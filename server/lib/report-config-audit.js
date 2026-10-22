/**
 * ============================================================================
 * 文件标识：server/lib/report-config-audit.js ｜ 报表口径变更留痕（批次 S）
 * ============================================================================
 * 【职责】报表口径变更留痕（批次 S）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 报表口径变更留痕（批次 S）
//
// ===========================================================================
// 一、这一批补的是「会计政策改了，只留下一句"保存成功"」
// ===========================================================================
// `034_report` 把报表结构从代码搬进库，理由是**它是会计政策**：科目区间与方向口径
// 决定"哪些科目算进哪一行"，改一行能让同一份账算出不同的利润。接口也建了
// （`PUT /reports/defs/{code}` / `POST /reports/lines` / `DELETE /reports/lines/{id}`），
// 而实际落下来的只有一条通用审计：
//
//     audit(req, { action: 'finance.report.line.save',
//                  target: `report_line:bs/BS_CASH`, detail: { line_no: 1 } })   ← 只有一个行号
//     audit(req, { action: 'finance.report.line.delete',
//                  target: `report_line:37` })                                  ← 只有一个自增 id
//
// 三个后果都是"事后答不出来"：
//   ① **删掉一行之后再问"删了什么"，查不出来**。`report_lines` 是物理删除，
//      日志里只有 `report_line:37`，而 37 已经不存在了 —— 日志指向一个空。
//   ② **改了什么，看不出来**。`subject_range` 从 `'1122~1122'` 改成
//      `'1122~1122|2203~2203'`、`sign` 从 +1 改成 −1、往资产负债表上加一行
//      `only_direction` —— 三种改动留下的记录完全一样。
//   ③ **报表定义只有 `basis` 有痕**，而 `cover_categories` 决定"这张表必须穷尽
//      覆盖哪些科目大类"（少覆盖一个大类就是少一块钱）。
//
// 本文件与 `039_report_config_audit.cjs` 一起补齐它：一张只追加的日志表、
// 一个唯一写入点、一套只读自证。
//
// ===========================================================================
// 二、危险判据与批次 R **不同**，这里是差分驱动的
// ===========================================================================
// 批次 R 里危险是**键的属性**（`SETTING_RULES[key].is_danger`）—— 一个键的含义固定，
// `closing_profit_subject` 永远是会计政策。
//
// 这里不行：同一行 `line_name` 从"存货"改成"库存商品"是纯展示，
// 而它的 `subject_range` 从 `'1405~1405'` 改成 `'1405~1408'` 是会计政策。
// 危险不是"这一行危险"，而是**这一次改动动了哪个字段**。
//
// 于是只有一条规则，没有特例：
//
//     危险 ⇔ changedFields 与 REPORT_CONFIG_DANGER_FIELDS[type] 有交集
//
// 它在四种动作上都给出正确答案，靠的是 `changedFields` 的定义：
//   · `baseline` → `[]`                        ⇒ 不危险（它不是谁的动作）；
//   · `create`   → **全部字段**                 ⇒ 危险（新增一行会让报表多一块）；
//   · `delete`   → **全部字段**（全部消失了）    ⇒ 危险（不可逆）；
//   · `update`   → 真正变了的字段                ⇒ 只有动了危险字段才危险。
//
// 所以"加一行口径"天然需要理由 —— 这是对的：加一行同样在改会计政策。
// 而只改 `line_name` / `display_no` / `level` / `order_no` / `remark`
// **不需要**理由 —— 它们不进任何金额。要求给它们写理由只会训练人写"调整显示"，
// 而理由一旦可以随便填就退化成噪音（与批次 R 拒绝给 `reset` 自动补一句
// "恢复默认值"同一条理由）。
//
// ===========================================================================
// 三、日志存**整行快照**，不是字段差分
// ===========================================================================
// 期间审计链（批次 Q）存"四个指针字段的改后值"，因为期间的状态就是四个字段。
// 报表口径的状态是**一百多行**，差分表达不了 `create` / `delete`，
// 而 `delete` 恰恰是最需要留完整内容的那一种。
//
// 所以每次记录存两份整行 JSON（`snapshot_before` / `snapshot_after`）。
// 一份快照同时解决三件事：删除后仍答得出"删的是什么"、重放能重建整张表、
// 「改前改后」能并排显示。
//
// ===========================================================================
// 四、重放：从空状态重建整张表
// ===========================================================================
// 期间链的不变量是"重放 == 四个字段"。这里的是：
//
//     从空状态开始，按 id 顺序应用每一条日志，得到的必须是今天
//     `report_defs` + `report_lines` 的**全部内容**（逐行、逐字段）。
//
// 两条路径出处不同：现状来自 `INSERT` / `DELETE`，历史来自本文件的唯一写入点。
// 所以它抓得到"改了没记""记了没改"。
//
// 盲区**必须划清**（批次 P 的教训：先问两条路径共享什么）：
//   · 两者共享"身份键"（`report_code` / `line_code`）。身份键错了会一起错 ——
//     由 `REPORT_CONFIG_FIELD_GAP`（表列必须全被 `SNAPSHOT_FIELDS` 声明）
//     与 `REPORT_CONFIG_AUDIT_SNAPSHOT_MISSING`（快照必须整份）从侧面守着；
//   · 抓不到"既没改库也没写日志" —— 留痕上的这种情形不存在（没有状态可藏）。
//
// ===========================================================================
// 五、两个闸门互斥：一条断言只被一个原因守着
// ===========================================================================
// "现状里有这一行、历史里没有" 与 "历史里有、两边的值对不上" 都会让重放失败，
// 但它们是**两种不同的病**（前者 = 初始化没跑 / 有人绕过写入点插入；
// 后者 = 改了没记或记了没改）。
// 如果两条都报，排障的人要在两条断言之间猜谁是真因。
// 所以 `REPORT_CONFIG_UNTRACKED` **只**报"这一行一条历史都没有"，
// 而 `REPORT_CONFIG_AUDIT_DESYNC` **只**比对"至少有一条历史"的行 —— 二者互斥。
//
// ===========================================================================
// 六、`SNAPSHOT_FIELDS` 是一条显式的代价，而且它被探针守着
// ===========================================================================
// 以后给 `report_lines` 加一列而没人登记它，那一列就**既不在留痕范围、
// 也不在重放比对范围** —— 一个会安静扩大的盲区。
// 所以 `REPORT_CONFIG_FIELD_GAP` 直接对比 `PRAGMA table_info` 与 `SNAPSHOT_FIELDS`：
// 表里有、清单里没有的列 ⇒ 报出来。
// 「唯一出处」必须能被机器核对，不能只写在注释里（批次 P 的教训）。
//
// ===========================================================================
// 七、初始化入口：基线由 `ensureReportConfigTrail` 补，与种子走同一条代码
// ===========================================================================
// 迁移 039 **只建表**。基线（"在我们开始记日志之前，库里的口径是什么"）
// 统一由 `ensureReportConfigTrail` 补 —— 与批次 R 的 `ensureSettings` 同构，理由也一样：
//   · **升级路径与重建路径走同一条代码**。重建会把 `report_lines` / `report_defs`
//     与日志一起清掉（都在 `db/seed.js` 的清理清单里），之后由本函数重新补基线；
//   · 迁移里**不需要抄一份字段清单**（迁移是 CommonJS、定义是 ESM，
//     抄一份就是第二个定义）。
//
// `seedReport` 走的是 `saveReportDef` / `saveReportLine` 的唯一实现，
// 但**明确关掉留痕**（`{ audit: false }`），否则两条路径的日志内容会不一样
// （重建路径 = 一百多条 `create`；升级路径 = 一百多条 `baseline`）。
// 关掉之后两条路径都只有基线，产物完全一致。
//
// ===========================================================================
// 八、为什么不加权限点
// ===========================================================================
// 改口径本来就限 `finance.report.config`；看历史复用 `finance.report.view` ——
// 能看报表的人已经能看到口径本身。日志给的是同一个信息集合的**历史**，
// 不是新的信息类别。与批次 Q / R 同一条理由。

export class ReportConfigAuditError extends Error {
  constructor(code, message, http = 400, detail = null) {
    super(message)
    this.code = code
    this.http = http
    // 与 `ReportError` / `SettingError` / `PeriodAuditError` 同一条：HTTP 层只认 `.status`
    this.status = http
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// 一、动作表 —— **全项目唯一的「动作 ↔ 效果」定义**
// ---------------------------------------------------------------------------
/**
 * 四个动作 + 基线。`effect` 的含义：
 *   · `'snapshot'` —— 整行快照（`baseline` 专用：它不是谁的动作，是"日志开始前的现状"）；
 *   · `'upsert'`   —— 让这一行的内容**变成** `snapshot_after`；
 *   · `'remove'`   —— 把这一行从状态里去掉。
 * `requires_reason` 不在这里声明 —— 见文件头第二节：危险是**差分驱动**的，
 * 不可能是动作的属性（同一个 `update` 改 `line_name` 不需要理由、改 `subject_range` 需要）。
 */
export const REPORT_CONFIG_ACTIONS = {
  baseline: { label: '基线（初始化时的现状快照）', effect: 'snapshot' },
  create: { label: '新增口径', effect: 'upsert' },
  update: { label: '修改口径', effect: 'upsert' },
  delete: { label: '删除口径', effect: 'remove' }
}

export const REPORT_CONFIG_ACTION_KEYS = Object.keys(REPORT_CONFIG_ACTIONS)

/** 目标类型。`def` = 一张报表的定义，`line` = 报表里的一行口径。 */
export const REPORT_CONFIG_TARGETS = ['def', 'line']

/**
 * 快照字段 —— 每一类目标**落库的全部列**，也是重放比对的全部字段。
 *
 * ⚠️ 这是一条**显式的代价**：以后给 `report_defs` / `report_lines` 加一列而没登记进来，
 * 那一列就不在留痕与重放范围内。所以 `REPORT_CONFIG_FIELD_GAP` 探针会拿
 * `PRAGMA table_info` 跟它对齐 —— 加了列不登记，`auditReport` 会报。
 * 顺序无关紧要，但必须**完备**。
 */
export const SNAPSHOT_FIELDS = {
  def: ['id', 'report_code', 'name', 'basis', 'cash_subjects', 'cover_categories', 'remark', 'status', 'created_at', 'updated_at'],
  line: ['id', 'report_code', 'line_code', 'line_no', 'display_no', 'line_name', 'line_type', 'level', 'subject_range', 'sign', 'only_direction', 'subtotal_expr', 'is_fallback', 'order_no', 'remark']
}

/**
 * 危险字段 —— 改到它们就是**会计政策**变更（而不是展示变更）。**全项目唯一的判据**。
 *
 * `def`：`basis` 换一套取数口径；`cash_subjects` 决定现金流量表认哪些是现金；
 *        `cover_categories` 决定"必须穷尽覆盖哪些科目大类"（少一大类就是少一块钱）；
 *        `status` 停用一张表。
 * `line`：`line_no` 是小计表达式的引用锚点；`line_type` 决定这一行怎么取值；
 *        `subject_range` 是"哪些科目算进这一行"；`sign` 是方向口径；
 *        `only_direction` 是现金流方向过滤；`subtotal_expr` 是"哪几行加起来"；
 *        `is_fallback` 是兜底行（"其它行都不认领才接"）。
 *
 * **刻意不含**：`line_name` / `display_no` / `level` / `order_no` / `remark`（纯展示）
 * 与 `created_at` / `updated_at`（时间戳不是内容）。
 */
export const REPORT_CONFIG_DANGER_FIELDS = {
  def: ['report_code', 'basis', 'cash_subjects', 'cover_categories', 'status'],
  line: ['report_code', 'line_code', 'line_no', 'line_type', 'subject_range', 'sign', 'only_direction', 'subtotal_expr', 'is_fallback']
}

/** 字段中文名（界面与历史显示的唯一出处 —— 界面不自己拼字段名）。 */
export const REPORT_CONFIG_FIELD_LABELS = {
  id: '内部 ID',
  report_code: '报表代码',
  line_code: '行机器键',
  name: '报表名称',
  basis: '取数口径',
  cash_subjects: '现金类科目',
  cover_categories: '须覆盖的科目大类',
  remark: '备注',
  status: '状态',
  line_no: '行号（小计引用锚点）',
  display_no: '显示行次',
  line_name: '行名称',
  line_type: '行类型',
  level: '缩进层级',
  subject_range: '科目区间',
  sign: '方向系数',
  only_direction: '方向过滤',
  subtotal_expr: '小计表达式',
  is_fallback: '兜底行',
  order_no: '排序号',
  created_at: '创建时间',
  updated_at: '更新时间'
}

export const REPORT_CONFIG_TARGET_LABELS = { def: '报表定义', line: '报表口径行' }

// ---------------------------------------------------------------------------
// 二、纯函数：身份键 / 快照裁剪 / 差分 / 危险判定
// ---------------------------------------------------------------------------
/** 一行目标的**身份键**：定义按 `report_code`，口径行按 `report_code + line_code`。 */
export const keyOf = (targetType, row) =>
  targetType === 'def' ? String(row.report_code) : `${row.report_code}/${row.line_code}`

/** 只保留 `SNAPSHOT_FIELDS` 里的列，且把 `undefined` 归一成 `null`（JSON 往返后两边同形）。 */
export function pickSnapshot(targetType, row) {
  const fields = SNAPSHOT_FIELDS[targetType] || []
  const out = {}
  for (const f of fields) out[f] = row && row[f] !== undefined ? row[f] : null
  return out
}

/** 两侧快照的列级差分。`before` 为 NULL（新增 / 基线）时返回全部字段。 */
export function diffSnapshot(targetType, before, after) {
  const fields = SNAPSHOT_FIELDS[targetType] || []
  const b = before || {}
  const a = after || {}
  const changed = []
  for (const f of fields) {
    const x = b[f] === undefined ? null : b[f]
    const y = a[f] === undefined ? null : a[f]
    // 数字与字符串统一成字符串再比：SQLite 里 `1` 与 `'1'` 都可能出现，
    // 而"值没变"这件事不该因为 JS 类型而判成变了（否则每次保存都写一条无意义的日志）。
    if (String(x) !== String(y)) changed.push(f)
  }
  return changed
}

/**
 * 危险判定 —— **全项目唯一**。见文件头第二节：差分驱动，一条规则覆盖四种动作。
 */
export function isDangerChange(targetType, action, changedFields = []) {
  if (action === 'baseline') return false
  const danger = REPORT_CONFIG_DANGER_FIELDS[targetType] || []
  return changedFields.some((f) => danger.includes(f))
}

/** `changedFields` 的中文名列表（界面直接用，不自己拼）。 */
export const labelFields = (fields = []) => fields.map((f) => REPORT_CONFIG_FIELD_LABELS[f] || f)

// ---------------------------------------------------------------------------
// 三、唯一写入点
// ---------------------------------------------------------------------------
/**
 * 写一条报表口径变更日志。**全项目唯一**的写法（只有一个 INSERT）。
 *
 * 调用约定（六条都会被**当场断言**，不是文档里的建议）：
 *   ① 必须在事务里 —— 日志与它记录的那次改动同生共死；
 *   ② `action` 必须是 `REPORT_CONFIG_ACTIONS` 里的名字；
 *   ③ `targetType` 必须是 `def` / `line`；
 *   ④ 快照必须完整：`create` / `baseline` 要有 `after`，`delete` 要有 `before`，
 *      `update` 两边都要 —— **缺一个就是一条指向空的记录**，而那正是这一批
 *      要根治的原始缺陷（原来删除只记 `report_line:37`）；
 *   ⑤ 危险改动必须带 `reason`；
 *   ⑥ 快照里不能出现 `SNAPSHOT_FIELDS` 之外的列 —— 落进去也不会被重放比对，
 *      属于"记了但不算数"，宁可炸。
 */
export function logReportConfigChange(db, {
  targetType,
  reportCode,
  lineCode = null,
  action,
  before = null,
  after = null,
  reason = null,
  actor = null,
  detail = null
} = {}) {
  const spec = REPORT_CONFIG_ACTIONS[action]
  if (!spec) {
    throw new ReportConfigAuditError(
      'REPORT_CONFIG_AUDIT_UNKNOWN_ACTION',
      `报表口径审计不认识动作「${action}」；动作名必须来自 lib/report-config-audit.js 的 REPORT_CONFIG_ACTIONS`,
      500, { action }
    )
  }
  if (!REPORT_CONFIG_TARGETS.includes(targetType)) {
    throw new ReportConfigAuditError(
      'REPORT_CONFIG_AUDIT_UNKNOWN_TARGET',
      `报表口径审计不认识目标类型「${targetType}」（应为 ${REPORT_CONFIG_TARGETS.join(' / ')}）`,
      500, { target_type: targetType }
    )
  }
  if (!db.inTransaction) {
    throw new ReportConfigAuditError(
      'AUDIT_OUTSIDE_TX',
      `报表口径「${reportCode}${lineCode ? `/${lineCode}` : ''}」的变更日志必须在事务内写入 —— 否则会出现"口径改了、日志没写"或反之`,
      500, { report_code: reportCode, line_code: lineCode, action }
    )
  }
  const b = before ? pickSnapshot(targetType, before) : null
  const a = after ? pickSnapshot(targetType, after) : null
  if ((action === 'create' || action === 'baseline') && !a) {
    throw new ReportConfigAuditError(
      'REPORT_CONFIG_AUDIT_SNAPSHOT_MISSING',
      `动作「${spec.label}」必须留改动后的**整行快照**（目标 ${reportCode}${lineCode ? `/${lineCode}` : ''}）`,
      500, { action, report_code: reportCode, line_code: lineCode }
    )
  }
  if (action === 'delete' && !b) {
    throw new ReportConfigAuditError(
      'REPORT_CONFIG_AUDIT_SNAPSHOT_MISSING',
      `动作「${spec.label}」必须留删除前的**整行快照**（目标 ${reportCode}${lineCode ? `/${lineCode}` : ''}）—— report_lines 是物理删除，不留它就等于没留痕`,
      500, { action, report_code: reportCode, line_code: lineCode }
    )
  }
  if (action === 'update' && (!b || !a)) {
    throw new ReportConfigAuditError(
      'REPORT_CONFIG_AUDIT_SNAPSHOT_MISSING',
      `动作「${spec.label}」必须同时留改动前后的整行快照（目标 ${reportCode}${lineCode ? `/${lineCode}` : ''}）`,
      500, { action, report_code: reportCode, line_code: lineCode }
    )
  }

  // `changedFields` 的定义见文件头第二节 —— 它同时决定了重放以外的两个用途：
  // 界面显示"改了哪几列"、以及危险判定。
  let changedFields
  if (action === 'baseline') changedFields = []
  else if (action === 'create') changedFields = [...SNAPSHOT_FIELDS[targetType]]
  else if (action === 'delete') changedFields = [...SNAPSHOT_FIELDS[targetType]]
  else changedFields = diffSnapshot(targetType, b, a)

  const danger = isDangerChange(targetType, action, changedFields)
  const why = String(reason ?? '').trim()
  if (danger && !why) {
    throw new ReportConfigAuditError(
      'REPORT_CONFIG_REASON_REQUIRED',
      `报表口径 ${REPORT_CONFIG_TARGET_LABELS[targetType]}「${a?.line_name || a?.name || b?.line_name || b?.name || reportCode}」的这次改动属于**会计政策**变更（动了 ${labelFields(changedFields.filter((f) => (REPORT_CONFIG_DANGER_FIELDS[targetType] || []).includes(f))).join('、')}），必须写理由 —— 改它会让同一份账算出不同的数`,
      400, { report_code: reportCode, line_code: lineCode, action, changed_fields: changedFields }
    )
  }

  const info = db
    .prepare(`
      INSERT INTO report_config_audit_log
        (target_type, report_code, line_code, action, action_label,
         snapshot_before, snapshot_after, changed_fields,
         is_danger, reason, actor_id, actor_name, actor_source, detail)
      VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?,?)
    `)
    .run(
      targetType, reportCode, lineCode, action, spec.label,
      b ? JSON.stringify(b) : null,
      a ? JSON.stringify(a) : null,
      changedFields.length ? JSON.stringify(changedFields) : null,
      danger ? 1 : 0, why || null,
      actor?.id ?? null, actor?.name ?? null, actor?.source || 'web',
      detail ? JSON.stringify(detail) : null
    )
  return Number(info.lastInsertRowid)
}

// ---------------------------------------------------------------------------
// 四、重放与现状
// ---------------------------------------------------------------------------
const parseSnapshot = (s) => {
  if (!s) return null
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/**
 * 从日志重放，得到 `report_defs` 与 `report_lines` 的**全部内容**。
 *
 * `entries` 可注入（与 `replaySettings` / `replayPeriodAudit` 同一个用法）：
 * 测试要能拿一份**造出来的**日志去问"如果日志是这样，重放会不会与现状对不上"。
 */
export function replayReportConfig(db, { entries = null } = {}) {
  const log = entries || db.prepare('SELECT * FROM report_config_audit_log ORDER BY id').all()
  const state = { def: {}, line: {} }
  for (const e of log) {
    // 未知动作 / 未知目标类型**在这里跳过**，由各自的探针单独报 ——
    // 在这里再炸一次只会让同一个问题以两种面目出现（与 `replaySettings` 同一条）。
    if (!REPORT_CONFIG_ACTIONS[e.action]) continue
    if (!state[e.target_type]) continue
    const b = parseSnapshot(e.snapshot_before)
    const a = parseSnapshot(e.snapshot_after)
    const anchor = a || b
    if (!anchor) continue
    const k = keyOf(e.target_type, anchor)
    if (a) state[e.target_type][k] = pickSnapshot(e.target_type, a)
    else delete state[e.target_type][k]
  }
  return state
}

/** 库里的现状（与重放结果同形，便于逐字段比对） */
export function reportConfigStateOf(db) {
  const state = { def: {}, line: {} }
  for (const r of db.prepare('SELECT * FROM report_defs').all()) state.def[keyOf('def', r)] = pickSnapshot('def', r)
  for (const r of db.prepare('SELECT * FROM report_lines').all()) state.line[keyOf('line', r)] = pickSnapshot('line', r)
  return state
}

// ---------------------------------------------------------------------------
// 五、初始化：补基线（唯一入口）
// ---------------------------------------------------------------------------
/**
 * 给"库里有这一行、但一条历史都没有"的行补一条 `baseline`。**幂等**。
 *
 * 与 `ensureSettings` 同构的三条理由（见文件头第七节）：
 *   · 升级路径与重建路径走同一条代码；
 *   · 迁移里不用抄字段清单；
 *   · "有历史但行被手工删掉了"的行**不补** —— 补一条基线会把"有人绕过写入点
 *     删了口径"伪装成"它本来就不存在"。探针 `REPORT_CONFIG_AUDIT_DESYNC` 会报出来，
 *     那才是正确的（**绕过唯一写入点就该被发现**）。
 */
export function ensureReportConfigTrail(db, { actor = null } = {}) {
  const tx = db.transaction(() => {
    let baselines = 0
    const hasLog = db.prepare(
      `SELECT 1 AS hit FROM report_config_audit_log
        WHERE target_type=? AND report_code=? AND line_code IS ? LIMIT 1`
    )
    const sysActor = actor || { id: null, name: null, source: 'system' }

    const targets = [
      { t: 'def', rows: db.prepare('SELECT * FROM report_defs').all() },
      { t: 'line', rows: db.prepare('SELECT * FROM report_lines').all() }
    ]
    for (const { t, rows } of targets) {
      for (const row of rows) {
        const lineCode = t === 'line' ? String(row.line_code) : null
        if (hasLog.get(t, String(row.report_code), lineCode)) continue
        logReportConfigChange(db, {
          targetType: t,
          reportCode: String(row.report_code),
          lineCode,
          action: 'baseline',
          after: row,
          actor: sysActor
        })
        baselines += 1
      }
    }
    return { baselines, defs: targets[0].rows.length, lines: targets[1].rows.length }
  })
  return tx()
}

// ---------------------------------------------------------------------------
// 六、自证（探针）
// ---------------------------------------------------------------------------
/**
 * 报表口径变更链的全部不变量。**全库扫描**，不是"只查界面上正在看的那几条"。
 *
 * 八条：
 *   ① `REPORT_CONFIG_AUDIT_UNKNOWN_ACTION` —— 动作名必须是代码认识的；
 *   ② `REPORT_CONFIG_AUDIT_SNAPSHOT_MISSING` —— 快照必须整份（"删了什么查不出来"的机械守卫）；
 *   ③ `REPORT_CONFIG_AUDIT_SNAPSHOT_BROKEN` —— 快照必须是可解析的 JSON；
 *   ④ `REPORT_CONFIG_AUDIT_REASON_REQUIRED` —— 危险改动必须写理由；
 *   ⑤ `REPORT_CONFIG_UNTRACKED` —— 现状里有行、历史里一条都没有
 *      （**只报这一种**：初始化没跑 / 有人绕过写入点插入）；
 *   ⑥ `REPORT_CONFIG_AUDIT_DESYNC` —— 有历史的行重放不出来
 *      （**只比对至少有一条历史的行** —— 与 ⑤ 互斥，见文件头第五节）；
 *   ⑦ `REPORT_CONFIG_LINE_ORPHAN` —— 现状里有一行口径，它挂的报表定义不存在；
 *   ⑧ `REPORT_CONFIG_FIELD_GAP` —— 表里有列没被 `SNAPSHOT_FIELDS` 声明
 *      （安静扩大的盲区，见文件头第六节）。
 */
export function auditReportConfigTrail(db, { log = null, state = null } = {}) {
  const problems = []
  const push = (code, message, detail = null) => problems.push({ code, message, detail })

  const known = REPORT_CONFIG_ACTION_KEYS
  const allLog = log || db.prepare('SELECT * FROM report_config_audit_log ORDER BY id').all()
  const now = state || reportConfigStateOf(db)

  // ① 动作名必须是代码认识的
  const unknownActions = [...new Set(allLog.map((r) => r.action))].filter((a) => !known.includes(a))
  if (unknownActions.length) {
    push('REPORT_CONFIG_AUDIT_UNKNOWN_ACTION', `报表口径变更日志里出现了代码不认识的动作：${unknownActions.join('、')}（唯一的写入点是 lib/report-config-audit.js 的 logReportConfigChange）`, { actions: unknownActions })
  }

  // ② 快照完整性 —— 这条直接对着"删掉一行之后查不出删了什么"这个原始缺陷。
  //    结构与迁移 039 的 `verify()` 同源，但这里是**运行时**守（迁移只在升级那一刻跑）。
  const missing = allLog.filter((r) => {
    if (r.action === 'create' || r.action === 'baseline') return !r.snapshot_after
    if (r.action === 'delete') return !r.snapshot_before
    if (r.action === 'update') return !r.snapshot_before || !r.snapshot_after
    return false
  })
  if (missing.length) {
    push('REPORT_CONFIG_AUDIT_SNAPSHOT_MISSING', `有 ${missing.length} 条记录的整行快照缺失（如 #${missing[0].id} ${missing[0].action} ${missing[0].report_code}${missing[0].line_code ? `/${missing[0].line_code}` : ''}）—— 缺快照的记录答不出"改前是什么 / 删掉的是什么"`, { entries: missing.slice(0, 5).map((x) => ({ id: x.id, action: x.action, report_code: x.report_code, line_code: x.line_code })) })
  }

  // ③ 快照必须能解析。有人手工插一行乱码不会报错，而重放会安静地跳过它 ——
  //    跳过等于"这一条不算数"，必须报出来。
  const broken = allLog.filter((r) => (r.snapshot_before && !parseSnapshot(r.snapshot_before)) || (r.snapshot_after && !parseSnapshot(r.snapshot_after)))
  if (broken.length) {
    push('REPORT_CONFIG_AUDIT_SNAPSHOT_BROKEN', `有 ${broken.length} 条记录的整行快照不是合法 JSON（如 #${broken[0].id}）—— 重放会跳过它们，于是"这条记录不算数"`, { entries: broken.slice(0, 5).map((x) => x.id) })
  }

  // ④ 危险改动必须有理由
  const noReason = allLog.filter((r) => r.action !== 'baseline' && r.is_danger && !String(r.reason ?? '').trim())
  if (noReason.length) {
    push('REPORT_CONFIG_AUDIT_REASON_REQUIRED', `有 ${noReason.length} 条会计政策变更没写理由（如 ${noReason[0].report_code}${noReason[0].line_code ? `/${noReason[0].line_code}` : ''} 在 ${noReason[0].created_at}）—— 改会计政策却不写为什么，等于把审计链断在这里`, { entries: noReason.slice(0, 5).map((x) => ({ report_code: x.report_code, line_code: x.line_code, action: x.action, at: x.created_at })) })
  }

  // ⑤ 现状里有行、历史里一条都没有。**与 ⑥ 互斥**（见文件头第五节）：
  //    这里报"没历史"，⑥ 只比对"有历史"的行。
  const loggedKeys = { def: new Set(), line: new Set() }
  for (const r of allLog) {
    if (!loggedKeys[r.target_type]) continue
    loggedKeys[r.target_type].add(r.target_type === 'def' ? String(r.report_code) : `${r.report_code}/${r.line_code}`)
  }
  const untracked = []
  for (const t of REPORT_CONFIG_TARGETS) {
    for (const k of Object.keys(now[t])) if (!loggedKeys[t].has(k)) untracked.push(`${t}:${k}`)
  }
  if (untracked.length) {
    push('REPORT_CONFIG_UNTRACKED', `有 ${untracked.length} 条报表口径没有任何变更记录（${untracked.slice(0, 3).join('、')}${untracked.length > 3 ? ' …' : ''}）—— 基线没补上（ensureReportConfigTrail 没跑或没跑全），或者有人绕过唯一写入点直接改了库`, { keys: untracked })
  }

  // ⑥ 重放 ≠ 现状（两条路径互证）。只比对至少有一条历史的行 —— 与 ⑤ 互斥。
  const want = replayReportConfig(db, { entries: allLog })
  const desync = []
  for (const t of REPORT_CONFIG_TARGETS) {
    const keys = new Set([...Object.keys(want[t]), ...Object.keys(now[t])])
    for (const k of keys) {
      if (!loggedKeys[t].has(k)) continue // 无历史的行由 ⑤ 负责，这里不重复报
      const a = want[t][k]
      const b = now[t][k]
      if (!a || !b) {
        desync.push(`${t}:${k} 重放${a ? '有' : '无'}、现状${b ? '有' : '无'}`)
        continue
      }
      const fields = diffSnapshot(t, a, b)
      // `updated_at` 由 `saveReportDef` 的 upsert 写，且不参与"值有没有变"的判定
      // （唯一写入点会在值没变时**根本不写库**，所以它不会造成假红）。
      if (fields.length) desync.push(`${t}:${k} 字段不一致：${labelFields(fields).join('、')}`)
    }
  }
  if (desync.length) {
    push('REPORT_CONFIG_AUDIT_DESYNC', `报表口径的现状无法由变更日志重放出来（${desync.length} 处）：${desync.slice(0, 3).join('；')} —— 说明有改动没留下日志（或日志写了库没改）`, { items: desync.slice(0, 10) })
  }

  // ⑦ 现状里有一行口径挂在**不存在的报表**上。`report_lines` 不做外键约束，
  //    所以这是可能发生的（删掉一张报表定义而不删它的行）。
  const defCodes = new Set(Object.keys(now.def))
  const orphans = []
  for (const r of db.prepare('SELECT report_code, line_code FROM report_lines').all()) {
    if (!defCodes.has(String(r.report_code))) orphans.push(`${r.report_code}/${r.line_code}`)
  }
  if (orphans.length) {
    push('REPORT_CONFIG_LINE_ORPHAN', `有 ${orphans.length} 行报表口径挂在不存在的报表上：${orphans.slice(0, 3).join('、')} —— 它们永远不会出现在任何报表里，也不会被任何探针算进去`, { keys: orphans })
  }

  // ⑧ 表里有列没被 `SNAPSHOT_FIELDS` 声明 —— 那一列既不留痕也不参与重放比对。
  //    这条是"显式代价"的机械守卫（见文件头第六节）。
  const gaps = []
  for (const [t, table] of [['def', 'report_defs'], ['line', 'report_lines']]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    const declared = new Set(SNAPSHOT_FIELDS[t])
    const undeclared = cols.filter((c) => !declared.has(c))
    if (undeclared.length) gaps.push(`${table}：${undeclared.join('、')}`)
  }
  if (gaps.length) {
    push('REPORT_CONFIG_FIELD_GAP', `表结构里有列没被 SNAPSHOT_FIELDS 声明（${gaps.join('；')}）—— 这些列不会被留痕，也不参与重放比对；新增列时必须同时登记进 lib/report-config-audit.js 的 SNAPSHOT_FIELDS`, { gaps })
  }

  return {
    ok: problems.length === 0,
    problems,
    entries_checked: allLog.length,
    defs_checked: Object.keys(now.def).length,
    lines_checked: Object.keys(now.line).length
  }
}

// ---------------------------------------------------------------------------
// 七、查询（界面用）
// ---------------------------------------------------------------------------
/**
 * 变更历史。`changed` 把 `changed_fields` 展开成「字段名 + 改前 + 改后」，
 * 界面直接渲染 —— **界面不自己解析 JSON、也不自己拼字段名**（唯一出处）。
 */
export function listReportConfigAudit(db, { targetType = null, reportCode = null, action = null, dangerOnly = false, limit = 200 } = {}) {
  const where = []
  const args = []
  if (targetType) { where.push('target_type = ?'); args.push(String(targetType)) }
  if (reportCode) { where.push('report_code = ?'); args.push(String(reportCode)) }
  if (action) { where.push('action = ?'); args.push(String(action)) }
  if (dangerOnly) where.push('is_danger = 1')
  const sql = `SELECT * FROM report_config_audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
  // `limit` 走唯一入口：字符串、负数、NaN 都归一成合理值（界面传的是 query 字符串）
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000)
  const rows = db.prepare(sql).all(...args, n)

  const total = db.prepare('SELECT COUNT(*) c FROM report_config_audit_log').get().c
  return {
    rows: rows.map((r) => {
      const before = parseSnapshot(r.snapshot_before)
      const after = parseSnapshot(r.snapshot_after)
      const fields = r.changed_fields ? JSON.parse(r.changed_fields) : []
      return {
        id: r.id,
        target_type: r.target_type,
        target_label: REPORT_CONFIG_TARGET_LABELS[r.target_type] || r.target_type,
        report_code: r.report_code,
        line_code: r.line_code,
        action: r.action,
        action_label: r.action_label,
        title: after?.line_name || after?.name || before?.line_name || before?.name || `${r.report_code}${r.line_code ? `/${r.line_code}` : ''}`,
        changed_fields: fields,
        changed_labels: labelFields(fields),
        changed: fields
          .filter((f) => !['created_at', 'updated_at', 'id'].includes(f))
          .map((f) => ({
            field: f,
            label: REPORT_CONFIG_FIELD_LABELS[f] || f,
            before: before ? before[f] : null,
            after: after ? after[f] : null,
            danger: (REPORT_CONFIG_DANGER_FIELDS[r.target_type] || []).includes(f)
          })),
        // 删除记录的"内容"只能从这里看 —— 这一行在 report_lines 里已经没有了。
        snapshot_before: before,
        snapshot_after: after,
        is_danger: Number(r.is_danger) === 1,
        reason: r.reason,
        actor_name: r.actor_name,
        actor_source: r.actor_source,
        detail: r.detail ? JSON.parse(r.detail) : null,
        created_at: r.created_at
      }
    }),
    total,
    filtered: rows.length,
    limit: n
  }
}

/** 定义表（界面据此渲染下拉与字段说明；也是"有哪些动作 / 哪些字段危险"的唯一出处） */
export function meta(db) {
  return {
    actions: Object.entries(REPORT_CONFIG_ACTIONS).map(([key, v]) => ({ key, label: v.label, effect: v.effect })),
    targets: REPORT_CONFIG_TARGETS.map((t) => ({ key: t, label: REPORT_CONFIG_TARGET_LABELS[t] })),
    danger_fields: REPORT_CONFIG_DANGER_FIELDS,
    snapshot_fields: SNAPSHOT_FIELDS,
    field_labels: REPORT_CONFIG_FIELD_LABELS,
    entries: db.prepare('SELECT COUNT(*) c FROM report_config_audit_log').get().c,
    baselines: db.prepare("SELECT COUNT(*) c FROM report_config_audit_log WHERE action='baseline'").get().c
  }
}

export default {
  ReportConfigAuditError,
  REPORT_CONFIG_ACTIONS,
  REPORT_CONFIG_DANGER_FIELDS,
  REPORT_CONFIG_FIELD_LABELS,
  REPORT_CONFIG_TARGETS,
  SNAPSHOT_FIELDS,
  logReportConfigChange,
  ensureReportConfigTrail,
  replayReportConfig,
  reportConfigStateOf,
  auditReportConfigTrail,
  listReportConfigAudit,
  meta
}
