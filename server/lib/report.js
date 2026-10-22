/**
 * ============================================================================
 * 文件标识：server/lib/report.js ｜ 报表体系（批次 L · 模块 28）：资产负债表 / 利润表 / 现金流量表 + 会计期间 + 期初余额
 * ============================================================================
 * 【职责】报表体系（批次 L · 模块 28）：资产负债表 / 利润表 / 现金流量表 + 会计期间 + 期初余额
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 报表体系（批次 L · 模块 28）：资产负债表 / 利润表 / 现金流量表 + 会计期间 + 期初余额
//
// ===========================================================================
// 一、这份文件要回答的三个问题，以及它们各自的"自证"
// ===========================================================================
// 试算平衡表答的是"总账平不平"。本文件答的是经营者真正要问的三句话：
//   · 有多少家底 → `balanceSheet()`  自证：**资产合计 = 负债合计 + 所有者权益合计**
//   · 这期间赚了多少 → `incomeStatement()`  自证：净利润 = Σ(损益类科目发生额，按方向取号)
//   · 钱怎么来的 → `cashFlow()`  自证：**净增加额 = 现金类科目期末余额 − 期初余额**
//
// 三条自证都不是"再算一遍核对"，而是**数学恒等式**：
//   · 前两条来自"每张凭证借贷平衡"（Σ所有科目 signed 恒为 0）；
//   · 第三条来自"凭证平衡 ⇒ 非现金分录净额 = 现金分录净额"。
// 所以它们不平时**只可能是配置错**（报表行漏了科目 / 期初余额不平），
// 这正是我们想要的探针：报表看起来好看但差一个数，是最难发现的一类错误。
//
// ===========================================================================
// 二、`signed` 口径（三张报表共用的唯一口径）
// ===========================================================================
// 记 `signed(科目) = 借 − 贷`（**方向由分录自身决定，不看科目属性**）。
//   · 余额：`signed = 期初登记(借−贷) + 本期借方发生 − 本期贷方发生`
//   · 发生额：`signed = 本期借方发生 − 本期贷方发生`
//
// 行金额 = `sign × Σ(本行认领科目的 signed)`。
//   资产负债表：资产行 `sign=+1`（借方正即正数）；负债 / 权益行 `sign=−1`（贷方正，取反成正数）。
//   利润表　　：收入行 `sign=−1`；成本费用行 `sign=+1`。
// **方向口径写进行里，不写进代码** —— 换一套会计政策不该改代码。
// （试算平衡表早已立过同一个教训：余额方向由科目决定，**不靠"借减贷"的正负去猜**。
//   这里比它更进一步：连"哪一行该取反"也是配置。）
//
// ===========================================================================
// 三、为什么报表行要入库，而"表达式"只能用行号做加减
// ===========================================================================
// 「货币资金 = 1001 + 1002」「营业成本 = 6401」是**会计政策**，
// 由人定、要能审计、要能追溯改过什么 —— 所以它入库（`report_lines`），
// 与 `voucher_templates` 同一个道理。
// 但 `subtotal_expr` **只允许行号与 `+`/`-`**（`'1+2+3-4'`）：
// 可被界面编辑的配置一旦能写表达式（`*`、`/`、括号、字段引用），
// 就等于**配置能改账** —— 与凭证模板的 `amount_key` 只能取封闭字典是同一条铁律。
//
// ===========================================================================
// 四、现金流量表：项目标记优先，未标记的按对手科目分析 —— 两条路都必须如实标注
// ===========================================================================
// 现金流量表有两种填列法，本文件**两条都实现**，算法见 `cashFlowBuckets()`：
//   · **标记填列**（批次 U）：分录上标了「现金流量项目」（`cash_flow_items`）时，
//     按项目对应的报表行直接落账。这是**人给的答案**，优先于任何推测。
//   · **分析填列**（034 起就有）：没有标记（或标记落不到行上）时，从凭证本身推：
//       - 单边配对：凭证里非现金分录方向单一（全 credit 或全 debit）且金额正好对上，
//         逐条按其**对手科目**匹配报表行。这是绝大多数存量凭证的形态。
//       - 净额法：现金与非现金在多条线上交叉（复合凭证）时，只把净额放进兜底行，
//         并**如实计数**回报（`complex_vouchers`）。
//
// **为什么必须保留回落，而不是"没标记就不填列"**：
//   存量凭证一条标记都没有（本批不回填 —— 回填等于把推测固化成事实，之后就再也
//   分不清哪一条是记的、哪一条是推的）。把回落拿掉，等于让这一批**主动弄坏**
//   升级前就存在的那些期间 —— 报表从"粗但可用"变成"空"。
//   所以回落的定位是**存量可用的保证**，不是过渡期的临时方案。
//
// **为什么必须如实计数**：`tagged_count`（靠标记归行的分录数）/ `untagged_count`
//   （靠分析推出来的分录数）。两者混在一起报一张表，读表的人无从判断
//   "这一行是记的还是推的"。不假装它被精确归了类 ——
//   "看起来归类很细"比"归得粗但说清楚"危险得多。
// 两条填列路都满足第三节的自证恒等式
// （标记路按 Σ(−signed) 归行，净额路把同一笔总额放到兜底行）。
//
// ===========================================================================
// 五、单一实现原则
// ===========================================================================
//   · **期间校验**只在这里（`assertPeriodOpen`），HTTP 与 MCP 都调它；
//   · **科目余额总表**只算一次（`subjectBalances`），三张报表都从它取数 ——
//     "资产负债表自己查一遍、利润表再查一遍"正是本项目 D2 那类缺陷的原形；
//   · **现金类科目集合**只从 `report_defs.cash_subjects` 读（默认 1001,1002），
//     不在两处各写一个数组。
const money2 = (n) => Number(Number(n || 0).toFixed(2))

export class ReportError extends Error {
  constructor(code, message, http = 400, detail = null) {
    super(message)
    this.code = code
    this.http = http
    // **同时写 `.status`**：HTTP 层的统一翻译器 `failFromError` 只认 `error.status`，
    // 全局兜底中间件也只认它。只写 `.http` 的后果是**每一个业务错误都被报成 500** ——
    // 而 500 会让排查方向从"我的参数不对"偏到"服务器挂了"。
    this.status = http
    this.detail = detail
  }
}

export const REPORT_BASIS_LABEL = {
  balance: '期末余额',
  amount: '本期发生额',
  cash_flow: '现金收支（对手科目分析填列）'
}
export const LINE_TYPE_LABEL = { item: '科目行', subtotal: '小计', total: '合计' }

/** 现金类科目的**默认**集合。真实取值从 `report_defs.cash_subjects` 读 —— 这里只是缺省。 */
export const DEFAULT_CASH_SUBJECTS = ['1001', '1002']

// 期间工具（格式 / 位移 / 状态 / 过账闸门）在 `lib/period.js` ——
// 凭证模块也要用同一个闸门，所以它必须待在两个模块都能依赖的那一层。
// ⚠️ 必须**先 import 再 re-export**：`export { x } from './y.js'` 只做转发、
//    不产生本地绑定，本文件内部照样用不了 `x`（本轮真实踩到）。
import {
  assertPeriod,
  shiftPeriod,
  listPeriods,
  getPeriod,
  isPeriodClosed,
  isPeriodCarried,
  ensurePeriod,
  assertPeriodOpen,
  CARRY_BIZ_TYPE,
  PERIOD_STATUS_LABEL,
  PeriodError
} from './period.js'

export {
  assertPeriod,
  shiftPeriod,
  listPeriods,
  getPeriod,
  isPeriodClosed,
  isPeriodCarried,
  ensurePeriod,
  assertPeriodOpen,
  CARRY_BIZ_TYPE,
  PERIOD_STATUS_LABEL,
  PeriodError
}

// 导出时间戳只走 `localNow`（本地时区）—— 见 `lib/dates.js` 的说明。
import { localNow } from './dates.js'

// 零依赖 XLSX 写入器（批次 U 之四）。**只做"矩阵 → OOXML"一件事**：
// 它不认报表、不认列定义、更不会自己插表头 —— 表头由本文件按 `columnsOf` 的结果作为
// `rows[0]` 传进去。理由见该模块文件头第三节：它一旦自作主张插表头，
// 而调用方也在 rows 里放了表头，就会出现**两行表头**，而这种重复只有打开文件才看得见。
import { buildXlsx, XlsxError, XLSX_CODES } from './xlsx.js'

// 期间审计日志（批次 Q）。依赖方向：`period-audit.js` 只依赖 `period.js`，本文件依赖它，不成环。
// 为什么本文件要 import `auditPeriodTrail`：审计链自证是 `auditReport` 的第 ⑩ 条 ——
// 关账的前置就是 `auditReport`，所以"账没留痕"与"账不平"一样会挡住关账。
import { logPeriodChange, auditPeriodTrail } from './period-audit.js'
import { readSetting, auditSettingTrail } from './settings.js'
// 报表口径变更日志（批次 S）。同样不成环：`report-config-audit.js` 不 import 本文件，
// 它只做"记录 / 重放 / 自证"，而"怎么改口径"的规则留在本文件。
// 为什么本文件要 import `auditReportConfigTrail`：会计政策变更链自证是 `auditReport`
// 的第 ⑫ 条 —— 关账前置就是 `auditReport`，所以"口径被改过却说不清"与"账不平"一样挡关账
// （与 ⑩ 期间链、⑪ 配置链同一条理由）。
// 实现量最大的三处（`logReportConfigChange` / `diffSnapshot`）在本文件里被调用，
// 所以"口径的每一次改动都会留痕"这件事**不可能被绕过**：写入点就在下面几个函数里。
import { logReportConfigChange, diffSnapshot, auditReportConfigTrail } from './report-config-audit.js'

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
/** 解析 `'1122~1122|2203~2203'` → `[{from,to}]`；非法即抛（静默忽略会表现成"这一行永远是 0"） */
export function parseSubjectRange(text) {
  const out = []
  for (const seg of String(text || '').split('|')) {
    const m = /^\s*(\d{4,8})\s*~\s*(\d{4,8})\s*$/.exec(seg)
    if (!m) throw new ReportError('BAD_SUBJECT_RANGE', `科目区间「${seg}」格式非法，应形如 1001~1002`, 500, { range: text })
    if (m[1] > m[2]) throw new ReportError('BAD_SUBJECT_RANGE', `科目区间起止写反了：「${seg}」`, 500, { range: text })
    out.push({ from: m[1], to: m[2] })
  }
  return out
}

/** 科目码是否落在区间内。**按字符串比较**：科目码是定长分层编码（1201 < 1403 < 1405 < 1601），
 *  这也是会计准则的编码约定，所以不需要转数字。 */
export function inSubjectRange(code, segs) {
  const c = String(code)
  for (const s of segs) if (c >= s.from && c <= s.to) return true
  return false
}

/** 解析小计表达式 `'1+2+3-4'` → `[{no, sign}]`。**只允许行号与 +−** —— 见文件头第三节。 */
export function parseSubtotalExpr(expr) {
  const text = String(expr ?? '').trim()
  if (!/^\d+(\s*[+-]\s*\d+)*$/.test(text)) {
    throw new ReportError('BAD_SUBTOTAL_EXPR', `小计表达式「${expr}」非法：只允许行号与加减号`, 500, { expr })
  }
  const out = []
  const re = /([+-]?)\s*(\d+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    out.push({ sign: m[1] === '-' ? -1 : 1, no: Number(m[2]) })
  }
  return out
}

// ---------------------------------------------------------------------------
// 一、报表定义与报表行（会计政策）
// ---------------------------------------------------------------------------
/** 报表定义的统一装饰（`cover_category_list` 只有在这里算一次 —— 两个读口公用一份） */
function decorateDef(row) {
  if (!row) return row
  return {
    ...row,
    basis_label: REPORT_BASIS_LABEL[row.basis] || row.basis,
    cover_category_list: String(row.cover_categories || '').split(',').map((s) => s.trim()).filter(Boolean)
  }
}

export function listReportDefs(db) {
  return db
    .prepare(`
      SELECT d.*, (SELECT COUNT(*) FROM report_lines l WHERE l.report_code = d.report_code) AS line_count
        FROM report_defs d ORDER BY d.report_code
    `)
    .all()
    .map(decorateDef)
}

export function getReportDef(db, reportCode) {
  const d = db.prepare('SELECT * FROM report_defs WHERE report_code=?').get(String(reportCode))
  if (!d) throw new ReportError('REPORT_NOT_FOUND', `报表「${reportCode}」不存在`, 404)
  return decorateDef(d)
}

export function listReportLines(db, reportCode) {
  return db
    .prepare('SELECT * FROM report_lines WHERE report_code=? ORDER BY order_no, line_no')
    .all(String(reportCode))
    .map((r) => ({
      ...r,
      line_type_label: LINE_TYPE_LABEL[r.line_type] || r.line_type,
      subject_segments: r.line_type === 'item' ? parseSubjectRange(r.subject_range) : []
    }))
}

/** 引用某一行的全部小计/合计行。**唯一实现**：删除与改行号两条路共用它。 */
function subtotalRefsOf(db, reportCode, lineNo) {
  return db
    .prepare("SELECT line_code, line_name, subtotal_expr FROM report_lines WHERE report_code=? AND line_type IN ('subtotal','total')")
    .all(reportCode)
    .filter((r) => parseSubtotalExpr(r.subtotal_expr).some((x) => x.no === Number(lineNo)))
}

/**
 * 写入 / 更新报表定义。`basis` 决定取数口径，改它等于换一套会计政策 —— 所以单独授权。
 *
 * 与批次 S 之前的三点区别（全在"会计政策改了要说得清"这一件事上）：
 *   ① **同事务留痕**：`report_config_audit_log` 里存改动前后的整行快照，
 *      危险字段（`basis` / `cash_subjects` / `cover_categories` / `status`）改动必须有理由；
 *   ② **值没变时不写库**（连 `updated_at` 都不动）—— "点了一次保存但没改"不是一次变更，
 *      写进历史只会让日志变成一串没有内容的记录（与 `writeSetting` 同一条口径）；
 *   ③ `{ audit: false }` 供 `seedReport` 使用：种子灌的是"库的初始状态"，
 *      它该由 `ensureReportConfigTrail` 补一条基线，而不是留下一百多条 `create`
 *      （否则升级路径与重建路径的日志内容会不一样）。
 */
export function saveReportDef(db, payload = {}, opts = {}) {
  const code = String(payload.report_code || '').trim()
  if (!code) throw new ReportError('REPORT_CODE_REQUIRED', '报表编码必填', 400)
  if (!REPORT_BASIS_LABEL[payload.basis]) {
    throw new ReportError('BAD_BASIS', `取数口径「${payload.basis}」不支持（应为 ${Object.keys(REPORT_BASIS_LABEL).join(' / ')}）`, 400)
  }
  const next = {
    name: String(payload.name || code),
    basis: String(payload.basis),
    cash_subjects: payload.cash_subjects ?? null,
    cover_categories: payload.cover_categories ?? null,
    remark: payload.remark ?? null,
    status: payload.status || 'active'
  }

  const tx = db.transaction(() => {
    const before = db.prepare('SELECT * FROM report_defs WHERE report_code=?').get(code) || null
    // 值没变 → 不是一次变更。**整个 UPDATE 都不执行**，连 `updated_at` 都不动。
    if (before && diffSnapshot('def', before, { ...before, ...next }).length === 0) {
      return { ...decorateDef(before), changed: false, logged: false }
    }
    db.prepare(`
      INSERT INTO report_defs (report_code,name,basis,cash_subjects,cover_categories,remark,status)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(report_code) DO UPDATE SET
        name=excluded.name, basis=excluded.basis, cash_subjects=excluded.cash_subjects,
        cover_categories=excluded.cover_categories, remark=excluded.remark, status=excluded.status,
        updated_at=datetime('now','localtime')
    `).run(code, next.name, next.basis, next.cash_subjects, next.cover_categories, next.remark, next.status)
    const row = db.prepare('SELECT * FROM report_defs WHERE report_code=?').get(code)
    if (opts.audit === false) return { ...decorateDef(row), changed: true, logged: false }
    const entryId = logReportConfigChange(db, {
      targetType: 'def',
      reportCode: code,
      action: before ? 'update' : 'create',
      before,
      after: row,
      reason: opts.reason ?? null,
      actor: opts.actor ?? null
    })
    return { ...decorateDef(row), changed: true, logged: true, entry_id: entryId }
  })
  return tx()
}

/**
 * 写入 / 更新一行报表口径。**唯一实现**：界面与 seed 都走它，
 * 所以界面改完的口径与 seed 建的口径在结构上必然一致（校验也同一份）。
 *
 * 批次 S 补上的三处（都在"这次改的是会计政策，要说得清"这条线上）：
 *   ① **同事务留痕**（整行快照 + 差分算危险等级，危险改动必须有理由）；
 *   ② `LINE_NO_TAKEN`：冲突键是 `(report_code, line_code)`，所以改 `line_no` 时
 *      INSERT 不会命中原来那一行，而会撞上 `UNIQUE(report_code, line_no)`
 *      并抛一句原始约束错 —— 用户完全看不出自己撞了哪一行。这里提前给一句人话；
 *   ③ `LINE_NO_IN_USE`：**改行号等于删掉旧行号**，所以要与删除受同一条保护 ——
 *      否则引用它的旧小计表达式会静默悬空（`SUBTOTAL_REF_MISSING` 只在保存
 *      那条小计时才校验，而那时离这次改动已经很远）。
 */
export function saveReportLine(db, payload = {}, opts = {}) {
  const reportCode = String(payload.report_code || '').trim()
  getReportDef(db, reportCode) // 报表必须存在
  const lineType = String(payload.line_type || '').trim()
  if (!LINE_TYPE_LABEL[lineType]) throw new ReportError('BAD_LINE_TYPE', `行类型「${lineType}」不支持`, 400)
  const lineCode = String(payload.line_code || '').trim()
  if (!lineCode) throw new ReportError('LINE_CODE_REQUIRED', '报表行的机器键（line_code）必填', 400)
  const lineName = String(payload.line_name || '').trim()
  if (!lineName) throw new ReportError('LINE_NAME_REQUIRED', '报表行名称必填', 400)
  // 行号只在这里取一次：自指检查、撞车检查、改行号检查、落库全用同一个值。
  // 原来它在四处各写一遍 `Number(payload.line_no)` —— 其中一处被改成 `Number(payload.lineNo)`
  // 就会变成 `NaN`，而 `NaN` 既不等于任何行号、也能安静地写进库。
  const lineNo = Number(payload.line_no)
  if (!Number.isInteger(lineNo)) throw new ReportError('BAD_LINE_NO', `行号必须是整数（收到 ${payload.line_no}）`, 400)

  let subjectRange = null
  let subtotalExpr = null
  if (lineType === 'item') {
    subjectRange = String(payload.subject_range || '').trim()
    if (!subjectRange) throw new ReportError('SUBJECT_RANGE_REQUIRED', '科目行必须写科目区间', 400)
    parseSubjectRange(subjectRange) // 校验格式（非法即抛，不静默）
  } else {
    subtotalExpr = String(payload.subtotal_expr || '').trim()
    if (!subtotalExpr) throw new ReportError('SUBTOTAL_EXPR_REQUIRED', '小计/合计行必须写表达式', 400)
    const refs = parseSubtotalExpr(subtotalExpr)
    // **引用必须当场解析得开**：写一条指向不存在行号的小计，写入时不会报错，
    // 等到有人打开那张报表才炸（`SUBTOTAL_REF_MISSING`）—— 而那时离改动已经很远，
    // 且报表页只会显示"算不出来"，看不出是**哪一次配置改动**造成的。
    // 顺带拦掉"小计引用自己"：那是一个自指的死循环。
    for (const ref of refs) {
      if (ref.no === lineNo) {
        throw new ReportError('SUBTOTAL_REF_SELF', `行「${lineName}」的小计表达式引用了它自己（第 ${ref.no} 行）`, 400, { expr: subtotalExpr })
      }
      const hit = db.prepare('SELECT line_name FROM report_lines WHERE report_code=? AND line_no=?').get(reportCode, ref.no)
      if (!hit) {
        throw new ReportError('SUBTOTAL_REF_MISSING', `行「${lineName}」引用了不存在的第 ${ref.no} 行（表达式 ${subtotalExpr}）`, 400, { expr: subtotalExpr, ref: ref.no })
      }
    }
  }
  const onlyDirection = payload.only_direction ?? null
  if (onlyDirection !== null && !['credit', 'debit'].includes(onlyDirection)) {
    throw new ReportError('BAD_ONLY_DIRECTION', '方向过滤只能是 credit / debit', 400)
  }
  // 方向过滤只在现金流口径下有意义。**写入时就拦掉**，而不是等到算报表时才报 ——
  // 「配置里写着、行为里没有」是最危险的一种不一致：改的人以为它生效了。
  // （本轮动态探针抓到过：往资产负债表上加一行 `only_direction` 竟然 200 通过。）
  if (onlyDirection && getReportDef(db, reportCode).basis !== 'cash_flow') {
    throw new ReportError(
      'ONLY_DIRECTION_UNSUPPORTED',
      `行「${lineName}」设置了方向过滤，但报表「${reportCode}」的取数口径不是 cash_flow（方向过滤只在现金流量表有意义）`,
      400,
      { report_code: reportCode }
    )
  }
  const sign = Number(payload.sign ?? 1)
  if (![1, -1].includes(sign)) throw new ReportError('BAD_SIGN', 'sign 只能是 +1 或 −1', 400)

  const next = {
    line_no: lineNo,
    display_no: payload.display_no ?? null,
    line_name: lineName,
    line_type: lineType,
    level: Number(payload.level ?? 1),
    subject_range: subjectRange,
    sign,
    only_direction: onlyDirection,
    subtotal_expr: subtotalExpr,
    is_fallback: payload.is_fallback ? 1 : 0,
    order_no: Number(payload.order_no ?? payload.line_no ?? 0),
    remark: payload.remark ?? null
  }

  const tx = db.transaction(() => {
    const before = db.prepare('SELECT * FROM report_lines WHERE report_code=? AND line_code=?').get(reportCode, lineCode) || null

    // 行号撞车：冲突键是 `(report_code, line_code)`，改 `line_no` 不会命中原来那一行，
    // 于是 INSERT 会撞 `UNIQUE(report_code, line_no)`，抛出来的是一句
    // `SqliteError: UNIQUE constraint failed: report_lines.report_code, report_lines.line_no`
    // —— 用户看不出自己撞了哪一行，也看不出"该先删谁"。这里给一句人话。
    const holder = db.prepare('SELECT line_code, line_name FROM report_lines WHERE report_code=? AND line_no=?').get(reportCode, lineNo)
    if (holder && holder.line_code !== lineCode) {
      throw new ReportError(
        'LINE_NO_TAKEN',
        `第 ${lineNo} 行已经被「${holder.line_name}」（${holder.line_code}）占用 —— 小计表达式按行号引用，同一张报表里行号必须唯一`,
        409,
        { report_code: reportCode, line_no: lineNo, holder: holder.line_code }
      )
    }

    // 改行号 = 删掉旧行号。与 `deleteReportLine` 受**同一条**保护：
    // 否则引用旧行号的表达式会静默悬空，而报表页只会显示"算不出来"。
    if (before && Number(before.line_no) !== lineNo) {
      const refs = subtotalRefsOf(db, reportCode, before.line_no)
      if (refs.length) {
        throw new ReportError(
          'LINE_NO_IN_USE',
          `第 ${before.line_no} 行「${before.line_name}」被小计行引用（${refs.map((r) => r.line_name).join('、')}），不能改行号 —— 改行号等于把那几行的引用拆掉`,
          409,
          { refs: refs.map((r) => r.line_code), from: before.line_no, to: lineNo }
        )
      }
    }

    // 值没变 → 不是一次变更，不写库也不写日志（与 `saveReportDef` / `writeSetting` 同一条）。
    if (before && diffSnapshot('line', before, { ...before, ...next }).length === 0) {
      return { ...before, changed: false, logged: false }
    }

    db.prepare(`
      INSERT INTO report_lines
        (report_code,line_code,line_no,display_no,line_name,line_type,level,
         subject_range,sign,only_direction,subtotal_expr,is_fallback,order_no,remark)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(report_code,line_code) DO UPDATE SET
        line_no=excluded.line_no, display_no=excluded.display_no, line_name=excluded.line_name,
        line_type=excluded.line_type, level=excluded.level, subject_range=excluded.subject_range,
        sign=excluded.sign, only_direction=excluded.only_direction, subtotal_expr=excluded.subtotal_expr,
        is_fallback=excluded.is_fallback, order_no=excluded.order_no, remark=excluded.remark
    `).run(
      reportCode, lineCode, lineNo, next.display_no, lineName, lineType,
      next.level, subjectRange, sign, onlyDirection, subtotalExpr,
      next.is_fallback, next.order_no, next.remark
    )
    const row = db.prepare('SELECT * FROM report_lines WHERE report_code=? AND line_code=?').get(reportCode, lineCode)
    if (opts.audit === false) return { ...row, changed: true, logged: false }
    const entryId = logReportConfigChange(db, {
      targetType: 'line',
      reportCode,
      lineCode,
      action: before ? 'update' : 'create',
      before,
      after: row,
      reason: opts.reason ?? null,
      actor: opts.actor ?? null
    })
    return { ...row, changed: true, logged: true, entry_id: entryId }
  })
  return tx()
}

/**
 * 删除一行报表口径。
 *
 * 批次 S 补的：删除必须**留整份快照**。`report_lines` 是物理删除 ——
 * 原来只往通用审计里记一句 `report_line:37`，而 37 删完就不存在了，
 * 于是"删的是哪一行、原来的科目区间是什么"永久不可考。
 * 现在 `snapshot_before` 是那一行唯一还查得到的地方。
 */
export function deleteReportLine(db, id, opts = {}) {
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM report_lines WHERE id=?').get(Number(id))
    if (!row) throw new ReportError('LINE_NOT_FOUND', `报表行不存在：#${id}`, 404)
    // 删掉一行会让引用它的**小计行**静默少一块（表达式还指着那个行号）——
    // 与其让人事后在报表上发现差额，不如在这里拦住。（与改行号共用 `subtotalRefsOf`。）
    const refs = subtotalRefsOf(db, row.report_code, row.line_no)
    if (refs.length) {
      throw new ReportError(
        'LINE_IN_USE',
        `第 ${row.line_no} 行「${row.line_name}」被小计行引用（${refs.map((r) => r.line_name).join('、')}），不能删除`,
        409,
        { refs: refs.map((r) => r.line_code) }
      )
    }
    db.prepare('DELETE FROM report_lines WHERE id=?').run(row.id)
    if (opts.audit === false) return { deleted: 1, logged: false }
    const entryId = logReportConfigChange(db, {
      targetType: 'line',
      reportCode: String(row.report_code),
      lineCode: String(row.line_code),
      action: 'delete',
      before: row,
      after: null,
      reason: opts.reason ?? null,
      actor: opts.actor ?? null
    })
    return { deleted: 1, logged: true, entry_id: entryId, line_code: row.line_code, line_name: row.line_name }
  })
  return tx()
}

// ---------------------------------------------------------------------------
// 二、会计期间的**业务规则**（纯粹的期间工具在 lib/period.js）
// ---------------------------------------------------------------------------
/**
 * 关账。四条前置检查都是**刻意**的，少一条都会把差额永久封存：
 *   ① 三张报表自证通过 —— 带着一张不平的资产负债表关账，等于把差额钉死在这一期；
 *   ② 没有未过账的草稿 —— 关账后它们的期间再也过不了账，只能作废重录；
 *   ③ **本期已结转**（或本期损益本来就为 0）—— 「关账」的定义是"这一期的账**结平**定稿了"。
 *      账没结平就定稿，损益余额会一直挂到跨年（6001 的余额变成开业至今的全部收入）；
 *      而空期间没有可结转的东西，不结转也能关账（否则每个空月都要先"结转 0 元"，荒谬）。
 *      判据在 `uncarriedProfitSubjects`（**唯一实现**，`lib/closing.js` 同用它）；
 *   ④ 期间格式合法（由 `assertPeriod` 保证）。
 */
export function closePeriod(db, { period, actor = null, remark = null }) {
  const p = assertPeriod(period)
  const row = getPeriod(db, p)
  if (row?.status === 'closed') return { period: p, status: 'closed', replayed: true }

  const audit = auditReport(db, { period: p })
  if (!audit.ok) {
    throw new ReportError(
      'PERIOD_NOT_BALANCED',
      `期间 ${p} 的报表自证不通过，不能关账：${audit.problems.map((x) => x.message).slice(0, 2).join('；')}`,
      409,
      { problems: audit.problems }
    )
  }
  const drafts = db.prepare("SELECT COUNT(*) c FROM vouchers WHERE period=? AND status='draft'").get(p).c
  if (drafts > 0) {
    throw new ReportError(
      'PERIOD_HAS_DRAFT',
      `期间 ${p} 还有 ${drafts} 张未过账的凭证，请先过账或作废再关账`,
      409,
      { period: p, drafts }
    )
  }
  // ③ 未结转就不算结平。**不做"自动结转"**：结转会生成一张已过账凭证（动账），
  //    而"关账"这个动作不该顺手往账里塞一张票 —— 那会让"谁改了账"变成一个查不出来的问题。
  const pending = uncarriedProfitSubjects(db, { period: p })
  if (pending.length) {
    throw new ReportError(
      'PERIOD_NOT_CARRIED',
      `期间 ${p} 还有 ${pending.length} 个损益科目未结转（${pending.slice(0, 3).map((x) => `${x.code} ${x.name}`).join('、')}${pending.length > 3 ? ' 等' : ''}），账未结平，不能关账；请先做期末结转`,
      409,
      { period: p, subjects: pending.map((x) => x.code) }
    )
  }
  ensurePeriod(db, p)
  // 写期间 + 写审计日志**同事务**：批次 Q 的硬口径 ——
  // 否则"关了账但日志没写"或"日志写了但账没关上"会真的出现，
  // 而这两种不一致都会让日志从"证据"退化成"说法"。
  const exec = db.transaction(() => {
    db.prepare(`
      UPDATE accounting_periods
         SET status='closed', closed_by=?, closed_by_name=?, closed_at=datetime('now','localtime'), remark=?
       WHERE period=?
    `).run(actor?.id ?? null, actor?.name ?? null, remark, p)
    logPeriodChange(db, {
      period: p,
      action: 'period_close',
      statusBefore: row?.status ?? 'open',
      statusAfter: 'closed',
      remark,
      actor
    })
  })
  exec()
  return { period: p, status: 'closed', replayed: false, audit }
}

/**
 * 反关账：让"已定稿"的期间重新可变 —— 与作废已过账凭证同一个道理，**必须写理由**。
 *
 * ⚠️ 这里**刻意不拦"本期已结转"**，虽然那看起来更安全。原因是拦了会**死锁**：
 *   「撤销结转」要求期间未关账（否则它就成了"删已关账期间的凭证"的钥匙），
 *   而「反关账」如果要求先撤销结转，就谁也走不了第一步。
 * 所以顺序只能是：**反关账（写理由）→ 撤销结转（写理由）→ 改账 → 重新结转 → 关账**。
 * 反关账之后、撤销结转之前，那一期处于"已结转但账又可变"的中间态 ——
 * 这个状态由 `closingStatus`（`carried && pending`）与自证探针 `CARRY_INCOMPLETE`
 * 如实报出来，而不是靠一道会锁死流程的前置检查来避免。
 */
export function reopenPeriod(db, { period, actor = null, reason = null }) {
  const p = assertPeriod(period)
  const row = getPeriod(db, p)
  if (!row || row.status !== 'closed') return { period: p, status: 'open', replayed: true }
  if (!String(reason || '').trim()) {
    throw new ReportError('REOPEN_REASON_REQUIRED', `反关账期间 ${p} 必须填写理由`, 400, { period: p })
  }
  // ⚠️ 批次 O 新增一环：**该期间所属年度已年结时，必须先撤销年度结转**。
  // 少了这一环，反关账就成了"绕过封账往旧年度塞凭证"的路 ——
  // 年结会把整年置为已关账（它承诺"这一年的账定稿了"），而这里又能把它打开，
  // 那封账就形同虚设：补一张 12 月的凭证不会报错，只是 4104 的金额再也不对了。
  //
  // 依赖方向：`annual.js` 依赖本文件，所以这里**不能** import `annual.js`（会成环），
  // 只直接读期间表。判据也只有一个：年末期间上有没有年结凭证指针
  // （结构一致性由迁移 036 的 verify 保证，与 `isPeriodCarried` 同一条理由）。
  const belongYear = p.slice(0, 4)
  const decAnnual = db
    .prepare('SELECT annual_voucher_id FROM accounting_periods WHERE period=?')
    .get(`${belongYear}-12`)
  if (decAnnual?.annual_voucher_id) {
    throw new ReportError(
      'YEAR_ANNUAL_CLOSED',
      `期间 ${p} 所属的 ${belongYear} 年已做年度结转（凭证 #${decAnnual.annual_voucher_id}）；`
        + '反关账会让这一年的账重新可变，而年结的金额是按当时的数据算出来的 —— '
        + '请先撤销年度结转（撤销本身要写理由）',
      409,
      { period: p, year: belongYear, annual_voucher_id: decAnnual.annual_voucher_id }
    )
  }
  // ⚠️ 这里把 `closed_by` / `closed_at` 清空，**不是销毁证据**：
  // 一个 `status='open'` 的期间同时带着 `closed_by='张三'` 是自相矛盾的一句话，
  // 而列名不携带"这是历史还是现状"这个信息 —— 读它的人只能靠猜。
  // 批次 Q 定下口径：**期间表 = 现状指针，审计日志 = 历史事实**。
  // "这一期被反关账过几次、每次为什么"从 `period_audit_log` 查（`listPeriodAudit`）。
  const exec = db.transaction(() => {
    db.prepare(`
      UPDATE accounting_periods
         SET status='open', reopen_reason=?, closed_by=NULL, closed_by_name=NULL, closed_at=NULL
       WHERE period=?
    `).run(reason, p)
    logPeriodChange(db, {
      period: p,
      action: 'period_reopen',
      statusBefore: 'closed',
      statusAfter: 'open',
      reason,
      actor,
      detail: { carried: !!row.closing_voucher_id, closing_voucher_id: row.closing_voucher_id ?? null }
    })
  })
  exec()
  return {
    period: p,
    status: 'open',
    replayed: false,
    operator: actor?.name ?? null,
    reason,
    // 反关账时本期是否已结转。为真时调用方（界面）应当提示：
    // **本期结转仍然挂着**，改完账要撤销结转后重做，否则新发生额进不了本年利润。
    carried: !!row.closing_voucher_id,
    closing_voucher_id: row.closing_voucher_id ?? null,
    notice: row.closing_voucher_id
      ? '本期已做期末结转；反关账后如需调整损益，请撤销结转后重做（撤销本身也要写理由）'
      : null
  }
}

// ---------------------------------------------------------------------------
// 三、期初余额
// ---------------------------------------------------------------------------
export function listOpeningBalances(db, { period }) {
  const p = assertPeriod(period)
  const rows = db
    .prepare(`
      SELECT o.*, s.name AS subject_name, s.category, s.direction,
             CASE WHEN o.debit_amount <> 0 THEN o.debit_amount ELSE -o.credit_amount END AS signed
        FROM accounting_opening_balances o
        LEFT JOIN accounting_subjects s ON s.id = o.subject_id
       WHERE o.period=? ORDER BY o.subject_code
    `)
    .all(p)
  const totalDebit = money2(rows.reduce((s, r) => s + Number(r.debit_amount || 0), 0))
  const totalCredit = money2(rows.reduce((s, r) => s + Number(r.credit_amount || 0), 0))
  return {
    period: p,
    rows,
    total_debit: totalDebit,
    total_credit: totalCredit,
    balanced: Math.abs(totalDebit - totalCredit) <= 0.005,
    diff: money2(totalDebit - totalCredit)
  }
}

/**
 * 录入期初余额（整批覆盖：先删该期间的登记、再整批写入）。
 *
 * 为什么必须**整体覆盖**而不是逐条 upsert：期初余额是一个"期初试算平衡表"，
 * 它一旦不平，后面每一张报表都不平，而差额会一直挂在账上没人认领。
 * 逐条改的时候，人看不到"现在的合计是多少"；整批覆盖时，
 * 平衡校验在**写入前**对整批做，不平就整批不落库。
 */
export function setOpeningBalances(db, { period, rows = [], actor = null, remark = null }) {
  const p = assertPeriod(period)
  const lines = []
  for (const [i, r] of rows.entries()) {
    const code = String(r.subject_code || '').trim()
    if (!code) throw new ReportError('OPENING_SUBJECT_REQUIRED', `第 ${i + 1} 行的科目编码必填`, 400)
    const subject = db.prepare('SELECT * FROM accounting_subjects WHERE code=?').get(code)
    if (!subject) throw new ReportError('SUBJECT_NOT_FOUND', `科目 ${code} 不存在`, 404)
    const d = Number(r.debit_amount ?? 0)
    const c = Number(r.credit_amount ?? 0)
    if (!Number.isFinite(d) || !Number.isFinite(c) || d < 0 || c < 0) {
      throw new ReportError('OPENING_BAD_AMOUNT', `科目 ${code} 的期初余额必须是非负数（方向用借/贷两列表达）`, 400)
    }
    // 同一科目的期初不能在借方又在贷方（"借 100 贷 100"会让试算平衡看起来平，但那一行读出来是 0）
    if (d > 0.005 && c > 0.005) {
      throw new ReportError('OPENING_BOTH_SIDES', `科目 ${code} 不能同时有借方与贷方期初余额`, 400)
    }
    lines.push({ subject, debit: money2(d), credit: money2(c) })
  }
  const totalDebit = money2(lines.reduce((s, l) => s + l.debit, 0))
  const totalCredit = money2(lines.reduce((s, l) => s + l.credit, 0))
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    // 不平**不落库**：一张不平的期初试算表会让之后每一期的资产负债表都不平，且差额来源从此不可考
    throw new ReportError(
      'OPENING_NOT_BALANCED',
      `期初余额试算不平衡：借方合计 ${totalDebit} ≠ 贷方合计 ${totalCredit}（差 ${money2(totalDebit - totalCredit)}）`,
      409,
      { total_debit: totalDebit, total_credit: totalCredit }
    )
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM accounting_opening_balances WHERE period=?').run(p)
    const ins = db.prepare(`
      INSERT INTO accounting_opening_balances (period,subject_id,subject_code,debit_amount,credit_amount,remark)
      VALUES (?,?,?,?,?,?)
    `)
    for (const l of lines) ins.run(p, l.subject.id, l.subject.code, l.debit, l.credit, remark)
  })
  tx()
  return { ...listOpeningBalances(db, { period: p }), operator: actor?.name ?? null }
}

/**
 * 某期间的**期初余额**（滚动到该期）。
 *
 * 规则：取 `period <= P` 中**最近一次登记**的期初作为基准（记作 B），
 * 再滚上 `[B, P)` 区间内已过账的发生额。
 *
 * **没有任何登记时**（B 不存在）：基准是"账上最早那一期的前一期"、余额为 0，
 * 然后**照常滚动**。这一条是批次 O 补的，理由见下面那段注释 ——
 * 它是"从零开始记账、从未登记期初"的库唯一会出错的地方。
 *
 * 为什么要滚动而不是"只认当期登记"：演示库只在 2026-05 登了一次期初，
 * 出 2026-10 的报表时如果只认当期登记，报表会变成"只有 10 月发生额"——
 * 资产合计与负债合计看起来都很小，且**恰好仍然平**（因为都从 0 起算），
 * 于是没有任何东西会告诉你这笔账漏了五个月。
 */
export function openingBalancesAsOf(db, period) {
  const p = assertPeriod(period)
  const base = db
    .prepare('SELECT period FROM accounting_opening_balances WHERE period <= ? ORDER BY period DESC LIMIT 1')
    .get(p)
  const map = new Map() // subject_id -> signed（借 − 贷）
  const out = { period: p, base_period: base?.period ?? null, has_opening: Boolean(base), rolled_vouchers: 0, map }

  if (base) {
    for (const r of db
      .prepare('SELECT subject_id, debit_amount, credit_amount FROM accounting_opening_balances WHERE period=?')
      .all(base.period)) {
      map.set(Number(r.subject_id), money2(Number(r.debit_amount) - Number(r.credit_amount)))
    }
    if (String(base.period) < p) rollForwardOpening(db, map, out, base.period, p)
    return out
  }

  // **没有任何期初登记 ≠ 每期都从 0 起算。**
  // 一个从未登记过期初的库，它的账是从"账上最早那一期"开始累积的；
  // 停在"期初 = 0"会让后面每一期的期末余额里**不含更早期间的发生额**。
  // 而它的可怕之处在于**不会让任何账不平**：每期各算各的，
  // 而每张凭证自身借贷平衡（Σsigned 恒为 0）⇒ 资产 = 负债 + 权益 照样成立。
  //
  // 批次 O 现场撞出来：自造一个 2024 年（早于所有期初登记）走完整条年结链路，
  // 11 月收入 10000、12 月费用 2000，4103 该是 −8000 却只有 −2000 —— 上一个月被吞了。
  // 修法：把"最早一期的**前一期**"当作零余额基准，然后照常滚动。
  const earliest = earliestPostedPeriod(db)
  if (!earliest || earliest >= p) return out
  rollForwardOpening(db, map, out, earliest, p)
  out.virtual_base_period = earliest
  return out
}

/** 账上最早出现过的期间（已过账凭证 ∪ 期初登记）。用于"没有期初登记"时的滚动起点。 */
function earliestPostedPeriod(db) {
  const row = db
    .prepare(`
      SELECT MIN(period) m FROM (
        SELECT period FROM vouchers WHERE status='posted'
        UNION SELECT period FROM accounting_opening_balances
      )
    `)
    .get()
  return row?.m ? String(row.m) : null
}

/** 把 `[fromPeriod, toPeriod)` 区间内已过账的发生额累加进 `map`。**只有一处实现**（两种基准共用）。 */
function rollForwardOpening(db, map, out, fromPeriod, toPeriod) {
  const rows = db
    .prepare(`
      SELECT e.subject_id,
             ROUND(SUM(CASE WHEN e.direction='debit'  THEN e.amount ELSE 0 END),2) d,
             ROUND(SUM(CASE WHEN e.direction='credit' THEN e.amount ELSE 0 END),2) c
        FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
       WHERE v.status='posted' AND v.period >= ? AND v.period < ?
       GROUP BY e.subject_id
    `)
    .all(fromPeriod, toPeriod)
  for (const r of rows) {
    const id = Number(r.subject_id)
    map.set(id, money2((map.get(id) || 0) + Number(r.d) - Number(r.c)))
  }
  out.rolled_vouchers += db
    .prepare("SELECT COUNT(*) c FROM vouchers WHERE status='posted' AND period >= ? AND period < ?")
    .get(fromPeriod, toPeriod).c
}

// ---------------------------------------------------------------------------
// 四之零、发生额取数：**唯一一份 SQL**（单期与区间共用）—— 批次 P
// ---------------------------------------------------------------------------
/**
 * 一段期间内的科目发生额（`from === to` 就是单期）。
 *
 * 这是"发生额"这件事的**唯一实现**：单期的 `subjectBalances` 与区间的
 * `subjectRangeMovements` 都调它，只是窗口不同。
 * 为什么必须共用：两个窗口各写一份 SQL，迟早在其中一份里改错一个条件
 * （漏 `status='posted'`、漏剔除结转），而**两个窗口的结果看起来都像真的** ——
 * 这正是本项目「同一份判据不允许有两个实现」在 SQL 层的落点
 * （批次 N 让 `trialBalanceFilter` 落在 `WHERE` 上，本批把它扩到发生额这里）。
 *
 * 两套发生额（批次 M 的口径，只查一遍库、在同一个 CASE 里分流）：
 *   · `period_*` 含期末结转凭证 —— 回答"这段期间**账上**发生了什么"。
 *     试算平衡表的恒等式是「期初 + 本期借 − 本期贷 = 期末」，剔除结转它立刻不成立。
 *   · `operating_*` 不含期末结转凭证 —— 回答"这段期间**经营**上发生了什么"。
 *     利润表与经营分析用它；含结转的后果是**结账之后利润表变成 0**。
 */
function movementOf(db, { from, to }) {
  const a = assertPeriod(from)
  const b = assertPeriod(to)
  const rows = db
    .prepare(`
      SELECT e.subject_id,
             ROUND(SUM(CASE WHEN e.direction='debit'  THEN e.amount ELSE 0 END),2) d,
             ROUND(SUM(CASE WHEN e.direction='credit' THEN e.amount ELSE 0 END),2) c,
             ROUND(SUM(CASE WHEN e.direction='debit'  AND v.biz_type<>? THEN e.amount ELSE 0 END),2) od,
             ROUND(SUM(CASE WHEN e.direction='credit' AND v.biz_type<>? THEN e.amount ELSE 0 END),2) oc
        FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
       WHERE v.status='posted' AND v.period >= ? AND v.period <= ?
       GROUP BY e.subject_id
    `)
    .all(CARRY_BIZ_TYPE, CARRY_BIZ_TYPE, a, b)
  return {
    from: a,
    to: b,
    map: new Map(rows.map((r) => [Number(r.subject_id), r])),
    voucher_count: db.prepare("SELECT COUNT(*) c FROM vouchers WHERE status='posted' AND period >= ? AND period <= ?").get(a, b).c,
    draft_count: db.prepare("SELECT COUNT(*) c FROM vouchers WHERE status='draft' AND period >= ? AND period <= ?").get(a, b).c
  }
}

/** 借贷合计与平衡判据。**单期与区间共用**，免得两个窗口的"平衡"各有一套阈值。 */
function totalsOfRows(rows) {
  const totalDebit = money2(rows.reduce((s, r) => s + r.period_debit, 0))
  const totalCredit = money2(rows.reduce((s, r) => s + r.period_credit, 0))
  return {
    total_debit: totalDebit,
    total_credit: totalCredit,
    diff: money2(totalDebit - totalCredit),
    balanced: Math.abs(totalDebit - totalCredit) <= 0.005
  }
}

/** 把科目表与一份发生额 Map 拼成"每科目一行"的完整形状（单期与区间共用）。 */
function shapeSubjectRows(subjects, mv, openingMap = null) {
  return subjects.map((s) => {
    const open = openingMap ? money2(openingMap.get(s.id) || 0) : null
    const m = mv.map.get(s.id)
    const pd = money2(m?.d || 0)
    const pc = money2(m?.c || 0)
    const od = money2(m?.od || 0)
    const oc = money2(m?.oc || 0)
    return {
      subject_id: s.id,
      code: s.code,
      name: s.name,
      category: s.category,
      direction: s.direction,
      is_leaf: s.is_leaf,
      opening_signed: open,
      period_debit: pd,
      period_credit: pc,
      period_signed: money2(pd - pc),
      // 剔除期末结转凭证后的发生额（利润表 / 经营分析专用）
      operating_debit: od,
      operating_credit: oc,
      operating_signed: money2(od - oc),
      // 区间取数**没有**"期末余额"这件事（它不是余额表），显式给 null；
      // 给 0 会让"区间期末是 0"看起来像一个结论。
      closing_signed: open === null ? null : money2(open + pd - pc)
    }
  })
}

/** 全部启用科目（单期与区间共用同一份清单，顺序也一致） */
function allSubjectsOf(db) {
  return db
    .prepare("SELECT id,code,name,category,direction,is_leaf FROM accounting_subjects WHERE status='active' ORDER BY code")
    .all()
}

// ---------------------------------------------------------------------------
// 四、科目余额总表（三张报表**唯一**的取数口）
// ---------------------------------------------------------------------------
/**
 * 一张表算清「期初 / 本期发生 / 期末」，三张报表都从它取数。
 * **只有 `posted` 计入** —— `draft` 是"生成出来了但还没进账"，算进去等于"生成"就是"入账"。
 */
export function subjectBalances(db, { period }) {
  const p = assertPeriod(period)
  const subjects = allSubjectsOf(db)
  const opening = openingBalancesAsOf(db, p)
  // 发生额走**唯一那份 SQL**（`movementOf`），单期只是"窗口两端相同"的特例。
  const mv = movementOf(db, { from: p, to: p })
  const rows = shapeSubjectRows(subjects, mv, opening.map)
  const totals = totalsOfRows(rows)

  const openingTotal = money2(rows.reduce((s, r) => s + r.opening_signed, 0))
  const closingTotal = money2(rows.reduce((s, r) => s + r.closing_signed, 0))

  return {
    period: p,
    rows,
    opening: {
      has_opening: opening.has_opening,
      base_period: opening.base_period,
      rolled_vouchers: opening.rolled_vouchers,
      total_signed: openingTotal,
      balanced: Math.abs(openingTotal) <= 0.005
    },
    movement: {
      ...totals,
      voucher_count: mv.voucher_count,
      draft_count: mv.draft_count
    },
    closing: { total_signed: closingTotal }
  }
}

// ---------------------------------------------------------------------------
// 四之一、区间发生额（批次 P）：**本年累计**的取数口
// ---------------------------------------------------------------------------
// 为什么另立一个函数，而不是给 `subjectBalances` 加一个 `range` 开关：
//   余额表的三件套是「期初 / 本期发生 / 期末」，而"区间"只有中间那一件 ——
//   区间没有期初余额、也没有期末余额（它是**发生额**的聚合，不是时点快照）。
//   用开关的话，返回对象里那两个字段在有/无区间时的含义会变，
//   而 `computeReport` / `auditReport` 都要读它 —— 一个字段两种含义是最难查的一类错。
//   所以：**两个函数、同一种形状、同一份 SQL**。`opening_signed` / `closing_signed`
//   在区间结果里是 `null`（不是 0）—— 拿它当余额用会立刻炸，而不是拿到一个看着合理的数。
//
// ---------------------------------------------------------------------------
// 三之二、会计年度起点（批次 U 之四 / ③-c）
// ---------------------------------------------------------------------------
// 会计年度的起点**可配置**（`settings.fiscal.start_month`，默认 1 = 自然年）。
// 它是"年初"这件事的**唯一出处**：`resolveRange` 算累计起点从这里拿，
// `annual.js` 那边的"年度"概念也是同一个东西（见下面的范围界）。
//
// 为什么要有：会计年度不等于自然年在实务里很常见（4 月起算的财年），
// 而在此之前"年初"在代码里被写死了两次（`resolveRange` 的 `${year}-01` 与
// `annual.js` 的 `period.slice(0,4)`）—— 两处各写一遍，改一处就会分叉。
export const FISCAL_START_DEFAULT = 1

/** 当前的会计年度起始月（读配置；缺行/非法一律回落默认值 —— 读路径必须容错） */
export function fiscalStartMonth(db) {
  const n = Number(readSetting(db, 'fiscal.start_month'))
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : FISCAL_START_DEFAULT
}

/**
 * 期间 → 会计年度（起点月 `startMonth`）。
 *
 * 返回 `{ fiscal_year, start_month, from, to, label }`：
 *   · `fiscal_year` —— **起始年**（2026 表示"2026-04 ~ 2027-03"这一年度）；
 *   · `from` / `to` —— 该年度的首月与末月（闭区间）；
 *   · `label` —— 起点为 1 月时就是 `2026`，否则 `2026-04 ~ 2027-03`。
 *     **跨自然年时标签必须说得出来** —— 一个叫"2026 年度"却横跨 2026 与 2027 的
 *     东西，会在所有对外的说明里被读成"自然年 2026"。
 *
 * 起点为 1 月时它与旧口径（`period.slice(0,4)`）逐字相同 —— 所以默认配置下
 * 这个函数替换掉原来的写法**不改变任何结果**。
 */
export function fiscalYearOf(period, startMonth = FISCAL_START_DEFAULT) {
  const p = assertPeriod(period)
  const m = Number(startMonth)
  if (!(Number.isInteger(m) && m >= 1 && m <= 12)) {
    throw new ReportError('BAD_FISCAL_START_MONTH', `会计年度起始月必须是 1~12 的整数，收到「${startMonth}」`, 400, { start_month: startMonth })
  }
  const y = Number(p.slice(0, 4))
  const mm = Number(p.slice(5, 7))
  const fromYear = mm >= m ? y : y - 1
  const from = `${fromYear}-${String(m).padStart(2, '0')}`
  // 末月 = 起始年 + 1 年的起始月 再回退一个月（只由 `shiftPeriod` 算，不手写 12 个月前）
  const to = shiftPeriod(`${fromYear + 1}-${String(m).padStart(2, '0')}`, -1)
  return {
    fiscal_year: fromYear,
    start_month: m,
    from,
    to,
    label: m === FISCAL_START_DEFAULT ? String(fromYear) : `${from} ~ ${to}`
  }
}

/**
 * **年结 / 利润分配只在"会计年度 = 自然年"时可用**（批次 U 之四 / ③-c 的**范围界**）。
 *
 * 为什么不顺手把年结也改成按会计年度结：`annual.js` 的整条链建在
 * "年度 = 期间前 4 位"这个结构上（`yearPeriods(db, year)` 按 `substr(period,1,4)` 取集合、
 * `decemberPeriod(year)` 就是 `YYYY-12`、年结凭证与分配的留痕都挂在那一期上，
 * 036 迁移的注释也明说了为什么不为"年度"建表）。要支持跨自然年的年结，
 * 得同时改年结与利润分配两套推导 —— 风险与收益不成比例。
 *
 * 所以这条的纪律是：**"没做"必须可见**，不许静默按自然年结过去。
 * 一个把 4 月起算的年度按自然年结掉的系统，会把它每年的利润切错两半，
 * 而账**仍然是平的**（借贷平衡不受影响）。
 *
 * 为什么只拦"做"、不拦"撤"（`reverseAnnual` / `reverseDistribution` 不拦）：
 * 拦撤销会造出一条**死锁**路径 —— 配置改成非自然年之后，已经做过的年结+分配就再也撤不掉了。
 */
export function assertNaturalFiscalYear(db) {
  const m = fiscalStartMonth(db)
  if (m !== FISCAL_START_DEFAULT) {
    throw new ReportError(
      'FISCAL_YEAR_UNSUPPORTED',
      `当前会计年度起始月是 ${m} 月（settings.fiscal.start_month），而**跨自然年的年结与利润分配未实现** —— `
        + '本系统只支持"会计年度 = 自然年"时做年结；把 4 月起算的年度按自然年结掉，会把它每年的利润切错两半，'
        + '而账仍然是平的（借贷平衡不受影响）。报表侧（本年累计、同比累计）已经支持非 1 月起点。',
      409,
      { fiscal_start_month: m }
    )
  }
  return m
}

// 会计年度的起点由 `fiscalYearOf` 算（默认 1 月 → 与旧口径 `period.slice(0,4)` 逐字相同）。
// `annual.js` 的"年度"是同一个概念，但它只在起始月为 1 时可用（`assertNaturalFiscalYear` 守着）。
export const RANGE_MODES = {
  ytd: { label: '本年累计' }
}

/**
 * 区间模式解析。**区间的起止只由这里算** ——
 * 界面自己拼 `YYYY-01` 是这类功能最常见的错误来源（跨年时忘了改年份、
 * 或者把"年初"写成"上年 12 月"），而错了以后两列都长得像真的。
 */
export function resolveRange(db, { period, range = null }) {
  const p = assertPeriod(period)
  const key = String(range ?? '').trim()
  const sm = fiscalStartMonth(db)
  const fy = fiscalYearOf(p, sm)
  if (!key) {
    // 单期也带会计年度：界面要能说清"这一期属于哪个会计年度"，
    // 而如果只让累计模式知道年度，两类结果里同一个字段的含义就会分叉。
    return { mode: null, mode_label: null, from: p, to: p, is_range: false, year: fy.fiscal_year, fiscal_start_month: sm, fiscal_label: fy.label }
  }
  const spec = RANGE_MODES[key]
  if (!spec) {
    throw new ReportError(
      'BAD_RANGE_MODE',
      `区间模式「${range}」不支持（应为 ${Object.keys(RANGE_MODES).join(' / ')}）`,
      400,
      { range }
    )
  }
  return {
    mode: key,
    // 非 1 月起点时把窗口写进标签：只写"本年累计"的话，读的人会默认它是从 1 月起算的
    mode_label: sm === FISCAL_START_DEFAULT ? spec.label : `${spec.label}（会计年度 ${fy.from} 起）`,
    from: fy.from,
    to: p,
    is_range: true,
    year: fy.fiscal_year,
    fiscal_start_month: sm,
    fiscal_label: fy.label
  }
}

/**
 * `[from, to]` 区间内的科目发生额。**闭区间**（两端都含）——
 * 单期就是 `from === to`，于是"单期"与"区间"是同一条路径。
 */
export function subjectRangeMovements(db, { from, to }) {
  const mv = movementOf(db, { from, to })
  const rows = shapeSubjectRows(allSubjectsOf(db), mv, null)
  const totals = totalsOfRows(rows)
  return {
    // 单期时 `from === to`，这里如实回报窗口的两端（不回报一个"期间"字段 ——
    // 区间没有单一期间可以自称）
    from: mv.from,
    to: mv.to,
    is_range: mv.from !== mv.to,
    rows,
    // **区间没有余额视图**。写成 `null` 而不是留空/写 0：
    // 一个 `null` 会让误用当场炸，一个 0 会让误用安静地算出一份"看起来对"的表。
    opening: null,
    closing: null,
    movement: {
      ...totals,
      voucher_count: mv.voucher_count,
      draft_count: mv.draft_count
    }
  }
}

// ---------------------------------------------------------------------------
// 四之二、"应结转而未结转"的损益科目（批次 M 的判据唯一实现）
// ---------------------------------------------------------------------------
/**
 * 本期还有哪些损益类科目挂着余额（即"该结转而没结转"）。
 *
 * **三个调用方共用这一个判据**：
 *   · `closePeriod` 的前置检查（账没结平就不算定稿）；
 *   · `lib/closing.js` 的 `planClosing`（结转账就由它派生）；
 *   · `auditReport` 的两条自证探针（`PERIOD_CLOSED_NO_CARRY` / `CARRY_INCOMPLETE`）。
 *
 * 为什么放在 `report.js` 而不是 `closing.js`：`closing.js` 依赖本文件
 * （它要从余额算分录），反向 import 会成环；而"有余额未结转"这件事
 * 只用得到科目余额，是报表域的知识。
 *
 * 阈值 0.005（半分）而不是 0：浮点残差不该被当成"还有余额"。
 */
export function uncarriedProfitSubjects(db, { period }) {
  const p = assertPeriod(period)
  return subjectBalances(db, { period: p })
    .rows.filter((r) => r.category === 'profit_loss' && r.is_leaf && Math.abs(Number(r.closing_signed)) > 0.005)
    .map((r) => ({
      subject_id: r.subject_id,
      code: r.code,
      name: r.name,
      direction: r.direction,
      balance_signed: money2(r.closing_signed)
    }))
}

// ---------------------------------------------------------------------------
// 五、现金流量：按凭证分析填列
// ---------------------------------------------------------------------------
export function cashSubjectsOf(db, reportCode = 'cf') {
  const def = db.prepare('SELECT cash_subjects FROM report_defs WHERE report_code=?').get(String(reportCode))
  const raw = String(def?.cash_subjects || '').trim()
  const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_CASH_SUBJECTS.slice()
  return list
}

/** 兜底桶的键：复合凭证的净额落在这里（不是一个真实的科目 id） */
export const CASH_OTHER_BUCKET = '__OTHER__'

// ===========================================================================
// 五之二、现金流量项目（批次 U）：字典 + 分录上的标记
// ===========================================================================
// 「现金流量项目」是一个**跨科目**的独立维度：同一个「销售商品收到的现金」
// 要能同时落在应收账款 / 预收账款 / 主营业务收入 / 销项税额上。
// 所以它不能做成 `accounting_subjects.aux_type` 的又一个取值（那是"挂在某个科目上"的属性），
// 只能是一张自己的字典表 + 分录上的一列（迁移 041）。
//
// 项目比报表行**细**（22 个内置项 vs 现金流量表 10 个科目行），所以
// 「项目 → 报表行」是字典里**显式的一列**（`report_line_code`），不靠 code 命名约定 ——
// 报表行可以被人在界面上改名，靠约定匹配会在改名之后**静默错行**。
export const CASH_FLOW_CATEGORY_LABEL = {
  operating: '经营活动',
  investing: '投资活动',
  financing: '筹资活动'
}
export const CASH_FLOW_DIRECTION_LABEL = { in: '现金流入', out: '现金流出', both: '流入流出皆可' }

/** 表 / 列存在性（本文件不 import 迁移目录的 CommonJS 小工具，就地实现两个纯查询） */
function reportTableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(String(name))
}
function reportColumnExists(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)
  } catch {
    return false
  }
}

/**
 * 这个库支持"现金流量项目标记"吗（041 迁移跑过没有）。
 *
 * 为什么**按能力探测**而不是假设它一定在：迁移随下次启动跑，
 * 而报表计算可能在迁移之前就被调用（存量库、单跑某个测试脚本）。
 * 「没有放标记的地方」与「没有标记」是同一件事 —— 都走纯分析路径，
 * 结果与加这一维之前**逐字节相同**。硬要求表存在只会把"库还没迁移"
 * 表现成"报表算不出来"，那是另一类更糟的失败。
 */
function cfTagSupportOf(db) {
  return reportColumnExists(db, 'voucher_entries', 'cash_flow_item') && reportTableExists(db, 'cash_flow_items')
}

/** 现金流量项目字典（只读列表）。缺省不给 filter 就是全部 —— 调用方自己决定要不要只看 active。 */
export function listCashFlowItems(db, { category = null, status = null, keyword = null } = {}) {
  // 没有 041 的库：**明确拒绝**而不是返回空数组 —— "字典是空的"与"这个库还没有这一维"
  // 是两句完全不同的话，而返回空数组会让后者看起来像前者（040 立过的同一条规矩：
  // 不静默返回空快照，静默的空会让排查方向整个偏掉）。
  if (!cfTagSupportOf(db)) {
    throw new ReportError('CF_ITEM_UNSUPPORTED', '这个库还没有执行 041 迁移（没有现金流量项目字典），先跑一次迁移', 409)
  }
  const where = []
  const args = []
  if (category) {
    where.push('category = ?')
    args.push(String(category))
  }
  if (status) {
    where.push('status = ?')
    args.push(String(status))
  }
  if (keyword) {
    where.push('(code LIKE ? OR name LIKE ?)')
    args.push(`%${keyword}%`, `%${keyword}%`)
  }
  const rows = db
    .prepare(
      `SELECT id, code, name, category, direction, is_builtin, report_line_code, sort_no, status, remark,
              created_at, updated_at
         FROM cash_flow_items
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY sort_no, code`
    )
    .all(...args)
  return rows.map((row) => ({
    ...row,
    is_builtin: Number(row.is_builtin) === 1,
    category_label: CASH_FLOW_CATEGORY_LABEL[row.category] || row.category,
    direction_label: CASH_FLOW_DIRECTION_LABEL[row.direction] || row.direction
  }))
}

/** 字典的元数据（类别 / 方向标签 + 几个**如实报出来的计数**） */
export function cashFlowItemMeta(db) {
  if (!cfTagSupportOf(db)) {
    throw new ReportError('CF_ITEM_UNSUPPORTED', '这个库还没有执行 041 迁移（没有现金流量项目字典），先跑一次迁移', 409)
  }
  const total = Number(db.prepare('SELECT COUNT(*) c FROM cash_flow_items').get().c || 0)
  const active = Number(db.prepare("SELECT COUNT(*) c FROM cash_flow_items WHERE status='active'").get().c || 0)
  const mapped = Number(
    db.prepare("SELECT COUNT(*) c FROM cash_flow_items WHERE status='active' AND report_line_code IS NOT NULL AND report_line_code <> ''").get().c || 0
  )
  // 「落点不明」：项目指向的报表行不存在了（行可以在界面上被删掉）。
  // 这不是错误（删一行口径是合法操作），但它会让挂在这些项目上的标记**落不到行上** ——
  // 所以必须**能查**，不能让读表的人自己猜为什么有的标记没生效。
  const orphan = Number(
    db
      .prepare(`
        SELECT COUNT(*) c FROM cash_flow_items i
         WHERE i.status='active' AND i.report_line_code IS NOT NULL AND i.report_line_code <> ''
           AND NOT EXISTS (SELECT 1 FROM report_lines l WHERE l.report_code='cf' AND l.line_code = i.report_line_code)
      `)
      .get().c || 0
  )
  return {
    categories: Object.entries(CASH_FLOW_CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
    directions: Object.entries(CASH_FLOW_DIRECTION_LABEL).map(([value, label]) => ({ value, label })),
    total,
    active,
    mapped_active: mapped,
    orphan_count: orphan,
    report_code: 'cf'
  }
}

/**
 * 给一张凭证的若干分录打 / 改 / 清「现金流量项目」标记。
 *
 * 判据全在这里（路由只取参数、翻译错误）：
 *   · 凭证必须存在、**不能是已作废**（往作废凭证上写标记是给自己埋坑：它不计入任何账）；
 *   · 分录必须属于这张凭证（按行号定位，而行号就是 `voucher_entries.seq`）；
 *   · 项目必须在字典里且 active —— 标一个字典里没有的项目不会报错，
 *     只会让那一笔**静默退回**按对手科目分析填列，而分析出来的行与标的人想的不是同一行；
 *   · **现金类科目的分录不允许标记**。现金流量项目回答的是"这笔钱是什么性质"，
 *     现金分录本身是"钱动了"这一事实；标它既没有意义，也会被归集逻辑忽略（现金分录不进分桶）——
 *     静默忽略比拒绝危险得多；
 *   · **改动已有标记（改值 / 清除）必须写理由**。危险是**差分驱动**的：
 *     在空白分录上第一次标项目是日常动作，而把一笔已经定过性的钱改到别的项目上，
 *     等于改了这一期报表的一行金额 —— 那需要一句"为什么"。
 */
export function tagVoucherCashFlow(db, { voucherId, entries, actor = null, reason = null }) {
  const id = Number(voucherId)
  if (!Number.isInteger(id) || id <= 0) {
    throw new ReportError('BAD_VOUCHER_ID', `凭证 id「${voucherId}」不合法`, 400)
  }
  const voucher = db.prepare('SELECT id, doc_no, period, status FROM vouchers WHERE id=?').get(id)
  if (!voucher) throw new ReportError('VOUCHER_NOT_FOUND', `凭证 #${id} 不存在`, 404)
  if (voucher.status === 'voided') {
    throw new ReportError('VOUCHER_VOIDED', `凭证 ${voucher.doc_no} 已作废：作废凭证不计入任何报表，改它的现金流量项目没有意义`, 409)
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ReportError('ENTRIES_REQUIRED', '必须给出要标记的分录（entries: [{ line_no, cash_flow_item }]）', 400)
  }
  if (!cfTagSupportOf(db)) {
    throw new ReportError('CF_ITEM_UNSUPPORTED', '这个库还没有执行 041 迁移（缺现金流量项目字典或分录标记列），无法打标记', 409)
  }

  const cashCodes = new Set(cashSubjectsOf(db, 'cf'))
  const subjectCodeOf = new Map(
    db.prepare('SELECT id, code FROM accounting_subjects').all().map((r) => [Number(r.id), String(r.code)])
  )
  const dict = new Map(db.prepare('SELECT code, status FROM cash_flow_items').all().map((r) => [String(r.code), String(r.status)]))
  // ⚠️ 「行号」= `voucher_entries.seq`（凭证详情接口里那个字段就是它）。
  // 表上没有 `line_no` 这一列 —— 分录的行号一直叫 `seq`，这里沿用同一个名字，
  // 不再造第二个叫法（同一个东西两个名字是本项目反复踩过的坑）。
  const current = new Map(
    db
      .prepare('SELECT seq, subject_id, subject_name, cash_flow_item FROM voucher_entries WHERE voucher_id=?')
      .all(id)
      .map((e) => [Number(e.seq), e])
  )

  // **两轮**校验：先解决"这一行是谁"，再校验"这个项目合不合法"。
  // 反过来（逐条边解析边校验）会让"同一行出现两次"这种**批次级的**错误被
  // 第一条的项目校验抢先抛掉 —— 报出来的错指向一个次要问题，真正的问题被盖住。
  const planned = []
  const seen = new Set()
  for (const raw of entries) {
    // `line_no` 与 `seq` 两个键都收（`seq` 是凭证详情里那个字段名，`line_no` 是接口契约里的名字）——
    // 收两个只是为了调用方不用猜，落库与回报统一用 `line_no` 这一个名字。
    const rawLine = raw?.line_no ?? raw?.seq
    const lineNo = Number(rawLine)
    if (!Number.isInteger(lineNo) || lineNo <= 0) {
      throw new ReportError('BAD_LINE_NO', `分录行号「${rawLine}」不合法（行号即分录的 seq）`, 400)
    }
    if (seen.has(lineNo)) {
      throw new ReportError('DUPLICATE_LINE_NO', `第 ${lineNo} 行在同一批里出现了两次：同一个行号只能有一个结果`, 400)
    }
    seen.add(lineNo)
    const entry = current.get(lineNo)
    if (!entry) {
      throw new ReportError('ENTRY_NOT_FOUND', `凭证 ${voucher.doc_no} 没有第 ${lineNo} 行分录`, 400)
    }
    const rawItem = raw?.cash_flow_item
    const code = rawItem === null || rawItem === undefined || String(rawItem).trim() === '' ? null : String(rawItem).trim()
    planned.push({ line_no: lineNo, entry, from: entry.cash_flow_item ?? null, to: code })
  }

  for (const p of planned) {
    if (!p.to) continue
    if (!dict.has(p.to)) {
      throw new ReportError('CF_ITEM_NOT_FOUND', `现金流量项目「${p.to}」不在字典里（标一个字典里没有的项目，会让这一笔静默退回按对手科目分析填列）`, 400)
    }
    if (dict.get(p.to) !== 'active') {
      throw new ReportError('CF_ITEM_INACTIVE', `现金流量项目「${p.to}」已停用：停用项不该再被标到新的分录上`, 400)
    }
    const subjectCode = subjectCodeOf.get(Number(p.entry.subject_id))
    if (cashCodes.has(subjectCode)) {
      throw new ReportError(
        'CF_ITEM_ON_CASH_ENTRY',
        `第 ${p.line_no} 行挂的是现金类科目（${subjectCode} ${p.entry.subject_name}）：现金流量项目标的是**对手方**那一笔，现金分录本身不标记`,
        400
      )
    }
  }

  // 差分驱动的理由要求：只在**改动已定性的那一笔**时要（改值或清除）
  const changes = planned.filter((p) => (p.from ?? null) !== (p.to ?? null))
  const destructive = changes.filter((p) => p.from !== null && p.from !== p.to)
  if (destructive.length && !String(reason ?? '').trim()) {
    throw new ReportError(
      'CF_TAG_REASON_REQUIRED',
      `本次要改动 ${destructive.length} 条**已经标过的**分录（第 ${destructive.slice(0, 3).map((p) => p.line_no).join('、')} 行）：改一笔已经定过性的钱，等于改这一期报表的一行金额，必须写理由`,
      409
    )
  }

  const upd = db.prepare('UPDATE voucher_entries SET cash_flow_item=? WHERE voucher_id=? AND seq=?')
  db.transaction(() => {
    for (const p of changes) upd.run(p.to, id, p.line_no)
  })()

  return {
    voucher_id: id,
    doc_no: voucher.doc_no,
    period: voucher.period,
    status: voucher.status,
    // 只回报**改动本身**（改动前后），不把整行分录塞进返回值 ——
    // 留痕要的是"从什么变成什么"，多带一份分录快照是第二份真相。
    changed: changes.map((p) => ({ line_no: p.line_no, from: p.from, to: p.to })),
    unchanged: planned.length - changes.length,
    tagged_total: db.prepare("SELECT COUNT(*) c FROM voucher_entries WHERE voucher_id=? AND cash_flow_item IS NOT NULL AND cash_flow_item <> ''").get(id).c,
    reason: reason ?? null,
    actor
  }
}

/**
 * 把某期间**涉及现金**的凭证，按对手科目分桶 —— 并**优先**按分录上的现金流量项目归行。
 *
 * 返回 `{ buckets, item_buckets, cash_in, cash_out, net, complex_vouchers, cash_vouchers, ... }`
 *   · `buckets`: Map<subjectId|'__OTHER__', { credit, debit }> —— **未标记**的非现金分录按对手科目累计
 *   · `item_buckets`: Map<reportLineNo, number> —— **标记**分录按项目对应的报表行累计的带符号金额
 *   · `net` = Σ(cash_in − cash_out) = 现金类科目本期净变动
 *   · `complex_vouchers`: 走了净额法的凭证数（**不含**标记凭证，如实回报，不假装精确归类）
 *   · `tagged_count` / `untagged_count`: 靠标记归行的分录数 / 靠分析推出来的分录数
 *     —— 读表的人必须能判断"这一行是记的还是推的"
 *
 * 恒等式（对两种填列路都成立）：`Σ item_buckets + Σ buckets → 各行金额` = `net`。
 * 因为对任一非现金分录 e 都有 `贡献 = −signed(e)`，而借贷平衡给出
 * `Σ(全部分录) −signed = cd − cc`（现金分录的 −signed 恰好就是 cd − cc）。
 */
export function cashFlowBuckets(db, { period, from = null, to = null, cashSubjects, reportCode = 'cf' }) {
  // 区间的两端只由 `resolveRange` 推出来（批次 P）。`from`/`to` 缺省即单期。
  const a = assertPeriod(from || period)
  const b = assertPeriod(to || period)
  const cash = (cashSubjects || DEFAULT_CASH_SUBJECTS).map(String)
  const cashSet = new Set(cash)
  const codes = db.prepare('SELECT id, code FROM accounting_subjects').all()
  const codeOf = new Map(codes.map((r) => [Number(r.id), String(r.code)]))

  // ---- 标记能力与"项目 → 报表行"的落点表（一次性读，逐张凭证复用）----
  // 落点解析成**报表行号**而不是行 code：行号是 `amounts` 这张表的键，
  // 而行 code 在界面改名之后就失效了 —— 那会让标记**静默落到别的行**（或落空）。
  const tagSupported = cfTagSupportOf(db)
  const lineOfItem = new Map() // 项目 code -> report_lines.line_no
  if (tagSupported) {
    // 只认**科目行**（`line_type='item'` 且不是兜底行）：小计/合计行的金额是算出来的，
    // 把标记落到小计上只会让那一行被加两次；兜底行的语义是"未能归类"，
    // 而打标记恰恰是"已经归好类了"——落上去等于自相矛盾。
    const lineNoByCode = new Map(
      db
        .prepare(
          `SELECT line_no, line_code FROM report_lines
            WHERE report_code=? AND line_type='item' AND COALESCE(is_fallback,0)=0`
        )
        .all(String(reportCode))
        .map((r) => [String(r.line_code), Number(r.line_no)])
    )
    for (const it of db.prepare("SELECT code, report_line_code FROM cash_flow_items WHERE status='active'").all()) {
      const ln = it.report_line_code ? lineNoByCode.get(String(it.report_line_code)) : undefined
      if (ln !== undefined) lineOfItem.set(String(it.code), ln)
    }
  }

  // 区间与单期的差别**只在这一行** —— 按期间窗口取凭证。
  // 其余逻辑（逐张凭证分析、单边配对、复合凭证归兜底桶）都是**按单张凭证独立**处理的，
  // 所以"逐月各算一次再相加"与"整段一次算"必然相同 —— 这条性质正是
  // `auditReport` 第 ⑨ 条探针（累计 = 逐月相加）能成立的原因。
  const vouchers = db
    .prepare("SELECT id FROM vouchers WHERE status='posted' AND period >= ? AND period <= ? ORDER BY id")
    .all(a, b)
  // 没有标记能力时**不查那一列**（那个库还没有 041）：SQL 里少一个字段，
  // 于是整条路径与原实现逐字一致，不存在"取了个不存在的列"这种失败。
  const entriesOf = db.prepare(
    `SELECT subject_id, direction, amount${tagSupported ? ', cash_flow_item' : ''} FROM voucher_entries WHERE voucher_id=? ORDER BY seq`
  )

  const buckets = new Map()
  const bump = (key, dir, amt) => {
    const cur = buckets.get(key) || { credit: 0, debit: 0 }
    cur[dir] = money2(cur[dir] + amt)
    buckets.set(key, cur)
  }

  const itemBuckets = new Map() // report line_no -> 带符号金额
  let cashIn = 0
  let cashOut = 0
  let cashVouchers = 0
  let complexVouchers = 0
  let taggedVouchers = 0
  let taggedCount = 0
  let nonCashCount = 0
  let taggedUnresolved = 0
  const complexList = []

  for (const v of vouchers) {
    const entries = entriesOf.all(v.id)
    let cd = 0
    let cc = 0
    const others = [] // 未标记的非现金分录：走对手科目分析
    const taggedRaw = [] // 带标记的非现金分录：优先按项目归行
    let voucherNonCash = 0
    for (const e of entries) {
      const isCash = cashSet.has(codeOf.get(Number(e.subject_id)))
      const amt = money2(e.amount)
      if (isCash) {
        if (e.direction === 'debit') cd = money2(cd + amt)
        else cc = money2(cc + amt)
      } else {
        voucherNonCash += 1
        const item = tagSupported && e.cash_flow_item ? String(e.cash_flow_item) : null
        const o = { id: Number(e.subject_id), direction: e.direction, amount: amt, item }
        if (item) taggedRaw.push(o)
        else others.push(o)
      }
    }
    if (cd === 0 && cc === 0) continue // 不涉及现金：既不是流入也不是流出
    cashVouchers += 1
    nonCashCount += voucherNonCash
    cashIn = money2(cashIn + cd)
    cashOut = money2(cashOut + cc)

    // 标记 → 报表行。落不到行上的（项目没配落点、或那一行被删了）**退回分析**：
    // 不静默丢账，也不假装归了 —— 计入 `tagged_unresolved_count` 如实报出来。
    const tagged = []
    for (const t of taggedRaw) {
      const ln = lineOfItem.get(String(t.item))
      if (ln === undefined) {
        taggedUnresolved += 1
        others.push(t)
        continue
      }
      // 非现金分录是借方 ⇒ 钱出去了 ⇒ 对报表行的贡献是负；
      // 与下面按对手科目归行的取号口径**必须一致**（`dir === 'credit' ? amt : -amt`）。
      tagged.push({ line_no: ln, amount: t.direction === 'credit' ? t.amount : -t.amount })
    }

    // ⚠️ 这里是唯一的岔路口。**一张分录都没有标记时，走的完全是原来的分析路径** ——
    //    存量库（没有 041）与存量凭证（没打标记）都落在这一支，结果逐字节不变。
    if (tagged.length === 0) {
      const otherDebit = money2(others.filter((o) => o.direction === 'debit').reduce((s, o) => s + o.amount, 0))
      const otherCredit = money2(others.filter((o) => o.direction === 'credit').reduce((s, o) => s + o.amount, 0))
      // 单边配对：非现金分录方向单一、且金额正好对上现金侧
      const pureIn = cc === 0 && otherDebit === 0 && Math.abs(otherCredit - cd) <= 0.005
      const pureOut = cd === 0 && otherCredit === 0 && Math.abs(otherDebit - cc) <= 0.005
      if (pureIn || pureOut) {
        for (const o of others) bump(o.id, o.direction, o.amount)
        continue
      }
      // 复合凭证（含现金内部划转）：净额归兜底桶，并如实记账
      const net = money2(cd - cc)
      if (net !== 0) bump(CASH_OTHER_BUCKET, net > 0 ? 'credit' : 'debit', Math.abs(net))
      complexVouchers += 1
      complexList.push({ voucher_id: v.id, net })
      continue
    }

    // ---- 标记路径：标记分录按项目归行；**剩余**非现金分录的净额归兜底桶 ----
    // 为什么剩余部分不再做单边配对：标记分录已经把现金侧的一部分"花掉"了，
    // 剩下的这些与现金侧再也对不上（对不上就会整张被当成复合凭证 ⇒ 与标记部分重复计）。
    // 而"剩余净额进兜底桶"仍然严格满足恒等式：
    //   Σ(标记贡献) + Σ(剩余贡献) = −Σ(signed 所有非现金分录) = cd − cc
    taggedVouchers += 1
    taggedCount += tagged.length
    for (const t of tagged) {
      itemBuckets.set(t.line_no, money2((itemBuckets.get(t.line_no) || 0) + t.amount))
    }
    const residual = money2(others.reduce((s, o) => s + (o.direction === 'credit' ? o.amount : -o.amount), 0))
    if (residual !== 0) bump(CASH_OTHER_BUCKET, residual > 0 ? 'credit' : 'debit', Math.abs(residual))
    complexList.push({ voucher_id: v.id, net: money2(cd - cc), tagged: tagged.length, residual })
  }

  return {
    period: b,
    from: a,
    to: b,
    is_range: a !== b,
    buckets,
    item_buckets: itemBuckets,
    cash_subjects: cash,
    cash_in: cashIn,
    cash_out: cashOut,
    net: money2(cashIn - cashOut),
    cash_vouchers: cashVouchers,
    complex_vouchers: complexVouchers,
    complex_list: complexList,
    // 标记填列 vs 分析倒推：**如实报出条数**，界面据此说明"这一行是记的还是推的"
    tag_supported: tagSupported,
    tagged_count: taggedCount,
    untagged_count: nonCashCount - taggedCount,
    tagged_vouchers: taggedVouchers,
    tagged_unresolved_count: taggedUnresolved
  }
}

// ---------------------------------------------------------------------------
// 六、报表计算（唯一的计算入口：`computeReport`）
// ---------------------------------------------------------------------------
/**
 * 按报表定义算出一张报表。
 *
 * 两轮计算，**不是**拓扑排序：
 *   ① 先算全部 `item` 行（含兜底行）—— item 行只依赖科目余额表与现金流桶；
 *   ② 再按 `line_no` 升序算 `subtotal` / `total` 行 —— 它们只引用**已算出的行金额**。
 * 之所以能这么写：本项目的小计表达式只允许行号加减（无嵌套、无跨表），
 * 所以"被引用的行"要么是 item 行（第一轮已好），要么是行号更小的 subtotal 行（第二轮已好）。
 * 兜底行是 item 行，因此在 total 引用它时已经算完 —— 这一点靠第二轮保证，不靠行号大小。
 */
export function computeReport(db, { reportCode, period, range = null }) {
  const def = getReportDef(db, reportCode)
  const p = assertPeriod(period)
  const rg = resolveRange(db, { period: p, range })

  // ---- 时点口径与"本年累计"**互斥**，显式拦掉而不是静默当成单期 ----
  // 资产负债表回答"截至某一刻的家底"，而累计要求"把若干期加总" ——
  // 两者不是同一个问题。硬做出来的结果只有两种：两列一模一样（本月 = 累计，
  // 当 1 月时其实也对）或者一列是**把时点数加了若干遍**的荒唐数，两种都很难被看出来。
  // 所以这里给 409 + 一句人话，而不是给一份"看起来有累计"的表。
  if (rg.is_range && def.basis === 'balance') {
    throw new ReportError(
      'RANGE_NOT_APPLICABLE',
      `报表「${def.name}」是**时点**口径（${def.basis_label}），没有"${rg.mode_label}"这回事：`
        + '累计要求把若干期加总，而它回答的是"截至某一刻的家底"。要看的是本期这一张表。',
      409,
      { report_code: reportCode, basis: def.basis, range: rg.mode }
    )
  }

  // 本期这一列（**永远先算**，它同时也是累计的最后一期）
  const cur = windowReport(db, { reportCode, def, period: p, rg: null })
  if (!rg.is_range) {
    return {
      ...cur,
      range_meta: { mode: null, mode_label: null, from: p, to: p, is_range: false, year: rg.year },
      columns: columnsOf({ period: p })
    }
  }

  // 累计这一列：**再调同一个 `windowReport`**，只是窗口不同。
  // 与跨期比较同一个道理 —— 两列必须来自同一个实现，不许有一列"自己再算一遍"。
  const ytd = windowReport(db, { reportCode, def, period: p, rg })
  const ytdByCode = new Map(ytd.rows.map((r) => [r.line_code, r.amount]))
  const rows = cur.rows.map((r) => {
    const v = ytdByCode.get(r.line_code)
    // 行缺失就抛：静默补 0 会把"累计少一行"表现成"这一项本年累计是 0"，
    // 而一个假的 0 比一个报错危险得多（批次 N 的同一条规矩）。
    if (v === undefined) {
      throw new ReportError(
        'RANGE_LINE_MISSING',
        `报表「${def.name}」的本年累计（${rg.from}~${rg.to}）缺少第 ${r.line_no} 行「${r.line_name}」（line_code=${r.line_code}）`,
        500,
        { report_code: reportCode, line_code: r.line_code, from: rg.from, to: rg.to }
      )
    }
    return { ...r, ytd_amount: money2(v) }
  })

  return {
    ...cur,
    rows,
    ytd,
    range_meta: { mode: rg.mode, mode_label: rg.mode_label, from: rg.from, to: rg.to, is_range: true, year: rg.year },
    columns: columnsOf({ withRange: true, period: p, rangeFrom: rg.from, rangeTo: rg.to })
  }
}

/**
 * **一个取数窗口**算出一张报表（内部）。
 *
 * 本期与"本年累计"都调它 —— 两个窗口、**同一个实现**。
 * `rg` 为 `null` 表示单期（窗口 = 本期）；给 `resolveRange` 的结果表示按该区间取数。
 */
function windowReport(db, { reportCode, def, period, rg }) {
  const p = assertPeriod(period)
  const lines = listReportLines(db, reportCode)
  if (!lines.length) throw new ReportError('REPORT_EMPTY', `报表「${def.name}」还没有定义任何行`, 409)

  // 方向过滤只在现金流口径下有意义。**显式拦掉**而不是静默忽略 ——
  // 配置里写着、行为里没有，是最危险的一种不一致（改的人以为它生效了）。
  if (def.basis !== 'cash_flow') {
    const bad = lines.find((l) => l.only_direction)
    if (bad) {
      throw new ReportError(
        'ONLY_DIRECTION_UNSUPPORTED',
        `行「${bad.line_name}」设置了方向过滤，但报表「${def.name}」的取数口径（${def.basis_label}）不支持方向过滤`,
        500,
        { report_code: reportCode, line_code: bad.line_code }
      )
    }
  }

  const isCashBasis = def.basis === 'cash_flow'
  // 区间取数**没有余额视图**，所以余额口径的报表在 `computeReport` 里就被拦掉了
  // （见那条 `RANGE_NOT_APPLICABLE`）；这里 `balances` 与 `movements` 只会有一个非空。
  const balances = isCashBasis || rg ? null : subjectBalances(db, { period: p })
  const movements = !isCashBasis && rg ? subjectRangeMovements(db, { from: rg.from, to: rg.to }) : null
  const view = balances || movements
  const cash = isCashBasis
    ? cashFlowBuckets(db, {
        period: p,
        from: rg ? rg.from : null,
        to: rg ? rg.to : null,
        cashSubjects: cashSubjectsOf(db, reportCode)
      })
    : null

  const amounts = new Map() // line_no -> money
  const claimed = new Set() // 已被某行认领的科目 id / 现金桶键
  const claimedBy = new Map() // 科目 id / 桶键 -> 行号

  const itemLines = lines.filter((l) => l.line_type === 'item' && !l.is_fallback)
  const fallbackLine = lines.find((l) => l.line_type === 'item' && l.is_fallback) || null
  const segsOf = new Map(itemLines.map((l) => [l, parseSubjectRange(l.subject_range)]))

  const claim = (line, key) => {
    claimed.add(key)
    if (!claimedBy.has(key)) claimedBy.set(key, line.line_no)
  }
  const addTo = (line, raw) => amounts.set(line.line_no, money2((amounts.get(line.line_no) || 0) + line.sign * raw))

  // **所有 item 行的金额先初始化为 0**，再往上加。
  // 为什么必做：现金流口径下，"本期没有任何一笔匹配到这一行"是完全正常的
  // （例如本期没交过税）。但如果那一行压根没被写进 `amounts`，
  // 引用它的小计会在第二轮报 `SUBTOTAL_REF_MISSING` —— 报的却是
  // "第 2 行还没算出来"，指向一个**其实只是没有发生额**的行。
  for (const l of itemLines) amounts.set(l.line_no, 0)

  // ---- 第一轮：item 行（不含兜底行） ----
  if (isCashBasis) {
    // 现金流口径：按 **(科目, 方向)** 分配到**第一个**匹配的行。
    // 为什么不能按科目整体认领：同一个科目在两个方向上语义不同 ——
    // 贷 222101 是"随货款代收的销项税"（属销售收现），借 222101 是"实际缴税"（属支付税费）。
    // 按科目认领会让后来那一行**永远分不到**，而报表看起来完全正常。
    for (const [key, b] of cash.buckets) {
      if (key === CASH_OTHER_BUCKET) continue // 复合凭证净额只归兜底行
      const code = codeOfCached(db, key)
      if (!code) continue
      for (const dir of ['credit', 'debit']) {
        const amt = money2(b[dir])
        if (amt === 0) continue
        const hit = itemLines.find((l) => (!l.only_direction || l.only_direction === dir) && inSubjectRange(code, segsOf.get(l)))
        if (!hit) continue
        addTo(hit, dir === 'credit' ? amt : -amt)
        claim(hit, `${key}|${dir}`)
      }
    }
    // 现金流量项目标记（批次 U）：**优先于上面那一段** —— 标记是人给的答案，
    // 对手科目分析只是推出来的。两者的分工由 `cashFlowBuckets` 决定：
    // 一条分录要么进 `buckets`（分析），要么进 `item_buckets`（标记），不会两边都进。
    // 键是**报表行号**，且只在 `line_type='item'` 且非兜底的行里解析出来的
    // （见 `cashFlowBuckets` 的落点解析）—— 所以这里一定找得到那一行。
    // 真找不到就跳过：宁可报告里少一行（`CF_MISMATCH` 会当场报出来），
    // 也不把它兜到别的行上 —— 归错行比缺一行更难被发现。
    for (const [lineNo, raw] of cash.item_buckets) {
      const hit = itemLines.find((l) => Number(l.line_no) === Number(lineNo))
      if (!hit) continue
      addTo(hit, raw)
      claim(hit, `item:${lineNo}`)
    }
  } else {
    // 余额 / 发生额口径：区间按设计应当**互不重叠**，所以每个科目落在哪一行是唯一确定的。
    // 这里仍然"每个匹配的行都算一次"（而不是首个匹配），是为了让配置重叠时**两次相加**
    // ⇒ 报表立刻不平 ⇒ `auditReport` 报出来，而不是悄悄少算一块。
    for (const line of itemLines) {
      const segs = segsOf.get(line)
      let sum = 0
      for (const r of view.rows) {
        if (!inSubjectRange(r.code, segs)) continue
        // `amount` 口径取 `operating_signed`（**剔除期末结转账**）——
        // 含它的话，结账之后利润表的收入行会被结转的借方冲平，净利润变成 0。
        sum += def.basis === 'balance' ? r.closing_signed : r.operating_signed
        claim(line, Number(r.subject_id))
      }
      amounts.set(line.line_no, money2(line.sign * sum))
    }
  }

  // ---- 兜底行：只接"没人认领的" ----
  // ⚠️ 它必须**排在最后**被计算，否则它会先把科目抢走，上面的行一道也认领不到。
  //   这也是「一张报表只能有一个兜底行」那条约束的原因。
  //
  // 对资产负债表 / 利润表，兜底行**应当恒为 0** —— 接了人就说明配置漏了科目，
  // `auditReport` 会拿这条当探针报出来（兜底行的用途是"不让金额凭空消失"，不是"掩盖漏配"）。
  // 对现金流量表，兜底行**会**有金额：复合凭证的净额本来就归不到任何一行，那是预期的。
  if (fallbackLine) {
    const segs = parseSubjectRange(fallbackLine.subject_range)
    let sum = 0
    if (isCashBasis) {
      // 逐 (科目, 方向) 判断有没有被认领 —— 与上面的认领键**必须同构**，
      // 否则"贷方已归销售收现、借方无人认领"的那一类会整块掉进兜底（或整块消失）。
      for (const [key, b] of cash.buckets) {
        const code = key === CASH_OTHER_BUCKET ? null : codeOfCached(db, key)
        for (const dir of ['credit', 'debit']) {
          const amt = money2(b[dir])
          if (amt === 0) continue
          if (claimed.has(`${key}|${dir}`)) continue
          if (code && !inSubjectRange(code, segs)) continue
          sum += dir === 'credit' ? amt : -amt
          claim(fallbackLine, `${key}|${dir}`)
        }
      }
    } else {
      for (const r of view.rows) {
        if (claimed.has(Number(r.subject_id))) continue
        if (!inSubjectRange(r.code, segs)) continue
        // `amount` 口径取 `operating_signed`（**剔除期末结转账**）——
        // 含它的话，结账之后利润表的收入行会被结转的借方冲平，净利润变成 0。
        sum += def.basis === 'balance' ? r.closing_signed : r.operating_signed
        claim(fallbackLine, Number(r.subject_id))
      }
    }
    amounts.set(fallbackLine.line_no, money2(fallbackLine.sign * sum))
  }

  // ---- 第二轮：subtotal / total（按 line_no 升序） ----
  // 之所以不需要拓扑排序：小计表达式只允许行号加减（无嵌套、无跨表），
  // 所以被引用的行要么是 item 行（第一轮已好），要么是行号更小的 subtotal 行（第二轮已好）。
  // 兜底行是 item 行，因此 total 引用它时也已经算完。
  const subLines = lines.filter((l) => l.line_type !== 'item').sort((a, b) => Number(a.line_no) - Number(b.line_no))
  for (const line of subLines) {
    let sum = 0
    for (const ref of parseSubtotalExpr(line.subtotal_expr)) {
      const amt = amounts.get(ref.no)
      if (amt === undefined) {
        throw new ReportError(
          'SUBTOTAL_REF_MISSING',
          `行「${line.line_name}」引用了尚未算出的第 ${ref.no} 行（表达式 ${line.subtotal_expr}）`,
          500,
          { report_code: reportCode, line_code: line.line_code }
        )
      }
      sum += ref.sign * amt
    }
    amounts.set(line.line_no, money2(line.sign * sum))
  }

  const rows = [...lines]
    .sort((a, b) => Number(a.order_no) - Number(b.order_no) || Number(a.line_no) - Number(b.line_no))
    .map((l) => ({ ...l, amount: amounts.get(l.line_no) ?? 0 }))

  return {
    report_code: reportCode,
    report_name: def.name,
    basis: def.basis,
    basis_label: def.basis_label,
    period: p,
    rows,
    lines,
    // 余额视图（单期的余额 / 发生额口径报表才有）
    balances,
    // 区间发生额视图（本年累计才有）—— 与 `balances` 只会有一个非空
    movements,
    // 本窗口的取数窗口（供自证用：**结果自称的期间必须由实际算出来的窗口派生**）
    window: rg
      ? { from: rg.from, to: rg.to, is_range: true, mode: rg.mode }
      : { from: p, to: p, is_range: false, mode: null },
    cash,
    claimed_subject_ids: [...claimed],
    claimed_by: claimedBy,
    // 按 `line_code` 取任意一行的金额（**含科目行**，不只是小计行）——
    // 报表自证的探针要按机器键找行，不能按中文名（改个名字探针就瞎了）；
    // 只要小计行的话，`BS_ASSETS_TOTAL` 这类键就够，但 `PL_REVENUE` 是科目行，
    // 一样需要能按键取到（否则复算只能靠"第几行"这种位置约定）。
    totals: Object.fromEntries(lines.map((l) => [l.line_code, amounts.get(l.line_no) ?? 0])),
    // 行类型为 subtotal / total 的那些（真正的"合计项"），供界面单独突出
    totals_only: Object.fromEntries(lines.filter((l) => l.line_type !== 'item').map((l) => [l.line_code, amounts.get(l.line_no) ?? 0]))
  }
}

// 科目码缓存（现金流分桶里按 id 反查 code，避免每次回表）
const codeCache = new WeakMap()
function codeOfCached(db, subjectId) {
  let m = codeCache.get(db)
  if (!m) {
    m = new Map(db.prepare('SELECT id, code FROM accounting_subjects').all().map((r) => [Number(r.id), String(r.code)]))
    codeCache.set(db, m)
  }
  return m.get(Number(subjectId))
}

/** 报表计算里对外的三个门面 —— 都只是 `computeReport` 的薄封装（**不重复算**） */
export function balanceSheet(db, { period, range = null }) {
  return computeReport(db, { reportCode: 'bs', period, range })
}
export function incomeStatement(db, { period, range = null }) {
  return computeReport(db, { reportCode: 'pl', period, range })
}
export function cashFlow(db, { period, range = null }) {
  return computeReport(db, { reportCode: 'cf', period, range })
}

// ---------------------------------------------------------------------------
// 六之二、跨期比较（批次 N）：上期（环比）/ 去年同期（同比）
// ---------------------------------------------------------------------------
// 「这期利润 12 万」不是结论，「这期利润 12 万，上期 30 万」才是。
// 但跨期比较有一类非常隐蔽的失败方式：**比较列自己算一遍**。
// 一旦比较走了第二条取数路径，它就和"单独打开那一期"不是同一个数 ——
// 而两个数都长得像真的，谁也不报错，只有对账的人会怀疑自己看错了。
// 所以本批的两条硬口径是：
//   · **基期列 = 对基期单独调 `computeReport` 的结果逐行相同**（唯一实现）；
//   · **差额 = 两列相减**，不"再算一遍"（再算一遍就有了第二个真值）。
// 两条都由 `auditComparison` 做成可执行断言 —— 不靠人记得。
//
// 为什么**只做环比与同比，不做"本年累计"**：
//   累计列要求"发生额按区间聚合"，那会让 `subjectBalances` 同时承担"单期"与"区间"
//   两套语义，而它是三张报表唯一的取数口 —— 为一个多出来的比较列去动摇它，
//   代价比收益大。这是**范围裁剪，不是遗漏**：累计口径留给后续批次单独设计。
//
// 时点 vs 期间（这一节的会计判断）：
//   · 资产负债表是**时点**口径：比较的是"两个时点的家底"。所以"上期"对它的含义
//     就是"上期末"，而**上期末就是本期期初** —— 这给出一条额外的强恒等式，
//     已由 `auditReport` 的第 ⑦ 条探针独立守着（不依赖比较功能）。
//   · 利润表 / 现金流量表是**期间**口径：比较的是"两个期间各发生了多少"。
// 为什么**只做环比、同比与自定义基期，不做"累计的比较"**（批次 P 仍不做）：
//   "上年同期累计"要求把去年同期**也**算成累计（去年同期 1 月到去年同期 P），
//   那是另一套窗口推导，会让一张表同时出现"本期 / 基期 / 本年累计 / 上年同期累计"
//   四列 —— 而其中两列的口径不同（一列是区间、另一列也是区间但起止都在去年）。
//   先把它做成独立的一列（`range=ytd`，见 `computeReport`），比较留给后续单独论证。
export const COMPARE_MODES = {
  previous: { label: '上期（环比）', delta: -1 },
  yoy: { label: '去年同期（同比）', delta: -12 },
  // ---------------------------------------------------------------------------
  // 「本年累计的比较」（批次 U 之四 / ③-b）
  // ---------------------------------------------------------------------------
  // 两列**都是累计窗口**：
  //   本期列 = [本年会计年度年初, 本期]
  //   基期列 = [上年会计年度年初, 上年同月]
  //
  // ⚠️ 基期**不能**取 `[上年同月, 本期]`。这一段必须写下来，否则下一个人一定会
  //    "顺手"这么实现 —— 因为它看起来更"自然"（都是"从去年到今年"）：
  //      · `[上年年初, 上年同月]` 与本期列**长度相同、相位相同**，两者相减得到的是
  //        "同口径同期之间的变化"（累计同比），这正是"今年到 10 月比去年到 10 月多做了多少"；
  //      · `[上年同月, 本期]` 跨两个年度、含一个完整的上年，是一个**另一个量**：
  //        它把"去年的全年"塞进了分母，于是"累计增长 8%"这种结论会凭空大出一个量级，
  //        而两列都长得像真的、没有任何东西会报错。
  // 实现上：基期窗口整体**下移 12 个月**（`delta: -12` 两次应用：一次给期间，一次给窗口），
  // 所以 `range: 'ytd'` 只需在基期那一侧也生效即可，不需要第二套窗口推导。
  yoy_ytd: { label: '上年同期累计（累计同比）', delta: -12, range: 'ytd' },
  // 自定义基期：**不可由期间推导**，必须显式给 `base_period`。
  // 它的价值在于"3 月改了一次促销，我想拿 10 月和 2 月比"这类问题 ——
  // 而 `previous` / `yoy` 永远只能比"相邻"与"去年同月"。
  custom: { label: '自定义基期', delta: null, requires_base: true }
}

/** 这个比较模式是不是"两列都是累计"的（目前只有 `yoy_ytd`） */
export function isRangeCompareMode(mode) {
  return Boolean(COMPARE_MODES[String(mode ?? '').trim()]?.range)
}

/**
 * 比较模式解析 + 基期推导。**基期只由这里算**（两处各写一次 `-1`/`-12` 迟早就对不上）。
 *
 * 自定义基期必须显式给，且**必须早于本期**：
 * 拿"未来的期间"当基期，差额的符号与"增长"的直觉正好相反
 * （本期 < 基期会算成正增长），而表面上看不出任何异常 ——
 * 一个看起来合理的负增长比一个报错危险得多。
 */
export function resolveCompareMode(db, { period, mode = 'previous', basePeriod = null }) {
  const p = assertPeriod(period)
  const key = String(mode ?? '').trim()
  if (!key) return { mode: null, mode_label: null, base_period: null }
  const spec = COMPARE_MODES[key]
  if (!spec) {
    throw new ReportError(
      'BAD_COMPARE_MODE',
      `比较模式「${mode}」不支持（应为 ${Object.keys(COMPARE_MODES).join(' / ')}）`,
      400,
      { mode }
    )
  }
  if (!spec.requires_base) {
    const bp = shiftPeriod(p, spec.delta)
    // "两列都是累计"的模式：基期那一侧也走同一个区间模式（`range: 'ytd'`），
    // 窗口整体下移 12 个月是 `shiftPeriod` 的自然结果，不需要第二套推导。
    // 基期窗口在这里算出来，是为了让**标签自己说清窗口**（"上年同期累计（2025-01 ~ 2025-10）"）——
    // 只写"上年同期累计"的话，读的人还得自己推一遍它是从哪个月起算的。
    if (spec.range) {
      const rg = resolveRange(db, { period: bp, range: spec.range })
      return {
        mode: key,
        mode_label: `${spec.label}（${rg.from} ~ ${bp}）`,
        base_period: bp,
        range: spec.range,
        // `is_range: true` 是**必须**带上的：导出与前端都按这个字段决定"要不要把窗口写进文件/界面"，
        // 漏了它的后果是"比较对了，但文件里少了'基期窗口是 2025-01 ~ 2025-10'那一行"——
        // 而那一行恰恰是读文件的人判断"这列到底比的是什么"的唯一依据。
        base_range: { mode: rg.mode, mode_label: rg.mode_label, from: rg.from, to: bp, is_range: true, year: rg.year }
      }
    }
    return { mode: key, mode_label: spec.label, base_period: bp, range: null, base_range: null }
  }

  const raw = String(basePeriod ?? '').trim()
  if (!raw) {
    throw new ReportError('COMPARE_BASE_REQUIRED', `比较模式「${spec.label}」必须同时给出基期期间（base_period=YYYY-MM）`, 400, { mode: key })
  }
  const b = assertPeriod(raw)
  if (b >= p) {
    throw new ReportError(
      'COMPARE_BASE_AFTER_CURRENT',
      `自定义基期 ${b} 不早于本期 ${p}：拿"未来的期间"当基期，差额的符号会与"增长"的直觉正好相反，而表面上看不出异常`,
      400,
      { period: p, base_period: b }
    )
  }
  return { mode: key, mode_label: `${spec.label}（${b}）`, base_period: b, range: null, base_range: null }
}

/** 期间元信息（比较的两栏各要一份：已关账的是定稿数，未关账的还会变） */
function periodMeta(db, period) {
  const row = getPeriod(db, period)
  const posted = db.prepare("SELECT COUNT(*) c FROM vouchers WHERE status='posted' AND period=?").get(period).c
  return {
    period,
    status: row?.status ?? 'open',
    status_label: PERIOD_STATUS_LABEL[row?.status ?? 'open'],
    carried: !!row?.closing_voucher_id,
    posted_vouchers: Number(posted)
  }
}

/**
 * 跨期比较。两列都来自 `computeReport`（**同一个实现**），差额只由两列相减。
 *
 * 基期"没数据"是**常见事实**（上月确实没开张），不是错误 —— 所以要如实标注
 * `base_meta.comparable`，而不是拒绝比较，也不是假装差额就是增长。
 * 一个"基期 0 → 本期 8 万"的差额，看起来像暴涨，实际是"基期没有业务"，
 * 界面必须能说出这个区别。
 */
export function compareReport(db, { reportCode, period, mode = 'previous', basePeriod = null, range = null }) {
  const p = assertPeriod(period)
  // 累计与比较**默认不叠加**（见 `COMPARE_MODES` 上方的说明）。显式拦掉而不是静默忽略：
  // 静默忽略的后果是"用户以为看到的是累计对比，实际是单期对比"，而两列都像真的。
  //
  // 唯一的例外是 `yoy_ytd` —— 那个模式**本身就是"两列都是累计"**，
  // 所以它的 `range` 不是"额外要求"，而是它的定义的一部分（写死在 `COMPARE_MODES` 里）。
  // 于是这里只放行"模式自带累计"的那一种，别的一律照旧拒绝。
  if (range && !isRangeCompareMode(mode)) {
    throw new ReportError(
      'RANGE_COMPARE_UNSUPPORTED',
      `不支持把"本年累计"（range=${range}）叠加在比较模式「${mode}」上：只有「上年同期累计」那个模式`
        + '（mode=yoy_ytd）的两列天生都是累计；环比/同比与累计叠加没有意义（一个区间和一个点比大小）。',
      400,
      { report_code: reportCode, period: p, range, mode }
    )
  }
  if (range && isRangeCompareMode(mode) && range !== COMPARE_MODES[String(mode).trim()].range) {
    // 模式自带累计，还额外传一个**别的**区间值 —— 说明调用方对窗口的理解与我们对不上，
    // 报错而不是"忽略它按模式自己的来"（那会让两边都以为自己是对的）。
    throw new ReportError('BAD_RANGE_MODE', `比较模式「${mode}」自带区间「${COMPARE_MODES[String(mode).trim()].range}」，不接受 range=${range}`, 400, { mode, range })
  }
  const {
    mode: m,
    mode_label: mLabel,
    base_period: basePeriodResolved,
    range: modeRange,
    base_range: modeBaseRange
  } = resolveCompareMode(db, { period: p, mode, basePeriod })
  if (!m) throw new ReportError('COMPARE_MODE_REQUIRED', '跨期比较必须指定比较模式（previous / yoy / yoy_ytd / custom）', 400)

  // 模式自带累计 + 时点口径 = 没有意义（累计要求"把若干期加总"，而资产负债表回答"截至某一刻的家底"）。
  // **显式拦在这里**而不是让它漏到 `computeReport` 的 `RANGE_NOT_APPLICABLE`：
  // 那条消息说的是"报表不能加累计列"，而用户点的是"上年同期累计对比" —— 两句话指的不是同一个问题。
  if (modeRange && getReportDef(db, reportCode).basis === 'balance') {
    throw new ReportError(
      'COMPARE_YTD_BASIS_NOT_APPLICABLE',
      `报表「${getReportDef(db, reportCode).name}」是**时点**口径，「${mLabel}」要求两列都是"把若干期加总"的累计窗口 —— 家底没有"累计"这回事。`,
      409,
      { report_code: reportCode, mode: m, basis: 'balance' }
    )
  }

  // 两列走同一个区间模式（`modeRange` 为空时就是单期）——**同一个 `computeReport`**，
  // 于是"基期列 = 单独打开基期"这条唯一实现的成立范围自动扩到"单独打开基期的累计"。
  const current = computeReport(db, { reportCode, period: p, range: modeRange })
  const base = computeReport(db, { reportCode, period: basePeriodResolved, range: modeRange })
  // 被比较的那一列取哪个字段：单期模式取 `amount`；"两列都是累计"的模式取 `ytd_amount`。
  // **取号只在这一处**：`diff` 永远是"两列相减"，于是 `auditComparison` 那条
  // 「差额 = 两列相减」的断言对两种口径都仍然成立（不必为累计再写一套）。
  const cmpOf = (r) => money2((modeRange ? r.ytd_amount : r.amount) ?? 0)

  const baseByCode = new Map(base.rows.map((r) => [r.line_code, r]))
  const numOr = (v) => money2(v ?? 0)
  const ratioOf = (cur, b) =>
    // 分母取**绝对值**：基期为负（例如上期亏损 100）时，"亏 100 → 亏 50"是改善，
    // 变动率应为 +50%。直接用带符号的基期做分母会得到一个负号，
    // 而那会让人把"好转"读成"恶化" —— 三处符号相乘，谁都算不对。
    Math.abs(b) > 0.005 ? Number(((money2(cur - b) / Math.abs(b)) * 100).toFixed(2)) : null

  const rows = current.rows.map((r) => {
    const b = baseByCode.get(r.line_code)
    // 行缺失就抛：静默补 0 会让"比较列少一行"表现成"这一项上期是 0"，
    // 一个假的 0 比一个报错危险得多（它会变成一条看起来合理的增长）。
    if (!b) {
      throw new ReportError(
        'COMPARE_LINE_MISSING',
        `报表「${current.report_name}」的基期（${basePeriodResolved}）缺少第 ${r.line_no} 行「${r.line_name}」（line_code=${r.line_code}）`,
        500,
        { report_code: reportCode, line_code: r.line_code, base_period: basePeriod }
      )
    }
    const amount = cmpOf(r)
    const baseAmount = cmpOf(b)
    return {
      ...r,
      amount,
      base_amount: baseAmount,
      // 差额**就是两列相减**。不再算一遍，也不做"四舍五入后再相减"这类聪明事。
      diff: money2(amount - baseAmount),
      ratio: ratioOf(amount, baseAmount)
    }
  })

  const totalsOf = (rep) => Object.fromEntries(rep.rows.map((r) => [r.line_code, cmpOf(r)]))
  const totalsCurrent = totalsOf(current)
  const totalsBase = totalsOf(base)
  const totalsDelta = Object.fromEntries(
    Object.keys(totalsCurrent).map((k) => {
      const cur = totalsCurrent[k]
      const b = totalsBase[k] ?? 0
      return [k, { current: cur, base: money2(b), diff: money2(cur - b), ratio: ratioOf(cur, b) }]
    })
  )

  const baseMeta = periodMeta(db, basePeriodResolved)
  const hasOpening = !!db
    .prepare('SELECT 1 x FROM accounting_opening_balances WHERE period <= ? LIMIT 1')
    .get(basePeriodResolved)
  // 基期"有没有数据"的唯一判据 —— 不依赖取数口径。
  // 资产负债表在"基期无凭证但更早登记过期初"时仍有非 0 的期末余额（滚动而来），
  // 所以两个来源都要看，漏一个就会把"有数"说成"不可比"。
  const comparable = baseMeta.posted_vouchers > 0 || hasOpening

  return {
    report_code: reportCode,
    report_name: current.report_name,
    basis: current.basis,
    basis_label: current.basis_label,
    period: p,
    mode: m,
    mode_label: mLabel,
    // 被比较的两列是什么口径：`period`（单期对单期）或 `ytd`（累计对累计，见 `COMPARE_MODES.yoy_ytd`）。
    // 明写出来，读结果的人/程序才不必从 `mode` 反推"我到底在看单期还是累计"。
    compare_basis: modeRange ? 'ytd' : 'period',
    compare_basis_label: modeRange ? '累计对累计' : '单期对单期',
    // **基期以"实际算了哪一期"为准**（`base.period`），不是以"模式推导出哪一期"为准。
    // 这两者本该永远一致，但一旦不一致，用推导值填这个字段就等于**让结果自称一个它没算的期间** ——
    // 两列看着都像真的，没人知道它们究竟是哪期的。用实际值填，
    // 不一致就由 `auditComparison` 的 `COMPARE_BASE_PERIOD_BAD` 当场报出来。
    // （本批反例 B 实测：改坏基期后，旧写法**一声不吭** —— 因为 2026-09 与 2026-08 的余额恰好相同。）
    base_period: base.period,
    rows,
    lines: current.lines,
    // 本期（与 `computeReport` 同形，含科目行）
    totals: totalsCurrent,
    totals_only: current.totals_only,
    // 基期（同一个形状，便于界面把两列并排放）
    totals_base: totalsBase,
    // 逐行的 {本期, 基期, 差额, 变动率}
    totals_delta: totalsDelta,
    base_meta: { ...baseMeta, comparable, has_opening: hasOpening },
    period_meta: periodMeta(db, p),
    // 本期的现金流/余额对象照原样透传 —— 比较**不重算**它们
    cash: current.cash,
    balances: current.balances,
    // 累计对累计时的两个窗口（单期模式是 null）。**两列各自覆盖哪几个月必须写下来**，
    // 否则"上年同期累计"这四个字没人知道是从哪个月起算的。
    range_meta: modeRange ? { mode: modeRange, mode_label: RANGE_MODES[modeRange].label, from: current.range_meta.from, to: p, is_range: true } : null,
    base_range_meta: modeBaseRange || null,
    // 列的唯一出处（批次 P）：CSV 与前端都按它渲染
    columns: columnsOf({
      withCompare: true,
      period: p,
      basePeriod: base.period,
      compareYtd: modeBaseRange ? { from: current.range_meta.from, to: p, baseFrom: modeBaseRange.from, baseTo: basePeriodResolved } : null
    })
  }
}

// ---------------------------------------------------------------------------
// 六之二之二、同期多年对比（批次 U 之四 / ④）：跨年度报表
// ---------------------------------------------------------------------------
// 「同期多年对比」= 同一张表并排 N 列，每列是**同一月份在往前第 k 个年度**的数：
//   k = 0 本期 / k = 1 去年同月 / k = 2 前年同月 …… N 限制 2~5。
//
// 为什么是"同期"而不是"任意跨年窗口"（如"上年 12 月 ~ 本年 3 月"）：
//   任意窗口需要一个新的**区间入参**（不是一个比较列），它会把 `computeReport` 的
//   窗口语义再扩一层（现在窗口只由 `resolveRange` 从期间推）。那是另一个量级的改动，
//   本批**明确不做**（见文件末的"没做"清单）—— 宁可不做，也不做一个半截窗口。
//
// 为什么列是"单期"而不是"累计"：多年对比问的是"这个月（这一期）与前几年同期比怎么样"。
//   累计口径的跨年对比是另一件事（③-b 的 `yoy_ytd` 只做相邻两年）。
export const MULTI_YEAR_MIN = 2
export const MULTI_YEAR_MAX = 5

/** 同期多年对比的期间序列：本期、去年同月、前年同月……（**只由 shiftPeriod 推**） */
export function multiYearPeriods(period, years) {
  const p = assertPeriod(period)
  const n = Number(years)
  if (!Number.isInteger(n) || n < MULTI_YEAR_MIN || n > MULTI_YEAR_MAX) {
    throw new ReportError(
      'MULTI_YEAR_COUNT',
      `同期多年对比的年数必须是 ${MULTI_YEAR_MIN}~${MULTI_YEAR_MAX} 之间的整数，收到「${years}」`,
      400,
      { years }
    )
  }
  const out = []
  for (let k = 0; k < n; k += 1) out.push({ k, period: shiftPeriod(p, -12 * k) })
  return out
}

export const MULTI_YEAR_LAG_KEY = (k) => (k === 0 ? 'amount' : `amount_lag${k}`)

/**
 * 同期多年对比。每一列都是**对那一期单独调 `computeReport`** 的结果 ——
 * 与比较列同一条纪律：不另写取数路径，于是"文件里那一列 = 单独打开那一期"是构造性成立的。
 */
export function multiYearReport(db, { reportCode, period, years = 3 }) {
  const p = assertPeriod(period)
  const cols = multiYearPeriods(p, years)
  const reports = cols.map((c) => ({ ...c, rep: computeReport(db, { reportCode, period: c.period }) }))
  const head = reports[0].rep
  const byCode = new Map()
  for (const c of reports) byCode.set(c.period, new Map(c.rep.rows.map((r) => [r.line_code, money2(r.amount)])))

  const rows = head.rows.map((r) => {
    const out = { ...r, amount: money2(r.amount) }
    for (const c of cols) {
      const v = byCode.get(c.period).get(r.line_code)
      // 行缺失就抛：静默补 0 会让"某一列少一行"表现成"那一年这一项是 0"，
      // 而一个假的 0 在同比里看起来像"那年没做这块业务"（与比较列同一条理由）。
      if (v === undefined) {
        throw new ReportError(
          'MULTI_YEAR_LINE_MISSING',
          `报表「${head.report_name}」的 ${c.period} 缺少第 ${r.line_no} 行「${r.line_name}」（line_code=${r.line_code}）`,
          500,
          { report_code: reportCode, line_code: r.line_code, period: c.period }
        )
      }
      out[MULTI_YEAR_LAG_KEY(c.k)] = v
    }
    return out
  })

  return {
    report_code: reportCode,
    report_name: head.report_name,
    basis: head.basis,
    basis_label: head.basis_label,
    period: p,
    years: cols.length,
    periods: cols.map((c) => c.period),
    rows,
    lines: head.lines,
    // 逐期合计（按 line_code），供自证与界面小计
    totals_by_period: Object.fromEntries(reports.map((c) => [c.period, Object.fromEntries(c.rep.rows.map((r) => [r.line_code, money2(r.amount)]))])),
    period_meta: reports.map((c) => periodMeta(db, c.period)),
    // 列的唯一出处（批次 P）：CSV / XLSX / 前端都按它渲染
    columns: [
      { key: 'line_no', label: '行次', kind: 'text' },
      { key: 'line_name', label: '项目', kind: 'text' },
      ...reports.map((c) => ({
        key: MULTI_YEAR_LAG_KEY(c.k),
        label: c.k === 0 ? `本期金额(${c.period})` : `金额(${c.period})`,
        kind: 'money'
      }))
    ]
  }
}

/**
 * 同期多年对比的自证（与 `auditComparison` 同构）。
 *
 * 三条：
 *   · 每一列必须等于"单独打开那一期"（守唯一实现）；
 *   · 期间序列必须是本期往前 12 个月的整数倍（**字面算出**，不调 `multiYearPeriods`）；
 *   · 列数与 `years` 一致（少一列会让"前年"那一列悄悄消失，而表看起来仍然完整）。
 */
export function auditMultiYear(db, { reportCode, period, years = 3, result = null }) {
  const p = assertPeriod(period)
  const problems = []
  const push = (code, message, detail = null) => problems.push({ code, message, detail })

  let got = result
  try {
    if (!got) got = multiYearReport(db, { reportCode, period: p, years })
  } catch (e) {
    push('MULTI_YEAR_ERROR', `同期多年对比算不出来：${e.message}`, { report_code: reportCode, period: p, years, code: e.code || null })
    return { ok: false, problems, report_code: reportCode, period: p, years, rows_checked: 0 }
  }

  // 期望期间**字面**算出：第 k 列 = 本期往前 12k 个月。（`shiftPeriod` 是期间工具，
  // 不是被测对象；被测的是 `multiYearReport` 怎么把列拼起来。）
  const n = Number(years)
  const expectPeriods = []
  for (let k = 0; k < n; k += 1) expectPeriods.push(shiftPeriod(p, -12 * k))
  if (JSON.stringify(got.periods) !== JSON.stringify(expectPeriods)) {
    push('MULTI_YEAR_PERIODS_BAD', `列期间是 ${(got.periods || []).join(' / ')}，应当是 ${expectPeriods.join(' / ')}`, { period: p, got: got.periods, expect: expectPeriods })
  }

  const bad = []
  for (const per of expectPeriods) {
    const solo = computeReport(db, { reportCode, period: per })
    const soloByCode = new Map(solo.rows.map((r) => [r.line_code, money2(r.amount)]))
    const key = MULTI_YEAR_LAG_KEY(expectPeriods.indexOf(per))
    for (const r of got.rows || []) {
      const want = soloByCode.get(r.line_code)
      if (want === undefined || Math.abs(money2(r[key]) - want) > 0.005) {
        bad.push(`${per} ${r.line_name}：列 ${r[key]} ≠ 单独打开 ${want}`)
      }
    }
  }
  if (bad.length) {
    push('MULTI_YEAR_COLUMN_MISMATCH', `有 ${bad.length} 处"列 ≠ 单独打开那一期"：${bad.slice(0, 2).join('；')}`, { report_code: reportCode, period: p, rows: bad.slice(0, 10) })
  }

  return {
    ok: problems.length === 0,
    problems,
    report_code: reportCode,
    period: p,
    years: n,
    periods: expectPeriods,
    rows_checked: (got.rows || []).length
  }
}

// ---------------------------------------------------------------------------
// 六之三、报表导出（批次 N）：**导出即视图**
// ---------------------------------------------------------------------------
// 导出最容易出的一类错，是"导出另写一条取数路径"：页面是 A、文件是 B，
// 用户拿着文件去开会，会上没有人能发现它和屏幕上的不是一套数。
// 所以导出的内容**就是** `computeReport` / `compareReport` 的结果，逐行照抄。
//
// 为什么是 CSV 而不是 Excel/PDF：CSV 是唯一"不需要在服务端引入第三方库"的格式，
// 而本项目对依赖的态度是能不加就不加（Excel 的格式细节会随版本变化，
// PDF 还会把"排版"变成一个新的、需要维护的正确性问题）。
// 导出的**预期用途**是"拿去再加工"，那正是 CSV 的用途。
export const CSV_BOM = '\uFEFF' // Excel 打开 UTF-8 CSV 靠它认出编码，否则中文全乱

/** CSV 单元格转义。含分隔符 / 引号 / 换行时必须加引号，引号本身加倍。 */
export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** 金额列：服务端已 `round2`，这里只负责"null 不能写成 NaN" */
const numCell = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toFixed(2))

// ---------------------------------------------------------------------------
// 六之三之二、列定义：**列的唯一出处**（批次 P）
// ---------------------------------------------------------------------------
// 批次 N 把"导出即视图"落成了"导出的**行** = 报表的行"，但**列**还是两处定义：
// CSV 的表头写在 `buildReportCSV` 里，页面的表头写在 `Reports.tsx` 里。
// 两处定义 = 迟早只改一处，而"文件里的列名和屏幕上的不一样"这种事没有人会去核对
// （它完全不像一个错误）。所以本批把列收敛到服务端一处：
// `columnsOf` 给出 `{key,label,kind}`，结果对象带 `columns`，
// CSV 按它生成、前端按它渲染 —— 要加一列只改这一个函数。
export function columnsOf({
  withCompare = false,
  withRange = false,
  period = null,
  basePeriod = null,
  rangeFrom = null,
  rangeTo = null,
  // 「比较的两列**都是累计**」时的四个窗口端点（`mode=yoy_ytd`，批次 U 之四 / ③-b）。
  // 传了它，前两列的名字必须换成累计 —— 否则一列是累计、标题却写着"本期金额(2026-10)"，
  // 而**列名是唯一能让读文件的人知道那一列是什么的东西**。
  compareYtd = null
} = {}) {
  const ytd = compareYtd && compareYtd.from && compareYtd.to && compareYtd.baseFrom && compareYtd.baseTo ? compareYtd : null
  const cols = [
    { key: 'line_no', label: '行次', kind: 'text' },
    { key: 'line_name', label: '项目', kind: 'text' },
    {
      key: 'amount',
      label: ytd ? `本期累计(${ytd.from}~${ytd.to})` : `本期金额(${period})`,
      kind: 'money'
    }
  ]
  if (withRange) cols.push({ key: 'ytd_amount', label: `本年累计(${rangeFrom}~${rangeTo})`, kind: 'money' })
  if (withCompare) {
    cols.push({
      key: 'base_amount',
      label: ytd ? `上年同期累计(${ytd.baseFrom}~${ytd.baseTo})` : `基期金额(${basePeriod})`,
      kind: 'money'
    })
    cols.push({ key: 'diff', label: ytd ? '累计差额' : '差额', kind: 'money' })
    cols.push({ key: 'ratio', label: ytd ? '累计变动率%' : '变动率%', kind: 'percent' })
  }
  return cols
}

/**
 * 一个单元格的取值：**按列的 `kind` 决定格式**，不按调用处决定。
 * 这是"格式"这件事的唯一实现 —— 前端渲染与 CSV 生成都走它，
 * 于是"文件里的 1,234.50 与屏幕上的 1234.5"这类不一致不可能发生。
 */
export function columnValue(row, col) {
  const v = row?.[col.key]
  if (col.kind === 'text') return v === null || v === undefined ? '' : String(v)
  if (col.kind === 'percent') return v === null || v === undefined ? '' : Number(v).toFixed(2)
  return numCell(v)
}

/**
 * 把一张报表（可含"本年累计"列 / 比较列）编成 CSV 文本。
 *
 * 纯函数，**不碰数据库**：这样"导出内容 = 视图内容"这件事可以脱离 HTTP 与文件
 * 单独断言（批次 N 的测试就是这么做的）。
 *
 * 列**不在这里定义** —— 它迭代 `result.columns`（唯一出处）。这条改动本身就是
 * "同一份判据不允许有两个实现"的又一次落地：此前 CSV 的列名是硬编码在这里的。
 */
export function buildReportCSV(result, { generatedAt = null } = {}) {
  const cols = result.columns && result.columns.length ? result.columns : columnsOf({ period: result.period })
  const out = [cols.map((c) => csvCell(c.label)).join(',')]
  for (const r of result.rows) out.push(cols.map((c) => csvCell(columnValue(r, c))).join(','))
  // 时间戳写在**末尾注释行**而不是首行：首行是表头，任何"首行是元信息"的做法
  // 都会让"直接用工具读这个 CSV"的人拿到一行废数据。
  out.push('')
  // 末尾那几行元信息的**文本**抽到 `reportFooterLines`：CSV 与 XLSX 共用同一份，
  // 于是"两种格式的文件里说的事不一样"不可能发生（列名已经统一过一次，这次是元信息）。
  for (const line of reportFooterLines(result, { generatedAt })) out.push(csvCell(`# ${line}`))
  return CSV_BOM + out.join('\r\n') + '\r\n'
}

/**
 * 导出文件末尾的元信息（期间 / 累计窗口 / 比较基期 / 生成时间）。
 *
 * **只出文本、不带 `#`** —— `#` 是 CSV 的注释约定，Excel 单元格里它什么都不是
 * （写在单元格里只会让人以为数据坏了）。所以 `#` 由 CSV 那一侧自己加。
 */
export function reportFooterLines(result, { generatedAt = null } = {}) {
  const at = generatedAt || localNow()
  const lines = [`${result.report_name} · ${result.basis_label} · 期间 ${result.period}`]
  // 「累计列」这件事有两种表达：独立加一列（computeReport range）与"比较的两列都是累计"
  // （`mode=yoy_ytd`）。两种都要说清窗口，否则读文件的人不知道那列覆盖了哪几个月。
  const win = result.range_meta?.is_range
    ? `${result.range_meta.mode_label}：${result.range_meta.from} ~ ${result.range_meta.to}（含两端）`
    : null
  if (win) lines.push(win)
  // 判据用"两个端点是否都有"，不用 `is_range`：`base_range_meta` 是"累计对累计"比较里
  // 基期那一侧的窗口，它天然是一个区间 —— 而它的来源（`resolveCompareMode`）有自己的字段集，
  // 靠一个可选的布尔标记来决定"要不要写这一行"太脆（实测就漏过一次）。
  if (result.base_range_meta?.from && result.base_range_meta?.to) {
    lines.push(`基期窗口：${result.base_range_meta.from} ~ ${result.base_range_meta.to}（含两端）`)
  }
  if (result.mode) lines.push(`${result.mode_label} 对比 ${result.base_period}`)
  if (Array.isArray(result.periods) && result.periods.length > 1) {
    lines.push(`同期多年并列：${result.periods.join(' / ')}`)
  }
  lines.push(`生成于 ${at}`)
  return lines
}

// ---------------------------------------------------------------------------
// 六之三之二、导出格式：CSV（默认）与 XLSX
// ---------------------------------------------------------------------------
// **默认必须是 csv**：这个端点在此之前只有一种格式，加格式不能改变既有调用的一个字节
// （前端、脚本、别人的 curl 都还带着老 URL）。所以 `format` 缺省 = csv，
// 且 CSV 那条分支的代码、文件名、mime 与响应头一字未动。
export const EXPORT_FORMATS = {
  csv: { label: 'CSV（逗号分隔）', ext: 'csv', mime: 'text/csv; charset=utf-8' },
  xlsx: {
    label: 'Excel 工作簿',
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }
}

export const XLSX_SHEET_NAME_MAX = 31

/**
 * 工作表名的**尽力修复**（只做一次，不再自己判"合不合法"）。
 *
 * 为什么不是"先自己判一遍合法性"：那会把 xlsx 模块的校验规则抄成第二份定义 ——
 * 两份规则迟早分叉，而分叉的表现是"我这边认为合法、写出去的文件 Excel 说要修复"。
 * 所以这里**只做一次粗修**（换掉 Excel 明令禁止的字符、截到 31 个码点），
 * 修完再交给模块判一次：它仍然拒绝，才报错。
 */
function relaxSheetName(name) {
  const s = String(name ?? '')
    .replace(/[\[\]:*?/\\]/g, '_')
    .replace(/[\u0000-\u001F]/g, '')
    .replace(/^'+|'+$/g, '')
  const cut = [...s].slice(0, XLSX_SHEET_NAME_MAX).join('')
  return cut || '报表'
}

/**
 * 把一张报表编成 xlsx 字节流。
 *
 * 与 `buildReportCSV` 完全同构：**行 = 报表的行、列 = `result.columns`**（同一份列定义）。
 * 表头**由这里作为 `rows[0]` 传进去** —— `buildXlsx` 明确不写 `columns[].label`，
 * 它只做"矩阵 → XML"（见该模块的约定，理由是没有第二行表头）。
 *
 * 末尾那几行元信息在 xlsx 里**作为最后几行文本追加**：Excel 没有注释概念，
 * 而"这份文件是哪一期、哪个窗口"是信息不是噪声 —— 丢掉它，文件离开系统之后就说不清自己是谁。
 * 取舍写在注释里：CSV 用 `#` 注释（工具可跳过），xlsx 用最后几行单元格（人看得见）。
 */
/**
 * 一个单元格在 xlsx 里的**表示**：金额与百分比落成**数值**（可被 Excel 求和），
 * 其余落成文本 —— 但**值的来源仍然是 `columnValue`**（唯一的"取值 + 取几位小数"出处）。
 *
 * 为什么不直接照抄 CSV 的字符串：Excel 里 "0.00" 是**文本**，标题栏不参与求和、
 * 还会挂一个"以文本形式存储的数字"的绿三角。一个拿去再加工的 Excel 文件里，
 * 金额不能求和等于没导出。
 * 为什么这不违反"列定义只有一个出处"：异的是**表示**（这是两种格式固有的差别，
 * 正如 CSV 要用逗号、xlsx 要用 XML），不是"哪一列、叫什么名、取几位小数" ——
 * 后三件事仍然只有 `columnsOf` / `columnValue` 一处定义。
 * 取整口径仍是 `numCell` 的 `toFixed(2)`：先按它格式化再转数字，
 * 于是两种格式里的**值**永远相同（测试里逐格核对过）。
 */
function xlsxCellValue(row, col) {
  const text = columnValue(row, col)
  if (text === '') return null // "没有值"在 xlsx 里是空单元格（不是 0，也不是空字符串）
  if (col.kind === 'money' || col.kind === 'percent') return Number(text)
  return text
}

export function buildReportXlsx(result, { generatedAt = null, sheetName = null } = {}) {
  const cols = result.columns && result.columns.length ? result.columns : columnsOf({ period: result.period })
  const rows = [cols.map((c) => c.label)]
  for (const r of result.rows) rows.push(cols.map((c) => xlsxCellValue(r, c)))
  rows.push([]) // 空行分隔：不然元信息会被当成数据行（导出的表本来就是拿去再加工的）
  for (const line of reportFooterLines(result, { generatedAt })) rows.push([line])

  const want = sheetName || result.report_name
  try {
    return { buffer: buildXlsx({ sheets: [{ name: want, columns: cols.map((c) => ({ label: c.label })), rows }] }), sheet_name: want, sheet_name_fallback: false }
  } catch (e) {
    if (!(e instanceof XlsxError) || e.code !== XLSX_CODES.BAD_SHEET_NAME) throw e
    // 报表名是**人可以在界面上改的**（`finance.report.config`）。改成一个带 `/` 或超长的名字
    // 是合法操作，它不该让"导出"整个失败 —— 所以降级成安全名，并且**如实标出来**
    // （`sheet_name_fallback` 会进响应头），不静默。
    const safe = relaxSheetName(want)
    try {
      return { buffer: buildXlsx({ sheets: [{ name: safe, columns: cols.map((c) => ({ label: c.label })), rows }] }), sheet_name: safe, sheet_name_fallback: true }
    } catch (e2) {
      throw new ReportError(
        'EXPORT_SHEET_NAME_BAD',
        `工作表名「${want}」不合法，降级成「${safe}」之后仍被拒绝：${e2.message}`,
        400,
        { sheet_name: want, relaxed: safe }
      )
    }
  }
}

/**
 * 导出门面：算出内容、给出双份文件名（ASCII 一份给老浏览器，UTF-8 一份给现代浏览器）。
 * `filename_utf8` 由路由编进 `Content-Disposition` 的 `filename*`。
 *
 * `format` 缺省 `csv`（**既有行为逐字节不变**）；`xlsx` 走同一份 `result`、同一份列定义。
 */
export function exportReport(db, { reportCode, period, mode = null, range = null, basePeriod = null, years = null, format = 'csv', generatedAt = null }) {
  const p = assertPeriod(period)
  const fmt = String(format ?? '').trim().toLowerCase() || 'csv'
  const spec = EXPORT_FORMATS[fmt]
  if (!spec) {
    throw new ReportError(
      'BAD_EXPORT_FORMAT',
      `导出格式「${format}」不支持（应为 ${Object.keys(EXPORT_FORMATS).join(' / ')}）`,
      400,
      { format }
    )
  }
  // 三种形态互斥（单期/累计、比较、同期多年）—— 显式拦掉组合，而不是"按某个优先级静默选一个"：
  // 静默选一个的后果是用户拿到一份**不是他要的那张表**的文件，而它看起来完全正常。
  const withMulti = years !== null && years !== undefined && Number(years) > 1
  if (withMulti && (mode || range)) {
    throw new ReportError('BAD_EXPORT_OPTIONS', '同期多年对比（years）不能与 mode / range 同时使用 —— 它们是三种不同的表', 400, { mode, range, years })
  }
  const withCompare = Boolean(mode)
  const result = withMulti
    ? multiYearReport(db, { reportCode, period: p, years })
    : withCompare
      ? compareReport(db, { reportCode, period: p, mode, basePeriod, range })
      : computeReport(db, { reportCode, period: p, range })
  const suffix = withMulti
    ? `_multi${result.years}`
    : withCompare
      ? `_vs_${result.base_period}_${result.mode}`
      : (result.range_meta?.is_range ? `_${result.range_meta.mode}` : '')
  const xlsx = fmt === 'xlsx' ? buildReportXlsx(result, { generatedAt }) : null
  return {
    report_code: reportCode,
    report_name: result.report_name,
    period: p,
    mode: withCompare ? result.mode : null,
    base_period: withCompare ? result.base_period : null,
    range: result.range_meta?.is_range ? result.range_meta.mode : null,
    range_from: result.range_meta?.from ?? null,
    range_to: result.range_meta?.to ?? null,
    // 同期多年：说清这份文件里并排了哪几期（否则"这是哪几年"只能靠猜文件名）
    years: withMulti ? result.years : null,
    periods: withMulti ? result.periods : null,
    with_compare: withCompare,
    with_multi_year: withMulti,
    format: fmt,
    format_label: spec.label,
    columns: result.columns,
    row_count: result.rows.length,
    mime: spec.mime,
    sheet_name: xlsx?.sheet_name ?? null,
    sheet_name_fallback: xlsx?.sheet_name_fallback ?? false,
    // ASCII 名（老浏览器兜底）：中文名进 HTTP 头会因编码问题变成乱码文件名
    filename: `${reportCode}_${p}${suffix}.${spec.ext}`,
    // 现代浏览器用这个（RFC 5987），用户看到的才是中文名
    filename_utf8: `${result.report_name}_${p}${suffix ? `_${suffix.replace(/^_/, '')}` : ''}.${spec.ext}`,
    content: xlsx ? xlsx.buffer : buildReportCSV(result, { generatedAt })
  }
}

// ---------------------------------------------------------------------------
// 七、经营分析（与账交叉核对，差异如实展示）
// ---------------------------------------------------------------------------
/**
 * 经营分析：**账上的**与**业务上的**并列给出，并给出差额。
 *
 * 为什么不做成"算完就完"的 KPI：本系统里**不是每条业务流都生成了凭证**
 * （生成是显式动作，且演示数据刻意留了一张 draft）。所以"应收科目余额"与
 * "业务应收未收余额"本来就可能不相等。把它们并列摆出来 + 说明差异，
 * 比强行让它们相等（或只显示一个）诚实得多 ——
 * 报表最容易骗人的方式不是算错，而是**只显示一个来源**。
 */
export function operatingSummary(db, { period }) {
  const p = assertPeriod(period)
  const balances = subjectBalances(db, { period: p })
  const num = (sql, ...args) => Number(db.prepare(sql).get(...args)?.v || 0)
  const balOf = (codes) =>
    money2(balances.rows.filter((r) => codes.includes(r.code)).reduce((s, r) => s + r.closing_signed, 0))

  // 账上（凭证口径）
  const revenue = money2(
    -1 * balances.rows.filter((r) => r.category === 'profit_loss' && r.direction === 'credit').reduce((s, r) => s + r.operating_signed, 0)
  )
  const cost = money2(
    balances.rows.filter((r) => r.category === 'profit_loss' && r.direction === 'debit').reduce((s, r) => s + r.operating_signed, 0)
  )
  const grossProfit = money2(revenue - cost)

  // 业务口径（发货 / 采购 / 库存）
  //
  // 这里刻意用**业务表自己的口径**，不借用账上的数：
  //   · 发货成本取 `inventory_transactions`（出库那一刻的成本），不是"发货行金额 × 某个毛利率"；
  //   · 应收未收取 `amount - allocated_amount`（核销明细的和），不是"amount - 已收款"这类反推；
  // 两套口径都各自只有一处定义，才谈得上"差异是真实的差异"。
  const bizDeliver = money2(num(`
    SELECT COALESCE(SUM(di.qty * di.price),0) v
      FROM sales_delivery_items di JOIN sales_deliveries d ON d.id = di.delivery_id
     WHERE substr(d.delivery_date,1,7) = ?`, p))
  const bizDeliverCost = money2(num(`
    SELECT COALESCE(SUM(amount),0) v FROM inventory_transactions
     WHERE doc_type='SAL_OUT' AND substr(biz_date,1,7) = ?`, p))
  const bizPurchase = money2(num(`
    SELECT COALESCE(SUM(ri.qty * ri.price),0) v
      FROM purchase_receipt_items ri JOIN purchase_receipts r ON r.id = ri.receipt_id
     WHERE substr(r.receipt_date,1,7) = ?`, p))
  const stockAmount = money2(num('SELECT COALESCE(SUM(qty_on_hand * cost_price),0) v FROM inventory_stocks'))
  const arOpen = money2(num("SELECT COALESCE(SUM(amount - allocated_amount),0) v FROM ar_documents WHERE status <> 'voided'"))
  const apOpen = money2(num("SELECT COALESCE(SUM(settle_amount - paid_amount),0) v FROM purchase_settlements WHERE status NOT IN ('voided','draft')"))

  const onBooks = {
    revenue,
    cost,
    gross_profit: grossProfit,
    gross_margin: revenue > 0 ? Number(((grossProfit / revenue) * 100).toFixed(2)) : null,
    profit: grossProfit,
    ar_balance: money2(-1 * balOf(['1122'])),
    ap_balance: money2(-1 * balOf(['2202'])),
    inventory_balance: balOf(['1403', '1405', '1408']),
    bank_balance: balOf(['1001', '1002'])
  }
  const onBiz = {
    delivery_amount: bizDeliver,
    delivery_cost: bizDeliverCost,
    purchase_amount: bizPurchase,
    stock_amount: stockAmount,
    ar_open: arOpen,
    ap_open: apOpen
  }
  const gaps = [
    { key: 'ar', label: '应收账款', books: onBooks.ar_balance, biz: onBiz.ar_open, diff: money2(onBooks.ar_balance - onBiz.ar_open) },
    { key: 'ap', label: '应付账款', books: onBooks.ap_balance, biz: onBiz.ap_open, diff: money2(onBooks.ap_balance - onBiz.ap_open) },
    { key: 'inventory', label: '存货', books: onBooks.inventory_balance, biz: onBiz.stock_amount, diff: money2(onBooks.inventory_balance - onBiz.stock_amount) }
  ].map((g) => ({ ...g, aligned: Math.abs(g.diff) <= 0.005 }))

  return {
    period: p,
    on_books: onBooks,
    on_biz: onBiz,
    gaps,
    note: '账上口径只统计**已过账**凭证；业务口径直接汇总业务单。'
      + '两者不相等是预期的 —— 本系统里生成凭证是显式动作，且未过账的凭证不计入账。'
      + '所以差额本身是「还没记到账上的业务」的度量，不是错误。',
    voucher_movement: balances.movement,
    opening: balances.opening
  }
}

// ---------------------------------------------------------------------------
// 八、域自证（与 `verify-seed` 共用同一份判据）
// ---------------------------------------------------------------------------
/**
 * 跨期比较的自证。**可注入 `result`** —— 这是刻意的：
 * 如果它只会"自己算一遍再自己核对"，那它就永远是对的，
 * 测试也就无法证明它**真的会响**。注入入口让"篡改后的比较结果"能进来挨这一刀。
 *
 * 两条探针各守一个口径：
 *   · `COMPARE_BASE_MISMATCH` —— 比较的两列必须等于"单独打开那一期"的结果。
 *     它守的是**唯一实现**：比较一旦走第二条取数路径（哪怕只是基期算错一个月），
 *     这条立刻响。这是本批最重要的一条。
 *   · `COMPARE_DIFF_MISMATCH` —— 差额必须是两列相减。它守的是**不许有第二个真值**：
 *     "再算一遍差额"这种做法在正常情况下与相减同值，只有在边界上（四舍五入、
 *     某一列被后处理过）才分叉 —— 而那时两列看着都正常。
 */
export function auditComparison(db, { reportCode, period, mode = null, result = null }) {
  const p = assertPeriod(period)
  const problems = []
  const push = (code, message, detail = null) => problems.push({ code, message, detail })

  let cmp = result
  try {
    if (!cmp) cmp = compareReport(db, { reportCode, period: p, mode: mode || 'previous' })
  } catch (e) {
    push('COMPARE_ERROR', `跨期比较算不出来：${e.message}`, { report_code: reportCode, period: p, mode })
    return { ok: false, problems, report_code: reportCode, period: p, mode, base_period: null, rows_checked: 0, comparable: false }
  }

  // **基期只由模式决定**（`previous` 就是上期），不由比较结果自己声称。
  // 否则"基期算错一个月"这件事会被自证绕过去：拿错的那一期去核对错的基期列，
  // 两边一致 —— 探针于是什么都发现不了，而这正是它该抓的东西。
  const wantMode = mode || cmp.mode || 'previous'
  const want = resolveCompareMode(db, { period: p, mode: wantMode })
  const basePeriod = want.base_period
  if (String(cmp.base_period || '') !== String(basePeriod)) {
    push(
      'COMPARE_BASE_PERIOD_BAD',
      `比较的基期是 ${cmp.base_period}，但模式「${wantMode}」（${want.label}）推导出的基期应当是 ${basePeriod}`,
      { period: p, mode: wantMode, got: cmp.base_period, expect: basePeriod }
    )
  }

  // 「两列都是累计」的模式（`yoy_ytd`）：核对对象必须是**同一口径**的单独计算 ——
  // 拿"单独打开本期的单期数"去核"比较里的累计列"，只会得到一条恒假的断言
  // （本批实测：不改这一处，pl 的 yoy_ytd 一跑就报 COMPARE_CURRENT_MISMATCH 3 行）。
  const soloRange = want.range || null
  const soloCurrent = computeReport(db, { reportCode, period: p, range: soloRange })
  const soloBase = computeReport(db, { reportCode, period: basePeriod, range: soloRange })

  // 口径本身也要核：结果自称"累计对累计"而模式说是单期（或反过来），
  // 说明它算的是**另一个口径**却用了这个口径的名字 —— 同族的还有基期期间与窗口两端。
  const wantBasis = want.range ? 'ytd' : 'period'
  if (cmp.compare_basis && cmp.compare_basis !== wantBasis) {
    push(
      'COMPARE_BASIS_BAD',
      `比较结果自称口径是「${cmp.compare_basis}」，而模式「${wantMode}」应当是「${wantBasis}」`,
      { period: p, mode: wantMode, got: cmp.compare_basis, expect: wantBasis }
    )
  }
  if (want.range) {
    // 期望窗口**字面算出**（读配置 + 字面算术），不调 `resolveRange` / `fiscalYearOf` ——
    // 与 `auditRange` 同一条理由：用被测对象推期望值就是自己验自己。
    const sm = readSetting(db, 'fiscal.start_month') || 1
    const startOf = (per) => {
      const y = Number(per.slice(0, 4))
      const mm = Number(per.slice(5, 7))
      return `${mm >= sm ? y : y - 1}-${String(sm).padStart(2, '0')}`
    }
    const bad = []
    if (String(cmp.range_meta?.from || '') !== startOf(p) || String(cmp.range_meta?.to || '') !== p) {
      bad.push(`本期窗口 ${cmp.range_meta?.from} ~ ${cmp.range_meta?.to}，应当是 ${startOf(p)} ~ ${p}`)
    }
    if (String(cmp.base_range_meta?.from || '') !== startOf(basePeriod) || String(cmp.base_range_meta?.to || '') !== basePeriod) {
      bad.push(`基期窗口 ${cmp.base_range_meta?.from} ~ ${cmp.base_range_meta?.to}，应当是 ${startOf(basePeriod)} ~ ${basePeriod}`)
    }
    if (bad.length) {
      push('COMPARE_RANGE_WINDOW_BAD', `"累计对累计"的两个窗口不对（${bad.length} 处）：${bad.join('；')}`, { period: p, mode: wantMode, rows: bad })
    }
  }
  // 单独计算那一侧也要按**同一个字段**取：累计模式取 `ytd_amount`，单期模式取 `amount`。
  // 取错字段的后果不是"比较更宽松"，而是把两条口径的数放在一起比 —— 一定不相等，
  // 报出来的却是一条看起来像"数据错了"的 COMPARE_CURRENT_MISMATCH。
  const soloOf = (r) => money2(soloRange ? r.ytd_amount : r.amount)
  const curByCode = new Map(soloCurrent.rows.map((r) => [r.line_code, soloOf(r)]))
  const baseByCode = new Map(soloBase.rows.map((r) => [r.line_code, soloOf(r)]))

  const badCur = []
  const badBase = []
  const badDiff = []
  const badRatio = []
  for (const r of cmp.rows || []) {
    const soloC = curByCode.get(r.line_code)
    const soloB = baseByCode.get(r.line_code)
    if (soloC === undefined || Math.abs(money2(r.amount) - soloC) > 0.005) badCur.push(`${r.line_name}：比较列 ${r.amount} ≠ 单独打开本期 ${soloC}`)
    if (soloB === undefined || Math.abs(money2(r.base_amount) - soloB) > 0.005) badBase.push(`${r.line_name}：基期列 ${r.base_amount} ≠ 单独打开基期 ${soloB}`)
    // 差额 = 本期 − 基期。**这里是复算，不是重算** —— 复算只用到比较结果里的两列，
    // 与 `compareReport` 怎么写的无关，所以它抓的是"差额被独立算过"这件事。
    if (Math.abs(money2(r.diff) - money2(Number(r.amount) - Number(r.base_amount))) > 0.005) {
      badDiff.push(`${r.line_name}：差额 ${r.diff} ≠ ${r.amount} − ${r.base_amount}`)
    }
    // 变动率为空 **当且仅当** 基期绝对值为 0（否则分母为 0 会写出 Infinity / NaN）
    const shouldBeNull = Math.abs(Number(r.base_amount)) <= 0.005
    const isNull = r.ratio === null || r.ratio === undefined
    if (shouldBeNull !== isNull) {
      badRatio.push(`${r.line_name}：基期 ${r.base_amount}，变动率应为${shouldBeNull ? '空' : '有值'}，实际 ${isNull ? '空' : r.ratio}`)
    }
  }
  if (badCur.length) push('COMPARE_CURRENT_MISMATCH', `比较的本期列与"单独打开本期"对不上（${badCur.length} 行）：${badCur.slice(0, 2).join('；')}`, { report_code: reportCode, period: p, rows: badCur })
  if (badBase.length) push('COMPARE_BASE_MISMATCH', `比较的基期列与"单独打开基期（${basePeriod}）"对不上（${badBase.length} 行）：${badBase.slice(0, 2).join('；')}`, { report_code: reportCode, period: p, base_period: basePeriod, rows: badBase })
  if (badDiff.length) push('COMPARE_DIFF_MISMATCH', `差额不等于两列相减（${badDiff.length} 行）：${badDiff.slice(0, 2).join('；')}`, { report_code: reportCode, period: p, rows: badDiff })
  if (badRatio.length) push('COMPARE_RATIO_BAD', `变动率与"基期是否为 0"不一致（${badRatio.length} 行）：${badRatio.slice(0, 2).join('；')}`, { report_code: reportCode, period: p, rows: badRatio })

  return {
    ok: problems.length === 0,
    problems,
    report_code: reportCode,
    period: p,
    mode: wantMode,
    base_period: basePeriod,
    comparable: !!cmp.base_meta?.comparable,
    rows_checked: (cmp.rows || []).length
  }
}

/**
 * **本年累计的自证**（批次 P）。
 *
 * 累计有一类特别隐蔽的失效方式：**区间算错但不自知**。
 * 起点错一个月（2026-02 起）、终点漏一期（到 2026-09 为止），两列都长得像真的，
 * 而且"少算一个月"在只有一两个月发生额的演示数据上**差异很小**。
 * 所以这里用**两条独立的路径**互相验证：
 *   · 路径一：整段一次聚合（`computeReport(range=ytd)`）；
 *   · 路径二：该年 1 月到本期**逐月各算一次再相加**（`computeReport(m)`）。
 * 两条路径的代码完全不同（一个按区间筛凭证、一个按月筛），
 * 所以它们同时错成同一个数的概率极低 —— 这正是"用独立实现验独立实现"。
 *
 * 另外两条守"结果自称的元信息"（批次 N 的教训）：
 * 区间自称的起点必须是本期所在年度的 1 月、终点必须就是本期；
 * 若不一致，说明它算的是**另一个窗口**却用这个窗口的名义报出来。
 */
export function auditRange(db, { reportCode, period, range = 'ytd', result = null }) {
  const p = assertPeriod(period)
  const problems = []
  const push = (code, message, detail = null) => problems.push({ code, message, detail })

  const rg = resolveRange(db, { period: p, range })
  const def = getReportDef(db, reportCode)

  // ⚠️ **期望窗口在这里"字面"算出，不调 `resolveRange`**（批次 P 反例 A 的产物）。
  // 反例 A 把 `resolveRange` 的起点改成 2 月后，这条探针**一声不吭** ——
  // 因为它的期望值也是从 `resolveRange` 推的：两边一起错，比较恒等。
  // 「用被测代码推期望值，再和被测代码的输出比」是**自己验自己**，
  // 这类探针比没有探针更危险：它占着位置，让人以为覆盖了。
  // 一条真正的独立探针，它的期望值必须来自**另一条推导**。
  //
  // 这里的"另一条推导"是：**读配置 + 字面算术**（批次 U 之四 / ③-c 把年初变成可配置的）。
  // 注意它读的是 `readSetting`（一个事实）而不是 `resolveRange` / `fiscalYearOf`（被测对象）——
  // 被测的正是"从起始月推出的窗口对不对"，所以期望值必须是"我自己按规则算一遍"。
  const startMonth = readSetting(db, 'fiscal.start_month') || 1
  const curYear = Number(p.slice(0, 4))
  const curMonth = Number(p.slice(5, 7))
  const fromYear = curMonth >= startMonth ? curYear : curYear - 1
  const expectFrom = `${fromYear}-${String(startMonth).padStart(2, '0')}`
  const expectTo = p

  // 时点口径报表不该有累计 —— 正常路径上 `computeReport` 已经拦了（409），
  // 这里再报一次是因为"注入的坏结果"会绕过那道闸门（探针必须能验"结果本身对不对"）。
  if (def.basis === 'balance') {
    push('RANGE_BASIS_NOT_APPLICABLE', `报表「${def.name}」是时点口径（${def.basis_label}），不该有"${rg.mode_label}"`, { report_code: reportCode, basis: def.basis })
    return { ok: false, problems, report_code: reportCode, period: p, range: rg.mode, from: expectFrom, to: expectTo, rows_checked: 0 }
  }

  let got = result
  try {
    if (!got) got = computeReport(db, { reportCode, period: p, range })
  } catch (e) {
    push('RANGE_ERROR', `本年累计算不出来：${e.message}`, { report_code: reportCode, period: p, range })
    return { ok: false, problems, report_code: reportCode, period: p, range: rg.mode, from: expectFrom, to: expectTo, rows_checked: 0 }
  }

  const meta = got.range_meta || {}
  if (String(meta.from || '') !== expectFrom) {
    push('RANGE_FROM_NOT_JAN', `本年累计的起点是 ${meta.from}，应当是 ${expectFrom}（本期 ${p} 所在年度的 1 月）`, { period: p, got: meta.from, expect: expectFrom })
  }
  if (String(meta.to || '') !== expectTo) {
    push('RANGE_TO_NE_PERIOD', `本年累计的终点是 ${meta.to}，应当就是本期 ${expectTo}（否则"累计到今天"是假的）`, { period: p, got: meta.to, expect: expectTo })
  }

  // 本期列必须等于"单独打开本期"——**累计只是加一列，不该改变本期这一列**
  const solo = computeReport(db, { reportCode, period: p })
  const soloByCode = new Map(solo.rows.map((r) => [r.line_code, money2(r.amount)]))
  const badCur = []
  for (const r of got.rows || []) {
    const v = soloByCode.get(r.line_code)
    if (v === undefined || Math.abs(money2(r.amount) - v) > 0.005) badCur.push(`${r.line_name}：本期列 ${r.amount} ≠ 单独打开本期 ${v}`)
  }
  if (badCur.length) {
    push('RANGE_CURRENT_MISMATCH', `加了累计列之后本期列变了（${badCur.length} 行）：${badCur.slice(0, 2).join('；')}`, { report_code: reportCode, period: p, rows: badCur })
  }

  // ---- 逐月相加（**另一条独立路径**）----
  const sums = new Map()
  const months = []
  for (let m = expectFrom; m <= expectTo; m = shiftPeriod(m, 1)) {
    months.push(m)
    const rep = computeReport(db, { reportCode, period: m })
    for (const r of rep.rows) sums.set(r.line_code, money2((sums.get(r.line_code) || 0) + money2(r.amount)))
  }
  const badSum = []
  for (const r of got.rows || []) {
    if (r.ytd_amount === undefined) {
      badSum.push(`${r.line_name}：没有累计列（ytd_amount 缺失）`)
      continue
    }
    const want2 = sums.get(r.line_code) ?? 0
    if (Math.abs(money2(r.ytd_amount) - want2) > 0.005) badSum.push(`${r.line_name}：累计 ${r.ytd_amount} ≠ 逐月相加 ${want2}`)
  }
  if (badSum.length) {
    push(
      'RANGE_NE_SUM_OF_MONTHS',
      `本年累计与"逐月各算一次再相加"对不上（${badSum.length} 行，窗口 ${expectFrom}~${expectTo}）：${badSum.slice(0, 2).join('；')}`,
      { report_code: reportCode, period: p, months, rows: badSum }
    )
  }

  return {
    ok: problems.length === 0,
    problems,
    report_code: reportCode,
    period: p,
    range: rg.mode,
    from: expectFrom,
    to: expectTo,
    months_checked: months.length,
    rows_checked: (got.rows || []).length
  }
}

/**
 * 报表域的全部不变量。**与 `verify-seed` 共用这一份实现** ——
 * 测试里再写一遍"资产等于负债加权益"，两处迟早只改一处。
 */
export function auditReport(db, { period }) {
  const p = assertPeriod(period)
  const problems = []
  const push = (code, message, detail = null) => problems.push({ code, message, detail })

  const defs = listReportDefs(db)
  if (!defs.length) push('NO_REPORT_DEF', '没有任何报表定义')

  // ---- ① 覆盖性：每一张需要穷尽的报表，科目必须**全部**被认领 ----
  // 这是"报表看起来很好看、就是差一个数"这类配置错误的唯一探针。
  //
  // ⚠️ 覆盖检查**必须排除兜底行**。兜底行的区间是 `0000~9999`，
  //    把它算进并集的话，这条检查会**永远通过** —— 而它的全部价值就在于抓漏配。
  const allSubjects = db.prepare("SELECT id, code, name, category FROM accounting_subjects WHERE status='active'").all()
  for (const def of defs) {
    const lines = listReportLines(db, def.report_code)
    if (def.basis === 'cash_flow') {
      const hasFallback = lines.some((l) => l.is_fallback)
      if (!hasFallback) {
        push('CF_NO_FALLBACK', `现金流量表「${def.name}」没有兜底行：认领不到的现金收支会**凭空消失**（净增加额与现金类科目变动对不上）`, { report_code: def.report_code })
      }
      continue
    }
    const owned = lines.filter((l) => l.line_type === 'item' && !l.is_fallback)
    const segs = []
    for (const l of owned) segs.push(...parseSubjectRange(l.subject_range))
    // 只检查这张报表**声明要穷尽覆盖**的科目大类。
    // 声明为空（现金流量表）就不做覆盖检查 —— 它的"覆盖面"由兜底行保证。
    const cats = def.cover_category_list || []
    const mustCover = cats.length ? allSubjects.filter((s) => cats.includes(s.category)) : []
    const uncovered = mustCover.filter((s) => !inSubjectRange(s.code, segs))
    if (uncovered.length) {
      push('SUBJECT_UNCOVERED', `报表「${def.name}」有 ${uncovered.length} 个科目没人认领：${uncovered.map((s) => `${s.code} ${s.name}`).join('、')}`, { report_code: def.report_code, subjects: uncovered.map((s) => s.code) })
    }
    // 区间重叠：两个科目行同时认领一个科目 ⇒ 该科目被**算两次**。
    // 这与"漏配"方向相反但同样隐蔽 —— 试算平衡表看不出来，只有报表不平或某一项偏大。
    const overlap = []
    for (let i = 0; i < owned.length; i += 1) {
      for (let j = i + 1; j < owned.length; j += 1) {
        for (const s of allSubjects) {
          const a = inSubjectRange(s.code, parseSubjectRange(owned[i].subject_range))
          const b = inSubjectRange(s.code, parseSubjectRange(owned[j].subject_range))
          if (a && b) overlap.push(`${owned[i].line_name} ∩ ${owned[j].line_name}（${s.code} ${s.name}）`)
        }
      }
    }
    if (overlap.length) {
      push('LINE_RANGE_OVERLAP', `报表「${def.name}」的科目行区间重叠，受影响的科目会被算两次：${overlap.slice(0, 3).join('、')}`, { report_code: def.report_code, overlap })
    }
  }

  // ---- ② 资产负债表平衡 ----
  let bs = null
  let pl = null
  let cf = null
  try { bs = balanceSheet(db, { period: p }) } catch (e) { push('BS_ERROR', `资产负债表算不出来：${e.message}`) }
  try { pl = incomeStatement(db, { period: p }) } catch (e) { push('PL_ERROR', `利润表算不出来：${e.message}`) }
  try { cf = cashFlow(db, { period: p }) } catch (e) { push('CF_ERROR', `现金流量表算不出来：${e.message}`) }

  if (bs) {
    const assets = bs.totals.BS_ASSETS_TOTAL
    const liab = bs.totals.BS_LIABILITIES_TOTAL
    const equity = bs.totals.BS_EQUITY_TOTAL
    if (assets === undefined || liab === undefined || equity === undefined) {
      push('BS_TOTAL_MISSING', '资产负债表缺少「资产合计 / 负债合计 / 所有者权益合计」中某一行的定义', { keys: Object.keys(bs.totals) })
    } else if (Math.abs(assets - (liab + equity)) > 0.005) {
      push('BS_NOT_BALANCED', `资产负债表不平：资产 ${assets} ≠ 负债 ${liab} + 权益 ${equity}（差 ${money2(assets - liab - equity)}）`, { assets, liabilities: liab, equity })
    }
  }

  // ---- ②之二 兜底行为空（资产负债表 / 利润表） ----
  // 兜底行的用途是"不让金额凭空消失"，不是"掩盖漏配"。
  // 它一旦接了钱，就说明有科目没被任何具体行认领 —— 而那正是 ① 已经报过的事；
  // 这里再报一次是因为**两条检查的失效方式不同**：① 靠区间并集，② 靠实际发生额。
  for (const report of [bs, pl]) {
    if (!report) continue
    const fb = report.rows.find((l) => l.is_fallback)
    if (fb && Math.abs(Number(fb.amount || 0)) > 0.005) {
      push(
        'FALLBACK_NONZERO',
        `报表「${report.report_name}」的兜底行「${fb.line_name}」金额为 ${fb.amount}：有科目没被任何具体行认领（兜底行只应作为"金额不会消失"的保险，不应真的有数）`,
        { report_code: report.report_code, line_code: fb.line_code, amount: fb.amount }
      )
    }
  }

  // ---- ③ 利润表：净利润必须等于"损益类科目**经营口径**发生额的取负之和" ----
  // 记 `signed = 借 − 贷`，则 `−signed` 对收入类（贷方发生）是 **+**、对成本费用类（借方发生）是 **−**
  // —— "收入取正、费用取负"正好等价于"全部损益科目的 signed 取负"，
  // 这是借贷平衡的推论（Σ所有科目 signed ≡ 0），所以公式里**不需要按方向分支**。
  //
  // ⚠️ 这里曾经写成 `direction === 'credit' ? -signed : +signed`（费用取了正号），
  //    而它**只在损益非 0 时才现形**：演示库里 2026-10 的损益发生额恰好是 0，
  //    于是这条探针长期恒真（`0 === 0`），直到批次 M 在测试里造出真实的损益发生额才被抓住。
  //    这是本项目"探针不响等于没有"的第三种形态：不是探针没跑，而是它的**公式写反了**。
  if (pl && pl.balances) {
    const plCodes = new Set(
      pl.balances.rows.filter((r) => r.category === 'profit_loss').map((r) => r.code)
    )
    const expected = money2(
      -1 * pl.balances.rows.filter((r) => r.category === 'profit_loss').reduce((s, r) => s + r.operating_signed, 0)
    )
    const actual = pl.totals.PL_NET_PROFIT
    if (actual === undefined) {
      push('PL_TOTAL_MISSING', '利润表缺少「净利润」行的定义', { keys: Object.keys(pl.totals) })
    } else if (Math.abs(actual - expected) > 0.005) {
      push('PL_MISMATCH', `利润表的净利润与损益类科目发生额合计对不上：报表 ${actual} ≠ 复算 ${expected}（差 ${money2(actual - expected)}）`, { report: actual, expected, profit_loss_subjects: [...plCodes].length })
    }
  }

  // ---- ④ 现金流量表：净增加额 = 现金类科目期末 − 期初 ----
  if (cf && cf.balances === null) {
    const actual = cf.totals.CF_NET_INCREASE
    const cashCodes = cf.cash.cash_subjects
    const bal = subjectBalances(db, { period: p })
    const cashRows = bal.rows.filter((r) => cashCodes.includes(r.code))
    const cashOpening = money2(cashRows.reduce((s, r) => s + r.opening_signed, 0))
    const cashClosing = money2(cashRows.reduce((s, r) => s + r.closing_signed, 0))
    const expected = money2(cashClosing - cashOpening)
    if (actual === undefined) {
      push('CF_TOTAL_MISSING', '现金流量表缺少「现金及现金等价物净增加额」行的定义', { keys: Object.keys(cf.totals) })
    } else if (Math.abs(actual - expected) > 0.005) {
      push('CF_MISMATCH', `现金流量表净增加额与现金类科目变动对不上：报表 ${actual} ≠ 复算 ${expected}（差 ${money2(actual - expected)}）`, { report: actual, expected, cash_subjects: cashCodes })
    }
  }

  // ---- ④之二 现金流量项目标记（批次 U）----
  // 这一维是**人给的答案**，所以它有两种坏法，而两种都**不报错**：
  //   · 分录标了一个字典里没有的项目 —— 那一笔会静默退回按对手科目分析填列，
  //     而分析出来的行与打标记的人想的不是同一行（报表看起来完全正常）；
  //   · 字典自己的取值域被写坏（category / direction）—— 界面按类别分组会**少一组**，
  //     而少的那一组看起来只是"这个类别没有项目"。
  // 探针**只查不修**：`auditReport` 是关账前置，在"检查"里写库等于把问题抹平。
  if (cfTagSupportOf(db)) {
    const unknownTag = db
      .prepare(`
        SELECT COUNT(*) c FROM voucher_entries e
         WHERE e.cash_flow_item IS NOT NULL AND e.cash_flow_item <> ''
           AND NOT EXISTS (SELECT 1 FROM cash_flow_items i WHERE i.code = e.cash_flow_item)
      `)
      .get().c
    if (Number(unknownTag) > 0) {
      push(
        'CF_ITEM_UNKNOWN',
        `有 ${unknownTag} 条分录挂着字典里不存在的现金流量项目：这些分录会静默退回按对手科目分析填列，而分析出来的行与打标记的人想的不是同一行`,
        { count: Number(unknownTag) }
      )
    }
    const badCat = db
      .prepare("SELECT COUNT(*) c FROM cash_flow_items WHERE category NOT IN ('operating','investing','financing')")
      .get().c
    const badDir = db
      .prepare("SELECT COUNT(*) c FROM cash_flow_items WHERE direction NOT IN ('in','out','both')")
      .get().c
    if (Number(badCat) > 0 || Number(badDir) > 0) {
      push(
        'CF_ITEM_DOMAIN',
        `现金流量项目字典的取值域被写坏：类别非法 ${badCat} 条 / 方向非法 ${badDir} 条（类别决定它归经营活动还是投资/筹资，方向决定它是流入还是流出）`,
        { bad_category: Number(badCat), bad_direction: Number(badDir) }
      )
    }
  }

  // ---- ⑤ 期初余额必须平（不平的期初会让之后每一期都不平，且差额来源不可考） ----
  const base = db
    .prepare('SELECT period FROM accounting_opening_balances WHERE period <= ? ORDER BY period DESC LIMIT 1')
    .get(p)
  if (base) {
    const ob = listOpeningBalances(db, { period: base.period })
    if (!ob.balanced) {
      push('OPENING_NOT_BALANCED', `期初余额（${base.period}）不平：借 ${ob.total_debit} ≠ 贷 ${ob.total_credit}（差 ${ob.diff}）`, { period: base.period })
    }
  }

  // ---- ⑥ 期末结转的状态与账必须一致（批次 M） ----
  // 三条探针各指向一种"结转没做对"的方式，而它们的**失效方式互不相同**：
  //   · 已关账但未结转 → 账没结平就定稿了（035 之前的存量数据，或有人绕过前置）；
  //   · 已结转但损益仍有余额 → 反关账后补了业务发生额而没重做结转。
  //     这条特别值得单独报：**报表靠「未结转损益」行凑平，所以别的检查都不会响**；
  //   · 结转凭证被删 / 被作废 / 挪了期间 → 期间说"已结转"、凭证说没有。
  for (const pr of db
    .prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM vouchers v WHERE v.period = p.period AND v.status='posted') AS posted_count
        FROM accounting_periods p ORDER BY p.period
    `)
    .all()) {
    if (!pr.closing_voucher_id) {
      // 没有已过账凭证的期间不必计算余额：它没有可结转的东西
      if (pr.status === 'closed' && Number(pr.posted_count) > 0) {
        const pending = uncarriedProfitSubjects(db, { period: pr.period })
        if (pending.length) {
          push(
            'PERIOD_CLOSED_NO_CARRY',
            `期间 ${pr.period} 已关账却没有做期末结转，还有 ${pending.length} 个损益科目挂着余额（${pending.slice(0, 3).map((x) => x.code).join('、')}${pending.length > 3 ? ' 等' : ''}）：这一期的账并没有结平`,
            { period: pr.period, subjects: pending.map((x) => x.code) }
          )
        }
      }
      continue
    }
    const v = db.prepare('SELECT id, biz_type, status, period FROM vouchers WHERE id=?').get(pr.closing_voucher_id)
    if (!v || v.biz_type !== CARRY_BIZ_TYPE || v.status !== 'posted' || v.period !== pr.period) {
      push(
        'CLOSING_VOUCHER_BAD',
        `期间 ${pr.period} 记录的结转凭证 #${pr.closing_voucher_id} ${!v ? '不存在' : `不合法（类型「${v.biz_type}」、状态「${v.status}」、期间「${v.period}」）`}：期间说"已结转"，凭证说没有`,
        { period: pr.period, closing_voucher_id: pr.closing_voucher_id }
      )
      continue
    }
    const pending = uncarriedProfitSubjects(db, { period: pr.period })
    if (pending.length) {
      push(
        'CARRY_INCOMPLETE',
        `期间 ${pr.period} 已结转，但损益科目仍有余额（${pending.slice(0, 3).map((x) => `${x.code} ${x.name}`).join('、')}${pending.length > 3 ? ' 等' : ''}）：通常是反关账后又补了业务发生额，需要撤销结转后重做`,
        { period: pr.period, subjects: pending.map((x) => x.code) }
      )
    }
  }

  // ---- ⑥之二 反向不一致：结转账还在，但期间没记它（`closing_voucher_id` 被清空） ----
  // 上面那一段是"**从期间出发**看凭证"，所以它只看得见"期间说了什么"。
  // 这一条要单独扫凭证表 —— "账已经转过了、期间说没有"是另一个方向的坏状态，
  // 而它的表现更隐蔽：界面显示"未结转"，但实际上已经转过了（再点结转会撞唯一约束）。
  const orphans = db
    .prepare(`
      SELECT v.id, v.doc_no, v.period, p.period AS period_row_exists, p.closing_voucher_id
        FROM vouchers v LEFT JOIN accounting_periods p ON p.period = v.period
       WHERE v.biz_type = ? AND v.status = 'posted'
         AND (p.period IS NULL OR p.closing_voucher_id IS NULL OR p.closing_voucher_id <> v.id)
    `)
    .all(CARRY_BIZ_TYPE)
  if (orphans.length) {
    push(
      'CARRY_VOUCHER_ORPHAN',
      `有 ${orphans.length} 张结转凭证没有被任何期间记录（如 ${orphans[0].doc_no} / ${orphans[0].period}）：期间说"未结转"，但账上已经转过了`,
      { vouchers: orphans.map((x) => x.doc_no) }
    )
  }

  // ---- ⑦ 本期期初 = 上期期末（逐科目）—— 批次 N ----
  // 这是"期初滚动"这件事的自证，也是跨期比较里"资产负债表比的是时点"的落点：
  // 上期末就是本期期初，所以逐科目的余额必须接得上。
  //
  // 成立的**前提**（不满足就跳过，而不是报错）：
  //   两期共享同一个期初基准，也就是**本期没有自己的期初登记**。
  //   本期若人工重设过期初，本期期初与上期期末本来就不该相等 ——
  //   那时"差多少"是人的选择，不是错误。
  //
  // ⚠️ **必须全期间扫描，不能只查"我正在看的那一期"** ——
  //    本批的反例注入给出了确切证据：把期初滚动的终点前移一个月（少滚一期发生额）后，
  //    在 P=2026-10 上**看不出任何差异**（它前两期都没有发生额），偏差全部落在 2026-09；
  //    只查本期的探针于是**一声不吭**，而账确实已经错了。
  //    「我只检查了我正在看的那一期」是最典型的一种覆盖面盲区 ——
  //    比断言少更危险，因为断言少至少还知道少；盲区是"以为覆盖了"。
  //    （同批的第 ⑥ 条结转探针本来就是全表扫描，这里与它对齐。）
  //
  // 为什么值得单独守：**别的探针都抓不到它**。少滚一期发生额时，
  // 那一期的 Σsigned 本就是 0（凭证借贷平衡），所以资产负债表**仍然是平的**，
  // 净利润与现金流也各算各的 —— 账面上一切正常，只有"期初接不上"这一个证据。
  const scanPeriods = db
    .prepare(`
      SELECT DISTINCT period FROM accounting_opening_balances
       UNION SELECT DISTINCT period FROM vouchers WHERE status='posted'
       ORDER BY period
    `)
    .all()
    .map((r) => String(r.period))
  const openingRegistered = new Set(
    db.prepare('SELECT DISTINCT period FROM accounting_opening_balances').all().map((r) => String(r.period))
  )
  const openingGap = []
  for (const cur of scanPeriods) {
    const prev = shiftPeriod(cur, -1)
    if (openingRegistered.has(cur)) continue // 本期自己登记过期初 → 本期期初是人工重设的，与上期期末无关，不适用
    // **不再要求"账上存在期初基准"**（批次 O 改）。
    // 批次 N 的第一版要求 `存在 period <= prev 的期初登记`，于是"从未登记过期初的库"
    // 整段被跳过 —— 而那正是唯一会出错的情形（`openingBalancesAsOf` 曾经在没有基准时
    // **停止滚动**，把更早期间的发生额整段吞掉）。修掉滚动之后，这里也就不该再有这道前提：
    // 没有基准时"最早一期的前一期"余额为 0，逐期仍然必须接得上。
    const a = subjectBalances(db, { period: prev })
    const b = subjectBalances(db, { period: cur })
    const prevClose = new Map(a.rows.map((r) => [Number(r.subject_id), money2(r.closing_signed)]))
    for (const r of b.rows) {
      const want = prevClose.get(Number(r.subject_id)) ?? 0
      if (Math.abs(money2(r.opening_signed) - want) > 0.005) {
        openingGap.push({ period: cur, prev_period: prev, code: r.code, opening: money2(r.opening_signed), prev_close: want })
      }
    }
  }
  if (openingGap.length) {
    push(
      'OPENING_NE_BASE_CLOSE',
      `有 ${openingGap.length} 处「本期期初 ≠ 上期期末」（如 ${openingGap[0].period} 的 ${openingGap[0].code}：`
        + `期初 ${openingGap[0].opening} ≠ ${openingGap[0].prev_period} 期末 ${openingGap[0].prev_close}）`
        + ' —— 这类偏差**账仍然是平的**（少滚的那一期借贷本就平衡），所以只有这一条会响',
      { count: openingGap.length, sample: openingGap.slice(0, 5) }
    )
  }

  // ---- ⑧ 年度结转与利润分配的状态一致性（批次 O）----
  // 四条都是**全库扫描**（与第 ⑥ ⑦ 条对齐）：年结是"整年"级别的事实，
  // 而 `auditReport` 的调用面是"某一期" —— 只查当期等于没查（批次 N 的教训）。
  // 唯一读取点（`readSetting`）—— 不再在这里手写默认值，那会是第二份定义。
  const closingCode8 = readSetting(db, 'closing_profit_subject')

  // ⑧-1 有年结凭证、但没有任何期间记录指向它：期间说"未年结"，账上已经结过了。
  const annualOrphans = db
    .prepare(`
      SELECT v.doc_no, v.period FROM vouchers v
       WHERE v.biz_type = 'annual_carry'
         AND NOT EXISTS (SELECT 1 FROM accounting_periods p WHERE p.annual_voucher_id = v.id)
       ORDER BY v.period
    `)
    .all()
  if (annualOrphans.length) {
    push(
      'ANNUAL_VOUCHER_ORPHAN',
      `有 ${annualOrphans.length} 张年度结转凭证没有被任何期间记录（如 ${annualOrphans[0].doc_no} / ${annualOrphans[0].period}）：期间说"未年结"，但账上已经结过了`,
      { vouchers: annualOrphans.map((x) => x.doc_no) }
    )
  }

  const carriedYears = db
    .prepare("SELECT period, annual_voucher_id, substr(period,1,4) AS y FROM accounting_periods WHERE annual_voucher_id IS NOT NULL ORDER BY period")
    .all()

  // ⑧-2 年结后 4103 必须归零。不为 0 只有三种原因，每一种都得有人去看：
  //      年结的金额算错了 / 年结后又往那一年补了损益凭证 / 月度结转漏了一期。
  const notZero = []
  const openInCarried = []
  for (const c of carriedYears) {
    const bal = subjectBalances(db, { period: `${c.y}-12` })
    const row = bal.rows.find((r) => r.code === closingCode8)
    const signed = money2(row?.closing_signed ?? 0)
    if (Math.abs(signed) > 0.005) notZero.push({ year: c.y, code: closingCode8, signed })
    // ⑧-3 年结承诺"这一年定稿了"，而打开着的期间随时能被改。
    const open = db
      .prepare("SELECT period FROM accounting_periods WHERE substr(period,1,4)=? AND status<>'closed' ORDER BY period")
      .all(c.y)
    if (open.length) openInCarried.push({ year: c.y, periods: open.map((x) => x.period) })
  }
  if (notZero.length) {
    push(
      'ANNUAL_NOT_BALANCED',
      `已年结的年度里 ${closingCode8} 的年末余额不为 0（${notZero.slice(0, 3).map((x) => `${x.year} 年 ${x.signed}`).join('；')}）：年结本该把它结平 —— 可能是金额算错、或年结后又往那一年补了损益凭证`,
      { items: notZero }
    )
  }
  if (openInCarried.length) {
    push(
      'ANNUAL_PERIODS_NOT_CLOSED',
      `已年结的年度里仍有未关账的期间（${openInCarried.slice(0, 3).map((x) => `${x.year}：${x.periods.join('、')}`).join('；')}）：年结承诺"这一年定稿了"，而打开着的期间随时能被改`,
      { items: openInCarried }
    )
  }

  // ⑧-4 分配是年结的下游：分掉的钱必须有"本年利润转入"这个来源。
  const distNoAnnual = db
    .prepare(`
      SELECT p.period FROM accounting_periods p
       WHERE p.dist_voucher_id IS NOT NULL AND p.annual_voucher_id IS NULL ORDER BY p.period
    `)
    .all()
  if (distNoAnnual.length) {
    push(
      'DISTRIBUTION_WITHOUT_ANNUAL',
      `有 ${distNoAnnual.length} 个年度做了利润分配却没有年度结转（${distNoAnnual.map((x) => x.period).join('、')}）：分掉的钱没有"本年利润转入"这个来源`,
      { periods: distNoAnnual.map((x) => x.period) }
    )
  }

  // ---- ⑨ 本年累计 = 该年逐月相加（批次 P，**全期间扫描**）----
  // 为什么放在 `auditReport`（跟着每一次自证跑）而不是只放在 `/:code/range/audit`：
  // **一个只在用户点了"累计"才会跑的探针等于不跑的探针**。累计是报表的一种常态看法，
  // 它错了却没人点开过，那就是"数据错了但系统一路绿灯"。
  //
  // 为什么**全期间扫描**而不是只查本期：批次 N 的反例给过确切证据 ——
  // 只查"我正在看的那一期"，偏差落在别的期间上时探针**一声不吭**（覆盖面盲区）。
  // 这里同样是"比起断言少，盲区更危险"。
  //
  // 为什么只查 `amount` / `cash_flow` 两种口径：时点口径没有累计这回事
  // （`computeReport` 会 409），拿它来查只会得到一条恒真的死断言。
  const postedPeriods = db
    .prepare("SELECT DISTINCT period FROM vouchers WHERE status='posted' ORDER BY period")
    .all()
    .map((r) => String(r.period))
  const rangeBad = []
  let rangeChecked = 0
  for (const def of defs) {
    if (def.basis === 'balance') continue
    for (const pr of postedPeriods) {
      const a = auditRange(db, { reportCode: def.report_code, period: pr, range: 'ytd' })
      rangeChecked += 1
      for (const pb of a.problems) rangeBad.push({ period: pr, report_code: def.report_code, code: pb.code, message: pb.message })
    }
  }
  if (rangeBad.length) {
    push(
      'YTD_NOT_SOUND',
      `本年累计自证不通过（${rangeBad.length} 处）：${rangeBad.slice(0, 2).map((x) => `${x.report_code}/${x.period} ${x.code}`).join('；')}`,
      { problems: rangeBad.slice(0, 10), checked: rangeChecked }
    )
  }

  // ---- ⑩ 期间审计链自洽（批次 Q，**全库扫描**）----
  // 与 ⑨ 同一条理由：只在用户点开某一期时才跑的探针等于不跑。
  //
  // 这一条比前面九条"更像审计"而不是"更像算术"：它核对的是
  // **"账上现在这个样子，能不能由这一路做过的动作解释得出来"**。
  // 具体四条（实现全在 `lib/period-audit.js` 的 `auditPeriodTrail`）：
  //   · 重放日志 = 期间表现状（两条路径互证）
  //   · 期间表上有留痕 ⇒ 必须有对应动作的日志（补重放的盲区）
  //   · 每条派生凭证都必须被某条日志认领（这条**完全不读期间表**）
  //   · 年结承诺"封整年"⇒ 该年度不能还有开着的期间
  const trail = auditPeriodTrail(db)
  for (const pb of trail.problems) push(pb.code, pb.message, pb.detail)

  // ---- ⑪ 配置变更链自洽（批次 R，**全库扫描**）----
  // 与 ⑨ ⑩ 同一条理由：只在用户点开某一期时才跑的探针等于不跑。
  //
  // 这一条回答的是**会计政策的可信度**：`closing_profit_subject`（期末结转到哪个科目）、
  // `annual_retained_subject`、`ar_source_of_truth`、`pos_variance_limit` 这些配置，
  // 决定了上面那几张报表是怎么算出来的。它们被人改过却说不清"谁改的、原来是什么"，
  // 与"账没留痕"是同一类问题 —— 所以也挡在关账前置里（`closePeriod` 的前置就是 `auditReport`）。
  //
  // 七条（实现全在 `lib/settings.js` 的 `auditSettingTrail`）：动作名是否认识 ·
  // 危险配置改动是否写了理由 · 库里有没有未登记的键 · 日志里有没有已移除的键 ·
  // 登记的键是否都落了库 · 现状值是否满足值域 · 重放日志能否得到 settings 的现状。
  //
  // **这一条不做初始化**（不调 `ensureSettings`）：`auditReport` 是只读自证，
  // 在"检查"里写库会让"没配齐"这件事被检查本身掩盖掉。
  // 配置初始化在 `bootIndustry` 与 `/api/meta/settings` 两处（见 `db/boot.js`）。
  const cfgTrail = auditSettingTrail(db)
  for (const pb of cfgTrail.problems) push(pb.code, pb.message, pb.detail)

  // ---- ⑫ 报表口径变更链自洽（批次 S，**全库扫描**）----
  // 与 ⑨ ⑩ ⑪ 同一条理由：只在用户点开某一期时才跑的探针等于不跑。
  //
  // 这一条回答的是**上面那三张报表是怎么被定义出来的、这个定义有没有人来路**。
  // ⑪ 守的是"参数（settings）改了有没有留痕"，这一条守的是**报表结构本身**
  // （`report_defs` / `report_lines`：科目区间、方向口径、小计表达式）——
  // 两者是同一件事的两半，但对象与危险字段集都不同（见 `lib/report-config-audit.js`
  // 文件头第二节：那边危险是"键的属性"，这边危险是"这次动了哪个字段"）。
  //
  // 八条（实现全在 `lib/report-config-audit.js` 的 `auditReportConfigTrail`）：
  // 动作名是否认识 · 快照是否整份 · 快照是否可解析 · 危险改动是否写了理由 ·
  // 有没有行一条历史都没有（`UNTRACKED`）· 有历史的行能否重放出来（`DESYNC`，
  // **与 UNTRACKED 互斥**）· 有没有行挂在不存在的报表上 · `SNAPSHOT_FIELDS`
  // 有没有漏掉表里新增的列。
  //
  // **这一条不做初始化**（不调 `ensureReportConfigTrail`）：`auditReport` 是只读自证，
  // 在"检查"里写库会让"没补基线"这件事被检查本身掩盖掉。初始化在 `bootIndustry`
  // 与 `seedReport` 两处（见 `db/boot.js` 与 `db/report-seed.js`）。
  const cfgReportTrail = auditReportConfigTrail(db)
  for (const pb of cfgReportTrail.problems) push(pb.code, pb.message, pb.detail)

  return {
    period: p,
    ok: problems.length === 0,
    problems,
    range_checked: rangeChecked,
    trail_checked: trail.entries_checked,
    config_checked: cfgTrail.keys_checked,
    report_config_checked: cfgReportTrail.entries_checked,
    totals: {
      assets: bs?.totals.BS_ASSETS_TOTAL ?? null,
      liabilities: bs?.totals.BS_LIABILITIES_TOTAL ?? null,
      equity: bs?.totals.BS_EQUITY_TOTAL ?? null,
      net_profit: pl?.totals.PL_NET_PROFIT ?? null,
      cash_net_increase: cf?.totals.CF_NET_INCREASE ?? null
    },
    cash_complex_vouchers: cf?.cash?.complex_vouchers ?? 0,
    // 现金流量表的填列构成（批次 U）：多少条是**记的**（项目标记）、多少条是**推的**（对手科目分析）。
    // 与 `cash_complex_vouchers` 并列放在这里，是因为"这张表可信到什么程度"是自证的一部分 ——
    // 只报复合凭证张数，读的人会以为其余全是精确归类的。
    cash_tagged_entries: cf?.cash?.tagged_count ?? 0,
    cash_untagged_entries: cf?.cash?.untagged_count ?? 0,
    cash_tagged_vouchers: cf?.cash?.tagged_vouchers ?? 0
  }
}

/** 可用期间列表（有凭证或有登记期初的期间，倒序） */
export function availablePeriods(db) {
  const rows = db
    .prepare(`
      SELECT period, COUNT(*) AS voucher_count,
             SUM(CASE WHEN status='posted' THEN 1 ELSE 0 END) AS posted_count
        FROM vouchers GROUP BY period
    `)
    .all()
  const map = new Map(rows.map((r) => [String(r.period), { period: String(r.period), voucher_count: Number(r.voucher_count), posted_count: Number(r.posted_count || 0) }]))
  for (const r of db.prepare('SELECT DISTINCT period FROM accounting_opening_balances').all()) {
    const k = String(r.period)
    if (!map.has(k)) map.set(k, { period: k, voucher_count: 0, posted_count: 0 })
  }
  const periods = [...map.values()].sort((a, b) => (a.period < b.period ? 1 : -1))
  const periodSet = new Set(periods.map((x) => x.period))
  for (const p of listPeriods(db)) if (!periodSet.has(p.period)) periods.push({ period: p.period, voucher_count: 0, posted_count: 0 })
  periods.sort((a, b) => (a.period < b.period ? 1 : -1))
  const status = new Map(listPeriods(db).map((r) => [r.period, r.status]))
  // 每期顺手给出环比 / 同比的基期期间名。**基期只由 `shiftPeriod` 算**（唯一出处），
  // 界面不自己减月份 —— 界面上"手算上一个月"是这类功能最常见的错误来源
  // （1 月减 1 得到 0 月、跨年时年份忘了退）。
  return periods.map((x) => ({
    ...x,
    status: status.get(x.period) || 'open',
    status_label: PERIOD_STATUS_LABEL[status.get(x.period) || 'open'],
    prev_period: shiftPeriod(x.period, -1),
    yoy_period: shiftPeriod(x.period, -12)
  }))
}

export function meta(db) {
  return {
    reports: listReportDefs(db),
    basis: Object.entries(REPORT_BASIS_LABEL).map(([value, label]) => ({ value, label })),
    line_types: Object.entries(LINE_TYPE_LABEL).map(([value, label]) => ({ value, label })),
    period_status: Object.entries(PERIOD_STATUS_LABEL).map(([value, label]) => ({ value, label })),
    compare_modes: [
      { value: '', label: '不比较', delta: 0 },
      // `compare_basis`：这一模式比较的是"单期 vs 单期"还是"累计 vs 累计"。
      // 界面据此决定"本年累计"开关是否要跟着打开，以及列名里要不要出现区间。
      ...Object.entries(COMPARE_MODES).map(([value, v]) => ({
        value,
        label: v.label,
        delta: v.delta,
        requires_base: !!v.requires_base,
        compare_basis: v.range ? 'ytd' : 'period'
      }))
    ],
    // 区间（累计）模式：界面据此渲染"本年累计"开关。
    // **带 `applicable_basis`** —— 时点口径的报表没有累计，界面要能据此把开关**禁用**
    // 并说出原因，而不是让用户点了以后收到一个 409。
    range_modes: [
      { value: '', label: '仅本期', applicable_basis: ['balance', 'amount', 'cash_flow'] },
      ...Object.entries(RANGE_MODES).map(([value, v]) => ({ value, label: v.label, applicable_basis: ['amount', 'cash_flow'] }))
    ],
    default_cash_subjects: DEFAULT_CASH_SUBJECTS,
    // 会计年度边界（批次 U 之四 / ③-c）：界面要能说清"本年累计是从哪个月起算的"，
    // 以及"年结为什么不能用"（起始月非 1 时年结被明确拒绝 —— 见 assertNaturalFiscalYear）。
    fiscal: {
      start_month: fiscalStartMonth(db),
      start_label: fiscalStartMonth(db) === FISCAL_START_DEFAULT ? '1 月（自然年）' : `${fiscalStartMonth(db)} 月`,
      // 年结能不能做（起始月非 1 时不做 —— 这是**范围界**，不是缺陷；界面据此把入口禁用并说明）
      annual_supported: fiscalStartMonth(db) === FISCAL_START_DEFAULT
    },
    periods: availablePeriods(db)
  }
}

export default {
  balanceSheet,
  incomeStatement,
  cashFlow,
  operatingSummary,
  // 现金流量项目（批次 U）：字典 / 元数据 / 打标记
  listCashFlowItems,
  cashFlowItemMeta,
  tagVoucherCashFlow,
  cashFlowBuckets,
  auditReport,
  auditComparison,
  auditRange,
  auditMultiYear,
  compareReport,
  multiYearReport,
  multiYearPeriods,
  resolveCompareMode,
  isRangeCompareMode,
  resolveRange,
  // 会计年度起点（批次 U 之四 / ③-c）
  fiscalStartMonth,
  fiscalYearOf,
  assertNaturalFiscalYear,
  subjectRangeMovements,
  columnsOf,
  columnValue,
  exportReport,
  buildReportCSV,
  buildReportXlsx,
  reportFooterLines,
  EXPORT_FORMATS,
  subjectBalances,
  computeReport,
  meta
}
