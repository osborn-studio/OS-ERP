'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/049_scm_role.cjs ｜ 迁移：新增「供应链主管」角色与其权限
 * ============================================================================
 * 【职责】迁移：新增「供应链主管」角色与其权限
 *
 * 【为什么加这个角色】
 *   客户 2026-10-17 口径：演示要能按角色切换 ——「admin 管理员 / 门店店长 / 供应链主管 / 经销商」。
 *   前三个里只有"供应链主管"在既有 9 个内置角色中没有对应：`purchase` 只看采购、
 *   `warehouse` 只看库存，而客户嘴里的"供应链主管"是**一个人管采购 + 库存 + 生产 + 质检**。
 *   用 `boss` 顶替不行 —— boss 是"全公司只读 + 关键审批"，能看财务，与供应链职责不符。
 *
 * 【为什么用迁移而不是改 005】
 *   005 已经在三套库里执行过（`schema_migrations` 有记录），改它不会重跑；
 *   而整库重建时 005 会重跑 —— 两代库就会不一致。迁移只能往后加，这是本项目的既有约定。
 *
 * 【权限怎么定的】
 *   按「供应链主管一天要干的活」列，而不是按模块全给：
 *     · 采购：全流程（含审批）—— 他是这一摊的负责人；
 *     · 库存：查询/调拨/盘点/调整/成本查看；**不给 `inventory.params`**（参数配置属管理员）；
 *     · 生产与委外：查看/编辑/领料/完工，**不给 BOM 维护**（工艺属技术）；
 *     · 质检：查看/判定/不良品处理批准；
 *     · 销售与订货：**只读**（要知道货去哪了，但不改销售单）；
 *     · 财务：只给"查看应付/成本"，**不给任何过账与结算**（钱的事归财务）。
 *   权限点一律先查存在再插 —— 迁移要能在"权限点还没补全"的旧库上安全跑完。
 * ============================================================================
 */

module.exports.name = '新增「供应链主管」角色（scm）与其权限'

const ROLE = ['scm', '供应链主管', '采购 / 库存 / 生产 / 质检 全链路；销售与财务只读', 'all', 25]

/**
 * 供应链主管的权限清单。
 * 用「模块通配」表达（`purchase.` 前缀全给），再显式排除不该给的 ——
 * 这样将来往 purchase 模块加权限点，供应链主管会自动跟上，不需要再改这条迁移。
 */
const GRANT_PREFIX = ['purchase.', 'inventory.', 'produce.', 'quality.', 'approval.', 'ai.']
const GRANT_EXACT = [
  'master.product.view',
  'master.partner.view',
  'master.price.view',
  'sales.order.view',
  'sales.invoice.view',
  'sales.quote.view',
  'credit.view',
  'order.view',
  'order.confirm',
  'order.statement.view',
  'dms.dealer.view',
  'finance.payable.view',
  'inventory.cost.view',
  'cost.view'
]
/** 显式排除：参数配置属管理员；库存参数一改影响全公司 */
const DENY_EXACT = ['inventory.params']

module.exports.up = function up(db) {
  db.prepare(
    'INSERT OR IGNORE INTO roles (code, name, description, is_builtin, data_scope, sort_order) VALUES (?,?,?,1,?,?)'
  ).run(ROLE[0], ROLE[1], ROLE[2], ROLE[3], ROLE[4])

  // 权限点是否存在的判据落在库里（旧库可能还没有后来新增的点）
  const exists = new Set(db.prepare('SELECT code FROM permissions').all().map((r) => r.code))
  const wanted = new Set()
  for (const code of exists) {
    if (DENY_EXACT.includes(code)) continue
    if (GRANT_EXACT.includes(code) || GRANT_PREFIX.some((p) => code.startsWith(p))) wanted.add(code)
  }
  const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)')
  for (const code of wanted) ins.run(ROLE[0], code)
  return wanted.size
}

module.exports.verify = function verify(db) {
  const { tableExists } = require('./_helpers.cjs')
  if (!tableExists(db, 'roles') || !tableExists(db, 'role_permissions')) return false
  const role = db.prepare('SELECT code FROM roles WHERE code=?').get(ROLE[0])
  // Defaults apply on first migration; subsequent administrator changes are
  // policy, including an empty grant set. Do not replay defaults as "repair".
  return !!role
}
