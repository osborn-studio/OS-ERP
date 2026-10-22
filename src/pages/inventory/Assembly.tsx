/**
 * ============================================================================
 * 文件标识：src/pages/inventory/Assembly.tsx ｜ 组装/拆卸单
 * ============================================================================
 * 【职责】组装/拆卸单（页面）
 * 【入口】/inventory/assembly
 * 【主要接口】/inventory/assembly
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
 * 页面：组装/拆卸单
 */

import { useState } from 'react'
import { Plus, RefreshCw, Package, Boxes } from 'lucide-react'
import api from '../../api/client'
import { Card, Field, Modal, Table, Pagination, toast, useList } from '../../components/ui'
import { FilterBar, Sel, Inp } from '../../components/DataPage'
import { useOpts } from '../../hooks/opts'

const TYPE_LABEL: Record<string, string> = { assemble: '组装', disassemble: '拆卸' }
// 状态文案：`cancelled` 是内核 `AS` 已登记的终态（原来渲染成「待过账」，与事实不符）。
const STATUS_LABEL: Record<string, string> = { draft: '待过账', confirmed: '已过账', cancelled: '已作废' }

export default function Assembly() {
  const o = useOpts()
  const { list, total, loading, page, pageSize, setPage, filters, setFilters, reload } = useList('/inventory/assembly')
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<any>({ type: 'assemble', qty: 10, biz_date: new Date().toISOString().slice(0, 10) })

  const submit = async () => {
    if (!form.bundle_id || !form.warehouse_id) return toast('请选择组合装与仓库', 'error')
    setSaving(true)
    try {
      await api.post('/inventory/assembly', { ...form, qty: Number(form.qty) })
      toast('组装单已创建（待过账）')
      setOpen(false)
      reload()
    } catch (e: any) {
      toast(e.message || '创建失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const confirmPost = async (row: any) => {
    if (!confirm(`确认过账「${row.doc_no}」？过账后将执行库存移动${row.type === 'assemble' ? '（组件出库 → 成品入库' + '）' : '（成品出库 → 组件入库）'}`)) return
    try {
      await api.post(`/inventory/assembly/${row.id}/confirm`)
      toast('过账完成，库存已更新')
      reload()
    } catch (e: any) {
      toast(e.message || '过账失败', 'error')
    }
  }

  const openDetail = async (id: number) => {
    const res = await api.get(`/inventory/assembly/${id}`)
    setDetail(res.data)
  }

  // 作废组装/拆卸单：只在草稿（还没执行、还没动库存）时可用 —— 作废不动库存。
  const cancelOrder = async (row: any) => {
    if (!confirm(`确认作废「${row.doc_no}」？作废后不会再执行库存移动。`)) return
    try {
      await api.post(`/inventory/assembly/${row.id}/cancel`)
      toast('单据已作废')
      reload()
    } catch (e: any) {
      toast(e.message || '作废失败', 'error')
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="text-[17px] font-medium text-ink-900 title-serif">组装 / 拆卸单</h1>
          <p className="text-[12px] text-slate-400 mt-0.5">组合包装（礼盒 / 套装）的组装入库与拆零还原 · 用友组装拆卸业务</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-primary btn-sm" onClick={() => setOpen(true)}>
            <Plus size={14} /> 新建组装单
          </button>
        </div>
      </div>

      <FilterBar onReset={() => setFilters({})}>
        <Sel value={filters.type} onChange={(v) => setFilters({ ...filters, type: v })} options={[
          { value: 'assemble', label: '组装' }, { value: 'disassemble', label: '拆卸' }
        ]} placeholder="全部类型" w={110} />
        <Sel value={filters.warehouse_id} onChange={(v) => setFilters({ ...filters, warehouse_id: v })} options={o.warehouses} placeholder="全部仓库" w={150} />
        <Sel value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={[
          { value: 'draft', label: '待过账' }, { value: 'confirmed', label: '已过账' }, { value: 'cancelled', label: '已作废' }
        ]} placeholder="全部状态" w={110} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '单据号', width: 130, render: (r: any) => <span className="font-mono text-[11px]">{r.doc_no}</span> },
            { key: 'type', title: '类型', width: 80, align: 'center', render: (r: any) => (
              <span className={`px-1.5 py-0.5 rounded text-[11px] ${r.type === 'assemble' ? 'bg-brand-50 text-brand-700' : 'bg-amber-50 text-amber-600'}`}>
                {TYPE_LABEL[r.type]}
              </span>
            ) },
            { key: 'bundle_name', title: '组合装', render: (r: any) => `${r.bundle_code} · ${r.bundle_name}` },
            { key: 'warehouse_name', title: '仓库', width: 140 },
            { key: 'biz_date', title: '业务日期', width: 100 },
            { key: 'qty', title: '数量', width: 70, align: 'right' },
            { key: 'total_cost', title: '成本合计', width: 110, align: 'right', render: (r: any) => r.total_cost ? `¥${r.total_cost.toLocaleString()}` : '—' },
            { key: 'status', title: '状态', width: 90, align: 'center', render: (r: any) => (
              <span className={`px-1.5 py-0.5 rounded text-[11px] ${r.status === 'confirmed' ? 'bg-emerald-50 text-emerald-600' : r.status === 'cancelled' ? 'bg-slate-100 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                {STATUS_LABEL[r.status] || r.status}
              </span>
            ) },
            {
              key: '__act', title: '操作', width: 180, render: (r: any) => (
                <div className="flex items-center gap-2 text-[12px]" onClick={(e) => e.stopPropagation()}>
                  <button className="link" onClick={() => openDetail(r.id)}>明细</button>
                  {r.status === 'draft' && (
                    <button className="text-brand-700 font-medium" onClick={() => confirmPost(r)}>过账</button>
                  )}
                  {/* 作废只在草稿可见：内核 `AS.cancel` 的唯一来源态就是 draft */}
                  {r.status === 'draft' && (
                    <button className="text-rose-600" onClick={() => cancelOrder(r)}>作废</button>
                  )}
                </div>
              )
            }
          ]}
          data={list}
          loading={loading}
          onRowClick={(r: any) => openDetail(r.id)}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>

      <Modal open={open} title="新建组装 / 拆卸单" onClose={() => setOpen(false)} width={560}
        footer={<>
          <button className="btn-ghost" onClick={() => setOpen(false)}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '保存中…' : '创建'}</button>
        </>}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Field label="业务类型" required>
            <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="assemble">组装（组件 → 成品）</option>
              <option value="disassemble">拆卸（成品 → 组件）</option>
            </select>
          </Field>
          <Field label="组合装" required>
            <select className="input" value={form.bundle_id ?? ''} onChange={(e) => setForm({ ...form, bundle_id: e.target.value })}>
              <option value="">请选择</option>
              {(o.bundles || []).map((b: any) => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </Field>
          <Field label="仓库" required>
            <select className="input" value={form.warehouse_id ?? ''} onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}>
              <option value="">请选择</option>
              {o.warehouses.map((w: any) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </select>
          </Field>
          <Field label="数量" required>
            <input className="input" type="number" min={1} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
          </Field>
          <Field label="业务日期" required>
            <input className="input" type="date" value={form.biz_date} onChange={(e) => setForm({ ...form, biz_date: e.target.value })} />
          </Field>
          <Field label="备注" span={2}>
            <input className="input" value={form.remark ?? ''} placeholder="选填" onChange={(e) => setForm({ ...form, remark: e.target.value })} />
          </Field>
        </div>
        <div className="mt-3 p-2.5 bg-paper border border-ink-300 rounded-md text-[12px] text-slate-500 leading-5">
          过账规则：组装 = 按 BOM 领组件出库（批次先进先出）→ 成品入库并生成新批次；成品启用序列号管理时逐件赋码。拆卸为反向操作。
        </div>
      </Modal>

      <Modal open={!!detail} title={detail ? `组装单明细 · ${detail.doc_no}` : ''} onClose={() => setDetail(null)} width={680}>
        {detail && (
          <div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 mb-4 p-3 bg-paper rounded-lg border border-ink-300 text-[12px]">
              {[['组合装', `${detail.bundle_code} · ${detail.bundle_name}`], ['类型', TYPE_LABEL[detail.type]],
                ['仓库', detail.warehouse_name], ['数量', detail.qty],
                ['成本合计', detail.total_cost ? `¥${detail.total_cost.toLocaleString()}` : '—'], ['状态', STATUS_LABEL[detail.status] || detail.status]].map(([l, v]) => (
                <div key={String(l)} className="flex"><span className="text-slate-400 w-20 shrink-0">{l}</span><span className="text-ink-900">{v}</span></div>
              ))}
            </div>
            <Table
              columns={[
                { key: 'role', title: '角色', width: 80, render: (r: any) => (
                  <span className={`text-[12px] ${r.role === 'parent' ? 'text-brand-700 font-medium' : 'text-slate-500'}`}>{r.role === 'parent' ? '成品' : '组件'}</span>
                ) },
                { key: 'sku_code', title: 'SKU', width: 110, render: (r: any) => <span className="font-mono text-[11px]">{r.sku_code}</span> },
                { key: 'product_name', title: '商品', render: (r: any) => `${r.product_name} ${r.sku_name || ''}` },
                { key: 'batch_no', title: '批次', width: 130, render: (r: any) => <span className="font-mono text-[11px]">{r.batch_no || '过账时生成'}</span> },
                { key: 'qty', title: '数量', width: 80, align: 'right' },
                { key: 'amount', title: '金额', width: 100, align: 'right', render: (r: any) => r.amount ? `¥${r.amount.toLocaleString()}` : '—' }
              ]}
              data={detail.items || []}
              loading={false}
            />
          </div>
        )}
      </Modal>
    </div>
  )
}
