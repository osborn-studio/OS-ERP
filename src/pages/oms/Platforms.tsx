/**
 * ============================================================================
 * 文件标识：src/pages/oms/Platforms.tsx ｜ 平台店铺
 * ============================================================================
 * 【职责】平台店铺（页面）
 * 【入口】/oms/platforms
 * 【主要接口】/oms/platforms、/oms/stats、/oms/stock-push
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
 * 页面：平台店铺
 */

import { useState } from 'react'
import api from '../../api/client'
import { useRuntimeCapabilities } from '../../store/runtime-capabilities'
import { useAuth } from '../../store/auth'
import { CapabilityStatus } from '../../components/CapabilityGate'
import { Card, SectionTitle, StatCard, Status, fmtInt, fmtMoney, toast, useFetch } from '../../components/ui'
import { useDict } from '../../hooks/opts'
import { RefreshCw, Plug, Radio } from 'lucide-react'

export default function OmsPlatforms() {
  const { enabled } = useRuntimeCapabilities()
  const { is } = useAuth()
  const canSync = enabled('oms_simulation') && is('sales', 'warehouse')
  const { platformTypes } = useDict()
  const { data, reload } = useFetch<any[]>('/oms/platforms')
  const { data: stats, reload: reloadStats } = useFetch<any>('/oms/stats')
  const [busy, setBusy] = useState<number | null>(null)

  const syncOrders = async (p: any) => {
    if (!canSync) return
    setBusy(p.id)
    try {
      const res: any = await api.post(`/oms/sync/${p.id}`, { count: 5 })
      toast(`已从 ${p.name} 拉取 ${res.data?.count ?? 0} 笔新订单`)
      reload()
      reloadStats()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(null)
    }
  }

  const pushStock = async (p: any) => {
    if (!canSync) return
    setBusy(p.id)
    try {
      await api.post('/oms/stock-push', { platform_id: p.id })
      toast(`已向 ${p.name} 推送可售库存`)
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">平台店铺</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">天猫 / 京东 / 抖音 / 美团闪购 / 自营商城 的店铺授权与对接状态</p>
        </div>
        <button className="btn-ghost btn-sm" onClick={() => reload()}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      <CapabilityStatus capability="oms_simulation" label="平台同步与库存推送" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="线上订单总数" value={fmtInt(stats?.total?.orders)} sub={`GMV ¥${fmtMoney(stats?.total?.gmv, 0)}`} tone="brand" />
        <StatCard label="待发货" value={fmtInt(stats?.total?.pending)} sub="需转单并出库" tone="amber" />
        <StatCard label="客单价" value={`¥${fmtMoney(stats?.total?.avg_amount, 0)}`} sub="全部平台平均" />
        <StatCard label="退款笔数" value={fmtInt(stats?.total?.refunded)} sub="含退款中与已退款" tone="red" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
        {(data || []).map((p: any) => (
          <Card key={p.id}>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-md bg-brand-50 text-brand-600 flex items-center justify-center">
                  <Plug size={16} />
                </div>
                <div>
                  <div className="text-[14px] font-medium text-ink-900">{p.name}</div>
                  <div className="text-[12px] text-ink-700">{p.shop_name}</div>
                </div>
              </div>
              <Status value={p.status} />
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-[12px] text-ink-700">累计订单</div>
                <div className="text-[15px] font-medium tabular-nums">{fmtInt(p.order_count)}</div>
              </div>
              <div>
                <div className="text-[12px] text-ink-700">待发货</div>
                <div className="text-[15px] font-medium tabular-nums text-amber-600">{fmtInt(p.pending_count)}</div>
              </div>
              <div>
                <div className="text-[12px] text-ink-700">GMV</div>
                <div className="text-[15px] font-medium tabular-nums">¥{fmtMoney(p.gmv, 0)}</div>
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-ink-300 text-[12px] text-ink-700 flex flex-col gap-1">
              <div>店铺类型：{platformTypes.find((t) => t.value === p.type)?.label || p.type}</div>
              <div>AppKey：{p.app_key || '—'} · Secret：{p.app_secret_masked || '—'}</div>
              <div>发货仓库：{p.warehouse_name || '—'}</div>
              <div>
                同步开关：订单{p.sync_order ? '开' : '关'} / 库存{p.sync_stock ? '开' : '关'} · 最近同步 {p.last_log_at || '—'}
              </div>
            </div>

            {canSync && <div className="mt-3 flex items-center gap-2">
              <button className="btn-primary btn-sm" disabled={busy === p.id} onClick={() => syncOrders(p)}>
                <RefreshCw size={13} /> {busy === p.id ? '同步中…' : '同步订单'}
              </button>
              <button className="btn-ghost btn-sm" disabled={busy === p.id} onClick={() => pushStock(p)}>
                <Radio size={13} /> 推送库存
              </button>
            </div>}
          </Card>
        ))}
      </div>

      <Card className="mt-3" pad={false}>
        <div className="px-4 pt-4">
          <SectionTitle title="各平台经营对比" desc="近 90 天" />
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>平台</th>
                <th className="text-right">订单数</th>
                <th className="text-right">GMV</th>
                <th className="text-right">待发货</th>
                <th className="text-right">退款金额</th>
              </tr>
            </thead>
            <tbody>
              {(stats?.byPlatform || []).map((x: any) => (
                <tr key={x.code}>
                  <td>{x.platform_name}</td>
                  <td className="text-right tabular-nums">{fmtInt(x.orders)}</td>
                  <td className="text-right tabular-nums">¥{fmtMoney(x.gmv, 0)}</td>
                  <td className="text-right tabular-nums">{fmtInt(x.pending)}</td>
                  <td className="text-right tabular-nums text-red-500">¥{fmtMoney(x.refund_amount, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
