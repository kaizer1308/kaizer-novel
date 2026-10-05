import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.KAIZER_DB = ':memory:'
const { run, get, all, kvSet } = await import('./db.ts')
const { start, nudge, undo, rewrite, applyEdits, requeue, reproof, home } = await import('./engine.ts')

test('edits land only where the passage is found exactly once', () => {
  const text = 'She said, “No.”\n\nOne. Two. Three.'
  assert.equal(applyEdits(text, [{ find: 'said,  "No."', replace: 'said, “Yes.”' }]), 'She said, “Yes.”\n\nOne. Two. Three.') // quote style and spacing may drift
  assert.equal(applyEdits(text, [{ find: 'Three.', replace: 'Four.' }, { find: 'Two.', replace: '' }]), 'She said, “No.”\n\nOne. Four.')
  assert.equal(applyEdits(text, [{ find: 'o.', replace: 'x' }]), null) // found more than once
  assert.equal(applyEdits(text, [{ find: 'Five.', replace: 'x' }]), null) // not found
  assert.equal(applyEdits(text, [{ find: 'One. Two.', replace: 'x' }, { find: 'Two. Three.', replace: 'y' }]), null) // overlapping
  assert.equal(applyEdits(text, []), null)
})

test('a finding filed under the wrong chapter of its window moves to the one its quotes are in', () => {
  const chs = [
    { idx: 32, text: '“Your father being sick did not make you a saint,” he says.\n\n“I never thought I was a saint.”' },
    { idx: 36, text: '“You came back because I was sick,” I say.' },
  ]
  const i = { chapter: 36, issue: 'Martin says “Your father being sick did not make you a saint.” to his own son.', fix: 'Make it “my being sick”.' }
  assert.equal(home(i, chs), 32)
  assert.equal(home({ ...i, chapter: 32 }, chs), 32) // already right
  assert.equal(home({ ...i, fix: 'Match chapter 34.' }, chs), 36) // it cites another chapter: the quote may be the other side
  assert.equal(home({ ...i, issue: 'Martin calls himself “your father” twice.' }, chs), 36) // too short to place
})

test('proofreader audits a finished book, repairs flagged chapters, re-checks them, and closes loose ends', async () => {
  kvSet('session', { clientId: 'c', subject: 's', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 })
  const bible = { title: 'T', logline: 'L', synopsis: 'S', themes: [], world: 'W', rules: [], power_system: 'none', glossary: [] }
  const settings = { model: 'm', genre: 'g', tropes: [], tone: 't', rating: 'r', language: 'English', pov: 'p', tense: 'past', words: 10, style: '' }
  const id = Number(run('insert into books (title, settings, bible, status, created_at, updated_at) values (?, ?, ?, ?, 0, 0)', 'T', JSON.stringify(settings), JSON.stringify(bible), 'complete').lastInsertRowid)
  run('insert into arcs (book_id, idx, title, goal, plan, chapter_count, expanded, synopsis) values (?, 0, ?, ?, ?, 3, 1, ?)', id, 'A', 'G', 'P', 'what happened')
  const prose = 'one two three four five six seven eight nine ten'
  for (const idx of [1, 2, 3])
    run('insert into chapters (book_id, arc_idx, idx, title, status, text, words, summary, detail, scene_end) values (?, 0, ?, ?, ?, ?, 10, ?, ?, ?)', id, idx, `C${idx}`, 'done', prose, 's', 'd', 'e')
  const thread = Number(run('insert into threads (book_id, chapter, text) values (?, 1, ?)', id, 'Who took the key?').lastInsertRowid)

  // Fake model: the first audit flags chapter 2 and a nitpick in chapter 1, later audits are clean; the ending check calls
  // the thread a hole in chapter 3. Repairs come back as edits; the second one (chapter 2's) quotes a passage the chapter
  // does not have, which forces a full rewrite.
  const calls: string[] = []
  const reply = (text: string) =>
    new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`)
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const kind: string = JSON.parse(init.body as string).text?.format?.name ?? 'rewrite'
    calls.push(kind)
    if (kind === 'proofread')
      return reply(JSON.stringify({
        issues: calls.length === 1
          ? [{ chapter: 2, severity: 'high', issue: 'The key is brass here, silver in chapter 1.', fix: 'Make it silver.' }, { chapter: 1, severity: 'low', issue: 'nitpick', fix: '' }]
          : [],
        threads_resolved: [],
      }))
    if (kind === 'loose_ends')
      return reply(JSON.stringify({ threads: [{ id: thread, verdict: 'hole', chapter: 3, fix: 'Reveal who took the key.' }], ending: { complete: true, fix: '' } }))
    if (kind === 'chapter_edits')
      return reply(JSON.stringify({ edits: [{ find: calls.filter(c => c === kind).length === 2 ? 'not in the chapter' : 'one two', replace: 'FIXED one two' }] }))
    // A repaired chapter has its recap and facts read again, and its arc's synopsis written again.
    if (kind === 'chapter_memory')
      return reply(JSON.stringify({ summary: 'after repair', detail: 'd', scene_end: 'e', facts: [], entity_updates: [], new_entities: [], threads_opened: [], threads_resolved: [], continuity_issues: [] }))
    if (kind === 'arc_synopsis') return reply(JSON.stringify({ synopsis: 'what happened', threads_resolved: [] }))
    return reply(`FIXED ${prose} rewritten`)
  }) as typeof fetch

  start(id)
  for (let i = 0; i < 200 && get('select status from books where id = ?', id)!.status === 'running'; i++) await sleep(25)

  const book = get('select status, error, proofed from books where id = ?', id)!
  assert.deepEqual([book.status, book.error, book.proofed], ['complete', null, 1])
  // The nitpick is repaired as well, without being asked: chapter 1 first, then 2, then the re-audit, then the loose ends.
  assert.deepEqual(calls, ['proofread', 'chapter_edits', 'chapter_memory', 'chapter_edits', 'rewrite', 'chapter_memory', 'arc_synopsis', 'proofread', 'loose_ends', 'chapter_edits', 'chapter_memory', 'arc_synopsis', 'proofread'])
  assert.deepEqual(all('select summary from chapters where book_id = ? order by idx', id).map(c => c.summary), ['after repair', 'after repair', 'after repair']) // memory follows the repaired text
  assert.deepEqual(all('select text from chapters where book_id = ? order by idx', id).map(c => c.text), [`FIXED ${prose}`, `FIXED ${prose} rewritten`, `FIXED ${prose}`])
  assert.deepEqual(all('select chapter, status from issues where book_id = ? order by id', id).map(i => `${i.chapter}:${i.status}`), ['1:fixed', '2:fixed', '3:fixed']) // recorded earliest chapter first
  assert.deepEqual({ ...get('select status, resolved_in from threads where id = ?', thread)! }, { status: 'resolved', resolved_in: 3 })

  // A nitpick left from before (a book proofread when they waited for the author) is still repaired on request.
  run('insert into issues (book_id, chapter, issue, fix, status) values (?, 3, ?, ?, ?)', id, 'old nitpick', 'Fix it.', 'noted')
  requeue(id, 'noted')
  for (let i = 0; i < 200 && get('select status from books where id = ?', id)!.status === 'running'; i++) await sleep(25)
  assert.deepEqual(calls.slice(13), ['chapter_edits', 'chapter_memory', 'arc_synopsis', 'proofread'])
  assert.equal(get('select status from issues where book_id = ? and issue = ?', id, 'old nitpick')!.status, 'fixed')
})

test('a request from the author changes canon, plan, and written text, and a paused book stays paused', async () => {
  kvSet('session', { clientId: 'c', subject: 's', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 })
  const bible = { title: 'T', logline: 'L', synopsis: 'S', themes: [], world: 'W', rules: ['Keys are brass'], power_system: 'none', glossary: [] }
  const settings = { model: 'm', genre: 'g', tropes: [], tone: 't', rating: 'r', language: 'English', pov: 'p', tense: 'past', words: 10, style: '' }
  const id = Number(run('insert into books (title, settings, bible, status, created_at, updated_at) values (?, ?, ?, ?, 0, 0)', 'T', JSON.stringify(settings), JSON.stringify(bible), 'paused').lastInsertRowid)
  run('insert into arcs (book_id, idx, title, goal, plan, chapter_count, expanded) values (?, 0, ?, ?, ?, 2, 1)', id, 'A', 'G', 'P')
  run('insert into chapters (book_id, arc_idx, idx, title, pov, cast_names, status, text, words, summary, detail, scene_end) values (?, 0, 1, ?, ?, ?, ?, ?, 10, ?, ?, ?)',
    id, 'C1', 'Kira', '["Kira"]', 'done', 'Kira found the brass key. Kirandel slept on.', 'Kira finds a key', 'd', 'e')
  run('insert into chapters (book_id, arc_idx, idx, title, pov, cast_names, beats) values (?, 0, 2, ?, ?, ?, ?)', id, 'C2', 'Kira', '["Kira"]', '["Kira loses the key"]')
  run('insert into entities (book_id, kind, name, sheet, state) values (?, ?, ?, ?, ?)', id, 'character', 'Kira', 'Role: lead', 'Holds the brass key')
  const fact = Number(run('insert into facts (book_id, chapter, text, tags) values (?, 1, ?, ?)', id, 'The key Kira found is brass.', 'Kira').lastInsertRowid)
  run('insert into requests (book_id, chapter, quote, text) values (?, 1, ?, ?)', id, 'the brass key', 'Make the key silver, and call her Mira.')

  const calls: string[] = []
  const reply = (o: object) =>
    new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: JSON.stringify(o) })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`)
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const kind: string = JSON.parse(init.body as string).text.format.name
    calls.push(kind)
    if (kind === 'direction')
      return reply({
        reply: 'The key is silver now and Kira is Mira.',
        renames: [{ from: 'Kira', to: 'Mira' }],
        traces: [],
        about: [],
        directions: ['Less romance'],
        bible: [{ field: 'rules', value: '- Keys are silver' }],
        entities: [{ kind: 'character', name: 'Mira', sheet: '', state: 'Holds the silver key' }],
        arcs: [{ arc: 1, title: 'A', goal: 'G2', plan: 'P2', chapters: 0 }], // 0: a model unsure of the number; the arc keeps its length
        arcs_cut: [],
        chapters: [{ chapter: 2, title: 'C2', pov: 'Mira', cast: ['Mira'], beats: ['Mira keeps the key'], hook: 'h' }],
        fixes: [{ chapter: 1, change: 'The key is silver.' }, { chapter: 2, change: 'not written yet, must be ignored' }],
        facts_dropped: [fact],
        threads_closed: [],
      })
    if (kind === 'chapter_edits') return reply({ edits: [{ find: 'brass key', replace: 'silver key' }] })
    return reply({ summary: 'Mira finds a silver key', detail: 'd2', scene_end: 'e2', facts: [{ text: 'The key is silver.', tags: ['Mira'] }], entity_updates: [], new_entities: [], threads_opened: [], threads_resolved: [], continuity_issues: [] })
  }) as typeof fetch

  nudge(id)
  for (let i = 0; i < 200 && get('select summary from chapters where book_id = ? and idx = 1', id)!.summary !== 'Mira finds a silver key'; i++) await sleep(25)
  await sleep(25)

  assert.deepEqual(calls, ['direction', 'chapter_edits', 'chapter_memory'])
  const book = get('select status, bible, settings from books where id = ?', id)!
  assert.equal(book.status, 'paused') // the request was carried out without resuming the writing
  assert.deepEqual(JSON.parse(book.bible).rules, ['Keys are silver'])
  assert.deepEqual(JSON.parse(book.settings).directions, ['Less romance'])
  // The rename is whole-word and reaches the written text; the edit changes one passage and nothing else.
  assert.equal(get('select text from chapters where book_id = ? and idx = 1', id)!.text, 'Mira found the silver key. Kirandel slept on.')
  assert.deepEqual({ ...get('select status, pov, beats from chapters where book_id = ? and idx = 2', id)! }, { status: 'planned', pov: 'Mira', beats: '["Mira keeps the key"]' })
  assert.deepEqual({ ...get('select name, state from entities where book_id = ?', id)! }, { name: 'Mira', state: 'Holds the silver key' })
  assert.deepEqual(all('select text from facts where book_id = ?', id).map(f => f.text), ['The key is silver.'])
  assert.deepEqual(all('select chapter, status from issues where book_id = ?', id).map(i => `${i.chapter}:${i.status}`), ['1:fixed'])
  assert.equal(get('select reply from requests where book_id = ?', id)!.reply, 'The key is silver now and Kira is Mira.')
  assert.equal(get('select goal from arcs where book_id = ?', id)!.goal, 'G2')
  // The request records what it really did; the fix of the unwritten chapter 2 is not among it.
  assert.deepEqual(JSON.parse(get('select effects from requests where book_id = ?', id)!.effects),
    ['Renamed Kira to Mira', 'Characters and elements: Mira', 'Re-planned the arc "A"', 'Re-planned chapter 2', 'Dropped 1 canon fact', 'Story bible: rules', 'Standing directions updated'])
  // What the chapter read before the request is kept, so both the rename and the edit can be shown in it.
  const { changes } = await import('./diff.ts')
  const ch = get('select before, text, proofed, repaired from chapters where book_id = ? and idx = 1', id)!
  assert.deepEqual(changes(ch.before, ch.text), [{ kind: 'mod', parts: [['-', 'Kira'], ['+', 'Mira'], ['=', ' found the '], ['-', 'brass'], ['+', 'silver'], ['=', ' key. Kirandel slept on.']] }])
  assert.deepEqual([ch.proofed, ch.repaired], [0, 0]) // an edit the author asked for is not a proofreader repair: the chapter is still due its audit and re-check
})

test('an edit is shown as what went and what came, inside the paragraph it touched', async () => {
  const { changes } = await import('./diff.ts')
  const before = 'She took the brass key.\n\nThe canal was quiet.\n\nGone by dawn.'
  const after = 'She took the iron ring.\n\nThe canal was quiet.\n\nA new line.\n\nAnother.'
  assert.deepEqual(changes(before, after), [
    { kind: 'mod', parts: [['=', 'She took the '], ['-', 'brass key'], ['+', 'iron ring'], ['=', '.']] }, // one edit, not two words chopped apart
    { kind: 'same', text: 'The canal was quiet.' },
    { kind: 'del', text: 'Gone by dawn.' }, // too little in common with what replaced it to read as a rewrite
    { kind: 'add', text: 'A new line.' },
    { kind: 'add', text: 'Another.' },
  ])
  assert.deepEqual(changes('彼は鍵を見つけた。', '彼は指輪を見つけた。').map(p => p.kind), ['mod']) // no spaces to split on: still word by word
  assert.deepEqual(changes(before, before), before.split('\n\n').map(text => ({ kind: 'same', text })))
})

// A book mid-run for the tests below: one planned arc, chapter 1 written and digested, the rest still to write.
function midBook(status: string, planned: number) {
  kvSet('session', { clientId: 'c', subject: 's', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 })
  const bible = { title: 'T', logline: 'L', synopsis: 'S', themes: [], world: 'W', rules: [], power_system: 'none', glossary: [] }
  const settings = { model: 'm', genre: 'g', tropes: [], tone: 't', rating: 'r', language: 'English', pov: 'p', tense: 'past', chapters: 1 + planned, words: 10, style: '' }
  const id = Number(run('insert into books (title, settings, bible, status, created_at, updated_at) values (?, ?, ?, ?, 0, 0)', 'T', JSON.stringify(settings), JSON.stringify(bible), status).lastInsertRowid)
  run('insert into arcs (book_id, idx, title, goal, plan, chapter_count, expanded) values (?, 0, ?, ?, ?, ?, 1)', id, 'A', 'G', 'P', 1 + planned)
  run('insert into chapters (book_id, arc_idx, idx, title, status, text, words, summary, detail, scene_end) values (?, 0, 1, ?, ?, ?, 10, ?, ?, ?)', id, 'C1', 'done', 'The gate was shut.\n\nShe climbed it anyway.', 'old summary', 'd', 'e')
  for (let i = 2; i <= 1 + planned; i++) run('insert into chapters (book_id, arc_idx, idx, title, beats) values (?, 0, ?, ?, ?)', id, i, `C${i}`, '["old beat"]')
  return id
}
const sse = (text: string) =>
  new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`)
const MEMORY = { summary: 'new summary', detail: 'd2', scene_end: 'e2', facts: [], entity_updates: [], new_entities: [], threads_opened: [], threads_resolved: [], continuity_issues: [] }
const NOTHING = { reply: 'ok', renames: [], traces: [], about: [], directions: [], bible: [], entities: [], arcs: [], arcs_cut: [], chapters: [], fixes: [], facts_dropped: [], threads_closed: [] }

test('a request stops the chapter being written, and an arc given a new length is planned again from what is written', async () => {
  const id = midBook('running', 1)
  const calls: string[] = []
  const inputs: string[] = []
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    const kind: string = body.text?.format?.name ?? 'draft'
    calls.push(kind)
    inputs.push(body.input[0].content)
    // The first draft never finishes on its own: only the interruption ends it.
    if (calls.length === 1) return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))
    if (kind === 'draft') return sse(`draft ${calls.length}: one two three four five six seven eight nine ten`) // each its own: a chapter that repeats the last one gets repaired
    if (kind === 'direction') return sse(JSON.stringify({ ...NOTHING, arcs: [{ arc: 1, title: 'A', goal: 'G', plan: 'longer plan', chapters: 3 }] }))
    if (kind === 'arc_chapters')
      return sse(JSON.stringify({ chapters: ['N2', 'N3'].map(title => ({ title, pov: '', cast: [], beats: ['new beat'], hook: 'h' })), new_entities: [] }))
    if (kind === 'chapter_memory') return sse(JSON.stringify(MEMORY))
    if (kind === 'arc_synopsis') return sse(JSON.stringify({ synopsis: 'what happened', threads_resolved: [] }))
    if (kind === 'proofread') return sse(JSON.stringify({ issues: [], threads_resolved: [] }))
    return sse(JSON.stringify({ threads: [], ending: { complete: true, fix: '' } }))
  }) as typeof fetch

  start(id)
  for (let i = 0; i < 200 && !calls.length; i++) await sleep(5)
  run('insert into requests (book_id, text) values (?, ?)', id, 'Make this arc three chapters.')
  nudge(id)
  for (let i = 0; i < 400 && get('select status from books where id = ?', id)!.status === 'running'; i++) await sleep(25)

  assert.deepEqual([get('select status, error from books where id = ?', id)!.status, get('select status, error from books where id = ?', id)!.error], ['complete', null])
  // The draft in flight was dropped for the request; the arc's one unwritten chapter became two, planned from chapter 1 on.
  assert.deepEqual(calls.slice(0, 4), ['draft', 'direction', 'arc_chapters', 'draft'])
  assert.ok(inputs[2].includes('partly written') && inputs[2].includes('exactly 2') && inputs[2].includes('old summary'), 'the planner is told what is written and how much is left')
  assert.deepEqual(all('select idx, title, status from chapters where book_id = ? order by idx', id).map(c => `${c.idx}:${c.title}:${c.status}`), ['1:C1:done', '2:N2:done', '3:N3:done'])
  assert.equal(get('select chapter_count from arcs where book_id = ?', id)!.chapter_count, 3)
  assert.equal(JSON.parse(get('select settings from books where id = ?', id)!.settings).chapters, 3)
})

test('a chapter edited by hand is final, the director is told what changed, and undo puts the book back', async () => {
  const id = midBook('paused', 1)
  run('insert into facts (book_id, chapter, text, tags) values (?, 1, ?, ?)', id, 'The gate was shut.', 'gate')
  const calls: string[] = []
  let asked = ''
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    const kind: string = body.text.format.name
    calls.push(kind)
    if (kind === 'chapter_memory') return sse(JSON.stringify({ ...MEMORY, facts: [{ text: 'The gate stood open.', tags: ['gate'] }] }))
    asked = body.input[0].content
    // The director may not touch the hand-edited chapter; its plan change for chapter 2 lands.
    return sse(JSON.stringify({ ...NOTHING, fixes: [{ chapter: 1, change: 'must be ignored' }], chapters: [{ chapter: 2, title: 'C2', pov: '', cast: [], beats: ['she walks through'], hook: 'h' }] }))
  }) as typeof fetch

  assert.equal(rewrite(id, 2, 'x'), false) // not written yet: nothing to edit
  assert.equal(rewrite(id, 1, 'The gate stood open.\n\nShe climbed it anyway.'), true)
  const req = get('select id from requests where book_id = ?', id)!.id
  for (let i = 0; i < 200 && !get('select reply from requests where id = ?', req)!.reply; i++) await sleep(25)
  await sleep(25)

  assert.deepEqual(calls, ['chapter_memory', 'direction']) // the recap is read again first, then the director reconciles the rest
  assert.ok(asked.includes('by hand') && asked.includes('The gate was shut.') && asked.includes('The gate stood open.'), 'the director sees what was removed and what was added')
  assert.deepEqual({ ...get('select text, summary, stale from chapters where book_id = ? and idx = 1', id)! }, { text: 'The gate stood open.\n\nShe climbed it anyway.', summary: 'new summary', stale: 0 })
  assert.equal(get('select count(*) n from issues where book_id = ?', id)!.n, 0)
  assert.equal(get('select beats from chapters where book_id = ? and idx = 2', id)!.beats, '["she walks through"]')
  assert.equal(get('select status from books where id = ?', id)!.status, 'paused')

  // Undo: text, recap, facts, and plan are all as they were, and the change is marked undone.
  assert.equal(undo(id, req), true)
  assert.deepEqual({ ...get('select text, summary from chapters where book_id = ? and idx = 1', id)! }, { text: 'The gate was shut.\n\nShe climbed it anyway.', summary: 'old summary' })
  assert.equal(get('select beats from chapters where book_id = ? and idx = 2', id)!.beats, '["old beat"]')
  assert.deepEqual(all('select text from facts where book_id = ?', id).map(f => f.text), ['The gate was shut.'])
  assert.deepEqual({ ...get('select undone, undo from requests where id = ?', req)! }, { undone: 1, undo: null })
  assert.equal(undo(id, req), false) // once
})

// A finished, proofread book: one arc, two chapters.
function doneBook() {
  kvSet('session', { clientId: 'c', subject: 's', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 })
  const bible = { title: 'T', logline: 'L', synopsis: 'S', themes: [], world: 'W', rules: [], power_system: 'none', glossary: [] }
  const settings = { model: 'm', genre: 'g', tropes: [], tone: 't', rating: 'r', language: 'English', pov: 'p', tense: 'past', chapters: 2, words: 10, style: '' }
  const id = Number(run('insert into books (title, settings, bible, status, proofed, created_at, updated_at) values (?, ?, ?, ?, 1, 0, 0)', 'T', JSON.stringify(settings), JSON.stringify(bible), 'complete').lastInsertRowid)
  run('insert into arcs (book_id, idx, title, goal, plan, chapter_count, expanded, synopsis) values (?, 0, ?, ?, ?, 2, 1, ?)', id, 'A', 'G', 'P', 'old synopsis')
  for (const idx of [1, 2])
    run('insert into chapters (book_id, arc_idx, idx, title, status, text, words, summary, detail, scene_end, proofed) values (?, 0, ?, ?, ?, ?, 10, ?, ?, ?, 1)', id, idx, `C${idx}`, 'done', 'one two three four five six seven eight nine ten', 's', 'd', 'e')
  return id
}
// The fake model's answer to everything a finished book can be asked after a change.
const model = (calls: string[], direction: object) =>
  (async (_url: unknown, init: RequestInit) => {
    const kind: string = JSON.parse(init.body as string).text?.format?.name ?? 'draft'
    calls.push(kind)
    if (kind === 'draft') return sse(`draft ${calls.length}: one two three four five six seven eight nine ten`) // each its own: a chapter that repeats the last one gets repaired
    if (kind === 'direction') return sse(JSON.stringify({ ...NOTHING, ...direction }))
    if (kind === 'chapter_edits') return sse(JSON.stringify({ edits: [{ find: 'one two', replace: 'ONE two' }] }))
    if (kind === 'arc_chapters') return sse(JSON.stringify({ chapters: [{ title: 'C3', pov: '', cast: [], beats: ['b'], hook: 'h' }], new_entities: [] }))
    if (kind === 'chapter_memory') return sse(JSON.stringify(MEMORY))
    if (kind === 'arc_synopsis') return sse(JSON.stringify({ synopsis: 'new synopsis', threads_resolved: [] }))
    if (kind === 'proofread') return sse(JSON.stringify({ issues: [], threads_resolved: [] }))
    return sse(JSON.stringify({ threads: [], ending: { complete: true, fix: '' } }))
  }) as typeof fetch
const settle = async (id: number) => {
  for (let i = 0; i < 400 && get('select status from books where id = ?', id)!.status === 'running'; i++) await sleep(25)
  return { ...get('select status, error, proofed from books where id = ?', id)! }
}

test('an edit to a finished book refreshes its memory and arc synopsis, and the proofreader checks the chapter again', async () => {
  const id = doneBook()
  const calls: string[] = []
  globalThis.fetch = model(calls, { fixes: [{ chapter: 1, change: 'shout the first word' }] })
  run('insert into requests (book_id, chapter, text) values (?, 1, ?)', id, 'Shout the first word.')
  nudge(id)
  assert.deepEqual(await settle(id), { status: 'complete', error: null, proofed: 1 })
  assert.deepEqual(calls, ['direction', 'chapter_edits', 'chapter_memory', 'arc_synopsis', 'proofread', 'loose_ends']) // the ending is judged again after the author's change
  assert.deepEqual({ ...get('select text, summary, proofed, repaired, stale from chapters where book_id = ? and idx = 1', id)! },
    { text: 'ONE two three four five six seven eight nine ten', summary: 'new summary', proofed: 1, repaired: 0, stale: 0 })
  assert.equal(get('select synopsis from arcs where book_id = ?', id)!.synopsis, 'new synopsis')
})

test('a proofread book can be proofread again at any time, from scratch; one still being written cannot', async () => {
  const id = doneBook()
  run("update chapters set repaired = 3 where book_id = ?", id)
  run('insert into issues (book_id, chapter, issue, fix, status) values (?, 1, ?, ?, ?)', id, 'found last time', '', 'fixed')
  const calls: string[] = []
  globalThis.fetch = model(calls, {})
  assert.equal(reproof(id), true)
  assert.deepEqual(await settle(id), { status: 'complete', error: null, proofed: 1 })
  assert.deepEqual(calls, ['proofread', 'loose_ends']) // every chapter in one window, then the ending
  assert.deepEqual(all('select proofed, repaired from chapters where book_id = ?', id).map(c => `${c.proofed}:${c.repaired}`), ['1:0', '1:0'])
  assert.equal(get('select count(*) n from issues where book_id = ?', id)!.n, 0) // the last pass's report gave way to this one's

  // With its own model chosen, the proofreader checks and repairs with it; the rest of the book keeps the writing model.
  const models: string[] = []
  run("update books set settings = json_set(settings, '$.proofModel', 'proof-m', '$.proofReasoning', 'high') where id = ?", id)
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    models.push(`${body.text?.format?.name}:${body.model}:${body.reasoning?.effort ?? ''}`)
    if (body.text?.format?.name === 'proofread') return sse(JSON.stringify({ issues: [{ chapter: 2, severity: 'low', issue: 'nit', fix: 'f' }], threads_resolved: [] }))
    return model([], {})(url as any, init)
  }) as typeof fetch
  assert.equal(reproof(id), true)
  await settle(id)
  assert.deepEqual(models.slice(0, 3), ['proofread:proof-m:high', 'chapter_edits:proof-m:high', 'chapter_memory:m:low'])

  const writing = midBook('paused', 1)
  assert.equal(reproof(writing), false)
  assert.equal(get('select status from books where id = ?', writing)!.status, 'paused')
})

test('proofreading reads and repairs side by side, and lands everything as if one by one', async () => {
  kvSet('session', { clientId: 'c', subject: 's', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 })
  const bible = { title: 'T', logline: 'L', synopsis: 'S', themes: [], world: 'W', rules: [], power_system: 'none', glossary: [] }
  const settings = { model: 'm', genre: 'g', tropes: [], tone: 't', rating: 'r', language: 'English', pov: 'p', tense: 'past', chapters: 9, words: 10, style: '' }
  const id = Number(run('insert into books (title, settings, bible, status, created_at, updated_at) values (?, ?, ?, ?, 0, 0)', 'T', JSON.stringify(settings), JSON.stringify(bible), 'complete').lastInsertRowid)
  run('insert into arcs (book_id, idx, title, goal, plan, chapter_count, expanded, synopsis) values (?, 0, ?, ?, ?, 9, 1, ?)', id, 'A', 'G', 'P', 'what happened')
  // Each chapter fills a window of its own.
  for (let i = 1; i <= 9; i++)
    run('insert into chapters (book_id, arc_idx, idx, title, status, text, words, summary, detail, scene_end) values (?, 0, ?, ?, ?, ?, 30001, ?, ?, ?)', id, i, `C${i}`, 'done', `Opening of chapter ${i}.\n\n${`w${i} `.repeat(30000).trim()}`, 's', 'd', 'e')

  // The first reading of chapter 1 finds a conflict with chapter 6, flagged on both sides (the link only in the words),
  // and a loose end in chapter 9. The first reading of chapter 2, made beside it, finds something too.
  const audited: number[] = []
  const flight: Record<string, number> = {}
  const most: Record<string, number> = {}
  const edited: number[] = []
  let recheck = ''
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    const kind: string = body.text?.format?.name ?? 'rewrite'
    const input: string = body.input[0].content
    flight[kind] = (flight[kind] ?? 0) + 1
    most[kind] = Math.max(most[kind] ?? 0, flight[kind])
    await sleep(30)
    flight[kind]--
    if (kind === 'proofread') {
      const ch = Number(/=== Chapter (\d+):/.exec(input)![1])
      const first = !audited.includes(ch)
      audited.push(ch)
      const issues = !first ? []
        : ch === 1 ? [
            { chapter: 1, other: 0, severity: 'high', issue: 'The key is brass here, silver in chapter 6.', fix: 'Make it silver.' },
            { chapter: 6, other: 0, severity: 'high', issue: 'The key is silver here, brass in chapter 1.', fix: 'Make it brass.' },
            { chapter: 9, other: 0, severity: 'high', issue: 'Set up but never paid off.', fix: 'Pay it off.' },
          ]
        : ch === 2 ? [{ chapter: 2, other: 0, severity: 'high', issue: 'Read before chapter 1 was repaired.', fix: 'f' }]
        : []
      return sse(JSON.stringify({ issues, threads_resolved: [] }))
    }
    if (kind === 'chapter_edits') {
      const n = Number(/Opening of chapter (\d+)\./.exec(input)![1])
      edited.push(n)
      if (n === 6) recheck = input
      return sse(JSON.stringify({ edits: [{ find: `Opening of chapter ${n}.`, replace: `Opening of chapter ${n}, repaired.` }] }))
    }
    return model([], {})(url as any, init)
  }) as typeof fetch

  start(id)
  for (let i = 0; i < 400 && get('select status from books where id = ?', id)!.status === 'running'; i++) await sleep(25)
  assert.deepEqual({ ...get('select status, error, proofed from books where id = ?', id)! }, { status: 'complete', error: null, proofed: 1 })

  // Three windows read at once; chapter 2's reading, made before chapter 1's repair, is set aside and made again after it.
  assert.deepEqual(audited.slice(0, 3).sort(), [1, 2, 3])
  assert.equal(most.proofread, 3)
  assert.ok(!edited.includes(2), 'nothing is repaired from a reading made before an earlier repair')
  assert.equal(audited.filter(c => c === 2).length, 2)
  assert.equal(get('select count(*) n from issues where book_id = ? and chapter = 2', id)!.n, 0)
  // Chapters 1 and 9 are far apart and untied: repaired, and read again, side by side. Chapter 6, which the conflict
  // ties to chapter 1, is repaired after it, and told to check the conflict against chapter 1 as it now stands.
  assert.equal(most.chapter_edits, 2)
  assert.equal(most.chapter_memory, 2)
  assert.deepEqual(edited.slice(0, 2).sort(), [1, 9])
  assert.equal(edited[2], 6)
  assert.match(recheck, /no longer holds/)
})

test('a reading that fails stops its siblings and is read again alone; one that cannot be built sends nothing', async () => {
  kvSet('session', { clientId: 'c', subject: 's', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 })
  const book = () => {
    const bible = { title: 'T', logline: 'L', synopsis: 'S', themes: [], world: 'W', rules: [], power_system: 'none', glossary: [] }
    const settings = { model: 'm', genre: 'g', tropes: [], tone: 't', rating: 'r', language: 'English', pov: 'p', tense: 'past', chapters: 3, words: 10, style: '' }
    const id = Number(run('insert into books (title, settings, bible, status, created_at, updated_at) values (?, ?, ?, ?, 0, 0)', 'T', JSON.stringify(settings), JSON.stringify(bible), 'complete').lastInsertRowid)
    run('insert into arcs (book_id, idx, title, goal, plan, chapter_count, expanded, synopsis) values (?, 0, ?, ?, ?, 3, 1, ?)', id, 'A', 'G', 'P', 'what happened')
    for (let i = 1; i <= 3; i++)
      run('insert into chapters (book_id, arc_idx, idx, title, status, text, words, summary, detail, scene_end) values (?, 0, ?, ?, ?, ?, 30001, ?, ?, ?)', id, i, `C${i}`, 'done', `Opening of chapter ${i}.\n\n${`w${i} `.repeat(30000).trim()}`, 's', 'd', 'e')
    return id
  }
  // Chapter 2's first reading fails after the others are back: only it is read again.
  const read: number[] = []
  let failedOnce = false
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    if (body.text?.format?.name !== 'proofread') return model([], {})(url as any, init)
    const ch = Number(/=== Chapter (\d+):/.exec(body.input[0].content)![1])
    read.push(ch)
    if (ch === 2 && !failedOnce) return (await sleep(30), (failedOnce = true), new Response('{"error":{"message":"busy"}}', { status: 503 }))
    return sse(JSON.stringify({ issues: [], threads_resolved: [] }))
  }) as typeof fetch
  let id = book()
  start(id)
  for (let i = 0; i < 400 && get('select status from books where id = ?', id)!.status === 'running'; i++) await sleep(25)
  assert.deepEqual({ ...get('select status, error, proofed from books where id = ?', id)! }, { status: 'complete', error: null, proofed: 1 })
  assert.deepEqual(read.slice(0, 3).sort(), [1, 2, 3])
  assert.deepEqual(read.slice(3), [2]) // the readings that came back are kept

  // A window whose request cannot be built (its plan is unreadable): nothing is sent, and the book stops with an error.
  read.length = 0
  id = book()
  run("update chapters set cast_names = '{bad' where book_id = ? and idx = 2", id)
  start(id)
  for (let i = 0; i < 200 && get('select status from books where id = ?', id)!.status === 'running'; i++) await sleep(25)
  assert.equal(get('select status from books where id = ?', id)!.status, 'error')
  assert.deepEqual(read, [])
})

test('a finished book given another arc writes it, proofreads it, and judges the ending again', async () => {
  const id = doneBook()
  const calls: string[] = []
  globalThis.fetch = model(calls, { arcs: [{ arc: 2, title: 'After', goal: 'G', plan: 'P', chapters: 1 }] })
  run('insert into requests (book_id, text) values (?, ?)', id, 'Carry the story on for one more chapter.')
  nudge(id)
  assert.deepEqual(await settle(id), { status: 'complete', error: null, proofed: 1 })
  assert.deepEqual(calls, ['direction', 'arc_chapters', 'draft', 'chapter_memory', 'arc_synopsis', 'proofread', 'loose_ends'])
  assert.deepEqual(all('select idx, arc_idx, status, proofed from chapters where book_id = ? order by idx', id).map(c => `${c.idx}:${c.arc_idx}:${c.status}:${c.proofed}`), ['1:0:done:1', '2:0:done:1', '3:1:done:1'])
  assert.equal(JSON.parse(get('select settings from books where id = ?', id)!.settings).chapters, 3)
})

// --- Regressions from an audit of the state machine: each of these left a book stuck, out of step with its own text, or less than the author's. ---

test('an arc cut down to what is written while its re-plan was pending has nothing left to plan, and the book finishes', async () => {
  const { applyDirection } = await import('./engine.ts')
  const id = midBook('paused', 1)
  const ask = (chapters: number) => {
    const req = Number(run('insert into requests (book_id, text) values (?, ?)', id, 'length').lastInsertRowid)
    applyDirection(id, req, { ...NOTHING, arcs: [{ arc: 1, title: 'A', goal: 'G', plan: 'P', chapters }] })
    return { ...get('select expanded, chapter_count from arcs where book_id = ?', id)! }
  }
  assert.deepEqual(ask(4), { expanded: 0, chapter_count: 4 }) // longer: the unwritten chapter is dropped for a new plan
  assert.deepEqual(ask(1), { expanded: 1, chapter_count: 1 }) // then cut to the one written chapter: planned out, not "plan 0 chapters" forever
  const calls: string[] = []
  globalThis.fetch = model(calls, {})
  start(id)
  assert.deepEqual(await settle(id), { status: 'complete', error: null, proofed: 1 })
  assert.deepEqual(calls, ['arc_synopsis', 'proofread', 'loose_ends'])
})

test("the author's own text is not rewritten: not by the continuity pass, not from findings about the text it replaced", async () => {
  const id = midBook('paused', 0)
  run('update arcs set chapter_count = 3 where book_id = ?', id)
  // Chapters 2 and 3 are both drafted and undigested: 3 was written from 2 as it stood.
  for (const idx of [2, 3]) run('insert into chapters (book_id, arc_idx, idx, title, status, text, words) values (?, 0, ?, ?, ?, ?, 10)', id, idx, `C${idx}`, 'drafted', `draft of chapter ${idx} one two three four five six`)
  run('insert into issues (book_id, chapter, issue, fix, status) values (?, 2, ?, ?, ?)', id, 'A passage of the old text.', 'Rewrite it.', 'noted')
  const calls: string[] = []
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    const kind: string = body.text?.format?.name ?? 'draft'
    calls.push(kind)
    // The continuity editor objects to the author's chapter, and to no other.
    if (kind === 'chapter_memory') return sse(JSON.stringify({ ...MEMORY, continuity_issues: body.input[0].content.includes('"""\nMY OWN CHAPTER') ? [{ severity: 'high', issue: 'contradicts canon' }] : [] }))
    return model([], {})(_url as any, init)
  }) as typeof fetch

  const mine = 'MY OWN CHAPTER two, word for word as I want it.'
  assert.equal(rewrite(id, 2, mine), true)
  assert.equal(get('select count(*) n from issues where book_id = ?', id)!.n, 0) // the finding was about text that is gone
  assert.deepEqual({ ...get('select status, text from chapters where book_id = ? and idx = 3', id)! }, { status: 'planned', text: null }) // built on the old chapter 2: written again
  for (let i = 0; i < 200 && !get('select reply from requests where book_id = ?', id)!.reply; i++) await sleep(25)
  start(id)
  assert.deepEqual(await settle(id), { status: 'complete', error: null, proofed: 1 })
  assert.equal(get('select text from chapters where book_id = ? and idx = 2', id)!.text, mine)
  assert.ok(!calls.includes('chapter_edits'), 'no repair ran against the author’s text')
})

test('a chapter that replays the one before it is patched in place, and what the patch leaves is repaired before writing goes on', async () => {
  const replay = 'She climbed the gate the same way as before, hand over hand.'
  const fixed = 'She went round by the river path instead, and it took an hour.'
  const book = () => {
    const id = midBook('running', 1)
    run('update chapters set text = ? where book_id = ? and idx = 1', `The gate was shut.\n\n${replay}`, id)
    run('update chapters set status = ?, text = ?, words = 20 where book_id = ? and idx = 2', 'drafted', `Morning came, grey and slow, over the yard.\n\n${replay}`, id)
    return id
  }
  // The editor itself reports nothing: the repeat is found by comparing the text. Each patch call takes the next reply.
  const fake = (calls: string[], patches: object[][]) => (async (url: unknown, init: RequestInit) => {
    const kind: string = JSON.parse(init.body as string).text?.format?.name ?? 'draft'
    calls.push(kind)
    if (kind === 'chapter_edits') return sse(JSON.stringify({ edits: patches.shift() ?? [] }))
    return model([], {})(url as any, init)
  }) as typeof fetch
  const edit = [{ find: replay, replace: fixed }]

  // The continuity pass patches the repeat, then reads the chapter again.
  let calls: string[] = []
  let id = book()
  globalThis.fetch = fake(calls, [edit])
  start(id)
  assert.deepEqual(await settle(id), { status: 'complete', error: null, proofed: 1 })
  assert.deepEqual(calls, ['chapter_memory', 'chapter_edits', 'chapter_memory', 'arc_synopsis', 'proofread', 'loose_ends'])
  assert.deepEqual({ ...get('select text, revised from chapters where book_id = ? and idx = 2', id)! }, { text: `Morning came, grey and slow, over the yard.\n\n${fixed}`, revised: 1 })

  // A patch that makes it worse (the repeat now twice) is refused; the repeat stays on record and is repaired before
  // anything more is written.
  calls = []
  id = book()
  globalThis.fetch = fake(calls, [[{ find: 'Morning came, grey and slow, over the yard.', replace: replay }], edit])
  start(id)
  assert.deepEqual(await settle(id), { status: 'complete', error: null, proofed: 1 })
  assert.deepEqual(calls, ['chapter_memory', 'chapter_edits', 'chapter_edits', 'chapter_memory', 'arc_synopsis', 'proofread', 'loose_ends'])
  assert.equal(get('select status from issues where book_id = ? and chapter = 2', id)!.status, 'fixed')
  assert.equal(get('select text from chapters where book_id = ? and idx = 2', id)!.text, `Morning came, grey and slow, over the yard.\n\n${fixed}`)

  // Asked to fix it, the patch finds nothing to change (a line meant to be read twice): the chapter stands as written.
  calls = []
  id = book()
  globalThis.fetch = fake(calls, [[]])
  start(id)
  assert.deepEqual(await settle(id), { status: 'complete', error: null, proofed: 1 })
  assert.deepEqual(calls, ['chapter_memory', 'chapter_edits', 'arc_synopsis', 'proofread', 'loose_ends'])
  assert.equal(get('select count(*) n from issues where book_id = ?', id)!.n, 0)
})

test('in a long book the cast list gives way before the open threads and the story so far', async () => {
  const { arcContext, tokens } = await import('./context.ts')
  const id = doneBook()
  run('insert into arcs (book_id, idx, title, goal, plan, chapter_count, expanded, synopsis) values (?, 2, ?, ?, ?, 1, 1, ?)', id, 'C', 'G', 'P', 'SYNOPSIS OF THE LAST ARC') // idx 1 was cut: a gap
  for (let i = 0; i < 400; i++) run('insert into entities (book_id, kind, name, sheet, state, last_chapter) values (?, ?, ?, ?, ?, ?)', id, 'character', `Person ${i}`, 's', 'state '.repeat(60), i % 2)
  run('insert into threads (book_id, chapter, text) values (?, 1, ?)', id, 'Who took the key?')
  const past = get('select coalesce(max(idx), -1) + 1 n from arcs where book_id = ?', id)!.n
  const ctx = arcContext(id, past, 20_000)
  assert.ok(tokens(ctx) <= 20_100, `over budget: ${tokens(ctx)}`)
  for (const keep of ['Who took the key?', 'old synopsis', 'SYNOPSIS OF THE LAST ARC', 'Arc 1 (chapters 1-2)']) assert.ok(ctx.includes(keep), keep)
  assert.ok(!ctx.includes('CURRENT ARC'), 'past the last arc, nothing is "current": the whole book is story so far')
  assert.ok(ctx.includes('Person 0 ') || !ctx.includes('Person 399 '), 'the cast is trimmed from its least recently seen end')
})

test('a hand edit that removes what resolved a thread reopens it, and a finished book is summarized, audited, and judged again', async () => {
  const id = doneBook()
  const thread = Number(run('insert into threads (book_id, chapter, text, status, resolved_in) values (?, 1, ?, ?, 2)', id, 'Who took the key?', 'resolved').lastInsertRowid)
  const calls: string[] = []
  globalThis.fetch = model(calls, {})
  assert.equal(rewrite(id, 2, 'The thief got away and nobody saw who it was.'), true)
  assert.deepEqual(await settle(id), { status: 'complete', error: null, proofed: 1 })
  // The chapter's memory, then its arc's synopsis, and only then the director: it must not read a written arc as unfinished.
  assert.deepEqual(calls, ['chapter_memory', 'arc_synopsis', 'direction', 'proofread', 'loose_ends'])
  assert.deepEqual({ ...get('select status, resolved_in from threads where id = ?', thread)! }, { status: 'open', resolved_in: null })
})

test('a rename reaches every form of the name: used alone, in capitals, and a surname someone else keeps', async () => {
  const id = midBook('paused', 1)
  run('update chapters set text = ? where book_id = ? and idx = 1', 'Evan Brooks met Mira Shah at the pier. Evan smiled.\n\n[New Match: EVAN BROOKS]\n\n“Ms. Shah,” he said. Her mother, Leela Shah, waved.\n\nMira stood to leave.', id)
  run('update chapters set pov = ?, cast_names = ?, beats = ? where book_id = ? and idx = 2', 'Mira Shah', '["Mira Shah","Evan Brooks"]', '["Evan asks Shah to stay"]', id)
  for (const name of ['Evan Brooks', 'Mira Shah', 'Leela Shah']) run('insert into entities (book_id, kind, name, sheet) values (?, ?, ?, ?)', id, 'character', name, 'sheet')
  run('insert into facts (book_id, chapter, text, tags) values (?, 0, ?, ?)', id, 'Ms. Shah works nights at the pier.', 'Mira Shah')
  run('update books set bible = ? where id = ?', JSON.stringify({ ...JSON.parse(get('select bible from books where id = ?', id)!.bible), rules: ['Shah never lies to a patient.'] }), id)
  run('insert into requests (book_id, text) values (?, ?)', id, 'change evan brooks to kaizer brooks, and mira shah to rae derbridge')

  // The director does what it did in the report this test comes from: it lists only the full names.
  const calls: string[] = []
  let read = ''
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    const kind: string = body.text.format.name
    calls.push(kind)
    const input: string = body.input[0].content
    if (kind === 'direction') return sse(JSON.stringify({ ...NOTHING, reply: 'Renamed.', renames: [{ from: 'Evan Brooks', to: 'Kaizer Brooks' }, { from: 'Mira Shah', to: 'Rae Derbridge' }] }))
    // The model reading the records and the chapter: "Shah" becomes Derbridge where it is her, and stays her mother's.
    if (kind === 'records_sweep')
      return sse(JSON.stringify({ notes: [...input.matchAll(/^\[(\d+)\] (.*)$/gm)].filter(m => !m[2].includes('Leela')).map(m => ({ n: Number(m[1]), text: m[2].replace('Shah', 'Derbridge') })) }))
    read = input
    return sse(JSON.stringify({ chapters: [{ chapter: 1, edits: [{ find: '“Ms. Shah,” he said.', replace: '“Ms. Derbridge,” he said.' }] }] }))
  }) as typeof fetch

  nudge(id)
  for (let i = 0; i < 300 && get('select count(*) n from requests where book_id = ? and (reply is null or sweep is not null)', id)!.n; i++) await sleep(25)
  await sleep(50)

  // Three calls for the whole rename: the edit lands straight from the read, and a swapped name needs no new recap.
  assert.deepEqual(calls, ['direction', 'records_sweep', 'chapter_sweep'])
  // Only the passage that uses the word was read, with its neighbours: not the chapter.
  assert.ok(read.includes('“Ms. Shah,” he said.') && read.includes('[…]') && !read.includes('at the pier'), 'the model is shown the passage, not the chapter')
  assert.deepEqual(all('select chapter, status from issues where book_id = ?', id).map(i => `${i.chapter}:${i.status}`), ['1:fixed'])
  assert.equal(get('select text from chapters where book_id = ? and idx = 1', id)!.text,
    'Kaizer Brooks met Rae Derbridge at the pier. Kaizer smiled.\n\n[New Match: KAIZER BROOKS]\n\n“Ms. Derbridge,” he said. Her mother, Leela Shah, waved.\n\nRae stood to leave.')
  // What is planned and what is remembered feed every later chapter: an old name left there would come back.
  assert.deepEqual({ ...get('select pov, cast_names, beats from chapters where book_id = ? and idx = 2', id)! }, { pov: 'Rae Derbridge', cast_names: '["Rae Derbridge","Kaizer Brooks"]', beats: '["Kaizer asks Derbridge to stay"]' })
  assert.deepEqual({ ...get('select text, tags from facts where book_id = ? and chapter = 0', id)! }, { text: 'Ms. Derbridge works nights at the pier.', tags: 'Rae Derbridge' })
  assert.deepEqual(all('select name from entities where book_id = ? order by id', id).map(e => e.name), ['Kaizer Brooks', 'Rae Derbridge', 'Leela Shah'])
  assert.deepEqual(JSON.parse(get('select bible from books where id = ?', id)!.bible).rules, ['Derbridge never lies to a patient.']) // the bible is in every chapter's context
  assert.deepEqual(JSON.parse(get('select effects from requests where book_id = ?', id)!.effects), [
    'Renamed Evan Brooks to Kaizer Brooks', 'Renamed Mira Shah to Rae Derbridge', 'Renamed Evan to Kaizer', 'Renamed Mira to Rae',
    "Reading 1 chapter and the story's records for what the change left behind",
  ])
  assert.equal(get('select count(*) n from chapters where book_id = ? and sweep != 0', id)!.n, 0)
})

test('a name that is also an ordinary word is not replaced blind: the chapters using it are read instead', async () => {
  const { applyDirection } = await import('./engine.ts')
  const id = midBook('paused', 0)
  run('update chapters set text = ? where book_id = ? and idx = 1', 'Rose Hill smiled. She rose early. Rose left.', id)
  const req = Number(run('insert into requests (book_id, text) values (?, ?)', id, 'rename').lastInsertRowid)
  applyDirection(id, req, { ...NOTHING, renames: [{ from: 'Rose Hill', to: 'Lily Hill' }] })
  assert.equal(get('select text from chapters where book_id = ? and idx = 1', id)!.text, 'Lily Hill smiled. She rose early. Rose left.')
  assert.deepEqual(JSON.parse(get('select sweep from requests where id = ?', req)!.sweep).terms, [{ t: 'Rose', exact: true }])
  assert.equal(get('select sweep from chapters where book_id = ? and idx = 1', id)!.sweep, req)
})

test('a change about a character reaches chapters that never use the word: by another form of it, or by "she"', async () => {
  const id = midBook('paused', 0)
  run('update arcs set chapter_count = 5 where book_id = ?', id)
  const ch = (idx: number, cast: string, text: string, summary: string) =>
    run('insert into chapters (book_id, arc_idx, idx, title, cast_names, status, text, words, summary, detail, scene_end) values (?, 0, ?, ?, ?, ?, ?, 10, ?, ?, ?)', id, idx, `C${idx}`, cast, 'done', text, summary, 'd', 'e')
  ch(2, '["Tomas"]', 'Rain fell on the quay.\n\nTomas pocketed the brass keys and said nothing.\n\nThe ferry was late.\n\nHe waited anyway.', 'Tomas waits.')
  ch(3, '["Kira"]', 'She flexed her left arm and winced.', 'Kira tests her arm.') // never names her, never mentions a key
  ch(4, '["Tomas"]', 'Nothing here concerns any of it.', 'Tomas sleeps.')
  run('insert into chapters (book_id, arc_idx, idx, title) values (?, 0, 5, ?)', id, 'C5')
  for (const name of ['Kira', 'Tomas']) run('insert into entities (book_id, kind, name, sheet) values (?, ?, ?, ?)', id, 'character', name, 'sheet')
  run('insert into requests (book_id, text) values (?, ?)', id, 'Kira lost her left arm before the story starts, and the key is iron.')

  const calls: string[] = []
  let read = ''
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    const kind: string = body.text.format.name
    calls.push(kind)
    if (kind === 'direction') return sse(JSON.stringify({ ...NOTHING, reply: 'Done.', traces: ['brass key'], about: ['Kira'] }))
    if (kind === 'chapter_memory') return sse(JSON.stringify(MEMORY))
    read = body.input[0].content
    return sse(JSON.stringify({ chapters: [
      { chapter: 2, edits: [{ find: 'Tomas pocketed the brass keys and said nothing.', replace: 'Tomas pocketed the iron keys and said nothing.' }] },
      { chapter: 3, edits: [{ find: 'She flexed her left arm and winced.', replace: 'She rolled her one shoulder and winced.' }] },
    ] }))
  }) as typeof fetch

  nudge(id)
  for (let i = 0; i < 300 && get('select count(*) n from requests where book_id = ? and (reply is null or sweep is not null)', id)!.n; i++) await sleep(25)
  for (let i = 0; i < 100 && get('select count(*) n from chapters where book_id = ? and stale != 0', id)!.n; i++) await sleep(25)
  await sleep(50)

  // "brass key" found "brass keys": that chapter is shown as the passage and its neighbours.
  assert.ok(read.includes('=== Chapter 2: C2 (passages only') && read.includes('brass keys') && !read.includes('He waited anyway.'), 'chapter 2 as passages')
  // Kira's chapter has neither the word nor her name in its prose: it is found by its cast, and read whole.
  assert.ok(read.includes('=== Chapter 3: C3 ===') && read.includes('She flexed her left arm'), 'chapter 3 whole')
  assert.ok(!read.includes('Chapter 4') && !read.includes('The gate was shut'), 'chapters the change cannot reach are not read')
  assert.deepEqual(all('select idx, text from chapters where book_id = ? and idx in (2, 3) order by idx', id).map(c => c.text.split('\n\n').find((p: string) => /keys|shoulder/.test(p))),
    ['Tomas pocketed the iron keys and said nothing.', 'She rolled her one shoulder and winced.'])
  // Facts changed, so each edited chapter's memory is read again: one call for the chapters, then one each.
  assert.deepEqual(calls, ['direction', 'chapter_sweep', 'chapter_memory', 'chapter_memory'])
  assert.equal(get('select count(*) n from chapters where book_id = ? and (sweep != 0 or stale != 0)', id)!.n, 0)
})
