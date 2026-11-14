import { createServer } from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import { BridgeStore } from './store.js'
import { LoginError } from './login.js'

const ID = /^[A-Za-z0-9_@.:-]{1,128}$/
export const MAX_TEXT = 4000
export const MAX_ALLOWED = 200
/** Log-safe identifier: a short hash, never the raw WeChat id or message text. */
export const mask = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 8)
/** Content address of an authorization snapshot; source/protocol.js computes the same value on the DSH side. */
export const authzRevision = (effective, allowed) =>
  createHash('sha256').update(JSON.stringify([effective === true, [...new Set(allowed.map(id => id.toLowerCase()))].sort()])).digest('hex')

export function normalize(raw) {
  const m = { id: raw?.id, chatId: raw?.chatId, chatType: raw?.chatType, senderId: raw?.senderId, self: raw?.self === true,
    mentioned: raw?.mentioned === true, text: raw?.text, at: raw?.at }
  if (![m.id, m.chatId, m.senderId].every(v => typeof v === 'string' && ID.test(v))) throw new Error('invalid ids')
  if (m.chatType !== 'direct' && m.chatType !== 'group') throw new Error('invalid chatType')
  if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > MAX_TEXT) throw new Error('invalid text')
  if (typeof m.at !== 'string' || !Number.isFinite(Date.parse(m.at))) throw new Error('invalid time')
  return { ...m, at: new Date(m.at).toISOString() }
}

class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code } }

export class Bridge {
  /**
   * `allowedSenders` is the legacy WECHAT_ALLOWED_SENDERS list: it can only narrow the DSH snapshot, never widen it.
   * `adminToken` guards login and preflight; the data `token` cannot reach those routes, and vice versa.
   */
  constructor({ provider, file, token, adminToken, login, groups = false, allowedSenders = [], authzTtlMs = 300000, sendTimeoutMs = 15000, log = () => {}, now = () => Date.now() }) {
    for (const value of [token, ...(adminToken === undefined ? [] : [adminToken])])
      if (typeof value !== 'string' || value.length < 32 || /\s/.test(value)) throw new Error('Bridge requires 32+ character tokens')
    if (adminToken !== undefined && adminToken === token) throw new Error('admin and data tokens must differ')
    this.provider = provider; this.token = token; this.adminToken = adminToken; this.login = login; this.groups = groups
    this.legacy = new Set(allowedSenders.map(id => id.toLowerCase())); this.authzTtlMs = authzTtlMs
    this.sendTimeoutMs = sendTimeoutMs; this.log = log; this.now = now; this.store = new BridgeStore(file, now); this.busy = undefined
  }
  /** Why a sender may not create new business messages right now, or undefined when the DSH snapshot admits them. */
  authzReason(senderId) {
    const snapshot = this.store.authz()
    if (!snapshot) return 'authz_missing'
    if (this.now() - snapshot.receivedAt > this.authzTtlMs) return 'authz_stale'
    if (!snapshot.effective) return 'source_not_effective'
    const sender = senderId.toLowerCase()
    if (!snapshot.allowed.includes(sender)) return 'sender_not_authorized'
    if (this.legacy.size && !this.legacy.has(sender)) return 'sender_not_in_legacy_env'
  }
  /** Provider callback: validate, drop self/disabled-group/unauthorized messages, then persist idempotently. */
  receive(raw) {
    let m
    try { m = normalize(raw) } catch (error) { this.store.audit('inbound_rejected', { reason: error.message }); return 'rejected' }
    const drop = m.self ? 'self' : m.chatType === 'group' && !this.groups ? 'group_disabled' : this.authzReason(m.senderId)
    if (drop) { this.store.audit('inbound_dropped', { reason: drop, sender: mask(m.senderId) }); return 'dropped' }
    const result = this.store.addInbound(m)
    this.store.audit('inbound_' + result, { id: mask(m.id), sender: mask(m.senderId) })
    return result
  }
  /** Replaces the authorization snapshot DSH pushed; the revision must be the content address of what it carries. */
  setAuthz(body) {
    const { revision, effective, allowed, status } = body ?? {}
    if (typeof effective !== 'boolean' || !Array.isArray(allowed) || allowed.length > MAX_ALLOWED || !allowed.every(id => typeof id === 'string' && ID.test(id)))
      throw new HttpError(400, 'invalid_authz')
    if (typeof revision !== 'string' || revision !== authzRevision(effective, allowed)) throw new HttpError(400, 'revision_mismatch')
    const dsh = { configuredEnabled: status?.configuredEnabled === true, confirmed: status?.confirmed === true, dshConfigured: status?.dshConfigured === true }
    const previous = this.store.authz()
    this.store.saveAuthz({ revision, effective, allowed: [...new Set(allowed.map(id => id.toLowerCase()))].sort(), status: dsh, receivedAt: this.now() })
    if (previous?.revision !== revision) this.store.audit('authz_updated', { revision: revision.slice(0, 12), effective, allowed: allowed.length })
    return { revision, changed: previous?.revision !== revision }
  }
  /** Structured readiness checks for the operator; ids and tokens are never included. */
  preflight() {
    const snapshot = this.store.authz(), age = snapshot ? this.now() - snapshot.receivedAt : undefined
    const provider = this.provider.status(), counts = this.store.counts()
    const check = (id, ok, level, code, extra = {}) => ({ id, ok, ...(ok ? {} : { level, code }), ...extra })
    const stuck = (counts.unknown ?? 0) + (counts.failed ?? 0)
    const checks = [
      check('bridge', true),
      check('provider_login', provider.connected, 'blocking', 'provider_not_connected', { detail: provider.detail }),
      check('authz_snapshot', !!snapshot && age <= this.authzTtlMs, 'blocking', snapshot ? 'authz_stale' : 'authz_missing',
        snapshot ? { revision: snapshot.revision.slice(0, 12), ageSeconds: Math.round(age / 1000) } : {}),
      check('source_enabled', !!snapshot?.status.configuredEnabled, 'blocking', 'source_disabled'),
      check('source_confirmed', !!snapshot?.status.confirmed, 'blocking', 'source_not_confirmed'),
      check('allowlist', (snapshot?.allowed.length ?? 0) > 0, 'blocking', 'allowlist_empty', { allowed: snapshot?.allowed.map(mask) ?? [] }),
      check('dsh_setup', !!snapshot?.status.dshConfigured, 'blocking', 'dsh_setup_pending'),
      check('legacy_env_allowlist', this.legacy.size === 0, 'warning', 'legacy_env_allowlist_set'),
      check('outbound_unconfirmed', stuck === 0, 'warning', 'delivery_unconfirmed', { count: stuck }),
    ]
    return { ready: checks.every(c => c.ok || c.level !== 'blocking'), checks, effective: !!snapshot?.effective && age <= this.authzTtlMs }
  }
  async start() { await this.provider.start(raw => this.receive(raw)) }
  /** Delivers due messages one at a time; a timeout leaves the message `unknown` and it is never resent automatically. */
  async dispatch() {
    if (this.busy) return this.busy
    this.busy = (async () => {
      for (let m; (m = this.store.claim());) {
        let timer
        try {
          await Promise.race([this.provider.send(m.chatId, m.text),
            new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { timeout: true })), this.sendTimeoutMs) })])
          this.store.settle(m.id, 'sent')
        } catch (error) {
          this.store.settle(m.id, error.timeout ? 'unknown' : error.retryable ? 'retry' : 'failed', error.timeout ? 'send timed out; delivery unconfirmed' : 'provider rejected')
        } finally { clearTimeout(timer) }
        const after = this.store.outbound(m.id)
        this.store.audit('outbound_' + after.state, { id: mask(m.id), attempts: after.attempts })
        this.log(`outbound ${mask(m.id)} ${after.state} attempt=${after.attempts}`)
      }
    })().finally(() => { this.busy = undefined })
    return this.busy
  }
  authorized(req, token = this.token) {
    if (token === undefined) return false
    const actual = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + token)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  /** Admin calls come only from the DSH plugin process: no browser Origin, an explicit marker header, JSON bodies. */
  admin(req) {
    if (!this.authorized(req, this.adminToken)) throw new HttpError(401, 'unauthorized')
    if (req.headers.origin !== undefined) throw new HttpError(403, 'browser_origin_rejected')
    if (req.headers['x-wechat-admin'] !== '1') throw new HttpError(403, 'admin_marker_required')
    if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'json_required')
  }
  server({ mockInject = false } = {}) {
    const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const body = async req => {
      let size = 0; const chunks = []
      for await (const chunk of req) { if ((size += chunk.length) > 65536) throw new Error('too large'); chunks.push(chunk) }
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    }
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://bridge')
      try {
        if (req.method === 'GET' && url.pathname === '/healthz') { json(res, 200, { ok: true }); return }
        if (url.pathname.startsWith('/v1/admin/')) { this.admin(req); json(res, 200, await this.adminRoute(req, url, body)); return }
        if (!this.authorized(req)) { json(res, 401, { error: 'unauthorized' }); return }
        if (req.method === 'GET' && url.pathname === '/v1/status') { json(res, 200, { provider: this.provider.status(), outbound: this.store.counts() }); return }
        if (req.method === 'PUT' && url.pathname === '/v1/authz') { json(res, 200, this.setAuthz(await body(req))); return }
        if (req.method === 'GET' && url.pathname === '/v1/inbound') {
          const after = Math.max(0, Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0)
          json(res, 200, { messages: this.store.inbound(after, 100) }); return
        }
        if (req.method === 'POST' && url.pathname === '/v1/outbound') {
          const { id, chatId, text } = await body(req)
          if (typeof id !== 'string' || !ID.test(id) || typeof chatId !== 'string' || !ID.test(chatId) || typeof text !== 'string' || !text || text.length > MAX_TEXT) { json(res, 400, { error: 'invalid message' }); return }
          const m = this.store.enqueue({ id, chatId, text })
          if (!m) { json(res, 409, { error: 'id reused with different content' }); return }
          this.dispatch().catch(() => {})
          json(res, 200, { id, state: m.state }); return
        }
        const out = /^\/v1\/outbound\/([A-Za-z0-9_@.:-]{1,128})$/.exec(url.pathname)
        if (req.method === 'GET' && out) { const m = this.store.outbound(out[1]); json(res, m ? 200 : 404, m ? { id: m.id, state: m.state, attempts: m.attempts } : { error: 'not found' }); return }
        if (mockInject && req.method === 'POST' && url.pathname === '/v1/mock/inject') { json(res, 200, { result: await this.provider.inject(await body(req)) }); return }
        json(res, 404, { error: 'not found' })
      } catch (error) {
        if (error instanceof HttpError || error instanceof LoginError) json(res, error.status, { error: error.code })
        else json(res, 400, { error: 'bad request' })
      }
    })
    server.headersTimeout = 10000; server.requestTimeout = 15000
    return server
  }
  async adminRoute(req, url, body) {
    if (req.method === 'GET' && url.pathname === '/v1/admin/preflight') return this.preflight()
    if (!url.pathname.startsWith('/v1/admin/login')) throw new HttpError(404, 'not_found')
    if (!this.login) throw new HttpError(409, 'login_unsupported')
    if (url.pathname === '/v1/admin/login') {
      if (req.method === 'GET') return this.login.current()
      if (req.method === 'POST') { const { force } = await body(req); return this.login.start({ force: force === true }) }
    }
    const route = /^\/v1\/admin\/login\/([^/]+)(\/pin)?$/.exec(url.pathname)
    if (!route) throw new HttpError(404, 'not_found')
    if (route[2] && req.method === 'POST') { const { pin } = await body(req); return this.login.submitPin(route[1], pin) }
    if (!route[2] && req.method === 'GET') return this.login.status(route[1])
    if (!route[2] && req.method === 'DELETE') return this.login.cancel(route[1])
    throw new HttpError(405, 'method_not_allowed')
  }
  async stop() { await this.busy; await this.provider.stop(); this.store.close() }
}
