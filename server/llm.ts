import { accessToken, AuthError, RESOURCE } from './auth.ts'

// kind drives autopilot: limit → wait long, retry → short backoff, auth → hold until the next sign-in, fatal → stop and show the message.
export class LLMError extends Error {
  code: string
  kind: 'limit' | 'retry' | 'auth' | 'fatal'
  constructor(code: string, message: string, kind: LLMError['kind']) {
    super(message)
    this.code = code
    this.kind = kind
  }
}

const MESSAGES: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: 'ChatGPT usage limit reached. Autopilot will resume automatically.',
  subscription_sharing_user_not_eligible: 'This ChatGPT account or workspace is not eligible for Sign in with ChatGPT.',
  subscription_sharing_v2_client_not_enabled: 'ChatGPT has not enabled this app for plan usage.',
}

async function apiError(res: Response): Promise<LLMError> {
  const body: any = await res.json().catch(() => ({}))
  const e = body.error ?? body
  const code: string = (typeof e === 'object' && (e.code ?? e.type)) || `http_${res.status}`
  const message = MESSAGES[code] ?? e.message ?? `ChatGPT request failed (${res.status}).`
  if (code === 'subscription_sharing_usage_limit_exceeded') return new LLMError(code, message, 'limit')
  if (res.status === 429 || res.status >= 500 || code.endsWith('_unavailable')) return new LLMError(code, message, 'retry')
  return new LLMError(code, message, 'fatal')
}

async function call(path: string, init: RequestInit) {
  for (let attempt = 0; ; attempt++) {
    let token: string
    try {
      token = await accessToken(attempt > 0)
    } catch (e) {
      // Signed out → hold for a sign-in; a broken registration → stop; the rest (network, 5xx) → retry.
      if (e instanceof AuthError) throw new LLMError(e.code, e.message, e.code === 'signed_out' ? 'auth' : e.code === 'invalid_client' ? 'fatal' : 'retry')
      throw new LLMError('network_error', 'Could not reach ChatGPT sign-in.', 'retry')
    }
    let res: Response
    try {
      res = await fetch(`${RESOURCE}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } })
    } catch (e) {
      if (init.signal?.aborted) throw e
      throw new LLMError('network_error', 'Could not reach ChatGPT.', 'retry')
    }
    if (res.status === 401 && attempt === 0) continue
    if (!res.ok) throw await apiError(res)
    return res
  }
}

// Models the API already serves but the plan's /models list does not carry yet. An entry is ignored once the list has it.
// gpt-6.1-sol: reasoning levels taken from the API's own validation error; priority tier is accepted but not applied.
const UNLISTED = [{ slug: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null, fast: null }]

let modelCache: { slug: string; name: string }[] | undefined
export async function listModels() {
  if (modelCache) return modelCache
  const body: any = await (await call('/models', { headers: { accept: 'application/json' } })).json()
  const listed: { slug: string; name: string }[] = (body.models ?? [])
    .filter((m: any) => m.visibility === 'list' && typeof m.slug === 'string')
    .map((m: any) => ({
      slug: m.slug,
      name: m.display_name ?? m.slug,
      efforts: (m.supported_reasoning_levels ?? []).map((l: any) => l.effort).filter((e: unknown) => typeof e === 'string'),
      defaultEffort: m.default_reasoning_level ?? null,
      fast: (m.service_tiers ?? []).find((t: any) => t.id === 'priority')?.description ?? null,
    }))
  return (modelCache = [...listed, ...UNLISTED.filter(u => !listed.some(m => m.slug === u.slug))])
}

export type Gen = {
  model: string
  instructions: string
  input: string
  signal?: AbortSignal
  onDelta?: (d: string) => void
  effort?: string
  fast?: boolean
}

// Optional extras: reasoning effort and the Fast (priority) tier. If the API rejects them and the
// same request succeeds without, stop sending them for the rest of the session.
let extrasUnsupported = false
async function stream(g: Gen, extra: object = {}) {
  const opts = { ...(g.effort && { reasoning: { effort: g.effort } }), ...(g.fast && { service_tier: 'priority' }) }
  if (!Object.keys(opts).length || extrasUnsupported) return streamOnce(g, extra)
  try {
    return await streamOnce(g, { ...extra, ...opts })
  } catch (e) {
    if (!(e instanceof LLMError) || e.kind !== 'fatal') throw e
    const r = await streamOnce(g, extra)
    extrasUnsupported = true
    return r
  }
}

// Streams one Responses API call. Returns full text; `incomplete` when output was cut short.
async function streamOnce(g: Gen, extra: object = {}) {
  const res = await call('/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: g.model, instructions: g.instructions, input: [{ role: 'user', content: g.input }], store: false, stream: true, ...extra }),
    signal: g.signal ? AbortSignal.any([g.signal, AbortSignal.timeout(15 * 60_000)]) : AbortSignal.timeout(15 * 60_000),
  })
  const decoder = new TextDecoder()
  let buf = ''
  let data: string[] = []
  let text = ''
  let done = false
  let incomplete = false
  const dispatch = () => {
    const raw = data.join('\n')
    data = []
    if (!raw || raw === '[DONE]') return
    const ev = JSON.parse(raw)
    if (ev.type === 'response.output_text.delta') {
      text += ev.delta
      g.onDelta?.(ev.delta)
    } else if (ev.type === 'response.completed') done = true
    else if (ev.type === 'response.incomplete') done = incomplete = true
    else if (ev.type === 'response.failed' || ev.type === 'error') {
      const e = ev.response?.error ?? ev.error ?? ev
      const code = e.code ?? 'response_failed'
      throw new LLMError(code, MESSAGES[code] ?? e.message ?? 'ChatGPT failed to respond.', code.includes('usage_limit') ? 'limit' : 'retry')
    }
  }
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      const lines = buf.split(/\r?\n/)
      buf = lines.pop()!
      for (const line of lines) {
        if (line === '') dispatch()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (done) break
    }
    if (buf.startsWith('data:')) data.push(buf.slice(5).trim())
    dispatch()
  } catch (e) {
    if (e instanceof LLMError || g.signal?.aborted) throw e
    throw new LLMError('stream_interrupted', 'The connection to ChatGPT was interrupted.', 'retry')
  }
  if (!done) throw new LLMError('stream_interrupted', 'ChatGPT stopped before finishing.', 'retry')
  return { text, incomplete }
}

export const generate = (g: Gen) => stream(g)

// Structured output. Falls back to schema-in-prompt if plan usage rejects `text.format`.
let schemaUnsupported = false
export async function generateJson<T>(g: Gen, name: string, schema: object): Promise<T> {
  const instructions = `${g.instructions}\n\nRespond with only a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`
  const format = { text: { format: { type: 'json_schema', name, schema, strict: true } } }
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const input = lastError ? `${g.input}\n\nYour previous reply was not valid JSON (${lastError}). Reply with only the JSON object.` : g.input
    let text: string
    try {
      text = (await stream({ ...g, instructions, input }, schemaUnsupported ? {} : format)).text
    } catch (e) {
      if (e instanceof LLMError && !schemaUnsupported && (e.code === 'subscription_sharing_unsupported_capability' || e.code === 'http_400' || e.code === 'invalid_request_error')) {
        schemaUnsupported = true
        attempt--
        continue
      }
      throw e
    }
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
    try {
      return JSON.parse(json) as T
    } catch (e) {
      lastError = (e as Error).message
    }
  }
  throw new LLMError('invalid_json', `ChatGPT returned malformed JSON for ${name}.`, 'retry')
}
