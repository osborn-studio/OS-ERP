/**
 * ============================================================================
 * 文件标识：scripts/test-invoice.mjs ｜ 测试：销售发票测试（模块 24）
 * ============================================================================
 * 【职责】测试：销售发票测试（模块 24）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 销售发票测试（模块 24）
 *
 * 守三条口径（三条都是"事实与人工状态必须一致"的推论）：
 *   ① 开票不动库存 —— 只产生债权；
 *   ② 开票关闭是可推导的 —— 由「已确认蓝字发票的行数量 SUM」与发货/订单数量比对得出；
 *   ③ 红冲不删原票 —— 原票留痕 + 关联应收作废 + 生成红字负数票。
 *
 * 与定价/成本/应收测试同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-invoice.mjs [industry]
 */
import { getDbFor } from '../server/db/index.js'
import {
  InvoiceError,
  createInvoiceFromDelivery, createManualInvoice,
  submitInvoice, confirmInvoice, redChartInvoice, voidInvoice,
  refreshCloseStatus, pendingLinesOfDelivery, pendingDeliveries,
  listInvoices, getInvoice, invoiceOverview, auditInvoice
} from '../server/lib/invoice.js'
import { pruneOrphanEvents } from '../server/lib/docflow.js'
import { recalcArBySubject } from '../server/lib/ar.js'

const INDUSTRY = process.argv[2] || 'cosmetic'
const db = getDbFor(INDUSTRY)

let pass = 0
let fail = 0
const only = []
function ok(cond, msg) {
  if (cond) pass++
  else { fail++; only.push(msg); console.log('  ✗', msg) }
}
function eq(msg, actual, expect) {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  ✗ ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) <= eps
const okNear = (a, b, msg, eps = 0.02) => { if (!near(a, b, eps)) console.log(`  ✗ ${msg}：期望≈${b}，实际 ${a}`); ok(near(a, b, eps), msg) }
const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
const throws = (fn, code, msg) => {
  try { fn() } catch (e) {
    const hit = !code || (e instanceof InvoiceError && e.code === code) || e.code === code
    if (!hit) console.log(`  ✗ ${msg}：抛的是 ${e.code}/${e.message}`)
    ok(hit, msg)
    return
  }
  console.log(`  ✗ ${msg}：没有抛错`)
  ok(false, msg)
}

console.log(`\n=== 销售发票（${INDUSTRY}） ===`)

// ---------- -1. 残留自愈：让测试可以重复跑 ----------
// 上一轮若中途抛错，发票（本票 + 红字票）与其 SI 应收会留在库里，
// 下一次跑时 pending 队列与开票关闭状态已被污染。开跑前先清自己的痕迹。
// 标记约定：发票 remark 以 '【TEST-SI】' 开头、手工票票号 'TEST-SI-%'。
// 注意：红冲自动生成的红字票 remark 是「红冲 <原票号>：<原因>」，不带标记，
// 必须靠 red_chart_of_id 反查才能兜住（本项目真实踩过：漏掉它 → 每轮留 1 张残票）。
const TEST_TAG = '【TEST-SI】'
function testInvoiceIds() {
  return db
    .prepare(
      `SELECT id FROM sales_invoices WHERE remark LIKE ?
        OR invoice_no LIKE 'TEST-SI-%'
        OR red_chart_of_id IN (SELECT id FROM sales_invoices WHERE remark LIKE ?)
        OR red_chart_of_id IN (SELECT id FROM sales_invoices WHERE invoice_no LIKE 'TEST-SI-%')`
    )
    .all(`${TEST_TAG}%`, `${TEST_TAG}%`)
    .map((r) => r.id)
}
function purgeTestInvoices() {
  const invIds = testInvoiceIds()
  if (!invIds.length) return { invoices: 0, ars: 0 }
  const ph = invIds.map(() => '?').join(',')
  const arIds = db
    .prepare(`SELECT id FROM ar_documents WHERE source_type='SI' AND source_id IN (${ph})`)
    .all(...invIds)
    .map((r) => r.id)
  db.transaction(() => {
    for (const id of arIds) {
      db.prepare('DELETE FROM receipt_allocations WHERE ar_id=?').run(id)
      db.prepare('DELETE FROM ar_documents WHERE id=?').run(id)
      db.prepare("DELETE FROM doc_events WHERE doc_type='AR' AND doc_id=?").run(id)
    }
    db.prepare(`DELETE FROM invoice_ar_links WHERE invoice_id IN (${ph}) OR ar_id IN (${arIds.length ? arIds.map(() => '?').join(',') : 'NULL'})`).run(...invIds, ...arIds)
    db.prepare(`DELETE FROM sales_invoice_items WHERE invoice_id IN (${ph})`).run(...invIds)
    db.prepare(`DELETE FROM sales_invoices WHERE id IN (${ph})`).run(...invIds)
    db.prepare(`DELETE FROM doc_events WHERE doc_type='SI' AND doc_id IN (${ph})`).run(...invIds)
  })()
  db.prepare("DELETE FROM doc_events WHERE doc_type='AR' AND doc_id NOT IN (SELECT id FROM ar_documents)").run()
  refreshCloseStatus(db, {})
  return { invoices: invIds.length, ars: arIds.length }
}
const cleaned = purgeTestInvoices()
if (cleaned.invoices || cleaned.ars) {
  console.log(`  （已清理上一轮残留：发票 ${cleaned.invoices} 张 / SI 应收 ${cleaned.ars} 张）`)
}

// ---------- 0. 单据内核注册 ----------
const types = db.prepare('SELECT code FROM doc_types').all().map((r) => r.code)
ok(types.includes('SI'), '内核已注册销售发票 SI')
const siStates = db.prepare("SELECT code FROM doc_states WHERE doc_type='SI'").all().map((r) => r.code)
eq('发票五状态', siStates.sort(), ['confirmed', 'draft', 'pending', 'red_charted', 'voided'])
const siActs = db.prepare("SELECT action, is_danger FROM doc_actions WHERE doc_type='SI'").all()
ok(siActs.find((a) => a.action === 'submit'), '有提交动作')
ok(siActs.find((a) => a.action === 'confirm'), '有确认（开票）动作')
ok(siActs.find((a) => a.action === 'red_chart')?.is_danger === 1, '红冲标为危险动作（红字票需能说明为什么冲）')
ok(db.prepare("SELECT 1 AS hit FROM biz_flows WHERE code='FLOW_SALES_INVOICE'").get(), '业务流 FLOW_SALES_INVOICE 已注册')
// confirmed 不能是终态 —— 开错票必须能红冲回来
const confirmedState = db.prepare("SELECT is_final FROM doc_states WHERE doc_type='SI' AND code='confirmed'").get()
eq('已开票不是终态（可红冲）', confirmedState.is_final, 0)

// ---------- 1. 开票不动库存（口径硬约束）----------
const stockBefore = db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get()
const stockSnapBefore = db.prepare('SELECT COUNT(*) c FROM inventory_batches').get().c

// ---------- 2. 手工开票：价税拆分 + 全生命周期（含红冲）----------
const dealer = db.prepare('SELECT id, name FROM dealers ORDER BY id LIMIT 1').get()
const manual = createManualInvoice(db, {
  subjectType: 'dealer',
  subjectId: dealer.id,
  subjectName: dealer.name,
  invoiceDate: dayOffset(-1),
  invoiceNo: 'TEST-SI-001',
  taxRate: 0.13,
  items: [
    { sku_id: null, qty: 10, price: 113, tax_rate: 0.13 },   // 含税 1130 → 不含税 1000 / 税 130
    { sku_id: null, qty: 2, price: 226, tax_rate: 0.13 }     // 含税 452  → 不含税 400 / 税 52
  ],
  remark: `${TEST_TAG}手工开票测试`,
  actor: { id: null, name: '测试' }
})
eq('手工票状态为草稿', manual.status, 'draft')
ok(manual.doc_no.startsWith('SI'), `手工票号以 SI 开头（${manual.doc_no}）`)
okNear(manual.total_amount, 1582, '价税合计 = 1130 + 452')
okNear(manual.amount, 1400, '不含税金额 = 1000 + 400')
okNear(manual.tax_amount, 182, '税额 = 130 + 52')
const manualItems = db.prepare('SELECT * FROM sales_invoice_items WHERE invoice_id=? ORDER BY line_no').all(manual.id)
eq('手工票两行', manualItems.length, 2)
okNear(manualItems[0].amount, 1000, '第 1 行不含税金额')
okNear(manualItems[0].tax_amount, 130, '第 1 行税额')

// 草稿不参与开票关闭：还没提交/确认，不应计入任何"已开票"口径
const draftCountInConfirmed = db.prepare("SELECT COUNT(*) c FROM sales_invoices WHERE id=? AND status='confirmed'").get(manual.id).c
eq('草稿票不出现在已开票口径', draftCountInConfirmed, 0)

submitInvoice(db, { id: manual.id, actor: { id: null, name: '测试' } })
eq('提交后为待确认', getInvoice(db, manual.id).status, 'pending')

const conf = confirmInvoice(db, { id: manual.id, creditDays: 30, actor: { id: null, name: '测试' } })
eq('确认后为已开票', conf.invoice.status, 'confirmed')
ok(conf.ar && conf.ar.id > 0, '确认开票生成/关联了应收')
eq('无订单来源时新建 SI 应收', conf.ar.source_type, 'SI')
eq('关联关系为 created', conf.relation, 'created')
const link = db.prepare('SELECT * FROM invoice_ar_links WHERE invoice_id=?').get(manual.id)
ok(!!link, '发票 ↔ 应收关联已写入')
okNear(link.amount, 1582, '关联金额 = 价税合计')
okNear(conf.ar.amount, 1582, 'SI 应收金额 = 价税合计')
eq('SI 应收来源单据号 = 发票号', conf.ar.source_doc_no, manual.doc_no)

throws(() => voidInvoice(db, { id: manual.id, actor: null }), 'SI_CONFIRMED_CANNOT_VOID', '已开票的不能直接作废')

// --- 红冲 ---
throws(() => redChartInvoice(db, { id: manual.id, reason: '', actor: null }), 'SI_REASON_REQUIRED', '红冲必须填原因')
const red = redChartInvoice(db, { id: manual.id, reason: '开票信息有误，重开', actor: { id: null, name: '测试' } })
eq('原票置已红冲', red.invoice.status, 'red_charted')
eq('红字票状态为已开票', red.red.status, 'confirmed')
eq('红字票类型为 red', red.red.invoice_type, 'red')
eq('红字票指回原票', red.red.red_chart_of_id, manual.id)
okNear(red.red.total_amount, -1582, '红字票金额为负（−1582）')
const redItems = db.prepare('SELECT * FROM sales_invoice_items WHERE invoice_id=? ORDER BY line_no').all(red.red.id)
okNear(redItems[0].qty, -10, '红字票第 1 行数量为负')
const arAfterRed = db.prepare('SELECT status FROM ar_documents WHERE id=?').get(conf.ar.id)
eq('红冲后关联应收置作废', arAfterRed.status, 'voided')
ok(getInvoice(db, manual.id).red_invoices.length === 1, '原票详情能看到红字票')
okNear(getInvoice(db, manual.id).red_invoices[0].total_amount, -1582, '详情里红字票金额为负')
ok(getInvoice(db, red.red.id).origin_invoice.id === manual.id, '红字票详情能看到原票')

// ---------- 3. 由发货单开票 + 开票关闭（可推导）----------
const cand = pendingDeliveries(db, {}).filter((r) => r.remain_qty > 1)
ok(cand.length > 0, '存在可开票的发货单')
const dl = cand[0]
const dlLines = pendingLinesOfDelivery(db, dl.id)
eq('待开行为非空', dlLines.length > 0, true)
const line0 = dlLines[0]

// 分批：只开该行一半
const halfQty = Math.max(0.5, Math.floor(line0.remain_qty / 2 * 100) / 100)
// 这张发货单可能**已经开过一部分票**（演示库里专造了"部分开票"样本），
// 所以判据只能是「本次开票让它**增加了** halfQty」，不能假设它从 0 开始。
// 写成绝对值 `== halfQty` 会在有历史开票的库上假红 —— 而假红和真红在输出里长得一样。
const sumBefore = Number(db.prepare('SELECT invoice_qty_sum FROM sales_deliveries WHERE id=?').get(dl.id).invoice_qty_sum) || 0
const inv1 = createInvoiceFromDelivery(db, {
  deliveryId: dl.id,
  invoiceNo: 'TEST-SI-DL1',
  taxRate: 0.13,
  items: [{ item_id: line0.item_id, qty: halfQty }],
  remark: `${TEST_TAG}发货单分批开票 1`,
  actor: { id: null, name: '测试' }
})
eq('由发货单开票为草稿', inv1.status, 'draft')
eq('草稿来源为 DL', inv1.source_type, 'DL')
eq('草稿带发货单号', inv1.source_doc_no, dl.doc_no)
// 草稿不参与开票关闭
eq('草稿不改变开票关闭状态', db.prepare('SELECT invoice_status FROM sales_deliveries WHERE id=?').get(dl.id).invoice_status, dl.invoice_status)

submitInvoice(db, { id: inv1.id, actor: null })
confirmInvoice(db, { id: inv1.id, actor: { id: null, name: '测试' } })
const dlAfterPartial = db.prepare('SELECT invoice_status, invoice_qty_sum FROM sales_deliveries WHERE id=?').get(dl.id)
eq('部分开票 → partial', dlAfterPartial.invoice_status, 'partial')
okNear(dlAfterPartial.invoice_qty_sum, sumBefore + halfQty, `已开票数量 = 原已开 ${sumBefore} + 本次 ${halfQty}`)
const remainAfter = pendingLinesOfDelivery(db, dl.id).find((l) => l.item_id === line0.item_id)
okNear(remainAfter.remain_qty, line0.remain_qty - halfQty, '剩余可开数量相应减少')

// 开完剩下
const restQty = remainAfter.remain_qty
const inv2 = createInvoiceFromDelivery(db, {
  deliveryId: dl.id,
  invoiceNo: 'TEST-SI-DL2',
  items: [{ item_id: line0.item_id, qty: restQty }],
  remark: `${TEST_TAG}发货单分批开票 2`,
  actor: null
})
submitInvoice(db, { id: inv2.id, actor: null })
confirmInvoice(db, { id: inv2.id, actor: null })
const dlAfterFull = db.prepare('SELECT invoice_status, invoice_qty_sum FROM sales_deliveries WHERE id=?').get(dl.id)
// 该发货单可能还有其它行未开，故不强制全开；只要该行开满，剩余行为空即可
const remainLines = pendingLinesOfDelivery(db, dl.id)
ok(!remainLines.find((l) => l.item_id === line0.item_id), '该行已开满，不再出现在待开队列')
ok(['partial', 'invoiced'].includes(dlAfterFull.invoice_status), `开票关闭状态合理（${dlAfterFull.invoice_status}）`)

// 超开保护：再对该行开票应被拒（已无剩余）
throws(() => createInvoiceFromDelivery(db, { deliveryId: dl.id, items: [{ item_id: line0.item_id, qty: 1 }], actor: null }), 'SI_NOTHING_TO_INVOICE', '已开满的行不能再开票')

// 不存在的发货单
throws(() => createInvoiceFromDelivery(db, { deliveryId: 99999999, actor: null }), 'SI_DELIVERY_NOT_FOUND', '不存在的发货单不能开票')

// 已收款不能红冲：手工票在确认时会新建 SI 应收，给它补一条核销明细模拟"已收款"
const anyReceipt = db.prepare("SELECT id FROM receipts WHERE status='confirmed' ORDER BY id LIMIT 1").get()
  || db.prepare('SELECT id FROM receipts ORDER BY id LIMIT 1').get()
if (anyReceipt) {
  const paidInv = createManualInvoice(db, {
    subjectType: 'dealer', subjectId: dealer.id, subjectName: dealer.name,
    invoiceNo: 'TEST-SI-PAID', taxRate: 0.13,
    items: [{ sku_id: null, qty: 1, price: 500 }],
    remark: `${TEST_TAG}已收款红冲拦截`, actor: null
  })
  submitInvoice(db, { id: paidInv.id, actor: null })
  const paidConf = confirmInvoice(db, { id: paidInv.id, actor: null })
  ok(paidConf.ar.source_type === 'SI', '手工票确认后新建 SI 应收')
  db.prepare('INSERT INTO receipt_allocations (receipt_id, ar_id, amount) VALUES (?,?,?)').run(anyReceipt.id, paidConf.ar.id, 0.01)
  // 红冲拦截读的是 ar_documents.allocated_amount（已收金额由核销明细 SUM 重算而来），
  // 直接插明细不会自动回写，这里按模块 21 的口径重算一次
  recalcArBySubject(db, { subjectType: 'dealer', subjectId: dealer.id })
  throws(() => redChartInvoice(db, { id: paidInv.id, reason: '测试已收款拦截', actor: null }), 'SI_AR_ALLOCATED', '已收过款的发票不能直接红冲')
  db.prepare('DELETE FROM receipt_allocations WHERE receipt_id=? AND ar_id=?').run(anyReceipt.id, paidConf.ar.id)
  recalcArBySubject(db, { subjectType: 'dealer', subjectId: dealer.id })
} else {
  console.log('  · 跳过"已收款拦截"（库中没有收款单可借用）')
}

// ---------- 4. 作废（仅草稿/待确认）----------
const voidDraft = createManualInvoice(db, {
  subjectType: 'dealer', subjectId: dealer.id, subjectName: dealer.name,
  invoiceNo: 'TEST-SI-VOID', taxRate: 0.13,
  items: [{ sku_id: null, qty: 1, price: 100 }],
  remark: `${TEST_TAG}待作废`, actor: null
})
voidInvoice(db, { id: voidDraft.id, reason: '误开', actor: null })
eq('草稿可作废', getInvoice(db, voidDraft.id).status, 'voided')

// ---------- 4b. 零金额发票（赠品 / 全额折让）----------
// 债权为 0 时没有"账"可记，仍应能开票并参与开票关闭，但**不应**去建一张 0 元应收
// （否则 ensureAr 的金额校验会把票挡在门外，赠品开票直接失败 —— 本轮真实踩到）。
const zeroInv = createManualInvoice(db, {
  subjectType: 'dealer', subjectId: dealer.id, subjectName: dealer.name,
  invoiceNo: 'TEST-SI-ZERO', taxRate: 0.13,
  items: [{ sku_id: null, qty: 0, price: 0 }],
  remark: `${TEST_TAG}零金额赠品票`, actor: null
})
okNear(zeroInv.total_amount, 0, '零金额票价税合计为 0')
submitInvoice(db, { id: zeroInv.id, actor: null })
const zeroConf = confirmInvoice(db, { id: zeroInv.id, actor: null })
eq('零金额票可以确认开票', zeroConf.invoice.status, 'confirmed')
eq('零金额票不产生应收', zeroConf.ar, null)
eq('零金额票无应收关联', db.prepare('SELECT COUNT(*) c FROM invoice_ar_links WHERE invoice_id=?').get(zeroInv.id).c, 0)

// ---------- 5. 列表与总览 ----------
const listed = listInvoices(db, { keyword: 'TEST-SI', pageSize: 50 })
ok(listed.total >= 3, `列表能按关键字查到测试票（${listed.total}）`)
const ov = invoiceOverview(db)
ok(ov.confirmed_count >= 0 && typeof ov.pending_deliveries === 'number', '总览返回结构正常')
ok(ov.red_count >= 1, '总览统计到红字票')

// ---------- 6. 开票不动库存（复核）----------
const stockAfter = db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get()
const stockSnapAfter = db.prepare('SELECT COUNT(*) c FROM inventory_batches').get().c
eq('开票不改动 inventory_transactions 行数', stockAfter.c, stockBefore.c)
eq('开票不改动库存批次', stockSnapAfter, stockSnapBefore)

// ---------- 7. 自洽审计 ----------
const audit = auditInvoice(db)
ok(audit.headDrift.length === 0, '审计：头金额与行 SUM 一致（零漂移）')
ok(audit.overQty.length === 0, '审计：无超开发票')
ok(audit.missingAr.length === 0, '审计：已确认票都有应收关联')
ok(audit.orphanLinks.length === 0, '审计：无孤儿关联')
ok(audit.badClose.length === 0, '审计：开票关闭状态无漂移')
ok(audit.ok, '自洽审计整体通过')

// ---------- 8. 清理本轮测试数据 ----------
const purged = purgeTestInvoices()
ok(purged.invoices > 0, `清理了测试发票（${purged.invoices} 张）`)
eq('清理干净（无残票）', testInvoiceIds().length, 0)
eq('没有遗留测试 SI 应收', db.prepare("SELECT COUNT(*) c FROM ar_documents WHERE source_type='SI' AND remark LIKE ?").get(`%${TEST_TAG}%`).c, 0)
eq('没有遗留测试发票行', db.prepare(`SELECT COUNT(*) c FROM sales_invoice_items WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE remark LIKE ? OR invoice_no LIKE 'TEST-SI-%')`).get(`${TEST_TAG}%`).c, 0)
eq('没有遗留测试关联', db.prepare(`SELECT COUNT(*) c FROM invoice_ar_links WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE remark LIKE ? OR invoice_no LIKE 'TEST-SI-%')`).get(`${TEST_TAG}%`).c, 0)
eq('没有遗留测试流转留痕', db.prepare("SELECT COUNT(*) c FROM doc_events WHERE doc_type='SI' AND doc_id NOT IN (SELECT id FROM sales_invoices)").get().c, 0)
refreshCloseStatus(db, { deliveryId: dl.id, orderId: dl.order_id })
eq('清理后该发货单恢复原开票状态', db.prepare('SELECT invoice_status FROM sales_deliveries WHERE id=?').get(dl.id).invoice_status, dl.invoice_status)
ok(pruneOrphanEvents(db, { dryRun: true }).removed === 0, '无孤儿流转留痕')
ok(auditInvoice(db).ok, '清理后仍自洽')

console.log(`\n通过 ${pass}　失败 ${fail}`)
if (only.length) console.log('失败项：\n - ' + only.join('\n - '))
console.log('─'.repeat(64))
process.exit(fail ? 1 : 0)
