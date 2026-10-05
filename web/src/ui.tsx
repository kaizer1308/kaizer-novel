import { Fragment, memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Para, Status } from './api'

const STATUS: Record<Status, string> = {
  running: 'Writing',
  paused: 'Paused',
  waiting: 'Waiting',
  error: 'Needs attention',
  complete: 'Complete',
}

// Linear-style status glyphs drawn as SVG so they share one stroke and size.
export function BookGlyph({ status, size = 14 }: { status: Status; size?: number }) {
  const c = `glyph glyph-${status}`
  return (
    <svg className={c} width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      {status === 'running' && (
        <>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path className="glyph-sweep" d="M7 7 V3 A4 4 0 0 1 11 7 Z" fill="currentColor" />
        </>
      )}
      {status === 'paused' && (
        <>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.5 5v4M8.5 5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
      {status === 'waiting' && (
        <>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 4.5V7l1.75 1.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {status === 'error' && (
        <>
          <circle cx="7" cy="7" r="6.25" fill="currentColor" />
          <path d="M7 4v3.5" stroke="var(--glyph-ink)" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="7" cy="10" r=".9" fill="var(--glyph-ink)" />
        </>
      )}
      {status === 'complete' && (
        <>
          <circle cx="7" cy="7" r="6.25" fill="currentColor" />
          <path d="M4.5 7.2 6.3 9l3.2-3.6" fill="none" stroke="var(--glyph-ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  )
}

export type ChapterState = 'planned' | 'writing' | 'drafted' | 'done'

export function ChapterGlyph({ state }: { state: ChapterState }) {
  return (
    <svg className={`glyph chapter-${state}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {state === 'planned' && <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.1" />}
      {state === 'writing' && (
        <>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path className="glyph-sweep" d="M7 7 V3 A4 4 0 0 1 11 7 Z" fill="currentColor" />
        </>
      )}
      {state === 'drafted' && (
        <>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 7 V3 A4 4 0 1 1 3 7 Z" fill="currentColor" />
        </>
      )}
      {state === 'done' && (
        <>
          <circle cx="7" cy="7" r="6.25" fill="currentColor" />
          <path d="M4.5 7.2 6.3 9l3.2-3.6" fill="none" stroke="var(--glyph-ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  )
}

export function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`pill pill-${status}`}>
      <BookGlyph status={status} size={12} />
      {STATUS[status]}
    </span>
  )
}

export const statusLabel = (s: Status) => STATUS[s]

export function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div className="bar-fill" style={{ transform: `scaleX(${pct / 100})` }} />
    </div>
  )
}

// Dropdown menu: button + popover, closes on outside click or Escape.
export function Menu({ label, icon, children, align = 'end', ariaLabel }: { label: string; icon?: ReactNode; children: (close: () => void) => ReactNode; align?: 'start' | 'end'; ariaLabel?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="menu" ref={ref}>
      <button className="btn" aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {icon}
        {label}
        <ChevronDown size={14} strokeWidth={1.75} className="btn-chevron" />
      </button>
      {open && (
        <div className={`menu-pop menu-${align}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

// Chapter prose: paragraphs, *italics*, and [system window] lines. Built as elements, never HTML strings.
// Memoized: pages around it re-render with every frame of live text.
export const Prose = memo(function Prose({ text, caret = false }: { text: string; caret?: boolean }) {
  const paras = text.split(/\n+/).filter(p => p.trim())
  return (
    <div className="prose">
      {paras.map((p, i) => {
        const last = caret && i === paras.length - 1
        const t = p.trim()
        const sys = /^\[.*\]$/.test(t)
        return (
          <p key={i} className={sys ? 'prose-system' : undefined}>
            {inline(t)}
            {last && <span className="caret" aria-hidden="true" />}
          </p>
        )
      })}
      {caret && !paras.length && (
        <p>
          <span className="caret" aria-hidden="true" />
        </p>
      )}
    </div>
  )
})

function inline(s: string) {
  return s.split(/(\*[^*\n]+\*)/g).map((part, i) =>
    part.length > 2 && part.startsWith('*') && part.endsWith('*') ? <em key={i}>{part.slice(1, -1)}</em> : <Fragment key={i}>{part}</Fragment>,
  )
}

// A chapter with its last edit shown in place: text that came is marked, text that went is struck through.
export function Diff({ paras }: { paras: Para[] }) {
  return (
    <div className="prose">
      {paras.map((p, i) => {
        const now = p.kind === 'mod' ? p.parts.filter(([op]) => op !== '-').map(([, s]) => s).join('') : p.text
        return (
          <p key={i} className={/^\[.*\]$/.test(now.trim()) ? 'prose-system' : undefined}>
            {p.kind === 'mod' ? rewritten(p.parts) : p.kind === 'add' ? <ins>{inline(p.text)}</ins> : p.kind === 'del' ? <del>{inline(p.text)}</del> : inline(p.text)}
          </p>
        )
      })}
    </div>
  )
}

// Italics are paired within the old text and within the new one, and an edit can cut across either, so each
// side keeps its own state: kept and added text follow the new text's asterisks, removed text the old one's.
function rewritten(parts: ['=' | '+' | '-', string][]) {
  let emNew = false
  let emOld = false
  return parts.flatMap(([op, s], i) =>
    s.split('*').map((piece, k) => {
      if (k > 0) {
        if (op !== '-') emNew = !emNew
        if (op !== '+') emOld = !emOld
      }
      const text = (op === '-' ? emOld : emNew) ? <em>{piece}</em> : piece
      return piece ? op === '+' ? <ins key={`${i}.${k}`}>{text}</ins> : op === '-' ? <del key={`${i}.${k}`}>{text}</del> : <Fragment key={`${i}.${k}`}>{text}</Fragment> : null
    }),
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  )
}

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <path d="M10 8v16M10 16.5 20 8M13.5 13.5 21 24" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
