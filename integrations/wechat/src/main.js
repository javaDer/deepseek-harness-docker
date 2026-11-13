import { readFileSync } from 'node:fs'
import { Bridge } from './bridge.js'
import { createProvider } from './providers.js'

const env = process.env
const token = readFileSync(env.WECHAT_BRIDGE_TOKEN_FILE ?? '/run/secrets/wechat-bridge-token', 'utf8').trim()
const provider = createProvider(env)
const bridge = new Bridge({ provider, token, file: (env.WECHAT_BRIDGE_DATA ?? '/data') + '/bridge.sqlite',
  groups: env.WECHAT_GROUPS_ENABLED === '1',
  allowedSenders: (env.WECHAT_ALLOWED_SENDERS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  log: line => console.log(line) })
await bridge.start()
const server = bridge.server({ mockInject: (env.WECHAT_PROVIDER ?? 'mock') === 'mock' })
server.listen(Number(env.WECHAT_BRIDGE_PORT ?? 8787), env.WECHAT_BRIDGE_HOST ?? '0.0.0.0')
// Retries become due on their backoff; dispatch picks them up.
const timer = setInterval(() => bridge.dispatch().catch(error => console.error('dispatch failed:', error.message)), 2000)
console.log(`wechat bridge listening provider=${env.WECHAT_PROVIDER ?? 'mock'}`)
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  clearInterval(timer); server.close(); await bridge.stop(); process.exit(0)
})
