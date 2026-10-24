/**
 * ============================================================================
 * 文件标识：scripts/lib/audit-chain-cli.mjs ｜ 审计哈希链两个脚本（校验 / 归档）共用的参数解析与行业库定位（ADR-0049）
 * ============================================================================
 * 【职责】`--data-dir <绝对路径>` 先写进 `GML_DATA_DIR`，**然后才**动态 import `server/db/index.js`（它在加载时读取数据目录）；
 *   再走 `requireExplicitDataDir()`（拒绝仓库 `data/`）与 `dbPathFor()`（不自己拼库文件名），与 retention / privacy 脚本同一口径。
 *   不存在的行业库只记为 absent，不创建。
 * 【改它要注意什么】不要在这里 import 任何会读数据目录的模块作为静态依赖。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

export function die(code, message, status = 2) {
  console.error(`${code}: ${message}`)
  process.exit(status)
}

/** 解析 `--name value`、可重复的 `--name value`（`multi`，结果是数组）与布尔开关；未知参数退出 2 */
export function parseArgs(argv, { values = [], flags = [], multi = [] }) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (flags.includes(a)) out[a.slice(2)] = true
    else if (multi.includes(a)) { // 可重复的 `--name value`：收集成数组（AG5：公钥集合）
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) die('USAGE', `${a} 需要一个值`)
      ;(out[a.slice(2)] ??= []).push(v)
    } else if (values.includes(a)) {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) die('USAGE', `${a} 需要一个值`)
      out[a.slice(2)] = v
    } else die('USAGE', `未知参数：${a}（可用：${[...values, ...multi, ...flags].join('、')}）`)
  }
  return out
}

/** 返回 { INDUSTRIES, dbPathFor, targets: [{ code, file }] }（只含库文件存在的行业，另有 absent 列表） */
export async function locateDatabases(args) {
  if (args['data-dir']) {
    if (!path.isAbsolute(args['data-dir'])) die('USAGE', '--data-dir 必须是绝对路径')
    process.env.GML_DATA_DIR = args['data-dir']
  }
  const { INDUSTRIES, requireExplicitDataDir, dbPathFor } = await import('../../server/db/index.js')
  try {
    requireExplicitDataDir()
  } catch (e) {
    die(e.code || 'USAGE', e.message)
  }
  if (args.industry && !Object.hasOwn(INDUSTRIES, args.industry)) die('USAGE', `未知行业：${args.industry}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
  const codes = args.industry ? [args.industry] : Object.keys(INDUSTRIES)
  const targets = []
  const absent = []
  for (const code of codes) {
    const file = dbPathFor(code)
    if (fs.existsSync(file)) targets.push({ code, file })
    else absent.push(code)
  }
  return { targets, absent }
}
