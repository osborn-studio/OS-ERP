/**
 * ============================================================================
 * 文件标识：scripts/check-file-header.mjs ｜ 「文件标识块」的守卫 + 覆盖率体检
 * ============================================================================
 * 【客户要求】
 *   「代码要规范，都要有标识，方便以后人为读取理解，然后人工改进。」
 *
 * 【为什么不是"全仓强制"】
 *   存量有 200+ 个文件，一次性全加既不可靠（大段注释靠人写，写歪了更糟），
 *   也会把这次改动变成一场无法审阅的格式化海啸。
 *   所以本守卫只做两件事，都是**能长期成立**的：
 *     ① **已登记的文件不许退化**（DECLARED 里的文件必须还有标识块）——
 *        防止"后来有人重构时把说明删了"；
 *     ② **把覆盖率说出来**（已标识 N / 全仓 M，百分比）——
 *        让"还没做完"这件事**每次跑批都可见**，而不是只写在某次交付说明里。
 *
 * 【怎么扩大覆盖面】
 *   给一个文件补上标识块 → 把路径加进 `DECLARED` → 提交。
 *   **不要**为了让它绿而把路径从 DECLARED 里删掉（那是把守卫改弱，不是把代码改好）。
 *
 * 【标识块长什么样】
 *   文件开头的块注释，第一行含「文件标识：<路径> ｜ <一句话职责>」，随后写清：
 *   这块干什么 / 为什么这样设计 / 改它要注意什么。参考 `server/index.js` 的开头。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 已登记「文件标识块」的文件。补一个加一行。 */
const DECLARED = [
  'server/index.js',
  'server/lib/audit-trail.js',
  'server/lib/redact.js',
  'server/middleware/audit.js',
  'server/version.js',
  'server/mcp/catalog.js',
  'server/mcp/delegation.js',
  'server/mcp/tokens.js',
  'server/db/migrations/053_agent_token_owner_version.cjs',
  'server/lib/outbound-url.js',
  'server/lib/secret-box.js',
  'scripts/check-mcp-coverage.mjs',
  'scripts/check-file-header.mjs',
  'scripts/db-backup.mjs',
  'server/db/migrations/runner.js',
  'server/lib/backup-dir.js',
  // 恢复 / 升级回退演练（ADR-0016）：共用底座 + 两个演练入口
  'scripts/lib/drill-common.mjs',
  'scripts/db-restore-drill.mjs',
  'scripts/upgrade-rollback-drill.mjs',
  'src/App.tsx',
  'src/api/client.ts',
  'src/components/Layout.tsx',
  'src/constants/brand.ts',
  'src/constants/capabilities.ts',
  'src/pages/system/McpCenter.tsx',
  'tailwind.config.js',
  // 授信释放台账（ADR-0013）：释放/逆向的唯一实现、建表迁移与守卫测试
  'server/lib/credit-release.js',
  'server/db/migrations/052_credit_release_ledger.cjs',
  'tests/credit-reversal.test.mjs',
  // 授信投影（ADR-0014）：credit_hold 的唯一写入者与对账守卫
  'tests/credit-hold-projection.test.mjs',
  // 待办范围与 Agent Token 有效状态（ADR-0015）
  'server/db/migrations/055_agent_token_revoke_reason.cjs',
  'tests/authz-followups.test.mjs'
]

/** 参与覆盖率统计的源文件（**排除** node_modules / dist / data） */
const SCAN_ROOTS = ['server', 'scripts', 'src']
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx'])
const EXTRA = ['tailwind.config.js', 'vite.config.ts']

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
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail !== undefined ? `  → ${String(detail).slice(0, 300)}` : ''}`)
  }
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)

/** 标识块的判据：文件前 1200 字符里同时出现「文件标识」与「===」分隔线 */
function hasHeader(abs) {
  let t
  try {
    t = fs.readFileSync(abs, 'utf8').slice(0, 1200)
  } catch {
    return false
  }
  return t.includes('文件标识') && t.includes('====')
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (SCAN_EXT.has(path.extname(f))) out.push(p)
  }
  return out
}

section('文件标识守卫')

// ① 已登记的必须还在
const missing = DECLARED.filter((rel) => !hasHeader(path.join(ROOT, rel)))
ok(`已登记的 ${DECLARED.length} 个文件都有标识块`, missing.length === 0, `缺标识：${missing.join(' / ')}`)

// ② 登记表本身不许有"指向不存在的文件"（表过期会让人以为"已经覆盖了"）
const gone = DECLARED.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
ok('登记表里没有已不存在的文件', gone.length === 0, `已不存在：${gone.join(' / ')}`)

// ③ 扫描面自证（否则"全绿"可能只是路径写错了）
const files = [...SCAN_ROOTS.flatMap((d) => walk(path.join(ROOT, d))), ...EXTRA.map((f) => path.join(ROOT, f))]
  .filter((p) => fs.existsSync(p))
ok('扫描面自证：至少扫到 100 个源文件', files.length >= 100, `实得 ${files.length}`)

// ④ 覆盖率体检（**打印，不判成败** —— 这是"还没做完"的可见化，不是失败）
const withHeader = files.filter((f) => hasHeader(f))
const pct = ((withHeader.length / files.length) * 100).toFixed(1)
console.log(`\n  覆盖率：${withHeader.length} / ${files.length} 个源文件有标识块（${pct}%）`)
console.log('  未覆盖的（前 8 个，按路径排）：')
for (const f of files.filter((x) => !hasHeader(x)).slice(0, 8)) console.log(`    ${path.relative(ROOT, f)}`)
// 棘轮：覆盖率**只许往上调**，不许往下掉。掉下来说明有文件把标识块删了，
// 或者新增了一批没标识的文件 —— 两种情况都该有人看一眼，而不是让它静静变回 2.9%。
const RATCHET = 100
ok(`覆盖率必须保持 100%（棘轮 ${RATCHET}%）（当前 ${pct}%）`, Number(pct) >= RATCHET, `已掉到 ${pct}%，请补标识块后把 RATCHET 往上调`)
console.log('  ⚠️ 覆盖是逐步补的：补一个就把路径加进 DECLARED，并把 RATCHET 往上调。')

console.log(`\n${'─'.repeat(64)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (failed.length) console.log('失败项：\n - ' + failed.join('\n - '))
process.exit(fail ? 1 : 0)
