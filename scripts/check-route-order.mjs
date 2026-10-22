#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-route-order.mjs ｜ 静态守卫：路由遮蔽检查：**字面段路由必须排在同前缀的参数路由之前**。
 * ============================================================================
 * 【职责】静态守卫：路由遮蔽检查：**字面段路由必须排在同前缀的参数路由之前**。
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
 * 路由遮蔽检查：**字面段路由必须排在同前缀的参数路由之前**。
 *
 * 为什么需要它：
 *   Express 按**注册顺序**匹配。`r.get('/agreements/:id')` 写在 `r.get('/agreements/explain')`
 *   前面时，请求 `/agreements/explain` 会被 `:id` 吃掉（`Number('explain')` → NaN → 404「协议不存在」）。
 *   表现是：**接口存在、契约里有它、前端也在调它，但它永远返回 404** ——
 *   而 404 是个"看起来很正常"的错（资源不存在），排查时会往数据上想，不会往注册顺序上想。
 *   `/api/dms/agreements/explain`（协议价取证接口，专门给验收侧用的）就这样从写下那天起一直 404。
 *
 * 判据只有一条：同 method 下，**先注册的参数路由**能不能匹配**后注册的字面路由**的路径。
 * 能匹配 ⇒ 后者永远不可达。
 *
 * 用法：node scripts/check-route-order.mjs   （有问题时退出码 1）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

/** 把 '/a/:id/b' 拆成段 */
const segsOf = (p) => p.split('/').filter(Boolean)
const isParam = (s) => s.startsWith(':')
/** pathB 是否会被 pathA 的模板匹配（A 先注册） */
function shadowedBy(a, b) {
  if (a === b) return false
  const A = segsOf(a)
  const B = segsOf(b)
  if (A.length !== B.length) return false
  if (!A.some(isParam)) return false
  if (B.some(isParam)) return false
  return A.every((s, i) => (isParam(s) ? true : s === B[i]))
}

const files = [...walk(path.join(ROOT, 'server/routes')), ...walk(path.join(ROOT, 'server/mcp'))]
const problems = []
let scanned = 0

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  const routes = []
  ROUTE_RE.lastIndex = 0
  let m
  while ((m = ROUTE_RE.exec(src))) {
    routes.push({ method: m[1], path: m[2], idx: m.index, line: src.slice(0, m.index).split('\n').length })
  }
  scanned += routes.length
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      if (routes[i].method !== routes[j].method) continue
      if (!shadowedBy(routes[i].path, routes[j].path)) continue
      problems.push({
        file: path.relative(ROOT, f),
        shadowed: `${routes[j].method.toUpperCase()} ${routes[j].path} (第 ${routes[j].line} 行)`,
        by: `${routes[i].method.toUpperCase()} ${routes[i].path} (第 ${routes[i].line} 行)`
      })
    }
  }
}

console.log(`路由遮蔽检查：扫描 ${files.length} 个文件 / ${scanned} 条路由`)
if (!problems.length) {
  console.log('✓ 没有发现被参数路由遮蔽的字面路由')
  process.exit(0)
}
console.log(`✗ 发现 ${problems.length} 处遮蔽（后者永远不可达）：`)
for (const p of problems) console.log(`  ${p.file}\n    被遮蔽：${p.shadowed}\n    遮蔽者：${p.by}`)
process.exit(1)
