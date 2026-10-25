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
 *   · AH10：角色可「停用 / 启用」。停用前先取影响预告（`GET /auth/roles/:code/deactivation-impact`），弹窗写明
 *     「受影响用户 N 人（其中主角色为此角色 M 人）」，确认时把 N 原样带回（`confirm_affected`）；预告与停用之间人数变了，
 *     后端回 409 `ROLE_IMPACT_CHANGED` 并带当前人数，弹窗刷新数字要求重新确认。主角色为已停用角色的账号，
 *     「重新指派主角色」指向用户页的编辑器（改角色字段），这里不另建编辑器；
 *   · `admin` 角色不给改（后端也拒）：管理员权限被误删会让系统再也进不去设置页。
 * ============================================================================
 */
import { useEffect, useMemo, useState } from 'react'
import { ShieldCheck, Lock, Eye, Save, RotateCcw } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Card, SectionTitle, Modal, useFetch, toast } from '../../components/ui'
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
  const navigate = useNavigate()
  // AH10：停用确认弹窗（impact 为打开时取到的预告；confirming 防重复提交）
  const [dlg, setDlg] = useState<{ impact: { affected_users: number; primary_users: number }; stale: boolean } | null>(null)
  const [confirming, setConfirming] = useState(false)

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
  const roleInactive = current?.status === 'inactive'
  // 已停用角色：取一次预告，提示仍以它为主角色的账号数（每次切换角色 / 刷新列表重取）
  const { data: inactiveImpact, reload: reloadImpact } = useFetch<any>(
    current && roleInactive ? `/auth/roles/${current.code}/deactivation-impact` : null,
    undefined,
    [current?.code, current?.status]
  )

  async function openDeactivate() {
    if (!current || isAdmin) return
    try {
      const r: any = await api.get(`/auth/roles/${current.code}/deactivation-impact`)
      setDlg({ impact: r.data, stale: false })
    } catch (e: any) {
      toast(e?.message || '读取影响预告失败', 'error')
    }
  }

  async function confirmDeactivate() {
    if (!current || !dlg) return
    setConfirming(true)
    try {
      await api.post(`/auth/roles/${current.code}/deactivate`, { confirm_affected: dlg.impact.affected_users })
      toast(`「${current.name}」已停用（受影响 ${dlg.impact.affected_users} 人）`, 'success')
      setDlg(null)
      reload()
      reloadImpact()
    } catch (e: any) {
      if (e?.detail?.code === 'ROLE_IMPACT_CHANGED') {
        // 预告过期：用服务端给的当前人数刷新弹窗，要求管理员重新确认（不自动重试）
        setDlg({ impact: { affected_users: e.detail.affected_users, primary_users: e.detail.primary_users }, stale: true })
      } else {
        toast(e?.message || '停用失败', 'error')
        setDlg(null)
      }
    } finally {
      setConfirming(false)
    }
  }

  async function activateRole() {
    if (!current) return
    try {
      await api.post(`/auth/roles/${current.code}/activate`, {})
      toast(`「${current.name}」已启用`, 'success')
      reload()
    } catch (e: any) {
      toast(e?.message || '启用失败', 'error')
    }
  }

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
                    <span className={`text-[13px] ${on ? 'text-brand-700 font-medium' : 'text-ink-800'}`}>{r.name}{r.status === 'inactive' && <span className="ml-1 text-[11px] text-amber-700">（已停用）</span>}</span>
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
                {!isAdmin && current && (
                  roleInactive ? (
                    <button
                      onClick={activateRole}
                      data-testid="role-activate"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-brand-300 text-[12px] text-brand-700 hover:bg-brand-50"
                    >
                      启用角色
                    </button>
                  ) : (
                    <button
                      onClick={openDeactivate}
                      data-testid="role-deactivate"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-red-300 text-[12px] text-red-700 hover:bg-red-50"
                    >
                      停用角色
                    </button>
                  )
                )}
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
            {roleInactive && (
              <div className="mt-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5" data-testid="role-inactive-note">
                该角色已停用：持有者不再获得它的权限，主角色为它的账号数据范围为空。
                {inactiveImpact && inactiveImpact.primary_users > 0 && (
                  <>
                    {' '}仍有 <b data-testid="role-inactive-primary-count">{inactiveImpact.primary_users}</b> 个账号以它为主角色，
                    <button type="button" className="underline ml-1" data-testid="role-reassign-primary" onClick={() => navigate('/system/users')}>
                      重新指派主角色
                    </button>
                    （在用户页编辑账号，改「角色」字段）。
                  </>
                )}
              </div>
            )}
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
      <Modal
        open={!!dlg}
        title={`停用角色「${current?.name || ''}」`}
        onClose={() => !confirming && setDlg(null)}
        width={520}
        footer={
          <>
            <button type="button" onClick={() => setDlg(null)} disabled={confirming} className="px-3 py-1.5 rounded-md border border-ink-300 text-[12px] text-ink-700 hover:bg-ink-50" data-testid="role-deactivate-cancel">
              取消
            </button>
            <button type="button" onClick={confirmDeactivate} disabled={confirming} className="px-3 py-1.5 rounded-md bg-red-600 text-white text-[12px] disabled:opacity-40 hover:bg-red-700" data-testid="role-deactivate-confirm">
              {confirming ? '停用中…' : `确认停用（影响 ${dlg?.impact.affected_users ?? 0} 人）`}
            </button>
          </>
        }
      >
        {dlg && (
          <div className="space-y-2 text-[13px] text-ink-800" data-testid="role-deactivate-dialog">
            {dlg.stale && (
              <div className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-800" role="alert" data-testid="role-deactivate-stale">
                受影响人数在你查看之后发生了变化，已按最新人数刷新，请重新确认。
              </div>
            )}
            <p>
              受影响用户 <b data-testid="role-impact-affected">{dlg.impact.affected_users}</b> 人（其中主角色为此角色 <b data-testid="role-impact-primary">{dlg.impact.primary_users}</b> 人）。
            </p>
            <ul className="list-disc pl-5 text-[12px] text-ink-600 space-y-1">
              <li>停用后这些账号不再获得该角色的权限点，已登录的会话不会被踢下线，下一次请求即按新状态判断。</li>
              <li>主角色为此角色的账号，数据范围会收紧为空（除非管理员为账号单独设置了范围），需要在用户页重新指派主角色。</li>
              <li>管理员账号与已停用账号不计入；停用与之后的启用都会写入审计日志。</li>
            </ul>
          </div>
        )}
      </Modal>
    </div>
  )
}
