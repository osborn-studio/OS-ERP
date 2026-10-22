/**
 * ============================================================================
 * 文件标识：src/pages/system/Roles.tsx ｜ 角色与权限（功能权限分配 + 可见菜单预览）
 * ============================================================================
 * 【这一页回答什么】
 *   「不同角色登进来，看到的菜单和能做的事为什么不一样？我在哪里改？」
 *
 * 【两件事必须分开看，这一页把它们摆在一起】
 *   ① **功能权限**（可改）—— `role_permissions` 表，决定接口层放不放行（`requirePerm`）。
 *      这一页勾的就是它，保存走 `PUT /auth/roles/:code/permissions`，后端会写审计日志。
 *   ② **可见菜单**（只读预览）—— 由 `src/components/Layout.tsx` 的 `MENUS` × 角色族决定。
 *      为什么不做成可勾选：菜单是**代码结构**的一部分（一个菜单项对应一个真实路由），
 *      允许在界面上造出"有菜单没路由"或"有路由没菜单"，比不给改更糟。
 *      所以这里只**预览**，要改菜单请改 `Layout.tsx` 的角色族表 —— 那也是唯一出处。
 *
 * 【为什么"预览"必须调 `menusForRole()` 而不是自己算】
 *   自己算就会和真实渲染分叉：这一页显示"店长能看到库存"，登录进去却没有。
 *   那种不一致不会报错，只会让人不再相信任何一页权限说明。
 *
 * 【改它要注意】
 *   · 权限点分组来自 `/auth/permissions` 的 `byModule`，页面里**不写死模块名**；
 *   · 保存是**整体覆盖**（后端先 DELETE 再 INSERT）：所以必须把整份勾选一起提交，
 *     不能只提交变化项 —— 那会把没勾的项全清掉；
 *   · `admin` 角色不给改（后端也拒）：管理员权限被误删会让系统再也进不去设置页。
 * ============================================================================
 */
import { useEffect, useMemo, useState } from 'react'
import { ShieldCheck, Lock, Eye, Save, RotateCcw } from 'lucide-react'
import { Card, SectionTitle, useFetch, toast } from '../../components/ui'
import api from '../../api/client'
import { useAuth } from '../../store/auth'
import { useRuntimeCapabilities } from '../../store/runtime-capabilities'
import { menusForRole } from '../../components/Layout'

function Badge({ children, cls = '' }: { children: any; cls?: string }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] leading-4 ${cls || 'bg-ink-100 text-ink-700 border-ink-300'}`}
    >
      {children}
    </span>
  )
}

const MODULE_LABEL: Record<string, string> = {
  master: '主数据',
  purchase: '采购',
  sales: '销售',
  inventory: '存货',
  produce: '生产与委外',
  quality: '质量',
  pos: '门店 POS',
  order: '订货中心',
  dms: '经销商 / 渠道',
  finance: '财务',
  oms: '线上 OMS',
  mall: '商城与会员',
  approval: '审批',
  system: '系统',
  ai: 'AI 与 MCP'
}

/** 数据范围文案（`roles.data_scope`）：决定这个人能看哪些组织的数据 */
const SCOPE_LABEL: Record<string, string> = {
  all: '全部数据',
  subtree: '本组织及下级',
  org: '本组织',
  dealer: '本经销商',
  self: '仅本人'
}

export default function Roles() {
  const { industry } = useAuth()
  const { enabled } = useRuntimeCapabilities()
  const { data: roles, reload } = useFetch<any[]>('/auth/roles-permissions')
  const { data: permMeta } = useFetch<any>('/auth/permissions')

  const [active, setActive] = useState<string>('')
  const [draft, setDraft] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  const list: any[] = roles || []
  const current = list.find((r) => r.code === active) || null
  const byModule: Record<string, any[]> = permMeta?.byModule || {}
  const modules = useMemo(() => Object.keys(byModule).sort(), [byModule])

  // 选中角色时把它的权限拷进草稿（**必须拷贝**：直接引用服务端数组会让"取消勾选"改到只读数据上）
  useEffect(() => {
    if (!active && list.length) {
      setActive(list[0].code)
      return
    }
    if (current) setDraft(new Set<string>((current.permissions || []) as string[]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, roles])

  const original = useMemo(() => new Set<string>((current?.permissions || []) as string[]), [current])
  const changed =
    draft.size !== original.size || [...draft].some((p) => !original.has(p))
  const isAdmin = current?.code === 'admin'

  function toggle(code: string) {
    if (isAdmin) return
    const next = new Set(draft)
    if (next.has(code)) next.delete(code)
    else next.add(code)
    setDraft(next)
  }

  function toggleModule(mod: string, on: boolean) {
    if (isAdmin) return
    const next = new Set(draft)
    for (const p of byModule[mod] || []) {
      if (on) next.add(p.code)
      else next.delete(p.code)
    }
    setDraft(next)
  }

  async function save() {
    if (!current || isAdmin) return
    setSaving(true)
    try {
      // **整体覆盖**：后端先删后插，所以必须提交完整勾选集合
      await api.put(`/auth/roles/${current.code}/permissions`, { permissions: [...draft] })
      toast(`「${current.name}」权限已保存（${draft.size} 项）`, 'success')
      reload()
    } catch (e: any) {
      toast(e?.message || '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const menus = current ? menusForRole(current.code, industry || 'cosmetic', enabled) : []

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-start gap-2 flex-wrap">
          <ShieldCheck size={18} className="text-brand-600 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-medium text-ink-900 title-serif">角色与权限</div>
            <div className="text-[12.5px] text-ink-600 mt-1 leading-6 max-w-[900px]">
              左侧选角色 → 右侧勾功能权限 → 保存。<b>功能权限决定接口放不放行</b>（`requirePerm`），
              与"能不能看见菜单"是两件事：菜单由 <code className="px-1 bg-ink-100 rounded text-[11.5px]">src/components/Layout.tsx</code>
              的角色族决定，本页只做<b>预览</b>（改了菜单要动代码，因为一个菜单项对应一条真实路由）。
            </div>
          </div>
          <Badge cls="bg-brand-50 text-brand-700 border-brand-200">
            <Lock size={11} className="mr-1" /> 仅管理员可见
          </Badge>
        </div>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-[260px_1fr] gap-3 items-start">
        {/* ---------- 左：角色清单 ---------- */}
        <Card pad={false} className="overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 bg-ink-50/60 text-[12px] text-ink-600">
            共 {list.length} 个角色
          </div>
          <div className="divide-y divide-ink-100 max-h-[620px] overflow-auto">
            {list.map((r) => {
              const on = r.code === active
              return (
                <button
                  key={r.code}
                  onClick={() => setActive(r.code)}
                  className={`w-full text-left px-3 py-2.5 transition-colors ${on ? 'bg-brand-50' : 'hover:bg-ink-50'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[13px] ${on ? 'text-brand-700 font-medium' : 'text-ink-800'}`}>{r.name}</span>
                    <span className="text-[11px] text-ink-500 tabular-nums">{r.permissions?.length || 0}</span>
                  </div>
                  <div className="text-[11px] text-ink-500 mt-0.5 truncate">{r.code} · {SCOPE_LABEL[r.data_scope] || r.data_scope}</div>
                </button>
              )
            })}
          </div>
        </Card>

        {/* ---------- 右：权限矩阵 + 菜单预览 ---------- */}
        <div className="space-y-3">
          <Card>
            <div className="flex items-wrap justify-between gap-2 flex-wrap">
              <div>
                <div className="text-[14px] font-medium text-ink-900">
                  {current?.name || '—'}{' '}
                  <span className="text-[12px] text-ink-500 font-normal">
                    {current?.code} · {SCOPE_LABEL[current?.data_scope] || current?.data_scope}
                  </span>
                </div>
                <div className="text-[12px] text-ink-600 mt-0.5">{current?.description || '—'}</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setDraft(new Set(original))}
                  disabled={!changed || isAdmin}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-ink-300 text-[12px] text-ink-700 disabled:opacity-40 hover:bg-ink-50"
                >
                  <RotateCcw size={13} /> 还原
                </button>
                <button
                  onClick={save}
                  disabled={!changed || isAdmin || saving}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-brand-600 text-white text-[12px] disabled:opacity-40 hover:bg-brand-700"
                >
                  <Save size={13} /> {saving ? '保存中…' : `保存（${draft.size} 项）`}
                </button>
              </div>
            </div>
            {isAdmin && (
              <div className="mt-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
                管理员角色的权限<b>刻意不可在这里改</b>：删掉 `system.user.edit` 之后，这个系统就再也没有入口能把权限加回来。
                真需要收紧，请通过迁移改，并留一条审计记录。
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle
              title="功能权限"
              desc={`勾选即授权 · 共 ${draft.size} 项 · 模块 ${modules.length} 个（模块名与权限点来自 /auth/permissions，页面不写死）`}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {modules.map((mod) => {
                const perms = byModule[mod] || []
                const onCount = perms.filter((p: any) => draft.has(p.code)).length
                const allOn = onCount === perms.length && perms.length > 0
                return (
                  <div key={mod} className="border border-ink-200 rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between px-2.5 py-1.5 bg-ink-50/70 border-b border-ink-200">
                      <div className="text-[12.5px] text-ink-800">
                        {MODULE_LABEL[mod] || mod}
                        <span className="text-[11px] text-ink-500 ml-1.5 tabular-nums">{onCount}/{perms.length}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => toggleModule(mod, !allOn)}
                          disabled={isAdmin}
                          className="text-[11px] text-brand-700 hover:underline disabled:opacity-40"
                        >
                          {allOn ? '清空' : '全选'}
                        </button>
                      </div>
                    </div>
                    <div className="p-2 grid grid-cols-1 gap-1 max-h-[168px] overflow-auto">
                      {perms.map((p: any) => {
                        const on = draft.has(p.code)
                        return (
                          <label
                            key={p.code}
                            className={`flex items-start gap-1.5 text-[12px] leading-5 cursor-pointer rounded px-1 py-0.5 ${on ? 'text-ink-900' : 'text-ink-600'} ${isAdmin ? 'cursor-not-allowed' : 'hover:bg-ink-50'}`}
                            title={p.code}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={isAdmin}
                              onChange={() => toggle(p.code)}
                              className="mt-[3px] accent-[#185FA5]"
                            />
                            <span className="min-w-0">
                              {p.name}
                              <span className="text-[10.5px] text-ink-400 ml-1">{p.category}</span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          <Card>
            <SectionTitle
              title="该角色登录后看到的菜单"
              desc={`按「${industry === 'food' ? '连锁餐饮' : industry === 'apparel' ? '服装' : '美妆连锁'}」行业版本计算 · 与侧栏渲染同一条判据（menusForRole）`}
              right={<span className="text-[11px] text-ink-500 inline-flex items-center gap-1"><Eye size={12} /> 只读预览</span>}
            />
            <div className="flex flex-wrap gap-1.5">
              {menus.map((m) => (
                <div key={m.key} className="border border-ink-200 rounded-md px-2 py-1 bg-white">
                  <div className="text-[12px] text-ink-800">{m.label}</div>
                  {m.children && (
                    <div className="text-[11px] text-ink-500 mt-0.5 max-w-[320px]">
                      {m.children.map((c) => c.label).join(' · ')}
                    </div>
                  )}
                </div>
              ))}
              {menus.length === 0 && <div className="text-[12px] text-ink-400">该角色没有任何菜单</div>}
            </div>
            <div className="text-[11.5px] text-ink-500 mt-2 leading-5">
              想看"一个人能做什么"要同时看两处：<b>这里的菜单</b>（看得见）与<b>上面的功能权限</b>（做得了）。
              接口层的判据是权限点，菜单隐藏只是界面收敛 —— 直接敲地址仍会被后端拒绝。
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
