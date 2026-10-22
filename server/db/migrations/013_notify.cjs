'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/013_notify.cjs ｜ 迁移：待办推送：通知渠道 + 推送日志
 * ============================================================================
 * 【职责】迁移：待办推送：通知渠道 + 推送日志
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 013 待办推送：通知渠道 + 推送日志
//
// 为什么需要这张表：
//   采购九环节都在系统里跑，但「该谁做什么」目前只能靠人登录进来看。
//   要把它推出去（飞书 / 钉钉 / 企业微信机器人），就需要两样东西：
//     ① 渠道：推到哪 —— webhook 地址 + 密钥，按渠道类型决定消息体格式；
//     ② 日志：推没推成功 —— 推送是**外部调用**，会失败（限流、密钥过期、网络抖动），
//        没有留痕就会出现「我说推了，你说没收到」这种无法对证的情况。
//
// 设计取舍：
//   - 渠道表**不存明文密钥**的字段名就一个 `secret`，演示系统里填的是占位值；
//     真实密钥应当走环境变量或密钥管理，这里只留结构位并显式说明（不做假的加密）。
//   - 一个渠道可订阅多个事件类型（`event_types`），用逗号分隔的 kind 列表；
//     空表示订阅全部 —— 「不选」比「全选」更常见的语义是「都要」。
//   - 日志表独立于渠道表，渠道删了日志仍在（外键设 SET NULL），因为日志是审计凭证。

const { tableExists, hasColumn, addColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '待办推送：通知渠道 + 推送日志'

const TABLES = [
  `CREATE TABLE IF NOT EXISTS notify_channels (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     code          TEXT NOT NULL UNIQUE,               -- 渠道编码（唯一）
     name          TEXT NOT NULL,                      -- 渠道名称
     provider      TEXT NOT NULL DEFAULT 'generic',    -- feishu / dingtalk / wecom / generic
     webhook_url   TEXT,                               -- 机器人 webhook
     secret        TEXT,                               -- 签名密钥（演示存占位；生产走密钥管理）
     event_types   TEXT,                               -- 订阅的事件 kind，逗号分隔；空 = 全部
     enabled       INTEGER NOT NULL DEFAULT 1,         -- 是否启用
     remark        TEXT,
     last_push_at  TEXT,
     last_status   TEXT,
     created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
     updated_at    TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS notify_logs (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     channel_id    INTEGER REFERENCES notify_channels(id) ON DELETE SET NULL,
     channel_code  TEXT,
     provider      TEXT,
     event_kind    TEXT,                               -- 触发的事件类型（digest / 单条待办）
     title         TEXT,
     payload       TEXT,                               -- 实际发出的消息体（截断存储）
     item_count    INTEGER NOT NULL DEFAULT 0,
     status        TEXT NOT NULL DEFAULT 'pending',    -- success / fail
     http_status   INTEGER,
     error         TEXT,
     triggered_by  TEXT,
     created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
   )`
]

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_notify_logs_created ON notify_logs (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_notify_logs_channel ON notify_logs (channel_id, status)`
]

// 权限点：推送是「对外的动作」，与查询渠道分开授权 ——
// 能看渠道配置的人不一定该有权把消息推到全公司群里。
// 列序必须与 permissions 表一致：(code, name, module, category, sort_order)
const PERMS = [
  ['system:notify:view', '查看推送渠道与日志', 'system', 'read', 4000],
  ['system:notify:manage', '维护推送渠道', 'system', 'write', 4010],
  ['system:notify:push', '发起待办推送', 'system', 'write', 4020]
]

// 角色授权：只有管理员与采购主管能推；出纳/财务只读。
// 「谁有权把消息推到全公司群」这件事不该放开给所有能看报表的角色。
const ROLE_GRANTS = {
  admin: ['system:notify:view', 'system:notify:manage', 'system:notify:push'],
  purchase: ['system:notify:view', 'system:notify:push'],
  finance: ['system:notify:view'],
  viewer: ['system:notify:view']
}

module.exports.up = function up(db) {
  for (const sql of TABLES) db.exec(sql)
  for (const sql of INDEXES) db.exec(sql)

  // 权限表可能还没建（迁移顺序保护）；存在才灌
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

  // 演示渠道：**默认停用**且 webhook 为空。
  // 演示环境不应该指向任何真实群 —— 一条误推会发到真实同事的群里。
  if (tableExists(db, 'notify_channels')) {
    const ins = db.prepare(
      `INSERT INTO notify_channels (code,name,provider,webhook_url,event_types,enabled,remark)
       VALUES (?,?,?,?,?,0,?)
       ON CONFLICT(code) DO NOTHING`
    )
    ins.run('feishu-purchase', '飞书 · 采购待办', 'feishu', '', '', '演示渠道：填入机器人 webhook 并启用后生效')
    ins.run('dingtalk-purchase', '钉钉 · 采购待办', 'dingtalk', '', '', '演示渠道：填入机器人 webhook 并启用后生效')
  }

  stampDef(db, '013_notify', { tables: TABLES, indexes: INDEXES, perms: PERMS, roles: ROLE_GRANTS })
  return { tables: TABLES.length, indexes: INDEXES.length, perms: PERMS.length }
}

module.exports.verify = function verify(db) {
  for (const t of ['notify_channels', 'notify_logs']) if (!tableExists(db, t)) return false
  for (const sql of INDEXES) {
    const m = /CREATE INDEX IF NOT EXISTS (\w+)/.exec(sql)
    if (m && !hasIndex(db, m[1])) return false
  }
  for (const col of ['webhook_url', 'event_types', 'last_status']) {
    if (!hasColumn(db, 'notify_channels', col)) return false
  }
  if (defStale(db, '013_notify', { tables: TABLES, indexes: INDEXES, perms: PERMS, roles: ROLE_GRANTS })) return false
  return true
}
