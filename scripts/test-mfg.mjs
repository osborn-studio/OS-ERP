/**
 * ============================================================================
 * 文件标识：scripts/test-mfg.mjs ｜ 测试：生产制造测试（模块 10B · BOM / 领料 / 完工入库）
 * ============================================================================
 * 【职责】测试：生产制造测试（模块 10B · BOM / 领料 / 完工入库）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 生产制造测试（模块 10B · BOM / 领料 / 完工入库）
 *
 * 本模块最容易出的错**不在崩溃，而在「账上有一笔、凭证查不到」**：
 * 领料单写着「已出库」而库存流水里没有；订单写着「已完工」而库里没有产出；
 * 完工入库的金额不等于数量 × 单价。这类错误不抛异常、界面上也看不出红字，
 * 只会在对账时露馅 —— 所以本测试的重心不是「接口通不通」，而是把下列口径钉死：
 *
 *   ① **一个母件一个用途一个 BOM**，且只有已审批 + 生效期内的能用来展开；
 *   ② **展开用量含损耗**：`单件用量 × (1 + 损耗率) × 生产数量 ÷ 基准批量`（逐位核对）；
 *   ③ **替代料的选择可解释**：主料够就选主料、不够就选有库存的替代料，并给出原因；
 *   ④ **领料的出库金额 = 数量 × 出库单价**，且与库存流水写的金额**逐行一致**
 *      （这里曾经错过：库存引擎返回的 `costAmount` 是**出库后的结存金额**，
 *      拿它当本次出库额会让金额随「这个仓还剩多少钱」而变 —— 单据上看不出，只错在成本账上）；
 *   ⑤ **材料成本按订单数量分摊**：`已出库领料总额 ÷ 订单数量 × 本次良品数`；
 *   ⑥ **完工入库真的入库**：库存增加、批次生成、订单的完工数与成本被回写；
 *   ⑦ **审计不变量真的能抓到问题**：手工制造「出库无流水」后必须被 auditMfg 报出来。
 *
 * 与其它测试同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-mfg.mjs [industry]
 *
 * 关于「可重复跑」：本模块会真的扣库存、真的入库。只删单据不还原库存，
 * 第二轮就会因为「库存不足」而失败，或者更糟 —— 悄悄把演示库的库存越改越乱。
 * 所以这里用**快照回滚**：开跑前拍 `inventory_stocks` 全表（业务单据的库存只增不减，
 * 但出库会改 qty_on_hand / cost_price / cost_amount），跑完逐行还原；
 * 按 id 边界删掉本轮新增的流水、成本台账、批次主档与业务单据。
 */
import { getDbFor, dbPathFor } from '../server/db/index.js'
import { resetSequences } from '../server/db/seq.js'
import {
  BomError, USAGE_LABEL, createBom, updateBom, auditBom, obsoleteBom, deleteBom,
  getBom, listBoms, resolveBom, expandBom, bomOverview, getSkuInfo
} from '../server/lib/bom.js'
import {
  MfgError, createIssue, transitionIssue, planRequirement, startOrder,
  createWorkReport, updateWorkReport, deleteWorkReport, completeOrder,
  previewCompletion, getIssue, getProductionOrder, listIssues, listWorkReports,
  mfgOverview, auditMfg
} from '../server/lib/mfg.js'
import { nextDocNo } from '../server/lib/docno.js'

const INDUSTRY = process.argv[2] || 'cosmetic'
// 把「这次到底落在哪个库」**在开库之前**印出来 —— 隔离这件事必须自证：
// 本项目有过"以为设了 GML_DATA_DIR 就隔离了"的教训（有的脚本硬编码 `ROOT/data`，env 对它无效），
// 而真正决定落点的是这一行解析出来的绝对路径。
// 这里只打印、不拒绝运行：`regress-all` 按设计就是对开发库跑的（那是本职，不是违纪）。
console.log(
  `库文件：${dbPathFor(INDUSTRY)}` +
  (process.env.GML_DATA_DIR ? '（GML_DATA_DIR 生效）' : '（⚠️ 未设 GML_DATA_DIR：落在仓库 data/ 下，请确认这是你想要的）')
)
const db = getDbFor(INDUSTRY)

// 本测试造的每一条数据都带这个标记 —— 清理靠它，不靠「猜哪些是测试数据」。
// 声明必须早于 purgeTestData 的**调用**（它在快照之后立刻跑，清上一轮残渣）。
const T = '__test_mfg__'

let pass = 0
let fail = 0
const fails = []
function ok(cond, msg) {
  if (cond) pass += 1
  else { fail += 1; fails.push(msg); console.log('  ✗', msg) }
}
function eq(msg, actual, expect) {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  ✗ ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const num = (v) => Number(v) || 0
const near = (a, b, eps = 0.005) => Math.abs(num(a) - num(b)) <= eps
const okNear = (msg, a, b, eps = 0.005) => {
  if (!near(a, b, eps)) console.log(`  ✗ ${msg}：期望≈${b}，实际 ${a}`)
  ok(near(a, b, eps), msg)
}
const throws = (fn, code, msg) => {
  try { fn() } catch (e) {
    const hit = !code || e.code === code
    if (!hit) console.log(`  ✗ ${msg}：抛的是 ${e.code || e.name}/${e.message}`)
    ok(hit, msg)
    return e
  }
  console.log(`  ✗ ${msg}：没有抛错`)
  ok(false, msg)
  return null
}
const noThrow = (fn, msg) => {
  try { return fn() } catch (e) { console.log(`  ✗ ${msg}：意外抛错 ${e.code || e.name}/${e.message}`); ok(false, msg); return null }
}
const ph = (n) => Array.from({ length: n }, () => '?').join(',')

// ===========================================================================
// 快照与清理（保证可重复跑）
// ===========================================================================

const STOCK_COLS = [
  'id', 'warehouse_id', 'owner_org_id', 'sku_id', 'batch_no', 'currency',
  'qty_on_hand', 'qty_reserved', 'cost_price', 'cost_amount', 'last_in_at', 'last_out_at', 'updated_at'
]
const stockSnapshot = new Map(
  db.prepare(`SELECT ${STOCK_COLS.join(',')} FROM inventory_stocks`).all().map((r) => [r.id, r])
)

function restoreStocks() {
  const cur = db.prepare(`SELECT ${STOCK_COLS.join(',')} FROM inventory_stocks`).all()
  let fixed = 0
  const upd = db.prepare(
    `UPDATE inventory_stocks SET qty_on_hand=?, qty_reserved=?, cost_price=?, cost_amount=?,
       last_in_at=?, last_out_at=?, updated_at=? WHERE id=?`
  )
  const ins = db.prepare(
    `INSERT INTO inventory_stocks (id,warehouse_id,owner_org_id,sku_id,batch_no,currency,qty_on_hand,qty_reserved,
       cost_price,cost_amount,last_in_at,last_out_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  db.transaction(() => {
    for (const r of cur) {
      const s = stockSnapshot.get(r.id)
      if (!s) { db.prepare('DELETE FROM inventory_stocks WHERE id=?').run(r.id); fixed += 1; continue }
      const changed =
        Math.abs(num(r.qty_on_hand) - num(s.qty_on_hand)) > 1e-6 ||
        Math.abs(num(r.qty_reserved) - num(s.qty_reserved)) > 1e-6 ||
        Math.abs(num(r.cost_price) - num(s.cost_price)) > 1e-6 ||
        Math.abs(num(r.cost_amount) - num(s.cost_amount)) > 1e-6 ||
        (r.last_out_at || '') !== (s.last_out_at || '') || (r.updated_at || '') !== (s.updated_at || '')
      if (changed) {
        upd.run(s.qty_on_hand, s.qty_reserved, s.cost_price, s.cost_amount, s.last_in_at, s.last_out_at, s.updated_at, r.id)
        fixed += 1
      }
    }
    // 快照里被删掉的行（本轮不会发生，但清理上一轮残渣时需要）
    for (const [id, s] of stockSnapshot) {
      if (!cur.find((r) => r.id === id)) {
        ins.run(id, s.warehouse_id, s.owner_org_id, s.sku_id, s.batch_no, s.currency,
          s.qty_on_hand, s.qty_reserved, s.cost_price, s.cost_amount, s.last_in_at, s.last_out_at, s.updated_at)
        fixed += 1
      }
    }
  })()
  return fixed
}

/** 清掉本测试造的所有数据：先按「引用它的行」，再删单据；最后按 id 边界删流水 */
function purgeTestData() {
  const c = { boms: 0, issues: 0, reports: 0, orders: 0, txns: 0, ledger: 0, batches: 0, events: 0 }
  db.transaction(() => {
    const mk = db.prepare('SELECT id,doc_no FROM production_orders WHERE remark=?').all(T)
    const iss = db.prepare('SELECT id,doc_no FROM material_issues WHERE remark LIKE ?').all(`%${T}%`)
    const boms = db.prepare('SELECT id FROM boms WHERE remark=?').all(T).map((r) => r.id)
    const ordIds = mk.map((r) => r.id)
    const ordNos = mk.map((r) => r.doc_no)
    const issIds = iss.map((r) => r.id)
    const issNos = iss.map((r) => r.doc_no)

    // 关联行先删：汇报 → 订单行；领料事件与行；BOM 行
    if (ordIds.length) {
      c.reports = db.prepare(`DELETE FROM work_reports WHERE order_id IN (${ph(ordIds.length)})`).run(...ordIds).changes
      db.prepare(`DELETE FROM production_order_items WHERE order_id IN (${ph(ordIds.length)})`).run(...ordIds)
    }
    if (issIds.length) {
      db.prepare(`DELETE FROM doc_events WHERE doc_type='MR' AND doc_id IN (${ph(issIds.length)})`).run(...issIds)
      db.prepare(`DELETE FROM material_issue_items WHERE issue_id IN (${ph(issIds.length)})`).run(...issIds)
    }
    if (boms.length) {
      db.prepare(`DELETE FROM bom_items WHERE bom_id IN (${ph(boms.length)})`).run(...boms)
    }

    // 库存流水 / 成本台账：**按单据号删，不是按「汇报单号」删**。
    // 完工入库的流水挂的是**生产订单号**（`t.doc_no = wr.order_no`），
    // 早先这里误用了汇报单号 —— 于是每次跑完都漏下两条完工入库流水，
    // 而「清理成功了」的假象在于：它确实删掉了领料那几条。
    const batchNos = new Set()
    const killTxn = db.prepare('DELETE FROM inventory_transactions WHERE doc_type=? AND doc_no=? AND direction=?')
    const killLedger = (docType, nos) =>
      db.prepare(`DELETE FROM stock_cost_ledger WHERE doc_type=? AND doc_no IN (${ph(nos.length)})`).run(docType, ...nos).changes
    const sweep = (docType, nos, dir) => {
      if (!nos.length) return
      for (const r of db
        .prepare(`SELECT batch_no FROM inventory_transactions WHERE doc_type=? AND direction=? AND doc_no IN (${ph(nos.length)})`)
        .all(docType, dir, ...nos)) {
        if (r.batch_no) batchNos.add(r.batch_no)
      }
      for (const no of nos) c.txns += killTxn.run(docType, no, dir).changes
      c.ledger += killLedger(docType, nos)
    }
    sweep('MO', ordNos, 'in')
    sweep('MR', issNos, 'out')

    // 孤儿兜底：上一轮若在 [7] 之前崩掉，会留下「单据已删、流水还在」的渣。
    // 这类渣只能靠「它引用的单据还在不在」去找 —— 按单号前缀猜是猜不出来的。
    c.txns += db
      .prepare("DELETE FROM inventory_transactions WHERE doc_type='MR' AND doc_id NOT IN (SELECT id FROM material_issues)")
      .run().changes
    c.txns += db
      .prepare("DELETE FROM inventory_transactions WHERE doc_type='MO' AND doc_id NOT IN (SELECT id FROM production_orders)")
      .run().changes
    c.ledger += db
      .prepare("DELETE FROM stock_cost_ledger WHERE doc_type='MR' AND doc_no NOT IN (SELECT doc_no FROM material_issues)")
      .run().changes
    c.ledger += db
      .prepare("DELETE FROM stock_cost_ledger WHERE doc_type='MO' AND doc_no NOT IN (SELECT doc_no FROM production_orders)")
      .run().changes

    // 批次主档：完工入库建的批次要一并清掉（否则库存还原后留下「谁都不认」的批次）
    if (batchNos.size) {
      c.batches = db.prepare(`DELETE FROM inventory_batches WHERE batch_no IN (${ph(batchNos.size)})`).run(...batchNos).changes
    }

    // 最后删单据本身
    if (issIds.length) c.issues = db.prepare(`DELETE FROM material_issues WHERE id IN (${ph(issIds.length)})`).run(...issIds).changes
    if (ordIds.length) c.orders = db.prepare(`DELETE FROM production_orders WHERE id IN (${ph(ordIds.length)})`).run(...ordIds).changes
    if (boms.length) c.boms = db.prepare(`DELETE FROM boms WHERE id IN (${ph(boms.length)})`).run(...boms).changes

    // 孤儿留痕：中间态被打断时最容易在这里留渣。
    // **两个单据类型都要清** —— 早先只清了 MR，结果每跑一轮就在 `doc_events` 里
    // 攒下若干条指向「已被删掉的测试生产订单」的留痕，而 verify-seed 第 8 节会把它算成
    // 「无孤儿留痕」不合格。孤儿不报错、界面也看不见，只能靠这类清点发现。
    c.events += db.prepare("DELETE FROM doc_events WHERE doc_type='MR' AND doc_id NOT IN (SELECT id FROM material_issues)").run().changes
    c.events += db.prepare("DELETE FROM doc_events WHERE doc_type='MO' AND doc_id NOT IN (SELECT id FROM production_orders)").run().changes
  })()
  return c
}

const pre = purgeTestData()
if (pre.boms || pre.issues || pre.orders || pre.txns || pre.ledger || pre.events) {
  console.log(
    `  （已清理上一轮残留：BOM ${pre.boms} / 领料 ${pre.issues} / 订单 ${pre.orders} / 流水 ${pre.txns} / 台账 ${pre.ledger} / 批次 ${pre.batches} / 孤儿留痕 ${pre.events}）`
  )
}
const preStock = restoreStocks()
if (preStock) console.log(`  （上一轮残留的库存变动已还原：${preStock} 行）`)

const txnCount0 = db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c
const ledgerCount0 = db.prepare('SELECT COUNT(*) c FROM stock_cost_ledger').get().c

// ===========================================================================
// 自建干净场景：不依赖演示数据的具体形态
// ===========================================================================

const wh = db
  .prepare("SELECT id,name FROM warehouses WHERE type='central_kitchen' ORDER BY id LIMIT 1")
  .get() || db.prepare('SELECT id,name FROM warehouses ORDER BY id LIMIT 1').get()

// 原料：该仓有足够库存的外购品（挑「对的」而不是「第一个」）
const comp = db
  .prepare(
    `SELECT s.sku_id, k.sku_code, k.name, SUM(s.qty_on_hand - s.qty_reserved) AS avail
       FROM inventory_stocks s
       JOIN product_skus k ON k.id = s.sku_id
       JOIN products p ON p.id = k.product_id
      WHERE s.warehouse_id = ? AND p.procurement_type = 'buy'
      GROUP BY s.sku_id
     HAVING SUM(s.qty_on_hand - s.qty_reserved) > 60
      ORDER BY avail DESC, s.sku_id LIMIT 1`
  )
  .get(wh.id)
// 备用原料（替代料用）
const comp2 = db
  .prepare(
    `SELECT s.sku_id, k.sku_code, k.name, SUM(s.qty_on_hand - s.qty_reserved) AS avail
       FROM inventory_stocks s
       JOIN product_skus k ON k.id = s.sku_id
       JOIN products p ON p.id = k.product_id
      WHERE s.warehouse_id = ? AND p.procurement_type = 'buy' AND s.sku_id <> ?
      GROUP BY s.sku_id
     HAVING SUM(s.qty_on_hand - s.qty_reserved) > 5
      ORDER BY avail DESC, s.sku_id LIMIT 1`
  )
  .get(wh.id, comp.sku_id)
// 母件：挑一个还没有**自制** BOM 的成品（主场景用）
const prod = db
  .prepare(
    `SELECT s.id, s.sku_code, s.name FROM product_skus s JOIN products p ON p.id = s.product_id
      WHERE p.procurement_type = 'self' AND s.status='active'
        AND s.id NOT IN (SELECT product_sku_id FROM boms WHERE usage='self_made')
      ORDER BY s.id LIMIT 1`
  )
  .get()

// 另一个母件：**任何用途**都还没有 BOM。
// 为什么要单挑一个：`createBom` 是先查「一个母件一个用途只有一版」再校验行数据，
// 所以若拿一个已有委外 BOM 的母件去测「损耗率填 5 被拦下」，抛出来的会是
// BOM_ALREADY_EXISTS —— 断言照样「绿」，但它验的根本不是行校验。
// 这正是「取样本要挑对的，不要挑第一个」那条规矩的又一次现身。
const prodFree = db
  .prepare(
    `SELECT s.id, s.sku_code, s.name FROM product_skus s JOIN products p ON p.id = s.product_id
      WHERE p.procurement_type = 'self' AND s.status='active'
        AND s.id NOT IN (SELECT product_sku_id FROM boms)
      ORDER BY s.id LIMIT 1`
  )
  .get()

if (!comp || !wh || !prod || !prodFree) {
  console.error('环境不足：需要仓库 / 有库存的外购原料 / 无 BOM 的自制成品 / 无任何 BOM 的自制成品')
  process.exit(1)
}

const actor = { id: null, name: '测试' }
const createdIds = { boms: [], issues: [], orders: [], reports: [] }

console.log(`\n=== 模块 10B 生产制造测试 · ${INDUSTRY} ===`)
console.log(`仓库 ${wh.name} / 原料 ${comp.sku_code}(可用 ${comp.avail}) / 母件 ${prod.sku_code}\n`)

// ---------------------------------------------------------------------------
console.log('[1] BOM 主数据与校验口径')
// ---------------------------------------------------------------------------

// 用量 × 清耗率都取整数便于逐位核对
const BOM_QTY = 1.5
const LOSS = 0.1
const bom = noThrow(() => createBom(db, {
  productSkuId: prod.id, usage: 'self_made', baseQty: 1,
  effectiveFrom: '2020-01-01',
  items: [
    { sku_id: comp.sku_id, qty: BOM_QTY, loss_rate: LOSS, substitute_group: '主替', priority: 0 },
    { sku_id: comp2.sku_id, qty: 0.5, loss_rate: 0, substitute_group: '主替', priority: 1 },
    { sku_id: comp2.sku_id, qty: 0.25, loss_rate: 0, remark: '独立行，不与谁互为替代' }
  ],
  remark: T, actor
}), '建 BOM')
if (bom) createdIds.boms.push(bom.id)
ok(!!bom, '✓ BOM 建成')
eq('新 BOM 初始状态为草稿', bom.status, 'draft')
eq('组件行数', bom.items.length, 3)
eq('基准批量', num(bom.base_qty), 1)
ok(!bom.audited_at, '草稿阶段没有审批时间')
okNear('第一行用量原样落库', bom.items[0].qty, BOM_QTY)
okNear('第一行损耗率原样落库', bom.items[0].loss_rate, LOSS)

// 一个母件一个用途只能一个 BOM
throws(() => createBom(db, {
  productSkuId: prod.id, usage: 'self_made', items: [{ sku_id: comp.sku_id, qty: 1 }], actor
}), 'BOM_ALREADY_EXISTS', '重复建同母件同用途 BOM 被拒（一个母件一个用途只有一版）')

// 另一用途可以建（组合装并入统一 BOM 的体现）。
// 用「任何用途都还没 BOM」的母件来建 —— 否则会先撞上它已有的那个用途，
// 断言「用途不同不算重复」就会在没验到这一点的情况下变绿。
const comboBom = noThrow(() => createBom(db, {
  productSkuId: prodFree.id, usage: 'combo', items: [{ sku_id: comp.sku_id, qty: 2 }], remark: T, actor
}), '同母件的组合装 BOM 可以另建')
if (comboBom) createdIds.boms.push(comboBom.id)
ok(!!comboBom, '同一母件可以另建组合装用途的 BOM（用途不同不算重复）')
if (comboBom) eq('combo 号码与自制那版不同', comboBom.code === bom.code, false)
if (comboBom) noThrow(() => obsoleteBom(db, { id: comboBom.id, actor }), '清理组合装样本')

// 组件行校验（用「任何用途都没有 BOM」的母件，才验得到行校验本身）
throws(() => createBom(db, {
  productSkuId: prodFree.id, usage: 'outsourced',
  items: [{ sku_id: comp.sku_id, qty: 1, loss_rate: 5 }], actor
}), 'BOM_ITEM_LOSS_SUSPECT', '损耗率填 5（应为 0.05）被拦下')
throws(() => createBom(db, {
  productSkuId: prodFree.id, usage: 'outsourced',
  items: [{ sku_id: comp.sku_id, qty: 0 }], actor
}), 'BOM_ITEM_QTY_INVALID', '用量为 0 被拦下')
throws(() => createBom(db, {
  productSkuId: prodFree.id, usage: 'outsourced', items: [], actor
}), 'BOM_ITEM_REQUIRED', '没有组件行被拦下')

// 未审批不能扩展
throws(() => expandBom(db, { bomId: bom.id, qty: 10, warehouseId: wh.id }),
  'BOM_NOT_APPROVED', '草稿 BOM 不能用于展开')

// 已审批不可改
throws(() => updateBom(db, { id: 0, version: 'V9' }), 'BOM_NOT_FOUND', '改不存在的 BOM 报 404')
const audited = noThrow(() => auditBom(db, { id: bom.id, actor, remark: '测试审批' }), '审批 BOM')
eq('审批后状态', audited.status, 'approved')
ok(!!audited.audited_at, '审批后有审批时间')
eq('审批人落库', audited.audited_by_name, '测试')
throws(() => updateBom(db, { id: bom.id, version: 'V2.0' }),
  'BOM_APPROVED_IMMUTABLE', '已审批的 BOM 不能原地修改（换版要走作废 + 新建）')
throws(() => deleteBom(db, { id: bom.id }),
  'BOM_DELETE_FORBIDDEN', '已审批的 BOM 不能删除')
eq('已审批 BOM 能被 resolveBom 取到', resolveBom(db, { skuId: prod.id, usage: 'self_made' })?.id, bom.id)
eq('已作废的 BOM 取不到（resolveBom 只认已审批）', resolveBom(db, { skuId: prodFree.id, usage: 'combo' }), null)
eq('主 BOM 审批后状态没被组合装样本影响', getBom(db, bom.id).status, 'approved')

// ---------------------------------------------------------------------------
console.log('\n[2] 展开：用量含损耗、替代料可解释')
// ---------------------------------------------------------------------------

const QTY = 10
const ex = noThrow(() => expandBom(db, { bomId: bom.id, qty: QTY, warehouseId: wh.id }), '展开 BOM')
ok(!!ex, '✓ 展开成功')
// 用量 = 1.5 × (1 + 0.1) × 10 ÷ 1 = 16.5
okNear('用量含损耗：1.5 × 1.1 × 10 = 16.5', ex.lines[0].qty, 16.5, 1e-6)
eq('展开行数（替代组只出 1 行 + 独立行 1 行）', ex.lines.length, 2)
eq('替代组数', ex.groups.length, 1)
ok(ex.lines[0].qty > num(ex.lines[0].base_qty) * QTY - 1e-9, '含损耗后用量大于「单件用量 × 数量」')

// 主料够 → 选主料
eq('主料库存充足时选中主料行', ex.lines[0].line_no, 1)
eq('选中主料时 is_substitute 为 false', ex.lines[0].is_substitute, false)
eq('原因说明', ex.groups[0].reason, '主料库存充足')
eq('替代组候选数', ex.groups[0].candidates.length, 2)

// 主料不够 → 选替代料。做法：把数量放大到远超主料库存，但替代料需求仍在其可用量之内
const tiny = Math.max(1, Math.floor(num(comp.avail) / (BOM_QTY * (1 + LOSS)) / 10))
const ex2 = noThrow(() => expandBom(db, { bomId: bom.id, qty: tiny, warehouseId: wh.id }), '小批量展开')
// 构造一个「主料不够、替代料够」的场景：直接调 expandBom 时把主料需求放大
const exSub = noThrow(() => {
  // 主料需 16.5 × N，N 取到刚好超过主料可用量；替代料需求 0.5 × N 仍小于其可用量
  const n = Math.floor(num(comp.avail) / (BOM_QTY * (1 + LOSS))) + 1
  return expandBom(db, { bomId: bom.id, qty: n, warehouseId: wh.id })
}, '主料不足时展开')
if (exSub) {
  eq('主料不足时改选替代料', exSub.lines[0].line_no, 2)
  eq('替代料标记为 is_substitute', exSub.lines[0].is_substitute, true)
  eq('替代料回指被替代的主料行', exSub.lines[0].substitute_for, 1)
  ok(/主料不足/.test(exSub.groups[0].reason), `替代原因说明主料不足（${exSub.groups[0].reason}）`)
  eq('替代时报告的替代数', exSub.summary.substituted, 1)
}
// 独立行不参与替代
eq('不在替代组里的行不会被替换', ex.lines[1].is_substitute, false)
ok(ex.lines[1].substitute_group == null, '独立行没有替代组')

// 关闭替代时永远取主料
const exNoSub = noThrow(() => expandBom(db, { bomId: bom.id, qty: 10, warehouseId: wh.id, allowSubstitute: false }), '关闭替代展开')
eq('关闭替代后仍取主料', exNoSub.lines[0].line_no, 1)
eq('关闭替代后原因说明', exNoSub.groups[0].reason, '主料（优先级最高）')

// 后续领料用例需要每个 BOM 原料都有稳定的有效库存；演示库存可能过期。
const testBatchNo = `MFGTEST${process.pid}`
const whStock = db.prepare('SELECT default_owner_org_id, currency FROM warehouses WHERE id=?').get(wh.id)
const testSkuIds = db.prepare(`
  SELECT DISTINCT bi.sku_id
    FROM bom_items bi JOIN boms b ON b.id=bi.bom_id
   WHERE b.product_sku_id=?
`).all(prod.id).map(x => Number(x.sku_id))
if (!testSkuIds.includes(Number(comp.sku_id))) testSkuIds.push(Number(comp.sku_id))
for (const [i, skuId] of testSkuIds.entries()) {
  const batchNo = `${testBatchNo}-${i + 1}`
  const skuPolicy = db.prepare(`SELECT p.require_qc FROM products p JOIN product_skus s ON s.product_id=p.id WHERE s.id=?`).get(skuId)
  const refCost = num(db.prepare('SELECT cost_price FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND qty_on_hand>0 ORDER BY qty_on_hand DESC LIMIT 1').get(wh.id, skuId)?.cost_price)
  db.prepare(`INSERT INTO inventory_batches (batch_no,sku_id,expire_at,origin_doc_type,origin_doc_no,qc_status,status,remark)
    VALUES (?,?,?,'TEST','__test_mfg__',?,'active','temporary manufacturing regression stock')`)
    .run(batchNo, skuId, '2099-12-31T23:59:59', skuPolicy?.require_qc ? 'qualified' : 'pending')
  db.prepare(`INSERT INTO inventory_stocks
    (warehouse_id,owner_org_id,sku_id,batch_no,currency,expire_date,expire_at,entry_date,qty_on_hand,qty_reserved,cost_price,cost_amount)
    VALUES (?,?,?,?,?,?,?,date('now','localtime'),50000,0,?,?)`)
    .run(wh.id, whStock.default_owner_org_id, skuId, batchNo, whStock.currency || 'CNY', '2099-12-31', '2099-12-31T23:59:59', refCost, 50000 * refCost)
}
console.log(`  （测试专用有效批次：${testSkuIds.length} 个 BOM 原料 SKU 各 50000 件；结束时按库存快照清理）`)

// 边界
throws(() => expandBom(db, { bomId: bom.id, qty: 0 }), 'BOM_QTY_INVALID', '数量为 0 被拦')
throws(() => expandBom(db, { bomId: 999999, qty: 1 }), 'BOM_NOT_FOUND', '不存在的 BOM 报 404')
// 按 skuId 展开、但没有生效 BOM：报的是「没找到生效 BOM」（带候选清单），不是空指针
throws(() => expandBom(db, { skuId: 999999, qty: 1 }), 'BOM_NOT_EFFECTIVE', '按 skuId 展开但无 BOM 时报错')
// 该母件确实没有任何 BOM，同样报 BOM_NOT_EFFECTIVE —— 证明上面那条不是因为「id 不存在」才报错
throws(() => expandBom(db, { skuId: prodFree.id, qty: 1 }), 'BOM_NOT_EFFECTIVE', '母件无 BOM 时展开同样报错')
eq('展开结果顺序稳定（按行号，替代组只出 1 行所以跳过第 2 行）', ex.lines.map((l) => l.line_no), [1, 3])

// ---------------------------------------------------------------------------
console.log('\n[3] 生产订单与领料')
// ---------------------------------------------------------------------------

const issueDate = '2026-06-15'
const docNo = nextDocNo(db, 'MO', 'production_orders', 'doc_no', issueDate)
const moInfo = db.prepare(
  `INSERT INTO production_orders (doc_no,product_sku_id,warehouse_id,plan_date,status,qty,completed_qty,
     unit_cost,material_cost,total_cost,source_type,remark,created_by)
   VALUES (?,?,?,?, 'approved', ?,0,0,0,0, 'manual',?,null)`
).run(docNo, prod.id, wh.id, issueDate, QTY, T)
const moId = moInfo.lastInsertRowid
createdIds.orders.push(moId)

eq('订单初始状态', getProductionOrder(db, moId).status, 'approved')
throws(() => createIssue(db, { orderId: moId, warehouseId: wh.id, actor, remark: T }),
  'MO_NOT_STARTED', '未开工的订单不能领料')

const started = noThrow(() => startOrder(db, { orderId: moId, actor }), '开工')
eq('开工后状态', started.status, 'in_progress')
eq('重复开工幂等', noThrow(() => startOrder(db, { orderId: moId, actor }), '重复开工')?.status, 'in_progress')

const req = noThrow(() => planRequirement(db, { orderId: moId }), '需求展开')
okNear('需求行第一行待领量 = 16.5', req.lines[0].pending_qty, 16.5, 1e-6)
eq('需求行数（替代组折叠为 1 行）', req.lines.length, 2)
eq('未领时已领量为 0', req.lines[0].issued_qty, 0)

// 自动装填领料
const stockBeforeIssue = num(db.prepare(
  'SELECT COALESCE(SUM(qty_on_hand - qty_reserved),0) AS q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?'
).get(wh.id, comp.sku_id).q)
let issue = noThrow(() => createIssue(db, { orderId: moId, warehouseId: wh.id, issueType: 'by_bom', issueDate, actor, remark: T }), '建领料单')
createdIds.issues.push(issue.id)
eq('领料单初始状态', issue.status, 'draft')
eq('自动装填行数', issue.items.length, 2)
okNear('自动装填数量 = 待领量', issue.items[0].qty, 16.5, 1e-6)
eq('领料类型', issue.issue_type, 'by_bom')
ok(!!issue.doc_no && issue.doc_no.startsWith('MR'), `领料单号前缀 MR（${issue.doc_no}）`)

throws(() => transitionIssue(db, { id: issue.id, action: 'issue', actor }),
  'MFG_ISSUE_NOT_APPROVED', '未审批的领料单不能出库')

issue = noThrow(() => transitionIssue(db, { id: issue.id, action: 'submit', actor }), '提交领料单')
eq('提交后状态', issue.status, 'submitted')
issue = noThrow(() => transitionIssue(db, { id: issue.id, action: 'approve', actor }), '审批领料单')
eq('审批后状态', issue.status, 'approved')
issue = noThrow(() => transitionIssue(db, { id: issue.id, action: 'issue', actor }), '出库')
eq('出库后状态', issue.status, 'issued')

// 库存真的减了
const stockNow = db
  .prepare('SELECT COALESCE(SUM(qty_on_hand - qty_reserved),0) AS q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?')
  .get(wh.id, comp.sku_id).q
okNear('出库后原料可用量减少 16.5', stockBeforeIssue - num(stockNow), 16.5, 0.01)

// **金额口径回归**：领料行金额 = 数量 × 单价，且与库存流水逐行一致
const txnRows = db
  .prepare("SELECT sku_id,qty,unit_cost,amount FROM inventory_transactions WHERE doc_type='MR' AND doc_id=? AND direction='out' ORDER BY id")
  .all(issue.id)
eq('出库流水条数 = 领料行数', txnRows.length, issue.items.length)
let lineSum = 0
for (const l of issue.items) {
  const t = txnRows.find((x) => x.sku_id === l.sku_id)
  ok(!!t, `行 SKU#${l.sku_id} 有对应出库流水`)
  if (!t) continue
  okNear(`行金额 = 数量 × 单价（SKU#${l.sku_id}）`, l.amount, num(l.qty) * num(l.unit_cost), 0.01)
  okNear(`行金额与库存流水金额一致（SKU#${l.sku_id}）`, l.amount, num(t.amount), 0.01)
  okNear(`行单价与流水单价一致（SKU#${l.sku_id}）`, l.unit_cost, num(t.unit_cost), 0.0001)
  lineSum += num(l.amount)
}
okNear('出库金额 = 各行金额之和（不是「出库后的结存金额」）', issue.total_amount, lineSum, 0.01)
ok(issue.total_amount > 0, `出库金额大于 0（${issue.total_amount}）`)
ok(!!issue.issued_at, '出库时间已记录')
eq('出库人已记录', issue.issued_by_name, '测试')

// 出库后不可取消（终态）
throws(() => transitionIssue(db, { id: issue.id, action: 'cancel', actor }), 'TRANSITION_NOT_ALLOWED', '已出库的领料单不能取消')

// 再领一次：需求应已扣减
const req2 = planRequirement(db, { orderId: moId, includeIssued: true })
okNear('已领量被正确累计', req2.lines[0].issued_qty, 16.5, 1e-6)
okNear('待领量归零', req2.lines[0].pending_qty, 0, 1e-6)
const req3 = planRequirement(db, { orderId: moId })
eq('待领清单为空（已领满）', req3.lines.length, 0)

// 限额领料超领被拦；补料必须写原因
throws(() => createIssue(db, {
  orderId: moId, warehouseId: wh.id, issueType: 'limit', issueDate, actor, remark: T,
  items: [{ sku_id: comp.sku_id, qty: 100 }]
}), 'MFG_OVER_ISSUE', '限额领料超出 BOM 需求被拦')
throws(() => createIssue(db, {
  orderId: moId, warehouseId: wh.id, issueType: 'supplement', issueDate, actor,
  items: [{ sku_id: comp.sku_id, qty: 1 }]
}), 'MFG_SUPPLEMENT_REASON_REQUIRED', '补料未填原因被拦')

// 补料单（合法）
const sup = noThrow(() => {
  let s = createIssue(db, {
    orderId: moId, warehouseId: wh.id, issueType: 'supplement', issueDate, actor,
    items: [{ sku_id: comp.sku_id, qty: 1 }], remark: `${T} 损耗超预期补领`
  })
  createdIds.issues.push(s.id)
  s = transitionIssue(db, { id: s.id, action: 'submit', actor })
  s = transitionIssue(db, { id: s.id, action: 'approve', actor })
  return transitionIssue(db, { id: s.id, action: 'issue', actor })
}, '补料单全流程')
eq('补料单类型', sup.issue_type, 'supplement')
eq('补料单状态', sup.status, 'issued')
eq('补料单原因保留', !!sup.remark, true)
const overReq = planRequirement(db, { orderId: moId, includeIssued: true })
ok(overReq.lines[0].issued_qty > overReq.lines[0].qty, '补料后已领量超过 BOM 需求（补料的意义所在）')

// ---------------------------------------------------------------------------
console.log('\n[4] 完工汇报与完工入库')
// ---------------------------------------------------------------------------

eq('结算前订单完工数', num(getProductionOrder(db, moId).completed_qty), 0)
throws(() => createWorkReport(db, { orderId: moId, goodQty: 0, defectQty: 0, actor }),
  'MFG_QTY_EMPTY', '良品与不良同时为 0 被拦')
throws(() => createWorkReport(db, { orderId: moId, goodQty: QTY + 1, defectQty: 0, actor }),
  'MFG_OVER_COMPLETE', '良品超过订单数量被拦')
throws(() => createWorkReport(db, { orderId: moId, goodQty: -1, defectQty: 0, actor }),
  'MFG_QTY_INVALID', '负数被拦')

const HOURS = 5
const RATE = 40
const OVERHEAD = 100
const GOOD = 9
const DEFECT = 1
const wr = noThrow(() => createWorkReport(db, {
  orderId: moId, issueId: issue.id, reportDate: '2026-06-16', processName: '测试工序',
  goodQty: GOOD, defectQty: DEFECT, workHours: HOURS, laborRate: RATE, overheadCost: OVERHEAD, actor
}), '登记完工汇报')
createdIds.reports.push(wr.id)
ok(!!wr, '✓ 完工汇报登记成功')
ok(!!wr.doc_no && wr.doc_no.startsWith('WRP'), `汇报单号前缀 WRP（${wr.doc_no}）`)
eq('完工汇报不推进任何单据状态（G4 不报工）', getProductionOrder(db, moId).status, 'in_progress')
eq('汇报良品数', num(wr.good_qty), GOOD)
eq('汇报不良数', num(wr.defect_qty), DEFECT)
okNear('人工成本 = 工时 × 费率', wr.labor_cost, HOURS * RATE, 0.01)
eq('入库前 stock_done 为 0', num(wr.stock_done), 0)

// 预览必须与实际入库一致
const pv = noThrow(() => previewCompletion(db, { orderId: moId }), '入库预览')
const issuedAmount = num(getIssue(db, issue.id).total_amount) + num(sup.total_amount)
okNear('预览的已领料总额 = 两张已出库领料单之和', pv.issued_amount, issuedAmount, 0.01)
okNear('预览单位材料 = 已领料总额 ÷ 订单数量', pv.unit_material, issuedAmount / QTY, 0.001)
okNear('预览材料成本 = 单位材料 × 良品数', pv.material_cost, (issuedAmount / QTY) * GOOD, 0.02)
okNear('预览转换成本 = 人工 + 制费', pv.conversion_cost, HOURS * RATE + OVERHEAD, 0.01)
eq('预览不会真的入库', num(db.prepare('SELECT stock_done FROM work_reports WHERE id=?').get(wr.id).stock_done), 0)

const stockBeforeIn = db
  .prepare('SELECT COALESCE(SUM(qty_on_hand),0) AS q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?')
  .get(wh.id, prod.id).q

const done = noThrow(() => completeOrder(db, { orderId: moId, reportId: wr.id, actor }), '完工入库')
ok(!!done, '✓ 完工入库成功')
eq('本次入库数量 = 良品数', num(done.stock_in_qty), GOOD)
okNear('实际材料成本 = 预览值', done.material_cost, pv.material_cost, 0.02)
okNear('实际转换成本 = 预览值', done.conversion_cost, pv.conversion_cost, 0.01)

const stockAfterIn = db
  .prepare('SELECT COALESCE(SUM(qty_on_hand),0) AS q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?')
  .get(wh.id, prod.id).q
okNear('成品库存真的增加了良品数', stockAfterIn - stockBeforeIn, GOOD, 0.001)

const inTxn = db
  .prepare("SELECT * FROM inventory_transactions WHERE doc_type='MO' AND doc_id=? AND direction='in' ORDER BY id")
  .all(moId)
eq('完工入库产生 1 条库存流水', inTxn.length, 1)
if (inTxn.length) {
  okNear('入库流水数量 = 良品数', inTxn[0].qty, GOOD, 0.001)
  okNear('入库流水金额 = 数量 × 单位成本', inTxn[0].amount, num(inTxn[0].qty) * num(inTxn[0].unit_cost), 0.01)
  okNear('入库单位成本 = 预览单位成本（含料工费）', inTxn[0].unit_cost, pv.unit_cost, 0.02)
  ok(!!inTxn[0].batch_no, `完工入库生成了批次号（${inTxn[0].batch_no}）`)
}
const batch = db.prepare('SELECT * FROM inventory_batches WHERE sku_id=? AND batch_no=?').get(prod.id, inTxn[0]?.batch_no)
ok(!!batch, '批次主档已建立')
eq('完工入库的成品批次状态为待检（尚未质检）', batch?.qc_status, 'pending')

// 汇报被锁
const wrAfter = db.prepare('SELECT * FROM work_reports WHERE id=?').get(wr.id)
eq('入库后 stock_done 置 1', num(wrAfter.stock_done), 1)
okNear('汇报回写的材料成本 = 入库金额', wrAfter.material_cost, done.material_cost, 0.02)
okNear('汇报回写的单位成本', wrAfter.unit_cost, pv.unit_cost, 0.02)
throws(() => updateWorkReport(db, { id: wr.id, goodQty: 1 }), 'MFG_REPORT_LOCKED', '已入库的汇报不能修改')
throws(() => deleteWorkReport(db, { id: wr.id }), 'MFG_REPORT_LOCKED', '已入库的汇报不能删除')
throws(() => completeOrder(db, { orderId: moId, actor }), 'MFG_NO_PENDING_REPORT', '没有待入库汇报时报错')

// 订单回写
const moAfter = getProductionOrder(db, moId)
okNear('订单完工数回写', moAfter.completed_qty, GOOD, 0.001)
okNear('订单材料成本回写', moAfter.material_cost, done.material_cost, 0.02)
okNear('订单总成本 = 材料 + 转换', moAfter.total_cost, done.material_cost + done.conversion_cost, 0.02)
okNear('订单单位成本 = 总成本 ÷ 完工数', moAfter.unit_cost, (done.material_cost + done.conversion_cost) / GOOD, 0.001)
eq('只完工一部分时订单仍是「生产中」', moAfter.status, 'in_progress')

// 完工剩余数量 → 订单转「已完工」
const wr2 = noThrow(() => createWorkReport(db, {
  orderId: moId, reportDate: '2026-06-17', goodQty: QTY - GOOD, defectQty: 0, actor
}), '登记第二张完工汇报')
createdIds.reports.push(wr2.id)
const done2 = noThrow(() => completeOrder(db, { orderId: moId, actor }), '第二次完工入库')
eq('全部完工后订单状态', done2.order.status, 'completed')
okNear('累计完工数 = 订单数量', done2.order.completed_qty, QTY, 0.001)
eq('完工汇报累计 2 张', db.prepare('SELECT COUNT(*) c FROM work_reports WHERE order_id=?').get(moId).c, 2)

// ---------------------------------------------------------------------------
console.log('\n[5] 审计不变量')
// ---------------------------------------------------------------------------

const aud = noThrow(() => auditMfg(db), '审计')
eq('自建场景跑完后审计 0 error', aud.error_count, 0)
eq('自建场景跑完后审计 0 warn', aud.warn_count, 0)

// 手工制造「出库无流水」：审计必须抓到。
// 注意要破坏的是**审计真正依赖的那个字段** —— 审计按 `t.doc_id = mi.id` 找流水，
// 所以这里动的是 doc_id。先前改成 doc_no 是「改了单据的另一个字段」，审计照样绿，
// 于是这条断言会一直绿着却什么都没验到（等于这项检查不存在）。
db.prepare("UPDATE inventory_transactions SET doc_id=-1 WHERE doc_type='MR' AND doc_id=?").run(issue.id)
const audBroken = auditMfg(db)
ok(audBroken.issues.some((x) => x.code === 'issue_without_txn'), '审计抓到「已出库但查不到库存流水」')
db.prepare("UPDATE inventory_transactions SET doc_id=? WHERE doc_type='MR' AND doc_id=-1").run(issue.id)
eq('恢复后审计重新归零', auditMfg(db).error_count, 0)

// 手工制造「订单完工数与汇报不符」：审计必须抓到
db.prepare('UPDATE production_orders SET completed_qty = completed_qty + 7 WHERE id=?').run(moId)
ok(auditMfg(db).issues.some((x) => x.code === 'order_completed_mismatch'), '审计抓到「订单完工数与已入库汇报良品数不符」')
db.prepare('UPDATE production_orders SET completed_qty = completed_qty - 7 WHERE id=?').run(moId)

// 手工制造「限额领料超领」：审计必须抓到
const overIssue = db.prepare("SELECT id FROM material_issues WHERE order_id=? AND issue_type='supplement'").get(moId)
if (overIssue) {
  db.prepare("UPDATE material_issues SET issue_type='limit' WHERE id=?").run(overIssue.id)
  ok(auditMfg(db).issues.some((x) => x.code === 'over_issue'), '审计抓到「限额领料出现超领」')
  db.prepare("UPDATE material_issues SET issue_type='supplement' WHERE id=?").run(overIssue.id)
}

// ---------------------------------------------------------------------------
console.log('\n[6] 总览与列表接口')
// ---------------------------------------------------------------------------

const ov = noThrow(() => mfgOverview(db), '总览')
ok(ov.orders.total >= 1, `总览统计到生产订单（${ov.orders.total}）`)
ok(ov.issues.issued >= 2, `总览统计到已出库领料单（${ov.issues.issued}）`)
ok(ov.reports.good_qty >= QTY, `总览统计到良品（${ov.reports.good_qty}）`)
ok(ov.reports.defect_rate > 0, `不良率大于 0（${ov.reports.defect_rate}%）`)

const bomOv = noThrow(() => bomOverview(db), 'BOM 总览')
ok(bomOv.total >= 1, `BOM 总数 >= 1（${bomOv.total}）`)
ok(bomOv.by_usage.self_made >= 1, '按用途统计：自制')

const bomList = noThrow(() => listBoms(db, { keyword: prod.sku_code, pageSize: 5 }), 'BOM 列表')
ok(bomList.list.some((b) => b.id === bom.id), 'BOM 列表能按母件编码搜到自己')
const issueList = noThrow(() => listIssues(db, { orderId: moId, pageSize: 10 }), '领料单列表')
eq('领料单列表条数（正常 + 补料）', issueList.total, 2)
const reportList = noThrow(() => listWorkReports(db, { orderId: moId, pageSize: 10 }), '汇报列表')
eq('汇报列表条数', reportList.total, 2)
const moDetail = noThrow(() => getProductionOrder(db, moId), '订单详情')
eq('订单详情含 2 张领料单', moDetail.issues.length, 2)
eq('订单详情含 2 张汇报', moDetail.reports.length, 2)
ok(!!moDetail.progress, '订单详情带进度视图')
// 注意：`issuedAmount` 本身已经是「正常单 + 补料单」两张之和，这里再加一次就会变成
// 「期望值 = 实际值 + 补料额」这种永远差一点的断言 —— 相加的地方只有一处。
okNear('进度视图的领料额 = 两张已出库领料单之和', moDetail.progress.issued_amount, issuedAmount, 0.01)
// 注意：这里要跟**订单当前的**完工数比，不能拿早先读过的 `moAfter`（那时只完工了 9 件）
okNear('进度视图的完工数与订单一致', moDetail.progress.completed_qty, num(getProductionOrder(db, moId).completed_qty), 0.001)

// 取 SKU 资料（编码与单位分散在两张表，这里钉住口径）
const info = getSkuInfo(db, prod.id)
eq('getSkuInfo 取到 SKU 编码（product_skus.sku_code）', info.code, prod.sku_code)
ok(!!info.unit, `getSkuInfo 能取到单位（来自 products.unit：${info.unit}）`)

// 只有草稿可删（用「任何用途都没 BOM」的母件，避免撞已有用途）
const draftBom = noThrow(() => createBom(db, {
  productSkuId: prodFree.id, usage: 'outsourced', items: [{ sku_id: comp.sku_id, qty: 1 }], remark: T, actor
}), '建委外草稿 BOM')
if (draftBom) {
  createdIds.boms.push(draftBom.id)
  const del = noThrow(() => deleteBom(db, { id: draftBom.id }), '删除草稿 BOM')
  eq('草稿 BOM 可以删除', del.deleted, true)
  eq('删除后查不到', getBom(db, draftBom.id), null)
  createdIds.boms = createdIds.boms.filter((x) => x !== draftBom.id)
}

// ---------------------------------------------------------------------------
console.log('\n[7] 清理与回滚')
// ---------------------------------------------------------------------------

const cleaned = purgeTestData()
const restored = restoreStocks()
const txnCount1 = db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c
const ledgerCount1 = db.prepare('SELECT COUNT(*) c FROM stock_cost_ledger').get().c
eq('清理后库存流水条数回到起点', txnCount1, txnCount0)
eq('清理后成本台账条数回到起点', ledgerCount1, ledgerCount0)
// 本轮应清理的流水恰好 5 条：领料 2 行 + 补料 1 行 + 完工入库 2 次。
// 写成精确值而不是 >=，是为了让「少清了一条」这种漏网立刻现形 —— 早先这里就是漏了那 2 条完工入库。
eq('清理掉的库存流水条数（领料 3 + 完工入库 2）', cleaned.txns, 5)
eq('清理掉的成本台账条数', cleaned.ledger, 5)
ok(cleaned.batches >= 1, `清理掉完工入库新建的批次（${cleaned.batches} 个）`)
ok(cleaned.boms >= 1 && cleaned.issues >= 2 && cleaned.orders >= 1,
  `清理了本测试造的单据（BOM ${cleaned.boms} / 领料 ${cleaned.issues} / 订单 ${cleaned.orders} / 汇报 ${cleaned.reports}）`)
ok(restored >= 0, `还原库存行 ${restored} 行`)
resetSequences(db, ['work_reports', 'material_issue_items', 'material_issues', 'bom_items', 'boms'])
eq('清理后审计归零（演示数据本身自洽）', auditMfg(db).error_count, 0)

// ---------------------------------------------------------------------------
console.log('\n[8] 闸门反例（M1 零领料完工 / M2 超产绕过 / M3 限额叠加 / M11 超领审计 / A6 留痕同生共死）')
// ---------------------------------------------------------------------------
// 这一段不是「再走一遍正常流程」，而是把**修之前真能跑通的那几条错路**钉成常驻断言。
// 本项目的「修完」定义里就有「反例进回归」—— 留在别处的反例等于没有人会再跑它。
//
// 五条共同的特征：**跑起来不报错、账却是错的**，所以界面与流程都看不出问题：
//   M1 一张领料单都没有也能完工入库 ⇒ 成品 0 材料成本入账；
//   M2 建汇报时合规、`PUT /reports/:id` 放大后照样按放大的数量入库；
//   M3 两张各自都不超领的限额单，依次出库后累计变成 2 × BOM 需求；
//   M11 审计第⑦项既不与需求比对（误报）又只看限额单（漏报）；
//   A6 留痕写在事务外 ⇒ 提交后崩溃就成了「动过但无痕」。
//
// 一句给下一位维护者的话：这些断言的**位置**和它的内容一样重要 ——
// 判据只有挂在「会真正执行到的那个分支」上才算数（本项目吃过"闸门挂在不跑的分支里"的亏）。
// 逐条注入验证（撤掉闸门 → 对应断言必须变红 → 还原后 sha256 逐位一致）在
// `scripts/inject-mfg-guards.mjs`：它在**临时副本**里注入，从不写仓库里的源码。

{
  const GATE_DATE = '2026-07-01'
  const mkOrder = (skuId, qty) => {
    const no = nextDocNo(db, 'MO', 'production_orders', 'doc_no', GATE_DATE)
    const id = Number(db.prepare(
      `INSERT INTO production_orders (doc_no,product_sku_id,warehouse_id,plan_date,status,qty,completed_qty,
         unit_cost,material_cost,total_cost,source_type,remark,created_by)
       VALUES (?,?,?,?, 'approved', ?,0,0,0,0, 'manual',?,null)`
    ).run(no, skuId, wh.id, GATE_DATE, qty, T).lastInsertRowid)
    createdIds.orders.push(id)
    return id
  }
  const issueAll = (orderId, type, items, remark) => {
    let i = createIssue(db, {
      orderId, warehouseId: wh.id, issueType: type, issueDate: GATE_DATE, actor, items, remark: remark || T
    })
    createdIds.issues.push(i.id)
    i = transitionIssue(db, { id: i.id, action: 'submit', actor })
    i = transitionIssue(db, { id: i.id, action: 'approve', actor })
    return transitionIssue(db, { id: i.id, action: 'issue', actor })
  }

  // 本段要自己一张 BOM：上一段的 BOM 已在 [7] 里连组件行一起清掉了。
  // 单件用量 1.5、损耗 0.1 ⇒ 每件 1.65，便于逐位核对需求。
  const bom2 = noThrow(() => createBom(db, {
    productSkuId: prod.id, usage: 'self_made', baseQty: 1, effectiveFrom: '2020-01-01',
    items: [{ sku_id: comp.sku_id, qty: 1.5, loss_rate: 0.1 }], remark: T, actor
  }), '建反例用 BOM')
  if (bom2) {
    createdIds.boms.push(bom2.id)
    noThrow(() => auditBom(db, { id: bom2.id, actor }), '审批反例用 BOM')
  }
  ok(!!bom2, '✓ 反例用 BOM 建成（每件用料 1.65）')

  // ---- M1：一张领料单都没有，不能完工入库 --------------------------------
  // 反常的地方在于：**它什么都不缺** —— 订单在生产中、汇报也登记了、数量也合规，
  // 只是没有任何料出库。修之前这一步会成功，然后 `material_cost = 0`、
  // 库存里凭空多一批货、成本账上只有转换成本。
  {
    const mo = mkOrder(prod.id, 10)
    startOrder(db, { orderId: mo, actor })
    createdIds.reports.push(createWorkReport(db, { orderId: mo, goodQty: 10, defectQty: 0, actor, remark: T }).id)
    throws(() => completeOrder(db, { orderId: mo, actor }), 'MFG_NO_ISSUED_MATERIAL',
      '零领料时完工入库被拒（钱可以不给、料不能不出：没有领料就没有材料成本）')
    eq('被拒后订单仍是生产中', getProductionOrder(db, mo).status, 'in_progress')
    eq('被拒后订单材料成本仍为 0（没有被写成"入库成功"的假账）', num(getProductionOrder(db, mo).material_cost), 0)
    eq('被拒后没有产生入库流水', db.prepare("SELECT COUNT(*) c FROM inventory_transactions WHERE doc_type='MO' AND doc_id=?").get(mo).c, 0)
  }

  // ---- M1 逃逸口：确实无料可领（该成品没有任何生效 BOM）时应当放行 --------
  // 判据是「BOM 需求 > 0 才拦」，不是「一律要有一张领料单」——
  // 一笔没有原料组成的成品（无 BOM）如果连完工都拦，就永远完不了工，
  // 那是「没维护 BOM」这个数据缺口，由总览的「能生产但没 BOM」单独暴露。
  if (!prodFree) {
    console.log('  （跳过：该行业没有「无任何 BOM」的自制成品）')
  } else {
    const mo = mkOrder(prodFree.id, 5)
    startOrder(db, { orderId: mo, actor })
    const reqFree = noThrow(() => planRequirement(db, { orderId: mo, includeIssued: true }), '无 BOM 订单的需求展开')
    eq('无生效 BOM ⇒ 需求为 0（放行口的前提）', num(reqFree?.summary?.required_qty), 0)
    createdIds.reports.push(createWorkReport(db, { orderId: mo, goodQty: 5, defectQty: 0, actor, remark: T }).id)
    const doneFree = noThrow(() => completeOrder(db, { orderId: mo, actor }), '无料可领时完工入库')
    eq('无料可领时不把「领不到料」变成「完不了工」', num(doneFree?.stock_in_qty), 5)
  }

  // ---- M1 边界：BOM 存在但没有组件行（历史数据）⇒ 判不出需求，fail-closed --
  // 「无料可领」的放行口只能开在**确实判得出需求为 0** 的时候。
  // BOM 建了却没有组件行时展开会直接报错，此时需求是"未知"——
  // 未知不许放行：宁可让人去修 BOM，也不要让成品 0 成本入账。
  {
    const mo = mkOrder(prod.id, 10)
    startOrder(db, { orderId: mo, actor })
    createdIds.reports.push(createWorkReport(db, { orderId: mo, goodQty: 10, defectQty: 0, actor, remark: T }).id)
    const savedItems = db.prepare('SELECT * FROM bom_items WHERE bom_id=? ORDER BY line_no').all(bom2.id)
    db.prepare('DELETE FROM bom_items WHERE bom_id=?').run(bom2.id)
    try {
      throws(() => completeOrder(db, { orderId: mo, actor }), null,
        'BOM 没有组件行（需求判不出）时不得放行 0 成本入库，报的是 BOM 本来的错')
    } finally {
      for (const it of savedItems) {
        const keys = Object.keys(it)
        db.prepare(`INSERT INTO bom_items (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
          .run(...keys.map((k) => it[k]))
      }
    }
    eq('BOM 组件行已还原', db.prepare('SELECT COUNT(*) c FROM bom_items WHERE bom_id=?').get(bom2.id).c, savedItems.length)
  }

  // ---- M2：超产入库（改单绕过 + 落库兜底）--------------------------------
  // `PUT /reports/:id` 把良品数放大，是最短的一条绕过路径；
  // 而真正要守住的是**最终落库那一步**（库存加分 + 订单完工数回写）。
  {
    const mo = mkOrder(prod.id, 10)
    startOrder(db, { orderId: mo, actor })
    issueAll(mo, 'by_bom', null)
    const wr = createWorkReport(db, { orderId: mo, goodQty: 1, defectQty: 0, actor, remark: T })
    createdIds.reports.push(wr.id)
    throws(() => updateWorkReport(db, { id: wr.id, goodQty: 9999 }), 'MFG_OVER_COMPLETE',
      '改汇报放大良品数被拒（订单 10，改后 9999）')
    // 绕过接口、直接把库里的良品数改大 —— 闸门必须挂在会落库的那一步，否则这条就是漏洞
    db.prepare('UPDATE work_reports SET good_qty=9999 WHERE id=?').run(wr.id)
    throws(() => completeOrder(db, { orderId: mo, actor }), 'MFG_OVER_COMPLETE',
      '完工入库复校累计良品 ≤ 订单数量（汇报 9999 > 订单 10）')
    eq('被拒后订单完工数没有被写成 9999', num(getProductionOrder(db, mo).completed_qty), 0)
    eq('被拒后没有产生入库流水', db.prepare("SELECT COUNT(*) c FROM inventory_transactions WHERE doc_type='MO' AND doc_id=?").get(mo).c, 0)
  }

  // ---- M3：限额领料的上限不能被两张单叠加突破 ---------------------------
  // 建单时每张都不超领（各自按"当时的待领量"看是合规的），
  // 但出库时累计已经领满 ⇒ 第二张必须被拦 —— 闸门要挂在窗口的出口。
  {
    const mo = mkOrder(prod.id, 10)
    startOrder(db, { orderId: mo, actor })
    const need = num(planRequirement(db, { orderId: mo }).summary.required_qty)
    okNear('该订单 BOM 需求 = 1.5 × 1.1 × 10', need, 16.5, 1e-6)
    const first = createIssue(db, {
      orderId: mo, warehouseId: wh.id, issueType: 'limit', issueDate: GATE_DATE, actor,
      items: [{ sku_id: comp.sku_id, qty: need }], remark: T
    })
    createdIds.issues.push(first.id)
    const second = createIssue(db, {
      orderId: mo, warehouseId: wh.id, issueType: 'limit', issueDate: GATE_DATE, actor,
      items: [{ sku_id: comp.sku_id, qty: need }], remark: T
    })
    createdIds.issues.push(second.id)
    ok(!!first.id && !!second.id, '两张限额单各自都不超领 ⇒ 建单都通过（窗口就开在这里）')
    let fi = transitionIssue(db, { id: first.id, action: 'submit', actor })
    fi = transitionIssue(db, { id: fi.id, action: 'approve', actor })
    fi = transitionIssue(db, { id: fi.id, action: 'issue', actor })
    eq('第一张出库后状态', fi.status, 'issued')
    let si = transitionIssue(db, { id: second.id, action: 'submit', actor })
    si = transitionIssue(db, { id: si.id, action: 'approve', actor })
    throws(() => transitionIssue(db, { id: second.id, action: 'issue', actor }), 'MFG_OVER_ISSUE',
      '第二张限额单出库被拒（再出一次累计就是 2 × BOM 需求）')
    const issuedQty = num(db.prepare(
      "SELECT COALESCE(SUM(total_qty),0) AS q FROM material_issues WHERE order_id=? AND status='issued'"
    ).get(mo).q)
    okNear('被拒后累计已出库 = BOM 需求（不多领一分）', issuedQty, need, 1e-6)
  }

  // ---- M11：审计第⑦项既不能误报、也不能漏报 -----------------------------
  // ① 两张各自不超领、**合计正好等于需求**的限额单：一条告警都不该有。
  //    修之前是无条件 push（只要 `issued AND limit`），实测一次误报 2 条 ——
  //    误报的代价不是多一行字，是这一项从此没人看。
  // ② 按 BOM 领料单领到远超需求、又没有任何补料单解释：必须抓到（修之前范围里只有 limit）。
  {
    const mo = mkOrder(prod.id, 4)
    startOrder(db, { orderId: mo, actor })
    const need = num(planRequirement(db, { orderId: mo }).summary.required_qty)
    const a = issueAll(mo, 'limit', [{ sku_id: comp.sku_id, qty: need / 2 }])
    const b = issueAll(mo, 'limit', [{ sku_id: comp.sku_id, qty: need / 2 }])
    const audOk = auditMfg(db)
    const falsePositive = audOk.issues.filter((x) => x.code === 'over_issue' && [a.doc_no, b.doc_no].includes(x.ref))
    eq('两张各自不超领、合计等于需求的限额单：0 条超领告警（不误报）', falsePositive.length, 0)

    const big = issueAll(mo, 'by_bom', [{ sku_id: comp.sku_id, qty: 40 }])
    const caught = auditMfg(db).issues.filter((x) => x.code === 'over_issue' && x.ref === big.doc_no)
    eq('按 BOM 领料超出需求且无补料单解释：1 条超领告警（不漏报）', caught.length, 1)
    ok(/超过 BOM 需求/.test(caught[0]?.message || ''), `告警说的是需求比对而不是"存在超领记录"（${caught[0]?.message || '无'}）`)
  }

  // ---- M11 对照：**有补料单解释**的超领不是异常 ---------------------------
  // 补料是口径② 明确允许的显式超领（必须填原因、留痕），把它判成异常就是新的误报。
  {
    const mo = mkOrder(prod.id, 4)
    startOrder(db, { orderId: mo, actor })
    const need = num(planRequirement(db, { orderId: mo }).summary.required_qty)
    issueAll(mo, 'limit', [{ sku_id: comp.sku_id, qty: need }])
    const sup = issueAll(mo, 'supplement', [{ sku_id: comp.sku_id, qty: 1 }], `${T} 熟制损耗超预期`)
    const hit = auditMfg(db).issues.filter((x) => x.code === 'over_issue' && x.ref === sup.doc_no)
    eq('补料单（合法超领、原因已记）不被判超领', hit.length, 0)
  }

  // ---- A6：出库留痕与出库同生共死 ----------------------------------------
  // 留痕写不进去时，出库必须整体回滚：不能出现「库存动了、金额写了、留痕没写」。
  // 修之前这条 INSERT 在事务外、还套着 `try/catch {}`（异常被吞）——
  // 于是这种"动过但无痕"的单据可以安静地留在库里。
  {
    const mo = mkOrder(prod.id, 10)
    startOrder(db, { orderId: mo, actor })
    let i = createIssue(db, { orderId: mo, warehouseId: wh.id, issueType: 'by_bom', issueDate: GATE_DATE, actor, remark: T })
    createdIds.issues.push(i.id)
    i = transitionIssue(db, { id: i.id, action: 'submit', actor })
    i = transitionIssue(db, { id: i.id, action: 'approve', actor })
    const stock0 = num(db.prepare(
      'SELECT COALESCE(SUM(qty_on_hand),0) AS q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?'
    ).get(wh.id, comp.sku_id).q)
    // 注入"留痕写不进去"：只在**这一个进程内**替换 db.prepare，finally 一定还原
    const origPrepare = db.prepare.bind(db)
    db.prepare = (sql) => (/INSERT INTO doc_events/i.test(sql)
      ? { run() { throw new Error('注入：留痕写入失败') } }
      : origPrepare(sql))
    let boom = null
    try { transitionIssue(db, { id: i.id, action: 'issue', actor }) } catch (e) { boom = e }
    finally { db.prepare = origPrepare }
    ok(!!boom, '留痕写不进去时出库会抛错（而不是吞掉异常照样出库）')
    eq('留痕失败后单据留在 approved（整体回滚）', getIssue(db, i.id).status, 'approved')
    const stock1 = num(db.prepare(
      'SELECT COALESCE(SUM(qty_on_hand),0) AS q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?'
    ).get(wh.id, comp.sku_id).q)
    okNear('留痕失败后库存一分没动', stock1, stock0, 1e-6)
  }

  // ---- 反例场景的清理：一切回到起点 -------------------------------------
  const cleaned2 = purgeTestData()
  const restored2 = restoreStocks()
  eq('反例场景清理后库存流水条数回到起点', db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c, txnCount0)
  eq('反例场景清理后成本台账条数回到起点', db.prepare('SELECT COUNT(*) c FROM stock_cost_ledger').get().c, ledgerCount0)
  ok(cleaned2.orders >= 6 && cleaned2.issues >= 5, `反例场景清理了自己的单据（订单 ${cleaned2.orders} / 领料 ${cleaned2.issues} / 流水 ${cleaned2.txns} / 台账 ${cleaned2.ledger}）`)
  ok(restored2 >= 0, `反例场景还原库存行 ${restored2} 行`)
  resetSequences(db, ['work_reports', 'material_issue_items', 'material_issues', 'bom_items', 'boms'])
  const audFinal = auditMfg(db)
  eq('反例场景清理后审计归零（错误）', audFinal.error_count, 0)
  eq('反例场景清理后审计归零（警告）—— 误报不许留在库里', audFinal.warn_count, 0)
}

// ---------------------------------------------------------------------------
console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`)
if (fail) {
  console.log('失败项：')
  for (const f of fails) console.log('  -', f)
  process.exit(1)
}
