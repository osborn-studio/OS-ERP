#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-install-registry.mjs ｜ 安装结果与锁文件一致性守卫：node_modules/.package-lock.json 对 package-lock.json（AH7）
 * ============================================================================
 * 【做什么】逐包比较 npm 安装后写下的隐藏锁文件（node_modules/.package-lock.json）与仓库 package-lock.json：`version`、`resolved`、
 *   `integrity` 必须逐字相同；已安装但锁文件里没有的包、字段不同的包、缺失 / 无法解析的文件、没有任何可比条目，一律退出码 1。
 *   锁文件里有、node_modules 里没有的包只计数（可选依赖在别的平台上、`--omit=dev` 都会这样），不算失败。
 * 【它证明什么】node_modules 是按**这份锁文件**装出来的（没有被 `npm install` 偷偷重新解析、没有装进锁文件之外的包、没有残留旧锁文件下的
 *   旧树）。配合 check-lock-registry（锁文件只认 registry.npmjs.org），安装树所记录的来源就是官方 registry。
 * 【它不证明什么（重要）】隐藏锁文件记录的是锁文件里的 `resolved`，**不是**这次实际下载的主机：用 `npm ci --registry <镜像>` 安装时，
 *   npm 把 registry.npmjs.org 的 tarball 请求改发到镜像（默认 replace-registry-host=npmjs），但隐藏锁文件里仍写着 registry.npmjs.org
 *   （已用本地回环镜像实测）。所以本脚本**看不出**字节是从哪台主机下载的，也不检查 tarball 的 integrity 本身；integrity 由 `npm ci` 在
 *   下载时按**锁文件**校验（不符则 EINTEGRITY 失败，已实测），不是由本脚本校验。装完之后文件被人改动本脚本也发现不了。
 * 【用法】node scripts/check-install-registry.mjs [--lock <file>] [--installed <file>] [--summary <file>]
 * 【不做什么】不联网、不读 tarball、不执行任何包脚本。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIELDS = ['version', 'resolved', 'integrity']

const isMap = (x) => x && typeof x === 'object' && !Array.isArray(x)

/** Pure: compare a parsed hidden lockfile against a parsed package-lock. Returns { compared, notInstalled, violations: [] }. */
export function compareInstalled(lock, installed) {
  const violations = []
  const lp = isMap(lock) ? lock.packages : null
  const ip = isMap(installed) ? installed.packages : null
  if (!isMap(lp)) violations.push('package-lock.json has no "packages" map (lockfileVersion 2/3 required)')
  if (!isMap(ip)) violations.push('node_modules/.package-lock.json has no "packages" map (was it written by npm 7+?)')
  if (violations.length) return { compared: 0, notInstalled: 0, violations }
  let compared = 0
  for (const [key, ie] of Object.entries(ip)) {
    if (key === '') continue
    if (!isMap(ie)) { violations.push(`${key}: installed entry is not an object`); continue }
    const le = lp[key]
    if (!isMap(le)) { violations.push(`${key}: installed but not in package-lock.json`); continue }
    compared++
    if (ie.link === true || le.link === true) {
      if (ie.link !== le.link || ie.resolved !== le.resolved) violations.push(`${key}: link differs from the lockfile`)
      continue
    }
    for (const f of FIELDS) {
      if (ie[f] !== le[f]) violations.push(`${key}: ${f} differs (installed ${JSON.stringify(ie[f])}, lockfile ${JSON.stringify(le[f])})`)
    }
  }
  if (compared === 0) violations.push('no installed package entries to compare (empty or missing node_modules?)')
  let notInstalled = 0
  for (const key of Object.keys(lp)) if (key !== '' && !(key in ip)) notInstalled++
  return { compared, notInstalled, violations }
}

function parseArgs(argv) {
  const o = { lock: path.join(ROOT, 'package-lock.json'), installed: path.join(ROOT, 'node_modules', '.package-lock.json'), summary: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--lock') o.lock = path.resolve(argv[++i] ?? '')
    else if (a === '--installed') o.installed = path.resolve(argv[++i] ?? '')
    else if (a === '--summary') o.summary = path.resolve(argv[++i] ?? '')
    else throw new Error(`unknown argument: ${a}`)
  }
  return o
}

function main() {
  let o
  try { o = parseArgs(process.argv.slice(2)) } catch (e) { console.error(`check-install-registry: ${e.message}`); process.exit(2) }
  let res
  try {
    const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
    res = compareInstalled(read(o.lock), read(o.installed))
  } catch (e) {
    res = { compared: 0, notInstalled: 0, violations: [`cannot read lockfile or installed tree: ${e.message}`] }
  }
  const pass = res.violations.length === 0
  console.log(`installed tree vs lockfile: ${res.compared} package(s) compared, ${res.notInstalled} lockfile entr${res.notInstalled === 1 ? 'y' : 'ies'} not installed (optional / other platform / omitted)`)
  if (o.summary) fs.writeFileSync(o.summary, JSON.stringify({ ...res, pass }, null, 2) + '\n')
  if (!pass) {
    for (const v of res.violations.slice(0, 20)) console.error(`FAIL ${v}`)
    if (res.violations.length > 20) console.error(`... and ${res.violations.length - 20} more`)
    process.exit(1)
  }
  console.log('OK: node_modules was installed from this lockfile (resolved, integrity and version identical). This does not show which host served the downloads.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
