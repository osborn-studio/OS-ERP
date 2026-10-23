/**
 * ============================================================================
 * 文件标识：tests/audit-logs-view.test.mjs ｜ Z7 审计日志查看器：权限、过滤、分页、二次脱敏、CSV 导出（注入安全、封顶、留痕）
 * 只在新临时数据目录与随机 loopback 端口运行；合成凭据不输出。见 ADR-0010 / ADR-0030 / roadmap-v5 Z7。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { csvCell, AUDIT_EXPORT_MAX_ROWS } from '../server/lib/audit-view.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

async function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-auditview-'))
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production',
    GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex')
  }
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let ready = false
  child.stdout.on('data', d => { ready ||= d.toString().includes('服务已启动') })
  child.stderr.on('data', () => {})
  const stopped = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    await stopped
    rmSync(dir, { recursive: true, force: true })
  })
  for (let i = 0; i < 1200 && !ready && child.exitCode === null; i++) await delay(50)
  assert.ok(ready, 'server must start')
  const raw = (route, headers = {}) => fetch(`http://127.0.0.1:${port}${route}`, { headers, signal: AbortSignal.timeout(15000) })
  const request = async (route, headers = {}) => {
    const res = await raw(route, headers)
    return { status: res.status, body: await res.json() }
  }
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  const login = async (username, role, { isSuper = 0, grant = null } = {}) => {
    const password = randomBytes(24).toString('hex')
    db.prepare('INSERT INTO users (username,password_hash,name,role,is_super) VALUES (?,?,?,?,?)')
      .run(username, bcrypt.hashSync(password, 10), username, role, isSuper)
    if (grant) {
      db.prepare("INSERT OR IGNORE INTO roles (code,name,description,is_builtin,data_scope,sort_order) VALUES (?,?,?,0,'all',99)").run(role, role, role)
      db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)').run(role, grant)
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, industry: 'cosmetic' })
    })
    const body = await res.json()
    assert.equal(res.status, 200, body.message)
    return { authorization: `Bearer ${body.data.token}` }
  }
  return { raw, request, db, login }
}

const PERM = 'system:audit:view'
const ins = (db, r) => db.prepare(
  'INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id,detail,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
).run(r.uid ?? 1, r.user ?? 'alice', r.action ?? 'CREATE', r.module ?? 'sales', r.entity ?? 'order', r.eid ?? '1', r.detail ?? null, r.ip ?? '10.0.0.1', r.at ?? '2026-10-01 10:00:00')

test('Z7 unit: csvCell quotes everything and neutralises formula prefixes', () => {
  assert.equal(csvCell('plain'), '"plain"')
  for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
    const out = csvCell(`${lead}SUM(1,1)`)
    assert.ok(out.startsWith(`"'${lead}`), `prefix ${JSON.stringify(lead)} must be neutralised: ${out}`)
  }
  assert.equal(csvCell('  =1+1'), `"'  =1+1"`)
  assert.equal(csvCell('say "hi"\nnow'), '"say ""hi""\nnow"')
  assert.equal(csvCell(null), '""')
  assert.equal(csvCell(42), '"42"')
  assert.ok(AUDIT_EXPORT_MAX_ROWS > 0 && AUDIT_EXPORT_MAX_ROWS <= 100000)
})

test('Z7 permission: 401 anonymous, 403 without system:audit:view, 200 with it; admin ok; migration grants admin', { timeout: 90000 }, async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/api/meta/audit-logs')).status, 401)
  const nobody = await f.login('z7_nobody', 'purchase')
  assert.equal((await f.request('/api/meta/audit-logs', nobody)).status, 403)
  assert.equal((await f.raw('/api/meta/audit-logs/export.csv', nobody)).status, 403)
  const auditor = await f.login('z7_auditor', 'z7_auditor_role', { grant: PERM })
  assert.equal((await f.request('/api/meta/audit-logs', auditor)).status, 200)
  assert.equal((await f.raw('/api/meta/audit-logs/export.csv', auditor)).status, 200)
  const admin = await f.login('z7_admin', 'admin', { isSuper: 1 })
  assert.equal((await f.request('/api/meta/audit-logs', admin)).status, 200)
  f.db.prepare("UPDATE roles SET data_scope='self' WHERE code='z7_auditor_role'").run()
  assert.equal((await f.request('/api/meta/audit-logs', auditor)).status, 403, 'scoped (non-global) holder is refused')
  assert.equal((await f.raw('/api/meta/audit-logs/export.csv', auditor)).status, 403)
  assert.ok(f.db.prepare('SELECT 1 FROM permissions WHERE code=?').get(PERM), 'permission in dictionary')
  assert.ok(f.db.prepare("SELECT 1 FROM role_permissions WHERE role_code='admin' AND perm_code=?").get(PERM), 'admin granted')
  assert.equal(f.db.prepare("SELECT COUNT(*) c FROM role_permissions WHERE perm_code=?").get(PERM).c >= 1, true)
  assert.equal(f.db.prepare("SELECT 1 FROM role_permissions WHERE role_code='boss' AND perm_code=?").get(PERM), undefined, 'boss not granted')
})

test('Z7 filters + pagination + redaction', { timeout: 90000 }, async t => {
  const f = await fixture(t)
  const admin = await f.login('z7_admin', 'admin', { isSuper: 1 })
  f.db.exec('DELETE FROM audit_logs')
  ins(f.db, { user: 'alice', uid: 11, action: 'CREATE', module: 'sales', entity: 'order', eid: '100', at: '2026-10-01 10:00:00', detail: '{"note":"first order"}' })
  ins(f.db, { user: 'bob', uid: 12, action: 'APPROVE', module: 'purchase', entity: 'po', eid: '200', at: '2026-10-05 09:00:00', detail: '{"note":"approve x"}' })
  ins(f.db, { user: 'alice', uid: 11, action: 'DEL100%_done', module: 'sales', entity: 'order', eid: '101', at: '2026-10-10 23:59:59', detail: 'plain text' })
  // 旧行 / 绕过 insertAuditRow 的写入：明细里仍有明文凭据与手机号，读取侧必须再脱敏一次
  ins(f.db, { user: 'carol', uid: 13, action: 'LEGACY', module: 'auth', entity: 'user', eid: '5', at: '2026-10-11 08:00:00',
    detail: JSON.stringify({ password: 'hunter2-plain', api_token: 'tok-abc', phone: '13812345678', nested: { secretKey: 's3' }, ok: 'visible' }) })
  ins(f.db, { user: 'carol', uid: 13, action: 'LEGACY2', module: 'auth', entity: 'user', eid: '6', at: '2026-10-11 08:01:00',
    detail: 'call back?token=abc123&x=1' })
  ins(f.db, { user: 'carol', uid: 13, action: 'FREE', module: 'auth', entity: 'user', eid: '7', at: '2026-10-11 08:02:00',
    detail: JSON.stringify({ note: 'password: freetext-pw contact 13987654321' }) })
  const get = async (qs, h = admin) => (await f.request(`/api/meta/audit-logs${qs}`, h)).body.data
  let d = await get('')
  assert.equal(d.total, 6)
  assert.equal(d.list[0].id > d.list[1].id, true, 'newest first')
  d = await get('?pageSize=2&page=2')
  assert.equal(d.list.length, 2); assert.equal(d.page, 2); assert.equal(d.totalPages, 3)
  assert.equal((await get('?pageSize=9999')).pageSize <= 200, true, 'page size capped')
  assert.equal((await get('?module=sales')).total, 2)
  assert.equal((await get('?action=APPROVE')).total, 1)
  assert.equal((await get('?user=alice')).total, 2)
  assert.equal((await get('?user=12')).total, 1, 'numeric user matches user_id')
  assert.equal((await get('?entity=po')).total, 1)
  assert.equal((await get('?entity=order&entity_id=101')).total, 1)
  assert.equal((await get('?from=2026-10-05&to=2026-10-10')).total, 2, 'inclusive dates incl. 23:59:59')
  assert.equal((await get('?from=2026-10-11')).total, 3)
  assert.equal((await get('?keyword=approve')).total, 1)
  assert.equal((await get('?keyword=first order')).total, 0, 'detail is not searchable (no raw-text side channel)')
  assert.equal((await get('?keyword=%25')).total, 1, 'a bare % is literal, not match-all')
  assert.equal((await get('?keyword=10_%25')).total, 0, '_ is literal, not a single-char wildcard')
  assert.equal((await get('?keyword=100%25_done')).total, 1, 'literal % _ match')
  assert.equal((await get('?module=sales&user=bob')).total, 0, 'filters AND together')
  assert.equal((await f.request('/api/meta/audit-logs?from=notadate', admin)).status, 400)
  assert.equal((await f.request('/api/meta/audit-logs?from=2026-10-10&to=2026-10-01', admin)).status, 400)
  // retention notice reads the setting
  assert.equal(d.retention.audit_days, 365)
  f.db.prepare("INSERT INTO settings (key,value) VALUES ('retention_audit_days','200') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run()
  assert.equal((await get('')).retention.audit_days, 200)
  // redaction on read
  const raw = JSON.stringify((await get('?module=auth')).list)
  for (const leak of ['hunter2-plain', 'tok-abc', '13812345678', 's3', 'abc123', 'freetext-pw', '13987654321']) assert.ok(!raw.includes(leak), `leaked ${leak}`)
  assert.ok(raw.includes('visible'))
  assert.ok(raw.includes('138****5678'))
})

test('Z7 CSV export: same filters, injection-safe, capped, audited', { timeout: 90000 }, async t => {
  const f = await fixture(t)
  const admin = await f.login('z7_admin', 'admin', { isSuper: 1 })
  f.db.exec('DELETE FROM audit_logs')
  ins(f.db, { user: '=HYPERLINK("http://x")', action: '+cmd', module: 'sales', entity: '-1+1', eid: '@SUM(A1)', detail: '{"password":"hunter2-plain","note":"=1+1"}' })
  ins(f.db, { user: 'dave', action: 'CREATE', module: 'purchase', detail: 'a,b "q"\nline2' })
  const res = await f.raw('/api/meta/audit-logs/export.csv?module=sales', admin)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/csv/)
  assert.match(res.headers.get('content-disposition'), /attachment; filename="audit-logs-.*\.csv"/)
  const text = await res.text()
  const lines = text.replace(/^﻿/, '').trim().split('\n')
  assert.equal(lines.length, 2, 'header + one filtered row')
  assert.ok(text.includes(`"'=HYPERLINK(""http://x"")"`))
  assert.ok(text.includes(`"'+cmd"`)); assert.ok(text.includes(`"'-1+1"`)); assert.ok(text.includes(`"'@SUM(A1)"`))
  assert.ok(!text.includes('hunter2-plain'), 'detail redacted in export')
  assert.ok(!text.includes('dave'), 'filter applied to export')
  const all = await (await f.raw('/api/meta/audit-logs/export.csv', admin)).text()
  assert.ok(all.includes('"a,b ""q""\nline2"'))
  // exports are themselves audited, with filters and row count
  const row = f.db.prepare("SELECT * FROM audit_logs WHERE action='AUDIT_LOG_EXPORT' ORDER BY id").all()
  assert.equal(row.length, 2)
  assert.equal(row[0].module, 'audit'); assert.equal(row[0].user_name, 'z7_admin')
  const detail = JSON.parse(row[0].detail)
  assert.equal(detail.filters.module, 'sales'); assert.equal(detail.rows, 1); assert.equal(detail.truncated, false)
  assert.equal(detail.max_rows, AUDIT_EXPORT_MAX_ROWS)
})

test('Z7 CSV export is row-capped and marks truncation', { timeout: 120000 }, async t => {
  const f = await fixture(t)
  const admin = await f.login('z7_admin', 'admin', { isSuper: 1 })
  f.db.exec('DELETE FROM audit_logs')
  const stmt = f.db.prepare("INSERT INTO audit_logs (user_id,user_name,action,module,created_at) VALUES (1,'bulk','BULK','bulk','2026-10-01 00:00:00')")
  f.db.transaction(() => { for (let i = 0; i < AUDIT_EXPORT_MAX_ROWS + 5; i++) stmt.run() })()
  const text = await (await f.raw('/api/meta/audit-logs/export.csv?module=bulk', admin)).text()
  const lines = text.replace(/^﻿/, '').trim().split('\n')
  assert.equal(lines.length, 1 + AUDIT_EXPORT_MAX_ROWS)
  const d = JSON.parse(f.db.prepare("SELECT detail FROM audit_logs WHERE action='AUDIT_LOG_EXPORT'").get().detail)
  assert.equal(d.rows, AUDIT_EXPORT_MAX_ROWS); assert.equal(d.truncated, true)
})
