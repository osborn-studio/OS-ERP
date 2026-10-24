'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/058_pos_permissions.cjs ｜ 门店 POS 路由权限点补全（pos.view / pos.cashdrop.receive）+ 内置角色授权（ADR-0025）
 * ============================================================================
 * 【为什么】`/api/pos` 的 19 条读写路由原来只靠 `storeCtx` 要求"账号绑了门店"：任何门店账号都能核款、驳回、接收缴款。
 *   005 / 024 已经登记了大部分动作的权限点（pos.cashier / pos.refund / pos.shift / pos.shift.review /
 *   pos.cashdrop / pos.dailyclose / pos.store.stock / pos.store.check），但路由从没用过它们。
 *   本迁移只补**字典里确实缺的两个**，不另造同义词：
 *     · `pos.view`              门店 POS 查看（上下文、商品、订单、班次、缴款单、日结、退货、盘点的读接口）；
 *     · `pos.cashdrop.receive`  接收缴款（与 `pos.cashdrop` 发起/取消缴款分开：交钱的人和收钱的人是两个动作）。
 *   默认授权：admin 得到两项；内置 `store`（店长）角色得到两项，并补上 024 当年漏掉的 `pos.cashdrop`
 *   （否则门店账号接上权限闸后连缴款都发起不了）。其余内置角色不授予。
 * 【ADR-0007 口径】授权只在 `up()` 首次执行时给；`verify()` 只查权限字典是否存在，**不**查角色授权集合 ——
 *   管理员削减授权是策略，不是损坏，正常重启不得重授。
 * 【编号】057 之后。运行器按文件名排序。
 * ============================================================================
 */
const { tableExists } = require('./_helpers.cjs')

module.exports.name = '门店 POS 权限点补全（pos.view / pos.cashdrop.receive）与内置角色授权'

const PERMS = [
  ['pos.view', '门店 POS 查看（上下文/商品/订单/班次/缴款/日结/退货/盘点）', 'pos', 'menu', 5300],
  ['pos.cashdrop.receive', '接收门店缴款（与发起缴款分离）', 'pos', 'action', 5310]
]

/** 角色 → 本迁移授予的权限点（含 024 漏给 store 的 pos.cashdrop） */
const ROLE_GRANTS = {
  admin: ['pos.view', 'pos.cashdrop.receive', 'pos.cashdrop'],
  store: ['pos.view', 'pos.cashdrop.receive', 'pos.cashdrop']
}

module.exports.up = (db) => {
  if (!tableExists(db, 'permissions')) return
  const upPerm = db.prepare(
    `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
  )
  for (const p of PERMS) upPerm.run(...p)
  if (!tableExists(db, 'role_permissions')) return
  const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
  const hasRole = db.prepare('SELECT 1 AS hit FROM roles WHERE code=?')
  const hasPerm = db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?')
  for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
    if (!hasRole.get(role)) continue
    for (const code of codes) if (hasPerm.get(code)) ins.run(role, code)
  }
}

module.exports.verify = (db) => {
  if (!tableExists(db, 'permissions')) return true
  const has = db.prepare('SELECT 1 FROM permissions WHERE code=?')
  for (const [code] of PERMS) if (!has.get(code)) return false
  // 角色授权集合是管理员策略（ADR-0007），不在这里重判。
  return true
}
