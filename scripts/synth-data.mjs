#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/synth-data.mjs ｜ 合成大库生成器：在隔离目录里用真实迁移 + 领域函数造出可配规模的生产分类库（roadmap-v4 Y10）
 * ============================================================================
 * 【职责】给"大库规模演练"（备份 / 恢复演练 / 索引审计 / 接口压测）提供一份**确定性、可重复、守不变量**的合成库。
 *   不是演示种子（server/db/*-seed.js 在生产模式被禁用），也不是容量承诺；数字只代表运行它的这台机器。
 *
 * 【怎么写数据】全部业务单据走领域函数，不直接 INSERT 业务表：
 *   · 迁移：`initSchemaFor()`（真实迁移运行器）+ `ensureSettings()`；管理员：`bootstrapAdmin()`（与 bootstrap-admin CLI 同一函数）。
 *   · 采购：`createPurchaseOrder` → `transitionPurchaseOrder`(submit/approve) → `receivePurchaseOrder`（收货单 + 批次入库 + 成本流水 + 订单状态）。
 *   · 销售：`createQuote` → `transitionQuote` → `convertQuote`（报价转单，含信用校验）→ 订单确认
 *     （`checkCredit` + `reserveForDoc` + `applyTransition` + `occupy`，**镜像** server/routes/sales.js 的 /orders/:id/confirm——
 *     确认逻辑只存在于该 HTTP 处理器内，领域层没有可调用的同名函数）→ 部分订单发货（`planShipment` + `applyStockOut` + 发货单，
 *     镜像 /orders/:id/deliver）→ 少量订单 `cancelOrder`（领域函数）。镜像处与路由逐段对应，路由改了要同步。
 *   · 盘盈盘亏：`applyStockGain` / `applyStockOut`（与 POST /api/inventory/adjust 同一入口），补足 --txns 目标。
 *   · **直接 INSERT 的表只有主数据**：categories / brands / products / product_skus / warehouses / suppliers / supplier_products / dealers
 *     （这些在 server/routes/master.js 等里是通用 CRUD，没有可调用的领域函数，且不涉及跨表不变量）。授信账户用 `ensureAccount` + `updateAccount`。
 *
 * 【安全判据】
 *   ① 必须显式给绝对路径 `GML_DATA_DIR`，经 `requireExplicitDataDir()` 拒绝仓库 data/；目录必须**不存在或为空**
 *      （已有任何文件即拒绝——这是"不碰在用实例"的判据：在用实例的目录里一定有 .db）；`GML_DB` 必须为空（否则 cosmetic 库会被改道）；
 *   ② `GML_RUNTIME_MODE` 必须是 `production`（生成的库带生产分类标记，db-restore-drill 只接受生产库；
 *      bench-api 只接受 demo/test，所以压测用 synth-pipeline.mjs 对**副本**改标记）；
 *   ③ 不监听任何端口、不读写 data/；`--out` 摘要不得落在仓库 data/ 内、不得是符号链接；
 *   ④ 管理员密码：`GML_SYNTH_ADMIN_PASSWORD`（≥16 字符）或随机生成；随机时写入 `<GML_DATA_DIR>/synth-admin-password.txt`（0600），不打印。
 *
 * 【确定性】`--seed`（默认 20261023）驱动 mulberry32；业务日期锚在 `--anchor`（默认 2026-10-01）之前，不读系统时钟；
 *   摘要里的 `digest` 只哈希业务列（单号/状态/金额/库存），不含时间戳，同参数两次运行应相同（tests/synth-data.test.mjs 断言）。
 *
 * 【用法】GML_RUNTIME_MODE=production GML_DATA_DIR=/abs/new-dir GML_DB= node scripts/synth-data.mjs
 *          [--skus 60] [--txns 600] [--docs 120] [--seed 20261023] [--anchor 2026-10-01] [--out summary.json] [--no-verify] [--quiet]
 *          [--batch-txns N] [--time-budget MINUTES] [--min-free-mb N]   (AB11：每 N 条流水 checkpoint+VACUUM；到时/磁盘不足则 partial 提前停并退出 0)
 *   --docs = 采购订单 + 销售订单总数（约 40% 采购 / 60% 销售）；--txns = inventory_transactions 目标行数（盘盈盘亏补足，已超则不删）。
 * 退出码：0 完成且不变量全绿；1 运行失败或不变量红；2 用法 / 安全拒绝。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { isWithin, writeExclusive } from './lib/safe-path.mjs'
import { sourceIdentity } from './lib/source-identity.mjs'

// 日期口径固定为 UTC：领域函数（如 receivePurchaseOrder 的 localDate）按本地时区取日，不同时区会让单号/摘要不同。必须在任何 Date 使用之前设置。
process.env.TZ = 'UTC'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SCHEMA_VERSION = 1
export const DEFAULTS = { skus: 60, txns: 600, docs: 120, seed: 20261023, anchor: '2026-10-01', batchTxns: 0, timeBudget: 0, minFreeMb: 0 }
const LIMITS = { skus: [1, 500000], txns: [0, 5000000], docs: [0, 1000000] }

const usage = (message) => Object.assign(new Error(message), { exitCode: 2 })

export function parseArgs(argv) {
  const o = { ...DEFAULTS, out: null, verify: true, quiet: false }
  const num = { '--skus': 'skus', '--txns': 'txns', '--docs': 'docs', '--seed': 'seed', '--batch-txns': 'batchTxns', '--min-free-mb': 'minFreeMb' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-verify') { o.verify = false; continue }
    if (a === '--quiet') { o.quiet = true; continue }
    if (a === '--time-budget') { // AB11：分钟，可为小数；到点后停止继续造数据并把结果标成 partial
      if (argv[i + 1] === undefined) throw usage(`参数 ${a} 缺值`)
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n <= 0) throw usage('--time-budget 必须是 >0 的分钟数')
      o.timeBudget = n
      continue
    }
    if (a === '--out' || a === '--anchor' || num[a]) {
      if (argv[i + 1] === undefined) throw usage(`参数 ${a} 缺值`)
      const v = argv[++i]
      if (a === '--out') o.out = v
      else if (a === '--anchor') o.anchor = v
      else {
        const n = Number(v)
        if (!Number.isInteger(n)) throw usage(`${a} 必须是整数`)
        o[num[a]] = n
      }
      continue
    }
    throw usage(`未知参数 ${a}`)
  }
  if (o.batchTxns < 0) throw usage('--batch-txns 必须 >=0（0 = 不分批）')
  if (o.minFreeMb < 0) throw usage('--min-free-mb 必须 >=0（0 = 不检查）')
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (o[k] < lo || o[k] > hi) throw usage(`--${k} 必须在 ${lo}..${hi}`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.anchor) || Number.isNaN(Date.parse(o.anchor))) throw usage('--anchor 必须是 YYYY-MM-DD')
  return o
}

/** mulberry32：32 位种子的确定性 PRNG，返回 [0,1) */
export function makeRng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ymdAdd = (anchor, days) => new Date(Date.parse(anchor) + days * 86400000).toISOString().slice(0, 10)
const round2 = (n) => Math.round(n * 100) / 100

const withinRepoData = (p) => isWithin(path.resolve(ROOT, 'data'), p)

/** 环境与目录闸门。返回 dataDir；违反即抛 exitCode=2。必须在 import 任何 server 模块之前调用（DATA_DIR 在 import 时固化）。 */
export function guardEnvironment(env = process.env) {
  if (env.GML_RUNTIME_MODE !== 'production') throw usage('GML_RUNTIME_MODE 必须显式为 production（生成生产分类库）')
  if (env.GML_DB) throw usage('GML_DB 必须为空：它会把 cosmetic 库改道到任意文件')
  const dir = env.GML_DATA_DIR
  if (!dir || !path.isAbsolute(dir)) throw usage('必须显式设置绝对路径 GML_DATA_DIR（全新的隔离目录）')
  if (withinRepoData(dir)) throw usage('GML_DATA_DIR 位于仓库 data/ 之内；请使用 /tmp 下的全新目录')
  try { if (fs.lstatSync(dir).isSymbolicLink()) throw usage('GML_DATA_DIR 本身不能是符号链接') } catch (e) { if (e.exitCode) throw e }
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory()) throw usage('GML_DATA_DIR 不是目录')
    if (fs.readdirSync(dir).length) throw usage(`GML_DATA_DIR 非空（${dir}）：只在全新/空目录生成，避免碰到在用实例`)
  }
  return dir
}

/** 摘要输出：父目录与目标都不得在仓库 data/ 内；目标必须尚不存在（写入时再用 O_EXCL 兜底，不跟随符号链接） */
function unsafeOutput(file) {
  const abs = path.resolve(file)
  if (withinRepoData(path.dirname(abs)) || withinRepoData(abs)) return true
  try { if (!fs.statSync(path.dirname(abs)).isDirectory()) return true } catch { return true } // 父目录必须已存在
  try { fs.lstatSync(abs); return true } catch { return false } // 已存在（含符号链接）即拒绝
}

/** 进度输出：到 stderr，按时间节流（≥2 s）+ 阶段结束必打 */
function makeProgress(quiet) {
  const t0 = performance.now()
  let last = 0
  return (phase, done, total, force = false) => {
    if (quiet) return
    const now = performance.now()
    if (!force && now - last < 2000) return
    last = now
    const el = (now - t0) / 1000
    process.stderr.write(`[synth] ${phase} ${done}/${total}${total ? ` (${Math.floor((done / total) * 100)}%)` : ''} elapsed ${el.toFixed(1)}s ${el > 0 ? `${(done / el).toFixed(0)}/s overall` : ''}\n`)
  }
}

/**
 * 不变量核对（verify-seed 风格）。只读，返回 { ok, checks:[{name, ok, detail}] }。
 * 判据尽量复用领域层自己的一份（reconcileOrderHolds / auditCredit），不再另写一遍。
 */
export async function verifyInvariants(db) {
  const { reconcileOrderHolds, auditCredit } = await import('../server/lib/credit.js')
  const checks = []
  const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail })
  const one = (sql) => db.prepare(sql).get()
  const rows = (sql) => db.prepare(sql).all()

  add('integrity_check', one('PRAGMA integrity_check')?.integrity_check === 'ok')
  const fk = rows('PRAGMA foreign_key_check')
  add('no_orphan_rows(foreign_key_check)', fk.length === 0, fk.length ? `${fk.length} 条，首条 ${JSON.stringify(fk[0])}` : '')

  // 库存 = 流水净额：逐 (仓, SKU, 批次) 对账
  const drift = rows(`
    SELECT s.warehouse_id w, s.sku_id k, s.batch_no b, s.qty_on_hand have, COALESCE(t.net,0) want
      FROM inventory_stocks s
      LEFT JOIN (SELECT warehouse_id, sku_id, COALESCE(batch_no,'') batch_no,
                        SUM(CASE direction WHEN 'in' THEN qty ELSE -qty END) net
                   FROM inventory_transactions GROUP BY warehouse_id, sku_id, COALESCE(batch_no,'')) t
        ON t.warehouse_id=s.warehouse_id AND t.sku_id=s.sku_id AND t.batch_no=s.batch_no
     WHERE ABS(s.qty_on_hand - COALESCE(t.net,0)) > 0.0001 LIMIT 5`)
  add('stock_equals_txn_net', drift.length === 0, drift.length ? JSON.stringify(drift[0]) : '')
  // 反向：流水分组必须都有库存行。用 LEFT JOIN 走 (仓,SKU,批次) 唯一索引（NOT EXISTS + COALESCE 会失去索引，250k 流水要 2 分钟）
  const orphanTxn = one(`SELECT COUNT(*) c FROM (SELECT warehouse_id, sku_id, COALESCE(batch_no,'') batch_no FROM inventory_transactions GROUP BY 1,2,3) t
      LEFT JOIN inventory_stocks s ON s.warehouse_id=t.warehouse_id AND s.sku_id=t.sku_id AND s.batch_no=t.batch_no WHERE s.id IS NULL`).c
  add('every_txn_has_stock_row', orphanTxn === 0, orphanTxn ? `${orphanTxn} 组流水无库存行` : '')
  add('no_negative_stock', one('SELECT COUNT(*) c FROM inventory_stocks WHERE qty_on_hand < -0.0001').c === 0)
  add('reserved_not_above_on_hand', one('SELECT COUNT(*) c FROM inventory_stocks WHERE qty_reserved > qty_on_hand + 0.0001').c === 0)

  // 单据 ↔ 库存流水
  const sumQ = (sql) => Number(one(sql).s || 0)
  add('purchase_receipt_qty_equals_PUR_IN',
    Math.abs(sumQ("SELECT COALESCE(SUM(i.qty),0) s FROM purchase_receipt_items i JOIN purchase_receipts r ON r.id=i.receipt_id") -
      sumQ("SELECT COALESCE(SUM(qty),0) s FROM inventory_transactions WHERE doc_type='PUR_IN'")) < 0.0001)
  add('delivery_qty_equals_SAL_OUT',
    Math.abs(sumQ('SELECT COALESCE(SUM(qty),0) s FROM sales_delivery_items') -
      sumQ("SELECT COALESCE(SUM(qty),0) s FROM inventory_transactions WHERE doc_type='SAL_OUT'")) < 0.0001)
  add('order_received_qty_equals_receipt_items',
    Math.abs(sumQ('SELECT COALESCE(SUM(received_qty),0) s FROM purchase_order_items') -
      sumQ('SELECT COALESCE(SUM(qty),0) s FROM purchase_receipt_items')) < 0.0001)
  add('order_shipped_qty_equals_delivery_items',
    Math.abs(sumQ('SELECT COALESCE(SUM(shipped_qty),0) s FROM sales_order_items') - sumQ('SELECT COALESCE(SUM(qty),0) s FROM sales_delivery_items')) < 0.0001)
  const hdr = rows(`SELECT o.id FROM sales_orders o WHERE ABS(o.total_qty - (SELECT COALESCE(SUM(qty),0) FROM sales_order_items i WHERE i.order_id=o.id)) > 0.0001 LIMIT 3`)
  add('sales_order_header_qty_equals_lines', hdr.length === 0, hdr.length ? `订单 #${hdr[0].id}` : '')
  const phdr = rows(`SELECT o.id FROM purchase_orders o WHERE ABS(o.total_amount - (SELECT COALESCE(SUM(amount),0) FROM purchase_order_items i WHERE i.order_id=o.id)) > 0.01 LIMIT 3`)
  add('purchase_order_header_amount_equals_lines', phdr.length === 0, phdr.length ? `订单 #${phdr[0].id}` : '')

  // 单据一生：每张单据至少有一条 doc_events；事件不指向不存在的单据（DL 的 create 留痕是路由里"写在改动旁边"的铁律）
  // 采购订单草稿没有留痕是路由的真实行为（createPurchaseOrder 不写 create 事件，只有流转才写），所以 PO 只核对非草稿
  for (const [type, table, where] of [['QT', 'sales_quotes', '1=1'], ['SO', 'sales_orders', '1=1'], ['DL', 'sales_deliveries', '1=1'], ['PO', 'purchase_orders', "d.status<>'draft'"], ['GR', 'purchase_receipts', '1=1']]) {
    const lacking = one(`SELECT COUNT(*) c FROM ${table} d WHERE ${where} AND NOT EXISTS (SELECT 1 FROM doc_events e WHERE e.doc_type='${type}' AND e.doc_id=d.id)`).c
    add(`every_${type}_has_doc_events`, lacking === 0, lacking ? `${lacking} 张 ${table} 无留痕` : '')
    const orphan = one(`SELECT COUNT(*) c FROM doc_events e WHERE e.doc_type='${type}' AND NOT EXISTS (SELECT 1 FROM ${table} d WHERE d.id=e.doc_id)`).c
    add(`no_orphan_${type}_events`, orphan === 0, orphan ? `${orphan} 条事件指向不存在的 ${table}` : '')
  }

  // 授信投影与台账
  const holds = reconcileOrderHolds(db)
  add('credit_hold_reconciles(reconcileOrderHolds)', holds.length === 0, holds.length ? JSON.stringify(holds[0]) : '')
  const ac = auditCredit(db)
  add('credit_ledger_balanced(auditCredit)', ac.balanced, ac.balanced ? '' : `drift ${ac.ledger_balance_drift.length} / holdDiff ${ac.order_hold_diff.length}`)
  return { ok: checks.every((c) => c.ok), checks }
}

/** 业务列摘要：不含时间戳 / 自增以外的运行时值，用于"同参数两次运行结果相同"的断言 */
export function businessDigest(db) {
  const h = crypto.createHash('sha256')
  const feed = (sql) => { for (const r of db.prepare(sql).iterate()) h.update(JSON.stringify(Object.values(r)) + '\n') }
  feed('SELECT doc_no,status,total_qty,total_amount FROM purchase_orders ORDER BY id')
  feed('SELECT doc_no,status,total_qty,receivable_amount,credit_hold FROM sales_orders ORDER BY id')
  feed('SELECT doc_no,total_qty FROM purchase_receipts ORDER BY id')
  feed('SELECT doc_no,total_qty FROM sales_deliveries ORDER BY id')
  feed('SELECT warehouse_id,sku_id,batch_no,qty_on_hand,qty_reserved,ROUND(cost_price,4) FROM inventory_stocks ORDER BY warehouse_id,sku_id,batch_no')
  feed('SELECT doc_type,doc_no,warehouse_id,sku_id,batch_no,direction,qty FROM inventory_transactions ORDER BY id')
  feed('SELECT doc_type,doc_id,action,from_state,to_state FROM doc_events ORDER BY id')
  return h.digest('hex')
}

export async function generate(opts, dataDir, env = process.env) {
  const progress = makeProgress(opts.quiet)
  const phases = {}
  const phase = async (name, fn) => { const t = performance.now(); const r = await fn(); phases[name] = Math.round(performance.now() - t); return r }
  const genStart = performance.now()
  const deadline = opts.timeBudget > 0 ? genStart + opts.timeBudget * 60000 : Infinity
  const rng = makeRng(opts.seed)
  const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1))
  const pick = (arr) => arr[Math.floor(rng() * arr.length)]

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const S = (p) => import(new URL(`../server/${p}`, import.meta.url))
  const { initSchemaFor, requireExplicitDataDir, dbPathFor } = await S('db/index.js')
  requireExplicitDataDir(env)
  const { ensureSettings } = await S('lib/settings.js')
  const { bootstrapAdmin } = await S('lib/admin-bootstrap.js')
  const purchase = await S('lib/purchase.js')
  const quote = await S('lib/quote.js')
  const credit = await S('lib/credit.js')
  const stock = await S('lib/stock.js')
  const { applyTransition, logEvent } = await S('lib/docflow.js')
  const { cancelOrder } = await S('lib/sales-order.js')
  const { nextDocNo } = await S('lib/docno.js')

  const db = await phase('migrate', async () => {
    const d = initSchemaFor('cosmetic')
    ensureSettings(d)
    // 合成库的写入连接：WAL + synchronous=NORMAL（崩溃安全不丢库，只可能丢最后几个事务）；生成完会 checkpoint
    d.pragma('synchronous = NORMAL')
    return d
  })

  // ---- 管理员（与 bootstrap-admin CLI 同一函数） ----
  let adminPassword = env.GML_SYNTH_ADMIN_PASSWORD
  let passwordFile = null
  if (!adminPassword) {
    adminPassword = crypto.randomBytes(18).toString('base64url')
    passwordFile = path.join(dataDir, 'synth-admin-password.txt')
    fs.writeFileSync(passwordFile, adminPassword + '\n', { mode: 0o600 })
  }
  const admin = bootstrapAdmin(db, { username: 'synthadmin', name: 'Synthetic Admin', companyCode: 'SYNTHCO', companyName: 'Synthetic Co', password: adminPassword })
  adminPassword = ''
  const actor = { id: admin.userId, name: 'Synthetic Admin' }
  const orgId = admin.orgId

  // ---- 主数据（唯一直接 INSERT 的部分，原因见文件头） ----
  const master = await phase('master', async () => {
    const nProducts = Math.max(1, Math.ceil(opts.skus / 3))
    const nSuppliers = Math.max(3, Math.min(200, Math.ceil(opts.skus / 100)))
    const nDealers = Math.max(5, Math.min(2000, Math.ceil(opts.docs / 40)))
    const whDefs = [['SYN-WH1', '合成总仓', 'central'], ['SYN-WH2', '合成华东仓', 'region'], ['SYN-WH3', '合成华南仓', 'region']]
    const warehouses = []; const suppliers = []; const dealers = []; const skus = []
    db.transaction(() => {
      db.prepare("INSERT INTO brands (code,name,status) VALUES ('SYN-B1','合成品牌','active')").run()
      db.prepare("INSERT INTO categories (code,name,status) VALUES ('SYN-C1','合成品类','active')").run()
      const wh = db.prepare('INSERT INTO warehouses (code,name,type,status,org_id,default_owner_org_id,currency) VALUES (?,?,?,?,?,?,?)')
      for (const [code, name, type] of whDefs) warehouses.push(Number(wh.run(code, name, type, 'active', orgId, orgId, 'CNY').lastInsertRowid))
      const sp = db.prepare("INSERT INTO suppliers (code,name,category,settle_type,credit_days,status,org_id) VALUES (?,?,?,?,30,'active',?)")
      for (let i = 1; i <= nSuppliers; i++) suppliers.push(Number(sp.run(`SYN-S${String(i).padStart(4, '0')}`, `合成供应商${i}`, '原料', '月结30天', orgId).lastInsertRowid))
      const dl = db.prepare("INSERT INTO dealers (code,name,level,region,channel_type,credit_limit,price_level,discount_rate,settle_type,status,org_id,credit_days) VALUES (?,?,?,?,?,?,?,?,?,'active',?,30)")
      for (let i = 1; i <= nDealers; i++) {
        dealers.push(Number(dl.run(`SYN-D${String(i).padStart(5, '0')}`, `合成经销商${i}`, pick(['diamond', 'gold', 'silver', 'bronze']), pick(['华东', '华南', '华北']), 'cs', 0, 'dealer', 100, '月结30天', orgId).lastInsertRowid))
      }
      const pr = db.prepare(`INSERT INTO products (spu_code,name,brand_id,category_id,spec,unit,shelf_life_months,batch_managed,tax_rate,price_retail,price_dealer,price_member,cost_std,status)
        VALUES (?,?,1,1,?,?,36,1,13,?,?,?,?,'active')`)
      const sk = db.prepare(`INSERT INTO product_skus (product_id,sku_code,name,spec,price_retail,price_dealer,price_member,cost_std,price_cost,price_min,status)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'active')`)
      const sup = db.prepare('INSERT INTO supplier_products (supplier_id,sku_id,is_available,price,currency,min_order_qty) VALUES (?,?,1,?,?,1)')
      const productIds = []
      for (let i = 1; i <= nProducts; i++) {
        const retail = ri(30, 600)
        productIds.push({ id: Number(pr.run(`SYN-P${String(i).padStart(6, '0')}`, `合成商品${i}`, '50ml', '瓶', retail, round2(retail * 0.7), round2(retail * 0.9), round2(retail * 0.35)).lastInsertRowid), retail })
      }
      for (let i = 1; i <= opts.skus; i++) {
        const p = productIds[(i - 1) % productIds.length]
        const cost = round2(p.retail * 0.35)
        const id = Number(sk.run(p.id, `SYN-K${String(i).padStart(7, '0')}`, `合成SKU${i}`, '50ml', p.retail, round2(p.retail * 0.7), round2(p.retail * 0.9), cost, cost, round2(p.retail * 0.5)).lastInsertRowid)
        skus.push({ id, cost, dealerPrice: round2(p.retail * 0.7) })
        sup.run(suppliers[(i - 1) % suppliers.length], id, cost, 'CNY')
      }
    })()
    // 授信账户走领域函数；额度给足，让校验链路被走到但不拦单
    for (const d of dealers) {
      const acc = credit.ensureAccount(db, { subjectType: 'dealer', subjectId: d, actor })
      credit.updateAccount(db, { accountId: acc.id, patch: { credit_limit: 1e12, credit_days: 30 }, actor })
    }
    return { warehouses, suppliers, dealers, skus }
  })

  // ---- 单据计划 ----
  const poCount = Math.round(opts.docs * 0.4)
  const soCount = opts.docs - poCount
  const deliverFrac = 0.7; const cancelFrac = 0.05
  const purLines = poCount ? Math.max(1, Math.round((opts.txns * 0.6) / poCount)) : 0
  const soLines = soCount ? Math.max(1, Math.round((opts.txns * 0.25) / Math.max(1, soCount * deliverFrac))) : 0
  const txnCount = () => db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c

  // ---- AB11：分批 checkpoint+VACUUM、磁盘余量守卫、时间预算（只在事务之外的循环边界检查，不会打断单据事务） ----
  // 流水计数用 MAX(rowid)（O(1)；本生成器从不删流水），不用 COUNT(*)（百万行上每次全扫）。
  const maxTxn = () => db.prepare('SELECT COALESCE(MAX(rowid),0) m FROM inventory_transactions').get().m
  const batching = { batch_txns: opts.batchTxns, vacuums: 0, vacuum_ms: 0, min_free_mb: opts.minFreeMb, free_mb_min_seen: null }
  let nextBoundary = opts.batchTxns > 0 ? opts.batchTxns : Infinity
  let stop = null // { reason, phase }
  let checks = 0
  const dbFileNow = () => dbPathFor('cosmetic')
  const freeMb = () => { try { const st = fs.statfsSync(dataDir); return Math.floor((Number(st.bavail) * Number(st.bsize)) / 1048576) } catch { return null } }
  const noteFree = () => { const f = freeMb(); if (f != null && (batching.free_mb_min_seen == null || f < batching.free_mb_min_seen)) batching.free_mb_min_seen = f; return f }
  /** 返回 true = 应停止当前循环。已停后任何阶段再调用都立即返回 true（后续阶段整体跳过）。 */
  const shouldStop = (phaseName) => {
    if (stop) return true
    if (performance.now() >= deadline) { stop = { reason: 'time_budget', phase: phaseName }; return true }
    checks++
    const atBoundary = maxTxn() >= nextBoundary
    // 磁盘余量：每次分批边界检查，另外每 200 次循环检查一次（statfs 很便宜，但不必逐单据）
    if (opts.minFreeMb > 0 && (atBoundary || checks % 200 === 0)) {
      const f = noteFree()
      if (f != null && f < opts.minFreeMb) { stop = { reason: 'disk_low', phase: phaseName }; return true }
    }
    if (atBoundary) {
      // VACUUM 在 WAL 模式下会把整库副本先写进 WAL 再 checkpoint 回主文件：峰值额外占用 ≈ 2 × 库大小。余量不够就不 VACUUM，直接停。
      db.pragma('wal_checkpoint(TRUNCATE)')
      const need = Math.ceil((fs.statSync(dbFileNow()).size / 1048576) * 2.2)
      const f = noteFree()
      if (f != null && f < need + opts.minFreeMb) { stop = { reason: 'disk_low', phase: phaseName }; return true }
      const t = performance.now()
      db.exec('VACUUM')
      db.pragma('wal_checkpoint(TRUNCATE)')
      batching.vacuum_ms += Math.round(performance.now() - t); batching.vacuums++
      while (maxTxn() >= nextBoundary) nextBoundary += opts.batchTxns
      noteFree()
    }
    return false
  }

  // SKU 轮转：先把每个 SKU 轮一遍（保证覆盖），再随机
  const order = master.skus.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
  let cursor = 0
  const nextSku = () => (cursor < order.length ? master.skus[order[cursor++]] : pick(master.skus))

  const counts = { purchase_orders: 0, receipts: 0, partial: 0, sales_orders: 0, confirmed: 0, delivered: 0, cancelled: 0, adjustments: 0 }
  const PUR_SPAN = 330 // 采购日期分布在锚点前 360..30 天
  const srcDate = (i, n, from, span) => ymdAdd(opts.anchor, -(from + span - Math.floor((i / Math.max(1, n)) * span)))

  await phase('purchase', async () => {
    for (let i = 0; i < poCount; i++) {
      if (shouldStop('purchase')) break
      const date = srcDate(i, poCount, 30, PUR_SPAN)
      const nLines = Math.max(1, purLines + ri(-1, 1))
      const used = new Set(); const items = []
      for (let l = 0; l < nLines; l++) {
        const sku = nextSku()
        if (used.has(sku.id)) continue
        used.add(sku.id)
        items.push({ sku_id: sku.id, qty: ri(50, 400), price: sku.cost })
      }
      const wh = master.warehouses[i % master.warehouses.length]
      const po = purchase.createPurchaseOrder(db, { supplierId: pick(master.suppliers), warehouseId: wh, orderDate: date, items, actor, sourceType: 'manual' })
      counts.purchase_orders++
      const roll = rng()
      if (roll < 0.04) { progress('purchase', i + 1, poCount); continue } // 留草稿
      purchase.transitionPurchaseOrder(db, { id: po.id, action: 'submit', actor })
      if (roll < 0.10) { progress('purchase', i + 1, poCount); continue } // 留已提交未收货
      if (roll < 0.40) purchase.transitionPurchaseOrder(db, { id: po.id, action: 'approve', actor })
      const partial = roll > 0.90
      const recvItems = partial ? po.items.map((it, k) => (k === 0 ? null : { id: it.id, sku_id: it.sku_id, qty: it.qty, price: it.price })).filter(Boolean) : null
      const lineList = (recvItems && recvItems.length ? recvItems : po.items.map((it) => ({ id: it.id, sku_id: it.sku_id, qty: it.qty, price: it.price })))
        .map((it) => ({ ...it, batch_no: `SB${date.replace(/-/g, '').slice(2)}-${it.sku_id}`, produce_date: date, expire_date: ymdAdd(date, 1095) }))
      purchase.receivePurchaseOrder(db, { orderId: po.id, items: lineList, receiptDate: date, actor, source: 'synth' })
      counts.receipts++; if (partial && recvItems.length < po.items.length) counts.partial++
      progress('purchase', i + 1, poCount)
    }
    if (!stop) progress('purchase', poCount, poCount, true)
  })

  const SO_SPAN = 25
  await phase('sales', async () => {
    const nWh = master.warehouses.length
    // 只挑"在对应仓库有库存的 SKU"：按仓缓存可售 SKU 清单（出库前再实时判断）
    const stocked = new Map()
    for (const w of master.warehouses) stocked.set(w, db.prepare('SELECT DISTINCT sku_id FROM inventory_stocks WHERE warehouse_id=? AND qty_on_hand>10').all(w).map((r) => r.sku_id))
    const priceOf = new Map(master.skus.map((s) => [s.id, s.dealerPrice]))
    const upsertSale = [] // 保留顺序以便确定性
    for (let i = 0; i < soCount; i++) {
      if (shouldStop('sales')) break
      const date = ymdAdd(opts.anchor, -(SO_SPAN - Math.floor((i / Math.max(1, soCount)) * SO_SPAN)))
      const wh = master.warehouses[i % nWh]
      const pool = stocked.get(wh)
      if (!pool.length) continue // 该仓还没有任何货（采购计划太小）：跳过，计数如实反映
      const used = new Set(); const items = []
      for (let l = 0; l < Math.max(1, soLines + ri(-1, 1)); l++) {
        const sku = pick(pool)
        if (used.has(sku)) continue
        used.add(sku); items.push({ sku_id: sku, qty: ri(1, 6), price: priceOf.get(sku) })
      }
      const dealerId = pick(master.dealers)
      let q = quote.createQuote(db, { customerType: 'dealer', dealerId, warehouseId: wh, quoteDate: date, validFrom: date, validTo: '2099-12-31', items, actor, source: 'synth' })
      quote.transitionQuote(db, { id: q.id, action: 'submit', actor, source: 'synth' })
      quote.transitionQuote(db, { id: q.id, action: 'approve', actor, source: 'synth' })
      const conv = quote.convertQuote(db, { id: q.id, target: 'SO', actor, orderDate: date, source: 'synth' })
      const soId = conv.order.id
      counts.sales_orders++
      confirmSalesOrder(soId)
      counts.confirmed++
      const roll = rng()
      if (roll < cancelFrac) {
        cancelOrder(db, { id: soId, reason: '合成数据：取消', actor, source: 'synth' })
        counts.cancelled++
      } else if (roll < cancelFrac + deliverFrac) {
        deliverSalesOrder(soId, date)
        counts.delivered++
      }
      progress('sales', i + 1, soCount)
    }
    progress('sales', soCount, soCount, true)
    void upsertSale
  })

  /** 镜像 routes/sales.js POST /orders/:id/confirm（信用闸门 + 占库 + 状态流转 + 占授信） */
  function confirmSalesOrder(id) {
    const order = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(id)
    const items = db.prepare('SELECT * FROM sales_order_items WHERE order_id=?').all(id)
    const sub = credit.resolveSubject(db, { dealerId: order.dealer_id, storeId: order.store_id })
    const acc = sub ? db.prepare('SELECT * FROM credit_accounts WHERE subject_type=? AND subject_id=?').get(sub.subjectType, sub.subjectId) : null
    const check = acc
      ? credit.checkCredit(db, { accountId: acc.id, amount: Number(order.receivable_amount || 0), scene: 'order.confirm', sourceType: 'SO', sourceId: id, docNo: order.doc_no, force: false, reason: null, actor })
      : null
    if (check && !check.pass) throw new Error(`合成订单信用校验未通过：${order.doc_no}`)
    db.transaction(() => {
      stock.reserveForDoc(db, { sourceDocType: 'SO', sourceDocId: id, sourceDocNo: order.doc_no, warehouseId: order.warehouse_id, items: items.map((it) => ({ skuId: it.sku_id, qty: it.qty })) })
      applyTransition({ db, docType: 'SO', id, action: 'confirm', actor, set: { updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') }, remark: '确认订单并占用库存', source: 'synth' })
      if (check?.account && check.account.limit > 0) {
        credit.occupy(db, { account: check.account.account_id, amount: Number(order.receivable_amount || 0), sourceType: 'SO', sourceId: id, docNo: order.doc_no, creditDays: check.account.credit_days, operator: actor, remark: '订单确认占用授信' })
        db.prepare("UPDATE sales_orders SET credit_checked_at=datetime('now','localtime') WHERE id=?").run(id)
      }
    })()
  }

  /** 镜像 routes/sales.js POST /orders/:id/deliver（消费本单预留 → SAL_OUT 出库 → 发货单 → 状态流转） */
  function deliverSalesOrder(id, date) {
    const order = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(id)
    const items = db.prepare('SELECT * FROM sales_order_items WHERE order_id=?').all(id)
    db.transaction(() => {
      const docNo = nextDocNo(db, 'SD', 'sales_deliveries', 'doc_no', date)
      const did = Number(db.prepare(`INSERT INTO sales_deliveries (doc_no,order_id,warehouse_id,delivery_date,status,total_qty,total_amount,created_by)
        VALUES (?,?,?,?,'shipped',0,0,?)`).run(docNo, id, order.warehouse_id, date, actor.id).lastInsertRowid)
      const insItem = db.prepare('INSERT INTO sales_delivery_items (delivery_id,sku_id,batch_no,qty,price,amount) VALUES (?,?,?,?,?,?)')
      let qtyAll = 0; let amtAll = 0
      for (const it of items) {
        const need = it.qty - it.shipped_qty
        if (need <= 0) continue
        const { plan } = stock.planShipment(db, { sourceDocType: 'SO', sourceDocId: id, warehouseId: order.warehouse_id, skuId: it.sku_id, needQty: need })
        let shipped = 0
        for (const p of plan) {
          stock.applyStockOut(db, { bizDate: date, docType: 'SAL_OUT', docNo, docId: did, warehouseId: order.warehouse_id, skuId: it.sku_id, batchNo: p.batchNo, qty: p.qty, unitCost: p.unitCost, counterparty: order.doc_no, operator: actor.name, remark: '销售出库(合成)' })
          insItem.run(did, it.sku_id, p.batchNo, p.qty, it.price, round2(p.qty * it.price))
          qtyAll += p.qty; shipped += p.qty; amtAll += p.qty * it.price
        }
        db.prepare('UPDATE sales_order_items SET shipped_qty = shipped_qty + ? WHERE id=?').run(shipped, it.id)
      }
      if (qtyAll <= 0) throw new Error(`合成订单无货可发：${order.doc_no}`)
      db.prepare('UPDATE sales_deliveries SET total_qty=?, total_amount=? WHERE id=?').run(qtyAll, round2(amtAll), did)
      // 与路由一致：发货单"建出来就是 shipped"，没有 DL.ship 流转可记，必须在同一事务里补一条 create 留痕
      logEvent({ db, docType: 'DL', id: did, docNo, action: 'create', actionName: '建单', to: 'shipped', actor, source: 'synth', remark: '发货单建单（发货出库，合成）',
        payload: { order_id: id, order_no: order.doc_no, warehouse_id: order.warehouse_id, qty: qtyAll, amount: round2(amtAll), inventory_doc_type: 'SAL_OUT', inventory_doc_no: docNo } })
      const pend = db.prepare('SELECT COALESCE(SUM(qty - shipped_qty),0) p FROM sales_order_items WHERE order_id=?').get(id).p
      applyTransition({ db, docType: 'SO', id, action: pend <= 0.0001 ? 'ship' : 'pick', actor, set: { updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') }, remark: `发货单 ${docNo}`, source: 'synth' })
    })()
  }

  // ---- 盘盈盘亏补足 --txns 目标（与 POST /api/inventory/adjust 同一入口） ----
  await phase('adjust', async () => {
    const need0 = opts.txns - txnCount()
    if (need0 <= 0) return
    const rows = db.prepare('SELECT warehouse_id w, sku_id k, batch_no b FROM inventory_stocks WHERE qty_on_hand >= 20 ORDER BY id').all()
    if (!rows.length) return
    let done = 0; let seq = 0
    const BATCH = 200
    while (done < need0) {
      if (shouldStop('adjust')) break
      db.transaction(() => {
        for (let n = 0; n < BATCH && done < need0; n++, done++) {
          const r = pick(rows); seq++
          const docNo = `SYNADJ${String(seq).padStart(9, '0')}`
          const date = ymdAdd(opts.anchor, -ri(1, 20))
          if (rng() < 0.5) stock.applyStockGain(db, { bizDate: date, docType: 'ADJ_IN', docNo, warehouseId: r.w, skuId: r.k, batchNo: r.b, qty: ri(1, 3), operator: actor.name, remark: '合成盘盈' })
          else stock.applyStockOut(db, { bizDate: date, docType: 'ADJ_OUT', docNo, warehouseId: r.w, skuId: r.k, batchNo: r.b, qty: 1, operator: actor.name, remark: '合成盘亏' })
          counts.adjustments++
        }
      })()
      progress('adjust', done, need0)
    }
    if (!stop) progress('adjust', need0, need0, true)
  })

  const verify = opts.verify ? await phase('verify', () => verifyInvariants(db)) : null
  const digest = businessDigest(db)
  db.pragma('wal_checkpoint(TRUNCATE)')
  // 刻意不跑 ANALYZE / PRAGMA optimize：应用本身从不跑，统计表会改变查询计划，使 explain-audit 看到的不再是应用真实会选的计划
  const tableCounts = {}
  for (const t of ['products', 'product_skus', 'inventory_batches', 'inventory_stocks', 'inventory_transactions', 'purchase_orders', 'purchase_order_items', 'purchase_receipts', 'sales_quotes', 'sales_orders', 'sales_order_items', 'sales_deliveries', 'credit_ledger', 'doc_events']) {
    tableCounts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
  }
  const dbFile = dbPathFor('cosmetic')
  db.close()
  return {
    schema_version: SCHEMA_VERSION,
    source: sourceIdentity(),
    timezone: process.env.TZ,
    scope_notice: 'Synthetic production-classified database generated on the local host. NOT customer data, NOT a target-host (dmserver) result.',
    // AB11：partial = 因时间预算 / 磁盘余量提前停止；reached 是实际达到的规模（来自库内真实行数，不是目标值）
    partial: !!stop,
    partial_reason: stop?.reason ?? null,
    partial_phase: stop?.phase ?? null,
    reached: { skus: master.skus.length, txns: tableCounts.inventory_transactions, txns_target: opts.txns, docs: counts.purchase_orders + counts.sales_orders, docs_target: opts.docs },
    batching,
    config: { skus: opts.skus, txns_target: opts.txns, docs: opts.docs, seed: opts.seed, anchor: opts.anchor, runtime_mode: 'production', industry: 'cosmetic' },
    host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? null, total_mem_mb: Math.round(os.totalmem() / 1048576), node: process.version },
    plan: { po_count: poCount, so_count: soCount, lines_per_po: purLines, lines_per_so: soLines },
    counts, table_counts: tableCounts,
    db_file: dbFile, db_bytes: fs.statSync(dbFile).size,
    password_file: passwordFile,
    phase_ms: phases,
    digest,
    invariants: verify
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv)
  const dataDir = guardEnvironment(env)
  if (opts.out && unsafeOutput(opts.out)) throw usage('--out 不得位于仓库 data/ 内，父目录必须已存在，且必须是尚不存在的新文件（不覆盖、不跟随符号链接）')
  const t0 = performance.now()
  const summary = await generate(opts, dataDir, env)
  summary.total_ms = Math.round(performance.now() - t0)
  if (opts.out) writeExclusive(path.resolve(opts.out), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify({ ok: summary.invariants ? summary.invariants.ok : null, partial: summary.partial, reached: summary.reached, total_ms: summary.total_ms, db_bytes: summary.db_bytes, counts: summary.counts, table_counts: summary.table_counts, digest: summary.digest, failed: (summary.invariants?.checks || []).filter((c) => !c.ok) }))
  return summary
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((s) => process.exit(s.invariants && !s.invariants.ok ? 1 : 0), (e) => {
    console.error(`synth-data: ${e.message}`)
    if (!e.exitCode) console.error(e.stack)
    process.exit(e.exitCode ?? 1)
  })
}
