/**
 * ============================================================================
 * 文件标识：scripts/reseed-all.mjs ｜ 三库重建：按 `INDUSTRIES` 逐个 `--force` 重建（可复现：两次重建逐表 0 差异）
 * ============================================================================
 * 【职责】三库重建：按 `INDUSTRIES` 逐个 `--force` 重建（可复现：两次重建逐表 0 差异）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自手写**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 整库重建（三个行业库一起）：把演示数据从零重灌一遍，顺序与服务启动完全一致。
// 用法：
//   node scripts/reseed-all.mjs            # 只重建空库（等价于服务启动时做的事）
//   node scripts/reseed-all.mjs --force    # 三个库全部强制重建（抹掉手工点出来的单据）
//   node scripts/reseed-all.mjs food --force
//
// 存在的理由：
//   以前「整库重建」只有「起一次服务、且库里是空的」这一条路 ——
//   于是每次改完 schema 或 seed 想验证，都得手工删库文件再重启服务，
//   命令行里没有任何一条命令能一次做完「基础数据 + 派生数据 + 口径字典 + 接入凭据」。
//   少灌一步不会报错，只会留下一库对不上的演示数据（最典型：seedAll 重建了 stores/dealers，
//   而订货中心的客户还指着旧 id），所以这件事必须有单一入口。
//
// 顺序由 server/db/boot.js 定义 —— 这里只负责调用与汇总，不复制任何一步。
import { bootIndustry, bootAll } from '../server/db/boot.js'
import { INDUSTRIES } from '../server/db/index.js'

const args = process.argv.slice(2)
const force = args.includes('--force')
const target = args.find((a) => !a.startsWith('--'))
const codes = target ? [target] : Object.keys(INDUSTRIES)
if (target && !INDUSTRIES[target]) {
  console.error(`未知行业：${target}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
  process.exit(1)
}

const t0 = Date.now()
console.log(`整库重建：${codes.map((c) => INDUSTRIES[c].label).join('、')}${force ? '（强制）' : '（仅空库）'}`)
const results = target
  ? [bootIndustry(target, { force, log: (m) => console.log(`  [${target}] ${m}`) })]
  : bootAll({ force, log: (m) => console.log(`  ${m}`) })

for (const r of results) {
  console.log(`  ${r.label.padEnd(12)} ${r.rebuilt ? '已重建' : '沿用现有数据'}  凭据新增 ${r.tokens}  ${r.dbPath}`)
}
console.log(`完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
