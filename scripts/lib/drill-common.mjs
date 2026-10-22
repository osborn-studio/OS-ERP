/**
 * ============================================================================
 * 文件标识：scripts/lib/drill-common.mjs ｜ 恢复/升级演练的共用底座：备份集读取、sha256 核对、隔离目标目录、迁移子进程、生产服务拉起、探针
 * ============================================================================
 * 【职责】`db-restore-drill.mjs` 与 `upgrade-rollback-drill.mjs` 共用的**唯一实现**：
 *   · 读 `backup-report-<stamp>.json` 得到备份集（文件 + sha256）；
 *   · 目标目录必须是显式绝对路径、**空目录**、不是备份来源的 `data_dir`、不是调用方的 `GML_DATA_DIR`、
 *     不与备份目录互相包含 —— 演练永远在一个与线上无关的副本上做（ADR-0016）；
 *   · 复制前逐个核对 sha256，任一不符**一个字节都不复制**（`RESTORE_SHA256_MISMATCH`）；
 *   · 迁移与服务都走真实入口（`scripts/migrate.mjs`、`server/index.js`）的子进程，生产模式、随机 loopback 端口、
 *     随机 JWT 密钥——演练证明的是"这套备份 + 这份代码能起来"，不是演练脚本自己的内存逻辑；
 *   · 探针口径只有一份（`PROBES`）：SQL 侧直接读备份文件，HTTP 侧走已认证接口，两侧比对。
 *
 * 【为什么这样设计】备份脚本（ADR-0009）只做烟雾恢复；这里补的是 F12 开放项：从文件到"能登录、数对得上"
 *   的完整链路，并把 RTO（耗时）与 RPO（备份年龄）量出来写进报告。
 *
 * 【改它要注意什么】本模块**不得**导入 `server/db/index.js`（它在导入时读 `GML_DATA_DIR`，而演练进程的
 *   目标目录来自命令行参数）；行业表名直接在本文件维护（与 `INDUSTRIES` 的 `db` 字段一致，
 *   `tests/restore-drill.test.mjs` 会在真实备份上验证）。报告里不许出现密码 / 密钥 / 令牌。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** 行业码 → 线上库文件名。与 `server/db/index.js` 的 INDUSTRIES[*].db 一致（不能导入它，见文件头）。 */
export const INDUSTRY_DB = { cosmetic: 'gml_cosmetic.db', food: 'gml_food.db', apparel: 'gml_apparel.db' }

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_USAGE = 2

export class DrillError extends Error {
  constructor(code, message, exitCode = EXIT_FAILED) {
    super(`${code}: ${message}`)
    this.code = code
    this.exitCode = exitCode
  }
}

export const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

export function stampNow(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 解析 `--key=value` 参数；未知参数一律拒绝（与 db-backup.mjs 同一原则：拼错不能静默通过）。 */
export function parseArgs(argv, known) {
  const out = {}
  for (const a of argv) {
    if (!a.startsWith('--')) throw new DrillError('DRILL_USAGE', `不支持的位置参数：${a}`, EXIT_USAGE)
    const eq = a.indexOf('=')
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq)
    const value = eq === -1 ? true : a.slice(eq + 1)
    if (!known.includes(key)) throw new DrillError('DRILL_USAGE', `未知参数：--${key}（可用：${known.map((k) => `--${k}`).join('、')}）`, EXIT_USAGE)
    out[key] = value
  }
  return out
}

function requireAbsoluteDir(value, name) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) {
    throw new DrillError('DRILL_USAGE', `${name} 必须是显式绝对路径`, EXIT_USAGE)
  }
  return path.resolve(value)
}

const contains = (parent, child) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 读取备份集：目录里最新（或 `--stamp` 指定）的 backup-report，只取 status=ok 的库。
 * 返回 { dir, reportFile, report, stamp, entries:[{code, file, sha256, size}] }
 */
export function loadBackupSet(backupDirArg, stamp = null) {
  const dir = requireAbsoluteDir(backupDirArg, '--backup-dir')
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new DrillError('DRILL_BACKUP_DIR_MISSING', `备份目录不存在：${dir}`, EXIT_USAGE)
  const reports = fs.readdirSync(dir).filter((f) => /^backup-report-.*\.json$/.test(f)).sort()
  if (!reports.length) throw new DrillError('DRILL_BACKUP_REPORT_MISSING', `备份目录里没有 backup-report-*.json：${dir}`, EXIT_USAGE)
  const name = stamp ? `backup-report-${stamp}.json` : reports.at(-1)
  if (!reports.includes(name)) throw new DrillError('DRILL_BACKUP_REPORT_MISSING', `找不到备份报告 ${name}`, EXIT_USAGE)
  const reportFile = path.join(dir, name)
  let report
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
  } catch (e) {
    throw new DrillError('DRILL_BACKUP_REPORT_INVALID', `备份报告无法解析：${e.message}`, EXIT_USAGE)
  }
  const entries = (report.results || [])
    .filter((r) => r.status === 'ok' && r.file && r.sha256 && INDUSTRY_DB[r.code])
    .map((r) => ({ code: r.code, file: path.isAbsolute(r.file) ? r.file : path.join(dir, path.basename(r.file)), sha256: r.sha256, size: r.size ?? null }))
  if (!entries.length) throw new DrillError('DRILL_BACKUP_EMPTY', `备份报告 ${name} 中没有 status=ok 的库`, EXIT_USAGE)
  return { dir, reportFile, report, stamp: report.stamp || name.replace(/^backup-report-|\.json$/g, ''), entries }
}

/**
 * 目标目录判据（全部满足才允许动它）：绝对路径；不是备份来源的 data_dir；不是调用方环境的 GML_DATA_DIR；
 * 不与备份目录互相包含；要么不存在要么是空目录。
 */
export function prepareTargetDir(targetArg, { backupDir, sourceDataDir, env = process.env }) {
  const target = requireAbsoluteDir(targetArg, '--target-dir')
  const same = (a, b) => a && b && path.resolve(a) === target
  if (sourceDataDir && path.isAbsolute(sourceDataDir) && same(sourceDataDir, target)) {
    throw new DrillError('DRILL_TARGET_IS_LIVE', `目标目录就是备份来源的线上数据目录（${sourceDataDir}），演练只能在空副本上做`, EXIT_USAGE)
  }
  if (env.GML_DATA_DIR && path.isAbsolute(env.GML_DATA_DIR) && same(env.GML_DATA_DIR, target)) {
    throw new DrillError('DRILL_TARGET_IS_LIVE', `目标目录等于当前环境的 GML_DATA_DIR，拒绝在可能在用的实例目录上演练`, EXIT_USAGE)
  }
  if (contains(backupDir, target) || contains(target, backupDir)) {
    throw new DrillError('DRILL_TARGET_OVERLAPS_BACKUP', `目标目录与备份目录互相包含：${target} / ${backupDir}`, EXIT_USAGE)
  }
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) throw new DrillError('DRILL_TARGET_NOT_EMPTY', `目标不是目录：${target}`, EXIT_USAGE)
    if (fs.readdirSync(target).length) throw new DrillError('DRILL_TARGET_NOT_EMPTY', `目标目录非空：${target}（演练拒绝覆盖任何已有文件）`, EXIT_USAGE)
  } else {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  }
  return target
}

/**
 * 先核对全部 sha256，再复制。返回每库 { code, file, sha256_expected, sha256_actual, sha256_verified, restored_as }；
 * 任一不符抛 RESTORE_SHA256_MISMATCH 且**不复制任何文件**（调用方把 restored 列表写进报告）。
 */
export function verifyAndRestore(set, target) {
  const restored = set.entries.map((e) => {
    const exists = fs.existsSync(e.file)
    const actual = exists ? sha256File(e.file) : null
    return {
      code: e.code,
      file: e.file,
      size: exists ? fs.statSync(e.file).size : null,
      mtime: exists ? fs.statSync(e.file).mtime.toISOString() : null,
      sha256_expected: e.sha256,
      sha256_actual: actual,
      sha256_verified: exists && actual === e.sha256,
      restored_as: path.join(target, INDUSTRY_DB[e.code])
    }
  })
  const bad = restored.filter((r) => !r.sha256_verified)
  if (bad.length) {
    const err = new DrillError('RESTORE_SHA256_MISMATCH', `备份文件与报告 sha256 不符：${bad.map((b) => path.basename(b.file)).join('、')}`)
    err.restored = restored
    throw err
  }
  for (const r of restored) {
    fs.copyFileSync(r.file, r.restored_as, fs.constants.COPYFILE_EXCL)
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${r.restored_as}${suffix}`, { force: true })
    if (sha256File(r.restored_as) !== r.sha256_expected) throw new DrillError('RESTORE_COPY_CORRUPT', `复制后的 ${r.restored_as} 校验和不符`)
  }
  return restored
}

/** 只读打开一个库文件，读取 ADR-0001 的运行模式标记；缺失返回 null。 */
export function runtimeMarkerOf(file) {
  const db = new Database(file, { readonly: true })
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='os_egp_runtime'").get()
    return has ? db.prepare('SELECT mode FROM os_egp_runtime WHERE id=1').get()?.mode ?? null : null
  } finally {
    db.close()
  }
}

/** 子进程环境：显式生产模式、显式数据目录、绝不继承调用方的 GML_* 与密钥。 */
export function childEnv(target, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: target,
    TMPDIR: target,
    NODE_ENV: 'production',
    GML_RUNTIME_MODE: 'production',
    GML_DATA_DIR: target,
    GML_DB: '',
    ...extra
  }
}

/** 真实迁移入口（含 ADR-0009 校验和核对）。返回 { status, stdout, stderr, ms }。 */
export function migrateInProduction(target, codes) {
  const t0 = performance.now()
  const r = spawnSync(process.execPath, ['scripts/migrate.mjs', ...codes], { cwd: ROOT, env: childEnv(target), encoding: 'utf8', timeout: 300000 })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', ms: Math.round(performance.now() - t0) }
}

export async function freeLoopbackPort() {
  const listener = net.createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  return port
}

const money = (n) => Number((Number(n) || 0).toFixed(2))

/**
 * 探针口径的唯一出处：name → { sql(db) 从备份文件直接算, http(api) 从已认证接口取 }。
 * 两侧必须是同一个业务含义：计数走同一张表，余额走同一条公式（ar.js arOverview 的 open_amount）。
 */
export const PROBES = {
  users: {
    sql: (db) => db.prepare('SELECT COUNT(*) c FROM users').get().c,
    http: async (api) => (await api.get('/api/auth/users?pageSize=1')).data.total
  },
  products: {
    sql: (db) => db.prepare('SELECT COUNT(*) c FROM products').get().c,
    http: async (api) => (await api.get('/api/master/products?pageSize=1')).data.total
  },
  purchase_orders: {
    sql: (db) => db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c,
    http: async (api) => (await api.get('/api/purchase/orders?pageSize=1')).data.total
  },
  receipts: {
    sql: (db) => db.prepare('SELECT COUNT(*) c FROM receipts').get().c,
    http: async (api) => (await api.get('/api/ar/receipts?pageSize=1')).data.total
  },
  ar_open_balance: {
    sql: (db) => money(db.prepare("SELECT IFNULL(SUM(amount - allocated_amount),0) amt FROM ar_documents WHERE status IN ('open','partial')").get().amt),
    http: async (api) => money((await api.get('/api/ar/overview')).data.open_amount)
  }
}

/** 直接读备份文件（只读）算出全部探针的期望值。表缺失时记 null（旧备份可能没有该表）。 */
export function sqlProbes(file) {
  const db = new Database(file, { readonly: true })
  try {
    const out = {}
    for (const [name, probe] of Object.entries(PROBES)) {
      try {
        out[name] = probe.sql(db)
      } catch {
        out[name] = null
      }
    }
    return out
  } finally {
    db.close()
  }
}

/**
 * 以生产模式拉起真实服务（随机 loopback 端口、随机 JWT 密钥），等 /api/meta/health 返回 ok。
 * 返回 { port, baseUrl, readyMs, stop(), output() }。密钥只存在于子进程环境，不进报告。
 */
export async function startProductionServer(target, { timeoutMs = 60000 } = {}) {
  const port = await freeLoopbackPort()
  const baseUrl = `http://127.0.0.1:${port}`
  const t0 = performance.now()
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: childEnv(target, { HOST: '127.0.0.1', PORT: String(port), GML_JWT_SECRET: randomBytes(48).toString('hex') }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const closed = once(child, 'close')
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await Promise.race([closed, delay(10000)])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  const deadline = Date.now() + timeoutMs
  let health = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break
    try {
      const res = await fetch(`${baseUrl}/api/meta/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const body = await res.json()
        if (body?.data?.status === 'ok') { health = body.data; break }
      }
    } catch { /* 还没起来，继续等 */ }
    await delay(100)
  }
  if (!health) {
    await stop()
    throw Object.assign(new DrillError('DRILL_SERVER_NOT_READY', `生产服务在 ${timeoutMs}ms 内未通过健康检查`), { output: output.slice(-4000) })
  }
  return { port, baseUrl, readyMs: Math.round(performance.now() - t0), health, stop, output: () => output }
}

/** 登录并返回一个带令牌的最小 HTTP 客户端；令牌只在内存里，不返回给调用方记录。 */
export async function loginClient(baseUrl, { username, password, industry }) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, industry }),
    signal: AbortSignal.timeout(10000)
  })
  const body = await res.json().catch(() => null)
  if (res.status !== 200 || !body?.data?.token) {
    throw new DrillError('DRILL_LOGIN_FAILED', `演练账号登录失败（HTTP ${res.status}${body?.code ? `，${body.code}` : ''}）`)
  }
  const token = body.data.token
  return {
    user: { id: body.data.user?.id ?? null, username: body.data.user?.username ?? username, role: body.data.user?.role ?? null },
    async get(pathname) {
      const r = await fetch(`${baseUrl}${pathname}`, { headers: { Authorization: `Bearer ${token}`, 'x-industry': industry }, signal: AbortSignal.timeout(10000) })
      const b = await r.json().catch(() => null)
      if (r.status !== 200 || !b || b.success === false) throw new DrillError('DRILL_PROBE_HTTP_FAILED', `${pathname} → HTTP ${r.status}${b?.code ? `，${b.code}` : ''}`)
      return b
    }
  }
}

/** 通过已认证接口取全部探针的实际值。 */
export async function httpProbes(api) {
  const out = {}
  for (const [name, probe] of Object.entries(PROBES)) out[name] = await probe.http(api)
  return out
}

/** 演练管理员密码：满足 ADR-0003 的长度/字符种类规则，只在进程内存里存在。 */
export const drillPassword = () => randomBytes(27).toString('base64url')

/** 用现有 bootstrap-admin CLI 在**恢复副本**里建一个演练管理员（密码经 stdin，不进参数/环境/输出）。 */
export function bootstrapDrillAdmin(target, { industry, username, password }) {
  const r = spawnSync(process.execPath, [
    'scripts/bootstrap-admin.mjs', `--industry=${industry}`, '--company-code=DRILL', '--company-name=恢复演练副本', `--username=${username}`, '--name=恢复演练管理员'
  ], { cwd: ROOT, env: childEnv(target), input: password + '\n', encoding: 'utf8', timeout: 60000 })
  let parsed = null
  try { parsed = JSON.parse((r.status === 0 ? r.stdout : r.stderr).trim().split('\n').at(-1)) } catch { /* 非 JSON 输出按失败处理 */ }
  if (r.status !== 0 || !parsed?.success) {
    throw new DrillError('DRILL_BOOTSTRAP_FAILED', `在恢复副本中创建演练管理员失败（${parsed?.code || `exit ${r.status}`}）`)
  }
  return { username, userId: parsed.userId ?? parsed.user_id ?? null }
}

/** 从 stdin 读一行密码（非 TTY），与 bootstrap-admin 同样不接受参数/环境变量。 */
export async function readPasswordFromStdin() {
  if (process.stdin.isTTY) throw new DrillError('DRILL_USAGE', '演练账号密码必须经非交互 stdin 管道传入（见 ADR-0003）', EXIT_USAGE)
  const chunks = []
  let length = 0
  for await (const chunk of process.stdin) {
    length += chunk.length
    if (length > 1024) throw new DrillError('DRILL_USAGE', 'stdin 密码过长', EXIT_USAGE)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  for (const chunk of chunks) chunk.fill(0)
  if (!text) throw new DrillError('DRILL_USAGE', 'stdin 没有读到演练账号密码', EXIT_USAGE)
  return text
}

/** 报告落盘：目标目录内 `<name>-<stamp>.json`，由调用方保证内容不含秘密。 */
export function writeReport(target, name, report) {
  const file = path.join(target, `${name}-${report.stamp}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  return file
}

/** 备份年龄（RPO 指标）：以备份报告的 generated_at 为准；解析失败返回 null。 */
export function backupAgeSeconds(report, now = Date.now()) {
  const t = Date.parse(report?.generated_at || '')
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : null
}
