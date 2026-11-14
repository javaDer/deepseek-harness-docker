import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { Bridge } from './bridge.js'
import { createProvider } from './providers.js'
import { IlinkClient, IlinkProvider } from './ilink.js'
import { LoginManager } from './login.js'

const env = process.env
// The Bridge owns its credentials: create each once on the shared volume, then DSH reads the same files.
// 'wx' never overwrites an existing or operator-supplied token.
const secret = file => {
  try { writeFileSync(file, randomBytes(48).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw new Error(`cannot create ${file}: ${error.code}; mount a writable volume there or supply the token file`) }
  return readFileSync(file, 'utf8').trim()
}
const token = secret(env.WECHAT_BRIDGE_TOKEN_FILE ?? '/run/secrets/wechat-bridge-token')
const adminToken = secret(env.WECHAT_BRIDGE_ADMIN_TOKEN_FILE ?? '/run/secrets/wechat-bridge-admin-token')
const provider = createProvider(env)
const legacy = (env.WECHAT_ALLOWED_SENDERS ?? '').split(',').map(s => s.trim()).filter(Boolean)
if (legacy.length) console.log('WECHAT_ALLOWED_SENDERS is deprecated: it only narrows the DSH Source allowlist; clear it once the Source policy is confirmed')
const bridge = new Bridge({ provider, token, adminToken, file: (env.WECHAT_BRIDGE_DATA ?? '/data') + '/bridge.sqlite',
  groups: env.WECHAT_GROUPS_ENABLED === '1', allowedSenders: legacy,
  authzTtlMs: Number(env.WECHAT_AUTHZ_TTL_SECONDS ?? 300) * 1000,
  log: line => console.log(line) })
if (provider instanceof IlinkProvider)
  bridge.login = new LoginManager({ provider, client: () => new IlinkClient({ baseUrl: env.ILINK_BASE_URL }), audit: (kind, detail) => bridge.store.audit(kind, detail) })
await bridge.start()
const server = bridge.server({ mockInject: (env.WECHAT_PROVIDER ?? 'mock') === 'mock' })
server.listen(Number(env.WECHAT_BRIDGE_PORT ?? 8787), env.WECHAT_BRIDGE_HOST ?? '0.0.0.0')
// Retries become due on their backoff; dispatch picks them up.
const timer = setInterval(() => bridge.dispatch().catch(error => console.error('dispatch failed:', error.message)), 2000)
console.log(`wechat bridge listening provider=${env.WECHAT_PROVIDER ?? 'mock'}`)
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  clearInterval(timer); server.close(); await bridge.stop(); process.exit(0)
})
