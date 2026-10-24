/**
 * ============================================================================
 * 文件标识：tests/browser/approval-template-perm.mjs ｜ 审批模板维护权限（AA3 / system:approval:template）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/approval 的"审批模板"页签：
 *   · 无该权限点的非 admin 账号（角色由 roles-permissions 动态挑选）：页面没有"新建模板"，模板行没有"编辑 / 停用 / 启用"，
 *     直接调 POST /api/approval/templates 与 /templates/:id/toggle 都是 403，且模板启用状态没被改动；
 *   · admin：页面有"新建模板"；点一个生效中模板的"停用" -> 接口 200、出现"模板已停用"提示、行上"未启用"；
 *     再点"启用"恢复 -> 200、"模板已启用"提示、行上"生效中"（场景自己还原，不污染后续场景）。
 * 只访问本机回环源，外部请求一律拦截并计数，必须为 0。账号密码随机，不打印。
 * 浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { apiLogin, createAccount, errorCode, launchBrowser, loopbackBase, makeApi, okData, screenshotPages, uiLogin } from './lib.mjs'
import { pickRole } from './scenario-data.mjs'

const PERM = 'system:approval:template'
const base = loopbackBase()
const api = makeApi(base)
const browser = await launchBrowser()
const pages = []
const results = []
let externalRequests = 0
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }

async function openTemplates(actor) {
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
  const listed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/approval/templates' && r.request().method() === 'GET')
  await page.goto(new URL('/system/approval', base).href)
  await page.locator('.tab', { hasText: '审批模板' }).click()
  assert.equal((await listed).status(), 200)
  return { page, errors }
}

try {
  const admin = (await apiLogin(api, 'admin', '12345')).token
  const templates = okData(await api('/api/approval/templates', { token: admin })).list
  const target = templates.find((t) => Number(t.enabled) === 1)
  assert.ok(target, 'demo data must ship at least one enabled approval template')
  const row = (page) => page.locator('tbody tr', { hasText: target.code })
  const enabledNow = async () => Number(okData(await api('/api/approval/templates', { token: admin })).list.find((t) => t.id === target.id).enabled)

  const roleCode = await pickRole(api, admin, { lacking: [PERM] })
  assert.ok(roleCode, `a non-admin role without ${PERM} must exist`)
  const plain = await createAccount(api, admin, 'ap_plain', roleCode, { data_scope: 'all' })

  await step('without system:approval:template: no edit controls, and the API refuses with 403 and changes nothing', async () => {
    const mine = okData(await api('/api/auth/my-permissions', { token: plain.token }))
    assert.ok(!mine.permissions.includes(PERM) && !mine.permissions.includes('*'))
    const toggled = await api(`/api/approval/templates/${target.id}/toggle`, { token: plain.token, method: 'POST', body: {} })
    assert.equal(toggled.status, 403)
    const saved = await api('/api/approval/templates', { token: plain.token, body: { code: target.code, name: 'x', doc_type: target.doc_type, action: target.action, steps: [{ approver_type: 'role', approver_value: 'admin' }] } })
    assert.equal(saved.status, 403, `unexpected body code ${errorCode(saved)}`)
    assert.equal(await enabledNow(), 1, 'a refused toggle must not change the template')
    const { page, errors } = await openTemplates(plain)
    await row(page).waitFor()
    assert.equal(await page.getByRole('button', { name: /新建模板/ }).count(), 0)
    assert.equal(await row(page).getByRole('button', { name: /编辑/ }).count(), 0)
    assert.equal(await row(page).getByRole('button', { name: /停用|启用/ }).count(), 0)
    assert.match(await row(page).innerText(), /生效中/)
    assert.deepEqual(errors, [])
  })

  await step('admin: sees the controls, disables then re-enables a template with 200 and the matching toast and row state', async () => {
    const { page, errors } = await openTemplates({ username: 'admin', password: '12345' })
    await row(page).waitFor()
    assert.equal(await page.getByRole('button', { name: /新建模板/ }).count(), 1)
    assert.equal(await row(page).getByRole('button', { name: /编辑/ }).count(), 1)
    try {
      const off = page.waitForResponse((r) => r.url().includes(`/api/approval/templates/${target.id}/toggle`))
      await row(page).getByRole('button', { name: /停用/ }).click()
      assert.equal((await off).status(), 200)
      await page.getByText('模板已停用').first().waitFor()
      await row(page).getByText('未启用').waitFor()
      assert.equal(await enabledNow(), 0)
    } finally {
      if (await enabledNow() === 0) {
        const on = page.waitForResponse((r) => r.url().includes(`/api/approval/templates/${target.id}/toggle`))
        await row(page).getByRole('button', { name: /^\s*启用/ }).click()
        assert.equal((await on).status(), 200)
        await page.getByText('模板已启用').first().waitFor()
        await row(page).getByText('生效中').waitFor()
      }
    }
    assert.equal(await enabledNow(), 1, 'the scenario must restore the template it touched')
    assert.deepEqual(errors, [])
  })

  assert.equal(externalRequests, 0, 'no request may leave the loopback origin')
  console.log(JSON.stringify({ suite: 'approval-template-perm-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('approval-template-perm', pages)
  throw error
} finally {
  await browser.close()
}
