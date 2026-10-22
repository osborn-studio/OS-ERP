/**
 * ============================================================================
 * 文件标识：server/db/seed-clock.js ｜ 灌数时钟（seed 专用，共享给 seed.js 与各 *-seed.js 卫星灌数步骤）。
 * ============================================================================
 * 【职责】灌数时钟（seed 专用，共享给 seed.js 与各 *-seed.js 卫星灌数步骤）。
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 灌数时钟（seed 专用，共享给 seed.js 与各 *-seed.js 卫星灌数步骤）。
//
// 为什么需要它，而不是各文件各自 `new Date()`：
//   ① 正确性 —— 一次整库重建要跑十几秒。如果正好跨零点（凌晨重建时真实发生过），
//      前半段写入的「今天」和后半段写入的「今天」不是同一天，派生数据会自相矛盾：
//      期初业务日期落在昨天、而期间快照落在今天，成本期间闸门会把刚写好的流水挡在外面。
//   ② 可复现 —— 两次重建的时间差会渗进 created_at / order_time / sync_at / *_date，
//      于是「同一份 seed + 同一份数据集」得不到同一张库。测试按具体单据写断言时就会
//      随机失败，且失败点在几个用例之间游走，排查成本极高（批次 C 收尾踩过）。
//
// 用法：整库重建开始时调用一次 resetSeedClock()，之后**所有**取当前时间的地方一律用 seedNow()。
// 需要严格逐字节复现时（如 CI 比对两次重建），用环境变量显式指定起点：
//   GML_SEED_NOW=2026-10-15T10:00:00 node scripts/reseed-all.mjs --force
//
// 注意：运行时（收货建批次、接口里写 created_at）**不要**用这个模块 ——
// 那里需要真实的墙上时间，冻结时钟只属于灌数过程。
//
// 库存引擎（lib/stock.js）里的 biz_time / updated_at 也走同一份时钟：
// 本模块在加载时把它的「现在」提供者接过来，灌完由 endSeedClock() 交还真实时间。
// 这样「整库重建 → 逐表逐字节一致」才成立（库存流水是最后一处对不上的表）。
import { setStockNowProvider } from '../lib/stock.js'

let _seedNow = null
let _frozen = false

/** 重置灌数时钟；传值则冻结到该时刻，不传取当前时刻（或环境变量 GML_SEED_NOW） */
export function resetSeedClock(t) {
  const src = t || process.env.GML_SEED_NOW || null
  _seedNow = src ? new Date(src) : new Date()
  _frozen = true
  return _seedNow
}

/** 灌数结束：交还真实时间。运行时的库存写入不应继续用冻结时钟 */
export function endSeedClock() {
  _seedNow = null
  _frozen = false
}

/** 灌数期间唯一的「现在」；未冻结时就是真实当前时间 */
export function seedNow() {
  return _frozen && _seedNow ? _seedNow : new Date()
}

/** 灌数期间的「现在」文本（YYYY-MM-DD HH:mm:ss），供库存引擎取用 */
export function seedNowText() {
  return seedNow().toISOString().slice(0, 19).replace('T', ' ')
}

/** 把一段灌数流程包在冻结时钟里；无论成败都交还真实时间 */
export function withSeedClock(fn, t) {
  resetSeedClock(t)
  try {
    return fn()
  } finally {
    endSeedClock()
  }
}

// 接管库存引擎的「现在」。未冻结时 seedNowText() 等价于真实时间，运行时行为不变。
setStockNowProvider(() => seedNowText())

export default { resetSeedClock, endSeedClock, seedNow, seedNowText, withSeedClock }
