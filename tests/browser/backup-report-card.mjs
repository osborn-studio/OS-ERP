/**
 * ============================================================================
 * 文件标识：tests/browser/backup-report-card.mjs ｜ 系统参数页"最近一次备份报告"状态卡（AH11）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/settings。共用服务没有备份目录报告（备份由脚本写文件，场景不碰盘），
 * 所以"有报告"的形态用 route.fetch 取真实响应后只替换 ops.last_backup / ops.backup_report 注入：
 *   · 真实响应：管理员 GET /api/meta/health 200 且带 ops.last_backup 与 ops.backup_report 键；页面卡片 data-result 等于接口 result；
 *     真实 result 为 none 时 backup_report 为 null，页面显示"没有可显示的清理摘要"；
 *   · 注入成功报告（清掉旧备份 3 份、孤儿清单 1 份、prune_state=done）：卡片 data-result=ok，data-pruned=3，data-orphans=1，文本含时间与"已加密"；
 *   · 注入失败 + 清理被打断（failed、planned、pre-prune）：data-result=failed、data-prune-state=planned，显示中间报告提示；
 *   · 无权限账号（role=purchase）：health 200 但没有 ops（不泄漏备份状态），页面没有该卡；未登录的 health 同样没有 ops。
 * 账号密码随机，不打印；页面文本没有路径 / sha256 字样；外部请求一律拦截并计数，必须为 0。
 * 浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { apiLogin, createAccount, launchBrowser, loopbackBase, makeApi, okData, screenshotPages, uiLogin } from './lib.mjs'

const base = loopbackBase()
const api = makeApi(base)
const browser = await launchBrowser()
const pages = []
const results = []
let externalRequests = 0
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }
const HEALTH_PATH = '/api/meta/health'

async function openSettings(actor, inject) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== base.origin) { externalRequests++; return route.abort('blockedbyclient') }
    if (inject && url.pathname === HEALTH_PATH) {
      const response = await route.fetch()
      const body = await response.json()
      if (body?.data?.ops) { body.data.ops.last_backup = inject.last_backup; body.data.ops.backup_report = inject.backup_report }
      return route.fulfill({ response, json: body })
    }
    return route.continue()
  })
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  await page.goto(new URL('/system/settings', base).href)
  await page.waitForLoadState('networkidle')
  return { page, errors }
}

try {
  const adminToken = (await apiLogin(api, 'admin', '12345')).token

  await step('real response: admin health carries ops.last_backup and ops.backup_report; the card result matches', async () => {
    const d = okData(await api(HEALTH_PATH, { token: adminToken }))
    assert.ok(['ok', 'failed', 'none', 'unreadable'].includes(d.ops.last_backup.result))
    assert.ok(Object.hasOwn(d.ops, 'backup_report'))
    const { page, errors } = await openSettings({ username: 'admin', password: '12345' })
    const card = page.getByTestId('backup-report')
    await card.waitFor()
    assert.equal(await card.getAttribute('data-result'), d.ops.last_backup.result)
    if (d.ops.backup_report === null) await page.getByTestId('backup-report-prune-none').waitFor()
    else assert.equal(await card.getAttribute('data-pruned'), String(d.ops.backup_report.pruned_backups))
    assert.deepEqual(errors, [])
  })

  await step('injected successful report: result ok, prune counts 3 / 1, time and encryption shown, no paths or hashes', async () => {
    const inject = {
      last_backup: { at: '2026-10-24T01:00:00.000Z', result: 'ok', encrypted: true, age_seconds: 7200 },
      backup_report: { report_phase: 'final', databases: 4, failed: 0, prune_state: 'done', pruned_backups: 3, pruned_orphans: 1 }
    }
    const { page, errors } = await openSettings({ username: 'admin', password: '12345' }, inject)
    const card = page.getByTestId('backup-report')
    await card.waitFor()
    assert.equal(await card.getAttribute('data-result'), 'ok')
    assert.equal(await card.getAttribute('data-prune-state'), 'done')
    assert.equal(await card.getAttribute('data-pruned'), '3')
    assert.equal(await card.getAttribute('data-orphans'), '1')
    const at = await page.getByTestId('backup-report-at').innerText()
    assert.ok(at.includes('2026-10-24T01:00:00.000Z') && at.includes('已加密') && at.includes('2 小时前'))
    const text = await card.innerText()
    assert.ok(text.includes('已清理') && text.includes('已清掉旧备份') && text.includes('4 个库条目'))
    assert.equal(await card.getAttribute('data-prune-confirmed'), '1')
    assert.doesNotMatch(text, /sha256|\.db\b|\/Users\/|\/var\//)
    assert.deepEqual(errors, [])
  })

  await step('injected failed report with an interrupted prune: failed / planned and the pre-prune notice', async () => {
    const inject = {
      last_backup: { at: '2026-10-24T02:00:00.000Z', result: 'failed', encrypted: false, age_seconds: 60 },
      backup_report: { report_phase: 'pre-prune', databases: 2, failed: 1, prune_state: 'planned', pruned_backups: 2, pruned_orphans: 0 }
    }
    const { page, errors } = await openSettings({ username: 'admin', password: '12345' }, inject)
    const card = page.getByTestId('backup-report')
    await card.waitFor()
    assert.equal(await card.getAttribute('data-result'), 'failed')
    assert.equal(await card.getAttribute('data-prune-state'), 'planned')
    const prune = await page.getByTestId('backup-report-prune').innerText()
    assert.ok(prune.includes('失败事件 1 次') && prune.includes('中间报告') && prune.includes('被打断') && prune.includes('未确认已删除'))
    assert.equal(await card.getAttribute('data-prune-confirmed'), '0')
    assert.equal(await page.getByTestId('backup-report-unconfirmed').count(), 1)
    assert.deepEqual(errors, [])
  })

  await step('non-admin and anonymous: health has no ops and the page has no card', async () => {
    const plain = await createAccount(api, adminToken, 'ah_plain', 'purchase')
    const asPlain = okData(await api(HEALTH_PATH, { token: plain.token }))
    assert.equal(Object.hasOwn(asPlain, 'ops'), false)
    assert.equal(Object.hasOwn(okData(await api(HEALTH_PATH)), 'ops'), false)
    const { page, errors } = await openSettings(plain)
    await page.waitForLoadState('networkidle')
    assert.equal(await page.getByTestId('backup-report').count(), 0)
    assert.deepEqual(errors.filter((e) => !/403/.test(e)), [])
  })

  assert.equal(externalRequests, 0, 'the scenario must not touch external origins')
  console.log(JSON.stringify({ suite: 'backup-report-card-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('backup-report-card', pages)
  throw error
} finally {
  await browser.close()
}
