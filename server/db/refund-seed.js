/**
 * ============================================================================
 * 文件标识：server/db/refund-seed.js ｜ 退款单演示数据（批次 J）
 * ============================================================================
 * 【职责】退款单演示数据（批次 J）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 退款单演示数据（批次 J）
//
// ===========================================================================
// 要造的是一条**完整闭环**
// ===========================================================================
//   客户已付款的订单 → 退货（应收已收清 ⇒ 冲不动 ⇒ 登记待退款 `refund_due`）
//   → 登记退款单 → 确认退款（出账）→ （由 finance-seed）生成记账凭证。
//
// 全程走**服务函数**（`createSalesReturn` / `createRefund` / `confirmRefund` / `voidRefund`），
// 与界面点击完全同一条代码路径。手工 INSERT 最容易漏掉派生列
// （`refund_due`、`ar_offset_amount`），漏了之后演示数据与真实数据**形态不同**，
// 而界面上完全看不出来 —— 只是"这个数字怎么一直是 0"。
//
// ===========================================================================
// 为什么必须先"收清货款"才能退
// ===========================================================================
// `refund_due` 只在**应收不够冲**的时候才出现：
//   · 货没付款 → 退货冲减应收，refund_due = 0（不需要退钱，把账冲掉就行）；
//   · 钱已经收了 → 应收已结清、冲不动 → 退多少就是多少待退。
// 所以演示要覆盖"已退款"，就**必须先有一笔真实的收款**。
// 这笔收款走 `createReceipt + confirmReceipt`（不是手工改 `allocated_amount`）——
// 手工改出来的"已收"没有核销明细，"这笔钱抵了哪一笔"就答不出来，
// 而退款的前提恰恰是"这笔钱确实收过"。
//
// ===========================================================================
// 三种形态都要有
// ===========================================================================
// **已退款（confirmed）/ 已登记未退款（draft）/ 已作废（voided）**。
// 只造 confirmed 的话，"草稿不占用额度"与"作废必须写理由"这两条口径
// 在演示与截图里根本看不到 —— 而它们恰恰是本批最容易被后来者改坏的规则。
import { requireDemoDatabase } from './runtime-policy.js'
import { seedNow } from './seed-clock.js'
import { createReceipt, confirmReceipt } from '../lib/ar.js'
import { createSalesReturn } from '../lib/returns.js'
import * as RF from '../lib/refund.js'

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100

const dayOffset = (n) => {
  const d = new Date(seedNow())
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

export function seedRefund(db, { silent = false } = {}) {
  requireDemoDatabase(db)
  const say = (m) => {
    if (!silent) console.log(`  [refund-seed] ${m}`)
  }

  // 幂等：库里已有退款单就跳过（不会覆盖演示现场真点出来的单）
  if (db.prepare('SELECT COUNT(*) c FROM refunds').get().c > 0) return { skipped: true }

  const actor = { id: null, name: '演示数据' }
  const today = dayOffset(0)

  // 候选订单：有 SO 应收 + 有**有价的**已发货行 + 状态可退 + **未逾期** + 还没退过。
  // 三个刻意排除：
  //   · 逾期单不能挑 —— `ar-seed` 刻意造了逾期样本，把它们收掉会让"账龄"演示消失；
  //   · 已退过的单不能挑 —— `seed.js` 已造了 18 张退货单，再退一次会让
  //     "已退量 ≤ 已发量" 那条上限判据失去样本（都贴到上限，看起来像判据没生效）；
  //   · **`amount > 0` 的行不能少** —— 订单里有赠品 / 搭品行是**零价**的，
  //     "挑第一个已发货行"会挑到它，退货额算出来是 0，
  //     于是这一批退款单凭空少一张（**只在某些库上复现**：取决于行的排列）。
  //     这是本项目反复吃过的那类坑：**挑样本要挑对的，不要挑第一个**。
  // 排序按"未结余额升序"：优先挑**已经收清**的单，这样不必额外改动应收演示数据。
  const cands = db
    .prepare(
      `SELECT o.id AS order_id, o.doc_no AS order_no, o.dealer_id, o.warehouse_id, o.status,
              a.id AS ar_id, a.doc_no AS ar_no, a.amount AS ar_amount, a.allocated_amount AS ar_alloc, a.due_date,
              d.name AS dealer_name
         FROM sales_orders o
         JOIN ar_documents a ON a.source_type='SO' AND a.source_id=o.id AND a.status <> 'voided'
         LEFT JOIN dealers d ON d.id = o.dealer_id
        WHERE o.dealer_id IS NOT NULL
          AND o.status IN ('confirmed','shipped','completed')
          AND EXISTS (
                SELECT 1 FROM sales_order_items i
                 WHERE i.order_id=o.id AND i.shipped_qty > 0 AND i.amount > 0
              )
          AND (a.due_date IS NULL OR a.due_date >= ?)
          AND NOT EXISTS (SELECT 1 FROM sales_returns r WHERE r.order_id=o.id)
        ORDER BY (a.amount - a.allocated_amount) ASC, a.amount ASC, o.id`
    )
    .all(today)

  if (cands.length < 3) {
    say(`可退货候选不足（${cands.length} < 3），跳过`)
    return { skipped: true }
  }

  /** 把一张候选订单变成"有待退款额的已确认退货单" */
  const makeReturn = (c) => {
    // ① 应收没收清 → 先走一张**真实收款单**（客户付款）
    const ar = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(c.ar_id)
    const open = round2(Number(ar.amount) - Number(ar.allocated_amount))
    if (open > 0.005) {
      const rc = createReceipt(db, {
        subjectType: 'dealer',
        subjectId: c.dealer_id,
        subjectName: c.dealer_name,
        receiptDate: dayOffset(-2),
        method: 'transfer',
        amount: open,
        serialNo: `DEMO-RF-AR${c.ar_id}`,
        remark: '客户付清货款（退款演示前置）',
        allocations: [{ ar_id: c.ar_id, amount: open }],
        actor
      })
      confirmReceipt(db, { id: rc.id, actor })
    }

    // ② 退货：退「已发货量」的 40%（至少 1 件），**只挑有价的行**。
    //    只退一部分是刻意的 —— 全额退会让"还能退多少"这个量恒等于 0，
    //    而**可退余额**才是退款判据唯一需要盯住的东西。
    const line = db
      .prepare('SELECT * FROM sales_order_items WHERE order_id=? AND shipped_qty > 0 AND amount > 0 ORDER BY id LIMIT 1')
      .get(c.order_id)
    const qty = Math.max(1, Math.floor(Number(line.shipped_qty) * 0.4))
    const ret = createSalesReturn(db, null, {
      orderId: c.order_id,
      sourceType: 'order',
      items: [{ order_item_id: line.id, qty }],
      warehouseId: c.warehouse_id,
      returnDate: dayOffset(-1),
      reason: '终端滞销退回',
      channel: 'dealer',
      dealerId: c.dealer_id,
      actor
    })
    return ret
  }

  const created = { returns: 0, confirmed: 0, draft: 0, voided: 0, amount: 0 }

  // ---------- ① 已退款：全额退掉一张退货单的待退款 ----------
  const rA = makeReturn(cands[0])
  created.returns += 1
  if (Number(rA.refund_due) > 0.005) {
    const rf = RF.createRefund(db, {
      items: [{ return_id: rA.id, amount: rA.refund_due }],
      refundDate: dayOffset(0),
      method: 'bank',
      bankAccount: '演示账户 ****8823',
      serialNo: 'DEMO-RFD-0001',
      remark: '退货货款银行转账退回',
      actor
    })
    RF.confirmRefund(db, { id: rf.id, actor })
    created.confirmed += 1
    created.amount = round2(created.amount + rf.amount)
  } else {
    say(`退货单 ${rA.doc_no} 的待退款为 0（应收有余额），未生成退款单`)
  }

  // ---------- ② 已登记未退款：只退一半，剩下留在"可退余额"上 ----------
  const rB = makeReturn(cands[1])
  created.returns += 1
  if (Number(rB.refund_due) > 0.02) {
    const half = round2(Number(rB.refund_due) * 0.5)
    RF.createRefund(db, {
      items: [{ return_id: rB.id, amount: half }],
      refundDate: dayOffset(0),
      method: 'wechat',
      serialNo: 'DEMO-RFD-0002',
      remark: '微信原路退回（待财务复核后确认）',
      actor
    })
    created.draft += 1
  }

  // ---------- ③ 已作废：账号填错，登记后作废重开 ----------
  const rC = makeReturn(cands[2])
  created.returns += 1
  if (Number(rC.refund_due) > 0.005) {
    const rf = RF.createRefund(db, {
      items: [{ return_id: rC.id, amount: rC.refund_due }],
      refundDate: dayOffset(0),
      method: 'bank',
      bankAccount: '演示账户 ****0001',
      remark: '收款账号填错，待重开',
      actor
    })
    RF.voidRefund(db, { id: rf.id, reason: '收款账号与户名不符，作废后重新提交', actor })
    created.voided += 1
  }

  say(
    `退货单 ${created.returns} 张 · 退款单 已退款 ${created.confirmed} / 草稿 ${created.draft} / 已作废 ${created.voided}` +
      `（已出账 ¥${created.amount}）`
  )
  return { skipped: false, ...created }
}

export default { seedRefund }
