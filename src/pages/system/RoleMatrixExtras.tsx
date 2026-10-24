/**
 * ============================================================================
 * 文件标识：src/pages/system/RoleMatrixExtras.tsx ｜ 角色矩阵页的两个数据驱动分组：自定义角色、我的并集（AE2，ADR-0051 补充 2）
 * ============================================================================
 * 【职责】只展示 /meta/role-matrix 已返回的数据，不重算：
 *   · CustomRolesCard（管理员）：自定义角色各一列的可见度，以及每个角色的 users.data_scope 覆盖**计数**；管理员另见多角色账号按组合聚合的"并集示例"；
 *   · MyUnionCard：当前账号持有多个角色时，自己这几个角色的并集一列（`my_union`；单角色账号不渲染）。
 * 【边界】接口不返回账号标识、权限点码，本页也不补；并集只是示例（外部主体闸按各角色取最宽，账号真实口径以主角色为准）。
 * ============================================================================
 */
import { Card } from '../../components/ui'

export type Access = 'full' | 'scoped' | 'bound' | 'global_only' | 'none'
export type ExtrasData = {
  roles: { code: string; name: string; builtin: boolean }[]
  doc_types: { code: string; name: string; module: string; binding: string | null; global_only: boolean }[]
  cells: Record<string, Record<string, Access>>
  scope_overrides?: Record<string, { default_scope: string; total: number; overridden: number; by_scope: Record<string, number> }>
  multi_role?: { label: string; accounts: number; combos: { roles: string[]; accounts: number; cells: Record<string, Access> }[] }
  my_union?: { roles: { code: string; name: string }[]; cells: Record<string, Access> } | null
}

const LABEL: Record<Access, string> = { full: '全部', scoped: '按范围', bound: '须绑定', global_only: '仅全局', none: '—' }
const CLS: Record<Access, string> = {
  full: 'bg-green-100 text-green-700', scoped: 'bg-sky-100 text-sky-700', bound: 'bg-amber-100 text-amber-700',
  global_only: 'bg-violet-100 text-violet-700', none: 'bg-slate-100 text-slate-400'
}
const SCOPE_NAME: Record<string, string> = { all: '全部', subtree: '本组织及下级', org: '仅本组织', self: '仅本人', dealer: '仅经销商', other: '其它' }
const Tag = ({ a }: { a: Access }) => <span className={`tag whitespace-nowrap ${CLS[a] || CLS.none}`}>{LABEL[a] || LABEL.none}</span>

export function CustomRolesCard({ data }: { data: ExtrasData }) {
  const custom = data.roles.filter((r) => !r.builtin)
  const so = data.scope_overrides
  if (!so) return null // 非管理员没有这一组
  const name = (c: string) => data.roles.find((r) => r.code === c)?.name || c
  const combos = data.multi_role?.combos || []
  return (
    <Card>
      <div data-testid="role-matrix-custom">
        <h3 className="text-sm font-medium text-slate-800 mb-2">自定义角色</h3>
        {custom.length === 0 ? (
          <p className="text-sm text-slate-400" data-testid="role-matrix-custom-empty">当前没有启用中的自定义角色。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="role-matrix-custom-table">
              <thead><tr className="text-left text-xs text-slate-500">
                <th className="py-1.5 pr-3 whitespace-nowrap">单据类型</th>
                {custom.map((r) => <th key={r.code} data-role={r.code} className="px-2 py-1.5 whitespace-nowrap text-center">{r.name}</th>)}
              </tr></thead>
              <tbody>
                {data.doc_types.map((t) => (
                  <tr key={t.code} data-doc={t.code} className="border-t border-slate-100">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-slate-800">{t.name}</td>
                    {custom.map((r) => <td key={r.code} data-role={r.code} data-access={data.cells[r.code]?.[t.code] || 'none'} className="px-2 py-1.5 text-center"><Tag a={data.cells[r.code]?.[t.code] || 'none'} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h4 className="text-xs font-medium text-slate-600 mt-4 mb-1">账号数据范围覆盖分布（仅计数，不列账号）</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="role-matrix-overrides">
            <thead><tr className="text-left text-slate-500"><th className="py-1 pr-3">角色</th><th className="px-2">角色默认范围</th><th className="px-2 text-right">账号数</th><th className="px-2 text-right">有覆盖</th><th className="px-2">覆盖取值分布</th></tr></thead>
            <tbody>
              {data.roles.map((r) => {
                const o = so[r.code]
                if (!o) return null
                const dist = Object.entries(o.by_scope).filter(([, n]) => n > 0).map(([k, n]) => `${SCOPE_NAME[k] || k} ${n}`).join('、')
                return (
                  <tr key={r.code} data-role={r.code} className="border-t border-slate-100">
                    <td className="py-1 pr-3 whitespace-nowrap">{r.name}{r.builtin ? '' : '（自定义）'}</td>
                    <td className="px-2">{SCOPE_NAME[o.default_scope] || o.default_scope}</td>
                    <td className="px-2 text-right">{o.total}</td>
                    <td className="px-2 text-right" data-testid={`role-matrix-overridden-${r.code}`}>{o.overridden}</td>
                    <td className="px-2 text-slate-600">{dist || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <h4 className="text-xs font-medium text-slate-600 mt-4 mb-1">{data.multi_role?.label || '并集示例'}：多角色账号（{data.multi_role?.accounts ?? 0} 个）</h4>
        {combos.length === 0 ? (
          <p className="text-xs text-slate-400">没有持有多个角色的账号。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="role-matrix-combos">
              <thead><tr className="text-left text-slate-500">
                <th className="py-1 pr-3 whitespace-nowrap">单据类型</th>
                {combos.map((c) => <th key={c.roles.join('+')} className="px-2 whitespace-nowrap text-center">{c.roles.map(name).join(' + ')}（{c.accounts} 个账号）</th>)}
              </tr></thead>
              <tbody>
                {data.doc_types.map((t) => (
                  <tr key={t.code} className="border-t border-slate-100">
                    <td className="py-1 pr-3 whitespace-nowrap">{t.name}</td>
                    {combos.map((c) => <td key={c.roles.join('+')} className="px-2 text-center"><Tag a={c.cells[t.code] || 'none'} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-slate-500">并集只是示例：权限点取各角色的并集，外部主体闸按各角色取最宽，账号真实口径以其主角色为准；个别账号的数据范围覆盖不在列内。</p>
      </div>
    </Card>
  )
}

export function MyUnionCard({ data }: { data: ExtrasData }) {
  const u = data.my_union
  if (!u) return null
  return (
    <Card>
      <div data-testid="role-matrix-my-union">
        <h3 className="text-sm font-medium text-slate-800 mb-1">我的并集</h3>
        <p className="text-xs text-slate-500 mb-2">你同时持有 {u.roles.map((r) => r.name).join('、')}；实际可见度是这些角色权限的并集（并集示例，不是授权判据）。</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="role-matrix-my-union-table">
            <tbody>
              {data.doc_types.map((t) => (
                <tr key={t.code} data-doc={t.code} data-access={u.cells[t.code] || 'none'} className="border-t border-slate-100">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-slate-800">{t.name}</td>
                  <td className="px-2 py-1.5 text-center"><Tag a={u.cells[t.code] || 'none'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  )
}
