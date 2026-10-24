/**
 * ============================================================================
 * 文件标识：tests/browser/audit-fts-hint.mjs ｜ 审计日志关键字检索提示与"仅动作需模块"交互（AC11）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/audit-logs：
 *   · 关键字提示随输入变化：空 -> none；1 个字 -> too_short 且"查询"置灰；2 个字 -> like；≥3 个字 -> fts（data-mode）；
 *   · 用 ≥3 字的真实关键字点"查询"：列表接口带 keyword 返回 200，total 等于直接调接口的 total，每一行的动作 / 对象 / 操作人之一包含该关键字；
 *   · 只填动作不填模块：data-needs-module=1、"查询"置灰、点击不会发出带 action 的列表请求；服务端同口径 400 AUDIT_ACTION_NEEDS_MODULE；
 *     补上模块后提示解除、"查询"可点，请求 200；没有模块的纯关键字查询不受限（200）；
 *   · 无权限账号（role=purchase）：列表 403，页面是阻断提示，页面上没有任何检索提示元素。
 * 账号密码随机，不打印；外部请求一律拦截并计数，必须为 0。
 * 浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { apiLogin, createAccount, errorCode, launchBrowser, loopbackBase, makeApi, okData, screenshotPages, uiLogin } from './lib.mjs'
import { prepareAuditModule } from './scenario-data.mjs'

const base = loopbackBase()
const api = makeApi(base)
const browser = await launchBrowser()
const pages = []
const results = []
let externalRequests = 0
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }
const isAuditList = (r) => new URL(r.url()).pathname === '/api/meta/audit-logs'
const KW_PLACEHOLDER = '关键字（≥3 字走全文检索）'

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

try {
  const adminToken = (await apiLogin(api, 'admin', '12345')).token
  await prepareAuditModule(api, adminToken)
  const first = okData(await api('/api/meta/audit-logs?page=1&pageSize=50', { token: adminToken })).list
  const candidates = first.flatMap((r) => [r.entity, r.action, r.user_name]).filter((v) => typeof v === 'string' && /^[A-Za-z_]{3,12}$/.test(v))
  assert.ok(candidates.length > 0, 'the audit list must contain a letters-only action/entity/user_name of 3-12 characters')
  const keyword = candidates[0]

  await step('keyword hint follows the input (none / too_short / like / fts) and the query button is disabled only for 1 character', async () => {
    const { page, errors } = await openAudit({ username: 'admin', password: '12345' })
    await page.goto(new URL('/system/audit-logs', base).href)
    await page.getByRole('heading', { name: '审计日志' }).waitFor()
    const hint = page.getByTestId('audit-fts-hint')
    const query = page.getByRole('button', { name: '查询', exact: true })
    const kw = page.getByPlaceholder(KW_PLACEHOLDER)
    assert.equal(await hint.getAttribute('data-mode'), 'none')
    assert.match(await hint.innerText(), /≥3 字符走全文检索/)
    for (const [text, mode, disabled] of [['a', 'too_short', true], ['ab', 'like', false], ['abc', 'fts', false], [' a ', 'too_short', true], ['', 'none', false]]) {
      await kw.fill(text)
      await page.waitForFunction(({ m }) => document.querySelector('[data-testid="audit-fts-hint"]')?.getAttribute('data-mode') === m, { m: mode })
      assert.equal(await query.isDisabled(), disabled, `query disabled for ${JSON.stringify(text)}`)
    }
    assert.deepEqual(errors, [])
  })

  await step('a 3+ character keyword query returns 200, matches the direct API total, and every row contains the keyword', async () => {
    const { page, errors } = await openAudit({ username: 'admin', password: '12345' })
    await page.goto(new URL('/system/audit-logs', base).href)
    await page.getByRole('heading', { name: '审计日志' }).waitFor()
    await page.getByPlaceholder(KW_PLACEHOLDER).fill(keyword)
    assert.equal(await page.getByTestId('audit-fts-hint').getAttribute('data-mode'), 'fts')
    const listed = page.waitForResponse((r) => isAuditList(r) && new URL(r.url()).searchParams.get('keyword') === keyword && new URL(r.url()).searchParams.get('pageSize') === '50')
    await page.getByRole('button', { name: '查询', exact: true }).click()
    const res = await listed
    assert.equal(res.status(), 200)
    const data = (await res.json()).data
    const direct = okData(await api(`/api/meta/audit-logs?keyword=${encodeURIComponent(keyword)}&page=1&pageSize=50`, { token: adminToken }))
    assert.equal(data.total, direct.total)
    assert.ok(data.total >= 1)
    const needle = keyword.toLowerCase()
    assert.ok(data.list.every((r) => [r.action, r.entity, r.user_name].some((v) => String(v ?? '').toLowerCase().includes(needle))), 'every row must contain the keyword')
    assert.deepEqual(errors, [])
  })

  await step('action without module: hint flags it, query is disabled and sends nothing, server says 400; adding a module clears it', async () => {
    assert.equal(errorCode(await api('/api/meta/audit-logs?action=CREATE&page=1&pageSize=5', { token: adminToken })), 'AUDIT_ACTION_NEEDS_MODULE')
    assert.equal((await api('/api/meta/audit-logs?action=CREATE&page=1&pageSize=5', { token: adminToken })).status, 400)
    assert.equal((await api(`/api/meta/audit-logs?keyword=${encodeURIComponent(keyword)}&page=1&pageSize=5`, { token: adminToken })).status, 200, 'only action needs a module')
    const { page, errors } = await openAudit({ username: 'admin', password: '12345' })
    await page.goto(new URL('/system/audit-logs', base).href)
    await page.getByRole('heading', { name: '审计日志' }).waitFor()
    const hint = page.getByTestId('audit-action-hint')
    const query = page.getByRole('button', { name: '查询', exact: true })
    assert.equal(await hint.getAttribute('data-needs-module'), '0')
    const sent = []
    page.on('request', (r) => { if (isAuditList(r) && new URL(r.url()).searchParams.get('action')) sent.push(r.url()) })
    await page.getByPlaceholder('动作（须同时填模块）').fill('CREATE')
    await page.waitForFunction(() => document.querySelector('[data-testid="audit-action-hint"]')?.getAttribute('data-needs-module') === '1')
    assert.equal(await query.isDisabled(), true)
    await query.click({ force: true }).catch(() => {})
    assert.deepEqual(sent, [], 'no list request with action may leave the page while the module is empty')
    await page.getByPlaceholder('模块（如 sales）').fill('master')
    await page.waitForFunction(() => document.querySelector('[data-testid="audit-action-hint"]')?.getAttribute('data-needs-module') === '0')
    assert.equal(await query.isDisabled(), false)
    const listed = page.waitForResponse((r) => isAuditList(r) && new URL(r.url()).searchParams.get('action') === 'CREATE' && new URL(r.url()).searchParams.get('module') === 'master')
    await query.click()
    assert.equal((await listed).status(), 200)
    assert.deepEqual(errors, [])
  })

  await step('non-admin: the list is 403, the page is blocked and shows no search hints', async () => {
    const plain = await createAccount(api, adminToken, 'af_plain', 'purchase')
    assert.equal((await api('/api/meta/audit-logs?page=1&pageSize=50', { token: plain.token })).status, 403)
    const { page, errors } = await openAudit(plain)
    const listed = page.waitForResponse(isAuditList)
    await page.goto(new URL('/system/audit-logs', base).href)
    assert.equal((await listed).status(), 403)
    await page.getByTestId('scope-notice').waitFor()
    assert.equal(await page.getByTestId('audit-fts-hint').count(), 0)
    assert.equal(await page.getByTestId('audit-action-hint').count(), 0)
    assert.deepEqual(errors, [])
  })

  assert.equal(externalRequests, 0, 'the scenario must not touch external origins')
  console.log(JSON.stringify({ suite: 'audit-fts-hint-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('audit-fts-hint', pages)
  throw error
} finally {
  await browser.close()
}
