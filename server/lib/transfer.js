/**
 * ============================================================================
 * 文件标识：server/lib/transfer.js ｜ 库存调拨单服务层：**建单 / 出库 / 入库** 三件事的唯一实现。
 * ============================================================================
 * 【职责】库存调拨单服务层：**建单 / 出库 / 入库** 三件事的唯一实现。
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 库存调拨单服务层：**建单 / 出库 / 入库** 三件事的唯一实现。
//
// 为什么必须抽到 lib 而不是留在路由里：
//   调拨单以前只有一条产生路径（人在库存页开单 → 出库 → 收货），逻辑就写在
//   `routes/inventory.js` 里。质检的「不良品处置」现在也要产生调拨单
//   （让步 → 不合格仓、返工 → 待检仓，客户口径：处置即调拨），而服务层不能反向
//   依赖路由 —— 复制一份出来最省事，但两份实现一定会分叉，而分叉点恰好是最难发现的
//   成本回写：`shipTransfer` 把**实际出库单价**回写到明细，入库侧必须用同一个价，
//   否则就是「出 100 进 0」——成本在源仓冲掉了、在调入仓一分没进，账还平。
//   所以出口只有一个：路由与质检处置都调本文件。
//
// 三个函数与内核的对应关系（口径不在这里另立一套）：
//   createTransfer  建 stock_transfers + stock_transfer_items（draft），合计数量/金额
//   shipTransfer    draft|submitted → shipped：逐行 applyStockOut(TR_OUT) + 回写实际单价
//   receiveTransfer shipped → received：逐行 applyStockIn(TR_IN) + 内核流转
// 单号：类型码 `TF`、前缀 `TR`（见 008_doc_kernel.cjs 的 DOC_TYPES 登记），
// 单号生成走 `nextDocNo` —— 与页面开单同一个号段，不另起一套。

import { applyTransition, findAction } from './docflow.js'
import { nextDocNo } from './docno.js'
import { applyStockIn, applyStockOut, stockScopeSql, assertWarehouseInScope } from './stock.js'
import { localDate } from './dates.js'

const num = (v) => Number(v) || 0
const actorOf = (a) => (a && typeof a === 'object' ? a : {})

/**
 * 调拨单类型（`stock_transfers.type`）的**可枚举取值**。
 *
 * 客户口径：「出库单一定会有多种类型的，所以你的出入库单上一定要加一个类型」。
 * 这一列是**用户能看见的类型**，不能只靠 remark 区分 —— 所以质检处置自动生成的调拨单
 * 必须与"人在库存页面开的调拨单"在**类型列**上就分开：
 *   normal          普通调拨（页面上手工开，默认值，也是 schema 的 DEFAULT）
 *   allocation      铺货调拨（门店要货配货生成，见 routes/requisitions.js 的 to-transfer）
 *   qc_disposition  质检处置调拨（让步接收 → 不合格品仓 / 返工 → 待检品仓，质检确认处置时自动生成）
 *
 * 新增取值时改这一处 + 界面文案（`src/pages/inventory/Transfers.tsx` 的「类型」列映射）。
 * 已经全库检索确认：**没有任何地方按 `stock_transfers.type = 'normal'` 做白名单筛选**
 * （只有创建默认值、类型列展示、以及 pages/inventory 的新建表单三个消费点），
 * 所以多一个取值不会被漏掉。
 */
export const TRANSFER_TYPES = {
  normal: '普通调拨',
  allocation: '铺货调拨',
  qc_disposition: '质检处置调拨'
}

/**
 * 建调拨单（draft）。不做出入库 —— 出/入库分别由 ship / receive 负责。
 *
 * @param {object} p
 * @param {number} p.fromWarehouseId
 * @param {number} p.toWarehouseId
 * @param {Array<{sku_id:number,batch_no?:string,qty:number,cost_price?:number|null}>} p.items
 * @param {string} [p.transferDate]  业务日期，缺省取本地日期
 * @param {string} [p.type]          见 TRANSFER_TYPES（缺省 normal）
 * @param {string} [p.remark]
 * @param {object} [p.actor]         { id, name }（uid/name 两种形态都认）
 * @param {boolean} [p.autoShip]     建完立刻出库（质检自动生成调拨单走这条）
 * @returns {{ id:number, docNo:string, type:string }}
 */
export function createTransfer(db, p = {}) {
  const fromWarehouseId = p.fromWarehouseId
  const toWarehouseId = p.toWarehouseId
  if (!fromWarehouseId || !toWarehouseId) {
    throw new Error('请选择调出与调入仓库')
  }
  if (Number(fromWarehouseId) === Number(toWarehouseId)) {
    throw new Error('调出与调入仓库不能相同')
  }
  const items = Array.isArray(p.items) ? p.items : []
  if (!items.length) throw new Error('请添加调拨明细')
  const transferDate = String(p.transferDate || '').trim() || localDate()
  const actor = actorOf(p.actor)
  const actorId = actor.uid ?? actor.id ?? null
  const actorName = actor.name ?? null

  const run = db.transaction(() => {
    const docNo = nextDocNo(db, 'TR', 'stock_transfers', 'doc_no', transferDate)
    const info = db
      .prepare(
        `INSERT INTO stock_transfers
           (doc_no,from_warehouse_id,to_warehouse_id,transfer_date,type,status,total_qty,total_amount,applicant,remark,created_by)
         VALUES (?,?,?,?,?,'draft',0,0,?,?,?)`
      )
      .run(docNo, fromWarehouseId, toWarehouseId, transferDate, p.type || 'normal', actorName, p.remark || null, actorId)
    const tid = info.lastInsertRowid
    const insItem = db.prepare(
      'INSERT INTO stock_transfer_items (transfer_id,sku_id,batch_no,qty,cost_price,amount) VALUES (?,?,?,?,?,?)'
    )
    let q = 0
    let a = 0
    for (const it of items) {
      const qty = num(it.qty)
      if (qty <= 0) continue
      // G4：明细**没填价**要落成 `null`（未指定），由库存引擎在出/入库时回落到结存均价。
      // 不能写 `Number(it.cost_price || 0)`：那等于把「没填」变成「显式 0 成本」——
      // 调拨出库金额为 0、源仓金额不冲减，调入仓按照 0 成本入账（整笔成本凭空消失）。
      const cost = it.cost_price == null || it.cost_price === '' ? null : Number(it.cost_price)
      const batchNo = it.batch_no || ''
      insItem.run(tid, it.sku_id, batchNo, qty, cost, cost == null ? null : Number((qty * cost).toFixed(2)))
      q += qty
      if (cost != null) a += qty * cost
    }
    if (q <= 0) throw new Error('调拨明细数量必须大于 0')
    db.prepare('UPDATE stock_transfers SET total_qty=?, total_amount=? WHERE id=?').run(q, Number(a.toFixed(2)), tid)
    if (p.autoShip) shipTransfer(db, tid, actor)
    return { id: tid, docNo, type: p.type || 'normal' }
  })
  return run()
}

/**
 * 调拨出库：draft|submitted → shipped。**真的扣源仓库存**，并留下 TR_OUT 流水。
 * 前置闸门交给内核（`findAction`）——非法状态由它抛 409 并提示可执行动作。
 *
 * @param {object} [opts]
 * @param {string} [opts.remark] 覆盖流水的备注。缺省写「调拨出库 → <调入仓名>」；
 *   调用方（如质检处置）用它把**来源**带进流水备注 —— 客户要求"出入库单上的类型要能看出
 *   这是什么单"，流水这一层就靠 `doc_type`（语义）+ `remark`（来源）+ `doc_id`（指向调拨单）。
 */
export function shipTransfer(db, id, actorRaw = {}, { remark = null } = {}) {
  const actor = actorOf(actorRaw)
  const head = db.prepare('SELECT * FROM stock_transfers WHERE id=?').get(id)
  if (!head) {
    const e = new Error('调拨单不存在')
    e.status = 404
    throw e
  }
  findAction(db, 'TF', head.status, 'ship')
  const toName = db.prepare('SELECT name FROM warehouses WHERE id=?').get(head.to_warehouse_id)?.name || `#${head.to_warehouse_id}`
  const items = db.prepare('SELECT * FROM stock_transfer_items WHERE transfer_id=?').all(id)
  let shipQty = 0
  let shipAmt = 0
  for (const it of items) {
    // G4：明细上的单价可能是 `null`（建单时没填）⇒ 交给引擎回落源仓结存均价。
    // 显式传 0 才是「确实按 0 成本调拨」。
    const out = applyStockOut(db, {
      bizDate: head.transfer_date, docType: 'TR_OUT', docNo: head.doc_no, docId: id,
      warehouseId: head.from_warehouse_id, skuId: it.sku_id, batchNo: it.batch_no, qty: it.qty,
      unitCost: it.cost_price ?? undefined, operator: actor.name ?? null,
      remark: remark || `调拨出库 → ${toName}`
    })
    // 实际出库单价回写明细：调拨的成本**随货平移**，入库侧必须用同一个价，
    // 否则「出 100 进 0」——成本在源仓冲掉了、在调入仓却一分没进（G4 的另一半）。
    db.prepare('UPDATE stock_transfer_items SET cost_price=?, amount=? WHERE id=?')
      .run(out.unitCost, Number(Number(out.outAmount || 0).toFixed(2)), it.id)
    shipQty += num(it.qty)
    shipAmt += num(out.outAmount)
  }
  db.prepare('UPDATE stock_transfers SET total_qty=?, total_amount=? WHERE id=?')
    .run(shipQty, Number(shipAmt.toFixed(2)), id)
  applyTransition({
    db, docType: 'TF', id, action: 'ship',
    actor: { id: actor.uid ?? actor.id ?? null, name: actor.name ?? null },
    remark: '调拨出库'
  })
  return { id, doc_no: head.doc_no, qty: shipQty, amount: Number(shipAmt.toFixed(2)) }
}

/**
 * 调拨收货：shipped → received。**真的把货入到调入仓**，并留下 TR_IN 流水。
 * 只有「已出库」的调拨单可以收货 —— 没出库就收货等于凭空造货。
 *
 * @param {object} [opts]
 * @param {string} [opts.remark] 覆盖流水的备注（同上，供质检处置带来源）。
 */
export function receiveTransfer(db, id, actorRaw = {}, { receiveDate = null, remark = null } = {}) {
  const actor = actorOf(actorRaw)
  const head = db.prepare('SELECT * FROM stock_transfers WHERE id=?').get(id)
  if (!head) {
    const e = new Error('调拨单不存在')
    e.status = 404
    throw e
  }
  if (head.status !== 'shipped') {
    const e = new Error('只有已出库的调拨单可以收货')
    e.status = 400
    e.code = 'TRANSFER_NOT_SHIPPED'
    throw e
  }
  const fromName = db.prepare('SELECT name FROM warehouses WHERE id=?').get(head.from_warehouse_id)?.name || `#${head.from_warehouse_id}`
  const items = db.prepare('SELECT * FROM stock_transfer_items WHERE transfer_id=?').all(id)
  for (const it of items) {
    applyStockIn(db, {
      bizDate: receiveDate || head.transfer_date, docType: 'TR_IN', docNo: head.doc_no, docId: id,
      warehouseId: head.to_warehouse_id, skuId: it.sku_id, batchNo: it.batch_no, qty: it.qty,
      unitCost: it.cost_price, operator: actor.name ?? null,
      remark: remark || `调拨入库 ← ${fromName}`
    })
  }
  applyTransition({
    db, docType: 'TF', id, action: 'receive',
    actor: { id: actor.uid ?? actor.id ?? null, name: actor.name ?? null },
    remark: '调拨入库'
  })
  return { id, doc_no: head.doc_no }
}

// ---------------------------------------------------------------------------
// 组织范围（ADR-0038）：调拨单有调出 / 调入两个仓，各自归属组织不一定相同。
//   · 读（列表 / 详情）：任一端在范围内即可见；
//   · 写（建单 / 出库 / 收货 / 提交 / 作废）：两端都必须在范围内 —— 否则一次调拨就能把货从别的组织的仓搬走，
//     或把货塞进别的组织的仓。建单的目标越界 ⇒ 403；既有单据一端越界 ⇒ 403（可读但不可动）；两端皆外 ⇒ 与不存在同形 404。
// 判据只有 `stockScopeSql` 一份；全局范围恒通过，lib 内部调用（质检处置等）不传 orgScope 口径不变。
// ---------------------------------------------------------------------------

/** 调拨单读范围谓词（任一端在范围内）。`alias` 是 `stock_transfers` 的别名。 */
export function transferScopeSql(orgScope, alias = 't') {
  const f = stockScopeSql(orgScope, alias, 'from_warehouse_id')
  const t = stockScopeSql(orgScope, alias, 'to_warehouse_id')
  if (f.empty) return { sql: '1=0', params: [], empty: true }
  if (!f.params.length) return { sql: '1=1', params: [], empty: false }
  return { sql: `(${f.sql} OR ${t.sql})`, params: [...f.params, ...t.params], empty: false }
}

/** 建单目标：调出 / 调入仓都必须在范围内，否则 403。 */
export function assertTransferTargetsInScope(db, fromWarehouseId, toWarehouseId, orgScope) {
  assertWarehouseInScope(db, fromWarehouseId, orgScope)
  assertWarehouseInScope(db, toWarehouseId, orgScope)
}

/**
 * 取调拨单并判范围；`write: true` 时两端都须在范围内。返回表头行。
 * 两端皆外 / 不存在 ⇒ 404（同形）；可见但写时一端越界 ⇒ 403。
 */
export function assertTransferInScope(db, id, orgScope, { write = false } = {}) {
  const sc = transferScopeSql(orgScope, 't')
  const head = Number.isFinite(Number(id))
    ? db.prepare(`SELECT t.* FROM stock_transfers t WHERE t.id=? AND ${sc.sql}`).get(Number(id), ...sc.params)
    : null
  if (!head) {
    const e = new Error('调拨单不存在')
    e.status = 404
    e.code = 'DOC_NOT_FOUND'
    throw e
  }
  if (write) assertTransferTargetsInScope(db, head.from_warehouse_id, head.to_warehouse_id, orgScope)
  return head
}

export default {
  createTransfer, shipTransfer, receiveTransfer, TRANSFER_TYPES,
  transferScopeSql, assertTransferTargetsInScope, assertTransferInScope
}
