/**
 * ============================================================================
 * 文件标识：src/pages/inventory/Transfers.tsx ｜ 调拨管理
 * ============================================================================
 * 【职责】调拨管理（页面）
 * 【入口】/inventory/transfers
 * 【主要接口】/inventory/transfers
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
 * 页面：调拨管理
 */

import { useState } from 'react'
import api from '../../api/client'
import { Card, Field, Modal, Pagination, Status, Table, Tabs, fmtInt, fmtMoney, toast, useList } from '../../components/ui'
import { FilterBar, Inp, Sel } from '../../components/DataPage'
import { LinesEditor, Line } from '../../components/Lines'
import { useDict, useOpts } from '../../hooks/opts'
import { Plus, RefreshCw, Truck } from 'lucide-react'

// 每个流转动作一条**写死的字面量路径**：不拼 `/${action}`。
// 动态段一拼，OpenAPI 漂移检查就只能整段跳过 —— 那等于没检查（见下 act() 里的旧注释）。
const TRANSFER_ACTIONS: Record<string, { label: string; path: (id: any) => string }> = {
  submit: { label: '提交', path: (id) => `/inventory/transfers/${id}/submit` },
  cancel: { label: '作废', path: (id) => `/inventory/transfers/${id}/cancel` },
  ship: { label: '出库', path: (id) => `/inventory/transfers/${id}/ship` },
  receive: { label: '入库', path: (id) => `/inventory/transfers/${id}/receive` }
}

// `submitted` 是内核 `TF` 已登记的状态，而全局 Status 徽标把它显示成「待审批」——
// 调拨单没有审批环节，那个文案会误导（单据其实只是「已提交、待出库」）。
// 这里就地给调拨单一个正确文案；`/meta/dict` 的 transfer_status 补上后可以删掉这行。
const TF_STATUS_TEXT: Record<string, string> = { submitted: '已提交' }

export default function Transfers() {
  const o = useOpts()
  const { transferStatus } = useDict()
  const [tab, setTab] = useState('')
  const [keyword, setKeyword] = useState('')
  const { list, total, loading, page, pageSize, setPage, reload } = useList('/inventory/transfers', {})
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<any>({})
  const [lines, setLines] = useState<Line[]>([])
  const [saving, setSaving] = useState(false)

  const filtered = list.filter((r: any) => {
    if (tab && r.status !== tab) return false
    if (keyword && !`${r.doc_no} ${r.from_warehouse_name} ${r.to_warehouse_name}`.toLowerCase().includes(keyword.toLowerCase())) return false
    return true
  })

  const act = async (row: any, action: string) => {
    const a = TRANSFER_ACTIONS[action]
    if (!a) return
    if (!confirm(`确认对 ${row.doc_no} 执行「${a.label}」？`)) return
    try {
      // 路径取自 TRANSFER_ACTIONS 里**写死的字面量**（不在这里拼 `/${action}`）：
      // 动态段一拼，OpenAPI 契约的漂移检查就只能跳过 —— 那等于没检查
      await api.post(a.path(row.id), {})
      toast('操作成功')
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const submit = async () => {
    if (!form.from_warehouse_id || !form.to_warehouse_id) return toast('请选择调出与调入仓库', 'error')
    if (form.from_warehouse_id === form.to_warehouse_id) return toast('调出与调入仓库不能相同', 'error')
    if (!lines.length || lines.some((l) => !l.sku_id || !(Number(l.qty) > 0))) return toast('请完整填写调拨明细', 'error')
    setSaving(true)
    try {
      await api.post('/inventory/transfers', { ...form, items: lines })
      toast('调拨单已创建')
      setOpen(false)
      setForm({})
      setLines([])
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
          <h1 className="title-serif text-[19px] font-medium text-ink-900">调拨管理</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">仓间调拨：调出仓出库 → 在途 → 调入仓入库，全程留痕</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button
            className="btn-primary btn-sm"
            onClick={() => {
              setForm({ transfer_date: new Date().toISOString().slice(0, 10), type: 'normal' })
              setLines([{ qty: 1, tax_rate: 13 }])
              setOpen(true)
            }}
          >
            <Plus size={14} /> 新建调拨单
          </button>
        </div>
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[{ key: '', label: '全部' }, ...transferStatus.map((s) => ({ key: String(s.value), label: s.label }))]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>

      <FilterBar onReset={() => setKeyword('')}>
        <Inp value={keyword} onChange={setKeyword} placeholder="调拨单号 / 仓库" w={240} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '调拨单号', width: 150 },
            { key: 'from_warehouse_name', title: '调出仓库', width: 160 },
            { key: 'to_warehouse_name', title: '调入仓库', width: 160 },
            {
              key: 'type', title: '类型', width: 110,
              // 类型文案与 `server/lib/transfer.js` 的 TRANSFER_TYPES 同口径（值域的唯一出处在那边）。
              // ⚠️ `qc_disposition` 是**质检自动生成**的调拨单（让步→不合格品仓 / 返工→待检品仓），
              // 它不在新建表单的下拉里（人不能手工选），但**必须在类型列显示出来** ——
              // 客户口径：「出库单一定会有多种类型的，出入库单上一定要加一个类型」。
              // 漏了这个键，这一档会渲染成裸码 `qc_disposition`，等于类型没加。
              render: (r) => ({ normal: '普通调拨', allocation: '铺货调拨', return: '调回', qc_disposition: '质检处置调拨' }[r.type as string] || r.type)
            },
            { key: 'transfer_date', title: '调拨日期', width: 110 },
            { key: 'item_count', title: '行数', width: 60, align: 'right' },
            { key: 'total_qty', title: '数量', width: 80, align: 'right', render: (r) => fmtInt(r.total_qty) },
            { key: 'total_amount', title: '成本金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.total_amount)}` },
            { key: 'applicant', title: '申请人', width: 90 },
            { key: 'status', title: '状态', width: 90, render: (r) => <Status value={r.status} text={TF_STATUS_TEXT[r.status]} /> },
            {
              key: '__act',
              title: '操作',
              width: 190,
              render: (r) => (
                <div className="flex items-center gap-2 text-[12px]">
                  {/* 动作可见性直接照内核 `TF` 的出边写：draft 可「提交/出库/作废」，
                      submitted 可「出库/作废」，shipped 只能「入库」。 */}
                  {r.status === 'draft' && (
                    <button className="link" onClick={() => act(r, 'submit')}>提交</button>
                  )}
                  {(r.status === 'draft' || r.status === 'submitted') && (
                    <button className="link inline-flex items-center gap-1" onClick={() => act(r, 'ship')}>
                      <Truck size={12} /> 出库
                    </button>
                  )}
                  {r.status === 'shipped' && <button className="link" onClick={() => act(r, 'receive')}>入库</button>}
                  {(r.status === 'draft' || r.status === 'submitted') && (
                    <button className="link text-rose-600" onClick={() => act(r, 'cancel')}>作废</button>
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
        title="新建调拨单"
        width={900}
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>取消</button>
            <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '提交中…' : '保存'}</button>
          </>
        }
      >
        <div className="grid grid-cols-3 gap-4 mb-4">
          <Field label="调出仓库" required>
            <select className="input" value={form.from_warehouse_id ?? ''} onChange={(e) => setForm({ ...form, from_warehouse_id: e.target.value })}>
              <option value="">请选择</option>
              {o.warehouses.map((w) => (
                <option key={w.value} value={w.value}>{w.label}</option>
              ))}
            </select>
          </Field>
          <Field label="调入仓库" required>
            <select className="input" value={form.to_warehouse_id ?? ''} onChange={(e) => setForm({ ...form, to_warehouse_id: e.target.value })}>
              <option value="">请选择</option>
              {o.warehouses.map((w) => (
                <option key={w.value} value={w.value}>{w.label}</option>
              ))}
            </select>
          </Field>
          <Field label="调拨类型">
            <select className="input" value={form.type ?? 'normal'} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="normal">普通调拨</option>
              <option value="allocation">铺货调拨</option>
              <option value="return">调回</option>
            </select>
          </Field>
          <Field label="调拨日期">
            <input className="input" type="date" value={form.transfer_date ?? ''} onChange={(e) => setForm({ ...form, transfer_date: e.target.value })} />
          </Field>
          <Field label="申请人">
            <input className="input" value={form.applicant ?? ''} onChange={(e) => setForm({ ...form, applicant: e.target.value })} />
          </Field>
          <Field label="备注">
            <input className="input" value={form.remark ?? ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
          </Field>
        </div>
        <LinesEditor lines={lines} onChange={setLines} skus={o.skus} priceKey="cost_std" />
      </Modal>
    </div>
  )
}
