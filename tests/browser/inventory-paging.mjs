/**
 * ============================================================================
 * 文件标识：tests/browser/inventory-paging.mjs ｜ 库存查询游标翻页（Z3）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /inventory/stocks：
 *   · 经真实库存调整接口造 65 个互不相同的批次行（随机前缀），用页面的关键字过滤把结果限定到这 65 行；
 *   · 接口层：逐页沿 next_after_id 取（pageSize 20 与 50 各一遍），并集恰等于一次取全的集合、每个 id 恰出现一次、
 *     total/summary 只在第一页出现；
 *   · 页面：第一页 50 行，响应带 total=65 与 summary；点"下一页"发出带 after_id（= 第一页的 next_after_id）的请求，
 *     响应没有 total，页面 15 行，"下一页"禁用；两页批次号的并集恰等于造数集合且互不相交；
 *     点"上一页"重新发出不带 after_id 的请求，响应又带 total，第一页内容与第一次完全相同，"上一页"禁用。
 * 账号为 admin，批次前缀随机；不打印令牌。接口数据期望在 scenario-data.mjs，由 tests/browser-scenario-contracts.test.mjs
 * 在本机验证；浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { apiLogin, launchBrowser, loopbackBase, makeApi, screenshotPages, uiLogin } from './lib.mjs'
import { assertExactlyOnce, seedStockRows, walkStocks } from './scenario-data.mjs'

const base = loopbackBase()
const api = makeApi(base)
const browser = await launchBrowser()
const pages = []
const results = []
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }
const COUNT = 65
const PAGE = 50
const isStocks = (r) => new URL(r.url()).pathname === '/api/inventory/stocks'

try {
  const adminToken = (await apiLogin(api, 'admin', '12345')).token
  const seeded = await seedStockRows(api, adminToken, COUNT)

  await step('API cursor walk (pageSize 20 and 50): union equals the seeded set, each id once, total only on page one', async () => {
    for (const size of [20, PAGE]) {
      const walk = await walkStocks(api, adminToken, seeded.prefix, size)
      assertExactlyOnce(walk, COUNT)
      assert.equal(walk.pages.length, Math.ceil(COUNT / size))
      assert.deepEqual(walk.pages.flatMap((p) => p.batches).sort(), seeded.batches)
    }
  })

  await step('page: next/prev walk the same 65 rows with the cursor in the request and total only on the first response', async () => {
    const ctx = await browser.newContext()
    ctx.setDefaultTimeout(15000)
    const page = await ctx.newPage()
    pages.push(page)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await uiLogin(page, base, 'admin', '12345')
    await page.goto(new URL('/inventory/stocks', base).href)
    await page.getByRole('heading', { name: '库存查询' }).waitFor()

    const keywordParam = (r) => new URL(r.url()).searchParams
    const firstLoad = page.waitForResponse((r) => isStocks(r) && keywordParam(r).get('keyword') === seeded.prefix && !keywordParam(r).has('after_id'))
    await page.getByPlaceholder('SKU 编码 / 商品名 / 批次号').fill(seeded.prefix)
    const first = await firstLoad
    assert.equal(first.status(), 200)
    const firstData = (await first.json()).data
    assert.equal(firstData.total, COUNT)
    assert.ok(firstData.summary, 'first page carries the summary')
    assert.equal(firstData.has_more, true)
    assert.equal(firstData.list.length, PAGE)

    const batchColumn = page.locator('tbody tr td:nth-child(6)')
    const shownBatches = async (n) => {
      await page.waitForFunction((count) => document.querySelectorAll('tbody tr td:nth-child(6)').length === count, n)
      return (await batchColumn.allInnerTexts()).map((s) => s.trim())
    }
    const page1 = await shownBatches(PAGE)
    assert.deepEqual(page1, firstData.list.map((r) => r.batch_no), 'rows shown are the rows the API returned')
    await page.getByText(`第 1–${PAGE} 条 / 共 ${COUNT} 条`).waitFor()
    assert.equal(await page.getByRole('button', { name: '上一页' }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '下一页' }).isDisabled(), false)

    const secondLoad = page.waitForResponse((r) => isStocks(r) && keywordParam(r).get('after_id') === String(firstData.next_after_id))
    await page.getByRole('button', { name: '下一页' }).click()
    const second = await secondLoad
    assert.equal(keywordParam(second).get('keyword'), seeded.prefix, 'the filter must travel with the cursor')
    const secondData = (await second.json()).data
    assert.equal('total' in secondData, false, 'later pages must not recompute the total')
    assert.equal(secondData.has_more, false)
    assert.equal(secondData.list.length, COUNT - PAGE)
    const page2 = await shownBatches(COUNT - PAGE)
    assert.deepEqual(page2, secondData.list.map((r) => r.batch_no))
    await page.getByText(`第 ${PAGE + 1}–${COUNT} 条 / 共 ${COUNT} 条`).waitFor()
    assert.equal(await page.getByRole('button', { name: '下一页' }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '上一页' }).isDisabled(), false)

    assert.equal(new Set([...page1, ...page2]).size, COUNT, 'no row appears on both pages')
    assert.deepEqual([...page1, ...page2].sort(), seeded.batches, 'union of the two pages is exactly the seeded set')
    const ids = [...firstData.list, ...secondData.list].map((r) => r.id)
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b))

    const backLoad = page.waitForResponse((r) => isStocks(r) && keywordParam(r).get('keyword') === seeded.prefix && !keywordParam(r).has('after_id'))
    await page.getByRole('button', { name: '上一页' }).click()
    const back = await backLoad
    const backData = (await back.json()).data
    assert.equal(backData.total, COUNT, 'returning to page one fetches the total again')
    assert.deepEqual(await shownBatches(PAGE), page1, 'page one is identical after going back')
    assert.equal(await page.getByRole('button', { name: '上一页' }).isDisabled(), true)
    assert.deepEqual(errors, [])
  })

  console.log(JSON.stringify({ suite: 'inventory-paging-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('inventory-paging', pages)
  throw error
} finally {
  await browser.close()
}
