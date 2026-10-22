/**
 * ============================================================================
 * 文件标识：src/pages/inventory/Ledger.tsx ｜ 收发存台账
 * ============================================================================
 * 【职责】收发存台账（页面）
 * 【入口】/inventory/ledger
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
 * 页面：收发存台账
 */

import { useState } from 'react'
import { Card, SectionTitle, Status, fmtInt, toast, useFetch } from '../../components/ui'
import { DateRange, FilterBar, Sel } from '../../components/DataPage'
import { useDict, useOpts } from '../../hooks/opts'
import { Search } from 'lucide-react'

export default function Ledger() {
  const o = useOpts()
  const { stockDocTypes } = useDict()
  const [skuId, setSkuId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [range, setRange] = useState({ from: '', to: '' })
  const { data } = useFetch<any>(skuId ? '/inventory/ledger' : null, { sku_id: skuId, warehouse_id: warehouseId, startDate: range.from, endDate: range.to }, [skuId, warehouseId, range])

  return (
    <div>
      <div className="mb-3">
        <h1 className="title-serif text-[19px] font-medium text-ink-900">收发存台账</h1>
        <p className="text-[12px] text-ink-700 mt-0.5">按 SKU 维度追踪期初、入库、出库与结存，逐笔可回溯到单据</p>
      </div>

      <FilterBar
        onReset={() => {
          setSkuId('')
          setWarehouseId('')
          setRange({ from: '', to: '' })
        }}
      >
        <Sel value={skuId} onChange={setSkuId} options={o.skus} placeholder="请选择商品 SKU" w={330} />
        <Sel value={warehouseId} onChange={setWarehouseId} options={o.warehouses} placeholder="全部仓库" w={190} />
        <DateRange from={range.from} to={range.to} onFrom={(v) => setRange({ ...range, from: v })} onTo={(v) => setRange({ ...range, to: v })} />
      </FilterBar>

      {!skuId ? (
        <Card className="text-center py-16 text-slate-400">
          <Search size={22} className="mx-auto mb-2 text-slate-300" />
          请先选择商品 SKU 查看收发存台账
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            <div className="kpi">
              <span className="kpi-label">期初结存</span>
              <span className="kpi-value">{fmtInt(data?.opening)}</span>
              <span className="kpi-sub">{data?.period?.start} 前累计</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">本期入库</span>
              <span className="kpi-value text-brand-600">{fmtInt(data?.inQty)}</span>
              <span className="kpi-sub">采购入库 / 调拨入 / 退货入</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">本期出库</span>
              <span className="kpi-value text-amber-600">{fmtInt(data?.outQty)}</span>
              <span className="kpi-sub">销售出库 / 调拨出 / 采购退</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">期末结存</span>
              <span className="kpi-value">{fmtInt(data?.closing)}</span>
              <span className="kpi-sub">{data?.sku?.sku_code}</span>
            </div>
          </div>

          <Card pad={false}>
            <div className="px-4 pt-4">
              <SectionTitle title={data?.sku ? `${data.sku.product_name} · ${data.sku.name}` : '台账明细'} desc={`${data?.period?.start} ~ ${data?.period?.end}，单位：${data?.sku?.unit || '件'}`} />
            </div>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>日期</th>
                    <th style={{ width: 110 }}>业务类型</th>
                    <th style={{ width: 150 }}>单据号</th>
                    <th style={{ width: 80 }}>方向</th>
                    <th className="text-right" style={{ width: 90 }}>数量</th>
                    <th className="text-right" style={{ width: 100 }}>单位成本</th>
                    <th className="text-right" style={{ width: 110 }}>金额</th>
                    <th className="text-right" style={{ width: 100 }}>结存数量</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.detail || []).length === 0 && (
                    <tr>
                      <td colSpan={8} className="text-center py-8 text-slate-400">该期间无出入库记录</td>
                    </tr>
                  )}
                  {(data?.detail || []).map((x: any, i: number) => (
                    <tr key={i}>
                      <td>{x.biz_date}</td>
                      {/* 业务类型：**先查字典文案，再退回服务端给的名字，最后才是裸码**。
                          顺序为什么是这样：客户可以自己新建出入库类型（`/master/inv-txn-types`），
                          服务端的 `doc_type_name` 只认硬编码的 `DOC_TYPE_LABEL`，对新类型会返回**裸码**，
                          而裸码是"truthy"的 —— 写在前面会让 `||` 永远短路，新类型永远显示成
                          `REPAIR_OUT` 这种码，而用户给它起的中文名就在字典里躺着。
                          低版本后端（没有 `/meta/dict` 的 stock_doc_types 合并）也不会更差：
                          那时字典文案就是 `DOC_TYPE_LABEL`，两者一致。 */}
                      <td>{stockDocTypes.find((t) => t.value === x.doc_type)?.label || x.doc_type_name || x.doc_type}</td>
                      <td>{x.doc_no}</td>
                      <td>{x.direction === 'in' ? <span className="text-brand-600">入库</span> : <span className="text-amber-600">出库</span>}</td>
                      <td className="text-right tabular-nums">{fmtInt(x.qty)}</td>
                      <td className="text-right tabular-nums">¥{Number(x.unit_cost || 0).toFixed(2)}</td>
                      <td className="text-right tabular-nums">¥{Number(x.amount || 0).toFixed(2)}</td>
                      <td className="text-right tabular-nums">{fmtInt(x.balance_qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
