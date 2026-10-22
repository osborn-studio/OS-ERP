/**
 * ============================================================================
 * 文件标识：scripts/test-audit-fixes.mjs | 审查缺陷回归：权限旁路、盘盈计价、历史班次
 * 【职责】在隔离库上验证授权正反例、REST/MCP/POS盘盈一致性；全新启动也必须成功。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { stopAndReport } from './lib/reap.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = path.resolve(process.env.GML_DATA_DIR || `/tmp/gml-audit-fixes-${process.pid}`)
assert(data.startsWith('/tmp/') && data !== path.join(ROOT, 'data'), 'Only disposable /tmp data is allowed')
process.env.GML_DATA_DIR = data
const listener = net.createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
})
let output = ''
srv.stdout.on('data', b => { output += b })
srv.stderr.on('data', b => { output += b })
const base = `http://127.0.0.1:${port}`
let passed = 0
function verify(name, condition) {
  assert(condition, name)
  passed++
  console.log(`  ✓ ${name}`)
}
async function request(url, token, body) {
  const res = await fetch(base + url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}
async function login(username, industry) {
  const res = await request('/api/auth/login', null, { username, password: username === 'admin' ? '12345' : '123456', industry })
  verify(`${industry}/${username} login`, res.status === 200)
  return res.body.data.token
}
try {
  for (let i = 0; i < 300 && !output.includes('服务已启动') && srv.exitCode === null; i++) await delay(100)
  assert(output.includes('服务已启动'), `Fresh startup failed: ${output.slice(-1800)}`)
  verify('server initialized and listened', true)
  const { getDbFor } = await import('../server/db/index.js')
  const stock = await import('../server/lib/stock.js')
  const { TOOL_MAP } = await import('../server/mcp/tools.js')
  const pos = await import('../server/lib/pos2.js')
  for (const industry of ['cosmetic', 'food']) {
    const admin = await login('admin', industry)
    const finance = await login('finance', industry)
    for (const url of ['/api/accounting/vouchers', '/api/accounting/trial-balance']) {
      verify(`${industry} admin can read ${url}`, (await request(url, admin)).status === 200)
      verify(`${industry} finance can read ${url}`, (await request(url, finance)).status === 200)
      verify(`${industry} unauthenticated denied ${url}`, (await request(url)).status === 401)
    }
    verify(`${industry} authorized AI query`, (await request('/api/ai/query', admin, { intent: 'sales_summary' })).status === 200)
    for (const username of ['store01', 'dealer01', 'sales']) {
      const token = await login(username, industry)
      for (const url of ['/api/accounting/vouchers', '/api/accounting/trial-balance', '/api/ai/schema', '/api/ai/logs']) {
        verify(`${industry}/${username} denied ${url}`, (await request(url, token)).status === 403)
      }
      verify(`${industry}/${username} denied global AI query`, (await request('/api/ai/query', token, { intent: 'sales_summary' })).status === 403)
    }
    const db = getDbFor(industry)
    const fin = db.prepare("SELECT * FROM users WHERE username='finance'").get()
    try {
      db.prepare("UPDATE users SET data_scope='org' WHERE id=?").run(fin.id)
      verify(`${industry} financial permission alone cannot bypass restricted scope`,
        (await request('/api/accounting/vouchers', finance)).status === 403)
    } finally { db.prepare('UPDATE users SET data_scope=? WHERE id=?').run(fin.data_scope, fin.id) }

    const row = db.prepare(`SELECT s.* FROM inventory_stocks s JOIN warehouses w ON w.id=s.warehouse_id
      WHERE s.qty_on_hand>0 AND s.cost_price>0 AND s.owner_org_id=w.default_owner_org_id AND s.currency=w.currency LIMIT 1`).get()
    db.exec('BEGIN')
    try {
      const result = TOOL_MAP.get('inventory.adjust').handler({ db,
        args: { warehouse_id: row.warehouse_id, sku_id: row.sku_id, batch_no: row.batch_no, delta: row.qty_on_hand, reason: 'audit regression' },
        ctx: { scope: { scope: 'all' }, engine: stock, tokenName: 'audit regression' } })
      const after = db.prepare('SELECT * FROM inventory_stocks WHERE id=?').get(row.id)
      verify(`${industry} MCP gain preserves unit cost`, Math.abs(after.cost_price - row.cost_price) < 0.001)
      verify(`${industry} MCP gain increases value`, Math.abs(after.cost_amount - (row.cost_amount + row.qty_on_hand * row.cost_price)) < 0.01)
      verify(`${industry} MCP reports costing source`, result.data.result.costSource === 'current_avg')
      const empty = stock.applyStockGain(db, { warehouseId: row.warehouse_id, skuId: row.sku_id, batchNo: `AUDIT-${process.pid}`, qty: 1, docType: 'ADJ_IN', docNo: `AUDIT-NEW-${process.pid}` })
      verify(`${industry} new dimension explicitly reports zero cost`, empty.costSource === 'new_row_zero_cost' && empty.gainUnitCost === 0)
    } finally { db.exec('ROLLBACK') }

    const user = db.prepare("SELECT * FROM users WHERE username='store01'").get()
    const req = { user: { uid: user.id, name: user.name, role: user.role }, ip: '127.0.0.1' }
    const storeWh = db.prepare("SELECT id FROM warehouses WHERE store_id=? AND type='store' LIMIT 1").get(user.store_id)
    const sr = db.prepare('SELECT * FROM inventory_stocks WHERE warehouse_id=? AND qty_on_hand>0 AND cost_price>0 LIMIT 1').get(storeWh.id)
    db.exec('BEGIN')
    try {
      const check = pos.createStoreCheck(db, req, { storeId: user.store_id, skuIds: [sr.sku_id], remark: 'audit regression' })
      const item = db.prepare('SELECT * FROM stock_check_items WHERE check_id=? AND batch_no=?').get(check.id, sr.batch_no)
      pos.submitStoreCheckItems(db, req, { checkId: check.id, items: [{ id: item.id, actual_qty: item.book_qty + 2, reason: 'audit gain' }] })
      pos.adjustStoreCheck(db, req, { checkId: check.id })
      const after = db.prepare('SELECT * FROM inventory_stocks WHERE id=?').get(sr.id)
      verify(`${industry} POS gain preserves unit cost`, Math.abs(after.cost_price - sr.cost_price) < 0.001)
    } finally { db.exec('ROLLBACK') }
    const storeToken = await login('store01', industry)
    const active = db.prepare("SELECT id,biz_date FROM pos_shifts WHERE store_id=? AND status='open' AND (cashier_id IS ? OR cashier_name=?)").all(user.store_id, user.id, user.name)
    assert(active.length, 'Seed must provide an active cashier shift for the negative test')
    try {
      for (const shift of active) db.prepare("UPDATE pos_shifts SET biz_date='2000-01-01' WHERE id=?").run(shift.id)
      const before = db.prepare('SELECT COUNT(*) n FROM pos_orders').get().n
      const res = await request('/api/pos/orders', storeToken, { items: [{ sku_id: sr.sku_id, qty: 1 }], pay_method: 'cash' })
      verify(`${industry} implicit current-day checkout refuses old shift`, res.status === 409)
      verify(`${industry} refusal leaves no order`, db.prepare('SELECT COUNT(*) n FROM pos_orders').get().n === before)
    } finally {
      for (const shift of active) db.prepare('UPDATE pos_shifts SET biz_date=? WHERE id=?').run(shift.biz_date, shift.id)
    }
  }
  console.log(`通过 ${passed} / 失败 0`)
} finally {
  await stopAndReport(srv)
}
