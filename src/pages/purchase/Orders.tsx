/**
 * ============================================================================
 * 文件标识：src/pages/purchase/Orders.tsx ｜ 采购订单
 * ============================================================================
 * 【职责】采购订单（页面）
 * 【入口】/purchase/orders
 * 【主要接口】/purchase/stats、/purchase/orders
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
 * 页面：采购订单
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../api/client'
import { Card, Field, Modal, Pagination, StatCard, Status, Table, Tabs, fmtInt, fmtMoney, toast, useFetch, useList } from '../../components/ui'
import { DateRange, FilterBar, Inp, Sel } from '../../components/DataPage'
import { LinesEditor, Line } from '../../components/Lines'
import { handleApprovalPending } from '../../api/approval'
import { useDict, useOpts } from '../../hooks/opts'
import { RefreshCw, Plus, Eye } from 'lucide-react'

export default function PurchaseOrders() {
  const nav = useNavigate()
  const o = useOpts()
  const { purchaseStatus } = useDict()
  const [tab, setTab] = useState('')
  const [keyword, setKeyword] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [range, setRange] = useState({ from: '', to: '' })
  const { list, total, loading, page, pageSize, setPage, reload } = useList('/purchase/orders', {})
  const { data: stats, reload: reloadStats } = useFetch<any>('/purchase/stats')

  // 简单筛选：本地实现（tab / keyword / 日期 / 供应商）
  const filtered = list.filter((r: any) => {
    if (tab && r.status !== tab) return false
    if (supplierId && String(r.supplier_id) !== String(supplierId)) return false
    if (range.from && r.order_date < range.from) return false
    if (range.to && r.order_date > range.to) return false
    if (keyword && !(`${r.doc_no} ${r.supplier_name}`.toLowerCase().includes(keyword.toLowerCase()))) return false
    return true
  })

  const [createOpen, setCreateOpen] = useState(false)
  const [recvOpen, setRecvOpen] = useState(false)
  const [current, setCurrent] = useState<any>(null)

  const refresh = () => {
    reload()
    reloadStats()
  }

  const act = async (row: any, action: string) => {
    const label: Record<string, string> = { submit: '提交审批', approve: '审批通过', close: '关闭订单', cancel: '取消订单' }
    if (!confirm(`确认对 ${row.doc_no} 执行「${label[action]}」？`)) return
    try {
      await api.post(`/purchase/orders/${row.id}/status`, { action })
      toast('操作成功')
      refresh()
    } catch (e: any) {
      // 模块 22：这个动作可能被审批闸门拦下（后端返 409 / APPROVAL_PENDING）。
      // 这不是失败，是「需要先走审批」—— 统一引导，而不是丢一句「操作失败」。
      const handled = await handleApprovalPending(e, {
        docType: 'PO',
        docId: row.id,
        docNo: row.doc_no,
        action,
        onSubmitted: refresh
      })
      if (!handled) toast(e.message, 'error')
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">采购订单</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">订单 → 审批 → 收货入库 → 采购退货 的完整闭环</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={refresh}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> 新建采购订单
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="订单总数" value={fmtInt((stats?.byStatus || []).reduce((s: number, x: any) => s + x.cnt, 0))} sub="全量采购订单" />
        <StatCard label="待审批" value={fmtInt(stats?.byStatus?.find((x: any) => x.status === 'submitted')?.cnt)} sub={`金额 ¥${fmtMoney(stats?.byStatus?.find((x: any) => x.status === 'submitted')?.amount, 0)}`} tone="amber" />
        <StatCard label="已审批在途" value={fmtInt(stats?.byStatus?.find((x: any) => x.status === 'approved')?.cnt)} sub={`金额 ¥${fmtMoney(stats?.byStatus?.find((x: any) => x.status === 'approved')?.amount, 0)}`} tone="brand" />
        <StatCard label="采购在途待收货" value={fmtInt(stats?.pending)} sub="需安排收货入库" tone="red" />
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[{ key: '', label: '全部' }, ...purchaseStatus.map((s) => ({ key: String(s.value), label: s.label }))]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>

      <FilterBar
        onReset={() => {
          setKeyword('')
          setSupplierId('')
          setRange({ from: '', to: '' })
        }}
      >
        <Inp value={keyword} onChange={setKeyword} placeholder="单号 / 供应商" w={200} />
        <Sel value={supplierId} onChange={setSupplierId} options={o.suppliers} placeholder="全部供应商" w={190} />
        <DateRange from={range.from} to={range.to} onFrom={(v) => setRange({ ...range, from: v })} onTo={(v) => setRange({ ...range, to: v })} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '采购单号', width: 150, render: (r) => <span className="link" onClick={() => nav(`/purchase/orders/${r.id}`)}>{r.doc_no}</span> },
            { key: 'supplier_name', title: '供应商', width: 220 },
            { key: 'warehouse_name', title: '收货仓库', width: 140 },
            { key: 'order_date', title: '下单日期', width: 110 },
            { key: 'expect_date', title: '期望到货', width: 110 },
            { key: 'buyer', title: '采购员', width: 90 },
            { key: 'item_count', title: '行数', width: 60, align: 'right' },
            { key: 'total_qty', title: '数量', width: 80, align: 'right', render: (r) => fmtInt(r.total_qty) },
            { key: 'total_amount', title: '金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.total_amount)}` },
            { key: 'status', title: '状态', width: 90, render: (r) => <Status value={r.status} /> },
            {
              key: '__act',
              title: '操作',
              width: 190,
              render: (r) => (
                <div className="flex items-center gap-2 text-[12px]">
                  <button className="link inline-flex items-center gap-1" onClick={() => nav(`/purchase/orders/${r.id}`)}>
                    <Eye size={12} /> 详情
                  </button>
                  {r.status === 'draft' && <button className="link" onClick={() => act(r, 'submit')}>提交</button>}
                  {r.status === 'submitted' && <button className="link" onClick={() => act(r, 'approve')}>审批</button>}
                  {['submitted', 'approved'].includes(r.status) && (
                    <button
                      className="link"
                      onClick={() => {
                        setCurrent(r)
                        setRecvOpen(true)
                      }}
                    >
                      收货
                    </button>
                  )}
                  {!['closed', 'cancelled', 'received'].includes(r.status) && (
                    <button className="text-red-500 hover:text-red-600" onClick={() => act(r, 'cancel')}>
                      取消
                    </button>
                  )}
                </div>
              )
            }
          ]}
          data={filtered}
          loading={loading}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>

      <CreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        suppliers={o.suppliers}
        warehouses={o.warehouses}
        skus={o.skus}
        onSaved={refresh}
      />
      <ReceiveModal order={current} open={recvOpen} onClose={() => setRecvOpen(false)} onSaved={refresh} />
    </div>
  )
}

function CreateModal({
  open,
  onClose,
  suppliers,
  warehouses,
  skus,
  onSaved
}: {
  open: boolean
  onClose: () => void
  suppliers: any[]
  warehouses: any[]
  skus: any[]
  onSaved: () => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState<any>({})
  const [lines, setLines] = useState<Line[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setForm({ order_date: today, expect_date: '', settle_type: '月结 30 天' })
      setLines([{ qty: 1, tax_rate: 13 }])
    }
  }, [open, today])

  const submit = async () => {
    if (!form.supplier_id || !form.warehouse_id) return toast('请选择供应商与收货仓库', 'error')
    if (!lines.length || lines.some((l) => !l.sku_id || !(Number(l.qty) > 0))) return toast('请完整填写明细行', 'error')
    setSaving(true)
    try {
      await api.post('/purchase/orders', { ...form, items: lines })
      toast('采购订单已创建')
      onClose()
      onSaved()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title="新建采购订单"
      width={900}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '提交中…' : '保存草稿'}</button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4 mb-4">
        <Field label="供应商" required>
          <select className="input" value={form.supplier_id ?? ''} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
            <option value="">请选择</option>
            {suppliers.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="收货仓库" required>
          <select className="input" value={form.warehouse_id ?? ''} onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}>
            <option value="">请选择</option>
            {warehouses.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="结算方式">
          <input className="input" value={form.settle_type ?? ''} onChange={(e) => setForm({ ...form, settle_type: e.target.value })} />
        </Field>
        <Field label="下单日期">
          <input className="input" type="date" value={form.order_date ?? ''} onChange={(e) => setForm({ ...form, order_date: e.target.value })} />
        </Field>
        <Field label="期望到货日">
          <input className="input" type="date" value={form.expect_date ?? ''} onChange={(e) => setForm({ ...form, expect_date: e.target.value })} />
        </Field>
        <Field label="备注">
          <input className="input" value={form.remark ?? ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
        </Field>
      </div>
      <LinesEditor lines={lines} onChange={setLines} skus={skus} priceKey="cost_std" showTax />
    </Modal>
  )
}

function ReceiveModal({ order, open, onClose, onSaved }: { order: any; open: boolean; onClose: () => void; onSaved: () => void }) {
  const [lines, setLines] = useState<any[]>([])
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [remark, setRemark] = useState('质检合格')
  const [inspector, setInspector] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !order) return
    setDate(new Date().toISOString().slice(0, 10))
    api
      .get(`/purchase/orders/${order.id}/receive-suggest`)
      .then((res: any) => setLines(res.data || []))
      .catch(() => setLines([]))
  }, [open, order])

  const submit = async () => {
    setSaving(true)
    try {
      await api.post(`/purchase/orders/${order.id}/receive`, {
        receipt_date: date,
        inspector,
        remark,
        items: lines.map((l) => ({
          id: l.item_id,
          sku_id: l.sku_id,
          qty: Number(l.pending_qty),
          price: l.price,
          batch_no: l.batch_no,
          produce_date: l.produce_date,
          expire_date: l.expire_date
        }))
      })
      toast('收货完成，库存已入库')
      onClose()
      onSaved()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title={`收货入库 · ${order?.doc_no || ''}`}
      width={980}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '入库中…' : '确认收货入库'}</button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4 mb-3">
        <Field label="收货日期">
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="验收人">
          <input className="input" value={inspector} onChange={(e) => setInspector(e.target.value)} placeholder="仓储负责人" />
        </Field>
        <Field label="备注">
          <input className="input" value={remark} onChange={(e) => setRemark(e.target.value)} />
        </Field>
      </div>
      <div className="table-wrap border border-ink-300 rounded-md">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 130 }}>SKU 编码</th>
              <th style={{ width: 200 }}>商品</th>
              <th style={{ width: 100 }}>待收数量</th>
              <th style={{ width: 100 }}>单价</th>
              <th style={{ width: 140 }}>批次号</th>
              <th style={{ width: 140 }}>生产日期</th>
              <th style={{ width: 140 }}>到期日期</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr><td colSpan={7} className="text-center py-6 text-slate-400">暂无可收货明细</td></tr>
            )}
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{l.sku_code}</td>
                <td>{l.sku_name}</td>
                <td>
                  <input
                    className="input input-sm text-right"
                    type="number"
                    value={l.pending_qty}
                    onChange={(e) => setLines(lines.map((x, idx) => (idx === i ? { ...x, pending_qty: Number(e.target.value) } : x)))}
                  />
                </td>
                <td className="text-right tabular-nums">¥{fmtMoney(l.price)}</td>
                <td>
                  <input
                    className="input input-sm"
                    value={l.batch_no ?? ''}
                    placeholder="留空自动生成"
                    onChange={(e) => setLines(lines.map((x, idx) => (idx === i ? { ...x, batch_no: e.target.value } : x)))}
                  />
                </td>
                <td>
                  <input
                    className="input input-sm"
                    type="date"
                    value={l.produce_date ?? ''}
                    onChange={(e) => setLines(lines.map((x, idx) => (idx === i ? { ...x, produce_date: e.target.value } : x)))}
                  />
                </td>
                <td>
                  <input
                    className="input input-sm"
                    type="date"
                    value={l.expire_date ?? ''}
                    onChange={(e) => setLines(lines.map((x, idx) => (idx === i ? { ...x, expire_date: e.target.value } : x)))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-ink-700 mt-2">
        提示：入库后会按批次生成库存与流水；保质期 36 个月的商品会按规则自动推算到期日。
      </p>
    </Modal>
  )
}
