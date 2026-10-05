export type Settings = {
  title: string
  premise: string
  genre: string
  tropes: string[]
  pov: string
  tense: string
  tone: string
  language: string
  rating: string
  chapters: number
  words: number
  style: string
  model: string
  reasoning?: string // missing on older books → 'low'; '' → model default
  fast?: boolean
  // The proofreader's own model and reasoning ('' → that model's default). Unset: it uses the writing model's settings.
  proofModel?: string
  proofReasoning?: string
  directions?: string[] // lasting wishes the author gave while the book was being written
}

// --- strict JSON-schema helpers (strict mode: every key required, no extras) ---
const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) })
const int = (description?: string) => ({ type: 'integer', ...(description ? { description } : {}) })
const arr = (items: object, description?: string) => ({ type: 'array', items, ...(description ? { description } : {}) })
const obj = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const kind = { type: 'string', enum: ['character', 'location', 'faction', 'item'] }

// A state is carried forward and edited, chapter after chapter: what lasts must be in it, not only the last scene.
const STATE = 'rank/level and abilities; role, job, home; money and possessions; relationships; what they know; condition and injuries; where they are now. For a place, faction or item: who holds or runs it, its condition, and the exact wording of any text it carries'

const character = obj({
  name: str(),
  role: str('protagonist, love interest, rival, mentor, antagonist, etc.'),
  appearance: str('distinctive, concrete visual details'),
  personality: str(),
  voice: str('speech patterns, rhythm, vocabulary, how they address others; describe the pattern, with no quotable catchphrase or sample line'),
  goal: str(),
  secret: str('a hidden truth or wound that already holds when the story starts, not an event that happens later; may be empty'),
  arc: str('how they change across the book'),
  state: str(`current status at story start: ${STATE}`),
})

export const bibleSchema = obj({
  title: str('a catchy light-novel title'),
  logline: str(),
  synopsis: str('the whole-book story direction including the climax and ending, 200-350 words'),
  themes: arr(str()),
  world: str('setting overview: era, geography, society, technology/magic level'),
  rules: arr(str(), 'hard world rules and constraints the story must never violate'),
  power_system: str('magic/cultivation/system/skill mechanics with ranks and costs, or "none"'),
  glossary: arr(obj({ term: str(), meaning: str() })),
  characters: arr(character, '6-12 core characters'),
  places: arr(obj({ kind, name: str(), description: str() }), 'key locations, factions, and significant items'),
})

export const outlineSchema = obj({
  arcs: arr(
    obj({
      title: str(),
      goal: str('what this arc accomplishes for plot and characters'),
      plan: str('major beats, turning points, reveals, and the arc climax, 120-250 words'),
      chapters: int('number of chapters in this arc'),
    }),
  ),
})

// `stale` comes first so the planner settles what the story already told before it plans; it is not stored.
export const arcSchema = obj({
  stale: arr(str(), 'points of the CURRENT ARC plan that the story so far already showed, used up, or contradicts, each with what the chapters do instead; empty if none'),
  chapters: arr(
    obj({
      title: str(),
      pov: str('POV character, exact name as listed'),
      cast: arr(str(), 'every character, place, faction, or item that appears, each by its exact name from the known list or from new_entities'),
      beats: arr(str(), '3-6 concrete scene beats in order'),
      hook: str('the turn the chapter ends on, as a short outline note; the next chapter begins after it'),
    }),
  ),
  new_entities: arr(obj({ kind, name: str(), sheet: str('full profile: role, appearance, personality, voice, goals, secrets'), state: str(STATE) }), 'entities introduced in this arc that are not yet known; every cast name must be known or listed here'),
})

const severity = { type: 'string', enum: ['high', 'low'] }

// `continuity_issues` comes first: keys are written in order, and the check must not come after the extraction has
// already taken the chapter at its word.
export const memorySchema = obj({
  continuity_issues: arr(obj({ severity, issue: str('what is wrong, quoting the passage') }), 'everything the checklist finds; high = a reader would notice the story break, low = a nitpick'),
  summary: str('3-5 sentence summary of the chapter'),
  detail: str('detailed recap, 150-300 words: events in order, decisions, key dialogue, revelations, emotional shifts; every score, tally, sum of money, count, date and time exactly as written'),
  facts: arr(
    obj({ text: str('one standalone canon fact, specific and checkable'), tags: arr(str(), 'names involved') }),
    'new canon facts established in this chapter (5-15): every result with its full score, every sum, date and time, who learned what; the exact words of any note, letter, message or page the chapter quotes; for a past event told here, when, where, and the ages of those involved',
  ),
  entity_updates: arr(
    obj({
      name: str('exact existing name'),
      state: str(`the full current state: start from the Current state shown, keep every lasting detail this chapter did not change, then change what it did; do not retell the chapter. Covers ${STATE}`),
      profile_correction: str('only when this chapter establishes something the profile above states differently (an age, a height, a name for someone known by a role): the correction in one sentence; else empty'),
    }),
    'every existing entity whose state changed',
  ),
  new_entities: arr(obj({ kind, name: str(), sheet: str(), state: str(STATE) }), 'entities introduced in this chapter not already known'),
  threads_opened: arr(obj({ text: str('a concrete plot promise, mystery, or setup that a specific later event must pay off; not a theme, a character arc, or a restatement of an open thread'), payoff: str('intended payoff, if implied') }), '0-2 per chapter; empty when the chapter only advances existing threads'),
  threads_resolved: arr(int('id of an open thread this chapter resolved, answered, or made moot')),
  scene_end: str('exact situation at chapter end. First the in-story day and time: weekday and date when the story keeps a calendar, else "Day N" counted from chapter 1, worked out from where the previous chapter ended plus the time this chapter covers (never copied unchanged unless no time passed). Then where, who is present, what is happening'),
})

export const synopsisSchema = obj({
  synopsis: str('200-350 words of plain prose: key events in order, character changes, power or status changes, revelations, and anything left unresolved'),
  threads_resolved: arr(int('id of an open thread this arc resolved, answered, or made moot')),
})

export const proofSchema = obj({
  issues: arr(
    obj({
      chapter: int('the chapter to rewrite'),
      other: int('when the problem is a conflict between two chapters, the other one; otherwise 0'),
      severity,
      issue: str('what is wrong, citing the conflicting passage or fact'),
      fix: str('the smallest rewrite of that chapter that removes the problem without changing anything other chapters rely on: cut or soften the wrong words where that is enough, and never move a reveal, or something a character learns, earlier than the canon has it'),
    }),
    'real errors only; empty when the chapters are clean',
  ),
  threads_resolved: arr(obj({ id: int(), chapter: int('the chapter that resolves it') }), 'open threads these chapters resolve, answer, or make moot'),
})

export const patchSchema = obj({
  edits: arr(
    obj({
      find: str('a passage copied from the chapter exactly, character for character, and long enough to occur only once'),
      replace: str('what takes its place; empty to delete the passage'),
    }),
    'the fewest, smallest edits that fix every problem; passages must not overlap',
  ),
})

export const endingSchema = obj({
  threads: arr(
    obj({
      id: int(),
      verdict: { type: 'string', enum: ['resolved', 'open_ended', 'hole'] },
      chapter: int('resolved: where; hole: the chapter to rewrite; otherwise 0'),
      fix: str('hole only: the smallest rewrite of that chapter that pays the thread off or removes the dangling setup; otherwise empty'),
    }),
    'one entry per open thread',
  ),
  ending: obj({ complete: { type: 'boolean' }, fix: str('if incomplete: what the final chapter must add or change; otherwise empty') }),
})

export const directSchema = obj({
  reply: str('to the author, in plain words: what changes and where, in 1-3 sentences; or the answer to their question, as long as it needs; or the one question you need answered first'),
  renames: arr(
    obj({ from: str('a name or term exactly as the book spells it now'), to: str('spelled and capitalized as it should read') }),
    'names or terms to replace everywhere, written and planned. A plain replacement of every occurrence, also inside longer names: besides the full name, list a form used on its own (a first name, a surname, a nickname) only when every use of it in the book means this one thing',
  ),
  about: arr(
    str('the exact name of a known character, place, faction, or item'),
    'who or what the change is about, when it changes something true of them in the story so far: how they look, what they own or can do, what they know, who they are to someone, whether they are alive. Every written chapter they are in or spoken of is then read in full, so that a passage saying only "she" or "the nurse" is not missed. Empty for a rename, and for a change that only concerns what is not written yet',
  ),
  traces: arr(
    str('a word or short phrase exactly as the written chapters would use it'),
    'what the change touches in chapters already written. Every chapter that uses one of these is read in full against the change and corrected. Give a short form of a replaced name that others share (a family surname), the thing, place, or event that changed, the key words of a fact that is no longer true. Empty only when nothing already written is affected',
  ),
  directions: arr(str(), 'the complete list of standing directions for all writing from here on: the current ones exactly, changed only when this request states a lasting wish about how the book is written; a question or a one-off change leaves them as they are'),
  bible: arr(
    obj({
      field: { type: 'string', enum: ['title', 'logline', 'synopsis', 'world', 'power_system', 'rules', 'themes', 'glossary'] },
      value: str('the full new text of the field; rules and themes one per line, glossary one "term: meaning" per line'),
    }),
    'story bible fields that change',
  ),
  entities: arr(obj({ kind, name: str('an exact known name, or a new one'), sheet: str('the full new profile; empty keeps the current one'), state: str('the full new current state; empty keeps the current one') }), 'characters, places, factions, or items to change or add'),
  arcs: arr(
    obj({ arc: int('arc number; the next unused number adds a new arc at the end of the book'), title: str(), goal: str(), plan: str(), chapters: int('how many chapters this arc has in all, written ones included; its current number to keep its length') }),
    'unfinished arcs whose plan or length changes, each in full',
  ),
  arcs_cut: arr(int('number of an arc to remove from the book; only one with no written chapter')),
  chapters: arr(obj({ chapter: int(), title: str(), pov: str(), cast: arr(str()), beats: arr(str()), hook: str() }), 'planned chapters whose plan changes, each in full'),
  fixes: arr(obj({ chapter: int(), change: str('what to change in this written chapter and where, quoting the passage; the smallest edit that does it') }), 'every written chapter whose text must change'),
  facts_dropped: arr(int('id of a canon fact the change makes untrue')),
  threads_closed: arr(int('id of an open plot thread the change settles or removes')),
})

export const POVS = ['First person', 'Third person limited', 'Third person omniscient']
export const TENSES = ['Past', 'Present']

export const enhanceSchema = obj({
  premise: str(),
  genres: arr(str(), '1-3 genres, most defining first'),
  tropes: arr(str(), '3-7 tropes the story really uses'),
  pov: { type: 'string', enum: POVS },
  tense: { type: 'string', enum: TENSES },
  tone: str('one line on how the telling should feel'),
  chapters: int('chapters this story needs to be told well without padding: 20-200, most stories 30-80'),
  words: int('words per chapter, a multiple of 100 between 1500 and 3500'),
})

// --- instructions ---
const standing = (s: Settings) => (s.directions?.length ? `\nStanding directions from the book's author, which outrank the defaults above:\n${s.directions.map(d => `- ${d}`).join('\n')}\n` : '')

export const architect = (s: Settings) => `You are a story architect and continuity editor for serialized light novels and web novels.
Genre: ${s.genre}. Tropes: ${s.tropes.join(', ') || 'none specified'}. POV: ${s.pov}, ${s.tense} tense. Tone: ${s.tone}. Content rating: ${s.rating}.
Write all story content in ${s.language}. Design for long-form serialization: escalating stakes, satisfying payoffs, memorable characters with distinct voices, a clear power/progression curve when the genre calls for it, and frequent hooks. Be concrete and specific; avoid generic fantasy filler. Respect hard world rules and established canon exactly.${standing(s)}`

// The New book form: no genre or tone yet, those are what it is about to choose.
export const enhancer = (s: Settings) => `You are a story architect for serialized light novels and web novels. Write all story content in ${s.language}. Content rating: ${s.rating}. Be concrete and specific; avoid generic filler.`

export const author = (s: Settings, title: string) => `You are a bestselling light novel and web novel author writing "${title}".
Genre: ${s.genre}. Tropes: ${s.tropes.join(', ') || 'none specified'}. POV: ${s.pov}, ${s.tense} tense. Tone: ${s.tone}. Content rating: ${s.rating}.
Write in ${s.language}.

Craft:
- Open in scene, right where the previous chapter left off or after a time or place jump you make clear in the first lines: mid-action, mid-dialogue, or a sharp sensory moment. Never open with a recap, a summary of earlier chapters, or the weather.
- Short paragraphs (1-4 sentences). Dialogue-forward. Every character speaks in their own voice as described in their profile.
- Strong interiority: the POV character's thoughts, reactions, and humor. Render direct thoughts in *italics*.
- Show through action and concrete detail. Vary sentence rhythm. Keep pacing brisk; every scene must change something.
- Escalate within the chapter and end on the planned hook so readers must click "next chapter".
- Only if the story bible's power system is itself a game-like interface (levels, stats, status windows), set system notices on their own lines in square brackets, e.g. [Skill Acquired: Shadow Step (Lv. 1)]; otherwise never invent bracketed system messages. Numbers must stay consistent with canon.
- Canon is law: never contradict the story bible, character states, or canon facts provided. Characters only know what they have learned on-page. Scores, counts, money, ages and times must add up.
- A new minor character gets a name nobody in the book has; never reuse an established name for a different person.
- Never reuse a joke, simile, catchphrase, or image from the recaps or the previous chapter; a verbal tic is a flavour, not a refrain.
- Plant foreshadowing subtly. Do not resolve open threads unless the beats call for it.
- Banned: "a testament to", "tapestry", "delve", "shiver down spine", "barely above a whisper", "let out a breath they didn't know they were holding", "little did they know", "the weight of" clichés, ending paragraphs by explaining the emotion just shown, moralizing wrap-ups, and overusing em dashes.
${s.style ? `\nMatch the voice of this style sample (voice only, not content):\n"""\n${s.style.slice(0, 4000)}\n"""\n` : ''}${standing(s)}
Output only the chapter prose. No chapter number, no title, no notes, no markdown other than *italics*.`

// --- inputs ---
export const biblePrompt = (s: Settings) => `Create the story bible for a new ${s.chapters}-chapter ${s.genre} serial.

Premise from the author:
"""
${s.premise}
"""
${s.title ? `\nThe title is fixed: "${s.title}".\n` : ''}
Build a world and cast rich enough to sustain ${s.chapters} chapters of roughly ${s.words} words each. Give each character a distinct voice. Define hard rules the plot must respect.`

export const enhancePrompt = (s: Settings, genres: string[], tropes: string[], tone: string) => `Notes from the author for a new serial:
"""
${s.premise}
"""

Turn these notes into a full story premise of 300-450 words. The notes are raw material, not text to polish: never restate or paraphrase them, and do not describe the idea from the outside. Stay faithful to every idea in them, then invent everything they leave out and tell it as this one specific story:
- a named protagonist with a particular past, a want, a flaw, and something to lose
- the opening situation, and the event that sets the story in motion
- the setting in concrete detail: the place, the era, the particular world the story lives in
- named allies, rivals, and an antagonist, each with their own reason to be in the story
- the central conflict and how it escalates over the course of the book
- what the protagonist must change in themselves, and the ending the story is heading for
Real people and existing works mentioned in the notes are inspiration for traits and style only: do not name them. Write flowing prose in a few paragraphs, specific enough that two writers would get the same book from it. The premise holds only the story: no title, headings, lists, or commentary.

Then choose how this story should be written: its genres, its tropes, the point of view, tense, and tone that suit it, and the length it needs.${genres.length ? `\nGenre labels to use where one fits: ${genres.join(', ')}.` : ''}${tropes.length ? `\nTrope labels to use where one fits: ${tropes.join(', ')}.` : ''}
Name your own genre or trope when no label fits.${s.tropes.length ? `\nThe author already chose these tropes; build them in: ${s.tropes.join(', ')}.` : ''}${tone ? `\nThe author wants this tone; write the premise to it: ${tone}` : ''}`

export const outlinePrompt = (s: Settings, bible: string) => `${bible}

Divide the whole book into story arcs (volumes) totalling exactly ${s.chapters} chapters. Typical arcs run 8-15 chapters; very short books may be a single arc. Each arc needs its own goal, rising tension, and climax, while building toward the book's ending in the synopsis.`

export const arcPrompt = (n: number, ctx: string, last: boolean, rest = false) => `${ctx}

${rest ? `The CURRENT ARC is partly written. Plan the chapters it has left, exactly ${n}, starting right after the last written one` : `Expand the CURRENT ARC into exactly ${n} chapters`}. Pace it so the arc climax lands near the end. Each chapter: a few concrete beats, a clear POV, everyone who appears, and an ending hook. List any new characters/places/items this arc introduces.
The story so far outranks the arc plan, which was outlined before any of it was written:
- The first chapter's first beat is what happens next after the scene where the story currently stands, never that scene again; each later chapter's first beat starts after the previous chapter's hook.
- Never plan a scene, reveal, confession, apology, meeting, or decision the story so far already shows; plan its consequence instead. Each event happens in exactly one chapter, and later chapters treat it as done. Plan only the CURRENT ARC: what later arcs' plans hold belongs to them.
- A beat may quote a number (a score, a sum, an age) only if the canon above has it. Every beat and hook is something the chapter's POV character sees, does, or learns.
${last
  ? 'This is the FINAL arc. Its beats must pay off or deliberately close every open plot thread, and the last chapter must deliver the climax and ending from the book direction: its "hook" is the closing image of the book, not a cliffhanger. Each event the book direction names for the ending (a choice, a confrontation, a farewell, a reveal) is a beat shown on the page with the people involved present, not reported afterwards.'
  : 'Pay off the open plot threads that are due in this arc; leave no setup forgotten.'}`

export const chapterPrompt = (ctx: string, words: number) => `${ctx}

Write this chapter now: ${words} words, never more than ${Math.round(words * 1.15)}. Follow the beats in order and end on the hook.
The previous chapter's ending has already happened: start right after it, and never stage again anything it or the recaps already show. Where a beat clashes with what has already happened, the story so far wins: adapt the beat in the smallest way. Stop at the hook; the next chapter is not yours to begin.`

export const continuePrompt = (ctx: string, draft: string, words: number) => `${ctx}

The chapter so far:
"""
${draft}
"""

The chapter is too short. Continue it seamlessly from the exact last sentence for about ${words} more words, covering any remaining beats and ending on the hook. Output only the continuation.`

// `edited`: the chapter was digested before and its text has changed since.
export const memoryPrompt = (ctx: string, text: string, edited = false) => `${ctx}

CHAPTER TEXT:
"""
${text}
"""

You are the continuity editor. First check the chapter, and list as continuity issues everything that fails:
- each hard rule, the power system, and the glossary above: does any passage break one?
- each character and element card: appearance, age, rank or abilities, possessions, injuries, location, what they know, whether alive
- the chapter's own numbers: scores, tallies, counts, money, ages, dates and clock times must add up, and agree with the canon facts
- the opening follows from where the previous chapter ended, and time never runs backwards
- nothing the previous chapter or the recaps already showed is staged again, no passage repeats inside the chapter, and nothing planned for the next chapter happens here
- the point of view and tense stay as set
- every planned beat and the ending hook are delivered, in any wording; a beat the story so far already showed counts as delivered when this chapter refers back to it
Then extract what this chapter established and changed. Use the exact names already known.${edited ?'\nThis chapter was edited after it was first read. The current states above were recorded from its earlier text and may no longer hold: give the full current state of every character and element that appears in it, as the chapter now leaves them.' : ''}`

export const revisePrompt = (ctx: string, text: string, issues: string[]) => `${ctx}

DRAFT:
"""
${text}
"""

Continuity problems found in the draft:
${issues.map(i => `- ${i}`).join('\n')}

Rewrite the full chapter fixing these problems while keeping everything else (events, voice, length, hook) as close to the draft as possible. Output only the chapter prose.`

// `recheck`: findings of a check made before other chapters were repaired, which may have settled them since.
export const patchPrompt = (ctx: string, text: string, issues: string[], recheck = false) => `${ctx}

CHAPTER:
"""
${text}
"""

Problems found in the chapter:
${issues.map(i => `- ${i}`).join('\n')}

Fix these problems by editing only the passages that cause them. Each edit replaces one passage, copied exactly from the chapter, with its corrected version in the same voice. To add text, replace the sentence it follows with that sentence plus the addition. Where a problem repeats, give one edit per place. Cut or soften the wrong words wherever that is enough: add no events or numbers beyond what the problem needs, and never have a character say, learn, or reveal something the canon shows them learning later. Leave everything else as it is.${recheck ? '\nThese problems were found before other chapters were repaired. Check each one against the chapters and the canon above as they stand now: one that no longer holds, because the other side was already brought in line, needs no edit.' : ''}`

export const directPrompt = (ctx: string, text: string, chapter: number | null, quote: string | null) => `${ctx}

REQUEST FROM THE AUTHOR${quote ? `, about this passage they highlighted in chapter ${chapter}:\n"""\n${quote}\n"""\n` : chapter ? `, made while looking at chapter ${chapter}:` : ':'}
"""
${text}
"""

You are the story's director. The author owns this book, and autopilot keeps writing the remaining chapters from whatever you leave behind. Carry the request out and change nothing else; when you are done, the plan and the canon must agree with it.
- Written chapters change through "fixes". List every written chapter whose text must change, including later ones the change would now contradict. Each is edited passage by passage and the rest stays word for word, so describe the smallest edit.
- You see most written chapters only as summaries, so you cannot list every chapter a change reaches. Two lists cover the rest, so the author never has to find leftovers themselves. "traces": the words by which the changed thing appears in the text; every passage and every record using one, in any form of the word, is read and corrected. "about": the characters or things the change is about, when it alters something already true of them; every chapter they are in or spoken of is read in full, because the text there may never use a word you can name. Leave both empty only when nothing already written can be affected.
- Everything not written yet changes through the plan: the story bible, the unfinished arcs, the planned chapters, and the profiles and current states of characters and elements. Rework what follows so the story still builds, pays off its open threads, and reaches the planned ending, unless the author asks for another.
- The book's length changes only when the author asks: give unfinished arcs a new number of chapters, add an arc at the end, or cut an arc nothing was written for. A planned arc that changes length has its unwritten chapters planned again from its new plan, so list none of them under chapters. Otherwise every arc keeps its number of chapters.
- A name or term that changes everywhere is a rename: list no fixes for it, and use the new name in everything else you return. A rename replaces only the exact form you give. The text mostly uses short forms, so think of each one: a first name used alone is its own rename when nobody else has it; a form others share, like a family's surname, goes under traces instead.
- A lasting wish about how the book is written (tone, pacing, style, what to favour or avoid) is a standing direction.
- Drop the canon facts the change makes untrue, and close the plot threads it removes.
- A question about the story gets a straight answer from the canon above, and changes nothing. Say so when the canon does not settle it rather than inventing an answer.
- If the request can be read two ways that would change the book differently, ask the author one short question in the reply and change nothing: they will answer in their next request, and the earlier requests above show what was already said.
- If the request cannot be carried out, say why in the reply and change nothing.
- The reply states only what you are returning here. Do not promise edits or plan changes that are not in this response.`

// A chapter the author rewrote themselves, put to the director as a request.
export const handPrompt = (chapter: number, cut: string[], added: string[]) => `I edited chapter ${chapter} by hand. Its text as shown above is final: list no fix for it. Bring the canon, the plan, and every other chapter it now contradicts in line with it. If my edit changes nothing beyond its own wording, reply and change nothing.

Passages I removed or replaced:
${cut.join('\n') || '(none)'}

Passages I added or rewrote:
${added.join('\n') || '(none)'}`

// --- the sweep: after a change, everything written before it that uses a word it touches is read in full ---
export const recordsSweepSchema = obj({
  notes: arr(obj({ n: int('the number of the note'), text: str('the whole note, corrected') }), 'only the notes that had to change'),
})
export const chapterSweepSchema = obj({
  chapters: arr(
    obj({
      chapter: int(),
      edits: arr(obj({
        find: str('a passage copied from the chapter exactly as shown, character for character, and long enough to occur only once in the chapter: a whole sentence'),
        replace: str('what takes its place; empty to delete the passage'),
      })),
    }),
    'only the chapters that have to change',
  ),
})

export const sweepBrief = (cast: string, ask: string, done: string, look: string[]) => `Everyone and everything named in the book, as named now:
${cast}

The author changed the book. Their request:
"""
${ask}
"""
What was done: ${done}
What may be left behind:
${look.map(l => `- ${l}`).join('\n')}`

export const recordsSweepPrompt = (brief: string, notes: string[]) => `${brief}

These are notes from the story's own records (recaps, canon facts, character states, plans), each written before the change and using a word it touches:
${notes.map((n, i) => `[${i + 1}] ${n}`).join('\n')}

Return the corrected text of every note that still tells the old version, changing nothing else in it. Leave out a note that is right as it stands, such as one where the word belongs to someone or something the change does not touch. A note that is a JSON list stays a JSON list.`

export const chapterSweepPrompt = (brief: string, text: string) => `${brief}

CHAPTERS, written before the change. Some are shown whole; of the others, only the passages that use a word the change touches:
${text}

Read everything shown. Find every place that still tells the old version: an old name, or part of one, used for what was renamed (a first name or surname alone, with a title, in capitals); a fact the change made untrue; something it removed. That includes places that never use the name: "she", a title, a description. For each such place give an edit: the passage, and the same passage corrected, in the same voice. To add text, replace the sentence it follows with that sentence plus the addition. A word that belongs to someone or something the change does not touch stays as it is. Leave out chapters that already agree with the change.`

export const synopsisPrompt =(arcTitle: string, plan: string, recaps: string, threads: string[]) => `Arc: ${arcTitle}
Plan:
${plan}

Chapter recaps:
${recaps}

Open plot threads:
${threads.join('\n') || 'none'}

Write the synopsis of what actually happened in this arc, and list the open plot threads it settled.`

export const proofPrompt = (ctx: string, text: string) => `${ctx}

CHAPTERS TO PROOFREAD:
${text}

You are the proofreader. The book is finished. Read these chapters against everything above and report every real error a careful reader would catch:
- contradictions with the story bible, its hard rules, the canon facts, or other chapters: names, appearance, ages, numbers, levels, possessions, injuries, locations, who knows what, who is alive
- timeline and causality breaks, events that happen twice (also a scene another chapter already staged), a chapter that does not follow from the one before it
- numbers that do not add up within a chapter: scores, tallies, money, ages, clock times
- setups in these chapters that the book never pays off, and payoffs that were never set up
- point of view or tense slips
- broken text: a chapter cut off mid-scene, repeated passages, leftover notes or headings
A canon fact dated after a chapter describes a later moment; it is a contradiction only if both cannot be true in order. High = a reader would notice the story break; low = a nitpick. Do not report matters of taste. Also list the open plot threads these chapters resolve.`

export const endingPrompt = (ctx: string) => `${ctx}

The book is finished. Judge every open plot thread above: "resolved" if the story did answer it; "open_ended" if it is a theme, an ongoing condition, or a deliberate open question that needs no answer; "hole" if the story set it up and leaves the reader hanging. For a hole, pick the chapter where a repair fits most naturally (spread repairs out rather than piling them onto the final chapter) and describe the smallest rewrite. Then judge the ending: does the final chapter deliver the climax and conclusion the book direction promises?`
