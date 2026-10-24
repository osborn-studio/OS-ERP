#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/evidence-log-ingest.mjs ｜ 把托管 CI artifact 里的 evidence-log-line.jsonl 校验后追加到仓库证据日志（AE10）
 * ============================================================================
 * 【职责】维护者在本机执行（不在 CI 里）：下载候选 artifact → 本脚本 → 提交 docs/release/EVIDENCE-LOG.jsonl。
 *   用法：node scripts/evidence-log-ingest.mjs --line <evidence-log-line.jsonl> [--log <repo log>]
 * 【校验】恰好一行规范化 JSON；schema/字段集/名称格式；built_by 必须是 hosted-ci 且 signature 为 null；
 *   prev 必须等于当前日志链尾哈希（日志为空则为 genesis）；候选名在日志中唯一；时间戳不倒退。
 *   实现上是"现有日志 + 此行"整体重新过一遍 verifyLog，再在与 release-candidate 相同的独占锁里追加并 fsync。
 *   任何一项不满足 ⇒ 退出码 1，日志不变。
 * 【边界】这条日志行由 CI 构建者自述，不证明证据为真；本脚本不下载 artifact、不联网、不签名、不提交。
 *   artifact 来自 CI 运行，其内容仍须由维护者对照该 run 核对。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOG_FILE, appendVerifiedLine } from './lib/evidence-log.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const usage = 'usage: node scripts/evidence-log-ingest.mjs --line <evidence-log-line.jsonl> [--log <repo log>]'

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(line|log)(?:=(.*))?$/.exec(argv[i])
    if (!m) throw new Error(`unknown argument ${argv[i]}\n${usage}`)
    const v = m[2] ?? argv[++i]
    if (!v || v.startsWith('--')) throw new Error(`--${m[1]} needs a value\n${usage}`)
    if (out[m[1]] !== undefined) throw new Error(`--${m[1]} given twice`)
    out[m[1]] = v
  }
  if (!out.line) throw new Error(usage)
  return out
}

export function ingest({ line, log = path.join(ROOT, LOG_FILE) }) {
  const st = fs.lstatSync(line)
  if (!st.isFile()) throw new Error(`${line} is not a regular file`)
  if (st.size > 4096) throw new Error(`${line} is too large for one evidence log line`)
  return appendVerifiedLine(log, fs.readFileSync(line, 'utf8'))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2))
    const entry = ingest({ line: path.resolve(opts.line), ...(opts.log ? { log: path.resolve(opts.log) } : {}) })
    console.log(`ingested ${entry.name} (built_by ${entry.built_by}) into the evidence log; review the diff and commit it`)
  } catch (error) {
    console.error(`evidence-log-ingest: ${error.message}`)
    process.exit(1)
  }
}
