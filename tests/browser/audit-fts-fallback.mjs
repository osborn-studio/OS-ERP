/**
 * ============================================================================
 * 文件标识：tests/browser/audit-fts-fallback.mjs ｜ 审计日志"维护中 / 回退"计数（AG11，接 AF4 `fts.fallback_total`）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/audit-logs：
 *   · 真实管理员：列表响应 `fts.fallback_total` 是非负整数；页面槽位 audit-fts-fallback 的 data-count 等于它；为 0 时没有说明文字，大于 0 时恰有一块；
 *   · 注入响应（page.route 改写同一个 /api/meta/audit-logs 响应的 fts.fallback_total）：7 -> data-count=7 且文字含"7 次"；
 *     非法值（负数、字符串、null、缺字段）-> data-count=0 且没有说明文字；
 *   · 披露边界：无审计权限账号（role=purchase）列表 403，页面上没有任何回退槽位 / 计数元素；
 *   · 外部请求一律拦截并计数，必须为 0。
 * 账号密码随机，不打印。浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
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
const isAuditList = (url) => url.pathname === '/api/meta/audit-logs'

// patch: undefined = 不改写；{ remove: true } 删字段；否则写入该值
async function openAudit(actor, patch, { blocked = false } = {}) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== base.origin) { externalRequests++; return route.abort('blockedbyclient') }
    if (patch !== undefined && isAuditList(url)) {
      const res = await route.fetch()
      if (res.status() !== 200) return route.fulfill({ response: res })
      const body = await res.json()
      if (body?.data?.fts) {
        if (patch.remove) delete body.data.fts.fallback_total
        else body.data.fts.fallback_total = patch.value
      }
      return route.fulfill({ response: res, json: body })
    }
    return route.continue()
  })
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  const seen = []
  page.on('response', async (r) => { if (isAuditList(new URL(r.url())) && r.status() === 200) { try { seen.push((await r.json())?.data?.fts?.fallback_total) } catch { /* not JSON */ } } })
  const listed = page.waitForResponse((r) => isAuditList(new URL(r.url())))
  await page.goto(new URL('/system/audit-logs', base).href)
  const status = (await listed).status()
  if (blocked) await page.getByTestId('scope-notice').waitFor()
  else await page.getByRole('heading', { name: '审计日志' }).waitFor()
  return { status, page, errors, seen }
}

try {
  const admin = (await apiLogin(api, 'admin', '12345')).token

  await step('real admin: fts.fallback_total is a non-negative integer and the slot shows exactly that', async () => {
    const fts = okData(await api('/api/meta/audit-logs?page=1&pageSize=1', { token: admin })).fts
    assert.ok(Number.isInteger(fts.fallback_total) && fts.fallback_total >= 0, 'fts.fallback_total must be a non-negative integer')
    const { page, errors, seen } = await openAudit({ username: 'admin', password: '12345' })
    const slot = page.getByTestId('audit-fts-fallback')
    await slot.waitFor({ state: 'attached' })
    // 页面值必须等于"页面自己收到的元数据响应"里的值（计数可能在两次读取之间增长，所以不与先前直接读到的值比等号，只要求不回退）
    const n = Number(await slot.getAttribute('data-count'))
    assert.ok(seen.length > 0 && seen.every((v) => Number.isInteger(v)), 'the page must receive an integer fts.fallback_total')
    assert.ok(seen.includes(n), `slot count ${n} must equal a value the page received (${seen.join(',')})`)
    assert.ok(n >= fts.fallback_total, 'the process counter never goes down')
    assert.equal(await page.getByTestId('audit-fts-fallback-text').count(), n > 0 ? 1 : 0)
    assert.deepEqual(errors, [])
  })

  await step('injected fallback_total=7: slot count 7 and the note says 7 次', async () => {
    const { page, errors } = await openAudit({ username: 'admin', password: '12345' }, { value: 7 })
    const slot = page.getByTestId('audit-fts-fallback')
    await slot.waitFor({ state: 'attached' })
    assert.equal(await slot.getAttribute('data-count'), '7')
    assert.match(await page.getByTestId('audit-fts-fallback-text').innerText(), /7 次/)
    assert.deepEqual(errors, [])
  })

  await step('invalid or missing fallback_total never renders a note', async () => {
    for (const patch of [{ value: -3 }, { value: 'x' }, { value: null }, { remove: true }]) {
      const { page, errors } = await openAudit({ username: 'admin', password: '12345' }, patch)
      const slot = page.getByTestId('audit-fts-fallback')
      await slot.waitFor({ state: 'attached' })
      assert.equal(await slot.getAttribute('data-count'), '0', JSON.stringify(patch))
      assert.equal(await page.getByTestId('audit-fts-fallback-text').count(), 0, JSON.stringify(patch))
      assert.deepEqual(errors, [])
    }
  })

  await step('no audit permission (purchase): list is 403 and the page carries no fallback slot', async () => {
    const acct = await createAccount(api, admin, 'af_fb', 'purchase')
    const direct = await api('/api/meta/audit-logs?page=1&pageSize=1', { token: acct.token })
    assert.equal(direct.status, 403)
    const { page, errors, status } = await openAudit(acct, undefined, { blocked: true })
    assert.equal(status, 403)
    await page.waitForLoadState('networkidle')
    assert.equal(await page.getByTestId('audit-fts-fallback').count(), 0)
    assert.equal(await page.getByTestId('audit-fts-fallback-text').count(), 0)
    assert.deepEqual(errors, [])
  })

  assert.equal(externalRequests, 0, 'the scenario must not touch external origins')
  console.log(JSON.stringify({ suite: 'audit-fts-fallback-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('audit-fts-fallback', pages)
  throw error
} finally {
  await browser.close()
}
