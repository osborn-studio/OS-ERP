import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { SETTING_RULES } from '../server/lib/settings.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCRIPT = 'scripts/retention.mjs'
const envFor = (dir, extra = {}) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: 'a'.repeat(48), ...extra })

function fixture(t, industries = ['cosmetic']) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-x9-ret-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const init = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const {initSchemaFor}=await import('./server/db/index.js');for(const c of ${JSON.stringify(industries)}) initSchemaFor(c)`
  ], { cwd: ROOT, env: envFor(dir), encoding: 'utf8', timeout: 120000 })
  assert.equal(init.status, 0, init.stderr)
  return dir
}
const run = (dir, args = [], extra = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: envFor(dir, extra), encoding: 'utf8', timeout: 60000 })
const open = (dir, code = 'cosmetic') => new Database(path.join(dir, `gml_${code}.db`))
const ago = (days) => `datetime('now','localtime','-${days} days')`

function seed(db) {
  const audit = db.prepare(`INSERT INTO audit_logs (user_name, action, module, created_at) VALUES (?,?,?,${'?'})`)
  const at = (days) => db.prepare(`SELECT ${ago(days)} AS t`).get().t
  audit.run('u', 'OLD_PLAIN', 'sales', at(400))
  audit.run('u', 'NEW_PLAIN', 'sales', at(10))
  audit.run('u', 'OLD_FINANCE', 'finance', at(2000))
  audit.run('u', 'OLD_SETTING', 'settings', at(2000))
  audit.run('u', 'OLD_AUTH', 'auth', at(2000))
  audit.run('u', 'FUNDS_CONFIRM', 'sales', at(2000))
  const nl = db.prepare(`INSERT INTO notify_logs (title, created_at) VALUES (?,?)`)
  nl.run('old', at(100)); nl.run('new', at(5))
  const ml = db.prepare(`INSERT INTO mcp_call_logs (tool_name, level, created_at) VALUES (?,?,?)`)
  ml.run('old_read', 'read', at(100)); ml.run('old_danger', 'danger', at(100)); ml.run('new_read', 'read', at(5))
}
const count = (db, sql) => db.prepare(sql).get().n

test('settings registry has the three retention keys as danger settings with the specified defaults', () => {
  for (const [key, def] of [['retention_audit_days', '365'], ['retention_notify_log_days', '90'], ['retention_mcp_log_days', '90']]) {
    assert.ok(SETTING_RULES[key], key)
    assert.equal(SETTING_RULES[key].default, def)
    assert.equal(SETTING_RULES[key].is_danger, true)
    assert.equal(SETTING_RULES[key].type, 'int')
  }
})

test('default is a dry run: counts per table and industry, nothing deleted', (t) => {
  const dir = fixture(t)
  const db = open(dir); seed(db)
  const before = count(db, 'SELECT COUNT(*) n FROM audit_logs'); db.close()
  const r = run(dir, ['--json'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const out = JSON.parse(r.stdout)
  assert.equal(out.mode, 'dry-run')
  const c = out.industries.cosmetic
  assert.equal(c.days.audit, 365); assert.equal(c.days.notify, 90); assert.equal(c.days.mcp, 90)
  assert.equal(c.counts.audit_logs, 1, 'only the unprotected 400-day row is eligible')
  assert.equal(c.counts.notify_logs, 1)
  assert.equal(c.counts.mcp_call_logs, 1, 'danger-level MCP rows are kept')
  const db2 = open(dir)
  assert.equal(count(db2, 'SELECT COUNT(*) n FROM audit_logs'), before)
  db2.close()
})

test('--execute deletes only eligible rows and writes exactly one audit summary in the same transaction', (t) => {
  const dir = fixture(t)
  const db = open(dir); seed(db); db.close()
  const r = run(dir, ['--execute', '--json'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const db2 = open(dir)
  const actions = db2.prepare('SELECT action FROM audit_logs ORDER BY id').all().map((x) => x.action)
  assert.ok(!actions.includes('OLD_PLAIN'))
  for (const keep of ['NEW_PLAIN', 'OLD_FINANCE', 'OLD_SETTING', 'OLD_AUTH', 'FUNDS_CONFIRM']) assert.ok(actions.includes(keep), keep)
  assert.deepEqual(db2.prepare('SELECT title FROM notify_logs').all().map((x) => x.title), ['new'])
  assert.deepEqual(db2.prepare('SELECT tool_name FROM mcp_call_logs ORDER BY id').all().map((x) => x.tool_name), ['old_danger', 'new_read'])
  const summary = db2.prepare("SELECT * FROM audit_logs WHERE action='RETENTION_PURGE'").all()
  assert.equal(summary.length, 1)
  assert.equal(summary[0].module, 'retention')
  const detail = JSON.parse(summary[0].detail)
  assert.deepEqual(detail.counts, { audit_logs: 1, notify_logs: 1, mcp_call_logs: 1 })
  db2.close()
  // second run is a no-op on rows but still one more summary row; the first summary is itself protected
  const r2 = run(dir, ['--execute', '--json'])
  assert.equal(r2.status, 0)
  const db3 = open(dir)
  assert.equal(count(db3, "SELECT COUNT(*) n FROM audit_logs WHERE action='RETENTION_PURGE'"), 2)
  db3.close()
})

test('honours configured retention windows from settings', (t) => {
  const dir = fixture(t)
  const db = open(dir); seed(db)
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('retention_notify_log_days','200')").run()
  db.close()
  const out = JSON.parse(run(dir, ['--json']).stdout)
  assert.equal(out.industries.cosmetic.days.notify, 200)
  assert.equal(out.industries.cosmetic.counts.notify_logs, 0)
})

test('an invalid retention setting fails closed and deletes nothing', (t) => {
  const dir = fixture(t)
  const db = open(dir); seed(db)
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('retention_audit_days','0')").run()
  const before = count(db, 'SELECT COUNT(*) n FROM audit_logs'); db.close()
  const r = run(dir, ['--execute'])
  assert.equal(r.status, 1, r.stdout + r.stderr)
  const db2 = open(dir)
  assert.equal(count(db2, 'SELECT COUNT(*) n FROM audit_logs'), before)
  db2.close()
})

test('when the audit summary cannot be written nothing is deleted', (t) => {
  const dir = fixture(t)
  const db = open(dir); seed(db)
  db.exec("CREATE TRIGGER block_summary BEFORE INSERT ON audit_logs WHEN NEW.action='RETENTION_PURGE' BEGIN SELECT RAISE(ABORT,'blocked'); END")
  const before = count(db, 'SELECT COUNT(*) n FROM notify_logs'); db.close()
  const r = run(dir, ['--execute'])
  assert.equal(r.status, 1, r.stdout + r.stderr)
  const db2 = open(dir)
  assert.equal(count(db2, 'SELECT COUNT(*) n FROM notify_logs'), before)
  assert.equal(count(db2, "SELECT COUNT(*) n FROM audit_logs WHERE action='OLD_PLAIN'"), 1)
  db2.close()
})

test('refuses the repository data directory, a missing data directory and bad arguments', (t) => {
  const dir = fixture(t)
  assert.equal(run(dir, [], { GML_DATA_DIR: path.join(ROOT, 'data') }).status, 2)
  assert.equal(run(dir, [], { GML_DATA_DIR: '' }).status, 2)
  assert.equal(run(dir, ['--bogus']).status, 2)
  assert.equal(run(dir, ['--execute', '--dry-run']).status, 2)
  assert.equal(run(dir, ['nosuchindustry']).status, 2)
})

test('industries without a database file are reported as absent, not created', (t) => {
  const dir = fixture(t)
  const r = run(dir, ['--json'])
  const out = JSON.parse(r.stdout)
  assert.equal(out.industries.food.status, 'absent')
  assert.ok(!existsSync(path.join(dir, 'gml_food.db')))
})
