/**
 * ============================================================================
 * 文件标识：scripts/retention.mjs ｜ 日志保留清理：按设置清理过期的审计 / 通知 / MCP 日志，默认只演练，执行时同事务写一条审计摘要
 * ============================================================================
 * 【职责】按 `retention_audit_days` / `retention_notify_log_days` / `retention_mcp_log_days`（默认 365/90/90，危险键，
 *   见 server/lib/settings.js）清理 `audit_logs` / `notify_logs` / `mcp_call_logs`。ADR-0030。
 *
 * 【判据】
 *   · 默认 `--dry-run`：只读打开库，按行业打印将删除的行数，不改任何东西。`--execute` 才删。
 *   · 每个行业库**一个事务**：三类删除 + 一条 `RETENTION_PURGE` 严格审计（auditStrictRow）。审计写不进 ⇒ 整个事务回滚，什么都不删。
 *   · **只清理白名单模块**：audit_logs 里 module ∈ {master, notify} 的行才可能被删；
 *     其余模块（finance / settings / auth / approval / privacy / retention 以及 purchase / sales / pos / dealer / inventory …
 *     这些业务单据的写操作审计就是账务证据）、module 为空或未知的行、`FUNDS_` 开头的行，一律保留。
 *     mcp_call_logs 里 level='danger' 的行也保留。
 *   · 保留设置读出来不是整数或越界（见 SETTING_RULES 的 min/max）⇒ 该库 fail-closed，退出码 1，不删。
 *   · 必须显式 GML_DATA_DIR（ADR-0001 / ADR-0019），且不许是仓库 data/；不存在的行业库只报 absent，不创建。
 *
 * 【用法】node scripts/retention.mjs [行业] [--dry-run | --execute] [--json] [--actor <名字>]
 *   退出码：0 完成；1 任一库设置非法或事务失败；2 参数 / 环境错误。
 *
 * 【改它要注意什么】受保护集合改动属于政策变更，要同步 ADR-0030 与 tests/retention.test.mjs；
 *   `created_at` 存的是本地时间字符串，截止时间用 SQLite `datetime('now','localtime','-N days')` 保持同一口径。
 * ============================================================================
 */
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { INDUSTRIES, requireExplicitDataDir, dbPathFor } from '../server/db/index.js'
import { SETTING_RULES, settingRow, normalizeSettingValue, castSettingValue } from '../server/lib/settings.js'
import { auditStrictRow, deleteAuditRowsAnchored } from '../server/lib/audit-trail.js'

// 白名单而非黑名单：审计行里几乎每个业务模块的 CREATE/UPDATE/pay/approve/void 都是账务证据（purchase/sales/pos/dealer/
// inventory/…），逐个列"不许删"必然漏。所以只有**明确登记为无账务 / 无授权影响**的模块才可被清理；
// 新增或未知模块、module 为空的行一律保留。要扩大范围是政策变更（改本清单 + ADR-0030 + 测试）。
export const PURGEABLE_AUDIT_MODULES = ['master', 'notify']
const PLACEHOLDERS = PURGEABLE_AUDIT_MODULES.map(() => '?').join(',')
const AUDIT_ELIGIBLE = `created_at < datetime('now','localtime',?) AND module IN (${PLACEHOLDERS}) AND action NOT LIKE 'FUNDS\\_%' ESCAPE '\\'`
const NOTIFY_ELIGIBLE = `created_at < datetime('now','localtime',?)`
const MCP_ELIGIBLE = `created_at < datetime('now','localtime',?) AND COALESCE(level,'') <> 'danger'`

function usage(message) {
  console.error(message)
  process.exit(2)
}

const args = process.argv.slice(2)
let execute = false
let dry = false
let json = false
let actor = 'retention-script'
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--execute') execute = true
  else if (a === '--dry-run') dry = true
  else if (a === '--json') json = true
  else if (a === '--actor') { actor = args[++i]; if (!actor || actor.startsWith('--')) usage('--actor 需要一个名字') }
  else if (a.startsWith('--')) usage(`未知参数：${a}（可用：--dry-run、--execute、--json、--actor）`)
  else positional.push(a)
}
if (execute && dry) usage('--dry-run 与 --execute 互斥')
if (positional.length > 1) usage('最多指定一个行业')
if (positional[0] && !Object.hasOwn(INDUSTRIES, positional[0])) usage(`未知行业：${positional[0]}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
try {
  requireExplicitDataDir()
} catch (e) {
  usage(`${e.code || 'USAGE'}: ${e.message}`)
}

const codes = positional[0] ? [positional[0]] : Object.keys(INDUSTRIES)

// 不用 `readSetting`：它对库里的非法值静默回落默认值，而清理是破坏性操作，
// 配置坏了应当停手让人看，而不是悄悄换一个窗口去删。
function windowDays(db, key) {
  const def = SETTING_RULES[key]
  const row = settingRow(db, key)
  if (!row) return Number(def.default)
  try {
    const v = castSettingValue(def, normalizeSettingValue(def, row.value))
    if (Number.isInteger(v)) return v
  } catch { /* 落到下面统一报错 */ }
  throw new Error(`设置 ${key}=${JSON.stringify(row.value)} 不合法（整数，${def.min}–${def.max} 天）；拒绝清理`)
}

function countsFor(db, days) {
  const off = (d) => `-${d} days`
  return {
    audit_logs: db.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE ${AUDIT_ELIGIBLE}`).get(off(days.audit), ...PURGEABLE_AUDIT_MODULES).n,
    notify_logs: db.prepare(`SELECT COUNT(*) n FROM notify_logs WHERE ${NOTIFY_ELIGIBLE}`).get(off(days.notify)).n,
    mcp_call_logs: db.prepare(`SELECT COUNT(*) n FROM mcp_call_logs WHERE ${MCP_ELIGIBLE}`).get(off(days.mcp)).n
  }
}

const report = { mode: execute ? 'execute' : 'dry-run', industries: {} }
let failed = false

for (const code of codes) {
  const file = dbPathFor(code)
  if (!fs.existsSync(file)) {
    report.industries[code] = { status: 'absent' }
    continue
  }
  const db = new Database(file, execute ? {} : { readonly: true })
  try {
    const days = { audit: windowDays(db, 'retention_audit_days'), notify: windowDays(db, 'retention_notify_log_days'), mcp: windowDays(db, 'retention_mcp_log_days') }
    if (!execute) {
      report.industries[code] = { status: 'ok', days, counts: countsFor(db, days) }
      continue
    }
    db.pragma('busy_timeout = 5000')
    const counts = db.transaction(() => {
      const off = (d) => `-${d} days`
      const done = {
        audit_logs: deleteAuditRowsAnchored(db, AUDIT_ELIGIBLE, [off(days.audit), ...PURGEABLE_AUDIT_MODULES], { kind: 'retention', reason: 'retention-purge' }),
        notify_logs: db.prepare(`DELETE FROM notify_logs WHERE ${NOTIFY_ELIGIBLE}`).run(off(days.notify)).changes,
        mcp_call_logs: db.prepare(`DELETE FROM mcp_call_logs WHERE ${MCP_ELIGIBLE}`).run(off(days.mcp)).changes
      }
      auditStrictRow(db, {
        userName: actor, action: 'RETENTION_PURGE', module: 'retention', entity: 'logs', entityId: code,
        detail: { counts: done, days, purgeable_audit_modules: PURGEABLE_AUDIT_MODULES }
      })
      return done
    }).immediate()
    report.industries[code] = { status: 'ok', days, counts }
  } catch (e) {
    failed = true
    report.industries[code] = { status: 'failed', error: `${e.code || 'ERROR'}: ${e.message}` }
  } finally {
    db.close()
  }
}

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(execute ? '[执行] 已按保留设置清理' : '[演练] 仅统计，未删除（加 --execute 才执行）')
  for (const [code, r] of Object.entries(report.industries)) {
    if (r.status !== 'ok') { console.log(`  ${code}: ${r.status}${r.error ? ' — ' + r.error : ''}`); continue }
    console.log(`  ${code}: audit_logs(>${r.days.audit}d)=${r.counts.audit_logs}  notify_logs(>${r.days.notify}d)=${r.counts.notify_logs}  mcp_call_logs(>${r.days.mcp}d)=${r.counts.mcp_call_logs}`)
  }
}
if (failed) {
  for (const [code, r] of Object.entries(report.industries)) if (r.status === 'failed') console.error(`${code}: ${r.error}`)
  process.exit(1)
}
