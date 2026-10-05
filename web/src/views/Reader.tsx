import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Minus, PenLine, Plus, Type } from 'lucide-react'
import { api, storage, useBook, type ChapterText } from '../api'
import { Menu } from '../ui'
import { Body, ChangeThis, Direct, type Quote } from '../direct'

type Prefs = { size: number; width: 'narrow' | 'medium' | 'wide'; theme: 'auto' | 'light' | 'paper' | 'dark'; font: 'serif' | 'sans' }
const DEFAULTS: Prefs = { size: 19, width: 'medium', theme: 'auto', font: 'serif' }

export function Reader({ bookId, idx }: { bookId: number; idx: number }) {
  const { book } = useBook(bookId)
  const [chapter, setChapter] = useState<ChapterText | null>(null)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [asking, setAsking] = useState(false) // the request box is docked under the page
  const page = useRef<HTMLElement>(null)
  const at = useRef(idx)
  at.current = idx
  const [missing, setMissing] = useState(false)
  const [prefs, setPrefs] = useState<Prefs>(() => ({ ...DEFAULTS, ...storage.get('kaizer.reader', {}) }))
  const [progress, setProgress] = useState(0)
  const cache = useRef(new Map<number, ChapterText>())
  const saved = useRef(storage.get<{ idx: number; y: number } | null>(`kaizer.read.${bookId}`, null))

  useEffect(() => storage.set('kaizer.reader', prefs), [prefs])

  const load = (i: number) =>
    cache.current.get(i) ? Promise.resolve(cache.current.get(i)!) : api.get<ChapterText>(`/api/books/${bookId}/chapters/${i}`).then(c => (cache.current.set(i, c), c))

  const written = book?.chapters.filter(c => c.status !== 'planned') ?? []
  const pos = written.findIndex(c => c.idx === idx)
  const prev = pos > 0 ? written[pos - 1] : undefined
  const next = pos >= 0 ? written[pos + 1] : undefined

  useEffect(() => {
    let off = false
    setMissing(false)
    load(idx).then(
      c => {
        if (off) return
        setChapter(c)
        const s = saved.current
        requestAnimationFrame(() => {
          const max = document.documentElement.scrollHeight - innerHeight
          scrollTo({ top: s?.idx === idx ? s.y * max : 0 })
        })
      },
      () => !off && setMissing(true),
    )
    return () => {
      off = true
    }
  }, [bookId, idx])

  // A change the author asked for rewrites chapters: drop what was loaded and show this one as it stands now.
  useEffect(() => {
    if (!book) return
    cache.current.clear()
    load(idx).then(c => c.idx === at.current && setChapter(c), () => {})
  }, [book?.updated_at])

  // Preload the next chapter so "Next" is instant.
  useEffect(() => {
    if (next) load(next.idx).catch(() => {})
  }, [next?.idx])

  useEffect(() => {
    let t = 0
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - innerHeight
      const y = max > 0 ? scrollY / max : 0
      setProgress(y)
      clearTimeout(t)
      t = window.setTimeout(() => storage.set(`kaizer.read.${bookId}`, (saved.current = { idx, y })), 300)
    }
    addEventListener('scroll', onScroll, { passive: true })
    return () => (removeEventListener('scroll', onScroll), clearTimeout(t))
  }, [bookId, idx])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, select, textarea')) return
      if (e.key === 'ArrowLeft' && prev) location.hash = `#/book/${bookId}/read/${prev.idx}`
      if (e.key === 'ArrowRight' && next) location.hash = `#/book/${bookId}/read/${next.idx}`
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [prev?.idx, next?.idx, bookId])

  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs(p => ({ ...p, [k]: v }))
  const upcoming = book?.chapters.find(c => c.idx === idx + 1)

  return (
    <div className="reader" data-reader-theme={prefs.theme} data-font={prefs.font} data-width={prefs.width} style={{ ['--reader-size' as string]: `${prefs.size}px` }}>
      <div className="reader-progress" style={{ transform: `scaleX(${progress})` }} />
      <header className="reader-bar">
        <a className="icon-btn" href={`#/book/${bookId}`} aria-label="Back to book">
          <ArrowLeft size={18} strokeWidth={1.75} />
        </a>
        <div className="reader-title truncate">{book?.title}</div>
        {written.length > 0 && (
          <select className="input reader-select" aria-label="Chapter" value={idx} onChange={e => (location.hash = `#/book/${bookId}/read/${e.target.value}`)}>
            {written.map(c => (
              <option key={c.idx} value={c.idx}>
                {c.idx}. {c.title}
              </option>
            ))}
          </select>
        )}
        <button className="icon-btn" aria-label="Ask for a change" title="Ask for a change" aria-pressed={asking} onClick={() => setAsking(a => !a)}>
          <PenLine size={16} strokeWidth={1.75} />
        </button>
        <Menu label="" ariaLabel="Reading settings" icon={<Type size={16} strokeWidth={1.75} />}>
          {() => (
            <div className="reader-prefs">
              <div className="pref">
                <span>Size</span>
                <div className="seg">
                  <button aria-label="Smaller text" onClick={() => set('size', Math.max(14, prefs.size - 1))}>
                    <Minus size={14} strokeWidth={2} />
                  </button>
                  <span className="num">{prefs.size}</span>
                  <button aria-label="Larger text" onClick={() => set('size', Math.min(28, prefs.size + 1))}>
                    <Plus size={14} strokeWidth={2} />
                  </button>
                </div>
              </div>
              <Pref label="Width" value={prefs.width} options={['narrow', 'medium', 'wide']} onPick={v => set('width', v)} />
              <Pref label="Font" value={prefs.font} options={['serif', 'sans']} onPick={v => set('font', v)} />
              <Pref label="Theme" value={prefs.theme} options={['auto', 'light', 'paper', 'dark']} onPick={v => set('theme', v)} />
            </div>
          )}
        </Menu>
      </header>

      <main className="reader-page" ref={page}>
        <ChangeThis root={page} chapter={chapter?.idx} onQuote={q => (setQuote(q), setAsking(true))} />
        {missing ? (
          <p className="reader-note">This chapter hasn't been written yet.</p>
        ) : chapter ? (
          <article key={chapter.idx}>
            <header className="reader-heading">
              <h1>
                <span className="chapter-n-block">{chapter.idx}</span>
                {chapter.title}
              </h1>
            </header>
            <Body bookId={bookId} chapter={chapter} onSeen={() => (cache.current.delete(chapter.idx), setChapter({ ...chapter, diff: null }))} ink={book?.chapters.find(c => c.idx === chapter.idx)} />
          </article>
        ) : (
          <div aria-busy="true" className="reader-loading" />
        )}

        {chapter && (
          <nav className="reader-nav" aria-label="Chapter navigation">
            {prev ? (
              <a className="reader-nav-prev" href={`#/book/${bookId}/read/${prev.idx}`}>
                <ChevronLeft size={16} strokeWidth={1.75} /> Previous
              </a>
            ) : (
              <span />
            )}
            {next ? (
              <a className="reader-next" href={`#/book/${bookId}/read/${next.idx}`}>
                <span className="reader-next-label">Next · Chapter {next.idx}</span>
                <span className="reader-next-title">
                  {next.title} <ChevronRight size={18} strokeWidth={1.75} />
                </span>
              </a>
            ) : (
              <span className="reader-end">
                {book?.status === 'complete' ? 'The end.' : upcoming ? `Chapter ${upcoming.idx} is on its way.` : 'More chapters are on the way.'}
              </span>
            )}
          </nav>
        )}
      </main>
      {book && (
        <div className="reader-direct">
          <Direct book={book} quote={quote} onQuote={setQuote} viewing={chapter?.idx} onOpen={i => (location.hash = `#/book/${bookId}/read/${i}`)} shown={asking} onShow={setAsking} />
        </div>
      )}
    </div>
  )
}

function Pref<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: T[]; onPick: (v: T) => void }) {
  return (
    <div className="pref">
      <span>{label}</span>
      <div className="seg">
        {options.map(o => (
          <button key={o} aria-pressed={value === o} className={value === o ? 'on' : undefined} onClick={() => onPick(o)}>
            {o[0].toUpperCase() + o.slice(1)}
          </button>
        ))}
      </div>
    </div>
  )
}
