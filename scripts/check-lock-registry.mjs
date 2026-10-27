#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-lock-registry.mjs ｜ 锁文件 registry 守卫：每个 resolved 的主机必须在白名单里（AG7）
 * ============================================================================
 * 【做什么】读取 package-lock.json，按 `resolved` 的主机统计包数并打印；任何主机不在白名单内则退出码 1。
 *   默认白名单只有 `registry.npmjs.org`（`npm audit signatures` 只能核验官方 registry 的包）。
 * 【失败即关闭】`resolved` 不是 https、带用户信息、主机不在白名单、缺 `integrity`、锁文件无法解析或没有任何
 *   `resolved` 条目，一律失败。`link` 与根包条目没有 `resolved`，单独计数、不算违规。
 * 【用法】node scripts/check-lock-registry.mjs [--lock <file>] [--allow <host>]... [--summary <file>]
 *   `--allow` 只用于本地镜像（可重复）；主机必须是不含通配符、路径、协议的纯主机名（可带端口）。
 *   CI 不应传 `--allow`。`--summary` 把统计写成 JSON（成败都写）。
 * 【不做什么】不联网、不校验 integrity 值本身（npm ci 会校验），不检查 package.json 的依赖声明。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_ALLOWED = ['registry.npmjs.org']
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/

/** Pure: validate an --allow host value. Returns normalized host or throws. */
export function normalizeAllowHost(h) {
  const v = String(h ?? '').trim().toLowerCase()
  if (!HOST_RE.test(v)) throw new Error(`invalid --allow host: ${JSON.stringify(h)} (plain hostname[:port] only)`)
  return v
}

/** Pure: analyse a parsed lockfile. Returns { hosts: {host: count}, noResolved, total, violations: [] }. */
export function analyseLock(lock, allowed = DEFAULT_ALLOWED) {
  const violations = []
  const hosts = {}
  let noResolved = 0
  let total = 0
  const pk = lock && typeof lock === 'object' ? lock.packages : null
  if (!pk || typeof pk !== 'object' || Array.isArray(pk)) return { hosts, noResolved, total, violations: ['lockfile has no "packages" map (lockfileVersion 2/3 required)'] }
  const ok = new Set(allowed.map((h) => h.toLowerCase()))
  for (const [key, e] of Object.entries(pk)) {
    if (key === '') continue
    if (!e || typeof e !== 'object') { violations.push(`${key}: entry is not an object`); continue }
    if (e.link === true || e.resolved === undefined) {
      if (e.link === true) {
        noResolved++
        // a link must point at a local path, never a URL
        if (typeof e.resolved !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(e.resolved) || e.integrity !== undefined) violations.push(`${key}: link target must be a local path without integrity`)
        continue
      }
      noResolved++
      violations.push(`${key}: no "resolved" and not a link (cannot verify its registry)`)
      continue
    }
    total++
    let u = null
    try { u = new URL(String(e.resolved)) } catch { /* handled below */ }
    if (!u) { violations.push(`${key}: resolved is not a URL`); continue }
    if (u.protocol !== 'https:') { violations.push(`${key}: resolved uses ${u.protocol} (https required)`); continue }
    if (u.username || u.password) { violations.push(`${key}: resolved carries credentials`); continue }
    const host = u.host.toLowerCase()
    hosts[host] = (hosts[host] || 0) + 1
    if (!ok.has(host)) violations.push(`${key}: host ${host} not in allowlist`)
    if (typeof e.integrity !== 'string' || !/^sha(256|384|512)-/.test(e.integrity)) violations.push(`${key}: missing or malformed integrity`)
  }
  if (total === 0) violations.push('lockfile has no resolved entries')
  return { hosts, noResolved, total, violations }
}

function parseArgs(argv) {
  const o = { lock: path.join(ROOT, 'package-lock.json'), allow: [...DEFAULT_ALLOWED], summary: null }
  const extra = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--lock') o.lock = path.resolve(argv[++i] ?? '')
    else if (a === '--allow') extra.push(normalizeAllowHost(argv[++i]))
    else if (a === '--summary') o.summary = path.resolve(argv[++i] ?? '')
    else throw new Error(`unknown argument: ${a}`)
  }
  o.allow.push(...extra)
  o.extra = extra
  return o
}

function main() {
  let o
  try { o = parseArgs(process.argv.slice(2)) } catch (e) { console.error(`check-lock-registry: ${e.message}`); process.exit(2) }
  let res
  try {
    res = analyseLock(JSON.parse(fs.readFileSync(o.lock, 'utf8')), o.allow)
  } catch (e) {
    res = { hosts: {}, noResolved: 0, total: 0, violations: [`cannot read lockfile ${o.lock}: ${e.message}`] }
  }
  console.log(`lockfile resolved entries by registry host (${res.total} total, ${res.noResolved} without resolved: link/none):`)
  for (const [h, n] of Object.entries(res.hosts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${h}${o.allow.includes(h) ? '' : '  <-- NOT ALLOWED'}`)
  if (o.extra.length) console.log(`extra allowed hosts (local override): ${o.extra.join(', ')}`)
  const pass = res.violations.length === 0
  if (o.summary) fs.writeFileSync(o.summary, JSON.stringify({ allowed: o.allow, ...res, pass }, null, 2) + '\n')
  if (!pass) {
    const shown = res.violations.slice(0, 20)
    for (const v of shown) console.error(`FAIL ${v}`)
    if (res.violations.length > shown.length) console.error(`... and ${res.violations.length - shown.length} more`)
    process.exit(1)
  }
  console.log('OK: every resolved entry is on an allowed registry host')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
