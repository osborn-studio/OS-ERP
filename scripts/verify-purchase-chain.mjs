/**
 * ============================================================================
 * 文件标识：scripts/verify-purchase-chain.mjs ｜ 数据校验：采购链缺陷守卫（P0-1/P0-2/P0-3/P0-4/G4/M15/M4/P1-5/P1-6/P1-10）
 * ============================================================================
 * 【职责】数据校验：采购链缺陷守卫（P0-1/P0-2/P0-3/P0-4/G4/M15/M4/P1-5/P1-6/P1-10）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 采购链缺陷守卫（P0-1/P0-2/P0-3/P0-4/G4/M15/M4/P1-5/P1-6/P1-10）
//
// 用法：node scripts/verify-purchase-chain.mjs [cosmetic|food|apparel]
//   （不设 GML_DATA_DIR 时会**自落**到 /tmp 并从仓库 data/ 只读备份一份；本脚本会建单/收货/退货）
//
// ---- 隔离落点（本项目硬纪律；形状与 scripts/test-kernel-*.mjs 的 requireIsolatedDataDir 一致）----
//   · 未设 `GML_DATA_DIR` ⇒ **自落**到 /tmp/gml-verify-<脚本名>，并从仓库 data/ **只读**备份三库进去。
//     为什么不是"未设 ⇒ exit 2"：`regress-all` **不设任何 env**，那种写法会把整轮回归自己拦死
//     （本项目真实踩过：三库全"退出码 2"）。本脚本今天不在跑批清单里（它是 `verify-` 而非 `test-`
//     前缀、opt-in），但只要哪天有人把它改回 `test-`，自落就是唯一不炸的形状。
//   · 指向仓库 data/ 或任何非 /tmp 路径 ⇒ 当场 exit 2 拒跑。
//   · ⚠️ **顺序要点（本文件原来就栽在这里）**：`server/db/index.js:11` 的
//     `DATA_DIR = process.env.GML_DATA_DIR || <仓库>/data` 是**模块加载时**求值一次的；而 ESM 的
//     静态 import 会在**模块体之前**全部求值完 —— 原来本文件静态 import 了 `db/index.js`，
//     还经 `lib/purchase.js → middleware/auth.js`、`lib/qc2.js` 两条链间接 import 它，
//     于是"自落 /tmp"其实**从没生效**（库落在仓库 data/，且 `getDb()` 会把写入落进去）。
//     所以下面所有会触到它的 import 一律改成**动态 import**：先钉 env，后 import。
//
// 它测的不是"接口通不通"，而是这 10 条已确认缺陷**有没有复发**：
//   ① P0-1 简化入口 receive 只能被拒（不能只翻状态）      ② P0-2 采购订单流转动作为权限
//   ③ P0-3 退货要回退上游已收量 + 来源可按字段反查          ④ P0-4 请购同 SKU 多行按**行**转单
//   ⑤ G4   退货未填价 ≠ 零成本（回落结存均价）            ⑥ M15 批次为空时拒绝（不跨批次拣选）
//   ⑦ M4   生产完工来源的报检行必须带批次 ⇒ 判不合格能落 qc_status
//   ⑧ P1-5 三单匹配按**订单行**绑定（不能跨订单串用入库量）
//   ⑨ P1-6 同 SKU 多行订单按**行**判超收                  ⑩ P1-10 收货/退货数量必须过 numQty(round4)
// 每条断言独立 try/catch：**先红后证**时（把 lib/purchase.js 的对应判据改坏）应看到对应条目变红。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DATA = path.join(ROOT_DIR, 'data')
const SELF_NAME = path.basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, '')
const RAW_ENV = process.env.GML_DATA_DIR || ''
const ISOLATED_DIR = RAW_ENV ? path.resolve(RAW_ENV) : path.join('/tmp', `gml-verify-${SELF_NAME}`)
if (ISOLATED_DIR === REPO_DATA || ISOLATED_DIR.startsWith(REPO_DATA + path.sep)) {
  console.error(`✗ 拒绝运行：隔离目录指向仓库 data/（${ISOLATED_DIR}）。本脚本会建单/收货/退货，只允许在 /tmp 下的副本上跑。`)
  process.exit(2)
}
if (!ISOLATED_DIR.startsWith('/tmp/')) {
  console.error(`✗ 拒绝运行：隔离目录必须在 /tmp 下（实得 ${ISOLATED_DIR}）；不设 GML_DATA_DIR 时会自落到 /tmp/gml-verify-${SELF_NAME}。`)
  process.exit(2)
}
// ⚠️ **先钉 env、再 import**（见文件头的顺序要点）：下面任何 import 都不能在此之前发生
process.env.GML_DATA_DIR = ISOLATED_DIR

const Database = (await import('better-sqlite3')).default
if (!RAW_ENV) {
  // 自落时目录里是空的 ⇒ 从仓库 data/ **只读**备份三库（缺了夹具：供应商/仓库/SKU 全没有）
  fs.mkdirSync(ISOLATED_DIR, { recursive: true })
  for (const c of ['cosmetic', 'food', 'apparel']) {
    const src = new Database(path.join(REPO_DATA, `gml_${c}.db`), { readonly: true })
    const dst = path.join(ISOLATED_DIR, `gml_${c}.db`)
    for (const ext of ['', '-wal', '-shm']) { const p = dst + ext; if (fs.existsSync(p)) fs.rmSync(p) }
    await src.backup(dst)
    src.close()
  }
  console.log(`[落点] 未设 GML_DATA_DIR ⇒ 自落到 ${ISOLATED_DIR}（已从仓库 data/ 只读备份三库；仓库 data/ 不会被写）`)
} else {
  console.log(`[落点] GML_DATA_DIR=${ISOLATED_DIR}`)
}

const { runWithIndustry, getDb, DATA_DIR } = await import('../server/db/index.js')
// 落点自证（判的就是模块**真实用的**那个 DATA_DIR，不是自己再算一遍）
if (!String(DATA_DIR).startsWith('/tmp/')) {
  console.error(`✗ 拒绝运行：db/index.js 实际解析出的 DATA_DIR=${DATA_DIR} 不在 /tmp 下 —— 隔离没生效，会写仓库 data/。`)
  process.exit(2)
}
console.log(`[落点自证] db/index.js 实际使用 DATA_DIR=${DATA_DIR}（已过 /tmp 闸门）`)

const P = await import('../server/lib/purchase.js')
const {
  createPurchaseOrder, transitionPurchaseOrder, receivePurchaseOrder,
  createPurchaseReturn, convertRequisitionToOrder,
  createRequisition, transitionRequisition, createInvoice, transitionInvoice,
  checkOverReceive
} = P
const purchaseReturnSource = P.purchaseReturnSource
if (typeof purchaseReturnSource !== 'function') {
  // 判据/能力被删掉时要**响亮地失败**，而不是静默降级成一个永远返回 null 的桩
  console.error('[守卫] lib/purchase.js 必须导出 purchaseReturnSource（P0-3 的来源反查入口）')
  process.exit(2)
}
// 这两处原来也是**静态** import：`middleware/auth.js` 与 `lib/qc2.js`（后者经 lib/purchase.js
// 间接）都会触到 `server/db/index.js` ⇒ 必须一样改成动态 import，否则钉 env 又会被抢在前面求值。
const { permContext } = await import('../server/middleware/auth.js')
const {
  sourceDetail, createRequest, submitRequest, submitInspection,
  createHandling, confirmHandling
} = await import('../server/lib/qc2.js')

const INDUSTRY = process.argv[2] || 'cosmetic'
const R = []
const SKIPPED = []
const skip = (name, n, why) => {
  SKIPPED.push({ name, n, why })
  console.log(`  ⚠️ SKIP ${name} ×${n}：${why}`)
}
const caseOk = (name, fn) => {
  try {
    const [ok, detail] = fn()
    R.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) })
  } catch (e) {
    R.push({ name, ok: false, detail: `THROW ${e.code || e.name}: ${e.message?.slice(0, 140)}` })
  }
}
const thrown = (fn) => {
  try { return { threw: false, value: fn() } } catch (e) { return { threw: true, code: e.code, error: e } }
}

runWithIndustry(INDUSTRY, () => {
  const db = getDb()
  const actor = { id: 2, name: '刘采购' }

  // ---------- 夹具 ----------
  const sup = db.prepare("SELECT * FROM suppliers ORDER BY id LIMIT 1").get()
  const cat = db
    .prepare('SELECT sku_id, price FROM supplier_products WHERE supplier_id=? AND is_available=1 AND price>0 ORDER BY sku_id LIMIT 1')
    .get(sup.id)
  const skuId = cat.sku_id
  const wh = db.prepare("SELECT * FROM warehouses WHERE type IN ('central','region','kitchen') ORDER BY id LIMIT 1").get()
    || db.prepare('SELECT * FROM warehouses ORDER BY id LIMIT 1').get()

  const mkDraft = (qty) =>
    createPurchaseOrder(db, {
      supplierId: sup.id, warehouseId: wh.id, orderDate: '2026-10-16', actor,
      items: [{ sku_id: skuId, qty, price: 10, tax_rate: 13 }]
    }).id
  const mkPo = (qty, lines = null) => {
    const o = createPurchaseOrder(db, {
      supplierId: sup.id, warehouseId: wh.id, orderDate: '2026-10-16', actor,
      items: lines || [{ sku_id: skuId, qty, price: 10, tax_rate: 13 }]
    })
    transitionPurchaseOrder(db, { id: o.id, action: 'submit', actor })
    return o.id
  }
  const receiveAll = (orderId, priceOverride) => {
    const d = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').all(orderId)
    return receivePurchaseOrder(db, {
      orderId, actor, source: 'api',
      items: d.map((x) => ({ id: x.id, sku_id: x.sku_id, qty: x.qty - x.received_qty, price: priceOverride ?? x.price }))
    })
  }

  // ============ P0-1 只翻状态变已收货 ============
  {
    const id = mkPo(5)
    const r = thrown(() => transitionPurchaseOrder(db, { id, action: 'receive', actor, source: 'api' }))
    const st = db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(id).status
    caseOk('P0-1 简化入口 receive 被拒(EFFECT_REQUIRES_BUSINESS_API)', () => [
      r.threw && r.code === 'EFFECT_REQUIRES_BUSINESS_API' && st !== 'received',
      `code=${r.code} status=${st}`
    ])
  }

  // ============ P0-2 流转动作为权限 ============
  {
    const id = mkDraft(5)
    const w = thrown(() => transitionPurchaseOrder(db, {
      id, action: 'submit', actor: { id: 4, name: '沈仓管' },
      permCtx: permContext(db, { uid: 4 }), source: 'api'
    }))
    caseOk('P0-2a warehouse 提交采购订单被拒(PERM_DENIED)', () => [w.threw && w.code === 'PERM_DENIED', `code=${w.code}`])
  }
  {
    const id = mkPo(5)
    const w = thrown(() => transitionPurchaseOrder(db, {
      id, action: 'approve', actor: { id: 4, name: '沈仓管' },
      permCtx: permContext(db, { uid: 4 }), source: 'api'
    }))
    caseOk('P0-2b warehouse 审批采购订单被拒(PERM_DENIED)', () => [w.threw && w.code === 'PERM_DENIED', `code=${w.code}`])
  }
  {
    const id = mkDraft(5)
    const ok = transitionPurchaseOrder(db, {
      id, action: 'submit', actor: { id: 2, name: '刘采购' }, permCtx: permContext(db, { uid: 2 }), source: 'api'
    })
    caseOk('P0-2c 合法角色(purchase)提交成功', () => [ok.order?.status === 'submitted', `status=${ok.order?.status}`])
  }

  // ============ P0-3 退货回退已收量 + 来源可追溯 ============
  let retRid = null
  {
    const id = mkPo(100)
    receiveAll(id, 10)
    const items = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').all(id)
    const before = db.prepare('SELECT received_qty FROM purchase_order_items WHERE id=?').get(items[0].id).received_qty
    const rc = db.prepare('SELECT * FROM purchase_receipts WHERE order_id=? ORDER BY id DESC LIMIT 1').get(id)
    const rcItems = db.prepare('SELECT * FROM purchase_receipt_items WHERE receipt_id=?').all(rc.id)
    retRid = createPurchaseReturn(db, {
      supplierId: sup.id, warehouseId: wh.id, returnDate: '2026-10-16',
      reason: '验证退货', items: [{ sku_id: skuId, batch_no: rcItems[0].batch_no, qty: 60, price: 10 }],
      actor, source: 'api'
    })
    const after = db.prepare('SELECT received_qty FROM purchase_order_items WHERE id=?').get(items[0].id).received_qty
    const ord = db.prepare('SELECT close_arrival FROM purchase_orders WHERE id=?').get(id)
    const src = purchaseReturnSource(db, retRid)
    caseOk('P0-3a 退货回退上游已收量(收100退60→40)', () => [Number(after) === 40, `before=${before} after=${after}`])
    caseOk('P0-3b 到货关闭随退货退回(close_arrival=0)', () => [Number(ord.close_arrival) === 0, `close_arrival=${ord.close_arrival}`])
    caseOk('P0-3c 按字段找回原单(退货→收货单/订单)', () => {
      const s = src?.sources?.[0]
      return [!!s && s.order_id === id && s.receipt_id === rc.id, `order_id=${s?.order_id} receipt_id=${s?.receipt_id} order_item_id=${s?.order_item_id}`]
    })
    caseOk('P0-3d 退货出库金额非 0（票面价 10）', () => {
      const t = db.prepare("SELECT amount,unit_cost FROM inventory_transactions WHERE doc_type='PUR_RET' AND doc_id=? LIMIT 1").get(retRid)
      return [Number(t?.amount) > 0, `amount=${t?.amount} unit=${t?.unit_cost}`]
    })
  }

  // ============ P0-4 请购同 SKU 多行按行转单 ============
  {
    const mkReq = (lines) => {
      const r = createRequisition(db, {
        warehouseId: wh.id, supplierId: sup.id, reqDate: '2026-10-16',
        applicantType: 'org', applicantName: '验证', actor, lines
      })
      transitionRequisition(db, { id: r.id, action: 'submit', actor })
      transitionRequisition(db, { id: r.id, action: 'approve', actor })
      return r.id
    }
    // 审计实测口径：两行各 10，请求转 10 → 原实现生成 20
    const r1 = mkReq([{ sku_id: skuId, qty: 10, price: 10 }, { sku_id: skuId, qty: 10, price: 10 }])
    const out1 = convertRequisitionToOrder(db, { reqId: r1, lines: [{ sku_id: skuId, qty: 10 }], actor })
    const poTotal = db.prepare('SELECT COALESCE(SUM(qty),0) q FROM purchase_order_items WHERE order_id=?').get(out1.order_id).q
    caseOk('P0-4a 同 SKU 两行各10、转10 ⇒ PO 合计 10', () => [Number(poTotal) === 10, `PO合计=${poTotal}`])
    // 派单口径：两行各 5，请求转 10 → 合计 10，且 converted_qty 各 5
    const r2 = mkReq([{ sku_id: skuId, qty: 5, price: 10 }, { sku_id: skuId, qty: 5, price: 10 }])
    const out2 = convertRequisitionToOrder(db, { reqId: r2, lines: [{ sku_id: skuId, qty: 10 }], actor })
    const poTotal2 = db.prepare('SELECT COALESCE(SUM(qty),0) q FROM purchase_order_items WHERE order_id=?').get(out2.order_id).q
    const conv = db.prepare('SELECT converted_qty FROM purchase_requisition_items WHERE req_id=? ORDER BY id').all(r2).map((x) => x.converted_qty)
    caseOk('P0-4b 两行各5、转10 ⇒ 明细合计10 且 converted_qty=5/5', () => [
      Number(poTotal2) === 10 && conv.length === 2 && Number(conv[0]) === 5 && Number(conv[1]) === 5,
      `PO合计=${poTotal2} converted=${JSON.stringify(conv)}`
    ])
  }

  // ============ P1-6 同 SKU 多行按行判超收 ============
  {
    const id = createPurchaseOrder(db, {
      supplierId: sup.id, warehouseId: wh.id, orderDate: '2026-10-16', actor,
      items: [{ sku_id: skuId, qty: 10, price: 10, tax_rate: 13 }, { sku_id: skuId, qty: 10, price: 10, tax_rate: 13 }]
    }).id
    transitionPurchaseOrder(db, { id, action: 'submit', actor })
    const its = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=? ORDER BY id').all(id)
    // 第一行收满 10
    receivePurchaseOrder(db, { orderId: id, actor, items: [{ id: its[0].id, sku_id: skuId, qty: 10, price: 10 }] })
    // 第二行再收 10 —— 只给行号（不给行号的老实现会拿第一行判成超收）
    const issues = checkOverReceive(db, { orderId: id, lines: [{ id: its[1].id, sku_id: skuId, qty: 10 }] })
    caseOk('P1-6 第二行收货不被第一行额度误判', () => [
      issues.filter((i) => i.level === 'block').length === 0,
      JSON.stringify(issues.map((i) => i.code))
    ])
    const bad = checkOverReceive(db, { orderId: id, lines: [{ id: its[1].id, sku_id: skuId, qty: 999 }] })
    caseOk('P1-6b 真正超收仍被拦', () => [bad.some((i) => i.code === 'OVER_RECEIVE'), JSON.stringify(bad.map((i) => i.code))])
  }

  // ============ P1-5 发票按订单行核对 ============
  {
    const a = mkPo(100); receiveAll(a, 10)
    const b = mkPo(100); receiveAll(b, 10)
    const oiA = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').get(a)
    const inv = createInvoice(db, {
      invoiceNo: `V${Date.now()}`, invoiceType: 'vat_special', supplierId: sup.id, actor,
      lines: [{ sku_id: skuId, qty: 200, price: 10, order_item_id: oiA.id }]
    })
    transitionInvoice(db, { id: inv.id, action: 'submit', actor })
    const r = thrown(() => transitionInvoice(db, { id: inv.id, action: 'verify', actor }))
    caseOk('P1-5 A单入100 却为 A 开 200 被拦(PI_MATCH_FAILED)', () => [r.threw && r.code === 'PI_MATCH_FAILED', `code=${r.code}`])
  }

  // ============ P1-10 数量过 numQty ============
  {
    const id = mkPo(100)
    const its = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').all(id)
    const r = thrown(() => receivePurchaseOrder(db, {
      orderId: id, actor, items: [{ id: its[0].id, sku_id: skuId, qty: 1.23456789, price: 10 }]
    }))
    caseOk('P1-10a 收货数量 1.23456789 被拒', () => [r.threw && r.code === 'PO_BAD_RECEIVE_QTY', `code=${r.code}`])
  }
  {
    const id2 = mkPo(100); receiveAll(id2, 10)
    const rc = db.prepare('SELECT * FROM purchase_receipts WHERE order_id=? ORDER BY id DESC LIMIT 1').get(id2)
    const ri = db.prepare('SELECT * FROM purchase_receipt_items WHERE receipt_id=?').all(rc.id)
    const r = thrown(() => createPurchaseReturn(db, {
      supplierId: sup.id, warehouseId: wh.id, returnDate: '2026-10-16', reason: '验证',
      items: [{ sku_id: skuId, batch_no: ri[0].batch_no, qty: 1.23456789, price: 10 }], actor
    }))
    caseOk('P1-10b 退货数量 1.23456789 被拒', () => [r.threw && r.code === 'PRT_BAD_QTY', `code=${r.code}`])
  }

  // ============ G4 采购退货未填价 → 回落结存均价 ============
  {
    const id = mkPo(100); receiveAll(id, 10)
    const rc = db.prepare('SELECT * FROM purchase_receipts WHERE order_id=? ORDER BY id DESC LIMIT 1').get(id)
    const ri = db.prepare('SELECT * FROM purchase_receipt_items WHERE receipt_id=?').all(rc.id)
    const rid = createPurchaseReturn(db, {
      supplierId: sup.id, warehouseId: wh.id, returnDate: '2026-10-16', reason: '验证未填价',
      items: [{ sku_id: skuId, batch_no: ri[0].batch_no, qty: 60 }], actor
    })
    const t = db.prepare("SELECT amount,unit_cost FROM inventory_transactions WHERE doc_type='PUR_RET' AND doc_id=? ORDER BY id DESC LIMIT 1").get(rid)
    caseOk('G4a 采购退货未填价：出库金额按结存均价（非 0）', () => [Number(t?.amount) > 0, `amount=${t?.amount} unit=${t?.unit_cost}`])
  }

  // ============ 质检链 M4/M15/G4b（采购来源判退 与 生产来源报废） ============
  {
    // 采购来源：收 100 → 报检 → 判不合格 → 判退 → 生成的 PRT 金额必须 > 0（G4b）
    const id = mkPo(20); receiveAll(id, 10)
    const rc = db.prepare('SELECT * FROM purchase_receipts WHERE order_id=? ORDER BY id DESC LIMIT 1').get(id)
    const req = createRequest(db, { sourceType: 'purchase_receipt', sourceId: rc.id, actor })
    const { inspection: ins0 } = submitRequest(db, { id: req.id, actor })
    const it = db.prepare('SELECT * FROM qc_request_items WHERE request_id=?').get(req.id)
    const ins = submitInspection(db, {
      id: ins0.id, actor,
      lines: [{ id: it.id, defect_qty: Math.max(1, Number(it.ac) + 1), defect_code: 'spec', defect_reason: '验证判退' }]
    })
    const dh = createHandling(db, {
      inspectionId: ins.id, skuId: skuId, batchNo: it.batch_no, qty: 5, mode: 'return', reason: '验证', actor
    })
    const out = confirmHandling(db, { id: dh.id, actor })
    const prt = db.prepare('SELECT * FROM purchase_returns WHERE id=?').get(out.out_doc_id)
    caseOk('G4b 模块13判退生成的 PRT 金额>0（取票面价 10）', () => [Number(prt?.total_amount) > 0, `PRT total_amount=${prt?.total_amount}`])
    const t = db.prepare("SELECT amount FROM inventory_transactions WHERE doc_type='PUR_RET' AND doc_id=? ORDER BY id DESC LIMIT 1").get(out.out_doc_id)
    caseOk('G4b2 判退出库流水金额!=0', () => [Number(t?.amount) !== 0, `amount=${t?.amount}`])
  }

  const mo = db.prepare("SELECT * FROM production_orders WHERE status='completed' ORDER BY id LIMIT 1").get()
  if (!mo) {
    // 本库没有"已完工生产订单"这个夹具（实测 **food 库** 就是没有）⇒ 明确跳过。
    // 跳过而不是断言失败：夹具缺失是**数据**性质，不是判据失效；但也**不是伪绿** —— 会打印并计数。
    skip('M4/M15（生产来源批次回填 + 报废批次闸门）', 4, '本库没有 status=completed 的生产订单夹具')
  } else {
    const wr = db.prepare('SELECT * FROM work_reports WHERE order_id=? ORDER BY id LIMIT 1').get(mo.id)
    const det = sourceDetail(db, 'production_order', mo.id)
    caseOk('M4a 生产来源报检行带上已入库批次', () => [
      !!det?.items?.[0]?.batch_no && det.items[0].batch_no === wr.batch_no,
      `sourceDetail=${det?.items?.[0]?.batch_no} work_report=${wr.batch_no}`
    ])
    // 释放旧报检单（种子已占用 MO#4）
    db.prepare("UPDATE qc_requests SET status='cancelled' WHERE source_type='production_order' AND source_id=?").run(mo.id)
    const req = createRequest(db, { sourceType: 'production_order', sourceId: mo.id, actor })
    const { inspection: ins0 } = submitRequest(db, { id: req.id, actor })
    const it = db.prepare('SELECT * FROM qc_request_items WHERE request_id=?').get(req.id)
    const ins = submitInspection(db, {
      id: ins0.id, actor,
      lines: [{ id: it.id, defect_qty: Math.max(1, Number(it.ac) + 1), defect_code: 'quality', defect_reason: '验证FQC' }]
    })
    const b = db.prepare('SELECT * FROM inventory_batches WHERE sku_id=? AND batch_no=?').get(mo.product_sku_id, it.batch_no)
    caseOk('M4b FQC 判不合格 ⇒ 该批次 qc_status=rejected', () => [b?.qc_status === 'rejected', `batch=${it.batch_no} qc_status=${b?.qc_status}`])

    // M15：批次为空执行报废必须被拒
    const dh0 = createHandling(db, { inspectionId: ins.id, skuId: mo.product_sku_id, batchNo: '', qty: 1, mode: 'scrap', actor })
    const r0 = thrown(() => confirmHandling(db, { id: dh0.id, actor }))
    caseOk('M15a 报废批次为空被拒(QC2_HANDLE_NO_BATCH)', () => [r0.threw && r0.code === 'QC2_HANDLE_NO_BATCH', `code=${r0.code}`])

    // M15：带上正确批次 → 只扣本批
    const before = db.prepare('SELECT qty_on_hand FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?')
      .get(mo.warehouse_id, mo.product_sku_id, it.batch_no)
    const dh1 = createHandling(db, { inspectionId: ins.id, skuId: mo.product_sku_id, batchNo: it.batch_no, qty: 2, mode: 'scrap', actor })
    const r1 = thrown(() => confirmHandling(db, { id: dh1.id, actor }))
    const after = db.prepare('SELECT qty_on_hand FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?')
      .get(mo.warehouse_id, mo.product_sku_id, it.batch_no)
    caseOk('M15b 带批次报废只扣本批', () => [
      !r1.threw && Number(before?.qty_on_hand) - Number(after?.qty_on_hand) === 2,
      `${before?.qty_on_hand} → ${after?.qty_on_hand} err=${r1.code || ''}`
    ])
  }
})

const pass = R.filter((x) => x.ok).length
for (const x of R) console.log(`${x.ok ? 'GREEN' : '  red'}  ${x.name}   [${x.detail}]`)
console.log(`\n[${INDUSTRY}] 通过 ${pass} / ${R.length}` + (SKIPPED.length ? `（另有 ${SKIPPED.reduce((a, x) => a + x.n, 0)} 条因夹具缺失跳过，见上方 SKIP）` : ''))
if (pass !== R.length) process.exitCode = 1
