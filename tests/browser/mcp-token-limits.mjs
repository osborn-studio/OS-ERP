/**
 * ============================================================================
 * 文件标识：tests/browser/mcp-token-limits.mjs ｜ MCP 令牌页限速 / 日配额 / 429 计数读数（AE11）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/mcp 的"人工确认与审计"标签：
 *   · 管理员：GET /api/mcp/limits 为 200；页面读数卡（mcp-limits）的 rpm / write-rpm / daily-quota / limited 与接口逐项一致；
 *   · 把日配额设为 1（危险键，带理由）并用一枚只读令牌调用 org.tree 两次：第一次 200，第二次 HTTP 429（MCP_RATE_LIMITED）；
 *     接口的 rate_limited_total 恰好 +1、daily_quota=1；点"刷新记录"后页面读数与接口一致（计数 +1、配额 1）。
 *     finally 把日配额还原为 0，并吊销该令牌；
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

async function openMcp(actor) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  await ctx.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== base.origin) { externalRequests++; return route.abort('blockedbyclient') }
    return route.continue()
  })
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  await page.goto(new URL('/system/mcp', base).href)
  await page.waitForLoadState('networkidle')
  // 无权限账号可能被页面守卫挡住而根本没有标签：有则点开，没有就保持原样（后面断言读数卡不存在）
  const tab = page.getByText('人工确认与审计', { exact: true })
  if (await tab.count()) await tab.click()
  return { page, errors }
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
try {
  adminToken = (await apiLogin(api, 'admin', '12345')).token

  await step('admin: the readout card equals GET /api/mcp/limits field by field', async () => {
    const limits = await limitsOf(adminToken)
    for (const k of ['rpm', 'write_rpm', 'daily_quota', 'rate_limited_total']) assert.ok(Number.isInteger(limits[k]) && limits[k] >= 0, `limits.${k}`)
    assert.ok(limits.rpm >= 1 && limits.write_rpm >= 1)
    const { page, errors } = await openMcp({ username: 'admin', password: '12345' })
    await page.getByTestId('mcp-limits').waitFor()
    assert.deepEqual(await readout(page), { rpm: limits.rpm, write_rpm: limits.write_rpm, daily_quota: limits.daily_quota, rate_limited_total: limits.rate_limited_total })
    assert.deepEqual(errors, [])
  })

  await step('a real 429 (daily quota 1, second call) moves the counter by exactly one and the refreshed page shows quota and count', async () => {
    const before = await limitsOf(adminToken)
    assert.equal((await putQuota(adminToken, '1')).status, 200)
    const created = okData(await api('/api/mcp/tokens', { token: adminToken, body: { name: `ae11-limits-${randomSuffix()}`, scopes: 'read' } }))
    tokenId = created.id
    assert.equal(await mcpCall(created.token), 200)
    assert.equal(await mcpCall(created.token), 429)
    const after = await limitsOf(adminToken)
    assert.equal(after.daily_quota, 1)
    assert.equal(after.rate_limited_total, before.rate_limited_total + 1)
    const { page, errors } = await openMcp({ username: 'admin', password: '12345' })
    await page.getByTestId('mcp-limits').waitFor()
    assert.deepEqual(await readout(page), { rpm: after.rpm, write_rpm: after.write_rpm, daily_quota: 1, rate_limited_total: after.rate_limited_total })
    assert.equal(JSON.stringify(await page.getByTestId('mcp-limits').innerText()).includes(created.token), false, 'the readout never shows token material')
    assert.deepEqual(errors, [])
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
  if (adminToken) {
    await putQuota(adminToken, '0').catch(() => {})
    if (tokenId != null) await api(`/api/mcp/tokens/${tokenId}`, { token: adminToken, method: 'DELETE' }).catch(() => {})
  }
  await browser.close()
}
