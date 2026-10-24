#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/audit-verify-chain.mjs ｜ 审计日志哈希链校验：顺序走一遍，报告第一个断点（ADR-0049）
 * ============================================================================
 * 【职责】只读打开各行业库，对 `audit_logs` 跑 `verifyChain`：内容被改（content）、中间行被删 / 插入 / 重排（link）、
 *   有行没入链（unchained）都会指出**第一个**出问题的行 id。保留清理 / 归档 / 隐私抹除登记的锚点被承认为合法断口。
 *
 * 【用法】node scripts/audit-verify-chain.mjs --data-dir <绝对路径> [--industry <行业>] [--expect-tip <64 位十六进制>] [--json]
 *   · `--expect-tip`：与链尾 row_hash 比对。链本身发现不了"整段尾部被截掉"，运维应把每次校验打印的 tip 带外保存，下次传进来。
 *   退出码：0 全部 OK；1 有断点（或库未迁移到 068）；2 参数 / 环境错误。
 * 【边界】不改库、不创建缺失的行业库；不覆盖 user_name / module / ip 三列（规格如此，见 ADR-0049「限制」）。
 * ============================================================================
 */
import Database from 'better-sqlite3'
import { parseArgs, locateDatabases, die } from './lib/audit-chain-cli.mjs'

const args = parseArgs(process.argv.slice(2), { values: ['--data-dir', '--industry', '--expect-tip'], flags: ['--json'] })
if (!args['data-dir'] && !process.env.GML_DATA_DIR) die('USAGE', '用法：audit-verify-chain.mjs --data-dir <绝对路径> [--industry <行业>] [--expect-tip <hash>] [--json]')
if (args['expect-tip'] && !/^[0-9a-f]{64}$/.test(args['expect-tip'])) die('USAGE', '--expect-tip 必须是 64 位小写十六进制')
if (args['expect-tip'] && !args.industry) die('USAGE', '--expect-tip 只对单个行业有意义，请同时给 --industry')

const { verifyChain, chainColumnsPresent } = await import('../server/lib/audit-chain-verify.js')
const { targets, absent } = await locateDatabases(args)
const report = { ok: true, industries: {} }
for (const code of absent) report.industries[code] = { status: 'absent' }
for (const { code, file } of targets) {
  const db = new Database(file, { readonly: true })
  try {
    if (!chainColumnsPresent(db)) {
      report.ok = false
      report.industries[code] = { status: 'not-migrated', message: 'audit_logs 没有 prev_hash/row_hash 列（迁移 068 未执行）' }
      continue
    }
    const r = verifyChain(db, { expectTip: args['expect-tip'] })
    if (!r.ok) report.ok = false
    report.industries[code] = { status: r.ok ? 'ok' : 'broken', rows: r.rows, first_id: r.firstId, last_id: r.lastId, tip_hash: r.tipHash, anchors_used: r.anchorsUsed, ...(r.brk ? { break: r.brk } : {}) }
  } finally {
    db.close()
  }
}

if (args.json) console.log(JSON.stringify(report, null, 2))
else {
  for (const [code, r] of Object.entries(report.industries)) {
    if (r.status === 'ok') console.log(`OK    ${code}: ${r.rows} 行，id ${r.first_id ?? '-'}..${r.last_id ?? '-'}，锚点 ${r.anchors_used}，tip=${r.tip_hash ?? '(空表)'}`)
    else if (r.status === 'broken') console.log(`BREAK ${code}: 第一个断点 id=${r.break.id} 类型=${r.break.kind}（期望 ${r.break.expected}，实得 ${r.break.actual}）；此前 ${r.rows} 行正常`)
    else console.log(`${r.status.toUpperCase()} ${code}${r.message ? ': ' + r.message : ''}`)
  }
}
process.exit(report.ok ? 0 : 1)
