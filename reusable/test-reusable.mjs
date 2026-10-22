// GML 开源复用落地包 · 冒烟测试
// 验证三块骨架（促销引擎 / 复式记账 / 行级权限）在 SQLite 下真能跑通。
// 用法：cd gml && node reusable/test-reusable.mjs
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  computePromotionActions, persistAdjustments, registerUsage, revertUsage, sortPromotions
} from './promotion/promotion-engine.js'
import { postJournal, voidJournal, getBalance, closePeriod, assertBalanced } from './ledger/ledger.js'
import { checkAccess, compileRowFilter, grantPolicy, assignRole, ROW_NONE, ROW_ALL } from './rbac/rbac.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(':memory:')
db.pragma('foreign_keys = ON')

let pass = 0
let fail = 0
function ok (name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

for (const f of [
  'promotion/001_promotion_schema.sql',
  'ledger/001_ledger_schema.sql',
  'rbac/001_rbac_schema.sql'
]) {
  db.exec(fs.readFileSync(path.join(here, f), 'utf8'))
}
console.log('\n[0] 三套表结构建表成功\n')

// =====================================================================
console.log('[1] 促销引擎')
// =====================================================================
db.prepare(`INSERT INTO promotions (code,name,type,status,is_automatic,priority,stack_group,usage_limit)
            VALUES ('NEW10','新客九折','standard','active',1,10,'g1',1)`).run()
db.prepare(`INSERT INTO promotion_methods (promotion_id,type,target_type,allocation,value,value_scale)
            VALUES (1,'percentage','items','each',1000,0)`).run()   // 1000 = 10.00%
db.prepare(`INSERT INTO promotions (code,name,type,status,is_automatic,priority,stack_group)
            VALUES ('VIP5','会员95折','standard','active',1,20,'g1')`).run()
db.prepare(`INSERT INTO promotion_methods (promotion_id,type,target_type,allocation,value,value_scale)
            VALUES (2,'percentage','items','each',500,0)`).run()      // 5%

const ctx = {
  items: [
    { id: 1, sku_id: 'SKU-A', qty: 2, unit_price: 5000, subtotal: 10000, is_discountable: 1 },
    { id: 2, sku_id: 'SKU-B', qty: 1, unit_price: 3000, subtotal: 3000, is_discountable: 1 }
  ],
  customer: { id: 1, level: 'gold' },
  subtotal: 13000,
  codes: [],
  now: '2026-10-15 16:00:00'
}
const r1 = computePromotionActions(db, ctx)
ok('同组互斥：只命中高优先级 NEW10', r1.appliedCodes.length === 1 && r1.appliedCodes[0] === 'NEW10', JSON.stringify(r1.appliedCodes))
ok('折扣额 = 13000 × 10% = 1300', r1.totalDiscount === 1300, `实际 ${r1.totalDiscount}`)

// 裁决器：买赠优先 + 同类型按力度降序 + priority 优先
ok('裁决器 priority 优先', sortPromotions({ priority: 1 }, { priority: 2 }) < 0)
ok('裁决器 同优先级按力度降序', sortPromotions({ priority: 1, method: { value: 900 } }, { priority: 1, method: { value: 500 } }) < 0)
ok('裁决器 同优先级买赠优先', sortPromotions({ priority: 1, type: 'buyget' }, { priority: 1, type: 'standard' }) < 0)

// 落库 + 使用登记（usage_limit=1）
persistAdjustments(db, { orderId: 1001, actions: r1.actions })
const adj = db.prepare('SELECT COALESCE(SUM(amount),0) c FROM promotion_adjustments WHERE order_id = 1001').get()
ok('优惠留痕落库 = 1300', adj.c === 1300, `实际 ${adj.c}`)

const u1 = registerUsage(db, { actions: r1.actions, orderId: 1001, customerId: 1 })
ok('首次登记成功', u1.registered === 1 && u1.skipped.length === 0, JSON.stringify(u1))
const used = db.prepare('SELECT used FROM promotions WHERE id = 1').get()
ok('used 计数 = 1', used.used === 1)

// 幂等：同一订单重复登记
const u2 = registerUsage(db, { actions: r1.actions, orderId: 1001, customerId: 1 })
ok('幂等：重复登记被拦', u2.registered === 0 && u2.skipped[0]?.reason === 'duplicate', JSON.stringify(u2))

// 超限：usage_limit=1，换订单再登记
const u3 = registerUsage(db, { actions: r1.actions, orderId: 1002, customerId: 1 })
ok('防超发：超出次数上限被拦', u3.registered === 0 && u3.skipped[0]?.reason === 'usage_limit_exceeded', JSON.stringify(u3))

// 回退
revertUsage(db, { orderId: 1001 })
const usedAfter = db.prepare('SELECT used FROM promotions WHERE id = 1').get()
ok('回退后 used 归零', usedAfter.used === 0, `实际 ${usedAfter.used}`)

// =====================================================================
console.log('\n[2] 复式记账内核')
// =====================================================================
let threw = false
try {
  assertBalanced([{ account_path: '1131:应收账款', debit: 10000, credit: 0 },
                  { account_path: '6001:主营业务收入', debit: 0, credit: 9000 }])
} catch (e) { threw = true }
ok('借贷不平衡被拒绝', threw)

threw = false
try {
  assertBalanced([{ account_path: '1131:应收账款', debit: 10000, credit: 5000 }])
} catch (e) { threw = true }
ok('同分录借贷同有被拒绝', threw)

const jid = postJournal(db, {
  docType: 'SALE_INVOICE', docId: 501, docNo: 'XS20261015001',
  bizDate: '2026-10-15', memo: '销售出库开票',
  entries: [
    { account_path: '1131:应收账款', debit: 10000, credit: 0, meta: { customer_id: 7 } },
    { account_path: '6001:主营业务收入', debit: 0, credit: 10000 }
  ],
  createdBy: 'tester'
})
ok('平衡凭证写入成功', jid > 0)
ok('应收账款余额 = 10000', getBalance(db, { accountPath: '1131' }).balance === 10000)
ok('收入科目余额 = -10000（贷方）', getBalance(db, { accountPath: '6001' }).balance === -10000)

// 红冲
const revId = voidJournal(db, { journalId: jid, reason: '开票有误' })
ok('红冲生成反向凭证', revId > 0)
ok('红冲后应收账款余额归零', getBalance(db, { accountPath: '1131' }).balance === 0,
  `实际 ${getBalance(db, { accountPath: '1131' }).balance}`)
const voided = db.prepare('SELECT voided FROM acct_journals WHERE id = ?').get(jid)
ok('原凭证标记作废（未物理删除）', voided.voided === 1)
threw = false
try { voidJournal(db, { journalId: jid, reason: '重复红冲' }) } catch (e) { threw = true }
ok('重复红冲被拒绝', threw)

// 期末结转
const closed = closePeriod(db, { period: '2026-10', bizDate: '2026-10-31', createdBy: 'tester' })
ok('期末结转完成', closed.closed === true)
ok('结转后损益科目余额归零', getBalance(db, { accountPath: '6001' }).balance === 0)
threw = false
try {
  postJournal(db, {
    docType: 'SALE_INVOICE', docId: 502, bizDate: '2026-10-20',
    entries: [{ account_path: '1131:应收账款', debit: 100, credit: 0 },
              { account_path: '6001:主营业务收入', debit: 0, credit: 100 }]
  })
} catch (e) { threw = /已结账/.test(e.message) }
ok('期间闸门：已结账月份禁止写凭证', threw)

// =====================================================================
console.log('\n[3] 行级权限')
// =====================================================================
db.prepare(`INSERT INTO rbac_roles (code,name) VALUES ('store_manager','店长')`).run()
db.prepare(`INSERT INTO rbac_roles (code,name) VALUES ('hq_admin','总部管理员')`).run()
assignRole(db, { userId: 88, roleCode: 'store_manager', dom: 'WH01' })

// 店长只能看自己仓库的销售订单
grantPolicy(db, {
  roleCode: 'store_manager', dom: 'WH01', resource: 'sales_order', action: 'read', eft: 'allow',
  rowRules: [{ field: 'warehouse_id', operator: 'in', value: '1,2' }]
})
// 显式拒绝：店长不能审批
grantPolicy(db, { roleCode: 'store_manager', dom: 'WH01', resource: 'sales_order', action: 'approve', eft: 'deny' })

const ctxA = { userId: 88, orgId: 3, dom: 'WH01', resource: 'sales_order', action: 'read' }
const a1 = checkAccess(db, ctxA)
ok('店长可读销售订单', a1.allowed === true, JSON.stringify(a1))

const f1 = compileRowFilter(db, ctxA)
ok('行级过滤编译为 SQL', /warehouse_id IN \(\?,\?\)/.test(f1.sql), f1.sql)
ok('行级过滤参数正确', JSON.stringify(f1.params) === '["1","2"]', JSON.stringify(f1.params))

const a2 = checkAccess(db, { ...ctxA, action: 'approve' })
ok('显式拒绝优先：店长不能审批', a2.allowed === false && /deny/.test(a2.reason), JSON.stringify(a2))

// 无角色用户
const a3 = checkAccess(db, { userId: 999, dom: 'WH01', resource: 'sales_order', action: 'read' })
ok('无角色用户被拒', a3.allowed === false)
ok('无角色用户行级过滤 = 空集', compileRowFilter(db, { userId: 999, dom: 'WH01', resource: 'sales_order' }).sql === ROW_NONE)

// 有授权但无行级规则 = 全可见
grantPolicy(db, { roleCode: 'hq_admin', dom: '*', resource: 'inventory.stock', action: 'read', eft: 'allow' })
assignRole(db, { userId: 88, roleCode: 'hq_admin', dom: '*' })
ok('无限定规则时全可见', compileRowFilter(db, { userId: 88, dom: 'WH01', resource: 'inventory.stock' }).sql === ROW_ALL)

// 注入面：非法字段与非法操作符必须被忽略
threw = false
try { grantPolicy(db, { roleCode: 'x', resource: 'r', action: 'read', rowRules: [{ field: 'a', operator: 'drop', value: '1' }] }) }
catch (e) { threw = /不支持的操作符/.test(e.message) }
ok('非法操作符被拒绝', threw)

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
