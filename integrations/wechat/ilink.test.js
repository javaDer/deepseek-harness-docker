/**
 * ClawBot (iLink) provider checks against a local fake of the Tencent endpoints. Nothing here reaches the network.
 * Run with `node --test integrations/wechat`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IlinkClient, IlinkProvider, IlinkState, loginWithQr, trusted } from './src/ilink.js'
import { ProviderError } from './src/providers.js'

const local = url => new URL(url).origin + '/'
const until = async (predicate, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)) } assert.fail('timed out waiting') }

/** Fake iLink: `routes` map a path to a handler(body, request) -> JSON; getupdates holds briefly when idle like a long poll. */
async function fake(routes) {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const url = new URL(req.url, 'http://fake'); const raw = Buffer.concat(chunks).toString('utf8')
    const record = { path: url.pathname, query: url.searchParams, headers: req.headers, raw, body: raw ? JSON.parse(raw) : undefined }
    requests.push(record)
    let reply = routes[url.pathname]?.(record.body, record)
    if (reply === undefined && url.pathname === '/ilink/bot/getupdates') await new Promise(r => setTimeout(r, 150)), reply = { ret: 0, msgs: [] }
    res.writeHead(reply === undefined ? 404 : 200, { 'content-type': 'application/json' }); res.end(typeof reply === 'string' ? reply : JSON.stringify(reply ?? {}))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)) } }
}
const setup = () => { const path = mkdtempSync(join(tmpdir(), 'ilink-')); return { file: join(path, 'ilink.json'), done: () => rmSync(path, { recursive: true, force: true }) } }
const login = (file, extra = {}) => { const state = new IlinkState(file); state.data = { token: 'tok-secret-123', botId: 'bot1', buf: '', ctx: {}, ...extra }; state.save() }
const provider = (file, server, over = {}) => new IlinkProvider({ stateFile: file, baseUrl: server.url, trust: local, idleMs: 20, retryMs: 20, ...over })
const text = (value, over = {}) => ({ seq: 1, message_id: '9007199254740993123', from_user_id: 'u1@im.wechat', create_time_ms: 1790000000000, message_type: 1,
  context_token: 'ctx1', item_list: [{ type: 1, text_item: { text: value } }], ...over })

test('inbound text reaches the Bridge contract, and the cursor is saved only after delivery', async () => {
  const t = setup(); login(t.file)
  const batches = [{ ret: 0, msgs: [text('/status')], get_updates_buf: 'B1' }]
  const server = await fake({ '/ilink/bot/getupdates': () => batches.shift() })
  const got = [], p = provider(t.file, server)
  await p.start(async m => { got.push(m); assert.equal(new IlinkState(t.file).data.buf, '', 'cursor must not move before the batch is stored') })
  await until(() => new IlinkState(t.file).data.buf === 'B1')
  await p.stop(); await server.close()
  assert.deepEqual(got, [{ id: '9007199254740993123', chatId: 'u1@im.wechat', chatType: 'direct', senderId: 'u1@im.wechat', self: false, mentioned: false,
    text: '/status', at: new Date(1790000000000).toISOString() }])
  const poll = server.requests.find(r => r.path === '/ilink/bot/getupdates')
  assert.equal(poll.headers.authorization, 'Bearer tok-secret-123'); assert.equal(poll.headers.authorizationtype, 'ilink_bot_token')
  assert.equal(poll.headers['ilink-app-id'], 'bot'); assert.match(poll.body.base_info.bot_agent, /^DSHWeChatBridge\//)
  assert.equal(statSync(t.file).mode & 0o777, 0o600)
  t.done()
})

test('a restart resumes from the saved cursor', async () => {
  const t = setup(); login(t.file, { buf: 'B7' })
  const server = await fake({}), p = provider(t.file, server)
  await p.start(async () => {})
  await until(() => server.requests.some(r => r.path === '/ilink/bot/getupdates'))
  await p.stop(); await server.close()
  assert.equal(server.requests.find(r => r.path === '/ilink/bot/getupdates').body.get_updates_buf, 'B7')
  t.done()
})

test('only user text is read: bot echoes, voice, empty and group messages are not treated as requests', async () => {
  const t = setup(); login(t.file)
  const batches = [{ ret: 0, get_updates_buf: 'B2', msgs: [
    text('from bot', { message_type: 2, message_id: '1' }),
    text('', { message_id: '2', item_list: [{ type: 3, voice_item: { text: 'transcript' } }] }),
    text('ping', { message_id: '3', group_id: 'g1@chatroom' }) ] }]
  const server = await fake({ '/ilink/bot/getupdates': () => batches.shift() })
  const got = [], p = provider(t.file, server)
  await p.start(async m => { got.push(m) })
  await until(() => new IlinkState(t.file).data.buf === 'B2')
  await p.stop(); await server.close()
  assert.deepEqual(got.map(m => [m.id, m.chatType, m.chatId, m.mentioned]), [['3', 'group', 'g1@chatroom', false]])
  t.done()
})

test('replies echo the stored context token and map provider outcomes', async () => {
  const t = setup(); login(t.file)
  const batches = [{ ret: 0, msgs: [text('hi')], get_updates_buf: 'B1' }], sends = [{ ret: 0 }, { ret: 1, errmsg: 'nope' }, { errcode: -14 }]
  const server = await fake({ '/ilink/bot/getupdates': () => batches.shift(), '/ilink/bot/sendmessage': () => sends.shift() })
  const p = provider(t.file, server); await p.start(async () => {})
  await until(() => new IlinkState(t.file).data.ctx?.['u1@im.wechat'] === 'ctx1')
  await p.send('u1@im.wechat', 'done')
  const sent = server.requests.find(r => r.path === '/ilink/bot/sendmessage').body.msg
  assert.deepEqual([sent.to_user_id, sent.message_type, sent.message_state, sent.context_token, sent.item_list[0].text_item.text], ['u1@im.wechat', 2, 2, 'ctx1', 'done'])
  assert.ok(sent.client_id)
  await assert.rejects(p.send('u1@im.wechat', 'x'), e => e instanceof ProviderError && e.retryable === false)
  await assert.rejects(p.send('u1@im.wechat', 'y'), e => e instanceof ProviderError && e.retryable === true)
  await p.stop(); await server.close(); t.done()
})

test('a request that may have reached WeChat is never marked retryable, a refused connection is', async () => {
  const t = setup(); login(t.file)
  const server = await fake({ '/ilink/bot/sendmessage': () => '{not json' })
  const p = provider(t.file, server); await p.start(async () => {}); await until(() => server.requests.length > 0)
  await assert.rejects(p.send('u1@im.wechat', 'a'), e => e.retryable === false)
  await p.stop(); await server.close()
  // The port was just released, so nothing listens: the connection is refused before any byte is sent.
  const closed = await fake({}); await closed.close()
  const dead = provider(t.file, closed); dead.client = new IlinkClient({ baseUrl: closed.url, token: 'tok', trust: local })
  await assert.rejects(dead.send('u1@im.wechat', 'b'), e => e.retryable === true)
  t.done()
})

test('session expiry (-14) pauses polling instead of hammering the service', async () => {
  const t = setup(); login(t.file)
  const server = await fake({ '/ilink/bot/getupdates': () => ({ ret: -14 }) })
  const p = provider(t.file, server, { pauseMs: 60000 }); await p.start(async () => {})
  await until(() => p.status().detail.includes('-14'))
  const before = server.requests.filter(r => r.path === '/ilink/bot/getupdates').length
  await new Promise(r => setTimeout(r, 200))
  assert.equal(server.requests.filter(r => r.path === '/ilink/bot/getupdates').length, before)
  assert.equal(p.status().connected, false)
  await p.stop(); await server.close(); t.done()
})

test('without credentials the provider waits for an operator login and never calls out', async () => {
  const t = setup(), server = await fake({}), p = provider(t.file, server)
  await p.start(async () => {})
  await until(() => p.status().detail.startsWith('login required'))
  login(t.file); await until(() => p.status().connected)
  await p.stop(); await server.close(); t.done()
})

test('credentials only go to Tencent hosts over HTTPS', () => {
  assert.equal(trusted('https://ilinkai.weixin.qq.com'), 'https://ilinkai.weixin.qq.com/')
  assert.equal(trusted('https://sh.ilinkai.weixin.qq.com'), 'https://sh.ilinkai.weixin.qq.com/')
  for (const bad of ['http://ilinkai.weixin.qq.com', 'https://evil.example', 'https://weixin.qq.com.evil.example', 'https://ilinkai.weixin.qq.com:8443', 'https://user@evil.example/'])
    assert.throws(() => trusted(bad), /untrusted/)
})

test('status never exposes the bot token', async () => {
  const t = setup(); login(t.file)
  const server = await fake({}), p = provider(t.file, server); await p.start(async () => {}); await until(() => p.status().connected)
  assert.ok(!JSON.stringify(p.status()).includes('tok-secret'))
  await p.stop(); await server.close(); t.done()
})

test('QR login: scan, PIN, confirm saves credentials once and the PIN goes only to the status poll', async () => {
  const t = setup(), state = new IlinkState(t.file)
  const steps = [{ status: 'wait' }, { status: 'scaned' }, { status: 'need_verifycode' }, { status: 'scaned' },
    { status: 'confirmed', bot_token: 'new-token', ilink_bot_id: 'bot9', ilink_user_id: 'owner@im.wechat', baseurl: 'https://ilinkai.weixin.qq.com' }]
  const server = await fake({ '/ilink/bot/get_bot_qrcode': () => ({ qrcode: 'Q1', qrcode_img_content: 'https://example.invalid/qr' }),
    '/ilink/bot/get_qrcode_status': () => steps.shift() })
  const qrs = []
  const result = await loginWithQr({ client: new IlinkClient({ baseUrl: server.url, trust: p => (p.startsWith('https://ilinkai') ? 'https://ilinkai.weixin.qq.com/' : local(p)) }),
    state, onQr: url => qrs.push(url), readPin: async () => '4821', pollMs: 5 })
  assert.deepEqual(result, { ok: true, userId: 'owner@im.wechat' }); assert.deepEqual(qrs, ['https://example.invalid/qr'])
  const polls = server.requests.filter(r => r.path === '/ilink/bot/get_qrcode_status')
  assert.deepEqual(polls.map(r => r.query.get('verify_code')), [null, null, null, '4821', null].slice(0, polls.length))
  assert.ok(polls.every(r => !r.headers.authorization), 'QR polling carries no bearer token')
  const saved = JSON.parse(readFileSync(t.file, 'utf8'))
  assert.deepEqual([saved.token, saved.botId, saved.userId, saved.buf], ['new-token', 'bot9', 'owner@im.wechat', ''])
  assert.equal(statSync(t.file).mode & 0o777, 0o600)
  await server.close(); t.done()
})

test('QR login gives up after repeated expiry, and an already-bound bot keeps its credentials', async () => {
  const t = setup(), state = new IlinkState(t.file)
  const expired = await fake({ '/ilink/bot/get_bot_qrcode': () => ({ qrcode: 'Q', qrcode_img_content: 'https://example.invalid/qr' }), '/ilink/bot/get_qrcode_status': () => ({ status: 'expired' }) })
  const a = await loginWithQr({ client: new IlinkClient({ baseUrl: expired.url, trust: local }), state, onQr() {}, readPin: async () => '', pollMs: 5 })
  assert.equal(a.ok, false); assert.equal(expired.requests.filter(r => r.path === '/ilink/bot/get_bot_qrcode').length, 3)
  const bound = await fake({ '/ilink/bot/get_bot_qrcode': () => ({ qrcode: 'Q', qrcode_img_content: 'x' }), '/ilink/bot/get_qrcode_status': () => ({ status: 'binded_redirect' }) })
  const b = await loginWithQr({ client: new IlinkClient({ baseUrl: bound.url, trust: local }), state, onQr() {}, readPin: async () => '', pollMs: 5 })
  assert.equal(b.ok, false); assert.deepEqual(new IlinkState(t.file).data, {})
  await expired.close(); await bound.close(); t.done()
})
