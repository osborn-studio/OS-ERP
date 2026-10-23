/**
 * ============================================================================
 * 文件标识：tests/data-path-guard.test.mjs ｜ 证明 `scripts/check-data-paths.mjs` 会红（ADR-0019）
 * ============================================================================
 * 守卫在**临时副本**上跑：复制 scripts/ server/ tests/ 到临时目录，注入一条 `data/gml_*.db` 字面量，
 * 守卫必须退出非零并点名该文件；不注入时必须绿；例外表里登记了却已无命中的文件必须红（防橡皮图章）。
 * 真仓库本身也跑一次（绿）—— 否则"守卫可用"与"仓库干净"两件事只证明了一件。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const GUARD = 'scripts/check-data-paths.mjs'

function run(cwd, args = []) {
  return spawnSync(process.execPath, [GUARD, ...args], { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 })
}
function copyTree(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-egp-data-path-guard-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const name of ['scripts', 'server', 'tests']) {
    cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true, filter: (src) => !src.includes('node_modules') })
  }
  return dir
}

test('the real repository passes the data-path guard', () => {
  const result = run(ROOT)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /通过 \d+ \/ 失败 0/)
})

test('an injected data/gml_*.db literal turns the guard red and is named', (t) => {
  const dir = copyTree(t)
  assert.equal(run(dir).status, 0, 'untouched copy must be green')
  const evil = path.join(dir, 'scripts', 'injected-bypass.mjs')
  writeFileSync(evil, "import Database from 'better-sqlite3'\nconst db = new Database('data/gml_cosmetic.db', { readonly: true })\n")
  const result = run(dir)
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /injected-bypass\.mjs/)
  // 第二种形态：path.join(ROOT, 'data', `gml_${x}.db`) 也必须被认出来
  writeFileSync(evil, "import path from 'node:path'\nconst f = path.join(process.cwd(), 'data', `gml_${process.argv[2]}.db`)\n")
  assert.notEqual(run(dir).status, 0)
  // 第三种形态：相对 cwd 的 readdirSync('data')
  writeFileSync(evil, "import fs from 'node:fs'\nfs.readdirSync('data')\n")
  assert.notEqual(run(dir).status, 0)
})

test('a comment-only mention and a server/db/index.js definition are not violations', (t) => {
  const dir = copyTree(t)
  mkdirSync(path.join(dir, 'scripts', 'sub'), { recursive: true })
  writeFileSync(path.join(dir, 'scripts', 'sub', 'notes.mjs'), "// 旧写法 'data/gml_cosmetic.db' 已废弃\n/* path.join(ROOT, 'data', 'gml_food.db') */\nexport const x = 1\n")
  const result = run(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('a stale allowlist entry (file without any hit) turns the guard red', (t) => {
  const dir = copyTree(t)
  const guard = path.join(dir, GUARD)
  const src = readFileSync(guard, 'utf8')
  assert.ok(src.includes("'scripts/regress-all.mjs'"), 'test assumes regress-all is allowlisted')
  // 把例外表里的 regress-all 命中点从源码里抹掉：例外表仍登记它 ⇒ 守卫必须红
  const target = path.join(dir, 'scripts', 'regress-all.mjs')
  writeFileSync(target, readFileSync(target, 'utf8').replace(/path\.join\(ROOT, 'data'\)/g, "path.join(ROOT, 'd' + 'ata')"))
  const result = run(dir)
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /regress-all\.mjs/)
})
