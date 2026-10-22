/**
 * ============================================================================
 * 文件标识：src/pages/inventory/Alerts.tsx ｜ 库存预警
 * ============================================================================
 * 【职责】库存预警（页面）
 * 【入口】/inventory/alerts
 * 【主要接口】/inventory/alerts、/inventory/stats
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
 * 页面：库存预警
 */

import { Card, Status, fmtInt, fmtMoney, useFetch } from '../../components/ui'
import { useDict } from '../../hooks/opts'
import { AlertTriangle, Clock, PackageX, Snowflake } from 'lucide-react'

export default function Alerts() {
  const { label } = useDict()
  const { data } = useFetch<any>('/inventory/alerts')
  const { data: stats } = useFetch<any>('/inventory/stats')

  const Block = ({
    title,
    desc,
    icon,
    count,
    tone,
    children
  }: {
    title: string
    desc: string
    icon: any
    count: number
    tone: string
    children: any
  }) => {
    const Icon = icon
    return (
      <Card pad={false} className="mb-3">
        <div className="px-4 py-3 flex items-center justify-between border-b border-ink-300">
          <div className="flex items-center gap-2.5">
            <div className={`w-8 h-8 rounded-md flex items-center justify-center ${tone}`}>
              <Icon size={15} />
            </div>
            <div>
              <div className="text-[14px] font-medium text-ink-900">{title}</div>
              <div className="text-[12px] text-ink-700">{desc}</div>
            </div>
          </div>
          <span className="tag bg-ink-200 text-ink-800">{count} 项</span>
        </div>
        <div className="table-wrap">{children}</div>
      </Card>
    )
  }

  return (
    <div>
      <div className="mb-3">
        <h1 className="title-serif text-[19px] font-medium text-ink-900">库存预警</h1>
        <p className="text-[12px] text-ink-700 mt-0.5">低于安全库存、临期批次、零库存与呆滞库存的四类风险清单</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <div className="kpi">
          <span className="kpi-label">低于安全库存</span>
          <span className="kpi-value text-amber-600">{fmtInt(data?.belowSafe?.length)}</span>
          <span className="kpi-sub">建议立即补货</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">临期批次</span>
          <span className="kpi-value text-orange-600">{fmtInt(data?.expiring?.length)}</span>
          <span className="kpi-sub">180 天内到期</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">零库存 SKU</span>
          <span className="kpi-value text-red-600">{fmtInt(data?.zeroStock?.length)}</span>
          <span className="kpi-sub">在售但无库存</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">呆滞库存</span>
          <span className="kpi-value text-ink-800">{fmtInt(data?.frozen?.length)}</span>
          <span className="kpi-sub">90 天无动销</span>
        </div>
      </div>

      <Block
        title="低于安全库存"
        desc="累计现存量低于 SKU 安全库存，存在断货风险"
        icon={AlertTriangle}
        count={data?.belowSafe?.length || 0}
        tone="bg-amber-50 text-amber-600"
      >
        <table className="tbl">
          <thead>
            <tr>
              <th>SKU 编码</th>
              <th>商品</th>
              <th className="text-right">安全库存</th>
              <th className="text-right">现存量</th>
              <th className="text-right">缺口</th>
            </tr>
          </thead>
          <tbody>
            {(data?.belowSafe || []).length === 0 && (
              <tr><td colSpan={5} className="text-center py-6 text-slate-400">暂无低于安全库存的 SKU</td></tr>
            )}
            {(data?.belowSafe || []).map((x: any) => (
              <tr key={x.sku_id}>
                <td>{x.sku_code}</td>
                <td>{x.product_name} · {x.sku_name}</td>
                <td className="text-right tabular-nums">{fmtInt(x.safe_stock)}</td>
                <td className="text-right tabular-nums">{fmtInt(x.qty_on_hand)}</td>
                <td className="text-right tabular-nums text-amber-600">{fmtInt(x.shortage)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Block>

      <Block
        title="临期批次"
        desc="按到期日排序，30 / 90 / 180 天分级提醒"
        icon={Clock}
        count={data?.expiring?.length || 0}
        tone="bg-orange-50 text-orange-600"
      >
        <table className="tbl">
          <thead>
            <tr>
              <th>SKU 编码</th>
              <th>商品</th>
              <th>仓库</th>
              <th>批次号</th>
              <th>到期日</th>
              <th className="text-right">剩余天数</th>
              <th className="text-right">库存数量</th>
              <th>预警级别</th>
            </tr>
          </thead>
          <tbody>
            {(data?.expiring || []).length === 0 && (
              <tr><td colSpan={8} className="text-center py-6 text-slate-400">暂无临期批次</td></tr>
            )}
            {(data?.expiring || []).map((x: any) => (
              <tr key={x.id}>
                <td>{x.sku_code}</td>
                <td>{x.sku_name}</td>
                <td>{x.warehouse_name}</td>
                <td>{x.batch_no}</td>
                <td>{x.expire_date}</td>
                <td className="text-right tabular-nums">{fmtInt(x.days_left)}</td>
                <td className="text-right tabular-nums">{fmtInt(x.qty_on_hand)}</td>
                <td><Status value={x.level} text={label('expire_level', x.level)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Block>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Block
          title="零库存 SKU"
          desc="在售但全仓无现货"
          icon={PackageX}
          count={data?.zeroStock?.length || 0}
          tone="bg-red-50 text-red-600"
        >
          <table className="tbl">
            <thead>
              <tr><th>SKU 编码</th><th>商品</th></tr>
            </thead>
            <tbody>
              {(data?.zeroStock || []).length === 0 && (
                <tr><td colSpan={2} className="text-center py-6 text-slate-400">所有在售 SKU 均有库存</td></tr>
              )}
              {(data?.zeroStock || []).map((x: any) => (
                <tr key={x.sku_id}><td>{x.sku_code}</td><td>{x.sku_name}</td></tr>
              ))}
            </tbody>
          </table>
        </Block>

        <Block
          title="呆滞库存"
          desc="90 天内无出库动销的批次"
          icon={Snowflake}
          count={data?.frozen?.length || 0}
          tone="bg-ink-200 text-ink-800"
        >
          <table className="tbl">
            <thead>
              <tr><th>SKU 编码</th><th>仓库</th><th className="text-right">库存</th><th className="text-right">滞留天数</th></tr>
            </thead>
            <tbody>
              {(data?.frozen || []).length === 0 && (
                <tr><td colSpan={4} className="text-center py-6 text-slate-400">暂无呆滞批次</td></tr>
              )}
              {(data?.frozen || []).map((x: any) => (
                <tr key={x.id}>
                  <td>{x.sku_code}</td>
                  <td>{x.warehouse_name}</td>
                  <td className="text-right tabular-nums">{fmtInt(x.qty_on_hand)}</td>
                  <td className="text-right tabular-nums">{fmtInt(x.idle_days)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      </div>
    </div>
  )
}
