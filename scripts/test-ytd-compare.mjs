/**
 * ============================================================================
 * 文件标识：scripts/test-ytd-compare.mjs ｜ 测试：批次 U 之四 · ③-b：「本年累计的比较」（`mode=yoy_ytd`）
 * ============================================================================
 * 【职责】测试：批次 U 之四 · ③-b：「本年累计的比较」（`mode=yoy_ytd`）
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
 * 批次 U 之四 · ③-b：「本年累计的比较」（`mode=yoy_ytd`）
 *
 * 这一项的全部价值压在一个**口径判断**上，所以测试要把它做成可执行的：
 *   本期列 = [会计年度年初, 本期]，基期列 = [上年会计年度年初, 上年同月]。
 *   **不能**取 `[上年同月, 本期]` —— 那个跨两个年度、含一个完整的上年，是另一个量。
 * 所以 Y3 不是"再算一遍核对"，而是**把那个错误窗口也算出来，断言它与正确答案不同**
 * （如果两者恰好相等，这条断言就是空跑，会如实说出来）。
 *
 * 只读跑（`readonly: true` 打开）—— 这一切都是纯计算。
 * 用法：node scripts/test-ytd-compare.mjs
 * 收尾打印「通过 N / 失败 M」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import * as R from '../server/lib/report.js'

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
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps
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

console.log(`=== 「本年累计的比较」（yoy_ytd）测试（三库：${INDUSTRIES.join(' / ')}） ===`)

for (const ind of INDUSTRIES) {
  const file = dbPathFor(ind)
  if (!fs.existsSync(file)) continue
  const db = new Database(file, { readonly: true, fileMustExist: true })
  const P = R.availablePeriods(db).find((x) => x.posted_count > 0)?.period || '2026-10'
  const base = R.shiftPeriod(P, -12)
  console.log(`\n${'─'.repeat(72)}\n【${ind}】本期 ${P} / 基期 ${base}`)

  // =========================================================================
  section(`Y1 模式解析：基期窗口 = [上年年初, 上年同月]（${ind}）`)
  // =========================================================================
  const want = R.resolveCompareMode(db, { period: P, mode: 'yoy_ytd' })
  eq('基期期间 = 本期往前 12 个月', want.base_period, base)
  eq('模式自带区间 ytd', want.range, 'ytd')
  const sm = R.fiscalStartMonth(db)
  const startOf = (per) => {
    const y = Number(per.slice(0, 4))
    const mm = Number(per.slice(5, 7))
    return `${mm >= sm ? y : y - 1}-${String(sm).padStart(2, '0')}`
  }
  eq('基期窗口**字面**等于 [上年年初, 上年同月]', [want.base_range?.from, want.base_range?.to], [startOf(base), base])
  eq('模式标签自己说清窗口（读的人不必自己推）', want.mode_label.includes(`${startOf(base)} ~ ${base}`), true)
  eq('isRangeCompareMode 只认这一个模式',
    ['previous', 'yoy', 'custom', 'yoy_ytd', 'nope'].map((m) => R.isRangeCompareMode(m)),
    [false, false, false, true, false])

  // =========================================================================
  section(`Y2 两列都是累计，且逐行等于"单独打开那一期的累计"（${ind}）`)
  // =========================================================================
  const cmp = R.compareReport(db, { reportCode: 'pl', period: P, mode: 'yoy_ytd' })
  eq('结自称口径 = ytd', [cmp.compare_basis, cmp.compare_basis_label], ['ytd', '累计对累计'])
  eq('列名带两个累计窗口', cmp.columns.map((c) => c.label), [
    '行次', '项目', `本期累计(${startOf(P)}~${P})`, `上年同期累计(${startOf(base)}~${base})`, '累计差额', '累计变动率%'
  ])
  const soloCur = R.computeReport(db, { reportCode: 'pl', period: P, range: 'ytd' })
  const soloBase = R.computeReport(db, { reportCode: 'pl', period: base, range: 'ytd' })
  const curBy = new Map(soloCur.rows.map((r) => [r.line_code, r.ytd_amount]))
  const baseBy = new Map(soloBase.rows.map((r) => [r.line_code, r.ytd_amount]))
  let badCur = 0
  let badBase = 0
  let badDiff = 0
  let nonZero = 0
  for (const r of cmp.rows) {
    if (!near(r.amount, curBy.get(r.line_code))) badCur += 1
    if (!near(r.base_amount, baseBy.get(r.line_code))) badBase += 1
    if (!near(r.diff, Number(r.amount) - Number(r.base_amount))) badDiff += 1
    if (Math.abs(Number(r.amount)) > 0.005) nonZero += 1
  }
  eq('本期列 == 单独打开本期累计（逐行）', badCur, 0)
  eq('基期列 == 单独打开基期累计（逐行）', badBase, 0)
  eq('累计差额 == 两列相减（逐行）', badDiff, 0)
  ok(nonZero > 0, `本期累计里至少有一行非 0（共 ${nonZero} 行）—— 否则上面三条都是"0 == 0"的空跑`)
  eq('range_meta / base_range_meta 两个窗口都在结果里',
    [cmp.range_meta?.from, cmp.range_meta?.to, cmp.base_range_meta?.from, cmp.base_range_meta?.to],
    [startOf(P), P, startOf(base), base])

  // =========================================================================
  section(`Y3 那个"看起来更自然"的错误窗口 [上年同月, 本期] 是**另一个量**（${ind}）`)
  // =========================================================================
  // 用逐月相加**独立**算出错误窗口的数（不调比较功能），再断言它与正确答案不同。
  // 这条断言是这一节的核心：它把"口径判断"变成"两个数不相等"。
  const wrong = new Map()
  for (let m = base; m <= P; m = R.shiftPeriod(m, 1)) {
    for (const r of R.computeReport(db, { reportCode: 'pl', period: m }).rows) {
      wrong.set(r.line_code, Math.round(((wrong.get(r.line_code) || 0) + Number(r.amount)) * 100) / 100)
    }
  }
  const diffs = cmp.rows
    .filter((r) => Math.abs(Number(r.base_amount) - (wrong.get(r.line_code) ?? 0)) > 0.005)
    .map((r) => r.line_code)
  ok(diffs.length > 0,
    `错误窗口 [${base}, ${P}] 的数与正确基期列**不同**（不同 ${diffs.length} 行：${diffs.slice(0, 3).join('、')}）—— 这就是"不能那么实现"的可执行证据`)
  // 两个窗口的**月数相同**（同相位：都是从"年初"到"某个月"）；而错误窗口是"从上年同月到本期"，
  // 它必然更长（跨两个年度）。这两条一起说清了"为什么不能那么实现"。
  eq('正确基期列与本期列的月数相同（同相位）',
    monthSpan(startOf(base), base), monthSpan(startOf(P), P))
  ok(monthSpan(base, P) > monthSpan(startOf(base), base),
    `错误窗口 [${base}, ${P}] 比正确窗口长（${monthSpan(base, P)} > ${monthSpan(startOf(base), base)} 个月）—— 它把去年整年算了进去`)

  // =========================================================================
  section(`Y4 闸门：该拒的照旧拒，该放的只放这一个（${ind}）`)
  // =========================================================================
  throws(() => R.compareReport(db, { reportCode: 'pl', period: P, mode: 'previous', range: 'ytd' }), 'RANGE_COMPARE_UNSUPPORTED', '环比 + 累计仍然拒绝')
  throws(() => R.compareReport(db, { reportCode: 'pl', period: P, mode: 'yoy', range: 'ytd' }), 'RANGE_COMPARE_UNSUPPORTED', '同比 + 累计仍然拒绝')
  const e = throws(() => R.compareReport(db, { reportCode: 'bs', period: P, mode: 'yoy_ytd' }), 'COMPARE_YTD_BASIS_NOT_APPLICABLE', '时点口径（资产负债表）+ 累计同比 → 明确拒绝')
  ok(!e || (e.http ?? e.status) === 409, '那条拒绝是 409（不是 500）')
  throws(() => R.compareReport(db, { reportCode: 'pl', period: P, mode: 'yoy_ytd', range: 'last3' }), 'BAD_RANGE_MODE', 'yoy_ytd 只接受它自带的 range=ytd')
  eq('yoy_ytd + range=ytd 与不传 range 结果一致',
    R.compareReport(db, { reportCode: 'pl', period: P, mode: 'yoy_ytd', range: 'ytd' }).rows.map((r) => [r.line_code, r.amount, r.base_amount]),
    cmp.rows.map((r) => [r.line_code, r.amount, r.base_amount]))

  // =========================================================================
  section(`Y5 自证会响：三种"算歪了"各报一个封闭错误码（${ind}）`)
  // =========================================================================
  ok(R.auditComparison(db, { reportCode: 'pl', period: P, mode: 'yoy_ytd' }).ok, 'yoy_ytd 的常规自证通过')
  const huaiBase = { ...cmp, rows: cmp.rows.map((r, i) => (i === 0 ? { ...r, base_amount: Number(r.base_amount) + 12345 } : r)) }
  ok(R.auditComparison(db, { reportCode: 'pl', period: P, mode: 'yoy_ytd', result: huaiBase }).problems.some((p) => p.code === 'COMPARE_BASE_MISMATCH'), '基期列被改 → COMPARE_BASE_MISMATCH')
  const huaiBasis = { ...cmp, compare_basis: 'period' }
  ok(R.auditComparison(db, { reportCode: 'pl', period: P, mode: 'yoy_ytd', result: huaiBasis }).problems.some((p) => p.code === 'COMPARE_BASIS_BAD'), '口径自称被改 → COMPARE_BASIS_BAD')
  const huaiWin = { ...cmp, base_range_meta: { ...cmp.base_range_meta, from: R.shiftPeriod(cmp.base_range_meta.from, 1) } }
  ok(R.auditComparison(db, { reportCode: 'pl', period: P, mode: 'yoy_ytd', result: huaiWin }).problems.some((p) => p.code === 'COMPARE_RANGE_WINDOW_BAD'), '基期窗口被挪一个月 → COMPARE_RANGE_WINDOW_BAD')
  ok(R.auditComparison(db, { reportCode: 'pl', period: P, mode: 'yoy_ytd' }).ok, '不注入时回到通过（三条探针都不是恒真的）')

  // =========================================================================
  section(`Y6 导出：两个累计窗口都写进文件（${ind}）`)
  // =========================================================================
  const out = R.exportReport(db, { reportCode: 'pl', period: P, mode: 'yoy_ytd', generatedAt: 'FIXED' })
  const lines = String(out.content).replace(/^\uFEFF/, '').split('\r\n')
  eq('CSV 表头 == columns 的 label', lines[0].split(',').join('|'), cmp.columns.map((c) => c.label).join('|'))
  ok(lines.some((l) => l.includes(`# 本年累计：${startOf(P)} ~ ${P}`)), '末尾元信息里有本期累计窗口')
  ok(lines.some((l) => l.includes(`# 基期窗口：${startOf(base)} ~ ${base}`)), '末尾元信息里有基期窗口')
  eq('文件名带基期与模式', out.filename, `pl_${P}_vs_${base}_yoy_ytd.csv`)
  const xl = R.exportReport(db, { reportCode: 'pl', period: P, mode: 'yoy_ytd', format: 'xlsx', generatedAt: 'FIXED' })
  ok(Buffer.isBuffer(xl.content) && xl.content.length > 100, 'xlsx 也能导（沿用同一份 result / 同一份列定义）')

  db.close()
}

function monthSpan(from, to) {
  let n = 0
  for (let m = from; m <= to; m = R.shiftPeriod(m, 1)) n += 1
  return n
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`本年累计的比较（三库）：通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  failures.forEach((f) => console.log(`  - ${f}`))
}
process.exit(fail === 0 ? 0 : 1)
