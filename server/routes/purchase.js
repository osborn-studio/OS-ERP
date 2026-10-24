/**
 * ============================================================================
 * 文件标识：server/routes/purchase.js ｜ 采购路由：请购 → 订单 → 收货 → 质检 → 发票 → 结算 → 付款 → 退货（九环节都要串得起来）
 * ============================================================================
 * 【职责】采购路由：请购 → 订单 → 收货 → 质检 → 发票 → 结算 → 付款 → 退货（九环节都要串得起来）
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
import { localDate, addDays } from '../lib/dates.js'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged, failFromError } from '../lib/http.js'
import { requireAuth, requireRole, requirePerm, attachOrgScope, currentUser, permContext } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import { withWriteRetry } from '../lib/tx.js'
// 状态推进的**唯一入口**是内核（`applyTransition`）。本文件过去没有直接用过它，
// 因为采购订单那条边有副作用、走的是 `transitionPurchaseOrder`；而下面补的三条边
// （PRT.cancel / PRT.complete / GR.close）都是**零副作用的纯状态推进**，直接走内核即可。
import { advanceStatus } from '../lib/docflow.js'
import { assertWarehouseInScope } from '../lib/stock.js'
import {
  createPurchaseReturn,
  // 采购订单的建单 / 收货 / 状态推进 / 详情重算 / 行级校验 —— 领域服务在 lib/purchase.js，
  // 本文件只做「HTTP 入参 → 领域服务 → 响应」的翻译（D5：入口可以有两个，实现只能有一份）。
  createPurchaseOrder, receivePurchaseOrder, transitionPurchaseOrder, recalcOrder,
  normalizePurchaseOrderLines,
  getPurchaseOrder as loadOrder,
  PURCHASE_ORDER_SELECT, PURCHASE_ORDER_FROM,
  PurchaseError, DocFlowError, PO_READ_PERMS, assertPurchaseDocInScope, purchaseScopeSql
} from '../lib/purchase.js'

const r = Router()
const W = ['purchase', 'warehouse', 'scm', 'admin']
// 采购域的读权限门。
// 为什么读也要有门：采购单是**内部单据**，而 dealer / store 这两个外部主体
// 在权限表里一个采购权限点都没有 —— 但原来的读接口只有 requireAuth，
// 于是经销商账号一个 GET 就把全部 41 张采购单连供应商、单价一起拉走。
// 「有登录态」不等于「有资格」：读接口同样要过功能权限门。
// 权限点清单本身在 `lib/purchase.js`（`PO_READ_PERMS`），采购工作台待办与这里同一份。

/**
 * 业务错误 → 响应（转成 `detail.code`，与采购后段路由 `guard()` 同一形状）。
 * 为什么要这一层：领域服务抛的是 `PurchaseError` / `DocFlowError`，
 * 直接冒到全局中间件会变成 `{code:1, error:'PO_NO_SUPPLIER'}` —— 业务码跑到了顶层 `error` 里，
 * 而不是约定的 `detail.code`。同一个错误在两个采购路由里长得不一样，排查时最费时间。
 */
function guard(fn) {
  return wrap((req, res, next) => {
    try {
      return fn(req, res, next)
    } catch (e) {
      if (e instanceof PurchaseError || e instanceof DocFlowError) {
        // `failFromError` 返回 false = "这不是一个能翻译的业务错误"（它只认 `code && status`）。
        // 这里必须显式 `throw e` 交给全局中间件：**漏了这一步就一个响应都不发、请求挂住** ——
        // 挂住的报障表现是"接口转圈"，跟真实原因（这个错缺 code）完全对不上号。
        // 与另外 13 处 guard 的形状保持一致。
        if (failFromError(res, e)) return
        throw e
      }
      throw e
    }
  })
}

// `PO_SELECT` / `PO_FROM` / `loadOrder` / `recalcOrder` 已下沉到 `lib/purchase.js`
// （收货要重算、MCP 要建单 —— 三处都要用，就不能只有路由这一份）。

// ---------- 采购订单 ----------
r.get(
  '/orders',
  requireAuth,
  requirePerm(...PO_READ_PERMS),
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    // ADR-0046：订单归属经入库仓的组织（与 assertPurchaseDocInScope 同一谓词）；空范围 ⇒ 空列表
    const scope = purchaseScopeSql(req.orgScope, 'po')
    const conds = [scope.wh]
    const params = [...scope.params]
    if (req.query.status) {
      conds.push('po.status = ?')
      params.push(req.query.status)
    }
    if (req.query.supplier_id) {
      conds.push('po.supplier_id = ?')
      params.push(Number(req.query.supplier_id))
    }
    if (req.query.startDate) {
      conds.push('po.order_date >= ?')
      params.push(req.query.startDate)
    }
    if (req.query.endDate) {
      conds.push('po.order_date <= ?')
      params.push(req.query.endDate)
    }
    if (req.query.keyword) {
      conds.push('(po.doc_no LIKE ? OR s.name LIKE ?)')
      params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM ${PURCHASE_ORDER_FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(`SELECT ${PURCHASE_ORDER_SELECT} FROM ${PURCHASE_ORDER_FROM} ${where} ORDER BY po.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/orders/:id',
  requireAuth,
  requirePerm(...PO_READ_PERMS),
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    // ADR-0046：范围外与不存在同形 404（DOC_NOT_FOUND）
    assertPurchaseDocInScope(db, 'PO', Number(req.params.id), req.orgScope)
    const order = loadOrder(db, Number(req.params.id))
    if (!order) return fail(res, '采购订单不存在', 404)
    return ok(res, order)
  })
)

r.post(
  '/orders',
  requireAuth,
  requireRole(...W),
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const {
      supplier_id, warehouse_id, order_date, expect_date, items = [], remark, settle_type,
      fulfill_type = 'hq', target_store_id, target_warehouse_id, source_type = 'manual'
    } = req.body || {}
    // ADR-0038：订单归属取自仓；入库仓与直运目标仓都必须在调用者范围内（403），否则建出的单会越过后续的单据范围闸。
    if (warehouse_id != null) assertWarehouseInScope(db, warehouse_id, req.orgScope)
    if (target_warehouse_id) assertWarehouseInScope(db, target_warehouse_id, req.orgScope)
    // 行级校验、单号、落库、汇总重算全在 `createPurchaseOrder` 里 ——
    // 与 MCP 工具 `purchase.create_order` 是同一段代码。
    const order = withWriteRetry(db, () => createPurchaseOrder(db, {
      supplierId: supplier_id,
      warehouseId: warehouse_id,
      orderDate: order_date,
      expectDate: expect_date,
      items,
      remark,
      settleType: settle_type || null,
      fulfillType: fulfill_type,
      targetStoreId: target_store_id || null,
      targetWarehouseId: target_warehouse_id || null,
      sourceType: source_type,
      actor: { id: u.uid || null, name: u.name || u.username || null }
    }), { label: 'po.create' })
    audit(req, { action: 'CREATE', module: 'purchase', entity: 'purchase_orders', entityId: order.id })
    return ok(res, order)
  })
)

r.put(
  '/orders/:id',
  requireAuth,
  requireRole(...W),
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    // ADR-0038：先判单据范围（404），再判改仓目标（403）；改仓不得把别组织的单挪进自己的范围
    const order = assertPurchaseDocInScope(db, 'PO', id, req.orgScope)
    if (!['draft'].includes(order.status)) return fail(res, '只有草稿状态的订单可以修改')
    const { supplier_id, warehouse_id, order_date, expect_date, remark, items } = req.body || {}
    if (warehouse_id != null) assertWarehouseInScope(db, warehouse_id, req.orgScope)
    // 修改草稿是与建单同形的写入口，校验必须同样严 —— 「只在 create 上拦」等于没拦。
    // 校验器与建单**同一份**（`normalizePurchaseOrderLines`），不再各写一遍。
    const lines = Array.isArray(items) ? normalizePurchaseOrderLines(db, items) : null
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE purchase_orders SET supplier_id=?,warehouse_id=?,order_date=?,expect_date=?,remark=?,updated_at=datetime('now','localtime') WHERE id=?`
      ).run(
        supplier_id ?? order.supplier_id,
        warehouse_id ?? order.warehouse_id,
        order_date ?? order.order_date,
        expect_date ?? order.expect_date,
        remark ?? order.remark,
        id
      )
      if (lines) {
        db.prepare('DELETE FROM purchase_order_items WHERE order_id=?').run(id)
        const insItem = db.prepare(
          'INSERT INTO purchase_order_items (order_id,sku_id,qty,price,tax_rate,amount,remark) VALUES (?,?,?,?,?,?,?)'
        )
        for (const it of lines) {
          insItem.run(id, it.sku_id, it.qty, it.price, it.tax_rate, Number((it.qty * it.price).toFixed(2)), it.remark)
        }
        recalcOrder(db, id)
      }
    })
    tx()
    return ok(res, loadOrder(db, id))
  })
)

r.post(
  '/orders/:id/status',
  requireAuth,
  requireRole(...W),
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    // ADR-0038：先判单据范围（订单经仓归属组织）再谈流转；范围外与不存在同形 404，不产生任何写。
    assertPurchaseDocInScope(db, 'PO', id, req.orgScope)
    // 流转规则已从本文件搬进单据内核（doc_actions 表）：
    // 合法状态与合法动作是数据，不是这里的 if；非法流转由内核统一拦截，
    // 并自动写 doc_events 留痕（谁、何时、从哪到哪）。
    // 执行体是 `transitionPurchaseOrder` —— 与 MCP 工具 `purchase.advance_order` 同一段代码。
    //
    // 两个判据都在 `transitionPurchaseOrder` 里（不在本文件各写一遍）：
    //   ① 「只能走带参数业务入口」的动作（receive/partial）一律拒绝并指路；
    //   ② 边权限 `assertEdgePermitted` —— 与请购单（purchase-chain.js）用的是同一份。
    //      原来这一层完全没有，warehouse 角色能 approve 采购订单，而同一角色在请购单上会 403。
    // 这里只负责把「这个人有哪些权限点」（permContext）递下去。
    const permCtx = permContext(db, req.user)
    const r = withWriteRetry(db, () => transitionPurchaseOrder(db, {
      id,
      action: req.body?.action,
      remark: req.body?.remark,
      actor: { id: req.user.uid, name: req.user.name || req.user.username },
      permCtx,
      source: 'api'
    }), { label: 'po.transition' })
    audit(req, { action: String(r.action || '').toUpperCase(), module: 'purchase', entity: 'purchase_orders', entityId: id })
    return ok(res, r.order)
  })
)

// 收货入库：生成收货单 -> 批次入库 -> 更新订单收货数量与状态
// 实现已下沉到 `lib/purchase.js` 的 `receivePurchaseOrder`（MCP 工具 `purchase.receive_order` 调同一份）
r.post(
  '/orders/:id/receive',
  requireAuth,
  requireRole(...W),
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    // ADR-0038：订单经 warehouse_id 判范围，范围外 404 且不入库。
    const po = assertPurchaseDocInScope(db, 'PO', Number(req.params.id), req.orgScope)
    // 直运订单实际入的是 target_warehouse_id（lib/purchase.js 的 inboundWhId），也必须在范围内
    if (po.fulfill_type === 'direct' && po.target_warehouse_id) assertWarehouseInScope(db, po.target_warehouse_id, req.orgScope)
    const out = withWriteRetry(db, () => receivePurchaseOrder(db, {
      orderId: Number(req.params.id),
      items: req.body?.items || [],
      inspector: req.body?.inspector || null,
      remark: req.body?.remark || null,
      receiptDate: req.body?.receipt_date || null,
      actor: { id: u.uid || null, name: u.name || u.username || null },
      source: 'api'
    }), { label: 'po.receive' })
    audit(req, { action: 'RECEIVE', module: 'purchase', entity: 'purchase_receipts', entityId: out.receipt_id })
    return ok(res, out)
  })
)

// ---------- 收货单 ----------
r.get(
  '/receipts',
  requireAuth,
  requirePerm(...PO_READ_PERMS),
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    // ADR-0038 补充（AA4）：收货单 / 退货单经 warehouse_id → warehouses.org_id 判范围（同 purchaseScopeSql.wh）
    const scope = purchaseScopeSql(req.orgScope, 'pr')
    const conds = [scope.wh]
    const params = [...scope.params]
    if (req.query.keyword) {
      conds.push('(pr.doc_no LIKE ? OR s.name LIKE ?)')
      params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = 'purchase_receipts pr LEFT JOIN suppliers s ON s.id=pr.supplier_id LEFT JOIN warehouses w ON w.id=pr.warehouse_id LEFT JOIN purchase_orders po ON po.id=pr.order_id'
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(
        `SELECT pr.*, s.name AS supplier_name, w.name AS warehouse_name, po.doc_no AS order_no,
                (SELECT COUNT(*) FROM purchase_receipt_items i WHERE i.receipt_id=pr.id) AS item_count
         FROM ${FROM} ${where} ORDER BY pr.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/receipts/:id',
  requireAuth,
  requirePerm(...PO_READ_PERMS),
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    assertPurchaseDocInScope(db, 'GR', Number(req.params.id), req.orgScope)
    const head = db
      .prepare(
        `SELECT pr.*, s.name AS supplier_name, w.name AS warehouse_name, po.doc_no AS order_no
         FROM purchase_receipts pr LEFT JOIN suppliers s ON s.id=pr.supplier_id
         LEFT JOIN warehouses w ON w.id=pr.warehouse_id LEFT JOIN purchase_orders po ON po.id=pr.order_id
         WHERE pr.id=?`
      )
      .get(Number(req.params.id))
    if (!head) return fail(res, '收货单不存在', 404)
    head.items = db
      .prepare(
        `SELECT i.*, sk.sku_code, sk.name AS sku_name, p.name AS product_name FROM purchase_receipt_items i
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id WHERE i.receipt_id=? ORDER BY i.id`
      )
      .all(head.id)
    return ok(res, head)
  })
)

// 关闭到货单（inspected → closed）＝**归档**：零副作用，只推进状态并留痕。
// 这一步长期没有门（`GR.close` 登记在内核里，后端从来没有路由）：
// 到货单一旦被质检推成 `inspected` 就再也关不掉，只能永远挂在「已质检」。
// 注意 `GR.inspect`（received → inspected）**不在这里** —— 那个门已经有了，
// 由 `lib/qc.js` 在提交质检结论时自动推进，本轮只补 `close`。
r.post(
  '/receipts/:id/close',
  requireAuth,
  requireRole(...W),
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    assertPurchaseDocInScope(db, 'GR', id, req.orgScope)
    const head = db.prepare('SELECT id, doc_no FROM purchase_receipts WHERE id=?').get(id)
    if (!head) return fail(res, '收货单不存在', 404)
    const out = advanceStatus(db, req, {
      docType: 'GR',
      id,
      action: 'close',
      remark: `采购到货单 ${head.doc_no} 关闭`
    })
    audit(req, { action: 'CLOSE', module: 'purchase', entity: 'purchase_receipts', entityId: id })
    return ok(res, { id, status: out.to })
  })
)

// ---------- 采购退货 ----------
r.get(
  '/returns',
  requireAuth,
  requirePerm(...PO_READ_PERMS),
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const scope = purchaseScopeSql(req.orgScope, 't')
    const FROM = 'purchase_returns t LEFT JOIN suppliers s ON s.id=t.supplier_id LEFT JOIN warehouses w ON w.id=t.warehouse_id'
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} WHERE ${scope.wh}`).get(...scope.params).c
    const rows = db
      .prepare(
        `SELECT t.*, s.name AS supplier_name, w.name AS warehouse_name FROM ${FROM} WHERE ${scope.wh} ORDER BY t.id DESC LIMIT ? OFFSET ?`
      )
      .all(...scope.params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.post(
  '/returns',
  requireAuth,
  requireRole(...W),
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const u = currentUser(req)
    const { supplier_id, warehouse_id, return_date, reason, items = [] } = req.body || {}
    if (!supplier_id || !warehouse_id) return fail(res, '请选择供应商与退货仓库')
    if (!items.length) return fail(res, '请添加退货明细')
    // ADR-0038 补充：退货出库的仓必须在范围内（不存在的仓对受限范围同为 403），先于任何库存写入
    assertWarehouseInScope(db, warehouse_id, req.orgScope)
    // 单据日期兜底，避免未传日期时触发 NOT NULL 约束错误。
    // 建单、出库、走内核三件事都在 lib/purchase.js 的 createPurchaseReturn 里 ——
    // 质检判退要走同一处，否则「退货单怎么生成」迟早有两套实现。
    const rid = createPurchaseReturn(db, {
      supplierId: supplier_id,
      warehouseId: warehouse_id,
      returnDate: String(return_date || '').trim() || null,
      reason: reason || null,
      items,
      actor: { id: u.uid, name: u.name },
      source: 'api'
    })
    audit(req, { action: 'CREATE', module: 'purchase', entity: 'purchase_returns', entityId: rid })
    return ok(res, { id: rid })
  })
)

// 作废退货单（draft → cancelled）。**零副作用的纯状态推进**。
// 为什么可以零副作用：`cancel` 这条边在内核里只从 `draft` 出发，而单子停在 `draft`
// 就意味着什么都还没发生 —— 出库（`PUR_RET` 流水 / 批次现存的回退）、回退采购订单已收量
// 全都发生在 `createPurchaseReturn` 里，与 `confirm` 同一个事务。draft 态 = 那一段根本没跑。
// 来源态不在这里判：内核 `findAction` 找不到 `cancel` 边时抛 `TRANSITION_NOT_ALLOWED`（409），
// 自己再写一遍白名单就是同一件事的两套判据 —— 两份判据必然分叉。
r.post(
  '/returns/:id/cancel',
  requireAuth,
  requireRole(...W),
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    assertPurchaseDocInScope(db, 'PRT', id, req.orgScope)
    const head = db.prepare('SELECT id, doc_no, status FROM purchase_returns WHERE id=?').get(id)
    if (!head) return fail(res, '采购退货单不存在', 404)
    const out = advanceStatus(db, req, {
      docType: 'PRT',
      id,
      action: 'cancel',
      remark: `采购退货单 ${head.doc_no} 作废`
    })
    audit(req, { action: 'CANCEL', module: 'purchase', entity: 'purchase_returns', entityId: id })
    return ok(res, { id, status: out.to })
  })
)

// 完成退货单（confirmed → completed）＝**结案**：纯状态推进 + 留痕，零副作用。
// 冲销后果（出库、回退已收量、重算到货关闭标记）在 `confirm` 那一步已经发生过；
// 在这里再做一次就是把账冲两遍、把货再退一次。
r.post(
  '/returns/:id/complete',
  requireAuth,
  requireRole(...W),
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    assertPurchaseDocInScope(db, 'PRT', id, req.orgScope)
    const head = db.prepare('SELECT id, doc_no, status FROM purchase_returns WHERE id=?').get(id)
    if (!head) return fail(res, '采购退货单不存在', 404)
    const out = advanceStatus(db, req, {
      docType: 'PRT',
      id,
      action: 'complete',
      remark: `采购退货单 ${head.doc_no} 完成`
    })
    audit(req, { action: 'COMPLETE', module: 'purchase', entity: 'purchase_returns', entityId: id })
    return ok(res, { id, status: out.to })
  })
)

// ---------- 采购统计 ----------
r.get(
  '/stats',
  requireAuth,
  requirePerm(...PO_READ_PERMS),
  wrap((req, res) => {
    const db = getDb()
    const days = Number(req.query.days || 30)
    const byStatus = db.prepare('SELECT status, COUNT(*) cnt, COALESCE(SUM(total_amount),0) amount FROM purchase_orders GROUP BY status').all()
    const trend = db
      .prepare(
        `SELECT order_date AS date, COUNT(*) orders, COALESCE(SUM(total_amount),0) amount
         FROM purchase_orders WHERE order_date >= date('now','localtime', ?) GROUP BY order_date ORDER BY order_date`
      )
      .all(`-${days} day`)
    const topSuppliers = db
      .prepare(
        `SELECT s.name, COUNT(po.id) orders, COALESCE(SUM(po.total_amount),0) amount
         FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id
         WHERE po.order_date >= date('now','localtime', ?)
         GROUP BY s.id ORDER BY amount DESC LIMIT 10`
      )
      .all(`-${days} day`)
    const pending = db
      .prepare("SELECT COUNT(*) c FROM purchase_orders WHERE status IN ('submitted','approved')")
      .get().c
    return ok(res, { byStatus, trend, topSuppliers, pending })
  })
)

// 收货时的批次建议（取最近采购价与效期）
r.get(
  '/orders/:id/receive-suggest',
  requireAuth,
  requirePerm(...PO_READ_PERMS),
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    // ADR-0038 补充：收货建议带出订单行，与订单收货同一道范围判据（范围外 404）
    assertPurchaseDocInScope(db, 'PO', id, req.orgScope)
    const rows = db
      .prepare(
        `SELECT i.id AS item_id, i.sku_id, sk.sku_code, sk.name AS sku_name, p.shelf_life_months,
                i.qty - i.received_qty AS pending_qty, i.price
         FROM purchase_order_items i JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id
         WHERE i.order_id=? AND i.qty - i.received_qty > 0`
      )
      .all(id)
    return ok(
      res,
      rows.map((x) => ({
        ...x,
        expire_date: x.shelf_life_months
          ? addDays(localDate(), x.shelf_life_months * 30)
          : null
      }))
    )
  })
)

export default r
