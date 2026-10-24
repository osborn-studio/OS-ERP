/**
 * ============================================================================
 * 文件标识：server/lib/metrics.js ｜ 数据口径字典（模块 23）
 * ============================================================================
 * 【职责】数据口径字典（模块 23）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 数据口径字典（模块 23）
//
// 要解决的问题：同一个「销售额」，看板按一个状态集算、报表按另一个状态集算、
// AI 问答又按第三种 —— 三个页面的数字互相对不上，而且**没有任何一处说得清
// 到底谁对**。口径一旦散落，争论就永远停在「你这个数不对」，查不下去。
//
// 本模块的口径：**定义与计算必须写在同一处**。
//   每条指标是一个对象，`formula`（给人看的文字口径）与 `compute`（真正跑的 SQL）
//   挨在一起。这样「文档写的」和「代码算的」不可能分家 ——
//   分家正是口径漂移的根源（改了 SQL 忘了改文档，或者反过来）。
//
// 每条口径必须显式回答四个问题，缺一不可：
//   ① formula      怎么算（能照着复现）
//   ② exclusions   不算什么（**排除项比包含项更容易出错**，必须写出来）
//   ③ source       取自哪些表
//   ④ note         什么时候会踩坑 / 为什么这么定
//
// 定义会同步进 `metric_defs` 表（启动时 syncMetricDefs），供 SQL 直查与 AI 理解；
// 但**代码是唯一源**，表只是投影。测试会校验两者一致，防止有人只改一边。

import { getDb } from '../db/index.js'
import { stampDef, defStale } from '../db/migrations/_helpers.cjs'
import { countBelowSafe, stockScopeSql } from './stock.js'
import { purchaseOrderScopeSql, PO_READ_PERMS } from './purchase.js'
import { readSetting } from './settings.js'
import { salesScopeSql, omsOrderScopeSql } from './sales-order.js'
import { ocScope, selfCustomerIdReadOnly } from './order-center.js'
import { boundStoreId, isExternalSubject } from './store-binding.js'

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const num = (v) => Number(v) || 0

/** 通用：把 `days` 变成一个安全的整数天数（防注入，也防手滑传 0 导致除零） */
const days = (p, dflt = 30) => {
  const n = Math.floor(Number(p?.days))
  return Number.isFinite(n) && n > 0 && n <= 3650 ? n : dflt
}

// AD1（ADR-0053）：范围参数。`compute(db, { days, orgScope })`；不传 orgScope = 全局（内部调用 / 看板口径不变）。
// 库存类走 `stockScopeSql`（仓库所属组织），采购订单类走 `purchaseOrderScopeSql`（入库仓所属组织），判据各只有一份。
// 带 `scopeAware: true` 的指标才会按范围收窄；其余指标没有组织归属可套（销售 / 线上 / 财务 / 订货 / 经销商 / 审批），
// 对受限调用者仍是全局口径，由 `metricScopedFlags` 标 `scoped: false`，前端据此标注「全局口径」。
// 绑定主体（门店 / 经销商账号）对库存 / 采购订单类同样失败关闭（Codex AF2 高项：此前 data_scope=all 的绑定账号会拿全局数）
const stockSc = (p, alias = 'st') => stockScopeSql(p?.subjectBound ? { scope: 'none' } : p?.orgScope, alias)
const poSc = (p, alias = 'po') => purchaseOrderScopeSql(p?.subjectBound ? { scope: 'none' } : p?.orgScope, alias)
/** 调用者是否受限（非全局范围）；不传 = 不受限 */
export const isScopeRestricted = (orgScope) => !!orgScope && orgScope.scope !== 'all'

// AF2（ADR-0057 补充）：销售 / 线上 OMS / 订货中心 / POS 指标也按范围计算，**复用各自路由的同一份谓词**，不另写第二份：
//   · 销售：`salesScopeSql`（ADR-0026，出货仓或门店所属组织任一在范围内；退货经来源订单）；
//   · 线上：`omsOrderScopeSql`（ADR-0039 / Y4，平台履约仓 `platforms.warehouse_id` 所属组织）；
//   · 订货中心：`ocScope`（ADR-0027，客户自身组织；外部订货主体只看自己的客户）；
//   · POS：绑定门店的账号只看本店；其余受限账号取门店所属组织（与销售"门店方"同一判据；POS 路由本身没有组织谓词）。
// 计算参数 `p = { days, orgScope, user, subjectBound }`。**绑定主体（门店 / 经销商账号）即使 data_scope=all 也不能拿全局数**：
// 指标的 `bound` 字段声明绑定主体如何处理 ——
//   · `deny`          销售 / 线上是内部组织口径，绑定主体不可见（可见性判据 `boundAllows`；compute 兜底为空范围）；
//   · `self-customer` 订货中心：仅外部订货主体（role=dealer|store）且只算自己的客户，其余绑定账号不可见；
//   · `own-store`     POS：仅绑定了门店的账号，且只算本店；
//   · 不声明（存货 / 采购订单类，AD1 既有指标）行为不变。
const ALL_SQL = { sql: '1=1', params: [], empty: false }
const NONE_SQL = { sql: '1=0', params: [], empty: true }
const salesSc = (p, kind = 'order', alias = 'so') => (p?.subjectBound ? NONE_SQL : salesScopeSql(p?.orgScope, kind, alias))
const omsSc = (p, alias = 'o') => (p?.subjectBound ? NONE_SQL : omsOrderScopeSql(p?.orgScope, alias))
const posSc = (p, alias = 'po') => {
  if (p?.subjectBound) {
    const sid = boundStoreId(p.user)
    return sid ? { sql: `${alias}.store_id = ?`, params: [sid], empty: false } : NONE_SQL
  }
  const s = p?.orgScope
  if (!s || s.scope === 'all') return ALL_SQL
  const ids = Array.isArray(s.orgIds) ? s.orgIds.map(Number).filter(Number.isFinite) : []
  if (s.scope === 'dealer' || s.scope === 'none' || !ids.length) return NONE_SQL
  return { sql: `${alias}.store_id IN (SELECT id FROM stores WHERE org_id IN (${ids.map(() => '?').join(',')}))`, params: ids, empty: false }
}
const ocSc = (db, p, column = 'o.customer_id') => {
  if (!p?.subjectBound && !isScopeRestricted(p?.orgScope)) return ALL_SQL
  // 绑定主体里只有外部订货主体有"自己的客户"；其余（如绑了门店的内部角色）不能借 data_scope=all 读全量
  if (p?.subjectBound && !isExternalSubject(p.user)) return NONE_SQL
  if (p?.subjectBound) {
    // 只读查本人客户档案：没有档案就是空范围（不能因为读指标而建档，也不能借 data_scope=all 回落到全量）
    const self = selfCustomerIdReadOnly(db, p.user)
    return self ? { sql: `${column} = ?`, params: [self], empty: false } : NONE_SQL
  }
  // 非绑定的受限内部账号：只看组织范围（user 置空，ocScope 不会走 selfCustomerId 的建档路径）
  const sc = ocScope(db, { user: {}, orgScope: p?.orgScope }, column)
  return { sql: sc.sql, params: sc.params, empty: sc.empty }
}

/** 绑定主体（subjectBound）能否看到该指标。未声明 `bound` 的既有指标行为不变（恒真）。 */
export function boundAllows(m, user) {
  if (!m.bound) return true
  if (m.bound === 'self-customer') return isExternalSubject(user)
  if (m.bound === 'own-store') return boundStoreId(user) !== null
  return false // 'deny' 及任何未知值
}

/**
 * 指标字典。分组顺序即字典展示顺序。
 * compute 一律返回数字（金额取两位小数），不返回对象 —— 便于前端直接排队比较。
 */
export const METRICS = [
  // ------------------------------------------------------------------ 销售
  {
    key: 'sales_amount',
    name: '销售额',
    module: '销售',
    perms: ['sales.order.view'],
    category: '规模',
    unit: 'CNY',
    formula: 'SUM(sales_orders.receivable_amount)',
    exclusions: '排除 status IN (draft, cancelled)：草稿与已取消不构成销售',
    source: 'sales_orders',
    note: '应收口径（已含运费、已扣折扣）。线上/线下都算，若要拆分用 channel 维度',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const sc = salesSc(p)
      return round2(num(db.prepare(
        `SELECT COALESCE(SUM(so.receivable_amount),0) v FROM sales_orders so WHERE so.status NOT IN ('draft','cancelled') AND ${sc.sql}`
      ).get(...sc.params).v))
    }
  },
  {
    key: 'sales_qty',
    name: '销售数量',
    module: '销售',
    perms: ['sales.order.view'],
    category: '规模',
    unit: '件',
    formula: 'SUM(sales_orders.total_qty)',
    exclusions: '同销售额：排除 draft / cancelled',
    source: 'sales_orders',
    note: '按单据头的汇总数量，与明细 SUM(qty) 应当一致；不一致说明写入时没同步汇总',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const sc = salesSc(p)
      return num(db.prepare(
        `SELECT COALESCE(SUM(so.total_qty),0) v FROM sales_orders so WHERE so.status NOT IN ('draft','cancelled') AND ${sc.sql}`
      ).get(...sc.params).v)
    }
  },
  {
    key: 'sales_order_count',
    name: '销售订单数',
    module: '销售',
    perms: ['sales.order.view'],
    category: '规模',
    unit: '单',
    formula: 'COUNT(sales_orders)',
    exclusions: '同销售额：排除 draft / cancelled',
    source: 'sales_orders',
    note: '客单价与连带率的分母，必须与销售额用同一状态集 —— 否则算出来的比值没有意义',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const sc = salesSc(p)
      return num(db.prepare(
        `SELECT COUNT(*) v FROM sales_orders so WHERE so.status NOT IN ('draft','cancelled') AND ${sc.sql}`
      ).get(...sc.params).v)
    }
  },
  {
    key: 'avg_order_value',
    name: '客单价',
    module: '销售',
    perms: ['sales.order.view'],
    category: '效率',
    unit: 'CNY',
    formula: '销售额 / 销售订单数',
    exclusions: '分子分母同用「排除 draft / cancelled」的口径',
    source: 'sales_orders',
    note: '订单数为 0 时返回 0，不返回 null —— 界面上 null 会显示成空白，看不出是 0 还是没算',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const a = METRIC_BY_KEY.sales_amount.compute(db, p)
      const n = METRIC_BY_KEY.sales_order_count.compute(db, p)
      return n > 0 ? round2(a / n) : 0
    }
  },
  {
    key: 'attach_rate',
    name: '连带率',
    module: '销售',
    perms: ['sales.order.view'],
    category: '效率',
    unit: '件/单',
    formula: '销售数量 / 销售订单数',
    exclusions: '同销售额口径',
    source: 'sales_orders',
    note: '反映「一单带几件」。低于 1 说明有订单头数量没同步（正常业务不可能 < 1）',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const q = METRIC_BY_KEY.sales_qty.compute(db, p)
      const n = METRIC_BY_KEY.sales_order_count.compute(db, p)
      return n > 0 ? round2(q / n) : 0
    }
  },
  {
    key: 'return_rate',
    name: '退货率',
    module: '销售',
    perms: ['sales.order.view'],
    category: '效率',
    unit: '%',
    formula: '销售退货金额 / 销售额 × 100',
    exclusions: '退货只取 sales_returns 里 status<>cancelled 的；销售额分母同「销售额」口径',
    source: 'sales_returns, sales_orders',
    note: '分子分母如果一边含运费一边不含，退货率会系统性偏离 —— 这里两边都取单据金额口径',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const sc = salesSc(p, 'return', 'sr')
      const r = num(db.prepare(
        `SELECT COALESCE(SUM(sr.total_amount),0) v FROM sales_returns sr WHERE sr.status NOT IN ('cancelled') AND ${sc.sql}`
      ).get(...sc.params).v)
      const a = METRIC_BY_KEY.sales_amount.compute(db, p)
      return a > 0 ? round2((r / a) * 100) : 0
    }
  },
  {
    key: 'unpaid',
    name: '未回款',
    module: '销售',
    perms: ['finance.receivable.view', 'sales.order.view'],
    category: '资金',
    unit: 'CNY',
    formula: 'SUM(receivable_amount - paid_amount)',
    exclusions: '排除 draft / cancelled；负数（超收）按原样保留，便于发现录入错误',
    source: 'sales_orders',
    note: '"超过已收" 时若取 GREATEST(0, ...) 会把错账抹平 —— 宁可让它显示负数',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const sc = salesSc(p)
      return round2(num(db.prepare(
        `SELECT COALESCE(SUM(so.receivable_amount - so.paid_amount),0) v FROM sales_orders so
          WHERE so.status NOT IN ('draft','cancelled') AND ${sc.sql}`
      ).get(...sc.params).v))
    }
  },

  // ------------------------------------------------------------------ 线上
  {
    key: 'gmv',
    name: '线上 GMV',
    module: '线上 OMS',
    perms: ['oms.order.view'],
    category: '规模',
    unit: 'CNY',
    formula: 'SUM(oms_orders.pay_amount)',
    exclusions: '排除 status = refunded（已退款不计成交）；pending（未支付）另计',
    source: 'oms_orders',
    note: '平台成交口径。与「销售额」不是一回事：GMV 含未转销售订单的部分，两者不应相等',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const sc = omsSc(p)
      return round2(num(db.prepare(
        `SELECT COALESCE(SUM(o.pay_amount),0) v FROM oms_orders o WHERE o.status <> 'refunded' AND ${sc.sql}`
      ).get(...sc.params).v))
    }
  },
  {
    key: 'oms_order_count',
    name: '线上订单数',
    module: '线上 OMS',
    perms: ['oms.order.view'],
    category: '规模',
    unit: '单',
    formula: 'COUNT(oms_orders)',
    exclusions: '排除 status = refunded',
    source: 'oms_orders',
    note: '与 GMV 同口径，便于算线上客单价',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const sc = omsSc(p)
      return num(db.prepare(`SELECT COUNT(*) v FROM oms_orders o WHERE o.status <> 'refunded' AND ${sc.sql}`).get(...sc.params).v)
    }
  },

  // ------------------------------------------------------------------ 存货
  {
    key: 'stock_qty',
    name: '库存数量',
    module: '存货',
    perms: ['inventory.stock.view'],
    category: '规模',
    unit: '件',
    formula: 'SUM(inventory_stocks.qty_on_hand)',
    exclusions: '不含在途（qty_in_transit）；不含已占用（那是可用量的事）',
    source: 'inventory_stocks',
    note: '实物层口径 —— 仓里真的有多少。跨批次汇总，不看批次明细',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const sc = stockSc(p)
      return num(db.prepare(`SELECT COALESCE(SUM(st.qty_on_hand),0) v FROM inventory_stocks st WHERE ${sc.sql}`).get(...sc.params).v)
    }
  },
  {
    key: 'available_qty',
    name: '可用量',
    module: '存货',
    perms: ['inventory.stock.view'],
    category: '规模',
    unit: '件',
    formula: 'SUM(qty_on_hand - qty_reserved)',
    exclusions: '不含在途（预计入库），也不含冻结 —— 本演示系统暂未启用冻结维度',
    source: 'inventory_stocks',
    note: '「现在能卖多少」。与库存数量的差就是被订单占用的部分',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const sc = stockSc(p)
      return num(db.prepare(
        `SELECT COALESCE(SUM(st.qty_on_hand - st.qty_reserved),0) v FROM inventory_stocks st WHERE ${sc.sql}`
      ).get(...sc.params).v)
    }
  },
  {
    key: 'stock_amount',
    name: '库存金额',
    module: '存货',
    perms: ['inventory.cost.view'],
    category: '资金',
    unit: 'CNY',
    formula: 'SUM(inventory_stocks.cost_amount)',
    exclusions: '成本口径，不是售价口径；不含未入库的采购在途',
    source: 'inventory_stocks',
    note: '用表上的 cost_amount 列（写入时已按 cost_price 算好），不在这里现乘 —— 现乘会与流水里的余额口径打架',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const sc = stockSc(p)
      return round2(num(db.prepare(`SELECT COALESCE(SUM(st.cost_amount),0) v FROM inventory_stocks st WHERE ${sc.sql}`).get(...sc.params).v))
    }
  },
  {
    key: 'turnover_days',
    name: '库存周转天数',
    module: '存货',
    perms: ['inventory.stock.view'],
    category: '效率',
    unit: '天',
    formula: '当前库存数量 / (近 N 天出库量 / N)，N 默认 30',
    exclusions: '出库只取 direction=out 的流水；仓库调拨不在指标内单独剔除（演示系统不做调拨剔除）',
    source: 'inventory_stocks, inventory_transactions',
    note: '按数量算而不是按金额 —— 演示数据里同一 SKU 的单价跨度大，按金额算会被高价品带偏',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const d = days(p, 30)
      const sc = stockSc(p, 'it')
      const out = num(db.prepare(
        `SELECT COALESCE(SUM(it.qty),0) v FROM inventory_transactions it
          WHERE it.direction='out' AND it.biz_date >= date('now','localtime','-' || ? || ' days') AND ${sc.sql}`
      ).get(d, ...sc.params).v)
      if (out <= 0) return 0 // 无出库 → 周转天数无意义，返回 0 而不是 Infinity
      const stock = METRIC_BY_KEY.stock_qty.compute(db, p)
      return round2(stock / (out / d))
    }
  },
  {
    key: 'below_safe',
    name: '低于安全库存 SKU 数',
    module: '存货',
    perms: ['inventory.stock.view'],
    category: '风险',
    unit: '个',
    formula: 'COUNT(SKU WHERE 该 SKU 库存合计 < 安全库存)',
    exclusions: '安全库存为 0 或空的 SKU、非 active 状态的 SKU 不参与（未设基准就没有「低于」可言；停用品不需要补货）',
    source: 'product_skus, inventory_stocks',
    note: '按 SKU 跨仓汇总后再比，不是逐仓比 —— 逐仓比会把「A 仓缺但 B 仓有」也算成缺货',
    // AA5：与看板、预警页、AI、MCP 同一口径（lib/stock.js countBelowSafe）；口径多了 status='active'（停用 SKU 不再计入）
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => num(countBelowSafe(db, p?.subjectBound ? { scope: 'none' } : p?.orgScope))
  },
  {
    key: 'expiring_qty',
    name: '临期数量',
    module: '存货',
    perms: ['inventory.stock.view'],
    category: '风险',
    unit: '件',
    formula: 'SUM(qty_on_hand) WHERE expire_date <= today + N 天，N 默认 90',
    exclusions: '无到期日（expire_date 为空）的批次不计；已过期的**计入**（更该被看见）',
    source: 'inventory_stocks',
    note: '默认 90 天。过期批次故意不剔除 —— 剔除会把最该处理的货从预警里藏起来',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const d = days(p, 90)
      const sc = stockSc(p)
      return num(db.prepare(
        `SELECT COALESCE(SUM(st.qty_on_hand),0) v FROM inventory_stocks st
          WHERE st.expire_date IS NOT NULL AND st.expire_date <> ''
            AND st.expire_date <= date('now','localtime','+' || ? || ' days') AND ${sc.sql}`
      ).get(d, ...sc.params).v)
    }
  },

  // ------------------------------------------------------------------ 采购
  {
    key: 'purchase_amount',
    name: '采购金额',
    module: '采购',
    perms: PO_READ_PERMS,
    category: '规模',
    unit: 'CNY',
    formula: 'SUM(purchase_orders.total_amount)',
    exclusions: '排除 status = cancelled；草稿（draft）**计入**',
    source: 'purchase_orders',
    note: '草稿计入是有意的：采购金额看的是「已经谈定的量」，草稿也占用了采购意图。' +
      '要看「已生效」请用 purchase_amount_effective',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const sc = poSc(p)
      return round2(num(db.prepare(
        `SELECT COALESCE(SUM(po.total_amount),0) v FROM purchase_orders po WHERE po.status <> 'cancelled' AND ${sc.sql}`
      ).get(...sc.params).v))
    }
  },
  {
    key: 'purchase_amount_effective',
    name: '采购金额（已生效）',
    module: '采购',
    perms: PO_READ_PERMS,
    category: '规模',
    unit: 'CNY',
    formula: 'SUM(purchase_orders.total_amount)',
    exclusions: '排除 status IN (draft, cancelled)',
    source: 'purchase_orders',
    note: '与 purchase_amount 只差一个 draft —— 两个口径都留着，是为了让「草稿占多少」可以被量化',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const sc = poSc(p)
      return round2(num(db.prepare(
        `SELECT COALESCE(SUM(po.total_amount),0) v FROM purchase_orders po WHERE po.status NOT IN ('draft','cancelled') AND ${sc.sql}`
      ).get(...sc.params).v))
    }
  },
  {
    key: 'payable_open',
    name: '应付未结',
    module: '采购',
    perms: ['finance.payable.view', 'purchase.settle.view', 'purchase.payment.view'],
    category: '资金',
    unit: 'CNY',
    formula: 'SUM(purchase_settlements.settle_amount - paid_amount)',
    exclusions: '排除 status = voided（作废结算单不构成应付）',
    source: 'purchase_settlements',
    note: '与采购域「核销生效点=付款单审批通过」同源：paid_amount 由核销明细算出，不是累加出来的',
    compute: (db) =>
      round2(num(db.prepare(
        `SELECT COALESCE(SUM(settle_amount - paid_amount),0) v FROM purchase_settlements
          WHERE status <> 'voided'`
      ).get().v))
  },

  // ------------------------------------------------------------------ 订货
  {
    key: 'oc_order_amount',
    name: '订货金额',
    module: '订货中心',
    perms: ['order.view'],
    category: '规模',
    unit: 'CNY',
    formula: 'SUM(oc_orders.total_amount)',
    exclusions: '排除 status = cancelled',
    source: 'oc_orders',
    note: '门店要货与经销商订货的合计口径 —— 两者已统一收口为一张单，这里不拆',
    scopeAware: true,
    bound: 'self-customer',
    compute: (db, p) => {
      const sc = ocSc(db, p)
      return round2(num(db.prepare(
        `SELECT COALESCE(SUM(o.total_amount),0) v FROM oc_orders o WHERE o.status <> 'cancelled' AND ${sc.sql}`
      ).get(...sc.params).v))
    }
  },
  {
    key: 'oc_fill_rate',
    name: '订货满足率',
    module: '订货中心',
    perms: ['order.view'],
    category: '效率',
    unit: '%',
    formula: '已完成订货单数 / 非取消订货单数 × 100',
    exclusions: '分母排除 cancelled；分母含在途（submitted/approved/allocated/shipped）',
    source: 'oc_orders',
    note: '在途算「未满足」是刻意的 —— 满足率看的是「客户已经拿到货的比例」，在途还没拿到',
    scopeAware: true,
    bound: 'self-customer',
    compute: (db, p) => {
      const sc = ocSc(db, p)
      const all = num(db.prepare(`SELECT COUNT(*) v FROM oc_orders o WHERE o.status <> 'cancelled' AND ${sc.sql}`).get(...sc.params).v)
      const done = num(db.prepare(`SELECT COUNT(*) v FROM oc_orders o WHERE o.status = 'completed' AND ${sc.sql}`).get(...sc.params).v)
      return all > 0 ? round2((done / all) * 100) : 0
    }
  },

  // ------------------------------------------------------------------ 门店
  {
    key: 'pos_sales',
    name: '门店零售额',
    module: '门店 POS',
    perms: ['pos.view'],
    category: '规模',
    unit: 'CNY',
    formula: 'SUM(pos_orders.pay_amount)',
    exclusions: '按实收（pay_amount）而不是吊牌额（total_amount）；已作废单不在表内',
    source: 'pos_orders',
    note: '门店口径用「实收」—— 折扣与抹零都发生在收银台，用 total_amount 会高估',
    scopeAware: true,
    bound: 'own-store',
    compute: (db, p) => {
      const sc = posSc(p)
      return round2(num(db.prepare(`SELECT COALESCE(SUM(po.pay_amount),0) v FROM pos_orders po WHERE ${sc.sql}`).get(...sc.params).v))
    }
  },

  // ------------------------------------------------------------------ 往来
  {
    key: 'credit_usage',
    name: '信用占用率',
    module: '经销商',
    perms: ['credit.view'],
    category: '风险',
    unit: '%',
    formula: 'SUM(credit_used) / SUM(credit_limit) × 100',
    exclusions: '授信额度为 0 或空的经销商不参与分母（未授信就没有占用率）',
    source: 'dealers',
    note: '整体口径。单客户超限请用 dealer 维度看明细 —— 整体 60% 里可能藏着几个 120%。' +
      '无范围语义（AF2）：经销商档案路由本身没有组织谓词，指标不另造；受限范围下默认隐藏',
    compute: (db) => {
      const r = db.prepare(
        `SELECT COALESCE(SUM(credit_used),0) u, COALESCE(SUM(credit_limit),0) l
           FROM dealers WHERE COALESCE(credit_limit,0) > 0`
      ).get()
      return num(r.l) > 0 ? round2((num(r.u) / num(r.l)) * 100) : 0
    }
  },
  {
    key: 'over_credit_dealers',
    name: '超授信经销商数',
    module: '经销商',
    perms: ['credit.view'],
    category: '风险',
    unit: '个',
    formula: 'COUNT(dealers WHERE credit_used > credit_limit)',
    exclusions: '仅统计授信额度 > 0 的经销商',
    source: 'dealers',
    note: '「占用率」是整体视角，这个才是能直接催办的名单长度',
    compute: (db) =>
      num(db.prepare(
        `SELECT COUNT(*) v FROM dealers
          WHERE COALESCE(credit_limit,0) > 0 AND COALESCE(credit_used,0) > credit_limit`
      ).get().v)
  },

  // ------------------------------------------------------------------ 流程
  {
    key: 'approval_pending',
    name: '待审批单数',
    module: '审批中心',
    perms: ['approval.instance.view', 'system:approval:view', 'system:approval:manage'],
    category: '流程',
    unit: '个',
    formula: 'COUNT(approval_instances WHERE status = pending)',
    exclusions: '不含已通过 / 已驳回 / 已撤回',
    source: 'approval_instances',
    note: '这是「卡住的工作流」规模。与采购待办数不是一回事：待办是「该做」，待审批是「等着别人放行」',
    compute: (db) =>
      num(db.prepare(`SELECT COUNT(*) v FROM approval_instances WHERE status='pending'`).get().v)
  },
  {
    key: 'closed_order_ratio',
    name: '采购订单四段闭环率',
    module: '采购',
    perms: PO_READ_PERMS,
    category: '流程',
    unit: '%',
    formula: '四段全关闭订单数 / 非取消订单数 × 100',
    exclusions: '排除 cancelled；四段 = 到货 / 入库 / 开票 / 付款 全部关闭。' +
      '**不等于** status=closed 的占比 —— 订单可以被提前关闭（剩余不再要了），那时四段并未走完',
    source: 'purchase_orders',
    note: '关闭标记是**只进不退**的推导结果。比率低不代表流程有问题，只代表在途多。' +
      '与「订单关闭率」（status=closed）是两个口径，别混用',
    scopeAware: true,
    bound: 'deny',
    compute: (db, p) => {
      const sc = poSc(p)
      const all = num(db.prepare(`SELECT COUNT(*) v FROM purchase_orders po WHERE po.status <> 'cancelled' AND ${sc.sql}`).get(...sc.params).v)
      const done = num(db.prepare(
        `SELECT COUNT(*) v FROM purchase_orders po WHERE po.status <> 'cancelled'
            AND po.close_arrival=1 AND po.close_inbound=1 AND po.close_invoice=1 AND po.close_payment=1 AND ${sc.sql}`
      ).get(...sc.params).v)
      return all > 0 ? round2((done / all) * 100) : 0
    }
  }
]

/** key → 指标，供 compute 内部互相引用（客单价要通过它拿分子分母） */
export const METRIC_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m]))

/** 去掉 compute（不可序列化），得到可入库/可下发的定义 */
export function metricDefinitions() {
  return METRICS.map((m) => ({
    key: m.key,
    name: m.name,
    module: m.module,
    category: m.category,
    unit: m.unit,
    formula: m.formula,
    exclusions: m.exclusions,
    source: m.source,
    note: m.note
  }))
}

/**
 * 要算 / 要标记的 key 列表：keys 不传（或空数组）= 全部；`allow`（Set）给出时再与之取交集。
 * 注意：`allow` 为空集时结果必须是空，不能因「keys 空 = 全部」而回落到全部（fail-closed）。
 */
function wantKeys(keys, allow) {
  const base = Array.isArray(keys) && keys.length ? keys : METRICS.map((m) => m.key)
  return allow ? base.filter((k) => allow.has(k)) : base
}

// AE1（ADR-0057）：指标可见性 = 调用者持有该指标 `perms` 中任一业务查看权限
//   且（调用者不受限，或设置 `metrics_global_for_restricted=label`，或指标按范围收窄 `scopeAware`）。
// 缺权限 / 无范围语义的指标「缺席」而不是 403；缺席数量以 `hidden_count` 告知，前端据此给一行说明。
export const METRICS_GLOBAL_MODE_KEY = 'metrics_global_for_restricted'

/**
 * 计算调用者可见的指标 key 集合。
 * @param {object} p
 * @param {(code: string) => boolean} p.canPerm 调用者是否持有某权限点（由路由用 permContext/hasPerm 构造；超管恒真）
 * @param {object|null} p.orgScope 调用者数据范围
 * @param {boolean} [p.subjectBound] 账号绑定了门店 / 经销商或是外部订货主体（视同受限，即使数据范围为全部）
 * @param {object|null} [p.user] 调用者（绑定主体对声明了 `bound` 的指标需要看 role / store_id，见 `boundAllows`）
 * @param {string[]|null} [p.keys] 只对这些 key 计数（`/values?keys=`）；不传 = 全部
 * @returns {{ allow: Set<string>, hidden: number }} hidden = 在统计范围内被隐藏的已知指标数
 */
export function metricVisibility(db, { canPerm, orgScope = null, keys = null, subjectBound = false, user = null } = {}) {
  // 绑定了门店 / 经销商的账号即使 data_scope=all 也是受限调用者（其余模块各自按绑定收口，指标没有）
  const restricted = isScopeRestricted(orgScope) || subjectBound
  // 非法 / 未知值读成默认 hide（readSetting 本身对不合法库值回落默认）；只有精确的 label 才放宽
  const hideScopeless = restricted && readSetting(db, METRICS_GLOBAL_MODE_KEY) !== 'label'
  const allow = new Set()
  let hidden = 0
  const considered = Array.isArray(keys) && keys.length ? keys.filter((k) => METRIC_BY_KEY[k]) : METRICS.map((m) => m.key)
  for (const m of METRICS) {
    const ok = (m.perms || []).some((c) => canPerm(c)) && !(hideScopeless && m.scopeAware !== true) &&
      !(subjectBound && !boundAllows(m, user))
    if (ok) allow.add(m.key)
  }
  for (const k of new Set(considered)) if (!allow.has(k)) hidden++
  return { allow, hidden }
}

/** 取指标值。keys 不传则算全部；返回 { key: value } */
export function metricValues(db = getDb(), { keys = null, days: d = 30, orgScope = null, allow = null, user = null, subjectBound = false } = {}) {
  const want = wantKeys(keys, allow)
  const out = {}
  for (const k of want) {
    const m = METRIC_BY_KEY[k]
    if (!m) continue
    try {
      out[k] = m.compute(db, { days: d, orgScope, user, subjectBound })
    } catch (e) {
      // 某条算不出来不该把整页拖垮 —— 但也不能假装它是 0
      out[k] = { error: e.message }
    }
  }
  return out
}

/**
 * 每个指标是否「按调用者范围算」：受限调用者下，`scopeAware` 指标为 true，没有组织归属的全局指标为 false
 * （值仍是全局口径，前端标「全局口径」）；全局调用者一律 true。keys 不传 = 全部。
 */
export function metricScopedFlags(orgScope = null, keys = null, allow = null, subjectBound = false) {
  const restricted = isScopeRestricted(orgScope) || subjectBound
  const want = wantKeys(keys, allow)
  const out = {}
  for (const k of want) if (METRIC_BY_KEY[k]) out[k] = !restricted || METRIC_BY_KEY[k].scopeAware === true
  return out
}

/** 定义 + 当前值（字典页主接口）；每项带 `scoped`（见 metricScopedFlags） */
export function metricCatalog(db = getDb(), { days: d = 30, withValues = true, orgScope = null, allow = null, subjectBound = false, user = null } = {}) {
  const values = withValues ? metricValues(db, { days: d, orgScope, allow, user, subjectBound }) : {}
  const scoped = metricScopedFlags(orgScope, null, allow, subjectBound)
  const defs = Object.fromEntries(metricDefinitions().map((x) => [x.key, x]))
  return METRICS.filter((m) => !allow || allow.has(m.key)).map((m) => ({
    ...defs[m.key],
    scoped: scoped[m.key],
    value: values[m.key] ?? null
  }))
}

// ---------------------------------------------------------------------------
// 同步进 metric_defs 表
// ---------------------------------------------------------------------------

export const METRIC_DEFS_FINGERPRINT_ID = 'metric_defs_sync'

/**
 * 把定义投影进 `metric_defs` 表。
 * 代码是唯一源，表只是投影 —— 供 SQL 直查与 AI 理解表结构用。
 * 每次启动调用（幂等），并写入定义指纹，供漂移检测。
 */
export function syncMetricDefs(db = getDb()) {
  const defs = metricDefinitions()
  const tx = db.transaction(() => {
    const up = db.prepare(
      `INSERT INTO metric_defs (key,name,module,category,unit,formula,exclusions,source,note,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
       ON CONFLICT(key) DO UPDATE SET
         name=excluded.name, module=excluded.module, category=excluded.category, unit=excluded.unit,
         formula=excluded.formula, exclusions=excluded.exclusions, source=excluded.source,
         note=excluded.note, updated_at=excluded.updated_at`
    )
    for (const d of defs) {
      up.run(d.key, d.name, d.module, d.category, d.unit, d.formula, d.exclusions, d.source, d.note)
    }
    // 代码里删掉的指标要从表里清掉，否则字典页与 SQL 查询会各说各话
    const keep = defs.map((d) => d.key)
    if (keep.length) {
      db.prepare(`DELETE FROM metric_defs WHERE key NOT IN (${keep.map(() => '?').join(',')})`).run(...keep)
    }
  })
  tx()
  stampDef(db, METRIC_DEFS_FINGERPRINT_ID, defs)
  return { synced: defs.length }
}

/** 表的定义是否落后于代码（测试与启动自检用） */
export function metricDefsStale(db = getDb()) {
  return defStale(db, METRIC_DEFS_FINGERPRINT_ID, metricDefinitions())
}

/** 分组后的字典（前端分组渲染用） */
export function metricGroups(db = getDb(), { days: d = 30, withValues = true, orgScope = null, allow = null, subjectBound = false, user = null } = {}) {
  const list = metricCatalog(db, { days: d, withValues, orgScope, allow, subjectBound, user })
  const order = []
  const map = new Map()
  for (const m of list) {
    if (!map.has(m.module)) {
      map.set(m.module, [])
      order.push(m.module)
    }
    map.get(m.module).push(m)
  }
  return order.map((mod) => ({ module: mod, items: map.get(mod) }))
}

export default {
  METRICS, METRIC_BY_KEY, metricDefinitions, metricValues, metricCatalog, metricScopedFlags, isScopeRestricted,
  syncMetricDefs, metricDefsStale, metricGroups, metricVisibility, boundAllows
}
