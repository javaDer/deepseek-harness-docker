/**
 * Provider contract (all providers):
 *   start(onMessage) -> Promise<void>   onMessage({ id, chatId, chatType: 'direct'|'group', senderId, self, mentioned, text, at })
 *   send(chatId, text) -> Promise<void> resolves only once the provider accepted the message; throws { retryable } otherwise
 *   status() -> { connected: boolean, detail: string }
 *   stop() -> Promise<void>
 */
export class ProviderError extends Error {
  constructor(message, retryable) { super(message); this.retryable = retryable }
}

/** In-memory provider for tests and the default deployment; nothing leaves the container. */
export class MockProvider {
  constructor() { this.sent = []; this.failures = []; this.onMessage = undefined }
  async start(onMessage) { this.onMessage = onMessage }
  /** Test/operator hook: inject an inbound message as if WeChat delivered it. */
  inject(message) { return this.onMessage({ chatType: 'direct', self: false, mentioned: false, at: new Date().toISOString(), ...message }) }
  /** Test hook: queue failures ('retry' | 'fatal' | 'hang') consumed by the next sends. */
  fail(...kinds) { this.failures.push(...kinds) }
  async send(chatId, text) {
    const failure = this.failures.shift()
    if (failure === 'hang') return new Promise(() => {})
    if (failure) throw new ProviderError('mock ' + failure, failure === 'retry')
    this.sent.push({ chatId, text })
  }
  status() { return { connected: !!this.onMessage, detail: 'mock' } }
  async stop() { this.onMessage = undefined }
}

/**
 * EXPERIMENTAL, NOT VERIFIED: adapter for a separately installed `wechaty` package and puppet.
 * The image does not ship wechaty; personal-account login and send behaviour must be validated manually first.
 */
export class WechatyProvider {
  constructor(options) { this.options = options; this.bot = undefined; this.connected = false; this.detail = 'not started' }
  async start(onMessage) {
    let WechatyBuilder
    try { ({ WechatyBuilder } = await import('wechaty')) } catch { throw new Error('wechaty is not installed; WECHAT_PROVIDER=wechaty is experimental') }
    this.bot = WechatyBuilder.build({ name: this.options.name, puppet: this.options.puppet })
    this.bot.on('scan', (_qrcode, status) => { this.detail = 'waiting for manual QR login (' + status + ')' })
    this.bot.on('login', () => { this.connected = true; this.detail = 'logged in' })
    this.bot.on('logout', () => { this.connected = false; this.detail = 'logged out' })
    this.bot.on('message', async message => {
      if (message.type() !== this.bot.Message.Type.Text) return
      const room = message.room(), talker = message.talker()
      await onMessage({ id: message.id, chatId: room ? room.id : talker.id, chatType: room ? 'group' : 'direct', senderId: talker.id,
        self: message.self(), mentioned: room ? await message.mentionSelf() : false, text: message.text(), at: message.date().toISOString() })
    })
    await this.bot.start()
  }
  async send(chatId, text) {
    if (!this.connected) throw new ProviderError('not logged in', true)
    const target = (await this.bot.Contact.find({ id: chatId })) ?? (await this.bot.Room.find({ id: chatId }))
    if (!target) throw new ProviderError('unknown chat', false)
    await target.say(text)
  }
  status() { return { connected: this.connected, detail: this.detail } }
  async stop() { await this.bot?.stop() }
}

export function createProvider(env) {
  if ((env.WECHAT_PROVIDER ?? 'mock') === 'mock') return new MockProvider()
  if (env.WECHAT_PROVIDER === 'wechaty') return new WechatyProvider({ name: env.WECHATY_NAME ?? 'dsh-wechat', puppet: env.WECHATY_PUPPET })
  throw new Error('Unknown WECHAT_PROVIDER: ' + env.WECHAT_PROVIDER)
}
