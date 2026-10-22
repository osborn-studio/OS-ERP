/**
 * ============================================================================
 * 文件标识：src/api/typed.ts ｜ 接口的**类型化封装**：与 `src/types/api-routes.ts`（由 openapi 生成）配套，让前端调用拿到路径与入参的类型约束
 * ============================================================================
 * 【职责】接口的**类型化封装**：与 `src/types/api-routes.ts`（由 openapi 生成）配套，让前端调用拿到路径与入参的类型约束
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import api from './client'
import type { ApiRoute, ApiRouteMap } from '../types/api-routes'

/**
 * 类型安全的接口调用（契约先行）。
 *
 * 项目里既有的 `api.get('/purchase/orders')` 用的是「去掉 /api 前缀」的相对路径，
 * 而 OpenAPI 里登记的是全路径 `/api/purchase/orders`。两套写法并存必然出错，
 * 所以这里**统一收全路径**：类型约束的是 OpenAPI 里那一条，调用时不用再心算前缀。
 *
 * 路径写错 → 编译期报错；方法用错（对着 GET 接口调 post）→ 编译期报错。
 * 这就是「契约先行」在类型层面的最小可用形态：不需要生成完整的请求/响应结构体，
 * 先把最常漂移的那一层（路径 + 方法）锁死。
 */

const strip = (p: string) => (p.startsWith('/api') ? p.slice(4) : p)

type Method = keyof ApiRouteMap[ApiRoute]

/** 仅保留该路径确实登记过的方法——用错方法编译不过 */
type HasMethod<P extends ApiRoute, M extends string> = M extends keyof ApiRouteMap[P] ? unknown : never

export function typedGet<P extends ApiRoute>(
  path: P & HasMethod<P, 'get'>,
  params?: Record<string, any>
): Promise<{ data: any }> {
  return api.get(strip(path), params) as any
}

export function typedPost<P extends ApiRoute>(
  path: P & HasMethod<P, 'post'>,
  body?: any
): Promise<{ data: any }> {
  return api.post(strip(path), body) as any
}

export function typedPut<P extends ApiRoute>(
  path: P & HasMethod<P, 'put'>,
  body?: any
): Promise<{ data: any }> {
  return api.put(strip(path), body) as any
}

export function typedDel<P extends ApiRoute>(path: P & HasMethod<P, 'delete'>): Promise<{ data: any }> {
  return api.del(strip(path)) as any
}

export type { ApiRoute, ApiRouteMap, Method }
