#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-metrics-scope.mjs ｜ 静态守卫：指标字典的「范围语义」覆盖率（ADR-0057 补充 2 / AG2）
 * ============================================================================
 * 【职责】指标字典里**每一条**指标都必须显式回答"受限范围的调用者看到的是不是自己范围内的数"：
 *     · `scopeAware: true`            —— 按调用者范围计算（谓词复用对应路由的同一份）；
 *     · `scopeless: '<理由，≥ 20 字>'` —— 没有可套的组织归属，理由写明为什么；
 *   二者必须**恰有其一**。未声明 / 理由过短 / 两者并存 / `scopeAware` 不是严格的 `true`，一律红（退出 1）。
 *
 * 【为什么】AF2 之前，"新加的指标默认是全局口径"是靠约定：新指标忘了接范围，既不报错、也不会在测试里露出来，
 *   只会在某天受限账号拿到全公司数时才被发现。运行时的可见性规则（`metricVisibility` / `metricScopedFlags`）
 *   读的是同一个判据 `isScopeAware(m)`（`m.scopeAware === true`），本守卫也读它，所以"守卫绿"与"运行时按范围"不会分叉。
 *
 * 【不查什么】不查谓词本身对不对（那是 `tests/metrics-perms.test.mjs` 的受限范围用例）；不查前端文案。
 *
 * 【用法】node scripts/check-metrics-scope.mjs [--list]
 *   默认：打印分类表；有问题的指标逐条列出，退出 1；全绿退出 0。
 *   --list：只打印当前分类（`key  scopeAware|scopeless|UNDECLARED  理由`），问题仍使退出码为 1。
 *   不打开任何数据库，不读 `data/`。
 * ============================================================================
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { METRICS, isScopeAware } from '../server/lib/metrics.js'

const SELF = fileURLToPath(import.meta.url)
export const MIN_REASON = 20

const reasonOf = (m) => (typeof m.scopeless === 'string' ? m.scopeless.trim() : '')

/** 分类 + 问题。纯函数，供测试喂入伪造的字典。 */
export function classifyMetrics(metrics) {
  const rows = []
  const problems = []
  for (const m of metrics) {
    const aware = isScopeAware(m)
    const has = m.scopeless !== undefined
    const reason = reasonOf(m)
    let cls = 'UNDECLARED'
    let issue = null
    if (aware && has) { cls = 'INVALID'; issue = '同时声明了 scopeAware 与 scopeless' }
    else if (aware) cls = 'scopeAware'
    else if (m.scopeAware !== undefined) { cls = 'INVALID'; issue = `scopeAware 必须是严格的 true（现为 ${JSON.stringify(m.scopeAware)}）；无范围语义请改写 scopeless 理由` }
    else if (!has) issue = '既没有 scopeAware: true 也没有 scopeless 理由'
    else if (reason.length < MIN_REASON) { cls = 'INVALID'; issue = `scopeless 理由不足 ${MIN_REASON} 字（现 ${reason.length}）` }
    else cls = 'scopeless'
    rows.push({ key: m.key, cls, reason: cls === 'scopeless' ? reason : '' })
    if (issue) problems.push({ key: m.key, issue })
  }
  return { rows, problems }
}

function main() {
  const extra = process.argv.slice(2).filter((a) => a !== '--list')
  if (extra.length) {
    console.error('用法：node scripts/check-metrics-scope.mjs [--list]')
    process.exitCode = 2
    return
  }
  const { rows, problems } = classifyMetrics(METRICS)
  const w = Math.max(...rows.map((r) => r.key.length))
  for (const r of rows) console.log(`${r.key.padEnd(w)}  ${r.cls.padEnd(10)}${r.reason ? `  ${r.reason}` : ''}`)
  const aware = rows.filter((r) => r.cls === 'scopeAware').length
  const less = rows.filter((r) => r.cls === 'scopeless').length
  console.log(`\n共 ${rows.length} 条指标：scopeAware ${aware}，scopeless ${less}，问题 ${problems.length}`)
  for (const p of problems) console.error(`✗ ${p.key}: ${p.issue}`)
  // 不用 process.exit()：stdout 接管道时写入是异步的
  process.exitCode = problems.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main()
