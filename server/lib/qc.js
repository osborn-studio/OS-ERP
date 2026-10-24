/**
 * ============================================================================
 * 文件标识：server/lib/qc.js ｜ 采购质检服务层（模块 07 · 到货单与质检单拆分）
 * ============================================================================
 * 【职责】采购质检服务层（模块 07 · 到货单与质检单拆分）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 采购质检服务层（模块 07 · 到货单与质检单拆分）
//
// 一条边界先划清：**到货单记事实，质检单记判断**。
//   到货单（GR）：「送来了什么」—— 数量、批次、效期。这些是称出来的、看得见的，不含立场。
//   质检单（INS）：「收不收、收多少、为什么」—— 合格 / 让步接收 / 判退。这是**人的判断**。
//
// 为什么判断必须独立成单，而不是写到货单的备注里：
//   ① 判断要能被统计 —— 「这个供应商判退率多少」是选供应商的硬指标，写在备注里算不出来；
//   ② 判断要有后果 —— 判退的货得生成退货单、退出正品库存、追责到批次；
//   ③ 判断与事实的**时间会错开** —— 货到是今天下午，质检可能明天才出结论，
//      塞在一张单里就必须给到货单加一个「已质检」状态，让它同时承担两种语义。
//
// 三条口径：
//   ① **三数闭合** qualified + concession + rejected = qty（到货数）。
//      不闭合说明有货既没算合格也没算退货 —— 它凭空消失了，而账上不会报警。
//   ② **判退必须有后果**：提交质检结论时，判退数量自动生成采购退货单并出库。
//      质检不能是一个只改状态的空动作，否则它只是一张纸。
//   ③ **让步接收要留痕**：让步（收下但记录不合格）不影响入库数量，
//      但它是最容易被和「合格」混起来的一项 —— 混起来之后索赔依据就没了。
//
// 一处**已知边界**（写清楚比含糊过去好）：
//   既有链路的到货单在「确认收货」时就把货记进了库存（收货即入库），
//   所以本模块的判退表现为「生成退货单 + 反向出库」，而不是「入库前先扣掉判退量」。
//   两条路都成立，差别只在质检窗口期内**待判货物是否计入可用库存**：
//   收货即入库时，未判定的货已可被销售占用；质检后入库时，它们要等判完才算数。
//   改成后者需要动收货 → 库存的整条链路（销售可用量、拣货、调拨都会受影响），
//   单独作为一步更安全，故本次先保证「单据分开 + 判退有后果」这一层。

import { applyTransition } from './docflow.js'
import { stockScopeSql } from './stock.js'
import { localDate, localNow } from './dates.js'
import {
  PurchaseError, createPurchaseReturn, refreshOrderStats, refreshCloseFlags
} from './purchase.js'

const nowStr = () => localNow()
// 业务日一律本地口径（dates.js）：`toISOString()` 是 UTC，
// 东八区 00:00–08:00 之间会把今天报检的单据记成昨天。
const ymd = (d = new Date()) => localDate(d)
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const num = (v) => Number(v) || 0

export class QCError extends Error {
  constructor(message, { code = 'QC_ERROR', httpStatus = 400, detail = null } = {}) {
    super(message)
    this.name = 'QCError'
    this.code = code
    // 全局错误中间件读的是 err.status，不赋值会被当成 500 —— 与 DocFlowError / ApprovalError 同一约定
    this.httpStatus = httpStatus
    this.status = httpStatus
    this.detail = detail
  }
}

/** 结论枚举：判退与让步的存在与否决定结论，不是人手工选的（避免结论与数字打架） */
function resultOf({ total, qualified, concession, rejected }) {
  if (total <= 0) return 'pending'
  if (rejected >= total - 1e-6) return 'rejected'          // 全退
  if (rejected > 0) return 'partial_rejected'              // 部分判退
  if (concession > 0) return 'concession'                  // 让步接收
  if (qualified >= total - 1e-6) return 'qualified'        // 全部合格
  return 'pending'
}

export const RESULT_LABEL = {
  pending: '待质检',
  qualified: '全部合格',
  concession: '让步接收',
  partial_rejected: '部分判退',
  rejected: '全部判退'
}

/** 装填：取到货单及其行（含已质检数量，便于判断还有多少未检） */
export function getReceiptForInspect(db, receiptId) {
  const rc = db
    .prepare(
      `SELECT rc.*, s.name AS supplier_name, w.name AS warehouse_name, o.doc_no AS order_no
         FROM purchase_receipts rc
         LEFT JOIN suppliers s ON s.id = rc.supplier_id
         LEFT JOIN warehouses w ON w.id = rc.warehouse_id
         LEFT JOIN purchase_orders o ON o.id = rc.order_id
        WHERE rc.id = ?`
    )
    .get(receiptId)
  if (!rc) return null
  const items = db
    .prepare(
      `SELECT ri.*, s.sku_code, s.name AS sku_name
         FROM purchase_receipt_items ri
         LEFT JOIN product_skus s ON s.id = ri.sku_id
        WHERE ri.receipt_id = ? ORDER BY ri.id`
    )
    .all(receiptId)
  const inspection = db.prepare('SELECT * FROM purchase_inspections WHERE receipt_id=?').get(receiptId)
  return { ...rc, items, inspection: inspection || null }
}

/**
 * 待质检的到货单：已收货（received）且**尚未出结论**。
 *
 * 这里有一条容易写错、写错了又看不出来的口径：
 *   判据是「没有 已质检/已关闭 的质检单」，**不是**「没有任何质检单」。
 *   因为提交质检结论可能失败（最典型的是判退要出库、而货已被下游消耗掉 → 库存不足），
 *   失败时事务回滚，但**建单那一步是独立事务、已经落库**，于是留下一张 draft 草稿。
 *   如果判据写成「没有任何质检单」，这张到货单就会从待质检队列里**消失** ——
 *   它既不在待办里，也不会出现在已质检里，除非有人记得去翻质检单列表的草稿页。
 *   所以：草稿也算「待质检」，并把草稿单号一起带出去，前端据此打开草稿而不是新建
 *   （新建会撞 uq_inspection_receipt 唯一约束，报一个与真实原因无关的错）。
 */
export function pendingReceipts(db, { limit = 50, orgScope = null } = {}) {
  const scope = stockScopeSql(orgScope, 'rc')
  return db
    .prepare(
      `SELECT rc.id, rc.doc_no, rc.receipt_date, rc.total_qty, rc.total_amount,
              rc.supplier_id, rc.warehouse_id, rc.inspector,
              s.name AS supplier_name, w.name AS warehouse_name, o.doc_no AS order_no,
              (SELECT COUNT(*) FROM purchase_receipt_items i WHERE i.receipt_id=rc.id) AS line_count,
              (SELECT i.id     FROM purchase_inspections i WHERE i.receipt_id=rc.id AND i.status='draft') AS draft_id,
              (SELECT i.doc_no FROM purchase_inspections i WHERE i.receipt_id=rc.id AND i.status='draft') AS draft_no
         FROM purchase_receipts rc
         LEFT JOIN suppliers s ON s.id = rc.supplier_id
         LEFT JOIN warehouses w ON w.id = rc.warehouse_id
         LEFT JOIN purchase_orders o ON o.id = rc.order_id
        WHERE rc.status = 'received' AND ${scope.sql}
          AND NOT EXISTS (
            SELECT 1 FROM purchase_inspections i
             WHERE i.receipt_id = rc.id AND i.status NOT IN ('cancelled', 'draft')
          )
        ORDER BY rc.receipt_date DESC, rc.id DESC
        LIMIT ?`
    )
    .all(...scope.params, limit)
}

/**
 * 从到货单建质检单（草稿）。默认全部合格 —— 让「正常情况」是一次点击，
 * 「异常情况」才需要人改数字。反过来（默认待定）会让人每次都从零填。
 */
export function createInspection(db, insp = {}) {
  const { receiptId, inspectDate = null, inspector = null, items = null, actor = {}, source = 'api' } = insp
  if (!receiptId) throw new QCError('缺少到货单', { code: 'QC_NO_RECEIPT' })

  const rc = db.prepare('SELECT * FROM purchase_receipts WHERE id=?').get(receiptId)
  if (!rc) throw new QCError('到货单不存在', { code: 'QC_RECEIPT_NOT_FOUND', httpStatus: 404 })
  if (rc.status !== 'received') {
    throw new QCError(
      rc.status === 'draft'
        ? '该到货单尚未确认收货，不能质检'
        : `到货单当前为「${rc.status}」，只有「已收货」状态才能质检`,
      { code: 'QC_RECEIPT_NOT_RECEIVED', httpStatus: 409 }
    )
  }

  const exist = db.prepare('SELECT id, doc_no, status FROM purchase_inspections WHERE receipt_id=?').get(receiptId)
  if (exist && exist.status !== 'cancelled') {
    throw new QCError(`该到货单已有质检单 ${exist.doc_no}（${exist.status}）`, {
      code: 'QC_DUPLICATE', httpStatus: 409, detail: { inspection_id: exist.id, doc_no: exist.doc_no }
    })
  }
  // 已取消的旧单先删掉：唯一索引 uq_inspection_receipt 只认「一张到货单一条记录」，
  // 留着旧的会直接撞唯一约束；而那张单已经作废，没有保留价值。
  // **留痕要跟着一起删**：doc_events 里的 INS 行按 doc_id 关联，单删了留痕还在，
  // 新单复用同一个 id 就会「继承」上一张单的历史 —— 时间线里凭空多出「已取消」。
  // 这类错不会报错，只会让人不再相信单据的流转记录。
  if (exist) {
    db.prepare("DELETE FROM doc_events WHERE doc_type='INS' AND doc_id=?").run(exist.id)
    db.prepare('DELETE FROM purchase_inspections WHERE id=?').run(exist.id)
  }

  const rcItems = db
    .prepare('SELECT * FROM purchase_receipt_items WHERE receipt_id=? ORDER BY id')
    .all(receiptId)
  if (!rcItems.length) throw new QCError('该到货单没有明细行', { code: 'QC_RECEIPT_EMPTY' })

  const date = ymd(inspectDate || new Date())
  const tx = db.transaction(() => {
    const no = nextInsNo(db, date)
    const info = db
      .prepare(
        `INSERT INTO purchase_inspections
           (doc_no,receipt_id,receipt_no,order_id,supplier_id,warehouse_id,inspect_date,
            inspect_by,inspect_by_name,result,status,remark,created_by,created_by_name,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,'pending','draft',?,?,?,?,?)`
      )
      .run(
        no, receiptId, rc.doc_no, rc.order_id || null, rc.supplier_id, rc.warehouse_id, date,
        actor.id || null, actor.name || null, insp.remark || null,
        actor.id || null, actor.name || null, nowStr(), nowStr()
      )
    const id = info.lastInsertRowid

    // 行级数据来源：**到货单行**（这是事实来源，不允许质检单自己编数量）
    const insItem = db.prepare(
      `INSERT INTO purchase_inspection_items
         (inspection_id,line_no,receipt_item_id,sku_id,batch_no,qty,qualified_qty,concession_qty,rejected_qty,defect_code,defect_reason,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    const override = Array.isArray(items) ? items : []
    let total = 0
    let qualified = 0
    rcItems.forEach((ri, i) => {
      const qty = round2(num(ri.qty))
      const o = override.find((x) => Number(x.receipt_item_id) === ri.id || Number(x.id) === ri.id) || {}
      const q = o.qualified_qty != null ? round2(num(o.qualified_qty)) : qty
      const c = o.concession_qty != null ? round2(num(o.concession_qty)) : 0
      const r = o.rejected_qty != null ? round2(num(o.rejected_qty)) : 0
      assertClosure(qty, q, c, r, ri.sku_id)
      insItem.run(id, i + 1, ri.id, ri.sku_id, ri.batch_no || '', qty, q, c, r,
        o.defect_code || null, o.defect_reason || null, o.remark || null)
      total += qty
      qualified += q
    })
    db.prepare(
      'UPDATE purchase_inspections SET total_qty=?, qualified_qty=?, result=? WHERE id=?'
    ).run(round2(total), round2(qualified), resultOf({ total, qualified, concession: 0, rejected: 0 }), id)

    // 检验员名字回写到到货单：到货单上原本就有 inspector 字段，一直没人写
    // （purchase_receipts 没有 updated_at 列，别顺手加上去）
    db.prepare('UPDATE purchase_receipts SET inspector=? WHERE id=?')
      .run(actor.name || null, receiptId)

    return id
  })
  return getInspection(db, tx())
}

/** 三数闭合校验。不闭合 = 有货凭空消失，而账上不会报警，所以必须在写库前拦住。 */
function assertClosure(qty, qualified, concession, rejected, skuId) {
  if (qty < 0 || qualified < 0 || concession < 0 || rejected < 0) {
    throw new QCError(`SKU#${skuId} 的质检数量不能为负`, { code: 'QC_NEGATIVE_QTY' })
  }
  const sum = round2(qualified + concession + rejected)
  if (Math.abs(sum - round2(qty)) > 0.005) {
    throw new QCError(
      `SKU#${skuId} 质检数量不闭合：合格 ${qualified} + 让步 ${concession} + 判退 ${rejected} = ${sum}，` +
        `但到货 ${round2(qty)}。漏掉的数量既不是合格也不是退货 —— 它会凭空消失。`,
      {
        code: 'QC_NOT_CLOSED', httpStatus: 400,
        detail: { sku_id: skuId, qty: round2(qty), qualified, concession, rejected, sum }
      }
    )
  }
}

export function getInspection(db, id) {
  const head = db
    .prepare(
      `SELECT i.*, s.name AS supplier_name, w.name AS warehouse_name,
              o.doc_no AS order_no, rc.receipt_date, rc.status AS receipt_status
         FROM purchase_inspections i
         LEFT JOIN suppliers s ON s.id = i.supplier_id
         LEFT JOIN warehouses w ON w.id = i.warehouse_id
         LEFT JOIN purchase_orders o ON o.id = i.order_id
         LEFT JOIN purchase_receipts rc ON rc.id = i.receipt_id
        WHERE i.id = ?`
    )
    .get(id)
  if (!head) return null
  const items = db
    .prepare(
      `SELECT ii.*, s.sku_code, s.name AS sku_name
         FROM purchase_inspection_items ii
         LEFT JOIN product_skus s ON s.id = ii.sku_id
        WHERE ii.inspection_id = ? ORDER BY ii.line_no`
    )
    .all(id)
  const events = db
    .prepare(
      `SELECT action, action_name, from_state, to_state, actor_name, remark, created_at
         FROM doc_events WHERE doc_type='INS' AND doc_id=? ORDER BY id`
    )
    .all(id)
  return { ...head, items, events, result_label: RESULT_LABEL[head.result] || head.result }
}

export function listInspections(db, q = {}) {
  const { page = 1, pageSize = 20, status = null, result = null, supplierId = null, receiptId = null, orgScope = null } = q
  const where = []
  const args = []
  // ADR-0038 补充：质检单随到货仓的组织范围裁剪（orgScope 不传 = 全局）
  const scope = stockScopeSql(orgScope, 'i')
  where.push(scope.sql); args.push(...scope.params)
  if (status) { where.push('i.status = ?'); args.push(status) }
  if (result) { where.push('i.result = ?'); args.push(result) }
  if (supplierId) { where.push('i.supplier_id = ?'); args.push(supplierId) }
  if (receiptId) { where.push('i.receipt_id = ?'); args.push(receiptId) }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) c FROM purchase_inspections i ${w}`).get(...args).c
  const offset = (Math.max(1, page) - 1) * pageSize
  const rows = db
    .prepare(
      `SELECT i.*, s.name AS supplier_name, w2.name AS warehouse_name, o.doc_no AS order_no
         FROM purchase_inspections i
         LEFT JOIN suppliers s ON s.id = i.supplier_id
         LEFT JOIN warehouses w2 ON w2.id = i.warehouse_id
         LEFT JOIN purchase_orders o ON o.id = i.order_id
         ${w}
        ORDER BY i.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, offset)
  return {
    rows: rows.map((r) => ({ ...r, result_label: RESULT_LABEL[r.result] || r.result })),
    total, page: Math.max(1, page), pageSize
  }
}

/**
 * 提交质检结论（draft → inspected）。**这是质检唯一有后果的动作。**
 *
 * 顺序固定，不能反：
 *   ① 先用行级数字覆盖草稿（并强校验三数闭合）
 *   ② 判退数量 → 生成采购退货单并出库（**先退后检**：退货失败就不该把结论定下来）
 *   ③ 到货单 received → inspected（走内核）
 *   ④ 最后一次写结论与汇总
 *
 * 如果顺序反过来（先改状态再判退），判退失败时会留下一张「已质检但没退货」的单 —— 劣品还在正品库里。
 */
export function submitInspection(db, { id, lines = null, actor = {}, remark = null, source = 'api' }) {
  const head = db.prepare('SELECT * FROM purchase_inspections WHERE id=?').get(id)
  if (!head) throw new QCError('质检单不存在', { code: 'QC_NOT_FOUND', httpStatus: 404 })

  const tx = db.transaction(() => {
    // ---- ① 用传入的行级数字覆盖草稿 ----
    if (Array.isArray(lines) && lines.length) {
      const items = db.prepare('SELECT * FROM purchase_inspection_items WHERE inspection_id=? ORDER BY line_no').all(id)
      const up = db.prepare(
        `UPDATE purchase_inspection_items
            SET qualified_qty=?, concession_qty=?, rejected_qty=?, defect_code=?, defect_reason=?, remark=?
          WHERE id=?`
      )
      for (const it of items) {
        const o = lines.find((x) => Number(x.id) === it.id)
        if (!o) continue
        const q = o.qualified_qty != null ? round2(num(o.qualified_qty)) : num(it.qualified_qty)
        const c = o.concession_qty != null ? round2(num(o.concession_qty)) : num(it.concession_qty)
        const r = o.rejected_qty != null ? round2(num(o.rejected_qty)) : num(it.rejected_qty)
        assertClosure(num(it.qty), q, c, r, it.sku_id)
        up.run(q, c, r, o.defect_code ?? it.defect_code, o.defect_reason ?? it.defect_reason, o.remark ?? it.remark, it.id)
      }
    }

    const items = db.prepare('SELECT * FROM purchase_inspection_items WHERE inspection_id=? ORDER BY line_no').all(id)
    const total = round2(items.reduce((s, x) => s + num(x.qty), 0))
    const qualified = round2(items.reduce((s, x) => s + num(x.qualified_qty), 0))
    const concession = round2(items.reduce((s, x) => s + num(x.concession_qty), 0))
    const rejected = round2(items.reduce((s, x) => s + num(x.rejected_qty), 0))
    resultOf({ total, qualified, concession, rejected }) // 触发一次，确保结论可判定（total=0 会被下面的校验拦）

    // 草稿里若还没有数量（例如建单时全填 0），必须显式拒绝，而不是当作「全部合格」
    if (total <= 0) {
      throw new QCError('质检单没有任何到货数量，无法提交', { code: 'QC_EMPTY' })
    }

    // ---- ② 判退 → 生成退货单并出库 ----
    let returnId = null
    let returnNo = null
    if (rejected > 0.0001) {
      const rejLines = items
        .filter((x) => num(x.rejected_qty) > 0.0001)
        .map((x) => ({
          sku_id: x.sku_id,
          batch_no: x.batch_no || '',
          qty: num(x.rejected_qty),
          // 退货单价取到货单价（票面价），不取当前标准成本 —— 退的是这一批货，按这一批的价退
          price: receiptItemPrice(db, x.receipt_item_id)
        }))
      const reasons = [...new Set(items.map((x) => x.defect_reason).filter(Boolean))]
      returnId = createPurchaseReturn(db, {
        supplierId: head.supplier_id,
        warehouseId: head.warehouse_id,
        returnDate: head.inspect_date,
        reason: `质检判退（${head.doc_no}）${reasons.length ? '：' + reasons.join('；') : ''}`,
        items: rejLines,
        actor,
        source
      })
      returnNo = db.prepare('SELECT doc_no FROM purchase_returns WHERE id=?').get(returnId)?.doc_no || null
    }

    // ---- ③ 到货单 received → inspected（走内核，不直接 UPDATE 状态）----
    const rc = db.prepare('SELECT id, status FROM purchase_receipts WHERE id=?').get(head.receipt_id)
    if (rc && rc.status === 'received') {
      applyTransition({
        db, docType: 'GR', id: rc.id, action: 'inspect',
        actor: { id: actor.id || null, name: actor.name || null },
        remark: `质检单 ${head.doc_no}${rejected > 0 ? `，判退 ${rejected}` : ''}`,
        source
      })
    }

    // ---- ④ 写结论与汇总，再走内核把质检单推进到 inspected ----
    db.prepare(
      `UPDATE purchase_inspections
          SET total_qty=?, qualified_qty=?, concession_qty=?, rejected_qty=?,
              result=?, return_id=?, return_no=?, inspect_by=?, inspect_by_name=?, updated_at=?
        WHERE id=?`
    ).run(
      total, qualified, concession, rejected,
      resultOf({ total, qualified, concession, rejected }),
      returnId, returnNo, actor.id || null, actor.name || null, nowStr(), id
    )

    applyTransition({
      db, docType: 'INS', id, action: 'inspect',
      actor: { id: actor.id || null, name: actor.name || null },
      remark: remark || `质检完成：合格 ${qualified} / 让步 ${concession} / 判退 ${rejected}`,
      source
    })

    // 到货单状态变了 → 订单的四段关闭要跟着重算（入库关闭取决于收货单是否关闭，
    // 而质检完成是「可以关收货单」的前提）
    const oid = head.order_id
    if (oid) {
      refreshOrderStats(db, oid)
      refreshCloseFlags(db, oid)
    }
    return { returnId, returnNo }
  })

  const out = tx()
  return { ...getInspection(db, id), return_created: out.returnId ? { id: out.returnId, doc_no: out.returnNo } : null }
}

/** 关闭 / 取消：纯归档动作，不产生业务后果 */
export function transitionInspection(db, { id, action, actor = {}, remark = null, source = 'api' }) {
  const head = db.prepare('SELECT * FROM purchase_inspections WHERE id=?').get(id)
  if (!head) throw new QCError('质检单不存在', { code: 'QC_NOT_FOUND', httpStatus: 404 })
  const r = applyTransition({
    db, docType: 'INS', id, action,
    actor: { id: actor.id || null, name: actor.name || null },
    remark, source
  })
  return r
}

function receiptItemPrice(db, receiptItemId) {
  if (!receiptItemId) return 0
  const r = db.prepare('SELECT price FROM purchase_receipt_items WHERE id=?').get(receiptItemId)
  return round2(num(r?.price))
}

/** 单号：QC + 日期 + 4 位序号，与其它采购单据保持一致 */
function nextInsNo(db, date) {
  const key = `QC${String(date).replace(/-/g, '')}`
  const row = db
    .prepare("SELECT doc_no FROM purchase_inspections WHERE doc_no LIKE ? ORDER BY doc_no DESC LIMIT 1")
    .get(`${key}%`)
  let seq = 1
  if (row?.doc_no) {
    const n = parseInt(String(row.doc_no).slice(key.length), 10)
    if (!Number.isNaN(n)) seq = n + 1
  }
  const exists = db.prepare('SELECT 1 AS hit FROM purchase_inspections WHERE doc_no=? LIMIT 1')
  const build = (n) => `${key}${String(n).padStart(4, '0')}`
  let no = build(seq)
  let guard = 0
  while (exists.get(no) && guard++ < 9999) no = build(++seq)
  return no
}

// ---------------------------------------------------------------------------
// 概览
// ---------------------------------------------------------------------------

export function inspectionOverview(db, { orgScope = null } = {}) {
  // ADR-0046：质检单按自身 warehouse_id、判退退货单按其 warehouse_id，同一份 stockScopeSql；
  // 全局范围谓词为 `1=1`（口径不变），空范围 ⇒ 全 0。
  const si = stockScopeSql(orgScope, '')
  const sr = stockScopeSql(orgScope, 'r')
  const one = (sql, ...a) => num(db.prepare(sql).get(...a)?.v)
  const ins = (expr, extra = '') => one(`SELECT ${expr} v FROM purchase_inspections WHERE ${si.sql}${extra}`, ...si.params)
  return {
    total: ins('COUNT(*)'),
    pending: ins('COUNT(*)', " AND status='draft'"),
    inspected: ins('COUNT(*)', " AND status='inspected'"),
    closed: ins('COUNT(*)', " AND status='closed'"),
    waiting_receipts: num(pendingReceipts(db, { limit: 999, orgScope }).length),
    // 其中已经建了草稿、只等提交的那部分。单列出来是因为这两种「待质检」要做的事不一样：
    // 没有草稿的要去建单，有草稿的是上次提交没成功（多为判退库存不足），要改数字再提交。
    draft_ready: ins('COUNT(DISTINCT receipt_id)', " AND status='draft'"),
    // 判退：这一段是质检存在的意义 —— 没有判退，质检就只是一张纸
    rejected_qty: round2(ins('COALESCE(SUM(rejected_qty),0)')),
    rejected_amount: round2(
      one(
        `SELECT COALESCE(SUM(ri.qty * ri.price),0) v
           FROM purchase_return_items ri
           JOIN purchase_returns r ON r.id = ri.return_id
          WHERE r.reason LIKE '质检判退%' AND ${sr.sql}`,
        ...sr.params
      )
    ),
    concession_qty: round2(ins('COALESCE(SUM(concession_qty),0)')),
    returns_created: one(`SELECT COUNT(*) v FROM purchase_returns r WHERE r.reason LIKE '质检判退%' AND ${sr.sql}`, ...sr.params),
    // 判退率：按数量算（金额会被高价值 SKU 带偏，与库存周转口径一致）
    reject_rate: (() => {
      const t = ins('COALESCE(SUM(total_qty),0)')
      const r = ins('COALESCE(SUM(rejected_qty),0)')
      return t > 0 ? round2((r / t) * 100) : 0
    })()
  }
}

export default {
  QCError, RESULT_LABEL,
  createInspection, getInspection, listInspections, submitInspection, transitionInspection,
  pendingReceipts, getReceiptForInspect, inspectionOverview
}
