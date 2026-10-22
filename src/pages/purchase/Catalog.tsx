/**
 * ============================================================================
 * 文件标识：src/pages/purchase/Catalog.tsx ｜ 供货目录
 * ============================================================================
 * 【职责】供货目录（页面）
 * 【入口】/purchase/catalog
 * 【主要接口】/purchase/catalog
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
 * 页面：供货目录
 */

import { useState } from 'react'
import api from '../../api/client'
import { Card, Field, Modal, Status, Table, fmtMoney, toast, useFetch } from '../../components/ui'
import { FilterBar, Inp, Sel } from '../../components/DataPage'
import { useOpts } from '../../hooks/opts'
import { RefreshCw, Pencil, ShieldCheck } from 'lucide-react'

/**
 * 供货目录（模块 07）。
 *
 * 这张表不是「供应商有哪些货」那么简单，它是**采购取价链的第 ① 档 + 硬拦截**：
 *   取价链：供货目录协议价 → 该供应商最近成交价 → 最近采购订单价 → 标准成本兜底 → 手工价直通
 *   硬拦截：目录里标了「不供」的 SKU，下单会被 block（不是警告，是拦下）
 *
 * 所以界面上「是否供货」必须是显式开关，不能靠 price 是否为空来推断 ——
 * 协议价没谈好但货是能供的，这两件事得分开表达，否则一改价格就把供货关系改没了。
 */
export default function PurchaseCatalog() {
  const o = useOpts()
  const [supplierId, setSupplierId] = useState('')
  const [keyword, setKeyword] = useState('')
  const [edit, setEdit] = useState<any>(null)
  const { data, loading, reload } = useFetch<any>('/purchase/catalog', {
    supplier_id: supplierId || undefined,
    keyword: keyword || undefined,
    limit: 300
  })
  const list: any[] = data?.list || []
  const available = list.filter((x) => x.is_available).length

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">供货目录</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">
            协议价（取价链第 ① 档）+ 供货关系（硬拦截）。目录里标「不供」的 SKU，下单会被直接拦下
          </p>
        </div>
        <button className="btn-ghost btn-sm" onClick={reload}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      <Card className="mb-3" pad={false}>
        <FilterBar
          onReset={() => {
            setSupplierId('')
            setKeyword('')
          }}
        >
          <Sel
            value={supplierId}
            onChange={setSupplierId}
            options={o.suppliers}
            placeholder="全部供应商"
            w={220}
          />
          <Inp value={keyword} onChange={setKeyword} placeholder="SKU 编码 / 商品名" w={220} />
          <span className="text-[12px] text-ink-500 ml-2">
            共 {list.length} 条 · 可供 {available} · 停供 {list.length - available}
          </span>
        </FilterBar>
      </Card>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'supplier_name', title: '供应商', width: 200 },
            { key: 'sku_code', title: 'SKU 编码', width: 120 },
            { key: 'sku_name', title: '商品', width: 220 },
            { key: 'unit', title: '单位', width: 60 },
            {
              key: 'is_available',
              title: '供货',
              width: 90,
              render: (r) =>
                r.is_available ? (
                  <span className="tag bg-green-100 text-green-700">可供</span>
                ) : (
                  <span className="tag bg-slate-100 text-slate-500">不供</span>
                )
            },
            { key: 'price', title: '协议价', width: 110, align: 'right', render: (r) => (r.price != null ? `¥${fmtMoney(r.price)}` : '—') },
            { key: 'min_order_qty', title: '起订量', width: 80, align: 'right', render: (r) => r.min_order_qty || '—' },
            { key: 'lead_time_days', title: '交期(天)', width: 80, align: 'right', render: (r) => r.lead_time_days || '—' },
            { key: 'last_price', title: '最近成交价', width: 110, align: 'right', render: (r) => (r.last_price != null ? `¥${fmtMoney(r.last_price)}` : '—') },
            { key: 'valid_to', title: '协议到期', width: 100, render: (r) => r.valid_to || '—' },
            {
              key: '__act',
              title: '操作',
              width: 80,
              render: (r) => (
                <button className="link inline-flex items-center gap-1 text-[12px]" onClick={() => setEdit(r)}>
                  <Pencil size={12} /> 维护
                </button>
              )
            }
          ]}
          data={list}
          loading={loading}
          empty="暂无供货目录记录"
        />
      </Card>

      <p className="text-[12px] text-ink-500 mt-3 flex items-center gap-1.5">
        <ShieldCheck size={13} />
        取价链：供货目录协议价 → 该供应商最近成交价 → 最近采购订单价 → 标准成本兜底。手工价（manual）直通，不走链。
      </p>

      <EditModal row={edit} onClose={() => setEdit(null)} onSaved={reload} />
    </div>
  )
}

function EditModal({ row, onClose, onSaved }: any) {
  const [form, setForm] = useState<any>({})
  const [saving, setSaving] = useState(false)

  // 每次换行重新灌一次表单（不能只在首次挂载时初始化，否则点第二条还是上一条的值）
  if (row && form.__id !== row.id) {
    setForm({
      __id: row.id,
      is_available: !!row.is_available,
      price: row.price ?? '',
      min_order_qty: row.min_order_qty ?? 0,
      lead_time_days: row.lead_time_days ?? 0,
      valid_from: row.valid_from ?? '',
      valid_to: row.valid_to ?? '',
      remark: row.remark ?? ''
    })
  }

  const submit = async () => {
    setSaving(true)
    try {
      await api.post('/purchase/catalog', {
        supplier_id: row.supplier_id,
        sku_id: row.sku_id,
        is_available: form.is_available ? 1 : 0,
        price: form.price === '' ? null : Number(form.price),
        min_order_qty: Number(form.min_order_qty || 0),
        lead_time_days: Number(form.lead_time_days || 0),
        valid_from: form.valid_from || null,
        valid_to: form.valid_to || null,
        remark: form.remark || null
      })
      toast('供货目录已更新')
      onClose()
      onSaved()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={!!row}
      title={`维护供货关系 · ${row?.supplier_name || ''} / ${row?.sku_code || ''}`}
      width={680}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '保存中…' : '保存'}</button>
        </>
      }
    >
      <div className="text-[13px] text-ink-700 mb-3">
        {row?.sku_name}
        {row?.product_name && <span className="text-ink-500"> · {row.product_name}</span>}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="是否供货" hint="关掉后该 SKU 下单会被直接拦下（block 级）">
          <label className="flex items-center gap-2 h-9">
            <input type="checkbox" checked={!!form.is_available} onChange={(e) => setForm({ ...form, is_available: e.target.checked })} />
            <span className="text-[13px]">{form.is_available ? '可供' : '不供'}</span>
          </label>
        </Field>
        <Field label="协议价" hint="留空表示协议价未谈定；取价会落到下一档（最近成交价）">
          <input className="input" type="number" value={form.price ?? ''} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        </Field>
        <Field label="最小起订量" hint="下单低于此量会被拦（block 级）">
          <input className="input" type="number" value={form.min_order_qty ?? 0} onChange={(e) => setForm({ ...form, min_order_qty: e.target.value })} />
        </Field>
        <Field label="交期（天）">
          <input className="input" type="number" value={form.lead_time_days ?? 0} onChange={(e) => setForm({ ...form, lead_time_days: e.target.value })} />
        </Field>
        <Field label="协议生效日">
          <input className="input" type="date" value={form.valid_from ?? ''} onChange={(e) => setForm({ ...form, valid_from: e.target.value })} />
        </Field>
        <Field label="协议到期日">
          <input className="input" type="date" value={form.valid_to ?? ''} onChange={(e) => setForm({ ...form, valid_to: e.target.value })} />
        </Field>
        <Field label="备注" span={2}>
          <input className="input" value={form.remark ?? ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
