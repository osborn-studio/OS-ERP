/**
 * ============================================================================
 * 文件标识：server/lib/agreement.js ｜ 渠道协议价（批次 G · 模块 26）
 * ============================================================================
 * 【职责】渠道协议价（批次 G · 模块 26）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 渠道协议价（批次 G · 模块 26）
//
// ===========================================================================
// 一、它和「价格组」不是一回事
// ===========================================================================
// `lib/pricing.js` 的四维价格组（渠道 × 门店类型 × 经销商等级 × 区域）描述的是
// **"这一类客户"的价**；协议价描述的是**"这一个客户谈下来的价"**：
//
//   | 维度 | 价格组 | 协议价 |
//   |---|---|---|
//   | 主体 | `dealer_level`（金牌 / 银牌…） | `dealer_id`（具体某一家） |
//   | 粒度 | 逐 SKU 维护在 `price_group_items` | `sku` / `category` / 全部 |
//   | 时间 | `effect_from/to` | 合同周期（含起订量） |
//   | 形态 | 只存单价 | 单价 **或** 折扣（万分比） |
//
// 硬要用 `dealer_level` 表达"某一家"，等于把合同的私有性降级成群组规则：
// 一旦某家要单独议价，就得给它造一个等级，而等级是**共享维度** ——
// 会影响所有同档客户，且没人会发现。
//
// ===========================================================================
// 二、在取价链上的位置（顺序本身就是一个口径）
// ===========================================================================
//   促销价 > **协议价** > 会员价 > 价格组价 > 标准零售价
//
// 放在促销价之后：促销是"这一档期全渠道投放的价"，属于更强的时间性意图；
// 放在会员价之前：**合同 > 通用权益** —— 会员价是"注册即得"的公开权益，
//   而协议价是逐字谈出来的，同一件货上后者必须赢。
//
// 这个顺序**只在 `pricing.resolvePrice` 里实现一次**，本文件只提供"命中哪一条协议"。
//
// ===========================================================================
// 三、本文件的三条判据
// ===========================================================================
//   ① 命中判定：主体 + 目标（含品类回溯）+ 周期 + 起订量，四项**全中**才适用；
//   ② 裁决：同类协议并存时按 `priority`（小者优先）→ `id`；
//   ③ 取价：`fixed` 直接给单价；`discount` 按万分比在**基准价**上折
//      —— 基准价由调用方给（一般是标准零售价），本层不自己查，避免第二处取价。
//
// 折扣后的价格**必须**≥ `product_skus.price_min`（最低限价）。低于就拒绝并说明原因 ——
// 静默按最低限价出价会让"这份协议谈的 88 折"变成"实际 6 折"，而双方都不知道。
import { logPriceChange } from './pricing.js'

export class AgreementError extends Error {
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

const nowText = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const money4 = (n) => Number(Number(n || 0).toFixed(4))

export const AGREEMENT_TARGET_LABEL = { sku: '指定 SKU', category: '指定品类', all: '全部商品' }
export const AGREEMENT_PRICE_LABEL = { fixed: '协议单价', discount: '折扣率' }

/** 折扣率（万分比）→ 可读文案：9500 → 「95.0 折」 */
export const discountLabel = (bp) => `${(Number(bp || 10000) / 1000).toFixed(1)} 折`

const pad = (n, w) => String(n).padStart(w, '0')
/** 协议编码：XY + 年 + 4 位序号（同一经销商不同品类各一份，编码全局唯一即可） */
export function nextAgreementCode(db) {
  const y = new Date().getFullYear()
  const row = db
    .prepare("SELECT code FROM price_agreements WHERE code LIKE ? ORDER BY code DESC LIMIT 1")
    .get(`XY${y}%`)
  const n = row ? Number(String(row.code).slice(-4)) + 1 : 1
  return `XY${y}${pad(n, 4)}`
}

/**
 * 命中某经销商在某时点、某 SKU 上适用的协议。
 *
 * @param at   判定时点（默认现在）—— 协议是**合同周期**，用日期判定；
 * @param qty  本次数量（低于 `min_qty` 不适用）
 * @param basePrice 基准价（`discount` 型协议在它上面打折）。**由调用方给**：
 *              "基准价是多少"必须由取价链的上一环决定，否则本层就成了第二处取价。
 * @returns 命中 → `{ agreement, price, basePrice, capped }`；未命中 → `null`
 */
export function resolveAgreement(db, { dealerId, skuId, qty = 1, at = null, basePrice = null, categoryId = null }) {
  if (!dealerId || !skuId) return null
  const day = String(at || nowText()).slice(0, 10)

  // 目标回溯：显式给的 categoryId 优先，否则现查一次（避免调用方忘传就静默不命中）
  let catId = categoryId
  if (catId == null) {
    const row = db
      .prepare('SELECT p.category_id AS c FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?')
      .get(Number(skuId))
    catId = row?.c ?? null
  }

  const rows = db
    .prepare(`
      SELECT * FROM price_agreements
       WHERE dealer_id=? AND status='active'
         AND (effect_from IS NULL OR effect_from='' OR effect_from <= ?)
         AND (effect_to   IS NULL OR effect_to=''   OR effect_to   >= ?)
         AND ( (target_type='sku'      AND target_id=?)
            OR (target_type='category' AND target_id=?)
            OR (target_type='all') )
       ORDER BY priority, id
    `)
    .all(Number(dealerId), day, day, Number(skuId), catId == null ? -1 : Number(catId))

  for (const a of rows) {
    if (Number(qty) < Number(a.min_qty ?? 1)) continue
    const base = Number(basePrice)
    let price
    if (a.price_type === 'fixed') {
      price = money4(a.price)
    } else {
      if (!(base > 0)) {
        // 折扣型协议没有基准价 = 谈不拢。**报错而不是跳过** ——
        // 静默跳过会让"这份协议明明在有效期内却不生效"，且没有任何痕迹。
        throw new AgreementError(
          'AGREEMENT_BASE_PRICE_REQUIRED',
          `协议 ${a.code} 是折扣型，但本次没有基准价，无法折算`,
          400,
          // 键名用 `agreement_code` 而**不是** `code`：响应里 `detail.code` 是**保留键**
          // （`bizFail` 把业务码写在那里），用 `code` 装协议号会把业务码挤掉 ——
          // 那时 `error` 与 `detail.code` 不同值，两处读法拿到两个不同的东西，且完全静默。
          { agreement_id: a.id, agreement_code: a.code }
        )
      }
      price = money4(base * (Number(a.discount_bp) || 10000) / 10000)
    }
    if (!(price > 0)) continue

    // 最低限价：低于就**如实拒绝**，不静默抬到限价
    const sku = db.prepare('SELECT price_min FROM product_skus WHERE id=?').get(Number(skuId))
    const floor = Number(sku?.price_min || 0)
    if (floor > 0 && price < floor - 0.0001) {
      throw new AgreementError(
        'AGREEMENT_BELOW_FLOOR',
        `协议 ${a.code} 折算价 ${price} 低于最低限价 ${floor}，请与客户重议或先调整限价`,
        409,
        // 同上：协议号走 `agreement_code`，`code` 留给业务码（保留键）
        { agreement_id: a.id, agreement_code: a.code, price, floor }
      )
    }
    return {
      agreement: a,
      price,
      base_price: base,
      source: a.price_type === 'fixed' ? 'agreement_fixed' : 'agreement_discount',
      trace: `协议价「${a.name}」命中（${AGREEMENT_TARGET_LABEL[a.target_type] || a.target_type}${
        a.price_type === 'discount' ? ` · ${discountLabel(a.discount_bp)}` : ''
      }）`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function validateDraft(db, p = {}) {
  const code = String(p.code || '').trim()
  const name = String(p.name || '').trim()
  if (!name) throw new AgreementError('BAD_ARGS', '协议名称必填')
  const dealerId = Number(p.dealer_id)
  if (!dealerId) throw new AgreementError('BAD_ARGS', '必须指定经销商')
  if (!db.prepare('SELECT 1 AS h FROM dealers WHERE id=?').get(dealerId)) {
    throw new AgreementError('DEALER_NOT_FOUND', `经销商 #${dealerId} 不存在`, 404)
  }
  const targetType = String(p.target_type || 'sku')
  if (!['sku', 'category', 'all'].includes(targetType)) {
    throw new AgreementError('BAD_ARGS', `目标类型无效：${targetType}`)
  }
  const targetId = targetType === 'all' ? null : Number(p.target_id)
  // 目标必须与类型自洽 —— 迁移 031 的 verify() 也断言这一条（写不进去总比写错好）
  if (targetType !== 'all' && !targetId) throw new AgreementError('BAD_ARGS', '请选择协议作用的 SKU 或品类')
  const priceType = String(p.price_type || 'fixed')
  if (!['fixed', 'discount'].includes(priceType)) {
    throw new AgreementError('BAD_ARGS', `价格形态无效：${priceType}`)
  }
  const price = Number(p.price || 0)
  const discountBp = Number(p.discount_bp ?? 10000)
  if (priceType === 'fixed' && !(price > 0)) throw new AgreementError('BAD_ARGS', '定价型协议必须给协议单价')
  if (priceType === 'discount' && !(discountBp > 0 && discountBp < 10000)) {
    throw new AgreementError('BAD_ARGS', '折扣型协议的折扣必须落在 (0, 10000) 万分比区间内（10000 = 不减）')
  }
  const minQty = Number(p.min_qty ?? 1)
  if (!(minQty > 0)) throw new AgreementError('BAD_ARGS', '起订量必须大于 0')
  const from = p.effect_from || null
  const to = p.effect_to || null
  if (from && to && from > to) throw new AgreementError('BAD_ARGS', '合同周期起不得晚于止')
  return {
    code,
    name,
    dealer_id: dealerId,
    target_type: targetType,
    target_id: targetId,
    price_type: priceType,
    price,
    discount_bp: discountBp,
    min_qty: minQty,
    effect_from: from,
    effect_to: to,
    priority: Number(p.priority ?? 100),
    status: String(p.status || 'active'),
    remark: p.remark || null
  }
}

export function createAgreement(db, payload = {}, actor = null) {
  const d = validateDraft(db, payload)
  const code = d.code || nextAgreementCode(db)
  if (db.prepare('SELECT 1 AS h FROM price_agreements WHERE code=?').get(code)) {
    throw new AgreementError('DUPLICATE_CODE', `协议编码已存在：${code}`, 409)
  }
  const info = db
    .prepare(`
      INSERT INTO price_agreements
        (code,name,dealer_id,target_type,target_id,price_type,price,discount_bp,min_qty,
         effect_from,effect_to,priority,status,remark,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    .run(code, d.name, d.dealer_id, d.target_type, d.target_id, d.price_type, d.price, d.discount_bp,
      d.min_qty, d.effect_from, d.effect_to, d.priority, d.status, d.remark,
      actor?.id ?? null)
  const id = Number(info.lastInsertRowid)
  logPriceChange(db, {
    entity: 'price_agreement', entityId: id, field: 'price',
    oldValue: null, newValue: d.price_type === 'fixed' ? d.price : d.discount_bp,
    reason: `新建协议价 ${code}`, operator: actor?.name ?? null,
    source: actor?.source || 'web'
  })
  return getAgreement(db, id)
}

export function updateAgreement(db, id, payload = {}, actor = null) {
  const cur = db.prepare('SELECT * FROM price_agreements WHERE id=?').get(Number(id))
  if (!cur) throw new AgreementError('NOT_FOUND', `协议不存在：#${id}`, 404)
  const d = validateDraft(db, { ...cur, ...payload, code: cur.code })
  db.prepare(`
    UPDATE price_agreements
       SET name=?, dealer_id=?, target_type=?, target_id=?, price_type=?, price=?, discount_bp=?,
           min_qty=?, effect_from=?, effect_to=?, priority=?, status=?, remark=?,
           updated_at=datetime('now','localtime')
     WHERE id=?
  `).run(d.name, d.dealer_id, d.target_type, d.target_id, d.price_type, d.price, d.discount_bp,
    d.min_qty, d.effect_from, d.effect_to, d.priority, d.status, d.remark, Number(id))
  const oldVal = cur.price_type === 'fixed' ? cur.price : cur.discount_bp
  const newVal = d.price_type === 'fixed' ? d.price : d.discount_bp
  if (Number(oldVal) !== Number(newVal) || cur.price_type !== d.price_type) {
    logPriceChange(db, {
      entity: 'price_agreement', entityId: Number(id), field: 'price',
      oldValue: oldVal, newValue: newVal,
      reason: payload.reason || `修改协议价 ${cur.code}`,
      operator: actor?.name ?? null, source: actor?.source || 'web'
    })
  }
  return getAgreement(db, Number(id))
}

export function setAgreementStatus(db, id, status, actor = null) {
  const cur = db.prepare('SELECT * FROM price_agreements WHERE id=?').get(Number(id))
  if (!cur) throw new AgreementError('NOT_FOUND', `协议不存在：#${id}`, 404)
  if (!['active', 'inactive'].includes(status)) {
    throw new AgreementError('BAD_ARGS', `状态无效：${status}`)
  }
  db.prepare("UPDATE price_agreements SET status=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(status, Number(id))
  logPriceChange(db, {
    entity: 'price_agreement', entityId: Number(id), field: 'status',
    oldValue: cur.status, newValue: status,
    reason: status === 'active' ? '启用协议价' : '停用协议价',
    operator: actor?.name ?? null, source: actor?.source || 'web'
  })
  return getAgreement(db, Number(id))
}

export function getAgreement(db, id) {
  const row = db
    .prepare(`
      SELECT a.*, d.name AS dealer_name, d.code AS dealer_code, d.level AS dealer_level,
             CASE a.target_type
               WHEN 'sku'      THEN (SELECT s.name FROM product_skus s WHERE s.id = a.target_id)
               WHEN 'category' THEN (SELECT c.name FROM categories  c WHERE c.id = a.target_id)
               ELSE '全部商品' END AS target_name
        FROM price_agreements a
        LEFT JOIN dealers d ON d.id = a.dealer_id
       WHERE a.id = ?
    `)
    .get(Number(id))
  if (!row) return null
  return {
    ...row,
    target_label: AGREEMENT_TARGET_LABEL[row.target_type] || row.target_type,
    price_label: AGREEMENT_PRICE_LABEL[row.price_type] || row.price_type,
    discount_label: row.price_type === 'discount' ? discountLabel(row.discount_bp) : null
  }
}

export function listAgreements(db, { dealerId = null, status = null, keyword = null, page = 1, pageSize = 20 } = {}) {
  const where = []
  const params = []
  if (dealerId) { where.push('a.dealer_id = ?'); params.push(Number(dealerId)) }
  if (status) { where.push('a.status = ?'); params.push(status) }
  if (keyword) {
    where.push('(a.code LIKE ? OR a.name LIKE ? OR d.name LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = db
    .prepare(`SELECT COUNT(*) c FROM price_agreements a LEFT JOIN dealers d ON d.id=a.dealer_id ${clause}`)
    .get(...params).c
  const off = (Math.max(1, page) - 1) * pageSize
  const rows = db
    .prepare(`
      SELECT a.*, d.name AS dealer_name, d.code AS dealer_code,
             CASE a.target_type
               WHEN 'sku'      THEN (SELECT s.name FROM product_skus s WHERE s.id = a.target_id)
               WHEN 'category' THEN (SELECT c.name FROM categories  c WHERE c.id = a.target_id)
               ELSE '全部商品' END AS target_name
        FROM price_agreements a LEFT JOIN dealers d ON d.id = a.dealer_id
        ${clause} ORDER BY a.dealer_id, a.priority, a.id LIMIT ? OFFSET ?
    `)
    .all(...params, pageSize, off)
  return {
    list: rows.map((r) => ({
      ...r,
      target_label: AGREEMENT_TARGET_LABEL[r.target_type] || r.target_type,
      discount_label: r.price_type === 'discount' ? discountLabel(r.discount_bp) : null
    })),
    total, page, pageSize
  }
}

export function meta() {
  return {
    target_types: Object.entries(AGREEMENT_TARGET_LABEL).map(([value, label]) => ({ value, label })),
    price_types: Object.entries(AGREEMENT_PRICE_LABEL).map(([value, label]) => ({ value, label })),
    statuses: [{ value: 'active', label: '启用' }, { value: 'inactive', label: '停用' }]
  }
}

export default {
  AgreementError, resolveAgreement, nextAgreementCode,
  createAgreement, updateAgreement, setAgreementStatus, getAgreement, listAgreements, meta,
  AGREEMENT_TARGET_LABEL, AGREEMENT_PRICE_LABEL, discountLabel
}
