/**
 * ============================================================================
 * 文件标识：src/api/promo.ts ｜ 模块 promo（按文件名推断，待人工完善）
 * ============================================================================
 * 【职责】模块 promo（按文件名推断，待人工完善）
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import api from './client'

/** 统一拆信封（与 useFetch 一致） */
const data = <T>(p: Promise<any>): Promise<T> => p.then((r) => r.data as T)

/**
 * 商城营销（模块 18）前端配套：活动 / 促销 / 券 / 会员等级 / 积分 / 储值 / 试算。
 *
 * 与后端一一对应的**三条硬口径**，前端也必须守住（改一处要同步）：
 *   ① 算钱顺序固定：会员折扣（作用于原价）→ 促销（在会员价上叠加）→ 积分（只作用于最终成交价）。
 *      所以试算器把金额拆成四段显示（原价 / 会员 / 促销 / 积分），而不是只给一个"优惠了多少"。
 *   ② 优惠必须摊到行：接口返回 `line_discounts`，界面按行展示三段优惠，能回答"减在哪几行"。
 *   ③ 余额不是真相，流水才是：会员详情必须能列到流水，并显示每行的 `balance_after`。
 *
 * 另外两条界面口径：
 *   · **券默认不自动使用**：试算器里"用哪张券"必须由人显式选（`coupon_codes`），
 *     或者由人显式勾选"自动选券"（`auto_coupon`）。默认什么都不勾 = 一张都不用。
 *   · 券的 `type`/`value` **只作展示**，真正算钱的是它绑定的那张促销 —— 界面上要写清楚，
 *     否则运维会以为"改券的金额就能改优惠"。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface PromoMeta {
  promo_types: { value: string; label: string }[]
  allocations: { value: string; label: string }[]
  targets: { value: string; label: string }[]
  promo_statuses: { value: string; label: string }[]
  coupon_statuses: { value: string; label: string }[]
  instance_statuses: { value: string; label: string }[]
  points_kinds: { value: string; label: string }[]
  balance_kinds: { value: string; label: string }[]
  levels: MemberLevel[]
  rule_attributes: { value: string; label: string; scope: 'order' | 'item' }[]
  rule_operators: string[]
  settings: { key: string; value: string }[]
}

export interface MemberLevel {
  id: number
  code: string
  name: string
  min_points: number
  min_spent_yuan: number
  /** 等级折扣（万分比，10000 = 不打折） */
  discount_pct: number
  /** 积分倍率（100 = 1 倍） */
  points_rate: number
  /** 积分抵扣上限（万分比，占订单金额） */
  points_deduct_limit: number
  benefits?: string | null
  sort_order: number
  status: string
}

export interface PromotionRow {
  id: number
  code: string
  name: string
  type: 'standard' | 'buyget'
  status: string
  status_label?: string
  type_label?: string
  target_label?: string | null
  campaign_id?: number | null
  campaign_code?: string | null
  campaign_name?: string | null
  is_automatic: number
  is_exclusive: number
  priority: number
  stack_group?: string | null
  usage_limit?: number | null
  used: number
  starts_at?: string | null
  ends_at?: string | null
  remark?: string | null
  method_type?: string
  target_type?: string
  allocation?: string
  value?: number
  max_quantity?: number | null
}

export interface PromotionMethod {
  type: 'fixed' | 'percentage'
  target_type: 'items' | 'order' | 'shipping'
  allocation: 'each' | 'across' | 'once'
  value: number
  max_quantity?: number | null
  buy_rules_min_quantity?: number | null
  apply_to_quantity?: number | null
  gift_sku_id?: number | null
}

export interface PromotionRule {
  attribute: string
  operator: string
  value: string
}

export interface PromotionDetail extends PromotionRow {
  method: PromotionMethod | null
  rules: { rules: PromotionRule[]; target_rules: PromotionRule[]; buy_rules: PromotionRule[] }
  /** 使用汇总：`used_counter` 是促销表上那个计数器，`used_count` 是使用登记条数 —— 两者必须相等 */
  usage_summary?: { used_count: number; used_amount: number; used_counter: number }
}

export interface CampaignRow {
  id: number
  code: string
  name: string
  description?: string | null
  status: string
  starts_at?: string | null
  ends_at?: string | null
  promotion_count?: number
  active_count?: number
  used_amount?: number
}

export interface CouponTemplate {
  id: number
  code: string
  name: string
  promotion_id?: number | null
  promotion_code?: string | null
  type: string
  value: number
  /** 使用门槛，单位 **分**（不是元）—— 展示前只看 `/100`，不要再 ×100 */
  min_subtotal: number
  total_qty?: number | null
  issued_qty: number
  per_user_limit?: number | null
  valid_from?: string | null
  valid_to?: string | null
  valid_days?: number | null
  status: string
  status_label?: string
  remaining?: number | null
  remark?: string | null
}

export interface CouponInstance {
  id: number
  coupon_id: number
  coupon_code: string
  customer_id?: number | null
  status: string
  acquired_at?: string | null
  expires_at?: string | null
  used_at?: string | null
  order_id?: number | null
  used_amount?: number | null
  remark?: string | null
  customer_name?: string | null
  customer_phone?: string | null
  coupon_name?: string | null
  template_code?: string | null
}

export interface MemberAccountRow {
  account_id: number
  customer_id: number
  phone: string
  name: string
  level_code: string
  level_name?: string | null
  discount_pct?: number
  points_rate?: number
  points_deduct_limit?: number
  min_points?: number
  min_spent_yuan?: number
  points: number
  points_total: number
  balance_cents: number
  total_spent_cents: number
  coupon_unused?: number
  coupon_used?: number
  upgraded_at?: string | null
  updated_at?: string | null
}

/**
 * 会员详情。注意流水**不在这里** —— 它由 `/members/:id/ledger` 单独分页返回。
 * 早先把 `points_ledger/balance_ledger` 写进本类型，会让页面拿 `undefined` 去 map，
 * 表现是「流水页签永远空白」而不是报错。
 */
export interface MemberDetail {
  overview: MemberAccountRow
  account: any
  level: MemberLevel | null
  next_level: MemberLevel | null
  /** 到下一级的两个门槛差（"与"关系，缺一不可，所以分开给） */
  gap?: { points?: number | null; spent_yuan?: number | null } | null
  /** 该客户在当前无单情况下的积分抵扣额度（0 元单） */
  deduct_quote?: any
  coupons?: CouponInstance[]
  /** 券张数按状态汇总：[{status, c, amt}] */
  coupon_stat?: { status: string; c: number; amt: number }[]
}

export interface PointsLedgerRow {
  id: number
  customer_id: number
  kind: string
  change_points: number
  balance_after_points: number
  source_type?: string | null
  source_id?: number | null
  doc_no?: string | null
  remark?: string | null
  created_at?: string
}

export interface BalanceLedgerRow {
  id: number
  customer_id: number
  kind: string
  change_cents: number
  balance_after_cents: number
  source_type?: string | null
  source_id?: number | null
  doc_no?: string | null
  remark?: string | null
  created_at?: string
}

export interface CartLineInput {
  item_id?: number
  sku_id: number
  qty: number
  /** 单价（分）；不给则按 SKU 的零售价兜底 */
  unit_price_cents?: number
}

export interface QuoteLine {
  item_id: number | number
  sku_id: number
  subtotal: number
  member_discount: number
  promotion_discount: number
  points_discount: number
  payable: number
}

export interface QuoteResult {
  at: string
  items: any[]
  subtotal: number
  member_discount: number
  promotion_discount: number
  points_discount: number
  points_used: number
  payable: number
  discount_total: number
  line_discounts: QuoteLine[]
  actions: { item_id?: number | null; promotion_id: number; code: string; amount: number; action?: string }[]
  applied_codes: string[]
  traced: { code: string; applied?: number; skipped?: string; by?: string; need?: number; got?: number }[]
  member: { customer_id: number; level_code: string; level_name?: string; discount_pct?: number; points?: number; balance_cents?: number } | null
  coupon: {
    promotion_codes: string[]
    accepted: { coupon_code: string; promotion_code: string; coupon_name?: string }[]
    rejected: { coupon_code: string; reason: string; message: string }[]
    available: {
      usable: { coupon_code: string; promotion_code: string; coupon_name?: string; min_subtotal_cents?: number }[]
      blocked: { coupon_code: string; reason: string; message: string }[]
    }
  }
  points_quote: { limitBp: number; levelLimitBp: number; globalLimitBp: number; maxPoints: number; maxCents: number } | null
}

export interface PromoOverview {
  promotions: { total: number; active: number; automatic: number; exclusive: number }
  coupons: { templates: number; total: number; unused: number; used: number; expired: number; voided: number; used_amount: number }
  members: {
    accounts: number
    points_balance: number
    balance_cents: number
    total_spent_cents: number
    by_level: { level_code: string; level_name: string; c: number }[]
  }
  usage: { promotion_discount: number; orders_hit: number }
}

// ---------------------------------------------------------------------------
// 概览 / 字典 / 对账
// ---------------------------------------------------------------------------

export const PROMO_META = () => data<PromoMeta>(api.get('/promo/meta'))
export const PROMO_OVERVIEW = () => data<PromoOverview>(api.get('/promo/overview'))
export const PROMO_AUDIT = () => data<any>(api.get('/promo/audit'))

// ---------------------------------------------------------------------------
// 会员等级
// ---------------------------------------------------------------------------

export const PROMO_LEVELS = () => data<MemberLevel[]>(api.get('/promo/levels'))
export const PROMO_LEVEL_UPDATE = (code: string, patch: Partial<MemberLevel>) =>
  data<MemberLevel>(api.put(`/promo/levels/${code}`, patch))

// ---------------------------------------------------------------------------
// 活动
// ---------------------------------------------------------------------------

export const PROMO_CAMPAIGNS = (params?: { status?: string; keyword?: string }) =>
  data<CampaignRow[]>(api.get('/promo/campaigns', params))
export const PROMO_CAMPAIGN_CREATE = (body: Partial<CampaignRow>) =>
  data<CampaignRow>(api.post('/promo/campaigns', body))
export const PROMO_CAMPAIGN_STATUS = (id: number, status: string) =>
  data<CampaignRow>(api.post(`/promo/campaigns/${id}/status`, { status }))

// ---------------------------------------------------------------------------
// 促销
// ---------------------------------------------------------------------------

export const PROMO_LIST = (params?: { status?: string; keyword?: string; page?: number; pageSize?: number }) =>
  data<{ list: PromotionRow[]; total: number; page: number; pageSize: number }>(api.get('/promo/promotions', params))
export const PROMO_DETAIL = (id: number | string) => data<PromotionDetail>(api.get(`/promo/promotions/${id}`))
/**
 * 只校验不写库：编辑器"保存前先验一遍"，避免存进去一个永远不会命中的活动。
 * 返回的是 `{ ok, normalized }`（归一化后的草稿），**不是**促销详情。
 */
export const PROMO_VALIDATE = (body: any) => data<{ ok: boolean; normalized: any }>(api.post('/promo/promotions/validate', body))
export const PROMO_CREATE = (body: any) => data<PromotionDetail>(api.post('/promo/promotions', body))
export const PROMO_UPDATE = (id: number | string, body: any) => data<PromotionDetail>(api.put(`/promo/promotions/${id}`, body))
export const PROMO_STATUS = (id: number | string, status: string) =>
  data<PromotionDetail>(api.post(`/promo/promotions/${id}/status`, { status }))
export const PROMO_DELETE = (id: number | string) => api.del(`/promo/promotions/${id}`)

// ---------------------------------------------------------------------------
// 试算 / 结算
// ---------------------------------------------------------------------------

export interface QuoteBody {
  items: CartLineInput[]
  customer_id?: number | null
  coupon_codes?: string[]
  auto_coupon?: boolean
  use_points?: number
  at?: string | null
}

export const PROMO_QUOTE = (body: QuoteBody) => data<QuoteResult>(api.post('/promo/quote', body))
export const PROMO_EXPLAIN = (body: QuoteBody) =>
  data<{ quote: QuoteResult; explain: { totalDiscount: number; appliedCodes: string[]; explanation: string; lines: string[] } }>(
    api.post('/promo/explain', body)
  )
export const PROMO_SETTLE = (body: QuoteBody & { order_id: number; order_amount_for_points?: number | null }) =>
  data<any>(api.post('/promo/settle', body))
export const PROMO_UNSETTLE = (order_id: number, reason?: string) =>
  data<any>(api.post('/promo/unsettle', { order_id, reason }))

// ---------------------------------------------------------------------------
// 券
// ---------------------------------------------------------------------------

export const PROMO_COUPONS = (params?: { status?: string; keyword?: string; page?: number; pageSize?: number }) =>
  data<{ list: CouponTemplate[]; total: number; page: number; pageSize: number }>(api.get('/promo/coupons', params))
export const PROMO_COUPON_DETAIL = (id: number | string) => data<CouponTemplate & { instances?: CouponInstance[] }>(api.get(`/promo/coupons/${id}`))
export const PROMO_COUPON_CREATE = (body: any) => data<CouponTemplate>(api.post('/promo/coupons', body))
export const PROMO_COUPON_UPDATE = (id: number | string, body: any) => data<CouponTemplate>(api.put(`/promo/coupons/${id}`, body))
export const PROMO_COUPON_STATUS = (id: number | string, status: string) =>
  data<CouponTemplate>(api.post(`/promo/coupons/${id}/status`, { status }))
export const PROMO_COUPON_ISSUE = (id: number | string, body: { customer_id: number; qty?: number; remark?: string }) =>
  data<{ coupon_id: number; coupon_name: string; customer_id: number; issued: number; codes: string[] }>(
    api.post(`/promo/coupons/${id}/issue`, body)
  )
/** 到期券批量落库（把 expires_at 已过的一批真的置成 expired） */
export const PROMO_COUPON_EXPIRE = (at?: string) => data<{ expired: number }>(api.post('/promo/coupons/expire', { at: at || null }))

/**
 * 券实例列表。**参数名必须与后端一致**（`customer_id` / `coupon_id`，蛇形）：
 * `client.ts` 把 params 原样拼进 query，写成驼峰会拼出 `?customerId=…`，
 * 后端 `req.query.customer_id` 取不到 → 静默返回**全站**的券，
 * 页面上"某客户的券包"会显示成所有人的券，且不报错。
 */
export const PROMO_INSTANCES = (params?: { customer_id?: number; coupon_id?: number; status?: string; page?: number; pageSize?: number }) =>
  data<{ list: CouponInstance[]; total: number; page: number; pageSize: number }>(api.get('/promo/coupon-instances', params))
export const PROMO_INSTANCE_VOID = (id: number, remark: string) =>
  data<CouponInstance>(api.post(`/promo/coupon-instances/${id}/void`, { remark }))

// ---------------------------------------------------------------------------
// 会员
// ---------------------------------------------------------------------------

/** 会员列表。同上：`level_code` 是蛇形，写驼峰会静默退化成"全量会员"。 */
export const PROMO_MEMBERS = (params?: { keyword?: string; level_code?: string; page?: number; pageSize?: number }) =>
  data<{ list: MemberAccountRow[]; total: number; page: number; pageSize: number }>(api.get('/promo/members', params))
export const PROMO_MEMBER_DETAIL = (customerId: number | string) => data<MemberDetail>(api.get(`/promo/members/${customerId}`))
export const PROMO_MEMBER_LEDGER = (customerId: number | string, params?: { kind?: 'points' | 'balance'; page?: number; pageSize?: number }) =>
  data<{ list: (PointsLedgerRow | BalanceLedgerRow)[]; total: number; page: number; pageSize: number; kind: 'points' | 'balance' }>(
    api.get(`/promo/members/${customerId}/ledger`, params)
  )

/** 人工调整积分（正负均可，**必须写理由**） */
export const PROMO_MEMBER_POINTS = (customerId: number | string, body: { change: number; remark: string }) =>
  data<any>(api.post(`/promo/members/${customerId}/points`, body))
/**
 * 储值：**充值**与**人工调整**是两个口径，接口按 `kind` 分流（`recharge` 走充值、否则走调整）。
 * 分开的理由：充值要记 `doc_no` 走财务，调整是纠错、必须留理由。
 * 混成一个接口会让"这笔钱怎么进来的"查不清。
 */
export const PROMO_MEMBER_RECHARGE = (customerId: number | string, body: { amount_cents: number; doc_no?: string; remark?: string }) =>
  data<any>(api.post(`/promo/members/${customerId}/balance`, { kind: 'recharge', ...body }))
export const PROMO_MEMBER_BALANCE = (customerId: number | string, body: { change_cents: number; remark: string }) =>
  data<any>(api.post(`/promo/members/${customerId}/balance`, body))
/** 人工指定等级（**必须写理由**；会把累计门槛一并抬到达标线） */
export const PROMO_MEMBER_LEVEL = (customerId: number | string, body: { level_code: string; remark: string }) =>
  data<any>(api.post(`/promo/members/${customerId}/level`, body))
/** 强制按规则重判等级（与人工指定区分开） */
export const PROMO_MEMBER_SYNC = (customerId: number | string) =>
  data<any>(api.post(`/promo/members/${customerId}/sync`, {}))
/** 给会员发券（按券模板 id + 张数） */
export const PROMO_MEMBER_ISSUE = (customerId: number | string, body: { coupon_id: number; qty?: number; remark?: string }) =>
  data<any>(api.post(`/promo/members/${customerId}/coupons`, body))

// ---------------------------------------------------------------------------
// C 端（H5 商城，免登录；手机号即身份）
//
// 与后台端点的区别只有一个：**信任级别**。这里只做「查我自己」与「领我自己的券」，
// 不提供任何"面向全站"的写入能力。
// ---------------------------------------------------------------------------

export const SHOP_MEMBER = (phone: string) => data<any>(api.get('/promo/shop/member', { phone }))
/** 活动墙：只列「任何人可参与」的自动促销（要券的那些属于券包，不挂在活动墙上） */
export const SHOP_PROMOTIONS = () => data<any[]>(api.get('/promo/shop/promotions'))
export const SHOP_QUOTE = (body: { phone: string; items: CartLineInput[]; coupon_codes?: string[]; use_points?: number }) =>
  data<QuoteResult>(api.post('/promo/shop/quote', body))
/** 领券（客户自助）：受发行量与每人限领约束，与后台发放同一套校验 */
export const SHOP_CLAIM = (body: { phone: string; coupon_id: number }) => data<any>(api.post('/promo/shop/claim', body))

// ---------------------------------------------------------------------------
// 展示辅助（前端只用它把枚举翻成中文；枚举本身以接口 `meta` 为准）
// ---------------------------------------------------------------------------

export const PROMO_STATUS_CLS: Record<string, string> = {
  active: 'text-green-700 bg-green-50 border-green-200',
  inactive: 'text-slate-500 bg-slate-50 border-slate-200'
}

export const COUPON_STATUS_CLS: Record<string, string> = {
  active: 'text-green-700 bg-green-50 border-green-200',
  inactive: 'text-slate-500 bg-slate-50 border-slate-200',
  ended: 'text-amber-700 bg-amber-50 border-amber-200'
}

export const INSTANCE_STATUS_CLS: Record<string, string> = {
  unused: 'text-brand-700 bg-brand-50 border-brand-200',
  used: 'text-green-700 bg-green-50 border-green-200',
  expired: 'text-amber-700 bg-amber-50 border-amber-200',
  void: 'text-slate-500 bg-slate-50 border-slate-200'
}

export const INSTANCE_STATUS_LABEL: Record<string, string> = {
  unused: '未使用',
  used: '已核销',
  expired: '已过期',
  void: '已作废'
}

/** 万分比 → 「减 X% / 打 X 折」的可读文案（`value` 是**减免率**，别写成折数） */
export function pctText(bp: number): string {
  const p = Number(bp || 0) / 100
  const off = (100 - p).toFixed(0)
  return `${p.toFixed(p % 1 === 0 ? 0 : 1)}%（约 ${(p / 10).toFixed(1)} 折）`
}

export function levelPctText(discountPct: number): string {
  const pay = Number(discountPct || 10000) / 100
  return pay >= 100 ? '无折扣' : `打 ${(pay / 10).toFixed(1)} 折（减 ${(100 - pay).toFixed(1)}%）`
}

/** 方法摘要：一行说清"怎么减" */
export function methodText(m?: PromotionMethod | null): string {
  if (!m) return '未配置'
  const target = m.target_type === 'order' ? '整单' : m.target_type === 'shipping' ? '运费' : '商品行'
  const alloc = m.allocation === 'each' ? '逐行' : m.allocation === 'across' ? '整单分摊' : `限 ${m.max_quantity ?? '?'} 件`
  const amount = m.type === 'percentage' ? `减 ${pctText(m.value)}` : `减 ${(Number(m.value || 0) / 100).toFixed(2)} 元`
  return `${target} · ${alloc} · ${amount}`
}
