#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/bench-mcp-rate-store.mjs ｜ MCP 限速存储（memory vs db）单次 consume 开销基准（AE9，ADR-0056 补充）
 * ============================================================================
 * 【职责】在临时目录里建一个 WAL 库（迁移 073 的表），分别对 memory / db 模式跑 N 次 `consume`（读 / 写各一轮），
 *   打印每次调用的 p50 / p95 / 平均微秒。额度开到最大，只测"放行"路径。输出 JSON 一行 + 人读表。
 * 【用法】node scripts/bench-mcp-rate-store.mjs [--n=20000] [--tokens=50]
 * 【边界】单进程、单连接、本机磁盘（`synchronous` 取库默认）；不含 HTTP 与鉴权开销，也不含多进程写锁争用——只回答"db 模式比 memory 多多少"。
 * ============================================================================
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { createMcpRateLimiter } from '../server/lib/mcp-rate-limit.js'

const require = createRequire(import.meta.url)
const arg = (k, d) => Number((process.argv.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=')[1] ?? d)
const N = arg('n', 20000)
const TOKENS = arg('tokens', 50)

const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-bench-rate-'))
try {
  const db = new Database(path.join(dir, 'bench.db'))
  db.pragma('journal_mode=WAL'); db.pragma('busy_timeout=5000')
  require('../server/db/migrations/073_mcp_rate_buckets.cjs').up(db)
  const run = (store, level) => {
    const l = createMcpRateLimiter({ env: { GML_MCP_RATE_STORE: store, GML_MCP_TOKEN_RPM: '1000000', GML_MCP_WRITE_RPM: '1000000' } })
    for (let i = 0; i < 500; i++) l.consume((i % TOKENS) + 1, level, 'cosmetic', db) // 预热
    const us = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint()
      const r = l.consume((i % TOKENS) + 1, level, 'cosmetic', db)
      us[i] = Number(process.hrtime.bigint() - t0) / 1000
      if (!r.allowed) throw new Error(`unexpected refusal: ${r.reason}`)
    }
    us.sort()
    return { store, level, n: N, p50_us: +us[Math.floor(N * 0.5)].toFixed(1), p95_us: +us[Math.floor(N * 0.95)].toFixed(1), p99_us: +us[Math.floor(N * 0.99)].toFixed(1), mean_us: +(us.reduce((a, b) => a + b, 0) / N).toFixed(1) }
  }
  const out = [run('memory', 'read'), run('db', 'read'), run('memory', 'write'), run('db', 'write')]
  console.table(out)
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, results: out }))
  db.close()
} finally { rmSync(dir, { recursive: true, force: true }) }
