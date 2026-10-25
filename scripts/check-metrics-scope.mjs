#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-metrics-scope.mjs ｜ 静态守卫：指标字典的「范围语义」覆盖率（ADR-0057 补充 2 / AG2）
 * ============================================================================
 * 【职责】指标字典里**每一条**指标都必须显式回答"受限范围的调用者看到的是不是自己范围内的数"：
 *     · `scopeAware: true`            —— 按调用者范围计算（谓词复用对应路由的同一份）；
 *     · `scopeless: { category, reason, backlog? }` —— 没有可套的组织归属（AH2 起为可机读对象，自由文本字符串不再接受）：
         category ∈ `global_by_nature`（口径天然是全公司的）/ `no_org_column`（业务上有归属，但表里没有可用的组织列）/ `pending`（可以接入、尚未做）；
         reason ≥ 20 字；`pending` 必须带 `backlog`（`docs/…` 路径锚点或 http(s) 链接）；
 *   二者必须**恰有其一**。未声明 / 理由过短 / 两者并存 / `scopeAware` 不是严格的 `true`，一律红（退出 1）。
 *
 * 【为什么】AF2 之前，"新加的指标默认是全局口径"是靠约定：新指标忘了接范围，既不报错、也不会在测试里露出来，
 *   只会在某天受限账号拿到全公司数时才被发现。运行时的可见性规则（`metricVisibility` / `metricScopedFlags`）
 *   读的是同一个判据 `isScopeAware(m)`（`m.scopeAware === true`），本守卫也读它，所以"守卫绿"与"运行时按范围"不会分叉。
 *
 * 【不查什么】不查谓词本身对不对（那是 `tests/metrics-perms.test.mjs` 的受限范围用例）；不查前端文案。
 *
 * 【AH2 新增】
 *   · `--report`：只列 scopeless 指标（key / 分类 / 模块 / 权限点 / backlog / 理由）与按分类汇总；`--report --json` 输出同内容 JSON。
 *   · pending 预警：`pending` 数量超过阈值（默认 DEFAULT_MAX_PENDING；`--max-pending N` 或环境变量 METRICS_MAX_PENDING 覆盖）时只告警不失败 ——
 *     CI（GITHUB_ACTIONS / CI）上输出 `::warning ::` 注解，本机输出 `warning:` 行；退出码不受影响。
 *
 * 【用法】node scripts/check-metrics-scope.mjs [--list | --report [--json]] [--max-pending N]
 *   默认：打印分类表；有问题的指标逐条列出，退出 1；全绿退出 0。
 *   --list：打印当前分类（`key  scopeAware|scopeless|UNDECLARED  [分类] 理由`），问题仍使退出码为 1。
 *   不打开任何数据库，不读 `data/`。
 * ============================================================================
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { METRICS, isScopeAware } from '../server/lib/metrics.js'

const SELF = fileURLToPath(import.meta.url)
export const MIN_REASON = 20
export const SCOPELESS_CATEGORIES = ['global_by_nature', 'no_org_column', 'pending']
/** pending 超过这个数只告警（不红）。当前字典里 pending 为 0，阈值给后续新增留一点余量。 */
export const DEFAULT_MAX_PENDING = 2
const BACKLOG_LINK = /^(docs\/\S+|https?:\/\/\S+)$/

/** 分类 + 问题。纯函数，供测试喂入伪造的字典。 */
export function classifyMetrics(metrics) {
  const rows = []
  const problems = []
  for (const m of metrics) {
    const aware = isScopeAware(m)
    const has = m.scopeless !== undefined
    let cls = 'UNDECLARED'
    let issue = null
    let category = null
    let reason = ''
    let backlog = ''
    if (aware && has) { cls = 'INVALID'; issue = '同时声明了 scopeAware 与 scopeless' }
    else if (aware) cls = 'scopeAware'
    else if (m.scopeAware !== undefined) { cls = 'INVALID'; issue = `scopeAware 必须是严格的 true（现为 ${JSON.stringify(m.scopeAware)}）；无范围语义请改写 scopeless 声明` }
    else if (!has) issue = '既没有 scopeAware: true 也没有 scopeless 声明'
    else {
      const s = m.scopeless
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        cls = 'INVALID'
        issue = `scopeless 必须是 { category, reason, backlog? } 对象（自由文本字符串不再接受）；category ∈ ${SCOPELESS_CATEGORIES.join(' / ')}`
      } else {
        category = typeof s.category === 'string' ? s.category : null
        reason = typeof s.reason === 'string' ? s.reason.trim() : ''
        backlog = typeof s.backlog === 'string' ? s.backlog.trim() : ''
        if (!SCOPELESS_CATEGORIES.includes(category)) { cls = 'INVALID'; issue = `scopeless.category 必须是 ${SCOPELESS_CATEGORIES.join(' / ')} 之一（现为 ${JSON.stringify(s.category)}）` }
        else if (reason.length < MIN_REASON) { cls = 'INVALID'; issue = `scopeless 理由不足 ${MIN_REASON} 字（现 ${reason.length}）` }
        else if (category === 'pending' && !BACKLOG_LINK.test(backlog)) { cls = 'INVALID'; issue = 'pending 必须带 backlog 链接（docs/… 路径锚点或 http(s) URL）' }
        else if (backlog && !BACKLOG_LINK.test(backlog)) { cls = 'INVALID'; issue = `backlog 不是链接：${JSON.stringify(backlog)}` }
        else cls = 'scopeless'
      }
    }
    const ok = cls === 'scopeless'
    rows.push({
      key: m.key, cls, module: m.module ?? '', perms: Array.isArray(m.perms) ? m.perms : [],
      category: ok ? category : null, reason: ok ? reason : '', backlog: ok ? backlog : ''
    })
    if (issue) problems.push({ key: m.key, issue })
  }
  return { rows, problems }
}

/** pending 预警文本；未超阈值返回 null。`ci` 缺省读环境（GITHUB_ACTIONS / CI）。只告警，调用方不得据此改退出码。 */
export function pendingWarning(pending, max = DEFAULT_MAX_PENDING, { ci = !!(process.env.GITHUB_ACTIONS || process.env.CI) } = {}) {
  if (!(pending > max)) return null
  const msg = `${pending} 条指标仍是 scopeless:pending（阈值 ${max}）——请逐条接入范围语义或改判分类，见各自 backlog 链接`
  return ci ? `::warning title=metrics-scope pending::${msg}` : `warning: ${msg}`
}

/** --report / --json 的数据：只含 scopeless 指标与按分类的汇总。 */
export function buildReport(rows, max = DEFAULT_MAX_PENDING) {
  const scopeless = rows.filter((r) => r.cls === 'scopeless')
  const by_category = Object.fromEntries(SCOPELESS_CATEGORIES.map((c) => [c, scopeless.filter((r) => r.category === c).length]))
  return {
    total: rows.length,
    scope_aware: rows.filter((r) => r.cls === 'scopeAware').length,
    pending: by_category.pending,
    max_pending: max,
    by_category,
    scopeless: scopeless.map(({ key, module, category, perms, backlog, reason }) => ({ key, module, category, perms, backlog, reason }))
  }
}

function parseArgs(argv) {
  const o = { list: false, report: false, json: false, max: Number(process.env.METRICS_MAX_PENDING ?? DEFAULT_MAX_PENDING), bad: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--list') o.list = true
    else if (a === '--report') o.report = true
    else if (a === '--json') o.json = true
    else if (a === '--max-pending') o.max = Number(argv[++i])
    else o.bad = true
  }
  if (!Number.isInteger(o.max) || o.max < 0) o.bad = true
  if (o.json && !o.report) o.bad = true
  return o
}

/**
 * 把分类结果渲染成 stdout / stderr 文本。`--report --json` 时 stdout 必须是**纯 JSON**，所以 pending 预警改走 stderr
 * （CI 的 `::warning ::` 注解 runner 同样会解析 stderr）；其余模式预警跟在表后面走 stdout。纯函数，供测试喂伪造字典。
 */
export function renderOutput(rows, rep, o, problemCount = 0) {
  const lines = []
  if (o.report && o.json) {
    lines.push(JSON.stringify(rep, null, 2))
  } else if (o.report) {
    const w = Math.max(3, ...rep.scopeless.map((r) => r.key.length))
    for (const r of rep.scopeless) {
      lines.push(`${r.key.padEnd(w)}  ${r.category.padEnd(16)}${r.module}  perms=${r.perms.join('|')}${r.backlog ? `  backlog=${r.backlog}` : ''}`)
      lines.push(`${' '.repeat(w)}  ${r.reason}`)
    }
    lines.push(`\n共 ${rep.total} 条指标：scopeAware ${rep.scope_aware}，scopeless ${rep.scopeless.length}（` +
      SCOPELESS_CATEGORIES.map((c) => `${c} ${rep.by_category[c]}`).join('，') + '）')
  } else {
    const w = Math.max(...rows.map((r) => r.key.length))
    for (const r of rows) lines.push(`${r.key.padEnd(w)}  ${r.cls.padEnd(10)}${r.category ? `  [${r.category}]` : ''}${r.reason ? `  ${r.reason}` : ''}`)
    const less = rows.filter((r) => r.cls === 'scopeless').length
    lines.push(`\n共 ${rows.length} 条指标：scopeAware ${rep.scope_aware}，scopeless ${less}，问题 ${problemCount}`)
  }
  const warn = pendingWarning(rep.pending, o.max, { ci: o.ci })
  if (warn && o.json) return { out: lines.join('\n'), err: warn }
  if (warn) lines.push(warn)
  return { out: lines.join('\n'), err: '' }
}

function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.bad) {
    console.error('用法：node scripts/check-metrics-scope.mjs [--list | --report [--json]] [--max-pending N]')
    process.exitCode = 2
    return
  }
  const { rows, problems } = classifyMetrics(METRICS)
  const rep = buildReport(rows, o.max)
  const { out, err } = renderOutput(rows, rep, { ...o, ci: !!(process.env.GITHUB_ACTIONS || process.env.CI) }, problems.length)
  if (out) console.log(out)
  if (err) console.error(err)
  for (const p of problems) console.error(`✗ ${p.key}: ${p.issue}`)
  // 不用 process.exit()：stdout 接管道时写入是异步的；pending 预警不影响退出码
  process.exitCode = problems.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main()
