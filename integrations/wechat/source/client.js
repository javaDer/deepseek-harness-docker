window.__ModuleLoader__.load({
  id: 'dsh-superagent-wechat',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const zh = window.navigator.language.toLowerCase().startsWith('zh')
    const t = (cn, en) => (zh ? cn : en)

    // Every code the Bridge or the wizard reports, in words an operator can act on.
    const explain = {
      provider_not_connected: t('Bridge 尚未登录微信 ClawBot。点击"扫码登录"。', 'The Bridge is not logged in to WeChat ClawBot. Use "Scan to log in".'),
      authz_missing: t('Bridge 还没收到 DSH 的授权快照。确认微信来源已安装且 Bridge 可达。', 'The Bridge has no authorization snapshot from DSH yet.'),
      authz_stale: t('Bridge 的授权快照已过期，DSH 没有按时同步。新消息会被拒收。', 'The Bridge snapshot is stale; new messages are refused.'),
      source_disabled: t('微信来源未启用。', 'The WeChat Source is off.'),
      source_not_confirmed: t('微信来源未确认。核对允许名单后点击"确认启用"。', 'The WeChat Source is not confirmed.'),
      allowlist_empty: t('允许名单为空，所有消息都会被拒收。', 'The allowlist is empty; every message is refused.'),
      dsh_setup_pending: t('Superagent 部署检查未通过（通常是 GitHub 仓库或 CLI 未配置）。完成前不会处理或回复任何消息。前往 Superagent → 设置 → 部署。', 'Superagent setup is pending (usually the GitHub repository or CLI). Nothing is processed or answered until it passes.'),
      legacy_env_allowlist_set: t('仍设置了 WECHAT_ALLOWED_SENDERS。它只会进一步收窄名单，确认来源策略后请清空。', 'WECHAT_ALLOWED_SENDERS is still set; clear it once the Source policy is confirmed.'),
      delivery_unconfirmed: t('有消息无法确认是否送达，不会自动重发。', 'Some messages may or may not have arrived; they are never resent automatically.'),
      login_in_progress: t('已有登录在进行。', 'Another login is in progress.'),
      already_logged_in: t('Bridge 已登录。重新登录会替换当前绑定。', 'The Bridge is already logged in; logging in again replaces the binding.'),
      login_unsupported: t('当前 Bridge 不是 ClawBot（ilink）模式。', 'The Bridge does not run the ClawBot (ilink) provider.'),
      qr_expired: t('二维码多次过期，请重新开始。', 'The QR code expired too many times.'),
      already_bound: t('该微信已绑定到此 Bridge，现有凭证继续有效。', 'Already bound; the existing credentials stay valid.'),
      no_credentials: t('微信服务未返回凭证，请重试。', 'WeChat returned no credentials; try again.'),
      login_error: t('登录出错，请重试。', 'The login failed; try again.'),
      invalid_pin: t('验证码应为 4–8 位数字。', 'The PIN must be 4 to 8 digits.'),
      pin_not_requested: t('微信当前没有要求验证码。', 'WeChat is not asking for a PIN.'),
      bridge_unreachable: t('DSH 无法连接 Bridge。', 'DSH cannot reach the Bridge.'),
      dsh_authentication_required: t('DSH 登录已失效，请刷新页面。', 'The DSH session ended; reload the page.'),
    }
    const describe = (code) => explain[code] ?? code

    let state = { open: false, preflight: null, session: null, busy: false, error: null, note: null }
    const listeners = new Set()
    const set = (patch) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
    const useStore = () => React.useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => state, () => state)

    async function setup(path, method = 'GET', body) {
      const response = await fetch('/wechat-setup/api' + path, { method, cache: 'no-store', credentials: 'same-origin',
        headers: { 'x-wechat-setup': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw Object.assign(new Error(value.error ?? 'http_' + response.status), { code: value.error, status: response.status })
      return value
    }
    async function settings(path, method = 'GET', body) {
      const response = await fetch('/orchestrator/api/' + path, { method, cache: 'no-store', credentials: 'same-origin',
        headers: { 'x-orchestrator-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(value.error ?? 'http_' + response.status)
      return value
    }
    const run = (work) => async (...args) => {
      set({ busy: true, error: null })
      try { await work(...args) } catch (error) { set({ error: error.code ? describe(error.code) : String(error.message) }) } finally { set({ busy: false }) }
    }
    const terminal = (s) => ['confirmed', 'failed', 'cancelled', 'expired'].includes(s?.state)

    let timer
    function poll(id) {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        try {
          const session = await setup('/login/' + id)
          set({ session })
          if (!terminal(session)) poll(id); else sessionStorage.removeItem('wechat-setup-session')
        } catch (error) {
          if (error.status === 404) { sessionStorage.removeItem('wechat-setup-session'); set({ session: null }) } else poll(id)
        }
      }, 1500)
    }
    const refresh = run(async () => set({ preflight: await setup('/preflight') }))
    // A reloaded page resumes the session it started; the id never leaves this tab.
    const load = run(async () => {
      set({ preflight: await setup('/preflight') })
      const id = sessionStorage.getItem('wechat-setup-session'), current = await setup('/login')
      if (id && current.active) { const session = await setup('/login/' + id); set({ session }); if (!terminal(session)) poll(id) }
    })
    const start = run(async (force) => {
      const session = await setup('/login', 'POST', { force: force === true })
      sessionStorage.setItem('wechat-setup-session', session.id); set({ session }); poll(session.id)
    })
    const submitPin = run(async (pin) => set({ session: await setup(`/login/${state.session.id}/pin`, 'POST', { pin }) }))
    const cancel = run(async () => { clearTimeout(timer); set({ session: await setup('/login/' + state.session.id, 'DELETE') }) })
    // Both writes go through DSH's own settings API with its revision checks; the wizard only fills in what the person approved.
    const authorize = run(async () => {
      const id = state.session.userId, all = await settings('settings'), policy = all.blocks.policy
      const part = policy.value.sources?.wechat ?? { allowed: [] }
      if (!part.allowed.some((entry) => entry.id.toLowerCase() === id.toLowerCase())) {
        const allowed = [...part.allowed, { id, name: t('扫码登录的联系人', 'Contact from QR login') }]
        await settings('settings/policy', 'PUT', { revision: policy.revision, value: { ...policy.value, sources: { ...policy.value.sources, wechat: { ...part, allowed } } } })
      }
      set({ note: t('已加入允许名单。', 'Added to the allowlist.') })
    })
    const confirm = run(async () => {
      const wechat = (await settings('settings')).sources.find((source) => source.kind === 'wechat')
      await settings('settings/source:wechat', 'PUT', { revision: wechat.revision, value: { enabled: true, config: { ...wechat.value.config, confirmed: true } } })
      set({ note: t('已确认启用。几秒后刷新预检查看结果。', 'Confirmed. Refresh the checks in a few seconds.') })
    })

    function Qr({ matrix }) {
      const size = matrix.length, cells = []
      matrix.forEach((row, y) => { for (let x = 0; x < size; x++) if (row[x] === '1') cells.push(h('rect', { key: `${x}-${y}`, x: x + 4, y: y + 4, width: 1, height: 1 })) })
      return h('svg', { viewBox: `0 0 ${size + 8} ${size + 8}`, width: 220, height: 220, role: 'img', 'aria-label': t('登录二维码', 'Login QR code'),
        style: { background: '#fff', shapeRendering: 'crispEdges' } }, h('g', { fill: '#000' }, cells))
    }
    function PinForm() {
      const [pin, setPin] = React.useState('')
      return h('form', { onSubmit: (event) => { event.preventDefault(); submitPin(pin) }, style: { display: 'flex', gap: 8 } },
        h('input', { value: pin, onChange: (event) => setPin(event.target.value), inputMode: 'numeric', autoComplete: 'one-time-code', 'aria-label': t('验证码', 'PIN'), style: fieldStyle() }),
        h('button', { type: 'submit', style: buttonStyle() }, t('提交验证码', 'Submit PIN')))
    }
    const Section = ({ title, children }) => h('section', { style: { display: 'grid', gap: 8 } }, h('h3', { style: { margin: 0, fontSize: 14 } }, title), children)

    function Overlay() {
      const s = useStore()
      React.useEffect(() => { if (s.open) load(); return () => clearTimeout(timer) }, [s.open])
      if (!s.open) return null
      const session = s.session, checks = s.preflight?.checks ?? []
      return h('div', { role: 'dialog', 'aria-label': t('微信接入向导', 'WeChat setup'), style: panelStyle() },
        h('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          h('strong', null, t('微信 ClawBot 接入（实验）', 'WeChat ClawBot setup (experimental)')),
          h('button', { type: 'button', onClick: () => set({ open: false }), style: buttonStyle() }, t('关闭', 'Close'))),
        s.error ? h('p', { role: 'alert', style: { color: 'var(--dsw-alias-label-danger, #c00)', margin: 0 } }, s.error) : null,
        s.note ? h('p', { role: 'status', style: { margin: 0 } }, s.note) : null,
        h(Section, { title: t('1. 前置条件', '1. Preconditions') },
          h('ul', { style: { margin: 0, paddingLeft: 18, display: 'grid', gap: 4 } }, checks.map((check) =>
            h('li', { key: check.id }, (check.ok ? '✅ ' : check.level === 'warning' ? '⚠️ ' : '⛔ ') + check.id + (check.ok ? '' : ' — ' + describe(check.code))))),
          h('button', { type: 'button', disabled: s.busy, onClick: refresh, style: buttonStyle() }, t('重新检查', 'Check again'))),
        h(Section, { title: t('2. 扫码登录', '2. Scan to log in') },
          !session || terminal(session)
            ? h('div', { style: { display: 'flex', gap: 8 } },
              h('button', { type: 'button', disabled: s.busy, onClick: () => start(false), style: buttonStyle() }, t('扫码登录', 'Scan to log in')),
              h('button', { type: 'button', disabled: s.busy, onClick: () => start(true), style: buttonStyle() }, t('替换现有登录', 'Replace current login')))
            : h('div', { style: { display: 'grid', gap: 8 } },
              h('span', null, t('状态：', 'State: ') + session.state + t('，有效至 ', ', valid until ') + new Date(session.expiresAt).toLocaleTimeString()),
              session.qrMatrix ? h(Qr, { matrix: session.qrMatrix }) : session.qr ? h('code', { style: { wordBreak: 'break-all' } }, session.qr) : null,
              session.qr ? h('span', null, t('请用要绑定 ClawBot 的微信扫码确认。不要把二维码发给他人。', 'Scan with the WeChat account that owns ClawBot. Do not share this code.')) : null,
              session.state === 'need_pin' ? h(PinForm) : null,
              h('button', { type: 'button', disabled: s.busy, onClick: cancel, style: buttonStyle() }, t('取消登录', 'Cancel'))),
          session?.state === 'failed' || session?.state === 'expired' ? h('p', { style: { margin: 0 } }, session.code ? describe(session.code) : t('登录已过期。', 'The login expired.')) : null),
        session?.state === 'confirmed' ? h(Section, { title: t('3. 授权确认', '3. Authorize') },
          h('span', null, t('登录的联系人 ID：', 'Logged-in contact ID: '), h('code', null, session.userId)),
          h('span', null, t('加入允许名单只让此联系人能发消息给 Superagent；Git Push、MR、DDL、Nacos 等操作仍需独立审批。', 'Listing this contact only lets it message Superagent; Git push, MRs, DDL and Nacos changes still need their own approval.')),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { type: 'button', disabled: s.busy, onClick: authorize, style: buttonStyle() }, t('加入允许名单', 'Add to allowlist')),
            h('button', { type: 'button', disabled: s.busy, onClick: confirm, style: buttonStyle() }, t('确认启用', 'Confirm and enable')))) : null,
        h(Section, { title: t('4. 验证', '4. Verify') },
          h('span', null, t('全部前置条件通过后，在微信里给 ClawBot 发送 /status，应收到回复。', 'When every check passes, send /status to ClawBot in WeChat; a reply should arrive.'))))
    }
    function Button({ wide }) {
      return h('button', { type: 'button', title: t('微信接入', 'WeChat setup'), 'aria-label': t('微信接入', 'WeChat setup'), onClick: () => set({ open: true }),
        style: { boxSizing: 'border-box', width: wide ? '100%' : '36px', height: '36px', margin: '2px 0', padding: wide ? '0 12px' : '0', border: 0, borderRadius: '10px',
          background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: wide ? 'flex-start' : 'center', gap: '9px', fontSize: '14px' } },
        h('span', { style: { fontSize: '18px', lineHeight: 1 } }, '💬'), wide ? h('span', null, t('微信接入', 'WeChat setup')) : null)
    }
    function panelStyle() {
      return { position: 'fixed', top: '8vh', left: '50%', transform: 'translateX(-50%)', width: 'min(560px, 92vw)', maxHeight: '84vh', overflow: 'auto', zIndex: 1000,
        display: 'grid', gap: 16, padding: 20, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l1, #fff)',
        color: 'var(--dsw-alias-label-primary)', boxShadow: '0 12px 40px rgba(0,0,0,.2)', fontSize: 13 }
    }
    function buttonStyle() {
      return { height: 30, padding: '0 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-button-elevated-fill)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }
    }
    function fieldStyle() { return { height: 30, padding: '0 8px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'transparent', color: 'inherit' } }

    module.exports.inject = ['slots']
    module.exports.apply = (ctx) => {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'wechat-setup', order: 60, label: t('微信接入', 'WeChat setup') }, Button))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'wechat-setup-overlay', order: 60, label: t('微信接入向导', 'WeChat setup') }, Overlay))
    }
    return module.exports
  }
})
