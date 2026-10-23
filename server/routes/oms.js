/**
 * ============================================================================
 * 文件标识：server/routes/oms.js ｜ 线上 OMS 路由：平台店铺、线上订单、奇门对接、同步日志
 * ============================================================================
 * 【职责】线上 OMS 路由：平台店铺、线上订单、奇门对接、同步日志
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自手写**，
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
import { ok, fail, wrap, pageParams, paged } from '../lib/http.js'
import { requireAuth, requireRole, requireInternal, currentUser, attachOrgScope } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import { nextDocNo } from '../lib/docno.js'
import { advanceStatus, tryTransition, nowText, logEvent } from '../lib/docflow.js'
import { publicPlatform } from '../lib/qimen-auth.js'
import { applyStockOut, pickBatches, releaseStock, reserveStock, reserveForDoc, planShipment, releaseForDoc } from '../lib/stock.js'
import { assertSalesTargetInScope, SalesOrderError, omsPlatformScopeSql, omsOrderScopeSql } from '../lib/sales-order.js'

const r = Router()
r.use(requireAuth, requireInternal('总部线上订单'))
const W = ['sales', 'warehouse', 'admin']

// ---------------------------------------------------------------------------
// 平台绑定组织（ADR-0034）：`platforms` 没有 org 列，平台的「绑定组织」= 其履约仓 `platforms.warehouse_id`
// 所属组织 `warehouses.org_id`。OMS 入口（模拟同步 / 线上单转销售订单）产生的订单一律归这个组织：
//   · 平台没有履约仓、或履约仓没有组织 ⇒ 422 `PLATFORM_ORG_UNBOUND`（不再回落到「任意电商仓 / 第一个仓」）；
//   · 调用者的组织范围必须包含该仓 / 组织 ⇒ 否则同步 403、转单 404（与不存在同形，不泄漏线上单存在）。
// ---------------------------------------------------------------------------
function platformBinding(db, pf) {
  const wh = pf?.warehouse_id ? db.prepare('SELECT id, org_id FROM warehouses WHERE id=?').get(Number(pf.warehouse_id)) : null
  return wh && wh.org_id != null ? { warehouseId: wh.id, orgId: wh.org_id } : null
}
const scopeOf = (req) => req.orgScope || { scope: 'none', orgIds: [] }
/** 返回 null 通过；否则返回 `{ status, code, message }`（调用方自行回复 / 记入失败清单）。 */
function checkPlatformWrite(db, req, pf, { hideAs404 = false } = {}) {
  const bind = platformBinding(db, pf)
  const sc = scopeOf(req)
  if (sc.scope !== 'all') {
    try {
      assertSalesTargetInScope(db, { warehouseId: bind?.warehouseId ?? pf?.warehouse_id ?? null }, sc)
    } catch (e) {
      if (e instanceof SalesOrderError) {
        return hideAs404
          ? { status: 404, code: 'ORDER_NOT_FOUND', message: '线上订单不存在' }
          : { status: 403, code: e.code, message: '该平台的履约仓不在您的组织数据范围内' }
      }
      throw e
    }
  }
  if (!bind) {
    return { status: 422, code: 'PLATFORM_ORG_UNBOUND', message: '该平台未绑定履约仓或履约仓未归属组织，订单无法归属，请先在平台档案维护' }
  }
  return null
}

const OMS_SELECT = `
  o.*, pf.name AS platform_name, pf.code AS platform_code, pf.type AS platform_type, pf.shop_name,
  so.doc_no AS sales_order_no,
  (SELECT COUNT(*) FROM oms_order_items i WHERE i.oms_order_id = o.id) AS item_count
`
const OMS_FROM = `oms_orders o LEFT JOIN platforms pf ON pf.id=o.platform_id LEFT JOIN sales_orders so ON so.id=o.sales_order_id`

const BUYER_NICKS = ['小鹿的日常', 'Cc_0912', '阿岚', '薄荷味的风', 'Vivi酱', '护肤小白', '夜航西飞', '橘子汽水', 'Anna_L', '不吃香菜', 'Momo', '林深见鹿', '甜酷女孩', '七七', '柚子茶']
const CITIES = [
  ['上海市', '浦东新区', '张江高科苑东路 88 弄', '021'],
  ['北京市', '朝阳区', '建国路 甲 6 号 SOHO 现代城', '010'],
  ['广州市', '天河区', '珠江新城华夏路 30 号', '020'],
  ['深圳市', '南山区', '科技园科苑大道 1 号', '0755'],
  ['杭州市', '西湖区', '文三路 90 号东部软件园', '0571'],
  ['成都市', '武侯区', '天府大道中段 500 号', '028'],
  ['南京市', '鼓楼区', '中山北路 105 号', '025'],
  ['武汉市', '洪山区', '光谷大道 77 号', '027'],
  ['西安市', '雁塔区', '高新路 25 号', '029'],
  ['苏州市', '工业园区', '星海街 199 号', '0512']
]
const EXPRESS = ['顺丰速运', '中通快递', '圆通速递', '京东物流', '韵达快递']

function rnd(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}
function rndInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
function maskPhone() {
  const prefix = rnd(['138', '139', '136', '150', '158', '186', '188', '199', '177'])
  return `${prefix}****${String(rndInt(1000, 9999))}`
}
function platformOrderNo(pf, d) {
  const t = d.getTime().toString().slice(-11)
  if (pf.code === 'TMALL') return `TB${t}${rndInt(100, 999)}`
  if (pf.code === 'JD') return `JD${t}${rndInt(100, 999)}`
  if (pf.code === 'DOUYIN') return `DY${t}${rndInt(100, 999)}`
  if (pf.code === 'MEITUAN') return `MT${t}${rndInt(100, 999)}`
  return `${pf.code}${t}${rndInt(100, 999)}`
}

// ---------- 平台列表 ----------
r.get(
  '/platforms',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const ps = omsPlatformScopeSql(scopeOf(req), 'pf')
    const rows = db
      .prepare(
        `SELECT pf.*, w.name AS warehouse_name,
          (SELECT COUNT(*) FROM oms_orders o WHERE o.platform_id=pf.id) AS order_count,
          (SELECT COUNT(*) FROM oms_orders o WHERE o.platform_id=pf.id AND o.status='pending') AS pending_count,
          (SELECT COALESCE(SUM(o.pay_amount),0) FROM oms_orders o WHERE o.platform_id=pf.id AND o.status NOT IN ('refunded','cancelled','closed')) AS gmv,
          (SELECT MAX(created_at) FROM oms_sync_logs l WHERE l.platform_id=pf.id) AS last_log_at
         FROM platforms pf LEFT JOIN warehouses w ON w.id=pf.warehouse_id WHERE ${ps.sql} ORDER BY pf.id`
      )
      .all(...ps.params)
    // 封存的奇门密钥不出库：只给 has_secret / secret_rotated_at（ADR-0033）
    return ok(res, rows.map(publicPlatform))
  })
)

// ---------- 模拟同步订单 ----------
r.post(
  '/sync/:platformId',
  requireAuth,
  attachOrgScope,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const platformId = Number(req.params.platformId)
    const pf = db.prepare('SELECT * FROM platforms WHERE id=?').get(platformId)
    if (!pf) return fail(res, '平台不存在', 404)
    const denied = checkPlatformWrite(db, req, pf)
    if (denied) return fail(res, denied.message, denied.status, denied.code)
    const count = Math.min(Math.max(Number(req.body?.count || rndInt(2, 5)), 1), 20)
    const started = Date.now()
    const skus = db
      .prepare(
        `SELECT s.*, p.name AS product_name, p.spec AS product_spec, p.unit FROM product_skus s
         JOIN products p ON p.id=s.product_id WHERE s.status='active'`
      )
      .all()
    if (!skus.length) return fail(res, '没有可用商品，请先维护商品档案')

    const created = []
    const tx = db.transaction(() => {
      const insOrder = db.prepare(
        `INSERT INTO oms_orders (platform_id,platform_order_no,buyer_nick,order_time,pay_time,status,goods_amount,freight,discount_amount,pay_amount,
          receiver,receiver_phone,receiver_address,sync_at,remark)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),?)`
      )
      const insItem = db.prepare(
        'INSERT INTO oms_order_items (oms_order_id,platform_sku_code,sku_id,title,spec,qty,price,amount) VALUES (?,?,?,?,?,?,?,?)'
      )
      for (let i = 0; i < count; i++) {
        const minutesAgo = rndInt(5, 60 * 24 * 7)
        const orderTime = new Date(Date.now() - minutesAgo * 60000)
        const payTime = new Date(orderTime.getTime() + rndInt(10, 900) * 1000)
        const lineCount = rndInt(1, 3)
        const lines = []
        let goods = 0
        for (let j = 0; j < lineCount; j++) {
          const sku = rnd(skus)
          const qty = rndInt(1, 3)
          const price = Number((sku.price_retail * (0.85 + Math.random() * 0.15)).toFixed(2))
          const amount = Number((qty * price).toFixed(2))
          goods += amount
          lines.push({ sku, qty, price, amount })
        }
        const freight = goods >= 199 ? 0 : rnd([0, 8, 10, 12])
        const discount = rnd([0, 0, 5, 10, 20, 30, 50])
        const payAmount = Number(Math.max(goods + freight - discount, 0).toFixed(2))
        const city = rnd(CITIES)
        const status = minutesAgo > 60 * 24 * 2 ? rnd(['completed', 'completed', 'shipped', 'refunded']) : minutesAgo > 60 * 5 ? 'shipped' : 'pending'
        const expressNo = status === 'pending' ? null : `SF${rndInt(100000000000, 999999999999)}`
        const info = insOrder.run(
          platformId,
          platformOrderNo(pf, orderTime),
          rnd(BUYER_NICKS),
          orderTime.toISOString().slice(0, 19).replace('T', ' '),
          payTime.toISOString().slice(0, 19).replace('T', ' '),
          status,
          Number(goods.toFixed(2)),
          freight,
          discount,
          payAmount,
          `${rnd(['王', '李', '张', '刘', '陈', '杨', '赵', '周', '吴', '徐'])}${rnd(['女士', '先生'])}`,
          maskPhone(),
          `${city[0]}${city[1]}${city[2]}`,
          `同步自 ${pf.name}`
        )
        const oid = info.lastInsertRowid
        for (const l of lines) {
          insItem.run(oid, `P${l.sku.sku_code}`, l.sku.id, `${l.sku.product_name} ${l.sku.name}`, l.sku.spec || l.sku.product_spec || '', l.qty, l.price, l.amount)
        }
        created.push({ id: oid, status })
      }
      db.prepare("UPDATE platforms SET last_sync_at=datetime('now','localtime') WHERE id=?").run(platformId)
      db.prepare(
        `INSERT INTO oms_sync_logs (platform_id,sync_type,direction,status,total_count,success_count,fail_count,message,cost_ms)
         VALUES (?,?,'in','success',?,?,0,?,?)`
      ).run(platformId, 'order', count, count, `拉取 ${pf.name} 订单 ${count} 笔`, Date.now() - started)
      return created
    })
    let list
    try {
      list = tx()
    } catch (e) {
      db.prepare(
        `INSERT INTO oms_sync_logs (platform_id,sync_type,direction,status,total_count,success_count,fail_count,message,cost_ms)
         VALUES (?,?,'in','fail',?,0,?,?,?)`
      ).run(platformId, 'order', count, count, e.message, Date.now() - started)
      throw e
    }
    audit(req, { action: 'SYNC', module: 'oms', entity: 'oms_orders', detail: `${pf.name} +${list.length}` })
    return ok(res, { platform: pf.name, created: list.length, orders: list, operator: u.name })
  })
)

// ---------- 线上订单 ----------
r.get(
  '/orders',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    // ADR-0039：先落范围谓词（平台绑定组织），再叠加调用方的过滤参数
    const os = omsOrderScopeSql(scopeOf(req), 'o')
    const conds = [os.sql]
    const params = [...os.params]
    if (req.query.platform_id) {
      conds.push('o.platform_id = ?')
      params.push(Number(req.query.platform_id))
    }
    if (req.query.status) {
      conds.push('o.status = ?')
      params.push(req.query.status)
    }
    if (req.query.startDate) {
      conds.push('o.order_time >= ?')
      params.push(`${req.query.startDate} 00:00:00`)
    }
    if (req.query.endDate) {
      conds.push('o.order_time <= ?')
      params.push(`${req.query.endDate} 23:59:59`)
    }
    if (req.query.keyword) {
      conds.push('(o.platform_order_no LIKE ? OR o.buyer_nick LIKE ? OR o.receiver LIKE ? OR o.express_no LIKE ?)')
      const kw = `%${req.query.keyword}%`
      params.push(kw, kw, kw, kw)
    }
    if (req.query.pending === '1') conds.push("o.status='pending'")
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM ${OMS_FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(`SELECT ${OMS_SELECT} FROM ${OMS_FROM} ${where} ORDER BY o.order_time DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset)
    const sum = db.prepare(`SELECT COALESCE(SUM(o.pay_amount),0) amount, COUNT(*) c FROM ${OMS_FROM} ${where}`).get(...params)
    return paged(res, { rows, total, page, pageSize, summary: { amount: sum.amount, count: sum.c } })
  })
)

r.get(
  '/orders/:id',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const os = omsOrderScopeSql(scopeOf(req), 'o')
    // 范围外与不存在同形（同一句 404），不泄漏线上单存在性
    const o = db.prepare(`SELECT ${OMS_SELECT} FROM ${OMS_FROM} WHERE o.id=? AND ${os.sql}`).get(Number(req.params.id), ...os.params)
    if (!o) return fail(res, '线上订单不存在', 404)
    o.items = db
      .prepare(
        `SELECT i.*, sk.sku_code, sk.name AS sku_name, p.name AS product_name FROM oms_order_items i
         LEFT JOIN product_skus sk ON sk.id=i.sku_id LEFT JOIN products p ON p.id=sk.product_id WHERE i.oms_order_id=?`
      )
      .all(o.id)
    return ok(res, o)
  })
)

// 线上订单转销售订单（进入供应链主流程）
r.post(
  '/orders/:id/convert',
  requireAuth,
  attachOrgScope,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const id = Number(req.params.id)
    const o = db.prepare('SELECT * FROM oms_orders WHERE id=?').get(id)
    if (!o) return fail(res, '线上订单不存在', 404)
    const pf = db.prepare('SELECT * FROM platforms WHERE id=?').get(o.platform_id)
    const denied = checkPlatformWrite(db, req, pf, { hideAs404: true }) // 范围 / 绑定判定早于状态校验，不泄漏存在性
    if (denied) return fail(res, denied.message, denied.status, denied.code)
    if (o.sales_order_id) return fail(res, '该订单已转为销售订单')
    const items = db.prepare('SELECT * FROM oms_order_items WHERE oms_order_id=?').all(id)
    if (!items.length) return fail(res, '订单没有明细')
    const whId = platformBinding(db, pf).warehouseId // 归属平台绑定组织的履约仓（ADR-0034），不回落到任意仓

    const tx = db.transaction(() => {
      const docNo = nextDocNo(db, 'SO', 'sales_orders', 'doc_no')
      const info = db
        .prepare(
          `INSERT INTO sales_orders (doc_no,channel,platform_id,oms_order_no,order_date,status,total_qty,goods_amount,discount_amount,freight,receivable_amount,paid_amount,
            receiver,receiver_phone,receiver_address,salesperson,warehouse_id,remark,created_by)
           VALUES (?,?,?,?,?,'confirmed',0,0,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          docNo, 'platform', o.platform_id, o.platform_order_no, (o.pay_time || o.order_time || '').slice(0, 10),
          o.discount_amount, o.freight, o.pay_amount, o.pay_amount, o.receiver, o.receiver_phone, o.receiver_address,
          u.name || 'OMS', whId, `由线上订单 ${o.platform_order_no} 转入`, u.uid || null
        )
      const soId = info.lastInsertRowid
      const insItem = db.prepare('INSERT INTO sales_order_items (order_id,sku_id,qty,price,discount,amount) VALUES (?,?,?,?,?,?)')
      let qtyAll = 0
      let amtAll = 0
      for (const it of items) {
        if (!it.sku_id) continue
        insItem.run(soId, it.sku_id, it.qty, it.price, 0, it.amount)
        qtyAll += it.qty
        amtAll += it.amount
      }
      let goodsAll = 0
      for (const it of items) goodsAll += it.amount
      db.prepare('UPDATE sales_orders SET total_qty=?, goods_amount=?, receivable_amount=? WHERE id=?').run(
        qtyAll, Number(goodsAll.toFixed(2)), Number((goodsAll - (o.discount_amount || 0) + (o.freight || 0)).toFixed(2)), soId
      )
      // 占库：走唯一入口并**登记来源**（SO#），否则这批预留无从追溯（A05）
      reserveForDoc(db, {
        sourceDocType: 'SO',
        sourceDocId: soId,
        sourceDocNo: docNo,
        warehouseId: whId,
        items: items.filter((it) => it.sku_id).map((it) => ({ skuId: it.sku_id, qty: it.qty }))
      })
      db.prepare('UPDATE oms_orders SET sales_order_id=? WHERE id=?').run(soId, id)
      return soId
    })
    const soId = tx()
    audit(req, { action: 'CONVERT', module: 'oms', entity: 'oms_orders', entityId: id, detail: `SO#${soId}` })
    return ok(res, { sales_order_id: soId })
  })
)

// 批量转单
r.post(
  '/orders/convert-batch',
  requireAuth,
  attachOrgScope,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const ids = (req.body?.ids || []).map(Number)
    if (!ids.length) return fail(res, '请选择要转单的订单')
    const result = { success: [], failed: [] }
    for (const id of ids) {
      try {
        const o = db.prepare('SELECT * FROM oms_orders WHERE id=?').get(id)
        if (!o) throw new Error('订单不存在')
        const pf = db.prepare('SELECT * FROM platforms WHERE id=?').get(o.platform_id)
        const denied = checkPlatformWrite(db, req, pf, { hideAs404: true })
        if (denied) throw new Error(denied.status === 404 ? '订单不存在' : denied.message)
        if (o.sales_order_id) throw new Error('已转单')
        const items = db.prepare('SELECT * FROM oms_order_items WHERE oms_order_id=?').all(id)
        const whId = platformBinding(db, pf).warehouseId // ADR-0034：平台绑定组织的履约仓
        const tx = db.transaction(() => {
          const docNo = nextDocNo(db, 'SO', 'sales_orders', 'doc_no')
          const info = db
            .prepare(
              `INSERT INTO sales_orders (doc_no,channel,platform_id,oms_order_no,order_date,status,total_qty,goods_amount,discount_amount,freight,receivable_amount,paid_amount,
                receiver,receiver_phone,receiver_address,salesperson,warehouse_id,remark)
               VALUES (?,?,?,?,?,'confirmed',0,0,?,?,?,?,?,?,?,?,?,?)`
            )
            .run(
              docNo, 'platform', o.platform_id, o.platform_order_no, (o.pay_time || o.order_time || '').slice(0, 10),
              o.discount_amount, o.freight, o.pay_amount, o.pay_amount, o.receiver, o.receiver_phone, o.receiver_address,
              'OMS批量', whId, `由线上订单 ${o.platform_order_no} 转入`
            )
          const soId = info.lastInsertRowid
          const insItem = db.prepare('INSERT INTO sales_order_items (order_id,sku_id,qty,price,discount,amount) VALUES (?,?,?,?,?,?)')
          let qtyAll = 0
          let goodsAll = 0
          for (const it of items) {
            if (!it.sku_id) continue
            insItem.run(soId, it.sku_id, it.qty, it.price, 0, it.amount)
            qtyAll += it.qty
            goodsAll += it.amount
          }
          db.prepare('UPDATE sales_orders SET total_qty=?, goods_amount=?, receivable_amount=? WHERE id=?').run(
            qtyAll, Number(goodsAll.toFixed(2)), Number((goodsAll - (o.discount_amount || 0) + (o.freight || 0)).toFixed(2)), soId
          )
          reserveForDoc(db, {
            sourceDocType: 'SO',
            sourceDocId: soId,
            sourceDocNo: docNo,
            warehouseId: whId,
            items: items.filter((it) => it.sku_id).map((it) => ({ skuId: it.sku_id, qty: it.qty }))
          })
          db.prepare('UPDATE oms_orders SET sales_order_id=? WHERE id=?').run(soId, id)
          return soId
        })
        result.success.push({ oms_order_id: id, sales_order_id: tx() })
      } catch (e) {
        result.failed.push({ oms_order_id: id, reason: e.message })
      }
    }
    return ok(res, result)
  })
)

// 发货回传
r.post(
  '/orders/:id/ship',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const id = Number(req.params.id)
    const o = db.prepare('SELECT * FROM oms_orders WHERE id=?').get(id)
    if (!o) return fail(res, '线上订单不存在', 404)
    if (o.status !== 'pending') return fail(res, '只有待发货订单可以发货')
    const expressCompany = req.body?.express_company || (o.platform_id ? rnd(EXPRESS) : '顺丰速运')
    const expressNo = req.body?.express_no || `SF${rndInt(100000000000, 999999999999)}`
    const started = Date.now()
    db.transaction(() => {
      // 如有对应销售订单，走正式出库
      if (o.sales_order_id) {
        const so = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(o.sales_order_id)
        const items = db.prepare('SELECT * FROM sales_order_items WHERE order_id=?').all(so.id)
        const docNo = nextDocNo(db, 'SD', 'sales_deliveries', 'doc_no')
        const info = db
          .prepare(
            `INSERT INTO sales_deliveries (doc_no,order_id,warehouse_id,delivery_date,status,total_qty,total_amount,express_company,express_no,remark,created_by)
             VALUES (?,?,?,date('now','localtime'),'shipped',0,0,?,?,?,?)`
          )
          .run(docNo, so.id, so.warehouse_id, expressCompany, expressNo, 'OMS 发货回传', u.uid || null)
        const did = info.lastInsertRowid
        const insItem = db.prepare('INSERT INTO sales_delivery_items (delivery_id,sku_id,batch_no,qty,price,amount) VALUES (?,?,?,?,?,?)')
        let qtyAll = 0
        let amtAll = 0
        for (const it of items) {
          const need = it.qty - it.shipped_qty
          if (need <= 0) continue
          // 发货消费本单预留（不重拣、不抢别人的）—— 与 sales.js 同一份实现（A05）
          const { plan } = planShipment(db, {
            sourceDocType: 'SO', sourceDocId: so.id,
            warehouseId: so.warehouse_id, skuId: it.sku_id, needQty: need
          })
          let shippedQty = 0
          for (const p of plan) {
            applyStockOut(db, {
              bizDate: localDate(), docType: 'SAL_OUT', docNo, docId: did,
              warehouseId: so.warehouse_id, skuId: it.sku_id, batchNo: p.batchNo, qty: p.qty, unitCost: p.unitCost,
              counterparty: so.doc_no, operator: u.name, remark: '平台电商出库'
            })
            insItem.run(did, it.sku_id, p.batchNo, p.qty, it.price, Number((p.qty * it.price).toFixed(2)))
            qtyAll += p.qty
            shippedQty += p.qty
            amtAll += p.qty * it.price
          }
          db.prepare('UPDATE sales_order_items SET shipped_qty=shipped_qty+? WHERE id=?').run(shippedQty, it.id)
        }
        db.prepare('UPDATE sales_deliveries SET total_qty=?, total_amount=? WHERE id=?').run(qtyAll, Number(amtAll.toFixed(2)), did)

        // 建单留痕（与 `routes/sales.js` 的发货建单**同一口径**，见那处的说明）：
        // 这张发货单是 OMS「发货回传」建出来的，建出来就是 `shipped`（同一事务里已出库），
        // 所以记 `create`（不是 `ship` —— 那是 draft→shipped 的边，本单没走过），`from_state` 留空。
        // ⚠️ `source` 仍写 `'api'`：该列的口径是 api / mcp / seed / system（实测三库只有这三种取值），
        //     "这是 OMS 回传建的"写在 remark 与 payload 里，**不新造第五个取值** ——
        //     新造取值会让按 source 过滤的人漏掉这一条（口径比一条记录的分类更重要）。
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
          remark: `发货单建单（OMS 发货回传，平台单 ${o.platform_order_no}）`,
          payload: {
            created_via: 'oms_ship_back',
            oms_order_id: id,
            platform_order_no: o.platform_order_no,
            order_id: so.id,
            order_no: so.doc_no,
            warehouse_id: so.warehouse_id,
            qty: qtyAll,
            amount: Number(amtAll.toFixed(2)),
            express_company: expressCompany,
            express_no: expressNo,
            inventory_doc_type: 'SAL_OUT',
            inventory_doc_no: docNo
          }
        })
        advanceStatus(db, req, { docType: 'SO', id: so.id, action: 'ship', set: { express_company: expressCompany, express_no: expressNo }, remark: `平台发货 ${o.platform_order_no}` })
      }
      advanceStatus(db, req, { docType: 'OM', id, action: 'ship', set: { express_company: expressCompany, express_no: expressNo }, remark: `发货回传 ${expressNo}` })
      db.prepare(
        `INSERT INTO oms_sync_logs (platform_id,sync_type,direction,status,total_count,success_count,fail_count,message,cost_ms)
         VALUES (?,?,'out','success',1,1,0,?,?)`
      ).run(o.platform_id, 'shipment', `发货回传 ${o.platform_order_no} / ${expressNo}`, Date.now() - started)
    })()
    audit(req, { action: 'SHIP', module: 'oms', entity: 'oms_orders', entityId: id })
    return ok(res, { id, express_no: expressNo, express_company: expressCompany })
  })
)

// 订单完成（OM.complete：shipped → completed）
// 平台侧早已完成（买家签收），但系统里**没有任何入口**把状态推过去 ⇒ 三库分别有 88 / 64 / 93 张单
// 永远停在「已发货」（实测）。内核 `ACTIONS.OM` 里 `complete` 这条边（`oms.order.route`，非危险）
// **一直在册**，缺的只是这道门。
// ⚠️ 目标状态是 `completed`，**不是 `closed`** —— 内核 `STATES.OM` 里根本没有 `closed`
//    （历史欠债：`routes/mall.js` 曾用裸 UPDATE 写过它，本批已改走内核 `cancel`）。
// 纯状态推进 + 留痕，不动库存：出库在 `POST /orders/:id/ship` 那一步已经发生过。
r.post(
  '/orders/:id/complete',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const o = db.prepare('SELECT id, platform_order_no, status FROM oms_orders WHERE id=?').get(id)
    if (!o) return fail(res, '线上订单不存在', 404)
    advanceStatus(db, req, {
      docType: 'OM',
      id,
      action: 'complete',
      remark: `订单完成 ${o.platform_order_no || id}`
    })
    audit(req, { action: 'COMPLETE', module: 'oms', entity: 'oms_orders', entityId: id })
    return ok(res, { id, status: 'completed' })
  })
)

// 退款
r.post(
  '/orders/:id/refund',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const o = db.prepare('SELECT * FROM oms_orders WHERE id=?').get(id)
    if (!o) return fail(res, '线上订单不存在', 404)
    const reason = req.body?.reason || '买家申请退款'
    db.transaction(() => {
      if (o.sales_order_id) {
        const so = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(o.sales_order_id)
        if (so.status === 'confirmed') {
          const items = db.prepare('SELECT * FROM sales_order_items WHERE order_id=?').all(so.id)
          for (const it of items) {
            // 按明细释放（不重拣）—— 与 sales.js 同一份实现（A05）
            releaseForDoc(db, {
              sourceDocType: 'SO', sourceDocId: so.id, warehouseId: so.warehouse_id,
              skuId: it.sku_id, needQty: Math.max(it.qty - it.shipped_qty, 0)
            })
          }
        }
        advanceStatus(db, req, { docType: 'SO', id: so.id, action: 'cancel', set: { remark: `线上退款：${reason}` }, remark: '线上退款' })
      }
      advanceStatus(db, req, { docType: 'OM', id, action: 'refund', set: { remark: reason }, remark: reason })
      db.prepare(
        `INSERT INTO oms_sync_logs (platform_id,sync_type,direction,status,total_count,success_count,fail_count,message,cost_ms)
         VALUES (?,?,'in','success',1,1,0,?,?)`
      ).run(o.platform_id, 'refund', `退款 ${o.platform_order_no}：${reason}`, 0)
    })()
    audit(req, { action: 'REFUND', module: 'oms', entity: 'oms_orders', entityId: id })
    return ok(res, { id })
  })
)

// 库存推送
r.post(
  '/stock-push',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const platformId = req.body?.platform_id ? Number(req.body.platform_id) : null
    const started = Date.now()
    const plats = platformId
      ? db.prepare('SELECT * FROM platforms WHERE id=? AND sync_stock=1').all(platformId)
      : db.prepare('SELECT * FROM platforms WHERE sync_stock=1 AND status=\'active\'').all()
    if (!plats.length) return fail(res, '没有开启库存同步的平台')
    const rows = []
    for (const pf of plats) {
      const skuCount = db.prepare("SELECT COUNT(*) c FROM product_skus WHERE status='active'").get().c
      const available = db
        .prepare(
          `SELECT COALESCE(SUM(qty_on_hand - qty_reserved),0) q FROM inventory_stocks st
           JOIN product_skus s ON s.id=st.sku_id WHERE s.status='active'`
        )
        .get().q
      const cost = Date.now() - started
      db.prepare(
        `INSERT INTO oms_sync_logs (platform_id,sync_type,direction,status,total_count,success_count,fail_count,message,payload,cost_ms)
         VALUES (?,?,'out','success',?,?,0,?,?,?)`
      ).run(
        pf.id, 'stock', skuCount, skuCount,
        `推送可售库存至 ${pf.name}（${skuCount} 个 SKU）`,
        JSON.stringify({ sku_count: skuCount, total_available: available }),
        cost
      )
      db.prepare("UPDATE platforms SET last_sync_at=datetime('now','localtime') WHERE id=?").run(pf.id)
      rows.push({ platform: pf.name, sku_count: skuCount, total_available: available })
    }
    audit(req, { action: 'STOCK_PUSH', module: 'oms', detail: `${rows.length} 个平台` })
    return ok(res, { pushed: rows })
  })
)

// 同步日志
r.get(
  '/sync-logs',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const ls = omsPlatformScopeSql(scopeOf(req), 'pf')
    const conds = [ls.sql]
    const params = [...ls.params]
    if (req.query.platform_id) {
      conds.push('l.platform_id = ?')
      params.push(Number(req.query.platform_id))
    }
    if (req.query.sync_type) {
      conds.push('l.sync_type = ?')
      params.push(req.query.sync_type)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = 'oms_sync_logs l LEFT JOIN platforms pf ON pf.id=l.platform_id'  // 日志无平台（pf 为空）⇒ 子查询 NULL，仅全局范围可见
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(`SELECT l.*, pf.name AS platform_name FROM ${FROM} ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

// OMS 分析
r.get(
  '/stats',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const days = Number(req.query.days || 30)
    const ps = omsPlatformScopeSql(scopeOf(req), 'pf')
    const os = omsOrderScopeSql(scopeOf(req), 'o')
    const os0 = omsOrderScopeSql(scopeOf(req), 'oms_orders')
    const from = `date('now','localtime','-${days} day')`
    const byPlatform = db
      .prepare(
        `SELECT pf.name AS platform_name, pf.code, COUNT(o.id) orders,
                COALESCE(SUM(CASE WHEN o.status NOT IN ('refunded','closed') THEN o.pay_amount ELSE 0 END),0) gmv,
                COALESCE(SUM(CASE WHEN o.status='pending' THEN 1 ELSE 0 END),0) pending,
                COALESCE(SUM(CASE WHEN o.status='refunded' THEN o.pay_amount ELSE 0 END),0) refund_amount
         FROM platforms pf LEFT JOIN oms_orders o ON o.platform_id=pf.id AND date(o.order_time) >= ${from}
         WHERE ${ps.sql} GROUP BY pf.id ORDER BY gmv DESC`
      )
      .all(...ps.params)
    const trend = db
      .prepare(
        `SELECT date(order_time) AS date, COUNT(*) orders, COALESCE(SUM(pay_amount),0) amount
         FROM oms_orders WHERE date(order_time) >= ${from} AND ${os0.sql} GROUP BY date(order_time) ORDER BY date`
      )
      .all(...os0.params)
    const total = db
      .prepare(
        `SELECT COUNT(*) orders, COALESCE(SUM(pay_amount),0) gmv,
                COALESCE(AVG(pay_amount),0) avg_amount,
                COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) pending,
                COALESCE(SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END),0) refunded
         FROM oms_orders WHERE date(order_time) >= ${from} AND ${os0.sql}`
      )
      .get(...os0.params)
    const topSkus = db
      .prepare(
        `SELECT i.title, SUM(i.qty) qty, SUM(i.amount) amount FROM oms_order_items i
         JOIN oms_orders o ON o.id=i.oms_order_id WHERE date(o.order_time) >= ${from} AND ${os.sql}
         GROUP BY i.title ORDER BY amount DESC LIMIT 10`
      )
      .all(...os.params)
    return ok(res, { byPlatform, trend, total, topSkus })
  })
)

// ---------- 奇门报文构建（发货单创建 / 库存推送）----------
// 按奇门白皮书字段结构组装 JSON 报文，供演示与联调核对
r.get(
  '/qimen-message/:orderId',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const os = omsOrderScopeSql(scopeOf(req), 'o')
    const o = db
      .prepare(
        `SELECT o.*, pf.name AS platform_name, pf.platform_code, pf.shop_code, w.code AS warehouse_code
         FROM oms_orders o JOIN platforms pf ON pf.id=o.platform_id LEFT JOIN warehouses w ON w.id=pf.warehouse_id
         WHERE o.id=? AND ${os.sql}`
      )
      .get(Number(req.params.orderId), ...os.params)
    if (!o) return fail(res, '线上订单不存在', 404)
    const items = db.prepare('SELECT * FROM oms_order_items WHERE oms_order_id=?').all(o.id)
    const expressCode = o.express_no || `SF${Math.floor(100000000000 + Math.random() * 8e11)}`
    const deliveryOrderCode = `GML-OUT-${o.id}`
    const message = {
      method: 'taobao.qimen.deliveryorder.create',
      app_key: '在平台适配配置中查看',
      timestamp: new Date().toISOString(),
      request: {
        deliveryOrder: {
          deliveryOrderCode,
          preDeliveryOrderCode: deliveryOrderCode,
          orderType: 'JYCK',
          status: 'NEW',
          warehouseCode: o.warehouse_code || 'OTHER',
          orderFlag: '',
          sourcePlatformCode: o.platform_code || 'OTHER',
          shopCode: o.shop_code || o.platform_name,
          orderSourceCode: o.platform_order_no,
          totalOrderLines: items.length,
          logisticsCode: o.express_company ? (o.express_company.includes('顺丰') ? 'SF' : 'ZTO') : '',
          scheduleFinishTime: new Date(Date.now() + 48 * 3600000).toISOString(),
          receiver: {
            name: o.receiver,
            mobile: o.receiver_phone,
            addressDetail: o.receiver_address
          },
          orderLines: items.map((it, idx) => ({
            orderLineNo: idx + 1,
            itemCode: it.sku_id ? `SKU${it.sku_id}` : it.platform_sku_code,
            itemName: it.title,
            planQty: it.qty,
            retailPrice: it.price,
            actualPrice: it.price
          }))
        }
      }
    }
    const confirmMessage = {
      method: 'taobao.qimen.deliveryorder.confirm',
      request: {
        deliveryOrder: {
          deliveryOrderCode,
          logisticsCode: o.express_company ? (o.express_company.includes('顺丰') ? 'SF' : 'ZTO') : 'SF',
          expressCode,
          orderLines: items.map((it, idx) => ({
            orderLineNo: idx + 1,
            itemCode: it.sku_id ? `SKU${it.sku_id}` : it.platform_sku_code,
            actualQty: it.qty,
            batchCode: ''
          }))
        }
      }
    }
    return ok(res, { order: { id: o.id, platform_order_no: o.platform_order_no, status: o.status }, createMessage: message, confirmMessage })
  })
)

// 库存推送报文（可售库存 → 平台）
r.get(
  '/qimen-stock-message/:platformId',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const ps = omsPlatformScopeSql(scopeOf(req), 'pf')
    const pf = db.prepare(`SELECT pf.*, w.code AS warehouse_code FROM platforms pf LEFT JOIN warehouses w ON w.id=pf.warehouse_id WHERE pf.id=? AND ${ps.sql}`).get(Number(req.params.platformId), ...ps.params)
    if (!pf) return fail(res, '平台不存在', 404)
    const stocks = db
      .prepare(
        `SELECT sk.sku_code, SUM(st.qty_on_hand - st.qty_reserved) available FROM inventory_stocks st
         JOIN product_skus sk ON sk.id=st.sku_id WHERE st.warehouse_id=? GROUP BY sk.sku_code HAVING available > 0 LIMIT 50`
      )
      .all(pf.warehouse_id)
    const message = {
      method: 'taobao.qimen.stock.change.report',
      request: {
        warehouseCode: pf.warehouse_code || pf.qimen_wh || 'OTHER',
        shopCode: pf.shop_code,
        items: stocks.map((s) => ({ itemCode: s.sku_code, shopSkuId: `P${s.sku_code}`, changeQty: s.available, orderType: 'AVAILABLE' }))
      }
    }
    return ok(res, { platform: { id: pf.id, name: pf.name, adapter: pf.adapter }, message })
  })
)

export default r
