/**
 * ============================================================================
 * 文件标识：tests/browser/audit-fts-state.mjs ｜ 审计日志页 FTS 启用状态与维护提示（AE11）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/audit-logs：
 *   · 管理员：列表接口 200 且带 fts 对象（setting_enabled / index_present / env_disabled / active）；页面状态卡的 data-state 等于
 *     场景自己按这四个字段推导的结论（on / off / env / drift），data-setting / data-index 与接口逐项一致，维护提示含 audit-fts-maintain.mjs；
 *   · 把设置 audit_fts_enabled 改为关（危险键，带理由）：接口 fts.setting_enabled=false 而 active 仍随索引表在不在走（改设置本身不动索引）；
 *     页面 data-state 为 converging_off（索引表还在）或 off（无索引），文案如实说明；改回开后接口与页面一致恢复。
 *     开场先记下设置原值，finally 无论断言成败都还原为原值并校验还原结果；
 *   · 无权限账号（role=purchase）：列表 403，页面是阻断提示，页面上没有状态卡。
 * 账号密码随机，不打印；外部请求一律拦截并计数，必须为 0。
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
const isAuditList = (r) => new URL(r.url()).pathname === '/api/meta/audit-logs'
// 场景自己的推导（与页面实现无关）：环境强制 > 设置关（索引还在 = 待收敛）> 索引表缺失 > 开启
const expectedState = (f) => (f.env_disabled ? 'env' : !f.setting_enabled ? (f.index_present ? 'converging_off' : 'off') : !f.index_present ? 'drift' : 'on')

async function openAudit(actor) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  await ctx.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== base.origin) { externalRequests++; return route.abort('blockedbyclient') }
    return route.continue()
  })
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  return { page, errors }
}
const ftsOf = async (token) => okData(await api('/api/meta/audit-logs?page=1&pageSize=1', { token })).fts

let adminToken
let originalSetting = null
let restoreFailed = false
try {
  adminToken = (await apiLogin(api, 'admin', '12345')).token
  originalSetting = (await ftsOf(adminToken)).setting_enabled ? '1' : '0'

  await step('admin: the list carries fts and the page state card agrees with it field by field', async () => {
    const fts = await ftsOf(adminToken)
    for (const k of ['setting_enabled', 'index_present', 'env_disabled', 'active']) assert.equal(typeof fts[k], 'boolean', `fts.${k} must be a boolean`)
    const { page, errors } = await openAudit({ username: 'admin', password: '12345' })
    await page.goto(new URL('/system/audit-logs', base).href)
    await page.getByRole('heading', { name: '审计日志' }).waitFor()
    const card = page.getByTestId('audit-fts-state')
    await card.waitFor()
    assert.equal(await card.getAttribute('data-state'), expectedState(fts))
    assert.equal(await card.getAttribute('data-setting'), fts.setting_enabled ? '1' : '0')
    assert.equal(await card.getAttribute('data-index'), fts.index_present ? '1' : '0')
    assert.match(await page.getByTestId('audit-fts-maintain-hint').innerText(), /audit-fts-maintain\.mjs/)
    assert.deepEqual(errors, [])
  })

  await step('turning audit_fts_enabled off flips the card to "off" with the LIKE explanation; turning it on restores it', async () => {
    const put = (value) => api('/api/meta/settings', { token: adminToken, method: 'PUT', body: { key: 'audit_fts_enabled', value, reason: 'browser scenario audit-fts-state' } })
    assert.equal((await put('0')).status, 200)
    const off = await ftsOf(adminToken)
    assert.equal(off.setting_enabled, false)
    assert.equal(off.active, off.index_present && !off.env_disabled, 'active follows the query predicate, not the setting')
    const { page, errors } = await openAudit({ username: 'admin', password: '12345' })
    await page.goto(new URL('/system/audit-logs', base).href)
    const card = page.getByTestId('audit-fts-state')
    await card.waitFor()
    assert.equal(await card.getAttribute('data-state'), expectedState(off))
    assert.equal(await card.getAttribute('data-setting'), '0')
    assert.match(await page.getByTestId('audit-fts-state-text').innerText(), off.env_disabled ? /GML_AUDIT_FTS/ : off.index_present ? /索引表还在/ : /LIKE/)
    assert.match(await page.getByTestId('audit-fts-maintain-hint').innerText(), off.env_disabled ? /环境变量/ : off.index_present ? /--disable/ : /--enable/)
    assert.equal((await put('1')).status, 200)
    const on = await ftsOf(adminToken)
    assert.equal(on.setting_enabled, true)
    await page.reload()
    await page.waitForFunction((want) => document.querySelector('[data-testid="audit-fts-state"]')?.getAttribute('data-state') === want, expectedState(on))
    assert.deepEqual(errors, [])
  })

  await step('non-admin: the list is 403, the page is blocked and shows no FTS state card', async () => {
    const plain = await createAccount(api, adminToken, 'ae_plain', 'purchase')
    assert.equal((await api('/api/meta/audit-logs?page=1&pageSize=1', { token: plain.token })).status, 403)
    const { page, errors } = await openAudit(plain)
    const listed = page.waitForResponse(isAuditList)
    await page.goto(new URL('/system/audit-logs', base).href)
    assert.equal((await listed).status(), 403)
    await page.getByTestId('scope-notice').waitFor()
    await page.waitForLoadState('networkidle')
    assert.equal(await page.getByTestId('audit-fts-state').count(), 0)
    assert.deepEqual(errors, [])
  })

  assert.equal(externalRequests, 0, 'the scenario must not touch external origins')
  console.log(JSON.stringify({ suite: 'audit-fts-state-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('audit-fts-state', pages)
  throw error
} finally {
  // 无论成败都还原为开场记下的原值，并校验还原结果（API 失败不会抛错，必须看状态码）
  if (adminToken && originalSetting !== null) {
    const r = await api('/api/meta/settings', { token: adminToken, method: 'PUT', body: { key: 'audit_fts_enabled', value: originalSetting, reason: 'browser scenario audit-fts-state restore' } }).catch(() => null)
    restoreFailed = !r || r.status !== 200
    if (restoreFailed) console.error('audit-fts-state: failed to restore audit_fts_enabled')
  }
  await browser.close()
}
if (restoreFailed) process.exitCode = 1
