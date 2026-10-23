/**
 * ============================================================================
 * 文件标识：tests/local-instance.test.mjs ｜ 单企业单实例安装验收：两个实例目录互不串（F11，ADR-0019）
 * ============================================================================
 * 用真实子进程驱动 `scripts/local-manage.mjs`（setup / start / backup / doctor）与
 * `scripts/bootstrap-admin.mjs`，在**同一份代码副本**上开两个实例目录（`GML_LOCAL_INSTANCE`）：
 *   · 各自的 data/、.local/config.json（0600、密钥不同）、backups/；
 *   · 生产模式：无演示数据，只有各自 bootstrap 出来的那一个管理员；
 *   · 两个服务同时在不同回环端口上跑；A 的账号在 B 登录必须 401；
 *   · doctor 对各自实例报告健康。
 * 代码副本（server/ scripts/ package.json + node_modules 软链 + 占位 dist/index.html）在临时目录里：
 * 开发工作树没有 dist/，而 `setup` 以 `dist/index.html` 是否存在作为"已构建"的判据。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

async function freePort() {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}
function codeCopy(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-egp-local-code-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const name of ['server', 'scripts']) cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true })
  cpSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'))
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  mkdirSync(path.join(dir, 'dist'))
  writeFileSync(path.join(dir, 'dist', 'index.html'), '<!doctype html><title>stub</title>')
  return dir
}
// 调用方环境里故意放上不该被继承的 GML_*：实例必须只认自己的目录与密钥。
const baseEnv = (code, instance, port) => ({
  PATH: process.env.PATH, HOME: instance, TMPDIR: instance,
  GML_LOCAL_INSTANCE: instance, GML_LOCAL_PORT: String(port),
  GML_DATA_DIR: path.join(code, 'must-not-use'), GML_DB: path.join(code, 'must-not-use.db'), GML_JWT_SECRET: 'must-not-use'
})
function manage(code, inst, command, extra = {}) {
  return spawnSync(process.execPath, ['scripts/local-manage.mjs', command, '--no-browser'], {
    cwd: code, env: { ...baseEnv(code, inst.dir, inst.port), ...extra }, encoding: 'utf8', timeout: 120000
  })
}
function bootstrap(code, inst, username, password) {
  return spawnSync(process.execPath, ['scripts/bootstrap-admin.mjs', '--industry=cosmetic', `--company-code=${inst.company}`,
    `--company-name=${inst.company} Ltd`, `--username=${username}`, '--name=Owner'], {
    cwd: code, env: { PATH: process.env.PATH, HOME: inst.dir, TMPDIR: inst.dir, GML_RUNTIME_MODE: 'production', GML_DATA_DIR: path.join(inst.dir, 'data'), GML_DB: '' },
    input: password + '\n', encoding: 'utf8', timeout: 60000
  })
}
async function startServer(t, code, inst) {
  const child = spawn(process.execPath, ['scripts/local-manage.mjs', 'start', '--no-browser'], {
    cwd: code, env: baseEnv(code, inst.dir, inst.port), stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', d => { output += d.toString() })
  child.stderr.on('data', d => { output += d.toString() })
  const closed = once(child, 'close')
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await closed } })
  for (let i = 0; i < 240 && child.exitCode === null; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${inst.port}/api/meta/health`, { signal: AbortSignal.timeout(1000) })
      if ((await r.json()).data?.status === 'ok') return { child, closed, output: () => output }
    } catch {}
    await delay(250)
  }
  assert.fail(`instance ${inst.company} never became healthy:\n${output}`)
}
async function login(inst, username, password) {
  const r = await fetch(`http://127.0.0.1:${inst.port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, industry: 'cosmetic' }), signal: AbortSignal.timeout(10000)
  })
  return r.status
}
const secretOf = inst => JSON.parse(readFileSync(path.join(inst.dir, '.local', 'config.json'), 'utf8')).jwtSecret

test('two production instances on one code copy stay fully separate', { timeout: 180000 }, async (t) => {
  const code = codeCopy(t)
  const instances = []
  for (const company of ['ALPHA', 'BRAVO']) {
    const dir = mkdtempSync(path.join(tmpdir(), `os-egp-instance-${company}-`))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    instances.push({ company, dir, port: await freePort(), username: `owner_${company.toLowerCase()}`, password: randomBytes(24).toString('base64url') })
  }
  const [a, b] = instances

  // setup：各自目录、各自密钥文件（0600）、无库文件
  for (const inst of instances) {
    const r = manage(code, inst, 'setup')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const cfg = path.join(inst.dir, '.local', 'config.json')
    assert.ok(existsSync(cfg), 'secret file lives inside the instance dir')
    if (process.platform !== 'win32') assert.equal(statSync(cfg).mode & 0o777, 0o600)
    assert.ok(existsSync(path.join(inst.dir, 'data')))
    assert.equal(readdirSync(path.join(inst.dir, 'data')).length, 0, 'setup must not create or seed databases')
  }
  assert.notEqual(secretOf(a), secretOf(b), 'each instance generates its own secret')
  assert.equal(existsSync(path.join(code, '.local')), false, 'code copy must not receive instance state')
  assert.equal(existsSync(path.join(code, 'data')), false)

  // bootstrap：各实例一个管理员，密码只走 stdin
  for (const inst of instances) {
    const r = bootstrap(code, inst, inst.username, inst.password)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(!(r.stdout + r.stderr).includes(inst.password))
  }

  // start：同时在线
  const servers = []
  for (const inst of instances) servers.push(await startServer(t, code, inst))
  for (const [i, inst] of instances.entries()) {
    assert.match(servers[i].output(), new RegExp(`\\[start\\] Data: ${path.join(inst.dir, 'data').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.doesNotMatch(servers[i].output(), /正在生成演示数据|已签发 MCP Agent Token/)
  }

  // 账号隔离：A 的账号只在 A 能登录
  assert.equal(await login(a, a.username, a.password), 200)
  assert.equal(await login(b, b.username, b.password), 200)
  assert.equal(await login(b, a.username, a.password), 401)
  assert.equal(await login(a, b.username, b.password), 401)

  // 库内容：生产分类、只有 bootstrap 的那一个用户、无演示业务行
  for (const inst of instances) {
    for (const codeName of ['cosmetic', 'food', 'apparel']) {
      const file = path.join(inst.dir, 'data', `gml_${codeName}.db`)
      assert.ok(existsSync(file), `${inst.company} ${codeName} database`)
      const db = new Database(file, { readonly: true })
      try {
        assert.equal(db.prepare('SELECT mode FROM os_egp_runtime').get().mode, 'production')
        const users = db.prepare('SELECT username FROM users').all().map(u => u.username)
        assert.deepEqual(users, codeName === 'cosmetic' ? [inst.username] : [])
        for (const table of ['products', 'sales_orders', 'purchase_orders', 'agent_tokens']) {
          assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${inst.company}.${codeName}.${table}`)
        }
      } finally { db.close() }
    }
  }

  // doctor：各自健康
  for (const inst of instances) {
    const r = manage(code, inst, 'doctor')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const report = JSON.parse(r.stdout)
    assert.equal(report.dataDirectory, path.join(inst.dir, 'data'))
    assert.equal(report.port, inst.port)
    assert.equal(report.health?.data?.status, 'ok')
  }

  // backup：落在各自实例目录里，带各自的三库与 config.json
  for (const inst of instances) {
    const r = manage(code, inst, 'backup')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const dirs = readdirSync(path.join(inst.dir, 'backups'))
    assert.equal(dirs.length, 1)
    const files = readdirSync(path.join(inst.dir, 'backups', dirs[0])).sort()
    assert.deepEqual(files, ['config.json', 'gml_apparel.db', 'gml_cosmetic.db', 'gml_food.db'])
    const restored = new Database(path.join(inst.dir, 'backups', dirs[0], 'gml_cosmetic.db'), { readonly: true })
    try { assert.deepEqual(restored.prepare('SELECT username FROM users').all().map(u => u.username), [inst.username]) } finally { restored.close() }
  }
  assert.equal(existsSync(path.join(code, 'backups')), false, 'backups never land in the code copy')
  assert.equal(existsSync(path.join(code, 'must-not-use')), false, 'inherited GML_DATA_DIR must be ignored')

  for (const s of servers) { s.child.kill('SIGTERM'); await s.closed }
})

test('GML_LOCAL_INSTANCE must be absolute and the default stays the code root', (t) => {
  const code = codeCopy(t)
  const r = spawnSync(process.execPath, ['scripts/local-manage.mjs', 'doctor'], {
    cwd: code, env: { PATH: process.env.PATH, GML_LOCAL_INSTANCE: 'relative/dir' }, encoding: 'utf8', timeout: 60000
  })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /GML_LOCAL_INSTANCE/)
  assert.equal(existsSync(path.join(code, 'relative')), false)
  const def = spawnSync(process.execPath, ['scripts/local-manage.mjs', 'doctor'], { cwd: code, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 60000 })
  assert.equal(def.status, 0, def.stdout + def.stderr)
  // macOS 的 import.meta.url 会把 /var 解析成 /private/var：按物理路径比
  assert.equal(JSON.parse(def.stdout).dataDirectory, path.join(realpathSync(code), 'data'))
  assert.ok(existsSync(path.join(code, '.local', 'config.json')))
})
