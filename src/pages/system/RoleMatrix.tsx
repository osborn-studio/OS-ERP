/**
 * ============================================================================
 * 文件标识：src/pages/system/RoleMatrix.tsx ｜ 角色与数据范围（只读矩阵）
 * ============================================================================
 * 【职责】回答"某个角色在某类单据上大致能看到什么、为什么我自己看不到"：上半部展示当前账号的角色、有效数据范围与门店 / 经销商绑定
 *   （取自 /auth/my-scope），下半部是"角色 x 单据类型"可见度矩阵（取自 /meta/role-matrix），并高亮当前账号所属角色那一列。
 * 【入口】/system/role-matrix（系统管理菜单"角色与数据范围"；MyScope 页有链接；接口只要求登录，不要求权限点）
 * 【主要接口】GET /meta/role-matrix、GET /auth/my-scope（均只读）
 *
 * 【说明】可见度的推演只在服务端 `server/lib/role-matrix.js`；本页不重算，只展示。五档含义（下面 LEGEND）与该文件的 ACCESS 一一对应。
 *   矩阵是说明性视图，不是授权判据：真正放行与否仍由各接口的权限点与数据范围决定；账号被授予多个角色时取并集，矩阵按单个角色展示。
 * 【改它要注意什么】不要在这里补权限点码、其他用户 / 组织的名字——接口不提供，也不应该提供。
 * ============================================================================
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, SectionTitle, useFetch } from '../../components/ui'
import { ScopeBlocked, firstFailure } from '../../components/ScopeNotice'

type Access = 'full' | 'scoped' | 'bound' | 'global_only' | 'none'
type RoleMatrixData = {
  roles: { code: string; name: string }[]
  doc_types: { code: string; name: string; module: string; binding: string | null; global_only: boolean }[]
  cells: Record<string, Record<string, Access>>
  me: { role: string; role_name: string; is_admin: boolean; data_scope_effective: string; store_bound: boolean; dealer_bound: boolean }
}
type Named = { id: number; name: string } | null
type MyScopeData = { role_name: string; data_scope_effective: string; store: Named; dealer: Named; explanations: string[] }

const SCOPE_LABEL: Record<string, string> = {
  all: '全部数据', subtree: '本组织及下级', org: '仅本组织', self: '仅本人', dealer: '仅本经销商', none: '无（未关联组织）'
}

const LEGEND: { access: Access; label: string; cls: string; text: string }[] = [
  { access: 'full', label: '全部', cls: 'bg-green-100 text-green-700', text: '管理员 / 超管：不受权限点、绑定与数据范围限制。' },
  { access: 'scoped', label: '按范围', cls: 'bg-sky-100 text-sky-700', text: '有查看权限；能看到哪些行由账号的数据范围（组织 / 门店归属）决定。' },
  { access: 'bound', label: '须绑定', cls: 'bg-amber-100 text-amber-700', text: '有查看权限，但账号要绑定门店 / 经销商才看得到，且只看自己绑定的那部分；总部角色不受此限。' },
  { access: 'global_only', label: '仅全局', cls: 'bg-violet-100 text-violet-700', text: '这类单据没有组织归属（如总账、应收、收款），只有"全部数据"范围的账号看得到。' },
  { access: 'none', label: '—', cls: 'bg-slate-100 text-slate-400', text: '没有查看权限，或门店 / 经销商账号访问仅限总部的单据类型。' }
]
const CELL = Object.fromEntries(LEGEND.map((l) => [l.access, l])) as Record<Access, (typeof LEGEND)[number]>

export default function RoleMatrix() {
  const matrix = useFetch<RoleMatrixData>('/meta/role-matrix', undefined, [])
  const scope = useFetch<MyScopeData>('/auth/my-scope', undefined, [])
  const [kw, setKw] = useState('')
  const failure = firstFailure({ errorStatus: matrix.errorStatus, errorCode: matrix.errorCode })
  const data = matrix.data
  const myRole = data?.me.role

  const rows = useMemo(() => {
    const k = kw.trim().toLowerCase()
    if (!data) return []
    return data.doc_types.filter((t) => !k || t.code.toLowerCase().includes(k) || t.name.toLowerCase().includes(k) || t.module.toLowerCase().includes(k))
  }, [data, kw])

  return (
    <div className="space-y-4" data-testid="role-matrix-page">
      <SectionTitle title="角色与数据范围" desc="各角色在各类单据上大致能看到什么，以及你自己的角色、数据范围与绑定（只读说明，不是授权开关）" />
      {matrix.error && !data && <ScopeBlocked failure={failure} onRetry={matrix.reload} />}
      {matrix.loading && !data && <p className="text-sm text-slate-400">加载中…</p>}

      {data && (
        <>
          <Card>
            <h3 className="text-sm font-medium text-slate-800 mb-2">我的角色与范围</h3>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm" data-testid="role-matrix-me" data-role={data.me.role}>
              <div><dt className="text-slate-400 text-xs">角色</dt><dd data-testid="role-matrix-me-role">{data.me.role_name}{data.me.is_admin ? '（管理员）' : ''}</dd></div>
              <div><dt className="text-slate-400 text-xs">生效的数据范围</dt><dd data-testid="role-matrix-me-scope">{SCOPE_LABEL[data.me.data_scope_effective] || data.me.data_scope_effective}</dd></div>
              <div><dt className="text-slate-400 text-xs">绑定门店</dt><dd data-testid="role-matrix-me-store">{data.me.store_bound ? scope.data?.store?.name || '已绑定' : '无'}</dd></div>
              <div><dt className="text-slate-400 text-xs">绑定经销商</dt><dd data-testid="role-matrix-me-dealer">{data.me.dealer_bound ? scope.data?.dealer?.name || '已绑定' : '无'}</dd></div>
            </dl>
            {scope.data && scope.data.explanations.length > 0 && (
              <ul className="list-disc pl-5 mt-3 space-y-1 text-sm text-slate-700" data-testid="role-matrix-explanations">
                {scope.data.explanations.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            )}
            <p className="mt-2 text-xs text-slate-500">范围内有哪些组织、三种"看不到"的区别，见<Link to="/system/my-scope" className="underline mx-1">我的数据范围</Link>。</p>
          </Card>

          <Card>
            <h3 className="text-sm font-medium text-slate-800 mb-2">图例</h3>
            <ul className="space-y-1 text-sm" data-testid="role-matrix-legend">
              {LEGEND.map((l) => (
                <li key={l.access} className="flex gap-2 items-start">
                  <span className={`tag whitespace-nowrap ${l.cls}`}>{l.label}</span>
                  <span className="text-slate-600">{l.text}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <div className="mb-3 flex items-center gap-2 flex-wrap">
              <input className="input" style={{ width: 260 }} placeholder="按单据类型 / 编码 / 模块筛选" value={kw} onChange={(e) => setKw(e.target.value)} data-testid="role-matrix-filter" />
              <span className="text-[11px] text-slate-400">你所属角色的一列已高亮；共 {rows.length} 类单据 x {data.roles.length} 个角色</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="role-matrix-table">
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th className="py-1.5 pr-3 whitespace-nowrap">单据类型</th>
                    {data.roles.map((r) => (
                      <th key={r.code} data-role={r.code} data-current={r.code === myRole ? 'true' : undefined}
                        className={`px-2 py-1.5 whitespace-nowrap text-center ${r.code === myRole ? 'bg-brand-50/70 text-slate-900 font-semibold' : ''}`}>
                        {r.name}{r.code === myRole ? '（我）' : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.code} data-doc={t.code} className="border-t border-slate-100">
                      <td className="py-1.5 pr-3 whitespace-nowrap text-slate-800">{t.name}<span className="text-[10px] text-slate-400 font-mono ml-1">{t.code}</span></td>
                      {data.roles.map((r) => {
                        const a = data.cells[r.code]?.[t.code] || 'none'
                        return (
                          <td key={r.code} data-role={r.code} data-access={a} data-current={r.code === myRole ? 'true' : undefined}
                            className={`px-2 py-1.5 text-center ${r.code === myRole ? 'bg-brand-50/70' : ''}`}>
                            <span className={`tag whitespace-nowrap ${CELL[a].cls}`}>{CELL[a].label}</span>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={data.roles.length + 1} className="py-6 text-center text-slate-400">没有匹配的单据类型</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-slate-500">账号被授予多个角色时，实际可见度是各角色权限的并集；矩阵按单个角色展示，且不含个别账号被单独设置的数据范围。</p>
          </Card>
        </>
      )}
    </div>
  )
}
