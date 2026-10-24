/**
 * ============================================================================
 * 文件标识：tests/browser/inactive-role-notice.mjs ｜ 停用角色提示（AG10）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建：
 *   · 管理员接口建一个 sales 账号；服务端没有"启停角色 / 加附加角色"的 HTTP 路由（ADR-0051 补充 3），
 *     所以场景经 GML_TEST_DATA_DIR（驱动给的一次性临时数据目录）直接改库：给账号加附加角色 purchase 并把该角色置为 inactive；
 *   · 对照：停用前登录，不出现横幅；
 *   · 停用后经真实登录表单登录：横幅出现且文字等于接口的 notice_message，点"关闭提示"后消失；
 *   · "我的数据范围"页：显示停用角色码、"由生效（启用）的角色生成"说明，解释列表逐条等于接口 explanations 且含"已停用"行；
 *   · finally 里把角色恢复为 active（场景失败也恢复，避免影响后续场景）。
 * 账号密码随机，不打印。浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'
import { apiLogin, createAccount, launchBrowser, loopbackBase, makeApi, okData, required, screenshotPages, uiLogin } from './lib.mjs'

const base = loopbackBase()
const api = makeApi(base)
const db = new Database(path.join(required('GML_TEST_DATA_DIR'), 'gml_cosmetic.db'))
db.pragma('busy_timeout = 5000')
const originalStatus = db.prepare("SELECT status FROM roles WHERE code='purchase'").get()?.status || 'active'
let browser
const pages = []
const results = []
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }

async function openPage(actor) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  return { page, errors }
}

try {
  browser = await launchBrowser()
  const admin = (await apiLogin(api, 'admin', '12345')).token
  const actor = await createAccount(api, admin, 'ag10', 'sales', { data_scope: 'all' })
  db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_code) VALUES (?, ?)').run(actor.id, 'purchase')

  await step('control: with every role active there is no banner', async () => {
    const { page, errors } = await openPage(actor)
    await page.waitForURL((u) => !u.pathname.startsWith('/login'))
    await page.locator('main').waitFor()
    assert.equal(await page.getByTestId('role-inactive-banner').count(), 0)
    assert.deepEqual(errors, [])
  })

  db.prepare("UPDATE roles SET status='inactive' WHERE code='purchase'").run()

  await step('after deactivation the login shows a dismissible banner carrying the server notice', async () => {
    const login = await api('/api/auth/login', { body: { username: actor.username, password: actor.password, industry: 'cosmetic' } })
    const d = okData(login)
    assert.equal(d.notice_code, 'ROLE_INACTIVE_NOTICE')
    assert.deepEqual(d.roles_inactive, ['purchase'])
    const { page, errors } = await openPage(actor)
    const banner = page.getByTestId('role-inactive-banner')
    await banner.waitFor()
    assert.equal((await page.getByTestId('role-inactive-banner-text').innerText()).trim(), d.notice_message)
    await page.getByTestId('role-inactive-banner-dismiss').click()
    await banner.waitFor({ state: 'detached' })
    assert.deepEqual(errors, [])
  })

  await step('the my-scope page lists the inactive role and explains from active roles only', async () => {
    const { page, errors } = await openPage(actor)
    const settled = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/my-scope')
    await page.goto(new URL('/system/my-scope', base).href)
    const res = await settled
    assert.equal(res.status(), 200)
    const data = (await res.json()).data
    assert.deepEqual(data.roles_inactive, ['purchase'])
    assert.deepEqual(data.roles_effective, ['sales'])
    await page.getByTestId('my-scope-page').waitFor()
    assert.match(await page.getByTestId('my-scope-inactive-codes').innerText(), /purchase/)
    assert.match(await page.getByTestId('my-scope-active-note').innerText(), /生效（启用）的角色生成/)
    const shown = await page.getByTestId('my-scope-explanations').locator('li').allInnerTexts()
    assert.deepEqual(shown, data.explanations)
    assert.ok(shown.some((s) => /已停用/.test(s)), 'an explanation line must name the inactive role')
    assert.ok(!shown.some((s) => /生效角色/.test(s) && /采购主管/.test(s)), 'the inactive role must not be listed as effective')
    assert.deepEqual(errors, [])
  })

  console.log(JSON.stringify({ suite: 'inactive-role-notice-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('inactive-role-notice', pages)
  throw error
} finally {
  try { db.prepare("UPDATE roles SET status=? WHERE code='purchase'").run(originalStatus) } finally {
    try { db.close() } finally { await browser?.close() }
  }
}
