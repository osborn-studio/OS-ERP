/**
 * ============================================================================
 * 文件标识：scripts/db-backup.mjs ｜ 数据库备份（三个行业库一起）：VACUUM INTO 快照 + 保留份数裁剪 + 可校验还原。
 * ============================================================================
 * 【职责】数据库备份（三个行业库一起）：VACUUM INTO 快照 + 保留份数裁剪 + 可校验还原。
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 数据库备份（三个行业库一起）：VACUUM INTO 快照 + 保留份数裁剪 + 可校验还原。
// 用法：
//   node scripts/db-backup.mjs              # 三库各备一份，按 settings.backup_keep 裁剪
//   node scripts/db-backup.mjs food         # 只备餐饮库
//   node scripts/db-backup.mjs --keep=3     # 临时改保留份数
//   node scripts/db-backup.mjs --verify     # 备完顺手打开备份库做完整性校验
//
// 存在的理由：
//   演示前把数据点乱了、或误删了单据，以前只能整库重建 —— 代价是手工点出来的
//   演示数据全没了。VACUUM INTO 是 SQLite 官方推荐的在线快照方式：不需要停服、
//   不会被 WAL 半写状态污染，产出的是一个干净的单文件库，拷回去就能用。
//
// 口径：
//   · 备份目录与保留份数从各库 settings 表读（backup_dir / backup_keep），
//     没有该键时用默认值 —— 保证「库里的配置」是唯一真相；
//   · 文件名带时间戳（yyyyMMdd-HHmmss），同秒冲突加序号后缀；
//   · 裁剪只删本脚本自己生成的文件（前缀匹配），不动用户手工放的任何文件。
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { INDUSTRIES, ROOT_DIR, dbPathFor } from '../server/db/index.js'

const args = process.argv.slice(2)
const verify = args.includes('--verify')
const keepArg = args.find((a) => a.startsWith('--keep='))
const target = args.find((a) => !a.startsWith('--'))
if (target && !INDUSTRIES[target]) {
  console.error(`未知行业：${target}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
  process.exit(1)
}
const codes = target ? [target] : Object.keys(INDUSTRIES)

const stamp = () => {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 从库里读运维参数；表缺失或键缺失时回落到默认值 */
function readSettings(db, fallback) {
  let dir = fallback.dir
  let keep = fallback.keep
  try {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('backup_dir','backup_keep')").all()
    for (const r of rows) {
      if (r.key === 'backup_dir' && r.value) dir = r.value
      if (r.key === 'backup_keep' && Number(r.value) > 0) keep = Number(r.value)
    }
  } catch {
    /* settings 表可能还没迁移出来，用默认值 */
  }
  return { dir, keep }
}

const results = []
let failed = 0

for (const code of codes) {
  const src = dbPathFor(code)
  const label = INDUSTRIES[code].label
  if (!fs.existsSync(src)) {
    results.push({ code, label, skipped: true, reason: '数据库文件不存在' })
    continue
  }

  // 只读打开源库：VACUUM INTO 只需要读一致性，不动源文件
  const db = new Database(src, { readonly: true })
  const fallback = { dir: 'data/backups', keep: keepArg ? Number(keepArg.split('=')[1]) : 10 }
  const cfg = readSettings(db, fallback)
  if (keepArg) cfg.keep = Number(keepArg.split('=')[1])

  const dir = path.isAbsolute(cfg.dir) ? cfg.dir : path.join(ROOT_DIR, cfg.dir)
  fs.mkdirSync(dir, { recursive: true })

  const base = path.basename(src, '.db')
  let out = path.join(dir, `${base}_${stamp()}.db`)
  let n = 1
  while (fs.existsSync(out)) out = path.join(dir, `${base}_${stamp()}_${n++}.db`)

  try {
    // VACUUM INTO 产出的文件是紧凑、无 WAL 残留的完整库
    db.prepare('VACUUM INTO ?').run(out)
  } catch (e) {
    db.close()
    failed++
    results.push({ code, label, error: e.message })
    continue
  }

  const tables = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").get().c
  const migrations = (() => {
    try {
      return db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c
    } catch {
      return 0
    }
  })()
  db.close()

  // 裁剪：只处理本脚本命名规则生成的文件
  const mine = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}_`) && f.endsWith('.db'))
    .map((f) => ({ f, p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  const removed = []
  for (const item of mine.slice(cfg.keep)) {
    fs.unlinkSync(item.p)
    removed.push(item.f)
  }

  let check = null
  if (verify) {
    const bk = new Database(out, { readonly: true })
    const integrity = bk.pragma('integrity_check', { simple: true })
    const bkTables = bk.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").get().c
    bk.close()
    check = { integrity, tables_match: bkTables === tables, backup_tables: bkTables }
  }

  results.push({
    code,
    label,
    size: fs.statSync(out).size,
    file: out,
    tables,
    migrations,
    kept: cfg.keep,
    pruned: removed.length,
    check
  })
}

for (const r of results) {
  if (r.skipped) {
    console.log(`  ${String(r.label).padEnd(14)} 跳过（${r.reason}）`)
    continue
  }
  if (r.error) {
    console.log(`  ${String(r.label).padEnd(14)} 失败：${r.error}`)
    continue
  }
  const mb = (r.size / 1024 / 1024).toFixed(1)
  let tail = `表 ${r.tables} / 迁移 ${r.migrations} / ${mb}MB / 保留 ${r.kept} 份，清理 ${r.pruned} 份`
  if (r.check) tail += ` ｜ 校验 ${r.check.integrity}${r.check.tables_match ? '、结构一致' : '、结构不一致⚠'}`
  console.log(`  ${String(r.label).padEnd(14)} ${r.file}`)
  console.log(`  ${' '.repeat(14)} ${tail}`)
}
console.log(failed ? `备份完成，其中 ${failed} 个失败` : '备份完成')
process.exit(failed ? 1 : 0)
