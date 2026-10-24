/**
 * ============================================================================
 * 文件标识：scripts/lib/sbom-diff.mjs ｜ 两份 CycloneDX SBOM 的组件对比（AF7）
 * ============================================================================
 * 【做什么】diffSboms(previous, current) 返回 { added, removed, changed, summary }：
 *   - 以 group/name 为键，每个键对应一组版本；只存在于一侧的键为 added / removed；
 *   - 两侧都有但版本集合不同 → changed(kind: version)；版本集合相同但同一 name@version 两侧都带 hashes 且不同 → changed(kind: integrity)
 *     （同版本内容被换掉是供应链上最值得看的变化）；任一侧缺 hashes 不算变化。
 * 【信任边界】前一份 SBOM 来自上一次候选的 artifact，按“不可信数据”处理：只做 JSON.parse 与结构检查，限制大小，
 *   绝不执行；表格输出把控制字符与换行替换掉并截断，避免日志注入（例如行首的 GitHub 工作流命令）。
 * 【不做什么】不联网、不判断好坏、不做许可证 / 漏洞分析；畸形输入抛错（调用方决定退出码）。
 * ============================================================================
 */
import fs from 'node:fs'

export const MAX_SBOM_BYTES = 32 * 1024 * 1024
export const MAX_COMPONENTS = 50000
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** 结构检查与 verify-release 一致（CycloneDX 1.x、components 为数组、各有 name/version、bom-ref 唯一）；返回组件数组。 */
export function parseSbom(bom, label = 'SBOM') {
  const bad = (why) => { throw new Error(`${label}: ${why}`) }
  if (!bom || typeof bom !== 'object' || Array.isArray(bom)) bad('not a JSON object')
  if (bom.bomFormat !== 'CycloneDX') bad('bomFormat is not CycloneDX')
  if (!/^1\.\d+$/.test(String(bom.specVersion))) bad('CycloneDX specVersion missing or not 1.x')
  if (!Array.isArray(bom.components)) bad('components is not an array')
  if (bom.components.length > MAX_COMPONENTS) bad(`more than ${MAX_COMPONENTS} components`)
  const refs = new Set()
  for (const c of bom.components) {
    if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name || typeof c.version !== 'string' || !c.version) bad('component without name/version')
    if (c.group !== undefined && typeof c.group !== 'string') bad('component group is not a string')
    if (c.hashes !== undefined) {
      if (!Array.isArray(c.hashes)) bad('component hashes is not an array')
      for (const h of c.hashes) if (!h || typeof h.alg !== 'string' || !h.alg || typeof h.content !== 'string' || !h.content) bad('component hash without alg/content')
    }
    const ref = c['bom-ref']
    if (ref !== undefined && (typeof ref !== 'string' || refs.has(ref))) bad(`invalid or duplicate bom-ref ${clean(ref, 80)}`)
    refs.add(ref)
  }
  return bom.components
}

export function loadSbomFile(file, { maxBytes = MAX_SBOM_BYTES } = {}) {
  let text
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) throw new Error('not a regular file')
    if (st.size > maxBytes) throw new Error('too large')
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.message === 'too large') throw new Error(`${file}: file too large (limit ${maxBytes} bytes)`)
    throw new Error(`${file}: cannot read (${error.message})`)
  }
  let json
  try { json = JSON.parse(text) } catch { throw new Error(`${file}: not valid JSON`) }
  parseSbom(json, file)
  return json
}

// 结构化键：{group:'@a',name:'pkg'} 与 {name:'@a/pkg'} 不会碰撞；显示名仍是 group/name。
const keyOf = (c) => JSON.stringify([c.group ?? '', c.name])
const displayOf = (c) => (c.group ? `${c.group}/${c.name}` : c.name)
const hashList = (c) => (Array.isArray(c.hashes) ? c.hashes.filter((h) => h && typeof h.alg === 'string' && typeof h.content === 'string').map((h) => `${h.alg}:${h.content}`).sort() : [])

function index(components) {
  const byKey = new Map()
  for (const c of components) {
    const k = keyOf(c)
    if (!byKey.has(k)) byKey.set(k, { name: displayOf(c), versions: new Map() })
    const { versions } = byKey.get(k)
    const prior = versions.get(c.version)
    versions.set(c.version, [...new Set([...(prior ?? []), ...hashList(c)])].sort())
  }
  return byKey
}

const sameList = (x, y) => x.length === y.length && x.every((v, i) => v === y[i])

export function diffSboms(previous, current) {
  const pc = parseSbom(previous, 'previous SBOM')
  const cc = parseSbom(current, 'current SBOM')
  const p = index(pc)
  const c = index(cc)
  const added = []
  const removed = []
  const changed = []
  for (const [key, cur] of c) {
    if (!p.has(key)) for (const v of [...cur.versions.keys()].sort()) added.push({ name: cur.name, version: v })
  }
  for (const [key, old] of p) {
    if (!c.has(key)) { for (const v of [...old.versions.keys()].sort()) removed.push({ name: old.name, version: v }); continue }
    const cur = c.get(key)
    const from = [...old.versions.keys()].sort()
    const to = [...cur.versions.keys()].sort()
    if (!sameList(from, to)) changed.push({ name: old.name, kind: 'version', from, to })
    // 完整性比较对两侧都存在的每个版本独立进行（版本集合变化不能掩盖同版本内容被替换）
    for (const v of from) {
      if (!cur.versions.has(v)) continue
      const a = old.versions.get(v)
      const b = cur.versions.get(v)
      if (a.length && b.length && !sameList(a, b)) changed.push({ name: old.name, kind: 'integrity', version: v, from, to, previousHashes: a, currentHashes: b })
    }
  }
  const byName = (x, y) => cmp(x.name, y.name) || cmp(x.version ?? '', y.version ?? '')
  added.sort(byName); removed.sort(byName); changed.sort((x, y) => cmp(x.name, y.name) || cmp(x.kind, y.kind) || cmp(x.version ?? '', y.version ?? ''))
  return { added, removed, changed, summary: { previous: pc.length, current: cc.length, added: added.length, removed: removed.length, changed: changed.length } }
}

/** 把任何来自 SBOM 的字符串变成单行、可见字符、有限长度。 */
export function clean(value, max = 160) {
  let s = ''
  for (const ch of String(value)) {
    const c = ch.codePointAt(0)
    const unsafe = c < 0x20 || (c >= 0x7f && c < 0xa0) || c === 0xfeff || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
    s += unsafe ? '?' : ch
  }
  // GitHub 会先去掉行首空白再解析 `::cmd::` ，并识别行内 `##[cmd]`：破坏这两种语法
  s = s.replace(/::/g, ': :').replace(/##\[/g, '# #[')
  return s.length > max ? `${s.slice(0, max)}...` : s
}

export function renderTable(diff) {
  const s = diff.summary
  const out = [`SBOM diff: ${s.previous} -> ${s.current} components; +${s.added} added, -${s.removed} removed, ~${s.changed} changed`]
  if (!s.added && !s.removed && !s.changed) { out.push('No component changes.'); return `${out.join('\n')}\n` }
  const section = (title, rows, fmt) => {
    if (!rows.length) return
    out.push('', `${title} (${rows.length})`)
    const cells = rows.map(fmt)
    const w = cells.reduce((m, r) => Math.max(m, r[0].length), 0)
    for (const [a, b] of cells) out.push(`  ${a.padEnd(w)}  ${b}`)
  }
  section('Added', diff.added, (r) => [clean(r.name), clean(r.version)])
  section('Removed', diff.removed, (r) => [clean(r.name), clean(r.version)])
  section('Changed', diff.changed, (r) => [clean(r.name), r.kind === 'integrity'
    ? `${clean(r.version)} (integrity hash differs for the same version)`
    : `${clean(r.from.join(', '))} -> ${clean(r.to.join(', '))}`])
  return `${out.join('\n')}\n`
}
