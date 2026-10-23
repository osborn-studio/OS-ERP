/**
 * ============================================================================
 * 文件标识：scripts/test-setting-audit.mjs ｜ 测试：批次 R：配置变更留痕（settings 的每一次改动都留一条可重放的记录）
 * ============================================================================
 * 【职责】测试：批次 R：配置变更留痕（settings 的每一次改动都留一条可重放的记录）
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
 * 批次 R：配置变更留痕（settings 的每一次改动都留一条可重放的记录）
 *
 * 这一批补的不是"配置读得到"，而是三件事：
 *   ① **配置项的集合是确定的** —— 库里的键 == 定义表里的键。
 *      摸底时查出四个真实缺口：同一个键四处各写一遍默认值（credit/quote/member/pos2）、
 *      三个"代码读、库里没有"的幽灵配置、一个"登记了但没人读"的配置、
 *      以及"库里的键没人管"这条总账（谁都能写一个没人认识的键进去）。
 *   ② **每一次改动都留痕，且与改值同事务**（断言 `db.inTransaction`，不是文档里的建议）；
 *   ③ **可重放**：从空状态按序应用日志，必须得到 settings 表的现状。
 *      两条路径的出处不同（现状来自各处的 upsert，历史来自唯一写入点），
 *      所以它抓得到"改了没记""记了没改"。
 *
 * 与其它域同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-setting-audit.mjs [cosmetic|food|apparel]
 *
 * 可重复跑 + 不留副作用：全部写操作包在 `BEGIN … ROLLBACK` 里，
 * S15 断言 settings 与审计日志表**一行都不多**。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import * as S from '../server/lib/settings.js'
import * as R from '../server/lib/report.js'
import * as P from '../server/lib/pos2.js'
import * as C from '../server/lib/credit.js'
import * as Q from '../server/lib/quote.js'
import * as M from '../server/lib/member.js'
import * as A from '../server/lib/accounting.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { DATA_DIR, dbPathFor, INDUSTRIES } from '../server/db/index.js'

const ROOT = path.resolve(__dirname, '..')
// ---------- 落点自证：这一跑会读写哪个数据目录 ----------
// 库路径一律从 db/index.js 的 `dbPathFor` 取，不在这里另写一份 `ROOT/data` ——
// 否则"打印出来的落点"和"真正打开的文件"会分家，脚本就会说谎（比不打印更坏）。
console.log(`[落点] 数据目录：${path.resolve(DATA_DIR)}`)
// 判据（两条，缺一不可）：
//   ① 没设 `GML_DATA_DIR` ⇒ 按定义就是开发库（`DATA_DIR = GML_DATA_DIR || <项目>/data`，
//      见 `server/db/index.js:10`）——这是**主**判据；
//   ② 设了、但指到项目 `data/` 本身。
// ① 必须有：字符串比较在 macOS 上会被 `/tmp → /private/tmp` 这类符号链接骗到
// （实测：副本里本该告警却**没**告警，把判据反过来才告警 —— 拿它当唯一判据是错的）。
if (!process.env.GML_DATA_DIR || path.resolve(DATA_DIR) === path.resolve(path.join(ROOT, 'data'))) {
  console.log('⚠️ 本次将读写开发库 data/ —— 若要隔离请设 GML_DATA_DIR=/tmp/...')
}
const INDUSTRY = process.argv[2] || 'cosmetic'
// 行业名必须合法：`dbPathFor` / `getDbFor` 会把**未知行业码静默归一成 cosmetic**
// （`server/db/index.js:28-30`），于是一个字母打错（`fodd`）会安静地跑另一个库，
// 拿到的"绿"是假的。调用侧自己把住"错名要响"。
if (process.argv[2] && !INDUSTRIES[process.argv[2]]) {
  console.error(`✗ 未知行业：${process.argv[2]}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
  process.exit(2)
}

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) pass++
  else {
    fail++
    failures.push(msg)
    console.log(`  \x1b[31m✗\x1b[0m ${msg}${detail !== undefined ? `  → ${String(detail).slice(0, 300)}` : ''}`)
  }
}
const eq = (msg, actual, expect) => {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)
const throws = (fn, code, msg) => {
  try {
    fn()
  } catch (e) {
    const hit = !code || e.code === code
    if (!hit) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${code}，实得 ${e.code || e.message}`)
    ok(hit, msg, e.code)
    return
  }
  console.log(`  \x1b[31m✗\x1b[0m ${msg}：没有抛错`)
  ok(false, msg)
}

const dbFile = dbPathFor(INDUSTRY)
const db = new Database(dbFile)
db.pragma('journal_mode = WAL')
const actor = { id: null, name: 'test-setting', source: 'web' }

console.log(`=== 配置变更留痕测试（${INDUSTRY}） ===`)

const base = {
  settings: db.prepare('SELECT COUNT(*) c FROM settings').get().c,
  log: db.prepare('SELECT COUNT(*) c FROM setting_audit_log').get().c
}

/** 在一个事务里做破坏性动作，跑完自动回滚（测试不留副作用） */
function inSavepoint(fn) {
  try {
    db.transaction(() => {
      fn()
      throw new Error('__ROLLBACK__')
    })()
  } catch (e) {
    if (e.message !== '__ROLLBACK__') throw e
  }
}

/** 直接改库（**绕过唯一写入点**）—— 用来制造探针该抓的场景 */
const poke = (key, value) => db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(value), key)
/**
 * 读一个配置在库里的**字符串**值。
 * `|| {}` 的兜底是刻意的：反例注入（如"ensureSettings 不补齐键"）会让这一行读不到行，
 * 而 `.get().value` 会崩在 `undefined` 上 —— 那等于把"这条断言该给的可读的红"丢掉，
 * 变成一句 `TypeError`（批次 Q 的教训：**崩在无关位置 = 把最重要的证据丢了**）。
 */
const valOf = (key) => (db.prepare('SELECT value FROM settings WHERE key=?').get(key) || {}).value

// ===========================================================================
section('S1 定义表是全项目唯一的「配置定义」')
{
  const keys = Object.keys(S.SETTING_RULES)
  eq('登记键数与 SETTING_KEYS 一致', S.SETTING_KEYS.length, keys.length)
  ok(S.SETTING_KEYS.length >= 16, `登记键不少于 16 个（实际 ${S.SETTING_KEYS.length}）`)

  // 每个定义都必须有"界面渲染需要的那几样"：标签、分组、类型、默认值、影响说明。
  // 少一个不会报错，只会让界面显示成空白 —— 而那看起来像"这个配置不重要"。
  const incomplete = keys.filter((k) => {
    const d = S.SETTING_RULES[k]
    return !d.label || !d.group || !d.type || d.default === undefined || !d.impact
  })
  eq('没有缺字段的定义', incomplete, [])

  // 分组必须是登记表里有的 —— 否则那个配置在界面上**一个分组都进不去**。
  const groupKeys = new Set(S.SETTING_GROUPS.map((g) => g.key))
  const orphanGroup = keys.filter((k) => !groupKeys.has(S.SETTING_RULES[k].group))
  eq('没有落在未定义分组里的配置', orphanGroup, [])

  // 反向：登记了但一个配置都没有的分组 = 界面上一个空块。
  const used = new Set(keys.map((k) => S.SETTING_RULES[k].group))
  eq('没有空分组', S.SETTING_GROUPS.filter((g) => !used.has(g.key)).map((g) => g.key), [])

  // 危险项集合。**字面写下**，不从定义表推 —— 从定义表推等于自己验自己：
  // 有人把某个会计政策误标成不危险，这条断言会跟着一起"通过"。
  // 批次 U 之四 / ③-c 加了 `fiscal.start_month`（会计年度起始月）—— 它改变**所有报表的年初边界**，
  // 按定义就是危险项。所以这里的字面集合从六个变七个（**必须同步**：这条断言的价值就在于
  // "有人把某个危险项误标成不危险"时它会响，跟着定义表改就白写了）。
  // 供应链参数（批次 V · 客户口径"是不是允许负库存"）再加两个：`inv_allow_negative` /
  // `inv_allow_negative_for` —— 它们决定**出库能不能超过可用库存**（结存能不能转负），
  // 直接动账实口径，按同一条判据就是危险项。
  // 第 0 层设计 §7.1 再补一个：`inv_doc_warehouse_scope`（单据类型 → 允许的仓库白名单）——
  // 它决定"这一单能不能用这个仓"，配错了会拦单 / 放错仓。七个 → 十个。
  // 本批再补一个：`purchase_return_offset`（采购退货是否抵减结算）——
  // 打开后它直接**改变应付金额**（应结 = 入库/发票 − 已确认退货）。按同一条判据是危险项：
  // 改错了不会报错，只会让"这票该付多少"整体偏移。十个 → **十一个**。
  // ⚠️ 这份清单是**刻意钉死**的：它抓的是"有人把某个危险项误标成不危险"，
  // 改成从 `is_danger` 派生就永远等于自己、抓不到任何东西。
  // ADR-0018 再补三个资金复核键：关掉证据/复核或抬高阈值都会让收付款绕过第二人，按同一判据是危险项。十一个 → **十四个**。
  // ADR-0030 再补三个数据保留键：缩短窗口会更早永久删除日志，按同一判据是危险项。十四个 → **十七个**。
  const DANGER = ['closing_profit_subject', 'annual_retained_subject', 'voucher_default_tax_rate', 'ar_source_of_truth', 'ar_oc_enabled', 'pos_variance_limit', 'fiscal.start_month', 'inv_allow_negative', 'inv_allow_negative_for', 'inv_doc_warehouse_scope', 'purchase_return_offset', 'funds_evidence_required', 'funds_review_required', 'funds_review_threshold', 'retention_audit_days', 'retention_notify_log_days', 'retention_mcp_log_days']
  eq('危险配置集合恰好是这十七个（会计政策 + 应收口径 + 门店阈值 + 会计年度边界 + 库存口径 + 单据类型允许仓库 + 采购退货抵减 + 资金复核 + 数据保留）',
    keys.filter((k) => S.SETTING_RULES[k].is_danger).sort(), [...DANGER].sort())

  // 动作表：三态必须能分开
  eq('配置变更动作恰好三种', Object.keys(S.SETTING_ACTIONS).sort(), ['baseline', 'reset', 'set'])
  const writes = Object.values(S.SETTING_ACTIONS).map((v) => v.effect.write).sort()
  eq('三种动作各自声明效果（snapshot / value / default）', writes, ['default', 'snapshot', 'value'])
}

// ===========================================================================
section('S2 值的形态与值域只有一处定义')
{
  const norm = (k, v) => S.normalizeSettingValue(S.SETTING_RULES[k], v)

  // bool：四种真值写法都要归一成 '1'
  for (const t of ['1', 'true', 'TRUE', 'yes', 'on', ' yEs ']) eq(`bool「${t}」→ '1'`, norm('ar_oc_enabled', t), '1')
  for (const f of ['0', 'false', 'no', 'off', '']) eq(`bool「${f}」→ '0'`, norm('ar_oc_enabled', f), '0')
  throws(() => norm('ar_oc_enabled', 'maybe'), 'SETTING_VALUE_INVALID', 'bool 拒绝含糊值')

  // int：拒绝小数与垃圾
  eq("int 接受 '12'", norm('quote.valid_days', '12'), '12')
  eq("int 接受 12（数字）", norm('quote.valid_days', 12), '12')
  throws(() => norm('quote.valid_days', '1.5'), 'SETTING_VALUE_INVALID', 'int 拒绝小数')
  throws(() => norm('quote.valid_days', 'abc'), 'SETTING_VALUE_INVALID', 'int 拒绝非数字')

  // gt / min / max
  throws(() => norm('quote.valid_days', '0'), 'SETTING_VALUE_INVALID', 'quote.valid_days 必须 > 0（报价有效期不能是 0 天）')
  throws(() => norm('promo_points_per_yuan', '-1'), 'SETTING_VALUE_INVALID', 'promo_points_per_yuan 必须 > 0')
  throws(() => norm('promo_points_per_yuan_deduct', '0'), 'SETTING_VALUE_INVALID', 'promo_points_per_yuan_deduct 必须 > 0（配成 0 会让抵扣除零）')
  throws(() => norm('voucher_default_tax_rate', '101'), 'SETTING_VALUE_INVALID', '税率不能超过 100')
  throws(() => norm('voucher_default_tax_rate', '-1'), 'SETTING_VALUE_INVALID', '税率不能为负')
  throws(() => norm('promo_points_deduct_max', '10001'), 'SETTING_VALUE_INVALID', '万分比上限不能超过 10000')
  eq('pos_variance_limit 允许 0（一差异就拦）', norm('pos_variance_limit', '0'), '0')
  throws(() => norm('pos_variance_limit', '-1'), 'SETTING_VALUE_INVALID', 'pos_variance_limit 不能为负')

  // enum：值域内按 value 收，按 label 也收（界面下拉里显示的是 label）
  eq("enum 接受 value 'SI'", norm('ar_source_of_truth', 'SI'), 'SI')
  throws(() => norm('ar_source_of_truth', 'OC'), 'SETTING_VALUE_INVALID', 'enum 拒绝域外值')

  // subject：科目编码必须是纯数字
  eq("subject 接受 '4104'", norm('closing_profit_subject', '4104'), '4104')
  throws(() => norm('closing_profit_subject', '本年利润'), 'SETTING_VALUE_INVALID', 'subject 拒绝非编码')
  throws(() => norm('closing_profit_subject', ''), 'SETTING_VALUE_INVALID', 'subject 拒绝空串')

  // text
  eq('text 去首尾空白', norm('backup_dir', '  data/bk  '), 'data/bk')
  throws(() => norm('backup_dir', '   '), 'SETTING_VALUE_INVALID', 'text 拒绝空串')

  // null / undefined 一律拒绝（"没填"不能变成"改成空"）
  throws(() => norm('backup_dir', null), 'SETTING_VALUE_INVALID', 'null 被拒绝')
  throws(() => norm('backup_dir', undefined), 'SETTING_VALUE_INVALID', 'undefined 被拒绝')
}

// ===========================================================================
section('S3 读取点唯一：转型正确 + 非法值回落默认（不抛）')
{
  eq('bool 返回真布尔', S.readSetting(db, 'ar_oc_enabled'), true)
  eq('int 返回数字', S.readSetting(db, 'quote.valid_days'), 30)
  eq('number 返回数字', S.readSetting(db, 'voucher_default_tax_rate'), 13)
  eq('subject 返回字符串', S.readSetting(db, 'closing_profit_subject'), '4103')
  eq('enum 返回字符串', S.readSetting(db, 'ar_source_of_truth'), 'SO')

  // 读未登记的键：**宁可炸**，也不要返回一个"某个默认值" ——
  // 那正是幽灵配置的成因（`credit.overdue_block_days` 曾经就是"读不到就当 30"）。
  throws(() => S.readSetting(db, 'no.such.key'), 'SETTING_UNKNOWN', '读未登记的键抛 SETTING_UNKNOWN')

  // 库里存了非法值：读路径**不抛**，回落默认值（否则一个配错的键会让整个模块在运行时炸）。
  // 但"不合法"这件事必须被探针报出来 —— 由 S8 覆盖。
  inSavepoint(() => {
    poke('voucher_default_tax_rate', 'abc')
    eq('非法值 → 回落默认 13', S.readSetting(db, 'voucher_default_tax_rate'), 13)
    poke('quote.valid_days', '0')
    eq('越界值 → 回落默认 30', S.readSetting(db, 'quote.valid_days'), 30)
    poke('ar_source_of_truth', 'OC')
    eq('域外枚举 → 回落默认 SO', S.readSetting(db, 'ar_source_of_truth'), 'SO')
  })

  // 四个原有读取函数与 readSetting **读的是同一个数**（行为等价性）。
  // 这里用**字面期望值**，不用被测函数互相推 —— 否则一方错会带着另一方一起"通过"。
  eq('pos2.getVarianceLimit == 500', P.getVarianceLimit(db), 500)
  eq('accounting.defaultTaxRate == 13', A.defaultTaxRate(db), 13)
  eq('member.pointsPerYuan == 10', M.pointsPerYuan(db), 10)
  eq('member.pointsPerYuanDeduct == 100', M.pointsPerYuanDeduct(db), 100)
  eq('member.deductMaxBp == 5000', M.deductMaxBp(db), 5000)
  eq('member.isAutoUpgrade == true', M.isAutoUpgrade(db), true)
  eq('quote 的审批阈值 == 200000', Q.quoteOverview(db).approval_amount_threshold, 200000)
  eq('quote 的默认有效期 == 30', Q.quoteOverview(db).valid_days_default, 30)
  eq('credit 的逾期拦截天数 == 30', C.overdueBlockDays(db), 30)
}

// ===========================================================================
section('S4 唯一写入点：写值与写日志同生共死')
{
  // 非危险项（促销积分率）：改值**不需要**理由
  inSavepoint(() => {
    const r = S.writeSetting(db, { key: 'promo_points_per_yuan', value: '20', actor })
    ok(r.changed && r.logged, 'writeSetting 报告已变更并已留痕')
    eq('settings 表里是新值', valOf('promo_points_per_yuan'), '20')

    const row = db.prepare("SELECT * FROM setting_audit_log WHERE key='promo_points_per_yuan' ORDER BY id DESC LIMIT 1").get() || {}
    eq('日志 action = set', row.action, 'set')
    eq('日志 value_before = 10', row.value_before, '10')
    eq('日志 value_after = 20', row.value_after, '20')
    eq('日志冻结了当时是否危险（非危险项记 0）', row.is_danger, 0)
    eq('非危险项不需要理由（reason 为空）', row.reason, null)
    eq('日志记了操作人', row.actor_name, 'test-setting')
    eq('动作中文名落库冻结', row.action_label, '修改配置')

    // 值没变：不是一次变更，不该写日志。
    // 界面上"点了一次保存但没改"是正常操作，所以不做成错误 —— 但它必须如实回答 changed=false。
    const r2 = S.writeSetting(db, { key: 'promo_points_per_yuan', value: 20, actor })
    eq('值没变时 changed = false', r2.changed, false)
    eq('值没变时不写日志', r2.logged, false)
    const cnt = db.prepare("SELECT COUNT(*) c FROM setting_audit_log WHERE key='promo_points_per_yuan'").get().c
    eq('值没变时日志条数不变', cnt, 2) // baseline + 上面那次 set
  })

  // 危险配置：改动必须写理由
  throws(
    () => inSavepoint(() => S.writeSetting(db, { key: 'closing_profit_subject', value: '4105', actor })),
    'SETTING_REASON_REQUIRED', '危险配置（会计政策）改值不写理由 → 拒绝'
  )
  inSavepoint(() => {
    const r = S.writeSetting(db, { key: 'closing_profit_subject', value: '4105', actor, reason: '口径调整：下半年起并入留存收益' })
    ok(r.changed, '写了理由就放行')
    const row = db.prepare("SELECT * FROM setting_audit_log WHERE key='closing_profit_subject' ORDER BY id DESC LIMIT 1").get() || {}
    eq('理由落进日志', row.reason, '口径调整：下半年起并入留存收益')
  })

  // 未登记的键：不许写
  throws(
    () => inSavepoint(() => S.writeSetting(db, { key: 'not.registered', value: '1', actor })),
    'SETTING_UNKNOWN', '写未登记的键 → 拒绝'
  )
  // 非法值
  throws(
    () => inSavepoint(() => S.writeSetting(db, { key: 'voucher_default_tax_rate', value: '999', actor, reason: 'x' })),
    'SETTING_VALUE_INVALID', '写非法值 → 拒绝'
  )

  // 被拒绝的三次尝试**一行日志都不该留下**
  eq('被拒的写入没有留下日志', db.prepare("SELECT COUNT(*) c FROM setting_audit_log WHERE key IN ('not.registered')").get().c, 0)
}

// ===========================================================================
section('S5 resetSetting：恢复默认，且与「改成了默认值」分开')
{
  inSavepoint(() => {
    S.writeSetting(db, { key: 'promo_points_per_yuan', value: '99', actor })
    const r = S.resetSetting(db, { key: 'promo_points_per_yuan', actor })
    ok(r.changed, 'reset 报告已变更')
    eq('值回到默认 10', valOf('promo_points_per_yuan'), '10')
    const row = db.prepare("SELECT * FROM setting_audit_log WHERE key='promo_points_per_yuan' ORDER BY id DESC LIMIT 1").get() || {}
    // 三态必须能分开：reset 与"手工填了一个恰好等于默认值的值"是两件事。
    eq('日志 action = reset（不是 set）', row.action, 'reset')
    eq('reset 的 value_after 是默认值', row.value_after, '10')
  })
  inSavepoint(() => {
    // 已经在默认值上再 reset：不是一次变更
    const r = S.resetSetting(db, { key: 'promo_points_per_yuan', actor })
    eq('已是默认值时 reset → changed = false', r.changed, false)
  })
  // 危险项 reset 同样要理由。
  // ⚠️ 必须先把它改成**非默认值**再 reset —— 否则 `resetSetting` 会在
  // "值已是默认值"这一步就如实返回 `changed:false`（那也是一条正确的路径），
  // 用例就变成"什么也没验证"了（红线：`ok(true, '跳过')` 式的假通过）。
  throws(
    () => inSavepoint(() => {
      S.writeSetting(db, { key: 'ar_source_of_truth', value: 'SI', actor, reason: '临时切到 SI 以验证 reset 闸门' })
      S.resetSetting(db, { key: 'ar_source_of_truth', actor }) // ← 这里必须抛
    }),
    'SETTING_REASON_REQUIRED', '危险项 reset 不写理由 → 拒绝'
  )
  inSavepoint(() => {
    S.writeSetting(db, { key: 'ar_source_of_truth', value: 'SI', actor, reason: '临时切到 SI 以验证 reset 闸门' })
    const r = S.resetSetting(db, { key: 'ar_source_of_truth', actor, reason: '口径回退：实验结束，恢复按订单生成应收' })
    ok(r.changed, '危险项 reset 写了理由就放行')
    eq('value 回到默认 SO', valOf('ar_source_of_truth'), 'SO')
  })
}

// ===========================================================================
section('S6 logSettingChange 的三条当场断言')
{
  // ① 必须在事务里。这条铁律写进文档没人记得，所以它是**断言**。
  //
  // ⚠️ 两个刻意的细节，都是被反例逼出来的：
  //   · 用**非危险的键**（`backup_keep`）。若用 `pos_variance_limit`，摘掉事务断言之后
  //     会落到"危险项必须写理由"那条闸门，断言实得 `SETTING_REASON_REQUIRED` ——
  //     那条用例就分不清"事务断言坏了"还是"理由闸门坏了"（一条断言只该被**一个**闸门守着）。
  //   · 用完**清掉这次调用可能留下的行**。这一条是反例注入时发现的真问题：
  //     断言被摘掉后，那次事务外的调用**真的会写进库**；而"还原代码"不会回滚库 ——
  //     于是这条脏日志会污染后面十几条断言，让它们一起红（**与本次注入无关的红**）。
  //     铁律：反例要给出**可读的红**，不能把证据埋在一片连带失败里。
  //     `maxLogId` 之后的清理在正常情况下是 no-op。
  const maxLogId = db.prepare('SELECT COALESCE(MAX(id),0) m FROM setting_audit_log').get().m
  const beforeCnt = db.prepare("SELECT COUNT(*) c FROM setting_audit_log WHERE key='backup_keep'").get().c
  throws(
    () => S.logSettingChange(db, { key: 'backup_keep', action: 'set', valueBefore: '1', valueAfter: '2' }),
    'AUDIT_OUTSIDE_TX', '事务外写日志 → AUDIT_OUTSIDE_TX'
  )
  const afterCnt = db.prepare("SELECT COUNT(*) c FROM setting_audit_log WHERE key='backup_keep'").get().c
  eq('事务外写日志一行都没落库（抛错与写入不能同时发生）', afterCnt, beforeCnt)
  db.prepare('DELETE FROM setting_audit_log WHERE id > ?').run(maxLogId)
  // ② 动作名必须认识
  throws(
    () => inSavepoint(() => S.logSettingChange(db, { key: 'pos_variance_limit', action: 'nonsense', valueAfter: '1' })),
    'SETTING_AUDIT_UNKNOWN_ACTION', '未登记的动作名 → 拒绝'
  )
  // ③ 未登记的键不能进日志（否则日志里会积累一批代码不认的键）
  throws(
    () => inSavepoint(() => S.logSettingChange(db, { key: 'ghost', action: 'set', valueAfter: '1' })),
    'SETTING_UNKNOWN', '未登记的键写日志 → 拒绝'
  )
  // 基线条目**不要求**理由（它不是谁的动作）—— 哪怕是危险项。
  inSavepoint(() => {
    db.prepare("DELETE FROM setting_audit_log WHERE key='closing_profit_subject'").run()
    const id = S.logSettingChange(db, { key: 'closing_profit_subject', action: 'baseline', valueAfter: '4103', actor: { source: 'system' } })
    ok(id > 0, '危险项的 baseline 不需要理由')
  })
}

// ===========================================================================
section('S7 重放自证：两条路径出处不同')
{
  // 干净状态下：重放 == 现状
  const cleanDiff = diffOf(db)
  eq('干净状态重放零差异', cleanDiff, [])

  inSavepoint(() => {
    S.writeSetting(db, { key: 'promo_points_per_yuan', value: '20', actor })
    eq('改一个值后重放立刻反映（不是缓存）', diffOf(db), [])
    eq('重放得到的就是新值', S.replaySettings(db).promo_points_per_yuan, '20')

    // 注入一份**造出来的**日志：证明重放确实读的是 entries，不是又去读了一遍库。
    // （批次 P 的教训：探针用被测函数推期望值 = 自己验自己，永远通过。）
    const fake = [
      { key: 'promo_points_per_yuan', action: 'baseline', value_after: '1' },
      { key: 'promo_points_per_yuan', action: 'set', value_after: '7' }
    ]
    eq('重放读的是传入的 entries', S.replaySettings(db, { entries: fake }).promo_points_per_yuan, '7')

    // 绕过唯一写入点改值 → 重放与现状分离
    poke('promo_points_per_yuan', '33')
    const d = diffOf(db)
    ok(d.length === 1 && d[0].includes('promo_points_per_yuan'), '绕过写入点改值 → 重放立刻与现状分离', JSON.stringify(d))
  })
}
/** 重放与现状的差异（**字面比对**，不借助被测函数的"相等"判断） */
function diffOf(database) {
  const want = S.replaySettings(database)
  const got = S.settingsStateOf(database)
  const out = []
  for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
    if (want[k] !== got[k]) out.push(`${k}: 重放=${want[k] ?? '（无）'} / 现状=${got[k] ?? '（无）'}`)
  }
  return out
}

// ===========================================================================
/** 探针结果里有没有某条 code（`const` 不提升，所以定义必须在调用之前） */
const hasCode = (trail, code) => (trail.problems || []).some((p) => p.code === code)

section('S8 auditSettingTrail 的七条覆盖面（每条都**造出场景**，不跳过）')
{
  ok(S.auditSettingTrail(db).ok, '干净库：自证通过')

  // ① 库里有未登记的键 —— 本批要根治的那类问题的反向
  inSavepoint(() => {
    db.prepare("INSERT INTO settings (key,value) VALUES ('ghost_key','1')").run()
    const t = S.auditSettingTrail(db)
    ok(hasCode(t, 'SETTING_KEY_UNKNOWN'), '库里多了一个未登记的键 → SETTING_KEY_UNKNOWN', JSON.stringify(t.problems.map((p) => p.code)))
  })

  // ② 登记的键在库里缺失（初始化没跑全）
  inSavepoint(() => {
    db.prepare("DELETE FROM settings WHERE key IN ('backup_keep','quote.valid_days')").run()
    const t = S.auditSettingTrail(db)
    ok(hasCode(t, 'SETTING_KEY_MISSING'), '登记的键缺失 → SETTING_KEY_MISSING')
  })

  // ③ 现状值不满足值域（有人直接改库，或值域在本批收紧了）
  inSavepoint(() => {
    poke('voucher_default_tax_rate', 'abc')
    const t = S.auditSettingTrail(db)
    ok(hasCode(t, 'SETTING_VALUE_INVALID'), '现状值非法 → SETTING_VALUE_INVALID')
  })

  // ④ 危险配置的变更没写理由（直接插一条，绕过写入点）
  inSavepoint(() => {
    db.prepare(`
      INSERT INTO setting_audit_log (key,action,action_label,group_key,value_before,value_after,is_danger,reason,actor_source)
      VALUES ('closing_profit_subject','set','修改配置','finance','4103','4105',1,NULL,'web')
    `).run()
    const t = S.auditSettingTrail(db)
    ok(hasCode(t, 'SETTING_AUDIT_REASON_REQUIRED'), '危险项变更无理由 → SETTING_AUDIT_REASON_REQUIRED')
  })

  // ⑤ 陌生动作名（有人绕过唯一写入点手写，或线上跑着更老的代码）
  inSavepoint(() => {
    db.prepare(`
      INSERT INTO setting_audit_log (key,action,action_label,group_key,value_before,value_after,is_danger,actor_source)
      VALUES ('pos_variance_limit','weird','怪动作','pos','500','600',1,'web')
    `).run()
    const t = S.auditSettingTrail(db)
    ok(hasCode(t, 'SETTING_AUDIT_UNKNOWN_ACTION'), '陌生动作名 → SETTING_AUDIT_UNKNOWN_ACTION')
  })

  // ⑥ 日志里有已不在登记表里的键（曾经登记过、后来删了）
  inSavepoint(() => {
    db.prepare(`
      INSERT INTO setting_audit_log (key,action,action_label,group_key,value_before,value_after,is_danger,actor_source)
      VALUES ('removed.key','baseline','基线（初始化时现状快照）','ops',NULL,'1',0,'system')
    `).run()
    const t = S.auditSettingTrail(db)
    ok(hasCode(t, 'SETTING_AUDIT_ORPHAN'), '日志里有已移除的键 → SETTING_AUDIT_ORPHAN')
  })

  // ⑦ 重放 ≠ 现状
  inSavepoint(() => {
    poke('ar_source_of_truth', 'SI') // 直接改库，不写日志
    const t = S.auditSettingTrail(db)
    ok(hasCode(t, 'SETTING_AUDIT_DESYNC'), '有改动没留日志 → SETTING_AUDIT_DESYNC')
  })

  // 全库扫描：探针查的是**整张表**而不是"我正在看的那一个键"。
  // （批次 N 的教训：只在用户点某一行时才跑的探针等于不跑。）
  inSavepoint(() => {
    poke('backup_keep', '1')
    const t = S.auditSettingTrail(db)
    ok(t.keys_checked >= 16, `自证扫描全部键（实际 ${t.keys_checked}）`)
  })
}

// ===========================================================================
section('S9 探针真的接在 auditReport 第 ⑪ 条上（不是"写好了没接"）')
{
  // ⚠️ 探针断言**放在最前面**：反例注入时若先跑会崩的细节断言，
  // 就看不到最重要的那一条证据（批次 Q 的教训）。
  const p = R.availablePeriods(db)[0]?.period
  ok(!!p, `库里有一个可用期间（${p}）`)
  if (p) {
    inSavepoint(() => {
      poke('voucher_default_tax_rate', '9') // 改了会计政策却不留痕
      const rep = R.auditReport(db, { period: p }) || {}
      const codes = (rep.problems || []).map((x) => x.code)
      ok(codes.includes('SETTING_AUDIT_DESYNC'),
        '绕过写入点改配置 → auditReport 报 SETTING_AUDIT_DESYNC（关账前置会挡住）',
        JSON.stringify(codes))
      ok(rep.config_checked >= 16, `auditReport 带回配置自证的扫描数（${rep.config_checked}）`)
    })
    // 干净状态：这一条**不响**
    const clean = R.auditReport(db, { period: p }) || {}
    const settingCodes = (clean.problems || []).map((x) => x.code).filter((c) => c.startsWith('SETTING_'))
    eq('干净状态不报配置类问题', settingCodes, [])
  }
}

// ===========================================================================
section('S10 ensureSettings：幂等 + 补齐 + 补基线')
{
  inSavepoint(() => {
    const r1 = S.ensureSettings(db)
    eq('已经齐了：不补键', r1.inserted, 0)
    eq('已经有历史：不补基线', r1.baselines, 0)

    // 删掉一个**从未被改过**的键 → 补回来。
    // 它**不**补基线：这个键已经有历史了（初始化时那条 baseline），
    // 再补一条会把"有人手工删了配置行"伪装成"它本来就该被重建"。
    db.prepare("DELETE FROM settings WHERE key='backup_keep'").run()
    const r2 = S.ensureSettings(db)
    eq('缺失的键被补齐', r2.inserted, 1)
    eq('已有历史的键不重复补基线', r2.baselines, 0)
    eq('值就是登记表里的默认值', valOf('backup_keep'), '10')
    eq('补回后重放与现状仍一致（它原本就没被改过）', diffOf(db), [])

    // **锋利的那一条**：一个**被改过**的键，如果行被手工删掉，
    // `ensureSettings` 会把值补成默认值 —— 但历史里还留着"改成了 800"。
    // 于是重放（800）≠ 现状（10）⇒ 探针必须报出来。
    // 这正是"补一条基线"会掩盖掉的东西：那会让人以为"它本来就是这样"。
    // 先**通过唯一写入点**改一次（这会进历史：baseline 10 → set 800）
    S.writeSetting(db, { key: 'backup_keep', value: '800', actor })
    // 再把它手工删掉 —— 此时历史里留着"800"，而 `ensureSettings` 会补成默认值"10"。
    db.prepare("DELETE FROM settings WHERE key='backup_keep'").run()
    S.ensureSettings(db)
    eq('值被补成默认值', valOf('backup_keep'), '10')
    const d2 = diffOf(db)
    ok(d2.some((x) => x.includes('backup_keep')),
      '历史说是 800、现状被补成 10 → 重放与现状分叉（探针抓得到，不会被"补基线"掩盖）', JSON.stringify(d2))
    // 还原成"历史上真实的样子"（800），后面的用例继续在一致状态上跑。
    // 这一步本身也是绕过写入点 —— 它故意如此：这正是"探针会抓"的那类改动，
    // 而下一步的 `DELETE FROM setting_audit_log` 会把历史整体重建成现状的样子。
    db.prepare("UPDATE settings SET value='800' WHERE key='backup_keep'").run()
    eq('还原后重放与现状重新一致', diffOf(db), [])

    // 清空全部历史 → 每个键补一条基线（重建路径走的就是这一支）
    db.prepare('DELETE FROM setting_audit_log').run()
    const r3 = S.ensureSettings(db)
    eq('历史清空后每个键补一条基线', r3.baselines, S.SETTING_KEYS.length)
    eq('补完仍然自证通过', S.auditSettingTrail(db).ok, true)
    eq('补完重放零差异', diffOf(db), [])

    // 基线**不是任何人的动作** —— 它必须能被认出来
    const b = db.prepare("SELECT * FROM setting_audit_log WHERE key='backup_keep' LIMIT 1").get() || {}
    eq('baseline 的 actor_source = system', b.actor_source, 'system')
    eq('baseline 的 value_before 为空（没有"之前"）', b.value_before, null)
  })
}

// ===========================================================================
section('S11 三个幽灵配置**真的落库了**（本批修掉的缺口）')
{
  // 这三个键在批次 R 之前是"代码读、库里没有"：读不到就永远走默认值，
  // 界面上看不见它们 —— 看起来可配、实际不可配。现在它们必须在库里。
  for (const k of ['credit.overdue_block_days', 'quote.approval_amount', 'quote.valid_days']) {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(k)
    ok(!!row, `幽灵配置 ${k} 已落库（实际 ${row ? row.value : '不存在'}）`)
  }
  // 而且**真的生效**：改了它，业务函数读到新值
  inSavepoint(() => {
    S.writeSetting(db, { key: 'credit.overdue_block_days', value: '7', actor })
    eq('credit.overdueBlockDays 跟着变', C.overdueBlockDays(db), 7)
    S.writeSetting(db, { key: 'quote.valid_days', value: '15', actor })
    eq('quote 默认有效期跟着变', Q.quoteOverview(db).valid_days_default, 15)
    S.writeSetting(db, { key: 'quote.approval_amount', value: '300000', actor })
    eq('quote 审批阈值跟着变', Q.quoteOverview(db).approval_amount_threshold, 300000)
  })
}

// ===========================================================================
section('S12 收敛后行为等价：四个原读取函数读的是同一个数')
{
  inSavepoint(() => {
    S.writeSetting(db, { key: 'pos_variance_limit', value: '1234', actor, reason: '测试' })
    eq('pos2 读到新阈值', P.getVarianceLimit(db), 1234)
    S.writeSetting(db, { key: 'voucher_default_tax_rate', value: '9', actor, reason: '测试' })
    eq('accounting 读到新税率', A.defaultTaxRate(db), 9)
    S.writeSetting(db, { key: 'promo_points_per_yuan', value: '5', actor })
    eq('member 读到新积分率', M.pointsPerYuan(db), 5)
  })
}
section('S12b 未登记键的写入被拒绝（不是"写进去了但没人读"）')
{
  throws(
    () => inSavepoint(() => S.writeSetting(db, { key: 'month_bad', value: '1', actor })),
    'SETTING_UNKNOWN', '未登记的键写不进去'
  )
  eq('库里没有留下未登记的键', db.prepare("SELECT COUNT(*) c FROM settings WHERE key='month_bad'").get().c, 0)
}

// ===========================================================================
section('S13 listSettings：偏离默认值的判断基于**库里的字符串**')
{
  const clean = S.listSettings(db)
  eq('干净状态偏离数 = 0', clean.changed, 0)
  eq('干净状态每项 is_default', clean.items.every((x) => x.is_default), true)
  eq('每项都带影响说明', clean.items.every((x) => !!x.impact), true)

  inSavepoint(() => {
    S.writeSetting(db, { key: 'voucher_default_tax_rate', value: '9', actor, reason: '测试' })
    const ls = S.listSettings(db)
    eq('改过之后偏离数 = 1', ls.changed, 1)
    const it = ls.items.find((x) => x.key === 'voucher_default_tax_rate') || {}
    eq('那一项 is_default = false', it.is_default, false)
    eq('那一项 value_raw 是库里的字符串', it.value_raw, '9')
    eq('那一项历史条数 >= 2', it.history_count >= 2, true)
    ok(!!it.last_changed_at, '带最后变更时间')
  })

  // **关键**：值非法时不能因为"读出来回落成默认值"就显示成"没改过"。
  // 判断必须基于库里的**字符串**，而不是 `readSetting` 的返回值。
  inSavepoint(() => {
    poke('voucher_default_tax_rate', 'abc')
    const ls = S.listSettings(db)
    const it = ls.items.find((x) => x.key === 'voucher_default_tax_rate') || {}
    eq('库里值非法时 is_default = false（不假装没改过）', it.is_default, false)
    eq('库里值非法时 value_raw 原样暴露', it.value_raw, 'abc')
    eq('同时读出来的可用值回落成默认', it.value, 13)
  })

  // 分组渲染：每个分组都有 items，且 items 总数 == 配置总数
  const sum = ls_(db)
  eq('分组里的项数之和 == 配置总数', sum.items, sum.groups.reduce((a, g) => a + g.items.length, 0))
}
function ls_(database) {
  const out = S.listSettings(database)
  return { items: out.items.length, groups: out.groups }
}

// ===========================================================================
section('S14 listSettingAudit：按键 / 按危险 / 分页')
{
  inSavepoint(() => {
    S.writeSetting(db, { key: 'pos_variance_limit', value: '777', actor, reason: '测试' })
    S.writeSetting(db, { key: 'pos_variance_limit', value: '778', actor, reason: '测试' })

    const byKey = S.listSettingAudit(db, { key: 'pos_variance_limit' })
    ok(byKey.rows.length >= 3, `按键过滤拿到 ${byKey.rows.length} 条（baseline + 两次 set）`)
    eq('按键过滤：每一条都是这个键', byKey.rows.every((r) => r.key === 'pos_variance_limit'), true)
    eq('倒序：第一条是最新的', byKey.rows[0].value_after, '778')
    eq('按键过滤的 total 与 rows 一致', byKey.total, byKey.rows.length)

    const danger = S.listSettingAudit(db, { dangerOnly: true })
    eq('只看危险项：每一条都是危险配置', danger.rows.every((r) => r.is_danger), true)

    const limited = S.listSettingAudit(db, { limit: 1 })
    eq('limit 生效', limited.rows.length, 1)
    eq('limit 截断时如实标注', limited.truncated, true)

    // 人读字段：动作中文名、操作人、键中文名
    const one = byKey.rows[0]
    eq('action_label 是人话', one.action_label, '修改配置')
    eq('actor_label 是人话', one.actor_label, 'test-setting')
    eq('key_label 是人话', one.key_label, '交班长短款容忍阈值（元）')

    const m = S.meta(db)
    eq('meta 给出三种动作', m.actions.length, 3)
    eq('meta 给出十七个危险键（批次 U 之四起含 fiscal.start_month；批次 V 起含两个库存口径键 + 单据类型允许仓库；采购退货抵减；ADR-0018 起含三个 funds_* 资金复核键；ADR-0030 起含三个 retention_*_days 保留键）', m.danger_keys.length, 17)
    eq('meta 的 keys 与定义表一致', m.keys.length, S.SETTING_KEYS.length)
  })
}

// ===========================================================================
section('S15 无副作用：settings 与审计日志表一行都不多')
{
  eq('settings 行数不变', db.prepare('SELECT COUNT(*) c FROM settings').get().c, base.settings)
  eq('**审计日志表**一行都不多', db.prepare('SELECT COUNT(*) c FROM setting_audit_log').get().c, base.log)
  eq('没有残留测试造的键', db.prepare("SELECT COUNT(*) c FROM settings WHERE key IN ('ghost_key','month_bad','removed.key')").get().c, 0)
  eq('没有残留测试造的日志', db.prepare("SELECT COUNT(*) c FROM setting_audit_log WHERE key LIKE '%ghost%' OR key LIKE '%removed%' OR action='weird'").get().c, 0)
  // 收尾：探针仍然自洽（证明整轮测试没有把库改坏）
  ok(S.auditSettingTrail(db).ok, '收尾：配置审计链仍然自洽')
  eq('收尾：重放零差异', diffOf(db), [])
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) console.log(`失败项：\n  - ${failures.slice(0, 12).join('\n  - ')}`)
process.exit(fail === 0 ? 0 : 1)
