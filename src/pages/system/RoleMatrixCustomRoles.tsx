/**
 * ============================================================================
 * 文件标识：src/pages/system/RoleMatrixCustomRoles.tsx ｜ 角色矩阵"自定义角色"分组（布局槽位，AE11）
 * ============================================================================
 * 【职责】只负责版式：把库内自定义角色（AE2 的数据层）列在内置角色矩阵之外的一个分组里；没有自定义角色时什么都不画。
 * 【不做】不取数、不算可见度——AE2 返回的结构接入后，RoleMatrix.tsx 在标记处把角色清单传进来；
 *   本分组只展示名称与说明，单元格可见度的渲染仍由 RoleMatrix 的矩阵表负责。
 * 【钩子】容器 `role-matrix-custom-slot` 常驻（data-count 为 0 时不可见）。
 * ============================================================================
 */
export type CustomRoleItem = { code: string; name: string; note?: string }

export default function RoleMatrixCustomRoles({ roles }: { roles?: CustomRoleItem[] }) {
  const list = Array.isArray(roles) ? roles : []
  return (
    <div data-testid="role-matrix-custom-slot" data-count={list.length}>
      {list.length > 0 && (
        <section className="rounded-lg border border-slate-200 bg-white p-4" aria-label="自定义角色">
          <h3 className="text-sm font-medium text-slate-800 mb-2">自定义角色</h3>
          <ul className="space-y-1 text-sm" data-testid="role-matrix-custom-list">
            {list.map((r) => (
              <li key={r.code} data-role={r.code} className="flex gap-2 items-baseline">
                <span className="tag bg-slate-100 text-slate-600 whitespace-nowrap">{r.name}</span>
                {r.note && <span className="text-slate-500 text-xs">{r.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
