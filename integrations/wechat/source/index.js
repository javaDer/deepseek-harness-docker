/**
 * WeChat Source plugin for DSH SuperAgent (experimental).
 *
 * The Bridge owns the WeChat account; this plugin only reads its ordered inbound log and posts replies back.
 * Every message except a read-only command is handed to `SourceContext.receive`, so the Engine's Policy and
 * Eval stay the only gate. Nothing here stores credentials or decides who may start work.
 */
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { SOURCE, key, pollOnce, authzSnapshot } from './protocol.js'

export { SOURCE, CURSOR, triggerId, wechatTrigger, describeTicket, command, pollOnce, authzSnapshot, authzRevision } from './protocol.js'

export const name = 'dsh-superagent-wechat'
export const inject = ['orchestrator']
const ID = /^[A-Za-z0-9_@.:-]{1,128}$/
/** Re-push an unchanged snapshot this often; the Bridge's default freshness window is five minutes. */
const AUTHZ_HEARTBEAT_MS = 30000
export const Config = schema.object({
  bridgeUrl: schema.string().default('http://wechat-bridge:8787'),
  tokenFile: schema.string().default('/run/secrets/wechat-bridge-token'),
  pollMs: schema.number().step(1).min(500).max(60000).default(2000),
})
/** `directMessages`/`groups` mirror the Bridge's own filters; both must allow a chat for it to be read. */
export const ConfigSchema = z.object({ directMessages: z.boolean().default(true), groups: z.boolean().default(false), confirmed: z.boolean().default(false) }).strict()

export class BridgeClient {
  constructor({ bridgeUrl, tokenFile }, request = fetch) { this.url = bridgeUrl.replace(/\/$/, ''); this.tokenFile = tokenFile; this.request = request }
  async call(path, body, method = body ? 'POST' : 'GET') {
    const token = readFileSync(this.tokenFile, 'utf8').trim()
    const response = await this.request(this.url + path, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) { const error = new Error('bridge http ' + response.status); error.status = response.status; throw error }
    return response.json()
  }
}

export function wechatKind(client) {
  const kind = {
    kind: SOURCE, title: { zh: '微信（实验）', en: 'WeChat (experimental)' },
    description: { zh: '经 WeChat Bridge 接收私聊消息；群聊默认关闭。', en: 'Receives direct messages through the WeChat Bridge; groups are off by default.' },
    schema: ConfigSchema,
    fields: [
      { key: 'confirmed', type: 'switch', label: { zh: '确认启用', en: 'Confirmed' },
        hint: { zh: '核对下方允许的联系人后再打开。未确认时 Bridge 拒收所有新消息。扫码登录和名单都不授予 Git Push、MR、DDL、Nacos 等高风险操作。',
          en: 'Turn on after reviewing the allowed contacts. Until then the Bridge refuses all new messages. Neither QR login nor the list grants Git push, MRs, DDL or Nacos changes.' } },
      { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
      { key: 'groups', type: 'switch', label: { zh: '接收群聊 @', en: 'Group @mentions' },
        hint: { zh: '默认关闭。群内只接收 @ 机器人的消息。', en: 'Off by default. Only messages that mention the bot are read in groups.' } },
    ],
    health: ['wechat'],
    scope({ meta }, config) {
      if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
      return config.groups && meta.mentioned === true ? { listened: true, observed: false, row: 'group' } : { listened: false, reason: 'chat_not_allowed' }
    },
    channel: {
      allowed: (address, config) => address.direct === 'true' ? config.directMessages !== false : config.groups === true,
      async send(_host, message) {
        const chatId = message.channel.address?.chatId
        if (!chatId || !ID.test(chatId)) return 'gone'
        const id = key(message.id)
        try { await client.call('/v1/outbound', { id, chatId, text: message.text }) }
        catch (error) {
          // 409: this id already carried different text, so resending cannot be right.
          if (error.status === 409) return 'gone'
          throw error
        }
        const { state } = await client.call('/v1/outbound/' + id)
        if (state === 'sent') return 'sent'
        // Unconfirmed or rejected sends are terminal: never resend a message that may already have arrived.
        if (state === 'failed' || state === 'unknown') return 'gone'
        throw new Error('WeChat delivery pending')
      },
      link: () => ({ url: '', label: { zh: '微信会话', en: 'WeChat chat' } }),
    },
    policy: {
      unnamed: { person: { zh: '微信联系人', en: 'WeChat contact' }, bot: { zh: '微信机器人', en: 'WeChat bot' } },
      schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().regex(ID), name: z.string().trim().max(100).optional() }).strict())
        .refine(list => new Set(list.map(e => e.id.toLowerCase())).size === list.length, 'Duplicate WeChat ids').default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的微信联系人 ID', en: 'WeChat contact IDs who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '联系人 ID（非昵称）', en: 'Contact ID (not nickname)' }, pattern: ID.source },
          { key: 'name', type: 'text', label: { zh: '备注', en: 'Note' }, optional: true }] }],
      explicit: { zh: '名单内的人私聊机器人，或在已开启的群里 @ 机器人，是明确的请求。', en: 'A listed contact who messages the bot directly, or mentions it in an enabled group, makes an explicit request.' },
      rows(stored) {
        const config = ConfigSchema.parse(stored)
        return [
          { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Read' } : { zh: '不接收', en: 'Not read' },
            cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
          { id: 'group', label: { zh: '群聊', en: 'Groups' }, note: config.groups ? { zh: '仅 @', en: '@ only' } : { zh: '不接收', en: 'Not read' },
            cells: { listedUnaddressed: false, unlistedAddressed: config.groups, unlistedUnaddressed: false } },
        ]
      },
    },
  }
  return kind
}

export function apply(ctx, config) {
  const client = new BridgeClient(config)
  const kind = wechatKind(client)
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'wechat: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = loop(ctx.orchestrator.context(kind), client, ctx.orchestrator.sources, config, controller.signal)
    return async () => { controller.abort(); await running }
  })
}

async function loop(source, client, registry, config, signal) {
  let failures = 0, pushed, pushedAt = 0
  await source.ready
  while (!signal.aborted) {
    // Keep the Bridge's snapshot current: on every change, and as a heartbeat well inside its freshness window.
    let authzError
    const snapshot = authzSnapshot(source, registry)
    if (snapshot.revision !== pushed || Date.now() - pushedAt > AUTHZ_HEARTBEAT_MS) {
      try {
        const ack = await client.call('/v1/authz', snapshot, 'PUT')
        if (ack.revision !== snapshot.revision) throw new Error('Bridge stored another revision')
        pushed = snapshot.revision; pushedAt = Date.now()
      } catch (error) { pushed = undefined; authzError = error }
    }
    try {
      await pollOnce(source, client, registry); failures = 0
      // The Bridge refuses new messages while its snapshot is missing or stale, so a failed push is an error, not a pause.
      if (authzError) source.report('wechat', { state: 'error', detail: `Allowlist sync failed: ${String(authzError.message).slice(0, 120)}` })
    } catch (error) {
      failures++
      source.report('wechat', { state: 'error', detail: `${failures} consecutive failed polls; last: ${String(error.message).slice(0, 120)}` })
    }
    await new Promise(resolve => {
      const timer = setTimeout(resolve, config.pollMs)
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
}
