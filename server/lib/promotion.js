/**
 * ============================================================================
 * 文件标识：server/lib/promotion.js ｜ 商城促销引擎（P1 · 促销域第一阶段）
 * ============================================================================
 * 【职责】商城促销引擎（P1 · 促销域第一阶段）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

/**
 * 商城促销引擎（P1 · 促销域第一阶段）
 *
 * 这一层只回答三个问题，其它一概不管：
 *   ① 多个活动撞在一起，谁先算、谁不叠加？（sortPromotions + stack_group / is_exclusive）
 *   ② 这一单该减多少、减在哪几行？（computePromotionActions：幂等，全量重算）
 *   ③ 限量券会不会超发？（registerUsage：条件式 UPDATE + 唯一键，不靠「先查后写」）
 *
 * 【来源与许可】
 *   领域模型与三个关键算法参考 medusa `packages/modules/promotion`（MIT，见 _ref/medusa）：
 *     · 优先级裁决器   ← buy-get.ts sortByBuyGetType（买赠优先、同类型按力度降序）
 *     · 防重复打折     ← compute-actions/line-items.ts 的 appliedPromotionsMap（逐行累计已优惠额）
 *     · 防超发         ← services/promotion-module.ts registerUsage（行锁 + 加锁后复读上限）
 *   代码全部按本项目技术栈重写为 Node + better-sqlite3，未整段复制。
 *   priority / stack_group / is_exclusive 三列为 GML 自研补齐（medusa 无此三列）。
 *   ⛔ 未参考 medusa 的 RBAC / SSO 路径（企业版需商业授权）。
 *
 * 【与 medusa 的三处关键差异】
 *   1. SQLite 没有 `SELECT ... FOR UPDATE`。medusa 靠行锁串行化，这里改用
 *      `BEGIN IMMEDIATE`（拿全局写锁）+ 条件式 `UPDATE ... WHERE used < limit`
 *      并用 `changes` 判成败 —— 判断与写入在同一条语句里，不会出现检查间隙。
 *      （medusa 的「按 id 排序加锁避免死锁」经验保留：处理顺序仍按 promotion_id 升序。）
 *   2. 金额一律用「分」的整数运算。折扣要按行占比摊、还要除回去，
 *      REAL 累计会出现分摊尾差导致总优惠与单据对不上（成本域踩过）。
 *   3. **最低价地板**（GML 自研）：每行的可折额要扣掉 `SKU 最低成交价 × 数量`。
 *      medusa 只保证「不超过本行金额」，于是叠加起来能打出**零元单** ——
 *      货出了、钱没进，而所有校验都是绿的。地板按商品属性取，一处生效全局收窄。
 *
 * 【幂等口径】computation 每次全量重算（先清后写），所以订单改价、加行、删行后
 *   重复调用结果是稳定的 —— 这一点和 medusa「先 REMOVE 再 ADD」同源。
 */
import { getDb } from '../db/index.js'

export class PromotionError extends Error {
  constructor(code, message, http = 400, detail = null) {
    super(message)
    this.code = code
    this.http = http
    // **同时写 `.status`**：HTTP 层的统一翻译器 `failFromError` 只认 `error.status`，
    // 全局兜底中间件也只认它。只写 `.http` 的后果是**每一个业务错误都被报成 500** ——
    // 而 500 会把排查方向从「我的参数不对」带偏到「服务器挂了」。
    // （批次 L 动态复现：`POST /api/accounting/vouchers/generate` 传未知 biz_type → 500）
    this.status = http
    this.detail = detail
  }
}

export const PROMO_TYPE = { STANDARD: 'standard', BUYGET: 'buyget' }
export const ALLOCATION = { EACH: 'each', ACROSS: 'across', ONCE: 'once' }
export const TARGET = { ITEMS: 'items', ORDER: 'order', SHIPPING: 'shipping' }
export const PROMO_STATUS_LABEL = { active: '进行中', inactive: '已停用', expired: '已过期' }
export const PROMO_TYPE_LABEL = { standard: '满减/折扣', buyget: '买赠' }
export const ALLOCATION_LABEL = { each: '逐行', across: '整单分摊', once: '限件数' }
export const TARGET_LABEL = { items: '商品行', order: '整单', shipping: '运费' }

const nowText = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

function resolveDb(db) {
  const handle = db ?? getDb()
  if (!handle) throw new PromotionError('DB_UNAVAILABLE', '数据库不可用', 500)
  return handle
}

// ---------------------------------------------------------------------------
// 一、优先级裁决器
// 抄 medusa sortByBuyGetType 的三段语义（买赠优先 → 同类型按力度降序 → 买赠再比门槛），
// 前面再叠 GML 自研的 priority，末尾补一个稳定的字典序兜底 ——
// 兜底不是为了好看：没有全序时，同样的购物车在不同时刻可能算出不同优惠，账单无法复现。
// ---------------------------------------------------------------------------
export function sortPromotions(a, b) {
  // 1) 显式优先级：数值小者先算（GML 自研）
  if ((a.priority ?? 100) !== (b.priority ?? 100)) return (a.priority ?? 100) - (b.priority ?? 100)
  // 2) 买赠优先（抄 medusa）
  if (a.type === PROMO_TYPE.BUYGET && b.type !== PROMO_TYPE.BUYGET) return -1
  if (a.type !== PROMO_TYPE.BUYGET && b.type === PROMO_TYPE.BUYGET) return 1
  // 3) 同类型按优惠力度降序（抄 medusa）
  const av = a.method?.value ?? 0
  const bv = b.method?.value ?? 0
  if (av !== bv) return bv - av
  // 4) 买赠再比门槛，门槛高的先算（抄 medusa）
  if (a.type === PROMO_TYPE.BUYGET) {
    const aq = a.method?.buy_rules_min_quantity ?? 0
    const bq = b.method?.buy_rules_min_quantity ?? 0
    if (aq !== bq) return bq - aq
  }
  // 5) 稳定兜底：按 code 字典序，保证同一输入永远同一结果（可重放）
  return String(a.code).localeCompare(String(b.code))
}

// ---------------------------------------------------------------------------
// 二、规则匹配（简化版 areRulesValidForContext）
// 规则只做比较，不做表达式求值 —— 策略表若能被写成表达式就是注入面
// （casbin 的 eval(p.sub_rule) 正是这个坑，本项目权限域已明确禁用）。
// ---------------------------------------------------------------------------
function matchRule(rule, ctxObj) {
  const actual = ctxObj?.[rule.attribute]
  if (actual === undefined || actual === null) return false
  const raw = String(rule.value ?? '')
  switch (rule.operator) {
    case 'in': {
      return raw.split(',').map((s) => s.trim()).includes(String(actual))
    }
    case 'not_in': {
      return !raw.split(',').map((s) => s.trim()).includes(String(actual))
    }
    case 'eq': return String(actual) === raw
    case 'ne': return String(actual) !== raw
    case 'gt': return Number(actual) > Number(raw)
    case 'gte': return Number(actual) >= Number(raw)
    case 'lt': return Number(actual) < Number(raw)
    case 'lte': return Number(actual) <= Number(raw)
    default: return false
  }
}

function rulesValid(rules, ctxObj) {
  if (!rules || !rules.length) return true
  return rules.every((r) => matchRule(r, ctxObj))
}

// ---------------------------------------------------------------------------
// 三、核心：计算优惠动作（幂等 —— 每次都全量重算，不增量累加）
//
// ctx = {
//   items: [{ id, sku_id, category_id, qty, unit_price, subtotal, is_discountable,
//             price_min_cents, floor_cents }],
//           subtotal / unit_price / floor 都是**分**；
//           `price_min_cents` 是该 SKU 的最低成交价（分/件），`floor_cents` 是本行地板（分），
//           两者都不给 = 无地板（只保证不出现负价）
//   customer: { id, level, ... },
//   subtotal, shipping_fee,
//   codes: ['SUMMER'],            // 用户输入的券码（**促销码**，不是券实例码；券要先翻译）
//   now: '2026-10-15 16:00:00'
// }
// 返回 { actions, totalDiscount, appliedCodes, traced }
//   traced 记录「哪些促销被跳过、为什么」，供界面解释（不影响计算结果）
// ---------------------------------------------------------------------------
export function computePromotionActions(db, ctx = {}) {
  const store = resolveDb(db)
  const items = Array.isArray(ctx.items) ? ctx.items : []
  if (!items.length) return { actions: [], totalDiscount: 0, appliedCodes: [], traced: [] }

  const now = ctx.now ?? nowText()
  const codes = new Set(ctx.codes ?? [])
  const traced = []

  // 1) 取候选：在有效期内 + 已启用；要么券码命中，要么标记为自动促销
  const rows = store.prepare(`
    SELECT * FROM promotions
     WHERE status = 'active'
       AND (starts_at IS NULL OR starts_at <= ?)
       AND (ends_at   IS NULL OR ends_at   >= ?)
  `).all(now, now)

  const candidates = []
  for (const p of rows) {
    if (!p.is_automatic && !codes.has(p.code)) {
      traced.push({ code: p.code, skipped: 'need_code' })
      continue
    }
    const method = store.prepare('SELECT * FROM promotion_methods WHERE promotion_id = ?').get(p.id)
    if (!method) {
      traced.push({ code: p.code, skipped: 'no_method' })
      continue
    }
    const rules = store.prepare('SELECT * FROM promotion_rules WHERE promotion_id = ?').all(p.id)
    candidates.push({
      ...p,
      method,
      rules: rules.filter((r) => r.rule_group === 'rules'),
      targetRules: rules.filter((r) => r.rule_group === 'target_rules'),
      buyRules: rules.filter((r) => r.rule_group === 'buy_rules')
    })
  }

  // 2) 订单级适用条件过滤（如「仅限黄金会员」「满 5000 才可用」）
  let eligible = candidates.filter((p) => {
    const hit = rulesValid(p.rules, { ...ctx.customer, subtotal: ctx.subtotal, shipping_fee: ctx.shipping_fee })
    if (!hit) traced.push({ code: p.code, skipped: 'order_rule' })
    return hit
  })

  // 3) 排序裁决
  eligible = eligible.sort(sortPromotions)

  // 4) 逐个计算；appliedMap 累计每行已优惠额（抄 medusa line-items.ts 的 appliedPromotionsMap）
  const appliedMap = new Map() // itemId -> 已优惠额（分）
  const actions = []
  const usedGroups = new Set() // stack_group 同组互斥
  let exclusiveHit = null
  let totalDiscount = 0

  for (const p of eligible) {
    if (exclusiveHit) {
      traced.push({ code: p.code, skipped: 'exclusive_hit', by: exclusiveHit })
      continue
    }
    if (p.stack_group && usedGroups.has(p.stack_group)) {
      traced.push({ code: p.code, skipped: 'stack_group', group: p.stack_group })
      continue
    }
    if (p.usage_limit != null && p.used >= p.usage_limit) {
      traced.push({ code: p.code, skipped: 'usage_limit' })
      continue
    }

    const applicableItems = items.filter((it) => {
      if (it.is_discountable === 0) return false // 不可打折商品直接跳过
      if (!(Number(it.subtotal) > 0) || !Number(it.qty)) return false
      return rulesValid(p.targetRules, it)
    })
    if (!applicableItems.length) {
      traced.push({ code: p.code, skipped: 'no_target' })
      continue
    }

    let stepActions = []
    if (p.type === PROMO_TYPE.BUYGET) {
      // 买赠有自己的件数口径，与 target_type 无关 —— 必须在前面拦一道，
      // 否则它会掉进 applyToItems 走「固定减免」那条路（value 通常是 0 → 永不生效）
      const bg = applyBuyGet(p, applicableItems, appliedMap)
      if (bg.skipped) {
        traced.push({ code: p.code, skipped: bg.skipped, need: bg.need, got: bg.got })
        continue
      }
      stepActions = bg.actions
    } else if (p.method.target_type === TARGET.ITEMS) {
      stepActions = applyToItems(p, applicableItems, appliedMap)
    } else if (p.method.target_type === TARGET.ORDER) {
      stepActions = applyToOrder(p, applicableItems, appliedMap)
    }
    if (!stepActions.length) {
      traced.push({ code: p.code, skipped: 'no_effect' })
      continue
    }

    // 同组互斥：本促销生效后，同组其它促销不再参与
    if (p.stack_group) usedGroups.add(p.stack_group)
    for (const a of stepActions) {
      actions.push(a)
      totalDiscount += a.amount
    }
    traced.push({ code: p.code, applied: stepActions.reduce((s, a) => s + a.amount, 0) })
    if (p.is_exclusive) {
      // 独占命中后不再 break —— 继续走一遍循环只为把「被谁拦下的」记进 traced，
      // 界面上要能回答「我那张券为什么没生效」。计算结果与 break 完全等价。
      exclusiveHit = p.code
    }
  }

  return {
    actions,
    totalDiscount,
    appliedCodes: [...new Set(actions.map((a) => a.code))],
    traced
  }
}

// ---------------------------------------------------------------------------
// 四、按行计算（allocation: each / across / once）
// 骨架抄 medusa line-items.ts 的 applyPromotionToItems，改为整数分运算并补齐整单分摊。
//
// 【最低价地板】`baseOf` 里扣掉了 `floorOf(it)` —— 这是本项目对 medusa 的**第二处实质增强**。
//
// 光靠「每行优惠不超过本行剩余额」只能保证不出现**负价**，保证不了不出现**零元单**：
//   满 200 减 200 的券 + 商家 9 折 + 平台补贴 50 叠加起来，可以把 200 元的单打到 0 元。
//   0 元单在业务上是事故 —— 货出了、钱没进，而所有校验都是绿的。
// 所以地板按 **SKU 的最低成交价**取（`product_skus.price_min`，营销域早就维护着这一列，
// 只是此前没有谁真正用它挡过折扣）。地板一扣，「可折额」天然收窄，
// 后面 allcation 的三种分配逻辑不需要各自再判一次 —— **一处地板，全局生效**。
//
// 为什么地板按 SKU 而不是全局一个百分比：地板要回答的是「这件货最低能卖多少钱」，
// 那是一个**商品的属性**（成本 + 策略），不是一个活动参数。
// ---------------------------------------------------------------------------
function applyToItems(p, items, appliedMap) {
  const m = p.method
  const out = []
  const list = [...items]
  const baseOf = (it) => Math.max(0, Number(it.subtotal) - (appliedMap.get(it.id) ?? 0) - floorOf(it))

  // once：只作用于最便宜的 N 件 —— 抄 medusa 的 sortLineItemByPriceAscending
  if (m.allocation === ALLOCATION.ONCE) {
    list.sort((a, b) => (Number(a.subtotal) / Number(a.qty)) - (Number(b.subtotal) / Number(b.qty)))
  }

  // across：先按「整单基数」算一次总额，再按各行剩余额占比摊回去（便于后续退款按行拆分）
  if (m.allocation === ALLOCATION.ACROSS) {
    const baseTotal = list.reduce((acc, it) => acc + baseOf(it), 0)
    if (baseTotal <= 0) return []
    const total = Math.min(calcAmount(m, baseTotal), baseTotal)
    if (total <= 0) return []
    let allocated = 0
    list.forEach((it, idx) => {
      const base = baseOf(it)
      const amount = Math.min(
        idx === list.length - 1 ? total - allocated : Math.round((total * base) / baseTotal),
        base
      )
      if (amount <= 0) return
      allocated += amount
      pushAdjustment(out, appliedMap, p, it.id, amount)
    })
    return out
  }

  // each / once：逐行独立计算，且每行不超过自己的剩余可折额
  let remainingQuota = m.max_quantity ?? 0
  for (const it of list) {
    if (m.allocation === ALLOCATION.ONCE && remainingQuota <= 0) break
    const base = baseOf(it)
    if (base <= 0) continue

    const effQty = m.allocation === ALLOCATION.ONCE
      ? Math.min(remainingQuota, Number(it.qty))
      : Number(it.qty)

    const unit = Number(it.subtotal) / Number(it.qty)
    const amount = Math.min(
      calcAmount(m, m.allocation === ALLOCATION.ONCE ? Math.round(unit * effQty) : base),
      base
    )
    if (amount <= 0) continue

    if (m.allocation === ALLOCATION.ONCE) remainingQuota -= effQty
    pushAdjustment(out, appliedMap, p, it.id, amount)
  }
  return out
}

// ---------------------------------------------------------------------------
// 买赠（type = buyget）
//
// ===== 为什么必须有这个函数 =====
// 买赠曾经**只入库、不生效**：`promotions.type` 存了 `buyget`、方法里也存了
// `buy_rules_min_quantity` / `apply_to_quantity` / `gift_sku_id`，
// 但引擎只按 `target_type` 走 `applyToItems` / `applyToOrder`，
// 从头到尾没人读过 `buy_rules`。后果是：一张"买 3 送 1"的促销，
// 界面上是「进行中」、`traced` 里连一条跳过记录都没有，而优惠额恒为 0 ——
// 既没有报错，也无法从任何字段看出它没起作用。
// （曾经的做法是让 `value` 里填赠品价 —— 那是拿"固定减免"冒充买赠，
//   件数条件完全没参与判断，买 1 件也照减。）
//
// ===== 口径（写死在这里，不允许散落） =====
//   ① 能不能触发：**参与行的数量合计** ≥ `buy_rules_min_quantity`，否则不生效并记原因；
//   ② 触发几次：`floor(数量合计 ÷ 门槛)`；
//   ③ 一共免几件：`次数 × apply_to_quantity`；
//   ④ 免的是哪几件：**单价由低到高**（与 `allocation=once` 同一取向 ——
//      只作用于最便宜的件）。反过来取最贵的会让"买 3 送 1"变成一次大额让利，
//      力度随顾客挑什么而变，促销预算完全不可预测；
//   ⑤ 每件最多抵到地板（`price_min`），与其它方式共用同一处地板，不另开一套；
//   ⑥ 总抵扣不超过该行剩余可折额。
//
// `gift_sku_id` **不参与算钱**，只是给界面/拣货的提示：本引擎不往购物车里加行，
// 赠品若不在购物车里就没有价格可抵。真要"送一件实物"，正确做法是加一行
// `is_discountable=0` 的赠品行再按行减免，那是调用方（结算层）的事。
// ---------------------------------------------------------------------------
function applyBuyGet(p, items, appliedMap) {
  const m = p.method
  const needQty = Number(m.buy_rules_min_quantity) || 0
  const giftQty = Number(m.apply_to_quantity) || 0
  if (needQty <= 0 || giftQty <= 0) return { actions: [], skipped: 'buyget_misconfigured' }

  const totalQty = items.reduce((s, it) => s + (Number(it.qty) || 0), 0)
  if (totalQty < needQty) return { actions: [], skipped: 'buy_rules', need: needQty, got: totalQty }

  const pool = []
  for (const it of items) {
    const qty = Number(it.qty) || 0
    if (qty <= 0) continue
    const base = Math.max(0, Number(it.subtotal) - (appliedMap.get(it.id) ?? 0) - floorOf(it))
    if (base <= 0) continue
    pool.push({ it, qty, unit: Number(it.subtotal) / qty, base })
  }
  if (!pool.length) return { actions: [], skipped: 'no_target' }

  const times = Math.floor(totalQty / needQty)
  let freeUnits = times * giftQty
  pool.sort((a, b) => a.unit - b.unit)

  const out = []
  for (const { it, qty, unit } of pool) {
    if (freeUnits <= 0) break
    if (!(unit > 0)) continue
    const base = Math.max(0, Number(it.subtotal) - (appliedMap.get(it.id) ?? 0) - floorOf(it))
    const byBase = Math.floor(base / unit)
    const give = Math.min(freeUnits, qty, Math.max(0, byBase))
    if (give <= 0) continue
    const amount = Math.min(Math.round(unit * give), base)
    if (amount <= 0) continue
    pushAdjustment(out, appliedMap, p, it.id, amount)
    freeUnits -= give
  }
  return { actions: out, gift_units: times * giftQty - freeUnits, times }
}

// 整单级优惠：算一次总额，按行剩余额占比摊回每一行（末行兜底消除尾差）
function applyToOrder(p, items, appliedMap) {
  const m = p.method
  const baseOf = (it) => Math.max(0, Number(it.subtotal) - (appliedMap.get(it.id) ?? 0) - floorOf(it))
  const baseTotal = items.reduce((acc, it) => acc + baseOf(it), 0)
  if (baseTotal <= 0) return []
  const total = Math.min(calcAmount(m, baseTotal), baseTotal)
  if (total <= 0) return []

  const out = []
  let allocated = 0
  items.forEach((it, idx) => {
    const base = baseOf(it)
    const amount = Math.min(
      idx === items.length - 1 ? total - allocated : Math.round((total * base) / baseTotal),
      base
    )
    if (amount <= 0) return
    allocated += amount
    pushAdjustment(out, appliedMap, p, it.id, amount, 'add_order_adjustment')
  })
  return out
}

function pushAdjustment(out, appliedMap, p, itemId, amount, action = 'add_item_adjustment') {
  appliedMap.set(itemId, (appliedMap.get(itemId) ?? 0) + amount)
  out.push({ action, promotion_id: p.id, code: p.code, item_id: itemId, amount })
}

/**
 * 本行的**不可折底价**（分）= SKU 最低成交价 × 数量。
 *
 * 取值优先级（都读得到就用更严的那个）：
 *   `it.floor_cents`    调用方直接给的行地板（结算时已按商品策略算好）
 *   `it.price_min_cents` SKU 最低成交价（分/件）
 * 两者都没给就是 0（无地板）—— **测试与内部试算不传就退化成"只保证不出现负价"**，
 * 这正是本次增强前的行为，所以对既有调用方是向后兼容的。
 */
function floorOf(it) {
  const qty = Math.max(0, Number(it.qty) || 0)
  if (it.floor_cents != null) return Math.max(0, Math.round(Number(it.floor_cents) || 0))
  const per = Number(it.price_min_cents)
  if (!Number.isFinite(per) || per <= 0) return 0
  return Math.round(per * qty)
}

// 金额计算：percentage 用万分比（1500 = 15.00%），fixed 直接取「分」。
//
// fixed 的口径要说清楚，否则后来人会以为「每件再乘数量」：
//   value 是**本次应用对该目标（一行 / 整单）的固定减免额**，不随件数放大。
//   要表达「每件减 N 元」，用 percentage；或按件数拆成多条目标规则 —— 别在这里加隐式乘法，
//   否则「整单分摊」与「限件数」两种 allocation 下同一张券会算出两个不同结果。
// value_scale 列是给「value 里存百分数（15 表示 15%）」的历史写法预留的，
// 当前所有写入方都用万分比（value_scale=0），读侧不依赖它。
function calcAmount(m, base) {
  const v = Number(m.value) || 0
  if (m.type === 'percentage') return Math.round((base * v) / 10000)
  return Math.max(0, Math.min(v, base))
}

// ---------------------------------------------------------------------------
// 五、落库：全量重算（先清后写），天然幂等
// ---------------------------------------------------------------------------
export function persistAdjustments(db, { source, orderId, actions } = {}) {
  const store = resolveDb(db)
  if (orderId == null) throw new PromotionError('BAD_ARGS', '缺少 orderId', 400)
  // `source` 必填（迁移 030）：`oms_orders.id` 与 `pos_orders.id` 会撞号，
  // 只按 order_id 删除会把「另一张同号的单」的留痕一起清掉 —— 不报错，只让账对不上。
  if (!source) throw new PromotionError('BAD_ARGS', '缺少 source（留痕必须能定位到唯一一张单）', 400)
  const run = () => {
    store.prepare('DELETE FROM promotion_adjustments WHERE source = ? AND order_id = ?').run(source, orderId)
    const ins = store.prepare(`
      INSERT INTO promotion_adjustments (source, order_id, item_id, promotion_id, code, amount, action)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const a of actions ?? []) {
      ins.run(source, orderId, a.item_id ?? null, a.promotion_id, a.code, a.amount, a.action ?? 'add_item_adjustment')
    }
  }
  const tx = store.transaction(run)
  tx.immediate()
  return (actions ?? []).length
}

// ---------------------------------------------------------------------------
// 六、使用登记：防超发（SQLite 版）
//
// medusa 原实现（promotion-module.ts registerUsage）：一个事务里 SELECT ... FOR UPDATE
// 锁住 promotion 与 budget 行，且「按 id 排序加锁」防死锁，加锁后复读 used 再判上限。
// SQLite 没有行锁，这里两道替代同时上：
//   ① BEGIN IMMEDIATE 拿全局写锁（better-sqlite3 的 tx.immediate()）—— 保证串行
//   ② 条件式 UPDATE（WHERE used < usage_limit）+ changes 判成败 —— 判断与写入原子
// 另外用 idempotency_key 唯一键兜底：同一订单同一促销重复登记会被数据库直接挡住。
// ---------------------------------------------------------------------------
export function registerUsage(db, { source, actions, orderId, customerId } = {}) {
  const store = resolveDb(db)
  if (!source) throw new PromotionError('BAD_ARGS', '缺少 source（使用登记必须能定位到唯一一张单）', 400)
  const byPromo = new Map()
  for (const a of actions ?? []) {
    const cur = byPromo.get(a.promotion_id) ?? { amount: 0, code: a.code }
    cur.amount += a.amount
    byPromo.set(a.promotion_id, cur)
  }
  if (!byPromo.size) return { registered: 0, skipped: [] }

  const run = () => {
    const skipped = []
    // 按 promotion_id 升序处理 —— 对应 medusa「按 id 排序加锁避免死锁」的经验
    const ids = [...byPromo.keys()].sort((x, y) => x - y)

    for (const pid of ids) {
      const { amount, code } = byPromo.get(pid)
      // 幂等键**必须带通道**：否则「商城第 418 单」与「门店第 418 单」的键完全相同，
      // 第二张单会被判成重复而**静默不登记**（限量券名额凭空少一个）。
      const idemKey = `${source}:order:${orderId ?? 'null'}:promo:${code}`

      const dup = store.prepare('SELECT id FROM promotion_usages WHERE idempotency_key = ?').get(idemKey)
      if (dup) {
        skipped.push({ code, reason: 'duplicate' })
        continue
      }

      const info = store.prepare(`
        UPDATE promotions SET used = used + 1, updated_at = datetime('now','localtime')
         WHERE id = ? AND (usage_limit IS NULL OR used < usage_limit)
      `).run(pid)
      if (info.changes === 0) {
        skipped.push({ code, reason: 'usage_limit_exceeded' })
        continue
      }

      store.prepare(`
        INSERT INTO promotion_usages (source, promotion_id, order_id, customer_id, amount, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(source, pid, orderId ?? null, customerId ?? null, amount, idemKey)

      // 预算扣减（spend 口径），同样条件式更新防超支
      store.prepare(`
        UPDATE promotion_campaign_budgets
           SET used = used + ?
         WHERE campaign_id = (SELECT campaign_id FROM promotions WHERE id = ?)
           AND type = 'spend'
           AND (limit_amt IS NULL OR used + ? <= limit_amt)
      `).run(amount, pid, amount)
    }
    return skipped
  }
  const tx = store.transaction(run)
  const skipped = tx.immediate()
  return { registered: byPromo.size - skipped.length, skipped }
}

// ---------------------------------------------------------------------------
// 七、撤销使用（退款 / 取消订单时回退）
// 回退同样走「明细是唯一真相」：先按 promotion_usages 明细逐笔减，再删明细，
// 避免像成本域那样「用自加计数减一次」导致对不上账。
// ---------------------------------------------------------------------------
export function revertUsage(db, { source, orderId } = {}) {
  const store = resolveDb(db)
  if (orderId == null) throw new PromotionError('BAD_ARGS', '缺少 orderId', 400)
  if (!source) throw new PromotionError('BAD_ARGS', '缺少 source（撤销必须只撤自己这一张单）', 400)
  const run = () => {
    const rows = store
      .prepare('SELECT * FROM promotion_usages WHERE source = ? AND order_id = ?')
      .all(source, orderId)
    for (const u of rows) {
      store.prepare(`UPDATE promotions SET used = MAX(0, used - 1), updated_at = datetime('now','localtime') WHERE id = ?`).run(u.promotion_id)
      store.prepare(`
        UPDATE promotion_campaign_budgets SET used = MAX(0, used - ?)
         WHERE campaign_id = (SELECT campaign_id FROM promotions WHERE id = ?) AND type = 'spend'
      `).run(u.amount, u.promotion_id)
    }
    store.prepare('DELETE FROM promotion_usages WHERE source = ? AND order_id = ?').run(source, orderId)
    const del = store
      .prepare('DELETE FROM promotion_adjustments WHERE source = ? AND order_id = ?')
      .run(source, orderId)
    return { usages: rows.length, adjustments: del.changes }
  }
  const tx = store.transaction(run)
  return tx.immediate()
}

// ---------------------------------------------------------------------------
// 八、查询与解释（给界面用：列表页、详情页、「为什么是这个优惠」）
// ---------------------------------------------------------------------------
export function listPromotions(db, { status = null, keyword = null, page = 1, pageSize = 20 } = {}) {
  const store = resolveDb(db)
  const where = []
  const params = []
  if (status) {
    where.push('p.status = ?')
    params.push(status)
  }
  if (keyword) {
    where.push('(p.code LIKE ? OR p.name LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = store.prepare(`SELECT COUNT(*) AS c FROM promotions p ${clause}`).get(...params).c
  const off = (Math.max(1, page) - 1) * pageSize
  const rows = store.prepare(`
    SELECT p.*, c.code AS campaign_code, c.name AS campaign_name,
           m.type AS method_type, m.target_type, m.allocation, m.value, m.max_quantity
      FROM promotions p
      LEFT JOIN promotion_campaigns c ON c.id = p.campaign_id
      LEFT JOIN promotion_methods   m ON m.promotion_id = p.id
      ${clause}
     ORDER BY p.status = 'active' DESC, p.priority ASC, p.id DESC
     LIMIT ? OFFSET ?
  `).all(...params, pageSize, off)
  return {
    list: rows.map((r) => ({
      ...r,
      status_label: PROMO_STATUS_LABEL[r.status] ?? r.status,
      type_label: PROMO_TYPE_LABEL[r.type] ?? r.type,
      target_label: r.target_type ? TARGET_LABEL[r.target_type] ?? r.target_type : null
    })),
    total,
    page,
    pageSize
  }
}

export function getPromotionDetail(db, id) {
  const store = resolveDb(db)
  const p = store.prepare('SELECT * FROM promotions WHERE id = ? OR code = ?').get(id, id)
  if (!p) throw new PromotionError('NOT_FOUND', `促销不存在：${id}`, 404)
  const method = store.prepare('SELECT * FROM promotion_methods WHERE promotion_id = ?').get(p.id) ?? null
  const rules = store.prepare('SELECT * FROM promotion_rules WHERE promotion_id = ? ORDER BY rule_group, id').all(p.id)
  const usage = store.prepare('SELECT COALESCE(SUM(amount),0) AS amt, COUNT(*) AS cnt FROM promotion_usages WHERE promotion_id = ?').get(p.id)
  return {
    ...p,
    status_label: PROMO_STATUS_LABEL[p.status] ?? p.status,
    method,
    rules: {
      rules: rules.filter((r) => r.rule_group === 'rules'),
      target_rules: rules.filter((r) => r.rule_group === 'target_rules'),
      buy_rules: rules.filter((r) => r.rule_group === 'buy_rules')
    },
    usage_summary: { used_count: usage.cnt, used_amount: usage.amt, used_counter: p.used }
  }
}

/**
 * 解释链：界面上要能回答「为什么是这么多优惠 / 那个券为什么没用上」。
 * 返回 { totalDiscount, appliedCodes, explanation, lines }
 */
export function explainPromotion(db, ctx = {}) {
  const r = computePromotionActions(db, ctx)
  const SKIP_LABEL = {
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
  const lines = []
  for (const t of r.traced) {
    if (t.applied != null) lines.push(`✅ ${t.code} 生效，优惠 ${(t.applied / 100).toFixed(2)} 元`)
    else {
      const why = SKIP_LABEL[t.skipped] ?? t.skipped
      const extra = t.by ? `（被 ${t.by} 独占）` : (t.need != null ? `（需要 ${t.need} 件，实际 ${t.got} 件）` : '')
      lines.push(`⏭️ ${t.code} 未生效：${why}${extra}`)
    }
  }
  const head = r.appliedCodes.length
    ? `本单共优惠 ${(r.totalDiscount / 100).toFixed(2)} 元，生效活动：${r.appliedCodes.join('、')}`
    : '本单未命中任何促销'
  return { totalDiscount: r.totalDiscount, appliedCodes: r.appliedCodes, explanation: [head, ...lines].join('\n'), lines, actions: r.actions }
}

// ---------------------------------------------------------------------------
// 九、活动与促销的编辑（写库）
//
// 这一节只做**校验 + 落库**，不含任何算钱逻辑 —— 算钱的唯一入口是
// `computePromotionActions`。这样"界面能存的东西"与"引擎认得的东西"不会分成两套。
//
// 校验为什么必须在这里（而不是只在校验函数里给界面用）：活动是可以**导入**的
// （seed / 迁移 / 将来对接外部营销平台），导入路径不过界面。校验放在服务层，
// 两条入口共用同一份判断。
// ---------------------------------------------------------------------------

// 规则属性白名单。**不接受任意 key** —— 属性名会被当成 ctxObj 的键去取，
// 开放任意 key 等于让调用方探任意对象属性（同权限域 eval 注入的坑）。
const RULE_ATTRS = [
  'sku_id', 'category_id', 'qty', 'unit_price', 'subtotal',
  'shipping_fee', 'level', 'level_code', 'customer_id'
]
const RULE_OPS = ['in', 'not_in', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte']
const RULE_GROUPS = ['rules', 'target_rules', 'buy_rules']
const METHOD_TYPES = ['fixed', 'percentage']

function fail(code, message, httpStatus = 400, detail = null) {
  throw new PromotionError(code, message, httpStatus, detail)
}

function normalizeMethod(m = {}) {
  const type = String(m.type ?? 'fixed')
  if (!METHOD_TYPES.includes(type)) {
    fail('BAD_METHOD_TYPE', `优惠方式 type 只支持 ${METHOD_TYPES.join(' / ')}，收到：${type}`)
  }
  const targetType = String(m.target_type ?? TARGET.ORDER)
  if (!Object.values(TARGET).includes(targetType)) {
    fail('BAD_TARGET_TYPE', `target_type 只支持 items / order / shipping，收到：${targetType}`)
  }
  const allocation = String(m.allocation ?? ALLOCATION.ACROSS)
  if (!Object.values(ALLOCATION).includes(allocation)) {
    fail('BAD_ALLOCATION', `allocation 只支持 each / across / once，收到：${allocation}`)
  }
  const value = Math.round(Number(m.value ?? 0))
  if (!Number.isFinite(value) || value < 0) fail('BAD_METHOD_VALUE', '优惠值必须是不小于 0 的数字')
  // ⚠️ percentage 的 value 是**减免率**的万分比，不是"折数"：
  //    500 = 减 5%（95 折）· 1000 = 减 10%（9 折）· 10000 = 全免。
  //    这里曾经把口径写成"10000 = 不打折 / 9000 = 9 折"，与 `calcAmount` 的
  //    `base * v / 10000` 正好相反 —— 会让人把 9 折写成 9000，实际减掉 90%。
  //    方向错了不会报错，只会让优惠额大十倍。
  if (type === 'percentage' && value > 10000) {
    fail('BAD_METHOD_VALUE',
      `percentage 的 value 是**减免率**万分比（10000 = 全免，1000 = 减 10% 即 9 折），${value} 超过 10000 会被地基截断成免费单`)
  }
  const out = {
    type,
    target_type: targetType,
    allocation,
    value,
    value_scale: Math.round(Number(m.value_scale ?? 0)) || 0,
    max_quantity: m.max_quantity == null ? null : Math.max(0, Math.round(Number(m.max_quantity))),
    buy_rules_min_quantity: m.buy_rules_min_quantity == null ? null : Math.max(0, Math.round(Number(m.buy_rules_min_quantity))),
    apply_to_quantity: m.apply_to_quantity == null ? null : Math.max(0, Math.round(Number(m.apply_to_quantity))),
    gift_sku_id: m.gift_sku_id == null ? null : Math.round(Number(m.gift_sku_id))
  }
  // 买赠豁免 max_quantity：买赠的件数由 buy_rules_min_quantity / apply_to_quantity 决定。
  // 这里只看「方式里有没有买赠字段」，因为 normalizeMethod 不知道促销的 type
  // （type 是 promotions 表的列，不是 method 的列）—— 类型级的必填校验在
  // validatePromotionDraft 里做。
  const isBuyGetStyle = m.apply_to_quantity != null || m.buy_rules_min_quantity != null
  if (allocation === ALLOCATION.ONCE && out.max_quantity == null && !isBuyGetStyle) {
    // once = "只作用于最便宜的 N 件"。不给 N 就等于"作用 0 件"，
    // 促销会静默不生效（traced 里只是一条 no_effect），界面上看不出原因。
    fail('BAD_ALLOCATION', 'allocation=once 必须同时给 max_quantity（作用于几件）')
  }
  return out
}

function normalizeRules(list, group) {
  if (list == null) return []
  if (!Array.isArray(list)) fail('BAD_RULES', `${group} 必须是数组`)
  return list.map((r, i) => {
    const attribute = String(r.attribute ?? '')
    if (!RULE_ATTRS.includes(attribute)) {
      fail('BAD_RULE_ATTR', `${group}[${i}] 的 attribute「${attribute}」不在允许列表（${RULE_ATTRS.join('/')}）`)
    }
    const operator = String(r.operator ?? '')
    if (!RULE_OPS.includes(operator)) {
      fail('BAD_RULE_OP', `${group}[${i}] 的 operator「${operator}」不在允许列表（${RULE_OPS.join('/')}）`)
    }
    if (r.value == null || String(r.value) === '') fail('BAD_RULE_VALUE', `${group}[${i}] 缺 value`)
    return { rule_group: group, attribute, operator, value: String(r.value) }
  })
}

/** 校验一份促销草稿（不写库）。返回归一化后的对象，供 create/update/seed 共用。 */
export function validatePromotionDraft(db, payload = {}) {
  const code = String(payload.code ?? '').trim()
  const name = String(payload.name ?? '').trim()
  if (!code) fail('BAD_ARGS', '促销编码 code 必填')
  if (!name) fail('BAD_ARGS', '促销名称 name 必填')
  const type = String(payload.type ?? PROMO_TYPE.STANDARD)
  if (!Object.values(PROMO_TYPE).includes(type)) fail('BAD_ARGS', `type 只支持 standard / buyget`)
  const status = String(payload.status ?? 'active')
  if (!['active', 'inactive'].includes(status)) fail('BAD_ARGS', 'status 只支持 active / inactive')

  const startsAt = payload.starts_at ?? null
  const endsAt = payload.ends_at ?? null
  if (startsAt && endsAt && String(startsAt) > String(endsAt)) {
    // 时间窗反了的话促销永远不命中，而界面上它是一个"进行中"的活动
    fail('BAD_WINDOW', `起止时间写反了：starts_at ${startsAt} 晚于 ends_at ${endsAt}`)
  }

  const usageLimit = payload.usage_limit == null ? null : Math.max(0, Math.round(Number(payload.usage_limit)))
  const method = normalizeMethod(payload.method ?? {})
  const isBuyGet = type === PROMO_TYPE.BUYGET
  if (isBuyGet) {
    if (method.buy_rules_min_quantity == null || method.buy_rules_min_quantity <= 0) {
      fail('BAD_BUYGET', '买赠促销必须给 buy_rules_min_quantity（买几件）')
    }
    if (method.apply_to_quantity == null || method.apply_to_quantity <= 0) {
      // 买赠必给"送几件"，否则引擎算不出抵扣多少（见 applyBuyGet）
      fail('BAD_BUYGET', '买赠促销必须给 apply_to_quantity（每次送几件）')
    }
  }
  const isExclusive = payload.is_exclusive ? 1 : 0
  const stackGroup = payload.stack_group ? String(payload.stack_group) : null
  if (isExclusive && stackGroup) {
    // 独占 = "我一生效，别的都别算"；stack_group = "同组只取最优"。
    // 两个一起配语义打架：独占已经把别人全挡了，同组规则永远不会被触发。
    // 不报错的话会让人以为"同组还有更优的"，实际是独占吃掉了整张单。
    fail('BAD_ARGS', 'is_exclusive 与 stack_group 不能同时设置（语义冲突，见注释）')
  }
  return {
    code, name, type, status,
    campaign_id: payload.campaign_id == null ? null : Math.round(Number(payload.campaign_id)),
    is_automatic: payload.is_automatic ? 1 : 0,
    is_tax_inclusive: payload.is_tax_inclusive ? 1 : 0,
    priority: Number.isFinite(Number(payload.priority)) ? Math.round(Number(payload.priority)) : 100,
    stack_group: stackGroup,
    is_exclusive: isExclusive,
    usage_limit: usageLimit,
    starts_at: startsAt,
    ends_at: endsAt,
    remark: payload.remark ? String(payload.remark) : null,
    method,
    rules: {
      rules: normalizeRules(payload.rules?.rules ?? payload.rules_list, 'rules'),
      target_rules: normalizeRules(payload.rules?.target_rules ?? payload.target_rules, 'target_rules'),
      buy_rules: normalizeRules(payload.rules?.buy_rules ?? payload.buy_rules, 'buy_rules')
    }
  }
}

function writeMethod(store, promotionId, method) {
  store.prepare('DELETE FROM promotion_methods WHERE promotion_id = ?').run(promotionId)
  store.prepare(`
    INSERT INTO promotion_methods
      (promotion_id,type,target_type,allocation,value,value_scale,max_quantity,
       buy_rules_min_quantity,apply_to_quantity,gift_sku_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(promotionId, method.type, method.target_type, method.allocation, method.value,
    method.value_scale, method.max_quantity, method.buy_rules_min_quantity,
    method.apply_to_quantity, method.gift_sku_id)
}

function writeRules(store, promotionId, rules) {
  store.prepare('DELETE FROM promotion_rules WHERE promotion_id = ?').run(promotionId)
  const ins = store.prepare(
    'INSERT INTO promotion_rules (promotion_id,rule_group,attribute,operator,value) VALUES (?,?,?,?,?)'
  )
  for (const g of RULE_GROUPS) {
    for (const r of rules[g] ?? []) ins.run(promotionId, g, r.attribute, r.operator, r.value)
  }
}

export function createPromotion(db, payload = {}) {
  const store = resolveDb(db)
  const d = validatePromotionDraft(store, payload)
  if (store.prepare('SELECT 1 AS hit FROM promotions WHERE code = ?').get(d.code)) {
    fail('DUPLICATE_CODE', `促销编码已存在：${d.code}`, 409)
  }
  if (d.campaign_id != null
    && !store.prepare('SELECT 1 AS hit FROM promotion_campaigns WHERE id = ?').get(d.campaign_id)) {
    fail('CAMPAIGN_NOT_FOUND', `活动不存在：${d.campaign_id}`, 404)
  }
  const tx = store.transaction(() => {
    const info = store.prepare(`
      INSERT INTO promotions
        (code,name,type,status,campaign_id,is_automatic,is_tax_inclusive,priority,
         stack_group,is_exclusive,usage_limit,used,starts_at,ends_at,remark)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)
    `).run(d.code, d.name, d.type, d.status, d.campaign_id, d.is_automatic, d.is_tax_inclusive,
      d.priority, d.stack_group, d.is_exclusive, d.usage_limit, d.starts_at, d.ends_at, d.remark)
    const id = Number(info.lastInsertRowid)
    writeMethod(store, id, d.method)
    writeRules(store, id, d.rules)
    return id
  })
  const id = tx.immediate()
  return getPromotionDetail(store, id)
}

export function updatePromotion(db, id, payload = {}) {
  const store = resolveDb(db)
  const cur = store.prepare('SELECT * FROM promotions WHERE id = ? OR code = ?').get(id, id)
  if (!cur) fail('NOT_FOUND', `促销不存在：${id}`, 404)

  // 用「现有值 + 本次改动」拼一份完整草稿再校验 —— 否则只想改个名字也要把
  // method / rules 全传一遍，而漏传的字段会被当成"清空"。
  const merged = {
    code: payload.code ?? cur.code,
    name: payload.name ?? cur.name,
    type: payload.type ?? cur.type,
    status: payload.status ?? cur.status,
    campaign_id: payload.campaign_id !== undefined ? payload.campaign_id : cur.campaign_id,
    is_automatic: payload.is_automatic !== undefined ? payload.is_automatic : cur.is_automatic,
    is_tax_inclusive: payload.is_tax_inclusive !== undefined ? payload.is_tax_inclusive : cur.is_tax_inclusive,
    priority: payload.priority ?? cur.priority,
    stack_group: payload.stack_group !== undefined ? payload.stack_group : cur.stack_group,
    is_exclusive: payload.is_exclusive !== undefined ? payload.is_exclusive : cur.is_exclusive,
    usage_limit: payload.usage_limit !== undefined ? payload.usage_limit : cur.usage_limit,
    starts_at: payload.starts_at !== undefined ? payload.starts_at : cur.starts_at,
    ends_at: payload.ends_at !== undefined ? payload.ends_at : cur.ends_at,
    remark: payload.remark !== undefined ? payload.remark : cur.remark,
    method: payload.method ?? store.prepare('SELECT * FROM promotion_methods WHERE promotion_id=?').get(cur.id) ?? {},
    rules: payload.rules ?? (() => {
      const rows = store.prepare('SELECT * FROM promotion_rules WHERE promotion_id=?').all(cur.id)
      return {
        rules: rows.filter((r) => r.rule_group === 'rules'),
        target_rules: rows.filter((r) => r.rule_group === 'target_rules'),
        buy_rules: rows.filter((r) => r.rule_group === 'buy_rules')
      }
    })()
  }
  const d = validatePromotionDraft(store, merged)
  if (d.code !== cur.code
    && store.prepare('SELECT 1 AS hit FROM promotions WHERE code=? AND id<>?').get(d.code, cur.id)) {
    fail('DUPLICATE_CODE', `促销编码已被占用：${d.code}`, 409)
  }
  const hasUsage = store.prepare('SELECT COUNT(*) AS c FROM promotion_usages WHERE promotion_id=?').get(cur.id).c
  if (hasUsage > 0 && d.code !== cur.code) {
    // 使用登记里存的是 code（`promotion_adjustments.code` / 留痕要回查），
    // 有历史使用后改码会让历史记录指向一个不存在的 code。
    fail('CODE_LOCKED', `该促销已有 ${hasUsage} 条使用记录，编码不能再改（历史留痕按 code 回查）`, 409)
  }

  const tx = store.transaction(() => {
    store.prepare(`
      UPDATE promotions
         SET code=?, name=?, type=?, status=?, campaign_id=?, is_automatic=?, is_tax_inclusive=?,
             priority=?, stack_group=?, is_exclusive=?, usage_limit=?, starts_at=?, ends_at=?, remark=?,
             updated_at=datetime('now','localtime')
       WHERE id=?
    `).run(d.code, d.name, d.type, d.status, d.campaign_id, d.is_automatic, d.is_tax_inclusive,
      d.priority, d.stack_group, d.is_exclusive, d.usage_limit, d.starts_at, d.ends_at, d.remark, cur.id)
    writeMethod(store, cur.id, d.method)
    writeRules(store, cur.id, d.rules)
  })
  tx.immediate()
  return getPromotionDetail(store, cur.id)
}

export function setPromotionStatus(db, id, status) {
  const store = resolveDb(db)
  if (!['active', 'inactive'].includes(status)) fail('BAD_ARGS', 'status 只支持 active / inactive')
  const cur = store.prepare('SELECT * FROM promotions WHERE id = ? OR code = ?').get(id, id)
  if (!cur) fail('NOT_FOUND', `促销不存在：${id}`, 404)
  store.prepare("UPDATE promotions SET status=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(status, cur.id)
  return getPromotionDetail(store, cur.id)
}

/**
 * 删除促销。**有使用记录就不许删** —— 使用登记与优惠留痕是财务报表的一部分，
 * 删掉促销会让留痕里那一行显示成"未知活动"，那笔优惠从此解释不了。
 * 不再想用它请改成 `inactive`。
 */
export function deletePromotion(db, id) {
  const store = resolveDb(db)
  const cur = store.prepare('SELECT * FROM promotions WHERE id = ? OR code = ?').get(id, id)
  if (!cur) fail('NOT_FOUND', `促销不存在：${id}`, 404)
  const used = store.prepare('SELECT COUNT(*) AS c FROM promotion_usages WHERE promotion_id=?').get(cur.id).c
  if (used > 0) fail('HAS_USAGE', `该促销已有 ${used} 条使用记录，不能删除；请改为停用（inactive）`, 409)
  const bound = store.prepare('SELECT COUNT(*) AS c FROM coupons WHERE promotion_id=?').get(cur.id).c
  if (bound > 0) fail('HAS_COUPON', `该促销被 ${bound} 个券模板引用，不能删除；请先解绑券`, 409)
  const tx = store.transaction(() => {
    store.prepare('DELETE FROM promotion_rules WHERE promotion_id=?').run(cur.id)
    store.prepare('DELETE FROM promotion_methods WHERE promotion_id=?').run(cur.id)
    store.prepare('DELETE FROM promotions WHERE id=?').run(cur.id)
  })
  tx.immediate()
  return { deleted: true, id: cur.id, code: cur.code }
}

// ---- 活动（活动的容器：一个活动下可以挂多张促销共享预算与档期） ----

export function listCampaigns(db, { status = null, keyword = null } = {}) {
  const store = resolveDb(db)
  const where = []
  const params = []
  if (status) { where.push('c.status = ?'); params.push(status) }
  if (keyword) { where.push('(c.code LIKE ? OR c.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return store.prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM promotions p WHERE p.campaign_id = c.id) AS promotion_count,
           (SELECT COUNT(*) FROM promotions p WHERE p.campaign_id = c.id AND p.status='active') AS active_count,
           (SELECT COALESCE(SUM(u.amount),0) FROM promotion_usages u
              JOIN promotions p ON p.id = u.promotion_id WHERE p.campaign_id = c.id) AS used_amount
      FROM promotion_campaigns c ${clause}
     ORDER BY c.id DESC
  `).all(...params)
}

export function createCampaign(db, payload = {}) {
  const store = resolveDb(db)
  const code = String(payload.code ?? '').trim()
  const name = String(payload.name ?? '').trim()
  if (!code || !name) fail('BAD_ARGS', '活动编码与名称必填')
  if (store.prepare('SELECT 1 AS hit FROM promotion_campaigns WHERE code=?').get(code)) {
    fail('DUPLICATE_CODE', `活动编码已存在：${code}`, 409)
  }
  const startsAt = payload.starts_at ?? null
  const endsAt = payload.ends_at ?? null
  if (startsAt && endsAt && String(startsAt) > String(endsAt)) fail('BAD_WINDOW', '活动起止时间写反了')
  const info = store.prepare(`
    INSERT INTO promotion_campaigns (code,name,description,starts_at,ends_at,status)
    VALUES (?,?,?,?,?,?)
  `).run(code, name, payload.description ? String(payload.description) : null,
    startsAt, endsAt, payload.status ?? 'active')
  return store.prepare('SELECT * FROM promotion_campaigns WHERE id=?').get(info.lastInsertRowid)
}

export function setCampaignStatus(db, id, status) {
  const store = resolveDb(db)
  if (!['active', 'ended'].includes(status)) fail('BAD_ARGS', '活动 status 只支持 active / ended')
  const cur = store.prepare('SELECT * FROM promotion_campaigns WHERE id = ? OR code = ?').get(id, id)
  if (!cur) fail('NOT_FOUND', `活动不存在：${id}`, 404)
  store.prepare('UPDATE promotion_campaigns SET status=? WHERE id=?').run(status, cur.id)
  return store.prepare('SELECT * FROM promotion_campaigns WHERE id=?').get(cur.id)
}

export default {
  PROMO_TYPE, ALLOCATION, TARGET,
  sortPromotions, computePromotionActions, persistAdjustments, registerUsage, revertUsage,
  listPromotions, getPromotionDetail, explainPromotion, PromotionError,
  validatePromotionDraft, createPromotion, updatePromotion, setPromotionStatus, deletePromotion,
  listCampaigns, createCampaign, setCampaignStatus
}
