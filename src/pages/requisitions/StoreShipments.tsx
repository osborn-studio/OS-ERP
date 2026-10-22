/**
 * ============================================================================
 * 文件标识：src/pages/requisitions/StoreShipments.tsx ｜ 门店发货单
 * ============================================================================
 * 【职责】门店发货单（页面）
 * 【入口】/store/shipments
 * 【主要接口】无（纯展示或纯表单）
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
 * 页面：门店发货单
 */

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import api from '../../api/client'
import { Card, Modal, Pagination, Status, Table, Tabs, fmtInt, fmtMoney, toast, useList } from '../../components/ui'
import { PackageCheck, RefreshCw, Send, Truck, XCircle } from 'lucide-react'

const STATUS_TABS = [
  { key: '', label: '全部' },
  { key: 'draft', label: '待发货' },
  { key: 'shipped', label: '已发货' },
  { key: 'partial', label: '部分收货' },
  { key: 'received', label: '已收货' },
  { key: 'cancelled', label: '已取消' }
]

/** 门店发货单：总部参考要货单选择性发货 → 门店选择性收货 */
export default function StoreShipments() {
  const [tab, setTab] = useState('')
  const { list, total, summary, loading, page, pageSize, setPage, setFilters, reload } =
    useList('/requisitions/shipments', {})
  const [detail, setDetail] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [sp] = useSearchParams()

  useEffect(() => {
    setFilters(tab ? { status: tab } : {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // 支持 /store/shipments?id=xx 直达某张发货单（演示 / 分享链接）
  useEffect(() => {
    const id = sp.get('id')
    if (id) openDetail({ id: Number(id) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openDetail = async (row: any) => {
    try {
      const r = await api.get(`/requisitions/shipments/${row.id}`)
      setDetail(r.data)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const doShip = async () => {
    if (!detail) return
    if (!confirm(`确认发货 ${detail.doc_no}？将从「${detail.from_warehouse_name}」出库。`)) return
    setBusy(true)
    try {
      const r = await api.post(`/requisitions/shipments/${detail.id}/ship`, {})
      setDetail(r.data)
      toast('已确认发货，等待门店收货')
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const doCancel = async () => {
    if (!detail) return
    if (!confirm(`确认取消发货单 ${detail.doc_no}？`)) return
    setBusy(true)
    try {
      const r = await api.post(`/requisitions/shipments/${detail.id}/cancel`, { reason: '总部取消发货' })
      setDetail(r.data)
      toast('发货单已取消')
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const s = summary || {}
  const pendingRecv = Number(s.shipped || 0) + Number(s.partial || 0)

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">门店发货单</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">
            参考门店要货单选择性发货 → 中心仓出库 → 门店端按到货情况选择性收货（支持短收与差异登记）
          </p>
        </div>
        <button className="btn-ghost btn-sm" onClick={reload}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <div className="kpi">
          <div className="kpi-label">发货单总数</div>
          <div className="kpi-value text-brand-700">{fmtInt(s.total)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">待发货</div>
          <div className={`kpi-value ${Number(s.draft) > 0 ? 'text-amber-600' : 'text-slate-800'}`}>{fmtInt(s.draft)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">在途 / 待门店收货</div>
          <div className={`kpi-value ${pendingRecv > 0 ? 'text-red-600' : 'text-slate-800'}`}>{fmtInt(pendingRecv)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">已收货</div>
          <div className="kpi-value text-slate-800">{fmtInt(s.received)}</div>
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
            { key: 'doc_no', title: '发货单号', width: 150 },
            { key: 'store_name', title: '收货门店', width: 170 },
            { key: 'from_warehouse_name', title: '发货仓', width: 130 },
            { key: 'ship_date', title: '发货日期', width: 105 },
            { key: 'requisition_doc_no', title: '来源要货单', width: 145, render: (r) => <span className="font-mono text-[11px] text-slate-500">{r.requisition_doc_no || '—'}</span> },
            { key: 'total_qty', title: '发货量', width: 80, align: 'right', render: (r) => fmtInt(r.total_qty) },
            { key: 'received_qty', title: '实收', width: 75, align: 'right', render: (r) => (Number(r.received_qty) ? fmtInt(r.received_qty) : '—') },
            {
              key: 'diff_qty',
              title: '差异',
              width: 70,
              align: 'right',
              render: (r) =>
                Number(r.diff_qty) ? <span className="text-red-600">{-Number(r.diff_qty)}</span> : <span className="text-slate-300">—</span>
            },
            { key: 'pending_count', title: '待收行', width: 70, align: 'right', render: (r) => (Number(r.pending_count) ? <span className="text-amber-600">{r.pending_count}</span> : '—') },
            { key: 'status', title: '状态', width: 95, render: (r) => <Status value={r.status} text={r.status_name} /> },
            {
              key: '__act',
              title: '操作',
              width: 80,
              render: (r) => (
                <button className="link text-[12px]" onClick={() => openDetail(r)}>
                  {r.status === 'draft' ? '发货' : '查看'}
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

      <Modal
        open={!!detail}
        title={`门店发货单 ${detail?.doc_no || ''}`}
        width={1000}
        onClose={() => setDetail(null)}
        footer={
          detail && (
            <div className="flex items-center gap-2">
              {detail.status === 'draft' && (
                <>
                  <button className="btn-ghost text-red-600" disabled={busy} onClick={doCancel}>
                    <XCircle size={14} /> 取消发货单
                  </button>
                  <button className="btn-primary" disabled={busy} onClick={doShip}>
                    <Truck size={14} /> {busy ? '处理中…' : '确认发货（中心仓出库）'}
                  </button>
                </>
              )}
              {['shipped', 'partial'].includes(detail.status) && (
                <div className="text-[12px] text-amber-600 flex items-center gap-1.5">
                  <Send size={13} /> 已发往门店，等待门店端收货（待收 {detail.items?.filter((i: any) => i.pending).length || 0} 行）
                </div>
              )}
              {detail.status === 'received' && (
                <div className="text-[12px] text-green-700 flex items-center gap-1.5">
                  <PackageCheck size={13} /> 门店已收货完成{Number(detail.diff_qty) ? `，差异 ${-Number(detail.diff_qty)} 件` : ''}
                </div>
              )}
            </div>
          )
        }
      >
        {detail && (
          <div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-[12px]">
              <div><span className="text-slate-400">收货门店：</span>{detail.store_name}</div>
              <div><span className="text-slate-400">发货仓：</span>{detail.from_warehouse_name}</div>
              <div><span className="text-slate-400">收货仓：</span>{detail.to_warehouse_name}</div>
              <div><span className="text-slate-400">来源要货单：</span>{detail.requisition_doc_no || '—'}</div>
              <div><span className="text-slate-400">发货日期：</span>{detail.ship_date}</div>
              <div><span className="text-slate-400">状态：</span><Status value={detail.status} text={detail.status_name} /></div>
              <div><span className="text-slate-400">承运 / 运单：</span>{detail.carrier || '—'} {detail.express_no || ''}</div>
              <div><span className="text-slate-400">发货 / 收货时间：</span>{detail.shipped_at || '—'} / {detail.received_at || '—'}</div>
              <div><span className="text-slate-400">发货数量：</span>{fmtInt(detail.total_qty)}</div>
              <div><span className="text-slate-400">实收数量：</span>{fmtInt(detail.received_qty)}</div>
              <div><span className="text-slate-400">差异数量：</span>{Number(detail.diff_qty) ? <span className="text-red-600">{-Number(detail.diff_qty)}</span> : '0'}</div>
              <div><span className="text-slate-400">金额：</span>¥{fmtMoney(detail.total_amount)}</div>
            </div>
            <Table
              columns={[
                { key: 'sku_code', title: 'SKU', width: 115 },
                { key: 'product_name', title: '商品', width: 190, render: (r) => `${r.product_name} ${r.sku_name || ''}` },
                { key: 'req_qty', title: '要货量', width: 75, align: 'right', render: (r) => fmtInt(r.req_qty) },
                { key: 'ship_qty', title: '发货量', width: 75, align: 'right', render: (r) => fmtInt(r.ship_qty) },
                { key: 'recv_qty', title: '实收', width: 70, align: 'right', render: (r) => (r.recv_qty == null ? <span className="text-amber-600">待收</span> : fmtInt(r.recv_qty)) },
                {
                  key: 'diff_qty',
                  title: '差异',
                  width: 65,
                  align: 'right',
                  render: (r) => (r.diff_qty == null ? '—' : Number(r.diff_qty) ? <span className="text-red-600">{-Number(r.diff_qty)}</span> : '0')
                },
                {
                  key: 'batch_list',
                  title: '批次',
                  width: 150,
                  render: (r) =>
                    r.batch_list?.length ? (
                      <span className="text-[11px] font-mono text-slate-500">
                        {r.batch_list.map((b: any) => `${b.batchNo}×${b.qty}`).join(', ')}
                      </span>
                    ) : (
                      '—'
                    )
                },
                { key: 'price', title: '成本', width: 85, align: 'right', render: (r) => `¥${fmtMoney(r.price)}` },
                { key: 'amount', title: '金额', width: 95, align: 'right', render: (r) => `¥${fmtMoney(r.amount)}` }
              ]}
              data={detail.items || []}
            />
            {detail.remark && <div className="mt-3 text-[12px] text-slate-500">备注：{detail.remark}</div>}
          </div>
        )}
      </Modal>
    </div>
  )
}
