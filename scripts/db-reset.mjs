/**
 * ============================================================================
 * 文件标识：scripts/db-reset.mjs ｜ 一键重置（演示前一键回到干净状态）：先备份 → 删库 → 迁移 → 重灌演示数据。
 * ============================================================================
 * 【职责】一键重置（演示前一键回到干净状态）：先备份 → 删库 → 迁移 → 重灌演示数据。
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 一键重置（演示前一键回到干净状态）：先备份 → 删库 → 迁移 → 重灌演示数据。
// 用法：
//   node scripts/db-reset.mjs              # 三库重置（默认自动先备份）
//   node scripts/db-reset.mjs food         # 只重置餐饮库
//   node scripts/db-reset.mjs --no-backup  # 跳过备份（危险，演示机上别用）
//   node scripts/db-reset.mjs --yes        # 跳过交互确认（CI / 无人值守）
//
// 存在的理由：
//   reseed-all --force 能重灌数据，但清不掉「库文件本身已被写乱」的情况
//   （比如某次手工 ALTER 留下的列、或 WAL 文件与主库不一致）。
//   演示现场需要的是一条命令把「文件系统状态」也一起复位，
//   并且在动手之前自动留一份可回滚的快照 —— 删库不备份是不可接受的。
//
// 安全设计：
//   · 默认先备份到 settings.backup_dir（快照失败即中止，绝不带着风险删库）；
//   · 首次运行需要交互输入 yes（--yes 可跳过），避免误触；
//   · 只删 data 目录下三个已知的行业库文件及其 -wal / -shm，不做通配删除。
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import Database from 'better-sqlite3'
import { INDUSTRIES, ROOT_DIR, dbPathFor } from '../server/db/index.js'
import { bootIndustry, bootAll } from '../server/db/boot.js'

const args = process.argv.slice(2)
const autoYes = args.includes('--yes')
const noBackup = args.includes('--no-backup')
const target = args.find((a) => !a.startsWith('--'))
if (target && !INDUSTRIES[target]) {
  console.error(`未知行业：${target}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
  process.exit(1)
}
const codes = target ? [target] : Object.keys(INDUSTRIES)

function backup(industry) {
  const src = dbPathFor(industry)
  if (!fs.existsSync(src)) return null
  const db = new Database(src, { readonly: true })
  let dir = 'data/backups'
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='backup_dir'").get()
    if (row?.value) dir = row.value
  } catch {
    /* settings 尚未迁移出来，用默认目录 */
  }
  const outDir = path.isAbsolute(dir) ? dir : path.join(ROOT_DIR, dir)
  fs.mkdirSync(outDir, { recursive: true })
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const out = path.join(outDir, `${path.basename(src, '.db')}_prereset_${stamp}.db`)
  db.prepare('VACUUM INTO ?').run(out)
  db.close()
  return out
}

async function confirm(question) {
  if (autoYes) return true
  if (!process.stdin.isTTY) {
    console.error('非交互环境：请显式加 --yes 确认重置')
    return false
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((resolve) => rl.question(question, resolve))
  rl.close()
  return /^y(es)?$/i.test(String(answer).trim())
}

const ok = await confirm(`即将重置 ${codes.map((c) => INDUSTRIES[c].label).join('、')}，输入 yes 继续：`)
if (!ok) {
  console.log('已取消')
  process.exit(0)
}

// ---- 1. 备份（失败即中止）----
const backups = []
if (!noBackup) {
  for (const code of codes) {
    const file = backup(code)
    if (file) {
      backups.push(file)
      console.log(`  已备份 ${INDUSTRIES[code].label} → ${path.relative(ROOT_DIR, file)}`)
    }
  }
} else {
  console.log('  已跳过快照（--no-backup）')
}

// ---- 2. 删库文件（含 WAL / SHM 伴生文件）----
for (const code of codes) {
  const src = dbPathFor(code)
  for (const f of [src, `${src}-wal`, `${src}-shm`]) {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f)
      console.log(`  已删除 ${path.relative(ROOT_DIR, f)}`)
    }
  }
}

// ---- 3. 迁移 + 重灌 ----
const t0 = Date.now()
const results = target
  ? [bootIndustry(target, { force: true, log: (m) => console.log(`  [${target}] ${m}`) })]
  : bootAll({ force: true, log: (m) => console.log(`  ${m}`) })

for (const r of results) {
  console.log(`  ${String(r.label).padEnd(14)} ${r.rebuilt ? '已重建' : '沿用现有数据'}  凭据新增 ${r.tokens}`)
}
console.log(`重置完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
if (backups.length) console.log(`回滚方式：把 ${backups.length} 份快照拷回 data/ 目录并改回原名`)
