/**
 * ============================================================================
 * 文件标识：src/pages/finance/Refunds.tsx ｜ Refunds（页面，未取到标题）
 * ============================================================================
 * 【职责】Refunds（页面，未取到标题）（页面）
 * 【入口】/finance/refunds
 * 【主要接口】/refunds/meta、/refunds、/refunds/refundables
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
 * 页面：Refunds（页面，未取到标题）
 */

import { useEffect, useState } from 'react'
import api from '../../api/client'
import { Plus, RefreshCw, CheckCircle2, Ban, Undo2, Wallet, AlertTriangle } from 'lucide-react'
import { Modal, Field, toast, fmtMoney } from '../../components/ui'

/**
 * 退款单（批次 J）：把销售退货登记的「待退款」兑现成一次真实出账
 *
 * 这一页要回答三个问题，且每个都要能一眼看出答案：
 *   ① **还能退多少？** —— 「可退清单」给的是 `待退款额 − 已确认退款额`，
 *      与后端 `planRefund()` 同一个口径（界面上自己再算一遍必然分叉）。
 *   ② **这笔钱出去了没有？** —— 状态只有三种：已登记（钱没动）/ 已退款（出账）/ 已作废。
 *      **登记与出账是两个按钮**：能录单的人不该同时能把钱放出去。
 *   ③ **为什么不超过这个数？** —— 明细逐行显示「这张退货单的待退 / 已退 / 可退」，
 *      超了就在提交前拦住并说明是哪一张、差多少。
 *
 * 刻意**没有**"编辑已登记退款单"的入口：改金额等于换一笔出账，
 * 正确做法是作废后重开（作废要写理由，留痕）。
 */

const fmt = (n: any) => '¥' + fmtMoney(n)

const R_STATUS: Record<string, [string, string]> = {
  draft: ['已登记', 'bg-amber-50 text-amber-700 border-amber-200'],
  confirmed: ['已退款', 'bg-emerald-50 text-emerald-700 border-emerald-200'],
  voided: ['已作废', 'bg-slate-100 text-slate-500 border-ink-300 bg-ink-100']
}

type Tab = 'refunds' | 'refundables'

export default function Refunds() {
  const [tab, setTab] = useState<Tab>('refunds')
  const [meta, setMeta] = useState<any>({})
  const [err, setErr] = useState('')
  const [bump, setBump] = useState(0)
  const [openForm, setOpenForm] = useState(false)
  const [prefill, setPrefill] = useState<any>(null)

  useEffect(() => {
    api.get('/refunds/meta').then((r: any) => setMeta(r.data || r)).catch(() => {})
  }, [])

  const TABS: [Tab, string][] = [
    ['refunds', '退款单'],
    ['refundables', '可退清单（待退款）']
  ]

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-[15px] font-medium title-serif">退款管理</div>
        <div className="text-[11px] text-slate-400">
          退货登记的「待退款」在这里兑现成出账 · 上限 = 待退款额 − 已确认退款额
        </div>
        <button className="ml-auto px-2.5 py-1 rounded border border-ink-300 text-[12px] bg-white flex items-center gap-1"
          onClick={() => setBump((b) => b + 1)}>
          <RefreshCw size={12} /> 刷新
        </button>
        <button className="px-2.5 py-1 rounded bg-brand-700 text-white text-[12px] flex items-center gap-1"
          onClick={() => { setPrefill(null); setOpenForm(true) }}>
          <Plus size={12} /> 登记退款单
        </button>
      </div>
      {err && <div className="text-[12px] text-red-500 mb-2">{err}</div>}
      <div className="flex gap-1.5 mb-3">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-1.5 rounded border text-[12px] ${tab === k ? 'bg-brand-700 text-white border-brand-700' : 'border-ink-300 text-slate-600 bg-white'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'refunds' && <RefundList meta={meta} bump={bump} onErr={setErr} onReload={() => setBump((b) => b + 1)} />}
      {tab === 'refundables' && (
        <Refundables bump={bump} onErr={setErr} onPick={(r: any) => { setPrefill(r); setOpenForm(true) }} />
      )}

      <CreateModal
        open={openForm}
        meta={meta}
        prefill={prefill}
        onClose={() => setOpenForm(false)}
        onErr={setErr}
        onDone={() => { setOpenForm(false); setBump((b) => b + 1) }}
      />
    </div>
  )
}

// ===========================================================================
// 退款单列表
// ===========================================================================

function RefundList({ bump, onErr, onReload }: any) {
  const [rows, setRows] = useState<any[]>([])
  const [status, setStatus] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<any>(null)

  const load = () =>
    api.get('/refunds', { status, pageSize: 50 })
      .then((r: any) => setRows((r.data || r).list || []))
      .catch((e: any) => onErr(e.message))

  useEffect(() => { load() }, [status, bump])

  const openDetail = (id: number) => {
    if (openId === id) { setOpenId(null); setDetail(null); return }
    setOpenId(id)
    api.get(`/refunds/${id}`).then((r: any) => setDetail(r.data || r)).catch((e: any) => onErr(e.message))
  }

  // 确认 = 出账。这一步之前后端会**再验一次**额度（建单时合法 ≠ 确认时合法）
  const doConfirm = (row: any) => {
    if (!window.confirm(`确认退款 ${row.doc_no}（${fmt(row.amount)}）？\n确认即出账，之后只能作废后重退。`)) return
    api.post(`/refunds/${row.id}/confirm`)
      .then((r: any) => { toast(`已确认退款 ${(r.data || r).doc_no}`); onReload() })
      .catch((e: any) => onErr(e.message))
  }
  const doVoid = (row: any) => {
    const reason = window.prompt(
      row.status === 'confirmed'
        ? '作废一张**已退款**的单会让一笔已出的钱从账上消失，请写理由'
        : '作废理由'
    )
    if (!reason) return
    api.post(`/refunds/${row.id}/void`, { reason })
      .then(() => { toast('已作废'); onReload(); if (openId === row.id) openDetail(row.id) })
      .catch((e: any) => onErr(e.message))
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <select className="border border-ink-300 rounded px-2 py-1 text-[12px]" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="draft">已登记（钱未动）</option>
          <option value="confirmed">已退款</option>
          <option value="voided">已作废</option>
        </select>
        <span className="text-[11px] text-slate-400">{rows.length} 张</span>
      </div>
      <div className="bg-white border border-ink-200 rounded overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-ink-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 font-normal">退款单号</th>
              <th className="text-left px-3 py-2 font-normal">客户</th>
              <th className="text-left px-3 py-2 font-normal">退款日期</th>
              <th className="text-left px-3 py-2 font-normal">方式</th>
              <th className="text-right px-3 py-2 font-normal">金额</th>
              <th className="text-left px-3 py-2 font-normal">状态</th>
              <th className="text-left px-3 py-2 font-normal">流水号</th>
              <th className="text-right px-3 py-2 font-normal">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-ink-100 hover:bg-ink-50/40">
                <td className="px-3 py-2">
                  <button className="text-brand-700 hover:underline" onClick={() => openDetail(r.id)}>{r.doc_no}</button>
                </td>
                <td className="px-3 py-2">{r.customer_name || r.customer_type}</td>
                <td className="px-3 py-2 text-slate-500">{r.refund_date}</td>
                <td className="px-3 py-2 text-slate-500">{r.method_label || r.method}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(r.amount)}</td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-1.5 py-0.5 rounded border text-[11px] ${R_STATUS[r.status]?.[1] || ''}`}>
                    {R_STATUS[r.status]?.[0] || r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-400">{r.serial_no || '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {r.status === 'draft' && (
                    <button className="text-emerald-700 hover:underline mr-2 inline-flex items-center gap-0.5" onClick={() => doConfirm(r)}>
                      <CheckCircle2 size={12} /> 确认退款
                    </button>
                  )}
                  {r.status !== 'voided' && (
                    <button className="text-slate-500 hover:underline inline-flex items-center gap-0.5" onClick={() => doVoid(r)}>
                      <Ban size={12} /> 作废
                    </button>
                  )}
                  {r.status === 'voided' && <span className="text-slate-400 text-[11px]">—</span>}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">暂无退款单</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {openId && detail && (
        <div className="mt-2 bg-white border border-ink-200 rounded p-3">
          <div className="flex items-center gap-2 mb-2">
            <Wallet size={14} className="text-brand-700" />
            <div className="text-[12px] font-medium">{detail.doc_no} · {fmt(detail.amount)}</div>
            <span className={`px-1.5 py-0.5 rounded border text-[11px] ${R_STATUS[detail.status]?.[1] || ''}`}>
              {R_STATUS[detail.status]?.[0] || detail.status}
            </span>
            {detail.confirmed_by_name && (
              <span className="text-[11px] text-slate-400">出账人 {detail.confirmed_by_name} · {detail.confirmed_at}</span>
            )}
            {detail.void_reason && <span className="text-[11px] text-red-500">作废理由：{detail.void_reason}</span>}
          </div>
          <table className="w-full text-[11px]">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-1 font-normal">退货单</th>
                <th className="text-right py-1 font-normal">本次退款</th>
                <th className="text-right py-1 font-normal">该单待退款</th>
                <th className="text-right py-1 font-normal">当前可退余额</th>
              </tr>
            </thead>
            <tbody>
              {(detail.items || []).map((it: any) => (
                <tr key={it.id} className="border-t border-ink-100">
                  <td className="py-1">{it.return_doc_no || `#${it.return_id}`}</td>
                  <td className="py-1 text-right font-mono">{fmt(it.amount)}</td>
                  <td className="py-1 text-right font-mono text-slate-500">{fmt(it.refund_due)}</td>
                  <td className="py-1 text-right font-mono text-slate-500">{fmt(it.refundable)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {detail.remark && <div className="text-[11px] text-slate-500 mt-2">备注：{detail.remark}</div>}
        </div>
      )}
    </div>
  )
}

// ===========================================================================
// 可退清单
// ===========================================================================

function Refundables({ bump, onErr, onPick }: any) {
  const [rows, setRows] = useState<any[]>([])
  useEffect(() => {
    api.get('/refunds/refundables')
      .then((r: any) => setRows((r.data || r).list || r.data || r || []))
      .catch((e: any) => onErr(e.message))
  }, [bump])

  const list = Array.isArray(rows) ? rows : []

  return (
    <div className="bg-white border border-ink-200 rounded overflow-hidden">
      <table className="w-full text-[12px]">
        <thead className="bg-ink-50 text-slate-500">
          <tr>
            <th className="text-left px-3 py-2 font-normal">退货单号</th>
            <th className="text-left px-3 py-2 font-normal">退货日期</th>
            <th className="text-left px-3 py-2 font-normal">客户</th>
            <th className="text-right px-3 py-2 font-normal">待退款额</th>
            <th className="text-right px-3 py-2 font-normal">已确认退款</th>
            <th className="text-right px-3 py-2 font-normal">可退余额</th>
            <th className="text-right px-3 py-2 font-normal">操作</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r: any) => (
            <tr key={r.return_id} className="border-t border-ink-100 hover:bg-ink-50/40">
              <td className="px-3 py-2">{r.doc_no}</td>
              <td className="px-3 py-2 text-slate-500">{r.return_date}</td>
              <td className="px-3 py-2">{r.customer?.name || r.customer?.type || '—'}</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(r.refund_due)}</td>
              <td className="px-3 py-2 text-right font-mono text-slate-500">{fmt(r.refunded)}</td>
              <td className="px-3 py-2 text-right font-mono font-medium text-brand-700">{fmt(r.refundable)}</td>
              <td className="px-3 py-2 text-right">
                <button className="text-brand-700 hover:underline inline-flex items-center gap-0.5" onClick={() => onPick(r)}>
                  <Undo2 size={12} /> 去退款
                </button>
              </td>
            </tr>
          ))}
          {!list.length && (
            <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">没有待退款的退货单</td></tr>
          )}
        </tbody>
      </table>
      <div className="px-3 py-2 text-[11px] text-slate-400 border-t border-ink-100">
        这里的"可退余额"与后端校验用的是同一个判据（待退款额 − <b>已确认</b>退款额）；
        草稿不占用额度 —— 否则"先建单、后作废"会变成一条永远退不出去的路。
      </div>
    </div>
  )
}

// ===========================================================================
// 登记退款单
// ===========================================================================

function CreateModal({ open, meta, prefill, onClose, onErr, onDone }: any) {
  const [rows, setRows] = useState<any[]>([])
  const [form, setForm] = useState<any>({ method: 'bank' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    onErr?.('')
    setForm({ method: 'bank', refund_date: new Date().toISOString().slice(0, 10) })
    setRows(prefill ? [{ return_id: prefill.return_id, amount: prefill.refundable, _info: prefill }] : [])
    if (!prefill) {
      api.get('/refunds/refundables')
        .then((r: any) => {
          const raw = r.data || r
          setRows([{ return_id: '', amount: '' }])
          setForm((f: any) => ({ ...f, _opts: Array.isArray(raw) ? raw : raw.list || [] }))
        })
        .catch((e: any) => onErr(e.message))
    }
  }, [open, prefill])

  const opts: any[] = form._opts || [prefill].filter(Boolean)
  const infoOf = (id: any) => opts.find((o: any) => Number(o.return_id) === Number(id))

  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)
  // 与前端口径一致地"先自己拦一道"：超了就说明是哪一张、差多少。
  // 后端仍会独立校验（前端拦是为了体验，不是为了让后端省事）
  const overs = rows
    .map((r) => {
      const info = infoOf(r.return_id)
      if (!info || !(Number(r.amount) > 0)) return null
      const over = Number(r.amount) - Number(info.refundable)
      return over > 0.005 ? { doc: info.doc_no, over, avail: info.refundable } : null
    })
    .filter(Boolean) as any[]

  const submit = () => {
    if (!rows.length || rows.some((r) => !r.return_id || !(Number(r.amount) > 0))) {
      return onErr('请完整填写分摊明细（退货单 + 金额 > 0）')
    }
    if (overs.length) return onErr(`超过待退款余额：${overs.map((o) => `${o.doc} 超 ${fmt(o.over)}`).join('；')}`)
    setSaving(true)
    api.post('/refunds', {
      items: rows.map((r) => ({ return_id: Number(r.return_id), amount: Number(r.amount) })),
      refund_date: form.refund_date,
      method: form.method,
      serial_no: form.serial_no || null,
      bank_account: form.bank_account || null,
      remark: form.remark || null
    })
      .then((r: any) => { toast(`已登记 ${(r.data || r).doc_no}（钱未动，待确认后出账）`); onDone() })
      .catch((e: any) => onErr(e.message))
      .finally(() => setSaving(false))
  }

  return (
    <Modal
      open={open}
      title="登记退款单（登记 ≠ 出账：钱要点了「确认退款」才出去）"
      onClose={onClose}
      width={860}
      footer={
        <>
          <button className="px-3 py-1.5 rounded border border-ink-300 text-[12px] bg-white" onClick={onClose}>取消</button>
          <button className="px-3 py-1.5 rounded bg-brand-700 text-white text-[12px] disabled:opacity-40"
            disabled={saving || overs.length > 0} onClick={submit}>
            登记（金额 {fmt(total)}）
          </button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3 mb-3">
        <Field label="退款日期">
          <input type="date" className="input" value={form.refund_date || ''} onChange={(e) => setForm({ ...form, refund_date: e.target.value })} />
        </Field>
        <Field label="退款方式">
          <select className="input" value={form.method || 'bank'} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            {(meta.methods || []).map((m: any) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="流水号">
          <input className="input" value={form.serial_no || ''} onChange={(e) => setForm({ ...form, serial_no: e.target.value })} placeholder="银行 / 支付流水号" />
        </Field>
      </div>

      <div className="text-[12px] font-medium mb-1.5">分摊明细（退哪张退货单、退多少）</div>
      <table className="w-full text-[12px] mb-2">
        <thead className="text-slate-400 bg-ink-50">
          <tr>
            <th className="text-left px-2 py-1.5 font-normal">退货单</th>
            <th className="text-right px-2 py-1.5 font-normal">待退款额</th>
            <th className="text-right px-2 py-1.5 font-normal">可退余额</th>
            <th className="text-right px-2 py-1.5 font-normal">本次退款</th>
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const info = infoOf(r.return_id)
            const over = info && Number(r.amount) - Number(info.refundable) > 0.005
            return (
              <tr key={i} className="border-t border-ink-100">
                <td className="px-2 py-1.5">
                  <select className="input" value={r.return_id} onChange={(e) => {
                    const next = [...rows]; next[i] = { ...r, return_id: e.target.value }; setRows(next)
                  }}>
                    <option value="">选择退货单…</option>
                    {opts.map((o: any) => (
                      <option key={o.return_id} value={o.return_id}>
                        {o.doc_no} · {o.customer?.name || ''} · 可退 {fmtMoney(o.refundable)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-slate-500">{info ? fmt(info.refund_due) : '—'}</td>
                <td className="px-2 py-1.5 text-right font-mono text-slate-500">{info ? fmt(info.refundable) : '—'}</td>
                <td className="px-2 py-1.5 text-right">
                  <input type="number" step="0.01" className={`input text-right ${over ? 'border-red-400' : ''}`}
                    value={r.amount} onChange={(e) => {
                      const next = [...rows]; next[i] = { ...r, amount: e.target.value }; setRows(next)
                    }} />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button className="text-slate-400 hover:text-red-500" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <button className="text-[12px] text-brand-700 inline-flex items-center gap-0.5"
        onClick={() => setRows([...rows, { return_id: '', amount: '' }])}>
        <Plus size={12} /> 增加一行
      </button>

      {overs.length > 0 && (
        <div className="mt-2 text-[11px] text-red-500 flex items-start gap-1">
          <AlertTriangle size={12} className="mt-0.5" />
          <span>超过待退款余额：{overs.map((o) => `${o.doc}（可退 ${fmt(o.avail)}，本行超 ${fmt(o.over)}）`).join('；')}。退款不能超过退货时登记的待退款额。</span>
        </div>
      )}

      <div className="mt-3">
        <Field label="备注">
          <input className="input" value={form.remark || ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
