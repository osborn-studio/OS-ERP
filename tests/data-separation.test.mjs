/**
 * ============================================================================
 * 文件标识：tests/data-separation.test.mjs ｜ AH5（ADR-0055 补充 4）：数据目录 / 数据库文件的属主与权限“只报告、不强制”的安装检查
 * 只在系统临时目录里建文件；注入 stat / uid / platform 的单元测试不依赖本机账号，doctor 子进程测试用 GML_LOCAL_INSTANCE 指向临时目录。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessDataSeparation } from '../scripts/lib/data-separation.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const tmp = (t) => { const d = mkdtempSync(path.join(tmpdir(), 'os-ah5-sep-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d }

/** 假文件系统：{ path: {uid, gid, mode, dir?, link?} } */
function fake(entries, { uid = 1000, writable = () => true } = {}) {
  return {
    platform: 'linux', uid,
    list: (dir) => Object.keys(entries).filter((p) => path.dirname(p) === dir).map((p) => path.basename(p)),
    lstat: (p) => { const e = entries[p]; if (!e) { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err } return { uid: e.uid, gid: e.gid ?? e.uid, mode: e.mode, isDirectory: () => !!e.dir, isSymbolicLink: () => !!e.link, isFile: () => !e.dir && !e.link } },
    canWrite: writable
  }
}
const D = '/inst/data'
const db = (extra = {}) => ({ [D]: { uid: 1000, mode: 0o40750, dir: true }, [`${D}/gml_cosmetic.db`]: { uid: 1000, mode: 0o100640 }, ...extra })

test('AH5 data separation: the same account owns the data and runs the service ⇒ single-account (reported, not an error); every finding is advisory', () => {
  const r = assessDataSeparation({ dataDir: D, ...fake(db()) })
  assert.equal(r.status, 'single-account')
  assert.equal(r.enforced, false)
  assert.ok(r.findings.some((f) => f.code === 'same-account'))
  assert.match(r.advice, /GML_ANCHOR_INTENT_KEY/)
})

test('AH5 data separation: files owned by another account that this account cannot write ⇒ separated', () => {
  const entries = { [D]: { uid: 0, mode: 0o40755, dir: true }, [`${D}/gml_cosmetic.db`]: { uid: 0, mode: 0o100644 } }
  const r = assessDataSeparation({ dataDir: D, ...fake(entries, { uid: 1000, writable: () => false }) })
  assert.equal(r.status, 'separated')
  assert.deepEqual(r.findings, [])
})

test('AH5 data separation: another owner but this account can still write (root, ACL, group) is not separation', () => {
  const entries = { [D]: { uid: 0, mode: 0o40755, dir: true }, [`${D}/gml_cosmetic.db`]: { uid: 0, mode: 0o100644 } }
  const r = assessDataSeparation({ dataDir: D, ...fake(entries, { uid: 0, writable: () => true }) })
  assert.equal(r.status, 'single-account')
  const r2 = assessDataSeparation({ dataDir: D, ...fake(entries, { uid: 1000, writable: () => true }) })
  assert.equal(r2.status, 'single-account')
  assert.ok(r2.findings.some((f) => f.code === 'writable-by-this-account'))
})

test('AH5 data separation: world-writable directory or database file ⇒ exposed (high); group-writable ⇒ group-shared (medium); exposure wins over separation', () => {
  const world = assessDataSeparation({ dataDir: D, ...fake(db({ [`${D}/gml_cosmetic.db`]: { uid: 1000, mode: 0o100666 } })) })
  assert.equal(world.status, 'exposed')
  assert.deepEqual(world.findings.filter((f) => f.severity === 'high').map((f) => f.code), ['world-writable'])
  assert.match(world.findings.find((f) => f.code === 'world-writable').path, /gml_cosmetic\.db$/)
  const dirWorld = assessDataSeparation({ dataDir: D, ...fake(db({ [D]: { uid: 1000, mode: 0o40777, dir: true } })) })
  assert.equal(dirWorld.status, 'exposed')
  const group = assessDataSeparation({ dataDir: D, ...fake(db({ [D]: { uid: 1000, mode: 0o40770, dir: true } })) })
  assert.equal(group.status, 'group-shared')
  assert.equal(group.findings.find((f) => f.code === 'group-writable').severity, 'medium')
  const both = assessDataSeparation({ dataDir: D, ...fake({ [D]: { uid: 0, mode: 0o40777, dir: true }, [`${D}/gml_cosmetic.db`]: { uid: 0, mode: 0o100644 } }, { uid: 1000, writable: () => false }) })
  assert.equal(both.status, 'exposed', 'a world-writable directory defeats an otherwise separated layout')
})

test('AH5 data separation: symlinked data directory or database file is reported (the real location is what matters) and never followed', () => {
  const r = assessDataSeparation({ dataDir: D, ...fake(db({ [`${D}/gml_food.db`]: { uid: 1000, mode: 0o120777, link: true } })) })
  assert.ok(r.findings.some((f) => f.code === 'symlink' && /gml_food\.db$/.test(f.path)))
  assert.notEqual(r.status, 'separated')
  const top = assessDataSeparation({ dataDir: D, ...fake({ [D]: { uid: 1000, mode: 0o120777, link: true } }) })
  assert.ok(top.findings.some((f) => f.code === 'symlink' && f.path === D))
})

test('AH5 data separation: platforms that cannot be determined are skipped with a clear message, never reported as separated', () => {
  const w = assessDataSeparation({ dataDir: D, ...fake(db()), platform: 'win32' })
  assert.equal(w.status, 'skipped')
  assert.match(w.message, /win32|Windows/)
  const noUid = assessDataSeparation({ dataDir: D, ...fake(db()), uid: null })
  assert.equal(noUid.status, 'skipped')
  const missing = assessDataSeparation({ dataDir: D, ...fake({}) })
  assert.equal(missing.status, 'not-created')
  assert.match(missing.message, /not created|尚未/)
  const boom = assessDataSeparation({ dataDir: D, ...fake(db()), lstat: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }) } })
  assert.equal(boom.status, 'unknown', 'a stat failure is unknown, not a pass')
})

test('AH5 doctor reports the data separation of a real instance without failing the command: default 0755 dir ⇒ single-account, world-writable ⇒ exposed, symlinked data dir is not followed', { skip: process.platform === 'win32' }, (t) => {
  const code = tmp(t)
  for (const name of ['server', 'scripts']) cpSync(path.join(ROOT, name), path.join(code, name), { recursive: true })
  cpSync(path.join(ROOT, 'package.json'), path.join(code, 'package.json'))
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(code, 'node_modules'), 'dir')
  mkdirSync(path.join(code, 'dist'))
  writeFileSync(path.join(code, 'dist', 'index.html'), '<!doctype html><title>stub</title>')
  const inst = tmp(t)
  const dataDir = path.join(inst, 'data')
  const dbFile = path.join(dataDir, 'gml_cosmetic.db')
  mkdirSync(dataDir, { mode: 0o700 })
  chmodSync(dataDir, 0o700)
  writeFileSync(dbFile, '')
  chmodSync(dbFile, 0o600)
  const doctor = () => spawnSync(process.execPath, ['scripts/local-manage.mjs', 'doctor'], { cwd: code, env: { PATH: process.env.PATH, HOME: inst, GML_LOCAL_INSTANCE: inst, GML_LOCAL_PORT: '45999' }, encoding: 'utf8', timeout: 60000 })
  let r = doctor()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  let report = JSON.parse(r.stdout)
  assert.equal(report.dataSeparation.status, 'single-account')
  assert.equal(report.dataSeparation.enforced, false)
  chmodSync(dbFile, 0o666)
  r = doctor()
  assert.equal(r.status, 0, 'a finding never changes the exit code (report, not enforce)')
  report = JSON.parse(r.stdout)
  assert.equal(report.dataSeparation.status, 'exposed')
  assert.ok(report.dataSeparation.findings.some((f) => f.code === 'world-writable'))
})
