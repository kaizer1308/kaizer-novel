import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, BookOpen, Download, MoreHorizontal, Pause, PenLine, Play, RotateCw, Send, SpellCheck, Trash2, TriangleAlert, Clock, PanelRight, X } from 'lucide-react'
import { api, countWords, effortName, eta, fmt, storage, useBook, useNow, type Book, type ChapterText, type Issue, type Live, type Model, type Settings } from '../api'
import { Bar, BookGlyph, ChapterGlyph, Empty, Menu, Prose, StatusPill, type ChapterState } from '../ui'
import { Body, ChangeThis, Direct, type Quote } from '../direct'
import { Inkstone } from './Inkstone'

type Pane = 'doc' | 'list' | 'memory'

export function BookView({ id, onChange }: { id: number; onChange: () => void }) {
  const { book, live, error, refresh } = useBook(id)
  const [selected, setSelected] = useState<number | 'live'>('live')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [pane, setPane] = useState<Pane>('doc')
  const [panel, setPanel] = useState<'ink' | 'proof' | null>(null) // Inkstone or the proofreading board takes the document's place
  const now = useNow(1000, book?.status === 'waiting')

  if (error && !book) return <Empty title="Book not found">{error}</Empty>
  if (!book) return <div className="page-loading" aria-busy="true" />

  const act = async (path: string) => {
    await api.post(`/api/books/${id}/${path}`).catch(() => {})
    refresh()
    onChange()
  }
  const remove = async () => {
    if (!confirm(`Delete "${book.title}"? This permanently removes the book, its chapters, and its story memory.`)) return
    await api.del(`/api/books/${id}`)
    onChange()
    location.hash = '#/'
  }
  const active = book.status === 'running' || book.status === 'waiting'
  // Until a pass has finished, this carries it on; after, it starts a fresh one.
  const proofread = () => {
    if (!book.proofed) return act('resume')
    if (confirm('Proofread the whole book again? Every chapter is re-read against the full story, and whatever is found is repaired.')) act('proofread')
  }
  const firstRead = storage.get<{ idx: number } | null>(`kaizer.read.${id}`, null)?.idx ?? book.chapters.find(c => c.status === 'done')?.idx
  const pick = (idx: number | 'live') => (setSelected(idx), setPanel(null), setPane('doc'))
  const toggle = (p: 'ink' | 'proof') => (setPanel(cur => (cur === p ? null : p)), setPane('doc'))

  return (
    <div className="book" data-pane={pane}>
      <header className="book-head">
        <div className="book-head-title">
          <h1 className="truncate">{book.title}</h1>
          <StatusPill status={book.status} />
          {book.status === 'running' && book.phase && <span className="book-head-phase truncate">{book.phase}</span>}
        </div>
        <div className="book-head-actions">
          {firstRead !== undefined && (
            <a className="btn" href={`#/book/${id}/read/${firstRead}`}>
              <BookOpen size={15} strokeWidth={1.75} /> Read
            </a>
          )}
          <Menu label="Export" icon={<Download size={15} strokeWidth={1.75} />}>
            {close =>
              (['epub', 'md', 'txt'] as const).map(f => (
                <a key={f} role="menuitem" className="menu-item" href={`/api/books/${id}/export/${f}`} onClick={close} download>
                  {f === 'epub' ? 'EPUB e-book' : f === 'md' ? 'Markdown' : 'Plain text'}
                  <span className="menu-item-meta">.{f}</span>
                </a>
              ))
            }
          </Menu>
          <button className="btn" aria-pressed={panel === 'ink'} onClick={() => toggle('ink')}>
            <Send size={15} strokeWidth={1.75} /> Inkstone
          </button>
          <button className="btn" aria-pressed={panel === 'proof'} onClick={() => toggle('proof')}>
            <SpellCheck size={15} strokeWidth={1.75} /> Proofreading
          </button>
          <Menu label="" ariaLabel="More actions" icon={<MoreHorizontal size={16} strokeWidth={1.75} />}>
            {close => (
              <button role="menuitem" className="menu-item menu-item-danger" onClick={() => (close(), remove())}>
                <Trash2 size={15} strokeWidth={1.75} /> Delete book
              </button>
            )}
          </Menu>
          <button className="btn btn-ghost memory-toggle" aria-pressed={pane === 'memory'} onClick={() => setPane(p => (p === 'memory' ? 'doc' : 'memory'))}>
            <PanelRight size={15} strokeWidth={1.75} /> Memory
          </button>
          {active && (
            <button className="btn btn-primary" onClick={() => act('pause')}>
              <Pause size={15} strokeWidth={2} /> Pause
            </button>
          )}
          {(book.status === 'paused' || book.status === 'error') && (
            <button className="btn btn-primary" onClick={() => act('resume')}>
              <Play size={15} strokeWidth={2} /> Resume
            </button>
          )}
          {book.status === 'complete' && (
            <button className={`btn${book.proofed ? '' : ' btn-primary'}`} title="Re-read the whole book and repair contradictions, plot holes, and loose ends" onClick={proofread}>
              <SpellCheck size={15} strokeWidth={2} /> {book.proofed ? 'Proofread again' : 'Proofread'}
            </button>
          )}
        </div>
      </header>

      <nav className="book-tabs" aria-label="Book sections">
        {(['doc', 'list', 'memory'] as Pane[]).map(p => (
          <button key={p} className={`book-tab${pane === p ? ' on' : ''}`} aria-pressed={pane === p} onClick={() => setPane(p)}>
            {p === 'doc' ? 'Writing' : p === 'list' ? 'Chapters' : 'Memory'}
          </button>
        ))}
      </nav>

      {book.status === 'waiting' && (
        <div className="banner banner-waiting" role="status">
          <Clock size={16} strokeWidth={1.75} />
          <span>
            {book.error ?? 'Paused for ChatGPT usage limits.'}{' '}
            {book.retry_at && (
              <>
                Trying again in <strong className="num">{fmt.clock(book.retry_at - now)}</strong>.
              </>
            )}
          </span>
          <button className="btn btn-sm" onClick={() => act('resume')}>
            <RotateCw size={14} strokeWidth={1.75} /> Try now
          </button>
        </div>
      )}
      {book.status === 'error' && (
        <div className="banner banner-error" role="alert">
          <TriangleAlert size={16} strokeWidth={1.75} />
          <span>
            <strong>Autopilot stopped.</strong> {book.error} Resume picks up exactly where it left off.
          </span>
        </div>
      )}

      <div className="book-body">
        <ChapterList book={book} live={live} selected={selected} onPick={pick} />
        {panel === 'ink' ? (
          <Inkstone book={book} />
        ) : panel === 'proof' ? (
          <ProofBoard book={book} onPick={pick} onStart={proofread} />
        ) : (
          <div className="doc-col">
            <Document book={book} live={live} selected={selected} onFollow={() => setSelected('live')} onQuote={setQuote} />
            <Direct book={book} quote={quote} onQuote={setQuote} viewing={selected === 'live' ? (live && book.status === 'running' ? live.idx : undefined) : selected} onOpen={pick} />
          </div>
        )}
        <Inspector book={book} onClose={() => setPane('doc')} />
      </div>
    </div>
  )
}

// What the engine is doing to a written chapter, or has waiting for it: an edit the author asked for, a
// proofreader repair, the continuity check's own fix, re-reading it after an edit, or checking it against a change.
// The chapters at work are the ones the engine's phase names; steps that run side by side join theirs with " · ".
const AT_WORK = /^(?:(Proofreading: repairing|Revising) chapter (\d+)( as you asked| for continuity)?|Re-reading chapter (\d+) after its edit)/
type Work = { label: string; detail: string; now: boolean }
function chapterWork(book: Book, c: Book['chapters'][number]): Work | null {
  const m = book.status === 'running' ? (book.phase ?? '').split(' · ').map(p => AT_WORK.exec(p)).find(m => m && Number(m[2] ?? m[4]) === c.idx) : null
  if (m) {
    if (m[4]) return { label: 'Re-reading', detail: 'Edited just now: its recap and canon facts are being read again from the new text', now: true }
    if (m[3] === ' as you asked') return { label: 'Editing', detail: 'Being edited as you asked', now: true }
    if (m[3] === ' for continuity') return { label: 'Revising', detail: 'The continuity check is fixing what it found', now: true }
    return { label: 'Repairing', detail: 'The proofreader is repairing what it found', now: true }
  }
  if (c.status !== 'done') return null
  if (c.edits_asked) return { label: 'Queued', detail: 'An edit you asked for is waiting its turn', now: false }
  if (c.edits_queued) return { label: 'Queued', detail: 'The proofreader will repair this chapter next', now: false }
  if (c.sweeping) return { label: 'To check', detail: 'Will be read against your latest change', now: false }
  return null
}

function chapterState(book: Book, live: Live, c: Book['chapters'][number]): ChapterState {
  if (c.status === 'done') return 'done'
  if (c.status === 'drafted') return 'drafted'
  return live?.idx === c.idx && book.status === 'running' ? 'writing' : 'planned'
}

function ChapterList({ book, live, selected, onPick }: { book: Book; live: Live; selected: number | 'live'; onPick: (i: number | 'live') => void }) {
  if (!book.arcs.length)
    return (
      <aside className="book-list" aria-label="Chapters">
        <p className="muted pad">The chapter list appears once the arc outline is ready.</p>
      </aside>
    )
  return (
    <aside className="book-list" aria-label="Chapters">
      {book.status === 'running' && (
        <button className={`chapter-row chapter-live${selected === 'live' ? ' on' : ''}`} onClick={() => onPick('live')}>
          <span className="live-dot" aria-hidden="true" />
          <span className="truncate">Live</span>
          {live && <span className="chapter-words num">Chapter {live.idx}</span>}
        </button>
      )}
      {book.arcs.map(a => {
        const chapters = book.chapters.filter(c => c.arc_idx === a.idx)
        const done = chapters.filter(c => c.status === 'done').length
        return (
          <section key={a.idx} className="arc-group">
            <h3 className="arc-head">
              <span className="truncate">{a.title}</span>
              <span className="num">
                {done}/{a.chapter_count}
              </span>
            </h3>
            {chapters.length ? (
              chapters.map(c => {
                const state = chapterState(book, live, c)
                const viewable = c.status !== 'planned' || state === 'writing'
                const work = chapterWork(book, c)
                return (
                  <button
                    key={c.idx}
                    className={`chapter-row${selected === c.idx ? ' on' : ''}${work?.now ? ' chapter-row-work' : ''}`}
                    disabled={!viewable}
                    onClick={() => onPick(state === 'writing' ? 'live' : c.idx)}
                    title={work ? `${work.detail}. ${c.summary ?? c.title}` : (c.summary ?? c.title)}
                  >
                    <ChapterGlyph state={work?.now ? 'writing' : state} />
                    <span className="chapter-n num">{c.idx}</span>
                    <span className="truncate">{c.title}</span>
                    {work ? (
                      <span key={work.label} className={`chapter-work${work.now ? ' now' : ''}`}>
                        {work.label}
                      </span>
                    ) : (
                      c.words > 0 && <span className="chapter-words num">{(c.words / 1000).toFixed(1)}k</span>
                    )}
                  </button>
                )
              })
            ) : (
              <p className="arc-pending">
                <ChapterGlyph state="planned" /> {a.chapter_count} chapters, planned when the arc begins
              </p>
            )}
          </section>
        )
      })}
    </aside>
  )
}

function Document({ book, live, selected, onFollow, onQuote }: { book: Book; live: Live; selected: number | 'live'; onFollow: () => void; onQuote: (q: Quote) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const [chapter, setChapter] = useState<ChapterText | null>(null)
  const [draft, setDraft] = useState<string | null>(null) // the chapter's text while the author edits it by hand
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setChapter(null)
    setDraft(null)
    setError(null)
    if (selected !== 'live') {
      api.get<ChapterText>(`/api/books/${book.id}/chapters/${selected}`).then(setChapter, () => {})
      ref.current?.scrollTo({ top: 0 })
    }
    setPinned(true)
  }, [selected, book.id])

  // An edit the author asked for rewrites the chapter on screen: reload it in place as the book moves on.
  useEffect(() => {
    if (selected !== 'live') api.get<ChapterText>(`/api/books/${book.id}/chapters/${selected}`).then(setChapter, () => {})
  }, [book.updated_at])

  // Follow the live text while the reader stays near the bottom.
  useLayoutEffect(() => {
    if (selected === 'live' && pinned && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [live?.text, selected, pinned])

  const onScroll = () => {
    const el = ref.current!
    if (selected === 'live') setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 120)
  }

  // The author's own text replaces the chapter as it stands; the engine then brings the rest of the book in line.
  const save = async () => {
    if (!chapter || draft === null) return
    const text = draft.trim()
    try {
      await api.post(`/api/books/${book.id}/chapters/${chapter.idx}`, { text })
      setChapter(await api.get<ChapterText>(`/api/books/${book.id}/chapters/${chapter.idx}`))
      setDraft(null)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  let content
  if (selected !== 'live') {
    const meta = book.chapters.find(c => c.idx === selected)
    const work = meta && chapterWork(book, meta)
    content = chapter?.idx === selected ? (
      <article className="doc-article">
        <ChapterHeading n={chapter.idx} title={chapter.title} meta={`${chapter.pov ? `${chapter.pov} · ` : ''}${fmt.num(draft === null ? chapter.words : countWords(draft))} words`} />
        {/* The text on screen is about to change: say so, and what changes it. */}
        {work && draft === null && (
          <p key={work.label} className={`chapter-work-note${work.now ? ' now' : ''}`} role="status">
            <ChapterGlyph state={work.now ? 'writing' : 'planned'} /> {work.detail}{work.now && !work.label.startsWith('Re-') ? '. The text below updates when it is done.' : '.'}
          </p>
        )}
        {draft === null ? (
          <Body bookId={book.id} chapter={chapter} onSeen={() => setChapter({ ...chapter, diff: null })} ink={book.chapters.find(c => c.idx === chapter.idx)} />
        ) : (
          <textarea className="input textarea doc-edit" aria-label={`Text of chapter ${chapter.idx}`} value={draft} onChange={e => setDraft(e.target.value)} autoFocus />
        )}
        {error && (
          <p className="direct-error" role="alert">
            {error}
          </p>
        )}
        <div className="doc-foot">
          {draft === null ? (
            <>
              <a className="btn" href={`#/book/${book.id}/read/${chapter.idx}`}>
                <BookOpen size={15} strokeWidth={1.75} /> Open in reader
              </a>
              <button className="btn" title="Rewrite this chapter yourself. The rest of the book is then brought in line with it." onClick={() => setDraft(chapter.text ?? '')}>
                <PenLine size={15} strokeWidth={1.75} /> Edit by hand
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-primary" disabled={!draft.trim()} onClick={save}>
                Save chapter
              </button>
              <button className="btn" onClick={() => (setDraft(null), setError(null))}>
                Cancel
              </button>
              <span className="muted">*Asterisks* mark italics. A line in [brackets] is a system window.</span>
            </>
          )}
        </div>
      </article>
    ) : (
      <div className="doc-article" aria-busy="true">
        {meta && <ChapterHeading n={meta.idx} title={meta.title} meta="Loading…" />}
      </div>
    )
  } else if (live && book.status === 'running') {
    const meta = book.chapters.find(c => c.idx === live.idx)
    const words = countWords(live.text)
    content = (
      <article className="doc-article">
        <ChapterHeading
          className="doc-live-head"
          n={live.idx}
          title={meta?.title ?? ''}
          meta={
            <>
              <span className="live-dot" aria-hidden="true" />
              {/^(Revising|Proofreading)/.test(book.phase ?? '') ? 'Revising' : 'Writing'} ·{' '}
              <span className="num">
                {fmt.num(words)} / {fmt.num(book.settings.words)}
              </span>{' '}
              words
              <span className="meta-mobile num">
                {' '}
                · {book.done} / {book.total} chapters
              </span>
            </>
          }
        />
        <Prose text={live.text} caret />
      </article>
    )
  } else {
    content = <Pipeline book={book} />
  }

  return (
    <div className="doc" ref={ref} onScroll={onScroll}>
      {content}
      <ChangeThis root={ref} chapter={selected === 'live' ? live?.idx : selected} onQuote={onQuote} />
      {selected === 'live' && live && !pinned && (
        <button className="btn jump-live" onClick={() => (setPinned(true), onFollow())}>
          <ArrowDown size={14} strokeWidth={2} /> Follow live
        </button>
      )}
    </div>
  )
}

function ChapterHeading({ n, title, meta, className = '' }: { n: number; title: string; meta: ReactNode; className?: string }) {
  return (
    <header className={`chapter-heading ${className}`}>
      <h2>
        <span className="chapter-n-inline">{n}</span>
        {title}
      </h2>
      <div className="chapter-meta">{meta}</div>
    </header>
  )
}

// What the engine is doing when no prose is streaming: the pipeline, with honest state.
function Pipeline({ book }: { book: Book }) {
  if (book.status === 'complete')
    return (
      <div className="pipeline">
        <h2>The book is finished.</h2>
        <p className="muted">
          {book.done} chapters, {fmt.num(book.words)} words. {proofSummary(book)}
        </p>
        <div className="pipeline-actions">
          <a className="btn btn-primary" href={`#/book/${book.id}/read/${book.chapters[0]?.idx ?? 1}`}>
            <BookOpen size={15} strokeWidth={1.75} /> Start reading
          </a>
          <a className="btn" href={`/api/books/${book.id}/export/epub`} download>
            <Download size={15} strokeWidth={1.75} /> Download EPUB
          </a>
        </div>
        <Proof book={book} />
      </div>
    )
  const curArc = book.arcs.find(a => !a.synopsis)
  const proofing = book.arcs.length > 0 && !curArc
  const lastDone = book.chapters.filter(c => c.status === 'done').at(-1)
  const steps: [string, 'done' | 'now' | 'next'][] = [
    ['Story bible and cast', book.bible ? 'done' : 'now'],
    ['Arc outline for the whole book', book.arcs.length ? 'done' : book.bible ? 'now' : 'next'],
    [curArc ? `Plan arc: ${curArc.title}` : 'Plan the first arc', proofing || book.chapters.some(c => c.arc_idx === curArc?.idx) ? 'done' : book.arcs.length ? 'now' : 'next'],
    ['Write, check, and remember each chapter', proofing ? 'done' : book.chapters.length ? 'now' : 'next'],
    ['Proofread the finished book', proofing ? 'now' : 'next'],
  ]
  const idle = book.status !== 'running'
  return (
    <div className="pipeline">
      <h2>{idle ? (book.status === 'paused' ? 'Autopilot is paused.' : book.status === 'waiting' ? 'Waiting to continue.' : 'Autopilot stopped.') : book.phase ?? 'Starting…'}</h2>
      {lastDone && (
        <p className="muted">
          Last finished: chapter {lastDone.idx}, “{lastDone.title}”.
        </p>
      )}
      <ol className="pipeline-steps">
        {steps.map(([label, state]) => (
          <li key={label} className={`step-${state}`}>
            {state === 'now' && idle ? <BookGlyph status={book.status} /> : <ChapterGlyph state={state === 'done' ? 'done' : state === 'now' ? 'writing' : 'planned'} />}
            {label}
          </li>
        ))}
      </ol>
      {lastDone?.summary && (
        <div className="pipeline-recap">
          <h3>Previously</h3>
          <p>{lastDone.summary}</p>
        </div>
      )}
      <Proof book={book} />
    </div>
  )
}

function proofSummary(book: Book) {
  if (!book.proofed) return 'Not proofread yet.'
  const n = (status: Issue['status']) => book.issues.filter(i => i.status === status).length
  if (!n('fixed') && !n('unfixed')) return 'Proofread: nothing needed repair.'
  return `Proofread: ${n('fixed')} repaired${n('kept') ? `, ${n('kept')} needed no change` : ''}${n('unfixed') ? `, ${n('unfixed')} could not be repaired` : ''}.`
}

// Applies from the next model call; the SSE update refetches the book, so a failed save just snaps back.
function SpeedSettings({ book }: { book: Book }) {
  const [models, setModels] = useState<Model[]>()
  useEffect(() => {
    api.get<Model[]>('/api/models').then(setModels, () => {})
  }, [])
  const model = models?.find(m => m.slug === book.settings.model)
  const save = (patch: Partial<Settings>) => api.post(`/api/books/${book.id}/settings`, patch).catch(() => {})
  const effort = book.settings.reasoning ?? 'low'
  // The proofreader may check and repair with another model; it starts at that model's own default reasoning.
  const proof = models?.find(m => m.slug === book.settings.proofModel)
  const proofEffort = book.settings.proofReasoning ?? ''
  const pickProof = (slug: string) => {
    const m = models?.find(x => x.slug === slug)
    save({ proofModel: slug, proofReasoning: m ? (m.efforts.includes(proofEffort) ? proofEffort : m.defaultEffort ?? '') : '' })
  }
  return (
    <>
      <div className="stats-row">
        <dt>Reasoning</dt>
        <dd>
          {model?.efforts.length ? (
            <select className="input stats-select" aria-label="Reasoning" value={effort} onChange={e => save({ reasoning: e.target.value })}>
              {model.efforts.map(e => (
                <option key={e} value={e}>
                  {effortName(e, model)}
                </option>
              ))}
            </select>
          ) : (
            effort || 'Model default'
          )}
        </dd>
      </div>
      {model?.fast && (
        <div className="stats-row">
          <dt title={model.fast}>Fast mode</dt>
          <dd>
            <select className="input stats-select" aria-label="Fast mode" value={book.settings.fast ? 'on' : 'off'} onChange={e => save({ fast: e.target.value === 'on' })}>
              <option value="off">Off</option>
              <option value="on">On: {model.fast}</option>
            </select>
          </dd>
        </div>
      )}
      <div className="stats-row">
        <dt title="The model that checks the finished book and repairs what it finds. Chapters are still written with the book's model.">Proofreading</dt>
        <dd>
          <select className="input stats-select" aria-label="Proofreading model" value={book.settings.proofModel ?? ''} disabled={!models} onChange={e => pickProof(e.target.value)}>
            <option value="">Same as writing</option>
            {/* A model the plan no longer lists stays visible until it is changed. */}
            {book.settings.proofModel && !proof && <option value={book.settings.proofModel}>{book.settings.proofModel}</option>}
            {models?.map(m => (
              <option key={m.slug} value={m.slug}>
                {m.name}
              </option>
            ))}
          </select>
        </dd>
      </div>
      {proof && proof.efforts.length > 0 && (
        <div className="stats-row">
          <dt>Its reasoning</dt>
          <dd>
            <select className="input stats-select" aria-label="Proofreading reasoning" value={proofEffort || (proof.defaultEffort ?? '')} onChange={e => save({ proofReasoning: e.target.value })}>
              {proof.efforts.map(e => (
                <option key={e} value={e}>
                  {effortName(e, proof)}
                </option>
              ))}
            </select>
          </dd>
        </div>
      )}
    </>
  )
}

type Tab = 'cast' | 'threads' | 'bible' | 'arcs'

function Inspector({ book, onClose }: { book: Book; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(() => storage.get('kaizer.inspectorTab', 'cast'))
  useEffect(() => storage.set('kaizer.inspectorTab', tab), [tab])
  const targetWords = book.total * book.settings.words
  const left = eta(book.chapters, book.total)
  const open = book.threads.filter(t => t.status === 'open')
  return (
    <aside className="inspector" aria-label="Story memory">
      <div className="inspector-close">
        <button className="icon-btn" aria-label="Close memory panel" onClick={onClose}>
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <dl className="stats">
        <div>
          <dt>Chapters</dt>
          <dd className="num">
            {book.done} <span className="muted">/ {book.total}</span>
          </dd>
          <Bar value={book.done} max={book.total} label="Chapters finished" />
        </div>
        <div>
          <dt>Words</dt>
          <dd className="num">
            {fmt.num(book.words)} <span className="muted">/ ~{fmt.num(targetWords)}</span>
          </dd>
          <Bar value={book.words} max={targetWords} label="Words written" />
        </div>
        <div className="stats-row">
          <dt>Time left</dt>
          <dd className="num">{book.status === 'complete' ? 'Done' : left === null ? 'Estimating…' : `~${fmt.duration(left)}`}</dd>
        </div>
        <div className="stats-row">
          <dt>Model</dt>
          <dd className="truncate">{book.settings.model}</dd>
        </div>
        <SpeedSettings book={book} />
      </dl>

      <div className="tabs" role="tablist">
        {(
          [
            ['cast', 'Cast', book.entities.length],
            ['threads', 'Threads', open.length],
            ['bible', 'Bible', null],
            ['arcs', 'Arcs', book.arcs.length],
          ] as [Tab, string, number | null][]
        ).map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>
            {label}
            {!!n && <span className="tab-n num">{n}</span>}
          </button>
        ))}
      </div>

      <div className="tab-panel" role="tabpanel">
        {tab === 'cast' && <Cast book={book} />}
        {tab === 'threads' && <Threads book={book} />}
        {tab === 'bible' && <BibleView book={book} />}
        {tab === 'arcs' && <Arcs book={book} />}
      </div>
    </aside>
  )
}

const KINDS: [string, string][] = [
  ['character', 'Characters'],
  ['location', 'Places'],
  ['faction', 'Factions'],
  ['item', 'Items'],
]

function Cast({ book }: { book: Book }) {
  if (!book.entities.length) return <p className="muted">The cast appears once the story bible is written.</p>
  return (
    <>
      {KINDS.map(([kind, label]) => {
        const list = book.entities.filter(e => e.kind === kind)
        if (!list.length) return null
        return (
          <section key={kind} className="mem-group">
            <h3>{label}</h3>
            {list.map(e => (
              <details key={e.name} className="entity">
                <summary>
                  <span className="entity-name truncate">{e.name}</span>
                  <span className="entity-seen num">{e.last_chapter ? `ch ${e.last_chapter}` : 'bible'}</span>
                  {e.state && <span className="entity-state">{e.state}</span>}
                </summary>
                <Sheet text={e.sheet} />
              </details>
            ))}
          </section>
        )
      })}
    </>
  )
}

// Profiles arrive as "Key: value" lines; render them as a label/value grid.
function Sheet({ text }: { text: string }) {
  return (
    <dl className="entity-sheet">
      {text.split('\n').filter(l => l.trim()).map((line, i) => {
        const m = line.match(/^([^:]{1,24}):\s*(.+)$/)
        return m ? (
          <div key={i} style={{ display: 'contents' }}>
            <dt>{m[1]}</dt>
            <dd>{m[2]}</dd>
          </div>
        ) : (
          <dd key={i} className="entity-note">
            {line}
          </dd>
        )
      })}
    </dl>
  )
}

function Threads({ book }: { book: Book }) {
  const open = book.threads.filter(t => t.status === 'open')
  const done = book.threads.filter(t => t.status === 'resolved')
  if (!book.threads.length) return <p className="muted">Open questions and foreshadowing show up here as chapters are written.</p>
  return (
    <>
      <section className="mem-group">
        <h3>
          Open <span className="num muted">{open.length}</span>
        </h3>
        {open.map(t => (
          <div key={t.id} className="thread">
            <p>{t.text}</p>
            <span className="thread-meta num">since ch {t.chapter}</span>
          </div>
        ))}
      </section>
      {!!done.length && (
        <section className="mem-group">
          <h3>
            Resolved <span className="num muted">{done.length}</span>
          </h3>
          {done.map(t => (
            <div key={t.id} className="thread thread-done">
              <p>{t.text}</p>
              <span className="thread-meta num">
                ch {t.chapter} → {t.resolved_in}
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  )
}

function BibleView({ book }: { book: Book }) {
  const b = book.bible
  if (!b) return <p className="muted">Kaizer is still building the story bible.</p>
  return (
    <div className="bible">
      <p className="bible-logline">{b.logline}</p>
      <h3>World</h3>
      <p>{b.world}</p>
      {b.power_system && b.power_system.toLowerCase() !== 'none' && (
        <>
          <h3>Power system</h3>
          <p>{b.power_system}</p>
        </>
      )}
      <h3>Hard rules</h3>
      <ul>
        {b.rules.map(r => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {!!b.themes.length && (
        <>
          <h3>Themes</h3>
          <p>{b.themes.join(', ')}</p>
        </>
      )}
      {!!b.glossary.length && (
        <>
          <h3>Glossary</h3>
          <dl className="glossary">
            {b.glossary.map(g => (
              <div key={g.term}>
                <dt>{g.term}</dt>
                <dd>{g.meaning}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  )
}

function Arcs({ book }: { book: Book }) {
  if (!book.arcs.length) return <p className="muted">The arc outline comes right after the story bible.</p>
  return (
    <ol className="arcs">
      {book.arcs.map(a => {
        const done = book.chapters.filter(c => c.arc_idx === a.idx && c.status === 'done').length
        return (
          <li key={a.idx} className={a.synopsis ? 'arc-done' : undefined}>
            <div className="arc-title">
              <span className="truncate">{a.title}</span>
              <span className="num muted">
                {done}/{a.chapter_count}
              </span>
            </div>
            <p>{a.synopsis ?? a.goal}</p>
          </li>
        )
      })}
    </ol>
  )
}

const ISSUES: [Issue['status'], string][] = [
  ['open', 'To repair'],
  ['unfixed', 'Could not repair'],
  ['fixed', 'Repaired'],
  ['kept', 'Checked again, nothing to change'],
  ['noted', 'Minor, left as written'],
]

// The proofreader at a glance: how far the re-read has got, what it found, and what became of each finding.
function ProofBoard({ book, onPick, onStart }: { book: Book; onPick: (idx: number) => void; onStart: () => void }) {
  const written = book.chapters.filter(c => c.status === 'done')
  const checked = written.filter(c => c.proofed).length
  const n = (status: Issue['status']) => book.issues.filter(i => i.status === status).length
  const flagged = n('open') + n('fixed') + n('unfixed') + n('kept')
  const writing = !book.arcs.length || book.arcs.some(a => !a.synopsis)
  const audited = !writing && checked === written.length
  const title = writing
    ? 'Proofreading starts when the last chapter is written.'
    : book.status === 'running'
      ? (book.phase ?? 'Starting…')
      : book.status === 'complete'
        ? book.proofed ? 'Proofreading is done.' : 'This book has not been proofread yet.'
        : book.status === 'paused' ? 'Proofreading is paused.' : book.status === 'waiting' ? 'Proofreading is waiting to continue.' : 'Proofreading stopped.'
  // A finished book has no step in progress, whatever is left undone.
  const at = (done: boolean, now: boolean) => (done ? 'done' : now && book.status !== 'complete' ? 'now' : 'next')
  const steps: [string, string, 'done' | 'now' | 'next'][] = [
    ['Check every chapter against the whole story', `${checked} / ${written.length}`, at(audited, !writing)],
    ['Repair what was flagged, passage by passage', flagged ? `${n('fixed') + n('kept')} / ${flagged}` : '', at(audited && !n('open'), n('open') > 0)],
    ['Judge the loose ends and the ending', '', at(!!book.proofed, audited && !n('open'))],
  ]
  return (
    <div className="doc">
      <div className="pipeline">
        <h2>{title}</h2>
        <p className="muted">
          {writing
            ? 'The whole book is then re-read against the full story, and contradictions, plot holes, and loose ends are repaired.'
            : book.proofed
              ? proofSummary(book)
              : `${checked} of ${written.length} chapters checked.`}
        </p>
        <div className="proof-bar">
          <Bar value={checked} max={written.length} label="Chapters proofread" />
        </div>
        <InkRepairs book={book} />
        <ol className="pipeline-steps">
          {steps.map(([label, count, state]) => (
            <li key={label} className={`step-${state}`}>
              {state === 'now' && book.status !== 'running' ? <BookGlyph status={book.status} /> : <ChapterGlyph state={state === 'done' ? 'done' : state === 'now' ? 'writing' : 'planned'} />}
              {label}
              <span className="step-n num">{count}</span>
            </li>
          ))}
        </ol>
        {/* Any time the book is written and nothing is at work on it: from the start, or once more. */}
        {!writing && book.status !== 'running' && book.status !== 'waiting' && (
          <div className="pipeline-actions">
            <button className="btn btn-primary" onClick={onStart}>
              <SpellCheck size={15} strokeWidth={2} /> {book.proofed ? 'Proofread again' : 'Proofread now'}
            </button>
          </div>
        )}
        <Proof book={book} onPick={onPick} />
      </div>
    </div>
  )
}

// Whether Inkstone has the repaired text of every repaired chapter that is on it. The engine re-uploads them
// by itself; this says so, and says when it has not managed to.
function InkRepairs({ book }: { book: Book }) {
  const repaired = new Set(book.issues.filter(i => i.status === 'fixed').map(i => i.chapter))
  const on = book.inkstone ? book.chapters.filter(c => repaired.has(c.idx) && c.ink_state) : []
  if (!on.length) return null
  const refused = on.filter(c => c.ink_error).length
  const updating = on.filter(c => c.ink_stale && !c.ink_error).length
  const last = Math.max(0, ...on.map(c => c.ink_updated ?? 0))
  const n = (k: number) => `${k} repaired chapter${k === 1 ? '' : 's'}`
  return (
    <p className="ink-sync ink-sync-board" role="status">
      {refused ? (
        <>
          <BookGlyph status="error" /> Inkstone refused {n(refused)}; the Inkstone panel has the reason.
        </>
      ) : updating ? (
        <>
          <ChapterGlyph state="writing" /> Updating {n(updating)} on Inkstone…
        </>
      ) : (
        <>
          <ChapterGlyph state="done" /> Inkstone has the repaired text of all {n(on.length)}
          {last ? `, last updated ${fmt.ago(last)}` : ''}.
        </>
      )}
    </p>
  )
}

// What the proofreader found in the finished book, and what became of each finding.
// With `onPick` (the proofreading board), a finding also shows its fix and opens its chapter.
function Proof({ book, onPick }: { book: Book; onPick?: (idx: number) => void }) {
  if (!book.issues.length) return null
  return (
    <div className="pipeline-proof">
      {ISSUES.map(([status, label]) => {
        const list = book.issues.filter(i => i.status === status)
        if (!list.length) return null
        return (
          <section key={status} className="mem-group">
            <h3>
              {label} <span className="num muted">{list.length}</span>
              {status === 'noted' && book.status === 'complete' && (
                <button className="btn btn-sm proof-minor" title="Repair these as well, editing only the passages at fault" onClick={() => api.post(`/api/books/${book.id}/fix-minor`).catch(() => {})}>
                  <SpellCheck size={14} strokeWidth={1.75} /> Repair these too
                </button>
              )}
              {status === 'unfixed' && (
                <button className="btn btn-sm proof-minor" title="Check these chapters again and repair what still needs it" onClick={() => api.post(`/api/books/${book.id}/retry-unfixed`).catch(() => {})}>
                  <RotateCw size={14} strokeWidth={1.75} /> Try again
                </button>
              )}
            </h3>
            {list.map(i => (
              <div key={i.id} className={`thread${status === 'fixed' ? ' thread-done' : ''}`}>
                <p>{i.issue}</p>
                {onPick && i.fix && <p className="thread-fix">Fix: {i.fix}</p>}
                {onPick ? (
                  <button className="thread-meta thread-open num" onClick={() => onPick(i.chapter)}>
                    Open chapter {i.chapter}
                  </button>
                ) : (
                  <span className="thread-meta num">ch {i.chapter}</span>
                )}
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}
