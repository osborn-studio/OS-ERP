/**
 * ============================================================================
 * 文件标识：src/pages/inventory/Costing.tsx ｜ 存货核算与成本
 * ============================================================================
 * 【职责】存货核算与成本（页面）
 * 【入口】/inventory/costing
 * 【主要接口】/costing/overview、/costing/variances、/costing/adjustments、/costing/periods
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
 * 页面：存货核算与成本
 */

import { useMemo, useState } from 'react'
import {
  Card, SectionTitle, Status, StatCard, Tabs, Empty, Modal, Field, fmtMoney, fmtInt, fmtNum, today, toast, useFetch
} from '../../components/ui'
import { FilterBar, Sel } from '../../components/DataPage'
import { useOpts } from '../../hooks/opts'
import {
  COSTING_OVERVIEW, COSTING_VARIANCES, COSTING_ADJUSTMENTS, COSTING_ADJUSTMENT,
  COSTING_CREATE_ADJUSTMENT, COSTING_ADJUST, COSTING_CANCEL_ADJUSTMENT,
  COSTING_CLOSE_PERIOD, COSTING_PERIODS,
  ADJ_STATUS_CLS, PERIOD_CLS,
  type VarianceRow, type Adjustment
} from '../../api/costing'
import { Calculator, Lock, AlertTriangle, Search } from 'lucide-react'

/**
 * 存货核算与成本（模块 09）。
 *
 * 页面结构对应四件事：
 *   ① 「本期成本」：三层恒等式 + 残差。残差 ≠ 0 时直接红字给出数量与金额 ——
 *      这是「账对不上」的信号，其余数字再漂亮也没意义。
 *   ② 「暂估差异」：两个口径分开列。待办只列**能回写**的（adjustable），
 *      发票口径的差额单独一列展示 —— 那是应付的事，点不出调整单。
 *   ③ 「调整单」：草稿 → 确认（唯一有后果）→ 取消。已售出不追溯的部分
 *      单列出来 —— 「差异去哪了」必须能回答。
 *   ④ 「期间」：结转把本期锁死。结转后不能再补单（后端闸门），界面同步禁用。
 */
export default function Costing() {
  const [tab, setTab] = useState<'period' | 'variance' | 'adjustments' | 'periods'>('period')
  const [tick, setTick] = useState(0)
  const reload = () => setTick((t) => t + 1)
  const o = useOpts()

  const { data: ov, loading } = useFetch<any>('/costing/overview', {}, [tick])
  const layers = ov?.layers

  // ---- 暂估差异（待办：只列能回写的） ----
  const { data: varData } = useFetch<any>('/costing/variances', { only: 'adjustable', limit: 100 }, [tick])
  const variances: VarianceRow[] = varData?.list || []

  // ---- 调整单 ----
  const [adjStatus, setAdjStatus] = useState('')
  const { data: adjData } = useFetch<any>('/costing/adjustments', { status: adjStatus || undefined, page: 1, pageSize: 30 }, [tick, adjStatus])
  const adjustments: Adjustment[] = adjData?.list || []

  // ---- 期间 ----
  const { data: periodData } = useFetch<any>('/costing/periods', { limit: 24 }, [tick])
  const periods: any[] = periodData?.list || []

  // ---- 弹窗：调整单详情 ----
  const [detail, setDetail] = useState<Adjustment | null>(null)
  const [busy, setBusy] = useState(false)

  const openDetail = async (id: number) => {
    try {
      const d = await COSTING_ADJUSTMENT(id)
      setDetail(d)
    } catch (e: any) {
      toast(e.message || '打开失败', 'error')
    }
  }

  /** 从结算单开调整单（草稿），打开详情让人核对行级前后单价 */
  const createFromSettle = async (row: VarianceRow) => {
    if (!row.adjustable) {
      toast(row.blocked_reason || '该结算单的差异不能回写到批次', 'error')
      return
    }
    setBusy(true)
    try {
      const adj = await COSTING_CREATE_ADJUSTMENT({ settle_id: row.id, adjust_date: today() })
      toast(`已建调整单 ${adj.doc_no}（草稿，确认后才改成本）`)
      setDetail(adj)
      reload()
    } catch (e: any) {
      toast(e.message || '建单失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const doAdjust = async (id: number) => {
    if (!confirm('确认调整后将从结存单价/金额上回写差异并写入成本台账，已售出部分只计损益不追溯。确认？')) return
    setBusy(true)
    try {
      const out = await COSTING_ADJUST(id)
      toast(`已调整 ${out.adjusted_amount} 元${out.sold_amount ? `（另有 ${out.sold_amount} 元已售出计入损益）` : ''}`)
      await openDetail(id)
      reload()
    } catch (e: any) {
      toast(e.message || '调整失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const doCancel = async (id: number) => {
    if (!confirm('取消这张草稿？取消后可对同一结算单重新建单。')) return
    setBusy(true)
    try {
      await COSTING_CANCEL_ADJUSTMENT(id, '界面取消')
      toast('已取消')
      setDetail(null)
      reload()
    } catch (e: any) {
      toast(e.message || '取消失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const doClosePeriod = async (period: string) => {
    if (!confirm(`结转 ${period} 后该期间将被锁死，不允许再补单（重开需反结转）。确认结转？`)) return
    setBusy(true)
    try {
      const out = await COSTING_CLOSE_PERIOD({ period })
      toast(`${period} 已结转（${out.lines} 条快照${out.balanced ? '，三层闭合' : '，注意：残差未归零'}）`)
      reload()
    } catch (e: any) {
      toast(e.message || '结转失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const balanced = layers?.balanced
  const residual = layers?.residual || { qty: 0, amount: 0 }

  const tabs = [
    { key: 'period', label: '本期成本' },
    { key: 'variance', label: '暂估差异', count: variances.filter((v) => !v.fully_adjusted).length },
    { key: 'adjustments', label: '调整单', count: adjustments.length },
    { key: 'periods', label: '期间结转' }
  ]

  return (
    <div>
      <div className="mb-3">
        <h1 className="title-serif text-[19px] font-medium text-ink-900">存货核算与成本</h1>
        <p className="text-[12px] text-ink-700 mt-0.5">
          三层成本（期初 + 入 − 出 = 期末）· 暂估差异回写 · 期末结转 —— 计价方式：{ov?.cost_method === 'moving_avg' ? '移动加权平均' : ov?.cost_method}
        </p>
      </div>

      {/* 概览四卡：一眼看清本期成本状况 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="期末结存金额" value={fmtMoney(layers?.closing?.amount)} sub={`${fmtInt(layers?.closing?.qty)} 件 · 均价 ${fmtNum(layers?.closing?.unit_cost, 4)}`} />
        <StatCard label="本期入库成本" value={fmtMoney(layers?.in?.amount)} sub={`${fmtInt(layers?.in?.qty)} 件 · ${layers?.in?.line_count || 0} 行`} tone="brand" />
        <StatCard label="本期出库成本" value={fmtMoney(layers?.out?.amount)} sub={`${fmtInt(layers?.out?.qty)} 件`} tone="amber" />
        <StatCard
          label={balanced ? '三层恒等式' : '三层残差（对不上）'}
          value={balanced ? '闭合 ✓' : `${fmtNum(residual.qty)} 件 / ${fmtMoney(residual.amount)}`}
          sub={balanced ? '现存量 = 截至期末 + 期末之后流水' : '现存量 ≠ 截至期末 + 期末之后流水'}
          tone={balanced ? 'green' : 'red'}
        />
      </div>

      {/* 残差不闭合：置顶警示，比任何数字都优先 */}
      {!loading && balanced === false && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-700">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div>
            三层成本出现残差：现存量 −（截至期末 + 期末之后流水）= <b>{fmtNum(residual.qty)} 件 / {fmtMoney(residual.amount)}</b>。
            在残差归零前，期末结转出的快照不可信 —— 请先在成本自洽审计中定位断点（流水累计 vs 结存金额）。
          </div>
        </div>
      )}

      <div className="mb-3">
        <Tabs tabs={tabs} value={tab} onChange={(k) => setTab(k as any)} />
      </div>

      {/* ======================= ① 本期成本 ======================= */}
      {tab === 'period' && (
        <Card pad={false}>
          <div className="px-4 pt-4">
            <SectionTitle
              title={`${layers?.period || '—'} 三层成本`}
              desc={`${layers?.range?.start} ~ ${layers?.range?.end} · 期初来源：${layers?.opening_source || '—'}`}
              right={
                <div className="text-[12px] text-ink-700">
                  期间状态：
                  <span className={`ml-1 rounded px-1.5 py-0.5 ${PERIOD_CLS[ov?.period_status] || ''}`}>
                    {ov?.period_status === 'closed' ? '已结转' : '未结转'}
                  </span>
                </div>
              }
            />
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>层次</th>
                  <th className="text-right" style={{ width: 120 }}>数量</th>
                  <th className="text-right" style={{ width: 140 }}>金额</th>
                  <th className="text-right" style={{ width: 120 }}>加权单价</th>
                  <th>口径说明</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { name: '期初', d: layers?.opening, note: '本期开始前累计结存' },
                  { name: '本期入库', d: layers?.in, note: '采购入库 / 调拨入 / 退货入' },
                  { name: '本期出库', d: layers?.out, note: '销售出库 / 调拨出 / 采购退' },
                  { name: '本期成本调整', d: layers?.adj, note: '暂估差异回写等（只改金额不动数量）' },
                  { name: '截至期末', d: layers?.as_of_end, note: '期初 + 本期入 − 本期出 + 本期调整（结转就结这个数）' },
                  { name: '期末之后流水', d: layers?.later, note: '期间还没结转时，今天比期末多出来的那段' },
                  { name: '现存量（今天）', d: layers?.closing, note: `结存 ${fmtInt(layers?.closing_line_count)} 行` }
                ].map((row) => (
                  <tr key={row.name}>
                    <td className="font-medium">{row.name}</td>
                    <td className="text-right">{fmtInt(row.d?.qty)}</td>
                    <td className="text-right">{fmtMoney(row.d?.amount)}</td>
                    <td className="text-right text-ink-700">{fmtNum(row.d?.unit_cost, 4)}</td>
                    <td className="text-[12px] text-ink-700">{row.note}</td>
                  </tr>
                ))}
                <tr className="bg-slate-50/60">
                  <td className="font-medium">残差</td>
                  <td className={`text-right ${balanced ? '' : 'text-red-600 font-medium'}`}>{fmtNum(residual.qty)}</td>
                  <td className={`text-right ${balanced ? '' : 'text-red-600 font-medium'}`}>{fmtMoney(residual.amount)}</td>
                  <td />
                  <td className="text-[12px] text-ink-700">{balanced ? '现存量 −（截至期末 + 之后流水）= 0 ✓' : '不为 0 即账实不符，先查审计再结转'}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="border-t border-slate-100 px-4 py-3 text-[12px] text-ink-700">
            本期已确认成本调整 <b className="text-ink-900">{fmtMoney(ov?.adjusted_this_period)}</b>；
            差异中已售出未追溯（计入损益）<b className="text-ink-900">{fmtMoney(ov?.sold_not_traced)}</b>；
            成本自洽审计：{fmtInt(ov?.integrity?.checked)} 行结存，断点 {ov?.integrity?.broken_count || 0} 处。
          </div>
        </Card>
      )}

      {/* ======================= ② 暂估差异 ======================= */}
      {tab === 'variance' && (
        <Card pad={false}>
          <div className="px-4 pt-4">
            <SectionTitle
              title="暂估差异台账（可回写口径）"
              desc={`入库按暂估价入账，结算后按实价调整。待办 ${ov?.variance?.pending_settlements || 0} 张 / ${fmtMoney(ov?.variance?.pending_amount)} 元；另有发票口径差额 ${fmtMoney(ov?.variance?.invoice_gap_amount)}（尚未开票，落不到批次，不是成本待办）`}
            />
          </div>
          {variances.length === 0 ? (
            <Empty text="没有可回写的暂估差异（全部结平或尚未结算）" />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>结算单号</th>
                    <th>供应商</th>
                    <th style={{ width: 100 }}>结算日</th>
                    <th className="text-right" style={{ width: 120 }}>暂估金额</th>
                    <th className="text-right" style={{ width: 120 }}>实际成本</th>
                    <th className="text-right" style={{ width: 110 }}>可回写差异</th>
                    <th className="text-right" style={{ width: 110 }}>已回写</th>
                    <th className="text-right" style={{ width: 110 }}>草稿待确认</th>
                    <th className="text-right" style={{ width: 110 }}>待调整</th>
                    <th className="text-right" style={{ width: 110 }}>已售未追溯</th>
                    <th style={{ width: 90 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {variances.map((v) => (
                    <tr key={v.id}>
                      <td className="font-mono text-[12px]">{v.doc_no}</td>
                      <td className="text-[12px]">{v.supplier_name}</td>
                      <td>{v.settle_date}</td>
                      <td className="text-right">{fmtMoney(v.est_amount)}</td>
                      <td className="text-right">{fmtMoney(v.act_amount)}</td>
                      <td className={`text-right ${v.cost_diff > 0 ? 'text-red-600' : v.cost_diff < 0 ? 'text-emerald-700' : ''}`}>
                        {fmtMoney(v.cost_diff)}
                      </td>
                      <td className="text-right">{fmtMoney(v.adjusted_amount)}</td>
                      <td className="text-right text-amber-700">{fmtMoney(v.draft_total)}</td>
                      <td className="text-right font-medium">{fmtMoney(v.pending_amount)}</td>
                      <td className="text-right text-ink-700">{fmtMoney(v.sold_not_traced)}</td>
                      <td>
                        {v.fully_adjusted && v.draft_total === 0 ? (
                          <span className="text-[12px] text-ink-600">已结平</span>
                        ) : (
                          <button className="btn-ghost text-[12px]" disabled={busy} onClick={() => createFromSettle(v)}>
                            {v.draft_total > 0 ? '继续调整单' : '开调整单'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ======================= ③ 调整单 ======================= */}
      {tab === 'adjustments' && (
        <Card pad={false}>
          <div className="px-4 pt-4 flex items-center justify-between">
            <SectionTitle title="成本调整单" desc="草稿不改成本；确认（adjust）才回写结存单价/金额并写成本台账" />
            <div className="w-40">
              <Sel value={adjStatus} onChange={setAdjStatus} options={[
                { value: '', label: '全部状态' },
                { value: 'draft', label: '草稿' },
                { value: 'adjusted', label: '已调整' },
                { value: 'cancelled', label: '已取消' }
              ]} placeholder="全部状态" />
            </div>
          </div>
          {adjustments.length === 0 ? (
            <Empty text="暂无调整单（从暂估差异台账开单）" action={
              <button className="btn-ghost text-[12px]" onClick={() => setTab('variance')}>去差异台账</button>
            } />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>调整单号</th>
                    <th style={{ width: 150 }}>来源结算单</th>
                    <th style={{ width: 100 }}>调整日</th>
                    <th style={{ width: 70 }}>行数</th>
                    <th className="text-right" style={{ width: 110 }}>回写金额</th>
                    <th className="text-right" style={{ width: 110 }}>已售计损益</th>
                    <th style={{ width: 80 }}>状态</th>
                    <th style={{ width: 130 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.map((a) => (
                    <tr key={a.id} className="cursor-pointer" onClick={() => openDetail(a.id)}>
                      <td className="font-mono text-[12px]">{a.doc_no}</td>
                      <td className="font-mono text-[12px]">{a.settle_no}</td>
                      <td>{a.adjust_date}</td>
                      <td>{a.line_count}</td>
                      <td className="text-right">{fmtMoney(a.adjusted_amount)}</td>
                      <td className="text-right text-ink-700">{fmtMoney(a.sold_amount)}</td>
                      <td><Status value={a.status} text={a.status_label} /></td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {a.status === 'draft' && (
                          <div className="flex gap-1">
                            <button className="btn-ghost text-[12px]" disabled={busy} onClick={() => doAdjust(a.id)}>确认</button>
                            <button className="btn-ghost text-[12px] text-slate-400" disabled={busy} onClick={() => doCancel(a.id)}>取消</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ======================= ④ 期间结转 ======================= */}
      {tab === 'periods' && (
        <Card pad={false}>
          <div className="px-4 pt-4">
            <SectionTitle
              title="成本期间"
              desc={`当前期间 ${periodData?.current || '—'}。结转把期间锁死（出入库闸门拦截），重结需反结转`}
            />
          </div>
          {periods.length === 0 ? (
            <Empty text="暂无已结转期间（结转后在此显示快照）" />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 100 }}>期间</th>
                    <th style={{ width: 90 }}>状态</th>
                    <th className="text-right" style={{ width: 120 }}>期末数量</th>
                    <th className="text-right" style={{ width: 140 }}>期末金额</th>
                    <th style={{ width: 150 }}>结转人 / 时间</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => (
                    <tr key={p.period}>
                      <td className="font-medium">{p.period}</td>
                      <td><Status value={p.status} text={p.status === 'closed' ? '已结转' : '未结转'} /></td>
                      <td className="text-right">{fmtInt(p.closing_qty)}</td>
                      <td className="text-right">{fmtMoney(p.closing_amount)}</td>
                      <td className="text-[12px]">{p.closed_by_name ? `${p.closed_by_name} · ${p.closed_at?.slice(0, 16).replace('T', ' ')}` : '—'}</td>
                      <td className="text-[12px] text-ink-700">{p.remark || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="border-t border-slate-100 px-4 py-3">
            <button
              className="btn-primary text-[12px]"
              disabled={busy || ov?.period_status === 'closed' || balanced === false}
              onClick={() => doClosePeriod(periodData?.current)}
              title={balanced === false ? '残差未归零，先查审计' : ''}
            >
              <Lock size={13} className="mr-1" />结转 {periodData?.current}
            </button>
            {ov?.period_status === 'closed' && (
              <span className="ml-3 text-[12px] text-ink-700">本期已结转（反结转请联系财务在结转时勾选重结）</span>
            )}
            {balanced === false && (
              <span className="ml-3 text-[12px] text-red-600">残差未归零，禁止结转</span>
            )}
          </div>
        </Card>
      )}

      {/* 调整单详情弹窗 */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? `成本调整单 ${detail.doc_no}` : ''}
        width={960}
      >
        {detail && (
          <div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-[12px]">
              <Field label="来源结算单">{detail.settle_no}</Field>
              <Field label="调整日 / 期间">{detail.adjust_date} · {detail.period}</Field>
              <Field label="回写金额"><b className="text-red-600">{fmtMoney(detail.adjusted_amount)}</b></Field>
              <Field label="已售出计损益">{fmtMoney(detail.sold_amount)}</Field>
            </div>
            <div className="table-wrap max-h-[340px]">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>仓库 / 商品 / 批次</th>
                    <th className="text-right">入库量</th>
                    <th className="text-right">在库</th>
                    <th className="text-right">已售</th>
                    <th className="text-right">暂估价</th>
                    <th className="text-right">实价</th>
                    <th className="text-right">回写金额</th>
                    <th className="text-right">单价 前→后</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.items || []).map((it) => (
                    <tr key={it.id}>
                      <td className="text-[12px]">
                        {it.warehouse_name} · {it.sku_name}
                        {it.batch_no ? ` · ${it.batch_no}` : ''}
                      </td>
                      <td className="text-right">{fmtInt(it.qty_total)}</td>
                      <td className="text-right">{fmtInt(it.qty_on_hand)}</td>
                      <td className="text-right text-ink-700">{fmtInt(it.qty_sold)}</td>
                      <td className="text-right">{fmtNum(it.price_est, 4)}</td>
                      <td className="text-right">{fmtNum(it.price_act, 4)}</td>
                      <td className="text-right font-medium">{fmtMoney(it.adj_amount)}</td>
                      <td className="text-right text-[12px] text-ink-700">
                        {fmtNum(it.unit_before, 4)} → <b className="text-ink-900">{fmtNum(it.unit_after, 4)}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 text-[12px] text-ink-700">
              行级三数：在库 + 已售 = 入库量；回写金额 = 在库量 ×（实价 − 暂估价）。已售出部分的差异计入本期损益，不追溯历史出库成本。
            </div>
            {detail.status === 'draft' && (
              <div className="mt-4 flex gap-2 justify-end">
                <button className="btn-primary text-[12px]" disabled={busy} onClick={() => doAdjust(detail.id)}>确认调整（有后果）</button>
                <button className="btn-ghost text-[12px]" disabled={busy} onClick={() => doCancel(detail.id)}>取消草稿</button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
