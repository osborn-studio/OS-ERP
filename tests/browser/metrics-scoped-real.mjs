/**
 * ============================================================================
 * 文件标识：tests/browser/metrics-scoped-real.mjs ｜ 指标目录"按范围计算"标记（AG11，接 AF2 真实字段）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/metrics。标记 = 受限账号（服务端 `scope_restricted === true`）+ 该行服务端标 `scoped === true`；
 * 前端不再从行上的 scoped 推断受限。三部分：
 *   · 真实管理员：`scope_restricted === false`，页面上一个"按范围计算"标记都没有；
 *   · 真实受限账号（role=purchase，绑定无下级组织，data_scope=org）：接口 `scope_restricted === true`；每个有值且 `scoped === true` 的行恰有 1 个标记、
 *     标记总数等于这些行数且大于 0、算不出的行没有标记；hidden_count > 0 时"未显示 N 项"说明块仍在且 data-count 一致（hide 模式文案不变）；
 *   · 注入响应（管理员页面，用 page.route 改写同一个 /api/metrics 响应）：缺 `scope_restricted` 字段、或 false 时即使有 scoped=true / scoped=false 行也 0 个标记（不推断）；
 *     `scope_restricted=true` 且含 scoped=false（label 模式）行时：该行只有"全局口径"没有标记，scoped 缺失的行没有标记；
 *   · 外部请求一律拦截并计数，必须为 0。
 * 账号密码随机，不打印。浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { apiLogin, createAccount, launchBrowser, loopbackBase, makeApi, okData, screenshotPages, uiLogin } from './lib.mjs'
import { pickLeafOrg } from './scenario-data.mjs'

const base = loopbackBase()
const api = makeApi(base)
const browser = await launchBrowser()
const pages = []
const results = []
let externalRequests = 0
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }
const isError = (v) => !!v && typeof v === 'object' && 'error' in v

// 注入形态：对前三个有值的行设 scoped（true / false / 缺失），顶层 scope_restricted 按参数设置或删除
function shape(body, { restricted, scopedRows }) {
  const items = body.data.groups.flatMap((g) => g.items).filter((m) => !isError(m.value))
  const picks = items.slice(0, 3)
  const [a, b, c] = picks
  a.scoped = scopedRows[0]; b.scoped = scopedRows[1]; c.scoped = scopedRows[2]
  for (const m of picks) if (m.scoped === undefined) delete m.scoped
  if (restricted === undefined) delete body.data.scope_restricted
  else body.data.scope_restricted = restricted
  return picks.map((m) => m.key)
}

async function openMetrics(actor, inject) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  let keys = []
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== base.origin) { externalRequests++; return route.abort('blockedbyclient') }
    if (inject && url.pathname === '/api/metrics') {
      const res = await route.fetch()
      const body = await res.json()
      keys = shape(body, inject)
      return route.fulfill({ response: res, json: body })
    }
    return route.continue()
  })
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  const settled = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/metrics')
  await page.goto(new URL('/system/metrics', base).href)
  const res = await settled
  await page.getByRole('heading', { name: '数据口径字典' }).waitFor()
  await page.locator('table').first().waitFor()
  return { page, errors, keys: () => keys, status: res.status() }
}

try {
  const admin = (await apiLogin(api, 'admin', '12345')).token

  await step('real admin: scope_restricted is false and no row carries the marker', async () => {
    const direct = okData(await api('/api/metrics?days=30&with_values=1', { token: admin }))
    assert.strictEqual(direct.scope_restricted, false)
    const { page, errors } = await openMetrics({ username: 'admin', password: '12345' })
    assert.equal(await page.getByTestId('metric-scoped-marker').count(), 0)
    assert.deepEqual(errors, [])
  })

  await step('real restricted account: every valued scoped=true row has exactly one marker, nothing else does', async () => {
    const org = await pickLeafOrg(api, admin)
    const acct = await createAccount(api, admin, 'ms_metrics', 'purchase', { org_id: org.id, data_scope: 'org' })
    const direct = okData(await api('/api/metrics?days=30&with_values=1', { token: acct.token }))
    assert.strictEqual(direct.scope_restricted, true)
    const items = direct.groups.flatMap((g) => g.items)
    const want = items.filter((m) => !isError(m.value) && m.scoped === true).map((m) => m.key)
    assert.ok(want.length > 0, 'a restricted purchase account must see at least one scope-aware metric')
    const { page, errors, status } = await openMetrics(acct)
    assert.equal(status, 200)
    assert.equal(await page.getByTestId('metric-scoped-marker').count(), want.length)
    for (const k of want) assert.equal(await page.getByTestId(`metric-value-${k}`).getByTestId('metric-scoped-marker').count(), 1, k)
    const hidden = Number(direct.hidden_count) || 0
    assert.equal(await page.getByTestId('metrics-hidden-note').count(), hidden > 0 ? 1 : 0)
    assert.equal(Number(await page.getByTestId('metrics-hidden-slot').getAttribute('data-count')), hidden)
    assert.deepEqual(errors, [])
  })

  await step('injected: scope_restricted missing or false never marks (no inference from per-row scoped)', async () => {
    for (const restricted of [undefined, false]) {
      const { page, errors } = await openMetrics({ username: 'admin', password: '12345' }, { restricted, scopedRows: [true, false, true] })
      assert.equal(await page.getByTestId('metric-scoped-marker').count(), 0, String(restricted))
      assert.deepEqual(errors, [])
    }
  })

  await step('injected scope_restricted=true (label-mode shape): scoped=true rows marked, the scoped=false row shows 全局口径 without a marker, a row without scoped has none', async () => {
    const { page, errors, keys } = await openMetrics({ username: 'admin', password: '12345' }, { restricted: true, scopedRows: [true, false, undefined] })
    const [a, b, c] = keys()
    await page.getByTestId('metric-scoped-marker').first().waitFor()
    assert.equal(await page.getByTestId(`metric-value-${a}`).getByTestId('metric-scoped-marker').count(), 1)
    const globalCell = page.getByTestId(`metric-value-${b}`)
    assert.equal(await globalCell.getByTestId('metric-scoped-marker').count(), 0)
    assert.match(await globalCell.innerText(), /全局口径/)
    assert.equal(await page.getByTestId(`metric-value-${c}`).getByTestId('metric-scoped-marker').count(), 0)
    assert.deepEqual(errors, [])
  })

  assert.equal(externalRequests, 0, 'the scenario must not touch external origins')
  console.log(JSON.stringify({ suite: 'metrics-scoped-real-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('metrics-scoped-real', pages)
  throw error
} finally {
  await browser.close()
}
