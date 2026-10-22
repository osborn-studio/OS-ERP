/**
 * ============================================================================
 * 文件标识：server/db/ar-seed.js ｜ 应收与收款核销演示数据（模块 21）
 * ============================================================================
 * 【职责】应收与收款核销演示数据（模块 21）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

/**
 * 应收与收款核销演示数据（模块 21）
 *
 * 造数据的原则与报价/信用一致：**每一条数据都能讲一个故事**，
 * 而不是把表填满。造出来的东西必须能回答界面上的四个问题：
 *   ① 谁欠我钱（应收单，来源可追到订单）
 *   ② 逾期多久（故意造两笔逾期：一笔 12 天、一笔 78 天）
 *   ③ 钱抵了哪笔（收款单 + 核销明细，含一笔跨单分摊）
 *   ④ 作废会怎样（一张作废的收款单，金额回到未收）
 *
 * 依赖：经销商档案（credit_accounts 已有账期）、销售订单（来源单据）。
 */
import { requireDemoDatabase } from './runtime-policy.js'
import { ensureAr, createReceipt, confirmReceipt, voidReceipt, recalcArBySubject, applyPrepay, syncOcAr, prepayList } from '../lib/ar.js'
import { seedNow } from './seed-clock.js'

const dayOffset = (n) => {
  const d = new Date(seedNow())
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

export function seedAr(db, { silent = false } = {}) {
  requireDemoDatabase(db)
  const say = (m) => { if (!silent) console.log(m) }
  const actor = { id: null, name: '演示数据' }

  // 已经造过就不再造：seed 是幂等的，重复跑只会让单据编号越跑越多。
  // 注意这里只判 SO 来源 —— 订货中心（OC）的应收是在 seedOrderCenter 里
  // 走「确认收货」自动生成的，若一并计入，ar-seed 会被自己的上游挤成空跑，
  // 演示数据（逾期 / 跨单分摊 / 作废）就都不见了。
  if (db.prepare("SELECT COUNT(*) AS c FROM ar_documents WHERE source_type='SO'").get().c > 0) {
    recalcArBySubject(db)
    return { skipped: true }
  }

  const accounts = db
    .prepare(`SELECT * FROM credit_accounts WHERE subject_type='dealer' ORDER BY credit_limit DESC`)
    .all()
  if (!accounts.length) return { skipped: true }

  const orders = db
    .prepare(
      `SELECT o.*, d.name AS dealer_name
       FROM sales_orders o JOIN dealers d ON d.id=o.dealer_id
       WHERE o.dealer_id IS NOT NULL AND o.status IN ('confirmed','shipped','completed')
         AND COALESCE(o.receivable_amount,0) > 0
       ORDER BY o.id DESC LIMIT 12`
    )
    .all()

  const created = { ar: 0, receipts: 0, voided: 0 }

  // ① 由销售订单生成应收单：前 4 笔按账期正常到期，后 2 笔故意造逾期
  const ars = []
  orders.forEach((o, i) => {
    const acc = accounts.find((a) => a.subject_id === o.dealer_id) || accounts[0]
    const creditDays = acc?.credit_days || 30
    // 逾期场景：把业务日期往前推（超过账期），到期日自然落在过去
    const back = i >= orders.length - 2 ? creditDays + (i === orders.length - 2 ? 12 : 78) : 3 + i
    const ar = ensureAr(db, {
      subjectType: 'dealer',
      subjectId: o.dealer_id,
      subjectName: o.dealer_name,
      sourceType: 'SO',
      sourceId: o.id,
      sourceDocNo: o.doc_no,
      bizDate: dayOffset(-back),
      amount: o.receivable_amount,
      creditDays,
      remark: '由销售订单生成',
      actor
    })
    db.prepare('UPDATE sales_orders SET ar_id=?, ar_doc_no=? WHERE id=?').run(ar.id, ar.doc_no, o.id)
    ars.push(ar)
    created.ar++
  })

  // ② 一张收款单跨两笔应收（FIFO 自动摊）：演示「这笔钱抵了哪几笔」
  if (ars.length >= 2) {
    const first = ars[0]
    const rc = createReceipt(db, {
      subjectType: 'dealer',
      subjectId: first.subject_id,
      subjectName: first.subject_name,
      receiptDate: dayOffset(-2),
      method: 'transfer',
      amount: Number((first.amount * 1.6).toFixed(2)),
      serialNo: 'DEMO-TR-0001',
      remark: '一笔款抵两单（FIFO 分摊）',
      actor
    })
    confirmReceipt(db, { id: rc.id, actor })
    created.receipts++
  }

  // ③ 部分收款：只付一半，应收留在「部分收款」状态
  if (ars.length >= 3) {
    const ar = ars[2]
    const rc = createReceipt(db, {
      subjectType: 'dealer',
      subjectId: ar.subject_id,
      subjectName: ar.subject_name,
      receiptDate: dayOffset(-1),
      method: 'online',
      amount: Number((ar.amount * 0.5).toFixed(2)),
      serialNo: 'DEMO-ON-0002',
      remark: '部分回款',
      actor
    })
    confirmReceipt(db, { id: rc.id, actor })
    created.receipts++
  }

  // ④ 一张草稿收款单（核销只是计划，不计入已收）＋ 一张已作废收款单
  if (ars.length >= 4) {
    const ar = ars[3]
    createReceipt(db, {
      subjectType: 'dealer',
      subjectId: ar.subject_id,
      subjectName: ar.subject_name,
      receiptDate: dayOffset(0),
      method: 'bill',
      amount: Number((ar.amount * 0.3).toFixed(2)),
      serialNo: 'DEMO-BL-0003',
      remark: '票据待背书（草稿，尚未生效）',
      actor
    })
    created.receipts++

    const rc = createReceipt(db, {
      subjectType: 'dealer',
      subjectId: ar.subject_id,
      subjectName: ar.subject_name,
      receiptDate: dayOffset(-5),
      method: 'transfer',
      amount: Number((ar.amount * 0.2).toFixed(2)),
      serialNo: 'DEMO-TR-0004',
      remark: '收款流水有误，已作废',
      actor
    })
    confirmReceipt(db, { id: rc.id, actor })
    voidReceipt(db, { id: rc.id, actor, reason: '银行流水重复入账，作废重开' })
    created.voided++
  }

  // ⑤ 预收场景（第二阶段）：一笔款打多了，多出来的部分成为客户预存余额，
  //    再演示「预收转应收」把它抵到另一张未结应收上。
  //    这件事在真实业务里天天发生（客户凑整数付款 / 订货中心先打款后开单），
  //    以前系统里无处安放，钱一到就只剩一个「已收」数字。
  let prepayDemo = 0
  if (ars.length >= 6) {
    // Earlier receipts may have consumed this balance already.
    const target = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(ars[5].id)
    const open = Math.max(0, Number((Number(target.amount) - Number(target.allocated_amount)).toFixed(2)))
    const pay = Number((open + 5000).toFixed(2))
    const rc = createReceipt(db, {
      subjectType: 'dealer',
      subjectId: target.subject_id,
      subjectName: target.subject_name,
      receiptDate: dayOffset(-1),
      method: 'transfer',
      amount: pay,
      serialNo: 'DEMO-TR-0006',
      // **必须显式指定核销明细**，不能让收款单走 FIFO 自动分配：
      // 自动分配会把这多付的 5000 也摊到该客户**其它**未结应收上，
      // 于是这张收款单被核销干净、预收余额为 0，下一步 applyPrepay 直接抛 PREPAY_EMPTY，
      // 整库重建当场中断 —— 而且是否踩到取决于该客户当时欠了几张单，属于「时好时坏」的种子。
      // 只核销目标单的未结余额，多出来的部分才真实地留下来变成预收。
      allocations: open > 0 ? [{ ar_id: target.id, amount: open }] : [],
      remark: `客户凑整付款，多付 5000 转为预存`,
      actor
    })
    confirmReceipt(db, { id: rc.id, actor })
    created.receipts++

    // 找到这个客户另一张未结应收，用预收抵一部分（auto = 按到期日 FIFO）
    const other = db
      .prepare(
        `SELECT * FROM ar_documents
         WHERE subject_type='dealer' AND subject_id=? AND status IN ('open','partial') AND id<>?
         ORDER BY due_date, id LIMIT 1`
      )
      .get(target.subject_id, target.id)
    if (other) {
      const r = applyPrepay(db, { receiptId: rc.id, auto: true, actor })
      prepayDemo = r.applied
      created.prepay_applied = r.applied
    }
  }

  // ⑥ 订货中心并入兜底（第二阶段）：12A 的订货单在「确认收货」时已自动生成应收，
  //    这里补的是历史遗留与开关曾经关闭过的窗口期。幂等，可重复跑。
  const oc = syncOcAr(db, { actor, limit: 200 })
  created.oc_merged = oc.count

  recalcArBySubject(db)
  const prepay = prepayList(db)
  say(
    `[ar] 应收单 ${created.ar} 张 / 收款单 ${created.receipts} 张（作废 ${created.voided} 张）/ ` +
    `订货并入 ${oc.count} 张 / 预收转应收 ${prepayDemo} 元 / 现存预收 ${prepay.total} 元`
  )
  return created
}

export default seedAr
