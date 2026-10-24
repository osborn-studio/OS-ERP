#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/offbox-anchor.mjs ｜ 离机锚点：把透明日志尾与各库审计链尾签名后写到另一台机器（ADR-0055）
 * ============================================================================
 * 【职责】生成签名的 `anchor-<stamp>.json`（格式见 scripts/lib/offbox-anchor.mjs）并写入目的地。目的地只能是
 *   · 本机已存在的绝对目录（不创建；不许在数据目录之内——那不叫离机），或
 *   · `ssh://<别名>/<绝对路径>`：别名必须是 ~/.ssh/config 里**已有**的别名，只经 `ssh`/`scp` 的 BatchMode 非交互调用；
 *     从不改 SSH 配置或认证，不传 -F / -i / ProxyCommand 之类选项。别名与路径按严格白名单校验后才会 spawn 任何进程，
 *     且全程以参数数组调用（无 shell）；远端命令里的路径只含 [A-Za-z0-9._/-]，另加单引号。
 *   写入是"一次写入"：先写临时名，再以不覆盖语义改名（本地 link/rename、远端 `test ! -e … && mv`），随后读回比对。
 * 【用法】node scripts/offbox-anchor.mjs --data-dir <绝对路径> --dest <绝对目录 | ssh://别名/绝对路径> --key <私钥PEM> [--log <EVIDENCE-LOG.jsonl>]
 *   · `--key`：Ed25519 私钥 PEM（同 release-keygen；仓库外、权限 0600）。
 *   · `--log`：缺省为仓库内 docs/release/EVIDENCE-LOG.jsonl；该文件不存在则锚点记 log.present=false。显式给出但无效 ⇒ 失败。
 *   · 审计链：对每个存在的行业库只读取 verifyChain；链已断 ⇒ 拒绝出锚点（不给坏链背书）。
 *   · 测试接缝：OS_ERP_SSH / OS_ERP_SCP 指向替身；只设 OS_ERP_SSH 而不设 OS_ERP_SCP ⇒ 拒绝（不让真 scp 经替身 ssh 出网）。
 *   退出码：0 成功；1 拒绝（链/日志无效、写入失败）；2 用法错误。
 * 【验证】audit-verify-chain --offbox <文件> --pubkey <公钥>；verify-release --log --offbox <文件> --pubkey <公钥>。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { parseArgs, locateDatabases, die } from './lib/audit-chain-cli.mjs'
import { loadSigningKey } from './lib/evidence-sign.mjs'
import { LOG_FILE } from './lib/evidence-log.mjs'
import { buildSignedAnchor, stampFor, summarizeLog } from './lib/offbox-anchor.mjs'
import { isWithin, resolveThroughSymlinks } from './lib/safe-path.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2), { values: ['--data-dir', '--dest', '--key', '--log'], flags: [] })
for (const need of ['data-dir', 'dest', 'key']) if (!args[need]) die('USAGE', '用法：offbox-anchor.mjs --data-dir <绝对路径> --dest <绝对目录|ssh://别名/绝对路径> --key <私钥PEM> [--log <EVIDENCE-LOG.jsonl>]')

// ---- 目的地解析（先校验，后动作）----
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
const RPATH = /^\/(?:[A-Za-z0-9._][A-Za-z0-9._-]*\/)*[A-Za-z0-9._][A-Za-z0-9._-]*$/ // 绝对、无空段、无前导 '-'、字符白名单
function parseDest(dest) {
  if (dest.startsWith('ssh://')) {
    const rest = dest.slice(6)
    const slash = rest.indexOf('/')
    if (slash < 1) die('USAGE', '--dest ssh://<别名>/<绝对路径>：缺少别名或路径')
    const alias = rest.slice(0, slash)
    const rpath = rest.slice(slash)
    if (!ALIAS.test(alias)) die('USAGE', `--dest 的 ssh 别名只允许字母数字及 . _ -，且不得以 - 开头（不接受 user@host、端口、选项）：${JSON.stringify(alias)}`)
    if (!RPATH.test(rpath) || rpath.split('/').some((s) => s === '.' || s === '..' || s.startsWith('-'))) die('USAGE', `--dest 的远端路径必须是绝对路径，只含 [A-Za-z0-9._/-]，不含 .. 或以 - 开头的段：${JSON.stringify(rpath)}`)
    return { kind: 'ssh', alias, rpath }
  }
  if (dest.includes('://') || /^[^/]*:/.test(dest)) die('USAGE', '--dest 只接受绝对本地目录或 ssh://<别名>/<绝对路径>')
  if (!path.isAbsolute(dest)) die('USAGE', '--dest 本地目录必须是绝对路径')
  return { kind: 'local', dir: dest }
}
const target = parseDest(args.dest)
const SSH = process.env.OS_ERP_SSH || 'ssh'
const SCP = process.env.OS_ERP_SCP || 'scp'
if (target.kind === 'ssh' && process.env.OS_ERP_SSH && !process.env.OS_ERP_SCP) die('USAGE', '设置了 OS_ERP_SSH 就必须同时设置 OS_ERP_SCP（测试替身必须成对，避免真 scp 出网）')

// ---- 密钥与日志 ----
let key
try { key = loadSigningKey(args.key) } catch (e) { die('USAGE', e.message) }
const logFile = args.log ? path.resolve(args.log) : path.join(ROOT, LOG_FILE)
let log = { present: false }
if (fs.existsSync(logFile)) {
  try { log = summarizeLog(fs.readFileSync(logFile, 'utf8')) } catch (e) { die('LOG', `透明日志 ${logFile} 无效，拒绝出锚点：${e.message}`, 1) }
} else if (args.log) die('LOG', `--log ${logFile} 不存在`, 1)

// ---- 审计链 ----
const { targets, absent } = await locateDatabases({ 'data-dir': args['data-dir'] })
if (target.kind === 'local') {
  let dirReal
  try { dirReal = resolveThroughSymlinks(target.dir); if (!fs.statSync(dirReal).isDirectory()) throw new Error('not a directory') } catch { die('USAGE', `--dest ${target.dir} 不是已存在的目录（不会创建；盘未挂载时静默落到本机盘正是离机的反面）`) }
  if (isWithin(resolveThroughSymlinks(args['data-dir']), dirReal)) die('USAGE', '--dest 不能在数据目录之内：这不是离机副本')
}
const { summarizeAuditChain } = await import('../server/lib/audit-anchor-manifest.js')
const audit = {}
for (const code of absent) audit[code] = { status: 'absent' }
for (const { code, file } of targets) {
  const db = new Database(file, { readonly: true })
  try {
    const s = summarizeAuditChain(db)
    if (!s.present) audit[code] = { status: 'not-migrated' }
    else if (!s.verified) die('CHAIN', `${code} 审计链已断（id=${s.break?.id} ${s.break?.kind}），拒绝出锚点；先处理断点`, 1)
    else audit[code] = { status: 'chain', rows: s.rows, first_id: s.first_id, last_id: s.last_id, tip_hash: s.tip_hash, anchors_count: s.anchors_count, anchors_digest: s.anchors_digest, anchors: s.anchors }
  } finally { db.close() }
}

const now = new Date()
const text = buildSignedAnchor({ createdAt: now.toISOString(), log, audit }, key)
const name = `anchor-${stampFor(now)}.json`

// ---- 写出 ----
if (target.kind === 'local') {
  const tmp = path.join(target.dir, `.${name}.${randomBytes(4).toString('hex')}.tmp`)
  const final = path.join(target.dir, name)
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o644 })
    try { fs.linkSync(tmp, final) } catch (e) { // 目标已存在则 EEXIST：永不覆盖
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK'].includes(e.code)) throw e
      fs.writeFileSync(final, text, { flag: 'wx', mode: 0o644 }) // 文件系统不支持硬链接（如 exFAT）：独占创建，仍不覆盖
    }
  } catch (e) { die('WRITE', `写入 ${final} 失败（${e.code || e.message}）`, 1) } finally { fs.rmSync(tmp, { force: true }) }
  if (fs.readFileSync(final, 'utf8') !== text) die('WRITE', `读回 ${final} 与写入内容不一致`, 1)
  console.log(`ANCHOR ${final}`)
} else {
  const { alias, rpath } = target
  const ssh = (cmd) => spawnSync(SSH, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', alias, cmd], { encoding: 'utf8', timeout: 60000 })
  const remoteTmp = `${rpath}/.${name}.${randomBytes(4).toString('hex')}.tmp`
  const remoteFinal = `${rpath}/${name}`
  const q = (p) => `'${p}'` // p 已被白名单限制，不含引号
  const cleanup = () => ssh(`rm -f -- ${q(remoteTmp)}`)
  let r = ssh(`test -d ${q(rpath)}`)
  if (r.status !== 0) die('WRITE', `远端目录 ${alias}:${rpath} 不可用（别名未配置 / 无法非交互连接 / 目录不存在）：${(r.stderr || '').trim().slice(0, 200)}`, 1)
  const local = path.join(os.tmpdir(), `.os-erp-anchor-${randomBytes(6).toString('hex')}.json`)
  try {
    fs.writeFileSync(local, text, { flag: 'wx', mode: 0o600 })
    r = spawnSync(SCP, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', local, `${alias}:${remoteTmp}`], { encoding: 'utf8', timeout: 120000 })
  } finally { fs.rmSync(local, { force: true }) }
  if (r.status !== 0) { cleanup(); die('WRITE', `scp 失败：${(r.stderr || '').trim().slice(0, 200)}`, 1) }
  r = ssh(`test ! -e ${q(remoteFinal)} && mv -- ${q(remoteTmp)} ${q(remoteFinal)}`)
  if (r.status !== 0) { cleanup(); die('WRITE', `远端改名失败（同名锚点已存在则不覆盖）：${(r.stderr || '').trim().slice(0, 200)}`, 1) }
  r = ssh(`cat -- ${q(remoteFinal)}`)
  if (r.status !== 0 || r.stdout !== text) die('WRITE', `读回 ${alias}:${remoteFinal} 与写入内容不一致`, 1)
  console.log(`ANCHOR ssh://${alias}${remoteFinal}`)
}
console.log(`  log: ${log.present ? `${log.lines} 行 tail=${log.tail_hash}` : '(无日志)'}`)
for (const [code, e] of Object.entries(audit)) console.log(`  ${code}: ${e.status === 'chain' ? `${e.rows} 行 tip=${e.tip_hash ?? '(空表)'}` : e.status}`)
