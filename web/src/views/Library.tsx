import { Plus } from 'lucide-react'
import { fmt, useNow, type BookSummary } from '../api'
import { Bar, BookGlyph, Empty, statusLabel } from '../ui'

export function stateLine(b: BookSummary, now: number) {
  if (b.status === 'running') return b.phase ?? 'Starting…'
  if (b.status === 'waiting') return b.retry_at ? `Usage limit, resumes in ${fmt.duration(b.retry_at - now)}` : 'Waiting for ChatGPT sign-in'
  if (b.status === 'error') return b.error ?? 'Stopped'
  if (b.status === 'complete') return `Finished ${fmt.ago(b.updated_at, now)}`
  return `Paused ${fmt.ago(b.updated_at, now)}`
}

export function Library({ books }: { books: BookSummary[] | null }) {
  const now = useNow(30_000)
  return (
    <div className="page">
      <header className="page-head">
        <h1>Library</h1>
        {!!books?.length && (
          <a className="btn btn-primary" href="#/new">
            <Plus size={15} strokeWidth={2} /> New book
          </a>
        )}
      </header>
      {books && !books.length && (
        <Empty title="No books yet">
          <p>Give Kaizer a premise and it plans and writes the whole book, chapter by chapter, while you do something else.</p>
          <a className="btn btn-primary" href="#/new">
            <Plus size={15} strokeWidth={2} /> Start your first book
          </a>
        </Empty>
      )}
      {!!books?.length && (
        <ul className="library-list">
          {books.map(b => (
            <li key={b.id}>
              <a className={`book-row status-${b.status}`} href={`#/book/${b.id}`}>
                <span className="book-row-glyph" title={statusLabel(b.status)}>
                  <BookGlyph status={b.status} />
                </span>
                <span className="book-row-main">
                  <span className="book-row-title truncate">{b.title}</span>
                  <span className="book-row-sub truncate">
                    {[b.settings.genre, ...b.settings.tropes.slice(0, 3)].join(' · ')}
                  </span>
                </span>
                <span className="book-row-state truncate">{stateLine(b, now)}</span>
                <span className="book-row-progress">
                  <Bar value={b.done} max={b.total} label={`${b.done} of ${b.total} chapters`} />
                  <span className="num">
                    {b.done}/{b.total}
                  </span>
                </span>
                <span className="book-row-words num">{fmt.num(b.words)} words</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
