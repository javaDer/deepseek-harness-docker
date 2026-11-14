/**
 * EXPERIMENTAL provider for Tencent's WeChat ClawBot (iLink Bot protocol, as implemented by
 * @tencent-weixin/openclaw-weixin): QR login, HTTP long-poll receive, text send. No OpenClaw runtime needed.
 * The service is in public beta and its text limits, rate limits and context_token lifetime are undocumented,
 * so every failure here ends in a terminal or backoff state and never in a blind resend.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ProviderError } from './providers.js'

export const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com'
// Protocol version the published plugin speaks; our own identity travels in the ignored suffix and in bot_agent.
const PROTOCOL_VERSION = '2.4.10'
const BASE_INFO = { channel_version: PROTOCOL_VERSION + '/dsh-wechat-bridge-0.1.0', bot_agent: 'DSHWeChatBridge/0.1.0' }
const clientVersion = () => String(PROTOCOL_VERSION.split('.').reduce((n, part) => (n << 8) | (Number.parseInt(part, 10) & 255), 0))
const UNSENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])

/** Credentials are only ever sent to Tencent hosts over HTTPS, including after a server-suggested redirect. */
export function trusted(url) {
  const u = new URL(url)
  if (u.protocol !== 'https:' || u.port || !/(^|\.)weixin\.qq\.com$/.test(u.hostname)) throw new Error('untrusted iLink host')
  return u.origin + '/'
}

// message_id / msg_id / svr_id are uint64: quote them before JSON.parse so they keep every digit.
const lossless = text => JSON.parse(text.replace(/"(message_id|msg_id|svr_id)"\s*:\s*(-?\d+)/g, '"$1":"$2"'))

export class IlinkClient {
  constructor({ baseUrl = DEFAULT_BASE, token, request = fetch, trust = trusted } = {}) { this.trust = trust; this.base = trust(baseUrl); this.token = token; this.request = request }
  rebase(url) { this.base = this.trust(url) }
  headers(auth) {
    return { 'content-type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
      'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': clientVersion(), ...(auth && this.token ? { Authorization: 'Bearer ' + this.token } : {}) }
  }
  async call(method, path, { body, auth = true, signal, timeoutMs = 15000 } = {}) {
    const response = await this.request(new URL(path, this.base), { method, redirect: 'error', headers: this.headers(auth),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      ...(method === 'POST' ? { body: JSON.stringify(auth ? { ...body, base_info: BASE_INFO } : body ?? {}) } : {}) })
    if (!response.ok) throw Object.assign(new Error('iLink http ' + response.status), { status: response.status })
    return lossless(await response.text())
  }
  getUpdates(buf, signal, timeoutMs) { return this.call('POST', 'ilink/bot/getupdates', { body: { get_updates_buf: buf ?? '' }, signal, timeoutMs }) }
  sendMessage(msg) { return this.call('POST', 'ilink/bot/sendmessage', { body: { msg } }) }
  notify(kind) { return this.call('POST', 'ilink/bot/msg/notify' + kind, { body: {}, timeoutMs: 5000 }) }
}

/** Credentials, long-poll cursor and per-chat reply context; kept on the data volume with mode 0600, never logged. */
export class IlinkState {
  constructor(file) { this.file = file; this.load() }
  load() { try { this.data = JSON.parse(readFileSync(this.file, 'utf8')) } catch { this.data = {} } return this.data }
  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 }); renameSync(this.file + '.tmp', this.file)
  }
}

export class IlinkProvider {
  constructor({ stateFile, baseUrl, request, trust, pauseMs = 3600000, idleMs = 5000, retryMs = 1000 } = {}) {
    this.state = new IlinkState(stateFile); this.baseUrl = baseUrl; this.request = request; this.trust = trust
    this.pauseMs = pauseMs; this.idleMs = idleMs; this.retryMs = retryMs
    this.connected = false; this.detail = 'not started'; this.stopped = true; this.client = undefined; this.abort = undefined; this.wake = undefined
  }
  sleep(ms) { return new Promise(resolve => { const timer = setTimeout(resolve, ms); this.wake = () => { clearTimeout(timer); resolve() } }) }
  async start(onMessage) { this.onMessage = onMessage; this.stopped = false; this.abort = new AbortController(); this.loop = this.run() }
  async run() {
    let delay = this.retryMs, pollMs = 35000
    while (!this.stopped) {
      const { token, baseUrl } = this.state.data.token ? this.state.data : this.state.load()
      if (!token) { this.connected = false; this.detail = 'login required: run ilink-login.js inside the bridge container'; await this.sleep(this.idleMs); continue }
      try {
        if (!this.client || this.client.token !== token) {
          this.client = new IlinkClient({ baseUrl: baseUrl ?? this.baseUrl, token, request: this.request, trust: this.trust })
          await this.client.notify('start').catch(() => {})
        }
        const response = await this.client.getUpdates(this.state.data.buf, this.abort.signal, pollMs + 5000)
        const code = response.errcode || response.ret
        if (code === -14) { this.connected = false; this.detail = 'session expired (-14); paused'; await this.sleep(this.pauseMs); continue }
        if (code) throw Object.assign(new Error('iLink ret ' + code), { code })
        for (const message of response.msgs ?? []) await this.deliver(message)
        // The cursor moves only after every message of the batch reached the Bridge store.
        if (response.get_updates_buf) { this.state.data.buf = response.get_updates_buf; this.state.save() }
        if (response.longpolling_timeout_ms > 0) pollMs = response.longpolling_timeout_ms
        this.connected = true; this.detail = 'logged in'; delay = this.retryMs
      } catch (error) {
        if (this.stopped) break
        this.connected = false; this.detail = 'poll failed: ' + (error.status ?? error.code ?? error.name)
        await this.sleep(delay); delay = Math.min(delay * 2, 60000)
      }
    }
  }
  async deliver(m) {
    // Only text the user typed is read; voice transcripts, images and files are ignored as untrusted input.
    if (m.message_type !== 1 || typeof m.from_user_id !== 'string') return
    if (m.context_token) { (this.state.data.ctx ??= {})[m.from_user_id] = m.context_token; this.state.save() }
    const text = (m.item_list ?? []).filter(item => item.type === 1).map(item => item.text_item?.text ?? '').join('\n').trim()
    if (!text) return
    const group = typeof m.group_id === 'string' && m.group_id
    await this.onMessage({ id: String(m.message_id ?? `${m.from_user_id}:${m.client_id ?? m.seq}`), chatId: group || m.from_user_id, chatType: group ? 'group' : 'direct',
      senderId: m.from_user_id, self: false, mentioned: false, text, at: new Date(m.create_time_ms ?? Date.now()).toISOString() })
  }
  async send(chatId, text) {
    if (!this.client) throw new ProviderError('not logged in', true)
    const context = this.state.data.ctx?.[chatId]
    let response
    try {
      response = await this.client.sendMessage({ from_user_id: '', to_user_id: chatId, client_id: randomUUID(), message_type: 2, message_state: 2,
        ...(context ? { context_token: context } : {}), item_list: [{ type: 1, text_item: { text } }] })
    } catch (error) {
      // Only a failure before any byte left the host is safe to retry; anything else may have been delivered.
      throw new ProviderError('iLink send failed', UNSENT.has(error.cause?.code))
    }
    const code = response.errcode || response.ret
    if (code) throw new ProviderError('iLink rejected (' + code + ')', code === -14)
  }
  status() { return { connected: this.connected, detail: this.detail } }
  async stop() {
    this.stopped = true; this.abort?.abort(); this.wake?.()
    await this.loop?.catch(() => {})
    await this.client?.notify('stop').catch(() => {})
  }
}

/**
 * Operator-driven QR login. Nothing here runs automatically: a person scans with their own WeChat.
 * onQr(url) shows the link to encode as a QR code, readPin() returns the digits WeChat shows when asked.
 */
export async function loginWithQr({ client, state, onQr, readPin, onStatus = () => {}, timeoutMs = 480000, pollMs = 35000, refreshLimit = 3 }) {
  const fetchQr = async () => {
    const qr = await client.call('POST', 'ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] }, auth: false })
    onQr(qr.qrcode_img_content); return qr.qrcode
  }
  let qrcode = await fetchQr(), refreshes = 1, pin
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    let reply
    try {
      reply = await client.call('GET', `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${pin ? '&verify_code=' + encodeURIComponent(pin) : ''}`, { auth: false, timeoutMs: pollMs + 5000 })
    } catch { reply = { status: 'wait' } } // gateway timeouts and client timeouts just mean "keep waiting"
    onStatus(reply.status)
    switch (reply.status) {
      case 'scaned': pin = undefined; break
      case 'need_verifycode': pin = await readPin(); continue
      case 'scaned_but_redirect': if (reply.redirect_host) client.rebase('https://' + reply.redirect_host); break
      case 'binded_redirect': return { ok: false, reason: 'already bound; existing credentials stay valid' }
      case 'expired': case 'verify_code_blocked':
        pin = undefined
        if (++refreshes > refreshLimit) return { ok: false, reason: 'QR code expired too many times' }
        qrcode = await fetchQr(); break
      case 'confirmed': {
        if (!reply.bot_token || !reply.ilink_bot_id) return { ok: false, reason: 'server did not return credentials' }
        state.data = { token: reply.bot_token, botId: reply.ilink_bot_id, baseUrl: reply.baseurl || client.base, userId: reply.ilink_user_id, buf: '', ctx: {} }
        client.trust(state.data.baseUrl); state.save()
        return { ok: true, userId: reply.ilink_user_id }
      }
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, pollMs)))
  }
  return { ok: false, reason: 'login timed out' }
}
