#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-test-helper-shape.mjs ｜ 静态守卫：断言助手**形状**守卫：钉住每个测试脚本里 `ok()` / `eq()` 的**形参顺序**。
 * ============================================================================
 * 【职责】静态守卫：断言助手**形状**守卫：钉住每个测试脚本里 `ok()` / `eq()` 的**形参顺序**。
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
 * 断言助手**形状**守卫：钉住每个测试脚本里 `ok()` / `eq()` 的**形参顺序**。
 *
 * ── 它钉的不是"顺序必须是哪一种"，而是"顺序不许在没人注意的时候变" ──────────────
 * 项目里当前**并存 4 种** `ok()` 形状（见下表 KNOWN_OK_SHAPES）。这本身不是错 ——
 * 每种都有它的语义（名字优先 / 消息优先 / 两参版）。**错的是它们太像了**：
 *
 *   从 `test-xlsx.mjs` 抄走 `ok(name, cond, detail)` 的顺序，写进 `test-export-excel.mjs`
 *   （后者是 `ok(cond, msg, detail)`）⇒ **条件位收到一个非空字符串 ⇒ 恒真**。
 *   那条断言从此**永远绿**，而"健康跑"也照样全绿 —— 没有任何东西会响。
 *
 * 所以这里的判据只有一条：**实测形状 == 声明表里的形状**。
 *   · 声明表里没有的文件 ⇒ 失败（新文件必须登记它的形状）；
 *   · 形状与声明不符   ⇒ 失败（有人换了参数顺序 —— 换顺序会让**所有调用点静默错位**）；
 *   · 实测形状不在已知集合里 ⇒ 失败并要求人工确认（防止"又发明一种"）。
 *
 * 声明表**就是现状快照**，不是"应该长什么样"。要改某个文件的形状：
 *   ① 改代码；② 跑 `--list` 拿到新表；③ 把那一行改掉并**在提交信息里说明为什么**。
 * 换形状本身没被禁止，被禁止的是**悄悄换**。
 *
 * 用法：
 *   node scripts/check-test-helper-shape.mjs          # 全绿退出 0，否则 1
 *   node scripts/check-test-helper-shape.mjs --list   # 只打印实测表（可粘贴回本文件）
 *
 * 退出码：0 = 全部相符；1 = 有断言失败；2 = 命令行用法错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = [
  '用法：node scripts/check-test-helper-shape.mjs [--list]',
  '  （无参数）：检查 scripts/test-*.mjs 与 scripts/accept/*.mjs 的 ok()/eq() 形参顺序是否与声明表一致',
  '  --list    ：只打印实测形状表（可直接粘贴回本文件的 DECLARED），不做断言'
].join('\n')

// ---------------------------------------------------------------------------
// 已知形状（**语义清单，不是位置清单**）
// ---------------------------------------------------------------------------
// 为什么要有这张清单：光比对"实测 vs 声明"挡不住"声明表和代码一起被改成第 5 种"。
// 它是第二道闸：任何**新组合**都必须先在这张清单里登记（= 有人看过并确认过）。
const KNOWN_OK_SHAPES = {
  'name,cond,detail': '名字优先：ok(name, cond, detail) —— 多数 name-first 家族',
  'msg,cond,detail': '消息优先：ok(msg, cond, detail) —— 与上一行**首参互换**，最危险的近邻',
  'cond,msg,detail': '条件优先 + 详情：ok(cond, msg, detail)',
  'cond,msg': '条件优先、两参：ok(cond, msg)'
}
const KNOWN_EQ_SHAPES = {
  'name,actual,expected': 'eq(name, actual, expected)',
  'name,actual,expect': 'eq(name, actual, expect)',
  'name,a,b': 'eq(name, a, b) —— 三个字母的两参版',
  'msg,actual,expect': 'eq(msg, actual, expect)',
  'msg,a,b': 'eq(msg, a, b)',
  'a,b': 'eq(a, b) —— 没有标签位；失败时打不出断言名'
}

// ---------------------------------------------------------------------------
// 声明表：**照实测填**（生成方式：`node scripts/check-test-helper-shape.mjs --list`）
// ---------------------------------------------------------------------------
const DECLARED = {
  'test-access-boundaries.mjs': { ok: null, eq: null },
  'a04-common-tx.mjs': { ok: 'name,cond,detail', eq: null },
  'a14-a18-reversal.mjs': { ok: null, eq: null },
  'reversal-cashflow.mjs': { ok: null, eq: null },
  'reversal-im.mjs': { ok: null, eq: null },
  'reversal-jwt-secret.mjs': { ok: null, eq: null },
  'reversal-report-deepening.mjs': { ok: null, eq: null },
  'run-on-copy.mjs': { ok: null, eq: null },
  'selfcheck.mjs': { ok: 'name,cond,detail', eq: 'name,a,b' },
  'smoke-report-deepening.mjs': { ok: 'name,cond,detail', eq: 'name,actual,expect' },
  'test-annual.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-approval.mjs': { ok: 'cond,msg', eq: null },
  'test-ar.mjs': { ok: 'cond,msg', eq: 'msg,actual,expect' },
  'test-audit-fixes.mjs': { ok: null, eq: null },
  'test-audit-trail.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-cashflow-item.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-closing.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-compare.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-costing.mjs': { ok: 'cond,msg', eq: null },
  'test-dms.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-dependency-security.mjs': { ok: null, eq: null },
  'test-local-delivery.mjs': { ok: null, eq: null },
  'test-docflow.mjs': { ok: 'name,cond,detail', eq: 'name,actual,expected' },
  'test-export-excel.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-final.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-fiscal-year.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-flows.mjs': { ok: 'name,cond,detail', eq: 'name,actual,expected' },
  // 本批新开的 11 个「门」的常驻测试（三路各一份脚本，形状各不相同 —— **照实测填**，别统一）：
  //   gates-inventory 用 `ok(cond,msg,detail)`（与 test-warehouse-master 同形）
  //   gates-other / gates-purchase 用 `ok(name,cond,detail)`（与 test-guards 同形）
  // 两份形状并存这件事本身就是"逐文件声明"的价值：如果当初按"统一成一个形状"去写，
  // 这种差异会看不见，而差异正是"抄一行过来 → 条件位收到非空字符串 → 断言恒真"的事故源。
  'test-gates-inventory.mjs': { ok: 'cond,msg,detail', eq: null },
  'test-gates-other.mjs': { ok: 'name,cond,detail', eq: null },
  'test-gates-purchase.mjs': { ok: 'name,cond,detail', eq: null },
  'test-guards.mjs': { ok: 'name,cond,detail', eq: null },
  'test-im-sync.mjs': { ok: 'msg,cond,detail', eq: 'msg,a,b' },
  // 批次 W：行业码「非法值拒绝式归一化」的守卫（判据用哨兵计数证明"读到哪个库"）。
  // ⚠️ 该文件初稿曾把调用点写成 ok(msg, cond, detail) —— 条件位收到非空字符串 ⇒ 49 条断言**恒真**
  //    （假绿，打印出来是 ✓ true 而不是断言名）。**本守卫只查形参名、查不出调用点参数错位** ——
  //    这是它已知的盲区（见文件头那段"从 test-xlsx 抄顺序"的说明，说的是同一件事的另一面）。
  'test-industry-code.mjs': { ok: 'cond,msg,detail', eq: null },
  // 「是否允许负库存」的唯一出处 = 配置中心（inv_allow_negative / _for 登记在 SETTING_RULES）。
  'test-inv-negative-stock.mjs': { ok: 'cond,msg,detail', eq: null },
  // 出入库类型主数据化（批次 W）：闸门成员必须有写入点那条判据的证据脚本。形状 (cond,msg,detail)、无 eq。
  'test-inv-type-gate.mjs': { ok: 'cond,msg,detail', eq: null },
  'test-invoice.mjs': { ok: 'cond,msg', eq: 'msg,actual,expect' },
  'test-jwt-secret.mjs': { ok: 'name,cond,detail', eq: null },
  // 批次 V 新增的三个内核守卫。前两个原本的形参名是 (cond,msg,extra) 与 (c,m) —— 与既有两个形状
  // **语义相同、只是拼写不同**，已改成 detail / cond,msg 归一到既有形状（形状越少守卫越有牙，
  // 近邻名正是本守卫要拦的事故）。a7 不打 ok()，只自己打印 PASS/FAIL ⇒ 两个都是 null。
  'test-kernel-a7.mjs': { ok: null, eq: null },
  'test-kernel-m7m9.mjs': { ok: 'cond,msg,detail', eq: null },
  'test-kernel-migrate.mjs': { ok: 'cond,msg', eq: null },
  'test-mcp-purchase.mjs': { ok: 'name,cond,detail', eq: null },
  'test-mcp.mjs': { ok: 'name,cond,detail', eq: null },
  'test-mcp-validation.mjs': { ok: null, eq: null },
  'test-metrics.mjs': { ok: 'cond,msg', eq: null },
  'test-mfg.mjs': { ok: 'cond,msg', eq: 'msg,actual,expect' },
  'test-multi-year.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-notify.mjs': { ok: 'cond,msg', eq: null },
  'test-oc.mjs': { ok: 'cond,msg', eq: null },
  'test-org-perm.mjs': { ok: null, eq: null },
  'test-period-audit.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-pos2.mjs': { ok: 'cond,msg', eq: 'msg,actual,expect' },
  'test-pricing.mjs': { ok: 'name,cond,detail', eq: 'name,a,b' },
  // 批次 V：成品「启用质检」开关的可售性判据守卫（qcSaleBlock 的唯一落点 + pickBatches 同源）。
  'test-product-qc-switch.mjs': { ok: 'cond,msg,detail', eq: null },
  'test-promo.mjs': { ok: 'cond,msg', eq: 'msg,actual,expect' },
  'test-promotion.mjs': { ok: 'name,cond,detail', eq: null },
  'test-purchase.mjs': { ok: 'cond,msg', eq: null },
  // 本批补的「采购退货会计落点」常驻测试：方向判据（借 2202 / 贷 1405）就写在这个文件里，
  // 它的形状与 test-gates-* 一致（`ok(name,cond,detail)`），**没有 eq**。
  'test-purchase-return-accounting.mjs': { ok: 'name,cond,detail', eq: null },
  'test-qc.mjs': { ok: 'cond,msg', eq: 'a,b' },
  'test-qc2.mjs': { ok: 'cond,msg', eq: 'msg,actual,expect' },
  'test-quote-credit.mjs': { ok: 'cond,msg', eq: null },
  'test-range.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-refund.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-report-config-audit.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-report.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-setting-audit.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  'test-stock-v2.mjs': { ok: 'name,cond,detail', eq: 'name,actual,expected' },
  'test-voucher.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' },
  // 仓库主数据可维护（不许物理删除 / 编码不可改 / 类型枚举 / 停用仓不能建单）—— 三库各跑一遍。
  'test-warehouse-master.mjs': { ok: 'cond,msg,detail', eq: null },
  'test-xlsx.mjs': { ok: 'name,cond,detail', eq: null },
  'test-ytd-compare.mjs': { ok: 'cond,msg,detail', eq: 'msg,actual,expect' }
}

// ---------------------------------------------------------------------------
// 扫描面：scripts/test-*.mjs + scripts/accept/*.mjs
// ---------------------------------------------------------------------------
const scan = () => {
  const out = []
  const add = (dir, filter) => {
    const d = path.join(ROOT, dir)
    if (!fs.existsSync(d)) return
    for (const f of fs.readdirSync(d)) if (filter(f)) out.push({ file: f, rel: `${dir}/${f}`, abs: path.join(d, f) })
  }
  add('scripts', (f) => f.startsWith('test-') && f.endsWith('.mjs'))
  add('scripts/accept', (f) => f.endsWith('.mjs'))
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 取某个助手的形参名列表（去空白；剥掉默认值）。
 * 三种写法都收：`function ok(...)` / `const ok = (...) =>` / `const ok = function (...)`。
 * 同一文件里出现**多种**形状时全部返回（调用点会按就近的那个解释，所以那本身就是缺陷）。
 */
function paramShapes(src, name) {
  const found = new Set()
  const res = [
    new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)`, 'g'),
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\(([^)]*)\\)\\s*=>`, 'g'),
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*function\\s*\\(([^)]*)\\)`, 'g')
  ]
  for (const re of res) {
    let m
    while ((m = re.exec(src))) found.add(m[1].replace(/\s+/g, '').replace(/=.*$/, ''))
  }
  return [...found]
}

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------
let pass = 0
let failed = 0
const failNames = []
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    failNames.push(name)
    console.log(`  ✗ ${name}${extra ? `  —— ${extra}` : ''}`)
  }
}

const measured = scan().map((e) => {
  const src = fs.readFileSync(e.abs, 'utf8')
  const okShapes = paramShapes(src, 'ok')
  const eqShapes = paramShapes(src, 'eq')
  return {
    file: e.file,
    rel: e.rel,
    okShapes,
    eqShapes,
    ok: okShapes.length === 1 ? okShapes[0] : null,
    eq: eqShapes.length === 1 ? eqShapes[0] : null
  }
})

// ---------------------------------------------------------------------------
// --list：只打印实测表（粘贴回 DECLARED 用）
// ---------------------------------------------------------------------------
if (process.argv.includes('--list')) {
  console.log(`// 实测于 ${new Date().toISOString().slice(0, 10)}（${measured.length} 个文件）`)
  for (const m of measured) {
    const v = (arr) => (arr.length === 0 ? 'null' : arr.length === 1 ? `'${arr[0]}'` : `[${arr.map((x) => `'${x}'`).join(', ')}]`)
    console.log(`  '${m.file}': { ok: ${v(m.okShapes)}, eq: ${v(m.eqShapes)} },`)
  }
  process.exit(0)
}
const unknownArgs = process.argv.slice(2)
if (unknownArgs.length) {
  console.error(`✗ 未知参数：${unknownArgs.join(' ')}\n`)
  console.error(USAGE)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 判据
// ---------------------------------------------------------------------------
console.log(`断言助手形状守卫（扫描 ${measured.length} 个文件）`)

// ① 扫描面自证：0 个文件说明路径写错了，那种"全绿"是假的
ok('扫描面自证：至少扫到 10 个文件（否则是本守卫的路径写错了，不是"大家都对"）', measured.length >= 10, `实际 ${measured.length}`)

// ② 覆盖率：扫到的每个文件都要登记
const declaredNames = new Set(Object.keys(DECLARED))
const missing = measured.filter((m) => !declaredNames.has(m.file)).map((m) => m.file)
ok(
  `声明表覆盖：${measured.length} 个被扫到的文件全部有登记`,
  missing.length === 0,
  missing.length ? `未登记 ${missing.length} 个：${missing.join(' / ')} —— 新文件必须登记它的断言助手形状，否则"抄错顺序"这类事故不会被任何人发现` : ''
)

// ③ 不过期：表里的每个文件都还在
const scannedNames = new Set(measured.map((m) => m.file))
const stale = [...declaredNames].filter((n) => !scannedNames.has(n))
ok(
  '声明表不过期：表里没有"已经不存在"的文件',
  stale.length === 0,
  stale.length ? `过期条目 ${stale.length} 个：${stale.join(' / ')}` : ''
)

// ④ 同一文件里形状唯一（多形状 = 调用点按就近解释，等于没形状）
const ambiguous = measured.filter((m) => m.okShapes.length > 1 || m.eqShapes.length > 1)
ok(
  '同一文件里 ok()/eq() 只有一种形状',
  ambiguous.length === 0,
  ambiguous.map((m) => `${m.rel} ok=[${m.okShapes.join(' | ')}] eq=[${m.eqShapes.join(' | ')}]`).join(' / ')
)

// ⑤ 已知形状自证：出现第 5 种就要求人工确认
const unknownOk = measured.filter((m) => m.ok && !KNOWN_OK_SHAPES[m.ok])
const unknownEq = measured.filter((m) => m.eq && !KNOWN_EQ_SHAPES[m.eq])
ok(
  `已知 ok() 形状自证：实测形状都在 ${Object.keys(KNOWN_OK_SHAPES).length} 种之内`,
  unknownOk.length === 0,
  unknownOk.length ? `${unknownOk.map((m) => `${m.rel} → ${m.ok}`).join(' / ')} —— 出现**新的第 5 种形状**，请人工确认后再进 KNOWN_OK_SHAPES（近邻互换是最危险的）` : ''
)
ok(
  `已知 eq() 形状自证：实测形状都在 ${Object.keys(KNOWN_EQ_SHAPES).length} 种之内`,
  unknownEq.length === 0,
  unknownEq.length ? `${unknownEq.map((m) => `${m.rel} → ${m.eq}`).join(' / ')} —— 新的 eq 形状，请人工确认` : ''
)

// ⑥ 声明表自身合法：表里不准写一个"不存在的形状"
const badDecl = Object.entries(DECLARED).flatMap(([f, v]) => {
  const bad = []
  if (v.ok && !KNOWN_OK_SHAPES[v.ok]) bad.push(`${f}.ok=${v.ok}`)
  if (v.eq && !KNOWN_EQ_SHAPES[v.eq]) bad.push(`${f}.eq=${v.eq}`)
  return bad
})
ok('声明表自身合法：表里写的形状都在已知清单里（防止把表也写歪）', badDecl.length === 0, badDecl.join(' / '))

// ⑦ 逐文件比对
for (const m of measured) {
  if (!declaredNames.has(m.file)) continue
  const d = DECLARED[m.file]
  const sameOk = (d.ok ?? null) === m.ok
  const sameEq = (d.eq ?? null) === m.eq
  ok(
    `形状未变：${m.rel}  ok=${m.ok ?? '(无)'}  eq=${m.eq ?? '(无)'}`,
    sameOk && sameEq,
    sameOk && sameEq ? '' : `声明是 ok=${d.ok ?? '(无)'} eq=${d.eq ?? '(无)'} —— 换了参数顺序会让**所有调用点静默错位**：条件位收到一个非空字符串就恒真，断言从此永远绿。要么改回去，要么按 --list 更新声明表并说明为什么`
  )
}

// ---------------------------------------------------------------------------
console.log('\n' + '─'.repeat(60))
if (failed) console.log(`失败断言：${failNames.join(' / ')}`)
console.log(`计数 通过 ${pass} / 失败 ${failed}`)
process.exitCode = failed ? 1 : 0
