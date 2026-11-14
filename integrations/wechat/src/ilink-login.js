// Run by an operator inside the Bridge container: docker exec -it <bridge> node /opt/dsh-wechat-bridge/src/ilink-login.js
import { createInterface } from 'node:readline/promises'
import { IlinkClient, IlinkState, loginWithQr } from './ilink.js'

const env = process.env
const state = new IlinkState((env.WECHAT_BRIDGE_DATA ?? '/data') + '/ilink.json')
const readline = createInterface({ input: process.stdin, output: process.stdout })
const result = await loginWithQr({ client: new IlinkClient({ baseUrl: env.ILINK_BASE_URL }), state,
  onQr: url => console.log('Encode this link as a QR code and scan it with the WeChat account that owns ClawBot:\n' + url + '\n'),
  readPin: () => readline.question('Enter the digits shown in WeChat: '), onStatus: status => console.log('status:', status) })
readline.close()
if (result.ok) console.log(`Logged in. Put this contact ID in WECHAT_ALLOWED_SENDERS (and the Source's allowed list): ${result.userId}`)
else console.error('Login failed: ' + result.reason)
process.exit(result.ok ? 0 : 1)
