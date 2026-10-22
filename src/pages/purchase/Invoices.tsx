/**
 * ============================================================================
 * 文件标识：src/pages/purchase/Invoices.tsx ｜ 采购发票
 * ============================================================================
 * 【职责】采购发票（页面）
 * 【入口】/purchase/invoices
 * 【主要接口】/purchase/invoices-available-lines、/purchase/invoices
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
 * 页面：采购发票
 */

import { useEffect, useState } from 'react'
import api from '../../api/client'
import { Card, Field, Modal, StatCard, Status, Table, Tabs, fmtInt, fmtMoney, toast, useFetch, useList } from '../../components/ui'
import { FilterBar, Inp, Sel } from '../../components/DataPage'
import { handleApprovalPending } from '../../api/approval'
import { useOpts } from '../../hooks/opts'
import { RefreshCw, Plus, Eye, FileText, AlertTriangle } from 'lucide-react'

/**
 * 采购发票（模块 07）。
 *
 * 三条必须显性化的口径：
 * ① **数量不得超入库量**（供应商+SKU 级累计），超了校验就被拒 —— 金额差异不拦，只记录。
 *    差异不拦是有意的：运费、返利、价格调整都会造成票面与入库金额不一致，硬拦会让财务没法录票。
 * ② 「已认证」与「已入账」是两个状态：认证是采购对票（数量对不对），入账是财务动作。
 * ③ 已认证未入账的票**可以作废**（票开错了得能撤）；已入账不给作废出口，要改走红字。
 */
/** 列表用的短标签：表格里 `费用发票（运费 / 折扣）` 会折成两行，把行高撑坏；弹窗里仍用全称。 */
const INVOICE_SHORT: Record<string, string> = { vat_special: '专票', vat_normal: '普票', fee: '费用票' }

const INVOICE_TYPES: { value: string; label: string }[] = [
  { value: 'vat_special', label: '增值税专用发票' },
  { value: 'vat_normal', label: '增值税普通发票' },
  { value: 'fee', label: '费用发票（运费 / 折扣）' }
]

/**
 * 动作 → **一次调用**（写成表，**不要拼 `/${action}`**）。
 *
 * 为什么是函数表、而不是"路径字符串表 + `api.post(path)`"：
 *   `scripts/check-api-contract.mjs` 是按"写在调用处的字面量路径"扫源码的。
 *   路径先进变量、再传给 `api.post(path)`，那 5 条动作路径就**从契约眼里消失了**
 *   （实测：改成字符串表后前端被检查的调用数从 401 掉到 396）。
 *   把 `api.post(...)` 写在表里，动作名是字面量、id 走 `${...}`，
 *   契约检查就能按占位段验证形状 —— 与 `src/api/*.ts`（如 `SI_CONFIRM`）同一写法。
 */
const INVOICE_ACTIONS: Record<string, (id: any) => Promise<any>> = {
  submit: (id) => api.post(`/purchase/invoices/${id}/submit`),
  verify: (id) => api.post(`/purchase/invoices/${id}/verify`),
  post: (id) => api.post(`/purchase/invoices/${id}/post`),
  void: (id) => api.post(`/purchase/invoices/${id}/void`)
}

export default function Invoices() {
  const o = useOpts()
  const [tab, setTab] = useState('')
  const [keyword, setKeyword] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [type, setType] = useState('')
  const { list, summary, loading, reload } = useList('/purchase/invoices', {})
  const [createOpen, setCreateOpen] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)

  const filtered = list.filter((r: any) => {
    if (tab && r.status !== tab) return false
    if (supplierId && String(r.supplier_id) !== String(supplierId)) return false
    if (type && r.invoice_type !== type) return false
    if (keyword && !`${r.doc_no} ${r.invoice_no} ${r.supplier_name}`.toLowerCase().includes(keyword.toLowerCase())) return false
    return true
  })

  const act = async (row: any, action: string) => {
    const label: Record<string, string> = { submit: '提交', verify: '发票认证（三单匹配）', post: '入账', void: '作废' }
    if (!confirm(`确认对 ${row.doc_no} 执行「${label[action] || action}」？`)) return false
    try {
      const call = INVOICE_ACTIONS[action]
      if (!call) return toast(`未知动作 ${action}`, 'error')
      await call(row.id)
      toast('操作成功')
      reload()
      return true
    } catch (e: any) {
      // 模块 22：作废/入账等动作可能被审批闸门拦下 —— 先走审批引导，再谈报错
      const handled = await handleApprovalPending(e, {
        docType: 'PI', docId: row.id, docNo: row.doc_no, action, onSubmitted: reload
      })
      if (handled) return false
      // 三单匹配失败会把逐行差异放在 detail 里 —— 展开给财务看，而不是只说一句「失败」
      const d = e.detail
      if (Array.isArray(d) && d.length) toast(`${e.message}（${d.map((x: any) => x.message).join('；')}）`, 'error')
      else toast(e.message, 'error')
      return false
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">采购发票</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">
            录入 → 提交 → 发票认证（三单匹配）→ 入账。数量不得超入库量；金额差异不拦，进结算单的暂估差异
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={reload}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> 录入发票
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="发票张数" value={fmtInt(filtered.length)} sub="不含已作废" />
        <StatCard label="不含税金额" value={`¥${fmtMoney(summary?.amount, 0)}`} tone="brand" />
        <StatCard label="税额" value={`¥${fmtMoney(summary?.tax, 0)}`} />
        <StatCard label="价税合计" value={`¥${fmtMoney(summary?.total, 0)}`} tone="red" />
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[
              { key: '', label: '全部' },
              { key: 'draft', label: '草稿' },
              { key: 'submitted', label: '待认证' },
              { key: 'verified', label: '已认证' },
              { key: 'posted', label: '已入账' }
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
          setType('')
        }}
      >
        <Inp value={keyword} onChange={setKeyword} placeholder="单据号 / 发票号 / 供应商" w={220} />
        <Sel value={supplierId} onChange={setSupplierId} options={o.suppliers} placeholder="全部供应商" w={200} />
        <Sel value={type} onChange={setType} options={INVOICE_TYPES} placeholder="全部票种" w={180} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '单据号', width: 145, render: (r) => <span className="link" onClick={() => setDetailId(r.id)}>{r.doc_no}</span> },
            { key: 'invoice_no', title: '发票号', width: 150 },
            { key: 'invoice_type', title: '票种', width: 108, render: (r) => INVOICE_SHORT[r.invoice_type] || r.invoice_type },
            { key: 'supplier_name', title: '供应商', width: 210 },
            { key: 'invoice_date', title: '开票日期', width: 112 },
            { key: 'line_count', title: '行数', width: 60, align: 'right' },
            { key: 'amount', title: '不含税', width: 110, align: 'right', render: (r) => `¥${fmtMoney(r.amount)}` },
            { key: 'tax_amount', title: '税额', width: 100, align: 'right', render: (r) => `¥${fmtMoney(r.tax_amount)}` },
            { key: 'total_amount', title: '价税合计', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.total_amount)}` },
            { key: 'status', title: '状态', width: 90, render: (r) => <Status value={r.status} /> },
            {
              key: '__act',
              title: '操作',
              width: 200,
              render: (r) => (
                <div className="flex items-center gap-2 text-[12px]">
                  <button className="link inline-flex items-center gap-1" onClick={() => setDetailId(r.id)}>
                    <Eye size={12} /> 详情
                  </button>
                  {r.status === 'draft' && <button className="link" onClick={() => act(r, 'submit')}>提交</button>}
                  {r.status === 'submitted' && <button className="link" onClick={() => act(r, 'verify')}>认证</button>}
                  {r.status === 'verified' && <button className="link" onClick={() => act(r, 'post')}>入账</button>}
                  {['draft', 'submitted', 'verified'].includes(r.status) && (
                    <button className="text-red-500 hover:text-red-600" onClick={() => act(r, 'void')}>作废</button>
                  )}
                </div>
              )
            }
          ]}
          data={filtered}
          loading={loading}
          empty="暂无采购发票"
        />
        <div className="px-3 pb-3 pt-2 text-[12px] text-ink-500">共 {filtered.length} 条</div>
      </Card>

      <CreateModal open={createOpen} onClose={() => setCreateOpen(false)} onSaved={reload} suppliers={o.suppliers} />
      <DetailModal id={detailId} onClose={() => setDetailId(null)} onAct={act} />
    </div>
  )
}

function CreateModal({ open, onClose, onSaved, suppliers }: any) {
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState<any>({ invoice_type: 'vat_special', tax_rate: 13, invoice_date: today })
  const [avail, setAvail] = useState<any[]>([])
  const [lines, setLines] = useState<any[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setForm({ invoice_type: 'vat_special', tax_rate: 13, invoice_date: today })
      setAvail([])
      setLines([])
    }
  }, [open, today])

  // 带出「本供应商已入库但未开票」的行 —— 手输数量极易超开票，让系统先算好剩余额度
  const loadAvail = async (sid: string) => {
    if (!sid) return
    try {
      const res = await api.get('/purchase/invoices-available-lines', { supplier_id: sid })
      const rows = res.data?.list || []
      setAvail(rows)
      setLines(
        rows.map((x: any) => ({
          ...x,
          pick: false,
          qty: x.open_qty,
          price: x.unit_price
        }))
      )
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const picked = lines.filter((l) => l.pick && Number(l.qty) > 0)
  const amount = picked.reduce((s, l) => s + Number(l.qty) * Number(l.price), 0)
  const tax = (amount * Number(form.tax_rate || 0)) / 100

  const submit = async () => {
    if (!form.supplier_id) return toast('请选择供应商', 'error')
    if (!picked.length) return toast('请勾选至少一行开票明细', 'error')
    const over = picked.find((l) => Number(l.qty) > Number(l.open_qty) + 1e-6)
    if (over) return toast(`${over.sku_name} 开票量 ${over.qty} 超过剩余可开 ${over.open_qty}`, 'error')
    setSaving(true)
    try {
      await api.post('/purchase/invoices', {
        invoice_no: form.invoice_no || undefined,
        invoice_type: form.invoice_type,
        supplier_id: Number(form.supplier_id),
        invoice_date: form.invoice_date,
        tax_rate: Number(form.tax_rate),
        remark: form.remark || null,
        lines: picked.map((l) => ({
          sku_id: l.sku_id,
          order_item_id: l.order_item_id || null,
          qty: Number(l.qty),
          price: Number(l.price)
        }))
      })
      toast('发票已录入（草稿）')
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
      title="录入采购发票"
      width={1020}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>
            {saving ? '保存中…' : `保存草稿（¥${fmtMoney(amount + tax)}）`}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-4 gap-4 mb-4">
        <Field label="供应商" required>
          <select
            className="input"
            value={form.supplier_id ?? ''}
            onChange={(e) => {
              setForm({ ...form, supplier_id: e.target.value })
              loadAvail(e.target.value)
            }}
          >
            <option value="">请选择</option>
            {suppliers.map((s: any) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="票种">
          <select className="input" value={form.invoice_type} onChange={(e) => setForm({ ...form, invoice_type: e.target.value })}>
            {INVOICE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </Field>
        <Field label="开票日期">
          <input className="input" type="date" value={form.invoice_date} onChange={(e) => setForm({ ...form, invoice_date: e.target.value })} />
        </Field>
        <Field label="税率 %">
          <input className="input" type="number" value={form.tax_rate} onChange={(e) => setForm({ ...form, tax_rate: e.target.value })} />
        </Field>
        <Field label="发票号" span={2}>
          <input className="input" value={form.invoice_no ?? ''} onChange={(e) => setForm({ ...form, invoice_no: e.target.value })} placeholder="供应商开票号码" />
        </Field>
        <Field label="备注" span={2}>
          <input className="input" value={form.remark ?? ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
        </Field>
      </div>

      <div className="text-[12px] text-ink-700 mb-2 flex items-center gap-1.5">
        <FileText size={13} />
        已入库未开票明细（勾选要开票的行，数量默认取剩余额度）
      </div>
      <div className="table-wrap border border-ink-300 rounded-md">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 44 }}></th>
              <th>SKU 编码</th>
              <th>商品</th>
              <th style={{ width: 90 }} className="text-right">已入库</th>
              <th style={{ width: 90 }} className="text-right">已开票</th>
              <th style={{ width: 90 }} className="text-right">剩余可开</th>
              <th style={{ width: 110 }} className="text-right">本次开票</th>
              <th style={{ width: 110 }} className="text-right">单价</th>
              <th style={{ width: 110 }} className="text-right">金额</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className={Number(l.qty) > Number(l.open_qty) + 1e-6 ? 'bg-red-50' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={!!l.pick}
                    onChange={(e) => setLines(lines.map((x, idx) => (idx === i ? { ...x, pick: e.target.checked } : x)))}
                  />
                </td>
                <td>{l.sku_code}</td>
                <td>{l.sku_name}</td>
                <td className="text-right tabular-nums">{fmtInt(l.recv_qty)}</td>
                <td className="text-right tabular-nums text-ink-500">{fmtInt(l.invoiced_qty)}</td>
                <td className="text-right tabular-nums text-teal-700">{fmtInt(l.open_qty)}</td>
                <td>
                  <input
                    className="input input-sm text-right"
                    type="number"
                    value={l.qty}
                    onChange={(e) => setLines(lines.map((x, idx) => (idx === i ? { ...x, qty: e.target.value, pick: true } : x)))}
                  />
                </td>
                <td>
                  <input
                    className="input input-sm text-right"
                    type="number"
                    value={l.price}
                    onChange={(e) => setLines(lines.map((x, idx) => (idx === i ? { ...x, price: e.target.value } : x)))}
                  />
                </td>
                <td className="text-right tabular-nums">¥{fmtMoney(Number(l.qty) * Number(l.price))}</td>
              </tr>
            ))}
            {!lines.length && (
              <tr>
                <td colSpan={9} className="text-center py-6 text-ink-400">
                  {form.supplier_id ? '该供应商暂无可开票的入库行' : '请先选择供应商'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!!lines.length && (
        <div className="flex items-center justify-between mt-2 text-[13px]">
          <span className="text-ink-500 text-[12px]">
            已选 {picked.length} 行 · 数量 {fmtInt(picked.reduce((s, l) => s + Number(l.qty), 0))}
          </span>
          <span>
            不含税 ¥{fmtMoney(amount)} <span className="text-ink-500 mx-1">+</span> 税额 ¥{fmtMoney(tax)}
            <span className="text-ink-500 mx-1">=</span>
            <b className="text-red-600">价税合计 ¥{fmtMoney(amount + tax)}</b>
          </span>
        </div>
      )}
    </Modal>
  )
}

function DetailModal({ id, onClose, onAct }: any) {
  const { data, loading, reload } = useFetch<any>(id ? `/purchase/invoices/${id}` : null, undefined, [id])
  const doAct = async (action: string) => {
    const okFlag = await onAct(data, action)
    if (okFlag) reload()
  }
  const match = data?.match
  const blocking = match?.blocking || []

  return (
    <Modal open={!!id} title={`采购发票详情 · ${data?.doc_no || ''}`} width={1000} onClose={onClose}>
      {loading && <div className="text-center py-8 text-ink-400 text-[13px]">加载中…</div>}
      {data && (
        <div>
          <div className="grid grid-cols-4 gap-3 mb-3 text-[13px]">
            <div><span className="text-ink-500">状态 </span><Status value={data.status} /></div>
            <div><span className="text-ink-500">供应商 </span>{data.supplier?.name || '-'}</div>
            <div><span className="text-ink-500">发票号 </span>{data.invoice_no || '-'}</div>
            <div><span className="text-ink-500">开票日期 </span>{data.invoice_date}</div>
            <div><span className="text-ink-500">票种 </span>{INVOICE_TYPES.find((x) => x.value === data.invoice_type)?.label || data.invoice_type}</div>
            <div><span className="text-ink-500">不含税 </span>¥{fmtMoney(data.amount)}</div>
            <div><span className="text-ink-500">税额 </span>¥{fmtMoney(data.tax_amount)}</div>
            <div><span className="text-ink-500">价税合计 </span><b>¥{fmtMoney(data.total_amount)}</b></div>
          </div>

          {/* ---- 三单匹配结果 ---- */}
          <div className={`rounded-md border p-3 mb-3 ${blocking.length ? 'border-red-300 bg-red-50' : 'border-teal-300 bg-teal-50/50'}`}>
            <div className="flex items-center gap-1.5 text-[13px] mb-2">
              {blocking.length ? <AlertTriangle size={14} className="text-red-600" /> : <FileText size={14} className="text-teal-700" />}
              <span className={blocking.length ? 'text-red-700' : 'text-teal-700'}>
                {blocking.length ? `三单匹配未通过（${blocking.length} 行超入库量）` : '三单匹配：发票数量未超入库量'}
              </span>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th style={{ width: 110 }} className="text-right">本票数量</th>
                  <th style={{ width: 110 }} className="text-right">已开票</th>
                  <th style={{ width: 110 }} className="text-right">已入库</th>
                  <th style={{ width: 110 }} className="text-right">超量</th>
                </tr>
              </thead>
              <tbody>
                {(match?.lines || []).map((l: any, i: number) => {
                  const over = Number(l.already_invoiced) + Number(l.invoiced) - Number(l.received)
                  return (
                    <tr key={i} className={over > 1e-6 ? 'bg-red-50' : ''}>
                      <td>{l.sku_id}</td>
                      <td className="text-right tabular-nums">{l.invoiced}</td>
                      <td className="text-right tabular-nums">{l.already_invoiced}</td>
                      <td className="text-right tabular-nums">{l.received}</td>
                      <td className="text-right tabular-nums">{over > 1e-6 ? over : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="table-wrap border border-ink-300 rounded-md mb-3">
            <table className="tbl">
              <thead>
                <tr>
                  <th>SKU 编码</th>
                  <th>商品</th>
                  <th style={{ width: 90 }} className="text-right">数量</th>
                  <th style={{ width: 110 }} className="text-right">单价</th>
                  <th style={{ width: 110 }} className="text-right">金额</th>
                  <th style={{ width: 80 }} className="text-right">税率</th>
                  <th style={{ width: 110 }} className="text-right">价税合计</th>
                </tr>
              </thead>
              <tbody>
                {(data.items || []).map((l: any, i: number) => (
                  <tr key={i}>
                    <td>{l.sku_code}</td>
                    <td>{l.sku_name}</td>
                    <td className="text-right tabular-nums">{l.qty}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(l.price)}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(l.amount)}</td>
                    <td className="text-right tabular-nums">{l.tax_rate}%</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(l.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.remark && <div className="text-[12px] text-ink-700 mb-3">备注：{data.remark}</div>}

          <div className="flex items-center gap-2">
            {data.status === 'draft' && (
              <>
                <button className="btn-primary btn-sm" onClick={() => doAct('submit')}>提交</button>
                <button className="btn-ghost btn-sm" onClick={() => doAct('void')}>作废</button>
              </>
            )}
            {data.status === 'submitted' && (
              <>
                <button className="btn-primary btn-sm" onClick={() => doAct('verify')}>发票认证</button>
                <button className="btn-ghost btn-sm" onClick={() => doAct('void')}>作废</button>
              </>
            )}
            {data.status === 'verified' && (
              <>
                <button className="btn-primary btn-sm" onClick={() => doAct('post')}>入账</button>
                <button className="btn-ghost btn-sm" onClick={() => doAct('void')}>作废（红冲前撤销）</button>
              </>
            )}
            {data.status === 'posted' && <span className="text-[12px] text-ink-500">已入账：要冲销请开红字发票，不能直接作废</span>}
          </div>
        </div>
      )}
    </Modal>
  )
}
