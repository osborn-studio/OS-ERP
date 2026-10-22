#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/accept/smoke-report-deepening.mjs ｜ 独立验收：真实 HTTP 冒烟 —— 「报表纵深之四」整批站在外面打一遍（批次 U 之四 / ③-a ③-b ③-c ④ + 现金流量项目打标记）
 * ============================================================================
 * 【职责】独立验收：真实 HTTP 冒烟 —— 「报表纵深之四」整批站在外面打一遍（批次 U 之四 / ③-a ③-b ③-c ④ + 现金流量项目打标记）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 真实 HTTP 冒烟 —— 「报表纵深之四」整批站在外面打一遍（批次 U 之四 / ③-a ③-b ③-c ④ + 现金流量项目打标记）
 *
 * 与证据文件的配对关系：
 *   产物 `docs/evidence/批次U之四_真实HTTP冒烟.txt`（37 / 0）
 *   ←→ 本脚本。那次冒烟是**一次临时跑出来的记录**（种子输出 + ✓ 清单），
 *   本脚本把它做成**能再跑一遍的东西**：同样六组；其中 37 条与当时同义同数，
 *   另 **+4 条**是独立复核之后补的（`xlsx 字节流非空` + 落盘后交给 CPython `zipfile` 列条目 +
 *   `xl/workbook.xml` + `[Content_Types].xml`）⇒ 现在收尾是 **41 / 0**。
 *   同样收尾一句「通过 N / 失败 M」。数字允许与当时那次不完全相同（种子数据每条库都不同），
 *   但**结论必须同向**：200 就是 200、409 就是 409、留痕真的落库。
 *
 * 为什么另起一套而不是复用 `scripts/test-*.mjs`：
 *   那些套件对着**开发库**、调的是**内部函数**。而"这一批在真实部署里能不能用"
 *   是另一个问题 —— 它要回答的是：**带真实令牌、打真实端口、走真实路由**，
 *   六组功能是不是真的通、拒绝与否是不是真的落在该落的 HTTP 状态码与业务码上。
 *   两者的失效方式不一样：内部函数全绿而路由漏挂/权限漏授/中间件顺序错，
 *   内部套件一条都发现不了（本项目已有前例）。
 *
 * 硬约束：**绝不动工作区**。
 *   ① 源码复制一份到 `/tmp` 的隔离副本里跑（复刻 `run-on-copy.mjs` 的复制口径：
 *      只复制源码与配置，排除 `.git` / `node_modules`，node_modules 用只读软链）；
 *   ② 数据目录走 `GML_DATA_DIR`，指向副本下的**全新空目录** —— `data/gml_*.db` 一个字节都不碰；
 *      三库由 `bootAll` 从零灌好（与服务启动时同一条路，不另写一套建库逻辑）；
 *   ③ 端口由 pid 派生（也认 `ACCEPT_PORT`），与常驻服务的 3001 不冲突；
 *   ④ 服务是**子进程**，跑完必杀（**等它真退出**再删 —— 它还在写 WAL 时删必然删一半）；
 *      临时目录跑完即删（`--keep` 可留），并**逐份核对**它确实没了。
 *   收工再逐字节核对源文件 sha256 + `git status --porcelain` 前后比对，两样都自证。
 *
 * ⚠️ 一个易被误读的现象：`/tmp` 里偶尔会看到**半截**的 `gml-depth4-*` 目录。
 *   它们不来自本脚本的清理（收工自证会给出"仍存在 0 份"）——
 *   而是**被中途杀掉的进程**留下的（例如同一命令被沙箱拒绝后在沙箱外重跑一遍，
 *   那一次会连同它的副本一起被 KILL）。看到半截目录先看收工自证那一行再下结论。
 *
 * 用法：
 *   node scripts/accept/smoke-report-deepening.mjs            # 全部 6 组（41 条）
 *   node scripts/accept/smoke-report-deepening.mjs --only=3   # 只跑某一组（编号见下面 group 标题）
 *   node scripts/accept/smoke-report-deepening.mjs --keep     # 保留 /tmp 副本便于复查
 *   ⚠️ 本脚本**没有** `--dry`：它是端到端冒烟、没有注入锚点，传了会被**明确拒绝**（用法 + 退出 2），
 *      而不是静默忽略（见下面的参数闸门；`--jobs` 同理——冒烟只有一条串行路径）。
 *   node scripts/accept/smoke-report-deepening.mjs --keep     # 保留 /tmp 副本与数据目录便于复查
 *
 * 退出码：全绿 0，否则 1。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, cpSync, symlinkSync, copyFileSync, statSync, accessSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ---------------------------------------------------------------------------
// 参数（口径「丁」）：**不认识的参数一律拒绝**，并打出用法 + 非 0 退出。
// 为什么必须显式拒绝：静默接受一个无意义的动作，与本批缺陷 186（`qty:-5` 静默成功）是同一族 ——
// 用户以为自己在"只验锚点、不跑"，实际得到的是"整套跑了一遍"（本脚本第一版就是这样：
// `--dry` 零命中、传了照跑，而且那次还"顺便拿到了 37/0"，看起来完全正常）。
// 本脚本是**端到端冒烟**、没有注入锚点，所以 `--dry` 在这里**没有意义**：明确拒掉，而不是假装做了。
// ---------------------------------------------------------------------------
const USAGE = '用法: node scripts/accept/smoke-report-deepening.mjs [--only=1,2,...] [--keep]\n' +
  '  --only=<n>  只跑指定编号的 HTTP 组（1~6，逗号分隔）\n' +
  '  --keep      保留 /tmp 副本与数据目录便于复查\n' +
  '  （本脚本是端到端冒烟、没有注入锚点 ⇒ 不接受 --dry；要只验一部分请用 --only=）'
const KNOWN_FLAGS = ['--only', '--keep', '--help']
const badArgs = process.argv.slice(2).filter((a) => {
  const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a
  return !KNOWN_FLAGS.includes(name)
})
if (badArgs.length) {
  console.error(`❌ 不认识的参数：${badArgs.join(' ')}`)
  console.error(USAGE)
  process.exit(2)
}
if (process.argv.includes('--help')) { console.log(USAGE); process.exit(0) }

const KEEP = process.argv.includes('--keep')
const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean)) : null
// 空跑与"通过"同形：`--only` 写错一个编号就会命中 0 组，而输出照样是「通过 N / 失败 0」。
if (ONLY && !ONLY.size) {
  console.error(`❌ --only 后面没给编号\n${USAGE}`)
  process.exit(2)
}

// 端口按 pid 打散：别的验收脚本可能同时在跑（a14-a18 用 42600+/44200+ 那两段），
// 撞端口报出来的错与真实原因毫无关系。
const PORT = Number(process.env.ACCEPT_PORT || (44700 + (process.pid % 40) * 5))
const BASE = `http://127.0.0.1:${PORT}`
const INDUSTRY = 'cosmetic'

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// ---------------------------------------------------------------------------
// 第三方读取器（CPython zipfile）：与 `test-export-excel.mjs` 同一套候选解析口径，不写死绝对路径。
// 找不到**不跳过** —— 那三条"交给外部实现读"的断言会记成失败并写出原因。
// ---------------------------------------------------------------------------
const PY_CANDIDATES = [
  process.env.GML_PYTHON,
  '/Users/linxinlan/.workbuddy/binaries/python/envs/default/bin/python',
  '/usr/bin/python3',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  'python3',
  'python'
].filter(Boolean)
function resolvePython() {
  for (const c of PY_CANDIDATES) {
    if (c.includes('/')) { if (existsSync(c)) return c; continue }
    const r = spawnSync(c, ['-V'], { encoding: 'utf8' })
    if (!r.error && r.status === 0) return c
  }
  return null // 兜一个不存在的路径只会让 spawnSync(undefined) 崩掉整套
}

// ── `GML_PYTHON` **优先**，但"优先"必须是真的优先 ─────────────────────────────
// 独立复核实测：显式指定的解释器不可用时**静默回退**到候选表里那个可用的 ——
// "用户以为在验 A、实际在验 B，而没有一处说'我换了'"（A20 那一族）。
// ⇒ 显式指定却不可用：**不回退**，返回 null，由 `listZipEntries` 把原因写进失败明细。
function pythonUsable(p) {
  if (String(p).includes('/')) {
    try { return statSync(p).isFile() && (accessSync(p, constants.X_OK), true) } catch { return false }
  }
  const r = spawnSync(p, ['-V'], { encoding: 'utf8' })
  return !r.error && r.status === 0
}
const PY_ENV = process.env.GML_PYTHON && String(process.env.GML_PYTHON).trim() ? String(process.env.GML_PYTHON).trim() : null
const PY_ENV_BAD = PY_ENV && !pythonUsable(PY_ENV) ? PY_ENV : null
const PY = PY_ENV_BAD ? null : (PY_ENV || resolvePython())
const PY_WHY = PY_ENV_BAD
  ? `你指定的 GML_PYTHON=${PY_ENV_BAD} 不可用（不存在 / 不是可执行文件）—— **不静默回退到别的解释器**：请把路径改对，或 unset GML_PYTHON 让候选表生效`
  : `找不到可用的 Python 解释器（候选都不存在：${PY_CANDIDATES.join(' / ')}）`

/**
 * 用 CPython 的 `zipfile` 列出条目名。
 * 返回 `string[]`（成功）或 `{ error }`（失败，**带原因**）—— 调用方据此记失败，
 * 绝不把"读不出来"变成"跳过"：本脚本这几条的价值就在"由外部实现判"。
 */
function listZipEntries(file) {
  if (!PY) return { error: PY_WHY }
  const pyPath = path.join(TMP, 'ziplist.py')
  writeFileSync(pyPath, "import sys, json, zipfile\nprint(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))\n")
  const r = spawnSync(PY, [pyPath, file], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
  if (r.error) return { error: `python 起不来（${PY}）：${r.error.message}` }
  if (r.status !== 0) return { error: `python zipfile 读不出来（status=${r.status}）：${String(r.stderr || '').slice(0, 200)}` }
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch (e) { return { error: `python 输出不是 JSON：${String(r.stdout).slice(0, 200)}` } }
}

// ---------------------------------------------------------------------------
// 断言收集（与项目里其他套件同一形状；收尾必打「通过 N / 失败 M」）
// ---------------------------------------------------------------------------
let pass = 0
let fail = 0
const failed = []
const ok = (name, cond, detail) => {
  // 自保（铁律 27 第二次撞车后立的规矩）：参数写反时**当场崩**，而不是「永远绿」。
  // ⚠️ 本文件的形参顺序是 (name, cond, detail) —— 与 (cond, msg, detail) 那一族**相反**；
  //    守卫因此写在**第二个**形参上（本批有两套顺序并存，这就是那条坑）。
  if (typeof cond !== 'boolean') throw new Error(`ok() 的条件必须是布尔值，收到 ${typeof cond}（参数顺序写反了？）`)
  if (cond) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  else { fail += 1; failed.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail === undefined ? '' : '  → ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 260)}`) }
}
const eq = (name, actual, expect) => ok(name, JSON.stringify(actual) === JSON.stringify(expect), `期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)

// ---------------------------------------------------------------------------
// 隔离副本
// ---------------------------------------------------------------------------
const COPY_DIRS = ['server', 'scripts', 'src', 'public']
const COPY_FILES = ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'vite.config.js', 'tsconfig.json', 'tailwind.config.js', 'postcss.config.js', 'enter.html']

const TMP = mkdtempSync(path.join(tmpdir(), 'gml-depth4-'))
const REPO = path.join(TMP, 'repo')
const DATA = path.join(TMP, 'data')
mkdirSync(REPO, { recursive: true })
for (const d of COPY_DIRS) if (existsSync(path.join(ROOT, d))) cpSync(path.join(ROOT, d), path.join(REPO, d), { recursive: true })
for (const f of COPY_FILES) if (existsSync(path.join(ROOT, f))) copyFileSync(path.join(ROOT, f), path.join(REPO, f))
// ⚠️ `data/` **刻意不复制**：三库必须是全新的（本组要验的正是"从零建起来的库"，
//    而且"不复制"这件事本身就是隔离性的结构性证据）。
mkdirSync(DATA, { recursive: true })
symlinkSync(path.join(ROOT, 'node_modules'), path.join(REPO, 'node_modules'), 'dir')

const gitBefore = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout || ''
const sources = ['server/index.js', 'server/lib/report.js', 'server/routes/report.js', 'server/lib/annual.js', 'server/lib/settings.js']
const beforeHash = new Map()
for (const f of sources) { const p = path.join(ROOT, f); if (existsSync(p)) beforeHash.set(f, sha256(p)) }

// ---------------------------------------------------------------------------
// 「改了几条库」的量法（口径「丙」）：**两栏口径不同，都要显式报数字**。
//   工作区：只读 COUNT(*) 一次（`readonly: true` 打开，不写一个字节）——
//           不写这条的话，读者只能从 sha256 里**间接**推出"没碰"，而"没量"与"不碰"分不清。
//   副本内：本脚本的数据目录是**全新空目录**、由 `bootAll` 从零灌，服务与打标记都写它 ——
//           所以这一栏会是**非 0**，如实报出来（那是副本，不是工作区）。
// ---------------------------------------------------------------------------
const Database = (await import(path.join(ROOT, 'node_modules/better-sqlite3/lib/index.js'))).default
/** 一个库里所有表的行数之和（读不出来返回 null —— 调用方如实报 null，不假装 0） */
function dbRows(file) {
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true })
    let n = 0
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      try { n += Number(db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c) } catch { /* 虚表/视图跳过 */ }
    }
    db.close()
    return n
  } catch { return null }
}
const sumRows = (dir) => ['cosmetic', 'food', 'apparel']
  .map((i) => dbRows(path.join(dir, `gml_${i}.db`)))
  .filter((x) => x !== null)
  .reduce((s, x) => s + x, 0)
const wsRowsBefore = sumRows(path.join(ROOT, 'data'))

console.log(`真实 HTTP 冒烟：报表纵深之四（批次 U 之四）\n  源 ${ROOT}\n  证据配对 docs/evidence/批次U之四_真实HTTP冒烟.txt\n  隔离副本 ${REPO}\n  临时数据目录 ${DATA}\n  端口 ${PORT}`)

let child = null
// 删临时副本要**重试**：`rmSync(recursive)` 在深目录上偶发 `ENOTEMPTY`（遍历与删除之间的竞态），
// 而这里还叠了一层 —— 服务是子进程，SIGKILL 之后它可能**还在写 WAL**，
// 这时删目录必然删一半。所以：① 起进程前先等它真退出；② 删除本身重试。
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 不支持就退化成不睡 */ } }
function rmrf(p) {
  for (let i = 0; i < 6; i += 1) {
    try { rmSync(p, { recursive: true, force: true }); return !existsSync(p) } catch { sleepSync(200) }
  }
  return !existsSync(p)
}
const cleanup = () => {
  try { if (child && !child.killed) child.kill('SIGKILL') } catch { /* 已经退出了 */ }
  if (!KEEP) {
    const gone = rmrf(TMP)
    if (!gone) console.log(`  ⚠️ 临时目录没删干净：${TMP}（下次跑之前可手工删）`)
  }
}
process.on('exit', cleanup)
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(3) })
process.on('SIGINT', () => { cleanup(); process.exit(3) })

// ---------------------------------------------------------------------------
// ① 全新三库（与起服务同一条建库路：`bootAll`，不另写一套）
// ---------------------------------------------------------------------------
process.env.GML_DATA_DIR = DATA
const t0 = Date.now()
const { bootAll } = await import(path.join(REPO, 'server/db/boot.js'))
bootAll({ force: true, log: (m) => console.log(`  [seed] ${m}`) })
console.log(`全新三库就绪 ${((Date.now() - t0) / 1000).toFixed(1)}s ｜ 临时目录 ${TMP}`)
const copyRowsSeeded = sumRows(DATA) // 「副本内」这一栏的起点（全新灌出来的量）

// ---------------------------------------------------------------------------
// ② 起服务（子进程，跑完必杀）
// ---------------------------------------------------------------------------
child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
  cwd: REPO,
  env: { ...process.env, GML_DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
child.stdout.on('data', (d) => { log += d })
child.stderr.on('data', (d) => { log += d })
let up = false
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { const r = await fetch(`${BASE}/api/meta/health`); if (r.ok) { up = true; break } } catch { /* 还没起来 */ }
}
if (!up) {
  console.error('服务未起来，日志尾部：\n' + log.split('\n').slice(-30).join('\n'))
  cleanup()
  process.exit(2)
}

// ---------------------------------------------------------------------------
// HTTP 助手
// ---------------------------------------------------------------------------
async function api(method, p, { token, body, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', 'x-industry': INDUSTRY, ...headers }
  if (token) h.authorization = `Bearer ${token}`
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  let b = null
  try { b = await r.json() } catch { /* 文件类响应不是 JSON */ }
  return { status: r.status, body: b, beCode: b?.detail?.code || b?.error || null, msg: b?.message || b?.error || null, data: b?.data }
}
/** 文件类响应（导出）需要原样拿字节与响应头 —— 走 JSON 解析会把文件读坏 */
async function raw(method, p, { token } = {}) {
  const h = { 'x-industry': INDUSTRY }
  if (token) h.authorization = `Bearer ${token}`
  const r = await fetch(BASE + p, { method, headers: h })
  const buf = Buffer.from(await r.arrayBuffer())
  return { status: r.status, headers: r.headers, buf, text: buf.toString('utf8') }
}

// 只读连副本的数据目录：**只用来选样本与核对期望**，不写任何一张表。
// （`Database` 在文件前部已经 import 过 —— 口径「丙」的计数要用它。）
const db = new Database(path.join(DATA, `gml_${INDUSTRY}.db`), { readonly: true })
const q1 = (sql, ...a) => db.prepare(sql).get(...a)
const qa = (sql, ...a) => db.prepare(sql).all(...a)

const login = await api('POST', '/api/auth/login', { body: { username: 'admin', password: '12345', industry: INDUSTRY } })
const token = login.data?.token || null
ok('管理员登录拿到令牌', !!token, login.body)

// 样本期：**取最新一个真的有已过账凭证的期间**（写死一个期间等于把冒烟挂在种子细节上）
const P = q1("SELECT period FROM vouchers WHERE status='posted' GROUP BY period ORDER BY period DESC LIMIT 1")?.period
if (!P) { console.error('演示库里没有任何已过账凭证 —— 这份种子不对，冒烟无从下手'); cleanup(); process.exit(2) }
// 现金类科目由报表定义给出（与 `cashSubjectsOf` 同一份配置，不在这里手写一套）
const CASH = String(q1("SELECT cash_subjects FROM report_defs WHERE report_code='cf'")?.cash_subjects || '1001,1002').split(',').map((s) => s.trim()).filter(Boolean)
console.log(`样本期 ${P} ｜ 现金类科目 ${CASH.join(',')} ｜ 已过账凭证 ${q1("SELECT COUNT(*) c FROM vouchers WHERE period=? AND status='posted'", P).c} 张`)

const want = (ids) => !ONLY || ids.some((i) => ONLY.has(i))
const GROUP_IDS = ['1', '2', '3', '4', '5', '6']
// `--only` 里写了不存在的编号 ⇒ 那一组一条断言都不会跑，而输出仍然"全绿"（空跑与通过同形）。
if (ONLY) {
  const unknown = [...ONLY].filter((x) => !GROUP_IDS.includes(x))
  if (unknown.length) {
    console.error(`❌ --only 里有不存在的组编号：${unknown.join(',')}（本脚本的组：${GROUP_IDS.join(',')}）`)
    console.error(USAGE)
    process.exit(2)
  }
}
// 第 1 组从接口拿到的项目号，留给第 6 组用 —— 不在脚本里手写一个项目号（那会与种子漂开）
let dictCode = null

// ===========================================================================
section('HTTP 1：字典与路由存在（含未带令牌时必须是 401）')
// ===========================================================================
if (want(['1'])) {
  const meta = await api('GET', '/api/reports/meta', { token })
  ok('meta 带会计年度信息', meta.status === 200 && meta.data?.fiscal && Number.isInteger(meta.data.fiscal.start_month), meta.data?.fiscal)
  const yoy = (meta.data?.compare_modes || []).find((m) => m.value === 'yoy_ytd')
  ok('compare_modes 里有 yoy_ytd 且标了 compare_basis=ytd', !!yoy && yoy.compare_basis === 'ytd', yoy)
  const dict = await api('GET', '/api/reports/cashflow-items', { token })
  ok('现金流量项目字典 200 且非空', dict.status === 200 && Array.isArray(dict.data?.rows) && dict.data.rows.length > 0, `${dict.status} / ${dict.data?.rows?.length} 条`)
  const noTok = await api('GET', '/api/reports/cashflow-items')
  ok('未带令牌 → 401（路由存在但拦住了）', noTok.status === 401, noTok.status)
  const noTok2 = await api('GET', `/api/reports/pl/multi-year?period=${P}`)
  ok('multi-year 未带令牌 → 401', noTok2.status === 401, noTok2.status)
  // 字典的 code 留一份给第 6 组用（**从接口拿**，不在脚本里手写一个项目号 —— 那会与种子漂开）
  dictCode = (dict.data?.rows || []).find((r) => r.status === 'active' && r.report_line_code)?.code || (dict.data?.rows || [])[0]?.code || null
}

// ===========================================================================
section('HTTP 2：③-b 累计同比')
// ===========================================================================
if (want(['2'])) {
  const cmp = await api('GET', `/api/reports/pl/compare?period=${P}&mode=yoy_ytd`, { token })
  ok('200', cmp.status === 200, { status: cmp.status, msg: cmp.msg })
  const cols = (cmp.data?.columns || []).map((c) => c.label)
  // 两列的标题必须**各自带自己的区间**（累计对累计时 `columnsOf` 走 `compareYtd` 那一路：
  // 本期那列叫「本期累计(a~b)」而不是「本期金额(p)」—— 一列累计、标题却写着单期，
  // 读文件的人会按单期去理解它）
  ok('口径与两列标签', cmp.data?.compare_basis === 'ytd' && /~/.test(String(cmp.data?.mode_label || '')) && cols.some((l) => /^本期累计\(\d{4}-\d{2}~\d{4}-\d{2}\)$/.test(l)) && cols.some((l) => /^上年同期累计\(\d{4}-\d{2}~\d{4}-\d{2}\)$/.test(l)), { basis: cmp.data?.compare_basis, label: cmp.data?.mode_label, cols })
  const bs = await api('GET', `/api/reports/bs/compare?period=${P}&mode=yoy_ytd`, { token })
  ok('时点口径 + 累计同比 → 409 + COMPARE_YTD_BASIS_NOT_APPLICABLE', bs.status === 409 && bs.beCode === 'COMPARE_YTD_BASIS_NOT_APPLICABLE', { status: bs.status, code: bs.beCode })
  const prev = await api('GET', `/api/reports/pl/compare?period=${P}&mode=previous&range=ytd`, { token })
  ok('环比 + 累计仍然 400（既有行为不变）', prev.status === 400 && prev.beCode === 'RANGE_COMPARE_UNSUPPORTED', { status: prev.status, code: prev.beCode })
  const ca = await api('GET', `/api/reports/pl/compare/audit?period=${P}&mode=yoy_ytd`, { token })
  ok('比较自证 ok', ca.status === 200 && ca.data?.ok === true, { status: ca.status, problems: ca.data?.problems })
}

// ===========================================================================
section('HTTP 3：③-c 会计年度起点（改配置 → 窗口跟着走 → 年结被拒 → 改回）')
// ===========================================================================
if (want(['3'])) {
  const setStart = (value, reason) => api('PUT', '/api/meta/settings', { token, body: reason === undefined ? { key: 'fiscal.start_month', value } : { key: 'fiscal.start_month', value, reason } })
  const w = await setStart('4', '冒烟：验会计年度起点可配置（跑完会改回 1）')
  ok('写入起始月（危险项，带理由）→ 200 且 changed', w.status === 200 && w.data?.changed === true, { status: w.status, data: w.data, msg: w.msg })
  const rr = await api('GET', `/api/reports/pl?period=${P}&range=ytd`, { token })
  // 期望**字面**算出：起始月 4 ⇒ 年初 = 本期所在的自然年 + 04
  eq('累计窗口起点跟着配置变成 4 月起（2026-04）', rr.data?.range_meta?.from, `${P.slice(0, 4)}-04`)
  const ann = await api('POST', `/api/reports/annual/${P.slice(0, 4)}/carry-forward`, { token, body: { remark: '冒烟：这一笔必须被拒' } })
  ok('非自然年度做年结 → 409 + 一句人话', ann.status === 409 && ann.beCode === 'FISCAL_YEAR_UNSUPPORTED' && /未实现/.test(String(ann.msg || '')), { status: ann.status, code: ann.beCode, msg: ann.msg })
  const back = await setStart('1', '冒烟：还原成自然年')
  ok('改回 1', back.status === 200 && back.data?.changed === true, { status: back.status, data: back.data })
  const noReason = await setStart('4')
  ok('危险配置不写理由 → 400（差分驱动的理由要求没被绕过）', noReason.status === 400 && noReason.beCode === 'SETTING_REASON_REQUIRED', { status: noReason.status, code: noReason.beCode })
}

// ===========================================================================
section('HTTP 4：④ 同期多年对比')
// ===========================================================================
if (want(['4'])) {
  // 期望期间**字面**算出：第 k 列 = 本期往前 12k 个月（自己算年月，不调被测函数）
  const lag = (period, k) => {
    const [y, m] = period.split('-').map(Number)
    const total = y * 12 + (m - 1) - 12 * k
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
  }
  const my = await api('GET', `/api/reports/pl/multi-year?period=${P}&years=3`, { token })
  eq('200 且三列期间正确', [my.status, my.data?.periods], [200, [P, lag(P, 1), lag(P, 2)]])
  eq('列数与标题', [my.data?.columns?.length, my.data?.columns?.slice(2).map((c) => c.label)], [5, [`本期金额(${P})`, `金额(${lag(P, 1)})`, `金额(${lag(P, 2)})`]])
  const bad = await api('GET', `/api/reports/pl/multi-year?period=${P}&years=6`, { token })
  ok('years 越界 → 400 + MULTI_YEAR_COUNT', bad.status === 400 && bad.beCode === 'MULTI_YEAR_COUNT', { status: bad.status, code: bad.beCode })
  const ma = await api('GET', `/api/reports/pl/multi-year/audit?period=${P}&years=3`, { token })
  ok('多年对比自证 ok', ma.status === 200 && ma.data?.ok === true, { status: ma.status, problems: ma.data?.problems })
}

// ===========================================================================
section('HTTP 5：③-a 导出 Excel / CSV（默认不变）')
// ===========================================================================
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
if (want(['5'])) {
  const x = await raw('GET', `/api/reports/pl/export?period=${P}&format=xlsx`, { token })
  ok('xlsx 200 + 正确的 Content-Type', x.status === 200 && x.headers.get('content-type') === XLSX_MIME, { status: x.status, ct: x.headers.get('content-type') })
  ok('xlsx 是 ZIP 魔数', x.buf.subarray(0, 2).toString('latin1') === 'PK', x.buf.subarray(0, 4).toString('hex'))
  ok('文件名后缀 .xlsx', /filename="[^"]+\.xlsx"/.test(String(x.headers.get('content-disposition') || '')), x.headers.get('content-disposition'))
  ok('X-Report-Format 头', x.headers.get('x-report-format') === 'xlsx', x.headers.get('x-report-format'))
  const c = await raw('GET', `/api/reports/pl/export?period=${P}`, { token })
  ok('不传 format 时仍是 CSV（既有调用一个字节都不变）', c.status === 200 && /^text\/csv/.test(String(c.headers.get('content-type') || '')) && c.headers.get('x-report-format') === 'csv' && c.text.startsWith('\ufeff'), { status: c.status, ct: c.headers.get('content-type'), fmt: c.headers.get('x-report-format') })
  const badF = await api('GET', `/api/reports/pl/export?period=${P}&format=pdf`, { token })
  ok('未知格式 → 400 + BAD_EXPORT_FORMAT', badF.status === 400 && badF.beCode === 'BAD_EXPORT_FORMAT', { status: badF.status, code: badF.beCode })
  const multi = await raw('GET', `/api/reports/pl/export?period=${P}&years=3&format=xlsx`, { token })
  ok('同期多年也能导 xlsx（文件名带 _multi3）', multi.status === 200 && /filename="[^"]*_multi3\.xlsx"/.test(String(multi.headers.get('content-disposition') || '')) && multi.buf.subarray(0, 2).toString('latin1') === 'PK', { status: multi.status, cd: multi.headers.get('content-disposition') })
  const both = await api('GET', `/api/reports/pl/export?period=${P}&years=3&mode=previous`, { token })
  ok('years 与 mode 同时给 → 400 + BAD_EXPORT_OPTIONS', both.status === 400 && both.beCode === 'BAD_EXPORT_OPTIONS', { status: both.status, code: both.beCode })

  // ---- 字节流 → 落盘 → 交给**第三方实现**（CPython 的 zipfile）列条目名 ----
  // 为什么非要外部实现：`PK\x03\x04` 只能证明"头两个字节像 ZIP"。
  // 自写一个读取器验自写的写入器是同源验证（CRC/中央目录解释错了会一起错、一起绿）。
  // zipfile 是别人的判据：它能列出条目名，就说明**中央目录与 local header 都对得上**。
  ok('xlsx 字节流非空（> 0 字节）', x.buf.length > 0, `${x.buf.length} 字节`)
  const XLSX_TMP = path.join(TMP, `probe-${Date.now().toString(36)}.xlsx`)
  writeFileSync(XLSX_TMP, x.buf)
  const zipList = listZipEntries(XLSX_TMP)
  ok('落盘后交给 CPython zipfile 能列出条目（外部实现读得开）', Array.isArray(zipList), zipList && zipList.error ? zipList.error : '不是 zip')
  const names = Array.isArray(zipList) ? zipList : []
  ok('条目里有 xl/workbook.xml（工作表定义在里面）', names.includes('xl/workbook.xml'), names.join(' | ').slice(0, 300))
  ok('条目里有 [Content_Types].xml（缺它 Excel 打不开）', names.includes('[Content_Types].xml'), names.join(' | ').slice(0, 300))
  try { rmSync(XLSX_TMP, { force: true }) } catch { /* 删不掉不影响结论 */ }
}

// ===========================================================================
section('HTTP 6：打标记（现金流量项目）端到端 + 留痕')
// ===========================================================================
if (want(['6'])) {
  // 样本：本期一张"既有现金分录又有非现金分录"的已过账凭证（这正是标记有意义的最小形态）
  const v = q1(`
    SELECT v.id, v.doc_no FROM vouchers v
     WHERE v.status='posted' AND v.period=?
       AND EXISTS (SELECT 1 FROM voucher_entries e WHERE e.voucher_id=v.id AND e.subject_code IN (${CASH.map(() => '?').join(',')}))
       AND EXISTS (SELECT 1 FROM voucher_entries e WHERE e.voucher_id=v.id AND e.subject_code NOT IN (${CASH.map(() => '?').join(',')}))
     ORDER BY v.id LIMIT 1`, P, ...CASH, ...CASH)
  ok('演示库里找到一张"既有现金分录又有非现金分录"的已过账凭证', !!v, v)
  if (v) {
    const entry = q1(`SELECT seq, subject_code FROM voucher_entries WHERE voucher_id=? AND subject_code NOT IN (${CASH.map(() => '?').join(',')}) ORDER BY seq LIMIT 1`, v.id, ...CASH)
    const cashEntry = q1(`SELECT seq, subject_code FROM voucher_entries WHERE voucher_id=? AND subject_code IN (${CASH.map(() => '?').join(',')}) ORDER BY seq LIMIT 1`, v.id, ...CASH)
    const code = dictCode || q1("SELECT code FROM cash_flow_items WHERE status='active' AND report_line_code IS NOT NULL ORDER BY code LIMIT 1")?.code
    const maxIdBefore = q1('SELECT COALESCE(MAX(id),0) m FROM audit_logs').m

    const tag = await api('POST', `/api/reports/vouchers/${v.id}/tag-cashflow`, { token, body: { entries: [{ line_no: entry.seq, cash_flow_item: code }] } })
    ok('打标记 → 200 且回报改动', tag.status === 200 && Array.isArray(tag.data?.changed) && tag.data.changed.length === 1 && tag.data.changed[0].from === null && tag.data.changed[0].to === code, { status: tag.status, data: tag.data, msg: tag.msg })

    const cf = await api('GET', `/api/reports/cf?period=${P}`, { token })
    eq('现金流量表如实报出标记条数（1 条）', cf.data?.cash?.tagged_count, 1)

    const aud = await api('GET', `/api/reports/audit?period=${P}`, { token })
    ok('打标记后报表自证仍然通过', aud.status === 200 && aud.data?.ok === true, aud.data?.problems)

    const noReason = await api('POST', `/api/reports/vouchers/${v.id}/tag-cashflow`, { token, body: { entries: [{ line_no: entry.seq, cash_flow_item: null }] } })
    ok('清除已标过的标记但不写理由 → 409', noReason.status === 409 && noReason.beCode === 'CF_TAG_REASON_REQUIRED', { status: noReason.status, code: noReason.beCode })

    const withReason = await api('POST', `/api/reports/vouchers/${v.id}/tag-cashflow`, { token, body: { entries: [{ line_no: entry.seq, cash_flow_item: null }], reason: '冒烟：还原这一笔的标记' } })
    ok('写了理由就清得掉', withReason.status === 200 && withReason.data?.changed?.[0]?.to === null, { status: withReason.status, data: withReason.data, msg: withReason.msg })

    const onCash = await api('POST', `/api/reports/vouchers/${v.id}/tag-cashflow`, { token, body: { entries: [{ line_no: cashEntry.seq, cash_flow_item: code }] } })
    ok('给现金科目的分录取标 → 400', onCash.status === 400 && onCash.beCode === 'CF_ITEM_ON_CASH_ENTRY', { status: onCash.status, code: onCash.beCode })

    const rows = qa("SELECT id, entity, entity_id, detail FROM audit_logs WHERE action='finance.cashflow.tag' AND id>? ORDER BY id", maxIdBefore)
    eq('打标记留了痕（audit_logs 里 2 条）', rows.length, 2)
    const newest = rows[rows.length - 1]
    ok('留痕里带着"是哪张凭证"（entity/entity_id —— 只记 action 的日志查不出改的是哪一笔）', newest?.entity === 'voucher' && String(newest?.entity_id) === String(v.id) && !!newest?.detail, newest)
  }
}

// ---------------------------------------------------------------------------
// 收工：杀服务（**等它真的退出**再删目录 —— 它还在写 WAL 时删必然删一半）
// ---------------------------------------------------------------------------
const exited = new Promise((r) => { if (!child || child.exitCode !== null || child.signalCode) return r(); child.once('exit', r) })
child.kill('SIGKILL')
await exited
db.close()
// 口径「丙」的副本那一栏**必须在这里数**：再晚一步 `cleanup()` 就把数据目录删掉了，
// 那时数出来的是"库没了"，而不是"改了几条"。
const copyRowsAfter = sumRows(DATA)
// 收工先删临时副本，**再逐份核对它是不是真的没了**（而不是笼统宣称"清理过了"）
cleanup()
const leftOver = !KEEP && existsSync(TMP)
// 「进程已杀 / 临时目录已删」**是结论的一部分**，所以要显式报出来（不是默认它没发生）：
//   · 进程没死 → 下一轮跑起来端口被占，而报出来的错与真实原因毫无关系；
//   · 目录没删 → 一次几 MB，攒几十次就是几百 MB，且没人会想到是冒烟脚本留下的。
const procDead = !child || child.exitCode !== null || !!child.signalCode
console.log(`  ${procDead ? '✓' : '✗'} 服务进程已杀：pid ${child?.pid ?? '—'}，退出码 ${child?.exitCode ?? 'null'}，signal ${child?.signalCode ?? 'null'}`)
console.log(`  ${leftOver ? '✗' : '✓'} 临时目录${KEEP ? '按 --keep 保留' : '已删'}：${TMP}`)

console.log(`\n${'─'.repeat(72)}`)
console.log(`报表纵深之四（真实 HTTP）：通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  failed.forEach((f) => console.log(`  - ${f}`))
}

// ---------------------------------------------------------------------------
// 工作区自证：源文件逐字节未变 + git status 前后一致
// ---------------------------------------------------------------------------
console.log(`\n工作区自证（源码只在 /tmp 副本里跑，数据只在临时目录里）：`)
console.log(`  ${leftOver ? '✗' : '✓'} 本次创建的 1 份临时副本（源码副本 + 全新三库数据），收工时仍存在 ${leftOver ? 1 : 0} 份${leftOver ? `：${TMP}` : ''}`)
if (KEEP) console.log(`  （--keep：本次保留 ${TMP}）`)
// 口径「丙」：两栏口径不同，**都要显式报数字**（"没量"与"不碰"必须分得开）
const wsRowsAfter = sumRows(path.join(ROOT, 'data'))
console.log(`  本次改动数据库：`)
console.log(`    工作区 ${wsRowsAfter - wsRowsBefore} 条（按表 COUNT(*) 实测 ${wsRowsBefore} → ${wsRowsAfter}；只对 data/ 下的三库做 readonly 计数、从不写 —— 受控实验：只读打开前后 sha256 逐字节不变）`)
console.log(`    副本内快照 ${copyRowsAfter - copyRowsSeeded} 条（${copyRowsSeeded} → ${copyRowsAfter}；全新三库由 bootAll 灌出，服务与打标记改的是这一份）`)
for (const f of sources) {
  const p = path.join(ROOT, f)
  const now = existsSync(p) ? sha256(p) : '(缺失)'
  console.log(`  ${now === beforeHash.get(f) ? '✓ 未变' : '✗ 已变'} ${f}`)
}
const gitAfter = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout || ''
const gitSame = gitBefore === gitAfter
console.log(`  ${gitSame ? '✓' : '⚠️'} git status --porcelain 与开跑前一致（开跑前 ${gitBefore.split('\n').filter(Boolean).length} 行 / 收工 ${gitAfter.split('\n').filter(Boolean).length} 行）`)
if (!gitSame) {
  const a = new Set(gitBefore.split('\n').filter(Boolean)); const b = new Set(gitAfter.split('\n').filter(Boolean))
  console.log(`    新增：${[...b].filter((x) => !a.has(x)).join(' | ') || '无'}`)
  console.log(`    消失：${[...a].filter((x) => !b.has(x)).join(' | ') || '无'}`)
  console.log('    （注：工作区可能同时有别人在改文件，差异未必来自本脚本；本脚本对源码只写 /tmp 副本）')
}
if (KEEP) console.log(`\n--keep：副本保留在 ${REPO}（数据目录 ${DATA}）`)

console.log(`\n计数 通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
