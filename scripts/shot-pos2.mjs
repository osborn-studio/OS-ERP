/**
 * ============================================================================
 * 文件标识：scripts/shot-pos2.mjs ｜ 模块 17 门店 POS 交班缴款界面截图（headless Chrome + CDP，零额外依赖）
 * ============================================================================
 * 【职责】模块 17 门店 POS 交班缴款界面截图（headless Chrome + CDP，零额外依赖）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 模块 17 门店 POS 交班缴款界面截图（headless Chrome + CDP，零额外依赖）
 *
 * 为什么手写 CDP 客户端：项目里没装 playwright / puppeteer，而 agent-browser 需要
 * 另下几百 MB 的 Chromium。本机已有 Chrome，用它的 --remote-debugging-port 配合
 * Node 22 内置 WebSocket 就够用了（与 shot-qc / shot-costing / shot-invoice 同一套骨架）。
 *
 * 用法：node scripts/shot-pos2.mjs [baseUrl] [outDir]
 *   baseUrl 默认 http://127.0.0.1:5173（vite dev，/api 已代理到 3001）
 *
 * 两套登录态：门店页面要**门店账号**（admin 没有 store_id，`/pos/context` 会 403），
 * 总部看板要 admin。所以脚本里切换两次 localStorage，而不是全程一个 token。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = process.argv[2] || 'http://127.0.0.1:5173'
const OUT = process.argv[3] || '/Users/linxinlan/工作文档/gml/docs/shots'
const PORT = 9300 + Math.floor(Math.random() * 90)
const PROFILE = `/tmp/gml-shot-pos2-${PORT}`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const API = 'http://127.0.0.1:3001'

mkdirSync(OUT, { recursive: true })

async function login(username, password) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, industry: 'cosmetic' })
  })
  const j = await r.json()
  if (!j?.data?.token) throw new Error(`${username} 登录失败：${JSON.stringify(j).slice(0, 160)}`)
  return { token: j.data.token, user: j.data.user }
}

const STORE = await login('store01', '123456')
const ADMIN = await login('admin', '12345')
console.log(`登录成功：门店 ${STORE.user?.name}（store_id=${STORE.user?.store_id}）｜总部 ${ADMIN.user?.name}`)

// ---------- 起 Chrome ----------
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-software-rasterizer',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-proxy-server',
  '--proxy-bypass-list=*',
  '--remote-allow-origins=*',
  '--window-size=1500,1100',
  `--user-data-dir=${PROFILE}`,
  'about:blank'
], { stdio: 'ignore' })

const cleanup = () => { try { chrome.kill('SIGKILL') } catch {} }
process.on('exit', cleanup)

async function waitChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) {
        const v = await r.json()
        if (String(v.webSocketDebuggerUrl || '').includes(`:${PORT}/`)) return v
      }
    } catch {}
    await sleep(300)
  }
  throw new Error('Chrome 调试端口没起来（或端口被别的实例占用）')
}
await waitChrome()

// ---------- 极简 CDP 客户端 ----------
let msgId = 0
const pending = new Map()
const consoleErrors = []
const pageErrors = []

class Cdp {
  constructor(ws) {
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
        return
      }
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || 'unknown')
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
        consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
      }
      if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
        consoleErrors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim())
      }
    })
  }
  send(method, params = {}) {
    return this.once(method, params, 6000).catch(async (err) => {
      try { this.ws.send(JSON.stringify({ id: ++msgId, method: 'Browser.getVersion' })) } catch {}
      await sleep(500)
      return this.once(method, params, 15000).catch(() => { throw err })
    })
  }
  once(method, params, timeout) {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) }
      }, timeout)
    })
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('error', (e) => reject(new Error(`WS 连接失败: ${e.message || url}`)))
    ws.addEventListener('open', () => {
      const cdp = new Cdp(ws)
      ws.send(JSON.stringify({ id: 999, method: 'Browser.getVersion' }))
      resolve(cdp)
    })
  })
}

let pageTarget = null
try {
  const nr = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  if (nr.ok) pageTarget = await nr.json()
} catch {}
if (!pageTarget) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  pageTarget = targets.find((t) => t.type === 'page' && t.url === 'about:blank') || targets.find((t) => t.type === 'page')
}
if (!pageTarget?.webSocketDebuggerUrl) throw new Error('没拿到可用的 page target')
const cdp = await connect(pageTarget.webSocketDebuggerUrl)

await sleep(250)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 2, mobile: false })

/** 在每次导航前注入登录态（切账号只需再写一次 localStorage） */
let authScriptId = null
async function setAuth({ token, user }) {
  if (authScriptId) { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: authScriptId }).catch(() => {}) }
  const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      try {
        localStorage.setItem('gml_token', ${JSON.stringify(token)});
        localStorage.setItem('gml_user', ${JSON.stringify(JSON.stringify(user))});
        localStorage.setItem('gml_industry', 'cosmetic');
      } catch (e) {}
    `
  })
  authScriptId = r.identifier
}

const evalJs = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
  return r.result?.value
}

async function goto(path, { wait = 3000, fullPage = true } = {}) {
  await cdp.send('Page.navigate', { url: `${BASE}${path}` })
  await sleep(wait)
  if (fullPage) {
    try {
      const m = await cdp.send('Page.getLayoutMetrics')
      const h = Math.min(Math.ceil(m.cssContentSize?.height || 1100), 6000)
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: h, deviceScaleFactor: 2, mobile: false })
      await sleep(600)
    } catch {}
  }
}

async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const file = `${OUT}/${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('  截图 →', file)
  return file
}

/**
 * 只拍**当前视口**（不展开整页）。
 * `goto()` 会把视口高度撑到整页高度，之后再拍第二张「同页面下半段」时，
 * `captureBeyondViewport:true` 拍到的还是同一张整页图 —— 两张 md5 一模一样，
 * 交付出去等于少了一张图（本项目已踩过：pos2-08 与 pos2-09 逐字节相同）。
 * 所以「下半段」必须先把视口缩回 1100，滚到位，再只拍视口。
 */
async function shotViewport(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = `${OUT}/${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('  截图 →', file)
  return file
}

/** 把含关键字的**最内层**元素滚到视口中间（自动处理任意层级的滚动容器） */
async function scrollTo(text) {
  return evalJs(`
    (() => {
      const t = ${JSON.stringify(text)};
      const els = [...document.querySelectorAll('div,section,table,h2,h3,span')]
        .filter((e) => (e.textContent || '').includes(t));
      if (!els.length) return 'not-found';
      els.sort((a, b) => a.textContent.length - b.textContent.length);
      els[0].scrollIntoView({ block: 'center' });
      return 'ok:' + els[0].textContent.replace(/\\s+/g, ' ').trim().slice(0, 40);
    })()
  `)
}

/**
 * 按文字点最内层的可点元素。
 * 注意：这里**不加** `.tab` 兜底 —— POS 底部页签里「缴款」「交班核款」与页面正文的
 * 同名按钮会撞车，模糊匹配会先点到页签上去，拍出来是同一张图。
 */
async function clickByText(text, selector = 'button:not(.tab), a, [role=button]') {
  return evalJs(`
    (() => {
      const t = ${JSON.stringify(text)};
      const pool = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const hits = pool.filter((e) => (e.textContent || '').trim() === t).concat(
        pool.filter((e) => (e.textContent || '').trim().includes(t))
      );
      if (!hits.length) return 'not-found';
      hits.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      hits[0].click();
      return 'clicked:' + (hits[0].textContent || '').trim().slice(0, 24);
    })()
  `)
}

/** 点底部页签（POS 底栏按钮没有 .tab 类，按文字在 nav 里找） */
async function clickBottomTab(text) {
  return evalJs(`
    (() => {
      const t = ${JSON.stringify(text)};
      const nav = document.querySelector('nav');
      if (!nav) return 'no-nav';
      const el = [...nav.querySelectorAll('button')].find((e) => (e.textContent || '').trim() === t);
      if (!el) return 'not-found:' + [...nav.querySelectorAll('button')].map(e=>e.textContent.trim()).join('/');
      el.click();
      return 'clicked:' + t;
    })()
  `)
}

/** 点表格里同时含这些关键字的行 */
async function clickRow(parts, selector = 'table tbody tr') {
  return evalJs(`
    (() => {
      const ks = ${JSON.stringify(parts)};
      const rows = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const hit = rows.find((tr) => { const t = tr.textContent || ''; return ks.every((k) => t.includes(k)); });
      if (!hit) return 'not-found';
      hit.click();
      return 'clicked:' + (hit.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 60);
    })()
  `)
}

/**
 * 点列表行 —— 本项目的班次/盘点列表是 `<button>` 而不是 `<tr>`，
 * 直接按文字点会先命中上方的筛选按钮（「待核款」既是筛选项也是状态徽标），
 * 所以这里要求**同时含全部关键字**，且排除底部导航里的同名页签。
 */
async function clickListRow(parts) {
  return evalJs(`
    (() => {
      const ks = ${JSON.stringify(parts)};
      const pool = [...document.querySelectorAll('button')].filter(b => !b.closest('nav'));
      const hit = pool.find((b) => { const t = b.textContent || ''; return ks.every((k) => t.includes(k)); });
      if (!hit) return 'not-found';
      hit.click();
      return 'clicked:' + (hit.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 70);
    })()
  `)
}

/** 只在弹窗内部点按钮 —— 页面正文有同名按钮时（「核款」既是筛选词也是动作），这是唯一可靠的锚点 */
async function clickInModal(text) {
  return evalJs(`
    (() => {
      const t = ${JSON.stringify(text)};
      const boxes = [...document.querySelectorAll('div.fixed')];
      if (!boxes.length) return 'no-modal';
      const box = boxes[boxes.length - 1];
      const hits = [...box.querySelectorAll('button')].filter((b) => (b.textContent || '').trim().includes(t));
      if (!hits.length) return 'not-found-in-modal';
      hits.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      hits[0].click();
      return 'clicked:' + (hits[0].textContent || '').trim().slice(0, 24);
    })()
  `)
}

/**
 * 设置弹窗里第一个数字输入框的值（React 受控组件）。
 * 直接 `inp.value = x` 不会触发 onChange —— React 拦截了 value 的 setter，
 * 必须用原型上的原生 setter 写入，再手工派发 `input` 事件。
 */
async function setModalNumberInput(value) {
  return evalJs(`
    (() => {
      const boxes = [...document.querySelectorAll('div.fixed')];
      if (!boxes.length) return 'no-modal';
      const box = boxes[boxes.length - 1];
      const inp = box.querySelector('input[type=number]');
      if (!inp) return 'no-number-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(String(value))});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'set:' + inp.value;
    })()
  `)
}

/** 关闭弹窗并**断言它真的不在了** —— 否则会拍出两张一模一样的图 */
async function closeModal() {
  const closed = await evalJs(`
    (() => {
      const boxes = [...document.querySelectorAll('div.fixed')];
      if (!boxes.length) return 'no-modal';
      const box = boxes[boxes.length - 1];
      const btn = box.querySelector('button');
      if (btn) { btn.click(); return 'clicked' }
      return 'no-btn'
    })()
  `)
  await sleep(700)
  const left = await evalJs(`document.querySelectorAll('div.fixed').length`)
  return `${closed}｜剩余弹窗 ${left}`
}

const results = []

// ===========================================================================
// A. 门店端（store01）
// ===========================================================================
await setAuth(STORE)

console.log('→ 门店 POS · 交班核款')
await goto('/pos?tab=shift')
await shot('pos2-01-交班核款')
console.log('  标题：', await evalJs(`([...document.querySelectorAll('h1,h2,div')].filter(e=>e.children.length===0&&e.textContent.trim()==='当前班次').map(e=>e.textContent.trim())[0] || '(无)')`))
console.log('  当期班次：', String(await evalJs(`
  (() => { const t = document.body.innerText; const m = t.match(/PSF\\d+/g); return m ? m.slice(0,3).join(',') : '无班次'; })()
`)))
console.log('  门禁：', String(await evalJs(`
  (() => { const t = document.body.innerText; const m = t.match(/未核款[^\\n]{0,40}|可日结/g); return m ? m.slice(0,2).join(' | ') : '(无提示)'; })()
`)))

console.log('→ 报数交班弹窗（按支付方式逐项报数）')
const b1 = await clickBottomTab('交班核款')
await sleep(300)
const b2 = await clickByText('报数交班')
console.log('  ', b1, '|', b2)
await sleep(1400)
await shot('pos2-02-报数交班')
console.log('  弹窗要素：', await evalJs(
  `(() => { const t = document.body.innerText; return ['支付方式','系统应收','报数金额','差异','待核款'].filter(k=>t.includes(k)).join('/'); })()`
))
await closeModal()

console.log('→ 核款弹窗（三段钱 + 长短款方向）')
// 挑「已报数待核款」的班次（`declared`）——「已核款」的班次里没有「核款」入口，
// 而「营业中」的班次得先报数。测试种子固定造了 PSF…0002 这一班待核款。
const r1 = await clickListRow(['PSF', '待核款'])
console.log('  班次行：', r1)
await sleep(1600)
await shot('pos2-03-班次详情')
console.log('  详情要素：', await evalJs(
  `(() => { const t = document.body.innerText; return ['系统应收（现金）','收银员报数','店长实点','长短款','按支付方式拆分','现金缴款','退回重报'].filter(k=>t.includes(k)).join('/'); })()`
))
const a1 = await clickInModal('核款')
console.log('  ', a1)
await sleep(1400)
// 把实点数改成「系统应收 − 3」，让差异块与归属按钮真的出现。
// 默认值等于系统应收 ⇒ 界面是"现金持平"，拍出来的核款弹窗看不出这个模块在干什么。
// 只改输入框不点确认，所以不会写库。
const setV = await setModalNumberInput(394)
console.log('  填入实点：', setV)
await sleep(900)
await shot('pos2-04-核款')
console.log('  核款要素：', await evalJs(
  `(() => { const b=[...document.querySelectorAll('div.fixed')].pop(); const t=b?b.innerText:''; return ['实点现金','短款','责任人承担','公司承担','归属','差异原因'].filter(k=>t.includes(k)).join('/'); })()`
))
console.log('  差异提示：', await evalJs(
  `(() => { const b=[...document.querySelectorAll('div.fixed')].pop(); const t=b?b.innerText.replace(/\\s+/g,' '):''; const m=t.match(/现金.{0,60}/); return m?m[0]:'(无)'; })()`
))
console.log('  关闭：', await closeModal(), '|', await closeModal())

console.log('→ 缴款')
await goto('/pos?tab=drop')
await shot('pos2-05-缴款')
console.log('  缴款要素：', await evalJs(
  `(() => { const t = document.body.innerText; return ['现金缴款','待缴款','缴款记录','待点收','已点收'].filter(k=>t.includes(k)).join('/'); })()`
))

console.log('→ 门店退货')
await goto('/pos?tab=storeop')
await sleep(600)
await clickByText('门店退货')
await sleep(1200)
// 先加一件商品：退货原因 / 原路退回 / 确认退货 这三个控件只在购物车非空时出现，
// 空车截图只能看到一个商品网格，看不出这是"退货"页。
const addR = await clickByText('焕活新春臻选礼盒')
console.log('  取一件商品：', addR)
await sleep(900)
// 断言购物车真的出来了 —— 商品块点不动时截图会静默退化成"又一个商品网格页"，
// 光看文件名发现不了（已踩过：退货页拍出来和商品页长得一样）。
console.log('  购物车：', await evalJs(
  `(() => { const i=[...document.querySelectorAll('input')].find(e=>e.placeholder==='退货原因'); return i ? '已展开（退货原因/原路退回/确认退货可见）' : '空车 —— 商品块没点上'; })()`
))
await shot('pos2-06-门店退货')
console.log('  退货要素：', await evalJs(
  `(() => { const t = document.body.innerText; return ['门店退货','回门店仓','当前成本价','原路退回','退货记录','确认退货'].filter(k=>t.includes(k)).join('/'); })()`
))

console.log('→ 门店盘点（明细一屏）')
await clickByText('门店盘点')
await sleep(1200)
const rc = await clickListRow(['SC', '行'])
console.log('  盘点行：', rc)
await sleep(1600)
await shot('pos2-07-门店盘点')
console.log('  盘点要素：', await evalJs(
  `(() => { const t = document.body.innerText; return ['账面','实盘','差异','原因','保存实盘数','过账调整库存'].filter(k=>t.includes(k)).join('/'); })()`
))
console.log('  关闭：', await closeModal())

// ===========================================================================
// B. 总部端（admin）
// ===========================================================================
await setAuth(ADMIN)

console.log('→ 总部 · 资金在途看板')
await goto('/store/monitor', { wait: 3600 })
await shot('pos2-08-总部资金在途')
console.log('  看板要素：', await evalJs(
  `(() => { const t = document.body.innerText; return ['门店待缴现金','长短款合计','资金在途','待核款班次','营业中班次','日结门禁','待点收缴款单','挂账待落案'].filter(k=>t.includes(k)).join('/'); })()`
))

console.log('→ 总部 · 日结批次（含现金三段数）')
// 「日结批次」在同一页的下半段。这里**必须**把视口缩回正常高度再滚过去 ——
// 上一张（goto 已把视口撑到整页高）用整页模式再拍一次，拍出来的 md5 与 08 完全相同。
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 2, mobile: false })
await sleep(400)
console.log('  滚动定位：', await scrollTo('日结批次'))
await sleep(900)
await shotViewport('pos2-09-总部日结批次')
console.log('  日结要素：', await evalJs(
  `(() => { const t = document.body.innerText; return ['日结批次','系统现金','报数现金','实点现金','长短款','核款'].filter(k=>t.includes(k)).join('/'); })()`
))

results.push({ consoleErrors, pageErrors })

// ---------- 收尾 ----------
console.log('\n=== 截图查重（同页面两次「整页截图」会拍出逐字节相同的图）===')
const { readdirSync, readFileSync } = await import('node:fs')
const { createHash } = await import('node:crypto')
const md5s = new Map()
let dup = 0
for (const f of readdirSync(OUT).filter((f) => /^pos2-\d\d-.*\.png$/.test(f)).sort()) {
  const h = createHash('md5').update(readFileSync(`${OUT}/${f}`)).digest('hex').slice(0, 12)
  if (md5s.has(h)) { console.log(`  ✗ 重复：${f} 与 ${md5s.get(h)} 完全相同（md5 ${h}）`); dup++ }
  else { md5s.set(h, f); console.log(`  ✓ ${f} ${h}`) }
}
if (dup) { console.log(`\n！有 ${dup} 张截图与别的图逐字节相同，等于少交了几张 —— 必须修脚本`); process.exitCode = 1 }
else console.log(`\n  ${md5s.size} 张，全部互不相同`)

console.log('\n=== 浏览器错误汇总 ===')
console.log('  Runtime 异常:', pageErrors.length ? pageErrors : '0 条')
console.log('  console.error / Log.error:', consoleErrors.length ? consoleErrors : '0 条')

await cdp.send('Browser.close').catch(() => {})
cleanup()
process.exit(0)
