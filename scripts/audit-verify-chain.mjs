#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/audit-verify-chain.mjs ｜ 审计日志哈希链校验：顺序走一遍，报告第一个断点（ADR-0049）
 * ============================================================================
 * 【职责】只读打开各行业库，对 `audit_logs` 跑 `verifyChain`：内容被改（content）、中间行被删 / 插入 / 重排（link）、
 *   有行没入链（unchained）都会指出**第一个**出问题的行 id。保留清理 / 归档 / 隐私抹除登记的锚点被承认为合法断口。
 *
 * 【用法】node scripts/audit-verify-chain.mjs --data-dir <绝对路径> [--industry <行业>] [--expect-tip <64 位十六进制>] [--json]
 *            [--against-backup <备份文件或 .audit-manifest.json> [--archive-dir <归档目录>] [--strict-anchors]]
 *   · `--expect-tip`：与链尾 row_hash 比对。链本身发现不了"整段尾部被截掉"，运维应把每次校验打印的 tip 带外保存，下次传进来。
 *   · `--against-backup`（AC7，ADR-0049 补充）：读备份清单（`db-backup.mjs` 写的 `<备份>.audit-manifest.json` / `.enc`；加密备份需 GML_BACKUP_KEY），
 *     先交叉核对清单与备份内容，再要求在用链是备份链尾的**后代**。在用链能通过自身校验却不是后代 ⇒ 整链被重算（`rewrite`）。行业取自清单。
 *     链尾已被归档搬出库时，用 `--archive-dir` 指向归档摘要目录证明。`--strict-anchors`：备份之后新增 / 消失的锚点也算失败。
 *   退出码：0 全部 OK；1 有断点（或库未迁移到 068、`--against-backup` 非 ok）；2 参数 / 环境错误。
 * 【边界】不改库、不创建缺失的行业库；不覆盖 user_name / module / ip 三列（规格如此，见 ADR-0049「限制」）。
 * ============================================================================
 */
import path from 'node:path'
import Database from 'better-sqlite3'
import { parseArgs, locateDatabases, die } from './lib/audit-chain-cli.mjs'

const args = parseArgs(process.argv.slice(2), { values: ['--data-dir', '--industry', '--expect-tip', '--against-backup', '--archive-dir'], flags: ['--json', '--strict-anchors'] })
if (!args['data-dir'] && !process.env.GML_DATA_DIR) die('USAGE', '用法：audit-verify-chain.mjs --data-dir <绝对路径> [--industry <行业>] [--expect-tip <hash>] [--json]')
if (args['expect-tip'] && !/^[0-9a-f]{64}$/.test(args['expect-tip'])) die('USAGE', '--expect-tip 必须是 64 位小写十六进制')
if (args['expect-tip'] && !args.industry) die('USAGE', '--expect-tip 只对单个行业有意义，请同时给 --industry')

if ((args['archive-dir'] || args['strict-anchors']) && !args['against-backup']) die('USAGE', '--archive-dir / --strict-anchors 只与 --against-backup 一起使用')

const { verifyChain, chainColumnsPresent } = await import('../server/lib/audit-chain-verify.js')
const { loadBackupManifest, compareLiveToBackup } = await import('../server/lib/audit-anchor-manifest.js')
const { loadBackupKey } = await import('../server/lib/backup-crypto.js')

// 备份清单先读（它决定行业）；清单读不出来 / 与备份对不上就是失败，不是通过
let backupCheck = null
if (args['against-backup']) {
  let key = null
  try { key = loadBackupKey() } catch (e) { die(e.code || 'USAGE', e.message) }
  const loaded = loadBackupManifest(path.resolve(args['against-backup']), key)
  if (!loaded.ok) {
    if (args.json) console.log(JSON.stringify({ ok: false, against_backup: { status: loaded.status, message: loaded.message } }, null, 2))
    else console.log(`${loaded.status.toUpperCase()} ${args['against-backup']}: ${loaded.message}`)
    process.exit(1)
  }
  const ind = loaded.manifest.industry
  if (args.industry && args.industry !== ind) die('USAGE', `--industry ${args.industry} 与清单行业 ${ind} 不一致`)
  args.industry = ind
  backupCheck = loaded
}

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
    let against = null
    if (backupCheck && r.ok) {
      against = { ...compareLiveToBackup(db, backupCheck.manifest, { archiveDir: args['archive-dir'] ? path.resolve(args['archive-dir']) : null }), manifest_source: backupCheck.source, notes: backupCheck.notes }
      if (against.status !== 'ok') report.ok = false
      else if (args['strict-anchors'] && (against.anchors_added?.length || against.anchors_removed?.length)) { against.status = 'anchors-changed'; report.ok = false }
    }
    report.industries[code] = { status: r.ok ? 'ok' : 'broken', rows: r.rows, first_id: r.firstId, last_id: r.lastId, tip_hash: r.tipHash, anchors_used: r.anchorsUsed, ...(r.brk ? { break: r.brk } : {}), ...(against ? { against_backup: against } : {}) }
  } finally {
    db.close()
  }
}

if (backupCheck && !Object.values(report.industries).some((r) => r.against_backup)) report.ok = false // 没能比对（库缺失 / 未迁移 / 链已断）不算通过

if (args.json) console.log(JSON.stringify(report, null, 2))
else {
  for (const [code, r] of Object.entries(report.industries)) {
    if (r.status === 'ok') console.log(`OK    ${code}: ${r.rows} 行，id ${r.first_id ?? '-'}..${r.last_id ?? '-'}，锚点 ${r.anchors_used}，tip=${r.tip_hash ?? '(空表)'}`)
    if (r.against_backup) {
      const a = r.against_backup
      console.log(`${a.status === 'ok' ? 'OK   ' : 'FAIL '} ${code} 对比备份 tip（id=${a.backup_tip_id}）：${a.status}${a.kind ? `/${a.kind}` : ''}${a.message ? ' — ' + a.message : ''}${a.advanced_rows !== undefined ? `；此后前进 ${a.advanced_rows} 行` : ''}`)
      if (a.anchors_added?.length) console.log(`      备份之后新增锚点 ${a.anchors_added.length} 条（保留清理 / 隐私抹除 / 归档会产生；请对照操作记录）：${a.anchors_added.map((x) => `${x.kind}@${x.at_row_id}`).join(', ')}`)
      for (const n of a.notes || []) console.log(`      注：${n}`)
    }
    if (r.status === 'ok') continue
    if (r.status === 'broken') console.log(`BREAK ${code}: 第一个断点 id=${r.break.id} 类型=${r.break.kind}（期望 ${r.break.expected}，实得 ${r.break.actual}）；此前 ${r.rows} 行正常`)
    else console.log(`${r.status.toUpperCase()} ${code}${r.message ? ': ' + r.message : ''}`)
  }
}
process.exit(report.ok ? 0 : 1)
