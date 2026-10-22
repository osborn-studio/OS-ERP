/**
 * ============================================================================
 * 文件标识：src/api/invoices.ts ｜ 模块 invoices（按文件名推断，待人工完善）
 * ============================================================================
 * 【职责】模块 invoices（按文件名推断，待人工完善）
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
 * 销售发票（模块 24）的前端配套。
 *
 * 这一页回答三个问题：
 *   · 哪些货发了票还没开？（待开票队列）
 *   · 开出去的票对应哪笔债权？（发票 ↔ 应收关联，两种口径）
 *   · 开错了怎么办？（红冲：原票留痕 + 关联应收作废 + 生成红字票）
 *
 * 前端同样要守住的三条口径（跟后端一一对应，改任何一处都要同步）：
 *   ① 开票不动库存 —— 界面上不提供任何"改库存"的入口。
 *   ② 开票关闭是可推导的 —— 不提供手工"关闭"按钮，`invoice_status` 由事实算出。
 *   ③ 红冲不删原票 —— 界面把原票与红字票并排展示，不隐藏任何一张。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface SalesInvoice {
  id: number
  doc_no: string
  org_id?: number | null
  subject_type: string
  subject_id: number
  subject_name?: string | null
  source_type: string
  source_id?: number | null
  source_doc_no?: string | null
  order_id?: number | null
  order_no?: string | null
  invoice_date: string
  invoice_no?: string | null
  invoice_type: 'normal' | 'red'
  tax_rate: number
  amount: number
  tax_amount: number
  total_amount: number
  currency?: string
  status: 'draft' | 'pending' | 'confirmed' | 'red_charted' | 'voided'
  ar_id?: number | null
  ar_doc_no?: string | null
  red_chart_of_id?: number | null
  remark?: string | null
  created_by_name?: string | null
  confirmed_by_name?: string | null
  confirmed_at?: string | null
  created_at?: string
  updated_at?: string
}

export interface SalesInvoiceItem {
  id: number
  invoice_id: number
  line_no: number
  sku_id?: number | null
  sku_code?: string | null
  sku_name?: string | null
  spec?: string | null
  qty: number
  price: number
  amount: number
  tax_rate: number
  tax_amount: number
  total_amount: number
  source_delivery_id?: number | null
  source_delivery_no?: string | null
  source_line_no?: number | null
}

export interface InvoiceArLink {
  id: number
  invoice_id: number
  ar_id: number
  delivery_id?: number | null
  amount: number
  relation: 'created' | 'linked'
  ar_no?: string
  ar_status?: string
  ar_amount?: number
  ar_allocated?: number
}

export interface InvoiceDetail extends SalesInvoice {
  items: SalesInvoiceItem[]
  links: InvoiceArLink[]
  red_invoices: { id: number; doc_no: string; total_amount: number; status: string }[]
  origin_invoice: { id: number; doc_no: string; status: string; total_amount: number } | null
}

/** 待开票队列的一行（一张发货单） */
export interface PendingDelivery {
  id: number
  doc_no: string
  order_id?: number | null
  order_no?: string | null
  delivery_date: string
  status: string
  total_qty: number
  total_amount: number
  invoice_status: 'none' | 'partial' | 'invoiced'
  invoice_qty_sum: number
  remain_qty: number
  subject_type: string
  subject_id: number
}

/** 某张发货单的逐行待开数量 */
export interface PendingLine {
  item_id: number
  sku_id: number
  batch_no?: string | null
  qty: number
  price: number
  amount: number
  invoiced_qty: number
  remain_qty: number
}

export interface InvoiceOverview {
  confirmed_count: number
  confirmed_amount: number
  tax_amount: number
  pending_confirm: number
  red_count: number
  red_amount: number
  pending_deliveries: number
  by_status: { status: string; c: number; amt: number }[]
}

export interface InvoiceAudit {
  headDrift: any[]
  overQty: any[]
  missingAr: any[]
  orphanLinks: any[]
  badClose: any[]
  ok: boolean
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

export const SI_META = () => data<any>(api.get('/invoices/meta'))

export const SI_OVERVIEW = () => data<InvoiceOverview>(api.get('/invoices/overview'))

/** 待开票队列：已发货/已签收且未开完票的发货单 */
export const SI_PENDING = (params?: Record<string, any>) =>
  data<{ rows: PendingDelivery[]; total: number }>(api.get('/invoices/pending', params))

/** 某张发货单的逐行待开数量 */
export const SI_PENDING_LINES = (deliveryId: number) =>
  data<{ delivery: any; lines: PendingLine[]; remain_total: number }>(api.get(`/invoices/pending/${deliveryId}`))

export const SI_LIST = (params?: Record<string, any>) =>
  data<{ rows: SalesInvoice[]; total: number; page: number; pageSize: number }>(api.get('/invoices/list', params))

export const SI_GET = (id: number) => data<InvoiceDetail>(api.get(`/invoices/${id}`))

export const SI_AUDIT = () => data<InvoiceAudit>(api.get('/invoices/audit'))

/** 由发货单开票（不传 items = 整单未开行一次开完；传 items 支持分批开票） */
export const SI_FROM_DELIVERY = (body: {
  delivery_id: number
  invoice_date?: string
  invoice_no?: string
  tax_rate?: number
  items?: { item_id: number; qty: number }[]
  remark?: string
}) => data<SalesInvoice>(api.post('/invoices/from-delivery', body))

/** 手工开票（无来源单据，补开历史票） */
export const SI_MANUAL = (body: {
  subject_type: string
  subject_id: number
  subject_name?: string
  invoice_date?: string
  invoice_no?: string
  tax_rate?: number
  items: { sku_id?: number | null; qty: number; price: number; total_amount?: number; tax_rate?: number }[]
  remark?: string
}) => data<SalesInvoice>(api.post('/invoices/manual', body))

export const SI_SUBMIT = (id: number) => data<InvoiceDetail>(api.post(`/invoices/${id}/submit`, {}))

/** 确认开票：唯一有后果的动作（生成/关联应收 + 回写开票关闭） */
export const SI_CONFIRM = (id: number, creditDays?: number) =>
  data<{ invoice: InvoiceDetail; ar: any; relation: string; ar_mode: string }>(
    api.post(`/invoices/${id}/confirm`, creditDays == null ? {} : { credit_days: creditDays })
  )

/** 红冲：原票留痕 + 关联应收作废 + 生成红字票 */
export const SI_RED_CHART = (id: number, reason: string) =>
  data<{ invoice: InvoiceDetail; red: InvoiceDetail }>(api.post(`/invoices/${id}/red-chart`, { reason }))

/** 作废（仅草稿/待确认） */
export const SI_VOID = (id: number, reason?: string) =>
  data<InvoiceDetail>(api.post(`/invoices/${id}/void`, { reason }))

/** 运维兜底：重推开票关闭状态 */
export const SI_REFRESH_CLOSE = () =>
  data<{ deliveries: number; orders: number }>(api.post('/invoices/refresh-close', {}))

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

export const SI_STATUS_CLS: Record<string, string> = {
  draft: 'text-slate-600 bg-slate-50 border-slate-200',
  pending: 'text-amber-600 bg-amber-50 border-amber-200',
  confirmed: 'text-emerald-600 bg-emerald-50 border-emerald-200',
  red_charted: 'text-rose-600 bg-rose-50 border-rose-200',
  voided: 'text-slate-500 bg-slate-100 border-slate-200'
}

export const SI_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  pending: '待确认',
  confirmed: '已开票',
  red_charted: '已红冲',
  voided: '已作废'
}

export const INVOICE_STATUS_CLS: Record<string, string> = {
  none: 'text-slate-600 bg-slate-50 border-slate-200',
  partial: 'text-amber-600 bg-amber-50 border-amber-200',
  invoiced: 'text-emerald-600 bg-emerald-50 border-emerald-200'
}

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  none: '未开票',
  partial: '部分开票',
  invoiced: '已开票'
}

export default {
  SI_META,
  SI_OVERVIEW,
  SI_PENDING,
  SI_PENDING_LINES,
  SI_LIST,
  SI_GET,
  SI_AUDIT,
  SI_FROM_DELIVERY,
  SI_MANUAL,
  SI_SUBMIT,
  SI_CONFIRM,
  SI_RED_CHART,
  SI_VOID,
  SI_REFRESH_CLOSE
}
