import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { Bridge } from './bridge.js'
import { createProvider } from './providers.js'

const env = process.env
const tokenFile = env.WECHAT_BRIDGE_TOKEN_FILE ?? '/run/secrets/wechat-bridge-token'
// The Bridge owns its credential: create it once on the shared volume, then DSH reads the same file.
// 'wx' never overwrites an existing or operator-supplied token.
try { writeFileSync(tokenFile, randomBytes(48).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }) }
catch (error) { if (error.code !== 'EEXIST') throw new Error(`cannot create ${tokenFile}: ${error.code}; mount a writable volume there or supply the token file`) }
const token = readFileSync(tokenFile, 'utf8').trim()
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
