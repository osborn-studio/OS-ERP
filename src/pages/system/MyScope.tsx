/**
 * ============================================================================
 * 文件标识：src/pages/system/MyScope.tsx ｜ 我的数据范围
 * ============================================================================
 * 【职责】回答"为什么我看不到某些数据"：展示当前账号的有效数据范围（来源、所属组织、范围内组织、门店/经销商绑定），
 *   并用白话解释每种范围的含义。ScopeNotice 的 403 / 空范围提示链接到本页。
 * 【入口】/system/my-scope（菜单"我的数据范围"，所有登录用户可见，不需要权限点）
 * 【主要接口】GET /auth/my-scope（只读；服务端只返回调用者自己的信息）
 *
 * 【说明】范围判据只在服务端 `resolveOrgScope`；本页不重算，只展示服务端给出的 `data_scope_effective`
 *   和 `explanations`。下面的"各范围含义"表是静态说明，口径来自 ADR-0015 / 0017 / 0026 / 0027：
 *   范围外的详情 404（与不存在同形）、范围内无数据 200 + 空列表、缺权限点 403，三者不同。
 * 【改它要注意什么】不要在这里补"其他人/其他组织"的信息；接口不提供，也不应该提供。
 * ============================================================================
 */
import { Link } from 'react-router-dom'
import { Card, SectionTitle, useFetch } from '../../components/ui'
import { ScopeBlocked, firstFailure } from '../../components/ScopeNotice'

type Named = { id: number; name: string } | null
type MyScopeData = {
  role: string
  role_name: string
  is_admin: boolean
  data_scope_effective: 'all' | 'subtree' | 'org' | 'self' | 'dealer' | 'none'
  data_scope_source: 'admin' | 'user' | 'role_default' | 'no_org'
  user_data_scope: string | null
  role_default_scope: string | null
  org: Named
  org_ids_in_scope: { all: boolean; count: number | null; names: string[]; truncated: boolean }
  store: Named
  dealer: Named
  explanations: string[]
}

const SCOPE_LABEL: Record<string, string> = {
  all: '全部数据', subtree: '本组织及下级', org: '仅本组织', self: '仅本人', dealer: '仅本经销商', none: '无（未关联组织）'
}
const SOURCE_LABEL: Record<string, string> = {
  admin: '管理员账号，恒为全部数据', user: '管理员为你的账号单独设置', role_default: '沿用角色默认', no_org: '账号没有所属组织'
}

/** 各范围的静态说明（口径见 ADR-0015/0017/0026/0027），与服务端 resolveOrgScope 一一对应。 */
const GLOSSARY: { scope: string; text: string }[] = [
  { scope: 'all', text: '所有组织的数据都能看到，包括没有归属组织的单据。管理员恒为此范围。' },
  { scope: 'subtree', text: '所属组织及它的全部下级组织。其它组织的行不会出现在列表与合计里。' },
  { scope: 'org', text: '只有所属组织这一个节点，不含下级。' },
  { scope: 'self', text: '名义上"仅本人"；目前组织范围型接口按所属的那一个组织过滤，并不按创建人再细分。' },
  { scope: 'dealer', text: '经销商角色只看绑定的那个经销商自己的数据；内部角色即使被设为此范围，销售、订货中心等按组织划分的接口也返回空。未绑定经销商则什么都看不到。' },
  { scope: 'none', text: '账号没有所属组织（且范围不是"全部"或"经销商"）。系统不会把"没有组织"当成"看全部"，所以按组织划分的列表为空；门店 / 经销商角色仍按绑定主体访问自己的数据。' }
]

export default function MyScope() {
  const { data, loading, error, errorStatus, errorCode, reload } = useFetch<MyScopeData>('/auth/my-scope', undefined, [])
  const failure = firstFailure({ errorStatus, errorCode })
  const eff = data?.data_scope_effective

  return (
    <div className="space-y-4" data-testid="my-scope-page">
      <SectionTitle title="我的数据范围" desc="列表为空或打开单据提示“不存在”时，先在这里看自己能看到哪些组织的数据" />
      {error && !data && <ScopeBlocked failure={failure} onRetry={reload} />}
      {loading && !data && <p className="text-sm text-slate-400">加载中…</p>}
      {data && (
        <>
          <Card>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <div><dt className="text-slate-400 text-xs">角色</dt><dd>{data.role_name}{data.is_admin ? '（管理员）' : ''}</dd></div>
              <div>
                <dt className="text-slate-400 text-xs">生效的数据范围</dt>
                <dd data-testid="my-scope-effective">{SCOPE_LABEL[eff!] || eff}<span className="text-slate-400">　{SOURCE_LABEL[data.data_scope_source]}</span></dd>
              </div>
              <div><dt className="text-slate-400 text-xs">所属组织</dt><dd>{data.org?.name || '未设置'}</dd></div>
              <div><dt className="text-slate-400 text-xs">角色默认范围</dt><dd>{data.role_default_scope ? SCOPE_LABEL[data.role_default_scope] || data.role_default_scope : '—'}</dd></div>
              <div><dt className="text-slate-400 text-xs">绑定门店</dt><dd>{data.store?.name || '无'}</dd></div>
              <div><dt className="text-slate-400 text-xs">绑定经销商</dt><dd>{data.dealer?.name || '无'}</dd></div>
            </dl>
          </Card>

          <Card>
            <h3 className="text-sm font-medium text-slate-800 mb-2">这对你意味着什么</h3>
            <ul className="list-disc pl-5 space-y-1 text-sm text-slate-700" data-testid="my-scope-explanations">
              {data.explanations.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </Card>

          <Card>
            <h3 className="text-sm font-medium text-slate-800 mb-2">范围内的组织</h3>
            {data.org_ids_in_scope.all ? (
              <p className="text-sm text-slate-600">全部组织（没有按组织的限制）。</p>
            ) : data.org_ids_in_scope.count === null ? (
              <p className="text-sm text-slate-600">此范围不按组织划分。</p>
            ) : data.org_ids_in_scope.count === 0 ? (
              <p className="text-sm text-slate-600">0 个组织：按组织划分的列表会是空的。</p>
            ) : (
              <>
                <p className="text-sm text-slate-600 mb-1">共 {data.org_ids_in_scope.count} 个组织{data.org_ids_in_scope.truncated ? `，仅列出前 ${data.org_ids_in_scope.names.length} 个` : ''}：</p>
                <p className="text-sm text-slate-700">{data.org_ids_in_scope.names.join('、')}{data.org_ids_in_scope.truncated ? ' …' : ''}</p>
              </>
            )}
          </Card>
        </>
      )}

      <Card>
        <h3 className="text-sm font-medium text-slate-800 mb-2">各数据范围的含义</h3>
        <table className="w-full text-sm">
          <tbody>
            {GLOSSARY.map((g) => (
              <tr key={g.scope} className={`align-top ${g.scope === eff ? 'bg-brand-50/60 font-medium' : ''}`} data-current={g.scope === eff ? 'true' : undefined}>
                <td className="py-1.5 pr-3 whitespace-nowrap text-slate-800">{SCOPE_LABEL[g.scope]}</td>
                <td className="py-1.5 text-slate-600">{g.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 text-xs text-slate-500 space-y-1">
          <p>三种"看不到"不要混淆：缺权限点是 403（页面会提示没有访问权限）；范围内没有数据是 200 加空列表；内部账号打开范围外的单据详情返回"不存在"（404），与真的不存在无法区分；门店 / 经销商账号访问他人主体的单据则是 403。</p>
          <p>需要调整范围请联系管理员（用户与权限页设置所属组织与数据范围）。<Link to="/system/role-matrix" className="underline ml-1">各角色的数据范围对照</Link><Link to="/" className="underline ml-2">返回首页</Link></p>
        </div>
      </Card>
    </div>
  )
}
