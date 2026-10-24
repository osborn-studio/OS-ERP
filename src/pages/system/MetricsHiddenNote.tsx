/**
 * ============================================================================
 * 文件标识：src/pages/system/MetricsHiddenNote.tsx ｜ 指标目录"部分指标因权限未显示"说明（布局槽位，AE11）
 * ============================================================================
 * 【职责】只负责版式：当有指标因调用者权限被服务端隐藏（AE1）时，在目录顶部给一条中性说明；没有隐藏项时什么都不画。
 * 【不做】不取数、不判断哪些指标被隐藏、不推断原因——数据层（隐藏数量与原因字段）由 AE1 提供，Metrics.tsx 把它传进 `count` / `reason`。
 * 【钩子】容器 `metrics-hidden-slot` 常驻（data-count 为 0 时不可见），便于浏览器场景断言"没有隐藏项时没有说明、有隐藏项时数量一致"。
 * 【改它要注意】AE1 合入后只需在 Metrics.tsx 的标记处替换传入的字段，本文件不应再改版式契约（testid / data-count）。
 * ============================================================================
 */
export default function MetricsHiddenNote({ count, reason }: { count?: number; reason?: string }) {
  const n = Number.isFinite(count) && (count as number) > 0 ? Math.floor(count as number) : 0
  return (
    <div data-testid="metrics-hidden-slot" data-count={n}>
      {n > 0 && (
        <div data-testid="metrics-hidden-note" className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-800">
          有 {n} 个指标因你的账号权限未显示，这不是「数据为 0」。{reason || '需要对应业务模块的查看权限才能看到这些指标；请联系管理员核对角色权限。'}
        </div>
      )}
    </div>
  )
}
