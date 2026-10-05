import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.KAIZER_DB = ':memory:'
const { fit, tokens, chapterContext, entityFinder } = await import('./context.ts')
const { run, get } = await import('./db.ts')

test('pipelined draft sees the full undigested previous chapter, not stale scene_end', () => {
  const bible = { title: 'T', logline: 'L', synopsis: 'S', themes: [], world: 'W', rules: [], power_system: 'none', glossary: [] }
  const id = Number(run('insert into books (title, settings, bible, created_at, updated_at) values (?, ?, ?, 0, 0)', 'T', '{}', JSON.stringify(bible)).lastInsertRowid)
  run('insert into arcs (book_id, idx, title, goal, plan, chapter_count, expanded) values (?, 0, ?, ?, ?, 3, 1)', id, 'A', 'G', 'P')
  const ch = (idx: number, status: string, text: string, scene_end: string | null) =>
    run('insert into chapters (book_id, arc_idx, idx, title, status, text, scene_end, summary, detail) values (?, 0, ?, ?, ?, ?, ?, ?, ?)', id, idx, `C${idx}`, status, text, scene_end, 's', 'd')
  ch(1, 'done', 'first chapter prose', 'OLD SCENE END')
  ch(2, 'drafted', 'opening line\n\nmiddle line\n\nclosing line', null)
  ch(3, 'planned', '', null)
  const out = chapterContext(id, get('select * from chapters where book_id = ? and idx = 3', id))
  for (const keep of ['opening line', 'closing line', 'full text']) assert.ok(out.includes(keep), keep)
  assert.ok(!out.includes('OLD SCENE END'), 'chapter 1 scene_end must not pose as the previous chapter ending')
})

test('fit trims by priority and never drops protected sections', () => {
  const big = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}${i} `.repeat(50))
  const sections = [
    { title: 'Bible', items: ['rules'] },
    { title: 'Cast', items: ['Lina sheet'] },
    { title: 'Older summaries', items: big('old', 20), drop: 1 },
    { title: 'Facts', items: big('fact', 20), drop: 4, fromEnd: true },
    { title: 'Tail', items: big('tail', 10), drop: 7 },
    { title: 'This chapter', items: ['beats'] },
  ]
  const out = fit(sections, 2000)
  assert.ok(tokens(out) <= 2000 + 50, `over budget: ${tokens(out)}`)
  for (const keep of ['rules', 'Lina sheet', 'beats']) assert.ok(out.includes(keep))
  assert.ok(!out.includes('old0 '), 'oldest summary should be trimmed first')
  assert.ok(out.includes('tail9 '), 'newest tail paragraph survives longest')
  assert.ok(out.includes('fact0 ') || !out.includes('fact19 '), 'facts trim from the low-rank end')
})

test('name variants resolve to one entity; off-cast state updates stack instead of overwriting', async () => {
  const { applyMemory } = await import('./engine.ts')
  const id = Number(run('insert into books (title, settings, bible, created_at, updated_at) values (?, ?, ?, 0, 0)', 'T', '{}', '{}').lastInsertRowid)
  const ent = (kind: string, name: string, state: string) => run('insert into entities (book_id, kind, name, sheet, state) values (?, ?, ?, ?, ?)', id, kind, name, 'sheet', state)
  ent('character', 'Andres "Pitik" Mallari', 'level 1')
  ent('character', 'Lorna Mallari', 'has the ledger')
  ent('item', 'Bong’s Contract', 'unsigned')
  ent('location', 'The Mallari Home', '')
  ent('location', 'Tondo Pool Academy', '')
  const find = entityFinder(id)
  assert.equal(find('Andres Mallari')?.name, 'Andres "Pitik" Mallari')
  assert.equal(find("Bong's Contract")?.name, 'Bong’s Contract')
  assert.equal(find('Mallari Home')?.name, 'The Mallari Home')
  assert.equal(find('Mallari'), undefined, 'ambiguous partial name')
  assert.equal(find('Tondo'), undefined, 'only characters match by partial name')

  run('insert into chapters (book_id, arc_idx, idx, title, pov, cast_names, status, text) values (?, 0, 5, ?, ?, ?, ?, ?)', id, 'C5', 'Andres Mallari', '[]', 'drafted', 'x')
  applyMemory(id, get('select * from chapters where book_id = ? and idx = 5', id), {
    summary: 's', detail: 'd', scene_end: 'e', facts: [], threads_opened: [], threads_resolved: [], continuity_issues: [],
    entity_updates: [{ name: 'Andres Mallari', state: 'level 2' }, { name: 'Lorna Mallari', state: 'at the market' }],
    new_entities: [{ kind: 'character', name: 'Lorna', sheet: 'dup', state: 'worried' }],
  })
  const state = (n: string) => get('select state from entities where book_id = ? and name = ?', id, n)!.state
  assert.equal(state('Andres "Pitik" Mallari'), 'level 2', 'cast entity: full replacement')
  assert.match(state('Lorna Mallari'), /worried[\s\S]*at the market[\s\S]*has the ledger/, 'off-cast entity keeps its old state')
  assert.equal(get('select count(*) n from entities where book_id = ?', id)!.n, 5, 'no duplicate Lorna')
})

test('a character the beats or the text bring on stage gets a card and a full state update, though the planner left them out', async () => {
  const { applyMemory } = await import('./engine.ts')
  const bible = { title: 'T', logline: 'L', synopsis: 'S', themes: [], world: 'W', rules: [], power_system: 'none', glossary: [] }
  const id = Number(run('insert into books (title, settings, bible, created_at, updated_at) values (?, ?, ?, 0, 0)', 'T', '{}', JSON.stringify(bible)).lastInsertRowid)
  run('insert into arcs (book_id, idx, title, goal, plan, chapter_count, expanded) values (?, 0, ?, ?, ?, 1, 1)', id, 'A', 'G', 'P')
  const ent = (kind: string, name: string, sheet: string) => run('insert into entities (book_id, kind, name, sheet, state) values (?, ?, ?, ?, ?)', id, kind, name, sheet, 'old state')
  for (const n of ['Teo Reyes', 'Elena Cruz', 'Ramon Cruz', 'Noli', 'Bing']) ent('character', n, `Role: ${n}'s role\nAppearance: tall`)
  ent('item', 'The Red Comet', 'a cue')
  // Elena is in a beat (by her own first name), Noli is in the text twice; Ramon only by the surname he shares, Bing once.
  run('insert into chapters (book_id, arc_idx, idx, title, pov, cast_names, beats, hook, status, text) values (?, 0, 1, ?, ?, ?, ?, ?, ?, ?)',
    id, 'C1', 'Teo Reyes', '[]', JSON.stringify(["Elena's cough worsens"]), 'h', 'drafted', 'Noli laughed. Cruz waited. Noli left. Bing.')
  const ch = get('select * from chapters where book_id = ? and idx = 1', id)
  const out = chapterContext(id, ch)
  for (const n of ['Teo Reyes', 'Elena Cruz', 'Noli']) assert.ok(out.includes(`### ${n} (character)`), n)
  for (const n of ['Ramon Cruz', 'Bing', 'Red Comet']) assert.ok(!out.includes(`### ${n}`) && !out.includes(`### The ${n}`), n)
  assert.ok(out.includes("Bing (Bing's role)"), 'the names not on stage come with their role')

  applyMemory(id, ch, {
    summary: 's', detail: 'd', scene_end: 'e', facts: [], threads_opened: [], threads_resolved: [], continuity_issues: [], new_entities: [],
    entity_updates: [{ name: 'Noli', state: 'at the hall', profile_correction: 'Noli is seventeen.' }, { name: 'Bing', state: 'asleep' }],
  })
  const row = (n: string) => get('select state, sheet from entities where book_id = ? and name = ?', id, n)!
  assert.equal(row('Noli').state, 'at the hall', 'she had a card: full replacement')
  assert.match(row('Noli').sheet, /\nCorrection \(ch 1\): Noli is seventeen\.$/)
  assert.match(row('Bing').state, /^\(ch 1\) asleep\nold state$/, 'no card: stacked')
})
