'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/004_org_default_and_transfer.cjs ｜ 迁移：默认主体与货主回填、货权转移事务类型
 * ============================================================================
 * 【职责】迁移：默认主体与货主回填、货权转移事务类型
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 004 默认货主主体 + 存量货主回填 + 货权转移事务类型
//
// 背景（为什么必须有这一迁移）：
//   SQLite 的 UNIQUE 约束把 NULL 视为互不相等，(wh, NULL, sku, batch, cur) 可以重复插入多行，
//   而 002 重建 inventory_stocks 时把 owner_org_id 一律填了 NULL，唯一键等于失效。
//   解决方式：引入 id=0 的「系统默认主体」做兜底货主，并把 NULL 全部回填成 0，
//             之后应用层只写具体货主（从仓库 default_owner_org_id 解析），0 只在极端兜底时出现。
//
// 依据：第二轮 1.2（批次与效期）、第三轮 B2（加盟店独立主体 → 央厨到加盟店是货权转移不是内部调拨）

module.exports.name = '默认主体与货主回填、货权转移事务类型'
module.exports.up = function up(db) {
  // ================= 1. 系统默认主体（id = 0，兜底货主） =================
  db.prepare(
    `INSERT OR IGNORE INTO orgs
       (id, code, name, short_name, type, parent_id, level, path, is_legal, owner_org_id, currency, status, remark)
     VALUES (0, 'SYS_DEFAULT', '系统默认主体', '默认主体', 'group', NULL, 0, '/0/', 0, 0, 'CNY', 'active',
             '未指定货主时的兜底主体，仅系统内部使用')`
  ).run()

  // ================= 2. 存量数据回填 NULL → 0 =================
  const s1 = db.prepare('UPDATE inventory_stocks SET owner_org_id = 0 WHERE owner_org_id IS NULL').run()
  const s2 = db.prepare('UPDATE inventory_transactions SET owner_org_id = 0 WHERE owner_org_id IS NULL').run()
  const s3 = db.prepare("UPDATE inventory_stocks SET currency = 'CNY' WHERE currency IS NULL OR currency = ''").run()

  // ================= 3. 货权转移事务类型 =================
  // 内部调拨（TR_OUT/TR_IN，cost_effect=transfer）货权不变，成本随货平移，不产生损益；
  // 货权转移（TR_OWN_OUT/TR_OWN_IN）跨主体，等同一次销售 + 一次采购，要产生结算与损益。
  const extra = [
    ['TR_OWN_OUT', '货权转移出库', 'out', 'transfer', 'ownership'],
    ['TR_OWN_IN', '货权转移入库', 'in', 'transfer', 'ownership'],
    ['SUP_IN', '受托代销入库', 'in', 'consign', 'consign'],
    ['SUP_OUT', '受托代销出库', 'out', 'consign', 'consign'],
    ['CST_IN', '寄售入库', 'in', 'consign', 'consign'],
    ['CST_OUT', '寄售出库', 'out', 'consign', 'consign'],
    ['SAMPLE_OUT', '样品领用出库', 'out', 'other', 'no_cost'],
    ['SCRAP_OUT', '报废出库', 'out', 'other', 'normal']
  ]
  const insType = db.prepare(
    `INSERT OR IGNORE INTO inv_txn_types (code, name, direction, biz_category, cost_effect, sort_order)
     VALUES (?,?,?,?,?,?)`
  )
  extra.forEach((t, i) => insType.run(t[0], t[1], t[2], t[3], t[4], 200 + (i + 1) * 10))

  // ================= 4. 库存参数补充（餐饮短保 / 跨币种） =================
  const insParam = db.prepare(
    `INSERT OR IGNORE INTO inv_params (scope, scope_value, param_key, param_value, remark)
     VALUES ('global', NULL, ?, ?, ?)`
  )
  ;[
    ['cost_precision', '4', '成本单价小数位'],
    ['allow_negative_for', 'pos_offline', '允许负库存的例外场景（POS 离线补单）'],
    ['transfer_price_rule', 'owner_cost', '跨货主调拨计价：owner_cost 按原货主成本 / price_list 按价格表'],
    ['expire_block_strict', '0', '过保是否全场景硬拦截（0 仅拦截拣选，1 全拦截）']
  ].forEach((p) => insParam.run(p[0], p[1], p[2]))

  return { backfilled_stocks: s1.changes, backfilled_txns: s2.changes, backfilled_currency: s3.changes }
}

module.exports.verify = function verify(db) {
  try {
    const { tableExists } = require('./_helpers.cjs')
    if (!tableExists(db, 'orgs')) return false
    const sys = db.prepare('SELECT id FROM orgs WHERE id=0').get()
    const t = db.prepare("SELECT 1 FROM inv_txn_types WHERE code='TR_OWN_OUT'").get()
    return !!sys && !!t
  } catch {
    return false
  }
}
