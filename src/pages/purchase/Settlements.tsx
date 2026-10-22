/**
 * ============================================================================
 * 文件标识：src/pages/purchase/Settlements.tsx ｜ 采购结算
 * ============================================================================
 * 【职责】采购结算（页面）
 * 【入口】/purchase/settlements
 * 【主要接口】/purchase/settlement-preview、/purchase/settlements
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
 * 页面：采购结算
 */

import { useState } from 'react'
import api from '../../api/client'
import { Card, Field, Modal, StatCard, Status, Table, Tabs, fmtInt, fmtMoney, toast, useFetch, useList } from '../../components/ui'
import { FilterBar, Inp, Sel } from '../../components/DataPage'
import { handleApprovalPending } from '../../api/approval'
import { useOpts } from '../../hooks/opts'
import { RefreshCw, Plus, Eye, Calculator, Wallet } from 'lucide-react'

/**
 * 采购结算（三单匹配）。
 *
 * 三单 = 入库单 + 采购发票 + 费用发票。三种结算模式的含义必须写清楚，否则财务会选错：
 *   auto   自动 —— 按**已认证发票**金额结算（有票先结，最常用）
 *   manual 手工 —— 按**入库暂估**金额结算（票还没来，先按入库暂估挂账）
 *   fee    费用折扣 —— 入库金额 + 费用发票金额（运费、折扣这类要并进结算）
 *
 * 两条硬口径：
 * ① `diff_amount`（暂估差异）**单独一列，不进任何合计** —— 它只是「票面与入库的差额」的账面留痕。
 * ② 「已付金额」永远是 SUM(生效核销明细) 算出来的，不是累加出来的。所以这里有三个数：
 *    已生效核销 / 未生效核销计划（挂在草稿付款单上的）/ 未结清。
 *    只显示一个合计，就会把「钱还没付」看成「已付」。
 *
 * 还有一条：**一单一结** —— 已被未作废结算单引用过的入库单，不会再进新结算单，避免同一批货结两次。
 */
const MODES: { value: string; label: string; hint: string }[] = [
  { value: 'auto', label: '自动（按已认证发票）', hint: '有票先结：以认证过的发票金额为准' },
  { value: 'manual', label: '手工（按入库暂估）', hint: '票未到：按入库金额先挂暂估应付' },
  { value: 'fee', label: '费用折扣（含费用发票）', hint: '入库金额 + 费用发票金额' }
]

/** 动作 → 一次调用（理由见 Invoices.tsx 的 INVOICE_ACTIONS：路径先进变量会让契约检查看不见） */
const SETTLEMENT_ACTIONS: Record<string, (id: any) => Promise<any>> = {
  submit: (id) => api.post(`/purchase/settlements/${id}/submit`),
  audit: (id) => api.post(`/purchase/settlements/${id}/audit`),
  settle: (id) => api.post(`/purchase/settlements/${id}/settle`),
  void: (id) => api.post(`/purchase/settlements/${id}/void`)
}

export default function Settlements() {
  const o = useOpts()
  const [tab, setTab] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const { list, summary, loading, reload } = useList('/purchase/settlements', {})
  const [createOpen, setCreateOpen] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)

  const filtered = list.filter((r: any) => {
    if (tab && r.status !== tab) return false
    if (supplierId && String(r.supplier_id) !== String(supplierId)) return false
    return true
  })

  const act = async (row: any, action: string) => {
    const label: Record<string, string> = { submit: '提交', audit: '审核', settle: '结清', void: '作废' }
    if (!confirm(`确认对 ${row.doc_no} 执行「${label[action] || action}」？`)) return false
    try {
      const call = SETTLEMENT_ACTIONS[action]
      if (!call) return toast(`未知动作 ${action}`, 'error')
      await call(row.id)
      toast('操作成功')
      reload()
      return true
    } catch (e: any) {
      // 模块 22：审核/作废可能被审批闸门拦下
      const handled = await handleApprovalPending(e, {
        docType: 'PST', docId: row.id, docNo: row.doc_no, action, onSubmitted: reload
      })
      if (!handled) toast(e.message, 'error')
      return false
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">采购结算</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">
            三单匹配（入库单 + 采购发票 + 费用发票）→ 审核 → 付款核销后自动结清；一单一结，同一批入库不重复结算
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={reload}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> 新建结算单
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="已结算金额" value={`¥${fmtMoney(summary?.settle, 0)}`} sub="不含已作废" tone="brand" />
        <StatCard label="已付金额" value={`¥${fmtMoney(summary?.paid, 0)}`} sub="按生效核销明细汇总" tone="red" />
        <StatCard label="未结清" value={`¥${fmtMoney(summary?.open, 0)}`} sub="结算额 − 已付" tone="amber" />
        <StatCard label="暂估差异" value={`¥${fmtMoney(summary?.diff, 0)}`} sub="单独一列，不进任何合计" />
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[
              { key: '', label: '全部' },
              { key: 'draft', label: '草稿' },
              { key: 'submitted', label: '待审核' },
              { key: 'audited', label: '已审核待付' },
              { key: 'settled', label: '已结清' }
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>

      <FilterBar onReset={() => setSupplierId('')}>
        <Sel value={supplierId} onChange={setSupplierId} options={o.suppliers} placeholder="全部供应商" w={220} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '结算单号', width: 145, render: (r) => <span className="link" onClick={() => setDetailId(r.id)}>{r.doc_no}</span> },
            { key: 'supplier_name', title: '供应商', width: 210 },
            { key: 'settle_date', title: '结算日期', width: 118 },
            { key: 'settle_mode', title: '模式', width: 108, render: (r) => MODES.find((m) => m.value === r.settle_mode)?.label.split('（')[0] || r.settle_mode },
            { key: 'order_count', title: '订单', width: 60, align: 'right' },
            { key: 'invoice_count', title: '发票', width: 60, align: 'right' },
            { key: 'receipt_amount', title: '入库金额', width: 115, align: 'right', render: (r) => `¥${fmtMoney(r.receipt_amount)}` },
            { key: 'settle_amount', title: '结算金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.settle_amount)}` },
            { key: 'paid_amount', title: '已付', width: 115, align: 'right', render: (r) => `¥${fmtMoney(r.paid_amount)}` },
            { key: 'open_amount', title: '未结清', width: 115, align: 'right', render: (r) => <span className={Number(r.open_amount) > 0.01 ? 'text-amber-700' : 'text-ink-400'}>¥{fmtMoney(r.open_amount)}</span> },
            { key: 'diff_amount', title: '暂估差异', width: 110, align: 'right', render: (r) => (Math.abs(Number(r.diff_amount)) > 0.01 ? `¥${fmtMoney(r.diff_amount)}` : '—') },
            { key: 'status', title: '状态', width: 90, render: (r) => <Status value={r.status} /> },
            {
              key: '__act',
              title: '操作',
              width: 170,
              render: (r) => (
                <div className="flex items-center gap-2 text-[12px]">
                  <button className="link inline-flex items-center gap-1" onClick={() => setDetailId(r.id)}>
                    <Eye size={12} /> 详情
                  </button>
                  {r.status === 'draft' && <button className="link" onClick={() => act(r, 'submit')}>提交</button>}
                  {r.status === 'submitted' && <button className="link" onClick={() => act(r, 'audit')}>审核</button>}
                  {r.status === 'audited' && <button className="link" onClick={() => act(r, 'settle')}>结清</button>}
                </div>
              )
            }
          ]}
          data={filtered}
          loading={loading}
          empty="暂无结算单"
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
  const [form, setForm] = useState<any>({ settle_mode: 'auto', settle_date: today })
  const [preview, setPreview] = useState<any>(null)
  const [saving, setSaving] = useState(false)

  const doPreview = async (sid: string) => {
    if (!sid) return setPreview(null)
    try {
      const res = await api.get('/purchase/settlement-preview', {
        supplier_id: sid,
        period_start: form.period_start || undefined,
        period_end: form.period_end || undefined
      })
      setPreview(res.data)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const submit = async () => {
    if (!form.supplier_id) return toast('请选择供应商', 'error')
    setSaving(true)
    try {
      const res = await api.post('/purchase/settlements', {
        supplier_id: Number(form.supplier_id),
        settle_date: form.settle_date,
        period_start: form.period_start || null,
        period_end: form.period_end || null,
        settle_mode: form.settle_mode,
        remark: form.remark || null
      })
      toast(`结算单已生成 ${res.data?.doc_no || ''}`)
      onClose()
      onSaved()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const mode = MODES.find((m) => m.value === form.settle_mode)
  // 三种模式的结算额预演：让财务在落单前就看到「会结出多少」，而不是建了再作废
  const projected =
    form.settle_mode === 'auto'
      ? Number(preview?.invoice_amount || 0)
      : form.settle_mode === 'fee'
        ? Number(preview?.receipt_amount || 0) + Number(preview?.fee_amount || 0)
        : Number(preview?.receipt_amount || 0)

  return (
    <Modal
      open={open}
      title="新建采购结算单"
      width={860}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={() => doPreview(form.supplier_id)} disabled={!form.supplier_id}>
            <Calculator size={13} /> 结算试算
          </button>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '生成中…' : '生成结算单'}</button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4 mb-4">
        <Field label="供应商" required>
          <select
            className="input"
            value={form.supplier_id ?? ''}
            onChange={(e) => {
              setForm({ ...form, supplier_id: e.target.value })
              doPreview(e.target.value)
            }}
          >
            <option value="">请选择</option>
            {suppliers.map((s: any) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </Field>
        <Field label="结算模式" hint={mode?.hint}>
          <select className="input" value={form.settle_mode} onChange={(e) => setForm({ ...form, settle_mode: e.target.value })}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </Field>
        <Field label="结算日期">
          <input className="input" type="date" value={form.settle_date} onChange={(e) => setForm({ ...form, settle_date: e.target.value })} />
        </Field>
        <Field label="期间起">
          <input className="input" type="date" value={form.period_start ?? ''} onChange={(e) => setForm({ ...form, period_start: e.target.value })} />
        </Field>
        <Field label="期间止">
          <input className="input" type="date" value={form.period_end ?? ''} onChange={(e) => setForm({ ...form, period_end: e.target.value })} />
        </Field>
        <Field label="备注">
          <input className="input" value={form.remark ?? ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
        </Field>
      </div>

      {preview && (
        <div className="rounded-md border border-ink-300 p-3">
          <div className="text-[13px] text-ink-900 mb-2">结算试算（{form.period_start || '不限'} ~ {form.period_end || '不限'}）</div>
          <div className="grid grid-cols-4 gap-3 text-[13px]">
            <div>
              <div className="text-ink-500 text-[12px]">可结入库单</div>
              <div>{fmtInt(preview.receipt_count)} 单</div>
              <div className="text-ink-700">¥{fmtMoney(preview.receipt_amount)}</div>
            </div>
            <div>
              <div className="text-ink-500 text-[12px]">可结发票</div>
              <div>{fmtInt(preview.invoice_count)} 张</div>
              <div className="text-ink-700">¥{fmtMoney(preview.invoice_amount)}</div>
            </div>
            <div>
              <div className="text-ink-500 text-[12px]">费用发票</div>
              <div>—</div>
              <div className="text-ink-700">¥{fmtMoney(preview.fee_amount)}</div>
            </div>
            <div>
              <div className="text-ink-500 text-[12px]">本次预计结算</div>
              <div className="text-red-600 font-medium">¥{fmtMoney(projected)}</div>
            </div>
          </div>
          {preview.hint && <div className="text-[12px] text-amber-700 mt-2">{preview.hint}</div>}
          <div className="text-[12px] text-ink-500 mt-2">
            提示：已被其他未作废结算单引用过的入库单不会再被结算（一单一结），所以这里算出的金额可能与入库总量不同。
          </div>
        </div>
      )}
    </Modal>
  )
}

function DetailModal({ id, onClose, onAct }: any) {
  const { data, loading, reload } = useFetch<any>(id ? `/purchase/settlements/${id}` : null, undefined, [id])
  const doAct = async (action: string) => {
    const okFlag = await onAct(data, action)
    if (okFlag) reload()
  }
  const payments: any[] = data?.payments || []
  const effective = payments.filter((p) => p.payment_status === 'approved' || p.payment_status === 'paid')
  const pending = payments.filter((p) => !p.payment_status || p.payment_status === 'draft')

  return (
    <Modal open={!!id} title={`结算单详情 · ${data?.doc_no || ''}`} width={1040} onClose={onClose}>
      {loading && <div className="text-center py-8 text-ink-400 text-[13px]">加载中…</div>}
      {data && (
        <div>
          <div className="grid grid-cols-4 gap-3 mb-3 text-[13px]">
            <div><span className="text-ink-500">状态 </span><Status value={data.status} /></div>
            <div><span className="text-ink-500">供应商 </span>{data.supplier?.name || '-'}</div>
            <div><span className="text-ink-500">结算日期 </span>{data.settle_date}</div>
            <div><span className="text-ink-500">模式 </span>{MODES.find((m) => m.value === data.settle_mode)?.label || data.settle_mode}</div>
          </div>

          <div className="grid grid-cols-4 gap-3 mb-3">
            <StatCard label="结算金额" value={`¥${fmtMoney(data.settle_amount, 0)}`} tone="brand" />
            <StatCard label="已生效核销" value={`¥${fmtMoney(data.settled_amount, 0)}`} sub={`${effective.length} 张付款单`} tone="red" />
            <StatCard label="未生效（草稿付款单）" value={`¥${fmtMoney(data.pending_amount, 0)}`} sub={`${pending.length} 张 · 只是计划`} tone="amber" />
            <StatCard label="未结清" value={`¥${fmtMoney(data.open_amount, 0)}`} />
          </div>

          <div className="rounded-md border border-ink-300 bg-ink-50/50 px-3 py-2 mb-3 text-[12px] text-ink-700 flex items-center gap-4">
            <span>暂估差异 <b className="text-ink-900">¥{fmtMoney(data.diff_amount)}</b>（单独一列，不进任何合计）</span>
            <span>入库 ¥{fmtMoney(data.receipt_amount)}</span>
            <span>发票 ¥{fmtMoney(data.invoice_amount)}</span>
            <span>费用 ¥{fmtMoney(data.fee_amount)}</span>
          </div>

          <div className="table-wrap border border-ink-300 rounded-md mb-3">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>来源</th>
                  <th style={{ width: 150 }}>来源单号</th>
                  <th>SKU 编码</th>
                  <th>商品</th>
                  <th style={{ width: 90 }} className="text-right">数量</th>
                  <th style={{ width: 110 }} className="text-right">单价</th>
                  <th style={{ width: 110 }} className="text-right">金额</th>
                  <th style={{ width: 110 }} className="text-right">最终成本</th>
                </tr>
              </thead>
              <tbody>
                {(data.items || []).map((l: any, i: number) => (
                  <tr key={i}>
                    <td>{l.source_type === 'receipt' ? '入库单' : l.source_type === 'invoice' ? '发票' : l.source_type}</td>
                    <td>{l.source_doc_no}</td>
                    <td>{l.sku_code}</td>
                    <td>{l.sku_name}</td>
                    <td className="text-right tabular-nums">{l.qty}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(l.price)}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(l.amount)}</td>
                    <td className="text-right tabular-nums">¥{fmtMoney(l.final_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ---- 核销明细：必须把「生效」与「未生效」分开 ---- */}
          <div className="text-[13px] text-ink-900 mb-2 flex items-center gap-1.5">
            <Wallet size={13} /> 付款核销明细
          </div>
          <div className="table-wrap border border-ink-300 rounded-md mb-3">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>付款单号</th>
                  <th style={{ width: 110 }}>付款日期</th>
                  <th style={{ width: 110 }} className="text-right">核销金额</th>
                  <th style={{ width: 100 }}>付款单状态</th>
                  <th>是否生效</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p: any, i: number) => {
                  const live = p.payment_status === 'approved' || p.payment_status === 'paid'
                  return (
                    <tr key={i}>
                      <td>{p.payment_doc_no || p.doc_no}</td>
                      <td>{p.pay_date}</td>
                      <td className="text-right tabular-nums">¥{fmtMoney(p.amount)}</td>
                      <td><Status value={p.payment_status} text={p.payment_status === 'paid' ? '已付款' : undefined} /></td>
                      <td className={live ? 'text-teal-700 text-[12px]' : 'text-amber-700 text-[12px]'}>
                        {live ? '已生效（计入已付）' : '未生效（草稿：只是计划）'}
                      </td>
                    </tr>
                  )
                })}
                {!payments.length && (
                  <tr>
                    <td colSpan={5} className="text-center py-6 text-ink-400">尚无付款核销</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2">
            {data.status === 'draft' && (
              <>
                <button className="btn-primary btn-sm" onClick={() => doAct('submit')}>提交</button>
                <button className="btn-ghost btn-sm" onClick={() => doAct('void')}>作废</button>
              </>
            )}
            {data.status === 'submitted' && (
              <>
                <button className="btn-primary btn-sm" onClick={() => doAct('audit')}>审核</button>
                <button className="btn-ghost btn-sm" onClick={() => doAct('void')}>作废</button>
              </>
            )}
            {data.status === 'audited' && <button className="btn-primary btn-sm" onClick={() => doAct('settle')}>结清</button>}
            {data.status === 'settled' && <span className="text-[12px] text-ink-500">已结清（核销足额自动推进，不能回退）</span>}
          </div>
        </div>
      )}
    </Modal>
  )
}
