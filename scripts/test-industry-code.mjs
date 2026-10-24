#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/test-industry-code.mjs ｜ 测试：行业码判据**常驻守卫**：缺失 ⇒ 默认库；非法 ⇒ 拒绝（绝不静默落到某个库）。
 * ============================================================================
 * 【职责】测试：行业码判据**常驻守卫**：缺失 ⇒ 默认库；非法 ⇒ 拒绝（绝不静默落到某个库）。
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
 * 行业码判据**常驻守卫**：缺失 ⇒ 默认库；非法 ⇒ 拒绝（绝不静默落到某个库）。
 *
 * 为什么必须常驻（不能只留一份一次性的反例脚本）：
 *   `server/db/index.js` 的行业归一化是**全站的库选择器** —— `x-industry` 头、登录体、
 *   令牌载荷、MCP 令牌行四处外部可控值最终都汇到它。它一旦被改回"非法 ⇒ 归 cosmetic"，
 *   表现是"一个打错的行业码安静地读到美妆版的库"：**不报错、界面照常出数**，
 *   跨租户串库看起来完全正常 —— 是最难在验收现场发现的一类错。
 *   一次性脚本跑完就没了，下次谁动了归一化没有东西会响，所以钉在这里。
 *
 * 判据**不看状态码本身，看读到了哪个库**：
 *   `/api/meta/health` 是公开端点，返回当前库的 `products` 计数；
 *   三库计数两两不同（哨兵），所以"返回哪个计数"就等于"读的哪个库"。
 *   只看 400 是弱判据 —— 它证明不了"没落到 cosmetic 的库"。
 *
 * 已知边界（照实写在守卫里，免得被当成漏测）：
 *   `x-industry: 'cosmetic '`（**尾随空格**）到达应用前已被 **Node HTTP 解析器**按 OWS
 *   剥离成 `'cosmetic'`（RFC 7230），应用**看不到**差别 —— 那是传输层归一，不是本项目的归一。
 *   所以头路径的"空白变体"用**内部空格** `'cos metic'`（不会被剥离）；
 *   "夹空格不被静默归一"由**登录体**与**令牌载荷**（JSON/JWT 里空白原样保留）守着。
 *
 * ── 判据面（**"值类型"是其中一整类**，别只测字符串）─────────────────────────────
 * 行业码是**外部可控值**，它**不一定是字符串**：JSON 体里可以是 `{}` / `[]` / 数字 / 布尔 /
 * `{"toString":null}`，令牌载荷同理。**"我测了 12 类输入"不等于"我测了所有值类型"** ——
 * 本项目第二次红队就是靠"非字符串"这一整类抓到两条：`{toString:null}` 让 `String(value)`
 * 在**构造错误时**又抛（⇒ 500 且**无业务码**）+ 任何**未知异常**被当成"令牌无效"吞掉
 * （⇒ **200 回落默认库**）。所以值类型单列成 §⑧（单测 + HTTP + 令牌三级）与 §⑨（fail-closed 判据），
 * 逐型覆盖：字符串 / 数字 / 布尔 / `null`（=缺失）/ `undefined`（=缺失）/ `{}` / `[]` /
 * `{toString:null}` / `Object.create(null)` / `toString`-或-`valueOf`-抛错的对象 / 嵌套对象 / 函数。
 *
 * ── 落点自证闸门 ──────────────────────────────────────────────────────────────
 * 本脚本在 `:pin` 处钉了 `process.env.GML_DATA_DIR = DIR`，**并且**在 `import db/index.js` 之后
 * **从模块导出里取它实际解析出的 `DATA_DIR`** 来验"钉的真的生效"（**不自己再算一遍** ——
 * 报告与实际必须同源），不在 `/tmp/` 下就 `exit 2` 拒跑。这条闸门的价值：把"钉了没效也看不出来"
 * 变成一个**会说话的红**（本项目已在 `test-kernel-migrate.mjs` 上被它咬过一次）。
 *
 * 隔离纪律（照 `test-kernel-migrate.mjs` 的形状，它的注释是这条规矩的唯一出处）：
 *   · 未设 `GML_DATA_DIR` ⇒ **自落**到 /tmp/gml-kernel-<本脚本名>（所以 regress-all 能自动
 *     发现它、且不碰仓库 data/ —— regress-all **不设任何 env**，写"未设 ⇒ exit 2"会把回归自己拦住）；
 *   · 指向仓库 `data/` 或任何非 `/tmp` 路径 ⇒ 当场 `exit 2` 拒跑；
 *   · 只**只读**地从仓库 data/ 备份到隔离目录，绝不写 data/。
 *
 * 回收子进程的逻辑**照抄 `test-guards.mjs`**（那是唯一出处，别自己再写一版）：
 *   等 `exit` 事件再下结论、SIGKILL 后 50ms 轮询上限 1.5s、`exit` 钩子只发信号不下结论。
 *
 * ⚠️ `ok()` 的实参顺序是 **(cond, msg, detail)** —— 条件在**第一位**。
 *   写反（条件位收到一个非空字符串）会让断言**恒真**，且形状守卫只查形参名、查不出调用点错位
 *   （本文件初稿就踩过这一步，靠"打印出来的是 true 而不是断言名"才发现）。别把顺序调换。
 *
 * 用法：node scripts/test-industry-code.mjs
 *   （无参数；行业上下文由脚本内部覆盖三库，不分行业跑）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DATA = path.join(ROOT, 'data')
const PORT = Number(process.env.IC_PORT || 44533)
const BASE = `http://127.0.0.1:${PORT}`
const INDUSTRY_CODES = ['cosmetic', 'food', 'apparel']

// ---------------------------------------------------------------------------
// 参数自证：不认识的参数**拒**（与 check-inv-txn-dict / test-guards 同族）。
// 注意：这里刻意**不读** `process.argv` 的第二个元素 —— regress-all 用"源码里有没有它"
// 判定是不是"×三库"脚本；本脚本自覆盖三库，必须被判为单库。
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
if (argv.length) {
  console.error(`✗ 未知参数：${argv.join(' ')}\n`)
  console.error('用法：node scripts/test-industry-code.mjs   （本脚本自覆盖三库，无参数）')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 隔离目录（形状照 test-kernel-migrate.mjs 的 requireIsolatedDataDir）
// ---------------------------------------------------------------------------
function requireIsolatedDataDir() {
  const name = path.basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, '')
  const raw = process.env.GML_DATA_DIR || ''
  const abs = raw ? path.resolve(raw) : path.join('/tmp', `gml-kernel-${name}`)
  if (abs === REPO_DATA || abs.startsWith(REPO_DATA + path.sep)) {
    console.error(`✗ 拒绝运行：隔离目录指向仓库 data/（${abs}）。本脚本只允许在 /tmp 下的副本上跑。`)
    process.exit(2)
  }
  if (!abs.startsWith('/tmp/')) {
    console.error(`✗ 拒绝运行：隔离目录必须在 /tmp 下（实得 ${abs}）；不设 GML_DATA_DIR 时会自落到 /tmp/gml-kernel-${name}。`)
    process.exit(2)
  }
  fs.mkdirSync(abs, { recursive: true })
  console.log(`${raw ? 'GML_DATA_DIR' : '未设 GML_DATA_DIR ⇒ 自落'} 隔离库目录：${abs}（仓库 data/ 不会被写）`)
  return abs
}
const DIR = requireIsolatedDataDir()
// 让**进程内**随后的 import（db/index.js、tokens.js…）也落到隔离目录 —— 否则未设 env 时
// 它们会解析到仓库 data/，本脚本进程内的 getDbFor 就会去写 data/（纪律最硬的一条）。
process.env.GML_DATA_DIR = DIR
console.log(`隔离库目录：${DIR}   端口：${PORT}`)

// ---------------------------------------------------------------------------
// 从仓库 data/ **只读**备份三个库到隔离目录（不写 data/）
// ---------------------------------------------------------------------------
const Database = (await import('better-sqlite3')).default
for (const c of INDUSTRY_CODES) {
  const src = new Database(path.join(REPO_DATA, `gml_${c}.db`), { readonly: true })
  const dst = path.join(DIR, `gml_${c}.db`)
  for (const ext of ['', '-wal', '-shm']) {
    const p = dst + ext
    if (fs.existsSync(p)) fs.rmSync(p)
  }
  await src.backup(dst)
  src.close()
}

// ---------------------------------------------------------------------------
// 起服务（显式 GML_DATA_DIR + 显式 PORT）
// ---------------------------------------------------------------------------
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, GML_DATA_DIR: DIR, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
srv.stdout.on('data', (d) => {
  log += d.toString()
})
srv.stderr.on('data', (d) => {
  log += d.toString()
})

// ---------------------------------------------------------------------------
// 回收子进程 —— **照抄 test-guards.mjs**（唯一出处）
//   ① `srv.kill()` 只表示信号发出去了，不等于进程真的没了；
//   ② 所以等 `exit` 事件再下结论；③ 结论只在轮询结束后下；
//   ④ `exit` 钩子**只发信号、不打字不下结论**（否则同一件事被说两遍、还说错一遍）。
// ---------------------------------------------------------------------------
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
async function reclaim(timeoutMs = 1500) {
  if (srv.exitCode !== null || srv.signalCode !== null) return true
  try {
    srv.kill('SIGKILL')
  } catch {
    /* 已经没了 */
  }
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (!pidAlive(srv.pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !pidAlive(srv.pid)
}
async function reclaimAndExit(code) {
  const gone = await reclaim()
  console.log(gone ? `[回收] 已回收 pid ${srv.pid}` : `[回收] 回收失败，pid ${srv.pid} 仍在`)
  process.exit(code)
}
process.on('SIGINT', () => reclaimAndExit(130))
process.on('uncaughtException', (e) => {
  console.error(e)
  reclaimAndExit(1)
})
process.on('exit', () => {
  try {
    if (srv.exitCode === null && srv.signalCode === null) srv.kill('SIGKILL')
  } catch {
    /* ignore */
  }
})

let pass = 0
let fail = 0
const failures = []
// 形参名与项目主流形状对齐（cond,msg,detail）—— 守卫按形参名判形状，别缩写。
// ⚠️ 调用点必须 (cond, msg, detail)，条件在第一位；写反 ⇒ 恒真（见文件头）。
const ok = (cond, msg, detail) => {
  if (cond) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    failures.push(msg)
    console.log(`  ✗ ${msg}${detail ? '  → ' + detail : ''}`)
  }
}

const api = async (method, p, { headers = {}, body } = {}) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, body: json, raw: text }
}

// 健康端点：ADR-0029 起 `database.products` 只对管理员返回，所以哨兵读取带上对应库 admin 的令牌
// （行业头非法/缺省时用 cosmetic 库的令牌；行业判定本身仍由头部决定）。
let healthTokens = null
const health = (headerIndustry) => {
  const code = headerIndustry && healthTokens && healthTokens[headerIndustry] ? headerIndustry : 'cosmetic'
  const headers = headerIndustry === undefined ? {} : { 'x-industry': headerIndustry }
  if (healthTokens && healthTokens[code]) headers.Authorization = `Bearer ${healthTokens[code]}`
  return api('GET', '/api/meta/health', { headers })
}

try {
  // ---- 服务就绪 ----
  const started = Date.now()
  const ready = await new Promise((res) => {
    const t = setInterval(() => {
      if (log.includes('服务已启动')) {
        clearInterval(t)
        res(true)
      } else if (Date.now() - started > 180000) {
        clearInterval(t)
        res(false)
      }
    }, 300)
  })
  if (!ready) {
    console.log('❌ 服务启动失败：\n' + log.split('\n').slice(-30).join('\n'))
    await reclaimAndExit(1)
  }
  console.log('✅ 服务已启动')

  // ---- 依赖：随后的进程内 import（判据唯一出处 / 签发令牌 / 建令牌）----
  const { INDUSTRY_CODE_INVALID, assertIndustry, industryError, showValue, DATA_DIR } =
    await import('../server/db/index.js')
  const { signToken, isTokenInvalid } = await import('../server/middleware/auth.js')
  const { createToken, TOKEN_FIELD_INVALID } = await import('../server/mcp/tokens.js')
  // ---- 落点自证闸门：钉了 env 还要**验它真的生效**（"钉了没效也看不出来"是同一个病的另一面）----
  // 取 `db/index.js` **实际导出**的 DATA_DIR —— **不自己再算一遍**，否则"我以为的落点"与
  // "模块真正用的落点"会分家、闸门就成了摆设。
  // ⚠️ 前缀比较用**原样字符串**：macOS 上 `fs.realpathSync('/tmp')` 会变成 `/private/tmp`，
  //    拿 realpath 去比 `/tmp/` 会**误拒**合法落点（fail-safe：只拒跑不误放，但会变成会咬人的假红）。
  console.log(`[落点自证] db/index.js 实际使用 DATA_DIR=${DATA_DIR}`)
  if (!String(DATA_DIR).startsWith('/tmp/')) {
    console.error(
      `✗ 隔离没生效：db/index.js 实际解析出的 DATA_DIR=${DATA_DIR} 不在 /tmp 下 —— 会写仓库 data/。拒跑。`
    )
    await reclaimAndExit(2)
  }
  ok('落点自证：钉的 env 真的生效（db/index.js 实际 DATA_DIR 以 /tmp/ 开头）', String(DATA_DIR).startsWith('/tmp/'), String(DATA_DIR))

  // ---- 哨兵：三库 products 计数（启动完成后读，避免与启动灌数抢跑）----
  const sentinel = {}
  const tokenUsers = {}
  for (const c of INDUSTRY_CODES) {
    const db = new Database(path.join(DIR, `gml_${c}.db`), { readonly: true })
    sentinel[c] = db.prepare('SELECT COUNT(*) c FROM products').get().c
    tokenUsers[c] = db.prepare("SELECT id, username, role, name, auth_version FROM users WHERE username='admin'").get()
    db.close()
  }
  console.log(`哨兵 products 计数 = ${JSON.stringify(sentinel)}`)
  healthTokens = Object.fromEntries(Object.entries(tokenUsers).map(([c, u]) => [c, signToken(u, c)]))
  // 哨兵前提自证：三库计数必须两两不同，否则"读到哪个库"判不出来（守卫的判据就失效了）
  ok(
    new Set(Object.values(sentinel)).size === 3,
    '哨兵自证：三库 products 计数两两不同（否则"读到哪个库"判不出来）',
    JSON.stringify(sentinel)
  )

  console.log('\n== ① 合法头 ⇒ 真的换库（证明端点能区分库） ==')
  const hCos = await health('cosmetic')
  const hFood = await health('food')
  const hApp = await health('apparel')
  ok(
    hCos.status === 200 && hCos.body?.data?.database?.products === sentinel.cosmetic,
    `x-industry:cosmetic → 200 且 products=${sentinel.cosmetic}`,
    JSON.stringify(hCos.body)?.slice(0, 200)
  )
  ok(
    hFood.status === 200 && hFood.body?.data?.database?.products === sentinel.food,
    `x-industry:food → 200 且 products=${sentinel.food}（与 cosmetic 不同）`,
    JSON.stringify(hFood.body)?.slice(0, 200)
  )
  ok(
    hApp.status === 200 && hApp.body?.data?.database?.products === sentinel.apparel,
    `x-industry:apparel → 200 且 products=${sentinel.apparel}`,
    JSON.stringify(hApp.body)?.slice(0, 200)
  )

  console.log('\n== ② 缺省头 ⇒ 默认库（缺失 ≠ 非法） ==')
  const hNone = await health(undefined)
  ok(
    hNone.status === 200 && hNone.body?.data?.database?.products === sentinel.cosmetic,
    `不带 x-industry → 200 且 products=${sentinel.cosmetic}（默认库）`,
    JSON.stringify(hNone.body)?.slice(0, 200)
  )
  const hEmpty = await health('')
  ok(hEmpty.status === 200, '空串头 ⇒ 也按"缺失"处理（默认库，200）', `实际 ${hEmpty.status}`)

  console.log('\n== ③ 非法头 ⇒ 400 + 稳定码 + 响应里没有任何库的数据 ==')
  // 'Cosmetic'=大小写；'cos metic'=内部空白（尾随空格会被 HTTP 解析器剥离，见文件头）；
  // 'foo'=不存在；后三个是 Object.hasOwn 反例（原型链上的键，旧写法 `INDUSTRIES[v]` 会判"合法"）。
  for (const bad of ['Cosmetic', 'cos metic', 'foo', 'constructor', '__proto__', 'toString']) {
    const h = await health(bad)
    ok(h.status === 400, `x-industry:${JSON.stringify(bad)} → 400`, `实际 ${h.status}`)
    ok(h.body?.error === INDUSTRY_CODE_INVALID, `x-industry:${JSON.stringify(bad)} → error=${INDUSTRY_CODE_INVALID}`, `实际 ${h.body?.error}`)
    // 关键判据：**没有**落到任何库（不只是状态码对）
    ok(
      h.body?.data?.database?.products === undefined,
      `x-industry:${JSON.stringify(bad)} → 响应里没有任何库的数据（未落 cosmetic/${sentinel.cosmetic}）`,
      JSON.stringify(h.body)?.slice(0, 160)
    )
  }

  console.log('\n== ③b 同值重复头 ⇒ 宁拒不猜（保持现状，别哪天被"顺手取第一个"改掉） ==')
  // 传输层会把两次 `x-industry: food` 合成 `'food, food'` —— 那不是合法码 ⇒ 400。
  // 取"第一个"就是回到"猜"，所以这里刻意拒；下面三条断言就是它的守卫。
  const dupHeaders = new Headers()
  dupHeaders.append('x-industry', 'food')
  dupHeaders.append('x-industry', 'food')
  ok(
    dupHeaders.get('x-industry') === 'food, food',
    '机制自证：两次 x-industry 头在传输层合成 "food, food"',
    JSON.stringify(dupHeaders.get('x-industry'))
  )
  const dupRes = await fetch(`${BASE}/api/meta/health`, { headers: dupHeaders })
  const dupBody = await dupRes.json().catch(() => null)
  ok(dupRes.status === 400, '重复头 x-industry: food ×2 ⇒ 400（宁拒不猜）', `实际 ${dupRes.status}`)
  ok(dupBody?.error === INDUSTRY_CODE_INVALID, `重复头 ⇒ error=${INDUSTRY_CODE_INVALID}`, `实际 ${dupBody?.error}`)
  ok(dupBody?.data?.database?.products === undefined, '重复头 ⇒ 响应里没有任何库的数据', JSON.stringify(dupBody)?.slice(0, 160))

  console.log('\n== ④ 登录体：缺失⇒默认；非法⇒400 + 稳定码 ==')
  const login = (body) => api('POST', '/api/auth/login', { body })
  const lOk = await login({ username: 'admin', password: '12345', industry: 'food' })
  ok(
    lOk.status === 200 && lOk.body?.data?.industry === 'food',
    '登录 body.industry=food → 200 且 industry=food',
    `实际 ${lOk.status}/${lOk.body?.data?.industry}`
  )
  const lNone = await login({ username: 'admin', password: '12345' })
  ok(
    lNone.status === 200 && lNone.body?.data?.industry === 'cosmetic',
    '登录不传 industry → 200 且落默认 cosmetic',
    `实际 ${lNone.status}/${lNone.body?.data?.industry}`
  )
  const lBad = await login({ username: 'admin', password: '12345', industry: 'foo' })
  ok(lBad.status === 400, '登录 body.industry=foo → 400', `实际 ${lBad.status}`)
  ok(lBad.body?.error === INDUSTRY_CODE_INVALID, `登录非法行业 → error=${INDUSTRY_CODE_INVALID}`, `实际 ${lBad.body?.error}`)
  const lWs = await login({ username: 'admin', password: '12345', industry: 'cosmetic ' })
  ok(
    lWs.status === 400,
    '登录 body.industry="cosmetic "（尾随空格，JSON 原样保留）→ 400（未被静默归一）',
    `实际 ${lWs.status} industry=${lWs.body?.data?.industry}`
  )

  console.log('\n== ⑤ 令牌载荷行业非法 ⇒ 拒绝该请求（不回落） ==')
  const me = (token, headerIndustry = 'cosmetic') =>
    api('GET', '/api/auth/me', { headers: { Authorization: `Bearer ${token}`, 'x-industry': headerIndustry } })
  const badJwt = signToken(tokenUsers.cosmetic, 'foo')
  const meBad = await me(badJwt)
  ok(meBad.status === 400, '带"行业=foo"的已签名令牌 → 400（拒绝，而不是当没这回事）', `实际 ${meBad.status}`)
  ok(meBad.body?.error === INDUSTRY_CODE_INVALID, `同上 → error=${INDUSTRY_CODE_INVALID}`, `实际 ${meBad.body?.error}`)
  ok(meBad.body?.data?.id === undefined, '同上 → 未读到库数据（无 data.id）', JSON.stringify(meBad.body)?.slice(0, 120))
  const wsJwt = signToken(tokenUsers.cosmetic, 'cosmetic ')
  const meWs = await me(wsJwt)
  ok(meWs.status === 400, '令牌载荷 industry="cosmetic " → 400（未被静默归一）', `实际 ${meWs.status}`)
  // 对照：合法令牌 → 200（证明拒绝不是"把所有人都挡了"）；合法但**不同**的头 ⇒ 令牌优先（不误杀）
  const goodJwt = signToken(tokenUsers.food, 'food')
  const meOk = await me(goodJwt, 'cosmetic')
  ok(
    meOk.status === 200 && meOk.body?.data?.industry === 'food',
    '对照：合法令牌（行业 food）+ 谎报头 cosmetic → 200 且 industry=food（令牌优先，不误杀合法头）',
    `实际 ${meOk.status}/${meOk.body?.data?.industry}`
  )
  // ★ F1 这一格：**非法头 + 合法令牌** ⇒ 头**先**判、非法**当场抛** ⇒ 400（令牌**不能**把它掩盖掉）。
  // 为什么必须有这条：这是"头先校验"与"令牌覆盖"两条口径的**交界**，两边脚本原来都没覆盖 ⇒
  // 口径若被改成"令牌给了行业就不再看头"，两边仍全绿、分歧没人看得见。这一格就是那道缝的守卫。
  const meHdrBad = await me(goodJwt, 'foo')
  ok(
    meHdrBad.status === 400,
    '★ 头=foo（非法）+ 合法令牌(food) → 400（头先判：令牌不能掩盖非法头）',
    `实际 ${meHdrBad.status}`
  )
  ok(meHdrBad.body?.error === INDUSTRY_CODE_INVALID, `★ 同上 → error=${INDUSTRY_CODE_INVALID}`, `实际 ${meHdrBad.body?.error}`)
  ok(meHdrBad.body?.data?.id === undefined, '★ 同上 → 响应里没有任何库数据（无 data.id）', JSON.stringify(meHdrBad.body)?.slice(0, 120))

  console.log('\n== ⑥ 建令牌侧：非法行业码在建的时候就拒（不留"用不了的脏令牌"） ==')
  const wdb = new Database(path.join(DIR, 'gml_cosmetic.db'))
  for (const bad of ['foo', 'Cosmetic', 'cosmetic ', 'constructor']) {
    let threw = null
    try {
      createToken(wdb, { name: `__industry_guard__/bad/${bad}`, industry: bad, scopes: 'read' })
    } catch (e) {
      threw = e
    }
    ok(
      !!threw && threw.code === INDUSTRY_CODE_INVALID,
      `createToken(industry:${JSON.stringify(bad)}) → 抛（建令牌即拒）`,
      threw ? `code=${threw.code}` : '未抛且已写库'
    )
  }
  // 缺失（null/undefined/''）⇒ 合法（Token 未绑定行业）；用独立名字便于清理
  for (const [i, v] of [null, undefined, ''].entries()) {
    let made = null
    let err = null
    try {
      made = createToken(wdb, { name: `__industry_guard__/null/${i}`, industry: v, scopes: 'read' })
    } catch (e) {
      err = e
    }
    ok(!!made && !err, `createToken(industry:${String(v)}) → 允许（Token 未绑定行业）`, err ? err.message : '')
    if (made) {
      ok(
        wdb.prepare('SELECT industry FROM agent_tokens WHERE id=?').get(made.id)?.industry === null,
        `落库的 industry 为 NULL（industry:${String(v)}）`
      )
    }
  }

  console.log('\n== ⑦ MCP：令牌行绑定了非法行业 ⇒ 拒绝（不再落"当前请求行业"） ==')
  // 造一张**绑定了非法行业**的令牌行：单纯 createToken 已建不出来（⑥），
  // 所以直接写库模拟"历史脏数据 / 迁移前留下的行"。
  const dirty = createToken(wdb, { name: '__industry_guard__/dirty', industry: null, scopes: 'read', rateLimit: 600 })
  wdb.prepare("UPDATE agent_tokens SET industry='foo' WHERE id=?").run(dirty.id)
  const mcp = await api('POST', '/mcp', {
    headers: { 'x-industry': 'cosmetic', Authorization: `Bearer ${dirty.token}` },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  })
  ok(!!mcp.body?.error, 'MCP 用"绑定 foo 行业"的令牌 → 被拒（JSON-RPC 报错）', JSON.stringify(mcp.body)?.slice(0, 160))
  ok(/行业码/.test(mcp.body?.error?.message || ''), 'MCP 拒绝文案点名"行业码无效"', JSON.stringify(mcp.body?.error))
  ok(mcp.body?.result === undefined, 'MCP 未返回工具清单（没有落到任何库）', JSON.stringify(mcp.body)?.slice(0, 120))
  // 对照：同一张令牌把行业改回合法 ⇒ 正常可用（证明拒绝的是"非法码"本身，不是这张令牌）
  wdb.prepare("UPDATE agent_tokens SET industry='cosmetic' WHERE id=?").run(dirty.id)
  const mcpOk = await api('POST', '/mcp', {
    headers: { 'x-industry': 'cosmetic', Authorization: `Bearer ${dirty.token}` },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  })
  ok(
    Array.isArray(mcpOk.body?.result?.tools) && mcpOk.body.result.tools.length > 0,
    '对照：同一令牌行业改回 cosmetic → 返回工具清单',
    JSON.stringify(mcpOk.body)?.slice(0, 120)
  )

  console.log('\n== ⑧ 值类型整类：非字符串值一律 400（不是 TypeError / 500） ==')
  // 行业码**不一定是字符串**（JSON 体 / 令牌载荷都可以是对象、数组、数字…）。
  // "我测了 12 类输入"不等于"我测了所有值类型" —— 第二次红队正是漏了这一整类。
  const valueTypes = [
    ['数字 123', 123],
    ['布尔 true', true],
    ['空对象 {}', {}],
    ['空数组 []', []],
    ['{toString:null}', { toString: null }],
    ['Object.create(null)', Object.create(null)],
    ['toString 抛错', { toString() { throw new Error('boom') } }],
    ['嵌套对象 {a:{b:1}}', { a: { b: 1 } }],
    ['函数', function probe() {}]
  ]
  // —— 单测级：判据给出稳定码，且**「构造这个错误」本身不许再抛** ——
  for (const [label, v] of valueTypes) {
    let caught = null
    try {
      assertIndustry(v)
    } catch (e) {
      caught = e
    }
    ok(
      !!caught && caught.code === INDUSTRY_CODE_INVALID && caught.status === 400,
      `assertIndustry(${label}) → INDUSTRY_CODE_INVALID / 400（不是 TypeError、不是无码异常）`,
      caught ? `code=${caught.code} status=${caught.status} msg=${String(caught.message).slice(0, 50)}` : '未抛'
    )
  }
  ok(assertIndustry(null) === null && assertIndustry(undefined) === null, 'null / undefined = 缺失（不是非法）⇒ 返回 null')
  let buildThrew = 0
  for (const [, v] of valueTypes) {
    try {
      industryError(v)
    } catch {
      buildThrew++
    }
  }
  ok(buildThrew === 0, 'industryError 对全部值类型都不抛（P1-A 的根因：构造错误时不许再抛）', `抛出 ${buildThrew} 次`)
  ok(showValue({ toString: null }) === '[object Object]', 'showValue({toString:null}) 安全回显', showValue({ toString: null }))
  const longEcho = showValue('x'.repeat(90000))
  ok(longEcho.length < 200, '超长值被截断（不再把 90KB 原样回显）', `长度 ${longEcho.length}`)
  // —— HTTP 级（登录体）：**无需登录、外网可达**，必须 400 + 稳定码 ——
  // ⚠️ 函数**无法用 JSON 表达**（`JSON.stringify` 会把该键整个丢掉 ⇒ 变成"缺失" ⇒ 200 是**正确**行为），
  //    所以 HTTP 级只覆盖可 JSON 表达的值；函数只在上面单测级覆盖（那里它确实是"给了非法值"）。
  const httpValueTypes = valueTypes.filter(([label]) => label !== '函数')
  for (const [label, v] of httpValueTypes) {
    const r = await login({ username: 'admin', password: '12345', industry: v })
    ok(r.status === 400, `登录 industry=${label} → 400（不是 500）`, `实际 ${r.status}`)
    ok(r.body?.error === INDUSTRY_CODE_INVALID, `登录 industry=${label} → error=${INDUSTRY_CODE_INVALID}`, `实际 ${r.body?.error}`)
  }
  // —— 令牌级：自签令牌载荷是对象 ⇒ 必须 400，**不是 200 读默认库**（第二次红队第 ② 条的现场）——
  const objJwt = signToken(tokenUsers.cosmetic, { toString: null })
  const meObj = await me(objJwt)
  ok(meObj.status === 400, '令牌载荷 industry={toString:null} → 400（不是 200 读默认库）', `实际 ${meObj.status}`)
  ok(meObj.body?.error === INDUSTRY_CODE_INVALID, `同上 → error=${INDUSTRY_CODE_INVALID}`, `实际 ${meObj.body?.error}`)
  ok(meObj.body?.data?.id === undefined, '同上 → 响应里没有任何库数据（无 data.id）', JSON.stringify(meObj.body)?.slice(0, 120))

  console.log('\n== ⑨ fail-closed：只有「令牌无效」家族可忽略，其余异常一律上抛拒绝 ==')
  // 这条守的是"**未知异常 ⇒ 静默回落默认库**"（第二次红队的结构性根因）。
  // 判据是**白名单** `isTokenInvalid`；只要它把"非令牌无效"的异常判成 false，中间件就会上抛。
  const jwtMod = (await import('jsonwebtoken')).default
  ok(isTokenInvalid(new jwtMod.JsonWebTokenError('bad signature')) === true, 'isTokenInvalid(JsonWebTokenError)=true（签名/格式错 ⇒ 可忽略）')
  ok(isTokenInvalid(new jwtMod.TokenExpiredError('expired', new Date())) === true, 'isTokenInvalid(TokenExpiredError)=true（过期 ⇒ 可忽略）')
  ok(isTokenInvalid(new jwtMod.NotBeforeError('nbf', new Date())) === true, 'isTokenInvalid(NotBeforeError)=true（未生效 ⇒ 可忽略）')
  for (const [label, err] of [
    ['行业码错误（我们自己的，必须响亮拒绝）', industryError('foo')],
    ['未知 TypeError', new TypeError('boom')],
    ['普通 Error', new Error('boom')],
    ['带 .code=INDUSTRY_CODE_INVALID 的**非 Error** 值', { code: INDUSTRY_CODE_INVALID }]
  ]) {
    ok(
      isTokenInvalid(err) === false,
      `isTokenInvalid(${label})=false ⇒ 上抛拒绝（不被当"令牌无效"吞掉、不回落默认库）`
    )
  }

  console.log('\n== ⑩ 同症状第二处：建令牌字段形状非法 ⇒ 400 + TOKEN_FIELD_INVALID（不是 500 无码） ==')
  // 与 §⑧ 同一症状（**用户可控值 ⇒ 500 且没有业务码**），只是触发点在建令牌的字段上：
  // `scopes:{toString:null}` 会走 `String(scopes)`，而 `{a:1}` 会被 better-sqlite3 当**具名参数包**。
  const adminLogin = await login({ username: 'admin', password: '12345', industry: 'cosmetic' })
  const adminTok = adminLogin.body?.data?.token
  ok(!!adminTok, '取管理员令牌（用于建令牌接口）')
  const issueToken = (body) =>
    api('POST', '/api/mcp/tokens', {
      headers: { Authorization: `Bearer ${adminTok}`, 'x-industry': 'cosmetic' },
      body
    })
  for (const [label, body] of [
    ['scopes={toString:null}', { name: '__industry_guard__/tok-scope', scopes: { toString: null } }],
    ['allow_tools={a:1}', { name: '__industry_guard__/tok-allow', allow_tools: { a: 1 } }],
    ['deny_tools={a:1}', { name: '__industry_guard__/tok-deny', deny_tools: { a: 1 } }],
    ['remark={a:1}', { name: '__industry_guard__/tok-remark', remark: { a: 1 } }],
    ['expires_at={a:1}', { name: '__industry_guard__/tok-exp', expires_at: { a: 1 } }],
    ['name={a:1}', { name: { a: 1 } }]
  ]) {
    const r = await issueToken(body)
    ok(r.status === 400, `建令牌 ${label} → 400（不是 500）`, `实际 ${r.status}`)
    ok(r.body?.error === TOKEN_FIELD_INVALID, `建令牌 ${label} → error=${TOKEN_FIELD_INVALID}`, `实际 ${r.body?.error}`)
  }
  // 对照：正常传法仍 200（不能把好人也挡了）
  const okTok = await issueToken({ name: '__industry_guard__/tok-ok', scopes: 'read', allow_tools: ['master.search_products'] })
  ok(okTok.status === 200 && !!okTok.body?.data?.token, '对照：正常传法（scopes 字符串 + allow_tools 字符串数组）仍 200', `实际 ${okTok.status}`)

  // ---- 清理：本次建出来的令牌不留痕（脚本可重复跑）----
  wdb.prepare("DELETE FROM agent_tokens WHERE name LIKE '__industry_guard__%'").run()
  const left = wdb.prepare("SELECT COUNT(*) c FROM agent_tokens WHERE name LIKE '__industry_guard__%'").get().c
  ok(left === 0, '用例自还原：本脚本建的令牌行已清除', `残留 ${left}`)
  wdb.close()
} catch (e) {
  fail++
  failures.push('异常：' + e.message)
  console.log('  ✗ 异常：' + e.message)
} finally {
  // 正常路径：只回收并报一句，**不在 finally 里 exit** —— 否则下面的计数永远打不出来，
  // regress-all 就抓不到「通过 N / 失败 M」。（异常路径由 reclaimAndExit 负责 exit。）
  const gone = await reclaim()
  console.log(gone ? `[回收] 已回收 pid ${srv.pid}` : `[回收] 回收失败，pid ${srv.pid} 仍在`)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail) console.log('失败项：\n - ' + failures.join('\n - '))
process.exit(fail ? 1 : 0)
