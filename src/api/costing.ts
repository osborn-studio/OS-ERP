/**
 * ============================================================================
 * 文件标识：src/api/costing.ts ｜ 模块 costing（按文件名推断，待人工完善）
 * ============================================================================
 * 【职责】模块 costing（按文件名推断，待人工完善）
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
 * 存货核算与成本（模块 09）的前端配套。
 *
 * 这一页回答的是财务每个月必问的三个问题：
 *   · 这个月的成本是多少？（三层：期初 + 入 − 出 = 期末）
 *   · 暂估和实票差了多少？差在哪？（差异台账 + 调整单）
 *   · 账能不能对上？（自洽审计：流水累计 vs 结存金额）
 *
 * 前端也要守住的口径：
 *   ① 三层恒等式：期初 + 本期入 − 本期出 = 截至期末；「现存量」还会多一段
 *      「期末之后的流水」（期间没结转时，今天 ≠ 期末）。residual ≠ 0 才是真错。
 *   ② 暂估差异有两个口径：**成本口径**（可回写到批次的，只来自入库行的费用摊入）
 *      与**发票口径**（还没开票的差额，落不到批次）。待办只列前者 —— 后者是
 *      应付的事，不是成本的事，混在一起会出现一条永远做不掉的待办。
 *   ③ 确认调整（adjust）是唯一有后果的动作：改结存单价/金额、写成本台账；
 *      建单只是草稿。已售出部分的差异单列计入损益，不追回去改历史出库成本。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一层成本：数量 / 金额 / 加权单价 */
export interface CostLayer {
  qty: number
  amount: number
  unit_cost: number
  line_count?: number
}

export interface CostLayers {
  period: string
  range: { start: string; end: string }
  /** 期间是否已走完（没走完不能结转） */
  finished: boolean
  /** 期初的来源口径说明（倒推 or 已结转快照） */
  opening_source: string
  cost_method: string
  opening: CostLayer
  in: CostLayer
  out: CostLayer
  /** 本期成本调整净额（暂估差异回写等，只改金额不动数量） */
  adj?: CostLayer
  /** 截至期末日 = 期初 + 本期入 − 本期出 */
  as_of_end: CostLayer
  /** 期末之后的流水净额（现存量比截至期末多出来的那段） */
  later: CostLayer
  /** 现存量（今天的结存） */
  closing: CostLayer
  closing_line_count: number
  residual: { qty: number; amount: number }
  /** 现存量 − (截至期末 + 期末之后) === 0 才算对上 */
  balanced: boolean
}

export interface CostPeriod {
  period: string
  status: 'open' | 'closed'
  closed_at: string | null
  closed_by_name: string | null
  remark: string | null
  finished: boolean
  closing_qty: number
  closing_amount: number
}

export interface VarianceRow {
  id: number
  doc_no: string
  supplier_name?: string | null
  settle_date: string
  status: string
  /** 入库暂估金额 */
  est_amount: number
  /** 实际入库成本（含摊入费用） */
  act_amount: number
  /** 可回写差异 = act − est（待办口径） */
  diff_amount: number
  cost_diff: number
  /** 发票口径差额（仅展示，不是成本待办） */
  invoice_diff: number
  invoice_open_amount: number
  adjusted_amount: number
  /** 草稿调整单金额（尚未生效） */
  draft_total: number
  pending_amount: number
  sold_not_traced: number
  source_lines: number
  adjustable: boolean
  invoice_settled: boolean
  fully_adjusted: boolean
  diff_label: string
  blocked_reason: string | null
}

export interface AdjustmentItem {
  id: number
  line_no: number
  warehouse_name?: string | null
  sku_code?: string
  sku_name?: string
  batch_no?: string | null
  receipt_no?: string | null
  qty_total: number
  qty_on_hand: number
  qty_sold: number
  price_est: number
  price_act: number
  amount_est: number
  amount_act: number
  adj_amount: number
  unit_before: number
  unit_after: number
  amount_before: number
  amount_after: number
  remark?: string | null
}

export interface Adjustment {
  id: number
  doc_no: string
  settle_id: number
  settle_no?: string | null
  adjust_type: string
  adjust_date: string
  period: string
  status: string
  status_label: string
  diff_amount: number
  adjusted_amount: number
  sold_amount: number
  line_count: number
  remark?: string | null
  created_by_name?: string | null
  adjusted_at?: string | null
  items?: AdjustmentItem[]
  events?: { action: string; action_name?: string; from_state?: string; to_state?: string; actor_name?: string; remark?: string; created_at: string }[]
}

export interface CostingOverview {
  period: string
  period_status: 'open' | 'closed'
  period_closed_at: string | null
  cost_method: string
  layers: CostLayers
  variance: {
    pending_settlements: number
    pending_amount: number
    invoice_gap_settlements: number
    invoice_gap_amount: number
  }
  integrity: { checked: number; broken_count: number; broken_amount: number; zero_qty_count: number }
  adjusted_this_period: number
  sold_not_traced: number
}

export interface CostAudit {
  checked: number
  broken_count: number
  broken_amount: number
  zero_qty_count: number
  zero_qty_amount: number
  broken: any[]
  zero_qty: any[]
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

export const COSTING_META = () =>
  data<{
    results: { value: string; label: string }[]
    cost_methods: { value: string; label: string }[]
    adjust_types: { value: string; label: string }[]
  }>(api.get('/costing/meta'))

export const COSTING_OVERVIEW = (period?: string) =>
  data<CostingOverview>(api.get('/costing/overview', { period }))

export const COSTING_LAYERS = (params?: {
  period?: string
  warehouse_id?: number | string
  sku_id?: number | string
  batch_no?: string
}) => data<CostLayers>(api.get('/costing/layers', params))

export const COSTING_PERIODS = (limit = 24) =>
  data<{ list: CostPeriod[]; current: string }>(api.get('/costing/periods', { limit }))

/** 期末结转：把本期锁死。reopen=true 才允许重结（先删快照） */
export const COSTING_CLOSE_PERIOD = (payload: { period: string; reopen?: boolean; remark?: string }) =>
  data<{ period: string; lines: number; layers: CostLayers; balanced: boolean }>(
    api.post('/costing/periods/close', payload)
  )

/** 暂估差异台账。only=adjustable 只回能回写到批次的（待办用） */
export const COSTING_VARIANCES = (opts?: { only?: 'adjustable'; limit?: number }) =>
  data<{ list: VarianceRow[] }>(api.get('/costing/variances', opts))

export const COSTING_AUDIT = (limit = 20) => data<CostAudit>(api.get('/costing/audit', { limit }))

export const COSTING_ADJUSTMENTS = (params?: { status?: string; period?: string; settle_id?: number; page?: number; pageSize?: number }) =>
  data<{ list: Adjustment[]; total: number; page: number; pageSize: number }>(api.get('/costing/adjustments', params))

export const COSTING_ADJUSTMENT = (id: number) => data<Adjustment>(api.get(`/costing/adjustments/${id}`))

/** 从结算单开调整单（草稿） */
export const COSTING_CREATE_ADJUSTMENT = (payload: { settle_id: number; adjust_date?: string; remark?: string }) =>
  data<Adjustment>(api.post('/costing/adjustments', payload))

/** 确认调整 —— 唯一有后果的动作 */
export const COSTING_ADJUST = (id: number, remark?: string) =>
  data<Adjustment>(api.post(`/costing/adjustments/${id}/adjust`, { remark }))

/** 取消草稿 */
export const COSTING_CANCEL_ADJUSTMENT = (id: number, remark?: string) =>
  data<Adjustment>(api.post(`/costing/adjustments/${id}/cancel`, { remark }))

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/** 调整单状态徽标颜色（红=问题/无效，绿=生效，灰=草稿/取消） */
export const ADJ_STATUS_CLS: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  adjusted: 'bg-green-100 text-green-700',
  cancelled: 'bg-slate-100 text-slate-400'
}

/** 期间状态徽标 */
export const PERIOD_CLS: Record<string, string> = {
  open: 'bg-amber-100 text-amber-700',
  closed: 'bg-slate-100 text-slate-500'
}
