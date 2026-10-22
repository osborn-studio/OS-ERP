#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-env-pinning.mjs ｜ 静态守卫：隔离闸门守卫（**唯一一份**）：`GML_DATA_DIR` 钉得**有没有效**。
 * ============================================================================
 * 【职责】静态守卫：隔离闸门守卫（**唯一一份**）：`GML_DATA_DIR` 钉得**有没有效**。
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
 * 隔离闸门守卫（**唯一一份**）：`GML_DATA_DIR` 钉得**有没有效**。
 *
 *  就是这一句害人：`server/db/index.js` 的
 *      DATA_DIR = process.env.GML_DATA_DIR || <仓库>/data        // 模块加载时求值一次
 *  而 **ESM 静态 import 在模块体之前全部求值完** ⇒ 脚本顶层那句
 *      process.env.GML_DATA_DIR = '<隔离目录>'
 *  对"在它之前就已经求值的模块"**来不及**。于是"我自落到 /tmp"是假的：
 *  进程内 DB 访问悄悄打开**仓库 data/**，不报错、不告警，输出照样全绿。
 *  本仓真栽过：`scripts/test-kernel-migrate.mjs` 的自落目录算了、没钉 env，
 *  在 `regress-all`（不设任何 env）下打开的其实是**仓库 `data/gml_*.db`**，而输出一切正常。
 *
 * ── 判据由**两格**组成（第二格是本轮新发现、必须有的）──────────────────────────
 *   ① **全静态闭包**：从入口出发，能不能**一路全静态**走到 `server/db/index.js`。
 *      能 ⇒ 暴露（`db/index.js` 在"钉 env"那行之前就求值了）。
 *      为什么只跟静态：**动态 `import()` 是一条边界** —— 跨过它 env 已经钉好，
 *      "某个被动态引入的模块内部还有静态 import"是无害的（那次求值发生在 `await import()` 时）。
 *   ② **次序**：脚本里出现动态 `import('X')` 时，若 **X 的（静态 ∪ 动态）闭包能到达
 *      `server/db/index.js`**，那么**这一行的行号必须 > 钉 env 的行号**；否则暴露。
 *      ⚠️ 这一格为什么不能省（本轮实证）：把 env 钉在
 *      `await import('../server/lib/stock.js')` **之后** ——
 *      ① 看不见任何指向 db 的静态边 ⇒ **放行**；若次序判据只认"直接动态 import db/index.js"，
 *      也 **放行**；可运行期 `stock.js → costing.js → docflow.js → db/index.js` **已经求值完**了。
 *      实测 A 形态（钉 env 写在那一跳之后）⇒ `DATA_DIR` = **仓库 data/**；B 形态（写在之前）⇒ `/tmp/…`。
 *      所以 ② 必须问"**这一跳的闭包能不能到达 db**"，而不是"这一跳是不是 db"。
 *
 * ── /tmp vs /private/tmp（**动作**，不是提醒）────────────────────────────────
 * 这类脚本的"落点闸门"通常写成"`DATA_DIR` 必须以 `/tmp/` 开头"。在 macOS 上 **`realpath` 会把
 * `/tmp` 解析成 `/private/tmp`** ⇒ **不许拿 `fs.realpathSync()` 的结果去比前缀**（那会**误拒**合法落点：
 * fail-safe、不会误放，但会变成一条会咬人的假红）。**动作 = 比"原样字符串"**：闸门里的
 * `ISOLATED_DIR` 由 `path.join('/tmp', …)` 造出、`db/index.js` 也按 env 原样使用 ⇒ 两边形式一致。
 *
 * ── 已知边界（照实写，别当全覆盖）─────────────────────────────────────────────
 *   · **非字面量动态 import**（`import(path.join(ROOT, '…'))`）**本身是安全的**（不可能被提升），
 *     **不必当洞、不必人工过**（`accept/selfcheck.mjs` 的 7 处全是这种）。
 *     但它是次序格 ② 的**残余盲区**：解析不出目标 ⇒ 若脚本把 pin 写在它**之后**、而它闭包可达 db，
 *     本守卫判不出。这类脚本请人工扫一眼 pin 与它的先后。
 *   · **正则字面量**里含 `//` 或 `/*`（如 `/a\/\//`）可能被掩码器误当注释起点（极端少见）；
 *     模板串 `${...}` 内的表达式会被一并遮蔽。两者都只让判据偏保守，不会放过真洞。
 *   · **`.cjs` 不在判据内**：`require()` 不像 ESM 静态 import 那样被提升 ⇒ "先钉 env、后 require"
 *     本身**有效**，所以不必怀疑 `.cjs`。
 *   · 本文件自身含**合成样本字面量**（在字符串里），故从扫描面**排除**，否则会自我误报。
 *
 * 用法：node scripts/check-env-pinning.mjs     （无参数；纯静态、零副作用：不开库 / 不 spawn / 不写文件）
 * 退出码：0 = 全绿；1 = 有断言失败（含：合成样本没被拦、扫描面为空）；2 = 用法错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = fileURLToPath(import.meta.url)
const DB_INDEX = path.join(ROOT, 'server/db/index.js')
const SCAN_DIR = path.join(ROOT, 'scripts')
const SKIP_DIRS = new Set(['node_modules', '.git'])

const argv = process.argv.slice(2)
if (argv.length) {
  console.error(`✗ 未知参数：${argv.join(' ')}\n`)
  console.error('用法：node scripts/check-env-pinning.mjs   （无参数）')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 一、把源码里的 import 拆成"静态 / 动态字面量 / 动态非字面量"
// ---------------------------------------------------------------------------
export function parseImports(src) {
  const statics = []
  const dynLit = []
  const dynExpr = []
  for (const m of src.matchAll(/^[ \t]*import\s+(?:[^('"\n]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) statics.push(m[1])
  for (const m of src.matchAll(/^[ \t]*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm)) statics.push(m[1])
  for (const m of src.matchAll(/\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)) dynLit.push(m[2])
  for (const m of src.matchAll(/\bimport\s*\(\s*([^'"`\s)][^)]*)\)/g)) dynExpr.push(m[1].replace(/\s+/g, ' ').slice(0, 40))
  return { statics, dynLit, dynExpr }
}

// ---------------------------------------------------------------------------
// 一之二、掩码扫描器：注释 / 字符串分别遮蔽成**等长空格**（保留换行 ⇒ 行号不变）
// ---------------------------------------------------------------------------
// 为什么需要："判 pin"若直接在原文找 `process.env.GML_DATA_DIR =`，那么**注释或字符串里提到**
// 也会算"这个脚本钉了 env" ⇒ 一个不钉 env、只在注释里引用的脚本进了候选，若它静态可达 db
// 就变成一条**假红**。掩码后判断，注释/字符串里的引用不算数。
export function mask(rawSrc, { strings = false } = {}) {
  const out = rawSrc.split('')
  const n = rawSrc.length
  let i = 0
  const blank = (k) => {
    if (rawSrc[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const c = rawSrc[i]
    const d = rawSrc[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && rawSrc[i] !== '\n') blank(i++)
      continue
    }
    if (c === '/' && d === '*') {
      blank(i); blank(i + 1); i += 2
      while (i < n && !(rawSrc[i] === '*' && rawSrc[i + 1] === '/')) blank(i++)
      if (i < n) { blank(i); blank(i + 1); i += 2 }
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      if (strings) blank(i)
      i++
      while (i < n) {
        if (rawSrc[i] === '\\') { if (strings) { blank(i); blank(i + 1) } i += 2; continue }
        if (rawSrc[i] === q) { if (strings) blank(i); i++; break }
        if (strings) blank(i)
        i++
      }
      continue
    }
    i++
  }
  return out.join('')
}

const PIN_RE = /process\.env\.GML_DATA_DIR\s*=/
/** 这个脚本**真的**钉了 env 吗？（注释 / 字符串里的引用不算） */
export const pinnedIn = (src) => PIN_RE.test(mask(src, { strings: true }))
const lineOf = (src, idx) => (idx < 0 ? -1 : src.slice(0, idx).split('\n').length)

// ---------------------------------------------------------------------------
// 二、闭包求解（跑在"文件源"抽象上 ⇒ 真实文件系统与内存合成样本共用一份实现）
//     follow: 'static'（判据①）| 'union'（判据②：静态 ∪ 动态字面量）
// ---------------------------------------------------------------------------
function closure({ entry, read, resolve, target, follow = 'static' }) {
  if (path.resolve(entry) === path.resolve(target)) return { hit: true, trail: [] }
  const seen = new Set([entry])
  const queue = [[entry, []]]
  while (queue.length) {
    const [file, trail] = queue.shift()
    const src = read(file)
    if (src == null) continue
    const { statics, dynLit } = parseImports(src)
    const specs = follow === 'static' ? statics : [...statics, ...dynLit]
    for (const spec of specs) {
      const to = resolve(spec, file)
      if (!to) continue
      const next = [...trail, { from: file, spec, to }]
      if (path.resolve(to) === path.resolve(target)) return { hit: true, trail: next }
      if (seen.has(to)) continue
      seen.add(to)
      queue.push([to, next])
    }
  }
  return { hit: false, trail: [] }
}

/** 渲染逐跳路径：`A --[spec]--> B --[spec]--> db/index.js` */
function renderTrail(entry, trail) {
  const rel = (p) => (p.startsWith('/virtual') ? p.replace('/virtual/', '⟨样本⟩/') : path.relative(ROOT, p))
  return [rel(entry), ...trail.map((h) => `${h.spec} ⇒ ${rel(h.to)}`)].join('  --[静态/动态]-->  ')
}

// ---------------------------------------------------------------------------
// 三、次序判据（②）：每个**可解析**的动态 import，其（静态∪动态）闭包若可达 db，
//     则该行的行号必须 > 钉 env 的行号
// ---------------------------------------------------------------------------
export function orderCheck({ src, baseFile, resolve, read, target, pinLine }) {
  const cMask = mask(src, { strings: false })
  const { dynLit } = parseImports(src)
  const dyn = []
  for (const spec of dynLit) {
    // ⚠️ 必须**相对 baseFile** 解析（`resolve(spec, baseFile)`）—— 而闭包里的每一跳再用
    //    `resolve(spec, 当前文件)`。曾经这里传的是"把基准钉死成脚本自身"的 1 参 resolver，
    //    于是多跳解析全错、A 形态被放行（**假绿**）；是"临时红态样本"把这一格抓出来的。
    const to = resolve(spec, baseFile)
    if (!to) continue
    // 锚定 `import(` 定位行号（同模块若也写了静态 import，直接找 specifier 会指错行）
    const re = new RegExp(`import\\s*\\(\\s*['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`)
    const line = lineOf(cMask, cMask.search(re))
    dyn.push({ spec, to, line })
  }
  const violations = []
  for (const d of dyn) {
    const c = closure({ entry: d.to, read, resolve, target, follow: 'union' })
    if (c.hit && !(d.line > pinLine)) violations.push({ ...d, trail: c.trail })
  }
  return { dyn, violations }
}

// ---- 真实文件系统适配 ----
const fsRead = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
const fsResolve = (spec, fromFile) => {
  if (!spec.startsWith('.')) return null // 裸包 / node: 内置 ⇒ 到不了 db/index.js
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const c of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js')]) {
    try { if (fs.statSync(c).isFile()) return c } catch { /* 不存在 */ }
  }
  return null
}
// ---- 虚拟文件系统适配（**仅供自证**：内存样本，绝不落盘）----
function virtualFs(files) {
  return {
    read: (f) => (f in files ? files[f] : null),
    resolve: (spec, fromFile) => {
      if (!spec.startsWith('.')) return null
      const base = path.resolve(path.dirname(fromFile), spec)
      for (const c of [base, `${base}.js`, `${base}.mjs`]) if (c in files) return c
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// 四、断言收集
// ---------------------------------------------------------------------------
let pass = 0
let failed = 0
const failNames = []
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; failNames.push(name); console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`) }
}
const rel = (p) => path.relative(ROOT, p)

console.log('隔离闸门守卫（纯静态 · 零副作用）')
console.log(`判据①：凡自己给 GML_DATA_DIR 赋值的脚本，其**全静态 import 闭包**不得命中 ${rel(DB_INDEX)}`)
console.log('判据②：其**动态 import** 若闭包可达 db/index.js，则该行必须**在钉 env 之后**')

// ---------------- ① 判据自证：内存合成样本（不落盘） ----------------
console.log('\n① 判据自证（内存合成样本，不落盘）')
{
  const V = '/virtual'
  const files = {
    [`${V}/entry-bad.mjs`]: "import './mid.mjs'\n",
    [`${V}/mid.mjs`]: "import './target.mjs'\n",
    [`${V}/entry-good.mjs`]: "await import('./mid.mjs')\n", // 动态 import = 边界
    [`${V}/entry-good2.mjs`]: "import('./mid.mjs')\n", // 非 await 的动态同样边界
    [`${V}/target.mjs`]: 'export const x = 1\n'
  }
  const v = virtualFs(files)
  const target = `${V}/target.mjs`
  const bad = closure({ entry: `${V}/entry-bad.mjs`, read: v.read, resolve: v.resolve, target })
  ok('自证（多跳静态）：**全静态** bad 样本必须被判命中', bad.hit === true, bad.hit ? '' : '合成 bad 样本没被命中 ⇒ 判据已失效')
  ok(
    '自证（多跳静态）：必须真的走**两跳**并给得出逐跳路径（否则是"只走一跳"的假绿）',
    bad.hit && bad.trail.length === 2 && bad.trail[0].spec === './mid.mjs' && bad.trail[1].spec === './target.mjs',
    JSON.stringify(bad.trail.map((h) => h.spec))
  )
  for (const g of ['entry-good.mjs', 'entry-good2.mjs']) {
    const good = closure({ entry: `${V}/${g}`, read: v.read, resolve: v.resolve, target })
    ok(`自证（动态边界）：${g} 必须不被判命中`, good.hit === false, good.hit ? '被误判为命中' : '')
  }
  // 次序格（②）的自证 —— 桩 resolver 必须**相对解析**（照 `from` 推），
  // 否则"按 spec 全局查表"的宽松桩会让自证在 1 参 resolver 的 bug 下**照绿**（假绿，本文件踩过）。
  {
    const V2 = '/virtual2'
    const files2 = {
      [`${V2}/stock.mjs`]: "import './costing.mjs'\n",
      [`${V2}/costing.mjs`]: "import './db-index.mjs'\n",
      [`${V2}/db-index.mjs`]: 'export const z = 1\n'
    }
    const read2 = (f) => files2[f] ?? null
    const resolve2 = (spec, fromFile) => {
      if (!spec.startsWith('.')) return null
      const base = path.resolve(path.dirname(fromFile), spec)
      return base in files2 ? base : null
    }
    const dbV = `${V2}/db-index.mjs`
    const P = "process.env.GML_DATA_DIR = '/tmp/x'"
    const run = (src, pinLine) => orderCheck({ src, baseFile: `${V2}/entry.mjs`, resolve: resolve2, read: read2, target: dbV, pinLine })
    ok('自证（次序·直接）：钉 env 在前 ⇒ 无越界', run(`${P}\nawait import('./db-index.mjs')\n`, 1).violations.length === 0)
    ok('自证（次序·直接）：直接动态 import db 排在 pin **之前** ⇒ 判越界', run(`await import('./db-index.mjs')\n${P}\n`, 2).violations.length === 1)
    ok(
      '自证（次序·**A 形态**）：动态 import 一个"三跳才到 db"的模块、排在 pin 之后 ⇒ 无越界',
      run(`${P}\nawait import('./stock.mjs')\n`, 1).violations.length === 0
    )
    const aForm = run(`await import('./stock.mjs')\n${P}\n`, 2)
    ok(
      '自证（次序·**A 形态**）：同上一跳排在 pin **之前** ⇒ 判越界，且给得出两跳路径（判据①看不见这一格）',
      aForm.violations.length === 1 && aForm.violations[0].trail.length === 2,
      JSON.stringify(aForm.violations.map((x) => x.spec))
    )
  }
  ok(
    '自证（pin 检测）：注释/字符串里提到 `process.env.GML_DATA_DIR =` **不算**"钉了 env"',
    pinnedIn("// 说明：process.env.GML_DATA_DIR = '/tmp/x'\nimport fs from 'node:fs'\n") === false &&
      pinnedIn("const s = 'process.env.GML_DATA_DIR = x'\n") === false &&
      pinnedIn("process.env.GML_DATA_DIR = '/tmp/x'\n") === true,
    '注释/字符串里的引用若被当成 pin，会造出**假红**'
  )
}

// ---------------- ② 扫描面 ----------------
const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue }
    if (p === SELF) continue // 本文件含合成样本字面量 ⇒ 排除以免自我误报
    if (/\.(mjs|js)$/.test(e.name)) files.push(p)
  }
}
walk(SCAN_DIR)

const pins = files.filter((f) => pinnedIn(fsRead(f) || ''))
console.log(`\n② 扫描面：${rel(SCAN_DIR)}/** 共 ${files.length} 个 .mjs/.js（已排除本文件）；其中**真的钉了 GML_DATA_DIR** 的 ${pins.length} 个`)
ok('扫描面自证：扫到 ≥ 10 个脚本（扫到 0 个说明路径写错了，不是"大家都对"）', files.length >= 10, `实际 ${files.length}`)
ok('扫描面自证：至少命中 1 个"自钉 env"的脚本（否则本守卫在空跑）', pins.length >= 1, `实际 ${pins.length}`)

// ---------------- ③ 逐个"自钉 env 的脚本"跑两格判据 ----------------
console.log('\n③ 逐脚本判两格')
for (const f of pins.sort()) {
  const src = fsRead(f) || ''
  const sMask = mask(src, { strings: true })
  const pinLine = lineOf(sMask, sMask.search(PIN_RE))
  const { dynLit, dynExpr } = parseImports(src)
  // ① 全静态闭包
  const st = closure({ entry: f, read: fsRead, resolve: (spec, from) => fsResolve(spec, from), target: DB_INDEX, follow: 'static' })
  if (st.hit) {
    ok(
      `${rel(f)}（钉 env 在第 ${pinLine} 行）的全静态闭包未命中 db/index.js`,
      false,
      `\n      ★ 闭包路径（逐跳）：${renderTrail(f, st.trail)}` +
        `\n      ★ 为什么是坏的：静态 import 在**模块体之前**求值 ⇒ db/index.js 的 DATA_DIR 在"钉 env"那行之前就算好了` +
        `，钉 env 无效；该脚本会打开并写**仓库 data/**，且照样打绿。` +
        `\n      ★ 修法：把这条链上**第一跳**改成动态 \`await import(...)\`（跨过动态边界后 env 已钉好，后面几跳静态无妨）。`
    )
  } else {
    const boundaries = dynLit.length + dynExpr.length
    ok(`${rel(f)}（钉 env 在第 ${pinLine} 行）的全静态闭包未命中 db/index.js ⇒ 判据①通过`, true)
    console.log(`      · 该文件有 ${boundaries} 处动态 import 作为边界（${dynLit.length} 字面量 / ${dynExpr.length} 非字面量）`)
  }
  // ② 次序
  const oc = orderCheck({ src, baseFile: f, resolve: fsResolve, read: fsRead, target: DB_INDEX, pinLine })
  for (const v of oc.violations) {
    ok(
      `${rel(f)}：动态 import「${v.spec}」@${v.line} 在钉 env@${pinLine} **之后**`,
      false,
      `\n      ★ 这一跳的（静态∪动态）闭包**可达** db/index.js：${renderTrail(v.to, v.trail)}` +
        `\n      ★ 为什么是坏的：它在钉 env **之前**求值 ⇒ 那一刻 env 还没钉好，链上的 db/index.js` +
        `（DATA_DIR）已按**错误的落点**算好 ⇒ 钉 env 无效、会写仓库 data/。判据①**看不见这一格**（没有静态边指向 db）。` +
        `\n      ★ 修法：把这次 \`await import(...)\` 挪到"钉 env"那行**之后**。`
    )
  }
  if (!oc.violations.length) {
    ok(`${rel(f)}：${oc.dyn.length} 处可解析动态 import 的次序均合法（闭包可达 db 的都排在钉 env 之后）`, true)
  }
}

// ---------------- ④ 汇总（格式对齐 regress-all 的计数正则） ----------------
console.log(`\n${'─'.repeat(64)}`)
console.log(`钉 env 的脚本 ${pins.length} 个：${pins.map((f) => rel(f).replace('scripts/', '')).join(' / ')}`)
if (failed) console.log(`失败断言：\n - ${failNames.join('\n - ')}`)
console.log(`计数 通过 ${pass} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
