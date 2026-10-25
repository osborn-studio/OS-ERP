/**
 * ============================================================================
 * 文件标识：tests/browser/audit-anchor-intents.mjs ｜ 审计日志页"锚点意图 key_id 与密钥集合状态"卡（AH11）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/audit-logs。共用服务里没有签名意图（意图只由保留清理 / 归档 / 抹除写入，
 * 而这些动作会改共用库），所以"有多把密钥"的形态用 route.fetch 取真实响应后只替换 anchor_intents 字段注入：
 *   · 真实响应：管理员 GET /api/meta/audit-logs 200 且带 anchor_intents（table_present / total / signed / unsigned / key_ids / recent）；
 *     页面卡片的 data-total / data-signed / data-unsigned / data-key-count 与接口逐项一致；
 *   · 注入形态（两把密钥 + 一条签名但无 key_id 的过渡期意图 + 一条未签名）：页面恰有 2 个 key 行，key_id、条数与注入一致，
 *     过渡期提示出现且条数正确，最近意图行的 data-signed / data-key-id 正确；页面文本没有签名 / 哈希 / 范围 / 操作人字样；
 *   · 注入"没有意图"：显示"还没有带 key_id 的意图"且没有 key 行；注入 table_present=false：整卡不显示；
 *   · 无权限账号（role=purchase）：接口 403、未登录 401，页面没有该卡。
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
const AUDIT_PATH = '/api/meta/audit-logs'
const K1 = '1111aaaa2222bbbb'
const K2 = '3333cccc4444dddd'

async function openAudit(actor, inject) {
  const ctx = await browser.newContext()
  ctx.setDefaultTimeout(15000)
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== base.origin) { externalRequests++; return route.abort('blockedbyclient') }
    if (inject && url.pathname === AUDIT_PATH) {
      const response = await route.fetch()
      const body = await response.json()
      if (body?.data) body.data.anchor_intents = inject
      return route.fulfill({ response, json: body })
    }
    return route.continue()
  })
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  await page.goto(new URL('/system/audit-logs', base).href)
  await page.waitForLoadState('networkidle')
  return { page, errors }
}

try {
  const adminToken = (await apiLogin(api, 'admin', '12345')).token

  await step('real response: admin 200 with anchor_intents; the card mirrors total / signed / unsigned / key count', async () => {
    const d = okData(await api(`${AUDIT_PATH}?page=1&pageSize=1`, { token: adminToken }))
    const a = d.anchor_intents
    assert.equal(a.table_present, true)
    assert.ok(Number.isInteger(a.total) && a.total === a.signed + a.unsigned)
    assert.ok(Array.isArray(a.key_ids) && Array.isArray(a.recent))
    const { page, errors } = await openAudit({ username: 'admin', password: '12345' })
    const card = page.getByTestId('audit-anchor-intents')
    await card.waitFor()
    assert.equal(await card.getAttribute('data-total'), String(a.total))
    assert.equal(await card.getAttribute('data-signed'), String(a.signed))
    assert.equal(await card.getAttribute('data-unsigned'), String(a.unsigned))
    assert.equal(await card.getAttribute('data-key-count'), String(a.key_ids.length))
    assert.equal(await page.getByTestId('audit-anchor-key').count(), a.key_ids.length)
    assert.deepEqual(errors, [])
  })

  await step('injected two-key set with a transition-period intent: key rows, counts, legacy note and recent rows match', async () => {
    const inject = {
      table_present: true, total: 5, signed: 4, unsigned: 1, signed_without_key_id: 1,
      key_ids: [{ key_id: K2, count: 1, last_at: '2026-10-05 10:00:00' }, { key_id: K1, count: 2, last_at: '2026-10-04 10:00:00' }],
      recent: [
        { id: 5, created_at: '2026-10-05 10:00:00', operation: 'retention', key_id: K2, signed: true },
        { id: 2, created_at: '2026-10-02 10:00:00', operation: 'archive', key_id: null, signed: true },
        { id: 1, created_at: '2026-10-01 10:00:00', operation: 'erase', key_id: null, signed: false }
      ]
    }
    const { page, errors } = await openAudit({ username: 'admin', password: '12345' }, inject)
    const card = page.getByTestId('audit-anchor-intents')
    await card.waitFor()
    assert.equal(await card.getAttribute('data-total'), '5')
    assert.equal(await card.getAttribute('data-legacy'), '1')
    const keys = page.getByTestId('audit-anchor-key')
    assert.equal(await keys.count(), 2)
    assert.equal(await keys.nth(0).getAttribute('data-key-id'), K2)
    assert.equal(await keys.nth(1).getAttribute('data-key-id'), K1)
    assert.equal(await keys.nth(1).getAttribute('data-count'), '2')
    assert.ok((await page.getByTestId('audit-anchor-legacy').innerText()).includes('1 条有签名但没有 key_id'))
    const recent = page.getByTestId('audit-anchor-recent')
    assert.equal(await recent.count(), 3)
    assert.equal(await recent.nth(0).getAttribute('data-signed'), '1')
    assert.equal(await recent.nth(0).getAttribute('data-key-id'), K2)
    assert.equal(await recent.nth(1).getAttribute('data-key-id'), '')
    assert.equal(await recent.nth(2).getAttribute('data-signed'), '0')
    const text = await card.innerText()
    assert.doesNotMatch(text, /signature|intent_hash|anchors_json|range_desc|operator_name/)
    assert.deepEqual(errors, [])
  })

  await step('injected empty intents show the empty statement; table_present=false hides the whole card', async () => {
    const empty = { table_present: true, total: 0, signed: 0, unsigned: 0, signed_without_key_id: 0, key_ids: [], recent: [] }
    const a = await openAudit({ username: 'admin', password: '12345' }, empty)
    await a.page.getByTestId('audit-anchor-keys-empty').waitFor()
    assert.equal(await a.page.getByTestId('audit-anchor-key').count(), 0)
    const b = await openAudit({ username: 'admin', password: '12345' }, { ...empty, table_present: false })
    await b.page.getByTestId('audit-fts-state').waitFor()
    assert.equal(await b.page.getByTestId('audit-anchor-intents').count(), 0)
    assert.deepEqual([...a.errors, ...b.errors], [])
  })

  await step('non-admin: the endpoint is 403 (401 without a token) and the page has no card', async () => {
    const plain = await createAccount(api, adminToken, 'ah_plain', 'purchase')
    assert.equal((await api(AUDIT_PATH, { token: plain.token })).status, 403)
    assert.equal((await api(AUDIT_PATH)).status, 401)
    const { page, errors } = await openAudit(plain)
    await page.waitForLoadState('networkidle')
    assert.equal(await page.getByTestId('audit-anchor-intents').count(), 0)
    assert.deepEqual(errors.filter((e) => !/403/.test(e)), [])
  })

  assert.equal(externalRequests, 0, 'the scenario must not touch external origins')
  console.log(JSON.stringify({ suite: 'audit-anchor-intents-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('audit-anchor-intents', pages)
  throw error
} finally {
  await browser.close()
}
