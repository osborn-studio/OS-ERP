#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-data-paths.mjs ｜ 静态守卫：库文件路径只能经 `server/db/index.js` 解析（ADR-0019）
 * ============================================================================
 * 【为什么需要它】
 *   ADR-0001 要求所有库访问都走显式绝对 `GML_DATA_DIR`。但判据写在 `server/db/index.js` 里，
 *   一个脚本只要自己拼 `'data/gml_cosmetic.db'` 或 `path.join(ROOT, 'data', …)` 就把它整个绕开了，
 *   **而且不报错**：`scripts/check-mcp-coverage.mjs` 文件头写着"设了 GML_DATA_DIR 读那里"，
 *   代码却一直读仓库 `data/`。这种漏只有静态扫描能长期盯住。
 *
 * 【判据】扫描 `server/ scripts/ tests/` 下的 .js/.mjs/.cjs（去掉注释行后），以下任一形态算命中：
 *   ① `'data/gml_xxx.db'` / `` `data/gml_${x}.db` `` 字面量；
 *   ② `'data', 'gml_…'` / `'data', `gml_…`` 相邻的两个 `path.join` 段；
 *   ③ `'data/' +` 字符串拼接；
 *   ④ `readdirSync('data')`（相对 cwd 的仓库目录）；
 *   ⑤ `path.join(ROOT|ROOT_DIR|__dirname…, 'data')` —— "仓库 data/ 兜底路径"的定义点。
 *   `server/db/index.js` 是唯一允许的定义点，不扫。其余命中必须在 `ALLOW` 里**带理由**登记；
 *   登记了却已无命中 ⇒ 也红（例外表不许变成橡皮图章）。
 *
 * 【改它要注意什么】往 ALLOW 里加一行之前先问：这个脚本为什么不能用
 *   `requireExplicitDataDir()` + `dbPathFor()`？答不上来就改脚本，不改例外表。
 *   tests/data-path-guard.test.mjs 用临时副本证明本守卫会红。
 *
 * 用法：node scripts/check-data-paths.mjs    （无参数；纯静态、零副作用）
 * 退出码：0 全绿；1 有未登记命中或过期登记；2 用法错误。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '..')
const SCAN_DIRS = ['server', 'scripts', 'tests']
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs'])
/** 唯一允许定义 `<repo>/data` 兜底的地方 */
const DEFINITION_POINT = 'server/db/index.js'
/** 本守卫的测试把**合成样本**写在字符串里，和本文件一样从扫描面排除（否则自我误报） */
const SAMPLE_HOLDERS = new Set([DEFINITION_POINT, 'tests/data-path-guard.test.mjs'])

if (process.argv.length > 2) {
  console.error('用法：node scripts/check-data-paths.mjs   （无参数）')
  process.exit(2)
}

const PATTERNS = [
  { id: '①', re: /['"`]data\/gml_[A-Za-z_${}]+\.db/, what: "'data/gml_*.db' 字面量" },
  { id: '②', re: /['"]data['"]\s*,\s*['"`]gml_/, what: "path.join(…, 'data', 'gml_…')" },
  { id: '③', re: /['"]data\/['"]\s*\+/, what: "'data/' + … 拼接" },
  { id: '④', re: /readdirSync\(\s*['"]data['"]\s*\)/, what: "readdirSync('data')（相对 cwd）" },
  { id: '⑤', re: /path\.join\(\s*(ROOT|ROOT_DIR|repo|root|__dirname[^,]*)\s*,\s*['"]data['"]\s*\)/, what: '仓库 data/ 兜底路径定义' }
]

/**
 * 例外表：文件 → 理由。**每条都要能说清为什么不走 `requireExplicitDataDir()`**。
 * 分三类：(a) 闸门自身需要知道"仓库 data/ 在哪"才能拒绝它；(b) 安装副本 / 隔离副本的根目录就是数据根
 *   （`local-manage.mjs` 以前也在这里：现在它按 `INSTANCE`（缺省 = 代码根）拼 data/，不再是本守卫的字面形态，
 *   但语义上仍是"安装副本的数据根"，子进程显式收到 `GML_DATA_DIR`）；
 * (c) 历史 test-*.mjs 把 `<ROOT>/data` 当**只读样本源**复制进自己的隔离目录——它们只在 regress-isolated
 *     的临时副本里跑（那里 `<ROOT>/data` 正是 reseed-all 按显式 GML_DATA_DIR 灌出来的样本）；迁到
 *     `dbPathFor()` 是后续批次的事，这里先钉住"不许再多一个"。
 */
const ALLOW = {
  // (a) 闸门：需要仓库 data/ 的路径来拒绝它
  'scripts/regress-all.mjs': '闸门：拒绝对仓库 data/ 跑回归；DICT 快照取自显式 GML_DATA_DIR',
  'scripts/audit-fts-maintain.mjs': '闸门：--out 报告路径不许落在仓库 data/ 下（库文件本身走 requireExplicitDataDir() + dbPathFor()）',
  'tests/audit-fts-maintain.test.mjs': '闸门测试：证明 audit-fts-maintain.mjs 拒绝仓库 data/ 作 --data-dir，且忽略环境 GML_DB（只传路径，不读写）',
  'scripts/inject-mfg-guards.mjs': '闸门：子进程 GML_DATA_DIR 不许落在仓库 data/ 下',
  'scripts/accept/selfcheck.mjs': '闸门：自检"数据目录不是开发库"，需要知道仓库 data/ 在哪',
  'scripts/test-flows.mjs': 'isDevDataDir 告警判据（自证开发库目录会被认出来）',
  'scripts/test-guards.mjs': 'isDevDataDir 告警判据（自证开发库目录会被认出来）',
  'tests/retention.test.mjs': '闸门测试：证明 retention.mjs 拒绝把仓库 data/ 当 GML_DATA_DIR（只传路径，不读写）',
  'tests/privacy-tools.test.mjs': '闸门测试：证明 privacy-export.mjs 拒绝把仓库 data/ 当 GML_DATA_DIR（只传路径，不读写）',
  // (b) 根目录就是数据根
  'scripts/regress-isolated.mjs': '隔离副本：reseed-all 显式收到 GML_DATA_DIR=<副本>/data，再 backup 到 run-data',
  'tests/local-instance.test.mjs': '安装验收：对临时实例目录（GML_LOCAL_INSTANCE）内的 data/ 断言，不是开发仓库',
  'scripts/test-local-delivery.mjs': '安装验收：对全新解压包目录（--package）内的 data/ 断言，不是开发仓库',
  'scripts/accept/a14-a18-reversal.mjs': '验收演练：把工作区（含 data/）整体复制到临时副本后再注入，只读源目录',
  'scripts/accept/reversal-cashflow.mjs': '验收演练：把工作区（含 data/）整体复制到临时副本后再注入，只读源目录',
  'scripts/accept/reversal-jwt-secret.mjs': '验收演练：只统计工作区 data/ 下库文件个数（只读），副本另建',
  'scripts/accept/smoke-report-deepening.mjs': '验收演练：只统计工作区 data/ 的行数以证明源目录未被改动（只读）',
  'scripts/accept/reversal-report-deepening.mjs': '验收演练：把工作区（含 data/）整体复制到临时副本后再注入，只读源目录',
  // (c) 历史 test-*.mjs：只读样本源 → 自己的隔离目录（后续批次迁到 dbPathFor）
  'scripts/test-audit-trail.mjs': '历史测试：<ROOT>/data 只读样本源，backup 到临时目录',
  'scripts/test-cashflow-item.mjs': '历史测试：<ROOT>/data 只读样本源，backup 到临时目录',
  'scripts/test-export-excel.mjs': '历史测试：<ROOT>/data 只读样本源 + 只读比对',
  'scripts/test-gates-inventory.mjs': '历史测试：<ROOT>/data 只读样本源',
  'scripts/test-gates-other.mjs': '历史测试：<ROOT>/data 只读样本源',
  'scripts/test-gates-purchase.mjs': '历史测试：<ROOT>/data 只读样本源',
  'scripts/test-industry-code.mjs': '历史测试：<ROOT>/data 只读样本源',
  'scripts/test-inv-negative-stock.mjs': '历史测试：<ROOT>/data 只读样本源',
  'scripts/test-kernel-a7.mjs': '历史测试：<ROOT>/data 只读样本源',
  'scripts/test-kernel-m7m9.mjs': '历史测试：<ROOT>/data 只读样本源',
  'scripts/test-kernel-migrate.mjs': '历史测试：<ROOT>/data 只读样本源',
  'scripts/test-product-qc-switch.mjs': '历史测试：<ROOT>/data 只读样本源',
  'scripts/test-purchase-return-accounting.mjs': '历史测试：<ROOT>/data 只读样本源',
  'scripts/test-warehouse-master.mjs': '历史测试：<ROOT>/data 只读样本源',
  'scripts/verify-purchase-chain.mjs': '历史测试：<ROOT>/data 只读样本源',
  'scripts/verify-purchase-entry.mjs': '历史测试：<ROOT>/data 只读样本源',
  // 其余 test-*.mjs 里 `path.resolve(path.join(ROOT, 'data'))` 是"等于仓库 data/ 就拒绝"的闸门（形态⑤）
  'scripts/test-annual.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-audit-fixes.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-closing.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-compare.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-final.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-fiscal-year.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-im-sync.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-mcp-purchase.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-multi-year.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-org-perm.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-period-audit.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-pricing.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-range.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-refund.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-report.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-report-config-audit.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-setting-audit.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝',
  'scripts/test-ytd-compare.mjs': '闸门：GML_DATA_DIR 等于仓库 data/ 就拒绝'
}

let pass = 0
let fail = 0
const failed = []
function ok(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    fail += 1
    failed.push(name)
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail !== undefined ? `  → ${String(detail).slice(0, 1200)}` : ''}`)
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name.startsWith('.')) continue
    const p = path.join(dir, item.name)
    if (item.isDirectory()) walk(p, out)
    else if (SCAN_EXT.has(path.extname(item.name))) out.push(p)
  }
  return out
}

/** 去掉整行注释与行尾 `//` 注释（够用的启发式：判据只会偏保守，不会放过真洞） */
function codeLines(src) {
  const out = []
  let inBlock = false
  for (const [i, raw] of src.split('\n').entries()) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) continue
      line = line.slice(end + 2)
      inBlock = false
    }
    const t = line.trim()
    if (t.startsWith('//')) continue
    const bs = line.indexOf('/*')
    if (bs !== -1) {
      const be = line.indexOf('*/', bs + 2)
      if (be === -1) { inBlock = true; line = line.slice(0, bs) } else line = line.slice(0, bs) + line.slice(be + 2)
    }
    const sl = line.indexOf(' // ')
    if (sl !== -1) line = line.slice(0, sl)
    out.push([i + 1, line])
  }
  return out
}

console.log('\x1b[36m库文件路径守卫（ADR-0019）\x1b[0m')
const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)))
  .filter((f) => f !== SELF)
  .map((f) => path.relative(ROOT, f))
  .filter((rel) => !SAMPLE_HOLDERS.has(rel))
  .sort()
ok('扫描面自证：至少 100 个源文件', files.length >= 100, `实得 ${files.length}`)

const hits = new Map() // rel → [{line, id, text}]
for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  for (const [lineNo, line] of codeLines(src)) {
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        if (!hits.has(rel)) hits.set(rel, [])
        hits.get(rel).push({ line: lineNo, id: p.id, text: line.trim() })
        break
      }
    }
  }
}

const unregistered = [...hits.keys()].filter((rel) => !Object.hasOwn(ALLOW, rel))
ok(
  '未登记的仓库 data/ 直拼路径 = 0（新脚本请走 requireExplicitDataDir() + dbPathFor()）',
  unregistered.length === 0,
  unregistered.map((rel) => `${rel}: ${hits.get(rel).map((h) => `L${h.line}${h.id} ${h.text}`).join(' | ')}`).join('\n      ')
)
const stale = Object.keys(ALLOW).filter((rel) => !hits.has(rel))
ok('例外表没有过期登记（登记了却已无命中 ⇒ 删掉那一行）', stale.length === 0, stale.join(' / '))
const gone = Object.keys(ALLOW).filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
ok('例外表里没有已不存在的文件', gone.length === 0, gone.join(' / '))
ok('定义点仍然只有一个（server/db/index.js 存在且含 GML_DATA_DIR 兜底）',
  fs.existsSync(path.join(ROOT, DEFINITION_POINT)) && /GML_DATA_DIR/.test(fs.readFileSync(path.join(ROOT, DEFINITION_POINT), 'utf8')))

console.log(`\n  已登记例外 ${Object.keys(ALLOW).length} 个文件；命中文件 ${hits.size} 个（含登记）`)
console.log(`\n${'─'.repeat(64)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (failed.length) console.log('失败项：\n - ' + failed.join('\n - '))
process.exit(fail ? 1 : 0)
