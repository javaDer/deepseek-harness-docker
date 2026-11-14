/**
 * Allowlist snapshot, admin API and operator login checks. Everything runs against local fakes; nothing reaches WeChat.
 * Run with `node --test integrations/wechat`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge, authzRevision as bridgeRevision } from './src/bridge.js'
import { MockProvider } from './src/providers.js'
import { IlinkClient, IlinkProvider } from './src/ilink.js'
import { LoginManager, LoginError } from './src/login.js'
import { authzRevision, authzSnapshot, pollOnce } from './source/protocol.js'

const TOKEN = 'd'.repeat(40), ADMIN = 'a'.repeat(40)
const STATUS = { configuredEnabled: true, confirmed: true, dshConfigured: true }
const msg = (id, over = {}) => ({ id, chatId: 'u1', chatType: 'direct', senderId: 'wxid_a', self: false, mentioned: false, text: 'hello', at: '2026-11-14T00:00:00.000Z', ...over })
const dir = () => { const path = mkdtempSync(join(tmpdir(), 'wechat-admin-')); return { file: join(path, 'bridge.sqlite'), path, done: () => rmSync(path, { recursive: true, force: true }) } }
const snapshot = (allowed, effective = true, status = STATUS) => ({ revision: authzRevision(effective, allowed), effective, allowed, status })
const make = (file, over = {}) => new Bridge({ provider: new MockProvider(), file, token: TOKEN, adminToken: ADMIN, ...over })
const until = async (predicate, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)) } assert.fail('timed out waiting') }
const dropped = bridge => bridge.store.db.prepare("SELECT detail FROM audit WHERE kind='inbound_dropped'").all().map(r => JSON.parse(r.detail).reason)
async function listen(bridge) {
  const server = bridge.server(); await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) }
}
const auth = token => ({ authorization: 'Bearer ' + token })
const admin = { ...auth(ADMIN), 'x-wechat-admin': '1' }

// --- Allowlist snapshot ------------------------------------------------------------------------------------------

test('without a DSH snapshot the Bridge refuses every new message (fail closed)', () => {
  const t = dir(), bridge = make(t.file)
  assert.equal(bridge.receive(msg('m1')), 'dropped')
  assert.deepEqual(dropped(bridge), ['authz_missing'])
  assert.equal(bridge.store.inbound(0, 10).length, 0)
  bridge.store.close(); t.done()
})

test('the snapshot admits listed senders only, and a stale or ineffective one admits nobody', () => {
  const t = dir(), bridge = make(t.file)
  bridge.setAuthz(snapshot(['WXID_A']))
  assert.equal(bridge.receive(msg('m1')), 'stored', 'ids compare case-insensitively, like the DSH Policy')
  assert.equal(bridge.receive(msg('m2', { senderId: 'wxid_x' })), 'dropped')
  bridge.setAuthz(snapshot([], false))
  assert.equal(bridge.receive(msg('m3')), 'dropped')
  bridge.setAuthz(snapshot(['wxid_a']))
  const later = Date.now() + 301000; bridge.now = () => later
  assert.equal(bridge.receive(msg('m4')), 'dropped')
  assert.deepEqual(dropped(bridge), ['sender_not_authorized', 'source_not_effective', 'authz_stale'])
  bridge.store.close(); t.done()
})

test('the legacy env allowlist can only narrow the snapshot, never widen it', () => {
  const t = dir(), bridge = make(t.file, { allowedSenders: ['wxid_a', 'wxid_env_only'] })
  bridge.setAuthz(snapshot(['wxid_a', 'wxid_b']))
  assert.equal(bridge.receive(msg('m1')), 'stored')
  assert.equal(bridge.receive(msg('m2', { senderId: 'wxid_b' })), 'dropped')
  assert.equal(bridge.receive(msg('m3', { senderId: 'wxid_env_only' })), 'dropped')
  assert.deepEqual(dropped(bridge), ['sender_not_in_legacy_env', 'sender_not_authorized'])
  bridge.store.close(); t.done()
})

test('a snapshot must carry the content address of what it lists, and survives a restart', () => {
  const t = dir(); let bridge = make(t.file)
  assert.throws(() => bridge.setAuthz({ ...snapshot(['wxid_a']), allowed: ['wxid_a', 'wxid_extra'] }), /revision_mismatch/)
  assert.throws(() => bridge.setAuthz(snapshot(['bad id'])), /invalid_authz/)
  assert.throws(() => bridge.setAuthz(snapshot(Array.from({ length: 201 }, (_, i) => 'u' + i))), /invalid_authz/)
  assert.throws(() => bridge.setAuthz({ ...snapshot(['wxid_a']), effective: 'yes' }), /invalid_authz/)
  const first = bridge.setAuthz(snapshot(['wxid_a']))
  assert.deepEqual([first.changed, bridge.setAuthz(snapshot(['wxid_a'])).changed], [true, false])
  bridge.store.close(); bridge = make(t.file)
  assert.equal(bridge.receive(msg('m1')), 'stored')
  bridge.store.close(); t.done()
})

test('DSH and the Bridge derive the same revision, independent of order and case', () => {
  assert.equal(authzRevision(true, ['B', 'a', 'a']), bridgeRevision(true, ['a', 'b']))
  assert.notEqual(authzRevision(true, ['a']), authzRevision(false, ['a']))
  assert.notEqual(authzRevision(true, ['a']), authzRevision(true, ['a', 'b']))
})

const sourceOf = ({ config, configured = true, allowed = [] }) => ({
  source: { config: () => config, configured: () => configured, state: { get: () => 0, set() {} }, report(_entry, value) { this.last = value } },
  registry: { policyPart: () => ({ allowed: allowed.map(id => ({ id })) }), scope: () => ({ listened: true }) },
})

test('the Source snapshot is effective only when enabled, confirmed and non-empty; defaults grant nothing', () => {
  const cases = [
    [{ config: undefined, allowed: ['wxid_a'] }, false],
    [{ config: {}, allowed: ['wxid_a'] }, false],                  // old volume: enabled by default, never confirmed
    [{ config: { confirmed: true }, allowed: [] }, false],
    [{ config: { confirmed: true }, allowed: ['wxid_a'] }, true],
  ]
  for (const [input, effective] of cases) {
    const { source, registry } = sourceOf(input), s = authzSnapshot(source, registry)
    assert.equal(s.effective, effective, JSON.stringify(input))
    assert.equal(s.revision, bridgeRevision(s.effective, s.allowed))
    if (!effective) assert.deepEqual(s.allowed, [], 'an ineffective snapshot lists nobody')
  }
  const { source, registry } = sourceOf({ config: {}, allowed: ['wxid_a'] })
  assert.deepEqual(authzSnapshot(source, registry).status, { configuredEnabled: true, confirmed: false, dshConfigured: true })
})

test('the Source leaves messages in the Bridge until DSH setup completes and an operator confirmed it', async () => {
  let calls = 0
  const client = { call: async () => { calls++; return { messages: [] } } }
  for (const [input, detail] of [[{ config: { confirmed: true }, configured: false }, /DSH setup/], [{ config: {} }, /Not confirmed/]]) {
    const { source, registry } = sourceOf({ ...input, allowed: ['wxid_a'] })
    assert.equal(await pollOnce(source, client, registry), 0)
    assert.equal(source.last.state, 'paused'); assert.match(source.last.detail, detail)
  }
  assert.equal(calls, 0, 'the Bridge log was not read, so its cursor did not move')
})

// --- Admin API ---------------------------------------------------------------------------------------------------

test('admin and data tokens are scoped to their own routes', async () => {
  const t = dir(), bridge = make(t.file), http = await listen(bridge)
  try {
    assert.equal((await fetch(http.base + '/v1/admin/preflight', { headers: { ...auth(TOKEN), 'x-wechat-admin': '1' } })).status, 401)
    assert.equal((await fetch(http.base + '/v1/status', { headers: auth(ADMIN) })).status, 401)
    const put = token => fetch(http.base + '/v1/authz', { method: 'PUT', headers: { ...auth(token), 'content-type': 'application/json' }, body: JSON.stringify(snapshot(['wxid_a'])) })
    assert.equal((await put(ADMIN)).status, 401)
    assert.equal((await put(TOKEN)).status, 200)
    const bad = await fetch(http.base + '/v1/authz', { method: 'PUT', headers: { ...auth(TOKEN), 'content-type': 'application/json' }, body: JSON.stringify({ ...snapshot(['wxid_a']), allowed: ['wxid_b'] }) })
    assert.deepEqual([bad.status, (await bad.json()).error], [400, 'revision_mismatch'])
  } finally { await http.close(); bridge.store.close(); t.done() }
  assert.throws(() => make(t.file, { adminToken: TOKEN }), /must differ/)
})

test('admin routes refuse browser-originated and unmarked requests', async () => {
  const t = dir(), bridge = make(t.file), http = await listen(bridge)
  try {
    const status = async (path, init) => (await fetch(http.base + path, init)).status
    assert.equal(await status('/v1/admin/preflight', { headers: auth(ADMIN) }), 403, 'marker header required')
    assert.equal(await status('/v1/admin/preflight', { headers: { ...admin, origin: 'https://dsh.931217.xyz' } }), 403, 'no browser may call the Bridge directly')
    assert.equal(await status('/v1/admin/login', { method: 'POST', headers: admin, body: '{}' }), 415, 'simple-request bodies cannot start a login')
    assert.equal(await status('/v1/admin/login', { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: '{}' }), 409, 'mock provider has no login')
    assert.equal(await status('/v1/admin/preflight', { headers: admin }), 200)
  } finally { await http.close(); bridge.store.close(); t.done() }
})

test('preflight names each blocker and never echoes ids or tokens', async () => {
  const t = dir(), bridge = make(t.file, { allowedSenders: ['wxid_a'] }), http = await listen(bridge)
  try {
    const read = async () => { const r = await fetch(http.base + '/v1/admin/preflight', { headers: admin }); return { text: await r.clone().text(), body: await r.json() } }
    let { body } = await read()
    assert.equal(body.ready, false)
    assert.deepEqual(body.checks.filter(c => !c.ok).map(c => c.code).sort(),
      ['allowlist_empty', 'authz_missing', 'dsh_setup_pending', 'legacy_env_allowlist_set', 'provider_not_connected', 'source_disabled', 'source_not_confirmed'])
    bridge.setAuthz(snapshot(['wxid_a'], true, { ...STATUS, dshConfigured: false }))
    await bridge.start()
    ;({ body } = await read())
    assert.deepEqual(body.checks.filter(c => !c.ok).map(c => c.code), ['dsh_setup_pending', 'legacy_env_allowlist_set'])
    bridge.setAuthz(snapshot(['wxid_a']))
    const { text, body: ready } = await read()
    assert.equal(ready.ready, true, 'a warning does not block')
    for (const secret of ['wxid_a', TOKEN, ADMIN]) assert.ok(!text.includes(secret), 'preflight leaked ' + secret.slice(0, 6))
  } finally { await http.close(); bridge.store.close(); t.done() }
})

// --- Operator login ----------------------------------------------------------------------------------------------

/** Fake iLink login endpoints; `steps` scripts get_qrcode_status replies, and the last one repeats. */
async function loginFixture(steps, { ttlMs = 5000, loggedIn = false } = {}) {
  const t = dir(), polls = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake')
    let reply = {}
    if (url.pathname === '/ilink/bot/get_bot_qrcode') reply = { qrcode: 'Q', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/secret-qr' }
    if (url.pathname === '/ilink/bot/get_qrcode_status') { polls.push(url.searchParams.get('verify_code')); reply = steps.length > 1 ? steps.shift() : steps[0] }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const trust = url => url.startsWith('https://ilinkai') ? 'https://ilinkai.weixin.qq.com/' : new URL(url).origin + '/'
  const provider = new IlinkProvider({ stateFile: join(t.path, 'ilink.json') })
  if (loggedIn) { provider.state.data = { token: 'old-token' }; provider.state.save() }
  let nudged = 0; provider.nudge = () => nudged++
  const audit = []
  const manager = new LoginManager({ provider, client: () => new IlinkClient({ baseUrl: base, trust }), ttlMs, pollMs: 5, audit: (kind, detail) => audit.push([kind, detail]) })
  return { manager, provider, polls, audit, nudged: () => nudged, done: async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); t.done() } }
}
const CONFIRMED = { status: 'confirmed', bot_token: 'new-secret-token', ilink_bot_id: 'bot9', ilink_user_id: 'owner@im.wechat', baseurl: 'https://ilinkai.weixin.qq.com' }

test('login: scan, PIN and confirmation hand the new credentials to the running provider', async () => {
  const l = await loginFixture([{ status: 'wait' }, { status: 'scaned' }, { status: 'need_verifycode' }, { status: 'scaned' }, CONFIRMED])
  const started = l.manager.start()
  assert.match(started.id, /^[a-f0-9]{32}$/)
  await until(() => l.manager.status(started.id).state === 'need_pin')
  assert.ok(!('qr' in l.manager.status(started.id)), 'the QR is not shown while WeChat waits for the PIN')
  assert.throws(() => l.manager.submitPin(started.id, '12ab'), e => e.code === 'invalid_pin')
  l.manager.submitPin(started.id, '4821')
  assert.throws(() => l.manager.submitPin(started.id, '4821'), e => e.code === 'pin_not_requested', 'one PIN per request')
  await until(() => l.manager.status(started.id).state === 'confirmed')
  const view = l.manager.status(started.id)
  assert.deepEqual([view.userId, 'qr' in view], ['owner@im.wechat', false])
  assert.equal(l.provider.state.data.token, 'new-secret-token'); assert.equal(l.nudged(), 1)
  assert.ok(l.polls.includes('4821'))
  const trail = JSON.stringify(l.audit)
  for (const secret of ['new-secret-token', 'secret-qr', '4821', 'owner@im.wechat']) assert.ok(!trail.includes(secret), 'audit leaked ' + secret)
  await l.done()
})

test('login: one session at a time; force replaces it, and an existing login needs force', async () => {
  const l = await loginFixture([{ status: 'wait' }])
  const first = l.manager.start()
  assert.throws(() => l.manager.start(), e => e instanceof LoginError && e.status === 409 && e.code === 'login_in_progress')
  const second = l.manager.start({ force: true })
  await until(() => l.manager.session.state === 'waiting_scan')
  assert.throws(() => l.manager.status(first.id), e => e.status === 404, 'a replaced session is gone')
  assert.ok(l.manager.status(second.id).qr)
  l.manager.cancel(second.id)
  await until(() => l.manager.status(second.id).state === 'cancelled')
  await l.done()
  const bound = await loginFixture([{ status: 'wait' }], { loggedIn: true })
  assert.throws(() => bound.manager.start(), e => e.code === 'already_logged_in')
  bound.manager.cancel(bound.manager.start({ force: true }).id)
  await bound.done()
})

test('login: expiry, already-bound and repeated QR expiry end the session with a code', async () => {
  for (const [steps, over, state, code] of [
    [[{ status: 'wait' }], { ttlMs: 80 }, 'expired', undefined],
    [[{ status: 'binded_redirect' }], {}, 'failed', 'already_bound'],
    [[{ status: 'expired' }], {}, 'failed', 'qr_expired'],
    [[{ status: 'need_verifycode' }], { ttlMs: 120 }, 'expired', undefined],   // nobody typed the PIN in time
  ]) {
    const l = await loginFixture(steps, over), { id } = l.manager.start()
    await until(() => ['expired', 'failed', 'cancelled', 'confirmed'].includes(l.manager.status(id).state))
    assert.deepEqual([l.manager.status(id).state, l.manager.status(id).code], [state, code], JSON.stringify(steps))
    assert.equal(l.provider.state.data.token, undefined, 'no credentials were written')
    await l.done()
  }
})

test('login over HTTP: a reloaded page finds the session, unknown ids are 404, the QR never leaves the session view', async () => {
  const l = await loginFixture([{ status: 'wait' }, CONFIRMED])
  const t = dir(), bridge = make(t.file, { login: l.manager }), http = await listen(bridge)
  const call = (path, method = 'GET', body) => fetch(http.base + path, { method, headers: { ...admin, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  try {
    const { id } = await (await call('/v1/admin/login', 'POST', {})).json()
    const current = await (await call('/v1/admin/login')).json()
    assert.equal(current.active, true); assert.ok(!JSON.stringify(current).includes(id) && !('qr' in current))
    assert.equal((await call('/v1/admin/login/' + 'f'.repeat(32))).status, 404)
    assert.equal((await call('/v1/admin/login/not-an-id')).status, 404)
    assert.equal((await call(`/v1/admin/login/${id}/pin`, 'POST', { pin: '1234' })).status, 409)
    await until(() => l.manager.status(id).state === 'confirmed')
    assert.equal((await (await call('/v1/admin/login/' + id)).json()).userId, 'owner@im.wechat')
    assert.equal((await call('/v1/admin/login/' + id, 'DELETE')).status, 200)
  } finally { await http.close(); bridge.store.close(); t.done(); await l.done() }
})

// --- Wizard setup route ------------------------------------------------------------------------------------------

test('setup route: only an admitted, marked request reaches the Bridge, which alone sees the admin token', async () => {
  const t = dir(), file = join(t.path, 'admin-token'); writeFileSync(file, ADMIN + '\n')
  const { setupRoute, qrMatrix } = await import('./source/setup-route.js')
  const calls = []
  const bridge = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'x', state: 'waiting_scan', qr: 'https://liteapp.weixin.qq.com/q/abc' }), { status: 200 }) }
  let rejection = 401
  const route = setupRoute({ connection: { requestRejection: () => rejection } }, { bridgeUrl: 'http://wechat-bridge:8787', adminTokenFile: file }, bridge)
  const server = createServer(route); await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/wechat-setup/api`
  const go = (path, init = {}) => fetch(base + path, init)
  try {
    assert.equal((await go('/preflight', { headers: { 'x-wechat-setup': '1' } })).status, 401, 'no DSH session')
    rejection = undefined
    assert.equal((await go('/preflight')).status, 403, 'marker header required')
    assert.equal((await go('/settings', { headers: { 'x-wechat-setup': '1' } })).status, 404, 'only the fixed Bridge endpoints')
    assert.equal((await go('/login/' + 'f'.repeat(32) + '/pin', { method: 'GET', headers: { 'x-wechat-setup': '1' } })).status, 404, 'method is part of the allowlist')
    assert.equal((await go('/login', { method: 'POST', headers: { 'x-wechat-setup': '1' }, body: 'not json' })).status, 400)
    assert.equal(calls.length, 0, 'nothing reached the Bridge so far')
    const ok = await go('/login', { method: 'POST', headers: { 'x-wechat-setup': '1', 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) })
    const body = await ok.json()
    assert.equal(ok.status, 200)
    assert.equal(calls[0].url, 'http://wechat-bridge:8787/v1/admin/login')
    assert.equal(calls[0].init.headers.authorization, 'Bearer ' + ADMIN)
    assert.equal(calls[0].init.headers['x-wechat-admin'], '1')
    assert.ok(!JSON.stringify(body).includes(ADMIN), 'the token never reaches the browser')
    if (qrMatrix('x')) { assert.ok(Array.isArray(body.qrMatrix) && body.qrMatrix.every(row => /^[01]+$/.test(row)), 'QR travels as data, not markup') }
  } finally { await new Promise(r => server.close(r)); t.done() }
})
