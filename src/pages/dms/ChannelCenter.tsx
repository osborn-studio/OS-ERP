/**
 * ============================================================================
 * 文件标识：src/pages/dms/ChannelCenter.tsx ｜ ChannelCenter（页面，未取到标题）
 * ============================================================================
 * 【职责】ChannelCenter（页面，未取到标题）（页面）
 * 【入口】/dms/channel
 * 【主要接口】/dms/meta、/dealers/overview、/dms/agreements、/master/skus、/master/categories、/dms/agreements/explain
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
 * 页面：ChannelCenter（页面，未取到标题）
 */

import { Fragment, useEffect, useState } from 'react'
import api from '../../api/client'
import { Plus, RefreshCw, Search, BadgePercent, Wallet, ChevronDown, ChevronRight } from 'lucide-react'

/**
 * 渠道中心（批次 G · 模块 26）：协议价档案 + 返利计提 / 试算 / 核销
 *
 * 这一页要回答三个问题，每个问题都在界面上给出**依据**而不是只给结论：
 *
 *   ① **这份协议到底有没有生效？** —— 靠「取价解释」面板：直接调与销售开单
 *      **同一条**取价路径，并把"不带经销商时的价"并列显示，一眼看出压了多少。
 *      只列协议档案是答不出这个问题的：配置正常但周期不对 / 优先级被压，
 *      在列表页上看起来一模一样。
 *   ② **这笔返利为什么是这个数？** —— 逐政策显示 `basis_desc`（如「阶梯命中 ≥5000:1.2%」）。
 *   ③ **核销之后应收动了没有？** —— 核销单同时显示 `ar_offset_amount` 与 `unoffset_amount`，
 *      冲不下的部分单独标出来（口径与销售退货一致：只减不增，冲不下就如实登记）。
 */

const fmt = (n: number) => '¥' + Number(n || 0).toFixed(2)
const pct = (bp: number) => `${(Number(bp || 10000) / 1000).toFixed(1)} 折`

type Tab = 'agreements' | 'rebates' | 'settlements'

export default function ChannelCenter() {
  const [tab, setTab] = useState<Tab>('agreements')
  const [meta, setMeta] = useState<any>({})
  const [dealers, setDealers] = useState<any[]>([])
  const [err, setErr] = useState('')

  useEffect(() => {
    api.get('/dms/meta').then((r: any) => setMeta(r.data || r)).catch(() => {})
    api.get('/dealers/overview', { pageSize: 200 }).then((r: any) => {
      const d = r.data || r
      setDealers(d.list || d.rows || [])
    }).catch(() => {})
  }, [])

  const TABS: [Tab, string][] = [
    ['agreements', '协议价档案'],
    ['rebates', '返利计提与核销'],
    ['settlements', '核销单']
  ]

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-[15px] font-medium title-serif">渠道中心</div>
        <div className="text-[11px] text-slate-400">协议价 / 返利计提与核销</div>
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
      {tab === 'agreements' && <Agreements meta={meta} dealers={dealers} onErr={setErr} />}
      {tab === 'rebates' && <Rebates meta={meta} dealers={dealers} onErr={setErr} />}
      {tab === 'settlements' && <Settlements onErr={setErr} />}
    </div>
  )
}

// ===========================================================================
// 协议价
// ===========================================================================

function Agreements({ meta, dealers, onErr }: any) {
  const [rows, setRows] = useState<any[]>([])
  const [kw, setKw] = useState('')
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<any>({ target_type: 'sku', price_type: 'fixed', min_qty: 1, priority: 100, discount_bp: 9500 })
  const [skus, setSkus] = useState<any[]>([])
  const [cats, setCats] = useState<any[]>([])
  // 取价解释面板
  const [ex, setEx] = useState<any>(null)
  const [exForm, setExForm] = useState<any>({ sku_id: '', dealer_id: '', qty: 1 })

  const load = () => api.get('/dms/agreements', { keyword: kw, pageSize: 50 })
    .then((r: any) => { const d = r.data || r; setRows(d.list || d.rows || []) })
    .catch((e: any) => onErr(e.message))

  useEffect(() => { load() }, [kw])
  useEffect(() => {
    api.get('/master/skus', { pageSize: 300 }).then((r: any) => {
      const d = r.data || r; setSkus(d.list || d.rows || [])
    }).catch(() => {})
    api.get('/master/categories').then((r: any) => { const d = r.data || r; setCats(Array.isArray(d) ? d : d.list || []) }).catch(() => {})
  }, [])

  const save = async () => {
    try {
      const body: any = {
        ...form,
        dealer_id: Number(form.dealer_id),
        target_id: form.target_type === 'all' ? null : Number(form.target_id),
        price: Number(form.price || 0),
        discount_bp: Number(form.discount_bp || 10000),
        min_qty: Number(form.min_qty || 1),
        priority: Number(form.priority ?? 100)
      }
      await api.post('/dms/agreements', body)
      setOpen(false); setForm({ target_type: 'sku', price_type: 'fixed', min_qty: 1, priority: 100, discount_bp: 9500 })
      onErr(''); load()
    } catch (e: any) { onErr(e.message) }
  }

  const toggle = async (row: any) => {
    try {
      await api.post(`/dms/agreements/${row.id}/status`, { status: row.status === 'active' ? 'inactive' : 'active' })
      load()
    } catch (e: any) { onErr(e.message) }
  }

  const explain = async () => {
    if (!exForm.sku_id) return
    try {
      const r: any = await api.get('/dms/agreements/explain', {
        sku_id: Number(exForm.sku_id), dealer_id: exForm.dealer_id ? Number(exForm.dealer_id) : undefined, qty: Number(exForm.qty || 1)
      })
      setEx(r.data || r)
    } catch (e: any) { onErr(e.message) }
  }

  // 今天是否落在合同周期内 —— 列表页直接标出来，避免"配置正常但没生效"看不出来
  const today = new Date().toISOString().slice(0, 10)
  const periodState = (r: any) => {
    if (r.effect_from && today < String(r.effect_from).slice(0, 10)) return ['未开始', 'text-amber-600']
    if (r.effect_to && today > String(r.effect_to).slice(0, 10)) return ['已过期', 'text-slate-400']
    return ['生效期内', 'text-brand-700']
  }

  return (
    <div>
      {/* 取价解释：这条是"协议价真的接进取价链了吗"的唯一证据 */}
      <div className="bg-white border border-ink-300 rounded-lg p-3 mb-3">
        <div className="text-[12px] font-medium mb-2 flex items-center gap-1"><BadgePercent size={13} /> 取价解释（与销售开单同一条取价路径）</div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[11px] text-slate-500">SKU
            <select className="input h-8 ml-1" value={exForm.sku_id} onChange={(e) => setExForm({ ...exForm, sku_id: e.target.value })}>
              <option value="">请选择</option>
              {skus.map((s) => <option key={s.id} value={s.id}>{s.name}（{s.sku_code}）</option>)}
            </select>
          </label>
          <label className="text-[11px] text-slate-500">经销商
            <select className="input h-8 ml-1" value={exForm.dealer_id} onChange={(e) => setExForm({ ...exForm, dealer_id: e.target.value })}>
              <option value="">不带（对照）</option>
              {dealers.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-slate-500">数量
            <input className="input h-8 w-16 ml-1" type="number" value={exForm.qty} onChange={(e) => setExForm({ ...exForm, qty: e.target.value })} />
          </label>
          <button className="btn-primary h-8 px-3 text-[12px]" onClick={explain}>取值</button>
        </div>
        {ex && (
          <div className="mt-2 text-[11px] bg-paper rounded p-2 space-y-0.5">
            <div>命中规则：<b className="text-brand-700">{ex.rule}</b>　单价 <b className="tabular-nums">{ex.price}</b></div>
            {ex.base_without_agreement && (
              <div>不带经销商时：{ex.base_without_agreement.price}（{ex.base_without_agreement.source}）　
                {ex.saved > 0 ? <span className="text-brand-700">协议价低 {ex.saved}</span> : <span className="text-slate-400">无差价</span>}
              </div>
            )}
            <div className="text-slate-500">{(ex.trace || []).join(' → ')}</div>
            {ex.warn && <div className="text-amber-600">{ex.warn}</div>}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 mb-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className="input h-8 pl-8 w-56" placeholder="编码 / 名称 / 经销商" value={kw} onChange={(e) => setKw(e.target.value)} />
        </div>
        <button className="btn-ghost h-8" onClick={load}><RefreshCw size={13} /></button>
        <button className="btn-primary h-8 ml-auto text-[12px]" onClick={() => setOpen(!open)}><Plus size={13} /> 新建协议</button>
      </div>

      {open && (
        <div className="bg-white border border-ink-300 rounded-lg p-3 mb-3 grid grid-cols-2 md:grid-cols-4 gap-2">
          <input className="input h-8 col-span-2" placeholder="协议名称" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select className="input h-8" value={form.dealer_id || ''} onChange={(e) => setForm({ ...form, dealer_id: e.target.value })}>
            <option value="">选择经销商</option>
            {dealers.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select className="input h-8" value={form.target_type} onChange={(e) => setForm({ ...form, target_type: e.target.value, target_id: '' })}>
            {(meta.target_types || []).map((t: any) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          {form.target_type === 'sku' && (
            <select className="input h-8" value={form.target_id || ''} onChange={(e) => setForm({ ...form, target_id: e.target.value })}>
              <option value="">选择 SKU</option>
              {skus.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {form.target_type === 'category' && (
            <select className="input h-8" value={form.target_id || ''} onChange={(e) => setForm({ ...form, target_id: e.target.value })}>
              <option value="">选择品类</option>
              {cats.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <select className="input h-8" value={form.price_type} onChange={(e) => setForm({ ...form, price_type: e.target.value })}>
            {(meta.price_types || []).map((t: any) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          {form.price_type === 'fixed'
            ? <input className="input h-8" type="number" placeholder="协议单价" value={form.price || ''} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            : <input className="input h-8" type="number" placeholder="折扣万分比（9500=95折）" value={form.discount_bp || ''} onChange={(e) => setForm({ ...form, discount_bp: e.target.value })} />}
          <input className="input h-8" type="number" placeholder="起订量" value={form.min_qty || ''} onChange={(e) => setForm({ ...form, min_qty: e.target.value })} />
          <input className="input h-8" type="number" placeholder="优先级（小者先）" value={form.priority ?? ''} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
          <input className="input h-8" type="date" value={form.effect_from || ''} onChange={(e) => setForm({ ...form, effect_from: e.target.value })} />
          <input className="input h-8" type="date" value={form.effect_to || ''} onChange={(e) => setForm({ ...form, effect_to: e.target.value })} />
          <button className="btn-primary h-8 text-[12px]" onClick={save}>保存</button>
        </div>
      )}

      <div className="bg-white border border-ink-300 rounded-lg overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-paper text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">编码 / 名称</th>
              <th className="px-3 py-2 text-left font-medium">经销商</th>
              <th className="px-3 py-2 text-left font-medium">作用对象</th>
              <th className="px-3 py-2 text-right font-medium">价格</th>
              <th className="px-3 py-2 text-right font-medium">起订</th>
              <th className="px-3 py-2 text-left font-medium">合同周期</th>
              <th className="px-3 py-2 text-left font-medium">状态</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const [st, cls] = r.status === 'active' ? periodState(r) : ['已停用', 'text-slate-400']
              return (
                <tr key={r.id} className="border-t border-ink-100">
                  <td className="px-3 py-1.5"><span className="font-mono text-slate-500">{r.code}</span> {r.name}</td>
                  <td className="px-3 py-1.5">{r.dealer_name}</td>
                  <td className="px-3 py-1.5">{r.target_label}{r.target_name ? ` · ${r.target_name}` : ''}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {r.price_type === 'fixed' ? fmt(r.price) : pct(r.discount_bp)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.min_qty}</td>
                  <td className="px-3 py-1.5 text-slate-500">{(r.effect_from || '—').slice(0, 10)} ~ {(r.effect_to || '—').slice(0, 10)}</td>
                  <td className={`px-3 py-1.5 ${cls}`}>{st}</td>
                  <td className="px-3 py-1.5 text-right">
                    <button className="text-[11px] text-slate-500 border border-ink-300 rounded px-2 py-0.5" onClick={() => toggle(r)}>
                      {r.status === 'active' ? '停用' : '启用'}
                    </button>
                  </td>
                </tr>
              )
            })}
            {!rows.length && <tr><td colSpan={8} className="px-3 py-10 text-center text-slate-400">暂无协议价</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ===========================================================================
// 返利：试算 / 计提 / 确认 / 核销
// ===========================================================================

function Rebates({ dealers, onErr }: any) {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7))
  const [dealerId, setDealerId] = useState('')
  const [plan, setPlan] = useState<any>(null)
  const [rows, setRows] = useState<any[]>([])
  const [busy, setBusy] = useState(false)

  const loadRows = () => api.get('/dms/rebates', { period, dealer_id: dealerId || undefined, pageSize: 100 })
    .then((r: any) => { const d = r.data || r; setRows(d.list || d.rows || []) })
    .catch((e: any) => onErr(e.message))
  useEffect(() => { loadRows() }, [period, dealerId])

  const doPlan = async () => {
    if (!dealerId) return onErr('请先选择经销商')
    try {
      const r: any = await api.post('/dms/rebates/plan', { dealer_id: Number(dealerId), period })
      setPlan(r.data || r); onErr('')
    } catch (e: any) { onErr(e.message) }
  }
  const doAccrue = async () => {
    if (!dealerId) return onErr('请先选择经销商')
    setBusy(true)
    try {
      const r: any = await api.post('/dms/rebates/accrue', { dealer_id: Number(dealerId), period })
      const d = r.data || r
      onErr(`计提完成：新建 ${d.created} / 更新 ${d.updated}${d.skipped?.length ? ` / 跳过 ${d.skipped.length}（已确认或已核销的一律不覆盖）` : ''}`)
      loadRows()
    } catch (e: any) { onErr(e.message) } finally { setBusy(false) }
  }
  const doConfirm = async (id: number) => {
    try { await api.post(`/dms/rebates/${id}/confirm`, {}); loadRows() } catch (e: any) { onErr(e.message) }
  }
  const doSettle = async () => {
    if (!dealerId) return onErr('请先选择经销商')
    if (!confirm(`确认核销 ${period} 已确认的返利并冲减该客户应收？`)) return
    setBusy(true)
    try {
      const r: any = await api.post('/dms/rebates/settle', { dealer_id: Number(dealerId), period })
      const d = r.data || r
      onErr(`核销单 ${d.doc_no}：返利 ${fmt(d.total_amount)} · 冲应收 ${fmt(d.ar_offset_amount)}` +
        (Number(d.unoffset_amount) > 0 ? ` · **未冲减 ${fmt(d.unoffset_amount)}**（应收余额不足，未生成负数应收）` : ''))
      loadRows()
    } catch (e: any) { onErr(e.message) } finally { setBusy(false) }
  }

  const ST: any = { pending: '待核算', confirmed: '已确认', paid: '已核销' }
  return (
    <div>
      <div className="flex flex-wrap items-end gap-2 mb-3">
        <label className="text-[11px] text-slate-500">期间
          <input className="input h-8 ml-1 w-32" placeholder="YYYY-MM" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </label>
        <label className="text-[11px] text-slate-500">经销商
          <select className="input h-8 ml-1" value={dealerId} onChange={(e) => setDealerId(e.target.value)}>
            <option value="">全部</option>
            {dealers.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <button className="btn-ghost h-8 text-[12px]" onClick={doPlan}>试算</button>
        <button className="btn-ghost h-8 text-[12px]" onClick={doAccrue} disabled={busy}>计提</button>
        <button className="btn-primary h-8 text-[12px]" onClick={doSettle} disabled={busy}><Wallet size={13} /> 核销并冲应收</button>
      </div>

      {plan && (
        <div className="bg-white border border-ink-300 rounded-lg p-3 mb-3">
          <div className="text-[12px] font-medium mb-1.5">试算结果（{plan.period} · 合计 {fmt(plan.total_amount)}）</div>
          <div className="space-y-1">
            {(plan.items || []).map((it: any) => (
              <div key={it.policy_id} className="text-[11px] bg-paper rounded p-2 flex items-start gap-2">
                <span className={it.matched ? 'text-brand-700' : 'text-slate-400'}>{it.matched ? '命中' : '未命中'}</span>
                <span className="text-ink-900">{it.policy_name}</span>
                <span className="text-slate-500">{it.policy_type_name}</span>
                <span className="text-slate-500">{it.basis_desc}</span>
                <span className="ml-auto tabular-nums text-brand-700">{fmt(it.rebate_amount)}</span>
              </div>
            ))}
            {!(plan.items || []).length && <div className="text-[11px] text-slate-400">这一期没有适用政策</div>}
          </div>
        </div>
      )}

      <div className="bg-white border border-ink-300 rounded-lg overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-paper text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">经销商</th>
              <th className="px-3 py-2 text-left font-medium">期间</th>
              <th className="px-3 py-2 text-left font-medium">政策</th>
              <th className="px-3 py-2 text-left font-medium">计返基数</th>
              <th className="px-3 py-2 text-right font-medium">净销售</th>
              <th className="px-3 py-2 text-right font-medium">费率</th>
              <th className="px-3 py-2 text-right font-medium">返利额</th>
              <th className="px-3 py-2 text-right font-medium">冲应收</th>
              <th className="px-3 py-2 text-left font-medium">状态</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-ink-100">
                <td className="px-3 py-1.5">{r.dealer_name}</td>
                <td className="px-3 py-1.5">{r.period}</td>
                <td className="px-3 py-1.5">{r.policy_name}</td>
                <td className="px-3 py-1.5 text-slate-500">{r.commission_basis || r.calc_basis}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.net_amount}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.rebate_rate}%</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-brand-700">{fmt(r.rebate_amount)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.settlement_id ? fmt(r.ar_offset_amount) : '—'}</td>
                <td className="px-3 py-1.5">{ST[r.status] || r.status}</td>
                <td className="px-3 py-1.5 text-right">
                  {r.status === 'pending' && (
                    <button className="text-[11px] text-slate-500 border border-ink-300 rounded px-2 py-0.5" onClick={() => doConfirm(r.id)}>确认</button>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={10} className="px-3 py-10 text-center text-slate-400">暂无返利记录</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ===========================================================================
// 核销单
// ===========================================================================

function Settlements({ onErr }: any) {
  const [rows, setRows] = useState<any[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<any>(null)

  useEffect(() => {
    api.get('/dms/settlements', { pageSize: 50 })
      .then((r: any) => { const d = r.data || r; setRows(d.list || d.rows || []) })
      .catch((e: any) => onErr(e.message))
  }, [])

  const open = async (id: number) => {
    if (openId === id) { setOpenId(null); setDetail(null); return }
    try {
      const r: any = await api.get(`/dms/settlements/${id}`)
      setDetail(r.data || r); setOpenId(id)
    } catch (e: any) { onErr(e.message) }
  }

  return (
    <div className="bg-white border border-ink-300 rounded-lg overflow-hidden">
      <table className="w-full text-[12px]">
        <thead className="bg-paper text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left font-medium">核销单号</th>
            <th className="px-3 py-2 text-left font-medium">经销商</th>
            <th className="px-3 py-2 text-left font-medium">期间</th>
            <th className="px-3 py-2 text-right font-medium">返利总额</th>
            <th className="px-3 py-2 text-right font-medium">冲减应收</th>
            <th className="px-3 py-2 text-right font-medium">未冲减</th>
            <th className="px-3 py-2 text-left font-medium">状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            // key 必须给在 **Fragment** 上（列表里返回两个兄弟节点，给了内层 tr 也没用：
            // React 认的是最外层元素，缺 key 会退化成"按下标复用"，
            // 展开详情时相邻行的展开状态会串到别人身上）
            <Fragment key={s.id}>
              <tr className="border-t border-ink-100 cursor-pointer" onClick={() => open(s.id)}>
                <td className="px-3 py-1.5 font-mono text-slate-600">
                  {openId === s.id ? <ChevronDown size={12} className="inline" /> : <ChevronRight size={12} className="inline" />} {s.doc_no}
                </td>
                <td className="px-3 py-1.5">{s.dealer_name}</td>
                <td className="px-3 py-1.5">{s.period}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(s.total_amount)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-brand-700">{fmt(s.ar_offset_amount)}</td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${Number(s.unoffset_amount) > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
                  {fmt(s.unoffset_amount)}
                </td>
                <td className="px-3 py-1.5">{s.status_label || s.status}</td>
              </tr>
              {openId === s.id && detail && (
                <tr className="bg-paper">
                  <td colSpan={7} className="px-4 py-2">
                    <div className="text-[11px] text-slate-500 mb-1">
                      {detail.unoffset_reason || '全部返利已冲减应收'}
                    </div>
                    <table className="w-full text-[11px]">
                      <thead className="text-slate-400">
                        <tr>
                          <th className="text-left font-normal">返利单</th>
                          <th className="text-left font-normal">政策</th>
                          <th className="text-right font-normal">核销额</th>
                          <th className="text-right font-normal">其中冲应收</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.items || []).map((i: any) => (
                          <tr key={i.id}>
                            <td>#{i.rebate_id}</td>
                            <td>{i.policy_name}</td>
                            <td className="text-right tabular-nums">{fmt(i.amount)}</td>
                            <td className="text-right tabular-nums">{fmt(i.ar_offset_amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {!rows.length && <tr><td colSpan={7} className="px-3 py-10 text-center text-slate-400">暂无核销单</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
