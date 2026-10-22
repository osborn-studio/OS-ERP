/**
 * ============================================================================
 * 文件标识：scripts/inject-mfg-guards.mjs ｜ 闸门注入验证（**显式 opt-in：不随 `regress-all` 跑**）
 * ============================================================================
 * 【职责】闸门注入验证（**显式 opt-in：不随 `regress-all` 跑**）
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
 * 闸门注入验证（**显式 opt-in：不随 `regress-all` 跑**）
 *
 * 为什么 opt-in、为什么不并进 `test-mfg.mjs`：两者职责不同，混在一条命令里两头都做不好 ——
 *   · **每轮回归要问的**是"闸门还在不在" ⇒ `test-mfg.mjs` 第 [8] 节（每跑必红/绿）；
 *   · **改判据时才要问的**是"这些断言到底有没有牙" ⇒ 本脚本（撤掉闸门必须变红）。
 * 而且它一次要 spawn 7 次 test-mfg（约 2 分钟/轮）。它叫 `inject-*` 而不是 `test-*`，
 * `scripts/regress-all.mjs` 的 `^test-.*\.mjs$` 因此抓不到它 —— 这是**有意的**，不是漏网。
 *
 * 它回答的问题是：**`scripts/test-mfg.mjs` 第 [8] 节的那几条反例，真的能红吗？**
 * —— 一个永远绿的断言等于没有这条断言，而"永远绿"恰恰是这类闸门最典型的失效方式
 *    （本项目已经有过：把判据挂在不会执行到的分支里、断言依赖的字段根本没被破坏）。
 *
 * 做法：逐条**撤掉一处闸门**（在副本上），跑 test-mfg，要求**对应的那条断言变红**；
 * 然后把原始字节写回，要求副本文件的 sha256 与仓库里的逐位一致。
 *
 * ⚠️ 两条安全底线（这是它敢进仓库的原因）：
 *   ① **从不写仓库里的源码** —— `server/` 整棵复制到系统临时目录，只改副本里的 `lib/mfg.js`。
 *      即使进程被 Ctrl-C 打断，被污染的也只是临时树，仓库源码一个字节都不动。
 *   ② **不依赖 `GML_DATA_DIR` 也能隔离数据** —— 临时树里 `server/db/index.js` 算出的
 *      `ROOT_DIR` 就是临时目录，所以它连"忘了设 GML_DATA_DIR 就写到 data/"这条路都没有。
 *      但为了跑得起来（要有演示数据），仍要求你显式给一个库目录；
 *      `GML_DATA_DIR` 若指向仓库 `data/` 会直接拒跑（exit 2）。
 *
 * 用法：GML_DATA_DIR=/tmp/fix-mfg-db node scripts/inject-mfg-guards.mjs [industry]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDUSTRY = process.argv[2] || 'cosmetic'
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

if (!process.env.GML_DATA_DIR) {
  console.error('请显式指定隔离库目录：GML_DATA_DIR=/tmp/xxx node scripts/inject-mfg-guards.mjs [industry]')
  process.exit(2)
}

// ---------- 临时树：server/ + scripts/test-mfg.mjs + node_modules 符号链接 ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mfg-inject-'))
fs.cpSync(path.join(ROOT, 'server'), path.join(TMP, 'server'), { recursive: true })
fs.mkdirSync(path.join(TMP, 'scripts'), { recursive: true })
fs.copyFileSync(path.join(ROOT, 'scripts/test-mfg.mjs'), path.join(TMP, 'scripts/test-mfg.mjs'))
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(TMP, 'package.json'))
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(TMP, 'node_modules'), 'dir')

const TMP_MFG = path.join(TMP, 'server/lib/mfg.js')
const original = fs.readFileSync(TMP_MFG)
const repoMfgPath = path.join(ROOT, 'server/lib/mfg.js')
const repoMfgSha0 = sha(fs.readFileSync(repoMfgPath))
const sha0 = sha(original)
// 隔离自证：把「每个进程分别落在哪个库」印出来（这是本项目的纪律：设了 env 不算自证，说得出落点才算）。
//   父进程：只读源码 + spawn，**不 import `server/db/index.js`**，所以它没有库落点。
//   子进程：跑的是**临时树**里的 test-mfg（它自己会打印解析到的绝对路径），库落点由 GML_DATA_DIR 决定。
// 而且临时树里 `server/db/index.js` 算出的 ROOT_DIR 就是临时目录 ⇒ 即使漏设 GML_DATA_DIR，
// 兜底路径也只是 `<临时树>/data`，**碰不到仓库的 data/**（双重保险）。
const DATA_DIR = path.resolve(process.env.GML_DATA_DIR)
const childDb = path.join(DATA_DIR, `gml_${INDUSTRY}.db`)
console.log(`临时树：${TMP}（仓库源码只读，注入只落在这棵临时树里）`)
console.log(`父进程：不碰库（无 db/index.js 依赖）`)
console.log(`子进程：test-mfg（临时树 + GML_DATA_DIR）→ ${childDb}`)
console.log(`仓库 data/ 兜底路径是否可能被子进程命中：${path.join(TMP, 'data')}（不是仓库 data/ ⇒ 不可能）`)
if (childDb.startsWith(path.join(ROOT, 'data') + path.sep)) {
  console.error('✗ GML_DATA_DIR 指到了仓库 data/ 下 —— 这个脚本拒绝在这种配置下运行')
  process.exit(2)
}
console.log(`副本 mfg.js sha256 = ${sha0}\n仓库 mfg.js sha256 = ${repoMfgSha0}\n`)

/** A6 的注入要"只动留痕那一句"：把事务内的 guard + INSERT 摘掉，按修之前的形状在 `tx()` 之后补一段 try/catch。 */
function buildA6(src) {
  const start = src.indexOf('    if (!db.inTransaction) {')
  const end = src.indexOf('  })\n  tx()', start)
  const seg = src.slice(start, end)
  const marker = '    db.prepare(\n      ' + '\x60' + 'INSERT INTO doc_events'
  const p = seg.indexOf(marker)
  if (start < 0 || end < 0 || p < 0) throw new Error('A6 注入锚点找不到（mfg.js 的 issueOut 结构变了？）')
  const insert = seg.slice(p)
  const withoutTrace = src.slice(0, start) + src.slice(end)
  const at = withoutTrace.indexOf('  })\n  tx()', withoutTrace.indexOf('const autoBatched')) + '  })\n  tx()'.length
  const post = '\n\n  try {\n' + insert + '  } catch { /* 注入：留痕失败不影响出库（A6 修之前的形状） */ }'
  return withoutTrace.slice(0, at) + post + withoutTrace.slice(at)
}

const INJECTIONS = [
  { name: 'M1 · 撤掉「没有领料不许完工」', from: 'if (requiredQty > 1e-9) {', to: 'if (false) { /* 注入 */', mustRed: '零领料时完工入库被拒' },
  { name: 'M2 · 撤掉 completeOrder 里的超产复核', from: 'assertNotOverComplete(po, reports.reduce((n, r) => n + (num(r.good_qty) > 0 ? num(r.good_qty) : 0), 0))', to: 'void reports /* 注入 */', mustRed: '完工入库复校累计良品' },
  { name: 'M2 · 撤掉 updateWorkReport 里的复校', from: "assertNotOverComplete(requireOrder(db, wr.order_id), nextGoodQty, '修改后良品数')", to: 'void nextGoodQty /* 注入 */', mustRed: '改汇报放大良品数被拒' },
  { name: 'M3 · 撤掉 issueOut 的限额复校', from: "if (issue.issue_type === 'limit') {", to: 'if (false) { /* 注入 */', mustRed: '第二张限额单出库被拒' },
  { name: 'M11 · 让「超领」变回无条件告警（误报）', from: 'if (over > 1e-9) {', to: 'if (true) { /* 注入 */', mustRed: '0 条超领告警（不误报）' },
  { name: 'M11 · 让「超领」只看限额单（漏报）', from: 'ORDER BY mi.id, mii.id', to: "AND mi.issue_type='limit'\n        ORDER BY mi.id, mii.id", mustRed: '1 条超领告警（不漏报）' },
  { name: 'A6 · 把留痕挪回事务外', kind: 'a6', mustRed: '留痕失败后单据留在 approved' }
]

let bad = 0
for (const inj of INJECTIONS) {
  const src = original.toString('utf8')
  let next
  if (inj.kind === 'a6') next = buildA6(src)
  else {
    if (src.split(inj.from).length - 1 !== 1) { console.log(`✗ 注入点不唯一/找不到，跳过：${inj.name}`); bad += 1; continue }
    next = src.replace(inj.from, inj.to)
  }
  fs.writeFileSync(TMP_MFG, Buffer.from(next, 'utf8'))
  const shaInj = sha(fs.readFileSync(TMP_MFG))

  const r = spawnSync(process.execPath, [path.join(TMP, 'scripts/test-mfg.mjs'), INDUSTRY], {
    encoding: 'utf8', env: process.env
  })
  const out = (r.stdout || '') + (r.stderr || '')
  const finished = out.includes('=== 通过')
  const reds = out.split('\n').filter((l) => l.includes('✗')).map((l) => l.trim())
  const hit = reds.some((l) => l.includes(inj.mustRed))
  const summary = out.split('\n').filter((l) => l.includes('=== 通过')).pop()?.trim()
  // 子进程自证：它打印出来的库落点必须不是仓库的 data/
  const childLine = (out.split('\n').find((l) => l.includes('库文件：')) || '').trim()
  const childSays = childLine.replace(/^库文件：/, '').replace(/（.*$/, '')
  const childOk = !!childSays && !childSays.startsWith(path.join(ROOT, 'data') + path.sep)
  if (inj === INJECTIONS[0]) {
    console.log(`子进程自报落点：${childLine || '（没打印）'} ⇒ 不是仓库 data/：${childOk}`)
    console.log('')
  }

  fs.writeFileSync(TMP_MFG, original)                       // 读进内存 → 写原始字节回
  const shaBack = sha(fs.readFileSync(TMP_MFG))
  const okShot = finished && hit && shaBack === sha0 && childOk
  if (!okShot) bad += 1

  console.log(`${okShot ? '✓' : '✗'} ${inj.name}`)
  console.log(`    注入 sha=${shaInj.slice(0, 12)} → 还原后 sha=${shaBack.slice(0, 12)}（与副本原文一致：${shaBack === sha0}）｜${summary || '（脚本没跑完）'}`)
  console.log(`    变红 ${reds.length} 条：`)
  for (const l of reds) console.log(`      ${l.replace(/^✗\s*/, '')}`)
  if (!hit) console.log(`    ✗ 期望红的那条没红：「${inj.mustRed}」`)
  if (!finished) console.log(`    ✗ 脚本未跑完，尾部：${out.split('\n').slice(-6).join(' | ')}`)
}

// 收尾：临时树里的 mfg.js 必须回到原始字节；仓库里的 mfg.js 必须从头到尾没被写过
const repoMfgSha1 = sha(fs.readFileSync(repoMfgPath))
console.log(`\n仓库 server/lib/mfg.js sha256：${repoMfgSha0} → ${repoMfgSha1}（未被动过：${repoMfgSha0 === repoMfgSha1}）`)
fs.rmSync(TMP, { recursive: true, force: true })
console.log(`临时树已删除：${TMP}`)
if (bad || repoMfgSha0 !== repoMfgSha1) process.exit(1)
