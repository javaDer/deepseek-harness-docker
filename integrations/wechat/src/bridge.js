import { createServer } from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import { BridgeStore } from './store.js'

const ID = /^[A-Za-z0-9_@.:-]{1,128}$/
export const MAX_TEXT = 4000
/** Log-safe identifier: a short hash, never the raw WeChat id or message text. */
export const mask = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 8)

export function normalize(raw) {
  const m = { id: raw?.id, chatId: raw?.chatId, chatType: raw?.chatType, senderId: raw?.senderId, self: raw?.self === true,
    mentioned: raw?.mentioned === true, text: raw?.text, at: raw?.at }
  if (![m.id, m.chatId, m.senderId].every(v => typeof v === 'string' && ID.test(v))) throw new Error('invalid ids')
  if (m.chatType !== 'direct' && m.chatType !== 'group') throw new Error('invalid chatType')
  if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > MAX_TEXT) throw new Error('invalid text')
  if (typeof m.at !== 'string' || !Number.isFinite(Date.parse(m.at))) throw new Error('invalid time')
  return { ...m, at: new Date(m.at).toISOString() }
}

export class Bridge {
  constructor({ provider, file, token, groups = false, allowedSenders = [], sendTimeoutMs = 15000, log = () => {}, now }) {
    if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw new Error('Bridge requires a 32+ character token')
    this.provider = provider; this.token = token; this.groups = groups; this.allowed = new Set(allowedSenders)
    this.sendTimeoutMs = sendTimeoutMs; this.log = log; this.store = new BridgeStore(file, now); this.busy = undefined
  }
  /** Provider callback: validate, drop self/disabled-group/unlisted messages, then persist idempotently. */
  receive(raw) {
    let m
    try { m = normalize(raw) } catch (error) { this.store.audit('inbound_rejected', { reason: error.message }); return 'rejected' }
    const drop = m.self ? 'self' : m.chatType === 'group' && !this.groups ? 'group_disabled'
      : this.allowed.size && !this.allowed.has(m.senderId) ? 'sender_not_allowed' : undefined
    if (drop) { this.store.audit('inbound_dropped', { reason: drop, sender: mask(m.senderId) }); return 'dropped' }
    const result = this.store.addInbound(m)
    this.store.audit('inbound_' + result, { id: mask(m.id), sender: mask(m.senderId) })
    return result
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
  authorized(req) {
    const actual = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + this.token)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  server({ mockInject = false } = {}) {
    const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const body = async req => {
      let size = 0; const chunks = []
      for await (const chunk of req) { if ((size += chunk.length) > 65536) throw new Error('too large'); chunks.push(chunk) }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://bridge')
      try {
        if (req.method === 'GET' && url.pathname === '/healthz') { json(res, 200, { ok: true }); return }
        if (!this.authorized(req)) { json(res, 401, { error: 'unauthorized' }); return }
        if (req.method === 'GET' && url.pathname === '/v1/status') { json(res, 200, { provider: this.provider.status(), outbound: this.store.counts() }); return }
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
      } catch { json(res, 400, { error: 'bad request' }) }
    })
    server.headersTimeout = 10000; server.requestTimeout = 15000
    return server
  }
  async stop() { await this.busy; await this.provider.stop(); this.store.close() }
}
