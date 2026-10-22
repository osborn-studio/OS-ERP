/**
 * ============================================================================
 * 文件标识：src/pages/finance/Reports.tsx ｜ Reports（页面，未取到标题）
 * ============================================================================
 * 【职责】Reports（页面，未取到标题）（页面）
 * 【入口】/finance/reports
 * 【主要接口】/reports/meta、/reports/audit、/reports/cashflow-items、/reports/subject-balances、/reports/periods、/reports/periods/audit/check
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
 * 页面：Reports（页面，未取到标题）
 */

import { Fragment, useEffect, useState } from 'react'
import api from '../../api/client'
import { RefreshCw, Lock, Unlock, ShieldCheck, AlertTriangle, FileSpreadsheet, ArrowRightLeft, Download, History } from 'lucide-react'

/**
 * 财务报表（批次 L · 模块 28）：资产负债表 / 利润表 / 现金流量表 / 科目余额表 / 经营分析
 *
 * 这一页与「财务中心（凭证 / 试算平衡）」的分工：
 *   财务中心回答 **"账记对了吗"**（凭证平不平、总账平不平）；
 *   本页回答 **"账读出来是什么"**（有多少家底、赚了多少、钱怎么来的）。
 *
 * 页面上刻意保留三样"不好看但必要"的东西：
 *   ① **报表自证**结果直接摆在顶部 —— 三条恒等式（资产=负债+权益；净利润=损益类发生额；
 *      现金流净增加额=现金科目变动）不通过时**显示红条**，而不是把差额悄悄摊进某一行。
 *      这三条不平只可能是**配置错**（口径漏了科目 / 期初不平），正是我们想让它立刻现形的地方。
 *   ② **兜底行照常显示**（"未分类科目（兜底）"）。它恒为 0 是正常的；一旦有金额，
 *      说明有科目没被任何具体行认领，而这一行就是那个证据。
 *   ③ **现金流量表的填列构成**（现金流量表下方）：多少条是**标记填列**（人给的答案）、
 *      多少条是**分析倒推**（按对手科目推出来的）。多线交叉的复合凭证只能按净额归类 ——
 *      说清楚有多少张、有多少条是推的，比假装归得很细诚实。
 */

const fmt = (n: any) => '¥' + Number(n || 0).toFixed(2)
const fmt2 = (n: any) => (n === null || n === undefined || n === '' ? '—' : Number(n || 0).toFixed(2))

type Tab = 'reports' | 'balances' | 'periods' | 'opening' | 'annual' | 'operating'

const REPORT_TABS: [string, string][] = [
  ['bs', '资产负债表'],
  ['pl', '利润表'],
  ['cf', '现金流量表']
]

export default function Reports() {
  const [tab, setTab] = useState<Tab>('reports')
  const [meta, setMeta] = useState<any>({})
  const [period, setPeriod] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    api.get('/reports/meta')
      .then((r: any) => {
        const d = r.data || r
        setMeta(d)
        // 默认落在**最近一个有已过账凭证的期间**：空期间的三张报表全 0，
        // 看上去像"功能没做"，而它其实是"这个月确实没有发生额"。
        const first = (d.periods || []).find((p: any) => p.posted_count > 0) || (d.periods || [])[0]
        if (first) setPeriod(first.period)
      })
      .catch((e: any) => setErr(e.message))
  }, [])

  const TABS: [Tab, string][] = [
    ['reports', '三大报表'],
    ['balances', '科目余额表'],
    ['periods', '期间与关账'],
    ['annual', '年度与分配'],
    ['opening', '期初余额'],
    ['operating', '经营分析']
  ]

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <FileSpreadsheet size={15} className="text-brand-700" />
        <div className="text-[15px] font-medium title-serif">财务报表</div>
        <div className="text-[11px] text-slate-400">三张主表 · 科目余额 · 期间关账 · 年度分配 · 期初余额 · 经营分析</div>
        <span className="flex-1" />
        <span className="text-[11px] text-slate-500">期间</span>
        <select className="border border-ink-300 rounded px-2 py-1 text-[12px]" value={period} onChange={(e) => setPeriod(e.target.value)}>
          <option value="">（未选择）</option>
          {(meta.periods || []).map((p: any) => (
            <option key={p.period} value={p.period}>
              {p.period} · {p.posted_count} 张已过账{p.status === 'closed' ? ' · 已关账' : ''}
            </option>
          ))}
        </select>
      </div>
      {err && <div className="text-[12px] text-red-500 mb-2">{err}</div>}
      <div className="flex gap-1.5 mb-3 flex-wrap">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-1.5 rounded border text-[12px] ${tab === k ? 'bg-brand-700 text-white border-brand-700' : 'border-ink-300 text-slate-600 bg-white'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'reports' && <MainReports period={period} meta={meta} onErr={setErr} />}
      {tab === 'balances' && <Balances period={period} onErr={setErr} />}
      {tab === 'periods' && <Periods meta={meta} reloadMeta={() => api.get('/reports/meta').then((r: any) => setMeta(r.data || r))} onErr={setErr} />}
      {tab === 'annual' && <Annual onErr={setErr} />}
      {tab === 'opening' && <Opening period={period} onErr={setErr} />}
      {tab === 'operating' && <Operating period={period} onErr={setErr} />}
    </div>
  )
}

// ===========================================================================
// 一、三大报表（含自证条）
// ===========================================================================

function MainReports({ period, meta, onErr }: any) {
  const [code, setCode] = useState('bs')
  const [mode, setMode] = useState('') // '' = 不比较；previous = 环比；yoy = 同比；custom = 自定义基期
  const [basePeriod, setBasePeriod] = useState('') // 仅 custom 用
  const [range, setRange] = useState('') // '' = 仅本期；ytd = 加一列"本年累计"
  const [rep, setRep] = useState<any>(null)
  const [audit, setAudit] = useState<any>(null)
  const [cmpAudit, setCmpAudit] = useState<any>(null)
  const [rangeAudit, setRangeAudit] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  // 同期多年对比（批次 U 之四 / ④）：并列几期（'' = 不并列）
  const [multiYears, setMultiYears] = useState('')
  // 现金流量项目字典（批次 U）：**只读展示**用。它是口径，不随期间变，所以单独一个 effect 取一次。
  const [cfItems, setCfItems] = useState<any[]>([])

  // 报表的口径（balance / amount / cash_flow）。**来自服务端**，不在前端硬编码
  // "bs 是资产负债表所以不能累计" —— 那是口径知识，口径的知识只能有一份。
  const basisOf = (k: string) => (meta?.reports || []).find((x: any) => x.report_code === k)?.basis || null
  const basis = basisOf(code)
  // 比较模式的定义也**来自服务端**（`compare_modes`：含 `compare_basis`）——
  // "哪个模式是累计对累计"是口径知识，前端不自己写死一个模式名。
  const compareModes: any[] = meta?.compare_modes || []
  const modeIsYtd = compareModes.find((m: any) => m.value === mode)?.compare_basis === 'ytd'
  const multiOn = Boolean(multiYears) && Number(multiYears) > 1
  // 时点口径没有"本年累计"这回事（服务端会 409）；`yoy_ytd` 自带累计（再叠一次没有意义）。
  // 两种情况都**禁用并说明原因**，而不是让用户点了以后收到一个错误。
  const rangeDisabled = basis === 'balance' || modeIsYtd || multiOn

  const wantCustom = mode === 'custom'
  const ready = Boolean(period) && (!wantCustom || Boolean(basePeriod)) && !(rangeDisabled && range)

  useEffect(() => {
    if (!period) return
    onErr('')
    // 比较与单期**走同一个接口家族**：比较端点内部就是对两期各跑一次同一个计算，
    // 所以界面上"两列并排"和"分别打开两期"永远是同一组数。
    // 同期多年对比是第三种形态，也是同一个家族（每一列都是对那一期单独算出来的）。
    const url = multiOn
      ? `/reports/${code}/multi-year`
      : mode
        ? `/reports/${code}/compare`
        : `/reports/${code}`
    const params: any = multiOn
      ? { period, years: multiYears }
      : mode
        ? { period, mode, ...(wantCustom ? { base_period: basePeriod } : {}) }
        : { period, ...(range ? { range } : {}) }
    if (ready || (!mode && !multiOn)) {
      api.get(url, params)
        .then((r: any) => setRep(r.data || r))
        .catch((e: any) => { setRep(null); onErr(e.message) })
    }
    api.get('/reports/audit', { period }).then((r: any) => setAudit(r.data || r)).catch(() => setAudit(null))
    if (mode && !multiOn && ready) {
      api.get(`/reports/${code}/compare/audit`, params).then((r: any) => setCmpAudit(r.data || r)).catch(() => setCmpAudit(null))
    } else {
      setCmpAudit(null)
    }
    if (range && !rangeDisabled) {
      api.get(`/reports/${code}/range/audit`, { period, range }).then((r: any) => setRangeAudit(r.data || r)).catch(() => setRangeAudit(null))
    } else {
      setRangeAudit(null)
    }
  }, [code, period, mode, basePeriod, range, multiYears])

  // 现金流量项目字典只在现金流量表下取：别的表用不到它，取了就是一次没人看的请求。
  // 类别与方向的**中文名由服务端给**（`category_label` / `direction_label`），
  // 前端不自己拼 —— 口径与标签只有一份出处。
  useEffect(() => {
    if (code !== 'cf') return
    api.get('/reports/cashflow-items', { status: 'active' })
      .then((r: any) => setCfItems((r.data || r).rows || []))
      .catch(() => setCfItems([]))
  }, [code])

  // 两种格式**走同一个端点、同一份参数**（只多一个 `format`）：服务端那边是
  // 同一份 `result`、同一份列定义，所以"Excel 里的列和 CSV 里的不一样"不可能发生。
  const doExport = (format: 'csv' | 'xlsx' = 'csv') => {
    setBusy(true)
    onErr('')
    const params: any = multiOn
      ? { period, years: multiYears }
      : mode
        ? { period, mode, ...(wantCustom ? { base_period: basePeriod } : {}) }
        : { period, ...(range ? { range } : {}) }
    if (format !== 'csv') params.format = format
    api.download(`/reports/${code}/export`, params, `${code}_${period}.${format}`)
      .catch((e: any) => onErr(e.message))
      .finally(() => setBusy(false))
  }

  const isTotal = (r: any) => r.line_type !== 'item'
  const pct = (v: any) => (v === null || v === undefined || v === '' ? '—' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`)

  // 列**由服务端给**（`columns`）—— CSV 与本表用同一份定义，
  // 所以"文件里的列名和屏幕上的不一样"这件事不可能发生。
  // 只有「行次」「项目」两列有专门排版，其余一律按 `kind` 渲染。
  const cols: any[] = rep?.columns || [
    { key: 'line_no', label: '行次', kind: 'text' },
    { key: 'line_name', label: '项目', kind: 'text' },
    { key: 'amount', label: '本期金额', kind: 'money' }
  ]
  const cellOf = (r: any, col: any) => {
    if (col.key === 'line_no') return <td key={col.key} className="px-3 py-1 text-slate-400">{r.line_no}</td>
    if (col.key === 'line_name') {
      return (
        <td key={col.key} className="px-3 py-1">
          <span style={{ paddingLeft: (Number(r.level || 1) - 1) * 14 }}>{r.line_name}</span>
          {r.is_fallback && <span className="ml-1 text-[10px] text-amber-600">兜底</span>}
          {r.only_direction && (
            <span className="ml-1 text-[10px] text-slate-400">仅{r.only_direction === 'credit' ? '流入' : '流出'}</span>
          )}
          {r.remark && <div className="text-[10px] text-slate-400 leading-snug">{r.remark}</div>}
        </td>
      )
    }
    const v = r[col.key]
    const dim = col.key === 'base_amount' || col.key === 'ratio'
    return (
      <td key={col.key} className={`px-3 py-1 text-right tabular-nums ${dim ? 'text-slate-500' : ''} ${!dim && Number(v) < 0 ? 'text-emerald-700' : ''}`}>
        {col.kind === 'percent' ? pct(v) : fmt2(v)}
      </td>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
        {REPORT_TABS.map(([k, label]) => (
          <button key={k} onClick={() => setCode(k)}
            className={`px-2.5 py-1 rounded border text-[12px] ${code === k ? 'bg-brand-50 text-brand-700 border-brand-300' : 'border-ink-300 text-slate-600 bg-white'}`}>
            {label}
          </button>
        ))}
        <span className="flex-1" />
        {/* 本年累计：时点口径（资产负债表）**禁用并说明原因** ——
            累计要把若干期加总，而时点报表回答的是"截至某一刻的家底"，两者不是同一个问题 */}
        <label className={`text-[11px] inline-flex items-center gap-1 ${rangeDisabled ? 'text-slate-300' : 'text-slate-600'}`}
          title={rangeDisabled ? `${code.toUpperCase()} 是时点口径，没有"本年累计"这回事` : '加一列"本年累计"（本年 1 月至本期）'}>
          <input type="checkbox" disabled={rangeDisabled} checked={Boolean(range) && !rangeDisabled}
            onChange={(e) => setRange(e.target.checked ? 'ytd' : '')} />
          本年累计
        </label>
        <span className="text-[11px] text-slate-500 ml-2">对比</span>
        {/* 选项**由服务端给**（`meta.compare_modes`）：加一个比较模式不必改前端，
            而"哪个模式是累计对累计"（`compare_basis`）也只有服务端说得准。 */}
        <select className="border border-ink-300 rounded px-2 py-1 text-[12px]" value={mode} disabled={multiOn}
          title={multiOn ? '已选「同期多年对比」，两者是两种不同的表' : undefined}
          onChange={(e) => {
            const next = e.target.value
            setMode(next)
            // 切到"自带累计"的模式时把"本年累计"开关清掉：否则开关会停在"已勾选但被禁用"，
            // 而用户看不出来那一列其实来自模式本身。
            if (compareModes.find((m: any) => m.value === next)?.compare_basis === 'ytd') setRange('')
          }}>
          <option value="">不比较</option>
          {compareModes.map((m: any) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        {/* 同期多年对比（跨年度报表）：并列 N 期（本期 + 往前 N-1 个年度） */}
        <span className="text-[11px] text-slate-500 ml-2">同期多年</span>
        <select className="border border-ink-300 rounded px-2 py-1 text-[12px]" value={multiYears}
          title="同一张表并排最近 N 年的同一个月份（跨年度报表）"
          onChange={(e) => { setMultiYears(e.target.value); if (e.target.value) setMode('') }}>
          <option value="">不并列</option>
          {[2, 3, 4, 5].map((n) => <option key={n} value={String(n)}>{n} 期（{n - 1} 年同期）</option>)}
        </select>
        {wantCustom && (
          <select className="border border-ink-300 rounded px-2 py-1 text-[12px]" value={basePeriod} onChange={(e) => setBasePeriod(e.target.value)}>
            <option value="">（选择基期）</option>
            {/* 只列**早于本期**的期间：拿未来的期间当基期，差额的符号会与"增长"的直觉相反 */}
            {(meta?.periods || []).filter((p: any) => p.period < period).map((p: any) => (
              <option key={p.period} value={p.period}>{p.period} · {p.posted_count} 张已过账</option>
            ))}
          </select>
        )}
        <button onClick={() => doExport('csv')} disabled={!ready && wantCustom}
          className="px-2 py-1 rounded border border-ink-300 text-[12px] bg-white inline-flex items-center gap-1 disabled:opacity-50">
          <Download size={12} />{busy ? '导出中…' : '导出 CSV'}
        </button>
        {/* Excel：与 CSV 同一个端点、同一份列定义，只多一个 `format=xlsx` */}
        <button onClick={() => doExport('xlsx')} disabled={!ready && wantCustom}
          className="px-2 py-1 rounded border border-ink-300 text-[12px] bg-white inline-flex items-center gap-1 disabled:opacity-50"
          title="导出为 Excel 工作簿（列与 CSV 完全一致）">
          <FileSpreadsheet size={12} />导出 Excel
        </button>
      </div>

      {rangeDisabled && <div className="text-[11px] text-slate-400 mb-2">
        「本年累计」对资产负债表**不适用**：它回答的是"截至某一刻的家底"（时点口径），
        而累计要把若干期加总 —— 硬做出来的两列要么一模一样、要么是把同一个时点数加了若干遍。利润表与现金流量表可以。
      </div>}
      {wantCustom && !basePeriod && <div className="text-[11px] text-amber-700 mb-2">请选择基期期间（必须早于本期）。</div>}

      {/* 报表自证：三条恒等式的现场结果 */}
      {audit && (
        <div className={`mb-2 border rounded px-3 py-2 text-[11px] flex items-start gap-2 ${
          audit.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'
        }`}>
          {audit.ok ? <ShieldCheck size={13} className="mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
          <div>
            <div className="font-medium">
              {audit.ok ? `报表自证通过（${audit.period}）` : `报表自证不通过（${audit.period}）`}
            </div>
            {audit.ok ? (
              <div className="mt-0.5">
                资产 {fmt(audit.totals.assets)} ＝ 负债 {fmt(audit.totals.liabilities)} ＋ 所有者权益 {fmt(audit.totals.equity)}
                ；净利润 {fmt(audit.totals.net_profit)}；现金净增加额 {fmt(audit.totals.cash_net_increase)}
              </div>
            ) : (
              <ul className="mt-0.5 list-disc list-inside space-y-0.5">
                {(audit.problems || []).map((p: any, i: number) => <li key={i}>{p.message}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* 比较自证：两列必须等于"单独打开那一期"，差额必须等于两列相减 */}
      {mode && cmpAudit && !cmpAudit.ok && (
        <div className="mb-2 border rounded px-3 py-2 text-[11px] bg-red-50 border-red-200 text-red-700 flex items-start gap-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">比较结果未通过自证</div>
            <ul className="mt-0.5 list-disc list-inside space-y-0.5">
              {(cmpAudit.problems || []).map((p: any, i: number) => <li key={i}>{p.message}</li>)}
            </ul>
          </div>
        </div>
      )}

      {/* 累计自证：起点必须是本年 1 月、终点必须就是本期，且**逐行等于"逐月各算一次再相加"** */}
      {range && rangeAudit && (
        <div className={`mb-2 border rounded px-3 py-2 text-[11px] flex items-start gap-2 ${
          rangeAudit.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'
        }`}>
          {rangeAudit.ok ? <ShieldCheck size={13} className="mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
          <div>
            <div className="font-medium">
              {rangeAudit.ok
                ? `本年累计自证通过（${rangeAudit.from} ~ ${rangeAudit.to}，${rangeAudit.months_checked} 个月逐月核对）`
                : '本年累计未通过自证'}
            </div>
            {rangeAudit.ok
              ? <div className="mt-0.5">累计列的每一个数都等于「本年 1 月至本期<b>逐月各算一次再相加</b>」——两条独立路径互证。</div>
              : (
                <ul className="mt-0.5 list-disc list-inside space-y-0.5">
                  {(rangeAudit.problems || []).map((p: any, i: number) => <li key={i}>{p.message}</li>)}
                </ul>
              )}
          </div>
        </div>
      )}

      {/* 基期没数据是**常见事实**（上月确实没开张），不是错误 —— 但必须说出来，
          否则"基期 0 → 本期 8 万"看起来就像暴涨 */}
      {rep?.base_meta && !rep.base_meta.comparable && (
        <div className="mb-2 border rounded px-3 py-2 text-[11px] bg-amber-50 border-amber-200 text-amber-800 flex items-start gap-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <div>
            基期 <b>{rep.base_period}</b> 没有任何已过账凭证，也没有可滚动的期初余额 ——
            这一列的 0 <b>表示"那期没有业务"</b>，不是"那期全是零"。差额等于本期全额，请勿读作增长。
          </div>
        </div>
      )}

      {!rep && <div className="text-[12px] text-slate-500">选择期间后加载…</div>}

      {rep && (
        <div className="bg-white border border-ink-200 rounded overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 flex items-center gap-2 flex-wrap">
            <div className="text-[13px] font-medium">{rep.report_name}</div>
            <div className="text-[11px] text-slate-400">
              {rep.period} · {rep.basis_label}
              {rep.base_period && (
                <>
                  {' · '}{rep.mode_label}对比 <b className="text-slate-600">{rep.base_period}</b>
                  <span className={rep.base_meta?.status === 'closed' ? 'text-emerald-700' : 'text-amber-700'}>
                    （{rep.base_meta?.status === 'closed' ? '已关账·定稿数' : '未关账·还会变'}）
                  </span>
                </>
              )}
              {rep.range_meta?.is_range && (
                <>
                  {' · '}<b className="text-slate-600">{rep.range_meta.mode_label}</b>
                  {' '}{rep.range_meta.from} ~ {rep.range_meta.to}
                </>
              )}
            </div>
            {rep.cash && (
              <div className="text-[11px] text-slate-500 ml-auto">
                涉现金凭证 {rep.cash.cash_vouchers} 张 · 流入 {fmt2(rep.cash.cash_in)} / 流出 {fmt2(rep.cash.cash_out)}
                {/* 填列构成只在服务端**确实报了这两个数**时才显示。
                    拿 `?? 0` 兜底会在"后端还是旧版本"时显示 0/0 —— 那是在说"这个月一条现金收支都没有"，
                    而事实是"这一版后端还不会报这个数"。不印一个自己也不认识的 0。 */}
                {typeof rep.cash.untagged_count === 'number' && (
                  <>
                    {' · '}标记填列 <span className="text-slate-700 font-medium">{rep.cash.tagged_count}</span> 条
                    {' / '}分析倒推 <span className="text-amber-700 font-medium">{rep.cash.untagged_count}</span> 条
                  </>
                )}
              </div>
            )}
          </div>
          <table className="w-full text-[12px]">
            <thead className="bg-ink-50 text-slate-500">
              <tr>
                {cols.map((c: any) => (
                  <th key={c.key} className={`px-3 py-1.5 font-normal ${c.key === 'line_no' ? 'text-left w-16' : c.key === 'line_name' ? 'text-left' : 'text-right w-32'}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rep.rows.map((r: any) => (
                <tr key={r.id ?? r.line_no}
                  className={`border-t border-ink-100 ${isTotal(r) ? 'bg-ink-50/60 font-medium' : ''} ${r.is_fallback ? 'text-slate-400' : ''}`}>
                  {cols.map((c: any) => cellOf(r, c))}
                </tr>
              ))}
            </tbody>
          </table>
          {rep.cash && (
            <div className="px-3 py-2 border-t border-ink-200 text-[11px] text-slate-500 leading-relaxed space-y-1">
              <div>
                填列口径：<b className="text-slate-600">标记优先</b>。分录上标了「现金流量项目」的，
                按项目对应的报表行直接落账；<b className="text-slate-600">没有标记的</b>（存量凭证，
                以及标了却落不到报表行上的）才按凭证的<b className="text-slate-600">对手科目</b>分析填列 ——
                非现金分录方向单一且金额正好对上现金侧时逐条归类，
                现金与非现金多线交叉的<b className="text-slate-600">复合凭证</b>按净额归入兜底行。
              </div>
              {/* 同样只在服务端确实报了这两个数时才说"本期构成" */}
              {typeof rep.cash.untagged_count === 'number' && (
                <div>
                  本期构成：标记填列 <span className="text-slate-700 font-medium">{rep.cash.tagged_count}</span> 条 /
                  分析倒推 <span className="text-amber-700 font-medium">{rep.cash.untagged_count}</span> 条
                  （其中复合凭证 <span className="text-amber-700 font-medium">{rep.cash.complex_vouchers}</span> 张按净额进兜底行，
                  走了标记路径的凭证 <span className="text-slate-700 font-medium">{rep.cash.tagged_vouchers}</span> 张）。<br />
                  两个数混着看会误判这张表的可信度 ——
                  标记是人给的答案，分析是推出来的结论，所以两者分开报。
                </div>
              )}
              {rep.cash.tagged_unresolved_count > 0 && (
                <div className="text-red-600">
                  另有 {rep.cash.tagged_unresolved_count} 条分录标了项目却落不到报表行上（字典里的落点指向了一个不存在的行），
                  它们已退回按对手科目分析填列。请到现金流量项目字典里检查落点。
                </div>
              )}
              <div className="text-slate-400">
                自证：本表净增加额必须等于现金类科目（{rep.cash.cash_subjects.join('、')}）的期末余额减期初余额。
              </div>
            </div>
          )}
          {rep.cash && cfItems.length > 0 && (
            <details className="px-3 py-2 border-t border-ink-200 text-[11px] text-slate-500">
              <summary className="cursor-pointer select-none">
                现金流量项目字典（{cfItems.length} 项 · 只读）
              </summary>
              <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* 类别的顺序与中文名都**从服务端那一行取**（`category_label`），不在这里硬编码 */}
                {[...new Set(cfItems.map((i: any) => i.category))].map((cat: any) => (
                  <div key={cat}>
                    <div className="font-medium text-slate-600 mb-1">
                      {cfItems.find((i: any) => i.category === cat)?.category_label || cat}
                    </div>
                    <ul className="space-y-0.5">
                      {cfItems.filter((i: any) => i.category === cat).map((i: any) => (
                        <li key={i.code} className="flex items-start gap-1">
                          <span className={i.direction === 'in' ? 'text-emerald-600' : i.direction === 'out' ? 'text-amber-600' : 'text-slate-400'}>
                            {i.direction === 'in' ? '＋' : i.direction === 'out' ? '－' : '±'}
                          </span>
                          <span className="text-slate-600" title={`${i.code}｜${i.direction_label}`}>{i.name}</span>
                          <span className="text-slate-300 ml-auto shrink-0">{i.report_line_code || '未配落点'}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-slate-400">
                打标记的入口在凭证侧（POST /api/reports/vouchers/:id/tag-cashflow）；
                本页只读展示字典 —— 改口径是另一个权限点，不在这张表上顺手做。
              </div>
            </details>
          )}
          <div className="px-3 py-2 border-t border-ink-200 text-[11px] text-slate-400 leading-relaxed">
            导出的 CSV **就是本页的数**（同一个计算入口、**同一份列定义**，逐行逐列照抄）。
            {rep.base_period
              ? '比较列取自对基期单独计算的结果；差额 = 本期 − 基期（两列相减），变动率 = 差额 ÷ |基期|，基期为 0 时留空。'
              : rep.range_meta?.is_range
                ? `累计列 = 本年 1 月至本期（${rep.range_meta.from} ~ ${rep.range_meta.to}，含两端）的发生额聚合；本期列不受影响。`
                : '列名里带期间，直接拿去再加工。'}
          </div>
        </div>
      )}
    </div>
  )
}

// ===========================================================================
// 二、科目余额表（三张报表的同一个取数口）
// ===========================================================================

function Balances({ period, onErr }: any) {
  const [data, setData] = useState<any>(null)
  useEffect(() => {
    if (!period) return
    api.get('/reports/subject-balances', { period }).then((r: any) => setData(r.data || r)).catch((e: any) => onErr(e.message))
  }, [period])
  if (!data) return <div className="text-[12px] text-slate-500">选择期间后加载…</div>
  const rows = (data.rows || []).filter((r: any) =>
    Number(r.opening_signed) !== 0 || Number(r.period_debit) !== 0 || Number(r.period_credit) !== 0)
  return (
    <div className="bg-white border border-ink-200 rounded overflow-hidden">
      <div className="px-3 py-2 border-b border-ink-200 text-[12px] flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">科目余额表 · {data.period}</span>
        <span className={data.movement.balanced ? 'text-emerald-700' : 'text-red-600'}>
          本期借 {fmt(data.movement.total_debit)} / 贷 {fmt(data.movement.total_credit)}
          {data.movement.balanced ? '（平）' : `（差 ${fmt2(data.movement.diff)}）`}
        </span>
        <span className="text-slate-500">已过账 {data.movement.voucher_count} 张{data.movement.draft_count ? ` · 未过账 ${data.movement.draft_count} 张（不计入）` : ''}</span>
        <span className="text-slate-500">
          期初{data.opening.has_opening ? `登记于 ${data.opening.base_period}` : '未登记（按 0 起算）'}
          {data.opening.rolled_vouchers ? `，已滚动 ${data.opening.rolled_vouchers} 张凭证` : ''}
        </span>
      </div>
      <table className="w-full text-[12px]">
        <thead className="bg-ink-50 text-slate-500">
          <tr>
            <th className="text-left px-3 py-1.5 font-normal">科目</th>
            <th className="text-right px-3 py-1.5 font-normal">期初（借−贷）</th>
            <th className="text-right px-3 py-1.5 font-normal">本期借方</th>
            <th className="text-right px-3 py-1.5 font-normal">本期贷方</th>
            <th className="text-right px-3 py-1.5 font-normal">期末（借−贷）</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={5} className="px-3 py-3 text-center text-slate-400">本期间与期初均无发生额</td></tr>
          )}
          {rows.map((r: any) => (
            <tr key={r.subject_id} className="border-t border-ink-100">
              <td className="px-3 py-1">{r.code} {r.name}</td>
              <td className="px-3 py-1 text-right tabular-nums">{fmt2(r.opening_signed)}</td>
              <td className="px-3 py-1 text-right tabular-nums">{fmt2(r.period_debit)}</td>
              <td className="px-3 py-1 text-right tabular-nums">{fmt2(r.period_credit)}</td>
              <td className="px-3 py-1 text-right tabular-nums font-medium">{fmt2(r.closing_signed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ===========================================================================
// 三、期间与关账
// ===========================================================================

function Periods({ meta, reloadMeta, onErr }: any) {
  const [rows, setRows] = useState<any[]>([])
  const [trail, setTrail] = useState<any>(null)
  const [openPeriod, setOpenPeriod] = useState('')
  const [history, setHistory] = useState<any>(null)

  const load = () => {
    api.get('/reports/periods').then((r: any) => setRows((r.data || r).rows || [])).catch((e: any) => onErr(e.message))
    // 审计链自证与期间列表**一起刷新**：「账面自洽」与「这段历史解释得通」是同一屏的两件事，
    // 分两次加载只会出现"表变了、自证还是上一版"的中间态。
    api.get('/reports/periods/audit/check').then((r: any) => setTrail(r.data || r)).catch(() => setTrail(null))
  }
  useEffect(() => { load() }, [])

  // 展开某一期的变更历史（**懒加载**：点开才查 —— 一次列出所有期间的所有日志没有意义）
  const toggleHistory = (p: string) => {
    if (openPeriod === p) { setOpenPeriod(''); return }
    setOpenPeriod(p)
    setHistory(null)
    api.get('/reports/periods/audit', { period: p, limit: 200 })
      .then((r: any) => setHistory(r.data || r))
      .catch((e: any) => { onErr(e.message); setHistory(null) })
  }

  const doClose = (p: string) => {
    const remark = window.prompt(`关账 ${p}：关账后该期间不能再过账。备注（可空）`) ?? ''
    onErr('')
    api.post(`/reports/periods/${p}/close`, { remark })
      .then(() => { load(); reloadMeta() })
      .catch((e: any) => onErr(e.message))
  }
  const doReopen = (p: string) => {
    // 反关账会让"已定稿"的期间重新可变 —— 与作废已过账凭证同一个道理，必须写理由
    const reason = window.prompt(`反关账 ${p}：必须填写理由（它会改变已定稿期间的报表）`)
    if (!reason) return
    onErr('')
    api.post(`/reports/periods/${p}/reopen`, { reason })
      .then(() => { load(); reloadMeta() })
      .catch((e: any) => onErr(e.message))
  }
  // 期末结转（批次 M）：把损益类科目余额结转到「本年利润」。
  // 它**会生成一张已过账的凭证**（真的动账），所以与关账分开授权（`finance.period.carry`）。
  const doCarry = (p: string) => {
    const remark = window.prompt(`期末结转 ${p}：把本期损益类科目余额结转到「本年利润」。备注（可空）`) ?? ''
    onErr('')
    api.post(`/reports/periods/${p}/carry-forward`, { remark })
      .then(() => { load(); reloadMeta() })
      .catch((e: any) => onErr(e.message))
  }
  const doReverse = (p: string) => {
    // 撤销结转会把这一期的结转账**删掉**（它是可复算的派生凭证），账重新变成未结平 ——
    // 与反关账、作废已过账凭证同一个道理，必须写理由
    const reason = window.prompt(`撤销结转 ${p}：必须填写理由（它会删掉这一期的结转账，账重新变成未结平）`)
    if (!reason) return
    onErr('')
    api.post(`/reports/periods/${p}/reverse-closing`, { reason })
      .then(() => { load(); reloadMeta() })
      .catch((e: any) => onErr(e.message))
  }

  return (
    <div className="bg-white border border-ink-200 rounded overflow-hidden">
      <div className="px-3 py-2 border-b border-ink-200 text-[12px] text-slate-500 leading-relaxed">
        <div>
          <b className="text-slate-700">期末结转</b> = 把损益类科目（6xxx）的余额搬到「本年利润」（4103），
          让损益科目归零。不做这一步，收入科目的余额会一路积到跨年（6001 的余额变成"开业至今的全部收入"），
          而"账上累计利润"也就答不出来。结转**会生成一张已过账的凭证**，日期取期间末日。
        </div>
        <div className="mt-1">
          <b className="text-slate-700">关账</b> = 「这一期的账**结平**定稿了」。没有它，9 月的报表会随着 10 月做事而改变。
          关账前会跑三张报表的自证 + 检查"本期已结转"（空期间除外）—— 带着一张不平的资产负债表定稿，
          等于把差额永久封存在这一期里。已关账期间<b>不能再过账</b>，但<b>可以生成</b>
          （`draft` 不计入任何报表，拦它只会让"先录单、后开账"走不通）。
        </div>
        <div className="mt-1 text-slate-400">
          要改动一个已关账的期间：<b>反关账（写理由）→ 撤销结转（写理由）→ 改账 → 重新结转 → 关账</b>。
          反关账不要求先撤销结转（否则两者会互相锁死），但反关账之后<b>必须</b>撤销结转再重做，
          否则新补的损益发生额进不了本年利润 —— 报表自证会把它报出来。
        </div>
        <div className="mt-1">
          <b className="text-slate-700">变更历史</b> = 每一次关账 / 反关账 / 结转 / 撤销 / 年结 / 分配**只追加**的一条记录。
          期间表上只有"最后一次"（谁关的、理由是什么随时被下一次覆盖），历史在上面每一行的「变更历史」里。
          自证方式：**从空状态按序重放这些记录，结果必须等于期间表里的现状** ——
          两者对不上，就说明有动作改了账却没留下痕迹。
        </div>
      </div>
      {/* 审计链自证：与"报表三条恒等式"并列的第二类健康检查 —— 那三条问"账算得对不对"，
          这一条问"现在这个样子能不能由来路解释" */}
      {trail && (
        <div className={`px-3 py-2 border-b text-[11px] flex items-start gap-2 ${
          trail.ok ? 'bg-emerald-50/60 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'
        }`}>
          {trail.ok ? <ShieldCheck size={13} className="mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
          <div>
            <div className="font-medium">
              {trail.ok
                ? `期间审计链自洽（核了 ${trail.periods_checked} 个期间 / ${trail.entries_checked} 条变更记录）`
                : '期间审计链不自洽'}
            </div>
            {trail.ok ? (
              <div className="mt-0.5">
                重放全部变更记录得到的状态 = 期间表现状；每条结转/分配凭证都能在日志里找到来源。
              </div>
            ) : (
              <ul className="mt-0.5 list-disc list-inside space-y-0.5">
                {(trail.problems || []).map((p: any, i: number) => <li key={i}>{p.message}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}
      <table className="w-full text-[12px]">
        <thead className="bg-ink-50 text-slate-500">
          <tr>
            <th className="text-left px-3 py-1.5 font-normal">期间</th>
            <th className="text-left px-3 py-1.5 font-normal">关账状态</th>
            <th className="text-left px-3 py-1.5 font-normal">结转状态</th>
            <th className="text-left px-3 py-1.5 font-normal">关账人 / 时间</th>
            <th className="text-left px-3 py-1.5 font-normal">理由（反关账 / 撤销结转）</th>
            <th className="text-right px-3 py-1.5 font-normal w-56">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r: any) => (
            <Fragment key={r.period}>
            <tr className="border-t border-ink-100">
              <td className="px-3 py-1 font-mono">{r.period}</td>
              <td className="px-3 py-1">
                <span className={`px-1.5 py-0.5 rounded border text-[11px] ${
                  r.status === 'closed' ? 'bg-slate-100 text-slate-600 border-ink-300' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                  {r.status_label}
                </span>
              </td>
              <td className="px-3 py-1">
                <span className={`px-1.5 py-0.5 rounded border text-[11px] ${
                  r.carried ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-white text-slate-500 border-ink-200'}`}>
                  {r.closing_label}
                </span>
                {r.closing_voucher_id ? <span className="text-slate-400 ml-1">凭证 #{r.closing_voucher_id}</span> : null}
              </td>
              <td className="px-3 py-1 text-slate-500">{r.closed_by_name || '—'} {r.closed_at || ''}</td>
              <td className="px-3 py-1 text-slate-500">{r.reopen_reason || r.closing_reverse_reason || '—'}</td>
              <td className="px-3 py-1 text-right space-x-1 whitespace-nowrap">
                <button onClick={() => toggleHistory(r.period)}
                  className={`px-2 py-0.5 rounded border text-[11px] inline-flex items-center gap-1 ${
                    openPeriod === r.period ? 'border-brand-300 text-brand-700 bg-brand-50' : 'border-ink-300 text-slate-600 bg-white'}`}>
                  <History size={11} />变更历史
                </button>
                {!r.carried && (
                  <button onClick={() => doCarry(r.period)} className="px-2 py-0.5 rounded border border-brand-300 text-brand-700 text-[11px] bg-white inline-flex items-center gap-1">
                    <ArrowRightLeft size={11} />期末结转
                  </button>
                )}
                {r.carried && r.status !== 'closed' && (
                  <button onClick={() => doReverse(r.period)} className="px-2 py-0.5 rounded border border-ink-300 text-[11px] bg-white inline-flex items-center gap-1">
                    <RefreshCw size={11} />撤销结转
                  </button>
                )}
                {r.status === 'closed' ? (
                  <button onClick={() => doReopen(r.period)} className="px-2 py-0.5 rounded border border-ink-300 text-[11px] bg-white inline-flex items-center gap-1">
                    <Unlock size={11} />反关账
                  </button>
                ) : (
                  <button onClick={() => doClose(r.period)} className="px-2 py-0.5 rounded border border-ink-300 text-[11px] bg-white inline-flex items-center gap-1">
                    <Lock size={11} />关账
                  </button>
                )}
              </td>
            </tr>
            {openPeriod === r.period && (
              <tr className="border-t border-ink-100 bg-ink-50/40">
                <td colSpan={6} className="px-3 py-2">
                  {/* 这一期"为什么是现在这个样子"—— 期间表上只有最后一次，历史在这里 */}
                  <div className="text-[11px] text-slate-500 mb-1">
                    变更历史（只追加，不可修改）—— 共 {history?.total ?? 0} 条；
                    自证方式：从空状态按序重放这些记录，结果必须等于上表里的现状。
                  </div>
                  {!history && <div className="text-[11px] text-slate-400">加载中…</div>}
                  {history && history.rows.length === 0 && (
                    <div className="text-[11px] text-slate-400">这一期还没有任何变更记录（从建立到现在一直是「未关账、未结转」）</div>
                  )}
                  {history && history.rows.length > 0 && (
                    <table className="w-full text-[11px]">
                      <thead className="text-slate-400">
                        <tr>
                          <th className="text-left py-0.5 font-normal w-8">#</th>
                          <th className="text-left py-0.5 font-normal w-32">时间</th>
                          <th className="text-left py-0.5 font-normal w-28">动作</th>
                          <th className="text-left py-0.5 font-normal w-32">状态</th>
                          <th className="text-right py-0.5 font-normal w-24">金额</th>
                          <th className="text-left py-0.5 font-normal w-24">操作人</th>
                          <th className="text-left py-0.5 font-normal">理由 / 备注</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.rows.map((h: any) => (
                          <tr key={h.id} className="border-t border-ink-100">
                            <td className="py-0.5 text-slate-400">{h.id}</td>
                            <td className="py-0.5 text-slate-500 font-mono">{h.created_at}</td>
                            <td className="py-0.5">
                              <span className={`px-1 py-0.5 rounded border ${
                                h.scope === 'year' ? 'bg-purple-50 text-purple-700 border-purple-200' : 'bg-white text-slate-600 border-ink-200'}`}>
                                {h.action_label}
                              </span>
                            </td>
                            <td className="py-0.5 text-slate-500">
                              {h.status_before ? `${h.status_before === 'closed' ? '已关账' : '未关账'} → ` : ''}
                              {h.status_after ? (h.status_after === 'closed' ? '已关账' : '未关账') : ''}
                              {!h.status_after && !h.status_before ? '（不改状态）' : ''}
                              {h.voucher_doc_no ? <span className="ml-1 text-slate-400">{h.voucher_doc_no}</span> : null}
                            </td>
                            <td className="py-0.5 text-right tabular-nums">{h.amount === null ? '—' : fmt2(h.amount)}</td>
                            <td className="py-0.5 text-slate-500">{h.actor_label}</td>
                            <td className="py-0.5 text-slate-500">{h.reason || h.remark || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {history?.truncated && <div className="text-[11px] text-amber-600 mt-1">记录超过 {history.limit} 条，只显示最近的部分</div>}
                </td>
              </tr>
            )}
            </Fragment>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-3 text-center text-slate-400">暂无期间登记</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

// ===========================================================================
// 四、期初余额
// ===========================================================================

function Opening({ period, onErr }: any) {
  const [data, setData] = useState<any>(null)
  const [text, setText] = useState('')
  useEffect(() => {
    if (!period) return
    api.get('/reports/opening', { period }).then((r: any) => {
      const d = r.data || r
      setData(d)
      setText((d.rows || []).map((x: any) => `${x.subject_code},${Number(x.debit_amount || 0)},${Number(x.credit_amount || 0)}`).join('\n'))
    }).catch((e: any) => onErr(e.message))
  }, [period])

  const save = () => {
    const rows = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [subject_code, debit_amount, credit_amount] = l.split(',').map((s) => s.trim())
      return { subject_code, debit_amount: Number(debit_amount || 0), credit_amount: Number(credit_amount || 0) }
    })
    onErr('')
    // 整批覆盖：期初试算表必须在**写入前**对整批做平衡校验，不平就整批不落库。
    // 逐条改的时候人看不到"现在的合计是多少"，而一张不平的期初会让之后每一期都不平。
    api.put('/reports/opening', { period, rows })
      .then((r: any) => setData(r.data || r))
      .catch((e: any) => onErr(e.message))
  }

  if (!data) return <div className="text-[12px] text-slate-500">选择期间后加载…</div>
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <div className="bg-white border border-ink-200 rounded overflow-hidden">
        <div className="px-3 py-2 border-b border-ink-200 text-[12px]">
          <span className="font-medium">期初余额 · {data.period}</span>
          <span className={`ml-2 ${data.balanced ? 'text-emerald-700' : 'text-red-600'}`}>
            借 {fmt(data.total_debit)} / 贷 {fmt(data.total_credit)}{data.balanced ? '（平）' : `（差 ${fmt2(data.diff)}）`}
          </span>
        </div>
        <table className="w-full text-[12px]">
          <thead className="bg-ink-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-1.5 font-normal">科目</th>
              <th className="text-right px-3 py-1.5 font-normal">借方余额</th>
              <th className="text-right px-3 py-1.5 font-normal">贷方余额</th>
            </tr>
          </thead>
          <tbody>
            {(data.rows || []).map((r: any) => (
              <tr key={r.id} className="border-t border-ink-100">
                <td className="px-3 py-1">{r.subject_code} {r.subject_name}</td>
                <td className="px-3 py-1 text-right tabular-nums">{Number(r.debit_amount) ? fmt(r.debit_amount) : ''}</td>
                <td className="px-3 py-1 text-right tabular-nums">{Number(r.credit_amount) ? fmt(r.credit_amount) : ''}</td>
              </tr>
            ))}
            {(data.rows || []).length === 0 && (
              <tr><td colSpan={3} className="px-3 py-3 text-center text-slate-400">该期间未登记期初余额（报表按 0 起算）</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="bg-white border border-ink-200 rounded p-3">
        <div className="text-[12px] font-medium mb-1">编辑期初（整批覆盖）</div>
        <div className="text-[11px] text-slate-500 mb-2 leading-relaxed">
          每行格式：<code className="bg-ink-50 px-1">科目编码,借方余额,贷方余额</code>。
          借贷必须相等，否则**整批不落库** ——
          一张不平的期初试算表会让之后每一期的资产负债表都不平，而差额来源从此不可考。
          同一科目不能同时有借方与贷方余额。
        </div>
        <textarea className="w-full h-56 border border-ink-300 rounded p-2 text-[12px] font-mono"
          value={text} onChange={(e) => setText(e.target.value)}
          placeholder={'1001,5000,0\n1002,1200000,0\n2202,0,900000'} />
        <div className="flex items-center gap-2 mt-2">
          <button onClick={save} className="px-2.5 py-1 rounded bg-brand-700 text-white text-[12px]">保存期初</button>
          <button onClick={() => setText((data.rows || []).map((x: any) => `${x.subject_code},${Number(x.debit_amount || 0)},${Number(x.credit_amount || 0)}`).join('\n'))}
            className="px-2.5 py-1 rounded border border-ink-300 text-[12px] bg-white inline-flex items-center gap-1">
            <RefreshCw size={11} />重置
          </button>
        </div>
      </div>
    </div>
  )
}

// ===========================================================================
// 六、年度与分配（年结 4103 → 4104 · 利润分配 4104 → 4105 / 2232）
// ===========================================================================

function Annual({ onErr }: any) {
  const [rows, setRows] = useState<any[]>([])
  const [year, setYear] = useState('')
  const [plan, setPlan] = useState<any>(null)
  const [dist, setDist] = useState<any>(null)
  const [items, setItems] = useState<any[]>([{ subject_code: '', amount: '', label: '' }])

  const loadList = () => api.get('/reports/annual')
    .then((r: any) => {
      const list = (r.data || r).rows || []
      setRows(list)
      if (list.length && !year) setYear(list[0].year)
    })
    .catch((e: any) => onErr(e.message))
  useEffect(() => { loadList() }, [])

  const loadYear = (y: string) => {
    if (!y) return
    api.get(`/reports/annual/${y}`).then((r: any) => setPlan(r.data || r)).catch((e: any) => { setPlan(null); onErr(e.message) })
    api.get(`/reports/annual/${y}/distribution`).then((r: any) => setDist(r.data || r)).catch(() => setDist(null))
  }
  useEffect(() => { loadYear(year) }, [year])
  const refresh = () => { loadList(); loadYear(year) }

  const doCarry = () => {
    const remark = window.prompt(`年度结转 ${year}：把「本年利润」结转到「未分配利润」，并把这一年封账。备注（可空）`) ?? ''
    onErr('')
    api.post(`/reports/annual/${year}/carry-forward`, { remark }).then(refresh).catch((e: any) => onErr(e.message))
  }
  const doReverseAnnual = () => {
    // 撤销年结要写理由 —— 它会删掉年结凭证，4103 恢复余额
    const reason = window.prompt(`撤销 ${year} 年度结转：必须填写理由（它会删掉年结凭证，本年利润恢复余额）`)
    if (!reason) return
    onErr('')
    api.post(`/reports/annual/${year}/reverse-closing`, { reason }).then(refresh).catch((e: any) => onErr(e.message))
  }
  const doDistribute = () => {
    const clean = items
      .filter((x) => x.subject_code && Number(x.amount) > 0)
      .map((x) => ({ subject_code: x.subject_code, amount: Number(x.amount), label: x.label || undefined }))
    if (!clean.length) { onErr('请至少填一个分配项（目标科目 + 正数金额）'); return }
    const total = clean.reduce((s, x) => s + x.amount, 0)
    // 分配是**决议** —— 金额由人给，所以这里必然有一次人工确认
    if (!window.confirm(`确认分配 ${total.toFixed(2)}？（借 ${year} 年末的未分配利润 / 贷各目标科目）凭证默认做在次年 1 月`)) return
    onErr('')
    api.post(`/reports/annual/${year}/distribute`, { items: clean })
      .then(() => { setItems([{ subject_code: '', amount: '', label: '' }]); refresh() })
      .catch((e: any) => onErr(e.message))
  }
  const doReverseDist = () => {
    const reason = window.prompt(`撤销 ${year} 的利润分配：必须填写理由`)
    if (!reason) return
    onErr('')
    api.post(`/reports/annual/${year}/reverse-distribution`, { reason }).then(refresh).catch((e: any) => onErr(e.message))
  }

  return (
    <div className="space-y-3">
      <div className="bg-white border border-ink-200 rounded overflow-hidden">
        <div className="px-3 py-2 border-b border-ink-200 text-[12px] text-slate-500 leading-relaxed">
          <div>
            <b className="text-slate-700">年度结转</b> = 把「本年利润」（4103）结转到「未分配利润」（4104），
            并把这一年<b>封账</b>（该年度所有期间置为已关账）。不做这一步，4103 会一年一年地累积，
            "账上到底有多少可分配的利润"永远答不出来。
          </div>
          <div className="mt-1">
            <b className="text-slate-700">利润分配</b> = 从 4104 里拿钱去提盈余公积（4105）、分股利（2232）。
            它是<b>决议</b>不是算法 —— 金额必须由人给，系统只负责校验、记账、留痕。
            凭证默认做在<b>次年 1 月</b>（分红决议在次年作出，账也做在次年）。
          </div>
          <div className="mt-1 text-slate-400">
            撤销必须反向：<b>撤分配 → 撤年结 → 反关账 → 改账</b>；每一步都要写理由。
            年结要求<b>全年都做过月度结转</b> —— 漏一个月就做年结，那个月的损益会永久留在 6xxx 上，而账仍然是平的。
          </div>
        </div>
        <table className="w-full text-[12px]">
          <thead className="bg-ink-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-1.5 font-normal">年度</th>
              <th className="text-left px-3 py-1.5 font-normal">期间</th>
              <th className="text-left px-3 py-1.5 font-normal">年结</th>
              <th className="text-left px-3 py-1.5 font-normal">分配</th>
              <th className="text-right px-3 py-1.5 font-normal">4103 待结转</th>
              <th className="text-right px-3 py-1.5 font-normal">可分配</th>
              <th className="text-left px-3 py-1.5 font-normal">能不能年结</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.year} onClick={() => setYear(r.year)}
                className={`border-t border-ink-100 cursor-pointer hover:bg-ink-50/60 ${year === r.year ? 'bg-brand-50/50' : ''}`}>
                <td className="px-3 py-1 font-mono">{r.year}</td>
                <td className="px-3 py-1 text-slate-500">{r.periods} 期 · 已关 {r.closed_periods}</td>
                <td className="px-3 py-1">
                  <span className={`px-1.5 py-0.5 rounded border text-[11px] ${r.carried ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-white text-slate-500 border-ink-200'}`}>
                    {r.carried ? '已年结' : '未年结'}
                  </span>
                </td>
                <td className="px-3 py-1">
                  <span className={`px-1.5 py-0.5 rounded border text-[11px] ${r.distributed ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-white text-slate-500 border-ink-200'}`}>
                    {r.distributed ? '已分配' : '未分配'}
                  </span>
                </td>
                <td className="px-3 py-1 text-right tabular-nums">{fmt2(r.carry_profit)}</td>
                <td className="px-3 py-1 text-right tabular-nums">{r.deficit ? '累计亏损' : fmt2(r.distributable)}</td>
                <td className="px-3 py-1">
                  {r.can_carry
                    ? <span className="text-emerald-700">可以</span>
                    : <span className="text-amber-700" title={r.blocked_message || ''}>{r.blocked?.join('、') || '—'}</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-3 text-center text-slate-400">账上还没有任何年度</td></tr>}
          </tbody>
        </table>
      </div>

      {plan && (
        <div className="bg-white border border-ink-200 rounded p-3 text-[12px]">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className="font-medium">{plan.year} 年度</span>
            <span className="text-slate-400">
              年末期间 {plan.december_period} · 待结转 {fmt2(plan.carry_profit)} ·
              本年度利润表净利润 {fmt2(plan.year_net_profit)}
            </span>
            <span className="flex-1" />
            {plan.carried ? (
              <button onClick={doReverseAnnual} className="px-2 py-1 rounded border border-ink-300 text-[12px] bg-white inline-flex items-center gap-1">
                <RefreshCw size={11} />撤销年结
              </button>
            ) : (
              <button onClick={doCarry} disabled={!plan.precheck?.ok}
                className="px-2 py-1 rounded bg-brand-700 text-white text-[12px] inline-flex items-center gap-1 disabled:opacity-50">
                <ArrowRightLeft size={11} />年度结转
              </button>
            )}
          </div>

          {plan.carry_profit !== plan.year_net_profit && (
            <div className="mb-2 border rounded px-2 py-1 bg-amber-50 border-amber-200 text-amber-800 text-[11px]">
              4103 的余额（{fmt2(plan.carry_profit)}）与本年度利润表的净利润（{fmt2(plan.year_net_profit)}）**不相等** ——
              说明 4103 里还含着**以前年度没有结转到 4104 的利润**。这两个数本来就不该相等的时候，这个差额就是证据。
            </div>
          )}

          {!plan.precheck?.ok && (
            <div className="mb-2 border rounded px-2 py-2 bg-red-50 border-red-200 text-red-700 text-[11px]">
              <div className="font-medium mb-1">还不能年结，差这几件事：</div>
              <ul className="list-disc list-inside space-y-1">
                {(plan.precheck?.problems || []).map((p: any, i: number) => (
                  <li key={i}>
                    <b>{p.code}</b>：{p.message}
                    {p.hint && <div className="text-red-600/80 ml-4">{p.hint}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.lines?.length > 0 && (
            <div className="mb-2">
              <div className="text-slate-500 mb-1">将要生成的分录（{plan.carried ? '已年结时的样子' : '预览'}）：</div>
              <table className="w-full text-[11px] border border-ink-200">
                <thead className="text-slate-400 bg-ink-50">
                  <tr>
                    <th className="text-left px-2 py-1 font-normal">科目</th>
                    <th className="text-left px-2 py-1 font-normal">摘要</th>
                    <th className="text-right px-2 py-1 font-normal">借方</th>
                    <th className="text-right px-2 py-1 font-normal">贷方</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.lines.map((l: any, i: number) => (
                    <tr key={i} className="border-t border-ink-100">
                      <td className="px-2 py-1">{l.subject_code}</td>
                      <td className="px-2 py-1 text-slate-500">{l.summary}</td>
                      <td className="px-2 py-1 text-right">{l.direction === 'debit' ? fmt(l.amount) : ''}</td>
                      <td className="px-2 py-1 text-right">{l.direction === 'credit' ? fmt(l.amount) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 利润分配 */}
          <div className="border-t border-ink-200 pt-2">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="font-medium">利润分配</span>
              {dist && (
                <span className="text-[11px] text-slate-500">
                  可分配 {dist.distributable?.deficit ? '累计亏损（无' : fmt2(dist.distributable?.available)}
                  {dist.distributable?.deficit ? '可分配利润）' : ' 元'}
                  {dist.can_distribute
                    ? <span className="ml-2 text-emerald-700">可分配</span>
                    : <span className="ml-2 text-amber-700">不可分配：{dist.blocked_reason}</span>}
                </span>
              )}
              <span className="flex-1" />
              {dist?.distributed && (
                <button onClick={doReverseDist} className="px-2 py-0.5 rounded border border-ink-300 text-[11px] bg-white inline-flex items-center gap-1">
                  <RefreshCw size={11} />撤销分配
                </button>
              )}
            </div>

            {dist?.distributed && (
              <div className="mb-2 text-[11px] text-slate-500">
                已分配凭证 {dist.voucher?.doc_no}（{dist.voucher?.voucher_date}，{fmt2(dist.voucher?.total_debit)}）：
                {(dist.entries || []).map((e: any, i: number) => (
                  <span key={i} className="ml-2">{e.subject_code} {e.subject_name} {e.direction === 'debit' ? '借' : '贷'} {fmt2(e.amount)}</span>
                ))}
                {dist.dist_reverse_reason && <div className="text-amber-700">上次撤销理由：{dist.dist_reverse_reason}</div>}
              </div>
            )}

            {dist?.can_distribute && !dist?.distributed && (
              <div>
                {items.map((it, i) => (
                  <div key={i} className="flex items-center gap-2 mb-1">
                    <select className="border border-ink-300 rounded px-2 py-1 text-[11px]" value={it.subject_code}
                      onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, subject_code: e.target.value } : x)))}>
                      <option value="">选择目标科目</option>
                      {(dist.subjects || []).map((s: any) => (
                        <option key={s.code} value={s.code}>
                          {s.code} {s.name}（{s.category === 'equity' ? '权益' : '负债'}）
                        </option>
                      ))}
                    </select>
                    <input className="border border-ink-300 rounded px-2 py-1 text-[11px] w-28" placeholder="金额" value={it.amount}
                      onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                    <input className="border border-ink-300 rounded px-2 py-1 text-[11px] flex-1" placeholder="摘要（可空）" value={it.label}
                      onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                    {items.length > 1 && (
                      <button className="text-slate-400 text-[11px]" onClick={() => setItems(items.filter((_, j) => j !== i))}>删除</button>
                    )}
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <button className="px-2 py-1 rounded border border-ink-300 text-[11px] bg-white"
                    onClick={() => setItems([...items, { subject_code: '', amount: '', label: '' }])}>+ 加一项</button>
                  <button className="px-2 py-1 rounded bg-brand-700 text-white text-[11px]" onClick={doDistribute}>执行分配</button>
                  <span className="text-[11px] text-slate-400">
                    合计 {fmt2(items.reduce((s, x) => s + (Number(x.amount) || 0), 0))} —— 不得超过可分配余额
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}


// ===========================================================================
// 五、经营分析（账上 vs 业务，差异如实展示）
// ===========================================================================

function Operating({ period, onErr }: any) {
  const [data, setData] = useState<any>(null)
  useEffect(() => {
    if (!period) return
    api.get('/reports/operating', { period }).then((r: any) => setData(r.data || r)).catch((e: any) => onErr(e.message))
  }, [period])
  if (!data) return <div className="text-[12px] text-slate-500">选择期间后加载…</div>
  const b = data.on_books || {}
  const z = data.on_biz || {}
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {[
          ['营业收入（账）', b.revenue], ['营业成本（账）', b.cost],
          ['毛利（账）', b.gross_profit], ['毛利率（账）', b.gross_margin, '%']
        ].map(([label, v, unit]: any) => (
          <div key={label} className="bg-white border border-ink-200 rounded px-3 py-2">
            <div className="text-[11px] text-slate-400">{label}</div>
            <div className="text-[15px] font-medium tabular-nums">{v === null || v === undefined ? '—' : Number(v).toFixed(2)}{unit || ''}</div>
          </div>
        ))}
      </div>

      <div className="bg-white border border-ink-200 rounded overflow-hidden">
        <div className="px-3 py-2 border-b border-ink-200 text-[12px] font-medium">账实对照（差异<b>不抹平</b>，如实展示）</div>
        <table className="w-full text-[12px]">
          <thead className="bg-ink-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-1.5 font-normal">项目</th>
              <th className="text-right px-3 py-1.5 font-normal">账上（已过账凭证）</th>
              <th className="text-right px-3 py-1.5 font-normal">业务单汇总</th>
              <th className="text-right px-3 py-1.5 font-normal">差异</th>
            </tr>
          </thead>
          <tbody>
            {(data.gaps || []).map((g: any) => (
              <tr key={g.key} className="border-t border-ink-100">
                <td className="px-3 py-1">{g.label}</td>
                <td className="px-3 py-1 text-right tabular-nums">{fmt2(g.books)}</td>
                <td className="px-3 py-1 text-right tabular-nums">{fmt2(g.biz)}</td>
                <td className={`px-3 py-1 text-right tabular-nums ${g.aligned ? 'text-emerald-700' : 'text-amber-700'}`}>{fmt2(g.diff)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-3 py-2 border-t border-ink-200 text-[11px] text-slate-500 leading-relaxed">{data.note}</div>
      </div>

      <div className="bg-white border border-ink-200 rounded p-3 text-[12px]">
        <div className="font-medium mb-2">业务口径明细</div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
          {[
            ['本期发货金额', z.delivery_amount], ['本期发货成本', z.delivery_cost],
            ['本期采购到货金额', z.purchase_amount], ['当前库存金额', z.stock_amount],
            ['应收未收余额', z.ar_open], ['应付未付余额', z.ap_open],
            ['账上银行存款/现金', b.bank_balance], ['账上存货余额', b.inventory_balance]
          ].map(([label, v]: any) => (
            <div key={label} className="flex justify-between border-b border-dashed border-ink-100 py-0.5">
              <span className="text-slate-500">{label}</span>
              <span className="tabular-nums">{fmt2(v)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
