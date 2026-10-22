/**
 * ============================================================================
 * 文件标识：src/pages/sales/Orders.tsx ｜ 销售订单
 * ============================================================================
 * 【职责】销售订单（页面）
 * 【入口】/sales/orders
 * 【主要接口】/sales/stats、/sales/orders
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
 * 页面：销售订单
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../api/client'
import { Card, Field, Modal, Pagination, StatCard, Status, Table, Tabs, fmtInt, fmtMoney, toast, useFetch, useList } from '../../components/ui'
import { DateRange, FilterBar, Inp, Sel } from '../../components/DataPage'
import { LinesEditor, Line } from '../../components/Lines'
import { useDict, useOpts } from '../../hooks/opts'
import { Plus, RefreshCw, Eye } from 'lucide-react'

/** 动作 → 具体接口路径。写成表而不是拼字符串，契约检查才能覆盖到 */
const ACTION_PATH = (id: any): Record<string, string> => ({
  confirm: `/sales/orders/${id}/confirm`,
  cancel: `/sales/orders/${id}/cancel`,
  complete: `/sales/orders/${id}/complete`
})

export default function SalesOrders() {
  const nav = useNavigate()
  const o = useOpts()
  const { salesChannels, salesStatus } = useDict()
  const [tab, setTab] = useState('')
  const [keyword, setKeyword] = useState('')
  const [range, setRange] = useState({ from: '', to: '' })
  const [channel, setChannel] = useState('')
  const { list, total, loading, page, pageSize, setPage, reload } = useList('/sales/orders', {})
  const { data: stats, reload: reloadStats } = useFetch<any>('/sales/stats')
  const [open, setOpen] = useState(false)

  const refresh = () => {
    reload()
    reloadStats()
  }

  const filtered = list.filter((r: any) => {
    if (tab && r.status !== tab) return false
    if (channel && r.channel !== channel) return false
    if (range.from && r.order_date < range.from) return false
    if (range.to && r.order_date > range.to) return false
    if (keyword && !`${r.doc_no} ${r.customer_name || ''} ${r.dealer_name || ''} ${r.store_name || ''}`.toLowerCase().includes(keyword.toLowerCase())) return false
    return true
  })

  const act = async (row: any, action: string) => {
    const label: Record<string, string> = { confirm: '确认订单（占用库存）', cancel: '取消订单', complete: '完成订单' }
    if (!confirm(`确认对 ${row.doc_no} 执行「${label[action]}」？`)) return
    try {
      // 用具体路径而不是 `/${action}`：动态段拼出来的路径无法被 OpenAPI 契约覆盖
      const path = ACTION_PATH[row.id]?.[action]
      if (!path) return toast(`未知动作 ${action}`, 'error')
      await api.post(path, {})
      toast('操作成功')
      refresh()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const deliver = async (row: any) => {
    if (!confirm(`确认对 ${row.doc_no} 执行发货？将按批次先进先出挑货并出库。`)) return
    try {
      await api.post(`/sales/orders/${row.id}/deliver`, { delivery_date: new Date().toISOString().slice(0, 10) })
      toast('发货完成，已按批次出库')
      refresh()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">销售订单</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">经销商分销 / 门店零售 / 平台电商 多渠道统一订单中心</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={refresh}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-primary btn-sm" onClick={() => setOpen(true)}>
            <Plus size={14} /> 新建销售订单
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="订单总数" value={fmtInt(stats?.totalOrders)} sub={`金额 ¥${fmtMoney(stats?.totalAmount, 0)}`} tone="brand" />
        <StatCard label="经销商分销" value={fmtInt(stats?.byChannel?.find((x: any) => x.channel === 'dealer')?.orders)} sub={`¥${fmtMoney(stats?.byChannel?.find((x: any) => x.channel === 'dealer')?.amount, 0)}`} />
        <StatCard label="门店零售" value={fmtInt(stats?.byChannel?.find((x: any) => x.channel === 'store')?.orders)} sub={`¥${fmtMoney(stats?.byChannel?.find((x: any) => x.channel === 'store')?.amount, 0)}`} />
        <StatCard label="待发货" value={fmtInt(stats?.pendingDelivery)} sub="需安排拣货出库" tone="amber" />
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[{ key: '', label: '全部' }, ...salesStatus.map((s) => ({ key: String(s.value), label: s.label }))]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>

      <FilterBar onReset={() => { setKeyword(''); setChannel(''); setRange({ from: '', to: '' }) }}>
        <Inp value={keyword} onChange={setKeyword} placeholder="单号 / 客户" w={200} />
        <Sel value={channel} onChange={setChannel} options={salesChannels} placeholder="全部渠道" w={170} />
        <DateRange from={range.from} to={range.to} onFrom={(v) => setRange({ ...range, from: v })} onTo={(v) => setRange({ ...range, to: v })} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '订单号', width: 150, render: (r) => <span className="link" onClick={() => nav(`/sales/orders/${r.id}`)}>{r.doc_no}</span> },
            { key: 'channel', title: '渠道', width: 100, render: (r) => salesChannels.find((c) => c.value === r.channel)?.label || r.channel },
            { key: 'customer_name', title: '客户', width: 210, render: (r) => r.dealer_name || r.store_name || r.receiver || '—' },
            { key: 'warehouse_name', title: '发货仓库', width: 150 },
            { key: 'order_date', title: '下单日期', width: 110 },
            { key: 'item_count', title: '行数', width: 60, align: 'right' },
            { key: 'total_qty', title: '数量', width: 80, align: 'right', render: (r) => fmtInt(r.total_qty) },
            { key: 'receivable_amount', title: '应收金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.receivable_amount)}` },
            { key: 'paid_amount', title: '已收金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.paid_amount)}` },
            { key: 'status', title: '状态', width: 110, render: (r) => <Status value={r.status} /> },
            {
              key: '__act',
              title: '操作',
              width: 200,
              render: (r) => (
                <div className="flex items-center gap-2 text-[12px]">
                  <button className="link inline-flex items-center gap-1" onClick={() => nav(`/sales/orders/${r.id}`)}>
                    <Eye size={12} /> 详情
                  </button>
                  {['draft', 'confirmed'].includes(r.status) ? null : null}
                  {r.status === 'draft' && <button className="link" onClick={() => act(r, 'confirm')}>确认</button>}
                  {['confirmed', 'picking'].includes(r.status) && <button className="link" onClick={() => deliver(r)}>发货</button>}
                  {r.status === 'shipped' && <button className="link" onClick={() => act(r, 'complete')}>完成</button>}
                  {['draft', 'confirmed'].includes(r.status) && (
                    <button className="text-red-500 hover:text-red-600" onClick={() => act(r, 'cancel')}>取消</button>
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

      <CreateModal open={open} onClose={() => setOpen(false)} onSaved={refresh} />
    </div>
  )
}

function CreateModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const o = useOpts()
  const { salesChannels } = useDict()
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState<any>({})
  const [lines, setLines] = useState<Line[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setForm({ channel: 'dealer', order_date: today })
      setLines([{ qty: 1, tax_rate: 13 }])
    }
  }, [open, today])

  const submit = async () => {
    if (!lines.length || lines.some((l) => !l.sku_id || !(Number(l.qty) > 0))) return toast('请完整填写明细行', 'error')
    if (form.channel === 'dealer' && !form.dealer_id) return toast('经销商渠道必须选择经销商', 'error')
    if (form.channel === 'store' && !form.store_id) return toast('门店渠道必须选择门店', 'error')
    setSaving(true)
    try {
      await api.post('/sales/orders', { ...form, items: lines })
      toast('销售订单已创建（草稿）')
      onClose()
      onSaved()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const priceKey = form.channel === 'dealer' ? 'price_dealer' : 'price_retail'

  return (
    <Modal
      open={open}
      title="新建销售订单"
      width={940}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '提交中…' : '保存草稿'}</button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4 mb-4">
        <Field label="销售渠道" required>
          <select className="input" value={form.channel ?? ''} onChange={(e) => setForm({ ...form, channel: e.target.value, dealer_id: '', store_id: '' })}>
            {salesChannels.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </Field>
        {form.channel === 'dealer' && (
          <Field label="经销商" required>
            <select className="input" value={form.dealer_id ?? ''} onChange={(e) => setForm({ ...form, dealer_id: e.target.value })}>
              <option value="">请选择</option>
              {o.dealers.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </Field>
        )}
        {form.channel === 'store' && (
          <Field label="门店" required>
            <select className="input" value={form.store_id ?? ''} onChange={(e) => setForm({ ...form, store_id: e.target.value })}>
              <option value="">请选择</option>
              {o.stores.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="发货仓库" hint="留空按渠道自动匹配">
          <select className="input" value={form.warehouse_id ?? ''} onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}>
            <option value="">自动匹配</option>
            {o.warehouses.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </Field>
        <Field label="下单日期">
          <input className="input" type="date" value={form.order_date ?? ''} onChange={(e) => setForm({ ...form, order_date: e.target.value })} />
        </Field>
        <Field label="收货人">
          <input className="input" value={form.receiver ?? ''} onChange={(e) => setForm({ ...form, receiver: e.target.value })} />
        </Field>
        <Field label="联系电话">
          <input className="input" value={form.receiver_phone ?? ''} onChange={(e) => setForm({ ...form, receiver_phone: e.target.value })} />
        </Field>
        <Field label="收货地址" span={2}>
          <input className="input" value={form.receiver_address ?? ''} onChange={(e) => setForm({ ...form, receiver_address: e.target.value })} />
        </Field>
      </div>
      <LinesEditor lines={lines} onChange={setLines} skus={o.skus} priceKey={priceKey} />
    </Modal>
  )
}
