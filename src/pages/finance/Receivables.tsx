/**
 * ============================================================================
 * 文件标识：src/pages/finance/Receivables.tsx ｜ Receivables（页面，未取到标题）
 * ============================================================================
 * 【职责】Receivables（页面，未取到标题）（页面）
 * 【入口】/finance/receivables
 * 【主要接口】/ar/overview、/ar/audit、/ar/aging、/ar/prepay、/ar/oc/pending
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
 * 页面：Receivables（页面，未取到标题）
 */

import { useState } from 'react'
import {
  Card, SectionTitle, StatCard, Table, Empty, Modal, Field, Tabs, Pagination, MiniBars,
  fmtMoney, fmtInt, toast, useFetch
} from '../../components/ui'
import ScopeNotice, { ScopeBlocked, firstFailure, isBlocked } from '../../components/ScopeNotice'
import { FilterBar, Sel, Inp } from '../../components/DataPage'
import { useOpts } from '../../hooks/opts'
import {
  AR_OVERVIEW, AR_AGING, AR_AUDIT, AR_STATEMENT,
  AR_LIST, AR_GET, AR_CREATE, AR_GENERATE,
  RC_LIST, RC_GET, RC_CREATE, RC_CONFIRM, RC_REVIEW, RC_VOID, AR_RECALC,
  AR_AGING_DETAIL, AR_PREPAY, AR_PREPAY_DETAIL, AR_PREPAY_APPLY,
  AR_OC_PENDING, AR_OC_SYNC,
  AR_STATUS_CLS, AR_STATUS_LABEL, RC_STATUS_CLS, RC_STATUS_LABEL, overdueCls,
  FUNDS_REVIEW_LABEL, FUNDS_REVIEW_CLS, FUNDS_REVIEW_PERM,
  type ArDocument, type Receipt, type Statement, type AgingSubjectRow, type AgingDetail
} from '../../api/ar'
import { Wallet, Banknote, AlertTriangle, FileText, Plus, RefreshCw, CheckCircle2, Ban, Coins, Inbox, ShieldCheck } from 'lucide-react'
import {
  formatCreditEffect, creditEffectSummary,
  type CreditEffect, type CreditEffectKind, type CreditEffectView
} from '../../utils/credit-effect'

/**
 * 应收与收款核销（模块 21）。
 *
 * 六个页签对应财务一天里真正会用到的六种动作：
 *   ① 总览：一共该收多少、收回来多少、逾期多少、哪几家要催；底下挂着自洽审计，有漂移立刻可见。
 *   ② 应收单：逐笔看未收余额与逾期天数，抵扣的是哪几张收款单在这里能翻出来。
 *   ③ 收款单：登记 → 确认（核销生效、释放授信）→ 必要时作废；草稿与已收款必须区分清楚。
 *   ④ 账龄与对账：四桶分布 + 客户风险榜 + 客户对账单（可导出打印给客户核对）。
 *   ⑤ 逐笔账龄：一行一张单，逾期几天一栏直读；催收看的是这一页，不是汇总桶。
 *   ⑥ 预收：客户多付 / 先付的钱在这里显形，可指定或按到期日顺序转去抵应收。
 *
 * 界面上钉死的三条口径：
 *   ① 没有「直接改已收金额」的入口 —— 要改就改核销关系，余额由明细重算。
 *   ② 草稿收款单不等于收到钱 —— 它只是核销计划，列里标「草稿（未生效）」。
 *   ③ 逾期天数由到期日与今天算出，不存缓存列；逐笔账龄与汇总账龄同源（都取库里的视图）。
 */
/**
 * 授信效果面板（ADR-0013）：确认 / 作废 / 预收抵扣成功后，把响应里的 `credit_released` / `credit_reversal`
 * 原样列出来 —— 逐来源（单号 / 类型 / 台账 / 金额）+ 统一授信 / 订货中心两条合计。
 * 只展示后端给的数，不在前端算；legacy（迁移前收款单）要把"统一授信没有恢复"说清楚。
 */
function CreditEffectPanel({ view, docNo, onClose }: { view: CreditEffectView; docNo?: string; onClose?: () => void }) {
  const tone = view.legacy ? 'border-amber-300 bg-amber-50' : view.empty ? 'border-slate-200 bg-slate-50' : 'border-emerald-200 bg-emerald-50'
  return (
    <div className={`rounded border px-3 py-2 text-[12.5px] ${tone}`} data-testid="credit-effect-panel" role="status">
      <div className="flex items-center gap-2">
        <ShieldCheck size={14} className={view.legacy ? 'text-amber-600' : view.empty ? 'text-slate-400' : 'text-emerald-600'} />
        <span className="font-medium text-slate-700">
          {docNo ? `${docNo} · ` : ''}{view.kind === 'released' ? '本次释放授信' : '本次恢复占用'}
        </span>
        {view.legacy && <span className="px-1.5 py-0.5 rounded border border-amber-300 text-amber-700 text-[11px]">迁移前收款单（旧口径）</span>}
        <div className="flex-1" />
        <span className="tabular-nums text-slate-600">统一授信 {fmtMoney(view.totals.unified)}</span>
        <span className="tabular-nums text-slate-600">订货中心 {fmtMoney(view.totals.oc)}</span>
        {onClose && (
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="收起授信效果">收起</button>
        )}
      </div>
      {view.empty && <div className="mt-1 text-slate-500">本次未触及授信占用（没有释放台账行，合计为 0）。</div>}
      {view.legacy && <div className="mt-1 text-amber-700">{view.note}</div>}
      {view.lines.length > 0 && (
        <table className="mt-2 w-full text-[12px]">
          <thead>
            <tr className="text-slate-400 text-left">
              <th className="font-normal pb-1">来源单号</th>
              <th className="font-normal pb-1 w-16">类型</th>
              <th className="font-normal pb-1 w-24">台账</th>
              <th className="font-normal pb-1 text-right w-28">金额</th>
            </tr>
          </thead>
          <tbody>
            {view.lines.map((l, i) => (
              <tr key={`${l.doc_no}-${i}`} className="text-slate-700">
                <td className="py-0.5">{l.doc_no}</td>
                <td className="py-0.5">{l.type}</td>
                <td className="py-0.5">{l.ledger_label}</td>
                <td className="py-0.5 text-right tabular-nums">{fmtMoney(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** 筛选条里的带标签控件：Inp / Sel 本身不带标签，这里统一补一个前缀 */
function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[12px] text-slate-500 whitespace-nowrap">{label}</span>
      {children}
    </div>
  )
}

export default function Receivables() {
  const [tab, setTab] = useState<'overview' | 'documents' | 'receipts' | 'aging' | 'aging_detail' | 'prepay'>('overview')
  const [tick, setTick] = useState(0)
  const reload = () => setTick((t) => t + 1)

  const { data: ov, loading: ovLoading, errorStatus: s1, errorCode: c1 } = useFetch<any>('/ar/overview', undefined, [tick])
  const { data: audit, errorStatus: s2, errorCode: c2 } = useFetch<any>('/ar/audit', undefined, [tick])
  const { data: aging, errorStatus: s3, errorCode: c3 } = useFetch<any>('/ar/aging', { by_subject: '1' }, [tick])
  const failure = firstFailure({ errorStatus: s1, errorCode: c1 }, { errorStatus: s2, errorCode: c2 }, { errorStatus: s3, errorCode: c3 })
  const BUCKET_META = [
    { key: 'b0', label: '未到期', color: '#2568a6' },
    { key: 'b1', label: '逾期 1-30 天', color: '#d97706' },
    { key: 'b2', label: '逾期 31-60 天', color: '#ea580c' },
    { key: 'b3', label: '逾期 60 天以上', color: '#dc2626' }
  ]

  // 对账单弹窗提到顶层：总览的逾期榜、账龄榜都要能直接开同一张对账单
  const [stmt, setStmt] = useState<Statement | null>(null)
  const [stmtBusy, setStmtBusy] = useState(false)
  const openStatement = async (subjectType: string, subjectId: number) => {
    setStmtBusy(true)
    try {
      setStmt(await AR_STATEMENT(subjectType, subjectId))
    } catch (e: any) {
      toast(e.message || '对账单生成失败', 'error')
    } finally {
      setStmtBusy(false)
    }
  }

  const agingRows: AgingSubjectRow[] = aging?.rows || []
  const buckets = ov?.aging?.buckets || { b0: 0, b1: 0, b2: 0, b3: 0 }

  if (isBlocked(failure)) return <ScopeBlocked failure={failure} onRetry={reload} />

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionTitle
          title="应收与收款核销"
          desc="已收金额由核销明细 SUM 算出 · 核销生效点 = 收款单确认 · 到期日 = 业务日 + 账期"
        />
        <button className="btn-ghost" onClick={reload}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      <ScopeNotice failure={failure} rows={ov ? Number(ov.open_count || 0) : null} loading={ovLoading} />

      <Tabs
        tabs={[
          { key: 'overview', label: '总览' },
          { key: 'documents', label: '应收单', count: ov?.open_count },
          { key: 'receipts', label: '收款单' },
          { key: 'aging', label: '账龄与对账' },
          { key: 'aging_detail', label: '逐笔账龄' },
          { key: 'prepay', label: '预收' }
        ]}
        value={tab}
        onChange={(k) => setTab(k as any)}
      />

      {tab === 'overview' && <OverviewTab ov={ov} audit={audit} onRecalc={reload} onStatement={openStatement} />}
      {tab === 'documents' && <DocumentsTab tick={tick} reload={reload} />}
      {tab === 'receipts' && <ReceiptsTab tick={tick} reload={reload} />}
      {tab === 'aging' && (
        <AgingTab buckets={buckets} overdueTotal={ov?.overdue_amount || 0} rows={agingRows} meta={BUCKET_META} onStatement={openStatement} />
      )}
      {tab === 'aging_detail' && <AgingDetailTab tick={tick} onStatement={openStatement} />}
      {tab === 'prepay' && <PrepayTab tick={tick} reload={reload} onStatement={openStatement} />}

      <Modal
        open={!!stmt}
        title={`客户对账单 · ${stmt?.subject_name || ''}`}
        onClose={() => setStmt(null)}
        width={920}
        footer={
          <>
            <button className="btn-ghost" onClick={() => window.print()}>打印</button>
            <button className="btn-ghost" onClick={() => setStmt(null)}>关闭</button>
          </>
        }
      >
        {stmt && <StatementView s={stmt} />}
        {stmtBusy && <div className="text-center text-slate-400 py-6">加载中…</div>}
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ① 总览
// ---------------------------------------------------------------------------

function OverviewTab({
  ov,
  audit,
  onRecalc,
  onStatement
}: {
  ov: any
  audit: any
  onRecalc: () => void
  onStatement: (t: string, id: number) => void
}) {
  const [busy, setBusy] = useState(false)
  const recalc = async () => {
    setBusy(true)
    try {
      const r = await AR_RECALC()
      toast(`已重算 ${r.recalculated} 笔应收余额`, 'success')
      onRecalc()
    } catch (e: any) {
      toast(e.message || '重算失败', 'error')
    } finally {
      setBusy(false)
    }
  }
  const bucketData = [
    { label: '未到期', value: ov?.aging?.buckets?.b0 || 0 },
    { label: '逾期1-30', value: ov?.aging?.buckets?.b1 || 0 },
    { label: '逾期31-60', value: ov?.aging?.buckets?.b2 || 0 },
    { label: '逾期60+', value: ov?.aging?.buckets?.b3 || 0 }
  ]
  const driftCount =
    (audit?.drift?.length || 0) + (audit?.badStatus?.length || 0) +
    (audit?.overAlloc?.length || 0) + (audit?.rcDrift?.length || 0)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="应收总额" value={fmtMoney(ov?.ar_amount, 0)} sub={`${fmtInt(ov?.ar_count)} 笔`} icon={<FileText size={16} />} />
        <StatCard label="未收余额" value={fmtMoney(ov?.open_amount, 0)} sub={`${fmtInt(ov?.open_count)} 笔未结清`} icon={<Wallet size={16} />} />
        <StatCard label="已收款" value={fmtMoney(ov?.receipt_amount, 0)} sub={`${fmtInt(ov?.receipt_count)} 张已确认`} icon={<Banknote size={16} />} />
        <StatCard
          label="逾期未收"
          value={fmtMoney(ov?.overdue_amount, 0)}
          sub={`${fmtInt(ov?.overdue_count)} 笔已过到期日`}
          icon={<AlertTriangle size={16} />}
        />
        <StatCard
          label="草稿收款"
          value={fmtMoney(ov?.draft_receipt_amount, 0)}
          sub={`${fmtInt(ov?.draft_receipt_count)} 张未生效`}
          icon={<FileText size={16} />}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <SectionTitle title="账龄分布" desc="未收余额按逾期天数分四桶；越靠右越该催" />
          <MiniBars data={bucketData} height={140} color="#2568a6" />
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            {bucketData.map((b) => (
              <div key={b.label} className="rounded border border-slate-200 py-2">
                <div className="text-[11px] text-slate-500">{b.label}</div>
                <div className="text-[13px] font-medium tabular-nums text-slate-800">{fmtMoney(b.value, 0)}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <SectionTitle
            title="逾期风险榜"
            desc="按客户汇总：总欠多少、其中逾期多少、最早一笔什么时候到期"
          />
          <Table
            loading={false}
            data={(ov?.top_overdue || []).slice(0, 8)}
            rowKey={(r) => `${r.subject_type}-${r.subject_id}`}
            onRowClick={(r) => onStatement(r.subject_type, r.subject_id)}
            empty="当前没有未收余额"
            columns={[
              { key: 'subject_name', title: '往来对象', render: (r) => r.subject_name || `${r.subject_type}#${r.subject_id}` },
              { key: 'balance', title: '未收余额', align: 'right', render: (r) => fmtMoney(r.balance) },
              {
                key: 'overdue_amount',
                title: '其中逾期',
                align: 'right',
                render: (r) => <span className={r.overdue_amount > 0.005 ? 'text-red-600 font-medium' : 'text-slate-400'}>{fmtMoney(r.overdue_amount)}</span>
              },
              { key: 'earliest_due', title: '最早到期', align: 'center', render: (r) => r.earliest_due || '-' },
              { key: 'ar_count', title: '笔数', align: 'right', render: (r) => fmtInt(r.ar_count) }
            ]}
          />
        </Card>
      </div>

      <Card>
        <SectionTitle
          title="自洽审计"
          desc="已收金额必须等于核销明细 SUM；状态与余额必须匹配；不得超额核销"
          right={
            <button className="btn-ghost btn-sm" disabled={busy} onClick={recalc}>
              <RefreshCw size={13} /> 按明细重算余额
            </button>
          }
        />
        {audit?.ok ? (
          <div className="flex items-center gap-2 text-[13px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
            <CheckCircle2 size={15} /> 四类检查全部通过：应收已收与核销明细一致，无超额核销，状态与余额匹配
          </div>
        ) : (
          <div className="space-y-2 text-[13px]">
            <div className="text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              发现 {driftCount} 处不一致，请点「按明细重算余额」修复后复查
            </div>
            <Table
              data={[
                ...(audit?.drift || []).map((r: any) => ({ ...r, _t: '应收已收与明细不符' })),
                ...(audit?.badStatus || []).map((r: any) => ({ ...r, _t: '状态与余额不匹配' })),
                ...(audit?.overAlloc || []).map((r: any) => ({ ...r, _t: '超额核销' })),
                ...(audit?.rcDrift || []).map((r: any) => ({ ...r, _t: '收款单已核销与明细不符' }))
              ]}
              empty="—"
              columns={[
                { key: '_t', title: '问题', width: 220 },
                { key: 'doc_no', title: '单据号', width: 150 },
                { key: 'amount', title: '金额', align: 'right', render: (r) => fmtMoney(r.amount) },
                { key: 'allocated_amount', title: '单据记的已收', align: 'right', render: (r) => fmtMoney(r.allocated_amount) },
                { key: 'detail', title: '明细 SUM', align: 'right', render: (r) => (r.detail === undefined ? '-' : fmtMoney(r.detail)) }
              ]}
            />
          </div>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ② 应收单
// ---------------------------------------------------------------------------

function DocumentsTab({ tick, reload }: { tick: number; reload: () => void }) {
  const [status, setStatus] = useState('')
  const [keyword, setKeyword] = useState('')
  const [openOnly, setOpenOnly] = useState('1')
  const [overdueOnly, setOverdueOnly] = useState('')
  const [page, setPage] = useState(1)
  const { data, loading } = useFetch<any>(
    '/ar/documents',
    {
      status: status || undefined,
      keyword: keyword || undefined,
      open_only: openOnly || undefined,
      overdue_only: overdueOnly || undefined,
      page,
      pageSize: 20
    },
    [tick, status, keyword, openOnly, overdueOnly, page]
  )
  const rows: ArDocument[] = data?.rows || []

  const [detail, setDetail] = useState<ArDocument | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const openDetail = async (id: number) => {
    try {
      setDetail(await AR_GET(id))
    } catch (e: any) {
      toast(e.message || '打开失败', 'error')
    }
  }

  const generate = async () => {
    setBusy(true)
    try {
      const r = await AR_GENERATE({ source_type: 'SO' })
      toast(`生成 ${r.created?.length || 0} 笔，跳过 ${r.skipped?.length || 0} 笔（已生成过）`, 'success')
      reload()
    } catch (e: any) {
      toast(e.message || '生成失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <FilterBar onReset={() => { setStatus(''); setKeyword(''); setOpenOnly('1'); setOverdueOnly(''); setPage(1) }}>
        <F label="搜索">
          <Inp value={keyword} onChange={setKeyword} placeholder="单号 / 往来对象 / 来源单号" w={210} />
        </F>
        <F label="状态">
          <Sel
            value={status}
            onChange={setStatus}
            options={[{ value: '', label: '全部' }, ...Object.entries(AR_STATUS_LABEL).map(([value, label]) => ({ value, label }))]}
          />
        </F>
        <F label="余额">
          <Sel
            value={openOnly}
            onChange={setOpenOnly}
            options={[{ value: '', label: '全部' }, { value: '1', label: '只看未结清' }]}
          />
        </F>
        <F label="逾期">
          <Sel
            value={overdueOnly}
            onChange={setOverdueOnly}
            options={[{ value: '', label: '不限' }, { value: '1', label: '只看已逾期' }]}
          />
        </F>
      </FilterBar>

      <Card pad={false}>
        <div className="px-3 pt-3 flex items-center justify-between">
          <SectionTitle title="应收单" desc="未收余额 = 应收金额 − 核销明细 SUM；逾期天数按到期日与今天算出" />
          <div className="flex gap-2">
            <button className="btn-ghost btn-sm" disabled={busy} onClick={generate}>
              <RefreshCw size={13} /> 由销售订单生成
            </button>
            <button className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
              <Plus size={13} /> 手工补录
            </button>
          </div>
        </div>
        <Table
          loading={loading}
          data={rows}
          onRowClick={(r) => openDetail(r.id)}
          empty="没有符合条件的应收单"
          columns={[
            { key: 'doc_no', title: '应收单号', width: 150 },
            { key: 'subject_name', title: '往来对象', render: (r) => r.subject_name || '-' },
            { key: 'source_doc_no', title: '来源单据', width: 140, render: (r) => r.source_doc_no || (r.source_type === 'MANUAL' ? '手工补录' : '-') },
            { key: 'biz_date', title: '业务日期', width: 110 },
            { key: 'due_date', title: '到期日', width: 110 },
            { key: 'amount', title: '应收金额', align: 'right', render: (r) => fmtMoney(r.amount) },
            { key: 'balance', title: '未收余额', align: 'right', render: (r) => <span className="font-medium">{fmtMoney(Number(r.amount) - Number(r.allocated_amount))}</span> },
            {
              key: 'overdue_days',
              title: '逾期',
              width: 90,
              align: 'right',
              render: (r) => {
                const d = Number(r.overdue_days || 0)
                return <span className={overdueCls(d)}>{d > 0 ? `${d} 天` : '-'}</span>
              }
            },
            {
              key: 'status',
              title: '状态',
              width: 100,
              align: 'center',
              render: (r) => <span className={`px-1.5 py-0.5 rounded border text-[11px] ${AR_STATUS_CLS[r.status] || ''}`}>{AR_STATUS_LABEL[r.status] || r.status}</span>
            }
          ]}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={20} total={data?.total || 0} onChange={setPage} />
        </div>
      </Card>

      <Modal open={!!detail} title={`应收单 ${detail?.doc_no || ''}`} onClose={() => setDetail(null)} width={820}>
        {detail && <ArDetail doc={detail} />}
      </Modal>

      <CreateArModal open={createOpen} onClose={() => setCreateOpen(false)} onOk={reload} />
    </div>
  )
}

function ArDetail({ doc }: { doc: ArDocument }) {
  const balance = Number(doc.amount) - Number(doc.allocated_amount)
  return (
    <div className="space-y-3 text-[13px]">
      <div className="grid grid-cols-3 gap-3">
        <Field label="往来对象"><div className="input-disabled">{doc.subject_name || '-'}</div></Field>
        <Field label="来源单据"><div className="input-disabled">{doc.source_doc_no || doc.source_type || '-'}</div></Field>
        <Field label="状态"><div className="input-disabled">{AR_STATUS_LABEL[doc.status] || doc.status}</div></Field>
        <Field label="业务日期"><div className="input-disabled">{doc.biz_date}</div></Field>
        <Field label="到期日"><div className="input-disabled">{doc.due_date}（账期 {doc.credit_days || 0} 天）</div></Field>
        <Field label="逾期天数">
          <div className={`input-disabled ${overdueCls(Number(doc.overdue_days || 0))}`}>
            {Number(doc.overdue_days || 0) > 0 ? `${doc.overdue_days} 天` : '未逾期'}
          </div>
        </Field>
        <Field label="应收金额"><div className="input-disabled">{fmtMoney(doc.amount)}</div></Field>
        <Field label="已收（明细 SUM）"><div className="input-disabled">{fmtMoney(doc.allocated_amount)}</div></Field>
        <Field label="未收余额"><div className="input-disabled font-medium">{fmtMoney(balance)}</div></Field>
      </div>
      <SectionTitle title="核销明细" desc="每一笔已收抵的是哪张收款单、多少钱、那天收的" />
      <Table
        data={doc.allocations || []}
        empty="尚未核销"
        columns={[
          { key: 'receipt_no', title: '收款单号', width: 150 },
          { key: 'receipt_date', title: '收款日期', width: 110 },
          { key: 'method', title: '方式', width: 100 },
          { key: 'amount', title: '本次抵扣', align: 'right', render: (r) => fmtMoney(r.amount) },
          {
            key: 'receipt_status',
            title: '收款单状态',
            width: 110,
            align: 'center',
            render: (r) => <span className={`px-1.5 py-0.5 rounded border text-[11px] ${RC_STATUS_CLS[r.receipt_status] || ''}`}>{RC_STATUS_LABEL[r.receipt_status] || r.receipt_status}</span>
          }
        ]}
      />
      {doc.remark && <div className="text-slate-500">备注：{doc.remark}</div>}
    </div>
  )
}

function CreateArModal({ open, onClose, onOk }: { open: boolean; onClose: () => void; onOk: () => void }) {
  const opts = useOpts()
  const [form, setForm] = useState<any>({
    subject_type: 'dealer',
    subject_id: '',
    biz_date: new Date().toISOString().slice(0, 10),
    amount: '',
    credit_days: 30,
    remark: ''
  })
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!form.subject_id) return toast('请选择往来对象', 'error')
    if (!(Number(form.amount) > 0)) return toast('应收金额必须大于 0', 'error')
    setBusy(true)
    try {
      const name = (opts.dealers.find((d) => String(d.value) === String(form.subject_id)) || {}).label
      await AR_CREATE({
        subject_type: form.subject_type,
        subject_id: Number(form.subject_id),
        subject_name: name,
        source_type: 'MANUAL',
        biz_date: form.biz_date,
        amount: Number(form.amount),
        credit_days: Number(form.credit_days) || 0,
        remark: form.remark || null
      })
      toast('已补录应收单', 'success')
      onOk()
      onClose()
      setForm({ ...form, amount: '', remark: '' })
    } catch (e: any) {
      toast(e.message || '补录失败', 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      title="手工补录应收单"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={submit}>保存</button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="往来对象类型">
          <select className="input" value={form.subject_type} onChange={(e) => setForm({ ...form, subject_type: e.target.value, subject_id: '' })}>
            <option value="dealer">经销商</option>
            <option value="store">门店</option>
          </select>
        </Field>
        <Field label="往来对象" required>
          <select className="input" value={form.subject_id} onChange={(e) => setForm({ ...form, subject_id: e.target.value })}>
            <option value="">请选择</option>
            {(form.subject_type === 'dealer' ? opts.dealers : opts.stores).map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </Field>
        <Field label="业务日期" required>
          <input type="date" className="input" value={form.biz_date} onChange={(e) => setForm({ ...form, biz_date: e.target.value })} />
        </Field>
        <Field label="应收金额" required>
          <input type="number" className="input" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0.00" />
        </Field>
        <Field label="账期天数" hint="到期日 = 业务日期 + 账期；填 0 视为现结">
          <input type="number" className="input" value={form.credit_days} onChange={(e) => setForm({ ...form, credit_days: e.target.value })} />
        </Field>
        <Field label="备注">
          <input className="input" value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} placeholder="如：补录 9 月尾款" />
        </Field>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// ③ 收款单
// ---------------------------------------------------------------------------

function ReceiptsTab({ tick, reload }: { tick: number; reload: () => void }) {
  const [status, setStatus] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const { data, loading } = useFetch<any>(
    '/ar/receipts',
    { status: status || undefined, keyword: keyword || undefined, page, pageSize: 20 },
    [tick, status, keyword, page]
  )
  const rows: Receipt[] = data?.rows || []
  const [detail, setDetail] = useState<Receipt | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 最近一次确认 / 作废带回的授信效果（ADR-0013），钉在详情弹窗顶部直到关闭或换单 */
  const [effect, setEffect] = useState<{ docNo: string; view: CreditEffectView } | null>(null)
  // ADR-0018：确认必须带凭证号；达到阈值只挂待复核，由持 finance.funds.review 的另一人批准 / 驳回
  const [evidence, setEvidence] = useState({ evidence_ref: '', evidence_note: '' })
  const { data: me } = useFetch<any>('/auth/me', undefined, [])
  const canReview = !!me?.permissions?.includes(FUNDS_REVIEW_PERM)
  const isPending = detail?.review_status === 'pending_review'
  const isMaker = !!detail?.review?.maker?.id && detail?.review?.maker?.id === me?.id

  const openDetail = async (id: number) => {
    try {
      setEffect(null)
      const rc = await RC_GET(id)
      setDetail(rc)
      setEvidence({ evidence_ref: rc.evidence_ref || '', evidence_note: rc.evidence_note || '' })
    } catch (e: any) {
      toast(e.message || '打开失败', 'error')
    }
  }
  const closeDetail = () => {
    setDetail(null)
    setEffect(null)
  }
  /** kind 给出时把响应里的授信效果（ADR-0013）钉到详情顶部；待复核的提交没有资金效果，不显示面板 */
  const act = async (fn: () => Promise<any>, msg: string | ((r: any) => string), kind?: CreditEffectKind) => {
    setBusy(true)
    try {
      const r = await fn()
      const pending = r?.review?.status === 'pending_review'
      const raw: CreditEffect | undefined = kind && !pending ? (kind === 'released' ? r?.credit_released : r?.credit_reversal) : undefined
      const text = typeof msg === 'function' ? msg(r) : msg
      toast(kind && !pending ? `${text}；${creditEffectSummary(raw, kind)}` : text, 'success')
      if (detail && r?.id === detail.id) {
        if (kind && !pending) setEffect({ docNo: r.doc_no || detail.doc_no, view: formatCreditEffect(raw, kind) })
        setDetail(await RC_GET(detail.id))
      }
      reload()
    } catch (e: any) {
      toast(e.message || '操作失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <FilterBar onReset={() => { setStatus(''); setKeyword(''); setPage(1) }}>
        <F label="搜索">
          <Inp value={keyword} onChange={setKeyword} placeholder="单号 / 往来对象 / 流水号" w={210} />
        </F>
        <F label="状态">
          <Sel
            value={status}
            onChange={setStatus}
            options={[{ value: '', label: '全部' }, ...Object.entries(RC_STATUS_LABEL).map(([value, label]) => ({ value, label }))]}
          />
        </F>
      </FilterBar>

      <Card pad={false}>
        <div className="px-3 pt-3 flex items-center justify-between">
          <SectionTitle title="收款单" desc="草稿上的核销只是计划；确认后才真正抵扣应收并释放授信占用" />
          <button className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
            <Plus size={13} /> 登记收款
          </button>
        </div>
        <Table
          loading={loading}
          data={rows}
          onRowClick={(r) => openDetail(r.id)}
          empty="还没有收款单"
          columns={[
            { key: 'doc_no', title: '收款单号', width: 150 },
            { key: 'subject_name', title: '往来对象', render: (r) => r.subject_name || '-' },
            { key: 'receipt_date', title: '收款日期', width: 110 },
            { key: 'method', title: '方式', width: 100, render: (r) => r.method || '-' },
            { key: 'amount', title: '收款金额', align: 'right', render: (r) => fmtMoney(r.amount) },
            {
              key: 'allocated_amount',
              title: '已核销',
              align: 'right',
              render: (r) => fmtMoney(r.allocated_amount)
            },
            {
              key: 'unallocated_amount',
              title: '未核销（预收）',
              align: 'right',
              render: (r) => {
                const v = Number(r.amount) - Number(r.allocated_amount)
                return <span className={v > 0.005 ? 'text-amber-600 font-medium' : 'text-slate-400'}>{fmtMoney(v)}</span>
              }
            },
            {
              key: 'status',
              title: '状态',
              width: 110,
              align: 'center',
              render: (r) => (
                <span className={`px-1.5 py-0.5 rounded border text-[11px] ${r.review_status === 'pending_review' ? FUNDS_REVIEW_CLS.pending_review : RC_STATUS_CLS[r.status] || ''}`}>
                  {r.review_status === 'pending_review' ? FUNDS_REVIEW_LABEL.pending_review : RC_STATUS_LABEL[r.status] || r.status}
                </span>
              )
            }
          ]}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={20} total={data?.total || 0} onChange={setPage} />
        </div>
      </Card>

      <Modal
        open={!!detail}
        title={`收款单 ${detail?.doc_no || ''}`}
        onClose={closeDetail}
        width={820}
        footer={
          detail && (
            <>
              <button className="btn-ghost" onClick={closeDetail}>关闭</button>
              {detail.status === 'draft' && !isPending && (
                <button
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => act(
                    () => RC_CONFIRM(detail.id, { evidence_ref: evidence.evidence_ref.trim(), evidence_note: evidence.evidence_note.trim() }),
                    (r) => (r?.review?.status === 'pending_review' ? '已提交复核：等待另一人批准后才核销、释放授信' : '已确认收款：核销生效、授信占用释放'),
                    'released'
                  )}
                >
                  <CheckCircle2 size={14} /> 确认收款
                </button>
              )}
              {isPending && canReview && !isMaker && (
                <>
                  <button
                    className="btn-danger"
                    disabled={busy}
                    onClick={() => {
                      const comment = window.prompt('驳回原因（必填，将写入严格审计）：')
                      if (!comment) return
                      act(() => RC_REVIEW(detail.id, 'reject', comment), '已驳回：收款单退回草稿，资金与授信未动')
                    }}
                  >
                    <Ban size={14} /> 驳回
                  </button>
                  <button
                    className="btn-primary"
                    disabled={busy}
                    onClick={() => {
                      const comment = window.prompt('复核意见（可空）：') ?? ''
                      act(() => RC_REVIEW(detail.id, 'approve', comment), '复核通过：核销生效、授信占用释放', 'released')
                    }}
                  >
                    <CheckCircle2 size={14} /> 复核通过
                  </button>
                </>
              )}
              {isPending && (!canReview || isMaker) && (
                <span className="text-[12px] text-amber-700">{isMaker ? '你是发起人，需由另一人复核' : '等待持复核权限的同事批准'}</span>
              )}
              {detail.status === 'confirmed' && (
                <button
                  className="btn-danger"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt('作废原因（必填，将写入留痕）：')
                    if (!reason) return
                    act(() => RC_VOID(detail.id, reason), '已作废：核销回退', 'reversal')
                  }}
                >
                  <Ban size={14} /> 作废
                </button>
              )}
            </>
          )
        }
      >
        {detail && (
          <div className="space-y-3">
            {effect && effect.docNo === detail.doc_no && (
              <CreditEffectPanel view={effect.view} docNo={effect.docNo} onClose={() => setEffect(null)} />
            )}
            <ReceiptDetail
              rc={detail}
              evidence={detail.status === 'draft' && !isPending ? evidence : null}
              onEvidence={setEvidence}
            />
          </div>
        )}
      </Modal>

      <CreateReceiptModal open={createOpen} onClose={() => setCreateOpen(false)} onOk={reload} />
    </div>
  )
}

function ReceiptDetail({
  rc, evidence = null, onEvidence
}: {
  rc: Receipt
  /** 非空 = 允许在本页填写证据（草稿且未在复核中） */
  evidence?: { evidence_ref: string; evidence_note: string } | null
  onEvidence?: (v: { evidence_ref: string; evidence_note: string }) => void
}) {
  const review = rc.review
  return (
    <div className="space-y-3 text-[13px]">
      {evidence && onEvidence && (
        <div className="grid grid-cols-2 gap-3 rounded border border-amber-200 bg-amber-50/40 p-3">
          <Field label="银行流水号 / 凭证号" required hint="确认收款的证据；缺失时服务端拒绝确认">
            <input className="input" value={evidence.evidence_ref} onChange={(e) => onEvidence({ ...evidence, evidence_ref: e.target.value })} placeholder="如 2026102300123456" />
          </Field>
          <Field label="证据说明" hint="可选：对账单行号、票据备注等">
            <input className="input" value={evidence.evidence_note} onChange={(e) => onEvidence({ ...evidence, evidence_note: e.target.value })} />
          </Field>
        </div>
      )}
      {review?.status && (
        <div className={`rounded border px-3 py-2 ${FUNDS_REVIEW_CLS[review.status] || ''}`}>
          <b>{FUNDS_REVIEW_LABEL[review.status] || review.status}</b>
          <span className="ml-2">发起：{review.maker?.name || '-'}{review.maker?.at ? `（${review.maker.at}）` : ''}</span>
          {review.checker && <span className="ml-2">复核：{review.checker.name || '-'}{review.decided_at ? `（${review.decided_at}）` : ''}</span>}
          {review.comment && <span className="ml-2">意见：{review.comment}</span>}
        </div>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Field label="往来对象"><div className="input-disabled">{rc.subject_name || '-'}</div></Field>
        <Field label="收款日期"><div className="input-disabled">{rc.receipt_date}</div></Field>
        <Field label="方式"><div className="input-disabled">{rc.method || '-'}</div></Field>
        <Field label="收款金额"><div className="input-disabled">{fmtMoney(rc.amount)}</div></Field>
        <Field label="已核销"><div className="input-disabled">{fmtMoney(rc.allocated_amount)}</div></Field>
        <Field label="未核销（预收）">
          <div className="input-disabled">{fmtMoney(Number(rc.amount) - Number(rc.allocated_amount))}</div>
        </Field>
        <Field label="银行账号"><div className="input-disabled">{rc.bank_account || '-'}</div></Field>
        <Field label="流水号"><div className="input-disabled">{rc.serial_no || '-'}</div></Field>
        <Field label="状态">
          <div className="input-disabled">
            {RC_STATUS_LABEL[rc.status] || rc.status}
            {rc.status === 'draft' && <span className="ml-1 text-amber-600">{rc.review_status === 'pending_review' ? '（待复核，未生效）' : '（未生效）'}</span>}
          </div>
        </Field>
        {!evidence && <Field label="凭证号"><div className="input-disabled">{rc.evidence_ref || '-'}</div></Field>}
      </div>
      <SectionTitle title="核销明细" desc="这张收款单抵了哪几笔应收" />
      <Table
        data={rc.allocations || []}
        empty="尚未核销"
        columns={[
          { key: 'ar_no', title: '应收单号', width: 150 },
          { key: 'source_doc_no', title: '来源单据', width: 140, render: (r) => r.source_doc_no || '-' },
          { key: 'due_date', title: '到期日', width: 110 },
          { key: 'ar_amount', title: '应收金额', align: 'right', render: (r) => fmtMoney(r.ar_amount) },
          { key: 'amount', title: '本次抵扣', align: 'right', render: (r) => fmtMoney(r.amount) }
        ]}
      />
      {rc.remark && <div className="text-slate-500">备注：{rc.remark}</div>}
    </div>
  )
}

function CreateReceiptModal({ open, onClose, onOk }: { open: boolean; onClose: () => void; onOk: () => void }) {
  const opts = useOpts()
  const [form, setForm] = useState<any>({
    subject_type: 'dealer',
    subject_id: '',
    receipt_date: new Date().toISOString().slice(0, 10),
    amount: '',
    method: 'transfer',
    bank_account: '',
    serial_no: '',
    remark: ''
  })
  const [picked, setPicked] = useState<Record<number, number>>({})
  const [busy, setBusy] = useState(false)

  // 选中往来对象后，把它名下的未结清应收拉出来让人挑（不选则后端按 FIFO 自动摊）
  const { data: arData } = useFetch<any>(
    form.subject_id ? '/ar/documents' : null,
    { subject_type: form.subject_type, subject_id: form.subject_id, open_only: '1', page: 1, pageSize: 50 },
    [form.subject_type, form.subject_id, open]
  )
  const arRows: ArDocument[] = arData?.rows || []
  const pickedTotal = Object.values(picked).reduce((s, v) => s + Number(v || 0), 0)

  const submit = async () => {
    if (!form.subject_id) return toast('请选择往来对象', 'error')
    const amt = Number(form.amount)
    if (!(amt > 0)) return toast('收款金额必须大于 0', 'error')
    if (pickedTotal > amt + 0.01) return toast(`手工指定核销合计 ${fmtMoney(pickedTotal)} 已超过收款金额`, 'error')
    setBusy(true)
    try {
      const name = (opts.dealers.find((d) => String(d.value) === String(form.subject_id)) || {}).label
      const allocations = Object.entries(picked)
        .filter(([, v]) => Number(v) > 0.005)
        .map(([k, v]) => ({ ar_id: Number(k), amount: Number(v) }))
      await RC_CREATE({
        subject_type: form.subject_type,
        subject_id: Number(form.subject_id),
        subject_name: name,
        receipt_date: form.receipt_date,
        amount: amt,
        method: form.method,
        bank_account: form.bank_account || null,
        serial_no: form.serial_no || null,
        remark: form.remark || null,
        allocations: allocations.length ? allocations : null
      })
      toast(allocations.length ? '已登记收款单（手工指定核销）' : '已登记收款单（按到期日自动分摊）', 'success')
      onOk()
      onClose()
      setPicked({})
      setForm({ ...form, amount: '', serial_no: '', remark: '' })
    } catch (e: any) {
      toast(e.message || '登记失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="登记收款单"
      onClose={onClose}
      width={900}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={submit}>保存草稿</button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <Field label="往来对象类型">
          <select className="input" value={form.subject_type} onChange={(e) => { setForm({ ...form, subject_type: e.target.value, subject_id: '' }); setPicked({}) }}>
            <option value="dealer">经销商</option>
            <option value="store">门店</option>
          </select>
        </Field>
        <Field label="往来对象" required>
          <select className="input" value={form.subject_id} onChange={(e) => { setForm({ ...form, subject_id: e.target.value }); setPicked({}) }}>
            <option value="">请选择</option>
            {(form.subject_type === 'dealer' ? opts.dealers : opts.stores).map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </Field>
        <Field label="收款日期" required>
          <input type="date" className="input" value={form.receipt_date} onChange={(e) => setForm({ ...form, receipt_date: e.target.value })} />
        </Field>
        <Field label="收款金额" required>
          <input type="number" className="input" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0.00" />
        </Field>
        <Field label="收款方式">
          <select className="input" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            <option value="transfer">银行转账</option>
            <option value="cash">现金</option>
            <option value="bill">票据</option>
            <option value="online">在线支付</option>
          </select>
        </Field>
        <Field label="流水号">
          <input className="input" value={form.serial_no} onChange={(e) => setForm({ ...form, serial_no: e.target.value })} />
        </Field>
      </div>

      <div className="mt-4">
        <SectionTitle
          title="指定核销（可留空）"
          desc="留空则按到期日从早到晚自动分摊；指定的合计不得超过收款金额"
        />
        {!form.subject_id ? (
          <Empty text="先选择往来对象，再看它名下的未结清应收" />
        ) : arRows.length === 0 ? (
          <Empty text="该往来对象没有未结清应收：这笔钱会全额记为预收" />
        ) : (
          <Table
            data={arRows}
            empty="—"
            columns={[
              { key: 'doc_no', title: '应收单号', width: 150 },
              { key: 'source_doc_no', title: '来源单据', width: 140, render: (r) => r.source_doc_no || '-' },
              { key: 'due_date', title: '到期日', width: 110 },
              { key: 'amount', title: '应收', align: 'right', render: (r) => fmtMoney(r.amount) },
              {
                key: '_bal',
                title: '未收余额',
                align: 'right',
                render: (r) => fmtMoney(Number(r.amount) - Number(r.allocated_amount))
              },
              {
                key: '_pick',
                title: '本次抵扣',
                width: 140,
                align: 'right',
                render: (r) => (
                  <input
                    type="number"
                    className="input text-right"
                    placeholder="0.00"
                    value={picked[r.id] ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setPicked({ ...picked, [r.id]: Number(e.target.value) })}
                  />
                )
              }
            ]}
          />
        )}
        <div className="mt-2 text-[13px] text-slate-600">
          手工指定合计：<span className="font-medium tabular-nums">{fmtMoney(pickedTotal)}</span>
          {Number(form.amount) > 0 && pickedTotal > 0 && (
            <span className="ml-2">
              · 剩余未指定：<span className="font-medium">{fmtMoney(Math.max(0, Number(form.amount) - pickedTotal))}</span>
            </span>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// ④ 账龄与对账
// ---------------------------------------------------------------------------

function AgingTab({
  buckets,
  overdueTotal,
  rows,
  meta,
  onStatement
}: {
  buckets: any
  overdueTotal: number
  rows: AgingSubjectRow[]
  meta: { key: string; label: string; color: string }[]
  onStatement: (t: string, id: number) => void
}) {
  const total = Number(buckets?.b0 || 0) + Number(buckets?.b1 || 0) + Number(buckets?.b2 || 0) + Number(buckets?.b3 || 0)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <SectionTitle title="账龄四桶" desc="未收余额按逾期天数分布" />
          <div className="space-y-2">
            {meta.map((m) => {
              const v = Number(buckets?.[m.key] || 0)
              const pct = total > 0 ? (v / total) * 100 : 0
              return (
                <div key={m.key} className="flex items-center gap-3">
                  <span className="w-28 text-[13px] text-slate-600">{m.label}</span>
                  <div className="flex-1 h-5 bg-slate-100 rounded overflow-hidden">
                    <div className="h-full rounded" style={{ width: `${pct}%`, background: m.color }} />
                  </div>
                  <span className="w-28 text-right text-[13px] tabular-nums text-slate-800">{fmtMoney(v, 0)}</span>
                  <span className="w-14 text-right text-[12px] text-slate-400">{pct.toFixed(1)}%</span>
                </div>
              )
            })}
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100 flex justify-between text-[13px]">
            <span className="text-slate-500">未收合计</span>
            <span className="font-medium tabular-nums">{fmtMoney(total)}</span>
          </div>
          <div className="mt-1 flex justify-between text-[13px]">
            <span className="text-slate-500">其中已逾期</span>
            <span className="font-medium tabular-nums text-red-600">{fmtMoney(overdueTotal)}</span>
          </div>
        </Card>

        <Card>
          <SectionTitle title="客户账龄榜" desc="点任意一行看这家客户的对账单" />
          <Table
            data={rows}
            rowKey={(r) => `${r.subject_type}-${r.subject_id}`}
            onRowClick={(r) => onStatement(r.subject_type, r.subject_id)}
            empty="没有未收余额"
            columns={[
              { key: 'subject_name', title: '往来对象', render: (r) => r.subject_name || `${r.subject_type}#${r.subject_id}` },
              { key: 'balance', title: '未收余额', align: 'right', render: (r) => fmtMoney(r.balance) },
              {
                key: 'overdue_amount',
                title: '其中逾期',
                align: 'right',
                render: (r) => <span className={r.overdue_amount > 0.005 ? 'text-red-600 font-medium' : 'text-slate-400'}>{fmtMoney(r.overdue_amount)}</span>
              },
              { key: 'earliest_due', title: '最早到期', align: 'center', render: (r) => r.earliest_due || '-' },
              { key: 'ar_count', title: '笔数', align: 'right', render: (r) => fmtInt(r.ar_count) }
            ]}
          />
        </Card>
      </div>
    </div>
  )
}

function StatementView({ s }: { s: Statement }) {
  return (
    <div className="space-y-3 text-[13px]">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <div className="rounded border border-slate-200 px-3 py-2">
          <div className="text-[11px] text-slate-500">本期应收</div>
          <div className="font-medium tabular-nums">{fmtMoney(s.ar_total)}</div>
        </div>
        <div className="rounded border border-slate-200 px-3 py-2">
          <div className="text-[11px] text-slate-500">本期收款</div>
          <div className="font-medium tabular-nums">{fmtMoney(s.receipt_total)}</div>
        </div>
        <div className="rounded border border-slate-200 px-3 py-2">
          <div className="text-[11px] text-slate-500">已核销</div>
          <div className="font-medium tabular-nums">{fmtMoney(s.allocated_total)}</div>
        </div>
        <div className="rounded border border-slate-200 px-3 py-2">
          <div className="text-[11px] text-slate-500">期末余额</div>
          <div className="font-medium tabular-nums text-red-600">{fmtMoney(s.balance)}</div>
        </div>
        <div className="rounded border border-slate-200 px-3 py-2">
          <div className="text-[11px] text-slate-500">未核销（预收）</div>
          <div className="font-medium tabular-nums text-amber-600">{fmtMoney(s.unallocated_receipt)}</div>
        </div>
      </div>

      <SectionTitle title="应收明细" />
      <Table
        data={s.ars}
        empty="本期无应收"
        columns={[
          { key: 'doc_no', title: '应收单号', width: 150 },
          { key: 'source_doc_no', title: '来源单据', width: 140, render: (r) => r.source_doc_no || '-' },
          { key: 'biz_date', title: '业务日期', width: 110 },
          { key: 'due_date', title: '到期日', width: 110 },
          { key: 'amount', title: '金额', align: 'right', render: (r) => fmtMoney(r.amount) },
          { key: 'allocated_amount', title: '已收', align: 'right', render: (r) => fmtMoney(r.allocated_amount) },
          {
            key: '_bal',
            title: '未收',
            align: 'right',
            render: (r) => fmtMoney(Number(r.amount) - Number(r.allocated_amount))
          }
        ]}
      />

      <SectionTitle title="收款明细（仅已确认）" />
      <Table
        data={s.receipts}
        empty="本期无收款"
        columns={[
          { key: 'doc_no', title: '收款单号', width: 150 },
          { key: 'receipt_date', title: '收款日期', width: 110 },
          { key: 'method', title: '方式', width: 100 },
          { key: 'amount', title: '金额', align: 'right', render: (r) => fmtMoney(r.amount) },
          {
            key: '_alloc',
            title: '已核销',
            align: 'right',
            render: (r) => fmtMoney(r.allocated_amount)
          }
        ]}
      />

      <SectionTitle title="核销关系" desc="哪张收款单抵了哪笔应收，逐笔可追溯" />
      <Table
        data={s.allocations}
        empty="—"
        columns={[
          { key: 'receipt_no', title: '收款单号', width: 150 },
          { key: 'receipt_date', title: '收款日期', width: 110 },
          { key: 'ar_no', title: '应收单号', width: 150, render: (r) => r.ar_no || '-' },
          { key: 'source_doc_no', title: '来源单据', width: 140, render: (r) => r.source_doc_no || '-' },
          { key: 'amount', title: '抵扣金额', align: 'right', render: (r) => fmtMoney(r.amount) }
        ]}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// ⑤ 逐笔账龄（第二阶段）
//
// 与「账龄与对账」的区别：那一页回答「总共逾期多少」，这一页回答
// 「哪几张单、各逾期几天、该找谁」—— 催收是逐笔动作，不是看汇总桶。
// 数据取库里的 v_ar_aging_detail 视图，与汇总口径同源。
// ---------------------------------------------------------------------------

function AgingDetailTab({ tick, onStatement }: { tick: number; onStatement: (t: string, id: number) => void }) {
  const [bucket, setBucket] = useState('all')
  const [sourceType, setSourceType] = useState('')
  const [kw, setKw] = useState('')
  const { data, loading } = useFetch<AgingDetail>(
    '/ar/aging/detail',
    { bucket, source_type: sourceType || undefined, keyword: kw || undefined },
    [tick, bucket, sourceType, kw]
  )
  const rows = data?.rows || []
  const sum = data?.summary || { b0: 0, b1: 0, b2: 0, b3: 0, settled: 0 }

  const cards = [
    { label: '未到期', value: sum.b0, cls: 'text-slate-800' },
    { label: '逾期 1-30 天', value: sum.b1, cls: 'text-amber-600' },
    { label: '逾期 31-60 天', value: sum.b2, cls: 'text-orange-600' },
    { label: '逾期 60 天以上', value: sum.b3, cls: 'text-red-600' }
  ]

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded border border-slate-200 bg-white px-3 py-2">
            <div className="text-[11px] text-slate-500">{c.label}</div>
            <div className={`text-[15px] font-medium tabular-nums ${c.cls}`}>{fmtMoney(c.value, 0)}</div>
          </div>
        ))}
        <div className="rounded border border-slate-200 bg-white px-3 py-2">
          <div className="text-[11px] text-slate-500">未结合计</div>
          <div className="text-[15px] font-medium tabular-nums">{fmtMoney(data?.total_open || 0, 0)}</div>
        </div>
        <div className="rounded border border-slate-200 bg-white px-3 py-2">
          <div className="text-[11px] text-slate-500">其中已逾期</div>
          <div className="text-[15px] font-medium tabular-nums text-red-600">{fmtMoney(data?.total_overdue || 0, 0)}</div>
        </div>
      </div>

      <FilterBar onReset={() => { setBucket('all'); setSourceType(''); setKw('') }}>
        <F label="搜索">
          <Inp value={kw} onChange={setKw} placeholder="单号 / 往来对象 / 来源单号" w={210} />
        </F>
        <F label="账龄桶">
          <Sel
            value={bucket}
            onChange={setBucket}
            options={[
              { value: 'all', label: '全部未结' },
              { value: 'b0', label: '未到期' },
              { value: 'b1', label: '逾期 1-30 天' },
              { value: 'b2', label: '逾期 31-60 天' },
              { value: 'b3', label: '逾期 60 天以上' },
              { value: 'settled', label: '已结清 / 作废' }
            ]}
          />
        </F>
        <F label="来源">
          <Sel
            value={sourceType}
            onChange={setSourceType}
            options={[
              { value: '', label: '全部' },
              { value: 'SO', label: '销售订单' },
              { value: 'OC', label: '订货单' },
              { value: 'MANUAL', label: '手工补录' }
            ]}
          />
        </F>
      </FilterBar>

      <Card pad={false}>
        <div className="px-3 pt-3">
          <SectionTitle
            title={`逐笔账龄 · ${rows.length} 笔`}
            desc="一行一张应收单；逾期天数由到期日与今天算出，不存缓存列。点一行看该客户对账单"
          />
        </div>
        <Table
          loading={loading}
          data={rows}
          rowKey={(r) => String(r.id)}
          onRowClick={(r) => onStatement(r.subject_type, r.subject_id)}
          empty="没有符合条件的应收单"
          columns={[
            { key: 'doc_no', title: '应收单号', width: 150 },
            { key: 'subject_name', title: '往来对象', render: (r) => r.subject_name || `${r.subject_type}#${r.subject_id}` },
            {
              key: 'source_doc_no',
              title: '来源单据',
              width: 140,
              render: (r) => r.source_doc_no || (r.source_type === 'MANUAL' ? '手工补录' : '-')
            },
            { key: 'biz_date', title: '业务日期', width: 105 },
            { key: 'due_date', title: '到期日', width: 105 },
            { key: 'amount', title: '应收', align: 'right', render: (r) => fmtMoney(r.amount) },
            { key: 'allocated_amount', title: '已收', align: 'right', render: (r) => fmtMoney(r.allocated_amount) },
            {
              key: 'open_amount',
              title: '未收余额',
              align: 'right',
              render: (r) => <span className="font-medium">{fmtMoney(r.open_amount)}</span>
            },
            {
              key: 'overdue_days',
              title: '逾期',
              width: 88,
              align: 'right',
              render: (r) => {
                const d = Number(r.overdue_days || 0)
                return <span className={overdueCls(d)}>{d > 0 ? `${d} 天` : '-'}</span>
              }
            },
            {
              key: 'bucket',
              title: '账龄',
              width: 96,
              align: 'center',
              render: (r) => {
                const M: Record<string, string> = {
                  b0: '未到期',
                  b1: '1-30 天',
                  b2: '31-60 天',
                  b3: '60 天以上',
                  settled: '已结清'
                }
                const C: Record<string, string> = {
                  b0: 'text-slate-600 bg-slate-50 border-slate-200',
                  b1: 'text-amber-600 bg-amber-50 border-amber-200',
                  b2: 'text-orange-600 bg-orange-50 border-orange-200',
                  b3: 'text-red-600 bg-red-50 border-red-200',
                  settled: 'text-emerald-600 bg-emerald-50 border-emerald-200'
                }
                return <span className={`px-1.5 py-0.5 rounded border text-[11px] ${C[r.bucket] || ''}`}>{M[r.bucket] || r.bucket}</span>
              }
            },
            {
              key: 'status',
              title: '状态',
              width: 96,
              align: 'center',
              render: (r) => (
                <span className={`px-1.5 py-0.5 rounded border text-[11px] ${AR_STATUS_CLS[r.status] || ''}`}>
                  {AR_STATUS_LABEL[r.status] || r.status}
                </span>
              )
            }
          ]}
        />
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ⑥ 预收（第二阶段）
//
// 预收不是一个「多收的钱」的备注，而是客户放在我方的余额：
//   · 上半页看「谁有预收、有多少」，点开看是哪些收款单付多了；
//   · 展开后能直接把这些钱转去抵未结应收（指定单，或按到期日自动抵）；
//   · 下半页是订货中心待并入的订单 —— 已收货但还没生成应收的兜底清单。
// 口径：预收余额 = 已确认收款单金额 − 其核销明细之和（库里的 v_ar_prepay 视图）。
// ---------------------------------------------------------------------------

function PrepayTab({
  tick,
  reload,
  onStatement
}: {
  tick: number
  reload: () => void
  onStatement: (t: string, id: number) => void
}) {
  const [kw, setKw] = useState('')
  const { data, loading } = useFetch<any>('/ar/prepay', { keyword: kw || undefined }, [tick, kw])
  const rows = data?.rows || []

  const { data: ocData, loading: ocLoading } = useFetch<any>('/ar/oc/pending', undefined, [tick])
  const ocRows = ocData?.rows || []

  const [detail, setDetail] = useState<any>(null)
  const [detailSubject, setDetailSubject] = useState<{ t: string; id: number; name?: string } | null>(null)
  const [target, setTarget] = useState('auto')
  const [busy, setBusy] = useState(false)
  const [ocBusy, setOcBusy] = useState(false)
  /** 最近一次预收抵扣带回的授信释放（ADR-0013），钉在弹窗里直到关闭或换客户 */
  const [effect, setEffect] = useState<{ docNo: string; view: CreditEffectView } | null>(null)

  const openDetail = async (r: any) => {
    setDetailSubject({ t: r.subject_type, id: r.subject_id, name: r.subject_name })
    setTarget('auto')
    setDetail(null)
    setEffect(null)
    try {
      setDetail(await AR_PREPAY_DETAIL(r.subject_type, r.subject_id))
    } catch (e: any) {
      toast(e.message || '加载失败', 'error')
    }
  }

  const refreshDetail = async () => {
    if (!detailSubject) return
    try {
      setDetail(await AR_PREPAY_DETAIL(detailSubject.t, detailSubject.id))
    } catch {
      /* 忽略 */
    }
  }

  const apply = async (receiptId: number) => {
    setBusy(true)
    try {
      const body: any = { receipt_id: receiptId }
      if (target === 'auto') body.auto = true
      else body.ar_id = Number(target)
      const r = await AR_PREPAY_APPLY(body)
      toast(`已抵扣 ${fmtMoney(r.applied)}，剩余预收 ${fmtMoney(r.remaining)}；${creditEffectSummary(r.credit_released, 'released')}`, 'success')
      setEffect({ docNo: r.receipt?.doc_no || `收款单#${receiptId}`, view: formatCreditEffect(r.credit_released, 'released') })
      await refreshDetail()
      reload()
    } catch (e: any) {
      toast(e.message || '抵扣失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const syncOc = async () => {
    setOcBusy(true)
    try {
      const r = await AR_OC_SYNC({ limit: 200 })
      toast(r.count ? `已并入 ${r.count} 张，合计 ${fmtMoney(r.total_amount)}` : '没有待并入的订货单', 'success')
      reload()
    } catch (e: any) {
      toast(e.message || '并入失败', 'error')
    } finally {
      setOcBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <Card pad={false}>
        <div className="px-3 pt-3 flex items-start justify-between">
          <SectionTitle
            title={`客户预收 · ${fmtMoney(data?.total || 0)}`}
            desc="预收余额 = 已确认收款单金额 − 其核销明细之和；点一行查看可抵的未结应收"
          />
        </div>
        <div className="px-3 pb-2">
          <FilterBar onReset={() => setKw('')}>
            <F label="搜索">
              <Inp value={kw} onChange={setKw} placeholder="客户名称" w={200} />
            </F>
          </FilterBar>
        </div>
        <Table
          loading={loading}
          data={rows}
          rowKey={(r) => `${r.subject_type}-${r.subject_id}`}
          onRowClick={openDetail}
          empty="没有预收余额"
          columns={[
            { key: 'subject_name', title: '客户', render: (r) => r.subject_name || `${r.subject_type}#${r.subject_id}` },
            { key: 'received_amount', title: '累计已收', align: 'right', render: (r) => fmtMoney(r.received_amount) },
            { key: 'allocated_amount', title: '已核销', align: 'right', render: (r) => fmtMoney(r.allocated_amount) },
            {
              key: 'prepay_balance',
              title: '预收余额',
              align: 'right',
              render: (r) => <span className="font-medium text-emerald-600">{fmtMoney(r.prepay_balance)}</span>
            },
            {
              key: 'act',
              title: '操作',
              width: 130,
              align: 'center',
              render: (r) => (
                <button
                  className="btn-ghost btn-sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    openDetail(r)
                  }}
                >
                  <Coins size={13} /> 转应收
                </button>
              )
            }
          ]}
        />
      </Card>

      <Card pad={false}>
        <div className="px-3 pt-3 flex items-start justify-between">
          <SectionTitle
            title={`订货中心待并入应收 · ${ocRows.length} 张`}
            desc="已收货 / 已发货但还没生成应收的订货单（正常在确认收货时自动生成，这里是兜底）"
          />
          <button className="btn-ghost btn-sm" disabled={ocBusy} onClick={syncOc}>
            <Inbox size={13} /> 一键并入
          </button>
        </div>
        <Table
          loading={ocLoading}
          data={ocRows}
          rowKey={(r) => String(r.id)}
          empty="没有待并入的订货单"
          columns={[
            { key: 'doc_no', title: '订货单号', width: 160 },
            { key: 'customer_name', title: '订货客户', render: (r) => r.customer_name || '-' },
            { key: 'order_date', title: '下单日期', width: 110 },
            { key: 'total_amount', title: '金额', align: 'right', render: (r) => fmtMoney(r.total_amount) },
            { key: 'status', title: '订单状态', width: 110, align: 'center' }
          ]}
        />
      </Card>

      <Modal
        open={!!detailSubject}
        title={`预收转应收 · ${detailSubject?.name || ''}`}
        onClose={() => {
          setDetailSubject(null)
          setDetail(null)
          setEffect(null)
        }}
        width={880}
        footer={
          <>
            <button
              className="btn-ghost"
              onClick={() => detailSubject && onStatement(detailSubject.t, detailSubject.id)}
            >
              <FileText size={13} /> 看对账单
            </button>
            <button
              className="btn-ghost"
              onClick={() => {
                setDetailSubject(null)
                setDetail(null)
                setEffect(null)
              }}
            >
              关闭
            </button>
          </>
        }
      >
        {!detail && <div className="text-center text-slate-400 py-6">加载中…</div>}
        {detail && (
          <div className="space-y-4 text-[13px]">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded border border-slate-200 px-3 py-2">
                <div className="text-[11px] text-slate-500">预收余额合计</div>
                <div className="text-[16px] font-medium tabular-nums text-emerald-600">{fmtMoney(detail.prepay_total)}</div>
              </div>
              <div className="rounded border border-slate-200 px-3 py-2">
                <div className="text-[11px] text-slate-500">该客户未结应收</div>
                <div className="text-[16px] font-medium tabular-nums">{fmtMoney(detail.open_total)}</div>
              </div>
            </div>

            <div>
              <SectionTitle title="可用的预收（付多的收款单）" desc="选中目标后点「转应收」，钱就从预收移到该笔应收上" />
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[12px] text-slate-500">抵扣目标</span>
                <Sel
                  value={target}
                  onChange={setTarget}
                  options={[
                    { value: 'auto', label: '按到期日自动抵扣（最老先抵）' },
                    ...detail.open_ars.map((a: any) => ({
                      value: String(a.id),
                      label: `${a.doc_no}（${a.source_doc_no || '手工'}，余额 ${fmtMoney(a.open_amount)}）`
                    }))
                  ]}
                />
              </div>
              <Table
                data={detail.receipts}
                rowKey={(r: any) => String(r.id)}
                empty="—"
                columns={[
                  { key: 'doc_no', title: '收款单号', width: 150 },
                  { key: 'receipt_date', title: '收款日期', width: 105 },
                  { key: 'amount', title: '收款金额', align: 'right', render: (r: any) => fmtMoney(r.amount) },
                  { key: 'allocated', title: '已核销', align: 'right', render: (r: any) => fmtMoney(r.allocated) },
                  {
                    key: 'left_amount',
                    title: '可转预收',
                    align: 'right',
                    render: (r: any) => <span className="font-medium text-emerald-600">{fmtMoney(r.left_amount)}</span>
                  },
                  {
                    key: 'act',
                    title: '操作',
                    width: 110,
                    align: 'center',
                    render: (r: any) => (
                      <button className="btn-primary btn-sm" disabled={busy || !detail.open_ars.length} onClick={() => apply(r.id)}>
                        转应收
                      </button>
                    )
                  }
                ]}
              />
              {!detail.open_ars.length && (
                <div className="mt-2 text-[12px] text-slate-400">该客户当前没有未结应收，钱先留在预收里</div>
              )}
              {effect && (
                <div className="mt-2">
                  <CreditEffectPanel view={effect.view} docNo={effect.docNo} onClose={() => setEffect(null)} />
                </div>
              )}
            </div>

            <div>
              <SectionTitle title="可抵的未结应收" desc="预收只会抵到同一往来对象上" />
              <Table
                data={detail.open_ars}
                rowKey={(r: any) => String(r.id)}
                empty="没有未结应收"
                columns={[
                  { key: 'doc_no', title: '应收单号', width: 150 },
                  { key: 'source_doc_no', title: '来源单据', width: 140, render: (r: any) => r.source_doc_no || '-' },
                  { key: 'due_date', title: '到期日', width: 110 },
                  { key: 'open_amount', title: '未收余额', align: 'right', render: (r: any) => fmtMoney(r.open_amount) }
                ]}
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
