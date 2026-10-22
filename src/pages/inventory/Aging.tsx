/**
 * ============================================================================
 * 文件标识：src/pages/inventory/Aging.tsx ｜ 库存分析
 * ============================================================================
 * 【职责】库存分析（页面）
 * 【入口】/inventory/aging
 * 【主要接口】/inventory/aging、/inventory/sluggish、/inventory/abc
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
 * 页面：库存分析
 */

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Card, Table, useFetch, toast } from '../../components/ui'

const TABS = [
  { key: 'aging', label: '库龄分析' },
  { key: 'sluggish', label: '呆滞分析' },
  { key: 'abc', label: 'ABC 分类' }
]

const num = (v: any) => (v ?? 0).toLocaleString?.() ?? v

export default function Aging() {
  const [tab, setTab] = useState('aging')
  const aging = useFetch<any>('/inventory/aging', { pageSize: 100 })
  const sluggish = useFetch<any>('/inventory/sluggish', { days: 90 })
  const abc = useFetch<any>('/inventory/abc')

  const bucketColor: Record<string, string> = {
    b0: 'bg-emerald-50 text-emerald-700',
    b1: 'bg-lime-50 text-lime-700',
    b2: 'bg-amber-50 text-amber-700',
    b3: 'bg-orange-50 text-orange-700',
    b4: 'bg-red-50 text-red-700'
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="text-[17px] font-medium text-ink-900 title-serif">库存分析</h1>
          <p className="text-[12px] text-slate-400 mt-0.5">库龄分层 · 呆滞预警 · ABC 价值分类（用友库存分析口径）</p>
        </div>
        <button className="btn-ghost btn-sm" onClick={() => { aging.reload(); sluggish.reload(); abc.reload() }}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      <div className="flex items-center gap-1 mb-3">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`px-3 h-8 rounded-md text-[13px] ${tab === t.key ? 'bg-brand-600 text-white' : 'bg-white border border-ink-300 text-slate-600 hover:bg-slate-50'}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'aging' && (
        <>
          <div className="grid grid-cols-5 gap-3 mb-3">
            {(aging.data?.buckets || []).map((b: any) => (
              <Card key={b.bucket} pad className="relative overflow-hidden">
                <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: 'linear-gradient(#245b4a,#b58a4a)' }} />
                <div className={`text-[11px] px-1.5 py-0.5 rounded w-fit ${bucketColor[b.bucket] || ''}`}>{b.label}</div>
                <div className="text-[20px] font-medium text-ink-900 mt-1.5">{num(b.qty)}</div>
                <div className="text-[11px] text-slate-400 mt-0.5">金额 ¥{num(Math.round(b.amount))}</div>
              </Card>
            ))}
          </div>
          <Card pad={false}>
            <Table
              columns={[
                { key: 'age_days', title: '库龄(天)', width: 90, align: 'right', render: (r: any) => (
                  <span className={`font-medium ${r.age_days > 365 ? 'text-red-500' : r.age_days > 180 ? 'text-orange-500' : ''}`}>{r.age_days}</span>
                ) },
                { key: 'bucket', title: '库龄段', width: 100, render: (r: any) => (
                  <span className={`px-1.5 py-0.5 rounded text-[11px] ${bucketColor[r.bucket] || ''}`}>{aging.data?.bucketLabel?.[r.bucket] || r.bucket}</span>
                ) },
                { key: 'warehouse_name', title: '仓库', width: 150 },
                { key: 'product_name', title: '商品', render: (r: any) => `${r.product_name} ${r.sku_name || ''}` },
                { key: 'sku_code', title: 'SKU', width: 110, render: (r: any) => <span className="font-mono text-[11px]">{r.sku_code}</span> },
                { key: 'batch_no', title: '批次', width: 120, render: (r: any) => <span className="font-mono text-[11px]">{r.batch_no || '—'}</span> },
                { key: 'base_date', title: '入库日期', width: 100 },
                { key: 'qty_on_hand', title: '数量', width: 80, align: 'right', render: (r: any) => num(r.qty_on_hand) },
                { key: 'amount', title: '金额', width: 110, align: 'right', render: (r: any) => `¥${num(Math.round(r.amount))}` }
              ]}
              data={aging.data?.list || []}
              loading={aging.loading}
            />
          </Card>
        </>
      )}

      {tab === 'sluggish' && (
        <>
          <Card className="mb-3" pad>
            <div className="flex items-center gap-6 text-[13px]">
              <span className="text-slate-500">呆滞阈值：<b className="text-ink-900">90 天无出库</b></span>
              <span>滞销(90-180 天)：<b className="text-amber-600">{sluggish.data?.summary?.sluggish_90 ?? 0}</b> 个库存单元</span>
              <span>呆滞(180 天以上)：<b className="text-red-500">{sluggish.data?.summary?.dead_180 ?? 0}</b> 个</span>
              <span>涉及金额：<b className="text-ink-900">¥{num(Math.round(sluggish.data?.summary?.amount || 0))}</b></span>
            </div>
          </Card>
          <Card pad={false}>
            <Table
              columns={[
                { key: 'idle_days', title: '无出库天数', width: 100, align: 'right', render: (r: any) => (
                  <span className={`font-medium ${r.level === 'dead' ? 'text-red-500' : 'text-amber-600'}`}>{r.idle_days}</span>
                ) },
                { key: 'level', title: '等级', width: 80, align: 'center', render: (r: any) => (
                  <span className={`px-1.5 py-0.5 rounded text-[11px] ${r.level === 'dead' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'}`}>
                    {r.level === 'dead' ? '呆滞' : '滞销'}
                  </span>
                ) },
                { key: 'warehouse_name', title: '仓库', width: 150 },
                { key: 'product_name', title: '商品', render: (r: any) => `${r.product_name} ${r.sku_name || ''}` },
                { key: 'sku_code', title: 'SKU', width: 110, render: (r: any) => <span className="font-mono text-[11px]">{r.sku_code}</span> },
                { key: 'qty_on_hand', title: '结存数量', width: 90, align: 'right', render: (r: any) => num(r.qty_on_hand) },
                { key: 'amount', title: '结存金额', width: 110, align: 'right', render: (r: any) => `¥${num(Math.round(r.amount))}` },
                { key: 'last_out_date', title: '最后出库', width: 110, render: (r: any) => r.last_out_date || '从未出库' }
              ]}
              data={sluggish.data?.rows || []}
              loading={sluggish.loading}
            />
          </Card>
        </>
      )}

      {tab === 'abc' && (
        <>
          <div className="grid grid-cols-3 gap-3 mb-3">
            {[
              { c: 'A', color: 'text-brand-700', bg: 'bg-brand-50' },
              { c: 'B', color: 'text-amber-600', bg: 'bg-amber-50' },
              { c: 'C', color: 'text-slate-500', bg: 'bg-slate-100' }
            ].map(({ c, color, bg }) => {
              const s = (abc.data?.summary || []).find((x: any) => x.class === c)
              return (
                <Card key={c} pad className="relative overflow-hidden">
                  <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: 'linear-gradient(#245b4a,#b58a4a)' }} />
                  <div className="flex items-center gap-2">
                    <span className={`w-6 h-6 rounded-md ${bg} ${color} flex items-center justify-center text-[13px] font-medium`}>{c}</span>
                    <span className="text-[12px] text-slate-400">{c === 'A' ? '头部 80% 金额' : c === 'B' ? '80%-95%' : '尾部 5%'}</span>
                  </div>
                  <div className="text-[20px] font-medium text-ink-900 mt-1.5">{s?.count ?? 0} <span className="text-[12px] text-slate-400 font-normal">个 SKU</span></div>
                  <div className="text-[11px] text-slate-400 mt-0.5">库存金额 ¥{num(Math.round(s?.amount || 0))} · 占比 {s?.amount_pct ?? 0}%</div>
                </Card>
              )
            })}
          </div>
          <Card pad={false}>
            <Table
              columns={[
                { key: 'class', title: '分类', width: 70, align: 'center', render: (r: any) => (
                  <span className={`w-5 h-5 rounded inline-flex items-center justify-center text-[12px] font-medium ${
                    r.class === 'A' ? 'bg-brand-50 text-brand-700' : r.class === 'B' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-500'
                  }`}>{r.class}</span>
                ) },
                { key: 'sku_code', title: 'SKU', width: 110, render: (r: any) => <span className="font-mono text-[11px]">{r.sku_code}</span> },
                { key: 'product_name', title: '商品', render: (r: any) => `${r.product_name} ${r.sku_name || ''}` },
                { key: 'category_name', title: '品类', width: 100, render: (r: any) => r.category_name || '—' },
                { key: 'qty', title: '数量', width: 90, align: 'right', render: (r: any) => num(r.qty) },
                { key: 'amount', title: '库存金额', width: 110, align: 'right', render: (r: any) => `¥${num(Math.round(r.amount))}` },
                { key: 'cum_pct', title: '累计占比', width: 100, align: 'right', render: (r: any) => `${r.cum_pct}%` }
              ]}
              data={abc.data?.rows || []}
              loading={abc.loading}
            />
          </Card>
        </>
      )}
    </div>
  )
}
