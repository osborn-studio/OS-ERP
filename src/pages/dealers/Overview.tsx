/**
 * ============================================================================
 * 文件标识：src/pages/dealers/Overview.tsx ｜ 经销商总览
 * ============================================================================
 * 【职责】经销商总览（页面）
 * 【入口】/dealers
 * 【主要接口】/dealers/overview
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
 * 页面：经销商总览
 */

import { useNavigate } from 'react-router-dom'
import { Card, SectionTitle, StatCard, Status, fmtInt, fmtMoney, fmtPct, useFetch } from '../../components/ui'
import { useDict } from '../../hooks/opts'

export default function DealerOverview() {
  const nav = useNavigate()
  const { dealerLevels } = useDict()
  const { data } = useFetch<any>('/dealers/overview')

  const maxAmount = Math.max(...(data?.ranking || []).map((x: any) => Number(x.amount || 0)), 1)

  return (
    <div>
      <div className="mb-3">
        <h1 className="title-serif text-[19px] font-medium text-ink-900">经销商总览</h1>
        <p className="text-[12px] text-ink-700 mt-0.5">等级分布、区域分布、销售排行与信用额度占用情况</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="经销商总数" value={fmtInt(data?.total?.dealers)} sub="全国合作渠道" tone="brand" />
        <StatCard label="授信总额度" value={`¥${fmtMoney(data?.total?.credit_limit, 0)}`} sub={`已用 ¥${fmtMoney(data?.total?.credit_used, 0)}`} />
        <StatCard
          label="额度占用率"
          value={fmtPct(((data?.total?.credit_used || 0) / (data?.total?.credit_limit || 1)) * 100)}
          sub="全部经销商平均"
          tone="amber"
        />
        <StatCard label="平均返利率" value={`${data?.total?.avg_rebate ?? 0}%`} sub="按等级政策加权" tone="green" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        <Card>
          <SectionTitle title="等级分布" desc="按经销商等级统计家数与授信额度" />
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>等级</th>
                  <th className="text-right">家数</th>
                  <th className="text-right">授信额度</th>
                </tr>
              </thead>
              <tbody>
                {(data?.byLevel || []).map((x: any) => (
                  <tr key={x.level}>
                    <td>
                      <Status value={x.level} text={x.level_name || dealerLevels.find((l) => l.value === x.level)?.label || x.level} />
                    </td>
                    <td className="text-right tabular-nums">{fmtInt(x.cnt)}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(x.credit, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <SectionTitle title="区域分布" desc="按大区统计经销商家数" />
          <div className="flex flex-col gap-2.5 pt-1">
            {(data?.byRegion || []).map((x: any) => {
              const max = Math.max(...(data?.byRegion || []).map((y: any) => y.cnt), 1)
              return (
                <div key={x.region} className="flex items-center gap-3">
                  <span className="w-16 text-[13px] text-ink-800">{x.region}</span>
                  <div className="flex-1 h-2.5 bg-ink-200 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(x.cnt / max) * 100}%`, background: 'linear-gradient(90deg,#245b4a,#b58a4a)' }} />
                  </div>
                  <span className="w-10 text-right text-[13px] tabular-nums text-ink-800">{x.cnt}</span>
                </div>
              )
            })}
          </div>
        </Card>
      </div>

      <Card pad={false}>
        <div className="px-4 pt-4">
          <SectionTitle title="销售排行" desc="按累计销售金额排序，点击可查看经销商 360 画像" />
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 50 }}>#</th>
                <th>经销商</th>
                <th>等级</th>
                <th>区域</th>
                <th className="text-right">订单数</th>
                <th className="text-right">销售金额</th>
                <th style={{ width: 180 }}>占比</th>
                <th className="text-right">已回款</th>
                <th className="text-right">未回款</th>
                <th className="text-right">额度占用</th>
              </tr>
            </thead>
            <tbody>
              {(data?.ranking || []).map((x: any, i: number) => (
                <tr key={x.id} className="cursor-pointer" onClick={() => nav(`/dealers/${x.id}`)}>
                  <td className="text-ink-700">{i + 1}</td>
                  <td className="link">{x.name}</td>
                  <td><Status value={x.level} text={dealerLevels.find((l) => l.value === x.level)?.label} /></td>
                  <td>{x.region}</td>
                  <td className="text-right tabular-nums">{fmtInt(x.orders)}</td>
                  <td className="text-right tabular-nums">¥{fmtMoney(x.amount, 0)}</td>
                  <td>
                    <div className="h-2 bg-ink-200 rounded-full overflow-hidden">
                      <div className="h-full bg-brand-600 rounded-full" style={{ width: `${(Number(x.amount) / maxAmount) * 100}%` }} />
                    </div>
                  </td>
                  <td className="text-right tabular-nums">¥{fmtMoney(x.paid, 0)}</td>
                  <td className="text-right tabular-nums text-amber-600">¥{fmtMoney(x.unpaid, 0)}</td>
                  <td className="text-right tabular-nums">
                    {fmtPct((Number(x.credit_used) / Number(x.credit_limit || 1)) * 100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
