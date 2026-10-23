import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const PHONE = '13812345678'
const OTHER = '13987654321'
const envFor = (dir, extra = {}) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: 'b'.repeat(48), ...extra })
const run = (script, dir, args = [], extra = {}) => spawnSync(process.execPath, [script, ...args], { cwd: ROOT, env: envFor(dir, extra), encoding: 'utf8', timeout: 60000 })
const open = (dir) => new Database(path.join(dir, 'gml_cosmetic.db'))

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
  assert.match(cust.phone, /^erased:[0-9a-f]{24}$/)
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
