import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.KAIZER_DB = ':memory:'
process.env.KAIZER_INK_PACE = '0'
const { run, get } = await import('./db.ts')
const ink = await import('./inkstone.ts')

test('schedule times are GMT+8 on a five-minute grid, and release slots never land in the past', () => {
  assert.deepEqual(ink.gmt8(Date.UTC(2026, 9, 4, 10, 2)), { date: '2026/10/04', time: '18:05' })
  assert.deepEqual(ink.gmt8(Date.UTC(2026, 9, 4, 17, 0)), { date: '2026/10/05', time: '01:00' })
  const h = 3_600_000
  assert.equal(ink.nextSlot({ start: 100 * h, every: 24 }, null, 0), 100 * h)
  assert.equal(ink.nextSlot({ start: 100 * h, every: 24 }, 124 * h, 0), 148 * h)
  assert.equal(ink.nextSlot({ start: 100 * h, every: 24 }, null, 150 * h), 172 * h)
  assert.equal(ink.inkBody('One *two*.\n\n  Three.\n'), 'One two.\r\nThree.')
  assert.equal(ink.inkBody('One *two* & <3.\n\nThree.', true), '<p>One <em>two</em> &amp; &lt;3.</p><p>Three.</p>')
})

test('drafts, schedules, reschedules and unschedules chapters through the Inkstone web API', async () => {
  const CBID = '10589139205070105' // real ids exceed 2^53
  const id = Number(run('insert into books (title, settings, status, created_at, updated_at) values (?, ?, ?, 0, 0)', 'T', '{}', 'complete').lastInsertRowid)
  for (const idx of [1, 2]) run('insert into chapters (book_id, arc_idx, idx, title, status, text, words) values (?, 0, ?, ?, ?, ?, 4)', id, idx, `C${idx}`, 'done', 'One *two*.\n\nThree.')

  const at = ink.gmt8(Date.now() + 3 * 3_600_000) // Inkstone takes timers up to 12 hours ahead in this test
  const max = ink.gmt8(Date.now() + 12 * 3_600_000)
  const calls: { path: string; auth: string; body: any }[] = []
  let signedIn = true
  let ccid = 0
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname + (new URL(url).searchParams.get('action') ?? '')
    const body = init.body ? JSON.parse(init.body as string) : Object.fromEntries(new URL(url).searchParams)
    calls.push({ path, auth: (init.headers as Record<string, string>).authorization, body })
    const reply = (result: string) => new Response(`{"returnCode":200,"Authorization":"tok${calls.length}","result":${result}}`)
    if (!signedIn) return new Response('{"returnCode":4001,"returnMsg":"expired"}')
    if (path.endsWith('getUserInfo')) return reply('{"penname":"Pen"}')
    if (path.endsWith('getAddPreBookChapter') || path.endsWith('editChapter')) return reply('{"token":"T","editorType":3,"vipSelected":-1,"volumeInfoVos":[{"CVID":20589139205070001}]}')
    if (path.endsWith('saveChapter')) return reply(`{"flag":true,"CCID":${body.CCID ?? `3058913920507000${++ccid}`},"publishPreInfoVo":{"minDate":-1,"maxDate":"${max.date}","maxTime":"${max.time}"}}`)
    return reply('{"flag":true}')
  }) as typeof fetch
  const settle = async () => {
    for (let n = -1; n !== calls.length; ) (n = calls.length), await sleep(60)
  }
  const row = (idx: number) => get('select * from ink_chapters where book_id = ? and idx = ?', id, idx)!
  const last = (name: string) => calls.findLast(c => c.path.endsWith(name))!

  await ink.connect('Cookie: uid=1; inkstone_auth_token=tok0', 'UA')
  assert.deepEqual(ink.status(), { connected: true, expired: false, name: 'Pen' })
  assert.equal(calls[0].auth, 'tok0')
  ink.link(id, { cbid: CBID, title: 'N', auto: 'off', every: 24, start: 0 })

  // Draft: one new chapter, plain CRLF text, ids kept exact.
  ink.want(id, [1], 'draft', null)
  await settle()
  assert.equal(row(1).state, 'draft')
  assert.equal(row(1).ccid, '30589139205070001')
  assert.equal(row(1).updated, null) // a first upload is not an update
  const saved = last('saveChapter')
  assert.equal(saved.auth, 'tok2') // the token Inkstone handed out on the previous call
  assert.deepEqual(
    { CBID: saved.body.CBID, cvid: saved.body.selectedCVID, title: saved.body.chapterTitle, content: saved.body.content, token: saved.body.token, op: saved.body.operatorType },
    { CBID, cvid: '20589139205070001', title: 'C1', content: 'One two.\r\nThree.', token: 'T', op: undefined })

  // Schedule both a day apart: chapter 1 gets a timer, chapter 2 is past Inkstone's window and waits as a draft.
  const when = Date.now() + 3 * 3_600_000
  ink.want(id, [1, 2], 'publish', when, 24)
  await settle()
  assert.equal(row(1).state, 'scheduled')
  assert.equal(row(1).ccid, '30589139205070001') // updated in place, not uploaded twice
  assert.equal(last('saveChapter').body.operatorType, 'getpublish')
  const timed = last('publishChapter').body
  assert.deepEqual({ CCID: timed.CCID, hasTimer: timed.hasTimer, date: timed.date, time: timed.time }, { CCID: '30589139205070001', hasTimer: 1, ...at })
  assert.equal(row(2).state, 'draft')
  assert.equal(calls.filter(c => c.path.endsWith('publishChapter')).length, 1)

  // Nothing left to do: another sweep makes no calls.
  const quiet = calls.length
  await ink.pass()
  assert.equal(calls.length, quiet)

  // The proofreader rewrites chapter 1: the draft is updated and its timer set again.
  run('update chapters set proof_rounds = 1 where book_id = ? and idx = 1', id)
  await ink.pass()
  assert.equal(calls.length, quiet + 3)
  assert.equal(row(1).ver, 1)
  assert.ok(row(1).updated > Date.now() - 60_000, 'the author can see when Inkstone took the new text')

  // Back to draft: the timed chapter is replaced, since Inkstone cannot cancel a timer.
  ink.want(id, [1], 'draft', null)
  await settle()
  assert.equal(last('deleteChapter').body.CCID, '30589139205070001')
  assert.deepEqual({ state: row(1).state, ccid: row(1).ccid }, { state: 'draft', ccid: '30589139205070003' })

  // Publish now, then a lapsed session: the order stays queued and the app says so.
  ink.want(id, [1], 'publish', null)
  await settle()
  assert.equal(row(1).state, 'published')
  assert.equal(last('publishChapter').body.hasTimer, 0)

  // The proofreader rewrites the published chapter: it is updated in place and not published a second time.
  const published = calls.filter(c => c.path.endsWith('publishChapter')).length
  run('update chapters set proof_rounds = 2, text = ? where book_id = ? and idx = 1', 'Fixed.', id)
  await ink.pass()
  assert.deepEqual({ CCID: last('saveChapter').body.CCID, content: last('saveChapter').body.content, op: last('saveChapter').body.operatorType }, { CCID: row(1).ccid, content: 'Fixed.', op: undefined })
  assert.deepEqual({ state: row(1).state, ver: row(1).ver }, { state: 'published', ver: 2 })
  assert.equal(calls.filter(c => c.path.endsWith('publishChapter')).length, published)
  signedIn = false
  ink.want(id, [2], 'publish', null)
  await settle()
  assert.deepEqual(ink.status(), { connected: false, expired: true, name: 'Pen' })
  assert.deepEqual({ state: row(2).state, error: row(2).error }, { state: 'draft', error: null })
})
