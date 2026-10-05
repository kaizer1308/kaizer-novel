import { existsSync, readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { streamSSE } from 'hono/streaming'
import { all, get, run } from './db.ts'
import { handleCallback, loginUrl, me, signOut } from './auth.ts'
import { generateJson, listModels } from './llm.ts'
import { bus, live, llmOpts, nudge, pause, reproof, resumeAll, requeue, resumeSignedOut, rewrite, start, undo } from './engine.ts'
import { changes } from './diff.ts'
import { toEpub, toMarkdown, toText } from './export.ts'
import * as ink from './inkstone.ts'
import { enhancePrompt, enhancer, enhanceSchema, POVS, TENSES, type Settings } from './prompts.ts'

const PORT = Number(process.env.PORT ?? 4317)
const app = new Hono()

// Local-only app: block DNS-rebinding hosts and cross-site writes.
app.use('*', async (c, next) => {
  const host = c.req.header('host') ?? ''
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return c.text('Forbidden', 403)
  const origin = c.req.header('origin')
  if (c.req.method !== 'GET' && origin && new URL(origin).host !== host) return c.text('Forbidden', 403)
  await next()
})

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message }, 500)
})

// --- auth ---
const back = (error?: string) => (error ? `/#/?error=${encodeURIComponent(error)}` : '/')

// A sign-in renewed from inside the app runs in a popup that closes itself, so the page behind it keeps its state.
let popup = false
const esc = (s: string) => s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
const finish = (c: any, error?: string) =>
  popup
    ? c.html(`<!doctype html><meta charset="utf-8"><title>Kaizer</title>${error ? '' : '<script>window.close()</script>'}<p style="font: 15px system-ui; padding: 24px">${error ? esc(error) : 'Signed in.'} You can close this window.</p>`)
    : c.redirect(back(error))

app.get('/auth/login', async c => {
  popup = c.req.query('popup') === '1'
  // SIWC only accepts 127.0.0.1 loopback redirects.
  const host = c.req.header('host')!.replace(/^localhost/, '127.0.0.1')
  try {
    return c.redirect(await loginUrl(`http://${host}/auth/callback`, c.req.query('fresh') === '1'))
  } catch (e) {
    return finish(c, (e as Error).message)
  }
})

app.get('/auth/callback', async c => {
  try {
    await handleCallback(new URL(c.req.url).searchParams)
    resumeSignedOut()
    return finish(c)
  } catch (e) {
    return finish(c, (e as Error).message)
  }
})

app.get('/api/me', c => c.json(me()))
app.post('/api/logout', async c => (await signOut(), c.json({ ok: true })))
app.get('/api/models', async c => {
  try {
    return c.json(await listModels())
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502)
  }
})

// --- books ---
const PROGRESS = `select b.id, b.title, b.status, b.phase, b.error, b.retry_at, b.settings, b.proofed, b.created_at, b.updated_at,
  (select count(*) from chapters where book_id = b.id and status = 'done') done,
  coalesce((select sum(chapter_count) from arcs where book_id = b.id), json_extract(b.settings, '$.chapters')) total,
  (select coalesce(sum(words), 0) from chapters where book_id = b.id and status = 'done') words
  from books b`
const withSettings = (b: any) => ({ ...b, settings: JSON.parse(b.settings) })

app.get('/api/books', c => c.json(all(`${PROGRESS} order by b.updated_at desc`).map(withSettings)))

const str = (v: unknown, max: number, fallback = '') => (typeof v === 'string' ? v.trim().slice(0, max) : fallback)
const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

const settingsFrom = (b: any): Settings => ({
  title: str(b.title, 200),
  premise: str(b.premise, 20_000),
  genre: str(b.genre, 200, 'Fantasy') || 'Fantasy',
  tropes: Array.isArray(b.tropes) ? b.tropes.filter((t: unknown) => typeof t === 'string').slice(0, 20).map((t: string) => t.slice(0, 60)) : [],
  pov: str(b.pov, 100, 'First person') || 'First person',
  tense: str(b.tense, 40, 'past') || 'past',
  tone: str(b.tone, 300, 'Fun, fast-paced, with heart') || 'Fun, fast-paced, with heart',
  language: str(b.language, 60, 'English') || 'English',
  rating: str(b.rating, 40, 'Teen') || 'Teen',
  chapters: num(b.chapters, 1, 1000, 30),
  words: num(b.words, 500, 8000, 2500),
  style: str(b.style, 6000),
  model: str(b.model, 200),
  reasoning: str(b.reasoning, 20, 'low'),
  fast: b.fast === true,
})

// Turns the notes on the New book form into a full premise and the settings that suit it; nothing is saved.
app.post('/api/enhance', async c => {
  const b = await c.req.json().catch(() => ({}))
  const s = settingsFrom(b)
  if (!s.premise) return c.json({ error: 'Write a premise first.' }, 400)
  if (!s.model) return c.json({ error: 'Choose a model.' }, 400)
  const labels = (v: unknown): string[] => (Array.isArray(v) ? v.filter(t => typeof t === 'string').slice(0, 40).map(t => t.slice(0, 60)) : [])
  const tone = str(b.tone, 300) // empty unless the author typed one; settingsFrom would fill in the default
  try {
    const r = await generateJson<any>(
      { ...llmOpts(s), instructions: enhancer(s), input: enhancePrompt(s, labels(b.options?.genres), labels(b.options?.tropes), tone), signal: c.req.raw.signal },
      'premise', enhanceSchema)
    // Same validation as a new book; what the author already picked is kept.
    const out = settingsFrom({
      premise: r.premise,
      genre: labels(r.genres).slice(0, 3).map(g => g.replace(/,/g, '')).join(', ') || s.genre,
      tropes: [...new Set([...s.tropes, ...labels(r.tropes)])],
      pov: POVS.includes(r.pov) ? r.pov : s.pov,
      tense: TENSES.includes(r.tense) ? r.tense : s.tense,
      tone: tone || r.tone,
      chapters: r.chapters,
      words: Math.round(Number(r.words) / 100) * 100,
    })
    if (!out.premise) return c.json({ error: 'The premise came back empty. Try again.' }, 502)
    const { premise, genre, tropes, pov, tense, chapters, words } = out
    return c.json({ premise, genre, tropes, pov, tense, tone: out.tone, chapters, words })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502)
  }
})

app.post('/api/books', async c => {
  const s = settingsFrom(await c.req.json().catch(() => ({})))
  if (!s.premise) return c.json({ error: 'A premise is required.' }, 400)
  if (!s.model) return c.json({ error: 'Choose a model.' }, 400)
  const now = Date.now()
  const id = Number(run('insert into books (title, settings, created_at, updated_at) values (?, ?, ?, ?)', s.title || 'Untitled', JSON.stringify(s), now, now).lastInsertRowid)
  start(id)
  return c.json({ id })
})

app.get('/api/books/:id', c => {
  const id = Number(c.req.param('id'))
  const book = get(`${PROGRESS} where b.id = ?`, id)
  if (!book) return c.json({ error: 'Not found' }, 404)
  const bible = get('select bible from books where id = ?', id)!.bible
  // Edits the author asked for are reported with their request, not in the proofreader's report.
  const fixes = all('select request_id, chapter, status from issues where book_id = ? and request_id is not null order by chapter, id', id)
  return c.json({
    ...withSettings(book),
    bible: bible ? JSON.parse(bible) : null,
    arcs: all('select idx, title, goal, chapter_count, synopsis from arcs where book_id = ? order by idx', id),
    inkstone: ink.config(id),
    chapters: all(
      `select c.idx, c.arc_idx, c.title, c.pov, c.status, c.words, c.summary, c.done_at, c.proofed,
        i.want ink_want, i.at ink_at, i.state ink_state, i.error ink_error, (i.ver is not null and i.ver != c.proof_rounds) ink_stale, i.updated ink_updated,
        (select count(*) from issues where book_id = c.book_id and chapter = c.idx and status = 'open') edits_queued,
        (select count(*) from issues where book_id = c.book_id and chapter = c.idx and status = 'open' and request_id is not null) edits_asked,
        c.sweep > 0 sweeping
       from chapters c left join ink_chapters i on i.book_id = c.book_id and i.idx = c.idx where c.book_id = ? order by c.idx`, id),
    entities: all('select kind, name, sheet, state, first_chapter, last_chapter from entities where book_id = ? order by first_chapter, id', id),
    threads: all('select id, chapter, text, payoff, status, resolved_in from threads where book_id = ? order by chapter', id),
    issues: all('select id, chapter, issue, fix, status from issues where book_id = ? and request_id is null order by chapter, id', id),
    requests: all('select id, chapter, quote, text, reply, effects, hand, undone, wrote, undo is not null undoable from requests where book_id = ? order by id', id)
      .map(r => ({ ...r, effects: r.effects ? JSON.parse(r.effects) : [], fixes: fixes.filter(f => f.request_id === r.id).map(f => ({ chapter: f.chapter, status: f.status })) })),
  })
})

// `diff`: what the chapter's last edit changed, until the author dismisses it.
app.get('/api/books/:id/chapters/:idx', c => {
  const ch = get('select idx, title, pov, text, words, status, before from chapters where book_id = ? and idx = ?', Number(c.req.param('id')), Number(c.req.param('idx')))
  if (!ch) return c.json({ error: 'Not found' }, 404)
  const { before, ...rest } = ch
  return c.json({ ...rest, diff: before && ch.text && before !== ch.text ? changes(before, ch.text) : null })
})
app.post('/api/books/:id/chapters/:idx/seen', c => {
  run('update chapters set before = null where book_id = ? and idx = ?', Number(c.req.param('id')), Number(c.req.param('idx')))
  return c.json({ ok: true })
})

// Speed settings can change mid-run; the engine reads them before each model call.
app.post('/api/books/:id/settings', async c => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json().catch(() => ({}))
  // Read after the await, written back at once: the engine may change the settings (directions, length) in between.
  const row = get('select settings from books where id = ?', id)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const s: Settings = JSON.parse(row.settings)
  if (typeof b.reasoning === 'string') s.reasoning = b.reasoning.slice(0, 20)
  if (typeof b.fast === 'boolean') s.fast = b.fast
  // Empty: the proofreader uses the writing model again.
  if (typeof b.proofModel === 'string') s.proofModel = b.proofModel.slice(0, 200) || undefined
  if (typeof b.proofReasoning === 'string') s.proofReasoning = b.proofReasoning.slice(0, 20)
  run('update books set settings = ? where id = ?', JSON.stringify(s), id)
  bus.emit(`book:${id}`, { type: 'update' })
  return c.json({ ok: true })
})
// A change the author asks for, in their own words, optionally about a passage they highlighted. The engine takes it from here.
app.post('/api/books/:id/requests', async c => {
  const id = Number(c.req.param('id'))
  if (!get('select 1 from books where id = ?', id)) return c.json({ error: 'Not found' }, 404)
  const b = await c.req.json().catch(() => ({}))
  const text = str(b.text, 4000)
  if (!text) return c.json({ error: 'Say what to change.' }, 400)
  // `chapter` is the one on the author's screen, so "this chapter" means something; with a `quote`, the one it is from.
  const chapter = Number.isInteger(b.chapter) ? (b.chapter as number) : null
  const quote = str(b.quote, 4000) || null
  run('insert into requests (book_id, chapter, quote, text) values (?, ?, ?, ?)', id, chapter, quote, text)
  nudge(id, quote ? chapter : null)
  return c.json({ ok: true })
})
// Only a request the engine has not taken up yet can be withdrawn. A chapter edited by hand is already saved: that is undone instead.
app.delete('/api/books/:id/requests/:rid', c => {
  const id = Number(c.req.param('id'))
  run('delete from requests where id = ? and book_id = ? and reply is null and hand = 0', Number(c.req.param('rid')), id)
  bus.emit(`book:${id}`, { type: 'update' })
  return c.json({ ok: true })
})
app.post('/api/books/:id/requests/:rid/undo', c =>
  undo(Number(c.req.param('id')), Number(c.req.param('rid'))) ? c.json({ ok: true }) : c.json({ error: 'This change can no longer be undone.' }, 400))
// The author's own rewrite of a written chapter.
app.post('/api/books/:id/chapters/:idx', async c => {
  const b = await c.req.json().catch(() => ({}))
  const text = str(b.text, 400_000).replace(/\r\n?/g, '\n')
  if (!text) return c.json({ error: 'A chapter cannot be empty.' }, 400)
  return rewrite(Number(c.req.param('id')), Number(c.req.param('idx')), text) ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)
})
app.post('/api/books/:id/pause', c => (pause(Number(c.req.param('id'))), c.json({ ok: true })))
app.post('/api/books/:id/resume', c => (start(Number(c.req.param('id'))), c.json({ ok: true })))
app.post('/api/books/:id/fix-minor', c => (requeue(Number(c.req.param('id')), 'noted'), c.json({ ok: true })))
app.post('/api/books/:id/retry-unfixed', c => (requeue(Number(c.req.param('id')), 'unfixed'), c.json({ ok: true })))
app.post('/api/books/:id/proofread', c =>
  reproof(Number(c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'Proofreading can start once the last chapter is written.' }, 400))
app.delete('/api/books/:id', c => {
  const id = Number(c.req.param('id'))
  pause(id)
  run('delete from books where id = ?', id)
  return c.json({ ok: true })
})

app.get('/api/books/:id/events', c => {
  const id = Number(c.req.param('id'))
  return streamSSE(c, async sse => {
    const send = (ev: object) => sse.writeSSE({ data: JSON.stringify(ev) }).catch(() => {})
    const cur = live.get(id)
    if (cur) send({ type: 'live', ...cur })
    bus.on(`book:${id}`, send)
    const ping = setInterval(() => send({ type: 'ping' }), 25_000)
    await new Promise<void>(resolve => sse.onAbort(resolve))
    clearInterval(ping)
    bus.off(`book:${id}`, send)
  })
})

app.get('/api/books/:id/export/:fmt', c => {
  const id = Number(c.req.param('id'))
  const fmt = c.req.param('fmt')
  const title = get<{ title: string }>('select title from books where id = ?', id)?.title
  const body = fmt === 'epub' ? toEpub(id) : fmt === 'md' ? toMarkdown(id) : fmt === 'txt' ? toText(id) : undefined
  if (!title || !body) return c.json({ error: 'Not found' }, 404)
  const type = { epub: 'application/epub+zip', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8' }[fmt]!
  const name = `${title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'book'}.${fmt}`
  return c.body(body as any, 200, { 'content-type': type, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` })
})

// --- inkstone ---
const inkFail = (c: any, e: unknown) => c.json({ error: (e as Error).message }, e instanceof ink.InkError && e.kind === 'net' ? 502 : 400)

app.get('/api/inkstone', c => c.json(ink.status()))
app.post('/api/inkstone/connect', async c => {
  const b = await c.req.json().catch(() => ({}))
  try {
    await ink.connect(str(b.cookie, 20_000), str(b.ua, 400) || c.req.header('user-agent') || '')
    return c.json(ink.status())
  } catch (e) {
    return inkFail(c, e)
  }
})
app.post('/api/inkstone/disconnect', c => (ink.disconnect(), c.json({ ok: true })))
app.get('/api/inkstone/novels', async c => {
  try {
    return c.json(await ink.novels())
  } catch (e) {
    return inkFail(c, e)
  }
})

// Links the book to an Inkstone novel and sets what happens to chapters as they finish. No cbid unlinks it.
app.post('/api/books/:id/inkstone', async c => {
  const id = Number(c.req.param('id'))
  if (!get('select 1 from books where id = ?', id)) return c.json({ error: 'Not found' }, 404)
  const b = await c.req.json().catch(() => ({}))
  const cbid = str(b.cbid, 40)
  if (cbid && !/^\d+$/.test(cbid)) return c.json({ error: 'Choose a novel.' }, 400)
  ink.link(id, cbid ? {
    cbid,
    title: str(b.title, 300),
    auto: ['draft', 'publish', 'schedule'].includes(b.auto) ? b.auto : 'off',
    every: num(b.every, 1, 720, 24),
    start: num(b.start, 0, 8.64e15, Date.now()),
  } : null)
  return c.json({ ok: true })
})

// Per-chapter control: { want: 'draft' | 'publish' | 'delete', idxs?, at?, every? }, or { retry: true }.
app.post('/api/books/:id/inkstone/chapters', async c => {
  const id = Number(c.req.param('id'))
  if (!ink.config(id)) return c.json({ error: 'Link this book to an Inkstone novel first.' }, 400)
  const b = await c.req.json().catch(() => ({}))
  if (b.retry === true) return ink.retry(id), c.json({ ok: true })
  if (!['draft', 'publish', 'delete'].includes(b.want)) return c.json({ error: 'Unknown action.' }, 400)
  const done = all<{ idx: number }>('select idx from chapters where book_id = ? and status = ? order by idx', id, 'done').map(r => r.idx)
  const idxs = Array.isArray(b.idxs) ? done.filter(i => b.idxs.includes(i)) : done
  ink.want(id, idxs, b.want, typeof b.at === 'number' && Number.isFinite(b.at) ? b.at : null, num(b.every, 0, 720, 0))
  return c.json({ ok: true, chapters: idxs.length })
})

// --- built SPA (prod); in dev Vite serves the UI and proxies here ---
if (existsSync('web/dist/index.html')) {
  const index = readFileSync('web/dist/index.html', 'utf8')
  app.use('/*', serveStatic({ root: './web/dist' }))
  app.get('*', c => c.html(index))
}

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  console.log(`Kaizer Novel Generator → http://127.0.0.1:${PORT}`)
  resumeAll()
  ink.watch()
})
