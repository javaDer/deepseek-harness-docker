/**
 * Bridge + Source protocol checks. Run with `node --test integrations/wechat`.
 * Covers the user-facing contract: rejection, dedupe, ordering, retry/terminal outcomes, restart behaviour,
 * and that Source commands never leak another sender's ticket.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge, normalize, MAX_TEXT } from './src/bridge.js'
import { BridgeStore, MAX_ATTEMPTS } from './src/store.js'
import { MockProvider } from './src/providers.js'
import { key, wechatTrigger, command, pollOnce, triggerId } from './source/protocol.js'

const TOKEN = 'x'.repeat(40)
const msg = (id, over = {}) => ({ id, chatId: 'room1', chatType: 'direct', senderId: 'wxid_a', self: false, mentioned: false,
  text: 'hello', at: '2026-11-13T00:00:00.000Z', ...over })
const dir = () => { const path = mkdtempSync(join(tmpdir(), 'wechat-')); return { path, file: join(path, 'bridge.sqlite'), done: () => rmSync(path, { recursive: true, force: true }) } }
const open = (file, provider = new MockProvider(), over = {}) => new Bridge({ provider, file, token: TOKEN, ...over })

test('normalize rejects malformed input and caps text', () => {
  assert.throws(() => normalize(msg('bad id!')), /invalid ids/)
  assert.throws(() => normalize(msg('ok', { chatType: 'channel' })), /invalid chatType/)
  assert.throws(() => normalize(msg('ok', { text: '   ' })), /invalid text/)
  assert.throws(() => normalize(msg('ok', { text: 'a'.repeat(MAX_TEXT + 1) })), /invalid text/)
  assert.throws(() => normalize(msg('ok', { at: 'yesterday' })), /invalid time/)
  assert.equal(normalize(msg('ok')).at, '2026-11-13T00:00:00.000Z')
})

test('self, group-off and unlisted senders are dropped before storage', () => {
  const t = dir()
  const bridge = open(t.file, new MockProvider(), { allowedSenders: ['wxid_a'] })
  assert.equal(bridge.receive(msg('m1', { self: true })), 'dropped')
  assert.equal(bridge.receive(msg('m2', { chatType: 'group' })), 'dropped')
  assert.equal(bridge.receive(msg('m3', { senderId: 'wxid_stranger' })), 'dropped')
  assert.equal(bridge.receive(msg('m4')), 'stored')
  assert.equal(bridge.receive(msg('m4')), 'duplicate')
  assert.equal(bridge.store.inbound(0, 10).length, 1)
  bridge.store.close(); t.done()
})

test('groups are read only when enabled, and only @mentions count as addressed', () => {
  const t = dir()
  const bridge = open(t.file, new MockProvider(), { groups: true })
  assert.equal(bridge.receive(msg('g1', { chatType: 'group', senderId: 'wxid_b' })), 'stored')
  const [group] = bridge.store.inbound(0, 10)
  assert.equal(wechatTrigger(group).addressed, undefined)
  assert.equal(wechatTrigger({ ...group, mentioned: true }).addressed, 'mention')
  assert.equal(wechatTrigger(msg('d1')).addressed, 'direct')
  bridge.store.close(); t.done()
})

test('inbound order and cursor resume survive a restart', () => {
  const t = dir()
  let bridge = open(t.file)
  bridge.receive(msg('m1')); bridge.receive(msg('m2'))
  const first = bridge.store.inbound(0, 10)
  assert.deepEqual(first.map(m => m.id), ['m1', 'm2'])
  assert.deepEqual(bridge.store.inbound(first.at(-1).seq, 10), [])
  bridge.store.close()
  // Reopening the same file keeps the log; ids stay deduplicated across restarts.
  bridge = open(t.file)
  assert.equal(bridge.receive(msg('m1')), 'duplicate')
  assert.equal(bridge.store.inbound(0, 10).length, 2)
  bridge.store.close(); t.done()
})

test('dispatch sends once, survives retryable failures, and stops at the attempt ceiling', async () => {
  const t = dir()
  const provider = new MockProvider()
  const bridge = open(t.file, provider)
  bridge.store.enqueue({ id: 'o1', chatId: 'room1', text: 'hi' })
  await bridge.dispatch()
  assert.deepEqual(provider.sent, [{ chatId: 'room1', text: 'hi' }])
  assert.equal(bridge.store.outbound('o1').state, 'sent')
  // Re-dispatch must not resend a settled message.
  await bridge.dispatch()
  assert.equal(provider.sent.length, 1)
  // Idempotent enqueue: same payload keeps state, different payload is a conflict.
  assert.equal(bridge.store.enqueue({ id: 'o1', chatId: 'room1', text: 'hi' }).state, 'sent')
  assert.equal(bridge.store.enqueue({ id: 'o1', chatId: 'room1', text: 'other' }), undefined)
  // Terminal failure.
  provider.fail('fatal')
  bridge.store.enqueue({ id: 'o2', chatId: 'room1', text: 'x' })
  await bridge.dispatch()
  assert.equal(bridge.store.outbound('o2').state, 'failed')
  assert.equal(provider.sent.length, 1)
  bridge.store.close(); t.done()
})

test('retryable failures back off and give up at MAX_ATTEMPTS', async () => {
  const t = dir()
  let clock = 1_000_000
  const provider = new MockProvider()
  const bridge = open(t.file, provider)
  bridge.store.now = () => clock
  provider.fail(...Array.from({ length: MAX_ATTEMPTS + 1 }, () => 'retry'))
  bridge.store.enqueue({ id: 'r1', chatId: 'room1', text: 'x' })
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) { await bridge.dispatch(); clock += 10 * 60_000 }
  const row = bridge.store.outbound('r1')
  assert.equal(row.state, 'failed')
  assert.equal(row.attempts, MAX_ATTEMPTS)
  assert.equal(provider.sent.length, 0)
  bridge.store.close(); t.done()
})

test('a send that may have landed is marked unknown and never resent', async () => {
  const t = dir()
  const provider = new MockProvider()
  const bridge = open(t.file, provider, { sendTimeoutMs: 20 })
  provider.fail('hang')
  bridge.store.enqueue({ id: 'u1', chatId: 'room1', text: 'x' })
  await bridge.dispatch()
  assert.equal(bridge.store.outbound('u1').state, 'unknown')
  provider.failures.length = 0
  await bridge.dispatch()
  assert.equal(provider.sent.length, 0)
  // A crash while `sending` becomes `unknown` on the next boot.
  bridge.store.db.prepare("UPDATE outbound SET state='sending' WHERE id=?").run('u1')
  bridge.store.close()
  const reopened = open(t.file)
  assert.equal(reopened.store.outbound('u1').state, 'unknown')
  reopened.store.close(); t.done()
})

test('http surface requires the token and keeps health open', async () => {
  const t = dir()
  const bridge = open(t.file)
  await bridge.start()
  const server = bridge.server({ mockInject: true })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const auth = { authorization: 'Bearer ' + TOKEN }
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200)
    assert.equal((await fetch(base + '/v1/status')).status, 401)
    assert.equal((await fetch(base + '/v1/status', { headers: { authorization: 'Bearer ' + 'y'.repeat(40) } })).status, 401)
    assert.equal((await fetch(base + '/v1/status', { headers: auth })).status, 200)
    // Mock injection only exists for the mock provider and still goes through the same filters.
    const inject = body => fetch(base + '/v1/mock/inject', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await (await inject(msg('i1'))).json()).result, 'stored')
    assert.equal((await (await inject(msg('i2', { self: true }))).json()).result, 'dropped')
    const out = await fetch(base + '/v1/outbound', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'http1', chatId: 'room1', text: 'reply' }) })
    assert.equal(out.status, 200)
    assert.equal((await fetch(base + '/v1/outbound/http1', { headers: auth })).status, 200)
    assert.equal((await fetch(base + '/v1/outbound/nope', { headers: auth })).status, 404)
  } finally { server.close(); bridge.store.close(); t.done() }
})

test('unknown outbound ids and out-of-range bodies are rejected', async () => {
  const t = dir()
  const bridge = open(t.file)
  const server = bridge.server()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = body => fetch(base + '/v1/outbound', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await post({ id: 'x', chatId: 'room1', text: '' })).status, 400)
    assert.equal((await post({ id: 'x', chatId: 'room 1', text: 'hi' })).status, 400)
    assert.equal((await post({ id: 'x', chatId: 'room1', text: 'a'.repeat(MAX_TEXT + 1) })).status, 400)
  } finally { server.close(); bridge.store.close(); t.done() }
})

test('trigger ids are stable and carry the chat as both thread and channel', () => {
  const a = wechatTrigger(msg('m1')), b = wechatTrigger(msg('m1'))
  assert.equal(a.id, b.id)
  assert.equal(a.id, triggerId('m1'))
  assert.notEqual(a.id, wechatTrigger(msg('m2')).id)
  assert.deepEqual(a.threads, [{ source: 'wechat', id: 'room1' }])
  assert.equal(a.channel.thread, 'wechat:room1')
  assert.deepEqual(a.channel.address, { chatId: 'room1', direct: 'true' })
})

const ticket = (id, actor, over = {}) => ({ id, title: 'T ' + id, mandate: { actor: { source: 'wechat', id: actor } },
  assignments: [], ...over })

test('commands only ever read tickets the sender originated', () => {
  const mine = ticket('a'.repeat(32), 'wxid_a')
  const foreign = ticket('b'.repeat(32), 'wxid_b')
  const tickets = { open: () => [mine, foreign], get: id => [mine, foreign].find(t => t.id === id) }
  assert.match(command('/status', 'wxid_a', tickets), /T a{5}/)
  assert.doesNotMatch(command('/status', 'wxid_a', tickets), /T b{5}/)
  assert.match(command('/task ' + 'a'.repeat(32), 'wxid_a', tickets), /T a{5}/)
  // Another sender's ticket answers exactly like a missing one.
  assert.equal(command('/task ' + 'b'.repeat(32), 'wxid_a', tickets), 'Task not found.')
  assert.equal(command('/task ' + 'c'.repeat(32), 'wxid_a', tickets), 'Task not found.')
  assert.equal(command('/status', 'wxid_c', tickets), 'No open tasks.')
  assert.equal(command('/task', 'wxid_a', tickets), 'Usage: /task <id>')
  // Anything that is not a command is not intercepted.
  assert.equal(command('fix the typo', 'wxid_a', tickets), undefined)
})

test('describeTicket reports only core states', () => {
  const t = ticket('d'.repeat(32), 'wxid_a', { assignments: [{ report: { state: 'progress', summary: 'halfway', at: 'x' } }] })
  assert.match(command('/task ' + 'd'.repeat(32), 'wxid_a', { open: () => [t], get: () => t }), /state: progress/)
  const ended = { ...t, ended: { at: 'x', by: 'executor', outcome: 'merged' } }
  assert.match(command('/task ' + 'd'.repeat(32), 'wxid_a', { open: () => [ended], get: () => ended }), /ended \(merged\)/)
})

test('poll advances the cursor only after receive, and is restart-safe', async () => {
  const t = dir()
  const bridge = open(t.file, new MockProvider(), { allowedSenders: ['wxid_a'] })
  bridge.receive(msg('p1', { text: 'fix the typo' }))
  bridge.receive(msg('p2', { text: '/status' }))
  const kv = new Map()
  const received = [], notified = []
  const client = { call: async path => ({ messages: bridge.store.inbound(Number(path.split('=')[1]), 100) }) }
  const source = { config: () => ({}), state: { get: k => kv.get(k), set: (k, v) => kv.set(k, v) },
    tickets: { open: () => [], get: () => undefined }, receive: async trigger => { received.push(trigger.id) }, notify: m => notified.push(m), report() {} }
  const registry = { policyPart: () => ({ allowed: [{ id: 'wxid_a' }] }), scope: () => ({ listened: true, observed: false }) }
  assert.equal(await pollOnce(source, client, registry), 2)
  assert.equal(received.length, 1)
  assert.equal(received[0], triggerId('p1'))
  assert.equal(notified.length, 1)
  assert.match(notified[0].text, /No open tasks/)
  assert.equal(kv.get('wechat-cursor'), 2)
  // Nothing new: a second poll is a no-op.
  assert.equal(await pollOnce(source, client, registry), 0)
  assert.equal(received.length, 1)
  bridge.store.close(); t.done()
})

test('an unlisted sender never reaches commands, and a disabled Source receives nothing', async () => {
  const t = dir()
  const bridge = open(t.file)
  bridge.receive(msg('q1', { senderId: 'wxid_stranger', text: '/status' }))
  const received = [], notified = []
  const client = { call: async () => ({ messages: bridge.store.inbound(0, 100) }) }
  const source = { config: () => ({}), state: { get: () => 0, set() {} }, tickets: { open: () => [], get: () => undefined },
    receive: async trigger => received.push(trigger), notify: m => notified.push(m), report() {} }
  const registry = { policyPart: () => ({ allowed: [{ id: 'wxid_a' }] }), scope: () => ({ listened: true, observed: false }) }
  await pollOnce(source, client, registry)
  // It is stored as a trigger for Policy to judge; it never gets a command answer.
  assert.equal(received.length, 1)
  assert.equal(notified.length, 0)
  const off = { ...source, config: () => undefined }
  assert.equal(await pollOnce(off, client, registry), 0)
  bridge.store.close(); t.done()
})

test('two senders cannot see each other through /task prefixes', () => {
  const mine = ticket('abc123', 'wxid_a')
  const foreign = ticket('abc124', 'wxid_b')
  const tickets = { open: () => [mine, foreign], get: () => undefined }
  assert.equal(command('/task abc12', 'wxid_b', tickets), 'Task not found.')
  assert.match(command('/task abc124', 'wxid_b', tickets), /T abc124/, 'exact id still resolves for its owner')
})
