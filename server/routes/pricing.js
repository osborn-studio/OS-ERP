/**
 * ============================================================================
 * 文件标识：server/routes/pricing.js ｜ 价格中心接口：取价 / 价格组维护 / 阶梯价 / 调价留痕
 * ============================================================================
 * 【职责】价格中心接口：取价 / 价格组维护 / 阶梯价 / 调价留痕
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 价格中心接口：取价 / 价格组维护 / 阶梯价 / 调价留痕
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged } from '../lib/http.js'
import { requireAuth, requirePerm, requireInternal } from '../middleware/auth.js'
import { resolvePrice, resolvePrices, explainPrice, logPriceChange } from '../lib/pricing.js'
import { audit } from '../middleware/audit.js'

const r = Router()
r.use(requireAuth, requireInternal('总部价格规则；订货方请使用订货中心报价'))

/** 取价：给 SKU + 上下文，返回应执行的价与来源 */
r.get(
  '/resolve',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const q = req.query
    const out = resolvePrice(db, {
      skuId: Number(q.sku_id),
      orgId: q.org_id ? Number(q.org_id) : req.user.org_id ?? null,
      channel: q.channel || null,
      storeType: q.store_type || null,
      dealerLevel: q.dealer_level || null,
      region: q.region || null,
      memberLevel: q.member_level || null,
      qty: q.qty ? Number(q.qty) : 1
    })
    return ok(res, out)
  })
)

/** 批量取价 */
r.post(
  '/resolve-batch',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { sku_ids, ...rest } = req.body || {}
    if (!Array.isArray(sku_ids) || !sku_ids.length) return fail(res, 'sku_ids 需为非空数组')
    return ok(res, resolvePrices(db, sku_ids.map(Number), { orgId: req.user.org_id ?? null, ...rest }))
  })
)

/** 取价解释：界面上回答「为什么是这个价」 */
r.get(
  '/explain',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const q = req.query
    return ok(
      res,
      explainPrice(db, {
        skuId: Number(q.sku_id),
        orgId: q.org_id ? Number(q.org_id) : req.user.org_id ?? null,
        channel: q.channel || null,
        storeType: q.store_type || null,
        dealerLevel: q.dealer_level || null,
        region: q.region || null,
        memberLevel: q.member_level || null,
        qty: q.qty ? Number(q.qty) : 1
      })
    )
  })
)

/** 价格组列表（含明细数量与覆盖维度） */
r.get(
  '/groups',
  requireAuth,
  requirePerm('master.price.view'),
  wrap((_req, res) => {
    const db = getDb()
    const rows = db.prepare(`
      SELECT g.*,
             (SELECT COUNT(*) FROM price_group_items i WHERE i.group_id=g.id) AS item_count,
             (SELECT COUNT(DISTINCT i.sku_id) FROM price_group_items i WHERE i.group_id=g.id) AS sku_count
      FROM price_groups g ORDER BY g.priority, g.id`).all()
    return ok(res, rows)
  })
)

/** 新建 / 更新价格组 */
r.post(
  '/groups',
  requireAuth,
  requirePerm('master.price.edit'),
  wrap((req, res) => {
    const db = getDb()
    const { code, name, channel, store_type, dealer_level, region, priority, currency, effect_from, effect_to, remark } = req.body || {}
    if (!code || !name) return fail(res, 'code 与 name 必填')
    db.prepare(`
      INSERT INTO price_groups (code,name,channel,store_type,dealer_level,region,priority,currency,effect_from,effect_to,remark)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name, channel=excluded.channel, store_type=excluded.store_type,
        dealer_level=excluded.dealer_level, region=excluded.region, priority=excluded.priority,
        currency=excluded.currency, effect_from=excluded.effect_from, effect_to=excluded.effect_to, remark=excluded.remark
    `).run(code, name, channel ?? null, store_type ?? null, dealer_level ?? null, region ?? null, priority ?? 100, currency || 'CNY', effect_from ?? null, effect_to ?? null, remark ?? null)
    const row = db.prepare('SELECT * FROM price_groups WHERE code=?').get(code)
    audit({ user: { uid: req.user.uid, name: req.user.name }, ip: req.ip }, { action: 'PRICE_GROUP_UPSERT', module: 'master', entity: 'price_group', entityId: row.id, detail: code })
    return ok(res, row)
  })
)

/** 价格组明细（分页 + 可按 SKU 搜索） */
r.get(
  '/groups/:id/items',
  requireAuth,
  requirePerm('master.price.view'),
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const gid = Number(req.params.id)
    const kw = req.query.keyword
    let where = 'WHERE i.group_id=?'
    const params = [gid]
    if (kw) { where += ' AND (k.name LIKE ? OR k.sku_code LIKE ?)'; params.push(`%${kw}%`, `%${kw}%`) }
    const total = db.prepare(`SELECT COUNT(*) c FROM price_group_items i LEFT JOIN product_skus k ON k.id=i.sku_id ${where}`).get(...params).c
    const rows = db.prepare(`
      SELECT i.id, i.sku_id, k.sku_code, k.name AS sku_name, i.price, i.min_qty, k.price_retail
      FROM price_group_items i LEFT JOIN product_skus k ON k.id=i.sku_id
      ${where} ORDER BY i.sku_id, i.min_qty LIMIT ? OFFSET ?`).all(...params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

/** 批量改价（写留痕） */
r.put(
  '/groups/:id/items',
  requireAuth,
  requirePerm('master.price.edit'),
  wrap((req, res) => {
    const db = getDb()
    const gid = Number(req.params.id)
    const { items, reason } = req.body || {}
    if (!Array.isArray(items) || !items.length) return fail(res, 'items 需为非空数组')
    const group = db.prepare('SELECT * FROM price_groups WHERE id=?').get(gid)
    if (!group) return fail(res, '价格组不存在', 404)

    const changed = []
    const tx = db.transaction(() => {
      for (const it of items) {
        const skuId = Number(it.sku_id)
        const minQty = Number(it.min_qty || 1)
        const old = db.prepare('SELECT price FROM price_group_items WHERE group_id=? AND sku_id=? AND min_qty=?').get(gid, skuId, minQty)
        db.prepare(`
          INSERT INTO price_group_items (group_id, sku_id, price, min_qty) VALUES (?,?,?,?)
          ON CONFLICT(group_id, sku_id, min_qty) DO UPDATE SET price=excluded.price
        `).run(gid, skuId, Number(it.price) || 0, minQty)
        logPriceChange(db, {
          entity: 'price_group', entityId: gid, field: `sku:${skuId}@${minQty}`,
          oldValue: old?.price ?? null, newValue: Number(it.price) || 0,
          reason: reason || null, operator: req.user.name || req.user.username,
          currency: group.currency
        })
        changed.push({ sku_id: skuId, min_qty: minQty, from: old?.price ?? null, to: Number(it.price) || 0 })
      }
    })
    tx()
    audit({ user: { uid: req.user.uid, name: req.user.name }, ip: req.ip }, { action: 'PRICE_GROUP_ITEMS_UPDATE', module: 'master', entity: 'price_group', entityId: gid, detail: `${changed.length} 条` })
    return ok(res, { group: group.code, changed })
  })
)

/** 调价留痕 */
r.get(
  '/logs',
  requireAuth,
  requirePerm('master.price.view'),
  wrap((req, res) => {
    const db = getDb()
    const limit = Math.min(Number(req.query.limit) || 100, 500)
    const where = []
    const params = []
    if (req.query.entity) { where.push('entity=?'); params.push(req.query.entity) }
    if (req.query.entity_id) { where.push('entity_id=?'); params.push(Number(req.query.entity_id)) }
    const sql = `SELECT * FROM price_change_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
    return ok(res, db.prepare(sql).all(...params, limit))
  })
)

/** 取价规则顺序 */
r.get(
  '/rules',
  requireAuth,
  wrap((_req, res) => ok(res, getDb().prepare('SELECT * FROM price_rules ORDER BY seq').all()))
)

export default r
