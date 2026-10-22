/**
 * ============================================================================
 * 文件标识：scripts/test-org-perm.mjs ｜ 测试：模块 05 验证：多角色登录，检查权限点与组织数据范围是否真的分化
 * ============================================================================
 * 【职责】测试：模块 05 验证：多角色登录，检查权限点与组织数据范围是否真的分化
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 模块 05 验证：多角色登录，检查权限点与组织数据范围是否真的分化
//   node scripts/test-org-perm.mjs
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
// 落点自证：库路径一律从 db/index.js 取（`dbPathFor`），不在这里另写一份 `ROOT/data` ——
// 否则"打印出来的落点"和"真正打开的文件"会分家，脚本就会说谎（比不打印更坏）。
import { DATA_DIR, dbPathFor, INDUSTRIES } from '../server/db/index.js'
// 子进程回收的**唯一实现**（`test-guards.mjs:166-205` 的同一形状，抽出来避免各写一版）
import { stopAndReport, installReapFallback } from './lib/reap.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = 3198
const BASE = `http://127.0.0.1:${PORT}`

// ---------- 0. 落点自证：本次运行会读写哪些库 ----------
// 本脚本一次要**改三个库**（下面统一 admin 密码）并 spawn 服务端 ⇒
// "这一跑动了哪儿"必须由脚本自己说，且父进程与子进程必须落在同一个目录。
const DB_PATHS = Object.keys(INDUSTRIES).map((c) => dbPathFor(c))
// 判据（两条，缺一不可）：
//   ① 没设 `GML_DATA_DIR` ⇒ 按定义就是开发库（`DATA_DIR = GML_DATA_DIR || <项目>/data`，
//      见 `server/db/index.js:10`）——这是**主**判据；
//   ② 设了、但指到项目 `data/` 本身。
// ① 必须有：字符串比较在 macOS 上会被 `/tmp → /private/tmp` 这类符号链接骗到
// （实测：副本里本该告警却**没**告警，把判据反过来才告警 —— 拿它当唯一判据是错的）。
const isDevDataDir = (dir) =>
  !process.env.GML_DATA_DIR || path.resolve(String(dir)) === path.resolve(path.join(ROOT, 'data'))
console.log(`[落点] 数据目录：${path.resolve(DATA_DIR)}`)
for (const c of Object.keys(INDUSTRIES)) {
  console.log(`[落点] ${String(c).padEnd(8)} ${dbPathFor(c)}`)
}
if (isDevDataDir(DATA_DIR)) {
  console.log('⚠️ 本次将读写开发库 data/ —— 若要隔离请设 GML_DATA_DIR=/tmp/...')
}

// ---------- 1. 前置：主管理员密码统一为 12345 ----------
let pwdFixed = 0
for (const p of DB_PATHS) {
  if (!fs.existsSync(p)) continue
  const db = new Database(p)
  const info = db
    .prepare('UPDATE users SET password_hash=? WHERE username=?')
    .run(bcrypt.hashSync('12345', 10), 'admin')
  pwdFixed += info.changes
  db.close()
}
console.log(`主管理员密码已设为 12345（影响 ${pwdFixed} 条记录）`)

// ---------- 2. 起服务 ----------
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  // `GML_DATA_DIR` 显式给出：父子同源、不靠 `{...process.env}` 继承 ——
  // 否则"父进程读 /tmp 副本、子进程去 boot 开发库"这种**半隔离**会静悄悄发生，
  // 而它一次会把三个行业库全 boot 一遍。
  env: { ...process.env, PORT: String(PORT), GML_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
srv.stdout.on('data', (d) => (log += d.toString()))
srv.stderr.on('data', (d) => (log += d.toString()))
const start = Date.now()
const ready = await new Promise((res) => {
  const t = setInterval(() => {
    if (log.includes('服务已启动')) { clearInterval(t); res(true) }
    else if (Date.now() - start > 180000) { clearInterval(t); res(false) }
  }, 300)
})
if (!ready) {
  console.log('❌ 服务启动失败：\n' + log.split('\n').slice(-25).join('\n'))
  srv.kill('SIGKILL')
  process.exit(1)
}
console.log('✅ 服务已启动\n')

const post = (p, body) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const get = (p, tk) => fetch(`${BASE}${p}`, { headers: tk ? { Authorization: `Bearer ${tk}` } : {} })

// ---------- 3. 多角色对比 ----------
const accounts = [
  ['admin', '12345', '系统管理员'],
  ['purchase', '123456', '采购员'],
  ['warehouse', '123456', '仓管员'],
  ['sales', '123456', '销售员'],
  ['finance', '123456', '财务'],
  ['store01', '123456', '店长'],
  ['dealer01', '123456', '经销商'],
  ['viewer', '123456', '访客']
]

console.log(['账号'.padEnd(10), '角色名'.padEnd(12), '权限数'.padEnd(8), '可见组织'.padEnd(10), '数据范围'.padEnd(10), '所属组织'].join(''))
console.log('─'.repeat(88))

const summaries = []
for (const [u, p, label] of accounts) {
  const lr = await post('/api/auth/login', { username: u, password: p, industry: 'cosmetic' })
  const lj = await lr.json().catch(() => ({}))
  if (!lj.data?.token) {
    console.log(`  ${u.padEnd(10)} 登录失败：${lj.message || lr.status}`)
    continue
  }
  const tk = lj.data.token
  const me = await (await get('/api/auth/me', tk)).json()
  const mp = await (await get('/api/auth/my-permissions', tk)).json()
  const ot = await (await get('/api/auth/org-tree', tk)).json()

  const d = me.data || {}
  const permCount = (mp.data?.permissions || []).length
  const scope = mp.data?.orgScope?.scope
  const orgName = d.org?.name || '-'
  summaries.push({ u, label, permCount, scope, orgName, orgType: d.org?.type, treeTotal: ot.data?.total, perms: mp.data?.permissions || [] })

  console.log(
    `${u.padEnd(10)} ${(d.roleName || label).padEnd(12)} ${String(permCount).padEnd(8)} ${String(ot.data?.total ?? '-').padEnd(8)} ${String(scope).padEnd(10)} ${orgName}`
  )
}

// ---------- 4. 关键断言 ----------
console.log('\n--- 断言 ---')
let pass = 0, fail = 0
const chk = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}  ${detail || ''}`) }
}

const byU = Object.fromEntries(summaries.map((s) => [s.u, s]))
chk('admin 拥有全部权限点', byU.admin?.permCount >= 60, `实际 ${byU.admin?.permCount}`)
chk('admin 数据范围为 all', byU.admin?.scope === 'all')
chk('店长数据范围限定本店（org）', byU.store01?.scope === 'org', `实际 ${byU.store01?.scope}`)
chk('店长可见组织数远小于 admin', (byU.store01?.treeTotal || 99) < (byU.admin?.treeTotal || 0), `店长 ${byU.store01?.treeTotal} / admin ${byU.admin?.treeTotal}`)
chk('经销商数据范围为 dealer', byU.dealer01?.scope === 'dealer', `实际 ${byU.dealer01?.scope}`)
chk('经销商权限不含采购下单', !(byU.dealer01?.perms || []).includes('purchase.order.edit'))
chk('经销商有订货下单权', (byU.dealer01?.perms || []).includes('order.place'))
chk('仓管无审批权（职责分离）', !(byU.warehouse?.perms || []).includes('purchase.order.approve'))
chk('仓管有库存调整权', (byU.warehouse?.perms || []).includes('inventory.adjust'))
chk('访客为只读（无任何写权限）', !(byU.viewer?.perms || []).some((x) => x.endsWith('.edit') || x.endsWith('.approve')), JSON.stringify((byU.viewer?.perms || []).slice(0, 5)))
chk('访客看不到成本', !(byU.viewer?.perms || []).includes('inventory.cost.view'))
chk('财务能看成本', (byU.finance?.perms || []).includes('inventory.cost.view'))
chk('各角色权限集合互不相同', new Set(summaries.map((s) => s.permCount)).size >= 5, summaries.map((s) => `${s.u}=${s.permCount}`).join(' '))

console.log(`\n通过 ${pass} / 失败 ${fail}`)
// 子进程必须回收并**说出来**：留下的一只 `node server/index.js` 会一直监听端口、
// 继续持有库文件（本项目已踩到过）。判据与形状见 `scripts/lib/reap.mjs`（唯一出处）。
installReapFallback(srv)
await stopAndReport(srv, { port: PORT })
process.exit(fail ? 1 : 0)
