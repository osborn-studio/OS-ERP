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
