import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ExternalLink, RotateCw, TriangleAlert } from 'lucide-react'
import { api, fmt, type Book, type Chapter, type InkConfig, type InkStatus } from '../api'
import { BookGlyph, ChapterGlyph } from '../ui'

const SITE = 'https://inkstone.webnovel.com'
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
// <input type="datetime-local"> speaks local wall time with no zone.
const toInput = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
const tomorrow = () => toInput(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 86_400_000)
const plural = (n: number) => `${n} chapter${n === 1 ? '' : 's'}`

export function Inkstone({ book }: { book: Book }) {
  const [status, setStatus] = useState<InkStatus | null>(null)
  // The book refetches whenever the server touches it, which is also when a session can turn out to have expired.
  useEffect(() => {
    api.get<InkStatus>('/api/inkstone').then(setStatus, () => {})
  }, [book])
  const disconnect = async () => {
    if (!confirm('Disconnect Inkstone? Kaizer forgets the session. Chapters already on Inkstone stay there.')) return
    await api.post('/api/inkstone/disconnect').catch(() => {})
    setStatus({ connected: false, expired: false, name: '' })
  }

  return (
    <div className="doc">
      <div className="ink">
        <h2>Webnovel Inkstone</h2>
        {status?.connected && (
          <p className="ink-row">
            Connected as {status.name}.
            <button className="btn btn-ghost btn-sm" onClick={disconnect}>
              Disconnect
            </button>
          </p>
        )}
        {status && !status.connected && <Connect expired={status.expired} onDone={setStatus} />}
        {status?.connected && !book.inkstone && <LinkNovel book={book} />}
        {book.inkstone && <Publish book={book} cfg={book.inkstone} />}
      </div>
    </div>
  )
}

function Connect({ expired, onDone }: { expired: boolean; onDone: (s: InkStatus) => void }) {
  const [cookie, setCookie] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onDone(await api.post<InkStatus>('/api/inkstone/connect', { cookie, ua: navigator.userAgent }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="ink-section" onSubmit={submit}>
      <p>
        {expired
          ? 'The Inkstone session expired. Connect again and the queued chapters carry on.'
          : 'Upload chapters to your novel on Inkstone as drafts, publish them, or put them on a release schedule. Inkstone has no sign-in for other apps, so Kaizer uses the session of your browser.'}
      </p>
      <ol className="ink-steps">
        <li>
          Open{' '}
          <a className="ink-link" href={SITE} target="_blank" rel="noreferrer">
            inkstone.webnovel.com
          </a>{' '}
          in this browser and sign in.
        </li>
        <li>Press F12, choose the Network tab, and reload the page.</li>
        <li>Select any request to inkstone.webnovel.com and copy the value of “cookie” under Request Headers.</li>
      </ol>
      <label className="field">
        <span className="label">Cookie</span>
        <textarea className="input textarea" rows={4} value={cookie} onChange={e => setCookie(e.target.value)} placeholder="uid=…; ukey=…; inkstone_auth_token=…" spellCheck={false} />
      </label>
      <p className="muted">It is stored only on this computer, in data/kaizer.db. Whoever holds it can act as you on Webnovel, so keep that file private.</p>
      <div className="ink-row">
        <button className="btn" disabled={busy || !cookie.trim()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  )
}

function LinkNovel({ book }: { book: Book }) {
  const [novels, setNovels] = useState<{ cbid: string; title: string }[] | null>(null)
  const [cbid, setCbid] = useState('')
  const [error, setError] = useState('')
  const load = () => {
    setError('')
    api.get<{ cbid: string; title: string }[]>('/api/inkstone/novels').then(
      list => {
        setNovels(list)
        setCbid((list.find(n => n.title.toLowerCase() === book.title.toLowerCase()) ?? list[0])?.cbid ?? '')
      },
      e => setError(e.message),
    )
  }
  useEffect(load, [book.id])
  const link = () =>
    api.post(`/api/books/${book.id}/inkstone`, { cbid, title: novels?.find(n => n.cbid === cbid)?.title, auto: 'off' }).catch(e => setError(e.message))

  return (
    <section className="ink-section">
      <h3>Which novel is this?</h3>
      {novels?.length === 0 ? (
        <p>This account has no novels yet. Create one on Inkstone with its title, genre, and cover, then reload the list.</p>
      ) : (
        <p>Kaizer uploads chapters into a novel that already exists on Inkstone.</p>
      )}
      <div className="ink-row">
        {!!novels?.length && (
          <>
            <select className="input" aria-label="Inkstone novel" value={cbid} onChange={e => setCbid(e.target.value)}>
              {novels.map(n => (
                <option key={n.cbid} value={n.cbid}>
                  {n.title}
                </option>
              ))}
            </select>
            <button className="btn" disabled={!cbid} onClick={link}>
              Link
            </button>
          </>
        )}
        <a className="btn" href={`${SITE}/novels/create`} target="_blank" rel="noreferrer">
          <ExternalLink size={15} strokeWidth={1.75} /> Create on Inkstone
        </a>
        <button className="btn btn-ghost" onClick={load}>
          <RotateCw size={14} strokeWidth={1.75} /> Reload list
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

type Action = 'draft' | 'publish' | 'schedule' | 'delete'

function Publish({ book, cfg }: { book: Book; cfg: InkConfig }) {
  const post = (path: string, body: unknown) => api.post(`/api/books/${book.id}/inkstone${path}`, body)
  const [error, setError] = useState('')
  const fail = (e: Error) => setError(e.message)
  const chapters = book.chapters.filter(c => c.status === 'done')
  const fresh = chapters.filter(c => !c.ink_want).length

  // Automation: a draft of the form, saved on demand because it can publish.
  const [auto, setAuto] = useState(cfg.auto)
  const [start, setStart] = useState(() => (cfg.auto === 'schedule' ? toInput(cfg.start) : tomorrow()))
  const [every, setEvery] = useState(cfg.every)
  const dirty = auto !== cfg.auto || (auto === 'schedule' && (every !== cfg.every || start !== toInput(cfg.start)))
  const saveAuto = () => {
    if (fresh && (auto === 'publish' || auto === 'schedule') && !confirm(`${plural(fresh)} already finished will be ${auto === 'publish' ? 'published on Webnovel right away' : 'scheduled for release on Webnovel'}, and so will every chapter after. Continue?`)) return
    post('', { ...cfg, auto, every, start: new Date(start).getTime() }).then(() => setError(''), fail)
  }
  const unlink = () => {
    if (confirm(`Unlink from “${cfg.title}”? Chapters already on Inkstone stay there, but Kaizer forgets which is which.`)) post('', {}).catch(fail)
  }

  // Chapter control: pick chapters, pick what should happen to them.
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [action, setAction] = useState<Action>('draft')
  const [at, setAt] = useState(tomorrow)
  const [gap, setGap] = useState(24)
  const free = chapters.filter(c => c.ink_state !== 'published')
  const picked = free.filter(c => sel.has(c.idx)).map(c => c.idx)
  const toggle = (idx: number) => setSel(s => (s.has(idx) ? new Set([...s].filter(i => i !== idx)) : new Set(s).add(idx)))
  const apply = () => {
    const n = plural(picked.length)
    if (action === 'publish' && !confirm(`Publish ${n} on Webnovel now? Readers see them at once.`)) return
    if (action === 'delete' && !confirm(`Remove ${n} from Inkstone? The drafts move to Inkstone's trash.`)) return
    post('/chapters', action === 'schedule' ? { want: 'publish', idxs: picked, at: new Date(at).getTime(), every: gap } : { want: action, idxs: picked }).then(() => (setSel(new Set()), setError('')), fail)
  }
  const failed = chapters.find(c => c.ink_error)

  return (
    <>
      <section className="ink-section">
        <div className="ink-row">
          <h3>
            <a className="ink-link" href={`${SITE}/novels/view/${cfg.cbid}`} target="_blank" rel="noreferrer">
              {cfg.title || 'Linked novel'} <ExternalLink size={13} strokeWidth={1.75} />
            </a>
          </h3>
          <button className="btn btn-ghost btn-sm" onClick={unlink}>
            Unlink
          </button>
        </div>
        <label className="field">
          <span className="label">When a chapter is finished</span>
          <select className="input" value={auto} onChange={e => setAuto(e.target.value as InkConfig['auto'])}>
            <option value="off">Do nothing</option>
            <option value="draft">Upload it as a draft</option>
            <option value="publish">Publish it right away</option>
            <option value="schedule">Publish it on a schedule</option>
          </select>
        </label>
        {auto === 'schedule' && <Timing label="First release" at={start} setAt={setStart} gap={every} setGap={setEvery} />}
        {auto !== 'off' && (
          <p className="muted">
            Covers finished chapters that are not on Inkstone yet, then each new one. If the proofreader rewrites a chapter later, its copy on Inkstone is updated too, published or not.
          </p>
        )}
        {dirty && (
          <div className="ink-row">
            <button className="btn" onClick={saveAuto}>
              Save
            </button>
          </div>
        )}
      </section>

      <section className="ink-section">
        <h3>Chapters</h3>
        {failed && (
          <div className="notice" role="alert">
            <TriangleAlert size={16} strokeWidth={1.75} />
            <span>
              Chapter {failed.idx} was refused: {failed.ink_error} Later chapters wait behind it.
            </span>
            <button className="btn btn-sm" onClick={() => post('/chapters', { retry: true }).catch(fail)}>
              <RotateCw size={14} strokeWidth={1.75} /> Retry
            </button>
          </div>
        )}
        {chapters.length ? (
          <>
            <div className="ink-row">
              <select className="input" aria-label="Action" value={action} onChange={e => setAction(e.target.value as Action)}>
                <option value="draft">Upload as drafts</option>
                <option value="publish">Publish now</option>
                <option value="schedule">Schedule</option>
                <option value="delete">Remove from Inkstone</option>
              </select>
              <button className="btn" disabled={!picked.length} onClick={apply}>
                Apply to {plural(picked.length)}
              </button>
            </div>
            {action === 'schedule' && <Timing label="First chapter" at={at} setAt={setAt} gap={gap} setGap={setGap} />}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <ul className="ink-list">
              <li className="ink-chapter ink-all">
                <input
                  type="checkbox"
                  aria-label="Select all chapters"
                  checked={!!free.length && picked.length === free.length}
                  onChange={e => setSel(new Set(e.target.checked ? free.map(c => c.idx) : []))}
                />
                <span className="muted num">
                  {picked.length} of {chapters.length} selected
                </span>
              </li>
              {chapters.map(c => {
                const [glyph, label] = inkState(c)
                return (
                  <li key={c.idx}>
                    <label className="ink-chapter">
                      <input type="checkbox" disabled={c.ink_state === 'published'} checked={sel.has(c.idx) && c.ink_state !== 'published'} onChange={() => toggle(c.idx)} />
                      <span className="truncate">
                        <span className="chapter-n num">{c.idx}</span> {c.title}
                      </span>
                      <span className="ink-state truncate" title={label}>
                        {glyph}
                        <span className="truncate">{label}</span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </>
        ) : (
          <p className="muted">Chapters show up here as they are finished.</p>
        )}
      </section>
    </>
  )
}

function Timing({ label, at, setAt, gap, setGap }: { label: string; at: string; setAt: (v: string) => void; gap: number; setGap: (n: number) => void }) {
  return (
    <div className="ink-row ink-fields">
      <label className="field">
        <span className="label">{label}</span>
        <input className="input" type="datetime-local" value={at} onChange={e => e.target.value && setAt(e.target.value)} />
      </label>
      <label className="field">
        <span className="label">
          Hours between chapters <span className="label-note">24 is one a day</span>
        </span>
        <input className="input num" type="number" min={1} max={720} value={gap} onChange={e => setGap(Math.min(720, Math.max(1, Math.round(Number(e.target.value)) || 1)))} />
      </label>
    </div>
  )
}

// Where a chapter stands on Inkstone, in the app's glyph vocabulary.
// A chapter rewritten after its upload says when Inkstone took the new text.
function inkState(c: Chapter): [ReactNode, string] {
  const busy = <ChapterGlyph state="writing" />
  const upd = c.ink_updated && !c.ink_stale ? `, updated ${fmt.ago(c.ink_updated)}` : ''
  if (c.ink_error) return [<BookGlyph status="error" />, 'Refused']
  if (!c.ink_want || c.ink_want === 'delete') return c.ink_state ? [busy, 'Removing'] : [<ChapterGlyph state="planned" />, 'Not on Inkstone']
  if (c.ink_state === 'published') return c.ink_stale ? [busy, 'Published, updating'] : [<ChapterGlyph state="done" />, `Published${upd}`]
  if (c.ink_want === 'draft') return c.ink_state === 'draft' && !c.ink_stale ? [<ChapterGlyph state="drafted" />, `Draft${upd}`] : [busy, c.ink_state ? 'Updating' : 'Uploading']
  if (!c.ink_at) return [busy, 'Publishing']
  if (c.ink_state === 'scheduled') return [<BookGlyph status="waiting" />, c.ink_stale ? `Scheduled, ${when(c.ink_at)}, updating` : `Scheduled, ${when(c.ink_at)}${upd}`]
  // Uploaded, but the date is further out than Inkstone accepts yet: Kaizer sets the timer once it is within reach.
  return c.ink_state === 'draft' ? [<BookGlyph status="waiting" />, `Draft, publishes ${when(c.ink_at)}`] : [busy, `Scheduling, ${when(c.ink_at)}`]
}
