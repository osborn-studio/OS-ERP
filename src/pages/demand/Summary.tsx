/**
 * ============================================================================
 * 文件标识：src/pages/demand/Summary.tsx ｜ 净需求汇总与分流
 * ============================================================================
 * 【职责】净需求汇总与分流（页面）
 * 【入口】/plan/summary
 * 【主要接口】/demand/dealer/summary、/demand/dealer/summary/to-orders
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
 * 页面：净需求汇总与分流
 */

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import api from '../../api/client'
import { Card, Field, Table, fmtInt, fmtMoney, toast } from '../../components/ui'
import { useOpts } from '../../hooks/opts'
import { Calculator, FileOutput, RefreshCw } from 'lucide-react'

type LineState = { checked: boolean; qty: number; route: string; supplier_id?: any }

const ROUTES = [
  { value: 'purchase', label: '外购（采购订单）' },
  { value: 'production', label: '自制（生产订单）' },
  { value: 'outsourcing', label: '委外（委外订单）' }
]

export default function Summary() {
  const o = useOpts()
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 8) + '01')
  const [endDate, setEndDate] = useState(() => new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10))
  const [warehouseId, setWarehouseId] = useState('')
  const [includePlans, setIncludePlans] = useState(true)
  const [includeRequests, setIncludeRequests] = useState(true)
  const [result, setResult] = useState<any>(null)
  const [lines, setLines] = useState<Record<number, LineState>>({})
  const [busy, setBusy] = useState(false)
  const [outResult, setOutResult] = useState<any>(null)
  const [params] = useSearchParams()

  const run = async () => {
    setBusy(true)
    setOutResult(null)
    try {
      const r: any = await api.post('/demand/dealer/summary', {
        startDate, endDate,
        warehouse_id: warehouseId ? Number(warehouseId) : undefined,
        include_plans: includePlans,
        include_requests: includeRequests
      })
      setResult(r.data)
      const next: Record<number, LineState> = {}
      for (const x of r.data.bySku || []) {
        next[x.sku_id] = { checked: x.net_requirement > 0, qty: x.net_requirement, route: x.suggest_route }
      }
      setLines(next)
      toast(`汇总完成：涉及 ${r.data.totals.sku_count} 个 SKU，净需求 ${r.data.totals.net_requirement}`)
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const setLine = (skuId: number, patch: Partial<LineState>) => setLines((s) => ({ ...s, [skuId]: { ...s[skuId], ...patch } }))

  // 支持 /plan/summary?auto=1 进入时自动汇总（演示与截图用）
  useEffect(() => {
    if (params.get('auto') === '1') run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chosen = useMemo(() => Object.entries(lines).filter(([, v]) => v.checked && Number(v.qty) > 0), [lines])

  const toOrders = async () => {
    if (!chosen.length) return toast('请勾选要生成的净需求行', 'error')
    const bad = chosen.filter(([, v]) => (v.route === 'purchase' || v.route === 'outsourcing') && !v.supplier_id)
    if (bad.length) return toast(`有 ${bad.length} 行未指定供应商/加工商`, 'error')
    setBusy(true)
    try {
      const r: any = await api.post('/demand/dealer/summary/to-orders', {
        period_start: startDate,
        period_end: endDate,
        warehouse_id: warehouseId ? Number(warehouseId) : undefined,
        lines: chosen.map(([skuId, v]) => ({ sku_id: Number(skuId), qty: v.qty, route: v.route, supplier_id: v.supplier_id })),
        outsource_supplier_id: chosen.find(([, v]) => v.route === 'outsourcing')?.[1].supplier_id
      })
      setOutResult(r.data)
      toast(`已生成订单（运行号 ${r.data.doc_no}）`)
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const bySku = result?.bySku || []

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">净需求汇总与分流</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">按时间段汇总经销商要货申请与计划 → 对比仓库实际可用库存（含在途）→ 得出净需求 → 分流生成采购 / 生产 / 委外订单</p>
        </div>
      </div>

      <Card className="mb-3">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 items-end">
          <Field label="汇总开始">
            <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="汇总结束">
            <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
          <Field label="库存对比仓">
            <select className="input" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">默认中心仓</option>
              {o.warehouses.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </select>
          </Field>
          <Field label="需求来源">
            <div className="flex items-center gap-3 h-9 text-[12px]">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={includeRequests} onChange={(e) => setIncludeRequests(e.target.checked)} /> 要货申请
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={includePlans} onChange={(e) => setIncludePlans(e.target.checked)} /> 要货计划
              </label>
            </div>
          </Field>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy} onClick={run}>
              <Calculator size={14} /> {busy ? '汇总中…' : '汇总计算'}
            </button>
            <button className="btn-ghost" onClick={() => { setResult(null); setOutResult(null) }}>
              <RefreshCw size={13} /> 清空
            </button>
          </div>
        </div>
      </Card>

      {result && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <div className="kpi"><div className="kpi-label">涉及 SKU</div><div className="kpi-value text-slate-800">{fmtInt(result.totals.sku_count)}</div></div>
            <div className="kpi"><div className="kpi-label">需求合计</div><div className="kpi-value text-slate-800">{fmtInt(result.totals.demand_qty)}</div></div>
            <div className="kpi"><div className="kpi-label">净需求合计</div><div className="kpi-value text-brand-700">{fmtInt(result.totals.net_requirement)}</div></div>
            <div className="kpi"><div className="kpi-label">库存对比仓</div><div className="kpi-value text-slate-800 text-[15px]">{result.warehouse?.name || '—'}</div><div className="kpi-sub">期间 {result.months?.join('、')}</div></div>
          </div>

          <Card pad={false} className="mb-3">
            <div className="px-3 py-2 flex items-center justify-between border-b border-ink-100">
              <span className="text-[13px] font-medium text-slate-700">净需求明细（已勾选 {chosen.length} 行）</span>
              <button className="btn-primary btn-sm" disabled={busy || !chosen.length} onClick={toOrders}>
                <FileOutput size={13} /> 生成订单
              </button>
            </div>
            <Table
              columns={[
                { key: '__chk', title: '选择', width: 56, render: (r: any) => (
                  <input type="checkbox" checked={!!lines[r.sku_id]?.checked}
                    onChange={(e) => setLine(r.sku_id, { checked: e.target.checked })} />
                ) },
                { key: 'sku_code', title: 'SKU', width: 110 },
                { key: 'product_name', title: '商品', width: 200, render: (r) => `${r.product_name} ${r.sku_name || ''}` },
                { key: 'req_qty', title: '申请量', width: 80, align: 'right', render: (r) => fmtInt(r.req_qty) },
                { key: 'plan_qty', title: '计划量', width: 80, align: 'right', render: (r) => fmtInt(r.plan_qty) },
                { key: 'demand_qty', title: '需求合计', width: 90, align: 'right', render: (r) => fmtInt(r.demand_qty) },
                { key: 'stock_available', title: '可用库存', width: 90, align: 'right', render: (r) => <span className={Number(r.stock_available) > 0 ? 'text-green-600' : 'text-slate-400'}>{fmtInt(r.stock_available)}</span> },
                { key: 'in_transit', title: '在途', width: 70, align: 'right', render: (r) => fmtInt(r.in_transit) },
                { key: 'net_requirement', title: '净需求', width: 90, align: 'right', render: (r) => <b className={Number(r.net_requirement) > 0 ? 'text-red-600' : 'text-slate-400'}>{fmtInt(r.net_requirement)}</b> },
                { key: '__qty', title: '安排数量', width: 100, render: (r: any) => (
                  <input className="input input-sm text-right" type="number" value={lines[r.sku_id]?.qty ?? 0}
                    onChange={(e) => setLine(r.sku_id, { qty: Number(e.target.value) })} />
                ) },
                { key: '__route', title: '去向', width: 150, render: (r: any) => (
                  <select className="input input-sm" value={lines[r.sku_id]?.route || 'purchase'}
                    onChange={(e) => setLine(r.sku_id, { route: e.target.value })}>
                    {ROUTES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                  </select>
                ) },
                { key: '__sup', title: '供应商 / 加工商', width: 180, render: (r: any) => {
                  const route = lines[r.sku_id]?.route
                  if (route === 'production') return <span className="text-slate-300">自制，无需供应商</span>
                  return (
                    <select className="input input-sm" value={lines[r.sku_id]?.supplier_id ?? ''}
                      onChange={(e) => setLine(r.sku_id, { supplier_id: e.target.value })}>
                      <option value="">请选择</option>
                      {o.suppliers.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  )
                } },
                { key: 'procurement_label', title: '主供货方式', width: 100, render: (r) => <span className="tag bg-slate-100 text-slate-600">{r.procurement_label}</span> }
              ]}
              data={bySku}
            />
            <div className="pb-3" />
          </Card>

          {outResult && (
            <Card className="mb-3">
              <div className="text-[13px] font-medium text-slate-700 mb-2">
                已生成订单 · 运行号 <span className="font-mono">{outResult.doc_no}</span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-[12px]">
                <div>
                  <div className="text-slate-400 mb-1">采购订单 {outResult.summary.purchase.length} 张</div>
                  {outResult.summary.purchase.map((x: any) => <div key={x.id} className="font-mono text-slate-600">{x.doc_no}（{x.lines} 行）</div>)}
                </div>
                <div>
                  <div className="text-slate-400 mb-1">生产订单 {outResult.summary.production.length} 张</div>
                  {outResult.summary.production.map((x: any) => <div key={x.id} className="font-mono text-slate-600">{x.doc_no}（{x.qty} 件）</div>)}
                </div>
                <div>
                  <div className="text-slate-400 mb-1">委外订单 {outResult.summary.outsourcing.length} 张</div>
                  {outResult.summary.outsourcing.map((x: any) => <div key={x.id} className="font-mono text-slate-600">{x.doc_no}（{x.lines} 行）</div>)}
                </div>
              </div>
              {outResult.skipped?.length > 0 && (
                <div className="mt-2 text-[12px] text-amber-600">跳过 {outResult.skipped.length} 行：{outResult.skipped.map((s: any) => s.reason).join('；')}</div>
              )}
            </Card>
          )}

          {result.byDealer?.length > 0 && (
            <Card pad={false}>
              <div className="px-3 py-2 text-[13px] font-medium text-slate-700 border-b border-ink-100">按经销商汇总（期间内要货申请）</div>
              <Table
                columns={[
                  { key: 'dealer_name', title: '经销商', width: 220 },
                  { key: 'region', title: '区域', width: 90 },
                  { key: 'level', title: '等级', width: 90 },
                  { key: 'req_count', title: '申请单数', width: 100, align: 'right' },
                  { key: 'req_qty', title: '要货数量', width: 110, align: 'right', render: (r) => fmtInt(r.req_qty) },
                  { key: 'req_amount', title: '要货金额', width: 130, align: 'right', render: (r) => `¥${fmtMoney(r.req_amount)}` }
                ]}
                data={result.byDealer}
              />
              <div className="pb-3" />
            </Card>
          )}
        </>
      )}

      {!result && (
        <Card>
          <div className="text-center text-[13px] text-slate-400 py-12">
            选择时间段后点击「汇总计算」，系统将汇总经销商要货申请与计划，对比仓库可用库存，给出净需求与分流建议
          </div>
        </Card>
      )}
    </div>
  )
}
