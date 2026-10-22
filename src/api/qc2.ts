/**
 * ============================================================================
 * 文件标识：src/api/qc2.ts ｜ 模块 qc2（按文件名推断，待人工完善）
 * ============================================================================
 * 【职责】模块 qc2（按文件名推断，待人工完善）
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import api from './client'

/** 统一拆信封（与 useFetch 一致）*/
const data = <T>(p: Promise<any>): Promise<T> => p.then((r) => r.data as T)

/**
 * 质量检验（模块 13）的前端配套。
 *
 * 与 `api/qc.ts`（模块 07 的采购质检）**不是一回事**，别混用：
 *   模块 07 的质检**绑死在到货单上**，只服务采购，三数写在一张单里（合格/让步/判退）；
 *   模块 13 是**独立三单链**：报检 → 检验 → 不良品处理，来源横跨采购到货、生产完工、在库复检，
 *   判定改用**抽样方案（n / Ac / Re）**，不良品的处置独立成单、各自带库存后果。
 *   两者并存：旧链管存量单据，新单一律走这条。为避免命名撞车，本文件导出一律带 `QC2_` 前缀。
 *
 * 这一页回答三个问题：
 *   · 谁在等检？（待检来源：采购到货 + 生产完工；已报检的不再出现）
 *   · 判的是合格还是不合格？（判定由不良数与 Ac/Re 推导，界面只显示、不让你选）
 *   · 不合格的怎么处理？（让步 / 退货 / 报废 / 返工 —— **四种都会真的动库存**）
 *
 * 前端同样要守住的三条口径（与后端一一对应，改一处要同步）：
 *   ① 判定由数字推导 —— 界面上**没有**"判合格/判不合格"的下拉框，只有填报不良数。
 *   ② 抽样量 ≤ 报检数量、不良数 ≤ 抽样量 —— 输入框按行给出上限，服务端再校验一次。
 *   ③ 处置必须有后果 —— 执行后界面显示生成的单据（调拨单 / 退货单 / 出库单号），
 *      不做"只改状态"的执行；让步与返工显示的是**自动生成的调拨单号**。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type QcSourceType = 'purchase_receipt' | 'production_order' | 'inventory'
export type Qc2Result = 'pending' | 'qualified' | 'unqualified'
export type QcHandleMode = 'concession' | 'return' | 'scrap' | 'rework'
export type QcDisposition = 'none' | QcHandleMode | 'mixed'

export interface QcPendingSource {
  source_type: QcSourceType
  source_id: number
  source_doc_no?: string | null
  warehouse_id?: number | null
  warehouse_name?: string | null
  supplier_id?: number | null
  subject_name?: string | null
  biz_date?: string | null
  qty: number
  sku_id?: number | null
  source_status?: string | null
  ref_id?: number | null
  source_label?: string
}

export interface QcSourceLine {
  source_item_id: number | null
  sku_id?: number | null
  batch_no?: string | null
  qty: number
  price?: number
  sku_name?: string | null
  sku_code?: string | null
  spec?: string | null
}

export interface QcSourceDetail {
  source_type: QcSourceType
  source_label: string
  source_id: number
  source_doc_no?: string | null
  source_status?: string | null
  warehouse_id?: number | null
  warehouse_name?: string | null
  supplier_id?: number | null
  subject_name?: string | null
  biz_date?: string | null
  ref_no?: string | null
  items: QcSourceLine[]
}

export interface QcRequestItem {
  id: number
  request_id: number
  line_no: number
  sku_id?: number | null
  sku_code?: string | null
  sku_name?: string | null
  spec?: string | null
  batch_no?: string | null
  qty: number
  sample_qty: number
  ac: number
  re: number
  defect_qty: number
  result: Qc2Result
  result_label?: string
  defect_code?: string | null
  defect_reason?: string | null
  remark?: string | null
  handled_qty?: number
  remain_handle_qty?: number
}

export interface QcEvent {
  action: string
  action_name: string
  from_state: string
  to_state: string
  actor_name?: string | null
  remark?: string | null
  created_at: string
}

export interface QcRequest {
  id: number
  doc_no: string
  source_type: QcSourceType
  source_label?: string
  source_id?: number | null
  source_doc_no?: string | null
  warehouse_id?: number | null
  warehouse_name?: string | null
  supplier_id?: number | null
  supplier_name?: string | null
  subject_name?: string | null
  request_date: string
  request_by_name?: string | null
  aql: number
  inspect_level: string
  total_qty: number
  total_sample_qty: number
  item_count: number
  inspection_id?: number | null
  inspection_no?: string | null
  status: 'draft' | 'submitted' | 'closed' | 'cancelled'
  remark?: string | null
  unqualified_lines?: number
  items?: QcRequestItem[]
  events?: QcEvent[]
}

export interface QcHandling {
  id: number
  doc_no: string
  inspection_id: number
  inspection_no?: string | null
  request_id?: number | null
  source_type?: QcSourceType
  source_label?: string
  warehouse_id?: number | null
  warehouse_name?: string | null
  sku_id?: number | null
  sku_code?: string | null
  sku_name?: string | null
  batch_no?: string | null
  qty: number
  mode: QcHandleMode
  mode_label?: string
  defect_code?: string | null
  reason?: string | null
  stock_direction: 'in' | 'out' | 'none'
  out_doc_type?: string | null
  out_doc_id?: number | null
  out_doc_no?: string | null
  status: 'draft' | 'confirmed' | 'cancelled'
  approved_by_name?: string | null
  approved_at?: string | null
  created_by_name?: string | null
  created_at?: string
  events?: QcEvent[]
  stock_effect?: { outDocType: string | null; outDocId: number | null; outDocNo: string | null }
}

export interface QcInspection {
  id: number
  doc_no: string
  request_id: number
  request_no?: string | null
  source_type: QcSourceType
  source_label?: string
  source_id?: number | null
  source_doc_no?: string | null
  warehouse_id?: number | null
  warehouse_name?: string | null
  supplier_id?: number | null
  supplier_name?: string | null
  inspect_date: string
  inspector_name?: string | null
  aql: number
  inspect_level: string
  total_qty: number
  sample_qty: number
  defect_qty: number
  defect_rate: number
  result: Qc2Result
  result_label?: string
  disposition: QcDisposition
  disposition_label?: string
  handling_count: number
  return_id?: number | null
  return_no?: string | null
  status: 'draft' | 'inspected' | 'closed' | 'cancelled'
  remark?: string | null
  items?: QcRequestItem[]
  handlings?: QcHandling[]
  handled_qty?: number
  events?: QcEvent[]
}

export interface Qc2Overview {
  pending_source: number
  requests: number
  requests_draft: number
  requests_submitted: number
  requests_closed: number
  inspections: number
  waiting_inspect: number
  qualified: number
  unqualified: number
  handlings: number
  handlings_draft: number
  handlings_confirmed: number
  scrap_qty: number
  return_qty: number
  concession_qty: number
  rework_qty: number
  defect_rate: number
  by_source: { source_type: string; label: string; c: number }[]
  by_mode: { mode: string; label: string; c: number; qty: number }[]
}

export interface QcAudit {
  badLineQty: any[]
  badVerdict: any[]
  headDrift: any[]
  inspDrift: any[]
  overHandle: any[]
  staleHandle: any[]
  closedWithDraft: any[]
  orphan: any[]
  missingStockEffect: any[]
  ok: boolean
  checked: string[]
}

export interface SamplePlan {
  qty: number
  sample_qty: number
  ac: number
  re: number
  code: string
  level: string
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

export const QC2_META = () => data<any>(api.get('/qc/meta'))

export const QC2_OVERVIEW = () => data<Qc2Overview>(api.get('/qc/overview'))

export const QC2_AUDIT = () => data<QcAudit>(api.get('/qc/audit'))

/** 抽样方案试算：建单前预览 n / Ac / Re */
export const QC2_SAMPLE_PLAN = (qty: number, level = 'normal') =>
  data<SamplePlan>(api.get('/qc/sample-plan', { qty, level }))

/** 待检来源（采购到货 + 生产完工） */
export const QC2_PENDING = (params?: Record<string, any>) =>
  data<{ list: QcPendingSource[]; total: number }>(api.get('/qc/pending', params))

/** 来源单据的行级装填 */
export const QC2_PENDING_DETAIL = (sourceType: QcSourceType, sourceId: number) =>
  data<QcSourceDetail>(api.get('/qc/pending/detail', { source_type: sourceType, source_id: sourceId }))

export const QC2_REQUESTS = (params?: Record<string, any>) =>
  data<{ rows: QcRequest[]; total: number; page: number; pageSize: number }>(api.get('/qc/requests', params))

export const QC2_REQUEST = (id: number) => data<QcRequest>(api.get(`/qc/requests/${id}`))

/** 建报检单（草稿） */
export const QC2_REQUEST_CREATE = (body: {
  source_type: QcSourceType
  source_id?: number
  request_date?: string
  aql?: number
  level?: string
  warehouse_id?: number
  items?: { source_item_id?: number | null; sku_id?: number | null; batch_no?: string; qty: number }[]
  remark?: string
}) => data<QcRequest>(api.post('/qc/requests', body))

/** 提交报检（同时生成一对一检验单草稿） */
export const QC2_REQUEST_SUBMIT = (id: number) =>
  data<{ request: QcRequest; inspection: QcInspection }>(api.post(`/qc/requests/${id}/submit`, {}))

export const QC2_REQUEST_CLOSE = (id: number) => data<QcRequest>(api.post(`/qc/requests/${id}/close`, {}))
export const QC2_REQUEST_CANCEL = (id: number, reason?: string) =>
  data<QcRequest>(api.post(`/qc/requests/${id}/cancel`, { remark: reason }))

export const QC2_INSPECTIONS = (params?: Record<string, any>) =>
  data<{ rows: QcInspection[]; total: number; page: number; pageSize: number }>(api.get('/qc/inspections', params))

export const QC2_INSPECTION = (id: number) => data<QcInspection>(api.get(`/qc/inspections/${id}`))

/** 提交检验结论（判定由服务端按不良数与 Ac/Re 推导） */
export const QC2_INSPECT_SUBMIT = (
  id: number,
  lines: { id: number; defect_qty: number; defect_code?: string; defect_reason?: string; remark?: string }[],
  remark?: string
) => data<QcInspection>(api.post(`/qc/inspections/${id}/submit`, { lines, remark }))

export const QC2_INSPECT_CLOSE = (id: number) => data<QcInspection>(api.post(`/qc/inspections/${id}/close`, {}))
export const QC2_INSPECT_CANCEL = (id: number, reason?: string) =>
  data<QcInspection>(api.post(`/qc/inspections/${id}/cancel`, { remark: reason }))

export const QC2_HANDLINGS = (params?: Record<string, any>) =>
  data<{ rows: QcHandling[]; total: number; page: number; pageSize: number }>(api.get('/qc/handlings', params))

export const QC2_HANDLING = (id: number) => data<QcHandling>(api.get(`/qc/handlings/${id}`))

/** 建不良品处理单（草稿） */
export const QC2_HANDLING_CREATE = (body: {
  inspection_id: number
  sku_id?: number | null
  batch_no?: string
  qty: number
  mode: QcHandleMode
  reason?: string
  defect_code?: string
  remark?: string
}) => data<QcHandling>(api.post('/qc/handlings', body))

/** 执行处理（唯一产生库存后果的动作） */
export const QC2_HANDLING_CONFIRM = (id: number, remark?: string) =>
  data<QcHandling>(api.post(`/qc/handlings/${id}/confirm`, { remark }))

export const QC2_HANDLING_CANCEL = (id: number, reason?: string) =>
  data<QcHandling>(api.post(`/qc/handlings/${id}/cancel`, { reason }))

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

export const QC_SOURCE_CLS: Record<string, string> = {
  purchase_receipt: 'text-sky-600 bg-sky-50 border-sky-200',
  production_order: 'text-violet-600 bg-violet-50 border-violet-200',
  inventory: 'text-slate-600 bg-slate-50 border-slate-200'
}

export const QC_STATUS_CLS: Record<string, string> = {
  draft: 'text-slate-600 bg-slate-50 border-slate-200',
  submitted: 'text-amber-600 bg-amber-50 border-amber-200',
  inspected: 'text-emerald-600 bg-emerald-50 border-emerald-200',
  closed: 'text-slate-500 bg-slate-100 border-slate-200',
  cancelled: 'text-slate-400 bg-slate-50 border-slate-200',
  confirmed: 'text-emerald-600 bg-emerald-50 border-emerald-200'
}

export const QC_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  submitted: '已报检',
  inspected: '已检',
  closed: '已关闭',
  cancelled: '已取消',
  confirmed: '已执行'
}

export const QC_RESULT_CLS: Record<string, string> = {
  pending: 'text-slate-600 bg-slate-50 border-slate-200',
  qualified: 'text-emerald-600 bg-emerald-50 border-emerald-200',
  unqualified: 'text-rose-600 bg-rose-50 border-rose-200'
}

export const QC_RESULT_LABEL: Record<string, string> = {
  pending: '待检',
  qualified: '合格',
  unqualified: '不合格'
}

export const QC_MODE_CLS: Record<string, string> = {
  concession: 'text-amber-600 bg-amber-50 border-amber-200',
  return: 'text-sky-600 bg-sky-50 border-sky-200',
  scrap: 'text-rose-600 bg-rose-50 border-rose-200',
  rework: 'text-violet-600 bg-violet-50 border-violet-200'
}

export const QC_MODE_LABEL: Record<string, string> = {
  concession: '让步接收',
  return: '退货',
  scrap: '报废',
  rework: '返工'
}

/**
 * 每种处置**执行后到底会发生什么**（一句话说清库存后果）。
 *
 * 客户口径：三种处置都必须真的动库存 ——
 *   报废 → 数量直接扣减；让步 → 调拨入不合格仓；返工 → 调拨入待检仓。
 * 文案的唯一出处就在这里：处置方式一多，最容易出的错是"代码改了、文案还写着不动库存"，
 * 或者更糟 ——「让步接收」被写成"可以正常卖"（那是把**批次级**的质检结论当成了仓级结论，
 * 而批次结论一置可售，留在原仓的那部分货也会被当成能卖）。
 */
export const QC_MODE_EFFECT: Record<string, string> = {
  scrap: '执行时报废出库（SCRAP_OUT）：数量**直接从当前仓扣减**，货不再存在。',
  return:
    '执行时按来源出库：采购来源生成采购退货单（PRT，含出库）；生产 / 在库来源走质检退料出库（QC_RET_OUT）。',
  concession:
    '执行时**自动生成一张调拨单**：当前仓 → 不合格品仓（出库 + 入库都真的发生）。批次仍判「不合格」，不能当可售货卖。',
  rework:
    '执行时**自动生成一张调拨单**：当前仓 → 待检品仓（出库 + 入库都真的发生）。批次退回「待检」，返工后可重新报检。'
}

/**
 * 无库存后果的处置方式 —— **现在一个都没有**。
 * 四种处置全部会真的动库存，所以界面上不再有「不动库存」这种状态；
 * 保留这个常量是为了让「有没有库存动作」这件事只有一个判据（而不是各处写死 mode 判断）。
 */
export const QC_MODE_NO_STOCK: QcHandleMode[] = []

export const QC_DEFECT_LABEL: Record<string, string> = {
  appearance: '外观不良',
  spec: '规格不符',
  packaging: '包装破损',
  expiry: '效期不足',
  batch: '批次错误',
  quality: '性能不达标',
  hygiene: '卫生指标',
  other: '其它'
}

export default {
  QC2_META,
  QC2_OVERVIEW,
  QC2_AUDIT,
  QC2_SAMPLE_PLAN,
  QC2_PENDING,
  QC2_PENDING_DETAIL,
  QC2_REQUESTS,
  QC2_REQUEST,
  QC2_REQUEST_CREATE,
  QC2_REQUEST_SUBMIT,
  QC2_REQUEST_CLOSE,
  QC2_REQUEST_CANCEL,
  QC2_INSPECTIONS,
  QC2_INSPECTION,
  QC2_INSPECT_SUBMIT,
  QC2_INSPECT_CLOSE,
  QC2_INSPECT_CANCEL,
  QC2_HANDLINGS,
  QC2_HANDLING,
  QC2_HANDLING_CREATE,
  QC2_HANDLING_CONFIRM,
  QC2_HANDLING_CANCEL,
  QC_MODE_EFFECT
}
