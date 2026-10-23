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
import { permContext, hasPerm } from '../middleware/auth.js'
import { PO_READ_PERMS } from '../lib/purchase.js'
import { TOKEN_OWNER_PERM_DENIED } from './delegation.js'

export { TOKEN_OWNER_PERM_DENIED }
export const DOC_TYPE_UNMAPPED = 'DOC_TYPE_UNMAPPED'

const http = (...perms) => ({ perms, source: 'http' })
const explicit = (...perms) => ({ perms, source: 'explicit' })

/** doc_type → { perms: 任一命中即可, source: 'http' | 'explicit' } */
export const DOC_VIEW_PERMS = Object.freeze({
  // 采购链：purchase-chain.js 的 readGate / purchase.js 的列表路由 = PO_READ_PERMS
  PRQ: explicit('purchase.req.view'),
  PO: http(...PO_READ_PERMS),
  GR: http(...PO_READ_PERMS),
  PRT: http(...PO_READ_PERMS),
  PI: explicit('purchase.invoice.view'),
  PST: explicit('purchase.settle.view'),
  PAY: explicit('purchase.payment.view'),
  INS: http('quality.inspect.view'), // routes/qc.js
  // 质量
  QCI: http('quality.inspect.view'),
  DH: http('quality.inspect.view'),
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
  MO: explicit('produce.order.view'),
  MR: explicit('produce.order.view'),
  WW: explicit('produce.order.view'),
  WM: explicit('produce.order.view'),
  WR: explicit('produce.order.view'),
  // 订货中心 / 经销商
  OC: explicit('order.view'),
  OCS: http('order.statement.view'),
  DR: explicit('dms.dealer.view'),
  DS: explicit('dms.dealer.view'),
  RB: explicit('dms.dealer.view'),
  // 线上订单
  OM: explicit('oms.order.view'),
  // 门店 / POS
  PS: explicit('pos.cashier'),
  PSF: explicit('pos.shift'),
  RC: explicit('pos.dailyclose'),
  YQ: explicit('pos.store.requisition'),
  SH: explicit('pos.store.requisition')
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

/** 某类型对本次调用是否可读（不抛错）：未映射 → false；无主令牌 → true；有主 → 所有者任一权限点命中 */
export function canViewDocType(db, ctx, docType, owner = ownerCtx(db, ctx)) {
  const perms = viewPermsOf(docType)
  if (!perms) return false
  if (!owner) return true
  return perms.some((p) => hasPerm(owner, p))
}

/** 读工具入口闸门：不可读则抛 403（未映射 `DOC_TYPE_UNMAPPED`，权限不足 `TOKEN_OWNER_PERM_DENIED`） */
export function assertCanViewDocType(db, ctx, type) {
  const perms = viewPermsOf(type.code)
  if (!perms) throw denied(DOC_TYPE_UNMAPPED, `单据类型「${type.name || type.code}」未登记查看权限点，默认拒绝（见 server/mcp/doc-perms.js）`)
  if (canViewDocType(db, ctx, type.code)) return
  throw denied(
    TOKEN_OWNER_PERM_DENIED,
    `令牌所有者当前没有查看「${type.name || type.code}」的权限（需 ${perms.join(' 或 ')}）；委托令牌不能超过所有者本人的权限`
  )
}

/** 活动单据类型里没有映射的 code（覆盖脚本用） */
export function unmappedDocTypes(codes) {
  return codes.filter((c) => !viewPermsOf(c))
}
