/**
 * Setup routes for the WeChat wizard. The browser never sees a Bridge token: these routes accept only a request
 * DSH's Connection admits (signed session cookie, Host/Origin checks) that also carries the wizard's marker
 * header, then call a fixed set of Bridge admin endpoints with the admin token read from the shared secret volume.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export const SETUP_PATH = '/wechat-setup/api'
const SESSION = '[a-f0-9]{32}'
const ROUTES = [
  ['GET', /^\/preflight$/], ['GET', /^\/login$/], ['POST', /^\/login$/],
  ['GET', new RegExp(`^/login/${SESSION}$`)], ['DELETE', new RegExp(`^/login/${SESSION}$`)], ['POST', new RegExp(`^/login/${SESSION}/pin$`)],
]

// ponytail: borrows the MIT QR encoder npm itself bundles (qrcode-terminal/vendor/QRCode); vendor it if npm ever drops it.
let encoder
function qrEncoder() {
  if (encoder !== undefined) return encoder
  const require = createRequire(import.meta.url)
  const root = join(dirname(dirname(process.execPath)), 'lib/node_modules/npm/node_modules/qrcode-terminal/vendor/QRCode')
  try { encoder = { QRCode: require(root), levels: require(join(root, 'QRErrorCorrectLevel.js')) } } catch { encoder = null }
  return encoder
}
/** QR modules as rows of '0'/'1': the browser draws them itself, so no markup ever crosses from server to page. */
export function qrMatrix(text) {
  const qr = qrEncoder()
  if (!qr) return undefined
  const code = new qr.QRCode(-1, qr.levels.M); code.addData(text); code.make()
  const size = code.getModuleCount()
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => (code.isDark(row, col) ? '1' : '0')).join(''))
}

const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }

export function setupRoute(ctx, config, request = fetch) {
  return async (req, res) => {
    let rejection
    try { rejection = ctx.connection.requestRejection(req) } catch { rejection = 401 }
    if (rejection !== undefined) return send(res, rejection, { error: 'dsh_authentication_required' })
    if (req.headers['x-wechat-setup'] !== '1') return send(res, 403, { error: 'setup_marker_required' })
    const path = new URL(req.url, 'http://dsh').pathname.slice(SETUP_PATH.length) || '/'
    if (!ROUTES.some(([method, pattern]) => method === req.method && pattern.test(path))) return send(res, 404, { error: 'not_found' })
    let body
    try {
      if (req.method === 'POST') {
        let raw = ''
        for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return send(res, 413, { error: 'too_large' }) }
        body = JSON.stringify(JSON.parse(raw || '{}'))
      }
    } catch { return send(res, 400, { error: 'invalid_json' }) }
    let response, value
    try {
      const token = readFileSync(config.adminTokenFile, 'utf8').trim()
      response = await request(config.bridgeUrl.replace(/\/$/, '') + '/v1/admin' + path, { method: req.method, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { authorization: 'Bearer ' + token, 'x-wechat-admin': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body } : {}) })
      value = await response.json()
    } catch { return send(res, 502, { error: 'bridge_unreachable' }) }
    if (typeof value?.qr === 'string') value = { ...value, qrMatrix: qrMatrix(value.qr) }
    send(res, response.status, value)
  }
}
