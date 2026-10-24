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
import { readFileSync, mkdtempSync as mkd, cpSync, rmSync as rm } from 'node:fs'
import { csvCell, AUDIT_EXPORT_MAX_ROWS, AUDIT_COUNT_CAP, buildWhere, parseFilters, orderOf, AuditViewError, ftsAvailable, ftsEnvDisabled, keywordUsesFts, FTS_RARE_MAX, setFtsOverride, AUDIT_ACTION_NEEDS_MODULE } from '../server/lib/audit-view.js'
import { runMigrations, MIGRATIONS_DIR } from '../server/db/migrations/runner.js'
import { auditStatements, STATEMENTS, ALLOW } from '../scripts/explain-audit.mjs'
import * as m065 from '../server/db/migrations/065_audit_log_indexes.cjs'
import * as m067 from '../server/db/migrations/067_audit_fts.cjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
// AC5：CI 以 GML_AUDIT_FTS=0 再跑一遍本文件（真实的无 FTS 路径）。此时依赖"FTS 路径可用"的用例跳过（原因写明），其余用例照跑
const NOFTS = process.env.GML_AUDIT_FTS === '0'
const needsFts = NOFTS ? { skip: 'GML_AUDIT_FTS=0: this case asserts the FTS path is available' } : {}

async function fixture(t, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-auditview-'))
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production',
    GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex'),
    ...(process.env.GML_AUDIT_FTS === undefined ? {} : { GML_AUDIT_FTS: process.env.GML_AUDIT_FTS }), ...extraEnv
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
  assert.equal((await get('?module=purchase&action=APPROVE')).total, 1)
  assert.equal((await get('?user=alice')).total, 2)
  assert.equal((await get('?user=12')).total, 1, 'numeric user matches user_id')
  assert.equal((await get('?entity=po')).total, 1)
  assert.equal((await get('?entity=order&entity_id=101')).total, 1)
  assert.equal((await get('?from=2026-10-05&to=2026-10-10')).total, 2, 'inclusive dates incl. 23:59:59')
  assert.equal((await get('?from=2026-10-11')).total, 3)
  assert.equal((await get('?keyword=approve')).total, 1)
  assert.equal((await get('?keyword=first order')).total, 0, 'detail is not searchable (no raw-text side channel)')
  assert.equal((await f.request('/api/meta/audit-logs?keyword=%25', admin)).status, 400, 'AA6: a single char keyword is refused')
  assert.equal((await get('?keyword=0%25')).total, 1, 'a % inside the keyword is literal, not match-all')
  assert.equal((await get('?keyword=%25%25')).total, 0, '%% is two literal percent signs, not match-all')
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

// ---------------------------------------------------------------------------------------------------------------------------
// AA6：关键词限制、封顶计数、翻页深度、排序/导出游标、迁移 065 与 explain-audit
// ---------------------------------------------------------------------------------------------------------------------------
test('AA6 unit: keyword needs 2 effective chars and buildWhere enforces it on its own', () => {
  for (const k of ['\u0000ab', 'a\u0000b', 'ab\u0000', 'a\tb', 'a\nb']) {
    assert.throws(() => parseFilters({ keyword: k }), AuditViewError, `control chars refused: ${JSON.stringify(k)}`)
    assert.throws(() => buildWhere({ keyword: k }), AuditViewError, `buildWhere: ${JSON.stringify(k)}`)
  }
  for (const k of ['a', ' a ', 'a\u200b', '\u200b\u200b', '%', ' \t ']) {
    if (k.trim() === '') { assert.deepEqual(parseFilters({ keyword: k }), {}, 'blank keyword is just no keyword'); continue }
    assert.throws(() => parseFilters({ keyword: k }), AuditViewError, JSON.stringify(k))
    assert.throws(() => buildWhere({ keyword: k }), AuditViewError, `buildWhere ${JSON.stringify(k)}`)
  }
  assert.throws(() => parseFilters({ keyword: ['a', 'long enough'] }), AuditViewError, 'first array element decides (same as every other filter)')
  const { where, args } = buildWhere(parseFilters({ keyword: '订单' }))
  assert.match(where, /action LIKE/); assert.match(where, /entity LIKE/); assert.match(where, /user_name LIKE/)
  assert.doesNotMatch(where, /detail|module LIKE|entity_id LIKE/, 'keyword searches action/entity/user_name only')
  assert.equal(args.length, 3)
  assert.match(buildWhere({ entity: 'e' }).where, /\+entity = \?/, 'entity alone must not use idx_audit_entity (forces a temp sort)')
  assert.match(buildWhere({ entity: 'e', entity_id: '1' }).where, /entity = \?/)
  assert.doesNotMatch(buildWhere({ entity: 'e', entity_id: '1' }).where, /\+entity/)
  assert.equal(orderOf({}).sql, 'id DESC')
  assert.equal(orderOf({ module: 'x' }).sql, 'created_at DESC, id DESC')
  assert.equal(orderOf({ user: '12' }).sql, 'created_at DESC, id DESC')
  assert.equal(orderOf({ user: 'alice' }).sql, 'id DESC', 'a name is a substring match: no user_id index order')
  assert.equal(orderOf({ module: 'x', entity: 'e', entity_id: '1' }).sql, 'id DESC', 'entity+id wins: idx_audit_entity gives rowid order')
})

test('AA6 keyword scope over HTTP: module / entity_id / detail are not searched; short keyword is 400 on list and export', { timeout: 90000 }, async t => {
  const f = await fixture(t)
  const admin = await f.login('aa6_admin', 'admin', { isSuper: 1 })
  f.db.exec('DELETE FROM audit_logs')
  ins(f.db, { user: 'alice', action: 'CREATE', module: 'zzmodule', entity: 'order', eid: 'zzeid', detail: '{"note":"zzdetail"}' })
  const get = async (qs) => f.request(`/api/meta/audit-logs${qs}`, admin)
  assert.equal((await get('?keyword=zzmodule')).body.data.total, 0)
  assert.equal((await get('?keyword=zzeid')).body.data.total, 0)
  assert.equal((await get('?keyword=zzdetail')).body.data.total, 0)
  assert.equal((await get('?keyword=ali')).body.data.total, 1, 'user_name')
  assert.equal((await get('?keyword=CREA')).body.data.total, 1, 'action')
  assert.equal((await get('?keyword=ord')).body.data.total, 1, 'entity')
  for (const bad of ['a', '%25', '%E2%80%8Ba', '%20a%20', '%00ab', 'a%00b']) {
    assert.equal((await get(`?keyword=${bad}`)).status, 400, `list ${bad}`)
    assert.equal((await f.raw(`/api/meta/audit-logs/export.csv?keyword=${bad}`, admin)).status, 400, `export ${bad}`)
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='AUDIT_LOG_EXPORT'").get().c, 0, 'refused export leaves no export audit row')
})

test('AA6 capped count: total is at most cap+1, has_more flags it, exact below the cap, page depth is capped', { timeout: 120000 }, async t => {
  const f = await fixture(t)
  const admin = await f.login('aa6_admin', 'admin', { isSuper: 1 })
  f.db.exec('DELETE FROM audit_logs')
  const stmt = f.db.prepare("INSERT INTO audit_logs (user_id,user_name,action,module,created_at) VALUES (?,?,?,?,datetime('2026-01-01','+'||?||' seconds'))")
  f.db.transaction(() => {
    for (let i = 0; i < AUDIT_COUNT_CAP + 50; i++) stmt.run(1, 'bulk', 'BULK', 'big', i)
    for (let i = 0; i < 7; i++) stmt.run(2, 'few', 'FEW', 'small', i)
  })()
  const get = async (qs) => (await f.request(`/api/meta/audit-logs${qs}`, admin))
  let d = (await get('?module=big&pageSize=100')).body.data
  assert.equal(d.total, AUDIT_COUNT_CAP + 1, 'capped at cap+1, not the true 10050')
  assert.equal(d.has_more, true); assert.equal(d.total_cap, AUDIT_COUNT_CAP)
  assert.equal(d.totalPages, AUDIT_COUNT_CAP / 100, 'pages never exceed the reachable depth')
  assert.equal(d.list.length, 100)
  d = (await get('?module=small')).body.data
  assert.equal(d.total, 7); assert.equal(d.has_more, false)
  assert.equal(d.list[0].created_at > d.list[6].created_at, true, 'time order newest first')
  d = (await get('?user=2')).body.data
  assert.equal(d.total, 7, 'numeric user = user_id')
  const unfiltered = (await get('')).body.data
  assert.equal(unfiltered.has_more, true); assert.equal(unfiltered.total, AUDIT_COUNT_CAP + 1)
  const last = await get(`?module=big&pageSize=100&page=${AUDIT_COUNT_CAP / 100}`)
  assert.equal(last.status, 200); assert.equal(last.body.data.list.length, 100)
  const deep = await get(`?module=big&pageSize=100&page=${AUDIT_COUNT_CAP / 100 + 1}`)
  assert.equal(deep.status, 400); assert.match(deep.body.message, /上限/)
})

test('AA6 export cursor follows the list order: every row once, newest first, ties on created_at, filter + snapshot respected', { timeout: 120000 }, async t => {
  const f = await fixture(t)
  const admin = await f.login('aa6_admin', 'admin', { isSuper: 1 })
  f.db.exec('DELETE FROM audit_logs')
  const stmt = f.db.prepare('INSERT INTO audit_logs (user_id,user_name,action,module,created_at) VALUES (?,?,?,?,?)')
  f.db.transaction(() => {
    for (let i = 0; i < 2600; i++) {
      // 同一秒里多行（created_at 并列）+ 其它模块的行穿插，游标必须按 (created_at,id) 而不是只按其一
      const sec = String(Math.floor(i / 9) % 60).padStart(2, '0')
      stmt.run(i % 2 ? 5 : 6, 'u', 'A', i % 3 === 0 ? 'other' : 'mine', `2026-10-0${1 + (i % 4)} 10:00:${sec}`)
    }
  })()
  const expectIds = (where, order) => f.db.prepare(`SELECT id FROM audit_logs WHERE ${where} ORDER BY ${order}`).all().map(r => r.id)
  const idsOf = async (qs) => {
    const text = await (await f.raw(`/api/meta/audit-logs/export.csv${qs}`, admin)).text()
    return text.replace(/^﻿/, '').trim().split('\r\n').slice(1).map(l => Number(l.slice(1, l.indexOf('"', 1))))
  }
  const byModule = await idsOf('?module=mine')
  assert.deepEqual(byModule, expectIds("module='mine'", 'created_at DESC, id DESC'))
  assert.equal(new Set(byModule).size, byModule.length)
  const byUser = await idsOf('?user=5&from=2026-10-02&to=2026-10-03')
  assert.deepEqual(byUser, expectIds("user_id=5 AND created_at>='2026-10-02 00:00:00' AND created_at<='2026-10-03 23:59:59'", 'created_at DESC, id DESC'))
  const snapshot = f.db.prepare('SELECT MAX(id) m FROM audit_logs').get().m
  const all = await idsOf('')
  // 快照上界：此前两次导出各写了一行 AUDIT_LOG_EXPORT（在快照内），本次导出自己的审计行不在文件里
  assert.deepEqual(all, expectIds(`id <= ${snapshot}`, 'id DESC'), 'unfiltered export keeps id order and stops at the snapshot')
  assert.equal(all.length, 2602)
  // list and export agree on the first page for a time-ordered filter
  const list = (await f.request('/api/meta/audit-logs?module=mine&pageSize=20', admin)).body.data.list.map(r => r.id)
  assert.deepEqual(list, byModule.slice(0, 20))
})

function migrated(t, opts = {}) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.pragma('foreign_keys=ON')
  db.exec(readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'))
  runMigrations(db, { mode: 'test', warn: () => {}, ...opts })
  return db
}
const auditIds = (r) => r.statements.filter(s => s.id.startsWith('audit.')).length

test('AA6 migration 065: idempotent, non-UNIQUE, checksummed, three indexes with the documented columns', (t) => {
  const db = migrated(t)
  assert.equal(m065.verify(db), true)
  const idx = () => db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='audit_logs' ORDER BY name").all()
  const before = idx()
  m065.up(db); m065.up(db)
  assert.deepEqual(idx(), before)
  assert.deepEqual(before.map(i => i.name), ['idx_audit_entity', 'idx_audit_module_created', 'idx_audit_user_created'])
  assert.match(before.find(i => i.name === 'idx_audit_module_created').sql, /\(module, created_at\)/)
  assert.match(before.find(i => i.name === 'idx_audit_user_created').sql, /\(user_id, created_at\)/)
  assert.match(before.find(i => i.name === 'idx_audit_entity').sql, /\(entity, entity_id\)/)
  for (const i of before) assert.doesNotMatch(i.sql, /UNIQUE/i)
  const rows = db.prepare("SELECT checksum FROM schema_migrations WHERE id LIKE '065_%'").all()
  assert.equal(rows.length, 1); assert.match(rows[0].checksum, /^[0-9a-f]{64}$/)
  assert.deepEqual(runMigrations(db, { mode: 'production', warn: () => {} }).applied, [])
})

test('AA6 explain-audit: the filtered audit list / count / export statements are green only with migration 065', (t) => {
  const targets = STATEMENTS.filter(s => s.id.startsWith('audit.'))
  const allow = ALLOW.filter(a => a.statement.startsWith('audit.'))
  assert.ok(targets.length >= 15)
  const withIx = migrated(t)
  const green = auditStatements(withIx, targets, { allow })
  assert.deepEqual(green.violations, [], JSON.stringify(green.violations))
  assert.deepEqual(green.unusedAllow, [])
  const plan = (id) => green.statements.find(s => s.id === id).plan.join(' | ')
  assert.match(plan('audit.list_module'), /idx_audit_module_created \(module=\? AND created_at>\? AND created_at<\?\)/)
  assert.doesNotMatch(plan('audit.list_module'), /TEMP B-TREE/, 'time-ordered filter needs no sort')
  assert.match(plan('audit.export_user'), /idx_audit_user_created/)
  assert.match(plan('audit.list_entity'), /idx_audit_entity \(entity=\? AND entity_id=\?\)/)
  assert.match(plan('audit.count_module'), /COVERING INDEX idx_audit_module_created/)
  assert.doesNotMatch(plan('audit.list_entity_only'), /idx_audit_entity|TEMP B-TREE/, 'entity alone: rowid walk, no index + temp sort')

  const dir = mkd(path.join(tmpdir(), 'os-aa6-mig-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  cpSync(MIGRATIONS_DIR, dir, { recursive: true })
  rm(path.join(dir, '065_audit_log_indexes.cjs'))
  const old = migrated(t, { migrationsDir: dir })
  const red = auditStatements(old, targets, { allow })
  const hit = new Set(red.violations.map(v => `${v.statement}`))
  const needIdx = targets.filter(s => s.expectIndex)
  assert.ok(needIdx.length >= 12)
  for (const { id } of needIdx) assert.ok(hit.has(id), `${id} must be red without 065 (got ${[...hit].join()})`)
  assert.equal(auditIds(red), targets.length)
})

// ---------------------------------------------------------------------------------------------------------------------------
// AB3：迁移 067（FTS5 外部内容表 + 触发器）、FTS / LIKE 双路径、仅 action 过滤必须带 module
// ---------------------------------------------------------------------------------------------------------------------------
const ftsRows = (db, q) => db.prepare('SELECT rowid FROM audit_logs_fts WHERE audit_logs_fts MATCH ? ORDER BY rowid').all(q).map(r => r.rowid)
const auditRow = (db, r) => db.prepare('INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id) VALUES (?,?,?,?,?,?)')
  .run(r.uid ?? 1, r.user ?? 'alice', r.action ?? 'CREATE', r.module ?? 'sales', r.entity ?? 'order', r.eid ?? '1').lastInsertRowid

test('AB3 migration 067: FTS5 external-content table + three triggers, idempotent, checksummed, backfills existing rows', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec(readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'))
  // 迁移之前就存在的行必须被回填
  const dir = mkd(path.join(tmpdir(), 'os-ab3-mig-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  cpSync(MIGRATIONS_DIR, dir, { recursive: true })
  rm(path.join(dir, '067_audit_fts.cjs'))
  runMigrations(db, { mode: 'test', warn: () => {}, migrationsDir: dir })
  const old = auditRow(db, { action: 'LEGACYROW', user: 'zed' })
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='audit_logs_fts'").get(), undefined)
  assert.equal(m067.verify(db), false, 'FTS-capable build without the table is not verified')
  assert.deepEqual(runMigrations(db, { mode: 'test', warn: () => {} }).applied, ['067_audit_fts'])
  assert.equal(m067.verify(db), true)
  assert.deepEqual(ftsRows(db, '"LEGACYROW"'), [Number(old)], 'backfill (rebuild) indexed pre-existing rows')
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='audit_logs_fts'").get().sql, /content\s*=\s*'audit_logs'.*content_rowid\s*=\s*'id'.*trigram/s)
  const names = () => db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_logs' ORDER BY name").all().map(r => r.name)
  assert.deepEqual(names(), ['audit_logs_fts_ad', 'audit_logs_fts_ai', 'audit_logs_fts_au'])
  const before = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'audit_logs_fts%' ORDER BY name").all()
  m067.up(db); m067.up(db)
  assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'audit_logs_fts%' ORDER BY name").all(), before)
  const rows = db.prepare("SELECT checksum FROM schema_migrations WHERE id LIKE '067_%'").all()
  assert.equal(rows.length, 1); assert.match(rows[0].checksum, /^[0-9a-f]{64}$/)
  assert.deepEqual(runMigrations(db, { mode: 'production', warn: () => {} }).applied, [])
})

test('AB3 triggers keep the index exact across insert / update / delete, and survive extra columns (AB6 prev_hash / row_hash)', (t) => {
  const db = migrated(t)
  assert.equal(m067.verify(db), true)
  const a = auditRow(db, { action: 'PRICEUP', user: 'alice', entity: 'sku' })
  const b = auditRow(db, { action: 'PRICEDOWN', user: 'bobby', entity: 'sku' })
  assert.deepEqual(ftsRows(db, '"PRICE"'), [a, b].map(Number))
  assert.deepEqual(ftsRows(db, '"bobby"'), [Number(b)])
  assert.deepEqual(ftsRows(db, '"sku"'), [a, b].map(Number), 'entity column is indexed')
  db.prepare('UPDATE audit_logs SET action=? WHERE id=?').run('RENAMED', a)
  assert.deepEqual(ftsRows(db, '"PRICEUP"'), [], 'old text gone after UPDATE')
  assert.deepEqual(ftsRows(db, '"RENAMED"'), [Number(a)])
  // 其它列的更新不触发 FTS 维护（UPDATE OF 限定）
  db.prepare('UPDATE audit_logs SET detail=?, ip=? WHERE id=?').run('{"x":1}', '1.2.3.4', a)
  assert.deepEqual(ftsRows(db, '"RENAMED"'), [Number(a)])
  db.prepare('DELETE FROM audit_logs WHERE id=?').run(b)
  assert.deepEqual(ftsRows(db, '"bobby"'), [], 'row removed from the index on DELETE')
  // NULL entity / user_name 不会让触发器报错
  db.prepare('INSERT INTO audit_logs (action, module) VALUES (?,?)').run('NULLY', 'm')
  assert.equal(ftsRows(db, '"NULLY"').length, 1)
  // AB6 加列：触发器只引用自己的列；新增列的写入既不报错也不改索引
  // 迁移 068（AB6）已经把这两列加上时跳过（两个工作流合并后两者并存）；否则在这里模拟加列
  const cols = new Set(db.prepare('PRAGMA table_info(audit_logs)').all().map(c => c.name))
  if (!cols.has('prev_hash')) db.exec('ALTER TABLE audit_logs ADD COLUMN prev_hash TEXT')
  if (!cols.has('row_hash')) db.exec('ALTER TABLE audit_logs ADD COLUMN row_hash TEXT')
  const c = db.prepare('INSERT INTO audit_logs (action, module, entity, user_name, prev_hash, row_hash) VALUES (?,?,?,?,?,?)').run('HASHED', 'm', 'e', 'carol', 'p', 'r').lastInsertRowid
  db.prepare('UPDATE audit_logs SET row_hash=? WHERE id=?').run('r2', c)
  assert.deepEqual(ftsRows(db, '"HASHED"'), [Number(c)])
  assert.equal(db.prepare("INSERT INTO audit_logs_fts(audit_logs_fts) VALUES('integrity-check')").run().changes >= 0, true, 'index is consistent with the content table')
  assert.equal(m067.verify(db), true)
})

test('AB3 an UPDATE of the content rowid (id) re-indexes the row; external-content integrity-check passes', (t) => {
  const db = migrated(t)
  const id = auditRow(db, { action: 'MOVEDROW' })
  db.prepare('UPDATE audit_logs SET id=? WHERE id=?').run(900001, id)
  assert.deepEqual(ftsRows(db, '"MOVEDROW"'), [900001])
  db.prepare("INSERT INTO audit_logs_fts(audit_logs_fts, rank) VALUES('integrity-check', 1)").run() // 外部内容表的完整性校验：索引与内容表逐行一致，否则抛错
})

test('AB3 verify() notices a dropped trigger / table and the runner heals it (and re-indexes missed rows)', (t) => {
  const db = migrated(t)
  db.exec('DROP TRIGGER audit_logs_fts_ai')
  assert.equal(m067.verify(db), false)
  const missed = auditRow(db, { action: 'MISSEDWHILEDOWN' })
  assert.deepEqual(ftsRows(db, '"MISSEDWHILEDOWN"'), [])
  const r = runMigrations(db, { mode: 'test', warn: () => {} })
  // 068（AB6 哈希链）的 verify 会把裸 INSERT 留下的未接链尾行一并自愈，所以这里只断言 067 被自愈
  assert.ok(r.healed.includes('067_audit_fts'), `healed: ${r.healed.join(',')}`)
  assert.equal(m067.verify(db), true)
  assert.deepEqual(ftsRows(db, '"MISSEDWHILEDOWN"'), [Number(missed)], 'heal rebuilds the index')
})

test('AB3 migration 067 on a build without FTS5: up() is a no-op, verify() is true, nothing is created', () => {
  const calls = []
  const noFts = {
    pragma: (q) => { calls.push(q); return [{ compile_options: 'ENABLE_FTS3' }] },
    exec: (q) => { calls.push(q); throw new Error('must not create anything') },
    prepare: (q) => { calls.push(q); throw new Error('must not query') }
  }
  assert.doesNotThrow(() => m067.up(noFts))
  assert.equal(m067.verify(noFts), true)
  assert.ok(calls.every(c => /compile_options/.test(c)))
  assert.equal(m067.ftsSupported(noFts), false)
  // trigram 不可用（老 SQLite）同样退化为 no-op
  const noTrigram = { pragma: () => [{ compile_options: 'ENABLE_FTS5' }], exec: () => { throw new Error('no such tokenizer: trigram') }, prepare: () => { throw new Error('unreachable') } }
  assert.doesNotThrow(() => m067.up(noTrigram)); assert.equal(m067.verify(noTrigram), true)
})

test('AB3 buildWhere: FTS only for >=3-char keywords when available; phrase-quoted, parameterised; LIKE otherwise', () => {
  const f = (keyword) => parseFilters({ keyword })
  let w = buildWhere(f('订单审'), { fts: true })
  assert.match(w.where, /id IN \(SELECT rowid FROM audit_logs_fts WHERE audit_logs_fts MATCH \?\)/)
  assert.match(w.where, /LIKE/, 'candidates are re-checked with the same LIKE predicate (Unicode case folding differs)')
  assert.deepEqual(w.args, ['"订单审"', '%订单审%', '%订单审%', '%订单审%'])
  w = buildWhere(f('订单'), { fts: true })
  assert.match(w.where, /LIKE/, 'two characters: trigram cannot match, LIKE path'); assert.doesNotMatch(w.where, /audit_logs_fts/)
  w = buildWhere(f('abcdef'), { fts: false })
  assert.match(w.where, /LIKE/); assert.doesNotMatch(w.where, /audit_logs_fts/)
  assert.match(buildWhere(f('abcdef')).where, /LIKE/, 'default is the LIKE path')
  // FTS 语法一律是字面量：引号加倍、不抛错
  assert.equal(buildWhere(f('a"b OR c'), { fts: true }).args[0], '"a""b OR c"')
  assert.doesNotMatch(buildWhere(f('abc" OR 1=1 --'), { fts: true }).where, /OR 1=1/, 'keyword never reaches the SQL text')
  assert.equal(buildWhere({ keyword: 'abc', module: 'x' }, { fts: true }).args.length, 5)
})

test('AB3 FTS and LIKE paths return identical rows (injection-shaped, wildcard, CJK, mixed-case keywords)', needsFts, (t) => {
  const db = migrated(t)
  assert.equal(ftsAvailable(db), true)
  const corpus = [['ÄBC', 'École', 'Straße'], ['CREATE', 'sales_orders', 'alice'], ['DEL100%_done', 'order', 'alice'], ['approve OR reject', 'po', 'bob'], ['审批通过', '销售订单', '张三'],
    ['导出', '审计日志', '张三丰'], ['a"b', 'NEAR(x y)', 'col:action'], ['LOGIN', '*', 'user-1'], ['x AND y', 'e', 'u'], ['Create', 'Sales_Orders', 'ALICE'], ['100%', 'a_b', 'axb']]
  for (const [action, entity, user] of corpus) auditRow(db, { action, entity, user })
  const ids = (keyword, fts) => {
    const { where, args } = buildWhere(parseFilters({ keyword }), { fts })
    return db.prepare(`SELECT id FROM audit_logs ${where} ORDER BY id`).all(...args).map(r => r.id)
  }
  const probes = ['äbc', 'ÄBC', 'éco', 'École', 'straSSe', 'Straße', 'CREATE', 'create', 'sales_orders', 'Sales', 'ali', 'alice', '100%', '%_d', 'DEL100', 'a_b', 'axb', 'OR re', 'approve OR', 'x AND y', '审批通', '销售订单', '张三', '张三丰', '审计日志',
    'a"b', '"b', 'NEAR(x', 'NEAR(x y)', 'col:ac', 'action:', '*', 'user-1', 'ser-', 'abc*', '^CRE', 'zzz', "'; DROP TABLE audit_logs;--", 'a OR b OR c', '(((', ')))', '-CRE', 'NOT x']
  for (const k of probes) {
    let like; try { like = ids(k, false) } catch (e) { assert.ok(e instanceof AuditViewError, k); continue }
    assert.deepEqual(ids(k, true), like, `FTS must equal LIKE for ${JSON.stringify(k)}`)
  }
  assert.ok(ids('审批通', true).length === 1 && ids('CREATE', true).length === 2 && ids('100%', true).length >= 1)
  assert.ok(db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c >= corpus.length, 'table survived the DROP TABLE probe')
})

test('AB3 setFtsOverride(false) simulates a build without FTS5', needsFts, (t) => {
  const db = migrated(t)
  assert.equal(ftsAvailable(db), true)
  setFtsOverride(false)
  t.after(() => setFtsOverride(null))
  assert.equal(ftsAvailable(db), false)
  setFtsOverride(null)
  assert.equal(ftsAvailable(db), true)
  const bare = new Database(':memory:'); t.after(() => bare.close())
  assert.equal(ftsAvailable(bare), false, 'no audit_logs_fts table: fallback')
})

test('AB3 keywordUsesFts: FTS only for rare hits; common keywords, short keywords and no-FTS builds use LIKE', needsFts, (t) => {
  const db = migrated(t)
  db.transaction(() => { for (let i = 0; i < FTS_RARE_MAX + 100; i++) auditRow(db, { action: 'COMMONACT', user: `u${i}` }) })()
  auditRow(db, { action: 'RAREACT' })
  assert.equal(keywordUsesFts(db, 'RAREACT'), true)
  assert.equal(keywordUsesFts(db, 'zzabsent'), true, 'no hits is the best case for FTS')
  assert.equal(keywordUsesFts(db, 'COMMONACT'), false, 'more than FTS_RARE_MAX hits: LIKE walks the index and stops at one page')
  assert.equal(keywordUsesFts(db, 'ra'), false, 'two characters: trigram cannot match')
  assert.equal(keywordUsesFts(db, undefined), false)
  // 两条路径结果相同（只是读量不同）
  for (const k of ['COMMONACT', 'RAREACT', 'zzabsent']) {
    const run = (fts) => { const w = buildWhere({ keyword: k }, { fts }); return db.prepare(`SELECT COUNT(*) c FROM audit_logs ${w.where}`).get(...w.args).c }
    assert.equal(run(true), run(false), k)
  }
  setFtsOverride(false); t.after(() => setFtsOverride(null))
  assert.equal(keywordUsesFts(db, 'RAREACT'), false, 'flagged off: LIKE')
})

test('AB3 action-only filter needs a module: unit + bizcode over HTTP (list and export), module+action still works', { timeout: 90000 }, async t => {
  assert.throws(() => parseFilters({ action: 'CREATE' }), (e) => e instanceof AuditViewError && e.code === AUDIT_ACTION_NEEDS_MODULE && e.status === 400)
  assert.throws(() => buildWhere({ action: 'CREATE' }), (e) => e.code === AUDIT_ACTION_NEEDS_MODULE, 'buildWhere enforces it on its own')
  assert.throws(() => parseFilters({ action: 'CREATE', user: '12' }), AuditViewError, 'a user id is not a module')
  assert.deepEqual(parseFilters({ module: 'sales', action: 'CREATE' }), { module: 'sales', action: 'CREATE' })
  const f = await fixture(t)
  const admin = await f.login('ab3_admin', 'admin', { isSuper: 1 })
  f.db.exec('DELETE FROM audit_logs')
  ins(f.db, { action: 'APPROVE', module: 'purchase' }); ins(f.db, { action: 'APPROVE', module: 'sales' })
  const bad = await f.request('/api/meta/audit-logs?action=APPROVE', admin)
  assert.equal(bad.status, 400)
  assert.equal(bad.body.success, false); assert.equal(bad.body.error, AUDIT_ACTION_NEEDS_MODULE); assert.equal(bad.body.detail.code, AUDIT_ACTION_NEEDS_MODULE)
  assert.equal(bad.body.code, 1, 'bizFail shape: numeric top-level code 1')
  assert.match(bad.body.message, /module/)
  const exp = await f.raw('/api/meta/audit-logs/export.csv?action=APPROVE', admin)
  assert.equal(exp.status, 400); assert.equal((await exp.json()).error, AUDIT_ACTION_NEEDS_MODULE)
  assert.equal(f.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='AUDIT_LOG_EXPORT'").get().c, 0, 'refused export leaves no audit row')
  assert.equal((await f.request('/api/meta/audit-logs?module=sales&action=APPROVE', admin)).body.data.total, 1)
  assert.equal((await f.request('/api/meta/audit-logs?module=sales', admin)).body.data.total, 1)
})

test('AB3 over HTTP: FTS path answers keyword searches (3+ and 2 chars); dropping the FTS objects falls back to LIKE with identical answers', { timeout: 90000 }, async t => {
  const f = await fixture(t)
  const admin = await f.login('ab3_http', 'admin', { isSuper: 1 })
  assert.equal(ftsAvailable(f.db), !NOFTS, 'server migrated to 067 (the FTS path is switched off by GML_AUDIT_FTS=0)')
  f.db.exec('DELETE FROM audit_logs')
  ins(f.db, { user: 'alice', action: 'CREATE', module: 'sales', entity: '销售订单', eid: 'zzeid', detail: '{"note":"zzdetail"}' })
  ins(f.db, { user: '张三丰', action: 'DEL100%_done', module: 'sales', entity: 'order' })
  ins(f.db, { user: 'bob', action: 'APPROVE', module: 'purchase', entity: 'po' })
  const probes = { 'alice': 1, 'CREAT': 1, '销售订单': 1, '销售': 1, '张三': 1, '100%': 1, '%_d': 1, 'approve': 1, 'zzeid': 0, 'zzdetail': 0, '" OR 1=1': 0, 'NEAR(': 0, 'al*': 0 }
  const run = async () => {
    const out = {}
    for (const k of Object.keys(probes)) out[k] = (await f.request(`/api/meta/audit-logs?keyword=${encodeURIComponent(k)}`, admin)).body.data.total
    out['alice+module'] = (await f.request('/api/meta/audit-logs?keyword=alice&module=purchase', admin)).body.data.total
    out['csv'] = (await (await f.raw('/api/meta/audit-logs/export.csv?keyword=alice', admin)).text()).trim().split('\r\n').length - 1
    return out
  }
  const viaFts = await run()
  for (const [k, n] of Object.entries(probes)) assert.equal(viaFts[k], n, `fts ${k}`)
  assert.equal(viaFts['alice+module'], 0); assert.equal(viaFts.csv, 1)
  f.db.exec('DROP TRIGGER audit_logs_fts_ai; DROP TRIGGER audit_logs_fts_ad; DROP TRIGGER audit_logs_fts_au; DROP TABLE audit_logs_fts')
  assert.equal(ftsAvailable(f.db), false)
  assert.deepEqual(await run(), viaFts, 'LIKE fallback answers identically')
})

test('AB3 explain-audit on a database without audit_logs_fts: FTS-only statements are skipped, LIKE fallback statements still audited, no error', (t) => {
  const dir = mkd(path.join(tmpdir(), 'os-ab3-nofts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  cpSync(MIGRATIONS_DIR, dir, { recursive: true })
  rm(path.join(dir, '067_audit_fts.cjs'))
  const db = migrated(t, { migrationsDir: dir })
  assert.equal(ftsAvailable(db), false)
  const targets = STATEMENTS.filter(s => s.id.startsWith('audit.'))
  const allow = ALLOW.filter(a => a.statement.startsWith('audit.'))
  const r = auditStatements(db, targets, { allow })
  assert.deepEqual(r.violations, [], JSON.stringify(r.violations)); assert.deepEqual(r.unusedAllow, [])
  const skipped = r.statements.filter(s => s.skipped).map(s => s.id)
  assert.ok(skipped.includes('audit.list_keyword_fts') && skipped.includes('audit.count_module_keyword_fts'), skipped.join())
  assert.ok(skipped.every(id => /_fts$/.test(id)))
  assert.ok(r.statements.find(s => s.id === 'audit.count_keyword_nofts').plan.length > 0, 'fallback statement is really audited')
})

test('AB3 explain-audit: FTS keyword statements are green and use the FTS table; LIKE fallback statements carry an exemption with a reason', (t) => {
  const db = migrated(t)
  const targets = STATEMENTS.filter(s => s.id.startsWith('audit.'))
  const allow = ALLOW.filter(a => a.statement.startsWith('audit.'))
  const r = auditStatements(db, targets, { allow })
  assert.deepEqual(r.violations, [], JSON.stringify(r.violations)); assert.deepEqual(r.unusedAllow, [])
  const plan = (id) => r.statements.find(s => s.id === id).plan.join(' | ')
  for (const id of ['audit.list_keyword_fts', 'audit.count_keyword_fts', 'audit.export_keyword_fts', 'audit.list_module_keyword_fts'])
    assert.match(plan(id), /audit_logs_fts VIRTUAL TABLE INDEX/, id)
  const fallbacks = allow.filter(a => /_nofts$|^audit\.(list|count)_keyword$/.test(a.statement))
  assert.ok(fallbacks.length >= 3)
  for (const a of fallbacks) assert.ok(a.reason.length > 20, a.statement)
  assert.ok(allow.some(a => a.statement === 'audit.count_keyword_nofts' && /FTS5/.test(a.reason)))
})

// ---------------------------------------------------------------------------------------------------------------------------
// AC5：GML_AUDIT_FTS=0 环境开关（真实无 FTS 路径；CI 的 checks job 以该开关再跑一遍本文件）
// ---------------------------------------------------------------------------------------------------------------------------
test('AC5 GML_AUDIT_FTS=0 forces the LIKE path: only the exact string "0" switches FTS off, read on every call', (t) => {
  const prev = process.env.GML_AUDIT_FTS
  t.after(() => { if (prev === undefined) delete process.env.GML_AUDIT_FTS; else process.env.GML_AUDIT_FTS = prev })
  const db = migrated(t)
  auditRow(db, { action: 'RAREACT' })
  const set = (v) => { if (v === undefined) delete process.env.GML_AUDIT_FTS; else process.env.GML_AUDIT_FTS = v }
  for (const v of [undefined, '', '1', 'false', 'off', ' 0', '00']) {
    set(v)
    assert.equal(ftsEnvDisabled(), false, `${JSON.stringify(v)} does not switch FTS off`)
    assert.equal(ftsAvailable(db), true, JSON.stringify(v))
    assert.equal(keywordUsesFts(db, 'RAREACT'), true, JSON.stringify(v))
  }
  set('0')
  assert.equal(ftsEnvDisabled(), true)
  assert.equal(ftsAvailable(db), false, 'the table exists, but the switch forces the fallback')
  assert.equal(keywordUsesFts(db, 'RAREACT'), false); assert.equal(keywordUsesFts(db, 'zzabsent'), false)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='audit_logs_fts'").get().c, 1, 'the switch changes the query path only; the index is untouched')
  // 开关随时可撤销，且不依赖 setFtsOverride 的状态
  set(undefined)
  assert.equal(keywordUsesFts(db, 'RAREACT'), true)
  setFtsOverride(false); t.after(() => setFtsOverride(null))
  assert.equal(ftsAvailable(db), false); setFtsOverride(null)
  assert.equal(ftsAvailable(db), true)
})

test('AC5 over HTTP: a server started with GML_AUDIT_FTS=0 answers from the base table, not the FTS index (a row the index never saw is found)', { timeout: 90000 }, async t => {
  const prev = process.env.GML_AUDIT_FTS
  t.after(() => { if (prev === undefined) delete process.env.GML_AUDIT_FTS; else process.env.GML_AUDIT_FTS = prev })
  delete process.env.GML_AUDIT_FTS // 本进程里 FTS 可用；子进程显式带 0
  const f = await fixture(t, { GML_AUDIT_FTS: '0' })
  const admin = await f.login('ac5_http', 'admin', { isSuper: 1 })
  f.db.exec('DELETE FROM audit_logs')
  f.db.exec('DROP TRIGGER audit_logs_fts_ai') // 之后写入的行不进索引：只有 LIKE 路径看得见
  ins(f.db, { user: 'alice', action: 'GHOSTACTION', module: 'sales' })
  assert.equal(ftsAvailable(f.db), true)
  const viaIndex = buildWhere(parseFilters({ keyword: 'GHOSTACTION' }), { fts: true })
  assert.equal(f.db.prepare(`SELECT COUNT(*) c FROM audit_logs ${viaIndex.where}`).get(...viaIndex.args).c, 0, 'control: the FTS index really misses the row')
  const r = await f.request('/api/meta/audit-logs?keyword=GHOSTACTION', admin)
  assert.equal(r.body.data.total, 1, 'server with GML_AUDIT_FTS=0 uses LIKE')
  const csv = await (await f.raw('/api/meta/audit-logs/export.csv?keyword=GHOSTACTION', admin)).text()
  assert.equal(csv.trim().split('\r\n').length - 1, 1, 'export uses LIKE too')
})
