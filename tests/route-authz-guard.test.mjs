/**
 * ============================================================================
 * 文件标识：tests/route-authz-guard.test.mjs ｜ 证明 `scripts/check-route-authz.mjs` 会红，也不误报（ADR-0021）
 * ============================================================================
 * 守卫通过环境变量 OSERP_ROUTE_AUTHZ_ROOT 指向**临时副本**（只复制 server/）：
 *   · 真仓库绿；
 *   · 注入一条裸 requireAuth 路由 / 一条完全无鉴权路由 ⇒ 红并点名；
 *   · 注入"挂载层/路由器层已有强闸门"的路由 ⇒ 不误报（r.use、展开本地数组、多行写法）；
 *   · 方法限定的行内 r.use（只守 GET）不会把 POST 误判为已闸门；
 *   · 例外表里登记了却已加闸门/已删除的路由 ⇒ 红（防橡皮图章）；
 *   · 字符串、注释、正则里的括号与 `r.get(` 字样不干扰解析。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const GUARD = path.join(ROOT, 'scripts/check-route-authz.mjs')

function run(root) {
  return spawnSync(process.execPath, [GUARD], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, env: { ...process.env, OSERP_ROUTE_AUTHZ_ROOT: root }
  })
}
function copyTree(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-route-authz-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(path.join(ROOT, 'server'), path.join(dir, 'server'), { recursive: true, filter: (s) => !s.includes('node_modules') })
  return dir
}
const addRoute = (dir, name, body, mountLine) => {
  writeFileSync(path.join(dir, 'server/routes', name), body)
  const idx = path.join(dir, 'server/index.js')
  let src = readFileSync(idx, 'utf8')
  const base = name.replace(/\.js$/, '')
  const ident = `${base.replace(/-/g, '')}Routes`
  src = src.replace("app.use('/api/auth', authRoutes)", `import ${ident} from './routes/${name}'\napp.use('/api/auth', authRoutes)\n${mountLine(ident)}`)
  writeFileSync(idx, src)
}
const HEAD = "import { Router } from 'express'\nimport { requireAuth, requirePerm } from '../middleware/auth.js'\nimport { ok, wrap } from '../lib/http.js'\nconst r = Router()\n"

test('the real repository passes the route-authz guard', () => {
  const res = run(ROOT)
  assert.equal(res.status, 0, res.stdout + res.stderr)
  assert.match(res.stdout, /通过 \d+ \/ 失败 0/)
  assert.match(res.stdout, /pending=W1/)
})

test('a bare requireAuth route and a no-auth route turn the guard red and are named', (t) => {
  const dir = copyTree(t)
  assert.equal(run(dir).status, 0, 'untouched copy must be green')
  addRoute(dir, 'zz-probe.js', HEAD + "r.get('/leak', requireAuth, wrap((_q, res) => ok(res, 1)))\nr.post(\n  '/open',\n  wrap((_q, res) => ok(res, 1))\n)\nexport default r\n", (id) => `app.use('/api/zz', ${id})`)
  const res = run(dir)
  assert.equal(res.status, 1)
  assert.match(res.stdout, /未登记：routes\/zz-probe\.js GET \/leak \(AUTH_ONLY/)
  assert.match(res.stdout, /未登记：routes\/zz-probe\.js POST \/open \(NO_AUTH/)
})

test('router-level, mount-level and spread-array gates are not false positives', (t) => {
  const dir = copyTree(t)
  addRoute(dir, 'zz-ok.js', HEAD + `const gate = [requireAuth, requirePerm('a.b')]
r.use('/guarded', requireAuth, requirePerm('x.y'))
r.get('/guarded/one', wrap((_q, res) => ok(res, 1)))
r.get('/spread', ...gate, wrap((_q, res) => ok(res, 1)))
r.get('/tricky', requireAuth, requirePerm('p'), wrap((_q, res) => ok(res, "r.get('/fake', requireAuth) ) ( " + /[)(']/.source)))
// r.get('/commented', requireAuth, wrap(() => 1))
export default r
`, (id) => `app.use('/api/zz', ${id})`)
  addRoute(dir, 'zz-mount.js', HEAD + "r.get('/m', wrap((_q, res) => ok(res, 1)))\nexport default r\n", (id) => `app.use('/api/zzm', requireAuth, requirePerm('m.v'), ${id})`)
  const res = run(dir)
  assert.equal(res.status, 0, res.stdout + res.stderr)
})

test('a method-limited inline r.use does not gate other verbs', (t) => {
  const dir = copyTree(t)
  addRoute(dir, 'zz-method.js', HEAD + `r.use((req, res, next) => {
  if (req.method !== 'GET') return next()
  return requireAuth(req, res, () => requirePerm('only.get')(req, res, next))
})
r.get('/read', wrap((_q, res) => ok(res, 1)))
r.post('/write', requireAuth, wrap((_q, res) => ok(res, 1)))
export default r
`, (id) => `app.use('/api/zzmeth', ${id})`)
  const res = run(dir)
  assert.equal(res.status, 1)
  assert.match(res.stdout, /未登记：routes\/zz-method\.js POST \/write/)
  assert.doesNotMatch(res.stdout, /GET \/read/)
})

test('a stale allowlist entry (route now gated, or removed) turns the guard red', (t) => {
  const dir = copyTree(t)
  // /orgs 在例外表里；给它加上 requirePerm ⇒ 过期登记
  const f = path.join(dir, 'server/routes/auth.js')
  let src = readFileSync(f, 'utf8')
  assert.match(src, /'\/orgs',\n  requireAuth,/)
  src = src.replace("'/orgs',\n  requireAuth,", "'/orgs',\n  requireAuth,\n  requirePerm('system.org.view'),")
  if (!/requirePerm/.test(src.split('\n').slice(0, 40).join('\n'))) src = "import { requirePerm } from '../middleware/auth.js'\n" + src
  writeFileSync(f, src)
  const res = run(dir)
  assert.equal(res.status, 1)
  assert.match(res.stdout, /过期登记：routes\/auth\.js GET \/orgs/)
})

test('a renamed or removed route leaves its allowlist entry stale', (t) => {
  const dir = copyTree(t)
  const f = path.join(dir, 'server/routes/refund.js')
  assert.ok(existsSync(f))
  const before = readFileSync(f, 'utf8')
  assert.match(before, /r\.get\('\/meta', requireAuth/)
  writeFileSync(f, before.replace("r.get('/meta', requireAuth", "r.get('/meta-renamed', requireAuth"))
  const res = run(dir)
  assert.equal(res.status, 1)
  assert.match(res.stdout, /过期登记：routes\/refund\.js GET \/meta 已不存在/)
  assert.match(res.stdout, /未登记：routes\/refund\.js GET \/meta-renamed/)
})

test('every allowlist entry in the real repository carries a reason; gaps are listed', () => {
  const res = spawnSync(process.execPath, [GUARD, '--list'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(res.status, 0)
  assert.match(res.stdout, /AUTH_ONLY .*purchase-chain\.js:\d+\] GET/)
  const src = readFileSync(GUARD, 'utf8')
  assert.doesNotMatch(src, /group\([^\n]*,\s*''\s*,/)
})

test('a gate on another mount does not vouch for an unprotected mount of the same router', (t) => {
  const dir = copyTree(t)
  addRoute(dir, 'zz-two.js', HEAD + "r.get('/x', requireAuth, wrap((_q, res) => ok(res, 1)))\nexport default r\n",
    (id) => `app.use('/api/zz1', requireAuth, requirePerm('a.b'), ${id})\napp.use('/api/zz2', ${id})`)
  const res = run(dir)
  assert.equal(res.status, 1)
  assert.match(res.stdout, /未登记：routes\/zz-two\.js GET \/x \(AUTH_ONLY/)
})

test('an r.route() registration the parser cannot read fails instead of passing silently', (t) => {
  const dir = copyTree(t)
  addRoute(dir, 'zz-route.js', HEAD + "r.route('/sneaky').get(wrap((_q, res) => ok(res, 1)))\nexport default r\n", (id) => `app.use('/api/zzr', ${id})`)
  const res = run(dir)
  assert.equal(res.status, 1)
  assert.match(res.stdout, /不可解析的路由注册：routes\/zz-route\.js:\d+ r\.route\(/)
})
