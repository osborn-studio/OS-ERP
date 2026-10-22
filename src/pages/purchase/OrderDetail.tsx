/**
 * ============================================================================
 * 文件标识：src/pages/purchase/OrderDetail.tsx ｜ PurchaseOrderDetail（页面，未取到标题）
 * ============================================================================
 * 【职责】PurchaseOrderDetail（页面，未取到标题）（页面）
 * 【入口】/purchase/orders/:id
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
 * 页面：PurchaseOrderDetail（页面，未取到标题）
 */

import { useNavigate, useParams } from 'react-router-dom'
import api from '../../api/client'
import { Card, SectionTitle, Status, fmtInt, fmtMoney, toast, useFetch } from '../../components/ui'
import { ArrowLeft } from 'lucide-react'

export default function PurchaseOrderDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const { data, reload } = useFetch<any>(id ? `/purchase/orders/${id}` : null, undefined, [id])

  if (!data) return <Card className="text-center py-10 text-slate-400">加载中…</Card>

  const act = async (action: string) => {
    if (!confirm(`确认执行「${action}」？`)) return
    try {
      await api.post(`/purchase/orders/${id}/status`, { action })
      toast('操作成功')
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const receive = async () => {
    if (!confirm('按订单剩余数量全额收货入库？')) return
    try {
      await api.post(`/purchase/orders/${id}/receive`, { receipt_date: new Date().toISOString().slice(0, 10), remark: '质检合格' })
      toast('收货完成')
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const Info = ({ label, value }: { label: string; value: any }) => (
    <div className="flex flex-col">
      <span className="text-[12px] text-ink-700">{label}</span>
      <span className="text-[13px] text-ink-900 mt-0.5">{value ?? '—'}</span>
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <button className="btn-ghost btn-sm" onClick={() => nav('/purchase/orders')}>
            <ArrowLeft size={13} /> 返回
          </button>
          <div>
            <h1 className="title-serif text-[19px] font-medium text-ink-900">{data.doc_no}</h1>
            <p className="text-[12px] text-ink-700 mt-0.5">
              采购订单 · <Status value={data.status} />
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {data.status === 'draft' && <button className="btn-ghost" onClick={() => act('submit')}>提交审批</button>}
          {data.status === 'submitted' && <button className="btn-ghost" onClick={() => act('approve')}>审批通过</button>}
          {['submitted', 'approved'].includes(data.status) && <button className="btn-primary" onClick={receive}>按单收货入库</button>}
          {data.status === 'received' && <button className="btn-ghost" onClick={() => act('close')}>关闭订单</button>}
        </div>
      </div>

      <Card>
        <SectionTitle title="单据信息" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Info label="供应商" value={data.supplier_name} />
          <Info label="收货仓库" value={data.warehouse_name} />
          <Info label="下单日期" value={data.order_date} />
          <Info label="期望到货" value={data.expect_date} />
          <Info label="采购员" value={data.buyer} />
          <Info label="结算方式" value={data.settle_type} />
          <Info label="订单数量" value={fmtInt(data.total_qty)} />
          <Info label="订单金额" value={`¥${fmtMoney(data.total_amount)}`} />
          <Info label="税额" value={`¥${fmtMoney(data.tax_amount)}`} />
          <Info label="备注" value={data.remark} />
        </div>
      </Card>

      <Card pad={false}>
        <div className="px-4 pt-4">
          <SectionTitle title="采购明细" desc={`共 ${data.items?.length || 0} 行`} />
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>SKU 编码</th>
                <th>商品</th>
                <th>规格</th>
                <th className="text-right">数量</th>
                <th className="text-right">已收</th>
                <th className="text-right">单价</th>
                <th className="text-right">金额</th>
                <th>税率</th>
              </tr>
            </thead>
            <tbody>
              {(data.items || []).map((it: any) => (
                <tr key={it.id}>
                  <td>{it.sku_code}</td>
                  <td>{it.sku_name}</td>
                  <td>{it.spec || '—'}</td>
                  <td className="text-right tabular-nums">{fmtInt(it.qty)}</td>
                  <td className="text-right tabular-nums">{fmtInt(it.received_qty)}</td>
                  <td className="text-right tabular-nums">¥{fmtMoney(it.price)}</td>
                  <td className="text-right tabular-nums">¥{fmtMoney(it.amount)}</td>
                  <td>{it.tax_rate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card pad={false}>
        <div className="px-4 pt-4">
          <SectionTitle title="收货记录" desc={`共 ${data.receipts?.length || 0} 张收货单`} />
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>收货单号</th>
                <th>收货日期</th>
                <th className="text-right">数量</th>
                <th className="text-right">金额</th>
                <th>验收人</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {(data.receipts || []).length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-slate-400">尚未收货</td>
                </tr>
              )}
              {(data.receipts || []).map((r: any) => (
                <tr key={r.id}>
                  <td>{r.doc_no}</td>
                  <td>{r.receipt_date}</td>
                  <td className="text-right tabular-nums">{fmtInt(r.total_qty)}</td>
                  <td className="text-right tabular-nums">¥{fmtMoney(r.total_amount)}</td>
                  <td>{r.inspector || '—'}</td>
                  <td><Status value={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
