/**
 * ============================================================================
 * 文件标识：scripts/test-qc.mjs ｜ 测试：采购质检（模块 07 · 到货单与质检单拆分）断言测试
 * ============================================================================
 * 【职责】测试：采购质检（模块 07 · 到货单与质检单拆分）断言测试
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 采购质检（模块 07 · 到货单与质检单拆分）断言测试
// 用法：node scripts/test-qc.mjs [cosmetic|food|apparel]
//
// 测的不是「接口通不通」，而是把「两张单为什么必须分开」这件事钉死在断言里：
//   ① 事实与判断分家：到货单（GR）记数量，质检单（INS）记结论 ——
//      **凡是已质检/已关闭的到货单，背后必须有一张非取消的质检单**。
//      这条不成立就意味着「状态说检过了，但查不到谁检的、怎么判的」。
//   ② 三数闭合：合格 + 让步 + 判退 = 到货数。不闭合的货既不是收下的也不是退掉的，
//      它会凭空消失，而账上不会报警 —— 所以必须在写库前拦住。
//   ③ 判退必须有后果：生成采购退货单 + 反向出库。没有后果的判退只是一张纸，
//      劣品还躺在正品库存里，判退率也只是个数字。
//   ④ 结论由数字推导，不让人手选 —— 手选意味着「结论说全部合格、数字说退了 10 件」。
//   ⑤ 一票一单：同一张到货单不允许两张有效质检单（否则「这批货判了没有」有两个答案）。
//   ⑥ 草稿不算「检过了」：提交失败会留下草稿（多为判退时库存不足），
//      如果按「有质检单就算检过」来算，这张到货单会从待质检队列里彻底消失。
//
// 夹具口径：需要改数据的用例（T4 / T6 / T7 / T8）**自建到货单并自清**，
// 不去消耗种子数据留给质检岗的那张待质检队列 —— 否则每跑一次回归就永久少一张，
// 跑到第十几次「待质检队列」就空了，而失败会表现为莫名其妙的「没有可用夹具」。
import { runWithIndustry, getDb, INDUSTRIES } from '../server/db/index.js'
import { seedProcurement } from '../server/db/procure-seed.js'
import { applyStockIn, applyStockOut } from '../server/lib/stock.js'
import { applyTransition, getMachine } from '../server/lib/docflow.js'
import {
  RESULT_LABEL, createInspection, getInspection, listInspections, submitInspection,
  transitionInspection, pendingReceipts, getReceiptForInspect, inspectionOverview
} from '../server/lib/qc.js'

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
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const num = (v) => Number(v) || 0
const today = () => new Date().toISOString().slice(0, 10)

/** 某仓某 SKU 的现存总量（不区分批次：判退可能跨批次拣选） */
const stockOf = (db, warehouseId, skuId) =>
  round2(
    num(
      db
        .prepare('SELECT COALESCE(SUM(qty_on_hand),0) v FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?')
        .get(warehouseId, skuId).v
    )
  )

/**
 * 自建一张「已收货」的到货单（含库存），供需要改数据的用例使用。
 * 走的是与 POST /api/purchase/orders/:id/receive 同一套动作：插单 → 入库 → 内核 confirm。
 * 库里现有的到货单不能借用：质检一旦提交就把 GR 推到 inspected，
 * 而状态机没有 inspected → received 的回头边，借一次就永久少一张。
 */
function makeReceipt(db, actor, { qty = 100, price = 50 } = {}) {
  const wh = db.prepare("SELECT * FROM warehouses WHERE type IN ('central','region','kitchen') ORDER BY id LIMIT 1").get()
    || db.prepare('SELECT * FROM warehouses ORDER BY id LIMIT 1').get()
  const sku = db
    .prepare("SELECT id, sku_code FROM product_skus WHERE status IS NULL OR status='active' ORDER BY id LIMIT 1")
    .get()
  const sup = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get()
  const date = today()
  const stamp = `${Date.now()}`.slice(-9)
  const docNo = `TESTQC${stamp}`
  const batchNo = `BQC${stamp}`
  const info = db
    .prepare(
      `INSERT INTO purchase_receipts (doc_no,order_id,supplier_id,warehouse_id,receipt_date,status,total_qty,total_amount,inspector,remark,created_by)
       VALUES (?,NULL,?,?,?,'draft',?,?,NULL,?,NULL)`
    )
    .run(docNo, sup.id, wh.id, date, qty, round2(qty * price), '自动化测试夹具')
  const rid = info.lastInsertRowid
  db.prepare(
    'INSERT INTO purchase_receipt_items (receipt_id,sku_id,batch_no,produce_date,expire_date,qty,price,amount) VALUES (?,?,?,?,?,?,?,?)'
  ).run(rid, sku.id, batchNo, null, null, qty, price, round2(qty * price))
  applyStockIn(db, {
    bizDate: date, docType: 'PUR_IN', docNo, docId: rid,
    warehouseId: wh.id, skuId: sku.id, batchNo, qty, unitCost: price,
    remark: '质检测试夹具', supplierId: sup.id
  })
  applyTransition({ db, docType: 'GR', id: rid, action: 'confirm', actor, remark: '质检测试夹具', source: 'api' })
  return { rid, docNo, warehouseId: wh.id, skuId: sku.id, batchNo, qty, price }
}

/** 拆掉夹具：先把它的库存影响与单据全部退回，再删记录（含质检判退产生的退货单） */
function dropReceipt(db, fx) {
  const insIds = db.prepare('SELECT id FROM purchase_inspections WHERE receipt_id=?').all(fx.rid).map((r) => r.id)
  for (const insId of insIds) {
    const retIds = db.prepare('SELECT return_id FROM purchase_inspections WHERE id=? AND return_id IS NOT NULL').all(insId).map((r) => r.return_id)
    for (const retId of retIds) {
      // 判退已经把货出掉了，先按退货行的数量与批次把货收回来
      for (const it of db.prepare('SELECT * FROM purchase_return_items WHERE return_id=?').all(retId)) {
        if (!(num(it.qty) > 0)) continue
        try {
          applyStockIn(db, {
            bizDate: today(), docType: 'PUR_RT_REV', docNo: `REV${retId}`,
            warehouseId: fx.warehouseId, skuId: it.sku_id, batchNo: it.batch_no || '',
            qty: num(it.qty), unitCost: num(it.price), remark: '测试夹具回滚判退'
          })
        } catch { /* 收不回来就只删单据，不影响断言 */ }
      }
      db.prepare('DELETE FROM purchase_return_items WHERE return_id=?').run(retId)
      // 退货单的留痕也要一起删：留痕按 (doc_type, doc_id) 指主表，主表删了留痕就成了孤儿，
      // 而且下一张退货单会复用这个 id 把旧留痕「认领」走 —— 时间线凭空多出别人的历史
      db.prepare("DELETE FROM doc_events WHERE doc_type='PRT' AND doc_id=?").run(retId)
      db.prepare('DELETE FROM purchase_returns WHERE id=?').run(retId)
    }
  }
  // 再退掉收货入库的那批
  try {
    applyStockOut(db, {
      warehouseId: fx.warehouseId, skuId: fx.skuId, batchNo: fx.batchNo, qty: fx.qty,
      docType: 'PUR_IN_REV', docNo: fx.docNo, remark: '测试夹具回滚收货'
    })
  } catch { /* 已被其它用例消耗则忽略 */ }
  if (insIds.length) {
    const ph = insIds.map(() => '?').join(',')
    db.prepare(`DELETE FROM doc_events WHERE doc_type='INS' AND doc_id IN (${ph})`).run(...insIds)
    db.prepare(`DELETE FROM purchase_inspection_items WHERE inspection_id IN (${ph})`).run(...insIds)
    db.prepare(`DELETE FROM purchase_inspections WHERE id IN (${ph})`).run(...insIds)
  }
  db.prepare("DELETE FROM doc_events WHERE doc_type='GR' AND doc_id=?").run(fx.rid)
  db.prepare('DELETE FROM purchase_receipt_items WHERE receipt_id=?').run(fx.rid)
  db.prepare('DELETE FROM purchase_receipts WHERE id=?').run(fx.rid)
}

await runWithIndustry(industry, () => {
  const db = getDb()
  const actor = { id: null, name: 'tester' }

  seedProcurement(db, { industry, silent: true })

  console.log(`\n采购质检测试 · 行业=${industry}（${INDUSTRIES[industry].label}）`)
  console.log('='.repeat(64))

  // =========================================================================
  section('T1 单据定义：质检单在内核里真的存在')
  // =========================================================================
  {
    const t = db.prepare("SELECT * FROM doc_types WHERE code='INS'").get()
    ok(!!t, `质检单（INS）已注册为单据类型${t ? `，表 ${t.table_name}` : ''}`)
    ok(t && t.module === 'purchase', '质检单归在采购模块下')
    const states = db.prepare('SELECT code, kind, is_initial, is_final FROM doc_states WHERE doc_type=? ORDER BY sort_order').all('INS')
    ok(states.length === 4, `INS 有 4 个状态（实测 ${states.length}）`)
    ok(states.filter((s) => s.is_initial).length === 1, 'INS 恰好一个初始状态（draft）')
    const kinds = new Set(states.map((s) => s.kind))
    ok([...kinds].every((k) => ['draft', 'active', 'done', 'void'].includes(k)),
      `INS 状态 kind 都在四值之内（${[...kinds].join('/')}）`)
    const rows = db.prepare('SELECT action, from_state, to_state FROM doc_actions WHERE doc_type=?').all('INS')
    ok(rows.length >= 3, `INS 流转边 ≥ 3（实测 ${rows.length}）`)
    ok(rows.some((r) => r.action === 'inspect' && r.from_state === 'draft' && r.to_state === 'inspected'),
      '提交质检结论的边存在（draft → inspected）')
  }

  // =========================================================================
  section('T2 主流程里质检压在到货之后、过账之前')
  // =========================================================================
  {
    const steps = db.prepare('SELECT seq, node_type, doc_type FROM biz_flow_steps WHERE flow_code=? ORDER BY seq').all('FLOW_PURCHASE')
    const i = steps.findIndex((s) => s.node_type === 'inspect')
    const r = steps.findIndex((s) => s.node_type === 'receipt')
    const v = steps.findIndex((s) => s.node_type === 'inbound')
    ok(i >= 0, '采购主流程里有「质量检验」环节')
    ok(i >= 0 && i > r && i < v, `质检排在到货（第 ${r + 1}）与过账（第 ${v + 1}）之间（第 ${i + 1} 环节）`)
    ok(steps[i]?.doc_type === 'INS', '该环节挂在质检单（INS）上，不是挂在到货单上')
  }

  // =========================================================================
  section('T3 权限点：不是一个「点了没反应」的功能')
  // =========================================================================
  {
    const rows = db.prepare("SELECT code, name FROM permissions WHERE code LIKE 'quality.inspect%'").all()
    ok(rows.length >= 3, `质检权限点 ≥ 3（实测 ${rows.length}）`)
    ok(rows.every((r) => r.name && r.name !== r.code), '权限点都有中文名，不是裸露 code')
    const granted = db.prepare("SELECT COUNT(*) c FROM role_permissions WHERE perm_code='quality.inspect'").get().c
    ok(granted >= 1, `至少一个角色获得质检权（${granted} 个）`)
  }

  // =========================================================================
  section('T4 三数闭合：不闭合的货会凭空消失，必须在写库前拦住')
  // =========================================================================
  const fx1 = makeReceipt(db, actor)     // 供 T4 / T6 / T7
  {
    const fill = getReceiptForInspect(db, fx1.rid)
    const firstQty = round2(num(fill.items[0].qty))
    const item = fill.items[0].id

    throws(
      () => createInspection(db, {
        receiptId: fx1.rid, actor,
        items: [{ receipt_item_id: item, qualified_qty: round2(firstQty - 1), concession_qty: 0, rejected_qty: 0 }]
      }),
      'QC_NOT_CLOSED',
      '合格数量少于到货数量被拒（凭空少了一件货）'
    )
    throws(
      () => createInspection(db, {
        receiptId: fx1.rid, actor,
        items: [{ receipt_item_id: item, qualified_qty: round2(firstQty + 1), concession_qty: 0, rejected_qty: 0 }]
      }),
      'QC_NOT_CLOSED',
      '合格数量多于到货数量被拒'
    )
    throws(
      () => createInspection(db, {
        receiptId: fx1.rid, actor,
        items: [{ receipt_item_id: item, qualified_qty: -1, concession_qty: 0, rejected_qty: round2(firstQty + 1) }]
      }),
      'QC_NEGATIVE_QTY',
      '负数数量被拒'
    )
    throws(
      () => createInspection(db, {
        receiptId: fx1.rid, actor,
        items: [{ receipt_item_id: item, qualified_qty: 1, concession_qty: 1, rejected_qty: 1 }]
      }),
      'QC_NOT_CLOSED',
      '三个数之和 ≠ 到货数被拒（即使每个数都是正的）'
    )
    const still = db.prepare('SELECT COUNT(*) c FROM purchase_inspections WHERE receipt_id=?').get(fx1.rid).c
    ok(still === 0, '以上四次非法建单全部没有落库（校验在写库之前）')
    ok(!!fx1.batchNo, `到货行带批次号（${fx1.batchNo}）`)
    // 未确认收货的到货单不能质检：货还没到就出结论，是「先签字后验货」
    const draftId = db
      .prepare("INSERT INTO purchase_receipts (doc_no,supplier_id,warehouse_id,receipt_date,status,total_qty,total_amount,remark) VALUES (?,?,?,?, 'draft',0,0,'未收货夹具')")
      .run(`TESTDR${Date.now()}`.slice(0, 24), db.prepare('SELECT supplier_id FROM purchase_receipts WHERE id=?').get(fx1.rid).supplier_id, fx1.warehouseId, today()).lastInsertRowid
    throws(() => createInspection(db, { receiptId: draftId, actor }), 'QC_RECEIPT_NOT_RECEIVED', '未确认收货的到货单不能质检')
    db.prepare('DELETE FROM purchase_receipts WHERE id=?').run(draftId)
    throws(() => createInspection(db, { receiptId: 99999999, actor }), 'QC_RECEIPT_NOT_FOUND', '不存在的到货单被拒')
  }

  // =========================================================================
  section('T5 结论由数字推导，不让人手选')
  // =========================================================================
  {
    ok(Object.keys(RESULT_LABEL).length === 5, `结论枚举 5 种（${Object.keys(RESULT_LABEL).join('/')}）`)
    const t = listInspections(db, { pageSize: 500 })
    const bad = t.rows.filter((r) => {
      const total = num(r.total_qty)
      const q = num(r.qualified_qty)
      const c = num(r.concession_qty)
      const j = num(r.rejected_qty)
      const expect =
        total <= 0 ? 'pending'
          : j >= total - 1e-6 ? 'rejected'
            : j > 0 ? 'partial_rejected'
              : c > 0 ? 'concession'
                : q >= total - 1e-6 ? 'qualified' : 'pending'
      return r.result !== expect
    })
    ok(bad.length === 0, `现有 ${t.total} 张质检单的结论与三数一致（不一致 ${bad.length} 张）`)

    // 「全部判退」这一档必须真的可达 —— 否则它只是枚举里的一个字符串
    const fxFull = makeReceipt(db, actor, { qty: 40, price: 30 })
    const insFull = createInspection(db, { receiptId: fxFull.rid, actor })
    const lineFull = getInspection(db, insFull.id).items[0]
    const outFull = submitInspection(db, {
      id: insFull.id,
      lines: [{ id: lineFull.id, qualified_qty: 0, concession_qty: 0, rejected_qty: 40, defect_code: 'quality', defect_reason: '整批性能不达标' }],
      actor
    })
    ok(outFull.result === 'rejected', `全部判退的结论确实可达（实测 ${outFull.result}）`)
    ok(outFull.return_created && round2(num(db.prepare('SELECT total_qty FROM purchase_returns WHERE id=?').get(outFull.return_id)?.total_qty)) === 40,
      '全部判退生成等量退货单（40 件）')
    ok(round2(num(db.prepare('SELECT qualified_qty FROM purchase_inspections WHERE id=?').get(insFull.id).qualified_qty)) === 0,
      '全部判退时合格数量为 0')
    dropReceipt(db, fxFull)
    ok(db.prepare('SELECT COUNT(*) c FROM purchase_receipts WHERE id=?').get(fxFull.rid).c === 0, '全部判退夹具已清理')
  }

  // =========================================================================
  section('T6 一票一单：同一张到货单不允许两张有效质检单')
  // =========================================================================
  let workInsId = null
  {
    const ins = createInspection(db, { receiptId: fx1.rid, actor, remark: '测试夹具' })
    ok(ins && ins.status === 'draft', `从到货单建出草稿（${ins.doc_no}）`)
    ok(ins.result === 'qualified', '默认全部合格（正常情况一次点击，异常情况才改数字）')
    ok(ins.result_label === RESULT_LABEL.qualified, `详情带结论中文名（${ins.result_label}）`)
    ok(ins.items.length === 1 && round2(num(ins.items[0].qty)) === fx1.qty,
      '质检行数量来自到货单（事实来源，不允许质检单自己编）')

    throws(() => createInspection(db, { receiptId: fx1.rid, actor }), 'QC_DUPLICATE', '同票重复建单被拒')

    // 取消之后可以重开：否则「取消一次就再也不能检第二批」
    transitionInspection(db, { id: ins.id, action: 'cancel', actor, remark: '作废重开' })
    const again = createInspection(db, { receiptId: fx1.rid, actor })
    ok(again.id !== ins.id, `作废旧单后可以重开（旧 ${ins.doc_no} 已删除 → 新 ${again.doc_no}）`)
    const cnt = db.prepare('SELECT COUNT(*) c FROM purchase_inspections WHERE receipt_id=?').get(fx1.rid).c
    ok(cnt === 1, `作废单被清理，同票只剩一条记录（实测 ${cnt}）`)

    // 作废单的**流转留痕必须跟着一起删**。
    // 这一条只有本测试能抓：doc_events 的行按 (doc_type, doc_id) 关联，如果删单不删留痕，
    // 新单很可能复用同一个自增 id，于是它「认领」了旧单的留痕 —— 详情时间线里凭空多出
    // 一条「取消」。此时**孤儿留痕检查是绿的**（id 指向一张存在的单），
    // 而错已经发生了。所以判据不能是「有没有孤儿」，只能是「新单的留痕是不是只有它自己的」。
    const ev = db
      .prepare("SELECT action, action_name, remark FROM doc_events WHERE doc_type='INS' AND doc_id=? ORDER BY id")
      .all(again.id)
    ok(
      ev.length === 0,
      `重开的新单不继承旧单的留痕（实测 ${ev.length} 条${ev.length ? '：' + ev.map((x) => x.action_name || x.action).join('、') : ''}）`
    )
    ok(
      db.prepare("SELECT COUNT(*) c FROM doc_events WHERE doc_type='INS' AND remark='作废重开'").get().c === 0,
      '作废动作的留痕已随单删除，不留悬挂记录'
    )
    workInsId = again.id
  }

  // =========================================================================
  section('T7 判退必须有后果：退货单 + 反向出库')
  // =========================================================================
  {
    // 注意：submitInspection 的 lines 是按**质检单行 id** 覆盖的（前端从
    // GET /inspections/:id 拿到行后用行 id 回传），不是到货单行 id ——
    // 传错 id 不会报错，只会「覆盖不上」，表现为「改了数字却没生效」。
    const ins = getInspection(db, workInsId)
    const line = ins.items[0]
    const totalQty = round2(num(line.qty))
    const rejectQty = 10
    const stockBefore = stockOf(db, fx1.warehouseId, fx1.skuId)

    const out = submitInspection(db, {
      id: workInsId,
      lines: [{
        id: line.id, qualified_qty: round2(totalQty - rejectQty), concession_qty: 0, rejected_qty: rejectQty,
        defect_code: 'spec', defect_reason: '测试判退'
      }],
      actor
    })

    ok(out.status === 'inspected', '质检单推进到已质检')
    ok(out.result === 'partial_rejected', `结论自动推导为「部分判退」（实测 ${out.result}）`)
    ok(!!out.return_created, `判退自动生成采购退货单（${out.return_created?.doc_no}）`)

    const ret = db.prepare('SELECT * FROM purchase_returns WHERE id=?').get(out.return_id)
    ok(!!ret && /^RT/.test(ret.doc_no), `退货单单号带 RT 前缀（${ret?.doc_no}）`)
    ok((ret?.reason || '').includes('质检判退'), `退货原因可追溯到质检单（${ret?.reason}）`)
    ok((ret?.reason || '').includes('测试判退'), '退货原因带上了不合格说明（索赔依据）')
    const retLines = db.prepare('SELECT * FROM purchase_return_items WHERE return_id=?').all(out.return_id)
    ok(retLines.length > 0, `退货单有明细行（${retLines.length} 行）`)
    ok(Math.abs(round2(retLines.reduce((s, x) => s + num(x.qty), 0)) - rejectQty) < 0.01,
      `退货数量 = 判退数量（${rejectQty}）`)
    ok(round2(num(ret?.total_qty)) === rejectQty, `退货单合计数量 = ${rejectQty}`)

    const stockAfter = stockOf(db, fx1.warehouseId, fx1.skuId)
    ok(Math.abs(round2(stockBefore - stockAfter) - rejectQty) < 0.01,
      `判退的货真的退出了库存（${stockBefore} → ${stockAfter}，差 ${round2(stockBefore - stockAfter)}）`)

    const gr = db.prepare('SELECT status FROM purchase_receipts WHERE id=?').get(fx1.rid)
    ok(gr.status === 'inspected', `到货单联动到「已质检」（实测 ${gr.status}）`)
    ok(Math.abs(num(retLines[0].price) - fx1.price) < 0.01,
      `退货单价取到货票面价（票面 ${fx1.price}，退货 ${num(retLines[0].price)}）`)

    // 表头汇总与明细一致，且留痕齐全
    const detail = getInspection(db, workInsId)
    ok(round2(num(detail.rejected_qty)) === rejectQty, `表头判退数量 = ${rejectQty}`)
    ok(detail.events.length >= 1 && detail.events.some((e) => e.action === 'inspect'),
      `质检单有流转留痕（${detail.events.map((e) => e.action).join('/')}）`)
    ok((detail.return_no || '') === ret.doc_no, '质检单回写退货单号，双向可追')
  }

  // =========================================================================
  section('T8 判退失败不留半成品，草稿不算「检过了」')
  // =========================================================================
  {
    const fx2 = makeReceipt(db, actor, { qty: 60, price: 20 })
    const ins = createInspection(db, { receiptId: fx2.rid, actor })
    const line = getInspection(db, ins.id).items[0]   // 用**质检行 id**（见 T7 的说明）
    // 要验的是「判退要出库」这道闸门，所以得让库存**必然不够**，而不能靠碰运气。
    // 做法：把质检行数量改成一个不可能被任何库存覆盖的值（连合格数一起改，保持三数闭合）。
    // 说明：正常流程下这个数量来自到货单（事实），改不出来 ——
    // 这里是在测「万一数据异常，闸门还在不在」，属于纵深防御，不是可达路径。
    const huge = round2(num(line.qty) + 999999)
    db.prepare('UPDATE purchase_inspection_items SET qty=?, qualified_qty=? WHERE id=?').run(huge, huge, line.id)
    const check = getInspection(db, ins.id).items[0]
    ok(round2(num(check.qualified_qty) + num(check.concession_qty) + num(check.rejected_qty)) === round2(num(check.qty)),
      `夹具自身仍满足三数闭合（到货 ${huge} = 合格 ${check.qualified_qty}）—— 失败原因只能是库存`)

    throws(
      () => submitInspection(db, {
        id: ins.id,
        lines: [{ id: line.id, qualified_qty: 0, concession_qty: 0, rejected_qty: huge, defect_code: 'other', defect_reason: '测试：判退量超过库存' }],
        actor
      }),
      'INSUFFICIENT_STOCK',
      '判退量超过库存时整单失败（判退不能只改结论、不退货）'
    )
    const after = getInspection(db, ins.id)
    ok(after.status === 'draft', `失败后质检单仍是草稿，不会被留成「已质检」（实测 ${after.status}）`)
    ok(!after.return_id, '失败后没有生成半截退货单')
    const gr = db.prepare('SELECT status FROM purchase_receipts WHERE id=?').get(fx2.rid)
    ok(gr.status === 'received', `到货单没有被动过（仍在「已收货」，实测 ${gr.status}）`)

    // 关键：这张带草稿的到货单必须仍在待质检队列里，并且把草稿号带出来。
    // 如果队列口径写成「有质检单就算检过」，它会从这里消失，且永远没人再处理它。
    const q = pendingReceipts(db, { limit: 500 }).find((p) => p.id === fx2.rid)
    ok(!!q, '带草稿的到货单仍在待质检队列里（没被当成「已检过」）')
    ok(q && q.draft_id === ins.id, `队列带出草稿 id（${q?.draft_id}）与单号（${q?.draft_no}）`)
    const ov = inspectionOverview(db)
    ok(ov.draft_ready >= 1, `概览单列「已建草稿待提交」（${ov.draft_ready} 张）`)
    ok(ov.waiting_receipts >= 1, `概览的待质检到货单数把草稿算进去（${ov.waiting_receipts}）`)
    const fill2 = getReceiptForInspect(db, fx2.rid)
    ok(fill2.inspection && fill2.inspection.id === ins.id,
      '装填接口把已有草稿一并返回（前端据此改数字，而不是再建一张）')

    transitionInspection(db, { id: ins.id, action: 'cancel', actor, remark: '测试清理' })
    ok(getInspection(db, ins.id).status === 'cancelled', '草稿可作废（作废后不再占用这张到货单）')
    ok(!pendingReceipts(db, { limit: 500 }).find((p) => p.id === fx2.rid)?.draft_id,
      '作废后队列不再带草稿号（回到「待建单」状态）')
    dropReceipt(db, fx2)
  }

  // =========================================================================
  section('T9 让步接收：不影响入库数量，但必须留痕')
  // =========================================================================
  {
    const t = listInspections(db, { result: 'concession', pageSize: 300 })
    ok(t.total >= 1, `库里有让步接收样本（${t.total} 张）`)
    const bad = t.rows.filter((r) => !(num(r.concession_qty) > 0 && num(r.rejected_qty) === 0))
    ok(bad.length === 0, `让步接收单都满足「让步 > 0 且判退 = 0」（异常 ${bad.length} 张）`)
    const leak = db
      .prepare(
        `SELECT COUNT(*) c FROM purchase_inspections i
          WHERE i.concession_qty > 0 AND NOT EXISTS (
            SELECT 1 FROM purchase_inspection_items x WHERE x.inspection_id=i.id AND x.defect_code IS NOT NULL)`
      )
      .get().c
    ok(leak === 0, `让步接收都记了不合格原因码（漏记 ${leak} 张）—— 不记原因的话索赔依据就没了`)
  }

  // =========================================================================
  section('T10 表头与明细必须对得上（账实一致）')
  // =========================================================================
  {
    const bad = db
      .prepare(
        `SELECT i.id, i.total_qty, i.qualified_qty, i.concession_qty, i.rejected_qty,
                (SELECT COALESCE(SUM(x.qty),0) FROM purchase_inspection_items x WHERE x.inspection_id=i.id) s_qty,
                (SELECT COALESCE(SUM(x.qualified_qty),0) FROM purchase_inspection_items x WHERE x.inspection_id=i.id) s_q,
                (SELECT COALESCE(SUM(x.concession_qty),0) FROM purchase_inspection_items x WHERE x.inspection_id=i.id) s_c,
                (SELECT COALESCE(SUM(x.rejected_qty),0) FROM purchase_inspection_items x WHERE x.inspection_id=i.id) s_j
           FROM purchase_inspections i`
      )
      .all()
      .filter((r) => {
        const eq = (a, b) => Math.abs(num(a) - num(b)) < 0.01
        return !(eq(r.total_qty, r.s_qty) && eq(r.qualified_qty, r.s_q) && eq(r.concession_qty, r.s_c) && eq(r.rejected_qty, r.s_j))
      })
    ok(bad.length === 0, `全部质检单的表头 = 明细合计（不一致 ${bad.length} 张）`)

    const notClosed = db
      .prepare('SELECT COUNT(*) c FROM purchase_inspection_items WHERE ABS(qualified_qty + concession_qty + rejected_qty - qty) > 0.005')
      .get().c
    ok(notClosed === 0, `全部质检行三数闭合（不闭合 ${notClosed} 行）`)

    const noLines = db
      .prepare('SELECT COUNT(*) c FROM purchase_inspections i WHERE NOT EXISTS (SELECT 1 FROM purchase_inspection_items x WHERE x.inspection_id=i.id)')
      .get().c
    ok(noLines === 0, `没有空头质检单（无明细 ${noLines} 张）`)
  }

  // =========================================================================
  section('T11 内核一致性：状态说检过了，就必须查得到质检单')
  // =========================================================================
  {
    const noIns = db
      .prepare(
        `SELECT COUNT(*) c FROM purchase_receipts rc
          WHERE rc.status IN ('inspected','closed')
            AND NOT EXISTS (SELECT 1 FROM purchase_inspections i
                             WHERE i.receipt_id=rc.id AND i.status NOT IN ('cancelled','draft'))`
      )
      .get().c
    ok(noIns === 0, `已质检/已关闭的到货单都有非取消质检单（缺 ${noIns} 张）`)

    const stuck = db
      .prepare(
        `SELECT COUNT(*) c FROM purchase_receipts rc
          WHERE rc.status='received'
            AND EXISTS (SELECT 1 FROM purchase_inspections i
                         WHERE i.receipt_id=rc.id AND i.status NOT IN ('cancelled','draft'))`
      )
      .get().c
    ok(stuck === 0, `没有「已出结论却停在已收货」的到货单（${stuck} 张）`)

    const orphan = db
      .prepare('SELECT COUNT(*) c FROM purchase_inspections WHERE receipt_id NOT IN (SELECT id FROM purchase_receipts)')
      .get().c
    ok(orphan === 0, `没有指向不存在到货单的孤儿质检单（${orphan} 张）`)

    const noEvent = db
      .prepare(
        `SELECT COUNT(*) c FROM purchase_inspections i
          WHERE i.status <> 'draft'
            AND NOT EXISTS (SELECT 1 FROM doc_events e WHERE e.doc_type='INS' AND e.doc_id=i.id)`
      )
      .get().c
    ok(noEvent === 0, `已出结论的质检单都有流转留痕（缺留痕 ${noEvent} 张）`)

    const grClosed = db
      .prepare(
        `SELECT COUNT(*) c FROM purchase_receipts rc
          WHERE rc.status='closed'
            AND NOT EXISTS (SELECT 1 FROM doc_events e WHERE e.doc_type='GR' AND e.doc_id=rc.id AND e.action='close')`
      )
      .get().c
    ok(grClosed === 0, `已关闭到货单都有 close 留痕（缺 ${grClosed} 张）`)
  }

  // =========================================================================
  section('T12 判退率按数量算，且分母不是 0')
  // =========================================================================
  {
    const ov = inspectionOverview(db)
    for (const k of ['total', 'pending', 'inspected', 'waiting_receipts', 'rejected_qty', 'rejected_amount', 'concession_qty', 'returns_created', 'reject_rate']) {
      ok(ov[k] !== undefined, `概览含字段 ${k}（${ov[k]}）`)
    }
    const t = db.prepare('SELECT COALESCE(SUM(total_qty),0) a, COALESCE(SUM(rejected_qty),0) b FROM purchase_inspections').get()
    const expect = num(t.a) > 0 ? round2((num(t.b) / num(t.a)) * 100) : 0
    ok(Math.abs(num(ov.reject_rate) - expect) < 0.02, `判退率 = 判退数 / 到货数（${ov.reject_rate}%，手算 ${expect}%）`)
    ok(ov.rejected_amount > 0, `判退金额 > 0（¥${ov.rejected_amount}）—— 没有金额的判退指标看不出损失`)
    const retCnt = db.prepare("SELECT COUNT(*) c FROM purchase_returns WHERE reason LIKE '质检判退%'").get().c
    ok(ov.returns_created === retCnt, `概览的退货单数与库中一致（${ov.returns_created} / ${retCnt}）`)
    const amt = db
      .prepare(
        `SELECT COALESCE(SUM(ri.qty * ri.price),0) v FROM purchase_return_items ri
           JOIN purchase_returns r ON r.id=ri.return_id WHERE r.reason LIKE '质检判退%'`
      )
      .get().v
    ok(Math.abs(num(ov.rejected_amount) - round2(num(amt))) < 0.02, `判退金额与退货明细合计一致（¥${round2(num(amt))}）`)
  }

  // =========================================================================
  section('T13 内核不接受非法流转（质检不能凭空跳到终态）')
  // =========================================================================
  {
    const ins = db.prepare("SELECT id FROM purchase_inspections WHERE status='inspected' LIMIT 1").get()
    if (ins) {
      throws(
        () => applyTransition({ db, docType: 'INS', id: ins.id, action: 'inspect', actor, source: 'api' }),
        'TRANSITION_NOT_ALLOWED',
        '已质检的单不能再「提交质检结论」'
      )
      throws(
        () => applyTransition({ db, docType: 'INS', id: 99999999, action: 'close', actor, source: 'api' }),
        'DOC_NOT_FOUND',
        '不存在的质检单不能流转'
      )
    } else {
      ok(false, '库里没有已质检的质检单，无法验证非法流转')
    }
    throws(
      () => applyTransition({ db, docType: 'NO_SUCH_TYPE', id: 1, action: 'x', actor, source: 'api' }),
      'DOC_TYPE_UNKNOWN',
      '未注册的单据类型被拒'
    )
    const m = getMachine(db, 'INS')
    ok(m.initial.length === 1 && m.finals.length >= 1, `INS 状态机可读出初始态与终态（${m.initial} / ${m.finals}）`)
  }

  // =========================================================================
  section('T14 夹具自清：回归不该消耗演示数据')
  // =========================================================================
  {
    dropReceipt(db, fx1)
    ok(db.prepare('SELECT COUNT(*) c FROM purchase_receipts WHERE id=?').get(fx1.rid).c === 0, '主夹具到货单已删除')
    ok(db.prepare('SELECT COUNT(*) c FROM purchase_inspections WHERE receipt_id=?').get(fx1.rid).c === 0, '主夹具质检单已删除')
    ok(db.prepare('SELECT COUNT(*) c FROM purchase_inspection_items WHERE inspection_id NOT IN (SELECT id FROM purchase_inspections)').get().c === 0,
      '没有悬挂的质检行（级联删除生效）')
    const leftover = db.prepare("SELECT COUNT(*) c FROM purchase_receipts WHERE doc_no LIKE 'TESTQC%' OR doc_no LIKE 'TESTDR%'").get().c
    ok(leftover === 0, `没有残留的测试到货单（${leftover} 张）`)
    const orphanRet = db
      .prepare("SELECT COUNT(*) c FROM purchase_returns r WHERE r.reason LIKE '质检判退%' AND NOT EXISTS (SELECT 1 FROM purchase_return_items x WHERE x.return_id=r.id)")
      .get().c
    ok(orphanRet === 0, `没有空头退货单（${orphanRet} 张）`)
  }

  console.log('\n' + '='.repeat(64))
  console.log(`结果：${pass} 通过 / ${fail} 失败 · 行业=${industry}`)
  if (fail) process.exitCode = 1
})
