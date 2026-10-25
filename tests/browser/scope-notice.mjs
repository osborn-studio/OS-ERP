/**
 * ============================================================================
 * 文件标识：tests/browser/scope-notice.mjs ｜ 范围提示（ADR-0017 / W3）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是采购工作台 /purchase/workbench：
 *   · 无组织的受限内部账号（role=purchase，data_scope=org，无 org_id）：接口 200 且总览为 0，
 *     页面出现非阻断的 empty_scope 提示，工作台标题与数据区仍在；
 *   · 对照组 admin（全局范围）同一页面没有任何范围提示 —— 证明提示不是无条件显示；
 *   · 外部主体（role=store，绑定一家演示门店）：接口 403，页面出现阻断的 forbidden 提示，
 *     工作台标题与数据区不渲染（403 不能被画成"没有数据"）。
 * 断言接口状态与 data-kind，不只是文案存在。账号密码全部随机，不打印。
 * 不声明：不覆盖 401 / FEATURE_DISABLED 分支（见 tests/scope-notice.test.mjs 的纯函数断言）。
 * 只在 Linux 托管 CI 或专用 Linux 主机运行；未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { apiLogin, createAccount, launchBrowser, loopbackBase, makeApi, okData, screenshotPages, uiLogin } from './lib.mjs'

const base = loopbackBase()
const api = makeApi(base)
const browser = await launchBrowser()
const pages = []
const results = []
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }

async function workbenchAs(actor) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  const settled = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/purchase/chain/overview')
  await page.goto(new URL('/purchase/workbench', base).href)
  const overview = await settled
  return { page, errors, overviewStatus: overview.status() }
}

try {
  const admin = (await apiLogin(api, 'admin', '12345')).token
  const store = okData(await api('/api/master/options', { token: admin })).stores?.[0]
  assert.ok(store, 'demo data must provide a store')
  const unscoped = await createAccount(api, admin, 'sn_unscoped', 'purchase', { data_scope: 'org' })
  const storeUser = await createAccount(api, admin, 'sn_store', 'store', { store_id: store.value })
  const adminActor = { username: 'admin', password: '12345' }

  await step('no-org internal account: API is 200 with zero totals and the page shows the non-blocking empty-scope notice', async () => {
    const ov = okData(await api('/api/purchase/chain/overview', { token: unscoped.token }))
    assert.equal(ov.requisition.total, 0)
    assert.equal(ov.order.total, 0)
    const { page, errors, overviewStatus } = await workbenchAs(unscoped)
    assert.equal(overviewStatus, 200)
    const notice = page.getByTestId('scope-notice')
    await notice.waitFor()
    assert.equal(await notice.getAttribute('data-kind'), 'empty_scope')
    assert.equal(await notice.getAttribute('role'), 'status')
    assert.match(await notice.innerText(), /未关联组织或数据范围/)
    await page.getByRole('heading', { name: '采购工作台' }).waitFor()
    assert.deepEqual(errors, [])
  })

  await step('control: admin (global scope) sees the same page without any scope notice', async () => {
    const { page, overviewStatus } = await workbenchAs(adminActor)
    assert.equal(overviewStatus, 200)
    await page.getByRole('heading', { name: '采购工作台' }).waitFor()
    assert.equal(await page.getByTestId('scope-notice').count(), 0)
  })

  await step('store account: API is 403 and the page shows the blocking forbidden notice instead of an empty workbench', async () => {
    const direct = await api('/api/purchase/chain/overview', { token: storeUser.token })
    assert.equal(direct.status, 403)
    const { page, errors, overviewStatus } = await workbenchAs(storeUser)
    assert.equal(overviewStatus, 403)
    const notice = page.getByTestId('scope-notice')
    await notice.waitFor()
    assert.equal(await notice.getAttribute('data-kind'), 'forbidden')
    assert.equal(await notice.getAttribute('role'), 'alert')
    assert.match(await notice.innerText(), /没有访问权限/)
    assert.equal(await page.getByRole('heading', { name: '采购工作台' }).count(), 0, '403 must not render the data area')
    assert.equal(await page.locator('[data-kind="empty_scope"]').count(), 0, '403 must not be explained as an empty scope')
    assert.deepEqual(errors, [])
  })

  console.log(JSON.stringify({ suite: 'scope-notice-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('scope-notice', pages)
  throw error
} finally {
  await browser.close()
}
