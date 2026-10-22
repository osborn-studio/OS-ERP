/**
 * ============================================================================
 * 文件标识：src/pages/manufacture/MfgCenter.tsx ｜ MfgCenter（页面，未取到标题）
 * ============================================================================
 * 【职责】MfgCenter（页面，未取到标题）（页面）
 * 【入口】/manufacture
 * 【主要接口】/manufacture/overview、/master/options、/manufacture/audit、/manufacture/orders
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
 * 页面：MfgCenter（页面，未取到标题）
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Card, SectionTitle, StatCard, Table, Empty, Modal, Field, Tabs,
  fmtInt, fmtNum, fmtMoney, toast, useFetch
} from '../../components/ui'
import { FilterBar, Sel, Inp } from '../../components/DataPage'
import {
  MFG_OVERVIEW, MFG_AUDIT, MFG_BOM_EXPAND,
  MFG_BOMS, MFG_BOM, MFG_BOM_CREATE, MFG_BOM_UPDATE, MFG_BOM_AUDIT, MFG_BOM_OBSOLETE, MFG_BOM_DELETE,
  MFG_ORDERS, MFG_ORDER, MFG_ORDER_REQUIREMENT, MFG_ORDER_START, MFG_ORDER_COMPLETE_PREVIEW, MFG_ORDER_COMPLETE,
  MFG_ISSUES, MFG_ISSUE, MFG_ISSUE_CREATE, MFG_ISSUE_TRANSITION,
  MFG_REPORTS, MFG_REPORT_CREATE,
  USAGE_LABEL, USAGE_CLS, BOM_STATUS_LABEL, BOM_STATUS_CLS,
  ISSUE_STATUS_LABEL, ISSUE_STATUS_CLS, ISSUE_TYPE_LABEL, ISSUE_TYPE_CLS,
  ORDER_STATUS_LABEL, ORDER_STATUS_CLS, ISSUE_ACTIONS,
  type Bom, type BomItem, type ExpandResult, type Issue, type ProductionOrder,
  type Requirement, type WorkReport, type CompletionPreview
} from '../../api/manufacture'
import {
  RefreshCw, Plus, Send, CheckCircle2, AlertTriangle, Play, PackageCheck,
  Trash2, Layers, ClipboardList, History, Ban, AlertOctagon
} from 'lucide-react'

/**
 * 制造中心（模块 10B：BOM / 领料 / 完工入库）。
 *
 * 四个页签对应「照什么做 → 领什么料 → 料领了没 → 货入库了没」这四问。
 *
 * 界面上刻意做到的几件事（都是为了让人看得见「哪一步真的动了库存」）：
 *   · 只有两个按钮会动库存：「确认出库」与「完工入库」，两处都给了明确的后果提示；
 *     其余动作（提交 / 审批 / 登记汇报）在界面上标注「不动库存」。
 *   · 已审批的 BOM 不给「编辑」按钮 —— 不是权限不够，是口径不允许：换版要作废后新建，
 *     否则「上月按什么用量发的料」就查不出来了。
 *   · 展开结果**直接显示含损耗的用量**，并把替代料的取舍理由一起显示；
 *     只给结果不给理由，出了问题没人能复盘。
 *   · 完工入库前必须先看「试算」，试算值与实际入库值同源，避免「点完才知道多少钱」。
 */
export default function MfgCenter() {
  const [tab, setTab] = useState<'overview' | 'bom' | 'issue' | 'complete'>('overview')
  const [tick, setTick] = useState(0)
  const reload = () => setTick((t) => t + 1)
  const { data: ov } = useFetch<any>('/manufacture/overview', undefined, [tick])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionTitle
          title="制造中心"
          desc="一个母件一个用途只有一版 BOM，只有已审批且在生效期内的能用来展开 · 展开用量已含损耗 · 替代料的选择给出理由 · 只有「确认出库」与「完工入库」两个动作会动库存"
        />
        <button className="btn-ghost" onClick={reload}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      <Tabs
        tabs={[
          { key: 'overview', label: '总览' },
          { key: 'bom', label: 'BOM 与展开', count: ov?.bom?.total },
          { key: 'issue', label: '生产领料', count: ov?.issues?.total },
          { key: 'complete', label: '完工入库', count: ov?.pending_stock_in }
        ]}
        value={tab}
        onChange={(k) => setTab(k as any)}
      />

      {tab === 'overview' && <OverviewTab tick={tick} ov={ov} />}
      {tab === 'bom' && <BomTab tick={tick} reload={reload} />}
      {tab === 'issue' && <IssueTab tick={tick} reload={reload} />}
      {tab === 'complete' && <CompleteTab tick={tick} reload={reload} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[12px] text-slate-500 whitespace-nowrap">{label}</span>
      {children}
    </div>
  )
}
const pill = (map: Record<string, string>, v?: string | null) =>
  `inline-block px-2 py-[1px] rounded border text-[12px] whitespace-nowrap ${map[v || ''] || 'text-slate-600 bg-slate-50 border-slate-200'}`
const YesNo = ({ v }: { v: any }) => (Number(v) ? <span className="text-emerald-600">是</span> : <span className="text-slate-400">否</span>)

/** 用一次请求拿仓库与 SKU 下拉（与全站一致，避免各页各写一份） */
function useOptions() {
  const { data } = useFetch<any>('/master/options')
  return {
    warehouses: (data?.warehouses || []) as { value: number; label: string; code: string; type: string }[],
    skus: (data?.skus || []) as { value: number; label: string; sku_code: string; name: string; unit?: string }[]
  }
}

const errText = (e: any) => e?.detail?.code ? `${e.message}（${e.detail.code}）` : e?.message || '操作失败'

// ---------------------------------------------------------------------------
// ① 总览：先把「哪一步断了」摆出来
// ---------------------------------------------------------------------------

function OverviewTab({ tick, ov }: { tick: number; ov: any }) {
  const { data: audit } = useFetch<any>('/manufacture/audit', undefined, [tick])

  // 审计代码 → 人话。写在这里而不是后端，是因为同一句人话要出现在总览与弹窗两处。
  const AUDIT_LABEL: Record<string, string> = {
    issue_no_cost: '领料已出库但金额为 0（库存成本没回写）',
    issue_without_txn: '领料单写着「已出库」，库存流水里查不到 —— 料账上出了、库里没出',
    issue_qty_mismatch: '领料单行合计与表头数量不一致',
    report_without_stock_in: '完工汇报标记了已入库，但找不到入库流水',
    order_completed_mismatch: '订单完工数与已入库汇报的良品数不一致（两个口径必须同源）',
    order_material_mismatch: '订单材料成本与汇报归集不一致（可能还没完工入库）',
    // ⑦ 的判据已从「只看限额领料单是否超领」扩到「**累计**领用超出 BOM 需求、且超出部分没有补料单解释」
    // （覆盖限额/按 BOM/补料全部类型；只有限额单在建单与出库时是硬拦，其余靠这项审计告警兜）——
    // 标签必须跟着判据一起放宽，否则会让人以为这项只查限额单。
    over_issue: '累计领用超出 BOM 需求（且没有补料单解释）'
  }
  const issues: { code: string; level: string; ref: string; message: string }[] = audit?.issues || []
  const errs = issues.filter((x) => x.level === 'error')
  const warns = issues.filter((x) => x.level === 'warn')
  const bom = ov?.bom || {}

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="在制订单" value={fmtInt(ov?.orders?.wip || 0)} tone={ov?.orders?.wip ? 'warn' : 'good'} sub={`在制数量 ${fmtInt(ov?.orders?.wip_qty || 0)}`} />
        <StatCard label="已出库领料额" value={fmtMoney(ov?.issues?.issued_amount || 0)} sub={`已出库 ${fmtInt(ov?.issues?.issued || 0)} / 共 ${fmtInt(ov?.issues?.total || 0)} 张`} />
        <StatCard label="累计良品" value={fmtInt(ov?.reports?.good_qty || 0)} sub={`不良率 ${fmtNum(ov?.reports?.defect_rate || 0, 2)}%（按良品+不良）`} />
        <StatCard
          label="待完工入库"
          value={fmtInt(ov?.pending_stock_in || 0)}
          tone={ov?.pending_stock_in ? 'warn' : 'good'}
          sub="已登记汇报但还没入库的批次数"
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="BOM 总数" value={fmtInt(bom.total || 0)} sub={`自制 ${bom.by_usage?.self_made || 0} · 委外 ${bom.by_usage?.outsourced || 0} · 组合装 ${bom.by_usage?.combo || 0}`} />
        <StatCard label="已审批 BOM" value={fmtInt(bom.by_status?.approved || 0)} tone="good" sub={`草稿 ${bom.by_status?.draft || 0} · 作废 ${bom.by_status?.obsolete || 0}`} />
        <StatCard label="替代组" value={fmtInt(bom.substitute_groups || 0)} sub="有替代料的组件组数" />
        <StatCard
          label="能生产但没 BOM"
          value={fmtInt(bom.producible_without_bom || 0)}
          tone={bom.producible_without_bom ? 'bad' : 'good'}
          sub="有生产订单、却找不到已审批 BOM 的成品"
        />
      </div>

      <Card>
        <SectionTitle
          title="自洽审计"
          desc="这几类问题都不会报错：单据说「出了库」，库存流水里却没有；订单说「完工 10 件」，汇报只有 9 件。只有专职检查才抓得到"
          right={
            <span className="text-[12px] text-slate-500">
              {audit ? `${audit.checked_at} 检查 · 错误 ${audit.error_count} / 警告 ${audit.warn_count}` : '—'}
            </span>
          }
        />
        {!audit ? (
          <Empty text="加载中…" />
        ) : issues.length === 0 ? (
          <div className="flex items-center gap-2 text-[13px] text-emerald-600 py-3">
            <CheckCircle2 size={16} /> 七项不变量全部通过（出库有流水、头行结平、完工数与汇报同源、料工费能对上）
          </div>
        ) : (
          <div className="space-y-3">
            {errs.length > 0 && (
              <div>
                <div className="text-[12px] text-red-600 mb-1.5 flex items-center gap-1">
                  <AlertOctagon size={13} /> 错误（{errs.length}）—— 账已经错了，必须处理
                </div>
                {errs.map((x, i) => (
                  <div key={i} className="text-[13px] text-slate-700 py-1 border-b border-slate-100 last:border-0">
                    <span className="text-slate-400 mr-2">{x.ref}</span>
                    {AUDIT_LABEL[x.code] || x.message}
                  </div>
                ))}
              </div>
            )}
            {warns.length > 0 && (
              <div>
                <div className="text-[12px] text-amber-600 mb-1.5 flex items-center gap-1">
                  <AlertTriangle size={13} /> 警告（{warns.length}）—— 需要人看一眼
                </div>
                {warns.map((x, i) => (
                  <div key={i} className="text-[13px] text-slate-700 py-1 border-b border-slate-100 last:border-0">
                    <span className="text-slate-400 mr-2">{x.ref}</span>
                    {AUDIT_LABEL[x.code] || x.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle title="这个模块的六条硬口径" desc="改任何一条都要前后端同步 —— 否则界面显示的与实际算的会是两回事" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-[13px] text-slate-700">
          {[
            ['一个母件一个用途只有一版 BOM', '换版 = 作废旧版 + 新建新版，已审批的不能原地改'],
            ['只有已审批 + 生效期内的能展开', '草稿用量是还没审的数，拿它发料等于按草稿生产'],
            ['展开用量已含损耗', '单件用量 × (1 + 损耗率) × 生产数量 ÷ 基准批量'],
            ['替代料要给理由', '主料不够时改选谁、为什么，展开结果里直接写明'],
            ['限额领料不得超 BOM 需求', '确需多领请改「补料」并填原因，审计会盯超领'],
            ['料工费按订单数量分摊', '单位材料 = 已出库领料总额 ÷ 订单数量；已售出部分不追溯']
          ].map(([t, d]) => (
            <div key={t} className="py-1 border-b border-slate-100 last:border-0">
              <span className="text-slate-800">{t}</span>
              <span className="text-slate-500"> —— {d}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ② BOM 与展开
// ---------------------------------------------------------------------------

type EditRow = { sku_id: number | ''; qty: string; loss_rate: string; substitute_group: string; priority: string; remark: string }
const emptyRow = (): EditRow => ({ sku_id: '', qty: '', loss_rate: '0', substitute_group: '', priority: '0', remark: '' })

function BomTab({ tick, reload }: { tick: number; reload: () => void }) {
  const [filters, setFilters] = useState({ status: '', usage: '', keyword: '' })
  const [page, setPage] = useState(1)
  const { data, loading, reload: reloadList } = useFetch<any>(
    '/manufacture/boms',
    { ...filters, page, pageSize: 20 },
    [tick, page]
  )
  const list: Bom[] = data?.list || []

  const [edit, setEdit] = useState<{ open: boolean; bom: Bom | null }>({ open: false, bom: null })
  const [expand, setExpand] = useState<Bom | null>(null)
  const [detail, setDetail] = useState<Bom | null>(null)

  const after = () => { reloadList(); reload() }

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          title="BOM 清单"
          desc="一个母件 + 一个用途只有一版。已审批的不能改、不能删 —— 只能作废后新建（历史领料要能对得上当时那一版）"
          right={
            <div className="flex gap-2">
              <button className="btn-ghost btn-sm" onClick={() => setEdit({ open: true, bom: null })}>
                <Plus size={14} /> 新建 BOM
              </button>
            </div>
          }
        />
        <FilterBar onReset={() => setFilters({ status: '', usage: '', keyword: '' })}>
          <F label="状态">
            <Sel value={filters.status} onChange={(v) => { setPage(1); setFilters({ ...filters, status: v }) }}
              placeholder="全部" options={Object.entries(BOM_STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
          </F>
          <F label="用途">
            <Sel value={filters.usage} onChange={(v) => { setPage(1); setFilters({ ...filters, usage: v }) }}
              placeholder="全部" options={Object.entries(USAGE_LABEL).map(([value, label]) => ({ value, label }))} />
          </F>
          <F label="关键字">
            <Inp value={filters.keyword} placeholder="BOM 号 / 母件编码 / 名称"
              onChange={(v) => { setPage(1); setFilters({ ...filters, keyword: v }) }} />
          </F>
        </FilterBar>

        <Table
          data={list}
          loading={loading}
          empty="没有 BOM。先在「商品档案」里确认成品与原料，再回来建 BOM"
          columns={[
            { key: 'code', title: 'BOM 号', width: 160, render: (r) => <span className="font-mono text-[12px]">{r.code}</span> },
            { key: 'product', title: '母件', render: (r) => (
              <div>
                <div className="text-slate-800">{r.product_sku_name}</div>
                <div className="text-[11px] text-slate-400 font-mono">{r.product_sku_code} · {r.version}</div>
              </div>
            ) },
            { key: 'usage', title: '用途', width: 90, render: (r) => <span className={pill(USAGE_CLS, r.usage)}>{USAGE_LABEL[r.usage] || r.usage}</span> },
            { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(BOM_STATUS_CLS, r.status)}>{BOM_STATUS_LABEL[r.status] || r.status}</span> },
            { key: 'base_qty', title: '基准批量', align: 'right', width: 90, render: (r) => fmtNum(r.base_qty, 4) },
            { key: 'item_count', title: '组件', align: 'right', width: 60, render: (r) => fmtInt(r.item_count) },
            { key: 'effective_from', title: '生效期', width: 180, render: (r) => (
              <span className="text-[12px] text-slate-500">{r.effective_from || '—'} ~ {r.effective_to || '长期'}</span>
            ) },
            { key: 'audited', title: '审批', width: 150, render: (r) => (
              r.audited_at
                ? <span className="text-[12px] text-slate-500">{r.audited_by_name || '—'}<br />{String(r.audited_at).slice(0, 16)}</span>
                : <span className="text-slate-300">—</span>
            ) },
            { key: 'act', title: '操作', width: 250, render: (r) => (
              <div className="flex gap-1.5 flex-wrap" onClick={(e) => e.stopPropagation()}>
                <button className="btn-ghost btn-sm" onClick={async () => setDetail(await MFG_BOM(r.id))}>详情</button>
                {r.status === 'approved' && (
                  <button className="btn-ghost btn-sm" onClick={() => setExpand(r)}>
                    <Layers size={13} /> 展开试算
                  </button>
                )}
                {r.status === 'draft' && (
                  <>
                    <button className="btn-ghost btn-sm" onClick={() => setEdit({ open: true, bom: r })}>编辑</button>
                    <button className="btn-primary btn-sm" onClick={() => doAudit(r, after)}>
                      <CheckCircle2 size={13} /> 审批
                    </button>
                    <button className="btn-ghost btn-sm text-red-600" onClick={() => doDelete(r, after)}>
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
                {r.status === 'approved' && (
                  <button className="btn-ghost btn-sm text-amber-600" onClick={() => doObsolete(r, after)}>作废</button>
                )}
              </div>
            ) }
          ]}
        />
        {data && data.total > 20 && (
          <div className="flex items-center justify-between px-1 pt-3 text-[13px] text-slate-500">
            <span>共 {fmtInt(data.total)} 条 · 第 {page}/{Math.ceil(data.total / 20)} 页</span>
            <div className="flex gap-1.5">
              <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
              <button className="btn-ghost btn-sm" disabled={page >= Math.ceil(data.total / 20)} onClick={() => setPage(page + 1)}>下一页</button>
            </div>
          </div>
        )}
      </Card>

      {edit.open && (
        <BomEditModal
          bom={edit.bom}
          onClose={() => setEdit({ open: false, bom: null })}
          onSaved={() => { setEdit({ open: false, bom: null }); after() }}
        />
      )}
      {expand && <ExpandModal bom={expand} onClose={() => setExpand(null)} />}
      {detail && <BomDetailModal bom={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

async function doAudit(r: Bom, after: () => void) {
  try {
    await MFG_BOM_AUDIT(r.id)
    toast(`BOM ${r.code} 已审批，现在可以用来展开需求`)
    after()
  } catch (e: any) { toast(errText(e), 'error') }
}
async function doObsolete(r: Bom, after: () => void) {
  if (!confirm(`作废 BOM ${r.code}？\n\n作废后不再用于展开。已发生的领料单据仍指向这一版，历史查得到。`)) return
  try {
    await MFG_BOM_OBSOLETE(r.id, '界面作废')
    toast(`BOM ${r.code} 已作废`)
    after()
  } catch (e: any) { toast(errText(e), 'error') }
}
async function doDelete(r: Bom, after: () => void) {
  if (!confirm(`删除草稿 BOM ${r.code}？只有草稿能删。`)) return
  try {
    await MFG_BOM_DELETE(r.id)
    toast('草稿已删除')
    after()
  } catch (e: any) { toast(errText(e), 'error') }
}

function BomEditModal({ bom, onClose, onSaved }: { bom: Bom | null; onClose: () => void; onSaved: () => void }) {
  const { skus } = useOptions()
  const [form, setForm] = useState<any>({
    product_sku_id: bom?.product_sku_id || '',
    usage: bom?.usage || 'self_made',
    version: bom?.version || 'V1.0',
    base_qty: String(bom?.base_qty ?? 1),
    effective_from: bom?.effective_from || '',
    effective_to: bom?.effective_to || '',
    remark: bom?.remark || ''
  })
  const [rows, setRows] = useState<EditRow[]>(() =>
    bom?.items?.length
      ? bom.items.map((i) => ({
          sku_id: i.sku_id,
          qty: String(i.qty),
          loss_rate: String(i.loss_rate ?? 0),
          substitute_group: i.substitute_group || '',
          priority: String(i.priority ?? 0),
          remark: i.remark || ''
        }))
      : [emptyRow()]
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!bom) return
    MFG_BOM(bom.id).then((full) => {
      if (full.items?.length) {
        setRows(full.items.map((i) => ({
          sku_id: i.sku_id,
          qty: String(i.qty),
          loss_rate: String(i.loss_rate ?? 0),
          substitute_group: i.substitute_group || '',
          priority: String(i.priority ?? 0),
          remark: i.remark || ''
        })))
      }
    }).catch(() => {})
  }, [bom?.id])

  const setRow = (i: number, patch: Partial<EditRow>) =>
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)))

  const submit = async () => {
    if (!form.product_sku_id) return toast('请选择母件（要生产的成品）', 'error')
    const items: BomItem[] = []
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i]
      if (!r.sku_id) continue
      items.push({
        sku_id: Number(r.sku_id),
        qty: Number(r.qty),
        loss_rate: Number(r.loss_rate || 0),
        substitute_group: r.substitute_group || null,
        priority: Number(r.priority || 0),
        remark: r.remark || null
      })
    }
    if (!items.length) return toast('至少要有一行组件', 'error')
    setBusy(true)
    try {
      const body: any = {
        product_sku_id: Number(form.product_sku_id),
        usage: form.usage,
        version: form.version,
        base_qty: Number(form.base_qty || 1),
        effective_from: form.effective_from || null,
        effective_to: form.effective_to || null,
        remark: form.remark || null,
        items
      }
      if (bom) await MFG_BOM_UPDATE(bom.id, body)
      else await MFG_BOM_CREATE(body)
      toast(bom ? 'BOM 已更新（仍是草稿，需审批后才能用于展开）' : 'BOM 已建立（草稿）。审批后才会被需求展开采纳')
      onSaved()
    } catch (e: any) { toast(errText(e), 'error') } finally { setBusy(false) }
  }

  return (
    <Modal
      open
      width={1080}
      title={bom ? `编辑 BOM ${bom.code}（${bom.status_label || ''}）` : '新建 BOM'}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? '保存中…' : '保存为草稿'}</button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <Field label="母件（要生产/组装出来的）" required>
          <Sel value={form.product_sku_id} disabled={!!bom}
            onChange={(v) => setForm({ ...form, product_sku_id: v })}
            placeholder="请选择" options={skus.map((s) => ({ value: s.value, label: s.label }))} />
        </Field>
        <Field label="用途" hint="一个母件 + 一个用途只能有一版" required>
          <Sel value={form.usage} disabled={!!bom} onChange={(v) => setForm({ ...form, usage: v })}
            options={Object.entries(USAGE_LABEL).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="版本号" hint="换版请作废旧版再新建，不要原地改">
          <Inp value={form.version} onChange={(v) => setForm({ ...form, version: v })} />
        </Field>
        <Field label="基准批量" hint="下面填的是「批量 N 件需要多少」；生产数量会按比例换算">
          <Inp type="number" value={form.base_qty} onChange={(v) => setForm({ ...form, base_qty: v })} />
        </Field>
        <Field label="生效起">
          <Inp type="date" value={form.effective_from} onChange={(v) => setForm({ ...form, effective_from: v })} />
        </Field>
        <Field label="生效止" hint="留空表示长期有效">
          <Inp type="date" value={form.effective_to} onChange={(v) => setForm({ ...form, effective_to: v })} />
        </Field>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[13px] font-medium text-slate-700">组件行</div>
          <button className="btn-ghost btn-sm" onClick={() => setRows([...rows, emptyRow()])}>
            <Plus size={13} /> 加一行
          </button>
        </div>
        <div className="text-[12px] text-slate-500 mb-2">
          损耗率按**小数**填：损耗 5% 填 0.05（填 5 会被拦下）。同一「替代组」内的多行互为替代，
          优先级 0 为最高；不填替代组的行各自独立领料。
        </div>
        <Table
          data={rows}
          rowKey={(_, i) => i}
          columns={[
            { key: 'sku', title: '组件 SKU', render: (r, i) => (
              <Sel value={r.sku_id} onChange={(v) => setRow(i, { sku_id: v === '' ? '' : Number(v) })}
                placeholder="请选择" options={skus.map((s) => ({ value: s.value, label: s.label }))} />
            ) },
            { key: 'qty', title: '用量', width: 110, render: (r, i) => (
              <Inp type="number" value={r.qty} onChange={(v) => setRow(i, { qty: v })} />
            ) },
            { key: 'loss', title: '损耗率', width: 110, render: (r, i) => (
              <Inp type="number" value={r.loss_rate} onChange={(v) => setRow(i, { loss_rate: v })} />
            ) },
            { key: 'group', title: '替代组', width: 130, render: (r, i) => (
              <Inp value={r.substitute_group} placeholder="可空" onChange={(v) => setRow(i, { substitute_group: v })} />
            ) },
            { key: 'prio', title: '优先级', width: 90, render: (r, i) => (
              <Inp type="number" value={r.priority} onChange={(v) => setRow(i, { priority: v })} />
            ) },
            { key: 'remark', title: '备注', width: 160, render: (r, i) => (
              <Inp value={r.remark} onChange={(v) => setRow(i, { remark: v })} />
            ) },
            { key: 'x', title: '', width: 44, render: (_, i) => (
              <button className="btn-ghost btn-sm text-red-600" onClick={() => setRows(rows.filter((_, k) => k !== i))}>
                <Trash2 size={13} />
              </button>
            ) }
          ]}
        />
      </div>

      <Field label="备注" span={3}>
        <Inp value={form.remark} onChange={(v) => setForm({ ...form, remark: v })} />
      </Field>
    </Modal>
  )
}

function BomDetailModal({ bom, onClose }: { bom: Bom; onClose: () => void }) {
  const items = bom.items || []
  const groups = useMemo(() => {
    const m = new Map<string, typeof items>()
    for (const it of items) {
      const key = it.substitute_group || `#${it.line_no}`
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(it)
    }
    return [...m.entries()]
  }, [items])

  return (
    <Modal
      open
      width={980}
      title={`BOM ${bom.code} · ${bom.product_sku_name || ''}`}
      onClose={onClose}
      footer={<button className="btn-ghost" onClick={onClose}>关闭</button>}
    >
      <div className="grid grid-cols-4 gap-x-6 gap-y-2 text-[13px] mb-4">
        {[
          ['母件', `${bom.product_sku_name || ''}（${bom.product_sku_code || ''}）`],
          ['用途 / 版本', `${USAGE_LABEL[bom.usage] || bom.usage} · ${bom.version}`],
          ['状态', BOM_STATUS_LABEL[bom.status] || bom.status],
          ['基准批量', fmtNum(bom.base_qty, 4)],
          ['生效期', `${bom.effective_from || '—'} ~ ${bom.effective_to || '长期'}`],
          ['审批人', bom.audited_by_name || '—'],
          ['审批时间', bom.audited_at ? String(bom.audited_at).slice(0, 16) : '—'],
          ['组件行数', fmtInt(items.length)]
        ].map(([k, v]) => (
          <div key={k}>
            <div className="text-[11px] text-slate-400">{k}</div>
            <div className="text-slate-700">{v}</div>
          </div>
        ))}
      </div>

      <div className="text-[13px] text-slate-700 mb-2">
        组件按替代组归并（{groups.filter(([, g]) => g.length > 1).length} 个替代组 +{' '}
        {groups.filter(([, g]) => g.length === 1).length} 个独立行）
      </div>
      <Table
        data={items}
        columns={[
          { key: 'line_no', title: '行号', width: 56, align: 'right' },
          { key: 'sku', title: '组件', render: (r) => (
            <div>
              <div className="text-slate-800">{r.sku_name}</div>
              <div className="text-[11px] text-slate-400 font-mono">{r.sku_code} · {r.spec || '—'}</div>
            </div>
          ) },
          { key: 'qty', title: '用量', width: 90, align: 'right', render: (r) => fmtNum(r.qty, 4) },
          { key: 'unit', title: '单位', width: 60, render: (r) => r.unit || '—' },
          { key: 'loss_rate', title: '损耗率', width: 90, align: 'right', render: (r) => `${fmtNum((r.loss_rate || 0) * 100, 2)}%` },
          { key: 'substitute_group', title: '替代组', width: 100, render: (r) => r.substitute_group || <span className="text-slate-300">独立</span> },
          { key: 'priority', title: '优先级', width: 70, align: 'right', render: (r) => (r.substitute_group ? fmtInt(r.priority) : '—') },
          { key: 'remark', title: '备注', render: (r) => r.remark || '—' }
        ]}
      />
      {bom.audit_remark && <div className="text-[12px] text-slate-500 mt-3">审批备注：{bom.audit_remark}</div>}
    </Modal>
  )
}

function ExpandModal({ bom, onClose }: { bom: Bom; onClose: () => void }) {
  const { warehouses } = useOptions()
  const [qty, setQty] = useState('100')
  const [wh, setWh] = useState<string>('')
  const [allowSub, setAllowSub] = useState(true)
  const [res, setRes] = useState<ExpandResult | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (!(Number(qty) > 0)) return toast('生产数量必须大于 0', 'error')
    setBusy(true)
    try {
      setRes(await MFG_BOM_EXPAND(bom.id, { qty: Number(qty), warehouse_id: wh === '' ? null : Number(wh), allow_substitute: allowSub }))
    } catch (e: any) { toast(errText(e), 'error') } finally { setBusy(false) }
  }
  useEffect(() => { run() }, []) // 打开即按默认值试算一次

  const lines = res?.lines || []
  const shortLines = lines.filter((l) => (l.shortage || 0) > 0)

  return (
    <Modal
      open
      width={1080}
      title={`展开试算 · ${bom.code}（${bom.product_sku_name || ''}）`}
      onClose={onClose}
      footer={<button className="btn-ghost" onClick={onClose}>关闭</button>}
    >
      <div className="text-[12px] text-slate-500 mb-3">
        试算**不改任何数据**。下面显示的是**已含损耗**的用量：
        单件用量 × (1 + 损耗率) × 生产数量 ÷ 基准批量（本版基准批量 {fmtNum(bom.base_qty, 4)}）。
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <F label="生产数量"><Inp type="number" value={qty} w={120} onChange={setQty} /></F>
        <F label="生产仓">
          <Sel value={wh} onChange={setWh} placeholder="不指定（只看优先级）" options={warehouses.map((w) => ({ value: w.value, label: w.label }))} />
        </F>
        <label className="flex items-center gap-1.5 text-[12px] text-slate-600">
          <input type="checkbox" checked={allowSub} onChange={(e) => setAllowSub(e.target.checked)} />
          启用替代料（关掉则永远取主料）
        </label>
        <button className="btn-primary btn-sm" disabled={busy} onClick={run}>
          <Layers size={13} /> {busy ? '试算中…' : '重新试算'}
        </button>
      </div>

      {!res ? (
        <Empty text="填好数量后点「重新试算」" />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 mb-3">
            <StatCard label="展开行数" value={fmtInt(res.summary.line_count)} sub={`替代组 ${res.summary.group_count} 个`} />
            <StatCard label="替代发生" value={fmtInt(res.summary.substituted)} tone={res.summary.substituted ? 'warn' : 'default'} sub="没选主料、改用了替代料的组数" />
            <StatCard label="物料短缺" value={fmtInt(res.summary.shortage_count)} tone={res.summary.shortage_count ? 'bad' : 'good'} sub="按当前仓可用量算不够的行数" />
            <StatCard label="生产数量" value={fmtInt(res.qty)} sub={`基准批量 ${fmtNum(res.bom.base_qty, 4)}`} />
          </div>

          <Table
            data={lines}
            columns={[
              { key: 'line_no', title: '行号', width: 56, align: 'right' },
              { key: 'sku', title: '物料', render: (r) => (
                <div>
                  <div className="text-slate-800">
                    {r.sku_name}
                    {r.is_substitute && <span className="ml-1.5 text-[11px] text-orange-600">替代（原第 {r.substitute_for} 行）</span>}
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono">{r.sku_code}</div>
                </div>
              ) },
              { key: 'qty', title: '应领（含损耗）', width: 130, align: 'right', render: (r) => (
                <span className="text-slate-800">{fmtNum(r.qty, 4)} <span className="text-slate-400">{r.unit || ''}</span></span>
              ) },
              { key: 'base', title: '单件用量+损耗', width: 130, align: 'right', render: (r) => (
                <span className="text-[12px] text-slate-500">{fmtNum(r.base_qty, 4)} + {(r.loss_rate * 100).toFixed(1)}%</span>
              ) },
              { key: 'available', title: '可用量', width: 100, align: 'right', render: (r) => (
                r.available == null ? <span className="text-slate-300">未指定仓</span> : fmtNum(r.available, 2)
              ) },
              { key: 'shortage', title: '缺口', width: 90, align: 'right', render: (r) => (
                (r.shortage || 0) > 0 ? <span className="text-red-600">{fmtNum(r.shortage, 2)}</span> : <span className="text-emerald-600">够</span>
              ) },
              { key: 'group', title: '替代组', width: 100, render: (r) => r.substitute_group || <span className="text-slate-300">独立</span> }
            ]}
          />

          {(res.groups || []).length > 0 && (
            <div className="mt-4">
              <div className="text-[13px] font-medium text-slate-700 mb-2">替代料的取舍理由</div>
              {(res.groups || []).map((g, i) => (
                <div key={i} className="border border-slate-200 rounded p-2.5 mb-2 text-[13px]">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="px-2 py-[1px] rounded border border-slate-200 bg-slate-50 text-[12px]">替代组 {g.group}</span>
                    <span className="text-slate-700">选中第 {g.chosen_line_no} 行（SKU#{g.chosen_sku_id}），需 {fmtNum(g.required_qty, 4)}</span>
                    <span className={g.reason.includes('不足') ? 'text-orange-600 text-[12px]' : 'text-emerald-600 text-[12px]'}>{g.reason}</span>
                  </div>
                  <table className="tbl">
                    <thead>
                      <tr><th>行号</th><th>候选物料</th><th className="text-right">优先级</th><th className="text-right">需求</th><th className="text-right">可用</th><th>够不够</th></tr>
                    </thead>
                    <tbody>
                      {g.candidates.map((c) => (
                        <tr key={c.line_no} className={c.line_no === g.chosen_line_no ? 'bg-emerald-50/50' : ''}>
                          <td>{c.line_no}</td>
                          <td>{c.sku_name} <span className="text-[11px] text-slate-400 font-mono">{c.sku_code}</span></td>
                          <td className="text-right">{fmtInt(c.priority)}</td>
                          <td className="text-right tabular-nums">{fmtNum(c.need_qty, 4)}</td>
                          <td className="text-right tabular-nums">{c.available == null ? '—' : fmtNum(c.available, 2)}</td>
                          <td>{c.enough == null ? '—' : <YesNo v={c.enough} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

          {shortLines.length > 0 && (
            <div className="mt-3 text-[12px] text-red-600 flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-[2px]" />
              <span>
                有 {shortLines.length} 行按当前仓的可用量不够。试算不会拦你，但真去领料时会在出库那一步被库存卡住
                —— 先补货或改仓库，别等到点了「确认出库」才发现。
              </span>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// ③ 生产领料
// ---------------------------------------------------------------------------

function IssueTab({ tick, reload }: { tick: number; reload: () => void }) {
  const [filters, setFilters] = useState({ status: '', issue_type: '', keyword: '' })
  const [page, setPage] = useState(1)
  const { data, loading, reload: reloadList } = useFetch<any>(
    '/manufacture/issues',
    { ...filters, page, pageSize: 20 },
    [tick, page]
  )
  const list: Issue[] = data?.list || []
  const [createOpen, setCreateOpen] = useState(false)
  const [detail, setDetail] = useState<Issue | null>(null)

  const after = () => { reloadList(); reload() }

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          title="领料单（MR）"
          desc="草稿 → 提交 → 审批 → 出库。**只有「确认出库」会扣库存**并回写出库成本；其余动作都只是走流程"
          right={
            <button className="btn-ghost btn-sm" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> 新建领料单
            </button>
          }
        />
        <FilterBar onReset={() => setFilters({ status: '', issue_type: '', keyword: '' })}>
          <F label="状态">
            <Sel value={filters.status} onChange={(v) => { setPage(1); setFilters({ ...filters, status: v }) }}
              placeholder="全部" options={Object.entries(ISSUE_STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
          </F>
          <F label="类型">
            <Sel value={filters.issue_type} onChange={(v) => { setPage(1); setFilters({ ...filters, issue_type: v }) }}
              placeholder="全部" options={Object.entries(ISSUE_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
          </F>
          <F label="关键字">
            <Inp value={filters.keyword} placeholder="领料单号 / 生产订单号"
              onChange={(v) => { setPage(1); setFilters({ ...filters, keyword: v }) }} />
          </F>
        </FilterBar>

        <Table
          data={list}
          loading={loading}
          empty="还没有领料单。先在生产订单上开工，再回来按 BOM 领料"
          onRowClick={async (r) => setDetail(await MFG_ISSUE(r.id))}
          columns={[
            { key: 'doc_no', title: '领料单号', width: 160, render: (r) => <span className="font-mono text-[12px]">{r.doc_no}</span> },
            { key: 'order_no', title: '生产订单', width: 160, render: (r) => <span className="font-mono text-[12px] text-slate-500">{r.order_no}</span> },
            { key: 'issue_date', title: '领料日期', width: 110 },
            { key: 'issue_type', title: '类型', width: 110, render: (r) => <span className={pill(ISSUE_TYPE_CLS, r.issue_type)}>{ISSUE_TYPE_LABEL[r.issue_type] || r.issue_type}</span> },
            { key: 'warehouse_name', title: '仓库', width: 130, render: (r) => r.warehouse_name || '—' },
            { key: 'total_qty', title: '数量', width: 100, align: 'right', render: (r) => fmtNum(r.total_qty, 4) },
            { key: 'total_amount', title: '出库金额', width: 110, align: 'right', render: (r) => (
              Number(r.total_amount) > 0 ? fmtMoney(r.total_amount) : <span className="text-slate-300">未出库</span>
            ) },
            { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(ISSUE_STATUS_CLS, r.status)}>{ISSUE_STATUS_LABEL[r.status] || r.status}</span> },
            { key: 'act', title: '操作', width: 220, render: (r) => (
              <div className="flex gap-1.5 flex-wrap" onClick={(e) => e.stopPropagation()}>
                <button className="btn-ghost btn-sm" onClick={async () => setDetail(await MFG_ISSUE(r.id))}>详情</button>
                {(ISSUE_ACTIONS[r.status] || []).map((a) => (
                  <button
                    key={a.action}
                    className={a.danger ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}
                    title={a.hint}
                    onClick={async () => {
                      if (a.danger && !confirm(`确认出库 ${r.doc_no}？\n\n这会按批次实际扣减库存并回写出库成本，单据随即变为终态，不能再取消。`)) return
                      try {
                        const out = await MFG_ISSUE_TRANSITION(r.id, a.action)
                        toast(a.action === 'issue' ? `已出库，出库金额 ${fmtMoney(out.total_amount)}` : `已${a.label}`)
                        after()
                      } catch (e: any) { toast(errText(e), 'error') }
                    }}
                  >
                    {a.danger && <PackageCheck size={13} />} {a.label}
                  </button>
                ))}
              </div>
            ) }
          ]}
        />
        {data && data.total > 20 && (
          <div className="flex items-center justify-between px-1 pt-3 text-[13px] text-slate-500">
            <span>共 {fmtInt(data.total)} 条 · 第 {page}/{Math.ceil(data.total / 20)} 页</span>
            <div className="flex gap-1.5">
              <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
              <button className="btn-ghost btn-sm" disabled={page >= Math.ceil(data.total / 20)} onClick={() => setPage(page + 1)}>下一页</button>
            </div>
          </div>
        )}
      </Card>

      {createOpen && <IssueCreateModal onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); after() }} />}
      {detail && <IssueDetailModal issue={detail} onClose={() => setDetail(null)} onChanged={async () => { setDetail(await MFG_ISSUE(detail.id)); after() }} />}
    </div>
  )
}

type DraftLine = { sku_id: number; sku_name?: string | null; sku_code?: string | null; unit?: string | null; qty: string; batch_no: string; pending: number; required: number }

function IssueCreateModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { warehouses, skus } = useOptions()
  const { data: ordersData } = useFetch<any>('/manufacture/orders', { status: 'in_progress', pageSize: 200 })
  const orders: ProductionOrder[] = ordersData?.list || []

  const [orderId, setOrderId] = useState<string>('')
  const [wh, setWh] = useState<string>('')
  const [issueType, setIssueType] = useState('by_bom')
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10))
  const [remark, setRemark] = useState('')
  const [req, setReq] = useState<Requirement | null>(null)
  const [lines, setLines] = useState<DraftLine[]>([])
  const [busy, setBusy] = useState(false)

  const order = orders.find((o) => o.id === Number(orderId))

  const loadReq = async (id: number, warehouseId?: string | number) => {
    try {
      const r = await MFG_ORDER_REQUIREMENT(id, warehouseId === '' || warehouseId == null ? undefined : { warehouse_id: Number(warehouseId) })
      setReq(r)
      if (issueType === 'by_bom') {
        setLines(
          (r.lines || []).map((l) => ({
            sku_id: l.sku_id,
            sku_name: l.sku_name,
            sku_code: l.sku_code,
            unit: l.unit,
            qty: String(l.pending_qty),
            batch_no: '',
            pending: l.pending_qty,
            required: l.qty
          }))
        )
      }
    } catch (e: any) { toast(errText(e), 'error') }
  }

  useEffect(() => {
    if (!orderId) { setReq(null); setLines([]); return }
    if (!wh && order?.warehouse_id) setWh(String(order.warehouse_id))
    loadReq(Number(orderId), wh || order?.warehouse_id || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  const submit = async () => {
    if (!orderId) return toast('请先选生产订单', 'error')
    const items = lines
      .filter((l) => Number(l.qty) > 0)
      .map((l) => ({ sku_id: l.sku_id, qty: Number(l.qty), batch_no: l.batch_no || null }))
    if (issueType !== 'by_bom' && !items.length) return toast('请至少填写一行领料数量', 'error')
    if (issueType === 'supplement' && !remark.trim()) return toast('补料必须填写原因（审计会盯超领）', 'error')
    setBusy(true)
    try {
      const out = await MFG_ISSUE_CREATE({
        order_id: Number(orderId),
        warehouse_id: wh === '' ? null : Number(wh),
        issue_date: issueDate,
        issue_type: issueType,
        items: issueType === 'by_bom' ? null : items,
        remark: remark || null
      })
      toast(`领料单 ${out.doc_no} 已建立（草稿）。提交并审批后才能出库`)
      onSaved()
    } catch (e: any) { toast(errText(e), 'error') } finally { setBusy(false) }
  }

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)))

  return (
    <Modal
      open
      width={1000}
      title="新建领料单"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? '建立中…' : '建立（草稿）'}</button>
        </>
      }
    >
      <div className="grid grid-cols-4 gap-3">
        <Field label="生产订单" required hint="只有「生产中」的订单能领料">
          <Sel value={orderId} onChange={(v) => setOrderId(v)}
            placeholder="请选择" options={orders.map((o) => ({ value: o.id, label: `${o.doc_no} · ${o.sku_name || ''} × ${o.qty}` }))} />
        </Field>
        <Field label="领料仓库">
          <Sel value={wh} onChange={(v) => { setWh(v); if (orderId) loadReq(Number(orderId), v) }}
            placeholder="默认（订单仓库）" options={warehouses.map((w) => ({ value: w.value, label: w.label }))} />
        </Field>
        <Field label="领料日期">
          <Inp type="date" value={issueDate} onChange={setIssueDate} />
        </Field>
        <Field label="领料类型" hint="限额领料不得超 BOM 需求；确需多领请改「补料」">
          <Sel value={issueType} onChange={(v) => {
            setIssueType(v)
            if (orderId && v === 'by_bom') loadReq(Number(orderId), wh)
            if (v !== 'by_bom' && req) {
              setLines((req.lines || []).map((l) => ({
                sku_id: l.sku_id, sku_name: l.sku_name, sku_code: l.sku_code, unit: l.unit,
                qty: '', batch_no: '', pending: l.pending_qty, required: l.qty
              })))
            }
          }}
            options={Object.entries(ISSUE_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
        </Field>
      </div>

      {orderId && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[13px] font-medium text-slate-700">
              待领物料
              {req?.bom && <span className="text-[12px] text-slate-500 ml-2">照 BOM {req.bom.code}（{req.bom.version}）展开</span>}
            </div>
            {issueType !== 'by_bom' && (
              <button className="btn-ghost btn-sm" onClick={() => setLines([...lines, { sku_id: 0, qty: '', batch_no: '', pending: 0, required: 0 }])}>
                <Plus size={13} /> 加一行
              </button>
            )}
          </div>

          {req?.message && <div className="text-[12px] text-amber-600 mb-2">{req.message}</div>}

          {req?.bom == null ? (
            <Empty text="该成品没有已审批的自制 BOM，无法自动装填 —— 请改为手工指定领料行，或先去建 BOM" />
          ) : lines.length === 0 ? (
            <Empty text="待领清单为空：本次订单的料已经领满了。如需追加请改用「补料」并填写原因" />
          ) : (
            <Table
              data={lines}
              rowKey={(_, i) => i}
              columns={[
                { key: 'sku', title: '物料', render: (r, i) => (
                  issueType === 'by_bom'
                    ? <div><div className="text-slate-800">{r.sku_name}</div><div className="text-[11px] text-slate-400 font-mono">{r.sku_code}</div></div>
                    : <Sel value={r.sku_id} w={280} placeholder="请选择物料" onChange={(v) => {
                        const s = skus.find((x) => x.value === Number(v))
                        setLine(i, {
                          sku_id: Number(v),
                          sku_name: s?.label || '',
                          sku_code: s?.sku_code || '',
                          unit: s?.unit || ''
                        })
                      }} options={skus.map((s) => ({ value: s.value, label: s.label }))} />
                ) },
                { key: 'required', title: 'BOM 需求', width: 110, align: 'right', render: (r) => (r.required ? fmtNum(r.required, 4) : '—') },
                { key: 'pending', title: '待领', width: 100, align: 'right', render: (r) => (r.required ? <span className="text-sky-700">{fmtNum(r.pending, 4)}</span> : '—') },
                { key: 'qty', title: '本次领用', width: 130, render: (r, i) => (
                  issueType === 'by_bom'
                    ? <span className="tabular-nums text-slate-800">{fmtNum(r.qty, 4)} {r.unit || ''}</span>
                    : <Inp type="number" value={r.qty} onChange={(v) => setLine(i, { qty: v })} />
                ) },
                { key: 'batch', title: '指定批次', width: 150, render: (r, i) => (
                  <Inp value={r.batch_no} placeholder="留空按先进先出" onChange={(v) => setLine(i, { batch_no: v })} />
                ) }
              ]}
            />
          )}

          <div className="text-[12px] text-slate-500 mt-2">
            批次留空的，出库时按库存引擎的拣选规则自动取批（并回写实际批次号）—— 也就是说，
            **你在这里不填批次也能出库**，出库后再回来看行上的批次号就是实际扣的那一批。
          </div>
        </div>
      )}

      <Field label={issueType === 'supplement' ? '补料原因（必填）' : '备注'} span={3}>
        <Inp value={remark} onChange={setRemark} placeholder={issueType === 'supplement' ? '例如：试产损耗超出 BOM 标准损耗' : '可空'} />
      </Field>
    </Modal>
  )
}

function IssueDetailModal({ issue, onClose, onChanged }: { issue: Issue; onClose: () => void; onChanged: () => void }) {
  const items = issue.items || []
  const lineSum = items.reduce((n, x) => n + Number(x.qty || 0), 0)
  const amountSum = items.reduce((n, x) => n + Number(x.amount || 0), 0)
  const actions = ISSUE_ACTIONS[issue.status] || []

  return (
    <Modal
      open
      width={1000}
      title={`领料单 ${issue.doc_no}（${issue.status_label || issue.status}）`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>关闭</button>
          {actions.map((a) => (
            <button
              key={a.action}
              className={a.danger ? 'btn-primary' : 'btn-ghost'}
              onClick={async () => {
                if (a.danger && !confirm(`确认出库 ${issue.doc_no}？\n\n这会按批次实际扣减库存并回写出库成本，单据随即变为终态。`)) return
                try {
                  const out = await MFG_ISSUE_TRANSITION(issue.id, a.action)
                  toast(a.action === 'issue' ? `已出库，出库金额 ${fmtMoney(out.total_amount)}` : `已${a.label}`)
                  onChanged()
                } catch (e: any) { toast(errText(e), 'error') }
              }}
            >
              {a.label}
            </button>
          ))}
        </>
      }
    >
      <div className="grid grid-cols-4 gap-x-6 gap-y-2 text-[13px] mb-4">
        {[
          ['生产订单', issue.order_no || '—'],
          ['领料日期', issue.issue_date || '—'],
          ['类型', ISSUE_TYPE_LABEL[issue.issue_type] || issue.issue_type],
          ['仓库', issue.warehouse_name || '—'],
          ['表头数量', fmtNum(issue.total_qty, 4)],
          ['行合计', fmtNum(lineSum, 4)],
          ['出库金额', Number(issue.total_amount) > 0 ? fmtMoney(issue.total_amount) : '未出库'],
          ['行金额合计', amountSum > 0 ? fmtMoney(amountSum) : '—'],
          ['出库人', issue.issued_by_name || '—'],
          ['出库时间', issue.issued_at ? String(issue.issued_at).slice(0, 19) : '—'],
          ['行数', fmtInt(items.length)],
          ['备注', issue.remark || '—']
        ].map(([k, v]) => (
          <div key={k}>
            <div className="text-[11px] text-slate-400">{k}</div>
            <div className="text-slate-700">{v}</div>
          </div>
        ))}
      </div>

      {Number(issue.total_amount) > 0 && Math.abs(Number(issue.total_amount) - amountSum) > 0.01 && (
        <div className="mb-3 text-[12px] text-red-600 flex items-center gap-1.5">
          <AlertTriangle size={14} /> 表头金额与行金额合计不一致（{fmtMoney(issue.total_amount)} vs {fmtMoney(amountSum)}）—— 这属于账实不符，请联系管理员
        </div>
      )}

      <Table
        data={items}
        columns={[
          { key: 'line_no', title: '行号', width: 56, align: 'right' },
          { key: 'sku', title: '物料', render: (r) => (
            <div>
              <div className="text-slate-800">{r.sku_name}</div>
              <div className="text-[11px] text-slate-400 font-mono">{r.sku_code} · {r.spec || '—'}</div>
            </div>
          ) },
          { key: 'batch_no', title: '批次', width: 130, render: (r) => (
            r.batch_no ? <span className="font-mono text-[12px] text-slate-600">{r.batch_no}</span> : <span className="text-slate-300">未指定</span>
          ) },
          { key: 'qty', title: '数量', width: 100, align: 'right', render: (r) => `${fmtNum(r.qty, 4)} ${r.unit || ''}` },
          { key: 'unit_cost', title: '出库单价', width: 100, align: 'right', render: (r) => (r.unit_cost == null ? <span className="text-slate-300">未出库</span> : fmtNum(r.unit_cost, 4)) },
          { key: 'amount', title: '金额', width: 110, align: 'right', render: (r) => (r.amount == null ? <span className="text-slate-300">—</span> : fmtMoney(r.amount)) }
        ]}
      />

      {(issue.events || []).length > 0 && (
        <div className="mt-4">
          <div className="text-[13px] font-medium text-slate-700 mb-1.5 flex items-center gap-1"><History size={14} /> 流转留痕</div>
          <Table
            data={issue.events || []}
            columns={[
              { key: 'created_at', title: '时间', width: 170, render: (r) => String(r.created_at || '').slice(0, 19) },
              { key: 'action', title: '动作', width: 100 },
              { key: 'from_state', title: '从', width: 100, render: (r) => r.from_state || '—' },
              { key: 'to_state', title: '到', width: 100, render: (r) => r.to_state || '—' },
              { key: 'actor_name', title: '操作人', render: (r) => r.actor_name || '—' }
            ]}
          />
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// ④ 完工入库
// ---------------------------------------------------------------------------

function CompleteTab({ tick, reload }: { tick: number; reload: () => void }) {
  const [status, setStatus] = useState('in_progress')
  const { data, loading, reload: reloadList } = useFetch<any>(
    '/manufacture/orders',
    { status, pageSize: 50 },
    [tick]
  )
  const orders: ProductionOrder[] = data?.list || []
  const [sel, setSel] = useState<ProductionOrder | null>(null)
  const after = () => { reloadList(); reload() }

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle
          title="生产订单执行"
          desc="开工 → 领料 → 登记完工汇报 → 完工入库。**只有「完工入库」会给库存做加法**；登记汇报本身不进库存、也不推进订单状态"
        />
        <FilterBar onReset={() => setStatus('in_progress')}>
          <F label="订单状态">
            <Sel value={status} onChange={setStatus}
              placeholder="全部" options={Object.entries(ORDER_STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
          </F>
        </FilterBar>

        <Table
          data={orders}
          loading={loading}
          empty="没有符合条件的生产订单"
          onRowClick={async (r) => setSel(await MFG_ORDER(r.id))}
          columns={[
            { key: 'doc_no', title: '生产订单', width: 160, render: (r) => <span className="font-mono text-[12px]">{r.doc_no}</span> },
            { key: 'sku', title: '成品', render: (r) => (
              <div>
                <div className="text-slate-800">{r.sku_name}</div>
                <div className="text-[11px] text-slate-400 font-mono">{r.sku_code} · {r.spec || '—'}</div>
              </div>
            ) },
            { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(ORDER_STATUS_CLS, r.status)}>{ORDER_STATUS_LABEL[r.status] || r.status}</span> },
            { key: 'qty', title: '计划 / 完工', width: 120, align: 'right', render: (r) => (
              <span className="tabular-nums">{fmtNum(r.qty, 0)} / <span className="text-emerald-600">{fmtNum(r.completed_qty, 0)}</span></span>
            ) },
            { key: 'issued_amount', title: '已领料额', width: 110, align: 'right', render: (r) => (Number(r.issued_amount) > 0 ? fmtMoney(r.issued_amount) : <span className="text-slate-300">—</span>) },
            { key: 'reported', title: '汇报良品/不良', width: 130, align: 'right', render: (r) => (
              `${fmtNum(r.reported_good_qty || 0, 0)} / ${Number(r.reported_defect_qty || 0) > 0 ? '' : ''}${fmtNum(r.reported_defect_qty || 0, 0)}`
            ) },
            { key: 'conversion', title: '转换成本', width: 110, align: 'right', render: (r) => (Number(r.conversion_cost) > 0 ? fmtMoney(r.conversion_cost) : <span className="text-slate-300">—</span>) },
            { key: 'act', title: '操作', width: 200, render: (r) => (
              <div className="flex gap-1.5 flex-wrap" onClick={(e) => e.stopPropagation()}>
                <button className="btn-ghost btn-sm" onClick={async () => setSel(await MFG_ORDER(r.id))}>明细</button>
                {(r.status === 'approved' || r.status === 'submitted') && (
                  <button className="btn-ghost btn-sm" onClick={async () => {
                    try {
                      await MFG_ORDER_START(r.id)
                      toast(`${r.doc_no} 已开工，现在可以领料与报完工`)
                      after()
                    } catch (e: any) { toast(errText(e), 'error') }
                  }}>
                    <Play size={13} /> 开工
                  </button>
                )}
              </div>
            ) }
          ]}
        />
      </Card>

      {sel && <OrderDrawer order={sel} onClose={() => setSel(null)} onChanged={async () => { setSel(await MFG_ORDER(sel.id)); after() }} />}
    </div>
  )
}

function OrderDrawer({ order, onClose, onChanged }: { order: ProductionOrder; onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<'req' | 'issues' | 'reports'>('req')
  const { data: req } = useFetch<Requirement>(`/manufacture/orders/${order.id}/requirement`, { include_issued: 1 }, [order.id, order.reported_good_qty])
  const [preview, setPreview] = useState<CompletionPreview | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)

  const pendingReports = (order.reports || []).filter((r) => !Number(r.stock_done))

  const openPreview = async () => {
    try {
      const p = await MFG_ORDER_COMPLETE_PREVIEW(order.id)
      setPreview(p)
      setPreviewOpen(true)
    } catch (e: any) { toast(errText(e), 'error') }
  }

  return (
    <>
      <Modal
        open
        width={1100}
        title={`生产订单 ${order.doc_no} · ${order.sku_name || ''}（${order.status_label || order.status}）`}
        onClose={onClose}
        footer={
          <>
            <button className="btn-ghost" onClick={onClose}>关闭</button>
            {order.status === 'in_progress' && (
              <>
                <button className="btn-ghost" onClick={() => setReportOpen(true)}>
                  <ClipboardList size={13} /> 登记完工汇报
                </button>
                <button className="btn-primary" onClick={openPreview} disabled={pendingReports.length === 0}
                  title={pendingReports.length === 0 ? '没有待入库的汇报，先去登记汇报' : '先看试算，确认金额再入库'}>
                  <PackageCheck size={13} /> 完工入库（{pendingReports.length} 批发货）
                </button>
              </>
            )}
          </>
        }
      >
        <div className="grid grid-cols-5 gap-x-5 gap-y-2 text-[13px] mb-4">
          {[
            ['计划数量', fmtNum(order.qty, 0)],
            ['已完工', fmtNum(order.completed_qty, 0)],
            ['在制剩余', fmtNum(order.in_progress_qty, 0)],
            ['生产仓', order.warehouse_name || '—'],
            ['BOM', order.bom ? `${order.bom.code}（${order.bom.version}）` : '未维护'],
            ['已领料额', Number(order.progress?.issued_amount) > 0 ? fmtMoney(order.progress?.issued_amount) : '—'],
            ['材料成本', Number(order.material_cost) > 0 ? fmtMoney(order.material_cost) : '—'],
            ['转换成本', Number(order.progress?.conversion_cost) > 0 ? fmtMoney(order.progress?.conversion_cost) : '—'],
            ['总成本', Number(order.total_cost) > 0 ? fmtMoney(order.total_cost) : '—'],
            ['单位成本', Number(order.unit_cost) > 0 ? fmtNum(order.unit_cost, 4) : '—']
          ].map(([k, v]) => (
            <div key={k}>
              <div className="text-[11px] text-slate-400">{k}</div>
              <div className="text-slate-700">{v}</div>
            </div>
          ))}
        </div>

        <Tabs
          tabs={[
            { key: 'req', label: '物料需求', count: req?.summary?.pending_count },
            { key: 'issues', label: '领料单', count: (order.issues || []).length },
            { key: 'reports', label: '完工汇报', count: (order.reports || []).length }
          ]}
          value={tab}
          onChange={(k) => setTab(k as any)}
        />

        {tab === 'req' && (
          !req ? <Empty text="加载中…" />
          : !req.bom ? <Empty text={req.message || '该成品没有已审批的 BOM，无法自动展开需求'} />
          : (
            <>
              <div className="flex gap-3 mb-2 text-[12px] text-slate-500">
                <span>BOM 需求合计 <b className="text-slate-700">{fmtNum(req.summary.required_qty, 4)}</b></span>
                <span>已出库累计 <b className="text-slate-700">{fmtNum(req.summary.issued_qty, 4)}</b></span>
                <span>待领行数 <b className="text-sky-700">{fmtNum(req.summary.pending_count, 0)}</b></span>
                {req.summary.shortage_count > 0 && <span className="text-red-600">库存不足行 {req.summary.shortage_count}</span>}
              </div>
              <Table
                data={req.lines || []}
                columns={[
                  { key: 'line_no', title: '行号', width: 56, align: 'right' },
                  { key: 'sku', title: '物料', render: (r) => (
                    <div>
                      <div className="text-slate-800">
                        {r.sku_name}
                        {r.is_substitute && <span className="ml-1.5 text-[11px] text-orange-600">替代</span>}
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono">{r.sku_code}</div>
                    </div>
                  ) },
                  { key: 'qty', title: 'BOM 需求', width: 110, align: 'right', render: (r) => fmtNum(r.qty, 4) },
                  { key: 'issued_qty', title: '已领', width: 100, align: 'right', render: (r) => fmtNum(r.issued_qty, 4) },
                  { key: 'pending_qty', title: '待领', width: 100, align: 'right', render: (r) => (
                    r.is_done ? <span className="text-emerald-600">已领满</span> : <span className="text-sky-700">{fmtNum(r.pending_qty, 4)}</span>
                  ) },
                  { key: 'available', title: '可用量', width: 100, align: 'right', render: (r) => (r.available == null ? '—' : fmtNum(r.available, 2)) },
                  { key: 'shortage', title: '缺口', width: 90, align: 'right', render: (r) => (
                    (r.shortage || 0) > 0 ? <span className="text-red-600">{fmtNum(r.shortage, 2)}</span> : <span className="text-slate-300">—</span>
                  ) }
                ]}
              />
            </>
          )
        )}

        {tab === 'issues' && (
          (order.issues || []).length === 0 ? <Empty text="还没有领料单" /> : (
            <Table
              data={order.issues || []}
              columns={[
                { key: 'doc_no', title: '单号', width: 160, render: (r) => <span className="font-mono text-[12px]">{r.doc_no}</span> },
                { key: 'issue_date', title: '日期', width: 110 },
                { key: 'issue_type', title: '类型', width: 110, render: (r) => <span className={pill(ISSUE_TYPE_CLS, r.issue_type)}>{ISSUE_TYPE_LABEL[r.issue_type] || r.issue_type}</span> },
                { key: 'total_qty', title: '数量', width: 100, align: 'right', render: (r) => fmtNum(r.total_qty, 4) },
                { key: 'total_amount', title: '金额', width: 110, align: 'right', render: (r) => (Number(r.total_amount) > 0 ? fmtMoney(r.total_amount) : '—') },
                { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(ISSUE_STATUS_CLS, r.status)}>{ISSUE_STATUS_LABEL[r.status] || r.status}</span> }
              ]}
            />
          )
        )}

        {tab === 'reports' && (
          (order.reports || []).length === 0 ? <Empty text="还没有完工汇报。完工汇报不推进订单状态，只是「这批货做出来多少」的记录" /> : (
            <Table
              data={order.reports || []}
              columns={[
                { key: 'doc_no', title: '汇报单号', width: 150, render: (r) => <span className="font-mono text-[12px]">{r.doc_no}</span> },
                { key: 'report_date', title: '日期', width: 110 },
                { key: 'process_name', title: '工序', width: 120, render: (r) => r.process_name || '—' },
                { key: 'good_qty', title: '良品', width: 80, align: 'right', render: (r) => <span className="text-emerald-600">{fmtNum(r.good_qty, 0)}</span> },
                { key: 'defect_qty', title: '不良', width: 80, align: 'right', render: (r) => (Number(r.defect_qty) > 0 ? <span className="text-red-600">{fmtNum(r.defect_qty, 0)}</span> : '0') },
                { key: 'work_hours', title: '工时', width: 80, align: 'right', render: (r) => fmtNum(r.work_hours, 2) },
                { key: 'labor_cost', title: '人工', width: 100, align: 'right', render: (r) => fmtMoney(r.labor_cost || 0) },
                { key: 'overhead_cost', title: '制费', width: 100, align: 'right', render: (r) => fmtMoney(r.overhead_cost || 0) },
                { key: 'stock_done', title: '是否入库', width: 110, render: (r) => (
                  Number(r.stock_done)
                    ? <span className="text-emerald-600 text-[12px]">已入库 {r.stock_doc_no || ''}</span>
                    : <span className="text-amber-600 text-[12px]">待入库</span>
                ) }
              ]}
            />
          )
        )}
      </Modal>

      {reportOpen && <WorkReportModal order={order} onClose={() => setReportOpen(false)} onSaved={() => { setReportOpen(false); onChanged() }} />}
      {previewOpen && preview && (
        <CompleteModal
          order={order}
          preview={preview}
          onClose={() => setPreviewOpen(false)}
          onDone={() => { setPreviewOpen(false); onChanged() }}
        />
      )}
    </>
  )
}

function WorkReportModal({ order, onClose, onSaved }: { order: ProductionOrder; onClose: () => void; onSaved: () => void }) {
  const remain = Math.max(0, Number(order.qty) - Number(order.completed_qty))
  const [form, setForm] = useState({
    report_date: new Date().toISOString().slice(0, 10),
    process_name: '',
    good_qty: String(remain),
    defect_qty: '0',
    work_hours: '0',
    labor_rate: '0',
    overhead_cost: '0',
    remark: ''
  })
  const [busy, setBusy] = useState(false)
  const good = Number(form.good_qty || 0)
  const defect = Number(form.defect_qty || 0)
  const labor = Number(form.work_hours || 0) * Number(form.labor_rate || 0)

  const submit = async () => {
    if (!(good > 0) && !(defect > 0)) return toast('良品与不良不能同时为 0', 'error')
    setBusy(true)
    try {
      await MFG_REPORT_CREATE({
        order_id: order.id,
        report_date: form.report_date,
        process_name: form.process_name || null,
        good_qty: good,
        defect_qty: defect,
        work_hours: Number(form.work_hours || 0),
        labor_rate: Number(form.labor_rate || 0),
        overhead_cost: Number(form.overhead_cost || 0),
        remark: form.remark || null
      })
      toast('完工汇报已登记。它不推进订单状态，也不会入库 —— 入库请点「完工入库」')
      onSaved()
    } catch (e: any) { toast(errText(e), 'error') } finally { setBusy(false) }
  }

  return (
    <Modal
      open
      width={860}
      title={`登记完工汇报 · ${order.doc_no}（还可完工 ${fmtNum(remain, 0)} 件）`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? '登记中…' : '登记汇报'}</button>
        </>
      }
    >
      <div className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">
        按第三轮口径 G4「生产不报工」：本动作**不进审批、不推进订单状态、不入库存**。
        它只记录「这一次做出来多少良品、多少不良、花了多少工时」，作为之后**完工入库**的依据。
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="汇报日期" required><Inp type="date" value={form.report_date} onChange={(v) => setForm({ ...form, report_date: v })} /></Field>
        <Field label="工序" hint="可空"><Inp value={form.process_name} onChange={(v) => setForm({ ...form, process_name: v })} /></Field>
        <Field label="良品数量" required hint={`不得超过订单数量（剩余可完工 ${fmtNum(remain, 0)}）`}>
          <Inp type="number" value={form.good_qty} onChange={(v) => setForm({ ...form, good_qty: v })} />
        </Field>
        <Field label="不良数量"><Inp type="number" value={form.defect_qty} onChange={(v) => setForm({ ...form, defect_qty: v })} /></Field>
        <Field label="工时"><Inp type="number" value={form.work_hours} onChange={(v) => setForm({ ...form, work_hours: v })} /></Field>
        <Field label="工时费率" hint="人工成本 = 工时 × 费率"><Inp type="number" value={form.labor_rate} onChange={(v) => setForm({ ...form, labor_rate: v })} /></Field>
        <Field label="制造费用"><Inp type="number" value={form.overhead_cost} onChange={(v) => setForm({ ...form, overhead_cost: v })} /></Field>
        <Field label="本次转换成本" span={2} hint="人工 + 制造费用，入库时计入产成品成本">
          <div className="text-[15px] text-slate-800 tabular-nums py-1.5">{fmtMoney(labor + Number(form.overhead_cost || 0))}</div>
        </Field>
      </div>
      <Field label="备注" span={3}><Inp value={form.remark} onChange={(v) => setForm({ ...form, remark: v })} /></Field>
    </Modal>
  )
}

function CompleteModal({ order, preview, onClose, onDone }: { order: ProductionOrder; preview: CompletionPreview; onClose: () => void; onDone: () => void }) {
  const [batchNo, setBatchNo] = useState('')
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (!confirm(`确认完工入库 ${preview.good_qty} 件？\n\n这会真的往仓库里加货、生成批次并计入产成品成本（${fmtMoney(preview.total_cost)}）。`)) return
    setBusy(true)
    try {
      const out = await MFG_ORDER_COMPLETE(order.id, { batch_no: batchNo || null, remark: remark || null })
      toast(`完工入库成功：${out.stock_in_qty} 件，批次 ${out.batch_no || '—'}，成本 ${fmtMoney(out.material_cost + out.conversion_cost)}`)
      onDone()
    } catch (e: any) { toast(errText(e), 'error') } finally { setBusy(false) }
  }

  const Row = ({ k, v, hint, strong }: { k: string; v: string; hint?: string; strong?: boolean }) => (
    <div className="py-1.5 border-b border-slate-100 last:border-0 flex items-baseline justify-between">
      <span className="text-[13px] text-slate-600">
        {k}
        {hint && <span className="text-[11px] text-slate-400 ml-1.5">{hint}</span>}
      </span>
      <span className={`tabular-nums ${strong ? 'text-[15px] font-medium text-slate-900' : 'text-[13px] text-slate-800'}`}>{v}</span>
    </div>
  )

  return (
    <Modal
      open
      width={820}
      title={`完工入库试算 · ${order.doc_no}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={run}>
            <PackageCheck size={14} /> {busy ? '入库中…' : `确认入库 ${preview.good_qty} 件`}
          </button>
        </>
      }
    >
      <div className="text-[12px] text-slate-500 mb-3">
        试算值与**实际入库值同源**：下面这些数字就是入库后会写进库存流水、汇报与订单上的数字。
        材料成本按订单数量分摊（已售出部分不追溯）。
      </div>

      <div className="grid grid-cols-2 gap-x-8">
        <div>
          <div className="text-[12px] text-slate-400 mb-1">来料</div>
          <Row k="已出库领料总额" v={fmtMoney(preview.issued_amount)} hint="两张领料单合计" />
          <Row k="订单数量" v={fmtNum(preview.order_qty, 0)} />
          <Row k="单位材料" v={fmtNum(preview.unit_material, 4)} hint="领料总额 ÷ 订单数量" />
          <Row k="本次良品" v={fmtNum(preview.good_qty, 0)} />
          <Row k="本次不良" v={fmtNum(preview.defect_qty, 0)} />
          <Row k="待入库汇报" v={`${preview.pending_report_count} 张`} />
        </div>
        <div>
          <div className="text-[12px] text-slate-400 mb-1">成本归集</div>
          <Row k="材料成本" v={fmtMoney(preview.material_cost)} hint="单位材料 × 良品数" />
          <Row k="转换成本" v={fmtMoney(preview.conversion_cost)} hint="人工 + 制费" />
          <Row k="入库总成本" v={fmtMoney(preview.total_cost)} strong />
          <Row k="入库单位成本" v={fmtNum(preview.unit_cost, 4)} strong />
          <Row k="本次后订单" v={preview.will_complete_order ? '全部完工 → 订单转「已完工」' : '仍为「生产中」'} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4">
        <Field label="批次号" hint="留空由系统生成；填了就按你填的记">
          <Inp value={batchNo} onChange={setBatchNo} placeholder="可空" />
        </Field>
        <Field label="备注"><Inp value={remark} onChange={setRemark} placeholder="可空" /></Field>
      </div>

      <div className="mt-3 text-[12px] text-slate-500 flex items-start gap-1.5">
        <Ban size={14} className="mt-[2px] text-slate-400" />
        <span>入库生成的是<b>待检</b>批次：质检（模块 13）通过后这批货才算可用。这是刻意的 —— 刚做出来的货不该直接就能发出去。</span>
      </div>
    </Modal>
  )
}
