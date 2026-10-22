/**
 * ============================================================================
 * 文件标识：src/pages/inventory/Availability.tsx ｜ 可用量报表
 * ============================================================================
 * 【职责】可用量报表（页面）
 * 【入口】/inventory/availability
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
 * 页面：可用量报表
 */

import { useState } from 'react'
import { Search, RefreshCw } from 'lucide-react'
import { Card, Table, Pagination, useList } from '../../components/ui'
import { FilterBar, Inp, Sel } from '../../components/DataPage'
import { useOpts } from '../../hooks/opts'

export default function Availability() {
  const o = useOpts()
  const { list, total, loading, page, pageSize, setPage, filters, setFilters, reload } = useList('/inventory/availability')
  const [keyword, setKeyword] = useState('')

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="text-[17px] font-medium text-ink-900 title-serif">可用量报表</h1>
          <p className="text-[12px] text-slate-400 mt-0.5">用友口径 · 现存量 / 冻结量 / 预计入库（在途）/ 预计出库（待发货）/ 可用量</p>
        </div>
        <button className="btn-ghost btn-sm" onClick={() => reload()}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      <Card className="mb-3" pad>
        <div className="flex items-center gap-2 text-[13px]">
          <span className="px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 text-[11px] font-medium">计算口径</span>
          <span className="text-slate-600">
            可用量 = 现存量 − 冻结量 + 预计入库量<span className="text-slate-400">（在途调拨）</span> − 预计出库量
            <span className="text-slate-400">（已确认未发货订单）</span>
          </span>
        </div>
      </Card>

      <FilterBar onReset={() => { setFilters({}); setKeyword('') }}>
        <Inp value={keyword} onChange={setKeyword} placeholder="SKU / 商品名称" w={200} />
        <Sel value={filters.warehouse_id} onChange={(v) => setFilters({ ...filters, warehouse_id: v })} options={o.warehouses} placeholder="全部仓库" w={160} />
        <button className="btn-primary btn-sm" onClick={() => setFilters({ ...filters, keyword })}>
          <Search size={13} /> 查询
        </button>
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'warehouse_name', title: '仓库', width: 150 },
            { key: 'sku_code', title: 'SKU', width: 120, render: (r: any) => <span className="font-mono text-[11px]">{r.sku_code}</span> },
            { key: 'product_name', title: '商品', render: (r: any) => `${r.product_name} ${r.sku_name || ''}` },
            { key: 'qty_on_hand', title: '现存量', width: 90, align: 'right', render: (r: any) => r.qty_on_hand?.toLocaleString() },
            { key: 'qty_reserved', title: '冻结量', width: 90, align: 'right', render: (r: any) => (
              <span className={r.qty_reserved > 0 ? 'text-amber-600' : 'text-slate-300'}>{r.qty_reserved?.toLocaleString()}</span>
            ) },
            { key: 'qty_in_transit', title: '预计入库(在途)', width: 120, align: 'right', render: (r: any) => (
              <span className={r.qty_in_transit > 0 ? 'text-brand-700' : 'text-slate-300'}>+{r.qty_in_transit?.toLocaleString()}</span>
            ) },
            { key: 'qty_backorder', title: '预计出库(待发)', width: 120, align: 'right', render: (r: any) => (
              <span className={r.qty_backorder > 0 ? 'text-red-500' : 'text-slate-300'}>−{r.qty_backorder?.toLocaleString()}</span>
            ) },
            { key: 'qty_available', title: '可用量', width: 100, align: 'right', render: (r: any) => (
              <span className={`font-medium ${r.qty_available <= 0 ? 'text-red-500' : 'text-brand-700'}`}>{r.qty_available?.toLocaleString()}</span>
            ) }
          ]}
          data={list}
          loading={loading}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>
    </div>
  )
}
