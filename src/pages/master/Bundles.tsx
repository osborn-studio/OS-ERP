/**
 * ============================================================================
 * 文件标识：src/pages/master/Bundles.tsx ｜ 组合装档案
 * ============================================================================
 * 【职责】组合装档案（页面）
 * 【入口】/master/bundles
 * 【主要接口】/master/bundles
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
 * 页面：组合装档案
 */

import { useState } from 'react'
import { Plus, RefreshCw, Gift, Layers, Tag } from 'lucide-react'
import api from '../../api/client'
import { Card, Field, Modal, Table, Pagination, toast, useList } from '../../components/ui'
import { FilterBar, Inp, Sel } from '../../components/DataPage'
import { useOpts } from '../../hooks/opts'

const TYPE_LABEL: Record<string, string> = { giftbox: '礼盒', set: '套装', promo: '促销装' }
const TYPE_COLOR: Record<string, string> = { giftbox: 'bg-brand-50 text-brand-700', set: 'bg-amber-50 text-amber-600', promo: 'bg-red-50 text-red-500' }

export default function Bundles() {
  const o = useOpts()
  const { list, total, loading, page, pageSize, setPage, filters, setFilters, reload } = useList('/master/bundles')
  const [keyword, setKeyword] = useState('')
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<any>({ type: 'giftbox', components: [{ component_sku_id: '', qty: 1 }] })

  const addComp = () => setForm({ ...form, components: [...form.components, { component_sku_id: '', qty: 1 }] })
  const setComp = (i: number, patch: any) => {
    const cs = form.components.map((c: any, idx: number) => (idx === i ? { ...c, ...patch } : c))
    setForm({ ...form, components: cs })
  }

  const submit = async () => {
    if (!form.name) return toast('请填写组合装名称', 'error')
    const comps = (form.components || []).filter((c: any) => c.component_sku_id && Number(c.qty) > 0)
    if (!comps.length) return toast('请至少配置一个有效组件', 'error')
    setSaving(true)
    try {
      const sku = o.skus.find((s: any) => String(s.value) === String(form.parent_sku_id))
      await api.post('/master/bundles', {
        ...form,
        parent_sku_id: form.parent_sku_id || null,
        components: comps.map((c: any) => ({
          component_sku_id: c.component_sku_id,
          qty: Number(c.qty),
          cost_std: o.skus.find((s: any) => String(s.value) === String(c.component_sku_id))?.cost_std || 0
        }))
      })
      toast('组合装已创建')
      setOpen(false)
      setForm({ type: 'giftbox', components: [{ component_sku_id: '', qty: 1 }] })
      reload()
    } catch (e: any) {
      toast(e.message || '创建失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const openDetail = async (id: number) => {
    const res = await api.get(`/master/bundles/${id}`)
    setDetail(res.data)
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="text-[17px] font-medium text-ink-900 title-serif">组合装档案</h1>
          <p className="text-[12px] text-slate-400 mt-0.5">礼盒 / 套装 / 促销装的 BOM 定义，支持组装入库与线上虚拟组合</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-primary btn-sm" onClick={() => setOpen(true)}>
            <Plus size={14} /> 新建组合装
          </button>
        </div>
      </div>

      <FilterBar onReset={() => { setFilters({}); setKeyword('') }}>
        <Inp value={keyword} onChange={setKeyword} placeholder="编码 / 名称" w={180} />
        <Sel value={filters.type} onChange={(v) => setFilters({ ...filters, type: v })} options={[
          { value: 'giftbox', label: '礼盒' }, { value: 'set', label: '套装' }, { value: 'promo', label: '促销装' }
        ]} placeholder="全部类型" w={110} />
        <button className="btn-primary btn-sm" onClick={() => setFilters({ ...filters, keyword })}>查询</button>
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'code', title: '编码', width: 90, render: (r: any) => <span className="font-mono text-[11px]">{r.code}</span> },
            { key: 'name', title: '组合装名称', render: (r: any) => (
              <span className="flex items-center gap-1.5 text-[13px]">
                {r.type === 'giftbox' ? <Gift size={13} className="text-brand-700" /> : r.type === 'set' ? <Layers size={13} className="text-amber-600" /> : <Tag size={13} className="text-red-500" />}
                {r.name}
              </span>
            ) },
            { key: 'type', title: '类型', width: 80, align: 'center', render: (r: any) => (
              <span className={`px-1.5 py-0.5 rounded text-[11px] ${TYPE_COLOR[r.type]}`}>{TYPE_LABEL[r.type] || r.type}</span>
            ) },
            { key: 'parent_sku_name', title: '成品 SKU', width: 180, render: (r: any) => r.parent_sku_name || <span className="text-slate-300">虚拟组合（无库存）</span> },
            { key: 'component_count', title: '组件数', width: 80, align: 'right' },
            { key: 'bom_cost', title: 'BOM 成本', width: 110, align: 'right', render: (r: any) => `¥${Math.round(r.bom_cost || 0).toLocaleString()}` },
            { key: 'price_retail', title: '零售价', width: 100, align: 'right', render: (r: any) => `¥${r.price_retail?.toLocaleString()}` },
            { key: 'price_dealer', title: '经销价', width: 100, align: 'right', render: (r: any) => `¥${r.price_dealer?.toLocaleString()}` },
            { key: 'stock_qty', title: '成品库存', width: 90, align: 'right', render: (r: any) => r.parent_sku_id ? (r.stock_qty || 0) : '—' },
            { key: '__act', title: '操作', width: 70, render: (r: any) => (
              <button className="link text-[12px]" onClick={(e) => { e.stopPropagation(); openDetail(r.id) }}>BOM</button>
            ) }
          ]}
          data={list}
          loading={loading}
          onRowClick={(r: any) => openDetail(r.id)}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>

      <Modal open={open} title="新建组合装" onClose={() => setOpen(false)} width={640}
        footer={<>
          <button className="btn-ghost" onClick={() => setOpen(false)}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '保存中…' : '保存'}</button>
        </>}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Field label="名称" required>
            <input className="input" value={form.name ?? ''} placeholder="如：焕活新春臻选礼盒" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="类型">
            <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="giftbox">礼盒（组装入库，独立库存）</option>
              <option value="set">套装（组装入库）</option>
              <option value="promo">促销装（线上虚拟组合，不产生库存）</option>
            </select>
          </Field>
          <Field label="成品 SKU" hint={form.type === 'promo' ? '促销装无需成品 SKU' : '组装过账后成品入库到此 SKU'}>
            <select className="input" value={form.parent_sku_id ?? ''} onChange={(e) => setForm({ ...form, parent_sku_id: e.target.value })}>
              <option value="">（虚拟组合）</option>
              {o.skus.map((s: any) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="零售价">
            <input className="input" type="number" value={form.price_retail ?? ''} onChange={(e) => setForm({ ...form, price_retail: e.target.value })} />
          </Field>
        </div>
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[13px] font-medium text-ink-900">组件 BOM</div>
            <button className="btn-ghost btn-sm" onClick={addComp}><Plus size={12} /> 加组件</button>
          </div>
          <div className="space-y-2">
            {(form.components || []).map((c: any, i: number) => (
              <div key={i} className="flex items-center gap-2">
                <select className="input flex-1" value={c.component_sku_id} onChange={(e) => setComp(i, { component_sku_id: e.target.value })}>
                  <option value="">选择组件 SKU</option>
                  {o.skus.map((s: any) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                <input className="input w-24" type="number" min={1} value={c.qty} onChange={(e) => setComp(i, { qty: e.target.value })} placeholder="数量" />
                <button className="text-slate-400 hover:text-red-500" onClick={() => setForm({ ...form, components: form.components.filter((_: any, idx: number) => idx !== i) })}>✕</button>
              </div>
            ))}
          </div>
        </div>
      </Modal>

      <Modal open={!!detail} title={detail ? `组合装 BOM · ${detail.name}` : ''} onClose={() => setDetail(null)} width={680}>
        {detail && (
          <div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 mb-4 p-3 bg-paper rounded-lg border border-ink-300 text-[12px]">
              {[['编码', detail.code], ['类型', TYPE_LABEL[detail.type] || detail.type],
                ['成品 SKU', detail.parent_sku_name || '虚拟组合（不产生独立库存）'], ['零售价', `¥${detail.price_retail?.toLocaleString()}`],
                ['BOM 成本', `¥${Math.round(detail.bom_cost ?? (detail.cost_std || 0)).toLocaleString()}`], ['备注', detail.remark || '—']].map(([l, v]) => (
                <div key={String(l)} className="flex"><span className="text-slate-400 w-20 shrink-0">{l}</span><span className="text-ink-900">{v}</span></div>
              ))}
            </div>
            <div className="text-[13px] font-medium text-ink-900 mb-2">组件清单</div>
            <Table
              columns={[
                { key: 'sku_code', title: 'SKU', width: 110, render: (r: any) => <span className="font-mono text-[11px]">{r.sku_code}</span> },
                { key: 'product_name', title: '商品', render: (r: any) => `${r.product_name} ${r.sku_name || ''}` },
                { key: 'qty', title: '单套用量', width: 90, align: 'right' },
                { key: 'cost_std', title: '单件成本', width: 100, align: 'right', render: (r: any) => `¥${r.cost_std?.toLocaleString()}` },
                { key: 'remark', title: '说明', render: (r: any) => r.remark || '—' }
              ]}
              data={detail.components || []}
              loading={false}
            />
            {(detail.assemblies || []).length > 0 && (
              <>
                <div className="text-[13px] font-medium text-ink-900 mb-2 mt-4">最近组装单</div>
                <Table
                  columns={[
                    { key: 'doc_no', title: '单据号', width: 130, render: (r: any) => <span className="font-mono text-[11px]">{r.doc_no}</span> },
                    { key: 'type', title: '类型', width: 70, render: (r: any) => TYPE_LABEL[r.type] },
                    { key: 'biz_date', title: '日期', width: 100 },
                    { key: 'qty', title: '数量', width: 70, align: 'right' },
                    { key: 'status', title: '状态', width: 80, render: (r: any) => r.status === 'confirmed' ? '已过账' : '待过账' }
                  ]}
                  data={detail.assemblies}
                  loading={false}
                />
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
