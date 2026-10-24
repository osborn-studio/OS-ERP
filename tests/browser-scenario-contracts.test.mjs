/**
 * ============================================================================
 * 文件标识：tests/browser-scenario-contracts.test.mjs ｜ AA8 浏览器场景的数据期望合同测试
 * ============================================================================
 * 本机（macOS）不能运行 Linux Chromium，所以 tests/browser/{my-scope,audit-logs,inventory-paging}.mjs 没有被执行过。
 * 这里对 test 模式服务跑场景用的同一批接口调用（tests/browser/scenario-data.mjs），证明场景依赖的数据期望成立：
 *   · my-scope：org 范围账号的范围/组织名/解释，admin 的"全部"；
 *   · audit-logs：按模块过滤的列表、CSV 导出（表头、行与过滤一致、不含导出自己的审计行）、导出审计行（过滤条件与行数）、无权限账号 403；
 *   · inventory-paging：65 行造数、游标逐页并集 = 全集且各 id 恰一次、total/summary 只在第一页、末页 has_more=false。
 * 不证明：选择器与页面渲染（那是托管 CI 里 Chromium 的事）。
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
import {
  AUDIT_CSV_HEADER, assertExactlyOnce, auditIds, csvRecords, exportAuditRows, fetchAuditCsv, expectAdminScope, expectOrgScoped,
  parseCsv, pickLeafOrg, prepareAuditModule, seedStockRows, walkStocks
} from './browser/scenario-data.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const secret = () => randomBytes(24).toString('base64url')

async function server(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-scenario-contracts-'))
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port),
    GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex')
  }
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const stopped = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    await stopped
    rmSync(dir, { recursive: true, force: true })
  })
  for (let i = 0; i < 2400 && !output.includes('服务已启动') && child.exitCode === null; i++) await delay(50)
  assert.ok(output.includes('服务已启动'), `test-mode server must become ready:\n${output.slice(-2000)}`)
  const base = `http://127.0.0.1:${port}`
  const api = async (route, { token, body, method = body === undefined ? 'GET' : 'POST' } = {}) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000)
    })
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* csv */ }
    return { status: res.status, body: parsed, text, headers: res.headers }
  }
  const login = async (username, password) => {
    const r = await api('/api/auth/login', { body: { username, password, industry: 'cosmetic' } })
    assert.equal(r.status, 200)
    return r.body.data.token
  }
  const admin = await login('admin', '12345')
  const account = async (prefix, role, extra = {}) => {
    const username = `${prefix}_${randomBytes(4).toString('hex')}`
    const password = secret()
    const r = await api('/api/auth/users', { token: admin, body: { username, name: username, role, password, ...extra } })
    assert.equal(r.status, 200)
    return { username, token: await login(username, password) }
  }
  return { api, base, admin, account }
}

test('AA8 scenario data contracts hold against a test-mode server', { timeout: 600000 }, async (t) => {
  const f = await server(t)
  const { api, admin } = f

  await t.test('my-scope: org-scoped user sees exactly their org; admin sees all', async () => {
    const org = await pickLeafOrg(api, admin)
    const user = await f.account('aa8_scope', 'purchase', { org_id: org.id, data_scope: 'org' })
    const d = (await api('/api/auth/my-scope', { token: user.token })).body.data
    expectOrgScoped(d, org)
    expectAdminScope((await api('/api/auth/my-scope', { token: admin })).body.data)
  })

  await t.test('audit-logs: module filter, CSV export and its audit row, forbidden for non-admin', async () => {
    const prep = await prepareAuditModule(api, admin)
    const before = await exportAuditRows(api, admin)
    assert.equal(before.total, 0)

    const q = `module=${prep.module}`
    const list = await api(`/api/meta/audit-logs?${q}&page=1&pageSize=50`, { token: admin })
    assert.equal(list.body.data.total, prep.filteredTotal)

    const csv = await api(`/api/meta/audit-logs/export.csv?${q}`, { token: admin })
    assert.equal(csv.status, 200)
    assert.match(csv.headers.get('content-type'), /^text\/csv/)
    assert.match(csv.headers.get('content-disposition'), /^attachment; filename="audit-logs-\d+\.csv"$/)
    assert.equal(csv.headers.get('x-export-truncated'), '0')
    const { header, records } = csvRecords(csv.text)
    assert.deepEqual(header, AUDIT_CSV_HEADER)
    assert.equal(records.length, prep.filteredTotal)
    assert.ok(records.every((r) => r.module === prep.module))
    assert.ok(!records.some((r) => r.action === 'AUDIT_LOG_EXPORT'), 'the export row itself is outside the snapshot')
    assert.equal(parseCsv('﻿"a","b""c"\r\n"d","e\r\nf"\r\n').length, 2)

    const after = await exportAuditRows(api, admin)
    assert.equal(after.total, before.total + 1)
    const row = after.list[0]
    assert.equal(row.action, 'AUDIT_LOG_EXPORT')
    const detail = JSON.parse(row.detail)
    assert.equal(detail.filters.module, prep.module)
    assert.equal(detail.rows, records.length)
    assert.equal(detail.truncated, false)

    const expected = await auditIds(api, admin, { module: prep.module })
    assert.deepEqual(records.map((r) => Number(r.id)).sort((a, b) => a - b), [...expected.ids].sort((a, b) => a - b))
    const second = await fetchAuditCsv(f.base, admin, 'module=audit&action=AUDIT_LOG_EXPORT')
    assert.equal(second.status, 200)
    assert.equal(second.records.length, after.total, 'a second export holds the first export row but not its own')
    assert.ok(second.records.some((r) => r.id === String(row.id)))

    const plain = await f.account('aa8_audit_plain', 'purchase', {})
    assert.equal((await api('/api/meta/audit-logs?page=1&pageSize=50', { token: plain.token })).status, 403)
    assert.equal((await api(`/api/meta/audit-logs/export.csv?${q}`, { token: plain.token })).status, 403)
    assert.equal((await exportAuditRows(api, admin)).total, after.total + 1, 'a refused export must not leave an export audit row')
  })

  await t.test('inventory paging: 65 seeded rows, cursor walk returns each row exactly once', async () => {
    const seeded = await seedStockRows(api, admin, 65)
    for (const pageSize of [50, 20]) {
      const walk = await walkStocks(api, admin, seeded.prefix, pageSize)
      assertExactlyOnce(walk, 65)
      assert.equal(walk.pages.length, Math.ceil(65 / pageSize))
      assert.deepEqual(walk.pages.flatMap((p) => p.batches).sort(), [...seeded.batches])
      assert.equal(walk.pages.at(-1).hasMore, false)
      assert.equal(walk.pages.at(-1).next, null)
    }
    // 回到第一页（"上一页"在客户端就是丢掉游标重新请求）得到与第一次相同的行
    const again = await walkStocks(api, admin, seeded.prefix, 50)
    const first = await walkStocks(api, admin, seeded.prefix, 50)
    assert.deepEqual(again.pages[0].ids, first.pages[0].ids)
  })
})
