/**
 * ============================================================================
 * 文件标识：scripts/check-api-contract.mjs ｜ 静态守卫：前后端契约漂移检查
 * ============================================================================
 * 【职责】静态守卫：前后端契约漂移检查
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 前后端契约漂移检查
// 用法：node scripts/check-api-contract.mjs
//
// 检查两件事：
//   ① 生成的类型文件与 openapi.js 是否一致（有人改了接口没跑 gen:api）
//   ② 前端代码里实际调用的接口路径，是否都登记在 OpenAPI 里
//
// 为什么②比①更重要：
//   ①只能发现「忘了重新生成」，②能发现「前端在打一个后端根本没登记的接口」。
//   后者是真正的漂移 —— 页面在开发机上碰巧能用（后端有那个路由），
//   但契约里没有它，换个人接手、或者做 SDK 生成时就会漏掉。
//   这类问题不会报错，只会「文档里查不到这个接口」。
//
// 已知豁免：
//   - 路径含 `??`/三元等动态拼接的，无法静态判定，跳过（不假装检查了）
//   - MCP / 奇门等面向外部系统的接口，前端不调用

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOpenApi } from '../server/openapi.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const spec = buildOpenApi()
const routes = Object.keys(spec.paths || {})
const OUT_FILE = path.join(ROOT, 'src', 'types', 'api-routes.ts')

let problems = 0
const bad = (msg) => {
  problems += 1
  console.log(`  ✗ ${msg}`)
}
const good = (msg) => console.log(`  ✓ ${msg}`)

// ---------------------------------------------------------------------------
// ① 生成文件是否最新
// ---------------------------------------------------------------------------
console.log('\n① 契约类型文件与 openapi.js 是否一致')

if (!fs.existsSync(OUT_FILE)) {
  bad('src/types/api-routes.ts 不存在，请执行 npm run gen:api')
} else {
  const onDisk = fs.readFileSync(OUT_FILE, 'utf-8')
  // 只比「路径集合」，不整文件比对 —— 整文件比对会因为注释/格式微调误报
  const diskRoutes = new Set(
    [...onDisk.matchAll(/^  '(\/api\/[^']+)',$/gm)].map((m) => m[1])
  )
  const specRoutes = new Set(routes)
  const missing = [...specRoutes].filter((r) => !diskRoutes.has(r))
  const extra = [...diskRoutes].filter((r) => !specRoutes.has(r))
  if (missing.length) bad(`有 ${missing.length} 条接口未写进类型文件（如 ${missing.slice(0, 3).join(', ')}），请执行 npm run gen:api`)
  else if (extra.length) bad(`类型文件里有 ${extra.length} 条接口已不在 OpenAPI（如 ${extra.slice(0, 3).join(', ')}），请执行 npm run gen:api`)
  else good(`类型文件覆盖 ${specRoutes.size} 条接口，无遗漏`)

  const v = /OPENAPI_VERSION = '([^']+)'/.exec(onDisk)?.[1]
  if (v !== spec.info.version) bad(`类型文件契约版本 ${v} ≠ openapi.js 的 ${spec.info.version}`)
  else good(`契约版本一致（${v}）`)
}

// ---------------------------------------------------------------------------
// ② 前端调用是否都在契约里
// ---------------------------------------------------------------------------
console.log('\n② 前端实际调用的接口是否都登记在 OpenAPI')

/** 把 OpenAPI 路径模板转成匹配正则：`{id}` → 任意一段 */
const routeToRegex = (r) =>
  new RegExp('^' + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}/g, '[^/]+') + '$')

// 每条契约路径**连它声明了哪些方法**一起带上 —— ③ 要比的就是这个集合。
// 只比路径不比方法的后果是实测过的：`/api/purchase/settlement-preview` 契约写 POST、
// 真实路由与前端都是 GET，而本检查照样报"全部通过"。
const routeRegexes = routes.map((r) => ({
  r,
  re: routeToRegex(r),
  methods: new Set(Object.keys(spec.paths[r]).map((m) => m.toLowerCase()))
}))

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name)
    if (f.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(f.name)) out.push(p)
  }
  return out
}

/**
 * 通用 CRUD 助手：路径由调用方传入（`${path}/${id}`），文件里根本没有具体接口名。
 * 这类没法静态判定，显式排除并说明 —— 悄悄跳过会让「% 处已覆盖」这个数字说谎。
 */
const SKIP_FILES = new Set(['src/components/DataPage.tsx'])

const files = walk(path.join(ROOT, 'src')).filter(
  (f) => !SKIP_FILES.has(path.relative(ROOT, f).split(path.sep).join('/'))
)
const callRe = /\bapi\.(get|post|put|del)\(\s*(['"`])([^'"`]*)\2/g

let checked = 0
let skipped = 0
const unmatched = []
const methodDrift = []
/** 前端写法 → HTTP 方法（`api.del` 是 DELETE） */
const METHOD_OF = { get: 'get', post: 'post', put: 'put', del: 'delete' }

for (const file of files) {
  const src = fs.readFileSync(file, 'utf-8')
  for (const m of src.matchAll(callRe)) {
    const [, fn, , raw] = m
    const rel = path.relative(ROOT, file)
    // 含插值的路径：\${...} 统一换成占位段，再参与匹配
    const hasInterp = /\$\{/.test(raw)
    let p = raw.split('?')[0]
    if (hasInterp) p = p.replace(/\$\{[^}]*\}/g, '__P__')
    else if (!p.startsWith('/') || p.includes('${')) { skipped += 1; continue }

    // 相对路径（不含 /api 前缀）补全，与既有写法兼容
    const full = p.startsWith('/api') ? p : `/api${p}`
    const hit = full.includes('__P__')
      ? routeRegexes.find(({ re }) => re.test(full.replace(/__P__/g, 'X')))
      : routeRegexes.find(({ r }) => r === full)
    if (hit) checked += 1
    else unmatched.push(`${rel} → ${raw}${full.includes('__P__') ? '（动态段）' : ''}`)
    // ③ 的观测点：路径命中了，但**方法**没在契约里声明
    if (hit && !hit.methods.has(METHOD_OF[fn])) {
      methodDrift.push({ key: `${rel} → api.${fn} ${raw}`, file: rel, fn, raw, contract: [...hit.methods].sort().join('/') })
    }
  }
}

if (unmatched.length) {
  bad(`${unmatched.length} 处前端调用未登记在 OpenAPI：`)
  for (const u of unmatched.slice(0, 25)) console.log(`      ${u}`)
  if (unmatched.length > 25) console.log(`      …还有 ${unmatched.length - 25} 处`)
} else {
  good(`前端 ${checked} 处调用全部已在契约内（跳过动态拼接无法静态判定的 ${skipped} 处）`)
}

// ---------------------------------------------------------------------------
// ③ 前端调用的**方法**是否也在契约里
// ---------------------------------------------------------------------------
// 为什么必须单列一条：② 只比路径。`api.post('/x')` 与 `api.get('/x')` 在 ② 眼里
// 是同一件事 —— 于是一个"契约写 POST、真实路由与前端都是 GET"的接口（真实发生过：
// `/api/purchase/settlement-preview`）能让 ② 报"全部通过"，而任何按契约生成的
// SDK/调用方都会打错方法、拿 404。
//
// 已知漂移是**现状快照**，不是"这样也行"（表里的条目全都要修，只是不该由本检查
// 一个人一次性拦住全队）：实测漂移 ⊆ 表里 ⇒ 不报；表里多出一行（＝有人修好了）
// ⇒ 报"表过期"。两边的判据都必须有，否则这张表要么变成橡皮图章、要么变成噪音。
console.log('\n③ 前端调用的 HTTP 方法是否也在契约里')

// ⚠️ **这张表现在是空的，而且必须保持空**（不是"允许有"）。
//   它曾经有 5 行（本批修掉的 5 处：2 处 ArError 同名键覆盖、1 处 DELETE 未登记、
//   1 处 GET 未登记、1 处前端打错方法）。判据是双向的：
//     · 实测漂移 ⊄ 表  ⇒ 报"新增方法漂移"（新错立刻拦）
//     · 表 ⊄ 实测漂移  ⇒ 报"清单已过期"（修好了却不删行 = 橡皮图章）
//   所以判据**不会**因为表空而失效：新出现的漂移仍然会红。
//   ⚠️ 认契约**不许用"正则首命中"**（`{id}` → `[^/]+` 会把 `/api/invoices/from-delivery`
//   错认成 `/api/invoices/{id}`，我第一版预探就因此误报了 5 处）。
//   本判据对字面路径走"模板全等"、只有含插值的路径才用占位段 —— 与 ② 同一套匹配方式。
const DECLARED_METHOD_DRIFT = {}

const measuredKeys = new Set(methodDrift.map((d) => d.key))
const newDrift = methodDrift.filter((d) => !(d.key in DECLARED_METHOD_DRIFT))
const staleDrift = Object.keys(DECLARED_METHOD_DRIFT).filter((k) => !measuredKeys.has(k))

if (methodDrift.length) {
  console.log(`  实测方法漂移 ${methodDrift.length} 处（已登记 ${Object.keys(DECLARED_METHOD_DRIFT).length} 处）：`)
  for (const d of methodDrift) console.log(`      · ${d.key}（契约只声明了 ${d.contract}）`)
} else {
  console.log('  实测方法漂移 0 处')
}
if (newDrift.length) {
  bad(`新增 ${newDrift.length} 处方法漂移（契约里没声明这个方法）：`)
  for (const d of newDrift) console.log(`      · ${d.key}（契约只声明了 ${d.contract}）—— 要么补契约、要么改前端`)
} else {
  good('新增方法漂移：0（实测漂移全部在已知清单里）')
}
if (staleDrift.length) {
  bad(`已知漂移清单有 ${staleDrift.length} 行已过期（实测不存在了，请从 DECLARED_METHOD_DRIFT 删掉）：`)
  for (const k of staleDrift) console.log(`      · ${k}`)
} else {
  good('已知漂移清单不过期：表里每一行都能在实测里找到')
}

// ---------------------------------------------------------------------------
// ④ openapi.js 里每个路径只声明一次（重复键 ⇒ 后一行覆盖前一行）
// ---------------------------------------------------------------------------
// 为什么单列一条：本文件（`server/openapi.js`）是一个巨大的**对象字面量**，
// 同一路径写成上下两行同名键时，JS 取**后一行**，前一行**整段静默失效**。
// 实测代价分两档，第二档更阴：
//   · 丢方法 —— `/api/ar/documents` 写成 `{get}` 紧跟 `{post}` ⇒ `get` 声明消失，
//     前端 `api.get('/ar/documents')` 与真实路由都是 GET，而契约里查不到 GET；
//   · 不丢方法、但前一行是**死文本** —— 两行声明同一方法时方法还在，
//     可前一行写的 summary / parameters 永远不生效。
//     ⇒ **改文档的人改到那一行、保存、以为生效了**，而导出与类型生成都不是它。
// 这两档的共同点：**声明写了两遍，生效的只有一遍**，且没有任何东西会响。
//
// 判据（表空 = 不留后患的终态）：
//   ① 命中行数 ≥ 100             —— 一个路径键都没扫到，是本判据错了，不是文档对了
//   ② 唯一键数 == spec.paths 条数 —— 源码里写了路径键却不在对象里
//                                   （被同名行覆盖 / 被注释掉 / 缩进写错 / 写错对象）
//   ③ 实测重复键集合 ⊆ 登记表     —— 新出现的重复键立刻红
//   ④ 登记表 ⊆ 实测重复键集合     —— 合并了却没删登记行 = 表过期，也红
// ⚠️ 表里**只登记路径、不登记行号**：行号每改一次文档就变，把它写进表等于给未来埋一个
//   必然触发的假红。行号在每次运行时**现算现打**（它才是给人看的那一半）。
//
// ⚠️ **已知缺口 · 待决定**（写在这里是为了"没做要可见"，不是遗漏）：
//    合并那 12 处重复键时，旧的 POS 那几行多声明了一个 `date`（营业日）参数，
//    而**真实路由并不读它**（`routes/pos.js:921-933` 一个 query 都不读、`:937-942` 只读 `store_id`）。
//    ⇒ `date` 未文档化 —— 补它牵动 contract / API / auth 抽取，属另一轮；本轮只做方法比对。
//    （补一个"后端不读的参数"比"少写一个方法"更坏：它是**主动承诺**，而且会成为同族写法的样板。）
console.log('\n④ openapi.js 里每个路径只声明一次')

// ⚠️ **本表现在是空的，而且必须保持空**（不是"允许有"）。它曾登记 12 处
//   （调拨 2 条 + POS 10 条），已全部合并 —— 合并口径：**保留两边方法与字段的并集**。
//   判据是双向的，所以表空不会让它失效：
//     · 实测重复 ⊄ 表 ⇒ 红（**第 13 处立刻拦**）
//     · 表 ⊄ 实测重复 ⇒ 红（合并了却没删这行 = 表过期）
//
// ⚠️ 两条判据**各管一个洞，都得在**（这条是反例实测出来的，不是推理）：
//   · `唯一键数 == 契约路径数` —— 抓的是"**源码里写了路径键却没进对象**"
//     （被同名行覆盖到只剩一份也算重复、被注释掉、缩进写错、写到了别的对象里）。
//     反例实测：人为复制一行 key 之后，唯一键数**仍然是 481 == 481** ——
//     因为复制的是一个已存在的键，唯一数不变 ⇒ **这条判据抓不到重复键**。
//   · `同一路径只出现一次` —— 才是抓重复键的那条。
//   只留任何一条，都会留下一半的洞。
const DECLARED_DUP_KEYS = new Set([])

/** 顶层路径键的行锚点：`paths` 对象里每个路径都写成 `    '/api/xxx': ...`（4 空格缩进） */
const OPENAPI_KEY_RE = /^\s{4}'(\/api\/[^']+)':/
const openapiSrc = fs.readFileSync(path.join(ROOT, 'server', 'openapi.js'), 'utf-8')
const keyHits = []
openapiSrc.split('\n').forEach((line, i) => {
  const m = OPENAPI_KEY_RE.exec(line)
  if (m) keyHits.push({ line: i + 1, key: m[1] })
})
const byKey = new Map()
for (const h of keyHits) {
  if (!byKey.has(h.key)) byKey.set(h.key, [])
  byKey.get(h.key).push(h.line)
}
const dups = [...byKey.entries()].filter(([, lines]) => lines.length > 1)
const dupKeys = new Set(dups.map(([k]) => k))
const newDup = [...dupKeys].filter((k) => !DECLARED_DUP_KEYS.has(k))
const staleDup = [...DECLARED_DUP_KEYS].filter((k) => !dupKeys.has(k))

if (keyHits.length >= 100) good(`扫描面自证：命中 ${keyHits.length} 个顶层路径键`)
else bad(`扫描面自证：只命中 ${keyHits.length} 个顶层路径键（≥100 才说明锚点对得上，否则这里"全绿"是假的）`)

if (byKey.size === routes.length) {
  good(`唯一路径键 ${byKey.size} 个 == 契约路径 ${routes.length} 条`)
} else {
  bad(`唯一路径键 ${byKey.size} 个 ≠ 契约路径 ${routes.length} 条 —— 源码里写了路径键却没进对象（被同名键覆盖 / 缩进写错 / 写错了对象）`)
}

if (dups.length) {
  console.log(`  实测重复路径键 ${dups.length} 处（已登记 ${DECLARED_DUP_KEYS.size} 处）—— 后一行覆盖前一行，前一行整段声明静默失效：`)
  for (const [k, lines] of dups) console.log(`      · ${k} → 行 ${lines.join(', ')}`)
} else {
  console.log('  实测重复路径键 0 处')
}
if (newDup.length) {
  bad(`新增 ${newDup.length} 处重复路径键（同一路径写了两遍，前一行不生效）：`)
  for (const k of newDup) console.log(`      · ${k} → 行 ${(byKey.get(k) || []).join(', ')}`)
} else {
  good('新增重复路径键：0（实测重复全部在已知清单里）')
}
if (staleDup.length) {
  bad(`已知重复键清单有 ${staleDup.length} 行已过期（实测不再重复，请从 DECLARED_DUP_KEYS 删掉）：`)
  for (const k of staleDup) console.log(`      · ${k}`)
} else {
  good('已知重复键清单不过期：表里每一行都能在实测里找到')
}

console.log('\n' + '─'.repeat(60))
console.log(problems ? `契约检查：${problems} 项问题` : '契约检查：全部通过')
process.exitCode = problems ? 1 : 0
