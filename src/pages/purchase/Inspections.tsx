/**
 * ============================================================================
 * 文件标识：src/pages/purchase/Inspections.tsx ｜ Inspections（页面，未取到标题）
 * ============================================================================
 * 【职责】Inspections（页面，未取到标题）（页面）
 * 【入口】/purchase/inspections
 * 【主要接口】/purchase/inspections/overview、/purchase/inspections/pending、/purchase/inspections/meta
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
 * 页面：Inspections（页面，未取到标题）
 */

import { useMemo, useState } from 'react'
import {
  Card, Field, Modal, Status, StatCard, Tabs, Empty, fmtMoney, fmtInt, fmtNum, today, toast, useFetch
} from '../../components/ui'
import api from '../../api/client'
import {
  QC_META, QC_RECEIPT, QC_CREATE, QC_SUBMIT, QC_CLOSE, QC_CANCEL,
  RESULT_CLS, lineClosed,
  type Inspection, type InspectionItem, type PendingReceipt, type QcMeta, type QcOverview
} from '../../api/qc'
import { ClipboardCheck, AlertTriangle, RotateCcw, Search } from 'lucide-react'

/**
 * 采购质检（模块 07：到货单与质检单拆分）。
 *
 * 页面结构对应的三件事：
 *   ① 顶部四张卡：待质检的活有多少、判退了多少、判退金额、判退率 ——
 *      判退率是这一页存在的意义；一张判退都没有的质检，只是一张纸。
 *   ② 「待质检」页签：质检岗的工作台。列出还没出结论的到货单，
 *      已经建过草稿的会带出草稿号（点进去是**改**那张草稿，不是再建一张）。
 *   ③ 「质检单」页签：历史记录。点开看行级三数、判退后果（退货单号）与流转留痕。
 *
 * 界面上守了两条口径：
 *   · 行内「合格 + 让步 + 判退」必须等于到货数，实时算给你看，不合法就不给提交；
 *   · 判退量不是普通输入 —— 它会在提交时生成退货单并出库，库存不够会整单失败。
 *     所以填了判退时，界面直接把这句话写在旁边，而不是等提交失败再解释。
 */
export default function Inspections() {
  const [tab, setTab] = useState<'pending' | 'docs'>('pending')
  const [tick, setTick] = useState(0)
  const overview = useFetch<QcOverview>('/purchase/inspections/overview', undefined, [tick])

  const reloadAll = () => setTick((t) => t + 1)

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[17px] font-semibold text-slate-800 flex items-center gap-2">
            <ClipboardCheck size={18} className="text-brand-700" /> 采购质检
          </h1>
          <p className="text-[12.5px] text-slate-500 mt-1 max-w-3xl leading-relaxed">
            到货单记<strong>事实</strong>（送来了什么、多少件、什么批次），质检单记<strong>判断</strong>（收不收、收多少合格、
            多少让步接收、多少判退、为什么）。两单分开的理由很实际：判断要能被统计、要有后果、
            而且判断的时间常常晚于到货。
          </p>
        </div>
        <button className="btn-ghost btn-sm" onClick={reloadAll}>
          <RotateCcw size={14} /> 刷新
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard
          label="待质检到货单"
          value={overview.data?.waiting_receipts ?? '—'}
          sub={
            (overview.data?.draft_ready || 0) > 0
              ? `其中 ${overview.data?.draft_ready} 张已建草稿待提交`
              : '收到货但还没出结论'
          }
          tone="amber"
          icon={<AlertTriangle size={15} />}
        />
        <StatCard label="质检单总数" value={overview.data?.total ?? '—'} sub={`已出结论 ${overview.data?.inspected ?? '—'}`} />
        <StatCard
          label="判退数量"
          value={fmtInt(overview.data?.rejected_qty)}
          sub={`让步接收 ${fmtInt(overview.data?.concession_qty)}`}
          tone="red"
        />
        <StatCard
          label="判退金额"
          value={`¥${fmtMoney(overview.data?.rejected_amount)}`}
          sub={`已生成退货单 ${overview.data?.returns_created ?? 0} 张`}
          tone="red"
        />
        <StatCard
          label="判退率（按数量）"
          value={`${fmtNum(overview.data?.reject_rate, 2)}%`}
          sub="金额会被高价值 SKU 带偏，所以按数量算"
          tone="brand"
        />
      </div>

      <Tabs
        tabs={[
          { key: 'pending', label: '待质检', count: overview.data?.waiting_receipts },
          { key: 'docs', label: '质检单', count: overview.data?.total }
        ]}
        value={tab}
        onChange={(k) => setTab(k as any)}
      />

      {tab === 'pending' ? <PendingBoard onDone={reloadAll} /> : <DocList onDone={reloadAll} />}
    </div>
  )
}

// ===========================================================================
// 待质检工作台
// ===========================================================================
function PendingBoard({ onDone }: { onDone: () => void }) {
  const { data, loading, reload } = useFetch<{ list: PendingReceipt[] }>('/purchase/inspections/pending', { limit: 200 })
  const [kw, setKw] = useState('')
  const [editing, setEditing] = useState<Inspection | null>(null)

  const list = useMemo(() => {
    const all = data?.list || []
    const k = kw.trim().toLowerCase()
    if (!k) return all
    return all.filter((r) =>
      [r.doc_no, r.supplier_name, r.warehouse_name, r.order_no, r.draft_no]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(k))
    )
  }, [data, kw])

  const openInspect = async (row: PendingReceipt) => {
    try {
      if (row.draft_id) {
        // 有草稿就打开草稿。**不能**再建一张：一票一单，会撞唯一约束，
        // 而那个报错信息（唯一约束冲突）跟真实原因（上次提交没成功）毫无关系。
        const d = await QC_RECEIPT(row.id)
        if (!d.inspection) return toast('草稿已不存在，请刷新后重试', 'error')
        setEditing({ ...d.inspection, items: d.inspection.items || [] })
        return
      }
      const fill = await QC_RECEIPT(row.id)
      const ins = await QC_CREATE({
        receipt_id: row.id,
        inspect_date: today(),
        // 默认全部合格：正常情况一次点击，「异常」才需要人改数字。
        // 反过来（默认待定）会让人每次都从零填。
        items: (fill.items || []).map((it) => ({
          receipt_item_id: it.id,
          qualified_qty: Number(it.qty || 0),
          concession_qty: 0,
          rejected_qty: 0
        }))
      })
      setEditing({ ...ins, items: ins.items || [] })
    } catch (e: any) {
      toast(e.message || '打开质检单失败', 'error')
    }
  }

  const close = (changed?: boolean) => {
    setEditing(null)
    if (changed) {
      reload()
      onDone()
    }
  }

  return (
    <Card pad={false}>
      <div className="p-3 flex items-center gap-2 flex-wrap border-b border-slate-100">
        <Search size={15} className="text-slate-400" />
        <input
          className="input input-sm"
          style={{ width: 240 }}
          placeholder="到货单号 / 供应商 / 仓库 / 采购单号"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
        <span className="text-[12px] text-slate-400 ml-auto">
          共 {list.length} 张待质检{kw ? `（已筛选，全部 ${data?.list?.length || 0} 张）` : ''}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 150 }}>到货单号</th>
              <th style={{ width: 110 }}>到货日期</th>
              <th style={{ width: 200 }}>供应商</th>
              <th style={{ width: 140 }}>收货仓库</th>
              <th style={{ width: 140 }}>采购单</th>
              <th style={{ width: 90, textAlign: 'right' }}>到货数量</th>
              <th style={{ width: 110, textAlign: 'right' }}>到货金额</th>
              <th style={{ width: 150 }}>质检状态</th>
              <th style={{ width: 110 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td className="font-medium text-slate-700">{r.doc_no}</td>
                <td>{r.receipt_date}</td>
                <td>{r.supplier_name || '—'}</td>
                <td>{r.warehouse_name || '—'}</td>
                <td>{r.order_no || '（无采购单）'}</td>
                <td style={{ textAlign: 'right' }}>{fmtNum(r.total_qty, 2)}</td>
                <td style={{ textAlign: 'right' }}>¥{fmtMoney(r.total_amount)}</td>
                <td>
                  {r.draft_id ? (
                    <span className="tag bg-orange-100 text-orange-700">草稿待提交 {r.draft_no}</span>
                  ) : (
                    <span className="tag bg-slate-100 text-slate-600">待质检</span>
                  )}
                </td>
                <td>
                  <button className="btn-ghost btn-sm" onClick={() => openInspect(r)}>
                    {r.draft_id ? '继续填写' : '开始质检'}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={9}>
                  <Empty text={kw ? '没有匹配的到货单' : '待质检队列已清空 —— 收到的货都出过结论了'} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && <InspectModal ins={editing} onClose={close} />}
    </Card>
  )
}

// ===========================================================================
// 质检单列表
// ===========================================================================
function DocList({ onDone }: { onDone: () => void }) {
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [result, setResult] = useState('')
  const [kw, setKw] = useState('')
  const [tick, setTick] = useState(0)
  const { data, loading } = useFetch<any>(
    '/purchase/inspections',
    { page, pageSize: 20, status: status || undefined, result: result || undefined },
    [page, status, result, tick]
  )
  const meta = useFetch<QcMeta>('/purchase/inspections/meta', undefined, [])
  const [detail, setDetail] = useState<Inspection | null>(null)

  const rows: Inspection[] = (data?.list || []).filter((r: Inspection) => {
    const k = kw.trim().toLowerCase()
    if (!k) return true
    return [r.doc_no, r.receipt_no, r.supplier_name, r.warehouse_name, r.return_no]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(k))
  })

  const openDetail = async (id: number) => {
    try {
      const d = await api.get(`/purchase/inspections/${id}`)
      setDetail(d.data)
    } catch (e: any) {
      toast(e.message || '打开失败', 'error')
    }
  }

  const total = data?.total || 0
  const pages = Math.max(1, Math.ceil(total / 20))

  return (
    <Card pad={false}>
      <div className="p-3 flex items-center gap-2 flex-wrap border-b border-slate-100">
        <Search size={15} className="text-slate-400" />
        <input
          className="input input-sm"
          style={{ width: 220 }}
          placeholder="质检单号 / 到货单号 / 供应商 / 退货单号"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
        <select className="input input-sm" style={{ width: 130 }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="inspected">已出结论</option>
          <option value="closed">已关闭</option>
          <option value="cancelled">已取消</option>
        </select>
        <select className="input input-sm" style={{ width: 140 }} value={result} onChange={(e) => { setResult(e.target.value); setPage(1) }}>
          <option value="">全部结论</option>
          {(meta.data?.results || []).map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
        <span className="text-[12px] text-slate-400 ml-auto">共 {total} 张</span>
      </div>

      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 150 }}>质检单号</th>
              <th style={{ width: 150 }}>到货单号</th>
              <th style={{ width: 110 }}>检验日期</th>
              <th style={{ width: 190 }}>供应商</th>
              <th style={{ width: 100 }}>结论</th>
              <th style={{ width: 80, textAlign: 'right' }}>到货数</th>
              <th style={{ width: 80, textAlign: 'right' }}>合格</th>
              <th style={{ width: 80, textAlign: 'right' }}>让步</th>
              <th style={{ width: 80, textAlign: 'right' }}>判退</th>
              <th style={{ width: 150 }}>判退后果</th>
              <th style={{ width: 90 }}>状态</th>
              <th style={{ width: 90 }}>检验员</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => openDetail(r.id)}>
                <td className="font-medium text-slate-700">{r.doc_no}</td>
                <td>{r.receipt_no || '—'}</td>
                <td>{r.inspect_date}</td>
                <td>{r.supplier_name || '—'}</td>
                <td>
                  <span className={`tag ${RESULT_CLS[r.result] || RESULT_CLS.pending}`}>{r.result_label || r.result}</span>
                </td>
                <td style={{ textAlign: 'right' }}>{fmtNum(r.total_qty, 2)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNum(r.qualified_qty, 2)}</td>
                <td style={{ textAlign: 'right' }} className={Number(r.concession_qty) > 0 ? 'text-amber-600' : ''}>
                  {fmtNum(r.concession_qty, 2)}
                </td>
                <td style={{ textAlign: 'right' }} className={Number(r.rejected_qty) > 0 ? 'text-red-600 font-medium' : ''}>
                  {fmtNum(r.rejected_qty, 2)}
                </td>
                <td>
                  {r.return_no ? (
                    <span className="text-[12px] text-slate-600">退货单 {r.return_no}</span>
                  ) : Number(r.rejected_qty) > 0 ? (
                    <span className="tag bg-red-100 text-red-600">判退未生成退货单</span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td><Status value={r.status} /></td>
                <td>{r.inspect_by_name || '—'}</td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={12}>
                  <Empty text="没有匹配的质检单" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="p-3 flex items-center justify-end gap-2 border-t border-slate-100">
          <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
          <span className="text-[12px] text-slate-500">{page} / {pages}</span>
          <button className="btn-ghost btn-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>下一页</button>
        </div>
      )}

      {detail && (
        <DetailModal
          ins={detail}
          onClose={() => setDetail(null)}
          onChanged={() => { setTick((t) => t + 1); onDone() }}
        />
      )}
    </Card>
  )
}

// ===========================================================================
// 质检填写 / 提交
// ===========================================================================
function InspectModal({ ins, onClose }: { ins: Inspection; onClose: (changed?: boolean) => void }) {
  const meta = useFetch<QcMeta>('/purchase/inspections/meta', undefined, [])
  const [lines, setLines] = useState<InspectionItem[]>(ins.items || [])
  const [remark, setRemark] = useState(ins.remark || '')
  const [saving, setSaving] = useState(false)

  const patch = (id: number, p: Partial<InspectionItem>) =>
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)))

  /** 改合格数时把差额留给判退，保证「三数之和 = 到货数」这条硬口径在界面上就成立 */
  const setQualified = (l: InspectionItem, v: number) => {
    const q = Number(v || 0)
    const rest = Number((Number(l.qty) - q - Number(l.concession_qty || 0)).toFixed(4))
    patch(l.id, { qualified_qty: q, rejected_qty: rest >= 0 ? rest : 0 })
  }
  const setConcession = (l: InspectionItem, v: number) => {
    const c = Number(v || 0)
    const rest = Number((Number(l.qty) - c - Number(l.qualified_qty || 0)).toFixed(4))
    patch(l.id, { concession_qty: c, rejected_qty: rest >= 0 ? rest : 0 })
  }
  const setRejected = (l: InspectionItem, v: number) => {
    const j = Number(v || 0)
    const rest = Number((Number(l.qty) - j - Number(l.concession_qty || 0)).toFixed(4))
    patch(l.id, { rejected_qty: j, qualified_qty: rest >= 0 ? rest : 0 })
  }

  const allClosed = lines.every(lineClosed)
  const totalRejected = lhs(lines, 'rejected_qty')
  const totalConcession = lhs(lines, 'concession_qty')

  const submit = async () => {
    if (!allClosed) return toast('每一行的「合格 + 让步 + 判退」必须等于到货数量', 'error')
    if (totalRejected > 0 && lines.some((l) => Number(l.rejected_qty) > 0 && !l.defect_reason)) {
      return toast('判退的行必须写清不合格原因 —— 这是后面索赔的依据', 'error')
    }
    setSaving(true)
    try {
      const out = await QC_SUBMIT(ins.id, {
        remark: remark || undefined,
        lines: lines.map((l) => ({
          id: l.id,
          qualified_qty: Number(l.qualified_qty || 0),
          concession_qty: Number(l.concession_qty || 0),
          rejected_qty: Number(l.rejected_qty || 0),
          defect_code: l.defect_code || null,
          defect_reason: l.defect_reason || null,
          remark: l.remark || null
        }))
      })
      if (out.return_created) {
        toast(`质检已提交，判退已生成退货单 ${out.return_created.doc_no} 并出库`)
      } else {
        toast('质检已提交')
      }
      onClose(true)
    } catch (e: any) {
      toast(e.message || '提交失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const cancel = async () => {
    if (!window.confirm('作废这张质检单？作废后可以对同一张到货单重新开单。')) return
    try {
      await QC_CANCEL(ins.id, '界面作废')
      toast('已作废')
      onClose(true)
    } catch (e: any) {
      toast(e.message || '作废失败', 'error')
    }
  }

  return (
    <Modal
      open
      title={`质检 · ${ins.doc_no}`}
      width={1080}
      onClose={() => onClose(false)}
      footer={
        <>
          <button className="btn-ghost" onClick={() => onClose(false)}>关闭</button>
          <button className="btn-ghost text-red-600" onClick={cancel}>作废</button>
          <button className="btn-primary" disabled={saving || !allClosed} onClick={submit}>
            {saving ? '提交中…' : '提交质检结论'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-4 gap-4 mb-4 text-[13px]">
        <div>
          <div className="text-slate-400 text-[12px]">到货单</div>
          <div className="font-medium">{ins.receipt_no || '—'}</div>
        </div>
        <div>
          <div className="text-slate-400 text-[12px]">供应商</div>
          <div className="font-medium">{ins.supplier_name || '—'}</div>
        </div>
        <div>
          <div className="text-slate-400 text-[12px]">收货仓库</div>
          <div className="font-medium">{ins.warehouse_name || '—'}</div>
        </div>
        <div>
          <div className="text-slate-400 text-[12px]">检验日期</div>
          <div className="font-medium">{ins.inspect_date}</div>
        </div>
      </div>

      <div className="overflow-x-auto mb-3">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 200 }}>商品</th>
              <th style={{ width: 140 }}>批次</th>
              <th style={{ width: 90, textAlign: 'right' }}>到货数量</th>
              <th style={{ width: 110, textAlign: 'right' }}>合格</th>
              <th style={{ width: 110, textAlign: 'right' }}>让步接收</th>
              <th style={{ width: 110, textAlign: 'right' }}>判退</th>
              <th style={{ width: 130 }}>不合格原因</th>
              <th style={{ width: 220 }}>说明</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className={lineClosed(l) ? '' : 'bg-red-50'}>
                <td>
                  <div className="text-slate-700">{l.sku_name || `SKU#${l.sku_id}`}</div>
                  <div className="text-[11px] text-slate-400">{l.sku_code}</div>
                </td>
                <td className="text-[12px] text-slate-500">{l.batch_no || '（无批次）'}</td>
                <td style={{ textAlign: 'right' }}>{fmtNum(l.qty, 2)}</td>
                <td style={{ textAlign: 'right' }}>
                  <input
                    className="input input-sm"
                    type="number"
                    style={{ width: 92, textAlign: 'right' }}
                    value={l.qualified_qty ?? 0}
                    onChange={(e) => setQualified(l, Number(e.target.value))}
                  />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input
                    className="input input-sm"
                    type="number"
                    style={{ width: 92, textAlign: 'right' }}
                    value={l.concession_qty ?? 0}
                    onChange={(e) => setConcession(l, Number(e.target.value))}
                  />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input
                    className={`input input-sm ${Number(l.rejected_qty) > 0 ? 'text-red-600 font-medium' : ''}`}
                    type="number"
                    style={{ width: 92, textAlign: 'right' }}
                    value={l.rejected_qty ?? 0}
                    onChange={(e) => setRejected(l, Number(e.target.value))}
                  />
                </td>
                <td>
                  <select
                    className="input input-sm"
                    value={l.defect_code || ''}
                    onChange={(e) => patch(l.id, { defect_code: e.target.value })}
                  >
                    <option value="">—</option>
                    {(meta.data?.defect_codes || []).map((d) => (
                      <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className="input input-sm"
                    placeholder="不合格说明（判退时必填）"
                    value={l.defect_reason || ''}
                    onChange={(e) => patch(l.id, { defect_reason: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="p-2.5 rounded border border-slate-200 bg-slate-50 text-[12.5px]">
          <span className="text-slate-500">让步接收合计</span>
          <span className="ml-2 font-medium text-amber-600">{fmtNum(totalConcession, 2)}</span>
          <div className="text-[11.5px] text-slate-400 mt-1">不影响入库数量，但会留痕 —— 混进「合格」里，索赔依据就没了</div>
        </div>
        <div className="p-2.5 rounded border border-slate-200 bg-slate-50 text-[12.5px]">
          <span className="text-slate-500">判退合计</span>
          <span className="ml-2 font-medium text-red-600">{fmtNum(totalRejected, 2)}</span>
          <div className="text-[11.5px] text-slate-400 mt-1">提交后会生成采购退货单并反向出库；库存不够会整单失败</div>
        </div>
        <div className={`p-2.5 rounded border text-[12.5px] ${allClosed ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
          <span className="text-slate-500">三数闭合检查</span>
          <span className={`ml-2 font-medium ${allClosed ? 'text-green-700' : 'text-red-600'}`}>
            {allClosed ? '通过' : '不通过'}
          </span>
          <div className="text-[11.5px] text-slate-400 mt-1">合格 + 让步 + 判退 必须等于到货数量，否则有货凭空消失</div>
        </div>
      </div>

      <Field label="质检备注">
        <input className="input" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="可选" />
      </Field>
    </Modal>
  )
}

// ===========================================================================
// 详情
// ===========================================================================
function DetailModal({ ins, onClose, onChanged }: { ins: Inspection; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)

  const act = async (kind: 'close' | 'cancel') => {
    if (kind === 'cancel' && !window.confirm('作废这张质检单？')) return
    setBusy(true)
    try {
      if (kind === 'close') await QC_CLOSE(ins.id)
      else await QC_CANCEL(ins.id, '界面作废')
      toast(kind === 'close' ? '已归档' : '已作废')
      onChanged()
      onClose()
    } catch (e: any) {
      toast(e.message || '操作失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title={`质检单 ${ins.doc_no}`}
      width={1000}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>关闭</button>
          {ins.status === 'draft' && <button className="btn-ghost text-red-600" disabled={busy} onClick={() => act('cancel')}>作废</button>}
          {ins.status === 'inspected' && <button className="btn-ghost" disabled={busy} onClick={() => act('close')}>归档</button>}
        </>
      }
    >
      <div className="grid grid-cols-4 gap-4 mb-4 text-[13px]">
        <div>
          <div className="text-slate-400 text-[12px]">到货单</div>
          <div className="font-medium">{ins.receipt_no || '—'}</div>
        </div>
        <div>
          <div className="text-slate-400 text-[12px]">采购单</div>
          <div className="font-medium">{ins.order_no || '—'}</div>
        </div>
        <div>
          <div className="text-slate-400 text-[12px]">供应商</div>
          <div className="font-medium">{ins.supplier_name || '—'}</div>
        </div>
        <div>
          <div className="text-slate-400 text-[12px]">结论 / 状态</div>
          <div className="flex items-center gap-2">
            <span className={`tag ${RESULT_CLS[ins.result] || RESULT_CLS.pending}`}>{ins.result_label || ins.result}</span>
            <Status value={ins.status} />
          </div>
        </div>
      </div>

      <div className="overflow-x-auto mb-4">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 200 }}>商品</th>
              <th style={{ width: 140 }}>批次</th>
              <th style={{ width: 90, textAlign: 'right' }}>到货数量</th>
              <th style={{ width: 90, textAlign: 'right' }}>合格</th>
              <th style={{ width: 90, textAlign: 'right' }}>让步</th>
              <th style={{ width: 90, textAlign: 'right' }}>判退</th>
              <th style={{ width: 260 }}>不合格说明</th>
            </tr>
          </thead>
          <tbody>
            {(ins.items || []).map((l) => (
              <tr key={l.id}>
                <td>
                  <div className="text-slate-700">{l.sku_name || `SKU#${l.sku_id}`}</div>
                  <div className="text-[11px] text-slate-400">{l.sku_code}</div>
                </td>
                <td className="text-[12px] text-slate-500">{l.batch_no || '（无批次）'}</td>
                <td style={{ textAlign: 'right' }}>{fmtNum(l.qty, 2)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNum(l.qualified_qty, 2)}</td>
                <td style={{ textAlign: 'right' }} className={Number(l.concession_qty) > 0 ? 'text-amber-600' : ''}>
                  {fmtNum(l.concession_qty, 2)}
                </td>
                <td style={{ textAlign: 'right' }} className={Number(l.rejected_qty) > 0 ? 'text-red-600 font-medium' : ''}>
                  {fmtNum(l.rejected_qty, 2)}
                </td>
                <td className="text-[12px] text-slate-600">{l.defect_reason || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {Number(ins.rejected_qty) > 0 && (
        <div className="p-3 rounded border border-red-200 bg-red-50 text-[12.5px] mb-4">
          <div className="font-medium text-red-700 mb-1">判退后果</div>
          {ins.return_no ? (
            <div className="text-slate-700">
              已生成采购退货单 <span className="font-medium">{ins.return_no}</span> 并反向出库 —— 判退不是只改结论。
            </div>
          ) : (
            <div className="text-slate-700">判退数量已记录，但还没有对应的退货单（草稿未提交时属正常）。</div>
          )}
        </div>
      )}

      {(ins.events || []).length > 0 && (
        <div>
          <div className="text-[12.5px] font-medium text-slate-700 mb-2">流转留痕</div>
          <div className="space-y-1.5">
            {(ins.events || []).map((e, i) => (
              <div key={i} className="flex items-start gap-2 text-[12.5px]">
                <span className="text-slate-400 w-40 shrink-0">{e.created_at}</span>
                <span className="text-slate-700">{e.action_name || e.action}</span>
                <span className="text-slate-400">{e.from_state} → {e.to_state}</span>
                {e.actor_name && <span className="text-slate-500">{e.actor_name}</span>}
                {e.remark && <span className="text-slate-400">· {e.remark}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {ins.remark && <div className="mt-3 text-[12.5px] text-slate-500">备注：{ins.remark}</div>}
    </Modal>
  )
}

function lhs(list: InspectionItem[], key: 'rejected_qty' | 'concession_qty') {
  return Number(list.reduce((s, l) => s + Number(l[key] || 0), 0).toFixed(2))
}
