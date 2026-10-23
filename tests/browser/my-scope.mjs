/**
 * ============================================================================
 * 文件标识：tests/browser/my-scope.mjs ｜ 我的数据范围（Z6）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/my-scope：
 *   · org 范围账号（role=purchase，绑定一个无下级的演示组织）：GET /api/auth/my-scope 为 200、范围 org、
 *     范围内组织恰为该组织；页面"生效的数据范围"= 仅本组织，解释列表逐条等于接口的 explanations 且点名该组织，
 *     "范围内的组织"区写出"共 1 个组织"和组织名，词汇表里"仅本组织"行被标成当前（data-current）；
 *   · 对照组 admin：页面"生效的数据范围"= 全部数据，"全部组织"，词汇表当前行是"全部数据"，且页面不含上面那个组织名
 *     （证明文本来自各自的接口响应，而不是写死）。
 * 账号密码随机，不打印。接口数据期望在 scenario-data.mjs，由 tests/browser-scenario-contracts.test.mjs 在本机验证；
 * 浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { apiLogin, createAccount, launchBrowser, loopbackBase, makeApi, okData, screenshotPages, uiLogin } from './lib.mjs'
import { expectAdminScope, expectOrgScoped, pickLeafOrg } from './scenario-data.mjs'

const base = loopbackBase()
const api = makeApi(base)
const browser = await launchBrowser()
const pages = []
const results = []
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }

async function openMyScope(actor) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  const settled = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/my-scope')
  await page.goto(new URL('/system/my-scope', base).href)
  const res = await settled
  const body = await res.json()
  await page.getByTestId('my-scope-page').waitFor()
  await page.getByTestId('my-scope-effective').waitFor()
  return { page, errors, status: res.status(), data: body.data }
}

try {
  const admin = (await apiLogin(api, 'admin', '12345')).token
  const org = await pickLeafOrg(api, admin)
  const scoped = await createAccount(api, admin, 'ms_org', 'purchase', { org_id: org.id, data_scope: 'org' })

  await step('org-scoped user: API says org scope and the page shows that org with the server explanations', async () => {
    expectOrgScoped(okData(await api('/api/auth/my-scope', { token: scoped.token })), org)
    const { page, errors, status, data } = await openMyScope(scoped)
    assert.equal(status, 200)
    expectOrgScoped(data, org)
    assert.match(await page.getByTestId('my-scope-effective').innerText(), /^仅本组织/)
    const shown = await page.getByTestId('my-scope-explanations').locator('li').allInnerTexts()
    assert.deepEqual(shown, data.explanations, 'the page must list the server explanations verbatim')
    assert.ok(shown.some((s) => s.includes(`「${org.name}」`)))
    const orgCard = page.locator('h3', { hasText: '范围内的组织' }).locator('xpath=..')
    const orgCardText = await orgCard.innerText()
    assert.match(orgCardText, /共 1 个组织/)
    assert.ok(orgCardText.includes(org.name), 'the in-scope org list itself must name the org')
    const body = await page.locator('[data-testid="my-scope-page"]').innerText()
    assert.doesNotMatch(body, /全部组织（没有按组织的限制）/)
    const current = page.locator('tr[data-current="true"]')
    assert.equal(await current.count(), 1)
    assert.match(await current.locator('td').first().innerText(), /^仅本组织$/)
    assert.deepEqual(errors, [])
  })

  await step('control: admin sees 全部数据 and no org restriction, and none of the scoped user\'s org text leaks in', async () => {
    const { page, errors, status, data } = await openMyScope({ username: 'admin', password: '12345' })
    assert.equal(status, 200)
    expectAdminScope(data)
    assert.match(await page.getByTestId('my-scope-effective').innerText(), /^全部数据/)
    const shown = await page.getByTestId('my-scope-explanations').locator('li').allInnerTexts()
    assert.deepEqual(shown, data.explanations)
    const body = await page.locator('[data-testid="my-scope-page"]').innerText()
    assert.match(body, /全部组织（没有按组织的限制）/)
    assert.doesNotMatch(body, /共 \d+ 个组织/)
    assert.ok(!shown.some((s) => s.includes(`「${org.name}」`)))
    const current = page.locator('tr[data-current="true"]')
    assert.equal(await current.count(), 1)
    assert.match(await current.locator('td').first().innerText(), /^全部数据$/)
    assert.deepEqual(errors, [])
  })

  console.log(JSON.stringify({ suite: 'my-scope-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('my-scope', pages)
  throw error
} finally {
  await browser.close()
}
