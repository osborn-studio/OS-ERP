/**
 * ============================================================================
 * 文件标识：tests/mcp-trace-ledger-scope.test.mjs ｜ MCP 追溯流水的货主与仓库范围交集
 * ============================================================================
 * 【职责】最小内存库复现货主在范围内但仓库越界的流水泄露；无对应单据也不得绕过库存域范围判据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { TOOL_MAP } from '../server/mcp/tools.js'
import { stockScopeSql } from '../server/lib/stock.js'

test('trace ledger requires both owner and warehouse scope, including documentless transactions', (t) => {
  const db = new Database(':memory:'); t.after(() => db.close())
  db.exec(`CREATE TABLE warehouses(id INTEGER PRIMARY KEY, org_id INTEGER);
    INSERT INTO warehouses VALUES(10,1),(20,2),(30,NULL);
    CREATE TABLE doc_types(code TEXT);
    CREATE TABLE inventory_transactions(id INTEGER PRIMARY KEY,doc_no TEXT,owner_org_id INTEGER,warehouse_id INTEGER);
    INSERT INTO inventory_transactions VALUES(1,'MIXED',1,10),(2,'MIXED',1,20),(3,'MIXED',2,10),
      (4,'MIXED',1,30),(5,'MIXED',1,NULL),(6,'MIXED',1,999),
      (7,'FOREIGN-ONLY',1,20);`)
  const scope = { scope:'org',orgIds:[1] }
  const trace = (doc_no, scope) => TOOL_MAP.get('order.trace_document').handler({db,args:{doc_no},ctx:{scope}}).data
  const got = trace('MIXED',scope).inventory_transactions.map(r=>r.id)
  assert.deepEqual(got,[1], 'a matching owner cannot unlock foreign, unowned, missing or null warehouses')
  const sc=stockScopeSql(scope,'t')
  const stockRows=db.prepare(`SELECT id FROM inventory_transactions t WHERE doc_no=? AND owner_org_id=? AND ${sc.sql} ORDER BY id`).all('MIXED',1,...sc.params).map(r=>r.id)
  assert.deepEqual(got,stockRows,'trace agrees with the inventory-domain warehouse predicate')
  assert.throws(()=>trace('FOREIGN-ONLY',scope),e=>e.code==='NOT_FOUND')
  assert.throws(()=>trace('MIXED',{scope:'none',orgIds:[]}),e=>e.code==='NOT_FOUND')
  assert.deepEqual(trace('MIXED',{scope:'all',orgIds:null}).inventory_transactions.map(r=>r.id),[1,2,3,4,5,6])
})
