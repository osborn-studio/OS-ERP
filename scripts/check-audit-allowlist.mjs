#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-audit-allowlist.mjs ｜ CI 依赖审计门禁：运行依赖的高危公告必须在带到期日的白名单里（AC10）
 * ============================================================================
 * 【做什么】运行 `npm audit --omit=dev --audit-level=high --json`（显式指定 npmjs 官方 registry，
 *   因为仓库 .npmrc 指向的镜像不实现审计接口），逐条检查 high/critical 公告：每条必须在
 *   `docs/security/audit-allowlist.json` 里有条目，条目含 `advisory`（GHSA 编号）、`reason`、
 *   `expires`（YYYY-MM-DD，必须晚于今天且不超过 180 天）。否则退出码 1。
 * 【失败即关闭】审计接口报错、输出不是预期结构、白名单格式不合法、条目过期、重复，一律失败；
 *   不会因为"查不到"而放行。白名单里已不再出现的公告只提示（不失败），提醒删除。
 * 【开发依赖模式（AE7）】`--include-dev`：运行 `npm audit --audit-level=critical --json`（含开发依赖），门槛只取 critical，
 *   只对照白名单文件里独立的 `dev` 段（条目格式、180 天上限相同）。两段互不通用：`allow` 段的条目不能豁免开发模式，
 *   `dev` 段的条目也不能豁免运行模式（运行模式不读 dev 段内容，只要求它若存在必须是数组）。
 * 【不做什么】默认模式不检查开发依赖；不修复漏洞；白名单是限期豁免，不是"已解决"。
 * 【用法】node scripts/check-audit-allowlist.mjs [--include-dev] [--allowlist <file>] [--audit-json <file>] [--summary <file>]
 *   --audit-json 读取已有审计输出（测试/离线复核用），不联网。
 *   --summary 把判定结果（模式、门槛、发现、豁免、失败）写成 JSON，成败都写（CI 复查 job 用）。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_ALLOWLIST = path.join(ROOT, 'docs', 'security', 'audit-allowlist.json')
const GATED_RUNTIME = new Set(['high', 'critical'])
const GATED_DEV = new Set(['critical'])
const MAX_DAYS = 180
const GHSA_RE = /^GHSA(-[2-9cfghjmpqrvwx]{4}){3}$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86400000

function parseDay(s) {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null
  if (!m) return null
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3])
  const d = new Date(t)
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null
  return t
}

function todayUtc(now) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

/** Pure: validate allowlist entries. Returns { entries: Map(advisory -> entry), errors: [] } */
export function validateAllowlist(doc, now = new Date(), section = 'allow') {
  const errors = []
  const entries = new Map()
  const isObj = doc && typeof doc === 'object' && !Array.isArray(doc)
  const list = isObj ? doc[section] : null
  if (!Array.isArray(list)) return { entries, errors: [`allowlist must be an object with an "${section}" array`] }
  // The other section is never used for coverage, but a present-yet-malformed one is a configuration error.
  const other = section === 'allow' ? 'dev' : 'allow'
  if (doc[other] !== undefined && !Array.isArray(doc[other])) errors.push(`"${other}" must be an array when present`)
  const today = todayUtc(now)
  list.forEach((e, i) => {
    const tag = `${section}[${i}]`
    if (!e || typeof e !== 'object' || Array.isArray(e)) { errors.push(`${tag}: not an object`); return }
    if (typeof e.advisory !== 'string' || !GHSA_RE.test(e.advisory)) { errors.push(`${tag}: advisory must be a GHSA id`); return }
    if (typeof e.reason !== 'string' || e.reason.trim().length < 20) errors.push(`${tag} ${e.advisory}: reason must be at least 20 characters`)
    const exp = parseDay(e.expires)
    if (exp === null) errors.push(`${tag} ${e.advisory}: expires must be a real YYYY-MM-DD date`)
    else if (exp <= today) errors.push(`${tag} ${e.advisory}: expired on ${e.expires} (must be after today)`)
    else if (exp - today > MAX_DAYS * DAY_MS) errors.push(`${tag} ${e.advisory}: expires more than ${MAX_DAYS} days ahead`)
    if (entries.has(e.advisory)) errors.push(`${tag} ${e.advisory}: duplicate entry`)
    entries.set(e.advisory, e)
  })
  return { entries, errors }
}

/** Pure: extract gated advisories from `npm audit --json` output. Throws on unexpected shape. */
export function gatedFindings(audit, GATED = GATED_RUNTIME) {
  if (!audit || typeof audit !== 'object' || audit.error) throw new Error('audit output is an error or not an object')
  const vulns = audit.vulnerabilities
  if (audit.auditReportVersion !== 2 || !vulns || typeof vulns !== 'object' || Array.isArray(vulns)) {
    throw new Error('audit output has no auditReportVersion 2 vulnerabilities map')
  }
  const SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical'])
  for (const [name, v] of Object.entries(vulns)) {
    if (!v || typeof v !== 'object' || !SEVERITIES.has(v.severity) || !Array.isArray(v.via)) {
      throw new Error(`vulnerability "${name}" has an unexpected shape`)
    }
  }
  const found = new Map() // advisory id (or "unidentified:<pkg>") -> { package, severity }
  // Every advisory object anywhere in the report is gated by its own severity; a gated package entry must
  // additionally be backed by at least one identified advisory, reached through its via chain (cycles do not count).
  for (const [name, v] of Object.entries(vulns)) {
    for (const x of v.via) {
      if (x && typeof x === 'object' && GATED.has(x.severity)) {
        const m = typeof x.url === 'string' ? /GHSA(-[a-z0-9]{4}){3}/.exec(x.url) : null
        found.set(m ? m[0] : `unidentified:${name}`, { package: x.name || name, severity: x.severity })
      }
    }
  }
  const backed = (name, seen) => {
    if (seen.has(name)) return false
    seen.add(name)
    const v = vulns[name]
    if (!v) return false
    return v.via.some((x) => (x && typeof x === 'object' ? GATED.has(x.severity) : typeof x === 'string' && backed(x, seen)))
  }
  for (const [name, v] of Object.entries(vulns)) {
    if (GATED.has(v.severity) && !backed(name, new Set())) found.set(`unidentified:${name}`, { package: name, severity: v.severity })
  }
  return found
}

/** Pure: compare findings with allowlist. */
export function evaluate(audit, allowDoc, now = new Date(), { includeDev = false } = {}) {
  const section = includeDev ? 'dev' : 'allow'
  const gate = includeDev ? GATED_DEV : GATED_RUNTIME
  const { entries, errors } = validateAllowlist(allowDoc, now, section)
  const failures = [...errors]
  const unused = []
  let found
  try { found = gatedFindings(audit, gate) } catch (e) { return { ok: false, failures: [...failures, `audit unusable: ${e.message}`], unused, covered: [] } }
  const covered = []
  for (const [id, f] of found) {
    const e = entries.get(id)
    if (!e) { failures.push(`${id} (${f.package}, ${f.severity}) is not in the allowlist`); continue }
    if (e.package && e.package !== f.package) { failures.push(`${id}: allowlist package "${e.package}" does not match "${f.package}"`); continue }
    covered.push(id)
  }
  for (const id of entries.keys()) if (!found.has(id)) unused.push(id)
  return { ok: failures.length === 0, failures, unused, covered }
}

function runAudit(includeDev) {
  const scope = includeDev ? ['--audit-level=critical'] : ['--omit=dev', '--audit-level=high']
  const r = spawnSync('npm', ['audit', ...scope, '--json', '--registry=https://registry.npmjs.org'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (r.error) throw r.error
  return JSON.parse(r.stdout)
}

function main() {
  const args = process.argv.slice(2)
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
  const includeDev = args.includes('--include-dev')
  const mode = includeDev ? 'dev' : 'runtime'
  const summaryFile = opt('--summary')
  const writeSummary = (obj) => {
    if (!summaryFile) return
    try { fs.writeFileSync(summaryFile, JSON.stringify({ mode, threshold: includeDev ? 'critical' : 'high', ...obj }, null, 2) + '\n') } catch (e) { console.error(`audit-allowlist: cannot write summary: ${e.message}`); process.exit(1) }
  }
  const die = (msg) => { console.error(msg); writeSummary({ ok: false, failures: [msg], covered: [], unused: [] }); process.exit(1) }
  let audit
  let allow
  try {
    allow = JSON.parse(fs.readFileSync(opt('--allowlist') || DEFAULT_ALLOWLIST, 'utf8'))
  } catch (e) { die(`audit-allowlist: cannot read allowlist: ${e.message}`) }
  try {
    audit = opt('--audit-json') ? JSON.parse(fs.readFileSync(opt('--audit-json'), 'utf8')) : runAudit(includeDev)
  } catch (e) { die(`audit-allowlist: cannot obtain audit output: ${e.message}`) }
  const res = evaluate(audit, allow, new Date(), { includeDev })
  const section = includeDev ? 'dev' : 'allow'
  const expiry = (id) => ((allow[section] || []).find((e) => e.advisory === id) || {}).expires
  for (const id of res.covered) console.log(`allowlisted: ${id} (until ${expiry(id)})`)
  for (const id of res.unused) console.log(`note: allowlist entry ${id} no longer appears in the audit; remove it`)
  writeSummary({ ok: res.ok, failures: res.failures, covered: res.covered.map((id) => ({ advisory: id, expires: expiry(id) })), unused: res.unused })
  if (!res.ok) {
    for (const f of res.failures) console.error(`FAIL: ${f}`)
    process.exit(1)
  }
  console.log(`audit-allowlist (${mode}): OK (${res.covered.length} allowlisted ${includeDev ? 'critical' : 'high/critical'} finding(s), none unlisted)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
