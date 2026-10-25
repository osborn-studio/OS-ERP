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
  // 审计哈希链（AB6，ADR-0049）
  'server/db/migrations/_audit_chain.cjs',
  'server/lib/audit-chain-verify.js',
  'server/lib/audit-anchor-manifest.js',
  'server/db/migrations/068_audit_hash_chain.cjs',
  // 锚点操作意图（AE5，ADR-0055 补充）
  'server/db/migrations/072_audit_anchor_intents.cjs',
  'server/lib/audit-anchor-intent.js',
  'scripts/lib/anchor-intent-signer.mjs',
  'scripts/audit-verify-chain.mjs',
  // 限速阈值校准（AH9，ADR-0056 补充 4）
  'scripts/mcp-rate-calibrate.mjs',
  'scripts/audit-archive.mjs',
  'scripts/gen-role-matrix.mjs',
  // 离机锚点（AD5，ADR-0055）
  'scripts/offbox-anchor.mjs',
  'scripts/lib/offbox-anchor.mjs',
  'tests/offbox-anchor.test.mjs',
  'scripts/lib/audit-chain-cli.mjs',
  'tests/audit-chain.test.mjs',
  'server/lib/logger.js',
  'server/lib/profile.js',
  'server/lib/db-ttl-cache.js',
  'server/lib/trust-proxy.js',
  'server/lib/process-counters.js',
  'server/lib/metrics-export.js',
  'server/lib/redact.js',
  'server/middleware/audit.js',
  'server/middleware/security-headers.js',
  'server/middleware/session-transport.js',
  'server/version.js',
  'server/mcp/catalog.js',
  'server/mcp/delegation.js',
  'server/mcp/doc-perms.js',
  'server/mcp/tokens.js',
  'server/db/migrations/053_agent_token_owner_version.cjs',
  'server/lib/outbound-url.js',
  'server/lib/secret-box.js',
  'server/lib/backup-crypto.js',
  'scripts/check-mcp-coverage.mjs',
  'scripts/gen-sbom.mjs',
  'scripts/sbom-diff.mjs',
  'scripts/lib/sbom-diff.mjs',
  'tests/sbom-diff.test.mjs',
  'scripts/release-candidate.mjs',
  'scripts/evidence-log-ingest.mjs',
  'tests/evidence-log-ingest.test.mjs',
  'scripts/release-keygen.mjs',
  'scripts/lib/evidence-sign.mjs',
  'scripts/gen-changelog.mjs',
  'scripts/gen-codemap.mjs',
  'scripts/lib/runtime-closure.mjs',
  'scripts/gen-third-party-notices.mjs',
  'scripts/check-file-header.mjs',
  'scripts/check-audit-allowlist.mjs',
  'scripts/check-metrics-scope.mjs',
  'tests/audit-allowlist.test.mjs',
  'scripts/check-lock-registry.mjs',
  'scripts/check-install-registry.mjs',
  'scripts/lib/zip-safe.mjs',
  'tests/check-install-registry.test.mjs',
  'tests/zip-safe.test.mjs',
  'tests/check-lock-registry.test.mjs',
  'tests/dependency-review-policy.test.mjs',
  'tests/release-candidate-policy.test.mjs',
  'scripts/db-backup.mjs',
  // 文件系统写入序列的故障注入点（AD6）
  'scripts/lib/fs-fault.mjs',
  'tests/fs-fault.test.mjs',
  // 数据保留与个人信息处理（ADR-0030）
  'scripts/retention.mjs',
  'scripts/privacy-export.mjs',
  'scripts/privacy-erase.mjs',
  'scripts/lib/privacy-common.mjs',
  'server/db/migrations/runner.js',
  'server/lib/backup-dir.js',
  // 恢复 / 升级回退演练（ADR-0016）：共用底座 + 两个演练入口
  'scripts/lib/drill-common.mjs',
  'scripts/db-restore-drill.mjs',
  'scripts/upgrade-rollback-drill.mjs',
  // 迁移升级演练（AA11）：逐迁移耗时 + 写锁探针 + 失败回退
  'scripts/upgrade-rehearsal.mjs',
  'scripts/lib/lock-probe.mjs',
  'tests/upgrade-rehearsal.test.mjs',
  // 审计 FTS 维护（AC5）
  'scripts/audit-fts-maintain.mjs',
  'tests/audit-fts-maintain.test.mjs',
  // 审计写入 vs FTS 开关压测（AG4）
  'scripts/bench-audit-toggle-under-write.mjs',
  'scripts/lib/audit-toggle-writer.mjs',
  // 旧结构快照备份集（AB5 / ADR-0048）
  'scripts/schema-snapshot.mjs',
  'tests/schema-snapshot.test.mjs',
  'src/App.tsx',
  'src/api/client.ts',
  'src/components/Layout.tsx',
  'src/constants/brand.ts',
  'src/constants/capabilities.ts',
  'src/pages/system/McpCenter.tsx',
  'src/pages/system/MyScope.tsx',
  'tests/my-scope.test.mjs',
  'tailwind.config.js',
  // 授信释放台账（ADR-0013）：释放/逆向的唯一实现、建表迁移与守卫测试
  'server/lib/credit-release.js',
  'server/db/migrations/052_credit_release_ledger.cjs',
  'tests/credit-reversal.test.mjs',
  'tests/release-candidate.test.mjs',
  'tests/release-signing.test.mjs',
  'tests/credit-effect-format.test.mjs',
  'src/utils/credit-effect.ts',
  // 前端 403 / 空范围 / 功能关闭提示（W3）
  'src/utils/scope-notice.ts',
  'src/components/ScopeNotice.tsx',
  'tests/scope-notice.test.mjs',
  // 奇门网关凭据（ADR-0033）
  'server/lib/qimen-auth.js',
  'server/db/migrations/060_qimen_secrets.cjs',
  'src/utils/qimen-sign.ts',
  'tests/qimen-auth.test.mjs',
  'tests/security-headers.test.mjs',
  // 授信投影（ADR-0014）：credit_hold 的唯一写入者与对账守卫
  'tests/credit-hold-projection.test.mjs',
  // 待办范围与 Agent Token 有效状态（ADR-0015）
  'server/db/migrations/055_agent_token_revoke_reason.cjs',
  'server/db/migrations/059_indexes.cjs',
  'server/db/migrations/061_hot_query_indexes.cjs',
  'tests/hot-queries.test.mjs',
  'scripts/explain-audit.mjs',
  'scripts/lib/explain-large.mjs',
  // 查询计划指纹快照与统计语句源码扫描（AG3，ADR-0044 补充 6）
  'scripts/lib/explain-plan-guard.mjs',
  'scripts/lib/analyze-scan.mjs',
  'tests/explain-plan-guard.test.mjs',
  // 大库规模演练（Y10）
  'scripts/synth-data.mjs',
  'scripts/synth-pipeline.mjs',
  'scripts/lib/safe-path.mjs',
  'scripts/lib/source-identity.mjs',
  'tests/synth-data.test.mjs',
  'tests/authz-followups.test.mjs',
  // 采购链读接口范围收口（ADR-0017）
  'tests/purchase-chain-scope.test.mjs',
  'tests/purchase-chain-detail-scope.test.mjs',
  // 审批域组织范围（ADR-0037）
  'tests/approval-scope.test.mjs',
  'tests/purchase-action-scope.test.mjs',
  'tests/inventory-scope.test.mjs',
  // 杂项授权缺口收口（ADR-0028）
  'tests/authz-misc.test.mjs',
  // 订货中心组织范围（ADR-0027）
  'tests/order-center-scope.test.mjs',
  // 销售域组织范围收口（ADR-0026）
  'tests/sales-scope.test.mjs',
  // 单据流读接口按账号数据范围过滤（ADR-0032）
  'tests/docflow-scope.test.mjs',
  // OMS 读接口与 MCP 单据历史按组织范围收口（ADR-0039）
  'tests/oms-scope.test.mjs',
  'server/lib/doc-scope-registry.js',
  // 脚本数据目录卫生与单实例安装验收（ADR-0019）
  'scripts/check-data-paths.mjs',
  'scripts/check-route-authz.mjs',
  'scripts/upstream-similarity.mjs',
  'tests/upstream-provenance.test.mjs',
  'tests/route-authz-guard.test.mjs',
  'scripts/db-inventory.mjs',
  'scripts/local-manage.mjs',
  'tests/data-path-guard.test.mjs',
  'tests/local-instance.test.mjs',
  // 收付款证据与二人复核（ADR-0018）
  'server/lib/funds-review.js',
  'server/db/migrations/056_funds_maker_checker.cjs',
  'tests/funds-maker-checker.test.mjs',
  // 付款释放台账（ADR-0024）
  'server/db/migrations/057_payment_release_ledger.cjs',
  'tests/payment-reversal.test.mjs',
  // 门店 POS 路由授权（ADR-0025）
  'server/db/migrations/058_pos_permissions.cjs',
  'tests/pos-authz.test.mjs',
  // POS 前端按权限显示（Y5）
  'src/utils/pos-actions.ts',
  'src/pages/pos/usePosPermissions.ts',
  'tests/pos-actions.test.mjs',
  // 写路径并发与 SQLITE_BUSY 治理（ADR-0035）
  'server/lib/tx.js',
  'scripts/lib/bench-contender.mjs',
  'tests/write-contention.test.mjs',
  'tests/fixtures/write-contention-worker.mjs',
  // OMS /stats 与 AI 平台分析的 order_time 区间谓词（AE3，ADR-0044 补充 4）
  'server/lib/oms-sql.js',
  'tests/oms-sql.test.mjs'
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
