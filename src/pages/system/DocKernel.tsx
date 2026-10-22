/**
 * ============================================================================
 * 文件标识：src/pages/system/DocKernel.tsx ｜ 单据内核
 * ============================================================================
 * 【职责】单据内核（页面）
 * 【入口】/system/doc-kernel
 * 【主要接口】/docflow/overview、/docflow/types、/docflow/flows、/docflow/events
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
 * 页面：单据内核
 */

import { useEffect, useMemo, useState } from 'react'
import { Card, SectionTitle, StatCard, Table, Tabs, fmtInt, useFetch } from '../../components/ui'
import { Inp } from '../../components/DataPage'
import { RefreshCw, GitBranch, Workflow, ScrollText, ArrowRight, ShieldCheck } from 'lucide-react'

/**
 * 单据内核（模块 04）——把「定义即数据」摊开给人看。
 *
 * 这一页存在的理由：模块 04 把状态机、业务流、动作权限全部变成了**表里的数据**
 * （`doc_types` / `doc_states` / `doc_actions` / `biz_flows` / `biz_flow_steps`），
 * 不再是散落在路由里的 if 判断。好处是改流程不用改代码；代价是**看不见了**——
 * 以前读代码能看到状态怎么流转，现在得查库。所以必须有一个把定义渲染出来的界面，
 * 否则「定义即数据」会退化成「定义即黑盒」。
 *
 * 本页只读（改定义走迁移脚本，不在这里改）——有意如此：状态机是系统契约，
 * 不应该在界面上被随手改动。编码规则是可运营的配置，所以它有单独的编辑页。
 */
const KIND_STYLE: Record<string, { label: string; cls: string }> = {
  draft: { label: '草稿', cls: 'bg-slate-100 text-slate-600 border-slate-300' },
  active: { label: '进行中', cls: 'bg-blue-50 text-blue-700 border-blue-300' },
  done: { label: '完成', cls: 'bg-green-50 text-green-700 border-green-300' },
  void: { label: '作废', cls: 'bg-red-50 text-red-600 border-red-300' }
}

export default function DocKernel() {
  const [tab, setTab] = useState('machine')
  const { data: ov, reload: rOv } = useFetch<any>('/docflow/overview')
  const { data: types, reload: rTypes } = useFetch<any[]>('/docflow/types')
  const { data: flows, reload: rFlows } = useFetch<any[]>('/docflow/flows')
  const [keyword, setKeyword] = useState('')
  const [code, setCode] = useState<string>('')

  // 默认选第一个类型（只在首次拿到列表时定，否则用户选中会被后续 reload 覆盖）
  useEffect(() => {
    if (!code && types?.length) setCode(types[0].code)
  }, [types, code])

  const grouped = useMemo(() => {
    const out: Record<string, any[]> = {}
    for (const t of types || []) {
      if (keyword && !`${t.code} ${t.name}`.toLowerCase().includes(keyword.toLowerCase())) continue
      ;(out[t.module] = out[t.module] || []).push(t)
    }
    return out
  }, [types, keyword])

  const reload = () => {
    rOv()
    rTypes()
    rFlows()
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">单据内核</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">
            定义即数据：单据类型 / 状态机 / 流转边 / 业务流全部存在表里，改流程不改代码。本页只读
          </p>
        </div>
        <button className="btn-ghost btn-sm" onClick={reload}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3 mb-3">
        <StatCard label="单据类型" value={fmtInt(ov?.docTypes)} sub="已注册" tone="brand" />
        <StatCard label="状态" value={fmtInt(ov?.states)} sub="四类 kind" />
        <StatCard label="流转边" value={fmtInt(ov?.actions)} sub="动作 × 起止状态" />
        <StatCard label="业务流" value={fmtInt(ov?.flows)} sub="跨单据链路" />
        <StatCard label="编码规则" value={fmtInt(ov?.noRules)} tone="amber" />
        <StatCard label="流转事件" value={fmtInt(ov?.events)} sub="全量留痕" tone="red" />
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[
              { key: 'machine', label: '状态机' },
              { key: 'flow', label: '业务流', count: (flows || []).length },
              { key: 'log', label: '流转日志' }
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>

      {tab === 'machine' && (
        <div className="grid grid-cols-12 gap-3">
          <Card className="col-span-12 lg:col-span-3" pad={false}>
            <div className="p-3 border-b border-ink-200">
              <Inp value={keyword} onChange={setKeyword} placeholder="类型编码 / 名称" w={180} />
            </div>
            <div className="max-h-[620px] overflow-y-auto p-2">
              {Object.entries(grouped).map(([mod, list]) => (
                <div key={mod} className="mb-2">
                  <div className="px-2 py-1 text-[11px] text-ink-500 uppercase tracking-wide">{mod}</div>
                  {list.map((t: any) => (
                    <div
                      key={t.code}
                      onClick={() => setCode(t.code)}
                      className={`px-2 py-1.5 rounded cursor-pointer text-[13px] flex items-center justify-between ${
                        code === t.code ? 'bg-brand-50 text-brand-700' : 'hover:bg-ink-50'
                      }`}
                    >
                      <span className="truncate">
                        {t.name}
                        <span className="text-[11px] text-ink-400 ml-1.5">{t.code}</span>
                      </span>
                      <span className="text-[11px] text-ink-400">{t.stateCount} 状态</span>
                    </div>
                  ))}
                </div>
              ))}
              {!Object.keys(grouped).length && <div className="text-center py-8 text-ink-400 text-[13px]">无匹配类型</div>}
            </div>
          </Card>
          <div className="col-span-12 lg:col-span-9">
            {code ? <Machine code={code} /> : <Card><div className="text-center py-12 text-ink-400 text-[13px]">请选择左侧单据类型</div></Card>}
          </div>
        </div>
      )}

      {tab === 'flow' && (
        <div className="space-y-3">
          {(flows || []).map((f: any) => (
            <Card key={f.code}>
              <SectionTitle title={f.name} desc={`${f.code} · 主单据 ${f.doc_type} · ${f.module}`} />
              <div className="flex items-stretch gap-1.5 overflow-x-auto pb-1 mt-2">
                {(f.steps || []).map((s: any, i: number) => (
                  <div key={s.id} className="flex items-center gap-1.5 shrink-0">
                    <div className={`rounded-md border px-3 py-2 min-w-[120px] ${s.is_required ? 'border-ink-300 bg-white' : 'border-dashed border-ink-300 bg-ink-50/40'}`}>
                      <div className="text-[11px] text-ink-500">步骤 {s.seq}</div>
                      <div className="text-[13px] text-ink-900 leading-tight mt-0.5">{s.node_name}</div>
                      <div className="text-[11px] text-ink-500 mt-1">
                        {s.doc_type} · <span className="font-mono">{s.perm_code || '—'}</span>
                      </div>
                      <div className="text-[11px] mt-0.5">
                        {s.is_required ? <span className="text-red-600">必需</span> : <span className="text-ink-400">可选</span>}
                      </div>
                    </div>
                    {i < (f.steps || []).length - 1 && <ArrowRight size={14} className="text-ink-300 shrink-0" />}
                  </div>
                ))}
              </div>
            </Card>
          ))}
          {!flows?.length && <Card><div className="text-center py-10 text-ink-400 text-[13px]">暂无业务流定义</div></Card>}
        </div>
      )}

      {tab === 'log' && <EventLog types={types || []} />}
    </div>
  )
}

function Machine({ code }: { code: string }) {
  const { data, loading } = useFetch<any>(`/docflow/types/${code}/machine`, undefined, [code])
  const { data: lc } = useFetch<any>(`/docflow/types/${code}/lifecycle`, undefined, [code])
  const [detail, setDetail] = useState(false)

  if (loading || !data) return <Card><div className="text-center py-12 text-ink-400 text-[13px]">加载中…</div></Card>

  const states: any[] = data.states || []
  const edges: any[] = data.edges || []
  const finals: string[] = data.finals || []
  const initial: string[] = data.initial || []
  const kinds: Record<string, string[]> = data.kinds || {}

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle
          title={`${data.type.name}（${data.type.code}）`}
          desc={`表 ${data.type.table_name} · 单号前缀 ${data.type.doc_no_prefix} · ${states.length} 状态 / ${edges.length} 流转边`}
          right={
            <button className="btn-ghost btn-sm" onClick={() => setDetail((v) => !v)}>
              <ScrollText size={13} /> {detail ? '收起文本版生命周期' : '文本版生命周期'}
            </button>
          }
        />

        {/* 状态按 kind 分组显示：一眼看出哪些是进行中、哪些是终态 */}
        <div className="mt-3 flex flex-wrap gap-2">
          {states.map((s: any) => {
            const st = KIND_STYLE[s.kind] || KIND_STYLE.active
            return (
              <div key={s.code} className={`rounded-md border px-3 py-1.5 ${st.cls}`}>
                <div className="text-[13px]">
                  {s.name}
                  <span className="text-[11px] opacity-70 ml-1.5 font-mono">{s.code}</span>
                </div>
                <div className="text-[11px] opacity-80 mt-0.5">
                  {s.kind}
                  {initial.includes(s.code) && ' · 初始'}
                  {s.is_final ? ' · 终态' : ''}
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-3 flex items-center gap-4 text-[12px] text-ink-500">
          {Object.entries(KIND_STYLE).map(([k, v]) => (
            <span key={k} className="flex items-center gap-1.5">
              <i className={`inline-block w-3 h-3 rounded-sm border ${v.cls}`} />
              {k}（{v.label}）· {(kinds[k] || []).length} 个
            </span>
          ))}
          <span className="flex items-center gap-1 text-ink-400">终态：{finals.join(' / ') || '无'}</span>
        </div>

        {detail && lc?.text && (
          <pre className="mt-3 text-[12px] leading-relaxed bg-ink-50 rounded-md p-3 overflow-x-auto whitespace-pre-wrap">{lc.text}</pre>
        )}
      </Card>

      <Card pad={false}>
        <div className="px-3 h-11 flex items-center gap-2 border-b border-ink-200">
          <GitBranch size={14} className="text-brand-500" />
          <span className="text-[13px] font-medium text-ink-900">流转边（动作 → 起止状态）</span>
          <span className="text-[12px] text-ink-500 ml-auto">
            唯一入口 applyTransition · 未定义的边一律 TRANSITION_NOT_ALLOWED
          </span>
        </div>
        <Table
          columns={[
            { key: 'action', title: '动作', width: 120, render: (r) => <span className="font-mono text-[12px]">{r.action}</span> },
            { key: 'action_name', title: '动作名', width: 120 },
            {
              key: 'from_state',
              title: '起始状态',
              width: 190,
              render: (r) => <span className="tag bg-slate-100 text-slate-600">{r.from_state}</span>
            },
            {
              key: 'to_state',
              title: '目标状态',
              width: 190,
              render: (r) => (
                <span className="inline-flex items-center gap-1.5">
                  <ArrowRight size={12} className="text-ink-400" />
                  <span className="tag bg-teal-50 text-teal-700">{r.to_state}</span>
                </span>
              )
            },
            {
              key: 'perm_code',
              title: '权限点',
              render: (r) => (r.perm_code ? <span className="font-mono text-[12px] text-ink-700">{r.perm_code}</span> : '—')
            },
            {
              key: 'require_approval',
              title: '需审批',
              width: 80,
              render: (r) => (r.require_approval ? <span className="text-amber-700">是</span> : <span className="text-ink-400">否</span>)
            },
            {
              key: 'is_danger',
              title: '危险动作',
              width: 90,
              render: (r) => (r.is_danger ? <span className="text-red-600">是</span> : <span className="text-ink-400">否</span>)
            }
          ]}
          data={edges}
          loading={loading}
          empty="该类型未定义流转边"
        />
      </Card>

      <p className="text-[12px] text-ink-500 flex items-center gap-1.5">
        <ShieldCheck size={13} />
        「危险动作」指会作废/驳回/取消的单向操作；这类边在界面上应当二次确认，而不是一点就执行。
      </p>
    </div>
  )
}

function EventLog({ types }: { types: any[] }) {
  const [docType, setDocType] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 30
  const { data, loading } = useFetch<any>('/docflow/events', { doc_type: docType || undefined, page, pageSize }, [docType, page])
  // 翻页/换筛选都要回到第一页，否则会停在空页
  useEffect(() => {
    setPage(1)
  }, [docType])
  const list: any[] = data?.list || []
  const total = data?.total || 0
  const pages = Math.max(Math.ceil(total / pageSize), 1)

  return (
    <Card pad={false}>
      <div className="px-3 h-11 flex items-center gap-3 border-b border-ink-200">
        <Workflow size={14} className="text-brand-500" />
        <span className="text-[13px] font-medium text-ink-900">全量流转留痕</span>
        <select className="input input-sm ml-auto" style={{ width: 180 }} value={docType} onChange={(e) => setDocType(e.target.value)}>
          <option value="">全部单据类型</option>
          {types.map((t) => (
            <option key={t.code} value={t.code}>{t.name}</option>
          ))}
        </select>
      </div>
      <Table
        columns={[
          { key: 'created_at', title: '时间', width: 165 },
          { key: 'doc_type', title: '类型', width: 70 },
          { key: 'doc_no', title: '单号', width: 165 },
          { key: 'action_name', title: '动作', width: 130, render: (r) => r.action_name || r.action },
          {
            key: 'from_state',
            title: '状态变化',
            width: 250,
            render: (r) => (
              <span className="inline-flex items-center gap-1.5 text-[12px]">
                <span className="tag bg-slate-100 text-slate-600">{r.from_state || '—'}</span>
                <ArrowRight size={12} className="text-ink-400" />
                <span className="tag bg-teal-50 text-teal-700">{r.to_state || '—'}</span>
              </span>
            )
          },
          { key: 'actor_name', title: '操作人', width: 110, render: (r) => r.actor_name || '系统' },
          { key: 'source', title: '来源', width: 90, render: (r) => <span className="text-[12px] text-ink-500">{r.source || 'api'}</span> },
          { key: 'remark', title: '备注', render: (r) => r.remark || '—' }
        ]}
        data={list}
        loading={loading}
        empty="暂无流转记录"
      />
      <div className="px-3 py-3 flex items-center justify-between text-[13px] text-ink-500">
        <span>共 {fmtInt(total)} 条 · 第 {page}/{pages} 页</span>
        <div className="flex gap-1.5">
          <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
          <button className="btn-ghost btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      </div>
    </Card>
  )
}
