/**
 * ============================================================================
 * 文件标识：tests/browser/role-deactivate-preview.mjs ｜ 角色停用的影响预告与恢复指引（AH10）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，管理员与受影响账号都走真实登录表单：
 *   · 经驱动给的一次性 GML_TEST_DATA_DIR 直接往库里插一个场景专用角色（服务端没有"建角色"的 HTTP 路由），
 *     账号经管理员接口建：一个主角色为它、一个把它作为附加角色（预告应为 N=2、M=1，和接口的数字逐项相等）；
 *   · 角色页点"停用角色" ⇒ 弹窗显示 N / M；弹窗打开后再往库里加一个成员 ⇒ 点"确认停用"得到过期提示（409 ROLE_IMPACT_CHANGED），
 *     弹窗数字刷新为 3，再确认才成功；接口侧角色为 inactive，审计行带受影响人数；
 *   · 主角色为它的账号经真实登录表单登录：横幅带 data-primary-role-inactive=1，文字含"联系管理员"与"重新指派主角色"；
 *     附加角色账号的横幅不含"重新指派主角色"；
 *   · 管理员角色页出现"仍有 1 个账号以它为主角色"与"重新指派主角色"入口，点击进用户页，用户列表该账号带"已停用"标记；
 *   · 点"启用角色"恢复，接口侧为 active；
 *   · finally 里清理：账号改回 viewer、删附加角色关系、删场景角色（失败也清理，不影响后续场景）。
 * 账号密码随机，不打印。浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'
import { apiLogin, createAccount, launchBrowser, loopbackBase, makeApi, okData, randomSuffix, required, screenshotPages, uiLogin } from './lib.mjs'

const base = loopbackBase()
const api = makeApi(base)
const db = new Database(path.join(required('GML_TEST_DATA_DIR'), 'gml_cosmetic.db'))
db.pragma('busy_timeout = 5000')
const ROLE = `ah10_${randomSuffix()}`
const ROLE_NAME = `AH10场景角色${randomSuffix()}`
const accountIds = []
let browser
const pages = []
const results = []
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }
const roleStatus = () => db.prepare('SELECT status FROM roles WHERE code=?').get(ROLE)?.status

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
  db.prepare("INSERT INTO roles (code, name, data_scope, status, sort_order) VALUES (?, ?, 'self', 'active', 999)").run(ROLE, ROLE_NAME)
  browser = await launchBrowser()
  const adminToken = (await apiLogin(api, 'admin', '12345')).token
  const primary = await createAccount(api, adminToken, 'ah10p', ROLE, { data_scope: 'all' })
  const extra = await createAccount(api, adminToken, 'ah10x', 'sales', { data_scope: 'all' })
  accountIds.push(primary.id, extra.id)
  db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_code) VALUES (?, ?)').run(extra.id, ROLE)
  const impact = okData(await api(`/api/auth/roles/${ROLE}/deactivation-impact`, { token: adminToken }))
  assert.equal(impact.affected_users, 2)
  assert.equal(impact.primary_users, 1)

  const admin = { username: 'admin', password: '12345' }
  const { page: adminPage, errors: adminErrors } = await openPage(admin)

  await step('roles page: the confirm dialog shows the server preview and a stale count forces a re-confirm', async () => {
    await adminPage.goto(new URL('/system/roles', base).href)
    await adminPage.getByRole('button', { name: new RegExp(ROLE_NAME) }).click()
    await adminPage.getByTestId('role-deactivate').click()
    await adminPage.getByTestId('role-deactivate-dialog').waitFor()
    assert.equal((await adminPage.getByTestId('role-impact-affected').innerText()).trim(), String(impact.affected_users))
    assert.equal((await adminPage.getByTestId('role-impact-primary').innerText()).trim(), String(impact.primary_users))
    assert.equal(await adminPage.getByTestId('role-deactivate-stale').count(), 0)
    // 管理员看完预告之后，又有人被加进角色：此时确认必须被拒并刷新数字
    const late = await createAccount(api, adminToken, 'ah10l', 'viewer')
    accountIds.push(late.id)
    db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_code) VALUES (?, ?)').run(late.id, ROLE)
    await adminPage.getByTestId('role-deactivate-confirm').click()
    await adminPage.getByTestId('role-deactivate-stale').waitFor()
    assert.equal(roleStatus(), 'active', 'a stale confirmation must not deactivate')
    assert.equal((await adminPage.getByTestId('role-impact-affected').innerText()).trim(), '3')
    await adminPage.getByTestId('role-deactivate-confirm').click()
    await adminPage.getByTestId('role-deactivate-dialog').waitFor({ state: 'detached' })
    assert.equal(roleStatus(), 'inactive')
    const audit = db.prepare("SELECT detail FROM audit_logs WHERE action='ROLE_DEACTIVATE' AND entity_id=?").get(ROLE)
    assert.ok(audit, 'a ROLE_DEACTIVATE audit row must exist')
    assert.equal(JSON.parse(audit.detail).affectedUsers, 3)
    assert.equal(JSON.parse(audit.detail).primaryUsers, 1)
  })

  await step('the primary-role holder sees the contact-an-administrator banner; the additional-role holder does not get the reassign wording', async () => {
    const p = await openPage(primary)
    const banner = p.page.getByTestId('role-inactive-banner')
    await banner.waitFor()
    assert.equal(await banner.getAttribute('data-primary-role-inactive'), '1')
    const text = await p.page.getByTestId('role-inactive-banner-text').innerText()
    assert.match(text, /联系管理员/)
    assert.match(text, /重新指派主角色/)
    assert.deepEqual(p.errors, [])
    const x = await openPage(extra)
    await x.page.getByTestId('role-inactive-banner').waitFor()
    assert.equal(await x.page.getByTestId('role-inactive-banner').getAttribute('data-primary-role-inactive'), '0')
    assert.doesNotMatch(await x.page.getByTestId('role-inactive-banner-text').innerText(), /重新指派主角色/)
    assert.deepEqual(x.errors, [])
  })

  await step('admin side: reassign entry on the roles page leads to the user list, which tags the affected account', async () => {
    await adminPage.goto(new URL('/system/roles', base).href)
    await adminPage.getByRole('button', { name: new RegExp(ROLE_NAME) }).click()
    await adminPage.getByTestId('role-inactive-note').waitFor()
    assert.equal((await adminPage.getByTestId('role-inactive-primary-count').innerText()).trim(), '1')
    await adminPage.getByTestId('role-reassign-primary').click()
    await adminPage.waitForURL((u) => u.pathname === '/system/users')
    await adminPage.getByTestId('primary-role-inactive-tag').first().waitFor()
    assert.ok((await adminPage.getByTestId('primary-role-inactive-tag').count()) >= 1)
  })

  await step('enabling the role from the roles page restores it', async () => {
    await adminPage.goto(new URL('/system/roles', base).href)
    await adminPage.getByRole('button', { name: new RegExp(ROLE_NAME) }).click()
    await adminPage.getByTestId('role-activate').click()
    await adminPage.getByTestId('role-deactivate').waitFor()
    assert.equal(roleStatus(), 'active')
    assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action='ROLE_ACTIVATE' AND entity_id=?").get(ROLE))
    assert.deepEqual(adminErrors, [])
  })

  console.log(JSON.stringify({ suite: 'role-deactivate-preview-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('role-deactivate-preview', pages)
  throw error
} finally {
  try {
    for (const id of accountIds) db.prepare("UPDATE users SET role='viewer' WHERE id=? AND role=?").run(id, ROLE)
    db.prepare('DELETE FROM user_roles WHERE role_code=?').run(ROLE)
    db.prepare('DELETE FROM roles WHERE code=?').run(ROLE)
  } finally {
    try { db.close() } finally { await browser?.close() }
  }
}
