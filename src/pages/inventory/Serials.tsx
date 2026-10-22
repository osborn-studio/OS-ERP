/**
 * ============================================================================
 * 文件标识：src/pages/inventory/Serials.tsx ｜ 序列号管理
 * ============================================================================
 * 【职责】序列号管理（页面）
 * 【入口】/inventory/serials
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
 * 页面：序列号管理
 */

import { useState } from 'react'
import { Search, RefreshCw, ScanSearch, Package } from 'lucide-react'
import api from '../../api/client'
import { Card, Modal, Table, Pagination, toast, useList } from '../../components/ui'
import { FilterBar, Inp, Sel } from '../../components/DataPage'
import { useOpts, useDict } from '../../hooks/opts'

const STATUS = [
  { value: 'in_stock', label: '在库' },
  { value: 'reserved', label: '已占用' },
  { value: 'shipped', label: '已出库' },
  { value: 'returned', label: '已退回' },
  { value: 'scrapped', label: '报废' }
]
const statusLabel = (s: string) => STATUS.find((x) => x.value === s)?.label || s
const statusColor = (s: string) =>
  s === 'in_stock' ? 'text-emerald-600 bg-emerald-50' : s === 'shipped' ? 'text-amber-600 bg-amber-50' : 'text-slate-500 bg-slate-100'

export default function Serials() {
  const o = useOpts()
  const { stockDocTypes } = useDict()
  const { list, total, loading, page, pageSize, setPage, filters, setFilters, reload, summary } = useList('/inventory/serials')
  const [keyword, setKeyword] = useState('')
  const [trace, setTrace] = useState<any>(null)
  const [traceLoading, setTraceLoading] = useState(false)

  const openTrace = async (sn: string) => {
    setTraceLoading(true)
    setTrace({ serial_no: sn })
    try {
      const res = await api.get(`/inventory/serials/trace/${sn}`)
      setTrace(res.data)
    } catch (e: any) {
      toast(e.message || '追溯失败', 'error')
      setTrace(null)
    } finally {
      setTraceLoading(false)
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="text-[17px] font-medium text-ink-900 title-serif">序列号管理</h1>
          <p className="text-[12px] text-slate-400 mt-0.5">单品一码 · 全链路追溯（入库 → 出库 → 持有人）</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-4 gap-3 mb-3">
          {[
            ['序列号总数', summary.total || 0],
            ['在库', summary.in_stock || 0],
            ['已出库', summary.shipped || 0],
            ['覆盖商品', '精华 / 香水 / 礼盒 / 套装']
          ].map(([l, v]) => (
            <Card key={String(l)} className="relative overflow-hidden" pad>
              <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: 'linear-gradient(#245b4a,#b58a4a)' }} />
              <div className="text-[12px] text-slate-400">{l}</div>
              <div className="text-[20px] font-medium text-ink-900 mt-1">{typeof v === 'number' ? v.toLocaleString() : v}</div>
            </Card>
          ))}
        </div>
      )}

      <FilterBar onReset={() => { setFilters({}); setKeyword('') }}>
        <Inp value={keyword} onChange={setKeyword} placeholder="序列号 / 条码 / SKU" w={210} />
        <Sel value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={STATUS} placeholder="全部状态" w={120} />
        <Sel value={filters.warehouse_id} onChange={(v) => setFilters({ ...filters, warehouse_id: v })} options={o.warehouses} placeholder="全部仓库" w={160} />
        <button className="btn-primary btn-sm" onClick={() => setFilters({ ...filters, keyword })}>
          <Search size={13} /> 查询
        </button>
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'serial_no', title: '序列号', width: 190, render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.serial_no}</span> },
            { key: 'product_name', title: '商品', render: (r: any) => (
              <div className="flex items-center gap-1.5">
                {r.serial_managed !== undefined && null}
                <span className="text-[12px]">{r.product_name}</span>
              </div>
            ) },
            { key: 'sku_code', title: 'SKU', width: 120, render: (r: any) => <span className="font-mono text-[11px] text-slate-500">{r.sku_code}</span> },
            { key: 'warehouse_name', title: '仓库 / 货位', width: 170, render: (r: any) => (
              <span className="text-[12px]">{r.warehouse_name || '—'}{r.location ? ` · ${r.location}` : ''}</span>
            ) },
            { key: 'batch_no', title: '批次', width: 130, render: (r: any) => <span className="font-mono text-[11px]">{r.batch_no || '—'}</span> },
            { key: 'status', title: '状态', width: 90, align: 'center', render: (r: any) => (
              <span className={`px-1.5 py-0.5 rounded text-[11px] ${statusColor(r.status)}`}>{statusLabel(r.status)}</span>
            ) },
            { key: 'entry_doc_no', title: '入库单', width: 120, render: (r: any) => <span className="font-mono text-[11px]">{r.entry_doc_no || '—'}</span> },
            { key: 'holder', title: '持有人', width: 150, render: (r: any) => r.holder || '—' },
            { key: 'exit_doc_no', title: '出库单', width: 120, render: (r: any) => <span className="font-mono text-[11px]">{r.exit_doc_no || '—'}</span> },
            {
              key: '__act', title: '操作', width: 90, render: (r: any) => (
                <button className="link text-[12px] inline-flex items-center gap-1" onClick={() => openTrace(r.serial_no)}>
                  <ScanSearch size={12} /> 追溯
                </button>
              )
            }
          ]}
          data={list}
          loading={loading}
          onRowClick={(r: any) => openTrace(r.serial_no)}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>

      <Modal open={!!trace} title={`序列号追溯 · ${trace?.serial?.serial_no || trace?.serial_no || ''}`} onClose={() => setTrace(null)} width={720}>
        {traceLoading && <div className="text-[13px] text-slate-400 py-6 text-center">追溯查询中…</div>}
        {trace?.serial && (
          <div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 mb-4 p-3 bg-paper rounded-lg border border-ink-300">
              {[
                ['商品', `${trace.serial.product_name} ${trace.serial.sku_name || ''}`],
                ['SKU 编码', trace.serial.sku_code],
                ['批次', trace.serial.batch_no || '—'],
                ['仓库 / 货位', `${trace.serial.warehouse_name || '—'}${trace.serial.location ? ' · ' + trace.serial.location : ''}`],
                ['当前状态', statusLabel(trace.serial.status)],
                ['持有人', trace.serial.holder || '—'],
                ['入库单 / 日期', `${trace.serial.entry_doc_no || '—'} / ${trace.serial.entry_date || '—'}`],
                ['出库单 / 日期', `${trace.serial.exit_doc_no || '—'} / ${trace.serial.exit_date || '—'}`]
              ].map(([l, v]) => (
                <div key={String(l)} className="flex text-[12px]">
                  <span className="text-slate-400 w-24 shrink-0">{l}</span>
                  <span className="text-ink-900">{v}</span>
                </div>
              ))}
            </div>
            <div className="text-[13px] font-medium text-ink-900 mb-2 flex items-center gap-1.5">
              <Package size={14} className="text-brand-700" /> 流转事件
            </div>
            {(trace.events || []).length ? (
              <Table
                columns={[
                  { key: 'stage', title: '环节', width: 70 },
                  { key: 'biz_date', title: '日期', width: 100 },
                  // 业务类型：先查字典文案（客户可新建/改名出入库类型），再退回服务端名字，最后裸码。
                  // 与台账页同一口径 —— 两处不一致会让同一个类型在两个页面显示成两个词。
                  { key: 'doc_type_name', title: '业务类型', width: 110, render: (r: any) => stockDocTypes.find((t) => t.value === r.doc_type)?.label || r.doc_type_name || r.doc_type },
                  { key: 'doc_no', title: '单据号', width: 130, render: (r: any) => <span className="font-mono text-[11px]">{r.doc_no}</span> },
                  { key: 'counterparty', title: '往来', width: 150, render: (r: any) => r.counterparty || '—' },
                  { key: 'operator', title: '经办', width: 80, render: (r: any) => r.operator || '—' },
                  { key: 'remark', title: '备注', render: (r: any) => r.remark || '—' }
                ]}
                data={trace.events}
                loading={false}
              />
            ) : (
              <div className="text-[12px] text-slate-400 py-3 text-center border border-dashed border-ink-300 rounded">暂无流转事件</div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
