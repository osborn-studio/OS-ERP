import test from 'node:test'
import { REBUILD_STATE_DDL, REBUILD_STATE_TABLE } from '../server/lib/audit-fts-state.js'
import { insertAuditRow } from '../server/lib/audit-trail.js'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { collect } from '../scripts/lib/privacy-common.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const PHONE = '13812345678'
const OTHER = '13987654321'
const envFor = (dir, extra = {}) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: 'b'.repeat(48), ...extra })
const run = (script, dir, args = [], extra = {}) => spawnSync(process.execPath, [script, ...args], { cwd: ROOT, env: envFor(dir, extra), encoding: 'utf8', timeout: 60000 })
const open = (dir) => new Database(path.join(dir, 'gml_cosmetic.db'))

test('E02 privacy CLI refuses audit rewrites during a rebuild without partially erasing the subject', (t) => {
  const { dir, cid } = fixture(t); const db = open(dir); t.after(() => db.close())
  insertAuditRow(db, { action: 'READ', entity: 'mall_customers', entityId: cid, detail: { phone: PHONE, name: '张三' } })
  assert.equal(collect(db, PHONE).audit_logs.length, 1, 'fixture must select the linked audit row for erasure')
  const snapshot = () => ['mall_customers', 'oms_orders', 'audit_logs'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
  const before = snapshot(); db.exec(REBUILD_STATE_DDL)
  const r = run('scripts/privacy-erase.mjs', dir, [PHONE, '--confirm', '--actor', 'boss'])
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout + r.stderr, /ERASE_FAILED 审计 FTS 分批重建未完成/) // CLI wraps non-Refusal errors; helper tests assert the internal code
  assert.deepEqual(snapshot(), before)
  db.exec(`DROP TABLE ${REBUILD_STATE_TABLE}`) // empty synthetic marker, no partial index to repair
  const retry = run('scripts/privacy-erase.mjs', dir, [PHONE, '--confirm', '--actor', 'boss'])
  assert.equal(retry.status, 0, retry.stdout + retry.stderr)
})

function fixture(t, { openOrder = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-x9-priv-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const init = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const {initSchemaFor}=await import('./server/db/index.js');initSchemaFor('cosmetic')"], { cwd: ROOT, env: envFor(dir), encoding: 'utf8', timeout: 120000 })
  assert.equal(init.status, 0, init.stderr)
  const db = open(dir)
  db.pragma('foreign_keys = OFF') // 种子行不建商品 / 门店主数据；完整性用前后 foreign_key_check 对比
  db.prepare("INSERT INTO users (username,password_hash,name,role,status) VALUES ('boss','hash-secret','Boss','admin','active')").run()
  db.prepare("INSERT INTO users (username,password_hash,name,role,status) VALUES ('clerk','hash-secret','Clerk','sales','active')").run()
  const pf = db.prepare("INSERT INTO platforms (code,platform_code,name,type,status) VALUES ('H5','h5','商城','self','active')").run().lastInsertRowid
  const cid = db.prepare('INSERT INTO mall_customers (phone,name,points,total_orders,total_amount) VALUES (?,?,?,?,?)').run(PHONE, '张三', 120, 2, 300.5).lastInsertRowid
  db.prepare('INSERT INTO mall_customers (phone,name) VALUES (?,?)').run(OTHER, '李四')
  db.prepare('INSERT INTO mall_cart_items (phone,sku_id,qty) VALUES (?,?,?)').run(PHONE, 1, 2)
  const ins = db.prepare(`INSERT INTO oms_orders (platform_id,platform_order_no,buyer_nick,status,goods_amount,freight,pay_amount,receiver,receiver_phone,receiver_address,remark)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  ins.run(pf, 'H5-1', `会员${PHONE}`, 'completed', 100, 0, 100, '张三', PHONE, '上海市浦东新区某路1号', 'ok token=abc123')
  ins.run(pf, 'H5-2', `会员${PHONE}`, openOrder ? 'pending' : 'completed', 200.5, 0, 200.5, '张三妈', '13500000000', '北京市朝阳区某街2号', null)
  ins.run(pf, 'H5-3', `会员${OTHER}`, 'completed', 50, 0, 50, '李四', OTHER, '广州市天河区某路3号', null)
  const so = db.prepare("INSERT INTO sales_orders (doc_no,order_date,status,receiver,receiver_phone,receiver_address,receivable_amount) VALUES ('SO-1','2026-01-01','completed','张三',?, '上海市浦东新区某路1号',100)").run(PHONE).lastInsertRowid
  db.prepare("INSERT INTO sales_orders (doc_no,channel,order_date,status,receiver,receiver_phone,receivable_amount,remark) VALUES ('XS-POS','store','2026-01-02','completed',?,?,9,'POS 日结上传 POS-1')").run(`会员 ${PHONE}`, PHONE)
  db.prepare("UPDATE oms_orders SET sales_order_id=? WHERE platform_order_no='H5-1'").run(so)
  db.prepare("INSERT INTO pos_orders (doc_no,store_id,warehouse_id,biz_date,member_phone,pay_amount) VALUES ('POS-1',1,1,'2026-01-01',?,9)").run(PHONE)
  db.close()
  return { dir, cid }
}

test('export writes the subject data to an explicit 0600 file with secrets scrubbed and nothing on stdout', (t) => {
  const { dir } = fixture(t)
  const out = path.join(dir, 'export.json')
  const r = run('scripts/privacy-export.mjs', dir, [PHONE, '--out', out])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(!r.stdout.includes('张三'), 'personal data is not echoed to stdout')
  assert.equal(statSync(out).mode & 0o777, 0o600)
  const j = JSON.parse(readFileSync(out, 'utf8'))
  const c = j.industries.cosmetic
  assert.equal(c.customer.phone, PHONE)
  assert.equal(c.orders.length, 2)
  assert.ok(c.orders.every((o) => !String(o.buyer_nick).includes(OTHER)))
  assert.equal(c.addresses.length, 2)
  assert.equal(c.pos_orders.length, 1)
  const text = readFileSync(out, 'utf8')
  assert.ok(!text.includes('abc123'), 'token=… in free text is stripped')
  assert.ok(!text.includes('李四') && !text.includes(OTHER), 'other customers are not exported')
})

test('export refuses: no --out, relative --out, --out inside the repository, existing file, bad phone, unknown number', (t) => {
  const { dir } = fixture(t)
  assert.equal(run('scripts/privacy-export.mjs', dir, [PHONE]).status, 2)
  assert.equal(run('scripts/privacy-export.mjs', dir, [PHONE, '--out', 'x.json']).status, 2)
  assert.equal(run('scripts/privacy-export.mjs', dir, [PHONE, '--out', path.join(ROOT, 'leak.json')]).status, 2)
  assert.ok(!existsSync(path.join(ROOT, 'leak.json')))
  const existing = path.join(dir, 'e.json'); writeFileSync(existing, 'keep')
  assert.equal(run('scripts/privacy-export.mjs', dir, [PHONE, '--out', existing]).status, 2)
  assert.equal(readFileSync(existing, 'utf8'), 'keep')
  assert.equal(run('scripts/privacy-export.mjs', dir, ['123', '--out', path.join(dir, 'a.json')]).status, 2)
  assert.equal(run('scripts/privacy-export.mjs', dir, ['13000000000', '--out', path.join(dir, 'b.json')]).status, 1)
  assert.equal(run('scripts/privacy-export.mjs', dir, [PHONE, '--out', path.join(dir, 'c.json')], { GML_DATA_DIR: path.join(ROOT, 'data') }).status, 2)
})

test('erase without --confirm or with a non-admin actor changes nothing', (t) => {
  const { dir } = fixture(t)
  assert.equal(run('scripts/privacy-erase.mjs', dir, [PHONE, '--actor', 'boss']).status, 2)
  assert.equal(run('scripts/privacy-erase.mjs', dir, [PHONE, '--confirm']).status, 2)
  assert.equal(run('scripts/privacy-erase.mjs', dir, [PHONE, '--confirm', '--actor', 'clerk']).status, 2)
  assert.equal(run('scripts/privacy-erase.mjs', dir, [PHONE, '--confirm', '--actor', 'nobody']).status, 2)
  const db = open(dir)
  assert.equal(db.prepare('SELECT name FROM mall_customers WHERE phone=?').get(PHONE).name, '张三')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='PRIVACY_ERASE'").get().n, 0)
  db.close()
})

test('erase pseudonymizes personal columns, keeps finance fields and ids, writes one audit row without the raw phone, and is replay safe', (t) => {
  const { dir, cid } = fixture(t)
  const db0 = open(dir)
  const fkBefore = db0.prepare('PRAGMA foreign_key_check').all().length
  const beforeOrders = db0.prepare('SELECT id,platform_order_no,status,goods_amount,freight,pay_amount,sales_order_id FROM oms_orders ORDER BY id').all()
  db0.close()
  const r = run('scripts/privacy-erase.mjs', dir, [PHONE, '--confirm', '--actor', 'boss'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const db = open(dir)
  const cust = db.prepare('SELECT * FROM mall_customers WHERE id=?').get(cid)
  assert.match(cust.phone, /^erased:[0-9a-f]{24}-\d+$/)
  assert.match(cust.name, /^erased:/)
  assert.equal(cust.points, 120); assert.equal(cust.total_amount, 300.5); assert.equal(cust.total_orders, 2)
  const orders = db.prepare('SELECT * FROM oms_orders ORDER BY id').all()
  assert.deepEqual(orders.map(({ id, platform_order_no, status, goods_amount, freight, pay_amount, sales_order_id }) => ({ id, platform_order_no, status, goods_amount, freight, pay_amount, sales_order_id })), beforeOrders)
  for (const o of orders.slice(0, 2)) {
    assert.match(o.receiver, /^erased:/); assert.match(o.receiver_phone, /^erased:/); assert.match(o.receiver_address, /^erased:/)
    assert.equal(o.buyer_nick, `会员${cust.phone}`)
  }
  assert.equal(orders[0].receiver_phone, cust.phone, 'same phone maps to the same pseudonym everywhere')
  assert.equal(orders[2].receiver, '李四', 'other customers untouched')
  assert.equal(db.prepare('SELECT phone FROM mall_customers WHERE name=?').get('李四').phone, OTHER)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mall_cart_items WHERE phone=?').get(cust.phone).n, 1)
  assert.equal(db.prepare("SELECT member_phone FROM pos_orders WHERE doc_no='POS-1'").get().member_phone, cust.phone)
  const so = db.prepare("SELECT * FROM sales_orders WHERE doc_no='SO-1'").get()
  assert.match(so.receiver, /^erased:/); assert.equal(so.receiver_phone, cust.phone); assert.match(so.receiver_address, /^erased:/); assert.equal(so.receivable_amount, 100)
  const posSo = db.prepare("SELECT * FROM sales_orders WHERE doc_no='XS-POS'").get()
  assert.equal(posSo.receiver, `会员 ${cust.phone}`); assert.equal(posSo.receiver_phone, cust.phone); assert.equal(posSo.receivable_amount, 9)
  assert.equal(db.prepare('SELECT pay_amount FROM pos_orders').get().pay_amount, 9)
  const audits = db.prepare("SELECT * FROM audit_logs WHERE action='PRIVACY_ERASE'").all()
  assert.equal(audits.length, 1)
  assert.equal(audits[0].user_name, 'boss'); assert.equal(audits[0].module, 'privacy')
  assert.ok(!audits[0].detail.includes(PHONE), 'raw phone never enters the audit row')
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, fkBefore, 'erase adds no dangling references')
  db.close()
  // exported data after erase no longer contains the person
  const out = path.join(dir, 'after.json')
  assert.equal(run('scripts/privacy-export.mjs', dir, [PHONE, '--out', out]).status, 1)
  // replay: harmless, no second audit row
  const again = run('scripts/privacy-erase.mjs', dir, [PHONE, '--confirm', '--actor', 'boss'])
  assert.equal(again.status, 0, again.stderr + again.stdout)
  assert.match(again.stdout, /already-erased/)
  const db2 = open(dir)
  assert.equal(db2.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='PRIVACY_ERASE'").get().n, 1)
  db2.close()
  // a number that never existed is an error
  assert.equal(run('scripts/privacy-erase.mjs', dir, ['13000000000', '--confirm', '--actor', 'boss']).status, 1)
})

test('a customer who re-registers after an erase can be erased again (pseudonyms are unique per customer row)', (t) => {
  const { dir } = fixture(t)
  assert.equal(run('scripts/privacy-erase.mjs', dir, [PHONE, '--confirm', '--actor', 'boss']).status, 0)
  const db = open(dir)
  const first = db.prepare("SELECT phone FROM mall_customers WHERE phone LIKE 'erased:%'").get().phone
  db.prepare('INSERT INTO mall_customers (phone,name) VALUES (?,?)').run(PHONE, '张三回来了')
  db.close()
  const r = run('scripts/privacy-erase.mjs', dir, [PHONE, '--confirm', '--actor', 'boss'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const db2 = open(dir)
  const erased = db2.prepare("SELECT phone FROM mall_customers WHERE phone LIKE 'erased:%' ORDER BY id").all().map((x) => x.phone)
  assert.equal(erased.length, 2)
  assert.equal(erased[0], first)
  assert.notEqual(erased[1], first)
  assert.equal(erased[0].split('-')[0], erased[1].split('-')[0], 'same keyed hash links lifecycles of one number')
  assert.equal(db2.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='PRIVACY_ERASE'").get().n, 2)
  db2.close()
})

test('export scrubs credentials embedded in free text and JSON fragments', (t) => {
  const { dir } = fixture(t)
  const db = open(dir)
  db.prepare("UPDATE oms_orders SET remark=? WHERE platform_order_no='H5-2'").run('{"token":"jsonsecret1","note":"hi"}')
  db.prepare("UPDATE oms_orders SET remark=? WHERE platform_order_no='H5-1'").run('Authorization: Bearer headersecret2 and api_key: keysecret3')
  db.prepare("UPDATE oms_orders SET remark=? WHERE platform_order_no='H5-3'").run('{"passwd":"pwdsecret4"}')
  db.close()
  const out = path.join(dir, 'scrub.json')
  assert.equal(run('scripts/privacy-export.mjs', dir, [PHONE, '--out', out]).status, 0)
  const text = readFileSync(out, 'utf8')
  for (const leaked of ['jsonsecret1', 'headersecret2', 'keysecret3', 'pwdsecret4']) assert.ok(!text.includes(leaked), leaked)
  assert.ok(text.includes('hi'), 'non-secret text survives')
})

test('a subject that only appears on sales orders is still found by export and erase', (t) => {
  const { dir } = fixture(t)
  const db = open(dir)
  db.prepare("INSERT INTO sales_orders (doc_no,channel,order_date,status,receiver,receiver_phone,receivable_amount) VALUES ('XS-ONLY','store','2026-02-01','completed','会员 13700000001','13700000001',5)").run()
  db.close()
  const out = path.join(dir, 'only.json')
  assert.equal(run('scripts/privacy-export.mjs', dir, ['13700000001', '--out', out]).status, 0)
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).industries.cosmetic.sales_orders.length, 1)
  assert.equal(run('scripts/privacy-erase.mjs', dir, ['13700000001', '--confirm', '--actor', 'boss']).status, 0)
  const db2 = open(dir)
  assert.match(db2.prepare("SELECT receiver_phone FROM sales_orders WHERE doc_no='XS-ONLY'").get().receiver_phone, /^erased:[0-9a-f]{24}-0$/)
  db2.close()
})

test('pseudonyms are keyed: a different secret yields different values', (t) => {
  const a = fixture(t); const b = fixture(t)
  assert.equal(run('scripts/privacy-erase.mjs', a.dir, [PHONE, '--confirm', '--actor', 'boss']).status, 0)
  assert.equal(run('scripts/privacy-erase.mjs', b.dir, [PHONE, '--confirm', '--actor', 'boss'], { GML_SECRET_KEY: 'another-secret-key-0123456789' }).status, 0)
  const pa = open(a.dir).prepare('SELECT phone FROM mall_customers WHERE id=?').get(a.cid).phone
  const pb = open(b.dir).prepare('SELECT phone FROM mall_customers WHERE id=?').get(b.cid).phone
  assert.notEqual(pa, pb)
})

test('open orders block the erase unless explicitly allowed', (t) => {
  const { dir } = fixture(t, { openOrder: true })
  const r = run('scripts/privacy-erase.mjs', dir, [PHONE, '--confirm', '--actor', 'boss'])
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /OPEN_ORDERS/)
  const db = open(dir)
  assert.equal(db.prepare('SELECT name FROM mall_customers WHERE phone=?').get(PHONE).name, '张三')
  db.close()
  assert.equal(run('scripts/privacy-erase.mjs', dir, [PHONE, '--confirm', '--actor', 'boss', '--allow-open-orders']).status, 0)
})

test('production mode refuses to pseudonymize with the public demo key', (t) => {
  const { dir } = fixture(t)
  const r = run('scripts/privacy-erase.mjs', dir, [PHONE, '--confirm', '--actor', 'boss'], { GML_RUNTIME_MODE: 'production', GML_JWT_SECRET: '' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /PSEUDONYM_KEY_UNSAFE/)
  const db = open(dir)
  assert.equal(db.prepare('SELECT name FROM mall_customers WHERE phone=?').get(PHONE).name, '张三')
  db.close()
})

test('when the audit row cannot be written the erase rolls back', (t) => {
  const { dir } = fixture(t)
  const db = open(dir)
  db.exec("CREATE TRIGGER block_erase BEFORE INSERT ON audit_logs WHEN NEW.action='PRIVACY_ERASE' BEGIN SELECT RAISE(ABORT,'blocked'); END")
  db.close()
  const r = run('scripts/privacy-erase.mjs', dir, [PHONE, '--confirm', '--actor', 'boss'])
  assert.equal(r.status, 1, r.stdout + r.stderr)
  const db2 = open(dir)
  assert.equal(db2.prepare('SELECT name FROM mall_customers WHERE phone=?').get(PHONE).name, '张三')
  assert.equal(db2.prepare("SELECT receiver FROM oms_orders WHERE platform_order_no='H5-1'").get().receiver, '张三')
  db2.close()
})

// ---------------------------------------------------------------------------------------------------------------
// Y8：抹除覆盖面扩展（退款单 / 订货中心快照 / 日志里的部分遮盖号码）与 --report
// ---------------------------------------------------------------------------------------------------------------
const MASKED = '138****5678'
const run2 = (dir, args, extra) => run('scripts/privacy-erase.mjs', dir, args, extra)

function y8Fixture(t, opts) {
  const f = fixture(t, opts)
  const db = open(f.dir)
  db.pragma('foreign_keys = OFF')
  const soId = db.prepare("SELECT id FROM sales_orders WHERE doc_no='SO-1'").get().id
  const omsId = db.prepare("SELECT id FROM oms_orders WHERE platform_order_no='H5-1'").get().id
  const ret = db.prepare("INSERT INTO sales_returns (doc_no,order_id,channel,return_date,status,total_amount,refund_due) VALUES ('SR-1',?,'store','2026-01-05','completed',100,100)").run(soId).lastInsertRowid
  const retB = db.prepare("INSERT INTO sales_returns (doc_no,order_id,channel,return_date,status,total_amount,refund_due) VALUES ('SR-2',?,'store','2026-01-06','completed',20,20)").run(soId).lastInsertRowid
  const mkRefund = db.prepare("INSERT INTO refunds (doc_no,source_type,source_id,customer_type,customer_id,customer_name,refund_date,method,amount,status,bank_account,serial_no,remark) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
  const rMember = mkRefund.run('RFD-M', 'sales_return', ret, 'member', f.cid, '张三', '2026-01-07', 'wechat', 100, 'confirmed', '招行 ****8821', 'SN-1', `联系 ${PHONE}`).lastInsertRowid
  const rLinkedPerson = mkRefund.run('RFD-P', 'sales_return', ret, 'walkin', null, '张三', '2026-01-08', 'cash', 10, 'confirmed', null, null, null).lastInsertRowid
  const rLinkedBiz = mkRefund.run('RFD-B', 'sales_return', retB, 'store', 7, '静安旗舰店', '2026-01-09', 'bank', 20, 'confirmed', null, null, null).lastInsertRowid
  const rOther = mkRefund.run('RFD-O', 'sales_return', 999, 'member', 99, '李四', '2026-01-10', 'cash', 5, 'confirmed', null, null, null).lastInsertRowid
  const ri = db.prepare('INSERT INTO refund_items (refund_id,return_id,return_doc_no,amount) VALUES (?,?,?,?)')
  ri.run(rLinkedPerson, ret, 'SR-1', 10); ri.run(rLinkedBiz, retB, 'SR-2', 20)
  const oc1 = db.prepare("INSERT INTO oc_customers (code,name,source_type,source_id,contact,phone,address) VALUES ('OC1','张三','dealer',1,'张三',?,'上海市某路9号')").run(PHONE).lastInsertRowid
  const oc2 = db.prepare("INSERT INTO oc_customers (code,name,source_type,source_id,contact,phone,address) VALUES ('OC2','李四','dealer',2,'李四',?,'广州市某路')").run(OTHER).lastInsertRowid
  const oc3 = db.prepare("INSERT INTO oc_customers (code,name,source_type,source_id,contact,phone,address) VALUES ('OC3','某某贸易有限公司','dealer',3,'王五',?,'杭州')").run('13600000003').lastInsertRowid
  db.prepare("INSERT INTO oc_addresses (customer_id,name,contact,phone,address) VALUES (?,?,?,?,?)").run(oc3, '仓库', '张三', PHONE, '杭州市某仓')
  db.prepare("INSERT INTO oc_addresses (customer_id,name,contact,phone,address) VALUES (?,?,?,?,?)").run(oc2, '总部', '李四', OTHER, '广州总部')
  const mkOc = db.prepare("INSERT INTO oc_orders (doc_no,customer_id,customer_type,customer_name,order_date,status,total_amount) VALUES (?,?,?,?,?,?,?)")
  mkOc.run('OC-ORD-1', oc1, 'dealer', '张三', '2026-01-01', 'completed', 321); mkOc.run('OC-ORD-2', oc2, 'dealer', '李四', '2026-01-01', 'completed', 654)
  mkOc.run('OC-ORD-3', oc3, 'dealer', '某某贸易有限公司', '2026-01-01', 'completed', 987)
  db.prepare("INSERT INTO oc_statements (doc_no,customer_id,customer_name,period_start,period_end,total_amount) VALUES ('OC-ST-1',?,'张三','2026-01-01','2026-01-31',321)").run(oc1)
  db.prepare("INSERT INTO ar_documents (doc_no,subject_type,subject_id,subject_name,source_type,biz_date,amount) VALUES ('AR-1','oc',?,'张三','OC','2026-01-01',321)").run(oc1)
  const ins = db.prepare('INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?)')
  ins.run(1, 'boss', 'SHIP', 'oms', 'oms_orders', String(omsId), JSON.stringify({ phone: MASKED, amount: 100, doc_no: 'H5-1' }))
  ins.run(1, 'boss', 'PAY', 'purchase', 'purchase_payments', '5', JSON.stringify({ phone: MASKED, amount: 4321.5, doc_no: 'PAY-9' }))
  ins.run(1, 'boss', 'SHIP', 'oms', 'oms_orders', '3', JSON.stringify({ phone: '139****4321', amount: 50 }))
  ins.run(1, 'boss', 'NOTE', 'sales', 'sales_orders', '77', `customer called from ${PHONE} about refund`)
  const nl = db.prepare("INSERT INTO notify_logs (channel_code,title,payload,status) VALUES ('c','t',?,'success')")
  nl.run(`raw ${PHONE} appeared`); nl.run(`only masked ${MASKED} appeared`); nl.run('nothing personal 100.00')
  db.close()
  return { ...f, soId, omsId, ret, rMember, rLinkedPerson, rLinkedBiz, rOther, oc1, oc2, oc3 }
}
const snap = (dir, sql) => { const db = open(dir); try { return db.prepare(sql).all() } finally { db.close() } }

test('--report prints per-table affected rows before executing, changes nothing and prints no personal data', (t) => {
  const f = y8Fixture(t)
  const before = JSON.stringify(snap(f.dir, 'SELECT * FROM refunds'))
  const r = run2(f.dir, [PHONE, '--report'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const j = JSON.parse(r.stdout)
  assert.equal(j.mode, 'report')
  const tb = j.industries.cosmetic.tables
  assert.equal(tb.refunds.rows, 2, 'member refund + order-linked refund whose name is the subject; the store-name refund and other member are untouched')
  assert.deepEqual(tb.refunds.columns, ['customer_name', 'remark'])
  assert.equal(tb.oc_customers.rows, 1); assert.equal(tb.oc_addresses.rows, 1)
  assert.equal(tb.oc_orders.rows, 1); assert.equal(tb.oc_statements.rows, 1); assert.equal(tb.ar_documents.rows, 1)
  assert.equal(tb.audit_logs.rows, 2, 'tied row + raw-phone row')
  assert.equal(tb.notify_logs.rows, 1)
  assert.equal(j.industries.cosmetic.ambiguous_masked.audit_logs, 1, 'purchase PAY row only matches the masked pattern')
  assert.equal(j.industries.cosmetic.ambiguous_masked.notify_logs, 1)
  for (const leaked of ['张三', PHONE, '静安']) assert.ok(!r.stdout.includes(leaked), leaked)
  assert.equal(JSON.stringify(snap(f.dir, 'SELECT * FROM refunds')), before)
  assert.equal(snap(f.dir, "SELECT COUNT(*) n FROM audit_logs WHERE action='PRIVACY_ERASE'")[0].n, 0)
  assert.equal(snap(f.dir, 'SELECT name FROM mall_customers WHERE phone=?'.replace('?', `'${PHONE}'`))[0].name, '张三')
})

test('--report needs neither --confirm nor --actor; --dry-run applies the real checks and still writes nothing', (t) => {
  const f = y8Fixture(t)
  assert.equal(run2(f.dir, [PHONE, '--dry-run']).status, 2, 'dry-run needs an actor')
  assert.equal(run2(f.dir, [PHONE, '--dry-run', '--actor', 'clerk']).status, 2)
  const d = run2(f.dir, [PHONE, '--dry-run', '--actor', 'boss'])
  assert.equal(d.status, 0, d.stderr)
  assert.equal(JSON.parse(d.stdout).mode, 'dry-run')
  assert.equal(snap(f.dir, "SELECT COUNT(*) n FROM audit_logs WHERE action='PRIVACY_ERASE'")[0].n, 0)
  assert.equal(snap(f.dir, "SELECT name FROM mall_customers WHERE phone='" + PHONE + "'")[0].name, '张三')
  assert.equal(run2(f.dir, [PHONE, '--report', '--dry-run']).status, 2)
})

test('--report on open orders lists them without refusing; --dry-run refuses like the real run', (t) => {
  const f = y8Fixture(t, { openOrder: true })
  const rep = run2(f.dir, [PHONE, '--report'])
  assert.equal(rep.status, 0)
  assert.equal(JSON.parse(rep.stdout).industries.cosmetic.would_refuse, 'OPEN_ORDERS')
  const dry = run2(f.dir, [PHONE, '--dry-run', '--actor', 'boss'])
  assert.equal(dry.status, 1)
  assert.match(dry.stderr, /OPEN_ORDERS/)
})

test('erase covers refunds, oc snapshots and log fragments; report counts equal the audited counts equal the real row changes', (t) => {
  const f = y8Fixture(t)
  const reportCounts = Object.fromEntries(Object.entries(JSON.parse(run2(f.dir, [PHONE, '--report']).stdout).industries.cosmetic.tables).map(([k, v]) => [k, v.rows]))
  const db0 = open(f.dir)
  const fk0 = db0.prepare('PRAGMA foreign_key_check').all().length
  const fin0 = {
    refunds: db0.prepare('SELECT id,doc_no,source_id,customer_type,customer_id,amount,status,method,bank_account,serial_no FROM refunds ORDER BY id').all(),
    oc_orders: db0.prepare('SELECT id,doc_no,customer_id,total_amount,status FROM oc_orders ORDER BY id').all(),
    ar: db0.prepare('SELECT id,doc_no,subject_id,amount FROM ar_documents').all(),
    audit: db0.prepare('SELECT id,user_name,action,module,entity,entity_id,created_at FROM audit_logs ORDER BY id').all(),
    n_audit: db0.prepare('SELECT COUNT(*) n FROM audit_logs').get().n
  }
  db0.close()
  const r = run2(f.dir, [PHONE, '--confirm', '--actor', 'boss'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const out = JSON.parse(r.stdout).cosmetic
  assert.deepEqual(out.erased, reportCounts, 'report == executed')
  const db = open(f.dir)
  const pp = db.prepare('SELECT phone FROM mall_customers WHERE id=?').get(f.cid).phone
  const audit = JSON.parse(db.prepare("SELECT detail FROM audit_logs WHERE action='PRIVACY_ERASE'").get().detail)
  assert.deepEqual(audit.counts, reportCounts, 'audit == report')
  // refunds
  const rf = Object.fromEntries(db.prepare('SELECT doc_no,customer_name,remark FROM refunds').all().map((x) => [x.doc_no, x]))
  assert.match(rf['RFD-M'].customer_name, /^erased:/); assert.equal(rf['RFD-M'].remark, `联系 ${pp}`)
  assert.match(rf['RFD-P'].customer_name, /^erased:/)
  assert.equal(rf['RFD-B'].customer_name, '静安旗舰店', 'business names on linked refunds are kept')
  assert.equal(rf['RFD-O'].customer_name, '李四', 'other members untouched')
  assert.deepEqual(db.prepare('SELECT id,doc_no,source_id,customer_type,customer_id,amount,status,method,bank_account,serial_no FROM refunds ORDER BY id').all(), fin0.refunds, 'finance fields unchanged')
  // oc
  const oc = Object.fromEntries(db.prepare('SELECT code,name,contact,phone,address FROM oc_customers').all().map((x) => [x.code, x]))
  assert.equal(oc.OC1.phone, pp); assert.match(oc.OC1.name, /^erased:/); assert.match(oc.OC1.contact, /^erased:/); assert.match(oc.OC1.address, /^erased:/)
  assert.equal(oc.OC2.name, '李四'); assert.equal(oc.OC2.phone, OTHER)
  assert.equal(oc.OC3.name, '某某贸易有限公司', 'business name kept even though an address row carries the subject phone'); assert.equal(oc.OC3.contact, '王五')
  const addr = db.prepare('SELECT customer_id,name,contact,phone,address FROM oc_addresses ORDER BY id').all()
  assert.equal(addr[0].phone, pp); assert.match(addr[0].contact, /^erased:/); assert.match(addr[0].address, /^erased:/); assert.equal(addr[0].name, '仓库')
  assert.equal(addr[1].phone, OTHER)
  const ocs = Object.fromEntries(db.prepare('SELECT doc_no,customer_name FROM oc_orders').all().map((x) => [x.doc_no, x.customer_name]))
  assert.match(ocs['OC-ORD-1'], /^erased:/); assert.equal(ocs['OC-ORD-2'], '李四'); assert.equal(ocs['OC-ORD-3'], '某某贸易有限公司')
  assert.match(db.prepare('SELECT customer_name FROM oc_statements').get().customer_name, /^erased:/)
  assert.match(db.prepare('SELECT subject_name FROM ar_documents').get().subject_name, /^erased:/)
  assert.deepEqual(db.prepare('SELECT id,doc_no,customer_id,total_amount,status FROM oc_orders ORDER BY id').all(), fin0.oc_orders)
  assert.deepEqual(db.prepare('SELECT id,doc_no,subject_id,amount FROM ar_documents').all(), fin0.ar)
  // logs: tied + raw rows replaced, ambiguous untouched, evidence columns and amounts intact
  const logs = db.prepare('SELECT id,action,entity,entity_id,detail FROM audit_logs WHERE action<>? ORDER BY id').all('PRIVACY_ERASE')
  assert.deepEqual(JSON.parse(logs[0].detail), { phone: pp, amount: 100, doc_no: 'H5-1' })
  assert.deepEqual(JSON.parse(logs[1].detail), { phone: MASKED, amount: 4321.5, doc_no: 'PAY-9' }, 'ambiguous masked-only row is not touched by default')
  assert.deepEqual(JSON.parse(logs[2].detail), { phone: '139****4321', amount: 50 })
  assert.equal(logs[3].detail, `customer called from ${pp} about refund`)
  assert.deepEqual(db.prepare('SELECT id,user_name,action,module,entity,entity_id,created_at FROM audit_logs WHERE action<>? ORDER BY id').all('PRIVACY_ERASE'), fin0.audit)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, fin0.n_audit + 1)
  const nl = db.prepare('SELECT payload FROM notify_logs ORDER BY id').all().map((x) => x.payload)
  assert.equal(nl[0], `raw ${pp} appeared`); assert.equal(nl[1], `only masked ${MASKED} appeared`); assert.equal(nl[2], 'nothing personal 100.00')
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, fk0)
  assert.ok(!audit.residual_raw_phone.length || audit.residual_raw_phone.every((x) => !/^(refunds|oc_|audit_logs|notify_logs)/.test(x)), 'covered tables have no residual')
  assert.ok(!JSON.stringify(audit).includes(PHONE))
  db.close()
})

test('--include-ambiguous-masked also replaces masked-only log rows, never touching amounts or document numbers', (t) => {
  const f = y8Fixture(t)
  const rep = JSON.parse(run2(f.dir, [PHONE, '--report', '--include-ambiguous-masked']).stdout).industries.cosmetic
  assert.equal(rep.tables.audit_logs.rows, 3); assert.equal(rep.tables.notify_logs.rows, 2)
  assert.equal(run2(f.dir, [PHONE, '--confirm', '--actor', 'boss', '--include-ambiguous-masked']).status, 0)
  const db = open(f.dir)
  const pp = db.prepare('SELECT phone FROM mall_customers WHERE id=?').get(f.cid).phone
  const pay = JSON.parse(db.prepare("SELECT detail FROM audit_logs WHERE action='PAY'").get().detail)
  assert.deepEqual(pay, { phone: pp, amount: 4321.5, doc_no: 'PAY-9' })
  assert.equal(db.prepare("SELECT detail FROM audit_logs WHERE action='PRIVACY_ERASE'").get().detail.includes('"include_ambiguous_masked":true'), true)
  assert.equal(db.prepare('SELECT payload FROM notify_logs WHERE id=2').get().payload, `only masked ${pp} appeared`)
  db.close()
})

test('a failure in the new tables rolls the whole database back (one transaction, nothing half-erased)', (t) => {
  const f = y8Fixture(t)
  const db = open(f.dir)
  db.exec("CREATE TRIGGER block_oc BEFORE UPDATE OF customer_name ON oc_statements BEGIN SELECT RAISE(ABORT,'blocked'); END")
  db.close()
  const r = run2(f.dir, [PHONE, '--confirm', '--actor', 'boss'])
  assert.equal(r.status, 1, r.stdout + r.stderr)
  const db2 = open(f.dir)
  assert.equal(db2.prepare('SELECT name FROM mall_customers WHERE phone=?').get(PHONE).name, '张三')
  assert.equal(db2.prepare("SELECT customer_name FROM refunds WHERE doc_no='RFD-M'").get().customer_name, '张三')
  assert.equal(db2.prepare("SELECT detail FROM audit_logs WHERE entity='sales_orders' AND entity_id='77'").get().detail.includes(PHONE), true)
  assert.equal(db2.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='PRIVACY_ERASE'").get().n, 0)
  db2.close()
})

test('export covers the same set as erase and reports (not exports) masked-only log rows', (t) => {
  const f = y8Fixture(t)
  const out = path.join(f.dir, 'y8.json')
  assert.equal(run('scripts/privacy-export.mjs', f.dir, [PHONE, '--out', out]).status, 0)
  const c = JSON.parse(readFileSync(out, 'utf8')).industries.cosmetic
  assert.deepEqual(c.refunds.map((x) => x.doc_no).sort(), ['RFD-B', 'RFD-M', 'RFD-P'])
  assert.equal(c.oc_customers.length, 1); assert.equal(c.oc_addresses.length, 1); assert.equal(c.oc_orders.length, 1); assert.equal(c.oc_statements.length, 1)
  assert.equal(c.audit_logs.length, 2); assert.equal(c.notify_logs.length, 1)
  assert.deepEqual(c.ambiguous_masked_log_rows, { audit_logs: 1, notify_logs: 1 })
  const text = readFileSync(out, 'utf8')
  assert.ok(!text.includes('PAY-9') && !text.includes('李四'), 'rows that cannot be tied to the subject are not exported')
})

test('report surfaces what the tool does not cover: master-data phones and raw numbers in other tables', (t) => {
  const f = y8Fixture(t)
  const db = open(f.dir)
  db.prepare("INSERT INTO dealers (code,name,phone) VALUES ('D-X','某经销商',?)").run(PHONE)
  db.prepare("INSERT INTO doc_events (doc_type,doc_id,action,to_state,payload_json) VALUES ('sales_order',1,'X','s',?)").run(`{"call":"${PHONE}"}`)
  db.close()
  const j = JSON.parse(run2(f.dir, [PHONE, '--report']).stdout).industries.cosmetic
  assert.equal(j.manual_review['dealers.phone'], 1)
  assert.ok(Object.keys(j.raw_phone_not_covered).includes('doc_events.payload_json'), JSON.stringify(j.raw_phone_not_covered))
  assert.ok(!Object.keys(j.raw_phone_not_covered).some((k) => /^(refunds|oc_|mall_|oms_orders\.receiver)/.test(k)))
  // 执行后：实际残留如实列出，且不被悄悄改写
  const r = JSON.parse(run2(f.dir, [PHONE, '--confirm', '--actor', 'boss']).stdout).cosmetic
  assert.equal(r.residual_raw_phone['doc_events.payload_json'], 1)
  assert.equal(r.residual_raw_phone['dealers.phone'], 1)
  const d = open(f.dir)
  assert.equal(d.prepare('SELECT phone FROM dealers').get().phone, PHONE, 'master data is left alone')
  d.close()
})

test('Y8 audit findings: identifiers that embed the number and JSON numbers are never rewritten; report predicts residue per row; oc-only subjects are found', (t) => {
  const f = y8Fixture(t)
  const db = open(f.dir)
  const ins = db.prepare('INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?)')
  const tied = String(f.omsId)
  const detail = '{"doc_no":"RC-13812345678","bank":"13812345678","amount":13812345678,"memo":"call 13812345678 now","n":1.50}'
  ins.run(1, 'boss', 'EDIT', 'oms', 'oms_orders', tied, detail)
  ins.run(1, 'boss', 'EDIT', 'oms', 'oms_orders', tied, 'ref RC-13812345678 and 13812345678-X untouched; tel:13812345678.')
  db.prepare("UPDATE sales_orders SET remark=? WHERE doc_no='SO-1'").run('call 13812345678')
  db.prepare("INSERT INTO sales_orders (doc_no,channel,order_date,status,receiver,receiver_phone,receivable_amount,remark) VALUES ('SO-OTHER','store','2026-03-01','completed','赵六','13999999999',1,'mentions 13812345678 in passing')").run()
  db.prepare("INSERT INTO oc_addresses (customer_id,name,contact,phone,address) VALUES (?,?,?,?,?)").run(f.oc1, '备用', '张三', '13011112222', '备用地址路1号')
  db.prepare("INSERT INTO oc_addresses (customer_id,name,contact,phone,address) VALUES (?,?,?,?,?)").run(f.oc1, '空号', '张三', null, '无电话地址')
  db.close()
  const rep = JSON.parse(run2(f.dir, [PHONE, '--report']).stdout).industries.cosmetic
  assert.equal(rep.raw_phone_not_covered['sales_orders.remark'], 1, 'the untouched sales order remark is reported even though another row of the same column is cleaned')
  const exec = JSON.parse(run2(f.dir, [PHONE, '--confirm', '--actor', 'boss']).stdout).cosmetic
  assert.deepEqual(exec.residual_raw_phone, rep.raw_phone_not_covered, 'report prediction == measured residue')
  const d = open(f.dir)
  const pp = d.prepare('SELECT phone FROM mall_customers WHERE id=?').get(f.cid).phone
  const rows = d.prepare("SELECT detail FROM audit_logs WHERE action='EDIT' ORDER BY id").all().map((x) => x.detail)
  const j = JSON.parse(rows[0])
  assert.equal(j.doc_no, 'RC-13812345678'); assert.equal(j.amount, 13812345678); assert.equal(j.n, 1.5)
  assert.equal(j.bank, '13812345678', 'bank-ish keys keep their value'); assert.equal(j.memo, `call ${pp} now`)
  assert.equal(rows[1], `ref RC-13812345678 and 13812345678-X untouched; tel:${pp}.`)
  assert.equal(d.prepare("SELECT remark FROM sales_orders WHERE doc_no='SO-OTHER'").get().remark, 'mentions 13812345678 in passing')
  const addrs = d.prepare('SELECT contact,phone,address FROM oc_addresses WHERE customer_id=? ORDER BY id').all(f.oc1)
  assert.ok(addrs.length === 2 && addrs.every((a) => /^erased:/.test(a.contact) && /^erased:/.test(a.address)), JSON.stringify(addrs))
  assert.match(addrs[0].phone, /^erased:/); assert.equal(addrs[1].phone, null)
  d.close()
})

test('a subject that exists only as an order-center customer is found, erased once and then reported as already erased', (t) => {
  const f = y8Fixture(t)
  const db = open(f.dir)
  db.prepare("INSERT INTO oc_customers (code,name,source_type,source_id,contact,phone,address) VALUES ('OC9','赵七','store',9,'赵七','13722223333','某地')").run()
  db.close()
  assert.equal(JSON.parse(run2(f.dir, ['13722223333', '--report']).stdout).industries.cosmetic.tables.oc_customers.rows, 1)
  const r = run2(f.dir, ['13722223333', '--confirm', '--actor', 'boss'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const d = open(f.dir)
  assert.match(d.prepare("SELECT phone FROM oc_customers WHERE code='OC9'").get().phone, /^erased:[0-9a-f]{24}-0$/)
  assert.equal(d.prepare("SELECT name FROM oc_customers WHERE code='OC9'").get().name.startsWith('erased:'), true)
  d.close()
  const again = run2(f.dir, ['13722223333', '--confirm', '--actor', 'boss'])
  assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /already-erased/)
})

test('Y8 round 2: JSON edits are lossless, protection follows ancestors, phone-named fields are not mistaken for identifiers, association uses the same boundary rules', (t) => {
  const f = y8Fixture(t)
  const db = open(f.dir)
  const ins = db.prepare('INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?)')
  const tied = String(f.omsId)
  const raw = `{ "transaction_id":9007199254740993, "n": 1.50 ,"note":"tel ${PHONE} ok","invoice":{"id":"${PHONE}"},"bank_account":{"value":"${PHONE}"},"phone_number":"${MASKED}","preferred_phone":"${PHONE}" }`
  ins.run(1, 'boss', 'R2A', 'oms', 'oms_orders', tied, raw)
  // 与主体无关：单号里嵌了号码，同时带一个恰好同遮盖串的号码 ⇒ 只能算"遮盖串命中"，不能算属于主体
  ins.run(1, 'boss', 'R2B', 'oms', 'oms_orders', '3', `{"doc_no":"RC-${PHONE}","phone":"${MASKED}"}`)
  db.prepare("INSERT INTO notify_logs (channel_code,title,payload,status) VALUES ('c','t',?,'success')").run(`{"ref":"RC-${PHONE}","who":"${MASKED}"}`)
  db.close()
  const rep = JSON.parse(run2(f.dir, [PHONE, '--report']).stdout).industries.cosmetic
  assert.equal(rep.ambiguous_masked.audit_logs, 2, 'PAY row + the R2B row (its masked phone is the only match)')
  assert.equal(rep.ambiguous_masked.notify_logs, 2)
  assert.ok(rep.masked_fragment_columns['audit_logs.detail'] >= 3)
  assert.equal(run2(f.dir, [PHONE, '--confirm', '--actor', 'boss']).status, 0)
  const d = open(f.dir)
  const pp = d.prepare('SELECT phone FROM mall_customers WHERE id=?').get(f.cid).phone
  const a = d.prepare("SELECT detail FROM audit_logs WHERE action='R2A'").get().detail
  assert.equal(a, `{ "transaction_id":9007199254740993, "n": 1.50 ,"note":"tel ${pp} ok","invoice":{"id":"${PHONE}"},"bank_account":{"value":"${PHONE}"},"phone_number":"${pp}","preferred_phone":"${pp}" }`, 'byte-for-byte except the personal values')
  assert.equal(d.prepare("SELECT detail FROM audit_logs WHERE action='R2B'").get().detail, `{"doc_no":"RC-${PHONE}","phone":"${MASKED}"}`, 'unrelated row untouched')
  d.close()
  const out = path.join(f.dir, 'r2.json')
  assert.equal(run('scripts/privacy-export.mjs', f.dir, [OTHER, '--out', out]).status, 0)
  assert.ok(!readFileSync(out, 'utf8').includes('R2B'))
})

test('AE5 privacy-erase records an erase intent in the same transaction as the rewritten-row anchors and references it from PRIVACY_ERASE', (t) => {
  const f = y8Fixture(t)
  const db0 = open(f.dir)
  // 夹具用裸 INSERT 写审计行；先把它们接上链（与启动自愈同一规则），隐私抹除才会改写已入链的行并登记锚点
  const mig = createRequire(import.meta.url)(path.join(ROOT, 'server/db/migrations/_audit_chain.cjs'))
  mig.adoptOrphans(db0)
  db0.close()
  const r = run2(f.dir, [PHONE, '--confirm', '--actor', 'boss'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const db = open(f.dir)
  const intents = db.prepare('SELECT * FROM audit_anchor_intents').all()
  assert.equal(intents.length, 1)
  assert.equal(intents[0].operation, 'erase')
  assert.equal(intents[0].operator_name, 'boss')
  assert.ok(intents[0].operator_user_id !== null)
  assert.ok(!JSON.stringify(intents[0]).includes(PHONE), 'no personal data in the intent')
  const audit = db.prepare("SELECT id, detail FROM audit_logs WHERE action='PRIVACY_ERASE'").get()
  assert.deepEqual([JSON.parse(audit.detail).anchor_intent.id, JSON.parse(audit.detail).anchor_intent.hash, intents[0].audit_row_id], [intents[0].id, intents[0].intent_hash, audit.id])
  const anchors = db.prepare("SELECT at_row_id FROM audit_chain_anchors WHERE kind='erase'").all()
  assert.ok(anchors.length >= 1)
  assert.equal(JSON.parse(intents[0].anchors_json).length, anchors.length)
  db.close()
})
