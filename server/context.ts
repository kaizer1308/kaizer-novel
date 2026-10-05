import { all, get } from './db.ts'

// A section's items are trimmed one at a time when over budget. Lower `drop` goes first;
// no `drop` = never trimmed. `fromEnd` trims the last item instead of the first.
export type Section = { title: string; items: string[]; drop?: number; fromEnd?: boolean }

export const CJK = /[぀-ヿ㐀-鿿가-힯]/
export const tokens = (s: string) => Math.ceil(s.length / (CJK.test(s) ? 1.2 : 4))

export function fit(sections: Section[], budget: number): string {
  const live = sections.filter(s => s.items.length)
  let total = live.reduce((n, s) => n + tokens(s.title) + s.items.reduce((m, i) => m + tokens(i) + 1, 0), 0)
  while (total > budget) {
    const s = live.filter(s => s.drop !== undefined && s.items.length).sort((a, b) => a.drop! - b.drop!)[0]
    if (!s) break
    total -= tokens((s.fromEnd ? s.items.pop() : s.items.shift())!) + 1
  }
  return live.filter(s => s.items.length).map(s => `## ${s.title}\n${s.items.join('\n')}`).join('\n\n')
}

type Bible = {
  title: string; logline: string; synopsis: string; themes: string[]; world: string; rules: string[]
  power_system: string; glossary: { term: string; meaning: string }[]
}

const bibleCore = (b: Bible, withEnding: boolean) => [
  `Title: ${b.title}`,
  `Logline: ${b.logline}`,
  ...(withEnding ? [`Book direction (author only, do not reveal early): ${b.synopsis}`] : []),
  `Themes: ${b.themes.join(', ')}`,
  `World: ${b.world}`,
  `Hard rules:\n${b.rules.map(r => `- ${r}`).join('\n')}`,
  ...(b.power_system && b.power_system.toLowerCase() !== 'none' ? [`Power system: ${b.power_system}`] : []),
  ...(b.glossary.length ? [`Glossary:\n${b.glossary.map(g => `- ${g.term}: ${g.meaning}`).join('\n')}`] : []),
]

const entityCard = (e: any) => `### ${e.name} (${e.kind})\n${e.sheet}\nCurrent state: ${e.state || 'unknown'}`

// Models drift on names: ’ for ', a dropped "The", a dropped nickname or title ("Arturo Villaroman" for
// "Boss Arturo Villaroman"). Exact match after normalizing, else the one character whose name has every word.
const nameKey = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/^the\s+/, '').trim()
const nameWords = (s: string) => nameKey(s).match(/[\p{L}\p{N}']+/gu) ?? []
export function entityFinder(bookId: number) {
  const ents = all('select * from entities where book_id = ?', bookId)
  const exact = new Map(ents.map(e => [nameKey(e.name), e]))
  const people = ents.filter(e => e.kind === 'character').map(e => ({ e, words: new Set(nameWords(e.name)) }))
  return (name: string) => {
    const hit = exact.get(nameKey(name))
    if (hit) return hit
    const words = nameWords(name)
    const near = words.length ? people.filter(p => words.every(w => p.words.has(w))) : []
    return near.length === 1 ? near[0]!.e : undefined
  }
}

// A name or phrase as it sits in running text: whole words only, so "Al" is not found in "Also" (scripts
// written without spaces have no word edges), and any run of spaces between its words. `caps`: also as it is
// shouted or set on a sign, in capitals. `loose`: in any letter case.
export function wordsRe(term: string, { caps = false, loose = false, all = false } = {}) {
  const pattern = (t: string) => t.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ \\t\\u00a0]+')
  const body = caps && term.toUpperCase() !== term ? `${pattern(term)}|${pattern(term.toUpperCase())}` : pattern(term)
  return new RegExp(CJK.test(term) ? body : `(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, `${all ? 'g' : ''}${loose ? 'i' : ''}u`)
}

// Who is in a chapter: its planned cast, plus every known name its beats or hook use, or its text uses twice.
// Planners under-list, and a character on the page without a card is written, and checked, from memory.
// A name is matched in full (less a leading "The"), or for a character by a capitalised word of it no other name has.
export function castOf(bookId: number, ch: any) {
  const find = entityFinder(bookId)
  const ents = all('select * from entities where book_id = ?', bookId)
  const out = new Map<number, any>()
  for (const n of [ch.pov, ...JSON.parse(ch.cast_names ?? '[]')].filter(Boolean)) {
    const e = find(n)
    if (e) out.set(e.id, e)
  }
  const fold = (s: string) => s.replace(/[‘’]/g, "'") // "Rae’s" in a name, "Rae's" in the text
  const plan = fold([ch.hook ?? '', ...JSON.parse(ch.beats ?? '[]')].join('\n'))
  const text = fold(ch.text ?? '')
  // Among characters only: "Noah’s Blue Notebook" must not cost Noah his first name.
  const tally = new Map<string, number>()
  for (const e of ents) if (e.kind === 'character') for (const w of new Set(nameWords(e.name))) tally.set(w, (tally.get(w) ?? 0) + 1)
  for (const e of ents) {
    if (out.has(e.id)) continue
    const own = e.kind !== 'character' ? [] : (fold(e.name).match(/[\p{L}\p{N}']+/gu) ?? [])
      .filter(w => w.length > 2 && /^\p{Lu}/u.test(w) && tally.get(w.toLowerCase()) === 1)
    const res = [fold(e.name).replace(/^the\s+/i, ''), ...own].filter(Boolean).map(f => wordsRe(f, { caps: true, all: true }))
    if (res.some(re => plan.match(re) || (text.match(re)?.length ?? 0) >= 2)) out.set(e.id, e)
  }
  return [...out.values()]
}

// The names that exist but are not on stage. A character's comes with their role, so that a new minor figure is
// not handed a name that is already someone's.
const roster = (bookId: number, present: any[]) =>
  all('select id, name, kind, sheet from entities where book_id = ? order by last_chapter desc', bookId)
    .filter(e => !present.some(p => p.id === e.id))
    .map(e => (e.kind === 'character' ? `${e.name} (${String(e.sheet).split('\n')[0].replace(/^Role:\s*/i, '').slice(0, 80)})` : `${e.name} (${e.kind})`))
    .join('; ')

const STOP = new Set('about after again against their there these those which while would could should where being before through under other another every'.split(' '))
// `skip`: chapters whose own facts say nothing new, e.g. the very chapters being audited.
function relevantFacts(bookId: number, names: string[], beats: string[], beforeChapter: number, limit = 100, skip: [number, number] = [0, -1]) {
  const words = new Set(names.map(t => t.trim()).filter(Boolean))
  for (const t of [...names, ...beats]) for (const w of t.split(/[^\p{L}\p{N}'-]+/u)) if (w.length >= 5 && !STOP.has(w.toLowerCase())) words.add(w)
  const q = [...words].slice(0, 60).map(w => `"${w.replace(/"/g, '""')}"`).join(' OR ')
  if (!q) return []
  return all<{ id: number; chapter: number; text: string }>(
    `select f.id, f.chapter, f.text from facts_fts join facts f on f.id = facts_fts.rowid
     where facts_fts match ? and f.book_id = ? and f.chapter < ? and f.chapter not between ? and ? order by bm25(facts_fts) limit ?`,
    q, bookId, beforeChapter, skip[0], skip[1], limit,
  )
}

// Newest first: threads get resolved within a few chapters or not at all, so old ones are the first to go.
export const threadItems = (bookId: number, limit = -1, through = 1e9) =>
  all('select * from threads where book_id = ? and status = ? and chapter <= ? order by chapter desc, id desc limit ?', bookId, 'open', through, limit)
    .map(t => `- #${t.id} (since ch ${t.chapter}): ${t.text}${t.payoff ? ` → payoff: ${t.payoff}` : ''}`)

// Everything the writer (and continuity editor) needs for chapter `ch`.
export function chapterContext(bookId: number, ch: any, budget = 40_000) {
  const book = get('select * from books where id = ?', bookId)!
  const bible: Bible = JSON.parse(book.bible)
  const cast: string[] = JSON.parse(ch.cast_names)
  const arc = get('select * from arcs where book_id = ? and idx = ?', bookId, ch.arc_idx)!
  const names = [...new Set([ch.pov, ...cast].filter(Boolean))]
  const present = castOf(bookId, ch)
  const done = all('select * from chapters where book_id = ? and status = ? and idx < ? order by idx', bookId, 'done', ch.idx)
  const recent = done.slice(-3)
  // This arc, and at least the last dozen chapters: an arc's first chapters must not stage again what the last arc showed.
  const older = done.slice(0, -3).filter(c => c.arc_idx === ch.arc_idx || c.idx > ch.idx - 13)
  const after = get('select title, pov, beats from chapters where book_id = ? and idx = ?', bookId, ch.idx + 1)
  const nth = ch.idx - get('select min(idx) n from chapters where book_id = ? and arc_idx = ?', bookId, ch.arc_idx)!.n + 1
  const prev = done.at(-1)?.idx === ch.idx - 1 ? done.at(-1) : undefined
  // Pipelined draft: the previous chapter is written but its memory pass hasn't landed, so send all of it.
  const pending = prev ? undefined : get('select text from chapters where book_id = ? and idx = ? and status = ?', bookId, ch.idx - 1, 'drafted')
  const tail = prev ? lastWords(prev.text, 1500) : pending ? lastWords(pending.text, Infinity) : []
  const beats: string[] = JSON.parse(ch.beats)
  const final = !get('select 1 from chapters where book_id = ? and idx > ?', bookId, ch.idx) && !get('select 1 from arcs where book_id = ? and idx > ?', bookId, ch.arc_idx)

  return fit([
    { title: 'Story bible', items: bibleCore(bible, false) },
    { title: 'Characters and elements in this chapter', items: present.map(entityCard) },
    { title: 'Other established names (each belongs to this one only: never give it to anyone new; not on stage unless the beats bring them in)', items: [roster(bookId, present)].filter(Boolean), drop: 3 },
    { title: 'Story so far: earlier arcs', items: all('select * from arcs where book_id = ? and idx < ? and synopsis is not null order by idx', bookId, ch.arc_idx).map(a => `Arc ${a.idx + 1}, ${a.title}: ${a.synopsis}`), drop: 2 },
    { title: 'Story so far: this arc and recent chapters', items: older.map(c => `Ch ${c.idx} "${c.title}": ${c.summary}`), drop: 1 },
    { title: 'Recent chapters in detail', items: recent.map(c => `Ch ${c.idx} "${c.title}":\n${c.detail}`), drop: 6 },
    { title: 'Relevant canon facts (a later chapter overrides an earlier one)', items: relevantFacts(bookId, [...names, ...present.map(e => e.name)], beats, ch.idx).map(f => `- (ch ${f.chapter}) ${f.text}`), drop: 4, fromEnd: true },
    { title: 'Open plot threads (newest first)', items: threadItems(bookId, 40), drop: 5, fromEnd: true },
    { title: 'Where the previous chapter ended', items: prev?.scene_end ? [prev.scene_end] : [] },
    {
      title: pending
        ? 'Previous chapter, full text (just written; where it differs from the states above, it wins. Continue seamlessly from its end)'
        : 'Previous chapter, final passage (continue seamlessly from here)',
      items: tail,
      drop: 7,
    },
    {
      title: 'Next chapter, planned (not this one: none of it happens here; stop at the hook so it can follow)',
      items: after ? [`Ch ${ch.idx + 1} "${after.title}" (POV: ${after.pov}):\n${JSON.parse(after.beats).map((b: string) => `- ${b}`).join('\n')}`] : [],
    },
    {
      title: `THIS CHAPTER: Chapter ${ch.idx}, "${ch.title}"`,
      items: [
        `Current arc: ${arc.title}, chapter ${nth} of ${arc.chapter_count}. Arc goal (for the whole arc: what this chapter's beats do not mention happens in a later chapter): ${arc.goal}`,
        `POV: ${ch.pov}`,
        `Beats:\n${beats.map(b => `- ${b}`).join('\n')}`,
        // The hook is the planner's note; pasted as it stands, it ends a past-tense chapter in outline voice.
        `${final ? 'This is the final chapter of the book. Conclude the story, leaving nothing important unresolved, and end' : 'End'} on this turn (an outline note, not prose: dramatize it in the POV character's voice and the book's tense, never copy its wording): ${ch.hook}`,
      ],
    },
  ], budget)
}

// What the architect needs to expand arc `arcIdx` into chapters.
export function arcContext(bookId: number, arcIdx: number, budget = 40_000) {
  const book = get('select * from books where id = ?', bookId)!
  const bible: Bible = JSON.parse(book.bible)
  const arcs = all('select * from arcs where book_id = ? order by idx', bookId)
  const last = get('select * from chapters where book_id = ? and status = ? order by idx desc limit 1', bookId, 'done')
  // Which chapters each arc covers: whoever must name a chapter (the ending's judge does) needs the map.
  const span = new Map(all('select arc_idx, min(idx) a, max(idx) b from chapters where book_id = ? group by arc_idx', bookId).map(r => [r.arc_idx, `chapters ${r.a}-${r.b}`]))
  // In a long book the cast list alone outgrows the budget, so it is what gives way first, least recently seen
  // first. The threads and the story so far are what planning and the ending's verdict rest on: they go last.
  return fit([
    { title: 'Story bible', items: bibleCore(bible, true) },
    // Outlined at the start. An arc planned from it as it stands re-stages what earlier arcs already told.
    { title: 'Arc plan for the rest of the book (outlined before the story was told: where it repeats or contradicts the story so far, the story wins)', items: arcs.filter(a => a.idx >= arcIdx).map(a => `Arc ${a.idx + 1}${a.idx === arcIdx ? ' (CURRENT ARC)' : ''}, ${a.title}: ${a.goal}\n${a.plan}`) },
    { title: 'Story so far', items: arcs.filter(a => a.idx < arcIdx && a.synopsis).map(a => `Arc ${a.idx + 1} (${span.get(a.idx) ?? 'no chapters'}), ${a.title}: ${a.synopsis}`), drop: 1 },
    // What each chapter already showed, for the planner not to stage again and the ending's judge to find payoffs in.
    // The synopses cover the same ground, so these are the first to give way, oldest first.
    { title: 'Chapter by chapter', items: all('select idx, title, summary from chapters where book_id = ? and arc_idx < ? and summary is not null order by idx', bookId, arcIdx).map(c => `Ch ${c.idx} "${c.title}": ${c.summary}`), drop: -1 },
    // Only an arc re-planned midway has any.
    { title: 'The current arc so far', items: all('select idx, title, summary from chapters where book_id = ? and arc_idx = ? and summary is not null order by idx', bookId, arcIdx).map(c => `Ch ${c.idx} "${c.title}": ${c.summary}`), drop: 3 },
    { title: 'Known characters and elements (most recently seen first)', items: all('select * from entities where book_id = ? order by last_chapter desc', bookId).map(e => `- ${e.name} (${e.kind}): ${String(e.state).slice(0, 400)}`), drop: 0, fromEnd: true },
    { title: 'Open plot threads (newest first; old ones may already be settled, check the story so far)', items: threadItems(bookId), drop: 2, fromEnd: true },
    { title: 'Where the story currently stands', items: last ? [`Chapter ${last.idx} "${last.title}": ${last.detail}`, `Scene at end: ${last.scene_end}`] : ['The story has not started yet.'] },
  ], budget)
}

// What the proofreader needs to audit or repair finished, consecutive chapters `chs` with the whole book in view.
export function proofContext(bookId: number, chs: any[], budget = 30_000) {
  const book = get('select * from books where id = ?', bookId)!
  const first = chs[0], last = chs.at(-1)
  const names = [...new Set(chs.flatMap(c => [c.pov, ...JSON.parse(c.cast_names)]).filter(Boolean))]
  const present = [...new Map(chs.flatMap(c => castOf(bookId, c)).map(e => [e.id, e])).values()]
  // Every other chapter, not just this arc's: a scene staged twice is as often an arc apart.
  const near = all('select * from chapters where book_id = ? and (idx < ? or idx > ?) order by idx', bookId, first.idx, last.idx)
  const prev = get('select scene_end from chapters where book_id = ? and idx = ?', bookId, first.idx - 1)
  const next = get('select idx, title, summary from chapters where book_id = ? and idx = ?', bookId, last.idx + 1)
  return fit([
    { title: 'Story bible', items: bibleCore(JSON.parse(book.bible), true) },
    // Profiles only: `state` is where an entity stands at the end of the book, not in these chapters.
    { title: 'Characters and elements in these chapters', items: present.map(e => `### ${e.name} (${e.kind})\n${e.sheet}`), drop: 4, fromEnd: true },
    { title: 'Other established names (they exist in the book; a mention of one is not an error)', items: [roster(bookId, present)].filter(Boolean), drop: 5 },
    { title: 'The whole book, arc by arc', items: all('select * from arcs where book_id = ? and synopsis is not null order by idx', bookId).map(a => `Arc ${a.idx + 1}, ${a.title}: ${a.synopsis}`) },
    { title: 'Other chapters', items: near.filter(c => c.summary).map(c => `Ch ${c.idx} "${c.title}": ${c.summary}`), drop: 2 },
    // Facts drawn from the very chapters under audit would only repeat them back.
    { title: 'Canon facts from the whole book (each dated by chapter; a later one overrides an earlier one)', items: relevantFacts(bookId, [...names, ...present.map(e => e.name)], chs.flatMap(c => JSON.parse(c.beats)), 1e9, 120, [first.idx, last.idx]).map(f => `- (ch ${f.chapter}) ${f.text}`), drop: 3, fromEnd: true },
    { title: 'Plot threads still open (newest first)', items: threadItems(bookId, -1, last.idx), drop: 1, fromEnd: true },
    { title: 'Where the chapter before these ended', items: prev?.scene_end ? [prev.scene_end] : [] },
    // An edit the author asks for mid-book lands here too, with later chapters still unwritten or unplanned.
    { title: 'What follows these chapters', items: [next ? `Ch ${next.idx} "${next.title}": ${next.summary ?? 'not written yet'}` : get('select 1 from arcs where book_id = ? and idx > ?', bookId, last.arc_idx) ? 'Later arcs, not planned yet.' : 'Nothing: these chapters end the book.'] },
  ], budget)
}

// What the director needs to carry out a request from the author: the plan it may rewrite, the canon the
// change must fit, and the written chapters it may send for edits.
export function directContext(bookId: number, req: any, budget = 40_000) {
  const book = get('select * from books where id = ?', bookId)!
  const arcs = all('select * from arcs where book_id = ? order by idx', bookId)
  const cur = arcs.find(a => !a.synopsis)
  const chapters = all('select * from chapters where book_id = ? order by idx', bookId)
  const marked = chapters.find(c => c.idx === req.chapter && c.status !== 'planned')
  const ask = `${req.text}\n${req.quote ?? ''}`.toLowerCase()
  const ents = all('select * from entities where book_id = ? order by last_chapter desc', bookId)
  const find = entityFinder(bookId)
  const cast = new Set(marked ? [marked.pov, ...JSON.parse(marked.cast_names)].map(find) : [])
  const near = ents.filter(e => ask.includes(e.name.toLowerCase()) || [...cast].some(c => c?.id === e.id))
  const facts = relevantFacts(bookId, near.map(e => e.name), [ask], 1e9, 60)
  // Earlier arcs are covered by their synopses; from them, only the chapters the request points at.
  const cited = new Set([req.chapter, ...facts.map(f => f.chapter)])
  const plan = (c: any) => `POV: ${c.pov}. Cast: ${JSON.parse(c.cast_names).join(', ')}.\nBeats:\n${JSON.parse(c.beats).map((b: string) => `- ${b}`).join('\n')}\nHook: ${c.hook}`
  return fit([
    { title: 'Story bible', items: bibleCore(JSON.parse(book.bible), true) },
    { title: 'Standing directions from the author', items: (JSON.parse(book.settings).directions ?? []).map((d: string) => `- ${d}`) },
    {
      title: 'Arcs (a finished arc shows what happened; an unfinished one shows its plan)',
      items: arcs.map(a => {
        const wrote = chapters.filter(c => c.arc_idx === a.idx && c.status !== 'planned').length
        return `Arc ${a.idx + 1}${a === cur ? ' (CURRENT)' : ''}, ${a.title} (${a.chapter_count} chapters${a.synopsis ? '' : `, ${wrote} written`}): ${a.synopsis ? `finished. ${a.synopsis}` : `${a.goal}\n${a.plan}`}`
      }),
    },
    {
      title: 'Chapters',
      items: chapters.filter(c => c.arc_idx === cur?.idx || cited.has(c.idx)).map(c =>
        `Ch ${c.idx} "${c.title}" (${c.status === 'planned' ? `planned)\n${plan(c)}` : c.summary ? `written): ${c.summary}` : `written to this plan)\n${plan(c)}`}`),
      drop: 3,
    },
    { title: 'Characters and elements the request touches', items: near.map(entityCard) },
    // The first to give way in a long book, least recently seen first; the threads keep their ids for the director to close.
    { title: 'Other known characters and elements (most recently seen first)', items: ents.filter(e => !near.includes(e)).map(e => `- ${e.name} (${e.kind}): ${String(e.state).slice(0, 300)}`), drop: 0, fromEnd: true },
    { title: 'Canon facts near the request (each with its id and chapter)', items: facts.map(f => `- #${f.id} (ch ${f.chapter}) ${f.text}`), drop: 2, fromEnd: true },
    { title: 'Open plot threads (newest first)', items: threadItems(bookId, 40), drop: 1, fromEnd: true },
    { title: `Chapter ${marked?.idx}, full text`, items: marked ? [marked.text] : [] },
    {
      title: 'Earlier requests from the author, oldest first',
      items: all('select text, reply from requests where book_id = ? and reply is not null order by id desc limit 6', bookId).reverse().map(r => `Author: ${r.text}\nYou: ${r.reply}`),
      drop: 4,
    },
  ], budget)
}

function lastWords(text: string, n: number) {
  const paras = text.split(/\n+/).filter(p => p.trim())
  const out: string[] = []
  let count = 0
  for (let i = paras.length - 1; i >= 0 && count < n; i--) {
    out.unshift(paras[i])
    count += paras[i].split(/\s+/).length
  }
  return out
}
