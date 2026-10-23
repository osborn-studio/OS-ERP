/**
 * ============================================================================
 * 文件标识：server/lib/sales-order.js ｜ 销售订单领域服务（D5）
 * ============================================================================
 * 【职责】销售订单领域服务（D5）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 销售订单领域服务（D5）
//
// 为什么要有这个文件：**「作废订单」有两个入口** ——
//   `POST /api/sales/orders/:id/cancel`（后台）与 MCP 的 `sales.cancel_order`（Agent）。
// 原来两处各写一份：路由那份做了"释放预留 + 退内核 + 释放授信"，MCP 那份只有一行
// `UPDATE sales_orders SET status='cancelled'` —— **同一件事，两个入口，两种后果**。
// 走 MCP 作废的订单：库存占用**没释放**（那批货永远卖不出去）、授信**没还回去**
// （客户额度只减不增），而单子看起来"已作废"，一切正常。
//
// 所以把这段抽到这里：**入口可以有两个，实现只能有一份。**
// 这与第 2 批 `claimTransitionEffect`（流转效果归属）是同一个口径，
// 只不过那次解决的是"通用入口 vs 业务入口"，这次解决的是"HTTP 入口 vs Agent 入口"。

import { advanceStatus, nowText } from './docflow.js'
import { releaseForDoc } from './stock.js'
import { release as creditRelease, projectOrderHold, resolveSubject } from './credit.js'

export class SalesOrderError extends Error {
  constructor(code, message, status = 400, detail = null) {
    super(message)
    this.code = code
    this.status = status
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// 组织数据范围（ADR-0026）：销售域**唯一**的组织范围判据。
// 与采购侧 `purchaseScopeSql` / `assertPurchaseDocInScope`（ADR-0017/0020）同一口径：
//   · 不传或 `all` ⇒ 全库；`dealer` / `none` / 空集合 ⇒ 空范围（`1=0`，空范围不许变成全库）；
//   · 其余 ⇒ 按单据归属组织过滤。
// 销售订单没有 `org_id` 列，归属由两条参与方推出：出货仓 `warehouses.org_id`、门店 `stores.org_id`
// （经销商是客户而不是本方组织，不参与）。**任一参与方在范围内即可见**；两者都为 NULL 对受限范围不可见、
// 对全局范围可见。发货单经所属订单；退货单有来源订单时经订单，无单退货用自己的仓 / 门店。
// 读（列表 / 详情 / 统计）用 `salesScopeSql`；详情与写路由取单后用 `assertSalesDocInScope`
// （不在范围内与不存在**同形**：同一句 404，不泄漏存在性）；建单 / 发货 / 退货的目标仓与门店用
// `assertSalesTargetInScope`（写比读严：涉及的仓与门店必须**都**在范围内）。
// ---------------------------------------------------------------------------

const DOC_KINDS = {
  order: { table: 'sales_orders', notFound: '销售订单不存在' },
  delivery: { table: 'sales_deliveries', notFound: '发货单不存在' },
  return: { table: 'sales_returns', notFound: '退货单不存在' }
}

function scopeIds(orgScope) {
  if (!orgScope || orgScope.scope === 'all') return { all: true, ids: [] }
  const ids = Array.isArray(orgScope.orgIds) ? orgScope.orgIds.map(Number).filter(Number.isFinite) : []
  if (orgScope.scope === 'dealer' || orgScope.scope === 'none' || !ids.length) return { all: false, ids: [] }
  return { all: false, ids }
}

/**
 * 把组织范围翻成销售单据查询的 SQL 谓词（无前导 AND）。`kind`：`order` | `delivery` | `return`；
 * `alias` 是该单据的表别名。返回 `{ sql, params, empty }`。
 */
export function salesScopeSql(orgScope, kind = 'order', alias = '') {
  const { all, ids } = scopeIds(orgScope)
  if (all) return { sql: '1=1', params: [], empty: false }
  if (!ids.length) return { sql: '1=0', params: [], empty: true }
  const col = (a, c) => (a ? `${a}.${c}` : c)
  const ph = ids.map(() => '?').join(',')
  const byParty = (a) =>
    `((SELECT org_id FROM warehouses WHERE id=${col(a, 'warehouse_id')}) IN (${ph}) OR (SELECT org_id FROM stores WHERE id=${col(a, 'store_id')}) IN (${ph}))`
  const viaOrder = `EXISTS (SELECT 1 FROM sales_orders sco WHERE sco.id=${col(alias, 'order_id')} AND ${byParty('sco')})`
  if (kind === 'delivery') return { sql: viaOrder, params: [...ids, ...ids], empty: false }
  if (kind === 'return') {
    return {
      sql: `(CASE WHEN ${col(alias, 'order_id')} IS NOT NULL THEN ${viaOrder} ELSE ${byParty(alias)} END)`,
      params: [...ids, ...ids, ...ids, ...ids],
      empty: false
    }
  }
  return { sql: byParty(alias), params: [...ids, ...ids], empty: false }
}

/** 单据是否在范围内；返回该行。范围外与不存在同形（404 + 同一句话）。 */
export function assertSalesDocInScope(db, kind, id, orgScope) {
  const def = DOC_KINDS[kind]
  if (!def) throw new SalesOrderError('BAD_DOC_KIND', `不支持的单据类型 ${kind}`, 400)
  const scope = salesScopeSql(orgScope, kind, 't')
  const row = Number.isFinite(Number(id))
    ? db.prepare(`SELECT t.* FROM ${def.table} t WHERE t.id=? AND ${scope.sql}`).get(Number(id), ...scope.params)
    : null
  if (!row) throw new SalesOrderError('DOC_NOT_FOUND', def.notFound, 404)
  return row
}

/**
 * 写路径的目标校验：出货 / 入库仓与门店的归属组织必须都在范围内（NULL 对受限范围不通过）。
 * 全局范围恒通过。不通过 ⇒ 403。
 */
export function assertSalesTargetInScope(db, { warehouseId = null, storeId = null } = {}, orgScope) {
  const { all, ids } = scopeIds(orgScope)
  if (all) return
  const inScope = (table, id) => {
    if (!ids.length || !Number.isFinite(Number(id))) return false
    const ph = ids.map(() => '?').join(',')
    return !!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND org_id IN (${ph})`).get(Number(id), ...ids)
  }
  if (warehouseId != null && !inScope('warehouses', warehouseId)) {
    throw new SalesOrderError('TARGET_OUT_OF_SCOPE', '所选仓库不在您的组织数据范围内', 403)
  }
  if (storeId != null && !inScope('stores', storeId)) {
    throw new SalesOrderError('TARGET_OUT_OF_SCOPE', '所选门店不在您的组织数据范围内', 403)
  }
}

/** 该订单的授信账户（按往来对象解析，不猜） */
function creditAccountOf(db, order) {
  const sub = resolveSubject(db, { dealerId: order.dealer_id, storeId: order.store_id })
  if (!sub) return null
  return db
    .prepare('SELECT * FROM credit_accounts WHERE subject_type=? AND subject_id=?')
    .get(sub.subjectType, sub.subjectId)
}

/**
 * 作废销售订单（**唯一实现**）。
 *
 * 四件后果一起发生，缺一不可：
 *   ① 释放库存占用（按明细释放，**不重新拣选**）；
 *   ② 走内核流转（合法性与留痕由 `doc_actions` 定义）；
 *   ③ 释放授信（订单取消，占着的额度必须还回去，否则额度只减不增）；
 *   ④ `credit_hold` 投影随台账归零（投影的唯一写入者在 credit.js，见 ADR-0014）。
 *
 * `actor` 必须显式传入 —— MCP 等非 HTTP 入口没有 `req.user`。
 */
export function cancelOrder(db, { id, reason = null, actor = null, source = 'api' } = {}) {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(Number(id))
  if (!order) throw new SalesOrderError('ORDER_NOT_FOUND', '销售订单不存在', 404)
  if (['shipped', 'completed', 'cancelled'].includes(order.status)) {
    throw new SalesOrderError(
      'ORDER_NOT_CANCELLABLE',
      `当前状态「${order.status}」的订单不能作废（已发货/已完成/已作废）`,
      409,
      { status: order.status }
    )
  }
  const items = db.prepare('SELECT * FROM sales_order_items WHERE order_id=?').all(order.id)

  const tx = db.transaction(() => {
    // ① 释放占用：按明细释放，不重新拣选
    //    （"再拣一次"很可能拣到别的批次 ⇒ 本单预留没释放、别人的预留被放掉）
    if (order.status === 'confirmed') {
      for (const it of items) {
        releaseForDoc(db, {
          sourceDocType: 'SO',
          sourceDocId: order.id,
          warehouseId: order.warehouse_id,
          skuId: it.sku_id,
          needQty: it.qty
        })
      }
    }

    // ② 内核流转（合法性由 doc_actions 定义；actor 显式传入）
    advanceStatus(db, null, {
      docType: 'SO',
      id: order.id,
      action: 'cancel',
      set: { updated_at: nowText() },
      remark: reason || '取消订单',
      source,
      actor
    })

    // ③④ 释放授信。`credit_hold` 是台账的投影（ADR-0014）：release 写台账时自动归零；
    //     没有信用账户（投影是旧数据残留）时走同一个投影函数重算，不另写 UPDATE。
    let creditReleased = 0
    if (Number(order.credit_hold || 0) > 0) {
      const acc = creditAccountOf(db, order)
      if (acc) {
        creditRelease(db, {
          account: acc.id,
          sourceType: 'SO',
          sourceId: order.id,
          docNo: order.doc_no,
          operator: actor,
          remark: '订单取消，释放授信'
        })
        creditReleased = Number(order.credit_hold || 0)
      }
      projectOrderHold(db, { sourceType: 'SO', sourceId: order.id })
    }

    return {
      order: db.prepare('SELECT * FROM sales_orders WHERE id=?').get(order.id),
      from_status: order.status,
      released_credit: creditReleased
    }
  })

  return tx()
}

export default { SalesOrderError, cancelOrder, salesScopeSql, assertSalesDocInScope, assertSalesTargetInScope }
