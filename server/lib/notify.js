/**
 * ============================================================================
 * 文件标识：server/lib/notify.js ｜ 待办推送（通知服务层）
 * ============================================================================
 * 【职责】待办推送（通知服务层）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 待办推送（通知服务层）
//
// 这个文件解决的是一个具体的运营缺口：**采购九环节都在系统里跑，但「该谁做什么」只能靠人登录进来看**。
// 把待办推出去（飞书 / 钉钉 / 企业微信机器人）需要三件事，缺一不可：
//
//   ① 组装：从各单据的待办口径里汇总出「今天谁要做什么」——
//      这里**复用 `purchaseTodos`**，不另写一套查询。
//      两套待办口径是维护灾难：界面看到的和推出去的不一致，用户会立刻不信任推送。
//   ② 渲染：不同机器人对消息体的要求不同（飞书要 interactive card / 互动卡片，
//      钉钉与企业微信要 markdown）。**渲染与发送分离**，这样加一个渠道不用动发送逻辑，
//      也才能在没配 webhook 的时候先把消息「渲染出来给人看」。
//   ③ 留痕：推送是**外部调用**，会失败（限流、密钥过期、网络抖动）。
//      没有日志就会出现「我说推了，你说没收到」这种无法对证的局面。
//
// 一条刻意的设计：**默认停用 + 空 webhook**。
// 推送是唯一一个会「把消息发到真实的人面前」的动作，误推的代价远大于漏推 ——
// 所以它必须是一个需要人显式配置与打开的动作，不能有默认生效的路径。

import { createHmac } from 'node:crypto'
import { purchaseTodos } from './purchase.js'
// 审批待办与采购待办**同形状合并**，推送侧不区分来源 —— 见 approvalTodoItems 的注释。
import { approvalTodoItems } from './approval.js'
// 出站策略与密钥封存各只有一处实现（ADR-0008）：保存渠道与发送走同一份判据。
import { validateOutboundUrl, outboundRequest, OutboundUrlError } from './outbound-url.js'
import { openSecret, sealSecret, resealIfLegacy, maskSecret } from './secret-box.js'

export class NotifyError extends Error {
  constructor(message, { code = 'NOTIFY_ERROR', httpStatus = 400, detail = null } = {}) {
    super(message)
    this.code = code
    this.httpStatus = httpStatus
    this.detail = detail
  }
}

export const PROVIDERS = {
  feishu: { code: 'feishu', label: '飞书机器人', format: 'interactive' },
  dingtalk: { code: 'dingtalk', label: '钉钉机器人', format: 'markdown' },
  wecom: { code: 'wecom', label: '企业微信机器人', format: 'markdown' },
  generic: { code: 'generic', label: '通用 Webhook', format: 'markdown' }
}

/** 待办 kind → 中文标签。与 `purchaseTodos` 推的 kind 逐字对齐，改一处必须改两处。 */
const KIND_LABEL = {
  req_approve: '请购单待审批',
  req_convert: '请购单待转采购订单',
  po_approve: '采购订单待审批',
  po_receive: '采购订单待到货',
  invoice_verify: '采购发票待校验',
  settle_audit: '采购结算待审核',
  payment_pay: '付款单待执行',
  approval_pending: '待审批单据'
}
export const KNOWN_KINDS = Object.keys(KIND_LABEL)

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const nowStr = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

// ---------------------------------------------------------------------------
// 一、渠道
// ---------------------------------------------------------------------------

/** 原始行（含封存后的 secret 列）：只给服务层内部与发送路径用，**不要**直接塞进响应。 */
export function listChannels(db) {
  return db.prepare('SELECT * FROM notify_channels ORDER BY id').all()
}

/**
 * 对外形态：**永远不带 `secret`**，只给 `has_secret` / `secret_last4`。
 * 路由层返回渠道一律经过这里 —— 这是"密钥不出服务端"的唯一出口，不要在路由里再拼一份。
 * 封存值解不开（密钥已更换且没配 PREVIOUS）时如实标 `secret_unreadable`，而不是假装没有密钥。
 */
export function publicChannel(row) {
  if (!row) return null
  const { secret, ...rest } = row
  try {
    return { ...rest, ...maskSecret(openSecret(secret)) }
  } catch {
    return { ...rest, has_secret: true, secret_last4: null, secret_unreadable: true }
  }
}

export function listChannelsPublic(db) {
  return listChannels(db).map(publicChannel)
}

/** 发送时取明文密钥：只在本模块内用，结果不进日志、不进响应。 */
function channelSecret(channel) {
  return openSecret(channel?.secret)
}

/** 保存前的地址门：空地址允许（"配了但没填地址"是合法中间态），非空必须过出站策略。 */
function checkedWebhookUrl(webhookUrl) {
  const s = String(webhookUrl ?? '').trim()
  if (!s) return ''
  return validateOutboundUrl(s).href
}

export function getChannel(db, idOrCode) {
  if (idOrCode == null) return null
  const n = Number(idOrCode)
  return Number.isFinite(n) && n > 0
    ? db.prepare('SELECT * FROM notify_channels WHERE id=?').get(n)
    : db.prepare('SELECT * FROM notify_channels WHERE code=?').get(String(idOrCode))
}

/** 新增/修改渠道（按 code 唯一）。只传要改的字段，未传的保持原值。 */
export function upsertChannel(db, { code, name, provider, webhookUrl, secret, eventTypes, enabled, remark } = {}) {
  if (!code) throw new NotifyError('渠道编码必填', { code: 'NOTIFY_NO_CODE' })
  if (provider && !PROVIDERS[provider]) {
    throw new NotifyError(`不支持的渠道类型：${provider}`, { code: 'NOTIFY_BAD_PROVIDER' })
  }
  const existing = db.prepare('SELECT * FROM notify_channels WHERE code=?').get(code)
  if (!existing) {
    if (!name) throw new NotifyError('新建渠道必须给名称', { code: 'NOTIFY_NO_NAME' })
    const res = db
      .prepare(
        `INSERT INTO notify_channels (code,name,provider,webhook_url,secret,event_types,enabled,remark)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        code, name, provider || 'generic', checkedWebhookUrl(webhookUrl), sealSecret(secret),
        Array.isArray(eventTypes) ? eventTypes.join(',') : eventTypes || '',
        enabled === undefined ? 0 : Number(enabled) ? 1 : 0,
        remark || null
      )
    return db.prepare('SELECT * FROM notify_channels WHERE id=?').get(res.lastInsertRowid)
  }
  // secret 的三种输入：未传/null = 保持（旧明文顺手升级为封存）；'' = 清除；非空 = 设置/轮换
  const patch = {
    name: name ?? existing.name,
    provider: provider ?? existing.provider,
    webhook_url: webhookUrl == null ? existing.webhook_url : checkedWebhookUrl(webhookUrl),
    secret: secret == null ? resealIfLegacy(existing.secret) : sealSecret(secret),
    event_types: eventTypes === undefined
      ? existing.event_types
      : Array.isArray(eventTypes) ? eventTypes.join(',') : eventTypes,
    enabled: enabled === undefined ? existing.enabled : Number(enabled) ? 1 : 0,
    remark: remark ?? existing.remark
  }
  db.prepare(
    `UPDATE notify_channels SET name=?,provider=?,webhook_url=?,secret=?,event_types=?,enabled=?,remark=?,
       updated_at=datetime('now','localtime') WHERE id=?`
  ).run(
    patch.name, patch.provider, patch.webhook_url, patch.secret,
    patch.event_types, patch.enabled, patch.remark, existing.id
  )
  return db.prepare('SELECT * FROM notify_channels WHERE id=?').get(existing.id)
}

/** 渠道订阅的事件类型；空表示全部订阅（「不选」的常见语义就是「都要」） */
export function channelKinds(channel) {
  const raw = String(channel?.event_types || '').trim()
  if (!raw) return KNOWN_KINDS.slice()
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** 渠道是否可发：启用 + 有 webhook。两者缺一都发不出去，前端要给出具体原因。 */
export function channelReady(channel) {
  if (!channel) return { ok: false, reason: '渠道不存在' }
  if (!Number(channel.enabled)) return { ok: false, reason: '渠道已停用' }
  if (!String(channel.webhook_url || '').trim()) return { ok: false, reason: '未配置 webhook 地址' }
  return { ok: true, reason: null }
}

// ---------------------------------------------------------------------------
// 二、组装待办摘要
// ---------------------------------------------------------------------------

/**
 * 汇总待办。**复用 purchaseTodos**，不另写查询 —— 界面看到的与推出去的必须是同一份数据。
 * @param kinds 只取这些 kind；不传取全部
 */
export function buildDigest(db, { kinds = null, limit = 8 } = {}) {
  const all = [...purchaseTodos(db), ...approvalTodoItems(db)]
  const want = Array.isArray(kinds) && kinds.length ? kinds : null
  const picked = want ? all.filter((t) => want.includes(t.kind)) : all

  const groups = []
  for (const kind of want || KNOWN_KINDS) {
    const items = picked.filter((t) => t.kind === kind)
    if (!items.length) continue
    groups.push({
      kind,
      label: KIND_LABEL[kind] || kind,
      count: items.length,
      amount: round2(items.reduce((s, x) => s + Number(x.amount || 0), 0)),
      // 摘要只带前 limit 条，避免一条消息刷屏；总数仍如实给出
      items: items.slice(0, limit).map((x) => ({ doc_no: x.doc_no, doc_type: x.doc_type, amount: round2(x.amount) }))
    })
  }

  // 标题跟着内容走：只有采购待办时叫「采购待办提醒」，混进审批后不能再自称「采购」——
  // 否则审批人收到消息会以为与自己无关，直接划过去。
  const hasApproval = groups.some((g) => g.kind === 'approval_pending')
  return {
    title: hasApproval ? '待办提醒（含审批）' : '采购待办提醒',
    generated_at: nowStr(),
    total: picked.length,
    total_amount: round2(picked.reduce((s, x) => s + Number(x.amount || 0), 0)),
    groups
  }
}

// ---------------------------------------------------------------------------
// 三、渲染（按渠道类型出不同消息体）
// ---------------------------------------------------------------------------

/** 纯文本摘要：任何渠道都能兜底，也是「没配 webhook 时先给人看」的形态 */
export function renderText(digest) {
  const lines = [`【${digest.title}】${digest.generated_at}`, `共 ${digest.total} 项待办，合计 ¥${digest.total_amount}`]
  for (const g of digest.groups) {
    lines.push('')
    lines.push(`▍${g.label}（${g.count} 项 · ¥${g.amount}）`)
    for (const it of g.items) lines.push(`  · ${it.doc_no}  ¥${it.amount}`)
    if (g.count > g.items.length) lines.push(`  … 另有 ${g.count - g.items.length} 项`)
  }
  if (!digest.groups.length) lines.push('', '当前没有待办，链路通畅。')
  return lines.join('\n')
}

/** Markdown 版：钉钉 / 企业微信可用 */
export function renderMarkdown(digest) {
  const head = `### ${digest.title}\n\n**${digest.generated_at}** ｜ 共 ${digest.total} 项 ｜ 合计 ¥${digest.total_amount}\n`
  if (!digest.groups.length) return `${head}\n当前没有待办，链路通畅。`
  const body = digest.groups
    .map((g) => {
      const items = g.items.map((it) => `- ${it.doc_no}　¥${it.amount}`).join('\n')
      const more = g.count > g.items.length ? `\n- … 另有 ${g.count - g.items.length} 项` : ''
      return `**${g.label}**（${g.count} 项 · ¥${g.amount}）\n${items}${more}`
    })
    .join('\n\n')
  return `${head}\n${body}`
}

/**
 * 按渠道类型渲染最终 payload。
 * 飞书用 interactive 卡片（有标题栏与分段），钉钉/企业微信用 markdown，
 * 未知类型退化成通用 markdown —— **永远不抛错**，渲染失败不应该让「看消息」这件事也做不了。
 */
export function renderPayload(channel, digest) {
  const provider = channel?.provider || 'generic'
  const text = renderText(digest)
  const md = renderMarkdown(digest)

  if (provider === 'feishu') {
    return {
      format: 'interactive',
      body: {
        msg_type: 'interactive',
        card: {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: digest.title }, template: 'blue' },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: `**生成时间**：${digest.generated_at}\n**待办合计**：${digest.total} 项 ｜ ¥${digest.total_amount}`
              }
            },
            ...(digest.groups.length
              ? digest.groups.map((g) => ({
                  tag: 'div',
                  text: {
                    tag: 'lark_md',
                    content:
                      `**${g.label}**（${g.count} 项 · ¥${g.amount}）\n` +
                      g.items.map((it) => `· ${it.doc_no}　¥${it.amount}`).join('\n') +
                      (g.count > g.items.length ? `\n· … 另有 ${g.count - g.items.length} 项` : '')
                  }
                }))
              : [{ tag: 'div', text: { tag: 'lark_md', content: '当前没有待办，链路通畅。' } }])
          ]
        }
      }
    }
  }

  if (provider === 'dingtalk') {
    return { format: 'markdown', body: { msgtype: 'markdown', markdown: { title: digest.title, text: md } } }
  }
  if (provider === 'wecom') {
    return { format: 'markdown', body: { msgtype: 'markdown', markdown: { content: md } } }
  }
  // generic：给最朴素的结构，方便接到自建网关 / n8n / 飞书以外的机器人
  return { format: 'text', body: { text, markdown: md, digest } }
}

// ---------------------------------------------------------------------------
// 四、发送与留痕
// ---------------------------------------------------------------------------

/**
 * 按渠道类型给请求加签。密钥为空则原样返回（渠道没配加签就是没配）。
 *
 *   dingtalk：query 追加 `timestamp`（毫秒）与 `sign` = base64(HMAC-SHA256(secret, `${timestamp}\n${secret}`))
 *   feishu  ：body 里加 `timestamp`（秒）与 `sign` = base64(HMAC-SHA256(key=`${timestamp}\n${secret}`, ''))
 *   generic ：头 `X-GML-Timestamp`（秒）与 `X-GML-Signature: sha256=` + hex(HMAC-SHA256(secret, `${timestamp}.${body}`))
 *   wecom   ：机器人 key 在 URL 里，没有签名方案
 *
 * 返回的 url/body/headers 就是实际要发出去的；留痕用同一份，保证"日志里的"= "发出去的"。
 */
export function signRequest(channel, body, secret) {
  const provider = channel?.provider || 'generic'
  let url
  try {
    url = new URL(String(channel?.webhook_url || ''))
  } catch {
    throw new OutboundUrlError('OUTBOUND_URL_INVALID', 'webhook 地址不是合法 URL')
  }
  const plain = String(secret ?? '')
  if (!plain) return { url: url.href, body: JSON.stringify(body), headers: {} }
  if (provider === 'dingtalk') {
    const timestamp = String(Date.now())
    const sign = createHmac('sha256', plain).update(`${timestamp}\n${plain}`).digest('base64')
    url.searchParams.set('timestamp', timestamp)
    url.searchParams.set('sign', sign)
    return { url: url.href, body: JSON.stringify(body), headers: {} }
  }
  if (provider === 'feishu') {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const sign = createHmac('sha256', `${timestamp}\n${plain}`).update('').digest('base64')
    return { url: url.href, body: JSON.stringify({ timestamp, sign, ...body }), headers: {} }
  }
  if (provider === 'wecom') return { url: url.href, body: JSON.stringify(body), headers: {} }
  const timestamp = String(Math.floor(Date.now() / 1000))
  const text = JSON.stringify(body)
  const signature = createHmac('sha256', plain).update(`${timestamp}.${text}`).digest('hex')
  return { url: url.href, body: text, headers: { 'X-GML-Timestamp': timestamp, 'X-GML-Signature': `sha256=${signature}` } }
}

/**
 * 发一条消息到指定渠道并留痕。
 *
 * @param dryRun true 时只渲染不发送（用于界面预览与测试）。
 *               有 dryRun 的理由：webhook 一旦配好，任何一次「试一下」都会真的发到群里。
 *               同事看到测试消息是小事，看到一堆测试消息就会开始忽略这个机器人 —— 那才是真损失。
 */
export async function pushToChannel(db, channel, digest, { dryRun = false, triggeredBy = null, timeoutMs = 8000 } = {}) {
  const rendered = renderPayload(channel, digest)
  const payloadStr = JSON.stringify(rendered.body)

  if (dryRun) {
    return { channel_id: channel?.id || null, channel_code: channel?.code || 'preview', dry_run: true, status: 'preview', payload: rendered }
  }

  const ready = channelReady(channel)
  if (!ready.ok) {
    const logId = writeLog(db, {
      channel, digest, payload: payloadStr, status: 'fail',
      httpStatus: null, error: ready.reason, triggeredBy
    })
    return { channel_id: channel.id, channel_code: channel.code, status: 'fail', error: ready.reason, log_id: logId }
  }

  let httpStatus = null
  let error = null
  let okFlag = false
  // 签名在发送前、留痕之前完成：日志里只会出现签名结果（timestamp/sign），绝不出现密钥本身
  let signed
  try {
    signed = signRequest(channel, rendered.body, channelSecret(channel))
  } catch (e) {
    signed = null
    error = `${e.code || 'NOTIFY_SIGN_ERROR'}: ${e.message}`
  }
  const sentPayload = signed ? signed.body : payloadStr
  if (signed) {
    try {
      // 出站策略在这里再判一次（库里的地址可能是策略收紧之前存的，或绕过 API 写入的）：
      // 协议/主机/名单 → DNS 逐地址检查 → 钉住地址连接 → 不跟随重定向 → 总超时覆盖响应体 → 响应体上限
      const res = await outboundRequest(signed.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signed.headers },
        body: signed.body,
        timeoutMs
      })
      httpStatus = res.status
      // 机器人网关惯用「HTTP 200 + 业务错误码」，所以 HTTP 200 不能单独作为成功判据
      const bodyText = res.bodyText || ''
      let bizCode = null
      try {
        const j = JSON.parse(bodyText)
        bizCode = j?.code ?? j?.errcode ?? j?.StatusCode ?? null
      } catch {
        /* 非 JSON 响应：不阻断判断，交给 HTTP 状态码 */
      }
      okFlag = httpStatus >= 200 && httpStatus < 300 && (bizCode === null || Number(bizCode) === 0)
      if (!okFlag) error = `HTTP ${httpStatus}${bizCode !== null ? ` · 业务码 ${bizCode}` : ''} ${bodyText.slice(0, 200)}`
    } catch (e) {
      // 策略拒绝（OUTBOUND_*）与网络错误都走同一条留痕路径；带上 code 便于在日志里区分"没发"与"发了没成"
      error = e instanceof OutboundUrlError ? `${e.code}: ${e.message}` : String(e.message || e)
    }
  }

  const logId = writeLog(db, {
    channel, digest, payload: sentPayload, status: okFlag ? 'success' : 'fail',
    httpStatus, error, triggeredBy
  })
  db.prepare(`UPDATE notify_channels SET last_push_at=?, last_status=? WHERE id=?`).run(
    nowStr(), okFlag ? 'success' : 'fail', channel.id
  )
  return { channel_id: channel.id, channel_code: channel.code, status: okFlag ? 'success' : 'fail', http_status: httpStatus, error, log_id: logId }
}

/** 消息体可能很大（分组多时），日志里截断存 —— 日志是给人看的凭证，不是备份 */
const LOG_PAYLOAD_LIMIT = 4000

function writeLog(db, { channel, digest, payload, status, httpStatus, error, triggeredBy }) {
  const res = db
    .prepare(
      `INSERT INTO notify_logs
         (channel_id,channel_code,provider,event_kind,title,payload,item_count,status,http_status,error,triggered_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      channel?.id || null, channel?.code || null, channel?.provider || null,
      'purchase_digest', digest?.title || null,
      String(payload || '').slice(0, LOG_PAYLOAD_LIMIT),
      Number(digest?.total || 0), status, httpStatus, error || null, triggeredBy || null
    )
  return res.lastInsertRowid
}

/**
 * 批量推送：按渠道各自的订阅过滤 kind，再逐个发送。
 * 一个渠道失败**不影响**其它渠道 —— 推送是尽力而为，不是事务。
 */
export async function pushDigest(db, { channelIds = null, kinds = null, dryRun = false, triggeredBy = null } = {}) {
  let channels = listChannels(db).filter((c) => Number(c.enabled))
  if (Array.isArray(channelIds) && channelIds.length) {
    const want = new Set(channelIds.map((x) => Number(x)))
    channels = channels.filter((c) => want.has(Number(c.id)))
  }
  // 需要预览时也要能选到停用渠道，否则「配好了但还没启用」这个中间态就看不到效果
  if (dryRun && Array.isArray(channelIds) && channelIds.length) {
    const want = new Set(channelIds.map((x) => Number(x)))
    channels = listChannels(db).filter((c) => want.has(Number(c.id)))
  }

  const results = []
  for (const ch of channels) {
    const chKinds = channelKinds(ch)
    const effective = kinds && kinds.length ? kinds.filter((k) => chKinds.includes(k)) : chKinds
    const digest = buildDigest(db, { kinds: effective })
    results.push(await pushToChannel(db, ch, digest, { dryRun, triggeredBy }))
  }
  if (!channels.length) {
    results.push({ status: 'skipped', error: '没有可用的推送渠道（需启用且配置 webhook）' })
  }
  return { sent: results.filter((r) => r.status === 'success').length, failed: results.filter((r) => r.status === 'fail').length, results }
}

export function listLogs(db, { page = 1, pageSize = 20, channelCode = null, status = null } = {}) {
  const cond = ['1=1']
  const args = []
  if (channelCode) {
    cond.push('channel_code=?')
    args.push(channelCode)
  }
  if (status) {
    cond.push('status=?')
    args.push(status)
  }
  const where = cond.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) c FROM notify_logs WHERE ${where}`).get(...args).c
  const list = db
    .prepare(`SELECT * FROM notify_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize)
  return { list, total, page, pageSize }
}

/** 推送概览：给界面顶部几个数 */
export function notifyOverview(db) {
  const channels = listChannels(db)
  const s = db
    .prepare(
      `SELECT
         COUNT(*) total,
         SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) ok,
         SUM(CASE WHEN status='fail' THEN 1 ELSE 0 END) fail
       FROM notify_logs`
    )
    .get()
  const last = db.prepare('SELECT * FROM notify_logs ORDER BY id DESC LIMIT 1').get() || null
  return {
    channels: channels.length,
    enabled: channels.filter((c) => Number(c.enabled)).length,
    ready: channels.filter((c) => channelReady(c).ok).length,
    log_total: s.total || 0,
    log_ok: s.ok || 0,
    log_fail: s.fail || 0,
    last
  }
}
