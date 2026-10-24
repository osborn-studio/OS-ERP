/**
 * ============================================================================
 * 文件标识：server/db/seed.js ｜ 演示数据种子：`TABLES` 登记表（新表必须登记，否则重建不可复现）+ 确定性随机源 `rnd/R/RI/RF/PICK`
 * ============================================================================
 * 【职责】演示数据种子：`TABLES` 登记表（新表必须登记，否则重建不可复现）+ 确定性随机源 `rnd/R/RI/RF/PICK`
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自手写**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

import bcrypt from 'bcryptjs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { requireDemoRuntime } from '../runtime.js'
import { getDb, initSchema, getCurrentIndustry, INDUSTRIES, runWithIndustry, dbPathFor } from './index.js'
import { buildDataset } from './datasets.js'
// 批次号不走 nextBatchNo：它的随机段是 Math.random，批次号会进拣选排序，
// 一变整库就不可复现（见下方 seedBatchNo 说明）。
import { nextDocNo } from '../lib/docno.js'
import { applyStockIn, applyStockOut, reserveStock, releaseStock, pickBatches } from '../lib/stock.js'
import { pruneOrphanEvents } from '../lib/docflow.js'

// ============ 工具 ============
//
// 确定性随机：**整库重建必须可复现**（同一份 seed 代码 + 同一份数据集 → 逐字节一样的库）。
// 这里原来直接用 `Math.random()`，后果是每重建一次门店/商品/单据的取值都不同，
// 凡是「按某一张具体的单写断言」的测试就随机失败 —— 批次 C 收尾时连跑 6 轮，
// 失败点在 `test-costing` / `test-purchase` / `test-quote-credit` 之间游走，且单跑必然通过，
// 排查成本极高（真因是「数据每次都不一样」，不是代码有分支没覆盖）。
//
// 为什么值得改而不是「让测试迁就随机数据」：
//   ① 演示库不可复现，等于**同一句话不能重复验证** —— 出了问题也回不到现场；
//   ② 随机失败会被当成噪音忽略，真正的缺陷混在里面就再也没人看；
//   ③ 改动很小且集中：全部随机都经由下面四个工具函数，把随机源换掉即可。
//
// mulberry32：小、快、无依赖，演示数据用足够（不需要密码学强度）。
// 种子固定，所以「重建 → 复现」是逐字节成立的。
const SEED_RANDOM_STATE = 20261015
let _rndState = SEED_RANDOM_STATE
const rnd = () => {
  _rndState = (_rndState + 0x6d2b79f5) | 0
  let t = Math.imul(_rndState ^ (_rndState >>> 15), 1 | _rndState)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
/** 重置随机序列：整库重建开始时调用，保证多行业连灌互不影响 */
export function resetSeedRandom() {
  _rndState = SEED_RANDOM_STATE
}
const R = (arr) => arr[Math.floor(rnd() * arr.length)]
const RI = (min, max) => Math.floor(rnd() * (max - min + 1)) + min
const RF = (min, max) => Number((rnd() * (max - min) + min).toFixed(2))
const PICK = (arr, n) => [...arr].sort(() => rnd() - 0.5).slice(0, n)

// ---------------------------------------------------------------------------
// 灌数时钟：**整库重建全程冻结在同一个时刻**。
// 实现与理由见 ./seed-clock.js；这里只做转发，让 seed 内部照旧写 `seedNow()`。
import { resetSeedClock, seedNow } from './seed-clock.js'
export { resetSeedClock }
const dayAgo = (n) => new Date(seedNow().getTime() - n * 86400000)
const ymd = (dt) => dt.toISOString().slice(0, 10)

/**
 * 批次号（seed 专用）。
 *
 * 格式与 `lib/docno.js` 的 `nextBatchNo` 完全一致（SKU 码后 6 位 + YYMM + 三位随机），
 * 但随机段走**确定性随机**。为什么不直接用 `nextBatchNo`：那里用的是 `Math.random()`，
 * 而**批次号会参与拣选排序**（FIFO 取批要按批次/效期排），批次号一变，
 * 同一次拣选取到的批次就变，库存结存与成本跟着变 —— 整库重建依然不可复现。
 * 运行时（收货/委外建批次）仍用 `nextBatchNo`：那里本来就需要真随机，且不在 seed 里。
 */
const seedBatchNo = (skuCode, dateStr) => {
  const d = dateStr ? new Date(dateStr) : seedNow()
  const yy = String(d.getFullYear()).slice(-2)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const rand = Math.floor(rnd() * 900 + 100)
  return `${String(skuCode).replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase()}${yy}${mm}${rand}`
}
const ymdhms = (dt) => dt.toISOString().slice(0, 19).replace('T', ' ')
const addMonths = (dt, m) => {
  const d = new Date(dt)
  d.setMonth(d.getMonth() + m)
  return d
}
const addDays = (dt, n) => new Date(new Date(dt).getTime() + n * 86400000)
const now = () => seedNow()

// **单一随机入口**：卫星 seed（`*-seed.js`）必须从这里取随机数与时间工具，
// 不允许自己再建一个 `Math.random()` 或第二套 mulberry32。
// 理由与上面同一段：随机源一旦有第二个入口，`resetSeedRandom()` 就管不到它，
// 于是「整库重建逐字节可复现」在那一块数据上悄悄失效 —— 而它不会报错。
export { rnd, R, RI, RF, PICK, seedNow, ymd, dayAgo, addDays, seedBatchNo, ymdhms }

// ============ 主数据（按行业数据集注入，见 ./datasets.js） ============
// 化妆品 / 服装两个行业各自独立的主数据：品牌、品类、商品（服装为「颜色 × 尺码」矩阵
// SKU）、仓库、门店、供应商、经销商、电商平台与组合装（BOM），由 buildDataset() 选择。
// 以下为行业无关的通用主数据：
const EXPRESS = ['顺丰速运', '中通快递', '圆通速递', '京东物流', '韵达快递']
const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭']

function mockReceiver(D) {
  const c = R(D.cities)
  return {
    name: `${R(SURNAMES)}${R(['女士', '先生'])}`,
    phone: `${R(['138', '139', '136', '150', '158', '186', '188', '199', '177'])}****${RI(1000, 9999)}`,
    address: `${c[0]}${c[1]}${c[2]}`
  }
}
function expressNo() {
  return `${R(['SF', 'ZT', 'YT', 'JD'])}${RI(100000000000, 999999999999)}`
}

// ============ 清库 ============
export const TABLES = [
  // 流转留痕必须在整库重建时一起清掉，而且必须排在最前面说明理由。
  // 它是**唯一一张跨所有单据类型的旁支表**：行按 (doc_type, doc_id) 指向各自的主表，
  // 而主表重建后自增 id 会被**复用**，于是上一代的留痕看起来仍然「指着一张存在的单」，
  // 不会被任何按 id 的孤儿检查发现，只会表现成两件坏事：
  //   ① 单据时间线错挂 —— 新建的草稿单里写着「已质检」，实测三库已中招 53 条 INS 留痕；
  //   ② 体积白涨 —— 实测三库共 2 万+ 条留痕，其中 99% 指向不存在的单据（PRQ/PI/PST/PAY 各约 99%）。
  // 留痕由 seed 与 applyTransition 重新生成，所以清掉不会丢信息，只是把「上一代的一生」抹掉。
  'doc_events',
  // 取号计数器：整库重建后**必须一起清**，否则「重建」出来的演示数据每一轮都不一样。
  //
  // 起因是一次真实的排查：全量回归时好时坏，失败点在 `test-costing` / `test-purchase` /
  // `test-quote-credit` 之间游走，且每次单跑都通过。根因就是这张表没被清 ——
  // 业务表全清空了，计数器却按上一代的末号继续发号，于是同一批演示数据在两次重建后
  // 拿到不同的单号（如 `PST202610090126` → `PST202610090146`）。
  // 单号一旦参与排序，「第一张可回写的结算单」「进度最靠前的采购订单」就换了人，
  // 而测试是按「某一张具体的单」写断言的 —— 表现成随机失败。
  //
  // 计数器是**派生状态**（它表示「上一代发到哪了」），上一代的单据已经不存在了，
  // 留着毫无意义；清掉之后同一份 seed 代码重建出的库是**逐字节可复现**的，
  // 这才是「整库重建」应有的语义。
  'doc_no_counters',
  // ---------------------------------------------------------------------------
  // 单据内核与审批流的**定义表**：整库重建时也要 DROP。
  //
  // 这几张表不在业务数据里，但在本流程里必须一起清 —— 因为 `resetDatabase()` 之后
  // `initSchema()` 会重跑一遍迁移，而 008 / 014 的 `up()` 是「先 DELETE 再 INSERT」
  // 的定义同步写法。表如果留着，`sqlite_sequence` 也跟着留着，于是每重建一次
  // `doc_states.id` 就往后长一整代（13008 → 13180 → 13352 …），`doc_actions` /
  // `biz_flow_steps` / `approval_steps` 同理。
  //
  // 危害不是体积，是**整库不可复现**：这几张表的 id 出现在别的表里
  // （审批实例指向模板、单据状态被流程节点引用），于是「同一份 seed 重建两次」
  // 拿不到同一张库，逐表比对永远合不上。DROP 掉之后序列清零，迁移重灌时从 1 开始。
  //
  // 顺带解决一个更隐蔽的存量问题：`approval_instances` / `approval_records` 此前
  // **从不清理**，而它们按 id 指向 `oc_orders` —— 订货中心的单重建后 id 会复用，
  // 旧审批实例于是「看起来仍指向一张存在的单」，任何按 id 的孤儿检查都发现不了。
  'approval_records', 'approval_instances', 'approval_steps', 'approval_templates',
  'biz_flow_steps', 'biz_flows', 'doc_actions', 'doc_states', 'doc_types',
  // 流转策略（027）：定义表。跟 doc_types 一起 DROP —— 027 的 verify 会发现表缺失判为脱节，
  // 由 runner 自愈重跑 up 重灌策略行（与 doc_types / member_levels 同一个机制）。
  'doc_transition_policy',
  'store_shipment_items', 'store_shipments',
  'demand_plan_runs', 'production_order_items', 'production_orders',
  // 模块 10B：BOM 与制造执行。BOM 是**主数据**，领料与完工汇报是**派生物**
  // （由 seed 按 BOM 展开 → 出库 → 完工入库重放出来），一并清掉不丢信息。
  // 漏掉 `material_issue_items` 而只清表头的后果与缺陷十三同类：
  // 行还在、头没了，视图 `v_production_progress` 汇总出的领料额会凭空多出一截。
  'work_reports', 'material_issue_items', 'material_issues', 'bom_items', 'boms',
  'dealer_requisition_plans', 'dealer_requisition_items', 'dealer_requisitions',
  'outsourcing_receipt_items', 'outsourcing_receipts', 'outsourcing_material_items', 'outsourcing_materials',
  'outsourcing_order_items', 'outsourcing_orders',
  'store_requisition_items', 'store_requisitions',
  // qimen_nonces（060）按 platform_id 记已接受的 nonce；重建后平台 id 会被复用，旧 nonce 会让新一代平台的合法请求被判重放，所以必须清
  'ai_query_logs', 'audit_logs', 'audit_chain_anchors', 'oms_sync_logs', 'oms_order_items', 'oms_orders', 'qimen_nonces', 'platforms',
  'mall_cart_items', 'mall_customers', 'pos_daily_closes', 'pos_shifts', 'pos_order_items', 'pos_orders',
  // 模块 17 交班缴款（024）：三张新表必须登记 —— 缴款明细引用班次 id、班次差异行引用班次 id，
  // 而重建后 `pos_shifts` 的 id 会被**复用**，旧明细看起来仍然「指向一个存在的班次」，
  // 任何按 id 的孤儿检查都发现不了。后果是 `UNIQUE (shift_id)` 被上一代的旧行占着，
  // 新一代的班次永远缴不了款 —— 表现是「缴款按钮点了报『已缴过款』」，而界面上一分钱都没缴过。
  // 顺序：子表先于父表（items 引用 drops，payments 引用 shifts）。
  'pos_shift_payments', 'pos_cash_drop_items', 'pos_cash_drops',
  // 商城促销与会员（模块 18 / 迁移 025）。
  //
  // 为什么促销域必须清：`promotion_adjustments` 挂着**订单行优惠**，`promotion_usages`
  // 挂着**订单与客户**，两者都按 id 指向 `sales_orders` / `mall_customers` ——
  // 而重建后这些父表的自增 id 会被**复用**，旧留痕看起来仍然「指向一张存在的单」，
  // 任何按 id 的孤儿检查都发现不了。后果有两处且都不报错：
  //   ① 订单详情会显示上一代的优惠说明（"这一单为什么减了 130 元"给出的是别人的答案）；
  //   ② `promotion_usages.idempotency_key` 是 `order:<id>:promo:<code>` ——
  //      旧行占着新一代同号订单的幂等键，于是新订单**登记不上使用**，
  //      表现是「限量券明明有名额却提示已达上限」。
  //
  // 为什么会员域必须清：`member_accounts` 是**派生余额**（= 两本流水之和），
  // 不清就会跨代累积成一批「余额对不上流水」的账户 —— 而 `auditMember` 会直接报出来，
  // 于是 verify-seed 变成永久失败（与模块 24「取消缴款残渣」同类的坑，
  // 只是这次的残渣不是脏数据，而是**上一代的合法数据**）。
  //
  // 为什么券域必须清：`coupon_instances.coupon_code` 唯一，旧实例会占住券码；
  // 且 `issued_qty` 与实例数一旦跨代，`total_qty` 的防超发就会误判。
  //
  // 顺序：先子后父（adjustments/usages/methods/rules 引用 promotions；
  // instances 引用 coupons 与 promotions；两张流水引用 accounts）。
  // `member_levels` 是**定义表**（等级档位在迁移里声明），清掉后由 025 的 verify
  // 判为脱节并自愈重跑 up 重灌 —— 与 `doc_types` 那批定义表同一个机制。
  'promotion_adjustments', 'promotion_usages', 'promotion_methods', 'promotion_rules',
  'promotions', 'promotion_campaign_budgets', 'promotion_campaigns',
  'coupon_instances', 'coupons',
  'member_points_ledger', 'member_balance_ledger', 'member_accounts', 'member_levels',
  'dealer_statements', 'dealer_rebates', 'rebate_policies',
  // 渠道协议价与返利核销（批次 G / 迁移 031）。
  // 为什么必须清：`rebate_settlements` 是**已冲应收的凭证**，`dealer_rebates.settlement_id`
  // 指向它 —— 重建后 `dealers.id` 会被复用，旧核销单看起来仍然「指向一个存在的经销商」，
  // 任何按 id 的孤儿检查都发现不了。后果是「这张核销单冲的是上一代那家客户」，
  // 而账龄与客户汇总照算。`price_agreements.dealer_id` 同理。
  // 顺序：子先于父（items 引用 settlements）。
  'price_agreements', 'rebate_settlement_items', 'rebate_settlements',
  // 退款单（批次 J）：它是**业务单据**（有状态、有明细、有出账后果），
  // 不是配置也不是派生 —— 整库重建时必须清掉，否则跨代的退款单会挂在
  // 已被复用的退货单 id 上（"这笔退款退的是哪张退货单"从此答错）。
  'refund_items', 'refunds',
  // 业财一体凭证（批次 H / 迁移 032）。
  // 为什么必须清：`vouchers.source_id` 指向**上一代的业务单据 id**。重建后
  // `purchase_receipts.id` / `sales_deliveries.id` / `receipts.id` 会被复用，
  // 旧凭证于是"看起来指向一张真实存在的单"，任何按 id 的孤儿检查都发现不了，
  // 而试算平衡表会把这些上一代的凭证一起算进来 —— 一本账里混进了两代业务。
  // 顺序：子先于父（entries 引用 vouchers，template_entries 引用 templates）。
  'voucher_entries', 'vouchers', 'voucher_template_entries', 'voucher_templates', 'accounting_subjects',
  // 报表体系（批次 L / 迁移 034）。
  // 为什么必须清：
  //   · `report_lines` / `report_defs` 是**会计政策**（配置），但它们在界面上可改 ——
  //     整库重建的语义是"回到 seed 那份定义"，不清就会把上一代改过的口径带到新一代；
  //   · `accounting_opening_balances` 是**人录进来的期初账**，它按 `subject_id` 指向科目，
  //     而科目表也在重建清单里（id 会被复用）—— 不清的话期初会挂到"另一个科目"上，
  //     而那正是"资产负债表差一个数"最隐蔽的来源；
  //   · `accounting_periods` 的 `closed` 状态会**挡住新流水过账**（与 `cost_periods` 同一个坑，
  //     那一行早就立过这条理由）。上一代关过账的期间留到新一代，表现是"演示库突然记不了账"。
  //   · `period_audit_log`（批次 Q / 迁移 037）是上一代的**动作历史**：它按 `period` 与
  //     凭证 id 记录"谁把这一期改成了什么样"，而这两样在重建后都会指向新一代 ——
  //     一张上一代的结转凭证日志会**看起来指向一张真实存在的凭证**（id 被复用），
  //     而审计链自证会当场报 `PERIOD_AUDIT_DESYNC`（"这一期的现状重放不出来"）。
  //     重建后由 seed 自己的 `closePeriod` / `carryForward` 重新写一份，**不需要迁移再回填基线**。
  // 顺序：子先于父（opening / log 引用 subjects / periods；lines 引用 defs）。
  'accounting_opening_balances', 'accounting_periods', 'period_audit_log', 'report_lines', 'report_defs',
  'assembly_order_items', 'assembly_orders', 'bundle_components', 'bundles', 'serial_numbers', 'warehouse_locations',
  'sales_return_items', 'sales_returns', 'sales_delivery_items',
  'sales_deliveries', 'sales_order_items', 'sales_orders', 'stock_check_items', 'stock_checks',
  'stock_transfer_items', 'stock_transfers', 'inventory_transactions', 'inventory_stocks',
  // 批次主档与占用：**必须跟库存一起重建**，否则会跨重建累积成脏数据。
  // 真实踩到：这一行原来漏了，于是 `inventory_batches` 攒到 21,865 行 ——
  // 因为历史上批次号的随机段是 Math.random，每次重建都产生一批全新的 (sku,batch_no)，
  // 旧行一条都不会被复用、也不会被清掉。危害不止是体积：
  //   ① `pickBatches` 会 LEFT JOIN 它取 qc_status / batch_status，**过保/禁售/质检不合格
  //      的旧批次记录会盖在新批次上**，拣选结果凭空少几个批次；
  //   ② 批次主档的 status / qc_status 在 ON CONFLICT 时**不更新**（只更效期和来源），
  //      所以一个批次一旦在某一代被判为不可用，后面每一代都跟着不可用 —— 状态回不来；
  //   ③ 结果是整库重建不完全可复现：库存行数在 779/780 之间来回跳（两代一轮回），
  //      凡按具体批次写断言的测试就随机失败。
  // 顺序：占用先于批次（reservations 引用批次），批次先于库存（批次是库存的效期依据）。
  'inventory_reservations', 'inventory_batches',
  // 成本流水台账：只记「每次出入库让结存单价/金额从多少变成多少」，是**派生表**。
  // 它此前不在重建清单里，于是每重灌一次就多叠一代旧行（旧行指向已重建过的仓库/SKU id）——
  // 平时看不出来（没有任何页面读它），但模块 09 把它当作「成本变动可回溯」的证据，
  // 混代之后这句话就不成立了。seed 全程走 applyStockIn/applyStockOut，会重新写一遍，所以清掉不丢信息。
  'stock_cost_ledger',
  // 成本期间与期末快照：快照是「结转那一刻的结存」，重建库存后它指的那批货已经不存在了，
  // 留着会让下一期的期初凭空多出一批货。期间记录同理（closed 状态还会挡住新流水）。
  'cost_period_balances', 'cost_periods',
  // 成本调整单：引用结算单 id，而整库重建时结算单被清空、id 会被复用 ——
  // 于是上一轮的调整单看起来仍然「指向一张存在的结算单」，不会被孤儿检查发现。
  // 后果是「暂估差异」那一栏永远显示已调整，而实际差异还没处理。
  'cost_adjustment_items', 'cost_adjustments',
  // 质检单必须跟到货单一起重建：质检单引用到货单 id，而重建后 id 会被**复用**，
  // 于是上一轮的质检单看起来仍然「指向一张存在的到货单」，不会被当作孤儿清掉。
  // 后果很隐蔽：新建质检单直接撞 uq_inspection_receipt（唯一约束），
  // 而这个错误只在带 try/catch 的调用处被吞掉 —— 表现是「质检功能点了没反应」。
  'purchase_inspection_items', 'purchase_inspections',
  // 销售报价与信用控制（模块 08A）：报价单引用经销商与商品，信用账户由经销商派生，
  // 两者都在本次重建里被 DROP，引用关系必须一起重建，否则留下一批指向已复用 id 的孤儿。
  'sales_quote_items', 'sales_quotes',
  'credit_check_logs', 'credit_ledger', 'credit_accounts',
  // 应收与收款核销（模块 21）：应收单引用销售订单 id，收款单的核销明细又引用应收单 id。
  // 重建后 sales_orders 的 id 会被复用，留着就等于「这笔钱抵的是另一张单」——
  // 账面上看不出来，但账龄与对账单会全错。必须跟着一起清。
  // 授信释放台账（迁移 052）引用收款单 id：必须先于 receipts 清，否则重建后指向被复用的 id。
  'credit_release_ledger', 'receipt_allocations', 'receipts', 'ar_documents',
  // 销售发票（模块 24）：发票行与关联表分别引用发票头、发货行、应收单，而重建后这些 id 全会被复用。
  // 漏掉的后果非常隐蔽 —— 旧发票看起来仍指向「存在的发货行」，任何按 id 的孤儿检查都发现不了，
  // 但开票关闭会算错（旧的已开票量被算到新一代的发货单头上），审计只报「超开发票」，
  // 查不出是重建不彻底造成的。本轮真实踩到：force 重灌后旧发票残留在库，误报 3 处超开 + 5 处孤儿关联。
  // 顺序：先子表后父表（links/items 引用 invoices），invoices 又引用 ar_documents（已在上方清理）。
  'invoice_ar_links', 'sales_invoice_items', 'sales_invoices',
  // 质量检验（模块 13）：报检行引用报检头，处理单引用检验单，而检验单又引用报检单 ——
  // 三者都必须清。漏了的后果与上一批发票那次完全一样：旧单据看起来仍指向「存在的单据」，
  // 按 id 的孤儿检查一个都发现不了，只有质检自洽审计会报「处置超量」这类莫名其妙的错。
  // 顺序：先子后父（handlings → inspections → request_items → requests）；
  // 处理单若产生过采购退货（PRT），由下面的 purchase_returns 一并清理，不重复登记。
  'qc_defect_handlings', 'qc_inspections', 'qc_request_items', 'qc_requests',
  'purchase_return_items', 'purchase_returns', 'purchase_receipt_items', 'purchase_receipts',
  'purchase_order_items', 'purchase_orders', 'product_skus', 'products', 'categories', 'brands',
  'warehouses', 'stores', 'suppliers', 'dealers',
  // user_roles / user_orgs 外键指向 users，必须先于 users 清理，
  // 否则重灌后残留行仍指向已删除的用户 id（FK 在 DROP 期间被关掉，不会报错）
  'user_roles', 'user_orgs',
  'users', 'settings',
  // ---- 改价留痕 ----
  // 与 `doc_events` 同性质的**跨表旁支留痕**（行按 entity / entity_id 指向
  // `price_groups` / `price_agreements` / `product_skus`）。漏清它有两层后果：
  //   ① **重建不可复现** —— 实测三库每轮重建各 +7 条（协议价造 7 条协议，每建一条写一条留痕），
  //      两次 `--force` 重建的指纹必然不一致（`verify-reseed` 抓到的**第一个也是唯一一个**漂移项）；
  //   ② **跨代混账** —— 重建后价格记录的自增 id 被复用，上一代的"改价历史"看起来仍指着现存的价格。
  // 留痕由 `logPriceChange` 重新生成，清掉不丢信息，只是把"上一代的一生"抹掉。
  'price_change_logs',
  // ---- 配置变更留痕（批次 R）----
  // 与 `price_change_logs` **完全同类**：一张只追加的留痕表，行按 `key` 指向 `settings`。
  // 漏清的后果也一样 —— 重建后配置值被重灌（`ensureSettings` 按登记表补齐），
  // 而上一代的日志还在，于是"重放日志得到的值"与"库里的值"对不上，
  // 探针 `SETTING_AUDIT_DESYNC` 会报一整片**假红**（对着一个刚重建的、完全正确的库报错）。
  // 清掉它不丢信息：基线由 `ensureSettings` 重新补，而"上一代有人把税率从 13 改成 9"
  // 这件事本来就该随那一代一起消失（它不是这一代的历史）。
  'setting_audit_log',
  // ---- 报表口径变更留痕（批次 S）----
  // 与 `setting_audit_log` 同一类：只追加的留痕表，行按 `report_code`（+ `line_code`）
  // 指向 `report_defs` / `report_lines`。**必须跟被它记录的这两张表一起清** ——
  // 而这两张表本来就在清理清单里（见下面 `report_lines` / `report_defs` 那两行）。
  // 顺序：日志先于目标（日志指向目标，虽然不做外键，但概念上是子先于父）。
  // 不清的后果与批次 R 一样，而且更刺眼：重建后口径行被整段重建
  // （`seedReport` 先 `DELETE` 再插），自增 id 全部重排 —— 上一代的日志会
  // **看起来指向一张真实存在的口径行**，而重放得到的行号/科目区间与现状对不上，
  // 探针 `REPORT_CONFIG_AUDIT_DESYNC` 会对着一本**完全正确的新账**报一整片假红。
  'report_config_audit_log',
  // ---- MCP 运行痕迹 ----
  // `mcp_idempotency` **必须清**：它按 `idempotency_key` 缓存"首次执行结果"，
  // 重建后自增 id 被复用，重放会返回**上一个世界**的结果 —— 与 `doc_events` 同一类跨代引用。
  // 待确认单（`mcp_confirmations`）与调用日志（`mcp_call_logs`）同属运行痕迹，
  // 重建后没有保留价值（`audit_logs` / `ai_query_logs` 早就在这份清单里，口径一致）。
  'mcp_idempotency', 'mcp_confirmations', 'mcp_call_logs',
  // AE9：MCP 限速桶（GML_MCP_RATE_STORE=db 时的窗口计数）。没有跨重建的保留价值，随运行痕迹一起清。
  'mcp_rate_buckets',
  // ---- IM（钉钉/飞书）同步痕迹（批次 T）----
  // 与 `mcp_idempotency` 同一类：三张映射表里存的是**外部 id → 本地自增 id**（`org_id` /
  // `gml_user_id` / `approval_id`）。重建会把这些本地 id 全部重排，于是上一代的映射会
  // **看起来指向一张真实存在的组织/用户/审批**，而它其实是另一代的东西 ——
  // 这正是"跨代引用"最坏的形态：没有一行是孤儿，所以任何孤儿检查都发现不了。
  // 冲突台账（`im_sync_conflicts`）与同步流水（`im_sync_runs`）同属运行痕迹，一起清。
  // 顺序：子先于父（冲突 → 流水 → 审批映射 → 成员映射 → 部门映射）。
  // 不清的后果还有一层：两次 `--force` 重建的指纹必然不一致（`verify-reseed` 会抓到）。
  'im_sync_conflicts', 'im_sync_runs', 'im_approval_map', 'im_user_map', 'im_dept_map'
]

/**
 * 「有意**不**清」的表 —— 与 `TABLES` 合起来构成完整清单（库里所有表必须落在两者之一）。
 *
 * 为什么需要这份清单：`TABLES` 漏掉一张表的表现**不是报错**，而是
 * 「重建不可复现」或「跨代引用」这类很久以后才暴露的问题（`price_change_logs` 就是）。
 * 把"有意保留"显式写出来，才能让**新增表忘记登记**这件事在 `verify-seed` 里立刻变红。
 *
 * 三类（每类都写明归属，"不管"与"别人管"必须能分开）：
 *   A. **迁移与定义**：清了等于把"我已经迁移到第几版"抹掉 —— 绝不归清库管。
 *   B. **由 satellite seed 自己清**（`DELETE` + `resetSequences`）：采购域 / 订货中心 / 报价信用。
 *      它们自带 `ownedTables` 与序列复位，登记在这里是**声明归属**，不是"不管"。
 *   C. **幂等 upsert 的配置与字典**：组织权限 / 价格本 / 字典 / 凭据 / 指标定义。
 *      每次重建都按同一份定义 upsert，内容不随代数变。
 */
export const KEEP_TABLES = [
  'os_egp_runtime',
  // D. FTS5 外部内容表的影子表（迁移 067）：由 audit_logs 上的触发器与 FTS 引擎维护，
  //    清 audit_logs 时触发器同步清索引；**绝不直接 DELETE** 这些表（会让索引与内容表失配）。
  'audit_logs_fts', 'audit_logs_fts_data', 'audit_logs_fts_idx', 'audit_logs_fts_docsize', 'audit_logs_fts_config',
  // A. 迁移与定义
  'schema_migrations', 'schema_def_fingerprints',
  // B. satellite seed 自清（procure-seed 的 ownedTables / oc-seed / quote-seed）
  'payment_release_ledger', 'purchase_payment_items', 'purchase_payments',
  'purchase_settlement_items', 'purchase_settlements',
  'purchase_invoice_items', 'purchase_invoices',
  'purchase_requisition_items', 'purchase_requisitions',
  'supplier_price_logs', 'supplier_products',
  'oc_addresses', 'oc_approval_rules', 'oc_credit_ledger', 'oc_customers',
  'oc_order_approvals', 'oc_order_items', 'oc_orders',
  'oc_statement_items', 'oc_statements', 'oc_visibility_rules',
  // C. 幂等 upsert 的配置与字典
  'orgs', 'org_functions', 'org_brands', 'roles', 'permissions', 'role_permissions',
  'doc_no_rules', 'inv_params', 'inv_txn_types', 'metric_defs',
  'notify_channels', 'notify_logs',
  // IM 平台配置：与 `notify_channels` 同性质 —— 是"配置"不是"数据"，
  // 重建时**保留**（不清）。它的行由迁移 040 与运行时的 `ensureImPlatforms` 幂等 upsert，
  // 而"这个平台接没接、凭据在哪"是运维的事实，不该被一次重建抹掉。
  'im_platform_cfg',
  // 现金流量项目字典（批次 U / 迁移 041）：与 `metric_defs` / `doc_types` 同性质 ——
  // 它是一份**幂等 upsert 的会计口径字典**，行由迁移 041 的 `INSERT OR IGNORE` 灌进去，
  // 内容不随代数变。所以重建时**保留**，不清。
  //
  // 为什么不能清：分录上的标记（`voucher_entries.cash_flow_item`）存的是**项目 code**，
  // 而 `voucher_entries` 在重建清单里（跟着凭证一起重建）。清掉字典而留着标记，
  // 就会出现"标着一个字典里没有的项目"——那一笔会静默退回按对手科目分析填列，
  // 而 `auditReport` 的 `CF_ITEM_UNKNOWN` 会对着一本完全正确的账报红。
  // 顺带说清反面：**分录上的标记本身是数据**（会计一条条标的），它随凭证一起清，
  // 这是对的 —— 业务单据都被重建了，旧的标记指向的分录已经不存在了。
  'cash_flow_items',
  'agent_tokens', 'agent_token_roles',
  'price_groups', 'price_group_items', 'price_group_targets', 'price_rules', 'member_prices'
]

export function resetDatabase() {
  requireDemoRuntime()
  const db = getDb()
  db.exec('PRAGMA foreign_keys = OFF')
  // 先删视图，再删表。
  // 视图引用业务表（如 v_ar_aging_detail 引用 ar_documents），若先删表，
  // SQLite 在之后任何一次 DDL 解析 schema 时都会报「error in view ... no such table」——
  // 报错点还会落在完全无关的迁移上（本轮真实踩到：炸在 002 的 db.exec）。
  // 这里动态枚举而不是硬编码清单：将来再加视图不会再踩同一个坑。
  // 视图由 020 迁移的 verify 自检负责重建（视图缺失即判为脱节并重跑 up）。
  for (const v of db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all()) {
    try {
      db.prepare(`DROP VIEW IF EXISTS ${v.name}`).run()
    } catch {
      /* 视图可能已被删除 */
    }
  }
  for (const t of TABLES) {
    try {
      db.prepare(`DROP TABLE IF EXISTS ${t}`).run()
    } catch {
      /* 表可能不存在 */
    }
  }
  db.exec('PRAGMA foreign_keys = ON')
}

// ============ 主流程 ============
export function seedAll({ silent = true } = {}) {
  requireDemoRuntime()
  getDb() // Validate persisted database classification before changing the seed clock or data.
  // 每个行业从同一个随机起点灌数 —— 这样「先灌哪个行业」不影响结果，
  // 三库各自可复现（否则上个行业多抽了几次随机数，下个行业整库就跟着变）。
  resetSeedRandom()
  // 时钟同理：整库重建全程共用同一个「现在」，跨零点也不会自相矛盾。
  resetSeedClock()
  const industry = getCurrentIndustry()
  const D = buildDataset(industry)
  const {
    brands: BRANDS, categories: CATEGORIES, products: PRODUCTS, serialSpus: SERIAL_SPUS,
    warehouses: WAREHOUSES, stores: STORES, suppliers: SUPPLIERS, dealerSeeds: DEALER_SEEDS,
    platforms: PLATFORMS, buyerNicks: BUYER_NICKS, cities: CITIES, emoji: EMOJI,
    materialPrefix: MATERIAL_PREFIX, outsourceSpus: OUTSOURCE_SPUS, selfSpus: SELF_SPUS
  } = D

  // ---------- 行业相关的批次效期口径 ----------
  // 美妆/服装是「月」级保质期（36 个月），生产日期可以取半年前；
  // 餐饮是「天」级短保（净菜 3~5 天、料理包 20~45 天），
  // 若沿用 120~700 天前的生产日期，会造出一整库天然过保的批次 —— 演示时拣选全被禁售拦掉。
  // 因此这两件事必须由数据集声明，不能写死。
  const SHELF_UNIT = D.shelfUnit || 'month'                 // 'month' | 'day'
  const LOOKBACK_INIT = D.produceLookback || [120, 700]      // 期初库存批次：距今 N 天
  const LOOKBACK_STORE = D.storeProduceLookback || [40, 120] // 门店铺货批次：距今 N 天
  const LOOKBACK_RECEIPT = D.receiptProduceLookback || null  // 采购收货批次：距今 N 天（null=与订单日期挂钩）
  const INIT_BIZ_DAYS = D.initBizDateDaysAgo ?? 181          // 期初库存业务日期：N 天前

  /** 按数据集的保质期单位加时长（'day' 加天，'month' 加月） */
  const shelfAdd = (produce, n) => (SHELF_UNIT === 'day' ? addDays(produce, n) : addMonths(produce, n))
  /**
   * 由生产日期 + 保质期算出效期。
   * @param produce  生产日期
   * @param shelf    保质期（单位由 shelfUnit 决定：月 / 天）
   * @param fallback shelf=0（未声明保质期）时的兜底值，**与 shelf 同单位**；0 表示不给效期
   */
  const expireOf = (produce, shelf, fallback = 0) => {
    if (shelf > 0) return shelfAdd(produce, shelf)
    return fallback ? shelfAdd(produce, fallback) : null
  }
  /** 统一出串：效期为空则落 NULL（列可空，不要用空串） */
  const ymdOrNull = (d) => (d ? ymd(d) : null)
  /** 采购收货批次的生成日期 */
  const receiptProduceDate = (orderDaysAgo) =>
    LOOKBACK_RECEIPT ? dayAgo(RI(LOOKBACK_RECEIPT[0], LOOKBACK_RECEIPT[1])) : dayAgo(orderDaysAgo + RI(0, 30))

  // 不变量：批次生产日期的回溯窗口，必须**严于**最短保质期。
  // 反例：保质期 3 天的鲜活水产，若生产日期取 4 天前，这条批次一入库就是过保状态，
  //       而 inv_params.block_expired 默认禁售 → 该 SKU 在演示里直接卖不出去。
  // 这类错**不会报错**，只会表现为「某些商品莫名无法出库」，所以前置断言拦住。
  if (SHELF_UNIT === 'day') {
    const minShelf = Math.min(...PRODUCTS.filter((p) => p[6] > 0).map((p) => p[6]))
    const maxLookback = Math.max(
      ...LOOKBACK_INIT, ...LOOKBACK_STORE, ...(LOOKBACK_RECEIPT || [0])
    )
    if (Number.isFinite(minShelf) && maxLookback >= minShelf) {
      throw new Error(
        `批次效期口径冲突：生产日期最多回溯 ${maxLookback} 天，但最短保质期只有 ${minShelf} 天，` +
          `会生成入库即过保的批次。请收紧 lookback 或上调最短保质期。`
      )
    }
  }

  const db = getDb()
  resetDatabase() // 先 DROP 所有表，保证 schema 变更立即生效
  initSchema() // 按最新 schema 重建
  const log = (...a) => !silent && console.log(`[seed:${industry}]`, ...a)

  // ---------- 用户 ----------
  const insUser = db.prepare(
    'INSERT INTO users (username,password_hash,name,role,dept,phone,dealer_id,store_id) VALUES (?,?,?,?,?,?,?,?)'
  )
  const pwd = (p) => bcrypt.hashSync(p, 10)
  insUser.run('admin', pwd('12345'), '系统管理员', 'admin', '信息中心', '13800000001', null, null)
  insUser.run('purchase', pwd('123456'), '刘采购', 'purchase', '采购部', '13800000002', null, null)
  insUser.run('sales', pwd('123456'), '秦销售', 'sales', '销售部', '13800000003', null, null)
  insUser.run('warehouse', pwd('123456'), '沈仓管', 'warehouse', '仓储部', '13800000004', null, null)
  insUser.run('finance', pwd('123456'), '钱财务', 'finance', '财务部', '13800000005', null, null)
  insUser.run('viewer', pwd('123456'), '访客演示', 'viewer', '访客', '13800000006', null, null)
  // 供应链主管（`scm`，角色由迁移 049 建立）：客户 2026-10-17 指定的演示角色之一。
  // 为什么不能复用 `purchase` 或 `boss`：前者只管采购、后者是"全公司只读 + 关键审批"，
  // 而"供应链主管"是**一个人管采购 + 库存 + 生产 + 质检**。角色语义不同，混用会让菜单与权限两头对不上。
  insUser.run('scm', pwd('123456'), '周供应链', 'scm', '供应链中心', '13800000007', null, null)
  // 老板/总经理：演示里用来讲"只看不改 + 关键审批"。登录页有对应角色卡，
  // **卡片点得开就必须有账号** —— 否则演示现场点一下报"用户不存在"，比不给卡片更糟。
  insUser.run('boss', pwd('123456'), '总经理', 'boss', '总经办', '13800000008', null, null)
  log('用户 8 个')

  // ---------- 品牌 / 品类 ----------
  const insBrand = db.prepare('INSERT INTO brands (code,name,en_name,origin) VALUES (?,?,?,?)')
  for (const b of BRANDS) insBrand.run(b[0], b[1], b[2], b[3])
  const brandIdByCode = Object.fromEntries(db.prepare('SELECT id, code FROM brands').all().map((x) => [x.code, x.id]))

  const insCat = db.prepare('INSERT INTO categories (code,name,parent_id,sort_no) VALUES (?,?,?,?)')
  const catIdByCode = {}
  let sortNo = 0
  for (const c of CATEGORIES) {
    const parentId = c[2] ? catIdByCode[c[2]] : null
    const info = insCat.run(c[0], c[1], parentId, sortNo++)
    catIdByCode[c[0]] = info.lastInsertRowid
  }
  log('品牌 %d / 品类 %d', BRANDS.length, CATEGORIES.length)

  // ---------- 商品与 SKU ----------
  const insProduct = db.prepare(
    `INSERT INTO products (spu_code,name,brand_id,category_id,series,spec,unit,barcode,shelf_life_months,batch_managed,tax_rate,
      price_retail,price_dealer,price_member,cost_std,safe_stock,image_emoji,remark)
     VALUES (?,?,?,?,?,?,?,?,?,1,13,?,?,?,?,?,?,?)`
  )
  const insSku = db.prepare(
    `INSERT INTO product_skus (product_id,sku_code,name,color_no,spec,barcode,price_retail,price_dealer,price_member,cost_std,safe_stock,min_stock,max_stock,serial_managed,price_min)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  const skuList = []
  PRODUCTS.forEach((p, idx) => {
    // 第 14 项为可选的商品级规格描述（如服装「弹力西装料 · 高腰阔腿」）；缺省时取首个变体
    const [spu, name, brand, cat, series, unit, shelf, retail, dealer, member, cost, safe, skus, productSpec] = p
    const info = insProduct.run(
      spu, name, brandIdByCode[brand], catIdByCode[cat], series, productSpec || skus[0][0], unit,
      `69${String(6900000000 + idx * 137).slice(0, 11)}`,
      shelf, retail, dealer, member, cost, safe, EMOJI[idx % EMOJI.length], `${series} · ${unit}装`
    )
    const pid = info.lastInsertRowid
    skus.forEach((s, si) => {
      // 变体解析：['30ml'] → 规格；['#01 正红'] → 色号；['黑色','M'] → 颜色 × 尺码
      const parts = Array.isArray(s) ? s : [s]
      let colorNo = null
      let spec = null
      if (parts.length >= 2) {
        colorNo = parts[0]
        spec = parts[1]
      } else if (parts[0].startsWith('#') || /^[A-Z]\d+/.test(parts[0])) {
        colorNo = parts[0]
      } else {
        spec = parts[0]
      }
      const skuCode = `${spu}-${String(si + 1).padStart(2, '0')}`
      const priceAdj = D.priceAdj(spec)
      const variantLabel = [colorNo, spec].filter(Boolean).join('/')
      const sinfo = insSku.run(
        pid, skuCode, `${name}${variantLabel ? ' ' + variantLabel : ''}`, colorNo, spec,
        `69${String(6900000000 + idx * 137 + si * 7).slice(0, 11)}`,
        Number((retail * priceAdj).toFixed(2)), Number((dealer * priceAdj).toFixed(2)), Number((member * priceAdj).toFixed(2)),
        Number((cost * priceAdj).toFixed(2)), Math.round(safe / skus.length),
        Math.round(safe / skus.length / 2), Math.round((safe / skus.length) * 3),
        SERIAL_SPUS.includes(spu) ? 1 : 0,
        // 最低限价：按经销价的 85% 设（模块 08A 报价审批的触发线）。
        // 它必须落在主数据上，不能等到报价时才算 —— 报价行会把它**快照**下来，
        // 主数据后来改了价，也不能拿新限价去追溯审一张已经报出去的老报价单。
        Number((dealer * priceAdj * 0.85).toFixed(2))
      )
      skuList.push({
        id: sinfo.lastInsertRowid, code: skuCode, productName: name,
        color: colorNo || '', size: spec || '', spec: variantLabel,
        retail: Number((retail * priceAdj).toFixed(2)), dealer: Number((dealer * priceAdj).toFixed(2)),
        member: Number((member * priceAdj).toFixed(2)), cost: Number((cost * priceAdj).toFixed(2)),
        min: Number((dealer * priceAdj * 0.85).toFixed(2)),
        shelf, productId: pid, serial: SERIAL_SPUS.includes(spu), skuCode
      })
    })
  })
  log('商品 %d / SKU %d', PRODUCTS.length, skuList.length)

  // 物料类型与供货方式（POS 仅售成品；净需求按供货方式分流）
  db.prepare("UPDATE products SET item_type='material' WHERE spu_code LIKE ?").run(`${MATERIAL_PREFIX}%`)
  if (OUTSOURCE_SPUS.length) {
    const ph = OUTSOURCE_SPUS.map(() => '?').join(',')
    db.prepare(`UPDATE products SET procurement_type='outsource' WHERE spu_code IN (${ph})`).run(...OUTSOURCE_SPUS)
  }
  if (SELF_SPUS.length) {
    const ph = SELF_SPUS.map(() => '?').join(',')
    db.prepare(`UPDATE products SET procurement_type='self' WHERE spu_code IN (${ph})`).run(...SELF_SPUS)
  }

  // ---------- 仓库 / 门店 ----------
  // 仓库元组：索引 3=store_id(占位) 4=地址 5=负责人 6=电话 7=币种 8=品牌码 9=地区
  const insWh = db.prepare(
    'INSERT INTO warehouses (code,name,type,address,manager,phone,currency,brand_id,region) VALUES (?,?,?,?,?,?,?,?,?)'
  )
  const whIdByCode = {}
  for (const w of WAREHOUSES) {
    const info = insWh.run(
      w[0], w[1], w[2], w[4], w[5], w[6],
      w[7] || 'CNY', w[8] ? brandIdByCode[w[8]] || null : null, w[9] || null
    )
    whIdByCode[w[0]] = info.lastInsertRowid
  }
  // 门店元组：索引 9=品牌码 10=币种 11=税区（美妆/服装旧元组只有 9 项，取到 undefined 自动回落）
  const insStore = db.prepare(
    `INSERT INTO stores (code,name,type,region,city,address,manager,phone,open_date,brand_id,currency,tax_region)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  const storeIds = []
  for (const s of STORES) {
    const info = insStore.run(
      s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8],
      s[9] ? brandIdByCode[s[9]] || null : null, s[10] || 'CNY', s[11] || null
    )
    storeIds.push(info.lastInsertRowid)
  }
  // 门店仓与门店一一关联（总部为每家门店设立仓库）。
  // ⚠️ 不能用 `WH0${i+4}` 推算：门店超过 6 家时会算出 WH010 这种不存在的编码，
  //    餐饮版 20 家门店的关联会**静默失败**（UPDATE 匹配不到行、也不报错），
  //    后果是门店铺货没仓库可落、POS 无库存。改为按数据集中 type='store' 的声明顺序取。
  const storeWhCodes = WAREHOUSES.filter((w) => w[2] === 'store').map((w) => w[0])
  if (storeWhCodes.length < STORES.length) {
    throw new Error(
      `门店仓不足：声明了 ${STORES.length} 家门店，但只有 ${storeWhCodes.length} 个 type='store' 的仓库`
    )
  }
  STORES.forEach((s, i) => {
    db.prepare('UPDATE warehouses SET store_id=? WHERE code=?').run(storeIds[i], storeWhCodes[i])
  })
  const storeWhIds = STORES.map((_, i) => whIdByCode[storeWhCodes[i]])
  log('仓库 %d / 门店 %d', WAREHOUSES.length, STORES.length)

  // ---------- 门店店员账号（POS 登录用，每店绑定 store_id） ----------
  // 原先是写死 5 个（store01~store05），餐饮版 20 家店只有前 5 家有账号。
  // 改为按门店数量生成，姓名取门店负责人。
  for (let si = 0; si < STORES.length; si++) {
    const no = String(si + 1).padStart(2, '0')
    insUser.run(
      `store${no}`, pwd('123456'), STORES[si][6], 'store', '门店',
      '13800138' + String(10 + si).padStart(2, '0'), null, storeIds[si]
    )
  }
  log('门店店员 %d 个', STORES.length)

  // ---------- 供应商 ----------
  const insSup = db.prepare(
    'INSERT INTO suppliers (code,name,category,contact,phone,address,tax_no,settle_type,credit_days) VALUES (?,?,?,?,?,?,?,?,?)'
  )
  const supplierIds = SUPPLIERS.map((s) => insSup.run(...s).lastInsertRowid)

  // ---------- 经销商 ----------
  const insDealer = db.prepare(
    `INSERT INTO dealers (code,name,level,region,city,channel_type,contact,phone,address,tax_no,credit_limit,credit_used,
      price_level,discount_rate,rebate_rate,settle_type,onboard_date,remark)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'dealer',?,?,?,?,?)`
  )
  const dealerIds = []
  DEALER_SEEDS.forEach((d, i) => {
    const [name, region, city, channel, level, credit, rebate] = d
    const discount = level === 'diamond' ? 88 : level === 'gold' ? 92 : level === 'silver' ? 96 : 100
    const info = insDealer.run(
      `DL${String(1001 + i)}`, name, level, region, city, channel,
      `${R(SURNAMES)}${R(['经理', '总'])}`, `139${String(20000000 + i * 1111).slice(0, 8)}`,
      `${city}市${R(['工业园区', '高新区', '经济开发区'])}${RI(1, 200)}号`,
      `9131${String(100000000000 + i * 7919).slice(0, 15)}`,
      credit, discount, rebate,
      R(['月结 30 天', '月结 45 天', '月结 60 天', '现结']),
      ymd(dayAgo(RI(200, 1200))),
      `${level === 'diamond' || level === 'gold' ? '重点客户' : '常规客户'}`
    )
    dealerIds.push(info.lastInsertRowid)
  })
  log('供应商 %d / 经销商 %d', supplierIds.length, dealerIds.length)

  // ---------- 平台 ----------
  const insPlatform = db.prepare(
    `INSERT INTO platforms (code,platform_code,name,shop_name,type,adapter,app_key,app_secret_masked,qimen_url,qimen_wh,shop_code,sync_stock,sync_order,warehouse_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  const platformIds = []
  PLATFORMS.forEach((p, i) => {
    const info = insPlatform.run(
      p[0], p[1], p[2], p[3], p[4], p[5],
      `ak_${p[0].toLowerCase()}_${RI(100000, 999999)}`, `sk_****${RI(1000, 9999)}`,
      'http://qimen.api.gml-demo.local/router/rest',
      `GML-WH-${String(i + 1).padStart(2, '0')}`,
      `SHOP${String(1001 + i)}`,
      p[6], p[7], whIdByCode[p[8]] || whIdByCode['WH03']
    )
    platformIds.push(info.lastInsertRowid)
  })
  log('平台 %d（含奇门适配配置）', PLATFORMS.length)

  // ---------- 货位 ----------
  const insLoc = db.prepare('INSERT INTO warehouse_locations (warehouse_id,code,name,type,max_capacity,remark) VALUES (?,?,?,?,?,?)')
  const locByWh = {}
  for (const w of WAREHOUSES) {
    const wid = whIdByCode[w[0]]
    const codes = []
    const zones = [
      ['R-01', '收货暂存区', 'receive', 2000],
      ['A-01-01', 'A 区一层 01 位', 'storage', 800],
      ['A-01-02', 'A 区一层 02 位', 'storage', 800],
      ['A-02-01', 'A 区二层 01 位', 'storage', 600],
      ['B-01-01', 'B 区一层 01 位', 'storage', 500],
      ['B-02-01', 'B 区二层 01 位', 'storage', 500],
      ['P-01', '拣选集货区', 'pick', 300],
      ['Q-01', '不合格品隔离区', 'defect', 100]
    ]
    for (const z of zones) {
      insLoc.run(wid, z[0], z[1], z[2], z[3], null)
      codes.push(z[0])
    }
    locByWh[wid] = codes
  }
  log('货位 %d 个', WAREHOUSES.length * 8)

  // ---------- 经销商/门店演示账号 ----------
  insUser.run('dealer01', pwd('123456'), DEALER_SEEDS[0][0].slice(0, 6) + '账号', 'dealer', '经销商', '13900000001', dealerIds[0], null)
  log('绑定演示账号 dealer01 / store01~store05')

  // ================= 库存与单据 =================
  // 隔离仓（不合格品仓 / 待检品仓）**不参与演示铺货**：它们是空的隔离区，
  // 货只能通过「质检处置」从别处调进来（见 lib/qc2.js 的 DISPOSITION_TARGET）。
  // 把它们算进铺货范围有两个后果，都不会报错：
  //   ① 期初库存会直接落在「不合格仓」里 —— 隔离区一开始就有货，与口径自相矛盾；
  //   ② `PICK` 的选仓结果整体漂移，下游的销售/应收演示数据跟着变
  //      （实测服装版会让 ar-seed 的核销金额与应收余额对不上而直接抛错）。
  // 所以这里按**类型排除**，而不是按编码写死哪几个仓 —— 以后再加隔离类仓不用改这里。
  const ISOLATION_WH_TYPES = ['defect', 'quarantine']
  const whCodes = WAREHOUSES.filter((w) => !ISOLATION_WH_TYPES.includes(w[2])).map((w) => w[0])
  const mainWh = whIdByCode['WH01']
  const ecomWh = whIdByCode['WH03']
  const regWh = whIdByCode['WH02']

  const tx = db.transaction(() => {
    // ---------- 1. 期初库存 ----------
    let initCount = 0
    for (const sku of skuList) {
      const whs = PICK(whCodes, RI(2, 4))
      for (const code of whs) {
        const qty = RI(60, 520)
        const produce = dayAgo(RI(LOOKBACK_INIT[0], LOOKBACK_INIT[1]))
        const expire = expireOf(produce, sku.shelf)
        try {
          applyStockIn(db, {
            bizDate: ymd(dayAgo(INIT_BIZ_DAYS)), docType: 'INIT', docNo: `INIT${ymd(dayAgo(INIT_BIZ_DAYS)).replace(/-/g, '')}`,
            warehouseId: whIdByCode[code], skuId: sku.id, batchNo: seedBatchNo(sku.code, produce),
            produceDate: ymd(produce), expireDate: expire ? ymd(expire) : null, qty, unitCost: sku.cost,
            operator: '系统初始化', remark: '期初库存导入'
          })
          initCount++
        } catch (e) {
          /* ignore */
        }
      }
    }
    log('期初库存 %d 条', initCount)

    // ---------- 2. 采购订单 ----------
    const insPo = db.prepare(
      `INSERT INTO purchase_orders (doc_no,supplier_id,warehouse_id,order_date,expect_date,buyer,status,total_qty,total_amount,tax_amount,settle_type,remark,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`
    )
    const insPoItem = db.prepare(
      'INSERT INTO purchase_order_items (order_id,sku_id,qty,price,tax_rate,amount,received_qty) VALUES (?,?,?,?,13,?,?)'
    )
    const insReceipt = db.prepare(
      `INSERT INTO purchase_receipts (doc_no,order_id,supplier_id,warehouse_id,receipt_date,status,total_qty,total_amount,inspector,remark,created_by)
       VALUES (?,?,?,?,?,'received',?,?,?,?,4)`
    )
    const insReceiptItem = db.prepare(
      'INSERT INTO purchase_receipt_items (receipt_id,sku_id,batch_no,produce_date,expire_date,qty,price,amount) VALUES (?,?,?,?,?,?,?,?)'
    )

    let poCount = 0
    let receiptCount = 0
    for (let d = 175; d >= 3; d -= RI(3, 6)) {
      const orderDate = dayAgo(d)
      const supplierId = R(supplierIds)
      const whId = R([mainWh, mainWh, regWh, ecomWh])
      const lines = PICK(skuList, RI(2, 5))
      const docNo = nextDocNo(db, 'PO', 'purchase_orders', 'doc_no', ymd(orderDate))
      let totalQty = 0
      let totalAmt = 0
      const lineData = []
      for (const sku of lines) {
        const qty = RI(100, 900)
        const price = Number((sku.cost * RF(0.95, 1.05)).toFixed(2))
        const amount = Number((qty * price).toFixed(2))
        totalQty += qty
        totalAmt += amount
        lineData.push({ sku, qty, price, amount })
      }
      const settled = d > 30
      const status = settled ? 'received' : R(['submitted', 'approved', 'approved', 'received'])
      const info = insPo.run(
        docNo, supplierId, whId, ymd(orderDate), ymd(new Date(orderDate.getTime() + RI(5, 20) * 86400000)),
        '刘采购', status, totalQty, Number(totalAmt.toFixed(2)), Number((totalAmt * 0.13).toFixed(2)),
        '月结 30 天', null
      )
      const poId = info.lastInsertRowid
      for (const l of lineData) {
        const received = status === 'received' ? l.qty : 0
        insPoItem.run(poId, l.sku.id, l.qty, l.price, l.amount, received)
      }
      poCount++

      if (status === 'received') {
        const receiptDate = new Date(orderDate.getTime() + RI(3, 12) * 86400000)
        const rDocNo = nextDocNo(db, 'PR', 'purchase_receipts', 'doc_no', ymd(receiptDate))
        const rInfo = insReceipt.run(rDocNo, poId, supplierId, whId, ymd(receiptDate), totalQty, Number(totalAmt.toFixed(2)), '沈仓管', '质检合格')
        const rid = rInfo.lastInsertRowid
        for (const l of lineData) {
          const produce = receiptProduceDate(d)
          const expire = expireOf(produce, l.sku.shelf)
          const expireStr = expire ? ymd(expire) : null
          const batchNo = seedBatchNo(l.sku.code, produce)
          insReceiptItem.run(rid, l.sku.id, batchNo, ymd(produce), expireStr, l.qty, l.price, l.amount)
          applyStockIn(db, {
            bizDate: ymd(receiptDate), docType: 'PUR_IN', docNo: rDocNo, docId: rid,
            warehouseId: whId, skuId: l.sku.id, batchNo, produceDate: ymd(produce), expireDate: expireStr,
            qty: l.qty, unitCost: l.price, counterparty: docNo, operator: '沈仓管', remark: '采购收货入库'
          })
        }
        receiptCount++
      }
    }
    log('采购订单 %d 单（已收货 %d）', poCount, receiptCount)

    // ---------- 2.5 门店初始铺货（总部为每家门店仓铺货，供 POS 零售） ----------
    let storeStockCount = 0
    const insStoreStock = db.transaction(() => {
      for (let si = 0; si < STORES.length; si++) {
        const swh = storeWhIds[si]
        const picks = PICK(skuList, RI(12, 18))
        for (const sku of picks) {
          const produce = dayAgo(RI(LOOKBACK_STORE[0], LOOKBACK_STORE[1]))
          const expire = expireOf(produce, sku.shelf)
          const batchNo = seedBatchNo(sku.code, produce)
          const qty = RI(8, 60)
          applyStockIn(db, {
            bizDate: ymd(dayAgo(RI(15, 45))), docType: 'INIT', docNo: `PU-${STORES[si][0]}`, docId: null,
            warehouseId: swh, skuId: sku.id, batchNo, produceDate: ymd(produce), expireDate: expire ? ymd(expire) : null,
            qty, unitCost: sku.cost, counterparty: STORES[si][1], operator: '沈仓管', remark: '门店初始铺货'
          })
          storeStockCount++
        }
      }
    })
    insStoreStock()
    log('门店铺货 %d 条库存', storeStockCount)

    // ---------- 3. 销售订单（经销商 / 门店）----------
    const insSo = db.prepare(
      `INSERT INTO sales_orders (doc_no,channel,dealer_id,store_id,order_date,status,total_qty,goods_amount,discount_amount,freight,
        receivable_amount,paid_amount,receiver,receiver_phone,receiver_address,salesperson,warehouse_id,remark,created_by)
       VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,?,1)`
    )
    const insSoItem = db.prepare('INSERT INTO sales_order_items (order_id,sku_id,qty,price,discount,amount,shipped_qty) VALUES (?,?,?,?,0,?,?)')
    const insDelivery = db.prepare(
      `INSERT INTO sales_deliveries (doc_no,order_id,warehouse_id,delivery_date,status,total_qty,total_amount,express_company,express_no,remark,created_by)
       VALUES (?,?,?,?,'shipped',?,?,?,?,NULL,4)`
    )
    const insDeliveryItem = db.prepare('INSERT INTO sales_delivery_items (delivery_id,sku_id,batch_no,qty,price,amount) VALUES (?,?,?,?,?,?)')

    const dealerRows = db.prepare('SELECT id, name, discount_rate FROM dealers').all()
    let soCount = 0
    let deliveryCount = 0
    for (let d = 89; d >= 0; d--) {
      const day = dayAgo(d)
      const isWeekend = [0, 6].includes(day.getDay())
      const orderCount = isWeekend ? RI(1, 3) : RI(2, 4)
      for (let k = 0; k < orderCount; k++) {
        const byDealer = rnd() < 0.62
        const dealer = byDealer ? R(dealerRows) : null
        const storeId = byDealer ? null : R(storeIds)
        const skuQty = RI(1, 4)
        const lines = PICK(skuList, skuQty)
        const whId = byDealer ? R([mainWh, mainWh, regWh]) : mainWh
        const orderDate = ymd(day)
        const docNo = nextDocNo(db, 'SO', 'sales_orders', 'doc_no', orderDate)
        const discountRate = dealer ? Number(dealer.discount_rate) : 100
        let goods = 0
        let qtyAll = 0
        const lineData = []
        for (const sku of lines) {
          const qty = byDealer ? RI(10, 120) : RI(1, 6)
          const base = byDealer ? sku.dealer : sku.member
          const price = Number((base * discountRate / 100).toFixed(2))
          const amount = Number((qty * price).toFixed(2))
          goods += amount
          qtyAll += qty
          lineData.push({ sku, qty, price, amount })
        }
        const paid = rnd() < 0.72 ? goods : Number((goods * RF(0.2, 0.8)).toFixed(2))
        const status = d > 3 ? R(['completed', 'completed', 'shipped', 'confirmed']) : R(['confirmed', 'shipped', 'draft'])
        const receiver = mockReceiver(D)
        const info = insSo.run(
          docNo, byDealer ? 'dealer' : 'store', dealer ? dealer.id : null, storeId, orderDate, status,
          qtyAll, Number(goods.toFixed(2)), Number(goods.toFixed(2)), paid,
          dealer ? dealer.name : STORES[storeIds.indexOf(storeId)][5], receiver.phone,
          byDealer ? `${dealer.name} 收货仓` : STORES[storeIds.indexOf(storeId)][5],
          R(['秦销售', '林小雨', '张伟']), whId, null
        )
        const soId = info.lastInsertRowid
        for (const l of lineData) {
          const shipped = status === 'completed' || status === 'shipped' ? l.qty : 0
          insSoItem.run(soId, l.sku.id, l.qty, l.price, l.amount, shipped)
        }
        soCount++

        if (status === 'completed' || status === 'shipped') {
          const deliveryDate = ymd(new Date(day.getTime() + RI(0, 3) * 86400000))
          const dDocNo = nextDocNo(db, 'SD', 'sales_deliveries', 'doc_no', deliveryDate)
          const dInfo = insDelivery.run(dDocNo, soId, whId, deliveryDate, qtyAll, Number(goods.toFixed(2)), R(EXPRESS), expressNo())
          const did = dInfo.lastInsertRowid
          let ok = true
          const picksAll = []
          for (const l of lineData) {
            const { picks, shortage } = pickBatches(db, whId, l.sku.id, l.qty)
            if (shortage > 0) {
              ok = false
              break
            }
            picksAll.push({ line: l, picks })
          }
          if (ok) {
            for (const { line, picks } of picksAll) {
              for (const p of picks) {
                applyStockOut(db, {
                  bizDate: deliveryDate, docType: 'SAL_OUT', docNo: dDocNo, docId: did,
                  warehouseId: whId, skuId: line.sku.id, batchNo: p.batchNo, qty: p.qty, unitCost: p.unitCost,
                  counterparty: dealer ? dealer.name : '门店零售', operator: '沈仓管', remark: '销售出库'
                })
                insDeliveryItem.run(did, line.sku.id, p.batchNo, p.qty, line.price, Number((p.qty * line.price).toFixed(2)))
              }
            }
            deliveryCount++
          } else {
            db.prepare('DELETE FROM sales_delivery_items WHERE delivery_id=?').run(did)
            db.prepare('DELETE FROM sales_deliveries WHERE id=?').run(did)
            db.prepare("UPDATE sales_orders SET status='confirmed' WHERE id=?").run(soId)
          }
        }
      }
    }
    log('销售订单 %d 单（已发货 %d）', soCount, deliveryCount)

    // ---------- 4. 销售退货（少量）----------
    // D1 之后退货单多了两个"依据"字段，seed 必须一起写 ——
    // 否则整库重建出来的库里，退货明细的来源行全是 NULL：
    // 迁移的回填只对**迁移执行前**就存在的行有效，而重建的顺序是「建表 → 迁移 → 灌数」，
    // seed 造的行永远等不到那次回填，于是"重建库"与"线上库"从此不一样（重建不可复现）。
    const insSr = db.prepare(
      `INSERT INTO sales_returns (doc_no,order_id,source_type,channel,dealer_id,warehouse_id,return_date,reason,status,total_qty,total_amount,created_by)
       VALUES (?,?,'order',?,?,?,?,?,'completed',?,?,1)`
    )
    const insSrItem = db.prepare(
      'INSERT INTO sales_return_items (return_id,order_item_id,sku_id,batch_no,qty,price,amount) VALUES (?,?,?,?,?,?,?)'
    )
    // 挑 18 张已发货订单做退货样本。
    // 这里原来写的是 `ORDER BY RANDOM() LIMIT 18` —— SQLite 自带的随机函数绕过了
    // 本文件的确定性随机，于是每次重建挑中的订单都不同，「哪张退货单入了哪个批次」
    // 跟着变，库存行数与流水在两次重建之间来回跳。改为「先按 id 取全集，再用 PICK 抽」：
    // 抽样依然分散，但完全可复现（PICK 走的是本文件的 mulberry32）。
    const soldOrders = PICK(
      db.prepare("SELECT * FROM sales_orders WHERE status IN ('shipped','completed') AND dealer_id IS NOT NULL ORDER BY id").all(),
      18
    )
    let srCount = 0
    for (const so of soldOrders) {
      const items = db.prepare('SELECT * FROM sales_order_items WHERE order_id=?').all(so.id)
      if (!items.length) continue
      const it = R(items)
      const qty = Math.max(1, Math.floor(it.qty * RF(0.1, 0.4)))
      const returnDate = ymd(new Date(new Date(so.order_date).getTime() + RI(5, 25) * 86400000))
      const docNo = nextDocNo(db, 'SRT', 'sales_returns', 'doc_no', returnDate)
      const amount = Number((qty * it.price).toFixed(2))
      const rInfo = insSr.run(docNo, so.id, 'dealer', so.dealer_id, so.warehouse_id, returnDate, R(['包装破损', '临期调换', '滞销退回', '色号不符']), qty, amount)
      const rid = rInfo.lastInsertRowid
      // 退货入哪个批次：原来是无 ORDER BY 的 LIMIT 1。SQLite 在没有排序时返回哪一行
      // 取决于物理页布局（重建一代、页复用一次就可能换一行），退货批次随之漂移。
      // 退回来的货要回到「同一批」才有意义，这里显式按批次号排序取最早的一批。
      const batch = db
        .prepare('SELECT batch_no FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? ORDER BY batch_no ASC LIMIT 1')
        .get(so.warehouse_id, it.sku_id)
      insSrItem.run(rid, it.id, it.sku_id, batch ? batch.batch_no : '', qty, it.price, amount)
      try {
        // 退货入库成本 = **该批次当初出库的成本**（追溯），不是这张订单的售价。
        // 用售价当退货成本会把毛利写进库存金额：库里的货"越退越值钱"，
        // 而这笔虚增会一路带进成本报表与三层残差等式。
        const lot = db
          .prepare(
            `SELECT ROUND(COALESCE(SUM(amount),0) / NULLIF(COALESCE(SUM(qty),0),0), 4) AS uc
               FROM inventory_transactions
              WHERE doc_type='SAL_OUT' AND counterparty=? AND sku_id=? AND IFNULL(batch_no,'')=?`
          )
          .get(so.doc_no, it.sku_id, batch ? batch.batch_no : '')
        const unitCost = Number(lot?.uc) > 0 ? Number(lot.uc) : it.price
        applyStockIn(db, {
          bizDate: returnDate, docType: 'SAL_RET', docNo, docId: rid, warehouseId: so.warehouse_id,
          skuId: it.sku_id, batchNo: batch ? batch.batch_no : '', qty, unitCost,
          counterparty: '经销商退货', operator: '沈仓管', remark: '销售退货入库'
        })
        srCount++
      } catch {
        /* ignore */
      }
    }
    log('销售退货 %d 单', srCount)

    // ---------- 5. 线上 OMS 订单 ----------
    const insOms = db.prepare(
      `INSERT INTO oms_orders (platform_id,platform_order_no,buyer_nick,order_time,pay_time,status,goods_amount,freight,discount_amount,pay_amount,
        receiver,receiver_phone,receiver_address,express_company,express_no,sync_at,sales_order_id,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`
    )
    const insOmsItem = db.prepare(
      'INSERT INTO oms_order_items (oms_order_id,platform_sku_code,sku_id,title,spec,qty,price,amount) VALUES (?,?,?,?,?,?,?,?)'
    )
    const platRows = db.prepare('SELECT * FROM platforms').all()
    let omsCount = 0
    for (let d = 59; d >= 0; d--) {
      const day = dayAgo(d)
      // 取到「当天零点」再叠加时分：平台单号里有 `orderTime.getTime().slice(-10)`，
      // 直接从 dayAgo() 的当前时刻加，会把「本次重建发生在第几秒」编进单号 ——
      // 两次重建的平台单号就不一样，转单生成的销售订单备注（`由线上订单 XXX 转入`）也跟着变。
      const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate())
      const cnt = RI(3, 9)
      for (let k = 0; k < cnt; k++) {
        const pf = R(platRows)
        const orderTime = new Date(dayStart.getTime() + RI(8, 22) * 3600000 + RI(0, 59) * 60000)
        const payTime = new Date(orderTime.getTime() + RI(30, 900) * 1000)
        const lines = PICK(skuList, RI(1, 3))
        let goods = 0
        const lineData = []
        for (const sku of lines) {
          const qty = RI(1, 3)
          const price = Number((sku.retail * RF(0.82, 1.0)).toFixed(2))
          const amount = Number((qty * price).toFixed(2))
          goods += amount
          lineData.push({ sku, qty, price, amount })
        }
        const freight = goods >= 199 ? 0 : R([0, 8, 10, 12])
        const discount = R([0, 0, 0, 5, 10, 20, 30, 50])
        const payAmount = Number(Math.max(goods + freight - discount, 0).toFixed(2))
        const rcv = mockReceiver(D)
        let status
        if (d > 4) status = R(['completed', 'completed', 'completed', 'shipped', 'refunded'])
        else if (d > 1) status = R(['shipped', 'shipped', 'completed'])
        else status = R(['pending', 'pending', 'pending', 'shipped'])
        const code = pf.code
        const pno = `${code.slice(0, 2)}${orderTime.getTime().toString().slice(-10)}${RI(100, 999)}`
        const info = insOms.run(
          pf.id, pno, R(BUYER_NICKS), ymdhms(orderTime), ymdhms(payTime), status,
          Number(goods.toFixed(2)), freight, discount, payAmount,
          rcv.name, rcv.phone, rcv.address,
          status === 'pending' ? null : R(EXPRESS), status === 'pending' ? null : expressNo(),
          ymdhms(new Date(orderTime.getTime() + RI(1, 30) * 60000)),
          `同步自 ${pf.name}`
        )
        const oid = info.lastInsertRowid
        for (const l of lineData) {
          insOmsItem.run(oid, `P${l.sku.code}`, l.sku.id, `${l.sku.productName}${l.sku.spec ? ' ' + l.sku.spec : ''}`, l.sku.spec, l.qty, l.price, l.amount)
        }
        omsCount++
      }
    }
    log('线上订单 %d 笔', omsCount)

    // ---------- 6. 线上订单部分转单 ----------
    const convertible = db
      .prepare("SELECT * FROM oms_orders WHERE status IN ('pending','shipped') AND sales_order_id IS NULL ORDER BY order_time DESC LIMIT 45")
      .all()
    let converted = 0
    for (const o of convertible) {
      if (rnd() < 0.35) continue
      const items = db.prepare('SELECT * FROM oms_order_items WHERE oms_order_id=?').all(o.id)
      if (!items.some((i) => i.sku_id)) continue
      const pf = platRows.find((p) => p.id === o.platform_id)
      const whId = pf && pf.warehouse_id ? pf.warehouse_id : ecomWh
      try {
        db.transaction(() => {
          const docNo = nextDocNo(db, 'SO', 'sales_orders', 'doc_no', (o.pay_time || o.order_time || '').slice(0, 10))
          const info = insSo.run(
            docNo, 'platform', null, null, (o.pay_time || o.order_time || '').slice(0, 10), 'confirmed',
            0, Number(o.goods_amount.toFixed(2)), Number(o.pay_amount.toFixed(2)), o.pay_amount,
            o.receiver, o.receiver_phone, o.receiver_address, 'OMS 自动转单', whId, `由线上订单 ${o.platform_order_no} 转入`
          )
          const soId = info.lastInsertRowid
          let qtyAll = 0
          let goodsAll = 0
          for (const it of items) {
            if (!it.sku_id) continue
            insSoItem.run(soId, it.sku_id, it.qty, it.price, it.amount, 0)
            qtyAll += it.qty
            goodsAll += it.amount
          }
          db.prepare('UPDATE sales_orders SET total_qty=?, goods_amount=?, receivable_amount=? WHERE id=?').run(
            qtyAll, Number(goodsAll.toFixed(2)), Number((goodsAll - o.discount_amount + o.freight).toFixed(2)), soId
          )
          for (const it of items) {
            if (!it.sku_id) continue
            const { picks, shortage } = pickBatches(db, whId, it.sku_id, it.qty)
            if (shortage > 0) throw new Error('库存不足')
            // 占库要登记来源（A05）：不登记的话这批预留无从追溯，
            // 后面发货/取消只能"重新按当前库存再拣一次"——而那时库存已经不是当时那批了。
            for (const p of picks) {
              reserveStock(db, {
                warehouseId: whId, skuId: it.sku_id, batchNo: p.batchNo, qty: p.qty,
                sourceDocType: 'SO', sourceDocId: soId, sourceDocNo: docNo
              })
            }
          }
          db.prepare('UPDATE oms_orders SET sales_order_id=? WHERE id=?').run(soId, o.id)
          if (o.status !== 'pending') {
            for (const it of items) {
              if (!it.sku_id) continue
              const { picks } = pickBatches(db, whId, it.sku_id, it.qty)
              for (const p of picks) {
                releaseStock(db, {
                  warehouseId: whId, skuId: it.sku_id, batchNo: p.batchNo, qty: p.qty,
                  sourceDocType: 'SO', sourceDocId: soId
                })
                applyStockOut(db, {
                  bizDate: (o.pay_time || o.order_time || '').slice(0, 10), docType: 'SAL_OUT', docNo, docId: soId,
                  warehouseId: whId, skuId: it.sku_id, batchNo: p.batchNo, qty: p.qty, unitCost: p.unitCost,
                  counterparty: o.platform_order_no, operator: 'OMS', remark: '平台电商出库'
                })
              }
            }
            db.prepare("UPDATE sales_orders SET status='shipped' WHERE id=?").run(soId)
          }
        })()
        converted++
      } catch {
        /* 库存不足则跳过 */
      }
    }
    log('线上订单转单 %d 笔', converted)

    // ---------- 7. 调拨 ----------
    const insTr = db.prepare(
      `INSERT INTO stock_transfers (doc_no,from_warehouse_id,to_warehouse_id,transfer_date,type,status,total_qty,total_amount,applicant,created_by)
       VALUES (?,?,?,?,?,'received',?,?,?,1)`
    )
    const insTrItem = db.prepare('INSERT INTO stock_transfer_items (transfer_id,sku_id,batch_no,qty,cost_price,amount) VALUES (?,?,?,?,?,?)')
    let trCount = 0
    for (let i = 0; i < 22; i++) {
      const from = R([mainWh, regWh])
      const to = R([ecomWh, whIdByCode['WH04'], whIdByCode['WH05'], whIdByCode['WH06']])
      if (from === to) continue
      const date = ymd(dayAgo(RI(3, 80)))
      const docNo = nextDocNo(db, 'TR', 'stock_transfers', 'doc_no', date)
      const lines = PICK(skuList, RI(2, 6))
      let qtyAll = 0
      let amtAll = 0
      const prepared = []
      for (const sku of lines) {
        const qty = RI(20, 160)
        const { picks, shortage } = pickBatches(db, from, sku.id, qty)
        if (shortage > 0) continue
        prepared.push({ sku, picks })
        qtyAll += qty
        amtAll += qty * sku.cost
      }
      if (!prepared.length) continue
      const info = insTr.run(docNo, from, to, date, 'allocation', qtyAll, Number(amtAll.toFixed(2)), '沈仓管')
      const tid = info.lastInsertRowid
      for (const { sku, picks } of prepared) {
        for (const p of picks) {
          applyStockOut(db, {
            bizDate: date, docType: 'TR_OUT', docNo, docId: tid, warehouseId: from, skuId: sku.id,
            batchNo: p.batchNo, qty: p.qty, unitCost: p.unitCost, operator: '沈仓管', remark: '调拨出库'
          })
          applyStockIn(db, {
            bizDate: date, docType: 'TR_IN', docNo, docId: tid, warehouseId: to, skuId: sku.id,
            batchNo: p.batchNo, qty: p.qty, unitCost: p.unitCost, operator: '沈仓管', remark: '调拨入库'
          })
          insTrItem.run(tid, sku.id, p.batchNo, p.qty, p.unitCost, Number((p.qty * p.unitCost).toFixed(2)))
        }
      }
      trCount++
    }
    log('调拨单 %d 单', trCount)

    // ---------- 8. 盘点（1 单已调整）----------
    const cDocNo = nextDocNo(db, 'SC', 'stock_checks', 'doc_no', ymd(dayAgo(12)))
    const cInfo = db
      .prepare("INSERT INTO stock_checks (doc_no,warehouse_id,check_date,status,checker,total_diff_qty) VALUES (?,?,?,'adjusted','沈仓管',0)")
      .run(cDocNo, whIdByCode['WH04'], ymd(dayAgo(12)))
    const cid = cInfo.lastInsertRowid
    const checkStocks = db.prepare('SELECT * FROM inventory_stocks WHERE warehouse_id=? AND qty_on_hand > 0 LIMIT 40').all(whIdByCode['WH04'])
    let diffSum = 0
    for (const s of checkStocks) {
      const actual = Math.max(0, s.qty_on_hand + R([0, 0, 0, -2, -1, 1, 2, -5]))
      const diff = actual - s.qty_on_hand
      diffSum += diff
      db.prepare('INSERT INTO stock_check_items (check_id,sku_id,batch_no,book_qty,actual_qty,diff_qty,reason) VALUES (?,?,?,?,?,?,?)').run(
        cid, s.sku_id, s.batch_no, s.qty_on_hand, actual, diff, diff === 0 ? '账实相符' : diff > 0 ? '盘盈' : '盘亏（试用品/破损）'
      )
      if (diff > 0) {
        applyStockIn(db, { bizDate: ymd(dayAgo(12)), docType: 'ADJ_IN', docNo: cDocNo, docId: cid, warehouseId: whIdByCode['WH04'], skuId: s.sku_id, batchNo: s.batch_no, qty: diff, unitCost: 0, operator: '沈仓管', remark: '盘盈' })
      } else if (diff < 0) {
        try {
          applyStockOut(db, { bizDate: ymd(dayAgo(12)), docType: 'ADJ_OUT', docNo: cDocNo, docId: cid, warehouseId: whIdByCode['WH04'], skuId: s.sku_id, batchNo: s.batch_no, qty: -diff, operator: '沈仓管', remark: '盘亏' })
        } catch {
          /* ignore */
        }
      }
    }
    db.prepare('UPDATE stock_checks SET total_diff_qty=? WHERE id=?').run(diffSum, cid)

    // ---------- 9. 经销商返利（基础点位 + 阶梯政策两种口径）----------
    const insRebate = db.prepare(
      `INSERT INTO dealer_rebates (dealer_id,period,policy_id,policy_name,calc_basis,sales_amount,return_amount,net_amount,rebate_rate,rebate_amount,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    const periods = [0, 1, 2].map((m) => {
      const d = new Date(seedNow())
      d.setMonth(d.getMonth() - m)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    })
    let rebateCount = 0
    for (const period of periods) {
      for (const dr of dealerRows) {
        const agg = db
          .prepare(
            `SELECT COALESCE(SUM(receivable_amount),0) amount FROM sales_orders
             WHERE dealer_id=? AND status NOT IN ('cancelled','draft') AND substr(order_date,1,7)=?`
          )
          .get(dr.id, period)
        const ret = db
          .prepare('SELECT COALESCE(SUM(total_amount),0) amount FROM sales_returns WHERE dealer_id=? AND substr(return_date,1,7)=?')
          .get(dr.id, period)
        const sales = Number(agg.amount.toFixed(2))
        if (sales <= 0) continue
        const net = Number((sales - ret.amount).toFixed(2))
        const rate = Number(db.prepare('SELECT rebate_rate r FROM dealers WHERE id=?').get(dr.id).r || 0)
        // ⚠️ 终止态用 `confirmed` 而**不是** `paid`（批次 G 收口）：
        // `paid` 现在的含义是「**已核销**」—— 必须挂在一张 `rebate_settlements` 上、
        // 且伴随真实的应收冲减（`lib/rebate.js` 的 `auditRebate` 与 `verify-seed` 都断言这一条）。
        // 这里造的是**手工口径**的样本（`policy_id=0`），它没有核销单，
        // 所以只能停在 `confirmed`（已确认入账）—— 硬写成 `paid` 会让不变量永久失败，
        // 而失败信息只会说"有 39 笔已核销的返利没挂核销单"，看不出是造数写错了状态字。
        const info = insRebate.run(
          dr.id, period, 0, '基础点位返点', '协议基础点位（客户档案 rebate_rate）',
          sales, Number(ret.amount.toFixed(2)), net, rate, Number((net * rate / 100).toFixed(2)), period === periods[0] ? 'pending' : 'confirmed'
        )
        rebateCount++
        void info
      }
    }
    log('返利记录 %d 条', rebateCount)

    // ---------- 10. 对账单 ----------
    const insStmt = db.prepare(
      `INSERT INTO dealer_statements (doc_no,dealer_id,period_start,period_end,opening_amount,sales_amount,return_amount,received_amount,closing_amount,status,confirmed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    let stmtCount = 0
    for (const period of periods.slice(1)) {
      const [y, m] = period.split('-').map(Number)
      const start = `${period}-01`
      const end = ymd(new Date(y, m, 0))
      for (const dr of dealerRows) {
        const opening = db
          .prepare(
            `SELECT COALESCE(SUM(receivable_amount - paid_amount),0) v FROM sales_orders
             WHERE dealer_id=? AND status NOT IN ('cancelled','draft') AND order_date < ?`
          )
          .get(dr.id, start).v
        const agg = db
          .prepare(
            `SELECT COALESCE(SUM(receivable_amount),0) amount, COALESCE(SUM(paid_amount),0) paid FROM sales_orders
             WHERE dealer_id=? AND status NOT IN ('cancelled','draft') AND order_date BETWEEN ? AND ?`
          )
          .get(dr.id, start, end)
        if (agg.amount <= 0) continue
        const ret = db
          .prepare('SELECT COALESCE(SUM(total_amount),0) v FROM sales_returns WHERE dealer_id=? AND return_date BETWEEN ? AND ?')
          .get(dr.id, start, end).v
        const closing = Number((Number(opening) + Number(agg.amount) - Number(ret) - Number(agg.paid)).toFixed(2))
        const docNo = nextDocNo(db, 'DS', 'dealer_statements', 'doc_no', end)
        insStmt.run(
          docNo, dr.id, start, end, Number(opening), Number(agg.amount), Number(ret), Number(agg.paid), closing,
          'confirmed', `${end} 10:00:00`
        )
        stmtCount++
      }
    }
    log('对账单 %d 份', stmtCount)

    // ---------- 11. 信用占用回写 ----------
    db.prepare(
      `UPDATE dealers SET credit_used = COALESCE((
        SELECT SUM(so.receivable_amount - so.paid_amount) FROM sales_orders so
        WHERE so.dealer_id = dealers.id AND so.status NOT IN ('cancelled','draft')
      ), 0)`
    ).run()

    // ---------- 12. 同步日志 ----------
    const insLog = db.prepare(
      `INSERT INTO oms_sync_logs (platform_id,sync_type,direction,status,total_count,success_count,fail_count,message,cost_ms,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    for (let i = 0; i < 30; i++) {
      const pf = R(platRows)
      const type = R(['order', 'order', 'stock', 'shipment', 'refund', 'price'])
      const dt = dayAgo(RI(0, 25))
      const total = RI(3, 60)
      insLog.run(
        pf.id, type, type === 'stock' || type === 'price' ? 'out' : 'in', rnd() < 0.93 ? 'success' : 'fail',
        total, total, 0,
        rnd() < 0.93 ? `${pf.name} ${type} 同步完成` : `${pf.name} 接口超时，已重试`,
        RI(120, 3200), ymdhms(dt)
      )
    }

    // ---------- 13. 返点政策（多形式）----------
    const insPolicy = db.prepare(
      `INSERT INTO rebate_policies (code,name,type,dealer_level,channel_type,period,basis,rules,rebate_cap,priority,status,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    const now0 = seedNow()
    const curMonth = `${now0.getFullYear()}-${String(now0.getMonth() + 1).padStart(2, '0')}`
    const curQuarter = `${now0.getFullYear()}-Q${Math.ceil((now0.getMonth() + 1) / 3)}`
    const policySeeds = [
      ['RP001', '季度阶梯返点（全网）', 'tiered', 'all', 'all', curQuarter, 'net',
        { tiers: [{ min: 0, max: 100000, rate: 2 }, { min: 100000, max: 300000, rate: 3 }, { min: 300000, max: null, rate: 4.5 }] },
        0, 10, '按净销售阶梯计返，档位越高点位越高'],
      ['RP002', 'CS 渠道按件返利', 'fixed_per_unit', 'all', 'cs', curQuarter, 'net', { perUnit: 1.5 }, 0, 20, '每进货 1 件返 1.5 元，鼓励铺货深度'],
      ['RP003', '同比增长返点', 'growth', 'all', 'all', null, 'net', { rate: 3 }, 0, 30, '环比上月销售增量部分按 3% 计返'],
      ['RP004', '回款达标返点', 'payback', 'all', 'all', curQuarter, 'pay', { payRatio: 0.9, rate: 1.5 }, 0, 40, '当期回款率 ≥90% 时按回款额 1.5% 返'],
      ['RP005', `${D.rebateCategoryName}品类专向返点`, 'category', 'all', 'all', null, 'net', { categoryId: catIdByCode[D.rebateCategoryCode], rate: 5 }, 0, 50, `${D.rebateCategoryName}品类单独加返 5%，驱动品类结构`],
      ['RP006', '档期任务返点', 'seasonal', 'all', 'all', curMonth, 'net', { target: 200000, rate: 5 }, 80000, 5, '档期净销售 ≥20 万返 5%，单期封顶 8 万']
    ]
    for (const p of policySeeds) {
      insPolicy.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6], JSON.stringify(p[7]), p[8], p[9], 'active', p[10])
    }
    log('返点政策 %d 种', policySeeds.length)

    // ---------- 14. 库存补齐：货位 + 入库日期（库龄基准）----------
    const updLoc = db.prepare('UPDATE inventory_stocks SET location=? WHERE id=?')
    for (const st of db.prepare('SELECT id, warehouse_id FROM inventory_stocks').all()) {
      const locs = (locByWh[st.warehouse_id] || []).filter((c) => c[0] !== 'R' && c[0] !== 'Q')
      updLoc.run(locs.length ? R(locs) : null, st.id)
    }
    db.prepare(
      `UPDATE inventory_stocks SET entry_date = COALESCE((
         SELECT MIN(t.biz_date) FROM inventory_transactions t
         WHERE t.warehouse_id = inventory_stocks.warehouse_id AND t.sku_id = inventory_stocks.sku_id
           AND t.batch_no = inventory_stocks.batch_no AND t.direction = 'in'
       ), produce_date)`
    ).run()

    // ---------- 15. 序列号（单品一码）----------
    const insSn = db.prepare(
      `INSERT INTO serial_numbers (serial_no,sku_id,barcode,warehouse_id,location,batch_no,status,entry_doc_no,entry_date,holder,exit_doc_no,exit_date,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    let snCount = 0
    for (const sku of skuList.filter((s) => s.serial)) {
      const stocks = db.prepare('SELECT * FROM inventory_stocks WHERE sku_id=? AND qty_on_hand>0').all(sku.id)
      let seq = 1
      for (const st of stocks) {
        const firstIn = db
          .prepare(
            `SELECT doc_no, biz_date FROM inventory_transactions WHERE warehouse_id=? AND sku_id=? AND batch_no=? AND direction='in' ORDER BY id LIMIT 1`
          )
          .get(st.warehouse_id, st.sku_id, st.batch_no)
        const perBatch = Math.min(Math.floor(st.qty_on_hand), 12)
        const locs = (locByWh[st.warehouse_id] || []).filter((c) => c[0] !== 'R' && c[0] !== 'Q')
        for (let i = 0; i < perBatch; i++) {
          const no = `SN${sku.code.replace(/-/g, '')}${String(seq).padStart(5, '0')}`
          seq++
          const shipped = rnd() < 0.28
          if (shipped) {
            const dl = db
              .prepare(
                `SELECT d.doc_no, d.delivery_date FROM sales_deliveries d JOIN sales_delivery_items di ON di.delivery_id=d.id
                 WHERE di.sku_id=? ORDER BY d.id DESC LIMIT 1`
              )
              .get(sku.id)
            insSn.run(
              no, sku.id, `69${String(6900000000 + sku.id * 137).slice(0, 11)}`, st.warehouse_id, null, st.batch_no,
              'shipped', firstIn ? firstIn.doc_no : 'INIT', firstIn ? firstIn.biz_date : st.entry_date,
              R(dealerRows).name, dl ? dl.doc_no : null, dl ? dl.delivery_date : null, '销售出库追溯'
            )
          } else {
            insSn.run(
              no, sku.id, `69${String(6900000000 + sku.id * 137).slice(0, 11)}`, st.warehouse_id,
              locs.length ? R(locs) : null, st.batch_no,
              'in_stock', firstIn ? firstIn.doc_no : 'INIT', firstIn ? firstIn.biz_date : st.entry_date,
              null, null, null, null
            )
          }
          snCount++
        }
      }
    }
    log('序列号 %d 个', snCount)

    // ---------- 16. 组合装（BOM）----------
    const skuOf = (pname, spec) => skuList.find((s) => s.productName.includes(pname) && (!spec || s.spec === spec || String(s.spec).includes(spec)))
    const insBundle = db.prepare(
      `INSERT INTO bundles (code,name,type,parent_sku_id,price_retail,price_dealer,cost_std,barcode,remark)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    const insComp = db.prepare('INSERT INTO bundle_components (bundle_id,component_sku_id,qty,remark) VALUES (?,?,?,?)')
    // 组合装定义来自行业数据集：父商品与组件通过「商品名 + 规格」定位
    const bundleDefs = D.bundles.map((b) => ({
      ...b,
      parent: b.parent ? skuOf(b.parent[0], b.parent[1]) : null,
      components: b.components.map(([picker, qty, rem]) => [skuOf(picker[0], picker[1]), qty, rem])
    }))
    const bundleByCode = {}
    for (const b of bundleDefs) {
      const bomCost = b.components.reduce((s, [sku, qty]) => s + (sku ? sku.cost * qty : 0), 0)
      const info = insBundle.run(
        b.code, b.name, b.type, b.parent ? b.parent.id : null, b.price, b.dealer,
        Number(bomCost.toFixed(2)), `69${String(6900990000 + Number(b.code.slice(3))).slice(0, 11)}`, b.remark || null
      )
      const bid = info.lastInsertRowid
      bundleByCode[b.code] = { id: bid, ...b }
      for (const [sku, qty, rem] of b.components) {
        if (sku) insComp.run(bid, sku.id, qty, rem)
      }
    }
    log('组合装 %d 个', bundleDefs.length)

    // ---------- 17. 组装单（组合包装库存）----------
    const insAsm = db.prepare(
      `INSERT INTO assembly_orders (doc_no,type,bundle_id,warehouse_id,biz_date,status,qty,total_cost,operator,remark,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,4)`
    )
    const insAsmItem = db.prepare('INSERT INTO assembly_order_items (order_id,role,sku_id,batch_no,qty,unit_cost,amount) VALUES (?,?,?,?,?,?,?)')
    // 已过账的组装单：组件出库 → 礼盒成品入库 + 生成序列号
    {
      const bd = bundleByCode['BND001']
      const wh = mainWh
      const date = ymd(dayAgo(18))
      const qty = 25
      const docNo = nextDocNo(db, 'AS', 'assembly_orders', 'doc_no', date)
      const comps = db
        .prepare(
          `SELECT bc.*, sk.cost_std FROM bundle_components bc JOIN product_skus sk ON sk.id=bc.component_sku_id WHERE bc.bundle_id=?`
        )
        .all(bd.id)
      const picksAll = []
      let cost = 0
      let ok = true
      for (const c of comps) {
        const { picks, shortage } = pickBatches(db, wh, c.component_sku_id, c.qty * qty)
        if (shortage > 0) {
          ok = false
          break
        }
        picksAll.push({ c, picks })
      }
      if (ok) {
        const info = insAsm.run(docNo, 'assemble', bd.id, wh, date, 'confirmed', qty, 0, '沈仓管', '礼盒备货组装')
        const aid = info.lastInsertRowid
        for (const { c, picks } of picksAll) {
          for (const p of picks) {
            cost += p.qty * p.unitCost
            applyStockOut(db, {
              bizDate: date, docType: 'ASM_OUT', docNo, docId: aid, warehouseId: wh,
              skuId: c.component_sku_id, batchNo: p.batchNo, qty: p.qty, unitCost: p.unitCost,
              operator: '沈仓管', remark: `组装领料 → ${bd.name}`
            })
            insAsmItem.run(aid, 'component', c.component_sku_id, p.batchNo, p.qty, p.unitCost, Number((p.qty * p.unitCost).toFixed(2)))
          }
        }
        const parentBatch = `ASM${date.replace(/-/g, '')}001`
        const expire = expireOf(new Date(date), bd.parent.shelf || 0, 24)
        applyStockIn(db, {
          bizDate: date, docType: 'ASM_IN', docNo, docId: aid, warehouseId: wh,
          skuId: bd.parent.id, batchNo: parentBatch, produceDate: date, expireDate: ymdOrNull(expire),
          qty, unitCost: Number((cost / qty).toFixed(4)), operator: '沈仓管', remark: `组装成品入库 ${bd.name}`
        })
        insAsmItem.run(aid, 'parent', bd.parent.id, parentBatch, qty, Number((cost / qty).toFixed(4)), Number(cost.toFixed(2)))
        db.prepare('UPDATE assembly_orders SET total_cost=? WHERE id=?').run(Number(cost.toFixed(2)), aid)
        db.prepare('UPDATE inventory_stocks SET location=?, entry_date=? WHERE warehouse_id=? AND sku_id=? AND batch_no=?').run('B-01-01', date, wh, bd.parent.id, parentBatch)
        // 组装生成的礼盒逐件赋码
        const insSn2 = db.prepare(
          `INSERT INTO serial_numbers (serial_no,sku_id,barcode,warehouse_id,location,batch_no,status,entry_doc_no,entry_date,remark)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        for (let i = 1; i <= qty; i++) {
          insSn2.run(`SN${bd.parent.code.replace(/-/g, '')}${String(90000 + i).padStart(5, '0')}`, bd.parent.id, null, wh, 'B-01-01', parentBatch, 'in_stock', docNo, date, '组装生成')
        }
        snCount += qty
      }
    }
    // 一张待确认的组装单 + 一张拆卸单草稿
    {
      const bd = bundleByCode['BND002']
      const date = ymd(dayAgo(2))
      const docNo = nextDocNo(db, 'AS', 'assembly_orders', 'doc_no', date)
      const pc = bd.parent.cost || 0
      const info = insAsm.run(docNo, 'assemble', bd.id, mainWh, date, 'draft', 30, 0, '沈仓管', '组合装备货（待确认）')
      insAsmItem.run(info.lastInsertRowid, 'parent', bd.parent.id, '', 30, pc, Number((pc * 30).toFixed(2)))
      for (const [sku, qty] of bd.components) {
        if (sku) insAsmItem.run(info.lastInsertRowid, 'component', sku.id, '', qty * 30, sku.cost, Number((qty * 30 * sku.cost).toFixed(2)))
      }
    }
    {
      const bd = bundleByCode['BND001']
      const date = ymd(dayAgo(1))
      const docNo = nextDocNo(db, 'DS', 'assembly_orders', 'doc_no', date)
      const pc = bd.parent.cost || 0
      const info = insAsm.run(docNo, 'disassemble', bd.id, mainWh, date, 'draft', 3, 0, '沈仓管', '礼盒改拆零（待确认）')
      insAsmItem.run(info.lastInsertRowid, 'parent', bd.parent.id, '', 3, pc, Number((pc * 3).toFixed(2)))
      for (const [sku, qty] of bd.components) {
        if (sku) insAsmItem.run(info.lastInsertRowid, 'component', sku.id, '', qty * 3, sku.cost, Number((qty * 3 * sku.cost).toFixed(2)))
      }
    }
    log('组装/拆卸单 3 张')

    // ---------- 18. 奇门对接日志 ----------
    const qimenLogs = [
      ['qimen:taobao.qimen.deliveryorder.create', 'success', { deliveryOrderCode: 'GML-OUT-1024', orderSourceCode: 'TB2610123456', warehouseCode: 'GML-WH-03', orderLines: 2 }],
      ['qimen:taobao.qimen.deliveryorder.confirm', 'success', { deliveryOrderCode: 'GML-OUT-1024', expressCode: 'SF1390001122334', logisticsCode: 'SF' }],
      ['qimen:taobao.qimen.itemmapping.query', 'success', { itemCode: skuList[0].code, shopSkuId: `PSP${skuList[0].code}` }],
      ['qimen:taobao.qimen.inventory.query', 'success', { warehouseCode: 'GML-WH-03', items: 48 }],
      ['qimen:taobao.qimen.entryorder.create', 'success', { entryOrderCode: 'PR20261012001', orderType: 'PURCHASE', orderLines: 4 }],
      ['qimen:taobao.qimen.stock.change.report', 'fail', { warehouseCode: 'GML-WH-03', items: 48, error: 'sign expired' }]
    ]
    for (const [type, status, payload] of qimenLogs) {
      insLog.run(
        R(platformIds), type, 'in', status, 1, status === 'success' ? 1 : 0, status === 'success' ? 0 : 1,
        status === 'success' ? `${type} 处理成功` : '签名过期，已重试成功',
        JSON.stringify(payload), RI(80, 900)
      )
    }
  })

  tx()
  // ---------- 14. 线下门店 POS 演示数据 ----------
  // **已迁走**：门店收银/交班/核款/缴款/日结的演示数据由 `db/pos-seed.js` 负责，
  // 在 boot.js 里排在 seedAll 之后单独执行。
  //
  // 为什么必须迁走 —— 原来这一段是**裸 INSERT**：班次只写四个字段（没有单号、没有
  // 系统应收、没有支付方式明细），订单直接插成 local/synced。它对 024 之前的结构是
  // 够用的，但交班核款模块上线之后，「钱对不对得上」的每个数字都需要被推导出来：
  //   · 班次没有单号 → 缴款单与日结单上「指回哪个班次」是空的；
  //   · 没有 `pos_shift_payments` → 核款界面上一个支付方式都列不出来；
  //   · 订单没有 `shift_id` → 系统应收只能靠「同门店 + 同业务日 + 同收银员」现算，
  //     同一个收银员一天两个班就会把现金应收算成两倍。
  // 而裸 INSERT 无法自己维护这些派生关系（它是一个「写死值」的动作，不是一条流程）。
  // 迁到 pos-seed.js 之后，造数走的是与界面点击**同一条服务函数**，
  // 上面这几类分叉在结构上不可能发生。

  // ---------- 15. H5 商城会员演示 ----------
  db.transaction(() => {
    const insCust = db.prepare(
      'INSERT INTO mall_customers (phone,name,points,total_orders,total_amount,last_active_at) VALUES (?,?,?,?,?,?)'
    )
    const h5Id = db.prepare("SELECT id FROM platforms WHERE code='H5'").get()?.id
    const customers = [
      ['13901390001', '顾小鹿'], ['13901390002', 'Vivi 酱'], ['13901390003', '林深见鹿'], ['13901390004', '柚子茶']
    ]
    for (const [phone, name] of customers) {
      const agg = h5Id
        ? db
            .prepare(
              "SELECT COUNT(*) c, COALESCE(SUM(pay_amount),0) a FROM oms_orders WHERE platform_id=? AND (receiver_phone=? OR buyer_nick=?)"
            )
            .get(h5Id, phone, `会员${phone}`)
        : { c: 0, a: 0 }
      insCust.run(phone, name, Math.floor(agg.a), agg.c, Number(agg.a.toFixed(2)), ymdhms(dayAgo(RI(0, 3))))
    }
    log('H5 会员 %d 个', customers.length)
  })()


  // ---------- 16. 门店要货（门店 → 总部受理）----------
  const ymOf = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
  const saleSkus = skuList.filter((s) => !s.code.startsWith(MATERIAL_PREFIX))
  const materialSkus = skuList.filter((s) => s.code.startsWith(MATERIAL_PREFIX))
  db.transaction(() => {
    const insReq = db.prepare(
      `INSERT INTO store_requisitions (doc_no,store_id,store_warehouse_id,req_date,expect_date,applicant,urgency,status,source,total_qty,total_amount,remark,created_by)
       VALUES (?,?,?,?,?,?,?,?, 'pos',?,?,?,null)`
    )
    const insItem = db.prepare(
      'INSERT INTO store_requisition_items (requisition_id,sku_id,qty,approved_qty,store_stock,price,status) VALUES (?,?,?,?,?,?,?)'
    )
    const ST = ['submitted', 'submitted', 'processing', 'transferred', 'allocated', 'completed']
    let n = 0
    for (let si = 0; si < storeIds.length; si++) {
      for (let k = 0; k < RI(2, 4); k++) {
        const d = ymd(dayAgo(RI(0, 12)))
        const status = R(ST)
        const docNo = `SQ${d.replace(/-/g, '')}${String(++n).padStart(4, '0')}`
        const picks = PICK(saleSkus, RI(2, 5))
        let tq = 0
        let ta = 0
        const lines = picks.map((s) => {
          const qty = RI(5, 60)
          tq += qty
          ta += qty * s.cost
          return { s, qty }
        })
        const info = insReq.run(
          docNo, storeIds[si], storeWhIds[si], d, d, STORES[si][6], R(['normal', 'normal', 'urgent']), status,
          tq, Number(ta.toFixed(2)), R(['常规补货', '促销备货', '畅销款补货', '季节上新'])
        )
        for (const l of lines) {
          const done = ['transferred', 'allocated', 'completed'].includes(status)
          insItem.run(info.lastInsertRowid, l.s.id, l.qty, done ? l.qty : 0, RI(0, 20), l.s.cost, done ? 'approved' : 'pending')
        }
      }
    }
    log('门店要货单 %d 张', n)
  })()

  // ---------- 16.5 门店发货与选择性收货（总部参考要货单发货 → 门店选择性收货）----------
  db.transaction(() => {
    const insShip = db.prepare(
      `INSERT INTO store_shipments
         (doc_no,requisition_id,store_id,from_warehouse_id,to_warehouse_id,ship_date,status,total_qty,received_qty,diff_qty,total_amount,
          receiver,carrier,express_no,shipped_at,received_at,remark,created_by)
       VALUES (?,?,?,?,?,?,?,0,0,0,0,?,?,?,?,?,?,null)`
    )
    const insShipItem = db.prepare(
      `INSERT INTO store_shipment_items
         (shipment_id,requisition_item_id,sku_id,req_qty,ship_qty,recv_qty,diff_qty,price,amount,batches,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    const upsReq = db.prepare('UPDATE store_requisitions SET status=?, linked_shipment_ids=? WHERE id=?')
    const reqRows = db
      .prepare("SELECT * FROM store_requisitions WHERE status IN ('submitted','processing','allocated','completed') ORDER BY id")
      .all()
    // 优先给首家门店（store01 可登录）生成发货单，保证门店端演示数据完整
    const ordered = [...reqRows].sort(
      (a, b) => (a.store_id === storeIds[0] ? 0 : 1) - (b.store_id === storeIds[0] ? 0 : 1) || a.id - b.id
    )
    // 状态按序轮转：前几张为「已发货」，保证门店端有待收货数据
    const SHIP_STATES = ['shipped', 'shipped', 'received', 'partial', 'draft', 'received', 'shipped', 'partial', 'received', 'draft', 'shipped', 'received']
    let sn = 0
    let made = 0
    let recvDone = 0
    for (const req of ordered.slice(0, 12)) {
      const items = db.prepare('SELECT * FROM store_requisition_items WHERE requisition_id=?').all(req.id)
      if (!items.length) continue
      const fromWhId = mainWh
      const toWhId = req.store_warehouse_id || storeWhIds[Math.max(storeIds.indexOf(req.store_id), 0)]
      if (!fromWhId || !toWhId) continue
      const status = SHIP_STATES[sn % SHIP_STATES.length]
      const sd = ymd(dayAgo(RI(1, 10)))
      const docNo = `FH${sd.replace(/-/g, '')}${String(++sn).padStart(4, '0')}`

      // 选择性发货：只挑部分要货行，且数量按要货量打折
      const shipLines = PICK(items, RI(1, Math.min(items.length, 3))).map((it) => ({
        it,
        shipQty: Math.max(1, Math.round(Number(it.qty) * R([0.5, 0.7, 0.8, 1, 1])))
      }))
      let validLines = shipLines
      const prepared = []
      if (status !== 'draft') {
        validLines = []
        for (const l of shipLines) {
          const { picks: batches, shortage } = pickBatches(db, fromWhId, l.it.sku_id, l.shipQty)
          if (shortage > 0) continue // 该行发货仓缺货，本次不发货（不整单放弃）
          validLines.push(l)
          prepared.push({ batches })
        }
        if (!validLines.length) continue
        for (let i = 0; i < validLines.length; i++) {
          for (const b of prepared[i].batches) {
            applyStockOut(db, {
              bizDate: sd, docType: 'SHP_OUT', docNo, docId: null,
              warehouseId: fromWhId, skuId: validLines[i].it.sku_id, batchNo: b.batchNo,
              qty: b.qty, unitCost: b.unitCost, operator: '沈仓管', remark: `门店发货 ${docNo}`
            })
          }
        }
      }

      const info = insShip.run(
        docNo, req.id, req.store_id, fromWhId, toWhId, sd, status,
        null, R(['顺丰速运', '京东物流', '自有配送']), `SF${RI(100000000, 999999999)}`,
        status === 'draft' ? null : `${sd} 10:30:00`, null,
        `参考要货单 ${req.doc_no} 发货`
      )
      const sid = info.lastInsertRowid
      let tq = 0
      let ta = 0
      let rq = 0
      let diffSum = 0
      for (let i = 0; i < validLines.length; i++) {
        const l = validLines[i]
        const price = Number(l.it.price || 0)
        const amount = Number((l.shipQty * price).toFixed(2))
        const batches = status === 'draft' ? [] : prepared[i].batches
        const batchJson = batches.length
          ? JSON.stringify(batches.map((b) => ({ batchNo: b.batchNo, qty: b.qty, unitCost: Number(b.unitCost || 0) })))
          : null
        // 门店收货：全收 / 全收但短少 / 部分行未收
        let recvQty = null
        if (status === 'received') recvQty = R([l.shipQty, l.shipQty, Math.max(1, l.shipQty - RI(1, 2))])
        else if (status === 'partial' && i === 0) recvQty = Math.max(1, l.shipQty - RI(1, 3))
        const diff = recvQty == null ? null : Number((recvQty - l.shipQty).toFixed(2))
        if (diff != null) diffSum += diff
        insShipItem.run(sid, l.it.id, l.it.sku_id, Number(l.it.qty), l.shipQty, recvQty, diff, price, amount, batchJson, null)
        if (recvQty != null && recvQty > 0) {
          const rd = ymd(dayAgo(RI(0, 3)))
          const useBatches = batches.length ? batches : [{ batchNo: '', qty: l.shipQty, unitCost: price }]
          let remain = recvQty
          for (const b of useBatches) {
            if (remain <= 0) break
            const take = Math.min(Number(b.qty) || 0, remain)
            if (take <= 0) continue
            applyStockIn(db, {
              bizDate: rd, docType: 'SHP_IN', docNo, docId: sid,
              warehouseId: toWhId, skuId: l.it.sku_id, batchNo: b.batchNo || '',
              qty: take, unitCost: Number(b.unitCost || price), operator: '李晶', remark: `门店收货 ${docNo}`
            })
            remain -= take
          }
          rq += recvQty
          recvDone++
        }
        tq += l.shipQty
        ta += amount
      }
      // 若标称部分收货但实际全部收完，则回退为已收货
      const pendingLeft = db
        .prepare('SELECT COUNT(*) c FROM store_shipment_items WHERE shipment_id=? AND recv_qty IS NULL')
        .get(sid).c
      let finalStatus = status
      if (status !== 'draft' && pendingLeft === 0) finalStatus = 'received'
      if (status === 'partial' && pendingLeft === 0) finalStatus = 'received'
      db.prepare(
        `UPDATE store_shipments SET status=?, total_qty=?, received_qty=?, diff_qty=?, total_amount=?,
           shipped_at=?, received_at=?, receiver=? WHERE id=?`
      ).run(
        finalStatus, tq, rq, Number(diffSum.toFixed(2)), Number(ta.toFixed(2)),
        status === 'draft' ? null : `${sd} 10:30:00`,
        finalStatus === 'received' ? `${sd} 16:20:00` : null,
        finalStatus === 'received' ? STORES[Math.max(storeIds.indexOf(req.store_id), 0)][6] : null,
        sid
      )
      upsReq.run(finalStatus === 'received' ? 'received' : finalStatus === 'draft' ? 'processing' : 'shipped', String(sid), req.id)
      made++
    }
    log('门店发货单 %d 张（已收货 %d 行）', made, recvDone)
  })()

  // ---------- 17. 经销商要货申请与要货计划 ----------
  db.transaction(() => {
    const insDR = db.prepare(
      `INSERT INTO dealer_requisitions (doc_no,dealer_id,req_date,expect_date,applicant,status,total_qty,total_amount,remark,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,null)`
    )
    const insItem = db.prepare('INSERT INTO dealer_requisition_items (requisition_id,sku_id,qty,price,amount) VALUES (?,?,?,?,?)')
    const DS = ['submitted', 'submitted', 'submitted', 'approved', 'converted', 'rejected']
    let n = 0
    for (let i = 0; i < 26; i++) {
      const dealerId = R(dealerIds)
      const d = ymd(dayAgo(RI(0, 25)))
      const docNo = `DR${d.replace(/-/g, '')}${String(++n).padStart(4, '0')}`
      const picks = PICK(saleSkus, RI(2, 6))
      let tq = 0
      let ta = 0
      const lines = picks.map((s) => {
        const qty = RI(20, 200)
        tq += qty
        ta += qty * s.dealer
        return { s, qty }
      })
      const info = insDR.run(
        docNo, dealerId, d, d, R(['王经理', '李主管', '张总', '陈采购']), R(DS), tq, Number(ta.toFixed(2)),
        R(['常规补货', '旺季备货', '新品试销', '门店陈列'])
      )
      for (const l of lines) insItem.run(info.lastInsertRowid, l.s.id, l.qty, l.s.dealer, Number((l.qty * l.s.dealer).toFixed(2)))
    }
    log('经销商要货申请 %d 张', n)

    const up = db.prepare(
      `INSERT INTO dealer_requisition_plans (dealer_id,period,sku_id,plan_qty,plan_amount,status)
       VALUES (?,?,?,?,?, 'forecast') ON CONFLICT(dealer_id,period,sku_id) DO NOTHING`
    )
    const periods = [ymOf(now()), ymOf(addMonths(now(), 1)), ymOf(addMonths(now(), 2))]
    let pc = 0
    for (const dealerId of dealerIds) {
      for (const period of periods) {
        for (const s of PICK(saleSkus, RI(6, 12))) {
          const qty = RI(30, 300)
          up.run(dealerId, period, s.id, qty, Number((qty * s.dealer).toFixed(2)))
          pc++
        }
      }
    }
    log('经销商要货计划 %d 行', pc)
  })()

  // ---------- 18. 委外订单（含发料 / 收货）----------
  db.transaction(() => {
    // 确保中心仓有原料/包材库存（供委外发料）
    // 生产日期沿用数据集的期初窗口：写死 40 天前对短保物料（净菜 3~5 天）会直接造出过保批次
    for (const m of materialSkus) {
      try {
        const matProduce = dayAgo(RI(LOOKBACK_INIT[0], LOOKBACK_INIT[1]))
        applyStockIn(db, {
          bizDate: ymd(dayAgo(INIT_BIZ_DAYS)), docType: 'INIT', docNo: `INIT${ymd(dayAgo(INIT_BIZ_DAYS)).replace(/-/g, '')}`,
          warehouseId: mainWh, skuId: m.id, batchNo: seedBatchNo(m.code, matProduce),
          produceDate: ymd(matProduce), expireDate: ymdOrNull(expireOf(matProduce, m.shelf || 0, 24)), qty: 3000,
          unitCost: m.cost, operator: '系统初始化', remark: '原料包材备货'
        })
      } catch {
        /* ignore */
      }
    }
    const insOS = db.prepare(
      `INSERT INTO outsourcing_orders
         (doc_no,supplier_id,warehouse_id,material_warehouse_id,order_date,expect_date,buyer,status,out_type,
          product_qty,product_amount,material_qty,material_amount,process_fee,total_amount,settle_type,source_type,remark,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'manual',?,null)`
    )
    const insOSItem = db.prepare(
      'INSERT INTO outsourcing_order_items (order_id,role,sku_id,qty,price,amount,issued_qty,received_qty) VALUES (?,?,?,?,?,?,?,?)'
    )
    const insIssue = db.prepare(
      `INSERT INTO outsourcing_materials (doc_no,order_id,supplier_id,warehouse_id,issue_date,status,total_qty,total_amount,operator,remark)
       VALUES (?,?,?,?,?, 'issued',?,?,?,?)`
    )
    const insIssueItem = db.prepare(
      'INSERT INTO outsourcing_material_items (issue_id,sku_id,batch_no,qty,cost_price,amount) VALUES (?,?,?,?,?,?)'
    )
    const insRecv = db.prepare(
      `INSERT INTO outsourcing_receipts (doc_no,order_id,supplier_id,warehouse_id,receipt_date,status,total_qty,process_fee,total_amount,inspector,remark)
       VALUES (?,?,?,?,?, 'received',?,?,?,?,?)`
    )
    const insRecvItem = db.prepare(
      'INSERT INTO outsourcing_receipt_items (receipt_id,sku_id,batch_no,produce_date,expire_date,qty,price,amount) VALUES (?,?,?,?,?,?,?,?)'
    )
    const osProducts = saleSkus.filter((s) => OUTSOURCE_SPUS.some((c) => s.code.startsWith(c)))
    const oemSuppliers = supplierIds.slice(0, 3)
    const OST = ['draft', 'submitted', 'approved', 'issued', 'received', 'received']
    let n = 0
    let issueSeq = 0
    let recvSeq = 0
    for (let i = 0; i < 6; i++) {
      const prod = osProducts[i % osProducts.length]
      if (!prod) continue
      const supplierId = R(oemSuppliers)
      const d = ymd(dayAgo(RI(2, 30)))
      const status = OST[i % OST.length]
      const qty = RI(200, 1200)
      const feeUnit = Number(RF(6, 22).toFixed(2))
      const processFee = Number((qty * feeUnit).toFixed(2))
      const docNo = nextDocNo(db, 'WW', 'outsourcing_orders', 'doc_no', d)
      // 材料需求：半成品基底料 + 包材
      const mats = [
        { m: materialSkus[0], per: 0.05 },
        { m: materialSkus[1], per: 1 },
        { m: materialSkus[2], per: 1 }
      ].filter((x) => x.m)
      const matLines = mats.map((x) => ({ m: x.m, qty: Math.max(1, Math.round(qty * x.per)) }))
      const matQty = matLines.reduce((s, x) => s + x.qty, 0)
      const matAmt = matLines.reduce((s, x) => s + x.qty * x.m.cost, 0)
      const info = insOS.run(
        docNo, supplierId, mainWh, mainWh, d, ymd(addMonths(new Date(d), 1)), '刘采购', status, 'normal',
        qty, Number((qty * prod.cost).toFixed(2)), matQty, Number(matAmt.toFixed(2)), processFee,
        Number((matAmt + processFee).toFixed(2)), R(['月结 30 天', '月结 45 天']), `委外加工 ${prod.productName}`
      )
      const oid = info.lastInsertRowid
      insOSItem.run(oid, 'product', prod.id, qty, feeUnit, processFee, 0, status === 'received' ? qty : 0)
      for (const ml of matLines) insOSItem.run(oid, 'material', ml.m.id, ml.qty, ml.m.cost, Number((ml.qty * ml.m.cost).toFixed(2)), ['issued', 'received'].includes(status) ? ml.qty : 0, 0)

      // 已发料 / 已收货：真实出库与入库
      if (['issued', 'received'].includes(status)) {
        const issueDate = ymd(dayAgo(RI(1, 20)))
        const issueNo = `WWF${issueDate.replace(/-/g, '')}${String(++issueSeq).padStart(4, '0')}`
        const iInfo = insIssue.run(issueNo, oid, supplierId, mainWh, issueDate, 0, 0, '沈仓管', `委外发料 ${docNo}`)
        const issueId = iInfo.lastInsertRowid
        let itq = 0
        let ita = 0
        for (const ml of matLines) {
          const { picks, shortage } = pickBatches(db, mainWh, ml.m.id, ml.qty)
          if (shortage > 0) continue
          for (const b of picks) {
            insIssueItem.run(issueId, ml.m.id, b.batchNo, b.qty, b.unitCost || ml.m.cost, Number((b.qty * (b.unitCost || ml.m.cost)).toFixed(2)))
            try {
              applyStockOut(db, {
                warehouseId: mainWh, skuId: ml.m.id, qty: b.qty, batchNo: b.batchNo, bizDate: issueDate,
                docType: 'WWS_OUT', docNo: issueNo, docId: issueId, counterparty: `委外加工 ${docNo}`, operator: '沈仓管', remark: '委外发料出库'
              })
            } catch {
              /* ignore */
            }
            itq += b.qty
            ita += b.qty * (b.unitCost || ml.m.cost)
          }
        }
        db.prepare('UPDATE outsourcing_materials SET total_qty=?, total_amount=? WHERE id=?').run(itq, Number(ita.toFixed(2)), issueId)

        if (status === 'received') {
          const recvDate = ymd(dayAgo(RI(0, 10)))
          const recvNo = `WWS${recvDate.replace(/-/g, '')}${String(++recvSeq).padStart(4, '0')}`
          const materialShare = qty > 0 ? matAmt / qty : 0
          const unitCost = Number((materialShare + feeUnit).toFixed(2))
          const batchNo = seedBatchNo(prod.code, new Date(recvDate))
          const recvExpire = ymdOrNull(expireOf(new Date(recvDate), prod.shelf || 0, 36))
          const rInfo = insRecv.run(recvNo, oid, supplierId, mainWh, recvDate, qty, processFee, Number((qty * unitCost).toFixed(2)), '质检-徐工', `委外收货 ${docNo}`)
          const rid = rInfo.lastInsertRowid
          insRecvItem.run(rid, prod.id, batchNo, recvDate, recvExpire, qty, feeUnit, Number((qty * feeUnit).toFixed(2)))
          try {
            applyStockIn(db, {
              bizDate: recvDate, docType: 'WWS_IN', docNo: recvNo, docId: rid, warehouseId: mainWh, skuId: prod.id,
              batchNo, produceDate: recvDate, expireDate: recvExpire, qty, unitCost,
              counterparty: `委外加工 ${docNo}`, operator: '沈仓管', remark: '委外收货入库'
            })
          } catch {
            /* ignore */
          }
        }
      }
    }
    log('委外订单 %d 张（含发料 %d / 收货 %d）', n, issueSeq, recvSeq)
  })()

  // ---------- 19. 生产订单与净需求汇总记录 ----------
  db.transaction(() => {
    const selfSkus = db
      .prepare("SELECT s.id, s.sku_code, s.name AS sku_name, s.cost_std, p.shelf_life_months FROM product_skus s JOIN products p ON p.id=s.product_id WHERE p.procurement_type='self'")
      .all()
    // `completed_qty` / `material_cost` / `total_cost` 一律留给模块 10B 的完工链路去写。
    // 这里直接填的后果是「订单写着已完工，而库里查不到任何产出、也没有一张领料单」——
    // 正是模块 10B 的审计口径要抓的那种「账上有一笔、凭证查不到」。
    const insMO = db.prepare(
      `INSERT INTO production_orders (doc_no,product_sku_id,warehouse_id,plan_date,expect_date,status,qty,completed_qty,unit_cost,material_cost,total_cost,source_type,remark,created_by)
       VALUES (?,?,?,?,?,?,?,0,0,0,0, 'manual',?,null)`
    )
    const insMOItem = db.prepare('INSERT INTO production_order_items (order_id,role,sku_id,qty,unit_cost,amount) VALUES (?,?,?,?,?,?)')
    // 状态只到「生产中」：`completed` 必须由完工入库（lib/mfg.js）产生。
    // 多给几张 in_progress，是为了让模块 10B 的制造页有活可干（领料 / 完工各留样本）。
    const MO_STATUSES = ['draft', 'submitted', 'approved', 'in_progress', 'in_progress', 'in_progress']
    let n = 0
    for (let i = 0; i < 6 && selfSkus.length; i++) {
      const sk = selfSkus[i % selfSkus.length]
      const qty = RI(100, 800)
      const unitCost = Number(sk.cost_std || 0)
      const d = ymd(dayAgo(RI(0, 15)))
      const status = MO_STATUSES[i % MO_STATUSES.length]
      const docNo = nextDocNo(db, 'MO', 'production_orders', 'doc_no', d)
      const info = insMO.run(
        docNo, sk.id, mainWh, d, ymd(addMonths(new Date(d), 1)), status, qty,
        R(['旺季备货', '新品首批生产', '常规补产'])
      )
      // **只记成品行，材料行不再手工写。** 「用什么料」的权威来源是 BOM + 领料单；
      // 在这里再记一遍材料行，等于给同一件事造了第二个来源，
      // 而两个来源迟早分叉（BOM 改了、订单行没改），到时分不清哪个对。
      insMOItem.run(info.lastInsertRowid, 'product', sk.id, qty, unitCost, Number((qty * unitCost).toFixed(2)))
      n += 1
    }
    log('生产订单 %d 张（状态至「生产中」，完工由模块 10B 链路产生）', n)

    const insRun = db.prepare(
      `INSERT INTO demand_plan_runs (doc_no,period_start,period_end,warehouse_id,rule,total_sku,total_demand,total_shortage,created_by)
       VALUES (?,?,?,?,?,?,?,?,null)`
    )
    const runs = [
      [ymd(dayAgo(30)), ymd(now())],
      [ymd(now()), ymd(addMonths(now(), 1))]
    ]
    for (const [s, e] of runs) {
      insRun.run(
        nextDocNo(db, 'DP', 'demand_plan_runs', 'doc_no', s), s, e, mainWh,
        JSON.stringify({ purchase: 3, production: 2, outsourcing: 1 }), RI(20, 40), RI(2000, 9000), RI(500, 3000)
      )
    }
    log('净需求汇总记录 %d 条', runs.length)
  })()

  // 汇总
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
  const summary = {
    users: count('users'),
    store_requisitions: count('store_requisitions'),
    store_shipments: count('store_shipments'),
    outsourcing_orders: count('outsourcing_orders'),
    dealer_requisitions: count('dealer_requisitions'),
    dealer_plans: count('dealer_requisition_plans'),
    production_orders: count('production_orders'),
    brands: count('brands'),
    products: count('products'),
    skus: count('product_skus'),
    warehouses: count('warehouses'),
    stores: count('stores'),
    suppliers: count('suppliers'),
    dealers: count('dealers'),
    platforms: count('platforms'),
    purchase_orders: count('purchase_orders'),
    receipts: count('purchase_receipts'),
    sales_orders: count('sales_orders'),
    deliveries: count('sales_deliveries'),
    sales_returns: count('sales_returns'),
    oms_orders: count('oms_orders'),
    inventory_rows: count('inventory_stocks'),
    transactions: count('inventory_transactions'),
    transfers: count('stock_transfers'),
    statements: count('dealer_statements'),
    rebates: count('dealer_rebates'),
    rebate_policies: count('rebate_policies'),
    serials: count('serial_numbers'),
    bundles: count('bundles'),
    assembly_orders: count('assembly_orders'),
    locations: count('warehouse_locations'),
    // 留痕对账：正常应为 0。不为 0 说明有单据被删/被重建而留痕没跟着走 ——
    // 那会表现成「单据时间线挂着别人的历史」，而这类错不会报错，只会让人不再相信这张单。
    // 所以每一步灌数结束都自报一次，不留给演示现场去发现。
    orphan_events_removed: pruneOrphanEvents(db).removed
  }
  log('完成：', JSON.stringify(summary, null, 2))
  return summary
}

// 直接执行：node server/db/seed.js [cosmetic|food|apparel] [--reset]
const isDirect = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isDirect) {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'))
  // 行业码非法 ⇒ **非零退出 + 一行用法**（与 scripts/check-inv-txn-dict.mjs / test-guards.mjs
  // 的"未知参数 exit 2"同族）。旧写法把打错的行业码静默换成"当前行业"，
  // 于是 `node server/db/seed.js cossmetic` 会安静地灌另一个库 —— 命令行没人会想到"我打错了"。
  if (arg && !Object.hasOwn(INDUSTRIES, arg)) {
    console.error(`未知行业：${arg}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
    console.error('用法：node server/db/seed.js [cosmetic|food|apparel] [--reset]')
    process.exit(2)
  }
  const industry = arg || getCurrentIndustry()
  console.log(`[seed] 行业：${INDUSTRIES[industry].label} → ${dbPathFor(industry)}`)
  const s = runWithIndustry(industry, () => seedAll({ silent: false }))
  console.log('[seed] 演示数据生成完成')
  console.log(JSON.stringify(s, null, 2))
}
