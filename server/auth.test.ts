import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.KAIZER_DB = ':memory:'
const { run, get, kvSet, kvGet } = await import('./db.ts')
const { accessToken, me } = await import('./auth.ts')
const { start, resumeSignedOut } = await import('./engine.ts')

const session = (minutesLeft: number, extra = {}) =>
  kvSet('session', { clientId: 'c', subject: 's', accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + minutesLeft * 60_000, ...extra })

// ChatGPT's token endpoint, refusing a refresh.
const refused = () => new Response(JSON.stringify({ error: 'invalid_grant', error_reason: 'refresh_token_invalidated' }), { status: 400 })
const authFetch = (refresh: () => Response): typeof fetch =>
  (async (url: unknown) =>
    String(url).includes('openid-configuration') ? Response.json({ token_endpoint: 'https://auth.test/token' }) : refresh()) as typeof fetch

test('a refused refresh keeps the session alive until the access token really expires', async () => {
  globalThis.fetch = authFetch(refused)
  session(4)
  assert.equal(await accessToken(), 'old', 'still usable for its last minutes')
  assert.equal(me().signedIn, true)
  assert.equal(me().renewable, false, 'the UI is told this sign-in will not renew itself')
  assert.equal(await accessToken(), 'old', 'and the dead refresh token is not tried again')

  session(60)
  assert.equal(me().renewable, true, 'a new sign-in is not judged by the old refusal')

  session(-1, { refreshDead: true })
  assert.equal(me().signedIn, false)
  await assert.rejects(accessToken(), { code: 'signed_out' })
  assert.equal(kvGet('session'), undefined)
})

test('a working refresh rotates the token; a network failure during refresh keeps the session', async () => {
  globalThis.fetch = authFetch(() => Response.json({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }))
  session(4)
  assert.equal(await accessToken(), 'new')
  assert.equal(kvGet<any>('session').refreshToken, 'r2')
  assert.equal(me().renewable, true)

  globalThis.fetch = authFetch(() => {
    throw new TypeError('fetch failed')
  })
  session(4)
  assert.equal(await accessToken(), 'old')
  assert.equal(kvGet<any>('session').refreshToken, 'r1', 'credentials untouched')
})

test('a book that loses its sign-in waits, then resumes by itself after the next sign-in', async () => {
  const bible = { title: 'T', logline: 'L', synopsis: 'S', themes: [], world: 'W', rules: [], power_system: 'none', glossary: [] }
  const settings = { model: 'm', genre: 'g', tropes: [], tone: 't', rating: 'r', language: 'English', pov: 'p', tense: 'past', words: 10, style: '' }
  const id = Number(run('insert into books (title, settings, bible, created_at, updated_at) values (?, ?, ?, 0, 0)', 'T', JSON.stringify(settings), JSON.stringify(bible)).lastInsertRowid)
  run('insert into arcs (book_id, idx, title, goal, plan, chapter_count, expanded) values (?, 0, ?, ?, ?, 1, 1)', id, 'A', 'G', 'P')
  run('insert into chapters (book_id, arc_idx, idx, title, status, text, words) values (?, 0, 1, ?, ?, ?, 2)', id, 'C1', 'drafted', 'some prose')
  const settle = async (from: string) => {
    for (let i = 0; i < 200 && get('select status from books where id = ?', id)!.status === from; i++) await sleep(25)
    return get('select status, error, retry_at from books where id = ?', id)!
  }

  // The hour is up and the refresh is refused.
  globalThis.fetch = authFetch(refused)
  session(-1)
  start(id)
  const held = await settle('running')
  assert.equal(held.status, 'waiting')
  assert.equal(held.retry_at, null)
  assert.match(held.error, /Signed out of ChatGPT/)

  // Sign in again: the callback route calls resumeSignedOut().
  let calls = 0
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    calls++
    const name = JSON.parse(init.body as string).text?.format?.name
    const text = name === 'chapter_memory'
      ? JSON.stringify({ summary: 's', detail: 'd', scene_end: 'e', facts: [], entity_updates: [], new_entities: [], threads_opened: [], threads_resolved: [], continuity_issues: [] })
      : name === 'arc_synopsis' ? JSON.stringify({ synopsis: 'what happened', threads_resolved: [] })
      : name === 'proofread' ? JSON.stringify({ issues: [], threads_resolved: [] })
      : JSON.stringify({ threads: [], ending: { complete: true, fix: '' } })
    return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`)
  }) as typeof fetch
  session(60)
  resumeSignedOut()
  await settle('waiting')
  const done = await settle('running')
  assert.deepEqual([done.status, done.error], ['complete', null])
  assert.ok(calls >= 4, 'memory, synopsis, proofread, ending')
})
