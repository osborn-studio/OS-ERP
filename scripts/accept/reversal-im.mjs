#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/accept/reversal-im.mjs ｜ 独立验收：批次 T 反例先红后证 —— 每一组：注入 → **红** → 还原 → **绿**。
 * ============================================================================
 * 【职责】独立验收：批次 T 反例先红后证 —— 每一组：注入 → **红** → 还原 → **绿**。
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
 * 批次 T 反例先红后证 —— 每一组：注入 → **红** → 还原 → **绿**。
 *
 * 为什么反例要成组跑：
 *   "加了断言"与"断言抓得到东西"是两回事。只有把被测的那条闸门拆掉之后看到它变红，
 *   才知道那条断言守的是这件事；否则它只是"一条恰好通过的断言"。
 *
 * 每一组改的是**一条**判据，跑的是 `scripts/test-im-sync.mjs`（里面已经写好断言）。
 * 判据是失败数：注入后必须 > 0，还原后必须 = 0。
 *
 * 用法：node scripts/accept/reversal-im.mjs
 *   （无参数；行业用环境变量 REV_INDUSTRY。口径「丁」：**不认识的参数一律拒绝** —— 打用法 + 退 2。
 *     本脚本会 patch 工作区 `server/lib/im-sync.js` 与迁移文件，所以闸门必须在任何写动作之前。）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ---------------------------------------------------------------------------
// 参数（口径「丁」）：**不认识的参数一律拒绝** —— 打用法 + 非 0 退出，绝不静默忽略。
// 本脚本**不接受任何命令行参数**（换行业用环境变量 REV_INDUSTRY —— 那是环境不是参数）。
// 为什么必须显式拒绝：有人给它传个 `--dry` 以为"只解析、不跑"，实际它会**真的往工作区
// `server/lib/im-sync.js` 与迁移文件打补丁、跑四组注入、写证据 JSON**。静默忽略一个
// 无意义的动作，与本批缺陷 186（`qty:-5` 静默成功）同一族。
// ⚠️ 闸门必须放在**最前面**：本脚本靠 exit 钩子还原被补丁的源码，所以"拒绝"要发生在
//    任何写动作之前 —— 否则拒掉之前工作区已经被改过了（先改再拒 = 拒了个寂寞）。
//    **判据（可复算）**：跑 `--nonsense` ⇒ 退出码 2，且**被补丁的两份源文件 sha256 逐字节未变**
//    （`server/lib/im-sync.js` 02e7e8fd… / `server/db/migrations/040_im_sync.cjs` c7836d64…）、
//    `docs/evidence/批次T_反例先红后证_4组.json` 未被新写、`/tmp` 副本残留 0 份。
// ---------------------------------------------------------------------------
const USAGE = [
  '用法: node scripts/accept/reversal-im.mjs',
  '  （无参数。行业用环境变量换：REV_INDUSTRY=food node scripts/accept/reversal-im.mjs）'
].join('\n')
// 顺序与家族里其余脚本一致：**非法参数优先于 `--help`**（`--help --nonsense` 也得退 2）。
// `--help` 是裸开关 ⇒ 只有整字相符才算（`--help=1` 一样被拒）。
const KNOWN_FLAGS = ['--help']
const badArgs = process.argv.slice(2).filter((a) => !KNOWN_FLAGS.includes(a))
if (badArgs.length) {
  console.error(`不认识的参数：${badArgs.join(' ')}`)
  console.error(USAGE)
  process.exit(2)
}
if (process.argv.includes('--help')) { console.log(USAGE); process.exit(0) }

const LIB = path.join(ROOT, 'server/lib/im-sync.js')
const MIG = path.join(ROOT, 'server/db/migrations/040_im_sync.cjs')
const ORIG_LIB = readFileSync(LIB, 'utf8')
const ORIG_MIG = readFileSync(MIG, 'utf8')
const INDUSTRY = process.env.REV_INDUSTRY || 'cosmetic'

const restore = () => { writeFileSync(LIB, ORIG_LIB); writeFileSync(MIG, ORIG_MIG) }
process.on('exit', restore)
process.on('SIGINT', () => { restore(); process.exit(3) })

function runTest() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-im-sync.mjs'), INDUSTRY], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  })
  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\u001b\[[0-9;]*m/g, '')
  const m = out.match(/通过 (\d+) \/ 失败 (\d+)/)
  const names = out.split('\n').filter((l) => l.includes('✗')).map((l) => l.replace(/^\s*✗\s*/, '').slice(0, 70))
  return { passed: m ? Number(m[1]) : -1, failed: m ? Number(m[2]) : -1, names, crashed: !m, tail: out.split('\n').slice(-8).join(' | ') }
}

const GROUPS = [
  {
    id: 'A',
    title: '拆掉「只在完整快照下做缺失判定」这道闸门',
    file: LIB,
    from: '  if (snap.complete) {',
    to: '  if (true) {',
    expect: '不完整快照也会把不在列表里的人标记为 missing（真实世界里的表现：一次网络抖动 = 全公司离职）'
  },
  {
    id: 'B',
    title: '去掉「外部审批人未映射到本地用户就不签字」这道闸门',
    file: LIB,
    from: '    if (!who || !who.gml_user_id) {',
    to: '    if (false) {',
    expect: '拿一个不存在的本地用户 id 去决策 —— 审批记录里会出现一个从没点过同意的人'
  },
  {
    id: 'C',
    title: '映射不再记「来自哪一次同步」（sync_batch 写空）',
    file: LIB,
    from: '  const batch = `${platform}-org-${runId}`',
    to: '  const batch = null',
    expect: '事后看见一行映射，答不出谁写的、该不该删（探针 ② 同时要能抓到"批次为空"）'
  },
  {
    id: 'D',
    title: '冲突码不再校验是否在封闭字典内',
    file: LIB,
    from: '    .filter((c) => !CONFLICT_CODE_LIST.includes(c))',
    to: '    .filter(() => false)',
    expect: '绕过唯一写入点写进一个字典外的码，探针一声不吭 —— 冲突码从此失去约束力'
  }
]

console.log(`批次 T 反例先红后证（${INDUSTRY}）\n${'─'.repeat(72)}`)
const baseline = runTest()
console.log(`基线（未注入）：通过 ${baseline.passed} / 失败 ${baseline.failed}`)

const rows = []
for (const g of GROUPS) {
  const target = g.file
  const orig = readFileSync(target, 'utf8')
  if (!orig.includes(g.from)) {
    console.log(`\n[${g.id}] 锚点找不到，跳过：${g.from.slice(0, 50)}`)
    rows.push({ id: g.id, anchorMissing: true })
    continue
  }
  console.log(`\n[${g.id}] ${g.title}`)
  console.log(`  拆掉的是：${g.expect}`)
  writeFileSync(target, orig.replace(g.from, g.to))
  const red = runTest()
  writeFileSync(target, orig)
  const back = runTest()
  console.log(`  注入后：通过 ${red.passed} / 失败 ${red.failed}${red.crashed ? '（崩了：' + red.tail + '）' : ''}`)
  for (const n of red.names.slice(0, 6)) console.log(`      ✗ ${n}`)
  console.log(`  还原后：通过 ${back.passed} / 失败 ${back.failed}${back.failed === 0 ? ' ✅ 回绿' : ' ❌ 没回绿（注入不干净）'}`)
  rows.push({
    id: g.id, title: g.title, expect: g.expect,
    red_failed: red.failed, red_crashed: red.crashed, red_names: red.names,
    restored_failed: back.failed, restored_passed: back.passed
  })
}

console.log(`\n${'─'.repeat(72)}`)
console.log('汇总：')
let allOk = true
for (const r of rows) {
  if (r.anchorMissing) { console.log(`  ${r.id}  锚点缺失 ⚠️`); allOk = false; continue }
  const okRed = r.red_failed > 0 || r.red_crashed
  const okGreen = r.restored_failed === 0
  if (!okRed || !okGreen) allOk = false
  console.log(`  ${r.id}  注入后失败 ${r.red_failed}${r.red_crashed ? '（崩）' : ''} / 可读红 ${r.red_names.length} 条 / 还原后失败 ${r.restored_failed}  ${okRed && okGreen ? '✅' : '❌'}`)
}
console.log(allOk ? '\n全部反例：先红后绿，零污染' : '\n有反例未达标准（见上）')

const evDir = path.join(ROOT, 'docs/evidence')
mkdirSync(evDir, { recursive: true })
writeFileSync(path.join(evDir, '批次T_反例先红后证_4组.json'), JSON.stringify({
  kind: 'reversal-before-after', batch: 'T · IM 组织与审批同步', industry: INDUSTRY,
  at: new Date().toISOString(), baseline, groups: rows, all_red_then_green: allOk
}, null, 2))
console.log(`证据：docs/evidence/批次T_反例先红后证_4组.json`)
process.exit(allOk ? 0 : 1)
