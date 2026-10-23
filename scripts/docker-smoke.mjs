#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/docker-smoke.mjs ｜ 运行镜像冒烟（ADR-0012 手工验证的可重复版本）
 * ============================================================================
 * 【做什么】
 *   对一个**已构建**的运行镜像执行 ADR-0012「验证」一节里的手工检查，并以退出码报告：
 *     (a) 不给 GML_JWT_SECRET            ⇒ 容器非零退出，日志含 JWT_SECRET_MISSING_IN_PRODUCTION
 *     (b) 给公开已知值                   ⇒ 同样拒绝启动
 *     (c) 给随机密钥 + 命名卷 /data + 只读根 + cap_drop ALL + no-new-privileges + 回环端口
 *         ⇒ /api/meta/health 200，version == package.json，build_sha == --expect-sha；
 *            /mcp 在 production 下 503；进程 uid 10001；写 /app 失败；/data 已落库文件。
 *   CI（.github/workflows/ci.yml 的 docker job）与维护者本机都跑同一份：
 *     node scripts/docker-smoke.mjs --image os-erp:ci --expect-sha $(git rev-parse HEAD)
 *
 * 【输出纪律】
 *   只打印本脚本自己的定格行（`ok:` / `FAIL:` / `smoke:`）；容器日志不原样回显，
 *   失败时只在诊断块里打印**经过脱敏**的尾部几行（32 位以上不透明串一律打码）。
 *   随机密钥只经 `docker run -e GML_JWT_SECRET`（不带值，从本进程环境继承）传入，
 *   **从不**出现在参数、日志或输出里；tests/docker-smoke-policy.test.mjs 静态守卫这一点。
 *
 * 【清理】
 *   容器名 / 卷名带随机后缀；无论成败，finally 里 `docker rm -f` + `docker volume rm -f`。
 *   端口从 127.0.0.1 随机空闲端口取；只发布到回环。
 *
 * 【不证明什么】
 *   通过只说明该镜像在本机 Docker（CI 为 linux/amd64，Mac mini 为 linux/arm64）上
 *   满足启动闸门与运行契约；不是生产部署验收，也不验证业务正确性（见 ADR-0012「边界」）。
 * ============================================================================
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 参数 ----------
const args = parseArgs(process.argv.slice(2))
if (args.help || !args.image) {
  console.log('usage: node scripts/docker-smoke.mjs --image <ref> [--expect-sha <hex>] [--expect-version <semver>] [--timeout-ms <n>]')
  process.exit(args.help ? 0 : 2)
}
const IMAGE = String(args.image)
const EXPECT_SHA = args['expect-sha'] ? String(args['expect-sha']).toLowerCase() : null
if (EXPECT_SHA !== null && !/^[0-9a-f]{7,64}$/.test(EXPECT_SHA)) {
  console.log('FAIL: --expect-sha must be 7-64 hex characters')
  process.exit(2)
}
const EXPECT_VERSION = args['expect-version']
  ? String(args['expect-version'])
  : JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const TIMEOUT_MS = Number(args['timeout-ms'] || 120000)
const PUBLIC_DEFAULT_VALUE = 'gml-demo-secret-change-me' // 公开已知值（仓库文档里就有），不是密钥
const EXPECTED_UID = '10001'

// ---------- 工具 ----------
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1)
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i]
    else out[a.slice(2)] = true
  }
  return out
}

/** 任何 32 位以上的不透明串（密钥、哈希、token）一律打码；另外显式抹掉本次随机密钥。 */
function redact(text, secret) {
  let s = String(text ?? '')
  if (secret) s = s.split(secret).join('[REDACTED]')
  return s.replace(/[A-Za-z0-9_.+/=-]{32,}/g, '[REDACTED]')
}

/** 运行 docker CLI（数组参数，不经 shell）。extraEnv 只用于把密钥交给 `-e NAME`（不带值）形式。 */
function docker(cmd, { timeout = TIMEOUT_MS, extraEnv = {} } = {}) {
  const r = spawnSync('docker', cmd, {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...extraEnv },
    maxBuffer: 16 * 1024 * 1024
  })
  return { status: r.status, signal: r.signal, error: r.error, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) })
  let body = null
  try { body = await res.json() } catch { body = null }
  return { status: res.status, body }
}

// ---------- 结果记录 ----------
let failures = 0
const diagnostics = []
function check(name, pass, detail) {
  if (pass) {
    console.log(`ok: ${name}`)
  } else {
    failures += 1
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
  }
  return pass
}

// ---------- 主流程 ----------
const suffix = randomBytes(4).toString('hex')
const names = {
  noSecret: `os-erp-smoke-nosecret-${suffix}`,
  publicSecret: `os-erp-smoke-public-${suffix}`,
  app: `os-erp-smoke-app-${suffix}`,
  volume: `os-erp-smoke-data-${suffix}`
}
/** 本次随机密钥；只在 (c) 里生成，诊断块据此做显式抹除。 */
let secret = null
const HARDENING = [
  '--read-only',
  '--tmpfs', '/tmp:size=64m,mode=1777',
  '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges'
]

async function main() {
  console.log(`smoke: image=${IMAGE} expect_version=${EXPECT_VERSION} expect_sha=${EXPECT_SHA ?? '(any valid)'}`)

  const inspect = docker(['image', 'inspect', '--format', '{{.Architecture}} {{.Config.User}}', IMAGE])
  if (!check('image exists locally', inspect.status === 0, 'docker image inspect failed')) return
  const [arch, user] = inspect.stdout.trim().split(/\s+/)
  console.log(`smoke: arch=${arch} config_user=${user}`)
  check('image Config.User is the service account (gml or 10001)', user === 'gml' || user === EXPECTED_UID, `got ${user}`)

  // (a) 无密钥 ⇒ 启动即退出
  {
    const r = docker(['run', '--name', names.noSecret, ...HARDENING, IMAGE])
    const logs = r.stdout + r.stderr
    check('(a) no GML_JWT_SECRET: container exits non-zero', r.status !== 0 && r.status !== null, `exit=${r.status} signal=${r.signal ?? ''}`)
    check('(a) no GML_JWT_SECRET: logs name JWT_SECRET_MISSING_IN_PRODUCTION', logs.includes('JWT_SECRET_MISSING_IN_PRODUCTION'))
    if (!logs.includes('JWT_SECRET_MISSING_IN_PRODUCTION')) diagnostics.push(['(a)', logs])
  }

  // (b) 公开已知值 ⇒ 同样拒绝
  {
    const r = docker(['run', '--name', names.publicSecret, ...HARDENING, '-e', `GML_JWT_SECRET=${PUBLIC_DEFAULT_VALUE}`, IMAGE])
    const logs = r.stdout + r.stderr
    check('(b) public default secret value: container exits non-zero', r.status !== 0 && r.status !== null, `exit=${r.status} signal=${r.signal ?? ''}`)
    check('(b) public default secret value: logs name JWT_SECRET_MISSING_IN_PRODUCTION', logs.includes('JWT_SECRET_MISSING_IN_PRODUCTION'))
    if (!logs.includes('JWT_SECRET_MISSING_IN_PRODUCTION')) diagnostics.push(['(b)', logs])
  }

  // (c) 随机密钥 + 加固运行
  secret = randomBytes(32).toString('hex')
  let port = null
  let started = null
  for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
    port = await freePort()
    const r = docker([
      'run', '-d', '--name', names.app, ...HARDENING,
      '-v', `${names.volume}:/data`,
      '-p', `127.0.0.1:${port}:3001`,
      '-e', 'GML_JWT_SECRET', // 值从本进程环境继承，不出现在参数里
      IMAGE
    ], { extraEnv: { GML_JWT_SECRET: secret } })
    if (r.status === 0) started = r
    else if (/port is already allocated|address already in use/i.test(r.stderr)) {
      docker(['rm', '-f', names.app])
      continue
    } else {
      diagnostics.push(['(c) docker run', r.stderr])
      break
    }
  }
  if (!check('(c) hardened container starts (read-only root, cap_drop ALL, no-new-privileges, named /data volume, loopback port)', Boolean(started))) return

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + TIMEOUT_MS
  let health = null
  let lastErr = ''
  while (Date.now() < deadline) {
    const running = docker(['inspect', '--format', '{{.State.Running}}', names.app]).stdout.trim()
    if (running !== 'true') { lastErr = 'container stopped'; break }
    try {
      health = await fetchJson(`${base}/api/meta/health`)
      if (health.status === 200) break
      lastErr = `status ${health.status}`
    } catch (e) {
      lastErr = e?.code || e?.name || 'fetch error'
    }
    await sleep(1000)
  }
  if (!check('(c) /api/meta/health returns 200', health?.status === 200, lastErr)) {
    diagnostics.push(['(c) container logs', docker(['logs', '--tail', '40', names.app]).stdout + docker(['logs', '--tail', '40', names.app]).stderr])
    return
  }
  const data = health.body?.data ?? {}
  check('(c) health.status is ok', data.status === 'ok', `got ${JSON.stringify(data.status)}`)
  check(`(c) health.version equals package.json (${EXPECT_VERSION})`, data.version === EXPECT_VERSION, `got ${JSON.stringify(data.version)}`)
  const sha = typeof data.build_sha === 'string' ? data.build_sha.toLowerCase() : data.build_sha
  if (EXPECT_SHA) check(`(c) health.build_sha equals expected commit (${EXPECT_SHA.slice(0, 12)}…)`, sha === EXPECT_SHA, `got ${JSON.stringify(sha)}`)
  else check('(c) health.build_sha is a 7-64 hex commit', typeof sha === 'string' && /^[0-9a-f]{7,64}$/.test(sha), `got ${JSON.stringify(sha)}`)

  // /mcp 在 production 下 503 FEATURE_DISABLED
  try {
    const mcp = await fetchJson(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    })
    check('(c) POST /mcp returns 503 in production', mcp.status === 503, `got ${mcp.status}`)
    check('(c) POST /mcp body code is FEATURE_DISABLED', mcp.body?.error === 'FEATURE_DISABLED' || mcp.body?.code === 'FEATURE_DISABLED' || JSON.stringify(mcp.body ?? {}).includes('FEATURE_DISABLED'))
  } catch (e) {
    check('(c) POST /mcp reachable', false, e?.code || e?.name)
  }

  // 进程身份与文件系统边界
  const uid = docker(['exec', names.app, 'id', '-u'])
  check(`(c) process runs as uid ${EXPECTED_UID}`, uid.status === 0 && uid.stdout.trim() === EXPECTED_UID, `got ${uid.stdout.trim() || uid.status}`)
  const pid1 = docker(['exec', names.app, 'sh', '-c', 'ps -o comm= -p 1 2>/dev/null || cat /proc/1/comm'])
  check('(c) PID 1 is tini', /tini/.test(pid1.stdout), `got ${pid1.stdout.trim()}`)
  const write = docker(['exec', names.app, 'sh', '-c', 'touch /app/.smoke-write-probe 2>&1'])
  check('(c) writing to /app fails (read-only root)', write.status !== 0 && /read-only/i.test(write.stdout + write.stderr), `exit=${write.status} ${redact(write.stdout.trim(), secret).slice(0, 120)}`)
  const dbs = docker(['exec', names.app, 'sh', '-c', 'ls /data/*.db 2>/dev/null | wc -l'])
  check('(c) /data (named volume) holds at least one SQLite database', dbs.status === 0 && Number(dbs.stdout.trim()) >= 1, `got ${dbs.stdout.trim()}`)

  // 容器日志里不得出现随机密钥（脱敏守卫的自证）
  const logs = docker(['logs', names.app])
  check('(c) container logs do not contain the secret', !(logs.stdout + logs.stderr).includes(secret))
}

function cleanup() {
  for (const name of [names.noSecret, names.publicSecret, names.app]) docker(['rm', '-f', name], { timeout: 30000 })
  docker(['volume', 'rm', '-f', names.volume], { timeout: 30000 })
}

try {
  await main()
} catch (e) {
  failures += 1
  console.log(`FAIL: unexpected error — ${redact(e?.code || e?.message || String(e), secret).slice(0, 200)}`)
} finally {
  cleanup()
}

if (diagnostics.length) {
  console.log('::group::smoke diagnostics (redacted tail)')
  for (const [label, text] of diagnostics) {
    const tail = redact(text, secret).split(/\r?\n/).filter(Boolean).slice(-40)
    console.log(`-- ${label}`)
    for (const line of tail) console.log(`   ${line.slice(0, 300)}`)
  }
  console.log('::endgroup::')
}

console.log(failures ? `smoke: FAILED (${failures} check(s))` : 'smoke: PASSED')
process.exit(failures ? 1 : 0)
