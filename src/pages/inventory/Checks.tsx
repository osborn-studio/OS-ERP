/**
 * ============================================================================
 * 文件标识：src/pages/inventory/Checks.tsx ｜ 盘点管理
 * ============================================================================
 * 【职责】盘点管理（页面）
 * 【入口】/inventory/checks
 * 【主要接口】/inventory/checks
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
 * 页面：盘点管理
 */

import { useState } from 'react'
import api from '../../api/client'
import { Card, Field, Modal, Pagination, StatCard, Status, Table, fmtInt, toast, useList } from '../../components/ui'
import { FilterBar, Sel } from '../../components/DataPage'
import { useDict, useOpts } from '../../hooks/opts'
import { Plus, RefreshCw } from 'lucide-react'

export default function Checks() {
  const o = useOpts()
  const { checkStatus } = useDict()
  const [warehouseId, setWarehouseId] = useState('')
  const { list, total, loading, page, pageSize, setPage, reload } = useList('/inventory/checks', {})
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<any>({})
  const [saving, setSaving] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const [items, setItems] = useState<any[]>([])

  const filtered = list.filter((r: any) => !warehouseId || String(r.warehouse_id) === String(warehouseId))

  const openDetail = async (row: any) => {
    try {
      const res: any = await api.get(`/inventory/checks/${row.id}`)
      setDetail(row)
      setItems(res.data?.items || res.data || [])
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const createCheck = async () => {
    if (!form.warehouse_id) return toast('请选择盘点仓库', 'error')
    setSaving(true)
    try {
      await api.post('/inventory/checks', {
        warehouse_id: form.warehouse_id,
        check_date: form.check_date || new Date().toISOString().slice(0, 10),
        checker: form.checker,
        remark: form.remark
      })
      toast('盘点单已生成，已快照当前账面库存')
      setOpen(false)
      setForm({})
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const postAdjust = async () => {
    if (!confirm('确认按实盘数量过账？差异将生成盘盈/盘亏流水。')) return
    try {
      await api.post(`/inventory/checks/${detail.id}/adjust`, {
        items: items.map((x) => ({ id: x.id, sku_id: x.sku_id, batch_no: x.batch_no, actual_qty: x.actual_qty }))
      })
      toast('盘点差异已过账')
      setDetail(null)
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const saveItems = async () => {
    try {
      // 必须是 **PUT**：后端只注册了 `PUT /checks/:id/items`（`routes/inventory.js:535`。
      // 这里原来打 POST ⇒ 落到 `server/index.js` 的兜底 404「接口不存在」，
      // 「保存实盘数量」这个按钮**点了永远不生效**，而且报的错看起来像"接口不存在"，
      // 不会让人想到"是不是方法用错了"。
      await api.put(`/inventory/checks/${detail.id}/items`, {
        items: items.map((x) => ({ id: x.id, sku_id: x.sku_id, batch_no: x.batch_no, actual_qty: x.actual_qty }))
      })
      toast('实盘数量已保存')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const diffCount = items.filter((x) => Number(x.actual_qty) !== Number(x.book_qty)).length

  // 作废盘点单：只在草稿（还没录实盘数量、差异还没入账）时可用 —— 作废不动库存。
  const cancelCheck = async (row: any) => {
    if (!confirm(`确认作废盘点单「${row.doc_no}」？作废后不能再录入/过账。`)) return
    try {
      await api.post(`/inventory/checks/${row.id}/cancel`)
      toast('盘点单已作废')
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">盘点管理</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">按仓库生成盘点单，录入实盘数量后一键过账生成盘盈 / 盘亏</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button
            className="btn-primary btn-sm"
            onClick={() => {
              setForm({ check_date: new Date().toISOString().slice(0, 10), checker: '沈仓管' })
              setOpen(true)
            }}
          >
            <Plus size={14} /> 新建盘点单
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="盘点单总数" value={fmtInt(total)} sub="历史盘点记录" />
        <StatCard label="已调整" value={fmtInt(list.filter((r: any) => r.status === 'adjusted').length)} sub="差异已过账" tone="green" />
        <StatCard label="盘点中" value={fmtInt(list.filter((r: any) => r.status === 'checking' || r.status === 'draft').length)} sub="待录入实盘数" tone="amber" />
        <StatCard label="覆盖仓库" value={fmtInt(new Set(list.map((r: any) => r.warehouse_id)).size)} sub="本次列表范围" tone="brand" />
      </div>

      <FilterBar onReset={() => setWarehouseId('')}>
        <Sel value={warehouseId} onChange={setWarehouseId} options={o.warehouses} placeholder="全部仓库" w={200} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '盘点单号', width: 150 },
            { key: 'warehouse_name', title: '盘点仓库', width: 180 },
            { key: 'check_date', title: '盘点日期', width: 110 },
            { key: 'checker', title: '盘点人', width: 100 },
            { key: 'total_diff_qty', title: '差异数量', width: 100, align: 'right', render: (r) => <span className={r.total_diff_qty !== 0 ? 'text-amber-600 font-medium' : ''}>{fmtInt(r.total_diff_qty)}</span> },
            { key: 'status', title: '状态', width: 90, render: (r) => <Status value={r.status} /> },
            { key: 'remark', title: '备注', width: 160 },
            {
              key: '__act',
              title: '操作',
              width: 150,
              render: (r) => (
                <div className="flex items-center gap-2 text-[12px]">
                  <button className="link" onClick={() => openDetail(r)}>
                    录入 / 过账
                  </button>
                  {/* 作废只在草稿可见：内核 `CK.cancel` 的唯一来源态就是 draft */}
                  {r.status === 'draft' && (
                    <button className="link text-rose-600" onClick={() => cancelCheck(r)}>作废</button>
                  )}
                </div>
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
        open={open}
        title="新建盘点单"
        width={560}
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>取消</button>
            <button className="btn-primary" disabled={saving} onClick={createCheck}>{saving ? '生成中…' : '生成盘点单'}</button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="盘点仓库" required span={2}>
            <select className="input" value={form.warehouse_id ?? ''} onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}>
              <option value="">请选择</option>
              {o.warehouses.map((w) => (
                <option key={w.value} value={w.value}>{w.label}</option>
              ))}
            </select>
          </Field>
          <Field label="盘点日期">
            <input className="input" type="date" value={form.check_date ?? ''} onChange={(e) => setForm({ ...form, check_date: e.target.value })} />
          </Field>
          <Field label="盘点人">
            <input className="input" value={form.checker ?? ''} onChange={(e) => setForm({ ...form, checker: e.target.value })} />
          </Field>
          <Field label="备注" span={2}>
            <input className="input" value={form.remark ?? ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!detail}
        title={`盘点录入 · ${detail?.doc_no || ''}`}
        width={900}
        onClose={() => setDetail(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setDetail(null)}>关闭</button>
            <button className="btn-ghost" onClick={saveItems}>保存实盘数</button>
            <button className="btn-primary" onClick={postAdjust}>差异过账（{diffCount} 行）</button>
          </>
        }
      >
        <div className="table-wrap border border-ink-300 rounded-md">
          <table className="tbl">
            <thead>
              <tr>
                <th>SKU 编码</th>
                <th>商品</th>
                <th>批次号</th>
                <th className="text-right">账面数量</th>
                <th style={{ width: 120 }}>实盘数量</th>
                <th className="text-right">差异</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={6} className="text-center py-6 text-slate-400">盘点单暂无明细</td></tr>
              )}
              {items.map((x, i) => {
                const diff = Number(x.actual_qty ?? 0) - Number(x.book_qty ?? 0)
                return (
                  <tr key={x.id ?? i}>
                    <td>{x.sku_code}</td>
                    <td>{x.sku_name}</td>
                    <td>{x.batch_no || '—'}</td>
                    <td className="text-right tabular-nums">{fmtInt(x.book_qty)}</td>
                    <td>
                      <input
                        className="input input-sm text-right"
                        type="number"
                        value={x.actual_qty ?? ''}
                        onChange={(e) => setItems(items.map((y, idx) => (idx === i ? { ...y, actual_qty: Number(e.target.value) } : y)))}
                      />
                    </td>
                    <td className={`text-right tabular-nums ${diff !== 0 ? 'text-amber-600 font-medium' : ''}`}>{diff > 0 ? `+${diff}` : diff}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  )
}
