/**
 * ============================================================================
 * 文件标识：server/routes/notify.js ｜ 待办推送路由（通知中心）
 * ============================================================================
 * 【职责】待办推送路由（通知中心）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 待办推送路由（通知中心）
//
// 挂载点：/api/notify
//
// 三条接口分工要清楚，别混：
//   GET  /preview   —— 只渲染，不发送（`dryRun`）。配 webhook 之前先看消息长什么样。
//   POST /push      —— 真发送。按渠道订阅过滤 kind，逐个投递，失败的渠道不影响其它渠道。
//   POST /channels  —— 维护渠道（含 webhook）。**推送权限与渠道维护权限分开授权**：
//                      能看渠道配置的人未必该有权把消息推到全公司群。
//
// 一条刻意的约束：`enabled` 默认 0、webhook 默认空。
// 推送是唯一一个会把消息发到真实人面前的动作，误推的代价远大于漏推，
// 所以它必须是「显式配置 + 显式打开」的，不存在默认生效的路径。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams } from '../lib/http.js'
import { requireAuth, requirePerm, requireInternal, requireGlobalData, currentUser } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import {
  NotifyError, PROVIDERS, KNOWN_KINDS,
  listChannelsPublic, publicChannel, getChannel, upsertChannel, channelReady,
  buildDigest, renderPayload, pushDigest, listLogs, notifyOverview
} from '../lib/notify.js'
import { OutboundUrlError } from '../lib/outbound-url.js'

const r = Router()

function guard(fn) {
  return wrap(async (req, res, next) => {
    try {
      return await fn(req, res, next)
    } catch (e) {
      if (e instanceof NotifyError || e instanceof OutboundUrlError) {
        return fail(res, e.message, e.httpStatus, 1, { code: e.code, ...(e.detail || {}) })
      }
      throw e
    }
  })
}

// ---------------------------------------------------------------------------
// 摘要类接口的门（ADR-0008 / F05）
// ---------------------------------------------------------------------------
// 摘要（预览 / 推送 / 日志 / 概览里的最近一条）汇总的是**全库**的采购与审批待办：
// 采购订单与审批实例表没有组织列，无法按组织切片，所以不假装"按范围过滤"，
// 而是要求：内部角色 + 通知权限点 + **全部数据范围**。受限账号（门店 / 经销商 /
// 只有 subtree、org 范围的岗位）一律 403，判据与 dashboard / accounting 用的是同一组中间件。
const VIEW_PERMS = ['system:notify:view', 'system:notify:manage', 'system:notify:push']
const digestGate = (label) => [requireAuth, requireInternal(label), requirePerm(...VIEW_PERMS), requireGlobalData(label)]

const actorOf = (req) => {
  const u = currentUser(req)
  return { id: u.id || u.uid || null, name: u.name || u.username || null }
}

/** 元数据：渠道类型、可选事件类型 —— 前端不用自己硬编码一份 */
r.get(
  '/meta',
  requireAuth,
  wrap((_req, res) => ok(res, { providers: Object.values(PROVIDERS), kinds: KNOWN_KINDS }))
)

r.get(
  '/overview',
  ...digestGate('通知概览'),
  wrap((_req, res) => ok(res, notifyOverview(getDb())))
)

// ===========================================================================
// 渠道
// ===========================================================================

r.get(
  '/channels',
  requireAuth,
  requirePerm('system:notify:manage'),
  wrap((_req, res) => {
    const db = getDb()
    // 渠道一律走 publicChannel：响应里没有 secret，只有 has_secret / secret_last4
    const list = listChannelsPublic(db).map((c) => ({ ...c, ready: channelReady(c) }))
    return ok(res, { list })
  })
)

r.post(
  '/channels',
  requireAuth,
  requirePerm('system:notify:manage'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const row = upsertChannel(db, {
      code: b.code,
      name: b.name,
      provider: b.provider,
      webhookUrl: b.webhook_url,
      secret: b.secret,
      eventTypes: b.event_types,
      enabled: b.enabled,
      remark: b.remark
    })
    audit(req, { action: 'UPSERT', module: 'notify', entity: 'notify_channels', entityId: row.id, detail: { code: row.code, enabled: row.enabled, secret_changed: typeof b.secret === 'string' } })
    return ok(res, { ...publicChannel(row), ready: channelReady(row) })
  })
)

/** 启停渠道：单独一个动作，避免改配置时误把开关带上/带下 */
r.post(
  '/channels/:id/toggle',
  requireAuth,
  requirePerm('system:notify:manage'),
  guard((req, res) => {
    const db = getDb()
    const ch = getChannel(db, req.params.id)
    if (!ch) return fail(res, '渠道不存在', 404)
    const next = Number(ch.enabled) ? 0 : 1
    // 要打开就必须先有 webhook —— 允许「启用但发不出去」只会制造假象
    if (next && !String(ch.webhook_url || '').trim()) {
      return fail(res, '未配置 webhook 地址，不能启用', 400)
    }
    const row = upsertChannel(db, { code: ch.code, enabled: next })
    audit(req, { action: next ? 'ENABLE' : 'DISABLE', module: 'notify', entity: 'notify_channels', entityId: ch.id })
    return ok(res, { ...publicChannel(row), ready: channelReady(row) })
  })
)

// ===========================================================================
// 预览 / 推送
// ===========================================================================

/** 渲染预览：不发送。可指定渠道（决定消息体格式）与事件类型。摘要是全库口径，见 digestGate。 */
r.get(
  '/preview',
  ...digestGate('待办摘要预览'),
  wrap((req, res) => {
    const db = getDb()
    const kinds = req.query.kinds ? String(req.query.kinds).split(',').map((s) => s.trim()).filter(Boolean) : null
    const digest = buildDigest(db, { kinds })
    const ch = req.query.channel_id ? getChannel(db, req.query.channel_id) : null
    const channel = ch || { provider: String(req.query.provider || 'feishu'), code: 'preview', name: '预览' }
    return ok(res, { digest, channel: { code: channel.code, name: channel.name, provider: channel.provider }, ...renderPayload(channel, digest) })
  })
)

/**
 * 手工推送。`dry_run=true` 时走渲染不留痕（纯预览）；
 * 否则按渠道发送，每个渠道一条日志 —— 失败也不中断其它渠道。
 */
r.post(
  '/push',
  ...digestGate('待办推送'),
  requirePerm('system:notify:push'),
  guard(async (req, res) => {
    const db = getDb()
    const b = req.body || {}
    const actor = actorOf(req)
    const out = await pushDigest(db, {
      channelIds: b.channel_ids || null,
      kinds: b.kinds || null,
      dryRun: !!b.dry_run,
      triggeredBy: actor.name
    })
    if (!b.dry_run) {
      audit(req, { action: 'PUSH', module: 'notify', entity: 'notify_logs', detail: { sent: out.sent, failed: out.failed } })
    }
    return ok(res, out)
  })
)

/** 日志里存的是实际发出的消息体（含单号与金额），所以与摘要同一道门 */
r.get(
  '/logs',
  ...digestGate('推送日志'),
  wrap((req, res) => {
    const { page, pageSize } = pageParams(req)
    return ok(res, listLogs(getDb(), {
      page,
      pageSize,
      channelCode: req.query.channel_code || null,
      status: req.query.status || null
    }))
  })
)

export default r
