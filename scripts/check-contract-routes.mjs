#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-contract-routes.mjs ｜ 静态守卫：契约 ↔ 真实路由 **双向差集**守卫。
 * ============================================================================
 * 【职责】静态守卫：契约 ↔ 真实路由 **双向差集**守卫。
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
 * 契约 ↔ 真实路由 **双向差集**守卫。
 *
 * ===========================================================================
 * 一、为什么需要它（本轮的实证）
 * ===========================================================================
 * 现有守卫覆盖：① 类型文件 ↔ openapi（check-api-contract 规则①）
 *               ② 前端调用 ↔ openapi（规则②）
 *               ④ openapi 内部无重复（规则④）
 * 但**没有一条**回答："**openapi 里写的路径，真实 express 路由里存在吗**"。
 *
 * 后果（本轮实测）：订货对账单（OCS）的 `close` / `void` 两条路由**后端压根没有**，
 * 而前端按钮一直在渲染（它读内核 `allowedActions('OCS', status)`）——
 * 契约里写的是笼统的 `/api/order-center/statements/{id}/{action}`，
 * 于是两道守卫**都不会报**，这个"点了必然 404"的缺口活到了今天
 * （`src/pages/order-center/OrderCenter.tsx:40` 的注释里其实早有人记下了它）。
 *
 * ===========================================================================
 * 二、判据：两个方向都要比，缺一不可
 * ===========================================================================
 *   A 方向（契约 → 真实）：openapi 声明的每条路径，必须在真实路由里找得到模板。
 *      —— 抓"**契约里有、后端没门**"（本次要防的那一类）。
 *   B 方向（真实 → 契约）：每条真实路由，必须登记在 openapi 里。
 *      —— 抓"**后端有门、契约没写**"（前端拿不到类型、外部集成方看不见）。
 * 只做一个方向会漏掉一半：只做 A 会把"新加了路由忘了登记"放过，
 * 只做 B 会把"契约写了假路径"放过。
 *
 * ===========================================================================
 * 三、已知边界（**不要以为它全覆盖**）
 * ===========================================================================
 *   ① **只认静态注册**：扫的是 `(r|router|app).<method>('<字面路径>'`。
 *      · 循环里动态挂载（`for (const p of list) r.get(p, ...)`）、
 *        路径来自变量/模板串的，**扫不到**——这类路由会被误报成"契约里有、真实没有"
 *        （A 方向假阳性）。遇到时请把该路径加入本文件的 KNOWN_DYNAMIC 白名单，
 *        **不要**把判据放宽成"前缀匹配"（那会把真正的缺口一起放过）。
 *      · 本文件**不判遮蔽**（`/orders/:id/:action` 吃掉 `/orders/:id/close` 那类）
 *        —— 那是 `check-route-order.mjs` 的职责，两者分工不同、都要跑。
 *   ② **参数写法归一**：openapi 用 `{id}`、express 用 `:id`，比较前都归一成 `{}`。
 *      段数不同的路径**不算同一模板**（`/a/{id}` 与 `/a/{id}/b` 是两条）。
 *   ③ **挂载前缀**：openapi 是 `/api/xxx/yyy`，路由文件里写的是 `/yyy`。
 *      映射从 `server/index.js` 的 `app.use('<mount>', <var>)` + `import <var> from './routes/<file>.js'`
 *      两处读出。**没有 mount 的文件（如 `server/mcp/**`）不参与**——它们不是
 *      `/api` HTTP 路由，硬比只会制造噪音。
 *   ④ 一个路由文件挂到多个 mount 时（如 `sales.js` / `quote.js` 都挂 `/api/sales`），
 *      按 **mount × 文件** 展开后再去重。
 *
 * ===========================================================================
 * 四、扫描器自检（**必须有牙**，否则"全绿"没有意义）
 * ===========================================================================
 *   `--hide=<子串>`          从真实路由的**源码文本**里剔除匹配行（模拟"后端没门"）
 *   `--hide-contract=<子串>` 从 openapi 的**源码文本**里剔除匹配行（模拟"契约没写"）
 * 判据自检的结果写死在文件末尾的 SELF_TEST 里（跑 `--selftest` 会断言它们）：
 *   剔除真实路由 ⇒ A 方向**只**指向那一格；剔除契约 ⇒ B 方向**只**指向那一格；
 *   并且**不该报的别报**（反向对照）。
 *
 * 用法：
 *   node scripts/check-contract-routes.mjs             # 双向差集（有问题退出码 1）
 *   node scripts/check-contract-routes.mjs --selftest  # 只跑扫描器自检
 *   node scripts/check-contract-routes.mjs --hide=/deliveries/:id/receive
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => (argv.find((a) => a.startsWith(k + '=')) || '').slice(k.length + 1)

// 契约里有、但真实路由是**动态注册**（扫不到的）—— 逐条给出理由，别当成缺口。
// 目前为空；发现一条就在注释里写清为什么，不允许静默加白名单。
const KNOWN_DYNAMIC = new Set([])

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.js$/.test(f)) out.push(p)
  }
  return out
}

const ROUTE_RE = /(?:^|\s)(?:r|router|app)\.(get|post|put|delete|patch)\(\s*'([^']+)'/g

/** 从 `(` 起做括号配对，返回整段实参文本（用于跨行的 app.use） */
function extractArgs(text, open) {
  let d = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') d++
    else if (text[i] === ')' && --d === 0) return text.slice(open + 1, i)
  }
  return ''
}
/** 归一化：`/a/{id}/b` 与 `/a/:id/b` → `/a/{}/b`；末尾斜杠也归一 */
const norm = (p) => {
  const n = p.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z_][\w]*/g, '{}')
  return n.length > 1 ? n.replace(/\/+$/, '') : n
}

/** `lib/crud.js` 里 `crudRouter()` 实际注册的路由形状 —— **从它的源码提取**，
 *  不在这里手抄一份（手抄就是第二份口径，改了 crud.js 不会有人记得改这里）。 */
function crudRouterShapes() {
  const t = fs.readFileSync(path.join(ROOT, 'server/lib/crud.js'), 'utf8')
  const out = []
  const re = /(?:^|\s)r\.(get|post|put|delete|patch)\(\s*'([^']+)'/g
  let m
  while ((m = re.exec(t))) out.push({ method: m[1].toUpperCase(), sub: m[2] })
  return out
}

/** 从 index.js 读 mount → 文件 的映射 */
function mountMap() {
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8')
  const imports = new Map() // 变量名 -> 路由文件相对路径
  // ⚠️ 原来只认 `./routes/xxx.js`，于是挂在 `/api/mcp` 上的 `server/mcp/admin.js`
  // **整份被漏掉**（注释里还写着"server/mcp/** 不参与，它们不是 /api 路由"—— 那句是错的：
  // `index.js` 里明明有 `app.use('/api/mcp', mcpAdminRoutes)`）。
  // 漏掉的后果不是"少报几条"，而是**MCP 管理面接口的契约永远无法登记**：
  // 一登记就报"契约有、后端没有"（假阳性），只能不登记 —— 于是它成了契约盲区。
  // 所以这里把 `./mcp/` 一并纳入；`server/mcp/server.js` 挂在 `/mcp`（非 /api），
  // 由下面的 mount 过滤挡掉，不会污染 `/api` 的差集。
  const imRe = /import\s+(\w+)\s+from\s+'\.\/(routes|mcp)\/([\w.-]+\.js)'/g
  let m
  while ((m = imRe.exec(src))) imports.set(m[1], 'server/' + m[2] + '/' + m[3])
  const out = [] // { mount, file }
  // ⚠️ `app.use` 有三种会被漏掉的形态，任何一种漏了都会把真实路由判成
  // "契约里有、后端没有"（A 方向假阳性）：
  //   ① `app.use('/api/x', xRoutes)`                  —— 两实参
  //   ② `app.use('/api/ai', <middleware>, aiRoutes)`  —— 三实参（中间件 + Router）
  //   ③ **跨行**：上面 ② 的中间件写成多行箭头函数时，按 `[^\n]*` 抓只拿到半行。
  //     `/api/ai` 实测就是 ③ —— 于是它的 5 条路由先被误报，修了 ② 又漏 ③。
  //   所以这里用**括号配对**取整段实参，再取其中**最后一个 import 过的标识符**当 Router。
  const useStart = /app\.use\(/g
  let um
  while ((um = useStart.exec(src))) {
    const args = extractArgs(src, um.index + um[0].length - 1)
    const mount = (/^\s*'(\/api[^']*)'/.exec(args) || [])[1]
    if (!mount) continue
    const ids = [...args.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((x) => x[1])
    const routerVar = ids.reverse().find((v) => imports.has(v))
    if (routerVar) out.push({ mount, file: imports.get(routerVar) })
  }
  return out
}

/** 扫一个路由文件的静态路由（含 `r.use(prefix, X)` 的**子路由展开**，递归 ≤3 层） */
function scanFile(abs, prefix, hide, depth = 0, acc = []) {
  if (depth > 3) return acc
  let text = fs.readFileSync(abs, 'utf8')
  if (hide) text = text.split('\n').filter((l) => !l.includes(hide)).join('\n')

  // 1) 直接注册
  ROUTE_RE.lastIndex = 0
  let m
  while ((m = ROUTE_RE.exec(text))) {
    acc.push({ method: m[1].toUpperCase(), full: prefix + m[2], file: path.relative(ROOT, abs), line: text.slice(0, m.index).split('\n').length })
  }

  // 2) 子路由挂载：r.use('<sub>', <X>)  —— X 是 crudRouter(...) 或一个 import 进来的 Router
  const useRe = /(?:^|\s)r\.use\(\s*'([^']+)'\s*,\s*([A-Za-z_$][\w$]*)\s*\(?/g
  while ((m = useRe.exec(text))) {
    const sub = m[1]
    const callee = m[2]
    const at = m.index
    if (callee === 'crudRouter') {
      for (const s of crudRouterShapes()) acc.push({ method: s.method, full: prefix + sub + (s.sub === '/' ? '' : s.sub), file: path.relative(ROOT, abs), line: text.slice(0, at).split('\n').length })
    } else {
      // 该文件里 import 进来的 Router 变量 → 找到源文件递归
      const imRe = new RegExp(`import\\s+\\{?\\s*[^}]*\\b${callee}\\b[^}]*\\}?\\s+from\\s+'\\./([\\w.-]+\\.js)'`)
      const im = imRe.exec(text)
      if (im) {
        const child = path.join(path.dirname(abs), im[1])
        if (fs.existsSync(child)) scanFile(child, prefix + sub, hide, depth + 1, acc)
      }
    }
  }
  return acc
}

/** 扫真实路由：返回 [{method, full, file, line}] */
function scanReal({ hide = '' } = {}) {
  const list = []
  for (const { mount, file } of mountMap()) {
    const abs = path.join(ROOT, file)
    if (!fs.existsSync(abs)) continue
    scanFile(abs, mount, hide, 0, list)
  }
  // 同一 (method, full) 可能因多文件/多 mount 重复 —— 保留首个
  return [...new Map(list.map((r) => [r.method + ' ' + norm(r.full), r])).values()]
}

/** 扫契约路径 */
function scanContract({ hide = '' } = {}) {
  let text = fs.readFileSync(path.join(ROOT, 'server/openapi.js'), 'utf8')
  if (hide) text = text.split('\n').filter((l) => !l.includes(hide)).join('\n')
  const out = []
  const re = /^\s{4}'(\/api\/[^']+)'\s*:/gm
  let m
  while ((m = re.exec(text))) out.push(m[1])
  return [...new Set(out)]
}

function diff({ hideReal = '', hideContract = '' } = {}) {
  const real = scanReal({ hide: hideReal })
  const contract = scanContract({ hide: hideContract })
  const realKeys = new Set(real.map((r) => r.method + ' ' + norm(r.full)))
  const contractKeys = new Set(contract.map((p) => norm(p)))
  const contractAny = new Set(contract.map((p) => norm(p)))
  // 契约 → 真实：路径模板存在即可（method 由 check-api-contract 的规则③管）
  const missingInReal = contract.filter((p) => !KNOWN_DYNAMIC.has(p) && !realKeys.has('GET ' + norm(p)) && !realKeys.has('POST ' + norm(p)) && !realKeys.has('PUT ' + norm(p)) && !realKeys.has('DELETE ' + norm(p)) && !realKeys.has('PATCH ' + norm(p)))
  // 真实 → 契约：只看路径
  const missingInContract = real.filter((r) => !contractAny.has(norm(r.full)))
  return { real, contract, missingInReal, missingInContract, noDoor: [], reachable: [] }
}

const SELFTEST = [
  // dir 指明"被剔除的那一侧，另一个方向应该只多出这一格"
  { name: '剔除真实路由 /deliveries/:id/receive ⇒ A 方向只指向它', args: { hideReal: '/deliveries/:id/receive' }, dir: 'A', expect: '/api/sales/deliveries/{}/receive', count: 1 },
  { name: '剔除契约 close 行 ⇒ B 方向只指向它', args: { hideContract: "'/api/dealers/statements/{id}/close'" }, dir: 'B', expect: '/api/dealers/statements/{}/close', count: 1 }
]

if (argv.includes('--dump-mounts')) {
  console.log('mount → 路由文件（从 server/index.js 的 app.use 读出）')
  for (const m of mountMap()) console.log(`  ${m.mount.padEnd(22)} ${m.file}`)
  console.log(`\n真实路由中含 /api/ai 的：`)
  for (const r of scanReal()) if (r.full.includes('/api/ai')) console.log(`  ${r.method} ${r.full}`)
  process.exit(0)
}

if (argv.includes('--selftest')) {
  let bad = 0
  const base = diff()
  console.log(`基线：真实路由 ${base.real.length} 条，契约路径 ${base.contract.length} 条，` +
    `A 方向缺 ${base.missingInReal.length}，B 方向缺 ${base.missingInContract.length}`)
  for (const st of SELFTEST) {
    const d = diff(st.args)
    // 断言"**增量**"而不是"总量"：② 方向本来就有历史欠账，比总量会把基线当成判据的功劳。
    const baseSet = new Set(
      (st.dir === 'A' ? base.missingInReal.map(norm) : base.missingInContract.map((r) => norm(r.full)))
    )
    const all = st.dir === 'A' ? d.missingInReal.map(norm) : d.missingInContract.map((r) => norm(r.full))
    const delta = all.filter((h) => !baseSet.has(h))
    const want = norm(st.expect)
    const ok = delta.length === st.count && delta.includes(want)
    console.log(`  ${ok ? '✓' : '✗'} ${st.name}（${st.dir} 方向**新增** ${delta.length} 条：${delta.join(', ') || '—'}）`)
    if (!ok) bad++
  }
  // 反向对照：不 hide 时，这两条路径都不该出现在 A 方向缺集里
  const noFalse = !base.missingInReal.some((p) => norm(p) === norm('/api/sales/deliveries/{id}/receive'))
  console.log(`  ${noFalse ? '✓' : '✗'} 反向对照：未 hide 时 DL.receive 不被误报`)
  if (!noFalse) bad++
  process.exit(bad ? 1 : 0)
}

const d = diff({ hideReal: argOf('--hide'), hideContract: argOf('--hide-contract') })
console.log(`真实路由 ${d.real.length} 条　契约路径 ${d.contract.length} 条`)
console.log('')
console.log(`① 契约 → 真实：openapi 声明了但真实路由里没有的（${d.missingInReal.length} 条）`)
for (const p of d.missingInReal) console.log('   ✗ ' + p)
if (!d.missingInReal.length) console.log('   ✓ 无（契约里每条路径都能在真实路由里找到模板）')
console.log('')
console.log(`② 真实 → 契约：真实路由有但没有登记进 openapi 的（${d.missingInContract.length} 条）`)
for (const r of d.missingInContract) console.log(`   · ${r.method} ${r.full}  (${r.file}:${r.line})`)
if (!d.missingInContract.length) console.log('   ✓ 无')
console.log('')

// 退出码策略（写在输出里，别让人猜）：
//   ① 方向（契约有、后端没门）—— **这才是"点了必然 404"那一类**，有差就红。
//   ② 方向（后端有门、契约没写）—— 截至本轮是一批**历史欠账**（76 条，绝大多数是
//      `crudRouter` 生成的资源级路由 `/:id` 详情/更新/删除没被登记）。
//      若默认计入，本守卫从第一天起就是红的 ⇒ 变成"狼来了"，没人再看它。
//      所以默认只**打印**，要计入退出码请加 `--strict`。
const strict = argv.includes('--strict')
const bad = d.missingInReal.length + (strict ? d.missingInContract.length : 0)
if (d.missingInContract.length && !strict) {
  console.log(`⚠️ ② 方向有 ${d.missingInContract.length} 条历史欠账（未计入退出码；加 --strict 可让它们也变红）`)
  console.log('   —— 它们不是"点了 404"，而是"契约漏登记了真实存在的接口"（前端拿不到类型、外部看不见）。')
  console.log('')
}
console.log(bad ? `契约↔路由双向差集：${bad} 项问题` : '契约↔路由双向差集：① 方向一致 ✓（② 方向见上，加 --strict 才计入）')
process.exit(bad ? 1 : 0)
