/**
 * ============================================================================
 * 文件标识：src/pages/finance/Accounting.tsx ｜ Accounting（页面，未取到标题）
 * ============================================================================
 * 【职责】Accounting（页面，未取到标题）（页面）
 * 【入口】/finance/accounting
 * 【主要接口】/accounting/meta、/accounting/vouchers、/accounting/vouchers/plan、/accounting/vouchers/generate、/accounting/trial-balance、/accounting/trial-balance/detail
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
 * 页面：Accounting（页面，未取到标题）
 */

import { Fragment, useEffect, useState } from 'react'
import api from '../../api/client'
import { Plus, RefreshCw, Play, CheckCircle2, Ban, ChevronDown, ChevronRight, Calculator } from 'lucide-react'

/**
 * 财务中心（批次 H · 模块 27）：会计科目 / 凭证模板 / 凭证与过账 / 试算平衡表
 *
 * 这一页刻意**没有"新建凭证"按钮** —— 一张凭证的来源由
 * `(biz_type, source_type, source_id)` 唯一决定，页面上只有「生成」。
 * 手工编分录的口子一开，"这张凭证是哪来的"就再也答不出来，
 * 而编出来的账同样是**平的** —— 平账骗得过所有不变量。
 *
 * 三个页签各自要回答一个具体问题：
 *   ① **科目能不能记账？** —— 列表里标出"非叶子科目不可记账"，
 *      因为挂父科目不会报错，只会让「父科目 = 子科目之和」悄悄不成立。
 *   ② **这张凭证为什么是这个金额？** —— 凭证详情把分录、来源单号、
 *      以及**取数键**（`amount_key`）并列显示，能逐行回答"这个数从哪来"。
 *   ③ **账到底平不平？** —— 试算平衡表给借合计、贷合计与差额；
 *      差额不为 0 时**不显示"平"**，而不是四舍五入到两位就当平了。
 */

const fmt = (n: number) => '¥' + Number(n || 0).toFixed(2)

type Tab = 'vouchers' | 'subjects' | 'templates' | 'trial'

const V_STATUS: Record<string, [string, string]> = {
  draft: ['已生成', 'bg-amber-50 text-amber-700 border-amber-200'],
  posted: ['已过账', 'bg-emerald-50 text-emerald-700 border-emerald-200'],
  voided: ['已作废', 'bg-slate-100 text-slate-500 border-ink-300']
}

export default function Accounting() {
  const [tab, setTab] = useState<Tab>('vouchers')
  const [meta, setMeta] = useState<any>({})
  const [err, setErr] = useState('')

  useEffect(() => {
    api.get('/accounting/meta').then((r: any) => setMeta(r.data || r)).catch(() => {})
  }, [])

  const TABS: [Tab, string][] = [
    ['vouchers', '凭证与过账'],
    ['trial', '试算平衡表'],
    ['subjects', '会计科目'],
    ['templates', '凭证模板']
  ]

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-[15px] font-medium title-serif">财务中心</div>
        <div className="text-[11px] text-slate-400">业财一体凭证 · 科目 / 模板 / 过账 / 试算平衡</div>
        {meta.default_tax_rate != null && (
          <span className="text-[11px] text-slate-400 border border-ink-300 rounded px-1.5 py-0.5">
            默认税率 {meta.default_tax_rate}%
          </span>
        )}
      </div>
      {err && <div className="text-[12px] text-red-500 mb-2">{err}</div>}
      <div className="flex gap-1.5 mb-3">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-1.5 rounded border text-[12px] ${tab === k ? 'bg-brand-700 text-white border-brand-700' : 'border-ink-300 text-slate-600 bg-white'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'vouchers' && <Vouchers meta={meta} onErr={setErr} />}
      {tab === 'trial' && <Trial onErr={setErr} />}
      {tab === 'subjects' && <Subjects meta={meta} onErr={setErr} />}
      {tab === 'templates' && <Templates meta={meta} onErr={setErr} />}
    </div>
  )
}

// ===========================================================================
// 凭证与过账
// ===========================================================================

function Vouchers({ meta, onErr }: any) {
  const [rows, setRows] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [period, setPeriod] = useState('')
  const [bizType, setBizType] = useState('')
  const [status, setStatus] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<any>(null)

  // 生成面板：先"试算"再"生成" —— 两者走服务端**同一个函数**，
  // 所以预览与落库必然一致（两处各算一遍一定会分叉）
  const [gen, setGen] = useState<any>({ biz_type: 'purchase_inbound', source_id: '' })
  const [plan, setPlan] = useState<any>(null)

  const load = () => api.get('/accounting/vouchers', { period, biz_type: bizType, status, pageSize: 50 })
    .then((r: any) => { const d = r.data || r; setRows(d.list || []); setTotal(d.total || 0) })
    .catch((e: any) => onErr(e.message))

  useEffect(() => { load() }, [period, bizType, status])

  const openDetail = (id: number) => {
    if (openId === id) { setOpenId(null); setDetail(null); return }
    setOpenId(id)
    api.get(`/accounting/vouchers/${id}`).then((r: any) => setDetail(r.data || r)).catch((e: any) => onErr(e.message))
  }

  const doPlan = () => {
    setPlan(null); onErr('')
    api.post('/accounting/vouchers/plan', { biz_type: gen.biz_type, source_id: Number(gen.source_id) })
      .then((r: any) => setPlan(r.data || r))
      .catch((e: any) => onErr(e.message))
  }
  const doGen = () => {
    api.post('/accounting/vouchers/generate', { biz_type: gen.biz_type, source_id: Number(gen.source_id) })
      .then(() => { setPlan(null); load() })
      .catch((e: any) => onErr(e.message))
  }
  const doPost = (id: number) => api.post(`/accounting/vouchers/${id}/post`)
    .then(() => { load(); if (openId === id) openDetail(id) }).catch((e: any) => onErr(e.message))
  const doVoid = (id: number) => {
    // 作废已过账凭证**必须写理由** —— 账少了钱，得有人知道为什么
    const reason = window.prompt('作废理由（作废已过账凭证会改变当期发生额，必须说明）')
    if (!reason) return
    api.post(`/accounting/vouchers/${id}/void`, { reason })
      .then(() => { load(); if (openId === id) openDetail(id) }).catch((e: any) => onErr(e.message))
  }

  return (
    <div>
      <div className="bg-white border border-ink-200 rounded p-3 mb-3">
        <div className="flex items-center gap-2 mb-2">
          <Calculator size={14} className="text-brand-700" />
          <div className="text-[12px] font-medium">生成凭证（只能从真实业务单生成，来源唯一）</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="border border-ink-300 rounded px-2 py-1 text-[12px]"
            value={gen.biz_type} onChange={(e) => { setGen({ ...gen, biz_type: e.target.value, source_id: '' }); setPlan(null) }}>
            {(meta.biz_types || []).map((b: any) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
          <input className="border border-ink-300 rounded px-2 py-1 text-[12px] w-32" placeholder="来源单据 id"
            value={gen.source_id} onChange={(e) => setGen({ ...gen, source_id: e.target.value })} />
          <button className="px-2.5 py-1 rounded border border-ink-300 text-[12px] bg-white" onClick={doPlan}>试算</button>
          <button className="px-2.5 py-1 rounded bg-brand-700 text-white text-[12px] flex items-center gap-1 disabled:opacity-40"
            disabled={!plan} onClick={doGen}><Play size={12} />生成</button>
          {plan && <span className="text-[11px] text-slate-500">试算 {fmt(plan.total_debit)}（借）＝ {fmt(plan.total_credit)}（贷），可生成</span>}
        </div>
        {plan && (
          <table className="w-full mt-2 text-[11px]">
            <thead className="text-slate-400"><tr><th className="text-left">摘要</th><th className="text-left">科目</th><th className="text-right">借</th><th className="text-right">贷</th></tr></thead>
            <tbody>
              {plan.lines.map((l: any, i: number) => (
                <tr key={i} className="border-t border-ink-100">
                  <td className="py-0.5">{l.summary}</td>
                  <td>{l.subject_code} {l.subject_name}{l.aux_name ? `（${l.aux_name}）` : ''}</td>
                  <td className="text-right">{l.direction === 'debit' ? fmt(l.amount) : ''}</td>
                  <td className="text-right">{l.direction === 'credit' ? fmt(l.amount) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center gap-2 mb-2">
        <input className="border border-ink-300 rounded px-2 py-1 text-[12px] w-28" placeholder="期间 2026-10"
          value={period} onChange={(e) => setPeriod(e.target.value)} />
        <select className="border border-ink-300 rounded px-2 py-1 text-[12px] border-ink-300" value={bizType} onChange={(e) => setBizType(e.target.value)}>
          <option value="">全部场景</option>
          {(meta.biz_types || []).map((b: any) => <option key={b.value} value={b.value}>{b.label}</option>)}
        </select>
        <select className="border border-ink-300 rounded px-2 py-1 text-[12px]" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="draft">已生成（未过账）</option>
          <option value="posted">已过账</option>
          <option value="voided">已作废</option>
        </select>
        <button className="px-2 py-1 rounded border border-ink-300 text-[12px] bg-white" onClick={load}><RefreshCw size={12} /></button>
        <span className="text-[11px] text-slate-400">共 {total} 张</span>
      </div>

      <table className="w-full text-[12px]">
        <thead className="text-slate-400 bg-ink-50">
          <tr>
            <th className="text-left px-2 py-1.5">凭证号</th>
            <th className="text-left px-2 py-1.5">记账日 / 期间</th>
            <th className="text-left px-2 py-1.5">业务场景</th>
            <th className="text-left px-2 py-1.5">来源单据</th>
            <th className="text-right px-2 py-1.5">借方</th>
            <th className="text-right px-2 py-1.5">贷方</th>
            <th className="text-left px-2 py-1.5">状态</th>
            <th className="text-right px-2 py-1.5">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <Fragment key={v.id}>
              <tr className="border-t border-ink-100 hover:bg-ink-50">
                <td className="px-2 py-1.5 cursor-pointer" onClick={() => openDetail(v.id)}>
                  <span className="inline-flex items-center gap-1">
                    {openId === v.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {v.doc_no}
                  </span>
                </td>
                <td className="px-2 py-1.5">{v.voucher_date}<span className="text-slate-400"> / {v.period}</span></td>
                <td className="px-2 py-1.5">{(meta.biz_types || []).find((b: any) => b.value === v.biz_type)?.label || v.biz_type}</td>
                <td className="px-2 py-1.5 text-slate-500">{v.source_doc_no}<span className="text-slate-400">（{v.entry_count} 行）</span></td>
                <td className="px-2 py-1.5 text-right">{fmt(v.total_debit)}</td>
                <td className="px-2 py-1.5 text-right">{fmt(v.total_credit)}</td>
                <td className="px-2 py-1.5">
                  <span className={`text-[10px] border rounded px-1 py-0.5 ${V_STATUS[v.status]?.[1] || ''}`}>{V_STATUS[v.status]?.[0] || v.status}</span>
                  {Math.abs(v.total_debit - v.total_credit) > 0.005 && <span className="text-[10px] text-red-600 ml-1">不平</span>}
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  {v.status === 'draft' && (
                    <button className="text-[11px] text-brand-700 inline-flex items-center gap-0.5" onClick={() => doPost(v.id)}>
                      <CheckCircle2 size={11} />过账
                    </button>
                  )}
                  {v.status !== 'voided' && (
                    <button className="text-[11px] text-slate-500 ml-2 inline-flex items-center gap-0.5" onClick={() => doVoid(v.id)}>
                      <Ban size={11} />作废
                    </button>
                  )}
                </td>
              </tr>
              {openId === v.id && detail && (
                <tr className="bg-ink-50">
                  <td colSpan={8} className="px-3 py-2">
                    <div className="text-[11px] text-slate-500 mb-1">
                      来源：{detail.source_type}#{detail.source_id} · {detail.source_doc_no}
                      {detail.posted_at && ` · 过账于 ${detail.posted_at}`}
                      {detail.void_reason && ` · 作废理由：${detail.void_reason}`}
                    </div>
                    <table className="w-full text-[11px]">
                      <thead className="text-slate-400">
                        <tr>
                          <th className="text-left">#</th><th className="text-left">摘要</th><th className="text-left">科目</th>
                          <th className="text-left">辅助核算</th><th className="text-right">借方</th><th className="text-right">贷方</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.entries.map((e: any) => (
                          <tr key={e.id} className="border-t border-ink-200">
                            <td>{e.seq}</td>
                            <td>{e.summary}</td>
                            <td>{e.subject_code} {e.subject_name}</td>
                            <td>{e.aux_name || '—'}</td>
                            <td className="text-right">{e.direction === 'debit' ? fmt(e.amount) : ''}</td>
                            <td className="text-right">{e.direction === 'credit' ? fmt(e.amount) : ''}</td>
                          </tr>
                        ))}
                        <tr className="border-t-2 border-ink-300 font-medium">
                          <td colSpan={4} className="text-right pr-2">合计</td>
                          <td className="text-right">{fmt(detail.total_debit)}</td>
                          <td className="text-right">{fmt(detail.total_credit)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="text-[12px] text-slate-400 py-6 text-center">没有凭证</div>}
    </div>
  )
}

// ===========================================================================
// 试算平衡表
// ===========================================================================

function Trial({ onErr }: any) {
  const [data, setData] = useState<any>(null)
  const [period, setPeriod] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [openCode, setOpenCode] = useState('')
  const [detail, setDetail] = useState<any>(null)
  const [detailErr, setDetailErr] = useState('')

  const load = () => api.get('/accounting/trial-balance', { period, from, to })
    .then((r: any) => setData(r.data || r)).catch((e: any) => onErr(e.message))
  useEffect(() => { load() }, [period, from, to])

  // 逐行展开：点开一个科目，下钻看**它在这个筛选条件下的每一笔分录**。
  // 明细与汇总在后端筛的是同一批凭证（同一个 where），所以
  // 「明细借贷合计 = 汇总行借贷」是必然的 —— 不相等就是缺陷，不是口径差异。
  const toggle = (code: string) => {
    if (openCode === code) { setOpenCode(''); setDetail(null); return }
    setOpenCode(code); setDetail(null); setDetailErr('')
    api.get('/accounting/trial-balance/detail', { period, from, to, subjectCode: code })
      .then((r: any) => setDetail(r.data || r))
      .catch((e: any) => setDetailErr(e.message))
  }
  // 换筛选条件就把展开收起来：否则明细还是上一组条件下的，
  // 而它挂在新的汇总行下面 —— 看起来像是"展开错了"，其实是没重新取数。
  useEffect(() => { setOpenCode(''); setDetail(null); setDetailErr('') }, [period, from, to])

  // 「展开的合计 = 汇总行」—— 展开视图存在的全部意义就是它。不一致时必须当场说，
  // 不能只把两个数字摆在那里让人自己比。
  const consistent = (d: any) => !!d?.summary_row
    && Math.abs(Number(d.total_debit) - Number(d.summary_row.debit)) <= 0.005
    && Math.abs(Number(d.total_credit) - Number(d.summary_row.credit)) <= 0.005

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <input className="border border-ink-300 rounded px-2 py-1 text-[12px] w-28" placeholder="期间 2026-10" value={period} onChange={(e) => setPeriod(e.target.value)} />
        <input className="border border-ink-300 rounded px-2 py-1 text-[12px] w-32" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-[11px] text-slate-400">至</span>
        <input className="border border-ink-300 rounded px-2 py-1 text-[12px] w-32" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="px-2 py-1 rounded border border-ink-300 text-[12px] bg-white" onClick={load}><RefreshCw size={12} /></button>
        {data && (
          <span className={`text-[11px] ${data.balanced ? 'text-emerald-600' : 'text-red-600'}`}>
            {data.balanced ? '试算平衡' : `试算**不平**，差 ${fmt(data.diff)}`}
          </span>
        )}
        {data && <span className="text-[11px] text-slate-400">已过账凭证 {data.voucher_count} 张</span>}
      </div>
      <table className="w-full text-[12px]">
        <thead className="text-slate-400 bg-ink-50">
          <tr>
            <th className="w-6" />
            <th className="text-left px-2 py-1.5">科目编码</th>
            <th className="text-left px-2 py-1.5">科目名称</th>
            <th className="text-left px-2 py-1.5">类别</th>
            <th className="text-right px-2 py-1.5">本期借方</th>
            <th className="text-right px-2 py-1.5">本期贷方</th>
            <th className="text-left px-2 py-1.5">余额方向</th>
            <th className="text-right px-2 py-1.5">余额</th>
          </tr>
        </thead>
        <tbody>
          {(data?.rows || []).map((r: any) => (
            <Fragment key={r.code}>
              <tr className="border-t border-ink-100 cursor-pointer hover:bg-ink-50/60" onClick={() => toggle(r.code)}>
                <td className="px-1 py-1.5 text-slate-400">
                  {openCode === r.code ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </td>
                <td className="px-2 py-1.5">{r.code}</td>
                <td className="px-2 py-1.5">{r.name}</td>
                <td className="px-2 py-1.5 text-slate-500">{r.category}</td>
                <td className="px-2 py-1.5 text-right">{fmt(r.debit)}</td>
                <td className="px-2 py-1.5 text-right">{fmt(r.credit)}</td>
                <td className="px-2 py-1.5">{r.balance_side === 'debit' ? '借' : '贷'}</td>
                <td className="px-2 py-1.5 text-right">{fmt(r.balance_abs)}</td>
              </tr>
              {openCode === r.code && (
                <tr>
                  <td colSpan={8} className="bg-ink-50/40 px-3 py-2">
                    {detailErr && <div className="text-[11px] text-red-500">明细加载失败：{detailErr}</div>}
                    {!detail && !detailErr && <div className="text-[11px] text-slate-400">加载明细…</div>}
                    {detail && (
                      <div>
                        <div className="text-[11px] text-slate-500 mb-1">
                          {detail.subject.code} {detail.subject.name} ·
                          {' '}共 <b>{detail.total_count}</b> 笔分录 / {detail.voucher_count} 张凭证
                          {detail.truncated && <span className="text-amber-700"> · 已截断（只显示前 {detail.limit} 笔）</span>}
                          <span className="ml-2">
                            合计 借 {fmt(detail.total_debit)} / 贷 {fmt(detail.total_credit)}
                            <span className={consistent(detail) ? 'text-emerald-700' : 'text-red-600'}>
                              （{consistent(detail) ? '与汇总行一致' : '与汇总行不一致（展开与汇总筛的应当是同一批凭证）'}）
                            </span>
                          </span>
                        </div>
                        <table className="w-full text-[11px] bg-white border border-ink-200">
                          <thead className="text-slate-400">
                            <tr>
                              <th className="text-left px-2 py-1 font-normal">凭证号</th>
                              <th className="text-left px-2 py-1 font-normal">日期</th>
                              <th className="text-left px-2 py-1 font-normal">期间</th>
                              <th className="text-left px-2 py-1 font-normal">摘要</th>
                              <th className="text-right px-2 py-1 font-normal">借方</th>
                              <th className="text-right px-2 py-1 font-normal">贷方</th>
                              <th className="text-right px-2 py-1 font-normal">
                                余额（{detail.subject.direction === 'debit' ? '借' : '贷'}）
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.rows.map((e: any) => (
                              <tr key={e.entry_id} className="border-t border-ink-100">
                                <td className="px-2 py-1 font-mono">{e.doc_no}</td>
                                <td className="px-2 py-1">{e.voucher_date}</td>
                                <td className="px-2 py-1 text-slate-500">{e.period}</td>
                                <td className="px-2 py-1">{e.summary}</td>
                                <td className="px-2 py-1 text-right">{e.direction === 'debit' ? fmt(e.amount) : ''}</td>
                                <td className="px-2 py-1 text-right">{e.direction === 'credit' ? fmt(e.amount) : ''}</td>
                                <td className="px-2 py-1 text-right">
                                  {fmt(e.running_abs)}
                                  <span className="text-slate-400 ml-1">{e.running_side === 'debit' ? '借' : '贷'}</span>
                                </td>
                              </tr>
                            ))}
                            {!detail.rows.length && (
                              <tr><td colSpan={7} className="px-2 py-2 text-center text-slate-400">该区间此科目没有已过账分录</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {data && (
            <tr className="border-t-2 border-ink-300 font-medium">
              <td /><td colSpan={3} className="text-right px-2 py-1.5 pr-2">合计</td>
              <td className="px-2 py-1.5 text-right">{fmt(data.total_debit)}</td>
              <td className="px-2 py-1.5 text-right">{fmt(data.total_credit)}</td>
              <td colSpan={2} />
            </tr>
          )}
        </tbody>
      </table>
      {data && !data.rows.length && <div className="text-[12px] text-slate-400 py-6 text-center">该区间没有已过账凭证（未过账的不计入账）</div>}
      {data && data.rows.length > 0 && (
        <div className="text-[11px] text-slate-400 mt-2">
          点任意科目行可**逐行展开**它的凭证分录明细。展开与汇总筛的是同一批凭证，
          所以明细合计必须等于该行的借贷 —— 不一致时页面会当场标红，不会把两个不同的数并排摆着。
        </div>
      )}
    </div>
  )
}

// ===========================================================================
// 会计科目
// ===========================================================================

function Subjects({ meta, onErr }: any) {
  const [rows, setRows] = useState<any[]>([])
  const [kw, setKw] = useState('')
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<any>({ code: '', name: '', category: 'asset', direction: 'debit' })

  const load = () => api.get('/accounting/subjects', { keyword: kw, pageSize: 500 })
    .then((r: any) => { const d = r.data || r; setRows(d.rows || []) })
    .catch((e: any) => onErr(e.message))
  useEffect(() => { load() }, [kw])

  const save = () => {
    api.post('/accounting/subjects', form)
      .then(() => { setOpen(false); setForm({ code: '', name: '', category: 'asset', direction: 'debit' }); load() })
      .catch((e: any) => onErr(e.message))
  }
  const stop = (id: number) => api.post(`/accounting/subjects/${id}/status`, { status: 'inactive' })
    .then(load).catch((e: any) => onErr(e.message))

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <input className="border border-ink-300 rounded px-2 py-1 text-[12px] w-48" placeholder="编码或名称" value={kw} onChange={(e) => setKw(e.target.value)} />
        <button className="px-2 py-1 rounded border border-ink-300 text-[12px] bg-white" onClick={load}><RefreshCw size={12} /></button>
        <button className="px-2 py-1 rounded bg-brand-700 text-white text-[12px] flex items-center gap-1" onClick={() => setOpen(true)}><Plus size={12} />新增科目</button>
        <span className="text-[11px] text-slate-400">共 {rows.length} 个 · 只有**叶子科目**能记账</span>
      </div>
      {open && (
        <div className="bg-white border border-ink-200 rounded p-3 mb-3 flex flex-wrap items-center gap-2">
          <input className="border border-ink-300 rounded px-2 py-1 text-[12px] w-28" placeholder="编码" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          <input className="border border-ink-300 rounded px-2 py-1 text-[12px] w-40" placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select className="border border-ink-300 rounded px-2 py-1 text-[12px]" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {(meta.categories || []).map((c: any) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <select className="border border-ink-300 rounded px-2 py-1 text-[12px]" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
            {(meta.directions || []).map((c: any) => <option key={c.value} value={c.value}>余额方向 {c.label}</option>)}
          </select>
          <button className="px-2.5 py-1 rounded bg-brand-700 text-white text-[12px]" onClick={save}>保存</button>
          <button className="px-2.5 py-1 rounded border border-ink-300 text-[12px] bg-white" onClick={() => setOpen(false)}>取消</button>
        </div>
      )}
      <table className="w-full text-[12px]">
        <thead className="text-slate-400 bg-ink-50">
          <tr>
            <th className="text-left px-2 py-1.5">编码</th><th className="text-left px-2 py-1.5">名称</th>
            <th className="text-left px-2 py-1.5">类别</th><th className="text-left px-2 py-1.5">余额方向</th>
            <th className="text-left px-2 py-1.5">可记账</th><th className="text-left px-2 py-1.5">辅助核算</th>
            <th className="text-left px-2 py-1.5">状态</th><th className="text-right px-2 py-1.5">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className="border-t border-ink-100">
              <td className="px-2 py-1.5">{s.code}</td>
              <td className="px-2 py-1.5" style={{ paddingLeft: 8 + (s.level - 1) * 14 }}>{s.name}</td>
              <td className="px-2 py-1.5 text-slate-500">{s.category_label}</td>
              <td className="px-2 py-1.5">{s.direction_label}</td>
              <td className="px-2 py-1.5">{s.is_leaf ? <span className="text-emerald-600">可记账</span> : <span className="text-amber-600">不可（有子科目）</span>}</td>
              <td className="px-2 py-1.5 text-slate-500">{s.aux_type || '—'}</td>
              <td className="px-2 py-1.5">{s.status === 'active' ? '启用' : '停用'}</td>
              <td className="px-2 py-1.5 text-right">
                {s.status === 'active' && (
                  <button className="text-[11px] text-slate-500" onClick={() => stop(s.id)}>停用</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ===========================================================================
// 凭证模板
// ===========================================================================

function Templates({ meta, onErr }: any) {
  const [rows, setRows] = useState<any[]>([])
  useEffect(() => {
    api.get('/accounting/templates').then((r: any) => { const d = r.data || r; setRows(d.rows || []) })
      .catch((e: any) => onErr(e.message))
  }, [])

  return (
    <div>
      <div className="text-[11px] text-slate-500 mb-2">
        模板分录只能引用**封闭的取数键**，没有自由表达式 —— 模板是可被界面编辑的配置，
        能写表达式就等于"配置能改账"，而改账的错不会报错。
      </div>
      {rows.map((t) => (
        <div key={t.id} className="bg-white border border-ink-200 rounded p-3 mb-2">
          <div className="flex items-center gap-2 mb-1">
            <div className="text-[12px] font-medium">{t.name}</div>
            <span className="text-[11px] text-slate-400">{t.code} · 场景 {t.biz_type} · 关联单据 {t.doc_type || '—'}</span>
          </div>
          {t.remark && <div className="text-[11px] text-slate-500 mb-1">{t.remark}</div>}
          <table className="w-full text-[11px]">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left">#</th><th className="text-left">摘要</th><th className="text-left">方向</th>
                <th className="text-left">科目</th><th className="text-left">取数键</th><th className="text-left">辅助核算</th>
              </tr>
            </thead>
            <tbody>
              {t.entries.map((e: any) => (
                <tr key={e.id} className="border-t border-ink-100">
                  <td>{e.seq}</td>
                  <td>{e.summary}</td>
                  <td>{e.direction === 'debit' ? '借' : '贷'}</td>
                  <td>{e.subject_code}</td>
                  <td>
                    {e.amount_key}
                    <span className="text-slate-400 ml-1">
                      {(meta.fact_keys || []).find((f: any) => f.value === e.amount_key)?.label || ''}
                    </span>
                  </td>
                  <td>{e.aux_key || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
