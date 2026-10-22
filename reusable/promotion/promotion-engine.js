// =====================================================================
// GML 促销引擎 · 可落地骨架（Node + better-sqlite3，ESM）
//
// 【来源与改造说明 - 必读】
// 1) 领域模型（promotion / rules / application_method / budget）参考
//    medusa packages/modules/promotion（MIT，见 _ref/medusa），
//    但 medusa 跑在 Postgres + MikroORM 上，此处完全用 SQLite 重写。
// 2) 抄来的三个关键设计：
//    a. 优先级裁决器 sortByBuyGetType（medusa buy-get.ts:645）——
//       买赠优先，同类型按优惠力度降序；GML 再叠 priority 与 stack_group。
//    b. appliedPromotionsMap（medusa line-items.ts:127-174）——
//       逐行累计已优惠额，杜绝同一件商品被多个促销重复打折。
//    c. 防超发：medusa 用 SELECT ... FOR UPDATE 行锁
//       （promotion-module.ts:336-372，且要求「按 id 排序加锁避免死锁」）；
//       SQLite 没有行锁，改用 BEGIN IMMEDIATE + 条件式 UPDATE
//       （WHERE used < limit）+ 检查 changes，语义等价且更省事。
// 3) medusa 没有、GML 补齐的：priority / stack_group / is_exclusive。
//
// 【金额口径】一律用「分」为单位的整数运算，禁止浮点。
//   percentage: value 单位为万分之一（1500 = 15.00%）
//   fixed:      value 单位即「分」
// =====================================================================

export const PROMO_TYPE = { STANDARD: 'standard', BUYGET: 'buyget' }
export const ALLOCATION = { EACH: 'each', ACROSS: 'across', ONCE: 'once' }
export const TARGET = { ITEMS: 'items', ORDER: 'order', SHIPPING: 'shipping' }

// ---------------------------------------------------------------------
// 一、优先级裁决器
// medusa 原实现：buyget 优先 → 同类型按 value 降序 → buyget 再比买赠门槛。
// GML 增加：priority（显式优先级）→ 同组互斥 stack_group → 独占 is_exclusive。
// ---------------------------------------------------------------------
export function sortPromotions (a, b) {
  // 1) 显式优先级：数值小者先算（GML 自研，medusa 无此列）
  if ((a.priority ?? 100) !== (b.priority ?? 100)) {
    return (a.priority ?? 100) - (b.priority ?? 100)
  }
  // 2) 买赠优先（抄 medusa sortByBuyGetType）
  if (a.type === PROMO_TYPE.BUYGET && b.type !== PROMO_TYPE.BUYGET) return -1
  if (a.type !== PROMO_TYPE.BUYGET && b.type === PROMO_TYPE.BUYGET) return 1
  // 3) 同类型按力度降序（抄 medusa）
  const av = a.method?.value ?? 0
  const bv = b.method?.value ?? 0
  if (av !== bv) return bv - av
  // 4) 买赠再比门槛（抄 medusa）
  if (a.type === PROMO_TYPE.BUYGET) {
    const aq = a.method?.buy_rules_min_quantity ?? 0
    const bq = b.method?.buy_rules_min_quantity ?? 0
    if (aq !== bq) return bq - aq
  }
  // 5) 稳定兜底：按 code 字典序，保证同一输入永远同一结果（可重放）
  return String(a.code).localeCompare(String(b.code))
}

// ---------------------------------------------------------------------
// 二、规则匹配（简化版 areRulesValidForContext）
// ---------------------------------------------------------------------
function matchRule (rule, ctxObj) {
  const actual = ctxObj?.[rule.attribute]
  if (actual === undefined || actual === null) return false
  const raw = String(rule.value ?? '')
  switch (rule.operator) {
    case 'in': {
      const set = raw.split(',').map((s) => s.trim())
      return set.includes(String(actual))
    }
    case 'not_in': {
      const set = raw.split(',').map((s) => s.trim())
      return !set.includes(String(actual))
    }
    case 'eq': return String(actual) === raw
    case 'gt': return Number(actual) > Number(raw)
    case 'gte': return Number(actual) >= Number(raw)
    case 'lt': return Number(actual) < Number(raw)
    case 'lte': return Number(actual) <= Number(raw)
    default: return false
  }
}

function rulesValid (rules, ctxObj) {
  if (!rules || !rules.length) return true
  return rules.every((r) => matchRule(r, ctxObj))
}

// ---------------------------------------------------------------------
// 三、核心：计算优惠动作（幂等 —— 每次都全量重算，不增量累加）
// ctx = {
//   items: [{ id, sku_id, category_id, qty, unit_price, subtotal, is_discountable }],
//   customer: { id, level, ... },
//   subtotal, shipping_fee,
//   codes: ['SUMMER'],           // 用户输入的券码
//   now: '2026-10-15 16:00:00'
// }
// ---------------------------------------------------------------------
export function computePromotionActions (db, ctx) {
  const items = ctx.items ?? []
  if (!items.length) return { actions: [], totalDiscount: 0, appliedCodes: [] }

  const now = ctx.now ?? new Date().toISOString().slice(0, 19).replace('T', ' ')
  const codes = new Set(ctx.codes ?? [])

  // 1) 取候选：在有效期内 + 已启用；要么是券码命中，要么是自动促销
  const rows = db.prepare(`
    SELECT * FROM promotions
    WHERE status = 'active'
      AND (starts_at IS NULL OR starts_at <= ?)
      AND (ends_at   IS NULL OR ends_at   >= ?)
  `).all(now, now)

  const candidates = []
  for (const p of rows) {
    if (!p.is_automatic && !codes.has(p.code)) continue
    const method = db.prepare('SELECT * FROM promotion_methods WHERE promotion_id = ?').get(p.id)
    if (!method) continue
    const rules = db.prepare(`SELECT * FROM promotion_rules WHERE promotion_id = ?`).all(p.id)
    candidates.push({
      ...p,
      method,
      rules: rules.filter((r) => r.rule_group === 'rules'),
      targetRules: rules.filter((r) => r.rule_group === 'target_rules'),
      buyRules: rules.filter((r) => r.rule_group === 'buy_rules')
    })
  }

  // 2) 订单级适用条件过滤（如“仅限黄金会员”）
  let eligible = candidates.filter((p) => rulesValid(p.rules, { ...ctx.customer, subtotal: ctx.subtotal }))

  // 3) 排序裁决
  eligible = eligible.sort(sortPromotions)

  // 4) 逐个计算；appliedMap 累计每行已优惠额（抄 medusa line-items.ts:127）
  const appliedMap = new Map()     // itemId -> 已优惠额（分）
  const actions = []
  const usedGroups = new Set()     // stack_group 同组互斥
  let exclusiveHit = null
  let totalDiscount = 0

  for (const p of eligible) {
    if (exclusiveHit) break                                  // 独占促销已命中
    if (p.stack_group && usedGroups.has(p.stack_group)) continue // 同组已取过一个
    if (p.usage_limit != null && p.used >= p.usage_limit) continue

    const applicableItems = items.filter((it) => {
      if (it.is_discountable === 0) return false            // 不可打折商品直接跳过
      if (it.subtotal <= 0 || !it.qty) return false
      return rulesValid(p.targetRules, it)
    })
    if (!applicableItems.length) continue

    let stepActions = []
    if (p.method.target_type === TARGET.ITEMS) {
      stepActions = applyToItems(p, applicableItems, appliedMap)
    } else if (p.method.target_type === TARGET.ORDER) {
      stepActions = applyToOrder(p, applicableItems, ctx, appliedMap)
    }
    if (!stepActions.length) continue

    // 同组互斥：本促销生效后，同组其它促销不再参与
    if (p.stack_group) usedGroups.add(p.stack_group)
    for (const a of stepActions) {
      actions.push(a)
      totalDiscount += a.amount
    }
    if (p.is_exclusive) { exclusiveHit = p.code; break }
  }

  return {
    actions,
    totalDiscount,
    appliedCodes: [...new Set(actions.map((a) => a.code))]
  }
}

// ---------------------------------------------------------------------
// 四、按行计算（allocation: each / across / once）
// 抄 medusa line-items.ts applyPromotionToItems 的骨架，改为整数分运算
// ---------------------------------------------------------------------
function applyToItems (p, items, appliedMap) {
  const m = p.method
  const out = []
  let list = [...items]

  // once：只作用于最便宜的 N 件 —— 抄 medusa 的 sortLineItemByPriceAscending
  if (m.allocation === ALLOCATION.ONCE) {
    list = list.sort((a, b) => (a.subtotal / a.qty) - (b.subtotal / b.qty))
  }

  // across：先算“整单基数”，再按比例摊到各行（抄 medusa line-items.ts:90-109）
  let baseTotal = 0
  if (m.allocation === ALLOCATION.ACROSS) {
    baseTotal = list.reduce((acc, it) => acc + Math.max(0, it.subtotal - (appliedMap.get(it.id) ?? 0)), 0)
    if (baseTotal <= 0) return []
  }

  let remainingQuota = m.max_quantity ?? 0
  for (const it of list) {
    if (m.allocation === ALLOCATION.ONCE && remainingQuota <= 0) break

    const applied = appliedMap.get(it.id) ?? 0
    const base = Math.max(0, it.subtotal - applied)
    if (base <= 0) continue

    const effQty = m.allocation === ALLOCATION.ONCE
      ? Math.min(remainingQuota, Number(it.qty))
      : Number(it.qty)

    let amount = 0
    if (m.allocation === ALLOCATION.ACROSS) {
      // 整单算一次，再按行占比分摊
      const share = Math.round((baseTotal * base) / baseTotal) // = base，保留结构便于扩展
      amount = calcAmount(m, share)
    } else if (m.allocation === ALLOCATION.ONCE) {
      const unit = it.subtotal / Number(it.qty)
      amount = calcAmount(m, Math.round(unit * effQty))
    } else {
      amount = calcAmount(m, base)   // each：每行独立，且不超过剩余可折额
    }
    amount = Math.min(amount, base)  // 永不折成负数
    if (amount <= 0) continue

    appliedMap.set(it.id, applied + amount)
    if (m.allocation === ALLOCATION.ONCE) remainingQuota -= effQty

    out.push({
      action: 'add_item_adjustment',
      promotion_id: p.id,
      code: p.code,
      item_id: it.id,
      amount
    })
  }
  return out
}

// 整单级优惠：算一次总额，按行 subtotal 占比摊回每一行（便于后续退款拆分）
function applyToOrder (p, items, ctx, appliedMap) {
  const m = p.method
  const baseTotal = items.reduce((acc, it) => acc + Math.max(0, it.subtotal - (appliedMap.get(it.id) ?? 0)), 0)
  if (baseTotal <= 0) return []
  const total = Math.min(calcAmount(m, baseTotal), baseTotal)
  if (total <= 0) return []

  const out = []
  let allocated = 0
  items.forEach((it, idx) => {
    const base = Math.max(0, it.subtotal - (appliedMap.get(it.id) ?? 0))
    let amount = idx === items.length - 1
      ? total - allocated                                   // 末行兜底，消除分摊尾差
      : Math.round((total * base) / baseTotal)
    amount = Math.min(amount, base)
    if (amount <= 0) return
    allocated += amount
    appliedMap.set(it.id, (appliedMap.get(it.id) ?? 0) + amount)
    out.push({ action: 'add_order_adjustment', promotion_id: p.id, code: p.code, item_id: it.id, amount })
  })
  return out
}

// 金额计算：percentage 用万分之一比例，fixed 直接取分
function calcAmount (m, base) {
  if (m.type === 'percentage') {
    return Math.round((base * m.value) / 10000)
  }
  return Math.min(m.value ?? 0, base)
}

// ---------------------------------------------------------------------
// 五、落库：全量重算（先清后写），天然幂等
// medusa 的做法是「先全量 REMOVE 再重算 ADD」，这是它能重复调用的根源
// ---------------------------------------------------------------------
export function persistAdjustments (db, { orderId, actions }) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM promotion_adjustments WHERE order_id = ?').run(orderId)
    const ins = db.prepare(`
      INSERT INTO promotion_adjustments (order_id, item_id, promotion_id, code, amount)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const a of actions) ins.run(orderId, a.item_id ?? null, a.promotion_id, a.code, a.amount)
  })
  return tx.immediate ? tx.immediate() : tx()
}

// ---------------------------------------------------------------------
// 六、使用登记：防超发（SQLite 版）
//
// medusa 原实现（promotion-module.ts:336-372）：
//   在一个事务里 SELECT ... FOR UPDATE 锁住 promotion 与 budget 行，
//   且「按 id 排序加锁」以防死锁，加锁后重新读取 used 再做上限判断。
// SQLite 没有 SELECT FOR UPDATE，替代方案二选一：
//   ① BEGIN IMMEDIATE 拿全局写锁（better-sqlite3: tx.immediate()）
//   ② 条件式 UPDATE：WHERE 里带上限判断，用 changes 判断是否成功
// 这里 ①+② 都用：IMMEDIATE 保证串行，条件 UPDATE 保证判断与写入原子。
// ---------------------------------------------------------------------
export function registerUsage (db, { actions, orderId, customerId }) {
  const byPromo = new Map()
  for (const a of actions) {
    const cur = byPromo.get(a.promotion_id) ?? { amount: 0, code: a.code }
    cur.amount += a.amount
    byPromo.set(a.promotion_id, cur)
  }
  if (!byPromo.size) return { registered: 0, skipped: [] }

  const tx = db.transaction(() => {
    const skipped = []
    // 按 promotion_id 升序处理 —— 对应 medusa「按 id 排序加锁避免死锁」的经验
    const ids = [...byPromo.keys()].sort((x, y) => x - y)

    for (const pid of ids) {
      const { amount, code } = byPromo.get(pid)
      const idemKey = `order:${orderId}:promo:${code}`

      // 幂等：同一订单同一促销只登记一次（唯一键兜底）
      const dup = db.prepare('SELECT id FROM promotion_usages WHERE idempotency_key = ?').get(idemKey)
      if (dup) { skipped.push({ code, reason: 'duplicate' }); continue }

      // 条件式 UPDATE：used < usage_limit 才 +1，changes=0 即已超限
      const info = db.prepare(`
        UPDATE promotions SET used = used + 1
        WHERE id = ? AND (usage_limit IS NULL OR used < usage_limit)
      `).run(pid)
      if (info.changes === 0) { skipped.push({ code, reason: 'usage_limit_exceeded' }); continue }

      db.prepare(`
        INSERT INTO promotion_usages (promotion_id, order_id, customer_id, amount, idempotency_key)
        VALUES (?, ?, ?, ?, ?)
      `).run(pid, orderId ?? null, customerId ?? null, amount, idemKey)

      // 预算扣减（spend 口径），同样用条件式更新防超支
      db.prepare(`
        UPDATE promotion_campaign_budgets
           SET used = used + ?
         WHERE campaign_id = (SELECT campaign_id FROM promotions WHERE id = ?)
           AND type = 'spend'
           AND (limit_amt IS NULL OR used + ? <= limit_amt)
      `).run(amount, pid, amount)
    }
    return skipped
  })
  const skipped = tx.immediate ? tx.immediate() : tx()
  return { registered: byPromo.size - skipped.length, skipped }
}

// ---------------------------------------------------------------------
// 七、撤销使用（退款/取消订单时回退）
// ---------------------------------------------------------------------
export function revertUsage (db, { orderId }) {
  const tx = db.transaction(() => {
    const rows = db.prepare('SELECT * FROM promotion_usages WHERE order_id = ?').all(orderId)
    for (const u of rows) {
      db.prepare('UPDATE promotions SET used = MAX(0, used - 1) WHERE id = ?').run(u.promotion_id)
      db.prepare(`
        UPDATE promotion_campaign_budgets SET used = MAX(0, used - ?)
         WHERE campaign_id = (SELECT campaign_id FROM promotions WHERE id = ?) AND type = 'spend'
      `).run(u.amount, u.promotion_id)
    }
    db.prepare('DELETE FROM promotion_usages WHERE order_id = ?').run(orderId)
    db.prepare('DELETE FROM promotion_adjustments WHERE order_id = ?').run(orderId)
    return rows.length
  })
  return tx.immediate ? tx.immediate() : tx()
}
