/**
 * ============================================================================
 * 文件标识：src/pages/purchase/Returns.tsx ｜ 采购退货
 * ============================================================================
 * 【职责】采购退货（页面）
 * 【入口】/purchase/returns
 * 【主要接口】/purchase/returns
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
 * 页面：采购退货
 */

import { useState } from 'react'
import DataPage, { FieldDef } from '../../components/DataPage'
import { Field, Modal, Status, fmtInt, fmtMoney, toast } from '../../components/ui'
import { LinesEditor, Line } from '../../components/Lines'
import { useOpts } from '../../hooks/opts'
import api from '../../api/client'
import { Plus } from 'lucide-react'

export default function PurchaseReturns() {
  const o = useOpts()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<any>({})
  const [lines, setLines] = useState<Line[]>([])
  const [tick, setTick] = useState(0)

  const fields: FieldDef[] = [
    { key: 'doc_no', label: '退货单号', width: 150 },
    { key: 'supplier_name', label: '供应商', width: 210 },
    { key: 'warehouse_name', label: '退货仓库', width: 150 },
    { key: 'return_date', label: '退货日期', width: 110 },
    { key: 'reason', label: '退货原因', width: 150 },
    { key: 'total_qty', label: '退货数量', width: 90, align: 'right', render: (r) => fmtInt(r.total_qty) },
    { key: 'total_amount', label: '退货金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.total_amount)}` },
    { key: 'status', label: '状态', width: 90, render: (r) => <Status value={r.status} /> }
  ]

  const submit = async () => {
    if (!form.supplier_id || !form.warehouse_id) return toast('请选择供应商与退货仓库', 'error')
    if (!lines.length || lines.some((l) => !l.sku_id || !(Number(l.qty) > 0))) return toast('请完整填写退货明细', 'error')
    setSaving(true)
    try {
      await api.post('/purchase/returns', { ...form, items: lines })
      toast('采购退货已提交，库存已扣减')
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

  /** 作废（仅 draft）。draft 态意味着退货出库与冲销都还没发生，所以这一步不该有后果。 */
  const cancel = async (row: any, reload: () => void) => {
    if (!confirm(`作废退货单「${row.doc_no}」？草稿单尚未退货出库，作废不会有库存变动。`)) return
    try {
      await api.post(`/purchase/returns/${row.id}/cancel`, {})
      toast('退货单已作废')
      reload()
    } catch (e: any) {
      toast(e.message || '作废失败', 'error')
    }
  }

  /** 完成（仅 confirmed）＝结案。库存与采购订单已收量的回退在「确认」那一步就做完了。 */
  const complete = async (row: any, reload: () => void) => {
    if (!confirm(`确认退货单「${row.doc_no}」已完成（货已退回供应商）？`)) return
    try {
      await api.post(`/purchase/returns/${row.id}/complete`, {})
      toast('退货单已结案')
      reload()
    } catch (e: any) {
      toast(e.message || '操作失败', 'error')
    }
  }

  return (
    <div key={tick}>
      <DataPage
        title="采购退货"
        desc="质量不符 / 包装破损等退回供应商，直接冲减批次库存"
        path="/purchase/returns"
        fields={fields}
        canWrite={false}
        allowDelete={false}
        excelName="采购退货"
        rowActions={(row, reload) => (
          <>
            {row.status === 'draft' && (
              <button className="link text-[12px] text-red-600" onClick={() => cancel(row, reload)}>
                作废
              </button>
            )}
            {row.status === 'confirmed' && (
              <button className="link text-[12px]" onClick={() => complete(row, reload)}>
                完成
              </button>
            )}
          </>
        )}
        extraToolbar={
          <button
            className="btn-primary btn-sm"
            onClick={() => {
              setForm({ return_date: new Date().toISOString().slice(0, 10), reason: '质量不符' })
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
        title="新建采购退货"
        width={880}
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>取消</button>
            <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '提交中…' : '确认退货'}</button>
          </>
        }
      >
        <div className="grid grid-cols-3 gap-4 mb-4">
          <Field label="供应商" required>
            <select className="input" value={form.supplier_id ?? ''} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
              <option value="">请选择</option>
              {o.suppliers.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </Field>
          <Field label="退货仓库" required>
            <select className="input" value={form.warehouse_id ?? ''} onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}>
              <option value="">请选择</option>
              {o.warehouses.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
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
        <LinesEditor lines={lines} onChange={setLines} skus={o.skus} priceKey="cost_std" showTax />
      </Modal>
    </div>
  )
}
