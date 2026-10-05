import { EventEmitter } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import type { SQLInputValue } from 'node:sqlite'
import { all, db, get, run, tx } from './db.ts'
import { arcContext, castOf, chapterContext, CJK, directContext, entityFinder, proofContext, threadItems, tokens, wordsRe } from './context.ts'
import { generate, generateJson, LLMError } from './llm.ts'
import * as P from './prompts.ts'
import type { Settings } from './prompts.ts'

// Engine → SSE. Events: {type:'update'} (refetch), {type:'delta', idx, delta}, {type:'live', idx, text} (reset buffer),
// {type:'idle'} (the text being written was dropped).
export const bus = new EventEmitter().setMaxListeners(0)
const emit = (id: number, ev: object) => bus.emit(`book:${id}`, ev)
export const live = new Map<number, { idx: number; text: string }>()

// A quiet job only carries out the author's requests and leaves the book's status alone.
// `step` stops the steps in flight; with `redo` set that is an interruption, not a failure. `ask`: they are the author's own.
type Job = { ac: AbortController; quiet: boolean; step?: AbortController; redo?: boolean; ask?: boolean }
const jobs = new Map<number, Job>()
const timers = new Map<number, NodeJS.Timeout>()

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
export function countWords(s: string) {
  let n = 0
  for (const x of segmenter.segment(s)) if (x.isWordLike) n++
  return n
}

function setBook(id: number, fields: Record<string, string | number | null>) {
  const sets = [...Object.keys(fields).map(k => `${k} = ?`), 'updated_at = ?']
  run(`update books set ${sets.join(', ')} where id = ?`, ...Object.values(fields), Date.now(), id)
  emit(id, { type: 'update' })
}

export function start(id: number) {
  clearTimeout(timers.get(id))
  const job = jobs.get(id)
  if (job && !job.quiet) return
  setBook(id, { status: 'running', error: null, retry_at: null })
  if (job) job.quiet = false // already at work on a request: it carries on into the writing
  else launch(id, false)
}

function launch(id: number, quiet: boolean) {
  const job: Job = { ac: new AbortController(), quiet }
  jobs.set(id, job)
  loop(id, job).finally(() => {
    jobs.delete(id)
    live.delete(id)
  })
}

export function pause(id: number) {
  clearTimeout(timers.get(id))
  setBook(id, { status: 'paused', phase: null, retry_at: null })
  jobs.get(id)?.ac.abort()
}

// Stops the steps in flight and has the loop take its next steps from the database again. Nothing half-done
// is left behind: every step commits in one transaction at its end.
function interrupt(id: number) {
  const job = jobs.get(id)
  if (!job?.step) return
  job.redo = true
  job.step.abort()
  live.delete(id)
  emit(id, { type: 'idle' })
}

// The author asked for a change. A running book stops what it is writing and takes the request now, a finished
// one reopens for it, and a paused or stopped one carries it out without resuming the writing. A waiting book
// keeps waiting: the request is first in line when it resumes.
export function nudge(id: number, chapter: number | null = null) {
  setBook(id, {}) // stamps the book as changed, so open views load its text again
  const job = jobs.get(id)
  if (job) {
    // Writing in flight is built on a plan the request may change, so it is dropped and done again after.
    // Not when the job is already on an earlier request, and not when the request is about the chapter
    // being written: its text only exists once the draft lands.
    const drafting = chapter !== null && get('select 1 from chapters where book_id = ? and idx = ? and status = ?', id, chapter, 'planned')
    if (!job.ask && !drafting && get('select bible from books where id = ?', id)?.bible) interrupt(id)
    return
  }
  const status = get('select status from books where id = ?', id)?.status
  if (status === 'complete') start(id)
  else if (status === 'paused' || status === 'error') launch(id, true)
}

// On boot: pick up books that were running or waiting when the server stopped.
export function resumeAll() {
  for (const b of all('select id, status, retry_at from books where status in (?, ?)', 'running', 'waiting')) {
    const wait = b.status === 'waiting' ? (b.retry_at ?? 0) - Date.now() : 0
    if (wait > 0) timers.set(b.id, setTimeout(() => start(b.id), wait))
    else start(b.id)
  }
  // A request left unserved on a paused or stopped book is carried out now.
  for (const r of all('select distinct book_id from requests where reply is null and undone = 0')) nudge(r.book_id)
}

// After a sign-in: pick up the books that were holding for one.
export function resumeSignedOut() {
  for (const b of all('select id from books where status = ? and retry_at is null', 'waiting')) start(b.id)
}

type Step = { phase: string; run: (signal: AbortSignal) => Promise<void>; ask?: boolean }

// Next steps are derived purely from DB state, so a crash or restart resumes exactly where it stopped.
// A chapter's memory pass runs alongside the next chapter's draft (same arc only).
function next(id: number, quiet: boolean): Step[] {
  const book = get('select * from books where id = ?', id)!
  const asked = book.bible ? requested(id) : []
  if (asked.length || quiet) return asked
  if (!book.bible) return [{ phase: 'Building the story bible', run: s => genBible(id, s) }]
  if (!get('select 1 from arcs where book_id = ?', id)) return [{ phase: 'Outlining arcs', run: s => genOutline(id, s) }]
  const arc = get('select * from arcs where book_id = ? and synopsis is null order by idx limit 1', id)
  if (!arc) return proofSteps(id, book)
  const ch = get('select * from chapters where book_id = ? and arc_idx = ? and status != ? order by idx limit 1', id, arc.idx, 'done')
  const digest = (c: any): Step => ({ phase: `Updating story memory after chapter ${c.idx}`, run: s => memory(id, c, s) })
  // An arc re-planned midway may hold a chapter not digested yet: the plan for the rest starts from what it wrote.
  if (!arc.expanded) return [ch?.status === 'drafted' ? digest(ch) : { phase: `Planning arc ${arc.idx + 1}: ${arc.title}`, run: s => expandArc(id, arc, s) }]
  const write = (c: any): Step => ({ phase: `Writing chapter ${c.idx}: ${c.title}`, run: s => draft(id, c, s) })
  if (ch?.status === 'planned') return [write(ch)]
  if (ch) {
    const nx = get('select * from chapters where book_id = ? and arc_idx = ? and idx = ? and status = ?', id, arc.idx, ch.idx + 1, 'planned')
    return [...(nx ? [write(nx)] : []), digest(ch)]
  }
  return [summarize(id, arc)] // requested() gets there first; kept so this never falls through to "complete"
}

const summarize = (id: number, arc: any): Step => ({ ask: true, phase: `Summarizing arc ${arc.idx + 1}`, run: s => synopsis(id, arc, s) })

// Repairs and the author's requests come before any more writing, one request at a time. Each chapter it
// edits has its memory read again before the next one is edited, so that edit sees the story as it now stands.
function requested(id: number): Step[] {
  // A repaired chapter of a book that is all written is read again on its own, whatever else is read beside it, so
  // proofreader repairs (stale = 1) are read side by side; the author's edits, and a book still being written,
  // where the last chapter's re-reading moves the story's present, one at a time.
  const stale = all('select * from chapters where book_id = ? and stale > 0 order by idx', id)
  const reread = (c: any): Step => ({ ask: true, phase: `Re-reading chapter ${c.idx} after its edit`, run: s => refresh(id, c, s) })
  const written = !get('select 1 from chapters where book_id = ? and status != ?', id, 'done') && !get('select 1 from arcs where book_id = ? and expanded = 0', id)
  if (stale.length) return !written || stale[0].stale === 2 ? [reread(stale[0])] : apart(stale.filter(c => c.stale === 1).map(c => c.idx), () => false).map(i => reread(stale.find(c => c.idx === i)))
  // Proofreader repairs run side by side for chapters four or more apart that no finding ties together: none reads
  // a neighbour another is rewriting, and two sides of one conflict are repaired one after the other, the second
  // against the first's result. The author's changes go one at a time, in order, as asked.
  const open = all('select chapter, request_id, other, issue, fix from issues where book_id = ? and status = ? order by chapter, id', id, 'open')
  const fix = (c: number, asked: boolean): Step => ({ ask: true, phase: asked ? `Revising chapter ${c} as you asked` : `Proofreading: repairing chapter ${c}`, run: s => proofFix(id, c, s) })
  if (open.length) {
    if (open.some(i => i.request_id)) return [fix(open[0].chapter, !!open[0].request_id)]
    const tied = (a: number, b: number) => open.some(i => (i.chapter === a && cites(i).has(b)) || (i.chapter === b && cites(i).has(a)))
    return apart(open.map(i => i.chapter), tied).map(c => fix(c, false))
  }
  // A change is followed through everything written before the next request is read.
  const sweeping = get('select id from requests where book_id = ? and sweep is not null and undone = 0 order by id limit 1', id)
  if (sweeping) return [{ ask: true, phase: 'Checking the rest of the book against your change', run: s => sweep(id, sweeping.id, s) }]
  // A written arc without its synopsis, whether just finished or edited since: it is summarized before a
  // request is directed, because everything reads "no synopsis" as "this arc is still being written".
  const due = get(
    `select * from arcs a where book_id = ? and synopsis is null and expanded = 1
     and exists (select 1 from chapters where book_id = a.book_id and arc_idx = a.idx)
     and not exists (select 1 from chapters where book_id = a.book_id and arc_idx = a.idx and status != ?) order by idx limit 1`, id, 'done')
  if (due) return [summarize(id, due)]
  const req = get('select id, chapter, quote, text, hand from requests where book_id = ? and reply is null and undone = 0 order by id limit 1', id)
  return req ? [{ ask: true, phase: 'Working on your request', run: s => direct(id, req, s) }] : []
}

// The other chapters a finding is about: the one the audit named, and any its words cite ("chapter 5", "ch 5"), since
// the model does not always name it.
const cites = (i: any) =>
  new Set<number>([i.other, ...[...`${i.issue} ${i.fix}`.matchAll(/\b(?:chapters?|ch\.?)\s*(\d+)/gi)].map(m => Number(m[1]))].filter(n => n > 0 && n !== i.chapter))

// Up to PARALLEL chapters, earliest first, each four or more from every other picked and not `tied` to it.
function apart(chapters: number[], tied: (a: number, b: number) => boolean) {
  const picked: number[] = []
  for (const c of chapters)
    if (picked.length < PARALLEL && !picked.includes(c) && picked.every(p => Math.abs(p - c) >= 4 && !tied(p, c))) picked.push(c)
  return picked
}

async function attempt(step: Step, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step.run(signal)
    } catch (e) {
      if (signal.aborted || !(e instanceof LLMError) || e.kind !== 'retry' || attempt === 2) throw e
      await sleep([5_000, 20_000][attempt], undefined, { signal })
    }
  }
}

async function loop(id: number, job: Job) {
  const signal = job.ac.signal
  try {
    for (let steps = next(id, job.quiet); steps.length; steps = next(id, job.quiet)) {
      setBook(id, { phase: steps.map(s => s.phase).join(' · ') })
      // First failure stops its sibling, so a later restart never races a step still in flight.
      const sub = (job.step = new AbortController())
      job.ask = steps.some(s => s.ask)
      job.redo = false
      const both = AbortSignal.any([signal, sub.signal])
      let failed: unknown
      // Repairs and re-readings side by side: each one's chapter stops showing as at work as soon as it is done.
      const done = new Set<Step>()
      const landed = (st: Step) => {
        done.add(st)
        const left = steps.filter(x => !done.has(x))
        if (left.length && steps.every(x => x.ask)) setBook(id, { phase: left.map(x => x.phase).join(' · ') })
      }
      await Promise.allSettled(steps.map(st => attempt(st, both).then(() => landed(st), e => ((failed ??= e), sub.abort()))))
      if (signal.aborted) return
      if (job.redo) continue // interrupted for the author: the steps start over from what the database says now
      if (failed) throw failed
      run('update books set limit_hits = 0 where id = ?', id)
    }
    setBook(id, job.quiet ? { phase: null } : { status: 'complete', phase: null, error: null })
  } catch (e) {
    if (signal.aborted) return
    const err = e as Error
    if (job.quiet) {
      // No timer for a book the author paused: a retry would resume the writing along with the request.
      setBook(id, { status: 'error', phase: null, error: err.message })
    } else if (err instanceof LLMError && err.kind === 'auth') {
      // Signed out mid-run: hold here with no timer. The next sign-in resumes it (resumeSignedOut).
      setBook(id, { status: 'waiting', error: 'Signed out of ChatGPT. Sign in again and writing picks up where it stopped.', retry_at: null })
    } else if (err instanceof LLMError && err.kind !== 'fatal') {
      // Usage limit (or a persistent outage): wait with backoff, then resume on our own.
      const hits = get('select limit_hits from books where id = ?', id)!.limit_hits
      const wait = [5, 15, 30, 60][Math.min(hits, 3)] * 60_000
      setBook(id, { status: 'waiting', error: err.message, retry_at: Date.now() + wait, limit_hits: hits + 1 })
      timers.set(id, setTimeout(() => start(id), wait))
    } else {
      console.error(`[book ${id}]`, err)
      setBook(id, { status: 'error', error: err.message })
    }
  }
}

export const llmOpts = (s: Settings) => ({ model: s.model, effort: s.reasoning ?? 'low', fast: s.fast })
// The proofreader's checks and repairs. Fast mode belongs to the writing model: another may not offer it.
const proofOpts = (s: Settings) => (s.proofModel ? { model: s.proofModel, effort: s.proofReasoning ?? '' } : llmOpts(s))

const settingsOf = (id: number) => {
  const b = get('select settings, title from books where id = ?', id)!
  return { s: JSON.parse(b.settings) as Settings, title: b.title as string }
}

const closeThread = (id: number, thread: number, chapter: number) =>
  run('update threads set status = ?, resolved_in = ? where id = ? and book_id = ? and status = ?', 'resolved', chapter, thread, id, 'open')

// Insert only: an entity that already exists keeps its canon state.
const addEntity = (id: number, kind: string, name: string, sheet: string, state: string, chapter: number) =>
  run(
    `insert into entities (book_id, kind, name, sheet, state, first_chapter, last_chapter) values (?, ?, ?, ?, ?, ?, ?)
     on conflict (book_id, name) do nothing`,
    id, kind, name.trim(), sheet, state, chapter, chapter,
  )

async function genBible(id: number, signal: AbortSignal) {
  const { s } = settingsOf(id)
  const b = await generateJson<any>({ ...llmOpts(s), instructions: P.architect(s), input: P.biblePrompt(s), signal }, 'story_bible', P.bibleSchema)
  if (s.title) b.title = s.title
  tx(() => {
    run('update books set bible = ?, title = ? where id = ?', JSON.stringify(b), b.title, id)
    for (const c of b.characters)
      addEntity(id, 'character', c.name, [`Role: ${c.role}`, `Appearance: ${c.appearance}`, `Personality: ${c.personality}`, `Voice: ${c.voice}`, `Goal: ${c.goal}`, c.secret && `Secret: ${c.secret}`, `Arc: ${c.arc}`].filter(Boolean).join('\n'), c.state, 0)
    for (const p of b.places) addEntity(id, p.kind, p.name, p.description, '', 0)
  })
}

async function genOutline(id: number, signal: AbortSignal) {
  const { s } = settingsOf(id)
  const bible = get('select bible from books where id = ?', id)!.bible
  const { arcs } = await generateJson<{ arcs: { title: string; goal: string; plan: string; chapters: number }[] }>(
    { ...llmOpts(s), instructions: P.architect(s), input: P.outlinePrompt(s, bible), signal }, 'arc_outline', P.outlineSchema)
  if (!arcs.length) throw new LLMError('empty_outline', 'The outline came back empty.', 'retry')
  // Scale chapter counts to sum exactly to the requested length.
  const list = arcs.slice(0, s.chapters)
  const raw = list.map(a => Math.max(1, a.chapters || 1))
  const total = raw.reduce((a, b) => a + b, 0)
  const counts = raw.map(c => Math.max(1, Math.round((c * s.chapters) / total)))
  for (let i = counts.length - 1, diff = s.chapters - counts.reduce((a, b) => a + b, 0); diff; i = (i || counts.length) - 1) {
    if (diff > 0) (counts[i]++, diff--)
    else if (counts[i] > 1) (counts[i]--, diff++)
  }
  tx(() => list.forEach((a, i) =>
    run('insert into arcs (book_id, idx, title, goal, plan, chapter_count) values (?, ?, ?, ?, ?, ?)', id, i, a.title, a.goal, a.plan, counts[i])))
}

async function expandArc(id: number, arc: any, signal: AbortSignal) {
  const { s } = settingsOf(id)
  // An arc the author had re-planned midway keeps what is written; only the rest is planned.
  const wrote = get('select count(*) n from chapters where book_id = ? and arc_idx = ?', id, arc.idx)!.n
  const n = arc.chapter_count - wrote
  // Nothing left to plan: the arc is as long as what is written. Asking for zero chapters would fail forever.
  if (n <= 0) return void run('update arcs set expanded = 1, chapter_count = ? where id = ?', wrote, arc.id)
  const r = await generateJson<{ chapters: any[]; new_entities: any[] }>(
    { ...llmOpts(s), instructions: P.architect(s), input: P.arcPrompt(n, arcContext(id, arc.idx), !get('select 1 from arcs where book_id = ? and idx > ?', id, arc.idx), wrote > 0), signal }, 'arc_chapters', P.arcSchema)
  const chs = r.chapters.slice(0, n)
  if (!chs.length) throw new LLMError('empty_arc', 'The arc plan came back empty.', 'retry')
  const first = (get('select max(idx) m from chapters where book_id = ?', id)!.m ?? 0) + 1
  const find = entityFinder(id)
  tx(() => {
    chs.forEach((c, i) =>
      run('insert into chapters (book_id, arc_idx, idx, title, pov, cast_names, beats, hook) values (?, ?, ?, ?, ?, ?, ?, ?)',
        id, arc.idx, first + i, c.title, c.pov, JSON.stringify(c.cast), JSON.stringify(c.beats), c.hook))
    // The planner often relists known entities as new; its guess must not overwrite their state.
    for (const e of r.new_entities) if (find(e.name)?.kind !== e.kind) addEntity(id, e.kind, e.name, e.sheet, e.state, first)
    // A cast name nobody has, most often a plot device the planner named but never listed, gets a card made from the
    // beats that use it. Not one sharing a word with a character's name: that is a person, named loosely.
    const known = entityFinder(id)
    const people = all('select name from entities where book_id = ? and kind = ?', id, 'character').map(e => e.name as string)
    // Only the first chapter's beat: the card is shown from then on, and later beats would give their reveals away early.
    for (const name of new Set(chs.flatMap(c => c.cast as string[]).map(n => n.trim())))
      if (name && !known(name) && !name.split(/\s+/).some(w => /^\p{Lu}/u.test(w) && people.some(p => wordsRe(w).test(p)))) {
        const at = chs.findIndex(c => c.cast.some((n: string) => n.trim() === name))
        const beat = (chs[at].beats as string[]).find(b => b.includes(name))
        addEntity(id, 'item', name, `First planned in chapter ${first + at}${beat ? `: ${beat}` : '.'}`, '', first)
      }
    run('update arcs set expanded = 1, chapter_count = ? where id = ?', wrote + chs.length, arc.id)
  })
}

// Streams into the live buffer so the UI can watch the chapter being written.
function liveWriter(id: number, idx: number) {
  live.set(id, { idx, text: '' })
  emit(id, { type: 'live', idx, text: '' })
  return (delta: string) => {
    const l = live.get(id)
    if (l?.idx !== idx) return // another chapter took over the live view
    l.text += delta
    emit(id, { type: 'delta', idx, delta })
  }
}

const prevRevised = (id: number, idx: number) => get('select revised from chapters where book_id = ? and idx = ?', id, idx - 1)?.revised

// A pipelined draft of the next chapter was built on text that has since changed: it is written again.
// Never one the author has edited (proof_rounds counts every change to a written chapter).
const redraftAfter = (id: number, idx: number) =>
  run('update chapters set status = ?, text = null, words = 0 where book_id = ? and idx = ? and status = ? and proof_rounds = 0', 'planned', id, idx + 1, 'drafted')

async function draft(id: number, ch: any, signal: AbortSignal) {
  const { s, title } = settingsOf(id)
  const basis = prevRevised(id, ch.idx)
  const ctx = chapterContext(id, ch)
  const g = { ...llmOpts(s), instructions: P.author(s, title), signal, onDelta: liveWriter(id, ch.idx) }
  let r = await generate({ ...g, input: P.chapterPrompt(ctx, s.words) })
  let text = r.text.trim()
  // Too short, or the model was cut off before the chapter's end.
  for (let i = 0; i < 2 && (r.incomplete || countWords(text) < s.words * 0.8); i++) {
    g.onDelta('\n\n')
    r = await generate({ ...g, input: P.continuePrompt(ctx, text, Math.max(150, s.words - countWords(text))) })
    text += '\n\n' + r.text.trim()
  }
  text = text.replace(/^\s*#*\s*chapter\b[^\n]*\n+/i, '')
  // Previous chapter got revised while this was drafted against its old text: discard, next() redrafts.
  if (prevRevised(id, ch.idx) !== basis) return
  run('update chapters set text = ?, words = ?, status = ? where id = ?', text, countWords(text), 'drafted', ch.id)
}

type Memory = {
  summary: string; detail: string; scene_end: string
  facts: { text: string; tags: string[] }[]
  entity_updates: { name: string; state: string; profile_correction?: string }[]
  new_entities: { kind: string; name: string; sheet: string; state: string }[]
  threads_opened: { text: string; payoff: string }[]
  threads_resolved: number[]
  continuity_issues: { severity: 'high' | 'low'; issue: string }[]
}

const prevText = (id: number, idx: number): string | null => get('select text from chapters where book_id = ? and idx = ?', id, idx - 1)?.text ?? null

// Paragraphs of 8+ words that occur twice in the chapter, or word for word in the chapter before it: what a rewrite
// or a continuation replays. Found here for certain, where a model reading 3,000 words would only maybe notice.
function echoes(text: string, prev: string | null) {
  const before = new Set(paragraphs(prev)), seen = new Set<string>(), out: string[] = []
  for (const p of paragraphs(text)) {
    if (countWords(p) >= 8 && (seen.has(p) || before.has(p)))
      out.push(`This passage repeats, word for word, what ${before.has(p) ? 'the previous chapter' : 'this chapter'} already says; cut it or move the story on: "${p}"`)
    seen.add(p)
  }
  return out
}

// A repair that comes back gutted, bloated, or repeating itself is worse than the fault it was meant to fix.
const sane = (old: string, text: string, prev: string | null) =>
  countWords(text) >= countWords(old) * 0.7 && countWords(text) <= countWords(old) * 1.3 && echoes(text, prev).length <= echoes(old, prev).length

// The passages at fault are edited and the rest stays word for word; only when the edits cannot be placed is the
// chapter written again. No edits at all means nothing was found to change: with `keep`, that is the answer.
// `proof`: a repair of what a check found, made with the proofreader's model.
async function mend(id: number, ch: any, ctx: string, problems: string[], keep: boolean, signal: AbortSignal, proof = false) {
  const { s, title } = settingsOf(id)
  const g = { ...(proof ? proofOpts(s) : llmOpts(s)), instructions: P.author(s, title), signal }
  const { edits } = await generateJson<{ edits: { find: string; replace: string }[] }>({ ...g, input: P.patchPrompt(ctx, ch.text, problems, proof) }, 'chapter_edits', P.patchSchema)
  if (keep && !edits?.length) return { text: ch.text as string, patched: true }
  const patched = applyEdits(ch.text, edits)
  if (patched) return { text: patched, patched: true }
  const r = await generate({ ...g, onDelta: liveWriter(id, ch.idx), input: P.revisePrompt(ctx, ch.text, problems) })
  return { text: r.incomplete ? '' : r.text.trim(), patched: false }
}

async function memory(id: number, ch: any, signal: AbortSignal) {
  const { s } = settingsOf(id)
  const ctx = chapterContext(id, ch)
  const m = await generateJson<Memory>({ ...llmOpts(s), instructions: P.architect(s), input: P.memoryPrompt(ctx, ch.text), signal }, 'chapter_memory', P.memorySchema)
  const prev = prevText(id, ch.idx)
  // Text the author has changed (proof_rounds counts every change) is theirs: it is digested as it stands, never rewritten here.
  let high = ch.proof_rounds ? [] : [...m.continuity_issues.filter(i => i.severity === 'high').map(i => i.issue), ...echoes(ch.text, prev)]
  if (high.length && ch.revised < 2) {
    // Up to two repairs; the memory step then re-runs on the repaired text.
    setBook(id, { phase: `Revising chapter ${ch.idx} for continuity` })
    const { text } = await mend(id, ch, ctx, high, true, signal)
    if (text !== ch.text && sane(ch.text, text, prev)) {
      tx(() => {
        run('update chapters set text = ?, words = ?, revised = revised + 1 where id = ?', text, countWords(text), ch.id)
        redraftAfter(id, ch.idx)
      })
      return
    }
    // Asked to fix them, the author's hand found nothing to change (a quoted letter read again, say): that settles it.
    if (text === ch.text) high = []
  }
  tx(() => {
    // What the repairs left behind is repaired before anything more is written (see requested()), and the chapter is
    // then read again from its new text (refresh()). Until then its profile corrections may be about the very fault.
    applyMemory(id, ch, high.length ? { ...m, entity_updates: m.entity_updates.map(u => ({ ...u, profile_correction: '' })) } : m)
    for (const i of high) addIssue(id, ch.idx, i, '', 'open')
  })
  if (live.get(id)?.idx === ch.idx) live.delete(id)
}

// Commits a chapter's memory pass: recap, facts, entity states, threads.
export function applyMemory(id: number, ch: any, m: Memory) {
  const find = entityFinder(id)
  // The editor saw the full state only of entities with a card (castOf, as chapterContext gave it). For anyone else
  // a "full replacement" would erase what it never saw, so the update is stacked on top as a dated note.
  const cast = castOf(id, ch)
  const setState = (e: any, state: string, replace: boolean) => {
    if (!state.trim()) return
    e.state = replace ? state : `(ch ${ch.idx}) ${state}\n${e.state}`.trim().slice(0, 2000)
    run('update entities set state = ?, last_chapter = ? where id = ?', e.state, ch.idx, e.id)
  }
  tx(() => {
    run('update chapters set summary = ?, detail = ?, scene_end = ?, status = ?, done_at = ? where id = ?', m.summary, m.detail, m.scene_end, 'done', Date.now(), ch.id)
    for (const f of m.facts) run('insert into facts (book_id, chapter, text, tags) values (?, ?, ?, ?)', id, ch.idx, f.text, f.tags.join(' '))
    for (const e of cast) run('update entities set last_chapter = ? where id = ?', ch.idx, e.id)
    for (const u of m.entity_updates) {
      const e = find(u.name)
      if (!e) continue
      setState(e, u.state, cast.some(c => c.id === e.id))
      // A profile is never rewritten, only corrected: what the story established outranks what was planned.
      const fix = u.profile_correction?.trim()
      if (fix) run('update entities set sheet = sheet || ? where id = ? and instr(sheet, ?) = 0', `\nCorrection (ch ${ch.idx}): ${fix}`, e.id, fix)
    }
    for (const n of m.new_entities) {
      const e = find(n.name)
      if (e) setState(e, n.state, false)
      else addEntity(id, n.kind, n.name, n.sheet, n.state, ch.idx)
    }
    for (const t of m.threads_opened) run('insert into threads (book_id, chapter, text, payoff) values (?, ?, ?, ?)', id, ch.idx, t.text, t.payoff)
    for (const t of m.threads_resolved) closeThread(id, t, ch.idx)
  })
}

async function synopsis(id: number, arc: any, signal: AbortSignal) {
  const { s } = settingsOf(id)
  const chs = all('select idx, title, detail from chapters where book_id = ? and arc_idx = ? order by idx', id, arc.idx)
  const recaps = chs.map(c => `Ch ${c.idx} "${c.title}": ${c.detail}`).join('\n\n')
  const r = await generateJson<{ synopsis: string; threads_resolved: number[] }>(
    // Threads opened by the end of this arc: a synopsis written again after an edit must not close later ones.
    { ...llmOpts(s), instructions: P.architect(s), input: P.synopsisPrompt(arc.title, arc.plan, recaps, threadItems(id, -1, chs.at(-1)!.idx)), signal }, 'arc_synopsis', P.synopsisSchema)
  if (!r.synopsis.trim()) throw new LLMError('empty_synopsis', 'The arc synopsis came back empty.', 'retry')
  tx(() => {
    run('update arcs set synopsis = ? where id = ?', r.synopsis.trim(), arc.id)
    // The per-chapter editor only sees recent threads; this is where older ones get closed.
    for (const t of r.threads_resolved) closeThread(id, t, chs.at(-1)!.idx)
  })
}

// --- Proofreader: once every arc is written, the whole book is re-read with the full story in view. ---
// Audit windows of consecutive chapters → rewrite the flagged ones → re-audit each rewrite once → judge
// the loose ends and the ending. All of it derives from DB state, like every other step.

const addIssue = (id: number, chapter: number, issue: string, fix: string, status: string, thread: number | null = null, request: number | null = null, other = 0) =>
  run('insert into issues (book_id, chapter, issue, fix, status, thread_id, request_id, other) values (?, ?, ?, ?, ?, ?, ?, ?)', id, chapter, issue, fix, status, thread, request, other)

// How many windows are read at once, and how many repairs or re-readings run side by side.
const PARALLEL = 3

// Flagged chapters are repaired first: see requested(). The next windows of consecutive chapters are read
// together, PARALLEL at a time, in one step: see proofAudit().
function proofSteps(id: number, book: any): Step[] {
  const windows: any[][] = []
  let chs: any[] = []
  let size = 0
  for (const c of all('select * from chapters where book_id = ? and proofed = 0 order by idx', id)) {
    if (chs.length && (c.idx !== chs.at(-1).idx + 1 || size + tokens(c.text ?? '') > 30_000)) (windows.push(chs), (chs = []), (size = 0))
    chs.push(c)
    size += tokens(c.text ?? '')
  }
  if (chs.length) windows.push(chs)
  const wins = windows.slice(0, PARALLEL)
  if (wins.length) {
    // Named as read: "chapters 3, 12, 25", not "3–25", when repairs left gaps between the windows.
    const spans: [number, number][] = []
    for (const w of wins) {
      const last = spans.at(-1)
      if (last && last[1] + 1 === w[0].idx) last[1] = w.at(-1).idx
      else spans.push([w[0].idx, w.at(-1).idx])
    }
    const one = spans.length === 1 && spans[0][0] === spans[0][1]
    const got = new Map<number, Proof>() // readings already back, kept if the step is tried again
    return [{ phase: `Proofreading chapter${one ? '' : 's'} ${spans.map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(', ')}`, run: s => proofAudit(id, wins, got, s) }]
  }
  if (!book.proofed) return [{ phase: 'Proofreading: loose ends and the ending', run: s => proofEnding(id, s) }]
  return []
}

type Proof = {
  issues: { chapter: number; other?: number; severity: 'high' | 'low'; issue: string; fix: string }[]
  threads_resolved: { id: number; chapter: number }[]
}

// Windows are read side by side, each against the story as it stands now, and their findings land in order, as
// if read one after another. Read that way, a window would only be read once the findings before it were
// repaired: so after the first window with findings to repair, the later readings are set aside, and those windows
// are read again after the repairs. A failed reading lands none of them: it stops the others at once, and the step
// is tried again, reading only what did not come back (`got`).
async function proofAudit(id: number, wins: any[][], got: Map<number, Proof>, signal: AbortSignal) {
  const { s } = settingsOf(id)
  // Every request is built before any is sent: one that cannot be built leaves nothing in flight.
  const inputs = wins.map(chs => P.proofPrompt(proofContext(id, chs), chs.map(c => `=== Chapter ${c.idx}: ${c.title} ===\n${c.text}`).join('\n\n')))
  const stop = new AbortController()
  const both = AbortSignal.any([signal, stop.signal])
  let failed: unknown
  const res = await Promise.allSettled(wins.map(async (_, k) => {
    if (got.has(k)) return got.get(k)!
    try {
      const r = await generateJson<Proof>({ ...proofOpts(s), instructions: P.architect(s), input: inputs[k], signal: both }, 'proofread', P.proofSchema)
      got.set(k, r)
      return r
    } catch (e) {
      failed ??= e // the first error is the one that counts: the others are only stopped by it
      stop.abort()
      throw e
    }
  }))
  if (failed) throw failed
  const rs = res.map(r => (r as PromiseFulfilledResult<Proof>).value)
  tx(() => {
    // Nitpicks too: nobody proofreads this book after it, and a repair that would make things worse is refused (sane()).
    // Not in a chapter the author wrote by hand: what reads as a slip there may be their choice, and it waits for them.
    const mine = (c: number) => get('select 1 from requests where book_id = ? and chapter = ? and hand = 1 and undone = 0', id, c)
    for (const [k, r] of rs.entries()) {
      for (const c of wins[k]) run('update chapters set proofed = 1 where id = ?', c.id)
      let repairs = false
      for (const i of r.issues.map(i => ({ ...i, chapter: home(i, wins[k]) })).sort((a, b) => a.chapter - b.chapter)) {
        if (!get('select 1 from chapters where book_id = ? and idx = ?', id, i.chapter)) continue
        const status = i.severity === 'high' || !mine(i.chapter) ? 'open' : 'noted'
        const other = Math.round(Number(i.other)) || 0
        addIssue(id, i.chapter, i.issue, i.fix, status, null, null, other > 0 && other !== i.chapter ? other : 0)
        repairs ||= status === 'open'
      }
      for (const t of r.threads_resolved) closeThread(id, t.id, t.chapter)
      if (repairs) break
    }
  })
}

// A window is read as one, and the audit sometimes files a finding under the wrong chapter of it. The passages it
// quotes say where it belongs: a finding that cites no other chapter, and none of whose quotes is in the chapter it
// names, moves to the one chapter of the window that has them all.
export function home(i: { chapter: number; other?: number; issue: string; fix: string }, chs: { idx: number; text: string }[]) {
  const quotes = [...i.issue.matchAll(/[“"]([^“”"]+)[”"]/g)]
    .map(m => loose(m[1]).out.replace(/[\s.,;:!?]+$/, '').trim().toLowerCase())
    .filter(q => q.split(' ').length >= 4)
  const has = (c: { text: string }) => quotes.filter(q => loose(c.text).out.toLowerCase().includes(q)).length
  const named = chs.find(c => c.idx === i.chapter)
  if (!quotes.length || !named || has(named) || cites(i).size) return i.chapter
  const all = chs.filter(c => has(c) === quotes.length)
  return all.length === 1 ? all[0].idx : i.chapter
}

// Quote style and spacing are where a model's "exact" copy of a passage drifts, so matching ignores both.
// `at` maps each character of `out` back to its place in the original.
function loose(s: string) {
  let out = ''
  const at: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = /\s/.test(s[i]) ? ' ' : '“”„'.includes(s[i]) ? '"' : '‘’'.includes(s[i]) ? "'" : s[i]
    if (c === ' ' && out.endsWith(' ')) continue
    out += c
    at.push(i)
  }
  return { out, at }
}

// Applies find/replace edits to a chapter. Null unless every passage is found exactly once and none overlap:
// an edit that cannot be placed for certain is never guessed at.
export function applyEdits(text: string, edits: { find: string; replace: string }[]) {
  if (!Array.isArray(edits) || !edits.length) return null
  const t = loose(text)
  const spans: { start: number; end: number; replace: string }[] = []
  for (const e of edits) {
    const find = loose(String(e.find ?? '')).out.trim()
    const i = find ? t.out.indexOf(find) : -1
    if (i < 0 || t.out.includes(find, i + 1)) return null
    let end = t.at[i + find.length - 1] + 1
    const replace = String(e.replace ?? '').trim()
    if (!replace) while (text[end] === ' ') end++ // a deleted sentence takes its trailing space with it
    spans.push({ start: t.at[i], end, replace })
  }
  spans.sort((a, b) => b.start - a.start)
  if (spans.some((s, k) => k > 0 && s.end > spans[k - 1].start)) return null
  for (const s of spans) text = text.slice(0, s.start) + s.replace + text.slice(s.end)
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

// The author queues findings for repair again: the nitpicks the proofreader left as written, or the repairs it could
// not land. A paused book keeps them until it is resumed.
export function requeue(id: number, status: 'noted' | 'unfixed') {
  run('update issues set status = ? where book_id = ? and status = ?', 'open', id, status)
  if (get('select status from books where id = ?', id)?.status !== 'paused') start(id)
}

// The author wants the whole book proofread again, at any time once it is written: every chapter is audited afresh
// with a fresh repair budget, then the loose ends and the ending are judged again. What earlier passes found and
// settled gives way to what this one finds; repairs still waiting are kept.
export function reproof(id: number) {
  if (!get('select 1 from arcs where book_id = ?', id) || get('select 1 from arcs where book_id = ? and synopsis is null', id)) return false
  tx(() => {
    run('delete from issues where book_id = ? and request_id is null and status != ?', id, 'open')
    run('update chapters set proofed = 0, repaired = 0 where book_id = ? and text is not null', id)
    run('update books set proofed = 0 where id = ?', id)
  })
  start(id)
  return true
}

async function proofFix(id: number, idx: number, signal: AbortSignal) {
  const ch = get('select * from chapters where book_id = ? and idx = ?', id, idx)!
  const open = all('select * from issues where book_id = ? and chapter = ? and status = ?', id, idx, 'open')
  const asked = open.some(i => i.request_id) // a change the author asked for, not a proofreader finding
  const problems = open.map(i => (i.request_id ? `The author of the book asked for this change: ${i.issue}` : i.fix ? `${i.issue} Fix: ${i.fix}` : i.issue))
  // The author's own changes are written with the book's model; the proofreader's findings with its own.
  // A repair that came back gutted, bloated, or repeating itself is dropped, and tried once more. Passage edits the
  // author asked for may cut as deep as they say.
  let text: string = ch.text, ok = false
  for (let n = 0; n < 2 && !ok; n++) {
    const r = await mend(id, ch, proofContext(id, [ch]), problems, !asked, signal, !asked)
    text = r.text
    if (text === ch.text) break
    ok = asked ? r.patched || countWords(text) >= ch.words * 0.7 : sane(ch.text, text, prevText(id, idx))
  }
  // No edit at all is the proofreader's recheck finding nothing to change (see patchPrompt): kept, not a failure.
  const status = ok ? 'fixed' : text === ch.text && !asked ? 'kept' : 'unfixed'
  tx(() => {
    if (ok) {
      land(id, ch, text, asked)
      for (const i of open) if (i.thread_id) closeThread(id, i.thread_id, idx)
    }
    for (const i of open) run('update issues set status = ? where id = ?', status, i.id)
  })
  if (live.get(id)?.idx === idx) live.delete(id)
}

// A changed text lands in a written chapter, with everything that hangs on it. The proofreader's first two repairs
// of a chapter get audited again; a third one is final, so repairing always terminates. A change the author
// asked for is not a repair: the chapter is simply due an audit again, and the loose ends and the ending a new
// verdict. Either way a digested chapter's recap and facts are now behind its text until refresh() catches
// them up: left stale, they would be held against the new text at the next audit. `digest` is false only
// where the edit swapped a name and nothing else, and the records were corrected by the same sweep.
function land(id: number, ch: any, text: string, asked: boolean, digest = true) {
  run('update chapters set text = ?, words = ?, before = coalesce(before, ?), proof_rounds = proof_rounds + 1, repaired = repaired + ?, proofed = ?, stale = ? where id = ?',
    text, countWords(text), ch.text, asked ? 0 : 1, !asked && ch.repaired >= 2 ? 1 : 0, digest && ch.status === 'done' ? (asked ? 2 : 1) : ch.stale, ch.id)
  redraftAfter(id, ch.idx)
  if (asked) run('update books set proofed = 0 where id = ?', id)
}

type Ending = {
  threads: { id: number; verdict: 'resolved' | 'open_ended' | 'hole'; chapter: number; fix: string }[]
  ending: { complete: boolean; fix: string }
}

async function proofEnding(id: number, signal: AbortSignal) {
  const { s } = settingsOf(id)
  // An arc index past the last arc: the whole book is "story so far". Past the highest, not the count: a cut arc leaves a gap.
  const ctx = arcContext(id, get('select coalesce(max(idx), -1) + 1 n from arcs where book_id = ?', id)!.n, 80_000)
  const r = await generateJson<Ending>({ ...proofOpts(s), instructions: P.architect(s), input: P.endingPrompt(ctx), signal }, 'loose_ends', P.endingSchema)
  const last = get('select max(idx) m from chapters where book_id = ?', id)!.m
  const at = (n: number) => (n >= 1 && n <= last ? n : last)
  tx(() => {
    for (const t of r.threads) {
      const th = get('select text from threads where id = ? and book_id = ? and status = ?', t.id, id, 'open')
      if (!th) continue
      if (t.verdict === 'hole') addIssue(id, at(t.chapter), `Unresolved plot thread: ${th.text}`, t.fix, 'open', t.id)
      else closeThread(id, t.id, at(t.chapter))
    }
    if (!r.ending.complete) addIssue(id, last, 'The ending does not deliver the conclusion the book promises.', r.ending.fix, 'open')
    run('update books set proofed = 1 where id = ?', id)
  })
}

// --- Director: the author can change the book at any point, by a request or about a highlighted passage. ---
// One call turns the request into changes to the canon and the plan, which land at once, and into edits of
// written chapters, which go through the same passage repair as the proofreader's findings. Autopilot then
// writes on from the changed plan.

type Direction = {
  reply: string
  renames: { from: string; to: string }[]
  traces: string[]
  about: string[]
  directions: string[]
  bible: { field: string; value: string }[]
  entities: { kind: string; name: string; sheet: string; state: string }[]
  arcs: { arc: number; title: string; goal: string; plan: string; chapters: number }[]
  arcs_cut: number[]
  chapters: { chapter: number; title: string; pov: string; cast: string[]; beats: string[]; hook: string }[]
  fixes: { chapter: number; change: string }[]
  facts_dropped: number[]
  threads_closed: number[]
}

async function direct(id: number, req: any, signal: AbortSignal) {
  const { s } = settingsOf(id)
  if (req.hand) {
    // A chapter the author rewrote: tell the director what changed, paragraph by paragraph, from the copy kept when they saved.
    const kept = get('select undo from requests where id = ?', req.id)?.undo
    const was: string = kept ? (JSON.parse(kept).chapters.find((c: any) => c.idx === req.chapter)?.text ?? '') : ''
    const now: string = get('select text from chapters where book_id = ? and idx = ?', id, req.chapter)?.text ?? ''
    const paras = (t: string) => t.split(/\n+/).map(p => p.trim()).filter(Boolean)
    const [a, b] = [paras(was), paras(now)]
    req = { ...req, text: P.handPrompt(req.chapter, a.filter(p => !b.includes(p)), b.filter(p => !a.includes(p))) }
  }
  const r = await generateJson<Direction>(
    { ...llmOpts(s), instructions: P.architect(s), input: P.directPrompt(directContext(id, req), req.text, req.chapter, req.quote), signal }, 'direction', P.directSchema)
  applyDirection(id, req.id, r)
}

export function applyDirection(id: number, reqId: number, r: Direction) {
  tx(() => {
    const req = get('select chapter, quote, hand, undo is not null kept from requests where id = ? and reply is null and undone = 0', reqId)
    if (!req) return // withdrawn or undone while the director was at work
    const s: Settings = JSON.parse(get('select settings from books where id = ?', id)!.settings)
    const directions = r.directions.map(d => d.trim()).filter(Boolean)
    // A reply that changes nothing leaves nothing to undo.
    const changes = [r.renames, r.traces, r.about, r.bible, r.entities, r.arcs, r.arcs_cut, r.chapters, r.fixes, r.facts_dropped, r.threads_closed].some(a => a.length)
    if (!req.kept && (changes || JSON.stringify(directions) !== JSON.stringify(s.directions ?? []))) keep(id, reqId)

    // What the change really did, line by line, for the author to read next to the reply: only what landed.
    const did: string[] = []
    const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
    for (const n of r.renames) if (rename(id, n.from.trim(), n.to.trim())) did.push(`Renamed ${n.from.trim()} to ${n.to.trim()}`)

    // A rename replaces the form it was given, and the text mostly uses others: "Evan" far more often than
    // "Evan Brooks". Each word the name lost is followed up here rather than left for the author to find.
    // Alone and unmistakable, it is renamed too. Shared with another name ("Shah", when her mother keeps it), or
    // also an ordinary word ("Rose", in a book where someone rose), it cannot be replaced blind: everything
    // written that uses it is read by the model instead (sweep()).
    const texts = all('select text from chapters where book_id = ? and text is not null', id).map(c => c.text as string)
    const terms: Term[] = []
    const look: string[] = []
    for (const n of r.renames) {
      const [from, to] = [n.from.trim().split(/\s+/), n.to.trim().split(/\s+/)]
      if (from.length > 1)
        from.forEach((w, i) => {
          const gone = !to.some(t => t.toLowerCase() === w.toLowerCase()) && !r.renames.some(x => x.from.trim().toLowerCase() === w.toLowerCase())
          if (!gone || w.length < 2 || !/^\p{Lu}/u.test(w)) return
          const now = from.length === to.length ? to[i] : null
          const shared = all('select name from entities where book_id = ?', id).some(e => e.name.toLowerCase() !== n.to.trim().toLowerCase() && wordsRe(w, { loose: true }).test(e.name))
          const lower = wordsRe(w.toLowerCase())
          const ordinary = texts.some(t => lower.test(t))
          if (now && !shared && !ordinary) {
            if (rename(id, w, now)) did.push(`Renamed ${w} to ${now}`)
          } else {
            terms.push({ t: w, exact: true })
            look.push(`"${w}" on its own, where it means ${n.to.trim()} (${n.from.trim()} before the change)${now ? `: there it is now "${now}"` : ''}. It stays wherever it names someone or something else.`)
          }
        })
    }
    for (const t of r.traces.map(t => t.trim()).filter(t => t.length > 1)) terms.push({ t, exact: false })
    if (r.traces.length) look.push(`Anything the change touches, found by: ${r.traces.join(', ')}.`)
    // Who the change is about: as the director says, and anyone already in the book whose profile it rewrote,
    // named or not. A new profile means something the written chapters show of them may no longer be true.
    const known = entityFinder(id)
    const about = [...new Set([...r.about.map(a => a.trim()), ...r.entities.filter(e => e.sheet.trim()).map(e => known(e.name)?.name as string)].filter(Boolean))]
    if (about.length) look.push(`What the chapters show or say of ${about.join(', ')}, whether by name or by "she", a title, or a description: wherever the change makes it untrue.`)
    if (terms.length || about.length) {
      const job: Sweep = { terms, about, look, records: false, names: !r.traces.length && !about.length }
      const { chs, found } = reach(id, job)
      for (const c of chs) if (found.has(c.idx)) run('update chapters set sweep = ? where id = ?', reqId, c.id)
      run('update requests set sweep = ? where id = ?', JSON.stringify(job), reqId)
      did.push(`Reading ${count(found.size, 'chapter')} and the story's records for what the change left behind`)
    }
    const last = get('select max(idx) m from chapters where book_id = ? and status != ?', id, 'planned')!.m ?? 0
    const find = entityFinder(id)
    for (const e of r.entities) {
      const known = find(e.name)
      if (known) run('update entities set sheet = ?, state = ? where id = ?', e.sheet.trim() || known.sheet, e.state.trim() || known.state, known.id)
      else addEntity(id, e.kind, e.name, e.sheet, e.state, last)
    }
    if (r.entities.length) did.push(`Characters and elements: ${r.entities.map(e => e.name.trim()).join(', ')}`)
    // Only what is not written yet can be re-planned; a written chapter changes through an edit.
    const written = (arc: number) => get('select count(*) n from chapters where book_id = ? and arc_idx = ? and status != ?', id, arc, 'planned')!.n
    for (const n of r.arcs_cut) {
      // Only an arc nothing was written for can be cut.
      const arc = get('select id, idx, title from arcs where book_id = ? and idx = ? and synopsis is null', id, n - 1)
      if (!arc || written(arc.idx)) continue
      run('delete from chapters where book_id = ? and arc_idx = ?', id, arc.idx)
      run('delete from arcs where id = ?', arc.id)
      did.push(`Cut the arc "${arc.title}"`)
    }
    for (const a of r.arcs) {
      const arc = get('select * from arcs where book_id = ? and idx = ?', id, a.arc - 1)
      const wrote = arc ? written(arc.idx) : 0
      // A written arc is closed to re-planning, with or without its synopsis (cleared while an edit is digested).
      if (arc && (arc.synopsis || (arc.expanded && wrote > 0 && !get('select 1 from chapters where book_id = ? and arc_idx = ? and status != ?', id, arc.idx, 'done')))) continue
      const others = get('select coalesce(sum(chapter_count), 0) n from arcs where book_id = ? and idx != ?', id, a.arc - 1)!.n
      // The book's length is the author's to change, an arc at a time, up to the 1000 chapters a new book may have.
      // 0 keeps an arc as long as it is: a model unsure of a number tends to write 0.
      const n = Math.max(wrote, arc ? 1 : 0, Math.min(Math.round(a.chapters) || arc?.chapter_count || 0, 1000 - others))
      if (!arc) {
        if (!n) continue
        // A new arc goes on the end, and the ending it brings has yet to be proofread.
        run('insert into arcs (book_id, idx, title, goal, plan, chapter_count) select ?, coalesce(max(idx), -1) + 1, ?, ?, ?, ? from arcs where book_id = ?', id, a.title, a.goal, a.plan, n, id)
        run('update books set proofed = 0 where id = ?', id)
        did.push(`Added the arc "${a.title}", ${count(n, 'chapter')}`)
        continue
      }
      run('update arcs set title = ?, goal = ?, plan = ?, chapter_count = ? where id = ?', a.title, a.goal, a.plan, n, arc.id)
      did.push(`Re-planned the arc "${a.title}"${n !== arc.chapter_count ? `, now ${count(n, 'chapter')} instead of ${arc.chapter_count}` : ''}`)
      if (n !== arc.chapter_count) {
        // An arc that changes length has its unwritten chapters planned again, from where the story stands.
        // One cut down to what is written has nothing left to plan, whether or not a plan was pending.
        run('delete from chapters where book_id = ? and arc_idx = ? and status = ?', id, arc.idx, 'planned')
        run('update arcs set expanded = ? where id = ?', n > wrote ? 0 : 1, arc.id)
      }
    }
    const planned = r.chapters.filter(c =>
      run('update chapters set title = ?, pov = ?, cast_names = ?, beats = ?, hook = ? where book_id = ? and idx = ? and status = ?',
        c.title, c.pov, JSON.stringify(c.cast), JSON.stringify(c.beats), c.hook, id, c.chapter, 'planned').changes)
    if (planned.length) did.push(`Re-planned chapter${planned.length === 1 ? '' : 's'} ${planned.map(c => c.chapter).join(', ')}`)
    for (const f of r.fixes) {
      if (req.hand && f.chapter === req.chapter) continue // the author's own text is final
      if (get('select 1 from chapters where book_id = ? and idx = ? and status != ?', id, f.chapter, 'planned'))
        addIssue(id, f.chapter, f.chapter === req.chapter && req.quote ? `${f.change}\nThe passage the author highlighted: "${req.quote}"` : f.change, '', 'open', null, reqId)
    }
    const dropped = r.facts_dropped.filter(f => run('delete from facts where id = ? and book_id = ?', f, id).changes).length
    if (dropped) did.push(`Dropped ${count(dropped, 'canon fact')}`)
    const closed = r.threads_closed.filter(t => closeThread(id, t, last).changes).length
    if (closed) did.push(`Closed ${count(closed, 'plot thread')}`)

    const book = get('select bible, title from books where id = ?', id)! // read after the renames
    const bible = JSON.parse(book.bible)
    const lines = (v: string) => v.split('\n').map(l => l.replace(/^\s*[-•]\s*/, '').trim()).filter(Boolean)
    for (const b of r.bible)
      bible[b.field] =
        b.field === 'rules' || b.field === 'themes' ? lines(b.value)
        : b.field === 'glossary' ? lines(b.value).map(l => ({ term: l.split(':')[0].trim(), meaning: l.slice(l.indexOf(':') + 1).trim() }))
        : b.value.trim()
    if (r.bible.length) did.push(`Story bible: ${[...new Set(r.bible.map(b => b.field.replace('_', ' ')))].join(', ')}`)
    if (JSON.stringify(directions) !== JSON.stringify(s.directions ?? [])) did.push('Standing directions updated')
    s.directions = directions
    s.chapters = get('select coalesce(sum(chapter_count), ?) n from arcs where book_id = ?', s.chapters ?? 0, id)!.n
    run('update books set bible = ?, settings = ?, title = ? where id = ?', JSON.stringify(bible), JSON.stringify(s), bible.title || book.title, id)
    run('update requests set reply = ?, effects = ? where id = ?', r.reply.trim() || 'Done.', JSON.stringify(did), reqId)
  })
}

// --- Undo: every change the author makes keeps a copy of the book from just before it. ---
const KEPT = ['entities', 'arcs', 'chapters', 'facts', 'threads', 'issues']

// A whole-book copy per change, the last 10 kept. Store row diffs if long books make that hurt.
function keep(id: number, reqId: number) {
  const copy: Record<string, any> = { book: get('select title, bible, settings, proofed from books where id = ?', id) }
  for (const t of KEPT) copy[t] = all(`select * from ${t} where book_id = ?`, id)
  run('update requests set undo = ?, wrote = ? where id = ?', JSON.stringify(copy), copy.chapters.filter((c: any) => c.status !== 'planned').length, reqId)
  run('update requests set undo = null where book_id = ? and id not in (select id from requests where book_id = ? and undo is not null order by id desc limit 10)', id, id)
}

// Puts the book back to the moment before a change. Everything since goes with it: later changes, and
// chapters written on top of it, which autopilot then writes again.
export function undo(id: number, reqId: number) {
  const kept = get('select undo from requests where id = ? and book_id = ? and undo is not null', reqId, id)?.undo
  if (!kept) return false
  interrupt(id)
  const copy = JSON.parse(kept)
  tx(() => {
    // Inkstone holds the text it was sent: a chapter whose text goes back is sent again once it is written.
    const old = new Map<number, string | null>(copy.chapters.map((c: any) => [c.idx, c.text]))
    for (const c of all('select idx, text from chapters where book_id = ? and text is not null', id))
      if (old.get(c.idx) !== c.text) run('update ink_chapters set ver = -1 where book_id = ? and idx = ? and ver is not null', id, c.idx)
    for (const t of KEPT) {
      run(`delete from ${t} where book_id = ?`, id)
      for (const row of copy[t] as Record<string, SQLInputValue>[])
        run(`insert into ${t} (${Object.keys(row).join(', ')}) values (${Object.keys(row).map(() => '?').join(', ')})`, ...Object.values(row))
    }
    // Speed settings are not part of the story: they stay as they are now.
    const was = JSON.parse(copy.book.settings)
    const s = { ...JSON.parse(get('select settings from books where id = ?', id)!.settings), directions: was.directions, chapters: was.chapters }
    run('update books set title = ?, bible = ?, settings = ?, proofed = ? where id = ?', copy.book.title, copy.book.bible, JSON.stringify(s), copy.book.proofed, id)
    run('update requests set undone = 1, undo = null where book_id = ? and id >= ? and (reply is not null or hand = 1)', id, reqId)
  })
  // A finished book may have chapters to write again.
  if (get('select status from books where id = ?', id)!.status === 'complete') start(id)
  else nudge(id)
  return true
}

// The author rewrote a chapter by hand. Their text is final; the director then brings the canon, the plan,
// and any chapter it now contradicts in line with it.
export function rewrite(id: number, idx: number, text: string) {
  const ch = get('select id, status, text from chapters where book_id = ? and idx = ? and status != ?', id, idx, 'planned')
  if (!ch) return false
  if (ch.text === text) return true
  interrupt(id) // a step in flight may be reading this chapter's old text, or about to write over the new one
  tx(() => {
    const req = Number(run('insert into requests (book_id, chapter, text, hand) values (?, ?, ?, 1)', id, idx, `Edited chapter ${idx} by hand.`).lastInsertRowid)
    keep(id, req)
    // A digested chapter has its recap and facts read again; the proofreader and Inkstone see a new text.
    run('update chapters set text = ?, words = ?, before = coalesce(before, ?), proof_rounds = proof_rounds + 1, proofed = 0, stale = ? where id = ?', text, countWords(text), ch.text, ch.status === 'done' ? 2 : 0, ch.id)
    redraftAfter(id, idx)
    // What the proofreader found in the old text no longer points at anything: repairing from it would have the
    // model rewrite the author's chapter. The chapter is audited afresh instead, and the ending judged again.
    // A loose end waiting to be paid off here still stands: it asks for an addition, not for a passage.
    run('delete from issues where book_id = ? and chapter = ? and request_id is null and thread_id is null and status in (?, ?)', id, idx, 'open', 'noted')
    run('update books set proofed = 0 where id = ?', id)
  })
  nudge(id)
  return true
}

// Every place a name can sit. A rename lands in all of them at once, written and planned, so no chapter is
// left for a model to miss.
const NAMED: [string, string[]][] = [
  ['arcs', ['title', 'goal', 'plan', 'synopsis']],
  ['chapters', ['title', 'pov', 'cast_names', 'beats', 'hook', 'text', 'summary', 'detail', 'scene_end']],
  ['entities', ['name', 'sheet', 'state']],
  ['facts', ['text', 'tags']],
  ['threads', ['text', 'payoff']],
]

// Returns how many rows it changed.
function rename(id: number, from: string, to: string) {
  if (!from || !to || from === to) return 0
  let rows = 0
  const re = wordsRe(from, { caps: true, all: true })
  // "EVAN BROOKS" on a sign becomes "KAIZER BROOKS".
  const put = (m: string) => (m !== from && m === m.toUpperCase() ? to.toUpperCase() : to)
  const swap = (v: unknown): any =>
    typeof v === 'string' ? v.replace(re, put)
    : Array.isArray(v) ? v.map(swap)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]))
    : v
  const json = (v: string) => JSON.stringify(swap(JSON.parse(v)))
  for (const [table, cols] of NAMED)
    for (const row of all(`select * from ${table} where book_id = ?`, id)) {
      const set: Record<string, string | number> = {}
      for (const c of cols) {
        if (typeof row[c] !== 'string') continue
        const v = c === 'cast_names' || c === 'beats' ? json(row[c]) : swap(row[c])
        if (v !== row[c]) set[c] = v
      }
      // A new round has Inkstone upload the chapter again. The text from before is kept to show what changed: the
      // oldest one the author has not dismissed, so a change is never dropped from view by the next.
      if (table === 'chapters' && typeof set.text === 'string') Object.assign(set, { words: countWords(set.text), proof_rounds: row.proof_rounds + 1, before: row.before ?? row.text })
      const keys = Object.keys(set)
      // "or ignore": a name that is already taken keeps its owner.
      if (keys.length) rows += Number(run(`update or ignore ${table} set ${keys.map(k => `${k} = ?`).join(', ')} where id = ?`, ...Object.values(set), row.id).changes)
    }
  const bible = get('select bible from books where id = ?', id)!.bible
  if (json(bible) !== bible) rows += Number(run('update books set bible = ? where id = ?', json(bible), id).changes)
  return rows
}

// --- The sweep: after a change, everything written before it that the change may reach is found and read. ---
// The director sees most chapters only as summaries, so it cannot list everything its change reaches, and a
// word shared with other names cannot be replaced blind. What may still hold the old version is found three
// ways: a name part, exactly as the text spells it; a trace word, in any of its forms ("key" finds "keys");
// and, for a change to something true of a character or thing, every chapter they are in or spoken of, since
// the prose there may say "she" or "the nurse" and never the name. The model then reads what was found: the
// story's records first (recaps, facts, states, plans, the bible), which feed every later chapter, then the chapters.

type Term = { t: string; exact: boolean } // exact: a name part, as spelled or in capitals; otherwise a trace, in any form
// `names`: only parts of names were left behind, so their edits change no fact of the story.
type Sweep = { terms: Term[]; about: string[]; look: string[]; records: boolean; names: boolean }

const paragraphs = (text: string | null) => (text ?? '').split(/\n+/).map(p => p.trim()).filter(Boolean)

// Which of `texts` use one of the terms. A trace is matched by word stem through SQLite's own full-text index,
// built for the moment: nothing to keep in step with every edit, and a whole book is small enough to load.
function search(texts: string[], terms: Term[]) {
  const hit = new Set<number>()
  const stemmed = terms.filter(t => !t.exact && !CJK.test(t.t) && /[\p{L}\p{N}]/u.test(t.t))
  for (const t of terms.filter(t => !stemmed.includes(t))) {
    const re = wordsRe(t.t, t.exact ? { caps: true } : { loose: true })
    texts.forEach((s, i) => re.test(s) && hit.add(i))
  }
  if (stemmed.length) {
    db.exec("create virtual table temp.found using fts5(text, tokenize = 'porter unicode61')")
    try {
      const add = db.prepare('insert into temp.found (rowid, text) values (?, ?)')
      texts.forEach((s, i) => add.run(i + 1, s))
      for (const t of stemmed) for (const r of all('select rowid from temp.found where found match ?', `"${t.t.replace(/"/g, '""')}"`)) hit.add(r.rowid - 1)
    } finally {
      db.exec('drop table temp.found')
    }
  }
  return hit
}

// Where a change may have left the old version, chapter by chapter: the paragraphs that use one of its words,
// and `full` where the chapter involves someone or something the change is about, so that all of it is read.
function reach(id: number, job: Sweep) {
  const chs = all('select * from chapters where book_id = ? and status != ? order by idx', id, 'planned')
  const found = new Map<number, { full: boolean; paras: Set<number> }>()
  const at = (idx: number) => found.get(idx) ?? found.set(idx, { full: false, paras: new Set() }).get(idx)!
  const paras = chs.flatMap(c => paragraphs(c.text).map((text, n) => ({ idx: c.idx as number, n, text })))
  for (const i of search(paras.map(p => p.text), job.terms)) at(paras[i].idx).paras.add(paras[i].n)

  const find = entityFinder(id)
  const names = all('select name from entities where book_id = ?', id).map(e => e.name as string)
  const facts = new Map<number, string>()
  for (const f of job.about.length ? all('select chapter, text, tags from facts where book_id = ?', id) : []) facts.set(f.chapter, `${facts.get(f.chapter) ?? ''} ${f.text} ${f.tags}`)
  for (const e of new Set(job.about.map(find).filter(e => e !== undefined))) {
    // A chapter's records use the name even where its prose says "she": the cast it was planned with, its recap,
    // its facts. The name in full, or a word of it that nobody else carries.
    const own = String(e.name).split(/\s+/).filter(w => w.length > 2 && /^\p{Lu}/u.test(w) && !names.some(n => n !== e.name && wordsRe(w, { loose: true }).test(n)))
    const res = [e.name, ...own].map(w => wordsRe(w, { caps: true }))
    for (const c of chs) {
      const cast = [c.pov, ...JSON.parse(c.cast_names)].some(n => find(n)?.id === e.id)
      const records = [c.text, c.summary, c.detail, c.scene_end, c.beats, facts.get(c.idx)].join(' ')
      if (cast || res.some(re => re.test(records))) at(c.idx).full = true
    }
  }
  return { chs, found }
}

// One unit of work per call; `requests.sweep` and `chapters.sweep` say what is left.
async function sweep(id: number, reqId: number, signal: AbortSignal) {
  const { s } = settingsOf(id)
  const req = get('select text, reply, sweep from requests where id = ?', reqId)!
  const job: Sweep = JSON.parse(req.sweep)
  const cast = all('select name, kind from entities where book_id = ? order by first_chapter, id', id).map(e => `${e.name} (${e.kind})`).join(', ')
  const g = { ...llmOpts(s), instructions: P.architect(s), signal }
  const brief = P.sweepBrief(cast, req.text, req.reply, job.look)

  if (!job.records) {
    type Cell = { text: string; table?: string; id?: number; col?: string; path?: string[] }
    const every: Cell[] = NAMED.flatMap(([table, cols]) =>
      all(`select * from ${table} where book_id = ?`, id).flatMap(row =>
        cols.filter(c => !(table === 'chapters' && c === 'text') && typeof row[c] === 'string' && row[c]).map(col => ({ table, id: row.id as number, col, text: row[col] as string }))))
    // The story bible is in every chapter's context: each line of it that the writer reads is a record too.
    const bible = JSON.parse(get('select bible from books where id = ?', id)!.bible)
    const walk = (v: unknown, path: string[]) => {
      if (typeof v === 'string') v && every.push({ path, text: v })
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...path, k])
    }
    for (const k of ['title', 'logline', 'synopsis', 'themes', 'world', 'rules', 'power_system', 'glossary']) walk(bible[k], [k])
    const hit = search(every.map(c => c.text), job.terms)
    const cells = every.filter((_, i) => hit.has(i))
    const fixed: { cell: Cell; text: string }[] = []
    for (let i = 0; i < cells.length; ) {
      const batch = [cells[i++]]
      for (let size = tokens(batch[0].text); i < cells.length && size + tokens(cells[i].text) <= 10_000; ) size += tokens((batch[batch.length] = cells[i++]).text)
      const r = await generateJson<{ notes: { n: number; text: string }[] }>({ ...g, input: P.recordsSweepPrompt(brief, batch.map(c => c.text)) }, 'records_sweep', P.recordsSweepSchema)
      for (const n of r.notes) {
        const cell = batch[n.n - 1]
        const text = String(n.text ?? '').trim()
        if (!cell || !text || text === cell.text) continue
        // A list stays a list: a plan's cast and beats are read back as JSON.
        if (cell.col === 'cast_names' || cell.col === 'beats') {
          try {
            if (!Array.isArray(JSON.parse(text))) continue
          } catch {
            continue
          }
        }
        fixed.push({ cell, text })
      }
    }
    tx(() => {
      for (const { cell, text } of fixed) {
        if (cell.path) cell.path.slice(0, -1).reduce((o, k) => o[k], bible)[cell.path.at(-1)!] = text
        else run(`update or ignore ${cell.table} set ${cell.col} = ? where id = ?`, text, cell.id!)
      }
      if (fixed.some(f => f.cell.path)) run('update books set bible = ?, title = ? where id = ?', JSON.stringify(bible), bible.title, id)
      run('update requests set sweep = ? where id = ?', JSON.stringify({ ...job, records: true }), reqId)
    })
    return
  }

  // The chapters, as many to a call as fit. One that involves what the change is about is read whole. Any other
  // is shown as the passages that use a word the change touches, each with the paragraph before and after it:
  // enough to tell whose "Shah" it is, at a fraction of the reading.
  const { chs, found } = reach(id, job)
  const batch: { ch: any; shown: string; whole: boolean }[] = []
  let size = 0
  for (const c of chs.filter(c => c.sweep === reqId)) {
    const f = found.get(c.idx)
    const near = new Set([...(f?.paras ?? [])].flatMap(n => [n - 1, n, n + 1]))
    const ps = paragraphs(c.text).map((p, n) => (f?.full || near.has(n) ? p : '[…]'))
    const shown = ps.filter((p, n) => p !== '[…]' || ps[n - 1] !== '[…]').join('\n\n')
    if (batch.length && size + tokens(shown) > 30_000) break
    batch.push({ ch: c, shown, whole: !!f?.full })
    size += tokens(shown)
  }
  if (!batch.length) return void run('update requests set sweep = null where id = ?', reqId)
  const read = batch.filter(b => b.shown !== '[…]') // nothing of the change left in the others by now
  const r = read.length
    ? await generateJson<{ chapters: { chapter: number; edits: { find: string; replace: string }[] }[] }>(
        { ...g, input: P.chapterSweepPrompt(brief, read.map(b => `=== Chapter ${b.ch.idx}: ${b.ch.title}${b.whole ? '' : ' (passages only; […] stands for what is left out)'} ===\n${b.shown}`).join('\n\n')) }, 'chapter_sweep', P.chapterSweepSchema)
    : { chapters: [] }
  tx(() => {
    for (const c of r.chapters) {
      const b = read.find(b => b.ch.idx === c.chapter)
      if (!b || !Array.isArray(c.edits) || !c.edits.length) continue
      const text = applyEdits(b.ch.text, c.edits)
      const what = c.edits.map(e => `“${e.find}” becomes “${e.replace}”`).join('\n')
      // The edits land as they are when every passage can be placed for certain. Otherwise the usual repair
      // takes them: it has the whole chapter in front of it.
      if (!text) addIssue(id, c.chapter, what, '', 'open', null, reqId)
      else if (text !== b.ch.text) (land(id, b.ch, text, true, !job.names), addIssue(id, c.chapter, what, '', 'fixed', null, reqId))
    }
    for (const b of batch) run('update chapters set sweep = 0 where id = ?', b.ch.id)
  })
}

// An edited chapter that was already digested: its memory is read again from the new text.
// `stale` says whose edit it was: 2 the author's, 1 a proofreader repair.
async function refresh(id: number, ch: any, signal: AbortSignal) {
  const { s } = settingsOf(id)
  const authored = ch.stale === 2
  // The last written chapter of a book still being written is where the story stands, so an edit to it, the
  // author's or a repair of what its continuity pass left behind, moves entity states and threads as well: the
  // whole memory pass is done again.
  const present =
    !get('select 1 from chapters where book_id = ? and idx > ? and status != ?', id, ch.idx, 'planned') &&
    !!(get('select 1 from chapters where book_id = ? and status = ?', id, 'planned') || get('select 1 from arcs where book_id = ? and expanded = 0', id))
  // What the old text did to the threads is taken back first, so the editor reads them as they stood before
  // this chapter: one it resolved is open again until the new text is seen to resolve it. A repair by the
  // proofreader to a finished book leaves them alone: it closes the thread it pays off itself. If the step is cut
  // short after this, the chapter is still stale and it all runs again.
  if (authored || present)
    tx(() => {
      if (present) run('delete from threads where book_id = ? and chapter = ? and status = ?', id, ch.idx, 'open')
      run('update threads set status = ?, resolved_in = null where book_id = ? and resolved_in = ?', 'open', id, ch.idx)
    })
  const m = await generateJson<Memory>({ ...llmOpts(s), instructions: P.architect(s), input: P.memoryPrompt(chapterContext(id, ch), ch.text, present), signal }, 'chapter_memory', P.memorySchema)
  const find = entityFinder(id)
  tx(() => {
    run('delete from facts where book_id = ? and chapter = ?', id, ch.idx)
    if (present) applyMemory(id, ch, m)
    else {
      // An earlier chapter, or a finished book: its own recap and facts, and the threads it resolves. Entity
      // states describe the story's present, which later chapters have moved on, so those are the director's to set.
      run('update chapters set summary = ?, detail = ?, scene_end = ? where id = ?', m.summary, m.detail, m.scene_end, ch.id)
      for (const f of m.facts) run('insert into facts (book_id, chapter, text, tags) values (?, ?, ?, ?)', id, ch.idx, f.text, f.tags.join(' '))
      for (const n of m.new_entities) if (!find(n.name)) addEntity(id, n.kind, n.name, n.sheet, n.state, ch.idx)
      // Only a thread opened by this point in the book can be one this chapter resolves.
      if (authored) for (const t of m.threads_resolved) if (get('select 1 from threads where id = ? and book_id = ? and chapter <= ?', t, id, ch.idx)) closeThread(id, t, ch.idx)
    }
    run('update chapters set stale = 0 where id = ?', ch.id)
    // A finished arc's synopsis was written from the old recap. Cleared, it is the next thing autopilot writes.
    run('update arcs set synopsis = null where book_id = ? and idx = ?', id, ch.arc_idx)
  })
}
