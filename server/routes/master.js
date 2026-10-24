/**
 * ============================================================================
 * 文件标识：server/routes/master.js ｜ 主数据路由：商品与 SKU、组合装、品牌与品类、供应商、仓库与门店、条码/序列号
 * ============================================================================
 * 【职责】主数据路由：商品与 SKU、组合装、品牌与品类、供应商、仓库与门店、条码/序列号
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
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged } from '../lib/http.js'
import { requireAuth, requireRole, requireInternal, attachOrgScope } from '../middleware/auth.js'
import { stockScopeSql, assertWarehouseInScope } from '../lib/stock.js'
import { audit } from '../middleware/audit.js'
import { crudRouter } from '../lib/crud.js'
import invTxnTypesRoutes from './inv-txn-types.js'
import warehouseRoutes from './warehouses.js'
// 「哪些仓库类型是隔离仓」的唯一出处（下拉候选要排除它们；见 /options 的注释）
import { ISOLATION_WAREHOUSE_TYPES } from '../lib/warehouse.js'
import { PLATFORM_PUBLIC_SELECT, PLATFORM_PROTECTED_FIELDS } from '../lib/qimen-auth.js'

const r = Router()
r.use(requireAuth, requireInternal('总部主数据；门店与经销商请使用各自业务目录'))
const ADMIN = ['admin']
const BIZ = ['admin', 'purchase', 'sales', 'warehouse']

// ---------- 商品主数据（含 SKU 子表）----------
const PRODUCT_SELECT = `
  p.*, b.name AS brand_name, c.name AS category_name,
  (SELECT COUNT(*) FROM product_skus s WHERE s.product_id = p.id) AS sku_count,
  (SELECT COALESCE(SUM(st.qty_on_hand),0) FROM inventory_stocks st JOIN product_skus s2 ON s2.id=st.sku_id WHERE s2.product_id=p.id) AS stock_qty
`
const PRODUCT_FROM = 'products p LEFT JOIN brands b ON b.id=p.brand_id LEFT JOIN categories c ON c.id=p.category_id'

r.get(
  '/products',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    if (req.query.keyword) {
      conds.push('(p.name LIKE ? OR p.spu_code LIKE ? OR b.name LIKE ?)')
      const kw = `%${req.query.keyword}%`
      params.push(kw, kw, kw)
    }
    if (req.query.brand_id) {
      conds.push('p.brand_id = ?')
      params.push(Number(req.query.brand_id))
    }
    if (req.query.category_id) {
      conds.push('p.category_id = ?')
      params.push(Number(req.query.category_id))
    }
    if (req.query.status) {
      conds.push('p.status = ?')
      params.push(req.query.status)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM ${PRODUCT_FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(`SELECT ${PRODUCT_SELECT} FROM ${PRODUCT_FROM} ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/products/:id',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const p = db.prepare(`SELECT ${PRODUCT_SELECT} FROM ${PRODUCT_FROM} WHERE p.id=?`).get(Number(req.params.id))
    if (!p) return fail(res, '商品不存在', 404)
    p.skus = db.prepare('SELECT * FROM product_skus WHERE product_id=? ORDER BY id').all(p.id)
    return ok(res, p)
  })
)

r.post(
  '/products',
  requireAuth,
  requireRole(...BIZ),
  wrap((req, res) => {
    const db = getDb()
    const {
      spu_code, name, brand_id, category_id, series, spec, unit, barcode, shelf_life_months,
      batch_managed, tax_rate, price_retail, price_dealer, price_member, cost_std, safe_stock, remark, image_emoji,
      require_qc, skus = []
    } = req.body || {}
    if (!name) return fail(res, '商品名称必填')
    const code = spu_code || `SPU${Date.now().toString().slice(-8)}`
    if (db.prepare('SELECT id FROM products WHERE spu_code=?').get(code)) return fail(res, '商品编码已存在')
    const tx = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO products (spu_code,name,brand_id,category_id,series,spec,unit,barcode,shelf_life_months,batch_managed,tax_rate,
            price_retail,price_dealer,price_member,cost_std,safe_stock,remark,image_emoji,require_qc)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          code, name, brand_id || null, category_id || null, series || null, spec || null, unit || '瓶', barcode || null,
          Number(shelf_life_months ?? 36), Number(batch_managed ?? 1), Number(tax_rate ?? 13),
          Number(price_retail || 0), Number(price_dealer || 0), Number(price_member || 0), Number(cost_std || 0),
          Number(safe_stock || 0), remark || null, image_emoji || null,
          // 「启用质检」开关：只认 0/1；省略即 0（不启用 = 沿用旧行为）
          Number(require_qc) === 1 ? 1 : 0
        )
      const pid = info.lastInsertRowid
      const insSku = db.prepare(
        `INSERT INTO product_skus (product_id,sku_code,name,color_no,spec,barcode,price_retail,price_dealer,price_member,cost_std,safe_stock)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      const list = skus.length ? skus : [{ name, sku_code: `${code}-01` }]
      for (const s of list) {
        insSku.run(
          pid, s.sku_code || `${code}-${String(list.indexOf(s) + 1).padStart(2, '0')}`, s.name || name,
          s.color_no || null, s.spec || spec || null, s.barcode || null,
          Number(s.price_retail ?? price_retail ?? 0), Number(s.price_dealer ?? price_dealer ?? 0),
          Number(s.price_member ?? price_member ?? 0), Number(s.cost_std ?? cost_std ?? 0), Number(s.safe_stock ?? safe_stock ?? 0)
        )
      }
      return pid
    })
    const pid = tx()
    audit(req, { action: 'CREATE', module: 'master', entity: 'products', entityId: pid, detail: name })
    return ok(res, db.prepare(`SELECT ${PRODUCT_SELECT} FROM ${PRODUCT_FROM} WHERE p.id=?`).get(pid))
  })
)

r.put(
  '/products/:id',
  requireAuth,
  requireRole(...BIZ),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const exist = db.prepare('SELECT * FROM products WHERE id=?').get(id)
    if (!exist) return fail(res, '商品不存在', 404)
    const f = ['name','brand_id','category_id','series','spec','unit','barcode','shelf_life_months','batch_managed','tax_rate','price_retail','price_dealer','price_member','cost_std','safe_stock','status','remark','image_emoji','require_qc']
    const sets = []
    const vals = []
    for (const k of f) {
      if (req.body[k] !== undefined) {
        sets.push(`${k}=?`)
        // `require_qc` 是 NOT NULL 的开关列：只认 0/1，空值落 0（不启用），
        // 不允许把 null 写进去 —— 那会在 SQL 层直接报约束错，而报错原因与用户的操作对不上
        vals.push(k === 'require_qc' ? (Number(req.body[k]) === 1 ? 1 : 0) : req.body[k] === '' ? null : req.body[k])
      }
    }
    if (sets.length) db.prepare(`UPDATE products SET ${sets.join(',')} WHERE id=?`).run(...vals, id)
    audit(req, { action: 'UPDATE', module: 'master', entity: 'products', entityId: id })
    return ok(res, db.prepare(`SELECT ${PRODUCT_SELECT} FROM ${PRODUCT_FROM} WHERE p.id=?`).get(id))
  })
)

r.delete(
  '/products/:id',
  requireAuth,
  requireRole(...ADMIN, 'purchase', 'sales'),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const used = db.prepare('SELECT COUNT(*) c FROM sales_order_items i JOIN product_skus s ON s.id=i.sku_id WHERE s.product_id=?').get(id).c
    if (used) return fail(res, '该商品已被业务单据引用，不能删除，请改为停用', 400, 'REFERENCED')
    db.prepare('DELETE FROM product_skus WHERE product_id=?').run(id)
    db.prepare('DELETE FROM products WHERE id=?').run(id)
    audit(req, { action: 'DELETE', module: 'master', entity: 'products', entityId: id })
    return ok(res, { id })
  })
)

// ---------- SKU ----------
r.get(
  '/skus',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const conds = []
    const params = []
    if (req.query.product_id) {
      conds.push('s.product_id = ?')
      params.push(Number(req.query.product_id))
    }
    if (req.query.keyword) {
      conds.push('(s.sku_code LIKE ? OR s.name LIKE ? OR p.name LIKE ? OR s.barcode LIKE ?)')
      const kw = `%${req.query.keyword}%`
      params.push(kw, kw, kw, kw)
    }
    if (req.query.status) {
      conds.push('s.status = ?')
      params.push(req.query.status)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = `product_skus s JOIN products p ON p.id=s.product_id LEFT JOIN brands b ON b.id=p.brand_id`
    // limit 仅接受有限正整数（防止 NaN / 负数拼接进 SQL）
    const rawLimit = parseInt(req.query.limit, 10)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? `LIMIT ${Math.min(rawLimit, 1000)}` : ''
    const rows = db
      .prepare(
        `SELECT s.*, p.name AS product_name, p.spu_code, p.unit, p.spec AS product_spec, b.name AS brand_name,
                COALESCE((SELECT SUM(st.qty_on_hand) FROM inventory_stocks st WHERE st.sku_id=s.id),0) AS stock_qty
         FROM ${FROM} ${where} ORDER BY s.id DESC ${limit}`
      )
      .all(...params)
    return ok(res, rows)
  })
)

r.post(
  '/skus',
  requireAuth,
  requireRole(...BIZ),
  wrap((req, res) => {
    const db = getDb()
    const { product_id, sku_code, name, color_no, spec, barcode, price_retail, price_dealer, price_member, cost_std, safe_stock } = req.body || {}
    if (!product_id || !name) return fail(res, '所属商品与 SKU 名称为必填')
    const code = sku_code || `SKU${Date.now().toString().slice(-8)}`
    if (db.prepare('SELECT id FROM product_skus WHERE sku_code=?').get(code)) return fail(res, 'SKU 编码已存在')
    const info = db
      .prepare(
        `INSERT INTO product_skus (product_id,sku_code,name,color_no,spec,barcode,price_retail,price_dealer,price_member,cost_std,safe_stock)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(product_id, code, name, color_no || null, spec || null, barcode || null, Number(price_retail || 0), Number(price_dealer || 0), Number(price_member || 0), Number(cost_std || 0), Number(safe_stock || 0))
    audit(req, { action: 'CREATE', module: 'master', entity: 'product_skus', entityId: info.lastInsertRowid })
    return ok(res, { id: info.lastInsertRowid, sku_code: code })
  })
)

r.put(
  '/skus/:id',
  requireAuth,
  requireRole(...BIZ),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const exist = db.prepare('SELECT * FROM product_skus WHERE id=?').get(id)
    if (!exist) return fail(res, 'SKU 不存在', 404)
    const f = ['name','color_no','spec','barcode','price_retail','price_dealer','price_member','cost_std','safe_stock','status']
    const sets = []
    const vals = []
    for (const k of f) {
      if (req.body[k] !== undefined) {
        sets.push(`${k}=?`)
        vals.push(req.body[k] === '' ? null : req.body[k])
      }
    }
    if (sets.length) db.prepare(`UPDATE product_skus SET ${sets.join(',')} WHERE id=?`).run(...vals, id)
    audit(req, { action: 'UPDATE', module: 'master', entity: 'product_skus', entityId: id })
    return ok(res, { id })
  })
)

// ---------- 标准主数据（工厂）----------
r.use('/brands', crudRouter({ table: 'brands', module: 'master', searchFields: ['code', 'name'], writeRoles: BIZ, orderBy: 'id ASC' }))
r.use('/categories', crudRouter({ table: 'categories', module: 'master', searchFields: ['code', 'name'], writeRoles: BIZ, orderBy: 'sort_no ASC, id ASC' }))
// 仓库**不走通用 CRUD**：它多三条业务约束（不许物理删除 / 编码不可改 / 类型必须枚举），
// 详见 `routes/warehouses.js` 头注。品牌 / 品类 / 门店… 仍是通用件（行为不变）。
r.use('/warehouses', warehouseRoutes)
r.use('/stores', crudRouter({ table: 'stores', module: 'master', searchFields: ['code', 'name', 'city'], writeRoles: ['admin', 'sales'], orderBy: 'id ASC' }))
r.use('/suppliers', crudRouter({ table: 'suppliers', module: 'master', searchFields: ['code', 'name', 'contact'], writeRoles: ['admin', 'purchase'], orderBy: 'id ASC' }))
r.use('/dealers', crudRouter({ table: 'dealers', module: 'master', searchFields: ['code', 'name', 'city', 'contact'], writeRoles: ['admin', 'sales'], orderBy: 'id ASC' }))
// 平台的封存密钥列不经通用接口读写（ADR-0033）：读取走显式列清单，写入列入 protectedFields；签发/轮换见 /api/qimen/platforms/:id/secret
r.use('/platforms', crudRouter({ table: 'platforms', module: 'master', searchFields: ['code', 'name', 'shop_name'], writeRoles: ['admin', 'sales'], orderBy: 'id ASC', selectSql: PLATFORM_PUBLIC_SELECT, protectedFields: PLATFORM_PROTECTED_FIELDS }))

// ---------- 扫码识别（条码 / 序列号 / SKU 编码 三合一）----------
r.get(
  '/scan',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const code = String(req.query.code || '').trim()
    if (!code) return fail(res, '请输入条码 / 序列号 / SKU 编码')
    // 1) 序列号
    const sn = db
      .prepare(
        `SELECT sn.*, sk.sku_code, sk.name AS sku_name, sk.spec, p.name AS product_name, w.name AS warehouse_name
         FROM serial_numbers sn JOIN product_skus sk ON sk.id=sn.sku_id JOIN products p ON p.id=sk.product_id
         LEFT JOIN warehouses w ON w.id=sn.warehouse_id WHERE sn.serial_no=?`
      )
      .get(code)
    if (sn) {
      return ok(res, { type: 'serial', data: sn, msg: `序列号命中：${sn.product_name}（${sn.status === 'in_stock' ? '在库' : sn.status === 'shipped' ? '已出库' : sn.status}）` })
    }
    // 2) 条码 / SKU 编码
    const sku = db
      .prepare(
        `SELECT s.*, p.name AS product_name, p.spu_code, p.unit, p.shelf_life_months, b.name AS brand_name,
                COALESCE((SELECT SUM(st.qty_on_hand) FROM inventory_stocks st WHERE st.sku_id=s.id),0) stock_qty,
                COALESCE((SELECT SUM(st.qty_on_hand - st.qty_reserved) FROM inventory_stocks st WHERE st.sku_id=s.id),0) available_qty
         FROM product_skus s JOIN products p ON p.id=s.product_id LEFT JOIN brands b ON b.id=p.brand_id
         WHERE s.barcode=? OR s.sku_code=?`
      )
      .get(code, code)
    if (sku) {
      return ok(res, { type: 'barcode', data: sku, msg: `商品命中：${sku.product_name} ${sku.name}` })
    }
    return fail(res, `未识别的编码：${code}`, 404, 'NOT_FOUND')
  })
)

// ---------- 组合装档案（BOM）----------
r.get(
  '/bundles',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    if (req.query.keyword) {
      conds.push('(b.code LIKE ? OR b.name LIKE ?)')
      const kw = `%${req.query.keyword}%`
      params.push(kw, kw)
    }
    if (req.query.type) {
      conds.push('b.type = ?')
      params.push(req.query.type)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = 'bundles b LEFT JOIN product_skus sk ON sk.id=b.parent_sku_id'
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(
        `SELECT b.*, sk.sku_code AS parent_sku_code, sk.name AS parent_sku_name,
                (SELECT COUNT(*) FROM bundle_components bc WHERE bc.bundle_id=b.id) component_count,
                (SELECT COALESCE(SUM(bc.qty * cs.cost_std),0) FROM bundle_components bc JOIN product_skus cs ON cs.id=bc.component_sku_id WHERE bc.bundle_id=b.id) AS bom_cost,
                (SELECT COALESCE(SUM(st.qty_on_hand),0) FROM inventory_stocks st WHERE st.sku_id=b.parent_sku_id) AS stock_qty
         FROM ${FROM} ${where} ORDER BY b.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/bundles/:id',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const head = db
      .prepare('SELECT b.*, sk.sku_code AS parent_sku_code, sk.name AS parent_sku_name FROM bundles b LEFT JOIN product_skus sk ON sk.id=b.parent_sku_id WHERE b.id=?')
      .get(Number(req.params.id))
    if (!head) return fail(res, '组合装不存在', 404)
    head.components = db
      .prepare(
        `SELECT bc.*, sk.sku_code, sk.name AS sku_name, sk.spec, p.name AS product_name, sk.cost_std, sk.price_retail
         FROM bundle_components bc JOIN product_skus sk ON sk.id=bc.component_sku_id JOIN products p ON p.id=sk.product_id
         WHERE bc.bundle_id=? ORDER BY bc.id`
      )
      .all(head.id)
    head.assemblies = db
      .prepare(
        `SELECT a.* FROM assembly_orders a WHERE a.bundle_id=? ORDER BY a.id DESC LIMIT 10`
      )
      .all(head.id)
    return ok(res, head)
  })
)

r.post(
  '/bundles',
  requireAuth,
  requireRole(...BIZ),
  wrap((req, res) => {
    const db = getDb()
    const { code, name, type = 'giftbox', parent_sku_id, price_retail, price_dealer, cost_std, barcode, remark, components = [] } = req.body || {}
    if (!name) return fail(res, '组合装名称必填')
    if (!components.length) return fail(res, '请至少配置一个组件')
    const bdCode = code || `BND${Date.now().toString().slice(-6)}`
    if (db.prepare('SELECT id FROM bundles WHERE code=?').get(bdCode)) return fail(res, '组合装编码已存在')
    const bomCost = components.reduce((s, c) => s + Number(c.qty || 0) * Number(c.cost_std || 0), 0)
    const run = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO bundles (code,name,type,parent_sku_id,price_retail,price_dealer,cost_std,barcode,remark)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(bdCode, name, type, parent_sku_id || null, Number(price_retail || 0), Number(price_dealer || 0), Number(cost_std || Number(bomCost.toFixed(2))), barcode || null, remark || null)
      const bid = info.lastInsertRowid
      const ins = db.prepare('INSERT INTO bundle_components (bundle_id,component_sku_id,qty,remark) VALUES (?,?,?,?)')
      for (const c of components) {
        if (!c.component_sku_id || !(Number(c.qty) > 0)) continue
        ins.run(bid, c.component_sku_id, Number(c.qty), c.remark || null)
      }
      return bid
    })
    const bid = run()
    audit(req, { action: 'CREATE', module: 'master', entity: 'bundles', entityId: bid, detail: name })
    return ok(res, { id: bid, code: bdCode })
  })
)

r.put(
  '/bundles/:id',
  requireAuth,
  requireRole(...BIZ),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const exist = db.prepare('SELECT * FROM bundles WHERE id=?').get(id)
    if (!exist) return fail(res, '组合装不存在', 404)
    const { name, type, parent_sku_id, price_retail, price_dealer, barcode, status, remark, components } = req.body || {}
    const run = db.transaction(() => {
      db.prepare(
        `UPDATE bundles SET name=COALESCE(?,name), type=COALESCE(?,type), parent_sku_id=COALESCE(?,parent_sku_id),
          price_retail=COALESCE(?,price_retail), price_dealer=COALESCE(?,price_dealer), barcode=COALESCE(?,barcode),
          status=COALESCE(?,status), remark=COALESCE(?,remark) WHERE id=?`
      ).run(name ?? null, type ?? null, parent_sku_id ?? null, price_retail ?? null, price_dealer ?? null, barcode ?? null, status ?? null, remark ?? null, id)
      if (Array.isArray(components)) {
        db.prepare('DELETE FROM bundle_components WHERE bundle_id=?').run(id)
        const ins = db.prepare('INSERT INTO bundle_components (bundle_id,component_sku_id,qty,remark) VALUES (?,?,?,?)')
        for (const c of components) {
          if (!c.component_sku_id || !(Number(c.qty) > 0)) continue
          ins.run(id, c.component_sku_id, Number(c.qty), c.remark || null)
        }
      }
    })
    run()
    audit(req, { action: 'UPDATE', module: 'master', entity: 'bundles', entityId: id })
    return ok(res, { id })
  })
)

// ---------- 货位管理 ----------
r.get(
  '/locations',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    // ADR-0038 补充：货位挂在仓库下，随仓库的组织范围裁剪（used_rows 也是该仓库存的汇总）
    const scope = stockScopeSql(req.orgScope, 'loc')
    const conds = [scope.sql]
    const params = [...scope.params]
    if (req.query.warehouse_id) {
      conds.push('loc.warehouse_id = ?')
      params.push(Number(req.query.warehouse_id))
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const rows = db
      .prepare(
        `SELECT loc.*, w.name AS warehouse_name, w.code AS warehouse_code,
                (SELECT COUNT(*) FROM inventory_stocks st WHERE st.warehouse_id=loc.warehouse_id AND st.location=loc.code AND st.qty_on_hand>0) AS used_rows
         FROM warehouse_locations loc JOIN warehouses w ON w.id=loc.warehouse_id ${where} ORDER BY w.id, loc.code`
      )
      .all(...params)
    return ok(res, rows)
  })
)

r.post(
  '/locations',
  requireAuth,
  requireRole('admin', 'warehouse'),
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const { warehouse_id, code, name, type = 'storage', max_capacity, remark } = req.body || {}
    if (!warehouse_id || !code) return fail(res, '仓库与货位编码必填')
    assertWarehouseInScope(db, warehouse_id, req.orgScope)
    if (db.prepare('SELECT id FROM warehouse_locations WHERE warehouse_id=? AND code=?').get(warehouse_id, code)) {
      return fail(res, '该仓库下货位编码已存在')
    }
    const info = db
      .prepare('INSERT INTO warehouse_locations (warehouse_id,code,name,type,max_capacity,remark) VALUES (?,?,?,?,?,?)')
      .run(warehouse_id, code, name || code, type, Number(max_capacity || 0), remark || null)
    audit(req, { action: 'CREATE', module: 'master', entity: 'warehouse_locations', entityId: info.lastInsertRowid })
    return ok(res, { id: info.lastInsertRowid })
  })
)

// ---------- 下拉选项聚合 ----------
r.get(
  '/options',
  requireAuth,
  wrap((_req, res) => {
    const db = getDb()
    const q = (sql, args = []) => db.prepare(sql).all(...args)
    return ok(res, {
      brands: q('SELECT id AS value, name AS label, code FROM brands WHERE status=\'active\' ORDER BY id'),
      categories: q('SELECT id AS value, name AS label, code, parent_id FROM categories WHERE status=\'active\' ORDER BY sort_no, id'),
      // 仓库候选：**排除隔离仓类型**（不合格品仓 / 待检品仓）。
      // 隔离仓不是经营仓 —— 货只能由质检处置的调拨单调进去；一旦它出现在"选发货仓 /
      // 选货源仓"的下拉里，一张销售单就能直接从不合格品仓发货，**而且没有任何地方会报错**。
      // "哪些类型是隔离仓"的唯一出处是 `lib/warehouse.js` 的 `ISOLATION_WAREHOUSE_TYPES`
      // （不从 SQL 里写死类型名 —— 客户能自建类型，写死会漏）。
      // ⚠️ 只影响**候选下拉**；仓库维护页走 `GET /warehouses`，隔离仓照常可见、可改名、可停用。
      warehouses: q(
        `SELECT id AS value, name AS label, code, type FROM warehouses
          WHERE status='active' AND type NOT IN (${ISOLATION_WAREHOUSE_TYPES.map(() => '?').join(',')})
          ORDER BY id`,
        ISOLATION_WAREHOUSE_TYPES
      ),
      // **全部启用仓（含隔离仓）** —— 给"查询筛选"类下拉用（如库存查询的"全部仓库"）。
      //
      // 为什么必须与上面那个 `warehouses` 分开：
      //   · `warehouses`     = **候选仓**，要排除隔离仓（不许它被选成发货仓 / 货源仓）；
      //   · `warehouses_all` = **筛选面**，隔离仓里**真的有货**，筛不出来就查不了它的库存。
      // 两者混用一个键的后果实测过：把隔离仓从候选里排掉的同时，它也**从筛选里消失了**。
      // 纯 additive：`warehouses` 的现有行为一个字没改。
      warehouses_all: q("SELECT id AS value, name AS label, code, type FROM warehouses WHERE status='active' ORDER BY id"),
      stores: q("SELECT id AS value, name AS label, code, type, region FROM stores WHERE status='active' ORDER BY id"),
      suppliers: q("SELECT id AS value, name AS label, code FROM suppliers WHERE status='active' ORDER BY id"),
      dealers: q("SELECT id AS value, name AS label, code, level, discount_rate, credit_limit, credit_used FROM dealers WHERE status='active' ORDER BY id"),
      platforms: q("SELECT id AS value, name AS label, code, type FROM platforms WHERE status='active' ORDER BY id"),
      skus: q(
        `SELECT s.id AS value, (s.sku_code || ' · ' || s.name) AS label, s.sku_code, s.name AS sku_name,
                s.price_retail, s.price_dealer, s.price_member, s.cost_std, s.serial_managed, p.name AS product_name, p.unit
         FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.status='active' ORDER BY s.sku_code`
      ),
      bundles: q(
        `SELECT b.id AS value, (b.code || ' · ' || b.name) AS label, b.code, b.name, b.type, b.parent_sku_id
         FROM bundles b WHERE b.status='active' ORDER BY b.id DESC`
      )
    })
  })
)

// ---------- 首页概览数字 ----------
r.get(
  '/overview',
  requireAuth,
  wrap((_req, res) => {
    const db = getDb()
    const c = (sql, ...p) => db.prepare(sql).get(...p).c
    return ok(res, {
      products: c("SELECT COUNT(*) c FROM products WHERE status='active'"),
      skus: c("SELECT COUNT(*) c FROM product_skus WHERE status='active'"),
      dealers: c("SELECT COUNT(*) c FROM dealers WHERE status='active'"),
      stores: c("SELECT COUNT(*) c FROM stores WHERE status='active'"),
      suppliers: c("SELECT COUNT(*) c FROM suppliers WHERE status='active'"),
      warehouses: c("SELECT COUNT(*) c FROM warehouses WHERE status='active'"),
      platforms: c("SELECT COUNT(*) c FROM platforms WHERE status='active'")
    })
  })
)

// ---------- 出入库单据类型（客户可维护，模块 03 × 27）----------
// 客户口径：出入库单据类型由客户自己新建。实现单独一个文件（`routes/inv-txn-types.js`），
// 这里只挂载 —— 那一整套（新增/改名/停用 + 闸门成员 + 核算科目）与商品/仓库主数据的
// 关注点不同，混进本文件会让它继续变长。路径沿用既有习惯：`/api/master/...`。
r.use('/inv-txn-types', invTxnTypesRoutes)

export default r
