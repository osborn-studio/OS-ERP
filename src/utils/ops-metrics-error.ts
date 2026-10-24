/**
 * ============================================================================
 * 文件标识：src/utils/ops-metrics-error.ts ｜ 运维计数器接口（/api/meta/metrics）失败时的页面文案（纯函数）
 * ============================================================================
 * 【职责】429 + METRICS_RATE_LIMITED（AB10：按来源 IP 的节流，独立桶）→ “抓取过于频繁，稍后重试”，不是故障；
 *   403 → 没有运维权限；其它失败保持服务端原文。`retryable` 决定页面是否提示“稍候再点刷新”。
 * 【不变量】只按状态码 + 业务码判断，不解析 message 文本；429 不被画成“没有数据”或通用错误。
 * ============================================================================
 */
export type OpsMetricsNotice = { kind: 'rate_limited' | 'forbidden' | 'error'; message: string; retryable: boolean }

export function selectOpsMetricsNotice(f: { status?: number | null; code?: string | null; message?: string | null }): OpsMetricsNotice | null {
  const status = Number(f.status || 0)
  if (status === 429 || f.code === 'METRICS_RATE_LIMITED') {
    return { kind: 'rate_limited', retryable: true, message: '指标刷新过于频繁，已被节流（按来源地址限速，并非系统故障）。请等待几秒后再点「刷新」；上方已显示的数值是上一次成功取到的结果。' }
  }
  if (status === 403) return { kind: 'forbidden', retryable: false, message: '只有管理员可以查看运维计数器。' }
  if (status >= 400 || f.code || f.message) return { kind: 'error', retryable: true, message: f.message || '运维计数器读取失败' }
  return null
}
