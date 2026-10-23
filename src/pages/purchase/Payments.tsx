/**
 * ============================================================================
 * 文件标识：src/pages/purchase/Payments.tsx ｜ 付款单
 * ============================================================================
 * 【职责】付款单（页面）
 * 【入口】/purchase/payments
 * 【主要接口】/purchase/payment-plan、/purchase/payments
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
 * 页面：付款单
 */

import { useState } from 'react'
import api from '../../api/client'
import ScopeNotice, { ScopeBlocked, firstFailure, isBlocked } from '../../components/ScopeNotice'
import { Card, Field, Modal, StatCard, Status, Table, Tabs, fmtInt, fmtMoney, toast, useFetch, useList } from '../../components/ui'
import { FilterBar, Inp, Sel } from '../../components/DataPage'
import { handleApprovalPending } from '../../api/approval'
import { useOpts } from '../../hooks/opts'
import { RefreshCw, Plus, Eye, ListOrdered, AlertTriangle } from 'lucide-react'

/**
 * 付款单（模块 07）。
 *
 * 这个页面承载本项目最重要的一条金额口径：**付款单「已审批」即形成核销**（用友口径）。
 * 换句话说：
 *   - 草稿付款单上录好的核销明细，只是**计划**，不计入结算单的已付金额；
 *   - 付款单一经审批（哪怕钱还没从银行出去），应付就已经被冲减了；
 *   - 「执行付款」这个动作 = 核销 + 状态前进（approved → paid），两件事必须一起发生。
 *     只核销不推状态 → 付款单永远停在已审批（账实不符）；
 *     只推状态不核销 → 结算单永远收不到钱。
 *
 * 另有一条保护：如果作废这张付款单会让某张**已结清**的结算单失血（结算单结清是单向的），
 * 服务端会直接拒绝作废，而不是让结算单停在「已结清」却金额不足。
 */
/**
 * ⚠️ 状态文案必须在本页覆盖：「paid」在通用 STATUS_MAP 里是**返利的「已发放」**，
 * 直接复用会让付款单显示成「已发放」—— 财务看到这个词会以为在讲返利，而不是钱已经付出去。
 * 通用映射服务于返利/发券等场景，付款场景必须显式改字。
 */
const PAY_STATUS_TEXT: Record<string, string> = { draft: '草稿', approved: '已审批（核销已生效）', paid: '已付款', voided: '已作废' }
/** ADR-0018：执行付款必须带凭证号；达到阈值只挂「待复核」，由持 finance.funds.review 的另一人批准 / 驳回 */
const FUNDS_REVIEW_PERM = 'finance.funds.review'
const REVIEW_TEXT: Record<string, string> = { pending_review: '待复核', approved: '复核通过', rejected: '复核驳回' }

const PAY_TYPES: { value: string; label: string }[] = [
  { value: 'transfer', label: '银行转账' },
  { value: 'accept', label: '银行承兑' },
  { value: 'cash', label: '现金' },
  { value: 'offset', label: '冲抵' }
]

/** 动作 → 一次调用（理由见 Invoices.tsx 的 INVOICE_ACTIONS：路径先进变量会让契约检查看不见） */
const PAYMENT_ACTIONS: Record<string, (id: any, body?: any) => Promise<any>> = {
  submit: (id) => api.post(`/purchase/payments/${id}/submit`),
  pay: (id, body) => api.post(`/purchase/payments/${id}/pay`, body),
  void: (id) => api.post(`/purchase/payments/${id}/void`),
  review: (id, body) => api.post(`/purchase/payments/${id}/review`, body)
}

export default function Payments() {
  const o = useOpts()
  const [tab, setTab] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const { list, summary, loading, reload, errorStatus, errorCode } = useList('/purchase/payments', {})
  const failure = { errorStatus, errorCode }
  const [createOpen, setCreateOpen] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const { data: me } = useFetch<any>('/auth/me', undefined, [])
  const canReview = !!me?.permissions?.includes(FUNDS_REVIEW_PERM)

  const filtered = list.filter((r: any) => {
    if (tab && r.status !== tab) return false
    if (supplierId && String(r.supplier_id) !== String(supplierId)) return false
    return true
  })

  const act = async (row: any, action: string) => {
    const label: Record<string, string> = { submit: '提交审批', pay: '执行付款（核销生效）', void: '作废', approve: '复核通过', reject: '复核驳回' }
    let body: any
    if (action === 'pay') {
      // ADR-0018：证据先于确认。缺凭证号服务端会拒绝（FUNDS_EVIDENCE_REQUIRED），这里不替它放水
      const ref = window.prompt(`${row.doc_no} 执行付款：请填写银行流水号 / 凭证号（证据，必填）`)
      if (ref === null) return false
      const note = window.prompt('证据说明（可空）：') ?? ''
      body = { evidence_ref: ref.trim(), evidence_note: note.trim() }
      if (!confirm(`${row.doc_no} 执行付款后将核销结算单并不可回退（达到复核阈值时先进入待复核），确认？`)) return false
    } else if (action === 'approve' || action === 'reject') {
      const comment = window.prompt(action === 'reject' ? '驳回原因（必填，写入严格审计）：' : '复核意见（可空）：')
      if (comment === null || (action === 'reject' && !comment.trim())) return false
      body = { decision: action, comment: comment.trim() }
    } else if (!confirm(`确认对 ${row.doc_no} 执行「${label[action] || action}」？`)) return false
    try {
      const call = PAYMENT_ACTIONS[action === 'approve' || action === 'reject' ? 'review' : action]
      if (!call) return toast(`未知动作 ${action}`, 'error')
      const res = await call(row.id, body)
      const review = res?.data?.review?.status
      toast(
        action === 'pay'
          ? (review === 'pending_review' ? '已提交复核：等待另一人批准后才标记已付' : '付款已执行，核销已生效')
          : action === 'approve' ? '复核通过：付款已执行' : action === 'reject' ? '已驳回：付款单退回已审批' : '操作成功'
      )
      reload()
      return true
    } catch (e: any) {
      // 模块 22：作废可能被审批闸门拦下
      const handled = await handleApprovalPending(e, {
        docType: 'PAY', docId: row.id, docNo: row.doc_no, action, onSubmitted: reload
      })
      if (!handled) toast(e.message, 'error')
      return false
    }
  }

  if (isBlocked(failure)) return <ScopeBlocked failure={failure} onRetry={reload} />

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">付款单</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">
            按结算单付款，FIFO 自动核销；<b>已审批即形成核销</b>，草稿上的核销只是计划
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={reload}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> 新建付款单
          </button>
        </div>
      </div>

      <ScopeNotice failure={failure} rows={loading ? null : list} loading={loading} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="付款单张数" value={fmtInt(filtered.length)} sub="不含已作废" />
        <StatCard label="付款总额" value={`¥${fmtMoney(summary?.amount, 0)}`} tone="brand" />
        <StatCard label="已核销" value={`¥${fmtMoney(summary?.settled, 0)}`} tone="red" />
        <StatCard label="未分配" value={`¥${fmtMoney(Number(summary?.amount || 0) - Number(summary?.settled || 0), 0)}`} sub="预付 / 待核销余额" tone="amber" />
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[
              { key: '', label: '全部' },
              { key: 'draft', label: '草稿（核销未生效）' },
              { key: 'approved', label: '已审批（核销已生效）' },
              { key: 'paid', label: '已付款' }
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>

      <FilterBar onReset={() => setSupplierId('')}>
        <Sel value={supplierId} onChange={setSupplierId} options={o.suppliers} placeholder="全部供应商" w={220} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '付款单号', width: 145, render: (r) => <span className="link" onClick={() => setDetailId(r.id)}>{r.doc_no}</span> },
            { key: 'supplier_name', title: '供应商', width: 210 },
            { key: 'pay_date', title: '付款日期', width: 105 },
            { key: 'pay_type', title: '付款方式', width: 100, render: (r) => PAY_TYPES.find((x) => x.value === r.pay_type)?.label || r.pay_type },
            { key: 'settle_count', title: '核销单数', width: 80, align: 'right' },
            { key: 'amount', title: '付款金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.amount)}` },
            { key: 'settled_amount', title: '已核销', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.settled_amount)}` },
            { key: 'unallocated', title: '未分配', width: 110, align: 'right', render: (r) => (Number(r.unallocated) > 0.01 ? `¥${fmtMoney(r.unallocated)}` : '—') },
            {
              key: 'status', title: '状态', width: 130,
              render: (r) => (r.review_status === 'pending_review'
                ? <Status value="pending" text={REVIEW_TEXT.pending_review} />
                : <Status value={r.status} text={PAY_STATUS_TEXT[r.status]} />)
            },
            {
              key: '__act',
              title: '操作',
              width: 190,
              render: (r) => (
                <div className="flex items-center gap-2 text-[12px]">
                  <button className="link inline-flex items-center gap-1" onClick={() => setDetailId(r.id)}>
                    <Eye size={12} /> 详情
                  </button>
                  {r.status === 'draft' && <button className="link" onClick={() => act(r, 'submit')}>提交审批</button>}
                  {r.status === 'approved' && r.review_status !== 'pending_review' && <button className="link" onClick={() => act(r, 'pay')}>执行付款</button>}
                  {r.review_status === 'pending_review' && canReview && me?.id !== r.review_maker_id && (
                    <>
                      <button className="link" onClick={() => act(r, 'approve')}>复核通过</button>
                      <button className="text-red-500 hover:text-red-600" onClick={() => act(r, 'reject')}>驳回</button>
                    </>
                  )}
                  {['draft', 'approved'].includes(r.status) && r.review_status !== 'pending_review' && (
                    <button className="text-red-500 hover:text-red-600" onClick={() => act(r, 'void')}>作废</button>
                  )}
                </div>
              )
            }
          ]}
          data={filtered}
          loading={loading}
          empty="暂无付款单"
        />
        <div className="px-3 pb-3 pt-2 text-[12px] text-ink-500">共 {filtered.length} 条</div>
      </Card>

      <CreateModal open={createOpen} onClose={() => setCreateOpen(false)} onSaved={reload} suppliers={o.suppliers} />
      <DetailModal id={detailId} onClose={() => setDetailId(null)} onAct={act} canReview={canReview} meId={me?.id} />
    </div>
  )
}

function CreateModal({ open, onClose, onSaved, suppliers }: any) {
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState<any>({ pay_type: 'transfer', pay_date: today, currency: 'CNY' })
  const [plan, setPlan] = useState<any>(null)
  const [saving, setSaving] = useState(false)

  const loadPlan = async (sid: string, amount: number) => {
    if (!sid) return setPlan(null)
    try {
      const res = await api.get('/purchase/payment-plan', { supplier_id: sid, amount: amount > 0 ? amount : undefined })
      setPlan(res.data)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const submit = async () => {
    if (!form.supplier_id) return toast('请选择供应商', 'error')
    if (!(Number(form.amount) > 0)) return toast('请填写付款金额', 'error')
    setSaving(true)
    try {
      const res = await api.post('/purchase/payments', {
        supplier_id: Number(form.supplier_id),
        pay_date: form.pay_date,
        pay_type: form.pay_type,
        currency: form.currency,
        amount: Number(form.amount),
        bank_account: form.bank_account || null,
        voucher_no: form.voucher_no || null,
        remark: form.remark || null
      })
      toast(`付款单已创建 ${res.data?.doc_no || ''}（FIFO 已自动核销）`)
      onClose()
      onSaved()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const planned = (plan?.plan || []).reduce((s: number, x: any) => s + Number(x.amount || 0), 0)
  const amount = Number(form.amount || 0)

  return (
    <Modal
      open={open}
      title="新建付款单"
      width={880}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={() => loadPlan(form.supplier_id, amount)} disabled={!form.supplier_id}>
            <ListOrdered size={13} /> 试算核销计划
          </button>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '创建中…' : '创建付款单'}</button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4 mb-4">
        <Field label="供应商" required>
          <select
            className="input"
            value={form.supplier_id ?? ''}
            onChange={(e) => {
              setForm({ ...form, supplier_id: e.target.value })
              loadPlan(e.target.value, amount)
            }}
          >
            <option value="">请选择</option>
            {suppliers.map((s: any) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="付款金额" required hint="按结算日 FIFO 自动核销（先结先付）">
          <input
            className="input"
            type="number"
            value={form.amount ?? ''}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            onBlur={() => loadPlan(form.supplier_id, Number(form.amount))}
          />
        </Field>
        <Field label="付款日期">
          <input className="input" type="date" value={form.pay_date} onChange={(e) => setForm({ ...form, pay_date: e.target.value })} />
        </Field>
        <Field label="付款方式">
          <select className="input" value={form.pay_type} onChange={(e) => setForm({ ...form, pay_type: e.target.value })}>
            {PAY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </Field>
        <Field label="银行账户">
          <input className="input" value={form.bank_account ?? ''} onChange={(e) => setForm({ ...form, bank_account: e.target.value })} placeholder="如：基本户 ****8821" />
        </Field>
        <Field label="凭证号">
          <input className="input" value={form.voucher_no ?? ''} onChange={(e) => setForm({ ...form, voucher_no: e.target.value })} />
        </Field>
        <Field label="备注" span={3}>
          <input className="input" value={form.remark ?? ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
        </Field>
      </div>

      {plan && (
        <div className="rounded-md border border-ink-300 p-3">
          <div className="text-[13px] text-ink-900 mb-2">
            该供应商未结清合计 <b className="text-amber-700">¥{fmtMoney(plan.open_total)}</b>
            {amount > 0 && <span className="ml-3 text-ink-700">本次将核销 ¥{fmtMoney(planned)}{planned < amount - 0.01 ? `（剩余 ¥${fmtMoney(amount - planned)} 记为未分配）` : ''}</span>}
          </div>
          <div className="table-wrap border border-ink-300 rounded-md">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>序</th>
                  <th>结算单号</th>
                  <th style={{ width: 110 }}>结算日期</th>
                  <th style={{ width: 120 }} className="text-right">结算金额</th>
                  <th style={{ width: 110 }} className="text-right">已付</th>
                  <th style={{ width: 120 }} className="text-right">未结清</th>
                  {amount > 0 && <th style={{ width: 120 }} className="text-right">本次核销</th>}
                </tr>
              </thead>
              <tbody>
                {(amount > 0 ? plan.plan || [] : plan.list || []).map((x: any, i: number) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{x.settle_doc_no || x.doc_no}</td>
                    <td>{x.settle_date}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(x.settle_amount)}</td>
                    <td className="text-right tabular-nums text-ink-500">¥{fmtMoney(x.paid_amount)}</td>
                    <td className="text-right tabular-nums text-amber-700">¥{fmtMoney(x.open_amount)}</td>
                    {amount > 0 && <td className="text-right tabular-nums text-red-600">¥{fmtMoney(x.amount)}</td>}
                  </tr>
                ))}
                {!(amount > 0 ? plan.plan || [] : plan.list || []).length && (
                  <tr>
                    <td colSpan={amount > 0 ? 7 : 6} className="text-center py-5 text-ink-400">
                      该供应商没有已审核的未结清结算单（草稿/待审核的结算单不参与付款核销）
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="text-[12px] text-ink-500 mt-2">
            核销顺序：按结算日期，先结先付（FIFO）。创建后先存为草稿 —— 核销明细已录，但<b>不计入已付</b>，直到提交审批。
          </div>
        </div>
      )}
    </Modal>
  )
}

function DetailModal({ id, onClose, onAct, canReview = false, meId = null }: any) {
  const { data, loading, reload } = useFetch<any>(id ? `/purchase/payments/${id}` : null, undefined, [id])
  const doAct = async (action: string) => {
    const okFlag = await onAct(data, action)
    if (okFlag) reload()
  }
  const items: any[] = data?.items || []
  const live = data?.status === 'approved' || data?.status === 'paid'
  const review = data?.review
  const pending = review?.status === 'pending_review'
  const isMaker = !!review?.maker?.id && review.maker.id === meId

  return (
    <Modal open={!!id} title={`付款单详情 · ${data?.doc_no || ''}`} width={940} onClose={onClose}>
      {loading && <div className="text-center py-8 text-ink-400 text-[13px]">加载中…</div>}
      {data && (
        <div>
          <div className="grid grid-cols-4 gap-3 mb-3 text-[13px]">
            <div><span className="text-ink-500">状态 </span><Status value={data.status} text={PAY_STATUS_TEXT[data.status]} /></div>
            <div><span className="text-ink-500">供应商 </span>{data.supplier?.name || '-'}</div>
            <div><span className="text-ink-500">付款日期 </span>{data.pay_date}</div>
            <div><span className="text-ink-500">付款方式 </span>{PAY_TYPES.find((x) => x.value === data.pay_type)?.label || data.pay_type}</div>
            <div><span className="text-ink-500">付款金额 </span><b>¥{fmtMoney(data.amount)}</b></div>
            <div><span className="text-ink-500">已核销 </span>¥{fmtMoney(data.settled_amount)}</div>
            <div><span className="text-ink-500">未分配 </span>¥{fmtMoney(Number(data.amount) - Number(data.settled_amount))}</div>
            <div><span className="text-ink-500">银行账户 </span>{data.bank_account || '-'}</div>
            <div><span className="text-ink-500">凭证号 </span>{data.evidence_ref || '-'}</div>
            {data.evidence_note && <div className="col-span-3"><span className="text-ink-500">证据说明 </span>{data.evidence_note}</div>}
          </div>
          {review?.status && (
            <div className={`rounded-md border px-3 py-2 mb-3 text-[12px] ${pending ? 'border-amber-300 bg-amber-50/50 text-amber-700' : review.status === 'approved' ? 'border-teal-300 bg-teal-50/50 text-teal-700' : 'border-red-300 bg-red-50/50 text-red-700'}`}>
              <b>{REVIEW_TEXT[review.status] || review.status}</b>
              <span className="ml-2">发起：{review.maker?.name || '-'}{review.maker?.at ? `（${review.maker.at}）` : ''}</span>
              {review.checker && <span className="ml-2">复核：{review.checker.name || '-'}{review.decided_at ? `（${review.decided_at}）` : ''}</span>}
              {review.comment && <span className="ml-2">意见：{review.comment}</span>}
            </div>
          )}

          <div className={`rounded-md border px-3 py-2 mb-3 text-[12px] ${live ? 'border-teal-300 bg-teal-50/50 text-teal-700' : 'border-amber-300 bg-amber-50/50 text-amber-700'}`}>
            {live ? (
              <>✅ 本单核销已生效（已审批 / 已付款），这些金额已经计入对应结算单的「已付」。</>
            ) : (
              <>⚠ 本单为草稿：核销明细已录，但<b>尚未生效</b>。不计入任何结算单的已付金额 —— 提交审批后才生效。</>
            )}
          </div>

          <div className="table-wrap border border-ink-300 rounded-md mb-3">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 160 }}>结算单号</th>
                  <th style={{ width: 110 }}>结算日期</th>
                  <th style={{ width: 120 }} className="text-right">结算金额</th>
                  <th style={{ width: 110 }} className="text-right">结算单已付</th>
                  <th style={{ width: 120 }} className="text-right">本次核销</th>
                  <th style={{ width: 100 }}>结算单状态</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it: any, i: number) => (
                  <tr key={i}>
                    <td>{it.settle_doc_no}</td>
                    <td>{it.settle_date}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(it.settle_amount)}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(it.paid_amount)}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(it.amount)}</td>
                    <td><Status value={it.settle_status} /></td>
                  </tr>
                ))}
                {!items.length && (
                  <tr>
                    <td colSpan={6} className="text-center py-6 text-ink-400">无核销明细（可能是预付 / 未分配款）</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {data.remark && <div className="text-[12px] text-ink-700 mb-3">备注：{data.remark}</div>}

          <div className="flex items-center gap-2">
            {data.status === 'draft' && (
              <>
                <button className="btn-primary btn-sm" onClick={() => doAct('submit')}>提交审批（核销生效）</button>
                <button className="btn-ghost btn-sm" onClick={() => doAct('void')}>作废</button>
              </>
            )}
            {data.status === 'approved' && !pending && (
              <>
                <button className="btn-primary btn-sm" onClick={() => doAct('pay')}>执行付款</button>
                <button className="btn-ghost btn-sm" onClick={() => doAct('void')}>作废</button>
              </>
            )}
            {pending && canReview && !isMaker && (
              <>
                <button className="btn-primary btn-sm" onClick={() => doAct('approve')}>复核通过（执行付款）</button>
                <button className="btn-ghost btn-sm" onClick={() => doAct('reject')}>驳回</button>
              </>
            )}
            {pending && (!canReview || isMaker) && (
              <span className="text-[12px] text-amber-700">{isMaker ? '你是发起人，需由另一人复核' : '等待持复核权限的同事批准'}</span>
            )}
            {data.status === 'paid' && <span className="text-[12px] text-ink-500">已付款，流程结束</span>}
          </div>

          {data.status === 'approved' && (
            <p className="text-[12px] text-ink-500 mt-2 flex items-center gap-1.5">
              <AlertTriangle size={12} />
              作废保护：如果作废本单会导致某张已结清的结算单金额不足，服务端会直接拒绝 —— 已结清是单向状态，不能靠作废把账改回去。
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
