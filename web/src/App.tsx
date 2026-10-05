import { useCallback, useEffect, useState } from 'react'
import { Clock, LibraryBig, LogOut, Menu as MenuIcon, Monitor, Moon, Plus, Sun, TriangleAlert, X } from 'lucide-react'
import { api, storage, type BookSummary } from './api'
import { BookGlyph, Logo, Menu } from './ui'
import { SignIn } from './views/SignIn'
import { Library } from './views/Library'
import { NewBook } from './views/NewBook'
import { BookView } from './views/Book'
import { Reader } from './views/Reader'

type Me = { signedIn: boolean; email?: string; name?: string; expiresAt?: number; renewable?: boolean }
type Theme = 'system' | 'light' | 'dark'

function useRoute() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  const [path, query = ''] = hash.replace(/^#/, '').split('?')
  return { path: path || '/', query: new URLSearchParams(query) }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => storage.get('kaizer.theme', 'system'))
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
    storage.set('kaizer.theme', theme)
  }, [theme])
  return [theme, setTheme] as const
}

export function App() {
  const { path, query } = useRoute()
  const [me, setMe] = useState<Me | null>(null)
  const [books, setBooks] = useState<BookSummary[] | null>(null)
  const [theme, setTheme] = useTheme()
  const [navOpen, setNavOpen] = useState(false)

  // Signed in at some point in this tab: a later sign-out shows a banner instead of replacing the page.
  const [seen, setSeen] = useState(false)

  const loadMe = useCallback(() => api.get<Me>('/api/me').then(setMe, () => setMe(m => m ?? { signedIn: false })), [])
  useEffect(() => {
    loadMe()
    const t = setInterval(loadMe, 30_000)
    addEventListener('focus', loadMe)
    return () => {
      clearInterval(t)
      removeEventListener('focus', loadMe)
    }
  }, [loadMe])
  useEffect(() => {
    if (me?.signedIn) setSeen(true)
  }, [me?.signedIn])

  const loadBooks = useCallback(() => api.get<BookSummary[]>('/api/books').then(setBooks, () => {}), [])
  useEffect(() => {
    if (!me?.signedIn && !seen) return
    loadBooks()
    const t = setInterval(loadBooks, 5000)
    return () => clearInterval(t)
  }, [me?.signedIn, seen, loadBooks, path])

  useEffect(() => setNavOpen(false), [path])

  if (!me) return null
  if (!me.signedIn && !seen) return <SignIn error={query.get('error')} />

  const read = path.match(/^\/book\/(\d+)\/read\/(\d+)$/)
  if (read) return <Reader bookId={Number(read[1])} idx={Number(read[2])} />

  const bookMatch = path.match(/^\/book\/(\d+)$/)
  const view = bookMatch ? (
    <BookView key={bookMatch[1]} id={Number(bookMatch[1])} onChange={loadBooks} />
  ) : path === '/new' ? (
    <NewBook onCreated={loadBooks} />
  ) : (
    <Library books={books} />
  )

  const signOut = async () => {
    await api.post('/api/logout').catch(() => {})
    setSeen(false)
    setMe({ signedIn: false })
  }

  // Sign-in in a popup that closes itself, so nothing on this page is lost.
  const renew = () => {
    const w = window.open('/auth/login?popup=1', 'kaizer-signin', 'width=520,height=720')
    if (!w) return void (location.href = '/auth/login')
    const t = setInterval(() => {
      if (!w.closed) return
      clearInterval(t)
      loadMe()
      loadBooks()
    }, 500)
  }
  // ChatGPT sign-ins last an hour. When this one cannot renew itself, offer a new one before a running book has to wait.
  const minutesLeft = me.expiresAt ? Math.max(0, Math.ceil((me.expiresAt - Date.now()) / 60_000)) : null
  const expiring = me.signedIn && me.renewable === false && minutesLeft !== null && minutesLeft <= 10 && !!books?.some(b => b.status === 'running')

  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
          <MenuIcon size={18} strokeWidth={1.75} />
        </button>
        <a href="#/" className="brand">
          <Logo size={18} /> Kaizer
        </a>
      </header>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar${navOpen ? ' open' : ''}`} aria-label="Navigation">
        <div className="sidebar-head">
          <a href="#/" className="brand">
            <Logo /> Kaizer
          </a>
          <button className="icon-btn sidebar-close" aria-label="Close navigation" onClick={() => setNavOpen(false)}>
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>
        <a className="btn btn-block" href="#/new">
          <Plus size={15} strokeWidth={2} /> New book
        </a>
        <nav className="nav">
          <a href="#/" className={`nav-item${path === '/' ? ' active' : ''}`}>
            <LibraryBig size={15} strokeWidth={1.75} /> Library
            {books && <span className="nav-meta">{books.length}</span>}
          </a>
        </nav>
        {!!books?.length && (
          <div className="nav-group">
            <div className="nav-group-label">Books</div>
            <ul className="nav-books">
              {books.map(b => (
                <li key={b.id}>
                  <a href={`#/book/${b.id}`} className={`nav-item${bookMatch?.[1] === String(b.id) ? ' active' : ''}`} title={b.title}>
                    <BookGlyph status={b.status} />
                    <span className="truncate">{b.title}</span>
                    <span className="nav-meta num">
                      {b.done}/{b.total}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="sidebar-foot">
          <div className="account truncate" title={me.email}>
            {me.name || me.email || 'Signed in'}
          </div>
          <Menu label="" ariaLabel={`Theme: ${theme}`} icon={<ThemeIcon size={15} strokeWidth={1.75} />} align="start">
            {close =>
              (['system', 'light', 'dark'] as Theme[]).map(t => (
                <button key={t} role="menuitemradio" aria-checked={theme === t} className="menu-item" onClick={() => (setTheme(t), close())}>
                  {t === 'system' ? <Monitor size={15} strokeWidth={1.75} /> : t === 'light' ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />}
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))
            }
          </Menu>
          <button className="icon-btn" aria-label="Sign out" title="Sign out" onClick={signOut}>
            <LogOut size={15} strokeWidth={1.75} />
          </button>
        </div>
      </aside>
      <main className="main">
        {(!me.signedIn || expiring) && (
          <div className={`banner ${me.signedIn ? 'banner-waiting' : 'banner-error'}`} role="status">
            {me.signedIn ? <Clock size={16} strokeWidth={1.75} /> : <TriangleAlert size={16} strokeWidth={1.75} />}
            <span>
              {me.signedIn
                ? `Your ChatGPT sign-in ends in ${minutesLeft} min. Renew it now and writing carries on without a pause.`
                : 'Signed out of ChatGPT. Writing is paused and picks up by itself once you sign in.'}
            </span>
            <button className="btn btn-sm" onClick={renew}>
              {me.signedIn ? 'Renew sign-in' : 'Sign in'}
            </button>
          </div>
        )}
        <div className="main-view">{view}</div>
      </main>
    </div>
  )
}
