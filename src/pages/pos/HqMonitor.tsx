/**
 * ============================================================================
 * 文件标识：src/pages/pos/HqMonitor.tsx ｜ 线下门店·POS运营监控
 * ============================================================================
 * 【职责】线下门店·POS运营监控（页面）
 * 【入口】/store/monitor
 * 【主要接口】/pos/hq/overview、/pos/hq/daily-closes、/pos/hq/cash-inflight
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
 * 页面：线下门店·POS运营监控
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../../api/client'
import { Card, Status, toast } from '../../components/ui'
import { Store, Upload, TrendingUp, ExternalLink, Banknote, AlertTriangle, Wallet } from 'lucide-react'

const fmt = (n: number) => '¥' + Math.round(Number(n || 0)).toLocaleString()

const HANDLE_LABEL: Record<string, string> = {
  charge: '责任人承担',
  absorb: '公司承担',
  pending: '挂账待处理'
}

/** 总部视角：门店 POS 运营监控（日结上传 + 资金在途 + 长短款处理） */
export default function HqMonitor() {
  const [data, setData] = useState<any>(null)
  const [closes, setCloses] = useState<any[]>([])
  const [cash, setCash] = useState<any>(null)

  const load = () => {
    api.get('/pos/hq/overview').then((r: any) => setData(r.data || r)).catch(() => {})
    api.get('/pos/hq/daily-closes').then((r: any) => setCloses(r.data || r)).catch(() => {})
    api.get('/pos/hq/cash-inflight').then((r: any) => setCash(r.data || r)).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const t = data?.totals || { today_amount: 0, today_orders: 0, local_orders: 0, cash_to_drop: 0, cash_to_receive: 0, cash_variance_total: 0 }
  const pendingDrops = cash?.pending_drops || []
  const pendingVars = cash?.pending_variances || []
  const blocked = (data?.stores || []).filter((s: any) => s.daily_close_blocked)

  const settle = async (shiftId: number, handled: string) => {
    try {
      await api.post(`/pos/shifts/${shiftId}/settle-variance`, { handled })
      toast(handled === 'charge' ? '已落案：责任人承担' : '已落案：公司承担')
      load()
    } catch (e: any) {
      toast(e.message || '落案失败（此操作需要总部管理员权限）', 'error')
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="text-[17px] font-medium text-ink-900 title-serif">线下门店 · POS 运营监控</h1>
          <p className="text-[12px] text-slate-400 mt-0.5">
            总部为每家门店设立专属门店仓；门店零售先进本机单，日结时集中上传总部并扣减门店仓库存。
            <b>钱的去向另外一条链</b>：交班 → 核款（出长短款）→ 缴款 → 总部点收。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/pos/hq/orders" className="btn-ghost btn-sm">
            <ExternalLink size={13} /> 门店单据明细
          </Link>
          <a href="/pos" target="_blank" rel="noreferrer" className="btn-primary btn-sm">
            <Store size={14} /> 打开门店 POS
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        {[
          ['今日门店零售', fmt(t.today_amount), `${t.today_orders} 单`, TrendingUp],
          ['待日结上传', `${t.local_orders} 单`, '门店本机单', Upload],
          ['门店待缴现金', fmt(t.cash_to_drop), '已核款未缴', Banknote],
          ['长短款合计', fmt(t.cash_variance_total), '正长负短', AlertTriangle]
        ].map(([l, v, s, Icon]: any) => (
          <Card key={l} pad>
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[11px] text-slate-400">{l}</div>
                <div className="text-[20px] font-medium text-ink-900 mt-0.5 tabular-nums">{v}</div>
                <div className="text-[11px] text-slate-400 mt-0.5">{s}</div>
              </div>
              <Icon size={16} className="text-brand-700/40" />
            </div>
          </Card>
        ))}
      </div>

      {/* 资金在途：口径只有一处（服务端视图），这里不另算一遍 */}
      <Card className="mb-3">
        <div className="px-3 py-2 border-b border-ink-100 flex items-center justify-between">
          <span className="text-[12px] text-slate-500">
            资金在途（<b>已核款未缴</b> + <b>已缴未点收</b> + <b>待核款班次</b>）
          </span>
          <span className="text-[11px] text-slate-400">门店自结上限 {fmt(cash?.variance_limit ?? 500)}，超过必须总部处理</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] min-w-[880px]">
            <thead className="bg-paper text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">门店</th>
                <th className="px-3 py-2 text-right font-medium">待缴现金</th>
                <th className="px-3 py-2 text-right font-medium">在途缴款（待点收）</th>
                <th className="px-3 py-2 text-right font-medium">长短款合计</th>
                <th className="px-3 py-2 text-right font-medium">待核款班次</th>
                <th className="px-3 py-2 text-right font-medium">营业中班次</th>
                <th className="px-3 py-2 text-left font-medium">日结门禁</th>
              </tr>
            </thead>
            <tbody>
              {(data?.stores || []).map((s: any) => (
                <tr key={s.id} className="border-t border-ink-100">
                  <td className="px-3 py-2">
                    <div className="text-ink-900">{s.name}</div>
                    <div className="text-[11px] text-slate-400">{s.city} · {s.manager}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className={Number(s.cash_to_drop) > 0 ? 'text-amber-700 font-medium' : 'text-slate-400'}>{fmt(s.cash_to_drop)}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                    {fmt(s.cash_to_receive)}{Number(s.cash_to_receive_count || 0) > 0 ? `（${s.cash_to_receive_count} 单）` : ''}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${Math.abs(Number(s.cash_variance_total)) > 0.005 ? 'text-amber-700 font-medium' : 'text-slate-400'}`}>
                    {fmt(s.cash_variance_total)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className={Number(s.cash_pending_review) > 0 ? 'text-amber-700 font-medium' : 'text-slate-400'}>{s.cash_pending_review}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{s.cash_open_shifts}</td>
                  <td className="px-3 py-2 text-[11px]">
                    {s.daily_close_blocked
                      ? <span className="text-amber-700">{s.daily_close_block_reason || '有未核款班次'}</span>
                      : <span className="text-emerald-600">可日结</span>}
                  </td>
                </tr>
              ))}
              {!data?.stores?.length && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">暂无门店</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {blocked.length > 0 && (
          <div className="px-3 py-2 border-t border-ink-100 text-[11px] text-amber-700 bg-amber-50/60">
            有 {blocked.length} 家门店因为班次未核款被挡在日结之外 —— 未核款的现金在账上没有位置，所以系统不允许它进入日结。
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mb-3">
        {/* 待点收缴款 */}
        <Card>
          <div className="px-3 py-2 border-b border-ink-100 text-[12px] text-slate-500 flex items-center gap-1.5">
            <Wallet size={13} /> 待点收缴款单（{pendingDrops.length}）
          </div>
          {pendingDrops.map((d: any) => (
            <div key={d.id} className="px-3 py-2 border-b border-ink-100 text-[12px] flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-ink-900">{d.doc_no}</div>
                <div className="text-[11px] text-slate-400 truncate">
                  {d.store_name} · {d.drop_date} · {d.handed_by_name || '—'} 交 · {d.shift_count} 个班次
                </div>
              </div>
              <span className="tabular-nums font-medium text-brand-700">{fmt(d.amount)}</span>
              <button
                className="btn-ghost btn-sm"
                onClick={async () => {
                  try { await api.post(`/pos/cash-drops/${d.id}/receive`, {}); toast('已点收'); load() }
                  catch (e: any) { toast(e.message || '点收失败', 'error') }
                }}
              >
                点收
              </button>
            </div>
          ))}
          {!pendingDrops.length && <div className="px-3 py-6 text-center text-[12px] text-slate-400">没有待点收的缴款单</div>}
        </Card>

        {/* 待落案长短款 */}
        <Card>
          <div className="px-3 py-2 border-b border-ink-100 text-[12px] text-slate-500 flex items-center gap-1.5">
            <AlertTriangle size={13} /> 挂账待落案的长短款（{pendingVars.length}）
          </div>
          {pendingVars.map((v: any) => {
            const amt = Number(v.variance || 0)
            return (
              <div key={v.id} className="px-3 py-2 border-b border-ink-100 text-[12px]">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-ink-900">{v.doc_no}</div>
                    <div className="text-[11px] text-slate-400 truncate">
                      {v.store_name} · {v.biz_date} · {v.cashier_name || '—'}
                      {v.variance_note ? ` · ${v.variance_note}` : ''}
                    </div>
                  </div>
                  <span className={`tabular-nums font-medium ${amt > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                    {amt > 0 ? '长款 ' : '短款 '}{fmt(Math.abs(amt))}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <button className="btn-ghost btn-sm" onClick={() => settle(v.id, 'charge')}>责任人承担</button>
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => { if (confirm('由公司承担该差异？确认后不再属于责任人。')) settle(v.id, 'absorb') }}
                  >
                    公司承担
                  </button>
                  <span className="text-[11px] text-slate-400 ml-auto">{HANDLE_LABEL[v.variance_handled]}</span>
                </div>
              </div>
            )
          })}
          {!pendingVars.length && <div className="px-3 py-6 text-center text-[12px] text-slate-400">没有挂账的长短款</div>}
        </Card>
      </div>

      <Card className="mb-3">
        <div className="px-3 py-2 border-b border-ink-100 text-[12px] text-slate-500">门店 POS 状态</div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] min-w-[820px]">
            <thead className="bg-paper text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">门店</th>
                <th className="px-3 py-2 text-left font-medium">类型</th>
                <th className="px-3 py-2 text-left font-medium">绑定仓</th>
                <th className="px-3 py-2 text-right font-medium">今日销售</th>
                <th className="px-3 py-2 text-right font-medium">待上传</th>
                <th className="px-3 py-2 text-right font-medium">仓内 SKU</th>
                <th className="px-3 py-2 text-right font-medium">库存市值</th>
                <th className="px-3 py-2 text-left font-medium">最近日结</th>
              </tr>
            </thead>
            <tbody>
              {(data?.stores || []).map((s: any) => (
                <tr key={s.id} className="border-t border-ink-100">
                  <td className="px-3 py-2">
                    <div className="text-ink-900">{s.name}</div>
                    <div className="text-[11px] text-slate-400">{s.city} · {s.manager}</div>
                  </td>
                  <td className="px-3 py-2 text-slate-500">
                    {s.type === 'direct' ? '直营' : s.type === 'counter' ? '专柜' : '加盟'}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{s.warehouse_name || '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-brand-700">{fmt(s.pos_today_amount)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className={s.pos_local_orders > 0 ? 'text-amber-600 font-medium' : 'text-slate-400'}>
                      {s.pos_local_orders}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.stock_skus}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(s.stock_value)}</td>
                  <td className="px-3 py-2 text-[11px] text-slate-400">
                    {s.last_close ? `${s.last_close.biz_date} · ${fmt(s.last_close.net_amount)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <div className="px-3 py-2 border-b border-ink-100 text-[12px] text-slate-500 flex items-center justify-between">
          <span>门店日结批次（上传总部记录）</span>
          <span className="text-[11px] text-slate-400">
            现金口径：系统应收 / 实点 / 差异（差异 = 实点 − 系统应收）—— 日结时把这一天各班的现金口径一起落下来
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] min-w-[1120px]">
            <thead className="bg-paper text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">批次号</th>
                <th className="px-3 py-2 text-left font-medium">门店</th>
                <th className="px-3 py-2 text-left font-medium">业务日期</th>
                <th className="px-3 py-2 text-right font-medium">上传单数</th>
                <th className="px-3 py-2 text-right font-medium">销售额</th>
                <th className="px-3 py-2 text-right font-medium">退货</th>
                <th className="px-3 py-2 text-right font-medium">净额</th>
                <th className="px-3 py-2 text-right font-medium">系统应收现金</th>
                <th className="px-3 py-2 text-right font-medium">实点现金</th>
                <th className="px-3 py-2 text-right font-medium">现金差异</th>
                <th className="px-3 py-2 text-left font-medium">操作人</th>
                <th className="px-3 py-2 text-left font-medium">状态</th>
                <th className="px-3 py-2 text-left font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {closes.map((c) => (
                <tr key={c.id} className="border-t border-ink-100">
                  <td className="px-3 py-2 font-mono text-ink-900">{c.batch_no}</td>
                  <td className="px-3 py-2">{c.store_name}</td>
                  <td className="px-3 py-2 text-slate-500">{c.biz_date}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.uploaded_orders}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(c.sales_amount)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-400">{fmt(c.refund_amount)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-brand-700 font-medium">{fmt(c.net_amount)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmt(c.sys_cash)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmt(c.counted_cash)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${Math.abs(Number(c.cash_variance || 0)) > 0.005 ? 'text-amber-700 font-medium' : 'text-slate-400'}`}>
                    {fmt(c.cash_variance)}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{c.operator}</td>
                  {/* 状态列：`confirmed` 只在总部确认之后才出现 —— 本批之前这条边没有入口，
                      三库的日结单全部停在 `uploaded`。 */}
                  <td className="px-3 py-2">
                    <Status value={c.status} text={c.status === 'uploaded' ? '已上传' : c.status === 'confirmed' ? '总部已确认' : c.status} />
                  </td>
                  <td className="px-3 py-2">
                    {c.status === 'uploaded' && (
                      <button
                        className="link text-[12px]"
                        onClick={async () => {
                          try {
                            await api.post(`/pos/daily-closes/${c.id}/confirm`, {})
                            toast('日结已确认')
                            load()
                          } catch (e: any) {
                            toast(e.message || '确认失败', 'error')
                          }
                        }}
                      >
                        确认
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!closes.length && (
                <tr><td colSpan={13} className="px-3 py-8 text-center text-slate-400">暂无日结记录</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
