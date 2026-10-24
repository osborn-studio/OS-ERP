/**
 * ============================================================================
 * 文件标识：tests/browser/metrics-hidden-note.mjs ｜ 指标目录"因权限未显示 N 个指标"说明槽位（AE11）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/metrics。本场景只验证版式槽位（数据层归 AE1），所以两部分：
 *   · 真实响应：槽位 metrics-hidden-slot 常驻；其 data-count 等于接口 /api/metrics 返回的 hidden_count（AE1 合入前该字段不存在 = 0）；
 *     count 为 0 时页面没有说明块，大于 0 时恰有一块；
 *   · 注入响应：用 page.route 把同一个 /api/metrics 响应加上 hidden_count=3 与 hidden_reason，页面必须出现一块说明，写明 3 个指标与原因，
 *     并且指标分组表仍照常渲染（说明不吞掉列表）；非法值（负数、NaN 字符串）不产生说明块；
 *   · 外部请求一律拦截并计数，必须为 0。
 * 账号密码不打印。浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { apiLogin, launchBrowser, loopbackBase, makeApi, okData, screenshotPages, uiLogin } from './lib.mjs'

const base = loopbackBase()
const api = makeApi(base)
const browser = await launchBrowser()
const pages = []
const results = []
let externalRequests = 0
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }
const isMetricsList = (r) => new URL(r.url()).pathname === '/api/metrics'

async function openMetrics(actor, rewrite) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== base.origin) { externalRequests++; return route.abort('blockedbyclient') }
    if (rewrite && url.pathname === '/api/metrics') {
      const res = await route.fetch()
      const body = await res.json()
      return route.fulfill({ response: res, json: { ...body, data: { ...body.data, ...rewrite } } })
    }
    return route.continue()
  })
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  const settled = page.waitForResponse(isMetricsList)
  await page.goto(new URL('/system/metrics', base).href)
  const res = await settled
  await page.getByRole('heading', { name: '数据口径字典' }).waitFor()
  // 响应到达不等于已渲染：等指标表出现（数据已进组件）再读槽位，避免读到加载中的初值
  await page.locator('table').first().waitFor()
  await page.getByTestId('metrics-hidden-slot').waitFor({ state: 'attached' })
  return { page, errors, status: res.status() }
}

try {
  const adminToken = (await apiLogin(api, 'admin', '12345')).token

  await step('real response: the slot is always there and its count equals the API hidden_count (0 before AE1)', async () => {
    const direct = okData(await api('/api/metrics?days=30&with_values=1', { token: adminToken }))
    const expected = Number.isInteger(direct.hidden_count) && direct.hidden_count > 0 ? direct.hidden_count : 0
    const { page, errors, status } = await openMetrics({ username: 'admin', password: '12345' })
    assert.equal(status, 200)
    assert.equal(Number(await page.getByTestId('metrics-hidden-slot').getAttribute('data-count')), expected)
    assert.equal(await page.getByTestId('metrics-hidden-note').count(), expected > 0 ? 1 : 0)
    assert.deepEqual(errors, [])
  })

  await step('injected hidden_count=3: exactly one note naming 3 indicators and the reason, and the indicator groups still render', async () => {
    const reason = '需要销售模块的查看权限'
    const { page, errors } = await openMetrics({ username: 'admin', password: '12345' }, { hidden_count: 3, hidden_reason: reason })
    assert.equal(Number(await page.getByTestId('metrics-hidden-slot').getAttribute('data-count')), 3)
    const note = page.getByTestId('metrics-hidden-note')
    assert.equal(await note.count(), 1)
    const text = await note.innerText()
    assert.match(text, /3 个指标/)
    assert.ok(text.includes(reason))
    assert.ok(await page.locator('table').count() >= 1, 'the indicator tables must still render next to the note')
    assert.deepEqual(errors, [])
  })

  await step('invalid hidden_count values (negative, string) never produce a note', async () => {
    for (const bad of [-2, 'abc']) {
      const { page, errors } = await openMetrics({ username: 'admin', password: '12345' }, { hidden_count: bad })
      assert.equal(Number(await page.getByTestId('metrics-hidden-slot').getAttribute('data-count')), 0, JSON.stringify(bad))
      assert.equal(await page.getByTestId('metrics-hidden-note').count(), 0, JSON.stringify(bad))
      assert.deepEqual(errors, [])
    }
  })

  assert.equal(externalRequests, 0, 'the scenario must not touch external origins')
  console.log(JSON.stringify({ suite: 'metrics-hidden-note-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('metrics-hidden-note', pages)
  throw error
} finally {
  await browser.close()
}
