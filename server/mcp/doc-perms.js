/**
 * ============================================================================
 * 文件标识：server/mcp/doc-perms.js ｜ 通用单据读工具的「单据类型 → 查看权限点」唯一映射（ADR-0011 补充 X5）
 * ============================================================================
 * 【这块解决什么问题】`doc.query` / `doc.get` / `doc.list_types` 只认内核（doc_types），原先只按数据范围收窄，
 *   不看所有者是否有权查看该**类型**的单据：仓库角色没有 `finance.voucher.view`，HTTP 查不了凭证，
 *   AI 令牌却能 `doc.get VOUCHER`。委托令牌的口径是「令牌范围 ∩ 所有者当前权限」，这里把缺的那一块补上。
 *
 * 【为什么这样设计】
 *   · **单一映射表** `DOC_VIEW_PERMS`：doc_type → 任一命中即可的权限点。`source:'http'` = 取自该类型
 *     HTTP 列表/详情路由的 requirePerm（含采购链的 `PO_READ_PERMS`）；`source:'explicit'` = HTTP 侧该类型
 *     只有 requireAuth（或按角色名闸），这里按模块的「查看」权限点显式钉死，口径比 HTTP 更严（委托不应比本人宽）。
 *   · **无映射 = 拒绝**（fail-closed）：新增单据类型忘了登记，读工具直接报 `DOC_TYPE_UNMAPPED`，
 *     `scripts/check-mcp-coverage.mjs` 同时红灯，不会静默放行。
 *   · 无主令牌（独立服务主体）没有「所有者」可对照，不查权限点，但**未映射类型对它也拒绝**。
 *
 * 【改它要注意什么】权限点必须是 `permissions` 表里真实存在的码（覆盖脚本会核对）；
 *   不要为了让某个测试绿而把类型映射成 `[]`（空数组 = 无人可看，等同未映射，会被覆盖脚本报错）。
 * ============================================================================
 */
import { permContext, hasPerm, INTERNAL_MODULES } from '../middleware/auth.js'
import { PO_READ_PERMS } from '../lib/purchase.js'
import { TOKEN_OWNER_PERM_DENIED } from './delegation.js'

export { TOKEN_OWNER_PERM_DENIED }
export const DOC_TYPE_UNMAPPED = 'DOC_TYPE_UNMAPPED'
/** Y6：类型要求门店 / 经销商 / 订货主体绑定，而所有者没有（工具层 403） */
export const TOKEN_OWNER_BINDING_REQUIRED = 'TOKEN_OWNER_BINDING_REQUIRED'

const http = (...perms) => ({ perms, source: 'http' })
const explicit = (...perms) => ({ perms, source: 'explicit' })
/**
 * Y6：声明该类型的 HTTP 路由按「门店 / 经销商 / 订货主体」绑定。`col` = 单据表里承载归属的列。
 *   store   → 所有者须有 `users.store_id`，且单据 `col` == 该门店（pos.js `storeCtx` / requisitions.js 门店侧）
 *   dealer  → 所有者须有 `users.dealer_id`，且单据 `col` == 该经销商（demand.js `dealerCtx`）
 *   subject → 订货中心：外部主体（role=dealer|store）须绑定对应档案，且单据的 customer_id 指向该档案
 *             （order-center.js `ocAccessCheck` / `selfCustomerId`）；内部账号 HTTP 口径是组织范围，
 *             已由 `scopeEntityIds` 覆盖，不要求绑定。
 * 超管 / admin 所有者与无主令牌豁免（HTTP 侧 admin 不受绑定约束，无主令牌无所有者可对照）。
 */
const bound = (binding, col, entry) => ({ ...entry, binding, bindCol: col })

/** doc_type → { perms: 任一命中即可, source: 'http' | 'explicit', binding?: 'store'|'dealer'|'subject', bindCol? } */
export const DOC_VIEW_PERMS = Object.freeze({
  // 采购链：purchase-chain.js 的 readGate（PRQ/PO/GR/PRT/PI/PST/PAY 全部读路由）/ purchase.js 的列表路由 = PO_READ_PERMS
  PRQ: http(...PO_READ_PERMS),
  PO: http(...PO_READ_PERMS),
  GR: http(...PO_READ_PERMS),
  PRT: http(...PO_READ_PERMS),
  PI: http(...PO_READ_PERMS),
  PST: http(...PO_READ_PERMS),
  PAY: http(...PO_READ_PERMS),
  INS: http('quality.inspect.view'), // routes/qc.js
  // 质量
  QCI: http('quality.qc.view'), // routes/qc2.js /inspections
  DH: http('quality.qc.view'), // routes/qc2.js /handlings
  QCR: http('quality.qc.view'), // routes/qc2.js /requests
  // 销售
  SO: explicit('sales.order.view'),
  DL: explicit('sales.order.view'),
  SR: explicit('sales.order.view'),
  QT: http('sales.quote.view'), // routes/quote.js
  SI: http('sales.invoice.view'), // routes/invoice.js
  // 财务
  AR: http('finance.receipt.view'), // routes/ar.js
  RCP: http('finance.receipt.view'),
  RFD: http('finance.refund.view'), // routes/refund.js
  VOUCHER: http('finance.voucher.view'), // routes/accounting.js
  CA: http('cost.view'), // routes/costing.js
  // 库存
  CK: explicit('inventory.stock.view'),
  TF: explicit('inventory.stock.view'),
  AS: explicit('inventory.stock.view'),
  // 生产 / 委外
  MO: http('produce.bom.view'), // routes/manufacture.js P_VIEW
  MR: http('produce.bom.view'),
  WW: explicit('produce.order.view'),
  WM: explicit('produce.order.view'),
  WR: explicit('produce.order.view'),
  // 订货中心 / 经销商
  OC: bound('subject', 'customer_id', explicit('order.view')),
  OCS: bound('subject', 'customer_id', http('order.statement.view')),
  DR: bound('dealer', 'dealer_id', explicit('dms.dealer.view')),
  DS: explicit('dms.dealer.view'),
  RB: explicit('dms.dealer.view'),
  // 线上订单
  OM: explicit('oms.order.view'),
  // 门店 / POS
  PS: bound('store', 'store_id', explicit('pos.cashier')),
  PSF: bound('store', 'store_id', explicit('pos.shift')),
  RC: bound('store', 'store_id', explicit('pos.dailyclose')),
  YQ: bound('store', 'store_id', explicit('pos.store.requisition')),
  SH: bound('store', 'store_id', explicit('pos.store.requisition'))
})

/** 该类型的查看权限点；无映射返回 null（调用方必须按拒绝处理） */
export function viewPermsOf(docType) {
  const e = Object.prototype.hasOwnProperty.call(DOC_VIEW_PERMS, docType) ? DOC_VIEW_PERMS[docType] : null
  return e && e.perms.length ? e.perms : null
}

function denied(code, message) {
  const err = new Error(message)
  err.code = code
  err.status = 403
  return err
}

/** 所有者此刻的权限上下文；无主令牌 = null */
function ownerCtx(db, ctx) {
  return ctx?.ownerUserId != null ? permContext(db, { uid: ctx.ownerUserId }) : null
}

/**
 * 仅总部内部可见的模块（HTTP 侧 `requireInternal` / docflow 的 `INTERNAL_MODULES` 判据）：
 * 经销商 / 门店身份的所有者即使被授予了查看权限点，也不能经 MCP 读这些类型。
 * 在 `INTERNAL_MODULES` 之外追加 oms / dealer：对应 HTTP 路由（oms.js / dealers.js / dms.js）整体 `requireInternal`。
 */
export const HQ_ONLY_MODULES = new Set([...INTERNAL_MODULES, 'oms', 'dealer'])

/** 所有者是外部主体（经销商 / 门店）且该单据类型只对内部开放 */
function externalOwnerBlocked(db, ctx, type) {
  if (ctx?.ownerUserId == null || !HQ_ONLY_MODULES.has(type?.module)) return false
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(Number(ctx.ownerUserId))
  return !u || u.role === 'dealer' || u.role === 'store'
}

/**
 * 某类型对本次调用是否可读（不抛错）：未映射 → false；无主令牌 → true；
 * 有主 → 所有者非外部主体（对内部类型）且任一权限点命中。`type` 需含 `code` 与 `module`。
 */
export function canViewDocType(db, ctx, type, owner = ownerCtx(db, ctx)) {
  const perms = viewPermsOf(type.code)
  if (!perms) return false
  if (!owner) return true
  if (externalOwnerBlocked(db, ctx, type)) return false
  if (!perms.some((p) => hasPerm(owner, p))) return false
  return holdsBinding(db, ctx, type, owner)
}

/** 读工具入口闸门：不可读则抛 403（未映射 `DOC_TYPE_UNMAPPED`，权限不足 `TOKEN_OWNER_PERM_DENIED`） */
export function assertCanViewDocType(db, ctx, type) {
  const perms = viewPermsOf(type.code)
  if (!perms) throw denied(DOC_TYPE_UNMAPPED, `单据类型「${type.name || type.code}」未登记查看权限点，默认拒绝（见 server/mcp/doc-perms.js）`)
  if (canViewDocType(db, ctx, type)) return
  const owner = ownerCtx(db, ctx)
  if (
    owner && !externalOwnerBlocked(db, ctx, type) && perms.some((p) => hasPerm(owner, p)) &&
    !holdsBinding(db, ctx, type, owner)
  ) {
    const b = bindingOf(type.code)
    const what = b.binding === 'dealer' ? '经销商' : b.binding === 'store' ? '门店' : '订货主体（经销商 / 门店档案）'
    throw denied(
      TOKEN_OWNER_BINDING_REQUIRED,
      `「${type.name || type.code}」按${what}绑定：令牌所有者账号没有对应绑定，不能读取；委托令牌不能超过所有者本人的权限`
    )
  }
  throw denied(
    TOKEN_OWNER_PERM_DENIED,
    externalOwnerBlocked(db, ctx, type)
      ? `令牌所有者是外部主体（经销商 / 门店），无权查看总部内部单据「${type.name || type.code}」`
      : `令牌所有者当前没有查看「${type.name || type.code}」的权限（需 ${perms.join(' 或 ')}）；委托令牌不能超过所有者本人的权限`
  )
}

/** 活动单据类型里没有映射的 code（覆盖脚本用） */
export function unmappedDocTypes(codes) {
  return codes.filter((c) => !viewPermsOf(c))
}

// ---------------------------------------------------------------------------
// Y6：门店 / 经销商 / 订货主体绑定（ADR-0011 Y6 补充）
// ---------------------------------------------------------------------------

/** 该类型的绑定声明；无绑定返回 null */
export function bindingOf(docType) {
  const e = Object.prototype.hasOwnProperty.call(DOC_VIEW_PERMS, docType) ? DOC_VIEW_PERMS[docType] : null
  return e && e.binding ? { binding: e.binding, col: e.bindCol } : null
}

/** 所有者的绑定事实（每次回库）：超管 / admin 豁免；无主令牌 = null（豁免） */
function ownerBindingFacts(db, ctx, owner = ownerCtx(db, ctx)) {
  if (!owner || owner.isSuper) return null
  const u = db.prepare('SELECT role, store_id, dealer_id FROM users WHERE id=?').get(Number(ctx.ownerUserId))
  return { role: u?.role ?? null, storeId: u?.store_id ?? null, dealerId: u?.dealer_id ?? null }
}

/**
 * 订货主体：外部主体（role=dealer|store）绑定的订货档案 id 集合；内部账号 = 不适用（返回 undefined）。
 * 只读，不像 HTTP 的 `selfCustomerId` 那样 ensureCustomer 建档（读工具不应写库）。
 */
function subjectCustomerIds(db, facts) {
  if (facts.role !== 'dealer' && facts.role !== 'store') return undefined
  const sid = facts.role === 'dealer' ? facts.dealerId : facts.storeId
  if (sid == null) return []
  return db.prepare('SELECT id FROM oc_customers WHERE source_type=? AND source_id=?').all(facts.role, Number(sid)).map((r) => r.id)
}

/** 类型级：所有者是否具备该类型要求的绑定（无绑定要求 / 豁免 = true） */
export function holdsBinding(db, ctx, type, owner = ownerCtx(db, ctx)) {
  const b = bindingOf(type.code)
  if (!b) return true
  const f = ownerBindingFacts(db, ctx, owner)
  if (!f) return true
  if (b.binding === 'store') return f.storeId != null
  if (b.binding === 'dealer') return f.dealerId != null
  if (f.role !== 'dealer' && f.role !== 'store') return true // 内部账号：HTTP 口径是组织范围，不要求绑定
  return f.role === 'dealer' ? f.dealerId != null : f.storeId != null
}

/**
 * 列表用的行级限定（拼进 WHERE）：返回 `{ sql, params }`，null = 不限。
 * 调用前须已通过 `assertCanViewDocType`（绑定存在）；绑定存在但档案为空 ⇒ `1=0`。
 */
export function bindingWhere(db, ctx, type) {
  const b = bindingOf(type.code)
  const f = b ? ownerBindingFacts(db, ctx) : null
  if (!f) return null
  if (b.binding === 'store' || b.binding === 'dealer') {
    const id = b.binding === 'store' ? f.storeId : f.dealerId
    return id == null ? { sql: '1=0', params: [] } : { sql: `${b.col}=?`, params: [Number(id)] }
  }
  const ids = subjectCustomerIds(db, f)
  if (ids === undefined) return null
  if (!ids.length) return { sql: '1=0', params: [] }
  return { sql: `${b.col} IN (${ids.map(() => '?').join(',')})`, params: ids }
}

/** 单据级：这一行是否属于所有者的绑定对象（无绑定要求 / 豁免 = true；取不到归属列 = false，fail-closed） */
export function rowInBinding(db, ctx, type, row) {
  const w = bindingWhere(db, ctx, type)
  if (!w) return true
  const b = bindingOf(type.code)
  const v = row?.[b.col]
  if (v == null) return false
  if (b.binding === 'subject') return w.params.map(Number).includes(Number(v))
  return w.params.length === 1 && Number(v) === Number(w.params[0])
}
