import { useCallback, useEffect, useRef, useState } from 'react'

export type Status = 'running' | 'paused' | 'waiting' | 'error' | 'complete'

export type Settings = {
  title: string; premise: string; genre: string; tropes: string[]; pov: string; tense: string; tone: string
  language: string; rating: string; chapters: number; words: number; style: string; model: string
  reasoning?: string; fast?: boolean
  proofModel?: string; proofReasoning?: string // the proofreader's own model; unset → the writing model
}

// `fast` is the Fast tier's description ("1.5x speed, increased usage") or null when unavailable.
export type Model = { slug: string; name: string; efforts: string[]; defaultEffort: string | null; fast: string | null }
export const effortName = (e: string, m: Model) => `${e[0].toUpperCase()}${e.slice(1)}${e === m.defaultEffort ? ' (model default)' : ''}`
// Low is fastest; fall back to the model's default when it has no low.
export const pickEffort = (m: Model) => (m.efforts.includes('low') ? 'low' : m.defaultEffort ?? '')

export type BookSummary = {
  id: number; title: string; status: Status; phase: string | null; error: string | null; retry_at: number | null
  settings: Settings; proofed: number; created_at: number; updated_at: number; done: number; total: number; words: number
}

// Inkstone publishing. `ink_want` is what was asked for, `ink_state` what Inkstone holds now; `ink_stale` marks text rewritten since the upload,
// `ink_updated` when Inkstone last took a rewritten text in place of the old one.
export type InkStatus = { connected: boolean; expired: boolean; name: string }
export type InkConfig = { cbid: string; title: string; auto: 'off' | 'draft' | 'publish' | 'schedule'; every: number; start: number }
export type Chapter = {
  idx: number; arc_idx: number; title: string; pov: string; status: 'planned' | 'drafted' | 'done'; words: number; summary: string | null; done_at: number | null
  proofed: number // the proofreader has checked this text
  ink_want: 'draft' | 'publish' | 'delete' | null; ink_at: number | null; ink_state: 'draft' | 'scheduled' | 'published' | null; ink_error: string | null; ink_stale: number | null; ink_updated: number | null
  // Edits waiting for this chapter (`edits_asked` of them the author's), and whether it is still to be checked against a change.
  edits_queued: number; edits_asked: number; sweeping: number
}
export type Arc = { idx: number; title: string; goal: string; chapter_count: number; synopsis: string | null }
export type Entity = { kind: string; name: string; sheet: string; state: string; first_chapter: number; last_chapter: number }
export type Thread = { id: number; chapter: number; text: string; payoff: string; status: 'open' | 'resolved'; resolved_in: number | null }
export type Issue = { id: number; chapter: number; issue: string; fix: string; status: 'open' | 'fixed' | 'unfixed' | 'kept' | 'noted' }
export type Bible = {
  title: string; logline: string; synopsis: string; themes: string[]; world: string; rules: string[]
  power_system: string; glossary: { term: string; meaning: string }[]
}
// A change the author made: a request, or (`hand`) a chapter they rewrote themselves. `reply` is null until the engine
// takes it up; `effects` is what it then really did to the canon and the plan, and `fixes` the written chapters it
// edits. `undoable`: the book as it was before is still kept, from when `wrote` chapters were written.
export type Ask = {
  id: number; chapter: number | null; quote: string | null; text: string; reply: string | null; hand: number; undone: number; wrote: number | null; undoable: number
  effects: string[]; fixes: { chapter: number; status: Issue['status'] }[]
}
export type Book = BookSummary & { bible: Bible | null; inkstone: InkConfig | null; arcs: Arc[]; chapters: Chapter[]; entities: Entity[]; threads: Thread[]; issues: Issue[]; requests: Ask[] }
// What a chapter's last edit changed: paragraphs kept, added, or removed, and inside a rewritten one the words that went ('-') and came ('+').
export type Para = { kind: 'same' | 'add' | 'del'; text: string } | { kind: 'mod'; parts: ['=' | '+' | '-', string][] }
export type ChapterText = { idx: number; title: string; pov: string; text: string; words: number; status: string; diff: Para[] | null }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
  return body as T
}

export const api = {
  get: <T>(path: string) => req<T>(path),
  post: <T>(path: string, body?: unknown) =>
    req<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => req<T>(path, { method: 'DELETE' }),
}

export type Live = { idx: number; text: string } | null

// Book detail + live chapter stream. Deltas are buffered and flushed once per frame.
export function useBook(id: number) {
  const [book, setBook] = useState<Book | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<Live>(null)
  const buf = useRef<Live>(null)
  const frame = useRef(0)

  const refresh = useCallback(() => {
    api.get<Book>(`/api/books/${id}`).then(b => (setBook(b), setError(null)), e => setError(e.message))
  }, [id])

  useEffect(() => {
    setBook(null)
    setLive(null)
    buf.current = null
    refresh()
    let timer: number | undefined
    const flush = () => {
      frame.current = 0
      setLive(buf.current && { ...buf.current })
    }
    const es = new EventSource(`/api/books/${id}/events`)
    es.onmessage = m => {
      const ev = JSON.parse(m.data)
      if (ev.type === 'update') {
        clearTimeout(timer)
        timer = window.setTimeout(refresh, 250)
      } else if (ev.type === 'live') {
        buf.current = { idx: ev.idx, text: ev.text }
        flush()
      } else if (ev.type === 'idle') {
        // The chapter being written was dropped for a change by the author; it is written again after.
        buf.current = null
        flush()
      } else if (ev.type === 'delta') {
        const cur = buf.current
        if (!cur || cur.idx !== ev.idx) return
        cur.text += ev.delta
        frame.current ||= requestAnimationFrame(flush)
      }
    }
    es.onopen = refresh // catch up after reconnects
    return () => {
      es.close()
      clearTimeout(timer)
      cancelAnimationFrame(frame.current)
    }
  }, [id, refresh])

  return { book, live, error, refresh }
}

export function useNow(intervalMs: number, enabled = true) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs, enabled])
  return now
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
export function countWords(s: string) {
  let n = 0
  for (const x of segmenter.segment(s)) if (x.isWordLike) n++
  return n
}

export const fmt = {
  num: (n: number) => n.toLocaleString(),
  duration(ms: number) {
    const m = Math.max(0, Math.round(ms / 60_000))
    if (m < 1) return 'under a minute'
    if (m < 60) return `${m} min`
    const h = Math.floor(m / 60)
    return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)} days`
  },
  clock(ms: number) {
    const s = Math.max(0, Math.ceil(ms / 1000))
    const h = Math.floor(s / 3600)
    const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0')
    const ss = String(s % 60).padStart(2, '0')
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
  },
  ago(t: number, now = Date.now()) {
    const m = Math.round((now - t) / 60_000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.round(m / 60)
    return h < 24 ? `${h}h ago` : new Date(t).toLocaleDateString()
  },
}

// Average pace over the last few finished chapters → time left.
export function eta(chapters: Chapter[], total: number) {
  const done = chapters.filter(c => c.done_at).map(c => c.done_at!).sort((a, b) => a - b).slice(-7)
  if (done.length < 2) return null
  const pace = (done.at(-1)! - done[0]) / (done.length - 1)
  return pace * Math.max(0, total - chapters.filter(c => c.status === 'done').length)
}

export const storage = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem(k)
      return v === null ? fallback : (JSON.parse(v) as T)
    } catch {
      return fallback
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {}
  },
}
