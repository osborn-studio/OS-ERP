#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-doc-events-edges.mjs ｜ 静态守卫：留痕↔内核边一致：**痕不许说谎**。
 * ============================================================================
 * 【职责】静态守卫：留痕↔内核边一致：**痕不许说谎**。
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
 * 留痕↔内核边一致：**痕不许说谎**。
 *
 * 判据（静态，不连数据库）：
 *   凡 `logEvent(...)` 里**声称了一次流转**（`from` 是状态字面量）的调用点，
 *   那对 `(doc_type, from, to)` 必须是内核 `008_doc_kernel.cjs` 的 `ACTIONS` 里**注册过的边**；
 *   `from` 为 `null`（建单 / 派生列重算这类"不是一次边流转"的痕）⇒ 只要求 `to` 是**已定义状态**。
 *
 * 为什么需要它：内核的 `applyTransition` 会自动校验边；但**绕过内核、手工补的 `logEvent`
 * 没有任何校验** —— 写错一对状态不会报错，只会在时间线上留下一句假话，而下游按边做统计的人
 * 会把它当真。这条判据把"每一对边的痕是否对得上"变成每轮都能跑的检查。
 *
 * 已知例外（**必须显式登记**，每行都要能说清为什么）：
 *   · `routes/demand.js` 记的 DR `submitted→cancelled`：`cancelled` **不在** DR 的 STATES 里
 *     （历史遗留枚举，代码注释自认）；等 DR 的 `cancelled` 要么进 STATES、要么改走 `reject` 之后删掉这行。
 *   · `routes/requisitions.js` 记的 YQ `partial_receive`（`shipped→shipped` 自环）：内核 YQ 没有这条边，
 *     `partial_receive` 也不是内核动作码（内核是 `receive`）；等口径统一后删掉这行。
 *
 * 用法：node scripts/check-doc-events-edges.mjs [--hide=<子串>]
 *   `--hide=<子串>`：跳过源码里含该子串的文件（给自检用：把某个调用点藏起来 ⇒ 判定必须跟着变）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KERNEL = path.join(ROOT, 'server/db/migrations/008_doc_kernel.cjs')

/** 已知例外：`docType|from|to`；每行都要有理由（见文件头）。**当前为空，且必须保持为空** ——
 *  双向判据会同时管两头：实测 ∖ 表 ⇒ 红（新写的痕说谎立刻拦）；表 ∖ 实测 ⇒ 红（修好了没删登记行 = 橡皮图章）。
 *  ⚠️ 曾经有 1 行（`PRQ|converted|converted`：`lib/purchase.js` 的"再次转采购订单"自环）——
 *  已按"**幂等重放不是一次流转**"的口径改成 `from: null` + payload 记 `replay:true`，那行随之删除。 */
const DECLARED_EXCEPTIONS = new Set([])
// ⚠️ **静态判不了的一处**（值来自变量，本判据覆盖不到，写在这里是为了"没做可见"）：
//   · `routes/requisitions.js` 的 YQ 联动痕（`from: rq.status` / `to: toStatus`）：记 `partial_receive`
//     时可能是 `shipped→shipped` 自环，而内核 YQ 没有这条边（同族 SH 有 `partial: shipped→partial`）。
//     归类：**A·定义缺失待补**（真实业务动作、内核没建模）。收口方式二选一（**只建议，未改**）：
//     ① 给 YQ 补一条自环边（内核里已有先例：`WW` 的 `issue: part_received→part_received`）；
//     ② 或改成 `from: null` + payload 记"部分收货（状态未变）"。
//   · （DR 那处曾在此列：`routes/demand.js` 写 `cancelled` 的联动痕 —— 已随"DR 补 `cancelled` 状态 +
//     `cancel` 边 + 路由改走内核"收口，不再是"静态判不了"的例子。）

const hideArg = process.argv.find((a) => a.startsWith('--hide='))
const HIDE = hideArg ? hideArg.slice('--hide='.length) : null

// ---------- 1. 从内核定义里解析出「每个单据类型的合法边与合法状态」 ----------
const kernelSrc = fs.readFileSync(KERNEL, 'utf8')
const blockOf = (name) => {
  // 抓 `ACTIONS = { ... }` / `STATES = { ... }` 到同一缩进的收尾 `}`
  const m = new RegExp(`\\nconst ${name} = \\{([\\s\\S]*?)\\n\\}`).exec(kernelSrc)
  return m ? m[1] : ''
}
const edges = new Set() // `T|from|to`
for (const m of blockOf('ACTIONS').matchAll(/\['([a-z_]+)',\s*'[^']*',\s*'([a-z_]+)',\s*'([a-z_]+)'/g)) {
  edges.add(`${m[2]}|${m[3]}`) // 这里先存 from|to，稍后按类型分组
}
// 上面把类型漏了 —— 重新按类型解析（按 `XX: [` 分块）
const typedEdges = new Set()
const typedStates = new Set()
for (const section of ['ACTIONS', 'STATES']) {
  const body = blockOf(section)
  let cur = null
  for (const line of body.split('\n')) {
    const t = /^\s{2}([A-Z]{1,6}):\s*\[/.exec(line)
    if (t) { cur = t[1]; continue }
    if (!cur) continue
    if (section === 'ACTIONS') {
      const m = /\['([a-z_]+)',\s*'[^']*',\s*'([a-z_]+)',\s*'([a-z_]+)'/.exec(line)
      if (m) typedEdges.add(`${cur}|${m[2]}|${m[3]}`)
    } else {
      const m = /\['([a-z_]+)',\s*'[^']*',\s*'[a-z_]+',\s*\d,\s*\d\]/.exec(line)
      if (m) typedStates.add(`${cur}|${m[1]}`)
    }
  }
}

// ---------- 2. 扫所有 logEvent 调用点 ----------
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}
const files = [
  ...walk(path.join(ROOT, 'server/routes')),
  ...walk(path.join(ROOT, 'server/lib')),
  ...walk(path.join(ROOT, 'server/mcp')),
  ...walk(path.join(ROOT, 'server/db'))
].filter((f) => !f.includes('/migrations/') && !f.endsWith('/lib/docflow.js'))
// ⚠️ 注释用**等长空白**替换（不是删掉）：删掉会让后面的行号整体前移，报出来的行号就指错了行
//    （实测踩过：PRQ 那处真实在 `purchase.js:725`，上一版报成 `:693`）。
const strip = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))

let checked = 0
let skipped = 0
const found = [] // 实测"不是边/不是状态"的调用点（未扣例外表）
const seen = new Set()
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/')
  if (HIDE && rel.includes(HIDE)) continue
  const src = strip(fs.readFileSync(f, 'utf8'))
  const calls = [...src.matchAll(/logEvent\s*\(/g)]
  for (let i = 0; i < calls.length; i++) {
    const stop = i + 1 < calls.length ? calls[i + 1].index : src.length
    const win = src.slice(calls[i].index, Math.min(stop, calls[i].index + 900))
    const dt = /doc_?[Tt]ype:\s*'([A-Z]{1,6})'/.exec(win)
    if (!dt) { skipped += 1; continue } // 类型不是字面量（如 docType 变量）⇒ 静态判不了，跳过并计数
    const T = dt[1]
    const line = src.slice(0, calls[i].index).split('\n').length
    const fromLit = /\bfrom:\s*'([a-z_]+)'/.exec(win)
    const fromNull = /\bfrom:\s*null\b/.test(win)
    const toLit = /\bto:\s*'([a-z_]+)'/.exec(win)
    const toVar = /\bto:\s*[a-zA-Z_$]/.test(win)
    if (!toLit && !toVar) { skipped += 1; continue }

    checked += 1
    const at = `${rel}:${line}`
    if (fromLit && toLit) {
      const key = `${T}|${fromLit[1]}|${toLit[1]}`
      seen.add(key)
      if (!typedEdges.has(key)) found.push({ at, key, msg: `${T}: ${fromLit[1]} → ${toLit[1]}  **不是内核注册过的边**` })
    } else if ((fromNull || !fromLit) && toLit) {
      // 建单 / 派生列重算：只要求 to 是已定义状态
      const key2 = `${T}|-|${toLit[1]}`
      seen.add(key2)
      if (!typedStates.has(`${T}|${toLit[1]}`)) found.push({ at, key: key2, msg: `${T}: to='${toLit[1]}' **不是已定义状态**` })
    } else {
      skipped += 1 // from/to 里有变量，静态判不了
    }
  }
}

// ---------- 3. 双向判据（与 check-api-contract 的已知漂移表同一口径） ----------
//   ① 实测 ∖ 例外表 ⇒ 红（新写的痕说谎，立刻拦）
//   ② 例外表 ∖ 实测 ⇒ 红（修好了却没删登记行 = 橡皮图章）
const problems = found.filter((x) => !DECLARED_EXCEPTIONS.has(x.key))
const staleExceptions = [...DECLARED_EXCEPTIONS].filter((k) => !found.some((x) => x.key === k))

console.log(`留痕↔内核边一致：扫描 ${files.length} 个文件，可静态判定 ${checked} 个 logEvent 调用点（跳过 ${skipped} 个：类型/状态来自变量）`)
console.log(`内核定义：${typedEdges.size} 条边 / ${typedStates.size} 个状态｜显式登记的已知例外 ${DECLARED_EXCEPTIONS.size} 条`)
if (!problems.length) console.log('✓ 没有发现"痕说谎"的调用点（from 非空 ⇒ (from,to) 都是内核注册过的边）')
else {
  console.log(`✗ 发现 ${problems.length} 处：`)
  for (const p of problems) console.log(`  ${p.at}  ${p.msg}  （例外的键：${p.key}）`)
}
if (staleExceptions.length) {
  console.log(`✗ 已知例外表有 ${staleExceptions.length} 行已过期（实测不再出现，请删掉）：`)
  for (const s of staleExceptions) console.log('  ' + s)
}
const fail = problems.length > 0 || staleExceptions.length > 0
console.log(`\n${fail ? '留痕↔内核边检查：失败' : '留痕↔内核边检查：通过'}`)
process.exitCode = fail ? 1 : 0
