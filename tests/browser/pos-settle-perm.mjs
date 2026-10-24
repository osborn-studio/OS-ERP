/**
 * ============================================================================
 * 文件标识：tests/browser/pos-settle-perm.mjs ｜ POS 差异结案 pos.shift.settle 与作废 pos.refund 的按钮闸（AA9）真实浏览器场景
 * ============================================================================
 * 真实 test 模式服务 + 真实前端构建 + 真实登录与 /api/auth/my-permissions（按钮闸读的就是它）；
 * 只有 POS 业务数据接口用夹具拦截（避免为一个按钮闸去造门店 / 班次 / 单据全套数据），并记录写请求：
 *   · /store/monitor（总部 POS 监控）：挂账长短款卡片上"责任人承担 / 公司承担"——无 pos.shift.settle 的账号一个都没有；
 *     admin 有，点"责任人承担"会 POST /api/pos/shifts/<id>/settle-variance，body 为 { handled: 'charge' }；
 *   · /pos?tab=orders（本机单据）："作废"按钮——无 pos.refund 的账号没有；admin 有，点击会 POST /api/pos/orders/<id>/void；
 *   · 对账：每个账号的按钮有无，等于其 my-permissions 是否含对应权限点（含 '*'）。
 * 角色由 roles-permissions 动态挑选，不写死角色名。外部请求拦截并计数，必须为 0。账号密码随机，不打印。
 * 浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { apiLogin, createAccount, launchBrowser, loopbackBase, makeApi, okData, screenshotPages, uiLogin } from './lib.mjs'
import { pickRole } from './scenario-data.mjs'

const SETTLE = 'pos.shift.settle'
const REFUND = 'pos.refund'
const VARIANCE = { id: 7001, doc_no: 'FIXTURE-SHIFT-7001', store_name: 'Fixture store', biz_date: '2026-01-02', cashier_name: 'Fixture cashier', variance: 12, variance_handled: 'pending' }
const ORDER = { id: 9001, doc_no: 'FIXTURE-POS-9001', biz_date: '2026-01-02', item_count: 1, status: 'local', pay_amount: 10, pay_method: 'cash', member_phone: null }
const base = loopbackBase()
const api = makeApi(base)
const browser = await launchBrowser()
const pages = []
const results = []
let externalRequests = 0
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }

async function open(actor, route) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  const writes = []
  const respond = (r, data) => r.fulfill({ json: { success: true, data } })
  await ctx.route('**/*', (r) => {
    const req = r.request()
    const url = new URL(req.url())
    if (url.origin !== base.origin) { externalRequests++; return r.abort('blockedbyclient') }
    const p = url.pathname
    if (req.method() === 'GET') {
      if (p === '/api/pos/hq/overview') return respond(r, { totals: {}, stores: [] })
      if (p === '/api/pos/hq/daily-closes') return respond(r, [])
      if (p === '/api/pos/hq/cash-inflight') return respond(r, { pending_drops: [], pending_variances: [VARIANCE], variance_limit: 500 })
      if (p === '/api/pos/context') return respond(r, { store: { name: 'Fixture store' }, warehouse: { name: 'Fixture warehouse' }, shift: null, local_orders: 1 })
      if (p === '/api/pos/orders') return respond(r, [ORDER])
    } else if (/^\/api\/pos\/(shifts\/\d+\/settle-variance|orders\/\d+\/void)$/.test(p)) {
      writes.push({ path: p, method: req.method(), body: req.postDataJSON() })
      return respond(r, { id: 1 })
    }
    return r.continue()
  })
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  await page.goto(new URL(route, base).href)
  return { page, errors, writes }
}

const has = (perms, code) => perms.includes(code) || perms.includes('*')

async function checkMonitor(actor, perms) {
  const { page, errors, writes } = await open(actor, '/store/monitor')
  await page.getByText(VARIANCE.doc_no).waitFor()
  const expected = has(perms, SETTLE) ? 1 : 0
  assert.equal(await page.getByRole('button', { name: '责任人承担' }).count(), expected)
  assert.equal(await page.getByRole('button', { name: '公司承担' }).count(), expected)
  assert.deepEqual(errors, [])
  return { page, writes }
}
async function checkOrders(actor, perms) {
  const { page, errors, writes } = await open(actor, '/pos?tab=orders')
  await page.getByText(ORDER.doc_no).waitFor()
  // 权限点异步取回后按钮才出现：先等到页面稳定再数（无权限时不出现，故以 my-permissions 响应为界）
  await page.waitForLoadState('networkidle')
  assert.equal(await page.getByRole('button', { name: '作废', exact: true }).count(), has(perms, REFUND) ? 1 : 0)
  assert.deepEqual(errors, [])
  return { page, writes }
}

try {
  const admin = (await apiLogin(api, 'admin', '12345')).token
  const noneRole = await pickRole(api, admin, { lacking: [SETTLE, REFUND] })
  assert.ok(noneRole, `a non-admin role without ${SETTLE} and ${REFUND} must exist`)
  const none = await createAccount(api, admin, 'pos_none', noneRole, { data_scope: 'all' })
  const permsOf = async (token) => okData(await api('/api/auth/my-permissions', { token })).permissions

  await step('account without pos.shift.settle / pos.refund: no settle buttons and no void button', async () => {
    const perms = await permsOf(none.token)
    assert.ok(!has(perms, SETTLE) && !has(perms, REFUND))
    await checkMonitor(none, perms)
    await checkOrders(none, perms)
  })

  const settleOnly = await pickRole(api, admin, { having: [SETTLE], lacking: [REFUND] })
  if (settleOnly) {
    await step('role with settle but not refund: settle buttons yes, void button no (the two gates are independent)', async () => {
      const acct = await createAccount(api, admin, 'pos_settle', settleOnly, { data_scope: 'all' })
      const perms = await permsOf(acct.token)
      await checkMonitor(acct, perms)
      await checkOrders(acct, perms)
    })
  }
  const refundOnly = await pickRole(api, admin, { having: [REFUND], lacking: [SETTLE] })
  if (refundOnly) {
    await step('role with refund but not settle: void button yes, settle buttons no', async () => {
      const acct = await createAccount(api, admin, 'pos_refund', refundOnly, { data_scope: 'all' })
      const perms = await permsOf(acct.token)
      await checkMonitor(acct, perms)
      await checkOrders(acct, perms)
    })
  }

  await step('admin: settle buttons POST settle-variance with handled=charge, and the void button POSTs the void', async () => {
    const admin2 = { username: 'admin', password: '12345' }
    const perms = await permsOf(admin)
    const m = await checkMonitor(admin2, perms)
    assert.equal(await m.page.getByRole('button', { name: '责任人承担' }).count(), 1)
    const settled = m.page.waitForResponse((r) => r.url().includes(`/api/pos/shifts/${VARIANCE.id}/settle-variance`))
    await m.page.getByRole('button', { name: '责任人承担' }).click()
    assert.equal((await settled).status(), 200)
    assert.deepEqual(m.writes.map((w) => [w.method, w.path, w.body]), [['POST', `/api/pos/shifts/${VARIANCE.id}/settle-variance`, { handled: 'charge' }]])
    const o = await checkOrders(admin2, perms)
    const voided = o.page.waitForResponse((r) => r.url().includes(`/api/pos/orders/${ORDER.id}/void`))
    await o.page.getByRole('button', { name: '作废', exact: true }).click()
    assert.equal((await voided).status(), 200)
    assert.equal(o.writes.length, 1)
    assert.equal(o.writes[0].path, `/api/pos/orders/${ORDER.id}/void`)
  })

  assert.equal(externalRequests, 0, 'no request may leave the loopback origin')
  console.log(JSON.stringify({ suite: 'pos-settle-perm-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('pos-settle-perm', pages)
  throw error
} finally {
  await browser.close()
}
