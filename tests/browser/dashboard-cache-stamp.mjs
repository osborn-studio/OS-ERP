/**
 * ============================================================================
 * 文件标识：tests/browser/dashboard-cache-stamp.mjs ｜ 看板"数据截至 hh:mm:ss（缓存 30 s）"戳与刷新（AC11）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /（经营看板）：
 *   · admin 打开看板：summary / trend / top / todos 四个接口都是 200，响应顶层有 ISO 的 cached_at 与 cache_ttl_ms=30000；
 *     页面戳文案匹配 /数据截至 \d\d:\d\d:\d\d（缓存 30 s）/，data-cached-at 等于四个响应里**最早**的 cached_at（页面不会比任何一块数据更新）；
 *   · 点"刷新"：四个接口各再发一次请求并返回 200；戳不早于刷新前（命中缓存则不变、失效则前进），页面没有未捕获错误；
 *   · 一次真实写入（库存调整）之后再点"刷新"：summary 的 cached_at 前进（缓存被写入失效），页面戳随之前进或不变但不倒退，且等于四个新响应中最早的一个；
 *   · 无全局数据范围账号（role=purchase, data_scope=org）：看板接口 403（GLOBAL_DATA_FORBIDDEN）；路由把它重定向到采购工作台，
 *     根本不挂载看板——没有任何看板请求、没有戳、没有刷新按钮。
 * 账号密码随机，不打印；外部请求一律拦截并计数，必须为 0。
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
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }
const CACHED = ['summary', 'trend', 'top', 'todos']
const dashName = (r) => new URL(r.url()).pathname.replace('/api/dashboard/', '')
const isCachedDash = (r) => new URL(r.url()).pathname.startsWith('/api/dashboard/') && CACHED.includes(dashName(r))

async function openDashboard(actor) {
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
  // 登录会自己导航回首页并触发一轮看板请求；先让它落定，之后各步骤用显式的一次加载 / 刷新来观察，避免两次导航的响应混在一起
  await page.waitForLoadState('networkidle')
  return { page, errors }
}

/** 等 n 个缓存接口的 200 响应到齐，返回 { name: body }；调用方先 arm 再触发动作 */
function collect(page, count = CACHED.length) {
  const got = {}
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); page.off('response', onResponse); fn(v) }
    const timer = setTimeout(() => done(reject, new Error(`only got ${Object.keys(got).join(',')}`)), 15000)
    const onResponse = async (r) => {
      if (!isCachedDash(r) || got[dashName(r)]) return
      try { assert.equal(r.status(), 200); got[dashName(r)] = await r.json() } catch (e) { done(reject, e); return }
      if (Object.keys(got).length === count) done(resolve, got)
    }
    page.on('response', onResponse)
  })
}
const oldest = (bodies) => Object.values(bodies).map((b) => b.cached_at).sort()[0]
const stampText = /^数据截至 \d\d:\d\d:\d\d（缓存 30 s）$/

try {
  const adminToken = (await apiLogin(api, 'admin', '12345')).token
  let stampBefore = ''

  await step('dashboard shows the stamp of the oldest cached response (summary/trend/top/todos), 30 s ttl, ISO stamps', async () => {
    const { page, errors } = await openDashboard({ username: 'admin', password: '12345' })
    const all = collect(page)
    await page.reload()
    const bodies = await all
    for (const name of CACHED) {
      assert.match(bodies[name].cached_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, name)
      assert.equal(bodies[name].cache_ttl_ms, 30000, name)
    }
    const stamp = page.getByTestId('dashboard-cache-stamp')
    await stamp.waitFor()
    assert.match((await stamp.innerText()).trim(), stampText)
    stampBefore = await stamp.getAttribute('data-cached-at')
    assert.equal(stampBefore, oldest(bodies), 'the page stamp must be the oldest cached_at among the four responses')
    assert.equal(await stamp.getAttribute('data-ttl-ms'), '30000')
    assert.equal(await page.getByTestId('dashboard-refresh').isEnabled(), true)
    assert.deepEqual(errors, [])
  })

  await step('refresh re-requests the four endpoints and the stamp never moves backwards; a write restamps summary', async () => {
    const { page, errors } = await openDashboard({ username: 'admin', password: '12345' })
    const initial = collect(page)
    await page.reload()
    const first = await initial
    const stamp = page.getByTestId('dashboard-cache-stamp')
    await stamp.waitFor()
    const t0 = await stamp.getAttribute('data-cached-at')
    assert.equal(t0, oldest(first))

    const again = collect(page)
    await page.getByTestId('dashboard-refresh').click()
    const second = await again
    for (const name of CACHED) assert.ok(Date.parse(second[name].cached_at) >= Date.parse(first[name].cached_at), `${name}: stamp must not move backwards`)
    await page.waitForFunction(({ t }) => document.querySelector('[data-testid="dashboard-cache-stamp"]')?.getAttribute('data-cached-at') === t, { t: oldest(second) })
    assert.ok(Date.parse(await stamp.getAttribute('data-cached-at')) >= Date.parse(t0))

    // 真实写入使缓存失效：下一次取数是新的计算，戳前进
    const opts = okData(await api('/api/master/options', { token: adminToken }))
    const wh = opts.warehouses[0]
    const sku = opts.skus[0]
    okData(await api('/api/inventory/adjust', { token: adminToken, body: { warehouse_id: wh.value, sku_id: sku.value, batch_no: `DSH${Date.now().toString(36)}`, qty: 1, direction: 'in', reason: 'ac11 dashboard stamp fixture' } }))
    await new Promise((r) => setTimeout(r, 30))
    const third = collect(page)
    await page.getByTestId('dashboard-refresh').click()
    const afterWrite = await third
    assert.ok(Date.parse(afterWrite.summary.cached_at) > Date.parse(second.summary.cached_at), 'a write must invalidate the cache so summary is recomputed')
    await page.waitForFunction(({ t }) => document.querySelector('[data-testid="dashboard-cache-stamp"]')?.getAttribute('data-cached-at') === t, { t: oldest(afterWrite) })
    assert.match((await stamp.innerText()).trim(), stampText)
    assert.deepEqual(errors, [])
  })

  await step('restricted account: the API is 403 and the router never mounts the dashboard (redirect, no request, no stamp, no refresh)', async () => {
    const plain = await createAccount(api, adminToken, 'dc_plain', 'purchase', { data_scope: 'org' })
    const direct = await api('/api/dashboard/summary', { token: plain.token })
    assert.equal(direct.status, 403)
    const { page, errors } = await openDashboard(plain)
    const dashRequests = []
    page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/dashboard/')) dashRequests.push(r.url()) })
    await page.goto(new URL('/', base).href)
    await page.waitForURL((u) => u.pathname === '/purchase/workbench')
    await page.waitForLoadState('networkidle')
    assert.deepEqual(dashRequests, [], 'a restricted account must not even request dashboard data')
    assert.equal(await page.getByTestId('dashboard-cache-stamp').count(), 0)
    assert.equal(await page.getByTestId('dashboard-refresh').count(), 0)
    assert.deepEqual(errors, [])
  })

  assert.equal(externalRequests, 0, 'the scenario must not touch external origins')
  console.log(JSON.stringify({ suite: 'dashboard-cache-stamp-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('dashboard-cache-stamp', pages)
  throw error
} finally {
  await browser.close()
}
