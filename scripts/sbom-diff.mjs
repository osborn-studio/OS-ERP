#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/sbom-diff.mjs ｜ 两份 CycloneDX SBOM 的组件增删变对比 CLI（AF7）
 * ============================================================================
 * 【用法】node scripts/sbom-diff.mjs <previous.cdx.json> [<current.cdx.json>] [--json-out=<file>] [--table-out=<file>]
 *   current 缺省为 release/sbom.cdx.json（相对包根）。表格打印到 stdout；JSON 只写 --json-out。
 * 【退出码】0 = 对比完成（无论有无差异，差异只是信息）；1 = 前一份或当前 SBOM 畸形 / 不可读；2 = 用法错误。
 *   与 `verify-release --sbom-diff` 共用 scripts/lib/sbom-diff.mjs。前一份文件按不可信数据处理，见该库的说明。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { diffSboms, loadSbomFile, renderTable } from './lib/sbom-diff.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const pos = args.filter((a) => !a.startsWith('--'))
if (pos.length < 1 || pos.length > 2 || args.some((a) => a.startsWith('--') && !/^--(json-out|table-out)=.+$/.test(a))) {
  console.error('usage: node scripts/sbom-diff.mjs <previous.cdx.json> [<current.cdx.json>] [--json-out=<file>] [--table-out=<file>]')
  process.exit(2)
}
try {
  const previous = loadSbomFile(path.resolve(pos[0]))
  const current = loadSbomFile(pos[1] ? path.resolve(pos[1]) : path.join(root, 'release/sbom.cdx.json'))
  const diff = diffSboms(previous, current)
  const table = renderTable(diff)
  process.stdout.write(table)
  if (flag('json-out')) fs.writeFileSync(path.resolve(flag('json-out')), `${JSON.stringify(diff, null, 2)}\n`)
  if (flag('table-out')) fs.writeFileSync(path.resolve(flag('table-out')), table)
} catch (error) {
  console.error(`[sbom-diff] ${error.message}`)
  process.exit(1)
}
