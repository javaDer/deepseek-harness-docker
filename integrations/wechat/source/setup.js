/**
 * WeChat setup wizard plugin: the Bridge admin routes behind DSH's Connection. It injects no orchestrator, so the wizard
 * still opens, and can explain why, when the Superagent runtime itself failed to start.
 */
import schema from '@deepseek-ai/schemastery'
import { SETUP_PATH, setupRoute } from './setup-route.js'

export const name = 'dsh-superagent-wechat-setup'
export const inject = ['webServer', 'connection']
export const Config = schema.object({
  bridgeUrl: schema.string().default('http://wechat-bridge:8787'),
  adminTokenFile: schema.string().default('/run/secrets/wechat-bridge-admin-token'),
})
export function apply(ctx, config) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: SETUP_PATH, handler: setupRoute(ctx, config) }), 'wechat: setup routes')
}
