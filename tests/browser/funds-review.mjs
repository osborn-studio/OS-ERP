/**
 * ============================================================================
 * 文件标识：tests/browser/funds-review.mjs ｜ 资金复核（ADR-0018）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建（GML_TEST_BASE_URL），数据由本脚本经 API 建在临时库里：
 *   1. 发起人（finance）无凭证点「确认收款」→ 服务端 400 FUNDS_EVIDENCE_REQUIRED，单据仍是草稿；
 *   2. 填凭证号再确认 → 200，review.status=pending_review，内核状态仍 draft；应收核销为 0；界面显示「待复核」
 *      与「你是发起人，需由另一人复核」，没有「复核通过」按钮、没有授信效果面板；
 *   3. 发起人自己调复核接口 → 409 FUNDS_SELF_REVIEW，仍待复核；
 *   4. 第二人（另一个 finance 账号）在界面点「复核通过」→ 200，status=confirmed、review.status=approved、
 *      复核人 = 第二人；授信效果面板出现并带本单单号；应收核销金额 = 收款金额。
 * 断言的是服务端状态与响应体，不只是页面上有没有某段文字。
 * 局限：夹具是不挂销售订单的手工应收，所以授信释放台账为空、释放金额为 0；面板只与服务端 credit_released 对照（行数 / 空态），
 *   不证明非零授信释放（那由 tests/funds-maker-checker.test.mjs 与授信台账测试负责）。
 * 不声明：不覆盖付款单（Payments.tsx）、不覆盖阈值/设置分支（见 tests/funds-maker-checker.test.mjs）。
 * 只在 Linux 托管 CI 或专用 Linux 主机运行；未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { apiLogin, createAccount, errorCode, launchBrowser, loopbackBase, makeApi, okData, randomSuffix, screenshotPages, uiLogin } from './lib.mjs'

const base = loopbackBase()
const api = makeApi(base)
const browser = await launchBrowser()
const pages = []
const results = []
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }

try {
  const admin = (await apiLogin(api, 'admin', '12345')).token
  const maker = await createAccount(api, admin, 'fr_maker', 'finance')
  const checker = await createAccount(api, admin, 'fr_checker', 'finance')

  const dealer = okData(await api('/api/master/options', { token: admin })).dealers?.[0]
  assert.ok(dealer, 'demo data must provide a dealer')
  const AR_AMOUNT = 300
  const RECEIPT_AMOUNT = 100
  const ar = okData(await api('/api/ar/documents', { token: maker.token, body: { subject_type: 'dealer', subject_id: dealer.value, subject_name: dealer.label, source_type: 'MANUAL', amount: AR_AMOUNT } }))
  const receipt = okData(await api('/api/ar/receipts', { token: maker.token, body: { subject_type: 'dealer', subject_id: dealer.value, amount: RECEIPT_AMOUNT, allocations: [{ ar_id: ar.id, amount: RECEIPT_AMOUNT }] } }))
  const allocated = async () => Number(okData(await api(`/api/ar/documents/${ar.id}`, { token: admin })).allocated_amount)
  const receiptRow = async () => okData(await api(`/api/ar/receipts/${receipt.id}`, { token: admin }))
  assert.equal(await allocated(), 0)

  const openReceipt = async (page, actor) => {
    await uiLogin(page, base, actor.username, actor.password)
    await page.goto(new URL('/finance/receivables', base).href)
    await page.locator('.tab', { hasText: '收款单' }).click()
    await page.getByPlaceholder('单号 / 往来对象 / 流水号').fill(receipt.doc_no)
    await page.getByRole('cell', { name: receipt.doc_no, exact: true }).click()
    await page.getByRole('heading', { name: `收款单 ${receipt.doc_no}` }).waitFor()
  }
  const responseTo = (page, suffix) => page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/ar/receipts/${receipt.id}/${suffix}`)

  const makerCtx = await browser.newContext()
  makerCtx.setDefaultTimeout(15000)
  const makerPage = await makerCtx.newPage()
  pages.push(makerPage)
  const pageErrors = []
  makerPage.on('pageerror', (e) => pageErrors.push(e.message))

  await step('maker without evidence is refused by the server and the receipt stays a plain draft', async () => {
    await openReceipt(makerPage, maker)
    const resp = responseTo(makerPage, 'confirm')
    await makerPage.getByRole('button', { name: '确认收款' }).click()
    const r = await resp
    assert.equal(r.status(), 400)
    assert.equal(errorCode({ body: await r.json() }), 'FUNDS_EVIDENCE_REQUIRED')
    const row = await receiptRow()
    assert.equal(row.status, 'draft')
    assert.notEqual(row.review?.status, 'pending_review')
    assert.equal(await allocated(), 0)
  })

  await step('maker confirms with evidence: pending_review, nothing is allocated, UI says another person must review', async () => {
    const evidence = `BROWSER-CI-${randomSuffix()}`
    await makerPage.getByPlaceholder('如 2026102300123456').fill(evidence)
    const resp = responseTo(makerPage, 'confirm')
    await makerPage.getByRole('button', { name: '确认收款' }).click()
    const r = await resp
    assert.equal(r.status(), 200)
    const data = (await r.json()).data
    assert.equal(data.status, 'draft')
    assert.equal(data.review.status, 'pending_review')
    assert.equal(data.review.maker.id, maker.id)
    const row = await receiptRow()
    assert.equal(row.review.status, 'pending_review')
    assert.equal(row.evidence_ref, evidence)
    assert.equal(await allocated(), 0, 'pending review must not touch receivables')
    await makerPage.getByText('你是发起人，需由另一人复核').waitFor()
    assert.equal(await makerPage.getByRole('button', { name: '复核通过' }).count(), 0)
    assert.equal(await makerPage.getByRole('button', { name: '确认收款' }).count(), 0)
    assert.equal(await makerPage.getByTestId('credit-effect-panel').count(), 0)
  })

  await step('self-review is rejected by the server with FUNDS_SELF_REVIEW and the request stays pending', async () => {
    const r = await api(`/api/ar/receipts/${receipt.id}/review`, { token: maker.token, body: { decision: 'approve', comment: 'self' } })
    assert.equal(r.status, 409)
    assert.equal(errorCode(r), 'FUNDS_SELF_REVIEW')
    assert.equal((await receiptRow()).review.status, 'pending_review')
    assert.equal(await allocated(), 0)
  })

  await step('a second user approves in the UI: confirmed, checker recorded, credit effect panel shown, receivable allocated', async () => {
    const ctx = await browser.newContext()
    ctx.setDefaultTimeout(15000)
    const page = await ctx.newPage()
    pages.push(page)
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await openReceipt(page, checker)
    await page.getByText('待复核', { exact: false }).first().waitFor()
    assert.equal(await page.getByText('你是发起人，需由另一人复核').count(), 0)
    page.once('dialog', (d) => d.accept('browser ci approval'))
    const resp = responseTo(page, 'review')
    await page.getByRole('button', { name: '复核通过' }).click()
    const r = await resp
    assert.equal(r.status(), 200)
    const data = (await r.json()).data
    assert.equal(data.status, 'confirmed')
    assert.equal(data.review.status, 'approved')
    assert.equal(data.review.checker.id, checker.id)
    assert.notEqual(data.review.checker.id, data.review.maker.id)
    const panel = page.getByTestId('credit-effect-panel')
    await panel.waitFor()
    const text = await panel.innerText()
    assert.ok(text.includes(receipt.doc_no), 'credit effect panel names the receipt')
    assert.ok(text.includes('本次释放授信'), 'credit effect panel states it is a release')
    // The panel must mirror the server's credit_released block: same number of ledger rows, empty-state only when the server says nothing was released.
    const released = data.credit_released
    assert.ok(released && Array.isArray(released.rows), 'approve response carries credit_released.rows')
    assert.equal(await panel.locator('tbody tr').count(), released.rows.length)
    assert.equal(text.includes('本次未触及授信占用'), released.rows.length === 0 && Number(released.unified || 0) === 0 && Number(released.oc || 0) === 0)
    const row = await receiptRow()
    assert.equal(row.status, 'confirmed')
    assert.equal(row.review.checker.id, checker.id)
    assert.equal(await allocated(), RECEIPT_AMOUNT)
    assert.equal(await page.getByRole('button', { name: '复核通过' }).count(), 0, 'no second approval is offered')
    const again = await api(`/api/ar/receipts/${receipt.id}/review`, { token: checker.token, body: { decision: 'approve', comment: 'again' } })
    assert.equal(again.status, 409)
    assert.equal(errorCode(again), 'FUNDS_NOT_PENDING')
    assert.equal(await allocated(), RECEIPT_AMOUNT, 'approval takes effect exactly once')
  })

  assert.deepEqual(pageErrors, [])
  console.log(JSON.stringify({ suite: 'funds-review-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('funds-review', pages)
  throw error
} finally {
  await browser.close()
}
