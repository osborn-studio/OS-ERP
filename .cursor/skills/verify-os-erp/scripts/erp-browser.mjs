#!/usr/bin/env node
// erp-browser.mjs — verification scaffolding (not product code). Drives the real OS ERP SPA in headless Chrome
// through the repo's own playwright-core (node_modules), with real clicks and typing, from a JSON step list.
//
// Usage (normally via `verify-os-erp.sh ui <label> <journey.json>`):
//   ERP_URL=... ERP_OUT=<dir> ERP_LABEL=<label> node erp-browser.mjs <journey.json>
// "${RUN_ID}" inside any string in the journey is replaced with ERP_RUN_ID, "${ADMIN_USER}" with the run's admin
// (demo: admin; production: verify-admin created by bootstrap-admin).
//
// Steps (one key decides the kind; optional "within": CSS scope, "exact": true for exact text):
//   {"login": "admin", "industry": "cosmetic"}  /login?industry=…, type 账号/密码 (placeholders 请输入账号/请输入密码),
//                                               click 「登 录」, wait until the URL leaves /login. Password comes from env.
//   {"goto": "/master/products"}                 navigate within the app origin
//   {"nav": ["主数据", "商品档案"]}             sidebar (<aside>): open the group, click the child NavLink
//   {"click": "新增", "role": "button"}          role = button|link|cell|row|tab|option|… (default: any text)
//   {"fill": "商品名称", "value": "…"}           input by <label> text (DataPage/Field wrap inputs in <label>)
//   {"fillPlaceholder": "关键词搜索", "value": "…"}
//   {"select": "品牌", "option": "…"}            <select> by label; option by visible label (or {"index": 1})
//   {"selectIn": "table select", "index": 1}     <select> by CSS (unlabeled cells, e.g. Lines.tsx SKU picker); nth via "nth"
//   {"fillIn": "table input[type=number]", "value": "5"}   input by CSS; nth via "nth"
//   {"press": "Enter"}
//   {"waitText": "已新增"}                        wait until the text is visible (toasts live ~2.6s)
//   {"waitGone": "保存中…"}
//   {"expectUrl": "/master/products"}           regex tested against pathname+search
//   {"expectText": "…", "count": 1}             assert visible occurrences (default ≥1); polls until stable, "timeout" (10s)
//   {"shot": "after-save"}                       <label>.<shot>.png + .text.txt (innerText) + .aria.txt (ARIA snapshot)
//   {"sleep": 300}
// window.confirm/alert are auto-accepted and logged. Requests leaving ERP_URL's origin are blocked and counted.
// Secrets (run password/JWT secret, demo "user / pwd" cards) are scrubbed from the DOM before every shot and from text.
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { redact, secretsFromEnv } from './redact.mjs'
import { passwordFor } from './erp-login.mjs'

const need = (k) => { if (!process.env[k]) { console.error(`${k} is required`); process.exit(2) } return process.env[k] }
const BASE = new URL(need('ERP_URL'))
const OUT = need('ERP_OUT'), LABEL = need('ERP_LABEL'), REPO = need('ERP_REPO')
const RUN_ID = process.env.ERP_RUN_ID || 'run'
const file = process.argv[2]; if (!file) { console.error('usage: erp-browser.mjs <journey.json>'); process.exit(2) }
const steps = JSON.parse(readFileSync(file, 'utf8').replaceAll('${RUN_ID}', RUN_ID).replaceAll('${ADMIN_USER}', process.env.ADMIN_USER || 'admin'))
mkdirSync(OUT, { recursive: true })
const logFile = path.join(OUT, `${LABEL}.steps.log`)
writeFileSync(logFile, `journey ${path.basename(file)} run=${RUN_ID} base=${BASE.origin}\n`)
const say = (m) => { const line = `[${new Date().toISOString()}] ${redact(m)}`; console.log(line); appendFileSync(logFile, line + '\n') }

const pwModule = path.join(REPO, 'node_modules/playwright-core/index.mjs')
if (!existsSync(pwModule)) { console.error('playwright-core missing: run verify-os-erp.sh build'); process.exit(2) }
const { chromium } = await import(pathToFileURL(pwModule).href)
const candidates = [process.env.CHROME_BIN, chromium.executablePath(), '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)
const exe = candidates.find((p) => existsSync(p))
if (!exe) { console.error('no Chrome/Chromium found; set CHROME_BIN'); process.exit(2) }

let browser
for (const sandbox of [true, false]) {
  try { browser = await chromium.launch({ executablePath: exe, headless: true, chromiumSandbox: sandbox }); say(`chrome ${browser.version()} sandbox=${sandbox} (${exe})`); break }
  catch (e) { say(`launch sandbox=${sandbox} failed: ${String(e.message).split('\n')[0]}`) }
}
if (!browser) process.exit(2)

const secrets = secretsFromEnv()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
context.setDefaultTimeout(15000)
let blocked = 0
await context.route('**/*', (route) => {
  if (new URL(route.request().url()).origin !== BASE.origin) { blocked++; return route.abort('blockedbyclient') }
  return route.continue()
})
const page = await context.newPage()
page.on('dialog', async (d) => { say(`dialog ${d.type()}: ${d.message().slice(0, 200)}`); await d.accept() })
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('response', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && r.status() >= 400) say(`HTTP ${r.status()} ${r.request().method()} ${u.pathname}`) })
// Slow API calls are logged so a wait timeout can be told apart from a missing row (server slow vs UI wrong).
const started = new Map()
page.on('request', (q) => { if (new URL(q.url()).pathname.startsWith('/api/')) started.set(q, Date.now()) })
page.on('requestfinished', (q) => {
  const t0 = started.get(q); started.delete(q)
  if (t0 !== undefined && Date.now() - t0 >= 2000) say(`slow ${Date.now() - t0}ms ${q.method()} ${new URL(q.url()).pathname}`)
})
page.on('requestfailed', (q) => started.delete(q))

const scope = (s) => (s.within ? page.locator(s.within).first() : page)
const textLoc = (s, text) => {
  const root = scope(s)
  if (s.role) return root.getByRole(s.role, { name: text, exact: !!s.exact })
  return root.getByText(text, { exact: !!s.exact })
}
async function scrubDom() {
  await page.evaluate((secrets) => {
    const re = /([A-Za-z0-9_]+ ?\/ ?)(12345|123456)\b/g
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      let t = n.nodeValue; const o = t
      for (const s of secrets) t = t.split(s).join('[REDACTED]')
      t = t.replace(re, '$1[REDACTED]').replace(/((?:密码|口令)\s*[:：=]?\s*)(12345|123456)\b/g, '$1[REDACTED]')
      // demo dashboard/login role tables put the public demo password alone in a cell;
      // a text node that is exactly 12345 / 123456 is treated as a password (may also hide a real quantity)
      if (/^\s*(12345|123456)\s*$/.test(t)) t = t.replace(/12345|123456/, '[REDACTED]')
      if (t !== o) n.nodeValue = t
    }
    for (const i of document.querySelectorAll('input')) if (i.type === 'password') i.value = ''
  }, secrets)
}
async function shot(name) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await scrubDom()
  const base = path.join(OUT, `${LABEL}.${name}`)
  await page.screenshot({ path: `${base}.png`, fullPage: false })
  writeFileSync(`${base}.text.txt`, redact(`URL ${new URL(page.url()).pathname}${new URL(page.url()).search}\n\n` + await page.locator('body').innerText()))
  writeFileSync(`${base}.aria.txt`, redact(await page.locator('body').ariaSnapshot()))
  say(`shot ${name} -> ${base}.{png,text.txt,aria.txt}`)
}

let n = 0
try {
  for (const s of steps) {
    n++
    const desc = JSON.stringify(s)
    say(`step ${n}: ${desc}`)
    if (s.login) {
      await page.goto(new URL(`/login?industry=${s.industry || 'cosmetic'}`, BASE).href)
      await page.getByPlaceholder('请输入账号').fill(s.login)
      await page.getByPlaceholder('请输入密码').fill(passwordFor(s.login))
      await page.getByRole('button', { name: /^登\s*录$/ }).click()
      await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
      say(`logged in as ${s.login}; now at ${new URL(page.url()).pathname}`)
    } else if (s.goto) {
      await page.goto(new URL(s.goto, BASE).href)
    } else if (s.nav) {
      const aside = page.locator('aside')
      const [group, child] = s.nav
      const childLink = aside.getByRole('link', { name: child ?? group, exact: true })
      if (child && !(await childLink.isVisible().catch(() => false))) await aside.getByText(group, { exact: true }).click()
      await childLink.click()
    } else if (s.click !== undefined) {
      await textLoc(s, s.click).first().click()
    } else if (s.fill !== undefined) {
      const loc = scope(s).getByLabel(s.fill, { exact: !!s.exact }).first()
      await loc.fill(String(s.value))
    } else if (s.fillPlaceholder !== undefined) {
      await scope(s).getByPlaceholder(s.fillPlaceholder).first().fill(String(s.value))
    } else if (s.select !== undefined) {
      const loc = scope(s).getByLabel(s.select, { exact: !!s.exact }).first()
      if (s.index !== undefined) await loc.selectOption({ index: s.index }); else await loc.selectOption({ label: s.option })
    } else if (s.selectIn !== undefined) {
      const loc = scope(s).locator(s.selectIn).nth(s.nth ?? 0)
      if (s.index !== undefined) await loc.selectOption({ index: s.index }); else await loc.selectOption({ label: s.option })
    } else if (s.fillIn !== undefined) {
      await scope(s).locator(s.fillIn).nth(s.nth ?? 0).fill(String(s.value))
    } else if (s.press) {
      await page.keyboard.press(s.press)
    } else if (s.waitText !== undefined) {
      await textLoc(s, s.waitText).first().waitFor({ state: 'visible', timeout: s.timeout || 15000 })
    } else if (s.waitGone !== undefined) {
      await textLoc(s, s.waitGone).first().waitFor({ state: 'hidden', timeout: s.timeout || 15000 })
    } else if (s.expectUrl) {
      await page.waitForURL((u) => new RegExp(s.expectUrl).test(u.pathname + u.search), { timeout: 10000 })
    } else if (s.expectText !== undefined) {
      // A list refresh (e.g. 查询 right after save) briefly swaps rows for 「加载中…」, so a one-shot count can read 0
      // while the row is about to come back. Poll until the count matches on two reads 250ms apart with no loading row.
      const want = (c) => (s.count === undefined ? c >= 1 : c === s.count)
      const read = async () => ((await scope(s).getByText('加载中…').count()) > 0 ? -1 : textLoc(s, s.expectText).count())
      const deadline = Date.now() + (s.timeout || 10000)
      let c = await read(), stable = false
      while (Date.now() < deadline) {
        if (want(c)) {
          await page.waitForTimeout(250)
          const again = await read()
          if (again === c) { stable = true; break }
          c = again
        } else {
          await page.waitForTimeout(100)
          c = await read()
        }
      }
      if (!stable) throw new Error(`expectText ${JSON.stringify(s.expectText)}: found ${c < 0 ? 'loading' : c}, want ${s.count ?? '>=1'}`)
      say(`expectText ok (${c})`)
    } else if (s.shot) {
      await shot(s.shot)
    } else if (s.sleep) {
      await page.waitForTimeout(s.sleep)
    } else throw new Error(`unknown step ${desc}`)
  }
  say(`PASS ${LABEL}: ${steps.length} steps; external requests blocked=${blocked}; console errors=${consoleErrors.length}`)
  for (const e of consoleErrors.slice(0, 10)) say(`console.error: ${e.slice(0, 300)}`)
  await browser.close()
} catch (e) {
  say(`FAIL ${LABEL} at step ${n}: ${String(e.message).split('\n')[0]}`)
  // State at the moment of failure, before the fail shot waits for networkidle (which can let the row arrive late)
  const s = steps[n - 1] || {}, text = s.waitText ?? s.expectText
  if (text !== undefined) {
    const matches = await textLoc(s, text).count().catch(() => -1)
    const loading = await scope(s).getByText('加载中…').count().catch(() => -1)
    say(`at failure: matches=${matches} loading=${loading > 0} pendingApi=${started.size}`)
  }
  await shot(`fail-${n}`).catch(() => {})
  await browser.close()
  process.exit(1)
}
