/**
 * ============================================================================
 * 文件标识：scripts/test-report-config-audit.mjs ｜ 测试：批次 S：报表口径变更留痕（report_defs / report_lines 的每一次改动都留一条可重放的记录）
 * ============================================================================
 * 【职责】测试：批次 S：报表口径变更留痕（report_defs / report_lines 的每一次改动都留一条可重放的记录）
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
 * 批次 S：报表口径变更留痕（report_defs / report_lines 的每一次改动都留一条可重放的记录）
 *
 * 这一批补的不是"报表口径能改"，而是三件事：
 *   ① **改了口径要答得出改了什么** —— 原来只有一句通用审计：
 *      保存记 `{ line_no }`、删除记 `report_line:<自增 id>`。
 *      于是"把 `sign` 从 +1 改成 −1"与"把科目区间加了一段"留下的记录**完全一样**，
 *      而"删掉的那一行原来是什么"**永久不可考**（行是物理删除，id 已经不存在了）。
 *   ② **删掉之后还查得出删了什么** —— 每次记录存**整行快照**（`snapshot_before`）。
 *   ③ **可重放**：从空状态按序应用日志，必须得到 `report_defs` + `report_lines`
 *      的**全部内容**（逐行逐字段）。两条路径出处不同（现状来自 INSERT/DELETE，
 *      历史来自唯一写入点），所以它抓得到"改了没记""记了没改"。
 *
 * 与批次 R 的差别（**不是照抄**）：那边危险是"键的属性"（一个键的含义固定），
 * 这边危险是**差分驱动**的（同一行改 `line_name` 是展示、改 `subject_range` 是会计政策）。
 *
 * 与其它域同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-report-config-audit.mjs [cosmetic|food|apparel]
 *
 * 可重复跑 + 不留副作用：全部写操作包在 `BEGIN … ROLLBACK` 里，
 * S13 断言 `report_lines` / `report_defs` / 日志表**一行都不多**。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import * as RCA from '../server/lib/report-config-audit.js'
import * as R from '../server/lib/report.js'
// 种子重跑（S15 用）：它回答"服务再启动一次会不会把口径改回去 / 换一代 id"。
// 这是**唯一**能用单测覆盖那条路径的办法 —— 真正的启动路径要起进程，代价太大。
import { seedReport } from '../server/db/report-seed.js'

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
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)
const throws = (fn, code, msg) => {
  try {
    fn()
  } catch (e) {
    const hit = !code || e.code === code
    if (!hit) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${code}，实得 ${e.code || e.message}`)
    ok(hit, msg, e.code)
    return
  }
  console.log(`  \x1b[31m✗\x1b[0m ${msg}：没有抛错`)
  ok(false, msg)
}

const dbFile = dbPathFor(INDUSTRY)
const db = new Database(dbFile)
db.pragma('journal_mode = WAL')
const actor = { id: null, name: 'test-rcfg', source: 'web' }

console.log(`=== 报表口径变更留痕测试（${INDUSTRY}） ===`)

const base = {
  defs: db.prepare('SELECT COUNT(*) c FROM report_defs').get().c,
  lines: db.prepare('SELECT COUNT(*) c FROM report_lines').get().c,
  log: db.prepare('SELECT COUNT(*) c FROM report_config_audit_log').get().c,
  // 记最大 id 而不只是条数：条数相同但"删了几条又插了几条"是另一种污染，
  // 而只比条数看不出来（这正是"只测有没有、不测对不对"的老毛病）。
  logMaxId: db.prepare('SELECT COALESCE(MAX(id),0) m FROM report_config_audit_log').get().m,
  lineIdSeq: db.prepare('SELECT COALESCE(MAX(id),0) m FROM report_lines').get().m
}

/** 在一个事务里做破坏性动作，跑完自动回滚（测试不留副作用） */
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

/** 直接读库（**不是**从参数推）—— 断言要对着库里的事实，不是对着我传进去的东西 */
const lineRow = (code, lineCode) =>
  db.prepare('SELECT * FROM report_lines WHERE report_code=? AND line_code=?').get(code, lineCode) || {}
/**
 * 把一个已有行原样变成一个 payload（再叠 `over`）。`|| {}` 的兜底是刻意的：
 * 反例注入（如"写入点不再留痕"）会让某些读取落空，而 `.line_no` 会崩在 `undefined` 上 ——
 * 那等于把"这条断言该给的可读的红"丢掉（批次 Q 的教训）。
 */
const payloadOf = (row = {}, over = {}) => ({
  report_code: row.report_code,
  line_code: row.line_code,
  line_no: row.line_no,
  display_no: row.display_no,
  line_name: row.line_name,
  line_type: row.line_type,
  level: row.level,
  subject_range: row.subject_range,
  sign: row.sign,
  only_direction: row.only_direction,
  subtotal_expr: row.subtotal_expr,
  is_fallback: row.is_fallback,
  order_no: row.order_no,
  remark: row.remark,
  ...over
})
/** 探针报出的 code 集合 */
const codesOf = (t) => (t.problems || []).map((p) => p.code)
/**
 * 读一个日志字段里存的 JSON。**`|| fallback` 的兜底是刻意的**：
 * 反例注入（如"写入点不再留痕"）会让日志行整个读不到，`JSON.parse(undefined)` 会抛
 * `SyntaxError: "undefined" is not valid JSON` —— 那等于把前面那几条已经变红的断言
 * 埋进栈里（批次 Q 的教训：崩在无关位置 = 把最重要的证据丢掉了）。
 */
const J = (s, fallback = null) => {
  try {
    return s ? JSON.parse(s) : fallback
  } catch {
    return fallback
  }
}
const lastLog = (where = '1=1', ...args) =>
  db.prepare(`SELECT * FROM report_config_audit_log WHERE ${where} ORDER BY id DESC LIMIT 1`).get(...args) || {}
/** 某个身份键有没有历史记录 */
const hasHistory = (t, code, lineCode = null) =>
  !!db
    .prepare('SELECT 1 AS hit FROM report_config_audit_log WHERE target_type=? AND report_code=? AND line_code IS ? LIMIT 1')
    .get(t, code, lineCode)

// 挑一类样本：**挑对的，不挑第一个**（批次 R 的教训）
const ITEM = db.prepare("SELECT * FROM report_lines WHERE report_code='bs' AND line_type='item' ORDER BY line_no").all()
const SUBTOTAL = db.prepare("SELECT * FROM report_lines WHERE report_code='bs' AND line_type IN ('subtotal','total') ORDER BY line_no").all()
const BS_DEF = db.prepare("SELECT * FROM report_defs WHERE report_code='bs'").get()

// ===========================================================================
section('S1 基线的完整性：每一行口径都有历史，且基线不是"谁的动作"')
{
  const t = RCA.auditReportConfigTrail(db)
  ok(t.ok, `起始状态自证通过（核 ${t.entries_checked} 条记录 / ${t.defs_checked} 张定义 / ${t.lines_checked} 行口径）`
    + (t.ok ? '' : `；异常：${codesOf(t).join(',')}`))

  const unTracked = []
  for (const r of db.prepare('SELECT report_code FROM report_defs').all()) if (!hasHistory('def', r.report_code)) unTracked.push(`def:${r.report_code}`)
  for (const r of db.prepare('SELECT report_code, line_code FROM report_lines').all()) if (!hasHistory('line', r.report_code, r.line_code)) unTracked.push(`line:${r.report_code}/${r.line_code}`)
  eq('每一张报表定义与每一行口径都有历史记录', unTracked, [])

  // ⚠️ 幂等这条断言**必须在事务里**跑。理由不是洁癖，是被反例注入当场抓到的：
  // 反例 I（"初始化对所有行都补基线"）会让这句**真的往库里写 47 条** ——
  // 它本来在事务外，于是写完就落库了，后面十几条断言跟着一起红（与本次注入无关），
  // 而"代码能还原、库不会"（批次 R 反例 B 的教训）。
  // 包进 `BEGIN … ROLLBACK` 之后：实现坏了，红还是红，但**一行都不落库**。
  inSavepoint(() => {
    const q = RCA.ensureReportConfigTrail(db)
    eq('ensureReportConfigTrail 幂等（再跑补 0 条）', q.baselines, 0)
    ok(q.defs > 0 && q.lines > 0, `它读到了 ${q.defs} 张定义 / ${q.lines} 行口径`, JSON.stringify(q))
  })

  // 基线不是动作：没有"改了哪几列"、不危险、不需要理由
  const b = lastLog("action='baseline'")
  eq('基线不带 changed_fields', b.changed_fields, null)
  eq('基线 is_danger = 0', b.is_danger, 0)
  eq('基线不需要理由', b.reason, null)

  // 初始化入口必须**真的会补** —— 否则"基线齐全"只是既有状态，不是这条路还活着。
  // 这一条同时是 `ensureReportConfigTrail` 的正面用例（反例 G 就是把它改成空转）。
  inSavepoint(() => {
    const sample = ITEM[0]
    db.prepare("DELETE FROM report_config_audit_log WHERE target_type='line' AND report_code=? AND line_code=?").run(sample.report_code, sample.line_code)
    ok(codesOf(RCA.auditReportConfigTrail(db)).includes('REPORT_CONFIG_UNTRACKED'),
      '清掉一行的历史之后 UNTRACKED 立刻响（说明"有行无历史"确实会被看见）')
    const r = RCA.ensureReportConfigTrail(db)
    eq('初始化给"有行无历史"的那一行补了一条基线', r.baselines, 1)
    eq('补完之后自证回绿', RCA.auditReportConfigTrail(db).ok, true)
    const fixed = lastLog('target_type=? AND report_code=? AND line_code=?', 'line', sample.report_code, sample.line_code)
    eq('补的确实是一条 baseline（不是 create / update）', fixed.action, 'baseline')
  })
}

// ===========================================================================
section('S2 迁移结构不变量 + 快照字段清单与表结构一致（盲区不会静默扩大）')
{
  const cols = db.prepare('PRAGMA table_info(report_config_audit_log)').all().map((c) => c.name)
  for (const need of ['id', 'target_type', 'report_code', 'line_code', 'action', 'action_label', 'snapshot_before', 'snapshot_after', 'changed_fields', 'is_danger', 'reason', 'actor_source', 'created_at']) {
    ok(cols.includes(need), `日志表有列 ${need}`)
  }
  // ⑧ 号探针的反面：三张表的列**全部**被 SNAPSHOT_FIELDS 声明。
  // 这条不是形式主义 —— 少声明一列，那一列就既不留痕也不参与重放比对，
  // 而它会安静地一直错下去（`REPORT_CONFIG_FIELD_GAP` 守的就是它）。
  for (const [t, table] of [['def', 'report_defs'], ['line', 'report_lines']]) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).sort()
    const declared = [...RCA.SNAPSHOT_FIELDS[t]].sort()
    eq(`${table} 的列与 SNAPSHOT_FIELDS.${t} 完全一致`, actual, declared)
  }
  eq('三张报表定义都在日志里有历史', db.prepare("SELECT COUNT(DISTINCT report_code) c FROM report_config_audit_log WHERE target_type='def'").get().c, 3)
}

// ===========================================================================
section('S3 新增一行口径 → create · 危险（全字段）· 必须写理由')
{
  inSavepoint(() => {
    const newLine = { report_code: 'bs', line_code: 'BS_TEST_CREATE', line_no: 9901, line_name: '测试口径行', line_type: 'item', subject_range: '1999~1999' }

    // ① 不写理由 → 拒绝。**新增也算会计政策变更**（它会让报表多一块）。
    throws(
      () => inSavepoint(() => R.saveReportLine(db, newLine, { actor })),
      'REPORT_CONFIG_REASON_REQUIRED', '新增口径不写理由 → 拒绝'
    )
    // 上面那次被拒绝，所以库里**不该**留下这一行（拒绝要拒绝得干净）
    eq('被拒绝的新增没有落库', !!db.prepare("SELECT 1 AS hit FROM report_lines WHERE line_code='BS_TEST_CREATE'").get(), false)

    const r = R.saveReportLine(db, newLine, { actor, reason: '测试：新增一行口径' })
    eq('新增报告 changed = true', r.changed, true)
    eq('新增报告 logged = true', r.logged, true)
    ok(Number.isInteger(r.entry_id), '新增返回了日志编号', r.entry_id)

    const row = lineRow('bs', 'BS_TEST_CREATE')
    eq('库里确实多了一行', !!row.id, true)

    const e = db.prepare('SELECT * FROM report_config_audit_log WHERE id=?').get(r.entry_id) || {}
    eq('日志 action = create', e.action, 'create')
    eq('日志 action_label 是人话', e.action_label, '新增口径')
    eq('日志冻结了"这次是危险改动"', e.is_danger, 1)
    eq('日志记了理由', e.reason, '测试：新增一行口径')
    eq('日志记了操作人', e.actor_name, 'test-rcfg')
    eq('create 的 changed_fields = 全部字段', J(e.changed_fields, []).length, RCA.SNAPSHOT_FIELDS.line.length)
    eq('create 没有 before 快照', e.snapshot_before, null)
    // **快照内容要与库里的事实逐字段一致** —— 不是"与传进去的参数一致"
    eq('快照 after 与库里的行逐字段一致', J(e.snapshot_after, {}), RCA.pickSnapshot('line', row))

    // 新增之后重放仍然自洽
    ok(RCA.auditReportConfigTrail(db).ok, '新增之后重放仍然自洽')
  })
}

// ===========================================================================
section('S4 修改**展示字段** → 不需要理由；值没变不算一次变更')
{
  inSavepoint(() => {
    const target = ITEM[1] || ITEM[0]
    const r = R.saveReportLine(db, payloadOf(target, { line_name: `${target.line_name}（改名）` }), { actor })
    eq('改 line_name：changed = true', r.changed, true)

    const e = db.prepare('SELECT * FROM report_config_audit_log WHERE id=?').get(r.entry_id) || {}
    eq('日志 action = update', e.action, 'update')
    eq('改展示字段**不**算危险', e.is_danger, 0)
    eq('不需要理由', e.reason, null)
    eq('changed_fields 只列出真正变了的列', J(e.changed_fields, []), ['line_name'])
    eq('before 快照里的旧名就是原来的名字', J(e.snapshot_before, {}).line_name, target.line_name)
    eq('after 快照里的新名是改后的名字', J(e.snapshot_after, {}).line_name, `${target.line_name}（改名）`)

    // 值没变再存一次：不是一次变更，**不写日志也不写库**
    const before = db.prepare('SELECT COUNT(*) c FROM report_config_audit_log').get().c
    const r2 = R.saveReportLine(db, payloadOf(lineRow(target.report_code, target.line_code)), { actor })
    eq('值没变时 changed = false', r2.changed, false)
    eq('值没变时 logged = false', r2.logged, false)
    eq('值没变时不写日志', db.prepare('SELECT COUNT(*) c FROM report_config_audit_log').get().c, before)
  })
}

// ===========================================================================
section('S5 修改**危险字段** → 必须写理由；差分精确到列')
{
  inSavepoint(() => {
    const target = ITEM[2] || ITEM[0]
    const other = target.subject_range === '1998~1998' ? '1997~1997' : '1998~1998'

    throws(
      () => inSavepoint(() => R.saveReportLine(db, payloadOf(target, { subject_range: other }), { actor })),
      'REPORT_CONFIG_REASON_REQUIRED', '改科目区间不写理由 → 拒绝'
    )
    eq('被拒绝的改动没有落库', lineRow(target.report_code, target.line_code).subject_range, target.subject_range)

    const r = R.saveReportLine(db, payloadOf(target, { subject_range: other }), { actor, reason: '测试：调整科目区间' })
    const e = db.prepare('SELECT * FROM report_config_audit_log WHERE id=?').get(r.entry_id) || {}
    eq('改科目区间算危险改动', e.is_danger, 1)
    eq('changed_fields 只列出科目区间这一列', J(e.changed_fields, []), ['subject_range'])
    eq('快照记录了改前的区间', J(e.snapshot_before, {}).subject_range, target.subject_range)
    eq('快照记录了改后的区间', J(e.snapshot_after, {}).subject_range, other)

    // `sign` 也是危险字段（方向口径）—— 顺带证明"危险集"不是一个只有一项的摆设
    const minus = Number(target.sign) === -1 ? 1 : -1
    const r2 = R.saveReportLine(db, payloadOf(lineRow(target.report_code, target.line_code), { sign: minus }), { actor, reason: '测试：改方向系数' })
    const e2 = db.prepare('SELECT * FROM report_config_audit_log WHERE id=?').get(r2.entry_id) || {}
    eq('改 sign 也算危险改动', e2.is_danger, 1)
    eq('sign 的 changed_fields 就一列', J(e2.changed_fields, []), ['sign'])
  })
}

// ===========================================================================
section('S6 删除 → 必须写理由；**删掉之后还查得出删了什么**（本批的核心）')
{
  inSavepoint(() => {
    // 挑一行**没有被任何小计引用**的口径行（挑对的，不挑第一个）
    const referenced = new Set()
    for (const s of SUBTOTAL) for (const x of R.parseSubtotalExpr(s.subtotal_expr)) referenced.add(Number(x.no))
    const victim = ITEM.find((r) => !referenced.has(Number(r.line_no)))
    ok(!!victim, '找到一行未被小计引用的科目行做样本', victim && `第 ${victim.line_no} 行 ${victim.line_name}`)
    const snapshot = { ...victim }

    throws(
      () => inSavepoint(() => R.deleteReportLine(db, victim.id, { actor })),
      'REPORT_CONFIG_REASON_REQUIRED', '删除口径不写理由 → 拒绝'
    )
    eq('被拒绝的删除没有落库', !!db.prepare('SELECT 1 AS hit FROM report_lines WHERE id=?').get(victim.id), true)

    const out = R.deleteReportLine(db, victim.id, { actor, reason: '测试：删除一行口径' })
    eq('删除报告 logged = true', out.logged, true)
    eq('库里这一行没了', db.prepare('SELECT COUNT(*) c FROM report_lines WHERE id=?').get(victim.id).c, 0)

    const e = db.prepare('SELECT * FROM report_config_audit_log WHERE id=?').get(out.entry_id) || {}
    eq('日志 action = delete', e.action, 'delete')
    eq('删除必须算危险改动', e.is_danger, 1)
    eq('delete 没有 after 快照', e.snapshot_after, null)
    // **这一条就是本批要根治的东西**：物理删除之后，"删的是什么"只剩这里还查得到。
    eq('删除记录带整行快照，内容与被删的行逐字段一致', J(e.snapshot_before, {}), RCA.pickSnapshot('line', snapshot))
    eq('从日志里能读出删掉的行的行号', J(e.snapshot_before, {}).line_no, snapshot.line_no)
    eq('从日志里能读出删掉的行的科目区间', J(e.snapshot_before, {}).subject_range, snapshot.subject_range)

    // 人读视角：列表接口把"删了什么"渲染出来（界面直接用，不自己解析 JSON）
    const list = RCA.listReportConfigAudit(db, { reportCode: 'bs', limit: 50 })
    const hit = list.rows.find((x) => x.id === out.entry_id) || {}
    eq('历史列表能给出被删掉的行名', hit.title, snapshot.line_name)
    eq('历史列表把快照展开成"改前有什么"', hit.snapshot_before && hit.snapshot_before.line_name, snapshot.line_name)

    ok(RCA.auditReportConfigTrail(db).ok, '删除之后重放仍然自洽（删除也是一次有记录的状态变化）')
  })
}

// ===========================================================================
section('S7 改行号撞车 → 给一句人话，不是原始 SQLite 约束错')
{
  inSavepoint(() => {
    const a = ITEM[0]
    const b = ITEM[1]
    // 冲突键是 (report_code, line_code)：把 a 的行号改成 b 的，INSERT 不会命中 a 自己，
    // 而会撞上 UNIQUE(report_code, line_no)。原来抛的是
    // `SqliteError: UNIQUE constraint failed: report_lines.report_code, report_lines.line_no`
    const err = (() => {
      try {
        R.saveReportLine(db, payloadOf(a, { line_no: b.line_no }), { actor, reason: '测试' })
        return null
      } catch (e) {
        return e
      }
    })()
    ok(!!err, '改行号撞到别的行 → 抛错')
    eq('错误码是可读的业务码（不是 SqliteError）', err && err.code, 'LINE_NO_TAKEN')
    ok(err && /已经被/.test(err.message), '错误消息指出了被谁占用', err && err.message)
    ok(err && !/SqliteError/.test(err.name || ''), '不是原始 SQLite 约束错', err && err.name)
  })
}

// ===========================================================================
section('S8 改行号 = 删掉旧行号 → 与删除受**同一条**保护（引用完整性）')
{
  inSavepoint(() => {
    // 找一个**被小计引用**的行号，然后试图把它改成别的号
    const referenced = new Map()
    for (const s of SUBTOTAL) for (const x of R.parseSubtotalExpr(s.subtotal_expr)) referenced.set(Number(x.no), s.line_name)
    const holder = ITEM.find((r) => referenced.has(Number(r.line_no)))
    ok(!!holder, '找到一行被小计引用的科目行做样本', holder && `第 ${holder.line_no} 行（被「${referenced.get(Number(holder.line_no))}」引用）`)

    const free = 9800
    throws(
      () => inSavepoint(() => R.saveReportLine(db, payloadOf(holder, { line_no: free }), { actor, reason: '测试' })),
      'LINE_NO_IN_USE', '改一个被小计引用的行号 → 拒绝（否则引用会静默悬空）'
    )
    eq('被拒绝的改行号没有落库', lineRow(holder.report_code, holder.line_code).line_no, holder.line_no)

    // 反向：删除同一条保护（证明这两条路确实共用同一份判据）
    throws(
      () => inSavepoint(() => R.deleteReportLine(db, holder.id, { actor, reason: '测试' })),
      'LINE_IN_USE', '删除同一个被引用的行 → 同样拒绝'
    )

    // 反向的正向样本：一行**没有被引用**的科目行可以自由改行号
    const referencedNos = new Set([...referenced.keys()])
    const freeLine = ITEM.find((r) => !referencedNos.has(Number(r.line_no)) && Number(r.line_no) !== free)
    ok(!!freeLine, '找到一行未被引用的科目行做正向样本', freeLine && `第 ${freeLine.line_no} 行`)
    const moved = R.saveReportLine(db, payloadOf(freeLine, { line_no: free }), { actor, reason: '测试：挪行号' })
    eq('未被引用的行可以改行号', lineRow(freeLine.report_code, freeLine.line_code).line_no, free)
    const movedLog = db.prepare('SELECT * FROM report_config_audit_log WHERE id=?').get(moved.entry_id) || {}
    eq('改行号留下一条 update 记录', movedLog.action, 'update')
    ok(J(movedLog.changed_fields, []).includes('line_no'), 'changed_fields 里有 line_no')
  })
}

// ===========================================================================
section('S9 写入点的硬约束：事务外写日志一律拒绝')
{
  // 铁律写进文档没人记得，所以它是**断言**。
  // 用**非危险**的键（非危险字段）来测：一条断言只该被一个闸门守着 ——
  // 若用危险改动，摘掉事务断言后会落到"必须写理由"那条闸门上，
  // 于是这条用例分不清是哪个闸门坏了（批次 R 反例 B 的教训）。
  throws(
    () => RCA.logReportConfigChange(db, {
      targetType: 'def', reportCode: 'bs', action: 'update',
      before: BS_DEF, after: BS_DEF
    }),
    'AUDIT_OUTSIDE_TX', '事务外写日志 → AUDIT_OUTSIDE_TX'
  )
  throws(
    () => inSavepoint(() => RCA.logReportConfigChange(db, { targetType: 'def', reportCode: 'bs', action: '随便', before: BS_DEF, after: BS_DEF })),
    'REPORT_CONFIG_AUDIT_UNKNOWN_ACTION', '不认识的动作 → 拒绝（宁可炸，也不要落一条代码解释不了的记录）'
  )
  throws(
    () => inSavepoint(() => RCA.logReportConfigChange(db, { targetType: 'sheet', reportCode: 'bs', action: 'update', before: BS_DEF, after: BS_DEF })),
    'REPORT_CONFIG_AUDIT_UNKNOWN_TARGET', '不认识的目标类型 → 拒绝'
  )
  // 快照必须整份：delete 没有 before 就是一条**指向空**的记录
  throws(
    () => inSavepoint(() => RCA.logReportConfigChange(db, { targetType: 'line', reportCode: 'bs', lineCode: 'X', action: 'delete' })),
    'REPORT_CONFIG_AUDIT_SNAPSHOT_MISSING', 'delete 没带 before 快照 → 拒绝'
  )
  throws(
    () => inSavepoint(() => RCA.logReportConfigChange(db, { targetType: 'line', reportCode: 'bs', lineCode: 'X', action: 'create' })),
    'REPORT_CONFIG_AUDIT_SNAPSHOT_MISSING', 'create 没带 after 快照 → 拒绝'
  )
}

// ===========================================================================
section('S10 重放是**独立**的：拿一份造出来的日志去问"如果日志是这样，对得上吗"')
{
  // 不断言"重放一定等于我传进去的参数"（那是自己验自己），
  // 而是断言：注入一份**与现状不符**的历史，探针必须响。
  const fake = db.prepare('SELECT * FROM report_config_audit_log ORDER BY id').all()
  const tampered = fake.map((e) => e.action === 'baseline' && e.target_type === 'def'
    ? { ...e, snapshot_after: JSON.stringify({ ...J(e.snapshot_after, {}), name: '被篡改的名字' }) }
    : e)
  const t = RCA.auditReportConfigTrail(db, { log: tampered })
  ok(codesOf(t).includes('REPORT_CONFIG_AUDIT_DESYNC'), '注入了篡改过的日志 → DESYNC 响', JSON.stringify(codesOf(t)))
  // 而把真实日志喂回去 → 不响（证明上面那条红是"注入造成的"，不是探针恒红）
  ok(RCA.auditReportConfigTrail(db, { log: fake }).ok, '喂真实日志 → 不响（探针不是恒红）')
}

// ===========================================================================
section('S11 八条探针逐条：每条只被**一个**原因触发（UNTRACKED 与 DESYNC 互斥）')
{
  const sample = ITEM[0]
  const insertLog = (o) => db.prepare(`
    INSERT INTO report_config_audit_log
      (target_type, report_code, line_code, action, action_label, snapshot_before, snapshot_after,
       changed_fields, is_danger, reason, actor_name, actor_source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(o.target_type, o.report_code, o.line_code ?? null, o.action, o.action_label || o.action,
      o.snapshot_before ?? null, o.snapshot_after ?? null, o.changed_fields ?? null,
      o.is_danger ?? 0, o.reason ?? null, 'probe', 'script')

  inSavepoint(() => {
    insertLog({ target_type: 'def', report_code: 'bs', action: 'weird', action_label: '怪动作', snapshot_after: JSON.stringify(BS_DEF) })
    const c = codesOf(RCA.auditReportConfigTrail(db))
    ok(c.includes('REPORT_CONFIG_AUDIT_UNKNOWN_ACTION'), '① 不认识的动作 → UNKNOWN_ACTION', JSON.stringify(c))
  })

  inSavepoint(() => {
    // 一条 delete 记录没有 before —— 正是"删了什么查不出"的形状
    insertLog({ target_type: 'line', report_code: 'zz', line_code: 'ZZ_1', action: 'delete', action_label: '删除口径', is_danger: 1, reason: 'x' })
    const c = codesOf(RCA.auditReportConfigTrail(db))
    ok(c.includes('REPORT_CONFIG_AUDIT_SNAPSHOT_MISSING'), '② 快照缺失 → SNAPSHOT_MISSING', JSON.stringify(c))
  })

  inSavepoint(() => {
    insertLog({ target_type: 'line', report_code: 'zz', line_code: 'ZZ_2', action: 'create', action_label: '新增口径', snapshot_after: '{这不是 JSON', is_danger: 1, reason: 'x' })
    const c = codesOf(RCA.auditReportConfigTrail(db))
    ok(c.includes('REPORT_CONFIG_AUDIT_SNAPSHOT_BROKEN'), '③ 快照不是合法 JSON → SNAPSHOT_BROKEN', JSON.stringify(c))
  })

  inSavepoint(() => {
    insertLog({
      target_type: 'line', report_code: sample.report_code, line_code: sample.line_code, action: 'update',
      action_label: '修改口径', snapshot_before: JSON.stringify(RCA.pickSnapshot('line', sample)),
      snapshot_after: JSON.stringify(RCA.pickSnapshot('line', sample)), is_danger: 1, reason: null
    })
    const c = codesOf(RCA.auditReportConfigTrail(db))
    ok(c.includes('REPORT_CONFIG_AUDIT_REASON_REQUIRED'), '④ 危险改动没写理由 → REASON_REQUIRED', JSON.stringify(c))
  })

  inSavepoint(() => {
    // 现状里有这一行、历史里一条都没有 ⇒ 只报 UNTRACKED，**不**同时报 DESYNC
    db.prepare("DELETE FROM report_config_audit_log WHERE target_type='line' AND report_code=? AND line_code=?").run(sample.report_code, sample.line_code)
    const t = RCA.auditReportConfigTrail(db)
    const c = codesOf(t)
    ok(c.includes('REPORT_CONFIG_UNTRACKED'), '⑤ 有行无历史 → UNTRACKED（初始化没跑 / 绕过写入点插入）', JSON.stringify(c))
    ok(!c.includes('REPORT_CONFIG_AUDIT_DESYNC'),
      '⑤ 且**不**同时报 DESYNC —— 两个闸门互斥，排障的人不用在两个原因之间猜',
      JSON.stringify(c))
    ok((t.problems.find((p) => p.code === 'REPORT_CONFIG_UNTRACKED')?.detail?.keys || []).some((k) => k.includes(sample.line_code)),
      '⑤ UNTRACKED 指名道姓说了是哪一行')
  })

  inSavepoint(() => {
    // 有历史、但有人绕过写入点直接改库 ⇒ 只报 DESYNC
    db.prepare('UPDATE report_lines SET line_name=? WHERE report_code=? AND line_code=?').run('绕过写入点改的名字', sample.report_code, sample.line_code)
    const t = RCA.auditReportConfigTrail(db)
    const c = codesOf(t)
    ok(c.includes('REPORT_CONFIG_AUDIT_DESYNC'), '⑥ 绕过写入点改库 → DESYNC', JSON.stringify(c))
    ok(!c.includes('REPORT_CONFIG_UNTRACKED'), '⑥ 且不报 UNTRACKED（这一行有历史）', JSON.stringify(c))
    ok((t.problems.find((p) => p.code === 'REPORT_CONFIG_AUDIT_DESYNC')?.detail?.items || []).some((k) => k.includes('行名称')),
      '⑥ DESYNC 指出是**哪个字段**对不上（不是只说"有 1 处不一致"）')
  })

  inSavepoint(() => {
    // 现状里有一行口径挂在**不存在的报表**上（report_lines 不做外键）
    db.prepare("INSERT INTO report_lines (report_code,line_code,line_no,line_name,line_type,subject_range,sign,order_no) VALUES ('zz','ZZ_ORPHAN',1,'孤儿行','item','1999~1999',1,1)").run()
    const orphan = db.prepare("SELECT * FROM report_lines WHERE line_code='ZZ_ORPHAN'").get()
    // 给它一条基线，否则它会同时触发 UNTRACKED —— 一条断言只该被一个原因守着
    insertLog({ target_type: 'line', report_code: 'zz', line_code: 'ZZ_ORPHAN', action: 'baseline', action_label: '基线',
      snapshot_after: JSON.stringify(RCA.pickSnapshot('line', orphan)) })
    const c = codesOf(RCA.auditReportConfigTrail(db))
    ok(c.includes('REPORT_CONFIG_LINE_ORPHAN'), '⑦ 口径行挂在不存在的报表上 → LINE_ORPHAN', JSON.stringify(c))
    ok(!c.includes('REPORT_CONFIG_UNTRACKED'), '⑦ 且不报 UNTRACKED（基线给了它历史）', JSON.stringify(c))
  })

  inSavepoint(() => {
    // 表里加一列而没人登记进 SNAPSHOT_FIELDS ⇒ 那一列既不留痕也不参与重放比对
    db.exec('ALTER TABLE report_lines ADD COLUMN tmp_probe_col TEXT')
    const t = RCA.auditReportConfigTrail(db)
    ok(codesOf(t).includes('REPORT_CONFIG_FIELD_GAP'), '⑧ 表里有列没被 SNAPSHOT_FIELDS 声明 → FIELD_GAP', JSON.stringify(codesOf(t)))
    ok((t.problems.find((p) => p.code === 'REPORT_CONFIG_FIELD_GAP')?.detail?.gaps || []).some((g) => g.includes('tmp_probe_col')),
      '⑧ FIELD_GAP 指出了具体是哪一列')
  })
  // 回滚之后这条列应该没了 —— 顺带证明"这条红是注入造成的"
  eq('回滚之后探针表的列没变', db.prepare('PRAGMA table_info(report_lines)').all().length, RCA.SNAPSHOT_FIELDS.line.length)
  ok(RCA.auditReportConfigTrail(db).ok, '八条探针跑完（全部回滚）之后自证回绿')
}

// ===========================================================================
section('S12 接进 auditReport 第 ⑫ 条 —— 关账前置会检查口径的可信度')
{
  inSavepoint(() => {
    ok(R.auditReport(db, { period: '2026-10' }).ok, '干净状态：auditReport 通过')

    const sample = ITEM[0]
    db.prepare('UPDATE report_lines SET line_name=? WHERE report_code=? AND line_code=?').run('偷偷改的名字', sample.report_code, sample.line_code)
    const a = R.auditReport(db, { period: '2026-10' })
    eq('绕过写入点改口径 → auditReport 不通过', a.ok, false)
    ok(codesOf(a).includes('REPORT_CONFIG_AUDIT_DESYNC'), 'auditReport 报出了口径链的问题', JSON.stringify(codesOf(a)))
    ok(a.report_config_checked > 0, `auditReport 报了它核了多少条口径记录（${a.report_config_checked}）`)
  })
  // 这条不是形式主义：`closePeriod` 的前置就是 `auditReport`，
  // 所以"口径被改过却说不清"与"账不平"一样会**挡住关账**。
  ok(R.auditReport(db, { period: '2026-10' }).ok, '回滚之后 auditReport 立刻回绿')
}

// ===========================================================================
section('S13 查询接口：过滤 / 截断 / 把快照展开成人话')
{
  inSavepoint(() => {
    const target = ITEM[0]
    R.saveReportLine(db, payloadOf(target, { subject_range: '1996~1996', line_name: `${target.line_name}（S13）` }), { actor, reason: '测试：S13' })

    const byCode = RCA.listReportConfigAudit(db, { reportCode: 'bs', limit: 200 })
    eq('按报表过滤：每一条都是这张报表', byCode.rows.every((r) => r.report_code === 'bs'), true)
    eq('倒序：第一条是最新的', byCode.rows[0].changed_labels.length > 0, true)

    const danger = RCA.listReportConfigAudit(db, { dangerOnly: true, limit: 200 })
    eq('只看危险改动：每一条都是危险改动', danger.rows.every((r) => r.is_danger), true)

    const one = RCA.listReportConfigAudit(db, { reportCode: 'bs', action: 'update', limit: 200 }).rows.find((r) => r.reason === '测试：S13')
    ok(!!one, '按动作过滤能拿到刚才那条 update')
    eq('标题是人话（行名）', one.title, `${target.line_name}（S13）`)
    eq('目标类型给了中文名', one.target_label, '报表口径行')

    const subject = one.changed.find((c) => c.field === 'subject_range') || {}
    eq('changed 里"科目区间"这一条带改前值', subject.before, target.subject_range)
    eq('changed 里"科目区间"这一条带改后值', subject.after, '1996~1996')
    eq('changed 里标记了它是危险字段', subject.danger, true)
    eq('changed 里带了中文字段名', subject.label, '科目区间')

    const nameOnly = RCA.listReportConfigAudit(db, { reportCode: 'bs', action: 'update', limit: 200 }).rows
      .find((r) => r.changed.length === 1 && r.changed[0].field === 'line_name')
    ok(!nameOnly || nameOnly.changed[0].danger === false, '纯展示字段不会被标成危险')

    const small = RCA.listReportConfigAudit(db, { limit: 3 })
    eq('limit 生效', small.rows.length, 3)
    ok(small.total >= small.filtered, `total(${small.total}) >= 本次返回(${small.filtered})`)

    const m = RCA.meta(db)
    eq('meta 给出四种动作', m.actions.length, 4)
    eq('meta 给出两种目标', m.targets.length, 2)
    ok(m.entries > 0 && m.baselines > 0, `meta 报了记录数 ${m.entries}（基线 ${m.baselines}）`)
    eq('meta 的危险字段与判据同源', m.danger_fields.line, RCA.REPORT_CONFIG_DANGER_FIELDS.line)
  })
}

// ===========================================================================
section('S14 无副作用：三张表一行都不多')
{
  eq('report_defs 行数不变', db.prepare('SELECT COUNT(*) c FROM report_defs').get().c, base.defs)
  eq('report_lines 行数不变', db.prepare('SELECT COUNT(*) c FROM report_lines').get().c, base.lines)
  eq('**口径变更日志表**一行都不多', db.prepare('SELECT COUNT(*) c FROM report_config_audit_log').get().c, base.log)
  eq('日志表的最大 id 也没有前移（防"删几条又插几条"）',
    db.prepare('SELECT COALESCE(MAX(id),0) m FROM report_config_audit_log').get().m, base.logMaxId)
  eq('口径行表的最大 id 也没有前移（**服务每启动一次换一代 id** 那个缺陷的守卫）',
    db.prepare('SELECT COALESCE(MAX(id),0) m FROM report_lines').get().m, base.lineIdSeq)
  eq('没有残留测试造的口径行', db.prepare("SELECT COUNT(*) c FROM report_lines WHERE line_code LIKE 'BS_TEST%' OR line_code LIKE 'ZZ_%'").get().c, 0)
  eq('没有残留测试造的日志', db.prepare("SELECT COUNT(*) c FROM report_config_audit_log WHERE report_code='zz' OR actor_name='probe'").get().c, 0)
  const t = RCA.auditReportConfigTrail(db)
  ok(t.ok, `收尾：报表口径变更链仍然自洽（${t.entries_checked} 条记录）`
    + (t.ok ? '' : `；异常：${codesOf(t).join(',')}`))
  ok(R.auditReport(db, { period: '2026-10' }).ok, '收尾：auditReport 仍然通过')
}

// ===========================================================================
section('S15 种子重跑**不再动口径** —— 服务每启动一次就换一代 id 的那个缺陷')
{
  // 这一条是这一批**顺带抓到的真实缺陷**的守卫，不是形式主义：
  // 原来 `seedReport` 在 `bootIndustry` 里**每次启动都会跑**，而它无条件
  // `DELETE FROM report_lines` 再整段重插 ⇒ 每重启一次服务，自增 id 就换一代
  // （实测 1~44 → 45~88）。两个后果：
  //   ① 人在界面上改过的口径被 seed **静默覆盖回去** —— 会计政策不是能被启动覆盖的东西；
  //   ② 任何"按 id 指向报表行"的记录指向了**另一个世界**，而那个 id 合法存在，
  //      所以按 id 的孤儿检查一条都发现不了（旧审计里那句 `report_line:<id>` 就是这样）；
  //   ③ 我这一批的整行快照会全部对不上 ⇒ 探针报一整片假红。
  // 修法：口径与**期初余额**同一条口径 —— **已有就不再重写**。
  inSavepoint(() => {
    const idsBefore = db.prepare('SELECT id FROM report_lines ORDER BY id').all().map((r) => r.id).join(',')
    const logBefore = db.prepare('SELECT COUNT(*) c FROM report_config_audit_log').get().c
    const defsBefore = db.prepare('SELECT report_code, name, basis, cover_categories, status FROM report_defs ORDER BY report_code').all()

    // 模拟"人在界面上改过一行口径"（走唯一写入点，带理由）
    const target = ITEM[0]
    R.saveReportLine(db, payloadOf(target, { line_name: `${target.line_name}（人改的）` }), { actor, reason: '测试：模拟人改口径' })
    const logAfterEdit = db.prepare('SELECT COUNT(*) c FROM report_config_audit_log').get().c
    eq('人改一次口径 → 多一条记录', logAfterEdit, logBefore + 1)

    // **重跑种子**（等价于服务再启动一次）
    seedReport(db, { silent: true })

    eq('重跑种子之后口径行的自增 id 一代都没换', db.prepare('SELECT id FROM report_lines ORDER BY id').all().map((r) => r.id).join(','), idsBefore)
    eq('重跑种子不产生任何新的口径变更记录', db.prepare('SELECT COUNT(*) c FROM report_config_audit_log').get().c, logAfterEdit)
    eq('**人改过的那一行没有被启动撤销**', lineRow(target.report_code, target.line_code).line_name, `${target.line_name}（人改的）`)
    eq('报表定义也没有被启动覆盖', db.prepare('SELECT report_code, name, basis, cover_categories, status FROM report_defs ORDER BY report_code').all(), defsBefore)
    ok(RCA.auditReportConfigTrail(db).ok, '重跑种子之后重放仍然自洽（这一条就是那个缺陷的守卫）')
  })
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) console.log(`失败项：\n  - ${failures.slice(0, 12).join('\n  - ')}`)
process.exit(fail === 0 ? 0 : 1)
