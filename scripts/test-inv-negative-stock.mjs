#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/test-inv-negative-stock.mjs ｜ 测试：常驻守卫：**「是否允许负库存」的唯一出处是配置中心**（客户口径）
 * ============================================================================
 * 【职责】测试：常驻守卫：**「是否允许负库存」的唯一出处是配置中心**（客户口径）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 常驻守卫：**「是否允许负库存」的唯一出处是配置中心**（客户口径）
//
// 用法：
//   node scripts/test-inv-negative-stock.mjs [cosmetic|food|apparel]
//   GML_DATA_DIR=/tmp/xxx node scripts/test-inv-negative-stock.mjs
//
// 绑住的是一句话：
//   「你也一定要地方设供应链参数，比如说出入库单据类型有哪些，**是不是允许负库存**，
//     能以哪些仓库。」（客户原话）
//
// 为什么它必须是常驻断言：
//   这条口径原来住在 `inv_params`（迁移 003 的 `negative_stock` + 004 的 `allow_negative_for`），
//   客户在**配置中心**看不到它、改了也没有留痕。本批把它收进 `lib/settings.js` 的
//   `SETTING_RULES`，判据只有一处。两件最容易做错的事，都由本脚本钉住：
//     ① **默认值改错 = 静默改变所有存量客户的行为** —— 所以有一组断言证明
//        "默认值 = 改动前的实际行为"（迁移里那两个 `inv_params` 默认值就是改动前的行为）；
//     ② **两份判据**（参数表一套、配置中心一套）—— 所以有一条断言证明
//        即使 `inv_params.negative_stock='1'`，结论也不再由它决定。
//
// 断言的 9 件事见下面 section 标题。
//
// 隔离纪律：未设 GML_DATA_DIR ⇒ 自落到 /tmp/gml-negstock-<脚本名>；
//   指向仓库 data/ 或非 /tmp ⇒ 当场 exit 2 拒跑；每次运行都在隔离目录里 mkdtemp 一个全新库。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DATA = path.join(ROOT, 'data')

const USAGE = '用法：node scripts/test-inv-negative-stock.mjs [cosmetic|food|apparel]'
const INDUSTRIES = ['cosmetic', 'food', 'apparel']
const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('-'))
const industryArgs = argv.filter((a) => !a.startsWith('-'))
const badArgs = [...flags, ...industryArgs.filter((a) => !INDUSTRIES.includes(a))]
if (badArgs.length) {
  console.error(`✗ 未知参数：${badArgs.join(' ')}\n${USAGE}`)
  process.exit(2)
}
const INDUSTRY = industryArgs[0] || 'cosmetic'

function requireIsolatedDataDir() {
  const name = path.basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, '')
  const raw = process.env.GML_DATA_DIR || ''
  const abs = raw ? path.resolve(raw) : path.join('/tmp', `gml-negstock-${name}`)
  if (abs === REPO_DATA || abs.startsWith(REPO_DATA + path.sep)) {
    console.error(`✗ 拒绝运行：隔离目录指向仓库 data/（${abs}）。`)
    process.exit(2)
  }
  if (!abs.startsWith('/tmp/')) {
    console.error(`✗ 拒绝运行：隔离目录必须在 /tmp 下（实得 ${abs}）。`)
    process.exit(2)
  }
  fs.mkdirSync(abs, { recursive: true })
  return { dir: abs, selfFallback: !raw }
}
const { dir: DIR, selfFallback } = requireIsolatedDataDir()
const RUN_DIR = fs.mkdtempSync(path.join(DIR, 'run-'))
process.env.GML_DATA_DIR = RUN_DIR
console.log(`隔离库目录：${RUN_DIR}（仓库 data/ 不会被写）`)

let pass = 0
let fail = 0
const failures = []
const ok = (cond, msg, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`) }
  else { fail += 1; failures.push(msg); console.log(`  ✗ ${msg}${detail !== undefined && detail !== '' ? '  → ' + String(detail).slice(0, 300) : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
function cleanup() {
  const dirs = selfFallback ? [RUN_DIR, DIR] : [RUN_DIR]
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ } }
}

async function main() {
  const { initSchemaFor, DATA_DIR } = await import('../server/db/index.js')
  // 落点自证闸门：钉 env 只有在 import 是 `await import(...)` 时才生效
  if (!String(DATA_DIR).startsWith('/tmp/')) {
    console.error(`✗ 拒绝运行：db/index.js 实际解析出的 DATA_DIR=${DATA_DIR} 不在 /tmp 下（钉 env 没生效），会写仓库 data/。`)
    process.exit(2)
  }
  console.log(`落点自证：db/index.js 实际使用 DATA_DIR=${DATA_DIR}（已过 /tmp 闸门）`)
  const { applyStockIn, applyStockOut, clearParamCache } = await import('../server/lib/stock.js')
  const { SETTING_RULES, SETTING_GROUPS, readSetting, writeSetting, ensureSettings, auditSettingTrail } = await import('../server/lib/settings.js')

  const db = initSchemaFor(INDUSTRY)

  // ---------- 夹具 ----------
  db.prepare(`INSERT OR IGNORE INTO orgs (id, code, name, type, parent_id, level, path, is_legal, owner_org_id, currency, region, status)
    VALUES (1,'HQ','演示总部','group',NULL,1,'/1/',1,1,'CNY','华东','active')`).run()
  db.prepare(`INSERT OR IGNORE INTO orgs (id, code, name, type, parent_id, level, path, is_legal, owner_org_id, currency, region, status)
    VALUES (0,'SYS','系统默认主体','group',NULL,1,'/0/',0,0,'CNY','华东','active')`).run()
  db.prepare("INSERT INTO warehouses (id, code, name, type, currency, org_id, default_owner_org_id, region) VALUES (1,'WH01','演示总仓','central','CNY',1,1,'华东')").run()
  db.prepare("INSERT INTO products (id, spu_code, name, unit) VALUES (1,'SPU-NEG','演示成品','瓶')").run()
  db.prepare("INSERT INTO product_skus (id, product_id, sku_code, name) VALUES (1,1,'SKU-NEG','演示成品')").run()

  const DAY = '2026-10-15'
  applyStockIn(db, { bizDate: DAY, docType: 'PUR_IN', docNo: 'IN-NEG-1', warehouseId: 1, skuId: 1, batchNo: 'N1', qty: 10, unitCost: 10 })

  const out = (qty, source, tag) => {
    try {
      applyStockOut(db, { bizDate: DAY, docType: 'SAL_OUT', docNo: `OUT-${tag}`, warehouseId: 1, skuId: 1, batchNo: 'N1', qty, source })
      return { threw: false }
    } catch (e) {
      return { threw: true, code: e.code, message: e.message || '' }
    }
  }
  const balance = () => db.prepare("SELECT qty_on_hand q FROM inventory_stocks WHERE warehouse_id=1 AND sku_id=1 AND batch_no='N1'").get().q

  section('① 登记表：两个键都在 `SETTING_RULES` 里，字段填对')
  const d1 = SETTING_RULES['inv_allow_negative']
  ok(!!d1, '登记了 inv_allow_negative')
  ok(d1?.group === 'inv', '① group=inv', d1?.group)
  ok(d1?.type === 'bool', '① type=bool（客户要的是"是不是允许"）', d1?.type)
  ok(d1?.default === '0', '① default=0（关）', d1?.default)
  ok(d1?.is_danger === true, '① is_danger=true（改它会动账/动库存行为）', String(d1?.is_danger))
  ok(d1?.wired === true, '① wired=true（有读取点，不是"登记待接"）', String(d1?.wired))
  const d2 = SETTING_RULES['inv_allow_negative_for']
  ok(!!d2 && d2.group === 'inv' && d2.type === 'text' && d2.default === 'pos_offline' && d2.is_danger === true && d2.wired === true,
    '① inv_allow_negative_for：group/type/default/is_danger/wired 全对',
    JSON.stringify({ group: d2?.group, type: d2?.type, default: d2?.default, is_danger: d2?.is_danger, wired: d2?.wired }))
  ok(SETTING_GROUPS.some((g) => g.key === 'inv' && /供应链/.test(g.label)), '① 分组表里有「供应链参数」组', JSON.stringify(SETTING_GROUPS.map((g) => g.key)))

  section('② 默认值 = 改动前的实际行为（"没人管的配置"必须是旧行为）')
  // 改动前：`inv_params.negative_stock` 的默认值就是 '0'（迁移 003），`allow_negative_for` 是 'pos_offline'（004）。
  // 所以"键不存在 / 没人改过"时，实际行为必须是**不放行**。
  const rowsBefore = db.prepare("SELECT COUNT(*) c FROM settings WHERE key IN ('inv_allow_negative','inv_allow_negative_for')").get().c
  ok(rowsBefore === 0, '② 前提：settings 表里还没有这两个键（= 没人管过）', `实得 ${rowsBefore} 行`)
  ok(readSetting(db, 'inv_allow_negative') === false, '② 没人管时读出来是 false（= 不允许负库存 = 旧行为）', String(readSetting(db, 'inv_allow_negative')))
  ok(readSetting(db, 'inv_allow_negative_for') === 'pos_offline', '② 没人管时例外来源是 pos_offline（= 迁移 004 的默认）', String(readSetting(db, 'inv_allow_negative_for')))
  const c1 = out(20, 'web', 'D1')
  ok(c1.threw && c1.code === 'INSUFFICIENT_STOCK', '② 默认（没人管）时超发被拒 → 与改动前一致', `${c1.code} ${c1.message}`)
  ok(balance() === 10, '② 结存没被动过（拒得干净）', String(balance()))

  section('③ 判据已不在 `inv_params`（参数表一套、配置中心一套 = 两份判据，必须消灭）')
  // 直写库：把迁移 003/004 那两个老键改成"允许"——若判据还在参数表，这一步就会放行。
  db.prepare("UPDATE inv_params SET param_value='1' WHERE param_key='negative_stock'").run()
  db.prepare("UPDATE inv_params SET param_value='web' WHERE param_key='allow_negative_for'").run()
  // ⚠️ `getInvParam` 有**进程内缓存**（`lib/stock.js` 的 `paramCache`），而直写库不经过它。
  // 不清缓存的话，这条断言会被上一条用例读过的旧值**掩护过去**（实测：不清缓存 ⇒ 反例注入
  // 退回 inv_params 也照样"通过"，是一条**假绿**）。清一次，这条断言才真的有牙。
  clearParamCache(db)
  const c3 = out(20, 'web', 'D3')
  ok(c3.threw && c3.code === 'INSUFFICIENT_STOCK',
    '③ inv_params 全改成"允许"后**仍然被拒** —— 判据已迁到配置中心，老键不再决定结论',
    `${c3.code} ${c3.message}`)

  section('④ 总开关打开但来源不匹配 ⇒ 仍拒（原来的口径：两个条件都要满足）')
  writeSetting(db, { key: 'inv_allow_negative', value: '1', reason: '用例：验证来源不匹配时不放行', actor: { id: 1, name: '演示管理员' } })
  const c4 = out(20, 'web', 'D4')
  ok(readSetting(db, 'inv_allow_negative') === true, '④ 配置中心里已经是"开"', String(readSetting(db, 'inv_allow_negative')))
  ok(c4.threw, '④ 来源（web）≠ 例外来源（pos_offline）⇒ 仍拒', `${c4.code} ${c4.message}`)

  section('⑤ 来源匹配 ⇒ 放行，结存转负（这是"允许负库存"的合法路径，不能被拦死）')
  writeSetting(db, { key: 'inv_allow_negative_for', value: 'web', reason: '用例：把例外来源改成 web', actor: { id: 1, name: '演示管理员' } })
  const c5 = out(20, 'web', 'D5')
  ok(!c5.threw, '⑤ 两个条件都满足 ⇒ 放行', c5.message)
  ok(balance() === -10, '⑤ 结存真的转成负的（10 − 20 = −10）—— 这就是"负库存"的含义', String(balance()))

  section('⑥ 危险键：修改必须写理由（改它动的是账）')
  let reasonErr = null
  try {
    writeSetting(db, { key: 'inv_allow_negative', value: '0', actor: { id: 1, name: '演示管理员' } })
  } catch (e) {
    reasonErr = e
  }
  ok(reasonErr && reasonErr.code === 'SETTING_REASON_REQUIRED', '⑥ 不带 reason 改危险键 → SETTING_REASON_REQUIRED', reasonErr?.code || '(没有报错)')

  section('⑦ 未登记的键：读、写**双拒**（不许绕开登记表）')
  let writeUnknown = null
  let readUnknown = null
  try { writeSetting(db, { key: 'inv_not_registered', value: '1', reason: '用例' }) } catch (e) { writeUnknown = e }
  try { readSetting(db, 'inv_not_registered') } catch (e) { readUnknown = e }
  ok(writeUnknown && writeUnknown.code === 'SETTING_UNKNOWN', '⑦ 写未登记键 → SETTING_UNKNOWN', writeUnknown?.code || '(没有报错)')
  ok(readUnknown && readUnknown.code === 'SETTING_UNKNOWN', '⑦ 读未登记键 → SETTING_UNKNOWN', readUnknown?.code || '(没有报错)')

  section('⑧ 审计链自证（改了要留痕、重放 == 现状）')
  // `ensureSettings` 是配置的初始化入口（服务启动时会跑）：补齐登记表里登记、库里还没有的键，
  // 并给"有值但无历史"的键补一条 baseline。放在这里而不是夹具处，是因为上面 ② 要的正是
  // "**库里还没有这两个键**时也走旧口径" —— 初始化跑完就把那个前提盖掉了。
  ensureSettings(db)
  const trail = auditSettingTrail(db)
  ok(trail.ok === true, '⑧ auditSettingTrail 全绿', JSON.stringify(trail.problems).slice(0, 240))
  const logged = db.prepare("SELECT COUNT(*) c FROM setting_audit_log WHERE key IN ('inv_allow_negative','inv_allow_negative_for') AND action='set'").get().c
  ok(logged === 2, '⑧ 两次修改各留一条 set 日志', `实得 ${logged} 条`)

  section('⑨ 恢复默认后行为回到旧口径（reset 也要留痕、也要理由）')
  writeSetting(db, { key: 'inv_allow_negative', value: '0', reason: '用例：收尾恢复默认口径', actor: { id: 1, name: '演示管理员' } })
  writeSetting(db, { key: 'inv_allow_negative_for', value: 'pos_offline', reason: '用例：收尾恢复默认口径', actor: { id: 1, name: '演示管理员' } })
  const c9 = out(10, 'web', 'D9')
  ok(c9.threw, '⑨ 恢复默认后再超发仍被拒（默认口径可复现）', `${c9.code} ${c9.message}`)
  ok(auditSettingTrail(db).ok === true, '⑨ 收尾后审计链仍然自证通过')

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (fail) console.log('失败项：\n - ' + failures.join('\n - '))
}

try {
  await main()
} catch (e) {
  fail += 1
  failures.push('脚本异常')
  console.error(`\n✗ 脚本异常：${e && e.stack ? e.stack : e}`)
} finally {
  cleanup()
}
process.exit(fail ? 1 : 0)
