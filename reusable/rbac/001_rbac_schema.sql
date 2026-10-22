-- =====================================================================
-- GML 组织与权限 · 行级数据规则 表结构（模块 05）
-- 来源：四维模型（组织-岗位-功能-数据）与「策略五元组 sub,dom,obj,act,eft」
--       抄 casbin（Apache-2.0，_ref/node-casbin）的 rbac_with_domains 设计；
--       **但不引入 casbin 依赖**，改为自研 SQLite 实现，理由见 rbac.js 头部。
-- 关键安全决策：策略里的行级条件**不使用 eval 求值**（casbin 的 eval(p.sub_rule)
--       是 RCE 面），改用受限表达式解析 + 编译成 SQL WHERE 片段。
-- =====================================================================

-- 角色
CREATE TABLE IF NOT EXISTS rbac_roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  org_id      INTEGER,                        -- 归属组织（dom 维度之一）
  parent_id   INTEGER REFERENCES rbac_roles(id),  -- 角色继承（对应 casbin g 的层级）
  enabled     INTEGER NOT NULL DEFAULT 1
);

-- 用户-角色（casbin 的 g 行：g, alice, admin, domain1）
CREATE TABLE IF NOT EXISTS rbac_user_roles (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL,
  role_code TEXT NOT NULL,
  dom       TEXT NOT NULL DEFAULT '*',       -- '*'=全组织；否则为组织/仓库编码
  UNIQUE(user_id, role_code, dom)
);
CREATE INDEX IF NOT EXISTS idx_rbac_user_roles ON rbac_user_roles(user_id);

-- 策略：RBAC 授权 + 行级数据规则，两张表分开，语义清晰
CREATE TABLE IF NOT EXISTS rbac_policies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  role_code   TEXT NOT NULL,                 -- 主体（角色）
  dom         TEXT NOT NULL DEFAULT '*',     -- 域：组织 / 仓库
  resource    TEXT NOT NULL,                 -- 资源：如 'sales_order' / 'inventory.stock'
  action      TEXT NOT NULL,                 -- 动作：read / create / approve / '*'
  eft         TEXT NOT NULL DEFAULT 'allow', -- allow / deny（deny 优先，对应 casbin p2+eft）
  priority    INTEGER NOT NULL DEFAULT 100,
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_rbac_policies_match ON rbac_policies(role_code, dom, resource, action);

-- 行级数据规则：附在策略上，限定能看见哪些行
CREATE TABLE IF NOT EXISTS rbac_row_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id   INTEGER NOT NULL REFERENCES rbac_policies(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,                 -- 单据字段，如 warehouse_id / owner_id / org_id
  operator    TEXT NOT NULL,                 -- eq/ne/in/not_in/gt/gte/lt/lte
  value       TEXT NOT NULL,                 -- 多值用逗号分隔；支持 :user_id / :org_id 占位
  logic       TEXT NOT NULL DEFAULT 'and'    -- 与同策略其它规则的组合（当前版本全部 AND）
);
CREATE INDEX IF NOT EXISTS idx_rbac_row_rules ON rbac_row_rules(policy_id);

-- 审计留痕（对应 casbin enforceEx 返回命中规则原文的能力）
CREATE TABLE IF NOT EXISTS rbac_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  resource    TEXT NOT NULL,
  action      TEXT NOT NULL,
  dom         TEXT,
  allowed     INTEGER NOT NULL,
  hit_policy  TEXT,                          -- 命中的策略原文，便于复盘
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_rbac_audit ON rbac_audit(user_id, created_at);
