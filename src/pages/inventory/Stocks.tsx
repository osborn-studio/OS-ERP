/**
 * ============================================================================
 * 文件标识：src/pages/inventory/Stocks.tsx ｜ 库存查询
 * ============================================================================
 * 【职责】库存查询（页面）
 * 【入口】/inventory/stocks
 * 【主要接口】/inventory/stats、/inventory/adjust
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
 * 页面：库存查询
 */

import { useState } from 'react'
import api from '../../api/client'
import { Card, Field, Modal, Pagination, StatCard, Status, Table, Tabs, fmtInt, fmtMoney, toast, useFetch, useList } from '../../components/ui'
import { FilterBar, Inp, Sel } from '../../components/DataPage'
import { useOpts } from '../../hooks/opts'
import { Boxes, RefreshCw } from 'lucide-react'

export default function Stocks() {
  const o = useOpts()
  const [keyword, setKeyword] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const { list, total, loading, page, pageSize, setPage, reload } = useList('/inventory/stocks', { pageSize: 20 })
  const { data: stats } = useFetch<any>('/inventory/stats')
  const [adj, setAdj] = useState<any>(null)
  const [adjForm, setAdjForm] = useState<any>({})
  const [saving, setSaving] = useState(false)

  const filtered = list.filter((r: any) => {
    if (warehouseId && String(r.warehouse_id) !== String(warehouseId)) return false
    if (keyword && !`${r.sku_code} ${r.sku_name} ${r.product_name} ${r.batch_no}`.toLowerCase().includes(keyword.toLowerCase())) return false
    return true
  })

  const adjust = async () => {
    setSaving(true)
    try {
      await api.post('/inventory/adjust', {
        warehouse_id: adj.warehouse_id,
        sku_id: adj.sku_id,
        batch_no: adj.batch_no || '',
        qty: Number(adjForm.qty),
        direction: adjForm.direction,
        reason: adjForm.reason,
        biz_date: adjForm.biz_date || new Date().toISOString().slice(0, 10)
      })
      toast('库存调整已过账')
      setAdj(null)
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">库存查询</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">按仓库 / 批次维度查看现货、占用与可用库存</p>
        </div>
        <button className="btn-ghost btn-sm" onClick={() => reload()}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="库存总量" value={fmtInt(stats?.total?.qty)} sub={`${fmtInt(stats?.total?.skus)} 个 SKU`} tone="brand" icon={<Boxes size={16} />} />
        <StatCard label="库存金额" value={`¥${fmtMoney(stats?.total?.amount, 0)}`} sub="按标准成本计价" />
        <StatCard label="近 30 天出库" value={fmtInt(stats?.outQty30)} sub="销售 + 调拨 + 退货出库" />
        <StatCard label="仓库数量" value={fmtInt(stats?.byWarehouse?.length)} sub="含电商仓与门店仓" />
      </div>

      <FilterBar onReset={() => { setKeyword(''); setWarehouseId('') }}>
        <Inp value={keyword} onChange={setKeyword} placeholder="SKU 编码 / 商品名 / 批次号" w={240} />
        <Sel value={warehouseId} onChange={setWarehouseId} options={o.warehouses} placeholder="全部仓库" w={190} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'sku_code', title: 'SKU 编码', width: 120 },
            { key: 'sku_name', title: '商品', width: 210 },
            { key: 'brand_name', title: '品牌', width: 130 },
            { key: 'warehouse_name', title: '仓库', width: 150 },
            { key: 'location', title: '货位', width: 90, render: (r: any) => <span className="font-mono text-[11px]">{r.location || '—'}</span> },
            { key: 'batch_no', title: '批次号', width: 140 },
            { key: 'expire_date', title: '到期日', width: 110 },
            {
              key: 'qty_on_hand',
              title: '现存量',
              width: 90,
              align: 'right',
              render: (r: any) => <span className={r.qty_on_hand <= r.safe_stock ? 'text-amber-600 font-medium' : ''}>{fmtInt(r.qty_on_hand)}</span>
            },
            { key: 'qty_reserved', title: '占用量', width: 80, align: 'right', render: (r) => fmtInt(r.qty_reserved) },
            { key: 'qty_available', title: '可用量', width: 90, align: 'right', render: (r) => <span className="font-medium text-brand-600">{fmtInt(r.qty_available)}</span> },
            { key: 'safe_stock', title: '安全库存', width: 90, align: 'right', render: (r) => fmtInt(r.safe_stock) },
            { key: 'cost_price', title: '成本单价', width: 100, align: 'right', render: (r) => `¥${fmtMoney(r.cost_price)}` },
            { key: 'amount', title: '库存金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.amount)}` },
            {
              key: '__act',
              title: '操作',
              width: 90,
              render: (r) => (
                <button
                  className="link text-[12px]"
                  onClick={() => {
                    setAdj(r)
                    setAdjForm({ direction: 'in', qty: 1, reason: '盘盈调整', biz_date: new Date().toISOString().slice(0, 10) })
                  }}
                >
                  调整
                </button>
              )
            }
          ]}
          data={filtered}
          loading={loading}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>

      <Modal
        open={!!adj}
        title={`库存调整 · ${adj?.sku_name || ''}`}
        width={560}
        onClose={() => setAdj(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setAdj(null)}>取消</button>
            <button className="btn-primary" disabled={saving} onClick={adjust}>{saving ? '过账中…' : '确认过账'}</button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="仓库">
            <div className="input bg-ink-100 text-ink-700 flex items-center">{adj?.warehouse_name}</div>
          </Field>
          <Field label="批次号">
            <div className="input bg-ink-100 text-ink-700 flex items-center">{adj?.batch_no || '—'}</div>
          </Field>
          <Field label="当前现存量">
            <div className="input bg-ink-100 text-ink-700 flex items-center">{fmtInt(adj?.qty_on_hand)}</div>
          </Field>
          <Field label="调整方向" required>
            <select className="input" value={adjForm.direction} onChange={(e) => setAdjForm({ ...adjForm, direction: e.target.value })}>
              <option value="in">盘盈（入库）</option>
              <option value="out">盘亏（出库）</option>
            </select>
          </Field>
          <Field label="调整数量" required>
            <input className="input" type="number" value={adjForm.qty ?? ''} onChange={(e) => setAdjForm({ ...adjForm, qty: e.target.value })} />
          </Field>
          <Field label="业务日期">
            <input className="input" type="date" value={adjForm.biz_date ?? ''} onChange={(e) => setAdjForm({ ...adjForm, biz_date: e.target.value })} />
          </Field>
          <Field label="调整原因" span={2}>
            <input className="input" value={adjForm.reason ?? ''} onChange={(e) => setAdjForm({ ...adjForm, reason: e.target.value })} />
          </Field>
        </div>
        <p className="text-[12px] text-ink-700 mt-3">说明：调整会写入库存流水（盘盈/盘亏），并同步更新现存量与库存金额。</p>
      </Modal>
    </div>
  )
}
