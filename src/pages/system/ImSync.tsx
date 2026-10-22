/**
 * ============================================================================
 * 文件标识：src/pages/system/ImSync.tsx ｜ ImSync（页面，未取到标题）
 * ============================================================================
 * 【职责】ImSync（页面，未取到标题）（页面）
 * 【入口】/system/im-sync
 * 【主要接口】/im/status、/im/meta、/im/audit、/im/platforms、/im/mappings
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自本页自己的标题**、
 *   入口取自 `src/App.tsx` 的路由表、接口取自本页实际调用的接口（**都不是新编的**）。
 *   人工完善时补：这页回答用户的什么问题 / 为什么这样组织 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处；下拉选项从 `/api/meta/*` 取，不要在页面里写死；
 *   改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */
/**
 * 页面：ImSync（页面，未取到标题）
 */

import { useState } from 'react'
import { api } from '../../api/client'
import { useRuntimeCapabilities } from '../../store/runtime-capabilities'
import { CapabilityStatus } from '../../components/CapabilityGate'
import { Card, SectionTitle, StatCard, Table, Tabs, Empty, toast, useFetch, useList, fmtInt } from '../../components/ui'

/**
 * 钉钉 / 飞书 组织与审批同步（批次 T）
 *
 * 这一页要回答的问题不是"同步成功了没有"，而是三件事：
 *   ① **接没接**：平台是不是启用了、凭据在环境里有没有值、真实调用能不能发出去；
 *   ② **对不对得上**：外部部门/成员/审批单，各自映射到了本地的哪一个；
 *   ③ **有没有对不上的**：冲突台账里每一条都带一句人话 —— 出了什么事、该怎么办。
 *
 * 界面上刻意保留一句实话：「真实租户调用未实现」。一个看起来能用、实际发不出去的按钮，
 * 比一个明确写着"未实现"的按钮危险得多。
 */
export default function ImSync() {
  const { enabled } = useRuntimeCapabilities()
  const me = useFetch<any>('/auth/me')
  const canSync = enabled('im_connector') && me.data?.permissions?.includes('system.im.sync')
  const canSelfTest = enabled('im_connector') && me.data?.permissions?.includes('system.im.view')
  const [tab, setTab] = useState('runs')
  const [busy, setBusy] = useState('')
  const status = useFetch<any>('/im/status', {}, [])
  const meta = useFetch<any>('/im/meta', {}, [])
  const audit = useFetch<any>('/im/audit', {}, [])
  const platforms = useFetch<any[]>('/im/platforms', {}, [])
  const runs = useList<any>('/im/runs', { pageSize: 20 })
  const conflicts = useList<any>('/im/conflicts', { pageSize: 20 })
  const mappings = useFetch<any>('/im/mappings', {}, [])

  const s = status.data
  const conflictsByCode = Object.entries(meta.data?.conflict_codes || {}) as [string, string][]

  async function run(label: string, path: string) {
    if (path.endsWith('/self-test') ? !canSelfTest : !canSync) return
    setBusy(label)
    try {
      const res = await api.post(path, {})
      const d = res.data || {}
      if (path.endsWith('/self-test')) {
        toast(d.rolled_back ? `自检通过：全链路跑通且已回滚（库里一行都没多）` : `⚠️ 自检没有完全回滚，请查看明细`)
      } else {
        toast(`同步完成：新建 ${d.created ?? 0} / 更新 ${d.updated ?? 0} / 冲突 ${d.conflicts ?? 0}`)
      }
      status.reload(); runs.reload(); conflicts.reload(); audit.reload(); mappings.reload()
    } catch (e: any) {
      toast(e?.detail?.code === 'IM_NOT_CONFIGURED' ? e.message : `失败：${e.message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="space-y-4">
      <SectionTitle
        title="钉钉 / 飞书 同步"
        desc="把外部平台上的部门、成员与审批结论，映射成本系统里的组织、用户与审批实例。密钥不落库（库里只存环境变量名）。"
        right={
          <div className="flex gap-2">
            {canSelfTest && <button className="btn" disabled={!!busy} onClick={() => run('自检', '/im/self-test')}>
              {busy === '自检' ? '自检中…' : '全链路自检（不留痕）'}
            </button>}
            {canSync && <button className="btn" disabled={!!busy} onClick={() => run('组织同步', '/im/sync/org')}>
              {busy === '组织同步' ? '同步中…' : '组织同步'}
            </button>}
            {canSync && <button className="btn" disabled={!!busy} onClick={() => run('审批同步', '/im/sync/approval')}>
              {busy === '审批同步' ? '同步中…' : '审批同步'}
            </button>}
          </div>
        }
      />

      <CapabilityStatus capability="im_connector" label="外部同步和全链路自检" />
      {enabled('im_connector') && <div className="rounded border border-amber-200 bg-amber-50/70 px-3 py-2 text-[12px] text-amber-900 leading-relaxed">
        <b>真实租户调用未实现</b>
        （本机无可用凭据）。除那一次 HTTP 之外的全部环节 —— 映射、幂等、缺失判定、冲突、留痕、回滚 ——
        都已可用，点「全链路自检」可以在一个<b>会回滚的事务里</b>真的跑一遍；库里一行都不会多。
        没配凭据时发起同步会<b>明确报错</b>，而不是"同步成功 0 条"：
        空快照会被缺失判定读成「全公司的人都离职了」。
      </div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="平台" value={fmtInt((s?.platforms || []).length)} sub={(s?.platforms || []).map((p: any) => `${p.label}${p.enabled ? '（已启用）' : '（停用）'}`).join(' · ')} />
        <StatCard label="部门映射" value={fmtInt(s?.maps?.departments || 0)} sub={`未挂接 ${s?.maps?.departments_unmapped ?? 0} · 外部已删 ${s?.maps?.departments_missing ?? 0}`} />
        <StatCard label="成员映射" value={fmtInt(s?.maps?.users || 0)} sub={`未开户 ${s?.maps?.users_unmapped ?? 0} · 外部已删 ${s?.maps?.users_missing ?? 0}`} />
        <StatCard label="冲突" value={fmtInt(s?.open_conflicts || 0)} sub={`同步 ${s?.runs ?? 0} 次 · 审批映射 ${s?.maps?.approvals ?? 0}`} />
      </div>

      <Card>
        <div className="grid md:grid-cols-2 gap-3">
          {(platforms.data || []).map((p: any) => (
            <div key={p.platform} className="rounded border border-slate-200 px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="font-medium">{p.label}</span>
                <span className={`text-[12px] ${p.enabled ? 'text-emerald-700' : 'text-slate-500'}`}>{p.enabled ? '已启用' : '停用'}</span>
              </div>
              <div className="mt-1 text-[12px] text-slate-500 space-y-0.5">
                <div>凭据环境变量：<span className="font-mono">{p.secret_ref || '未填'}</span>{p.secret_present ? '（环境里已有值）' : '（环境里没有值）'}</div>
                <div>真实调用适配器：<b>{p.adapter_ready ? '就绪' : '未实现'}</b>{p.last_sync_at ? ` · 上次同步 ${p.last_sync_at}` : ''}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card pad={false}>
        <div className="px-4 pt-3">
          <Tabs
            tabs={[
              { key: 'runs', label: '同步流水', count: runs.total },
              { key: 'conflicts', label: '冲突台账', count: conflicts.total },
              { key: 'maps', label: '映射明细' },
              { key: 'codes', label: '冲突码字典', count: conflictsByCode.length },
              { key: 'audit', label: '自证' }
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>

        <div className="p-4">
          {tab === 'runs' && (
            runs.list.length === 0 ? <Empty text="还没有同步过" /> : (
              <Table
                columns={[
                  { key: 'id', title: '#', width: 60 },
                  { key: 'platform', title: '平台' },
                  { key: 'kind', title: '种类', render: (r: any) => (r.kind === 'org' ? '组织' : '审批') },
                  { key: 'status', title: '结果' },
                  { key: 'pulled', title: '拉取' },
                  { key: 'created', title: '新建' },
                  { key: 'updated', title: '更新' },
                  { key: 'conflicts', title: '冲突' },
                  { key: 'cursor_before', title: '游标（前 → 后）', render: (r: any) => `${r.cursor_before || '—'} → ${r.cursor_after || '—'}` },
                  { key: 'actor_name', title: '发起人' },
                  { key: 'started_at', title: '开始' },
                  { key: 'finished_at', title: '结束' }
                ]}
                data={runs.list}
              />
            )
          )}

          {tab === 'conflicts' && (
            conflicts.list.length === 0 ? <Empty text="没有冲突" /> : (
              <Table
                columns={[
                  { key: 'id', title: '#', width: 60 },
                  { key: 'platform', title: '平台' },
                  { key: 'kind', title: '种类', render: (r: any) => (r.kind === 'org' ? '组织' : '审批') },
                  { key: 'reason_code', title: '冲突码' },
                  { key: 'external_id', title: '外部对象' },
                  { key: 'message', title: '出了什么事 / 该怎么办' },
                  { key: 'created_at', title: '时间' }
                ]}
                data={conflicts.list}
              />
            )
          )}

          {tab === 'maps' && (
            <div className="space-y-4">
              <div>
                <div className="text-[13px] font-medium mb-1">外部部门 → 本地组织</div>
                <Table
                  columns={[
                    { key: 'platform', title: '平台' },
                    { key: 'external_dept_id', title: '外部部门' },
                    { key: 'external_name', title: '名称' },
                    { key: 'org_id', title: '本地组织', render: (r: any) => (r.org_id ?? <span className="text-amber-700">未挂接</span>) },
                    { key: 'status', title: '状态' },
                    { key: 'sync_batch', title: '来自哪一次同步' }
                  ]}
                  data={mappings.data?.departments || []}
                />
              </div>
              <div>
                <div className="text-[13px] font-medium mb-1">外部成员 → 本地用户</div>
                <Table
                  columns={[
                    { key: 'platform', title: '平台' },
                    { key: 'external_user_id', title: '外部成员' },
                    { key: 'external_name', title: '姓名' },
                    { key: 'mobile', title: '手机号' },
                    { key: 'gml_user_id', title: '本地用户', render: (r: any) => (r.gml_user_id ?? <span className="text-amber-700">未开户</span>) },
                    { key: 'status', title: '状态' },
                    { key: 'sync_batch', title: '来自哪一次同步' }
                  ]}
                  data={mappings.data?.users || []}
                />
              </div>
              <div>
                <div className="text-[13px] font-medium mb-1">外部审批单 → 本地审批实例</div>
                <Table
                  columns={[
                    { key: 'platform', title: '平台' },
                    { key: 'external_instance_id', title: '外部审批单' },
                    { key: 'external_status', title: '外部原文' },
                    { key: 'local_status', title: '读成了什么' },
                    { key: 'approval_id', title: '本地实例' },
                    { key: 'doc_no', title: '单据号' },
                    { key: 'synced_at', title: '同步时间' }
                  ]}
                  data={mappings.data?.approvals || []}
                />
              </div>
            </div>
          )}

          {tab === 'codes' && (
            <Table
              columns={[
                { key: 'code', title: '冲突码' },
                { key: 'text', title: '含义 / 人该做什么' }
              ]}
              data={conflictsByCode.map(([code, text]) => ({ code, text }))}
            />
          )}

          {tab === 'audit' && (
            <div className="space-y-2 text-[13px]">
              <div className={audit.data?.ok ? 'text-emerald-700' : 'text-red-700'}>
                {audit.data?.ok ? '同步链自洽' : `不自洽（${audit.data?.problems?.length || 0} 处）`}
              </div>
              {(audit.data?.problems || []).map((p: any, i: number) => (
                <div key={i} className="rounded border border-red-200 bg-red-50/60 px-3 py-2">
                  <b className="font-mono text-[12px]">{p.code}</b>
                  <div className="text-[12px] text-red-800 mt-0.5">{p.message}</div>
                </div>
              ))}
              <div className="text-[12px] text-slate-500">
                核过：同步 {audit.data?.checked?.runs ?? 0} 次 / 部门映射 {audit.data?.checked?.dept_maps ?? 0} /
                成员映射 {audit.data?.checked?.user_maps ?? 0} / 审批映射 {audit.data?.checked?.approval_maps ?? 0} /
                冲突 {audit.data?.checked?.conflicts ?? 0}
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
