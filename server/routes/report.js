/**
 * ============================================================================
 * 文件标识：server/routes/report.js ｜ 财务报表路由（批次 L · 模块 28）：资产负债表 / 利润表 / 现金流量表 + 期间 + 期初余额 + 经营分析
 * ============================================================================
 * 【职责】财务报表路由（批次 L · 模块 28）：资产负债表 / 利润表 / 现金流量表 + 期间 + 期初余额 + 经营分析
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 财务报表路由（批次 L · 模块 28）：资产负债表 / 利润表 / 现金流量表 + 期间 + 期初余额 + 经营分析
//
// 本文件只做三件事：**取参数、调 lib、翻译错误**。
// 所有判据都在 `lib/report.js`（报表口径计算、期间业务规则、期初平衡校验、域自证），
// 期间格式与过账闸门在 `lib/period.js`。
//
// 为什么"看报表"与"改报表口径"要分开授权（`finance.report.view` / `finance.report.config`）：
//   报表行定义决定"哪些科目算进哪一行"，改它能让**同一份账**得出不同的利润 ——
//   这是会计政策，不是展示配置。
// 为什么"期初余额"单独授权（`finance.opening.edit`）：
//   改一个期初数字会同时改变之后**每一期**的资产负债表，且改完仍然"看起来平"。
// 为什么"期间关账"单独授权（`finance.period.close`）：
//   关账会挡住记账；反关账会让已定稿的期间重新可变。
// 为什么"期末结转"再单独授权（`finance.period.carry`，批次 M）：
//   结转会**生成一张已过账凭证**（真的动账），而关账只是"把这一期封起来"。
//   让"能关账"的人自动获得"能动账"的能力是不对的 —— 这两个动作的后果不在一个量级。
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, wrap, failFromError } from '../lib/http.js'
import { requireAuth, requirePerm } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import * as R from '../lib/report.js'
import * as C from '../lib/closing.js'
import * as N from '../lib/annual.js'
import * as Q from '../lib/period-audit.js'
// 报表口径变更链（批次 S）。别名用 `RCA` 而不是 `N` / `C` —— 那两个已被
// `annual.js` 与 `closing.js` 占用，重名会让"这一句到底调的是谁"变成要靠上下文猜的事。
import * as RCA from '../lib/report-config-audit.js'

const r = Router()

function guard(fn) {
  return wrap((req, res, next) => {
    try {
      return fn(req, res, next)
    } catch (e) {
      if (failFromError(res, e)) return undefined
      throw e
    }
  })
}

const view = [requireAuth, requirePerm('finance.report.view')]
// 现金流量项目（批次 U）单独授权：打标记会改变现金流量表**每一行**的金额。
// 它与"改报表口径"（`finance.report.config`）不是一件事 —— 口径是会计政策（偶尔改），
// 打标记是日常动作（每张涉现金的凭证都要做）。合成一个权限点只会让日常动作没人有权做。
const itemView = [requireAuth, requirePerm('finance.cashflow.item.view')]

// ===========================================================================
// 一、字典
// ===========================================================================
r.get('/meta', ...view, guard((_req, res) => ok(res, R.meta(getDb()))))

// ---------------------------------------------------------------------------
// 一之二、现金流量项目：字典 + 给一张凭证的分录打标记（批次 U）
// ---------------------------------------------------------------------------
// ⚠️ 路径顺序：这几条都是**字面段**，必须排在文件末尾的 `/:code` 之前 ——
//    否则 `/:code` 会把 `cashflow-items` 当成一个报表代码吃掉（批次 L 的前车之鉴，
//    `scripts/check-route-order.mjs` 常驻守着这条）。
r.get('/cashflow-items', ...itemView, guard((req, res) => ok(res, {
  rows: R.listCashFlowItems(getDb(), {
    category: req.query.category || null,
    status: req.query.status || null,
    keyword: req.query.keyword || null
  })
})))

r.get('/cashflow-items/meta', ...itemView, guard((_req, res) => ok(res, R.cashFlowItemMeta(getDb()))))

// 打 / 改 / 清一张凭证上若干分录的现金流量项目标记。
// `reason` 只在**改动已经标过的分录**时才被要求（判据在 `lib/report.js`，路由不判断）——
// 危险是差分驱动的：在空白分录上第一次标是日常动作，把一笔已定性的钱改到别的项目上才是。
r.post('/vouchers/:id/tag-cashflow', requireAuth, requirePerm('finance.cashflow.item.edit'), guard((req, res) => {
  const out = R.tagVoucherCashFlow(getDb(), {
    voucherId: req.params.id,
    entries: req.body?.entries || [],
    reason: req.body?.reason ?? null,
    actor: actorOf(req)
  })
  // 留痕走 `audit_logs`（唯一的写入点在 `middleware/audit.js`）。
  // 形状用**主要的那个**（`entity` / `entityId`）—— 项目里 174 处这么写、16 处写的是
  // 早年的 `target`，而 `audit()` 根本不认 `target`：写它等于**什么都没留下**
  // （实测过：action 记下了，entity/entity_id 是空的，凭这条日志找不到是哪张凭证）。
  audit(req, {
    action: 'finance.cashflow.tag',
    module: 'finance',
    entity: 'voucher',
    entityId: out.voucher_id,
    detail: JSON.stringify({ doc_no: out.doc_no, period: out.period, changed: out.changed, reason: out.reason ?? null })
  })
  ok(res, out)
}))

// ===========================================================================
// 二、报表定义与报表口径（会计政策）
// ===========================================================================
r.get('/defs', ...view, guard((_req, res) => ok(res, { rows: R.listReportDefs(getDb()) })))

r.get('/defs/:code/lines', ...view, guard((req, res) => ok(res, { rows: R.listReportLines(getDb(), req.params.code) })))

// 三个写接口（批次 S 起）：`reason` 与 `actor` 一路传到 `report_config_audit_log`。
// **原来那句通用 `audit(req, …)` 在这里删掉了** —— 它只记 `line_no`（保存）
// 或一个自增 id（删除），既答不出"改前是什么"也答不出"删掉的是什么"。
// 现在每一次改动都由 `lib/report.js` 的三个写入点**同事务**写一条带整行快照的记录，
// 而那条记录里已经有 actor —— 通用审计在这里只是同一件事的第二份、且更差的说法。
r.put('/defs/:code', requireAuth, requirePerm('finance.report.config'), guard((req, res) => {
  const { reason, ...payload } = req.body || {}
  ok(res, R.saveReportDef(getDb(), { ...payload, report_code: req.params.code }, { reason, actor: actorOf(req) }))
}))

r.post('/lines', requireAuth, requirePerm('finance.report.config'), guard((req, res) => {
  const { reason, ...payload } = req.body || {}
  ok(res, R.saveReportLine(getDb(), payload, { reason, actor: actorOf(req) }))
}))

r.delete('/lines/:id', requireAuth, requirePerm('finance.report.config'), guard((req, res) => {
  ok(res, R.deleteReportLine(getDb(), req.params.id, { reason: req.body?.reason ?? req.query.reason, actor: actorOf(req) }))
}))

// ---------------------------------------------------------------------------
// 报表口径变更历史与自证（批次 S）
// ---------------------------------------------------------------------------
// 读权限复用 `finance.report.view`：能看报表的人已经能看到口径本身
// （`GET /reports/defs/{code}/lines`），日志给的是同一个信息集合的**历史**，
// 不是新的信息类别 —— 与 `GET /periods/audit` 同一条理由。
r.get('/config/audit', ...view, guard((req, res) => ok(res, RCA.listReportConfigAudit(getDb(), {
  targetType: req.query.target_type || null,
  reportCode: req.query.report_code || null,
  action: req.query.action || null,
  dangerOnly: req.query.danger_only === '1' || req.query.danger_only === 'true',
  limit: req.query.limit || 200
}))))

// 口径的定义表（界面据此渲染字段与危险标记；也是"哪些字段危险"的唯一出处）
r.get('/config/meta', ...view, guard((_req, res) => ok(res, RCA.meta(getDb()))))

// 口径变更链自证（与 `/periods/audit/check` 同形）。
// **纯只读**：这里刻意**不**调 `ensureReportConfigTrail` ——
// 在一个"检查"里写库，会让"基线没补上"这件事被检查本身掩盖掉
// （检查先把它补上，然后报告一切正常）。初始化只在两处：
// `bootIndustry`（每次启动 / 切行业）与 `seedReport`（口径刚写完那一刻）。
// 与 `auditReport` 第 ⑫ 条同一条口径。这里**能**报出 `REPORT_CONFIG_UNTRACKED`，
// 那正是它该做的事 —— 把"没补基线"如实说出来，而不是顺手抹平。
r.get('/config/audit/check', ...view, guard((_req, res) => ok(res, RCA.auditReportConfigTrail(getDb()))))

// ===========================================================================
// 三、会计期间（关账 / 反关账）
// ===========================================================================
r.get('/periods', ...view, guard((_req, res) => ok(res, { rows: R.listPeriods(getDb()) })))

// 期间变更历史（批次 Q）。**只读**，复用 `finance.report.view`，不新增权限点：
// 能看 `/periods` 的人已经看到 `closed_by_name` / `reopen_reason` / `closing_reverse_reason`，
// 日志给的是同一个信息集合的**历史**，不是新的信息类别。
r.get('/periods/audit', ...view, guard((req, res) => ok(res, Q.listPeriodAudit(getDb(), {
  period: req.query.period || null,
  year: req.query.year || null,
  action: req.query.action || null,
  limit: req.query.limit || 200
}))))

// 审计链自证：重放日志必须等于期间表现状，且每条派生凭证都要有来源。
// 与 `/audit`（这一期的账自洽吗）分开：它回答的是"这段历史解释得通吗"，失效原因不同。
r.get('/periods/audit/check', ...view, guard((_req, res) => ok(res, Q.auditPeriodTrail(getDb()))))

r.post('/periods/:period/close', requireAuth, requirePerm('finance.period.close'), guard((req, res) => {
  const out = R.closePeriod(getDb(), { period: req.params.period, actor: actorOf(req), remark: req.body?.remark })
  audit(req, { action: 'finance.period.close', target: `period:${out.period}`, detail: { replayed: out.replayed } })
  ok(res, out)
}))

r.post('/periods/:period/reopen', requireAuth, requirePerm('finance.period.close'), guard((req, res) => {
  const out = R.reopenPeriod(getDb(), { period: req.params.period, actor: actorOf(req), reason: req.body?.reason })
  audit(req, { action: 'finance.period.reopen', target: `period:${out.period}`, detail: { reason: req.body?.reason || null } })
  ok(res, out)
}))

// ===========================================================================
// 三之二、期末结转（批次 M）
// ===========================================================================
// **只读的结转状态**：结转会给界面一个"该不该结转、结转多少"的回答，
// 而它同时是关账前置检查的同一份判据（`lib/closing.js` 的 `closingStatus`）。
r.get('/closing/:period', ...view, guard((req, res) => ok(res, C.closingStatus(getDb(), { period: req.params.period }))))

// 结转：生成一张**已过账**的损益结转账（借各损益科目 / 贷本年利润）
r.post('/periods/:period/carry-forward', requireAuth, requirePerm('finance.period.carry'), guard((req, res) => {
  const out = C.carryForward(getDb(), { period: req.params.period, actor: actorOf(req), remark: req.body?.remark })
  audit(req, {
    action: 'finance.period.carry_forward',
    target: `period:${out.period}`,
    detail: {
      replayed: out.replayed,
      voucher: out.voucher?.doc_no ?? null,
      carry_profit: out.plan?.carry_profit ?? null,
      target_subject: out.plan?.target?.code ?? null
    }
  })
  ok(res, out)
}))

// 撤销结转：删掉本期的结转凭证（**必须写理由**，见 `lib/closing.js` 的注释四）
r.post('/periods/:period/reverse-closing', requireAuth, requirePerm('finance.period.carry'), guard((req, res) => {
  const out = C.reverseClosing(getDb(), { period: req.params.period, actor: actorOf(req), reason: req.body?.reason })
  audit(req, {
    action: 'finance.period.reverse_closing',
    target: `period:${out.period}`,
    detail: { replayed: out.replayed, removed_voucher: out.removed?.doc_no ?? null, reason: out.reason ?? null }
  })
  ok(res, out)
}))

// ===========================================================================
// 三之三、年度结转与利润分配（批次 O）
// ===========================================================================
// 为什么年结与月结**分开授权**（`finance.annual.close`）：
//   月结影响**一期**，年结**封整年**并改变次年的期初余额。让"能月结"的人自动获得
//   "封整年"的能力是不对的 —— 与"关账（一期）vs 结转（动账）分开授权"同源。
//
// ⚠️ 路径顺序：`/annual` 是**单段**，必须排在文件末尾的 `/:code` **之前**，
//    否则它会被 `/:code` 当成"报表代码 annual"吃掉（这一条是批次 L 留下的前车之鉴）。
r.get('/annual', ...view, guard((_req, res) => ok(res, { rows: N.listAnnual(getDb()) })))

// 单年详情：含**前置检查的完整回答**（还要做什么才能年结）与"将要结转多少"的预览。
r.get('/annual/:year', ...view, guard((req, res) => ok(res, N.planAnnual(getDb(), { year: req.params.year }))))

// 分配状态：可分配余额、是否已分配、**能不能分配**（唯一回答，界面不自己拼判断）。
r.get('/annual/:year/distribution', ...view, guard((req, res) => ok(res, N.distributionStatus(getDb(), { year: req.params.year }))))

r.post('/annual/:year/carry-forward', requireAuth, requirePerm('finance.annual.close'), guard((req, res) => {
  const out = N.carryForwardAnnual(getDb(), { year: req.params.year, actor: actorOf(req), remark: req.body?.remark })
  audit(req, {
    action: 'finance.annual.carry_forward',
    target: `year:${out.year}`,
    detail: {
      replayed: out.replayed,
      voucher: out.voucher?.doc_no ?? null,
      carry_profit: out.plan?.carry_profit ?? null,
      closed_periods: out.closed_periods ?? 0
    }
  })
  ok(res, out)
}))

// 撤销年结：**必须先撤销利润分配**，且次年不能有已关账的期间（撤销会改次年期初）。
r.post('/annual/:year/reverse-closing', requireAuth, requirePerm('finance.annual.close'), guard((req, res) => {
  const out = N.reverseAnnual(getDb(), { year: req.params.year, actor: actorOf(req), reason: req.body?.reason })
  audit(req, {
    action: 'finance.annual.reverse_closing',
    target: `year:${out.year}`,
    detail: { replayed: out.replayed, removed_voucher: out.removed?.doc_no ?? null, reason: out.reason ?? null }
  })
  ok(res, out)
}))

// 利润分配：**金额必须由人给**（这是决议，不是算法）。一次调用 = 一张凭证 = 一年一次。
r.post('/annual/:year/distribute', requireAuth, requirePerm('finance.annual.close'), guard((req, res) => {
  const out = N.distributeProfit(getDb(), {
    year: req.params.year,
    items: req.body?.items || [],
    actor: actorOf(req),
    remark: req.body?.remark
  })
  audit(req, {
    action: 'finance.annual.distribute',
    target: `year:${out.year}`,
    detail: { replayed: out.replayed, voucher: out.voucher?.doc_no ?? null, total: out.total ?? null }
  })
  ok(res, out)
}))

r.post('/annual/:year/reverse-distribution', requireAuth, requirePerm('finance.annual.close'), guard((req, res) => {
  const out = N.reverseDistribution(getDb(), { year: req.params.year, actor: actorOf(req), reason: req.body?.reason })
  audit(req, {
    action: 'finance.annual.reverse_distribution',
    target: `year:${out.year}`,
    detail: { replayed: out.replayed, removed_voucher: out.removed?.doc_no ?? null, reason: out.reason ?? null }
  })
  ok(res, out)
}))

// ===========================================================================
// 四、期初余额
// ===========================================================================
r.get('/opening', ...view, guard((req, res) => ok(res, R.listOpeningBalances(getDb(), { period: req.query.period }))))

r.put('/opening', requireAuth, requirePerm('finance.opening.edit'), guard((req, res) => {
  const out = R.setOpeningBalances(getDb(), {
    period: req.body?.period,
    rows: req.body?.rows || [],
    actor: actorOf(req),
    remark: req.body?.remark
  })
  audit(req, { action: 'finance.opening.save', target: `opening:${out.period}`, detail: { rows: out.rows.length, total_debit: out.total_debit } })
  ok(res, out)
}))

// ===========================================================================
// 五、科目余额表（三张报表的**同一个**取数口，单独暴露便于核对）
// ===========================================================================
r.get('/subject-balances', ...view, guard((req, res) => ok(res, R.subjectBalances(getDb(), { period: req.query.period }))))

// ===========================================================================
// 六、经营分析（账上 vs 业务，差异如实展示）
// ===========================================================================
r.get('/operating', ...view, guard((req, res) => ok(res, R.operatingSummary(getDb(), { period: req.query.period }))))

// ===========================================================================
// 七、域自证
// ===========================================================================
r.get('/audit', ...view, guard((req, res) => ok(res, R.auditReport(getDb(), { period: req.query.period }))))

// ===========================================================================
// 七之二、跨期比较与导出（批次 N）
// ===========================================================================
// 比较与导出都是**只读**动作，所以复用 `finance.report.view`，**不新增权限点**：
// 导出与查看能拿到的信息完全相同，凭空多一个"导出权限"只会让权限表越来越长
// 而没人真的去维护它（权限通胀会让真正的授权边界被淹没）。
//
// 路径是两段（`/:code/compare`、`/:code/export`），与下面的 `/:code` 不冲突 ——
// 但仍排在它前面：`/:code` 那一条带着"它会吃掉所有单段路径"的前车之鉴（见文件末注释）。
r.get('/:code/compare', ...view, guard((req, res) => ok(res, R.compareReport(getDb(), {
  reportCode: req.params.code,
  period: req.query.period,
  mode: req.query.mode || 'previous',
  // 自定义基期（批次 P）：只有 `mode=custom` 时才有意义；
  // 校验（必须给、必须早于本期）在 `resolveCompareMode` 里，路由不做判断。
  basePeriod: req.query.base_period || null,
  range: req.query.range || null // 传了就是"累计的比较"，`compareReport` 会明确拒绝
}))))

// 自证：比较的两列必须等于"单独打开那一期"，差额必须等于两列相减。
// 独立成一个端点而不是塞进 `/audit`：`/audit` 回答"这一期的账自洽吗"，
// 而这是"这个比较结果可信吗"，两者的失效原因不同。
r.get('/:code/compare/audit', ...view, guard((req, res) => ok(res, R.auditComparison(getDb(), {
  reportCode: req.params.code,
  period: req.query.period,
  mode: req.query.mode || 'previous',
  basePeriod: req.query.base_period || null
}))))

// 自证：本年累计的起点必须是本年 1 月、终点必须就是本期，且**逐行等于"逐月各算一次再相加"**
// （两条独立路径互证）。与比较自证分开，理由同上：失效原因不同。
r.get('/:code/range/audit', ...view, guard((req, res) => ok(res, R.auditRange(getDb(), {
  reportCode: req.params.code,
  period: req.query.period,
  range: req.query.range || 'ytd'
}))))

// ---------------------------------------------------------------------------
// 七之三、同期多年对比（批次 U 之四 / ④）：跨年度报表
// ---------------------------------------------------------------------------
// ⚠️ 路径是两段（`/:code/multi-year`），与上面的 `/:code/compare` 同族 ——
//    仍必须排在 `/:code` 之前：那一条带着"它会吃掉所有单段路径"的前车之鉴。
r.get('/:code/multi-year', ...view, guard((req, res) => ok(res, R.multiYearReport(getDb(), {
  reportCode: req.params.code,
  period: req.query.period,
  // 不传 = 3 列（本期 + 往前两年）；取值范围与校验在 lib（2~5，越界给 MULTI_YEAR_COUNT）
  years: req.query.years ?? 3
}))))

// 自证：每一列必须等于"单独打开那一期"，期间序列必须就是往前 12 个月的整数倍。
r.get('/:code/multi-year/audit', ...view, guard((req, res) => ok(res, R.auditMultiYear(getDb(), {
  reportCode: req.params.code,
  period: req.query.period,
  years: req.query.years ?? 3
}))))

// 导出**不走 `ok()`**：它返回的是文件（text/csv），不是 JSON 包装。
r.get('/:code/export', ...view, guard((req, res) => {
  const out = R.exportReport(getDb(), {
    reportCode: req.params.code,
    period: req.query.period,
    mode: req.query.mode || null, // 不传 mode = 导出单期
    range: req.query.range || null, // 传 `ytd` = 导出带"本年累计"列
    basePeriod: req.query.base_period || null,
    // 同期多年对比（批次 U 之四 / ④）：传了它就只有它（与 mode / range 互斥，lib 里拦）
    years: req.query.years || null,
    // 不传 = csv（**既有行为逐字节不变**）；`xlsx` 走同一份 result / 同一份列定义
    format: req.query.format || 'csv'
  })
  // 双份文件名：`filename*`（RFC 5987）让现代浏览器显示中文名，老浏览器退回 ASCII 名。
  // 只写中文名 → 老浏览器文件名乱码；只写 ASCII 名 → 用户认不出这是哪张表。
  res.setHeader('Content-Type', out.mime)
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${out.filename}"; filename*=UTF-8''${encodeURIComponent(out.filename_utf8)}`
  )
  res.setHeader('X-Report-Code', out.report_code)
  res.setHeader('X-Report-Period', out.period)
  res.setHeader('X-Report-Format', out.format)
  if (out.base_period) res.setHeader('X-Report-Base-Period', out.base_period)
  if (out.range_from) res.setHeader('X-Report-Range', `${out.range_from}~${out.range_to}`)
  // 工作表名被降级过就**说出来**（报表名是人可以改成非法的，那时导出不该整个失败，
  // 但"文件里的工作表叫什么"必须能被调用方知道，不能靠打开文件去发现）
  if (out.sheet_name) {
    res.setHeader('X-Report-Sheet', encodeURIComponent(out.sheet_name))
    if (out.sheet_name_fallback) res.setHeader('X-Report-Sheet-Fallback', '1')
  }
  res.send(out.content)
}))

// ===========================================================================
// 八、三张报表（`/:code` **必须放在最后**，否则它会吃掉上面所有单段路径）
// ===========================================================================
r.get('/:code', ...view, guard((req, res) => ok(res, R.computeReport(getDb(), {
  reportCode: req.params.code,
  period: req.query.period,
  // 传 `range=ytd` = 同一张表多一列"本年累计"（时点口径会 409，见 `computeReport`）
  range: req.query.range || null
}))))

function actorOf(req) {
  return {
    id: req.user?.uid ?? null,
    name: req.user?.name || req.user?.username || null,
    source: 'web'
  }
}

export default r
