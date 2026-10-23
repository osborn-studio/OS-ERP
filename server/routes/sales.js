/**
 * ============================================================================
 * 文件标识：server/routes/sales.js ｜ 销售路由：销售订单、报价、信用控制、发货、销售发票、销售退货
 * ============================================================================
 * 【职责】销售路由：销售订单、报价、信用控制、发货、销售发票、销售退货
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自人工补充**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

import { Router } from 'express'
import { localDate } from '../lib/dates.js'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged, bizFail } from '../lib/http.js'
import { requireAuth, requireRole, currentUser, scopeFilter, assertCanRead, numAmount, numQty, attachOrgScope, isExternalUser } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import { nextDocNo } from '../lib/docno.js'
import { advanceStatus, tryTransition, nowText, logEvent } from '../lib/docflow.js'
import { applyStockOut, applyStockIn, pickBatches, reserveStock, releaseStock, reserveForDoc, planShipment, releaseForDoc } from '../lib/stock.js'
// 模块 08A 信用控制：订单确认前过一次授信闸门，确认占用、取消释放、回款核销
import { checkCredit, occupy, release, settle, resolveSubject } from '../lib/credit.js'
// 模块 21：回款不再是「订单上一个数字」，而是收款单 + 核销明细
import { ensureAr, arOfOrder, createReceipt, confirmReceipt } from '../lib/ar.js'
// D1 退货闭环：来源行绑定 + 退量上限 + 成本追溯 + 应收冲减（与门店退货共用同一份判据）
import { createSalesReturn, ReturnError } from '../lib/returns.js'
// D5：作废订单的唯一实现（HTTP 与 MCP 两个入口共用）
import { cancelOrder, SalesOrderError, salesScopeSql, assertSalesDocInScope, assertSalesTargetInScope } from '../lib/sales-order.js'

const r = Router()
const W = ['sales', 'warehouse', 'admin']
// 进门 + 挂组织范围（ADR-0026）。所有销售读写路由用同一组前置中间件。
const G = [requireAuth, attachOrgScope]

// 内部账号的组织范围（ADR-0026）。外部主体（经销商 / 门店）返回 null：它们只受 scopeFilter / assertCanRead
// 的主体绑定约束，行为不变；内部账号缺 `req.orgScope` 时按「无范围」处理（fail-closed）。
const internalOrgScope = (req) => (isExternalUser(req) ? null : req.orgScope || { scope: 'none', orgIds: [] })

/**
 * 读列表 / 统计的范围片段（前导 AND，可直接拼接）：主体绑定（scopeFilter）+ 内部账号的组织范围，
 * 二者同在一个入口，列表、统计、详情不会各写各的。`bindAlias` 是带 dealer_id/store_id 的表别名，
 * `kind` / `docAlias` 描述组织谓词挂在哪张单据上。
 */
function readScope(req, { bindAlias, kind = 'order', docAlias = bindAlias }) {
  const bind = scopeFilter(req, bindAlias)
  const org = internalOrgScope(req)
  if (!org) return bind
  const o = salesScopeSql(org, kind, docAlias)
  return { sql: `${bind.sql} AND ${o.sql} `, params: [...bind.params, ...o.params] }
}

/** 取单后的范围断言：内部账号范围外 ⇒ 与不存在同形的 404；外部主体不走这里。返回 true 表示已回复 4xx（调用方直接 return）。 */
function denyOutOfOrgScope(req, res, db, kind, id) {
  const org = internalOrgScope(req)
  if (!org) return false
  try {
    assertSalesDocInScope(db, kind, id, org)
    return false
  } catch (e) {
    if (e instanceof SalesOrderError) {
      fail(res, e.message, e.status)
      return true
    }
    throw e
  }
}

/** 写路径目标（仓 / 门店）校验：内部账号必须都在范围内，否则 403。返回 true 表示已回复 4xx（调用方直接 return）。 */
function denyTargetOutOfScope(req, res, db, target) {
  const org = internalOrgScope(req)
  if (!org) return false
  try {
    assertSalesTargetInScope(db, target, org)
    return false
  } catch (e) {
    if (e instanceof SalesOrderError) {
      fail(res, e.message, e.status)
      return true
    }
    throw e
  }
}

const actorOf = (req) => {
  const u = currentUser(req)
  return { id: u.uid || u.id || null, name: u.name || u.username || null }
}

export const CHANNEL_LABEL = {
  dealer: '经销商分销',
  store: '门店零售',
  online: '自营商城',
  platform: '平台电商',
  live: '直播电商'
}

const SO_SELECT = `
  so.*, d.name AS dealer_name, d.code AS dealer_code, d.discount_rate AS dealer_discount,
  s.name AS store_name, p.name AS platform_name, p.type AS platform_type,
  w.name AS warehouse_name,
  (SELECT COUNT(*) FROM sales_order_items i WHERE i.order_id = so.id) AS item_count
`
const SO_FROM = `
  sales_orders so
  LEFT JOIN dealers d ON d.id=so.dealer_id
  LEFT JOIN stores s ON s.id=so.store_id
  LEFT JOIN platforms p ON p.id=so.platform_id
  LEFT JOIN warehouses w ON w.id=so.warehouse_id
`

// 订单主体 → 信用账户。未建档（未授信）返回 null，走现结不占用授信
function creditAccountOf(db, order) {
  const sub = resolveSubject(db, { dealerId: order.dealer_id, storeId: order.store_id })
  if (!sub) return null
  return db
    .prepare('SELECT * FROM credit_accounts WHERE subject_type=? AND subject_id=?')
    .get(sub.subjectType, sub.subjectId)
}

function loadOrder(db, id) {
  const order = db.prepare(`SELECT ${SO_SELECT} FROM ${SO_FROM} WHERE so.id=?`).get(id)
  if (!order) return null
  order.items = db
    .prepare(
      `SELECT i.*, sk.sku_code, sk.name AS sku_name, sk.spec, sk.barcode, p.name AS product_name, b.name AS brand_name
       FROM sales_order_items i JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id
       LEFT JOIN brands b ON b.id=p.brand_id WHERE i.order_id=? ORDER BY i.id`
    )
    .all(id)
  order.deliveries = db.prepare('SELECT * FROM sales_deliveries WHERE order_id=? ORDER BY id').all(id)
  return order
}

function recalcOrder(db, id) {
  const agg = db
    .prepare('SELECT COALESCE(SUM(qty),0) qty, COALESCE(SUM(amount),0) amt, COALESCE(SUM(discount),0) disc FROM sales_order_items WHERE order_id=?')
    .get(id)
  const head = db.prepare('SELECT freight, discount_amount FROM sales_orders WHERE id=?').get(id)
  const receivable = Number((agg.amt - Number(agg.disc || 0) - Number(head.discount_amount || 0) + Number(head.freight || 0)).toFixed(2))
  // 金额非负是**落库前的最后一道闸**：行级价格已校验过非负，但整单折扣/运费
  // 由单头字段参与运算，仍可能把应收推成负数（例如折扣 > 货值）。
  // 负金额单据只允许由红冲这类特定单据类型产生，普通订单不能"算"出负数。
  if (receivable < -0.001) {
    const err = new Error(`销售订单应收金额为负（${receivable}），请检查折扣金额与运费`)
    err.status = 400
    throw err
  }
  db.prepare(
    `UPDATE sales_orders SET total_qty=?, goods_amount=?, receivable_amount=?, updated_at=datetime('now','localtime') WHERE id=?`
  ).run(agg.qty, Number(agg.amt.toFixed(2)), receivable, id)
}

// 按 SKU + 渠道 + 经销商折扣计算单价
function resolvePrice(db, skuId, { channel, dealer }) {
  const sku = db.prepare('SELECT * FROM product_skus WHERE id=?').get(skuId)
  if (!sku) return { price: 0, sku: null }
  let base = sku.price_retail
  if (channel === 'dealer') base = sku.price_dealer
  if (channel === 'store' || channel === 'online') base = sku.price_member || sku.price_retail
  const rate = dealer && channel === 'dealer' ? Number(dealer.discount_rate || 100) : 100
  return { price: Number((base * rate / 100).toFixed(2)), sku, base }
}

// ---------- 销售订单 ----------
r.get(
  '/orders',
  ...G,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    const scope = readScope(req, { bindAlias: 'so', kind: 'order' })
    if (scope.sql) {
      conds.push(scope.sql.replace(/^\s*AND\s*/, '').replace(/\s*$/, '').trim())
      params.push(...scope.params)
    }
    if (req.query.channel) {
      conds.push('so.channel = ?')
      params.push(req.query.channel)
    }
    if (req.query.status) {
      conds.push('so.status = ?')
      params.push(req.query.status)
    }
    if (req.query.startDate) {
      conds.push('so.order_date >= ?')
      params.push(req.query.startDate)
    }
    if (req.query.endDate) {
      conds.push('so.order_date <= ?')
      params.push(req.query.endDate)
    }
    if (req.query.keyword) {
      conds.push('(so.doc_no LIKE ? OR d.name LIKE ? OR s.name LIKE ? OR so.oms_order_no LIKE ?)')
      const kw = `%${req.query.keyword}%`
      params.push(kw, kw, kw, kw)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM ${SO_FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(`SELECT ${SO_SELECT} FROM ${SO_FROM} ${where} ORDER BY so.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/orders/:id',
  ...G,
  wrap((req, res) => {
    const db = getDb()
    const order = loadOrder(db, Number(req.params.id))
    if (!order) return fail(res, '销售订单不存在', 404)
    // 授权判据与列表接口**同一份**（middleware/auth.js 的 scopePairs）。
    // 这里曾经手写 `if (role === 'dealer' && ...)` —— 只有 dealer 分支、没有 store 分支，
    // 于是列表看不到的其他门店订单，详情却能直接打开。
    const d = assertCanRead(req, order)
    if (!d.ok) return fail(res, d.message, d.status)
    // 内部账号：组织范围外与不存在同形（ADR-0026）
    const oos = denyOutOfOrgScope(req, res, db, 'order', order.id)
    if (oos) return
    return ok(res, order)
  })
)

r.post(
  '/orders',
  ...G,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const {
      channel = 'dealer', dealer_id, store_id, platform_id, oms_order_no, order_date,
      items = [], receiver, receiver_phone, receiver_address, freight = 0,
      discount_amount = 0, warehouse_id, remark, salesperson
    } = req.body || {}
    if (!Array.isArray(items) || !items.length) return fail(res, '请至少添加一行销售商品')
    // 单头字段兜底与实体校验：避免空表单 / 失效主数据直接触发 SQL 约束错误（500）
    const orderDate = String(order_date || '').trim() || localDate()
    if (channel === 'dealer' && !dealer_id) return fail(res, '经销商渠道必须选择经销商')
    if (channel === 'store' && !store_id) return fail(res, '门店渠道必须选择门店')
    const dealer = dealer_id ? db.prepare('SELECT * FROM dealers WHERE id=?').get(dealer_id) : null
    if (channel === 'dealer' && !dealer) return fail(res, '所选经销商不存在，请重新选择')
    if (channel === 'store' && !db.prepare('SELECT id FROM stores WHERE id=?').get(store_id))
      return fail(res, '所选门店不存在，请重新选择')
    if (platform_id && !db.prepare('SELECT id FROM platforms WHERE id=?').get(platform_id))
      return fail(res, '所选平台店铺不存在，请重新选择')

    let whId = warehouse_id ? Number(warehouse_id) : null
    if (whId && !db.prepare("SELECT id FROM warehouses WHERE id=? AND status='active'").get(whId))
      return fail(res, '所选仓库不存在，请重新选择')
    if (!whId) {
      if (channel === 'store' && store_id) {
        whId = db.prepare("SELECT id FROM warehouses WHERE store_id=? AND status='active' LIMIT 1").get(store_id)?.id
      }
      whId =
        whId ||
        db.prepare("SELECT id FROM warehouses WHERE type='central' AND status='active' LIMIT 1").get()?.id ||
        db.prepare("SELECT id FROM warehouses WHERE status='active' LIMIT 1").get()?.id
    }
    if (!whId) return fail(res, '没有可用仓库，请先在仓库档案中维护')
    // 写路径目标校验（ADR-0026）：出货仓与门店的归属组织必须在调用者范围内
    const oosTarget = denyTargetOutOfScope(req, res, db, { warehouseId: whId, storeId: store_id || null })
    if (oosTarget) return
    // 单头金额：运费与整单折扣也必须非负、两位小数。
    // 以前它们直接 `Number(discount_amount || 0)` 进库，配合行价格就能算出负应收。
    const chkFreight = numAmount(freight, '运费')
    if (!chkFreight.ok) return fail(res, chkFreight.message)
    const chkDiscount = numAmount(discount_amount, '整单折扣金额')
    if (!chkDiscount.ok) return fail(res, chkDiscount.message)
    // 明细预校验：数量、单价、行折扣与 SKU 有效性（避免事务内触发外键错误、或静默落一张空草稿单）
    // 校验结果直接组成 lines，事务里不再二次解析请求体 —— 校验过的值与写库的值必须**是同一个**，
    // 否则"校验了 A、写进去的是 B"，校验等于没做。
    const lines = []
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i]
      const at = `第 ${i + 1} 行`
      if (!db.prepare('SELECT id FROM product_skus WHERE id=?').get(Number(it.sku_id))) {
        return fail(res, `${at}：商品 SKU#${it.sku_id} 不存在，请重新选择`)
      }
      const q = numQty(it.qty, `${at}销售数量`)
      if (!q.ok) return fail(res, q.message)
      const disc = numAmount(it.discount, `${at}行折扣金额`)
      if (!disc.ok) return fail(res, disc.message)
      let priceInput = null
      if (it.price != null && it.price !== '') {
        const p = numAmount(it.price, `${at}销售单价`)
        if (!p.ok) return fail(res, p.message)
        priceInput = p.value
      }
      lines.push({ sku_id: Number(it.sku_id), qty: q.value, priceInput, discount: disc.value ?? 0, remark: it.remark || null })
    }
    // 制单人外键兜底：token 中的 uid 若在当前行业库不存在则置空，避免 FK 失败
    const createdBy = u.uid && db.prepare('SELECT id FROM users WHERE id=?').get(u.uid) ? u.uid : null

    const tx = db.transaction(() => {
      const docNo = nextDocNo(db, 'SO', 'sales_orders', 'doc_no', orderDate)
      const info = db
        .prepare(
          `INSERT INTO sales_orders
           (doc_no,channel,dealer_id,store_id,platform_id,oms_order_no,order_date,status,total_qty,goods_amount,discount_amount,freight,receivable_amount,paid_amount,
            receiver,receiver_phone,receiver_address,salesperson,remark,created_by,warehouse_id)
           VALUES (?,?,?,?,?,?,?,'draft',0,0,?,?,0,0,?,?,?,?,?,?,?)`
        )
        .run(
          docNo, channel, dealer_id || null, store_id || null, platform_id || null, oms_order_no || null, orderDate,
          chkDiscount.value ?? 0, chkFreight.value ?? 0, receiver || null, receiver_phone || null,
          receiver_address || null, salesperson || u.name || null, remark || null, createdBy, whId
        )
      const soId = info.lastInsertRowid
      const insItem = db.prepare(
        'INSERT INTO sales_order_items (order_id,sku_id,qty,price,discount,amount,remark) VALUES (?,?,?,?,?,?,?)'
      )
      for (const it of lines) {
        const auto = resolvePrice(db, it.sku_id, { channel, dealer })
        const price = it.priceInput != null ? it.priceInput : auto.price
        insItem.run(soId, it.sku_id, it.qty, price, it.discount, Number((it.qty * price).toFixed(2)), it.remark)
      }
      recalcOrder(db, soId)
      return soId
    })
    const id = tx()
    audit(req, { action: 'CREATE', module: 'sales', entity: 'sales_orders', entityId: id })
    return ok(res, loadOrder(db, id))
  })
)

r.put(
  '/orders/:id',
  ...G,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const order = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(id)
    if (!order) return fail(res, '销售订单不存在', 404)
    const oos = denyOutOfOrgScope(req, res, db, 'order', id)
    if (oos) return
    if (!['draft'].includes(order.status)) return fail(res, '只有草稿订单可以修改')
    const { items, receiver, receiver_phone, receiver_address, freight, discount_amount, remark, warehouse_id } =
      req.body || {}
    if (warehouse_id != null) {
      const oosWh = denyTargetOutOfScope(req, res, db, { warehouseId: warehouse_id })
      if (oosWh) return
    }
    // 与建单同一套校验：修改草稿同样是"把钱写进库"的入口，不能只在 create 上拦。
    const chkFreight = freight === undefined ? { ok: true, value: null } : numAmount(freight, '运费')
    if (!chkFreight.ok) return fail(res, chkFreight.message)
    const chkDiscount =
      discount_amount === undefined ? { ok: true, value: null } : numAmount(discount_amount, '整单折扣金额')
    if (!chkDiscount.ok) return fail(res, chkDiscount.message)
    const lines = []
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i += 1) {
        const it = items[i]
        const at = `第 ${i + 1} 行`
        if (!db.prepare('SELECT id FROM product_skus WHERE id=?').get(Number(it.sku_id))) {
          return fail(res, `${at}：商品 SKU#${it.sku_id} 不存在，请重新选择`)
        }
        const q = numQty(it.qty, `${at}销售数量`)
        if (!q.ok) return fail(res, q.message)
        const disc = numAmount(it.discount, `${at}行折扣金额`)
        if (!disc.ok) return fail(res, disc.message)
        let priceInput = null
        if (it.price != null && it.price !== '') {
          const p = numAmount(it.price, `${at}销售单价`)
          if (!p.ok) return fail(res, p.message)
          priceInput = p.value
        }
        lines.push({ sku_id: Number(it.sku_id), qty: q.value, priceInput, discount: disc.value ?? 0, remark: it.remark || null })
      }
    }
    // 单头字段（运费 / 整单折扣）也参与应收金额的计算 ⇒ 只改单头同样必须重算。
    // 旧实现只在 `Array.isArray(items)` 时调 recalcOrder，于是：
    //   · PUT { freight: 30 } 返回 200、运费落库了，**应收还是老数**（静默不一致）；
    //   · PUT { discount_amount: 99999 } 也返回 200 —— 因为它压根没算，
    //     连"应收被推成负数就别落库"这道闸门都没触发。
    const headChanged = freight !== undefined || discount_amount !== undefined
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE sales_orders SET receiver=?,receiver_phone=?,receiver_address=?,freight=?,discount_amount=?,remark=?,warehouse_id=?,updated_at=datetime('now','localtime') WHERE id=?`
      ).run(
        receiver ?? order.receiver,
        receiver_phone ?? order.receiver_phone,
        receiver_address ?? order.receiver_address,
        chkFreight.value ?? order.freight,
        chkDiscount.value ?? order.discount_amount,
        remark ?? order.remark,
        warehouse_id ?? order.warehouse_id,
        id
      )
      if (Array.isArray(items)) {
        db.prepare('DELETE FROM sales_order_items WHERE order_id=?').run(id)
        const dealer = order.dealer_id ? db.prepare('SELECT * FROM dealers WHERE id=?').get(order.dealer_id) : null
        const insItem = db.prepare(
          'INSERT INTO sales_order_items (order_id,sku_id,qty,price,discount,amount,remark) VALUES (?,?,?,?,?,?,?)'
        )
        for (const it of lines) {
          const auto = resolvePrice(db, it.sku_id, { channel: order.channel, dealer })
          const price = it.priceInput != null ? it.priceInput : auto.price
          insItem.run(id, it.sku_id, it.qty, price, it.discount, Number((it.qty * price).toFixed(2)), it.remark)
        }
      }
      // recalcOrder 在事务内：金额为负时它会抛错，整笔修改（含刚落库的单头字段）一并回滚
      if (Array.isArray(items) || headChanged) recalcOrder(db, id)
    })
    tx()
    return ok(res, loadOrder(db, id))
  })
)

// 确认订单：占用库存（防超卖）
r.post(
  '/orders/:id/confirm',
  ...G,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const order = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(id)
    if (!order) return fail(res, '销售订单不存在', 404)
    const oos = denyOutOfOrgScope(req, res, db, 'order', id)
    if (oos) return
    if (order.status !== 'draft') return fail(res, `当前状态「${order.status}」不能确认`)
    const items = db.prepare('SELECT * FROM sales_order_items WHERE order_id=?').all(id)

    // 信用闸门：确认订单是授信真正被占用的时点，所以必须在此之前拦一次。
    // 未建档（未授信）账户不拦 —— 那是现结客户，按现结处理（口径见 lib/credit.js）。
    const acc = creditAccountOf(db, order)
    const credit = acc
      ? checkCredit(db, {
          accountId: acc.id,
          amount: Number(order.receivable_amount || 0),
          scene: 'order.confirm',
          sourceType: 'SO',
          sourceId: id,
          docNo: order.doc_no,
          force: !!req.body?.force,
          reason: req.body?.credit_reason || null,
          actor: { id: currentUser(req).uid || currentUser(req).id || null, name: currentUser(req).name || currentUser(req).username || null }
        })
      : null
    if (credit && !credit.pass) {
      // 形状统一交给唯一构造点 `bizFail`。信用拦截的 `credit` 明细原样进 detail
      // （原先它被塞在 `detail.detail` 里；已核实全仓无人读 `detail.detail`，前端只读 `detail.code`）。
      return bizFail(res, {
        status: 409,
        code: 'CREDIT_BLOCKED',
        message: `信用校验未通过：${credit.blocking.map((c) => c.message).join('；')}`,
        detail: credit
      })
    }

    const tx = db.transaction(() => {
      // 占库走唯一入口：拣选 → 预留 → **登记"谁占的"**。
      // 少了最后一步，预留就只是库存行上的一个数字：说不出是替哪张单占的，
      // 于是发货/取消只能"重新按当前库存再拣一次"——而那时的库存已经不是当时那批了。
      reserveForDoc(db, {
        sourceDocType: 'SO',
        sourceDocId: id,
        sourceDocNo: order.doc_no,
        warehouseId: order.warehouse_id,
        items: items.map((it) => ({ skuId: it.sku_id, qty: it.qty }))
      })
      // 状态推进走单据内核：合法性由 doc_actions 定义，且自动留痕
      advanceStatus(db, req, { docType: 'SO', id, action: 'confirm', set: { updated_at: nowText() }, remark: '确认订单并占用库存' })

      // 占用授信：额度为 0（未授信）不占 —— 现结客户本来就不该占用额度
      if (credit?.account && credit.account.limit > 0) {
        const hold = Number(order.receivable_amount || 0)
        occupy(db, {
          account: credit.account.account_id,
          amount: hold,
          sourceType: 'SO',
          sourceId: id,
          docNo: order.doc_no,
          creditDays: credit.account.credit_days,
          operator: { id: currentUser(req).uid || currentUser(req).id || null, name: currentUser(req).name || currentUser(req).username || null },
          remark: credit.result === 'force' ? `订单确认占用（超信特批：${req.body?.credit_reason || ''}）` : '订单确认占用授信'
        })
        // `credit_hold` 由 occupy 在台账写入时投影（ADR-0014），这里只记"何时校验过"
        db.prepare("UPDATE sales_orders SET credit_checked_at=datetime('now','localtime') WHERE id=?").run(id)
      }
    })
    tx()
    audit(req, { action: 'CONFIRM', module: 'sales', entity: 'sales_orders', entityId: id })
    return ok(res, loadOrder(db, id))
  })
)

r.post(
  '/orders/:id/cancel',
  ...G,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const u = currentUser(req)
    // 范围判定在任何写入之前（ADR-0026）；`cancelOrder` 是 HTTP / MCP 共用的实现，不在里面掺调用者范围
    const oos = denyOutOfOrgScope(req, res, db, 'order', id)
    if (oos) return
    // D5：作废订单的**唯一实现**在 lib/sales-order.js —— MCP 的 sales.cancel_order 调同一个函数。
    // 原来两处各写一份，MCP 那份只有一行 UPDATE：库存占用没释放、授信没还，
    // 而单子看起来"已作废"。入口可以有两个，实现只能有一份。
    try {
      cancelOrder(db, {
        id,
        reason: req.body?.reason || null,
        actor: { id: u.uid || u.id || null, name: u.name || u.username || null }
      })
    } catch (e) {
      if (e instanceof SalesOrderError) {
        return bizFail(res, e)
      }
      throw e
    }
    audit(req, { action: 'CANCEL', module: 'sales', entity: 'sales_orders', entityId: id })
    return ok(res, loadOrder(db, id))
  })
)

// 发货出库
r.post(
  '/orders/:id/deliver',
  ...G,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const id = Number(req.params.id)
    const order = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(id)
    if (!order) return fail(res, '销售订单不存在', 404)
    const oos = denyOutOfOrgScope(req, res, db, 'order', id)
    if (oos) return
    if (!['confirmed', 'picking'].includes(order.status)) return fail(res, '只有已确认的订单可以发货')
    const { delivery_date, express_company, express_no, warehouse_id, remark } = req.body || {}
    const whId = warehouse_id || order.warehouse_id
    // 改仓发货等于动另一个仓的库存：发货仓也必须在范围内（ADR-0026）
    const oosWh = denyTargetOutOfScope(req, res, db, { warehouseId: whId })
    if (oosWh) return
    const items = db.prepare('SELECT * FROM sales_order_items WHERE order_id=?').all(id)
    const legacyItems = [] // 走了兼容路径（无预留明细）的 SKU，回执里明示出来

    const tx = db.transaction(() => {
      const docNo = nextDocNo(db, 'SD', 'sales_deliveries', 'doc_no', delivery_date)
      const info = db
        .prepare(
          `INSERT INTO sales_deliveries (doc_no,order_id,warehouse_id,delivery_date,status,total_qty,total_amount,express_company,express_no,remark,created_by)
           VALUES (?,?,?,?,'shipped',0,0,?,?,?,?)`
        )
        .run(docNo, id, whId, delivery_date, express_company || order.express_company || null, express_no || order.express_no || null, remark || null, u.uid || null)
      const did = info.lastInsertRowid
      const insItem = db.prepare(
        'INSERT INTO sales_delivery_items (delivery_id,sku_id,batch_no,qty,price,amount) VALUES (?,?,?,?,?,?)'
      )
      let qtyAll = 0
      let amtAll = 0
      const shortList = []
      for (const it of items) {
        const need = it.qty - it.shipped_qty
        if (need <= 0) continue
        // 发货 = **消费本单占住的那批货**（planShipment 读的就是确认时登记的预留明细）。
        // 不再"重新拣一次"：那会拣到已经被别的单占住的批次，结果是出货 0 件 +
        // 预留永远挂着（幽灵预留），并且落下一张 0 数量的发货单。
        // 本单预留不够时**不抢别人的** —— 缺口如实报出来，部分发货。
        const { plan, shortage, mode } = planShipment(db, {
          sourceDocType: 'SO',
          sourceDocId: id,
          warehouseId: whId,
          skuId: it.sku_id,
          needQty: need
        })
        if (mode === 'legacy') legacyItems.push(it.sku_id)
        if (shortage > 0) shortList.push({ sku_id: it.sku_id, shortage, reserved: mode === 'reservation' })
        let shippedQty = 0
        for (const p of plan) {
          applyStockOut(db, {
            bizDate: delivery_date,
            docType: 'SAL_OUT',
            docNo,
            docId: did,
            warehouseId: whId,
            skuId: it.sku_id,
            batchNo: p.batchNo,
            qty: p.qty,
            unitCost: p.unitCost,
            counterparty: order.doc_no,
            operator: u.name,
            remark: `销售出库(${CHANNEL_LABEL[order.channel] || order.channel})`
          })
          insItem.run(did, it.sku_id, p.batchNo, p.qty, it.price, Number((p.qty * it.price).toFixed(2)))
          qtyAll += p.qty
          shippedQty += p.qty
          amtAll += p.qty * it.price
        }
        db.prepare('UPDATE sales_order_items SET shipped_qty = shipped_qty + ? WHERE id=?').run(shippedQty, it.id)
      }
      // **不许产生 0 数量的发货单**：一张"已发货、0 件"的单没有任何业务含义，
      // 却会让订单看起来发过了、而库存一件没动 —— 全链路没有一处会报错。
      if (qtyAll <= 0) {
        const err = new Error(
          shortList.length
            ? `没有任何货可发：${shortList.map((s) => `SKU#${s.sku_id} 缺 ${s.shortage}`).join('；')}`
            : '没有任何货可发（订单行已全部发完）'
        )
        err.status = 409
        err.code = 'NOTHING_TO_SHIP'
        err.detail = { shortages: shortList }
        throw err
      }
      db.prepare('UPDATE sales_deliveries SET total_qty=?, total_amount=? WHERE id=?').run(qtyAll, Number(amtAll.toFixed(2)), did)

      // 建单留痕（铁律：留痕须与改动同生共死、**写在改动旁边**，且在同一个事务里）。
      //
      // 发货单是**建出来就是 `shipped`** 的：上面这几行在同一个事务里已经出库（applyStockOut、
      // 写 inventory_transactions 的 `SAL_OUT`）并把单子落成 `shipped`，所以**不存在**一次
      // `DL.ship`（draft→shipped）的流转可记。不在这里记，「这张发货单怎么来的」在
      // `doc_events` 里就是空白（实测形状：修前三库 DL 的 doc_events 条数是 **0**）。
      //
      // `action='create'` 而**不是** `'ship'`：`ship` 是内核里 draft→shipped 那条**边**的动作码，
      // 这张单从没处于 draft，冒用它等于在时间线上伪造一次没发生过的流转（与 SR 建单同一口径）。
      // `from_state` 留空、`to_state='shipped'` —— 如实说"它建出来就在已发货"。
      // payload 带上**库存侧的对账锚点**（`SAL_OUT` 的 doc_no 就是本单号），
      // 这样"这张单建的时候出了多少库"能一路对到 inventory_transactions。
      logEvent({
        db,
        docType: 'DL',
        id: did,
        docNo,
        action: 'create',
        actionName: '建单',
        to: 'shipped',
        actor: { id: u.uid || u.id || null, name: u.name || u.username || null },
        source: 'api',
        remark:
          shortList.length > 0
            ? `发货单建单（发货出库，部分发货：${shortList.length} 个 SKU 有缺口）`
            : '发货单建单（发货出库，整单发完）',
        payload: {
          order_id: id,
          order_no: order.doc_no,
          warehouse_id: whId,
          qty: qtyAll,
          amount: Number(amtAll.toFixed(2)),
          // 与库存流水对得上：doc_type='SAL_OUT' 且 doc_no=本发货单号、doc_id=本发货单 id
          inventory_doc_type: 'SAL_OUT',
          inventory_doc_no: docNo,
          shortages: shortList,
          legacy_items: legacyItems.length ? legacyItems : undefined
        }
      })
      const pend = db
        .prepare('SELECT COALESCE(SUM(qty - shipped_qty),0) p FROM sales_order_items WHERE order_id=?')
        .get(id).p
      // 全部发完 → 已发货；仍有欠发 → 拣货中（动作不同，同一条状态机规则链）
      advanceStatus(db, req, {
        docType: 'SO',
        id,
        action: pend <= 0.0001 ? 'ship' : 'pick',
        set: {
          express_company: express_company || order.express_company || null,
          express_no: express_no || order.express_no || null,
          updated_at: nowText()
        },
        remark: `发货单 ${docNo}`
      })
      return { did, shortList }
    })
    const { did, shortList } = tx()
    audit(req, { action: 'DELIVER', module: 'sales', entity: 'sales_deliveries', entityId: did })
    return ok(res, {
      delivery_id: did,
      shortages: shortList,
      // 兼容路径的提示：这些行没有预留明细（确认早于 A05 修复），走的是"按当前可用量拣选"
      legacy_items: legacyItems.length ? legacyItems : undefined,
      order: loadOrder(db, id)
    })
  })
)

r.post(
  '/orders/:id/complete',
  ...G,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    if (db.prepare('SELECT 1 FROM sales_orders WHERE id=?').get(id)) {
      const oos = denyOutOfOrgScope(req, res, db, 'order', id)
      if (oos) return
    }
    advanceStatus(db, req, { docType: 'SO', id, action: 'complete', expectFrom: 'shipped', remark: '订单完成' })
    return ok(res, loadOrder(db, id))
  })
)

r.post(
  '/orders/:id/payment',
  ...G,
  requireRole(...W, 'finance'),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const order = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(id)
    if (!order) return fail(res, '销售订单不存在', 404)
    const oos = denyOutOfOrgScope(req, res, db, 'order', id)
    if (oos) return
    const amount = Number(req.body?.amount || 0)
    if (!(amount > 0)) return fail(res, '回款金额必须大于 0')
    // 回款必须走「收款单 + 核销」：先有应收单才有核销对象。
    // 没有应收单（历史数据 / 门店现结）时按来源自动补一张，保证钱抵的是哪笔可追。
    //
    // S-2：找的必须是**这张订单的应收**（按订单聚合、不分来源，见 ar.js `arOfOrder`）。
    // 原来只按 `source_type='SO'` 找 ⇒ 订单已经挂着 `SI` 应收（开票建的）时它看不见，
    // 于是又 `ensureAr` 建一张 `SO` 应收 ⇒ 同一订单两笔债权（实测 200 → 400）。
    const ar =
      arOfOrder(db, id)[0] ||
      ensureAr(db, {
        subjectType: order.dealer_id ? 'dealer' : 'store',
        subjectId: order.dealer_id || order.store_id,
        subjectName: null,
        sourceType: 'SO',
        sourceId: id,
        sourceDocNo: order.doc_no,
        bizDate: order.order_date,
        amount: order.receivable_amount || 0,
        creditDays: 0,
        remark: '回款时补生成应收',
        actor: actorOf(req)
      })
    // 核销**必须指定这一张应收单**（A08）：
    // 原来不传 allocations，createReceipt 会按"同主体的全部未结应收 + 到期日 FIFO"自动摊，
    // 于是「给这张单回款」实际抵到了同客户的**另一张单**上 —— 客户说"我付的是 10 月那单"，
    // 系统抵到了 9 月那单，两张单的状态都变了，而没有任何提示。
    const openOfThis = Number((Number(ar.amount || 0) - Number(ar.allocated_amount || 0)).toFixed(2))
    const toThis = Math.min(amount, Math.max(openOfThis, 0))
    const rc = createReceipt(db, {
      subjectType: ar.subject_type,
      subjectId: ar.subject_id,
      receiptDate: req.body?.receipt_date || localDate(),
      method: req.body?.method || 'transfer',
      amount,
      serialNo: req.body?.serial_no || null,
      remark: req.body?.remark || '销售订单回款',
      // 只抵这张单；多出来的部分**停在预收**，不替客户决定"这钱该抵哪张"
      allocations: toThis > 0.005 ? [{ ar_id: ar.id, amount: toThis }] : [],
      actor: actorOf(req)
    })
    // 确认即生效：核销抵减应收、释放授信（草稿上的核销只是计划，不算数）
    confirmReceipt(db, { id: rc.id, actor: actorOf(req), releaseCredit: true })
    if (order.dealer_id) {
      db.prepare('UPDATE dealers SET credit_used = MAX(credit_used - ?, 0) WHERE id=?').run(toThis, order.dealer_id)
    }
    audit(req, { action: 'PAYMENT', module: 'sales', entity: 'sales_orders', entityId: id, detail: String(amount) })
    return ok(res, {
      ...loadOrder(db, id),
      // 把这次回款落在哪儿如实回报：抵了多少、还剩多少是预收
      receipt: {
        id: rc.id,
        doc_no: rc.doc_no,
        amount,
        allocated: toThis,
        unallocated: Number((amount - toThis).toFixed(2)),
        ar_id: ar.id,
        ar_doc_no: ar.doc_no
      }
    })
  })
)

// ---------- 发货单 ----------
r.get(
  '/deliveries',
  ...G,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const FROM = `sales_deliveries sd LEFT JOIN sales_orders so ON so.id=sd.order_id
      LEFT JOIN warehouses w ON w.id=sd.warehouse_id LEFT JOIN dealers d ON d.id=so.dealer_id LEFT JOIN stores s ON s.id=so.store_id`
    // 发货单本身没有 dealer_id/store_id，范围挂在它所属的销售订单上
    const scope = readScope(req, { bindAlias: 'so', kind: 'delivery', docAlias: 'sd' })
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} WHERE 1=1${scope.sql}`).get(...scope.params).c
    const rows = db
      .prepare(
        `SELECT sd.*, so.doc_no AS order_no, so.channel, w.name AS warehouse_name,
                COALESCE(d.name, s.name, so.receiver, '线上买家') AS customer_name
         FROM ${FROM} WHERE 1=1${scope.sql} ORDER BY sd.id DESC LIMIT ? OFFSET ?`
      )
      .all(...scope.params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/deliveries/:id',
  ...G,
  wrap((req, res) => {
    const db = getDb()
    const head = db
      .prepare(
        `SELECT sd.*, so.doc_no AS order_no, so.channel, so.dealer_id, so.store_id, w.name AS warehouse_name
         FROM sales_deliveries sd
         LEFT JOIN sales_orders so ON so.id=sd.order_id LEFT JOIN warehouses w ON w.id=sd.warehouse_id WHERE sd.id=?`
      )
      .get(Number(req.params.id))
    if (!head) return fail(res, '发货单不存在', 404)
    const d = assertCanRead(req, head)
    if (!d.ok) return fail(res, d.message, d.status)
    const oos = denyOutOfOrgScope(req, res, db, 'delivery', head.id)
    if (oos) return
    head.items = db
      .prepare(
        `SELECT i.*, sk.sku_code, sk.name AS sku_name, p.name AS product_name FROM sales_delivery_items i
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id WHERE i.delivery_id=?`
      )
      .all(head.id)
    return ok(res, head)
  })
)

// 发货单签收：已发货 → 已签收（DL 链的收口动作）。
//
// 为什么是**纯内核流转**、不在这里写库存/成本逻辑：
//   签收是"货已经在路上、客户收到了"这个事实的登记 —— 出库与成本结转都发生在 `ship` 那一步
//   （`POST /api/sales/orders/:id/deliver` 已调 applyStockOut）。签收本身没有任何数字后果，
//   所以它的后果就是"状态变了、且留了痕"。
//
// 为什么不能裸 `UPDATE sales_deliveries SET status='received'`：
//   ① 合法性就没有出处了 —— 边定义在 `008_doc_kernel.cjs` 的 `ACTIONS.DL`
//      （`['receive','签收','shipped','received','sales.outbound',0]`），内核才是判据；
//   ② **留痕会一起丢** —— `doc_events` 的那一行是 applyTransition 顺手写的，
//      手写 UPDATE 只改状态、不留痕，于是这张单在时间线上"从已发货直接变成已签收"，
//      中间没有人、没有时间、没有动作名（本项目铁律：留痕须与改动同生共死）。
//
// 幂等与状态前置（产品口径，都不另写 if，判据就是内核里的边）：
//   · 已签收再点一次 ⇒ 409「状态「已签收」已是终态，不能继续流转」（不会二次生效）；
//   · 待发货（draft）点签收 ⇒ 409「状态「待发货」不支持动作「签收」，当前可执行：发货 / 取消」——
//     凭空跳到"已签收"这条捷径**不存在**，因为 `receive` 边的 from_state 只有 `shipped`；
//   · 两个 409 都是 DocFlowError，由全局 errorHandler 走 bizFail 输出，
//     带业务码 `TRANSITION_NOT_ALLOWED`，不会退化成 500。
r.post(
  '/deliveries/:id/receive',
  ...G,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    // 发货单自己不带 dealer_id/store_id，数据范围挂在它所属的销售订单上 ——
    // 与列表（`scopeFilter(req,'so')`）和详情（`assertCanRead(req, head)`）**同一份判据**，
    // 不能这里另写一套（否则会重演"列表挡得住、单条挡不住"）。
    const head = db
      .prepare(
        `SELECT sd.*, so.dealer_id, so.store_id FROM sales_deliveries sd
         LEFT JOIN sales_orders so ON so.id = sd.order_id WHERE sd.id=?`
      )
      .get(id)
    if (!head) return fail(res, '发货单不存在', 404)
    const d = assertCanRead(req, head)
    if (!d.ok) return fail(res, d.message, d.status)
    const oos = denyOutOfOrgScope(req, res, db, 'delivery', id)
    if (oos) return

    const out = advanceStatus(db, req, {
      docType: 'DL',
      id,
      action: 'receive',
      remark: req.body?.remark || '发货单签收'
    })
    audit(req, { action: 'RECEIVE', module: 'sales', entity: 'sales_deliveries', entityId: id })
    return ok(res, { ...out, delivery: db.prepare('SELECT * FROM sales_deliveries WHERE id=?').get(id) })
  })
)

// ---------- 销售退货 ----------
// D1：退货闭环。原来这里只做三件事：建单、按请求给的单价入库、推一下订单状态。
// 于是「退多少、按什么成本、应收怎么办」三件事都没有依据 —— 详见 lib/returns.js 的文件头。
r.get(
  '/returns',
  ...G,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const FROM = `sales_returns t LEFT JOIN dealers d ON d.id=t.dealer_id LEFT JOIN stores s ON s.id=t.store_id
      LEFT JOIN warehouses w ON w.id=t.warehouse_id LEFT JOIN sales_orders so ON so.id=t.order_id`
    // 退货单自带 dealer_id/store_id，范围直接挂在它自己身上
    const scope = readScope(req, { bindAlias: 't', kind: 'return' })
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} WHERE 1=1${scope.sql}`).get(...scope.params).c
    const rows = db
      .prepare(
        `SELECT t.*, COALESCE(d.name, s.name) AS customer_name, w.name AS warehouse_name, so.doc_no AS order_no FROM ${FROM} WHERE 1=1${scope.sql} ORDER BY t.id DESC LIMIT ? OFFSET ?`
      )
      .all(...scope.params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.post(
  '/returns',
  ...G,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const b = req.body || {}
    // 写路径范围校验（ADR-0026）：来源订单、入库仓、门店都必须在调用者范围内；
    // 有来源订单且未指定仓时，入库仓就是订单出货仓，同样要在范围内
    let srcOrder = null
    if (b.order_id) {
      srcOrder = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(Number(b.order_id))
      if (srcOrder) {
        const oos = denyOutOfOrgScope(req, res, db, 'order', srcOrder.id)
        if (oos) return
      }
    }
    const retWh = b.warehouse_id || srcOrder?.warehouse_id || null
    const retStore = b.store_id || null
    if (retWh != null || retStore != null) {
      const oosT = denyTargetOutOfScope(req, res, db, { warehouseId: retWh, storeId: retStore })
      if (oosT) return
    }
    try {
      const out = createSalesReturn(db, req, {
        orderId: b.order_id || null,
        // 关联了订单 = 有单退货（必须绑来源行）；没关联 = 无单退货（显式标注，不参与追溯）
        sourceType: b.source_type || (b.order_id ? 'order' : 'walkin'),
        items: b.items || [],
        warehouseId: b.warehouse_id || null,
        returnDate: b.return_date || null,
        reason: b.reason || null,
        channel: b.channel || 'dealer',
        dealerId: b.dealer_id || null,
        storeId: b.store_id || null,
        idempotencyKey: b.idempotency_key || req.headers['x-idempotency-key'] || null,
        actor: { id: u.uid || null, name: u.name || u.username || null }
      })
      audit(req, { action: 'CREATE', module: 'sales', entity: 'sales_returns', entityId: out.id })
      return ok(res, out)
    } catch (e) {
      if (e instanceof ReturnError) {
        return bizFail(res, e)
      }
      throw e
    }
  })
)

// 退货完成：已确认 → 已完成（SR 链的收口动作）。
//
// 现状说明（避免把它当"可有可无的一步"）：
//   退货单在**建单那一刻**就已经把货回库了（`lib/returns.js` 的 createSalesReturn 里
//   applyStockIn 与应收冲减都在同一个事务内），建出来的状态直接是 `confirmed`。
//   所以 `complete` 不是"再入一次库"，而是把这张单**闭合**：
//   「货已回、账已冲、这单结了」——闭合之后它不再出现在待处理队列里。
//
// 与签收同一条口径：走内核 `advanceStatus`、不裸 UPDATE、不另写合法性 if。
//   边定义：`008_doc_kernel.cjs` 的 `ACTIONS.SR` —— `['complete','完成入库','confirmed','completed','sales.return',0]`。
//   `draft` 没有 complete 边 ⇒ 未确认的退货单点完成得到 409，而不是被推成"已完成"（凭空跳过确认）。
//   重复点 ⇒ 409「状态「已完成」已是终态，不能继续流转」。
r.post(
  '/returns/:id/complete',
  ...G,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    // 退货单自带 dealer_id / store_id，范围直接挂在它自己身上 —— 与列表 `scopeFilter(req,'t')` 同源
    const row = db.prepare('SELECT * FROM sales_returns WHERE id=?').get(id)
    if (!row) return fail(res, '退货单不存在', 404)
    const d = assertCanRead(req, row)
    if (!d.ok) return fail(res, d.message, d.status)
    const oos = denyOutOfOrgScope(req, res, db, 'return', id)
    if (oos) return

    const out = advanceStatus(db, req, {
      docType: 'SR',
      id,
      action: 'complete',
      remark: req.body?.remark || '退货完成'
    })
    audit(req, { action: 'COMPLETE', module: 'sales', entity: 'sales_returns', entityId: id })
    return ok(res, { ...out, return: db.prepare('SELECT * FROM sales_returns WHERE id=?').get(id) })
  })
)

// ---------- 销售分析 ----------
r.get(
  '/stats',
  ...G,
  wrap((req, res) => {
    const db = getDb()
    const days = Number(req.query.days || 30)
    const from = `date('now','localtime', '-${days} day')`
    // 统计也是"读"：门店账号不该从汇总里看到别家门店的销售结构。
    // 这里按各自 SQL 里的表别名分别取范围片段，与列表/详情同源。
    const sOrders = readScope(req, { bindAlias: 'sales_orders', kind: 'order' })
    const sSo = readScope(req, { bindAlias: 'so', kind: 'order' })
    const byChannel = db
      .prepare(
        `SELECT channel, COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount, COALESCE(SUM(total_qty),0) qty
         FROM sales_orders WHERE status NOT IN ('cancelled','draft') AND order_date >= ${from}${sOrders.sql} GROUP BY channel`
      )
      .all(...sOrders.params)
    const trend = db
      .prepare(
        `SELECT order_date AS date, COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount
         FROM sales_orders WHERE status NOT IN ('cancelled','draft') AND order_date >= ${from}${sOrders.sql} GROUP BY order_date ORDER BY order_date`
      )
      .all(...sOrders.params)
    const topProducts = db
      .prepare(
        `SELECT p.name AS product_name, sk.name AS sku_name, SUM(i.qty) qty, SUM(i.amount) amount
         FROM sales_order_items i JOIN sales_orders so ON so.id=i.order_id
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id
         WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${from}${sSo.sql}
         GROUP BY sk.id ORDER BY amount DESC LIMIT 10`
      )
      .all(...sSo.params)
    const topDealers = db
      .prepare(
        `SELECT d.name, COUNT(so.id) orders, COALESCE(SUM(so.receivable_amount),0) amount
         FROM sales_orders so JOIN dealers d ON d.id=so.dealer_id
         WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${from}${sSo.sql}
         GROUP BY d.id ORDER BY amount DESC LIMIT 10`
      )
      .all(...sSo.params)
    const topStores = db
      .prepare(
        `SELECT s.name, COUNT(so.id) orders, COALESCE(SUM(so.receivable_amount),0) amount
         FROM sales_orders so JOIN stores s ON s.id=so.store_id
         WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${from}${sSo.sql}
         GROUP BY s.id ORDER BY amount DESC LIMIT 10`
      )
      .all(...sSo.params)
    const pendingDelivery = db
      .prepare(`SELECT COUNT(*) c FROM sales_orders WHERE status='confirmed'${sOrders.sql}`)
      .get(...sOrders.params).c
    const totalAmount = db
      .prepare(
        `SELECT COALESCE(SUM(receivable_amount),0) a, COUNT(*) c FROM sales_orders WHERE status NOT IN ('cancelled','draft') AND order_date >= ${from}${sOrders.sql}`
      )
      .get(...sOrders.params)
    return ok(res, {
      byChannel: byChannel.map((x) => ({ ...x, channel_name: CHANNEL_LABEL[x.channel] || x.channel })),
      trend,
      topProducts,
      topDealers,
      topStores,
      pendingDelivery,
      totalAmount: totalAmount.a,
      totalOrders: totalAmount.c
    })
  })
)

export default r
