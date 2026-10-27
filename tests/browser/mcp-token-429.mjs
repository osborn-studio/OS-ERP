/**
 * ============================================================================
 * 文件标识：tests/browser/mcp-token-429.mjs ｜ MCP 令牌页"每令牌近期限流"块（AF11）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/mcp 的"人工确认与审计"标签。托管 CI 的服务是默认的 memory 速率存储，
 * 所以 db 模式的形态用 page.route 注入（桶表语义归 tests/mcp-limits-tokens.test.mjs）：
 *   · 真实响应：GET /api/mcp/limits/tokens 管理员 200，store 与页面块的 data-store 一致；memory 模式 tokens 为空且页面没有任何令牌行；
 *   · 注入 db 响应（一张触顶 2 个窗口、一张 0）：页面恰有 1 行，id / 次数与注入一致，不显示 0 的令牌；全为 0 时显示"没有令牌被限流"；
 *   · AH11：Agent Token 表的「近期限流（429）」列：真实签发两张令牌；memory 存储下列显示破折号（data-recent 为空），注入 db 响应后精确显示 3 / 0 次，窗口说明含注入的秒数；场景结束吊销所签令牌；
 *   · 无权限账号（role=purchase）：接口 403、未登录 401，页面没有该块。
 * 令牌明文与账号密码都不打印；页面文本不得出现令牌哈希 / 前缀字样；外部请求一律拦截并计数，必须为 0。
 * 浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { apiLogin, createAccount, launchBrowser, loopbackBase, makeApi, okData, screenshotPages, uiLogin } from './lib.mjs'

const base = loopbackBase()
const api = makeApi(base)
const browser = await launchBrowser()
const pages = []
const results = []
let externalRequests = 0
let adminTokenForCleanup = null
const createdTokenIds = []
let cleanupFailed = false
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }
const TOKENS_PATH = '/api/mcp/limits/tokens'

async function openMcp(actor, inject) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== base.origin) { externalRequests++; return route.abort('blockedbyclient') }
    if (inject && url.pathname === TOKENS_PATH) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, success: true, data: inject }) })
    return route.continue()
  })
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  await page.goto(new URL('/system/mcp', base).href)
  await page.waitForLoadState('networkidle')
  const tab = page.getByText('人工确认与审计', { exact: true })
  if (await tab.count()) await tab.click()
  return { page, errors }
}

try {
  const adminToken = (await apiLogin(api, 'admin', '12345')).token

  await step('real response: admin 200, the block mirrors the store; memory mode shows no token rows', async () => {
    const d = okData(await api(TOKENS_PATH, { token: adminToken }))
    assert.ok(['memory', 'db'].includes(d.store))
    assert.ok(Array.isArray(d.tokens))
    if (d.store === 'memory') assert.deepEqual(d.tokens, [])
    const { page, errors } = await openMcp({ username: 'admin', password: '12345' })
    const block = page.getByTestId('mcp-token-429')
    await block.waitFor()
    assert.equal(await block.getAttribute('data-store'), d.store)
    if (d.store === 'memory') assert.equal(await page.getByTestId('mcp-token-429-row').count(), 0)
    assert.deepEqual(errors, [])
  })

  await step('injected db response: only the token that hit the ceiling is listed, with its window count', async () => {
    const inject = { store: 'db', window_seconds: 60, tokens: [{ id: 7, name: 'busy-agent', rate_limited_recent: 2 }, { id: 8, name: 'quiet-agent', rate_limited_recent: 0 }] }
    const { page, errors } = await openMcp({ username: 'admin', password: '12345' }, inject)
    const block = page.getByTestId('mcp-token-429')
    await block.waitFor()
    assert.equal(await block.getAttribute('data-store'), 'db')
    const rows = page.getByTestId('mcp-token-429-row')
    assert.equal(await rows.count(), 1)
    assert.equal(await rows.first().getAttribute('data-token-id'), '7')
    assert.equal(await rows.first().getAttribute('data-recent'), '2')
    const text = await block.innerText()
    assert.ok(text.includes('busy-agent') && !text.includes('quiet-agent'))
    assert.doesNotMatch(text, /token_hash|token_prefix/)
    assert.deepEqual(errors, [])
  })

  await step('injected db response with nothing at the ceiling: shows the empty statement and no rows', async () => {
    const { page, errors } = await openMcp({ username: 'admin', password: '12345' }, { store: 'db', window_seconds: 60, tokens: [{ id: 8, name: 'quiet-agent', rate_limited_recent: 0 }] })
    await page.getByTestId('mcp-token-429-empty').waitFor()
    assert.equal(await page.getByTestId('mcp-token-429-row').count(), 0)
    assert.deepEqual(errors, [])
  })

  // AH11：Agent Token 表自己的「近期限流（429）」列。令牌是真实签发的（/api/mcp/tokens），限流数形态用注入（共用服务是 memory 存储）
  await step('AH11 token list column: real tokens, memory mode shows a dash; injected db counts show exact numbers and the window note', async () => {
    adminTokenForCleanup = adminToken
    const busy = okData(await api('/api/mcp/tokens', { token: adminToken, body: { name: `ah11-busy-${Math.random().toString(16).slice(2, 8)}`, scopes: 'read' } }))
    const quiet = okData(await api('/api/mcp/tokens', { token: adminToken, body: { name: `ah11-quiet-${Math.random().toString(16).slice(2, 8)}`, scopes: 'read' } }))
    createdTokenIds.push(busy.id, quiet.id)
    const real = okData(await api(TOKENS_PATH, { token: adminToken }))
    const m = await openMcp({ username: 'admin', password: '12345' })
    const cell = (page, id) => page.locator(`[data-testid="mcp-token-limited"][data-token-id="${id}"]`)
    await cell(m.page, busy.id).waitFor()
    if (real.store === 'memory') assert.equal(await cell(m.page, busy.id).getAttribute('data-recent'), '')
    assert.deepEqual(m.errors, [])
    const inject = { store: 'db', window_seconds: 45, tokens: [{ id: busy.id, name: busy.name, rate_limited_recent: 3 }, { id: quiet.id, name: quiet.name, rate_limited_recent: 0 }] }
    const { page, errors } = await openMcp({ username: 'admin', password: '12345' }, inject)
    await cell(page, busy.id).waitFor()
    assert.equal(await cell(page, busy.id).getAttribute('data-recent'), '3')
    assert.equal(await cell(page, quiet.id).getAttribute('data-recent'), '0')
    assert.ok((await cell(page, busy.id).innerText()).includes('3 次'))
    const note = await page.getByTestId('mcp-token-limited-note').innerText()
    assert.ok(note.includes('45 秒窗口') && note.includes('不是累计值'))
    const tableText = await page.locator('table').first().innerText()
    assert.equal(tableText.includes(busy.token) || tableText.includes(quiet.token), false, 'the list never shows token material')
    assert.deepEqual(errors, [])
    // 响应被截断（只含 busy 一张）时，不在响应里的 quiet 令牌是"未知"，不能显示成 0
    const cut = await openMcp({ username: 'admin', password: '12345' }, { store: 'db', truncated: true, window_seconds: 45, tokens: [{ id: busy.id, name: busy.name, rate_limited_recent: 3 }] })
    await cell(cut.page, busy.id).waitFor()
    assert.equal(await cell(cut.page, busy.id).getAttribute('data-recent'), '3')
    assert.equal(await cell(cut.page, quiet.id).getAttribute('data-recent'), '')
    assert.ok((await cell(cut.page, quiet.id).innerText()).includes('未知'))
    assert.deepEqual(cut.errors, [])
  })

  await step('non-admin: the endpoint is 403 (401 without a token) and the page has no block', async () => {
    const plain = await createAccount(api, adminToken, 'af_plain', 'purchase')
    assert.equal((await api(TOKENS_PATH, { token: plain.token })).status, 403)
    assert.equal((await api(TOKENS_PATH)).status, 401)
    const { page, errors } = await openMcp(plain)
    await page.waitForLoadState('networkidle')
    assert.equal(await page.getByTestId('mcp-token-429').count(), 0)
    assert.deepEqual(errors.filter((e) => !/403/.test(e)), [])
  })

  assert.equal(externalRequests, 0, 'the scenario must not touch external origins')
  console.log(JSON.stringify({ suite: 'mcp-token-429-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('mcp-token-429', pages)
  throw error
} finally {
  // 吊销本场景签发的令牌；API 失败不会抛错，必须看状态码
  if (adminTokenForCleanup) {
    for (const id of createdTokenIds) {
      const r = await api(`/api/mcp/tokens/${id}`, { token: adminTokenForCleanup, method: 'DELETE' }).catch(() => null)
      if (!r || r.status !== 200) { cleanupFailed = true; console.error('mcp-token-429: failed to revoke a scenario token') }
    }
  }
  await browser.close()
}
if (cleanupFailed) process.exitCode = 1
