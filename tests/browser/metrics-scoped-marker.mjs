/**
 * ============================================================================
 * 文件标识：tests/browser/metrics-scoped-marker.mjs ｜ 指标目录"按范围计算"标记（AF11）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/metrics。标记只给"受限账号 + 该指标按范围收窄"的行，数据层归 AF2，所以两部分：
 *   · 真实响应（管理员，不受限）：页面上一个"按范围计算"标记都没有（不能在管理员页面上误标）；
 *   · 注入响应：用 page.route 把同一个 /api/metrics 响应改成受限账号形态——前两个指标 scoped=true、第三个 scoped=false（全局口径）、
 *     顶层 restricted=true：前两个指标各有 1 个标记（其余按范围的行也有，算不出的行没有值格故不标），全局口径行只有"全局口径"没有"按范围计算"；
 *     同样的响应但 restricted=false 时标记为 0；没有 restricted 字段但有 scoped=false 的行（当前接口形态）时按推断视为受限，标记数同上；
 *   · 外部请求一律拦截并计数，必须为 0。
 * 账号密码不打印。浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { launchBrowser, loopbackBase, screenshotPages, uiLogin } from './lib.mjs'

const base = loopbackBase()
const browser = await launchBrowser()
const pages = []
const results = []
let externalRequests = 0
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }

// 取响应里前三个指标的 key，按形态改写；返回被标 scoped 的 key 列表供断言
function shape(body, { restricted }) {
  const items = body.data.groups.flatMap((g) => g.items)
  const keys = items.slice(0, 3).map((m) => m.key)
  for (const m of items) m.scoped = true
  items[2].scoped = false
  if (restricted === undefined) delete body.data.restricted
  else body.data.restricted = restricted
  return keys
}

async function openMetrics(rewriteOpts) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  let keys = []
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== base.origin) { externalRequests++; return route.abort('blockedbyclient') }
    if (rewriteOpts && url.pathname === '/api/metrics') {
      const res = await route.fetch()
      const body = await res.json()
      keys = shape(body, rewriteOpts)
      return route.fulfill({ response: res, json: body })
    }
    return route.continue()
  })
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, 'admin', '12345')
  const settled = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/metrics')
  await page.goto(new URL('/system/metrics', base).href)
  await settled
  await page.getByRole('heading', { name: '数据口径字典' }).waitFor()
  await page.locator('table').first().waitFor()
  return { page, errors, keys: () => keys }
}

try {
  await step('real admin response: no "按范围计算" marker anywhere', async () => {
    const { page, errors } = await openMetrics(null)
    assert.equal(await page.getByTestId('metric-scoped-marker').count(), 0)
    assert.deepEqual(errors, [])
  })

  await step('injected restricted shape: exactly the two scoped rows carry the marker, the global-scope row does not', async () => {
    const { page, errors, keys } = await openMetrics({ restricted: true })
    const [a, b, c] = keys()
    const markers = page.getByTestId('metric-scoped-marker')
    await markers.first().waitFor()
    assert.ok(await markers.count() >= 2, 'scoped rows are marked')
    for (const k of [a, b]) assert.equal(await page.getByTestId(`metric-value-${k}`).getByTestId('metric-scoped-marker').count(), 1, k)
    const globalCell = page.getByTestId(`metric-value-${c}`)
    assert.equal(await globalCell.getByTestId('metric-scoped-marker').count(), 0)
    assert.match(await globalCell.innerText(), /全局口径/)
    assert.deepEqual(errors, [])
  })

  await step('restricted=false: no marker; restricted field absent but a scoped=false row exists: inferred restricted, markers shown', async () => {
    const off = await openMetrics({ restricted: false })
    assert.equal(await off.page.getByTestId('metric-scoped-marker').count(), 0)
    assert.deepEqual(off.errors, [])
    const inferred = await openMetrics({ restricted: undefined })
    await inferred.page.getByTestId('metric-scoped-marker').first().waitFor()
    assert.ok(await inferred.page.getByTestId('metric-scoped-marker').count() >= 1)
    assert.deepEqual(inferred.errors, [])
  })

  assert.equal(externalRequests, 0, 'the scenario must not touch external origins')
  console.log(JSON.stringify({ suite: 'metrics-scoped-marker-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('metrics-scoped-marker', pages)
  throw error
} finally {
  await browser.close()
}
