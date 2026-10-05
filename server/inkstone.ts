// Webnovel Inkstone publishing. Inkstone has no public API: this calls the endpoints its own web app uses,
// signed in with the author's browser session (a pasted Cookie header). Request shapes mirror that web client.
import { setTimeout as sleep } from 'node:timers/promises'
import { all, get, kvDel, kvGet, kvSet, run } from './db.ts'
import { bus } from './engine.ts'

const ORIGIN = 'https://inkstone.webnovel.com'
const TOKEN = 'inkstone_auth_token'
// Inkstone's own bulk importer uploads one chapter a second; stay under that.
const PACE = Number(process.env.KAIZER_INK_PACE ?? 1500)

export class InkError extends Error {
  kind: 'auth' | 'net' | 'api'
  constructor(kind: InkError['kind'], message: string) {
    super(message)
    this.kind = kind
  }
}

type Session = { cookie: string; token: string; ua: string; name: string; expired?: boolean }
export type Want = 'draft' | 'publish' | 'delete'
export type Config = { cbid: string; title: string; auto: 'off' | 'draft' | 'publish' | 'schedule'; every: number; start: number }

const pair = (s: string): [string, string] => {
  const i = s.indexOf('=')
  return [s.slice(0, i).trim(), s.slice(i + 1).trim()]
}
const jar = (cookie: string) => new Map(cookie.split(';').filter(p => p.includes('=')).map(pair))

// Book and chapter ids are larger than 2^53. Keep them as strings, as Inkstone's client does.
const parse = (text: string) =>
  JSON.parse(text, ((_k: string, v: unknown, ctx: { source?: string }) =>
    typeof v === 'number' && !Number.isSafeInteger(v) && /^-?\d+$/.test(ctx?.source ?? '') ? ctx.source : v) as (k: string, v: unknown) => unknown)

async function call(path: string, data: Record<string, unknown> = {}, post = false): Promise<any> {
  const s = kvGet<Session>('inkstone')
  if (!s || s.expired) throw new InkError('auth', 'Connect Inkstone to continue.')
  let res: Response
  let body: any
  try {
    const query = post ? '' : (path.includes('?') ? '&' : '?') + new URLSearchParams(data as Record<string, string>)
    res = await fetch(ORIGIN + path + query, {
      method: post ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: s.token, cookie: s.cookie, 'user-agent': s.ua, origin: ORIGIN, referer: `${ORIGIN}/` },
      body: post ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    body = parse(await res.text())
  } catch (e) {
    throw new InkError('net', `Inkstone could not be reached (${(e as Error).message}).`)
  }
  // The session renews itself: Inkstone hands out a fresh auth token and cookies as it goes.
  const cookies = jar(s.cookie)
  for (const c of res.headers.getSetCookie()) cookies.set(...pair(c.split(';')[0]))
  if (typeof body.Authorization === 'string') cookies.set(TOKEN, body.Authorization)
  const cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  const expired = body.returnCode === 4001 || body.returnCode === 412
  if (cookie !== s.cookie || expired) kvSet('inkstone', { ...s, cookie, token: cookies.get(TOKEN) ?? s.token, expired: expired || undefined })
  if (expired) throw new InkError('auth', 'The Inkstone session expired. Connect again.')
  if (body.returnCode !== 200 && body.code !== 0) throw new InkError('api', body.returnMsg || body.message || `Inkstone refused the request (${body.returnCode ?? res.status}).`)
  return body.result ?? {}
}

export function status() {
  const s = kvGet<Session>('inkstone')
  return { connected: !!s && !s.expired, expired: !!s?.expired, name: s?.name ?? '' }
}

// `cookie` is the Cookie request header of a signed-in inkstone.webnovel.com tab; `ua` is that browser's user agent.
export async function connect(cookie: string, ua: string) {
  cookie = cookie.replace(/^cookie:/i, '').replace(/[\r\n]+/g, ' ').trim()
  if (!cookie.includes('=')) throw new InkError('auth', 'That is not a Cookie header. Copy the whole value, it looks like "name=value; name=value".')
  const before = kvGet<Session>('inkstone')
  kvSet('inkstone', { cookie, token: jar(cookie).get(TOKEN) ?? '', ua, name: '' })
  try {
    const u = await call('/externalsite?service=userinfoservice&action=getUserInfo', { _time: Date.now() })
    kvSet('inkstone', { ...kvGet<Session>('inkstone'), name: String(u.penname || u.nickname || u.email || 'Inkstone author') })
  } catch (e) {
    if (before) kvSet('inkstone', before)
    else kvDel('inkstone')
    throw e
  }
  kick()
}

export const disconnect = () => kvDel('inkstone')

export const novels = async () =>
  ((await call('/externalsite?service=novelservice&action=paginateNovelList', { type: 0 })).records ?? []).map((r: any) => ({
    cbid: String(r.CBID),
    title: String(r.novelTitle ?? r.CBID),
  })) as { cbid: string; title: string }[]

// Inkstone schedules in GMT+8 on a five-minute grid.
const GRID = 300_000
const grid = (ms: number) => Math.ceil(ms / GRID) * GRID
export function gmt8(ms: number) {
  const d = new Date(grid(ms) + 8 * 3_600_000).toISOString()
  return { date: d.slice(0, 10).replaceAll('-', '/'), time: d.slice(11, 16) }
}
const fromGmt8 = (date: unknown, time: unknown) => {
  if (typeof date !== 'string' || !/^\d{4}\/\d\d\/\d\d$/.test(date)) return null
  return Date.parse(`${date.replaceAll('/', '-')}T${typeof time === 'string' && /^\d\d:\d\d$/.test(time) ? time : '00:00'}:00+08:00`)
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// The plain editor takes CRLF-separated paragraphs and nothing else (its only elements are p and br), so
// italics lose their markers there. The Japanese editors store HTML and keep them as <em>.
export function inkBody(text: string, html = false) {
  const paras = text.split(/\n+/).map(p => p.trim()).filter(Boolean)
  const italics = /\*([^*\n]+)\*/g
  return html ? paras.map(p => `<p>${esc(p).replace(italics, '<em>$1</em>')}</p>`).join('') : paras.map(p => p.replace(italics, '$1')).join('\r\n')
}

// Creates the draft, or updates it when `ccid` is given. `publish` asks for the publishing terms as well.
async function save(cbid: string, ccid: string | null, title: string, text: string, publish: boolean) {
  const pre = ccid ? await call('/tauthorweb/chapter/editChapter', { CBID: cbid, CCID: ccid }) : await call('/tauthorweb/chapter/getAddPreBookChapter', { CBID: cbid })
  const jp = [1, 2].includes(Number(pre.editorType))
  const cvid = pre.selectedCVID || pre.volumeInfoVos?.at(-1)?.CVID
  const r = await call('/tauthorweb/chapter/saveChapter', {
    CBID: cbid, CCID: ccid ?? undefined, selectedCVID: cvid, chapterType: pre.vipSelected,
    chapterTitle: title.slice(0, 200), chapterextra: pre.chapterextra, content: inkBody(text, jp), isfinelayout: jp ? 1 : -1,
    jsonAnnotationMap: [], vipSelected: pre.vipSelected, token: pre.token, editorType: pre.editorType,
    bonusChapter: false, operatorType: publish ? 'getpublish' : undefined,
  }, true)
  if (!r.flag || !r.CCID) throw new InkError('api', r.msg || 'Inkstone did not save the chapter.')
  return { ccid: String(r.CCID), cvid, terms: r.publishPreInfoVo ?? {} }
}

async function remove(cbid: string, ccid: string | null) {
  if (!ccid) return
  const r = await call('/tauthorweb/chapter/deleteChapter', { CBID: cbid, CCID: ccid }, true)
  if (!r.flag) throw new InkError('api', r.msg || 'Inkstone did not delete the chapter.')
}

export const config = (id: number): Config | null => {
  const raw = get<{ inkstone: string | null }>('select inkstone from books where id = ?', id)?.inkstone
  return raw ? JSON.parse(raw) : null
}
const emit = (id: number) => bus.emit(`book:${id}`, { type: 'update' })

export function link(id: number, cfg: Config | null) {
  // Chapter ids belong to the novel they were uploaded to.
  if (config(id)?.cbid !== cfg?.cbid) run('delete from ink_chapters where book_id = ?', id)
  run('update books set inkstone = ? where id = ?', cfg ? JSON.stringify(cfg) : null, id)
  horizon.delete(id)
  emit(id)
  kick()
}

// Sets what should happen to chapters; the worker makes it so. With `at`, each chapter after the first lands `everyHours` later.
export function want(id: number, idxs: number[], w: Want, at: number | null, everyHours = 0) {
  let k = 0
  for (const idx of idxs) {
    // A published chapter cannot be pulled back or removed from here; only its text is kept up to date.
    if (get('select 1 from ink_chapters where book_id = ? and idx = ? and state = ?', id, idx, 'published')) continue
    const t = w === 'publish' && at !== null ? grid(at + k++ * everyHours * 3_600_000) : null
    run('insert into ink_chapters (book_id, idx, want, at) values (?, ?, ?, ?) on conflict (book_id, idx) do update set want = excluded.want, at = excluded.at, error = null', id, idx, w, t)
  }
  emit(id)
  kick()
}

export function retry(id: number) {
  run('update ink_chapters set error = null where book_id = ?', id)
  emit(id)
  kick()
}

// The next free release slot on the book's grid: after everything already queued, never in the past.
export function nextSlot(cfg: Pick<Config, 'start' | 'every'>, last: number | null, now = Date.now()) {
  const step = cfg.every * 3_600_000
  const from = Math.max(cfg.start, last === null ? 0 : last + step, now)
  return cfg.start + Math.ceil((from - cfg.start) / step) * step
}

// Automation: every finished chapter that Inkstone has not been told about yet gets the book's standing order.
function plan(id: number, cfg: Config) {
  if (cfg.auto === 'off') return
  let last = get<{ m: number | null }>('select max(at) m from ink_chapters where book_id = ? and want = ?', id, 'publish')!.m
  for (const c of all<{ idx: number }>('select idx from chapters where book_id = ? and status = ? and idx not in (select idx from ink_chapters where book_id = ?) order by idx', id, 'done', id)) {
    const at = cfg.auto === 'schedule' ? (last = nextSlot(cfg, last)) : null
    run('insert into ink_chapters (book_id, idx, want, at) values (?, ?, ?, ?)', id, c.idx, cfg.auto === 'draft' ? 'draft' : 'publish', at)
  }
}

// How far ahead Inkstone accepts a timer, per book, learned when it turns one down.
const horizon = new Map<number, number>()
const far = (r: any, now: number) => r.at !== null && r.at > now + (horizon.get(r.book_id) ?? Infinity)

function pending(r: any, now: number) {
  const stale = r.ver !== null && r.ver !== r.proof_rounds // the proofreader rewrote it since the upload
  if (r.want === 'delete') return !!r.ccid && r.state !== 'published'
  if (r.state === 'published') return stale
  if (r.want === 'draft') return r.state !== 'draft' || stale
  if (r.state === 'scheduled') return stale || r.at !== r.applied
  return r.state === null || stale || !far(r, now)
}

async function sync(cbid: string, r: any, now: number) {
  const set = (f: Record<string, string | number | null>) => {
    run(`update ink_chapters set ${Object.keys(f).map(k => `${k} = ?`).join(', ')} where book_id = ? and idx = ?`, ...Object.values(f), r.book_id, r.idx)
    emit(r.book_id)
  }
  if (r.want === 'delete') {
    await remove(cbid, r.ccid)
    return set({ ccid: null, state: null, applied: null, ver: null, updated: null })
  }
  const changed = r.ver !== null && r.ver !== r.proof_rounds // a text that replaces one Inkstone already had
  // Inkstone cannot cancel a timer. A scheduled chapter that should be a draft again, or wait for a date
  // Inkstone does not take yet, is replaced with a fresh draft.
  if (r.state === 'scheduled' && (r.want === 'draft' || far(r, now))) {
    await remove(cbid, r.ccid)
    set({ ccid: null, state: null, applied: null })
    r.ccid = r.state = null
  }
  // A published chapter that was rewritten is saved in place, which is what Inkstone's editor does on "Update".
  const publish = r.want === 'publish' && r.state !== 'published' && !far(r, now)
  const saved = await save(cbid, r.ccid, r.title, r.text, publish)
  set({ ccid: saved.ccid, state: r.state ?? 'draft', ver: r.proof_rounds, ...(changed ? { updated: Date.now() } : {}) })
  if (!publish) return

  const { terms } = saved
  const min = fromGmt8(terms.minDate, terms.minTime)
  const max = fromGmt8(terms.maxDate, terms.maxTime)
  if (r.at !== null && max && r.at > max) {
    horizon.set(r.book_id, max - now) // waits as a draft until the date comes within reach
    return
  }
  const timer = r.at !== null && r.at > now + GRID
  const at = timer ? Math.max(grid(r.at), min ?? 0) : null
  const res = await call('/tauthorweb/chapter/publishChapter', {
    // Publishing right away still sends a date: the earliest one Inkstone offered, as its publish dialog does.
    CVID: saved.cvid, CCID: saved.ccid, CBID: cbid, hasTimer: timer ? 1 : 0, ...gmt8(at ?? min ?? now),
    isTestRepeatability: 1, // have Inkstone refuse a chapter that repeats an earlier one, rather than post it twice
    timezone: -new Date().getTimezoneOffset() / 60,
  }, true)
  if (!res.flag) throw new InkError('api', res.msg || 'Inkstone did not publish the chapter.')
  set(at ? { state: 'scheduled', at, applied: at } : { state: 'published', applied: now })
}

// One sweep over every linked book. All state is in the database, so a restart picks up where this stopped.
export async function pass() {
  if (!status().connected) return
  for (const b of all<{ id: number }>('select id from books where inkstone is not null')) {
    const cfg = config(b.id)!
    const now = Date.now()
    // A timer that has run out means Inkstone has published the chapter.
    if (run('update ink_chapters set state = ? where book_id = ? and state = ? and applied <= ?', 'published', b.id, 'scheduled', now).changes) emit(b.id)
    plan(b.id, cfg)
    const rows = all(
      `select i.*, c.title, c.text, c.proof_rounds from ink_chapters i join chapters c on c.book_id = i.book_id and c.idx = i.idx
       where i.book_id = ? and c.status = 'done' order by i.idx`, b.id)
    for (const r of rows) {
      if (r.error) break // chapters go up in order: nothing passes a failed one
      if (!pending(r, now)) continue
      try {
        await sync(cfg.cbid, r, now)
      } catch (e) {
        // Signed out or offline: leave everything queued for the next sweep.
        if (e instanceof InkError && e.kind !== 'api') return
        run('update ink_chapters set error = ? where book_id = ? and idx = ?', (e as Error).message, r.book_id, r.idx)
        emit(b.id)
        break
      }
      await sleep(PACE)
    }
  }
}

let running = false
let again = false
export function kick() {
  if (running) return void (again = true)
  running = true
  pass()
    .catch(e => console.error('[inkstone]', e))
    .finally(() => {
      running = false
      if (again) (again = false), kick()
    })
}

// New chapters, due timers and retries are picked up once a minute.
export const watch = () => (setInterval(kick, 60_000).unref(), kick())
