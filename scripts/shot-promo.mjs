/**
 * ============================================================================
 * 文件标识：scripts/shot-promo.mjs ｜ 模块 18 营销中心（促销 / 券 / 会员 / 试算器）界面截图
 * ============================================================================
 * 【职责】模块 18 营销中心（促销 / 券 / 会员 / 试算器）界面截图
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
 * 模块 18 营销中心（促销 / 券 / 会员 / 试算器）界面截图
 * headless Chrome + CDP，零额外依赖（与 shot-qc / shot-invoice / shot-pos2 同一套骨架）。
 *
 * 用法：node scripts/shot-promo.mjs [baseUrl] [outDir]
 *   baseUrl 默认 http://127.0.0.1:5173（vite dev，/api 已代理到 3001）
 *
 * 本页是**六个页签的单页应用**，所以脚本的核心不是"换路由"而是"点页签 + 断言页签真的切了"。
 * 三条硬约束（都是本项目踩过的坑）：
 *   ① 点页签用 `.tab` 精确匹配**开头**：页签文案后面挂着数量徽标（如「促销10」），
 *      全等匹配永远点不中。
 *   ② 弹窗开着时点页签会被遮罩挡住 —— 必须先确认弹窗真的关了再切页签，
 *      否则会拍出两张完全相同的图（已踩过：qc-06 与 qc-07 逐字节相同）。
 *   ③ React 受控 `<select>` / `<input type=checkbox>` 不能直接改 `.value`（改了会被下一次
 *      render 冲回），必须走原型上的原生 setter + 派发 change 事件。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = process.argv[2] || 'http://127.0.0.1:5173'
const OUT = process.argv[3] || '/Users/linxinlan/工作文档/gml/docs/shots'
const PORT = 9300 + Math.floor(Math.random() * 90)
const PROFILE = `/tmp/gml-shot-promo-${PORT}`
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

const ADMIN = await login('admin', '12345')
console.log(`登录成功：${ADMIN.user?.name}`)

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

const authScript = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    try {
      localStorage.setItem('gml_token', ${JSON.stringify(ADMIN.token)});
      localStorage.setItem('gml_user', ${JSON.stringify(JSON.stringify(ADMIN.user))});
      localStorage.setItem('gml_industry', 'cosmetic');
    } catch (e) {}
  `
})
if (!authScript?.identifier) console.log('  提示：登录态注入脚本没拿到 identifier（继续，可能要人工确认登录页）')

const evalJs = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.value
}

async function goto(path, { wait = 3200, fullPage = true } = {}) {
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
 * 只拍当前视口。整页模式下连拍两次会得到逐字节相同的图（本项目已踩过）。
 * 需要"同页面下半段"时：先把视口缩回 1100，滚到位，再用这个函数。
 */
async function shotViewport(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = `${OUT}/${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('  截图 →', file)
  return file
}

const bodyText = () => evalJs('document.body.innerText')
const has = async (...keys) => {
  const t = await bodyText()
  return keys.filter((k) => t.includes(k))
}

/** 点页签：`.tab` 文案**以给定文字开头**（后面挂着数量徽标，全等匹配点不中） */
async function clickTab(text) {
  return evalJs(`
    (() => {
      const t = ${JSON.stringify(text)};
      const tabs = [...document.querySelectorAll('.tab')];
      const el = tabs.find((e) => (e.textContent || '').trim().startsWith(t));
      if (!el) return 'not-found: ' + tabs.map(e => e.textContent.trim()).join(' | ');
      el.click();
      return 'clicked:' + el.textContent.trim().slice(0, 24);
    })()
  `)
}

/**
 * 点按钮：**归一化空白后**精确匹配优先，其次包含匹配；取「DOM 最小的那个」
 * （避免点到包着它的大容器）。
 *
 * 为什么要归一化：JSX 里 `<Calculator size={14} /> 试算` 渲染出的 textContent 是
 * `"试算"` 前后带空白的字符串，`trim()` 只去首尾、去不掉中间的换行/多空格 ——
 * 于是「试算」的精确匹配永远落空，contains 匹配就会命中最小的"包含它"的按钮
 * （实测命中了旁边的「试算 + 解释链」），两个按钮点成同一个，拍出来的图看着对、
 * 其实那一张图是另一条路径。这类"点错按钮但没报错"是最难发现的一类。
 */
async function clickByText(text, selector = 'button, a, [role=button]') {
  return evalJs(`
    (() => {
      const t = ${JSON.stringify(text)};
      const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const small = (arr) => arr.slice().sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
      const pool = [...document.querySelectorAll(${JSON.stringify(selector)})];
      // 两组分开选，**不能合并后再排序**：合并后"DOM 最小"会把没有图标的
      // 「试算 + 解释链」顶到最前，压过带图标的「试算」—— 精确匹配形同虚设，
      // 两个按钮点成同一个，而且不报错（实测踩到）。
      const exact = pool.filter((e) => norm(e.textContent) === t);
      const hit = exact.length ? small(exact) : small(pool.filter((e) => norm(e.textContent).includes(t)));
      if (!hit) return 'not-found';
      hit.click();
      return 'clicked:' + norm(hit.textContent).slice(0, 24);
    })()
  `)
}

/** 点表格行（Table 组件把 onRowClick 挂在 <tr> 上） */
async function clickRow(parts, nth = 0) {
  return evalJs(`
    (() => {
      const ks = ${JSON.stringify(parts)};
      const rows = [...document.querySelectorAll('table tbody tr')];
      const hits = rows.filter((tr) => { const t = tr.textContent || ''; return ks.every((k) => t.includes(k)); });
      if (!hits.length) return 'not-found: 共 ' + rows.length + ' 行';
      const hit = hits[Math.min(${nth}, hits.length - 1)];
      hit.click();
      return 'clicked:' + (hit.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 60);
    })()
  `)
}

/** 弹窗是否真的在 */
const modalOpen = () => evalJs(`
  (() => {
    const b = [...document.querySelectorAll('button')].find(e => (e.textContent||'').trim() === '×');
    return !!b && !!b.closest('.fixed.inset-0');
  })()
`)

/** 关弹窗并**断言真的关了**（不查会让下一张图与上一张逐字节相同） */
async function closeModal() {
  const r = await evalJs(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(e => (e.textContent||'').trim() === '×');
      if (!b) return 'no-close-button';
      b.click();
      return 'clicked';
    })()
  `)
  await sleep(600)
  const still = await modalOpen()
  return r + (still ? '（关不掉！）' : '，已关闭')
}

/**
 * 按 `<label>` 内的文字定位受控控件。
 * **不要用 `querySelectorAll('input')[i]` 这种位置索引** —— 页面结构一变索引就指到别处，
 * 值会静默落到错误字段上（实测：本想填「使用积分」，结果填进了「搜索商品」，
 * 截图里积分抵扣一段永远是 0，而脚本一行报错都没有）。
 */
const setByLabel = (labelText, value) => evalJs(`
  (() => {
    const l = [...document.querySelectorAll('label')].find(e => (e.textContent||'').includes(${JSON.stringify(labelText)}));
    if (!l) return 'not-found-label';
    const el = l.querySelector('input, select, textarea');
    if (!el) return 'not-found-control';
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'set:' + el.tagName + '=' + el.value;
  })()
`)

/** 购物车行里的数量框：同行必有 <select>（位置索引不可靠，用结构特征认它） */
const setQty = (value) => evalJs(`
  (() => {
    const el = [...document.querySelectorAll('input[type=number]')].find(e => e.parentElement?.querySelector('select'));
    if (!el) return 'not-found';
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'set:qty=' + el.value;
  })()
`)

const results = []

// ===========================================================================
// A. 总览
// ===========================================================================
console.log('\n→ 总览')
await goto('/marketing/promo', { wait: 3800 })
console.log('  页面要素：', await has('营销中心', '会员等级分布', '自洽审计', '促销活动', '券发行量', '促销累计优惠'))
console.log('  审计结论：', await evalJs(`(() => { const t=document.body.innerText; const m=t.match(/全部通过|发现异常/); return m?m[0]:'未找到'; })()`))
await shot('promo-01-总览')

// ===========================================================================
// B. 活动
// ===========================================================================
console.log('\n→ 活动')
console.log('  ', await clickTab('活动'))
await sleep(1200)
console.log('  要素：', await has('新建活动', '活动名称', '累计优惠'))
await shot('promo-02-活动')

// ===========================================================================
// C. 促销列表 + 详情
// ===========================================================================
console.log('\n→ 促销列表')
console.log('  ', await clickTab('促销'))
await sleep(1400)
console.log('  要素：', await has('新建促销', '优惠方式', '自动', '独占'))
await shot('promo-03-促销列表')

console.log('\n→ 促销详情（弹窗）')
console.log('  ', await clickRow(['自动']))
await sleep(1300)
console.log('  弹窗：', await modalOpen())
console.log('  要素：', await has('促销详情', '优惠方式', '适用条件', '使用汇总', '减免率'))
await shot('promo-04-促销详情')
console.log('  关闭：', await closeModal())

// ===========================================================================
// D. 券模板 / 券实例
// ===========================================================================
console.log('\n→ 券模板')
console.log('  ', await clickTab('券'))
await sleep(1500)
console.log('  要素：', await has('券模板', '券实例（券包）', '绑定促销', '到期落库'))
await shot('promo-05-券模板')

console.log('\n→ 券实例（券包）')
console.log('  ', await clickTab('券实例'))
await sleep(1400)
console.log('  要素：', await has('券码', '持有人', '核销时间'))
await shot('promo-06-券实例')

// ===========================================================================
// E. 会员列表 + 详情（含流水 balance_after）
// ===========================================================================
console.log('\n→ 会员列表')
console.log('  ', await clickTab('会员'))
await sleep(1600)
console.log('  要素：', await has('等级权益', '可用积分', '储值余额', '累计消费'))
await shot('promo-07-会员列表')

console.log('\n→ 会员详情（弹窗）')
console.log('  ', await clickRow([]))
await sleep(1500)
console.log('  弹窗：', await modalOpen())
console.log('  要素：', await has('会员详情', '距下一级', '积分调整', '储值', '人工指定等级'))
await shot('promo-08-会员详情')

console.log('\n→ 会员流水（balance_after 逐行）')
console.log('  ', await clickTab('积分 / 储值流水'))
await sleep(1500)
console.log('  要素：', await has('积分流水', '储值流水', '变动后余额', '余额不是真相'))
await shot('promo-09-会员流水')
console.log('  关闭：', await closeModal())

// ===========================================================================
// F. 试算器（四段拆 + 行级优惠 + 命中链）
// ===========================================================================
console.log('\n→ 试算器')
console.log('  ', await clickTab('试算器'))
await sleep(1400)

// 挑一个**名下有未使用券**的客户：普通试算演示不出"显式勾券"这条口径，
// 而"券默认不自动使用"正是本模块最想让人看见的一条。
const AUTH = { Authorization: `Bearer ${ADMIN.token}`, 'x-industry': 'cosmetic' }
const members = await (await fetch(`${API}/api/promo/members?pageSize=50`, { headers: AUTH })).json()
const memList = members?.data?.list || []
const withCoupon = memList.find((m) => Number(m.coupon_unused) > 0) || memList[0]
console.log(`  选中客户：${withCoupon?.phone} · ${withCoupon?.name || ''} · ${withCoupon?.level_name} · 未用券 ${withCoupon?.coupon_unused ?? 0} 张`)
console.log('  选客户：', await evalJs(`
  (() => {
    const s = [...document.querySelectorAll('select')].find(e => (e.options?.[0]?.textContent||'').includes('散客'));
    if (!s) return 'not-found';
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(s, ${JSON.stringify(String(withCoupon?.customer_id ?? ''))});
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'set:' + s.value;
  })()
`))
await sleep(500)

// 挑 SKU 与数量：购物车金额必须落在 **[券促销门槛, 独占促销门槛)** 这个窗口里。
// 为什么不能随便挑个数量：seed 里那张 `AUTO_EXCLUSIVE` 是**独占**促销且优先级最高，
// 只要它的金额门槛也满足，就会把包括券解锁的那张在内的所有活动全部拦掉 ——
// 截图于是只能证明"券码被接受"，证明不了"券真的减了钱"，
// 页面上还会出现"券被接受但未生效"看着像 bug 的组合。
// 门槛从接口读、不写死：seed 一改数量，写死的值就静默失效。
const promoDetail = async (code) => {
  const l = await (await fetch(`${API}/api/promo/promotions?keyword=${encodeURIComponent(code)}`, { headers: AUTH })).json()
  const hit = (l?.data?.list || []).find((x) => x.code === code)
  if (!hit) return null
  return (await (await fetch(`${API}/api/promo/promotions/${hit.id}`, { headers: AUTH })).json()).data
}
const ruleMinCents = (d) => {
  const r = (d?.rules?.rules || []).find((x) => x.attribute === 'subtotal')
  return r ? Number(r.value) : 0
}
const couponPromo = await promoDetail('COUPON_FULL')
const exclPromo = await promoDetail('AUTO_EXCLUSIVE')
const floorCents = ruleMinCents(couponPromo)
const capCents = exclPromo?.is_exclusive ? (ruleMinCents(exclPromo) || Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
console.log(`  窗口：[券门槛 ¥${(floorCents / 100).toFixed(0)}, 独占门槛 ¥${(capCents / 100).toFixed(0)})`)
const target = Math.min(capCents - 1, Math.round(floorCents * 1.2))

const skus = await (await fetch(`${API}/api/master/skus?limit=500`, { headers: AUTH })).json()
const priced = (skus?.data || []).filter((s) => Number(s.price_retail) > 0)
const cand = priced
  .filter((s) => Math.round(Number(s.price_retail) * 100) <= Math.max(target, floorCents))
  .sort((a, b) => Number(b.price_retail) - Number(a.price_retail))
const sku = cand[0] || priced.slice().sort((a, b) => Number(b.price_retail) - Number(a.price_retail))[0]
const priceCents = Math.round(Number(sku?.price_retail || 0) * 100)
let qty = Math.max(1, Math.ceil(Math.max(target, floorCents) / (priceCents || 1)))
if (priceCents * qty >= capCents) qty = Math.max(1, Math.floor((capCents - 1) / priceCents))
console.log(`  选中 SKU：${sku?.sku_code} · ${sku?.name} · ¥${sku?.price_retail} × ${qty} = ¥${((priceCents * qty) / 100).toFixed(2)}` +
  (priceCents * qty < floorCents ? '  ⚠ 未达券门槛，券不会生效' : ''))
console.log('  选 SKU：', await evalJs(`
  (() => {
    const s = [...document.querySelectorAll('select')].find(e => (e.options?.[0]?.textContent||'').trim() === '选择 SKU');
    if (!s) return 'not-found';
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(s, ${JSON.stringify(String(sku?.id ?? ''))});
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'set:' + s.value;
  })()
`))
await sleep(400)
console.log('  数量：', await setQty(String(qty)))
await sleep(300)

console.log('  第一次试算：', await clickByText('试算', 'button'))
await sleep(1800)
console.log('  四段：', await has('算钱顺序（四段）', '商品原价合计', '会员折扣', '促销优惠', '积分抵扣', '应付金额'))

// 券：**显式勾选第一张可用券** —— 这一勾就是"券默认不自动使用"那条口径的正向演示
const usable = await evalJs(`
  (() => {
    const boxes = [...document.querySelectorAll('input[type=checkbox]')].filter(e => !e.disabled);
    const coupon = boxes.find(e => (e.closest('label')?.textContent || '').includes('门槛'));
    if (coupon) { coupon.click(); return 'picked:' + coupon.closest('label').textContent.replace(/\\s+/g,' ').trim().slice(0,40); }
    return 'none-usable';
  })()
`)
console.log('  勾选券：', usable)

// 积分：上限从界面提示里读回来（写死一个数可能超上限被服务端拒，toast 一报错整段就废了）
const maxPts = await evalJs(`
  (() => { const m = document.body.innerText.match(/本单最多可抵\\s*([\\d,]+)\\s*分/); return m ? Number(m[1].replace(/,/g,'')) : 0; })()
`)
const usePts = maxPts > 0 ? Math.max(100, Math.min(maxPts, 800)) : 0
console.log(`  可用积分上限 ${maxPts}，本次使用 ${usePts}`)
if (usePts > 0) console.log('  填积分：', await setByLabel('使用积分', String(usePts)))
await sleep(400)

console.log('  试算 + 解释链：', await clickByText('试算 + 解释链', 'button'))
await sleep(2200)
console.log('  结果要素：', await has('算钱顺序（四段）', '行级优惠（三段）', '促销命中链', '券的参与情况', '解释链（人话版）'))
console.log('  行应付是否平：', await evalJs(`
  (() => { const t = document.body.innerText; return t.includes('✓ 平') ? '✓ 平' : (t.includes('✗ 不平') ? '✗ 不平' : '未找到'); })()
`))
// 四段里"积分抵扣"是不是真的非零 —— 非零才证明这一段被演示到了。
// 按卡片取，不要按"标签 + 换行 + 数字"去正则：AmountRow 里 label 与金额是同一个 flex 行，
// innerText 的分隔符不稳定，正则一改就静默取不到（返回一堆 '?'，看着像页面坏了）。
console.log('  四段金额序列：', await evalJs(`
  (() => {
    const h = [...document.querySelectorAll('h2')].find(e => (e.textContent||'').includes('算钱顺序'));
    const card = h && h.closest('.card');
    if (!card) return 'not-found';
    return (card.innerText.match(/-?¥[\\d,]+\\.\\d{2}/g) || []).join(' | ');
  })()
`))
console.log('  券是否真的减了钱：', await evalJs(`
  (() => {
    const t = document.body.innerText;
    const live = t.match(/✅[^\\n]*券码被接受，对应促销已生效/);
    const pending = t.match(/⏳[^\\n]*未生效/);
    if (live) return '已生效 → ' + live[0].trim().slice(0, 60);
    if (pending) return '被接受但促销未生效 → ' + pending[0].trim().slice(0, 60);
    const none = t.match(/本单没有券码被接受/);
    return none ? '没有券码被接受' : '未找到券的参与情况区块';
  })()
`))
console.log('  命中链：', await evalJs(`
  (() => { const t = document.body.innerText; const m = t.match(/✅[^\\n]*/g) || []; const n = (t.match(/⏭️/g) || []).length; return '生效 ' + m.length + ' 条 / 未生效 ' + n + ' 条'; })()
`))

// 结果区在右栏，整页截图即可（左栏输入 + 右栏结果都在一张图里）
await shot('promo-10-试算器结果')

results.push({ consoleErrors, pageErrors })

// ---------- 收尾 ----------
console.log('\n=== 截图查重（同页面连拍两次会拍出逐字节相同的图）===')
const { readdirSync, readFileSync } = await import('node:fs')
const { createHash } = await import('node:crypto')
const md5s = new Map()
let dup = 0
for (const f of readdirSync(OUT).filter((f) => /^promo-\d\d-.*\.png$/.test(f)).sort()) {
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
process.exit(process.exitCode || 0)
