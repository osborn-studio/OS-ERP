/**
 * ============================================================================
 * 文件标识：src/api/manufacture.ts ｜ 模块 manufacture（按文件名推断，待人工完善）
 * ============================================================================
 * 【职责】模块 manufacture（按文件名推断，待人工完善）
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import api from './client'

/**
 * 生产制造（模块 10B）的前端配套：**一个 BOM + 三类执行单**。
 *
 * 这一页回答四个问题，四个页签一一对应：
 *   ① 这个成品照什么做？（BOM：用量、损耗、替代料）
 *   ② 现在该领什么料？（需求展开：BOM 需求 − 已出库 = 待领）
 *   ③ 料领了没有？（领料单 MR：草稿 → 提交 → 审批 → **出库**）
 *   ④ 做出来的货入库了没有？（完工汇报 → **完工入库**）
 *
 * 界面上要守住的四条口径（与后端一一对应，改一处必须同步改另一处）：
 *   ① **一个母件一个用途只有一版 BOM**，且只有「已审批 + 在生效期内」的能拿来展开 ——
 *      所以已审批的 BOM 界面上**不给改**，只能作废后新建；展开按钮只在已审批的行上出现。
 *   ② **展开用量已含损耗**：`单件用量 × (1 + 损耗率) × 生产数量 ÷ 基准批量`。
 *      界面上显示的就是这个含损耗的量，不要再乘一次 (1+损耗率)。
 *   ③ **替代料的选择要给理由**：同组内选了谁、为什么没选主料，展开结果里直接写明（`reason`）。
 *   ④ **出库与入库是两个「有后果」的动作**，各只有一个按钮：
 *      领料单的「确认出库」（扣库存）、生产订单的「完工入库」（增库存）。
 *      其余按钮（提交/审批/登记汇报）都不动库存 —— 界面上也要让人看得出来。
 */

const data = <T>(p: Promise<any>): Promise<T> => p.then((r) => r.data as T)

// ---------------------------------------------------------------------------
// 字典与配色
// ---------------------------------------------------------------------------

export const USAGE_LABEL: Record<string, string> = { self_made: '自制', outsourced: '委外', combo: '组合装' }
export const USAGE_CLS: Record<string, string> = {
  self_made: 'text-sky-700 bg-sky-50 border-sky-200',
  outsourced: 'text-violet-700 bg-violet-50 border-violet-200',
  combo: 'text-teal-700 bg-teal-50 border-teal-200'
}

export const BOM_STATUS_LABEL: Record<string, string> = { draft: '草稿', approved: '已审批', obsolete: '已作废' }
export const BOM_STATUS_CLS: Record<string, string> = {
  draft: 'text-slate-600 bg-slate-50 border-slate-200',
  approved: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  obsolete: 'text-slate-400 bg-slate-50 border-slate-200 line-through'
}

export const ISSUE_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交',
  approved: '已审批',
  issued: '已出库',
  cancelled: '已取消'
}
export const ISSUE_STATUS_CLS: Record<string, string> = {
  draft: 'text-slate-600 bg-slate-50 border-slate-200',
  submitted: 'text-amber-700 bg-amber-50 border-amber-200',
  approved: 'text-sky-700 bg-sky-50 border-sky-200',
  issued: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  cancelled: 'text-slate-400 bg-slate-50 border-slate-200'
}

export const ISSUE_TYPE_LABEL: Record<string, string> = { by_bom: '按 BOM 领料', limit: '限额领料', supplement: '补料' }
export const ISSUE_TYPE_CLS: Record<string, string> = {
  by_bom: 'text-sky-700 bg-sky-50 border-sky-200',
  limit: 'text-indigo-700 bg-indigo-50 border-indigo-200',
  supplement: 'text-orange-700 bg-orange-50 border-orange-200'
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交',
  approved: '已审批',
  in_progress: '生产中',
  completed: '已完工',
  closed: '已关闭',
  cancelled: '已取消'
}
export const ORDER_STATUS_CLS: Record<string, string> = {
  draft: 'text-slate-600 bg-slate-50 border-slate-200',
  submitted: 'text-amber-700 bg-amber-50 border-amber-200',
  approved: 'text-sky-700 bg-sky-50 border-sky-200',
  in_progress: 'text-indigo-700 bg-indigo-50 border-indigo-200',
  completed: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  closed: 'text-slate-500 bg-slate-50 border-slate-200',
  cancelled: 'text-slate-400 bg-slate-50 border-slate-200'
}

/** 领料单状态机的可用动作。**「确认出库」是唯一扣库存的动作**，所以只它带红标。 */
export const ISSUE_ACTIONS: Record<string, { action: string; label: string; danger?: boolean; hint: string }[]> = {
  draft: [
    { action: 'submit', label: '提交', hint: '提交后才能审批' },
    { action: 'cancel', label: '取消', hint: '取消后不能再提交' }
  ],
  submitted: [
    { action: 'approve', label: '审批', hint: '审批后才能出库' },
    { action: 'cancel', label: '取消', hint: '取消后不能再提交' }
  ],
  approved: [
    { action: 'issue', label: '确认出库', danger: true, hint: '按批次实际扣减库存并回写出库成本，单据变终态' },
    { action: 'cancel', label: '取消', hint: '取消后不能再提交' }
  ],
  issued: [],
  cancelled: []
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface BomItem {
  id?: number
  line_no?: number
  sku_id: number
  sku_code?: string | null
  sku_name?: string | null
  spec?: string | null
  unit?: string | null
  qty: number
  loss_rate: number
  substitute_group?: string | null
  priority?: number
  issue_way?: string
  remark?: string | null
}

export interface Bom {
  id: number
  code: string
  product_sku_id: number
  product_sku_code?: string | null
  product_sku_name?: string | null
  version: string
  usage: string
  usage_label?: string
  status: string
  status_label?: string
  base_qty: number
  produce_way?: string
  warehouse_id?: number | null
  effective_from?: string | null
  effective_to?: string | null
  audited_by_name?: string | null
  audited_at?: string | null
  audit_remark?: string | null
  item_count?: number
  remark?: string | null
  items?: BomItem[]
}

export interface ExpandLine {
  line_no: number
  bom_line_no: number
  sku_id: number
  sku_code?: string | null
  sku_name?: string | null
  spec?: string | null
  unit?: string | null
  qty: number
  base_qty: number
  loss_rate: number
  available?: number | null
  shortage?: number | null
  substitute_group?: string | null
  is_substitute: boolean
  substitute_for?: number | null
  issue_way?: string
}

export interface ExpandGroup {
  group: string
  required_qty: number
  chosen_line_no: number
  chosen_sku_id: number
  reason: string
  candidates: { line_no: number; sku_id: number; sku_code?: string | null; sku_name?: string | null; priority: number; need_qty: number; available: number | null; enough: boolean | null }[]
}

export interface ExpandResult {
  bom: { id: number; code: string; version: string; usage: string; usage_label?: string; base_qty: number; product_sku_code?: string | null; product_sku_name?: string | null }
  qty: number
  lines: ExpandLine[]
  groups: ExpandGroup[]
  summary: { line_count: number; group_count: number; substituted: number; shortage_count: number }
}

export interface IssueItem {
  id?: number
  line_no: number
  sku_id: number
  sku_code?: string | null
  sku_name?: string | null
  spec?: string | null
  unit?: string | null
  batch_no?: string | null
  plan_qty?: number
  qty: number
  issued_qty?: number
  unit_cost?: number | null
  amount?: number | null
  substitute_for?: number | null
}

export interface Issue {
  id: number
  doc_no: string
  order_id: number
  order_no?: string | null
  warehouse_id?: number | null
  warehouse_name?: string | null
  issue_date?: string | null
  issue_type: string
  issue_type_label?: string
  status: string
  status_label?: string
  plan_qty?: number
  total_qty: number
  total_amount: number
  item_count?: number
  issued_by_name?: string | null
  issued_at?: string | null
  remark?: string | null
  items?: IssueItem[]
  events?: { id: number; action: string; from_state?: string | null; to_state?: string | null; actor_name?: string | null; created_at?: string }[]
}

export interface RequirementLine extends ExpandLine {
  issued_qty: number
  pending_qty: number
  is_done: boolean
}

export interface Requirement {
  order: { id: number; doc_no: string; qty: number; status?: string; product_sku_id: number; warehouse_id?: number | null; produce_way?: string }
  bom: ExpandResult['bom'] | null
  lines: RequirementLine[]
  groups?: ExpandGroup[]
  summary: { line_count: number; required_qty: number; issued_qty: number; pending_count: number; shortage_count: number }
  message?: string
}

export interface WorkReport {
  id: number
  doc_no: string
  order_id: number
  order_no?: string | null
  report_date?: string | null
  process_name?: string | null
  good_qty: number
  defect_qty: number
  work_hours?: number
  labor_rate?: number
  labor_cost?: number
  overhead_cost?: number
  material_cost?: number
  unit_cost?: number
  batch_no?: string | null
  stock_done: number
  stock_doc_no?: string | null
  operator_name?: string | null
  sku_code?: string | null
  sku_name?: string | null
  remark?: string | null
}

export interface ProductionOrder {
  id: number
  doc_no: string
  product_sku_id: number
  sku_code?: string | null
  sku_name?: string | null
  spec?: string | null
  unit?: string | null
  warehouse_id?: number | null
  warehouse_name?: string | null
  plan_date?: string | null
  status: string
  status_label?: string
  produce_way?: string
  qty: number
  completed_qty: number
  in_progress_qty?: number
  unit_cost?: number
  material_cost?: number
  total_cost?: number
  issued_qty?: number
  issued_amount?: number
  reported_good_qty?: number
  reported_defect_qty?: number
  conversion_cost?: number
  issue_count?: number
  report_count?: number
  progress?: { order_id: number; issued_qty?: number; issued_amount?: number; reported_good_qty?: number; reported_defect_qty?: number; conversion_cost?: number; issue_count?: number; completed_qty?: number }
  issues?: Issue[]
  reports?: WorkReport[]
  bom?: { id: number; code: string; version: string; base_qty: number; item_count: number } | null
  items?: { id: number; sku_id: number; qty: number; issued_qty?: number }[]
}

export interface CompletionPreview {
  order_id: number
  order_no: string
  order_qty: number
  pending_report_count: number
  good_qty: number
  defect_qty: number
  issued_amount: number
  unit_material: number
  material_cost: number
  conversion_cost: number
  total_cost: number
  unit_cost: number
  will_complete_order: boolean
}

export interface MfgOverview {
  orders: { total: number; wip: number; completed: number; wip_qty: number }
  issues: { total: number; issued: number; issued_amount: number }
  reports: { total: number; good_qty: number; defect_qty: number; defect_rate: number; hours: number; conversion_cost: number }
  pending_stock_in: number
  in_progress_without_report: number
  bom: {
    total: number
    by_status: { draft: number; approved: number; obsolete: number }
    by_usage: { self_made: number; outsourced: number; combo: number }
    substitute_groups: number
    producible_without_bom: number
  }
}

export interface MfgAudit {
  checked_at: string
  error_count: number
  warn_count: number
  issues: { code: string; level: 'error' | 'warn'; ref: string; message: string }[]
}

export interface MfgMeta {
  usages: { value: string; label: string }[]
  bom_statuses: { value: string; label: string }[]
  issue_statuses: { value: string; label: string }[]
  issue_types: { value: string; label: string }[]
  order_statuses: { value: string; label: string }[]
  produce_ways: { value: string; label: string }[]
  rules: { code: string; text: string }[]
}

// ---------------------------------------------------------------------------
// 只读
// ---------------------------------------------------------------------------

export const MFG_META = () => data<MfgMeta>(api.get('/manufacture/meta'))
export const MFG_OVERVIEW = () => data<MfgOverview>(api.get('/manufacture/overview'))
export const MFG_AUDIT = () => data<MfgAudit>(api.get('/manufacture/audit'))

// ---------------------------------------------------------------------------
// BOM
// ---------------------------------------------------------------------------

export const MFG_BOMS = (p?: Record<string, any>) =>
  data<{ list: Bom[]; total: number; page: number; pageSize: number }>(api.get('/manufacture/boms', p))
export const MFG_BOM = (id: number) => data<Bom>(api.get(`/manufacture/boms/${id}`))
export const MFG_BOM_BY_SKU = (skuId: number, usage = 'self_made') =>
  data<{ bom: Bom | null; usages: Bom[] }>(api.get('/manufacture/boms/by-sku', { sku_id: skuId, usage }))
export const MFG_BOM_CREATE = (body: any) => data<Bom>(api.post('/manufacture/boms', body))
export const MFG_BOM_UPDATE = (id: number, body: any) => data<Bom>(api.put(`/manufacture/boms/${id}`, body))
export const MFG_BOM_AUDIT = (id: number, remark?: string) => data<Bom>(api.post(`/manufacture/boms/${id}/audit`, { remark }))
export const MFG_BOM_OBSOLETE = (id: number, remark?: string) => data<Bom>(api.post(`/manufacture/boms/${id}/obsolete`, { remark }))
export const MFG_BOM_DELETE = (id: number) => data<{ id: number; deleted: boolean }>(api.del(`/manufacture/boms/${id}`))
/** 试算展开：**不改任何数据**，只回答「照这版 BOM 做 N 个要领什么、够不够」 */
export const MFG_BOM_EXPAND = (id: number, body: { qty: number; warehouse_id?: number | null; allow_substitute?: boolean }) =>
  data<ExpandResult>(api.post(`/manufacture/boms/${id}/expand`, body))

// ---------------------------------------------------------------------------
// 生产订单（读 + 开工 + 完工入库）
// ---------------------------------------------------------------------------

export const MFG_ORDERS = (p?: Record<string, any>) =>
  data<{ list: ProductionOrder[]; total: number; page: number; pageSize: number }>(api.get('/manufacture/orders', p))
export const MFG_ORDER = (id: number) => data<ProductionOrder>(api.get(`/manufacture/orders/${id}`))
export const MFG_ORDER_REQUIREMENT = (id: number, p?: { warehouse_id?: number; include_issued?: 1 | 0 }) =>
  data<Requirement>(api.get(`/manufacture/orders/${id}/requirement`, p))
export const MFG_ORDER_START = (id: number, remark?: string) => data<ProductionOrder>(api.post(`/manufacture/orders/${id}/start`, { remark }))
export const MFG_ORDER_COMPLETE_PREVIEW = (id: number, reportId?: number | null) =>
  data<CompletionPreview>(api.get(`/manufacture/orders/${id}/complete-preview`, reportId ? { report_id: reportId } : undefined))
/** **完工入库**：本模块唯一给库存做加法的动作。不传 report_id 则把该单所有待入库汇报一起入。 */
export const MFG_ORDER_COMPLETE = (id: number, body: { report_id?: number | null; batch_no?: string | null; warehouse_id?: number | null; remark?: string | null }) =>
  data<{ order: ProductionOrder; stock_in_qty: number; material_cost: number; conversion_cost: number; batch_no?: string; doc_no?: string }>(
    api.post(`/manufacture/orders/${id}/complete`, body)
  )

// ---------------------------------------------------------------------------
// 领料单（MR）
// ---------------------------------------------------------------------------

export const MFG_ISSUES = (p?: Record<string, any>) =>
  data<{ list: Issue[]; total: number; page: number; pageSize: number }>(api.get('/manufacture/issues', p))
export const MFG_ISSUE = (id: number) => data<Issue>(api.get(`/manufacture/issues/${id}`))
/** 建单：不传 items 时按 BOM 自动装填待领量 */
export const MFG_ISSUE_CREATE = (body: {
  order_id: number
  warehouse_id?: number | null
  issue_date?: string | null
  issue_type?: string
  items?: { sku_id: number; qty: number; batch_no?: string | null; substitute_for?: number | null; remark?: string | null }[] | null
  remark?: string | null
}) => data<Issue>(api.post('/manufacture/issues', body))

// 四个动作各写一条**字面量**路径，不做 `${action}` 拼接：
//   ① 契约检查脚本靠静态扫描比对「前端调用」与「OpenAPI 登记」，拼出来的路径它认不出，
//      会报成「未登记的接口」—— 而那其实是误报，只会训练人忽略这项检查；
//   ② 真把 4 个端点摆在这里，也一眼看得出「只有 issue 会扣库存」。
export const MFG_ISSUE_SUBMIT = (id: number, remark?: string) => data<Issue>(api.post(`/manufacture/issues/${id}/submit`, { remark }))
export const MFG_ISSUE_APPROVE = (id: number, remark?: string) => data<Issue>(api.post(`/manufacture/issues/${id}/approve`, { remark }))
/** **确认出库**：唯一扣库存的动作（按批次取料、回写出库单价与金额，单据随即变终态） */
export const MFG_ISSUE_OUT = (id: number, remark?: string) => data<Issue>(api.post(`/manufacture/issues/${id}/issue`, { remark }))
export const MFG_ISSUE_CANCEL = (id: number, remark?: string) => data<Issue>(api.post(`/manufacture/issues/${id}/cancel`, { remark }))

const ISSUE_ACTIONS_FN: Record<string, (id: number, remark?: string) => Promise<Issue>> = {
  submit: MFG_ISSUE_SUBMIT,
  approve: MFG_ISSUE_APPROVE,
  issue: MFG_ISSUE_OUT,
  cancel: MFG_ISSUE_CANCEL
}
/** 按动作名分派（界面按状态机渲染按钮时用）。未知动作直接抛，不静默当成提交。 */
export const MFG_ISSUE_TRANSITION = (id: number, action: string, remark?: string) => {
  const fn = ISSUE_ACTIONS_FN[action]
  if (!fn) throw new Error(`未知的领料单动作：${action}`)
  return fn(id, remark)
}

// ---------------------------------------------------------------------------
// 完工汇报
// ---------------------------------------------------------------------------

export const MFG_REPORTS = (p?: Record<string, any>) =>
  data<{ list: WorkReport[]; total: number; page: number; pageSize: number }>(api.get('/manufacture/reports', p))
export const MFG_REPORT = (id: number) => data<WorkReport>(api.get(`/manufacture/reports/${id}`))
/** 登记汇报：**不推进任何状态、不动库存**（G4「生产不报工」的落地）；入库要另点「完工入库」。 */
export const MFG_REPORT_CREATE = (body: {
  order_id: number
  issue_id?: number | null
  report_date?: string | null
  process_name?: string | null
  good_qty: number
  defect_qty?: number
  work_hours?: number
  labor_rate?: number
  overhead_cost?: number
  batch_no?: string | null
  remark?: string | null
}) => data<WorkReport>(api.post('/manufacture/reports', body))
export const MFG_REPORT_UPDATE = (id: number, body: any) => data<WorkReport>(api.put(`/manufacture/reports/${id}`, body))
export const MFG_REPORT_DELETE = (id: number) => data<{ id: number; deleted: boolean }>(api.del(`/manufacture/reports/${id}`))

export default {
  MFG_META, MFG_OVERVIEW, MFG_AUDIT,
  MFG_BOMS, MFG_BOM, MFG_BOM_BY_SKU, MFG_BOM_CREATE, MFG_BOM_UPDATE,
  MFG_BOM_AUDIT, MFG_BOM_OBSOLETE, MFG_BOM_DELETE, MFG_BOM_EXPAND,
  MFG_ORDERS, MFG_ORDER, MFG_ORDER_REQUIREMENT, MFG_ORDER_START,
  MFG_ORDER_COMPLETE_PREVIEW, MFG_ORDER_COMPLETE,
  MFG_ISSUES, MFG_ISSUE, MFG_ISSUE_CREATE, MFG_ISSUE_TRANSITION,
  MFG_ISSUE_SUBMIT, MFG_ISSUE_APPROVE, MFG_ISSUE_OUT, MFG_ISSUE_CANCEL,
  MFG_REPORTS, MFG_REPORT, MFG_REPORT_CREATE, MFG_REPORT_UPDATE, MFG_REPORT_DELETE
}
