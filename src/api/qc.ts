/**
 * ============================================================================
 * 文件标识：src/api/qc.ts ｜ 模块 qc（按文件名推断，待人工完善）
 * ============================================================================
 * 【职责】模块 qc（按文件名推断，待人工完善）
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import api from './client'

/** 统一拆信封：接口返回 { code, success, data }，页面只关心 data（与 useFetch 一致） */
const data = <T>(p: Promise<any>): Promise<T> => p.then((r) => r.data as T)

/**
 * 采购质检（模块 07：到货单与质检单拆分）的前端配套。
 *
 * 这一页存在的理由：**到货单记事实，质检单记判断**。
 *   「送来了多少件」是称出来的、看得见的，不含立场；
 *   「收不收、收多少、为什么」是人的判断，它需要单独一份记录，因为：
 *     · 判断要能被统计（供应商判退率是选供应商的硬指标）；
 *     · 判断要有后果（判退得生成退货单、退出正品库存、追责到批次）；
 *     · 判断与事实的时间会错开（货到是今天，结论可能是明天）。
 *
 * 三条前端也要守住的口径：
 *   ① 行内三数（合格 / 让步 / 判退）之和**必须**等于到货数量 ——
 *      界面上直接算出来提示，别等到提交才报错。
 *   ② 判退是唯一有后果的输入：它会在提交时生成退货单并出库，
 *      库存不够会整单失败（所以别把判退量随手填大）。
 *   ③ 「待质检」包含**已建草稿但没提交**的到货单 —— 提交失败会留下草稿，
 *      如果前端按「有质检单就算检过」过滤，这张单会从工作台上彻底消失。
 */

export type QcResult = 'pending' | 'qualified' | 'concession' | 'partial_rejected' | 'rejected'

export interface InspectionItem {
  id: number
  line_no: number
  receipt_item_id: number | null
  sku_id: number
  sku_code?: string
  sku_name?: string
  batch_no?: string | null
  /** 到货数量（事实，来自到货单行） */
  qty: number
  qualified_qty: number
  concession_qty: number
  rejected_qty: number
  defect_code?: string | null
  defect_reason?: string | null
  remark?: string | null
}

export interface Inspection {
  id: number
  doc_no: string
  receipt_id: number
  receipt_no?: string | null
  receipt_date?: string | null
  order_id?: number | null
  order_no?: string | null
  supplier_id: number
  supplier_name?: string | null
  warehouse_id: number
  warehouse_name?: string | null
  inspect_date: string
  inspect_by_name?: string | null
  result: QcResult
  result_label?: string
  total_qty: number
  qualified_qty: number
  concession_qty: number
  rejected_qty: number
  return_id?: number | null
  return_no?: string | null
  status: string
  remark?: string | null
  items: InspectionItem[]
  events?: { action: string; action_name?: string; from_state?: string; to_state?: string; actor_name?: string; remark?: string; created_at: string }[]
}

/** 待质检的到货单。draft_id/draft_no 非空表示这张上已经有一张**没提交**的草稿 */
export interface PendingReceipt {
  id: number
  doc_no: string
  receipt_date: string
  total_qty: number
  total_amount: number
  supplier_name?: string | null
  warehouse_name?: string | null
  order_no?: string | null
  inspector?: string | null
  line_count: number
  draft_id?: number | null
  draft_no?: string | null
}

export interface QcOverview {
  total: number
  pending: number
  inspected: number
  closed: number
  waiting_receipts: number
  draft_ready: number
  rejected_qty: number
  rejected_amount: number
  concession_qty: number
  returns_created: number
  reject_rate: number
}

export interface QcMeta {
  results: { value: QcResult; label: string }[]
  defect_codes: { value: string; label: string }[]
}

/** 提交时按**质检单行 id** 覆盖（不是到货单行 id） */
export interface InspectionLinePatch {
  id: number
  qualified_qty?: number
  concession_qty?: number
  rejected_qty?: number
  defect_code?: string | null
  defect_reason?: string | null
  remark?: string | null
}

export const QC_META = () => data<QcMeta>(api.get('/purchase/inspections/meta'))
export const QC_OVERVIEW = () => data<QcOverview>(api.get('/purchase/inspections/overview'))
export const QC_PENDING = (limit = 100) => data<{ list: PendingReceipt[] }>(api.get('/purchase/inspections/pending', { limit }))
export const QC_RECEIPT = (receiptId: number) =>
  data<{ items: InspectionItem[]; inspection: Inspection | null } & Record<string, any>>(api.get(`/purchase/inspections/receipt/${receiptId}`))
export const QC_CREATE = (payload: { receipt_id: number; inspect_date?: string; remark?: string; items?: any[] }) =>
  data<Inspection>(api.post('/purchase/inspections', payload))
export const QC_SUBMIT = (id: number, payload: { lines?: InspectionLinePatch[]; remark?: string }) =>
  data<Inspection & { return_created: { id: number; doc_no: string } | null }>(api.post(`/purchase/inspections/${id}/submit`, payload))
export const QC_CLOSE = (id: number) => data<Inspection>(api.post(`/purchase/inspections/${id}/close`, {}))
export const QC_CANCEL = (id: number, remark?: string) => data<Inspection>(api.post(`/purchase/inspections/${id}/cancel`, { remark }))

/** 结论对应的颜色（与看板 / 状态徽标同一套：红=问题，绿=正常，橙=留意） */
export const RESULT_CLS: Record<string, string> = {
  qualified: 'bg-green-100 text-green-700',
  concession: 'bg-orange-100 text-orange-700',
  partial_rejected: 'bg-red-100 text-red-600',
  rejected: 'bg-red-100 text-red-700',
  pending: 'bg-slate-100 text-slate-600'
}

/** 行内三数是否闭合 —— 界面实时提示，不必等到提交被服务端拒绝 */
export const lineClosed = (l: { qty: number; qualified_qty: number; concession_qty: number; rejected_qty: number }) =>
  Math.abs(
    Number(l.qualified_qty || 0) + Number(l.concession_qty || 0) + Number(l.rejected_qty || 0) - Number(l.qty || 0)
  ) < 0.005
