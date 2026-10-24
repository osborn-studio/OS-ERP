/**
 * ============================================================================
 * 文件标识：server/lib/crud.js ｜ 通用增删改查骨架：字段白名单、分页、排序、软删除的**唯一实现**（各路由不要各写一套）
 * ============================================================================
 * 【职责】通用增删改查骨架：字段白名单、分页、排序、软删除的**唯一实现**（各路由不要各写一套）
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
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged } from './http.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'

const PROTECTED = new Set(['id', 'created_at', 'updated_at'])

export function tableColumns(table) {
  const db = getDb()
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
}

function pickFields(table, body, protectedFields = []) {
  const cols = tableColumns(table)
  const out = {}
  for (const [k, v] of Object.entries(body || {})) {
    if (!cols.includes(k) || PROTECTED.has(k) || protectedFields.includes(k)) continue
    out[k] = v === '' ? null : v
  }
  return out
}

/**
 * 通用主数据 CRUD
 * @param {object} opt table/module/searchFields/orderBy/selectSql/joinSql/writeRoles
 */
export function crudRouter(opt) {
  const {
    table,
    module,
    searchFields = [],
    orderBy = 'id DESC',
    writeRoles = [],
    selectSql = null,
    fromSql = null,
    extraWhere = '',
    nameField = 'name',
    // 通用接口永远不可写、不可作过滤条件的列（例如封存的凭据；读取侧另用 selectSql 排除）
    protectedFields = []
  } = opt
  const r = Router()
  const base = fromSql || table
  const alias = / AS /i.test(base) ? '' : `${base}.`

  r.get(
    '/',
    requireAuth,
    wrap((req, res) => {
      const db = getDb()
      const { page, pageSize, offset } = pageParams(req)
      const params = []
      const conds = []
      if (extraWhere) conds.push(extraWhere)
      const kw = req.query.keyword ? `%${req.query.keyword}%` : null
      if (kw && searchFields.length) {
        conds.push(`(${searchFields.map((f) => `${f} LIKE ?`).join(' OR ')})`)
        searchFields.forEach(() => params.push(kw))
      }
      for (const [k, v] of Object.entries(req.query)) {
        if (['page', 'pageSize', 'keyword', 'all'].includes(k)) continue
        if (v === '' || v == null) continue
        if (tableColumns(table).includes(k) && !protectedFields.includes(k)) {
          conds.push(`${alias}${k} = ?`)
          params.push(v)
        }
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      const sql = selectSql || `${table}.*`
      const total = db.prepare(`SELECT COUNT(*) c FROM ${base} ${where}`).get(...params).c
      const limitSql = req.query.all === '1' ? '' : 'LIMIT ? OFFSET ?'
      const rows = db
        .prepare(`SELECT ${sql} FROM ${base} ${where} ORDER BY ${orderBy} ${limitSql}`)
        .all(...params, ...(req.query.all === '1' ? [] : [pageSize, offset]))
      if (req.query.all === '1') return ok(res, rows)
      return paged(res, { rows, total, page, pageSize })
    })
  )

  r.get(
    '/:id',
    requireAuth,
    wrap((req, res) => {
      const db = getDb()
      const sql = selectSql || `${table}.*`
      const row = db.prepare(`SELECT ${sql} FROM ${base} WHERE ${alias}id = ?`).get(Number(req.params.id))
      if (!row) return fail(res, '记录不存在', 404)
      return ok(res, row)
    })
  )

  r.post(
    '/',
    requireAuth,
    requireRole(...writeRoles),
    wrap((req, res) => {
      const db = getDb()
      const data = pickFields(table, req.body, protectedFields)
      if (!Object.keys(data).length) return fail(res, '没有可写入的字段')
      for (const key of searchFields) {
        if (data[key] && key.endsWith('code')) {
          const dup = db.prepare(`SELECT id FROM ${table} WHERE ${key} = ?`).get(data[key])
          if (dup) return fail(res, `${key} 已存在：${data[key]}`)
        }
      }
      const keys = Object.keys(data)
      const info = db
        .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
        .run(...keys.map((k) => data[k]))
      audit(req, { action: 'CREATE', module, entity: table, entityId: info.lastInsertRowid, detail: data[nameField] })
      return ok(res, { id: info.lastInsertRowid, ...data })
    })
  )

  r.put(
    '/:id',
    requireAuth,
    requireRole(...writeRoles),
    wrap((req, res) => {
      const db = getDb()
      const id = Number(req.params.id)
      const exist = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
      if (!exist) return fail(res, '记录不存在', 404)
      const data = pickFields(table, req.body, protectedFields)
      const keys = Object.keys(data)
      if (!keys.length) return fail(res, '没有可更新的字段')
      db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(
        ...keys.map((k) => data[k]),
        id
      )
      audit(req, { action: 'UPDATE', module, entity: table, entityId: id, detail: data[nameField] || exist[nameField] })
      return ok(res, { id })
    })
  )

  r.delete(
    '/:id',
    requireAuth,
    requireRole(...writeRoles),
    wrap((req, res) => {
      const db = getDb()
      const id = Number(req.params.id)
      const exist = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
      if (!exist) return fail(res, '记录不存在', 404)
      try {
        db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id)
      } catch (e) {
        return fail(res, '该记录已被业务单据引用，不能删除，可改为停用', 400, 'REFERENCED')
      }
      audit(req, { action: 'DELETE', module, entity: table, entityId: id, detail: exist[nameField] })
      return ok(res, { id })
    })
  )

  return r
}

export default crudRouter
