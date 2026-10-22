/**
 * ============================================================================
 * 文件标识：src/pages/sales/Invoices.tsx ｜ SalesInvoices（页面，未取到标题）
 * ============================================================================
 * 【职责】SalesInvoices（页面，未取到标题）（页面）
 * 【入口】/sales/invoices
 * 【主要接口】/invoices/overview、/invoices/audit、/master/options
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
 * 页面：SalesInvoices（页面，未取到标题）
 */

import { useEffect, useState } from 'react'
import {
  Card, SectionTitle, StatCard, Table, Empty, Modal, Field, Tabs, Pagination,
  fmtMoney, fmtInt, toast, useFetch
} from '../../components/ui'
import { FilterBar, Sel, Inp } from '../../components/DataPage'
import {
  SI_PENDING_LINES, SI_GET,
  SI_FROM_DELIVERY, SI_MANUAL, SI_SUBMIT, SI_CONFIRM, SI_RED_CHART, SI_VOID, SI_REFRESH_CLOSE,
  SI_STATUS_CLS, SI_STATUS_LABEL, INVOICE_STATUS_CLS, INVOICE_STATUS_LABEL,
  type SalesInvoice, type InvoiceDetail, type PendingDelivery, type PendingLine
} from '../../api/invoices'
import { RefreshCw, Plus, CheckCircle2, Ban, Undo2, Send, Receipt, AlertTriangle, Layers } from 'lucide-react'

/**
 * 销售发票（模块 24）。
 *
 * 三个页签对应三种视角：
 *   ① 总览：开了多少票、交了多少税、还有多少发货没开票；底下挂自洽审计，有漂移立即可见。
 *   ② 待开票队列：财务每天开工第一眼看的地方 —— 哪些货发了、票还没开；在这里一键开票（支持分批）。
 *   ③ 发票列表：逐张票看状态与去向（关联了哪张应收），并完成提交 / 确认 / 红冲 / 作废。
 *
 * 界面上钉死的三条口径：
 *   ① 没有「改库存」的入口 —— 开票只产生债权，不动库存。
 *   ② 没有手工「关闭」按钮 —— 开票关闭状态由事实（发票行 SUM 与发货量比对）推导。
 *   ③ 红冲不删原票 —— 原票与红字票并排展示，不隐藏任何一张。
 */
function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[12px] text-slate-500 whitespace-nowrap">{label}</span>
      {children}
    </div>
  )
}

const pill = (map: Record<string, string>, v: string) =>
  `inline-block px-2 py-[1px] rounded border text-[12px] ${map[v] || 'text-slate-600 bg-slate-50 border-slate-200'}`

export default function SalesInvoices() {
  const [tab, setTab] = useState<'overview' | 'pending' | 'invoices'>('overview')
  const [tick, setTick] = useState(0)
  const reload = () => setTick((t) => t + 1)

  const { data: ov } = useFetch<any>('/invoices/overview', undefined, [tick])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionTitle
          title="销售发票"
          desc="开票只产生债权不动库存 · 开票关闭由发票数量与发货数量比对推导 · 确认开票才生成/关联应收 · 红冲不删原票"
        />
        <button className="btn-ghost" onClick={reload}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      <Tabs
        tabs={[
          { key: 'overview', label: '总览' },
          { key: 'pending', label: '待开票队列', count: ov?.pending_deliveries },
          { key: 'invoices', label: '发票列表' }
        ]}
        value={tab}
        onChange={(k) => setTab(k as any)}
      />

      {tab === 'overview' && <OverviewTab tick={tick} ov={ov} reload={reload} />}
      {tab === 'pending' && <PendingTab tick={tick} reload={reload} />}
      {tab === 'invoices' && <InvoicesTab tick={tick} reload={reload} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ① 总览
// ---------------------------------------------------------------------------

function OverviewTab({ tick, ov, reload }: { tick: number; ov: any; reload: () => void }) {
  const { data: audit } = useFetch<any>('/invoices/audit', undefined, [tick])
  const [busy, setBusy] = useState(false)

  const refreshClose = async () => {
    setBusy(true)
    try {
      const r = await SI_REFRESH_CLOSE()
      toast(`已重推 ${r.deliveries} 张发货单 / ${r.orders} 张订单的开票关闭状态`, 'success')
      reload()
    } catch (e: any) {
      toast(e.message || '重推失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const driftCount = (audit?.headDrift?.length || 0) + (audit?.overQty?.length || 0) + (audit?.missingAr?.length || 0) + (audit?.orphanLinks?.length || 0) + (audit?.badClose?.length || 0)
  const byStatus: { status: string; c: number; amt: number }[] = ov?.by_status || []

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="已开票金额（价税合计）" value={fmtMoney(ov?.confirmed_amount || 0)} tone="brand" icon={<Receipt size={16} />} sub={`${fmtInt(ov?.confirmed_count || 0)} 张已确认`} />
        <StatCard label="其中税额" value={fmtMoney(ov?.tax_amount || 0)} sub="销项税额（价税分离得出）" />
        <StatCard label="待确认发票" value={fmtInt(ov?.pending_confirm || 0)} tone={ov?.pending_confirm ? 'warn' : 'default'} sub="草稿 + 待确认（未生效）" />
        <StatCard label="待开票发货单" value={fmtInt(ov?.pending_deliveries || 0)} tone={ov?.pending_deliveries ? 'warn' : 'good'} icon={<Layers size={16} />} sub="已发货但未开完票" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="红字票张数" value={fmtInt(ov?.red_count || 0)} tone={ov?.red_count ? 'bad' : 'default'} sub="红冲产生的负数票" />
        <StatCard label="红字票金额（负数）" value={fmtMoney(ov?.red_amount || 0)} tone={ov?.red_count ? 'bad' : 'default'} />
      </div>

      <Card>
        <SectionTitle title="按状态分布" desc="草稿与待确认不参与开票关闭（没生效的动作不产生后果）" />
        {byStatus.length === 0 ? (
          <Empty text="还没有发票" />
        ) : (
          <Table
            data={byStatus}
            empty="—"
            columns={[
              { key: 'status', title: '状态', render: (r) => <span className={pill(SI_STATUS_CLS, r.status)}>{SI_STATUS_LABEL[r.status] || r.status}</span> },
              { key: 'c', title: '张数', align: 'right', render: (r) => fmtInt(r.c) },
              { key: 'amt', title: '价税合计', align: 'right', render: (r) => fmtMoney(r.amt) }
            ]}
          />
        )}
      </Card>

      <Card>
        <SectionTitle
          title="自洽审计"
          desc="头金额必须等于行 SUM；不得超开；已确认票必须有应收关联；开票关闭状态不得漂移"
          right={
            <button className="btn-ghost btn-sm" disabled={busy} onClick={refreshClose}>
              <RefreshCw size={13} /> 重推开票关闭状态
            </button>
          }
        />
        {audit?.ok ? (
          <div className="flex items-center gap-2 text-[13px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
            <CheckCircle2 size={15} /> 五类检查全部通过：头行一致、无超开、已完成票均有应收关联、无孤儿关联、关闭状态无漂移
          </div>
        ) : (
          <div className="space-y-2 text-[13px]">
            <div className="text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-center gap-2">
              <AlertTriangle size={14} /> 发现 {driftCount} 处不一致
            </div>
            <Table
              data={[
                ...(audit?.headDrift || []).map((r: any) => ({ ...r, _t: '头金额与行 SUM 不符' })),
                ...(audit?.overQty || []).map((r: any) => ({ ...r, _t: '超开发票', doc_no: `发货行 ${r.source_line_no}` })),
                ...(audit?.missingAr || []).map((r: any) => ({ ...r, _t: '已确认票缺应收关联' })),
                ...(audit?.orphanLinks || []).map((r: any) => ({ ...r, _t: '孤儿关联', doc_no: `link#${r.id}` })),
                ...(audit?.badClose || []).map((r: any) => ({ ...r, _t: '关闭状态漂移', doc_no: r.doc_no }))
              ]}
              empty="—"
              columns={[
                { key: '_t', title: '问题', width: 220 },
                { key: 'doc_no', title: '单据', width: 160 },
                { key: 'total_amount', title: '金额', align: 'right', render: (r) => (r.total_amount == null ? '-' : fmtMoney(r.total_amount)) },
                { key: 'detail', title: '说明', render: (r) => r.detail || (r.real_qty != null ? `应为 ${r.real_qty}，实为 ${r.invoice_qty_sum}` : '') }
              ]}
            />
          </div>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ② 待开票队列
// ---------------------------------------------------------------------------

function PendingTab({ tick, reload }: { tick: number; reload: () => void }) {
  const [keyword, setKeyword] = useState('')
  const [onlyNone, setOnlyNone] = useState('')
  const { data, loading } = useFetch<any>(
    '/invoices/pending',
    { keyword: keyword || undefined, only_none: onlyNone || undefined },
    [tick, keyword, onlyNone]
  )
  const rows: PendingDelivery[] = data?.rows || []
  const [target, setTarget] = useState<PendingDelivery | null>(null)

  return (
    <div className="space-y-3">
      <FilterBar onReset={() => { setKeyword(''); setOnlyNone('') }}>
        <F label="搜索">
          <Inp value={keyword} onChange={setKeyword} placeholder="发货单号 / 订单号" w={220} />
        </F>
        <F label="开票状态">
          <Sel value={onlyNone} onChange={setOnlyNone} options={[{ value: '', label: '全部' }, { value: '1', label: '只看未开票' }]} />
        </F>
      </FilterBar>

      <Card pad={false}>
        <div className="px-3 pt-3">
          <SectionTitle title="待开票队列" desc="已发货/已签收且还有未开数量的发货单；点行开票，可分批" />
        </div>
        <Table
          loading={loading}
          data={rows}
          onRowClick={(r) => setTarget(r)}
          empty="没有待开票的发货单"
          columns={[
            { key: 'doc_no', title: '发货单号', width: 150 },
            { key: 'order_no', title: '订单号', width: 150, render: (r) => r.order_no || '-' },
            { key: 'delivery_date', title: '发货日期', width: 110 },
            { key: 'subject_type', title: '客户类型', width: 90, render: (r) => (r.subject_type === 'dealer' ? '经销商' : '门店') },
            { key: 'total_qty', title: '发货数量', align: 'right', render: (r) => fmtInt(r.total_qty) },
            { key: 'invoice_qty_sum', title: '已开票量', align: 'right', render: (r) => fmtInt(r.invoice_qty_sum) },
            { key: 'remain_qty', title: '剩余可开', align: 'right', render: (r) => <span className="font-medium text-amber-600">{fmtInt(r.remain_qty)}</span> },
            { key: 'invoice_status', title: '开票状态', width: 100, render: (r) => <span className={pill(INVOICE_STATUS_CLS, r.invoice_status)}>{INVOICE_STATUS_LABEL[r.invoice_status] || r.invoice_status}</span> },
            {
              key: '_op', title: '操作', width: 90,
              render: (r) => (
                <button className="btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); setTarget(r) }}>
                  <Plus size={12} /> 开票
                </button>
              )
            }
          ]}
        />
      </Card>

      <InvoiceFromDeliveryModal
        delivery={target}
        onClose={() => setTarget(null)}
        onDone={() => { setTarget(null); reload() }}
      />
    </div>
  )
}

/** 由发货单开票：默认整单未开行开完，可改数量实现分批 */
function InvoiceFromDeliveryModal({ delivery, onClose, onDone }: { delivery: PendingDelivery | null; onClose: () => void; onDone: () => void }) {
  const [lines, setLines] = useState<PendingLine[]>([])
  const [qty, setQty] = useState<Record<number, number>>({})
  const [taxRate, setTaxRate] = useState('0.13')
  const [invoiceNo, setInvoiceNo] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!delivery) return
    setInvoiceNo('')
    setBusy(false)
    SI_PENDING_LINES(delivery.id)
      .then((r) => {
        setLines(r.lines)
        const m: Record<number, number> = {}
        for (const l of r.lines) m[l.item_id] = l.remain_qty
        setQty(m)
      })
      .catch((e: any) => toast(e.message || '加载待开行失败', 'error'))
  }, [delivery])

  const selected = lines.filter((l) => Number(qty[l.item_id]) > 0)
  const totalIncl = selected.reduce((s, l) => {
    const unitIncl = Number(l.qty) > 0 ? Number(l.amount) / Number(l.qty) : Number(l.price) || 0
    return s + unitIncl * Number(qty[l.item_id] || 0)
  }, 0)
  const rate = Number(taxRate) || 0
  const amountEx = rate > 0 ? totalIncl / (1 + rate) : totalIncl
  const tax = totalIncl - amountEx

  const submit = async () => {
    if (!delivery) return
    if (!selected.length) return toast('请至少填写一行的开票数量', 'error')
    setBusy(true)
    try {
      const r = await SI_FROM_DELIVERY({
        delivery_id: delivery.id,
        invoice_date: invoiceDate,
        invoice_no: invoiceNo || undefined,
        tax_rate: rate,
        items: selected.map((l) => ({ item_id: l.item_id, qty: Number(qty[l.item_id]) })),
        remark: '发票页由发货单开票'
      })
      toast(`已生成草稿发票 ${r.doc_no}（价税合计 ${fmtMoney(r.total_amount)}）`, 'success')
      onDone()
    } catch (e: any) {
      toast(e.message || '开票失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={!!delivery}
      title={`由发货单开票 · ${delivery?.doc_no || ''}`}
      onClose={onClose}
      width={860}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={submit}>
            <Plus size={13} /> 生成草稿发票
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label="开票日期"><Inp type="date" value={invoiceDate} onChange={setInvoiceDate} w={160} /></Field>
          <Field label="税务发票号（可后补）"><Inp value={invoiceNo} onChange={setInvoiceNo} placeholder="纸质/电子票面号" w={200} /></Field>
          <Field label="税率"><Inp value={taxRate} onChange={setTaxRate} w={100} /></Field>
        </div>

        <Table
          data={lines}
          empty="该发货单没有可开数量"
          columns={[
            { key: 'item_id', title: '发货行', width: 80 },
            { key: 'sku_id', title: 'SKU', width: 90, render: (r) => `#${r.sku_id}` },
            { key: 'batch_no', title: '批次', width: 110, render: (r) => r.batch_no || '-' },
            { key: 'qty', title: '发货数量', align: 'right', render: (r) => fmtInt(r.qty) },
            { key: 'invoiced_qty', title: '已开票', align: 'right', render: (r) => fmtInt(r.invoiced_qty) },
            { key: 'remain_qty', title: '剩余可开', align: 'right', render: (r) => fmtInt(r.remain_qty) },
            {
              key: 'pick', title: '本次开票数量', width: 140,
              render: (r) => (
                <input
                  className="input input-sm text-right"
                  style={{ width: 110 }}
                  type="number"
                  min={0}
                  max={r.remain_qty}
                  value={qty[r.item_id] ?? ''}
                  onChange={(e) => setQty((m) => ({ ...m, [r.item_id]: Math.min(Number(e.target.value) || 0, r.remain_qty) }))}
                />
              )
            }
          ]}
        />

        <div className="flex justify-end gap-6 text-[13px] text-slate-600 pr-1">
          <span>不含税：<b className="text-slate-800">{fmtMoney(amountEx)}</b></span>
          <span>税额：<b className="text-slate-800">{fmtMoney(tax)}</b></span>
          <span>价税合计：<b className="text-brand-700">{fmtMoney(totalIncl)}</b></span>
        </div>
        <div className="text-[12px] text-slate-500 bg-slate-50 border border-slate-200 rounded px-3 py-2">
          生成的是<b>草稿</b>发票 —— 草稿不参与开票关闭，需在「发票列表」里提交并确认后债权才成立。价税拆分按含税单价反推（不含税 = 含税 ÷ (1 + 税率)）。
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// ③ 发票列表
// ---------------------------------------------------------------------------

function InvoicesTab({ tick, reload }: { tick: number; reload: () => void }) {
  const [status, setStatus] = useState('')
  const [invType, setInvType] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const { data, loading } = useFetch<any>(
    '/invoices/list',
    { status: status || undefined, invoice_type: invType || undefined, keyword: keyword || undefined, page, pageSize: 20 },
    [tick, status, invType, keyword, page]
  )
  const rows: SalesInvoice[] = data?.rows || []

  const [detail, setDetail] = useState<InvoiceDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [redTarget, setRedTarget] = useState<SalesInvoice | null>(null)
  const [redReason, setRedReason] = useState('')

  const openDetail = async (id: number) => {
    try {
      setDetail(await SI_GET(id))
    } catch (e: any) {
      toast(e.message || '打开失败', 'error')
    }
  }

  const act = async (fn: () => Promise<any>, okMsg: string, afterDetailId?: number) => {
    setBusy(true)
    try {
      await fn()
      toast(okMsg, 'success')
      reload()
      if (afterDetailId) setDetail(await SI_GET(afterDetailId))
    } catch (e: any) {
      toast(e.message || '操作失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const doRedChart = async () => {
    if (!redTarget) return
    if (!redReason.trim()) return toast('红冲必须填写原因', 'error')
    await act(async () => {
      const r = await SI_RED_CHART(redTarget.id, redReason.trim())
      setDetail(r.invoice)
    }, '已红冲：原票留痕，并生成红字票', redTarget.id)
    setRedTarget(null)
    setRedReason('')
  }

  return (
    <div className="space-y-3">
      <FilterBar onReset={() => { setStatus(''); setInvType(''); setKeyword(''); setPage(1) }}>
        <F label="搜索">
          <Inp value={keyword} onChange={setKeyword} placeholder="单号 / 票号 / 客户 / 订单号" w={220} />
        </F>
        <F label="状态">
          <Sel value={status} onChange={setStatus} options={Object.entries(SI_STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
        </F>
        <F label="票种">
          <Sel value={invType} onChange={setInvType} options={[{ value: 'normal', label: '蓝字' }, { value: 'red', label: '红字' }]} />
        </F>
      </FilterBar>

      <Card pad={false}>
        <div className="px-3 pt-3 flex items-center justify-between">
          <SectionTitle title="发票列表" desc="点行看详情与关联应收；已开票的可红冲，草稿可提交或作废" />
          <button className="btn-primary btn-sm" onClick={() => setManualOpen(true)}>
            <Plus size={13} /> 手工开票
          </button>
        </div>
        <Table
          loading={loading}
          data={rows}
          onRowClick={(r) => openDetail(r.id)}
          empty="没有符合条件的发票"
          columns={[
            { key: 'doc_no', title: '发票单号', width: 150 },
            {
              key: 'invoice_type', title: '票种', width: 70,
              render: (r) => (r.invoice_type === 'red' ? <span className="text-rose-600 font-medium">红字</span> : <span className="text-slate-600">蓝字</span>)
            },
            { key: 'invoice_no', title: '税务发票号', width: 130, render: (r) => r.invoice_no || '-' },
            { key: 'subject_name', title: '客户', render: (r) => r.subject_name || '-' },
            { key: 'source_doc_no', title: '来源单号', width: 140, render: (r) => r.source_doc_no || (r.source_type === 'MANUAL' ? '手工开票' : '-') },
            { key: 'invoice_date', title: '开票日期', width: 110 },
            { key: 'total_amount', title: '价税合计', align: 'right', render: (r) => fmtMoney(r.total_amount) },
            { key: 'tax_amount', title: '税额', align: 'right', render: (r) => fmtMoney(r.tax_amount) },
            { key: 'ar_doc_no', title: '关联应收', width: 140, render: (r) => r.ar_doc_no || '-' },
            { key: 'status', title: '状态', width: 100, render: (r) => <span className={pill(SI_STATUS_CLS, r.status)}>{SI_STATUS_LABEL[r.status] || r.status}</span> },
            {
              key: '_op', title: '操作', width: 150,
              render: (r) => (
                <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                  {r.status === 'draft' && <button className="btn-ghost btn-sm" disabled={busy} onClick={() => act(() => SI_SUBMIT(r.id), '已提交，等待确认开票')}><Send size={12} />提交</button>}
                  {r.status === 'pending' && <button className="btn-primary btn-sm" disabled={busy} onClick={() => act(() => SI_CONFIRM(r.id), '已确认开票：债权成立', r.id)}><CheckCircle2 size={12} />确认</button>}
                  {r.status === 'confirmed' && <button className="btn-ghost btn-sm text-rose-600" disabled={busy} onClick={() => { setRedTarget(r); setRedReason('') }}><Undo2 size={12} />红冲</button>}
                  {(r.status === 'draft' || r.status === 'pending') && <button className="btn-ghost btn-sm" disabled={busy} onClick={() => act(() => SI_VOID(r.id, '作废'), '已作废')}><Ban size={12} />作废</button>}
                </div>
              )
            }
          ]}
        />
        <div className="px-3 pb-3">
          <Pagination page={data?.page || 1} pageSize={data?.pageSize || 20} total={data?.total || 0} onChange={setPage} />
        </div>
      </Card>

      <InvoiceDetailModal detail={detail} onClose={() => setDetail(null)} />
      <ManualInvoiceModal open={manualOpen} onClose={() => setManualOpen(false)} onDone={() => { setManualOpen(false); reload() }} />

      <Modal
        open={!!redTarget}
        title={`红冲发票 · ${redTarget?.doc_no || ''}`}
        onClose={() => setRedTarget(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setRedTarget(null)}>取消</button>
            <button className="btn-primary" disabled={busy} onClick={doRedChart}>确认红冲</button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="text-[13px] text-slate-600">
            红冲会：① 把原票置为「已红冲」（不删除）；② 把关联合应收置为「已作废」；③ 自动生成一张红字负数票并指回原票。
          </div>
          {redTarget && (
            <div className="text-[13px] bg-slate-50 border border-slate-200 rounded px-3 py-2">
              原票 {redTarget.doc_no} · 价税合计 <b>{fmtMoney(redTarget.total_amount)}</b> · 将生成红字票 <b className="text-rose-600">{fmtMoney(-Number(redTarget.total_amount))}</b>
            </div>
          )}
          <Field label="红冲原因" required>
            <textarea className="input" rows={3} value={redReason} onChange={(e) => setRedReason(e.target.value)} placeholder="例如：开票信息有误，需重开" />
          </Field>
          <div className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            若该发票关联的应收已收款，则需先作废对应收款单才能红冲。
          </div>
        </div>
      </Modal>
    </div>
  )
}

function InvoiceDetailModal({ detail, onClose }: { detail: InvoiceDetail | null; onClose: () => void }) {
  if (!detail) return null
  const balance = Number(detail.total_amount)
  return (
    <Modal open={!!detail} title={`发票详情 · ${detail.doc_no}`} onClose={onClose} width={920} footer={<button className="btn-ghost" onClick={onClose}>关闭</button>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[13px]">
          <div><div className="text-slate-500 text-[12px]">客户</div><div className="text-slate-800">{detail.subject_name || '-'}</div></div>
          <div><div className="text-slate-500 text-[12px]">状态</div><div><span className={pill(SI_STATUS_CLS, detail.status)}>{SI_STATUS_LABEL[detail.status]}</span></div></div>
          <div><div className="text-slate-500 text-[12px]">开票日期</div><div className="text-slate-800">{detail.invoice_date}</div></div>
          <div><div className="text-slate-500 text-[12px]">税务发票号</div><div className="text-slate-800">{detail.invoice_no || '-'}</div></div>
          <div><div className="text-slate-500 text-[12px]">来源</div><div className="text-slate-800">{detail.source_doc_no || (detail.source_type === 'MANUAL' ? '手工开票' : '-')}</div></div>
          <div><div className="text-slate-500 text-[12px]">订单号</div><div className="text-slate-800">{detail.order_no || '-'}</div></div>
          <div><div className="text-slate-500 text-[12px]">不含税金额</div><div className="text-slate-800">{fmtMoney(detail.amount)}</div></div>
          <div><div className="text-slate-500 text-[12px]">税额 / 价税合计</div><div className="text-slate-800">{fmtMoney(detail.tax_amount)} / <b className="text-brand-700">{fmtMoney(balance)}</b></div></div>
        </div>

        {detail.remark && <div className="text-[12px] text-slate-500 bg-slate-50 border border-slate-200 rounded px-3 py-2">备注：{detail.remark}</div>}

        <div>
          <SectionTitle title="发票行" />
          <Table
            data={detail.items}
            empty="—"
            columns={[
              { key: 'line_no', title: '#', width: 50 },
              { key: 'sku_name', title: '商品', render: (r) => r.sku_name || (r.sku_id ? `#${r.sku_id}` : '-') },
              { key: 'qty', title: '数量', align: 'right', render: (r) => fmtInt(r.qty) },
              { key: 'price', title: '不含税单价', align: 'right', render: (r) => fmtMoney(r.price) },
              { key: 'amount', title: '不含税金额', align: 'right', render: (r) => fmtMoney(r.amount) },
              { key: 'tax_amount', title: '税额', align: 'right', render: (r) => fmtMoney(r.tax_amount) },
              { key: 'total_amount', title: '价税合计', align: 'right', render: (r) => fmtMoney(r.total_amount) },
              { key: 'source_delivery_no', title: '来源发货单', width: 140, render: (r) => r.source_delivery_no || '-' }
            ]}
          />
        </div>

        <div>
          <SectionTitle title="关联应收" desc="确认开票时生成或关联的应收单（债权落点）" />
          {detail.links.length === 0 ? (
            <Empty text="尚未关联应收（草稿/待确认票不产生债权）" />
          ) : (
            <Table
              data={detail.links}
              empty="—"
              columns={[
                { key: 'ar_no', title: '应收单号', width: 150 },
                { key: 'relation', title: '关系', width: 100, render: (r) => (r.relation === 'linked' ? '关联既有' : '本票生成') },
                { key: 'ar_amount', title: '应收金额', align: 'right', render: (r) => fmtMoney(r.ar_amount) },
                { key: 'ar_allocated', title: '已收', align: 'right', render: (r) => fmtMoney(r.ar_allocated) },
                { key: 'ar_status', title: '应收状态', width: 100 }
              ]}
            />
          )}
        </div>

        {(detail.red_invoices.length > 0 || detail.origin_invoice) && (
          <div>
            <SectionTitle title="红冲关系" desc="红冲不删原票：原票与红字票都在，账才追得回来" />
            <Table
              data={[
                ...(detail.origin_invoice ? [{ _t: '原票', ...detail.origin_invoice }] : []),
                ...detail.red_invoices.map((r) => ({ _t: '红字票', ...r }))
              ]}
              empty="—"
              columns={[
                { key: '_t', title: '类型', width: 90, render: (r) => (r._t === '原票' ? <span className="text-slate-600">原票</span> : <span className="text-rose-600">红字票</span>) },
                { key: 'doc_no', title: '单号', width: 160 },
                { key: 'status', title: '状态', width: 110, render: (r) => <span className={pill(SI_STATUS_CLS, r.status)}>{SI_STATUS_LABEL[r.status] || r.status}</span> },
                { key: 'total_amount', title: '价税合计', align: 'right', render: (r) => <span className={Number(r.total_amount) < 0 ? 'text-rose-600' : ''}>{fmtMoney(r.total_amount)}</span> }
              ]}
            />
          </div>
        )}
      </div>
    </Modal>
  )
}

/** 手工开票：无来源单据，补开历史票 / 特殊业务 */
function ManualInvoiceModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [subjectType, setSubjectType] = useState('dealer')
  const [subjectId, setSubjectId] = useState('')
  const [invoiceNo, setInvoiceNo] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10))
  const [taxRate, setTaxRate] = useState('0.13')
  const [rows, setRows] = useState<{ qty: string; price: string }[]>([{ qty: '', price: '' }])
  const [busy, setBusy] = useState(false)
  const { data: opts } = useFetch<any>('/master/options', undefined, [])

  const total = rows.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.price) || 0), 0)
  const rate = Number(taxRate) || 0
  const amountEx = rate > 0 ? total / (1 + rate) : total

  const submit = async () => {
    if (!subjectId) return toast('请选择开票客户', 'error')
    const items = rows.filter((r) => Number(r.qty) > 0 && Number(r.price) > 0).map((r) => ({ qty: Number(r.qty), price: Number(r.price) }))
    if (!items.length) return toast('请至少填写一行有效明细', 'error')
    setBusy(true)
    try {
      const r = await SI_MANUAL({
        subject_type: subjectType,
        subject_id: Number(subjectId),
        invoice_date: invoiceDate,
        invoice_no: invoiceNo || undefined,
        tax_rate: rate,
        items,
        remark: '手工开票（无来源单据）'
      })
      toast(`已生成草稿发票 ${r.doc_no}（价税合计 ${fmtMoney(r.total_amount)}）`, 'success')
      onDone()
    } catch (e: any) {
      toast(e.message || '开票失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const subjectOpts = (subjectType === 'dealer' ? opts?.dealers : opts?.stores) || []

  return (
    <Modal
      open={open}
      title="手工开票"
      onClose={onClose}
      width={820}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={submit}><Plus size={13} /> 生成草稿发票</button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label="客户类型">
            <Sel value={subjectType} onChange={(v) => { setSubjectType(v || 'dealer'); setSubjectId('') }} options={[{ value: 'dealer', label: '经销商' }, { value: 'store', label: '门店' }]} placeholder="经销商" />
          </Field>
          <Field label="客户" required>
            <Sel value={subjectId} onChange={setSubjectId} options={subjectOpts} placeholder="请选择" />
          </Field>
          <Field label="开票日期"><Inp type="date" value={invoiceDate} onChange={setInvoiceDate} w={160} /></Field>
          <Field label="税务发票号"><Inp value={invoiceNo} onChange={setInvoiceNo} placeholder="可后补" w={200} /></Field>
          <Field label="税率"><Inp value={taxRate} onChange={setTaxRate} w={100} /></Field>
        </div>

        <div>
          <SectionTitle title="开票明细" right={<button className="btn-ghost btn-sm" onClick={() => setRows((r) => [...r, { qty: '', price: '' }])}><Plus size={12} /> 增行</button>} />
          <Table
            data={rows.map((r, i) => ({ ...r, _i: i }))}
            empty="—"
            rowKey={(r) => r._i}
            columns={[
              { key: '_i', title: '#', width: 50, render: (r) => r._i + 1 },
              { key: 'qty', title: '数量', width: 140, render: (r) => <input className="input input-sm text-right" style={{ width: 110 }} type="number" min={0} value={r.qty} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === r._i ? { ...x, qty: e.target.value } : x)))} /> },
              { key: 'price', title: '含税单价', width: 160, render: (r) => <input className="input input-sm text-right" style={{ width: 130 }} type="number" min={0} value={r.price} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === r._i ? { ...x, price: e.target.value } : x)))} /> },
              { key: '_amt', title: '含税金额', align: 'right', render: (r) => fmtMoney((Number(r.qty) || 0) * (Number(r.price) || 0)) },
              { key: '_del', title: '', width: 70, render: (r) => (rows.length > 1 ? <button className="btn-ghost btn-sm" onClick={() => setRows((rs) => rs.filter((_, j) => j !== r._i))}><Ban size={12} /></button> : null) }
            ]}
          />
        </div>

        <div className="flex justify-end gap-6 text-[13px] text-slate-600 pr-1">
          <span>不含税：<b className="text-slate-800">{fmtMoney(amountEx)}</b></span>
          <span>税额：<b className="text-slate-800">{fmtMoney(total - amountEx)}</b></span>
          <span>价税合计：<b className="text-brand-700">{fmtMoney(total)}</b></span>
        </div>
      </div>
    </Modal>
  )
}
