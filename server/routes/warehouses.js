/**
 * ============================================================================
 * 文件标识：server/routes/warehouses.js ｜ 仓库主数据维护（客户口径：「仓库是可以客户自己新建的」）
 * ============================================================================
 * 【职责】仓库主数据维护（客户口径：「仓库是可以客户自己新建的」）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 仓库主数据维护（客户口径：「仓库是可以客户自己新建的」）
//
// 为什么不是直接用 `lib/crud.js` 的通用 CRUD（它原本就挂在这里）：
//   通用 CRUD 对**任何**主数据都是同一套动作，而仓库比"一张可增删改的名单"多三条**业务约束** ——
//   通用件里加不出来（加进去就等于给品牌 / 品类 / 供应商…都加上同样的约束，那是改别人的行为）：
//
//   ① **不许物理删除**。历史单据按 `warehouse_id` / `code` 引用仓库，
//      删掉它 = 「这批货当时在哪个仓」永久丢答案（报表、追溯、成本复核都会少一块）。
//      所以这里**没有** DELETE 的物理分支：DELETE 一律被拒，只做「停用」。
//      原实现的 `DELETE /api/master/warehouses/:id` 是真删（`crud.js:144`），
//      界面上那个「删除」按钮点下去就没了 —— 这是本次要堵住的那条路。
//   ② **`code` 不可改**。它是历史单据与外部系统（奇门 `warehouseCode`）的引用键，
//      改掉之后老单据的 `code` 会指向一个已经不存在的仓。名称随便改，编码定死。
//   ③ **`type` 取值必须枚举**。取值域在 `lib/warehouse.js`（界面文案同源），
//      不枚举的后果是拼错的类型静默存进去、界面上显示成一个没有名字的灰点。
//
// 与通用 CRUD 保持同一套形状（`ok` / `fail` / `paged` / `audit` / 角色门），
// 所以前端 `DataPage` 不用改一行就能继续用这个页面（它本来就是这么写的）。
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, paged, pageParams } from '../lib/http.js'
import { requireAuth, requireRole, requireGlobalData, attachOrgScope } from '../middleware/auth.js'
import { stockScopeSql, warehouseInScope } from '../lib/stock.js'
import { audit } from '../middleware/audit.js'
import {
  WAREHOUSE_STATUS,
  WarehouseError,
  assertWarehouseType,
  findWarehouse
} from '../lib/warehouse.js'

const r = Router()
const WRITE = ['admin', 'warehouse']
// ADR-0038 补充（AA4）：仓库主数据是库存范围谓词的根（warehouses.org_id）。
//   · 读：受限范围只看见 org_id 在自己范围内的仓（org 为 NULL 的仓对受限范围不可见），范围外与不存在同形 404；
//   · 写（新建 / 修改 / 停用 / 删除拒绝）：仅全局数据范围 —— 受限账号改仓库的 org_id / 状态 / 类型会改写别组织的库存可见性。
const GLOBAL_ONLY = requireGlobalData('仓库主数据维护')

/** 可写字段（`code` 单独处理：新建可填、改不可变）。列名清单只在这里写一份。 */
const EDITABLE = ['name', 'type', 'store_id', 'address', 'manager', 'phone', 'status']

const normText = (v) => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const normStatus = (v) => {
  const s = normText(v)
  if (s === null) return null
  if (!Object.hasOwn(WAREHOUSE_STATUS, s)) {
    throw new WarehouseError(
      'WAREHOUSE_STATUS_INVALID',
      `仓库状态「${s}」不是合法取值（可选：${Object.keys(WAREHOUSE_STATUS).join(' / ')}）`,
      400,
      { received: s }
    )
  }
  return s
}

const normStoreId = (v) => {
  const s = normText(v)
  if (s === null) return null
  if (!/^\d+$/.test(s)) {
    throw new WarehouseError('WAREHOUSE_STORE_ID_INVALID', `所属门店 ID 必须是数字，收到「${s}」`, 400, { received: s })
  }
  return Number(s)
}

/** 仓库编码重复 ⇒ **409 + 人话**（不是 200 加一句"已存在"：那是"操作被拒绝"却报成功码） */
function assertCodeFree(db, code, exceptId = null) {
  const dup = db.prepare('SELECT id, code, name FROM warehouses WHERE code=?').get(code)
  if (dup && dup.id !== exceptId) {
    throw new WarehouseError(
      'WAREHOUSE_CODE_DUPLICATE',
      `仓库编码「${code}」已被仓库「${dup.name}」占用。编码是历史单据的引用键，必须唯一。`,
      409,
      // ⚠️ **不能**用 `code` 当 detail 的键名：`detail.code` 是**保留键**，由 `lib/http.js`
      // 的 `bizFail` 写业务码（`detail = {...err.detail, code}`）—— 用了它，业务码会**静默覆盖**
      // 仓库编码，同一份响应里两个读法会拿到两个不同的东西。判据由 `scripts/check-bizcode-shape.mjs` 守着。
      { warehouse_code: code, conflict_with: { id: dup.id, warehouse_code: dup.code, name: dup.name } }
    )
  }
}

// ---------------------------------------------------------------------------
// 列表 / 详情（与通用 CRUD 同形状：分页 + keyword + 任意列等值过滤 + all=1）
// ---------------------------------------------------------------------------
r.get(
  '/',
  requireAuth,
  attachOrgScope,
  (req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    const kw = req.query.keyword ? `%${req.query.keyword}%` : null
    if (kw) {
      conds.push('(warehouses.code LIKE ? OR warehouses.name LIKE ?)')
      params.push(kw, kw)
    }
    for (const [k, v] of Object.entries(req.query)) {
      if (['page', 'pageSize', 'keyword', 'all'].includes(k)) continue
      if (v === '' || v == null) continue
      if (['id', 'code', 'name', 'type', 'store_id', 'status', 'manager', 'phone'].includes(k)) {
        conds.push(`warehouses.${k} = ?`)
        params.push(v)
      }
    }
    const scope = stockScopeSql(req.orgScope, 'warehouses', 'id')
    conds.push(scope.sql)
    params.push(...scope.params)
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM warehouses ${where}`).get(...params).c
    const limitSql = req.query.all === '1' ? '' : 'LIMIT ? OFFSET ?'
    const rows = db
      .prepare(`SELECT warehouses.* FROM warehouses ${where} ORDER BY warehouses.id ASC ${limitSql}`)
      .all(...params, ...(req.query.all === '1' ? [] : [pageSize, offset]))
    if (req.query.all === '1') return ok(res, rows)
    return paged(res, { rows, total, page, pageSize })
  }
)

r.get(
  '/:id',
  requireAuth,
  attachOrgScope,
  (req, res, next) => {
    try {
      const db = getDb()
      let row = findWarehouse(db, req.params.id)
      if (row && !warehouseInScope(db, row.id, req.orgScope)) row = null
      if (!row) return next(new WarehouseError('WAREHOUSE_NOT_FOUND', `仓库不存在：id=${req.params.id}`, 404))
      return ok(res, row)
    } catch (e) {
      next(e)
    }
  }
)

// ---------------------------------------------------------------------------
// 新建
// ---------------------------------------------------------------------------
r.post(
  '/',
  requireAuth,
  requireRole(...WRITE),
  GLOBAL_ONLY,
  (req, res, next) => {
    try {
      const db = getDb()
      const b = req.body || {}
      const code = normText(b.code)
      const name = normText(b.name)
      if (!code) throw new WarehouseError('WAREHOUSE_CODE_REQUIRED', '仓库编码必填', 400)
      if (!name) throw new WarehouseError('WAREHOUSE_NAME_REQUIRED', '仓库名称必填', 400)
      assertCodeFree(db, code)
      // 类型缺省 central：与界面下拉的默认值一致（那一个是"新建仓库最常见的是总仓"的常识，不是业务规则）
      const type = assertWarehouseType(normText(b.type) ?? 'central')
      const status = normStatus(b.status) ?? 'active'
      const storeId = normStoreId(b.store_id)

      const info = db
        .prepare(
          `INSERT INTO warehouses (code, name, type, store_id, address, manager, phone, status)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(code, name, type, storeId, normText(b.address), normText(b.manager), normText(b.phone), status)
      audit(req, { action: 'CREATE', module: 'master', entity: 'warehouses', entityId: info.lastInsertRowid, detail: `${code} ${name}` })
      return ok(res, { id: info.lastInsertRowid, code, name, type, status })
    } catch (e) {
      next(e)
    }
  }
)

// ---------------------------------------------------------------------------
// 修改（编码不可变；停用即改 status）
// ---------------------------------------------------------------------------
r.put(
  '/:id',
  requireAuth,
  requireRole(...WRITE),
  GLOBAL_ONLY,
  (req, res, next) => {
    try {
      const db = getDb()
      const cur = findWarehouse(db, req.params.id)
      if (!cur) throw new WarehouseError('WAREHOUSE_NOT_FOUND', `仓库不存在：id=${req.params.id}`, 404)
      const b = req.body || {}

      // 编码不可变：**明确报错**，不静默忽略。
      // 静默忽略的后果是用户以为改成功了（界面上也确实显示的是新编码，直到刷新）。
      if (b.code !== undefined && normText(b.code) !== cur.code) {
        throw new WarehouseError(
          'WAREHOUSE_CODE_IMMUTABLE',
          `仓库编码不可修改（现在「${cur.code}」，收到「${normText(b.code)}」）。` +
            '历史单据与外部系统按编码引用仓库，改掉会让老单据指向一个查不到的仓。名称可以改。',
          400,
          { current: cur.code, received: normText(b.code) }
        )
      }

      const sets = []
      const vals = []
      for (const k of EDITABLE) {
        if (b[k] === undefined) continue
        let v
        if (k === 'type') v = assertWarehouseType(normText(b[k]))
        else if (k === 'status') v = normStatus(b[k])
        else if (k === 'store_id') v = normStoreId(b[k])
        else v = normText(b[k])
        if (k === 'name' && !v) throw new WarehouseError('WAREHOUSE_NAME_REQUIRED', '仓库名称必填', 400)
        sets.push(`${k}=?`)
        vals.push(v)
      }
      if (!sets.length) throw new WarehouseError('WAREHOUSE_NO_FIELD', '没有可更新的字段', 400)

      db.prepare(`UPDATE warehouses SET ${sets.join(',')} WHERE id=?`).run(...vals, cur.id)
      audit(req, { action: 'UPDATE', module: 'master', entity: 'warehouses', entityId: cur.id, detail: `${cur.code} ${cur.name}` })
      return ok(res, { id: cur.id })
    } catch (e) {
      next(e)
    }
  }
)

// ---------------------------------------------------------------------------
// 删除：**一律拒绝**（不物理删除）
// ---------------------------------------------------------------------------
// 保留这个方法是**故意**的：不保留的话 `DELETE /api/master/warehouses/:id` 会落到
// 通用 CRUD 的物理删除分支（或者 404 让人以为"接口不存在"），两种都掩盖了真实口径。
// 现在它明确回答"不许删、请停用"。
//
// **状态码 409（Conflict），不是 400**：这条拒绝的性质是"**与既有引用冲突**"
// （历史单据 / 库存流水可能引用着它），而**不是"请求格式不对"**。
// 同一个语义「主数据不许物理删除」在另一条线（`routes/inv-txn-types.js`）也是 409
// （`INV_TYPE_NO_DELETE`）—— 两个**资源**各自的业务码可以不同（那说明的是"哪张表不许删"），
// 但**严重程度**必须一致，否则客户端按状态码分类处理时会把同一个语义分到两堆。
r.delete(
  '/:id',
  requireAuth,
  requireRole(...WRITE),
  GLOBAL_ONLY,
  (req, res, next) => {
    try {
      const db = getDb()
      const cur = findWarehouse(db, req.params.id)
      if (!cur) throw new WarehouseError('WAREHOUSE_NOT_FOUND', `仓库不存在：id=${req.params.id}`, 404)
      const used = db.prepare('SELECT COUNT(*) c FROM inventory_transactions WHERE warehouse_id=?').get(cur.id).c
      throw new WarehouseError(
        'WAREHOUSE_NO_DELETE',
        `仓库不允许删除（「${cur.code} ${cur.name}」已被 ${used} 条库存流水引用）。` +
          '历史单据按仓库记录"这批货当时在哪"，删掉它这个答案就永久没了。' +
          '请把「状态」改为「停用」—— 停用后新建单据不能再选它，历史单据与报表不受影响。',
        409,
        { id: cur.id, warehouse_code: cur.code, name: cur.name, referenced_txns: used }
      )
    } catch (e) {
      next(e)
    }
  }
)

export default r
