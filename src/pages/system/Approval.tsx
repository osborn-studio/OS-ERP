/**
 * ============================================================================
 * 文件标识：src/pages/system/Approval.tsx ｜ 审批中心
 * ============================================================================
 * 【职责】审批中心（页面）
 * 【入口】/system/approval
 * 【主要接口】/approval/overview、/approval/pending、/approval/instances、/approval/templates、/approval/meta
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
 * 页面：审批中心
 */

import { useState } from 'react'
import api from '../../api/client'
import ScopeNotice, { ScopeBlocked, firstFailure, isBlocked } from '../../components/ScopeNotice'
import { Card, Field, Modal, StatCard, Status, Table, Tabs, fmtInt, toast, useFetch } from '../../components/ui'
import { FilterBar, Inp, Sel } from '../../components/DataPage'
import { useAuth } from '../../store/auth'
import { RefreshCw, Check, X, Undo2, Pencil, PauseCircle, PlayCircle, ListChecks } from 'lucide-react'

/**
 * 审批中心（模块 22）。
 *
 * 这一页是「审批与单据状态解耦」这个设计的**必要配套**，不是锦上添花：
 * 解耦之后，单据在等审批期间**状态是不变的**。如果界面上没有一个地方能查到
 * 「这张单子到底卡在谁那里」，用户点完按钮只会觉得「点了没反应」。
 * 换句话说，代价（单据状态不变）是用这一页买回来的。
 *
 * 三种角色视角在这页要分得清：
 *   待我审批 —— 审批人：只看当前级指派给我的（后端按角色/人员/权限点解析，不是前端筛）
 *   全部审批 —— 管理者：全量流水，看谁在拖、哪类单据最容易积压
 *   审批模板 —— 管理员：定义「什么动作、多大金额、审几级、谁来审」
 */
export default function Approval() {
  const { is } = useAuth()
  const canManage = is('admin')
  const [tab, setTab] = useState('mine')
  const [decide, setDecide] = useState<any>(null)
  const [detail, setDetail] = useState<any>(null)

  const { data: ov, reload: rOv, errorStatus: ovStatus, errorCode: ovCode } = useFetch<any>('/approval/overview', undefined, [])
  const reloadAll = () => rOv()
  const ovFailure = { errorStatus: ovStatus, errorCode: ovCode }

  if (isBlocked(ovFailure)) return <ScopeBlocked failure={ovFailure} onRetry={reloadAll} />

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">审批中心</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">
            被标记为「需审批」的动作会在这里集结。审批通过前，单据状态<strong>不会</strong>变化
          </p>
        </div>
        <button className="btn-ghost btn-sm" onClick={reloadAll}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <StatCard
          label="待审批"
          value={fmtInt(ov?.pending || 0)}
          tone={(ov?.pending || 0) > 0 ? 'amber' : 'default'}
          icon={<ListChecks size={15} />}
          sub={`¥${fmtInt(ov?.pending_amount || 0)}`}
        />
        <StatCard label="已通过" value={fmtInt(ov?.approved || 0)} tone="green" />
        <StatCard label="已驳回" value={fmtInt(ov?.rejected || 0)} tone={(ov?.rejected || 0) > 0 ? 'red' : 'default'} />
        <StatCard
          label="启用中的模板"
          value={`${ov?.templates_enabled ?? 0} / ${ov?.templates_total ?? 0}`}
          sub="未启用的模板不会拦截任何动作"
        />
      </div>

      <Tabs
        tabs={[
          { key: 'mine', label: '待我审批', count: ov?.pending || 0 },
          { key: 'all', label: '全部审批', count: ov?.total || 0 },
          { key: 'templates', label: '审批模板', count: ov?.templates_total || 0 }
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'mine' && <MineTab onDecide={setDecide} onDetail={setDetail} onChanged={reloadAll} />}
      {tab === 'all' && <AllTab onDetail={setDetail} />}
      {tab === 'templates' && <TemplatesTab canManage={canManage} onChanged={reloadAll} />}

      <DecideModal row={decide} onClose={() => setDecide(null)} onDone={() => { setDecide(null); reloadAll() }} />
      <DetailModal id={detail} onClose={() => setDetail(null)} onChanged={() => { setDetail(null); reloadAll() }} />
    </div>
  )
}

/* --------------------------------------------------------------- 待我审批 */

function MineTab({ onDecide, onDetail, onChanged }: any) {
  const typeName = useDocTypeNames()
  const { data, loading, reload, errorStatus, errorCode } = useFetch<any>('/approval/pending', { pageSize: 50 }, [])
  const list: any[] = data?.list || []
  const failure = { errorStatus, errorCode }

  const cancel = async (row: any) => {
    const comment = window.prompt('撤回原因（可留空）') ?? null
    try {
      await api.post(`/approval/instances/${row.id}/cancel`, { comment })
      toast('已撤回')
      reload()
      onChanged()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  if (isBlocked(failure)) return <ScopeBlocked failure={failure} onRetry={reload} />

  return (
    <Card pad={false}>
      <ScopeNotice failure={failure} loading={loading} />
      <Table
        columns={[
          { key: 'doc_no', title: '单据号', width: 160, render: (r) => (
            <button className="link font-mono text-[12px]" onClick={() => onDetail(r.id)}>{r.doc_no || `#${r.doc_id}`}</button>
          ) },
          { key: 'doc_name', title: '类型', width: 140, render: (r) => typeName(r.doc_type) },
          { key: 'action_name', title: '待办动作', width: 100, render: (r) => r.action_name || r.action },
          { key: 'amount', title: '金额', width: 110, align: 'right', render: (r) => `¥${fmtInt(r.amount)}` },
          {
            key: 'progress',
            title: '进度',
            width: 80,
            render: (r) => (
              <span className="text-[12px]">
                第 <b>{r.current_step}</b> / {r.total_steps} 级
              </span>
            )
          },
          { key: 'current_approver', title: '当前审批人', width: 100, render: (r) => r.current_approver || '—' },
          {
            key: 'submitted',
            title: '提交',
            width: 120,
            render: (r) => (
              <span className="text-[12px]">
                {r.submitted_by || '—'}
                <br />
                <span className="text-ink-400">{String(r.submitted_at || '').slice(5, 16)}</span>
              </span>
            )
          },
          {
            key: '__act',
            title: '操作',
            width: 150,
            render: (r) => (
              <div className="flex items-center gap-2">
                <button className="link inline-flex items-center gap-1 text-[12px] text-green-700" onClick={() => onDecide({ ...r, decision: 'approve' })}>
                  <Check size={12} /> 通过
                </button>
                <button className="link inline-flex items-center gap-1 text-[12px] text-red-600" onClick={() => onDecide({ ...r, decision: 'reject' })}>
                  <X size={12} /> 驳回
                </button>
                <button className="link inline-flex items-center gap-1 text-[12px]" onClick={() => cancel(r)}>
                  <Undo2 size={12} /> 撤回
                </button>
              </div>
            )
          }
        ]}
        data={list}
        loading={loading}
        empty="没有需要你处理的审批 —— 当前级没有指派到你"
      />
    </Card>
  )
}

/* --------------------------------------------------------------- 全部审批 */

const STATUS_TEXT: Record<string, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  canceled: '已撤回'
}

function AllTab({ onDetail }: any) {
  const typeName = useDocTypeNames()
  const [status, setStatus] = useState('')
  const [docType, setDocType] = useState('')
  const [page, setPage] = useState(1)
  const { data, loading } = useFetch<any>('/approval/instances', {
    page,
    pageSize: 20,
    status: status || undefined,
    doc_type: docType || undefined
  })
  const list: any[] = data?.list || []
  const pages = Math.max(1, Math.ceil((data?.total || 0) / 20))

  return (
    <>
      <FilterBar onReset={() => { setStatus(''); setDocType(''); setPage(1) }}>
        <Sel
          value={status}
          onChange={(v) => { setStatus(v); setPage(1) }}
          options={[
            { value: 'pending', label: '待审批' },
            { value: 'approved', label: '已通过' },
            { value: 'rejected', label: '已驳回' },
            { value: 'canceled', label: '已撤回' }
          ]}
          placeholder="全部状态"
          w={140}
        />
        <Inp value={docType} onChange={(v) => { setDocType(v); setPage(1) }} placeholder="单据类型（如 PO）" w={180} />
        <span className="text-[12px] text-ink-500 ml-2">共 {data?.total || 0} 条</span>
      </FilterBar>
      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '单据号', width: 160, render: (r) => (
              <button className="link font-mono text-[12px]" onClick={() => onDetail(r.id)}>{r.doc_no || `#${r.doc_id}`}</button>
            ) },
            { key: 'doc_name', title: '类型', width: 140, render: (r) => typeName(r.doc_type) },
            { key: 'action_name', title: '动作', width: 100, render: (r) => r.action_name || r.action },
            { key: 'amount', title: '金额', width: 110, align: 'right', render: (r) => `¥${fmtInt(r.amount)}` },
            { key: 'template_name', title: '审批模板', width: 170, render: (r) => r.template_name || '—' },
            { key: 'progress', title: '进度', width: 90, render: (r) => `${r.current_step} / ${r.total_steps}` },
            {
              key: 'status',
              title: '状态',
              width: 100,
              render: (r) => <Status value={r.status} text={STATUS_TEXT[r.status]} />
            },
            { key: 'submitted_by', title: '提交人', width: 100, render: (r) => r.submitted_by || '—' },
            { key: 'decided_at', title: '处理时间', width: 155, render: (r) => r.decided_at || '—' }
          ]}
          data={list}
          loading={loading}
          empty="暂无审批记录"
        />
      </Card>
      {data?.total > 20 && (
        <div className="flex justify-end mt-3">
          <div className="flex items-center gap-2 text-[12px]">
            <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <span className="text-ink-500">第 {page} / {pages} 页</span>
            <button className="btn-ghost btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        </div>
      )}
    </>
  )
}

/* --------------------------------------------------------------- 模板 */

function TemplatesTab({ canManage, onChanged }: any) {
  const { data, loading, reload } = useFetch<any>('/approval/templates', undefined, [])
  const { data: meta } = useFetch<any>('/approval/meta', undefined, [])
  const [edit, setEdit] = useState<any>(null)
  const list: any[] = data?.list || []

  const toggle = async (row: any) => {
    try {
      await api.post(`/approval/templates/${row.id}/toggle`)
      toast(Number(row.enabled) ? '模板已停用（该动作不再需要审批）' : '模板已启用（该动作需要审批）')
      reload()
      onChanged()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <>
      {canManage && (
        <div className="flex justify-end mb-2">
          <button className="btn-primary btn-sm" onClick={() => setEdit({ __new: true, doc_type: 'PO', action: 'approve', min_amount: 0, steps: [{ step_name: '一级审批', approver_type: 'role', approver_value: 'purchase' }] })}>
            + 新建模板
          </button>
        </div>
      )}
      <Card pad={false}>
        <Table
          columns={[
            { key: 'code', title: '模板编码', width: 180, render: (r) => <span className="font-mono text-[12px]">{r.code}</span> },
            { key: 'name', title: '名称', width: 190 },
            { key: 'doc_type', title: '单据', width: 130, render: (r) => `${r.doc_type_name || r.doc_type} · ${r.action_name || r.action}` },
            {
              key: 'range',
              title: '金额区间',
              width: 160,
              render: (r) => (
                <span className="text-[12px]">
                  {r.max_amount == null ? `≥ ¥${fmtInt(r.min_amount)}` : `¥${fmtInt(r.min_amount)} ~ ¥${fmtInt(r.max_amount)}`}
                </span>
              )
            },
            {
              key: 'steps',
              title: '审批级次',
              width: 260,
              render: (r) => (
                <div className="flex flex-wrap gap-1">
                  {(r.steps || []).map((s: any) => (
                    <span key={s.id} className="tag bg-slate-100 text-ink-700">
                      {s.step_no}. {s.step_name} · {s.approver_text}
                    </span>
                  ))}
                </div>
              )
            },
            {
              key: 'enabled',
              title: '状态',
              width: 90,
              render: (r) =>
                Number(r.enabled) ? (
                  <span className="tag bg-green-100 text-green-700">生效中</span>
                ) : (
                  <span className="tag bg-slate-100 text-slate-500">未启用</span>
                )
            },
            { key: 'priority', title: '优先级', width: 70, align: 'right' },
            ...(canManage
              ? [
                  {
                    key: '__act',
                    title: '操作',
                    width: 160,
                    render: (r: any) => (
                      <div className="flex items-center gap-2">
                        <button className="link inline-flex items-center gap-1 text-[12px]" onClick={() => setEdit(r)}>
                          <Pencil size={12} /> 编辑
                        </button>
                        <button className="link inline-flex items-center gap-1 text-[12px]" onClick={() => toggle(r)}>
                          {Number(r.enabled) ? <><PauseCircle size={12} /> 停用</> : <><PlayCircle size={12} /> 启用</>}
                        </button>
                      </div>
                    )
                  }
                ]
              : [])
          ]}
          data={list}
          loading={loading}
          empty="暂无审批模板"
        />
      </Card>
      <p className="text-[12px] text-ink-500 mt-3">
        模板<strong>未启用</strong>时，即使单据动作被标记为「需审批」也不会拦截 —— 标记只表示「可以走审批」，拦不拦看这里。
      </p>
      <TemplateModal row={edit} meta={meta} onClose={() => setEdit(null)} onSaved={() => { reload(); onChanged() }} />
    </>
  )
}

function TemplateModal({ row, meta, onClose, onSaved }: any) {
  const [form, setForm] = useState<any>({})
  const [saving, setSaving] = useState(false)

  if (row && form.__id !== (row.id ?? '__new')) {
    setForm({
      __id: row.id ?? '__new',
      code: row.code ?? '',
      name: row.name ?? '',
      doc_type: row.doc_type ?? 'PO',
      action: row.action ?? 'approve',
      min_amount: row.min_amount ?? 0,
      max_amount: row.max_amount ?? '',
      priority: row.priority ?? 10,
      remark: row.remark ?? '',
      steps: (row.steps || []).length
        ? row.steps.map((s: any) => ({ step_name: s.step_name, approver_type: s.approver_type, approver_value: String(s.approver_value) }))
        : [{ step_name: '一级审批', approver_type: 'role', approver_value: 'purchase' }]
    })
  }

  const setStep = (i: number, patch: any) => {
    const steps = form.steps.map((s: any, j: number) => (j === i ? { ...s, ...patch } : s))
    setForm({ ...form, steps })
  }

  const submit = async () => {
    if (!form.code || !form.name) return toast('模板编码与名称必填', 'error')
    setSaving(true)
    try {
      await api.post('/approval/templates', {
        code: form.code,
        name: form.name,
        doc_type: form.doc_type,
        action: form.action,
        min_amount: Number(form.min_amount || 0),
        max_amount: form.max_amount === '' ? null : Number(form.max_amount),
        priority: Number(form.priority || 0),
        enabled: row.enabled ?? 0,
        remark: form.remark || null,
        steps: form.steps
      })
      toast('模板已保存')
      onClose()
      onSaved()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const approverOptions = (type: string) => {
    if (type === 'role') return (meta?.roles || []).map((r: any) => ({ value: r.code, label: r.name }))
    if (type === 'user') return (meta?.users || []).map((u: any) => ({ value: String(u.id), label: u.name || u.username }))
    if (type === 'perm') return (meta?.permissions || []).map((p: any) => ({ value: p.code, label: p.name }))
    return []
  }

  return (
    <Modal
      open={!!row}
      title={row?.__new ? '新建审批模板' : `编辑模板 · ${row?.name || ''}`}
      width={760}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '保存中…' : '保存'}</button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="模板编码" hint="唯一标识">
          <input className="input" value={form.code ?? ''} disabled={!row?.__new} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </Field>
        <Field label="模板名称">
          <input className="input" value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="适用单据">
          <select className="input" value={form.doc_type ?? 'PO'} onChange={(e) => setForm({ ...form, doc_type: e.target.value })}>
            {(meta?.doc_types || []).map((d: any) => (
              <option key={d.code} value={d.code}>{d.name}（{d.code}）</option>
            ))}
          </select>
        </Field>
        <Field label="适用动作" hint="必须与单据内核里的动作码一致，如 approve / cancel / void">
          <input className="input" value={form.action ?? ''} onChange={(e) => setForm({ ...form, action: e.target.value })} />
        </Field>
        <Field label="金额下限（含）">
          <input className="input" type="number" value={form.min_amount ?? 0} onChange={(e) => setForm({ ...form, min_amount: e.target.value })} />
        </Field>
        <Field label="金额上限（不含）" hint="留空 = 不限上限">
          <input className="input" type="number" value={form.max_amount ?? ''} onChange={(e) => setForm({ ...form, max_amount: e.target.value })} />
        </Field>
        <Field label="优先级" hint="同一单据+动作多个模板命中时，值大者优先">
          <input className="input" type="number" value={form.priority ?? 10} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
        </Field>
        <Field label="备注" span={2}>
          <input className="input" value={form.remark ?? ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
        </Field>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[13px] font-medium text-ink-800">审批级次（按顺序逐级审批）</span>
          <button
            className="btn-ghost btn-sm"
            onClick={() => setForm({ ...form, steps: [...form.steps, { step_name: `第 ${form.steps.length + 1} 级`, approver_type: 'role', approver_value: 'purchase' }] })}
          >
            + 加一级
          </button>
        </div>
        {form.steps?.map((s: any, i: number) => (
          <div key={i} className="grid grid-cols-12 gap-2 mb-2 items-center">
            <span className="col-span-1 text-[12px] text-ink-500 text-center">{i + 1}</span>
            <input
              className="input col-span-4"
              placeholder="级次名称"
              value={s.step_name}
              onChange={(e) => setStep(i, { step_name: e.target.value })}
            />
            <select
              className="input col-span-2"
              value={s.approver_type}
              onChange={(e) => {
                const opts = approverOptions(e.target.value)
                setStep(i, { approver_type: e.target.value, approver_value: opts[0]?.value || '' })
              }}
            >
              <option value="role">按角色</option>
              <option value="user">指定人员</option>
              <option value="perm">按权限点</option>
            </select>
            <select
              className="input col-span-4"
              value={s.approver_value}
              onChange={(e) => setStep(i, { approver_value: e.target.value })}
            >
              {approverOptions(s.approver_type).map((o: any) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <button
              className="col-span-1 link text-[12px] text-red-600"
              disabled={form.steps.length <= 1}
              onClick={() => setForm({ ...form, steps: form.steps.filter((_: any, j: number) => j !== i) })}
            >
              删除
            </button>
          </div>
        ))}
      </div>
      <p className="text-[12px] text-ink-500 mt-3">
        保存后模板仍是「未启用」—— 需要单独启用。审批会卡住别人的工作流，开启必须是显式的。
      </p>
    </Modal>
  )
}

/* --------------------------------------------------------------- 决策弹窗 */

function DecideModal({ row, onClose, onDone }: any) {
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [seen, setSeen] = useState('')
  // 换一行（或换通过/驳回）时清空意见 —— 在渲染里直接 setState 会死循环
  const key = row ? `${row.id}:${row.decision}` : ''
  if (row && seen !== key) {
    setSeen(key)
    setComment('')
  }

  const submit = async () => {
    setSaving(true)
    try {
      const res: any = await api.post(`/approval/instances/${row.id}/decide`, {
        decision: row.decision,
        comment: comment || null
      })
      const d = res.data
      if (d.rejected) toast('已驳回')
      else if (d.done) toast('审批已通过，业务动作已执行')
      else toast(`已通过第 ${d.step} 级，转入第 ${d.nextStep} 级（${d.nextApprover}）`)
      onDone()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={!!row}
      title={row?.decision === 'reject' ? '驳回审批' : '通过审批'}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className={row?.decision === 'reject' ? 'btn-danger' : 'btn-primary'} disabled={saving} onClick={submit}>
            {saving ? '处理中…' : row?.decision === 'reject' ? '确认驳回' : '确认通过'}
          </button>
        </>
      }
    >
      <div className="text-[13px] text-ink-700 mb-3 space-y-1">
        <div>单据：<b className="font-mono">{row?.doc_no || `#${row?.doc_id}`}</b> · {row?.action_name || row?.action}</div>
        <div>金额：¥{fmtInt(row?.amount || 0)}</div>
        <div>级次：第 {row?.current_step} / {row?.total_steps} 级{row?.total_steps > 1 && row?.current_step === row?.total_steps ? '（最后一级，通过后业务动作立即执行）' : ''}</div>
      </div>
      <Field label={row?.decision === 'reject' ? '驳回意见（建议填写）' : '审批意见（可选）'}>
        <textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      {row?.decision !== 'reject' && row?.current_step === row?.total_steps && (
        <p className="text-[12px] text-amber-700 mt-2">
          这是最后一级 —— 通过后「{row?.action_name || row?.action}」会立即在单据上执行。
        </p>
      )}
    </Modal>
  )
}

/* --------------------------------------------------------------- 详情弹窗 */

function DetailModal({ id, onClose, onChanged }: any) {
  const typeName = useDocTypeNames()
  const { data, loading } = useFetch<any>(id ? `/approval/instances/${id}` : null, undefined, [id])
  const records: any[] = data?.records || []
  const steps: any[] = data?.steps || []

  const cancel = async () => {
    const comment = window.prompt('撤回原因（可留空）') ?? null
    try {
      await api.post(`/approval/instances/${id}/cancel`, { comment })
      toast('已撤回')
      onChanged()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <Modal
      open={!!id}
      title={`审批详情 · ${data?.doc_no || ''}`}
      width={720}
      onClose={onClose}
      footer={
        <>
          {data?.status === 'pending' && (
            <button className="btn-ghost" onClick={cancel}>
              <Undo2 size={13} /> 撤回
            </button>
          )}
          <button className="btn-ghost" onClick={onClose}>关闭</button>
        </>
      }
    >
      {loading && <div className="text-[12px] text-ink-400 py-6 text-center">加载中…</div>}
      {!loading && data && (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] mb-4">
            <div><span className="text-ink-500">单据类型 </span>{typeName(data.doc_type)}（{data.doc_type}）</div>
            <div><span className="text-ink-500">动作 </span>{data.action_name || data.action}</div>
            <div><span className="text-ink-500">金额 </span>¥{fmtInt(data.amount)}</div>
            <div><span className="text-ink-500">状态 </span><Status value={data.status} text={STATUS_TEXT[data.status]} /></div>
            <div><span className="text-ink-500">提交人 </span>{data.submitted_by || '—'} · {data.submitted_at}</div>
            <div><span className="text-ink-500">当前级 </span>第 {data.current_step} / {data.total_steps} 级{data.current_approver ? `（${data.current_approver}）` : ''}</div>
            {data.doc_title?.party && <div><span className="text-ink-500">往来单位 </span>{data.doc_title.party}</div>}
            {data.doc_title?.status && <div><span className="text-ink-500">单据当前状态 </span>{data.doc_title.status}</div>}
          </div>

          <div className="mb-3">
            <div className="text-[13px] font-medium text-ink-800 mb-2">审批链路</div>
            <div className="flex items-center flex-wrap gap-2">
              {steps.map((s: any) => {
                const done = records.some((r: any) => r.step_no === s.step_no && r.decision === 'approve')
                const rejected = records.some((r: any) => r.step_no === s.step_no && r.decision === 'reject')
                const active = data.status === 'pending' && data.current_step === s.step_no
                return (
                  <span
                    key={s.id}
                    className={`tag ${rejected ? 'bg-red-100 text-red-600' : done ? 'bg-green-100 text-green-700' : active ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}
                  >
                    {s.step_no}. {s.step_name} · {s.approver_text}
                    {done ? ' ✓' : rejected ? ' ✗' : active ? ' ← 当前' : ''}
                  </span>
                )
              })}
            </div>
          </div>

          <div>
            <div className="text-[13px] font-medium text-ink-800 mb-2">处理记录</div>
            <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
              {records.map((r: any) => (
                <div key={r.id} className="flex items-start gap-3 px-3 py-2 text-[12px]">
                  <span className={`tag shrink-0 ${r.decision === 'approve' ? 'bg-green-100 text-green-700' : r.decision === 'reject' ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-600'}`}>
                    {{ approve: '通过', reject: '驳回', submit: '提交', cancel: '撤回' }[r.decision] || r.decision}
                  </span>
                  <span className="text-ink-700 shrink-0 w-24">{r.approver_name || '—'}</span>
                  <span className="text-ink-500 shrink-0 w-20">{r.step_name || '—'}</span>
                  <span className="text-ink-700 flex-1">{r.comment || '—'}</span>
                  <span className="text-ink-400 shrink-0">{r.decided_at}</span>
                </div>
              ))}
              {!records.length && <div className="px-3 py-4 text-[12px] text-ink-400 text-center">暂无记录</div>}
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}

/* --------------------------------------------------------------- 工具 */

/**
 * 单据类型码 → 中文名。列表接口为了省一次 join 没带名称，
 * 但界面上直接吐 `PO` 这种码等于让人查字典 —— 用 meta 里的映射补齐。
 */
function useDocTypeNames() {
  const { data } = useFetch<any>('/approval/meta', undefined, [])
  const map: Record<string, string> = {}
  for (const d of data?.doc_types || []) map[d.code] = d.name
  return (code: string) => map[code] || code
}
