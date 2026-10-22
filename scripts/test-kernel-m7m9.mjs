#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/test-kernel-m7m9.mjs ｜ 测试：【复现脚本】M7 / M9：委外部分收货卡死 + 明细行静默跳过（批次 V）
 * ============================================================================
 * 【职责】测试：【复现脚本】M7 / M9：委外部分收货卡死 + 明细行静默跳过（批次 V）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 【复现脚本】M7 / M9：委外部分收货卡死 + 明细行静默跳过（批次 V）
//
//   用法：GML_DATA_DIR=/tmp/xxx node scripts/repro-kernel-m7-m9.mjs
//
// 复现的结论：
//   M9 修前 —— `POST /orders/:id/receive {items:[{id:null,qty:4}]}` 返回 **200**、
//               收货单 `total_qty=0`，而订单状态照样推进到 `part_received`（"一张 0 数量收货单 + 状态推进"）。
//   M7 修前 —— 部分收货后 `POST /orders/:id/status {action:'close'}` ⇒
//               `409 状态「part_received」已是终态，不能继续流转`（`available:[]`）。
//   修后 —— 上面那条被 400 拒；合法部分收货能收、能关，且 doc_events 有完整轨迹。
//
// 真实起服务（显式 GML_DATA_DIR + 显式 PORT），跑完回收子进程。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DATA = path.join(ROOT, 'data')
const PORT = Number(process.env.FK_PORT || 44317)
const BASE = `http://127.0.0.1:${PORT}`

// 隔离规则（本项目硬纪律）：
//   · 未设 GML_DATA_DIR ⇒ **自落**到 /tmp/gml-kernel-<脚本名>（所以它也能被 regress-all 自动发现而不碰仓库 data/）
//   · 指向仓库 data/ 或任何非 /tmp 路径 ⇒ 当场 exit 2 拒跑
//   · 本脚本只**只读**地从仓库 data/ 备份到隔离目录，绝不写 data/
function requireIsolatedDataDir() {
  const name = path.basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, '')
  const raw = process.env.GML_DATA_DIR || ''
  const abs = raw ? path.resolve(raw) : path.join('/tmp', `gml-kernel-${name}`)
  if (abs === REPO_DATA || abs.startsWith(REPO_DATA + path.sep)) {
    console.error(`✗ 拒绝运行：隔离目录指向仓库 data/（${abs}）。本脚本只允许在 /tmp 下的副本上跑。`); process.exit(2)
  }
  if (!abs.startsWith('/tmp/')) {
    console.error(`✗ 拒绝运行：隔离目录必须在 /tmp 下（实得 ${abs}）；不设 GML_DATA_DIR 时会自落到 /tmp/gml-kernel-${name}。`); process.exit(2)
  }
  fs.mkdirSync(abs, { recursive: true })
  // ⚠️ **先钉 env、再起子进程**：`db/index.js:11` 的 `DATA_DIR = process.env.GML_DATA_DIR || <仓库>/data`
  //    是在**模块加载时**求值的，而它在 `server/index.js` 这个**子进程**里求值。
  //    钉住它有两个作用：① 下面的 spawn 即使哪天被改成"继承 process.env"也仍落 /tmp；
  //    ② 让"自落 /tmp"这句话与本进程看到的环境一致，不再只是注释里的一句声明。
  process.env.GML_DATA_DIR = abs
  console.log(`${raw ? 'GML_DATA_DIR' : '未设 GML_DATA_DIR ⇒ 自落'} 隔离库目录：${abs}（仓库 data/ 不会被写）`)
  return abs
}
const DIR = requireIsolatedDataDir()
console.log(`隔离库目录：${DIR}   端口：${PORT}`)

// 从仓库 data/ 只读备份三个库（不写 data/）
const Database = (await import('better-sqlite3')).default
for (const c of ['cosmetic', 'food', 'apparel']) {
  const src = new Database(path.join(REPO_DATA, `gml_${c}.db`), { readonly: true })
  const dst = path.join(DIR, `gml_${c}.db`)
  for (const ext of ['', '-wal', '-shm']) { const p = dst + ext; if (fs.existsSync(p)) fs.rmSync(p) }
  await src.backup(dst)
  src.close()
}

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  // ⚠️ 保持**显式注入** `GML_DATA_DIR: DIR`（别改成只靠 process.env 继承）：
  //    这行是"子进程一定跑在隔离库上"的承重点，显式写出来才不会被下一个改 env 的人无声带走。
  env: { ...process.env, GML_DATA_DIR: DIR, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
child.stdout.on('data', (d) => { log += d.toString() })
child.stderr.on('data', (d) => { log += d.toString() })

/** 回收子进程：等 `exit` 事件再下结论；只有超时才报失败（不在 exit 钩子里探活） */
const stopAndReport = () => new Promise((resolve) => {
  if (!child) { console.log('无子进程需要回收'); return resolve() }
  const pid = child.pid
  if (child.exitCode !== null || child.signalCode !== null) { console.log(`已回收 pid ${pid}（结束时已退出）`); return resolve() }
  const timer = setTimeout(() => {
    let alive = false
    try { process.kill(pid, 0); alive = true } catch { /* 已退出 */ }
    console.log(alive ? `⚠️ 回收失败，pid ${pid} 仍在（SIGKILL 后 2s 仍存活；请 lsof -p ${pid} 复查）` : `已回收 pid ${pid}（2s 内退出）`)
    resolve()
  }, 2000)
  child.once('exit', () => { clearTimeout(timer); console.log(`已回收 pid ${pid}`); resolve() })
  try { child.kill('SIGKILL') } catch { /* ignore */ }
})

let pass = 0, fail = 0
// 形参名刻意与项目主流形状对齐（cond,msg,detail）—— 便于 check-test-helper-shape 直接登记，
// 不要改成 extra/note 之类的近邻名（守卫按形参名判形状，近邻互换正是它要拦的事故）。
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.log(`  ✗ ${msg}${detail ? '  → ' + detail : ''}`) }
}
const api = async (method, p, token, body) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let j = null
  try { j = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, body: j, raw: text }
}

try {
  const t0 = Date.now()
  const ready = await new Promise((resolve) => {
    const t = setInterval(() => {
      if (log.includes('服务已启动')) { clearInterval(t); resolve(true) }
      else if (Date.now() - t0 > 240000) { clearInterval(t); resolve(false) }
    }, 400)
  })
  if (!ready) throw new Error('服务未就绪，日志尾部：\n' + log.split('\n').slice(-30).join('\n'))
  console.log('✅ 服务已启动  ' + (log.split('\n').filter((l) => l.includes('[migrate]')).join(' | ') || '(无自愈)'))

  // 闸门（启动即验）：判据取自**子进程自报的实际库路径**（`server/index.js:123` 打的那句
  // `[gml] <版本> 数据库：<真实路径>`），不是自己再算一遍 —— "报告与实际必须同源"。
  // 只要有一个库不在隔离目录下，就当场回收子进程并 exit 2：否则整套断言是在**仓库 data/** 上跑的。
  const gateFail = async (msg) => { console.error(msg); await stopAndReport(); process.exit(2) }
  const dbPaths = [...log.matchAll(/数据库：(\S+)/g)].map((m) => m[1])
  if (!dbPaths.length) await gateFail('✗ 拒绝运行：子进程没有自报库路径（`数据库：` 一行都没抓到），无法确认隔离是否生效。')
  const outside = [...new Set(dbPaths)].filter((p) => !p.startsWith(DIR + '/'))
  if (outside.length) await gateFail(`✗ 拒绝运行：子进程实际使用的库不在隔离目录下：${outside.join(' / ')}（期望前缀 ${DIR}/）`)
  console.log(`隔离闸门：子进程自报 ${new Set(dbPaths).size} 个库路径，全部在 ${DIR}/ 下`)

  const login = await api('POST', '/api/auth/login', null, { username: 'admin', password: '12345', industry: 'cosmetic' })
  const token = login.body?.data?.token
  if (!token) throw new Error('登录失败：' + login.raw.slice(0, 200))

  const list = await api('GET', '/api/outsourcing/orders?status=issued', token)
  const rows = list.body?.data?.list || []
  const target = rows.find((r) => r.id)
  if (!target) throw new Error('找不到 status=issued 的委外订单夹具：' + list.raw.slice(0, 300))
  const before = await api('GET', `/api/outsourcing/orders/${target.id}`, token)
  const prod = (before.body.data.items || []).find((i) => i.role === 'product')
  const receiptsBefore = (before.body.data.receipts || []).length
  console.log(`\n夹具：委外单 #${target.id} ${target.doc_no} status=${before.body.data.status} 待收=${prod.qty - prod.received_qty} 成品行id=${prod.id}`)

  console.log('\n--- M9 验收 ---')
  const r1 = await api('POST', `/api/outsourcing/orders/${target.id}/receive`, token, { items: [{ id: null, qty: 4 }] })
  ok(r1.status >= 400, `① 匹配不上的行被拒（HTTP ${r1.status}）`, r1.raw.slice(0, 200))
  const after1 = await api('GET', `/api/outsourcing/orders/${target.id}`, token)
  ok(after1.body.data.status === 'issued', `③ 被拒后订单状态不变（${after1.body.data.status}）`)
  ok((after1.body.data.receipts || []).length === receiptsBefore, `③ 被拒后未新增收货单（${(after1.body.data.receipts || []).length}/${receiptsBefore}）`)
  const r2 = await api('POST', `/api/outsourcing/orders/${target.id}/receive`, token, { items: [{ id: prod.id, qty: 0 }] })
  ok(r2.status >= 400, `② 数量为 0 的行被拒（HTTP ${r2.status}）`, r2.raw.slice(0, 200))

  // /issue 侧同一条判据；夹具选「已审批且还有待发材料」的单，避免把「没有待发材料」的 400 误当通过
  const apprList = await api('GET', '/api/outsourcing/orders?status=approved', token)
  const apprRow = (apprList.body?.data?.list || []).find((r) => r.id)
  const appr = apprRow ? await api('GET', `/api/outsourcing/orders/${apprRow.id}`, token) : null
  const pendMat = appr ? (appr.body.data.items || []).filter((i) => i.role === 'material' && i.qty - i.issued_qty > 0) : []
  if (!appr || !pendMat.length) throw new Error('找不到「已审批且还有待发材料」的委外单夹具')
  const r2b = await api('POST', `/api/outsourcing/orders/${apprRow.id}/issue`, token, { items: [{ id: null, qty: 1 }] })
  ok(r2b.status >= 400 && /无法处理/.test(r2b.raw), `② /issue 匹配不上的行被拒（HTTP ${r2b.status}）`, r2b.raw.slice(0, 200))
  const after2b = await api('GET', `/api/outsourcing/orders/${apprRow.id}`, token)
  ok(after2b.body.data.status === 'approved', `② /issue 被拒后状态不变（${after2b.body.data.status}）`)

  const matIds = pendMat.slice(0, 2).map((m) => ({ id: m.id, qty: 1 }))
  const r2c = await api('POST', `/api/outsourcing/orders/${apprRow.id}/issue`, token, { items: matIds })
  ok(r2c.status === 200, `合法发料成功（HTTP ${r2c.status}）`, r2c.raw.slice(0, 200))
  const after2c = await api('GET', `/api/outsourcing/orders/${apprRow.id}`, token)
  ok(after2c.body.data.status === 'issued', `发料后 approved → issued（${after2c.body.data.status}）`)
  const r2d = await api('POST', `/api/outsourcing/orders/${apprRow.id}/issue`, token, { items: [{ id: matIds[0].id, qty: 1 }] })
  ok(r2d.status === 200, `继续发料（自环边）成功（HTTP ${r2d.status}）`, r2d.raw.slice(0, 200))
  const ev2 = await api('GET', `/api/docflow/history/WW/${apprRow.id}`, token)
  const keys2 = (ev2.body?.data?.events || ev2.body?.data?.list || ev2.body?.data || []).map((e) => `${e.from_state}→${e.to_state}(${e.action})`)
  ok(keys2.includes('approved→issued(issue)'), `发料轨迹含 approved→issued（${keys2.join(' , ')}）`)
  ok(keys2.filter((k) => k === 'issued→issued(issue)').length >= 1, '继续发料在 issued→issued 自环上留了痕')

  console.log('\n--- M7 验收 ---')
  const r3 = await api('POST', `/api/outsourcing/orders/${target.id}/receive`, token, { items: [{ id: prod.id, qty: 10 }] })
  ok(r3.status === 200, `部分收货成功（HTTP ${r3.status}）`, r3.raw.slice(0, 200))
  const mid = await api('GET', `/api/outsourcing/orders/${target.id}`, token)
  ok(mid.body.data.status === 'part_received', `部分收货后状态 = part_received（${mid.body.data.status}）`)
  const closeRes = await api('POST', `/api/outsourcing/orders/${target.id}/status`, token, { action: 'close', remark: 'repro 关闭' })
  ok(closeRes.status === 200, `部分收货后仍能关闭（HTTP ${closeRes.status}）`, closeRes.raw.slice(0, 240))
  ok(closeRes.body?.data?.status === 'closed', `关闭后状态 = closed（${closeRes.body?.data?.status}）`)
  const ev = await api('GET', `/api/docflow/history/WW/${target.id}`, token)
  const events = ev.body?.data?.events || ev.body?.data?.list || ev.body?.data || []
  ok(Array.isArray(events) && events.length >= 2, `doc_events 有轨迹（${Array.isArray(events) ? events.length : 0} 条）`)
  const keys = Array.isArray(events) ? events.map((e) => `${e.from_state}→${e.to_state}(${e.action})`) : []
  ok(keys.includes('issued→part_received(partial)'), '轨迹含「部分收货 issued→part_received」')
  ok(keys.includes('part_received→closed(close)'), '轨迹含「关闭 part_received→closed」')
  console.log('  doc_events: ' + keys.join(' , '))
} catch (e) {
  fail++
  console.log('  ✗ 异常：' + e.message)
} finally {
  await stopAndReport()
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
