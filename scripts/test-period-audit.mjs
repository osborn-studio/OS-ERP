/**
 * ============================================================================
 * 文件标识：scripts/test-period-audit.mjs ｜ 测试：批次 Q：期间审计链（关账 / 结转 / 年结 / 分配的每一次变更都留一条可重放的记录）
 * ============================================================================
 * 【职责】测试：批次 Q：期间审计链（关账 / 结转 / 年结 / 分配的每一次变更都留一条可重放的记录）
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
 * 批次 Q：期间审计链（关账 / 结转 / 年结 / 分配的每一次变更都留一条可重放的记录）
 *
 * 这一批补的不是"算得对"，而是「**现在这个样子能不能由来路解释得出来**」。
 * 期间表上的列是**现状指针**（做一次反关账就把 `closed_by` 清掉，历史随之消失），
 * 审计日志是**历史事实**（只追加）。两者之间有一条可验证的不变量：
 *
 *     从空状态开始，按 id 顺序应用每一条日志，得到的必须等于期间表的现状。
 *
 * 所以本文件的重点**不是**"日志写下来了"，而是三件事：
 *   ① 八个动作**每一个**都真的写日志（少一个，重放就对不上）；
 *   ② 日志与账 **同事务**（断言 `db.inTransaction`，不是文档里的一句建议）；
 *   ③ 三条互证路径**来源不同**（期间表字段 / 凭证表 / 日志），
 *      否则它们会一起错、一起不响（批次 P 的教训：先问两条路径**共享**什么）。
 *
 * 与其它域同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-period-audit.mjs [cosmetic|food|apparel]
 *
 * 可重复跑 + 不留副作用：自造的是 **2024 年**，全部写操作包在 `BEGIN … ROLLBACK` 里，
 * Q14 断言真表**一行都不多**（含审计日志表本身）。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import * as R from '../server/lib/report.js'
import * as A from '../server/lib/accounting.js'
import * as C from '../server/lib/closing.js'
import * as N from '../server/lib/annual.js'
import * as Q from '../server/lib/period-audit.js'

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
    console.log(`  \x1b[31m✗\x1b[0m ${msg}${detail !== undefined ? `  → ${String(detail).slice(0, 300)}` : ''}`)
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
const actor = { id: null, name: 'test-audit', source: 'web' }
const money = (v) => Math.round((Number(v) || 0) * 100) / 100

console.log(`=== 期间审计链测试（${INDUSTRY}） ===`)

const Y = '2024'
const base = {
  vouchers: db.prepare('SELECT COUNT(*) c FROM vouchers').get().c,
  entries: db.prepare('SELECT COUNT(*) c FROM voucher_entries').get().c,
  periods: db.prepare('SELECT COUNT(*) c FROM accounting_periods').get().c,
  subjects: db.prepare('SELECT COUNT(*) c FROM accounting_subjects').get().c,
  log: db.prepare('SELECT COUNT(*) c FROM period_audit_log').get().c,
  // 演示库本身就有派生凭证（seed 在 2026-07 真做过一次期末结转），
  // 所以"残留"要跟**开工时的数量**比，而不是跟 0 比
  derived: db.prepare("SELECT COUNT(*) c FROM vouchers WHERE biz_type IN ('profit_carry','annual_carry','profit_distribution')").get().c
}

let seq = 93000
function makeVoucher({ period, date, lines, label }) {
  seq += 1
  const v = A.persistVoucher(db, {
    biz_type: 'test_audit', source_type: 'test_audit', source_id: seq, source_doc_no: label,
    voucher_date: date, period, lines, label
  }, { actor })
  A.postVoucher(db, { id: v.id, actor })
  return v
}
const logsOf = (p) => db.prepare('SELECT * FROM period_audit_log WHERE period=? ORDER BY id').all(p)
const actionCount = () => {
  const m = new Map()
  for (const r of db.prepare('SELECT action, COUNT(*) c FROM period_audit_log GROUP BY action').all()) m.set(r.action, r.c)
  return m
}
/** 在一个嵌套事务里做破坏性动作，跑完自动回滚（测试不留副作用） */
function inSavepoint(fn) {
  try {
    db.transaction(() => {
      fn()
      throw new Error('__ROLLBACK__')
    })()
  } catch (e) {
    if (e.message !== '__ROLLBACK__') throw e
  }
}

// ===========================================================================
section('Q1 动作表是「动作 ↔ 效果」的唯一出处')
{
  const acts = Q.PERIOD_ACTIONS
  // 八个动作必须齐（少一个就意味着某个动作没接上日志，而那会被重放抓到）
  const must = ['period_close', 'period_reopen', 'profit_carry', 'carry_reverse', 'annual_carry', 'annual_reverse', 'profit_distribution', 'dist_reverse']
  eq('八个动作全部登记', must.filter((a) => acts[a]).sort(), [...must].sort())
  ok(acts.baseline, '基线条目也在白名单里（否则"未知动作"探针会把自己报成异常）')

  // effect 的键必须落在已知的四个状态键或 spread_year 上 —— 写错键名不会报错，
  // 只会让那个动作的效果**永远不被应用**（重放时安静地少改一个字段）
  const legal = new Set([...Q.PERIOD_STATE_KEYS, 'spread_year'])
  const badKeys = []
  for (const [k, v] of Object.entries(acts)) {
    if (v.effect === 'snapshot') continue
    for (const ek of Object.keys(v.effect || {})) if (!legal.has(ek)) badKeys.push(`${k}.${ek}`)
  }
  eq('所有 effect 的键都是合法的状态键', badKeys, [])

  // 撤销类动作必须要求理由（与"作废已过账凭证"同一个道理）
  eq('撤销/反关账类动作都要求理由', [...Q.REASON_REQUIRED_ACTIONS].sort(),
    ['annual_reverse', 'carry_reverse', 'dist_reverse', 'period_reopen'].sort())

  // 年结必须是**唯一**带 spread_year 的动作：如果哪天"结账"也想封整年，那是一次政策变更，
  // 应该在这里被看见，而不是从某次发布里悄悄生效
  eq('只有年度结转会扩散到整年', Object.entries(acts).filter(([, v]) => v.effect && v.effect.spread_year).map(([k]) => k), ['annual_carry'])

  // 年维度动作与期间维度动作的分工
  eq('年维度动作只有四个', Object.entries(acts).filter(([, v]) => v.scope === 'year').map(([k]) => k).sort(),
    ['annual_carry', 'annual_reverse', 'dist_reverse', 'profit_distribution'].sort())
}

// ===========================================================================
section('Q2 唯一写入点的三道当场断言')
{
  const before = db.prepare('SELECT COUNT(*) c FROM period_audit_log').get().c
  throws(() => Q.logPeriodChange(db, { period: '2026-12', action: 'period_close' }), 'AUDIT_OUTSIDE_TX',
    '事务外写日志被拦下（"账改了、日志没写"的入口被堵死）')

  db.exec('BEGIN')
  try {
    throws(() => Q.logPeriodChange(db, { period: '2026-12', action: 'no_such_action' }), 'UNKNOWN_ACTION',
      '未知动作名被拦下（宁可炸，也不落一条代码解释不了的记录）')
    throws(() => Q.logPeriodChange(db, { period: '2026-12', action: 'carry_reverse' }), 'AUDIT_REASON_REQUIRED',
      '撤销类动作不写理由被拦下')
    throws(() => Q.logPeriodChange(db, { period: '2026-13', action: 'period_close' }), 'BAD_PERIOD',
      '非法期间被拦下（日志的 period 必须是真的期间格式）')
  } finally {
    db.exec('ROLLBACK')
  }
  eq('被拦下的三次尝试一行日志都没落', db.prepare('SELECT COUNT(*) c FROM period_audit_log').get().c, before)
}

// ===========================================================================
section('Q3 基线：只在"升级既有库"时出现；重建的库由真实动作留痕')
{
  const bases = db.prepare("SELECT * FROM period_audit_log WHERE action='baseline' ORDER BY period").all()

  // 基线**不是**每个库都该有的东西，这一点本身要断言清楚：
  //   · 升级一个"已经用过"的库 → 迁移 037 按现状补一条基线（历史动作发生在日志表存在之前）；
  //   · 整库重建出来的库 → **不该有基线**，因为 seed 自己的 `closePeriod` / `carryForward`
  //     就是经 `logPeriodChange` 写下来的真实动作。
  // 两类库都必须满足同一条不变量：**任何"有事可记"的期间都能被日志解释**。
  // 如果只断言"基线必须存在"，重建路径就成了盲区 —— 而它恰好是本批最容易坏的一条路。
  if (bases.length) {
    ok(bases.every((b) => b.actor_source === 'migration'), '基线明确标着来源是 migration（不是某个人的动作）')
    ok(bases.every((b) => /基线/.test(b.action_label) && /不表示任何人的动作/.test(b.reason || '')),
      '基线的措辞写清了"这是现状快照，不是一次动作"')
    ok(true, `本库由升级而来：有 ${bases.length} 条基线（${bases.map((b) => b.period).join('、')}）`)
  } else {
    ok(true, '本库由**重建**而来：没有基线，日志全部来自 seed 的真实动作（迁移只回填既有库）')
  }

  const trail = Q.auditPeriodTrail(db)
  ok(trail.ok, '审计链自洽（重放 = 现状）', trail.problems.map((x) => x.code))
  ok(trail.entries_checked >= bases.length, `自证核了 ${trail.entries_checked} 条记录 / ${trail.periods_checked} 个期间`)

  // 不变量：每个"有事可记"的期间都至少有一条日志（基线或真实动作都算）
  const unexplained = db
    .prepare(`
      SELECT p.period FROM accounting_periods p
       WHERE (p.status <> 'open' OR p.closing_voucher_id IS NOT NULL OR p.annual_voucher_id IS NOT NULL
              OR p.dist_voucher_id IS NOT NULL OR p.reopen_reason IS NOT NULL
              OR p.closing_reverse_reason IS NOT NULL OR p.annual_reverse_reason IS NOT NULL
              OR p.dist_reverse_reason IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM period_audit_log l WHERE l.period = p.period)
    `)
    .all()
    .map((r) => r.period)
  eq('每个"有事可记"的期间都至少有一条日志（否则重放不变量从第一个期间起就不成立）', unexplained, [])

  // 基线只能是**该期间最早**的一条，且一个期间最多一条 ——
  // 基线插在真实动作之后，会让"重放"从中间被整体改写，而它看起来完全正常
  const baselineMisplaced = bases.filter((b) => {
    const first = db.prepare('SELECT MIN(id) m FROM period_audit_log WHERE period=?').get(b.period).m
    return first !== b.id
  }).map((b) => b.period)
  eq('基线是该期间最早的一条', baselineMisplaced, [])
  const dupBaseline = db.prepare("SELECT period FROM period_audit_log WHERE action='baseline' GROUP BY period HAVING COUNT(*)>1").all()
  eq('一个期间最多一条基线', dupBaseline.map((r) => r.period), [])
}

// ===========================================================================
section('Q4 关账 → 反关账 → 关账：三条日志把状态串成一条链')
{
  const P2 = '1902-12' // Before demo opening balances: no inherited uncarried profit.
  db.exec('BEGIN')
  try {
    const rowsBefore = db.prepare('SELECT COUNT(*) c FROM period_audit_log WHERE period=?').get(P2).c
    R.closePeriod(db, { period: P2, actor, remark: '第一次关账' })
    const afterClose = logsOf(P2)
    eq('关账写了 1 条日志', afterClose.length, rowsBefore + 1)
    // `|| {}` 不是防御性编程，是**让反例注入时给出一句可读的红**：
    // 日志若缺失，这里应当红"动作名与状态迁移"，而不是让整份测试崩在一个无关的 `.action` 上
    // （批次 Q 反例 A 现场：崩掉之后 DESYNC 探针根本没跑到，等于证据没取到）
    const l1 = afterClose[afterClose.length - 1] || {}
    eq('动作名与状态迁移', [l1.action, l1.status_before, l1.status_after], ['period_close', 'open', 'closed'])
    eq('关账备注落进日志（不只在期间表上）', l1.remark, '第一次关账')
    eq('关账动作不涉及金额（与"结了 0 元"是两件事）', l1.amount, null)

    R.reopenPeriod(db, { period: P2, actor, reason: '探针改账' })
    const l2 = logsOf(P2).pop() || {}
    eq('反关账动作与状态迁移', [l2.action, l2.status_before, l2.status_after], ['period_reopen', 'closed', 'open'])
    eq('反关账理由落进日志', l2.reason, '探针改账')

    R.closePeriod(db, { period: P2, actor, remark: '第二次关账' })
    const chain = logsOf(P2)
    eq('三次动作 → 三条日志（历史不被覆盖）', chain.length, rowsBefore + 3)
    eq('状态链首尾相接', chain.map((x) => `${x.status_before}→${x.status_after}`),
      [...chain.slice(0, -3).map(() => ''), 'open→closed', 'closed→open', 'open→closed'])

    // ⚠️ 探针断言放在**最前面**（紧跟三次动作）：反例注入时它们必须最先跑出来，
    // 否则一旦上面的细节断言红了、流程断了，最要紧的证据反而没被采集到。
    ok(Q.auditPeriodTrail(db).ok, '这条链自证通过（重放日志 = 期间表现状）',
      Q.auditPeriodTrail(db).problems.map((x) => `${x.code}`))
    ok(R.auditReport(db, { period: P2 }).ok, 'auditReport（含第⑩条）通过',
      R.auditReport(db, { period: P2 }).problems.map((x) => x.code))

    // 期间表只有"最后一次"，日志有全部 —— 这正是本批存在的理由
    const row = db.prepare('SELECT * FROM accounting_periods WHERE period=?').get(P2)
    eq('期间表上是现状', row.status, 'closed')
    eq('期间表只留下最后一次的理由', row.reopen_reason, '探针改账')
    eq('两次关账在日志里都能看到', chain.filter((x) => x.action === 'period_close').length, rowsBefore + 2)

    // 重放 = 现状
    const rp = Q.replayPeriodAudit(db, { period: P2 })
    eq('重放得到的 = 期间表现状', rp.replayed, Q.periodStateOf(db, P2))
    eq('重放用到的就是这个期间的日志', rp.entries.length, chain.length)

    // 反关账把 closed_by 清空这件事本身是对的（指针语义），历史在日志里
    eq('反关账后期间表上的关账人是空的（它是指针，不是历史）', row.closed_by, null)
    ok(chain.some((x) => x.action === 'period_close' && x.actor_name === 'test-audit'),
      '但"谁关的账"在日志里查得到')
  } finally {
    db.exec('ROLLBACK')
  }
  eq('回滚后该期间的日志一条不留', db.prepare('SELECT COUNT(*) c FROM period_audit_log WHERE period=?').get(P2).c, 0)
}

// ===========================================================================
section('Q5 期末结转与撤销：日志里有金额与凭证号（撤销后它是唯一的记录）')
{
  db.exec('BEGIN')
  try {
    makeVoucher({
      period: `${Y}-01`, date: `${Y}-01-31`, label: 'TA-01',
      lines: [
        { seq: 1, summary: '收现', direction: 'debit', amount: 1000, subject_code: '1002' },
        { seq: 2, summary: '收入', direction: 'credit', amount: 1000, subject_code: '6001' }
      ]
    })
    const out = C.carryForward(db, { period: `${Y}-01`, actor, remark: '一月结转' })
    const l1 = logsOf(`${Y}-01`).pop() || {}
    eq('结转日志动作名', l1.action, 'profit_carry')
    eq('结转日志记下凭证号', l1.voucher_doc_no, out.voucher.doc_no)
    eq('结转日志记下凭证指针', l1.closing_voucher_id, out.voucher.id)
    okNear(l1.amount, 1000, '结转日志记下结转金额 1000')
    eq('结转不改期间状态（status_after 为空 = 本动作不动状态）', l1.status_after, null)
    eq('重放得到"已结转"', Q.replayPeriodAudit(db, { period: `${Y}-01` }).replayed.closing_voucher_id, out.voucher.id)
    // 探针紧跟结转（而不是排在关账之后）：反例注入时它必须最先跑出来。
    // 关账会先被自证拦住并抛错，排在它后面的断言就再也跑不到了 ——
    // 那样最要紧的证据（"这张票没人认领"）只能从异常栈里读，而不该如此。
    const t5 = Q.auditPeriodTrail(db)
    ok(t5.ok, '结转之后审计链自证通过（重放对得上 + 这张票有人认领）', t5.problems.map((x) => x.code))

    R.closePeriod(db, { period: `${Y}-01`, actor })

    // 撤销之前先反关账 —— 顺序是设计的一部分，顺便证明它真的会拦
    throws(() => C.reverseClosing(db, { period: `${Y}-01`, actor, reason: '要先反关账' }), 'PERIOD_CLOSED',
      '已关账期间不许撤销结转（撤销必须先反关账）')
    R.reopenPeriod(db, { period: `${Y}-01`, actor, reason: '调整一月' })
    const rev = C.reverseClosing(db, { period: `${Y}-01`, actor, reason: '一月结错了' })
    const l2 = logsOf(`${Y}-01`).pop() || {}
    eq('撤销结转日志动作名', l2.action, 'carry_reverse')
    eq('撤销结转日志记下理由', l2.reason, '一月结错了')
    okNear(l2.amount, rev.removed?.total_debit, '撤销日志保留了被删凭证的金额（凭证已经不在了）')
    eq('撤销日志记下被删凭证号', l2.voucher_doc_no, rev.removed?.doc_no)
    eq('重放得到"未结转"', Q.replayPeriodAudit(db, { period: `${Y}-01` }).replayed.closing_voucher_id, null)
    eq('重放 = 现状', Q.replayPeriodAudit(db, { period: `${Y}-01` }).replayed, Q.periodStateOf(db, `${Y}-01`))
    ok(Q.auditPeriodTrail(db).ok, '结转→撤销链自证通过', Q.auditPeriodTrail(db).problems.map((x) => x.code))
  } finally {
    db.exec('ROLLBACK')
  }
}

// ===========================================================================
section('Q6 自造 2024 完整年结链：11 次关账 + 3 次结转 + 1 次年结全部留痕')
{
  db.exec('BEGIN')
  try {
    // ⚠️ 顺序很要紧：**每月"先记、再结转、再关账"**。
    // 不能先把 1、2 月的凭证都造好再逐月关 —— 那样在"关 1 月"的这一刻，
    // 2 月的损益（6401 +400）还没结转，它会随**期初滚动**漏进演示年度：
    // 2026-04 的期末余额里会凭空多出 6401，而 food 库恰好有一个"已关账未结转"的历史期间，
    // 于是探针在**别人的账上**报红（批次 P 缺陷一百五十八：造数的范围与断言的范围要一样大）。
    // 先记再结再关，任何时刻 6xxx 的净额都是 0，沙箱就真的围起来了。
    const monthClose = (m, lines) => {
      const p = `${Y}-${String(m).padStart(2, '0')}`
      if (lines) {
        makeVoucher({ period: p, date: `${p}-28`, label: `TA-${String(m).padStart(2, '0')}`, lines })
        C.carryForward(db, { period: p, actor })
      }
      R.closePeriod(db, { period: p, actor })
    }
    monthClose(1, [
      { seq: 1, summary: '收现', direction: 'debit', amount: 1000, subject_code: '1002' },
      { seq: 2, summary: '收入', direction: 'credit', amount: 1000, subject_code: '6001' }
    ])
    monthClose(2, [
      { seq: 1, summary: '成本', direction: 'debit', amount: 400, subject_code: '6401' },
      { seq: 2, summary: '付款', direction: 'credit', amount: 400, subject_code: '1002' }
    ])
    for (let m = 3; m <= 11; m += 1) monthClose(m, null)
    makeVoucher({
      period: `${Y}-12`, date: `${Y}-12-31`, label: 'TA-12',
      lines: [
        { seq: 1, summary: '费用', direction: 'debit', amount: 200, subject_code: '6602' },
        { seq: 2, summary: '付款', direction: 'credit', amount: 200, subject_code: '1002' }
      ]
    })
    C.carryForward(db, { period: `${Y}-12`, actor })
    const pre = N.annualPrecheck(db, { year: Y })
    ok(pre.ok, '年结前置通过（全年已月结）', (pre.problems || []).map((x) => x.code))

    const ca = N.carryForwardAnnual(db, { year: Y, actor, remark: '年结' })
    // 按**期间年份**取，而不是按 `scope_key` —— 期间维度的动作（关账/结转）
    // 的 `scope_key` 是 'YYYY-MM'，只按 scope_key 查会把它们全漏掉（本批修过的一个真实缺口）。
    const yLogs = db.prepare("SELECT * FROM period_audit_log WHERE substr(period,1,4)=? ORDER BY id").all(Y)
    eq('这一年共 11 关账 + 3 结转 + 1 年结 = 15 条记录', yLogs.length, 15)
    const dist = {}
    for (const r of yLogs) dist[r.action] = (dist[r.action] || 0) + 1
    eq('动作分布', Object.entries(dist).sort().map(([k, v]) => `${k}=${v}`).join(','),
      'annual_carry=1,period_close=11,profit_carry=3')

    const al = yLogs.pop() || {}
    eq('年结日志：动作名 / 维度 / 挂在年末期间', [al.action, al.scope, al.period, al.scope_key], ['annual_carry', 'year', `${Y}-12`, Y])
    eq('年结日志记下凭证指针', al.annual_voucher_id, ca.voucher.id)
    okNear(al.amount, 400, '年结日志记下年结金额（收入 1000 − 成本 400 − 费用 200 = 400）')
    const detail = al.detail ? JSON.parse(al.detail) : {}
    eq('年结日志记下"这一次封了几期"', detail.closed_periods, ca.closed_periods)

    // 年结重放：12 月拿到年结指针，而**整年每一期**都应当是已关账
    const decState = Q.replayPeriodAudit(db, { period: `${Y}-12` }).replayed
    eq('重放：12 月已关账且挂着年结指针', [decState.period_status, decState.annual_voucher_id], ['closed', ca.voucher.id])
    const janState = Q.replayPeriodAudit(db, { period: `${Y}-01` }).replayed
    eq('重放：1 月（非 12 月）也被年结封成已关账', janState.period_status, 'closed')
    eq('重放：1 月**不会**拿到别人的年结指针（指针只挂年末那一行）', janState.annual_voucher_id, null)
    eq('年结后每一期的重放都等于现状', db.prepare("SELECT period FROM accounting_periods WHERE substr(period,1,4)=?").all(Y)
      .every((r) => JSON.stringify(Q.replayPeriodAudit(db, { period: r.period }).replayed) === JSON.stringify(Q.periodStateOf(db, r.period))), true)

    const trail = Q.auditPeriodTrail(db)
    ok(trail.ok, '完整年结链自证通过', trail.problems.map((x) => x.code))
    ok(trail.years_checked >= 1, `自证覆盖了 ${trail.years_checked} 个已年结年度`)
  } finally {
    db.exec('ROLLBACK')
  }
}

// ===========================================================================
section('Q7 利润分配：日志记下总额，并指明凭证落在次年')
{
  db.exec('BEGIN')
  try {
    makeVoucher({
      period: `${Y}-01`, date: `${Y}-01-31`, label: 'TA-01',
      lines: [
        { seq: 1, summary: '收现', direction: 'debit', amount: 1000, subject_code: '1002' },
        { seq: 2, summary: '收入', direction: 'credit', amount: 1000, subject_code: '6001' }
      ]
    })
    for (let m = 1; m <= 11; m += 1) {
      const p = `${Y}-${String(m).padStart(2, '0')}`
      if (m === 1) C.carryForward(db, { period: p, actor })
      R.closePeriod(db, { period: p, actor })
    }
    // 12 月在本用例里没有发生额 ⇒ 无需结转（空期间不结转也能关账），年结会把它一并封上
    N.carryForwardAnnual(db, { year: Y, actor })

    const out = N.distributeProfit(db, {
      year: Y, actor, remark: '股东会决议',
      items: [
        { subject_code: '4105', amount: 300, label: '提取盈余公积' },
        { subject_code: '2232', amount: 500, label: '分配股利' }
      ]
    })
    const dl = logsOf(`${Y}-12`).pop() || {}
    eq('分配日志：动作名 / 维度 / 挂在年末期间', [dl.action, dl.scope, dl.period], ['profit_distribution', 'year', `${Y}-12`])
    okNear(dl.amount, 800, '分配日志记下总额 800')
    eq('分配日志记下凭证指针', dl.dist_voucher_id, out.voucher.id)
    const dd = dl.detail ? JSON.parse(dl.detail) : {}
    eq('分配日志记下凭证落在哪一期（次年）', dd.voucher_period, `${Number(Y) + 1}-01`)
    eq('分配日志记下明细', (dd.items || []).map((x) => `${x.subject_code}:${x.amount}`).join(','), '4105:300,2232:500')
    eq('重放得到"已分配"', Q.replayPeriodAudit(db, { period: `${Y}-12` }).replayed.dist_voucher_id, out.voucher.id)
    ok(Q.auditPeriodTrail(db).ok, '分配链自证通过', Q.auditPeriodTrail(db).problems.map((x) => x.code))
  } finally {
    db.exec('ROLLBACK')
  }
}

// ===========================================================================
section('Q8 撤销链（撤分配 → 撤年结）：顺序被强制，且每次撤销都留理由')
{
  db.exec('BEGIN')
  try {
    makeVoucher({
      period: `${Y}-01`, date: `${Y}-01-31`, label: 'TA-01',
      lines: [
        { seq: 1, summary: '收现', direction: 'debit', amount: 1000, subject_code: '1002' },
        { seq: 2, summary: '收入', direction: 'credit', amount: 1000, subject_code: '6001' }
      ]
    })
    for (let m = 1; m <= 11; m += 1) {
      const p = `${Y}-${String(m).padStart(2, '0')}`
      if (m === 1) C.carryForward(db, { period: p, actor })
      R.closePeriod(db, { period: p, actor })
    }
    // 12 月在本用例里没有发生额 ⇒ 无需结转（空期间不结转也能关账），年结会把它一并封上
    N.carryForwardAnnual(db, { year: Y, actor })
    N.distributeProfit(db, { year: Y, actor, items: [{ subject_code: '4105', amount: 300, label: '公积' }] })

    throws(() => N.reverseAnnual(db, { year: Y, actor, reason: '想直接撤年结' }), 'REVERSE_DISTRIBUTION_FIRST',
      '还有分配时不许撤年结（下游的金额会失去依据）')

    N.reverseDistribution(db, { year: Y, actor, reason: '决议变更' })
    const dl = logsOf(`${Y}-12`).pop() || {}
    eq('撤销分配日志', [dl.action, dl.reason], ['dist_reverse', '决议变更'])
    eq('撤销分配把指针清空', dl.dist_voucher_id, null)

    N.reverseAnnual(db, { year: Y, actor, reason: '年结口径要改' })
    const al = logsOf(`${Y}-12`).pop() || {}
    eq('撤销年结日志', [al.action, al.reason], ['annual_reverse', '年结口径要改'])
    eq('撤销年结**不**把整年重开（政策，不是随手）', (al.detail ? JSON.parse(al.detail) : {}).reopened_year, false)

    // 撤销之后重放必须仍然等于现状 —— 撤销"不动状态"这件事也要被日志表达出来
    for (const r of db.prepare("SELECT period FROM accounting_periods WHERE substr(period,1,4)=?").all(Y)) {
      eq(`${r.period} 撤销后重放 = 现状`, Q.replayPeriodAudit(db, { period: r.period }).replayed, Q.periodStateOf(db, r.period))
    }
    const trail = Q.auditPeriodTrail(db)
    ok(trail.ok, '撤销链自证通过', trail.problems.map((x) => x.code))
    // 已撤销的年度不再承诺"整年关账"——探针⑥必须认得这件事，否则它会对着一个正确的状态报红
    ok(!trail.problems.some((x) => x.code === 'PERIOD_AUDIT_YEAR_GAP'), '撤销年结后不再报"整年关账缺口"')
  } finally {
    db.exec('ROLLBACK')
  }
}

// ===========================================================================
section('Q9 反向核对（注入日志，不动库）：五类失效各自被认出来')
{
  // 拿一份真实的日志快照做底，再按失效方式各改一处
  const real = db.prepare('SELECT * FROM period_audit_log ORDER BY id').all()
  ok(real.length > 0, `取到 ${real.length} 条真实日志做底`)

  // ① 摘掉最后一条日志（模拟"动作改了状态但没写日志"）
  const dropLast = real.slice(0, -1)
  const t1 = Q.auditPeriodTrail(db, { log: dropLast })
  ok(t1.problems.some((p) => p.code === 'PERIOD_AUDIT_DESYNC'),
    '摘掉一条日志 → PERIOD_AUDIT_DESYNC 响（重放不出现在的样子）', t1.problems.map((x) => x.code))

  // ② 把一条日志的期间改错（模拟"日志写到了别人名下"）
  //    目标优先取基线（它一定"有事在身"），重建的库里没有基线就取第一条 ——
  //    断言不该依赖"这个库恰好有基线"（批次 P 缺陷一百五十八：断言的作用域别超过造数范围）
  const target = real.find((r) => r.action === 'baseline') || real[0]
  const moved = real.map((r) => (r.id === target.id ? { ...r, period: '2030-01' } : r))
  const t2 = Q.auditPeriodTrail(db, { log: moved })
  ok(t2.problems.some((p) => p.code === 'PERIOD_AUDIT_DESYNC'),
    '日志被挂到别的期间 → 原期间重放不出、新期间多出一条 → DESYNC 响', t2.problems.map((x) => x.code))
  ok(!t2.ok, '整体不通过')

  // ③ 未知动作（模拟"有人绕过唯一写入点手写了一条"）
  const unknown = [...real, { id: 999999, period: '2026-01', action: 'someone_handwrote_this', action_label: '?', scope: 'period', scope_key: '2026-01', status_before: null, status_after: null, closing_voucher_id: null, annual_voucher_id: null, dist_voucher_id: null, reason: null }]
  const t3 = Q.auditPeriodTrail(db, { log: unknown })
  ok(t3.problems.some((p) => p.code === 'PERIOD_AUDIT_UNKNOWN_ACTION'),
    '陌生动作名 → PERIOD_AUDIT_UNKNOWN_ACTION 响', t3.problems.map((x) => x.code))

  // ④ 撤销类动作丢了理由 / ⑤ 期间表有留痕却没有对应日志
  //    —— 这两类都必须在**造过一次真实动作之后**才成立：
  //    演示库（重建而来）只有 period_close + profit_carry，**没有任何撤销类记录**；
  //    拿一个不存在的场景去"跳过"，等于这一条永久不跑（"不适用"与"通过"在输出上完全一样）。
  db.exec('BEGIN')
  try {
    const P3 = '1902-12'
    R.closePeriod(db, { period: P3, actor })
    R.reopenPeriod(db, { period: P3, actor, reason: '注入用例' })
    const real2 = db.prepare('SELECT * FROM period_audit_log ORDER BY id').all()
    const reopenRow = real2.find((r) => r.period === P3 && r.action === 'period_reopen')
    ok(!!reopenRow && Q.PERIOD_ACTIONS.period_reopen.requires_reason === true,
      '造出了一条撤销类记录（period_reopen），第 ④ 类注入才有对象')

    // ④ 把理由抹掉
    const noReason = real2.map((r) => (r.id === reopenRow.id ? { ...r, reason: '' } : r))
    const t4 = Q.auditPeriodTrail(db, { log: noReason })
    ok(t4.problems.some((p) => p.code === 'PERIOD_AUDIT_REASON_REQUIRED'),
      '撤销类日志没有理由 → PERIOD_AUDIT_REASON_REQUIRED 响', t4.problems.map((x) => x.code))

    const withoutReopen = real2.filter((r) => !(r.period === P3 && r.action === 'period_reopen'))
    const t5 = Q.auditPeriodTrail(db, { log: withoutReopen })
    ok(t5.problems.some((p) => p.code === 'PERIOD_AUDIT_MISSING'),
      '期间表有 reopen_reason、日志里没有对应的 period_reopen → PERIOD_AUDIT_MISSING 响', t5.problems.map((x) => x.code))
    ok(t5.problems.some((p) => p.code === 'PERIOD_AUDIT_DESYNC'),
      '同一状态下 DESYNC 也响（两条探针覆盖不同的失效方式：一个看状态，一个看留痕）')
    // 完整日志下必须干净 —— 否则上面两条只是"探针永远在响"
    ok(Q.auditPeriodTrail(db, { log: real2 }).ok, '把日志补全后自证通过（证明上面不是恒真）')
  } finally {
    db.exec('ROLLBACK')
  }

  // ⑥ 注入不改库
  eq('所有注入都是纯函数行为，库里日志条数没变', db.prepare('SELECT COUNT(*) c FROM period_audit_log').get().c, real.length)
}

// ===========================================================================
section('Q10 派生凭证孤儿：这条路径**完全不读期间表**')
{
  db.exec('BEGIN')
  try {
    makeVoucher({
      period: `${Y}-01`, date: `${Y}-01-31`, label: 'TA-01',
      lines: [
        { seq: 1, summary: '收现', direction: 'debit', amount: 1000, subject_code: '1002' },
        { seq: 2, summary: '收入', direction: 'credit', amount: 1000, subject_code: '6001' }
      ]
    })
    const out = C.carryForward(db, { period: `${Y}-01`, actor })
    ok(Q.auditPeriodTrail(db).ok, '结转之后审计链自洽')

    // 把这条结转日志删掉（只留凭证），账与指针都还在 ——
    // 重放会响 DESYNC，但"凭证孤儿"这条要独立地把"账上有票、没人认领"说出来
    inSavepoint(() => {
      db.prepare("DELETE FROM period_audit_log WHERE action='profit_carry' AND closing_voucher_id=?").run(out.voucher.id)
      const t = Q.auditPeriodTrail(db)
      ok(t.problems.some((p) => p.code === 'PERIOD_AUDIT_VOUCHER_ORPHAN'),
        '有派生凭证但日志被删 → PERIOD_AUDIT_VOUCHER_ORPHAN 响', t.problems.map((x) => x.code))
      ok(t.problems.some((p) => p.code === 'PERIOD_AUDIT_DESYNC'), '同一状态下 DESYNC 也响（两条探针覆盖不同失效方式）')
    })
    ok(Q.auditPeriodTrail(db).ok, '嵌套事务回滚后恢复自洽')
  } finally {
    db.exec('ROLLBACK')
  }
}

// ===========================================================================
section('Q11 年结封整年：把某一期偷偷开回来，探针⑥必须响')
{
  db.exec('BEGIN')
  try {
    makeVoucher({
      period: `${Y}-01`, date: `${Y}-01-31`, label: 'TA-01',
      lines: [
        { seq: 1, summary: '收现', direction: 'debit', amount: 1000, subject_code: '1002' },
        { seq: 2, summary: '收入', direction: 'credit', amount: 1000, subject_code: '6001' }
      ]
    })
    for (let m = 1; m <= 11; m += 1) {
      const p = `${Y}-${String(m).padStart(2, '0')}`
      if (m === 1) C.carryForward(db, { period: p, actor })
      R.closePeriod(db, { period: p, actor })
    }
    // 12 月在本用例里没有发生额 ⇒ 无需结转（空期间不结转也能关账），年结会把它一并封上
    N.carryForwardAnnual(db, { year: Y, actor })
    ok(Q.auditPeriodTrail(db).ok, '年结后自洽（整年都关着）')

    // 绕过 `reopenPeriod` 直接改状态 —— 模拟"有人用 SQL 打开了旧年度"。
    // 重放**抓不到**它（日志里没有这条 reopen，但期间表也不该被重放影响……
    // 不，重放会得到 closed 而现状是 open ⇒ DESYNC 会响）。
    inSavepoint(() => {
      db.prepare("UPDATE accounting_periods SET status='open' WHERE period=?").run(`${Y}-03`)
      const t = Q.auditPeriodTrail(db)
      ok(t.problems.some((p) => p.code === 'PERIOD_AUDIT_DESYNC'),
        '偷偷开回 3 月 → 重放（closed）≠ 现状（open）→ DESYNC 响', t.problems.map((x) => x.code))
      ok(t.problems.some((p) => p.code === 'PERIOD_AUDIT_YEAR_GAP'),
        '年结承诺"封整年" → PERIOD_AUDIT_YEAR_GAP 响（重放看不见"3 月还开着"）', t.problems.map((x) => x.code))
    })
    ok(Q.auditPeriodTrail(db).ok, '嵌套事务回滚后恢复自洽')
  } finally {
    db.exec('ROLLBACK')
  }
}

// ===========================================================================
section('Q12 auditReport 第⑩条真的在跑（不是一页写好看的注释）')
{
  db.exec('BEGIN')
  try {
    makeVoucher({
      period: `${Y}-01`, date: `${Y}-01-31`, label: 'TA-01',
      lines: [
        { seq: 1, summary: '收现', direction: 'debit', amount: 1000, subject_code: '1002' },
        { seq: 2, summary: '收入', direction: 'credit', amount: 1000, subject_code: '6001' }
      ]
    })
    C.carryForward(db, { period: `${Y}-01`, actor })
    const a = R.auditReport(db, { period: `${Y}-01` })
    eq('auditReport 回报了它核过多少条变更记录', a.trail_checked, db.prepare('SELECT COUNT(*) c FROM period_audit_log').get().c)
    ok(a.ok, '账与历史都自洽')

    // 破坏一条日志 → **任何一期**的 auditReport 都要变红（全库扫描，不是只看这一期）
    inSavepoint(() => {
      db.prepare("DELETE FROM period_audit_log WHERE action='profit_carry'").run()
      const a2 = R.auditReport(db, { period: '2026-10' }) // 注意：查的是**别的期间**
      ok(a2.problems.some((p) => p.code === 'PERIOD_AUDIT_VOUCHER_ORPHAN' || p.code === 'PERIOD_AUDIT_DESYNC'),
        '日志缺一条 → 查**别的期间**也会红（全库扫描；只在点开那一期才跑的探针等于不跑）', a2.problems.map((x) => x.code))

      // 关账前置会因此拦住关账 —— "账没留痕"与"账不平"同等对待
      throws(() => R.closePeriod(db, { period: `${Y}-02`, actor }), 'PERIOD_NOT_BALANCED',
        '审计链不自洽时关账会被拦（第⑩条接在关账前置上）')
    })
    ok(R.auditReport(db, { period: `${Y}-01` }).ok, '回滚后恢复自洽')
  } finally {
    db.exec('ROLLBACK')
  }
}

// ===========================================================================
section('Q13 查询：按期间 / 按年 / 按动作')
{
  db.exec('BEGIN')
  try {
    makeVoucher({
      period: `${Y}-01`, date: `${Y}-01-31`, label: 'TA-01',
      lines: [
        { seq: 1, summary: '收现', direction: 'debit', amount: 1000, subject_code: '1002' },
        { seq: 2, summary: '收入', direction: 'credit', amount: 1000, subject_code: '6001' }
      ]
    })
    C.carryForward(db, { period: `${Y}-01`, actor })
    R.closePeriod(db, { period: `${Y}-01`, actor })
    R.closePeriod(db, { period: `${Y}-02`, actor })

    const byPeriod = Q.listPeriodAudit(db, { period: `${Y}-01` })
    eq('按期间查：三条（结转 + 关账 + …… 不含别的期间）', byPeriod.rows.map((r) => r.action).sort(), ['period_close', 'profit_carry'])
    ok(byPeriod.rows.every((r) => r.period === `${Y}-01`), '按期间查不会串期')

    const byYear = Q.listPeriodAudit(db, { year: Y })
    // ⚠️ 这条断言是本批修过的一个真实缺口：只匹配 `scope_key` 的话，
    // "2024 年做过什么"只会返回年度动作，把 11 次关账全漏掉
    ok(byYear.total >= 3, `按年查返回 ${byYear.total} 条（含期间维度的关账，不只是年度动作）`)
    ok(byYear.rows.some((r) => r.scope === 'period') && byYear.rows.some((r) => r.period === `${Y}-02`),
      '按年查把这一年的期间动作也带上了')

    const byAction = Q.listPeriodAudit(db, { action: 'period_close' })
    ok(byAction.rows.every((r) => r.action === 'period_close'), '按动作查只返回该动作')
    eq('筛选后 total 反映的是筛选后的总数', byAction.total, byAction.rows.length)

    // 排序与截断：最新在前、截断时有明确标志
    const lim = Q.listPeriodAudit(db, { year: Y, limit: 2 })
    eq('limit 生效', lim.rows.length, 2)
    eq('截断有明确标志（如实说"还有更多"，不假装看全了）', lim.truncated, true)
    ok(lim.rows[0].id > lim.rows[1].id, '最新在前')

    // 行上带的派生字段：人读需要它，且它由日志本身派生（不是第二份定义）
    const row = Q.listPeriodAudit(db, { year: Y }).rows[0]
    ok(typeof row.action_label === 'string' && row.action_label.length > 0, '每行都带动作中文名')
    eq('期间维度动作的 scope_label', row.scope_label, row.scope === 'year' ? '年度动作' : '期间动作')

    // meta 的动作清单带计数（界面据此生成筛选器，不会"少一个选项"）
    const m = Q.meta(db)
    eq('meta 里有八个动作 + 基线', m.actions.length, 9)
    ok(m.actions.every((x) => typeof x.count === 'number'), '每个动作都带当前条数')
    ok(m.actions.find((x) => x.value === 'period_close').count >= 2, '关账计数 ≥ 2')
  } finally {
    db.exec('ROLLBACK')
  }
}

// ===========================================================================
section('Q14 无副作用：真表一行都不多')
{
  const after = {
    vouchers: db.prepare('SELECT COUNT(*) c FROM vouchers').get().c,
    entries: db.prepare('SELECT COUNT(*) c FROM voucher_entries').get().c,
    periods: db.prepare('SELECT COUNT(*) c FROM accounting_periods').get().c,
    subjects: db.prepare('SELECT COUNT(*) c FROM accounting_subjects').get().c,
    log: db.prepare('SELECT COUNT(*) c FROM period_audit_log').get().c
  }
  eq('凭证数不变', after.vouchers, base.vouchers)
  eq('分录数不变', after.entries, base.entries)
  eq('期间数不变', after.periods, base.periods)
  eq('科目数不变', after.subjects, base.subjects)
  eq('**审计日志表**一行都不多', after.log, base.log)
  eq('没有残留自造年度', db.prepare("SELECT COUNT(*) c FROM accounting_periods WHERE substr(period,1,4)='2024'").get().c, 0)
  eq('没有残留测试凭证', db.prepare("SELECT COUNT(*) c FROM vouchers WHERE biz_type='test_audit'").get().c, 0)
  eq('派生凭证数与开工时一致（测试没有多留下一张结转账）',
    db.prepare("SELECT COUNT(*) c FROM vouchers WHERE biz_type IN ('profit_carry','annual_carry','profit_distribution')").get().c, base.derived)
  ok(Q.auditPeriodTrail(db).ok, '收尾：审计链仍然自洽')
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) console.log(`失败项：\n  - ${failures.slice(0, 12).join('\n  - ')}`)
process.exit(fail === 0 ? 0 : 1)
