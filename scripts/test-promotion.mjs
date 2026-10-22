/**
 * ============================================================================
 * 文件标识：scripts/test-promotion.mjs ｜ 测试：GML 促销引擎门禁测试（P1 · 促销域第一阶段）
 * ============================================================================
 * 【职责】测试：GML 促销引擎门禁测试（P1 · 促销域第一阶段）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// GML 促销引擎门禁测试（P1 · 促销域第一阶段）
//
// 用法：node scripts/test-promotion.mjs
//
// 覆盖 reusable/test-reusable.mjs 的促销断言（同组互斥 / 优先级裁决 / 防重复登记 /
// 防超发 / 回退），并补上**迁移脚本本身**的验证（建表 + 幂等 + verify 自检）。
// 全部跑在 :memory: 库上，不碰 data/ 下的业务库。
//
// 【为什么从 reusable/ 而不是 server/db/migrations/ 加载建表脚本】
// 促销表结构与工程主笔的批次计划（批次 F = 迁移 025）重叠，编号与表名都该由主线统一定，
// 故迁移脚本暂存 `reusable/promotion/promotion-migration.cjs`（不参与 runner 扫描），
// 待 025 批次落地时整体采用。**注意建表前必须先改 server/lib/pricing.js 的促销探测**，
// 详见该文件头注与 `INBOX_给主编写.md`。
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import {
  computePromotionActions, persistAdjustments, registerUsage, revertUsage,
  sortPromotions, listPromotions, getPromotionDetail, explainPromotion, PromotionError
} from '../server/lib/promotion.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const require = createRequire(path.join(ROOT, 'package.json'))
const migration = require(path.join(ROOT, 'reusable/promotion/promotion-migration.cjs'))

let pass = 0
let fail = 0
const failed = []
function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    fail++
    failed.push(name)
    console.log(`  \x1b[31m✗\x1b[0m ${name}  ${detail !== undefined ? '→ ' + detail : ''}`)
  }
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)

/**
 * 新建一个跑完 020 迁移的空库。
 *
 * 这里在归档迁移之上再补一次**已落地迁移的列**（`030_settlement_source` 的 `source`）：
 * `reusable/promotion/promotion-migration.cjs` 是**来源存档**，它的文件头写得很清楚
 * ——「若后续要改促销表结构，改 025，不要改本文件」。
 * 而 `promotion.js` 的落库函数自 030 起要求 `source`（通道），
 * 归档库不带这一列就会在 `persistAdjustments` 上抛 `no such column: source`。
 * 补列放在测试的建库函数里，而不是去改归档：**归档的意义就是"当时那一版"**。
 */
function freshDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migration.up(db)
  db.exec(`
    ALTER TABLE promotion_adjustments ADD COLUMN source TEXT NOT NULL DEFAULT 'oms';
    ALTER TABLE promotion_usages      ADD COLUMN source TEXT NOT NULL DEFAULT 'oms';
  `)
  return db
}

// ============================================================
section('T1 迁移脚本 020_promotion')
const db = freshDb()
const TABLES = [
  'promotion_campaigns', 'promotion_campaign_budgets', 'promotions',
  'promotion_rules', 'promotion_methods', 'promotion_usages', 'promotion_adjustments'
]
const tableNames = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name)
for (const t of TABLES) ok(`建表 ${t}`, tableNames.includes(t))
ok('迁移幂等：重复执行不报错', (() => { try { migration.up(db); return true } catch (e) { console.log(e.message); return false } })())
ok('迁移 verify() 自检通过', migration.verify(db) === true)

// ============================================================
section('T2 优先级裁决器')
ok('priority 数值小者先算', sortPromotions({ priority: 1 }, { priority: 2 }) < 0)
ok('同优先级：力度大者先算', sortPromotions({ priority: 1, method: { value: 900 } }, { priority: 1, method: { value: 500 } }) < 0)
ok('同优先级：买赠优先', sortPromotions({ priority: 1, type: 'buyget' }, { priority: 1, type: 'standard' }) < 0)
ok('同优先级同类型：按 code 稳定兜底（可重放）', sortPromotions({ priority: 1, code: 'A' }, { priority: 1, code: 'A' }) === 0)

// ============================================================
section('T3 同组互斥 + 折扣计算')
db.prepare(`INSERT INTO promotions (code,name,type,status,is_automatic,priority,stack_group,usage_limit)
            VALUES ('NEW10','新客九折','standard','active',1,10,'g1',1)`).run()
db.prepare(`INSERT INTO promotion_methods (promotion_id,type,target_type,allocation,value,value_scale)
            VALUES (1,'percentage','items','each',1000,0)`).run() // 1000 = 10.00%
db.prepare(`INSERT INTO promotions (code,name,type,status,is_automatic,priority,stack_group)
            VALUES ('VIP5','会员95折','standard','active',1,20,'g1')`).run()
db.prepare(`INSERT INTO promotion_methods (promotion_id,type,target_type,allocation,value,value_scale)
            VALUES (2,'percentage','items','each',500,0)`).run() // 5%

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
ok('同组互斥：只命中优先级更高的 NEW10',
  r1.appliedCodes.length === 1 && r1.appliedCodes[0] === 'NEW10', JSON.stringify(r1.appliedCodes))
ok('折扣额 = 13000 × 10% = 1300 分', r1.totalDiscount === 1300, `实际 ${r1.totalDiscount}`)
ok('被跳过的 VIP5 有原因记录（stack_group）',
  r1.traced.some((t) => t.code === 'VIP5' && t.skipped === 'stack_group'), JSON.stringify(r1.traced))

// ============================================================
section('T4 独占促销终止后续计算')
const dbX = freshDb()
dbX.prepare(`INSERT INTO promotions (code,name,type,status,is_automatic,priority,is_exclusive)
             VALUES ('FLASH','秒杀独占','standard','active',1,5,1)`).run()
dbX.prepare(`INSERT INTO promotion_methods (promotion_id,type,target_type,allocation,value)
             VALUES (1,'fixed','items','each',2000)`).run() // 直减 20 元
dbX.prepare(`INSERT INTO promotions (code,name,type,status,is_automatic,priority)
             VALUES ('NORMAL','常规九折','standard','active',1,10)`).run()
dbX.prepare(`INSERT INTO promotion_methods (promotion_id,type,target_type,allocation,value)
             VALUES (2,'percentage','items','each',1000)`).run()
const rx = computePromotionActions(dbX, ctx)
ok('独占命中后只算它自己', rx.appliedCodes.length === 1 && rx.appliedCodes[0] === 'FLASH', JSON.stringify(rx.appliedCodes))
ok('独占直减 2000 分 × 2 行 = 4000', rx.totalDiscount === 4000, `实际 ${rx.totalDiscount}`)
ok('后续活动被标记 exclusive_hit', rx.traced.some((t) => t.code === 'NORMAL' && t.skipped === 'exclusive_hit'))

// ============================================================
section('T5 落库留痕 + 使用登记（幂等 / 防超发 / 回退）')
persistAdjustments(db, { source: 'oms', orderId: 1001, actions: r1.actions })
const adj = db.prepare('SELECT COALESCE(SUM(amount),0) c FROM promotion_adjustments WHERE order_id = 1001').get()
ok('优惠留痕落库 = 1300', adj.c === 1300, `实际 ${adj.c}`)
ok('落库幂等：重复落库不叠加', (() => {
  persistAdjustments(db, { source: 'oms', orderId: 1001, actions: r1.actions })
  return db.prepare('SELECT COALESCE(SUM(amount),0) c FROM promotion_adjustments WHERE order_id = 1001').get().c === 1300
})())

const u1 = registerUsage(db, { source: 'oms', actions: r1.actions, orderId: 1001, customerId: 1 })
ok('首次登记成功', u1.registered === 1 && u1.skipped.length === 0, JSON.stringify(u1))
ok('used 计数 = 1', db.prepare('SELECT used FROM promotions WHERE id = 1').get().used === 1)

const u2 = registerUsage(db, { source: 'oms', actions: r1.actions, orderId: 1001, customerId: 1 })
ok('幂等：同一订单重复登记被拦', u2.registered === 0 && u2.skipped[0]?.reason === 'duplicate', JSON.stringify(u2))

const u3 = registerUsage(db, { source: 'oms', actions: r1.actions, orderId: 1002, customerId: 1 })
ok('防超发：超出 usage_limit 被拦',
  u3.registered === 0 && u3.skipped[0]?.reason === 'usage_limit_exceeded', JSON.stringify(u3))
ok('被拦后 used 未被加高', db.prepare('SELECT used FROM promotions WHERE id = 1').get().used === 1)

revertUsage(db, { source: 'oms', orderId: 1001 })
ok('回退后 used 归零', db.prepare('SELECT used FROM promotions WHERE id = 1').get().used === 0)
ok('回退后优惠留痕清空',
  db.prepare('SELECT COUNT(*) c FROM promotion_adjustments WHERE order_id = 1001').get().c === 0)

// ============================================================
section('T6 整单分摊（target_type=order）尾差归零')
const dbO = freshDb()
dbO.prepare(`INSERT INTO promotions (code,name,type,status,is_automatic,priority)
             VALUES ('ORDER10','整单九折','standard','active',1,10)`).run()
dbO.prepare(`INSERT INTO promotion_methods (promotion_id,type,target_type,allocation,value)
             VALUES (1,'percentage','order','across',1000)`).run()
const ctxOdd = {
  items: [
    { id: 1, qty: 1, subtotal: 3333, is_discountable: 1 },
    { id: 2, qty: 1, subtotal: 3333, is_discountable: 1 },
    { id: 3, qty: 1, subtotal: 3334, is_discountable: 1 }
  ],
  customer: {}, subtotal: 10000, codes: [], now: '2026-10-15 16:00:00'
}
const ro = computePromotionActions(dbO, ctxOdd)
ok('整单优惠额 = 10000 × 10% = 1000', ro.totalDiscount === 1000, `实际 ${ro.totalDiscount}`)
ok('分摊到 3 行且尾差被末行吸收',
  ro.actions.length === 3 && ro.actions.reduce((s, a) => s + a.amount, 0) === 1000, JSON.stringify(ro.actions))
ok('每行分摊额都不超过该行金额', ro.actions.every((a) => a.amount <= 3334))

// ============================================================
section('T7 限件数（allocation=once：只作用最便宜的 N 件）')
const dbN = freshDb()
dbN.prepare(`INSERT INTO promotions (code,name,type,status,is_automatic,priority)
             VALUES ('ONCE3','限三件九折','standard','active',1,10)`).run()
dbN.prepare(`INSERT INTO promotion_methods (promotion_id,type,target_type,allocation,value,max_quantity)
             VALUES (1,'percentage','items','once',1000,3)`).run() // 10%，最多 3 件
const rn = computePromotionActions(dbN, {
  items: [{ id: 1, qty: 5, subtotal: 25000, is_discountable: 1 }],
  customer: {}, subtotal: 25000, codes: [], now: '2026-10-15 16:00:00'
})
ok('once：基数只取 3 件 → 单价 50 元 × 3 × 10% = 1500',
  rn.totalDiscount === 1500, `实际 ${rn.totalDiscount}`)

dbN.prepare('UPDATE promotion_methods SET max_quantity = 5 WHERE promotion_id = 1').run()
const rnAll = computePromotionActions(dbN, {
  items: [{ id: 1, qty: 5, subtotal: 25000, is_discountable: 1 }],
  customer: {}, subtotal: 25000, codes: [], now: '2026-10-15 16:00:00'
})
ok('放宽到 5 件后 = 250 元 × 10% = 2500', rnAll.totalDiscount === 2500, `实际 ${rnAll.totalDiscount}`)

// ============================================================
section('T8 券码门槛 + 解释链 + 查询封装')
const dbQ = freshDb()
dbQ.prepare(`INSERT INTO promotions (code,name,type,status,is_automatic,priority,usage_limit)
             VALUES ('SUMMER','夏日券','standard','active',0,10,100)`).run()
dbQ.prepare(`INSERT INTO promotion_methods (promotion_id,type,target_type,allocation,value)
             VALUES (1,'percentage','items','each',1500)`).run()
dbQ.prepare(`INSERT INTO promotion_rules (promotion_id,rule_group,attribute,operator,value)
             VALUES (1,'rules','subtotal','gte','5000')`).run() // 满 50 元才可用

const noCode = computePromotionActions(dbQ, { ...ctx, codes: [] })
ok('非自动促销未输码 → 不生效',
  noCode.appliedCodes.length === 0 && noCode.traced.some((t) => t.skipped === 'need_code'))

const smallOrder = computePromotionActions(dbQ, { ...ctx, codes: ['SUMMER'], subtotal: 1000 })
ok('订单级门槛未达 → 不生效', smallOrder.totalDiscount === 0 && smallOrder.traced.some((t) => t.skipped === 'order_rule'))

const withCode = computePromotionActions(dbQ, { ...ctx, codes: ['SUMMER'] })
ok('输码且满足门槛 → 生效 15%', withCode.totalDiscount === 1950, `实际 ${withCode.totalDiscount}`)

const exp = explainPromotion(dbQ, { ...ctx, codes: ['SUMMER'] })
ok('解释链含结论头', /本单共优惠 19\.50 元/.test(exp.explanation), exp.explanation.split('\n')[0])
ok('解释链逐条列出活动', exp.lines.length >= 1 && /SUMMER/.test(exp.explanation))

const listed = listPromotions(dbQ, { status: 'active' })
ok('列表查询返回总数与标签', listed.total >= 1 && !!listed.list[0].status_label, JSON.stringify({ total: listed.total }))
ok('列表支持关键字过滤', listPromotions(dbQ, { keyword: '夏日' }).total === 1)
const detail = getPromotionDetail(dbQ, 'SUMMER')
ok('详情含应用方式与规则分组', !!detail.method && detail.rules.rules.length === 1)
ok('详情可查用券次数汇总', detail.usage_summary.used_count === 0)

let threw = null
try { getPromotionDetail(dbQ, 'NOT_EXIST') } catch (e) { threw = e }
ok('查不存在的促销抛 PromotionError(NOT_FOUND)', threw instanceof PromotionError && threw.code === 'NOT_FOUND', threw?.code)

threw = null
try { persistAdjustments(dbQ, { source: 'oms', actions: [] }) } catch (e) { threw = e }
ok('缺 orderId 抛 PromotionError(BAD_ARGS)', threw instanceof PromotionError && threw.code === 'BAD_ARGS', threw?.code)

// ============================================================
console.log(`\n${'─'.repeat(56)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) console.log('失败项：\n - ' + failed.join('\n - '))
process.exit(fail ? 1 : 0)
