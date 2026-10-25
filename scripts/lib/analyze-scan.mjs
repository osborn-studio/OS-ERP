/**
 * ============================================================================
 * 文件标识：scripts/lib/analyze-scan.mjs ｜ 源码扫描：非测试代码不得执行 ANALYZE / PRAGMA optimize（roadmap-v12 AG3，ADR-0044 补充 6）
 * ============================================================================
 * 【职责】explain-audit 的断言与计划快照都以"没有 sqlite_stat1"为前提（docs/operations/query-planner.md）。如果 server/、scripts/ 里有人加了
 *   会生成统计的语句，计划会悄悄变；这里在 CI 里把它变成红灯。
 * 【怎么扫】
 *   · JS/MJS/CJS/TS/TSX：小型词法扫描，去掉注释（// 和 块注释），保留字符串 / 模板字面量内容（含模板里 ${} 内的代码），
 *     字符串里出现独立单词（前后不是路径 / 文件名字符） ANALYZE（不分大小写）或 PRAGMA optimize → 命中；`pragma(` 调用的字符串参数以 optimize 开头 → 命中。
 *     正则字面量按"表达式开头"启发式跳过，避免里面的引号让词法扫描错位。标识符 / 函数名（analyze()）不算。
 *   · .sql：去掉 -- 与块注释后整体匹配。
 *   · 跳过 tests/、*.test.*、node_modules、dist 及非源码文件。
 * 【诚实边界】这是静态文本检查：运行时拼接（'ANA' + 'LYZE'）、eval、子进程里调 sqlite3 命令行、package.json / 工作流里的命令都扫不到；
 *   它防"手滑把 ANALYZE 写进代码"，不防有意绕过。本文件的模式用片段拼接，使守卫自己不命中。
 * 【ANALYZE_ALLOW】{ file, reason }：整文件豁免，必须写理由（≥20 字符）；条目所指文件已没有命中则算过期、同样报红。当前为空。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const ANALYZE_ALLOW = []
export const SCAN_DIRS = ['server', 'scripts'] // 不含 src/：前端文案可能含 "Analyze"，且前端不碰数据库
const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'])
const SKIP_DIR = new Set(['node_modules', 'dist', 'tests', '.git'])
const MIN_REASON = 20

// 片段拼接：让本文件自己的源码不含完整关键字
const RE_ANALYZE = new RegExp('(?<![\\w./-])' + 'ANAL' + 'YZE' + '(?![\\w/-])', 'i') // 前后不是路径 / 文件名字符：'./lib/analyze-scan.mjs' 不算
const RE_PRAGMA_OPT = new RegExp('\\b' + 'PRAG' + 'MA' + '\\s+(?:[A-Za-z_]\\w*\\.)?' + 'optim' + 'ize' + '\\b', 'i') // 含 schema 限定：PRAGMA main.optimize
const RE_OPT_ARG = new RegExp('^\\s*(?:[A-Za-z_]\\w*\\.)?' + 'optim' + 'ize' + '\\b', 'i')
const RE_PRAGMA_CALL = new RegExp('prag' + 'ma' + '\\s*\\(\\s*$', 'i')

const lineOf = (src, idx) => { let n = 1; for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++; return n }

// 字符串里的 SQL 注释（块注释 / 行注释）换成同长度空格，使带注释的写法仍能被识别，行号不受影响（Codex 审计 AG3）
function blankSqlComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/--[^\n]*/g, m => ' '.repeat(m.length))
}

function sqlHits(rawText, base, file, src) {
  const text = blankSqlComments(rawText)
  const out = []
  const a = RE_ANALYZE.exec(text); if (a) out.push({ file, line: lineOf(src, base + a.index), rule: 'stats' })
  const p = RE_PRAGMA_OPT.exec(text); if (p) out.push({ file, line: lineOf(src, base + p.index), rule: 'pragma-optimize' })
  return out
}

function scanSql(src, file) {
  let code = '', i = 0
  while (i < src.length) {
    if (src.startsWith('--', i)) { while (i < src.length && src[i] !== '\n') i++ ; continue }
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; code += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue }
    code += src[i++]
  }
  return sqlHits(code, 0, file, src)
}

/** 取字符串（引号内）内容，返回结束位置；模板字面量里的 ${…} 递归当代码扫 */
function scanJs(src, file) {
  const hits = []
  let i = 0
  let tail = '' // 最近的非空白代码字符（给 pragma( 判定和正则/除号判定用）
  const pushTail = (s) => { tail = (tail + s).slice(-40) }
  const parens = [] // 每个未闭合的 '(' 是否属于 if/while/for/with 的条件；其 ')' 之后的 '/' 是正则而不是除号
  let lastParenCtl = false
  const isRegexStart = () => { const t = tail.trimEnd(); if (!t) return true; const c = t[t.length - 1]; if (c === ')') return lastParenCtl
    if (/[\]}\w$"'`]/.test(c)) { const word = /(?:return|typeof|case|in|of|delete|void|throw|new|else|do)$/.exec(t); return !!word && !/[\w$]/.test(t[t.length - 1 - word[0].length] ?? ' ') } return true }
  const frames = [{ type: 'code', depth: 0 }]
  const flushString = (text, start, isPragmaArg) => {
    if (isPragmaArg && RE_OPT_ARG.test(text)) hits.push({ file, line: lineOf(src, start), rule: 'pragma-optimize' })
    for (const h of sqlHits(text, start, file, src)) hits.push(h)
  }
  while (i < src.length) {
    const top = frames[frames.length - 1]
    if (top.type === 'tpl') {
      // 模板字面量主体：累计文本，遇 ${ 进入代码帧，遇 ` 结束
      let j = i, buf = ''
      const start = i
      while (j < src.length) {
        const c = src[j]
        if (c === '\\') { buf += src.slice(j, j + 2); j += 2; continue }
        if (c === '`') break
        if (c === '$' && src[j + 1] === '{') break
        buf += c; j++
      }
      flushString(buf, start, top.pragmaArg && j >= src.length ? false : top.pragmaArg && src[j] === '`' && !top.hadExpr)
      i = j
      if (i >= src.length) break
      if (src[i] === '`') { frames.pop(); i++; pushTail('`'); continue }
      top.hadExpr = true
      frames.push({ type: 'code', depth: 0, fromTpl: true }); i += 2; continue
    }
    const c = src[i], n = src[i + 1]
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue }
    if (c === '\'' || c === '"') {
      let j = i + 1, buf = ''
      while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { buf += src.slice(j, j + 2); j += 2 } else buf += src[j++] }
      flushString(buf, i + 1, RE_PRAGMA_CALL.test(tail))
      i = j + 1; pushTail('"'); continue
    }
    if (c === '`') { frames.push({ type: 'tpl', pragmaArg: RE_PRAGMA_CALL.test(tail), hadExpr: false }); i++; continue }
    if (c === '/' && isRegexStart()) {
      let j = i + 1, cls = false
      while (j < src.length && src[j] !== '\n') { const d = src[j]; if (d === '\\') { j += 2; continue } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; j++ }
      i = j + 1; pushTail('/r/'); continue
    }
    if (c === '{') top.depth++
    if (c === '}') { if (top.depth === 0 && top.fromTpl) { frames.pop(); i++; continue } top.depth = Math.max(0, top.depth - 1) }
    if (c === '(') parens.push(/(?:^|[^\w$.])(?:if|while|for|with)\s*$/.test(tail))
    else if (c === ')') lastParenCtl = parens.pop() ?? false
    if (/\s/.test(c)) { if (!tail.endsWith(' ')) pushTail(' ') } else pushTail(c)
    i++
  }
  return hits
}

/** 扫一段源码；file 决定按 SQL 还是 JS 处理（扩展名） */
export function scanSource(src, file) {
  return path.extname(file).toLowerCase() === '.sql' ? scanSql(src, file) : scanJs(src, file)
}

const isTestFile = (name) => /\.test\.[cm]?[jt]sx?$/.test(name) || /\.spec\.[cm]?[jt]sx?$/.test(name)

function* walk(abs, rel) {
  let entries
  try { entries = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isSymbolicLink()) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) yield* walk(path.join(abs, e.name), r) } else if (e.isFile()) yield r
  }
}

/** 扫目录树。返回 { ok, hits, staleAllow, filesScanned } */
export function scanTree(root = ROOT, { dirs = SCAN_DIRS, allow = ANALYZE_ALLOW } = {}) {
  for (const a of allow) if (!a.file || !a.reason || String(a.reason).trim().length < MIN_REASON) throw new Error(`统计语句扫描豁免 ${a.file ?? '?'} 必须写理由 reason（至少 ${MIN_REASON} 个字符）`)
  const raw = []
  let filesScanned = 0
  for (const d of dirs) {
    for (const rel of walk(path.join(root, d), d)) {
      const ext = path.extname(rel).toLowerCase()
      if ((!SRC_EXT.has(ext) && ext !== '.sql') || isTestFile(rel)) continue
      filesScanned++
      for (const h of scanSource(fs.readFileSync(path.join(root, rel), 'utf8'), rel)) raw.push(h)
    }
  }
  const allowed = new Set(allow.map(a => a.file))
  const hits = raw.filter(h => !allowed.has(h.file))
  const hitFiles = new Set(raw.map(h => h.file))
  const staleAllow = allow.filter(a => !hitFiles.has(a.file))
  return { ok: hits.length === 0 && staleAllow.length === 0, hits, staleAllow, filesScanned }
}
