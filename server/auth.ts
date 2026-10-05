// "Sign in with ChatGPT" (SIWC) — OpenAI's official plan-usage OAuth for local apps.
// Protocol mirrors github.com/openai/sign-in-with-chatgpt-devkit (packages/local/src/oauth.ts).
import { createHash, randomBytes } from 'node:crypto'
import { kvDel, kvGet, kvSet } from './db.ts'

const ISSUER = 'https://auth.openai.com'
export const RESOURCE = 'https://api.openai.com/v1'
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const APP_NAME = 'Kaizer Novel Generator'
const REAUTH = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']

export class AuthError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

type Session = {
  clientId: string
  subject: string
  email?: string
  name?: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  refreshDead?: boolean // ChatGPT refused the refresh token; the access token still runs out its hour
}

const rand = () => randomBytes(32).toString('base64url')
const b64urlJson = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))

let discovery: Promise<{ authorization_endpoint: string; token_endpoint: string; revocation_endpoint?: string }> | undefined
const provider = () =>
  (discovery ??= fetch(`${ISSUER}/.well-known/openid-configuration`)
    .then(r => (r.ok ? r.json() : Promise.reject(new AuthError('discovery_failed', 'ChatGPT sign-in is unavailable. Try again shortly.'))))
    .catch(e => {
      discovery = undefined
      throw e
    }))

async function tokenRequest(params: Record<string, string>) {
  const { token_endpoint } = await provider()
  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...params, resource: RESOURCE }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const code = typeof data.error === 'string' ? data.error : data.error?.code ?? 'token_error'
    throw new AuthError(code, data.error_description ?? data.error?.message ?? `ChatGPT sign-in failed (${res.status}).`)
  }
  if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number' || typeof data.refresh_token !== 'string')
    throw new AuthError('invalid_token_response', 'ChatGPT returned incomplete credentials. Sign in again.')
  return data
}

// One sign-in at a time; this is a single-user local app.
let pending: { state: string; nonce: string; verifier: string; redirectUri: string; clientId?: string } | undefined

// A registered client id only admits accounts in the workspace that registered it, so `fresh` registers anew for another account.
export async function loginUrl(redirectUri: string, fresh = false) {
  const { authorization_endpoint } = await provider()
  const clientId = fresh ? undefined : kvGet<string>('client_id')
  pending = { state: rand(), nonce: rand(), verifier: rand(), redirectUri, clientId }
  const url = new URL(authorization_endpoint)
  url.search = new URLSearchParams({
    client_id: clientId ?? 'dynamic_agent_client',
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
  }).toString()
  // First sign-in registers this app with ChatGPT; later sign-ins reuse the issued client id.
  if (!clientId) url.searchParams.set('agent_name_hint', APP_NAME)
  return url.toString()
}

export async function handleCallback(q: URLSearchParams) {
  const p = pending
  if (!p || q.get('state') !== p.state) throw new AuthError('invalid_state', 'Sign-in expired or was started elsewhere. Try again.')
  pending = undefined
  const err = q.get('error')
  if (err) throw new AuthError(err, q.get('error_description') ?? 'Sign-in was not completed.')
  const code = q.get('code')
  const clientId = q.get('client_id') ?? p.clientId
  if (!code || !clientId || clientId === 'dynamic_agent_client')
    throw new AuthError('registration_incomplete', 'ChatGPT did not complete app registration. Try again.')
  // Persist registration before the one-time code exchange so a retry doesn't register another app.
  kvSet('client_id', clientId)
  const data = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: p.verifier, redirect_uri: p.redirectUri })
  // id_token arrives directly from the token endpoint over TLS, so issuer/signature trust comes from TLS
  // (OIDC Core 3.1.3.7); claim checks below still bind it to this request.
  const claims = typeof data.id_token === 'string' ? b64urlJson(data.id_token.split('.')[1]) : {}
  const aud = [claims.aud].flat()
  if (claims.iss !== ISSUER || claims.nonce !== p.nonce || !aud.includes(clientId) || typeof claims.sub !== 'string')
    throw new AuthError('invalid_id_token', 'ChatGPT identity could not be verified. Sign in again.')
  save({ clientId, subject: claims.sub, email: claims.email, name: claims.name }, data)
}

function save(base: Omit<Session, 'accessToken' | 'refreshToken' | 'expiresAt'>, data: { access_token: string; refresh_token: string; expires_in: number }) {
  kvSet('session', { ...base, accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 })
}

let refreshing: Promise<string> | undefined
const signedOut = () => new AuthError('signed_out', 'Sign in with ChatGPT to continue.')

export async function accessToken(force = false): Promise<string> {
  const s = kvGet<Session>('session')
  if (!s) throw signedOut()
  if (!force && s.expiresAt - Date.now() > 5 * 60_000) return s.accessToken
  // Once the refresh token is unusable, the access token it came with still works until it expires
  // (unless `force`: ChatGPT just rejected it). Only then is the session over.
  const lastLegs = () => {
    if (!force && s.expiresAt > Date.now()) return s.accessToken
    kvDel('session')
    throw signedOut()
  }
  if (s.refreshDead) return lastLegs()
  return (refreshing ??= (async () => {
    try {
      const data = await tokenRequest({ grant_type: 'refresh_token', client_id: s.clientId, refresh_token: s.refreshToken })
      save(s, data) // refresh tokens rotate: persist the new one immediately
      return data.access_token as string
    } catch (e) {
      // A new sign-in landed while this was in flight: use it and leave it alone.
      const cur = kvGet<Session>('session')
      if (cur && cur.refreshToken !== s.refreshToken) return cur.accessToken
      if (e instanceof AuthError && REAUTH.includes(e.code)) {
        kvSet('session', { ...s, refreshDead: true })
        return lastLegs()
      }
      // Anything else is transient (network, 5xx): keep the credentials, and keep going while the access token lasts.
      if (!force && s.expiresAt > Date.now()) return s.accessToken
      throw e
    } finally {
      refreshing = undefined
    }
  })())
}

// renewable: false once ChatGPT has refused this session's refresh, so the UI can offer a new sign-in before it lapses.
// Per session, not global: a past refusal must not make the UI pre-empt a refresh that would now succeed.
export function me() {
  const s = kvGet<Session>('session')
  if (!s || (s.refreshDead && s.expiresAt <= Date.now())) return { signedIn: false }
  return { signedIn: true, email: s.email, name: s.name, expiresAt: s.expiresAt, renewable: !s.refreshDead }
}

export async function signOut() {
  const s = kvGet<Session>('session')
  kvDel('session')
  if (!s) return
  const { revocation_endpoint } = await provider().catch(() => ({ revocation_endpoint: undefined }))
  if (revocation_endpoint)
    await fetch(revocation_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: s.refreshToken, token_type_hint: 'refresh_token', client_id: s.clientId }),
    }).catch(() => {})
}
