import { useEffect, useRef, useState, type RefObject } from 'react'
import { ArrowUp, ChevronDown, PenLine, X } from 'lucide-react'
import { api, fmt, storage, type Ask, type Book, type Chapter, type ChapterText } from './api'
import { BookGlyph, ChapterGlyph, Diff, Prose } from './ui'

// The author's line to the engine, shared by the book console and the reader: "Change this" on highlighted
// prose, the box that takes a request and shows what became of it, and a chapter's text with its last edit marked.

export type Quote = { chapter: number; text: string } // a passage the author highlighted to ask for a change

// "Change this" over prose highlighted inside `root`, the positioned box the button is placed in. It follows
// the selection itself rather than the pointer, so a mouse, the keyboard, and a touch screen's selection
// handles all work the same.
export function ChangeThis({ root, chapter, onQuote }: { root: RefObject<HTMLElement | null>; chapter: number | undefined; onQuote: (q: Quote) => void }) {
  const [pick, setPick] = useState<{ x: number; y: number; below: boolean; text: string } | null>(null)
  useEffect(() => {
    let t = 0
    const read = () => {
      const el = root.current
      const sel = getSelection()
      const text = sel?.toString().trim()
      const prose = el?.querySelector('.prose')
      if (!el || !sel || !text || !prose?.contains(sel.anchorNode) || !prose.contains(sel.focusNode)) return setPick(null)
      const r = sel.getRangeAt(0).getBoundingClientRect()
      const box = el.getBoundingClientRect()
      // Below the passage on a touch screen, which puts its own menu above it, and where the top edge leaves no room.
      const below = matchMedia('(pointer: coarse)').matches || r.top - Math.max(box.top, 0) < 56
      const x = Math.min(Math.max(r.left + r.width / 2 - box.left + el.scrollLeft, 70), el.clientWidth - 70)
      setPick({ x, y: (below ? r.bottom : r.top) - box.top + el.scrollTop, below, text })
    }
    // Once the selection has rested: it changes with every pixel of a drag.
    const onChange = () => (clearTimeout(t), (t = window.setTimeout(read, 300)))
    document.addEventListener('selectionchange', onChange)
    return () => (document.removeEventListener('selectionchange', onChange), clearTimeout(t))
  }, [root])

  if (!pick || chapter === undefined) return null
  return (
    <button
      className={`btn pick${pick.below ? ' pick-below' : ''}`}
      style={{ left: pick.x, top: pick.y }}
      onMouseDown={e => e.preventDefault()}
      onClick={() => (onQuote({ chapter, text: pick.text.slice(0, 2000) }), getSelection()?.removeAllRanges(), setPick(null))}
    >
      <PenLine size={14} strokeWidth={1.75} /> Change this
    </button>
  )
}

// Whether Inkstone has the chapter's latest text, for a chapter that is on it: the engine re-uploads an edited one
// by itself, and this is where the author sees that it did.
export function InkSync({ c }: { c?: Chapter }) {
  if (!c?.ink_state) return null
  if (c.ink_error)
    return (
      <span className="ink-sync ink-sync-error" title={c.ink_error}>
        <BookGlyph status="error" /> Inkstone refused the update
      </span>
    )
  if (c.ink_stale)
    return (
      <span className="ink-sync">
        <ChapterGlyph state="writing" /> Updating on Inkstone…
      </span>
    )
  return (
    <span className="ink-sync" title={c.ink_updated ? new Date(c.ink_updated).toLocaleString() : undefined}>
      <ChapterGlyph state="done" /> {c.ink_updated ? `Updated on Inkstone ${fmt.ago(c.ink_updated)}` : 'Up to date on Inkstone'}
    </span>
  )
}

// A chapter's text. After an edit, what it changed is marked in place until the author dismisses it:
// text that came is highlighted, text that went is struck through. `ink`: the chapter's row, for its Inkstone copy.
export function Body({ bookId, chapter, onSeen, ink }: { bookId: number; chapter: ChapterText; onSeen: () => void; ink?: Chapter }) {
  const [show, setShow] = useState(true)
  if (!chapter.diff) return <Prose text={chapter.text ?? ''} />
  const n = chapter.diff.filter(p => p.kind !== 'same').length
  return (
    <>
      <div className="changes">
        <span>
          {n} passage{n === 1 ? '' : 's'} changed since you last looked.
          <InkSync c={ink} />
        </span>
        <button className="btn btn-sm" aria-pressed={show} onClick={() => setShow(s => !s)}>
          {show ? 'Hide changes' : 'Show changes'}
        </button>
        <button className="btn btn-sm btn-ghost" title="Stop marking these changes" onClick={() => api.post(`/api/books/${bookId}/chapters/${chapter.idx}/seen`).then(onSeen, () => {})}>
          Dismiss
        </button>
      </div>
      {show ? <Diff paras={chapter.diff} /> : <Prose text={chapter.text ?? ''} />}
    </>
  )
}

// The engine at work on the author's changes, as its phase reads then.
const AT_WORK = /^(Working on your request|Revising chapter \d+ as you asked|Re-reading chapter \d+ after its edit|Checking the rest of the book)/

// One change and what became of it.
function AskRow({ book, ask, onOpen }: { book: Book; ask: Ask; onOpen: (chapter: number) => void }) {
  const first = book.requests.find(a => a.reply === null && !a.undone)
  const state = ask.undone
    ? 'Undone.'
    : (ask.reply ??
      (ask === first && book.phase === 'Working on your request'
        ? 'Working on it…'
        : book.status === 'waiting'
          ? `Queued until writing resumes. ${book.error ?? ''}`
          : book.status === 'error'
            ? `Could not be carried out: ${book.error ?? 'autopilot stopped.'} Resume tries again.`
            : 'Queued.'))
  const undo = () => {
    const since = book.chapters.filter(c => c.status !== 'planned').length - (ask.wrote ?? 0)
    const later = book.requests.filter(a => a.id > ask.id && a.undoable).length
    const lost = [since > 0 && `${since} chapter${since === 1 ? '' : 's'} written since, which will be written again`, later > 0 && `${later} later change${later === 1 ? '' : 's'}`].filter(Boolean)
    if (confirm(`Put the book back to how it was before this change?${lost.length ? ` Everything since goes with it: ${lost.join(', and ')}.` : ''}`))
      api.post(`/api/books/${book.id}/requests/${ask.id}/undo`).catch(e => alert((e as Error).message))
  }
  return (
    <div className={`ask${ask.undone ? ' ask-undone' : ''}`}>
      <p>
        {ask.quote && <q className="ask-quote">{ask.quote.length > 90 ? `${ask.quote.slice(0, 90)}…` : ask.quote}</q>} {ask.text}
      </p>
      <p className="ask-reply">
        {state}
        {ask.reply === null && !ask.hand && !ask.undone && (
          <button type="button" className="ask-act" onClick={() => api.del(`/api/books/${book.id}/requests/${ask.id}`).catch(() => {})}>
            Withdraw
          </button>
        )}
        {!!ask.undoable && (
          <button type="button" className="ask-act" title="Put the book back to how it was before this change" onClick={undo}>
            Undo
          </button>
        )}
      </p>
      {!ask.undone && ask.effects.length > 0 && <p className="ask-meta">{ask.effects.join(' · ')}</p>}
      {!ask.undone && ask.fixes.length > 0 && (
        <p className="ask-meta num">
          {ask.fixes.map((f, i) => (
            <span key={i}>
              {i > 0 && ' · '}
              {f.status === 'fixed' ? (
                <button type="button" className="ask-open" title="Open the chapter with the edit marked" onClick={() => onOpen(f.chapter)}>
                  Chapter {f.chapter} edited
                </button>
              ) : f.status === 'unfixed' ? (
                `Chapter ${f.chapter} could not be edited`
              ) : (
                `Chapter ${f.chapter} queued for its edit`
              )}
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

// Ask for a change to the book, or to a passage highlighted above. The engine drops what it is writing,
// carries the request out, and writes on. `viewing` is the chapter on screen, so "this chapter" means something.
// The box folds away: on its own into a slim bar that still says what the engine is doing with the author's
// changes, remembered across visits; or, given `shown`/`onShow` (the reader, which toggles it from its header),
// out of sight entirely.
export function Direct({ book, quote, onQuote, viewing, onOpen, shown: held, onShow }: {
  book: Book; quote: Quote | null; onQuote: (q: Quote | null) => void; viewing?: number; onOpen: (chapter: number) => void
  shown?: boolean; onShow?: (shown: boolean) => void
}) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [own, setOwn] = useState(() => !storage.get('kaizer.direct.hidden', false))
  const shown = held ?? own
  const show = (s: boolean) => (onShow ? onShow(s) : (setOwn(s), storage.set('kaizer.direct.hidden', !s)))
  const input = useRef<HTMLTextAreaElement>(null)
  const log = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLButtonElement>(null)
  // Focus waits for the box to be open: an inert field cannot take it.
  const wantFocus = useRef(false)
  // A passage highlighted for a change brings the box up.
  useEffect(() => {
    if (quote) (wantFocus.current = true), show(true)
  }, [quote])
  useEffect(() => {
    if (shown && wantFocus.current) (wantFocus.current = false), input.current?.focus({ preventScroll: true })
  }, [shown, quote])
  const hide = () => {
    show(false)
    requestAnimationFrame(() => bar.current?.focus({ preventScroll: true }))
  }
  // The newest change is the one being talked about: keep it in view. In braces: scrollTo returns a promise
  // in current Chrome, and React would take a returned value for the effect's cleanup.
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [open, book.requests.length])

  const send = async () => {
    const t = text.trim()
    if (!t) return
    setText('')
    setError(null)
    try {
      await api.post(`/api/books/${book.id}/requests`, { text: t, chapter: quote?.chapter ?? viewing, quote: quote?.text })
      onQuote(null)
    } catch (e) {
      setText(t)
      setError((e as Error).message)
    }
  }
  const working = AT_WORK.test(book.phase ?? '') && book.phase !== 'Working on your request'
  const busy = AT_WORK.test(book.phase ?? '')
  const queued = book.requests.filter(a => a.reply === null && !a.undone).length
  return (
    <div className={`direct${onShow ? ' direct-docked' : ''}`} data-shown={shown}>
      {!onShow && (
        <div className="direct-bar" inert={shown}>
          <button ref={bar} type="button" className="direct-open" aria-expanded={false} onClick={() => ((wantFocus.current = true), show(true))}>
            <PenLine size={15} strokeWidth={1.75} />
            <span className="direct-open-label">Ask for a change</span>
            {busy ? (
              <span className="direct-open-state truncate">
                <span className="live-dot" aria-hidden="true" /> {book.phase}…
              </span>
            ) : queued > 0 ? (
              <span className="direct-open-state num">{queued} queued</span>
            ) : null}
          </button>
        </div>
      )}
      <div className="direct-body" inert={!shown}>
        {/* The track's item carries no padding, so it can close all the way. */}
        <div>
          <form className="direct-form" onSubmit={e => (e.preventDefault(), send())}>
            {book.requests.length > 0 && (
              <div className="direct-log" ref={log}>
                {book.requests.length > 1 && (
                  <button type="button" className="direct-more" aria-expanded={open} onClick={() => setOpen(o => !o)}>
                    {open ? 'Show only the latest' : `Show all ${book.requests.length} changes`}
                  </button>
                )}
                {(open ? book.requests : book.requests.slice(-1)).map(a => (
                  <AskRow key={a.id} book={book} ask={a} onOpen={onOpen} />
                ))}
                {working && (
                  <p className="direct-now" role="status">
                    <span className="live-dot" aria-hidden="true" /> {book.phase}…
                  </p>
                )}
              </div>
            )}
            {quote && (
              <div className="direct-quote">
                <span className="num">Ch {quote.chapter}</span>
                <q>{quote.text}</q>
                <button type="button" className="icon-btn" aria-label="Remove the highlighted passage" onClick={() => onQuote(null)}>
                  <X size={14} strokeWidth={1.75} />
                </button>
              </div>
            )}
            {error && (
              <p className="direct-error" role="alert">
                {error}
              </p>
            )}
            <div className="direct-row">
              <textarea
                ref={input}
                className="input textarea direct-input"
                rows={1}
                aria-label="Ask for a change"
                placeholder={quote ? 'What should change in this passage?' : viewing ? `Ask about chapter ${viewing} or the whole book, or highlight a passage` : 'Ask for a change or ask about the story'}
                value={text}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), send())
                  // Escape lets go of the passage first, then folds the box away (a draft in it stays).
                  if (e.key === 'Escape') quote ? onQuote(null) : hide()
                }}
              />
              <button className="btn btn-primary" disabled={!text.trim()} aria-label="Send request">
                <ArrowUp size={15} strokeWidth={2} />
              </button>
              <button type="button" className="icon-btn direct-hide" aria-label="Hide the request box" title="Hide (Esc)" onClick={hide}>
                <ChevronDown size={16} strokeWidth={1.75} />
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
