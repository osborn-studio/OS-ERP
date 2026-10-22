import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { runMigrations } from '../server/db/migrations/runner.js'

function fixture(t) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.pragma('foreign_keys=ON')
  db.exec(readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'))
  runMigrations(db)
  return db
}

test('normal migration recheck preserves an administrator-reduced SCM role', t => {
  const db = fixture(t)
  const count = () => db.prepare("SELECT count(*) n FROM role_permissions WHERE role_code='scm'").get().n
  assert.ok(count() >= 20, 'first application still establishes the default role')
  db.prepare("DELETE FROM role_permissions WHERE role_code='scm'").run()
  for (let i = 0; i < 3; i++) {
    const result = runMigrations(db)
    assert.equal(count(), 0, 'normal restart must not restore explicitly revoked grants')
    assert.ok(!result.healed.includes('049_scm_role'))
  }
})

test('normal migration recheck preserves removal of MCP approval permission', t => {
  const db = fixture(t)
  const count = () => db.prepare("SELECT count(*) n FROM role_permissions WHERE perm_code='system.mcp.confirm'").get().n
  assert.ok(count() >= 6, 'first application still establishes the default approval grants')
  db.prepare("DELETE FROM role_permissions WHERE perm_code='system.mcp.confirm'").run()
  const result = runMigrations(db)
  assert.equal(count(), 0)
  assert.ok(!result.healed.includes('026_mcp_guard'))
  assert.ok(db.prepare("SELECT 1 FROM permissions WHERE code='system.mcp.confirm'").get(), 'permission dictionary remains intact')
})

test('normal migration recheck respects an explicitly customized SCM permission set', t => {
  const db = fixture(t)
  db.prepare("DELETE FROM role_permissions WHERE role_code='scm'").run()
  db.prepare("INSERT INTO role_permissions(role_code,perm_code) VALUES ('scm','inventory.params')").run()
  const result = runMigrations(db)
  assert.deepEqual(db.prepare("SELECT perm_code FROM role_permissions WHERE role_code='scm'").all(), [{ perm_code: 'inventory.params' }])
  assert.ok(!result.healed.includes('049_scm_role'))
})
