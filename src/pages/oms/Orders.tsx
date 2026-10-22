/**
 * ============================================================================
 * 文件标识：src/pages/oms/Orders.tsx ｜ 线上订单
 * ============================================================================
 * 【职责】线上订单（页面）
 * 【入口】/oms/orders
 * 【主要接口】/oms/orders/convert-batch
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
 * 页面：线上订单
 */

import { useState } from 'react'
import api from '../../api/client'
import { useRuntimeCapabilities } from '../../store/runtime-capabilities'
import { useAuth } from '../../store/auth'
import { CapabilityStatus } from '../../components/CapabilityGate'
import { Card, Modal, Pagination, Status, Table, Tabs, fmtInt, fmtMoney, toast, useList } from '../../components/ui'
import { DateRange, FilterBar, Inp, Sel } from '../../components/DataPage'
import { useDict, useOpts } from '../../hooks/opts'
import { RefreshCw, Truck, RotateCcw, ArrowRightLeft, Check } from 'lucide-react'

export default function OmsOrders() {
  const { enabled } = useRuntimeCapabilities()
  const { is } = useAuth()
  const canSimulate = enabled('oms_simulation') && is('sales', 'warehouse')
  const o = useOpts()
  const { omsStatus } = useDict()
  const [tab, setTab] = useState('')
  const [keyword, setKeyword] = useState('')
  const [platformId, setPlatformId] = useState('')
  const [range, setRange] = useState({ from: '', to: '' })
  const [selected, setSelected] = useState<number[]>([])
  const [detail, setDetail] = useState<any>(null)
  const { list, total, loading, page, pageSize, setPage, reload } = useList('/oms/orders', {})

  const filtered = list.filter((r: any) => {
    if (tab && r.status !== tab) return false
    if (platformId && String(r.platform_id) !== String(platformId)) return false
    if (range.from && (r.order_time || '') < range.from) return false
    if (range.to && (r.order_time || '') > `${range.to} 23:59:59`) return false
    if (keyword && !`${r.platform_order_no} ${r.buyer_nick || ''} ${r.receiver || ''}`.toLowerCase().includes(keyword.toLowerCase())) return false
    return true
  })

  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const doAction = async (fn: () => Promise<any>, msg: string) => {
    try {
      await fn()
      toast(msg)
      setSelected([])
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const convertBatch = () =>
    doAction(async () => {
      if (!selected.length) throw new Error('请先勾选待转单的线上订单')
      await api.post('/oms/orders/convert-batch', { ids: selected })
    }, '已批量转销售订单并占用库存')

  return (
    <div>
      <CapabilityStatus capability="oms_simulation" label="平台发货回传与退款" />
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">线上订单</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">平台订单与转单记录；平台回传能力以当前实例配置为准</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-primary btn-sm" onClick={convertBatch}>
            <ArrowRightLeft size={13} /> 批量转单 {selected.length ? `(${selected.length})` : ''}
          </button>
        </div>
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[{ key: '', label: '全部' }, ...omsStatus.map((s) => ({ key: String(s.value), label: s.label }))]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>

      <FilterBar onReset={() => { setKeyword(''); setPlatformId(''); setRange({ from: '', to: '' }) }}>
        <Inp value={keyword} onChange={setKeyword} placeholder="平台单号 / 买家 / 收件人" w={220} />
        <Sel value={platformId} onChange={setPlatformId} options={o.platforms} placeholder="全部平台" w={160} />
        <DateRange from={range.from} to={range.to} onFrom={(v) => setRange({ ...range, from: v })} onTo={(v) => setRange({ ...range, to: v })} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            {
              key: '__sel',
              title: '',
              width: 40,
              render: (r: any) => (
                <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} disabled={r.status !== 'pending'} />
              )
            },
            { key: 'platform_name', title: '平台', width: 100 },
            {
              key: 'platform_order_no',
              title: '平台单号',
              width: 170,
              render: (r) => (
                <span className="link" onClick={() => setDetail(r)}>
                  {r.platform_order_no}
                </span>
              )
            },
            { key: 'buyer_nick', title: '买家', width: 110 },
            { key: 'order_time', title: '下单时间', width: 160 },
            { key: 'item_count', title: '行数', width: 60, align: 'right' },
            { key: 'pay_amount', title: '实付金额', width: 110, align: 'right', render: (r) => `¥${fmtMoney(r.pay_amount)}` },
            { key: 'receiver', title: '收件人', width: 90 },
            { key: 'sales_order_no', title: '关联销售单', width: 150, render: (r) => r.sales_order_no || '—' },
            { key: 'express_no', title: '运单号', width: 160 },
            { key: 'status', title: '状态', width: 90, render: (r) => <Status value={r.status} /> },
            {
              key: '__act',
              title: '操作',
              width: 290,
              render: (r) => (
                <div className="flex items-center gap-2.5 text-[12px] whitespace-nowrap">
                  {r.status === 'pending' && (
                    <button
                      className="link"
                      onClick={() => doAction(async () => { await api.post(`/oms/orders/${r.id}/convert`, {}) }, '已转销售订单')}
                    >
                      转单
                    </button>
                  )}
                  {canSimulate && ['pending', 'shipped'].includes(r.status) && (
                    <button
                      className="link inline-flex items-center gap-1"
                      onClick={() =>
                        doAction(
                          async () => { await api.post(`/oms/orders/${r.id}/ship`, { express_company: '顺丰速运' }) },
                          '已发货并回传运单号'
                        )
                      }
                    >
                      <Truck size={12} /> 发货
                    </button>
                  )}
                  {/* 订单完成：平台侧早已签收，之前系统里没有任何入口 ⇒ 单子永远停在「已发货」。
                      只对 `shipped` 显示（内核 `OM.complete` 的出边只有 shipped→completed，
                      其它状态点了必然 409 —— 界面不该显示一个后端做不到的动作）。 */}
                  {r.status === 'shipped' && (
                    <button
                      className="link inline-flex items-center gap-1"
                      onClick={() => doAction(async () => { await api.post(`/oms/orders/${r.id}/complete`, {}) }, '订单已完成')}
                    >
                      <Check size={12} /> 完成
                    </button>
                  )}
                  {/* 已退款/已关闭（历史值）/已取消 都不该再显示【退款】。
                      `cancelled` 是撤单走内核后写入的值；漏了它 ⇒ **已撤单的订单会显示一个
                      点了必然 409 的【退款】按钮**（内核里 cancelled 没有 refund 出边，fail-closed）
                      —— 正是"界面显示一个后端做不到的动作"那类缺陷。 */}
                  {canSimulate && !['refunded', 'closed', 'cancelled'].includes(r.status) && (
                    <button
                      className="text-red-500 hover:text-red-600 inline-flex items-center gap-1"
                      onClick={() => doAction(async () => { await api.post(`/oms/orders/${r.id}/refund`, { reason: '买家申请退款' }) }, '退款已受理')}
                    >
                      <RotateCcw size={12} /> 退款
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

      <Modal open={!!detail} title={`线上订单 ${detail?.platform_order_no || ''}`} width={720} onClose={() => setDetail(null)}>
        {detail && (
          <div className="grid grid-cols-2 gap-4 text-[13px]">
            {[
              ['平台', detail.platform_name],
              ['店铺', detail.shop_name],
              ['买家昵称', detail.buyer_nick],
              ['下单时间', detail.order_time],
              ['付款时间', detail.pay_time],
              ['实付金额', `¥${fmtMoney(detail.pay_amount)}`],
              ['商品金额', `¥${fmtMoney(detail.goods_amount)}`],
              ['优惠', `¥${fmtMoney(detail.discount_amount)}`],
              ['收件人', detail.receiver],
              ['联系电话', detail.receiver_phone],
              ['收件地址', detail.receiver_address],
              ['关联销售单', detail.sales_order_no || '未转单'],
              ['运单号', detail.express_no || '—'],
              ['状态', omsStatus.find((s) => s.value === detail.status)?.label || detail.status]
            ].map(([k, v]: any) => (
              <div key={k}>
                <div className="text-[12px] text-ink-700">{k}</div>
                <div className="mt-0.5 text-ink-900">{v ?? '—'}</div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  )
}
