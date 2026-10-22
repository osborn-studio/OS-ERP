#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/test-product-qc-switch.mjs ｜ 测试：常驻守卫：成品「启用质检」开关的可售性判据（批次 V · 客户口径）
 * ============================================================================
 * 【职责】测试：常驻守卫：成品「启用质检」开关的可售性判据（批次 V · 客户口径）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 常驻守卫：成品「启用质检」开关的可售性判据（批次 V · 客户口径）
//
// 用法：
//   node scripts/test-product-qc-switch.mjs
//   GML_DATA_DIR=/tmp/xxx node scripts/test-product-qc-switch.mjs
//
// 绑住的是一句话（客户原话）：
//   「检验成品默认不可售，但客户可以选择成品是否开启质检：成品属性里开启质检，
//     就这批货必须走质检流程才能出售；不开启，这个成品可售。」
//
// 为什么它必须是常驻断言、而不是"这轮人手看过一次"：
//   这条口径落在 `server/lib/stock.js` 的 `qcSaleBlock()` **一个函数**上，
//   而它同时被两条路调用 —— `pickBatches`（自动拣选）与 `assertBatchUsable`（指名批次出库）。
//   本项目踩过的那一版缺陷正是"两处各写一份 if"：同一批货**自动拣选时不可用、指名要用时可用**。
//   谁哪天在图省事把某一条路另写一遍，这套断言里的 ⑥ 会当场变红 —— 否则不会有任何东西会响。
//
// 断言的 7 件事：
//   ① require_qc=1 + 批次 pending   ⇒ 出库被拒（码 BATCH_NOT_SELLABLE、拒因含「尚在待检」）
//   ② require_qc=1 + 批次 rejected  ⇒ 出库被拒（同码、拒因含「检验不合格」）
//   ③ ①②的**拒因必须是两条不同文案**（合并成一句"不可售"就没法告诉用户去报检还是去处置）
//   ④ require_qc=1 + 批次 qualified ⇒ 放行（合法路径不能被拦死）
//   ⑤ require_qc=0 + 批次 pending   ⇒ 放行（默认行为一字未变）
//   ⑥ **同源**：自动拣选与指名出库对**每一批**给同一结论（本次最值钱的一条）
//   ⑦ 迁移 042 自证：列存在 + 取值域只 0/1（脏值下次启动收敛回 0）+ 第二次启动不重复执行
//
// 隔离纪律（本项目最硬的一条）：
//   · 未设 GML_DATA_DIR ⇒ **自落**到 /tmp/gml-qc-switch-<脚本名>（所以 regress-all 不设 env 也能跑）
//   · 指向仓库 data/ 或任何非 /tmp 路径 ⇒ **当场 exit 2 拒跑**（不设 env 就 exit 2 会把回归自己拦住 —— 上批真实事故）
//   · 每次运行都在隔离目录里 `mkdtemp` 一个**全新库**目录，跑完删掉；**只读仓库**（只读 schema.sql）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DATA = path.join(ROOT, 'data')
const require = createRequire(import.meta.url)

/** 隔离规则：未设 env ⇒ 自落 /tmp；指向仓库 data/ 或非 /tmp ⇒ exit 2 */
function requireIsolatedDataDir() {
  const name = path.basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, '')
  const raw = process.env.GML_DATA_DIR || ''
  const abs = raw ? path.resolve(raw) : path.join('/tmp', `gml-qc-switch-${name}`)
  if (abs === REPO_DATA || abs.startsWith(REPO_DATA + path.sep)) {
    console.error(`✗ 拒绝运行：隔离目录指向仓库 data/（${abs}）。本脚本只允许在 /tmp 下的副本上跑。`)
    process.exit(2)
  }
  if (!abs.startsWith('/tmp/')) {
    console.error(`✗ 拒绝运行：隔离目录必须在 /tmp 下（实得 ${abs}）；不设 GML_DATA_DIR 时会自落到 /tmp/gml-qc-switch-${name}。`)
    process.exit(2)
  }
  fs.mkdirSync(abs, { recursive: true })
  console.log(`${raw ? 'GML_DATA_DIR' : '未设 GML_DATA_DIR ⇒ 自落'} 隔离库目录：${abs}（仓库 data/ 不会被写）`)
  return { dir: abs, selfFallback: !raw }
}

const { dir: DIR, selfFallback } = requireIsolatedDataDir()
// 每次运行都用一个**全新库**（mkdtemp 保证不与任何并发跑批撞名）。
// ⚠️ 必须在 import `server/db/index.js` **之前**把 GML_DATA_DIR 钉住：
//    该模块在加载时就把 `DATA_DIR = process.env.GML_DATA_DIR || <仓库>/data` 求值定死，
//    不钉的话"未设 env"这一支会让 `initSchemaFor` 落到**仓库 data/**（自落目录就白算了）。
//    ⚠️ 而且**只有动态 import 才保得住这次钉 env**：ESM 的静态 import 会被提升到模块体之前求值，
//    所以下面每一处触到 db/index.js 的 import 都必须是 `await import(...)`
//    （`lib/stock.js → lib/costing.js → lib/docflow.js → db/index.js` 是一整条链，
//     任何一跳改回静态形式，这次钉 env 就白钉 —— 所以下面还有一道落点自证闸门兜着）。
const RUN_DIR = fs.mkdtempSync(path.join(DIR, 'run-'))
process.env.GML_DATA_DIR = RUN_DIR
console.log(`本次运行的全新库目录：${RUN_DIR}`)

// 形参名与项目主流形状对齐（cond,msg,detail）—— check-test-helper-shape 按形参名判形状，别改成 c/m 这类缩写。
let pass = 0
let fail = 0
const failures = []
const ok = (cond, msg, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`) }
  else { fail += 1; failures.push(msg); console.log(`  ✗ ${msg}${detail ? '  → ' + detail : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

function cleanup() {
  const dirs = selfFallback ? [RUN_DIR, DIR] : [RUN_DIR]
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 清不掉不影响断言结论 */ } }
}

async function main() {
  const { initSchemaFor, DATA_DIR } = await import('../server/db/index.js')
  // 落点自证闸门：判的就是模块**真实用的**那个 DATA_DIR（不是自己再算一遍）。
  // 有牙的证据：把上面任一处 `await import(...)` 改回静态 `import ... from` ⇒ 静态 import 被提升到
  // 钉 env 之前 ⇒ 这里 DATA_DIR 会变成**仓库 data/** ⇒ 当场 exit 2，而不是安静地把仓库库写花。
  if (!String(DATA_DIR).startsWith('/tmp/')) {
    console.error(`✗ 拒绝运行：db/index.js 实际解析出的 DATA_DIR=${DATA_DIR} 不在 /tmp 下 —— 钉 env 没生效（多半是某处 import 被改成静态了），会写仓库 data/。`)
    process.exit(2)
  }
  console.log(`落点自证：db/index.js 实际使用 DATA_DIR=${DATA_DIR}（已过 /tmp 闸门）`)
  const { runMigrations } = await import('../server/db/migrations/runner.js')
  const { applyStockIn, applyStockOut, pickBatches, clearParamCache } = await import('../server/lib/stock.js')
  const m042 = require(path.join(ROOT, 'server/db/migrations/042_product_require_qc.cjs'))

  // ---------- 全新库：schema.sql + 全迁移（不读任何既有数据） ----------
  const db = initSchemaFor('cosmetic')
  clearParamCache()

  section('⑦ 迁移 042 自证')
  const cols = db.prepare('PRAGMA table_info(products)').all().map((r) => r.name)
  ok(cols.includes('require_qc'), '迁移 042 落地 products.require_qc 列', cols.join(','))
  ok(!!db.prepare('SELECT 1 AS h FROM schema_migrations WHERE id=?').get('042_product_require_qc'), '042 已登记进 schema_migrations')
  ok(m042.verify(db) === true, '042.verify() = true（结构不变量成立）')

  // ---------- 夹具：一个开启质检的成品、一个不开启的成品 ----------
  db.prepare(`INSERT OR IGNORE INTO orgs (id, code, name, type, parent_id, level, path, is_legal, owner_org_id, currency, region, status)
    VALUES (1,'HQ','演示总部','group',NULL,1,'/1/',1,1,'CNY','华东','active')`).run()
  db.prepare(`INSERT OR IGNORE INTO orgs (id, code, name, type, parent_id, level, path, is_legal, owner_org_id, currency, region, status)
    VALUES (0,'SYS','系统默认主体','group',NULL,1,'/0/',0,0,'CNY','华东','active')`).run()
  db.prepare("INSERT INTO warehouses (id, code, name, type, currency, org_id, default_owner_org_id, region) VALUES (1,'WH01','总仓','central','CNY',1,1,'华东')").run()

  db.prepare("INSERT INTO products (id, spu_code, name, unit, require_qc) VALUES (1,'SPU-QC-ON','演示成品·开启质检','瓶',1)").run()
  db.prepare("INSERT INTO products (id, spu_code, name, unit, require_qc) VALUES (2,'SPU-QC-OFF','演示成品·不启用质检','瓶',0)").run()
  db.prepare("INSERT INTO products (id, spu_code, name, unit, require_qc) VALUES (3,'SPU-QC-BAD','演示成品·脏值','瓶',0)").run()
  db.prepare("INSERT INTO product_skus (id, product_id, sku_code, name) VALUES (1,1,'SKU-QC-ON','演示成品·开启质检')").run()
  db.prepare("INSERT INTO product_skus (id, product_id, sku_code, name) VALUES (2,2,'SKU-QC-OFF','演示成品·不启用质检')").run()
  db.prepare("INSERT INTO product_skus (id, product_id, sku_code, name) VALUES (3,3,'SKU-QC-BAD','演示成品·脏值')").run()

  const DAY = '2026-10-15'
  const batches = [
    [1, 'ON-PENDING', 'pending'],
    [1, 'ON-REJECTED', 'rejected'],
    [1, 'ON-QUALIFIED', 'qualified'],
    [2, 'OFF-PENDING', 'pending']
  ]
  for (const [skuId, batchNo] of batches) {
    applyStockIn(db, { bizDate: DAY, docType: 'PUR_IN', docNo: `IN-${batchNo}`, warehouseId: 1, skuId, batchNo, qty: 100, unitCost: 10 })
  }
  for (const [skuId, batchNo, qc] of batches) {
    db.prepare('UPDATE inventory_batches SET qc_status=? WHERE sku_id=? AND batch_no=?').run(qc, skuId, batchNo)
  }
  clearParamCache()
  ok(
    db.prepare("SELECT COUNT(*) c FROM inv_params WHERE param_key IN ('block_pending_qc','block_rejected_qc')").get().c === 0,
    '口径前提：未在库中配置 inv_params（rejected 默认拦、pending 默认放行）'
  )

  const out = (skuId, batchNo, tag) => {
    try {
      applyStockOut(db, { bizDate: DAY, docType: 'SAL_OUT', docNo: `OUT-${tag}-${batchNo}`, warehouseId: 1, skuId, batchNo, qty: 1, source: 'test' })
      return { threw: false, message: '' }
    } catch (e) {
      return { threw: true, code: e.code, message: e.message || '', reasons: e.detail?.reasons }
    }
  }
  const pickedBatches = (skuId) => pickBatches(db, 1, skuId, 1e9, { ownerOrgId: 1 })

  section('① require_qc=1 + 批次 pending ⇒ 出库被拒（客户口径的"默认不可售"）')
  const c1 = out(1, 'ON-PENDING', 'C1')
  ok(c1.threw, '待检批次出库被拒（否则"待检货"被当可售货消耗掉了）')
  ok(c1.code === 'BATCH_NOT_SELLABLE', '错误码沿用既有 BATCH_NOT_SELLABLE（未新造近名码）', `实得 ${c1.code}`)
  ok(/尚在待检/.test(c1.message), '拒因含「尚在待检」', c1.message)

  section('② require_qc=1 + 批次 rejected ⇒ 出库被拒')
  const c2 = out(1, 'ON-REJECTED', 'C2')
  ok(c2.threw, '不合格批次出库被拒')
  ok(c2.code === 'BATCH_NOT_SELLABLE', '错误码与①同码（同一道闸门、同一类"不可售"）', `实得 ${c2.code}`)
  ok(/检验不合格/.test(c2.message), '拒因含「检验不合格」', c2.message)

  section('③ ①②的拒因必须是两条不同文案')
  ok(c1.message !== '' && c2.message !== '' && c1.message !== c2.message, '两条拒因不相等（不是一句含糊的"不可售"）',
    `①=${JSON.stringify(c1.reasons)} ②=${JSON.stringify(c2.reasons)}`)

  section('④ require_qc=1 + 批次 qualified ⇒ 放行（合法路径不能被拦死）')
  const c4 = out(1, 'ON-QUALIFIED', 'C4')
  ok(!c4.threw, '质检合格批次放行', c4.message)

  section('⑤ require_qc=0 + 批次 pending ⇒ 放行（默认行为一字未变）')
  const c5 = out(2, 'OFF-PENDING', 'C5')
  ok(!c5.threw, '未启用质检的成品：待检批次仍可出库', c5.message)

  section('⑥ 同源：自动拣选（pickBatches）与指名出库（applyStockOut）同一判据')
  const onPicks = pickedBatches(1).picks.map((p) => p.batchNo)
  const offPicks = pickedBatches(2).picks.map((p) => p.batchNo)
  ok(!onPicks.includes('ON-PENDING') && !onPicks.includes('ON-REJECTED'), 'require_qc=1：pending / rejected 两批都不被自动拣出', onPicks.join(','))
  ok(onPicks.includes('ON-QUALIFIED'), 'require_qc=1：qualified 批仍被自动拣出', onPicks.join(','))
  ok(offPicks.includes('OFF-PENDING'), 'require_qc=0：pending 批仍被自动拣出', offPicks.join(','))
  // 同源判据本身：逐批比对"拣选拦不拦"与"指名出库拦不拦"必须一致
  const mismatch = []
  for (const [skuId, batchNo] of [[1, 'ON-PENDING'], [1, 'ON-REJECTED'], [1, 'ON-QUALIFIED'], [2, 'OFF-PENDING']]) {
    const pickedBlocked = !pickedBatches(skuId).picks.some((p) => p.batchNo === batchNo)
    const outBlocked = out(skuId, batchNo, 'SAME').threw
    if (pickedBlocked !== outBlocked) mismatch.push(`${batchNo}(拣选${pickedBlocked ? '拦' : '放'}/出库${outBlocked ? '拦' : '放'})`)
  }
  ok(mismatch.length === 0, '逐批一致：自动拣选与指名出库对同一批货给同一结论（判据只落一处）', mismatch.join(' '))

  section('⑦ 迁移 042 的取值域与"下次启动收敛"')
  const badVal = db.prepare("SELECT require_qc FROM products WHERE id=3").get().require_qc
  ok(badVal === 0 || badVal === 1, '取值域：库内 require_qc 只取 0/1', `实得 ${badVal}`)
  db.prepare('UPDATE products SET require_qc=7 WHERE id=3').run() // 直写一个脏值（界面写不进来，只有直写库会）
  const heal = runMigrations(db)
  ok(heal.healed.includes('042_product_require_qc'), '脏值被 verify 判为脱节 ⇒ 下次启动自愈重跑 042', `healed=[${heal.healed}]`)
  ok(db.prepare('SELECT require_qc FROM products WHERE id=3').get().require_qc === 0, '脏值被收敛回 0（不启用 = 沿用旧行为）')
  const again = runMigrations(db)
  ok(again.applied.length === 0 && !again.healed.includes('042_product_require_qc'),
    '第二次启动不重复执行 042（applied 空、healed 不含它）', `applied=[${again.applied}] healed=[${again.healed}]`)

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (fail) console.log('失败项：\n - ' + failures.join('\n - '))
}

try {
  await main()
} catch (e) {
  fail += 1
  console.error(`\n✗ 脚本异常：${e && e.stack ? e.stack : e}`)
  console.log(`\n通过 ${pass} / 失败 ${fail}`)
} finally {
  cleanup()
}
process.exit(fail ? 1 : 0)
