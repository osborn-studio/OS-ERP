/**
 * ============================================================================
 * 文件标识：src/pages/Dashboard.tsx ｜ 经营看板
 * ============================================================================
 * 【职责】经营看板（页面）
 * 【入口】/
 * 【主要接口】/dashboard/summary、/dashboard/trend、/dashboard/channel、/dashboard/top、/dashboard/todos、/dashboard/recent
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
 * 页面：经营看板
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles, PlayCircle, BookOpen, RefreshCw } from 'lucide-react'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, BarChart, Bar
} from 'recharts'
import { useFetch, Card, StatCard, SectionTitle, Status, fmtMoney, fmtInt, fmtPct } from '../components/ui'
import { useAuth } from '../store/auth'
import { useRuntimeCapabilities } from '../store/runtime-capabilities'
import { hasDealer } from '../constants/capabilities'
import { selectCacheStamp } from '../utils/cache-stamp'

const PIE_COLORS = ['#2568a6', '#1d9e75', '#7f77dd', '#d85a30', '#ba7517', '#d4537e', '#5f5e5a']

export default function Dashboard() {
  // 经销商只有美妆 / 服装有；连锁餐饮看这一块等于看一个永远为空的榜单
  const { industry } = useAuth()
  const { isDemo } = useRuntimeCapabilities()
  const showDealer = hasDealer(industry)
  const { data: s, stamp: sStamp, reload: reloadSummary, loading: sLoading } = useFetch<any>('/dashboard/summary')
  const { data: trend, stamp: trendStamp, reload: reloadTrend, loading: trendLoading } = useFetch<any[]>('/dashboard/trend', { days: 30 })
  const { data: channel, reload: reloadChannel } = useFetch<any>('/dashboard/channel', { days: 90 })
  const { data: top, stamp: topStamp, reload: reloadTop, loading: topLoading } = useFetch<any>('/dashboard/top', { days: 30 })
  const { data: todos, stamp: todosStamp, reload: reloadTodos, loading: todosLoading } = useFetch<any>('/dashboard/todos')
  const { data: recent, reload: reloadRecent } = useFetch<any>('/dashboard/recent')
  // AC11：四个缓存接口（summary / trend / top / todos）的“数据截至”戳——取最早的一个；有任何一个没戳就不显示（见 utils/cache-stamp.ts）
  const stampView = selectCacheStamp([sStamp, trendStamp, topStamp, todosStamp])
  const refreshing = sLoading || trendLoading || topLoading || todosLoading
  const refreshAll = () => { reloadSummary(); reloadTrend(); reloadChannel(); reloadTop(); reloadTodos(); reloadRecent() }

  const channelData = [
    ...(channel?.offline || []).map((x: any) => ({ name: x.name, value: Number(x.amount || 0) })),
    ...(channel?.online || []).map((x: any) => ({ name: x.platform_name, value: Number(x.amount || 0) }))
  ].filter((x) => x.value > 0)

  const todoCount =
    (todos?.pendingDelivery?.length || 0) +
    (todos?.pendingReceipt?.length || 0) +
    (todos?.omsPending?.length || 0)

  return (
    <div className="flex flex-col gap-4">
      {/* 演示环境声明：放在**第一屏最上面**，因为演示时客户第一个问题往往是
          "这是真实数据吗"。含糊其辞比不写更糟 —— 一旦被追问出一张真实单号，信任就没了。 */}
      {isDemo && <DemoBanner industry={industry} />}

      {/* AC11：缓存戳 + 刷新。刷新只是重新取数：缓存未过期且库无写入时服务端仍返回同一份（戳不变），这正是戳存在的原因 */}
      {stampView && (
        <div className="flex items-center justify-end gap-2 text-[12px] text-slate-500">
          <span data-testid="dashboard-cache-stamp" data-cached-at={stampView.cachedAt} data-ttl-ms={stampView.ttlMs}>{stampView.text}</span>
          <button type="button" className="btn-ghost btn-sm" data-testid="dashboard-refresh" disabled={refreshing} onClick={refreshAll}>
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>
      )}

      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard
          label="本月销售额"
          value={`¥${fmtMoney(s?.month?.amount, 0)}`}
          sub={
            s?.growth === null || s?.growth === undefined
              ? '暂无上月对比'
              : `环比 ${s.growth >= 0 ? '↑' : '↓'} ${Math.abs(s.growth)}%`
          }
          tone="brand"
        />
        <StatCard label="本月订单" value={fmtInt(s?.month?.orders)} sub={`出货 ${fmtInt(s?.month?.qty)} 件`} />
        <StatCard
          label="线上 GMV（本月）"
          value={`¥${fmtMoney(s?.omsMonth?.gmv, 0)}`}
          sub={`${fmtInt(s?.omsMonth?.orders)} 笔 · 待发货 ${fmtInt(s?.omsMonth?.pending)}`}
          tone="green"
        />
        <StatCard
          label="库存金额"
          value={`¥${fmtMoney(s?.inventory?.amount, 0)}`}
          sub={`${fmtInt(s?.inventory?.qty)} 件 / ${fmtInt(s?.inventory?.skus)} 个 SKU`}
        />
        <StatCard
          label="待回款"
          value={`¥${fmtMoney(s?.receivable?.unpaid, 0)}`}
          sub={`采购应付 ¥${fmtMoney(s?.payable?.amount, 0)}`}
          tone="amber"
        />
        <StatCard
          label="本月采购"
          value={`¥${fmtMoney(s?.purchaseMonth?.amount, 0)}`}
          sub={`${fmtInt(s?.purchaseMonth?.orders)} 笔采购订单`}
        />
      </div>

      {/* 待办 */}
      <Card>
        <SectionTitle
          title="待办事项"
          desc={`共 ${todoCount} 项需要处理，点击进入对应模块`}
          right={
            <Link to="/inventory/alerts" className="text-[12px] link">
              查看库存预警 →
            </Link>
          }
        />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <TodoBlock
            title="待发货订单"
            count={s?.alerts?.pending_delivery || 0}
            to="/sales/orders?status=confirmed"
            items={(todos?.pendingDelivery || []).slice(0, 4).map((x: any) => ({
              main: x.doc_no,
              sub: `${x.customer_name || '-'} · ¥${fmtMoney(x.receivable_amount, 0)}`
            }))}
            tone="amber"
          />
          <TodoBlock
            title="待收货采购"
            count={s?.alerts?.pending_receipt || 0}
            to="/purchase/orders"
            items={(todos?.pendingReceipt || []).slice(0, 4).map((x: any) => ({
              main: x.doc_no,
              sub: `${x.supplier_name} · ¥${fmtMoney(x.total_amount, 0)}`
            }))}
            tone="brand"
          />
          <TodoBlock
            title="线上待发货"
            count={s?.alerts?.oms_pending || 0}
            to="/oms/orders?status=pending"
            items={(todos?.omsPending || []).slice(0, 4).map((x: any) => ({
              main: x.platform_order_no,
              sub: `${x.platform_name} · ${x.sales_order_id ? '已转单' : '未转单'}`
            }))}
            tone="green"
          />
          <TodoBlock
            title="库存与效期预警"
            count={(s?.alerts?.below_safe || 0) + (s?.alerts?.expiring || 0)}
            to="/inventory/alerts"
            items={[
              { main: `低于安全库存 ${s?.alerts?.below_safe || 0} 个 SKU`, sub: '建议尽快补货' },
              { main: `90 天内临期 ${s?.alerts?.expiring || 0} 个批次`, sub: '建议促销或调拨' },
              { main: `信用额度预警 ${s?.alerts?.credit_alert || 0} ${showDealer ? '家经销商' : '家客户'}`, sub: '占用率超过 80%' }
            ]}
            tone="red"
          />
        </div>
      </Card>

      {/* 趋势 + 渠道 */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2">
          <SectionTitle title="近 30 天销售趋势" desc="线下（经销商+门店）与线上（平台+自营）合并口径" />
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend || []} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gOffline" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2568a6" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="#2568a6" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="gOnline" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#1d9e75" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="#1d9e75" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={(v) => String(v).slice(5)} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={(v) => (v >= 10000 ? `${(v / 10000).toFixed(0)}万` : v)} />
                <Tooltip
                  formatter={(v: any, n: any) => [`¥${fmtMoney(v, 0)}`, n === 'offline' ? '线下销售' : n === 'online' ? '线上销售' : '采购']}
                  labelStyle={{ fontSize: 12 }}
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
                />
                <Area type="monotone" dataKey="offline" stroke="#2568a6" strokeWidth={2} fill="url(#gOffline)" />
                <Area type="monotone" dataKey="online" stroke="#1d9e75" strokeWidth={2} fill="url(#gOnline)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-4 mt-1 text-[12px] text-slate-500">
            <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm bg-brand-600 inline-block" />线下销售</span>
            <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm bg-[#1d9e75] inline-block" />线上销售</span>
          </div>
        </Card>

        <Card>
          <SectionTitle title="渠道结构" desc="近 90 天各渠道销售额占比" />
          {channelData.length === 0 ? (
            <div className="text-center text-slate-400 text-[13px] py-16">暂无数据</div>
          ) : (
            <>
              <div style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={channelData} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={2}>
                      {channelData.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v: any) => `¥${fmtMoney(v, 0)}`} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-col gap-1.5 mt-2">
                {channelData.map((c, i) => {
                  const total = channelData.reduce((a, b) => a + b.value, 0)
                  return (
                    <div key={c.name} className="flex items-center gap-2 text-[12px]">
                      <i className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                      <span className="flex-1 text-slate-600 truncate">{c.name}</span>
                      <span className="text-slate-400 tabular-nums">{fmtPct((c.value / total) * 100, 1)}</span>
                      <span className="text-slate-700 tabular-nums w-20 text-right">¥{fmtMoney(c.value, 0)}</span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* 排行 + 最近单据 */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card>
          <SectionTitle title="商品销售排行" desc="近 30 天" />
          <div style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={(top?.products || []).slice(0, 8)} layout="vertical" margin={{ left: 8, right: 16 }}>
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="product_name"
                  width={110}
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: string) => (v.length > 8 ? v.slice(0, 8) + '…' : v)}
                />
                <Tooltip formatter={(v: any) => `¥${fmtMoney(v, 0)}`} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="amount" fill="#2568a6" radius={[0, 4, 4, 0]} barSize={14} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {showDealer && (
        <Card>
          <SectionTitle title="经销商排行" desc="近 30 天销售额" right={<Link className="text-[12px] link" to="/dealers">全部 →</Link>} />
          <div className="flex flex-col divide-y divide-slate-100">
            {(top?.dealers || []).slice(0, 6).map((d: any, i: number) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <span className={`w-5 h-5 rounded text-[11px] flex items-center justify-center ${i < 3 ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-slate-700 truncate">{d.name}</div>
                  <div className="text-[11px] text-slate-400">{d.orders} 笔订单</div>
                </div>
                <span className="text-[13px] text-slate-800 tabular-nums">¥{fmtMoney(d.amount, 0)}</span>
              </div>
            ))}
            {(top?.dealers || []).length === 0 && <div className="text-center text-slate-400 text-[13px] py-10">暂无数据</div>}
          </div>
        </Card>
        )}

        <Card>
          <SectionTitle title="最近单据" desc="实时业务流水" />
          <div className="flex flex-col divide-y divide-slate-100">
            {(recent?.salesOrders || []).slice(0, 5).map((o: any) => (
              <div key={o.doc_no} className="flex items-center gap-2 py-2">
                <span className="tag bg-brand-50 text-brand-700">销售</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-slate-700 truncate">{o.doc_no}</div>
                  <div className="text-[11px] text-slate-400 truncate">{o.customer_name}</div>
                </div>
                <div className="text-right">
                  <div className="text-[12px] text-slate-700 tabular-nums">¥{fmtMoney(o.receivable_amount, 0)}</div>
                  <Status value={o.status} />
                </div>
              </div>
            ))}
            {(recent?.omsOrders || []).slice(0, 4).map((o: any) => (
              <div key={o.platform_order_no} className="flex items-center gap-2 py-2">
                <span className="tag bg-teal-50 text-teal-700">线上</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-slate-700 truncate">{o.platform_order_no}</div>
                  <div className="text-[11px] text-slate-400 truncate">
                    {o.platform_name} · {o.buyer_nick}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[12px] text-slate-700 tabular-nums">¥{fmtMoney(o.pay_amount, 0)}</div>
                  <Status value={o.status} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* 演示指南：账号 + 手册入口。放在**页面最下方**（客户口径「放在首页的下方」）——
          演示时先讲业务、讲到"你自己试试"的时候再往下滚，不打断主线。 */}
      {isDemo && <DemoGuide showDealer={showDealer} industry={industry} />}
    </div>
  )
}

/** 演示账号（与 seed 里的用户一一对应；密码以 seed.js 为准，不在这里"发明"） */
const DEMO_ACCOUNTS = [
  { role: '系统管理员', user: 'admin', pwd: '12345', scope: '全部菜单 + 系统设置 + AI 与 MCP 控制台', dealerOnly: false },
  { role: '老板 / 总经理', user: 'boss', pwd: '123456', scope: '全部数据只读 + 关键审批（无系统设置）', dealerOnly: false },
  { role: '供应链主管', user: 'scm', pwd: '123456', scope: '采购 / 库存 / 生产 / 质检（销售与财务只读）', dealerOnly: false },
  { role: '门店店长', user: 'store01', pwd: '123456', scope: '本店 POS 收银 / 交班核款 / 库存 / 要货', dealerOnly: false },
  { role: '经销商', user: 'dealer01', pwd: '123456', scope: '订货中心 + 对账单（只看自己的数据）', dealerOnly: true },
  { role: '财务', user: 'finance', pwd: '123456', scope: '应收与收款核销 / 凭证 / 财务报表', dealerOnly: false },
  { role: '只读访客', user: 'viewer', pwd: '123456', scope: '只看不改，适合客户自己点着看', dealerOnly: false }
]

function DemoBanner({ industry }: { industry?: string | null }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-brand-200 bg-gradient-to-r from-brand-50 via-white to-tech-50 px-4 py-3">
      <div
        className="absolute inset-y-0 left-0 w-1.5"
        style={{ background: 'linear-gradient(180deg,#185fa5 0%,#06b6d4 100%)' }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-2">
        <span className="inline-flex items-center gap-1 rounded-md bg-brand-600 text-white text-[11px] px-2 py-0.5">
          <Sparkles size={12} /> DEMO 演示系统
        </span>
        <span className="text-[13px] text-ink-800">
          本系统为 <b>演示环境</b>：全部商品、客户、门店、单据均为程序生成的<b>虚构样例</b>，不含任何真实客户与商业数据。
        </span>
        <span className="text-[12px] text-ink-600">
          当前行业：<b>{industry === 'food' ? '连锁餐饮版' : industry === 'apparel' ? '服装版（开发中）' : '美妆连锁版'}</b>
        </span>
        <span className="text-[12px] text-ink-500">可以放心点、放心改；演示数据可通过 <code className="px-1 bg-white/70 rounded border border-ink-200 text-[11px]">npm run reseed</code> 重建。</span>
      </div>
    </div>
  )
}

function DemoGuide({ showDealer, industry }: { showDealer: boolean; industry?: string | null }) {
  const [copied, setCopied] = useState<string>('')
  const accounts = DEMO_ACCOUNTS.filter((a) => !a.dealerOnly || showDealer)

  const copy = async (a: { user: string; pwd: string }) => {
    try {
      await navigator.clipboard.writeText(`${a.user} / ${a.pwd}`)
      setCopied(a.user)
      setTimeout(() => setCopied(''), 1600)
    } catch {
      setCopied('')
    }
  }

  return (
    <Card>
      <SectionTitle
        title="演示账号与手册"
        desc="同一个系统，不同角色登进来看到的菜单与能做的事都不一样 —— 建议每个账号都登一次，对比着看"
      />
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_300px] gap-4">
        <div className="overflow-hidden border border-ink-200 rounded-lg">
          <table className="w-full text-[12.5px]">
            <thead className="bg-ink-50/70 text-ink-600">
              <tr>
                <th className="text-left font-normal px-3 py-2">角色</th>
                <th className="text-left font-normal px-2 py-2">账号</th>
                <th className="text-left font-normal px-2 py-2">密码</th>
                <th className="text-left font-normal px-3 py-2">登进来能看到什么</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {accounts.map((a) => (
                <tr key={a.user} className="hover:bg-brand-50/40">
                  <td className="px-3 py-2 text-ink-900 whitespace-nowrap">{a.role}</td>
                  <td className="px-2 py-2"><code className="px-1 py-0.5 rounded bg-ink-100 text-ink-800 text-[11.5px]">{a.user}</code></td>
                  <td className="px-2 py-2"><code className="px-1 py-0.5 rounded bg-ink-100 text-ink-800 text-[11.5px]">{a.pwd}</code></td>
                  <td className="px-3 py-2 text-ink-600">{a.scope}</td>
                  <td className="px-2 py-2 text-right">
                    <button onClick={() => copy(a)} className="text-[11.5px] text-brand-700 hover:underline whitespace-nowrap">
                      {copied === a.user ? '已复制' : '复制'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-3 py-2 text-[11.5px] text-ink-500 bg-ink-50/50 border-t border-ink-200">
            账号密码以 <code className="px-1 bg-white rounded border border-ink-200">server/db/seed.js</code> 为准（重建库会恢复成这里列的值）。
            {!showDealer && ' 连锁餐饮版没有经销商，所以不列经销商账号 —— 这是业务形态差异，不是权限没配。'}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <a
            href="/docs/demo-flow.html"
            target="_blank"
            rel="noreferrer"
            className="group block rounded-lg border border-brand-200 bg-gradient-to-br from-brand-600 to-brand-700 text-white px-3.5 py-3 hover:from-brand-700 hover:to-brand-800 transition-colors"
          >
            <div className="flex items-center gap-1.5 text-[13.5px] font-medium">
              <PlayCircle size={15} /> 完整演示手册
            </div>
            <div className="text-[11.5px] text-white/80 mt-1 leading-5">
              按角色排的演示剧本：先讲什么、后讲什么、每一步点哪里、要读出哪个数字。
            </div>
          </a>
          <a
            href="/docs/manual.html"
            target="_blank"
            rel="noreferrer"
            className="group block rounded-lg border border-tech-200 bg-gradient-to-br from-tech-500 to-tech-600 text-white px-3.5 py-3 hover:from-tech-600 hover:to-tech-700 transition-colors"
          >
            <div className="flex items-center gap-1.5 text-[13.5px] font-medium">
              <BookOpen size={15} /> 功能模块操作手册
            </div>
            <div className="text-[11.5px] text-white/85 mt-1 leading-5">
              按模块排：每个页面回答什么问题、字段什么含义、做完一步之后单据会变成什么状态。
            </div>
          </a>
          <div className="text-[11.5px] text-ink-500 leading-5 px-1">
            手册在该页新开一个窗口，左侧目录可以直接跳到对应章节 —— 演示时投屏给客户看也够用。
          </div>
        </div>
      </div>
    </Card>
  )
}

function TodoBlock({
  title,
  count,
  items,
  to,
  tone
}: {
  title: string
  count: number
  items: { main: string; sub: string }[]
  to: string
  tone: 'amber' | 'brand' | 'green' | 'red'
}) {
  const tones = {
    amber: 'text-amber-600 bg-amber-50',
    brand: 'text-brand-700 bg-brand-50',
    green: 'text-green-600 bg-green-50',
    red: 'text-red-600 bg-red-50'
  }
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-slate-50/70">
        <span className="text-[13px] text-slate-700">{title}</span>
        <span className={`tag ${tones[tone]}`}>{count}</span>
      </div>
      <div className="divide-y divide-slate-100">
        {items.length === 0 && <div className="px-3 py-4 text-[12px] text-slate-400">暂无待处理事项</div>}
        {items.map((it, i) => (
          <div key={i} className="px-3 py-2">
            <div className="text-[12px] text-slate-700 truncate">{it.main}</div>
            <div className="text-[11px] text-slate-400 truncate">{it.sub}</div>
          </div>
        ))}
      </div>
      <Link to={to} className="block text-center text-[12px] text-brand-700 hover:bg-brand-50 py-1.5 border-t border-slate-100">
        进入处理 →
      </Link>
    </div>
  )
}
