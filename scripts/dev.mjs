#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/dev.mjs ｜ 本地开发启动器（前后端同起）
 * ============================================================================
 * 【职责】本地开发启动器（前后端同起）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自手写**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 开发模式启动器：同时拉起后端 API（3001）与 Vite 前端（5173）
 * 用法：npm run dev
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const procs = []

function run(name, cmd, args, color) {
  const p = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  const tag = `\x1b[${color}m[${name}]\x1b[0m`
  const pipe = (stream) => {
    stream.setEncoding('utf8')
    let buf = ''
    stream.on('data', (chunk) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) console.log(`${tag} ${line}`)
    })
  }
  pipe(p.stdout)
  pipe(p.stderr)
  p.on('exit', (code) => {
    console.log(`${tag} 进程退出，code=${code}`)
    stop(code ?? 0)
  })
  procs.push(p)
  return p
}

function stop(code = 0) {
  for (const p of procs) {
    try {
      p.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  process.exit(code)
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

console.log('\n  GML 供应链协同系统 · 开发模式\n')
run('api', process.execPath, ['server/index.js'], '32')
run('web', process.execPath, ['node_modules/vite/bin/vite.js'], '36')
console.log('\n  前端 http://localhost:5173    后端 http://localhost:3001\n')
