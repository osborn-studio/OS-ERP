/**
 * ============================================================================
 * 文件标识：server/routes/metrics.js ｜ 数据口径字典路由（模块 23）
 * ============================================================================
 * 【职责】数据口径字典路由（模块 23）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 数据口径字典路由（模块 23）
//
// 挂载点：/api/metrics
//
// 四个端点分工要分清：
//   GET  /          字典（分组 + 当前值）—— 前端字典页主接口，定义与数字同框
//   GET  /defs      只有定义、没有值 —— 给文档 / AI / 外部系统读口径
//   GET  /values    只有值 —— 给看板 / 报表批量取值（想一次拿多个指标时用它）
//   POST /sync      把代码定义重新投影进 metric_defs（治理动作，非日常）
//
// 一条刻意的约束：**值一律现算，不进缓存**。
//   口径字典全部的价值就是「你看到的数 = 按上面写的口径算出来的数」。
//   中间加一层缓存，字典页上的口径与数字就可能不在同一时刻，那正好把这个模块废掉。
//   指标都是单表 SUM/COUNT，千条级演示数据下现算的开销可以忽略。
//
// 另一条：`/defs` 与 `/values` 拆开，是因为它们的**读者不同**。
//   读口径的人（写文档、训 AI、对外解释）不需要数字；读数字的人（看板）不需要口径。
//   合成一个接口，两边都得过滤掉一半字段，反而更贵。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, wrap } from '../lib/http.js'
import { requireAuth, requirePerm, attachOrgScope } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import {
  METRICS, METRIC_BY_KEY, metricDefinitions, metricValues,
  metricCatalog, metricGroups, metricScopedFlags, syncMetricDefs, metricDefsStale
} from '../lib/metrics.js'

const r = Router()

const daysOf = (req) => {
  const n = Math.floor(Number(req.query.days))
  return Number.isFinite(n) && n > 0 && n <= 3650 ? n : 30
}

/** 逗号分隔的 keys 参数；不传 = 全部。非法 key 静默忽略（由 metricValues 处理） */
const keysOf = (req) => {
  const raw = String(req.query.keys || '').trim()
  if (!raw) return null
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// 字典
// ---------------------------------------------------------------------------

r.get(
  '/',
  requireAuth,
  requirePerm('system:metrics:view'),
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const days = daysOf(req)
    const withValues = String(req.query.with_values ?? '1') !== '0'
    return ok(res, {
      days,
      groups: metricGroups(db, { days, withValues, orgScope: req.orgScope }),
      total: METRICS.length,
      modules: [...new Set(METRICS.map((m) => m.module))]
    })
  })
)

// 只有定义：没有 compute，也没有值。给文档生成、AI 理解、对外口径说明用。
r.get(
  '/defs',
  requireAuth,
  requirePerm('system:metrics:view'),
  wrap((_req, res) => ok(res, { items: metricDefinitions(), total: METRICS.length }))
)

// 只有值：一次可传多个 key。返回 { key: number }；某条算不出来会是 { error } 而非 0。
r.get(
  '/values',
  requireAuth,
  requirePerm('system:metrics:view'),
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const days = daysOf(req)
    const keys = keysOf(req)
    const values = metricValues(db, { keys, days, orgScope: req.orgScope })
    // unknown = 请求了但字典里没有的 key —— 显式回一个列表，别让人对着空值猜
    const unknown = keys ? keys.filter((k) => !METRIC_BY_KEY[k]) : []
    // scoped：该值是否按调用者范围算（false = 全局口径，前端据此标注）；见 ADR-0053
    return ok(res, { days, values, scoped: metricScopedFlags(req.orgScope, keys), unknown })
  })
)

// 指标目录（关键指标一览）：字典页顶部卡片与看板复用同一份口径
r.get(
  '/catalog',
  requireAuth,
  requirePerm('system:metrics:view'),
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    return ok(res, { items: metricCatalog(db, { days: daysOf(req), withValues: true, orgScope: req.orgScope }) })
  })
)

// ---------------------------------------------------------------------------
// 治理
// ---------------------------------------------------------------------------

// 表的定义是否落后于代码。落后 = 有人只改了代码没跑同步，或有人直接改了表。
r.get(
  '/stale',
  requireAuth,
  requirePerm('system:metrics:view'),
  wrap((_req, res) => {
    const db = getDb()
    const stale = metricDefsStale(db)
    const inTable = db.prepare('SELECT COUNT(*) c FROM metric_defs').get().c
    return ok(res, {
      stale,
      in_code: METRICS.length,
      in_table: inTable,
      // 不一致时把差异摊开，避免只给一个 true/false 让人无从下手
      missing_in_table: stale
        ? metricDefinitions().filter((d) => !db.prepare('SELECT 1 FROM metric_defs WHERE key=?').get(d.key)).map((d) => d.key)
        : [],
      extra_in_table: stale
        ? db.prepare('SELECT key FROM metric_defs').all()
            .map((x) => x.key).filter((k) => !METRIC_BY_KEY[k])
        : []
    })
  })
)

// 把代码定义重新投影进表。幂等：重复调用结果一致。
r.post(
  '/sync',
  requireAuth,
  requirePerm('system:metrics:sync'),
  wrap((req, res) => {
    const db = getDb()
    const before = db.prepare('SELECT COUNT(*) c FROM metric_defs').get().c
    const out = syncMetricDefs(db)
    audit(req, { action: 'metrics.sync', detail: { before, after: out.synced } })
    return ok(res, { ...out, before, stale: metricDefsStale(db) })
  })
)

export default r
