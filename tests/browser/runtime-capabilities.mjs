/**
 * ============================================================================
 * 文件标识：tests/browser/runtime-capabilities.mjs ｜ Linux 浏览器运行能力交互验证
 * 使用实际前端构建和可控 API 响应；不替代真实服务端门禁/会话测试。
 * 不自动下载浏览器，不安装依赖，不使用真实凭据。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const base = process.env.GML_TEST_BASE_URL
const url = new URL(base || 'http://invalid')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use an isolated loopback frontend')
assert.ok(process.env.GML_PLAYWRIGHT_MODULE && process.env.GML_CHROMIUM_EXECUTABLE, 'Provide existing Linux browser tooling paths')
const { chromium } = await import(pathToFileURL(process.env.GML_PLAYWRIGHT_MODULE).href)
const browser = await chromium.launch({
  chromiumSandbox: true, headless: true, executablePath: process.env.GML_CHROMIUM_EXECUTABLE,
  env: { ...process.env, ...(process.env.GML_BROWSER_LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.GML_BROWSER_LD_LIBRARY_PATH } : {}) }
})
const ids = ['public_mall', 'qimen_gateway', 'oms_simulation', 'im_connector', 'agent_access']
let passed = 0
async function scenario(label, fn) {
  await fn()
  passed++
  console.log(`PASS ${label}`)
}
async function fixture({ mode = 'production', role = 'admin', signedIn = true } = {}) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const calls = []
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const user = { id: 1, uid: 1, username: 'browser_fixture', name: 'Browser fixture', role, industry: 'cosmetic' }
  await context.addInitScript(({ signedIn, user }) => {
    if (signedIn) {
      localStorage.setItem('gml_token', 'browser-fixture-token')
      localStorage.setItem('gml_user', JSON.stringify(user))
      localStorage.setItem('gml_industry', 'cosmetic')
    }
  }, { signedIn, user })
  const state = { mode, capabilityFailure: null, pending: false, release: null, rejectNextWrite: false, logoutFailure: false }
  await page.route('**/api**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    calls.push({ pathname, method: request.method() })
    const respond = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code: 0, success: true, data }) })
    if (pathname === '/api') {
      if (state.pending) await new Promise(resolve => { state.release = resolve })
      if (state.capabilityFailure === 'network') return route.abort('failed')
      const capabilities = Object.fromEntries(ids.map(id => [id, { enabled: state.mode !== 'production' }]))
      if (state.capabilityFailure === 'missing') delete capabilities.agent_access
      return respond({ runtime_mode: state.mode, capabilities })
    }
    if (state.rejectNextWrite && request.method() === 'POST') {
      state.rejectNextWrite = false
      state.mode = 'production'
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'FEATURE_DISABLED', message: '功能已停用', detail: { code: 'FEATURE_DISABLED', capability: 'oms_simulation' } }) })
    }
    if (pathname === '/api/auth/me') return respond({ ...user, orgScope: { scope: 'all' }, permissions: role === 'admin' ? ['system.mcp.manage', 'system.im.view', 'system.im.sync'] : [] })
    if (pathname === '/api/auth/logout-all') return state.logoutFailure ? route.abort('failed') : respond({ revoked: true })
    if (pathname === '/api/auth/industries') return respond([{ code: 'cosmetic', label: '美妆连锁版', visible: true }])
    if (pathname === '/api/oms/platforms') return respond([{ id: 1, name: 'Test platform', status: 'active', sync_order: 1, sync_stock: 1 }])
    if (pathname === '/api/oms/orders') return respond({ list: [{ id: 1, platform_order_no: 'TEST-ORDER', status: 'pending', pay_amount: 1 }], total: 1 })
    if (pathname === '/api/im/status') return respond({ platforms: [], maps: {} })
    if (['/api/im/platforms', '/api/im/mappings', '/api/mall/products'].includes(pathname)) return respond([])
    if (pathname.startsWith('/api/dashboard/') && !['/api/dashboard/summary', '/api/dashboard/todos', '/api/dashboard/channel'].includes(pathname)) return respond([])
    return respond({})
  })
  const goto = route => page.goto(new URL(route, base).href)
  const settled = () => page.waitForFunction(() => !document.body.innerText.includes('正在确认功能可用性'))
  return { page, calls, state, goto, settled, async close() { await context.close(); assert.deepEqual(errors, [], 'No React/browser runtime errors') } }
}

try {
  await scenario('production deep links do not mount restricted pages or request child APIs', async () => {
    const f = await fixture()
    try {
      for (const path of ['/mall', '/oms/qimen', '/system/mcp']) {
        await f.goto(path)
        await f.page.getByTestId('capability-status').last().getByText(/在当前实例未启用/).waitFor()
        await f.page.reload()
        await f.page.getByTestId('capability-status').last().getByText(/在当前实例未启用/).waitFor()
      }
      assert.equal(f.calls.filter(x => /^\/api\/(mall|qimen|mcp)(\/|$)/.test(x.pathname)).length, 0)
      assert.equal(await f.page.locator('a[href="/mall"],a[href="/oms/qimen"],a[href="/system/mcp"]').count(), 0)
    } finally { await f.close() }
  })
  await scenario('production login has no demo credentials or advertising', async () => {
    const f = await fixture({ signedIn: false })
    try {
      await f.goto('/login'); await f.settled()
      assert.equal(await f.page.getByPlaceholder('请输入账号').inputValue(), '')
      assert.equal(await f.page.locator('input[type="password"]').inputValue(), '')
      assert.doesNotMatch(await f.page.locator('body').innerText(), /② 演示角色|MCP 全面开放|种单据全部开放 MCP|DEMO 演示环境/)
      assert.equal(await f.page.locator('a[href="/mall"],a[href="/docs/demo-flow.html"]').count(), 0)
    } finally { await f.close() }
  })
  await scenario('POS demo hints appear only after an explicit demo/test capability response', async () => {
    for (const mode of ['production', 'unknown', 'demo', 'test']) {
      const f = await fixture({ mode, signedIn: false })
      try {
        f.state.pending = true
        await f.goto('/pos')
        await f.page.getByRole('button', { name: '登录', exact: true }).waitFor()
        assert.doesNotMatch(await f.page.locator('body').innerText(), /store01|123456/)
        assert.equal(await f.page.getByPlaceholder('账号', { exact: true }).inputValue(), '')
        assert.equal(await f.page.getByPlaceholder('密码', { exact: true }).inputValue(), '')
        for (let i = 0; i < 100 && !f.state.release; i++) await new Promise(resolve => setTimeout(resolve, 10))
        assert.ok(f.state.release, 'Capability request must arrive before release')
        f.state.pending = false; f.state.release()
        if (mode === 'demo' || mode === 'test') await f.page.getByText(/演示：store01/).waitFor()
        else {
          // A completed /api response cannot make an unknown/production mode show demo credentials.
          if (mode === 'unknown') await f.page.getByText(/暂时无法确认功能可用性/).waitFor()
          else await f.page.getByTestId('capability-status').waitFor({ state: 'hidden' })
          assert.doesNotMatch(await f.page.locator('body').innerText(), /store01|123456/)
        }
      } finally { await f.close() }
    }
  })
  await scenario('loading, missing fields, unknown mode, network failure and retry remain closed', async () => {
    const f = await fixture()
    try {
      f.state.pending = true
      await f.goto('/mall')
      await f.page.getByText('正在确认功能可用性…').waitFor()
      assert.equal(f.calls.filter(x => x.pathname.startsWith('/api/mall')).length, 0)
      f.state.capabilityFailure = 'missing'; f.state.pending = false; f.state.release()
      await f.page.getByText(/暂时无法确认功能可用性/).waitFor()
      f.state.capabilityFailure = null; f.state.mode = 'unknown'
      await f.page.getByRole('button', { name: '重新检查' }).click()
      await f.page.getByText(/暂时无法确认功能可用性/).waitFor()
      f.state.mode = 'production'
      f.state.capabilityFailure = 'network'
      await f.page.getByRole('button', { name: '重新检查' }).click()
      await f.page.getByText(/暂时无法确认功能可用性/).waitFor()
      f.state.capabilityFailure = null
      await f.page.getByRole('button', { name: '重新检查' }).click()
      await f.page.getByText(/线上商城在当前实例未启用/).waitFor()
      assert.equal(f.calls.filter(x => x.pathname.startsWith('/api/mall')).length, 0)
    } finally { await f.close() }
  })
  await scenario('production OMS actions hidden while internal conversion and IM read views remain', async () => {
    const f = await fixture()
    try {
      await f.goto('/oms/platforms'); await f.settled()
      await f.page.getByText('Test platform', { exact: true }).waitFor()
      assert.equal(await f.page.getByRole('button', { name: /同步订单|推送库存/ }).count(), 0)
      await f.goto('/oms/orders'); await f.settled()
      await f.page.getByText('TEST-ORDER', { exact: true }).waitFor()
      assert.equal(await f.page.getByRole('button', { name: /^(发货|退款)$/ }).count(), 0)
      assert.equal(await f.page.getByRole('button', { name: '转单', exact: true }).count(), 1)
      await f.goto('/system/im-sync'); await f.settled()
      assert.equal(await f.page.getByRole('button', { name: /组织同步|审批同步|全链路自检/ }).count(), 0)
      assert.ok(f.calls.some(x => x.pathname === '/api/im/status'))
    } finally { await f.close() }
  })
  for (const mode of ['demo', 'test']) await scenario(`${mode} preserves role-scoped actions and explicit demo login`, async () => {
    const f = await fixture({ mode })
    try {
      await f.goto('/login')
      await f.page.getByText(/② 演示角色/).waitFor()
      await f.page.getByRole('button', { name: /系统管理员/ }).click()
      assert.equal(await f.page.getByPlaceholder('请输入账号').inputValue(), 'admin')
      await f.goto('/oms/platforms')
      await f.page.getByRole('button', { name: '同步订单', exact: true }).waitFor()
      assert.equal(await f.page.getByRole('button', { name: '推送库存', exact: true }).count(), 1)
      assert.equal(await f.page.locator('a[href="/oms/qimen"],a[href="/system/mcp"]').count(), 2)
      await f.goto('/system/im-sync')
      await f.page.getByRole('button', { name: '组织同步', exact: true }).waitFor()
    } finally { await f.close() }
    const viewer = await fixture({ mode, role: 'viewer' })
    try {
      await viewer.goto('/oms/platforms'); await viewer.settled()
      await viewer.page.getByText('Test platform', { exact: true }).waitFor()
      assert.equal(await viewer.page.getByRole('button', { name: /同步订单|推送库存/ }).count(), 0)
      assert.equal(await viewer.page.locator('a[href="/system/mcp"]').count(), 0)
      await viewer.goto('/system/im-sync'); await viewer.settled()
      await viewer.page.getByText('钉钉 / 飞书 同步', { exact: true }).waitFor()
      assert.equal(await viewer.page.getByRole('button', { name: /组织同步|审批同步|全链路自检/ }).count(), 0)
    } finally { await viewer.close() }
  })
  await scenario('FEATURE_DISABLED refreshes capabilities and never retries the write', async () => {
    const f = await fixture({ mode: 'demo' })
    try {
      await f.goto('/oms/platforms')
      const button = f.page.getByRole('button', { name: '同步订单', exact: true })
      await button.waitFor()
      f.state.rejectNextWrite = true
      await button.click()
      await f.page.getByText(/平台同步与库存推送在当前实例未启用/).waitFor()
      assert.equal(f.calls.filter(x => x.method === 'POST' && x.pathname === '/api/oms/sync/1').length, 1)
      assert.equal(await button.count(), 0)
    } finally { await f.close() }
  })
  await scenario('actual Layout opens password dialog and displays confirmed/unconfirmed logout notices on Login', async () => {
    for (const failure of [false, true]) {
      const f = await fixture()
      try {
        f.state.logoutFailure = failure
        await f.goto('/oms/platforms'); await f.settled()
        await f.page.getByRole('button', { name: /Browser fixture/ }).click()
        await f.page.getByRole('button', { name: '修改密码', exact: true }).click()
        const dialog = f.page.getByRole('dialog', { name: '修改密码' })
        await dialog.waitFor()
        await dialog.getByRole('button', { name: '取消', exact: true }).click()
        await f.page.getByRole('button', { name: /Browser fixture/ }).click()
        await f.page.getByRole('button', { name: '退出全部会话', exact: true }).click()
        await f.page.waitForURL('**/login')
        await f.page.getByText(failure ? /未能确认服务端会话撤销/ : /服务端已撤销该账号的全部后台会话/).waitFor()
        assert.equal(await f.page.evaluate(() => localStorage.getItem('gml_token')), null)
        assert.equal(f.calls.filter(x => x.method === 'POST' && x.pathname === '/api/auth/logout-all').length, 1)
      } finally { await f.close() }
    }
  })
  console.log(`Browser runtime capability scenarios passed: ${passed}`)
} finally { await browser.close() }
