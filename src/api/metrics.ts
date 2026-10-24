/**
 * ============================================================================
 * 文件标识：src/api/metrics.ts ｜ 模块 metrics（按文件名推断，待人工完善）
 * ============================================================================
 * 【职责】模块 metrics（按文件名推断，待人工完善）
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import api from './client'

/**
 * 数据口径字典（模块 23）的前端配套。
 *
 * 这一页存在的理由：同一个「销售额」，看板按一个状态集算、报表按另一个状态集算、
 * AI 问答又按第三种 —— 三个页面的数字互相对不上，而**没有任何一处说得清谁对**。
 * 字典页把「口径」与「按这个口径算出来的数」放在同一行，
 * 争论才能从「你这个数不对」推进到「这条口径对不对」。
 *
 * 一个刻意的约束：**值一律现算**，不在前端缓存。
 * 缓存会让口径与数字不在同一时刻，正好毁掉这个模块唯一的用途。
 */

/** 一条指标定义（不含 compute / value） */
export interface MetricDef {
  key: string
  name: string
  module: string
  category: string | null
  unit: string | null
  formula: string
  exclusions: string | null
  source: string | null
  note: string | null
}

/** 定义 + 当前值。值为 { error } 时表示这条算不出来（不是 0） */
export interface MetricItem extends MetricDef {
  value: number | { error: string } | null
  /** false = 该值是全局口径（受限账号看到的不是本组织的数）；缺省或 true = 按调用者范围算（ADR-0053） */
  scoped?: boolean
}

export interface MetricGroup {
  module: string
  items: MetricItem[]
}

/** `GET /metrics` 响应：只含调用者有权看到的指标；`hidden_count` = 因缺业务权限或无范围口径而被隐藏的条数（ADR-0057） */
export interface MetricsDictResponse {
  days: number
  groups: MetricGroup[]
  total: number
  modules: string[]
  hidden_count?: number
  /** 调用者是否受限（含绑定主体）；受限时 `scoped: true` 的行显示「按范围计算」 */
  scope_restricted?: boolean
}

/**
 * 调用者是否为受限（按组织范围收窄）账号：只认服务端 `GET /metrics` 回传的 `scope_restricted`（AF2 的 `isScopeRestricted(orgScope) || subjectBound`，
 * 绑定主体即使 data_scope=all 也算受限）。字段缺失（旧服务端）一律当作不受限——宁可少标，也不在管理员页面上误标，更不再从行上的 `scoped` 推断。
 */
export function callerRestricted(data: unknown): boolean {
  return (data as { scope_restricted?: unknown } | null | undefined)?.scope_restricted === true
}

/** 该指标是否显示「按范围计算」：受限账号 + 服务端明确标 `scoped === true`（`scoped === false` 是全局口径，显示「全局口径」而不是这个标） */
export function showsScopedMarker(m: Pick<MetricItem, 'scoped'>, restricted: boolean): boolean {
  return restricted && m.scoped === true
}

/** 被隐藏指标的一行说明；没有隐藏项时返回 null */
export function hiddenMetricsNote(hidden?: number | null): string | null {
  const n = Number(hidden) || 0
  return n > 0 ? `另有 ${n} 项指标未显示：当前账号缺少对应业务查看权限，或其数据范围下该指标没有范围口径（见设置「受限账号可见的全局口径指标」）` : null
}

export const METRICS_PATH = '/system/metrics'

/** 值是不是「算不出来」——不能当成 0 显示 */
export const isMetricError = (v: unknown): v is { error: string } =>
  !!v && typeof v === 'object' && 'error' in (v as any)

/** 按单位选格式化方式：金额两位、百分比一位、计数取整、天/件两位 */
export function fmtMetricValue(v: MetricItem['value'], unit?: string | null): string {
  if (v === null || v === undefined) return '—'
  if (isMetricError(v)) return '算不出'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (unit === 'CNY') return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (unit === '%') return `${n.toFixed(1)}%`
  if (unit === '个' || unit === '单' || unit === '件') return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

/** 重新投影：把代码里的定义覆盖进 metric_defs 表（管理员动作） */
export const syncMetricDefs = () => api.post('/metrics/sync', {})
