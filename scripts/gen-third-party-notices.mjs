#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/gen-third-party-notices.mjs ｜ 从锁文件生成 THIRD_PARTY_NOTICES.md 的第三方许可证清单（W9）
 * ============================================================================
 * 【做什么】遍历 package-lock.json 中所有非 dev 的包，加上被打进前端 dist 的 dev 声明依赖闭包（scripts/lib/runtime-closure.mjs），逐包读取
 *   node_modules/<pkg>/ 下的 LICENSE, LICENCE, COPYING and NOTICE 原文，写入
 *   THIRD_PARTY_NOTICES.md 中 `<!-- generated below -->` 标记之下。标记之上的手写头部
 *   （项目来源、reusable/ 上游声明）原样保留，永不被覆盖。
 * 【无许可证文件的包】回退到 package.json / 锁文件的 license 字段，并显式标注
 *   「NO LICENSE FILE IN PACKAGE — fallback to declared metadata」；这不是许可证原文。
 * 【多选许可证表达式（含 OR）】必须在 SPDX_CHOICES 里显式登记所选项与理由；
 *   未登记则生成失败，绝不静默选择。这里只记录选择与义务描述，不是法律结论。
 * 【确定性】按 name、version 排序，无时间戳、无绝对路径；两次运行逐字节一致。
 * 【用法】node scripts/gen-third-party-notices.mjs           写入文件
 *         node scripts/gen-third-party-notices.mjs --check   与仓库文件比对，漂移则退出 1
 * 【改它要注意】node_modules 必须是按锁文件安装的（npm ci），否则文本来源不同。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { distributedPackages } from './lib/runtime-closure.mjs'

export const MARKER = '<!-- generated below -->'
export const FALLBACK_MARKER = 'NO LICENSE FILE IN PACKAGE — fallback to declared metadata (not license text)'

/** 多选表达式的显式选择。key = "name@version" 或 "name"。 */
export const SPDX_CHOICES = {
  'expand-template': {
    selected: 'MIT',
    reason: 'Dual-licensed (MIT OR WTFPL); MIT is selected because it is the license text shipped in the package LICENSE file.'
  },
  rc: {
    selected: 'MIT',
    reason: 'Tri-licensed (BSD-2-Clause OR MIT OR Apache-2.0); MIT is selected as the least-burdensome notice-only option. The package ships all three texts and all are reproduced below.'
  }
}

const LICENSE_FILE_RE = /^(licen[sc]e|licen[sc]e[-._].*|copying|copying[-._].*|notice|notice[-._].*)$/i

function listLicenseFiles(dir) {
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names
    .filter((n) => LICENSE_FILE_RE.test(n) && fs.statSync(path.join(dir, n)).isFile())
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function norm(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
}

function fence(text) {
  const runs = text.match(/`+/g) || []
  const n = Math.max(2, ...runs.map((r) => r.length)) + 1
  return '`'.repeat(n)
}

export function runtimePackages(lock, roots) {
  const out = distributedPackages(lock, roots)
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : a.key < b.key ? -1 : 1))
  return out
}

/** README 中「License」小节（无独立许可证文件时的来源，需在输出中标注）。 */
function readmeLicenseSection(dir) {
  let names
  try { names = fs.readdirSync(dir) } catch { return null }
  const rd = names.filter((n) => /^readme(\.\w+)?$/i.test(n)).sort()[0]
  if (!rd) return null
  const lines = norm(fs.readFileSync(path.join(dir, rd), 'utf8')).split('\n')
  const i = lines.findIndex((l) => /^#{1,6}\s*licen[sc]e/i.test(l))
  if (i < 0) return null
  let j = lines.findIndex((l, n) => n > i && /^#{1,6}\s/.test(l))
  if (j < 0) j = lines.length
  const text = lines.slice(i + 1, j).join('\n').trim()
  return text.length >= 200 ? { file: rd, text } : null
}

export function buildNotices({ root, head, roots }) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const pkgs = runtimePackages(lock, roots)
  const stats = { total: pkgs.length, fallbacks: [], readme: [], byLicense: {}, choices: [] }
  const parts = []
  for (const p of pkgs) {
    const dir = path.join(root, p.key)
    let meta = {}
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch {
      throw new Error(`missing installed package for ${p.key}; run npm ci first`)
    }
    let declared = p.license || (typeof meta.license === 'string' ? meta.license : meta.license?.type) || 'UNKNOWN'
    stats.byLicense[declared] = (stats.byLicense[declared] || 0) + 1
    const lines = [`### ${p.name}@${p.version}`, '', `- Declared license (SPDX): \`${declared}\``]
    if (/\sOR\s/i.test(declared)) {
      const c = SPDX_CHOICES[`${p.name}@${p.version}`] || SPDX_CHOICES[p.name]
      if (!c) throw new Error(`multi-license expression "${declared}" for ${p.name}@${p.version} has no entry in SPDX_CHOICES`)
      lines.push(`- Selected license: \`${c.selected}\` — ${c.reason}`)
      stats.choices.push(`${p.name}@${p.version}: ${declared} -> ${c.selected}`)
    }
    const files = listLicenseFiles(dir)
    const licFiles = files.filter((f) => !/^notice/i.test(f))
    if (p.bundledFrontend) lines.push('- Distribution: bundled into the frontend build (declared as a devDependency in package.json)')
    const rm = licFiles.length === 0 ? readmeLicenseSection(dir) : null
    if (rm) {
      lines.push(`- Source: no standalone license file; license section extracted from \`${rm.file}\` of the installed package`)
      stats.readme.push(`${p.name}@${p.version}`)
      const fe = fence(rm.text)
      lines.push('', `**${rm.file} (License section)**`, '', fe + 'text', rm.text, fe)
    } else if (licFiles.length === 0) {
      lines.push(`- Source: ${FALLBACK_MARKER}`)
      stats.fallbacks.push(`${p.name}@${p.version}`)
    } else {
      lines.push(`- Source: ${files.map((f) => '`' + f + '`').join(', ')} from the installed package`)
    }
    // Some packages vendor other libraries with their own license files (e.g. victory-vendor/lib-vendor/d3-*/LICENSE).
    const vendored = []
    const vdir = path.join(dir, 'lib-vendor')
    if (fs.existsSync(vdir)) {
      for (const sub of fs.readdirSync(vdir).sort()) {
        for (const f of listLicenseFiles(path.join(vdir, sub))) vendored.push({ label: `lib-vendor/${sub}/${f}`, abs: path.join(vdir, sub, f) })
      }
    }
    if (vendored.length) lines.push(`- Vendored third-party license files shipped inside this package: ${vendored.length}`)
    for (const f of files) {
      const text = norm(fs.readFileSync(path.join(dir, f), 'utf8'))
      const fe = fence(text)
      lines.push('', `**${f}**`, '', fe + 'text', text, fe)
    }
    for (const v of vendored) {
      const text = norm(fs.readFileSync(v.abs, 'utf8'))
      const fe = fence(text)
      lines.push('', `**${v.label}**`, '', fe + 'text', text, fe)
    }
    parts.push(lines.join('\n'))
  }
  const intro = [
    '## Runtime dependency licenses (generated)',
    '',
    `Generated by \`scripts/gen-third-party-notices.mjs\` from \`package-lock.json\` (${stats.total} distributed packages: lock entries not marked dev, plus the transitive closure of the frontend packages that \`vite build\` bundles into dist). Do not edit below the marker; regenerate instead.`,
    'Each entry reproduces the license and NOTICE files shipped in the installed package. Where a package ships no license file, the entry says so and shows only declared metadata, which is not license text.',
    'Packages needed only to build or test (not bundled or loaded at runtime) are not listed. The text is a notice inventory, not a legal opinion.',
    ''
  ].join('\n')
  const body = head.replace(/\s+$/, '') + '\n\n' + MARKER + '\n\n' + intro + '\n' + parts.join('\n\n') + '\n'
  return { text: body, stats }
}

export function splitHead(existing) {
  const i = existing.indexOf(MARKER)
  return i < 0 ? existing : existing.slice(0, i)
}

export function generate({ root, file = 'THIRD_PARTY_NOTICES.md', roots }) {
  const target = path.join(root, file)
  const head = splitHead(fs.readFileSync(target, 'utf8'))
  return { target, ...buildNotices({ root, head, roots }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const check = process.argv.includes('--check')
  const { target, text, stats } = generate({ root })
  const current = fs.readFileSync(target, 'utf8')
  console.log(`readme-extracted: ${stats.readme.length}${stats.readme.length ? ' (' + stats.readme.join(', ') + ')' : ''}`)
  console.log(`runtime packages: ${stats.total}; fallbacks: ${stats.fallbacks.length}${stats.fallbacks.length ? ' (' + stats.fallbacks.join(', ') + ')' : ''}`)
  console.log('by license: ' + JSON.stringify(Object.fromEntries(Object.entries(stats.byLicense).sort())))
  for (const c of stats.choices) console.log('choice: ' + c)
  if (check) {
    if (current !== text) { console.error('THIRD_PARTY_NOTICES.md is out of date; run: node scripts/gen-third-party-notices.mjs'); process.exit(1) }
    console.log('THIRD_PARTY_NOTICES.md is up to date')
  } else {
    fs.writeFileSync(target, text)
    console.log('wrote THIRD_PARTY_NOTICES.md')
  }
}
