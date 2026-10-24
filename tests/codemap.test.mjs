/**
 * ============================================================================
 * 文件标识：tests/codemap.test.mjs ｜ 代码地图与 ADR 索引生成器（Z12）：确定性、覆盖完整、--check 对漂移变红
 * ============================================================================
 * 证明的事：
 *   · 两次生成逐字节一致（无时间戳、无绝对路径）；
 *   · check-route-authz --list 的每一条路由都在 routes.md 里（按 文件:行号+动词+路径 逐条对账，多重集合相等）；
 *   · 每个 ADR 文件都在 ADR-INDEX.md；每个 server/lib 模块都在 modules.md；每个 schema/迁移里建的表都在 tables.md；
 *   · 抽样事实：某条路由→处理器文件→调用的 lib→触达的表，与源码一致（合成路由证明扫描语义，而不是只对账行数）；
 *   · 仓库里的四份产物是最新的；任何一份被手改（漂移）⇒ `--check` 退出 1 并点名；
 *   · 扫描边界声明（"不做什么"）写在产物里，不能被删。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { generate, MARKER, OUTPUTS } from '../scripts/gen-codemap.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GEN = path.join(ROOT, 'scripts/gen-codemap.mjs')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** 临时副本：只复制 server/ 与 docs/implementation（生成器自身从本仓库运行，路由清单通过 OSERP_ROUTE_AUTHZ_ROOT 指向副本）。 */
function copyTree(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'z12-codemap-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  fs.cpSync(path.join(ROOT, 'server'), path.join(d, 'server'), { recursive: true, filter: (s) => !s.includes('node_modules') })
  fs.mkdirSync(path.join(d, 'docs/implementation'), { recursive: true })
  for (const f of fs.readdirSync(path.join(ROOT, 'docs/implementation'))) {
    if (/^ADR-.*\.md$/.test(f)) fs.copyFileSync(path.join(ROOT, 'docs/implementation', f), path.join(d, 'docs/implementation', f))
  }
  return d
}
const cli = (root, ...a) => spawnSync(process.execPath, [GEN, `--root=${root}`, ...a], { encoding: 'utf8', timeout: 120000 })

test('the four outputs are declared and carry the generated marker', () => {
  assert.deepEqual(Object.keys(OUTPUTS).sort(), ['adr', 'modules', 'routes', 'tables'])
  const { files } = generate({ root: ROOT })
  for (const rel of Object.values(OUTPUTS)) {
    assert.ok(files[rel], `${rel} generated`)
    assert.ok(files[rel].includes(MARKER), `${rel} has marker`)
  }
})

test('deterministic: two generations are byte-identical, no absolute paths or timestamps', () => {
  const a = generate({ root: ROOT })
  const b = generate({ root: ROOT })
  assert.deepEqual(a.files, b.files)
  for (const [rel, text] of Object.entries(a.files)) {
    assert.ok(!text.includes(ROOT), `${rel} leaks the checkout path`)
    assert.ok(!/\b20\d\d-\d\d-\d\dT\d\d:/.test(text), `${rel} contains a timestamp`)
    assert.ok(!text.includes('/Users/') && !text.includes('/Volumes/'), `${rel} contains an absolute path`)
  }
})

test('every route from check-route-authz --list appears in routes.md exactly once (file:line + verb + path)', () => {
  const list = spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-route-authz.mjs'), '--list'], { encoding: 'utf8' }).stdout
  const want = []
  for (const line of list.split('\n')) {
    const m = /^(GATED|AUTH_ONLY|NO_AUTH)\s+(\S+)\s+\[routes\/([^\]:]+):(\d+)\]\s+(\S+)\s/.exec(line + ' ')
    if (m) want.push(`${m[3]}:${m[4]} ${m[5]} ${m[2]}`)
  }
  assert.ok(want.length > 600, `parsed ${want.length} routes`)
  const md = read('docs/CODEMAPS/routes.md')
  const got = []
  for (const line of md.split('\n')) {
    const m = /^\| `([^`]+:\d+)` \| ([A-Z]+) \| `([^`]+)` \|/.exec(line)
    if (m) got.push(`${m[1]} ${m[2]} ${m[3]}`)
  }
  assert.deepEqual(got.sort(), want.sort())
})

test('every ADR file is in ADR-INDEX.md with a batch; every lib module and every table is mapped', () => {
  const idx = read('docs/implementation/ADR-INDEX.md')
  const adrs = fs.readdirSync(path.join(ROOT, 'docs/implementation')).filter((f) => /^ADR-\d{4}-.+\.md$/.test(f))
  assert.ok(adrs.length >= 36)
  for (const f of adrs) assert.ok(idx.includes(`](${f})`), `${f} missing from ADR-INDEX.md`)
  const mod = read('docs/CODEMAPS/modules.md')
  for (const f of fs.readdirSync(path.join(ROOT, 'server/lib')).filter((x) => x.endsWith('.js'))) {
    assert.ok(mod.includes(`\`server/lib/${f}\``), `server/lib/${f} missing from modules.md`)
  }
  const tbl = read('docs/CODEMAPS/tables.md')
  const schema = read('server/db/schema.sql')
  for (const m of schema.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+["`]?([a-z_][a-z0-9_]*)/gi)) {
    assert.ok(tbl.includes(`| \`${m[1].toLowerCase()}\` |`), `table ${m[1]} missing from tables.md`)
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'server/db/migrations')).filter((x) => /^\d{3}_.*\.cjs$/.test(x))) {
    for (const m of read(`server/db/migrations/${f}`).matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+["`]?([a-z_][a-z0-9_]*)/gi)) {
      if (m[1].toLowerCase() === "if") continue // 注释里的 `CREATE TABLE IF NOT EXISTS` 字样
      assert.ok(tbl.includes(`| \`${m[1].toLowerCase()}\` |`), `table ${m[1]} (${f}) missing from tables.md`)
    }
  }
})

test('scan semantics on a synthetic route: chain, handler file, lib functions, tables, migrations', (t) => {
  const d = copyTree(t)
  fs.writeFileSync(path.join(d, 'server/lib/zz-probe.js'), `
import { getDb } from '../db/index.js'
export function readThing(db, id) { return db.prepare('SELECT * FROM zz_things WHERE id=?').get(id) }
export function writeThing(db, id) { helperTouch(db); return db.prepare("UPDATE zz_things SET x=1 WHERE id=?").run(id) }
function helperTouch(db) { db.prepare('INSERT INTO zz_log (a) VALUES (1)').run() }
// export function ghost() { FROM zz_ghost }
export const ZZ_CONST = 1
`)
  fs.writeFileSync(path.join(d, 'server/db/migrations/999_zz.cjs'), `'use strict'
const { addColumn } = require('./_helpers.cjs')
module.exports.name = 'zz probe'
module.exports.up = (db) => {
  db.exec('CREATE TABLE IF NOT EXISTS zz_things (id INTEGER PRIMARY KEY)')
  db.exec('CREATE TABLE IF NOT EXISTS zz_log (a INTEGER)')
  addColumn(db, 'products', 'zz_flag', 'INTEGER')
}
`)
  fs.writeFileSync(path.join(d, 'server/routes/zz-probe.js'), `import { Router } from 'express'
import { requireAuth, requirePerm } from '../middleware/auth.js'
import { ok, wrap } from '../lib/http.js'
import { readThing, writeThing, ZZ_CONST } from '../lib/zz-probe.js'
const r = Router()
r.get('/thing/:id', requireAuth, requirePerm('zz.view'), wrap((req, res) => {
  const db = req.db
  const n = db.prepare('SELECT COUNT(*) c FROM products').get()
  ok(res, readThing(db, req.params.id), n, ZZ_CONST)
}))
function localHelper(db) { return writeThing(db, 1) }
r.post('/thing/:id', requireAuth, requirePerm('zz.edit'), wrap((req, res) => {
  ok(res, localHelper(req.db))
}))
export default r
`)
  const idx = path.join(d, 'server/index.js')
  fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace("app.use('/api/auth', authRoutes)", "import zzprobeRoutes from './routes/zz-probe.js'\napp.use('/api/auth', authRoutes)\napp.use('/api/zz', zzprobeRoutes)"))
  const { files } = generate({ root: d })
  const routes = files['docs/CODEMAPS/routes.md']
  const getRow = routes.split('\n').find((l) => l.includes('`/api/zz/thing/:id`') && l.includes('| GET |'))
  const postRow = routes.split('\n').find((l) => l.includes('`/api/zz/thing/:id`') && l.includes('| POST |'))
  assert.ok(getRow, 'GET row present'); assert.ok(postRow, 'POST row present')
  assert.match(getRow, /requireAuth → requirePerm\('zz\.view'\)|requireAuth → requirePerm/)
  assert.match(getRow, /zz-probe\.js/)
  assert.match(getRow, /readThing/)
  assert.ok(!/writeThing/.test(getRow), 'GET must not claim writeThing')
  assert.ok(!/ZZ_CONST/.test(getRow), 'constants are not functions')
  assert.match(getRow, /products/, 'handler-level SQL table')
  assert.match(getRow, /zz_things/, 'table reached through the lib function')
  assert.ok(!/zz_log/.test(getRow))
  // POST：经本文件 localHelper → writeThing（本地助手一层展开）→ helperTouch（同模块传递）
  assert.match(postRow, /writeThing/)
  assert.match(postRow, /zz_things/)
  assert.match(postRow, /zz_log/)
  assert.ok(!/zz_ghost/.test(files['docs/CODEMAPS/tables.md']), 'commented-out SQL is ignored')
  const tables = files['docs/CODEMAPS/tables.md']
  const th = tables.split('\n').find((l) => l.startsWith('| `zz_things` |'))
  assert.ok(th && th.includes('999') && th.includes('zz-probe.js'), th)
  const pr = tables.split('\n').find((l) => l.startsWith('| `products` |'))
  assert.ok(pr.includes('999'), 'addColumn counts as altering migration')
  const mods = files['docs/CODEMAPS/modules.md']
  const mrow = mods.split('\n').find((l) => l.includes('`readThing`'))
  assert.ok(mrow && mrow.includes('/api/zz/thing/:id'), mrow)
})

test('--check is green on the repository and red (exit 1, named) when any output drifts or is missing', (t) => {
  const d = copyTree(t)
  assert.equal(cli(d).status, 0)
  assert.equal(cli(d, '--check').status, 0, 'fresh write is current')
  for (const rel of Object.values(OUTPUTS)) {
    const file = path.join(d, rel)
    const good = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, good + '\n手动改动\n')
    const bad = cli(d, '--check')
    assert.equal(bad.status, 1, `${rel} drift must be red`)
    assert.ok(bad.stderr.includes(rel), `stderr names ${rel}: ${bad.stderr}`)
    fs.writeFileSync(file, good)
    assert.equal(cli(d, '--check').status, 0)
    fs.rmSync(file)
    assert.equal(cli(d, '--check').status, 1, `${rel} missing must be red`)
    fs.writeFileSync(file, good)
  }
  // 源码变化也算漂移：给副本加一条路由而不重新生成
  fs.writeFileSync(path.join(d, 'server/routes/zz-drift.js'), "import { Router } from 'express'\nimport { requireAuth, requirePerm } from '../middleware/auth.js'\nconst r = Router()\nr.get('/x', requireAuth, requirePerm('a.b'), (q, s) => s.json({}))\nexport default r\n")
  const idx = path.join(d, 'server/index.js')
  fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace("app.use('/api/auth', authRoutes)", "import zzdriftRoutes from './routes/zz-drift.js'\napp.use('/api/auth', authRoutes)\napp.use('/api/zzd', zzdriftRoutes)"))
  assert.equal(cli(d, '--check').status, 1, 'new route without regeneration is drift')
})

test('repository outputs are current (run: node scripts/gen-codemap.mjs)', () => {
  const { files } = generate({ root: ROOT })
  for (const [rel, text] of Object.entries(files)) assert.equal(read(rel), text, `${rel} is stale; run node scripts/gen-codemap.mjs`)
  const res = spawnSync(process.execPath, [GEN, '--check'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
})

test('the outputs state their scan limits (honesty block) and development.md points at the maps', () => {
  for (const rel of ['docs/CODEMAPS/routes.md', 'docs/CODEMAPS/modules.md', 'docs/CODEMAPS/tables.md']) {
    const t = read(rel)
    assert.match(t, /扫描边界/, `${rel} must state its limits`)
    assert.match(t, /静态/, `${rel} must say it is a static scan`)
  }
  const dev = read('docs/implementation/development.md')
  assert.match(dev, /新人 30 分钟路径/)
  for (const p of ['CODEMAPS/routes.md', 'CODEMAPS/modules.md', 'CODEMAPS/tables.md', 'ADR-INDEX.md', 'check-route-authz']) assert.ok(dev.includes(p), `development.md should mention ${p}`)
})
