#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/gen-changelog.mjs ｜ 从 docs/implementation/ADR-*.md 生成 CHANGELOG.md（Y9）
 * ============================================================================
 * 【做什么】读取每个 ADR 的标题行与“决定”段首段（原文摘录，去 Markdown 强调符，最长 240 字符），按开发批次分组写入
 *   CHANGELOG.md 中 `<!-- generated -->` 标记之下；标记之上的手写头部原样保留。没有“决定”段的 ADR 只列标题并如实标注。
 * 【诚实边界】这里只转述 ADR 已写下的决定，不推断“已验收/已上线”：ADR 里的状态措辞（“开发实现，尚非生产部署验收”等）
 *   以 ADR 为准；没有 ADR 的工作流（脚本、文档、测试类）不会出现在这里，见 docs/implementation/progress.md。
 * 【批次映射】BATCHES 由 docs/implementation/progress.md 的批次小节与 roadmap-v2/v3/v4 的 ADR 分配得出（ADR 编号区间 →
 *   批次）。编号落在所有区间之外的 ADR 不会被丢弃，而是进入“未归批”分组并让 generate() 返回 unmapped；仓库测试要求 unmapped 为空，
 *   因此新增 ADR 编号超出现有区间时必须同时更新 BATCHES。
 * 【确定性】批次新→旧；批内按 ADR 编号、再按文件名升序；无时间戳、无绝对路径、无随机；两次运行逐字节一致。
 * 【用法】node scripts/gen-changelog.mjs           写入 CHANGELOG.md
 *         node scripts/gen-changelog.mjs --check   与仓库文件比对，漂移则退出 1（CI）
 *         --root=<dir> 指定仓库根（测试用）
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MARKER = '<!-- generated -->'
const MAX_DECISION = 240

/** ADR 编号区间 → 批次。来源：progress.md 各批次小节；第八批为 roadmap-v4 的分配（进行中）。 */
export const BATCHES = [
  { id: 1, title: '第一批：生产/演示隔离与首个管理员', from: 1, to: 3 },
  { id: 2, title: '第二批：后台会话、登录节流与权限迁移', from: 4, to: 7 },
  { id: 3, title: '第三批：通知、备份、审计、MCP 委托与容器/版本契约', from: 8, to: 13 },
  { id: 4, title: '第四批：授信投影、待办范围与恢复演练', from: 14, to: 16 },
  { id: 5, title: '第五批：采购链范围、人工资金复核与脚本数据目录', from: 17, to: 19 },
  { id: 6, title: '第六批：详情范围、路由守卫、备份加密、日志与付款台账', from: 20, to: 24 },
  { id: 7, title: '第七批：POS/销售/订货中心范围、运维健康与个人信息', from: 25, to: 30 },
  { id: 8, title: '第八批（进行中）：见 roadmap-v4', from: 31, to: 37 },
  { id: 9, title: '第九批：见 roadmap-v5', from: 38, to: 40 },
  { id: 10, title: '第十批：见 roadmap-v6', from: 41, to: 45 },
  { id: 11, title: '第十一批（进行中）：见 roadmap-v7', from: 46, to: 49 },
  { id: 12, title: '第十二批（进行中）：见 roadmap-v8', from: 50, to: 64 }
]
const UNMAPPED_TITLE = '未归批（ADR 编号超出 BATCHES 区间，需要更新 scripts/gen-changelog.mjs）'

const DEFAULT_HEAD = `# 变更记录

本文件的“按批次”部分由 \`node scripts/gen-changelog.mjs\` 从 \`docs/implementation/ADR-*.md\` 生成，CI 校验不漂移；标记行之上是手写说明。

- 当前版本号以 \`package.json\` 为准（预发布 alpha），不是可用于生产或商用交付的声明：验收状态、未关闭事项与验证边界以 [整改跟踪](docs/implementation/backlog.md) 和 [开发进度](docs/implementation/progress.md) 为准。
- 这里只转述各 ADR 写下的决定，不代表已在目标主机上验收；没有 ADR 的工作（脚本、文档、测试）见开发进度。
- 批次划分来自开发进度；同一 ADR 后续的修订可能在原文件内更新。
`

export const batchOf = n => BATCHES.find(b => n >= b.from && n <= b.to) ?? null

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const plain = s => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()

/** “决定”段首段（原文）；没有该标题或该节内没有正文 ⇒ null。 */
export function extractDecision(md) { return decisionSection(md)?.text ?? null }

/** → { text, heading } ；heading 是被摘录的节标题（如“问题与决定”，首段可能是问题陈述，输出时会标明出处）。 */
export function decisionSection(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  let level = 0
  let heading = ''
  let i = lines.findIndex(l => {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(l)
    if (m && /(决定|决策|Decision)/i.test(m[2])) { level = m[1].length; heading = plain(m[2]); return true }
    return false
  })
  if (i < 0) return null
  const para = []
  for (i += 1; i < lines.length; i++) {
    const line = lines[i]
    const h = /^(#{1,6})\s/.exec(line)
    if (h) {
      if (h[1].length <= level) break // 到了同级或更高级标题：本节结束
      if (para.length) break
      continue // 子标题：跳过，继续找正文
    }
    if (/^\s*$/.test(line)) { if (para.length) break; continue }
    if (/^\s*(\||```)/.test(line)) { if (para.length) break; continue }
    para.push(line.trim())
  }
  if (!para.length) return null
  const text = plain(para.join(' ').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')).replace(/[:：]$/, '')
  const chars = [...text]
  return { heading, text: chars.length > MAX_DECISION ? chars.slice(0, MAX_DECISION).join('') + '…' : text }
}

/** 节标题含“问题”时，首段可能是问题陈述而不是结论：如实标明出处，不把它说成“决定”。 */
function describe(section) {
  if (!section) return '（ADR 未写出“决定”段，仅列标题）'
  return /问题/.test(section.heading) ? `${section.text}（摘自“${section.heading}”节首段）` : section.text
}

export function generate({ root }) {
  const dir = path.join(root, 'docs/implementation')
  const files = fs.readdirSync(dir).filter(f => /^ADR-\d{4}-.+\.md$/.test(f))
  const adrs = files.map(file => {
    const md = fs.readFileSync(path.join(dir, file), 'utf8')
    const number = Number(file.slice(4, 8))
    const heading = /^#\s+(.+?)\s*$/m.exec(md)
    return { file, number, title: heading ? plain(heading[1]) : file, section: decisionSection(md) }
  }).sort((a, b) => a.number - b.number || cmp(a.file, b.file))

  const groups = BATCHES.map(b => ({ ...b, items: [] })).sort((a, b) => b.id - a.id)
  const stray = { id: 0, title: UNMAPPED_TITLE, items: [] }
  for (const a of adrs) (batchOf(a.number) ? groups.find(g => g.id === batchOf(a.number).id) : stray).items.push(a)
  if (stray.items.length) groups.unshift(stray)

  const body = groups.filter(g => g.items.length).map(g => {
    const rows = g.items.map(a => `- [${a.title}](docs/implementation/${a.file}) — ${describe(a.section)}`)
    return `## ${g.title}\n\n${rows.join('\n')}`
  }).join('\n\n')

  const file = path.join(root, 'CHANGELOG.md')
  let head = DEFAULT_HEAD
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n')
    const at = old.indexOf(MARKER)
    head = at >= 0 ? old.slice(0, at) : old
  }
  const text = `${head.trimEnd()}\n\n${MARKER}\n\n${body}\n`
  return { text, count: adrs.length, unmapped: stray.items.map(a => a.file) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootArg = process.argv.find(a => a.startsWith('--root='))
  const root = rootArg ? path.resolve(rootArg.slice(7)) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { text, count, unmapped } = generate({ root })
  const file = path.join(root, 'CHANGELOG.md')
  if (unmapped.length) console.error(`[changelog] ADRs outside BATCHES ranges: ${unmapped.join(', ')}`)
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    if (current !== text) { console.error('CHANGELOG.md is stale; run npm run changelog and commit'); process.exit(1) }
    console.log(`[changelog] CHANGELOG.md is current (${count} ADRs)`)
  } else {
    fs.writeFileSync(file, text)
    console.log(`wrote CHANGELOG.md (${count} ADRs)`)
  }
}
