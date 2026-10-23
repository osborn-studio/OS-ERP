#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-route-authz.mjs ｜ 静态守卫：路由授权清单（只有 requireAuth 的路由必须登记，ADR-0021）
 * ============================================================================
 * 【为什么需要它】
 *   「谁只过了登录、没过任何权限/范围闸门」是商用整改里反复出现的洞（ADR-0017 收口了 7 条采购读路由，
 *   剩余详情路由仍只有 requireAuth）。没有清单就看不见，修了也无法防回退。本守卫把它变成每次跑批可见的清单。
 *
 * 【判据】静态解析 `server/routes/*.js` 的 `r.get/post/put/patch/delete/all(path, ...中间件, 处理器)`，
 *   对每条路由算「有效链」= 挂载层中间件（server/index.js 的 `app.use(prefix, ...mw, router)`）
 *   + 路由器层 `r.use(...)`（仅取该路由之前、且路径无前缀或能覆盖本路由的）+ 路由自身中间件（不含最后一个处理器）。
 *   分类：
 *     · GATED     链里有任一"强闸门"（requirePerm/requireRole/requireInternal/requireGlobalData/requireStore/
 *                 requireDealer/requireMall）⇒ 通过；
 *     · AUTH_ONLY 只有 requireAuth ⇒ 必须在 ALLOW 登记，带理由；
 *     · NO_AUTH   连 requireAuth 都没有 ⇒ 同上（公开端点必须写明"为什么公开"）。
 *   ALLOW 双向校验：登记了却已不存在 / 已经 GATED / 分类变了 ⇒ 红（例外表不许变成橡皮图章）；
 *   `pending: 'W1'` 表示"真实缺口，已排期"，在报告里单列，不算通过的理由。
 *
 * 【解析器的边界（诚实写明）】
 *   ① 只认字面量调用 `r.<verb>(`（行首）；`r.route(...)`、动态拼动词、循环里批量注册的路由看不到（会在报告里单列"不可解析"计数）。
 *   ② 中间件按"名字"识别，不执行；本地 `const xGate = [ ... ]` 数组、`...xGate` 展开会解析，跨文件导入的数组不会。
 *   ③ 行内箭头函数中间件视为不透明：其源码里出现的强闸门名字按"仅限该方法"计入——若源码含
 *      `req.method !== 'GET'` 这类方法守卫，则只对 GET 生效（approval.js 的 r.use 即此形态）。
 *   ④ 路由器层 `r.use('/x', subRouter)` 只登记"子路由器未解析"，子路由器自己的文件若在 routes/ 下会被单独扫描。
 *   ⑤ 处理器内部手写的权限判断（`assertCanRead(...)`、`if (!hasPerm(...))`）不可见：这类路由会被判 AUTH_ONLY，
 *      在 ALLOW 里写明"处理器内自检"，由人复核。
 *   ⑥ 守卫只证明"链里出现了闸门名字"，不证明闸门配置得对；权限码是否合适靠 ADR 与各域测试。
 *
 * 用法：node scripts/check-route-authz.mjs [--list]    （--list 打印全部路由及其中间件链）
 *       环境变量 OSERP_ROUTE_AUTHZ_ROOT 可指向另一个仓库副本（测试用），缺省为本脚本所在仓库。
 * 退出码：0 全绿；1 有未登记路由或过期登记；2 用法错误。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = process.env.OSERP_ROUTE_AUTHZ_ROOT
  ? path.resolve(process.env.OSERP_ROUTE_AUTHZ_ROOT)
  : path.resolve(path.dirname(SELF), '..')

const LIST = process.argv.includes('--list')
if (process.argv.slice(2).some((a) => a !== '--list')) {
  console.error('用法：node scripts/check-route-authz.mjs [--list]')
  process.exit(2)
}

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'all']
const AUTH = 'requireAuth'
const STRONG = new Set(['requirePerm', 'requireRole', 'requireInternal', 'requireGlobalData', 'requireStore', 'requireDealer', 'requireMall'])
/** 处理器包装器：出现在最后一个参数位置，不是中间件 */
const HANDLER_WRAPPERS = new Set(['wrap', 'guard', 'asyncHandler'])

// ---------------------------------------------------------------------------
// 词法：把注释抹成空格（保留行号），并生成"骨架"（字符串/模板/正则内容也抹掉，括号匹配用）
// ---------------------------------------------------------------------------
export function lex(src) {
  const n = src.length
  const masked = src.split('')
  const skel = src.split('')
  const blank = (arr, a, b) => { for (let k = a; k < b; k++) if (arr[k] !== '\n') arr[k] = ' ' }
  const prevSig = (i) => { let k = i - 1; while (k >= 0 && /\s/.test(src[k])) k--; return k >= 0 ? src[k] : '' }
  function scanString(i, q) {
    let j = i + 1
    while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++ }
    blank(skel, i + 1, j)
    return j + 1
  }
  function scanTemplate(i) {
    let j = i + 1
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') { j += 2; continue }
      if (src[j] === '$' && src[j + 1] === '{') { j = scanCode(j + 2, true); continue }
      blank(skel, j, j + 1)
      j++
    }
    return j + 1
  }
  function scanCode(i, untilBrace) {
    let depth = 0
    while (i < n) {
      const c = src[i]
      const d = src[i + 1]
      if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blank(masked, i, end); blank(skel, i, end); i = end; continue }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; blank(masked, i, end); blank(skel, i, end); i = end; continue }
      if (c === '"' || c === "'") { i = scanString(i, c); continue }
      if (c === '`') { i = scanTemplate(i); continue }
      if (c === '/' && /[(,=:[!&|?{};+*%<>~^-]|^$/.test(prevSig(i))) {
        let j = i + 1; let cls = false
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue }
          if (src[j] === '[') cls = true
          else if (src[j] === ']') cls = false
          else if (src[j] === '/' && !cls) break
          j++
        }
        blank(skel, i + 1, j); i = j + 1; continue
      }
      if (untilBrace) {
        if (c === '{') depth++
        else if (c === '}') { if (depth === 0) return i + 1; depth-- }
      }
      i++
    }
    return i
  }
  scanCode(0, false)
  return { masked: masked.join(''), skel: skel.join('') }
}

/** 在骨架里从 open 位置的 "(" 找匹配的 ")"；返回其下标，找不到返回 -1 */
function matchParen(skel, open) {
  let depth = 0
  for (let i = open; i < skel.length; i++) {
    const c = skel[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

/** 把 (open, close) 之间按顶层逗号切成参数，返回 masked 原文片段（trim 后，空参数丢弃） */
function splitArgs(masked, skel, open, close) {
  const out = []
  let depth = 0
  let start = open + 1
  for (let i = open + 1; i < close; i++) {
    const c = skel[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) { out.push(masked.slice(start, i)); start = i + 1 }
    // 箭头函数体里的 `=>` 不含顶层逗号，无需特殊处理
  }
  out.push(masked.slice(start, close))
  return out.map((s) => s.trim()).filter(Boolean)
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length

// ---------------------------------------------------------------------------
// 中间件参数 → 名字列表
// ---------------------------------------------------------------------------
/** 解析文件里 `const NAME = [a, b(...), c]` 形式的本地中间件数组 */
function localArrays(masked, skel) {
  const map = new Map()
  // `const g = [a, b]` 与 `const g = (label) => [a, b(label)]` 两种形态
  const re = /(?:^|\n)\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([\w$,\s]*\)\s*=>\s*)?\[/g
  let m
  while ((m = re.exec(skel))) {
    const open = m.index + m[0].length - 1
    const close = matchParen(skel, open)
    if (close < 0) continue
    map.set(m[1], splitArgs(masked, skel, open, close))
  }
  return map
}

/** 一个参数 → { names: string[], opaque: boolean, methodOnly: string|null } */
function classifyArg(arg, arrays, seen = new Set()) {
  let a = arg.trim()
  if (a.startsWith('...')) a = a.slice(3).trim()
  const id = a.match(/^([A-Za-z_$][\w$]*)\s*(\(|$)/)
  if (id && !/=>/.test(a.slice(0, 80)) && !/^function\b/.test(a)) {
    const name = id[1]
    if (arrays.has(name) && !seen.has(name)) {
      seen.add(name)
      return arrays.get(name).reduce((acc, x) => mergeCls(acc, classifyArg(x, arrays, seen)), emptyCls())
    }
    if (HANDLER_WRAPPERS.has(name)) return { names: ['<handler>'], opaque: false, methodOnly: null, exemptPaths: [] }
    return { names: [name], opaque: false, methodOnly: null, exemptPaths: [] }
  }
  // 行内函数：不透明；从源码里抠强闸门/requireAuth 名字
  const names = [...new Set((a.match(/\brequire[A-Z]\w*/g) || []))]
  const mg = a.match(/req\.method\s*!==?\s*['"](\w+)['"]/)
  // 路径豁免：`if (req.path === '/manifest' ...) return next()` ⇒ 这些路径不经过该行内中间件（ai.js 挂载层即此形态）
  const exemptPaths = [...a.matchAll(/req\.path\s*===\s*['"]([^'"]+)['"]/g)].map((x) => x[1])
  return { names, opaque: true, methodOnly: mg ? mg[1].toUpperCase() : null, exemptPaths }
}
const emptyCls = () => ({ names: [], opaque: false, methodOnly: null, exemptPaths: [] })
const mergeCls = (a, b) => ({
  names: [...a.names, ...b.names],
  opaque: a.opaque || b.opaque,
  methodOnly: a.methodOnly || b.methodOnly,
  exemptPaths: [...(a.exemptPaths || []), ...(b.exemptPaths || [])]
})

// ---------------------------------------------------------------------------
// 挂载层：server/index.js 的 app.use(prefix, ...mw, routerIdent) + import 映射
// ---------------------------------------------------------------------------
function parseMounts(indexSrc) {
  const { masked, skel } = lex(indexSrc)
  const importFile = new Map() // ident -> routes/xxx.js
  for (const m of masked.matchAll(/import\s+(\w+)\s+from\s+['"]\.\/routes\/([\w-]+\.js)['"]/g)) importFile.set(m[1], `routes/${m[2]}`)
  const mounts = [] // { file, prefix, mw: cls, line }
  const re = /app\.use\(/g
  let m
  while ((m = re.exec(skel))) {
    const open = m.index + m[0].length - 1
    const close = matchParen(skel, open)
    if (close < 0) continue
    const args = splitArgs(masked, skel, open, close)
    if (args.length < 2) continue
    const pm = args[0].match(/^['"]([^'"]+)['"]$/)
    const last = args[args.length - 1]
    if (!pm || !importFile.has(last)) continue
    const mw = args.slice(1, -1).reduce((acc, x) => mergeCls(acc, classifyArg(x, new Map())), emptyCls())
    mounts.push({ file: importFile.get(last), prefix: pm[1], mw })
  }
  return mounts
}

// ---------------------------------------------------------------------------
// 单个路由文件 → 路由列表
// ---------------------------------------------------------------------------
function parseRouteFile(rel, src) {
  const { masked, skel } = lex(src)
  const arrays = localArrays(masked, skel)
  const routes = []
  const uses = [] // 路由器层 use：{ pos, prefix|null, cls }
  const unparsed = []
  const re = new RegExp(`(?:^|\\n)[ \\t]*(?:r|router)\\.(${VERBS.join('|')}|use|route)\\(`, 'g')
  let m
  while ((m = re.exec(skel))) {
    const verb = m[1]
    const open = m.index + m[0].length - 1
    const close = matchParen(skel, open)
    const line = lineOf(src, open)
    if (close < 0 || verb === 'route') { unparsed.push({ line, what: `r.${verb}(` }); continue }
    const args = splitArgs(masked, skel, open, close)
    if (verb === 'use') {
      const pm = args[0] && args[0].match(/^['"]([^'"]*)['"]$/)
      const rest = pm ? args.slice(1) : args
      const cls = rest.reduce((acc, x) => mergeCls(acc, classifyArg(x, arrays)), emptyCls())
      if (pm && rest.length === 1 && !/^require/.test(rest[0]) && /^[A-Za-z_$][\w$]*(\(|$)/.test(rest[0])) {
        uses.push({ pos: open, line, prefix: pm[1], cls, sub: rest[0].slice(0, 40) })
      } else {
        uses.push({ pos: open, line, prefix: pm ? pm[1] : null, cls, sub: null })
      }
      continue
    }
    const pm = args[0] && args[0].match(/^['"`]([^'"`]*)['"`]$/)
    if (!pm) { unparsed.push({ line, what: `r.${verb}(<非字面量路径>)` }); continue }
    const mwArgs = args.slice(1, -1)
    const cls = mwArgs.reduce((acc, x) => mergeCls(acc, classifyArg(x, arrays)), emptyCls())
    routes.push({ file: rel, verb: verb.toUpperCase(), path: pm[1], line, pos: open, own: cls })
  }
  return { routes, uses, unparsed }
}

const covers = (usePrefix, routePath) => usePrefix == null || usePrefix === '' || routePath === usePrefix || routePath.startsWith(usePrefix.replace(/\/$/, '') + '/')

function effectiveChain(route, uses, mounts) {
  const parts = []
  for (const mt of mounts) parts.push({ from: '挂载层', cls: mt.mw })
  for (const u of uses) {
    if (u.pos < route.pos && !u.sub && covers(u.prefix, route.path)) parts.push({ from: '路由器层', cls: u.cls })
  }
  parts.push({ from: '路由自身', cls: route.own })
  const names = []
  for (const p of parts) {
    const only = p.cls.methodOnly
    if (only && only !== route.verb) continue
    if (p.cls.exemptPaths && p.cls.exemptPaths.includes(route.path)) continue
    for (const nm of p.cls.names) if (nm !== '<handler>') names.push(nm)
  }
  return names
}

export function collect(root = ROOT) {
  const routesDir = path.join(root, 'server', 'routes')
  const indexSrc = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8')
  const allMounts = parseMounts(indexSrc)
  const files = fs.readdirSync(routesDir).filter((x) => x.endsWith('.js')).sort()
  const parsed = new Map()
  const srcOf = new Map()
  for (const f of files) {
    const rel = `routes/${f}`
    const src = fs.readFileSync(path.join(routesDir, f), 'utf8')
    srcOf.set(rel, src)
    parsed.set(rel, parseRouteFile(rel, src))
  }
  // 子路由器继承：`r.use('/warehouses', warehouseRoutes)` 的子文件运行时继承父路由器在该挂载点之前的闸门
  const inherited = new Map() // childRel -> { prefix, cls }
  const subRouters = []
  const mountsOf = (rel) => allMounts.filter((x) => x.file === rel)
  for (const [rel, { uses }] of parsed) {
    const imports = new Map()
    for (const m of lex(srcOf.get(rel)).masked.matchAll(/import\s+(\w+)\s+from\s+['"]\.\/([\w-]+\.js)['"]/g)) imports.set(m[1], `routes/${m[2]}`)
    for (const u of uses) {
      if (!u.sub) continue
      // 子路由器挂载点当作一条 USE 伪路由：挂载点之前的闸门（挂载层 + 先出现的 r.use）必须已含强闸门
      const pseudo = { file: rel, verb: 'USE', path: u.prefix || '/', line: u.line, pos: u.pos, own: emptyCls() }
      const rank = { NO_AUTH: 0, AUTH_ONLY: 1, GATED: 2 }
      let worst = null
      for (const mt of mountsOf(rel).length ? mountsOf(rel) : [null]) {
        const c = effectiveChain(pseudo, uses, mt ? [mt] : [])
        const k = c.some((x) => STRONG.has(x)) ? 'GATED' : c.includes(AUTH) ? 'AUTH_ONLY' : 'NO_AUTH'
        if (!worst || rank[k] < rank[worst.cls]) worst = { chain: c, cls: k }
      }
      const { chain, cls } = worst
      const prefixes = mountsOf(rel).map((x) => x.prefix)
      subRouters.push({ ...pseudo, prefixes, chain, cls, sub: u.sub })
      const child = imports.get(u.sub.replace(/\(.*$/, ''))
      if (child && !mountsOf(child).length) inherited.set(child, { prefix: prefixes[0] + (u.prefix || ''), cls: { names: chain, opaque: false, methodOnly: null, exemptPaths: [] } })
    }
  }
  const out = []
  const unparsed = []
  for (const [rel, { routes, uses, unparsed: un }] of parsed) {
    for (const u of un) unparsed.push({ file: rel, ...u })
    const mounts = mountsOf(rel).map((x) => ({ ...x }))
    const inh = inherited.get(rel)
    if (inh) mounts.push({ file: rel, prefix: inh.prefix, mw: inh.cls })
    const prefixes = mounts.length ? mounts.map((x) => x.prefix) : ['<未挂载>']
    for (const r of routes) {
      // 同一个路由文件可能挂在多个前缀下：逐个挂载独立计算，取**最弱**的一条（别的 URL 上的闸门不能替本 URL 背书）
      const rank = { NO_AUTH: 0, AUTH_ONLY: 1, GATED: 2 }
      let worst = null
      for (const mt of mounts.length ? mounts : [null]) {
        const chain = effectiveChain(r, uses, mt ? [mt] : [])
        const strong = chain.filter((x) => STRONG.has(x))
        const cls = strong.length ? 'GATED' : chain.includes(AUTH) ? 'AUTH_ONLY' : 'NO_AUTH'
        if (!worst || rank[cls] < rank[worst.cls]) worst = { chain, cls }
      }
      out.push({ ...r, prefixes: inh ? [inh.prefix] : prefixes, chain: worst.chain, cls: worst.cls })
    }
  }
  return { routes: out, unparsed, subRouters, mounts: allMounts }
}

// ---------------------------------------------------------------------------
// 例外表（诚实清单）。kind：
//   public        公开端点（无 requireAuth）。必须写清为什么公开、靠什么防滥用。
//   meta          静态字典/元数据，仅 requireAuth：低风险，但仍是"任何登录账号可读"。
//   self          只返回/修改调用者自己的信息。
//   handler-scope 处理器内有主体/门店/经销商/组织范围判定（storeCtx、dealerCtx、scopeFilter、assertCanRead、
//                 assertActionPermitted…）。守卫看不见这些，需人工复核；不等于"没有缺口"。
//   gap           已确认的真实缺口：写操作或敏感读仍只有 requireAuth。`pending` 标明归属工作流。
// 带 pending 的条目在报告里单列；pending 为 'unassigned' 表示尚无排期，是整改待办而不是通过的理由。
// ---------------------------------------------------------------------------
const KINDS = new Set(['public', 'meta', 'self', 'handler-scope', 'gap'])
const ALLOW = []
function group(file, kind, reason, routes, pending = null) {
  for (const [verb, p] of routes) ALLOW.push({ file: `routes/${file}`, verb, path: p, kind, reason, pending })
}

// —— 公开端点 ——
group('ai.js', 'public', '挂载层 app.use("/api/ai") 对 /manifest、/metrics 显式放行：AI 能力清单与指标定义，不含业务数据', [['GET', '/manifest'], ['GET', '/metrics']])
group('auth.js', 'public', '登录入口本身不可能先有令牌；防暴力破解靠 login-throttle / 账号锁定', [['POST', '/login']])
group('auth.js', 'public', '登录页要先选行业，行业列表只含名称/编码', [['GET', '/industries']])
group('meta.js', 'public', '健康检查（版本/构建 SHA/库可用性），供探活与登录前展示；不含业务数据', [['GET', '/health']])
group('meta.js', 'public', '字典（角色名/经销商等级/仓库类型），前端登录前即需渲染；不含业务数据', [['GET', '/dict']])
group('mall.js', 'public', '商城匿名浏览/登录入口；会话路由另有 requireMall（mall-session）', [['POST', '/login'], ['GET', '/home'], ['GET', '/products'], ['GET', '/products/:skuId']])
group('promo.js', 'public', '商城活动墙：只返回"任何人都能参与"的自动促销（见处理器内 SQL 条件）', [['GET', '/shop/promotions']])
group('qimen.js', 'public', '奇门网关模拟承接方：由 body.app_key + 签名 verifySign 在处理器内自鉴权；ADR-0028 起 app_key / 签名必填，缺失、未知平台或错签名一律 401，不再放行；生产运行时由 capabilities 关闭（503）', [['POST', '/']])

// —— 只读自身 / 自身范围 ——
group('auth.js', 'self', '返回/修改当前登录者自己的资料、权限或其数据范围内的组织树', [
  ['GET', '/me'], ['GET', '/roles'], ['POST', '/change-password'], ['POST', '/logout-all'],
  ['GET', '/org-tree'], ['GET', '/permissions'], ['GET', '/my-permissions']
])
group('approval.js', 'handler-scope', '撤回审批：cancelApproval 内判"提交人本人或管理员"（lib/approval.js）；发起审批：处理器内 assertCanRead 单据范围', [['POST', '/instances'], ['POST', '/instances/:id/cancel']])

// —— 元数据 / 字典 ——
for (const [f, p] of [['costing.js', '/meta'], ['credit.js', '/meta'], ['im.js', '/meta'], ['manufacture.js', '/meta'], ['notify.js', '/meta'], ['qc.js', '/inspections/meta'], ['qc2.js', '/meta'], ['refund.js', '/meta'], ['quote.js', '/quotes/meta']]) {
  group(f, 'meta', '模块静态元数据/枚举（状态、类型、开关），前端渲染表单与筛选用，不含单据数据', [['GET', p]])
}
group('qc2.js', 'meta', '抽样方案静态查询（AQL 表计算），无业务数据', [['GET', '/sample-plan']])
group('qimen.js', 'meta', '奇门接口能力清单（静态）', [['GET', '/capabilities']])
group('docflow.js', 'meta', '单据类型/状态机/生命周期/流转图/取号规则的静态配置读取', [
  ['GET', '/types'], ['GET', '/types/:code/machine'], ['GET', '/types/:code/lifecycle'], ['GET', '/flows'], ['GET', '/flows/:code'], ['GET', '/no-rules']
])
group('docflow.js', 'meta', '取号规则效果预览（不消耗序号，纯计算）', [['POST', '/no-preview']])
group('docflow.js', 'handler-scope', '/actions 在处理器内 assertCanRead；/transition 在处理器内 assertEdgePermitted + 单据主体/组织范围（ADR 单据流转）', [['GET', '/actions'], ['POST', '/transition']])
group('docflow.js', 'handler-scope', '/no-issue 非 dry 时在处理器内按 DOC_CREATE_PERMS（lib/docflow.js 唯一映射表）要求该单据类型的创建权限，未映射类型 403 DOC_TYPE_PERM_UNMAPPED；dry 只读预览豁免（ADR-0028）', [['POST', '/no-issue']])

// —— 门店 / 经销商 / 订货主体：处理器内按绑定主体收口 ——
group('pos.js', 'handler-scope', '门店 POS：storeCtx 要求账号绑定 store_id 并只读写本店；未设 role/perm 闸门，即任何绑定门店的账号都可操作（班次核款/驳回 approve|reject 靠 lib/pos2 内的角色判定）。是否应加 requireStore/requirePerm 待评估', [
  ['GET', '/context'], ['GET', '/products'], ['GET', '/orders'], ['GET', '/orders/:id'], ['GET', '/stocks'],
  ['GET', '/shifts'], ['GET', '/shifts/open'], ['GET', '/shifts/:id'], ['POST', '/shifts/:id/reject'], ['POST', '/shifts/:id/approve'], ['POST', '/shifts/:id/cancel'],
  ['GET', '/cash-drops'], ['GET', '/cash-drops/pending-shifts'], ['POST', '/cash-drops/:id/receive'], ['POST', '/cash-drops/:id/cancel'],
  ['GET', '/daily-closes'], ['GET', '/returns'], ['GET', '/stock-checks'], ['GET', '/stock-checks/:id']
], 'unassigned')
group('requisitions.js', 'handler-scope', '门店要货：storeCtx 要求绑定门店，只读写本店单据', [['GET', '/store/mine'], ['GET', '/store/shipments/mine'], ['GET', '/store/shipments/:id'], ['POST', '/store/shipments/:id/receive']])
group('demand.js', 'handler-scope', '经销商"我的"要货/计划：dealerCtx 要求绑定经销商，只读本经销商', [['GET', '/dealer/requisitions/mine'], ['GET', '/dealer/plans/mine']])
group('sales.js', 'handler-scope', '销售读接口：scopeFilter / assertCanRead 只按经销商/门店绑定收口（scopePairs），不按内部账号的组织数据范围过滤；data_scope=org 的内部账号可读他组织订单/发货/退货/统计', [
  ['GET', '/orders'], ['GET', '/orders/:id'], ['GET', '/deliveries'], ['GET', '/deliveries/:id'], ['GET', '/returns'], ['GET', '/stats']
], 'unassigned')
group('quote.js', 'handler-scope', '报价动作：处理器内按动作再选 requirePerm（动态权限码），守卫看不到', [['POST', '/quotes/:id/action']])
group('order-center.js', 'handler-scope', '订货中心：路由器层 requireAuth + attachOrgScope + 客户主体准入（checkCustomerAccess）只收口经销商/门店自身主体；内部账号即使 data_scope=org 也读到全局（如 /overview 的 customerIds=null、/customers、/customers/tree），组织范围未落实。外部角色是本模块的正常用户，故不要求 perm 码', [
  ['GET', '/overview'], ['GET', '/flow'], ['GET', '/policies'], ['GET', '/customers'], ['GET', '/customers/tree'], ['GET', '/customers/:id'],
  ['GET', '/catalog'], ['POST', '/quote'], ['GET', '/orders'], ['GET', '/orders/:id'], ['GET', '/orders/:id/repeat'], ['GET', '/orders/:id/actions'],
  ['POST', '/orders/:id/:action'], ['GET', '/credit/:customerId'], ['GET', '/statements'], ['GET', '/statements/:id']
], 'unassigned')

// —— 采购链：ADR-0017 收口列表/概览，ADR-0020（W1）收口详情/预览/计划/目录；剩余写路径见下 ——
group('purchase-chain.js', 'gap', 'ADR-0020 边界：收货核对仍只有 requireAuth，未过 readGate，也未按组织范围判定', [
  ['POST', '/orders/:id/receive-check']
], 'unassigned')
group('purchase-chain.js', 'handler-scope', '动作路由：处理器内 assertActionPermitted 按动作校验权限码；这些动作路由的单据级组织范围判定仍未做（POST /payments、/settlements 的自动分配与来源选择已由 ADR-0028 按范围收口，它们本身有 requirePerm）', [
  ['POST', '/requisitions/:id/:action'], ['POST', '/invoices/:id/:action'], ['POST', '/settlements/:id/:action'], ['POST', '/payments/:id/:action']
], 'unassigned')

// —— 其它 ——
group('auth.js', 'handler-scope', '组织档案平铺列表：处理器内按 resolveOrgScope 裁剪（admin / 全局范围全量，其余只含范围内组织，经销商另含挂靠组织，空范围 ⇒ 空列表）；ADR-0028', [['GET', '/orgs']])

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const key = (x) => `${x.file} ${x.verb} ${x.path}`

export function evaluate(root = ROOT) {
  const { routes, unparsed, subRouters } = collect(root)
  const problems = []
  const byKey = new Map()
  for (const e of ALLOW) {
    if (!KINDS.has(e.kind)) problems.push(`例外表条目 kind 非法：${key(e)} (${e.kind})`)
    if (!e.reason || e.reason.length < 8) problems.push(`例外表条目缺少理由：${key(e)}`)
    if (byKey.has(key(e))) problems.push(`例外表重复条目：${key(e)}`)
    byKey.set(key(e), e)
  }
  const seen = new Set()
  const all = [...routes, ...subRouters]
  for (const r of all) {
    const k = key(r)
    const e = byKey.get(k)
    if (r.cls === 'GATED') {
      if (e) problems.push(`过期登记：${k} 现在已有强闸门（${r.chain.filter((x) => STRONG.has(x)).join(',')}），请从 ALLOW 删除`)
      continue
    }
    if (!e) { problems.push(`未登记：${k} (${r.cls}，链：${r.chain.join(' → ') || '无'}) —— 加闸门，或在 ALLOW 里写明理由`); continue }
    seen.add(k)
    const want = e.kind === 'public' ? 'NO_AUTH' : 'AUTH_ONLY'
    if (r.cls !== want) problems.push(`登记与现实不符：${k} 登记为 ${e.kind}（应为 ${want}）但实际是 ${r.cls}`)
  }
  // 不可解析的注册方式（r.route()、动态路径）看不到授权链：默认红，必须改成字面量写法
  for (const u of unparsed) problems.push(`不可解析的路由注册：${u.file}:${u.line} ${u.what} —— 改成 r.<verb>('/字面量路径', …) 写法，守卫才能检查`)
  for (const e of ALLOW) if (!seen.has(key(e)) && !all.some((r) => key(r) === key(e))) problems.push(`过期登记：${key(e)} 已不存在于路由文件`)
  return { routes: all, unparsed, problems, allow: byKey }
}

function main() {
  const { routes, unparsed, problems, allow } = evaluate()
  const count = (c) => routes.filter((r) => r.cls === c).length
  if (LIST) {
    for (const r of routes) console.log(`${r.cls.padEnd(9)} ${r.prefixes.join('|')}${r.path === '/' ? '' : r.path}  [${r.file}:${r.line}] ${r.verb}  ${r.chain.join(' → ') || '(无)'}`)
  }
  const pend = {}
  for (const e of allow.values()) if (e.pending) (pend[e.pending] ||= []).push(e)
  console.log(`路由 ${routes.length} 条：GATED ${count('GATED')} / AUTH_ONLY ${count('AUTH_ONLY')} / NO_AUTH ${count('NO_AUTH')}；已登记例外 ${allow.size} 条；不可解析调用 ${unparsed.length} 处`)
  for (const [k, list] of Object.entries(pend)) {
    console.log(`  待办 pending=${k}：${list.length} 条`)
  }
  for (const p of problems) console.log(`  ✗ ${p}`)
  console.log(`通过 ${routes.length - problems.length} / 失败 ${problems.length}`)
  process.exit(problems.length ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main()
