'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/003_inv_dict.cjs ｜ 迁移：库存事务类型字典 inv_txn_types 与库存参数 inv_params
 * ============================================================================
 * 【职责】迁移：库存事务类型字典 inv_txn_types 与库存参数 inv_params
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 003 库存事务类型字典与库存参数
// 依据：把 server/lib/stock.js 里硬编码的 DOC_TYPE_LABEL（19 种）落成数据字典；
//       把拣选规则 / 过保禁售 / 效期预警阈值等从代码里搬到可配置参数。
//
// 定义提到模块级：up() 与 verify() 共用同一份，才能对「定义」本身算指纹，
// 这样改了事务类型或参数默认值，重跑迁移即可自动同步进库（详见 _helpers 的指纹机制）。

const { stampDef, defStale } = require('./_helpers.cjs')

// ---------- 19 种库存事务类型（来源：server/lib/stock.js DOC_TYPE_LABEL） ----------
const TYPES = [
  ['PUR_IN', '采购入库', 'in', 'purchase', 'normal'],
  ['PUR_RET', '采购退货出库', 'out', 'purchase', 'normal'],
  ['SAL_OUT', '销售出库', 'out', 'sales', 'normal'],
  ['SAL_RET', '销售退货入库', 'in', 'sales', 'normal'],
  ['TR_OUT', '调拨出库', 'out', 'transfer', 'transfer'],
  ['TR_IN', '调拨入库', 'in', 'transfer', 'transfer'],
  ['ADJ_IN', '盘盈调整', 'in', 'check', 'normal'],
  ['ADJ_OUT', '盘亏调整', 'out', 'check', 'normal'],
  ['ASM_OUT', '组装组件出库', 'out', 'produce', 'normal'],
  ['ASM_IN', '组装成品入库', 'in', 'produce', 'normal'],
  ['DSM_OUT', '拆卸成品出库', 'out', 'produce', 'normal'],
  ['DSM_IN', '拆卸组件入库', 'in', 'produce', 'normal'],
  ['WWS_OUT', '委外发料出库', 'out', 'outsource', 'normal'],
  ['WWS_IN', '委外收货入库', 'in', 'outsource', 'normal'],
  ['SHP_OUT', '门店发货出库', 'out', 'store', 'transfer'],
  ['SHP_IN', '门店收货入库', 'in', 'store', 'transfer'],
  ['PRD_OUT', '生产领料出库', 'out', 'produce', 'normal'],
  ['PRD_IN', '生产完工入库', 'in', 'produce', 'normal'],
  ['INIT', '期初库存', 'in', 'init', 'normal']
]

// 004 迁移补的货权转移/受托代销/寄售/样品/报废 8 种，一并纳入指纹，避免两处定义割裂。
// 口径说明（勿改）：
//   cost_effect = ownership 跨主体货权转移，等同一次销售+一次采购，要产生结算与损益；
//   cost_effect = consign   委托/受托代销，货物在库但不属于本方存货，不参与本方成本；
//   cost_effect = no_cost   样品领用，出库不结转成本（费用化）；
//   biz_category = consign / other 为 004 引入的新分类，非 base 的 8 类。
// 注意：code/name/direction/biz_category/cost_effect 必须与 004_org_default_and_transfer.cjs 完全一致，
//       否则重跑本迁移的 UPSERT 会把库里正确的定义改坏。
const EXTRA_TYPES = [
  ['TR_OWN_OUT', '货权转移出库', 'out', 'transfer', 'ownership'],
  ['TR_OWN_IN', '货权转移入库', 'in', 'transfer', 'ownership'],
  ['SUP_IN', '受托代销入库', 'in', 'consign', 'consign'],
  ['SUP_OUT', '受托代销出库', 'out', 'consign', 'consign'],
  ['CST_IN', '寄售入库', 'in', 'consign', 'consign'],
  ['CST_OUT', '寄售出库', 'out', 'consign', 'consign'],
  ['SAMPLE_OUT', '样品领用出库', 'out', 'other', 'no_cost'],
  ['SCRAP_OUT', '报废出库', 'out', 'other', 'normal']
]

// ---------- 库存参数默认值 ----------
const PARAMS = [
  ['pick_rule', 'fefo', '批次拣选规则：fefo 先到期先出 / fifo 先进先出'],
  ['block_expired', '1', '过保批次是否禁止拣选（1 禁止）'],
  ['expire_warn_days', '180', '效期预警提前天数'],
  ['expire_warn_hours_short', '24', '短保商品效期预警提前小时数（餐饮线）'],
  // 计价方式。**支持集合由代码声明**（lib/costing.js 的 COST_METHODS），这里只是默认值投影。
  // 写清可选值不是装饰：库里若被改成第三种写法，出库会静默按移动加权算，
  // 而报表口径上写着别的 —— 这正是模块 23 口径字典最忌讳的「口径与算法分家」。
  ['cost_method', 'moving_avg',
    '计价方式：moving_avg 移动加权平均 / batch_actual 分批实际成本（出库取所出批次的真实成本）；'
    + '只支持这两种，其它写法一律拒绝（不能静默按移动加权算）'],
  ['zero_qty_cost', 'keep_last', '数量归零时单位成本处理：keep_last 保留最后成本 / reset 归零'],
  ['batch_time_precision', 'hour', '批次效期精度：hour 到小时 / day 到天'],
  ['negative_stock', '0', '是否允许负库存（1 允许，POS 离线补单场景用）']
]

module.exports.name = '库存事务类型字典 inv_txn_types 与库存参数 inv_params'

module.exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inv_txn_types (
      code         TEXT PRIMARY KEY,        -- PUR_IN / SAL_OUT / TR_OUT ...
      name         TEXT NOT NULL,
      direction    TEXT NOT NULL,           -- in / out
      biz_category TEXT NOT NULL,           -- purchase/sales/transfer/check/produce/outsource/store/init
      cost_effect  TEXT NOT NULL DEFAULT 'normal',  -- normal / transfer（货权转移）/ no_cost
      status       TEXT NOT NULL DEFAULT 'active',
      sort_order   INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS inv_params (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scope       TEXT NOT NULL DEFAULT 'global',   -- global / industry / org
      scope_value TEXT,                              -- 行业码 或 org_id
      param_key   TEXT NOT NULL,
      param_value TEXT,
      remark      TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE (scope, scope_value, param_key)
    );
  `)

  // UPSERT 而非 INSERT OR IGNORE：名称/方向/成本口径改了要能覆盖过来
  const insType = db.prepare(`
    INSERT INTO inv_txn_types (code, name, direction, biz_category, cost_effect, sort_order)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET
      name=excluded.name, direction=excluded.direction,
      biz_category=excluded.biz_category, cost_effect=excluded.cost_effect,
      sort_order=excluded.sort_order
  `)
  // sort_order 沿用 004 的编号习惯：base 10..190，extra 210..280
  TYPES.forEach((t, i) => insType.run(t[0], t[1], t[2], t[3], t[4], (i + 1) * 10))
  EXTRA_TYPES.forEach((t, i) => insType.run(t[0], t[1], t[2], t[3], t[4], 200 + (i + 1) * 10))

  // 参数只补默认值，不覆盖演示时现场调过的值
  const insParam = db.prepare(`
    INSERT OR IGNORE INTO inv_params (scope, scope_value, param_key, param_value, remark)
    VALUES ('global', NULL, ?, ?, ?)
  `)
  PARAMS.forEach((p) => insParam.run(p[0], p[1], p[2]))

  stampDef(db, '003_inv_dict', { TYPES, EXTRA_TYPES, PARAMS })
}

module.exports.verify = function verify(db) {
  const t1 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inv_txn_types'").get()
  const t2 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inv_params'").get()
  if (!t1 || !t2) return false
  if (db.prepare('SELECT COUNT(*) c FROM inv_txn_types').get().c === 0) return false
  if (db.prepare('SELECT COUNT(*) c FROM inv_params').get().c === 0) return false
  // 定义指纹：事务类型 / 参数默认值改了要能被自检发现并重跑
  if (defStale(db, '003_inv_dict', { TYPES, EXTRA_TYPES, PARAMS })) return false
  return true
}
