/**
 * ============================================================================
 * 文件标识：scripts/test-stock-v2.mjs ｜ 测试：库存引擎 v2 冒烟测试 —— 独立临时库，不触碰任何生产数据
 * ============================================================================
 * 【职责】测试：库存引擎 v2 冒烟测试 —— 独立临时库，不触碰任何生产数据
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 库存引擎 v2 冒烟测试 —— 独立临时库，不触碰任何生产数据
// 运行：node scripts/test-stock-v2.mjs
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from '../server/db/migrations/runner.js'
import {
  applyStockIn, applyStockOut, applyOwnershipTransfer,
  reserveStock, releaseStock, availableQty, pickBatches,
  queryBalance, costOf, clearParamCache, setStockNowProvider
} from '../server/lib/stock.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const TMP = '/tmp/gml_stock_test.db'

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}  ${detail ? '→ ' + detail : ''}`) }
}
function eq(name, actual, expected) {
  // 数值按容差比；字符串/枚举按严格相等比（避免 Number('E1018') → NaN 的误判）
  const numeric = typeof expected === 'number' && actual != null && !Number.isNaN(Number(actual))
  const good = numeric
    ? Math.abs(Number(actual) - Number(expected)) < 1e-4
    : String(actual) === String(expected)
  ok(name, good, `实际 ${actual} / 期望 ${expected}`)
}
function section(t) { console.log(`\n\x1b[36m${t}\x1b[0m`) }

// ---------- 准备干净库 ----------
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f)
const db = new Database(TMP)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')
db.exec(fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8'))
const applied = runMigrations(db)
console.log(`迁移已执行：${applied.length ? applied.join(', ') : '（无）'}`)
clearParamCache()

// ---------- 造组织与仓库 ----------
db.prepare(`INSERT OR IGNORE INTO orgs (id, code, name, type, parent_id, level, path, is_legal, owner_org_id, currency, region, status)
  VALUES (1,'HQ','演示总部','group',NULL,1,'/1/',1,1,'CNY','华东','active')`).run()
db.prepare(`INSERT OR IGNORE INTO orgs (id, code, name, type, parent_id, level, path, is_legal, owner_org_id, currency, region, status)
  VALUES (2,'ST_A','直营店A','store',1,2,'/1/2/',0,1,'CNY','华东','active')`).run()
db.prepare(`INSERT OR IGNORE INTO orgs (id, code, name, type, parent_id, level, path, is_legal, owner_org_id, currency, region, status)
  VALUES (3,'ST_B','加盟店B','store',1,2,'/1/3/',1,3,'CNY','华南','active')`).run()
db.prepare(`INSERT OR IGNORE INTO orgs (id, code, name, type, parent_id, level, path, is_legal, owner_org_id, currency, region, status)
  VALUES (4,'CK','中央厨房','kitchen',1,2,'/1/4/',0,1,'CNY','华东','active')`).run()
db.prepare(`INSERT OR IGNORE INTO orgs (id, code, name, type, parent_id, level, path, is_legal, owner_org_id, currency, region, tax_region, status)
  VALUES (5,'HK_ST','中国香港门店','store',1,2,'/1/5/',0,1,'HKD','香港','中国香港','active')`).run()

db.prepare(`INSERT INTO warehouses (id, code, name, type, currency, org_id, default_owner_org_id, region) VALUES
  (1,'WH01','总仓','central','CNY',1,1,'华东'),
  (2,'WH02','直营店A仓','store','CNY',2,1,'华东'),
  (3,'WH03','加盟店B仓','store','CNY',3,3,'华南'),
  (4,'WH04','央厨仓','central','CNY',4,1,'华东'),
  (5,'WH05','中国香港门店仓','store','HKD',5,1,'香港')`).run()

db.prepare("INSERT INTO products (id, spu_code, name, unit) VALUES (1,'SPU001','测试面膜','盒')").run()
db.prepare("INSERT INTO product_skus (id, product_id, sku_code, name) VALUES (1,1,'SKU001','测试面膜 50ml')").run()
db.prepare("INSERT INTO product_skus (id, product_id, sku_code, name) VALUES (2,1,'SKU002','测试面膜 100ml')").run()

const DAY = '2026-10-15'
setStockNowProvider(() => `${DAY} 12:00:00`)

// ============================================================
section('T1–T3 移动加权成本')
applyStockIn(db, { bizDate: DAY, docType: 'PUR_IN', docNo: 'PO001', warehouseId: 1, skuId: 1, batchNo: 'B1', qty: 10, unitCost: 10 })
let c = costOf(db, { warehouseId: 1, ownerOrgId: 1, skuId: 1, batchNo: 'B1' })
eq('入库 10@10 → 数量', c.qty, 10)
eq('入库 10@10 → 均价', c.unitCost, 10)
eq('入库 10@10 → 金额', c.amount, 100)

applyStockIn(db, { bizDate: DAY, docType: 'PUR_IN', docNo: 'PO002', warehouseId: 1, skuId: 1, batchNo: 'B1', qty: 10, unitCost: 20 })
c = costOf(db, { warehouseId: 1, ownerOrgId: 1, skuId: 1, batchNo: 'B1' })
eq('再入 10@20 → 数量 20', c.qty, 20)
eq('再入 10@20 → 加权均价 15（v1 会错成 20）', c.unitCost, 15)
eq('再入 10@20 → 金额 300', c.amount, 300)

const out1 = applyStockOut(db, { bizDate: DAY, docType: 'SAL_OUT', docNo: 'SO001', warehouseId: 1, skuId: 1, batchNo: 'B1', qty: 5 })
c = costOf(db, { warehouseId: 1, ownerOrgId: 1, skuId: 1, batchNo: 'B1' })
eq('出库 5 → 出库单价取均价 15', out1.unitCost, 15)
eq('出库 5 → 剩余数量 15', c.qty, 15)
eq('出库 5 → 剩余金额 225', c.amount, 225)

// ============================================================
section('T4 五维隔离（同仓不同货主）')
applyStockIn(db, { bizDate: DAY, docType: 'PUR_IN', docNo: 'PO003', warehouseId: 1, skuId: 1, batchNo: 'B1', qty: 7, unitCost: 99, ownerOrgId: 3 })
const rowsB1 = queryBalance(db, { warehouseId: 1, skuId: 1, batchNo: 'B1' })
ok('同仓同 SKU 同批次、不同货主 → 两行独立库存', rowsB1.length === 2, `实际 ${rowsB1.length} 行`)
const owner1 = rowsB1.find((r) => r.owner_org_id === 1)
const owner3 = rowsB1.find((r) => r.owner_org_id === 3)
eq('货主1（总部/直营口径）数量仍是 15', owner1?.qty_on_hand, 15)
eq('货主3（加盟店）数量 7', owner3?.qty_on_hand, 7)
eq('两货主成本互不污染：货主1 均价 15', owner1?.cost_price, 15)
eq('两货主成本互不污染：货主3 均价 99', owner3?.cost_price, 99)

// ============================================================
section('T5 多币种（中国香港门店 HKD 与内地 CNY 不混算）')
applyStockIn(db, { bizDate: DAY, docType: 'PUR_IN', docNo: 'PO004', warehouseId: 5, skuId: 1, batchNo: 'HK1', qty: 3, unitCost: 88 })
const hk = costOf(db, { warehouseId: 5, ownerOrgId: 1, skuId: 1, batchNo: 'HK1' })
eq('中国香港仓自动落 HKD 币种金额', hk.amount, 264)
const hkRow = db.prepare("SELECT currency FROM inventory_stocks WHERE warehouse_id=5 AND batch_no='HK1'").get()
ok('币种字段自动解析为 HKD（无需调用方传参）', hkRow?.currency === 'HKD', `实际 ${hkRow?.currency}`)

// ============================================================
section('T6 FEFO 拣选 + 过保禁售')
applyStockIn(db, { bizDate: DAY, docType: 'PUR_IN', docNo: 'PO100', warehouseId: 1, skuId: 2, batchNo: 'E1120', qty: 5, unitCost: 5, expireDate: '2026-11-20' })
applyStockIn(db, { bizDate: DAY, docType: 'PUR_IN', docNo: 'PO101', warehouseId: 1, skuId: 2, batchNo: 'E1025', qty: 5, unitCost: 5, expireDate: '2026-10-25' })
applyStockIn(db, { bizDate: DAY, docType: 'PUR_IN', docNo: 'PO102', warehouseId: 1, skuId: 2, batchNo: 'E1018', qty: 5, unitCost: 5, expireDate: '2026-10-18' })
applyStockIn(db, { bizDate: DAY, docType: 'PUR_IN', docNo: 'PO103', warehouseId: 1, skuId: 2, batchNo: 'EXPIRED', qty: 5, unitCost: 5, expireDate: '2020-01-01' })

const pick = pickBatches(db, 1, 2, 12, { ownerOrgId: 1 })
eq('拣选规则读取参数为 fefo', pick.rule, 'fefo')
eq('拣 12 件跨 3 个批次', pick.picks.length, 3)
eq('第 1 顺位 = 最早到期 2026-10-18', pick.picks[0].batchNo, 'E1018')
eq('第 2 顺位 = 2026-10-25', pick.picks[1].batchNo, 'E1025')
eq('第 3 顺位 = 最后补足 2 件来自 2026-11-20', pick.picks[2].qty, 2)
ok('过保批次 EXPIRED 被剔除', !pick.picks.some((x) => x.batchNo === 'EXPIRED'))
ok('返回过保跳过提示', pick.skippedExpired === 1, `实际 ${pick.skippedExpired}`)

// 切 FIFO 应改变顺序
db.prepare("UPDATE inv_params SET param_value='fifo' WHERE param_key='pick_rule'").run()
clearParamCache()
const pickFifo = pickBatches(db, 1, 2, 5, { ownerOrgId: 1 })
eq('切到 fifo 后规则生效', pickFifo.rule, 'fifo')
eq('FIFO 第 1 顺位 = 最早入库 E1120', pickFifo.picks[0].batchNo, 'E1120')
db.prepare("UPDATE inv_params SET param_value='fefo' WHERE param_key='pick_rule'").run()
clearParamCache()

// 小时级效期
applyStockIn(db, { bizDate: DAY, docType: 'PRD_IN', docNo: 'MO001', warehouseId: 4, skuId: 2, batchNo: 'FRESH1', qty: 2, unitCost: 3, expireAt: '2026-10-15 22:00:00' })
const freshRow = db.prepare("SELECT expire_at FROM inventory_stocks WHERE warehouse_id=4 AND batch_no='FRESH1'").get()
ok('餐饮短保：效期精确到小时可落库', freshRow?.expire_at === '2026-10-15 22:00:00', `实际 ${freshRow?.expire_at}`)

// ============================================================
section('T7 成本流水落账')
const ledgerCount = db.prepare('SELECT COUNT(*) c FROM stock_cost_ledger').get().c
ok('每次出入库均写成本流水', ledgerCount >= 8, `实际 ${ledgerCount} 条`)
const txnCount = db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c
ok('业务流水同步落账', txnCount >= 8, `实际 ${txnCount} 条`)
const ledgerSample = db.prepare("SELECT * FROM stock_cost_ledger WHERE doc_no='PO002'").get()
eq('成本流水记录加权前单价', ledgerSample?.unit_cost_before, 10)
eq('成本流水记录加权后单价', ledgerSample?.unit_cost_after, 15)

// ============================================================
section('T8 预留明细（可回答「被谁占的」）')
reserveStock(db, { warehouseId: 1, skuId: 1, batchNo: 'B1', qty: 3, ownerOrgId: 1, sourceDocType: 'sales_order', sourceDocId: 9001, sourceDocNo: 'SO9001' })
const resv = db.prepare("SELECT * FROM inventory_reservations WHERE source_doc_no='SO9001'").get()
ok('预留写出明细行', resv && resv.qty === 3, JSON.stringify(resv))
eq('可用量 = 在库 - 占用', availableQty(db, 1, 1, 'B1', 1), 12)
releaseStock(db, { warehouseId: 1, skuId: 1, batchNo: 'B1', qty: 3, ownerOrgId: 1, sourceDocType: 'sales_order', sourceDocId: 9001 })
const resvAfter = db.prepare("SELECT status FROM inventory_reservations WHERE source_doc_no='SO9001'").get()
ok('释放后预留明细置为 released', resvAfter?.status === 'released', `实际 ${resvAfter?.status}`)
eq('释放后可用量恢复 15', availableQty(db, 1, 1, 'B1', 1), 15)

// ============================================================
section('T9 库存不足拦截')
let threw = null
try {
  applyStockOut(db, { bizDate: DAY, docType: 'SAL_OUT', docNo: 'SO_BAD', warehouseId: 1, skuId: 1, batchNo: 'B1', qty: 9999, ownerOrgId: 1 })
} catch (e) { threw = e }
ok('超量出库抛错', !!threw)
ok('错误码为 INSUFFICIENT_STOCK', threw?.code === 'INSUFFICIENT_STOCK', `实际 ${threw?.code}`)
ok('错误带可用量明细', threw?.detail?.available === 15, JSON.stringify(threw?.detail))

// ============================================================
section('T10 数量归零时成本口径（keep_last）')
applyStockOut(db, { bizDate: DAY, docType: 'SAL_OUT', docNo: 'SO_CLEAR', warehouseId: 1, skuId: 1, batchNo: 'B1', qty: 15, ownerOrgId: 1 })
const zeroed = db.prepare("SELECT qty_on_hand, cost_price, cost_amount FROM inventory_stocks WHERE warehouse_id=1 AND owner_org_id=1 AND sku_id=1 AND batch_no='B1'").get()
eq('归零后数量 0', zeroed.qty_on_hand, 0)
eq('归零后金额 0', zeroed.cost_amount, 0)
eq('keep_last：保留最后均价 15 供下次入库参考', zeroed.cost_price, 15)

// ============================================================
section('T11 货权转移（央厨 → 加盟店，加盟店是独立主体）')
applyStockIn(db, { bizDate: DAY, docType: 'PRD_IN', docNo: 'MO900', warehouseId: 4, skuId: 2, batchNo: 'CK01', qty: 20, unitCost: 6, ownerOrgId: 1 })
const tr = applyOwnershipTransfer(db, {
  fromWarehouseId: 4, fromOwnerOrgId: 1, toWarehouseId: 3, toOwnerOrgId: 3,
  skuId: 2, batchNo: 'CK01', qty: 8, docNo: 'TR900', bizDate: DAY, operator: '演示'
})
eq('转移单价沿用原货主成本 6', tr.unitCost, 6)
const fromSide = costOf(db, { warehouseId: 4, ownerOrgId: 1, skuId: 2, batchNo: 'CK01' })
const toSide = costOf(db, { warehouseId: 3, ownerOrgId: 3, skuId: 2, batchNo: 'CK01' })
eq('央厨侧（货主=总部）剩 12', fromSide.qty, 12)
eq('加盟店侧（货主=加盟店）得 8', toSide.qty, 8)
eq('加盟店侧结存成本 48', toSide.amount, 48)
const ownTxns = db.prepare("SELECT doc_type FROM inventory_transactions WHERE doc_no='TR900' ORDER BY id").all().map((r) => r.doc_type)
ok('产生两条货权转移流水（出+入）', ownTxns.join(',') === 'TR_OWN_OUT,TR_OWN_IN', ownTxns.join(','))

// ============================================================
section('T12 向后兼容：旧签名（不传货主/币种）')
let compat = null
try {
  applyStockIn(db, { bizDate: DAY, docType: 'PUR_IN', docNo: 'PO_OLD', warehouseId: 1, skuId: 1, batchNo: '', qty: 2, unitCost: 12 })
  const p = pickBatches(db, 1, 1, 1)
  const a = availableQty(db, 1, 1, '')
  compat = { picks: p.picks.length, available: a }
} catch (e) { compat = { error: e.message } }
ok('旧调用形式仍然可用（80 处调用点无需改动）', compat && !compat.error && compat.picks === 1, JSON.stringify(compat))

// ============================================================
section('T13 orgs 默认主体兜底（id=0 存在，NULL 已回填）')
const sysOrg = db.prepare('SELECT id, code FROM orgs WHERE id=0').get()
ok('系统默认主体 id=0 存在（UNIQUE 约束对 NULL 失效的兜底）', !!sysOrg, JSON.stringify(sysOrg))
const nullOwners = db.prepare('SELECT COUNT(*) c FROM inventory_stocks WHERE owner_org_id IS NULL').get().c
eq('库存表已无 NULL 货主', nullOwners, 0)

// ---------- 汇总 ----------
console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
if (fail) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1) }
console.log('\x1b[32m全部通过\x1b[0m')
db.close()
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f)
