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

export default { SalesOrderError, cancelOrder }
