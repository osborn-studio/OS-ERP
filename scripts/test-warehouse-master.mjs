#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/test-warehouse-master.mjs ｜ 测试：常驻守卫：**仓库主数据可维护**（客户口径）
 * ============================================================================
 * 【职责】测试：常驻守卫：**仓库主数据可维护**（客户口径）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 常驻守卫：**仓库主数据可维护**（客户口径）
//
// 客户原话：「仓库是可以客户自己新建的……简单来讲，仓库是可以客户自己新建的，
//   出入库单据类型也是客户新建的，以应对多种情况。」
//
// 用法：
//   node scripts/test-warehouse-master.mjs                 # 三个行业都跑
//   node scripts/test-warehouse-master.mjs cosmetic        # 只跑一个行业
//   GML_DATA_DIR=/tmp/xxx node scripts/test-warehouse-master.mjs
//
// 为什么它必须是常驻断言（而不是"这轮人手看过一次"）：
//   本批给仓库加了三条**业务约束**，它们都不是"界面上的礼貌"，而是账实口径：
//     · ① 不许物理删除（历史单据按仓库记录"这批货当时在哪"）；
//     · ② 编码不可改（它是历史单据与外部系统的引用键）；
//     · ③ 类型取值必须枚举（拼错的类型会静默存进去，质量处置按类型找隔离仓就找不到）。
//   以及一条**跨模块**的口径：
//     · ④ 停用仓不能再被新建单据选中 —— 它由「界面下拉」与「建单服务层」两半组成，
//       少一半就漏一个入口（界面选不到、接口还收得下）。
//   ③④ 这类"漏一个入口"的缺口，按接口逐个手写用例是挡不住的：**漏掉的那一个
//   永远不会出现在用例清单里**。所以这里按「入口 × 边界」写。
//
// 断言的 15 件事（三库各跑一遍）见下面 section 标题。
//
// 隔离纪律（本项目最硬的一条）：
//   · 未设 GML_DATA_DIR ⇒ **自落**到 /tmp/gml-wh-master-<脚本名>
//   · 指向仓库 data/ 或任何非 /tmp 路径 ⇒ **当场 exit 2 拒跑**
//   · 三库副本是**纯文件拷贝**（`copyFileSync`，含 `-wal`）—— 用 sqlite 打开仓库 data/ 去导
//     会把开发库的 WAL 合并掉，那是**写**仓库 data/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { stopAndReport } from './lib/reap.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DATA = path.join(ROOT, 'data')
const require = createRequire(import.meta.url)

const INDUSTRIES = ['cosmetic', 'food', 'apparel']
const DB_FILE = { cosmetic: 'gml_cosmetic.db', food: 'gml_food.db', apparel: 'gml_apparel.db' }

// ---------- 参数自证：不认识的输入**拒**，不静默忽略 ----------
// （`node scripts/test-warehouse-master.mjs fot` 若被当成行业名直接吞掉，
//   脚本会照样打"通过 N / 失败 0"、退出码 0 —— 与"真的跑过了"输出同形。）
const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('-'))
const industryArgs = argv.filter((a) => !a.startsWith('-'))
const badArgs = [...flags, ...industryArgs.filter((a) => !INDUSTRIES.includes(a))]
if (badArgs.length) {
  console.error(`✗ 未知参数：${badArgs.join(' ')}`)
  console.error('用法：node scripts/test-warehouse-master.mjs [cosmetic|food|apparel]')
  process.exit(2)
}
const WANT = industryArgs.length ? industryArgs : INDUSTRIES

// ---------- 隔离目录 ----------
function resolveIsolatedDir() {
  const name = path.basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, '')
  const raw = process.env.GML_DATA_DIR || ''
  const abs = raw ? path.resolve(raw) : path.join('/tmp', `gml-wh-master-${name}`)
  if (abs === REPO_DATA || abs.startsWith(REPO_DATA + path.sep)) {
    console.error(`✗ 拒绝运行：隔离目录指向仓库 data/（${abs}）。本脚本只允许在 /tmp 下的副本上跑。`)
    process.exit(2)
  }
  if (!abs.startsWith('/tmp/')) {
    console.error(`✗ 拒绝运行：隔离目录必须在 /tmp 下（实得 ${abs}）。`)
    process.exit(2)
  }
  fs.mkdirSync(abs, { recursive: true })
  console.log(`隔离库目录：${abs}（仓库 data/ 不会被写）`)
  return abs
}
const DIR = resolveIsolatedDir()

// 纯文件拷贝：仓库 data/ 只被"读成字节"，不被 sqlite 打开。
let copied = 0
for (const ind of INDUSTRIES) {
  const src = path.join(REPO_DATA, DB_FILE[ind])
  const dst = path.join(DIR, DB_FILE[ind])
  if (fs.existsSync(dst)) continue
  if (!fs.existsSync(src)) {
    console.error(`✗ 找不到源库 ${src} —— 请先在仓库里把三行业库建出来（npm run seed / reseed）`)
    process.exit(2)
  }
  fs.copyFileSync(src, dst)
  // -wal 必须一起拷：只拷 .db 会丢掉还留在 WAL 里、尚未 checkpoint 的事务
  if (fs.existsSync(src + '-wal')) fs.copyFileSync(src + '-wal', dst + '-wal')
  copied += 1
}
console.log(copied ? `已从仓库 data/ 纯文件拷贝 ${copied} 个行业库（含 -wal）到隔离目录` : '隔离目录里已有三库副本（不重复拷贝）')

const PORT = Number(process.env.PORT) || 44561
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
const failures = []
const ok = (cond, msg, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`) }
  else { fail += 1; failures.push(msg); console.log(`  ✗ ${msg}${detail !== undefined && detail !== '' ? '  → ' + String(detail).slice(0, 300) : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ---------- 起服务（GML_DATA_DIR 由 env 传给子进程） ----------
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), GML_DATA_DIR: DIR },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
srv.stdout.on('data', (d) => (log += d.toString()))
srv.stderr.on('data', (d) => (log += d.toString()))

async function main() {
  const started = Date.now()
  await new Promise((res, rej) => {
    const t = setInterval(() => {
      if (log.includes('服务已启动')) { clearInterval(t); res(true) }
      else if (srv.exitCode !== null) { clearInterval(t); rej(new Error(`服务提前退出：\n${log.slice(-2000)}`)) }
      else if (Date.now() - started > 120000) { clearInterval(t); rej(new Error(`服务启动超时：\n${log.slice(-2000)}`)) }
    }, 100)
  })
  console.log(`服务已启动：${BASE}（pid ${srv.pid}）`)

  // ---------- 直连隔离库：只用于**夹取夹具**与**收尾清理**，不参与任何断言 ----------
  const Database = require('better-sqlite3')
  const directDb = (ind) => new Database(path.join(DIR, DB_FILE[ind]))
  const cleanup = () => {
    for (const ind of INDUSTRIES) {
      const d = directDb(ind)
      // 清理测试仓（真删 —— 这是**测试夹具**的清理，不是产品路径）。
      // 先删引用它的测试采购单：`purchase_orders.warehouse_id` 有外键，
      // 直接删仓会以 FOREIGN KEY constraint failed 收场 —— 而那是**清理**失败，
      // 会让下一轮带着残留夹具开跑（"先红"那轮就真的把仓建出来了）。
      for (const w of d.prepare("SELECT id FROM warehouses WHERE code LIKE 'WHT-T%'").all()) {
        d.prepare('DELETE FROM purchase_order_items WHERE order_id IN (SELECT id FROM purchase_orders WHERE warehouse_id=?)').run(w.id)
        d.prepare('DELETE FROM purchase_orders WHERE warehouse_id=?').run(w.id)
        d.prepare('DELETE FROM warehouses WHERE id=?').run(w.id)
      }
      d.close()
    }
  }
  cleanup()

  const tokens = {}
  for (const ind of WANT) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: '12345', industry: ind })
    })
    const j = await r.json().catch(() => ({}))
    if (j.data?.token) tokens[ind] = j.data.token
    else throw new Error(`登录失败[${ind}] ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
  }

  const api = async (ind, method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens[ind]}`,
        'x-industry': ind
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const j = await r.json().catch(() => ({}))
    return { status: r.status, body: j }
  }

  for (const ind of WANT) {
    const X = (m, p, b) => api(ind, m, p, b)
    const T1 = 'WHT-T1' // 经营仓（要出现在"选仓"下拉里）
    const T2 = 'WHT-T2' // 隔离仓（不许出现在"选仓"下拉里）
    const T3 = 'WHT-T3' // 隔离仓（同上，换一个类型）
    section(`行业 ${ind}`)

    // ---------- ① 新建：客户自己建仓（含质量隔离仓） ----------
    const c1 = await X('POST', '/master/warehouses', { code: T1, name: '演示·前置仓', type: 'forward', manager: '张三', phone: '13800000000' })
    ok(c1.status === 200 && c1.body?.data?.id > 0, '① 新建仓库（type=forward）→ 200', `${c1.status} ${JSON.stringify(c1.body).slice(0, 200)}`)
    const whId = c1.body?.data?.id
    const c2 = await X('POST', '/master/warehouses', { code: T2, name: '演示·待检仓', type: 'quarantine' })
    ok(c2.status === 200 && c2.body?.data?.id > 0, '① 新建仓库（type=quarantine 待检仓）→ 200', `${c2.status} ${JSON.stringify(c2.body).slice(0, 200)}`)
    const c3 = await X('POST', '/master/warehouses', { code: T3, name: '演示·不合格品仓', type: 'defect' })
    ok(c3.status === 200 && c3.body?.data?.id > 0, '① 新建仓库（type=defect 不合格品仓）→ 200', `${c3.status} ${JSON.stringify(c3.body).slice(0, 200)}`)

    // ---------- ② 重复编码 ⇒ 409 + 人话 ----------
    const dup = await X('POST', '/master/warehouses', { code: T1, name: '演示·重名仓', type: 'central' })
    ok(dup.status === 409, `② 重复编码 → 409（不是 200 加一句"已存在"）`, `实得 ${dup.status} ${JSON.stringify(dup.body).slice(0, 200)}`)
    ok(/已被/.test(String(dup.body?.message || '')), '② 409 是人话（说得出被谁占了）', dup.body?.message)
    ok((dup.body?.error || dup.body?.detail?.code) === 'WAREHOUSE_CODE_DUPLICATE', '② 409 带稳定业务码 WAREHOUSE_CODE_DUPLICATE', dup.body?.error || dup.body?.detail?.code)

    // ---------- ③ 类型必须枚举 ----------
    const badType = await X('POST', '/master/warehouses', { code: 'WHT-T9', name: '演示·类型写错', type: 'defectt' })
    ok(badType.status === 400, '③ 类型不在取值域 → 400（拼错的类型不许静默存进去）', `实得 ${badType.status} ${JSON.stringify(badType.body).slice(0, 200)}`)
    ok((badType.body?.error || badType.body?.detail?.code) === 'WAREHOUSE_TYPE_INVALID', '③ 带业务码 WAREHOUSE_TYPE_INVALID', badType.body?.error || badType.body?.detail?.code)
    const backdoor = (() => { const d = directDb(ind); const n = d.prepare('SELECT COUNT(*) c FROM warehouses WHERE code=?').get('WHT-T9').c; d.close(); return n })()
    ok(backdoor === 0, '③ 非法类型的仓**一行都没建出来**', `实得 ${backdoor} 行`)

    // ---------- ④ 必填 ----------
    const noCode = await X('POST', '/master/warehouses', { name: '演示·没编码' })
    ok(noCode.status === 400 && (noCode.body?.error || noCode.body?.detail?.code) === 'WAREHOUSE_CODE_REQUIRED', '④ 缺编码 → 400 WAREHOUSE_CODE_REQUIRED', `${noCode.status} ${noCode.body?.error || noCode.body?.detail?.code}`)
    const noName = await X('POST', '/master/warehouses', { code: 'WHT-T8' })
    ok(noName.status === 400 && (noName.body?.error || noName.body?.detail?.code) === 'WAREHOUSE_NAME_REQUIRED', '④ 缺名称 → 400 WAREHOUSE_NAME_REQUIRED', `${noName.status} ${noName.body?.error || noName.body?.detail?.code}`)

    // ---------- ⑤ 编码不可改（改名称可以） ----------
    const chgCode = await X('PUT', `/master/warehouses/${whId}`, { code: `${T1}X` })
    ok(chgCode.status === 400 && (chgCode.body?.error || chgCode.body?.detail?.code) === 'WAREHOUSE_CODE_IMMUTABLE', '⑤ 改编码 → 400 WAREHOUSE_CODE_IMMUTABLE', `${chgCode.status} ${chgCode.body?.error || chgCode.body?.detail?.code}`)
    const still = await X('GET', `/master/warehouses/${whId}`)
    ok(still.body?.data?.code === T1, '⑤ 库里编码一个字没变（不是"报了错但还是改了"）', still.body?.data?.code)
    const chgName = await X('PUT', `/master/warehouses/${whId}`, { name: '演示·前置仓（改名）', type: 'forward', code: T1 })
    ok(chgName.status === 200, '⑤ 改名 + 原值回传编码 → 200（前端整行回传不该被拒）', `${chgName.status} ${JSON.stringify(chgName.body).slice(0, 160)}`)

    // ---------- ⑥ 不许物理删除 ----------
    // 状态码 409（Conflict）：拒绝的性质是"与既有引用冲突"，不是"请求格式不对"。
    // 与另一条线的 `DELETE /api/master/inv-txn-types/{code}`（409 + `INV_TYPE_NO_DELETE`）
    // **严重程度一致**；业务码各自保留（那说明的是"哪张表不许删"）。
    const del = await X('DELETE', `/master/warehouses/${whId}`)
    ok(del.status === 409 && (del.body?.error || del.body?.detail?.code) === 'WAREHOUSE_NO_DELETE', '⑥ 删除 → 409 WAREHOUSE_NO_DELETE（不许物理删）', `${del.status} ${del.body?.error || del.body?.detail?.code}`)
    ok(/停用/.test(String(del.body?.message || '')), '⑥ 拒删的同时告诉用户该做什么（改为停用）', del.body?.message)
    const alive = await X('GET', `/master/warehouses/${whId}`)
    ok(alive.status === 200 && alive.body?.data?.id === whId, '⑥ 行还在（不是"删了才报错"）', `${alive.status}`)
    // 保留键口径（`bizFail` 往 `detail.code` 写业务码 ⇒ 仓库编码必须换个键名）**不能**在这一路回退
    ok(
      del.body?.detail?.warehouse_code === T1 && del.body?.detail?.code === 'WAREHOUSE_NO_DELETE',
      '⑥ 响应体：业务码在 `detail.code`、仓库编码在 `detail.warehouse_code`，**互不覆盖**',
      JSON.stringify(del.body?.detail)
    )

    // ---------- ⑦ 启用时：出现在新建下拉里；**隔离仓不许出现** ----------
    const optOn = await X('GET', '/master/options')
    const listOn = (optOn.body?.data?.warehouses || []).map((w) => w.code)
    ok(listOn.includes(T1), '⑦ 启用中的**经营仓**出现在 /master/options（新建单据能选到）', listOn.join(','))
    ok(!listOn.includes(T2) && !listOn.includes(T3),
      '⑦ **隔离仓（待检仓 / 不合格品仓）即使启用也不出现在 /master/options** —— 它不能被"选发货仓/选货源仓"选中',
      listOn.join(','))
    const allWh = await X('GET', '/master/warehouses?all=1')
    const allCodes = (allWh.body?.data || []).map((w) => w.code)
    ok(allCodes.includes(T2) && allCodes.includes(T3),
      '⑦ 但隔离仓在**仓库维护列表**里照常可见（可改名 / 可停用；"不进候选"≠"看不见"）', allCodes.join(','))

    // ⑦b 候选面 / 筛选面**必须分开**：`warehouses`（候选，排隔离仓）与 `warehouses_all`（筛选，含隔离仓）。
    // 混用的后果实测过：把隔离仓从候选里排掉的同时，它也**从筛选里消失**了 ——
    // 而隔离仓里真的有货，筛不出来就查不了它的库存。
    const listAll = (optOn.body?.data?.warehouses_all || []).map((w) => w.code)
    ok(listAll.includes(T2) && listAll.includes(T3),
      '⑦b `warehouses_all`（筛选面）**含**隔离仓 —— 隔离仓里的货要能筛出来',
      listAll.join(','))
    ok(listAll.length > listOn.length,
      '⑦b 两个面确实不同（warehouses_all 比候选 warehouses 多出隔离仓）',
      `候选 ${listOn.length} / 筛选 ${listAll.length}`)

    // ---------- ⑧ 停用 ----------
    const off = await X('PUT', `/master/warehouses/${whId}`, { status: 'inactive' })
    ok(off.status === 200, '⑧ 停用（status=inactive）→ 200', `${off.status} ${JSON.stringify(off.body).slice(0, 160)}`)
    const badStatus = await X('PUT', `/master/warehouses/${whId}`, { status: 'deleted' })
    ok(badStatus.status === 400, '⑧ 状态取值域也要枚举（status=deleted → 400）', `实得 ${badStatus.status}`)

    // ---------- ⑨ 停用后：**不出现在新建下拉里**（红点） ----------
    const optOff = await X('GET', '/master/options')
    const listOff = (optOff.body?.data?.warehouses || []).map((w) => w.code)
    ok(!listOff.includes(T1), '⑨ 停用仓**不再**出现在 /master/options（下拉里选不到）', listOff.join(','))

    // ---------- ⑩ 停用后：**拿它建单被拒**（红点） ----------
    const opt = await X('GET', '/master/options')
    const supplierId = (opt.body?.data?.suppliers || [])[0]?.value
    const skuId = (opt.body?.data?.skus || [])[0]?.value
    if (!supplierId || !skuId) {
      ok(false, '⑩ 夹具不足：拿不到供应商或 SKU，无法验证建单被拒', `supplier=${supplierId} sku=${skuId}`)
    } else {
      const po = await X('POST', '/purchase/orders', {
        supplier_id: supplierId,
        warehouse_id: whId,
        items: [{ sku_id: skuId, qty: 1, price: 10 }]
      })
      ok(po.status === 409 && (po.body?.error || po.body?.detail?.code) === 'WAREHOUSE_INACTIVE',
        '⑩ 用停用仓建采购单 → 409 WAREHOUSE_INACTIVE（后端也拦，不只靠界面）',
        `${po.status} ${po.body?.error || po.body?.detail?.code} ${po.body?.message || ''}`)
      // 合法的仓照常能建（不能把合法路径一起拦死）
      const poOk = await X('POST', '/purchase/orders', {
        supplier_id: supplierId,
        warehouse_id: (opt.body?.data?.warehouses || [])[0]?.value,
        items: [{ sku_id: skuId, qty: 1, price: 10 }]
      })
      ok(poOk.status === 200, '⑩ 用启用中的仓建单照常成功（没有把合法路径拦死）', `${poOk.status} ${JSON.stringify(poOk.body).slice(0, 160)}`)
    }

    // ---------- ⑪ 停用不影响历史（行还在、查得到） ----------
    const historic = await X('GET', `/master/warehouses?status=inactive&all=1`)
    const histList = historic.body?.data || historic.body?.data?.list || []
    ok(Array.isArray(histList) && histList.some((w) => w.code === T1), '⑪ 停用仓仍然查得到（停用≠消失）', JSON.stringify(histList).slice(0, 160))

    // ---------- ⑫ 类型字典（界面中文） ----------
    const dict = await X('GET', '/meta/dict')
    const wt = dict.body?.data?.warehouse_types || {}
    ok(wt.defect === '不合格品仓' && wt.quarantine === '待检品仓', '⑫ 字典含不合格品仓 / 待检品仓（新类型能显示成中文）', JSON.stringify(wt))
    ok(!!wt.kitchen, '⑫ 字典含 kitchen（餐饮线的中央厨房仓不再显示裸串）', JSON.stringify(wt))

    // ---------- ⑬ 「单据类型 → 允许仓库」白名单（最高层设计 §7.1，客户已拍） ----------
    // 客户原话：「某一类单据进客户指定仓库。」默认 = 不限（= 上线前的实际行为）。
    const whAll = await X('GET', '/master/warehouses?status=active&all=1')
    const usable = (whAll.body?.data || []).filter((w) => !['defect', 'quarantine'].includes(w.type))
    const [wa, wb] = usable
    if (!wa || !wb) {
      ok(false, '⑬ 夹具不足：需要两个可经营的启用仓', JSON.stringify(usable.map((w) => w.code)))
    } else {
      const opt2 = await X('GET', '/master/options')
      const supId = (opt2.body?.data?.suppliers || [])[0]?.value
      const skId = (opt2.body?.data?.skus || [])[0]?.value
      const mkPo = (whValue) =>
        X('POST', '/purchase/orders', { supplier_id: supId, warehouse_id: whValue, items: [{ sku_id: skId, qty: 1, price: 10 }] })

      // ⑬-1 默认（不配置）⇒ 两个仓都能建单 = **改动前的实际行为**
      const d1 = await mkPo(wa.id)
      const d2 = await mkPo(wb.id)
      ok(d1.status === 200 && d2.status === 200,
        `⑬-1 默认（配置为 \`*\` 不限）时 ${wa.code} / ${wb.code} 都能建单（= 上线前行为）`,
        `${wa.code}:${d1.status} ${wb.code}:${d2.status}`)

      // ⑬-2 把 PUR_IN 的许可集设成「只有 wa」
      const setScope = await X('PUT', '/meta/settings', { key: 'inv_doc_warehouse_scope', value: `PUR_IN=${wa.code}`, reason: '用例：验证单据类型允许仓库的白名单真的生效' })
      ok(setScope.status === 200, '⑬-2 把「单据类型允许仓库」配成 PUR_IN=' + wa.code + ' → 200', `${setScope.status} ${JSON.stringify(setScope.body).slice(0, 160)}`)

      const r1 = await mkPo(wa.id)
      ok(r1.status === 200, `⑬-2 许可集内的仓 ${wa.code} 照常放行（合法路径不能被拦死）`, `${r1.status} ${JSON.stringify(r1.body).slice(0, 160)}`)
      const r2 = await mkPo(wb.id)
      ok(r2.status === 409 && (r2.body?.error || r2.body?.detail?.code) === 'WAREHOUSE_NOT_ALLOWED_FOR_DOC',
        `⑬-2 许可集外的仓 ${wb.code} 建单 → 409 WAREHOUSE_NOT_ALLOWED_FOR_DOC（原错场景被拒）`,
        `${r2.status} ${r2.body?.error || r2.body?.detail?.code} ${r2.body?.message || ''}`)
      ok(/允许/.test(String(r2.body?.message || '')), '⑬-2 拒绝时人话里说得出允许哪些仓', r2.body?.message)

      // ⑬-3 没在配置里出现的单据类型 = 不限（PUR_RET 没配 ⇒ 采购退货不被这条限制拦住）
      const prt = await X('POST', '/purchase/returns', { supplier_id: supId, warehouse_id: wb.id, return_date: '2026-10-15', reason: '用例', items: [{ sku_id: skId, qty: 1, price: 10 }] })
      const prtCode = prt.body?.error || prt.body?.detail?.code
      ok(prtCode !== 'WAREHOUSE_NOT_ALLOWED_FOR_DOC',
        '⑬-3 没配过的单据类型（PUR_RET）**不受这条限制影响** = 不限（不许扩大拦截面）',
        `${prt.status} ${prtCode || ''} ${prt.body?.message || ''}`)

      // ⑬-4 把许可集改成「另一个仓」⇒ 行为必须跟着变（§4 接线证明：改配置 ⇒ 行为变）
      await X('PUT', '/meta/settings', { key: 'inv_doc_warehouse_scope', value: `PUR_IN=${wb.code}`, reason: '用例：换一个许可仓，行为必须跟着换' })
      const r3 = await mkPo(wa.id)
      const r4 = await mkPo(wb.id)
      ok(r3.status === 409 && r4.status === 200,
        '⑬-4 改成只允许 ' + wb.code + ' ⇒ ' + wa.code + ' 被拒 / ' + wb.code + ' 放行（**同一份配置改一下，判定真的翻转**）',
        `${wa.code}:${r3.status} ${wb.code}:${r4.status}`)

      // ⑬-5 写法不对 ⇒ 响亮拒绝，不静默当成"不限"
      await X('PUT', '/meta/settings', { key: 'inv_doc_warehouse_scope', value: 'PUR_IN WH01', reason: '用例：坏值必须响亮' })
      const r5 = await mkPo(wa.id)
      ok(r5.status === 409 && (r5.body?.error || r5.body?.detail?.code) === 'WAREHOUSE_SCOPE_INVALID',
        '⑬-5 配置写法不对 ⇒ 409 WAREHOUSE_SCOPE_INVALID（**不许静默退化成"不限"**）',
        `${r5.status} ${r5.body?.error || r5.body?.detail?.code} ${r5.body?.message || ''}`)

      // ⑬-6 恢复默认 ⇒ 必须回到"都不限"（不把合法路径永久拦死）
      const rs = await X('POST', '/meta/settings/reset', { key: 'inv_doc_warehouse_scope', reason: '用例：恢复默认（不限）' })
      ok(rs.status === 200, '⑬-6 恢复默认值 → 200', `${rs.status} ${JSON.stringify(rs.body).slice(0, 160)}`)
      const r6 = await mkPo(wb.id)
      ok(r6.status === 200, `⑬-6 恢复默认后 ${wb.code} 又能建单（默认 = 不限 = 上线前行为）`, `${r6.status} ${JSON.stringify(r6.body).slice(0, 160)}`)
    }
  }

  cleanup()
}

try {
  await main()
} catch (e) {
  fail += 1
  failures.push('脚本异常')
  console.error(`\n✗ 脚本异常：${e && e.stack ? e.stack : e}`)
} finally {
  await stopAndReport(srv, { port: PORT })
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (fail) console.log('失败项：\n - ' + failures.join('\n - '))
}
process.exit(fail ? 1 : 0)
