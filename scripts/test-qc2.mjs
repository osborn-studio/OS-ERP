/**
 * ============================================================================
 * 文件标识：scripts/test-qc2.mjs ｜ 测试：质量检验测试（模块 13 · 报检 QCR / 检验 QCI / 不良品处理 DH）
 * ============================================================================
 * 【职责】测试：质量检验测试（模块 13 · 报检 QCR / 检验 QCI / 不良品处理 DH）
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
 * 质量检验测试（模块 13 · 报检 QCR / 检验 QCI / 不良品处理 DH）
 *
 * 这个模块最容易出的错不是崩溃，而是**结论与数字对不上**：
 * 界面上写着「合格」而行里不良数是 5；或者同一批不良品被退两次货。
 * 这类错误不抛异常、不留红字，只会让人慢慢不再相信系统。所以本测试的重心不是
 * 「接口能不能调通」，而是把下列口径一条条钉死：
 *
 *   ① **判定由数字推导，不由人选**：不良数 = Ac 判合格、= Ac+1 判不合格，
 *      两个边界都要实测（差一个数结论就翻，是最容易写错的地方）；
 *   ② **抽样量 ≤ 报检数量、不良数 ≤ 抽样量**：不成立必须被拦，且拦在写库之前；
 *   ③ **四路分流各有后果，而且都要真的动库存**：退货 → 采购退货单（PRT，采购来源）/
 *      质检退料出库（QC_RET_OUT，其它来源）；报废 → SCRAP_OUT；让步 → 自动生成调拨单
 *      进**不合格品仓**；返工 → 自动生成调拨单进**待检品仓**（后两者出库 + 入库都真的发生，
 *      并断言"两仓合计不变"的数量守恒）。
 *   ④ **处置有上限**：同一行的处置数量合计不得超过报检数量（不能退两次货）；
 *   ⑤ **链会自动收口**：全部合格直接关；有不合格则等处置单全部执行完再关。
 *
 * 与定价 / 成本 / 发票 / 应收测试同一规矩：**串行跑**
 * （并行写同一个 SQLite 会 WAL 竞争）。用法：node scripts/test-qc2.mjs [industry]
 *
 * 关于「可重复跑」：
 *   本模块是全项目里唯一**真的会扣库存**的服务层（报废 / 退货都要出库）。
 *   只删单据不还原库存，第二轮就会因为「库存不足」而失败，或者更糟 ——
 *   悄悄把演示库的库存越扣越少。所以这里用**快照回滚**：
 *   开跑前把 inventory_stocks 全表拍一张快照，跑完按 id 逐行还原；
 *   同时按单据号删掉本轮的 inventory_transactions / stock_cost_ledger 流水。
 *   这不是「绕过业务」——流水本来就不该留下，因为业务单据本身被删了。
 */
import { getDbFor } from '../server/db/index.js'
import {
  QC2Error, samplingPlan, SAMPLE_TABLE, directionOf, DISPOSITION_TARGET,
  pendingSources, sourceDetail,
  createRequest, submitRequest, getRequest, listRequests, transitionRequest,
  getInspection, listInspections, submitInspection, transitionInspection,
  createHandling, confirmHandling, cancelHandling, getHandling, listHandlings,
  qcOverview, auditQc
} from '../server/lib/qc2.js'
import { applyTransition } from '../server/lib/docflow.js'

const INDUSTRY = process.argv[2] || 'cosmetic'
const db = getDbFor(INDUSTRY)

let pass = 0
let fail = 0
const only = []
function ok(cond, msg) {
  if (cond) pass++
  else { fail++; only.push(msg); console.log('  ✗', msg) }
}
function eq(msg, actual, expect) {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  ✗ ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps
const okNear = (a, b, msg, eps = 0.005) => {
  if (!near(a, b, eps)) console.log(`  ✗ ${msg}：期望≈${b}，实际 ${a}`)
  ok(near(a, b, eps), msg)
}
const num = (v) => Number(v) || 0
const throws = (fn, code, msg) => {
  try { fn() } catch (e) {
    const hit = !code || (e instanceof QC2Error && e.code === code) || e.code === code
    if (!hit) console.log(`  ✗ ${msg}：抛的是 ${e.code || e.name}/${e.message}`)
    ok(hit, msg)
    return
  }
  console.log(`  ✗ ${msg}：没有抛错`)
  ok(false, msg)
}
const noThrow = (fn, msg) => {
  try { fn(); ok(true, msg) } catch (e) {
    console.log(`  ✗ ${msg}：意外抛错 ${e.code || e.name}/${e.message}`)
    ok(false, msg)
  }
}

console.log(`\n=== 质量检验（模块 13 · ${INDUSTRY}） ===`)

// ---------------------------------------------------------------------------
// -1. 快照与残留自愈
// ---------------------------------------------------------------------------
// 标记约定：报检单 remark、处理单 remark 一律以 '【TEST-QC2】' 开头；
// 采购退货单没有 remark 字段，只能靠 reason 认 —— 退货处置的 reason 里带标记，
// confirmHandling 会把它拼进 PRT 的 reason（`质检判退（QCI…）：<reason>`），
// 所以「按标记认 PRT」这条路是通的。
const TEST_TAG = '【TEST-QC2】'
const ph = (n) => Array.from({ length: n }, () => '?').join(',')

// 库存快照：全表。演示库最多千余行，拍/还原都在毫秒级，比「想办法反推」
// 可靠得多 —— 反推要假设出库时用的单价、批次，等于把被测逻辑再写一遍。
const STOCK_COLS = [
  'id', 'warehouse_id', 'owner_org_id', 'sku_id', 'batch_no', 'currency',
  'produce_date', 'expire_date', 'expire_at', 'entry_date', 'location',
  'qty_on_hand', 'qty_reserved', 'qty_in_transit', 'qty_ordered',
  'cost_price', 'cost_amount', 'last_in_at', 'last_out_at', 'updated_at'
]
const stockSnapshot = new Map(
  db.prepare(`SELECT ${STOCK_COLS.join(',')} FROM inventory_stocks`).all()
    .map((r) => [r.id, r])
)

function testRequestIds() {
  return db.prepare('SELECT id FROM qc_requests WHERE remark LIKE ?').all(`${TEST_TAG}%`).map((r) => r.id)
}

/**
 * 隔离仓（不合格品仓 / 待检品仓）的**崩溃残渣**行。
 *
 * 判据：隔离仓里有一行库存，却在**那个仓**找不到任何库存流水。
 * 为什么这个判据成立：这两类仓不参与期初铺货（`seed.js` 按类型排除），
 * 也不参与销售/配货，仓里的货**只可能**由质检处置的调拨单搬进来 ——
 * 而调拨必然在该仓留下一条 TR_IN 流水。所以「有货无流水」只有一种解释：
 * 上一次本测试中途崩了，purge 删了流水与调拨单，却没删掉那条新造的库存行。
 * 不清理的后果不是"多一点脏数据"，而是后续的账实自检（test-costing 的
 * 「流水累计 vs 结存金额」）会拿这行去对账、报出一个与本次改动无关的假红。
 */
function isolationResidueRows() {
  return db
    .prepare(
      `SELECT s.id FROM inventory_stocks s
         JOIN warehouses w ON w.id = s.warehouse_id
        WHERE w.type IN ('defect','quarantine')
          AND NOT EXISTS (
            SELECT 1 FROM inventory_transactions t
             WHERE t.warehouse_id = s.warehouse_id AND t.sku_id = s.sku_id
               AND IFNULL(t.batch_no,'') = IFNULL(s.batch_no,''))`
    )
    .all()
    .map((r) => r.id)
}

/** 清掉本轮留下的全部单据 + 流水；返回清理计数。可在开头与结尾各跑一次。 */
function purgeTestData() {
  const rid = testRequestIds()
  const iids = rid.length
    ? db.prepare(`SELECT id FROM qc_inspections WHERE request_id IN (${ph(rid.length)})`).all(...rid).map((r) => r.id)
    : []
  const dhRows = db
    .prepare(
      `SELECT id, doc_no, out_doc_type, out_doc_id FROM qc_defect_handlings
        WHERE remark LIKE ? ${rid.length ? `OR request_id IN (${ph(rid.length)})` : ''}`
    )
    .all(`${TEST_TAG}%`, ...rid)
  const dhIds = dhRows.map((r) => r.id)
  const prtRows = db.prepare("SELECT id, doc_no FROM purchase_returns WHERE reason LIKE ?").all(`%${TEST_TAG}%`)
  const prtIds = prtRows.map((r) => r.id)
  // 让步 / 返工会**自动生成调拨单**（TF）。它挂在处置单的 out_doc_type/out_doc_id 上，
  // 所以这里能精确定位到本轮生成的那几张 —— 只删本轮造的，不碰演示数据里的 20 张调拨单。
  const tfIds = dhRows.filter((r) => r.out_doc_type === 'TF' && r.out_doc_id != null).map((r) => r.out_doc_id)
  const tfRows = tfIds.length
    ? db.prepare(`SELECT id, doc_no FROM stock_transfers WHERE id IN (${ph(tfIds.length)})`).all(...tfIds)
    : []
  const outDocNos = [...dhRows.map((r) => r.doc_no), ...prtRows.map((r) => r.doc_no), ...tfRows.map((r) => r.doc_no)]

  const counts = { requests: rid.length, inspections: iids.length, handlings: dhIds.length, returns: prtIds.length, transfers: tfIds.length, txns: 0, ledger: 0 }
  db.transaction(() => {
    // 1) 库存流水按「单据号 / 单据 id」精确删 —— 只删本轮产生的，不碰演示数据的账
    const txnWhere = []
    const txnArgs = []
    if (dhIds.length) {
      txnWhere.push(`(doc_type IN ('SCRAP_OUT','QC_RET_OUT') AND doc_id IN (${ph(dhIds.length)}))`)
      txnArgs.push(...dhIds)
    }
    if (prtIds.length) {
      txnWhere.push(`(doc_type='PUR_RET' AND doc_id IN (${ph(prtIds.length)}))`)
      txnArgs.push(...prtIds)
    }
    if (tfIds.length) {
      // 调拨两侧的流水都要删：留一半会让「无本轮残留流水」这条自检变红，
      // 而且下一轮的库存快照会把残留当成"演示数据"。
      txnWhere.push(`(doc_type IN ('TR_OUT','TR_IN') AND doc_id IN (${ph(tfIds.length)}))`)
      txnArgs.push(...tfIds)
    }
    if (txnWhere.length) {
      counts.txns = db.prepare(`DELETE FROM inventory_transactions WHERE ${txnWhere.join(' OR ')}`).run(...txnArgs).changes
    }
    if (outDocNos.length) {
      counts.ledger = db
        .prepare(`DELETE FROM stock_cost_ledger WHERE doc_no IN (${ph(outDocNos.length)})`)
        .run(...outDocNos).changes
    }

    // 2) 采购退货单（本轮生成的）与其明细、留痕
    if (prtIds.length) {
      db.prepare(`DELETE FROM purchase_return_items WHERE return_id IN (${ph(prtIds.length)})`).run(...prtIds)
      db.prepare(`DELETE FROM doc_events WHERE doc_type='PRT' AND doc_id IN (${ph(prtIds.length)})`).run(...prtIds)
      db.prepare(`DELETE FROM purchase_returns WHERE id IN (${ph(prtIds.length)})`).run(...prtIds)
    }

    // 2b) 本轮自动生成的调拨单：留痕 → 明细 → 单头
    if (tfIds.length) {
      db.prepare(`DELETE FROM doc_events WHERE doc_type='TF' AND doc_id IN (${ph(tfIds.length)})`).run(...tfIds)
      db.prepare(`DELETE FROM stock_transfer_items WHERE transfer_id IN (${ph(tfIds.length)})`).run(...tfIds)
      db.prepare(`DELETE FROM stock_transfers WHERE id IN (${ph(tfIds.length)})`).run(...tfIds)
    }

    // 3) 质检三单（DH → QCI → QCR，顺序不能反：外键在 DH 上）
    if (dhIds.length) {
      db.prepare(`DELETE FROM doc_events WHERE doc_type='DH' AND doc_id IN (${ph(dhIds.length)})`).run(...dhIds)
      db.prepare(`DELETE FROM qc_defect_handlings WHERE id IN (${ph(dhIds.length)})`).run(...dhIds)
    }
    if (iids.length) {
      db.prepare(`DELETE FROM doc_events WHERE doc_type='QCI' AND doc_id IN (${ph(iids.length)})`).run(...iids)
      db.prepare(`DELETE FROM qc_inspections WHERE id IN (${ph(iids.length)})`).run(...iids)
    }
    if (rid.length) {
      db.prepare(`DELETE FROM doc_events WHERE doc_type='QCR' AND doc_id IN (${ph(rid.length)})`).run(...rid)
      db.prepare(`DELETE FROM qc_request_items WHERE request_id IN (${ph(rid.length)})`).run(...rid)
      db.prepare(`DELETE FROM qc_requests WHERE id IN (${ph(rid.length)})`).run(...rid)
    }

    // 4) 孤儿留痕统统扫一遍（中间态被打断时最容易在这里留渣）
    for (const [docType, table] of [['QCR', 'qc_requests'], ['QCI', 'qc_inspections'], ['DH', 'qc_defect_handlings'], ['PRT', 'purchase_returns']]) {
      db.prepare(`DELETE FROM doc_events WHERE doc_type=? AND doc_id NOT IN (SELECT id FROM ${table})`).run(docType)
    }
  })()
  return counts
}

/** 库存快照还原：只改被动过的行，且只在值不同时才写；**本轮新造的行直接删掉**。
 *
 * 为什么要删新行：让步 / 返工现在会把货调拨进「不合格品仓 / 待检品仓」，
 * 那两个仓原来没有这个批次的行 ⇒ 一次处置就多一行 `inventory_stocks`。
 * 只还原老行不删新行的话，第二轮会看到上一轮留下的货（断言全乱），
 * 而且「库存行数未变」这条自检会一次比一次红。
 * 删的条件是「快照里没有」—— 快照就是本轮开始前的全表，所以删掉的一定是本轮新造的。 */
function restoreStocks() {
  const cur = db.prepare(`SELECT ${STOCK_COLS.join(',')} FROM inventory_stocks`).all()
  let fixed = 0
  let removed = 0
  const upd = db.prepare(
    `UPDATE inventory_stocks SET qty_on_hand=?, cost_price=?, cost_amount=?, last_in_at=?, last_out_at=?, updated_at=? WHERE id=?`
  )
  const del = db.prepare('DELETE FROM inventory_stocks WHERE id=?')
  db.transaction(() => {
    for (const r of cur) {
      const s = stockSnapshot.get(r.id)
      if (!s) {
        del.run(r.id)
        removed++
        continue
      }
      if (
        Math.abs(num(r.qty_on_hand) - num(s.qty_on_hand)) > 1e-6 ||
        Math.abs(num(r.cost_price) - num(s.cost_price)) > 1e-6 ||
        Math.abs(num(r.cost_amount) - num(s.cost_amount)) > 1e-6 ||
        (r.last_out_at || '') !== (s.last_out_at || '') ||
        (r.updated_at || '') !== (s.updated_at || '')
      ) {
        upd.run(s.qty_on_hand, s.cost_price, s.cost_amount, s.last_in_at, s.last_out_at, s.updated_at, r.id)
        fixed++
      }
    }
  })()
  return { fixed, removed }
}

const cleaned0 = purgeTestData()
if (cleaned0.requests || cleaned0.handlings || cleaned0.returns) {
  console.log(
    `  （已清理上一轮残留：报检 ${cleaned0.requests} / 检验 ${cleaned0.inspections} / 处置 ${cleaned0.handlings} / 退货 ${cleaned0.returns}）`
  )
}
const isolated0 = isolationResidueRows()
if (isolated0.length) {
  // 必须**同时**从快照里摘掉：留在快照里的话它会被当成"演示数据"，
  // 结尾的「库存行数未变」反而会红。
  db.prepare(`DELETE FROM inventory_stocks WHERE id IN (${ph(isolated0.length)})`).run(...isolated0)
  for (const id of isolated0) stockSnapshot.delete(id)
  console.log(`  （清理隔离仓崩溃残渣：${isolated0.length} 行 —— 隔离仓里有货却查不到任何流水）`)
}
const restored0 = restoreStocks()
if (restored0.fixed || restored0.removed) {
  console.log(`  （上一轮残留的库存变动已还原：${restored0.fixed} 行改回，${restored0.removed} 行新造的行已删除）`)
}

const txnMax = db.prepare('SELECT IFNULL(MAX(id),0) m FROM inventory_transactions').get().m
const ledgerMax = db.prepare('SELECT IFNULL(MAX(id),0) m FROM stock_cost_ledger').get().m
const txnCount0 = db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c
const ledgerCount0 = db.prepare('SELECT COUNT(*) c FROM stock_cost_ledger').get().c
const pending0 = pendingSources(db, { limit: 999 }).length
const requestCount0 = db.prepare('SELECT COUNT(*) c FROM qc_requests').get().c

// 崩溃兜底（fix-ltype 报的坑，这里收掉）：
//   本脚本靠「快照回滚 + 按单号删本轮流水」保证可重复跑，但这套机制只在**正常结束**时生效；
//   中途抛异常（断言里解引用 undefined、被并发改坏的代码、没有隔离仓的旧库……）会跳过清理，
//   库里就留下本轮的库存变动与**新造的隔离仓库存行**。后续任何人跑账实自检
//   （test-costing 的「流水累计 vs 结存金额」）都会看到与本次改动无关的残差 —— 实测踩到过 5 条假红。
//   ⇒ 只有走到结尾才置 finished；否则退出时补跑一次清理 + 库存还原。
let finished = false
process.on('exit', () => {
  if (finished) return
  try {
    purgeTestData()
    const r = restoreStocks()
    console.log(`\n  （异常退出：已补跑清理与库存还原 —— 还原 ${r.fixed} 行 / 删除新造 ${r.removed} 行，避免把残差留给后续测试）`)
  } catch (e) {
    console.log(`\n  （异常退出补清理失败，请重建落点库：${e.message}）`)
  }
})

const stockOf = (warehouseId, skuId, batchNo) =>
  db
    .prepare(
      `SELECT * FROM inventory_stocks
        WHERE warehouse_id=? AND sku_id=? AND IFNULL(batch_no,'')=? ORDER BY id LIMIT 1`
    )
    .get(warehouseId, skuId, batchNo || '')

/** 没有库存行时按 0 计 —— 「不动库存」的断言不能用 undefined 自我满足 */
const stockQty = (warehouseId, skuId, batchNo) => {
  const r = stockOf(warehouseId, skuId, batchNo)
  return r ? num(r.qty_on_hand) : 0
}

/** 取一个「有货可扣」的库存行，用于在库复检类用例（报废 / 退料都需要真出库） */
function pickFatStock(minQty = 60) {
  return db
    .prepare(
      `SELECT warehouse_id, sku_id, batch_no, qty_on_hand, qty_reserved, currency, owner_org_id
         FROM inventory_stocks
        WHERE qty_on_hand - qty_reserved >= ? AND sku_id IS NOT NULL
        ORDER BY qty_on_hand DESC LIMIT 1`
    )
    .get(minQty)
}

// ---------------------------------------------------------------------------
// 0. 内核注册
// ---------------------------------------------------------------------------
console.log('\n0. 单据内核注册')
const types = db.prepare('SELECT code FROM doc_types').all().map((r) => r.code)
for (const t of ['QCR', 'QCI', 'DH']) ok(types.includes(t), `内核已注册 ${t}`)
const st = (t) => db.prepare('SELECT code FROM doc_states WHERE doc_type=?').all(t).map((r) => r.code).sort()
eq('QCR 四状态', st('QCR'), ['cancelled', 'closed', 'draft', 'submitted'])
eq('QCI 四状态', st('QCI'), ['cancelled', 'closed', 'draft', 'inspected'])
eq('DH 三状态', st('DH'), ['cancelled', 'confirmed', 'draft'])
ok(db.prepare("SELECT 1 h FROM doc_actions WHERE doc_type='QCR' AND action='submit'").get(), 'QCR 有提交动作')
ok(db.prepare("SELECT 1 h FROM doc_actions WHERE doc_type='QCI' AND action='inspect'").get(), 'QCI 有检验动作')
const dhConfirm = db.prepare("SELECT is_danger FROM doc_actions WHERE doc_type='DH' AND action='confirm'").get()
ok(dhConfirm && dhConfirm.is_danger === 1, 'DH 执行标为危险动作（有库存后果）')
ok(db.prepare("SELECT is_final FROM doc_states WHERE doc_type='DH' AND code='confirmed'").get().is_final === 1, 'DH 已执行是终态')
ok(db.prepare("SELECT is_final FROM doc_states WHERE doc_type='QCI' AND code='inspected'").get().is_final === 0, 'QCI 已检不是终态（还要处置）')
ok(db.prepare("SELECT 1 h FROM biz_flows WHERE code='FLOW_QUALITY'").get(), '业务流 FLOW_QUALITY 已注册')
const flowSteps = db.prepare("SELECT COUNT(*) c FROM biz_flow_steps WHERE flow_code='FLOW_QUALITY'").get().c
eq('质量流程 5 步', flowSteps, 5)
ok(db.prepare("SELECT 1 h FROM inv_txn_types WHERE code='QC_RET_OUT'").get(), '库存事务类型字典含 QC_RET_OUT')

// ---------------------------------------------------------------------------
// 1. 抽样方案（纯函数，不碰库）
// ---------------------------------------------------------------------------
console.log('\n1. 抽样方案与判定边界')
const s8 = samplingPlan(8)
eq('批量 8 → 方案 A', [s8.code, s8.sample_qty, s8.ac, s8.re], ['A', 2, 0, 1])
const s9 = samplingPlan(9)
eq('批量 9 → 跨到方案 B', [s9.code, s9.sample_qty, s9.ac], ['B', 3, 0])
eq('批量 500 → 方案 H', (() => { const x = samplingPlan(500); return [x.code, x.sample_qty, x.ac] })(), ['H', 50, 3])
eq('批量 501 → 方案 J', (() => { const x = samplingPlan(501); return [x.code, x.sample_qty, x.ac] })(), ['J', 80, 5])
const sTight = samplingPlan(500, 'tightened')
eq('加严只调 Ac 不调 n', [sTight.sample_qty, sTight.ac, sTight.re], [50, 2, 3])
const sReduce = samplingPlan(500, 'reduced')
eq('放宽只调 Ac 不调 n', [sReduce.sample_qty, sReduce.ac, sReduce.re], [50, 4, 5])
const sTight0 = samplingPlan(20, 'tightened')
eq('Ac=0 加严不为负', sTight0.ac, 0)
const sTiny = samplingPlan(1)
eq('批量小于样本量 → 全检', sTiny.sample_qty, 1)
const sZero = samplingPlan(0)
eq('批量 0 → 仍给最小样本 1', sZero.sample_qty, 1)
let monotone = true
for (let lot = 1; lot <= 1300; lot++) {
  const p = samplingPlan(lot)
  if (p.sample_qty > lot || p.sample_qty < 1 || p.ac >= p.re) { monotone = false; break }
}
ok(monotone, '1..1300 批量区间内：样本量 ≤ 批量、Ac < Re 恒成立')
eq('全表 Re = Ac + 1', SAMPLE_TABLE.every((r) => r.re === r.ac + 1), true)
eq('让步接收 → 调拨出库（原仓真的扣减）', directionOf('concession'), 'out')
eq('返工 → 调拨入库待检仓（原仓真的扣减）', directionOf('rework'), 'out')
eq('退货出库', directionOf('return'), 'out')
eq('报废出库', directionOf('scrap'), 'out')
eq('不认识的处置方式没有库存方向', directionOf('no_such'), 'none')
// 「哪个处置 → 哪个目标仓」只有一处出处：DISPOSITION_TARGET。
// 这两条钉住它，口径要改时改一处、这里跟着改一处，不会出现"代码改了、界面没改"。
eq('让步接收的目标仓类型', DISPOSITION_TARGET.concession, 'defect')
eq('返工的目标仓类型', DISPOSITION_TARGET.rework, 'quarantine')

// ---------------------------------------------------------------------------
// 2. 在库复检 · 全部合格（不良数恰好等于 Ac）→ 报检单自动关闭
// ---------------------------------------------------------------------------
console.log('\n2. 在库复检：不良数 = Ac 判合格，链自动收口')
const fat = pickFatStock(60)
ok(!!fat, '存在可复检的库存行')
const qA = 40
const rqA = createRequest(db, {
  sourceType: 'inventory',
  warehouseId: fat.warehouse_id,
  items: [{ sku_id: fat.sku_id, batch_no: fat.batch_no, qty: qA }],
  aql: 2.5,
  level: 'normal',
  requestDate: new Date(),
  remark: `${TEST_TAG}在库复检全合格`,
  actor: { id: null, name: '测试' }
})
eq('报检单为草稿', rqA.status, 'draft')
ok(rqA.doc_no.startsWith('QCR'), `报检单号前缀 QCR（${rqA.doc_no}）`)
eq('报检单一行', rqA.items.length, 1)
eq('报检数量入行', rqA.items[0].qty, qA)
ok(rqA.items[0].sample_qty <= qA, '抽样量 ≤ 报检数量')
eq('报检单头合计抽样量与行一致', rqA.total_sample_qty, rqA.items[0].sample_qty)
eq('建单时行还是待检', rqA.items[0].result, 'pending')
throws(() => createRequest(db, { sourceType: 'inventory', items: [{ sku_id: fat.sku_id, qty: 1 }], actor: null }), 'QC2_NO_WAREHOUSE', '在库复检缺仓库被拒')
throws(() => createRequest(db, { sourceType: 'inventory', warehouseId: fat.warehouse_id, actor: null }), 'QC2_NO_ITEMS', '在库复检缺明细被拒')
throws(() => createRequest(db, { sourceType: 'nope', actor: null }), 'QC2_BAD_SOURCE', '不认识的来源类型被拒')

const subA = submitRequest(db, { id: rqA.id, actor: { id: null, name: '测试' } })
eq('提交后报检单为已报检', subA.request.status, 'submitted')
ok(!!subA.inspection, '提交同时生成检验单')
eq('检验单为待检', subA.inspection.status, 'draft')
eq('检验单指回报检单', subA.inspection.request_no, rqA.doc_no)
eq('报检单回写检验单号', getRequest(db, rqA.id).inspection_no, subA.inspection.doc_no)
throws(() => submitRequest(db, { id: rqA.id, actor: null }), 'QC2_STATE_INVALID', '已报检的不能再提交')

const acA = subA.inspection.items[0].ac
const inspA = submitInspection(db, {
  id: subA.inspection.id,
  lines: [{ id: subA.inspection.items[0].id, defect_qty: acA, defect_code: 'appearance' }],
  actor: { id: null, name: '测试' }
})
eq(`不良数恰好等于 Ac(${acA}) → 判合格`, inspA.result, 'qualified')
eq('行结论为合格', inspA.items[0].result, 'qualified')
eq('全部合格 → 报检单自动关闭', getRequest(db, rqA.id).status, 'closed')
eq('检验单随之归档关闭', getInspection(db, subA.inspection.id).status, 'closed')
eq('合格单没有任何处置', inspA.handling_count, 0)
eq('合格单处置汇总为未处置', inspA.disposition, 'none')
throws(
  () => createHandling(db, { inspectionId: subA.inspection.id, skuId: fat.sku_id, batchNo: fat.batch_no, qty: 1, mode: 'rework', actor: null }),
  'QC2_NO_DEFECT',
  '合格品不能建不良品处理单'
)
okNear(inspA.defect_rate, (acA / subA.inspection.items[0].sample_qty) * 100, '不良率 = 不良数 / 抽样量')

// ---------------------------------------------------------------------------
// 3. 采购到货 · 判不合格 → 四路分流（让步 / 退货 / 报废 / 返工）
// ---------------------------------------------------------------------------
console.log('\n3. 采购到货：四路分流与库存后果')
// 选一张「已收货、还没被任何质检链认领」的到货单，且首行有足够现货可扣。
// ⚠️ 现在要求现货**盖得住整行报检量**（旧口径只要 50%）：四种处置全部会真的动库存
// （让步/返工也会先出库再入隔离仓），四路拆分之和 = 报检量，现货不够就没法把整行处置完，
// 「四路分流 + 报检单自动收口」这条主线索就断了。
const pend = pendingSources(db, { sourceType: 'purchase_receipt', limit: 50 })
ok(pend.length > 0, `存在待检的采购到货来源（${pend.length}）`)
let pick = null
let pickDetail = null
for (const p of pend) {
  const d = sourceDetail(db, p.source_type, p.source_id)
  if (!d || !d.items.length) continue
  const it0 = d.items[0]
  const stock = stockOf(d.warehouse_id, it0.sku_id, it0.batch_no)
  if (stock && num(stock.qty_on_hand) - num(stock.qty_reserved) >= num(it0.qty)) {
    pick = p
    pickDetail = d
    break
  }
}
ok(!!pick, '找到一张现货充足的待检到货单')
if (pick) {
  const it0 = pickDetail.items[0]
  const avail0 = num(stockOf(pickDetail.warehouse_id, it0.sku_id, it0.batch_no).qty_on_hand)

  const rqB = createRequest(db, {
    sourceType: 'purchase_receipt',
    sourceId: pick.source_id,
    remark: `${TEST_TAG}采购到货四路分流`,
    actor: { id: null, name: '测试' }
  })
  eq('报检来源类型', rqB.source_type, 'purchase_receipt')
  eq('带上来源单号', rqB.source_doc_no, pickDetail.source_doc_no)
  eq('带上供应商', rqB.supplier_id, pickDetail.supplier_id)
  throws(
    () => createRequest(db, { sourceType: 'purchase_receipt', sourceId: pick.source_id, actor: null }),
    'QC2_DUPLICATE',
    '同一来源不能重复报检（幂等）'
  )
  ok(!pendingSources(db, { sourceType: 'purchase_receipt', limit: 999 }).some((x) => x.source_id === pick.source_id), '已报检的来源从待检清单消失')

  const subB = submitRequest(db, { id: rqB.id, actor: { id: null, name: '测试' } })
  const linesB = subB.inspection.items.map((it) =>
    it.id === subB.inspection.items[0].id
      ? { id: it.id, defect_qty: it.ac + 1, defect_code: 'spec', defect_reason: `${TEST_TAG}规格不符` } // 边界：Ac+1 必须判不合格
      : { id: it.id, defect_qty: 0 }
  )
  const inspB = submitInspection(db, { id: subB.inspection.id, lines: linesB, actor: { id: null, name: '测试' } })
  eq('首行不良数 = Ac+1 → 判不合格', inspB.items[0].result, 'unqualified')
  eq('整单结论为不合格', inspB.result, 'unqualified')
  eq('其余行不良数 0 → 合格', inspB.items.slice(1).every((it) => it.result === 'qualified'), true)
  eq('有不合格未处置 → 报检单仍开着', getRequest(db, rqB.id).status, 'submitted')
  eq('检验单为已检', getInspection(db, subB.inspection.id).status, 'inspected')

  const line = inspB.items[0]
  const total = num(line.qty)
  const remainBefore = num(line.remain_handle_qty)
  okNear(remainBefore, total, '未处置时可处置量 = 报检数量')

  // --- 拦截：四种前置校验都要拦在写库之前 ---
  throws(() => createHandling(db, { inspectionId: subB.inspection.id, skuId: line.sku_id, batchNo: line.batch_no, qty: total + 1, mode: 'rework', actor: null }), 'QC2_QTY_OVER', '超量处置被拒')
  throws(() => createHandling(db, { inspectionId: subB.inspection.id, skuId: line.sku_id, batchNo: line.batch_no, qty: 1, mode: 'concession', actor: null }), 'QC2_REASON_REQUIRED', '让步接收必须写理由')
  throws(() => createHandling(db, { inspectionId: subB.inspection.id, skuId: line.sku_id, batchNo: line.batch_no, qty: 1, mode: 'no_such', actor: null }), 'QC2_BAD_MODE', '不认识的处置方式被拒')
  throws(() => createHandling(db, { inspectionId: subB.inspection.id, skuId: -999, batchNo: '', qty: 1, mode: 'rework', actor: null }), 'QC2_ITEM_NOT_FOUND', '不在报检明细里的 SKU 被拒')
  eq('被拒的处置没有落库', db.prepare('SELECT COUNT(*) c FROM qc_defect_handlings WHERE inspection_id=?').get(subB.inspection.id).c, 0)

  // --- 把首行报检数量拆成四份，四种处置各走一遍 ---
  const payable = Math.min(total, avail0)
  const retQty = Math.max(1, Math.floor(payable * 0.15))
  const scrQty = Math.max(1, Math.floor(payable * 0.15))
  const conQty = Math.max(1, Math.floor((total - retQty - scrQty) / 2))
  const rwQty = Math.round((total - conQty - retQty - scrQty) * 100) / 100
  ok(rwQty >= 1, `四份拆分都为正（让步 ${conQty} / 退货 ${retQty} / 报废 ${scrQty} / 返工 ${rwQty}）`)

  // ① 让步接收：**自动生成一张调拨单**，把货从当前仓调进不合格品仓
  //    （客户口径：「可以把不合格的产品调拨入不合格仓，单子可以是客户选择后自动生成，
  //      其实就是调拨单」「一定要都真实扣减库存的，并形成真实的出入库」）
  const before1 = stockQty(pickDetail.warehouse_id, line.sku_id, line.batch_no)
  const defectWh = db.prepare("SELECT * FROM warehouses WHERE type='defect' ORDER BY id LIMIT 1").get()
  ok(!!defectWh, `已建「不合格品仓」（${defectWh?.name || '-'}）`)
  const defectBefore = stockQty(defectWh.id, line.sku_id, line.batch_no)
  const dhCon = createHandling(db, {
    inspectionId: subB.inspection.id, skuId: line.sku_id, batchNo: line.batch_no,
    qty: conQty, mode: 'concession', reason: `${TEST_TAG}客户急单，外观轻微瑕疵可接受`,
    defectCode: 'spec', remark: `${TEST_TAG}让步接收`, actor: { id: null, name: '测试' }
  })
  eq('让步单为待处理', dhCon.status, 'draft')
  eq('让步单库存方向为 out（调拨出库，原仓真的扣减）', dhCon.stock_direction, 'out')
  const dhConDone = confirmHandling(db, { id: dhCon.id, actor: { id: null, name: '测试' } })
  eq('让步执行生成调拨单（内核短码 TF）', dhConDone.stock_effect.outDocType, 'TF')
  ok(!!dhConDone.out_doc_no, `让步单回写调拨单号（${dhConDone.out_doc_no}）`)
  // 先断言**库存本身**（这一段是本次改动的核心：处置必须真的扣货 + 真的入库），
  // 再看单据细节 —— 顺序反过来的话，没有调拨单时会在解引用上崩，
  // 于是「库存没动」这条最关键的失效反而看不到。
  okNear(stockQty(pickDetail.warehouse_id, line.sku_id, line.batch_no), before1 - conQty, '让步真的扣了原仓结存（处置完库存必须动）')
  okNear(stockQty(defectWh.id, line.sku_id, line.batch_no), defectBefore + conQty, '不合格品仓真的入了货')
  okNear(
    stockQty(pickDetail.warehouse_id, line.sku_id, line.batch_no) + stockQty(defectWh.id, line.sku_id, line.batch_no),
    before1 + defectBefore,
    '让步前后两仓合计不变（数量守恒，货只是换了地方）'
  )
  const conTr = db.prepare('SELECT * FROM stock_transfers WHERE id=?').get(dhConDone.stock_effect.outDocId ?? -1)
  ok(!!conTr, '调拨单已落库')
  eq('调拨单号 = 处置单上的出库单号', dhConDone.out_doc_no, conTr?.doc_no ?? null)
  eq('调拨单已入库（出库 + 入库两步都走完）', conTr?.status ?? null, 'received')
  eq('调出仓 = 原仓', conTr?.from_warehouse_id ?? null, pickDetail.warehouse_id)
  eq('调入仓 = 不合格品仓', conTr?.to_warehouse_id ?? null, defectWh.id)
  const conItems = db.prepare('SELECT * FROM stock_transfer_items WHERE transfer_id=?').all(conTr?.id ?? -1)
  eq('调拨单一行', conItems.length, 1)
  okNear(conItems[0]?.qty ?? 0, conQty, '调拨数量 = 处置数量')
  eq('调拨行带原批次（不跨批次扣货）', conItems[0]?.batch_no ?? null, line.batch_no)
  // 客户口径：「出库单一定会有多种类型的，所以你的出入库单上一定要加一个类型」
  // ⇒ 这张自动生成的调拨单必须带上**一眼能看出来的类型**，不能混进默认的 normal。
  eq('调拨单类型可辨识（质检处置调拨，不是 normal）', conTr?.type ?? null, 'qc_disposition')
  // 真的过账：两条流水 + 两侧结存一减一增
  const conOut = db.prepare("SELECT * FROM inventory_transactions WHERE doc_type='TR_OUT' AND doc_id=?").get(conTr?.id ?? -1)
  const conIn = db.prepare("SELECT * FROM inventory_transactions WHERE doc_type='TR_IN' AND doc_id=?").get(conTr?.id ?? -1)
  ok(!!conOut, '让步留下了 TR_OUT 出库流水')
  ok(!!conIn, '让步留下了 TR_IN 入库流水')
  // 流水这一层的口径：doc_type 保持**调拨语义**（不另造码），doc_id 指向**调拨单**，
  // 来源写在 remark 里 —— 三者合起来才能回答"这是一张什么出库单"。
  eq('出库流水 direction=out', conOut?.direction ?? null, 'out')
  eq('入库流水 direction=in', conIn?.direction ?? null, 'in')
  eq('出库流水的 doc_id 指向调拨单', conOut?.doc_id ?? null, conTr?.id ?? -1)
  eq('入库流水的 doc_id 指向调拨单', conIn?.doc_id ?? null, conTr?.id ?? -1)
  ok(
    String(conOut?.remark || '').includes(dhCon.doc_no) && String(conOut?.remark || '').includes('让步接收'),
    `出库流水备注写清来源（${conOut?.remark || ''}）`
  )
  ok(String(conIn?.remark || '').includes(dhCon.doc_no), `入库流水备注写清来源（${conIn?.remark || ''}）`)
  ok(
    db
      .prepare(
        `SELECT 1 h FROM inventory_transactions t JOIN stock_transfers s ON s.id = t.doc_id
          WHERE t.doc_type IN ('TR_OUT','TR_IN') AND s.type='qc_disposition' AND t.doc_id=?`
      )
      .get(conTr?.id ?? -1),
    '按 type=qc_disposition 能一条 JOIN 反查出这两条流水'
  )
  // 批次可用性：qc_status 是**批次级**的，不能被"挪进不合格仓"这一步改成可售 ——
  // 否则整批货（含还留在原仓的那部分）都会被当成能卖。
  eq(
    '让步后批次仍判不合格（不能当可售货卖）',
    db.prepare('SELECT qc_status FROM inventory_batches WHERE sku_id=? AND batch_no=?').get(line.sku_id, line.batch_no).qc_status,
    'rejected'
  )
  eq('让步执行后为已执行', dhConDone.status, 'confirmed')
  // 留痕里能看出这一步生成了哪张调拨单（remark 人看，payload 机读）
  const conEv = getHandling(db, dhCon.id).events
  ok(conEv.some((e) => e.to_state === 'confirmed' && String(e.remark || '').includes(String(dhConDone.out_doc_no || '\u0000'))), '处置留痕里带着生成的调拨单号')
  const conEvPayload = db
    .prepare("SELECT payload_json FROM doc_events WHERE doc_type='DH' AND doc_id=? AND action='confirm'")
    .get(dhCon.id)
  ok(String(conEvPayload?.payload_json || '').includes(String(dhConDone.out_doc_no || '\u0000')), '留痕 payload 里带着调拨单的机读引用')
  throws(() => confirmHandling(db, { id: dhCon.id, actor: null }), 'QC2_STATE_INVALID', '已执行的处置不能重复执行')

  // ①b 草稿可撤销：误开的处置不能把这一行的可处置量永久吃掉
  const dhDraft = createHandling(db, {
    inspectionId: subB.inspection.id, skuId: line.sku_id, batchNo: line.batch_no,
    qty: 0.01, mode: 'rework', remark: `${TEST_TAG}待撤销`, actor: null
  })
  eq('撤销前计入处理单张数', getInspection(db, subB.inspection.id).handling_count, 2)
  const dhCanceled = cancelHandling(db, { id: dhDraft.id, reason: '误开', actor: null })
  eq('草稿处置可撤销', dhCanceled.status, 'cancelled')
  eq('撤销后不计入处理单张数', getInspection(db, subB.inspection.id).handling_count, 1)
  eq('撤销后处置汇总不变', getInspection(db, subB.inspection.id).disposition, 'concession')

  // ② 退货：采购来源 → 生成采购退货单（内部已出库）
  const before2 = stockQty(pickDetail.warehouse_id, line.sku_id, line.batch_no)
  const dhRet = createHandling(db, {
    inspectionId: subB.inspection.id, skuId: line.sku_id, batchNo: line.batch_no,
    qty: retQty, mode: 'return', reason: `${TEST_TAG}批次规格不符，退回供应商`,
    defectCode: 'spec', remark: `${TEST_TAG}退货`, actor: { id: null, name: '测试' }
  })
  eq('退货单库存方向为 out', dhRet.stock_direction, 'out')
  const dhRetDone = confirmHandling(db, { id: dhRet.id, actor: { id: null, name: '测试' } })
  eq('采购来源退货 → 生成采购退货单', dhRetDone.stock_effect.outDocType, 'PRT')
  ok(!!dhRetDone.out_doc_no, `退货单带回出库单号（${dhRetDone.out_doc_no}）`)
  const prt = db.prepare('SELECT * FROM purchase_returns WHERE id=?').get(dhRetDone.stock_effect.outDocId)
  ok(!!prt, '采购退货单已落库')
  eq('处理单上的出库单号 = 采购退货单号', dhRetDone.out_doc_no, prt.doc_no)
  eq('采购退货单已确认', prt.status, 'confirmed')
  eq('采购退货单带仓库', prt.warehouse_id, pickDetail.warehouse_id)
  const prtQty = db.prepare('SELECT IFNULL(SUM(qty),0) q FROM purchase_return_items WHERE return_id=?').get(prt.id).q
  okNear(prtQty, retQty, '采购退货单明细数量 = 处置数量')
  okNear(stockQty(pickDetail.warehouse_id, line.sku_id, line.batch_no), before2 - retQty, '退货真的扣了库存')
  ok(
    db.prepare("SELECT 1 h FROM inventory_transactions WHERE doc_type='PUR_RET' AND doc_no=?").get(prt.doc_no),
    '退货留下了 PUR_RET 出库流水'
  )

  // ③ 报废：报废出库
  const before3 = stockQty(pickDetail.warehouse_id, line.sku_id, line.batch_no)
  const dhScr = createHandling(db, {
    inspectionId: subB.inspection.id, skuId: line.sku_id, batchNo: line.batch_no,
    qty: scrQty, mode: 'scrap', reason: `${TEST_TAG}破损不可用`,
    defectCode: 'packaging', remark: `${TEST_TAG}报废`, actor: { id: null, name: '测试' }
  })
  const dhScrDone = confirmHandling(db, { id: dhScr.id, actor: { id: null, name: '测试' } })
  eq('报废出库单类型', dhScrDone.stock_effect.outDocType, 'SCRAP_OUT')
  eq('报废出库单号 = 处理单号', dhScrDone.out_doc_no, dhScr.doc_no)
  okNear(stockQty(pickDetail.warehouse_id, line.sku_id, line.batch_no), before3 - scrQty, '报废真的扣了库存')
  ok(
    db.prepare("SELECT 1 h FROM inventory_transactions WHERE doc_type='SCRAP_OUT' AND doc_id=?").get(dhScr.id),
    '报废留下了 SCRAP_OUT 出库流水'
  )

  // ④ 返工：**自动生成一张调拨单**，把货从当前仓调进待检品仓（真的出库 + 真的入库）
  const before4 = stockQty(pickDetail.warehouse_id, line.sku_id, line.batch_no)
  const pendWh = db.prepare("SELECT * FROM warehouses WHERE type='quarantine' ORDER BY id LIMIT 1").get()
  ok(!!pendWh, `已建「待检品仓」（${pendWh?.name || '-'}）`)
  const pendBefore = stockQty(pendWh.id, line.sku_id, line.batch_no)
  const dhRw = createHandling(db, {
    inspectionId: subB.inspection.id, skuId: line.sku_id, batchNo: line.batch_no,
    qty: rwQty, mode: 'rework', reason: `${TEST_TAG}返工后复检`,
    remark: `${TEST_TAG}返工`, actor: { id: null, name: '测试' }
  })
  const dhRwDone = confirmHandling(db, { id: dhRw.id, actor: { id: null, name: '测试' } })
  eq('返工执行生成调拨单（内核短码 TF）', dhRwDone.stock_effect.outDocType, 'TF')
  ok(!!dhRwDone.out_doc_no, `返工单回写调拨单号（${dhRwDone.out_doc_no}）`)
  // 与让步同一顺序：先断言库存真的动了，再看单据细节（顺序反了会在解引用上崩）
  okNear(stockQty(pickDetail.warehouse_id, line.sku_id, line.batch_no), before4 - rwQty, '返工真的扣了原仓结存（处置完库存必须动）')
  okNear(stockQty(pendWh.id, line.sku_id, line.batch_no), pendBefore + rwQty, '待检品仓真的入了货')
  okNear(
    stockQty(pickDetail.warehouse_id, line.sku_id, line.batch_no) + stockQty(pendWh.id, line.sku_id, line.batch_no),
    before4 + pendBefore,
    '返工前后两仓合计不变（数量守恒）'
  )
  const rwTr = db.prepare('SELECT * FROM stock_transfers WHERE id=?').get(dhRwDone.stock_effect.outDocId ?? -1)
  eq('返工调拨单已入库', rwTr?.status ?? null, 'received')
  eq('返工调拨单类型可辨识（质检处置调拨）', rwTr?.type ?? null, 'qc_disposition')
  eq('返工调入仓 = 待检品仓', rwTr?.to_warehouse_id ?? null, pendWh.id)
  eq('返工调出仓 = 原仓', rwTr?.from_warehouse_id ?? null, pickDetail.warehouse_id)
  ok(
    db.prepare("SELECT 1 h FROM inventory_transactions WHERE doc_type='TR_OUT' AND doc_id=?").get(rwTr?.id ?? -1),
    '返工留下了 TR_OUT 出库流水'
  )
  ok(
    db.prepare("SELECT 1 h FROM inventory_transactions WHERE doc_type='TR_IN' AND doc_id=?").get(rwTr?.id ?? -1),
    '返工留下了 TR_IN 入库流水'
  )
  // 返工的货是「待检」：既不是可售的合格品，也不是判死的不合格品
  eq(
    '返工后批次为待检',
    db.prepare('SELECT qc_status FROM inventory_batches WHERE sku_id=? AND batch_no=?').get(line.sku_id, line.batch_no).qc_status,
    'pending'
  )
  const dhRwEv = getHandling(db, dhRw.id).events
  eq('返工留下一条执行留痕', dhRwEv.length, 1)
  eq('留痕记到了已执行', dhRwEv[0].to_state, 'confirmed')
  eq('留痕记下了谁批的', dhRwEv[0].actor_name, '测试')
  ok(String(dhRwEv[0].remark || '').includes(String(dhRwDone.out_doc_no || '\u0000')), '返工留痕里带着生成的调拨单号')

  // --- 收口：四份都处置完 → 报检单与检验单自动关闭 ---
  const inspBAfter = getInspection(db, subB.inspection.id)
  eq('处置汇总为混合处置', inspBAfter.disposition, 'mixed')
  eq('处理单张数 4', inspBAfter.handling_count, 4)
  okNear(inspBAfter.items[0].handled_qty, total, '该行已处置量 = 报检数量')
  okNear(inspBAfter.items[0].remain_handle_qty, 0, '已处置完的行可处置量为 0')
  eq('处置完 → 报检单自动关闭', getRequest(db, rqB.id).status, 'closed')
  eq('处置完 → 检验单随之关闭', getInspection(db, subB.inspection.id).status, 'closed')
  eq('四路分流各一张', db.prepare("SELECT COUNT(DISTINCT mode) c FROM qc_defect_handlings WHERE inspection_id=?").get(subB.inspection.id).c, 4)
  eq('清单能按检验单过滤（含已撤销的那张）', listHandlings(db, { inspectionId: subB.inspection.id, pageSize: 50 }).total, 5)
  eq('清单能再按已执行过滤', listHandlings(db, { inspectionId: subB.inspection.id, status: 'confirmed', pageSize: 50 }).total, 4)

  // --- 已执行（终态）的处置连撤销都不行：货已经出库或已经拍板，只能冲不能抹 ---
  throws(() => cancelHandling(db, { id: dhScr.id, reason: '试试', actor: null }), 'TRANSITION_NOT_ALLOWED', '已执行（终态）的处置不能再取消')

  // 不存在的来源单
  throws(() => createRequest(db, { sourceType: 'purchase_receipt', sourceId: 99999999, actor: null }), 'QC2_SOURCE_NOT_FOUND', '不存在的来源单被拒')
}

// ---------------------------------------------------------------------------
// 4. 生产完工 · 加严检验（+「没有批次的返工必须被拒」）
//    返工 → 待检仓的完整出库+入库验证在上一节（同一段代码，来源无关）。
// ---------------------------------------------------------------------------
console.log('\n4. 生产完工：加严抽检 + 无批次返工被拒')
// 演示库里已完工的生产订单都已被 seed 认领，这里把一张草稿单按内核推完工，
// 用完再还原 —— 直接把 status 写成 completed 会绕过内核（本项目的红线）。
const mo = db.prepare("SELECT * FROM production_orders WHERE status='draft' ORDER BY id LIMIT 1").get()
ok(!!mo, '存在草稿生产订单可用于测试')
if (mo) {
  const moSnap = { ...mo }
  const evMax = db.prepare('SELECT IFNULL(MAX(id),0) m FROM doc_events').get().m
  try {
    for (const action of ['submit', 'approve', 'start']) {
      applyTransition({ db, docType: 'MO', id: mo.id, action, actor: { id: null, name: '测试' }, source: 'test' })
    }
    throws(
      () => createRequest(db, { sourceType: 'production_order', sourceId: mo.id, actor: null }),
      'QC2_SOURCE_NOT_READY',
      '生产中（未完工）不能报检'
    )
    applyTransition({ db, docType: 'MO', id: mo.id, action: 'complete', actor: { id: null, name: '测试' }, source: 'test' })
    eq('生产订单已完工', db.prepare('SELECT status FROM production_orders WHERE id=?').get(mo.id).status, 'completed')

    const rqC = createRequest(db, {
      sourceType: 'production_order', sourceId: mo.id, level: 'tightened',
      remark: `${TEST_TAG}生产完工加严抽检`, actor: { id: null, name: '测试' }
    })
    eq('来源类型为生产完工', rqC.source_type, 'production_order')
    eq('检验水平为加严', rqC.inspect_level, 'tightened')
    eq('加严 Ac 比正常低 1', rqC.items[0].ac, samplingPlan(rqC.items[0].qty, 'normal').ac - 1)
    eq('车间名落到展示字段', rqC.subject_name, '生产车间')

    const subC = submitRequest(db, { id: rqC.id, actor: null })
    throws(
      () => createHandling(db, { inspectionId: subC.inspection.id, skuId: rqC.items[0].sku_id, batchNo: '', qty: 1, mode: 'rework', actor: null }),
      'QC2_NOT_INSPECTED',
      '还没出检验结论不能建处置单'
    )
    const before5 = stockQty(rqC.warehouse_id, rqC.items[0].sku_id, rqC.items[0].batch_no)
    const acC = subC.inspection.items[0].ac
    const inspC = submitInspection(db, {
      id: subC.inspection.id,
      lines: [{ id: subC.inspection.items[0].id, defect_qty: acC + 1, defect_code: 'quality' }],
      actor: { id: null, name: '测试' }
    })
    eq('生产完工判不合格', inspC.result, 'unqualified')
    // 这张 MO 是按内核推到「已完工」的（**没有真的走完工入库**，所以没有入库批次）。
    // 返工现在要真的把货调拨进待检仓，没有批次就不知道该挪哪一批货 ——
    // 这时候必须**拒绝**，而不是按拣选规则跨批次乱扣（那是更难发现的静默错误）。
    const dhRw2 = createHandling(db, {
      inspectionId: subC.inspection.id, skuId: rqC.items[0].sku_id, batchNo: rqC.items[0].batch_no,
      qty: inspC.items[0].qty, mode: 'rework', reason: `${TEST_TAG}性能不达标，返工`,
      remark: `${TEST_TAG}生产返工`, actor: null
    })
    throws(
      () => confirmHandling(db, { id: dhRw2.id, actor: null }),
      'QC2_HANDLE_NO_BATCH',
      '没有批次的处置拒绝执行（宁可拒绝，也不跨批次乱扣）'
    )
    eq('被拒后处置单仍是草稿', getHandling(db, dhRw2.id).status, 'draft')
    eq('被拒后没有生成任何调拨单', db.prepare('SELECT COUNT(*) c FROM stock_transfers WHERE remark LIKE ?').get(`%${dhRw2.doc_no}%`).c, 0)
    eq('有草稿处置没执行 → 报检单不关闭', getRequest(db, rqC.id).status, 'submitted')
    eq('有草稿处置没执行 → 检验单不归档', getInspection(db, subC.inspection.id).status, 'inspected')
    // 处置汇总按**已执行**的算：这条没执行，所以仍是没有处置
    eq('未执行的处置不计入处置汇总', getInspection(db, subC.inspection.id).disposition, 'none')
    cancelHandling(db, { id: dhRw2.id, reason: '测试收尾', actor: null })
    // 返工 → 待检仓这条路的**完整**验证在上一节（采购来源那一张，走的是同一段代码）；
    // 这里只钉「没有批次就拒绝」，因为本节的 MO 没有真的完工入库、无货可挪。
    eq('撤销草稿处置后仍无调拨单', db.prepare('SELECT COUNT(*) c FROM stock_transfers WHERE remark LIKE ?').get(`%${dhRw2.doc_no}%`).c, 0)
    okNear(stockQty(rqC.warehouse_id, rqC.items[0].sku_id, rqC.items[0].batch_no), before5, '被拒的返工没有动成品仓结存')
  } finally {
    // 还原生产订单：状态回草稿，并只删掉本轮新增的 MO 留痕（不能连 seed 的老留痕一起删）
    db.prepare('UPDATE production_orders SET status=?, updated_at=? WHERE id=?').run(moSnap.status, moSnap.updated_at, mo.id)
    db.prepare("DELETE FROM doc_events WHERE doc_type='MO' AND doc_id=? AND id>?").run(mo.id, evMax)
    eq('生产订单状态已还原为草稿', db.prepare('SELECT status FROM production_orders WHERE id=?').get(mo.id).status, 'draft')
  }
}

// ---------------------------------------------------------------------------
// 5. 非采购来源的退货 → QC_RET_OUT（没有「退给谁」，直接出到退料区）
// ---------------------------------------------------------------------------
console.log('\n5. 非采购来源退货：走质检退料出库')
const fat2 = pickFatStock(60)
const qtyC = Math.max(5, Math.floor(num(fat2.qty_on_hand) * 0.01))
const rqD = createRequest(db, {
  sourceType: 'inventory', warehouseId: fat2.warehouse_id,
  items: [{ sku_id: fat2.sku_id, batch_no: fat2.batch_no, qty: qtyC }],
  remark: `${TEST_TAG}在库复检退货`, actor: null
})
const subD = submitRequest(db, { id: rqD.id, actor: null })
const acD = subD.inspection.items[0].ac
const inspD = submitInspection(db, {
  id: subD.inspection.id,
  lines: [{ id: subD.inspection.items[0].id, defect_qty: acD + 1, defect_code: 'hygiene' }],
  actor: null
})
eq('在库复检判不合格', inspD.result, 'unqualified')
const before6 = stockQty(fat2.warehouse_id, fat2.sku_id, fat2.batch_no)
const dhRet2 = createHandling(db, {
  inspectionId: subD.inspection.id, skuId: fat2.sku_id, batchNo: fat2.batch_no,
  qty: inspD.items[0].qty, mode: 'return', reason: `${TEST_TAG}卫生指标超标，退料`,
  remark: `${TEST_TAG}退料`, actor: null
})
const dhRet2Done = confirmHandling(db, { id: dhRet2.id, actor: null })
eq('非采购来源退货 → QC_RET_OUT', dhRet2Done.stock_effect.outDocType, 'QC_RET_OUT')
eq('无采购退货单生成', db.prepare('SELECT COUNT(*) c FROM purchase_returns WHERE reason LIKE ?').get(`%${TEST_TAG}卫生指标超标%`).c, 0)
okNear(stockQty(fat2.warehouse_id, fat2.sku_id, fat2.batch_no), before6 - num(inspD.items[0].qty), '质检退料真的扣了库存')
ok(
  db.prepare("SELECT 1 h FROM inventory_transactions WHERE doc_type='QC_RET_OUT' AND doc_id=?").get(dhRet2.id),
  '退料留下了 QC_RET_OUT 出库流水'
)
eq('退料后报检单关闭', getRequest(db, rqD.id).status, 'closed')

// ---------------------------------------------------------------------------
// 6. 数字不一致必须被拦在写库之前
// ---------------------------------------------------------------------------
console.log('\n6. 数字校验：拦在写库之前')
const rqE = createRequest(db, {
  sourceType: 'inventory', warehouseId: fat2.warehouse_id,
  items: [{ sku_id: fat2.sku_id, batch_no: fat2.batch_no, qty: qtyC }],
  remark: `${TEST_TAG}数字校验`, actor: null
})
const subE = submitRequest(db, { id: rqE.id, actor: null })
const itE = subE.inspection.items[0]
throws(
  () => submitInspection(db, { id: subE.inspection.id, lines: [{ id: itE.id, defect_qty: num(itE.sample_qty) + 1 }], actor: null }),
  'QC2_DEFECT_OVER_SAMPLE',
  '不良数超过抽样量被拒（抽了 n 个不可能有 n+1 个不良）'
)
throws(
  () => submitInspection(db, { id: subE.inspection.id, lines: [{ id: itE.id, defect_qty: -1 }], actor: null }),
  'QC2_QTY_INVALID',
  '不良数为负被拒'
)
eq('被拒后检验单仍是待检（事务已回滚）', getInspection(db, subE.inspection.id).status, 'draft')
eq('被拒后行仍未判定', getInspection(db, subE.inspection.id).items[0].result, 'pending')
noThrow(() => transitionInspection(db, { id: subE.inspection.id, action: 'cancel', actor: null }), '待检的检验单可以取消')
eq('取消后检验单为已取消', getInspection(db, subE.inspection.id).status, 'cancelled')
throws(
  () => submitInspection(db, { id: subE.inspection.id, lines: [{ id: itE.id, defect_qty: 0 }], actor: null }),
  'QC2_STATE_INVALID',
  '已取消的检验单不能再提交结论'
)
// 已报检的单不能取消 —— 内核只给了「草稿 → 已取消」这条边。
// 这是刻意的：报检之后货已经在质检手上了，谁点的「取消」得说得清，
// 所以强制走关闭（close）而不是抹掉（cancel）。
throws(() => transitionRequest(db, { id: rqE.id, action: 'cancel', actor: null }), 'TRANSITION_NOT_ALLOWED', '已报检的报检单不能取消（只能关闭）')
eq('被拒后报检单状态未变', getRequest(db, rqE.id).status, 'submitted')
noThrow(() => transitionRequest(db, { id: rqE.id, action: 'close', actor: null }), '已报检的报检单可以关闭')
eq('关闭后报检单为已关闭', getRequest(db, rqE.id).status, 'closed')

// 草稿可取消，取消后同一来源可以重新报检（否则一次误操作就把来源永久占死）
const pend2 = pendingSources(db, { sourceType: 'purchase_receipt', limit: 50 }).filter((p) => !pick || p.source_id !== pick.source_id)
if (pend2.length) {
  const rqF = createRequest(db, {
    sourceType: 'purchase_receipt', sourceId: pend2[0].source_id,
    remark: `${TEST_TAG}草稿取消`, actor: null
  })
  transitionRequest(db, { id: rqF.id, action: 'cancel', actor: null })
  eq('草稿可取消', getRequest(db, rqF.id).status, 'cancelled')
  let again = null
  noThrow(() => { again = createRequest(db, { sourceType: 'purchase_receipt', sourceId: pend2[0].source_id, remark: `${TEST_TAG}取消后重报`, actor: null }) }, '取消后同一来源可以重新报检')
  throws(
    () => createRequest(db, { sourceType: 'purchase_receipt', sourceId: pend2[0].source_id, actor: null }),
    'QC2_DUPLICATE',
    '重新报检后再次重复仍被拒'
  )
  ok(!!again, '重新报检拿到了新单号')
} else {
  console.log('  · 跳过「草稿取消后重报」（已没有空闲的待检到货单）')
}

// ---------------------------------------------------------------------------
// 7. 审计与总览
// ---------------------------------------------------------------------------
console.log('\n7. 自洽审计与总览')
const audit = auditQc(db)
for (const k of audit.checked) eq(`审计 ${k} 为 0`, audit[k].length, 0)
ok(audit.ok, '质检自洽审计整体通过')

const ov = qcOverview(db)
ok(ov.requests >= 5, `总览统计到本轮报检单（${ov.requests}）`)
ok(ov.inspections >= 4, `总览统计到本轮检验单（${ov.inspections}）`)
ok(ov.unqualified >= 3, `总览统计到不合格（${ov.unqualified}）`)
ok(ov.qualified >= 1, `总览统计到合格（${ov.qualified}）`)
const modes = ov.by_mode.map((m) => m.mode)
ok(modes.includes('concession') && modes.includes('return') && modes.includes('scrap') && modes.includes('rework'), '总览按处置方式分布齐全')
ok(ov.scrap_qty > 0 && ov.return_qty > 0 && ov.concession_qty > 0 && ov.rework_qty > 0, '四种处置的数量都统计到了')
ok(ov.defect_rate >= 0 && ov.defect_rate <= 100, '不良率落在 0~100 区间')
const listedReq = listRequests(db, { pageSize: 200 })
eq('报检单列表总数与库内一致', listedReq.total, db.prepare('SELECT COUNT(*) c FROM qc_requests').get().c)
ok(listedReq.total >= 5, `报检单列表能列出本轮单据（${listedReq.total}）`)
ok(listRequests(db, { keyword: '在库复检', pageSize: 50 }).total >= 1, '报检单能按主题关键字检索')
ok(listRequests(db, { status: 'closed', pageSize: 50 }).rows.every((r) => r.status === 'closed'), '报检单能按状态过滤')
ok(listRequests(db, { sourceType: 'production_order', pageSize: 50 }).rows.every((r) => r.source_type === 'production_order'), '报检单能按来源过滤')
ok(listInspections(db, { result: 'unqualified', pageSize: 50 }).rows.every((r) => r.result === 'unqualified'), '检验单能按结论过滤')
ok(listHandlings(db, { mode: 'scrap', pageSize: 50 }).rows.every((r) => r.mode === 'scrap'), '处理单能按方式过滤')

// ---------------------------------------------------------------------------
// 8. 清理与还原
// ---------------------------------------------------------------------------
console.log('\n8. 清理与库存还原')
const cleaned = purgeTestData()
ok(cleaned.requests > 0, `清理了本轮报检单（${cleaned.requests} 张）`)
ok(cleaned.handlings > 0, `清理了本轮处理单（${cleaned.handlings} 张）`)
ok(cleaned.txns > 0, `清理了本轮库存流水（${cleaned.txns} 条）`)
eq('无残留报检单', testRequestIds().length, 0)
eq('无残留检验单', db.prepare(`SELECT COUNT(*) c FROM qc_inspections WHERE request_id NOT IN (SELECT id FROM qc_requests)`).get().c, 0)
eq('无残留处理单', db.prepare(`SELECT COUNT(*) c FROM qc_defect_handlings WHERE inspection_id NOT IN (SELECT id FROM qc_inspections)`).get().c, 0)
eq('报检单行无残留', db.prepare(`SELECT COUNT(*) c FROM qc_request_items WHERE request_id NOT IN (SELECT id FROM qc_requests)`).get().c, 0)
eq('无残留流转留痕', db.prepare(`SELECT COUNT(*) c FROM doc_events WHERE doc_type IN ('QCR','QCI','DH','PRT') AND doc_id NOT IN (SELECT id FROM qc_requests UNION SELECT id FROM qc_inspections UNION SELECT id FROM qc_defect_handlings UNION SELECT id FROM purchase_returns)`).get().c, 0)
eq('库存流水行数回到起点', db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c, txnCount0)
eq('无本轮残留流水', db.prepare('SELECT COUNT(*) c FROM inventory_transactions WHERE id > ?').get(txnMax).c, 0)
eq('成本流水行数回到起点', db.prepare('SELECT COUNT(*) c FROM stock_cost_ledger').get().c, ledgerCount0)
eq('无本轮残留成本流水', db.prepare('SELECT COUNT(*) c FROM stock_cost_ledger WHERE id > ?').get(ledgerMax).c, 0)
const restored = restoreStocks()
const drift = db
  .prepare(`SELECT COUNT(*) c FROM inventory_stocks`)
  .get().c
let mismatch = 0
for (const r of db.prepare(`SELECT ${STOCK_COLS.join(',')} FROM inventory_stocks`).all()) {
  const s = stockSnapshot.get(r.id)
  if (!s) { mismatch++; continue }
  if (Math.abs(num(r.qty_on_hand) - num(s.qty_on_hand)) > 1e-6) mismatch++
  else if (Math.abs(num(r.cost_amount) - num(s.cost_amount)) > 1e-6) mismatch++
}
eq('库存快照逐行比对无差异', mismatch, 0)
eq('库存行数未变', drift, stockSnapshot.size)
eq('无残留调拨单（本轮生成的让步/返工调拨单已清掉）', db.prepare('SELECT COUNT(*) c FROM stock_transfers WHERE remark LIKE ?').get('%质检处置%').c, 0)
eq('无残留调拨明细', db.prepare('SELECT COUNT(*) c FROM stock_transfer_items i WHERE NOT EXISTS (SELECT 1 FROM stock_transfers t WHERE t.id=i.transfer_id)').get().c, 0)
eq('待检来源数量回到起点', pendingSources(db, { limit: 999 }).length, pending0)
eq('报检单数量回到起点', db.prepare('SELECT COUNT(*) c FROM qc_requests').get().c, requestCount0)
ok(restored.fixed >= 0, `还原了库存行 ${restored.fixed} 行（另删除新造 ${restored.removed} 行）`)
ok(auditQc(db).ok, '清理后仍自洽（审计通过）')

console.log(`\n通过 ${pass}　失败 ${fail}`)
if (only.length) console.log('失败项：\n - ' + only.join('\n - '))
console.log('─'.repeat(64))
finished = true
process.exit(fail ? 1 : 0)
