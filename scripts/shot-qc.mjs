/**
 * ============================================================================
 * 文件标识：scripts/shot-qc.mjs ｜ 模块 13 质量中心界面截图（headless Chrome + CDP，零额外依赖）
 * ============================================================================
 * 【职责】模块 13 质量中心界面截图（headless Chrome + CDP，零额外依赖）
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
 * 模块 13 质量中心界面截图（headless Chrome + CDP，零额外依赖）
 *
 * 为什么手写 CDP 客户端：项目里没装 playwright / puppeteer，而 agent-browser 需要
 * 另下几百 MB 的 Chromium。本机已有 Chrome，用它的 --remote-debugging-port 配合
 * Node 22 内置 WebSocket 就够用了（与 shot-costing / shot-invoice 同一套骨架）。
 *
 * 用法：node scripts/shot-qc.mjs [baseUrl] [outDir]
 *   baseUrl 默认 http://127.0.0.1:5173（vite dev，/api 已代理到 3001）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = process.argv[2] || 'http://127.0.0.1:5173'
const OUT = process.argv[3] || '/Users/linxinlan/工作文档/gml/docs/shots'
// 每次用不同端口 + 不同 profile 目录：否则上一轮没死透的 Chrome 会占着端口，
// 探活探到的是旧实例，而它手上那个 page target 早已随 Browser.close 失效。
const PORT = 9400 + Math.floor(Math.random() * 90)
const PROFILE = `/tmp/gml-shot-profile-${PORT}`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const API = 'http://127.0.0.1:3001'

mkdirSync(OUT, { recursive: true })

// ---------- 1. 先拿一枚管理员 token（截图要落在已登录态） ----------
const loginRes = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: '12345' })
})
const login = await loginRes.json()
if (!login?.data?.token) {
  console.error('登录失败，无法继续：', JSON.stringify(login).slice(0, 200))
  process.exit(1)
}
const TOKEN = login.data.token
const USER = JSON.stringify(login.data.user || { username: 'admin' })

// ---------- 2. 起 Chrome ----------
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  // Chrome 155 起：不加这几个开关，渲染进程会直接 targetCrashed（表现是所有 CDP 命令超时）
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-software-rasterizer',
  '--disable-gpu',
  '--hide-scrollbars',
  // 本机开着系统代理，headless Chrome 会跟着走代理去访问 127.0.0.1 → ERR_CONNECTION_*
  '--no-proxy-server',
  '--proxy-bypass-list=*',
  // Chrome 新版会校验 DevTools WebSocket 的 Origin，来源不明直接不回帧（表现为所有命令超时）
  '--remote-allow-origins=*',
  '--window-size=1600,1200',
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

// ---------- 3. 极简 CDP 客户端 ----------
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
    // 首帧偶尔会被 Chrome 吞掉（Node 内置 WebSocket 的已知毛病）：6 秒没回就补一帧激活再重发
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
      // ⚠️ 必须在 open 事件里**同步**送出第一帧：Node 内置 WebSocket 若把首次 send 推到
      // open 事件之外（哪怕只隔一个 microtask），帧发得出去但 Chrome 一条响应都不回。
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
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1600, height: 1200, deviceScaleFactor: 2, mobile: false
})

await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    try {
      localStorage.setItem('gml_token', ${JSON.stringify(TOKEN)});
      localStorage.setItem('gml_user', ${JSON.stringify(USER)});
      if (!localStorage.getItem('gml_industry')) localStorage.setItem('gml_industry', 'cosmetic');
    } catch (e) { /* about:blank 等无 storage 权限的文档，静默跳过 */ }
  `
})

async function goto(path, { wait = 3200, fullPage = true } = {}) {
  await cdp.send('Page.navigate', { url: `${BASE}${path}` })
  await sleep(wait)
  if (fullPage) {
    try {
      const m = await cdp.send('Page.getLayoutMetrics')
      const h = Math.min(Math.ceil(m.cssContentSize?.height || 1200), 6000)
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1600, height: h, deviceScaleFactor: 2, mobile: false
      })
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

const evalJs = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
  return r.result?.value
}

/** 点页签：本项目 Tabs 是 div.tab，必须只在这个集合里找 —— 否则会先命中正文里的描述文案 */
async function clickTab(text) {
  return evalJs(`
    (() => {
      const t = ${JSON.stringify(text)};
      const el = [...document.querySelectorAll('.tab')].find((e) => (e.textContent || '').includes(t));
      if (!el) return 'not-found';
      el.click();
      return 'clicked:' + (el.textContent || '').trim().slice(0, 20);
    })()
  `)
}

/** 按文字点最内层的可点元素（React 页面没有稳定 id，文字是最稳的锚点）
 *  注意 selector 默认含 .tab：点「报检」时页签「待检与报检」也含这两个字，
 *  会先把页签点一遍 —— 需要精确到按钮的场景请显式传 'button'。 */
async function clickByText(text, selector = 'button, a, [role=tab], [role=button], .tab, .cursor-pointer') {
  return evalJs(`
    (() => {
      const t = ${JSON.stringify(text)};
      const pool = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const hits = pool.filter((e) => (e.textContent || '').trim().includes(t));
      if (!hits.length) return 'not-found';
      hits.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      hits[0].click();
      return 'clicked:' + (hits[0].textContent || '').trim().slice(0, 24);
    })()
  `)
}

/** 点「同时含这些关键字」的那一行 —— 用行内容当锚点比序号稳（列表是按 id 倒序的） */
async function clickRow(parts) {
  return evalJs(`
    (() => {
      const ks = ${JSON.stringify(parts)};
      const rows = [...document.querySelectorAll('table tbody tr')];
      const hit = rows.find((tr) => {
        const t = tr.textContent || '';
        return ks.every((k) => t.includes(k));
      });
      if (!hit) return 'not-found';
      hit.click();
      return 'clicked:' + (hit.textContent || '').trim().slice(0, 40);
    })()
  `)
}

const results = []

// ---------- 4. 截图序列 ----------
console.log('→ 质量中心 · 总览')
await goto('/quality/qc')
await shot('qc-01-总览')
console.log('  标题：', await evalJs(`([...document.querySelectorAll('h1,h2')].map(e=>e.textContent.trim()).slice(0,3).join(' | '))`))
console.log('  指标卡：', JSON.stringify(await evalJs(
  `([...document.querySelectorAll('*')].filter(e=>e.children.length===0&&/待检|待出结论|不良率|让步接收|退货|报废/.test(e.textContent||'')).slice(0,14).map(e=>e.textContent.trim()))`
)).slice(0, 400))

console.log('→ 待检与报检：待检来源 + 报检单台账')
const c1 = await clickTab('待检与报检')
console.log('  ', c1)
await sleep(2000)
await shot('qc-02-待检与报检')

console.log('→ 新建报检单：报检数量由抽样方案（n/Ac/Re）推出')
const b1 = await clickByText('报检', 'button.btn-primary')
console.log('  ', b1)
await sleep(2200)
await shot('qc-03-新建报检单')
console.log('  抽样方案提示：', await evalJs(
  `(() => { const t = document.body.innerText; return (t.match(/抽样[^\\n]{0,60}/g)||[]).slice(0,3).join(' ｜ '); })()`
))
const bClose = await clickByText('取消')
console.log('  ', bClose)
await sleep(800)

console.log('→ 检验台账')
const c2 = await clickTab('检验')
console.log('  ', c2)
await sleep(2200)
await shot('qc-04-检验台账')
console.log('  台账文本：', String(await evalJs(`([...document.querySelectorAll('table tbody tr')].slice(0,3).map(tr=>tr.innerText.replace(/\\n/g,' | ')).join('  ///  '))`)).slice(0, 500))

console.log('→ 检验明细（待检单：界面不提供判定下拉框，判定随不良数实时推出）')
const r1 = await clickRow(['QCI', '待检'])
console.log('  ', r1)
await sleep(2400)
await shot('qc-05-检验明细-待检')
console.log('  弹窗要素：', await evalJs(
  `(() => { const t = document.body.innerText; return ['抽样 n','Ac','Re','实测不良数','判定','提交检验结论'].filter(k=>t.includes(k)).join('/'); })()`
))
const r1close = await clickByText('关闭')
console.log('  ', r1close)
await sleep(800)

console.log('→ 不合格单：填不良数 → 提交结论 → 开处置单（一屏完成）')
// 挑「已检」而不是「已关闭」的：已关闭的单子处置已经走完，看不到「生成处置单」这个入口
const r2 = await clickRow(['QCI', '不合格', '已检'])
console.log('  ', r2)
await sleep(2400)
await shot('qc-06-检验明细-不合格')
console.log('  处置入口：', await evalJs(
  `(() => { const t = document.body.innerText; return ['不良品处理','生成处置单','已处置','不动库存','出库'].filter(k=>t.includes(k)).join('/'); })()`
))
const r2close = await clickByText('关闭')
console.log('  ', r2close)
await sleep(800)

console.log('→ 不良品处理台账')
const c3 = await clickTab('不良品处理')
console.log('  ', c3)
await sleep(2200)
await shot('qc-07-不良品处理')

results.push({ consoleErrors, pageErrors })

// ---------- 5. 收尾 ----------
console.log('\n=== 浏览器错误汇总 ===')
console.log('  Runtime 异常:', pageErrors.length ? pageErrors : '0 条')
console.log('  console.error / Log.error:', consoleErrors.length ? consoleErrors : '0 条')

await cdp.send('Browser.close').catch(() => {})
cleanup()
process.exit(0)
