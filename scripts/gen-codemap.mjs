#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/gen-codemap.mjs ｜ 生成代码地图（路由/模块/表）与 ADR 索引（Z12）
 * ============================================================================
 * 【做什么】静态扫描 server/ 与 docs/implementation/ADR-*.md，生成四份确定性文档（均带 `<!-- generated -->` 标记）：
 *   docs/CODEMAPS/routes.md   路由 → 中间件链 → 处理器文件:行 → 调用的 lib 函数 → 触达的表
 *   docs/CODEMAPS/modules.md  server/lib 与 server/mcp 模块 → 导出 → 哪些路由 / MCP 工具 / 模块在用
 *   docs/CODEMAPS/tables.md   表 → 建/改它的迁移 → 触达它的文件
 *   docs/implementation/ADR-INDEX.md  ADR 编号、标题、批次、状态、相关守卫与测试
 *   路由清单来自 `scripts/check-route-authz.mjs --list`（同一份解析，不另写第二份）。
 * 【诚实边界】这是**静态文本扫描**，不执行代码、不是调用图证明：
 *   ① 函数引用 = 标识符出现在处理器区域内且来自 import / 本文件顶层声明（字符串内容与注释已抹掉，`${}` 表达式保留）；
 *      同名局部变量遮蔽、解构改名后的再引用不处理；
 *   ② 看不到动态分发（`handlers[action]()`、注册表、docflow 流转表、回调传参后在别处调用）；
 *   ③ 表名只认 schema/迁移/运行时建表语句里出现过的表，且只认大写 SQL 关键字 FROM/JOIN/INTO/UPDATE/TABLE 之后的字面量标识符
 *      （含 `table: '名'` 配置字面量）；`FROM ${变量}`、逗号连接 `FROM a, b`、小写 SQL、拼接出的表名看不到；
 *   ④ “经 lib 触达的表”沿跨文件调用最多 3 跳（同文件内的辅助函数不计跳数），是**可能触达**的上界，不代表某次请求一定读写；
 *   ⑤ 处理器区域 = 路由注册行到下一个顶层声明/下一条路由之前的文本；路由器层 `r.use` 与子路由器内的处理器不展开；
 *   ⑥ 迁移只统计建表 / ALTER / addColumn / 建索引 / 建触发器；迁移里对数据的 INSERT/UPDATE 不计；server/db/ 下的种子与启动文件不计入“触达”。
 *   ⑦ lib 导出里“—”表示静态扫描没找到调用方，不等于死代码。
 * 【确定性】排序固定；无时间戳、无绝对路径；两次运行逐字节一致。
 * 【用法】node scripts/gen-codemap.mjs            写入四份文件
 *         node scripts/gen-codemap.mjs --check    与仓库文件比对，漂移/缺失则退出 1（CI）
 *         --root=<dir> 指定仓库根（测试用）
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BATCHES, batchOf } from './gen-changelog.mjs'

export const MARKER = '<!-- generated -->'
export const OUTPUTS = {
  routes: 'docs/CODEMAPS/routes.md',
  modules: 'docs/CODEMAPS/modules.md',
  tables: 'docs/CODEMAPS/tables.md',
  adr: 'docs/implementation/ADR-INDEX.md'
}
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
const MAX_HOPS = 3
const PLUMBING = new Set(['server/lib/http.js'])
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const uniqSorted = (it) => [...new Set(it)].sort(cmp)
const esc = (s) => String(s).replace(/\|/g, '\\|')

// ---------------------------------------------------------------------------
// 词法：返回等长的两个视图。sqlView=注释抹掉、字符串保留；identView=注释与字符串/模板文本抹掉（`${}` 内保留）
// ---------------------------------------------------------------------------
export function lex(src) {
  const n = src.length
  const sqlV = src.split('')
  const idV = src.split('')
  const blank = (arr, a, b) => { for (let k = a; k < b; k++) if (arr[k] !== '\n') arr[k] = ' ' }
  const prevSig = (i) => { let k = i - 1; while (k >= 0 && /\s/.test(src[k])) k--; return k }
  const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])
  function str(i, q) {
    let j = i + 1
    while (j < n && src[j] !== q && src[j] !== '\n') { if (src[j] === '\\') j++; j++ }
    blank(idV, i, j + 1)
    return j + 1
  }
  function tpl(i) {
    let j = i + 1
    blank(idV, i, i + 1)
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') { blank(idV, j, j + 2); j += 2; continue }
      if (src[j] === '$' && src[j + 1] === '{') { blank(idV, j, j + 2); j = code(j + 2, true); continue }
      blank(idV, j, j + 1)
      j++
    }
    blank(idV, j, j + 1)
    return j + 1
  }
  function code(i, inExpr) {
    let depth = 0
    while (i < n) {
      const c = src[i]
      const d = src[i + 1]
      if (c === '/' && d === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(sqlV, i, j); blank(idV, i, j); i = j; continue }
      if (c === '/' && d === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; blank(sqlV, i, j); blank(idV, i, j); i = j; continue }
      if (c === "'" || c === '"') { i = str(i, c); continue }
      if (c === '`') { i = tpl(i); continue }
      if (c === '/') {
        const p = prevSig(i)
        const pc = p >= 0 ? src[p] : ''
        const word = /[\w$]/.test(pc) ? /([A-Za-z_$][\w$]*)$/.exec(src.slice(Math.max(0, p - 12), p + 1)) : null
        if (p < 0 || REGEX_PREV.has(pc) || (word && /^(return|typeof|case|in|of)$/.test(word[1]))) {
          let j = i + 1; let cls = false
          while (j < n && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++ }
          blank(idV, i, j + 1); blank(sqlV, i, j + 1)
          i = j + 1; continue
        }
      }
      if (inExpr) { if (c === '{') depth++; else if (c === '}') { if (depth === 0) return i + 1; depth-- } }
      i++
    }
    return i
  }
  code(0, false)
  return { sql: sqlV.join(''), ident: idV.join('') }
}

// ---------------------------------------------------------------------------
// 文件索引
// ---------------------------------------------------------------------------
const BOUNDARY = /^(?:export\b|import\b|const\b|let\b|var\b|function\b|async\s+function\b|class\b|r\.(?:get|post|put|patch|delete|all|use|route)\b|router\.|app\.)/
const DECL_FN = /^(export\s+(?:default\s+)?)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
const DECL_CLASS = /^(export\s+)?class\s+([A-Za-z_$][\w$]*)/
const DECL_VAR = /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name))) {
    if (e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(?:js|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

function lineStarts(text) {
  const a = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') a.push(i + 1)
  return a
}

function parseFile(root, rel, files) {
  const raw = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/g, '\n')
  const { sql, ident } = lex(raw)
  const starts = lineStarts(raw)
  const lines = sql.split('\n')
  const bounds = []
  const decls = new Map()
  const exports = new Map() // exportedName -> localName
  const reexports = new Map() // exportedName -> { spec, name }
  lines.forEach((ln, idx) => {
    if (!BOUNDARY.test(ln)) return
    bounds.push(starts[idx])
    let m
    if ((m = DECL_FN.exec(ln))) { decls.set(m[3], { name: m[3], kind: 'fn', start: starts[idx] }); if (m[1]) exports.set(m[3], m[3]) }
    else if ((m = DECL_CLASS.exec(ln))) { decls.set(m[2], { name: m[2], kind: 'class', start: starts[idx] }); if (m[1]) exports.set(m[2], m[2]) }
    else if ((m = DECL_VAR.exec(ln))) {
      const head = sql.slice(starts[idx] + m[0].length, starts[idx] + m[0].length + 300)
      const fn = /^(?:async\s+)?function\b/.test(head) || /^(?:async\s*)?(?:\([^()]*(?:\([^()]*\)[^()]*)*\)|[A-Za-z_$][\w$]*)\s*=>/.test(head)
      decls.set(m[2], { name: m[2], kind: fn ? 'fn' : 'const', start: starts[idx] })
      if (m[1]) exports.set(m[2], m[2])
    }
  })
  for (const m of sql.matchAll(/^export\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/gm)) {
    for (const part of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const [a, b] = part.split(/\s+as\s+/)
      if (m[2]) reexports.set(b || a, { spec: m[2], name: a })
      else exports.set(b || a, a)
    }
  }
  const sorted = [...new Set(bounds)].sort((a, b) => a - b)
  for (const d of decls.values()) {
    const next = sorted.find((b) => b > d.start)
    d.end = next ?? raw.length
    d.sql = sql.slice(d.start, d.end)
    d.ident = ident.slice(d.start, d.end)
  }
  const imports = new Map() // local -> { spec, name } | { spec, ns:true }
  for (const m of sql.matchAll(/import\s+([^'";]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    let clause = m[1]; const spec = m[2]
    const braces = /\{([^}]*)\}/.exec(clause)
    if (braces) {
      for (const part of braces[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        const [a, b] = part.replace(/^type\s+/, '').split(/\s+as\s+/)
        imports.set(b || a, { spec, name: a })
      }
      clause = clause.replace(/\{[^}]*\}/, '')
    }
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause)
    if (ns) { imports.set(ns[1], { spec, ns: true }); clause = clause.replace(/\*\s*as\s+[\w$]+/, '') }
    const def = clause.replace(/,/g, ' ').trim()
    if (def && /^[\w$]+$/.test(def)) imports.set(def, { spec, name: 'default' })
  }
  const resolve = (spec) => {
    if (!spec.startsWith('.')) return null
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
    for (const c of [base, `${base}.js`, `${base}/index.js`]) if (files.has(c)) return c
    return null
  }
  for (const imp of imports.values()) imp.file = resolve(imp.spec)
  for (const re of reexports.values()) re.file = resolve(re.spec)
  const header = /文件标识：\S+\s*[｜|]\s*([^\n]+)/.exec(raw)
  return { rel, raw, sql, ident, decls, exports, reexports, imports, header: header ? header[1].trim() : '', starts }
}

function buildIndex(root) {
  const serverDir = path.join(root, 'server')
  const rels = walk(serverDir).map((p) => path.relative(root, p).split(path.sep).join('/')).filter((r) => !r.startsWith('server/db/migrations/'))
  const files = new Set(rels)
  const idx = new Map()
  for (const r of rels) idx.set(r, parseFile(root, r, files))
  return idx
}

/** 把 (file, name) 解析到定义它的声明，沿重导出走。 */
function declOf(idx, file, name, seen = new Set()) {
  const f = idx.get(file)
  if (!f) return null
  const k = `${file}#${name}`
  if (seen.has(k)) return null
  seen.add(k)
  const local = f.exports.get(name)
  if (local !== undefined && f.decls.has(local)) return { file, decl: f.decls.get(local) }
  const re = f.reexports.get(name)
  if (re?.file) return declOf(idx, re.file, re.name, seen)
  return null
}

const IDENT_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)/g
const NS_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g

/** 一段文本（来自 file）引用到的声明：{file, decl, cross}。cross=是否跨文件。 */
function refsIn(idx, file, identText) {
  const f = idx.get(file)
  const out = new Map()
  const add = (target, cross) => { if (target) out.set(`${target.file}#${target.decl.name}`, { ...target, cross }) }
  for (const m of identText.matchAll(IDENT_RE)) {
    const t = m[1]
    if (f.decls.has(t)) { add({ file, decl: f.decls.get(t) }, false); continue }
    const imp = f.imports.get(t)
    if (imp && imp.file && !imp.ns && imp.name !== 'default') add(declOf(idx, imp.file, imp.name), true)
  }
  for (const m of identText.matchAll(NS_RE)) {
    const imp = f.imports.get(m[1])
    if (imp?.ns && imp.file) add(declOf(idx, imp.file, m[2]), true)
  }
  return out
}

// ---------------------------------------------------------------------------
// 表
// ---------------------------------------------------------------------------
const CREATE_RE = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["`]?([A-Za-z_][A-Za-z0-9_]*)/gi
const TOUCH_RE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][A-Za-z0-9_]*)/g
const TABLE_LIT_RE = /\btable:\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g

function tablesIn(sqlText, known) {
  const out = new Set()
  for (const m of sqlText.matchAll(TOUCH_RE)) { const t = m[1].toLowerCase(); if (known.has(t) && m[1] === m[1]) out.add(t) }
  for (const m of sqlText.matchAll(TABLE_LIT_RE)) { const t = m[1].toLowerCase(); if (known.has(t)) out.add(t) }
  return out
}

function scanMigrations(root) {
  const dir = path.join(root, 'server/db/migrations')
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{3}_.+\.cjs$/.test(x)).sort(cmp)) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8')
    const { sql } = lex(raw)
    const created = new Set(); const altered = new Map()
    const note = (t, tag) => { t = t.toLowerCase(); if (!altered.has(t)) altered.set(t, new Set()); altered.get(t).add(tag) }
    for (const m of sql.matchAll(CREATE_RE)) created.add(m[1].toLowerCase())
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+["`]?([A-Za-z_]\w*)/gi)) note(m[1], '')
    for (const m of sql.matchAll(/\baddColumn\(\s*\w+\s*,\s*['"]([A-Za-z_]\w*)['"]/g)) note(m[1], '')
    for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+[\w"`]+\s+ON\s+["`]?([A-Za-z_]\w*)/gi)) note(m[1], '·idx')
    for (const m of sql.matchAll(/CREATE\s+TRIGGER[^;]*?\bON\s+["`]?([A-Za-z_]\w*)/gi)) note(m[1], '·trg')
    for (const m of sql.matchAll(/DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+["`]?([A-Za-z_]\w*)/gi)) note(m[1], '·drop')
    const nm = /name\s*[:=]\s*['"]([^'"]+)['"]/.exec(sql) ?? /module\.exports\.name\s*=\s*['"]([^'"]+)['"]/.exec(sql)
    out.push({ file: f, num: f.slice(0, 3), name: nm ? nm[1] : '', created: uniqSorted(created), altered })
  }
  return out
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
function listRoutes(root) {
  const res = spawnSync(process.execPath, [path.join(SELF_DIR, 'check-route-authz.mjs'), '--list'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, OSERP_ROUTE_AUTHZ_ROOT: root }
  })
  const routes = []
  for (const line of res.stdout.split('\n')) {
    const m = /^(GATED|AUTH_ONLY|NO_AUTH)\s+(\S+)\s+\[routes\/([^\]:]+):(\d+)\]\s+(\S+)\s*(.*)$/.exec(line)
    if (!m) continue
    const chain = m[6].trim()
    routes.push({ cls: m[1], path: m[2], file: `server/routes/${m[3]}`, line: Number(m[4]), verb: m[5], chain: chain === '(无)' ? '' : chain })
  }
  if (!routes.length) throw new Error(`check-route-authz --list returned no routes: ${res.stderr || res.stdout}`.slice(0, 400))
  // 清单必须完整：汇总行「路由 N 条」要与解析到的条数一致（管道截断 / 子进程异常时宁可失败，不生成残缺地图）
  const total = /^路由 (\d+) 条/m.exec(res.stdout)
  if (res.status !== 0 || !total || Number(total[1]) !== routes.length) {
    throw new Error(`check-route-authz --list incomplete: status=${res.status} parsed=${routes.length} declared=${total ? total[1] : 'missing'} ${res.stderr}`.slice(0, 400))
  }
  routes.sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.path, b.path) || cmp(a.verb, b.verb))
  return routes
}

/** 区域 → { direct: Set(table), libs: Map(key->ref), via: Set(table), reached: Map(key->ref) } */
function analyse(idx, file, sqlText, identText, known) {
  const direct = tablesIn(sqlText, known)
  const first = new Map()
  const via = new Set()
  const reached = new Map()
  const visited = new Set()
  // 状态：{file, decl, hops}
  const queue = []
  const seed = refsIn(idx, file, identText)
  for (const r of seed.values()) queue.push({ ...r, hops: r.cross ? 1 : 0, top: true })
  while (queue.length) {
    const cur = queue.shift()
    const key = `${cur.file}#${cur.decl.name}`
    if (visited.has(key)) continue
    visited.add(key)
    if (cur.cross) { reached.set(key, cur); if (cur.top) first.set(key, cur) }
    else if (cur.hops === 0) { /* 同文件辅助函数：算处理器自身 */ }
    const t = tablesIn(cur.decl.sql, known)
    for (const x of t) (cur.hops === 0 ? direct : via).add(x)
    for (const r of refsIn(idx, cur.file, cur.decl.ident).values()) {
      const hops = cur.hops + (r.file !== cur.file ? 1 : 0)
      if (hops > MAX_HOPS) continue
      queue.push({ ...r, hops, top: cur.top && cur.hops === 0 && r.file !== cur.file })
    }
  }
  for (const x of direct) via.delete(x)
  return { direct, first, via, reached }
}

function regionOf(f, line, boundaryLines) {
  const startOff = f.starts[line - 1] ?? 0
  const next = boundaryLines.find((l) => l > line)
  const endOff = Math.min(next ? f.starts[next - 1] : f.raw.length, ...[...f.decls.values()].map((d) => d.start).filter((s) => s > startOff))
  return [startOff, endOff]
}

function libList(refs, onlyLibs = true) {
  const byMod = new Map()
  for (const r of refs) {
    const isLib = r.file.startsWith('server/lib/') || r.file.startsWith('server/mcp/')
    if (onlyLibs && !isLib) continue
    if (r.decl.kind !== 'fn') continue
    if (!byMod.has(r.file)) byMod.set(r.file, new Set())
    byMod.get(r.file).add(r.decl.name)
  }
  return byMod
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------
const LIMITS = `## 扫描边界（必读）

本文件由静态文本扫描生成，不执行代码，不是调用图证明。看不到：动态分发（\`handlers[x]()\`、注册表、docflow 流转表）、把函数当参数传出去后在别处调用、\`FROM \${变量}\` 与逗号连接的表、小写 SQL。
“经 lib 触达的表”沿跨文件调用最多 ${MAX_HOPS} 跳，是**可能触达**的上界。完整清单见 [scripts/gen-codemap.mjs](../../scripts/gen-codemap.mjs) 文件头。`

export function generate({ root }) {
  root = path.resolve(root)
  const idx = buildIndex(root)
  const migrations = scanMigrations(root)

  // 已知表
  const creators = new Map() // table -> Set(origin)
  const addCreator = (t, o) => { t = t.toLowerCase(); if (!creators.has(t)) creators.set(t, new Set()); creators.get(t).add(o) }
  const schemaPath = path.join(root, 'server/db/schema.sql')
  if (fs.existsSync(schemaPath)) for (const m of fs.readFileSync(schemaPath, 'utf8').matchAll(CREATE_RE)) addCreator(m[1], 'schema.sql')
  for (const m of migrations) for (const t of m.created) addCreator(t, m.num)
  for (const [rel, f] of idx) for (const m of f.sql.matchAll(CREATE_RE)) addCreator(m[1], `运行时 ${rel.replace(/^server\//, '')}`)
  const known = new Set(creators.keys())

  // 路由
  const routes = listRoutes(root)
  const boundaryByFile = new Map()
  for (const r of routes) { if (!boundaryByFile.has(r.file)) boundaryByFile.set(r.file, []); boundaryByFile.get(r.file).push(r.line) }
  for (const v of boundaryByFile.values()) v.sort((a, b) => a - b)
  const routeData = routes.map((r) => {
    const f = idx.get(r.file)
    if (!f) return { ...r, direct: new Set(), via: new Set(), first: new Map() }
    const [a, b] = regionOf(f, r.line, boundaryByFile.get(r.file))
    return { ...r, ...analyse(idx, r.file, f.sql.slice(a, b), f.ident.slice(a, b), known) }
  })

  // MCP 工具
  const tools = []
  const tf = idx.get('server/mcp/tools.js')
  if (tf) {
    const s = tf.sql.indexOf('export const TOOLS = [')
    const e = s >= 0 ? tf.sql.indexOf('\n]\n', s) : -1
    if (s >= 0 && e > s) {
      const seg = tf.sql.slice(s, e)
      const ms = [...seg.matchAll(/^ {4}name:\s*'([\w.]+)'/gm)]
      ms.forEach((m, i) => {
        const a = s + m.index
        const b = i + 1 < ms.length ? s + ms[i + 1].index : e
        const body = tf.sql.slice(a, b)
        const level = /level:\s*'(\w+)'/.exec(body)?.[1] ?? ''
        const perms = /perms:\s*\[([^\]]*)\]/.exec(body)?.[1].replace(/['"\s]/g, '').split(',').filter(Boolean) ?? []
        tools.push({ name: m[1], level, perms, ...analyse(idx, 'server/mcp/tools.js', body, tf.ident.slice(a, b), known) })
      })
    }
  }

  // ---- routes.md
  const stats = { routes: routes.length, tools: tools.length }
  const byFile = new Map()
  for (const r of routeData) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r) }
  const fmtLibs = (first) => {
    const m = libList(first.values())
    for (const k of [...m.keys()]) if (PLUMBING.has(k)) m.delete(k)
    return [...m.keys()].sort(cmp).map((k) => `${k.replace(/^server\//, '')}: ${uniqSorted(m.get(k)).join(', ')}`).join('<br>') || '—'
  }
  const fmtT = (s) => (s.size ? uniqSorted(s).join(', ') : '—')
  let md = `# 路由代码地图\n\n${MARKER}\n<!-- 由 \`node scripts/gen-codemap.mjs\` 生成，勿手改；CI 校验不漂移 -->\n\n`
  md += `共 ${routes.length} 条路由（含 ${routes.filter((r) => r.verb === 'USE').length} 条子路由器挂载），${byFile.size} 个路由文件。路由、分类与中间件链来自 \`node scripts/check-route-authz.mjs --list\`（只显示中间件名，权限码以源码为准）。`
  md += `“调用的 lib 函数”只列 server/lib 与 server/mcp 的函数（\`lib/http.js\` 的响应工具不列）；“处理器内 SQL 表”含本文件内辅助函数；“经 lib 触达的表”为跨文件可能触达的上界。\n\n${LIMITS}\n`
  for (const file of [...byFile.keys()].sort(cmp)) {
    md += `\n## ${file}\n\n| 处理器 | 方法 | 路径 | 分类 | 中间件链 | 调用的 lib 函数 | 处理器内 SQL 表 | 经 lib 触达的表 |\n|---|---|---|---|---|---|---|---|\n`
    for (const r of byFile.get(file)) {
      md += `| \`${r.file.replace('server/routes/', '')}:${r.line}\` | ${r.verb} | \`${esc(r.path)}\` | ${r.cls} | ${esc(r.chain) || '（无）'} | ${fmtLibs(r.first)} | ${fmtT(r.direct)} | ${fmtT(r.via)} |\n`
    }
  }

  // ---- modules.md
  const usage = new Map() // key -> { routes:[], tools:[], mods:Set }
  const u = (k) => { if (!usage.has(k)) usage.set(k, { routes: [], tools: [], mods: new Set() }); return usage.get(k) }
  for (const r of routeData) for (const [k, ref] of r.first) if (ref.decl.kind === 'fn') u(k).routes.push(r)
  for (const t of tools) for (const [k] of t.first) u(k).tools.push(t.name)
  const isMod = (p) => p.startsWith('server/lib/') || p.startsWith('server/mcp/')
  for (const [rel, f] of idx) {
    if (!isMod(rel)) continue
    for (const d of f.decls.values()) for (const ref of refsIn(idx, rel, d.ident).values()) if (ref.cross) u(`${ref.file}#${ref.decl.name}`).mods.add(rel)
  }
  const modFiles = [...idx.keys()].filter(isMod).sort(cmp)
  const routeLabel = (r) => `${r.verb} ${r.path}`
  let mm = `# 模块代码地图（server/lib 与 server/mcp）\n\n${MARKER}\n<!-- 由 \`node scripts/gen-codemap.mjs\` 生成，勿手改；CI 校验不漂移 -->\n\n`
  mm += `共 ${modFiles.length} 个模块。“路由”只列在处理器区域内直接引用该函数的路由（路由超过 5 条时按路由文件汇总，明细见 [routes.md](routes.md)）；“MCP 工具”来自 \`server/mcp/tools.js\` 的 ${tools.length} 个工具；“被模块调用”是其它 lib/mcp 模块里的跨文件引用。“—”表示静态扫描没找到调用方，不等于死代码。\n\n${LIMITS}\n`
  for (const rel of modFiles) {
    const f = idx.get(rel)
    const names = uniqSorted([...f.exports.keys(), ...f.reexports.keys()])
    mm += `\n## \`${rel}\`\n\n${f.header ? `${esc(f.header)}\n\n` : ''}`
    if (!names.length) { mm += '（无具名导出）\n'; continue }
    mm += '| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |\n|---|---|---|---|---|\n'
    for (const n of names) {
      const d = f.decls.get(f.exports.get(n))
      const orig = d ? { file: rel, decl: d } : (f.reexports.get(n)?.file ? declOf(idx, f.reexports.get(n).file, f.reexports.get(n).name) : null)
      const us = (orig && usage.get(`${orig.file}#${orig.decl.name}`)) || { routes: [], tools: [], mods: new Set() }
      const rs = us.routes
      let rcell = '—'
      if (rs.length && rs.length <= 5) rcell = rs.map((r) => `${esc(routeLabel(r))}`).join('<br>')
      else if (rs.length) {
        const c = new Map(); for (const r of rs) c.set(r.file.replace('server/routes/', ''), (c.get(r.file.replace('server/routes/', '')) ?? 0) + 1)
        rcell = `${rs.length} 条：` + [...c.keys()].sort(cmp).map((k) => `${k}×${c.get(k)}`).join(', ')
      }
      const ts = uniqSorted(us.tools)
      const tcell = !ts.length ? '—' : ts.length <= 8 ? ts.join(', ') : `${ts.length} 个：${ts.slice(0, 8).join(', ')} …`
      const ms = uniqSorted(us.mods).map((x) => x.replace(/^server\//, ''))
      const mcell = !ms.length ? '—' : ms.length <= 6 ? ms.join(', ') : `${ms.length} 个：${ms.slice(0, 6).join(', ')} …`
      mm += `| \`${n}\` | ${d ? d.kind : `再导出（${orig ? orig.file.replace(/^server\//, '') : '未解析'}）`} | ${rcell} | ${tcell} | ${mcell} |\n`
    }
  }
  mm += `\n## MCP 工具 → lib 函数 → 表\n\n| 工具 | 级别 | 权限点 | 调用的 lib 函数 | 工具内 SQL 表 | 经 lib 触达的表 |\n|---|---|---|---|---|---|\n`
  for (const t of tools) mm += `| \`${t.name}\` | ${t.level} | ${t.perms.join(', ') || '—'} | ${fmtLibs(t.first)} | ${fmtT(t.direct)} | ${fmtT(t.via)} |\n`

  // ---- tables.md
  const touch = new Map() // table -> { libs:Set, routes:Set }
  const tt = (t) => { if (!touch.has(t)) touch.set(t, { libs: new Set(), routes: new Set() }); return touch.get(t) }
  for (const [rel, f] of idx) {
    if (rel.startsWith('server/db/')) continue
    const isRoute = rel.startsWith('server/routes/')
    for (const t of tablesIn(f.sql, known)) (isRoute ? tt(t).routes : tt(t).libs).add(rel.replace(/^server\//, ''))
  }
  const alters = new Map()
  for (const m of migrations) for (const [t, tags] of m.altered) { if (!alters.has(t)) alters.set(t, []); alters.get(t).push(`${m.num}${[...tags].sort(cmp).join('')}`) }
  let tm = `# 数据表代码地图\n\n${MARKER}\n<!-- 由 \`node scripts/gen-codemap.mjs\` 生成，勿手改；CI 校验不漂移 -->\n\n`
  tm += `共 ${known.size} 张表、${migrations.length} 个迁移。“建于”= schema.sql / 迁移编号 / 运行时建表的文件；“改于”= ALTER、addColumn（无后缀）、建索引（·idx）、触发器（·trg）、DROP（·drop）所在迁移编号。“触达”= 该文件的 SQL 文本里出现这张表（server/db/ 下的种子与启动文件不计）。\n\n${LIMITS}\n`
  tm += `\n## 表索引\n\n| 表 | 建于 | 改于 | lib / mcp / 中间件 / 其它直接触达 | 路由文件内直接 SQL |\n|---|---|---|---|---|\n`
  for (const t of [...known].sort(cmp)) {
    const x = touch.get(t) ?? { libs: new Set(), routes: new Set() }
    tm += `| \`${t}\` | ${uniqSorted(creators.get(t)).join(', ')} | ${uniqSorted(alters.get(t) ?? []).join(', ') || '—'} | ${uniqSorted(x.libs).join(', ') || '—'} | ${uniqSorted(x.routes).join(', ') || '—'} |\n`
  }
  tm += `\n## 迁移索引\n\n| 编号 | 文件 | 名称 | 建表 | 改表 |\n|---|---|---|---|---|\n`
  for (const m of migrations) {
    tm += `| ${m.num} | \`${m.file}\` | ${esc(m.name) || '—'} | ${m.created.join(', ') || '—'} | ${[...m.altered.keys()].sort(cmp).join(', ') || '—'} |\n`
  }

  // ---- ADR-INDEX.md
  const adrDir = path.join(root, 'docs/implementation')
  const adrFiles = fs.existsSync(adrDir) ? fs.readdirSync(adrDir).filter((f) => /^ADR-\d{4}-.+\.md$/.test(f)).sort(cmp) : []
  const exists = (p) => fs.existsSync(path.join(root, p))
  let am = `# ADR 索引\n\n${MARKER}\n<!-- 由 \`node scripts/gen-codemap.mjs\` 生成，勿手改；CI 校验不漂移 -->\n\n`
  am += `共 ${adrFiles.length} 个 ADR 文件。批次来自 \`scripts/gen-changelog.mjs\` 的 BATCHES（编号区间）；状态是 ADR 原文“状态：”一句的摘录（没有就如实标注），**不代表验收**；“守卫 / 测试”是 ADR 正文里提到的文件路径（静态正则提取，路径不存在时标注“（不存在）”），不证明该测试覆盖了 ADR 的全部决定。\n\n`
  am += '| 编号 | 标题 | 批次 | 状态（原文摘录） | 守卫（scripts/） | 测试（tests/） |\n|---|---|---|---|---|---|\n'
  for (const f of adrFiles) {
    const md0 = fs.readFileSync(path.join(adrDir, f), 'utf8').replace(/\r\n?/g, '\n')
    const title = (/^#\s+(.+?)\s*$/m.exec(md0)?.[1] ?? f).replace(/\*\*/g, '')
    const num = Number(f.slice(4, 8))
    const b = batchOf(num)
    const batch = b ? b.title.split('：')[0] : '未归批'
    const st = /状态[：:]\s*([^。｜\n]+)/.exec(md0)
    const status = st ? st[1].trim().replace(/\s+/g, ' ').slice(0, 60) : '（ADR 未写出状态）'
    const code = md0.replace(/```[\s\S]*?```/g, (x) => x)
    const refs = (re) => uniqSorted([...code.matchAll(re)].map((m) => m[0].replace(/[.,;:)]+$/, '')))
    const guards = refs(/scripts\/[A-Za-z0-9_\-/]+\.(?:mjs|cjs|js)/g)
    const tests = refs(/tests\/[A-Za-z0-9_\-/]+\.(?:mjs|js)/g)
    const fmt = (l) => (l.length ? l.map((p) => `\`${p.replace(/^(scripts|tests)\//, '')}\`${exists(p) ? '' : '（不存在）'}`).join('<br>') : '—')
    am += `| ${f.slice(4, 8)} | [${esc(title)}](${f}) | ${batch} | ${esc(status)} | ${fmt(guards)} | ${fmt(tests)} |\n`
  }
  void BATCHES

  const files = { [OUTPUTS.routes]: md, [OUTPUTS.modules]: mm, [OUTPUTS.tables]: tm, [OUTPUTS.adr]: am }
  Object.assign(stats, { modules: modFiles.length, tables: known.size, migrations: migrations.length, adrs: adrFiles.length })
  return { files, stats }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootArg = process.argv.find((a) => a.startsWith('--root='))
  const root = rootArg ? path.resolve(rootArg.slice(7)) : path.resolve(SELF_DIR, '..')
  const { files, stats } = generate({ root })
  const summary = `${stats.routes} routes, ${stats.modules} modules, ${stats.tables} tables, ${stats.migrations} migrations, ${stats.tools} MCP tools, ${stats.adrs} ADRs`
  if (process.argv.includes('--check')) {
    const stale = Object.keys(files).filter((rel) => {
      const p = path.join(root, rel)
      return !fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== files[rel]
    })
    if (stale.length) { console.error(`codemap is stale (${stale.join(', ')}); run node scripts/gen-codemap.mjs and commit`); process.exit(1) }
    console.log(`[codemap] current (${summary})`)
  } else {
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
    console.log(`wrote ${Object.keys(files).join(', ')} (${summary})`)
  }
}
