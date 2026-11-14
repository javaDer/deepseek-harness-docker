/**
 * Operator login sessions for the ClawBot (iLink) provider, driven through the Bridge admin API.
 * One session at a time, an unguessable id per session, a hard expiry, and a PIN accepted only while WeChat asks
 * for one. Views never carry the bot token; the QR link only while a scan is still possible.
 */
import { randomBytes } from 'node:crypto'
import { loginWithQr } from './ilink.js'

const TERMINAL = new Set(['confirmed', 'failed', 'cancelled', 'expired'])
const PIN = /^\d{4,8}$/
const SESSION_ID = /^[a-f0-9]{32}$/

export class LoginError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}

export class LoginManager {
  constructor({ provider, client, ttlMs = 8 * 60000, pollMs, audit = () => {} }) {
    this.provider = provider; this.client = client; this.ttlMs = ttlMs; this.pollMs = pollMs; this.audit = audit; this.session = undefined
  }
  active() { return this.session && !TERMINAL.has(this.session.state) ? this.session : undefined }
  /** Starts a login; refuses while another runs or while already logged in, unless the operator forces a replacement. */
  start({ force = false } = {}) {
    const running = this.active()
    if (running && !force) throw new LoginError(409, 'login_in_progress')
    if (!running && !force && this.provider.loggedIn()) throw new LoginError(409, 'already_logged_in')
    running?.controller.abort('cancelled')
    const controller = new AbortController()
    const session = { id: randomBytes(16).toString('hex'), state: 'starting', qr: undefined, userId: undefined, code: undefined,
      expiresAt: Date.now() + this.ttlMs, controller, pin: undefined }
    this.session = session
    const timer = setTimeout(() => controller.abort('expired'), this.ttlMs)
    this.audit('login_started', { session: session.id.slice(0, 8), forced: force })
    const readPin = () => new Promise((resolve, reject) => {
      session.state = 'need_pin'; session.pin = resolve
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    const onStatus = status => { if (status === 'scaned' && session.state !== 'need_pin') session.state = 'scanned' }
    const client = this.client()
    // The session timer, not loginWithQr's own deadline, ends an idle login, so it always reads as `expired`.
    loginWithQr({ client, state: this.provider.state, signal: controller.signal, readPin, onStatus, timeoutMs: this.ttlMs + 60000, ...(this.pollMs ? { pollMs: this.pollMs } : {}),
      onQr: url => { session.qr = url; session.state = 'waiting_scan' } })
      .then(result => {
        if (result.ok) { session.state = 'confirmed'; session.userId = result.userId; this.provider.nudge?.() }
        else { session.state = 'failed'; session.code = result.code }
      }, () => {
        const reason = controller.signal.reason
        session.state = reason === 'expired' ? 'expired' : reason === 'cancelled' ? 'cancelled' : 'failed'
        if (session.state === 'failed') session.code = 'login_error'
      })
      .finally(() => { clearTimeout(timer); session.pin = undefined; session.qr = undefined; this.audit('login_' + session.state, { session: session.id.slice(0, 8), code: session.code ?? null }) })
    return this.view(session)
  }
  find(id) {
    if (typeof id !== 'string' || !SESSION_ID.test(id) || this.session?.id !== id) throw new LoginError(404, 'login_not_found')
    return this.session
  }
  status(id) { return this.view(this.find(id)) }
  submitPin(id, pin) {
    const session = this.find(id)
    if (session.state !== 'need_pin' || !session.pin) throw new LoginError(409, 'pin_not_requested')
    if (typeof pin !== 'string' || !PIN.test(pin)) throw new LoginError(400, 'invalid_pin')
    const resolve = session.pin; session.pin = undefined; session.state = 'scanned'; resolve(pin)
    return this.view(session)
  }
  cancel(id) {
    const session = this.find(id)
    if (!TERMINAL.has(session.state)) session.controller.abort('cancelled')
    return this.view(session)
  }
  /** Lets a reloaded page find the running session again; it still needs the id to read the QR link. */
  current() { const s = this.active(); return s ? { active: true, state: s.state, expiresAt: new Date(s.expiresAt).toISOString() } : { active: false } }
  view(s) {
    return { id: s.id, state: s.state, expiresAt: new Date(s.expiresAt).toISOString(),
      ...(s.qr && (s.state === 'waiting_scan' || s.state === 'scanned') ? { qr: s.qr } : {}),
      ...(s.state === 'confirmed' ? { userId: s.userId } : {}), ...(s.code ? { code: s.code } : {}) }
  }
}
