/**
 * ============================================================================
 * 文件标识：src/pages/sales/Returns.tsx ｜ 销售退货
 * ============================================================================
 * 【职责】销售退货（页面）
 * 【入口】/sales/returns
 * 【主要接口】/sales/returns
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
 * 页面：销售退货
 */

import { useState } from 'react'
import DataPage, { FieldDef } from '../../components/DataPage'
import { Field, Modal, Status, fmtInt, fmtMoney, toast } from '../../components/ui'
import { LinesEditor, Line } from '../../components/Lines'
import { useDict, useOpts } from '../../hooks/opts'
import api from '../../api/client'
import { Plus } from 'lucide-react'

export default function SalesReturns() {
  const o = useOpts()
  const { salesChannels } = useDict()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<any>({})
  const [lines, setLines] = useState<Line[]>([])
  const [tick, setTick] = useState(0)

  const fields: FieldDef[] = [
    { key: 'doc_no', label: '退货单号', width: 150 },
    { key: 'order_no', label: '销售订单', width: 150 },
    { key: 'channel', label: '渠道', width: 100, render: (r) => salesChannels.find((c) => c.value === r.channel)?.label || r.channel },
    { key: 'customer_name', label: '客户', width: 200 },
    { key: 'warehouse_name', label: '退货入库仓', width: 150 },
    { key: 'return_date', label: '退货日期', width: 110 },
    { key: 'reason', label: '退货原因', width: 140 },
    { key: 'total_qty', label: '退货数量', width: 90, align: 'right', render: (r) => fmtInt(r.total_qty) },
    { key: 'total_amount', label: '退货金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.total_amount)}` },
    { key: 'status', label: '状态', width: 90, render: (r) => <Status value={r.status} /> }
  ]

  const submit = async () => {
    if (!lines.length || lines.some((l) => !l.sku_id || !(Number(l.qty) > 0))) return toast('请完整填写退货明细', 'error')
    setSaving(true)
    try {
      await api.post('/sales/returns', { ...form, items: lines })
      toast('销售退货已登记，库存已回补')
      setOpen(false)
      setForm({})
      setLines([])
      setTick((t) => t + 1)
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  // 退货完成（已确认 → 已完成）。按钮只在 `confirmed` 时可点 —— 与内核里
  // `complete` 边的 from_state 一致；草稿态（未确认）点它会被服务端 409 拒掉，
  // 这里先把不可能的操作藏起来（"已完成的单"不再显示按钮，重复点无从发生）。
  const complete = async (row: any, reload: () => void) => {
    if (!confirm(`确认退货单「${row.doc_no}」已完成（货已回库、应收已冲减）？`)) return
    try {
      await api.post(`/sales/returns/${row.id}/complete`, {})
      toast('退货已完成')
      reload()
    } catch (e: any) {
      toast(e.message || '操作失败', 'error')
    }
  }

  return (
    <div key={tick}>
      <DataPage
        title="销售退货"
        desc="渠道退回商品回补库存；经销商退货会冲减当期返利基数"
        path="/sales/returns"
        fields={fields}
        canWrite={false}
        allowDelete={false}
        excelName="销售退货"
        rowActions={(row, reload) =>
          row.status === 'confirmed' ? (
            <button className="link text-[12px]" onClick={() => complete(row, reload)}>
              完成
            </button>
          ) : null
        }
        filters={[{ key: 'channel', type: 'select', label: '全部渠道', options: salesChannels }]}
        extraToolbar={
          <button
            className="btn-primary btn-sm"
            onClick={() => {
              setForm({ channel: 'dealer', return_date: new Date().toISOString().slice(0, 10), reason: '滞销退回' })
              setLines([{ qty: 1, tax_rate: 13 }])
              setOpen(true)
            }}
          >
            <Plus size={14} /> 新建退货
          </button>
        }
      />

      <Modal
        open={open}
        title="新建销售退货"
        width={900}
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>取消</button>
            <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '提交中…' : '确认退货'}</button>
          </>
        }
      >
        <div className="grid grid-cols-3 gap-4 mb-4">
          <Field label="退货渠道" required>
            <select className="input" value={form.channel ?? ''} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
              {salesChannels.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </Field>
          {form.channel === 'dealer' && (
            <Field label="经销商">
              <select className="input" value={form.dealer_id ?? ''} onChange={(e) => setForm({ ...form, dealer_id: e.target.value })}>
                <option value="">请选择</option>
                {o.dealers.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </Field>
          )}
          {form.channel === 'store' && (
            <Field label="门店">
              <select className="input" value={form.store_id ?? ''} onChange={(e) => setForm({ ...form, store_id: e.target.value })}>
                <option value="">请选择</option>
                {o.stores.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="入库仓库" required>
            <select className="input" value={form.warehouse_id ?? ''} onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}>
              <option value="">请选择</option>
              {o.warehouses.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </Field>
          <Field label="退货日期">
            <input className="input" type="date" value={form.return_date ?? ''} onChange={(e) => setForm({ ...form, return_date: e.target.value })} />
          </Field>
          <Field label="退货原因" span={2}>
            <input className="input" value={form.reason ?? ''} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
        </div>
        <LinesEditor lines={lines} onChange={setLines} skus={o.skus} priceKey="price_retail" />
      </Modal>
    </div>
  )
}
