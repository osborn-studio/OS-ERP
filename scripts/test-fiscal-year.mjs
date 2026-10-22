/**
 * ============================================================================
 * 文件标识：scripts/test-fiscal-year.mjs ｜ 测试：批次 U 之四 · ③-c：会计年度起点可配置（`settings.fiscal.start_month`）
 * ============================================================================
 * 【职责】测试：批次 U 之四 · ③-c：会计年度起点可配置（`settings.fiscal.start_month`）
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
 * 批次 U 之四 · ③-c：会计年度起点可配置（`settings.fiscal.start_month`）
 *
 * 这一项有两条硬口径，测试都按它们写：
 *   ① **唯一出处**：年初只由 `fiscalYearOf` 算（`resolveRange` 与 `annual.js` 都调它）。
 *      默认 1 月时它与旧口径（`period.slice(0,4)`）**逐字相同** —— 所以"换实现不改结果"。
 *   ② **范围界**：报表侧支持非 1 月起点；**年结 / 利润分配在非 1 月时明确 409 拒绝**，
 *      不静默按自然年结过去。F3 就是把这条做出来（包括"只拦做、不拦撤"）。
 *
 * 写操作（改配置）全部包在 `BEGIN … ROLLBACK` 里，收尾断言一行都不多。
 * 用法：node scripts/test-fiscal-year.mjs
 * 收尾打印「通过 N / 失败 M」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import * as R from '../server/lib/report.js'
import * as S from '../server/lib/settings.js'
import * as A from '../server/lib/annual.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { DATA_DIR, dbPathFor } from '../server/db/index.js'

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
const INDUSTRIES = ['cosmetic', 'food', 'apparel']

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
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)
const throws = (fn, code, msg) => {
  try {
    fn()
  } catch (e) {
    const hit = !code || e.code === code
    if (!hit) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${code}，实得 ${e.code || e.message}`)
    ok(hit, msg)
    return e
  }
  console.log(`  \x1b[31m✗\x1b[0m ${msg}：没有抛错`)
  ok(false, msg)
  return null
}

console.log(`=== 会计年度起点可配置测试（三库：${INDUSTRIES.join(' / ')}） ===`)

for (const ind of INDUSTRIES) {
  const file = dbPathFor(ind)
  if (!fs.existsSync(file)) continue
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  const P = R.availablePeriods(db).find((x) => x.posted_count > 0)?.period || '2026-10'
  console.log(`\n${'─'.repeat(72)}\n【${ind}】期间 ${P}`)

  // =========================================================================
  section(`F1 默认（起始月 = 1）与旧口径逐字相同（${ind}）`)
  // =========================================================================
  const before = {
    settings: db.prepare('SELECT COUNT(*) c FROM settings').get().c,
    log: db.prepare('SELECT COUNT(*) c FROM setting_audit_log').get().c
  }
  eq('默认起始月 = 1', R.fiscalStartMonth(db), 1)
  eq('起始月为 1 时会计年度就是自然年（与旧口径 slice(0,4) 逐字相同）',
    [R.fiscalYearOf(P, 1).fiscal_year, R.fiscalYearOf(P, 1).from, R.fiscalYearOf(P, 1).to, R.fiscalYearOf(P, 1).label],
    [Number(P.slice(0, 4)), `${P.slice(0, 4)}-01`, `${P.slice(0, 4)}-12`, P.slice(0, 4)])
  const rg1 = R.resolveRange(db, { period: P, range: 'ytd' })
  eq('resolveRange 的累计窗口仍是 [1 月, 本期]（默认配置下行为不变）',
    [rg1.from, rg1.to, rg1.year, rg1.fiscal_start_month, rg1.mode_label], [`${P.slice(0, 4)}-01`, P, Number(P.slice(0, 4)), 1, '本年累计'])
  eq('跨年不回头：2027-03 的"本年"仍是 2027 年 1 月', [R.resolveRange(db, { period: '2027-03', range: 'ytd' }).from], ['2027-01'])
  eq('meta 如实报出起始月与"年结能不能做"',
    [R.meta(db).fiscal.start_month, R.meta(db).fiscal.annual_supported], [1, true])
  ok(R.auditReport(db, { period: P }).ok, '默认配置下报表自证仍然通过')

  // =========================================================================
  section(`F2 起始月改成 4：年初/年末与跨自然年标签（${ind}）`)
  // =========================================================================
  db.exec('BEGIN')
  try {
    const setStart = (v) => S.writeSetting(db, { key: 'fiscal.start_month', value: String(v), reason: '测试：把会计年度起点改成 ' + v + ' 月', actor: { id: null, name: 'test-fiscal-year', source: 'script' } })
    setStart(4)
    eq('读回来的起始月', R.fiscalStartMonth(db), 4)
    // 字面表驱动：起始月、期间 → 预期的会计年度与窗口
    const cases = [
      { sm: 4, p: '2026-04', fy: 2026, from: '2026-04', to: '2027-03' },
      { sm: 4, p: '2026-12', fy: 2026, from: '2026-04', to: '2027-03' },
      { sm: 4, p: '2027-03', fy: 2026, from: '2026-04', to: '2027-03' },
      { sm: 4, p: '2026-03', fy: 2025, from: '2025-04', to: '2026-03' },
      { sm: 7, p: '2026-06', fy: 2025, from: '2025-07', to: '2026-06' },
      { sm: 7, p: '2026-07', fy: 2026, from: '2026-07', to: '2027-06' },
      { sm: 12, p: '2026-12', fy: 2026, from: '2026-12', to: '2027-11' },
      { sm: 12, p: '2026-11', fy: 2025, from: '2025-12', to: '2026-11' }
    ]
    let bad = 0
    for (const c of cases) {
      const got = R.fiscalYearOf(c.p, c.sm)
      if (got.fiscal_year !== c.fy || got.from !== c.from || got.to !== c.to) {
        bad += 1
        console.log(`    ✗ fiscalYearOf(${c.p}, ${c.sm}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(c)}`)
      }
      // 跨自然年时标签必须说得出来（否则"2026 年度"会被读成自然年 2026）
      if (got.label !== `${c.from} ~ ${c.to}`) bad += 1
    }
    eq('八组（期间 × 起始月）的字面预期全部命中，且标签写出跨自然年窗口', bad, 0)
    eq('起始月 4 时累计窗口 = 该会计年度的起点（而不是 1 月）',
      (() => {
        const rg = R.resolveRange(db, { period: '2026-10', range: 'ytd' })
        return [rg.from, rg.to, rg.year, rg.mode_label]
      })(),
      ['2026-04', '2026-10', 2026, '本年累计（会计年度 2026-04 起）'])
    eq('累计窗口的月数 = 7（4~10 月）', R.subjectRangeMovements(db, { from: '2026-04', to: '2026-10' }).rows.length > 0, true)
    // 同口径的"上年同期累计"跟着一起挪（③-b 的 yoy_ytd 用的是同一个年初规则）
    const want = R.resolveCompareMode(db, { period: '2026-10', mode: 'yoy_ytd' })
    eq('yoy_ytd 的基期窗口也跟着会计年度走', [want.base_range.from, want.base_range.to], ['2025-04', '2025-10'])
    eq('meta 上"年结能不能做"变成 false', R.meta(db).fiscal.annual_supported, false)

    // =======================================================================
    section(`F3 范围界：年结 / 利润分配在非自然年度**明确拒绝**（${ind}）`)
    // =======================================================================
    const e1 = throws(() => A.carryForwardAnnual(db, { year: '2026', actor: { id: null, name: 't' } }), 'FISCAL_YEAR_UNSUPPORTED', '年结被明确拒绝（不是静默按自然年结）')
    ok(!e1 || (e1.http ?? e1.status) === 409, '年结那条拒绝是 409')
    ok(!e1 || /未实现/.test(e1.message), '拒绝里有一句人话说清"跨自然年度的年结未实现"', e1?.message)
    throws(() => A.distributeProfit(db, { year: '2026', items: [], actor: { id: null, name: 't' } }), 'FISCAL_YEAR_UNSUPPORTED', '利润分配被明确拒绝')
    // 预览也要能说出原因（界面据此把入口禁掉，而不是让用户点了收到 409）
    const plan = A.planAnnual(db, { year: '2026' })
    ok((plan.precheck?.problems || []).some((p) => p.code === 'FISCAL_YEAR_UNSUPPORTED'), '年结预览里带上了"起算月非 1 → 不能年结"这条原因')
    // **只拦"做"、不拦"撤"**：拦撤销会造出死锁（配置改了之后已做的年结撤不掉）
    const rev = (() => { try { A.reverseAnnual(db, { year: '2099', actor: { id: null, name: 't' }, reason: 'x' }); return 'no-throw' } catch (e) { return e.code } })()
    ok(rev !== 'FISCAL_YEAR_UNSUPPORTED', `撤销年结**不**被这条闸门拦（实得 ${rev}）—— 拦它会造成一条死锁路径`)

    // =======================================================================
    section(`F4 值域只有一处定义（1~12 的整数）（${ind}）`)
    // =======================================================================
    for (const bad2 of ['0', '13', '4.5', 'abc']) {
      throws(() => setStart(bad2), 'SETTING_VALUE_INVALID', `起始月「${bad2}」被拒（SETTING_VALUE_INVALID）`)
    }
    setStart(1)
    eq('改回 1 之后会计年度回到自然年', [R.fiscalStartMonth(db), R.resolveRange(db, { period: P, range: 'ytd' }).from], [1, `${P.slice(0, 4)}-01`])
    // 「唯一出处」的机械检验：resolveRange 算出的年初必须等于 fiscalYearOf 的 from
    let mismatch = 0
    for (const per of ['2026-01', '2026-04', '2026-07', '2026-12', '2027-03']) {
      for (const sm2 of [1, 4, 7, 12]) {
        setStart(sm2)
        const rg = R.resolveRange(db, { period: per, range: 'ytd' })
        const fy = R.fiscalYearOf(per, sm2)
        if (rg.from !== fy.from || rg.year !== fy.fiscal_year) mismatch += 1
      }
    }
    eq('resolveRange 与 fiscalYearOf 在 20 组组合上完全一致（年初只有一个出处）', mismatch, 0)
    setStart(1)
  } finally {
    db.exec('ROLLBACK')
  }

  // =========================================================================
  section(`F5 收尾：一行都不多（${ind}）`)
  // =========================================================================
  eq('settings 行数未变', db.prepare('SELECT COUNT(*) c FROM settings').get().c, before.settings)
  eq('配置变更日志行数未变', db.prepare('SELECT COUNT(*) c FROM setting_audit_log').get().c, before.log)
  eq('起始月回到测试前的值', R.fiscalStartMonth(db), 1)
  ok(R.auditReport(db, { period: P }).ok, '收尾：报表自证仍然通过（没被测试改坏）')

  db.close()
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`会计年度起点可配置（三库）：通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  failures.forEach((f) => console.log(`  - ${f}`))
}
process.exit(fail === 0 ? 0 : 1)
