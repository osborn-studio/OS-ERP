/**
 * ============================================================================
 * 文件标识：scripts/test-pricing.mjs ｜ 测试：取价引擎测试：验证「不设主维的四维自由组合」靠匹配度打分能否正确工作
 * ============================================================================
 * 【职责】测试：取价引擎测试：验证「不设主维的四维自由组合」靠匹配度打分能否正确工作
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 取价引擎测试：验证「不设主维的四维自由组合」靠匹配度打分能否正确工作
//   node scripts/test-pricing.mjs
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 落点自证：库路径一律从 db/index.js 取（`dbPathFor`），不在这里另写一份 `ROOT/data` ——
// 否则"打印出来的落点"和"真正打开的文件"会分家，脚本就会说谎（比不打印更坏）。
import { DATA_DIR, dbPathFor } from '../server/db/index.js'
import { seedPricing } from '../server/db/pricing-seed.js'
import { resolvePrice, explainPrice, logPriceChange } from '../server/lib/pricing.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ---------- 落点自证：本次运行读写哪个库 ----------
// 本脚本**只跑 cosmetic**（下面的库连接、种子、取价用例全部写死 cosmetic），
// 这一点对"某次运行污染了哪个库"的归因很关键：它**没有** food / apparel 的写入路径。
const DB_PATH = dbPathFor('cosmetic')
console.log(`[落点] 数据目录：${path.resolve(DATA_DIR)}`)
console.log(`[落点] cosmetic ${DB_PATH}   ← 本次读写`)
// 判据（两条，缺一不可）：
//   ① 没设 `GML_DATA_DIR` ⇒ 按定义就是开发库（`DATA_DIR = GML_DATA_DIR || <项目>/data`，
//      见 `server/db/index.js:10`）——这是**主**判据；
//   ② 设了、但指到项目 `data/` 本身。
// ① 必须有：字符串比较在 macOS 上会被 `/tmp → /private/tmp` 这类符号链接骗到
// （实测：副本里本该告警却**没**告警，把判据反过来才告警 —— 拿它当唯一判据是错的）。
if (!process.env.GML_DATA_DIR || path.resolve(DATA_DIR) === path.resolve(path.join(ROOT, 'data'))) {
  console.log('⚠️ 本次将读写开发库 data/ —— 若要隔离请设 GML_DATA_DIR=/tmp/...')
}

let pass = 0, fail = 0
const failed = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  else { fail++; failed.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}  ${detail !== undefined ? '→ ' + detail : ''}`) }
}
const eq = (name, a, b) => ok(name, Math.abs(Number(a) - Number(b)) < 0.011, `实际 ${a} / 期望 ${b}`)
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)

const db = new Database(DB_PATH)
db.pragma('foreign_keys = ON')

section('准备价格组数据')
const seeded = seedPricing(db, { industry: 'cosmetic' })
ok('价格组已就绪', seeded.groups >= 7, `实际 ${seeded.groups}`)

const sku = db.prepare("SELECT id, name, price_retail FROM product_skus WHERE status='active' AND price_retail > 0 LIMIT 1").get()
const base = Number(sku.price_retail)
console.log(`  基准 SKU：#${sku.id} ${sku.name} 零售价 ${base}`)
const P = (q) => resolvePrice(db, { skuId: sku.id, ...q })

// ============================================================
section('T1 单维匹配')
const online = P({ channel: 'online' })
ok('线上渠道命中「线上渠道价」', online.source === 'price_group' && online.groupCode === 'PG_ONLINE', `${online.groupCode} / ${online.source}`)
eq('线上价 = 零售价 × 0.95', online.price, base * 0.95)

const counter = P({ storeType: 'counter' })
ok('专柜命中「专柜价」', counter.groupCode === 'PG_COUNTER', counter.groupCode)
eq('专柜价 = 零售价 × 1.05', counter.price, base * 1.05)

const direct = P({ channel: 'direct' })
ok('直营店命中「直营门店价」', direct.groupCode === 'PG_DIRECT', direct.groupCode)

const franchise = P({ channel: 'franchise' })
ok('加盟店命中「加盟店供货价」', franchise.groupCode === 'PG_FRANCHISE', franchise.groupCode)
eq('加盟供货价 = 零售价 × 0.75', franchise.price, base * 0.75)

// ============================================================
section('T2 多维匹配（不设主维的核心验证）')
const goldEC = P({ channel: 'dealer', dealerLevel: 'gold', region: '华东' })
ok('华东金牌经销商 → 命中 3 维的「华东金牌经销商专价」，而非 2 维的通用金牌价',
  goldEC.groupCode === 'PG_EC_GOLD', `实际命中 ${goldEC.groupCode}`)
eq('华东专价 = 零售价 × 0.58', goldEC.price, base * 0.58)
ok('匹配维度数为 3', goldEC.matchedDimensions === 3, String(goldEC.matchedDimensions))

const goldSC = P({ channel: 'dealer', dealerLevel: 'gold', region: '华南' })
ok('华南金牌经销商 → 回落 2 维的「经销商金牌价」', goldSC.groupCode === 'PG_DEALER_GOLD', goldSC.groupCode)
eq('通用金牌价 = 零售价 × 0.62', goldSC.price, base * 0.62)

const silverEC = P({ channel: 'dealer', dealerLevel: 'silver', region: '华东' })
ok('华东银牌经销商 → 不命中金牌专价（等级不符即排除）', silverEC.groupCode === 'PG_DEALER_SILVER', silverEC.groupCode)
eq('银牌价 = 零售价 × 0.70', silverEC.price, base * 0.70)

// ============================================================
section('T3 取价优先级（第三轮 C2）')
const memberNormal = P({ channel: 'direct', memberLevel: 'normal' })
ok('会员价优先于价格组价', memberNormal.source === 'member', `${memberNormal.source} / ${memberNormal.groupCode || '-'}`)
eq('普通会员价 = 零售价 × 0.95', memberNormal.price, base * 0.95)

const memberGold = P({ channel: 'direct', memberLevel: 'gold' })
ok('金卡会员取到更低一档', memberGold.price < memberNormal.price, `${memberGold.price} vs ${memberNormal.price}`)

const noMatch = P({ channel: 'unknown_channel' })
ok('无任何匹配 → 回落标准零售价', noMatch.source === 'standard', noMatch.source)
eq('标准零售价 = 零售价原值', noMatch.price, base)

// ============================================================
section('T4 阶梯价')
const goldSmall = P({ channel: 'dealer', dealerLevel: 'gold', region: '华南', qty: 10 })
const goldBig = P({ channel: 'dealer', dealerLevel: 'gold', region: '华南', qty: 200 })
eq('小单取首档价', goldSmall.price, base * 0.62)
eq('满 100 件取阶梯价（×0.59）', goldBig.price, base * 0.59)
ok('阶梯价确实更低', goldBig.price < goldSmall.price, `${goldBig.price} < ${goldSmall.price}`)
ok('返回阶梯起订量', goldBig.ladderMinQty === 100, String(goldBig.ladderMinQty))

// ============================================================
section('T5 解释链（界面上要能回答「为什么是这个价」）')
const exp = explainPrice(db, { skuId: sku.id, channel: 'dealer', dealerLevel: 'gold', region: '华东' })
ok('返回可读的解释链', typeof exp.explanation === 'string' && exp.explanation.length > 0, exp.explanation)
ok('解释链点明命中的价格组', exp.explanation.includes('华东金牌经销商专价'), exp.explanation)
console.log(`    → ${exp.explanation}`)

// ============================================================
section('T6 调价留痕')
const before = db.prepare('SELECT COUNT(*) c FROM price_change_logs').get().c
const oldPrice = Number(sku.price_retail)
db.prepare('UPDATE product_skus SET price_retail=? WHERE id=?').run(oldPrice + 1, sku.id)
logPriceChange(db, {
  entity: 'sku', entityId: sku.id, field: 'price_retail',
  oldValue: oldPrice, newValue: oldPrice + 1, reason: '自动化测试', operator: 'tester', source: 'test'
})
const after = db.prepare('SELECT COUNT(*) c FROM price_change_logs').get().c
ok('留痕已写入', after === before + 1, `${before} → ${after}`)
const lastLog = db.prepare('SELECT * FROM price_change_logs ORDER BY id DESC LIMIT 1').get()
ok('留痕含改动前后值与原因', lastLog.old_value === oldPrice && lastLog.reason === '自动化测试', JSON.stringify(lastLog))
// 还原
db.prepare('UPDATE product_skus SET price_retail=? WHERE id=?').run(oldPrice, sku.id)

// ============================================================
section('T7 边界')
let threw = null
try { resolvePrice(db, {}) } catch (e) { threw = e }
ok('缺 skuId 抛错', !!threw && threw.code === 'BAD_ARGS', threw?.code)

let threw2 = null
try { resolvePrice(db, { skuId: 99999999 }) } catch (e) { threw2 = e }
ok('SKU 不存在抛 NOT_FOUND', !!threw2 && threw2.code === 'NOT_FOUND', threw2?.code)

// ============================================================
section('T8 促销表存在时取价引擎不能被打断（批次 F 的建表陷阱）')
// 背景：这一步原先用「`promotions` 表是否存在」当促销价特性开关，
// 命中后按 price / sku_id / start_at / end_at 四列查询。
// 而批次 F（迁移 025）建的是 medusa 模型（优惠在 promotion_methods、时间列是 starts_at/ends_at），
// **没有这四列** ⇒ 表一建出来取价引擎每次调用都抛 `no such column: price`，
// seedOrderCenter 崩溃、服务起不来。已改为探测列形状。
// 这条断言把它锁死：即使 promotions 表存在（且是 medusa 形状），取价也必须正常回落。
//
// ⚠️ 两张假表必须建在**事务**里、结束时 ROLLBACK —— 这里是**共享的演示库**，
// `promotions` 是模块 18 的真表。早先这一节直接 `db.exec('DROP TABLE promotions')`，
// 于是：① 同一轮批跑里后面的 test-promo（cosmetic）报 `no such table: promotions`；
// ② 服务下次启动时 initSchema 把空表补回来、而 `promotion_campaigns` 没被动过，
// 于是 seedPromo 以为"库里没促销"照常重灌，直接撞 `DUPLICATE_CODE: CMP_AUTUMN`，
// smoke-api 起不来。SQLite 的 DDL 是事务性的，ROLLBACK 能把真表连同数据一字不差地还回来。
db.exec('BEGIN')
try {
  db.exec('DROP TABLE promotions')
  // 形状一：medusa 模型（无 price 列，时间列是 starts_at / ends_at）
  db.exec(`CREATE TABLE promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'standard', status TEXT NOT NULL DEFAULT 'active',
    priority INTEGER NOT NULL DEFAULT 100, stack_group TEXT, is_exclusive INTEGER NOT NULL DEFAULT 0,
    is_automatic INTEGER NOT NULL DEFAULT 0,
    starts_at TEXT, ends_at TEXT
  )`)
  db.prepare("INSERT INTO promotions (code,name,type,status,is_automatic,priority,starts_at) VALUES ('T_PROMO','测试促销','standard','active',1,10,'2020-01-01')").run()
  let threw3 = null
  let promoHit = null
  try { promoHit = resolvePrice(db, { skuId: sku.id, qty: 1 }) } catch (e) { threw3 = e }
  ok('promotions 表存在时取价不抛错', !threw3, threw3?.message)
  ok('medusa 形状的 promotions 不参与取价（回落标准价）', !!promoHit && promoHit.source !== 'promotion', promoHit?.source)
  db.exec('DROP TABLE promotions')

  // 反向确认：真的「简表形态」（带 price 列）仍然能被促销价命中 ——
  // 否则这次修复等于把促销价这条通路悄悄删掉了。
  db.exec(`CREATE TABLE promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sku_id INTEGER, price REAL,
    status TEXT, start_at TEXT, end_at TEXT, priority INTEGER
  )`)
  db.prepare("INSERT INTO promotions (sku_id,price,status,priority) VALUES (?,?,'active',1)").run(sku.id, 1.23)
  const legacyHit = resolvePrice(db, { skuId: sku.id, qty: 1 })
  ok('简表形态的 promotions 仍能命中促销价', legacyHit.source === 'promotion' && Math.abs(legacyHit.price - 1.23) < 0.001, `${legacyHit.source} / ${legacyHit.price}`)
  db.exec('DROP TABLE promotions')
} finally {
  db.exec('ROLLBACK')
}
// 还原自检：这条断言存在的意义是「下次再有人把上面那两句 DROP 挪到事务外，这里立刻红」。
// 单靠"测试通过了"发现不了 —— 库被改坏是**下一轮**别的测试才报错的。
const promoTableBack = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='promotions'").get().c
ok('T8 结束后真实 promotions 表仍在（假表只活在事务里）', promoTableBack === 1, `sqlite_master 命中 ${promoTableBack} 张`)
const promoRealRows = db.prepare('SELECT COUNT(*) c FROM promotions').get().c
ok('真实促销数据未被测试破坏', promoRealRows > 0, `实际 ${promoRealRows} 行`)

console.log(`\n${'─'.repeat(56)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) console.log('失败项：\n - ' + failed.join('\n - '))
db.close()
process.exit(fail ? 1 : 0)
