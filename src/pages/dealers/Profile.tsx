/**
 * ============================================================================
 * 文件标识：src/pages/dealers/Profile.tsx ｜ DealerProfile（页面，未取到标题）
 * ============================================================================
 * 【职责】DealerProfile（页面，未取到标题）（页面）
 * 【入口】/dealers/:id
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
 * 页面：DealerProfile（页面，未取到标题）
 */

import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Card, SectionTitle, StatCard, Status, Tabs, fmtInt, fmtMoney, fmtPct, useFetch } from '../../components/ui'
import { useDict } from '../../hooks/opts'
import { ArrowLeft } from 'lucide-react'

export default function DealerProfile() {
  const { id } = useParams()
  const nav = useNavigate()
  const { dealerLevels, dealerChannel, rebateStatus } = useDict()
  const { data } = useFetch<any>(id ? `/dealers/${id}/profile` : null, undefined, [id])
  const { data: analysis } = useFetch<any>(id ? `/dealers/${id}/purchase-analysis` : null, undefined, [id])
  const [tab, setTab] = useState('orders')

  if (!data) return <Card className="text-center py-10 text-slate-400">加载中…</Card>
  const d = data.dealer

  const Info = ({ label, value }: { label: string; value: any }) => (
    <div>
      <div className="text-[12px] text-ink-700">{label}</div>
      <div className="text-[13px] text-ink-900 mt-0.5">{value ?? '—'}</div>
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <button className="btn-ghost btn-sm" onClick={() => nav('/dealers')}>
          <ArrowLeft size={13} /> 返回
        </button>
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">{d.name}</h1>
          <p className="text-[12px] text-ink-700 mt-0.5 flex items-center gap-2">
            {d.code} · <Status value={d.level} text={d.level_name} />
            <span>{d.region} / {d.city}</span>
            <Status value={d.status} />
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard label="累计销售额" value={`¥${fmtMoney(data.sales?.amount, 0)}`} sub={`${fmtInt(data.sales?.orders)} 张订单`} tone="brand" />
        <StatCard label="已回款" value={`¥${fmtMoney(data.sales?.paid, 0)}`} sub={`未回款 ¥${fmtMoney((data.sales?.amount || 0) - (data.sales?.paid || 0), 0)}`} tone="green" />
        <StatCard label="授信额度" value={`¥${fmtMoney(d.credit_limit, 0)}`} sub={`已用 ¥${fmtMoney(d.credit_used, 0)}`} />
        <StatCard
          label="额度占用率"
          value={fmtPct((Number(d.credit_used) / Number(d.credit_limit || 1)) * 100)}
          sub="超过 80% 需关注"
          tone="amber"
        />
        <StatCard label="返利政策" value={`${d.rebate_rate || 0}%`} sub={`折扣率 ${d.discount_rate || 100}%`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <SectionTitle title="合作档案" />
          <div className="grid grid-cols-2 gap-4">
            <Info label="渠道类型" value={dealerChannel.find((c) => c.value === d.channel_type)?.label} />
            <Info label="结算方式" value={d.settle_type} />
            <Info label="联系人" value={d.contact} />
            <Info label="联系电话" value={d.phone} />
            <Info label="税号" value={d.tax_no} />
            <Info label="合作起始" value={d.onboard_date} />
            <Info label="地址" value={d.address} />
            <Info label="备注" value={d.remark} />
          </div>
        </Card>

        <Card>
          <SectionTitle title="月度销售趋势" desc="近 4 个月" />
          <div className="flex flex-col gap-2.5 pt-1">
            {(data.monthly || []).map((m: any) => {
              const max = Math.max(...(data.monthly || []).map((x: any) => Number(x.amount || 0)), 1)
              return (
                <div key={m.month} className="flex items-center gap-3">
                  <span className="w-20 text-[13px] text-ink-800">{m.month}</span>
                  <div className="flex-1 h-2.5 bg-ink-200 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(Number(m.amount) / max) * 100}%`, background: '#245b4a' }} />
                  </div>
                  <span className="w-28 text-right text-[13px] tabular-nums text-ink-800">¥{fmtMoney(m.amount, 0)}</span>
                  <span className="w-14 text-right text-[12px] text-ink-700">{m.orders} 单</span>
                </div>
              )
            })}
          </div>
        </Card>
      </div>

      <Card pad={false}>
        <div className="px-4 pt-4">
          <Tabs
            tabs={[
              { key: 'orders', label: '近期订单' },
              { key: 'products', label: '畅销商品' },
              { key: 'rebates', label: '返利记录' },
              { key: 'statements', label: '对账单' },
              { key: 'analysis', label: '采购结构' }
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
        <div className="table-wrap">
          {tab === 'orders' && (
            <table className="tbl">
              <thead>
                <tr>
                  <th>订单号</th>
                  <th>下单日期</th>
                  <th className="text-right">数量</th>
                  <th className="text-right">应收金额</th>
                  <th className="text-right">已收金额</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {(data.recentOrders || []).map((o: any) => (
                  <tr key={o.id} className="cursor-pointer" onClick={() => nav(`/sales/orders/${o.id}`)}>
                    <td className="link">{o.doc_no}</td>
                    <td>{o.order_date}</td>
                    <td className="text-right tabular-nums">{fmtInt(o.total_qty)}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(o.receivable_amount)}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(o.paid_amount)}</td>
                    <td><Status value={o.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'products' && (
            <table className="tbl">
              <thead>
                <tr>
                  <th>商品</th>
                  <th>SKU</th>
                  <th className="text-right">数量</th>
                  <th className="text-right">金额</th>
                </tr>
              </thead>
              <tbody>
                {(data.topProducts || []).map((p: any, i: number) => (
                  <tr key={i}>
                    <td>{p.product_name}</td>
                    <td>{p.sku_name}</td>
                    <td className="text-right tabular-nums">{fmtInt(p.qty)}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(p.amount, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'rebates' && (
            <table className="tbl">
              <thead>
                <tr>
                  <th>返利期间</th>
                  <th className="text-right">销售金额</th>
                  <th className="text-right">退货金额</th>
                  <th className="text-right">净额</th>
                  <th className="text-right">返利率</th>
                  <th className="text-right">返利金额</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {(data.rebates || []).map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.period}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(r.sales_amount, 0)}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(r.return_amount, 0)}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(r.net_amount, 0)}</td>
                    <td className="text-right tabular-nums">{r.rebate_rate}%</td>
                    <td className="text-right tabular-nums font-medium">¥{fmtMoney(r.rebate_amount)}</td>
                    <td><Status value={r.status} text={rebateStatus.find((x) => x.value === r.status)?.label} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'statements' && (
            <table className="tbl">
              <thead>
                <tr>
                  <th>对账单号</th>
                  <th>期间</th>
                  <th className="text-right">期初</th>
                  <th className="text-right">本期销售</th>
                  <th className="text-right">本期回款</th>
                  <th className="text-right">期末应收</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {(data.statements || []).map((s: any) => (
                  <tr key={s.id}>
                    <td>{s.doc_no}</td>
                    <td>{s.period_start} ~ {s.period_end}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(s.opening_amount, 0)}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(s.sales_amount, 0)}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(s.received_amount, 0)}</td>
                    <td className="text-right tabular-nums font-medium">¥{fmtMoney(s.closing_amount, 0)}</td>
                    <td><Status value={s.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'analysis' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
              <div>
                <div className="text-[13px] font-medium text-ink-900 mb-2">按品类采购</div>
                <table className="tbl">
                  <thead>
                    <tr><th>品类</th><th className="text-right">数量</th><th className="text-right">金额</th></tr>
                  </thead>
                  <tbody>
                    {(analysis?.byCategory || []).map((x: any) => (
                      <tr key={x.category_name}>
                        <td>{x.category_name}</td>
                        <td className="text-right tabular-nums">{fmtInt(x.qty)}</td>
                        <td className="text-right tabular-nums">¥{fmtMoney(x.amount, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="text-[13px] font-medium text-ink-900 mb-2">按品牌采购</div>
                <table className="tbl">
                  <thead>
                    <tr><th>品牌</th><th className="text-right">数量</th><th className="text-right">金额</th></tr>
                  </thead>
                  <tbody>
                    {(analysis?.byBrand || []).map((x: any) => (
                      <tr key={x.brand_name}>
                        <td>{x.brand_name}</td>
                        <td className="text-right tabular-nums">{fmtInt(x.qty)}</td>
                        <td className="text-right tabular-nums">¥{fmtMoney(x.amount, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="lg:col-span-2 text-[13px] text-ink-800">
                退货率：
                <span className="font-medium ml-1">
                  {fmtPct((Number(analysis?.returnRate?.returns || 0) / Number(analysis?.returnRate?.sales || 1)) * 100, 2)}
                </span>
                <span className="text-ink-700 ml-2">
                  （销售 ¥{fmtMoney(analysis?.returnRate?.sales, 0)} / 退货 ¥{fmtMoney(analysis?.returnRate?.returns, 0)}）
                </span>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
