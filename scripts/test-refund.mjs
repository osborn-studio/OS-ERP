/**
 * ============================================================================
 * 文件标识：scripts/test-refund.mjs ｜ 测试：批次 J：退款单（销售退货「待退款」的兑现）
 * ============================================================================
 * 【职责】测试：批次 J：退款单（销售退货「待退款」的兑现）
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
 * 批次 J：退款单（销售退货「待退款」的兑现）
 *
 * 这一批补的是 D1 只做到一半的那一环：
 *   D1 把退货的应收后果做到了"如实登记 `refund_due`" —— 答出了"该退多少"，
 *   **但没有任何东西能把这件事变成一次真实的出账**。
 *   于是那个数字永远停在界面上：既不能被核销（"这笔退了吗"答不出），
 *   也不能被审计（"谁放的这笔钱"答不出）。
 *
 * 所以这里按「判据 × 时点 × 后果」写，而不是按接口写：
 *   ① 判据：退款上限 = 待退 − **已确认**退款额（按退货单累计）；
 *      草稿不占用额度（否则"先建单、后作废"成了一条永远退不出去的路）；
 *   ② 时点：**建单合法 ≠ 确认时合法** —— 两张草稿可以各自合法地答应退同一笔额度，
 *      真正冲突的是**确认的那一刻**（与 A07 收款单同源）；
 *   ③ 后果：确认即出账（终态），必须有账务后果（凭证：借预收 / 贷银行）。
 *
 * 与其它域同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-refund.mjs [cosmetic|food|apparel]
 *
 * 「可重复跑」：开跑前按标记 `__test_refund__` 把自己上一轮的残渣**成对清掉**
 * （子表 → 父表：凭证分录 → 凭证 → 退款明细 → 退款单 → 探针退货单），结束后再清一次。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { nextDocNo } from '../server/lib/docno.js'
import * as RF from '../server/lib/refund.js'
import * as A from '../server/lib/accounting.js'
import { pruneOrphanEvents } from '../server/lib/docflow.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { DATA_DIR, dbPathFor, INDUSTRIES } from '../server/db/index.js'

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
    return null
  }
  console.log(`  \x1b[31m✗\x1b[0m ${msg}：没有抛错`)
  ok(false, msg)
  return null
}

const T = '__test_refund__'
const dbFile = dbPathFor(INDUSTRY)
const db = new Database(dbFile)
db.pragma('journal_mode = WAL')
const actor = { id: null, name: 'test-refund' }
const ymd = (d = new Date()) => d.toISOString().slice(0, 10)
const money = (v) => Math.round((Number(v) || 0) * 100) / 100
const ph = (n) => Array.from({ length: n }, () => '?').join(',')

console.log(`=== 退款单测试（${INDUSTRY}） ===`)

// ---------------------------------------------------------------- 残留自愈
function myRefundIds() {
  return db.prepare('SELECT id FROM refunds WHERE remark LIKE ? OR void_reason LIKE ?').all(`${T}%`, `${T}%`).map((r) => r.id)
}
function myReturnIds() {
  return db.prepare('SELECT id FROM sales_returns WHERE reason LIKE ?').all(`${T}%`).map((r) => r.id)
}
function cleanup() {
  const rids = myRefundIds()
  const retIds = myReturnIds()
  const inList = (a) => (a.length ? `(${a.join(',')})` : '(NULL)')
  const vids = rids.length
    ? db.prepare(`SELECT id FROM vouchers WHERE source_type='refunds' AND source_id IN ${inList(rids)}`).all().map((r) => r.id)
    : []
  if (vids.length) {
    db.prepare(`DELETE FROM voucher_entries WHERE voucher_id IN ${inList(vids)}`).run()
    db.prepare(`DELETE FROM vouchers WHERE id IN ${inList(vids)}`).run()
  }
  if (rids.length) {
    db.prepare(`DELETE FROM refund_items WHERE refund_id IN ${inList(rids)}`).run()
    db.prepare(`DELETE FROM refunds WHERE id IN ${inList(rids)}`).run()
  }
  if (retIds.length) db.prepare(`DELETE FROM sales_returns WHERE id IN ${inList(retIds)}`).run()
  // 事件留痕：**不随业务单级联删除**，孤儿事件会让"这张单经历过什么"永久残留在流程图上
  pruneOrphanEvents(db)
  return { rids, retIds, vids }
}
cleanup()

// ---------------------------------------------------------------- 夹具
const dealers = db.prepare("SELECT id, name FROM dealers WHERE status='active' ORDER BY id LIMIT 2").all()
if (dealers.length < 2) {
  console.log('  \x1b[31m✗\x1b[0m 缺少经销商主档，无法构造退款场景')
  process.exit(1)
}
const whId = db.prepare("SELECT id FROM warehouses WHERE type='central' LIMIT 1").get()?.id ?? 1

/** 探针退货单：退款只关心 `refund_due`，所以夹具直接把它写成我们要的数字 */
function mkReturn({ dealerId, refundDue, status = 'confirmed', channel = 'dealer', returnDate = ymd() }) {
  const docNo = nextDocNo(db, 'SRT', 'sales_returns', 'doc_no', returnDate)
  const info = db
    .prepare(
      `INSERT INTO sales_returns
       (doc_no,order_id,source_type,channel,dealer_id,warehouse_id,return_date,reason,status,total_qty,total_amount,created_by,refund_due)
       VALUES (?,NULL,'order',?,?,?,?,?,?,0,?,NULL,?)`
    )
    .run(docNo, channel, dealerId, whId, returnDate, `${T} 探针退货`, status, refundDue, refundDue)
  return { id: Number(info.lastInsertRowid), doc_no: docNo }
}

const D1 = dealers[0]
const D2 = dealers[1]
const R1 = mkReturn({ dealerId: D1.id, refundDue: 1000 })
const R2 = mkReturn({ dealerId: D1.id, refundDue: 500 })

// ================================================================ 1. 退款上限判据
section('1. 退款上限判据（待退 − 已确认退款额）')

const info1 = RF.refundableOf(db, R1.id)
eq('可退余额 = refund_due（尚无退款）', info1.refundable, 1000)
eq('客户由退货单推导（不是调用方传的）', info1.customer.type, 'dealer')
eq('客户 id 与退货单一致', info1.customer.id, D1.id)

throws(() => RF.planRefund(db, { items: [] }), 'REFUND_NO_ITEMS', '空明细 → 拒绝')
throws(() => RF.planRefund(db, { items: [{ return_id: R1.id, amount: 0 }] }), 'REFUND_ITEM_BAD_AMOUNT',
  '金额为 0 → 拒绝（值域是引擎的责任）')
throws(() => RF.planRefund(db, { items: [{ return_id: R1.id, amount: -100 }] }), 'REFUND_ITEM_BAD_AMOUNT',
  '金额为负 → 拒绝（负数会让"超上限"这道闸门恒为假）')
throws(() => RF.planRefund(db, { items: [{ amount: 100 }] }), 'REFUND_ITEM_NO_RETURN', '缺退货单 → 拒绝')
throws(() => RF.planRefund(db, { items: [{ return_id: 99999999, amount: 100 }] }), 'REFUND_RETURN_NOT_FOUND',
  '退货单不存在 → 拒绝')
throws(() => RF.planRefund(db, { items: [{ return_id: R1.id, amount: 1001 }] }), 'REFUND_OVER_DUE',
  '超过可退余额 → 拒绝（不是截平）')
throws(
  () => RF.planRefund(db, { items: [{ return_id: R1.id, amount: 600 }, { return_id: R1.id, amount: 600 }] }),
  'REFUND_ITEM_DUPLICATE',
  '同一张退货单在同一次退款里出现两次 → 拒绝（合并前两条各 600 都不超，合起来超）'
)
throws(
  () => RF.planRefund(db, { items: [{ return_id: R1.id, amount: 700 }, { return_id: R2.id, amount: 600 }] }),
  'REFUND_OVER_DUE',
  '两条明细分属不同退货单，其中一条超 → 拒绝（判据按单累计，不是看合计）'
)

const draftRet = mkReturn({ dealerId: D1.id, refundDue: 300, status: 'draft' })
throws(() => RF.planRefund(db, { items: [{ return_id: draftRet.id, amount: 100 }] }), 'REFUND_RETURN_STATUS',
  '草稿状态的退货单 → 拒绝（草稿是意向，不是事实）')

const otherRet = mkReturn({ dealerId: D2.id, refundDue: 200 })
throws(
  () => RF.planRefund(db, { items: [{ return_id: R1.id, amount: 100 }, { return_id: otherRet.id, amount: 100 }] }),
  'REFUND_CUSTOMER_MISMATCH',
  '两个不同客户的退货单混在一张退款单 → 拒绝（等于把 A 的钱退给 B，而两边账各自都是对的）'
)

const plan = RF.planRefund(db, { items: [{ return_id: R1.id, amount: 600 }, { return_id: R2.id, amount: 200 }] })
eq('合法：明细行数', plan.lines.length, 2)
eq('合法：合计 = 各行之和', plan.total, 800)
eq('合法：客户来自退货单', plan.customer.id, D1.id)

// ================================================================ 2. 登记退款单
section('2. 登记退款单（草稿：钱不动）')

const IDEM = `${T}-idem-1`
const rf1 = RF.createRefund(db, {
  items: [{ return_id: R1.id, amount: 600 }],
  refundDate: ymd(),
  method: 'bank',
  idempotencyKey: IDEM,
  remark: `${T} 已登记`,
  actor
})
eq('建单返回 draft', rf1.status, 'draft')
eq('金额 = 明细合计', rf1.amount, 600)
eq('明细落库', db.prepare('SELECT COUNT(*) c FROM refund_items WHERE refund_id=?').get(rf1.id).c, 1)
eq('客户落到单头', rf1.customer_id, D1.id)

const rf1b = RF.createRefund(db, { items: [{ return_id: R1.id, amount: 600 }], idempotencyKey: IDEM, actor })
eq('同键重放返回同一张（不新建）', rf1b.id, rf1.id)
eq('重放标记为 true', rf1b.replayed, true)
eq('同键没有多出一张', db.prepare('SELECT COUNT(*) c FROM refunds WHERE idempotency_key=?').get(IDEM).c, 1)

eq('**草稿不占用额度**（可退余额不变）', RF.refundableOf(db, R1.id).refundable, 1000)

throws(() => RF.createRefund(db, { items: [{ return_id: R1.id, amount: 100 }], method: 'bitcoin', actor }),
  'REFUND_BAD_METHOD', '非法退款方式 → 拒绝')
throws(() => RF.createRefund(db, { items: [], actor }), 'REFUND_NO_ITEMS', '空明细建单 → 拒绝')

// ================================================================ 3. 确认退款（出账）
section('3. 确认退款（这一步才出账）')

const rf1c = RF.confirmRefund(db, { id: rf1.id, actor })
eq('确认后状态为已退款', rf1c.status, 'confirmed')
eq('确认返回的是同一张单', rf1c.id, rf1.id)
const confirmedRow = db.prepare('SELECT * FROM refunds WHERE id=?').get(rf1.id)
ok(!!confirmedRow.confirmed_by_name && !!confirmedRow.confirmed_at, '库里落了确认人 + 确认时间（"谁放的这笔钱"要答得上）')

eq('**确认后才占用额度**（可退余额 1000 → 400）', RF.refundableOf(db, R1.id).refundable, 400)
eq('累计已退额', RF.refundedOf(db, R1.id), 600)

const rf1d = RF.confirmRefund(db, { id: rf1.id, actor })
eq('重复确认幂等（不重复出账）', rf1d.replayed, true)
eq('重复确认后已退额没有翻倍', RF.refundedOf(db, R1.id), 600)

// —— 两张草稿可以各自"合法地"答应退同一笔额度：真正冲突的是确认的那一刻 ——
// 建单处刻意包 try/catch：如果"草稿也占用额度"这条口径被改坏，**第二张建单本身就会抛错**，
// 未捕获的异常会把后面所有断言一起吞掉 —— 那种"红"没有信息量，看不出到底哪条规则坏了。
const rA = mkReturn({ dealerId: D2.id, refundDue: 400 })
const tryCreate = (fn) => {
  try {
    return fn()
  } catch (e) {
    return { id: null, status: `抛错 ${e.code || e.message}` }
  }
}
const draft1 = tryCreate(() => RF.createRefund(db, { items: [{ return_id: rA.id, amount: 400 }], remark: `${T} 草稿甲`, actor }))
const draft2 = tryCreate(() => RF.createRefund(db, { items: [{ return_id: rA.id, amount: 400 }], remark: `${T} 草稿乙`, actor }))
eq('两张草稿在**建单时都合法**（各自 ≤ 可退余额；草稿不占用额度）', [draft1.status, draft2.status], ['draft', 'draft'])
RF.confirmRefund(db, { id: draft1.id, actor })
throws(() => RF.confirmRefund(db, { id: draft2.id ?? -1, actor }), 'REFUND_OVER_DUE',
  '第二张草稿确认时 → 拒绝（建单时合法 ≠ 确认时合法）')

// —— 作废 ——
const rB = mkReturn({ dealerId: D2.id, refundDue: 300 })
const rfVoid = RF.createRefund(db, { items: [{ return_id: rB.id, amount: 300 }], remark: `${T} 待作废`, actor })
throws(() => RF.voidRefund(db, { id: rfVoid.id }), 'REFUND_VOID_REASON_REQUIRED', '作废不写理由 → 拒绝')
const voided = RF.voidRefund(db, { id: rfVoid.id, reason: `${T} 账号填错`, actor })
eq('作废成功', voided.status, 'voided')
eq('作废留痕（"为什么这笔不算了"要答得上）',
  db.prepare('SELECT void_reason FROM refunds WHERE id=?').get(rfVoid.id).void_reason, `${T} 账号填错`)
eq('重复作废幂等', RF.voidRefund(db, { id: rfVoid.id }).replayed, true)
eq('作废后额度**未被占用**（作废的草稿从未出账）', RF.refundableOf(db, rB.id).refundable, 300)

// —— 作废一张**已退款**的单：它是高危动作，但必须可行 ——
const rC = mkReturn({ dealerId: D2.id, refundDue: 250 })
const rfC = RF.createRefund(db, { items: [{ return_id: rC.id, amount: 250 }], remark: `${T} 已退再作废`, actor })
RF.confirmRefund(db, { id: rfC.id, actor })
eq('已退款的占用了额度', RF.refundableOf(db, rC.id).refundable, 0)
RF.voidRefund(db, { id: rfC.id, reason: `${T} 退错客户`, actor })
eq('作废已退款后额度释放（重退可行）', RF.refundableOf(db, rC.id).refundable, 250)

// ================================================================ 4. 账务后果
section('4. 账务后果（确认即入账）')

ok(!!A.BIZ_TYPES.refund, '退款注册进了凭证的业务场景字典（否则"这笔退款在账上没有落点"）')
eq('只有"已退款"状态允许入账', A.BIZ_TYPES.refund.okStatuses, ['confirmed'])

const rB2 = mkReturn({ dealerId: D2.id, refundDue: 800 })
const rfDraft = RF.createRefund(db, { items: [{ return_id: rB2.id, amount: 800 }], remark: `${T} 草稿不入账`, actor })
throws(() => A.generateVoucher(db, { bizType: 'refund', sourceId: rfDraft.id, actor }), 'SOURCE_STATUS_INVALID',
  '草稿退款单生成凭证 → 拒绝（"打算退"不是"退过了"）')

RF.confirmRefund(db, { id: rfDraft.id, actor })
const v = A.generateVoucher(db, { bizType: 'refund', sourceId: rfDraft.id, actor })
okNear(Number(v.total_debit), 800, '退款凭证借贷合计 = 退款额')
okNear(Number(v.total_credit), 800, '退款凭证两边相等')
const entries = db.prepare('SELECT subject_code, direction, amount FROM voucher_entries WHERE voucher_id=? ORDER BY seq').all(v.id)
ok(entries.some((e) => e.direction === 'debit' && e.subject_code === '2203'),
  '借方挂 2203 预收账款（退的是"多收客户的钱"这笔负债）', JSON.stringify(entries))
ok(entries.some((e) => e.direction === 'credit' && e.subject_code === '1002'),
  '贷方挂 1002 银行存款（钱确实出去了）', JSON.stringify(entries))

const v2 = A.generateVoucher(db, { bizType: 'refund', sourceId: rfDraft.id, actor })
eq('同来源重复生成返回同一张', v2.id, v.id)
eq('重复生成没有多出一张', db.prepare("SELECT COUNT(*) c FROM vouchers WHERE source_type='refunds' AND source_id=?").get(rfDraft.id).c, 1)

const trial = A.trialBalance(db)
ok(trial.balanced, '试算平衡表借贷相等（含退款凭证）')

// ================================================================ 5. 域自证
section('5. 域自证（退款域自己回答"我是不是自洽的"）')

const myIds = myRefundIds()
const audit = RF.auditRefund(db, { refIds: myIds })
ok(audit.balanced, '自造数据的退款域自证通过', JSON.stringify(audit.problems.slice(0, 3)))
eq('自证统计到了自造的退款单', audit.refunds >= 3, true)

// 反例：把头金额改大 → 自证必须报"头行不一致"
const target = myIds[0]
const before = db.prepare('SELECT amount FROM refunds WHERE id=?').get(target).amount
db.prepare('UPDATE refunds SET amount=? WHERE id=?').run(money(before + 10), target)
const broken = RF.auditRefund(db, { refIds: myIds })
ok(!broken.balanced, '人为把头金额改大 → 自证变红（头行不一致）')
ok(broken.problems.some((p) => p.includes('明细合计')), '报出的正是"头金额 ≠ 明细合计"', JSON.stringify(broken.problems))
db.prepare('UPDATE refunds SET amount=? WHERE id=?').run(before, target)
ok(RF.auditRefund(db, { refIds: myIds }).balanced, '还原后自证立刻回绿')

// ================================================================ 6. 清理与还原
section('6. 清理与还原')

const cleared = cleanup()
for (const id of cleared.rids) {
  eq(`自造退款单 #${id} 已清掉`, db.prepare('SELECT COUNT(*) c FROM refunds WHERE id=?').get(id).c, 0)
}
eq('自造退款明细未残留', cleared.rids.length
  ? db.prepare(`SELECT COUNT(*) c FROM refund_items WHERE refund_id IN (${ph(cleared.rids.length)})`).get(...cleared.rids).c
  : 0, 0)
eq('自造退货单已清掉', cleared.retIds.length
  ? db.prepare(`SELECT COUNT(*) c FROM sales_returns WHERE id IN (${ph(cleared.retIds.length)})`).get(...cleared.retIds).c
  : 0, 0)
eq('自造凭证已清掉', cleared.vids.length
  ? db.prepare(`SELECT COUNT(*) c FROM vouchers WHERE id IN (${ph(cleared.vids.length)})`).get(...cleared.vids).c
  : 0, 0)
eq('无孤儿退款明细（明细不会指向已删的退货单）',
  db.prepare('SELECT COUNT(*) c FROM refund_items i WHERE NOT EXISTS (SELECT 1 FROM sales_returns r WHERE r.id=i.return_id)').get().c, 0)
ok(RF.auditRefund(db).balanced, '清理后全库退款域仍然自证通过', JSON.stringify(RF.auditRefund(db).problems.slice(0, 3)))
const left = db.prepare('SELECT COUNT(*) c FROM refunds WHERE remark LIKE ? OR void_reason LIKE ?').get(`${T}%`, `${T}%`).c
eq('本测试的残留归零', left, 0)

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
if (failures.length) {
  console.log(`失败项：${failures.join('\n         ')}`)
  process.exitCode = 1
}
db.close()
