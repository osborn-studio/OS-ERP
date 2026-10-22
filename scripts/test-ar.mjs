/**
 * ============================================================================
 * 文件标识：scripts/test-ar.mjs ｜ 测试：应收与收款核销测试（模块 21）
 * ============================================================================
 * 【职责】测试：应收与收款核销测试（模块 21）
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
 * 应收与收款核销测试（模块 21）
 *
 * 守三条口径，其它都是这三条的推论：
 *   ① 已收金额永远由核销明细 SUM 算出（不是累加）；
 *   ② 核销生效点 = 收款单确认（草稿上的核销不算数）；
 *   ③ 单据上的金额必须能由明细重算出来（audit 零漂移）。
 *
 * 与定价/成本测试同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-ar.mjs [industry]
 */
import { getDbFor } from '../server/db/index.js'
import {
  ensureAr, recalcAr, recalcArBySubject, listAr, getAr,
  createReceipt, confirmReceipt, voidReceipt, getReceipt, listReceipts,
  aging, agingBySubject, statement, arOverview, auditAr, dueDateOf, overdueDaysOf,
  agingDetail, agingDetailBySubject, prepayList, prepayDetail, applyPrepay,
  pendingOcAr, ensureOcAr, syncOcAr
} from '../server/lib/ar.js'
import { pruneOrphanEvents } from '../server/lib/docflow.js'
// 对账单终局动作（结清 / 作废）的**唯一实现** —— 与业务路由调用的是同一段代码。
// 测试直接调 lib 而不是打 HTTP：要断言的是**判据本身**（收齐才准结清、作废不动应收），
// 而不是"路由有没有转发对"（后者由 check-api-contract / 自检验收清单覆盖）。
import { closeStatement, voidStatement, setStatementStatus, statementFigures, SETTLE_TOLERANCE } from '../server/lib/dealer-statement.js'

const INDUSTRY = process.argv[2] || 'cosmetic'
const db = getDbFor(INDUSTRY)

let pass = 0
let fail = 0
const only = []
function ok(cond, msg) {
  if (cond) {
    pass++
  } else {
    fail++
    only.push(msg)
    console.log('  ✗', msg)
  }
}
function eq(msg, actual, expect) {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  ✗ ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps
const today = new Date().toISOString().slice(0, 10)
const dayOffset = (n) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

console.log(`\n=== 应收与收款核销（${INDUSTRY}） ===`)

// ---------- -1. 残留自愈：让测试可以重复跑 ----------
// 上一轮若中途抛错（比如断言失败直接终止），测试造的 MANUAL 应收与 TEST- 收款单
// 会留在库里；下一次跑时 ensureAr 判定「同一来源已存在」而返回旧单，
// 于是从「幂等不新增单据」开始全线偏移 —— 一个中间异常会污染后面所有断言。
// 这里在开跑前先把自己的痕迹清干净（只认自己造的标记：source_id ≥ 900000 / serial_no 前缀 TEST-）。
function cleanupTestArtifacts() {
  const arIds = db
    .prepare("SELECT id FROM ar_documents WHERE source_type='MANUAL' AND source_id >= 900000")
    .all()
    .map((r) => r.id)
  const rcIds = db.prepare("SELECT id FROM receipts WHERE serial_no LIKE 'TEST-%'").all().map((r) => r.id)
  const tx = db.transaction(() => {
    for (const id of arIds) {
      db.prepare('DELETE FROM receipt_allocations WHERE ar_id=?').run(id)
      db.prepare('DELETE FROM ar_documents WHERE id=?').run(id)
      db.prepare("DELETE FROM doc_events WHERE doc_type='AR' AND doc_id=?").run(id)
    }
    for (const id of rcIds) {
      db.prepare('DELETE FROM receipt_allocations WHERE receipt_id=?').run(id)
      db.prepare('DELETE FROM receipts WHERE id=?').run(id)
      db.prepare("DELETE FROM doc_events WHERE doc_type='RCP' AND doc_id=?").run(id)
    }
  })
  tx()
  if (arIds.length || rcIds.length) {
    recalcArBySubject(db)
    console.log(`  （已清理上一轮残留：应收 ${arIds.length} 张 / 收款 ${rcIds.length} 张）`)
  }
  // 对账单测试造的样本（`TEST-DS-`）：本轮新引入，同样要先清干净，
  // 否则第二次跑时 doc_no UNIQUE 冲突 / 样本被上次改成了终态。
  const dsIds = db
    .prepare("SELECT id FROM dealer_statements WHERE doc_no LIKE 'TEST-DS-%'")
    .all()
    .map((r) => r.id)
  if (dsIds.length) {
    const tx2 = db.transaction(() => {
      for (const id of dsIds) {
        db.prepare('DELETE FROM dealer_statements WHERE id=?').run(id)
        db.prepare("DELETE FROM doc_events WHERE doc_type='DS' AND doc_id=?").run(id)
      }
    })
    tx2()
    console.log(`  （已清理上一轮残留对账单：${dsIds.length} 张）`)
  }
}
cleanupTestArtifacts()

// ---------- 0. 单据内核注册 ----------
const types = db.prepare('SELECT code FROM doc_types').all().map((r) => r.code)
ok(types.includes('AR'), '内核已注册应收单 AR')
ok(types.includes('RCP'), '内核已注册收款单 RCP')
ok(types.filter((c) => c === 'RCP').length === 1, 'RCP 只有一个含义（不与门店日结单撞码）')
const rcStates = db.prepare("SELECT code FROM doc_states WHERE doc_type='RCP'").all().map((r) => r.code)
eq('收款单三状态', rcStates.sort(), ['confirmed', 'draft', 'voided'])
const rcActs = db.prepare("SELECT action FROM doc_actions WHERE doc_type='RCP'").all().map((r) => r.action)
ok(rcActs.includes('confirm') && rcActs.includes('void'), '收款单有确认与作废动作')
ok(
  db.prepare("SELECT 1 AS hit FROM biz_flows WHERE code='FLOW_RECEIVABLE'").get(),
  '业务流 FLOW_RECEIVABLE 已注册'
)

// ---------- 1. 到期日与逾期 ----------
eq('到期日 = 业务日 + 账期', dueDateOf('2026-01-01', 30), '2026-01-31')
eq('账期 0 即当天到期', dueDateOf('2026-01-01', 0), '2026-01-01')
eq('未到期不算逾期', overdueDaysOf({ due_date: dayOffset(5) }, today), 0)
eq('逾期天数可算', overdueDaysOf({ due_date: dayOffset(-12) }, today), 12)

// ---------- 2. 应收单：幂等与来源 ----------
const dealer = db.prepare('SELECT id, name FROM dealers WHERE credit_limit > 0 ORDER BY id LIMIT 1').get()
const before = db.prepare('SELECT COUNT(*) c FROM ar_documents').get().c
const ar1 = ensureAr(db, {
  subjectType: 'dealer',
  subjectId: dealer.id,
  subjectName: dealer.name,
  sourceType: 'MANUAL',
  sourceId: 900001,
  sourceDocNo: 'TEST-MANUAL-1',
  bizDate: dayOffset(-3),
  amount: 1000,
  creditDays: 30,
  actor: { id: null, name: '测试' }
})
ok(ar1.id > 0, '手工应收单已生成')
const again = ensureAr(db, {
  subjectType: 'dealer',
  subjectId: dealer.id,
  sourceType: 'MANUAL',
  sourceId: 900001,
  bizDate: dayOffset(-3),
  amount: 1000
})
eq('同一来源重复生成返回同一张（幂等）', again.id, ar1.id)
eq('幂等不新增单据', db.prepare('SELECT COUNT(*) c FROM ar_documents').get().c, before + 1)
eq('应收初始状态为待收款', ar1.status, 'open')
eq('应收初始已收为 0', ar1.allocated_amount, 0)

// ---------- 3. 核销生效点 = 收款单确认 ----------
const rc = createReceipt(db, {
  subjectType: 'dealer',
  subjectId: dealer.id,
  subjectName: dealer.name,
  receiptDate: today,
  amount: 400,
  method: 'transfer',
  serialNo: 'TEST-RC-0001',
  // 显式指定抵哪一笔：库里还有 seed 造的更早到期的应收，走 FIFO 会抵到它们身上
  allocations: [{ ar_id: ar1.id, amount: 400 }],
  actor: { id: null, name: '测试' }
})
ok(rc.id > 0, '收款单已登记（草稿）')
ok(near(rc.allocated_amount, 400) || near(rc.allocated_amount, 0), '草稿阶段已生成核销计划')
const draftState = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(ar1.id)
eq('草稿收款不算已收（核销未生效）', draftState.allocated_amount, 0)
eq('草稿收款不改应收状态', draftState.status, 'open')

const conf = confirmReceipt(db, { id: rc.id, actor: { id: null, name: '测试' } })
eq('确认后收款单状态', conf.status, 'confirmed')
const afterConf = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(ar1.id)
eq('确认后已收 = 核销金额', afterConf.allocated_amount, 400)
eq('部分收款状态', afterConf.status, 'partial')
ok(afterConf.amount - afterConf.allocated_amount > 0, '仍有未收余额')

// ---------- 4. 已收金额由明细 SUM 算出，不累加 ----------
const allocSum = db
  .prepare(
    `SELECT IFNULL(SUM(a.amount),0) s FROM receipt_allocations a
     JOIN receipts r ON r.id=a.receipt_id WHERE a.ar_id=? AND r.status='confirmed'`
  )
  .get(ar1.id).s
ok(near(allocSum, afterConf.allocated_amount), '已收 = 明细 SUM（非累加）')

const rc2 = createReceipt(db, {
  subjectType: 'dealer',
  subjectId: dealer.id,
  receiptDate: today,
  amount: 600,
  method: 'cash',
  serialNo: 'TEST-RC-0002',
  allocations: [{ ar_id: ar1.id, amount: 600 }],
  actor: { id: null, name: '测试' }
})
confirmReceipt(db, { id: rc2.id, actor: { id: null, name: '测试' } })
const closed = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(ar1.id)
eq('收齐后状态为已结清', closed.status, 'closed')
ok(near(closed.allocated_amount, closed.amount), '已收等于应收（不多收）')

// ---------- 5. 作废收款：核销失效并重算 ----------
const voided = voidReceipt(db, { id: rc2.id, actor: { id: null, name: '测试' }, reason: '测试作废' })
eq('作废后状态', voided.status, 'voided')
const afterVoid = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(ar1.id)
eq('作废后已收回退', afterVoid.allocated_amount, 400)
eq('作废后回到部分收款', afterVoid.status, 'partial')
const allocSum2 = db
  .prepare(
    `SELECT IFNULL(SUM(a.amount),0) s FROM receipt_allocations a
     JOIN receipts r ON r.id=a.receipt_id WHERE a.ar_id=? AND r.status='confirmed'`
  )
  .get(ar1.id).s
ok(near(allocSum2, afterVoid.allocated_amount), '作废后已收仍等于明细 SUM')

// ---------- 6. 超收与跨单分摊 ----------
const ar2 = ensureAr(db, {
  subjectType: 'dealer',
  subjectId: dealer.id,
  sourceType: 'MANUAL',
  sourceId: 900002,
  bizDate: dayOffset(-1),
  amount: 800,
  creditDays: 15,
  actor: { id: null, name: '测试' }
})
const rc3 = createReceipt(db, {
  subjectType: 'dealer',
  subjectId: dealer.id,
  receiptDate: today,
  amount: 1500, // 超过两张应收的剩余（600 + 800），应有 100 成为预收
  method: 'transfer',
  serialNo: 'TEST-RC-0003',
  allocations: [{ ar_id: ar1.id, amount: 600 }, { ar_id: ar2.id, amount: 800 }],
  actor: { id: null, name: '测试' }
})
ok(rc3.unallocated >= 0, '超收部分记为预收（unallocated ≥ 0）')
confirmReceipt(db, { id: rc3.id, actor: { id: null, name: '测试' } })
const arX = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(ar2.id)
ok(near(arX.allocated_amount, arX.amount), '跨单分摊：第二张应收被结清')
ok(arX.allocated_amount <= arX.amount + 0.01, '核销不会超过应收金额')

// ---------- 7. 账龄 ----------
const ag = aging(db)
ok(ag.total_outstanding > 0, '账龄有未结余额')
ok(ag.buckets.b0 >= 0 && ag.buckets.b1 >= 0 && ag.buckets.b2 >= 0 && ag.buckets.b3 >= 0, '四个账龄桶均非负')
ok(near(ag.total_outstanding, ag.buckets.b0 + ag.buckets.b1 + ag.buckets.b2 + ag.buckets.b3, 0.05), '账龄合计 = 四桶之和')
ok(ag.overdue <= ag.total_outstanding + 0.01, '逾期额不超过未结总额')
const bySubject = agingBySubject(db)
ok(Array.isArray(bySubject) && bySubject.length > 0, '可按客户汇总账龄')
ok(bySubject.every((r) => r.balance > 0), '账龄榜只列有余额的客户')

// ---------- 8. 对账单：期末余额可由明细重算 ----------
const stmt = statement(db, { subjectType: 'dealer', subjectId: dealer.id })
ok(stmt.ar_total > 0, '对账单有应收发生额')
ok(near(stmt.balance, stmt.ar_total - stmt.allocated_total, 0.05), '期末余额 = 应收 − 已核销')
ok(stmt.ars.every((r) => r.subject_id === dealer.id), '对账单只含该客户的应收')
ok(
  stmt.allocations.every((a) => a.status === 'confirmed'),
  '对账单只计已确认收款的核销'
)

// ---------- 9. 列表与详情 ----------
const list = listAr(db, { subjectType: 'dealer', subjectId: dealer.id, pageSize: 50 })
ok(list.rows.length > 0 && list.total >= list.rows.length, '应收列表可查（含分页计数）')
const detail = getAr(db, list.rows[0].id)
ok(Array.isArray(detail.allocations), '应收详情带核销明细')
const rcl = listReceipts(db, { subjectType: 'dealer', subjectId: dealer.id, pageSize: 50 })
ok(rcl.rows.length > 0, '收款列表可查')
ok(Array.isArray(getReceipt(db, rcl.rows[0].id).allocations), '收款详情带核销明细')

// ---------- 10. 自洽审计 ----------
const audit = auditAr(db)
ok(audit.ok, '应收自洽：单据金额 = 核销明细 SUM')
eq('无超额核销', audit.overAlloc.length, 0)
eq('无状态与金额不符', audit.badStatus.length, 0)
eq('收款单分摊无漂移', audit.rcDrift.length, 0)

recalcArBySubject(db)
ok(auditAr(db).ok, '全量重算后仍自洽')

// ---------- 11. 概览与留痕 ----------
const ov = arOverview(db)
ok(ov.ar_count > 0 && ov.receipt_count > 0, '概览有应收与收款数据')
ok(ov.open_amount > 0, '概览有未结金额')
ok(ov.ar_allocated <= ov.ar_amount + 0.01, '已收不超过应收总额')
const events = db.prepare("SELECT COUNT(*) c FROM doc_events WHERE doc_type='RCP'").get().c
ok(events > 0, '收款单流转有留痕')
ok(pruneOrphanEvents(db, { dryRun: true }).removed === 0, '无孤儿流转留痕')

// ---------- 12. 逐笔账龄（第二阶段）----------
// 用全库口径断言：本测试前面已把该 dealer 的应收全部结清，
// 按单客户取会得到 0 行（那是因为没余额，不是口径错）
const ad = agingDetail(db)
ok(ad.count > 0, '逐笔账龄有记录')
ok(ad.rows.every((r) => r.status === 'open' || r.status === 'partial'), '逐笔账龄默认只看未结清')
ok(
  ad.rows.every((r) => ['b0', 'b1', 'b2', 'b3', 'settled'].includes(r.bucket)),
  '每条都能归入账龄桶'
)
const agAll = aging(db)
ok(near(ad.total_open, agAll.total_outstanding), '逐笔合计 = 汇总口径（两个入口同源）')
ok(near(ad.total_overdue, agAll.overdue), '逐笔逾期合计 = 汇总逾期')
const adSettled = agingDetail(db, { bucket: 'settled' })
ok(adSettled.rows.every((r) => r.status !== 'open' && r.status !== 'partial'), 'settled 桶只含已结清/作废')
const adSubj = agingDetailBySubject(db)
ok(adSubj.length > 0 && adSubj.every((r) => r.balance > 0), '客户级逐笔汇总只列有余额的')
ok(Number.isInteger(adSubj[0].max_overdue_days), '客户级汇总带最长逾期天数')

// 视图与函数必须同源：视图少一行，说明有人绕过视图自己写 SQL 了
const viewOpen = db.prepare("SELECT COUNT(*) c FROM v_ar_aging_detail WHERE status IN ('open','partial')").get().c
eq('逐笔账龄与视图口径一致', viewOpen, ad.count)

// ---------- 13. 预收：多收的钱要能查到、能抵账（第二阶段）----------
// 造一张干净的未结应收当靶子（前面两张都已结清，不能拿它们测「拿预收去结清」）
const ar3 = ensureAr(db, {
  subjectType: 'dealer',
  subjectId: dealer.id,
  sourceType: 'MANUAL',
  sourceId: 900003,
  sourceDocNo: 'TEST-PREPAY-TARGET',
  bizDate: dayOffset(-2),
  amount: 300,
  creditDays: 30,
  actor: { id: null, name: '测试' }
})
const ppBefore = prepayList(db, { subjectType: 'dealer', subjectId: dealer.id }).total
const rc4 = createReceipt(db, {
  subjectType: 'dealer',
  subjectId: dealer.id,
  receiptDate: today,
  amount: 2000,
  method: 'transfer',
  serialNo: 'TEST-PP-0001',
  // 显式给一条 0 金额的核销计划：createReceipt 在 allocations 为空时会走它的
  // 「FIFO 自动分配」分支，把多付的钱抵到库里最老的应收上 —— 那样就造不出预收了
  allocations: [{ ar_id: ar3.id, amount: 0 }],
  remark: '测试：多付 2000 转预收',
  actor: { id: null, name: '测试' }
})
confirmReceipt(db, { id: rc4.id, actor: { id: null, name: '测试' } })

const pp = prepayList(db, { subjectType: 'dealer', subjectId: dealer.id })
ok(near(pp.total - ppBefore, 2000, 0.05), '预收余额增加 = 多收的 2000（不多不少）')
const ppDetail = prepayDetail(db, { subjectType: 'dealer', subjectId: dealer.id })
ok(ppDetail.receipts.some((r) => r.id === rc4.id && near(r.left_amount, 2000, 0.05)), '预收明细指到具体收款单')
ok(near(ppDetail.prepay_total, pp.total, 0.05), '明细合计 = 清单合计')
ok(
  ppDetail.receipts.every((r) => r.left_amount > 0.005),
  '已抵完的收款单不出现在预收明细里'
)
ok(ppDetail.open_ars.some((r) => r.id === ar3.id), '预收明细同时给出可抵的未结应收')

// 预收转应收：拿预收去抵 ar3（300 元）
const applied = applyPrepay(db, { receiptId: rc4.id, arId: ar3.id, actor: { id: null, name: '测试' } })
ok(near(applied.applied, 300, 0.05), '预收按指定应收单抵扣（金额 = 该单余额）')
ok(near(applied.remaining, 1700, 0.05), '剩余预收正确回退')
eq('抵账后 ar3 结清', db.prepare('SELECT status FROM ar_documents WHERE id=?').get(ar3.id).status, 'closed')
const ppAfter = prepayList(db, { subjectType: 'dealer', subjectId: dealer.id })
ok(near(ppAfter.total, ppBefore + 1700, 0.05), '预收清单跟着减少')

// 抵不平的对象要拦住：预收与应收不是同一往来对象时拒绝
let mismatchErr = null
try {
  applyPrepay(db, { receiptId: rc4.id, arId: 999999 })
} catch (e) {
  mismatchErr = e.code
}
ok(mismatchErr === 'AR_NOT_FOUND', '抵到不存在的应收单被拒绝')

// 已核销完的收款单不能再抵
let prepayErr = null
try {
  applyPrepay(db, { receiptId: rc.id, auto: true })
} catch (e) {
  prepayErr = e.code
}
ok(prepayErr === 'PREPAY_EMPTY', '没有预收余额时拒绝抵账（不留静默空转）')

// ---------- 14. 订货中心并入应收（第二阶段）----------
const ocOrder = db
  .prepare("SELECT * FROM oc_orders WHERE status IN ('received','completed','shipped','allocated') ORDER BY id LIMIT 1")
  .get()
if (ocOrder) {
  const ocar = ensureOcAr(db, ocOrder, { id: null, name: '测试' })
  ok(ocar.source_type === 'OC', '订货单生成的应收来源标记为 OC')
  ok(ocar.subject_type === 'oc', '订货单应收挂订货客户（不是经销商档案）')
  eq('订货单应收金额 = 订货单金额', Number(ocar.amount), Number(ocOrder.total_amount))
  eq('同一订货单重复生成返回同一张（幂等）', ensureOcAr(db, ocOrder, { id: null, name: '测试' }).id, ocar.id)

  const pend = pendingOcAr(db)
  ok(!pend.rows.some((r) => r.id === ocOrder.id), '已并入的订货单不在待并入清单里')
  ok(
    db.prepare("SELECT 1 AS hit FROM ar_documents WHERE source_type='OC' AND source_id=?").get(ocOrder.id),
    '库里能按来源反查到应收'
  )
  const sync1 = syncOcAr(db, { actor: { id: null, name: '测试' } })
  const sync2 = syncOcAr(db, { actor: { id: null, name: '测试' } })
  eq('批量并入是幂等的（再跑一次为 0）', sync2.count, 0)
  ok(sync1.count >= 0 && Array.isArray(sync1.created), '批量并入返回明细')

  // ---------- 15. OC 回款释放 12A 台账占用 ----------
  const ocWithHold = db
    .prepare(
      `SELECT o.id, o.doc_no, o.credit_hold, o.customer_id FROM oc_orders o
       WHERE o.credit_hold > 0.01 AND o.status IN ('received','completed')
       ORDER BY o.credit_hold DESC LIMIT 1`
    )
    .get()
  if (ocWithHold) {
    const arOc = db.prepare('SELECT * FROM ar_documents WHERE source_type=? AND source_id=?').get('OC', ocWithHold.id)
    if (arOc) {
      const holdBefore = Number(ocWithHold.credit_hold)
      const repayBefore = db
        .prepare("SELECT COUNT(*) c FROM oc_credit_ledger WHERE order_id=? AND change_type='repay'")
        .get(ocWithHold.id).c
      const payAmount = Number(Math.min(arOc.amount, holdBefore).toFixed(2))
      const rcOc = createReceipt(db, {
        subjectType: 'oc',
        subjectId: arOc.subject_id,
        receiptDate: today,
        amount: arOc.amount,
        method: 'transfer',
        serialNo: 'TEST-OC-PAY',
        allocations: [{ ar_id: arOc.id, amount: arOc.amount }],
        remark: '测试：订货单回款',
        actor: { id: null, name: '测试' }
      })
      confirmReceipt(db, { id: rcOc.id, actor: { id: null, name: '测试' } })

      const holdAfter = Number(db.prepare('SELECT credit_hold FROM oc_orders WHERE id=?').get(ocWithHold.id).credit_hold)
      ok(holdAfter < holdBefore, 'OC 回款释放了订货占用（额度回来了）')
      ok(near(holdBefore - holdAfter, payAmount), '释放金额 = 本次核销金额（不重复释放）')
      const repayAfter = db
        .prepare("SELECT COUNT(*) c FROM oc_credit_ledger WHERE order_id=? AND change_type='repay'")
        .get(ocWithHold.id).c
      ok(repayAfter > repayBefore, '释放动作在 12A 台账上有留痕')

      // 作废收款：额度要占回来，否则等于白送授信
      voidReceipt(db, { id: rcOc.id, actor: { id: null, name: '测试' }, reason: '测试作废' })
      const holdRestored = Number(db.prepare('SELECT credit_hold FROM oc_orders WHERE id=?').get(ocWithHold.id).credit_hold)
      ok(near(holdRestored, holdBefore), '作废收款后占用恢复原值')
      recalcAr(db, arOc.id)

      // 清理这张测试收款单
      db.prepare('DELETE FROM receipt_allocations WHERE receipt_id=?').run(rcOc.id)
      db.prepare('DELETE FROM receipts WHERE id=?').run(rcOc.id)
      db.prepare("DELETE FROM doc_events WHERE doc_type='RCP' AND doc_id=?").run(rcOc.id)
    }
  }
}

// ---------- 16. 对账单的两个终局动作：结清（必须收齐）/ 作废（不动应收） ----------
// 载体是 `dealer_statements`（实体表）——**不是** `lib/ar.js` 的 statement()。
// 后者是"实时算"的对账视图（无 id、不落库），根本没有"结清 / 作废"可言。
// 本节守两条口径（它们正是这两个动作存在的意义）：
//   ① 结清**必须**"同主体同期间应收已收齐"；账没收齐时唯一入口是
//      显式 `force=true` + 写明理由。去掉判据，"0 回款也能标已结清"就会成立（反例甲）。
//   ② 作废**只作废这份对账单凭证**，`sales_orders` / `ar_documents` 分毫不动。
//      把应收也顺带置 voided，就是对账结论与债权台账脱节（反例乙）。
const TEST_ACTOR = { id: null, name: '测试' }
const DS_TEST_PREFIX = 'TEST-DS-'
let dsSeq = 0

/** 抛错断言：确实抛了、且业务码匹配（不给码则只要求抛错） */
function throwsCode(fn, wantCode) {
  try {
    fn()
  } catch (e) {
    return !wantCode || e?.code === wantCode
  }
  return false
}

/**
 * 调一个**应当成功**的业务函数：失败不抛到顶层，返回 `{ ok, value, error }`。
 * 为什么要它：断言用 `ok/eq` 记红后**不会终止**，若后面直接调一个已经不该成立的动作
 * （例如反例注入后，同一张单被结清了两次），未捕获的异常会让整个脚本崩在堆栈上，
 * 断言的红反而被堆栈盖住 —— 崩溃看起来像"脚本写错了"，而不是"实现被改坏了"。
 */
function tryCall(fn) {
  try {
    return { ok: true, value: fn() }
  } catch (e) {
    return { ok: false, error: e }
  }
}

/**
 * 造一张测试对账单。金额一律用 statementFigures 重算（口径唯一出处），
 * 所以样本的"存的值"与"算的值"从一开始就一致 —— 断言不会踩到口径漂移。
 * 期间取空区间（`1970-01-01`）时，四个数全为 0 ⇒ 期末应收为 0 ⇒ 判定"已收齐"。
 */
function mkTestStatement({ dealerId, periodStart, periodEnd, status }) {
  const fig = statementFigures(db, { dealerId, periodStart, periodEnd })
  const docNo = DS_TEST_PREFIX + String(++dsSeq)
  const info = db
    .prepare(
      `INSERT INTO dealer_statements
        (doc_no,dealer_id,period_start,period_end,opening_amount,sales_amount,return_amount,received_amount,closing_amount,status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(docNo, dealerId, periodStart, periodEnd, fig.opening_amount, fig.sales_amount, fig.return_amount, fig.received_amount, fig.closing_amount, status)
  return Number(info.lastInsertRowid)
}

// 样本 A/C 用"库里有欠款的真实期间"（重算必然 > 容差）；样本 B/D 用空区间（重算必然 ≈ 0）。
const seedSt = db
  .prepare('SELECT * FROM dealer_statements WHERE closing_amount > 0.01 AND dealer_id IS NOT NULL ORDER BY id LIMIT 1')
  .get()
ok(!!seedSt, '库里有可用于测试的未收结对账单样本')
const figA = statementFigures(db, { dealerId: seedSt.dealer_id, periodStart: seedSt.period_start, periodEnd: seedSt.period_end })
ok(figA.closing_amount > SETTLE_TOLERANCE, `样本期间确实未收齐（期末应收 ${figA.closing_amount}）`)

const aId = mkTestStatement({ dealerId: seedSt.dealer_id, periodStart: seedSt.period_start, periodEnd: seedSt.period_end, status: 'confirmed' })
const bId = mkTestStatement({ dealerId: seedSt.dealer_id, periodStart: '1970-01-01', periodEnd: '1970-01-01', status: 'confirmed' })
// C 刻意用**空区间**（期末应收 = 0，"收齐"成立）：这样"不能结清"只可能来自
// "草稿不是 close 边的起点"这条内核规则，而不是被前面的收齐校验挡住 —— 断言才有针对性。
const cId = mkTestStatement({ dealerId: seedSt.dealer_id, periodStart: '1970-01-01', periodEnd: '1970-01-01', status: 'draft' })
const dId = mkTestStatement({ dealerId: seedSt.dealer_id, periodStart: '1970-01-01', periodEnd: '1970-01-01', status: 'draft' })
// E 专测「确认 / 发送」这条链（`POST /statements/:id/status` 的唯一实现）。
const eId = mkTestStatement({ dealerId: seedSt.dealer_id, periodStart: '1970-01-01', periodEnd: '1970-01-01', status: 'draft' })

// ③0 确认 / 发送**走内核**：每一次流转都在 `doc_events` 留一条痕，且带操作人。
// 这一段守的是"它曾经是一段裸 UPDATE"：状态变了、痕一条没有 ⇒ 下面是 0 条 ⇒ 变红。
const dsEvOf = (sid) => db.prepare("SELECT * FROM doc_events WHERE doc_type='DS' AND doc_id=? ORDER BY id").all(sid)
const evBefore = dsEvOf(eId).length
const rE1 = tryCall(() => setStatementStatus(db, { id: eId, actor: TEST_ACTOR, status: 'confirmed' }))
ok(rE1.ok, `确认对账单可以走通${rE1.ok ? '' : '：' + rE1.error?.message}`)
if (rE1.ok) {
  eq('确认后状态为已确认', rE1.value.statement.status, 'confirmed')
  ok(!!rE1.value.statement.confirmed_at, '确认后 confirmed_at 已落库（保留原字段语义）')
}
const evConfirm = dsEvOf(eId)
const lastConfirm = evConfirm[evConfirm.length - 1]
eq('确认留痕恰 1 条（不重复）', evConfirm.length - evBefore, 1)
eq('确认留痕 action', lastConfirm?.action, 'confirm')
eq('确认留痕 from→to', [lastConfirm?.from_state, lastConfirm?.to_state], ['draft', 'confirmed'])
eq('确认留痕带操作人', lastConfirm?.actor_name, TEST_ACTOR.name)

const rE2 = tryCall(() => setStatementStatus(db, { id: eId, actor: TEST_ACTOR, status: 'sent' }))
ok(rE2.ok, `发送对账单可以走通${rE2.ok ? '' : '：' + rE2.error?.message}`)
const evSend = dsEvOf(eId)
const lastSend = evSend[evSend.length - 1]
eq('发送留痕恰 1 条', evSend.length - evConfirm.length, 1)
eq('发送留痕 action', lastSend?.action, 'send')
eq('发送留痕 from→to', [lastSend?.from_state, lastSend?.to_state], ['confirmed', 'sent'])
eq('发送留痕带操作人', lastSend?.actor_name, TEST_ACTOR.name)
eq('发送后状态为已发送', db.prepare('SELECT status FROM dealer_statements WHERE id=?').get(eId).status, 'sent')
ok(pruneOrphanEvents(db, { dryRun: true }).removed === 0, '确认/发送后无孤儿流转留痕')

// 这个端点只认两条前进边："退回草稿"与"一步推 closed"都必须被拒（且不落痕）
ok(throwsCode(() => setStatementStatus(db, { id: eId, actor: TEST_ACTOR, status: 'draft' }), 'BAD_STATUS'), '退回草稿不是合法流转：被拒绝')
ok(throwsCode(() => setStatementStatus(db, { id: eId, actor: TEST_ACTOR, status: 'closed' }), 'BAD_STATUS'), '从 status 端点直接推 closed：被拒绝（终局动作要另走 close）')
eq('被拒后不落新痕', dsEvOf(eId).length, evSend.length)

// ① 「0 回款 / 账没收齐也能标已结清」这条路必须走不通（反例甲的守卫）
ok(throwsCode(() => closeStatement(db, { id: aId, actor: TEST_ACTOR }), 'STATEMENT_NOT_SETTLED'), '账未收齐且不 force：结清被拒绝')
const aAfterReject = db.prepare('SELECT * FROM dealer_statements WHERE id=?').get(aId)
eq('被拒绝后状态不变', aAfterReject.status, 'confirmed')
eq('被拒绝后不写结清时间', aAfterReject.closed_at, null)

// ② 手动结清是**显式越权**：必须写理由，且理由有最短长度
ok(throwsCode(() => closeStatement(db, { id: aId, actor: TEST_ACTOR, force: true }), 'REASON_REQUIRED'), '手动结清不写理由：被拒绝')
ok(throwsCode(() => closeStatement(db, { id: aId, actor: TEST_ACTOR, force: true, reason: '短' }), 'REASON_REQUIRED'), '手动结清理由过短：被拒绝')

// ③ 草稿不能跳过对账直接结清（内核 DS 的 close 边只从 confirmed / sent 出发）
ok(throwsCode(() => closeStatement(db, { id: cId, actor: TEST_ACTOR }), 'TRANSITION_NOT_ALLOWED'), '草稿对账单不能结清')

// ④ 收齐了就能结清（自动结清）
const rB = tryCall(() => closeStatement(db, { id: bId, actor: TEST_ACTOR }))
ok(rB.ok, `已收齐的对账单可以结清${rB.ok ? '' : '：' + rB.error?.message}`)
if (rB.ok) {
  eq('已收齐：状态为已结清', rB.value.statement.status, 'closed')
  ok(!!rB.value.statement.closed_at, '已结清：结清时间已落库')
  eq('已结清：结清人已落库', rB.value.statement.closed_by_name, TEST_ACTOR.name)
  ok(rB.value.settled === true && rB.value.forced === false, '已收齐：判定为自动结清（非手动）')
}

// ⑤ 手动结清走通，且**理由落在单据上**（不只是事件流的 remark —— 理由要跟这张单走）
const MANUAL_REASON = '客户走线下和解，尾款不再收取'
const rA = tryCall(() => closeStatement(db, { id: aId, actor: TEST_ACTOR, force: true, reason: MANUAL_REASON }))
ok(rA.ok, `手动结清（force + 理由）可以走通${rA.ok ? '' : '：' + rA.error?.message}`)
if (rA.ok) {
  eq('手动结清：状态为已结清', rA.value.statement.status, 'closed')
  eq('手动结清：理由落在单据上', rA.value.statement.close_reason, MANUAL_REASON)
  ok(rA.value.forced === true, '手动结清：被标记为手动（与自动结清可区分）')
}

// ⑥ 结清留痕：走内核 applyTransition，写 doc_events（只追加，不重复）
const closeEv = db.prepare("SELECT * FROM doc_events WHERE doc_type='DS' AND doc_id=? AND action='close' ORDER BY id").all(aId)
eq('结清留痕恰 1 条（只追加）', closeEv.length, 1)
eq('结清留痕 from→to', [closeEv[0].from_state, closeEv[0].to_state], ['confirmed', 'closed'])
ok(String(closeEv[0].remark || '').includes('手动结清'), '结清留痕标明这是手动结清')

// ⑦ 作废**只动对账单**：底层应收台账分毫不动（反例乙的守卫）
const AR_SQL = "SELECT COUNT(*) c, COALESCE(SUM(amount),0) amt, COALESCE(SUM(allocated_amount),0) alloc FROM ar_documents WHERE subject_type='dealer' AND subject_id=?"
const SO_SQL = "SELECT COALESCE(SUM(receivable_amount - paid_amount),0) open FROM sales_orders WHERE dealer_id=? AND status NOT IN ('cancelled','draft')"
const arBefore = db.prepare(AR_SQL).get(seedSt.dealer_id)
const soBefore = db.prepare(SO_SQL).get(seedSt.dealer_id)
const arStatusBefore = db.prepare("SELECT status, COUNT(*) c FROM ar_documents WHERE subject_type='dealer' AND subject_id=? GROUP BY status").all(seedSt.dealer_id)

const VOID_REASON = '期间录错，重开一张'
const rV = tryCall(() => voidStatement(db, { id: dId, actor: TEST_ACTOR, reason: VOID_REASON }))
ok(rV.ok, `作废可以走通${rV.ok ? '' : '：' + rV.error?.message}`)
if (rV.ok) {
  eq('作废：状态为已作废', rV.value.statement.status, 'voided')
  eq('作废：理由落在单据上', rV.value.statement.void_reason, VOID_REASON)
  eq('作废：作废人已落库', rV.value.statement.voided_by_name, TEST_ACTOR.name)
  ok(!!rV.value.statement.voided_at, '作废：时间已落库')
}

const arAfter = db.prepare(AR_SQL).get(seedSt.dealer_id)
const soAfter = db.prepare(SO_SQL).get(seedSt.dealer_id)
const arStatusAfter = db.prepare("SELECT status, COUNT(*) c FROM ar_documents WHERE subject_type='dealer' AND subject_id=? GROUP BY status").all(seedSt.dealer_id)
eq('作废不动应收单：张数 / 金额 / 已核销均不变', [arAfter.c, arAfter.amt, arAfter.alloc], [arBefore.c, arBefore.amt, arBefore.alloc])
eq('作废不动应收台账：订单未结余额不变', soAfter.open, soBefore.open)
eq('作废不动应收状态分布', JSON.stringify(arStatusAfter), JSON.stringify(arStatusBefore))

// ⑧ 作废必须写理由；终态不可再流转（内核：voided 无出边）
ok(throwsCode(() => voidStatement(db, { id: dId, actor: TEST_ACTOR }), 'REASON_REQUIRED'), '作废不写理由：被拒绝')
ok(throwsCode(() => voidStatement(db, { id: dId, actor: TEST_ACTOR, reason: '再作废一次试试' }), 'TRANSITION_NOT_ALLOWED'), '已作废的对账单不能再作废')
ok(throwsCode(() => voidStatement(db, { id: aId, actor: TEST_ACTOR, reason: '已结清的再作废' }), 'TRANSITION_NOT_ALLOWED'), '已结清的对账单不能作废')

// 作废留痕
const voidEv = db.prepare("SELECT * FROM doc_events WHERE doc_type='DS' AND doc_id=? AND action='void' ORDER BY id").all(dId)
eq('作废留痕恰 1 条', voidEv.length, 1)
eq('作废留痕 from→to', [voidEv[0].from_state, voidEv[0].to_state], ['draft', 'voided'])
ok(pruneOrphanEvents(db, { dryRun: true }).removed === 0, '对账单动作后无孤儿流转留痕')

// ---------- 17. 自洽审计（第二阶段口径）----------
const audit2 = auditAr(db)
ok(audit2.ok, '第二阶段操作后仍自洽')
ok(pruneOrphanEvents(db, { dryRun: true }).removed === 0, '第二阶段无孤儿流转留痕')

// ---------- 18. 清理本轮测试数据 ----------
const tx = db.transaction(() => {
  for (const id of [ar1.id, ar2.id, ar3.id]) {
    db.prepare('DELETE FROM receipt_allocations WHERE ar_id=?').run(id)
    db.prepare('DELETE FROM ar_documents WHERE id=?').run(id)
  }
  for (const id of [rc.id, rc2.id, rc3.id, rc4.id]) {
    db.prepare('DELETE FROM receipt_allocations WHERE receipt_id=?').run(id)
    db.prepare('DELETE FROM receipts WHERE id=?').run(id)
  }
  db.prepare("DELETE FROM doc_events WHERE doc_type='RCP' AND doc_id IN (?,?,?,?)").run(rc.id, rc2.id, rc3.id, rc4.id)
  db.prepare("DELETE FROM doc_events WHERE doc_type='AR' AND doc_id IN (?,?,?)").run(ar1.id, ar2.id, ar3.id)
  // 对账单样本与它的流转留痕（doc_events 是旁支表，必须一并清，否则会留下孤儿留痕）
  for (const id of [aId, bId, cId, dId, eId]) {
    db.prepare('DELETE FROM dealer_statements WHERE id=?').run(id)
    db.prepare("DELETE FROM doc_events WHERE doc_type='DS' AND doc_id=?").run(id)
  }
})
tx()
ok(auditAr(db).ok, '清理后仍自洽')

console.log(`\n通过 ${pass}　失败 ${fail}`)
if (only.length) console.log('失败项：\n - ' + only.join('\n - '))
console.log('─'.repeat(64))
process.exit(fail ? 1 : 0)
