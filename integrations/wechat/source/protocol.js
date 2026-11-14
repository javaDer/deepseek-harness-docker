/**
 * WeChat Source protocol layer: Bridge message → Trigger, read-only commands, and one poll cycle.
 * Imports only Node built-ins so it can be tested without the DSH runtime's zod/schemastery peers.
 */
import { createHash } from 'node:crypto'

export const SOURCE = 'wechat'
export const CURSOR = 'wechat-cursor'
/** Same derivation as the core's `key()` so Trigger ids survive restarts. */
export const key = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
export const triggerId = messageId => key(SOURCE, messageId)

/** Bridge message → Trigger. Text is untrusted; `human` only means a person, not this bot, wrote it. */
export function wechatTrigger(m) {
  const direct = m.chatType === 'direct'
  return { id: triggerId(m.id), source: SOURCE, threads: [{ source: SOURCE, id: m.chatId }],
    actor: { source: SOURCE, id: m.senderId }, human: true,
    ...(direct ? { addressed: 'direct' } : m.mentioned ? { addressed: 'mention' } : {}),
    at: m.at, text: m.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${m.chatId}`, address: { chatId: m.chatId, ...(direct ? { direct: 'true' } : {}) } },
    meta: { chatId: m.chatId, messageId: m.id, direct, mentioned: !!m.mentioned } }
}

/** Ticket status in the core's own words: `ended.outcome`, the latest report state, or its open question. */
export function describeTicket(t) {
  const report = t.assignments.findLast(a => a.report)?.report
  const state = t.ended ? `ended (${t.ended.outcome})` : report ? report.state : t.attention ? 'needs attention' : 'pending'
  return [`[${t.id.slice(0, 8)}] ${t.title}`, `state: ${state}`,
    ...(report?.summary ? [`last report: ${report.summary}`] : []), ...(t.attention ? [`question: ${t.attention.question}`] : [])].join('\n')
}
const owns = (t, actor) => t.mandate?.actor?.source === SOURCE && String(t.mandate.actor.id).toLowerCase() === actor.toLowerCase()
export const listed = (part, sender) => !!part?.allowed?.some(entry => entry.id.toLowerCase() === sender.toLowerCase())

/** Content address of an authorization snapshot; the Bridge recomputes it (src/bridge.js authzRevision) and refuses mismatches. */
export const authzRevision = (effective, allowed) =>
  createHash('sha256').update(JSON.stringify([effective === true, [...new Set(allowed.map(id => id.toLowerCase()))].sort()])).digest('hex')

/**
 * The Source Policy is the only allowlist. The Bridge enforces this snapshot of it on inbound messages.
 * `configuredEnabled` is the core's switch (an old volume without a record reads as on); the snapshot is effective only
 * once an operator also ticked `confirmed` and listed at least one contact, so neither default nor QR login grants anything.
 */
export function authzSnapshot(source, registry) {
  const config = source.config(SOURCE)
  const allowed = (registry.policyPart(SOURCE)?.allowed ?? []).map(entry => entry.id)
  const status = { configuredEnabled: !!config, confirmed: config?.confirmed === true, dshConfigured: source.configured() }
  const effective = status.configuredEnabled && status.confirmed && allowed.length > 0
  return { revision: authzRevision(effective, effective ? allowed : []), effective, allowed: effective ? allowed : [], status }
}

/**
 * Answers `/status` and `/task <id>` from the Engine's records, read-only and only for tickets this sender originated.
 * Returns undefined for anything else, which then goes through the Policy like any other message.
 */
export function command(text, sender, tickets) {
  const [head, arg] = String(text).trim().split(/\s+/, 2)
  if (head === '/status') {
    const mine = tickets.open().filter(t => owns(t, sender))
    return mine.length ? mine.slice(0, 5).map(describeTicket).join('\n\n') : 'No open tasks.'
  }
  if (head === '/task') {
    if (!arg || !/^[a-f0-9]{4,32}$/i.test(arg)) return 'Usage: /task <id>'
    const found = arg.length === 32 ? tickets.get(arg.toLowerCase()) : tickets.open().find(t => t.id.startsWith(arg.toLowerCase()))
    // Missing and foreign tickets answer alike, so other people's ids are not confirmed.
    return found && owns(found, sender) ? describeTicket(found) : 'Task not found.'
  }
}

/**
 * One poll: read the Bridge log after the stored cursor, answer read-only commands, hand the rest to the Engine,
 * and only then advance the cursor. A crash mid-batch re-reads the batch; stable Trigger ids make that a no-op.
 * Until DSH setup completes the core delivers nothing, so messages stay in the Bridge instead of being answered into a queue
 * nobody drains; an unconfirmed Source reads nothing either.
 */
export async function pollOnce(source, client, registry) {
  const config = source.config(SOURCE)
  if (!config) { source.report('wechat', { state: 'paused', detail: 'Off' }); return 0 }
  if (config.confirmed !== true) { source.report('wechat', { state: 'paused', detail: 'Not confirmed: review the allowed contacts, then turn on "confirmed"' }); return 0 }
  if (!source.configured()) { source.report('wechat', { state: 'paused', detail: 'Waiting for DSH setup (Superagent → Settings → Deployment); messages stay in the Bridge' }); return 0 }
  const after = source.state.get(CURSOR) ?? 0
  const { messages } = await client.call('/v1/inbound?after=' + after)
  for (const m of messages) {
    const trigger = wechatTrigger(m)
    const servable = listed(registry.policyPart(SOURCE), m.senderId) && registry.scope({ source: SOURCE, meta: trigger.meta }).listened
    // Commands grant nothing and are answered from records, so they never enter Eval. Everything else goes through Policy.
    const reply = servable ? command(m.text, m.senderId, source.tickets) : undefined
    if (reply === undefined) await source.receive(trigger)
    else source.notify({ id: key('wechat-command', m.id), channel: trigger.channel, text: reply, kind: 'notice' })
    source.state.set(CURSOR, m.seq)
  }
  source.report('wechat', { state: 'ready', detail: '', at: new Date().toISOString() })
  return messages.length
}