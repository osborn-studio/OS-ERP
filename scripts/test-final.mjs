/**
 * ============================================================================
 * 文件标识：scripts/test-final.mjs ｜ 测试：收尾批次：三条遗留不变量（A10 / A17b / A18）
 * ============================================================================
 * 【职责】测试：收尾批次：三条遗留不变量（A10 / A17b / A18）
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
 * 收尾批次：三条遗留不变量（A10 / A17b / A18）
 *
 * 三条的形状完全不同，但**根因是同一种**：判据住在了错误的地方 ——
 *   A10  红冲「按关联整张作废应收」，把「这张票的债权」当成了「这个客户的债权」；
 *   A17b 建单校验了价格与数量、**改单**没有；出库函数**没校验数量符号**；
 *        MCP 只验必填、不验类型与范围；
 *   A18 付款核销**信调用方**：信它给的结算单属于本供应商、信它没超未付余额、信它在有效期内。
 *
 * 所以这里按「入口 × 边界」写，而不是按接口写：
 *   ① 同一张共享应收上有多张票时，红冲一张不能把别人一起干掉（且 SI 口径不受影响）；
 *   ② 付款核销的每一条明细都要过四道闸：主体、状态、金额符号、未付余额（含同一张单重复出现）；
 *   ③ 只改单头（运费/折扣）必须重算；库存出入库的数量必须 > 0；MCP 入参必须过 schema。
 *
 * 与其它域同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-final.mjs [cosmetic|food|apparel]
 *
 * 关于「可重复跑」：本测试会造真实的发票 / 应收 / 结算单 / 付款单 / 销售订单。
 * 开跑前按标记 `__test_final__` 把自己上一轮的残渣**成对清掉**（子表 → 父表），
 * 结束后再清一次。红字票的 remark 是「红冲 <原票号>：<原因>」不带标记，
 * 必须靠 `red_chart_of_id` 反查（本项目在 test-invoice 里真实踩过漏掉它的坑）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { nextDocNo } from '../server/lib/docno.js'
import {
  createManualInvoice, submitInvoice, confirmInvoice, redChartInvoice, InvoiceError
} from '../server/lib/invoice.js'
import { createPayment, transitionPayment, PurchaseError } from '../server/lib/purchase.js'
import { applyStockIn, applyStockOut } from '../server/lib/stock.js'
import { validateToolArgs } from '../server/mcp/validate.js'
import { sellableSkus, sellableSkusInWarehouse, isSellable } from '../server/lib/catalog.js'
import { listTools } from '../server/mcp/tools.js'
import { pruneOrphanEvents } from '../server/lib/docflow.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { DATA_DIR, dbPathFor, INDUSTRIES } from '../server/db/index.js'
// 子进程回收的**唯一实现**（`test-guards.mjs:166-205` 的同一形状，抽出来避免各写一版）
import { stopAndReport, installReapFallback } from './lib/reap.mjs'

const ROOT = path.resolve(__dirname, '..')
// ---------- 落点自证：这一跑会读写哪个数据目录 ----------
// 库路径一律从 db/index.js 的 `dbPathFor` 取，不在这里另写一份 `ROOT/data` ——
// 否则"打印出来的落点"和"真正打开的文件"会分家，脚本就会说谎（比不打印更坏）。
console.log(`[落点] 数据目录：${path.resolve(DATA_DIR)}`)
// 判据（两条，缺一不可）：
//   ① 没设 `GML_DATA_DIR` ⇒ 按定义就是开发库（`DATA_DIR = GML_DATA_DIR || <项目>/data`，
//      见 `server/db/index.js:10`）——这是**主**判据；
//   ② 设了、但指到项目 `data/` 本身。
// ① 必须有：字符串比较在 macOS 上会被 `/tmp → /private/tmp` 这类符号链接骗到
// （实测：副本里本该告警却**没**告警，把判据反过来才告警 —— 拿它当唯一判据是错的）。
if (!process.env.GML_DATA_DIR || path.resolve(DATA_DIR) === path.resolve(path.join(ROOT, 'data'))) {
  console.log('⚠️ 本次将读写开发库 data/ —— 若要隔离请设 GML_DATA_DIR=/tmp/...')
}
const INDUSTRY = process.argv[2] || 'cosmetic'
// 行业名必须合法：`dbPathFor` / `getDbFor` 会把**未知行业码静默归一成 cosmetic**
// （`server/db/index.js:28-30`），于是一个字母打错（`fodd`）会安静地跑另一个库，
// 拿到的"绿"是假的。调用侧自己把住"错名要响"。
if (process.argv[2] && !INDUSTRIES[process.argv[2]]) {
  console.error(`✗ 未知行业：${process.argv[2]}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
  process.exit(2)
}
const PORT = 3197
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) pass++
  else {
    fail++
    failures.push(msg)
    console.log(`  \x1b[31m✗\x1b[0m ${msg}${detail !== undefined ? `  → ${String(detail).slice(0, 240)}` : ''}`)
  }
}
const eq = (msg, actual, expect) => {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) <= eps
const okNear = (a, b, msg, eps = 0.02) => {
  if (!near(a, b, eps)) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望≈${b}，实际 ${a}`)
  ok(near(a, b, eps), msg)
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)
/** 断言抛错并带上期望的业务码；抛错本身也是断言（"没抛错"要能看出是这条挂了） */
const throws = (fn, code, msg) => {
  try {
    fn()
  } catch (e) {
    const hit = !code || e.code === code
    if (!hit) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${code}，实得 ${e.code || e.message}`)
    ok(hit, msg)
    return
  }
  console.log(`  \x1b[31m✗\x1b[0m ${msg}：没有抛错`)
  ok(false, msg)
}

const T = '__test_final__'
const dbFile = dbPathFor(INDUSTRY)
const db = new Database(dbFile)
db.pragma('journal_mode = WAL')
const actor = { id: null, name: 'test-final' }
const ymd = (d = new Date()) => d.toISOString().slice(0, 10)
const ph = (n) => Array.from({ length: n }, () => '?').join(',')

console.log(`=== 收尾遗留不变量测试（${INDUSTRY}） ===`)

// ---------------------------------------------------------------- 残留自愈
function testInvoiceIds() {
  const base = db.prepare('SELECT id FROM sales_invoices WHERE remark LIKE ?').all(`${T}%`).map((r) => r.id)
  if (!base.length) return []
  const reds = db
    .prepare(`SELECT id FROM sales_invoices WHERE red_chart_of_id IN (${ph(base.length)})`)
    .all(...base)
    .map((r) => r.id)
  return [...base, ...reds]
}
function cleanup() {
  const invIds = testInvoiceIds()
  const stat = { invoices: 0, ars: 0, payments: 0, settles: 0, orders: 0 }
  db.transaction(() => {
    if (invIds.length) {
      const P = ph(invIds.length)
      const arIds = db
        .prepare(
          `SELECT DISTINCT ar_id FROM invoice_ar_links WHERE invoice_id IN (${P})
            UNION SELECT id FROM ar_documents WHERE source_type='SI' AND source_id IN (${P})`
        )
        .all(...invIds, ...invIds)
        .map((r) => r.ar_id)
      db.prepare(`DELETE FROM invoice_ar_links WHERE invoice_id IN (${P})`).run(...invIds)
      db.prepare(`DELETE FROM sales_invoice_items WHERE invoice_id IN (${P})`).run(...invIds)
      db.prepare(`DELETE FROM sales_invoices WHERE id IN (${P})`).run(...invIds)
      if (arIds.length) {
        db.prepare(`DELETE FROM receipt_allocations WHERE ar_id IN (${ph(arIds.length)})`).run(...arIds)
        db.prepare(`DELETE FROM ar_documents WHERE id IN (${ph(arIds.length)})`).run(...arIds)
      }
      stat.invoices = invIds.length
      stat.ars = arIds.length
    }
    // 自造的共享应收（SO 口径，不经 SI 来源，所以上面那张查询捞不到）
    const soAr = db.prepare(`SELECT id FROM ar_documents WHERE remark LIKE ?`).all(`${T}%`).map((r) => r.id)
    if (soAr.length) {
      db.prepare(`DELETE FROM receipt_allocations WHERE ar_id IN (${ph(soAr.length)})`).run(...soAr)
      db.prepare(`DELETE FROM ar_documents WHERE id IN (${ph(soAr.length)})`).run(...soAr)
      stat.ars += soAr.length
    }
    // 付款单（子 → 父）
    const payIds = db.prepare('SELECT id FROM purchase_payments WHERE remark LIKE ?').all(`${T}%`).map((r) => r.id)
    if (payIds.length) {
      db.prepare(`DELETE FROM purchase_payment_items WHERE payment_id IN (${ph(payIds.length)})`).run(...payIds)
      db.prepare(`DELETE FROM purchase_payments WHERE id IN (${ph(payIds.length)})`).run(...payIds)
      stat.payments = payIds.length
    }
    // 结算单
    const stIds = db.prepare('SELECT id FROM purchase_settlements WHERE remark LIKE ?').all(`${T}%`).map((r) => r.id)
    if (stIds.length) {
      db.prepare(`DELETE FROM purchase_payment_items WHERE settle_id IN (${ph(stIds.length)})`).run(...stIds)
      db.prepare(`DELETE FROM purchase_settlement_items WHERE settle_id IN (${ph(stIds.length)})`).run(...stIds)
      db.prepare(`DELETE FROM purchase_settlements WHERE id IN (${ph(stIds.length)})`).run(...stIds)
      stat.settles = stIds.length
    }
    // 自造销售订单（PUT 用例）
    const soIds = db.prepare('SELECT id FROM sales_orders WHERE remark LIKE ?').all(`${T}%`).map((r) => r.id)
    if (soIds.length) {
      db.prepare(`DELETE FROM sales_order_items WHERE order_id IN (${ph(soIds.length)})`).run(...soIds)
      db.prepare(`DELETE FROM sales_orders WHERE id IN (${ph(soIds.length)})`).run(...soIds)
      stat.orders = soIds.length
    }
    db.prepare(
      "DELETE FROM doc_events WHERE doc_type IN ('SI','AR','PAY','PST','SO') AND doc_id NOT IN (SELECT id FROM sales_invoices) AND doc_id NOT IN (SELECT id FROM ar_documents) AND doc_id NOT IN (SELECT id FROM purchase_payments) AND doc_id NOT IN (SELECT id FROM purchase_settlements) AND doc_id NOT IN (SELECT id FROM sales_orders)"
    ).run()
    // 库存流水兜底：**修复前**的负数量出入库会真的写流水（这正是那一批缺陷的形态），
    // 残渣留着会让"没有留下流水"这条断言永远红。修复后引擎自己会拦，这里只为可重复跑兜底。
    db.prepare("DELETE FROM inventory_transactions WHERE doc_no LIKE 'TEST-FINAL%'").run()
    db.prepare("DELETE FROM stock_cost_ledger WHERE doc_no LIKE 'TEST-FINAL%'").run()
    db.prepare("DELETE FROM inventory_stocks WHERE batch_no='__test_final__'").run()
  })()
  // 孤儿事件兜底（单据删了、事件还在 —— 内核的 pruneOrphanEvents 是唯一实现）
  try { pruneOrphanEvents(db) } catch { /* 非本次关注点 */ }
  return stat
}
const cleaned = cleanup()
if (Object.values(cleaned).some((v) => v > 0)) {
  console.log(`  （已清理上一轮残留：${JSON.stringify(cleaned)}）`)
}

// ---------------------------------------------------------------- 取样
const dealer = db.prepare('SELECT id, name FROM dealers ORDER BY id LIMIT 1').get()
const suppliers = db.prepare("SELECT id, name FROM suppliers WHERE status='active' ORDER BY id LIMIT 2").all()
const skus = db.prepare('SELECT id, sku_code, name, price_retail FROM product_skus ORDER BY id LIMIT 2').all()
const wh = db.prepare("SELECT id FROM warehouses WHERE status='active' ORDER BY id LIMIT 1").get()
const uid = db.prepare("SELECT id, name FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()

// ================================================================ 1. A10
section('1. A10 —— 红冲一张票不能把共享的整笔应收作废')
{
  // SO 口径：先造一张**订单级**应收（真实业务里由销售订单确认时生成），
  // 再让两张票分别关联到它。这正是"部分开票"的形态。
  const soArNo = nextDocNo(db, 'AR', 'ar_documents', 'doc_no', ymd())
  const soArId = Number(
    db
      .prepare(
        `INSERT INTO ar_documents
         (doc_no,subject_type,subject_id,subject_name,source_type,source_id,source_doc_no,
          biz_date,due_date,credit_days,amount,allocated_amount,status,currency,remark,created_at,updated_at)
         VALUES (?,'dealer',?,?,'SO',?,?,?,?,30,1000,0,'pending','CNY',?,?,?)`
      )
      .run(soArNo, dealer.id, dealer.name, 999999, 'SO-TEST-ORDER', ymd(), ymd(),
        `${T} 订单级共享应收`, ymd(), ymd()).lastInsertRowid
  )
  ok(soArId > 0, '造出订单级共享应收（1000）')

  const mk = (amount, tag) => {
    const inv = createManualInvoice(db, {
      subjectType: 'dealer', subjectId: dealer.id, subjectName: dealer.name,
      invoiceDate: ymd(), invoiceNo: `TEST-FINAL-${tag}`, taxRate: 0,
      items: [{ sku_id: null, qty: 1, price: amount, tax_rate: 0 }],
      remark: `${T} 共享应收 ${tag}`, actor
    })
    // 把票挂到订单上：SO 口径下发票是**关联**订单已有应收，不是自己开一张
    db.prepare('UPDATE sales_invoices SET order_id=?, order_no=? WHERE id=?').run(999999, 'SO-TEST-ORDER', inv.id)
    submitInvoice(db, { id: inv.id, actor })
    return inv
  }
  const invA = mk(400, 'A')
  const invB = mk(600, 'B')
  const ca = confirmInvoice(db, { id: invA.id, actor })
  const cb = confirmInvoice(db, { id: invB.id, actor })
  eq('SO 口径下两张票的关联关系都是 linked', [ca.relation, cb.relation], ['linked', 'linked'])
  eq('两张票关联到**同一张**共享应收', [ca.ar.id, cb.ar.id], [soArId, soArId])
  okNear(db.prepare('SELECT amount FROM ar_documents WHERE id=?').get(soArId).amount, 1000, '共享应收金额仍是 1000')

  // 红冲 A(400)：这一步以前会把整张 1000 的应收 voided
  const red = redChartInvoice(db, { id: invA.id, reason: '开票信息有误，重开', actor })
  eq('原票置为已红冲', red.invoice.status, 'red_charted')
  okNear(red.red.total_amount, -400, '红字票金额为 −400')

  const shared = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(soArId)
  ok(shared.status !== 'voided', '共享应收**没有**被整张作废', `status=${shared.status}`)
  okNear(shared.amount, 1000, '共享应收金额未被红冲改动（债权属于订单，不属于某一张票）')
  eq('B 票仍然是已开票（它的债权还在）', db.prepare('SELECT status FROM sales_invoices WHERE id=?').get(invB.id).status, 'confirmed')
  eq('B 票的关联仍在', db.prepare('SELECT COUNT(*) c FROM invoice_ar_links WHERE invoice_id=?').get(invB.id).c, 1)
  eq('B 票的应收指向的还是那张共享应收', db.prepare('SELECT ar_id FROM sales_invoices WHERE id=?').get(invB.id).ar_id, soArId)

  // 再红冲 B：两张都冲完，共享应收仍应由**订单**的生命周期决定，不因发票而消失
  redChartInvoice(db, { id: invB.id, reason: '客户退货', actor })
  eq('两张票都红冲后，共享应收仍不作废', db.prepare('SELECT status FROM ar_documents WHERE id=?').get(soArId).status, 'pending')
  eq('两张票都是已红冲', db.prepare('SELECT COUNT(*) c FROM sales_invoices WHERE order_id=999999 AND status=?').get('red_charted').c, 2)

  // 对照：SI 口径下应收就是**这张票自己**的，红冲必须整张作废（别把功能改坏了）
  const prevMode = db.prepare("SELECT value FROM settings WHERE key='ar_source_of_truth'").get()?.value
  db.prepare("UPDATE settings SET value='SI' WHERE key='ar_source_of_truth'").run()
  const invC = createManualInvoice(db, {
    subjectType: 'dealer', subjectId: dealer.id, subjectName: dealer.name,
    invoiceDate: ymd(), invoiceNo: 'TEST-FINAL-C', taxRate: 0,
    items: [{ sku_id: null, qty: 1, price: 250, tax_rate: 0 }],
    remark: `${T} SI 口径对照`, actor
  })
  submitInvoice(db, { id: invC.id, actor })
  const cc = confirmInvoice(db, { id: invC.id, actor })
  eq('SI 口径下关联关系是 created', cc.relation, 'created')
  redChartInvoice(db, { id: invC.id, reason: 'SI 口径对照', actor })
  eq('SI 口径下红冲作废**自己那张**应收（对照项，不能被上面改坏）',
    db.prepare('SELECT status FROM ar_documents WHERE id=?').get(cc.ar.id).status, 'voided')
  if (prevMode) db.prepare("UPDATE settings SET value=? WHERE key='ar_source_of_truth'").run(prevMode)
}

// ================================================================ 2. A18
section('2. A18 —— 付款核销的每一条明细都要过闸')
{
  const [s1, s2] = suppliers
  ok(!!s1 && !!s2, `取到两个供应商（${s1?.name} / ${s2?.name}）`)
  const mkSettle = (supplierId, amount, status = 'audited', paid = 0) => {
    const no = nextDocNo(db, 'PST', 'purchase_settlements', 'doc_no', ymd())
    const id = Number(
      db
        .prepare(
          `INSERT INTO purchase_settlements
           (doc_no,supplier_id,settle_date,settle_mode,settle_amount,paid_amount,status,remark,created_at,updated_at)
           VALUES (?,?,?,'fee',?,?,?,?,?,?)`
        )
        .run(no, supplierId, ymd(), amount, paid, status, `${T} 结算单`, ymd(), ymd()).lastInsertRowid
    )
    return { id, doc_no: no }
  }
  const st1 = mkSettle(s1.id, 1000)
  const st2 = mkSettle(s2.id, 800)
  const stDraft = mkSettle(s1.id, 500, 'draft')

  const pay = (allocations, extra = {}) =>
    createPayment(db, { supplierId: s1.id, payDate: ymd(), amount: 1000, remark: `${T} 付款`, actor, allocations, ...extra })

  throws(() => pay([{ settle_id: 99999999, amount: 10 }]), 'PAY_SETTLE_NOT_FOUND', '核销一条不存在的结算单 → 拒绝')
  throws(() => pay([{ settle_id: st2.id, amount: 10 }]), 'PAY_ALLOC_SUPPLIER_MISMATCH',
    '跨供应商核销（给 A 付款、抵 B 的结算单）→ 拒绝')
  throws(() => pay([{ settle_id: stDraft.id, amount: 10 }]), 'PAY_ALLOC_SETTLE_STATUS',
    '核销一张未审核的结算单 → 拒绝')
  throws(() => pay([{ settle_id: st1.id, amount: -50 }]), 'PAY_ALLOC_BAD_AMOUNT', '负分摊 → 拒绝')
  throws(() => pay([{ settle_id: st1.id, amount: 0 }]), 'PAY_ALLOC_BAD_AMOUNT', '零分摊 → 拒绝')
  throws(() => pay([{ settle_id: st1.id, amount: 1200 }]), 'PAY_ALLOC_OVER_OPEN',
    '单条超过未付余额 → 拒绝（不是截平）')
  throws(() => pay([{ settle_id: st1.id, amount: 600 }, { settle_id: st1.id, amount: 600 }]), 'PAY_ALLOC_OVER_OPEN',
    '两条明细指向同一张结算单、累加超过未付余额 → 拒绝')
  throws(() => pay([{ settle_id: st1.id, amount: 100 }], { currency: 'XYZ' }), 'PAY_BAD_CURRENCY',
    '非法币种 → 拒绝')

  // 合法的一条要能过，且真写进去
  const good = pay([{ settle_id: st1.id, amount: 300 }])
  eq('合法核销能建单', good.items.length, 1)
  okNear(good.items[0].amount, 300, '核销明细金额落库')
  okNear(good.amount, 1000, '付款单金额不变')

  // 「作废结算后批准付款」：建单时目标有效、生效时已失效
  const doomed = mkSettle(s1.id, 700)
  const p2 = createPayment(db, {
    supplierId: s1.id, payDate: ymd(), amount: 700, remark: `${T} 付款-作废结算`, actor,
    allocations: [{ settle_id: doomed.id, amount: 700 }]
  })
  eq('建单时为草稿', p2.status, 'draft')
  db.prepare("UPDATE purchase_settlements SET status='voided', updated_at=? WHERE id=?").run(ymd(), doomed.id)
  throws(() => transitionPayment(db, { id: p2.id, action: 'submit', actor }), 'PAY_ALLOC_SETTLE_STATUS',
    '目标结算单在生效前被作废 → 批准付款必须拒绝（不能把钱付出去抵一张已作废的单）')

  // 自动 FIFO（不传 allocations）仍要工作，且不超未付余额
  const auto = createPayment(db, {
    supplierId: s1.id, payDate: ymd(), amount: 200, remark: `${T} 付款-FIFO`, actor
  })
  const autoItems = auto.items.filter((i) => i.settle_id)
  ok(autoItems.length >= 1, 'FIFO 自动分摊至少一条')
  const overpaid = autoItems
    .map((i) => {
      const st = db.prepare('SELECT settle_amount, paid_amount FROM purchase_settlements WHERE id=?').get(i.settle_id)
      return Number(i.amount) - (Number(st.settle_amount) - Number(st.paid_amount))
    })
    .filter((d) => d > 0.005)
  eq('FIFO 每条都不超该单未付余额（尚未生效、paid 未动，因此用计划口径核对）', overpaid.length, 0)
}

// ================================================================ 3. A17b
section('3. A17b —— 只改单头要重算 / 数量必须为正 / MCP 入参要过 schema')

// ---- 3.1 库存出入库的数量符号 ----
{
  const row = db.prepare('SELECT sku_id, batch_no, warehouse_id FROM inventory_stocks ORDER BY id LIMIT 1').get()
  const target = { warehouseId: row.warehouse_id, skuId: row.sku_id, batchNo: row.batch_no, docType: 'ADJ', docNo: 'TEST-FINAL-ADJ', bizDate: ymd() }
  const before = db.prepare('SELECT qty_on_hand FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?')
    .get(row.warehouse_id, row.sku_id, row.batch_no)?.qty_on_hand
  throws(() => applyStockOut(db, { ...target, qty: -5 }), 'STOCK_BAD_QTY',
    '负数量出库 → 拒绝（负出库会**反向加库存**）')
  throws(() => applyStockIn(db, { ...target, qty: -5, unitCost: 1 }), 'STOCK_BAD_QTY',
    '负数量入库 → 拒绝（负入库会**反向减库存**）')
  throws(() => applyStockOut(db, { ...target, qty: 0 }), 'STOCK_BAD_QTY', '零数量出库 → 拒绝')
  const after = db.prepare('SELECT qty_on_hand FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?')
    .get(row.warehouse_id, row.sku_id, row.batch_no)?.qty_on_hand
  eq('被拒之后库存**分毫未动**', Number(after), Number(before))
  const txn = db.prepare("SELECT COUNT(*) c FROM inventory_transactions WHERE doc_no='TEST-FINAL-ADJ'").get().c
  eq('被拒之后没有留下流水', txn, 0)
}

// ---- 3.2 MCP 入参 schema 校验（不是只验必填）----
{
  const tools = listTools({ levels: ['read', 'write', 'danger'] })
  const byName = new Map(tools.map((t) => [t.name, t]))
  ok(tools.length > 0, `取到工具清单 ${tools.length} 个`)

  // 类型：integer 传一个不可解析的字符串
  const intTool = tools.find((t) => Object.values(t.inputSchema?.properties || {}).some((s) => s.type === 'integer'))
  ok(!!intTool, `找到带 integer 入参的工具（${intTool?.name}）`)
  if (intTool) {
    const key = Object.entries(intTool.inputSchema.properties).find(([, s]) => s.type === 'integer')[0]
    const r = validateToolArgs(intTool, { [key]: 'abc' })
    eq(`integer 入参收到不可解析字符串 → 拒（${intTool.name}.${key}）`, r.ok, false)
    ok(r.code === 'ARG_TYPE', '错误码为 ARG_TYPE', r.code)
    const r2 = validateToolArgs(intTool, { [key]: '42' })
    ok(r2.ok, '可解析的数字字符串仍放行（客户端普遍传字符串）', r2.error)
    const r3 = validateToolArgs(intTool, { [key]: 3.7 })
    eq('integer 收到小数 → 拒', r3.ok, false)
  }

  // 未知参数：不能静默忽略（否则 AI 以为传了、系统没收到）
  const anyTool = tools[0]
  const ru = validateToolArgs(anyTool, { __not_a_field__: 1 })
  eq('未知参数 → 拒（否则"传了但没生效"会静默）', ru.ok, false)
  ok(ru.code === 'ARG_UNKNOWN', '错误码为 ARG_UNKNOWN', ru.code)

  // 必填仍然拦
  const reqTool = tools.find((t) => (t.inputSchema?.required || []).length > 0)
  if (reqTool) {
    const missingKey = reqTool.inputSchema.required[0]
    const r = validateToolArgs(reqTool, {})
    eq(`必填缺失仍拦（${reqTool.name}.${missingKey}）`, r.ok, false)
    ok(r.code === 'MISSING_ARGS', '错误码为 MISSING_ARGS', r.code)
  }

  // 合法入参（拿必填填上）不能误伤
  if (reqTool) {
    const filled = {}
    for (const k of reqTool.inputSchema.required) {
      const s = reqTool.inputSchema.properties[k] || {}
      filled[k] = s.type === 'integer' || s.type === 'number' ? 1 : s.type === 'boolean' ? true : 'x'
    }
    const r = validateToolArgs(reqTool, filled)
    ok(r.ok, `合法入参放行（${reqTool.name}）`, r.error)
  }
  ok(!!byName.get('stock_list') || byName.size > 0, '工具注册表可用')
}

// ---- 3.3 只改单头必须重算（HTTP PUT）----
{
  // ---- 起服务（PUT 是路由层行为，必须真打一遍）----
  const srv = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    // `GML_DATA_DIR` 显式给出：父子同源、不靠 `{...process.env}` 继承 ——
    // 否则"父进程读 /tmp 副本、子进程去 boot 开发库"这种**半隔离**会静悄悄发生
    // （而它一次会把三个行业库全 boot 一遍）。
    env: { ...process.env, PORT: String(PORT), GML_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // 中途抛错退出时 'exit' 钩子也要收掉服务，否则端口被占、拖垮后续脚本（CI 实测）。
  installReapFallback(srv)
  let log = ''
  srv.stdout.on('data', (d) => (log += d.toString()))
  srv.stderr.on('data', (d) => (log += d.toString()))
  const started = Date.now()
  const ready = await new Promise((res) => {
    const t = setInterval(() => {
      if (log.includes('服务已启动')) { clearInterval(t); res(true) }
      // 进程已经退出（端口被占、启动报错）→ 立刻失败，不要白等 3 分钟 ——
      // 等超时会把"端口被占"变成一条与真正原因无关的"启动失败"
      else if (srv.exitCode !== null || srv.signalCode !== null) { clearInterval(t); res(false) }
      else if (Date.now() - started > 60000) { clearInterval(t); res(false) }
    }, 300)
  })
  if (!ready) {
    console.log('❌ 服务启动失败：\n' + log.split('\n').slice(-25).join('\n'))
    ok(false, '服务已启动')
    srv.kill('SIGKILL')
  } else {
    ok(true, '服务已启动')
    const api = async (method, p, { token, body } = {}) => {
      const res = await fetch(`${BASE}${p}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-industry': INDUSTRY,
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const login = await api('POST', '/api/auth/login', { body: { username: 'admin', password: '12345', industry: INDUSTRY } })
    const token = login.body?.data?.token || null
    ok(!!token, '管理员登录成功')

    const soNo = nextDocNo(db, 'SO', 'sales_orders', 'doc_no', ymd())
    const soId = Number(
      db
        .prepare(
          `INSERT INTO sales_orders (doc_no,channel,order_date,status,total_qty,goods_amount,discount_amount,freight,
                                     receivable_amount,warehouse_id,remark,created_at,updated_at)
           VALUES (?,'store',?,'draft',0,0,0,0,0,?,?,?,?)`
        )
        .run(soNo, ymd(), wh.id, `${T} 改单重算`, ymd(), ymd()).lastInsertRowid
    )
    // 用 HTTP 建两行（顺带验 create 入口）
    const r1 = await api('PUT', `/api/sales/orders/${soId}`, {
      token,
      body: {
        items: [
          { sku_id: skus[0].id, qty: 2, price: 100 },
          { sku_id: skus[1].id, qty: 1, price: 50 }
        ]
      }
    })
    eq('PUT 建行返回 200', r1.status, 200)
    const o1 = db.prepare('SELECT goods_amount, discount_amount, freight, receivable_amount FROM sales_orders WHERE id=?').get(soId)
    okNear(o1.goods_amount, 250, '两行货值 = 250')
    okNear(o1.receivable_amount, 250, '应收 = 250')

    // 只改运费：不动 items。旧实现只在传了 items 时才 recalcOrder ⇒ 应收纹丝不动
    const r2 = await api('PUT', `/api/sales/orders/${soId}`, { token, body: { freight: 30 } })
    eq('只改运费返回 200', r2.status, 200)
    const o2 = db.prepare('SELECT freight, receivable_amount FROM sales_orders WHERE id=?').get(soId)
    okNear(o2.freight, 30, '运费已落库')
    okNear(o2.receivable_amount, 280, '**应收随运费重算**（250 + 30）')

    // 只改整单折扣：同样必须重算
    const r3 = await api('PUT', `/api/sales/orders/${soId}`, { token, body: { discount_amount: 50 } })
    eq('只改折扣返回 200', r3.status, 200)
    const o3 = db.prepare('SELECT discount_amount, receivable_amount FROM sales_orders WHERE id=?').get(soId)
    okNear(o3.discount_amount, 50, '整单折扣已落库')
    okNear(o3.receivable_amount, 230, '**应收随折扣重算**（250 + 30 − 50）')

    // 折扣大于货值 → 应收为负 → 落库前拒绝，且不留下半截修改
    const r4 = await api('PUT', `/api/sales/orders/${soId}`, { token, body: { discount_amount: 99999 } })
    ok(r4.status >= 400, '折扣把应收推成负数 → 拒绝', `status=${r4.status}`)
    const o4 = db.prepare('SELECT discount_amount, receivable_amount FROM sales_orders WHERE id=?').get(soId)
    okNear(o4.discount_amount, 50, '被拒之后折扣**未被写入**（不能只改一半）')
    okNear(o4.receivable_amount, 230, '被拒之后应收保持原值')

    // 收尾：SIGKILL（SIGTERM 下 Express 的 keep-alive 连接会让进程挂着不退，
    // 下一轮起服务时端口被占 → 表现为"服务启动失败"，查起来完全不指向真正的原因）
    // 子进程必须回收并**说出来**：留下的一只 `node server/index.js` 会一直监听端口、
    // 继续持有库文件。判据与形状见 `scripts/lib/reap.mjs`（唯一出处）。
    installReapFallback(srv)
    await stopAndReport(srv, { port: PORT })
  }
}

// ================================================================ 4. 可售样本判据
section('4. 演示造数的「可售样本」判据（排除原料/包材 + 必须有零售价）')
{
  // 这两处筛选原先各写一份、都漏了"排除原料"：
  //   · 门店仓堆了 >= 5 件原料 ⇒ 原料按库存量排进 POS 候选 ⇒ `posQuote` 以「单价异常」崩；
  //   · 协议价样本按 id 取前 40 个 SKU ⇒ 取到原料 ⇒ `round2(0 * 0.82) = 0` ⇒ `createAgreement` 拒绝。
  // 两处都表现为"整库重建崩掉"，而报错点离真正的原因隔着好几层调用栈。
  const globalSkus = sellableSkus(db, { limit: 500 })
  ok(globalSkus.length > 0, `全局可售样本非空（${globalSkus.length} 个）`)
  eq('全局可售样本里没有 0 价商品', globalSkus.filter((s) => !(Number(s.price_retail) > 0)).length, 0)
  eq('全局可售样本里没有原料/包材', globalSkus.filter((s) => String(s.product_item_type ?? '') === 'material').length, 0)

  const storeWh = db
    .prepare("SELECT w.id FROM warehouses w JOIN stores s ON s.id = w.store_id WHERE w.status='active' ORDER BY w.id LIMIT 1")
    .get()
  ok(!!storeWh, '取到一个门店仓')

  const mat = db
    .prepare(
      `SELECT s.id, s.sku_code, s.price_retail FROM product_skus s JOIN products p ON p.id = s.product_id
        WHERE IFNULL(p.item_type,'')='material' ORDER BY s.id LIMIT 1`
    )
    .get()
  ok(!!mat, `找到一个原料 SKU（${mat?.sku_code}，零售价 ${mat?.price_retail}）`)

  // ---- 人造成反例 ----
  // 把一个**原料**塞进门店仓、库存量开到最大：旧实现是"该仓库存量最大的 8 个 SKU"，
  // 不看卖不卖得出去 —— 于是它会**排到第一个**被当成收银样本。
  const sample = db.prepare('SELECT owner_org_id, currency FROM inventory_stocks WHERE warehouse_id=? LIMIT 1').get(storeWh.id)
  const BATCH = '__test_final__'
  db.prepare('DELETE FROM inventory_stocks WHERE batch_no=?').run(BATCH)
  db.prepare(
    `INSERT INTO inventory_stocks
     (warehouse_id,owner_org_id,sku_id,batch_no,currency,qty_on_hand,qty_reserved,qty_in_transit,qty_ordered,updated_at)
     VALUES (?,?,?,?,?,99999,0,0,0,?)`
  ).run(storeWh.id, sample?.owner_org_id ?? null, mat.id, BATCH, sample?.currency || 'CNY', ymd())
  try {
    // 先证"这个场景确实能杀人"：不做可售过滤、只按库存量排，它一定排第一
    // （聚合列必须显式写 —— `GROUP BY` 后按 bare column 排是不确定的）
    const naive = db
      .prepare(
        `SELECT s.id FROM inventory_stocks st JOIN product_skus s ON s.id = st.sku_id
          WHERE st.warehouse_id=? AND st.qty_on_hand >= 5
          GROUP BY s.id ORDER BY SUM(st.qty_on_hand) DESC, s.sku_code LIMIT 1`
      )
      .get(storeWh.id)
    eq('先决条件成立：不过滤时这个原料确实是库存量最大的（旧实现会选中它）', naive?.id, mat.id)

    const picked = sellableSkusInWarehouse(db, storeWh.id, { minQty: 5, limit: 8 })
    ok(picked.length > 0, `可售样本仍能选出 ${picked.length} 个`)
    eq('门店仓样本里**没有**这个原料', picked.filter((s) => s.id === mat.id).length, 0)
    eq('门店仓样本全部有零售价', picked.filter((s) => !(Number(s.price_retail) > 0)).length, 0)
  } finally {
    db.prepare('DELETE FROM inventory_stocks WHERE batch_no=?').run(BATCH)
  }
  eq('人造行已清理', db.prepare('SELECT COUNT(*) c FROM inventory_stocks WHERE batch_no=?').get(BATCH).c, 0)

  // 单条判定与两段 SQL 同一口径
  eq('isSellable：原料 → 不可售', isSellable({ item_type: 'material', price_retail: 88 }), false)
  eq('isSellable：有价的成品 → 可售', isSellable({ item_type: 'finished', price_retail: 88 }), true)
  eq('isSellable：0 价的成品 → 不可售', isSellable({ item_type: 'finished', price_retail: 0 }), false)
}

// ================================================================ 5. 自证与清理
section('5. 自证与清理')
{
  const draftOrphans = db
    .prepare(`SELECT COUNT(*) c FROM invoice_ar_links l LEFT JOIN sales_invoices i ON i.id=l.invoice_id WHERE i.id IS NULL`)
    .get().c
  eq('没有指向已删发票的关联行', draftOrphans, 0)
  const payOrphans = db
    .prepare('SELECT COUNT(*) c FROM purchase_payment_items it LEFT JOIN purchase_payments p ON p.id=it.payment_id WHERE p.id IS NULL')
    .get().c
  eq('没有指向已删付款单的明细', payOrphans, 0)

  const st = cleanup()
  console.log(`  （已清理：${JSON.stringify(st)}）`)
  const leftover = db.prepare('SELECT COUNT(*) c FROM sales_invoices WHERE remark LIKE ?').get(`${T}%`).c
  eq('本测试的发票全部清干净', leftover, 0)
  const leftoverPay = db.prepare('SELECT COUNT(*) c FROM purchase_payments WHERE remark LIKE ?').get(`${T}%`).c
  eq('本测试的付款单全部清干净', leftoverPay, 0)
  const leftoverSt = db.prepare('SELECT COUNT(*) c FROM purchase_settlements WHERE remark LIKE ?').get(`${T}%`).c
  eq('本测试的结算单全部清干净', leftoverSt, 0)
  const leftoverSo = db.prepare('SELECT COUNT(*) c FROM sales_orders WHERE remark LIKE ?').get(`${T}%`).c
  eq('本测试的销售订单全部清干净', leftoverSo, 0)
  const mode = db.prepare("SELECT value FROM settings WHERE key='ar_source_of_truth'").get()?.value
  eq('应收口径设置已还原', mode, 'SO')
}

db.close()
console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('\n失败项：')
  failures.forEach((f) => console.log(`  · ${f}`))
  process.exit(1)
}
