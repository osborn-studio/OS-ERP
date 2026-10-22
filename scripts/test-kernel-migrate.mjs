#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/test-kernel-migrate.mjs ｜ 测试：【复现脚本】内核定义改动在「已迁移库」上能不能收敛（批次 V · A3/M7/A1/S-4）
 * ============================================================================
 * 【职责】测试：【复现脚本】内核定义改动在「已迁移库」上能不能收敛（批次 V · A3/M7/A1/S-4）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 【复现脚本】内核定义改动在「已迁移库」上能不能收敛（批次 V · A3/M7/A1/S-4）
//
//   用法：GML_DATA_DIR=/tmp/xxx node scripts/repro-kernel-migrate.mjs
//
// 复现的结论：
//   ① `008.up()` 对 `doc_states`/`doc_actions` 是 **DELETE + 全量 INSERT**、`doc_types` 是 **upsert**；
//      `027.up()` 是 **upsert** ⇒ **不是 041 那个 `INSERT OR IGNORE` 形状** ——
//      新加的状态/边（`WW.part_received`、`RB.confirmed`、`SO.returned.kind`）**下次启动就会落到已迁移库**，
//      **不需要再加一次迁移**。
//   ② 连带效应：008 重跑会 `DELETE doc_actions`，把 014 打的 `require_approval=1` 清掉 ⇒
//      014 紧随其后也被判脱节并自愈 ⇒ 第一次 `healed=[008, 014]`；**第二次不再触发任何自愈**（收敛）。
//
// 做法：把仓库 data/ 下三个库（=「已迁移库」，定义还是旧的）只读拷到隔离目录，再跑迁移。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DATA = path.join(ROOT, 'data')
const require = createRequire(import.meta.url)

// 隔离规则（本项目硬纪律）：
//   · 未设 GML_DATA_DIR ⇒ **自落**到 /tmp/gml-kernel-<脚本名>（所以它也能被 regress-all 自动发现而不碰仓库 data/）
//   · 指向仓库 data/ 或任何非 /tmp 路径 ⇒ 当场 exit 2 拒跑
//   · 本脚本只**只读**地从仓库 data/ 备份到隔离目录，绝不写 data/
function requireIsolatedDataDir() {
  const name = path.basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, '')
  const raw = process.env.GML_DATA_DIR || ''
  const abs = raw ? path.resolve(raw) : path.join('/tmp', `gml-kernel-${name}`)
  if (abs === REPO_DATA || abs.startsWith(REPO_DATA + path.sep)) {
    console.error(`✗ 拒绝运行：隔离目录指向仓库 data/（${abs}）。本脚本只允许在 /tmp 下的副本上跑。`); process.exit(2)
  }
  if (!abs.startsWith('/tmp/')) {
    console.error(`✗ 拒绝运行：隔离目录必须在 /tmp 下（实得 ${abs}）；不设 GML_DATA_DIR 时会自落到 /tmp/gml-kernel-${name}。`); process.exit(2)
  }
  fs.mkdirSync(abs, { recursive: true })
  // ⚠️ **先钉 env、再 import** `server/db/index.js` —— 顺序不能反。
  //    `db/index.js:11` 是 `DATA_DIR = process.env.GML_DATA_DIR || path.join(ROOT_DIR,'data')`，
  //    它在**模块加载时**求值一次。原先这里只算出 abs、没钉回 env，于是随后 `getDbFor(code)`
  //    打开的是**仓库 data/**，`runMigrations` 的自愈也写在那儿 —— 而脚本照样打绿。
  //    这就是"自证说落 /tmp、实际落 data/"那一族：报告与实际不同源。
  process.env.GML_DATA_DIR = abs
  console.log(`${raw ? 'GML_DATA_DIR' : '未设 GML_DATA_DIR ⇒ 自落'} 隔离库目录：${abs}（仓库 data/ 不会被写）`)
  return abs
}
const DIR = requireIsolatedDataDir()
console.log(`隔离库目录：${DIR}`)

const Database = (await import('better-sqlite3')).default
for (const c of ['cosmetic', 'food', 'apparel']) {
  const src = new Database(path.join(REPO_DATA, `gml_${c}.db`), { readonly: true })
  const dst = path.join(DIR, `gml_${c}.db`)
  for (const ext of ['', '-wal', '-shm']) { const p = dst + ext; if (fs.existsSync(p)) fs.rmSync(p) }
  await src.backup(dst)
  src.close()
}

// 注意：下面这两个 import 会读 GML_DATA_DIR（已在上面钉成 /tmp 下的隔离目录）
const { getDbFor, INDUSTRIES, DATA_DIR } = await import('../server/db/index.js')
// 闸门（**启动即验**）：报告与实际必须同源 —— 这里打的/判的就是模块**真实用的**那个 DATA_DIR，
// 不是自己再算一遍的路径。判据只有一条：它必须以 /tmp/ 开头。
//   这条有牙的证据：把上面那行 `process.env.GML_DATA_DIR = abs` 删掉 ⇒ 这里 DATA_DIR 会变成
//   仓库 data/ ⇒ **当场 exit 2**，而不是安静地去写 data/、还打一个绿。
if (!String(DATA_DIR).startsWith('/tmp/')) {
  console.error(`✗ 拒绝运行：db/index.js 实际解析出的 DATA_DIR=${DATA_DIR} 不在 /tmp 下 —— 隔离没生效，会写仓库 data/。`)
  process.exit(2)
}
console.log(`db/index.js 实际使用 DATA_DIR=${DATA_DIR}（已过 /tmp 闸门）`)
const { runMigrations } = await import('../server/db/migrations/runner.js')
const m008 = require(path.join(ROOT, 'server/db/migrations/008_doc_kernel.cjs'))
const m027 = require(path.join(ROOT, 'server/db/migrations/027_transition_policy.cjs'))
const m014 = require(path.join(ROOT, 'server/db/migrations/014_approval.cjs'))

let fail = 0
// 形参名与项目主流两参形状对齐（cond,msg）—— 守卫按形参名判形状，别改成 c/m 这类缩写。
const ok = (cond, msg) => { if (!cond) { fail++; console.log(`  ✗ ${msg}`) } else console.log(`  ✓ ${msg}`) }

for (const code of Object.keys(INDUSTRIES)) {
  const db = getDbFor(code)
  console.log(`\n=== ${code} ===`)
  const fp = (t) => db.prepare('SELECT fingerprint FROM schema_def_fingerprints WHERE migration_id=?').get(t)?.fingerprint
  const st = (t, c) => db.prepare('SELECT kind,is_final FROM doc_states WHERE doc_type=? AND code=?').get(t, c)
  const before = fp('008_doc_kernel')
  console.log(`  迁移前：008 指纹=${before} part_received=${!!st('WW', 'part_received')} RB.confirmed=${!!st('RB', 'confirmed')} SO.returned.kind=${st('SO', 'returned')?.kind}`)

  const r1 = runMigrations(db, { log: (m) => console.log('    [migrate] ' + m) })
  console.log(`  第一次 runMigrations：applied=[${r1.applied}] healed=[${r1.healed}]`)
  console.log(`  迁移后：008 指纹=${fp('008_doc_kernel')} part_received=${!!st('WW', 'part_received')} RB.confirmed=${!!st('RB', 'confirmed')} SO.returned.kind=${st('SO', 'returned')?.kind}`)

  // 起始状态有两种合法情形：① 真·已迁移库（旧定义，应触发一次自愈）；
  // ② 此前已经收敛过（库里已是新定义，首跑不该再自愈）。
  // 判据是「跑完之后必须落在新定义上」，不是「必须发生一次自愈」——否则脚本会因基线不同而假红。
  const startedOld = !st('WW', 'part_received') || !st('RB', 'confirmed') || st('SO', 'returned')?.kind !== 'done'
  if (startedOld) {
    ok(r1.healed.includes('008_doc_kernel'), '起始是旧定义 ⇒ 008 第一次跑就被自愈')
    ok(fp('008_doc_kernel') !== before, '008 指纹已从旧定义更新为新定义')
  } else {
    ok(r1.healed.length === 0, '起始已是新定义 ⇒ 首跑无需自愈（此前已收敛；这条证明"收敛"不是靠反复自愈）')
  }
  ok(!!st('WW', 'part_received') && Number(st('WW', 'part_received').is_final) === 0, 'M7 part_received 落到已迁移库且非终态')
  ok(!!st('RB', 'confirmed') && Number(st('RB', 'confirmed').is_final) === 0, 'A1 RB.confirmed 落到已迁移库且非终态')
  ok(st('SO', 'returned')?.kind === 'done' && Number(st('SO', 'returned').is_final) === 1, 'S-4 SO.returned kind=done 且仍是终态')

  const cnt = (sql, ...a) => db.prepare(sql).get(...a).c
  ok(cnt("SELECT COUNT(*) c FROM doc_actions WHERE doc_type='WW' AND from_state='part_received'") > 0, 'WW 在 part_received 上有出边')
  ok(cnt("SELECT COUNT(*) c FROM doc_actions WHERE doc_type='WW' AND from_state='part_received' AND to_state='closed'") === 1, 'WW 边 part_received→closed 在册')
  ok(cnt("SELECT COUNT(*) c FROM doc_actions WHERE doc_type='RB' AND action='pay' AND from_state='confirmed'") === 1, 'RB 边 confirmed→paid 在册')
  ok(cnt("SELECT COUNT(*) c FROM doc_actions WHERE doc_type='RB' AND action='pay' AND from_state='pending'") === 0, 'RB 直跳边 pending→paid 已删除')
  // 内核不变量（与 verify 同一判据，独立复算）
  ok(cnt("SELECT COUNT(*) c FROM doc_actions a JOIN doc_states s ON s.doc_type=a.doc_type AND s.code=a.from_state WHERE s.is_final=1") === 0, '不变量：终态无出边')
  ok(cnt("SELECT COUNT(*) c FROM doc_actions a WHERE NOT EXISTS (SELECT 1 FROM doc_states s WHERE s.doc_type=a.doc_type AND s.code=a.from_state) OR NOT EXISTS (SELECT 1 FROM doc_states s WHERE s.doc_type=a.doc_type AND s.code=a.to_state)") === 0, '不变量：每条边两端状态都已定义')
  ok(m008.verify(db) === true, '008.verify() = true')
  ok(m027.verify(db) === true, '027.verify() = true（恒假 ⇒ 每次启动一次无意义自愈）')
  ok(m014.verify(db) === true, '014.verify() = true（require_approval 标记仍在）')
  const r2 = runMigrations(db, { log: (m) => console.log('    [migrate] ' + m) })
  ok(r2.healed.length === 0, `第二次 runMigrations 无自愈（healed=[${r2.healed}]）⇒ 收敛`)
}

console.log(`\n${fail ? '✗ 失败 ' + fail + ' 条' : '✓ 三库都在已迁移库上收敛：新状态/新边下次启动即生效，不需要新迁移'}`)
process.exit(fail ? 1 : 0)
