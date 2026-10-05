import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'

mkdirSync('data', { recursive: true })
export const db = new DatabaseSync(process.env.KAIZER_DB ?? 'data/kaizer.db')

db.exec(`
pragma journal_mode = wal;
pragma foreign_keys = on;
create table if not exists kv (k text primary key, v text not null);
create table if not exists books (
  id integer primary key,
  title text not null,
  settings text not null,
  status text not null default 'running',
  phase text,
  error text,
  retry_at integer,
  limit_hits integer not null default 0,
  bible text,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists entities (
  id integer primary key,
  book_id integer not null references books on delete cascade,
  kind text not null,
  name text not null collate nocase,
  sheet text not null,
  state text not null default '',
  first_chapter integer not null default 0,
  last_chapter integer not null default 0,
  unique (book_id, name)
);
create table if not exists arcs (
  id integer primary key,
  book_id integer not null references books on delete cascade,
  idx integer not null,
  title text not null,
  goal text not null,
  plan text not null,
  chapter_count integer not null,
  expanded integer not null default 0,
  synopsis text,
  unique (book_id, idx)
);
create table if not exists chapters (
  id integer primary key,
  book_id integer not null references books on delete cascade,
  arc_idx integer not null,
  idx integer not null,
  title text not null,
  pov text not null default '',
  cast_names text not null default '[]',
  beats text not null default '[]',
  hook text not null default '',
  status text not null default 'planned',
  text text,
  words integer not null default 0,
  revised integer not null default 0,
  summary text,
  detail text,
  scene_end text,
  done_at integer,
  unique (book_id, idx)
);
create table if not exists facts (
  id integer primary key,
  book_id integer not null references books on delete cascade,
  chapter integer not null,
  text text not null,
  tags text not null default ''
);
create virtual table if not exists facts_fts using fts5(text, tags, content = 'facts', content_rowid = 'id');
create trigger if not exists facts_ai after insert on facts begin
  insert into facts_fts (rowid, text, tags) values (new.id, new.text, new.tags);
end;
create trigger if not exists facts_ad after delete on facts begin
  insert into facts_fts (facts_fts, rowid, text, tags) values ('delete', old.id, old.text, old.tags);
end;
create trigger if not exists facts_au after update on facts begin
  insert into facts_fts (facts_fts, rowid, text, tags) values ('delete', old.id, old.text, old.tags);
  insert into facts_fts (rowid, text, tags) values (new.id, new.text, new.tags);
end;
create table if not exists threads (
  id integer primary key,
  book_id integer not null references books on delete cascade,
  chapter integer not null,
  text text not null,
  payoff text not null default '',
  status text not null default 'open',
  resolved_in integer
);
create table if not exists issues (
  id integer primary key,
  book_id integer not null references books on delete cascade,
  chapter integer not null,
  issue text not null,
  fix text not null default '',
  thread_id integer,
  status text not null default 'open'
);
create table if not exists requests (
  id integer primary key,
  book_id integer not null references books on delete cascade,
  chapter integer,        -- the chapter the author highlighted in, if any
  quote text,             -- the highlighted passage
  text text not null,     -- what the author asked for
  reply text              -- what was done about it; null until the engine has taken it up
);
create table if not exists ink_chapters (
  book_id integer not null references books on delete cascade,
  idx integer not null,
  ccid text,              -- the chapter's id on Inkstone, once uploaded
  want text not null,     -- 'draft' | 'publish' | 'delete'
  at integer,             -- wanted publish time; null = right away
  state text,             -- on Inkstone now: null | 'draft' | 'scheduled' | 'published'
  applied integer,        -- the publish time Inkstone holds
  ver integer,            -- chapters.proof_rounds of the text last uploaded
  error text,
  primary key (book_id, idx)
);
`)

// Proofreader state. Added after the first release, and sqlite has no "add column if not exists".
for (const [table, col] of [['books', 'proofed'], ['chapters', 'proofed'], ['chapters', 'proof_rounds']])
  try {
    db.exec(`alter table ${table} add column ${col} integer not null default 0`)
  } catch {}
// Inkstone link and automation for a book (JSON), null until linked.
try {
  db.exec('alter table books add column inkstone text')
} catch {}
// The author's requests: the one an edit came from, and chapters whose memory predates their edited text.
try {
  db.exec('alter table issues add column request_id integer')
} catch {}
try {
  db.exec('alter table chapters add column stale integer not null default 0')
} catch {}
// A change by the author: `hand` marks a chapter they rewrote themselves, `undo` is the book as it was just
// before the change (JSON, null once it can no longer be undone), `wrote` how many chapters were written then.
// `effects` lists what the change actually did to the book (JSON array of lines). `sweep`: what the change
// may have left behind in text written before it and is still being checked for (JSON), null when done.
for (const col of ['undo text', 'wrote integer', 'undone integer not null default 0', 'hand integer not null default 0', 'effects text', 'sweep text'])
  try {
    db.exec(`alter table requests add column ${col}`)
  } catch {}
// `other`: for a proofreader finding about a conflict between two chapters, the other one (0 when none).
try {
  db.exec('alter table issues add column other integer not null default 0')
} catch {}
// `updated`: when Inkstone last took a changed text in place of the one it had, so the author can see it landed.
try {
  db.exec('alter table ink_chapters add column updated integer')
} catch {}
// `before`: a chapter's text as it stood before its last edit, kept to show what changed. `repaired`: how many
// times the proofreader has repaired it; `proof_rounds` counts every change of text and is what Inkstone compares.
// `sweep`: the request whose change this chapter still has to be read against, 0 when none.
for (const col of ['before text', 'repaired integer not null default 0', 'sweep integer not null default 0'])
  try {
    db.exec(`alter table chapters add column ${col}`)
  } catch {}

type Row = Record<string, any>
export const all = <T = Row>(sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p) as T[]
export const get = <T = Row>(sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p) as T | undefined
export const run = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p)

export function tx<T>(fn: () => T): T {
  if (db.isTransaction) return fn() // called from inside another: part of it
  db.exec('begin')
  try {
    const r = fn()
    db.exec('commit')
    return r
  } catch (e) {
    db.exec('rollback')
    throw e
  }
}

export const kvGet = <T>(k: string): T | undefined => {
  const r = get<{ v: string }>('select v from kv where k = ?', k)
  return r ? JSON.parse(r.v) : undefined
}
export const kvSet = (k: string, v: unknown) =>
  run('insert into kv (k, v) values (?, ?) on conflict (k) do update set v = excluded.v', k, JSON.stringify(v))
export const kvDel = (k: string) => run('delete from kv where k = ?', k)
