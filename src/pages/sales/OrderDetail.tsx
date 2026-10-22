/**
 * ============================================================================
 * 文件标识：src/pages/sales/OrderDetail.tsx ｜ SalesOrderDetail（页面，未取到标题）
 * ============================================================================
 * 【职责】SalesOrderDetail（页面，未取到标题）（页面）
 * 【入口】/sales/orders/:id
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
 * 页面：SalesOrderDetail（页面，未取到标题）
 */

import { useNavigate, useParams } from 'react-router-dom'
import api from '../../api/client'
import { Card, SectionTitle, Status, fmtInt, fmtMoney, toast, useFetch } from '../../components/ui'
import { useDict } from '../../hooks/opts'
import { ArrowLeft } from 'lucide-react'
// 订单详情里的「发货记录」也是 DL —— 必须与发货单页用**同一份** DL 文案表。
// 只改列表不改详情，就是本项目反复吃过的那个形状：「列表挡得住 / 详情挡不住」；
// 两处各写一份文案表，则改一处忘一处时两张页面显示同一个状态的两个名字。
import { DL_STATUS_LABEL } from './Deliveries'

/** 动作 → 具体接口路径（写成表，契约检查才覆盖得到） */
const ORDER_ACTION_PATH = (id: any): Record<string, string> => ({
  confirm: `/sales/orders/${id}/confirm`,
  cancel: `/sales/orders/${id}/cancel`,
  deliver: `/sales/orders/${id}/deliver`,
  complete: `/sales/orders/${id}/complete`,
  payment: `/sales/orders/${id}/payment`
})

export default function SalesOrderDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const { salesChannels } = useDict()
  const { data, reload } = useFetch<any>(id ? `/sales/orders/${id}` : null, undefined, [id])

  if (!data) return <Card className="text-center py-10 text-slate-400">加载中…</Card>

  const act = async (action: string, body: any = {}) => {
    if (!confirm(`确认执行该操作？`)) return
    try {
      // 用具体路径而不是 `/${action}`：动态拼接无法被 OpenAPI 契约覆盖
      const path = ORDER_ACTION_PATH(id)[action]
      if (!path) return toast(`未知动作 ${action}`, 'error')
      await api.post(path, body)
      toast('操作成功')
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const Info = ({ label, value, span }: { label: string; value: any; span?: boolean }) => (
    <div className={`flex flex-col ${span ? 'col-span-2' : ''}`}>
      <span className="text-[12px] text-ink-700">{label}</span>
      <span className="text-[13px] text-ink-900 mt-0.5">{value ?? '—'}</span>
    </div>
  )

  const customer = data.dealer_name || data.store_name || data.platform_name || data.receiver

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <button className="btn-ghost btn-sm" onClick={() => nav('/sales/orders')}>
            <ArrowLeft size={13} /> 返回
          </button>
          <div>
            <h1 className="title-serif text-[19px] font-medium text-ink-900">{data.doc_no}</h1>
            <p className="text-[12px] text-ink-700 mt-0.5 flex items-center gap-2">
              销售订单 · <Status value={data.status} />
              <span className="text-ink-600">{salesChannels.find((c) => c.value === data.channel)?.label}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {data.status === 'draft' && <button className="btn-primary" onClick={() => act('confirm')}>确认订单（占用库存）</button>}
          {['confirmed', 'picking'].includes(data.status) && (
            <button
              className="btn-primary"
              onClick={() => act('deliver', { delivery_date: new Date().toISOString().slice(0, 10), express_company: '顺丰速运' })}
            >
              发货出库
            </button>
          )}
          {data.status === 'shipped' && <button className="btn-ghost" onClick={() => act('complete')}>标记完成</button>}
          {['draft', 'confirmed'].includes(data.status) && <button className="btn-danger" onClick={() => act('cancel')}>取消订单</button>}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="kpi">
          <span className="kpi-label">应收金额</span>
          <span className="kpi-value">¥{fmtMoney(data.receivable_amount, 0)}</span>
          <span className="kpi-sub">商品 ¥{fmtMoney(data.goods_amount, 0)} · 折扣 ¥{fmtMoney(data.discount_amount, 0)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">已收金额</span>
          <span className="kpi-value text-brand-600">¥{fmtMoney(data.paid_amount, 0)}</span>
          <span className="kpi-sub">未收 ¥{fmtMoney((data.receivable_amount || 0) - (data.paid_amount || 0), 0)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">订单数量</span>
          <span className="kpi-value">{fmtInt(data.total_qty)}</span>
          <span className="kpi-sub">{data.items?.length || 0} 个 SKU</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">发货仓库</span>
          <span className="kpi-value text-[18px] leading-8">{data.warehouse_name || '—'}</span>
          <span className="kpi-sub">业务员 {data.salesperson || '—'}</span>
        </div>
      </div>

      <Card>
        <SectionTitle title="单据信息" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Info label="客户" value={customer} />
          <Info label="下单日期" value={data.order_date} />
          <Info label="收货人" value={data.receiver} />
          <Info label="联系电话" value={data.receiver_phone} />
          <Info label="收货地址" value={data.receiver_address} span />
          <Info label="承运商" value={data.express_company} />
          <Info label="运单号" value={data.express_no} />
          <Info label="备注" value={data.remark} span />
        </div>
      </Card>

      <Card pad={false}>
        <div className="px-4 pt-4">
          <SectionTitle title="销售明细" desc={`共 ${data.items?.length || 0} 行`} />
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>SKU 编码</th>
                <th>商品</th>
                <th>规格</th>
                <th className="text-right">数量</th>
                <th className="text-right">已发</th>
                <th className="text-right">单价</th>
                <th className="text-right">折扣</th>
                <th className="text-right">金额</th>
              </tr>
            </thead>
            <tbody>
              {(data.items || []).map((it: any) => (
                <tr key={it.id}>
                  <td>{it.sku_code}</td>
                  <td>{it.sku_name}</td>
                  <td>{it.spec || '—'}</td>
                  <td className="text-right tabular-nums">{fmtInt(it.qty)}</td>
                  <td className="text-right tabular-nums">{fmtInt(it.shipped_qty)}</td>
                  <td className="text-right tabular-nums">¥{fmtMoney(it.price)}</td>
                  <td className="text-right tabular-nums">¥{fmtMoney(it.discount)}</td>
                  <td className="text-right tabular-nums">¥{fmtMoney(it.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card pad={false}>
        <div className="px-4 pt-4">
          <SectionTitle title="发货记录" desc={`共 ${data.deliveries?.length || 0} 张发货单`} />
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>发货单号</th>
                <th>发货日期</th>
                <th className="text-right">数量</th>
                <th className="text-right">金额</th>
                <th>承运商</th>
                <th>运单号</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {(data.deliveries || []).length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-slate-400">尚未发货</td>
                </tr>
              )}
              {(data.deliveries || []).map((d: any) => (
                <tr key={d.id}>
                  <td>{d.doc_no}</td>
                  <td>{d.delivery_date}</td>
                  <td className="text-right tabular-nums">{fmtInt(d.total_qty)}</td>
                  <td className="text-right tabular-nums">¥{fmtMoney(d.total_amount)}</td>
                  <td>{d.express_company || '—'}</td>
                  <td>{d.express_no || '—'}</td>
                  <td><Status value={d.status} text={DL_STATUS_LABEL[d.status]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
