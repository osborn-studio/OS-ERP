/**
 * ============================================================================
 * 文件标识：src/api/ar.ts ｜ 模块 ar（按文件名推断，待人工完善）
 * ============================================================================
 * 【职责】模块 ar（按文件名推断，待人工完善）
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import api from './client'
import type { CreditEffect } from '../utils/credit-effect'

/** 统一拆信封：接口返回 { code, success, data }，页面只关心 data（与 useFetch 一致） */
const data = <T>(p: Promise<any>): Promise<T> => p.then((r) => r.data as T)

/**
 * 应收与收款核销（模块 21）的前端配套。
 *
 * 这一页回答财务每天要答的三个问题：
 *   · 外面还欠我多少钱？（应收单：未收余额 / 到期日 / 逾期天数）
 *   · 钱收到了抵的是哪一笔？（收款单 + 核销明细）
 *   · 哪几家该催了？（账龄四桶 + 客户风险榜 + 对账单）
 *
 * 前端同样要守住的三条口径（跟后端一一对应，改任何一处都要同步）：
 *   ① 已收金额永远由核销明细 SUM 算出 —— 界面上不提供「直接改已收金额」的入口，
 *      要改就改核销关系，余额自己重算。
 *   ② 核销生效点 = 收款单确认 —— 草稿收款单上的核销只是「计划」，
 *      列里要标出来，且确认按钮要显式提示「确认后释放授信占用」。
 *   ③ 金额必须能由明细重算 —— 总览页把 auditAr 的结果摆在最下面，
 *      有任何漂移，页面上要看得见，而不是等财务月底对不上账才发现。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface ArDocument {
  id: number
  doc_no: string
  subject_type: string
  subject_id: number
  subject_name?: string
  source_type?: string
  source_id?: number | null
  source_doc_no?: string | null
  biz_date: string
  due_date: string
  amount: number
  allocated_amount: number
  balance?: number
  status: 'open' | 'partial' | 'closed' | 'voided'
  credit_days?: number
  remark?: string | null
  overdue_days?: number
  allocations?: ReceiptAllocation[]
}

export interface ReceiptAllocation {
  id?: number
  receipt_id?: number
  ar_id: number
  amount: number
  ar_no?: string
  receipt_no?: string
  source_doc_no?: string | null
  receipt_date?: string
  receipt_status?: string
  due_date?: string
  ar_amount?: number
  method?: string
}

export interface Receipt {
  id: number
  doc_no: string
  subject_type: string
  subject_id: number
  subject_name?: string
  receipt_date: string
  amount: number
  allocated_amount: number
  unallocated_amount?: number
  method: string
  bank_account?: string | null
  serial_no?: string | null
  status: 'draft' | 'confirmed' | 'voided'
  remark?: string | null
  allocations?: ReceiptAllocation[]
  /** 仅 POST /confirm 响应（ADR-0013）：本次释放的授信台账行与合计 */
  credit_released?: CreditEffect
  /** 仅 POST /void 响应（ADR-0013）：本次恢复的占用；legacy=true 为迁移前收款单的旧口径 */
  credit_reversal?: CreditEffect
  // ADR-0018：证据与二人复核（内核 status 在待复核期间仍是 draft）
  evidence_ref?: string | null
  evidence_note?: string | null
  review_status?: FundsReviewStatus | null
  review?: FundsReview | null
}

export type FundsReviewStatus = 'pending_review' | 'approved' | 'rejected'
export interface FundsReview {
  status: FundsReviewStatus | null
  maker: { id: number | null; name: string | null; at: string | null } | null
  checker: { id: number | null; name: string | null } | null
  decided_at: string | null
  comment: string | null
  evidence_ref: string | null
  evidence_note: string | null
}

export interface ArOverview {
  ar_count: number
  ar_amount: number
  ar_allocated: number
  open_count: number
  open_amount: number
  overdue_count: number
  overdue_amount: number
  receipt_count: number
  receipt_amount: number
  draft_receipt_count: number
  draft_receipt_amount: number
  aging: AgingSummary
  top_overdue?: AgingSubjectRow[]
}

export interface AgingSummary {
  buckets: { b0: number; b1: number; b2: number; b3: number }
  total_outstanding: number
  overdue: number
  count: number
}

export interface AgingSubjectRow {
  subject_type: string
  subject_id: number
  subject_name?: string
  balance: number
  overdue_amount: number
  earliest_due?: string
  ar_count: number
  max_overdue_days?: number
}

/** 逐笔账龄：一行 = 一张应收单（催收要看的就是这一行一行） */
export interface AgingDetailRow extends ArDocument {
  open_amount: number
  bucket: 'b0' | 'b1' | 'b2' | 'b3' | 'settled'
}

export interface AgingDetail {
  rows: AgingDetailRow[]
  summary: { b0: number; b1: number; b2: number; b3: number; settled: number }
  total_open: number
  total_overdue: number
  count: number
}

/** 预收：客户存在我方的余额 */
export interface PrepayRow {
  subject_type: string
  subject_id: number
  subject_name?: string
  received_amount: number
  allocated_amount: number
  prepay_balance: number
}

export interface PrepayDetail {
  receipts: {
    id: number
    doc_no: string
    receipt_date: string
    method: string
    amount: number
    allocated: number
    left_amount: number
  }[]
  open_ars: { id: number; doc_no: string; source_doc_no?: string | null; due_date?: string; open_amount: number }[]
  prepay_total: number
  open_total: number
}

/** 订货中心待并入应收的订货单 */
export interface OcPendingRow {
  id: number
  doc_no: string
  customer_id: number
  customer_name?: string
  order_date: string
  total_amount: number
  status: string
  ship_warehouse_id?: number | null
}

export interface Statement {
  subject_type: string
  subject_id: number
  subject_name?: string
  from?: string | null
  to?: string | null
  ar_total: number
  receipt_total: number
  allocated_total: number
  balance: number
  unallocated_receipt: number
  ars: ArDocument[]
  receipts: Receipt[]
  allocations: ReceiptAllocation[]
}

export interface ArAudit {
  drift: any[]
  badStatus: any[]
  overAlloc: any[]
  rcDrift: any[]
  ok: boolean
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

export const AR_META = () => data<any>(api.get('/ar/meta'))

export const AR_OVERVIEW = () => data<ArOverview>(api.get('/ar/overview'))

export const AR_AGING = (params?: Record<string, any>) =>
  data<{ buckets?: AgingSummary['buckets']; total_outstanding?: number; overdue?: number; rows: AgingSubjectRow[] }>(
    api.get('/ar/aging', params)
  )

/** 逐笔账龄：一行一张单（bucket 过滤 settled / b0~b3） */
export const AR_AGING_DETAIL = (params?: Record<string, any>) => data<AgingDetail>(api.get('/ar/aging/detail', params))

/** 客户级逐笔汇总（催收风险榜） */
export const AR_AGING_SUBJECTS = () =>
  data<{ rows: AgingSubjectRow[] }>(api.get('/ar/aging/subjects'))

// ---------- 预收 ----------
export const AR_PREPAY = (params?: Record<string, any>) =>
  data<{ rows: PrepayRow[]; total: number; count: number }>(api.get('/ar/prepay', params))

export const AR_PREPAY_DETAIL = (subjectType: string, subjectId: number) =>
  data<PrepayDetail>(api.get('/ar/prepay/detail', { subject_type: subjectType, subject_id: subjectId }))

/** 预收转应收：指定应收单（ar_id）或传 auto 按到期日 FIFO 自动抵扣 */
export const AR_PREPAY_APPLY = (body: { receipt_id: number; ar_id?: number; amount?: number; auto?: boolean }) =>
  data<{
    receipt: Receipt
    plan: { ar_id: number; amount: number }[]
    applied: number
    remaining: number
    /** ADR-0013：本次抵扣按来源释放的授信（形状同确认收款） */
    credit_released?: CreditEffect
  }>(api.post('/ar/prepay/apply', body))

// ---------- 订货中心并入 ----------
/** 已收货但还没生成应收的订货单（历史遗留与开关关闭期） */
export const AR_OC_PENDING = (params?: Record<string, any>) =>
  data<{ rows: OcPendingRow[]; total: number; count: number }>(api.get('/ar/oc/pending', params))

/** 一键把待并入的订货单生成应收（幂等，可重复跑） */
export const AR_OC_SYNC = (body?: { limit?: number; customer_id?: number }) =>
  data<{ created: any[]; count: number; total_amount: number }>(api.post('/ar/oc/sync', body || {}))

export const AR_AUDIT = () => data<ArAudit>(api.get('/ar/audit'))

export const AR_STATEMENT = (subjectType: string, subjectId: number, from?: string, to?: string) =>
  data<Statement>(api.get('/ar/statement', { subject_type: subjectType, subject_id: subjectId, from, to }))

export const AR_LIST = (params?: Record<string, any>) =>
  data<{ rows: ArDocument[]; total: number; page: number; pageSize: number }>(api.get('/ar/documents', params))

export const AR_GET = (id: number) => data<ArDocument>(api.get(`/ar/documents/${id}`))

export const AR_CREATE = (body: any) => data<ArDocument>(api.post('/ar/documents', body))

/** 由销售订单批量生成应收单（幂等：已生成过的订单会跳过） */
export const AR_GENERATE = (body: { source_type?: string; items?: { source_id: number }[] }) =>
  data<{ created: any[]; skipped: any[] }>(api.post('/ar/documents/generate', body))

export const RC_LIST = (params?: Record<string, any>) =>
  data<{ rows: Receipt[]; total: number; page: number; pageSize: number }>(api.get('/ar/receipts', params))

export const RC_GET = (id: number) => data<Receipt>(api.get(`/ar/receipts/${id}`))

export const RC_CREATE = (body: any) => data<Receipt>(api.post('/ar/receipts', body))

/** 确认收款：核销在此刻生效，并释放授信占用 */
/** 确认收款（ADR-0018）：必须带凭证号；达到复核阈值时响应 `review.status='pending_review'`，status 仍是 draft */
export const RC_CONFIRM = (id: number, evidence: { evidence_ref?: string; evidence_note?: string } = {}, releaseCredit = true) =>
  data<Receipt>(api.post(`/ar/receipts/${id}/confirm`, { release_credit: releaseCredit, ...evidence }))

/** 第二人复核（需 finance.funds.review）：approve 真正核销；reject 退回草稿（comment 必填） */
export const RC_REVIEW = (id: number, decision: 'approve' | 'reject', comment?: string) =>
  data<Receipt>(api.post(`/ar/receipts/${id}/review`, { decision, comment }))

/** 作废收款：核销回退；不会自动回收已释放的授信，需显式补占用 */
export const RC_VOID = (id: number, reason: string) => data<Receipt>(api.post(`/ar/receipts/${id}/void`, { reason }))

/** 按往来对象重算应收余额（兜底修复，正常不需要点） */
export const AR_RECALC = (body?: { subject_type?: string; subject_id?: number }) =>
  data<{ recalculated: number }>(api.post('/ar/recalc', body || {}))

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

export const AR_STATUS_CLS: Record<string, string> = {
  open: 'text-amber-600 bg-amber-50 border-amber-200',
  partial: 'text-blue-600 bg-blue-50 border-blue-200',
  closed: 'text-emerald-600 bg-emerald-50 border-emerald-200',
  voided: 'text-slate-500 bg-slate-50 border-slate-200'
}

export const AR_STATUS_LABEL: Record<string, string> = {
  open: '未收款',
  partial: '部分收款',
  closed: '已结清',
  voided: '已作废'
}

export const RC_STATUS_CLS: Record<string, string> = {
  draft: 'text-slate-600 bg-slate-50 border-slate-200',
  confirmed: 'text-emerald-600 bg-emerald-50 border-emerald-200',
  voided: 'text-red-600 bg-red-50 border-red-200'
}

export const RC_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  confirmed: '已收款',
  voided: '已作废'
}

/** 复核状态文案与着色（与 server/lib/funds-review.js 的 FUNDS_REVIEW_LABEL 同源） */
export const FUNDS_REVIEW_LABEL: Record<string, string> = {
  pending_review: '待复核',
  approved: '复核通过',
  rejected: '复核驳回'
}
export const FUNDS_REVIEW_CLS: Record<string, string> = {
  pending_review: 'text-amber-700 bg-amber-50 border-amber-200',
  approved: 'text-emerald-600 bg-emerald-50 border-emerald-200',
  rejected: 'text-red-600 bg-red-50 border-red-200'
}
export const FUNDS_REVIEW_PERM = 'finance.funds.review'

/** 逾期天数着色：越久越红（财务看板的第一眼信号） */
export function overdueCls(days: number): string {
  if (days <= 0) return 'text-slate-600'
  if (days <= 30) return 'text-amber-600 font-medium'
  if (days <= 60) return 'text-orange-600 font-medium'
  return 'text-red-600 font-semibold'
}

export default {
  AR_META,
  AR_OVERVIEW,
  AR_AGING,
  AR_AGING_DETAIL,
  AR_AGING_SUBJECTS,
  AR_PREPAY,
  AR_PREPAY_DETAIL,
  AR_PREPAY_APPLY,
  AR_OC_PENDING,
  AR_OC_SYNC,
  AR_AUDIT,
  AR_STATEMENT,
  AR_LIST,
  AR_GET,
  AR_CREATE,
  AR_GENERATE,
  RC_LIST,
  RC_GET,
  RC_CREATE,
  RC_CONFIRM,
  RC_REVIEW,
  RC_VOID,
  AR_RECALC
}
