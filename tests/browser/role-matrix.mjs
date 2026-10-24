/**
 * ============================================================================
 * 文件标识：tests/browser/role-matrix.mjs ｜ 角色与数据范围页（AD11）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/role-matrix：
 *   · 仓储账号：GET /api/meta/role-matrix 为 200；页面恰有一列被标为当前（data-current）且是 warehouse；
 *     该列每个单元格的 data-access 逐格等于接口 cells.warehouse；"我的角色与范围"里数据范围、门店 / 经销商绑定与接口一致（无绑定）；
 *     筛选框输入单据编码后只剩那一行；
 *   · 门店账号（绑定一家演示门店）：当前列是 store；采购单（PO）一格接口与页面都是 none（外部主体看不到内部域），
 *     页面的"绑定门店"显示该门店名（来自 /auth/my-scope），不是"无"；
 *   · 对照组 admin：当前列是 admin，凭证（VOUCHER）一格是 full；页面文本不含上面两个账号的用户名（矩阵不带其他主体）。
 * 全程拦截非回环请求并断言为 0；账号密码随机，不打印。
 * 浏览器部分只在 Linux 托管 CI 运行；未执行前不得称"浏览器场景已通过"。
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

async function openMatrix(actor) {
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
  const settled = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/meta/role-matrix')
  await page.goto(new URL('/system/role-matrix', base).href)
  const res = await settled
  const body = await res.json()
  await page.getByTestId('role-matrix-page').waitFor()
  await page.getByTestId('role-matrix-table').waitFor()
  return { page, errors, status: res.status(), data: body.data }
}

/** 当前列：表头恰一个 data-current，其单元格 data-access 逐格读出 */
async function currentColumn(page) {
  const heads = page.locator('thead th[data-current="true"]')
  assert.equal(await heads.count(), 1, 'exactly one column is highlighted as the caller\'s role')
  const role = await heads.getAttribute('data-role')
  const cells = await page.locator(`tbody td[data-role="${role}"]`).evaluateAll((els) => els.map((e) => [e.closest('tr').getAttribute('data-doc'), e.getAttribute('data-access')]))
  return { role, cells: Object.fromEntries(cells) }
}

try {
  const admin = (await apiLogin(api, 'admin', '12345')).token
  const store = okData(await api('/api/master/options', { token: admin })).stores?.[0]
  assert.ok(store, 'demo data must provide a store')
  const wh = await createAccount(api, admin, 'rm_wh', 'warehouse')
  const st = await createAccount(api, admin, 'rm_store', 'store', { store_id: store.value })
  const storeName = okData(await api('/api/auth/my-scope', { token: st.token })).store?.name
  assert.ok(storeName, 'the store account must see its bound store name in my-scope')

  await step('warehouse account: API 200, the highlighted column is warehouse and every cell equals the server matrix', async () => {
    const direct = okData(await api('/api/meta/role-matrix', { token: wh.token }))
    const { page, errors, status, data } = await openMatrix(wh)
    assert.equal(status, 200)
    assert.deepEqual(data.me, direct.me)
    assert.equal(data.me.role, 'warehouse')
    const col = await currentColumn(page)
    assert.equal(col.role, 'warehouse')
    assert.equal(data.restricted, true)
    assert.equal(await page.locator('thead th[data-role]').count(), 1, 'a non-admin sees only their own role column')
    assert.deepEqual(col.cells, data.cells.warehouse, 'page cells must be the server cells, not recomputed')
    assert.ok(Object.keys(col.cells).length >= 10)
    const SCOPE = { all: '全部数据', subtree: '本组织及下级', org: '仅本组织', self: '仅本人', dealer: '仅本经销商', none: '无（未关联组织）' }
    assert.equal(await page.getByTestId('role-matrix-me-scope').innerText(), SCOPE[data.me.data_scope_effective])
    assert.equal(await page.getByTestId('role-matrix-me-store').innerText(), '无')
    assert.equal(await page.getByTestId('role-matrix-me-dealer').innerText(), '无')
    assert.ok((await page.getByTestId('role-matrix-legend').locator('li').count()) === 5)
    await page.getByTestId('role-matrix-filter').fill('VOUCHER')
    assert.equal(await page.locator('tbody tr[data-doc]').count(), 1)
    assert.equal(await page.locator('tbody tr[data-doc="VOUCHER"]').count(), 1)
    assert.deepEqual(errors, [])
  })

  await step('store account: PO is none for it, the bound store name comes from my-scope, and its column is the highlighted one', async () => {
    const { page, errors, status, data } = await openMatrix(st)
    assert.equal(status, 200)
    assert.equal(data.cells.store.PO, 'none')
    const col = await currentColumn(page)
    assert.equal(col.role, 'store')
    assert.equal(col.cells.PO, 'none')
    assert.deepEqual(col.cells, data.cells.store)
    await page.getByTestId('role-matrix-me-store').filter({ hasText: storeName }).waitFor()
    assert.equal(await page.getByTestId('role-matrix-me-store').innerText(), storeName)
    assert.equal(data.restricted, true)
    assert.equal(data.me.store_bound, true)
    assert.deepEqual(errors, [])
  })

  await step('control: admin column is highlighted with full access and no other principal\'s name appears', async () => {
    const { page, errors, status, data } = await openMatrix({ username: 'admin', password: '12345' })
    assert.equal(status, 200)
    assert.equal(data.me.is_admin, true)
    const col = await currentColumn(page)
    assert.equal(col.role, 'admin')
    assert.equal(col.cells.VOUCHER, 'full')
    assert.equal(data.restricted, false)
    assert.ok((await page.locator('thead th[data-role]').count()) > 1, 'admin sees every role column')
    const text = await page.getByTestId('role-matrix-page').innerText()
    assert.ok(!text.includes(wh.username) && !text.includes(st.username), 'other accounts must not appear in the matrix page')
    assert.deepEqual(errors, [])
  })

  assert.equal(externalRequests, 0, 'the scenario must not touch external origins')
  console.log(JSON.stringify({ suite: 'role-matrix-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('role-matrix', pages)
  throw error
} finally {
  await browser.close()
}
