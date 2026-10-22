/**
 * ============================================================================
 * 文件标识：src/pages/purchase/Requisitions.tsx ｜ 请购单
 * ============================================================================
 * 【职责】请购单（页面）
 * 【入口】/purchase/requisitions
 * 【主要接口】/purchase/chain/overview、/purchase/price-preview、/purchase/requisitions
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
 * 页面：请购单
 */

import { useEffect, useState } from 'react'
import api from '../../api/client'
import { Card, Field, Modal, Status, Table, Tabs, fmtInt, fmtMoney, toast, useFetch, useList } from '../../components/ui'
import { FilterBar, Inp, Sel } from '../../components/DataPage'
import { LinesEditor, Line } from '../../components/Lines'
import { handleApprovalPending } from '../../api/approval'
import { useOpts } from '../../hooks/opts'
import { RefreshCw, Plus, Eye, ArrowRightLeft } from 'lucide-react'

/**
 * 请购单（模块 07）。
 *
 * 一句必须写在界面上的话：**请购 ≠ 门店要货**。
 * 请购是「内部部门 → 外部供应商」，审批通过转成采购订单，最终形成应付；
 * 门店要货是「门店 → 总部仓」，属内部往来，走订货中心，不产生应付。
 * 两者不合并 —— 合并会让应付凭空多出一块，且审批流完全不同。
 *
 * 转单是**部分可转**的：请购 100 件可以先转 60 件给 A 供应商、40 件再转一次。
 * 所以界面上「已转单」不等于「转完」，剩余量 = 请购量 − 已转量。
 */
const URGENCY: { value: string; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'normal', label: '普通' },
  { value: 'high', label: '紧急' }
]

/** 动作 → 一次调用（理由见 Invoices.tsx 的 INVOICE_ACTIONS：路径先进变量会让契约检查看不见） */
const REQUISITION_ACTIONS: Record<string, (id: any) => Promise<any>> = {
  submit: (id) => api.post(`/purchase/requisitions/${id}/submit`),
  approve: (id) => api.post(`/purchase/requisitions/${id}/approve`),
  reject: (id) => api.post(`/purchase/requisitions/${id}/reject`),
  close: (id) => api.post(`/purchase/requisitions/${id}/close`),
  cancel: (id) => api.post(`/purchase/requisitions/${id}/cancel`)
}

export default function Requisitions() {
  const o = useOpts()
  const [tab, setTab] = useState('')
  const [keyword, setKeyword] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const { list, loading, reload } = useList('/purchase/requisitions', {})
  const { data: ov, reload: rOv } = useFetch<any>('/purchase/chain/overview')
  const [createOpen, setCreateOpen] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [convertId, setConvertId] = useState<number | null>(null)

  const refresh = () => {
    reload()
    rOv()
  }
  const req = ov?.requisition || {}
  const filtered = list.filter((r: any) => {
    if (tab && r.status !== tab) return false
    if (supplierId && String(r.supplier_id) !== String(supplierId)) return false
    if (keyword && !`${r.doc_no} ${r.applicant_name} ${r.department}`.toLowerCase().includes(keyword.toLowerCase())) return false
    return true
  })

  const act = async (row: any, action: string) => {
    const label: Record<string, string> = { submit: '提交', approve: '审批通过', reject: '驳回', close: '关闭', cancel: '取消' }
    if (!confirm(`确认对 ${row.doc_no} 执行「${label[action] || action}」？`)) return
    try {
      const call = REQUISITION_ACTIONS[action]
      if (!call) return toast(`未知动作 ${action}`, 'error')
      await call(row.id)
      toast('操作成功')
      refresh()
    } catch (e: any) {
      // 模块 22：`PRQ.approve` 是**被审批标记的边**（`doc_actions.require_approval=1`）——
      // 模板一启用，这里就会收到 409 `APPROVAL_PENDING`。少了下面这一段，
      // 用户看到的只是「需要审批…请在单据统计页提交审批」，而请购页根本没有那个入口
      // ⇒ 审批按钮点了没反应。与 Invoices / Settlements / Payments / Orders 同一份写法。
      const handled = await handleApprovalPending(e, {
        docType: 'PRQ', docId: row.id, docNo: row.doc_no, action, onSubmitted: refresh
      })
      if (!handled) toast(e.message, 'error')
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">请购单</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">
            内部请购 → 审批 → 转采购订单（可部分转）。与「门店要货」不合并：请购产生应付，要货是内部往来
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={refresh}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> 新建请购单
          </button>
        </div>
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[
              { key: '', label: '全部', count: req.total },
              { key: 'draft', label: '草稿', count: req.draft || 0 },
              { key: 'submitted', label: '待审批', count: req.submitted || 0 },
              { key: 'approved', label: '待转单', count: req.approved || 0 },
              { key: 'converted', label: '已转单', count: req.converted || 0 },
              { key: 'rejected', label: '已驳回', count: req.rejected || 0 }
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>

      <FilterBar
        onReset={() => {
          setKeyword('')
          setSupplierId('')
        }}
      >
        <Inp value={keyword} onChange={setKeyword} placeholder="单号 / 申请人 / 部门" w={210} />
        <Sel value={supplierId} onChange={setSupplierId} options={o.suppliers} placeholder="全部供应商" w={200} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '请购单号', width: 150, render: (r) => <span className="link" onClick={() => setDetailId(r.id)}>{r.doc_no}</span> },
            { key: 'req_date', title: '请购日期', width: 105 },
            { key: 'expect_date', title: '期望到货', width: 105 },
            { key: 'applicant_name', title: '申请人 / 部门', width: 170, render: (r) => `${r.applicant_name || '-'}${r.department ? ' · ' + r.department : ''}` },
            { key: 'purpose', title: '用途', width: 90 },
            { key: 'urgency', title: '紧急度', width: 80, render: (r) => URGENCY.find((x) => x.value === r.urgency)?.label || r.urgency || '-' },
            { key: 'line_count', title: '行数', width: 60, align: 'right' },
            { key: 'total_qty', title: '数量', width: 85, align: 'right', render: (r) => fmtInt(r.total_qty) },
            { key: 'total_amount', title: '金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.total_amount)}` },
            { key: 'status', title: '状态', width: 90, render: (r) => <Status value={r.status} /> },
            {
              key: '__act',
              title: '操作',
              width: 220,
              render: (r) => (
                <div className="flex items-center gap-2 text-[12px]">
                  <button className="link inline-flex items-center gap-1" onClick={() => setDetailId(r.id)}>
                    <Eye size={12} /> 详情
                  </button>
                  {r.status === 'draft' && <button className="link" onClick={() => act(r, 'submit')}>提交</button>}
                  {r.status === 'submitted' && (
                    <>
                      <button className="link" onClick={() => act(r, 'approve')}>审批</button>
                      <button className="text-red-500 hover:text-red-600" onClick={() => act(r, 'reject')}>驳回</button>
                    </>
                  )}
                  {r.status === 'approved' && (
                    <button className="link inline-flex items-center gap-1" onClick={() => setConvertId(r.id)}>
                      <ArrowRightLeft size={12} /> 转采购订单
                    </button>
                  )}
                </div>
              )
            }
          ]}
          data={filtered}
          loading={loading}
          empty="暂无请购单"
        />
        <div className="px-3 pb-3 pt-2 text-[12px] text-ink-500">
          共 {filtered.length} 条（请购列表按 limit 拉取，不做服务端分页）
        </div>
      </Card>

      <CreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={refresh}
        suppliers={o.suppliers}
        warehouses={o.warehouses}
        skus={o.skus}
      />
      <DetailModal id={detailId} onClose={() => setDetailId(null)} onAct={act} onConvert={(id) => { setDetailId(null); setConvertId(id) }} />
      <ConvertModal id={convertId} onClose={() => setConvertId(null)} onSaved={refresh} warehouses={o.warehouses} />
    </div>
  )
}

function CreateModal({ open, onClose, onSaved, suppliers, warehouses, skus }: any) {
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState<any>({})
  const [lines, setLines] = useState<Line[]>([])
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<any>(null)

  useEffect(() => {
    if (open) {
      setForm({ req_date: today, applicant_type: 'org', urgency: 'normal', trade_type: 'normal' })
      setLines([{ qty: 1 }])
      setPreview(null)
    }
  }, [open, today])

  // 整单试算：一次请求把所有行的取价链结果拿回来，避免逐行请求
  const doPreview = async (nextLines?: Line[]) => {
    const ls = (nextLines || lines).filter((l) => l.sku_id && Number(l.qty) > 0)
    if (!ls.length) return setPreview(null)
    try {
      const res = await api.post('/purchase/price-preview', {
        supplier_id: form.supplier_id ? Number(form.supplier_id) : null,
        lines: ls.map((l) => ({ sku_id: l.sku_id, qty: Number(l.qty) }))
      })
      setPreview(res.data)
    } catch {
      setPreview(null)
    }
  }

  const submit = async () => {
    if (!lines.length || lines.some((l) => !l.sku_id || !(Number(l.qty) > 0))) return toast('请完整填写明细行', 'error')
    setSaving(true)
    try {
      await api.post('/purchase/requisitions', {
        ...form,
        warehouse_id: form.warehouse_id || undefined,
        supplier_id: form.supplier_id || undefined,
        budget_amount: form.budget_amount || undefined,
        lines: lines.filter((l) => l.sku_id).map((l) => ({ sku_id: l.sku_id, qty: Number(l.qty), price: l.price, remark: l.remark }))
      })
      toast('请购单已创建（未给价的行已按取价链补价）')
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
      open={open}
      title="新建请购单"
      width={960}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={() => doPreview()} disabled={!lines.some((l) => l.sku_id)}>
            取价试算
          </button>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '提交中…' : '保存草稿'}</button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4 mb-4">
        <Field label="请购日期">
          <input className="input" type="date" value={form.req_date ?? ''} onChange={(e) => setForm({ ...form, req_date: e.target.value })} />
        </Field>
        <Field label="期望到货日">
          <input className="input" type="date" value={form.expect_date ?? ''} onChange={(e) => setForm({ ...form, expect_date: e.target.value })} />
        </Field>
        <Field label="紧急度">
          <select className="input" value={form.urgency ?? 'normal'} onChange={(e) => setForm({ ...form, urgency: e.target.value })}>
            {URGENCY.map((u) => (
              <option key={u.value} value={u.value}>{u.label}</option>
            ))}
          </select>
        </Field>
        <Field label="建议供应商" hint="留空则转单时再定；影响取价链第 ① 档（协议价）">
          <select className="input" value={form.supplier_id ?? ''} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
            <option value="">暂不确定</option>
            {suppliers.map((s: any) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="收货仓库">
          <select className="input" value={form.warehouse_id ?? ''} onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}>
            <option value="">请选择</option>
            {warehouses.map((s: any) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="预算金额">
          <input className="input" type="number" value={form.budget_amount ?? ''} onChange={(e) => setForm({ ...form, budget_amount: e.target.value })} />
        </Field>
        <Field label="申请人">
          <input className="input" value={form.applicant_name ?? ''} onChange={(e) => setForm({ ...form, applicant_name: e.target.value })} placeholder="留空取当前账号" />
        </Field>
        <Field label="部门">
          <input className="input" value={form.department ?? ''} onChange={(e) => setForm({ ...form, department: e.target.value })} />
        </Field>
        <Field label="用途">
          <input className="input" value={form.purpose ?? ''} onChange={(e) => setForm({ ...form, purpose: e.target.value })} placeholder="如：生产备料 / 门店装修" />
        </Field>
      </div>

      <LinesEditor
        lines={lines}
        onChange={(l) => {
          setLines(l)
        }}
        skus={skus}
        priceKey="cost_std"
      />

      {preview && (
        <div className="mt-3 rounded-md border border-ink-300 overflow-hidden">
          <div className="px-3 py-2 bg-ink-50 text-[12px] text-ink-700 flex items-center justify-between">
            <span>取价试算（必须带来源：为什么是这个价）</span>
            <span>合计 ¥{fmtMoney(preview.total_amount)}</span>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>SKU</th>
                <th style={{ width: 90 }} className="text-right">数量</th>
                <th style={{ width: 110 }} className="text-right">单价</th>
                <th style={{ width: 140 }}>取价来源</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {(preview.trace || []).map((t: any, i: number) => (
                <tr key={i}>
                  <td>{t.sku_id}</td>
                  <td className="text-right tabular-nums">{preview.lines?.[i]?.qty}</td>
                  <td className="text-right tabular-nums">¥{fmtMoney(t.price)}</td>
                  <td><span className="tag bg-brand-50 text-brand-700">{t.sourceLabel || t.source}</span></td>
                  <td className="text-[12px] text-ink-700">{t.detail || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!!(preview.issues || []).length && (
            <div className="px-3 py-2 bg-red-50 text-[12px] text-red-600">
              {(preview.issues || []).map((x: any, i: number) => (
                <div key={i}>{x.level === 'block' ? '⛔ ' : '⚠ '}{x.message}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function DetailModal({ id, onClose, onAct, onConvert }: any) {
  const { data, loading, reload } = useFetch<any>(id ? `/purchase/requisitions/${id}` : null, undefined, [id])
  const actions: string[] = (data?.actions || []).map((a: any) => a.action || a.code)
  // 详情里的动作：先走父级 act（它会刷新列表），再刷新本弹窗 —— 否则点了「审批」
  // 列表变了、弹窗还显示旧状态，用户会以为没生效。
  const doAct = async (action: string) => {
    await onAct(data, action)
    reload()
  }
  return (
    <Modal open={!!id} title={`请购单详情 · ${data?.doc_no || ''}`} width={980} onClose={onClose}>
      {loading && <div className="text-center py-8 text-ink-400 text-[13px]">加载中…</div>}
      {data && (
        <div>
          <div className="grid grid-cols-4 gap-3 mb-3 text-[13px]">
            <div><span className="text-ink-500">状态 </span><Status value={data.status} /></div>
            <div><span className="text-ink-500">请购日期 </span>{data.req_date}</div>
            <div><span className="text-ink-500">期望到货 </span>{data.expect_date || '-'}</div>
            <div><span className="text-ink-500">申请人 </span>{data.applicant_name} {data.department ? `· ${data.department}` : ''}</div>
            <div><span className="text-ink-500">仓库 </span>{data.warehouse_name || '-'}</div>
            <div><span className="text-ink-500">供应商 </span>{data.supplier_name || '待定'}</div>
            <div><span className="text-ink-500">用途 </span>{data.purpose || '-'}</div>
            <div><span className="text-ink-500">金额 </span>¥{fmtMoney(data.total_amount)}</div>
          </div>
          {data.converted_order_no && (
            <div className="text-[12px] text-teal-700 bg-teal-50 rounded px-2 py-1 inline-block mb-2">
              已转采购订单 {data.converted_order_no}
            </div>
          )}
          {data.reason && <div className="text-[12px] text-red-600 mb-2">驳回原因：{data.reason}</div>}

          <div className="table-wrap border border-ink-300 rounded-md mb-3">
            <table className="tbl">
              <thead>
                <tr>
                  <th>SKU 编码</th>
                  <th>商品</th>
                  <th style={{ width: 90 }} className="text-right">数量</th>
                  <th style={{ width: 60 }} className="text-right">已转</th>
                  <th style={{ width: 60 }} className="text-right">剩余</th>
                  <th style={{ width: 100 }} className="text-right">单价</th>
                  <th style={{ width: 110 }} className="text-right">金额</th>
                  <th style={{ width: 130 }}>取价来源</th>
                </tr>
              </thead>
              <tbody>
                {(data.items || []).map((l: any, i: number) => {
                  const rest = Number(l.qty || 0) - Number(l.converted_qty || 0)
                  return (
                    <tr key={i}>
                      <td>{l.sku_code}</td>
                      <td>{l.sku_name}</td>
                      <td className="text-right tabular-nums">{l.qty}</td>
                      <td className="text-right tabular-nums text-ink-500">{l.converted_qty || 0}</td>
                      <td className="text-right tabular-nums">{rest}</td>
                      <td className="text-right tabular-nums">¥{fmtMoney(l.price)}</td>
                      <td className="text-right tabular-nums">¥{fmtMoney(l.amount)}</td>
                      <td className="text-[12px]">{l.price_source_label || l.price_source || '-'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2">
            {data.status === 'draft' && <button className="btn-ghost btn-sm" onClick={() => doAct('submit')}>提交</button>}
            {data.status === 'submitted' && (
              <>
                <button className="btn-primary btn-sm" onClick={() => doAct('approve')}>审批通过</button>
                <button className="btn-ghost btn-sm" onClick={() => doAct('reject')}>驳回</button>
              </>
            )}
            {data.status === 'approved' && (
              <button className="btn-primary btn-sm" onClick={() => onConvert(data.id)}>
                <ArrowRightLeft size={13} /> 转采购订单
              </button>
            )}
            {actions.includes('close') && <button className="btn-ghost btn-sm" onClick={() => doAct('close')}>关闭</button>}
          </div>
        </div>
      )}
    </Modal>
  )
}

function ConvertModal({ id, onClose, onSaved, warehouses }: any) {
  const { data } = useFetch<any>(id ? `/purchase/requisitions/${id}` : null, undefined, [id])
  const [lines, setLines] = useState<any[]>([])
  const [warehouseId, setWarehouseId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (data) {
      setWarehouseId(String(data.warehouse_id || ''))
      setSupplierId(String(data.supplier_id || ''))
      setLines(
        (data.items || []).map((l: any) => ({
          ...l,
          convert_qty: Math.max(Number(l.qty || 0) - Number(l.converted_qty || 0), 0)
        }))
      )
    }
  }, [data])

  const total = lines.reduce((s, l) => s + Number(l.convert_qty || 0) * Number(l.price || 0), 0)

  const submit = async () => {
    const payload = lines.filter((l) => Number(l.convert_qty) > 0).map((l) => ({ id: l.id, qty: Number(l.convert_qty) }))
    if (!payload.length) return toast('请填写至少一行的转单数量', 'error')
    if (!warehouseId) return toast('转单必须指定收货仓库', 'error')
    setSaving(true)
    try {
      const res = await api.post(`/purchase/requisitions/${id}/convert`, {
        lines: payload,
        warehouse_id: Number(warehouseId),
        supplier_id: supplierId ? Number(supplierId) : undefined
      })
      toast(`已生成采购订单 ${res.data?.doc_no || ''}`)
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
      open={!!id}
      title={`转采购订单 · ${data?.doc_no || ''}`}
      width={900}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '转单中…' : `确认转单（¥${fmtMoney(total)}）`}</button>
        </>
      }
    >
      <p className="text-[12px] text-ink-700 mb-3">
        支持部分转单：只填要转的数量即可，剩余量留在请购单上，下次还能再转一次。
        转单必须指定收货仓库 —— 没有仓库的采购订单到了货没法入库。
      </p>
      <div className="grid grid-cols-2 gap-4 mb-3">
        <Field label="收货仓库" required>
          <select className="input" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">请选择</option>
            {warehouses.map((w: any) => (
              <option key={w.value} value={w.value}>{w.label}</option>
            ))}
          </select>
        </Field>
        <Field label="供应商" hint="覆盖请购单上的建议供应商">
          <input className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} placeholder="留空沿用请购单" />
        </Field>
      </div>
      <div className="table-wrap border border-ink-300 rounded-md">
        <table className="tbl">
          <thead>
            <tr>
              <th>SKU 编码</th>
              <th>商品</th>
              <th style={{ width: 80 }} className="text-right">请购量</th>
              <th style={{ width: 80 }} className="text-right">已转</th>
              <th style={{ width: 110 }} className="text-right">本次转单</th>
              <th style={{ width: 100 }} className="text-right">单价</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{l.sku_code}</td>
                <td>{l.sku_name}</td>
                <td className="text-right tabular-nums">{l.qty}</td>
                <td className="text-right tabular-nums text-ink-500">{l.converted_qty || 0}</td>
                <td>
                  <input
                    className="input input-sm text-right"
                    type="number"
                    value={l.convert_qty}
                    onChange={(e) => setLines(lines.map((x, idx) => (idx === i ? { ...x, convert_qty: e.target.value } : x)))}
                  />
                </td>
                <td className="text-right tabular-nums">¥{fmtMoney(l.price)}</td>
              </tr>
            ))}
            {!lines.length && (
              <tr>
                <td colSpan={6} className="text-center py-6 text-ink-400">该请购单无剩余可转行</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
