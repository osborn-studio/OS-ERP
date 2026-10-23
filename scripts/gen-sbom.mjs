#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/gen-sbom.mjs ｜ 生成运行时依赖的 CycloneDX SBOM 到 release/sbom.cdx.json（W9）
 * ============================================================================
 * 【做什么】调用 `npm sbom --sbom-format cyclonedx --package-lock-only`（只依据 package-lock.json，
 *   不依赖本机 node_modules），再按发行物集合（非 dev 包 ∪ 前端打包闭包，见 scripts/lib/runtime-closure.mjs）过滤 —— 与
 *   `--omit dev` 的语义一致。【为什么不直接用 --omit dev】npm 10.9 的 `--omit dev` 会漏掉
 *   运行时包（本仓库实测漏 6 个：es-errors、function-bind、hasown、ms@2.1.3、object-assign、
 *   util-deprecate，而 `npm ls --omit dev` 与锁文件都显示它们是运行时依赖）。脚本因此以锁文件
 *   为准过滤，并在运行时包缺失时失败。再做确定性归一化：
 *   去掉 serialNumber / timestamp / 工具版本，根组件名固定为 package.json 的 name
 *   （npm 默认取目录名，会泄露 worktree 目录），components 与 dependencies 排序。
 * 【产物】release/sbom.cdx.json（release/ 已被 .gitignore，是发行产物而非源码）。
 * 【确定性】两次运行逐字节一致；不含绝对路径。
 * 【用法】node scripts/gen-sbom.mjs [--out <file>]
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { distributedPackages } from './lib/runtime-closure.mjs'

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export function normalizeSbom(bom, pkgName) {
  const out = JSON.parse(JSON.stringify(bom))
  delete out.serialNumber
  if (out.metadata) {
    delete out.metadata.timestamp
    delete out.metadata.tools
    if (out.metadata.component) out.metadata.component.name = pkgName
  }
  if (Array.isArray(out.components)) out.components.sort((a, b) => cmp(a['bom-ref'] || '', b['bom-ref'] || ''))
  if (Array.isArray(out.dependencies)) {
    for (const d of out.dependencies) if (Array.isArray(d.dependsOn)) d.dependsOn.sort(cmp)
    out.dependencies.sort((a, b) => cmp(a.ref, b.ref))
  }
  return out
}

/** 锁文件里的运行时包（非 dev）→ "name@version" 集合，与 npm sbom 的 bom-ref 形态一致。 */
export function runtimeRefs(lock) {
  return new Set(distributedPackages(lock).map((p) => `${p.name}@${p.version}`))
}

export function filterToRuntime(bom, refs) {
  const out = JSON.parse(JSON.stringify(bom))
  const have = new Set(out.components.map((c) => c['bom-ref']))
  const missing = [...refs].filter((r) => !have.has(r)).sort(cmp)
  if (missing.length) throw new Error(`npm sbom lacks runtime packages: ${missing.join(', ')}`)
  // bom-ref must be unique in CycloneDX; npm emits one component per installed copy, so keep the first of each name@version.
  const seen = new Set()
  out.components = out.components.filter((c) => {
    const r = c['bom-ref']
    if (!refs.has(r) || seen.has(r)) return false
    seen.add(r)
    return true
  })
  const root = out.metadata?.component?.['bom-ref']
  const deps = new Map()
  for (const d of out.dependencies || []) {
    if (!refs.has(d.ref) && d.ref !== root) continue
    const cur = deps.get(d.ref) || new Set()
    for (const r of d.dependsOn || []) if (refs.has(r)) cur.add(r)
    deps.set(d.ref, cur)
  }
  out.dependencies = [...deps].map(([ref, set]) => ({ ref, dependsOn: [...set] }))
  return out
}

export function generateSbom(root) {
  const r = spawnSync('npm', ['sbom', '--sbom-format', 'cyclonedx', '--package-lock-only'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  })
  if (r.status !== 0) throw new Error(`npm sbom failed: ${r.stderr}`)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const bom = filterToRuntime(JSON.parse(r.stdout), runtimeRefs(lock))
  return JSON.stringify(normalizeSbom(bom, pkg.name), null, 2) + '\n'
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const i = process.argv.indexOf('--out')
  const out = i > 0 ? path.resolve(process.argv[i + 1]) : path.join(root, 'release', 'sbom.cdx.json')
  const text = generateSbom(root)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, text)
  console.log(`wrote ${path.relative(root, out)} (${JSON.parse(text).components.length} components)`)
}
