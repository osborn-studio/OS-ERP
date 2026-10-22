/**
 * ============================================================================
 * 文件标识：server/lib/pricing.js ｜ 取价引擎：按「匹配度 + 优先级」在四维自由组合的价格组里取值
 * ============================================================================
 * 【职责】取价引擎：按「匹配度 + 优先级」在四维自由组合的价格组里取值
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 取价引擎：按「匹配度 + 优先级」在四维自由组合的价格组里取值
//
// 口径（第三轮 C1/C2）：
//   价格组不设主维，四维（渠道 × 门店类型 × 经销商等级 × 区域）自由组合
//   取价顺序：促销价 > 会员价 > 价格组价 > 标准零售价
//
// 为什么用「匹配度打分」而不是固定维度树：
//   不设主维就无法用一条固定的 WHERE 链取值。改为：价格组某一维度留空 = 不限，
//   非空则必须命中；命中维度越多得分越高；同分再按人工 priority 排序。
//   这样「华东加盟店银牌」这种细组合与「仅限经销商」这种宽组合能共存，
//   且宽组合自动成为细组合的兜底，不需要为每个组合建一张表。

// 协议价（批次 G）：取价链上的 1.5 环，唯一实现见 `lib/agreement.js`
import { resolveAgreement } from './agreement.js'

const DIMS = ['channel', 'store_type', 'dealer_level', 'region']

function nowLocal() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

function pack(price, source, extra = {}) {
  return {
    price: Number(Number(price).toFixed(4)),
    source,
    currency: extra.currency || 'CNY',
    ...extra
  }
}

/**
 * 取价。
 * @param {object} q
 *   skuId        必填
 *   orgId        组织（用于价格组直绑）
 *   channel      渠道：direct/franchise/dealer/online/pos
 *   storeType    门店类型：direct/counter/franchise
 *   dealerLevel  经销商等级：gold/silver
 *   region       区域
 *   memberLevel  会员等级（命中会员价）
 *   dealerId     经销商 id（命中**协议价**，批次 G）
 *   qty          数量（用于阶梯价）
 *   at           指定时点（默认当前）
 */
export function resolvePrice(db, q = {}) {
  const {
    skuId, orgId = null, channel = null, storeType = null,
    dealerLevel = null, region = null, memberLevel = null,
    dealerId = null,
    qty = 1, at = null
  } = q

  if (!skuId) {
    const e = new Error('skuId 必填'); e.code = 'BAD_ARGS'; e.status = 400; throw e
  }
  const sku = db.prepare('SELECT * FROM product_skus WHERE id=?').get(skuId)
  if (!sku) {
    const e = new Error(`SKU#${skuId} 不存在`); e.code = 'NOT_FOUND'; e.status = 404; throw e
  }

  const ts = at || nowLocal()
  const day = String(ts).slice(0, 10)
  const trace = []

  // ---------- 1. 促销价（活动表未上线前跳过，但占住优先级位置） ----------
  //
  // ⚠️ 特性开关**不能**用「`promotions` 表是否存在」。
  //   批次 F（迁移 025）的 `promotions` 是 medusa 风格模型：优惠方式在
  //   `promotion_methods`、时间列叫 `starts_at` / `ends_at`，**没有**
  //   `price` / `sku_id` / `start_at` / `end_at` 这四列。
  //   用表名当开关的后果是：表一建出来，取价引擎每次调用都抛
  //   `no such column: price`，`seedOrderCenter` 随之崩溃、服务起不来
  //   （已在 2026-10-15 复现过一次，见 reusable/promotion/promotion-migration.cjs 抬头）。
  //
  //   改为**探测列形状**：只有「简表形态」的 promotions（带 price 列）才走这一段。
  //   这样两种模型能共存，也不会因为「表建出来了」就突然改行为。
  const hasLegacyPromo = db
    .prepare("SELECT 1 AS hit FROM pragma_table_info('promotions') WHERE name='price'").get()
  if (hasLegacyPromo) {
    const promo = db.prepare(`
      SELECT price FROM promotions WHERE sku_id=? AND status='active'
        AND (start_at IS NULL OR start_at <= ?) AND (end_at IS NULL OR end_at >= ?)
      ORDER BY priority LIMIT 1`).get(skuId, ts, ts)
    if (promo?.price > 0) {
      return { ...pack(promo.price, 'promotion', { skuId, trace: [...trace, '促销价命中'] }), rule: 'promotion' }
    }
    trace.push('促销价未命中')
  }

  // ---------- 1.5 协议价（批次 G） ----------
  //
  // 顺序：促销价 > **协议价** > 会员价 > 价格组价 > 标准零售价。
  //   · 放在促销价之后：促销是"这一档期全渠道投放的价"，时间性意图更强；
  //   · 放在会员价之前：**合同 > 通用权益** —— 会员价是"注册即得"的公开权益，
  //     协议价是逐字谈出来的，同一件货上后者必须赢。
  //
  // 顺序**只在这里实现一次**：`lib/agreement.js` 只回答"命中哪一条协议"，
  // 不参与"它排第几"。基准价用 SKU 的标准零售价（协议折扣就是"在零售价上打几折"）。
  //
  // 表不存在时（老库未迁移）**必须静默跳过**，不能抛错 ——
  // 取价引擎是全系统最热的调用点之一，任何一个"新表还没建"都不该让它整体不可用。
  if (dealerId) {
    const hasAgreement = db
      .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='price_agreements'")
      .get()
    if (hasAgreement) {
      const hit = resolveAgreement(db, {
        dealerId, skuId, qty, at: day, basePrice: Number(sku.price_retail || 0)
      })
      if (hit?.price > 0) {
        return {
          ...pack(hit.price, hit.source, {
            skuId,
            dealerId,
            agreementId: hit.agreement.id,
            agreementCode: hit.agreement.code,
            agreementName: hit.agreement.name,
            basePrice: hit.base_price,
            trace: [...trace, hit.trace]
          }),
          rule: 'agreement'
        }
      }
      trace.push('协议价未命中')
    }
  }

  // ---------- 2. 会员价 ----------
  if (memberLevel) {
    const mp = db.prepare('SELECT price FROM member_prices WHERE sku_id=? AND member_level=?').get(skuId, memberLevel)
    if (mp && mp.price > 0) {
      return { ...pack(mp.price, 'member', { skuId, memberLevel, trace: [...trace, `会员价命中（${memberLevel}）`] }), rule: 'member' }
    }
    trace.push('会员价未命中')
  }

  // ---------- 3. 价格组价 ----------
  const groups = db.prepare(`
    SELECT * FROM price_groups
    WHERE status='active'
      AND (effect_from IS NULL OR effect_from='' OR effect_from <= ?)
      AND (effect_to   IS NULL OR effect_to=''   OR effect_to   >= ?)
  `).all(day, day)

  const boundIds = orgId
    ? new Set(db.prepare('SELECT group_id FROM price_group_targets WHERE org_id=?').all(orgId).map((r) => r.group_id))
    : new Set()

  const given = { channel, store_type: storeType, dealer_level: dealerLevel, region }
  const scored = []
  for (const g of groups) {
    let hit = 0
    let conflict = false
    for (const d of DIMS) {
      const want = g[d]
      if (want === null || want === undefined || want === '') continue
      const got = given[d]
      if (got !== null && got !== undefined && got !== '' && String(want) === String(got)) hit += 1
      else conflict = true          // 该组要求了某维度但本次不匹配 → 排除
    }
    const bound = boundIds.has(g.id)
    if (conflict && !bound) continue
    scored.push({ g, score: hit + (bound ? 1 : 0) })
  }
  // 匹配维度多者优先；同分按人工 priority（数字小者优先）；再同按 id
  scored.sort((a, b) => b.score - a.score || a.g.priority - b.g.priority || a.g.id - b.g.id)

  for (const { g, score } of scored) {
    const item = db
      .prepare('SELECT price, min_qty FROM price_group_items WHERE group_id=? AND sku_id=? AND min_qty <= ? ORDER BY min_qty DESC LIMIT 1')
      .get(g.id, skuId, Number(qty) || 1)
    if (item && item.price > 0) {
      return {
        ...pack(item.price, 'price_group', {
          skuId, groupId: g.id, groupCode: g.code, groupName: g.name,
          matchedDimensions: score, ladderMinQty: item.min_qty, currency: g.currency,
          trace: [...trace, `价格组「${g.name}」命中（匹配 ${score} 个维度）`]
        }),
        rule: 'price_group'
      }
    }
  }
  trace.push(`价格组未命中（候选 ${scored.length} 个）`)

  // ---------- 4. 兜底：标准零售价 ----------
  const retail = Number(sku.price_retail || 0)
  const minPrice = Number(sku.price_min || 0)
  const warn = minPrice > 0 && retail < minPrice ? `标准零售价 ${retail} 低于最低限价 ${minPrice}` : null

  return {
    ...pack(retail, 'standard', {
      skuId, trace: [...trace, '回落标准零售价'], warn
    }),
    rule: 'standard'
  }
}

/** 批量取价（一次给多个 SKU，避免 N 次往返） */
export function resolvePrices(db, skuIds, q = {}) {
  return skuIds.map((id) => resolvePrice(db, { ...q, skuId: id }))
}

/** 反查：某个 SKU 当前适用的价格组（用于界面上解释「为什么是这个价」） */
export function explainPrice(db, q = {}) {
  const r = resolvePrice(db, q)
  return {
    ...r,
    explanation: r.trace ? r.trace.join(' → ') : ''
  }
}

/** 调价留痕 */
export function logPriceChange(db, { entity, entityId, field, oldValue, newValue, currency = 'CNY', reason, operator, source = 'web' }) {
  db.prepare(`
    INSERT INTO price_change_logs (entity, entity_id, field, old_value, new_value, currency, reason, operator, source)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(entity, entityId, field, oldValue ?? null, newValue ?? null, currency, reason ?? null, operator ?? null, source)
}

export default { resolvePrice, resolvePrices, explainPrice, logPriceChange }
