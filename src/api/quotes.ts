/**
 * ============================================================================
 * 文件标识：src/api/quotes.ts ｜ 模块 quotes（按文件名推断，待人工完善）
 * ============================================================================
 * 【职责】模块 quotes（按文件名推断，待人工完善）
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
 * 销售报价与信用控制（模块 08A）的前端配套。
 *
 * 这一块回答的是销售与财务各问的两个问题：
 *   · 这个价是怎么报出去的？还能不能转成订单？（报价单：取价 / 有效期 / 审批 / 转单）
 *   · 这家客户还能下多少货？（信用：额度 / 账期 / 已用 / 超信谁放的）
 *
 * 前端也要守住的口径：
 *   ① 报价行的价不是手填的：每行都有 price_source / price_rule，
 *      界面必须能回答「为什么是这个价」；手工改过的行要标出来（overridden）。
 *   ② 有效期是硬约束：已过期或未审批的报价，「转订单」按钮不出现 ——
 *      不是点了之后报错，是根本不该让人点。
 *   ③ 转单只能成功一次：已转单的报价只显示「查看订单」。
 *   ④ 额度只有一个真相：已用额来自台账（含订货中心同主体占用），
 *      不读经销商档案上的缓存列；超信要放行必须填理由。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface QuoteItem {
  id?: number
  line_no: number
  sku_id: number
  sku_code?: string
  sku_name?: string
  spec?: string
  qty: number
  list_price: number
  price: number
  price_source?: string
  price_rule?: string
  price_trace?: string
  discount_rate: number
  amount: number
  min_price: number
  below_min: number
  available_qty?: number | null
  overridden?: boolean
}

export interface Quote {
  id: number
  doc_no: string
  source_quote_id?: number | null
  version: number
  customer_type: string
  dealer_id?: number | null
  customer_id?: number | null
  store_id?: number | null
  dealer_name?: string
  customer_name?: string
  store_name?: string
  channel?: string
  warehouse_id?: number | null
  quote_date: string
  valid_from: string
  valid_to: string
  status: string
  goods_amount: number
  freight: number
  tax_rate: number
  tax_amount: number
  total_amount: number
  gross_rate: number
  below_min_count: number
  need_approval: number
  approval_reason?: string | null
  approved_by_name?: string | null
  approved_at?: string | null
  converted_type?: string | null
  converted_order_id?: number | null
  converted_doc_no?: string | null
  remark?: string | null
  items?: QuoteItem[]
  expired?: boolean
  converted?: boolean
}

export interface QuotePriceResult {
  lines: QuoteItem[]
  goods_amount: number
  freight: number
  tax_rate: number
  tax_amount: number
  total_amount: number
  gross_rate: number
  below_min_count: number
  need_approval: number
  approval_reason?: string | null
}

export interface CreditAccount {
  account_id: number
  subject_type: string
  subject_id: number
  code?: string
  name?: string
  status: string
  frozen_reason?: string | null
  credit_limit: number
  temp_limit: number
  temp_expire_at?: string | null
  limit: number
  used: number
  own_used: number
  oc_used: number
  available: number
  credit_days: number
  settle_type?: string | null
  overdue_amount: number
  overdue_days: number
  usage_rate: number
}

export interface CreditLedgerRow {
  id: number
  account_id: number
  account_name?: string
  change_type: string
  source_type: string
  source_id?: number | null
  doc_no?: string | null
  amount: number
  balance_after: number
  due_date?: string | null
  operator?: string | null
  remark?: string | null
  created_at: string
}

export interface CreditCheckRow {
  id: number
  account_id?: number | null
  account_name?: string
  scene: string
  source_type?: string | null
  doc_no?: string | null
  amount: number
  available: number
  over_amount: number
  overdue_days: number
  result: string
  reason?: string | null
  operator?: string | null
  created_at: string
}

export interface CreditCheckResult {
  pass: boolean
  blocking: { code: string; level: string; message: string }[]
  warnings: { code: string; level: string; message: string }[]
  checks: { code: string; level: string; message: string }[]
  result: string
  account: CreditAccount | null
  available: number
  over_amount: number
  credit_days?: number
  due_date?: string | null
}

export interface CreditOverview {
  account_count: number
  total_limit: number
  total_used: number
  total_available: number
  overdue_count: number
  frozen_count: number
  risk: (CreditAccount & { reasons: string[] })[]
  exceptions: CreditCheckRow[]
  audit: { ledger_balance_drift: any[]; order_hold_diff: any[]; balanced: boolean }
}

// ---------------------------------------------------------------------------
// 报价单接口
// ---------------------------------------------------------------------------

export const QUOTE_META = () =>
  data<{
    statuses: { value: string; label: string }[]
    customer_types: { value: string; label: string }[]
    channels: { value: string; label: string }[]
    convert_targets: { value: string; label: string }[]
    approval_amount_threshold: number
    valid_days_default: number
  }>(api.get('/sales/quotes/meta'))

export const QUOTE_OVERVIEW = () =>
  data<{
    status_counts: Record<string, { value: string; label: string; count: number }>
    pending_approval: number
    expiring_soon: { id: number; doc_no: string; valid_to: string; total_amount: number }[]
    converted_amount: number
  }>(api.get('/sales/quotes/overview'))

export const QUOTE_LIST = (params?: {
  status?: string
  customer_type?: string
  dealer_id?: number
  keyword?: string
  valid_only?: 0 | 1
  page?: number
  pageSize?: number
}) => data<{ rows: Quote[]; total: number; page: number; pageSize: number }>(api.get('/sales/quotes', params))

export const QUOTE_DETAIL = (id: number) => data<Quote>(api.get(`/sales/quotes/${id}`))

/** 取价试算：不落库，新增报价前先看价 */
export const QUOTE_PRICE = (payload: {
  items: { sku_id: number; qty: number; price?: number }[]
  customer_type?: string
  dealer_id?: number | null
  customer_id?: number | null
  store_id?: number | null
  channel?: string | null
  warehouse_id?: number | null
  freight?: number
  tax_rate?: number
}) => data<QuotePriceResult>(api.post('/sales/quotes/price', payload))

export const QUOTE_CREATE = (payload: {
  customer_type?: string
  dealer_id?: number | null
  customer_id?: number | null
  store_id?: number | null
  channel?: string | null
  warehouse_id?: number | null
  quote_date?: string
  valid_days?: number
  valid_to?: string
  items: { sku_id: number; qty: number; price?: number }[]
  freight?: number
  tax_rate?: number
  remark?: string
  source_quote_id?: number | null
}) => data<Quote>(api.post('/sales/quotes', payload))

/** 流转：submit / approve / reject / resubmit / cancel */
export const QUOTE_ACTION = (id: number, action: string, remark?: string) =>
  data<Quote>(api.post(`/sales/quotes/${id}/action`, { action, remark }))

/** 转单：唯一有后果的动作。force+reason = 超信特批放行 */
export const QUOTE_CONVERT = (
  id: number,
  payload?: { target?: 'SO' | 'OC'; force?: boolean; reason?: string; order_date?: string; remark?: string }
) =>
  data<{ reused: boolean; quote: Quote; order: { id: number; doc_no: string; type?: string } | null; credit: CreditCheckResult | null; converted_type?: string }>(
    api.post(`/sales/quotes/${id}/convert`, payload || {})
  )

export const QUOTE_COPY = (id: number, payload?: { valid_days?: number; remark?: string }) =>
  data<Quote>(api.post(`/sales/quotes/${id}/copy`, payload || {}))

/** 批量把过期报价置为「已过期」（系统动作） */
export const QUOTE_EXPIRE = (payload?: { at?: string }) =>
  data<{ expired: number }>(api.post('/sales/quotes/expire', payload || {}))

// ---------------------------------------------------------------------------
// 信用控制接口
// ---------------------------------------------------------------------------

export const CREDIT_META = () =>
  data<{
    change_types: { value: string; label: string }[]
    check_results: { value: string; label: string }[]
    account_status: { value: string; label: string }[]
    subject_types: { value: string; label: string }[]
  }>(api.get('/credit/meta'))

export const CREDIT_OVERVIEW = () => data<CreditOverview>(api.get('/credit/overview'))

export const CREDIT_ACCOUNTS = (params?: { subject_type?: string; status?: string; keyword?: string; page?: number; pageSize?: number }) =>
  data<{ rows: CreditAccount[]; total: number; page: number; pageSize: number }>(api.get('/credit/accounts', params))

export const CREDIT_ACCOUNT = (id: number) =>
  data<{ account: CreditAccount; ledger: CreditLedgerRow[]; checks: CreditCheckRow[] }>(
    api.get(`/credit/accounts/${id}`)
  )

export const CREDIT_CREATE_ACCOUNT = (payload: { subject_type: string; subject_id: number }) =>
  data<CreditAccount>(api.post('/credit/accounts', payload))

export const CREDIT_UPDATE_ACCOUNT = (
  id: number,
  payload: { credit_limit?: number; credit_days?: number; temp_limit?: number; temp_expire_at?: string | null; status?: string; frozen_reason?: string | null; remark?: string }
) => data<CreditAccount>(api.post(`/credit/accounts/${id}`, payload))

/** 只校验不写单：下单/转单前问一句「够不够」 */
export const CREDIT_CHECK = (payload: {
  dealer_id?: number | null
  customer_id?: number | null
  store_id?: number | null
  account_id?: number | null
  amount: number
  scene?: string
  force?: boolean
  reason?: string
}) => data<CreditCheckResult>(api.post('/credit/check', payload))

export const CREDIT_LEDGER = (params?: { account_id?: number; source_type?: string; source_id?: number; limit?: number }) =>
  data<CreditLedgerRow[]>(api.get('/credit/ledger', params))

export const CREDIT_CHECKS = (params?: { account_id?: number; result?: string; limit?: number }) =>
  data<CreditCheckRow[]>(api.get('/credit/checks', params))

/** 回款核销：货发了钱没到，额度仍占着；钱到了才释放 */
export const CREDIT_SETTLE = (payload: {
  dealer_id?: number | null
  customer_id?: number | null
  account_id?: number | null
  amount: number
  source_type?: string
  source_id?: number | null
  doc_no?: string
  remark?: string
}) => data<{ ledger: any; account: CreditAccount }>(api.post('/credit/settle', payload))

/** 人工调整占用（坏账核销等），必填原因 */
export const CREDIT_ADJUST = (payload: {
  dealer_id?: number | null
  customer_id?: number | null
  account_id?: number | null
  amount: number
  remark: string
}) => data<{ ledger: any; account: CreditAccount }>(api.post('/credit/adjust', payload))

export const CREDIT_AUDIT = () =>
  data<{ ledger_balance_drift: any[]; order_hold_diff: any[]; balanced: boolean }>(api.get('/credit/audit'))

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/** 报价单状态徽标：绿=可转单，蓝=审批通过待处理，灰=已终结 */
export const QUOTE_STATUS_CLS: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  submitted: 'bg-amber-100 text-amber-700',
  approved: 'bg-blue-100 text-blue-700',
  rejected: 'bg-orange-100 text-orange-700',
  converted: 'bg-green-100 text-green-700',
  expired: 'bg-slate-100 text-slate-400',
  cancelled: 'bg-slate-100 text-slate-400'
}

/** 信用校验结论徽标：红=拦住，橙=特批放行，蓝=预警，灰=通过 */
export const CHECK_RESULT_CLS: Record<string, string> = {
  pass: 'bg-slate-100 text-slate-600',
  warn: 'bg-blue-100 text-blue-700',
  block: 'bg-red-100 text-red-700',
  force: 'bg-orange-100 text-orange-700'
}

/** 台账变更方向：占用为红（额度变少），释放/核销为绿（额度回来） */
export const ledgerAmountCls = (amount: number) =>
  amount > 0 ? 'text-red-600' : amount < 0 ? 'text-green-600' : 'text-slate-500'
