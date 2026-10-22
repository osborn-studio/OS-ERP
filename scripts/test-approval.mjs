/**
 * ============================================================================
 * 文件标识：scripts/test-approval.mjs ｜ 测试：通用审批流（模块 22）断言测试
 * ============================================================================
 * 【职责】测试：通用审批流（模块 22）断言测试
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 通用审批流（模块 22）断言测试
// 用法：node scripts/test-approval.mjs [cosmetic|food|apparel]
//
// 测的不是「接口通不通」，而是审批引擎的六条硬口径：
//   ① 闸门只检查、不写库 —— 被拦时不能偷偷建实例（否则事务一回滚就丢）
//   ② 标记 ≠ 生效 —— 边标了 require_approval，没有启用中的模板就不该拦
//   ③ 按级次放行且只有当前级的人能审
//   ④ 最后一级通过才真正执行业务流转；审批通过但业务失败必须抛错，不能吞
//   ⑤ 驳回后单据状态**不变**（审批不篡改状态机）
//   ⑥ 提交/反复提交幂等，重复决策被拒
import { runWithIndustry, getDb, INDUSTRIES } from '../server/db/index.js'
import { seedProcurement } from '../server/db/procure-seed.js'
import { applyTransition, DocFlowError } from '../server/lib/docflow.js'
import {
  ApprovalError, approvalGate, matchTemplate, amountOf,
  submitApproval, getInstance, decideApproval, cancelApproval, canApproveStep,
  listInstances, pendingForMe, listTemplates, approvalOverview, approvalTodos
} from '../server/lib/approval.js'
import {
  createRequisition, transitionRequisition, convertRequisitionToOrder, upsertSupplierProduct,
  resolvePurchasePrice
} from '../server/lib/purchase.js'

const industry = process.argv[2] && INDUSTRIES[process.argv[2]] ? process.argv[2] : 'cosmetic'
let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) }
}
const section = (t) => console.log(`\n${t}`)
const throws = (fn, code, msg) => {
  try {
    fn()
    ok(false, `${msg}（未抛错）`)
  } catch (e) {
    const hit = !code || e.code === code
    ok(hit, hit ? `${msg} → ${e.code}` : `${msg}（期望 ${code}，实得 ${e.code}）`)
  }
}

await runWithIndustry(industry, () => {
  const db = getDb()
  const actor = { id: null, name: 'tester' }

  seedProcurement(db, { industry, silent: true })

  console.log(`\n审批流测试 · 行业=${industry}（${INDUSTRIES[industry].label}）`)
  console.log('='.repeat(64))

  // 清掉上一轮跑测留下的孤儿实例（单据已被 seed 重置删掉了，实例不该留）
  db.prepare("DELETE FROM approval_instances WHERE doc_type='PO' AND doc_id NOT IN (SELECT id FROM purchase_orders)").run()

  // ---- 夹具：三个真实用户（采购 / 财务 / 销售）+ 一个供应商 ----
  const uPurchase = db.prepare("SELECT id, name, role FROM users WHERE role='purchase' ORDER BY id LIMIT 1").get()
  const uFinance = db.prepare("SELECT id, name, role FROM users WHERE role='finance' ORDER BY id LIMIT 1").get()
  const uSales = db.prepare("SELECT id, name, role FROM users WHERE role='sales' ORDER BY id LIMIT 1").get()
  const mePurchase = { id: uPurchase.id, name: uPurchase.name }
  const meFinance = { id: uFinance.id, name: uFinance.name }
  const meSales = { id: uSales.id, name: uSales.name }

  const sup = db.prepare('SELECT * FROM suppliers ORDER BY id LIMIT 1').get()
  const wh = db.prepare("SELECT * FROM warehouses WHERE type IN ('central','region','kitchen') ORDER BY id LIMIT 1").get()
    || db.prepare('SELECT * FROM warehouses ORDER BY id LIMIT 1').get()
  const catalog = db
    .prepare('SELECT * FROM supplier_products WHERE supplier_id=? AND is_available=1 AND price>0 ORDER BY sku_id LIMIT 2')
    .all(sup.id)
  for (const c of catalog) {
    upsertSupplierProduct(db, { supplierId: sup.id, skuId: c.sku_id, patch: { min_order_qty: 0 }, operator: 'tester' })
  }

  /**
   * 造一张 submitted 状态的采购订单。
   * 走正规链路（请购 → 提交 → 审批 → 转单）而不是直接插表 ——
   * 一是复用真实字段口径，二是这些订单的 source_type='requisition'，
   * seed 重置时会连测试垃圾一起清掉，不污染演示数据。
   */
  const makeOrder = (qty) => {
    const req = createRequisition(db, {
      warehouseId: wh.id,
      supplierId: sup.id,
      reqDate: new Date().toISOString().slice(0, 10),
      applicantType: 'org',
      applicantName: '审批测试部门',
      department: '供应链中心',
      purpose: '审批流测试夹具',
      actor,
      lines: [{ sku_id: catalog[0].sku_id, qty, price: resolvePurchasePrice(db, { skuId: catalog[0].sku_id, supplierId: sup.id }).price }]
    })
    transitionRequisition(db, { id: req.id, action: 'submit', actor })
    transitionRequisition(db, { id: req.id, action: 'approve', actor })
    const out = convertRequisitionToOrder(db, { reqId: req.id, actor, remark: '审批测试转单' })
    applyTransition({ db, docType: 'PO', id: out.order_id, action: 'submit', actor })
    return db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(out.order_id)
  }

  // ---------------------------------------------------------------
  section('T1 模板与闸门标记（标记 ≠ 生效）')
  const tpls = listTemplates(db)
  ok(tpls.length >= 5, `审批模板已灌入（${tpls.length} 个）`)
  const tCancel = tpls.find((t) => t.code === 'APV-PO-CANCEL')
  ok(!!tCancel && Number(tCancel.enabled) === 1, '① 取消采购订单模板默认启用')
  ok(tCancel.steps.length === 1 && tCancel.steps[0].approver_text, `① 级次 1 且有可读审批人（${tCancel.steps[0]?.approver_text}）`)
  const tBig = tpls.find((t) => t.code === 'APV-PO-APPROVE-BIG')
  ok(!!tBig && Number(tBig.enabled) === 0, '① 大额二级审批模板默认停用（不阻塞既有链路）')
  const gatedEdges = db.prepare('SELECT COUNT(*) c FROM doc_actions WHERE require_approval=1').get().c
  ok(gatedEdges >= 8, `① 已标记需审批的边 ${gatedEdges} 条`)

  section('T2 闸门只检查、不写库')
  const po1 = makeOrder(5)
  ok(po1.status === 'submitted', `① 夹具订单已提交（${po1.doc_no} ¥${po1.total_amount}）`)
  const before = db.prepare('SELECT COUNT(*) c FROM approval_instances').get().c
  throws(
    () => applyTransition({ db, docType: 'PO', id: po1.id, action: 'cancel', actor }),
    'APPROVAL_PENDING',
    '① 取消被闸门拦下'
  )
  const after = db.prepare('SELECT COUNT(*) c FROM approval_instances').get().c
  ok(before === after, `① 被拦时**没有**偷偷建实例（拦前 ${before} → 拦后 ${after}）`)
  ok(db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(po1.id).status === 'submitted', '① 单据状态未被改动')

  section('T3 提交审批（实例唯一创建入口）')
  const inst1 = submitApproval(db, { docType: 'PO', docId: po1.id, docNo: po1.doc_no, action: 'cancel', actor: mePurchase })
  ok(inst1.status === 'pending', '①② 实例为待审批')
  ok(inst1.total_steps === 1 && inst1.current_step === 1, '① 级次 1/1')
  ok(inst1.current_approver === uPurchase.name || !!inst1.current_approver, `① 当前审批人已解析（${inst1.current_approver}）`)
  ok(inst1.records.length === 1 && inst1.records[0].decision === 'submit', '① 提交动作已留痕')
  ok(amountOf('PO', po1) > 0 && inst1.amount === amountOf('PO', po1), `① 金额取自单据主金额列（¥${inst1.amount}）`)

  const inst1b = submitApproval(db, { docType: 'PO', docId: po1.id, docNo: po1.doc_no, action: 'cancel', actor: mePurchase })
  ok(inst1b.id === inst1.id, '⑥ 重复提交复用同一实例（不产生两条）')

  section('T4 只有当前级指派的人能审')
  const step1 = db.prepare('SELECT * FROM approval_steps WHERE template_id=? AND step_no=1').get(inst1.template_id)
  ok(canApproveStep(db, step1, mePurchase), `③ 采购主管可审（rule=${step1.approver_type}:${step1.approver_value}）`)
  ok(!canApproveStep(db, step1, meSales), '③ 销售不可审')
  throws(
    () => decideApproval(db, { instanceId: inst1.id, decision: 'approve', actor: meSales }),
    'APPROVAL_NOT_ASSIGNED',
    '③ 越权审批被拒'
  )
  const stillPending = getInstance(db, inst1.id)
  ok(stillPending.status === 'pending' && stillPending.current_step === 1, '③ 越权被拒后实例未被改动')

  section('T5 通过 → 业务流转真正发生')
  const d1 = decideApproval(db, { instanceId: inst1.id, decision: 'approve', comment: '同意取消', actor: mePurchase })
  ok(d1.done === true, '④ 最后一级通过')
  ok(d1.instance.status === 'approved', '④ 实例转已通过')
  ok(d1.applied && d1.applied.to === 'cancelled', `④ 业务流转已执行（→ ${d1.applied?.to}）`)
  ok(db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(po1.id).status === 'cancelled', '④ 单据真的被取消了')
  const ev = db.prepare("SELECT COUNT(*) c FROM doc_events WHERE doc_type='PO' AND doc_id=? AND action LIKE '__approval%'").get(po1.id).c
  ok(ev >= 2, `④ 单据时间线有审批留痕（${ev} 条：提交 + 通过）`)

  throws(
    () => decideApproval(db, { instanceId: inst1.id, decision: 'approve', actor: mePurchase }),
    'APPROVAL_NOT_PENDING',
    '⑥ 重复决策被拒'
  )

  section('T6 驳回：单据状态不变（审批不篡改状态机）')
  const po2 = makeOrder(5)
  const inst2 = submitApproval(db, { docType: 'PO', docId: po2.id, docNo: po2.doc_no, action: 'cancel', actor: mePurchase })
  const d2 = decideApproval(db, { instanceId: inst2.id, decision: 'reject', comment: '供应商已备料，先别取消', actor: mePurchase })
  ok(d2.rejected === true && d2.instance.status === 'rejected', '⑤ 实例转已驳回')
  ok(db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(po2.id).status === 'submitted', '⑤ 单据状态**保持** submitted（不对应到虚假状态）')
  const rejectedDetail = getInstance(db, inst2.id)
  ok(rejectedDetail.records.some((r) => r.decision === 'reject' && r.comment), '⑤ 驳回意见已留痕')

  section('T7 撤回审批')
  const po3 = makeOrder(5)
  const inst3 = submitApproval(db, { docType: 'PO', docId: po3.id, docNo: po3.doc_no, action: 'cancel', actor: mePurchase })
  throws(
    () => cancelApproval(db, { instanceId: inst3.id, actor: meFinance }),
    'APPROVAL_CANCEL_FORBIDDEN',
    '⑥ 非提交人不能撤回'
  )
  const c3 = cancelApproval(db, { instanceId: inst3.id, actor: mePurchase, comment: '点错了' })
  ok(c3.status === 'canceled', '⑥ 提交人可撤回 → canceled')
  const g3 = approvalGate(db, { docType: 'PO', docId: po3.id, action: 'cancel', row: db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(po3.id) })
  ok(g3 && g3.pending === null, '⑥ 撤回后重新回到「需要审批但无待审实例」')

  section('T8 多级审批（大额二级）')
  db.prepare("UPDATE approval_templates SET enabled=1 WHERE code='APV-PO-APPROVE-BIG'").run()
  db.prepare("UPDATE approval_templates SET enabled=0 WHERE code='APV-PO-APPROVE-NORMAL'").run()
  const poBig = makeOrder(5)
  db.prepare('UPDATE purchase_orders SET total_amount=400000 WHERE id=?').run(poBig.id)
  const bigRow = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(poBig.id)
  const gBig = approvalGate(db, { docType: 'PO', docId: poBig.id, action: 'approve', row: bigRow })
  ok(gBig && gBig.template.code === 'APV-PO-APPROVE-BIG', `③ 金额 ¥${gBig?.amount} 命中大额模板（不是常规模板）`)
  throws(
    () => applyTransition({ db, docType: 'PO', id: poBig.id, action: 'approve', actor }),
    'APPROVAL_PENDING',
    '③ 大额订单审批被拦'
  )
  const instBig = submitApproval(db, { docType: 'PO', docId: poBig.id, docNo: bigRow.doc_no, action: 'approve', actor: mePurchase })
  ok(instBig.total_steps === 2, '③ 实例为两级')
  const s1 = decideApproval(db, { instanceId: instBig.id, decision: 'approve', actor: mePurchase })
  ok(s1.done === false && s1.nextStep === 2, `③ 一级通过后进入第二级（${s1.nextApprover}）`)
  ok(db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(poBig.id).status === 'submitted', '③ 未全部通过前业务不流转')
  ok(!canApproveStep(db, db.prepare('SELECT * FROM approval_steps WHERE template_id=? AND step_no=2').get(instBig.template_id), mePurchase), '③ 采购审不了财务那一级')
  const s2 = decideApproval(db, { instanceId: instBig.id, decision: 'approve', actor: meFinance })
  ok(s2.done === true, '③ 二级通过')
  ok(db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(poBig.id).status === 'approved', '③ 两级走完才真正审批通过')
  const instBigDetail = getInstance(db, instBig.id)
  ok(instBigDetail.records.filter((r) => r.decision === 'approve').length === 2, '③ 两级各有一条审批记录')

  section('T9 模板停用后不再拦截（② 标记 ≠ 生效）')
  db.prepare("UPDATE approval_templates SET enabled=0 WHERE code='APV-PO-APPROVE-BIG'").run()
  const poFree = makeOrder(5)
  db.prepare('UPDATE purchase_orders SET total_amount=400000 WHERE id=?').run(poFree.id)
  const rFree = applyTransition({ db, docType: 'PO', id: poFree.id, action: 'approve', actor })
  ok(rFree.to === 'approved', '② 没有启用中的模板时直接放行（行为与从前一致）')

  section('T10 概览与待办自洽')
  const ov = approvalOverview(db)
  const cnt = db.prepare("SELECT COUNT(*) c FROM approval_instances WHERE status='pending'").get().c
  ok(ov.pending === cnt, `⑥ 待审批数与库一致（${ov.pending}）`)
  ok(ov.total === ov.pending + ov.approved + ov.rejected + ov.canceled, '⑥ 状态分项合计 = 总数')
  const td = approvalTodos(db)
  ok(td.kind === 'approval_pending' && td.count === ov.pending, `⑥ 待办数与待审批数一致（${td.count}）`)
  const mine = pendingForMe(db, mePurchase)
  ok(mine.total >= ov.pending - 1, `③ 「待我审批」覆盖当前级指派给我的实例（${mine.total}）`)

  // 复位：把测试启用的模板关回去，避免影响别的测试
  db.prepare("UPDATE approval_templates SET enabled=0 WHERE code IN ('APV-PO-APPROVE-BIG','APV-PO-APPROVE-NORMAL')").run()

  console.log('\n' + '='.repeat(64))
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (fail > 0) process.exitCode = 1
})
