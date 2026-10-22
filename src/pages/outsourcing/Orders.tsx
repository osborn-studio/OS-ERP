/**
 * ============================================================================
 * 文件标识：src/pages/outsourcing/Orders.tsx ｜ 委外管理
 * ============================================================================
 * 【职责】委外管理（页面）
 * 【入口】/outsourcing/orders
 * 【主要接口】/outsourcing/orders、/outsourcing/materials、/outsourcing/receipts、/outsourcing/settlements
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
 * 页面：委外管理
 */

import { useEffect, useState, type ReactNode } from 'react'
import api from '../../api/client'
import { Card, Field, Modal, Pagination, Status, Table, Tabs, fmtInt, fmtMoney, toast, useList, useFetch } from '../../components/ui'
import { useOpts } from '../../hooks/opts'
import { PackageOpen, Plus, RefreshCw, Trash2, Truck, Wrench } from 'lucide-react'

type Row = { role: 'product' | 'material'; sku_id?: any; qty?: number; price?: number }

export default function OutsourcingOrders() {
  const o = useOpts()
  const [tab, setTab] = useState('orders')
  const [status, setStatus] = useState('')
  const { list, total, loading, page, pageSize, setPage, reload } = useList('/outsourcing/orders', {})
  const [detail, setDetail] = useState<any>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<any>({})
  const [rows, setRows] = useState<Row[]>([{ role: 'product', qty: 100, price: 8 }])
  const [busy, setBusy] = useState(false)

  const filtered = status ? list.filter((r: any) => r.status === status) : list

  const openDetail = async (row: any) => {
    const r = await api.get(`/outsourcing/orders/${row.id}`)
    setDetail(r.data)
  }

  const submit = async () => {
    if (!form.supplier_id || !form.warehouse_id) return toast('请选择委外加工商与成品入库仓', 'error')
    if (!rows.length || rows.some((r) => !r.sku_id || !(Number(r.qty) > 0))) return toast('请完整填写明细行', 'error')
    setBusy(true)
    try {
      await api.post('/outsourcing/orders', { ...form, items: rows })
      toast('委外订单已创建')
      setOpen(false)
      setRows([{ role: 'product', qty: 100, price: 8 }])
      setForm({})
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const doIssue = async () => {
    if (!detail) return
    if (!confirm('确认对该委外订单发料？材料将从发料仓按批次先进先出出库。')) return
    try {
      const r = await api.post(`/outsourcing/orders/${detail.id}/issue`, {})
      toast(`已生成委外发料单 ${r.data.doc_no}`)
      setDetail(r.data.order)
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const doReceive = async () => {
    if (!detail) return
    if (!confirm('确认收货？成品将入成品仓并计算委外入库成本（材料成本 + 加工费）。')) return
    try {
      const r = await api.post(`/outsourcing/orders/${detail.id}/receive`, {})
      toast(`已生成委外收货单 ${r.data.doc_no}`)
      setDetail(r.data.order)
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">委外管理</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">委外订单 → 委外发料（材料出库）→ 委外收货（成品入库）→ 委外结算，对齐用友委外业务口径</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-primary btn-sm" onClick={() => { setForm({ order_date: new Date().toISOString().slice(0, 10), out_type: 'normal' }); setOpen(true) }}>
            <Plus size={14} /> 新建委外订单
          </button>
        </div>
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[
              { key: 'orders', label: '委外订单' },
              { key: 'materials', label: '委外发料单' },
              { key: 'receipts', label: '委外收货单' },
              { key: 'settlements', label: '委外结算' }
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>

      {tab === 'orders' && (
        <>
          <div className="flex items-center gap-2 mb-2">
            {[['', '全部'], ['draft', '草稿'], ['submitted', '待审批'], ['approved', '已审批'], ['issued', '已发料'], ['received', '已收货'], ['part_received', '部分收货']].map(([k, l]) => (
              <button key={k} onClick={() => setStatus(k)}
                className={`px-2.5 py-1 rounded text-[12px] border ${status === k ? 'bg-brand-700 text-white border-brand-700' : 'bg-white border-ink-300 text-slate-500'}`}>{l}</button>
            ))}
          </div>
          <Card pad={false}>
            <Table
              columns={[
                { key: 'doc_no', title: '委外单号', width: 150 },
                { key: 'supplier_name', title: '委外加工商', width: 200 },
                { key: 'order_date', title: '下单日', width: 100 },
                { key: 'warehouse_name', title: '成品入库仓', width: 140 },
                { key: 'item_count', title: '行数', width: 60, align: 'right' },
                { key: 'product_qty', title: '成品数量', width: 90, align: 'right', render: (r) => fmtInt(r.product_qty) },
                { key: 'material_qty', title: '应发材料', width: 90, align: 'right', render: (r) => fmtInt(r.material_qty) },
                { key: 'process_fee', title: '加工费', width: 110, align: 'right', render: (r) => `¥${fmtMoney(r.process_fee)}` },
                { key: 'status', title: '状态', width: 90, render: (r) => <Status value={r.status} text={r.status_name} /> },
                { key: '__act', title: '操作', width: 90, render: (r) => <button className="link text-[12px]" onClick={() => openDetail(r)}>详情</button> }
              ]}
              data={filtered}
              loading={loading}
              onRowClick={openDetail}
            />
            <div className="px-3 pb-3">
              <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
            </div>
          </Card>
        </>
      )}

      {tab === 'materials' && <DocList path="/outsourcing/materials" title="委外发料单" col2="supplier_name" col2Title="加工商" extra="total_amount" />}
      {/* 收货单的【质检】入口就挂在这一页的收货单列表上（本页就是委外收货单列表，tab=receipts）。
          只对 `received` 显示：内核 `WR.inspect` 的出边只有 received→inspected。 */}
      {tab === 'receipts' && (
        <DocList
          path="/outsourcing/receipts"
          title="委外收货单"
          col2="supplier_name"
          col2Title="加工商"
          extra="process_fee"
          rowActions={(r, reload) =>
            r.status === 'received' ? (
              <button
                className="link text-[12px]"
                onClick={async () => {
                  try {
                    await api.post(`/outsourcing/receipts/${r.id}/inspect`, {})
                    toast('已完成质检')
                    reload()
                  } catch (e: any) {
                    toast(e.message, 'error')
                  }
                }}
              >
                质检
              </button>
            ) : null
          }
        />
      )}
      {tab === 'settlements' && <Settlements />}

      {/* 新建 */}
      <Modal open={open} title="新建委外订单" width={960} onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>取消</button>
            <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? '保存中…' : '保存'}</button>
          </>
        }
      >
        <div className="grid grid-cols-3 gap-4 mb-4">
          <Field label="委外加工商" required>
            <select className="input" value={form.supplier_id ?? ''} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
              <option value="">请选择</option>
              {o.suppliers.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="成品入库仓" required>
            <select className="input" value={form.warehouse_id ?? ''} onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}>
              <option value="">请选择</option>
              {o.warehouses.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </select>
          </Field>
          <Field label="材料发料仓">
            <select className="input" value={form.material_warehouse_id ?? ''} onChange={(e) => setForm({ ...form, material_warehouse_id: e.target.value })}>
              <option value="">同成品入库仓</option>
              {o.warehouses.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </select>
          </Field>
          <Field label="委外类型">
            <select className="input" value={form.out_type ?? 'normal'} onChange={(e) => setForm({ ...form, out_type: e.target.value })}>
              <option value="normal">一般委外（成品）</option>
              <option value="process">工序委外</option>
            </select>
          </Field>
          <Field label="下单日期">
            <input className="input" type="date" value={form.order_date ?? ''} onChange={(e) => setForm({ ...form, order_date: e.target.value })} />
          </Field>
          <Field label="预计交货">
            <input className="input" type="date" value={form.expect_date ?? ''} onChange={(e) => setForm({ ...form, expect_date: e.target.value })} />
          </Field>
          <Field label="加工费合计">
            <input className="input" type="number" value={form.process_fee ?? ''} onChange={(e) => setForm({ ...form, process_fee: Number(e.target.value) })} />
          </Field>
          <Field label="结算方式">
            <input className="input" value={form.settle_type ?? ''} placeholder="月结 30 天" onChange={(e) => setForm({ ...form, settle_type: e.target.value })} />
          </Field>
          <Field label="备注">
            <input className="input" value={form.remark ?? ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
          </Field>
        </div>

        <div className="table-wrap border border-ink-300 rounded-md">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 110 }}>行类型</th>
                <th style={{ width: 260 }}>商品 SKU</th>
                <th style={{ width: 90 }}>数量</th>
                <th style={{ width: 110 }}>单价</th>
                <th style={{ width: 110 }}>金额</th>
                <th style={{ width: 50 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l, i) => (
                <tr key={i}>
                  <td>
                    <select className="input input-sm" value={l.role} onChange={(e) => { const n = [...rows]; n[i] = { ...n[i], role: e.target.value as any }; setRows(n) }}>
                      <option value="product">成品</option>
                      <option value="material">材料</option>
                    </select>
                  </td>
                  <td>
                    <select className="input input-sm" value={l.sku_id ?? ''} onChange={(e) => { const n = [...rows]; n[i] = { ...n[i], sku_id: Number(e.target.value) }; setRows(n) }}>
                      <option value="">选择商品</option>
                      {o.skus.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </td>
                  <td><input className="input input-sm text-right" type="number" value={l.qty ?? ''} onChange={(e) => { const n = [...rows]; n[i] = { ...n[i], qty: Number(e.target.value) }; setRows(n) }} /></td>
                  <td><input className="input input-sm text-right" type="number" value={l.price ?? ''} onChange={(e) => { const n = [...rows]; n[i] = { ...n[i], price: Number(e.target.value) }; setRows(n) }} /></td>
                  <td className="text-right tabular-nums">¥{fmtMoney(Number(l.qty || 0) * Number(l.price || 0))}</td>
                  <td className="text-center">
                    <button className="text-red-500" onClick={() => setRows(rows.filter((_, x) => x !== i))}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between mt-2">
          <div className="flex gap-2">
            <button className="btn-ghost btn-sm" onClick={() => setRows([...rows, { role: 'product', qty: 100, price: 8 }])}><Plus size={13} /> 加成品行</button>
            <button className="btn-ghost btn-sm" onClick={() => setRows([...rows, { role: 'material', qty: 100, price: 0 }])}><Plus size={13} /> 加材料行</button>
          </div>
          <span className="text-[12px] text-slate-500">成品行为加工成品单价（加工费）；材料行为应发材料成本价</span>
        </div>
      </Modal>

      {/* 详情 */}
      <Modal open={!!detail} title={`委外订单 ${detail?.doc_no || ''}`} width={960} onClose={() => setDetail(null)}
        footer={
          detail && (
            <div className="flex items-center gap-2">
              {detail.status === 'draft' && (
                <button className="btn-ghost" onClick={async () => { const r = await api.post(`/outsourcing/orders/${detail.id}/status`, { action: 'submit' }); setDetail(r.data); reload() }}>提交</button>
              )}
              {detail.status === 'submitted' && (
                <button className="btn-ghost" onClick={async () => { const r = await api.post(`/outsourcing/orders/${detail.id}/status`, { action: 'approve' }); setDetail(r.data); reload() }}>审批通过</button>
              )}
              {['approved', 'issued', 'part_received'].includes(detail.status) && (
                <button className="btn-ghost" onClick={doIssue}><PackageOpen size={14} /> 委外发料</button>
              )}
              {['issued', 'part_received', 'approved'].includes(detail.status) && (
                <button className="btn-primary" onClick={doReceive}><Wrench size={14} /> 委外收货</button>
              )}
              {detail.status === 'received' && (
                <button className="btn-ghost" onClick={async () => { const r = await api.post(`/outsourcing/orders/${detail.id}/status`, { action: 'close' }); setDetail(r.data); reload() }}>关闭订单</button>
              )}
            </div>
          )
        }
      >
        {detail && (
          <div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-[12px]">
              <div><span className="text-slate-400">加工商：</span>{detail.supplier_name}</div>
              <div><span className="text-slate-400">入库仓：</span>{detail.warehouse_name}</div>
              <div><span className="text-slate-400">发料仓：</span>{detail.material_warehouse_name || detail.warehouse_name}</div>
              <div><span className="text-slate-400">状态：</span><Status value={detail.status} text={detail.status_name} /></div>
              <div><span className="text-slate-400">成品数量：</span>{fmtInt(detail.product_qty)}</div>
              <div><span className="text-slate-400">材料数量：</span>{fmtInt(detail.material_qty)}</div>
              <div><span className="text-slate-400">加工费：</span>¥{fmtMoney(detail.process_fee)}</div>
              <div><span className="text-slate-400">总成本：</span>¥{fmtMoney(detail.total_amount)}</div>
            </div>
            <Table
              columns={[
                { key: 'role', title: '类型', width: 80, render: (r) => (r.role === 'product' ? <span className="tag bg-brand-50 text-brand-700">成品</span> : <span className="tag bg-slate-100 text-slate-600">材料</span>) },
                { key: 'sku_code', title: 'SKU', width: 120 },
                { key: 'product_name', title: '商品', width: 200, render: (r) => `${r.product_name} ${r.sku_name || ''}` },
                { key: 'qty', title: '数量', width: 90, align: 'right', render: (r) => fmtInt(r.qty) },
                { key: 'price', title: '单价', width: 100, align: 'right', render: (r) => `¥${fmtMoney(r.price)}` },
                { key: 'amount', title: '金额', width: 110, align: 'right', render: (r) => `¥${fmtMoney(r.amount)}` },
                { key: 'issued_qty', title: '已发料', width: 90, align: 'right', render: (r) => (r.role === 'material' ? fmtInt(r.issued_qty) : '—') },
                { key: 'received_qty', title: '已收货', width: 90, align: 'right', render: (r) => (r.role === 'product' ? fmtInt(r.received_qty) : '—') }
              ]}
              data={detail.items || []}
            />
            {(detail.issues?.length > 0 || detail.receipts?.length > 0) && (
              <div className="grid grid-cols-2 gap-4 mt-4">
                <div>
                  <div className="text-[13px] font-medium text-slate-700 mb-2">委外发料单</div>
                  {(detail.issues || []).map((x: any) => (
                    <div key={x.id} className="text-[12px] flex justify-between border-b border-ink-100 py-1.5">
                      <span className="font-mono">{x.doc_no}</span>
                      <span>{x.issue_date} · {fmtInt(x.total_qty)} 件 · ¥{fmtMoney(x.total_amount)}</span>
                    </div>
                  ))}
                  {!detail.issues?.length && <div className="text-[12px] text-slate-400">暂无发料记录</div>}
                </div>
                <div>
                  <div className="text-[13px] font-medium text-slate-700 mb-2">委外收货单</div>
                  {(detail.receipts || []).map((x: any) => (
                    <div key={x.id} className="text-[12px] flex justify-between border-b border-ink-100 py-1.5">
                      <span className="font-mono">{x.doc_no}</span>
                      <span>{x.receipt_date} · {fmtInt(x.total_qty)} 件 · 加工费 ¥{fmtMoney(x.process_fee)}</span>
                    </div>
                  ))}
                  {!detail.receipts?.length && <div className="text-[12px] text-slate-400">暂无收货记录</div>}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

/** 发料单 / 收货单列表 */
function DocList({
  path,
  title,
  col2,
  col2Title,
  extra,
  rowActions
}: {
  path: string
  title: string
  col2: string
  col2Title: string
  extra: string
  /** 传了才渲染「状态 + 操作」两列（发料单没有可推进的边，就不给空操作列） */
  rowActions?: (r: any, reload: () => void) => ReactNode
}) {
  const { list, total, loading, page, pageSize, setPage, reload } = useList(path, {})
  return (
    <Card pad={false}>
      <Table
        columns={[
          { key: 'doc_no', title: '单号', width: 150 },
          { key: 'order_no', title: '委外订单', width: 150 },
          { key: col2, title: col2Title, width: 200 },
          { key: 'warehouse_name', title: '仓库', width: 140 },
          { key: 'issue_date', title: '日期', width: 110, render: (r) => r.issue_date || r.receipt_date },
          { key: 'item_count', title: '行数', width: 60, align: 'right' },
          { key: 'total_qty', title: '数量', width: 90, align: 'right', render: (r) => fmtInt(r.total_qty) },
          { key: extra, title: extra === 'process_fee' ? '加工费' : '成本金额', width: 110, align: 'right', render: (r) => `¥${fmtMoney(r[extra])}` },
          ...(rowActions
            ? [
                { key: 'status', title: '状态', width: 90, render: (r: any) => <Status value={r.status} /> },
                { key: '__act', title: '操作', width: 80, render: (r: any) => rowActions(r, reload) }
              ]
            : [])
        ]}
        data={list}
        loading={loading}
      />
      <div className="px-3 pb-3">
        <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
      </div>
      {!list.length && !loading && <div className="pb-6 text-center text-[12px] text-slate-400">{title}暂无记录</div>}
    </Card>
  )
}

/** 委外结算（按加工商汇总加工费） */
function Settlements() {
  const [start, setStart] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10))
  const [end, setEnd] = useState(() => new Date().toISOString().slice(0, 10))
  const { data, loading, reload } = useFetch<any>('/outsourcing/settlements', { startDate: start, endDate: end }, [start, end])
  const rows = data?.rows || []
  return (
    <Card pad={false}>
      <div className="p-3 flex items-center gap-2 flex-wrap border-b border-ink-100">
        <span className="text-[12px] text-slate-500">收货期间</span>
        <input className="input input-sm" style={{ width: 140 }} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <span className="text-[12px] text-slate-400">至</span>
        <input className="input input-sm" style={{ width: 140 }} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        <button className="btn-ghost btn-sm" onClick={() => reload()}><RefreshCw size={13} /> 查询</button>
        <span className="ml-auto text-[12px] text-slate-500">
          加工费合计 <b className="text-brand-700">¥{fmtMoney(data?.totals?.process_fee)}</b> · 入库成本合计 ¥{fmtMoney(data?.totals?.inbound_amount)}
        </span>
      </div>
      <Table
        columns={[
          { key: 'supplier_name', title: '委外加工商', width: 240 },
          { key: 'order_count', title: '收货订单数', width: 110, align: 'right' },
          { key: 'received_qty', title: '收货数量', width: 110, align: 'right', render: (r) => fmtInt(r.received_qty) },
          { key: 'process_fee', title: '应付加工费', width: 130, align: 'right', render: (r) => <span className="text-brand-700">¥{fmtMoney(r.process_fee)}</span> },
          { key: 'inbound_amount', title: '入库成本', width: 130, align: 'right', render: (r) => `¥${fmtMoney(r.inbound_amount)}` }
        ]}
        data={rows}
        loading={loading}
      />
      <div className="pb-4" />
    </Card>
  )
}
