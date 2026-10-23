#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/upstream-similarity.mjs ｜ 本地文件与上游文件的 token 重合率（X12，来源取证用）
 * ============================================================================
 * 【做什么】对两个文本文件计算「简单 token 重合率」，供 docs/legal/PROVENANCE.md 记录每个
 *   reusable 文件相对其上游参考文件的重合程度。零依赖，纯统计。
 * 【度量（务必如实理解）】
 *   1. 预处理：去掉 // 与 /* *\/ 注释以及以 # 开头的整行注释；按 [A-Za-z_$][\w$]* 与数字切出标识符/数字，
 *      再把驼峰与下划线拆成小写子词（"appliedPromotionsMap" 与 "applied_promotions_map" 同为 applied,promotions,map）。
 *      不解析语法，不区分关键字；字符串字面量里的词也会被切成 token，注释剥离只是正则，字符串里的 `//`（如 URL）会让该行余下内容被丢弃。
 *   2. unigramJaccard：两侧「不同子词集合」的 Jaccard = |A∩B| / |A∪B|。受文件长度差影响大，
 *      长文件对短文件会拉低该值；关键字/常见词会抬高该值。
 *   3. shingle5：连续 5 个子词为一片（shingle）。localInUpstream = 本地片中也出现在上游的比例；
 *      upstreamInLocal = 上游片中也出现在本地的比例。前者最能回答「本地文件有多少片段能在上游找到」。
 * 【它不是什么】不是抄袭检测，不是法律意见，不是著作权相似性判断。改名、改写、换语言（TS→JS）、重排都会
 *   把重合率压低；通用片段（import、循环、括号）会把它抬高。低值不证明独立创作，高值不证明复制。
 *   使用时应与「对照行」（本地文件对一个无关上游文件的重合率，即噪声底）一起读。
 * 【用法】node scripts/upstream-similarity.mjs <本地文件> <上游文件> [--json] [--shared]（--shared 逐条列出共有片段）
 * 【导出】similarity(textA, textB) / sharedShingleList(textA, textB, limit) / tokenize(text) / shingles(tokens, n)
 * ============================================================================
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SHINGLE_SIZE = 5

export function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
    .replace(/^[ \t]*#[^\n]*/gm, ' ')
}

export function tokenize(text) {
  const out = []
  const words = stripComments(text).match(/[A-Za-z_$][\w$]*|\d+/g) || []
  for (const w of words) {
    const parts = w
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_$]+/)
      .filter(Boolean)
    for (const p of parts) out.push(p.toLowerCase())
  }
  return out
}

export function shingles(tokens, n = SHINGLE_SIZE) {
  const set = new Set()
  for (let i = 0; i + n <= tokens.length; i++) set.add(tokens.slice(i, i + n).join(' '))
  return set
}

function ratio(num, den) { return den === 0 ? 0 : num / den }
function round(x) { return Math.round(x * 10000) / 10000 }

/** 列出两侧共有的 5-shingle（最多 limit 条），人工判断重合是通用片段还是实质片段。 */
export function sharedShingleList(textA, textB, limit = 50) {
  const sb = shingles(tokenize(textB))
  const out = []
  for (const s of shingles(tokenize(textA))) {
    if (sb.has(s)) out.push(s)
    if (out.length >= limit) break
  }
  return out
}

export function similarity(textA, textB) {
  const ta = tokenize(textA)
  const tb = tokenize(textB)
  const ua = new Set(ta)
  const ub = new Set(tb)
  let inter = 0
  for (const t of ua) if (ub.has(t)) inter++
  const sa = shingles(ta)
  const sb = shingles(tb)
  let shared = 0
  for (const s of sa) if (sb.has(s)) shared++
  return {
    tokensA: ta.length,
    tokensB: tb.length,
    unigramJaccard: round(ratio(inter, ua.size + ub.size - inter)),
    shingleSize: SHINGLE_SIZE,
    shinglesA: sa.size,
    shinglesB: sb.size,
    sharedShingles: shared,
    localInUpstream: round(ratio(shared, sa.size)),
    upstreamInLocal: round(ratio(shared, sb.size))
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const json = process.argv.includes('--json')
  if (args.length !== 2) {
    console.error('usage: node scripts/upstream-similarity.mjs <local-file> <upstream-file> [--json] [--shared]')
    process.exit(2)
  }
  const r = similarity(fs.readFileSync(args[0], 'utf8'), fs.readFileSync(args[1], 'utf8'))
  if (process.argv.includes('--shared')) {
    for (const s of sharedShingleList(fs.readFileSync(args[0], 'utf8'), fs.readFileSync(args[1], 'utf8'))) console.log(`shared: ${s}`)
  }
  if (json) console.log(JSON.stringify(r))
  else {
    console.log(`unigram Jaccard        : ${(r.unigramJaccard * 100).toFixed(2)}%`)
    console.log(`5-shingle local in up  : ${(r.localInUpstream * 100).toFixed(2)}%  (${r.sharedShingles}/${r.shinglesA})`)
    console.log(`5-shingle up in local  : ${(r.upstreamInLocal * 100).toFixed(2)}%  (${r.sharedShingles}/${r.shinglesB})`)
  }
}
