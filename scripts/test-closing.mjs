/**
 * ============================================================================
 * 文件标识：scripts/test-closing.mjs ｜ 测试：批次 M：期末结转与结账
 * ============================================================================
 * 【职责】测试：批次 M：期末结转与结账
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
 * 批次 M：期末结转与结账
 *
 * 这一批补的是「账平了，但利润还挂在损益科目上」：
 *   批次 L 让三张报表算得出来，但它自己在注释里承认了「本系统没有做期末结转」，
 *   并靠资产负债表上的一行「未结转损益」把 6xxx 的余额兜进权益。
 *   代价是：收入科目的余额跨年不清零、"账上累计利润"答不出来、"结账"没有落点。
 *
 * 本脚本按「**恒等式**」写，不按接口写：
 *   ① 结转后所有损益类科目余额归零；
 *   ② 目标科目（4103）的余额增量 = 被结转的损益净额；
 *   ③ **结转前后利润表净利润完全相同**（因为利润表的发生额口径剔除了结转账）；
 *   ④ **结转前后资产负债表三项合计完全相同**（结转只在权益内部搬动）。
 * ③④ 是这一批最重要的两条 —— 它们把"结转是记账动作、不是经营事件"这句话
 * 变成了可以随时复算的断言（见迁移 035 的注释三）。
 *
 * 与其它域同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-closing.mjs [cosmetic|food|apparel]
 *
 * 「可重复跑」与「不留副作用」：所有写操作全部包在 `BEGIN … ROLLBACK` 里 ——
 * 假数据与假期间只活在事务里，结束后真表**一行都不多**（M8 会断言这一点）。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import * as R from '../server/lib/report.js'
import * as C from '../server/lib/closing.js'
import * as A from '../server/lib/accounting.js'
import * as P from '../server/lib/period.js'

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
    console.log(`  \x1b[31m✗\x1b[0m ${msg}${detail !== undefined ? `  → ${String(detail).slice(0, 280)}` : ''}`)
  }
}
const eq = (msg, actual, expect) => {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps
const okNear = (a, b, msg, eps = 0.005) => {
  if (!near(a, b, eps)) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望≈${b}，实际 ${a}`)
  ok(near(a, b, eps), msg)
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)
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

const dbFile = dbPathFor(INDUSTRY)
const db = new Database(dbFile)
db.pragma('journal_mode = WAL')
const actor = { id: null, name: 'test-closing' }
const money = (v) => Math.round((Number(v) || 0) * 100) / 100
const byCode = (code) => {
  const s = db.prepare('SELECT * FROM accounting_subjects WHERE code=?').get(String(code))
  if (!s) throw new Error(`科目 ${code} 不存在`)
  return s
}

console.log(`=== 期末结转与结账测试（${INDUSTRY}） ===`)

// 演示库里那个"真的做过结转"的期间（`report-seed` 的 CARRY_PERIODS）
const carriedDemo = db
  .prepare("SELECT period, closing_voucher_id FROM accounting_periods WHERE closing_voucher_id IS NOT NULL ORDER BY period LIMIT 1")
  .get()

// Use periods before the demo ledger: future balances inherit its uncarried profits.
const P1 = '1901-04' // 结转主流程
const P2 = '1901-05' // 关账联动
const P3 = '1901-06' // 探针
const EMPTY_P = '1901-07' // 空期间（无任何凭证）

/** 造一张**已过账**的测试凭证（`biz_type='test_closing'`，因此不会被当成结转账剔除） */
let srcSeq = 0
const mkPosted = (docNo, period, lines) => {
  srcSeq += 1
  const total = money(lines.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.amount, 0))
  const vid = Number(
    db
      .prepare(`
        INSERT INTO vouchers (doc_no,biz_type,source_type,source_id,voucher_date,period,status,total_debit,total_credit,memo,maker_name)
        VALUES (?,'test_closing','test_closing',?,?,?,'posted',?,?,?,'test-closing')
      `)
      .run(docNo, srcSeq, `${period}-15`, period, total, total, docNo).lastInsertRowid
  )
  const ins = db.prepare(`
    INSERT INTO voucher_entries (voucher_id,seq,summary,subject_id,subject_code,subject_name,direction,amount)
    VALUES (?,?,?,?,?,?,?,?)
  `)
  lines.forEach((l, i) => {
    const s = byCode(l.code)
    ins.run(vid, i + 1, docNo, s.id, s.code, s.name, l.direction, l.amount)
  })
  return vid
}

// ===========================================================================
section('M1 结转目标科目（会计政策，唯一出处 settings.closing_profit_subject）')
// ===========================================================================
db.exec('BEGIN')
try {
  eq('演示库的结转目标是本年利润 4103', C.closingSubjectCode(db), '4103')
  const target = C.closingSubject(db)
  eq('目标科目类别是权益类（损益只能结转到权益）', target.category, 'equity')
  ok(Boolean(target.is_leaf), '目标科目必须是叶子科目')

  // 三条校验各造一次：指向不存在的科目 / 指向损益科目 / 指向非叶子科目
  const setTarget = (code) => db.prepare("UPDATE settings SET value=? WHERE key='closing_profit_subject'").run(code)
  setTarget('9999')
  throws(() => C.closingSubject(db), 'CLOSING_SUBJECT_NOT_FOUND', '目标科目不存在 → 拒绝（而不是生成一半才发现）')
  setTarget('6001')
  throws(() => C.closingSubject(db), 'CLOSING_SUBJECT_NOT_EQUITY', '目标科目不是权益类 → 拒绝（否则报表同时错两块，而它仍然平）')
  // 造一个"非叶子"的科目：把 4103 自己标记成父科目
  const wasLeaf = byCode('4103').is_leaf
  db.prepare("UPDATE accounting_subjects SET is_leaf=0 WHERE code='4103'").run()
  setTarget('4103')
  throws(() => C.closingSubject(db), 'CLOSING_SUBJECT_NOT_LEAF', '目标科目不是叶子 → 拒绝（挂父科目会让"父 = 子之和"悄悄不成立）')
  db.prepare('UPDATE accounting_subjects SET is_leaf=? WHERE code=?').run(wasLeaf, '4103')
  setTarget('4103')
  eq('口径恢复后目标科目重新可用', C.closingSubject(db).code, '4103')
} finally {
  db.exec('ROLLBACK')
}

// ===========================================================================
section('M2 结转计划（只算不写）')
// ===========================================================================
db.exec('BEGIN')
try {
  // 本期：收入 1000（贷）/ 成本 400（借）→ 待结转损益净额 600
  mkPosted('__test_closing__A', P1, [
    { code: '1002', direction: 'debit', amount: 1000 },
    { code: '6001', direction: 'credit', amount: 1000 }
  ])
  mkPosted('__test_closing__B', P1, [
    { code: '6401', direction: 'debit', amount: 400 },
    { code: '1403', direction: 'credit', amount: 400 }
  ])

  const pending = R.uncarriedProfitSubjects(db, { period: P1 })
  eq('待结转的损益科目 = 6001 与 6401', pending.map((x) => x.code).sort(), ['6001', '6401'])
  eq('6001 的余额是贷方 1000（signed = 借−贷 = −1000）', pending.find((x) => x.code === '6001').balance_signed, -1000)
  eq('6401 的余额是借方 400', pending.find((x) => x.code === '6401').balance_signed, 400)

  const voucherCountBefore = db.prepare('SELECT COUNT(*) c FROM vouchers').get().c
  const plan = C.planClosing(db, { period: P1 })
  eq('计划不落库（凭证数不变）', db.prepare('SELECT COUNT(*) c FROM vouchers').get().c, voucherCountBefore)
  eq('计划没有把期间标记成已结转', C.closingStatus(db, { period: P1 }).carried, false)
  eq('待结转损益净额 = 1000 − 400', plan.carry_profit, 600)
  eq('本期经营净利润（利润表口径）也是 600', plan.period_net_profit, 600)
  eq('分录行数 = 2 个损益科目 + 1 个目标科目', plan.lines.length, 3)
  // 与其余额方向相反
  const l6001 = plan.lines.find((l) => l.subject_code === '6001')
  const l6401 = plan.lines.find((l) => l.subject_code === '6401')
  eq('收入类（贷方余额）记**借方**冲平', [l6001.direction, l6001.amount], ['debit', 1000])
  eq('成本类（借方余额）记**贷方**冲平', [l6401.direction, l6401.amount], ['credit', 400])
  eq('目标科目记贷方 600（权益增加 = 利润）', [plan.lines[2].subject_code, plan.lines[2].direction, plan.lines[2].amount], ['4103', 'credit', 600])
  eq('计划本身借贷平衡', [plan.total_debit, plan.total_credit], [1000, 1000])
  ok(plan.pending, '计划报告"还有待结转内容"')
  eq('明细覆盖了每一个待结转科目', plan.details.map((d) => d.subject_code).sort(), ['6001', '6401'])
} finally {
  db.exec('ROLLBACK')
}

// ===========================================================================
section('M3 结转执行（四条恒等式 + 幂等）')
// ===========================================================================
db.exec('BEGIN')
try {
  mkPosted('__test_closing__A', P1, [
    { code: '1002', direction: 'debit', amount: 1000 },
    { code: '6001', direction: 'credit', amount: 1000 }
  ])
  mkPosted('__test_closing__B', P1, [
    { code: '6401', direction: 'debit', amount: 400 },
    { code: '1403', direction: 'credit', amount: 400 }
  ])

  const plBefore = R.incomeStatement(db, { period: P1 })
  const bsBefore = R.balanceSheet(db, { period: P1 })
  const cfBefore = R.cashFlow(db, { period: P1 })
  const retainedBefore = bsBefore.rows.find((l) => l.line_code === 'BS_RETAINED').amount
  const uncarriedBefore = bsBefore.rows.find((l) => l.line_code === 'BS_UNCARRIED_PL').amount

  const out = C.carryForward(db, { period: P1, actor })
  ok(!out.replayed, '首次结转不是重放')
  eq('结转凭证当场过账（posted）', out.voucher.status, 'posted')
  eq('结转凭证的业务类型是 profit_carry', out.voucher.biz_type, 'profit_carry')
  eq('结转凭证的日期 = 期间**末日**（不是"今天"）', out.voucher.voucher_date, '1901-04-30')
  eq('结转凭证落在它所结转的那个期间', out.voucher.period, P1)
  eq('结转账借贷平衡', [out.voucher.total_debit, out.voucher.total_credit], [1000, 1000])
  eq(
    '结转账三条分录（借收入 / 贷成本 / 贷本年利润）',
    out.voucher.entries.map((e) => [e.direction, e.subject_code, e.amount]),
    [['debit', '6001', 1000], ['credit', '6401', 400], ['credit', '4103', 600]]
  )

  // 恒等式 ①：损益科目余额归零
  eq('① 结转后没有待结转的损益科目', R.uncarriedProfitSubjects(db, { period: P1 }).length, 0)

  // 恒等式 ②：目标科目余额增量 = 被结转的损益净额
  const bsAfter = R.balanceSheet(db, { period: P1 })
  const retainedAfter = bsAfter.rows.find((l) => l.line_code === 'BS_RETAINED').amount
  const uncarriedAfter = bsAfter.rows.find((l) => l.line_code === 'BS_UNCARRIED_PL').amount
  okNear(retainedAfter - retainedBefore, 600, '② 本年利润行增加了 600（= 被结转的损益净额）')
  okNear(uncarriedAfter, 0, '①「未结转损益」行归零（结转把 6xxx 的余额搬走了）')
  okNear(uncarriedBefore - uncarriedAfter, retainedAfter - retainedBefore, '「未结转损益」减少的正好是「本年利润」增加的')

  // 恒等式 ③：利润表净利润不变
  const plAfter = R.incomeStatement(db, { period: P1 })
  eq('③ 结转前后利润表净利润完全相同', plAfter.totals.PL_NET_PROFIT, plBefore.totals.PL_NET_PROFIT)
  eq('③ 利润表的营业收入也不变', plAfter.rows.find((l) => l.line_code === 'PL_REVENUE').amount, 1000)
  eq('③ 利润表的净利润 = 1000 − 400', plAfter.totals.PL_NET_PROFIT, 600)

  // 恒等式 ④：资产负债表三项合计不变
  eq(
    '④ 结转前后资产 / 负债 / 权益三项合计完全相同',
    [bsAfter.totals.BS_ASSETS_TOTAL, bsAfter.totals.BS_LIABILITIES_TOTAL, bsAfter.totals.BS_EQUITY_TOTAL],
    [bsBefore.totals.BS_ASSETS_TOTAL, bsBefore.totals.BS_LIABILITIES_TOTAL, bsBefore.totals.BS_EQUITY_TOTAL]
  )
  okNear(
    bsAfter.totals.BS_ASSETS_TOTAL,
    bsAfter.totals.BS_LIABILITIES_TOTAL + bsAfter.totals.BS_EQUITY_TOTAL,
    '④ 结转后资产负债表仍然平'
  )

  // 现金流不受结转影响（结转账的借贷双方都不是现金科目）
  const cfAfter = R.cashFlow(db, { period: P1 })
  eq('结转不影响现金流量净增加额', cfAfter.totals.CF_NET_INCREASE, cfBefore.totals.CF_NET_INCREASE)

  // 域自证必须通过
  const audit = R.auditReport(db, { period: P1 })
  ok(audit.ok, '结转后域自证通过', JSON.stringify(audit.problems.map((x) => x.code)))

  // 期间列回写
  const st = C.closingStatus(db, { period: P1 })
  eq('期间记录了结转凭证', st.carried, true)
  eq('期间记录的凭证 id 就是刚生成的那张', st.closing_voucher_id, out.voucher.id)
  eq('期间记录了结转人', st.closing_by_name, 'test-closing')
  ok(Boolean(st.closing_at), '期间记录了结转时间')
  eq('结转后没有待结转内容', st.pending, false)

  // 幂等
  const again = C.carryForward(db, { period: P1, actor })
  ok(again.replayed, '重复结转是重放（不会生成第二张）')
  eq('重复结转仍然指向同一张凭证', again.voucher.id, out.voucher.id)
  eq('库里只有一张结转账', db.prepare("SELECT COUNT(*) c FROM vouchers WHERE biz_type='profit_carry' AND period=?").get(P1).c, 1)

  // 已关账时不能**重新**结转（已结转的情形走幂等；"已关账且未结转"那种形态在 M7 探针里造）
  R.closePeriod(db, { period: P1, actor })
  ok(C.carryForward(db, { period: P1, actor }).replayed, '已关账但已结转 → 结转为重放（不会撞过账闸门）')
} finally {
  db.exec('ROLLBACK')
}

// ===========================================================================
section('M4 关账 / 反关账与结账的联动（含"没有死锁路径"）')
// ===========================================================================
db.exec('BEGIN')
try {
  mkPosted('__test_closing__C', P2, [
    { code: '1002', direction: 'debit', amount: 500 },
    { code: '6001', direction: 'credit', amount: 500 }
  ])

  // ① 未结转 → 不能关账
  throws(() => R.closePeriod(db, { period: P2, actor }), 'PERIOD_NOT_CARRIED', '损益未结转时关账被拒（账没结平就不算定稿）')
  eq('被拒后期间状态未变', P.getPeriod(db, P2)?.status ?? 'open', 'open')

  // ② 结转 → 可以关账
  const cf = C.carryForward(db, { period: P2, actor })
  eq('结转账生成', cf.voucher.status, 'posted')
  const closed = R.closePeriod(db, { period: P2, actor })
  eq('结转后关账成功', closed.status, 'closed')

  // ③ 关账后不能过账（结转之后又冒出草稿的情形）
  const vid = mkPosted('__test_closing__C2', P2, [
    { code: '1002', direction: 'debit', amount: 10 },
    { code: '6001', direction: 'credit', amount: 10 }
  ])
  db.prepare("UPDATE vouchers SET status='draft' WHERE id=?").run(vid)
  throws(() => A.postVoucher(db, { id: vid, actor }), 'PERIOD_CLOSED', '关账后不能再过账（判据仍是 lib/period.js 的那一个）')
  // 清掉这张草稿：关账的前置要求"没有未过账草稿"，留着它 ⑤ 关不了账
  A.voidVoucher(db, { id: vid, actor })
  eq('草稿作废成功（为后面的重新关账腾路）', db.prepare('SELECT status FROM vouchers WHERE id=?').get(vid).status, 'voided')

  // ④ 关账后撤销结转被拒 —— 但**反关账不被拒**，这样才没有死锁
  throws(() => C.reverseClosing(db, { period: P2, actor, reason: '试撤' }), 'PERIOD_CLOSED', '已关账的期间不许撤销结转（那会删掉已定稿账里的凭证）')
  const re = R.reopenPeriod(db, { period: P2, actor, reason: '__test_closing__ 反关账以调整' })
  eq('已结转的期间**可以**反关账（否则与"撤销结转要求未关账"互相锁死）', re.status, 'open')
  eq('反关账的结果里如实带着"本期已结转"的提示', re.carried, true)
  ok(Boolean(re.notice), '反关账返回了提示语（引导先撤销结转再调整）', re.notice)

  // ⑤ 反关账 → 撤销结转 → 重新结转 → 重新关账（完整可走的路径）
  const rv = C.reverseClosing(db, { period: P2, actor, reason: '__test_closing__ 调整损益' })
  ok(!rv.replayed, '撤销结转成功')
  eq('撤销后期间不再标记已结转', C.closingStatus(db, { period: P2 }).carried, false)
  const cf2 = C.carryForward(db, { period: P2, actor })
  ok(!cf2.replayed, '撤销之后可以重新结转（唯一约束不会挡路）')
  ok(cf2.voucher.id !== cf.voucher.id, '重新结转生成的是**新**凭证（旧的已被删除）', `${cf.voucher.id} → ${cf2.voucher.id}`)
  eq('重新关账成功', R.closePeriod(db, { period: P2, actor }).status, 'closed')

  // ⑥ 空期间：没有损益余额，不结转也能关账
  throws(() => C.carryForward(db, { period: EMPTY_P, actor }), 'CLOSING_NOTHING', '空期间没有可结转内容 → 明确拒绝（而不是生成一张 0 元凭证）')
  const emptyClose = R.closePeriod(db, { period: EMPTY_P, actor })
  eq('空期间（损益为 0）不结转也能关账', emptyClose.status, 'closed')
} finally {
  db.exec('ROLLBACK')
}

// ===========================================================================
section('M5 撤销结转（幂等 / 理由 / 三道硬约束）')
// ===========================================================================
db.exec('BEGIN')
try {
  mkPosted('__test_closing__D', P1, [
    { code: '1002', direction: 'debit', amount: 800 },
    { code: '6001', direction: 'credit', amount: 800 }
  ])
  const cf = C.carryForward(db, { period: P1, actor })
  const entriesBefore = db.prepare('SELECT COUNT(*) c FROM voucher_entries WHERE voucher_id=?').get(cf.voucher.id).c
  ok(entriesBefore > 0, '结转账有分录（撤销时要一起删）')

  throws(() => C.reverseClosing(db, { period: P1, actor }), 'REVERSE_REASON_REQUIRED', '撤销结转不写理由 → 拒绝（与反关账、作废已过账凭证同一条口径）')

  const rv = C.reverseClosing(db, { period: P1, actor, reason: '__test_closing__ 撤销理由' })
  eq('撤销后凭证行被删除', db.prepare('SELECT COUNT(*) c FROM vouchers WHERE id=?').get(cf.voucher.id).c, 0)
  eq('撤销后分录行也被删除（不留孤儿）', db.prepare('SELECT COUNT(*) c FROM voucher_entries WHERE voucher_id=?').get(cf.voucher.id).c, 0)
  eq('撤销后期间不再标记已结转', P.getPeriod(db, P1).closing_voucher_id, null)
  eq('撤销理由被记进期间', P.getPeriod(db, P1).closing_reverse_reason, '__test_closing__ 撤销理由')
  eq('撤销后损益余额恢复（待结转内容回来了）', R.uncarriedProfitSubjects(db, { period: P1 }).length, 1)

  // 幂等：未结转时再撤销
  const rv2 = C.reverseClosing(db, { period: P1, actor, reason: '再撤一次' })
  ok(rv2.replayed, '未结转时再撤销是重放（不会报错）')
  eq('重放不会覆盖原来的撤销理由', P.getPeriod(db, P1).closing_reverse_reason, '__test_closing__ 撤销理由')

  // 期间列被改坏成一张**业务**凭证时，拒绝撤销（不能变成万能删除键）
  C.carryForward(db, { period: P1, actor })
  const bizVid = mkPosted('__test_closing__E', P1, [
    { code: '1002', direction: 'debit', amount: 20 },
    { code: '6001', direction: 'credit', amount: 20 }
  ])
  db.prepare('UPDATE accounting_periods SET closing_voucher_id=? WHERE period=?').run(bizVid, P1)
  throws(() => C.reverseClosing(db, { period: P1, actor, reason: '试图删业务凭证' }), 'NOT_A_CARRY_VOUCHER', '期间列指向业务凭证时拒绝删除（撤销只认结转账）')
  eq('那张业务凭证还在', db.prepare('SELECT COUNT(*) c FROM vouchers WHERE id=?').get(bizVid).c, 1)
} finally {
  db.exec('ROLLBACK')
}

// ===========================================================================
section('M6 两套发生额口径（含结转 / 不含结转）—— 本批的核心')
// ===========================================================================
db.exec('BEGIN')
try {
  mkPosted('__test_closing__F', P1, [
    { code: '1002', direction: 'debit', amount: 1000 },
    { code: '6001', direction: 'credit', amount: 1000 }
  ])
  mkPosted('__test_closing__G', P1, [
    { code: '6401', direction: 'debit', amount: 400 },
    { code: '1403', direction: 'credit', amount: 400 }
  ])
  C.carryForward(db, { period: P1, actor })

  const bal = R.subjectBalances(db, { period: P1 })
  const s6001 = bal.rows.find((r) => r.code === '6001')
  const s4103 = bal.rows.find((r) => r.code === '4103')

  eq('`operating` 口径下 6001 仍是本期收入净额（−1000）', s6001.operating_signed, -1000)
  eq('`period` 口径下 6001 被结转冲平（0）', s6001.period_signed, 0)
  okNear(s6001.period_signed - s6001.operating_signed, 1000, '两套口径的差额 = 结转金额')
  eq('`operating` 口径下 4103 不受结转影响（0）', s4103.operating_signed, 0)
  eq('`period` 口径下 4103 收到 600', s4103.period_signed, -600)
  eq('期末余额两套口径一致（结转不改变余额，只改变它挂在哪）', s6001.closing_signed, 0)

  // 试算平衡的恒等式用的是**含结转**口径：期初 + 借 − 贷 = 期末
  const worst = bal.rows.reduce(
    (m, r) => Math.max(m, Math.abs(money(r.opening_signed + r.period_debit - r.period_credit) - r.closing_signed)),
    0
  )
  okNear(worst, 0, '每个科目都满足「期初 + 本期借 − 本期贷 = 期末」（含结转口径）')
  const tb = A.trialBalance(db, { period: P1 })
  okNear(bal.movement.total_debit, tb.total_debit, '科目余额表与试算平衡表仍是**同一份发生额**（都含结转）')
  okNear(bal.movement.total_credit, tb.total_credit, '同上（贷方）')

  // 利润表与经营分析用的是**不含结转**口径
  eq('利润表净利润 = operating 口径复算', R.incomeStatement(db, { period: P1 }).totals.PL_NET_PROFIT, 600)
  eq('经营分析的账上收入也是 operating 口径', R.operatingSummary(db, { period: P1 }).on_books.revenue, 1000)
  eq('经营分析的账上成本也是 operating 口径', R.operatingSummary(db, { period: P1 }).on_books.cost, 400)
} finally {
  db.exec('ROLLBACK')
}

// ===========================================================================
section('M7 自证探针（人造失效：探针不响等于没有）')
// ===========================================================================
db.exec('BEGIN')
try {
  mkPosted('__test_closing__H', P3, [
    { code: '1002', direction: 'debit', amount: 300 },
    { code: '6001', direction: 'credit', amount: 300 }
  ])
  const clean = R.auditReport(db, { period: P3 })
  ok(clean.ok, '造假数据之后（未结转、未关账）自证仍通过', JSON.stringify(clean.problems.map((x) => x.code)))

  // ① 期间记录的结转凭证指向一张**业务**凭证 → CLOSING_VOUCHER_BAD
  const cf1 = C.carryForward(db, { period: P3, actor })
  const bizVid = mkPosted('__test_closing__I', P3, [
    { code: '1002', direction: 'debit', amount: 5 },
    { code: '6001', direction: 'credit', amount: 5 }
  ])
  db.prepare('UPDATE accounting_periods SET closing_voucher_id=? WHERE period=?').run(bizVid, P3)
  const a1 = R.auditReport(db, { period: P3 })
  ok(a1.problems.some((x) => x.code === 'CLOSING_VOUCHER_BAD'), '① 期间说的结转凭证不是结转账 → CLOSING_VOUCHER_BAD', JSON.stringify(a1.problems.map((x) => x.code)))
  db.prepare('UPDATE accounting_periods SET closing_voucher_id=? WHERE period=?').run(cf1.voucher.id, P3)
  // 那张业务凭证是 posted 的，它给本期添了 5 元新损益 —— 不作废它，`CARRY_INCOMPLETE` 会一直响
  A.voidVoucher(db, { id: bizVid, reason: '探针测试①：作废测试凭证', actor })
  ok(R.auditReport(db, { period: P3 }).ok, '① 指针改回、测试凭证作废后探针恢复')

  // ② 已结转但损益又有余额 → CARRY_INCOMPLETE（"反关账后补单、忘了重做结转"的形态）
  mkPosted('__test_closing__J', P3, [
    { code: '1002', direction: 'debit', amount: 70 },
    { code: '6001', direction: 'credit', amount: 70 }
  ])
  const a2 = R.auditReport(db, { period: P3 })
  ok(a2.problems.some((x) => x.code === 'CARRY_INCOMPLETE'), '② 已结转但损益又有余额 → CARRY_INCOMPLETE（否则没人会知道要重做结转）', JSON.stringify(a2.problems.map((x) => x.code)))
  C.reverseClosing(db, { period: P3, actor, reason: '探针测试②：重做结转' })
  C.carryForward(db, { period: P3, actor })
  ok(R.auditReport(db, { period: P3 }).ok, '② 重做结转后探针恢复（CARRY_INCOMPLETE 不是永远在响）')

  // ③ 反向不一致：指针被清空，但凭证还在 → CARRY_VOUCHER_ORPHAN
  const carryVid = db.prepare("SELECT id FROM vouchers WHERE biz_type='profit_carry' AND period=? AND status='posted'").get(P3).id
  db.prepare('UPDATE accounting_periods SET closing_voucher_id=NULL WHERE period=?').run(P3)
  const a3 = R.auditReport(db, { period: P3 })
  ok(a3.problems.some((x) => x.code === 'CARRY_VOUCHER_ORPHAN'), '③ 账已结转但期间说未结转 → CARRY_VOUCHER_ORPHAN（反方向的坏状态要单独扫凭证表才看得见）', JSON.stringify(a3.problems.map((x) => x.code)))
  const replayOrphan = C.carryForward(db, { period: P3, actor })
  ok(replayOrphan.replayed && replayOrphan.pointer_missing, '③ 指针缺失但凭证在 → 按**凭证表为准**返回重放（不去撞唯一约束、也不重复结转）')

  // ④ 把指针修回来 → 探针恢复。
  // 注意这里**不能用 `reverseClosing` 修**：它要求期间指针非空才动手
  // （指针已经被③清空了，它会直接返回重放）。这一步修的是"人手动改坏的状态"，
  // 所以也手动修回去 —— 生产路径上不会出现这个状态（③ 存在的前提就是有人绕过 API 改库）。
  db.prepare('UPDATE accounting_periods SET closing_voucher_id=? WHERE period=?').run(carryVid, P3)
  ok(R.auditReport(db, { period: P3 }).ok, '④ 指针修回后探针回到通过')

  // ⑤ 已关账且账上**确实**未结转 → PERIOD_CLOSED_NO_CARRY + 结转被拒
  eq('⑤ 此时可以关账（已结转）', R.closePeriod(db, { period: P3, actor }).status, 'closed')
  // 造"确实未结转"：把结转凭证与期间指针一起清掉，再补一笔损益发生额
  const vid5 = db.prepare("SELECT id FROM vouchers WHERE biz_type='profit_carry' AND period=?").get(P3).id
  db.prepare('DELETE FROM voucher_entries WHERE voucher_id=?').run(vid5)
  db.prepare('DELETE FROM vouchers WHERE id=?').run(vid5)
  db.prepare('UPDATE accounting_periods SET closing_voucher_id=NULL WHERE period=?').run(P3)
  mkPosted('__test_closing__K', P3, [
    { code: '1002', direction: 'debit', amount: 30 },
    { code: '6001', direction: 'credit', amount: 30 }
  ])
  const a5 = R.auditReport(db, { period: P3 })
  ok(a5.problems.some((x) => x.code === 'PERIOD_CLOSED_NO_CARRY'), '⑤ 已关账但损益未结平 → PERIOD_CLOSED_NO_CARRY', JSON.stringify(a5.problems.map((x) => x.code)))
  throws(() => C.carryForward(db, { period: P3, actor }), 'PERIOD_CLOSED', '⑤ 已关账且确实未结转 → 结转被拒（要过账就得先反关账）')

  // ⑥ 反关账 → 重新结转 → 回到通过（**证明没有死锁**：关账 + 已结转 这两个状态也走得出去）
  const re = R.reopenPeriod(db, { period: P3, actor, reason: '__test_closing__ 探针还原' })
  eq('⑥ 反关账成功（已关账 + 已结转 不是死路）', re.status, 'open')
  C.carryForward(db, { period: P3, actor })
  const a6 = R.auditReport(db, { period: P3 })
  ok(a6.ok, '⑥ 重新结转后自证回到通过（探针都恢复了）', JSON.stringify(a6.problems.map((x) => x.code)))
} finally {
  db.exec('ROLLBACK')
}

// ===========================================================================
section('M8 演示库状态与清理（不留副作用）')
// ===========================================================================
if (carriedDemo) {
  const st = C.closingStatus(db, { period: carriedDemo.period })
  ok(st.carried, `演示库期间 ${carriedDemo.period} 已结转（report-seed 做过真实结转）`)
  ok(!st.pending, `已结转的 ${carriedDemo.period} 损益余额已归零（没有待结转内容）`)
  eq('演示库该期间的结转账是 posted', db.prepare('SELECT status FROM vouchers WHERE id=?').get(carriedDemo.closing_voucher_id)?.status, 'posted')
  const a = R.auditReport(db, { period: carriedDemo.period })
  ok(a.ok, `演示库 ${carriedDemo.period} 自证通过`, JSON.stringify(a.problems.map((x) => x.code)))
} else {
  ok(false, '演示库存在一个"真的做过结转"的期间（report-seed 的 CARRY_PERIODS）—— 否则本批在演示环境里看不见效果')
}

eq('测试凭证一行都没留下（全部活在事务里）', db.prepare("SELECT COUNT(*) c FROM vouchers WHERE doc_no LIKE '__test_closing__%'").get().c, 0)
eq('测试期间一行都没留下', db.prepare("SELECT COUNT(*) c FROM accounting_periods WHERE period LIKE '1901-%'").get().c, 0)
eq('结转账只剩演示 seed 的那一张', db.prepare("SELECT COUNT(*) c FROM vouchers WHERE biz_type='profit_carry'").get().c, carriedDemo ? 1 : 0)
const finalAudit = R.auditReport(db, { period: carriedDemo?.period || '2026-10' })
ok(finalAudit.ok, '收尾：演示库报表自证仍然通过（没被测试改坏）', JSON.stringify(finalAudit.problems.map((x) => x.message)))

// ===========================================================================
console.log(`\n${'─'.repeat(72)}`)
console.log(`期末结转与结账（${INDUSTRY}）：通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  failures.forEach((f) => console.log(`  - ${f}`))
}
db.close()
process.exit(fail === 0 ? 0 : 1)
