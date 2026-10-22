'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/014_approval.cjs ｜ 迁移：通用审批流：模板 / 级次 / 实例 / 记录
 * ============================================================================
 * 【职责】迁移：通用审批流：模板 / 级次 / 实例 / 记录
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 014 通用审批流：模板 + 级次 + 实例 + 审批记录
//
// 为什么单据内核（008）里已经预留了 `doc_actions.require_approval`，还要单独一个模块：
//   那条列只能表达「这个动作要不要审」，表达不了「审几级、谁来审」。
//   金额 5 万的采购订单和 50 万的，显然不该走同一个审批人 —— 这需要**模板 + 级次**。
//
// 核心设计：**审批与单据状态解耦**（框架文档 P0 的明确要求）。
//   审批实例有自己的一套状态（pending/approved/rejected/canceled），存在自己的表里，
//   不进 `doc_events`。单据状态机该是什么还是什么 —— 审批只是**流转前的一道闸门**：
//     ① 单据执行某个 `require_approval=1` 的动作时，闸门拦下，创建审批实例，状态不变；
//     ② 审批人逐级通过后，闸门放行，业务动作才真正发生（由业务侧调 applyTransition）。
//   这样做的收益：换审批流不动状态机，改状态机不动审批流；两者可以独立演进。
//   代价：单据在「等审批」期间状态是**没变**的 —— 所以审批状态必须能被单独查到，
//   否则用户会以为「点了没反应」。审批中心（前端）就是为这个代价买的单。
//
// 为什么模板默认 **停用**：
//   审批是唯一会**卡住别人工作流**的动作。默认开启等于把所有既有链路一次性堵死
//   （测试、演示脚本、日常操作全都要先去审批）。所以定义先建好、默认关，
//   由管理者显式打开 —— 与待办推送（013）同一个取舍。
//   例外：`PO` 的「取消」边默认开启审批 —— 取消一张已提交的采购订单本就应该有人复核，
//   且这条路径不在任何自动化回归的主链路上，不会阻塞既有流程。

const { tableExists, hasColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '通用审批流：模板 / 级次 / 实例 / 记录'

const TABLES = [
  `CREATE TABLE IF NOT EXISTS approval_templates (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     code         TEXT NOT NULL UNIQUE,                 -- 模板编码
     name         TEXT NOT NULL,                        -- 模板名称
     doc_type     TEXT NOT NULL,                        -- 适用单据类型（doc_types.code）
     action       TEXT NOT NULL,                        -- 适用动作码（doc_actions.action）
     min_amount   REAL NOT NULL DEFAULT 0,              -- 金额下限（含）
     max_amount   REAL,                                 -- 金额上限（不含）；空 = 不限
     priority     INTEGER NOT NULL DEFAULT 0,           -- 同 doc_type+action 多模板时，值大者优先
     enabled      INTEGER NOT NULL DEFAULT 0,           -- 是否启用（**默认关**）
     remark       TEXT,
     created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
     updated_at   TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS approval_steps (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     template_id    INTEGER NOT NULL REFERENCES approval_templates(id) ON DELETE CASCADE,
     step_no        INTEGER NOT NULL,                   -- 级次，从 1 开始
     step_name      TEXT NOT NULL,                      -- 级次名称（如「采购主管审核」）
     approver_type  TEXT NOT NULL DEFAULT 'role',       -- role / user / perm
     approver_value TEXT NOT NULL,                      -- 角色码 / 用户ID / 权限点
     remark         TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS approval_instances (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     template_id      INTEGER REFERENCES approval_templates(id) ON DELETE SET NULL,
     template_code    TEXT,
     doc_type         TEXT NOT NULL,
     doc_id           INTEGER NOT NULL,
     doc_no           TEXT,
     action           TEXT NOT NULL,
     action_name      TEXT,
     amount           REAL NOT NULL DEFAULT 0,
     total_steps      INTEGER NOT NULL DEFAULT 1,
     current_step     INTEGER NOT NULL DEFAULT 1,
     status           TEXT NOT NULL DEFAULT 'pending',  -- pending / approved / rejected / canceled
     current_approver TEXT,                             -- 当前级审批人描述（冗余，列表直出）
     submitted_by_id  INTEGER,
     submitted_by     TEXT,
     submitted_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
     decided_at       TEXT,
     remark           TEXT,
     created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
     updated_at       TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS approval_records (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     instance_id   INTEGER NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
     step_no       INTEGER NOT NULL DEFAULT 0,          -- 0 = 系统动作（提交/撤回）
     step_name     TEXT,
     decision      TEXT NOT NULL,                       -- approve / reject / cancel / submit
     approver_id   INTEGER,
     approver_name TEXT,
     comment       TEXT,
     decided_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
   )`
]

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_apv_tpl_match ON approval_templates (doc_type, action, enabled)`,
  `CREATE INDEX IF NOT EXISTS idx_apv_steps_tpl ON approval_steps (template_id, step_no)`,
  `CREATE INDEX IF NOT EXISTS idx_apv_inst_doc ON approval_instances (doc_type, doc_id, action, status)`,
  `CREATE INDEX IF NOT EXISTS idx_apv_inst_status ON approval_instances (status, current_step)`,
  `CREATE INDEX IF NOT EXISTS idx_apv_rec_inst ON approval_records (instance_id, step_no)`
]

// 权限点：能看审批 ≠ 能审批 ≠ 能改审批流。
// 三者中最危险的是「改审批流」—— 把审批人改成自己，等于把所有审批都变成走过场。
const PERMS = [
  ['system:approval:view', '查看审批中心', 'system', 'read', 4100],
  ['system:approval:decide', '审批单据', 'system', 'write', 4110],
  ['system:approval:manage', '维护审批模板', 'system', 'write', 4120]
]

const ROLE_GRANTS = {
  admin: ['system:approval:view', 'system:approval:decide', 'system:approval:manage'],
  purchase: ['system:approval:view', 'system:approval:decide'],
  finance: ['system:approval:view', 'system:approval:decide'],
  warehouse: ['system:approval:view'],
  sales: ['system:approval:view'],
  dealer: ['system:approval:view'],
  store: ['system:approval:view'],
  viewer: ['system:approval:view']
}

// 哪些边「可以」走审批 —— 把 `doc_actions.require_approval` 打开。
// 注意：**标记 ≠ 生效**。真正拦不拦由「有没有启用中的模板」决定（matchTemplate）。
// 所以这里可以放心把重要动作都标上：没有模板时闸门返回 null，行为与从前一模一样。
// 反过来，只标记不建模板等于没做 —— 但那是配置问题，不是代码问题，界面上能配。
const GATED_EDGES = [
  ['PO', 'cancel'],   // 取消采购订单：默认就有模板且启用（见下）
  ['PO', 'approve'],  // 订单审批：大额分级模板默认停用
  ['PRQ', 'approve'], // 请购审批
  ['PI', 'void'],     // 采购发票作废：账务影响大
  ['PI', 'post'],     // 采购发票入账
  ['PST', 'void'],    // 结算单作废
  ['PST', 'audit'],   // 结算单审核
  ['PAY', 'void']     // 付款单作废
]

// 模板定义（结构性数据，随迁移灌入；定义指纹守护）
const TEMPLATES = [
  {
    code: 'APV-PO-CANCEL',
    name: '采购订单取消审批',
    doc_type: 'PO',
    action: 'cancel',
    min_amount: 0,
    max_amount: null,
    priority: 10,
    enabled: 1,
    remark: '取消采购订单需采购主管复核 —— 已提交/已审批的订单取消会影响下游到货与结算',
    steps: [{ step_no: 1, step_name: '采购主管复核', approver_type: 'role', approver_value: 'purchase' }]
  },
  {
    code: 'APV-PO-APPROVE-BIG',
    name: '大额采购订单二级审批',
    doc_type: 'PO',
    action: 'approve',
    min_amount: 300000,
    max_amount: null,
    priority: 20,
    enabled: 0,
    remark: '金额 ≥ 30 万的采购订单需二级审批（默认停用；启用后大额订单审批会自动走两级）',
    steps: [
      { step_no: 1, step_name: '采购主管初审', approver_type: 'role', approver_value: 'purchase' },
      { step_no: 2, step_name: '财务复核', approver_type: 'role', approver_value: 'finance' }
    ]
  },
  {
    code: 'APV-PO-APPROVE-NORMAL',
    name: '采购订单审批（常规）',
    doc_type: 'PO',
    action: 'approve',
    min_amount: 0,
    max_amount: 300000,
    priority: 10,
    enabled: 0,
    remark: '金额 < 30 万的一级审批（默认停用）',
    steps: [{ step_no: 1, step_name: '采购主管审批', approver_type: 'role', approver_value: 'purchase' }]
  },
  {
    code: 'APV-PI-VOID',
    name: '采购发票作废审批',
    doc_type: 'PI',
    action: 'void',
    min_amount: 0,
    max_amount: null,
    priority: 10,
    enabled: 0,
    remark: '发票作废影响已入账金额与暂估差异，默认停用；启用后作废需财务复核',
    steps: [{ step_no: 1, step_name: '财务复核', approver_type: 'role', approver_value: 'finance' }]
  },
  {
    code: 'APV-PAY-VOID',
    name: '付款单作废审批',
    doc_type: 'PAY',
    action: 'void',
    min_amount: 0,
    max_amount: null,
    priority: 10,
    enabled: 0,
    remark: '作废付款单会让结算单已付金额回退，默认停用；启用后需财务复核',
    steps: [{ step_no: 1, step_name: '财务复核', approver_type: 'role', approver_value: 'finance' }]
  }
]

module.exports.up = function up(db) {
  for (const sql of TABLES) db.exec(sql)
  for (const sql of INDEXES) db.exec(sql)

  if (tableExists(db, 'permissions')) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    )
    for (const [code, name, module, category, sortOrder] of PERMS) upPerm.run(code, name, module, category, sortOrder)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        const exists = db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)
        if (!exists) continue
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  // 模板与级次：幂等 UPSERT。**不覆盖 enabled** —— 管理者在界面上打开过之后，
  // 重跑迁移（自愈）不能把它又关回去。
  const upTpl = db.prepare(
    `INSERT INTO approval_templates (code,name,doc_type,action,min_amount,max_amount,priority,enabled,remark)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET
       name=excluded.name, doc_type=excluded.doc_type, action=excluded.action,
       min_amount=excluded.min_amount, max_amount=excluded.max_amount,
       priority=excluded.priority, remark=excluded.remark`
  )
  const getTpl = db.prepare('SELECT id FROM approval_templates WHERE code=?')
  const delSteps = db.prepare('DELETE FROM approval_steps WHERE template_id=?')
  const insStep = db.prepare(
    `INSERT INTO approval_steps (template_id,step_no,step_name,approver_type,approver_value,remark)
     VALUES (?,?,?,?,?,?)`
  )

  for (const t of TEMPLATES) {
    upTpl.run(t.code, t.name, t.doc_type, t.action, t.min_amount, t.max_amount ?? null, t.priority, t.enabled, t.remark || null)
    const row = getTpl.get(t.code)
    // 级次整体重建：改级次（加一级/换审批人）时不留旧行
    delSteps.run(row.id)
    for (const s of t.steps) insStep.run(row.id, s.step_no, s.step_name, s.approver_type, s.approver_value, null)
  }

  // 把重要动作的边标记为「可审批」—— 闸门只看这个 flag，拦不拦看模板
  if (tableExists(db, 'doc_actions')) {
    const mark = db.prepare(`UPDATE doc_actions SET require_approval=1 WHERE doc_type=? AND action=?`)
    for (const [dt, ac] of GATED_EDGES) mark.run(dt, ac)
  }

  stampDef(db, '014_approval', {
    tables: TABLES, indexes: INDEXES, perms: PERMS, roles: ROLE_GRANTS, templates: TEMPLATES, gated: GATED_EDGES
  })
  return { tables: TABLES.length, indexes: INDEXES.length, perms: PERMS.length, templates: TEMPLATES.length, gated: GATED_EDGES.length }
}

module.exports.verify = function verify(db) {
  for (const t of ['approval_templates', 'approval_steps', 'approval_instances', 'approval_records']) {
    if (!tableExists(db, t)) return false
  }
  for (const sql of INDEXES) {
    const m = /CREATE INDEX IF NOT EXISTS (\w+)/.exec(sql)
    if (m && !hasIndex(db, m[1])) return false
  }
  for (const col of ['current_step', 'current_approver', 'submitted_by']) {
    if (!hasColumn(db, 'approval_instances', col)) return false
  }
  // 模板齐不齐、级次对不对
  if (tableExists(db, 'approval_templates') && tableExists(db, 'approval_steps')) {
    for (const t of TEMPLATES) {
      const row = db.prepare('SELECT id FROM approval_templates WHERE code=?').get(t.code)
      if (!row) return false
      const n = db.prepare('SELECT COUNT(*) c FROM approval_steps WHERE template_id=?').get(row.id).c
      if (n !== t.steps.length) return false
    }
  }
  // 该标记的边一个都不能少（漏标 = 闸门形同虚设，且不会报错、只会「功能莫名不生效」）
  if (tableExists(db, 'doc_actions')) {
    for (const [dt, ac] of GATED_EDGES) {
      const hit = db
        .prepare(`SELECT COUNT(*) c FROM doc_actions WHERE doc_type=? AND action=? AND require_approval=1`)
        .get(dt, ac).c
      if (!hit) return false
    }
  }
  if (defStale(db, '014_approval', {
    tables: TABLES, indexes: INDEXES, perms: PERMS, roles: ROLE_GRANTS, templates: TEMPLATES, gated: GATED_EDGES
  })) return false
  return true
}
