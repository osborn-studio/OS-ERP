'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/005_org_permission.cjs ｜ 迁移：组织与权限模型（角色 / 权限点 / 用户多组织多角色 / 数据权限范围）
 * ============================================================================
 * 【职责】迁移：组织与权限模型（角色 / 权限点 / 用户多组织多角色 / 数据权限范围）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 005 组织与权限模型
//
// 依据：
//   第二轮 3（独立审批流设计系统 + 全端适配）
//   第三轮 B1 四层主体 / B2 加盟店独立主体 / B3 央厨归总部 / B5 经销商两级开户
//   框架文档模块 05
//
// 设计要点：
//   1. 权限拆两轴：**功能权限**（能不能看到这个菜单/做这个动作）与**数据权限**（能看到谁的数据），
//      两轴正交，避免「有菜单但看不到数据」或「看得到数据但动不了」的经典坑。
//   2. 角色可自定义（roles 表），内置 8 个扁平角色升级为可扩展角色体系；
//      同时保留 users.role 字段做兼容（老代码 requireRole('admin') 不用改）。
//   3. 一人多组织、一人多角色：user_orgs / user_roles 两张关联表。
//   4. 数据权限默认按**组织子树**（orgs.path 前缀匹配），加盟店独立主体天然隔离。

const { addColumn, tableExists, hasColumn } = require('./_helpers.cjs')

module.exports.name = '组织与权限模型（角色 / 权限点 / 用户多组织多角色 / 数据权限范围）'
module.exports.up = function up(db) {
  // ================= 1. 权限点字典 =================
  db.exec(`
    CREATE TABLE IF NOT EXISTS permissions (
      code        TEXT PRIMARY KEY,          -- 形如 inventory.stock.view
      name        TEXT NOT NULL,
      module      TEXT NOT NULL,             -- master/purchase/sales/inventory/pos/oms/dms/order/system/ai
      category    TEXT NOT NULL DEFAULT 'action',  -- menu 菜单 / action 动作 / data 数据 / api 接口
      description TEXT,
      sort_order  INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_perm_module ON permissions(module);
  `)

  // ================= 2. 角色 =================
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      code        TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      is_builtin  INTEGER NOT NULL DEFAULT 0,
      -- 数据权限范围：all 全部 / subtree 本组织及下级 / org 仅本组织 / self 仅本人 / dealer 仅本经销商
      data_scope  TEXT NOT NULL DEFAULT 'self',
      sort_order  INTEGER DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_code TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
      perm_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
      PRIMARY KEY (role_code, perm_code)
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_code TEXT NOT NULL,
      PRIMARY KEY (user_id, role_code)
    );

    CREATE TABLE IF NOT EXISTS user_orgs (
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      org_id   INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'member',   -- member 成员 / manager 负责人
      PRIMARY KEY (user_id, org_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_orgs_user  ON user_orgs(user_id);
  `)

  // ================= 3. users 挂组织与数据范围 =================
  addColumn(db, 'users', 'org_id', 'INTEGER')
  addColumn(db, 'users', 'data_scope', "TEXT NOT NULL DEFAULT ''")
  addColumn(db, 'users', 'is_super', 'INTEGER NOT NULL DEFAULT 0')

  // ================= 4. 主数据挂组织（补齐 001 未覆盖的） =================
  addColumn(db, 'suppliers', 'org_id', 'INTEGER')
  addColumn(db, 'dealers', 'org_id', 'INTEGER')
  addColumn(db, 'dealers', 'parent_dealer_id', 'INTEGER')   // 经销商两级开户（公司 → 旗下门店）
  addColumn(db, 'dealers', 'region', 'TEXT')
  addColumn(db, 'dealers', 'level', "TEXT DEFAULT 'silver'") // 金牌/银牌（价格组分档依据）
  addColumn(db, 'dealers', 'credit_limit', 'REAL DEFAULT 0')
  addColumn(db, 'dealers', 'credit_days', 'INTEGER DEFAULT 0')

  // ================= 5. 品牌表（餐饮多品牌贯穿组织） =================
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_brands (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      short_name TEXT,
      industry   TEXT,
      theme      TEXT,                         -- 主题色等 UI 配置（双系统两套 UI）
      sort_order INTEGER DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'active'
    );
  `)

  // ================= 6. 内置权限点 =================
  // 覆盖面：主数据 / 采购 / 销售 / 库存 / 门店 POS / 商城 OMS / 经销商 / 订货 / 财务 / 审批 / 系统 / AI
  const perms = [
    // 主数据
    ['master.product.view', '查看商品', 'master', 'menu'],
    ['master.product.edit', '维护商品', 'master', 'action'],
    ['master.partner.view', '查看往来单位', 'master', 'menu'],
    ['master.partner.edit', '维护往来单位', 'master', 'action'],
    ['master.price.view', '查看价格', 'master', 'menu'],
    ['master.price.edit', '维护价格与价格组', 'master', 'action'],
    // 采购
    ['purchase.order.view', '查看采购订单', 'purchase', 'menu'],
    ['purchase.order.edit', '编辑采购订单', 'purchase', 'action'],
    ['purchase.order.approve', '审批采购订单', 'purchase', 'action'],
    ['purchase.inbound', '采购入库', 'purchase', 'action'],
    ['purchase.return', '采购退货', 'purchase', 'action'],
    // 销售
    ['sales.order.view', '查看销售订单', 'sales', 'menu'],
    ['sales.order.edit', '编辑销售订单', 'sales', 'action'],
    ['sales.order.approve', '审批销售订单', 'sales', 'action'],
    ['sales.outbound', '销售出库', 'sales', 'action'],
    ['sales.return', '销售退货', 'sales', 'action'],
    // 库存
    ['inventory.stock.view', '查看库存', 'inventory', 'menu'],
    ['inventory.stock.query', '查询库存明细', 'inventory', 'action'],
    ['inventory.transfer', '调拨', 'inventory', 'action'],
    ['inventory.transfer.ownership', '货权转移', 'inventory', 'action'],
    ['inventory.check', '盘点', 'inventory', 'action'],
    ['inventory.adjust', '库存调整', 'inventory', 'action'],
    ['inventory.cost.view', '查看成本', 'inventory', 'data'],
    ['inventory.batch.view', '查看批次效期', 'inventory', 'menu'],
    ['inventory.params', '库存参数配置', 'inventory', 'action'],
    // 生产与委外
    ['produce.order.view', '查看生产/委外单', 'produce', 'menu'],
    ['produce.order.edit', '编辑生产/委外单', 'produce', 'action'],
    ['produce.bom.view', '查看 BOM', 'produce', 'menu'],
    ['produce.bom.edit', '维护 BOM', 'produce', 'action'],
    ['produce.issue', '生产领料/委外发料', 'produce', 'action'],
    ['produce.receipt', '生产完工/委外收货', 'produce', 'action'],
    // 门店 POS
    ['pos.cashier', '门店收银', 'pos', 'action'],
    ['pos.shift', '开班/交接班', 'pos', 'action'],
    ['pos.dailyclose', '日结', 'pos', 'action'],
    ['pos.store.stock', '门店库存查询', 'pos', 'menu'],
    ['pos.store.requisition', '门店要货申请', 'pos', 'action'],
    ['pos.refund', '门店退货/退款', 'pos', 'action'],
    ['pos.offline', '离线收银', 'pos', 'action'],
    // 商城与 OMS
    ['oms.order.view', '查看线上订单', 'oms', 'menu'],
    ['oms.order.route', '订单路由与分仓', 'oms', 'action'],
    ['oms.order.ship', '订单发货', 'oms', 'action'],
    ['oms.promotion.edit', '维护促销', 'oms', 'action'],
    ['mall.member.view', '查看会员', 'mall', 'menu'],
    ['mall.member.edit', '维护会员', 'mall', 'action'],
    // 经销商
    ['dms.dealer.view', '查看经销商', 'dms', 'menu'],
    ['dms.dealer.edit', '维护经销商', 'dms', 'action'],
    ['dms.dealer.approve', '经销商准入审批', 'dms', 'action'],
    ['dms.policy.edit', '维护渠道价格与返利', 'dms', 'action'],
    // 订货中心（门店要货 = 订货，统一平台）
    ['order.place', '下单订货', 'order', 'action'],
    ['order.view', '查看订货单', 'order', 'menu'],
    ['order.confirm', '订单确认与发货', 'order', 'action'],
    ['order.statement.view', '查看对账单', 'order', 'menu'],
    // 财务
    ['finance.receivable.view', '查看应收', 'finance', 'menu'],
    ['finance.payable.view', '查看应付', 'finance', 'menu'],
    ['finance.settle.edit', '结算处理', 'finance', 'action'],
    ['finance.cost.view', '查看成本与毛利', 'finance', 'data'],
    // 审批
    ['approval.instance.view', '查看审批单', 'approval', 'menu'],
    ['approval.instance.act', '审批动作', 'approval', 'action'],
    ['approval.flow.edit', '维护审批流定义', 'approval', 'action'],
    // 系统
    ['system.user.view', '查看用户', 'system', 'menu'],
    ['system.user.edit', '维护用户与角色', 'system', 'action'],
    ['system.org.edit', '维护组织', 'system', 'action'],
    ['system.audit.view', '查看操作日志', 'system', 'menu'],
    ['system.mcp.manage', '管理 MCP Agent Token', 'system', 'action'],
    // AI
    ['ai.chat', '使用 AI 助手', 'ai', 'action'],
    ['ai.manifest.view', '查看能力清单', 'ai', 'menu']
  ]
  const insPerm = db.prepare(
    `INSERT OR IGNORE INTO permissions (code, name, module, category, sort_order) VALUES (?,?,?,?,?)`
  )
  perms.forEach((p, i) => insPerm.run(p[0], p[1], p[2], p[3], (i + 1) * 10))

  // ================= 7. 内置角色 =================
  // 与原 8 个扁平角色（admin/purchase/sales/warehouse/finance/dealer/store/viewer）一一对应，
  // 保证旧代码 users.role / requireRole() 继续可用。
  const roles = [
    ['admin', '系统管理员', '全部功能与全部数据', 'all', 10],
    ['boss', '老板/总经理', '全部数据只读 + 关键审批', 'all', 20],
    ['purchase', '采购员', '采购全流程', 'subtree', 30],
    ['sales', '销售员', '销售与客户', 'subtree', 40],
    ['warehouse', '仓管员', '库存与出入库', 'subtree', 50],
    ['finance', '财务', '应收应付与成本', 'all', 60],
    ['store', '店长', '本店收银/库存/要货', 'org', 70],
    ['dealer', '经销商', '本经销商订货与对账', 'dealer', 80],
    ['viewer', '访客', '只读演示', 'all', 90]
  ]
  const insRole = db.prepare(
    `INSERT OR IGNORE INTO roles (code, name, description, is_builtin, data_scope, sort_order) VALUES (?,?,?,1,?,?)`
  )
  roles.forEach((r) => insRole.run(r[0], r[1], r[2], r[3], r[4]))

  // 角色 → 权限映射
  const all = perms.map((p) => p[0])
  const byModule = (...mods) => all.filter((c) => mods.includes(c.split('.')[0]))
  const rolePerms = {
    admin: all,
    boss: [
      ...byModule('master', 'dms', 'finance', 'approval', 'system', 'ai'),
      'inventory.stock.view', 'inventory.cost.view', 'purchase.order.view', 'sales.order.view',
      'oms.order.view', 'order.view', 'order.statement.view'
    ],
    purchase: [
      ...byModule('purchase', 'produce'),
      'master.product.view', 'master.partner.view', 'master.price.view',
      'inventory.stock.view', 'inventory.stock.query', 'inventory.batch.view',
      'order.view', 'ai.chat'
    ],
    sales: [
      ...byModule('sales', 'dms', 'order'),
      'master.product.view', 'master.partner.view', 'master.price.view', 'mall.member.view',
      'inventory.stock.view', 'inventory.stock.query', 'finance.receivable.view', 'ai.chat'
    ],
    warehouse: [
      ...byModule('inventory', 'produce'),
      'purchase.inbound', 'sales.outbound', 'master.product.view',
      'purchase.order.view', 'sales.order.view', 'ai.chat'
    ],
    finance: [
      ...byModule('finance'),
      'purchase.order.view', 'sales.order.view', 'oms.order.view',
      'inventory.stock.view', 'inventory.cost.view', 'order.statement.view',
      'master.partner.view', 'ai.chat'
    ],
    store: [
      ...byModule('pos'),
      'inventory.stock.view', 'inventory.stock.query', 'inventory.batch.view',
      'mall.member.view', 'mall.member.edit', 'master.price.view', 'ai.chat'
    ],
    dealer: [
      'order.place', 'order.view', 'order.statement.view',
      'master.product.view', 'master.price.view', 'finance.receivable.view', 'ai.chat'
    ],
    viewer: [
      'master.product.view', 'master.partner.view', 'inventory.stock.view',
      'purchase.order.view', 'sales.order.view', 'oms.order.view', 'dms.dealer.view',
      'ai.manifest.view'
    ]
  }
  const insRP = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)')
  for (const [role, list] of Object.entries(rolePerms)) {
    for (const p of list) insRP.run(role, p)
  }

  // ================= 8. 存量用户回填 =================
  // 老库用户只有 role 字段，回填 user_roles；admin 标记为超级管理员
  db.exec(`
    INSERT OR IGNORE INTO user_roles (user_id, role_code)
    SELECT id, role FROM users WHERE role IS NOT NULL AND role <> ''
  `)
  db.exec(`UPDATE users SET is_super = 1 WHERE role = 'admin'`)
}

// 结构自检：既查表，也查本迁移给**既有表**加的列。
//
// 为什么必须查列（真实踩过）：
//   seed.js 的 resetDatabase() 会 DROP users / dealers / suppliers 这三张**基础表**
//   再按 schema.sql 重建。schema.sql 里没有 org_id 等列（它们由本迁移补），
//   而重建后 runMigrations 看到 schema_migrations 已记录 005、就直接跳过了 up()。
//   原 verify 只检查 roles/permissions/user_roles 等**本迁移新建的表**——
//   这些表不在 DROP 名单里，能活下来，于是 verify 通过、列却已经丢了。
//   结果：重灌演示数据后，org-seed 执行到 `UPDATE dealers SET org_id` 才报
//   "no such column: org_id"，而错误点离根因很远，极难定位。
//   把加过的列纳入自检后，重灌会自动触发 heal、补齐列。
module.exports.verify = function verify(db) {
  const tablesOk =
    tableExists(db, 'roles') &&
    tableExists(db, 'permissions') &&
    tableExists(db, 'role_permissions') &&
    tableExists(db, 'user_roles') &&
    tableExists(db, 'user_orgs') &&
    tableExists(db, 'org_brands')
  if (!tablesOk) return false

  // 本迁移在既有表上新增的列（漏一列就会让下游 SQL 报错）
  const columns = [
    ['users', 'org_id'], ['users', 'data_scope'], ['users', 'is_super'],
    ['suppliers', 'org_id'],
    ['dealers', 'org_id'], ['dealers', 'parent_dealer_id'], ['dealers', 'region'],
    ['dealers', 'level'], ['dealers', 'credit_limit'], ['dealers', 'credit_days']
  ]
  for (const [table, col] of columns) {
    if (!hasColumn(db, table, col)) return false
  }

  return (
    db.prepare('SELECT COUNT(*) c FROM permissions').get().c > 50 &&
    db.prepare('SELECT COUNT(*) c FROM roles').get().c >= 8
  )
}
