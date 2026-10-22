/**
 * ============================================================================
 * 文件标识：scripts/gen-api-types.mjs ｜ 由 `server/openapi.js` 生成 `src/types/api-routes.ts`（前端接口类型）
 * ============================================================================
 * 【职责】由 `server/openapi.js` 生成 `src/types/api-routes.ts`（前端接口类型）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自手写**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 从 OpenAPI 生成前端 TS 契约类型
// 用法：node scripts/gen-api-types.mjs
//
// 为什么需要它（框架文档 P0「前后端契约」的欠账）：
//   OpenAPI 一直是**手工维护**的，前端页面则各拼各的接口字符串。
//   两边没有强制关系，于是必然漂移：后端改了路径、前端还在打老路径，
//   报错要到运行时才发现，而且表现为「接口 404」这种与业务无关的症状。
//
// 做法：把 openapi.js 里的路径与动作固化成一个 TS 联合类型。
//   前端用 `typedGet` / `typedPost` 时，路径写错**编译期就报**，
//   不用等到点开页面才发现。类型文件是产物，改接口后重新生成即可。
//
// 不做的事：不生成完整的 request/response 结构体。
//   本项目的 schema 大多是 `jsonResp(null)`（返回体形状因页面而异），
//   硬生成会产出一堆 any 包装，看着专业、实际没有约束力。
//   先把**路径与方法**这一层锁死（这层最常漂移，且收益立竿见影），
//   等 schema 补齐了再往上加 —— 生成一个骗人的类型比不生成更糟。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOpenApi } from '../server/openapi.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'src', 'types')
const OUT_FILE = path.join(OUT_DIR, 'api-routes.ts')

const spec = buildOpenApi()
const METHODS = ['get', 'post', 'put', 'delete', 'patch']

const routes = []
for (const [p, ops] of Object.entries(spec.paths || {})) {
  const methods = METHODS.filter((m) => ops[m])
  if (methods.length) routes.push({ path: p, methods, tags: ops.get?.tags || ops.post?.tags || [] })
}
// 稳定排序：生成结果可复现，否则每次 diff 都在抖，就没人愿意看这个 diff 了
routes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

const tsString = (v) => `'${String(v).replace(/'/g, "\\'")}'`

const mapLines = routes
  .map((r) => {
    const m = r.methods.map((x) => `${x}: true`).join('; ')
    return `  ${tsString(r.path)}: { ${m} }`
  })
  .join('\n')

const tagSet = [...new Set(routes.flatMap((r) => r.tags))]

const content = `// ⚠️ 本文件由 scripts/gen-api-types.mjs 自动生成，请勿手改。
// 改接口请改 server/openapi.js，然后执行：npm run gen:api
//
// 生成源：server/openapi.js ｜ OpenAPI ${spec.openapi} ｜ 契约版本 ${spec.info.version}
//
// ============================================================================
// 文件标识：src/types/api-routes.ts ｜ 【自动生成，勿手改】接口路径与标签的类型定义
// ============================================================================
// 【职责】把 openapi 的路径、标签生成为前端可直接 import 的联合类型，让调用方拿到路径约束
// 【入口】生成源是 server/openapi.js；重生成用 npm run gen:api（**不要手改本文件**）
// 【注意】本文件由脚本写出：**文件标识块也必须由脚本输出**，否则下次 gen:api 会把它冲掉 ——
//   "登记了不等于守住了"。改格式请改 scripts/gen-api-types.mjs。
// ============================================================================
// 路径 ${routes.length} 条 ｜ 标签 ${tagSet.length} 个
//
// 用法：
//   import { typedGet, typedPost } from '../api/typed'
//   typedGet('/api/purchase/chain/overview')   // 路径写错编译期就报

export const OPENAPI_VERSION = ${tsString(spec.info.version)}
export const API_ROUTE_COUNT = ${routes.length}

/** 全部已登记的接口路径 */
export type ApiRoute =
${routes.map((r) => `  | ${tsString(r.path)}`).join('\n')}

/** 路径 → 支持的方法 */
export type ApiRouteMap = {
${mapLines}
}

/** 已登记的接口标签（模块划分） */
export const API_TAGS = [${tagSet.map(tsString).join(', ')}] as const
export type ApiTag = (typeof API_TAGS)[number]

/** 路径是否已登记 */
export function isApiRoute(p: string): p is ApiRoute {
  return (API_ROUTES as readonly string[]).includes(p)
}

export const API_ROUTES: readonly ApiRoute[] = [
${routes.map((r) => `  ${tsString(r.path)},`).join('\n')}
] as const

/** 某路径支持的方法 */
export const ROUTE_METHODS: Record<ApiRoute, string[]> = {
${routes.map((r) => `  ${tsString(r.path)}: [${r.methods.map(tsString).join(', ')}],`).join('\n')}
}
`

fs.mkdirSync(OUT_DIR, { recursive: true })
const prev = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf-8') : null

// 只比对「去掉版本注释头」的正文：否则每次只改 version 也会被判为过期，
// 而 version 变化本身不该导致契约校验失败
const stripHeader = (s) => (s ? s.split('\n').filter((l) => !l.startsWith('// ')).join('\n') : '')
const changed = stripHeader(prev) !== stripHeader(content)

fs.writeFileSync(OUT_FILE, content, 'utf-8')
console.log(`[gen:api] 契约版本 ${spec.info.version}｜路径 ${routes.length} 条｜标签 ${tagSet.length} 个`)
console.log(`[gen:api] 已写出 ${path.relative(ROOT, OUT_FILE)}（${changed ? '内容有更新' : '内容与上次一致'}）`)
