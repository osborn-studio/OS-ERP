'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/040_im_sync.cjs ｜ 迁移：钉钉/飞书 组织与审批同步（映射表 · 同步流水 · 冲突台账）
 * ============================================================================
 * 【职责】迁移：钉钉/飞书 组织与审批同步（映射表 · 同步流水 · 冲突台账）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 040 钉钉 / 飞书 组织与审批同步（映射表 + 同步流水 + 冲突台账）
//
// ===========================================================================
// 一、这一批解决的是「两边各有一份组织，但没人知道谁对应谁」
// ===========================================================================
// 在批次 S 之前，本项目对外只有**一条**通道：`lib/notify.js` 的机器人 webhook
// （钉钉 / 飞书 / 企业微信 / 通用），而且只发**待办摘要**一种消息。
// 也就是说：钉钉和飞书在这套系统里的角色，是"一个消息出口"，不是"一个身份来源"。
//
// 于是有三件事做不了：
//   ① 在钉钉里换了部门 / 离职了人，系统里没人知道 —— `users` 里还是旧组织；
//   ② 审批发生在钉钉，本地 `approval_instances` 永远停在 `pending`；
//   ③ 想回答"这个人是谁"，只能靠姓名，而姓名会重。
//
// 这一批把"映射"这件事做成**可查、可重放、有留痕**的数据结构 ——
// 同步本身能不能连上真实租户，是另一件事（见第四节的边界）。
//
// ===========================================================================
// 二、为什么是「映射表」而不是「往 users 里加个 dingtalk_id 列」
// ===========================================================================
// 因为**一个人可能在多个平台上都有账号**（钉钉 + 飞书 + 将来还有企业微信），
// 而 `users` 只有一行。加一列意味着加一个平台就改一次基础表结构，
// 而且第二列几乎永远是空的（"你钉钉 id 是多少"这个问题对飞书用户没有意义）。
//
// 映射表把"外部身份"做成**多行**：`im_user_map` 的每一行是"某个平台上某个人 = 本地哪个用户"。
// 同族：`im_dept_map`（外部部门 → 本地组织）、`im_approval_map`（外部审批单 → 本地审批实例）。
//
// 三张表都带 `sync_batch`，且 `UNIQUE(platform, external_id)` —— 后者是**幂等的地基**：
// 同一个外部实体同步一百次，也只会有一行（upsert 而不是 insert）。
//
// ===========================================================================
// 三、`im_sync_runs` 只追加，`im_sync_conflicts` 也只追加
// ===========================================================================
// 与 `period_audit_log` / `setting_audit_log` / `report_config_audit_log` 同一族：
// 本表**没有 UPDATE / DELETE 路径**，代码层面只有一处 INSERT（`lib/im-sync.js`）。
// 区别在于它记的不是"配置改了"，而是"**这一次同步做了什么**"：
//   拉了多少条 / 新建几个 / 更新几个 / 跳过几个 / 冲突几条 / 游标从哪到哪。
//
// 冲突**单独一张表**而不是塞进 run 的 JSON 列：冲突是"要人去处理"的东西，
// 需要按 `reason_code` 筛选与统计（"这个月有多少条对不上"）；
// 塞进 JSON 之后，任何统计都得先把 JSON 解开 —— 那不是查询，那是脚本。
//
// ===========================================================================
// 四、凭据**不落库**（这是"不依赖真实租户也能做"的关键）
// ===========================================================================
// `im_platform_cfg` 只存 `secret_ref`（**环境变量名**），不存密钥本身。
// 理由：密钥落库之后，"谁能看这张表"就变成了"谁能拿密钥"，
// 而 SQLite 文件在开发机上人人可读。同一条理由见 `013_notify.cjs` 的注释。
//
// 于是"没有真实租户"这件事的边界很清楚：
//   · 组织映射、审批映射、同步流水、冲突判定、幂等、重放 —— **全部可做、可测、可自证**；
//   · 真实 HTTP 调用 —— 没有凭据就**明确拒绝**（`IM_NOT_CONFIGURED`，一句人话），
//     而**不静默返回空快照**。静默返回空快照的后果是：同步"成功"了，
//     但 `missing` 判定会把**全公司的人标记为已离职** —— 这是最坏的一种失败（破坏性且看起来正常）。
//
// ===========================================================================
// 五、权限点
// ===========================================================================
// 与 `013_notify.cjs` 同构：`system.im.view`（看映射与流水）/ `system.im.sync`（发起同步）。
// 查看与发起分开，因为**发起同步会改组织与审批状态**，而"能看"不等于"能动"。

const { tableExists, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '钉钉/飞书 组织与审批同步（映射表 · 同步流水 · 冲突台账）'

const TABLES = [
  // -------------------------------------------------------------------------
  // 平台接入配置。**不放密钥**，只放"密钥的环境变量名"。
  // -------------------------------------------------------------------------
  {
    name: 'im_platform_cfg',
    sql: `CREATE TABLE IF NOT EXISTS im_platform_cfg (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      platform      TEXT NOT NULL UNIQUE,        -- dingtalk / feishu
      label         TEXT NOT NULL,               -- 中文名（当时措辞，落库冻结）
      corp_id       TEXT,                         -- 企业 id（钉钉 corpId / 飞书 tenant_key）
      app_key       TEXT,                         -- appKey / app_id（非密钥，可落库）
      secret_ref    TEXT,                         -- **环境变量名**，不是密钥本身
      agent_id      TEXT,                         -- 钉钉微应用 agentId / 飞书 app 无此项
      base_url      TEXT,                         -- 接口基址（自建网关/沙箱可覆盖）
      enabled       INTEGER NOT NULL DEFAULT 0,   -- 默认停用：没配凭据就不该"看起来在同步"
      last_sync_at  TEXT,
      remark        TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`
  },
  // -------------------------------------------------------------------------
  // 外部部门 → 本地组织。**多行**（一个平台一行），不是往 orgs 上加列。
  // `org_id` 允许为空：外部部门拉回来了、但还没决定挂到哪个本地主体上，
  // 这种情况必须**能表达**（否则只能要么不落库、要么瞎猜一个 org）。
  // -------------------------------------------------------------------------
  {
    name: 'im_dept_map',
    sql: `CREATE TABLE IF NOT EXISTS im_dept_map (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      platform            TEXT NOT NULL,
      external_dept_id    TEXT NOT NULL,
      external_parent_id  TEXT,                   -- 外部父部门（用来还原树）
      external_name       TEXT,
      org_id              INTEGER,                -- 本地组织；NULL = 已拉回但未挂接
      status              TEXT NOT NULL DEFAULT 'active',  -- active / missing（外部已删）
      sync_batch          TEXT,                   -- 这一行是哪个批次写下的
      synced_at           TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE (platform, external_dept_id)
    )`
  },
  // -------------------------------------------------------------------------
  // 外部成员 → 本地用户。`gml_user_id` 允许为空（同上：拉回来了但还没开户）。
  // `mobile` 落库是为了**排重**（同名不同人），不是为了联系 —— 它有唯一性吗？没有。
  // -------------------------------------------------------------------------
  {
    name: 'im_user_map',
    sql: `CREATE TABLE IF NOT EXISTS im_user_map (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      platform            TEXT NOT NULL,
      external_user_id    TEXT NOT NULL,
      union_id            TEXT,                   -- 跨应用唯一 id（钉钉 unionId / 飞书 union_id）
      external_name       TEXT,
      mobile              TEXT,
      external_dept_id    TEXT,
      gml_user_id         INTEGER,                -- 本地用户；NULL = 已拉回但未开户
      status              TEXT NOT NULL DEFAULT 'active',  -- active / missing
      sync_batch          TEXT,
      synced_at           TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE (platform, external_user_id)
    )`
  },
  // -------------------------------------------------------------------------
  // 外部审批单 → 本地审批实例。唯一的"审批同步"落点。
  // `local_status` 冗余落库：外部状态名与本地状态名**不是一套词**，
  // 事后要能回答"当时我们把它读成了什么"，而不是每次重新翻译一遍。
  // -------------------------------------------------------------------------
  {
    name: 'im_approval_map',
    sql: `CREATE TABLE IF NOT EXISTS im_approval_map (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      platform              TEXT NOT NULL,
      external_instance_id  TEXT NOT NULL,
      external_process_code TEXT,                 -- 外部审批模板码
      external_status       TEXT,                 -- 外部原始状态（原文落库，不翻译）
      local_status          TEXT,                 -- 我们把它读成了什么
      approval_id           INTEGER,              -- 本地 approval_instances.id
      doc_type              TEXT,
      doc_no                TEXT,
      sync_batch            TEXT,
      synced_at             TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE (platform, external_instance_id)
    )`
  },
  // -------------------------------------------------------------------------
  // 同步流水：**只追加**。一次同步一行，失败也留一行（失败更该留）。
  // -------------------------------------------------------------------------
  {
    name: 'im_sync_runs',
    sql: `CREATE TABLE IF NOT EXISTS im_sync_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      platform      TEXT NOT NULL,
      kind          TEXT NOT NULL,                -- org / approval
      trigger_by    TEXT NOT NULL,                -- web / mcp / script / system
      status        TEXT NOT NULL,                -- ok / partial / failed / not_configured
      cursor_before TEXT,
      cursor_after  TEXT,
      pulled        INTEGER NOT NULL DEFAULT 0,
      created       INTEGER NOT NULL DEFAULT 0,
      updated       INTEGER NOT NULL DEFAULT 0,
      skipped       INTEGER NOT NULL DEFAULT 0,
      conflicts     INTEGER NOT NULL DEFAULT 0,
      error_code    TEXT,
      error_message TEXT,
      actor_id      INTEGER,
      actor_name    TEXT,
      detail        TEXT,                         -- JSON（人读与排障；判据不读它）
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`
  },
  // -------------------------------------------------------------------------
  // 冲突台账：**只追加**。`reason_code` 是封闭字典（lib/im-sync.js 的 CONFLICT_CODES）。
  // -------------------------------------------------------------------------
  {
    name: 'im_sync_conflicts',
    sql: `CREATE TABLE IF NOT EXISTS im_sync_conflicts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        INTEGER,                      -- 哪一次同步发现的（不做外键：留痕不随父级消失）
      platform      TEXT NOT NULL,
      kind          TEXT NOT NULL,
      reason_code   TEXT NOT NULL,                -- 封闭字典，见 lib/im-sync.js
      external_id   TEXT,
      local_id      INTEGER,
      message       TEXT NOT NULL,                -- 一句人话：出了什么事、该怎么办
      payload       TEXT,                         -- JSON 快照（当时的原始数据）
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`
  }
]

const INDEXES = [
  { name: 'idx_im_dept_map_platform', sql: 'CREATE INDEX IF NOT EXISTS idx_im_dept_map_platform ON im_dept_map (platform, status)' },
  { name: 'idx_im_dept_map_org', sql: 'CREATE INDEX IF NOT EXISTS idx_im_dept_map_org ON im_dept_map (org_id)' },
  { name: 'idx_im_user_map_platform', sql: 'CREATE INDEX IF NOT EXISTS idx_im_user_map_platform ON im_user_map (platform, status)' },
  { name: 'idx_im_user_map_user', sql: 'CREATE INDEX IF NOT EXISTS idx_im_user_map_user ON im_user_map (gml_user_id)' },
  { name: 'idx_im_user_map_mobile', sql: 'CREATE INDEX IF NOT EXISTS idx_im_user_map_mobile ON im_user_map (mobile)' },
  { name: 'idx_im_approval_map_local', sql: 'CREATE INDEX IF NOT EXISTS idx_im_approval_map_local ON im_approval_map (approval_id)' },
  { name: 'idx_im_approval_map_status', sql: 'CREATE INDEX IF NOT EXISTS idx_im_approval_map_status ON im_approval_map (platform, local_status)' },
  { name: 'idx_im_sync_runs_time', sql: 'CREATE INDEX IF NOT EXISTS idx_im_sync_runs_time ON im_sync_runs (created_at)' },
  { name: 'idx_im_sync_runs_platform', sql: 'CREATE INDEX IF NOT EXISTS idx_im_sync_runs_platform ON im_sync_runs (platform, kind, status)' },
  { name: 'idx_im_sync_conflicts_run', sql: 'CREATE INDEX IF NOT EXISTS idx_im_sync_conflicts_run ON im_sync_conflicts (run_id)' },
  { name: 'idx_im_sync_conflicts_code', sql: 'CREATE INDEX IF NOT EXISTS idx_im_sync_conflicts_code ON im_sync_conflicts (reason_code)' }
]

const PERMS = [
  ['system.im.view', '查看 IM 组织与审批同步', 'system', 'menu', 4130],
  ['system.im.sync', '发起 IM 组织与审批同步', 'system', 'action', 4140]
]
// 授予范围与 `system.mcp.confirm` / `system.approval:manage` 同一条口径：
// 管理员与各业务主管可发起；**刻意不给 viewer / dealer / store** ——
// 发起同步会改组织与审批状态，外部主体与只读访客都不该动它。
const ROLE_GRANTS = {
  'system.im.view': ['admin', 'boss', 'purchase', 'sales', 'warehouse', 'finance'],
  'system.im.sync': ['admin', 'boss']
}

module.exports.up = function up(db) {
  if (!tableExists(db, 'orgs') || !tableExists(db, 'users') || !tableExists(db, 'approval_instances')) {
    throw new Error('基础表不存在，迁移顺序有误（orgs / users / approval_instances 应先在 001 / schema.sql / 014 里创建）')
  }
  for (const t of TABLES) db.exec(t.sql)
  for (const ix of INDEXES) db.exec(ix.sql)

  for (const [code, name, module, category, sort] of PERMS) {
    db.prepare('INSERT OR IGNORE INTO permissions (code, name, module, category, sort_order) VALUES (?,?,?,?,?)').run(
      code, name, module, category, sort
    )
  }
  for (const [perm, roles] of Object.entries(ROLE_GRANTS)) {
    for (const role of roles) {
      db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, perm_code) VALUES (?,?)').run(role, perm)
    }
  }
  // 两个平台各插一行**默认停用**的配置。为什么要有：让"这个平台接没接"是一个**可查的事实**，
  // 而不是靠"表里有没有这一行"猜。没有凭据就不该显示成"在同步"。
  for (const [platform, label] of [['dingtalk', '钉钉'], ['feishu', '飞书']]) {
    db.prepare(
      `INSERT OR IGNORE INTO im_platform_cfg (platform, label, secret_ref, enabled, remark)
       VALUES (?,?,?,0,?)`
    ).run(platform, label, `${platform.toUpperCase()}_APP_SECRET`, '默认停用：填入凭据的环境变量名并启用后才会真正发起同步')
  }

  const def = {
    tables: TABLES.map((t) => t.name),
    indexes: INDEXES.map((x) => x.name),
    perms: PERMS.map((p) => p[0])
    // 冲突码字典**刻意不放这里**（迁移是 CommonJS、定义是 ESM，抄一份就是第二个定义），
    // 它由运行时探针 `IM_CONFLICT_CODE_UNKNOWN` 守着 —— 与 038 把动作清单交给运行时探针同一条理由。
  }
  stampDef(db, '040_im_sync', def)
  return { tables: TABLES.length, indexes: INDEXES.length, perms: PERMS.length }
}

module.exports.verify = function verify(db) {
  for (const t of TABLES) if (!tableExists(db, t.name)) return false
  for (const ix of INDEXES) if (!hasIndex(db, ix.name)) return false

  // 结构不变量：状态取值域。写进一个 'ok2' 不会报错，但"这个实体在外部还在不在"从此没有确定答案。
  const badDept = db.prepare("SELECT COUNT(*) c FROM im_dept_map WHERE status NOT IN ('active','missing')").get().c
  if (badDept > 0) return false
  const badUser = db.prepare("SELECT COUNT(*) c FROM im_user_map WHERE status NOT IN ('active','missing')").get().c
  if (badUser > 0) return false
  const badRun = db
    .prepare("SELECT COUNT(*) c FROM im_sync_runs WHERE status NOT IN ('ok','partial','failed','not_configured')")
    .get().c
  if (badRun > 0) return false
  const badKind = db.prepare("SELECT COUNT(*) c FROM im_sync_runs WHERE kind NOT IN ('org','approval')").get().c
  if (badKind > 0) return false

  // 结构不变量：**同步流水不能有"没结束的"**。
  // `finished_at` 为空意味着进程在同步中途死了 —— 这件事**必须可见**，
  // 否则下一次同步会以为上一次干净地结束了（游标已推进、集合其实没拉全）。
  const unfinished = db.prepare('SELECT COUNT(*) c FROM im_sync_runs WHERE finished_at IS NULL').get().c
  if (unfinished > 0) return false

  // 结构不变量：冲突必须带"一句人话"。只有 code 的冲突，排障的人得去读代码才知道发生了什么。
  const bareConflict = db.prepare("SELECT COUNT(*) c FROM im_sync_conflicts WHERE message IS NULL OR message=''").get().c
  if (bareConflict > 0) return false

  const def = {
    tables: TABLES.map((t) => t.name),
    indexes: INDEXES.map((x) => x.name),
    perms: PERMS.map((p) => p[0])
  }
  if (defStale(db, '040_im_sync', def)) return false
  return true
}
