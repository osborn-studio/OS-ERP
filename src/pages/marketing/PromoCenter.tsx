/**
 * ============================================================================
 * 文件标识：src/pages/marketing/PromoCenter.tsx ｜ PromoCenter（页面，未取到标题）
 * ============================================================================
 * 【职责】PromoCenter（页面，未取到标题）（页面）
 * 【入口】/marketing/promo
 * 【主要接口】/master/skus
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
 * 页面：PromoCenter（页面，未取到标题）
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Card, SectionTitle, StatCard, Table, Empty, Modal, Field, Tabs,
  Pagination, fmtInt, toast
} from '../../components/ui'
import { FilterBar, Sel, Inp } from '../../components/DataPage'
import {
  PROMO_META, PROMO_OVERVIEW, PROMO_AUDIT,
  PROMO_LEVELS, PROMO_LEVEL_UPDATE,
  PROMO_CAMPAIGNS, PROMO_CAMPAIGN_CREATE, PROMO_CAMPAIGN_STATUS,
  PROMO_LIST, PROMO_DETAIL, PROMO_CREATE, PROMO_VALIDATE, PROMO_STATUS, PROMO_DELETE,
  PROMO_QUOTE, PROMO_EXPLAIN,
  PROMO_COUPONS, PROMO_COUPON_DETAIL, PROMO_COUPON_CREATE, PROMO_COUPON_STATUS,
  PROMO_COUPON_ISSUE, PROMO_COUPON_EXPIRE,
  PROMO_INSTANCES, PROMO_INSTANCE_VOID,
  PROMO_MEMBERS, PROMO_MEMBER_DETAIL, PROMO_MEMBER_LEDGER,
  PROMO_MEMBER_POINTS, PROMO_MEMBER_RECHARGE, PROMO_MEMBER_BALANCE,
  PROMO_MEMBER_LEVEL, PROMO_MEMBER_SYNC, PROMO_MEMBER_ISSUE,
  PROMO_STATUS_CLS, COUPON_STATUS_CLS, INSTANCE_STATUS_CLS, INSTANCE_STATUS_LABEL,
  pctText, levelPctText, methodText,
  type PromoMeta, type PromoOverview, type PromotionRow, type PromotionDetail,
  type CampaignRow, type CouponTemplate, type CouponInstance,
  type MemberAccountRow, type MemberDetail, type QuoteResult, type MemberLevel
} from '../../api/promo'
import { RefreshCw, Plus, Play, Pause, Trash2, Ticket, Ban, AlertTriangle, Calculator, Users2, CheckCircle2 } from 'lucide-react'
import api from '../../api/client'

/**
 * 营销中心（模块 18：促销与会员）。
 *
 * 这一页存在的意义是把**算钱的顺序**和**余额的真相**摊开给人看，而不是只给一个"优惠了多少"。
 * 界面上钉死的五条口径（与后端 `checkout.js` / `promotion.js` / `member.js` 一一对应）：
 *
 *   ① 算钱顺序固定：会员折扣（作用于原价）→ 促销（在会员价上叠加）→ 积分（只作用于最终成交价）。
 *      所以试算器把金额拆成**四段**逐段显示，而不是合并成一个优惠额 ——
 *      合并之后没人看得出"这 30 块是会员折的还是促销减的"，退货时的退款策略也没法解释。
 *   ② 优惠必须摊到行：试算结果带 `line_discounts`，界面按行展示三段优惠。
 *      只给整单优惠额回答不了"减在哪几行"，退货就只能按比例反推，反推会差几分钱。
 *   ③ 余额不是真相，流水才是：会员详情的积分/储值都列到流水，并显示每行的 `balance_after`。
 *   ④ **券默认不自动使用**：试算器里"用哪张券"必须由人显式勾选，或显式勾选"自动选券"。
 *      默认什么都不选 = 一张都不用。这条是防事故的：曾经一句普通试算会顺手把客户券包用光。
 *   ⑤ 券的 `type`/`value` 只作展示 —— 真正算钱的是它绑定的那张促销。界面要写清楚，
 *      否则运维会以为"改券的金额就能改优惠"。
 */
export default function PromoCenter() {
  const [tab, setTab] = useState<'overview' | 'campaign' | 'promotion' | 'coupon' | 'member' | 'quote'>('overview')
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])

  // 字典只取一次 —— 它是编辑器与各处下拉的枚举来源，全页共用一份，避免各处自己维护导致漂移
  const [meta, setMeta] = useState<PromoMeta | null>(null)
  useEffect(() => {
    PROMO_META().then(setMeta).catch((e) => toast(e.message, 'error'))
  }, [])

  const [ov, setOv] = useState<PromoOverview | null>(null)
  useEffect(() => {
    PROMO_OVERVIEW().then(setOv).catch(() => {})
  }, [tick])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <SectionTitle
          title="营销中心（促销与会员）"
          desc="算钱顺序：会员折扣 → 促销 → 积分 · 优惠摊到行 · 余额看流水 · 券默认不自动使用 · 券的金额只作展示"
        />
        <button className="btn-ghost" onClick={reload}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      <Tabs
        tabs={[
          { key: 'overview', label: '总览' },
          { key: 'campaign', label: '活动' },
          { key: 'promotion', label: '促销', count: ov?.promotions?.total },
          { key: 'coupon', label: '券', count: ov?.coupons?.total },
          { key: 'member', label: '会员', count: ov?.members?.accounts },
          { key: 'quote', label: '试算器' }
        ]}
        value={tab}
        onChange={(k) => setTab(k as any)}
      />

      {tab === 'overview' && <OverviewTab ov={ov} meta={meta} tick={tick} />}
      {tab === 'campaign' && <CampaignTab tick={tick} onChanged={reload} />}
      {tab === 'promotion' && <PromotionTab meta={meta} tick={tick} onChanged={reload} />}
      {tab === 'coupon' && <CouponTab meta={meta} tick={tick} onChanged={reload} />}
      {tab === 'member' && <MemberTab meta={meta} tick={tick} onChanged={reload} />}
      {tab === 'quote' && <QuoteTab meta={meta} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 分 → 元文本。后端金额一律是「分」，前端只看元，转换只在这一处做 */
const yuan = (cents: any, digits = 2) => (Number(cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
/** 元文本 → 分（用户输入用元，提交前必须转分；漏转会让金额差 100 倍且不报错） */
const toCents = (v: any) => Math.round(Number(v || 0) * 100)

const pill = (map: Record<string, string>, v: string, label?: string) =>
  `inline-block px-2 py-[1px] rounded border text-[12px] whitespace-nowrap ${map[v] || 'text-slate-600 bg-slate-50 border-slate-200'}`

/** 促销状态多了个 expired，补进颜色表（不补会一律落成默认灰，看不出"已过期"与"已停用"的区别） */
const PROMO_CLS: Record<string, string> = { ...PROMO_STATUS_CLS, expired: 'text-amber-700 bg-amber-50 border-amber-200' }

const CAMPAIGN_CLS: Record<string, string> = {
  active: 'text-green-700 bg-green-50 border-green-200',
  ended: 'text-slate-500 bg-slate-50 border-slate-200'
}

/** 统一的加载/错误小 hook：这一页各页签都是"取一份数据 → 渲染"，不需要全局状态库 */
function useAsync<T>(fn: () => Promise<T>, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(() => {
    setLoading(true)
    setError(null)
    fn()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => { run() }, [run])
  return { data, loading, error, reload: run, setData }
}

/** 一行"标签 / 值"，详情弹窗里密集使用 */
function KV({ k, v, tone }: { k: string; v: React.ReactNode; tone?: 'red' | 'green' | 'muted' }) {
  const cls = tone === 'red' ? 'text-red-600' : tone === 'green' ? 'text-green-600' : tone === 'muted' ? 'text-slate-400' : 'text-slate-800'
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="text-[12px] text-slate-500 shrink-0">{k}</span>
      <span className={`text-[13px] tabular-nums text-right ${cls}`}>{v}</span>
    </div>
  )
}

// ===========================================================================
// 一、总览
// ===========================================================================

function OverviewTab({ ov, meta, tick }: { ov: PromoOverview | null; meta: PromoMeta | null; tick: number }) {
  const { data: audit } = useAsync<any>(() => PROMO_AUDIT(), [tick])
  const { data: levels } = useAsync<MemberLevel[]>(() => PROMO_LEVELS(), [])

  if (!ov) return <Card>加载中…</Card>

  // 防御性取值：`by_level` 曾经因为后端漏了 `.all()` 而变成一个对象，
  // 这时 `levelRows.map` 会抛异常 —— 没有错误边界的话**整页白屏**，
  // 表现是"点哪个页签都不动"，排查成本远高于这里多写一句 Array.isArray。
  const levelRows: { level_code: string; level_name: string; c: number }[] =
    Array.isArray(ov.members?.by_level) ? (ov.members.by_level as any) : []
  const levelMax = Math.max(1, ...levelRows.map((r) => Number(r.c || 0)))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="促销活动" value={fmtInt(ov.promotions.total)} tone="brand"
          sub={`生效 ${ov.promotions.active} · 自动 ${ov.promotions.automatic} · 独占 ${ov.promotions.exclusive}`} />
        <StatCard label="券发行量" value={fmtInt(ov.coupons.total)}
          sub={`未使用 ${ov.coupons.unused} · 已核销 ${ov.coupons.used} · 过期 ${ov.coupons.expired} · 作废 ${ov.coupons.voided}`} />
        <StatCard label="会员积分余额" value={fmtInt(ov.members.points_balance)} tone="amber"
          sub={`会员 ${fmtInt(ov.members.accounts)} 人 · 储值 ¥${yuan(ov.members.balance_cents)}`} />
        <StatCard label="促销累计优惠" value={`¥${yuan(ov.usage.promotion_discount)}`} tone="green"
          sub={`命中 ${fmtInt(ov.usage.orders_hit)} 张订单 · 累计消费 ¥${yuan(ov.members.total_spent_cents)}`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 会员等级分布：一眼看出"高等级有没有人" —— seed 或真实数据里某一档为空时，
            券与折扣的演示线就是断的，这里能立刻看见 */}
        <Card>
          <SectionTitle title="会员等级分布" desc="每个等级必须都有样本，否则该等级的折扣演示线是断的" />
          {levelRows.length === 0 ? (
            <Empty text="暂无会员" />
          ) : (
            <div className="space-y-2.5 pt-1">
              {levelRows.map((r) => {
                const lv = (levels || []).find((l) => l.code === r.level_code)
                return (
                  <div key={r.level_code} className="flex items-center gap-3">
                    <span className="w-16 text-[12px] text-slate-600 shrink-0">{r.level_name || r.level_code}</span>
                    <div className="flex-1 h-4 bg-slate-100 rounded overflow-hidden">
                      <div className="h-full rounded bg-brand-500/70" style={{ width: `${(Number(r.c || 0) / levelMax) * 100}%` }} />
                    </div>
                    <span className="w-10 text-right text-[13px] tabular-nums text-slate-700">{fmtInt(r.c)}</span>
                    <span className="w-32 text-right text-[11px] text-slate-400 whitespace-nowrap">{lv ? levelPctText(lv.discount_pct) : ''}</span>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {/* 自洽审计：营销域最容易出的错是"余额与流水不一致"，而它**不会报错**，
            只会在下一次抵扣时凭空少一截。把检查摆在界面上，是唯一能提前发现的办法 */}
        <Card>
          <SectionTitle
            title="自洽审计"
            desc="余额=流水合计 · 券状态与时间自洽 · 用量计数=登记条数"
            right={audit && (
              <span className={`tag ${audit.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                {audit.ok ? '全部通过' : '发现异常'}
              </span>
            )}
          />
          {!audit ? (
            <Empty text="加载中…" />
          ) : (
            <div className="space-y-1">
              <AuditRow label="会员积分余额 = 流水合计" bad={Number(audit.member?.points_drift || 0)} />
              <AuditRow label="会员储值余额 = 流水合计" bad={Number(audit.member?.balance_drift || 0)} />
              <AuditRow label="累计积分 ≥ 正变动之和" bad={Number(audit.member?.total_drift || 0)}
                hint="人工改级会把累计门槛抬到达标线（无流水支撑），故只要求不低于" />
              <AuditRow label="已核销券必须有核销时间" bad={Number(audit.coupon?.bad_used || 0)} />
              <AuditRow label="未使用券不得有核销时间" bad={Number(audit.coupon?.bad_unused || 0)} />
              <AuditRow label="券发行量 = 实例数（防超发）" bad={Number(audit.coupon?.over_issued || 0)} />
              <AuditRow label="促销用量计数 = 使用登记条数" bad={Number(audit.promotion?.counter_drift || 0)} />
              <AuditRow label="优惠留痕均指向真实促销" bad={Number(audit.promotion?.orphan_adjustment || 0)} />
              <AuditRow label="客户等级冗余列一致" bad={Number(audit.customer_level_drift || 0)} />
            </div>
          )}
        </Card>
      </div>

      {meta && (
        <Card>
          <SectionTitle title="全局口径（settings）" desc="这些是算钱时的上限与换算率，改了会立刻影响所有试算" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-1">
            {meta.settings.map((s) => (
              <KV key={s.key} k={s.key} v={s.value} />
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

function AuditRow({ label, bad, hint }: { label: string; bad: number; hint?: string }) {
  const ok = bad === 0
  return (
    <div className="flex items-start gap-2 py-[3px]">
      {ok ? <CheckCircle2 size={14} className="text-green-600 mt-[3px] shrink-0" /> : <AlertTriangle size={14} className="text-red-600 mt-[3px] shrink-0" />}
      <div className="min-w-0">
        <span className="text-[13px] text-slate-700">{label}</span>
        {!ok && <span className="text-[12px] text-red-600 ml-2">{bad} 条不符</span>}
        {hint && <div className="text-[11px] text-slate-400">{hint}</div>}
      </div>
    </div>
  )
}

// ===========================================================================
// 二、活动
// ===========================================================================

function CampaignTab({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('')
  const { data, loading, reload } = useAsync<CampaignRow[]>(
    () => PROMO_CAMPAIGNS({ keyword: keyword || undefined, status: status || undefined }),
    [keyword, status, tick]
  )
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ code: '', name: '', description: '', starts_at: '', ends_at: '' })
  const [saving, setSaving] = useState(false)

  const rows = data || []

  const submit = async () => {
    if (!form.code.trim() || !form.name.trim()) return toast('活动编码与名称必填', 'error')
    setSaving(true)
    try {
      await PROMO_CAMPAIGN_CREATE({
        code: form.code.trim(), name: form.name.trim(), description: form.description || null,
        starts_at: form.starts_at || null, ends_at: form.ends_at || null
      })
      toast('活动已创建')
      setOpen(false)
      setForm({ code: '', name: '', description: '', starts_at: '', ends_at: '' })
      reload(); onChanged()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (r: CampaignRow) => {
    try {
      await PROMO_CAMPAIGN_STATUS(r.id, r.status === 'active' ? 'ended' : 'active')
      toast(r.status === 'active' ? '活动已结束' : '活动已启用')
      reload(); onChanged()
    } catch (e: any) { toast(e.message, 'error') }
  }

  return (
    <div>
      <FilterBar onReset={() => { setKeyword(''); setStatus('') }}>
        <Inp value={keyword} onChange={setKeyword} placeholder="活动编码 / 名称" w={180} />
        <Sel value={status} onChange={setStatus} w={120} placeholder="全部状态"
          options={[{ value: 'active', label: '进行中' }, { value: 'ended', label: '已结束' }]} />
        <button className="btn-primary btn-sm ml-auto" onClick={() => setOpen(true)}>
          <Plus size={14} /> 新建活动
        </button>
      </FilterBar>

      <Card pad={false}>
        <Table
          loading={loading}
          data={rows}
          empty="暂无活动"
          columns={[
            { key: 'code', title: '编码', width: 130 },
            { key: 'name', title: '活动名称' },
            { key: 'starts_at', title: '开始', width: 160, render: (r) => r.starts_at || '不限' },
            { key: 'ends_at', title: '结束', width: 160, render: (r) => r.ends_at || '不限' },
            { key: 'promotion_count', title: '促销 / 生效', width: 110, align: 'center', render: (r) => `${r.promotion_count ?? 0} / ${r.active_count ?? 0}` },
            { key: 'used_amount', title: '累计优惠', width: 110, align: 'right', render: (r) => `¥${yuan(r.used_amount)}` },
            { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(CAMPAIGN_CLS, r.status)}>{r.status === 'active' ? '进行中' : '已结束'}</span> },
            {
              key: 'op', title: '操作', width: 90, render: (r) => (
                <button className="btn-ghost btn-sm" onClick={() => toggle(r)}>
                  {r.status === 'active' ? <><Pause size={13} /> 结束</> : <><Play size={13} /> 启用</>}
                </button>
              )
            }
          ]}
        />
      </Card>

      <Modal
        open={open}
        title="新建活动"
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>取消</button>
            <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '保存中…' : '保存'}</button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="活动编码" required hint="唯一；建议 大促编码规则"><input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="如 CMP-2026-11" /></Field>
          <Field label="活动名称" required><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 双十一大促" /></Field>
          <Field label="开始时间" hint="留空表示不限"><input className="input" type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} /></Field>
          <Field label="结束时间" hint="留空表示不限"><input className="input" type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} /></Field>
          <Field label="说明" span={2}><textarea className="input" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  )
}

// ===========================================================================
// 三、促销
// ===========================================================================

function PromotionTab({ meta, tick, onChanged }: { meta: PromoMeta | null; tick: number; onChanged: () => void }) {
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const { data, loading, reload } = useAsync<{ list: PromotionRow[]; total: number }>(
    () => PROMO_LIST({ keyword: keyword || undefined, status: status || undefined, page, pageSize: 20 }),
    [keyword, status, page, tick]
  )
  const [detail, setDetail] = useState<PromotionDetail | null>(null)
  const [openDetail, setOpenDetail] = useState(false)

  const rows = data?.list || []

  const openOne = async (r: PromotionRow) => {
    try {
      const d = await PROMO_DETAIL(r.id)
      setDetail(d); setOpenDetail(true)
    } catch (e: any) { toast(e.message, 'error') }
  }

  const toggle = async (r: PromotionRow) => {
    try {
      await PROMO_STATUS(r.id, r.status === 'active' ? 'inactive' : 'active')
      toast(r.status === 'active' ? '促销已停用' : '促销已启用')
      reload(); onChanged()
    } catch (e: any) { toast(e.message, 'error') }
  }

  const remove = async (r: PromotionRow) => {
    if (!confirm(`删除促销「${r.name}」？有使用记录或被券引用的会被服务端拒绝。`)) return
    try {
      await PROMO_DELETE(r.id)
      toast('已删除'); reload(); onChanged()
    } catch (e: any) { toast(e.message, 'error') }
  }

  return (
    <div>
      <FilterBar onReset={() => { setKeyword(''); setStatus(''); setPage(1) }}>
        <Inp value={keyword} onChange={(v) => { setKeyword(v); setPage(1) }} placeholder="促销编码 / 名称" w={180} />
        <Sel value={status} onChange={(v) => { setStatus(v); setPage(1) }} w={130} placeholder="全部状态"
          options={(meta?.promo_statuses || []).map((s) => ({ value: s.value, label: s.label }))} />
        <PromotionEditor meta={meta} onSaved={() => { reload(); onChanged() }} />
      </FilterBar>

      <Card pad={false}>
        <Table
          loading={loading}
          data={rows}
          empty="暂无促销"
          onRowClick={openOne}
          columns={[
            { key: 'code', title: '编码', width: 140 },
            { key: 'name', title: '名称' },
            { key: 'type_label', title: '类型', width: 100 },
            {
              key: 'method', title: '优惠方式', width: 230,
              render: (r) => <span className="text-[12px] text-slate-600">{methodText(r as any)}</span>
            },
            { key: 'priority', title: '优先级', width: 70, align: 'center' },
            {
              key: 'flags', title: '属性', width: 130,
              render: (r) => (
                <span className="text-[12px]">
                  {r.is_automatic ? <span className="text-brand-700 mr-2">自动</span> : <span className="text-slate-400 mr-2">需券码</span>}
                  {r.is_exclusive ? <span className="text-red-600">独占</span> : null}
                </span>
              )
            },
            {
              key: 'used', title: '用量', width: 90, align: 'right',
              render: (r) => <span className={r.usage_limit && r.used >= r.usage_limit ? 'text-red-600' : ''}>{r.used}{r.usage_limit ? ` / ${r.usage_limit}` : ''}</span>
            },
            { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(PROMO_CLS, r.status)}>{r.status_label || r.status}</span> },
            {
              key: 'op', title: '操作', width: 160, render: (r) => (
                <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                  <button className="btn-ghost btn-sm" onClick={() => toggle(r)}>
                    {r.status === 'active' ? <><Pause size={13} /> 停用</> : <><Play size={13} /> 启用</>}
                  </button>
                  <button className="btn-ghost btn-sm text-red-600" onClick={() => remove(r)}><Trash2 size={13} /></button>
                </div>
              )
            }
          ]}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={20} total={data?.total || 0} onChange={setPage} />
        </div>
      </Card>

      <Modal open={openDetail} title={`促销详情 · ${detail?.name || ''}`} width={860} onClose={() => setOpenDetail(false)}>
        {detail && <PromotionDetailBody d={detail} />}
      </Modal>
    </div>
  )
}

function PromotionDetailBody({ d }: { d: PromotionDetail }) {
  const groups: { key: 'rules' | 'target_rules' | 'buy_rules'; label: string }[] = [
    { key: 'rules', label: '适用条件（rules）' },
    { key: 'target_rules', label: '作用目标（target_rules）' },
    { key: 'buy_rules', label: '买赠门槛（buy_rules）' }
  ]
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-x-8">
        <div>
          <KV k="编码" v={d.code} />
          <KV k="类型" v={d.type_label || d.type} />
          <KV k="状态" v={d.status_label || d.status} />
          <KV k="优先级" v={d.priority} />
        </div>
        <div>
          <KV k="自动参与" v={d.is_automatic ? '是（无需券码）' : '否（需要券码）'} />
          <KV k="独占" v={d.is_exclusive ? '是（命中即拦截其他）' : '否（可叠加）'} tone={d.is_exclusive ? 'red' : undefined} />
          <KV k="同组互斥" v={d.stack_group || '—'} />
          <KV k="使用上限" v={d.usage_limit ?? '不限'} />
        </div>
      </div>

      <Card className="bg-slate-50">
        <div className="text-[12px] text-slate-500 mb-1">优惠方式</div>
        <div className="text-[13px] text-slate-800">{methodText(d.method)}</div>
        {d.method?.type === 'percentage' && (
          <div className="text-[11px] text-slate-400 mt-1">
            value = {d.method.value}，口径是**减免率**的万分比：{pctText(d.method.value)}
          </div>
        )}
        {d.type === 'buyget' && (
          <div className="text-[12px] text-slate-500 mt-1">
            买赠口径：触发 = 参与行数量合计 ≥ {d.method?.buy_rules_min_quantity ?? '—'}；
            次数 = floor(合计 ÷ 门槛)；免 {d.method?.apply_to_quantity ?? '—'} 件/次；**从最低单价件开始免**
          </div>
        )}
      </Card>

      {groups.map((g) => (
        <div key={g.key}>
          <div className="text-[12px] text-slate-500 mb-1">{g.label}</div>
          {d.rules[g.key].length === 0 ? (
            <div className="text-[12px] text-slate-300">（无）</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {d.rules[g.key].map((r, i) => (
                <span key={i} className="tag bg-slate-100 text-slate-600 font-mono text-[12px]">
                  {r.attribute} {r.operator} {r.value}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}

      {d.usage_summary && (
        <Card className="bg-slate-50">
          <div className="text-[12px] text-slate-500 mb-1">使用汇总</div>
          <div className="grid grid-cols-3 gap-3 text-[13px]">
            <div>登记条数 <b className="tabular-nums">{d.usage_summary.used_count}</b></div>
            <div>优惠合计 <b className="tabular-nums">¥{yuan(d.usage_summary.used_amount)}</b></div>
            <div>
              用量计数 <b className={`tabular-nums ${d.usage_summary.used_counter !== d.usage_summary.used_count ? 'text-red-600' : ''}`}>{d.usage_summary.used_counter}</b>
              {d.usage_summary.used_counter !== d.usage_summary.used_count && <span className="text-[11px] text-red-600 ml-1">与登记条数不符</span>}
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}

/**
 * 促销编辑器（新建）。
 *
 * 「保存前先验一遍」走的是 `/promotions/validate`（只校验不落库）——
 * 这样用户不必先存进库、再去列表里找它、再删掉。
 */
function PromotionEditor({ meta, onSaved }: { meta: PromoMeta | null; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ruleText, setRuleText] = useState('')
  const [form, setForm] = useState({
    code: '', name: '', type: 'standard',
    method_type: 'percentage', target_type: 'items', allocation: 'each',
    value: '10', max_quantity: '',
    buy_rules_min_quantity: '', apply_to_quantity: '',
    is_automatic: true, is_exclusive: false, priority: '100',
    usage_limit: '', starts_at: '', ends_at: '', remark: ''
  })

  const build = () => {
    const rules: { attribute: string; operator: string; value: string }[] = []
    for (const line of ruleText.split('\n')) {
      const t = line.trim()
      if (!t) continue
      const [attribute, operator, value] = t.split(/\s+/)
      rules.push({ attribute, operator, value })
    }
    const m: any = {
      type: form.method_type,
      target_type: form.target_type,
      allocation: form.allocation,
      // **百分比在这里换算成"减免率万分比"**：界面让运营填"减几个点"（10 表示减 10%），
      // 后端要的是 1000。漏了这步会把"减 10%"存成"减 0.1%"，而引擎不会报错。
      value: form.method_type === 'percentage' ? Math.round(Number(form.value || 0) * 100) : toCents(form.value)
    }
    if (form.allocation === 'once' && form.max_quantity) m.max_quantity = Number(form.max_quantity)
    if (form.type === 'buyget') {
      m.buy_rules_min_quantity = Number(form.buy_rules_min_quantity || 0)
      m.apply_to_quantity = Number(form.apply_to_quantity || 0)
    }
    return {
      code: form.code.trim(), name: form.name.trim(), type: form.type,
      is_automatic: form.is_automatic ? 1 : 0, is_exclusive: form.is_exclusive ? 1 : 0,
      priority: Number(form.priority || 100),
      usage_limit: form.usage_limit ? Number(form.usage_limit) : null,
      starts_at: form.starts_at || null, ends_at: form.ends_at || null,
      remark: form.remark || null,
      method: m,
      rules: { rules: [], target_rules: [], buy_rules: [] }
    }
  }

  const save = async () => {
    const body = build()
    if (!body.code || !body.name) return toast('编码与名称必填', 'error')
    setBusy(true)
    try {
      // 先预检：能在这里拦住的问题不要走到落库（落库失败后编辑区的内容会丢）
      await PROMO_VALIDATE(body)
      await PROMO_CREATE(body)
      toast('促销已创建')
      setOpen(false); onSaved()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally { setBusy(false) }
  }

  const isPct = form.method_type === 'percentage'

  return (
    <>
      <button className="btn-primary btn-sm ml-auto" onClick={() => setOpen(true)}><Plus size={14} /> 新建促销</button>
      <Modal
        open={open} title="新建促销" width={820} onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>取消</button>
            <button className="btn-primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '校验并保存'}</button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="促销编码" required><input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="如 TP-DEMO" /></Field>
          <Field label="促销名称" required><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="类型">
            <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {(meta?.promo_types || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="参与方式" hint="自动参与 = 无需券码；否则需要券码解锁">
            <select className="input" value={form.is_automatic ? '1' : '0'} onChange={(e) => setForm({ ...form, is_automatic: e.target.value === '1' })}>
              <option value="1">自动参与</option>
              <option value="0">需要券码</option>
            </select>
          </Field>
          <Field label="优惠方式">
            <select className="input" value={form.method_type} onChange={(e) => setForm({ ...form, method_type: e.target.value })}>
              <option value="percentage">按比例减（折扣）</option>
              <option value="fixed">按金额减</option>
            </select>
          </Field>
          <Field label={isPct ? '减免点数（%）' : '减免金额（元）'} hint={isPct ? '填 10 表示"减 10%"（即 9 折）；系统按减免率存' : '填元，提交时自动转分'} required>
            <input className="input" type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
          </Field>
          <Field label="作用目标">
            <select className="input" value={form.target_type} onChange={(e) => setForm({ ...form, target_type: e.target.value })}>
              {(meta?.targets || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="分配方式">
            <select className="input" value={form.allocation} onChange={(e) => setForm({ ...form, allocation: e.target.value })}>
              {(meta?.allocations || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          {form.allocation === 'once' && (
            <Field label="限件数"><input className="input" type="number" value={form.max_quantity} onChange={(e) => setForm({ ...form, max_quantity: e.target.value })} /></Field>
          )}
          {form.type === 'buyget' && (
            <>
              <Field label="买够几件（门槛）" required><input className="input" type="number" value={form.buy_rules_min_quantity} onChange={(e) => setForm({ ...form, buy_rules_min_quantity: e.target.value })} /></Field>
              <Field label="每次免几件" required><input className="input" type="number" value={form.apply_to_quantity} onChange={(e) => setForm({ ...form, apply_to_quantity: e.target.value })} /></Field>
            </>
          )}
          <Field label="优先级" hint="数字越小越先算"><input className="input" type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} /></Field>
          <Field label="使用上限" hint="留空不限"><input className="input" type="number" value={form.usage_limit} onChange={(e) => setForm({ ...form, usage_limit: e.target.value })} /></Field>
          <Field label="独占" hint="命中后拦截其他活动">
            <select className="input" value={form.is_exclusive ? '1' : '0'} onChange={(e) => setForm({ ...form, is_exclusive: e.target.value === '1' })}>
              <option value="0">否（可叠加）</option>
              <option value="1">是（独占）</option>
            </select>
          </Field>
          <Field label="开始时间" hint="留空不限"><input className="input" type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} /></Field>
          <Field label="结束时间" hint="留空不限"><input className="input" type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} /></Field>
          <Field label="适用/目标规则" span={2} hint="每行一条，空格分隔：属性 运算符 值。如 sku_id in 3,5 或 subtotal gt 20000。留空表示全部商品">
            <textarea className="input font-mono" rows={2} value={ruleText} onChange={(e) => setRuleText(e.target.value)} placeholder="category_id in 2" />
          </Field>
        </div>
        <div className="text-[12px] text-slate-500 bg-amber-50 border border-amber-200 rounded p-2 mt-1">
          <AlertTriangle size={13} className="inline mr-1" />
          规则属性白名单由服务端给定（{ (meta?.rule_attributes || []).map((a) => a.value).join(' / ') }），
          写白名单外的属性会被直接拒绝 —— 属性名会被当成对象键去取值，开放任意键等于给了探针。
        </div>
      </Modal>
    </>
  )
}

// ===========================================================================
// 四、券
// ===========================================================================

function CouponTab({ meta, tick, onChanged }: { meta: PromoMeta | null; tick: number; onChanged: () => void }) {
  const [sub, setSub] = useState<'template' | 'instance'>('template')
  return (
    <div>
      <Tabs
        tabs={[{ key: 'template', label: '券模板' }, { key: 'instance', label: '券实例（券包）' }]}
        value={sub}
        onChange={(k) => setSub(k as any)}
      />
      {sub === 'template' ? <CouponTemplates meta={meta} tick={tick} onChanged={onChanged} /> : <CouponInstances tick={tick} onChanged={onChanged} />}
    </div>
  )
}

function CouponTemplates({ meta, tick, onChanged }: { meta: PromoMeta | null; tick: number; onChanged: () => void }) {
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const { data, loading, reload } = useAsync<{ list: CouponTemplate[]; total: number }>(
    () => PROMO_COUPONS({ keyword: keyword || undefined, status: status || undefined, page, pageSize: 20 }),
    [keyword, status, page, tick]
  )
  const [issueTarget, setIssueTarget] = useState<CouponTemplate | null>(null)
  const [detail, setDetail] = useState<(CouponTemplate & { instances?: CouponInstance[] }) | null>(null)

  const rows = data?.list || []

  const toggle = async (r: CouponTemplate) => {
    try {
      await PROMO_COUPON_STATUS(r.id, r.status === 'active' ? 'paused' : 'active')
      toast(r.status === 'active' ? '券已暂停' : '券已启用'); reload(); onChanged()
    } catch (e: any) { toast(e.message, 'error') }
  }

  const openDetail = async (r: CouponTemplate) => {
    try { setDetail(await PROMO_COUPON_DETAIL(r.id)) } catch (e: any) { toast(e.message, 'error') }
  }

  const expire = async () => {
    if (!confirm('把已到期券批量落库为「已过期」？这一步只改状态列，不改有效期。')) return
    try {
      const r = await PROMO_COUPON_EXPIRE()
      toast(`已落库 ${r.expired} 张过期券`); reload(); onChanged()
    } catch (e: any) { toast(e.message, 'error') }
  }

  return (
    <div>
      <FilterBar onReset={() => { setKeyword(''); setStatus(''); setPage(1) }}>
        <Inp value={keyword} onChange={(v) => { setKeyword(v); setPage(1) }} placeholder="券编码 / 名称" w={180} />
        <Sel value={status} onChange={(v) => { setStatus(v); setPage(1) }} w={130} placeholder="全部状态"
          options={(meta?.coupon_statuses || []).map((s) => ({ value: s.value, label: s.label }))} />
        <button className="btn-ghost btn-sm" onClick={expire} title="把 expires_at 已过的一批真的置成 expired">到期落库</button>
        <CouponEditor meta={meta} onSaved={() => { reload(); onChanged() }} />
      </FilterBar>

      <Card pad={false}>
        <Table
          loading={loading}
          data={rows}
          empty="暂无券模板"
          onRowClick={openDetail}
          columns={[
            { key: 'code', title: '券编码', width: 150 },
            { key: 'name', title: '名称' },
            { key: 'promotion_code', title: '绑定促销', width: 150, render: (r) => r.promotion_code || <span className="text-slate-400">未绑定</span> },
            {
              key: 'face', title: '面值（仅展示）', width: 140,
              render: (r) => r.type === 'percentage' ? pctText(r.value) : `¥${yuan(r.value)}`
            },
            { key: 'min_subtotal', title: '门槛', width: 90, align: 'right', render: (r) => `¥${yuan(r.min_subtotal)}` },
            { key: 'issued', title: '发行 / 总量', width: 110, align: 'center', render: (r) => `${r.issued_qty}${r.total_qty ? ` / ${r.total_qty}` : ''}` },
            { key: 'valid', title: '有效期', width: 150, render: (r) => r.valid_days ? `领取后 ${r.valid_days} 天` : `${r.valid_from || '不限'} ~ ${r.valid_to || '不限'}` },
            { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(COUPON_STATUS_CLS, r.status)}>{r.status_label || r.status}</span> },
            {
              key: 'op', title: '操作', width: 170, render: (r) => (
                <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                  <button className="btn-ghost btn-sm" onClick={() => setIssueTarget(r)}><Ticket size={13} /> 发券</button>
                  <button className="btn-ghost btn-sm" onClick={() => toggle(r)}>{r.status === 'active' ? <Pause size={13} /> : <Play size={13} />}</button>
                </div>
              )
            }
          ]}
        />
        <div className="px-3 pb-3"><Pagination page={page} pageSize={20} total={data?.total || 0} onChange={setPage} /></div>
      </Card>

      <div className="text-[12px] text-slate-500 mt-2 flex items-start gap-1.5">
        <AlertTriangle size={13} className="mt-[3px] shrink-0 text-amber-600" />
        <span>
          <b>券的 type / value 只作展示</b> —— 真正算钱的是「绑定促销」那一列指向的促销规则。
          改券上的金额不会改优惠额；要让优惠变，得改它绑定的那张促销。
        </span>
      </div>

      {issueTarget && (
        <IssueModal
          coupon={issueTarget}
          onClose={() => setIssueTarget(null)}
          onDone={() => { setIssueTarget(null); reload(); onChanged() }}
        />
      )}

      <Modal open={!!detail} title={`券模板详情 · ${detail?.name || ''}`} width={820} onClose={() => setDetail(null)}>
        {detail && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-x-8">
              <div>
                <KV k="券编码" v={detail.code} />
                <KV k="名称" v={detail.name} />
                <KV k="绑定促销" v={detail.promotion_code || '未绑定'} />
                <KV k="面值（展示）" v={detail.type === 'percentage' ? pctText(detail.value) : `¥${yuan(detail.value)}`} />
              </div>
              <div>
                <KV k="使用门槛" v={`¥${yuan(detail.min_subtotal)}`} />
                <KV k="发行量" v={`${detail.issued_qty}${detail.total_qty ? ` / ${detail.total_qty}` : ''}`} />
                <KV k="每人限领" v={detail.per_user_limit ?? '不限'} />
                <KV k="有效期" v={detail.valid_days ? `领取后 ${detail.valid_days} 天` : `${detail.valid_from || '不限'} ~ ${detail.valid_to || '不限'}`} />
              </div>
            </div>
            <div>
              <div className="text-[12px] text-slate-500 mb-1">已发放实例（最近）</div>
              <Table
                data={detail.instances || []}
                empty="暂无实例"
                columns={[
                  { key: 'coupon_code', title: '券码', width: 170 },
                  { key: 'customer_name', title: '客户', render: (r) => r.customer_name || r.customer_phone || '—' },
                  { key: 'acquired_at', title: '领取时间', width: 160 },
                  { key: 'expires_at', title: '到期', width: 160 },
                  { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(INSTANCE_STATUS_CLS, r.status)}>{INSTANCE_STATUS_LABEL[r.status] || r.status}</span> }
                ]}
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function CouponEditor({ meta, onSaved }: { meta: PromoMeta | null; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [promos, setPromos] = useState<PromotionRow[]>([])
  const [form, setForm] = useState({
    code: '', name: '', promotion_id: '', type: 'fixed', value: '10', min_subtotal: '0',
    total_qty: '', per_user_limit: '', valid_days: '30', valid_from: '', valid_to: '', remark: ''
  })

  useEffect(() => {
    if (!open) return
    // 只列「需要券码」的促销 —— 券要解锁的就是这类；自动参与的促销根本不需要券
    PROMO_LIST({ page: 1, pageSize: 200 }).then((r) => setPromos(r.list.filter((p) => !p.is_automatic))).catch(() => {})
  }, [open])

  const save = async () => {
    if (!form.code.trim() || !form.name.trim()) return toast('券编码与名称必填', 'error')
    if (!form.promotion_id) return toast('必须绑定一张「需要券码」的促销，否则券没有任何优惠效果', 'error')
    setBusy(true)
    try {
      await PROMO_COUPON_CREATE({
        code: form.code.trim(), name: form.name.trim(),
        promotion_id: Number(form.promotion_id),
        type: form.type,
        // 同促销编辑器：百分比口径是"减免率万分比"，界面填点数要 ×100
        value: form.type === 'percentage' ? Math.round(Number(form.value || 0) * 100) : toCents(form.value),
        // 门槛列**本来就是分**（后端 `min_subtotal` 单位是分），界面填的是元 → 这里必须转
        min_subtotal: toCents(form.min_subtotal),
        total_qty: form.total_qty ? Number(form.total_qty) : null,
        per_user_limit: form.per_user_limit ? Number(form.per_user_limit) : null,
        valid_days: form.valid_days ? Number(form.valid_days) : null,
        valid_from: form.valid_from || null, valid_to: form.valid_to || null,
        remark: form.remark || null
      })
      toast('券模板已创建'); setOpen(false); onSaved()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <>
      <button className="btn-primary btn-sm" onClick={() => setOpen(true)}><Plus size={14} /> 新建券</button>
      <Modal
        open={open} title="新建券模板" width={760} onClose={() => setOpen(false)}
        footer={<><button className="btn-ghost" onClick={() => setOpen(false)}>取消</button><button className="btn-primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button></>}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="券编码" required><input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="如 TC-DEMO" /></Field>
          <Field label="券名称" required><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="绑定促销" required span={2} hint="只能选「需要券码」的促销 —— 券的作用就是给它开一扇门">
            <select className="input" value={form.promotion_id} onChange={(e) => setForm({ ...form, promotion_id: e.target.value })}>
              <option value="">请选择</option>
              {promos.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
            </select>
          </Field>
          <Field label="面值类型" hint="仅用于对外展示，算钱看绑定的促销">
            <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="fixed">固定金额</option>
              <option value="percentage">按比例</option>
            </select>
          </Field>
          <Field label={form.type === 'percentage' ? '减免点数（%）' : '面值（元）'}>
            <input className="input" type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
          </Field>
          <Field label="使用门槛（元）"><input className="input" type="number" value={form.min_subtotal} onChange={(e) => setForm({ ...form, min_subtotal: e.target.value })} /></Field>
          <Field label="发行总量" hint="留空不限"><input className="input" type="number" value={form.total_qty} onChange={(e) => setForm({ ...form, total_qty: e.target.value })} /></Field>
          <Field label="每人限领" hint="留空不限"><input className="input" type="number" value={form.per_user_limit} onChange={(e) => setForm({ ...form, per_user_limit: e.target.value })} /></Field>
          <Field label="领取后有效天数" hint="与下面的绝对有效期二选一"><input className="input" type="number" value={form.valid_days} onChange={(e) => setForm({ ...form, valid_days: e.target.value })} /></Field>
          <Field label="绝对生效时间"><input className="input" type="datetime-local" value={form.valid_from} onChange={(e) => setForm({ ...form, valid_from: e.target.value })} /></Field>
          <Field label="绝对失效时间"><input className="input" type="datetime-local" value={form.valid_to} onChange={(e) => setForm({ ...form, valid_to: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  )
}

/** 发券：必须给一个真实客户 id（券是发给人的，不是发给"大家"） */
function IssueModal({ coupon, onClose, onDone }: { coupon: CouponTemplate; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState('1')
  const [remark, setRemark] = useState('')
  const [kw, setKw] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [busy, setBusy] = useState(false)
  const { data: members } = useAsync<{ list: MemberAccountRow[] }>(
    () => PROMO_MEMBERS({ keyword: kw || undefined, pageSize: 20 }), [kw]
  )

  const submit = async () => {
    if (!customerId) return toast('请选择客户', 'error')
    setBusy(true)
    try {
      const r = await PROMO_COUPON_ISSUE(coupon.id, { customer_id: Number(customerId), qty: Number(qty) || 1, remark: remark || null })
      toast(`已发放 ${r.issued} 张`); onDone()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <Modal
      open title={`发放券 · ${coupon.name}`} onClose={onClose}
      footer={<><button className="btn-ghost" onClick={onClose}>取消</button><button className="btn-primary" disabled={busy} onClick={submit}>{busy ? '发放中…' : '发放'}</button></>}
    >
      <div className="space-y-3">
        <Field label="搜索会员" hint="按手机号 / 姓名">
          <input className="input" value={kw} onChange={(e) => setKw(e.target.value)} placeholder="输入手机号或姓名" />
        </Field>
        <Field label="选择客户" required>
          <select className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">请选择</option>
            {(members?.list || []).map((m) => (
              <option key={m.customer_id} value={m.customer_id}>{m.phone} · {m.name || '未命名'} · {m.level_name || m.level_code}</option>
            ))}
          </select>
        </Field>
        <Field label="发放张数"><input className="input" type="number" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        <Field label="备注"><input className="input" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="如：客服补发" /></Field>
        <div className="text-[12px] text-slate-500 bg-slate-50 rounded p-2">
          受「发行总量」与「每人限领」约束 —— 超发会被拒绝，不会静默多发。
        </div>
      </div>
    </Modal>
  )
}

function CouponInstances({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const { data, loading, reload } = useAsync<{ list: CouponInstance[]; total: number }>(
    () => PROMO_INSTANCES({ status: status || undefined, page, pageSize: 20 }), [status, page, tick]
  )
  const rows = data?.list || []

  const voidOne = async (r: CouponInstance) => {
    const remark = prompt(`作废券 ${r.coupon_code}，请填写作废理由（必填）`, '客服作废')
    if (!remark) return
    try {
      await PROMO_INSTANCE_VOID(r.id, remark)
      toast('券已作废'); reload(); onChanged()
    } catch (e: any) { toast(e.message, 'error') }
  }

  return (
    <div>
      <FilterBar onReset={() => { setStatus(''); setPage(1) }}>
        <Sel value={status} onChange={(v) => { setStatus(v); setPage(1) }} w={140} placeholder="全部状态"
          options={Object.entries(INSTANCE_STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
      </FilterBar>
      <Card pad={false}>
        <Table
          loading={loading}
          data={rows}
          empty="暂无券实例"
          columns={[
            { key: 'coupon_code', title: '券码', width: 180 },
            { key: 'coupon_name', title: '券名称' },
            { key: 'customer_name', title: '持有人', width: 160, render: (r) => r.customer_name || r.customer_phone || '—' },
            { key: 'acquired_at', title: '领取时间', width: 160 },
            { key: 'expires_at', title: '到期时间', width: 160 },
            { key: 'used_at', title: '核销时间', width: 160, render: (r) => r.used_at || '—' },
            { key: 'used_amount', title: '核销金额', width: 100, align: 'right', render: (r) => r.used_amount ? `¥${yuan(r.used_amount)}` : '—' },
            { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(INSTANCE_STATUS_CLS, r.status)}>{INSTANCE_STATUS_LABEL[r.status] || r.status}</span> },
            {
              key: 'op', title: '操作', width: 90, render: (r) => r.status === 'unused'
                ? <button className="btn-ghost btn-sm text-red-600" onClick={() => voidOne(r)}><Ban size={13} /> 作废</button>
                : <span className="text-[12px] text-slate-300">—</span>
            }
          ]}
        />
        <div className="px-3 pb-3"><Pagination page={page} pageSize={20} total={data?.total || 0} onChange={setPage} /></div>
      </Card>
    </div>
  )
}

// ===========================================================================
// 五、会员
// ===========================================================================

function MemberTab({ meta, tick, onChanged }: { meta: PromoMeta | null; tick: number; onChanged: () => void }) {
  const [keyword, setKeyword] = useState('')
  const [levelCode, setLevelCode] = useState('')
  const [page, setPage] = useState(1)
  const { data, loading, reload } = useAsync<{ list: MemberAccountRow[]; total: number }>(
    () => PROMO_MEMBERS({ keyword: keyword || undefined, level_code: levelCode || undefined, page, pageSize: 20 }),
    [keyword, levelCode, page, tick]
  )
  const [cid, setCid] = useState<number | null>(null)
  const rows = data?.list || []

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <FilterBar onReset={() => { setKeyword(''); setLevelCode(''); setPage(1) }}>
          <Inp value={keyword} onChange={(v) => { setKeyword(v); setPage(1) }} placeholder="手机号 / 姓名" w={170} />
          <Sel value={levelCode} onChange={(v) => { setLevelCode(v); setPage(1) }} w={130} placeholder="全部等级"
            options={(meta?.levels || []).map((l) => ({ value: l.code, label: l.name }))} />
        </FilterBar>
        <LevelEditor meta={meta} onSaved={onChanged} />
      </div>

      <Card pad={false}>
        <Table
          loading={loading}
          data={rows}
          empty="暂无会员"
          rowKey={(r) => r.customer_id}
          onRowClick={(r) => setCid(r.customer_id)}
          columns={[
            { key: 'phone', title: '手机号', width: 140 },
            { key: 'name', title: '姓名', width: 110, render: (r) => r.name || '—' },
            { key: 'level', title: '等级', width: 110, render: (r) => <span className="tag bg-brand-50 text-brand-700">{r.level_name || r.level_code}</span> },
            { key: 'discount', title: '等级折扣', width: 120, render: (r) => levelPctText(r.discount_pct) },
            { key: 'points', title: '可用积分', width: 100, align: 'right', render: (r) => fmtInt(r.points) },
            { key: 'points_total', title: '累计积分', width: 100, align: 'right', render: (r) => fmtInt(r.points_total) },
            { key: 'balance_cents', title: '储值余额', width: 110, align: 'right', render: (r) => `¥${yuan(r.balance_cents)}` },
            { key: 'total_spent_cents', title: '累计消费', width: 120, align: 'right', render: (r) => `¥${yuan(r.total_spent_cents)}` },
            { key: 'coupon', title: '券（未用/已用）', width: 120, align: 'center', render: (r) => `${r.coupon_unused ?? 0} / ${r.coupon_used ?? 0}` }
          ]}
        />
        <div className="px-3 pb-3"><Pagination page={page} pageSize={20} total={data?.total || 0} onChange={setPage} /></div>
      </Card>

      {cid != null && (
        <MemberDetailModal
          customerId={cid}
          meta={meta}
          onClose={() => setCid(null)}
          onChanged={() => { reload(); onChanged() }}
        />
      )}
    </div>
  )
}

function LevelEditor({ meta, onSaved }: { meta: PromoMeta | null; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [levels, setLevels] = useState<MemberLevel[]>([])
  const [editing, setEditing] = useState<MemberLevel | null>(null)
  const [form, setForm] = useState({ name: '', min_points: '', min_spent_yuan: '', pay_pct: '', points_rate: '', points_deduct_limit: '', benefits: '' })
  const [busy, setBusy] = useState(false)

  const load = () => PROMO_LEVELS().then(setLevels).catch((e) => toast(e.message, 'error'))
  useEffect(() => { if (open) load() }, [open])

  const pick = (l: MemberLevel) => {
    setEditing(l)
    setForm({
      name: l.name,
      min_points: String(l.min_points),
      min_spent_yuan: String(l.min_spent_yuan),
      // 对外显示"实付百分比"（打几折），存的是 discount_pct 万分比 —— 在这里转一次
      pay_pct: String(Number(l.discount_pct) / 100),
      points_rate: String(l.points_rate),
      points_deduct_limit: String(Number(l.points_deduct_limit) / 100),
      benefits: l.benefits || ''
    })
  }

  const save = async () => {
    if (!editing) return
    setBusy(true)
    try {
      await PROMO_LEVEL_UPDATE(editing.code, {
        name: form.name,
        min_points: Number(form.min_points || 0),
        min_spent_yuan: Number(form.min_spent_yuan || 0),
        // 实付百分比 → discount_pct 万分比
        discount_pct: Math.round(Number(form.pay_pct || 100) * 100),
        points_rate: Number(form.points_rate || 100),
        // 抵扣上限同样是万分比
        points_deduct_limit: Math.round(Number(form.points_deduct_limit || 0) * 100),
        benefits: form.benefits || null
      } as any)
      toast('等级权益已更新'); await load(); onSaved()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <>
      <button className="btn-ghost btn-sm" onClick={() => setOpen(true)}><Users2 size={14} /> 等级权益</button>
      <Modal open={open} title="会员等级权益" width={900} onClose={() => setOpen(false)}>
        <div className="space-y-3">
          <Table
            data={levels}
            empty="暂无等级"
            columns={[
              { key: 'code', title: '编码', width: 100 },
              { key: 'name', title: '名称', width: 100 },
              { key: 'min_points', title: '积分门槛', width: 100, align: 'right', render: (r) => fmtInt(r.min_points) },
              { key: 'min_spent_yuan', title: '消费门槛(元)', width: 120, align: 'right', render: (r) => fmtInt(r.min_spent_yuan) },
              { key: 'discount', title: '折扣', width: 150, render: (r) => levelPctText(r.discount_pct) },
              { key: 'points_rate', title: '积分倍率', width: 100, align: 'center', render: (r) => `${(Number(r.points_rate) / 100).toFixed(2)}x` },
              { key: 'points_deduct_limit', title: '积分抵扣上限', width: 130, align: 'right', render: (r) => `${(Number(r.points_deduct_limit) / 100).toFixed(0)}%` },
              { key: 'op', title: '', width: 70, render: (r) => <button className="btn-ghost btn-sm" onClick={() => pick(r)}>编辑</button> }
            ]}
          />
          <div className="text-[12px] text-slate-500 bg-amber-50 border border-amber-200 rounded p-2">
            升级是<b>两个门槛的「与」</b>：积分与累计消费都达标才升。改低门槛会让存量会员在下次同步时被重判。
          </div>
          {editing && (
            <Card className="bg-slate-50">
              <SectionTitle title={`编辑 · ${editing.code}`} />
              <div className="grid grid-cols-3 gap-3">
                <Field label="名称"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
                <Field label="积分门槛"><input className="input" type="number" value={form.min_points} onChange={(e) => setForm({ ...form, min_points: e.target.value })} /></Field>
                <Field label="消费门槛（元）"><input className="input" type="number" value={form.min_spent_yuan} onChange={(e) => setForm({ ...form, min_spent_yuan: e.target.value })} /></Field>
                <Field label="实付比例（%）" hint="填 95 表示实付 95%（9.5 折）；100 = 不打折">
                  <input className="input" type="number" value={form.pay_pct} onChange={(e) => setForm({ ...form, pay_pct: e.target.value })} />
                </Field>
                <Field label="积分倍率（%）" hint="100 = 1 倍"><input className="input" type="number" value={form.points_rate} onChange={(e) => setForm({ ...form, points_rate: e.target.value })} /></Field>
                <Field label="积分抵扣上限（%）" hint="占订单金额的比例，如 30">
                  <input className="input" type="number" value={form.points_deduct_limit} onChange={(e) => setForm({ ...form, points_deduct_limit: e.target.value })} />
                </Field>
                <Field label="权益说明" span={3}><textarea className="input" rows={2} value={form.benefits} onChange={(e) => setForm({ ...form, benefits: e.target.value })} /></Field>
              </div>
              <div className="flex justify-end mt-2">
                <button className="btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存权益'}</button>
              </div>
            </Card>
          )}
        </div>
      </Modal>
    </>
  )
}

function MemberDetailModal({ customerId, meta, onClose, onChanged }: { customerId: number; meta: PromoMeta | null; onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<'profile' | 'coupon' | 'ledger'>('profile')
  const { data, reload } = useAsync<MemberDetail>(() => PROMO_MEMBER_DETAIL(customerId), [customerId])
  const ov = data?.overview

  const refresh = () => { reload(); onChanged() }

  return (
    <Modal open title={`会员详情 · ${ov?.phone || customerId}`} width={980} onClose={onClose}>
      {!data || !ov ? (
        <Empty text="加载中…" />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-4 gap-3">
            <StatCard label="会员等级" value={data.level?.name || ov.level_code} sub={levelPctText(ov.discount_pct)} tone="brand" />
            <StatCard label="可用积分" value={fmtInt(ov.points)} sub={`累计 ${fmtInt(ov.points_total)}`} tone="amber" />
            <StatCard label="储值余额" value={`¥${yuan(ov.balance_cents)}`} sub={`累计消费 ¥${yuan(ov.total_spent_cents)}`} />
            <StatCard
              label="距下一级"
              value={data.next_level ? (data.next_level.name) : '已是最高级'}
              sub={data.gap ? `还差 ${fmtInt(data.gap.points)} 分 / ¥${fmtInt(data.gap.spent_yuan)}` : '—'}
            />
          </div>

          <Tabs
            tabs={[
              { key: 'profile', label: '概览与操作' },
              { key: 'coupon', label: '券包', count: (data.coupons || []).length },
              { key: 'ledger', label: '积分 / 储值流水' }
            ]}
            value={tab}
            onChange={(k) => setTab(k as any)}
          />

          {tab === 'profile' && <MemberOps customerId={customerId} meta={meta} data={data} onDone={refresh} />}
          {tab === 'coupon' && <MemberCoupons customerId={customerId} data={data} onDone={refresh} />}
          {tab === 'ledger' && <MemberLedger customerId={customerId} />}
        </div>
      )}
    </Modal>
  )
}

function MemberOps({ customerId, meta, data, onDone }: { customerId: number; meta: PromoMeta | null; data: MemberDetail; onDone: () => void }) {
  const [pointsChange, setPointsChange] = useState('')
  const [pointsRemark, setPointsRemark] = useState('')
  const [amt, setAmt] = useState('')
  const [amtKind, setAmtKind] = useState<'recharge' | 'adjust'>('recharge')
  const [amtRemark, setAmtRemark] = useState('')
  const [levelCode, setLevelCode] = useState('')
  const [levelRemark, setLevelRemark] = useState('')
  const [busy, setBusy] = useState('')

  const ov = data.overview

  const doPoints = async () => {
    if (!pointsChange || !pointsRemark.trim()) return toast('积分变动与理由都必填', 'error')
    setBusy('points')
    try {
      await PROMO_MEMBER_POINTS(customerId, { change: Number(pointsChange), remark: pointsRemark })
      toast('积分已调整'); setPointsChange(''); setPointsRemark(''); onDone()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy('') }
  }

  const doAmount = async () => {
    if (!amt || !amtRemark.trim()) return toast('金额与理由都必填', 'error')
    setBusy('amt')
    try {
      if (amtKind === 'recharge') {
        await PROMO_MEMBER_RECHARGE(customerId, { amount_cents: toCents(amt), remark: amtRemark })
      } else {
        await PROMO_MEMBER_BALANCE(customerId, { change_cents: toCents(amt), remark: amtRemark })
      }
      toast(amtKind === 'recharge' ? '充值成功' : '储值已调整')
      setAmt(''); setAmtRemark(''); onDone()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy('') }
  }

  const doLevel = async () => {
    if (!levelCode || !levelRemark.trim()) return toast('目标等级与理由都必填', 'error')
    setBusy('level')
    try {
      await PROMO_MEMBER_LEVEL(customerId, { level_code: levelCode, remark: levelRemark })
      toast('等级已人工指定'); setLevelRemark(''); onDone()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy('') }
  }

  const doSync = async () => {
    setBusy('sync')
    try {
      const r = await PROMO_MEMBER_SYNC(customerId)
      toast(`已按规则重判：${r?.level_code ? `${r.level_code}` : '完成'}`); onDone()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy('') }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      <Card className="bg-slate-50">
        <SectionTitle title="基本信息" />
        <KV k="手机号" v={ov.phone} />
        <KV k="姓名" v={ov.name || '—'} />
        <KV k="等级" v={data.level?.name || ov.level_code} />
        <KV k="等级折扣" v={levelPctText(ov.discount_pct)} />
        <KV k="积分倍率" v={`${(Number(ov.points_rate || 100) / 100).toFixed(2)}x`} />
        <KV k="积分抵扣上限" v={`${(Number(ov.points_deduct_limit || 0) / 100).toFixed(0)}%`} />
        <KV k="升级时间" v={ov.upgraded_at || '—'} />
      </Card>

      <Card>
        <SectionTitle title="积分调整" desc="必须写理由；服务端会写流水并回写余额" />
        <Field label="变动（正加负减）"><input className="input" type="number" value={pointsChange} onChange={(e) => setPointsChange(e.target.value)} placeholder="如 500 / -200" /></Field>
        <div className="h-2" />
        <Field label="理由" required><input className="input" value={pointsRemark} onChange={(e) => setPointsRemark(e.target.value)} placeholder="如：客服补偿" /></Field>
        <div className="flex justify-end mt-3">
          <button className="btn-primary btn-sm" disabled={busy === 'points'} onClick={doPoints}>
            {busy === 'points' ? '提交中…' : '提交积分调整'}
          </button>
        </div>
      </Card>

      <Card>
        <SectionTitle title="储值" desc="充值与调整是两个口径，混在一起会让「钱怎么进来的」查不清" />
        <Field label="操作类型">
          <select className="input" value={amtKind} onChange={(e) => setAmtKind(e.target.value as any)}>
            <option value="recharge">充值（走财务，记 doc_no）</option>
            <option value="adjust">人工调整（纠错）</option>
          </select>
        </Field>
        <div className="h-2" />
        <Field label="金额（元）"><input className="input" type="number" value={amt} onChange={(e) => setAmt(e.target.value)} /></Field>
        <div className="h-2" />
        <Field label="理由" required><input className="input" value={amtRemark} onChange={(e) => setAmtRemark(e.target.value)} /></Field>
        <div className="flex justify-end mt-3">
          <button className="btn-primary btn-sm" disabled={busy === 'amt'} onClick={doAmount}>
            {busy === 'amt' ? '提交中…' : '提交'}
          </button>
        </div>
      </Card>

      <Card className="lg:col-span-3">
        <SectionTitle title="等级维护" desc="人工指定会把累计门槛抬到达标线（否则下一单送分会被自动判定冲回）；按规则重判则完全按积分/消费重算" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <Field label="目标等级">
            <select className="input" value={levelCode} onChange={(e) => setLevelCode(e.target.value)}>
              <option value="">请选择</option>
              {(meta?.levels || []).map((l) => <option key={l.code} value={l.code}>{l.name}（{l.code}）</option>)}
            </select>
          </Field>
          <Field label="理由" required><input className="input" value={levelRemark} onChange={(e) => setLevelRemark(e.target.value)} placeholder="如：大客户手工授级" /></Field>
          <div className="flex gap-2">
            <button className="btn-primary btn-sm" disabled={busy === 'level'} onClick={doLevel}>人工指定等级</button>
            <button className="btn-ghost btn-sm" disabled={busy === 'sync'} onClick={doSync}><RefreshCw size={13} /> 按规则重判</button>
          </div>
        </div>
      </Card>
    </div>
  )
}

function MemberCoupons({ customerId, data, onDone }: { customerId: number; data: MemberDetail; onDone: () => void }) {
  const [couponId, setCouponId] = useState('')
  const [templates, setTemplates] = useState<CouponTemplate[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => { PROMO_COUPONS({ pageSize: 100 }).then((r) => setTemplates(r.list)).catch(() => {}) }, [])

  const issue = async () => {
    if (!couponId) return toast('请选择券模板', 'error')
    setBusy(true)
    try {
      await PROMO_MEMBER_ISSUE(customerId, { coupon_id: Number(couponId), qty: 1, remark: '客服发券' })
      toast('已发券'); onDone()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  const stat = data.coupon_stat || []

  return (
    <div className="space-y-3">
      <Card className="bg-slate-50">
        <div className="flex items-center gap-4 flex-wrap">
          {stat.length === 0 && <span className="text-[13px] text-slate-400">暂无券</span>}
          {stat.map((s) => (
            <span key={s.status} className={pill(INSTANCE_STATUS_CLS, s.status) + ' px-3 py-1'}>
              {INSTANCE_STATUS_LABEL[s.status] || s.status} {s.c} 张{s.amt ? ` · 已用 ¥${yuan(s.amt)}` : ''}
            </span>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <select className="input input-sm" style={{ width: 220 }} value={couponId} onChange={(e) => setCouponId(e.target.value)}>
              <option value="">选择券模板发券</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.code}）</option>)}
            </select>
            <button className="btn-primary btn-sm" disabled={busy} onClick={issue}><Plus size={13} /> 发券</button>
          </div>
        </div>
      </Card>

      <Table
        data={data.coupons || []}
        empty="暂无券"
        columns={[
          { key: 'coupon_code', title: '券码', width: 180 },
          { key: 'coupon_name', title: '券名称' },
          { key: 'acquired_at', title: '领取时间', width: 160 },
          { key: 'expires_at', title: '到期', width: 160 },
          { key: 'used_at', title: '核销时间', width: 160, render: (r) => r.used_at || '—' },
          { key: 'status', title: '状态', width: 90, render: (r) => <span className={pill(INSTANCE_STATUS_CLS, r.status)}>{INSTANCE_STATUS_LABEL[r.status] || r.status}</span> }
        ]}
      />
    </div>
  )
}

function MemberLedger({ customerId }: { customerId: number }) {
  const [kind, setKind] = useState<'points' | 'balance'>('points')
  const [page, setPage] = useState(1)
  const { data, loading } = useAsync<{ list: any[]; total: number; kind: string }>(
    () => PROMO_MEMBER_LEDGER(customerId, { kind, page, pageSize: 20 }), [kind, page, customerId]
  )
  const rows = data?.list || []
  const isPoints = kind === 'points'

  return (
    <div>
      <Tabs
        tabs={[{ key: 'points', label: '积分流水' }, { key: 'balance', label: '储值流水' }]}
        value={kind}
        onChange={(k) => { setKind(k as any); setPage(1) }}
      />
      <div className="text-[12px] text-slate-500 mb-2">
        <b>余额不是真相，流水才是</b> —— 每一行都带「变动后余额」，
        可用它逐行复算：上一行余额 + 本行变动 = 本行余额。
      </div>
      <Table
        loading={loading}
        data={rows}
        empty="暂无流水"
        columns={[
          { key: 'created_at', title: '时间', width: 160 },
          { key: 'kind_label', title: '类型', width: 120, render: (r) => r.kind_label || r.kind },
          {
            key: 'change', title: isPoints ? '积分变动' : '金额变动', width: 130, align: 'right',
            render: (r) => {
              const v = isPoints ? r.change_points : r.change_cents
              const n = Number(v || 0)
              return <span className={n > 0 ? 'text-red-600' : n < 0 ? 'text-green-600' : ''}>{isPoints ? (n > 0 ? `+${fmtInt(n)}` : fmtInt(n)) : `¥${yuan(n)}`}</span>
            }
          },
          {
            key: 'after', title: '变动后余额', width: 130, align: 'right',
            render: (r) => {
              const v = isPoints ? r.balance_after_points : r.balance_after_cents
              return isPoints ? fmtInt(v) : `¥${yuan(v)}`
            }
          },
          { key: 'doc_no', title: '来源单号', width: 150, render: (r) => r.doc_no || '—' },
          { key: 'remark', title: '备注' }
        ]}
      />
      <Pagination page={page} pageSize={20} total={data?.total || 0} onChange={setPage} />
    </div>
  )
}

// ===========================================================================
// 六、试算器
// ===========================================================================

interface CartRow { key: number; sku_id: string; qty: string }

function QuoteTab({ meta }: { meta: PromoMeta | null }) {
  const [customerId, setCustomerId] = useState('')
  const [kw, setKw] = useState('')
  const [skuKw, setSkuKw] = useState('')
  const [rows, setRows] = useState<CartRow[]>([{ key: 1, sku_id: '', qty: '1' }])
  const [skus, setSkus] = useState<any[]>([])
  const [usePoints, setUsePoints] = useState('')
  const [autoCoupon, setAutoCoupon] = useState(false)
  const [pickedCoupons, setPickedCoupons] = useState<string[]>([])
  const [result, setResult] = useState<QuoteResult | null>(null)
  const [explain, setExplain] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const { data: members } = useAsync<{ list: MemberAccountRow[] }>(
    () => PROMO_MEMBERS({ keyword: kw || undefined, pageSize: 30 }), [kw]
  )
  useEffect(() => {
    // 只取**有零售价**的 SKU：单价为 0 的行会被服务端以 PRICE_INVALID 拒掉
    // （`buildItems` 兜底取 `sku.price_retail * 100`，为 0 就不是"异常"而是"根本没法算"）。
    // 不在这里滤，用户就会从下拉里挑到一个"选了必报错"的选项。
    api.get('/master/skus', { limit: 500 })
      .then((r: any) => setSkus((r.data || []).filter((s: any) => Number(s.price_retail) > 0)))
      .catch(() => {})
  }, [])

  const filteredSkus = skus.filter((s) =>
    !skuKw || `${s.sku_code} ${s.name} ${s.product_name} ${s.barcode || ''}`.toLowerCase().includes(skuKw.toLowerCase())
  )

  const customer = (members?.list || []).find((m) => String(m.customer_id) === customerId) || null

  // 可用券列表：**只读展示**，不代表本单会用 —— 用它来给人做勾选
  const avail = result?.coupon?.available

  const buildBody = () => ({
    items: rows.filter((r) => r.sku_id && Number(r.qty) > 0).map((r) => ({ sku_id: Number(r.sku_id), qty: Number(r.qty) })),
    customer_id: customerId ? Number(customerId) : null,
    coupon_codes: pickedCoupons,
    auto_coupon: autoCoupon,
    use_points: Number(usePoints) || 0
  })

  const run = async (withExplain: boolean) => {
    const body = buildBody()
    if (!body.items.length) return toast('请至少添加一行商品', 'error')
    setBusy(true)
    try {
      if (withExplain) {
        const r = await PROMO_EXPLAIN(body)
        setResult(r.quote)
        setExplain(r.explain.lines || [])
      } else {
        setResult(await PROMO_QUOTE(body))
        setExplain([])
      }
    } catch (e: any) {
      toast(e.message, 'error')
    } finally { setBusy(false) }
  }

  const addRow = () => setRows((r) => [...r, { key: Date.now(), sku_id: '', qty: '1' }])
  const delRow = (key: number) => setRows((r) => (r.length > 1 ? r.filter((x) => x.key !== key) : r))
  const upd = (key: number, patch: Partial<CartRow>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)))

  const skuName = (id: any) => {
    const s = skus.find((x) => String(x.id) === String(id))
    return s ? `${s.sku_code} · ${s.name}` : `SKU#${id}`
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* 左：输入 */}
      <div className="space-y-3">
        <Card>
          <SectionTitle title="购物车" desc="单价留空则按 SKU 零售价兜底（后端自动 ×100 转分）" />
          <div className="space-y-2">
            <Field label="搜索商品" hint="按 SKU 编码 / 名称 / 商品名 / 条码；只列有零售价的 SKU">
              <input className="input" value={skuKw} onChange={(e) => setSkuKw(e.target.value)} placeholder="输入关键字筛选下面的下拉" />
            </Field>
            {rows.map((r, i) => (
              <div key={r.key} className="flex items-center gap-2">
                <span className="w-6 text-[12px] text-slate-400">{i + 1}</span>
                <select className="input input-sm flex-1" value={r.sku_id} onChange={(e) => upd(r.key, { sku_id: e.target.value })}>
                  <option value="">选择 SKU</option>
                  {filteredSkus.slice(0, 80).map((s) => <option key={s.id} value={s.id}>{s.sku_code} · {s.name} · ¥{s.price_retail}</option>)}
                </select>
                <input className="input input-sm" style={{ width: 80 }} type="number" min={1} value={r.qty} onChange={(e) => upd(r.key, { qty: e.target.value })} />
                <button className="btn-ghost btn-sm text-red-600" onClick={() => delRow(r.key)} disabled={rows.length === 1}><Trash2 size={13} /></button>
              </div>
            ))}
            <button className="btn-ghost btn-sm" onClick={addRow}><Plus size={13} /> 添加一行</button>
            {filteredSkus.length === 0 && <div className="text-[12px] text-amber-600">没有匹配的商品，试试换个关键字</div>}
          </div>
        </Card>

        <Card>
          <SectionTitle title="客户与优惠" desc="券必须显式勾选，或显式开启自动选券；默认一张都不用" />
          <div className="space-y-3">
            <Field label="搜索会员" hint="留空表示散客（无会员折扣、无积分、无券）">
              <input className="input" value={kw} onChange={(e) => setKw(e.target.value)} placeholder="手机号 / 姓名" />
            </Field>
            <Field label="选择客户">
              <select className="input" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setPickedCoupons([]); setResult(null) }}>
                <option value="">散客（不使用会员权益）</option>
                {(members?.list || []).map((m) => (
                  <option key={m.customer_id} value={m.customer_id}>{m.phone} · {m.name || '未命名'} · {m.level_name || m.level_code}</option>
                ))}
              </select>
            </Field>
            {customer && (
              <div className="text-[12px] text-slate-500 bg-slate-50 rounded p-2">
                {customer.level_name || customer.level_code} · 可用积分 {fmtInt(customer.points)} · 储值 ¥{yuan(customer.balance_cents)} · 未用券 {customer.coupon_unused ?? 0} 张
              </div>
            )}

            <label className="flex items-center gap-2 text-[13px] text-slate-700">
              <input type="checkbox" checked={autoCoupon} onChange={(e) => { setAutoCoupon(e.target.checked); setPickedCoupons([]) }} />
              自动选券（由引擎挑最省的一张）——<span className="text-amber-600">仅试算，落单时同样需要显式声明</span>
            </label>

            {!autoCoupon && (
              <div>
                <div className="text-[12px] text-slate-500 mb-1">指定券（勾选后才参与计算）</div>
                {!result ? (
                  <div className="text-[12px] text-slate-400">先试算一次，这里会列出该客户当前可用的券</div>
                ) : (avail?.usable?.length || avail?.blocked?.length) ? (
                  <div className="space-y-1">
                    {(avail?.usable || []).map((c) => (
                      <label key={c.coupon_code} className="flex items-center gap-2 text-[12px]">
                        <input
                          type="checkbox"
                          checked={pickedCoupons.includes(c.coupon_code)}
                          onChange={(e) => setPickedCoupons((p) => e.target.checked ? [...p, c.coupon_code] : p.filter((x) => x !== c.coupon_code))}
                        />
                        <span className="text-green-700">{c.coupon_code}</span>
                        <span>{c.coupon_name}</span>
                        <span className="text-slate-400">门槛 ¥{yuan(c.min_subtotal_cents)}</span>
                      </label>
                    ))}
                    {(avail?.blocked || []).map((c) => (
                      <div key={c.coupon_code} className="flex items-center gap-2 text-[12px] text-slate-400">
                        <input type="checkbox" disabled />
                        <span>{c.coupon_code}</span>
                        <span>{c.message}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-slate-400">该客户当前没有可用券</div>
                )}
              </div>
            )}

            <Field label="使用积分" hint={result?.points_quote ? `本单最多可抵 ${fmtInt(result.points_quote.maxPoints)} 分（上限 ${(Number(result.points_quote.limitBp || 0) / 100).toFixed(0)}%）` : '留空或 0 表示不使用'}>
              <input className="input" type="number" value={usePoints} onChange={(e) => setUsePoints(e.target.value)} />
            </Field>

            <div className="flex gap-2">
              <button className="btn-primary btn-sm" disabled={busy} onClick={() => run(false)}><Calculator size={14} /> 试算</button>
              <button className="btn-ghost btn-sm" disabled={busy} onClick={() => run(true)}>试算 + 解释链</button>
            </div>
          </div>
        </Card>
      </div>

      {/* 右：结果 */}
      <div className="space-y-3">
        {!result ? (
          <Card><Empty text="还没有试算结果" /></Card>
        ) : (
          <>
            <Card>
              <SectionTitle title="算钱顺序（四段）" desc="会员折扣作用于原价 → 促销在会员价上叠加 → 积分只作用于最终成交价" />
              <div className="space-y-1">
                <AmountRow label="① 商品原价合计" v={result.subtotal} />
                <AmountRow label="② 会员折扣" v={-result.member_discount} hint={result.member ? `${result.member.level_name} · ${levelPctText(result.member.discount_pct || 10000)}` : '非会员'} />
                <AmountRow label="③ 促销优惠" v={-result.promotion_discount} hint={(result.applied_codes || []).join('、') || '无命中'} />
                <AmountRow label="④ 积分抵扣" v={-result.points_discount} hint={result.points_used ? `抵 ${fmtInt(result.points_used)} 分` : '未使用'} />
                <div className="border-t border-slate-200 mt-1 pt-1">
                  <AmountRow label="应付金额" v={result.payable} strong />
                </div>
              </div>
            </Card>

            {/* 行级优惠：只给整单额回答不了"减在哪几行" */}
            <Card>
              <SectionTitle title="行级优惠（三段）" desc="行优惠合计必须等于整单优惠 —— 不平即抛 ALLOCATION_MISMATCH" />
              <Table
                data={result.line_discounts || []}
                empty="无行"
                columns={[
                  { key: 'sku', title: '商品', render: (r) => skuName(r.sku_id) },
                  { key: 'subtotal', title: '原价', width: 90, align: 'right', render: (r) => `¥${yuan(r.subtotal)}` },
                  { key: 'member_discount', title: '会员', width: 80, align: 'right', render: (r) => r.member_discount ? `-¥${yuan(r.member_discount)}` : '—' },
                  { key: 'promotion_discount', title: '促销', width: 80, align: 'right', render: (r) => r.promotion_discount ? `-¥${yuan(r.promotion_discount)}` : '—' },
                  { key: 'points_discount', title: '积分', width: 80, align: 'right', render: (r) => r.points_discount ? `-¥${yuan(r.points_discount)}` : '—' },
                  { key: 'payable', title: '行应付', width: 90, align: 'right', render: (r) => `¥${yuan(r.payable)}` }
                ]}
              />
              <div className="text-[12px] text-slate-500 mt-2">
                行应付合计 <b className="tabular-nums">¥{yuan((result.line_discounts || []).reduce((s, l) => s + Number(l.payable || 0), 0))}</b>
                ，整单应付 <b className="tabular-nums">¥{yuan(result.payable)}</b>
                {Math.abs((result.line_discounts || []).reduce((s, l) => s + Number(l.payable || 0), 0) - Number(result.payable)) < 0.005
                  ? <span className="text-green-600 ml-1">✓ 平</span>
                  : <span className="text-red-600 ml-1">✗ 不平</span>}
              </div>
            </Card>

            {result.coupon && (
              <Card>
                <SectionTitle
                  title="券的参与情况"
                  desc="accepted = 券码被接受（解锁了对应促销），但促销还要满足自身规则才真正生效 · available = 仅「可用」，不代表本单会用"
                />
                {(result.coupon.accepted || []).length === 0 ? (
                  <div className="text-[13px] text-slate-400 mb-1">本单没有券码被接受</div>
                ) : (
                  // 关键区分：券码被接受 ≠ 优惠已发生。
                  // 券只负责"解锁"，对应促销仍要过自己的规则（门槛/时间/用量/独占）。
                  // 早先把 accepted 直接写成「已参与」，于是页面上一处说"已参与"、
                  // 另一处命中链说"未生效：不满足适用条件"——同一页自相矛盾，
                  // 而用户只会得出"系统算错了"的结论。
                  (result.coupon.accepted || []).map((c) => {
                    const live = (result.applied_codes || []).includes(c.promotion_code)
                    return (
                      <div key={c.coupon_code} className={`text-[13px] mb-1 ${live ? 'text-green-700' : 'text-amber-600'}`}>
                        {live ? '✅' : '⏳'} {c.coupon_code} → {c.promotion_code}：
                        {live ? '券码被接受，对应促销已生效' : '券码被接受，但对应促销未生效（原因见下方命中链）'}
                      </div>
                    )
                  })
                )}
                {(result.coupon.rejected || []).map((c) => (
                  <div key={c.coupon_code} className="text-[12px] text-red-600">{c.coupon_code}：{c.message}（{c.reason}）</div>
                ))}
              </Card>
            )}

            {/* 命中链：为什么某张活动没生效，必须能回答 */}
            <Card>
              <SectionTitle title="促销命中链" desc="生效的给优惠额；未生效的给原因，不留「为什么没减」的疑问" />
              {!(result.traced || []).length ? (
                <div className="text-[12px] text-slate-400">无命中记录</div>
              ) : (
                <div className="space-y-1">
                  {(result.traced || []).map((t, i) => (
                    <div key={i} className="flex items-start gap-2 text-[12px]">
                      {t.applied != null
                        ? <span className="text-green-700">✅ {t.code} 生效，优惠 ¥{yuan(t.applied)}</span>
                        : <span className="text-slate-500">⏭️ {t.code} 未生效：{SKIP_LABEL[t.skipped || ''] || t.skipped}{t.by ? `（被 ${t.by} 独占）` : ''}{t.need != null ? `（需 ${t.need} 件，实际 ${t.got} 件）` : ''}</span>}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {explain.length > 0 && (
              <Card className="bg-slate-50">
                <SectionTitle title="解释链（人话版）" />
                <div className="font-mono text-[12px] text-slate-700 whitespace-pre-wrap leading-relaxed">{explain.join('\n')}</div>
              </Card>
            )}
          </>
        )}

        {meta && (
          <div className="text-[12px] text-slate-400">
            提示：本页只做**试算**（纯读）。真正落单要调结算接口，它会写优惠留痕、登记使用、核销券、送积分四件事；
            撤单则成对回退这四件事。
          </div>
        )}
      </div>
    </div>
  )
}

/** 与后端 promotion.js 的 SKIP_LABEL 保持一致的文案（前端不自己造词，否则同一件事两处说法） */
const SKIP_LABEL: Record<string, string> = {
  need_code: '需要券码',
  no_method: '未配置优惠方式',
  order_rule: '不满足适用条件',
  stack_group: '同组已有更优活动生效',
  usage_limit: '已达使用次数上限',
  exclusive_hit: '已被独占活动拦截',
  no_target: '没有可作用的商品行',
  no_effect: '未产生优惠额',
  buy_rules: '买的不够（买赠门槛）',
  buyget_misconfigured: '买赠配置不完整（缺门槛或赠出件数）'
}

function AmountRow({ label, v, hint, strong }: { label: string; v: number; hint?: string; strong?: boolean }) {
  const n = Number(v || 0)
  const cls = strong ? 'text-slate-900 font-medium' : n < 0 ? 'text-green-600' : 'text-slate-700'
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={`text-[13px] ${strong ? 'text-slate-800 font-medium' : 'text-slate-600'}`}>
        {label}
        {hint && <span className="text-[11px] text-slate-400 ml-2">{hint}</span>}
      </span>
      <span className={`text-[14px] tabular-nums ${cls}`}>{n < 0 ? `-¥${yuan(-n)}` : `¥${yuan(n)}`}</span>
    </div>
  )
}
