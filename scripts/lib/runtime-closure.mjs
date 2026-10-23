/**
 * ============================================================================
 * 文件标识：scripts/lib/runtime-closure.mjs ｜ 发行物依赖集合：非 dev 包 + 前端打包进 dist 的 dev 声明依赖（W9）
 * ============================================================================
 * 【为什么】前端依赖（react、lucide-react 等）在 package.json 里是 devDependencies，但 `vite build`
 *   会把它们打进随发行物分发的 dist。只看「非 dev」会漏掉它们的许可证通知（Codex 审计 2026-10 指出）。
 *   所以发行物集合 = 锁文件里非 dev 的包 ∪ FRONTEND_BUNDLED_ROOTS 的传递闭包。
 * 【改它要注意】新增被 `src/` 直接 import 的前端包时，加进 FRONTEND_BUNDLED_ROOTS；
 *   tests/third-party-notices.test.mjs 会扫描 src/ 的 import 并校验这些根都在集合里。
 * ============================================================================
 */
export const FRONTEND_BUNDLED_ROOTS = ['react', 'react-dom', 'react-router-dom', 'lucide-react', 'recharts']

/** 按 Node 解析规则从 fromKey 向上找依赖 name 对应的锁文件条目路径。 */
function resolveKey(packages, fromKey, name) {
  let base = fromKey
  for (;;) {
    const cand = (base ? base + '/' : '') + 'node_modules/' + name
    if (packages[cand]) return cand
    if (!base) return null
    const i = base.lastIndexOf('/node_modules/')
    base = i >= 0 ? base.slice(0, i) : ''
  }
}

/** 返回 [{key,name,version,license,bundledFrontend}]，key 为锁文件条目路径。 */
export function distributedPackages(lock, roots = FRONTEND_BUNDLED_ROOTS) {
  const packages = lock.packages || {}
  const keep = new Map()
  const nameOf = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
  for (const [key, v] of Object.entries(packages)) {
    if (key && !v.dev && !v.link && key.includes('node_modules/')) keep.set(key, false)
  }
  const stack = []
  for (const r of roots) {
    const k = resolveKey(packages, '', r)
    if (!k) throw new Error(`frontend bundled root ${r} not found in package-lock.json`)
    stack.push(k)
  }
  const seen = new Set()
  while (stack.length) {
    const k = stack.pop()
    if (seen.has(k)) continue
    seen.add(k)
    if (!keep.has(k)) keep.set(k, true)
    const e = packages[k]
    for (const n of Object.keys({ ...(e.dependencies || {}), ...(e.optionalDependencies || {}) })) {
      const dk = resolveKey(packages, k, n)
      if (dk) stack.push(dk)
    }
  }
  return [...keep].map(([key, bundledFrontend]) => {
    const v = packages[key]
    return { key, name: nameOf(key), version: v.version, license: v.license, lockEntry: v, bundledFrontend }
  })
}
