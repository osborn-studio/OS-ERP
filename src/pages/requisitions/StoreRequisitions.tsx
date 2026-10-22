/**
 * ============================================================================
 * 文件标识：src/pages/requisitions/StoreRequisitions.tsx ｜ 门店要货管理
 * ============================================================================
 * 【职责】门店要货管理（页面）
 * 【入口】/store/requisitions
 * 【主要接口】/requisitions/store/board、/requisitions/shipments
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
 * 页面：门店要货管理
 */

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import api from '../../api/client'
import { Card, Field, Modal, Pagination, Status, Table, Tabs, fmtInt, fmtMoney, toast, useList } from '../../components/ui'
import { FilterBar, Inp } from '../../components/DataPage'
import { useOpts } from '../../hooks/opts'
import { CheckCircle2, PackageCheck, RefreshCw, Send, ShoppingCart, Truck, XCircle } from 'lucide-react'

const STATUS_TABS = [
  { key: '', label: '全部' },
  { key: 'submitted', label: '待受理' },
  { key: 'processing', label: '处理中' },
  { key: 'transferred', label: '已转采购' },
  { key: 'allocated', label: '已配货' },
  { key: 'completed', label: '已完成' }
]

export default function StoreRequisitions() {
  const o = useOpts()
  const [tab, setTab] = useState('')
  const [sp] = useSearchParams()
  const { list, total, loading, page, pageSize, setPage, setFilters, reload } = useList('/requisitions/store', {})
  const [detail, setDetail] = useState<any>(null)
  const [board, setBoard] = useState<any>(null)
  const [poOpen, setPoOpen] = useState(false)
  const [poForm, setPoForm] = useState<any>({ fulfil_type: 'hq' })
  const [checked, setChecked] = useState<Record<number, boolean>>({})
  const [qtys, setQtys] = useState<Record<number, number>>({})
  const [shipOpen, setShipOpen] = useState(false)
  const [shipChecked, setShipChecked] = useState<Record<number, boolean>>({})
  const [shipQtys, setShipQtys] = useState<Record<number, number>>({})
  const [busy, setBusy] = useState(false)

  const loadBoard = () => api.get('/requisitions/store/board').then((r) => setBoard(r.data)).catch(() => {})
  useEffect(() => {
    loadBoard()
  }, [])

  useEffect(() => {
    setFilters(tab ? { status: tab } : {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const openDetail = async (row: any) => {
    try {
      const r = await api.get(`/requisitions/store/${row.id}`)
      setDetail(r.data)
      const c: Record<number, boolean> = {}
      const q: Record<number, number> = {}
      for (const it of r.data.items || []) {
        c[it.id] = it.status === 'pending'
        q[it.id] = it.qty
      }
      setChecked(c)
      setQtys(q)
      // 发货勾选：默认勾选仍有待发数量的行（可选择部分行 / 改发货数量）
      const sc: Record<number, boolean> = {}
      const sq: Record<number, number> = {}
      for (const it of r.data.items || []) {
        const remain = Number(it.remain_qty ?? it.qty) || 0
        sc[it.id] = remain > 0
        sq[it.id] = remain
      }
      setShipChecked(sc)
      setShipQtys(sq)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  // 支持 /store/requisitions?req=<id> 直达明细；附加 &ship=1 同时打开发货弹窗（演示 / 截图）
  useEffect(() => {
    const id = sp.get('req')
    if (!id) return
    openDetail({ id: Number(id) }).then(() => {
      if (sp.get('ship') === '1') setShipOpen(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const act = async (action: string, reason?: string) => {
    if (!detail) return
    try {
      const r = await api.post(`/requisitions/store/${detail.id}/status`, { action, reason })
      setDetail(r.data)
      reload()
      loadBoard()
      toast('已' + (action === 'accept' ? '受理' : action === 'reject' ? '驳回' : '更新'))
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const submitPo = async () => {
    if (!poForm.supplier_id) return toast('请选择供应商', 'error')
    const lines = Object.keys(checked)
      .filter((k) => checked[Number(k)])
      .map((k) => ({ item_id: Number(k), qty: qtys[Number(k)] }))
    if (!lines.length) return toast('请勾选要转采购的明细行', 'error')
    setBusy(true)
    try {
      const r = await api.post(`/requisitions/store/${detail.id}/to-purchase`, {
        supplier_id: Number(poForm.supplier_id),
        fulfill_type: poForm.fulfil_type,
        warehouse_id: poForm.warehouse_id ? Number(poForm.warehouse_id) : undefined,
        lines
      })
      toast(`已生成采购单 ${r.data.doc_no}`)
      setPoOpen(false)
      setDetail(r.data.requisition)
      reload()
      loadBoard()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const submitShip = async () => {
    if (!detail) return
    const lines = Object.keys(shipChecked)
      .filter((k) => shipChecked[Number(k)])
      .map((k) => ({ item_id: Number(k), ship_qty: shipQtys[Number(k)] }))
      .filter((l) => Number(l.ship_qty) > 0)
    if (!lines.length) return toast('请勾选要发货的明细行并填写发货数量', 'error')
    setBusy(true)
    try {
      const r = await api.post('/requisitions/shipments', { requisition_id: detail.id, lines })
      toast(`已生成发货单 ${r.data.doc_no}，请到「门店发货单」确认发货`)
      setShipOpen(false)
      const d = await api.get(`/requisitions/store/${detail.id}`)
      setDetail(d.data)
      reload()
      loadBoard()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const doTransfer = async () => {
    if (!detail) return
    if (!confirm('确认从中心仓配货调拨到该门店仓？将校验中心仓库存。')) return
    try {
      const r = await api.post(`/requisitions/store/${detail.id}/to-transfer`, {})
      toast(`已生成配货调拨单 ${r.data.doc_no}`)
      setDetail(r.data.requisition)
      reload()
      loadBoard()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const totals = board?.byStore?.reduce(
    (a: any, s: any) => {
      a.pending += Number(s.pending || 0)
      a.req += Number(s.req_count || 0)
      return a
    },
    { pending: 0, req: 0 }
  ) || { pending: 0, req: 0 }

  const selectedCount = useMemo(() => Object.values(checked).filter(Boolean).length, [checked])
  const shipIds = useMemo(() => Object.keys(shipChecked).filter((k) => shipChecked[Number(k)]), [shipChecked])
  const shipTotal = useMemo(
    () => shipIds.reduce((sum, k) => sum + (Number(shipQtys[Number(k)]) || 0), 0),
    [shipIds, shipQtys]
  )

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">门店要货管理</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">门店补货申请 → 总部受理 → 转采购（总部入库 / 直运门店仓）或中心仓配货调拨</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={() => { reload(); loadBoard() }}>
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <div className="kpi">
          <div className="kpi-label">门店要货单总数</div>
          <div className="kpi-value text-brand-700">{fmtInt(totals.req)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">待受理</div>
          <div className={`kpi-value ${totals.pending > 0 ? 'text-red-600' : 'text-slate-800'}`}>{fmtInt(totals.pending)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">在营门店</div>
          <div className="kpi-value text-slate-800">{fmtInt(board?.byStore?.length || 0)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">最新要货</div>
          <div className="kpi-value text-slate-800 text-[15px]">{board?.recent?.[0]?.doc_no || '—'}</div>
          <div className="kpi-sub">{board?.recent?.[0]?.store_name || ''}</div>
        </div>
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs tabs={STATUS_TABS} value={tab} onChange={setTab} />
        </div>
      </Card>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '要货单号', width: 150 },
            { key: 'store_name', title: '门店', width: 170 },
            { key: 'req_date', title: '要货日期', width: 110 },
            { key: 'urgency', title: '紧急', width: 70, render: (r) => (r.urgency === 'urgent' ? <span className="tag bg-red-50 text-red-600">紧急</span> : <span className="text-slate-300">—</span>) },
            { key: 'item_count', title: '行数', width: 60, align: 'right' },
            { key: 'total_qty', title: '要货数量', width: 90, align: 'right', render: (r) => fmtInt(r.total_qty) },
            { key: 'applicant', title: '申请人', width: 90 },
            { key: 'status', title: '状态', width: 100, render: (r) => <Status value={r.status} text={r.status_name} /> },
            {
              key: '__act',
              title: '操作',
              width: 90,
              render: (r) => (
                <button className="link text-[12px]" onClick={() => openDetail(r)}>
                  处理
                </button>
              )
            }
          ]}
          data={list}
          loading={loading}
          onRowClick={openDetail}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>

      {/* 明细与处理 */}
      <Modal open={!!detail} title={`要货单 ${detail?.doc_no || ''}`} width={980} onClose={() => setDetail(null)}
        footer={
          detail && (
            <div className="flex items-center gap-2">
              {detail.status === 'submitted' && (
                <>
                  <button className="btn-ghost" onClick={() => act('accept')}>
                    <CheckCircle2 size={14} /> 受理
                  </button>
                  <button className="btn-ghost text-red-600" onClick={() => act('reject', '库存/政策原因驳回')}>
                    <XCircle size={14} /> 驳回
                  </button>
                </>
              )}
              {['submitted', 'processing'].includes(detail.status) && (
                <>
                  <button className="btn-ghost" onClick={doTransfer}>
                    <Truck size={14} /> 中心仓配货
                  </button>
                  <button className="btn-primary" onClick={() => setPoOpen(true)}>
                    <ShoppingCart size={14} /> 转采购订单
                  </button>
                </>
              )}
              {!['completed', 'rejected', 'cancelled'].includes(detail.status) &&
                (detail.items || []).some((i: any) => Number(i.remain_qty) > 0) && (
                  <button className="btn-ghost" onClick={() => setShipOpen(true)}>
                    <Send size={14} /> 参考本单发货
                  </button>
                )}
              {['transferred', 'allocated'].includes(detail.status) && detail.status !== 'completed' && (
                <button className="btn-ghost" onClick={() => act('complete')}>
                  <PackageCheck size={14} /> 标记完成
                </button>
              )}
            </div>
          )
        }
      >
        {detail && (
          <div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-[12px]">
              <div><span className="text-slate-400">门店：</span>{detail.store_name}</div>
              <div><span className="text-slate-400">要货日期：</span>{detail.req_date}</div>
              <div><span className="text-slate-400">申请人：</span>{detail.applicant || '—'}</div>
              <div><span className="text-slate-400">状态：</span><Status value={detail.status} text={detail.status_name} /></div>
              <div><span className="text-slate-400">门店仓：</span>{detail.warehouse_name || '—'}</div>
              <div><span className="text-slate-400">总部仓：</span>{detail.hq_warehouse?.name || '—'}</div>
              <div><span className="text-slate-400">关联采购单：</span>{detail.linked_po_ids || '—'}</div>
              <div><span className="text-slate-400">关联调拨单：</span>{detail.linked_transfer_id || '—'}</div>
            </div>
            <Table
              columns={[
                { key: 'sku_code', title: 'SKU', width: 120 },
                { key: 'product_name', title: '商品', width: 200, render: (r) => `${r.product_name} ${r.sku_name || ''}` },
                { key: 'qty', title: '要货量', width: 80, align: 'right', render: (r) => fmtInt(r.qty) },
                { key: 'store_stock_now', title: '门店现存', width: 90, align: 'right', render: (r) => fmtInt(r.store_stock_now) },
                { key: 'hq_available', title: '总部可用', width: 90, align: 'right', render: (r) => <span className={Number(r.hq_available) > 0 ? 'text-green-600' : 'text-slate-400'}>{fmtInt(r.hq_available)}</span> },
                { key: 'shipped_qty', title: '已发', width: 70, align: 'right', render: (r) => (Number(r.shipped_qty) ? fmtInt(r.shipped_qty) : '—') },
                { key: 'remain_qty', title: '待发', width: 70, align: 'right', render: (r) => <span className={Number(r.remain_qty) > 0 ? 'text-amber-600' : 'text-slate-300'}>{fmtInt(r.remain_qty)}</span> },
                { key: 'price', title: '参考成本', width: 90, align: 'right', render: (r) => `¥${fmtMoney(r.price)}` },
                { key: 'approved_qty', title: '已批数量', width: 90, align: 'right', render: (r) => (r.approved_qty ? fmtInt(r.approved_qty) : '—') },
                { key: 'status', title: '行状态', width: 80, render: (r) => (r.status === 'approved' ? <Status value="approved" text="已批准" /> : <Status value="submitted" text="待处理" />) }
              ]}
              data={detail.items || []}
            />
            {detail.remark && <div className="mt-3 text-[12px] text-slate-500">备注：{detail.remark}</div>}
          </div>
        )}
      </Modal>

      {/* 转采购 */}
      <Modal open={poOpen} title="要货单转采购订单" width={820} onClose={() => setPoOpen(false)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setPoOpen(false)}>取消</button>
            <button className="btn-primary" disabled={busy} onClick={submitPo}>{busy ? '生成中…' : `生成采购订单（${selectedCount} 行）`}</button>
          </>
        }
      >
        <div className="grid grid-cols-3 gap-4 mb-4">
          <Field label="供应商" required>
            <select className="input" value={poForm.supplier_id ?? ''} onChange={(e) => setPoForm({ ...poForm, supplier_id: e.target.value })}>
              <option value="">请选择</option>
              {o.suppliers.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </Field>
          <Field label="履约方式" required hint={poForm.fulfil_type === 'direct' ? '供应商直运到门店仓，收货直接入门店库存' : '先入总部中心仓，再由中心仓配货到门店'}>
            <select className="input" value={poForm.fulfil_type} onChange={(e) => setPoForm({ ...poForm, fulfil_type: e.target.value })}>
              <option value="hq">总部入库</option>
              <option value="direct">直运门店仓</option>
            </select>
          </Field>
          <Field label={poForm.fulfil_type === 'direct' ? '直运门店仓（自动）' : '入库仓库'}>
            {poForm.fulfil_type === 'direct' ? (
              <div className="input bg-slate-50 text-slate-500 flex items-center">{detail?.warehouse_name || '门店仓'}</div>
            ) : (
              <select className="input" value={poForm.warehouse_id ?? ''} onChange={(e) => setPoForm({ ...poForm, warehouse_id: e.target.value })}>
                <option value="">默认中心仓</option>
                {o.warehouses.map((w) => (
                  <option key={w.value} value={w.value}>{w.label}</option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Table
          columns={[
            { key: '__chk', title: '选择', width: 60, render: (r: any) => (
              <input type="checkbox" checked={!!checked[r.id]} onChange={(e) => setChecked({ ...checked, [r.id]: e.target.checked })} />
            ) },
            { key: 'sku_code', title: 'SKU', width: 120 },
            { key: 'product_name', title: '商品', width: 220, render: (r: any) => `${r.product_name} ${r.sku_name || ''}` },
            { key: 'qty', title: '要货量', width: 80, align: 'right', render: (r: any) => fmtInt(r.qty) },
            { key: '__qty', title: '采购数量', width: 110, render: (r: any) => (
              <input className="input input-sm text-right" type="number" value={qtys[r.id] ?? r.qty}
                onChange={(e) => setQtys({ ...qtys, [r.id]: Number(e.target.value) })} />
            ) }
          ]}
          data={(detail?.items || []).filter((x: any) => x.status !== 'approved')}
        />
      </Modal>

      {/* 参考要货单生成发货单（选择性发货） */}
      <Modal
        open={shipOpen}
        title={`参考要货单 ${detail?.doc_no || ''} 生成发货单`}
        width={900}
        onClose={() => setShipOpen(false)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setShipOpen(false)}>取消</button>
            <button className="btn-primary" disabled={busy || !shipIds.length} onClick={submitShip}>
              {busy ? '生成中…' : `生成发货单（${shipIds.length} 行 / ${fmtInt(shipTotal)} 件）`}
            </button>
          </>
        }
      >
        <div className="mb-3 p-2.5 bg-brand-50 border border-brand-600/20 rounded text-[12px] text-brand-700">
          可从要货行中<strong>勾选部分行</strong>发货，也可<strong>修改发货数量</strong>（不超过该行待发数量，且不得高于总部可用库存）。
          生成后为「待发货」，需在<strong>门店发货单</strong>页确认发货才会出库。
        </div>
        <Table
          columns={[
            {
              key: '__chk',
              title: '选择',
              width: 55,
              render: (r: any) => (
                <input
                  type="checkbox"
                  checked={!!shipChecked[r.id]}
                  disabled={!(Number(r.remain_qty) > 0)}
                  onChange={(e) => setShipChecked({ ...shipChecked, [r.id]: e.target.checked })}
                />
              )
            },
            { key: 'sku_code', title: 'SKU', width: 115 },
            { key: 'product_name', title: '商品', width: 200, render: (r: any) => `${r.product_name} ${r.sku_name || ''}` },
            { key: 'qty', title: '要货量', width: 75, align: 'right', render: (r: any) => fmtInt(r.qty) },
            { key: 'shipped_qty', title: '已发', width: 65, align: 'right', render: (r: any) => (Number(r.shipped_qty) ? fmtInt(r.shipped_qty) : '—') },
            {
              key: 'remain_qty',
              title: '待发',
              width: 65,
              align: 'right',
              render: (r: any) => <span className="text-amber-600">{fmtInt(r.remain_qty)}</span>
            },
            {
              key: 'hq_available',
              title: '总部可用',
              width: 85,
              align: 'right',
              render: (r: any) => <span className={Number(r.hq_available) > 0 ? 'text-green-600' : 'text-red-500'}>{fmtInt(r.hq_available)}</span>
            },
            {
              key: '__qty',
              title: '本次发货',
              width: 105,
              render: (r: any) => (
                <input
                  className="input input-sm text-right"
                  type="number"
                  min={0}
                  max={Number(r.remain_qty) || 0}
                  value={shipQtys[r.id] ?? ''}
                  disabled={!shipChecked[r.id]}
                  onChange={(e) => setShipQtys({ ...shipQtys, [r.id]: Number(e.target.value) })}
                />
              )
            }
          ]}
          data={detail?.items || []}
        />
      </Modal>
    </div>
  )
}
