/**
 * ============================================================================
 * 文件标识：src/pages/quality/QcCenter.tsx ｜ QcCenter（页面，未取到标题）
 * ============================================================================
 * 【职责】QcCenter（页面，未取到标题）（页面）
 * 【入口】/quality/qc
 * 【主要接口】/qc/overview、/qc/audit
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
 * 页面：QcCenter（页面，未取到标题）
 */

import { useEffect, useState } from 'react'
import {
  Card, SectionTitle, StatCard, Table, Empty, Modal, Field, Tabs,
  fmtInt, toast, useFetch
} from '../../components/ui'
import { FilterBar, Sel, Inp } from '../../components/DataPage'
import {
  QC2_PENDING, QC2_PENDING_DETAIL, QC2_REQUESTS, QC2_REQUEST_CREATE, QC2_REQUEST_SUBMIT, QC2_REQUEST_CLOSE, QC2_REQUEST_CANCEL,
  QC2_INSPECTIONS, QC2_INSPECTION, QC2_INSPECT_SUBMIT,
  QC2_HANDLINGS, QC2_HANDLING_CREATE, QC2_HANDLING_CONFIRM, QC2_HANDLING_CANCEL,
  QC_SOURCE_CLS, QC_STATUS_CLS, QC_STATUS_LABEL, QC_RESULT_CLS, QC_RESULT_LABEL,
  QC_MODE_CLS, QC_MODE_LABEL, QC_MODE_NO_STOCK, QC_MODE_EFFECT, QC_DEFECT_LABEL,
  type QcPendingSource, type QcSourceDetail, type QcRequest, type QcInspection,
  type QcHandling, type QcHandleMode, type QcSourceType
} from '../../api/qc2'
import { RefreshCw, Plus, Send, CheckCircle2, AlertTriangle, ShieldCheck, Undo2, Trash2, Recycle } from 'lucide-react'

/**
 * 质量中心（模块 13：报检 / 检验 / 不良品处理）。
 *
 * 三个业务页签对应三段链，一段一件事：
 *   ① 待检与报检：谁在等检（采购到货 + 生产完工），一键报检；报检单提交后进入待检。
 *   ② 检验：按抽样方案填报不良数，**判定由数字推出来**（不良 ≤ Ac 合格），不由人选。
 *   ③ 不良品处理：不合格的货怎么处置 —— 让步 / 退货 / 报废 / 返工。
 *      **四种都会真的动库存**：报废与退货直接出库；让步与返工**自动生成一张调拨单**
 *      （让步 → 不合格品仓、返工 → 待检品仓），出库与入库都真的发生。
 *
 * 界面上钉死的三条口径：
 *   ① 没有「判合格 / 判不合格」的下拉框 —— 判定只由不良数与 Ac/Re 推导，防止"不良 5 个却点了合格"。
 *   ② 抽样量 ≤ 报检数量、不良数 ≤ 抽样量 —— 输入框直接卡上限，服务端再校验一次。
 *   ③ 处置要有后果 —— 执行后把生成的单据号显示出来（调拨单 / 退货单 / 出库单），
 *      不做只改状态的执行。每种处置的后果文案取 `QC_MODE_EFFECT`（唯一出处），
 *      不在这里各写一份 —— 否则「让步接收」很容易被写成"可以正常卖"，
 *      而那是把批次级的质检结论当成了仓级结论。
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
  `inline-block px-2 py-[1px] rounded border text-[12px] whitespace-nowrap ${map[v] || 'text-slate-600 bg-slate-50 border-slate-200'}`

// 同一个 `draft` 在三张单上的含义完全不同：报检单是「草稿」，检验单是「待检」（等人填结论），
// 处理单是「待处理」（等执行）。共用一套标签会让人以为检验单也是一张没提交的草稿 ——
// 更糟的是筛选框写「待检」而列表里显示「草稿」，用户会以为筛选没生效。
const INSPECT_STATUS_LABEL: Record<string, string> = { ...QC_STATUS_LABEL, draft: '待检' }
const HANDLE_STATUS_LABEL: Record<string, string> = { ...QC_STATUS_LABEL, draft: '待处理', confirmed: '已执行' }

/**
 * 「库存方向」列：四种处置都会真的动库存，所以不再有「不动库存」这一档。
 * 让步 / 返工是**调拨**（原仓出库 + 隔离仓入库），写成"出库"会让人以为货没了 ——
 * 单独标成「调拨出库」，与直接出库区分开。
 */
function dirBadge(r: QcHandling) {
  if (r.stock_direction !== 'out') return <span className="text-slate-400">-</span>
  if (r.mode === 'concession' || r.mode === 'rework') return <span className="text-amber-600">调拨出库</span>
  return <span className="text-rose-600">出库</span>
}

/** 执行成功后的提示：与列表「生成单据」列同口径（单号 + 类型 + 去哪），避免两处文案分叉 */
function genDocToast(r: QcHandling) {
  if (!r.out_doc_no) return `${r.mode_label}已执行`
  const to = r.out_doc_type === 'TF' ? `（质检处置调拨 → ${r.mode === 'rework' ? '待检品仓' : '不合格品仓'}）` : ''
  return `${r.mode_label}已执行，生成 ${r.out_doc_type} ${r.out_doc_no}${to}`
}

/**
 * 「生成单据」列：把这一步产生的单据显示出来 —— 处置的价值就在这里（不做只改状态的执行）。
 * 调拨单（TF）额外标出**类型 + 调入哪个隔离仓**：客户口径「出入库单上一定要加一个类型」，
 * 所以这里不能只给单号 —— 要能一眼看出「这是一张质检处置调拨、货去了不合格品仓/待检品仓」。
 * （类型文案与 `server/lib/transfer.js` 的 TRANSFER_TYPES 同口径。）
 */
function genDocBadge(r: QcHandling) {
  if (!r.out_doc_no) return <span className="text-slate-400">-</span>
  const to = r.out_doc_type === 'TF' ? (r.mode === 'rework' ? '待检品仓' : '不合格品仓') : null
  return (
    <span className="whitespace-nowrap">
      {r.out_doc_type} {r.out_doc_no}
      {to && <span className="text-slate-500">（质检处置调拨 → {to}）</span>}
    </span>
  )
}

// 检验水平落库是英文枚举，界面上必须给中文 —— 直接显示 normal/tightened
// 会让「这张单为什么 Ac 比别人低 1」变成一个没人看得懂的问题
const LEVEL_LABEL: Record<string, string> = { normal: '正常检验', tightened: '加严检验', reduced: '放宽检验' }

export default function QcCenter() {
  const [tab, setTab] = useState<'overview' | 'request' | 'inspect' | 'handle'>('overview')
  const [tick, setTick] = useState(0)
  const reload = () => setTick((t) => t + 1)
  const { data: ov } = useFetch<any>('/qc/overview', undefined, [tick])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionTitle
          title="质量中心"
          desc="判定由不良数与 Ac/Re 推导不由人选 · 抽样量 ≤ 报检数量、不良数 ≤ 抽样量 · 四种处置都要真的动库存：报废/退货直接出库，让步→自动调拨入不合格仓、返工→自动调拨入待检仓"
        />
        <button className="btn-ghost" onClick={reload}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      <Tabs
        tabs={[
          { key: 'overview', label: '总览' },
          { key: 'request', label: '待检与报检', count: ov?.pending_source },
          { key: 'inspect', label: '检验', count: ov?.waiting_inspect },
          { key: 'handle', label: '不良品处理', count: ov?.handlings_draft }
        ]}
        value={tab}
        onChange={(k) => setTab(k as any)}
      />

      {tab === 'overview' && <OverviewTab tick={tick} ov={ov} />}
      {tab === 'request' && <RequestTab tick={tick} reload={reload} />}
      {tab === 'inspect' && <InspectTab tick={tick} reload={reload} />}
      {tab === 'handle' && <HandleTab tick={tick} reload={reload} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ① 总览
// ---------------------------------------------------------------------------

function OverviewTab({ tick, ov }: { tick: number; ov: any }) {
  const { data: audit } = useFetch<any>('/qc/audit', undefined, [tick])
  const badKeys = ['badLineQty', 'badVerdict', 'headDrift', 'inspDrift', 'overHandle', 'staleHandle', 'closedWithDraft', 'shortHandle', 'orphan', 'missingStockEffect']
  const auditLabel: Record<string, string> = {
    badLineQty: '行内数量关系不成立（抽样 > 报检 / 不良 > 抽样 / Ac ≥ Re）',
    badVerdict: '判定与数字不一致（判合格但不良 > Ac）',
    headDrift: '报检单头汇总与行合计不符',
    inspDrift: '检验单汇总与行不良数不符',
    overHandle: '处置数量超过报检数量（同一批被处理两次）',
    staleHandle: '结论合格却挂着处理单',
    closedWithDraft: '已关闭的报检单上还有未执行的处置',
    shortHandle: '已关闭的报检单里有不合格行没处置满（剩下的货没人管）',
    orphan: '孤儿子引用',
    missingStockEffect: '退货 / 报废的执行单没有出库单号'
  }
  const badCount = badKeys.reduce((s, k) => s + (audit?.[k]?.length || 0), 0)
  const modeRows: { mode: string; label: string; c: number; qty: number }[] = ov?.by_mode || []
  const srcRows: { source_type: string; label: string; c: number }[] = ov?.by_source || []

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="待检来源" value={fmtInt(ov?.pending_source || 0)} tone={ov?.pending_source ? 'warn' : 'good'} icon={<AlertTriangle size={16} />} sub="采购到货 + 生产完工" />
        <StatCard label="待出结论" value={fmtInt(ov?.waiting_inspect || 0)} tone={ov?.waiting_inspect ? 'warn' : 'good'} sub="已报检、还没填检验结果" />
        <StatCard label="已检合格 / 不合格" value={`${fmtInt(ov?.qualified || 0)} / ${fmtInt(ov?.unqualified || 0)}`} tone={ov?.unqualified ? 'bad' : 'good'} sub="按不合格优先处理" />
        <StatCard label="不良率（加权）" value={`${(ov?.defect_rate || 0).toFixed(2)}%`} sub="按抽样量算：不良数 ÷ 抽样量" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="待执行处置" value={fmtInt(ov?.handlings_draft || 0)} tone={ov?.handlings_draft ? 'warn' : 'default'} sub="草稿处置单（还没产生库存后果）" />
        <StatCard label="让步接收（数量）" value={fmtInt(ov?.concession_qty || 0)} sub="自动调拨入不合格仓（出库+入库），批次仍判不合格" />
        <StatCard label="退货（数量）" value={fmtInt(ov?.return_qty || 0)} tone={ov?.return_qty ? 'warn' : 'default'} sub="采购来源生成退货单并出库" />
        <StatCard label="报废（数量）" value={fmtInt(ov?.scrap_qty || 0)} tone={ov?.scrap_qty ? 'bad' : 'default'} sub="报废出库，数量直接扣减" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card>
          <SectionTitle title="按来源分布" desc="质检第一次能按来源统计 —— 采购、生产、在库复检各占多少" />
          {srcRows.length === 0 ? (
            <Empty text="还没有报检单" />
          ) : (
            <Table
              data={srcRows}
              empty="—"
              columns={[
                { key: 'label', title: '来源', render: (r) => <span className={pill(QC_SOURCE_CLS, r.source_type)}>{r.label}</span> },
                { key: 'c', title: '报检单数', align: 'right', render: (r) => fmtInt(r.c) }
              ]}
            />
          )}
        </Card>
        <Card>
          <SectionTitle title="按处置方式分布" desc="四路分流各走了多少 —— 这是「质检有没有后果」的直接证据" />
          {modeRows.length === 0 ? (
            <Empty text="还没有处置单" />
          ) : (
            <Table
              data={modeRows}
              empty="—"
              columns={[
                { key: 'label', title: '处置方式', render: (r) => <span className={pill(QC_MODE_CLS, r.mode)}>{r.label}</span> },
                { key: 'c', title: '单据数', align: 'right', render: (r) => fmtInt(r.c) },
                { key: 'qty', title: '数量', align: 'right', render: (r) => fmtInt(r.qty) }
              ]}
            />
          )}
        </Card>
      </div>

      <Card>
        <SectionTitle
          title="自洽审计"
          desc="判定必须与数字一致（判合格就不能有不良数 > Ac）· 头行汇总一致 · 处置不超报检量 · 关单前不合格行必须处置满 · 退货报废必有出库单 · 无孤儿子引用"
        />
        {audit?.ok ? (
          <div className="flex items-center gap-2 text-[13px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
            <ShieldCheck size={15} /> 十类检查全部通过：数字自洽、判定与数字一致、头行一致、处置不超量、关单前处置满、库存后果齐备、无孤儿子引用
          </div>
        ) : (
          <div className="space-y-2 text-[13px]">
            <div className="text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-center gap-2">
              <AlertTriangle size={14} /> 发现 {badCount} 处不一致
            </div>
            <Table
              data={badKeys.flatMap((k) => (audit?.[k] || []).map((r: any) => ({ ...r, _t: k })))}
              empty="—"
              columns={[
                { key: '_t', title: '问题类型', width: 260, render: (r) => auditLabel[r._t] || r._t },
                { key: 'doc_no', title: '单据', width: 160, render: (r) => r.doc_no || r.id },
                { key: 'sku_id', title: 'SKU', width: 80, render: (r) => (r.sku_id == null ? '-' : `#${r.sku_id}`) },
                { key: 'detail', title: '说明', render: (r) => r.defect_qty != null ? `不良 ${r.defect_qty} / Ac ${r.ac} / 判定 ${r.result}` : '' }
              ]}
            />
          </div>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ② 待检与报检
// ---------------------------------------------------------------------------

function RequestTab({ tick, reload }: { tick: number; reload: () => void }) {
  const [srcType, setSrcType] = useState('')
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('')
  const { data: pend, loading: pl } = useFetch<any>(
    '/qc/pending',
    { source_type: srcType || undefined, keyword: keyword || undefined },
    [tick, srcType, keyword]
  )
  const { data: reqs, loading: rl } = useFetch<any>(
    '/qc/requests',
    { status: status || undefined, keyword: keyword || undefined, pageSize: 50 },
    [tick, status, keyword]
  )
  const [target, setTarget] = useState<QcPendingSource | null>(null)
  const [detail, setDetail] = useState<QcRequest | null>(null)

  const sources: QcPendingSource[] = pend?.list || []
  const rows: QcRequest[] = reqs?.list || []

  const act = async (fn: () => Promise<any>, okMsg: string) => {
    try {
      const r = await fn()
      toast(`${okMsg}${r?.doc_no ? ` ${r.doc_no}` : ''}`, 'success')
      reload()
    } catch (e: any) {
      toast(e.message || '操作失败', 'error')
    }
  }

  return (
    <div className="space-y-3">
      <FilterBar onReset={() => { setSrcType(''); setKeyword(''); setStatus('') }}>
        <F label="搜索">
          <Inp value={keyword} onChange={setKeyword} placeholder="单号 / 供应商 / 车间" w={200} />
        </F>
        <F label="来源">
          <Sel
            value={srcType}
            onChange={setSrcType}
            options={[
              { value: '', label: '全部' },
              { value: 'purchase_receipt', label: '采购到货' },
              { value: 'production_order', label: '生产完工' }
            ]}
          />
        </F>
        <F label="报检状态">
          <Sel
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: '全部' },
              { value: 'draft', label: '草稿' },
              { value: 'submitted', label: '已报检' },
              { value: 'closed', label: '已关闭' }
            ]}
          />
        </F>
      </FilterBar>

      <Card pad={false}>
        <div className="px-3 pt-3">
          <SectionTitle
            title="待检来源"
            desc="采购到货（已收货）与生产完工（已完成）；已被模块 07 质检覆盖或已报检的不再出现 —— 同一批货不会被检两次"
          />
        </div>
        <Table
          loading={pl}
          data={sources}
          empty="没有待检来源"
          columns={[
            { key: 'source_doc_no', title: '来源单号', width: 160 },
            { key: 'source_type', title: '来源', width: 100, render: (r) => <span className={pill(QC_SOURCE_CLS, r.source_type)}>{r.source_label}</span> },
            { key: 'subject_name', title: '供应商 / 车间', width: 180, render: (r) => r.subject_name || '-' },
            { key: 'warehouse_name', title: '仓库', width: 120, render: (r) => r.warehouse_name || '-' },
            { key: 'biz_date', title: '业务日期', width: 110 },
            { key: 'qty', title: '待检数量', align: 'right', render: (r) => fmtInt(r.qty) },
            {
              key: '_op', title: '操作', width: 100,
              render: (r) => (
                <button className="btn-primary btn-sm" onClick={() => setTarget(r)}>
                  <Plus size={12} /> 报检
                </button>
              )
            }
          ]}
        />
      </Card>

      <Card pad={false}>
        <div className="px-3 pt-3">
          <SectionTitle title="报检单" desc="提交报检会同时生成一对一的检验单草稿；全部合格时系统自动关闭报检单" />
        </div>
        <Table
          loading={rl}
          data={rows}
          onRowClick={(r) => setDetail(r as QcRequest)}
          empty="还没有报检单"
          columns={[
            { key: 'doc_no', title: '报检单号', width: 160 },
            { key: 'source_type', title: '来源', width: 100, render: (r) => <span className={pill(QC_SOURCE_CLS, r.source_type)}>{r.source_label}</span> },
            { key: 'source_doc_no', title: '来源单号', width: 150, render: (r) => r.source_doc_no || '-' },
            { key: 'subject_name', title: '供应商 / 车间', width: 160, render: (r) => r.subject_name || '-' },
            { key: 'request_date', title: '报检日期', width: 110 },
            { key: 'total_qty', title: '报检数量', align: 'right', render: (r) => fmtInt(r.total_qty) },
            { key: 'total_sample_qty', title: '抽样量', align: 'right', render: (r) => fmtInt(r.total_sample_qty) },
            { key: 'unqualified_lines', title: '不合格行', align: 'right', render: (r) => (r.unqualified_lines ? <span className="text-rose-600 font-medium">{r.unqualified_lines}</span> : '-') },
            { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(QC_STATUS_CLS, r.status)}>{QC_STATUS_LABEL[r.status] || r.status}</span> },
            {
              key: '_op', title: '操作', width: 220,
              render: (r) => (
                <div className="flex gap-1">
                  {r.status === 'draft' && (
                    <button className="btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); act(() => QC2_REQUEST_SUBMIT(r.id).then((x) => x.request), '已提交报检') }}>
                      <Send size={12} /> 提交
                    </button>
                  )}
                  {r.status === 'submitted' && (
                    <button className="btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); act(() => QC2_REQUEST_CLOSE(r.id), '已关闭') }}>
                      <CheckCircle2 size={12} /> 关闭
                    </button>
                  )}
                  {r.status === 'draft' && (
                    <button className="btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); act(() => QC2_REQUEST_CANCEL(r.id, '手工作废'), '已作废') }}>
                      <Trash2 size={12} /> 作废
                    </button>
                  )}
                </div>
              )
            }
          ]}
        />
      </Card>

      <CreateRequestModal source={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); reload() }} />

      <Modal
        open={!!detail}
        title={`报检单详情 · ${detail?.doc_no || ''}`}
        onClose={() => setDetail(null)}
        width={1100}
      >
        {detail && (
          <div className="space-y-3">
            <div className="grid grid-cols-5 gap-3 text-[13px]">
              <div><div className="text-slate-500 text-[12px]">来源</div>{detail.source_label} · {detail.source_doc_no || '-'}</div>
              <div><div className="text-slate-500 text-[12px]">供应商 / 车间</div>{detail.subject_name || '-'}</div>
              <div><div className="text-slate-500 text-[12px]">报检日期</div>{detail.request_date}</div>
              <div><div className="text-slate-500 text-[12px]">检验水平</div>{LEVEL_LABEL[detail.inspect_level] || detail.inspect_level} · AQL {detail.aql}</div>
              <div><div className="text-slate-500 text-[12px]">状态</div><span className={pill(QC_STATUS_CLS, detail.status)}>{QC_STATUS_LABEL[detail.status]}</span></div>
            </div>
            <Table
              data={detail.items || []}
              empty="无明细"
              columns={[
                { key: 'line_no', title: '行', width: 50 },
                { key: 'sku_name', title: '商品', width: 220, render: (r) => <span className="whitespace-nowrap">{r.sku_name || `SKU#${r.sku_id}`}</span> },
                { key: 'batch_no', title: '批次', width: 120, render: (r) => r.batch_no || '-' },
                { key: 'qty', title: '报检数量', align: 'right', render: (r) => fmtInt(r.qty) },
                { key: 'sample_qty', title: '抽样 n', align: 'right', render: (r) => fmtInt(r.sample_qty) },
                { key: 'ac', title: 'Ac', align: 'right', width: 60 },
                { key: 're', title: 'Re', align: 'right', width: 60 },
                { key: 'result', title: '判定', width: 90, render: (r) => <span className={pill(QC_RESULT_CLS, r.result)}>{QC_RESULT_LABEL[r.result] || r.result}</span> }
              ]}
            />
          </div>
        )}
      </Modal>
    </div>
  )
}

/** 建报检单：装填来源行 → 可改报检数量与检验水平（建单前试算抽样量） */
function CreateRequestModal({ source, onClose, onDone }: { source: QcPendingSource | null; onClose: () => void; onDone: () => void }) {
  const [det, setDet] = useState<QcSourceDetail | null>(null)
  const [qty, setQty] = useState<Record<number, number>>({})
  const [level, setLevel] = useState('normal')
  const [aql, setAql] = useState('2.5')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!source) return
    setBusy(false); setLevel('normal'); setAql('2.5'); setDet(null); setQty({})
    QC2_PENDING_DETAIL(source.source_type as QcSourceType, source.source_id)
      .then((d) => {
        setDet(d)
        const m: Record<number, number> = {}
        d.items.forEach((l, i) => { m[i] = Number(l.qty) })
        setQty(m)
      })
      .catch((e: any) => toast(e.message || '加载来源明细失败', 'error'))
  }, [source])

  const pick = (i: number, v: string) => setQty((m) => ({ ...m, [i]: Number(v) || 0 }))

  const submit = async (thenSubmit: boolean) => {
    if (!source || !det) return
    const items = det.items
      .map((l, i) => ({ source_item_id: l.source_item_id, sku_id: l.sku_id, batch_no: l.batch_no || '', qty: Number(qty[i] || 0) }))
      .filter((x) => x.qty > 0)
    if (!items.length) return toast('请至少填写一行的报检数量', 'error')
    setBusy(true)
    try {
      const req = await QC2_REQUEST_CREATE({
        source_type: source.source_type as QcSourceType,
        source_id: source.source_id,
        level,
        aql: Number(aql) || 2.5,
        items,
        remark: `质量中心由${source.source_label}报检`
      })
      if (thenSubmit) {
        const r = await QC2_REQUEST_SUBMIT(req.id)
        toast(`已报检 ${req.doc_no}，检验单 ${r.inspection.doc_no} 已生成`, 'success')
      } else {
        toast(`已生成报检单草稿 ${req.doc_no}`, 'success')
      }
      onDone()
    } catch (e: any) {
      toast(e.message || '报检失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={!!source}
      title={`报检 · ${source?.source_doc_no || ''}`}
      onClose={onClose}
      width={880}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-ghost" disabled={busy} onClick={() => submit(false)}>存草稿</button>
          <button className="btn-primary" disabled={busy} onClick={() => submit(true)}>
            <Send size={13} /> 报检并提交
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label="来源">
            <div className="text-[13px] pt-1">{source?.source_label} · {source?.source_doc_no}</div>
          </Field>
          <Field label="检验水平">
            <Sel
              value={level}
              onChange={setLevel}
              options={[
                { value: 'normal', label: '正常检验' },
                { value: 'tightened', label: '加严检验（Ac −1）' },
                { value: 'reduced', label: '放宽检验（Ac +1）' }
              ]}
            />
          </Field>
          <Field label="AQL">
            <Inp value={aql} onChange={setAql} w={100} />
          </Field>
        </div>

        <div className="text-[12px] text-slate-500 bg-slate-50 border border-slate-200 rounded px-3 py-2">
          抽样方案按「批量 × 检验水平」在建单时算好写进行里 —— 不是检验时现算。
          现算意味着同一批货今天算和明天算可能不一样（参数被改了），判过的案子就再也复现不了。
        </div>

        <Table
          data={det?.items || []}
          empty="该来源没有可报检的明细"
          columns={[
            { key: 'sku_name', title: '商品', width: 220, render: (r) => <span className="whitespace-nowrap">{r.sku_name || `SKU#${r.sku_id}`}</span> },
            { key: 'sku_code', title: '编码', width: 130, render: (r) => r.sku_code || '-' },
            { key: 'batch_no', title: '批次', width: 120, render: (r) => r.batch_no || '-' },
            { key: 'qty', title: '来源数量', align: 'right', render: (r) => fmtInt(r.qty) },
            {
              key: 'pick', title: '本次报检数量', width: 140,
              render: (r, i) => (
                <input
                  className="input input-sm text-right"
                  style={{ width: 110 }}
                  type="number"
                  value={qty[i] ?? 0}
                  onChange={(e) => pick(i, e.target.value)}
                />
              )
            }
          ]}
        />
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// ③ 检验
// ---------------------------------------------------------------------------

function InspectTab({ tick, reload }: { tick: number; reload: () => void }) {
  const [status, setStatus] = useState('')
  const [result, setResult] = useState('')
  const { data, loading } = useFetch<any>(
    '/qc/inspections',
    { status: status || undefined, result: result || undefined, pageSize: 50 },
    [tick, status, result]
  )
  const rows: QcInspection[] = data?.list || []
  const [openId, setOpenId] = useState<number | null>(null)

  return (
    <div className="space-y-3">
      <FilterBar onReset={() => { setStatus(''); setResult('') }}>
        <F label="检验状态">
          <Sel
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: '全部' },
              { value: 'draft', label: '待检' },
              { value: 'inspected', label: '已检' },
              { value: 'closed', label: '已关闭' }
            ]}
          />
        </F>
        <F label="结论">
          <Sel
            value={result}
            onChange={setResult}
            options={[
              { value: '', label: '全部' },
              { value: 'qualified', label: '合格' },
              { value: 'unqualified', label: '不合格' }
            ]}
          />
        </F>
      </FilterBar>

      <Card pad={false}>
        <div className="px-3 pt-3">
          <SectionTitle title="检验单" desc="点行进入检验：按行填不良数，判定由 不良数 vs Ac 推出；不合格的行在同一个弹窗里开处置单" />
        </div>
        <Table
          loading={loading}
          data={rows}
          onRowClick={(r) => setOpenId(r.id)}
          empty="没有检验单"
          columns={[
            { key: 'doc_no', title: '检验单号', width: 160 },
            { key: 'request_no', title: '报检单号', width: 160, render: (r) => r.request_no || '-' },
            { key: 'source_type', title: '来源', width: 100, render: (r) => <span className={pill(QC_SOURCE_CLS, r.source_type)}>{r.source_label}</span> },
            { key: 'source_doc_no', title: '来源单号', width: 150, render: (r) => r.source_doc_no || '-' },
            { key: 'inspect_date', title: '检验日期', width: 110 },
            { key: 'sample_qty', title: '抽样量', align: 'right', render: (r) => fmtInt(r.sample_qty) },
            { key: 'defect_qty', title: '不良数', align: 'right', render: (r) => (r.defect_qty ? <span className="text-rose-600">{fmtInt(r.defect_qty)}</span> : '-') },
            { key: 'defect_rate', title: '不良率', align: 'right', render: (r) => `${(r.defect_rate || 0).toFixed(2)}%` },
            { key: 'result', title: '结论', width: 90, render: (r) => <span className={pill(QC_RESULT_CLS, r.result)}>{QC_RESULT_LABEL[r.result] || r.result}</span> },
            { key: 'disposition', title: '处置', width: 100, render: (r) => (r.disposition === 'none' ? '-' : <span className={pill(QC_MODE_CLS, r.disposition)}>{r.disposition_label}</span>) },
            { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(QC_STATUS_CLS, r.status)}>{INSPECT_STATUS_LABEL[r.status] || r.status}</span> }
          ]}
        />
      </Card>

      <InspectionModal id={openId} onClose={() => setOpenId(null)} onDone={() => { reload() }} />
    </div>
  )
}

/** 检验 + 处置：一屏完成「填不良数 → 提交结论 → 开处置单 → 执行」 */
function InspectionModal({ id, onClose, onDone }: { id: number | null; onClose: () => void; onDone: () => void }) {
  const [det, setDet] = useState<QcInspection | null>(null)
  const [defects, setDefects] = useState<Record<number, number>>({})
  const [codes, setCodes] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [hForm, setHForm] = useState<{ itemIdx: number; mode: QcHandleMode; qty: string; reason: string } | null>(null)

  const load = () => {
    if (!id) return
    QC2_INSPECTION(id)
      .then((d) => {
        setDet(d)
        const m: Record<number, number> = {}
        const c: Record<number, string> = {}
        ;(d.items || []).forEach((it) => { m[it.id] = Number(it.defect_qty || 0); c[it.id] = it.defect_code || 'appearance' })
        setDefects(m); setCodes(c)
      })
      .catch((e: any) => toast(e.message || '加载检验单失败', 'error'))
  }
  useEffect(() => { setDet(null); setBusy(false); setHForm(null); load() /* eslint-disable-line */ }, [id])

  const isDraft = det?.status === 'draft'
  const unq = (det?.items || []).filter((x) => x.result === 'unqualified' && Number(x.remain_handle_qty || 0) > 0)

  const submitInspect = async () => {
    if (!det) return
    setBusy(true)
    try {
      const lines = (det.items || []).map((it) => ({
        id: it.id,
        defect_qty: Number(defects[it.id] || 0),
        defect_code: codes[it.id] || 'appearance'
      }))
      const r = await QC2_INSPECT_SUBMIT(det.id, lines)
      toast(`结论：${r.result_label}（抽样 ${fmtInt(r.sample_qty)}，不良 ${fmtInt(r.defect_qty)}）`, 'success')
      load(); onDone()
    } catch (e: any) {
      toast(e.message || '提交结论失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const createH = async () => {
    if (!det || !hForm) return
    const it = (det.items || [])[hForm.itemIdx]
    if (!it) return
    setBusy(true)
    try {
      await QC2_HANDLING_CREATE({
        inspection_id: det.id,
        sku_id: it.sku_id,
        batch_no: it.batch_no || '',
        qty: Number(hForm.qty) || 0,
        mode: hForm.mode,
        reason: hForm.reason || undefined,
        defect_code: it.defect_code || undefined
      })
      toast('已生成处置单草稿（确认执行才会产生库存后果）', 'success')
      setHForm(null); load(); onDone()
    } catch (e: any) {
      toast(e.message || '建处置单失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const confirmH = async (h: QcHandling) => {
    try {
      const r = await QC2_HANDLING_CONFIRM(h.id)
      toast(genDocToast(r), 'success')
      load(); onDone()
    } catch (e: any) {
      toast(e.message || '执行失败', 'error')
    }
  }

  const cancelH = async (h: QcHandling) => {
    try {
      await QC2_HANDLING_CANCEL(h.id, '取消处置')
      toast('已取消处置单', 'success')
      load(); onDone()
    } catch (e: any) {
      toast(e.message || '取消失败', 'error')
    }
  }

  return (
    <Modal
      open={!!id}
      title={`检验单 · ${det?.doc_no || ''}`}
      onClose={() => { onClose(); onDone() }}
      width={1280}
      footer={
        isDraft ? (
          <>
            <button className="btn-ghost" onClick={() => { onClose(); onDone() }}>关闭</button>
            <button className="btn-primary" disabled={busy} onClick={submitInspect}>
              <CheckCircle2 size={13} /> 提交检验结论
            </button>
          </>
        ) : (
          <button className="btn-ghost" onClick={() => { onClose(); onDone() }}>关闭</button>
        )
      }
    >
      {det && (
        <div className="space-y-3">
          <div className="grid grid-cols-4 gap-3 text-[13px]">
            <div><div className="text-slate-500 text-[12px]">来源</div>{det.source_label} · {det.source_doc_no || '-'}</div>
            <div><div className="text-slate-500 text-[12px]">仓库</div>{det.warehouse_name || '-'}</div>
            <div><div className="text-slate-500 text-[12px]">检验水平</div>{LEVEL_LABEL[det.inspect_level] || det.inspect_level} · AQL {det.aql}</div>
            <div><div className="text-slate-500 text-[12px]">结论</div>
              <span className={pill(QC_RESULT_CLS, det.result)}>{QC_RESULT_LABEL[det.result] || det.result}</span>
              {det.disposition !== 'none' && <> <span className={pill(QC_MODE_CLS, det.disposition)}>{det.disposition_label}</span></>}
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <StatCard label="报检数量" value={fmtInt(det.total_qty)} />
            <StatCard label="抽样量" value={fmtInt(det.sample_qty)} sub="由抽样方案（n/Ac/Re）决定" />
            <StatCard label="不良数" value={fmtInt(det.defect_qty)} tone={det.defect_qty ? 'bad' : 'good'} />
            <StatCard label="不良率" value={`${(det.defect_rate || 0).toFixed(2)}%`} sub="不良数 ÷ 抽样量" />
          </div>

          <Table
            data={det.items || []}
            empty="无明细"
            columns={[
              { key: 'line_no', title: '行', width: 50 },
              { key: 'sku_name', title: '商品', width: 220, render: (r) => <span className="whitespace-nowrap">{r.sku_name || `SKU#${r.sku_id}`}</span> },
              { key: 'batch_no', title: '批次', width: 120, render: (r) => r.batch_no || '-' },
              { key: 'qty', title: '报检数量', align: 'right', render: (r) => fmtInt(r.qty) },
              { key: 'sample_qty', title: '抽样 n', align: 'right', render: (r) => fmtInt(r.sample_qty) },
              { key: 'ac', title: 'Ac', align: 'right', width: 55 },
              { key: 're', title: 'Re', align: 'right', width: 55 },
              {
                key: 'defect', title: '实测不良数', width: 130,
                render: (r) => isDraft ? (
                  <input
                    className="input input-sm text-right"
                    style={{ width: 100 }}
                    type="number"
                    min={0}
                    max={r.sample_qty}
                    value={defects[r.id] ?? 0}
                    onChange={(e) => setDefects((m) => ({ ...m, [r.id]: Math.min(Number(e.target.value) || 0, Number(r.sample_qty)) }))}
                  />
                ) : (
                  <span className={r.defect_qty ? 'text-rose-600' : ''}>{fmtInt(r.defect_qty)}</span>
                )
              },
              {
                key: 'code', title: '缺陷', width: 130,
                render: (r) => isDraft ? (
                  <Sel
                    value={codes[r.id] || 'appearance'}
                    onChange={(v) => setCodes((m) => ({ ...m, [r.id]: v }))}
                    options={Object.entries(QC_DEFECT_LABEL).map(([value, label]) => ({ value, label }))}
                  />
                ) : (
                  <span className="whitespace-nowrap">{QC_DEFECT_LABEL[r.defect_code || ''] || '-'}</span>
                )
              },
              {
                key: 'result', title: '判定', width: 100,
                render: (r) => (
                  <span className={`whitespace-nowrap ${pill(QC_RESULT_CLS, isDraft && r.result === 'pending' ? (Number(defects[r.id] || 0) <= r.ac ? 'qualified' : 'unqualified') : r.result)}`}>
                    {isDraft && r.result === 'pending'
                      ? (Number(defects[r.id] || 0) <= r.ac ? '合格' : '不合格')
                      : (QC_RESULT_LABEL[r.result] || r.result)}
                  </span>
                )
              },
              {
                key: 'handled', title: '已处置 / 可处置', width: 130, align: 'right',
                render: (r) => `${fmtInt(r.handled_qty || 0)} / ${fmtInt(r.remain_handle_qty ?? r.qty)}`
              }
            ]}
          />

          <div className="text-[12px] text-slate-500 bg-slate-50 border border-slate-200 rounded px-3 py-2">
            判定只看数字：实测不良数 ≤ Ac 判合格，大于 Ac 判不合格。界面上没有「判合格 / 判不合格」的下拉框 ——
            让人手选结论，就会出现「不良 5 个却点了合格」，而系统毫无察觉。
          </div>

          {!isDraft && det.result === 'unqualified' && (
            <div className="space-y-2">
              <SectionTitle
                title="不良品处理"
                desc="处置按 SKU × 批次逐条决策；四种处置都会真的动库存 —— 报废/退货直接出库，让步→自动调拨入不合格仓、返工→自动调拨入待检仓"
                right={
                  unq.length > 0 && (
                    <button className="btn-primary btn-sm" onClick={() => {
                      const idx = (det.items || []).findIndex((x) => x.result === 'unqualified' && Number(x.remain_handle_qty || 0) > 0)
                      const it = (det.items || [])[idx]
                      setHForm({ itemIdx: idx, mode: 'concession', qty: String(Number(it.remain_handle_qty || it.qty)), reason: '' })
                    }}>
                      <Plus size={12} /> 新增处置
                    </button>
                  )
                }
              />
              {(det.handlings || []).length === 0 ? (
                <Empty text="还没有处置单 —— 不合格的货必须先决定怎么处理，报检单才能关闭" />
              ) : (
                <Table
                  data={det.handlings || []}
                  empty="—"
                  columns={[
                    { key: 'doc_no', title: '处置单号', width: 160 },
                    { key: 'sku_name', title: '商品', width: 220, render: (r) => <span className="whitespace-nowrap">{r.sku_name || `SKU#${r.sku_id}`}</span> },
                    { key: 'batch_no', title: '批次', width: 110, render: (r) => r.batch_no || '-' },
                    { key: 'mode', title: '方式', width: 100, render: (r) => <span className={pill(QC_MODE_CLS, r.mode)}>{r.mode_label}</span> },
                    { key: 'qty', title: '数量', align: 'right', render: (r) => fmtInt(r.qty) },
                    {
                      key: 'dir', title: '库存方向', width: 110,
                      render: (r) => dirBadge(r)
                    },
                    { key: 'out_doc_no', title: '生成单据', width: 240, render: (r) => genDocBadge(r) },
                    { key: 'reason', title: '理由', width: 200, render: (r) => r.reason || '-' },
                    { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(QC_STATUS_CLS, r.status)}>{HANDLE_STATUS_LABEL[r.status] || r.status}</span> },
                    {
                      key: '_op', title: '操作', width: 150,
                      render: (r) => r.status === 'draft' ? (
                        <div className="flex gap-1">
                          <button className="btn-primary btn-sm" onClick={() => confirmH(r)}>
                            <Recycle size={12} /> 执行
                          </button>
                          <button className="btn-ghost btn-sm" onClick={() => cancelH(r)}>
                            <Undo2 size={12} />
                          </button>
                        </div>
                      ) : null
                    }
                  ]}
                />
              )}
            </div>
          )}

          {hForm && (() => {
            const it = (det.items || [])[hForm.itemIdx]
            if (!it) return null
            const noStock = QC_MODE_NO_STOCK.includes(hForm.mode)
            return (
              <Card>
                <SectionTitle title={`新增处置 · ${it.sku_name || `SKU#${it.sku_id}`}`} desc={`该行可处置 ${fmtInt(it.remain_handle_qty ?? it.qty)}（报检 ${fmtInt(it.qty)} − 已处置 ${fmtInt(it.handled_qty || 0)}）`} />
                <div className="grid grid-cols-3 gap-3">
                  <Field label="处置方式">
                    <Sel
                      value={hForm.mode}
                      onChange={(v) => setHForm({ ...hForm, mode: v as QcHandleMode })}
                      options={Object.entries(QC_MODE_LABEL).map(([value, label]) => ({ value, label }))}
                    />
                  </Field>
                  <Field label="处置数量">
                    <Inp value={hForm.qty} onChange={(v) => setHForm({ ...hForm, qty: v })} w={120} />
                  </Field>
                  <Field label={hForm.mode === 'concession' ? '理由（必填）' : '理由'}>
                    <Inp value={hForm.reason} onChange={(v) => setHForm({ ...hForm, reason: v })} placeholder={hForm.mode === 'concession' ? '明知不合格仍收下，必须说明为什么' : '可填'} w={280} />
                  </Field>
                </div>
                <div className="mt-2 text-[12px] text-slate-500">
                  {QC_MODE_EFFECT[hForm.mode] || '执行后会产生库存后果。'}
                  {noStock && '（该方式不动库存：货留在库里，只是把这件事记下来。）'}
                </div>
                <div className="mt-3 flex gap-2">
                  <button className="btn-primary" disabled={busy} onClick={createH}>生成处置单</button>
                  <button className="btn-ghost" onClick={() => setHForm(null)}>取消</button>
                </div>
              </Card>
            )
          })()}
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// ④ 不良品处理
// ---------------------------------------------------------------------------

function HandleTab({ tick, reload }: { tick: number; reload: () => void }) {
  const [status, setStatus] = useState('')
  const [mode, setMode] = useState('')
  const { data, loading } = useFetch<any>(
    '/qc/handlings',
    { status: status || undefined, mode: mode || undefined, pageSize: 50 },
    [tick, status, mode]
  )
  const rows: QcHandling[] = data?.list || []

  const confirmH = async (h: QcHandling) => {
    try {
      const r = await QC2_HANDLING_CONFIRM(h.id)
      toast(genDocToast(r), 'success')
      reload()
    } catch (e: any) {
      toast(e.message || '执行失败', 'error')
    }
  }
  const cancelH = async (h: QcHandling) => {
    try {
      await QC2_HANDLING_CANCEL(h.id, '取消处置')
      toast('已取消处置单', 'success')
      reload()
    } catch (e: any) {
      toast(e.message || '取消失败', 'error')
    }
  }

  return (
    <div className="space-y-3">
      <FilterBar onReset={() => { setStatus(''); setMode('') }}>
        <F label="状态">
          <Sel
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: '全部' },
              { value: 'draft', label: '待处理' },
              { value: 'confirmed', label: '已执行' },
              { value: 'cancelled', label: '已取消' }
            ]}
          />
        </F>
        <F label="处置方式">
          <Sel
            value={mode}
            onChange={setMode}
            options={[{ value: '', label: '全部' }, ...Object.entries(QC_MODE_LABEL).map(([value, label]) => ({ value, label }))]}
          />
        </F>
      </FilterBar>

      <Card pad={false}>
        <div className="px-3 pt-3">
          <SectionTitle
            title="不良品处理单"
            desc="执行是唯一产生库存后果的动作；已执行的不能取消 —— 要纠正只能再开一张反向单（与成本调整单同一哲学）"
          />
        </div>
        <Table
          loading={loading}
          data={rows}
          empty="没有不良品处理单"
          columns={[
            { key: 'doc_no', title: '处置单号', width: 160 },
            { key: 'inspection_no', title: '检验单号', width: 160, render: (r) => r.inspection_no || '-' },
            { key: 'source_label', title: '来源', width: 100, render: (r) => <span className={pill(QC_SOURCE_CLS, r.source_type)}>{r.source_label}</span> },
            { key: 'sku_name', title: '商品', width: 220, render: (r) => <span className="whitespace-nowrap">{r.sku_name || `SKU#${r.sku_id}`}</span> },
            { key: 'batch_no', title: '批次', width: 110, render: (r) => r.batch_no || '-' },
            { key: 'mode', title: '方式', width: 100, render: (r) => <span className={pill(QC_MODE_CLS, r.mode)}>{r.mode_label}</span> },
            { key: 'qty', title: '数量', align: 'right', render: (r) => fmtInt(r.qty) },
            { key: 'stock_direction', title: '库存方向', width: 110, render: (r) => dirBadge(r) },
            { key: 'out_doc_no', title: '生成单据', width: 240, render: (r) => genDocBadge(r) },
            { key: 'approved_by_name', title: '执行人', width: 110, render: (r) => <span className="whitespace-nowrap">{r.approved_by_name || '-'}</span> },
            { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(QC_STATUS_CLS, r.status)}>{HANDLE_STATUS_LABEL[r.status] || r.status}</span> },
            {
              key: '_op', title: '操作', width: 150,
              render: (r) => r.status === 'draft' ? (
                <div className="flex gap-1">
                  <button className="btn-primary btn-sm" onClick={() => confirmH(r)}>
                    <Recycle size={12} /> 执行
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => cancelH(r)}>
                    <Undo2 size={12} />
                  </button>
                </div>
              ) : null
            }
          ]}
        />
      </Card>
    </div>
  )
}
