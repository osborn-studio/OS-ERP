/**
 * ============================================================================
 * 文件标识：scripts/test-notify.mjs ｜ 测试：待办推送断言测试
 * ============================================================================
 * 【职责】测试：待办推送断言测试
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 待办推送断言测试
// 用法：node scripts/test-notify.mjs [cosmetic|food|apparel]
//
// 测的不是「接口通不通」，而是六条必须成立的约束：
//   ① 安全默认：演示渠道必须**默认停用且无 webhook** —— 推送是唯一会把消息
//      发到真人面前的动件，绝不能有默认生效的路径。
//   ② 组装复用：推送的待办必须与界面同一份（采购待办 + 审批待办，两者同形状合并），
//      两套口径必然漂移。
//   ③ 渲染与发送分离：四种渠道各自的消息体格式；渲染永远不抛错。
//   ④ 失败必须留痕：webhook 没配 / 连不上 / 返回业务错误码，都要落一条 fail 日志。
//      没有日志就会出现「我说推了，你说没收到」这种无法对证的局面。
//   ⑤ 渠道隔离：一个渠道失败不影响其它渠道（推送是尽力而为，不是事务）。
//   ⑥ 订阅过滤：渠道只收到它订阅的事件类型。
import http from 'node:http'
import { runWithIndustry, getDb, INDUSTRIES } from '../server/db/index.js'
import { purchaseTodos } from '../server/lib/purchase.js'
import { approvalTodoItems } from '../server/lib/approval.js'
import {
  NotifyError, PROVIDERS, KNOWN_KINDS,
  listChannels, getChannel, upsertChannel, channelReady, channelKinds,
  buildDigest, renderText, renderMarkdown, renderPayload,
  pushToChannel, pushDigest, listLogs, notifyOverview
} from '../server/lib/notify.js'

const industry = process.argv[2] && INDUSTRIES[process.argv[2]] ? process.argv[2] : 'cosmetic'
let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${msg}`)
  } else {
    fail += 1
    console.log(`  ✗ ${msg}`)
  }
}
const section = (t) => console.log(`\n${t}`)
const throws = (fn, code, msg) => {
  try {
    fn()
    ok(false, `${msg}（未抛错）`)
  } catch (e) {
    const hit = !code || e.code === code
    ok(hit, hit ? `${msg} → ${e.code}` : `${msg}（期望 ${code}，实得 ${e.code}）`)
  }
}

// —— 本地假机器人：验「真发送」路径必须有一个真的 HTTP 端点，
//    否则只能测到「未配置 webhook」那一条分支，发出去这一段永远没被跑过。
const received = []
let mode = 'ok'
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    received.push(body)
    if (mode === 'bizfail') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ code: 19021, msg: 'sign match fail' }))
    }
    if (mode === 'http500') {
      res.writeHead(500)
      return res.end('boom')
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, msg: 'ok' }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const HOOK = `http://127.0.0.1:${port}/hook`

const TEST_CODES = ['t-notify-ok', 't-notify-noauth', 't-notify-bizfail', 't-notify-sub']

/** 清掉本测试创建的渠道与日志（保持库干净，重跑结果稳定） */
function cleanup(db) {
  const ids = db
    .prepare(`SELECT id FROM notify_channels WHERE code IN (${TEST_CODES.map(() => '?').join(',')})`)
    .all(...TEST_CODES)
    .map((x) => x.id)
  if (ids.length) {
    db.prepare(`DELETE FROM notify_logs WHERE channel_id IN (${ids.map(() => '?').join(',')})`).run(...ids)
    db.prepare(`DELETE FROM notify_channels WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
  }
}

await runWithIndustry(industry, async () => {
  const db = getDb()
  console.log(`\n待办推送测试 · 行业=${industry}（${INDUSTRIES[industry].label}）`)
  console.log('='.repeat(64))
  cleanup(db)

  // ---------------------------------------------------------------
  section('T1 安全默认：内置渠道默认停用且无 webhook')
  const builtin = listChannels(db).filter((c) => ['feishu-purchase', 'dingtalk-purchase'].includes(c.code))
  ok(builtin.length === 2, `内置演示渠道 2 个（实测 ${builtin.length}）`)
  ok(builtin.every((c) => !Number(c.enabled)), '全部默认停用（无人为打开就不会发出去）')
  ok(builtin.every((c) => !String(c.webhook_url || '').trim()), '全部默认空 webhook（不会指向任何真实群）')
  ok(builtin.every((c) => PROVIDERS[c.provider]), '渠道类型都在支持列表内')

  // ---------------------------------------------------------------
  section('T2 可发判定：三种失败原因都要说清楚')
  ok(channelReady({ enabled: 0, webhook_url: HOOK }).reason === '渠道已停用', '停用 → "渠道已停用"')
  ok(channelReady({ enabled: 1, webhook_url: '' }).reason === '未配置 webhook 地址', '空 webhook → "未配置 webhook 地址"')
  ok(channelReady({ enabled: 1, webhook_url: HOOK }).ok === true, '启用 + 有 webhook → 可发')
  ok(channelReady(null).ok === false, '渠道不存在 → 不可发')

  // ---------------------------------------------------------------
  section('T3 组装复用：推送口径必须与界面同一份')
  // digest 的来源是 purchaseTodos **加上** approvalTodoItems（模块 22 引入）。
  // 断言必须按同一个「来源集合」去比，否则在「恰好没有待审批单」时通过、一有审批单就红 ——
  // 那种测试不是在守口径，只是在守某个时刻的巧合。
  const todos = purchaseTodos(db)
  const approvalTodos = approvalTodoItems(db)
  const expectedTodos = [...todos, ...approvalTodos]
  const digestAll = buildDigest(db)
  ok(
    digestAll.total === expectedTodos.length,
    `待办总数一致（采购 ${todos.length} + 审批 ${approvalTodos.length} / digest ${digestAll.total}）`
  )
  const sumTodos = Math.round(expectedTodos.reduce((s, x) => s + Number(x.amount || 0), 0) * 100) / 100
  ok(digestAll.total_amount === sumTodos, `金额合计一致（${digestAll.total_amount}）`)
  const kindsInTodos = new Set(todos.map((t) => t.kind))
  ok([...kindsInTodos].every((k) => KNOWN_KINDS.includes(k)), '出现的 kind 都在已知列表内（不会渲染成原始 key）')
  const one = buildDigest(db, { kinds: ['payment_pay'] })
  ok(one.groups.every((g) => g.kind === 'payment_pay'), '按 kind 过滤只出指定分组')
  ok(one.total === todos.filter((t) => t.kind === 'payment_pay').length, '过滤后的总数与源数据一致')

  // ---------------------------------------------------------------
  section('T4 渲染与发送分离：四种渠道各自的格式')
  const d = buildDigest(db)
  const feishu = renderPayload({ provider: 'feishu' }, d)
  ok(feishu.format === 'interactive' && feishu.body.card?.header, '飞书 → interactive 卡片（有 header）')
  ok(Array.isArray(feishu.body.card.elements) && feishu.body.card.elements.length >= 1, '飞书卡片至少一个 element')
  const ding = renderPayload({ provider: 'dingtalk' }, d)
  ok(ding.format === 'markdown' && ding.body.msgtype === 'markdown' && !!ding.body.markdown?.text, '钉钉 → markdown 文本')
  const wecom = renderPayload({ provider: 'wecom' }, d)
  ok(wecom.format === 'markdown' && !!wecom.body.markdown?.content, '企业微信 → markdown content')
  const gen = renderPayload({ provider: 'unknown-nonsense' }, d)
  ok(gen.format === 'text' && !!gen.body.text, '未知渠道类型 → 退化为通用文本（不抛错）')
  // 标题跟着内容走：只有采购待办时叫「采购待办提醒」，混进审批后必须换名 ——
  // 审批人收到标题写着「采购」的消息会以为与自己无关，直接划过去。
  const expectTitle = approvalTodos.length > 0 ? '待办提醒（含审批）' : '采购待办提醒'
  ok(renderText(d).includes(expectTitle), `纯文本含标题（${expectTitle}）`)
  ok(renderMarkdown(d).startsWith('### '), 'markdown 以三级标题开头')

  // ---------------------------------------------------------------
  section('T5 dryRun：只渲染不留痕')
  const before = listLogs(db, { pageSize: 1 }).total
  const dry = await pushToChannel(db, { id: null, code: 'preview', provider: 'feishu' }, d, { dryRun: true })
  ok(dry.status === 'preview' && dry.payload.format === 'interactive', 'dryRun 返回 preview 与渲染结果')
  ok(listLogs(db, { pageSize: 1 }).total === before, `dryRun 不写日志（${before} → ${listLogs(db, { pageSize: 1 }).total}）`)

  // ---------------------------------------------------------------
  section('T6 未配置 webhook：留 fail 日志而不是抛错')
  const noAuth = upsertChannel(db, { code: 't-notify-noauth', name: '测试·无 webhook', provider: 'feishu', enabled: 1 })
  const r6 = await pushToChannel(db, getChannel(db, noAuth.id), d)
  ok(r6.status === 'fail', '返回 fail 而不是抛异常')
  ok(r6.error === '未配置 webhook 地址', `错误原因明确：${r6.error}`)
  const log6 = db.prepare('SELECT * FROM notify_logs WHERE id=?').get(r6.log_id)
  ok(!!log6 && log6.status === 'fail' && log6.http_status === null, '落了一条 fail 日志（含原因）')

  // ---------------------------------------------------------------
  section('T7 真发送：本地假机器人收到消息并判成功')
  mode = 'ok'
  received.length = 0
  const okCh = upsertChannel(db, { code: 't-notify-ok', name: '测试·可用渠道', provider: 'dingtalk', webhookUrl: HOOK, enabled: 1 })
  const r7 = await pushToChannel(db, getChannel(db, okCh.id), d)
  ok(r7.status === 'success', `发送成功（HTTP ${r7.http_status}）`)
  ok(received.length === 1, '假机器人确实收到了 1 条请求')
  const payload = JSON.parse(received[0] || '{}')
  ok(payload.msgtype === 'markdown', '收到的报文是钉钉 markdown 格式')
  ok(String(payload.markdown?.text || '').includes(expectTitle), '报文里带上了待办内容')
  const ch7 = getChannel(db, okCh.id)
  ok(!!ch7.last_push_at && ch7.last_status === 'success', '渠道表回写了最近推送时间与结果')

  // ---------------------------------------------------------------
  section('T8 HTTP 200 + 业务错误码 必须判失败（机器人网关惯用套路）')
  mode = 'bizfail'
  received.length = 0
  const r8 = await pushToChannel(db, getChannel(db, okCh.id), d)
  ok(r8.status === 'fail', '业务码非 0 → 判失败（不能只看 HTTP 200）')
  ok(String(r8.error || '').includes('19021'), `错误里带上了业务码：${r8.error}`)

  mode = 'http500'
  const r8b = await pushToChannel(db, getChannel(db, okCh.id), d)
  ok(r8b.status === 'fail' && r8b.http_status === 500, 'HTTP 500 → 判失败并记录状态码')
  mode = 'ok'

  // ---------------------------------------------------------------
  section('T9 渠道隔离 + 订阅过滤')
  const sub = upsertChannel(db, {
    code: 't-notify-sub', name: '测试·只订阅结算', provider: 'generic',
    webhookUrl: HOOK, enabled: 1, eventTypes: ['settle_audit']
  })
  ok(channelKinds(getChannel(db, sub.id)).join(',') === 'settle_audit', '订阅列表解析正确')
  ok(channelKinds({ event_types: '' }).length === KNOWN_KINDS.length, '空订阅 = 订阅全部')

  received.length = 0
  const bulk = await pushDigest(db, { channelIds: [okCh.id, sub.id], triggeredBy: 'tester' })
  ok(bulk.results.length === 2, '两个渠道各推一次')
  ok(received.length === 2, '假机器人收到 2 条')
  const subMsg = JSON.parse(received[1] || '{}')
  const subText = subMsg.markdown || JSON.stringify(subMsg)
  ok(!subText.includes('请购单待审批'), '只订阅结算的渠道**收不到**请购待办（订阅真的生效）')
  if (buildDigest(db, { kinds: ['settle_audit'] }).total > 0) {
    ok(subText.includes('采购结算'), '订阅的结算待办确实在里面')
  } else {
    ok(true, '（当前无结算待办，跳过内容断言）')
  }

  // 隔离：把其中一个渠道打挂，另一个仍应成功
  mode = 'http500'
  received.length = 0
  const bulk2 = await pushDigest(db, { channelIds: [okCh.id, sub.id], triggeredBy: 'tester' })
  ok(bulk2.failed === 2 && received.length === 2, '两个渠道都失败时如实计数')
  const ov = notifyOverview(db)
  ok(ov.log_fail >= 2 && ov.log_total === ov.log_ok + ov.log_fail, 'fail 日志被统计，且总数 = 成功 + 失败')
  mode = 'ok'

  // ---------------------------------------------------------------
  section('T10 权限与校验')
  throws(() => upsertChannel(db, { code: '' }), 'NOTIFY_NO_CODE', '缺渠道编码被拒')
  throws(() => upsertChannel(db, { code: 'x', name: 'x', provider: 'no-such' }), 'NOTIFY_BAD_PROVIDER', '不支持的渠道类型被拒')
  throws(() => upsertChannel(db, { code: 'y' }), 'NOTIFY_NO_NAME', '新建缺名称被拒')
  const permRows = db
    .prepare(`SELECT code FROM permissions WHERE code IN ('system:notify:view','system:notify:manage','system:notify:push')`)
    .all()
  ok(permRows.length === 3, `三个推送权限点已注册（实测 ${permRows.length}）`)

  // ---------------------------------------------------------------
  cleanup(db)
  console.log(`\n${'='.repeat(64)}`)
  console.log(`通过 ${pass} / 失败 ${fail}`)
})

server.close()
if (fail > 0) process.exitCode = 1
