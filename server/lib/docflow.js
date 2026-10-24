/**
 * ============================================================================
 * 文件标识：server/lib/docflow.js ｜ 单据内核：状态机驱动的统一流转入口
 * ============================================================================
 * 【职责】单据内核：状态机驱动的统一流转入口
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 单据内核：状态机驱动的统一流转入口
//
// 解决的问题：以前每个路由自己写流转判断
//   （purchase.js: { submit:['draft','submitted'], approve:['submitted','approved'] ... }）
//   非法流转靠各处 if 拦，漏一处就写坏数据，且事后查不到谁改的。
//
// 现在的约定：
//   合法状态与合法流转是**数据**（doc_states / doc_actions），不是散落的 if。
//   所有状态变更走 applyTransition()，它做三件事：
//     ① 校验这条边是否存在（不存在直接拒绝，附带当前可做的动作）
//     ② 更新业务表的状态字段
//     ③ 写一条 doc_events 留痕（谁、何时、从哪到哪、什么动作）
//   三件事在同一个事务里，要么全成要么全不成。
//
// 未迁移的老代码仍可直接 UPDATE status —— 内核不强制，但新代码一律不再手写流转。

import { getDb } from '../db/index.js'
// 流转留痕的时间一律本地口径 —— 本模块下面的注释一直写着「替代 SQL 里的
// datetime('now','localtime')」，但实现用的是 toISOString()（**UTC**），
// 于是 doc_events.created_at 比库里其它 datetime('now','localtime') 早 8 小时：
// 界面上「流转时间」与「单据时间」对不上，跨零点时甚至差一天。
import { localNow } from './dates.js'
import { docScopeBuilder } from './doc-scope-registry.js'
import { boundStoreId, storeBindingExempt } from './store-binding.js'

export class DocFlowError extends Error {
  constructor(message, { code = 'DOC_FLOW_ERROR', httpStatus = 400, detail = null } = {}) {
    super(message)
    this.name = 'DocFlowError'
    this.code = code
    this.httpStatus = httpStatus
    // 全局错误中间件读的是 err.status，这里一并给出，保证抛出后能返回 409/404 而不是 500
    this.status = httpStatus
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// 单据类型 → 创建权限码（ADR-0028）：唯一映射表
// ---------------------------------------------------------------------------
//
// 用途：`POST /api/docflow/no-issue`（真实取号会消耗序号）按单据类型要求"能创建这类单据"的权限。
// 取值口径：与该类型在 HTTP 侧**创建路由**挂的权限码一致；该类型的创建路由用角色闸门（`requireRole`）时，
//   取与它同域的状态机首条出边 / 编辑权限码（写在每行注释里）。表里没有的类型 = 未映射 ⇒ 调用方必须拒绝
//   （`DOC_TYPE_PERM_UNMAPPED`），新增 doc_types 时 `tests/authz-misc.test.mjs` 会因缺映射而变红。
export const DOC_CREATE_PERMS = Object.freeze({
  // 采购
  PO: 'purchase.order.edit', GR: 'purchase.inbound', PRT: 'purchase.return', PRQ: 'purchase.req.edit',
  PI: 'purchase.invoice.edit', PST: 'purchase.settle.edit', PAY: 'purchase.payment.edit', INS: 'quality.inspect.edit',
  // 销售
  QT: 'sales.quote.edit', SO: 'sales.order.edit', DL: 'sales.outbound', SR: 'sales.return', SI: 'sales.invoice.edit',
  // 质检
  QCR: 'quality.request.create', QCI: 'quality.inspect', DH: 'quality.handle.approve',
  // 库存与成本
  TF: 'inventory.transfer', CK: 'inventory.check', AS: 'inventory.adjust', CA: 'cost.adjust',
  // 财务
  AR: 'finance.receipt.edit', RCP: 'finance.receipt.edit', VOUCHER: 'finance.voucher.gen', RFD: 'finance.refund.edit',
  // 门店要货 / 发货 / POS
  YQ: 'pos.store.requisition', SH: 'sales.outbound', // SH：总部发货，创建路由是仓管 / 销售 / 供应链角色，不是门店（状态机边的权限码是门店收货口径）
   PS: 'pos.cashier', PSF: 'pos.shift', RC: 'pos.dailyclose',
  // 生产与委外
  MO: 'produce.order.edit', WW: 'produce.order.edit', WM: 'produce.issue', WR: 'produce.receipt', MR: 'produce.issue',
  // 电商 / 经销商 / 订货中心
  OM: 'oms.order.route', DR: 'order.place', DS: 'finance.settle.edit', RB: 'finance.settle.edit',
  OC: 'order.place', OCS: 'order.statement.view'
})

/** 单据类型的创建权限码；未映射（含未注册 / 原型链键）⇒ null，调用方必须按"拒绝"处理。 */
export function createPermOf(docType) {
  return typeof docType === 'string' && Object.prototype.hasOwnProperty.call(DOC_CREATE_PERMS, docType)
    ? DOC_CREATE_PERMS[docType]
    : null
}

// ---------------------------------------------------------------------------
// 单据 → 数据范围谓词的分发表（ADR-0032）
// ---------------------------------------------------------------------------
//
// 用途：`/api/docflow` 的 `/events`、`/overview`、`/history`、`/trace` 读的是**跨所有单据类型**的流转留痕。
// 留痕行只有 (doc_type, doc_id)，没有统一的组织归属，所以"这条事件该不该给这个账号看"必须回到
// 它指向的**单据本身**，用该单据所属领域已有的范围谓词判定（判据只在各领域库有一份，这里只做分发）。
//
// 每个已注册 doc_types.code 必须在此有一行（缺项 ⇒ 对受限范围不可见，并被 tests/docflow-scope.test.mjs 报红）：
//   builder   谓词构建器名：purchase / sales / order-center 由各领域库经 doc-scope-registry 登记
//             （避免与它们循环依赖）；org / warehouse / store / dealer 是本文件内的通用"归属组织"构建器；
//             'global' ⇒ 该类单据（主数据 / 财务总账类）没有可按组织切的归属，只有全局范围（admin 或 data_scope=all）可见。
//   table     主表名（必须等于 doc_types.table_name，测试校验）。
//   cols      通用构建器用的归属列；'warehouse' 多列表示"任一仓在范围内即可见"（调拨）。
//   via / kind 传给领域构建器的形状参数（采购 org|wh；销售 order|delivery|return）。
// 谓词都写在别名 `t`（单据主表）上，调用方包成 `doc_id IN (SELECT t.id FROM <table> t WHERE <pred>)`。
// 归属为 NULL 的单据对受限范围不可见；空 / 非法范围一律失败关闭。Y12（审批实例范围）将复用本表。
export const DOC_SCOPE_RESOLVERS = Object.freeze({
  // 采购（purchaseScopeSql，ADR-0017/0020）
  PRQ: { builder: 'purchase', table: 'purchase_requisitions', via: 'org' },
  PI: { builder: 'purchase', table: 'purchase_invoices', via: 'org' },
  PST: { builder: 'purchase', table: 'purchase_settlements', via: 'org' },
  PAY: { builder: 'purchase', table: 'purchase_payments', via: 'org' },
  PO: { builder: 'purchase', table: 'purchase_orders', via: 'wh' },
  GR: { builder: 'purchase', table: 'purchase_receipts', via: 'wh' },
  PRT: { builder: 'purchase', table: 'purchase_returns', via: 'wh' },
  INS: { builder: 'purchase', table: 'purchase_inspections', via: 'wh' },
  // 销售（salesScopeSql，ADR-0026）：报价与订单同形（仓 / 门店归属）
  QT: { builder: 'sales', table: 'sales_quotes', kind: 'order' },
  SO: { builder: 'sales', table: 'sales_orders', kind: 'order' },
  DL: { builder: 'sales', table: 'sales_deliveries', kind: 'delivery' },
  SR: { builder: 'sales', table: 'sales_returns', kind: 'return' },
  SI: { builder: 'org', table: 'sales_invoices', cols: ['org_id'] },
  // 订货中心（ocScope，ADR-0027）：按客户归属组织
  OC: { builder: 'order-center', table: 'oc_orders' },
  OCS: { builder: 'order-center', table: 'oc_statements' },
  // POS / 门店（门店归属组织；账号绑了门店则只限该门店，ADR-0025）
  PS: { builder: 'store', table: 'pos_orders', cols: ['store_id'] },
  PSF: { builder: 'store', table: 'pos_shifts', cols: ['store_id'] },
  RC: { builder: 'store', table: 'pos_daily_closes', cols: ['store_id'], binding: 'store' },
  YQ: { builder: 'store', table: 'store_requisitions', cols: ['store_id'], binding: 'store' },
  SH: { builder: 'store', table: 'store_shipments', cols: ['store_id'], binding: 'store' },
  // 经销商往来（经销商档案 dealers.org_id）
  DR: { builder: 'dealer', table: 'dealer_requisitions', cols: ['dealer_id'] },
  DS: { builder: 'dealer', table: 'dealer_statements', cols: ['dealer_id'] },
  RB: { builder: 'dealer', table: 'dealer_rebates', cols: ['dealer_id'] },
  // 库存 / 生产 / 委外 / 质检：仓库归属组织（warehouses.org_id）
  TF: { builder: 'warehouse', table: 'stock_transfers', cols: ['from_warehouse_id', 'to_warehouse_id'] },
  CK: { builder: 'warehouse', table: 'stock_checks', cols: ['warehouse_id'] },
  AS: { builder: 'warehouse', table: 'assembly_orders', cols: ['warehouse_id'] },
  MO: { builder: 'warehouse', table: 'production_orders', cols: ['warehouse_id'] },
  MR: { builder: 'warehouse', table: 'material_issues', cols: ['warehouse_id'] },
  WW: { builder: 'warehouse', table: 'outsourcing_orders', cols: ['warehouse_id'] },
  WM: { builder: 'warehouse', table: 'outsourcing_materials', cols: ['warehouse_id'] },
  WR: { builder: 'warehouse', table: 'outsourcing_receipts', cols: ['warehouse_id'] },
  QCR: { builder: 'org', table: 'qc_requests', cols: ['org_id'] },
  QCI: { builder: 'warehouse', table: 'qc_inspections', cols: ['warehouse_id'] },
  DH: { builder: 'warehouse', table: 'qc_defect_handlings', cols: ['warehouse_id'] },
  // 无组织归属 ⇒ 仅全局范围：财务总账 / 应收 / 收款 / 退款 / 成本调整 / 电商订单
  AR: { builder: 'global', table: 'ar_documents' },
  RCP: { builder: 'global', table: 'receipts' },
  VOUCHER: { builder: 'global', table: 'vouchers' },
  RFD: { builder: 'global', table: 'refunds' },
  CA: { builder: 'global', table: 'cost_adjustments' },
  OM: { builder: 'global', table: 'oms_orders' }
})

const idList = (orgScope) =>
  orgScope && Array.isArray(orgScope.orgIds) && orgScope.scope !== 'dealer' && orgScope.scope !== 'none'
    ? orgScope.orgIds.map(Number).filter(Number.isFinite)
    : []

/** 通用"归属组织"构建器：列直接带 org_id / 经仓库 / 门店 / 经销商档案的 org_id 取归属。 */
const GENERIC_BUILDERS = {
  org: (ids, spec) => ({ sql: `(${spec.cols.map((c) => `t.${c} IN (${ids.map(() => '?').join(',')})`).join(' OR ')})`, params: spec.cols.flatMap(() => ids) }),
  warehouse: (ids, spec) => ({
    sql: `(${spec.cols.map((c) => `t.${c} IN (SELECT id FROM warehouses WHERE org_id IN (${ids.map(() => '?').join(',')}))`).join(' OR ')})`,
    params: spec.cols.flatMap(() => ids)
  }),
  store: (ids, spec, ctx) => {
    const base = `t.${spec.cols[0]} IN (SELECT id FROM stores WHERE org_id IN (${ids.map(() => '?').join(',')}))`
    // 绑了门店的内部账号（自定义角色）只限本店，与 POS 路由的门店绑定一致（ADR-0025）
    const bound = boundStoreId(ctx.user)
    return bound != null
      ? { sql: `(${base} AND t.${spec.cols[0]} = ?)`, params: [...ids, bound] }
      : { sql: base, params: ids }
  },
  dealer: (ids, spec) => ({ sql: `t.${spec.cols[0]} IN (SELECT id FROM dealers WHERE org_id IN (${ids.map(() => '?').join(',')}))`, params: ids })
}

/**
 * 某账号在某单据类型上的范围。
 *   ctx = { db, user, orgScope }（orgScope 即 `req.orgScope`，缺省按"无范围"失败关闭）
 *   返回：`{ all: true }`（全局范围，不加过滤）| `{ sql, params }`（对别名 t 的谓词）| `null`（该类单据对该账号完全不可见）
 * 未登记的类型：全局范围可见（admin 不被工程缺口挡住），受限范围不可见（失败关闭）。
 */
export function docScopeOf(ctx, docType) {
  const spec = typeof docType === 'string' && Object.prototype.hasOwnProperty.call(DOC_SCOPE_RESOLVERS, docType) ? DOC_SCOPE_RESOLVERS[docType] : null
  // AB7：带 `binding: 'store'` 的类型（RC / YQ / SH）在任何数据范围（含 all）下都先过门店绑定闸
  if (spec && spec.binding === 'store' && ctx && ctx.user && !storeBindingExempt(ctx.user)) {
    const sid = boundStoreId(ctx.user)
    if (sid == null) {
      // 未绑门店：HTTP 路由按角色名放行总部角色（保持）；严格模式（MCP）一律不可见
      if (ctx.strictBinding) return null
    } else if (ctx.orgScope && ctx.orgScope.scope === 'all') {
      return { sql: `t.${spec.cols[0]} = ?`, params: [sid] }
    }
  }
  if (ctx && ctx.orgScope && ctx.orgScope.scope === 'all') return { all: true }
  if (!spec || spec.builder === 'global') return null
  const orgScope = ctx ? ctx.orgScope : null
  const full = { ...ctx, orgScope }
  const generic = GENERIC_BUILDERS[spec.builder]
  if (generic) {
    const ids = idList(orgScope)
    return ids.length ? generic(ids, spec, full) : null
  }
  const build = docScopeBuilder(spec.builder)
  if (!build) return null
  const out = build(full, spec)
  return out && out.sql && out.sql !== '1=0' ? out : null
}

/**
 * doc_events 的范围谓词（对别名 `alias` 的事件行）。全局范围 ⇒ `1=1`；
 * 受限范围 ⇒ 每个可见类型一段 `(doc_type=? AND doc_id IN (SELECT t.id FROM <表> t WHERE <谓词>))` 的并集；
 * 没有任何可见类型 ⇒ `1=0`。事件的 doc_id 为 NULL 或指向已不存在的单据，对受限范围不可见。
 */
export function docEventScope(ctx, alias = 'e') {
  const allScope = !!(ctx && ctx.orgScope && ctx.orgScope.scope === 'all')
  const parts = []
  const params = []
  const narrowed = [] // 全局范围下被绑定收窄的类型（只有 allScope 用到）
  for (const [code, spec] of Object.entries(DOC_SCOPE_RESOLVERS)) {
    const p = docScopeOf(ctx, code)
    if (allScope && !(p && p.all)) narrowed.push(code)
    if (!p || p.all) continue
    parts.push(`(${alias}.doc_type=? AND ${alias}.doc_id IN (SELECT t.id FROM ${spec.table} t WHERE ${p.sql}))`)
    params.push(code, ...p.params)
  }
  // 全局范围且没有任何类型被绑定收窄 ⇒ 原来的无过滤；有收窄（AB7：绑了门店的非 admin 账号）⇒ 其余类型整类放行
  if (allScope && !narrowed.length) return { all: true, sql: '1=1', params: [] }
  if (allScope) {
    parts.push(`(${alias}.doc_type NOT IN (${narrowed.map(() => '?').join(',')}))`)
    params.push(...narrowed)
  }
  return parts.length ? { all: false, sql: `(${parts.join(' OR ')})`, params } : { all: false, sql: '1=0', params: [] }
}

/** 单据是否在范围内（详情类读取用）：范围外与不存在同形。 */
export function docInScope(ctx, docType, id) {
  const p = docScopeOf(ctx, docType)
  if (!p) return false
  if (p.all) return true
  const spec = DOC_SCOPE_RESOLVERS[docType]
  if (!Number.isFinite(Number(id))) return false
  return !!ctx.db.prepare(`SELECT 1 FROM ${spec.table} t WHERE t.id=? AND ${p.sql}`).get(Number(id), ...p.params)
}

/** doc_types 里已注册、但 DOC_SCOPE_RESOLVERS 缺项的类型（守卫用；非空 ⇒ 这些类型对受限范围不可见）。 */
export function unmappedScopeDocTypes(db = getDb()) {
  return db.prepare('SELECT code FROM doc_types').all().map((r) => r.code).filter((c) => !Object.prototype.hasOwnProperty.call(DOC_SCOPE_RESOLVERS, c))
}

// ---------------------------------------------------------------------------
// 读取定义
// ---------------------------------------------------------------------------

/** 单据类型列表（可带模块过滤） */
export function listDocTypes(db = getDb(), { module } = {}) {
  const sql = module
    ? 'SELECT * FROM doc_types WHERE status=\'active\' AND module=? ORDER BY sort_order'
    : 'SELECT * FROM doc_types WHERE status=\'active\' ORDER BY sort_order'
  const rows = module ? db.prepare(sql).all(module) : db.prepare(sql).all()
  return rows.map((t) => ({ ...t, stateCount: countStates(db, t.code) }))
}

/** 按类型码或表名取单据类型定义 */
export function getDocType(db = getDb(), codeOrTable) {
  const t = db
    .prepare('SELECT * FROM doc_types WHERE code=? OR table_name=?')
    .get(codeOrTable, codeOrTable)
  if (!t) {
    throw new DocFlowError(`未注册的单据类型：${codeOrTable}`, {
      code: 'DOC_TYPE_UNKNOWN',
      httpStatus: 404
    })
  }
  return t
}

function countStates(db, docType) {
  return db.prepare('SELECT COUNT(*) c FROM doc_states WHERE doc_type=?').get(docType).c
}

/** 完整状态机：状态清单 + 动作边 */
export function getMachine(db = getDb(), codeOrTable) {
  const type = getDocType(db, codeOrTable)
  const states = db
    .prepare('SELECT * FROM doc_states WHERE doc_type=? ORDER BY sort_order')
    .all(type.code)
  const edges = db
    .prepare('SELECT * FROM doc_actions WHERE doc_type=? ORDER BY sort_order')
    .all(type.code)

  // 把边按 starting state 归集，方便前端画流转图
  const byFrom = {}
  for (const e of edges) {
    ;(byFrom[e.from_state] ||= []).push(e)
  }
  return {
    type,
    states,
    edges,
    fromStates: Object.entries(byFrom).map(([from, list]) => ({
      from,
      fromName: states.find((s) => s.code === from)?.name || from,
      to: list.map((e) => ({
        action: e.action,
        actionName: e.action_name,
        to: e.to_state,
        permCode: e.perm_code,
        isDanger: !!e.is_danger
      }))
    })),
    initial: states.filter((s) => s.is_initial).map((s) => s.code),
    finals: states.filter((s) => s.is_final).map((s) => s.code),
    kinds: states.reduce((acc, s) => {
      ;(acc[s.kind] ||= []).push(s.code)
      return acc
    }, {})
  }
}

/** 某状态下可以做什么（可传已持权限集合做过滤） */
export function allowedActions(db = getDb(), docType, fromState, { perms = null } = {}) {
  const rows = db
    .prepare('SELECT * FROM doc_actions WHERE doc_type=? AND from_state=? ORDER BY sort_order')
    .all(getDocType(db, docType).code, fromState)
  const list = rows.map((e) => ({
    action: e.action,
    actionName: e.action_name,
    to: e.to_state,
    permCode: e.perm_code,
    isDanger: !!e.is_danger,
    permitted: !perms || !e.perm_code || perms.has(e.perm_code) || perms.has('*')
  }))
  return list
}

/** 定位一条边；找不到抛出带「当前可做动作」的错误，便于前端直接提示 */
export function findAction(db, docType, fromState, action) {
  const edge = db
    .prepare('SELECT * FROM doc_actions WHERE doc_type=? AND from_state=? AND action=?')
    .get(docType, fromState, action)
  if (edge) return edge

  const available = allowedActions(db, docType, fromState).map((a) => a.actionName || a.action)
  const stateName =
    db.prepare('SELECT name FROM doc_states WHERE doc_type=? AND code=?').get(docType, fromState)?.name ||
    fromState
  throw new DocFlowError(
    available.length
      ? `状态「${stateName}」不支持动作「${action}」，当前可执行：${available.join(' / ')}`
      : `状态「${stateName}」已是终态，不能继续流转`,
    {
      code: 'TRANSITION_NOT_ALLOWED',
      httpStatus: 409,
      detail: { docType, fromState, action, available }
    }
  )
}

// ---------------------------------------------------------------------------
// 审批闸门挂点（模块 22）
//
// 审批引擎（approval.js）需要 import 本文件的 applyTransition，
// 而本文件又要在流转前问一句「这次动作要不要先审批」—— 直接互相 import 会成环。
// 所以这里只留一个挂点，由 approval.js 在加载时把自己注册进来。
// 没注册（比如单元测试只加载内核）时闸门视为不存在，行为与从前完全一致。
// ---------------------------------------------------------------------------

let approvalGateHook = null

/** 由 approval.js 调用；传 null 可卸载 */
export function setApprovalGate(fn) {
  approvalGateHook = typeof fn === 'function' ? fn : null
}

// ---------------------------------------------------------------------------
// 执行流转
// ---------------------------------------------------------------------------

const nowStr = () => localNow()

/**
 * 统一的单据流转入口。
 * @param {object} p
 * @param {Database} p.db
 * @param {string}  p.docType    单据类型码或表名（PO / sales_orders）
 * @param {number}  p.id         单据主键
 * @param {string}  p.action     动作码（submit/approve/ship…）
 * @param {object}  [p.actor]    { id, name }
 * @param {string}  [p.remark]
 * @param {string}  [p.source]   api / mcp / seed / system
 * @param {object}  [p.payload]  附加信息（写入留痕）
 * @param {object}  [p.set]      需要一并更新的其它字段（如 updated_at / express_no）
 * @param {number}  [p.expectFrom] 乐观并发：期望的当前状态，不符则拒绝
 * @returns {{docType:string,id:number,docNo:string|null,from:string,to:string,action:string,actionName:string}}
 */
export function applyTransition(p) {
  const db = p.db || getDb()
  const type = getDocType(db, p.docType)
  const statusField = type.status_field || 'status'
  const docNoField = type.doc_no_field || 'doc_no'

  if (!p.action) {
    throw new DocFlowError('必须指定动作 action', { code: 'ACTION_REQUIRED', httpStatus: 400 })
  }

  const row = db.prepare(`SELECT * FROM ${type.table_name} WHERE id=?`).get(p.id)
  if (!row) {
    throw new DocFlowError(`${type.name} #${p.id} 不存在`, { code: 'DOC_NOT_FOUND', httpStatus: 404 })
  }

  const from = row[statusField]
  if (p.expectFrom && p.expectFrom !== from) {
    throw new DocFlowError(`状态已变化：期望 ${p.expectFrom}，实际 ${from}`, {
      code: 'STATE_CONFLICT',
      httpStatus: 409
    })
  }

  const edge = findAction(db, type.code, from, p.action)

  // 审批闸门：`doc_actions.require_approval=1` 的边必须先走完审批流才放行。
  // **只检查、不写库** —— 调用方常常把流转包在事务里，这里若建了审批实例，
  // 一次回滚就把实例冲掉了，用户会看到「请去审批中心」而审批中心是空的。
  // 实例的创建是显式动作（POST /api/approval/instances），不在这里偷偷做。
  if (edge.require_approval && approvalGateHook) {
    const gate = approvalGateHook(db, { docType: type.code, docId: p.id, action: edge.action, row })
    if (gate && gate.required) {
      const waiting = gate.pending
        ? `已提交审批，等待「${gate.pending.current_approver || '审批人'}」处理`
        : '尚未提交审批'
      throw new DocFlowError(
        `「${edge.action_name || edge.action}」需要审批（${waiting}）。${
          gate.pending ? '' : '请在单据统计页提交审批。'
        }`,
        {
          code: 'APPROVAL_PENDING',
          httpStatus: 409,
          detail: {
            docType: type.code,
            docId: p.id,
            docNo: row[docNoField] || null,
            action: edge.action,
            actionName: edge.action_name,
            templateCode: gate.template?.code || null,
            templateName: gate.template?.name || null,
            amount: gate.amount,
            instanceId: gate.pending?.id ?? null,
            currentApprover: gate.pending?.current_approver ?? null,
            requireApproval: true
          }
        }
      )
    }
  }

  // 组装 UPDATE：状态 + 调用方要求的附加字段（白名单校验，防注入未知列）
  const sets = [`${statusField}=?`]
  const vals = [edge.to_state]
  const cols = db.prepare(`PRAGMA table_info(${type.table_name})`).all().map((c) => c.name)
  for (const [k, v] of Object.entries(p.set || {})) {
    if (!cols.includes(k)) continue // 静默忽略不存在的列，避免老代码传入的冗余字段炸掉
    sets.push(`${k}=?`)
    vals.push(v)
  }

  const execute = db.transaction(() => {
    db.prepare(`UPDATE ${type.table_name} SET ${sets.join(', ')} WHERE id=?`).run(...vals, p.id)
    db.prepare(
      `INSERT INTO doc_events
        (doc_type,doc_id,doc_no,action,action_name,from_state,to_state,actor_id,actor_name,source,remark,payload_json,org_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      type.code,
      p.id,
      row[docNoField] || null,
      edge.action,
      edge.action_name,
      from,
      edge.to_state,
      p.actor?.id ?? null,
      p.actor?.name ?? null,
      p.source || 'api',
      p.remark || null,
      p.payload ? JSON.stringify(p.payload) : null,
      p.orgId ?? row.org_id ?? null,
      nowStr()
    )
  })
  execute()

  return {
    docType: type.code,
    docTypeName: type.name,
    id: p.id,
    docNo: row[docNoField] || null,
    from,
    to: edge.to_state,
    action: edge.action,
    actionName: edge.action_name,
    isDanger: !!edge.is_danger
  }
}

/** 非抛错版本：返回 { ok, data | error }，便于在既有路由里平滑接入 */
export function tryTransition(p) {
  try {
    return { ok: true, data: applyTransition(p) }
  } catch (e) {
    if (e instanceof DocFlowError) return { ok: false, error: e }
    throw e
  }
}

// ---------------------------------------------------------------------------
// 入口闸门（027）：通用流转入口能驱动谁、不能驱动谁
// ---------------------------------------------------------------------------
// 为什么闸门放在内核而不是各路由：
//   ① 「通用入口」与「业务入口」是两个入口，但判据必须是**一份**。
//      如果只在通用入口写一段 if，业务入口将来加的新动作就又漏了 ——
//      本项目已经用两条缺陷证明过这个形状（列表挡得住、详情挡不住；create 拦得住、update 拦不住）。
//   ② D5「MCP 复用领域服务」需要同一个入口函数：MCP 不应该是"另一条平行实现"。
//      所以把「这条边归谁执行」做成登记表，两个入口都调 dispatchTransition。
//
// **权限检查留在入口层（路由），不下沉到内核** —— 这是刻意的：
//   一个用户动作常常在内部触发**多个**状态变更（付款核销会自动把结算单结清、
//   收货会自动把订货单并入应收），那些内部流转的 perm_code 属于别的角色。
//   若把 perm_code 判定下沉进 applyTransition，一次合法的付款会被判成越权。
//   ⇒ 判据函数共用（assertEdgePermitted），调用点放在"用户请求"这一层。

/** 效果归属登记表：`docType` → 归属的业务服务 */
const EFFECT_OWNERS = new Map()

/**
 * 声明某单据类型的流转由哪个业务服务负责执行（副作用与状态在同一段代码里）。
 *
 * 为什么要有这张表：通用入口被问到「帮我把这张 OC 单推进一步」时，
 * 正确的做法**不是**"只改状态"，也不是"拒绝"，而是**走和正门完全一样的那段代码**。
 * 登记之后，通用入口与业务入口是同一条实现，不存在「两条路结果不一样」。
 *
 * `canAccess` 是**可选的**单据级越权判定。为什么它也该登记：
 *   订货中心判"这张单能不能动"用的是 `customer_id`（订货方视角），
 *   而不是通用的 `dealer_id/store_id` —— 这套口径只属于那个域。
 *   通用入口若自己另写一套，就会出现「同一个人，列表里看不到这张单、却能动它」。
 *   没登记就退回通用判据（assertCanRead + 组织范围）。
 *
 * @param {string} docType 单据类型码
 * @param {Function} run   (db, p) => transitionResult，内部自己调 applyTransition
 * @param {object} opts    { entry, canAccess }
 */
export function claimTransitionEffect(docType, run, { entry = null, canAccess = null } = {}) {
  if (typeof run !== 'function') throw new Error('claimTransitionEffect 需要一个执行函数')
  EFFECT_OWNERS.set(docType, { run, entry, canAccess })
}

/** 查某单据类型的归属执行器（未登记返回 null） */
export function effectOwnerOf(docType) {
  return EFFECT_OWNERS.get(docType) || null
}

/** 读取流转策略行（未写策略返回 null —— 调用方按"未声明"处理，一律拒绝） */
export function transitionPolicyOf(db, docType) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='doc_transition_policy'").get()) {
    return null
  }
  return db.prepare('SELECT * FROM doc_transition_policy WHERE doc_type=?').get(docType) || null
}

/**
 * 功能权限门：这条边的 `perm_code` 当前主体是否持有。
 * 与 `requirePerm` 共用同一份「一个人有哪些权限点」的定义（middleware/auth.js 的 permContext）。
 *
 * 边不存在时**直接放行** —— 让 applyTransition 去抛那个带「当前可做动作」的 409。
 * 在这里抛 403 会把"你写错了动作名"误报成"你没权限"，排查方向被带偏。
 *
 * @param {object} p { db, docType, fromState, action, permCtx, entry }
 */
export function assertEdgePermitted(p) {
  const db = p.db || getDb()
  const type = getDocType(db, p.docType)
  const edge = db
    .prepare('SELECT * FROM doc_actions WHERE doc_type=? AND from_state=? AND action=?')
    .get(type.code, p.fromState, p.action)
  if (!edge || !edge.perm_code) return edge || null

  const ctx = p.permCtx || { perms: new Set(), isSuper: false }
  if (ctx.isSuper) return edge
  const perms = ctx.perms || new Set()
  if (perms.has('*') || perms.has(edge.perm_code)) return edge

  throw new DocFlowError(
    `当前身份没有「${edge.action_name || edge.action}」的操作权限（需 ${edge.perm_code}）`,
    {
      code: 'PERM_DENIED',
      httpStatus: 403,
      detail: { docType: type.code, action: edge.action, actionName: edge.action_name, permCode: edge.perm_code, entry: p.entry || null }
    }
  )
}

/**
 * 通用流转分发（唯一入口）：效果归属 → 委托；显式放开的纯状态类型 → 内核；其余 → 拒绝。
 * @param {object} p 与 applyTransition 同样的参数
 */
export function dispatchTransition(p) {
  const db = p.db || getDb()
  const type = getDocType(db, p.docType)
  const statusField = type.status_field || 'status'

  if (!p.action) {
    throw new DocFlowError('必须指定动作 action', { code: 'ACTION_REQUIRED', httpStatus: 400 })
  }
  const row = db.prepare(`SELECT * FROM ${type.table_name} WHERE id=?`).get(p.id)
  if (!row) {
    throw new DocFlowError(`${type.name} #${p.id} 不存在`, { code: 'DOC_NOT_FOUND', httpStatus: 404 })
  }
  const from = row[statusField]

  // ① 有归属执行器 → 走正门那一段代码（副作用、事务、留痕全部一致）
  const owner = effectOwnerOf(type.code)
  if (owner) {
    return owner.run(db, { ...p, docType: type.code, from })
  }

  // ② 策略显式放开 → 纯状态流转，走内核
  const policy = transitionPolicyOf(db, type.code)
  if (policy && policy.allow_generic) {
    return applyTransition({ ...p, db, docType: type.code })
  }

  // ③ 其余 → 拒绝，并指路
  const entry = (policy && policy.effect_owner) || `${type.module || '业务'} 域业务接口`
  throw new DocFlowError(
    `「${type.name}」的流转带业务后果（库存/往来/授信/成本），通用流转入口不驱动它。请走：${entry}`,
    {
      code: 'EFFECT_REQUIRES_BUSINESS_API',
      httpStatus: 409,
      detail: {
        docType: type.code,
        docName: type.name,
        docId: p.id,
        docNo: row[type.doc_no_field || 'doc_no'] || null,
        action: p.action,
        entry
      }
    }
  )
}

/**
 * 路由里最常用的一形态：直接拿 req 里的操作人，失败即抛（全局错误中间件转 409/404）。
 * 用法：advanceStatus(db, req, { docType:'SO', id, action:'confirm' })
 */
export function advanceStatus(db, req, { docType, id, action, set, remark, source = 'api', expectFrom = null, payload = null, actor = null }) {
  return applyTransition({
    db,
    docType,
    id,
    action,
    set,
    remark,
    source,
    payload,
    expectFrom,
    // `actor` 可显式传入（D5：MCP 等非 HTTP 入口没有 `req.user`）——
    // 原来只能从 `req.user` 取，非 HTTP 调用方就被迫去伪造一个 req 对象，
    // 而伪造出来的 req 会让"谁做的这次流转"彻底失真。留痕的第一要素是人。
    actor: actor || { id: req?.user?.uid ?? null, name: req?.user?.name || req?.user?.username || null },
    orgId: req?.user?.org_id ?? null
  })
}

/** 本地时间字符串（替代 SQL 里的 datetime('now','localtime')，便于作为流转附加字段） */
export function nowText() {
  return nowStr()
}

/** 只补留痕、不改状态（用于历史上没有留痕的单据修复、或 seed 造数据） */
export function logEvent(p) {
  const db = p.db || getDb()
  const type = getDocType(db, p.docType)
  db.prepare(
    `INSERT INTO doc_events
      (doc_type,doc_id,doc_no,action,action_name,from_state,to_state,actor_id,actor_name,source,remark,payload_json,org_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    type.code,
    p.id ?? null,
    p.docNo ?? null,
    p.action,
    p.actionName ?? p.action,
    p.from ?? null,
    p.to,
    p.actor?.id ?? null,
    p.actor?.name ?? null,
    p.source || 'system',
    p.remark || null,
    p.payload ? JSON.stringify(p.payload) : null,
    p.orgId ?? null,
    p.createdAt || nowStr()
  )
}

/** 单据一生：按时间正序列出全部流转 */
export function historyOf(db = getDb(), { docType, id = null, docNo = null, limit = 200, scope = null }) {
  const type = getDocType(db, docType)
  const conds = ['doc_type=?']
  const args = [type.code]
  // 范围（ADR-0032）：传 docEventScope(ctx, 'doc_events') 的结果；受限范围只返回范围内单据的留痕
  if (scope && !scope.all) {
    conds.push(scope.sql)
    args.push(...scope.params)
  }
  if (id != null) {
    conds.push('doc_id=?')
    args.push(id)
  }
  if (docNo) {
    conds.push('doc_no=?')
    args.push(docNo)
  }
  return db
    .prepare(`SELECT * FROM doc_events WHERE ${conds.join(' AND ')} ORDER BY id ASC LIMIT ?`)
    .all(...args, limit)
}

/**
 * 孤儿留痕对账：找出（并可选删除）指向「不存在的单据」的流转留痕。
 *
 * 为什么内核必须带这把尺子：
 *   doc_events 是**唯一一张跨所有单据类型的旁支表** —— 行按 (doc_type, doc_id) 指向各自的主表。
 *   主表一旦重建，自增 id 从 1 重新发放，于是上一代的留痕看起来仍然「指着一张存在的单」，
 *   单靠 doc_id 查不出问题。实测三库重建后共留下 2 万+ 条留痕，其中 99% 指向不存在的单据
 *   （PRQ / PI / PST / PAY 各约 99%），并且已经造成**错挂**：
 *   新建的单据复用到旧 id，时间线里挂着上一张单的历史（三库累计 53 条 INS 留痕已中招）。
 *
 * 两条后果不对称，后者更要命：
 *   ① 体积白涨 —— 每次备份、导出、巡检都带着走；
 *   ② 错挂 —— 单据的「一生」不是它自己的一生，演示时点开一张刚建的草稿单，
 *      时间线里写着「已质检」。这类错**不会报错**，只会让人不再相信这张单。
 *
 * 判据用内核自己的定义（doc_types.table_name），不写死表名清单：
 * 将来新增单据类型，只要注册进 doc_types，这里自动覆盖 —— 不会再出现「忘了把某张表加进清单」。
 *
 * @param dryRun true=只数不删（给自检脚本用，让「零孤儿」成为可断言的不变量）
 * @returns {{ removed:number, byType:Object }} removed=0 才是不变量成立的状态
 */
export function pruneOrphanEvents(db = getDb(), { dryRun = false } = {}) {
  const types = db.prepare('SELECT code, table_name FROM doc_types').all()
  const hasTable = db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name=?")
  const byType = {}
  let removed = 0
  // 表名取自 doc_types（内核定义，非外部输入），不存在注入面
  const countSql = (t) =>
    `SELECT COUNT(*) c FROM doc_events
      WHERE doc_type = ?
        AND doc_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${t.table_name} t WHERE t.id = doc_events.doc_id)`
  const delSql = (t) =>
    `DELETE FROM doc_events
      WHERE doc_type = ?
        AND doc_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${t.table_name} t WHERE t.id = doc_events.doc_id)`
  const run = () => {
    for (const t of types) {
      if (!hasTable.get(t.table_name)) continue
      const n = dryRun
        ? db.prepare(countSql(t)).get(t.code).c
        : db.prepare(delSql(t)).run(t.code).changes
      if (n) {
        byType[t.code] = n
        removed += n
      }
    }
  }
  if (dryRun) run()
  else db.transaction(run)()
  return { removed, byType }
}

/** 全链路联查：给定任意单号，把它所在业务流上所有单据的流转串起来 */
export function traceByDocNo(db = getDb(), docNo, { scope = null } = {}) {
  // 范围（ADR-0032）：命中单号的事件与 payload 里提到该单号的"关联事件"都要过同一道范围谓词，
  // 否则受限账号可以用别的组织的单号，经 payload 联查读到范围外单据的留痕。
  const sc = scope && !scope.all ? ` AND ${scope.sql}` : ''
  const sp = scope && !scope.all ? scope.params : []
  const events = db
    .prepare(`SELECT * FROM doc_events WHERE doc_no=?${sc} ORDER BY id`)
    .all(docNo, ...sp)
  const related = db
    .prepare(`SELECT * FROM doc_events WHERE payload_json LIKE ?${sc} ORDER BY id LIMIT 200`)
    .all(`%${docNo}%`, ...sp)
  const seen = new Set(events.map((e) => e.id))
  const merged = [...events, ...related.filter((e) => !seen.has(e.id))].sort((a, b) => a.id - b.id)
  return merged
}

/** 单证生命周期说明（给文档与界面用） */
export function explainLifecycle(db = getDb(), codeOrTable) {
  const m = getMachine(db, codeOrTable)
  const lines = [`${m.type.name}（${m.type.code}）｜表 ${m.type.table_name}｜单号前缀 ${m.type.doc_no_prefix || '-'}`]
  // 初始状态打**中文名**（与下面每一行「[1] draft 草稿」同一口径）。
  // 原来这里 join 的是**状态码**，于是同一段文本里两种口径并存："初始状态：draft" 对 "草稿"；
  // 而同一个码在不同域name不同（`draft` 在 DL 域是「待发货」）⇒ 用户读到的是代码而不是名字。
  // 展示口径在 `label()` 里已经有一份（下面每行用的就是它），这里复用它 —— 不另写映射。
  lines.push(`  初始状态：${m.type ? m.initial.map((c) => label(m, c)).join('、') || '-' : '-'}`)
  const order = m.states.map((s) => s.code)
  for (const s of m.states) {
    const sName = s.name
    const outs = m.edges.filter((e) => e.from_state === s.code)
    const desc = outs.length
      ? outs.map((e) => `${e.action_name}→${label(m, e.to_state)}`).join('，')
      : '终态'
    lines.push(`  [${order.indexOf(s.code) + 1}] ${s.code} ${sName}：${desc}`)
  }
  return lines.join('\n')
}

function label(m, code) {
  return m.states.find((x) => x.code === code)?.name || code
}

export default {
  DocFlowError,
  DOC_CREATE_PERMS,
  DOC_SCOPE_RESOLVERS,
  docScopeOf,
  docEventScope,
  docInScope,
  unmappedScopeDocTypes,
  createPermOf,
  listDocTypes,
  getDocType,
  getMachine,
  allowedActions,
  findAction,
  applyTransition,
  tryTransition,
  claimTransitionEffect,
  effectOwnerOf,
  transitionPolicyOf,
  assertEdgePermitted,
  dispatchTransition,
  logEvent,
  historyOf,
  pruneOrphanEvents,
  traceByDocNo,
  explainLifecycle
}
