/**
 * ============================================================================
 * 文件标识：tests/browser/mcp-token-limits.mjs ｜ MCP 令牌页限速 / 日配额 / 429 计数读数（AE11）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/mcp 的"人工确认与审计"标签：
 *   · 管理员：GET /api/mcp/limits 为 200；页面读数卡（mcp-limits）的 rpm / write-rpm / daily-quota / limited 与接口逐项一致；
 *   · 把日配额设为 1（危险键，带理由）并用一枚只读令牌调用 org.tree 两次：第一次 200，第二次 HTTP 429（MCP_RATE_LIMITED）；
 *     接口的 rate_limited_total 恰好 +1、daily_quota=1；在已打开的页面上点"刷新记录"后读数与接口一致（计数 +1、配额 1；刷新前仍是旧读数）。
 *     开场记下日配额原值，finally 还原原值并吊销该令牌，且校验还原结果；
 *   · 无权限账号（role=purchase）：接口 403，页面上没有读数卡。
 * 令牌明文与账号密码都不打印；外部请求一律拦截并计数，必须为 0。
 * 浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { apiLogin, createAccount, launchBrowser, loopbackBase, makeApi, okData, randomSuffix, screenshotPages, uiLogin } from './lib.mjs'

const base = loopbackBase()
const api = makeApi(base)
const browser = await launchBrowser()
const pages = []
const results = []
let externalRequests = 0
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }

async function openMcp(actor, settleLimits = false) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  await ctx.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== base.origin) { externalRequests++; return route.abort('blockedbyclient') }
    return route.continue()
  })
  const page = await ctx.newPage()
  pages.push(page)
  let limitsRequests = 0
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/mcp/limits') limitsRequests++ })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  await page.goto(new URL('/system/mcp', base).href)
  await page.waitForLoadState('networkidle')
  // 无权限账号可能被页面守卫挡住而根本没有标签：有则点开，没有就保持原样（后面断言读数卡不存在）
  const tab = page.getByText('人工确认与审计', { exact: true })
  if (await tab.count()) {
    const initialResponses = []
    // 卡片挂载和父级 load() 的 nonce 更新各取一次；先订阅再点击，不能把首张卡当成初始化完成。
    const settled = settleLimits ? page.waitForResponse((response) => {
      if (new URL(response.url()).pathname !== '/api/mcp/limits') return false
      initialResponses.push(response)
      return initialResponses.length === 2
    }) : null
    await Promise.all([settled, tab.click()])
    if (settled) {
      for (const response of initialResponses) {
        assert.equal(response.status(), 200, 'initial limits request succeeds')
        assert.equal(await response.finished(), null, 'initial limits response completed')
      }
      assert.equal(limitsRequests, 2, 'mount plus parent load refresh are both accounted for')
    }
  }
  return { page, errors, limitsRequestCount: () => limitsRequests }
}
const readout = (page) => page.getByTestId('mcp-limits').evaluate((el) => ({
  rpm: Number(el.getAttribute('data-rpm')), write_rpm: Number(el.getAttribute('data-write-rpm')),
  daily_quota: Number(el.getAttribute('data-daily-quota')), rate_limited_total: Number(el.getAttribute('data-limited'))
}))
const limitsOf = async (token) => okData(await api('/api/mcp/limits', { token }))
const putQuota = (token, value) => api('/api/meta/settings', { token, method: 'PUT', body: { key: 'mcp_token_daily_quota', value, reason: 'browser scenario mcp-token-limits' } })
const mcpCall = async (plain) => {
  const res = await fetch(new URL('/mcp', base), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${plain}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'org.tree', arguments: {} } }),
    signal: AbortSignal.timeout(15000)
  })
  await res.text()
  return res.status
}

let adminToken
let tokenId = null
let originalQuota = null
let cleanupFailed = false
try {
  adminToken = (await apiLogin(api, 'admin', '12345')).token
  originalQuota = (await limitsOf(adminToken)).daily_quota

  // 同一个页面贯穿两步：第二步靠"刷新记录"取新读数，证明刷新路径真的重新取了限速读数
  const admin = await openMcp({ username: 'admin', password: '12345' }, true)

  await step('admin: the readout card equals GET /api/mcp/limits field by field', async () => {
    const limits = await limitsOf(adminToken)
    for (const k of ['rpm', 'write_rpm', 'daily_quota', 'rate_limited_total']) assert.ok(Number.isInteger(limits[k]) && limits[k] >= 0, `limits.${k}`)
    assert.ok(limits.rpm >= 1 && limits.write_rpm >= 1)
    await admin.page.waitForFunction((expected) => {
      const el = document.querySelector('[data-testid="mcp-limits"]')
      const attrs = { rpm: 'data-rpm', write_rpm: 'data-write-rpm', daily_quota: 'data-daily-quota', rate_limited_total: 'data-limited' }
      return el && Object.entries(attrs).every(([key, attr]) => el.getAttribute(attr) === String(expected[key]))
    }, limits)
    assert.deepEqual(await readout(admin.page), { rpm: limits.rpm, write_rpm: limits.write_rpm, daily_quota: limits.daily_quota, rate_limited_total: limits.rate_limited_total })
  })

  await step('a real 429 (daily quota 1, second call) moves the counter by exactly one; clicking refresh on the open page shows quota and count', async () => {
    const initialRequestCount = admin.limitsRequestCount()
    const before = await limitsOf(adminToken)
    assert.equal((await putQuota(adminToken, '1')).status, 200)
    const created = okData(await api('/api/mcp/tokens', { token: adminToken, body: { name: `ae11-limits-${randomSuffix()}`, scopes: 'read' } }))
    tokenId = created.id
    assert.equal(await mcpCall(created.token), 200)
    assert.equal(await mcpCall(created.token), 429)
    const after = await limitsOf(adminToken)
    assert.equal(after.daily_quota, 1)
    assert.equal(after.rate_limited_total, before.rate_limited_total + 1)
    // 刷新前页面仍是旧读数
    assert.equal((await readout(admin.page)).daily_quota, before.daily_quota)
    assert.equal(admin.limitsRequestCount(), initialRequestCount, 'no background limits request before manual refresh')
    await admin.page.getByRole('button', { name: '刷新记录' }).click()
    await admin.page.waitForFunction((n) => document.querySelector('[data-testid="mcp-limits"]')?.getAttribute('data-limited') === String(n), after.rate_limited_total)
    assert.deepEqual(await readout(admin.page), { rpm: after.rpm, write_rpm: after.write_rpm, daily_quota: 1, rate_limited_total: after.rate_limited_total })
    assert.equal(admin.limitsRequestCount(), initialRequestCount + 1, 'manual refresh issues exactly one new limits request')
    assert.equal((await admin.page.getByTestId('mcp-limits').innerText()).includes(created.token), false, 'the readout never shows token material')
    assert.deepEqual(admin.errors, [])
  })

  await step('non-admin: the limits endpoint is 403 and the page has no readout card', async () => {
    const plain = await createAccount(api, adminToken, 'ae_plain', 'purchase')
    assert.equal((await api('/api/mcp/limits', { token: plain.token })).status, 403)
    const { page, errors } = await openMcp(plain)
    await page.waitForLoadState('networkidle')
    assert.equal(await page.getByTestId('mcp-limits').count(), 0)
    assert.deepEqual(errors.filter((e) => !/403/.test(e)), [])
  })

  assert.equal(externalRequests, 0, 'the scenario must not touch external origins')
  console.log(JSON.stringify({ suite: 'mcp-limits-readout-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('mcp-token-limits', pages)
  throw error
} finally {
  // 还原开场记下的日配额原值并吊销本场景签发的令牌；API 失败不会抛错，必须看状态码
  if (adminToken) {
    if (originalQuota !== null) {
      const r = await putQuota(adminToken, String(originalQuota)).catch(() => null)
      if (!r || r.status !== 200) { cleanupFailed = true; console.error('mcp-token-limits: failed to restore mcp_token_daily_quota') }
    }
    if (tokenId != null) {
      const r = await api(`/api/mcp/tokens/${tokenId}`, { token: adminToken, method: 'DELETE' }).catch(() => null)
      if (!r || r.status !== 200) { cleanupFailed = true; console.error('mcp-token-limits: failed to revoke the scenario token') }
    }
  }
  await browser.close()
}
if (cleanupFailed) process.exitCode = 1
