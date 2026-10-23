#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-inv-txn-dict.mjs ｜ 静态守卫：库存流水「字典归属」守卫：钉住 `inventory_transactions` 的两个维度都有权威字典。
 * ============================================================================
 * 【职责】静态守卫：库存流水「字典归属」守卫：钉住 `inventory_transactions` 的两个维度都有权威字典。
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
 * 库存流水「字典归属」守卫：钉住 `inventory_transactions` 的两个维度都有权威字典。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * `inventory_transactions.doc_type` 这一列的 DDL 是裸的 `TEXT NOT NULL`
 * （`server/db/schema.sql`：无 CHECK、无 REFERENCES），取值以 `inv_txn_types`
 * （库存事务类型字典）为准，并兼容 `doc_types`（单据类型注册表）里那张历史单据码。
 * 后果不是报错，而是**"按字典对账"这件事在这一列上失效**：
 *   `lib/accounting.js` 的结转成本按 `doc_type='SAL_OUT'` 取数、
 *   `lib/stock.js` 的 `SALEABLE_ONLY_OUT` 按 doc_type 判可售、
 *   `lib/mfg.js` 的"重复出库/重复入库"判据按 `doc_type='MR'/'MO'` 反查 ——
 *   谁都能往这一列写一个没人认得的码，而**没有任何东西会响**。
 * （`MR` / `MO` 曾是「只在 doc_types、不在 inv_txn_types」的两个码，迁移 `045` 已把它们
 *   补进字典，取「登记跟代码」；见 `045_inv_txn_doc_types.cjs` 顶部注释与交付报告。）
 *
 * 本守卫的判据（**默认档，今天就该全绿**）：
 *   ① `doc_type` 的取值必须 ⊆ `inv_txn_types.code ∪ doc_types.code`，两典都不认的取值数 = 0；
 *   ② `txn_type` 必须非空（它是唯一全覆盖的维度：`lib/stock.js` 的 `writeTxn` 写的是
 *      `p.txnType || p.docType`，目前只有制造链显式传了 `txnType`）；
 *   ④ **双向闭合（客户可新建类型之后的口径）**：
 *      · `inv_txn_types` 的每个码，**要么**有 `lib/stock.js` 的 `DOC_TYPE_LABEL` 文案，
 *        **要么**字典行自己带着名字（`name`）—— 后者是**客户新建类型**走的那条路：
 *        客户在维护页上填的名字本来就该被显示，凭"硬编码文案表里没有"把它判红是错的；
 *      · `DOC_TYPE_LABEL` 的每个键，**必须**还在 `inv_txn_types` 里（这条保持严格：
 *        它守的是"只改了代码那一处"）。
 *      这条判据钉的是「同一个类型定义散落在两处、以后只会改一处」这个形状：
 *      它上线时**当场**抓到 `QC_RET_OUT`（022 只补了字典、没补文案）—— 证明判据是对的。
 *      并附**扫描器自检**（三条）：注入"只有码、没有名字也没有文案"⇒ 必须报；
 *      注入"只有码、但自带名字"（= 客户新建）⇒ **不许报**；注入"只有文案、不在字典"⇒ 必须报。
 *      少了自检，判据哪怕被写反（恒真）也会一直显示全绿。
 *   ⑤ **闸门成员必须有写入点**：凡 `saleable_only=1` 的类型，全仓（`server/`）必须能找到
 *      写它的地方（`docType: '<码>'` 字面量）。
 *      守的是什么：闸门成员从硬编码搬进主数据之后，客户（或我们自己）可以给一条类型打上
 *      `saleable_only=1`，而**没有任何代码会写这种类型** —— 那与 `POS_OUT`/`MALL_OUT`
 *      被塞进硬编码名单是同一个病（"拦一个不会发生的东西"，还会污染用户可见的报错文案）。
 *      §3 第 ⑦ 条要求的"客户新增不许误红"在这条上**不适用**：默认 `saleable_only=0`，
 *      客户新建的类型不会被这条判红；只有"声明它受约束、却没人写它"才红 —— 那是真矛盾。
 *      ⚠️ **两条已知边界**（写在这里，避免下一个人以为它比实际更可靠）：
 *        · 将来若有人用**变量拼** `docType`（`docType: xxx`），本判据会**假红**（fail-loud，
 *          比漏报好）；那时应把它升级成"跟到变量赋值"，而不是把这条删掉；
 *        · `docType:` 这个键名**也被单据内核的流转用**（`applyTransition`），所以这条判据
 *          只保证"有人在某处写过这个码"，不保证"它真的写进了 inventory_transactions"。
 *          方向是**宁可漏报**（假绿）也不假红 —— 与它要替代的那个硬编码名单是同一种取舍。
 *      并附**扫描器自检**：合成一个"被标 true 但没人写"的码 ⇒ 判据必须红。
 *
 * `--strict`（**默认不开，今天会红**）额外查第三件事：
 *   ③ 走标准 `doc_no` 列的单据表，其单号前缀必须 ∈ `doc_types.doc_no_prefix`。
 *      `doc_no_field <> 'doc_no'` 的类型（OM 的 `platform_order_no`、RC 的 `batch_no`）
 *      **不判**，只打印说明 —— 前者是外部平台给的号，不受内核前缀约束。
 *      今天红是因为 `sales_orders` 里有 `XS` 前缀的单号（门店日结取号走的是
 *      `lib/docno.js` 的 `nextDocNo(db, 'XS', ...)`，它**不查** `doc_types`），
 *      而 `doc_types` 里没有 `XS`；顺带也把 `assembly_orders` 里那张 `DS…` 单捞了出来。
 *      这条**故意**放在默认档之外：它牵到内核注册表与 POS 取号两处，要一起动，
 *      不该让本守卫"一上线就红"从而被当成噪音关掉。
 *      ⇒ 它是**能被跑出来看见**的，只是不拦路。
 *
 *      ⚠️ `--strict` 的两条红是**已知项、不是回归失败**（脚本输出里也会逐条标注）：
 *        · `AS`（`assembly_orders`）1 行 `DS…` —— 历史数据，**已决定保留**
 *          （"改历史单号比不改更糟"被明确否决）；新单已全部是 `AS`。
 *        · `SO`（`sales_orders`）若干行 `XS…` —— 门店日结取号走 `lib/pos2.js:872`，
 *          另行安排。
 *      为防"数量扩散"，`--strict` 额外断言 ③b：失败的单据类型**只能是** `AS` / `SO` 这两个；
 *      一旦冒出第三个类型，就是新问题，会额外报一条红（它今天绿）。
 *      注意：**不**把这两条写进"豁免清单"让 ③ 变绿 —— 它们是真实的历史缺口，只是不拦路。
 *
 * 用法：
 *   node scripts/check-inv-txn-dict.mjs            # 默认档（今天全绿才正常）
 *   node scripts/check-inv-txn-dict.mjs --strict   # 加查单号前缀（今天会红，见上）
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 命令行用法错误。
 *
 * 只读：本脚本只用 SELECT，并以 `readonly` + `query_only` 打开库，**不写任何行**。
 *   ⚠️ 但 SQLite 读 WAL 库时仍会在库旁建 `-shm` / `-wal`（实测）。要保证"一个字节都不碰"，
 *   请把库复制到 `/tmp` 后用 `GML_DATA_DIR=<副本目录>` 指过去 —— 这是本项目跑测试的既有约定。
 *
 * 与 `server/db/index.js` 的依赖面**刻意压到最小**（本项目纪律第三条）：
 *   只用它的 `INDUSTRIES` 常量与两个纯路径函数 `requireExplicitDataDir` / `dbPathFor`
 *   （不开连接、不建表），**不调用** `getDb` / `getDbFor` / `initSchema`，也不用 `spawn` 起任何服务端。
 *   下面会把**解析后的绝对路径**逐个打出来 —— "我设了 env" 不构成免责，
 *   能说出"这条命令的每个进程分别落在哪个库"才算。
 *   缺显式 `GML_DATA_DIR` 或指向开发库（`<repo>/data`）⇒ **拒绝运行，退出码 2**（ADR-0019；
 *   原来只是告警，而只读打开仍会在开发库旁建 -shm/-wal）。
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { INDUSTRIES, requireExplicitDataDir, dbPathFor } from '../server/db/index.js'
// 「两处必须一致」的那另一处就是 `DOC_TYPE_LABEL`（库存流水类型的**中文文案**，
// 前端台账页显示的就是它：`/meta/dict` 的 `stock_doc_types` 与 `/inventory/ledger` 的
// `doc_type_name` 都取自这一份）。这里只取它的常量表，不调用 stock.js 的任何函数 ——
// 模块加载期无 I/O（已实测：纯 import 不建连接、不落文件）。
import { DOC_TYPE_LABEL } from '../server/lib/stock.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 解析后的绝对数据目录 —— 打印以它为准；缺省/仓库 data/ 在这里就拒绝 */
let DATA_DIR_ABS
try {
  DATA_DIR_ABS = path.resolve(requireExplicitDataDir())
} catch (e) {
  console.error(`${e.code}: ${e.message}`)
  process.exit(2)
}

const USAGE = [
  '用法：node scripts/check-inv-txn-dict.mjs [--strict]',
  '  （无参数）：查 inventory_transactions 的 doc_type 归属、txn_type 非空，',
  '              以及 inv_txn_types 与 lib/stock.js 的 DOC_TYPE_LABEL 双向闭合',
  '  --strict ：额外查「每张单据表的单号前缀 ∈ doc_types.doc_no_prefix」（今天会红，见文件头）'
].join('\n')

const argv = process.argv.slice(2)
const STRICT = argv.includes('--strict')
const unknownArgs = argv.filter((a) => a !== '--strict')
if (unknownArgs.length) {
  console.error(`✗ 未知参数：${unknownArgs.join(' ')}\n`)
  console.error(USAGE)
  process.exit(2)
}

let pass = 0
let failed = 0
const failNames = []
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    failNames.push(name)
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

/** 只读打开；库文件不存在直接报错（不静默返回"全绿"） */
function openRo(file) {
  if (!fs.existsSync(file)) throw new Error(`库文件不存在：${file}`)
  const db = new Database(file, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  return db
}

const rowsOf = (db, sql, ...args) => db.prepare(sql).all(...args)
const hasTable = (db, t) => !!db.prepare("SELECT 1 h FROM sqlite_master WHERE type='table' AND name=?").get(t)
const hasColumn = (db, t, c) => rowsOf(db, `PRAGMA table_info(${t})`).some((r) => r.name === c)

/**
 * 「这个库到底有没有这张表 / 这几列」的**统一探针**：读任何**迁移才会加上**的表/列之前必须先过它。
 *
 * 为什么必须有它（实测事故）：判据 ⑤ 直接 `SELECT code FROM inv_txn_types WHERE saleable_only=1`，
 * 而**没跑过迁移 047 的库没有这一列** ⇒ 守卫**抛栈退出**：
 *     `SqliteError: no such column: saleable_only`
 * 而"库还没跑迁移"是一个**完全合法的库状态**（服务还没重启、副本是迁移前拷的）——
 * 于是**一条合法状态**被报告成"**脚本坏了**"，下一个人会去查脚本，而不是去跑 `migrate`。
 * 本项目规矩是**失败必须可读**：这里返回一句**带库名**的人话（三库同名表不同文件，
 * 不带库名根本没法定位），交给断言当 detail 用，**不抛栈**。
 * 返回 `null` = 都在；返回字符串 = 缺什么。
 */
function missingFor(db, table, columns = []) {
  if (!hasTable(db, table)) return `缺表 ${table}`
  const miss = columns.filter((c) => !hasColumn(db, table, c))
  return miss.length ? `缺列 ${table}.${miss.join(' / ')}` : null
}

/** 缺表/缺列时统一的那句人话（**带库名**，并区分"库没迁移"与"脚本坏了"） */
function missingHint(code, missing, todo) {
  return (
    `⚠️ [${code}] 库${missing} —— ${todo}；本判据**无法判定**（不是"通过"）。` +
    `请先跑 \`node scripts/migrate.mjs\` 或重建该库。**这不是脚本坏了** —— ` +
    `库处于"还没跑迁移"的合法状态（服务未重启 / 副本是迁移前拷的），守卫照旧要把它说清楚。`
  )
}

/**
 * 判据 ④ 的纯函数：字典行 ⇄ 文案键 的**双向差集**。
 *   nameless   = 在字典里、既没有文案、字典行自己也没名字的码（"谁都说不出它叫什么"）；
 *   extraLabel = 有文案、却不在字典里的键（"只补了代码那半边"）。
 *
 * 为什么 `name` 也算数：客户可以自己新建类型（维护页上填名字），
 * 那种码**本来就不该出现在硬编码文案表里** —— 拿"文案表里查不到"判它红是错的。
 *
 * 单独抽成纯函数是为了让**扫描器自检**能往同一判据里注入合成行，
 * 证明它真的会红、也证明它**不会误报**（客户新建那条路必须放行）。
 * 返回**全部**差集元素（不是布尔）："少判一条就报"靠的是逐条列出。
 */
function closureDiff(dictRows, labelKeys) {
  const labels = new Set(labelKeys)
  const codes = new Set(dictRows.map((r) => r.code))
  return {
    nameless: dictRows
      .filter((r) => !labels.has(r.code) && !String(r.name || '').trim())
      .map((r) => r.code)
      .sort(),
    extraLabel: [...labels].filter((c) => !codes.has(c)).sort()
  }
}

/** `--strict` 的已知项：长期红、**非**本轮回归失败。只用于输出标注与「是否扩散」断言。 */
const KNOWN_STRICT_PREFIX = {
  AS: '历史数据（assembly_orders 那张 DS… 单）—— 已决定保留，改历史单号比不改更糟；新单已全部是 AS',
  SO: '门店日结取号走 lib/pos2.js:872 —— 另行安排'
}

// ---------------------------------------------------------------------------
// 判据 ⑤ 的原料：**全仓有哪些码真的被写出过**
// ---------------------------------------------------------------------------
// 只扫 `server/`（产品代码）。**不扫 `scripts/`**：测试里写一个码不构成"产品会写它"，
// 把它算成写入点会让这条判据变成"测试覆盖过就算接线"—— 那是假保险（本项目最贵的一类缺陷）。
const WRITE_SCAN_ROOT = path.join(ROOT, 'server')
const DOC_TYPE_LITERAL = /docType\s*:\s*'([A-Z][A-Z0-9_]{0,23})'/g

function scanWritePointCodes() {
  const found = new Set()
  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(p)
    }
  }
  walk(WRITE_SCAN_ROOT)
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    let m
    while ((m = DOC_TYPE_LITERAL.exec(src))) found.add(m[1])
  }
  return { codes: found, files: files.length }
}

/**
 * 判据 ⑤ 的纯函数：`saleable_only=1` 的码里，哪些在全仓找不到写入点。
 * 抽成纯函数是为了让扫描器自检能注入合成码（证明它真的会红）。
 */
function gateWithoutWriter(gateCodes, writeCodes) {
  const written = new Set(writeCodes)
  return [...gateCodes].filter((c) => !written.has(c)).sort()
}

console.log(`库存流水字典守卫${STRICT ? '（--strict：含单号前缀）' : ''}`)
console.log(`数据目录（解析后绝对路径）：${DATA_DIR_ABS}`)
console.log('─'.repeat(66))

// ---- 判据 ⑤ 的原料 + 扫描器自检（与具体库无关，先算一次）----
const WRITE_POINTS = scanWritePointCodes()
console.log(
  `判据⑤原料：扫描 server/ 下 ${WRITE_POINTS.files} 个 .js，` +
    `找到 ${WRITE_POINTS.codes.size} 个「被写出来的码」`
)
{
  const probe = gateWithoutWriter([...WRITE_POINTS.codes, '__PROBE_NO_WRITER__'], [...WRITE_POINTS.codes])
  const clean = gateWithoutWriter([...WRITE_POINTS.codes], [...WRITE_POINTS.codes])
  ok(
    '⑤ 扫描器自检：合成一个「被标 saleable_only=1 但全仓没人写」的码 ⇒ 只报该码（真写入的码不报）',
    JSON.stringify(probe) === JSON.stringify(['__PROBE_NO_WRITER__']) && clean.length === 0,
    `probe=${JSON.stringify(probe)} clean=${JSON.stringify(clean)}`
  )
}

let scannedTxns = 0
const selectedIndustries = process.env.GML_TEST_INDUSTRIES
  ? process.env.GML_TEST_INDUSTRIES.split(',').map(x => x.trim()) : Object.keys(INDUSTRIES)
if (!selectedIndustries.length || selectedIndustries.some(x => !Object.hasOwn(INDUSTRIES, x))) throw new Error('Invalid GML_TEST_INDUSTRIES')
for (const code of selectedIndustries) {
  const file = dbPathFor(code)
  console.log(`\n===== [${code}] ${file} =====`)
  const db = openRo(file)
  try {
    // ---- 扫描面自证：0 行不是"大家都对"，是本守卫指错了表 ----
    // ⚠️ 先探**结构**再读数：库可以是"还没跑迁移"的合法状态，那时新列/新表根本不存在。
    //    （实测：直接读 `saleable_only` 会让守卫抛 `SqliteError: no such column` 退出 ——
    //     "库没迁移"被报告成"脚本坏了"。见 `missingFor` 的注释。）
    const CORE_READS = [
      ['inventory_transactions', ['doc_type', 'txn_type']],
      ['inv_txn_types', ['code', 'name']],
      ['doc_types', ['code']]
    ]
    const coreMissing = CORE_READS.map(([t, cs]) => missingFor(db, t, cs)).filter(Boolean)
    const stats = coreMissing.length
      ? null
      : {
          txn: db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c,
          dict: db.prepare('SELECT COUNT(*) c FROM inv_txn_types').get().c,
          type: db.prepare('SELECT COUNT(*) c FROM doc_types').get().c
        }
    if (stats) scannedTxns += stats.txn
    ok(
      '扫描面自证：三张表都有数据（且本守卫要读的列都在）',
      !!stats && stats.txn > 0 && stats.dict > 0 && stats.type > 0,
      coreMissing.length
        ? missingHint(code, coreMissing.join('；'), '该库还没跑到这一步的迁移，本库的判据**全部**无法判定')
        : `流水 ${stats.txn} 行 / 事务类型字典 ${stats.dict} 码 / 单据类型注册表 ${stats.type} 条`
    )
    // 结构不全 ⇒ 本库后面的判据全部**无法判定**：与其抛栈，不如在这里把话说清然后收手。
    if (coreMissing.length) continue

    // ---- ① doc_type 必须落在两个字典的并集里 ----
    const offenders = rowsOf(
      db,
      `SELECT t.doc_type, COUNT(*) c
         FROM inventory_transactions t
         LEFT JOIN inv_txn_types d1 ON d1.code = t.doc_type
         LEFT JOIN doc_types     d2 ON d2.code = t.doc_type
        WHERE d1.code IS NULL AND d2.code IS NULL
        GROUP BY t.doc_type
        ORDER BY c DESC`
    )
    const distinct = db.prepare('SELECT COUNT(DISTINCT doc_type) c FROM inventory_transactions').get().c
    ok(
      `① 扫描 ${distinct} 种 doc_type 取值，全部 ∈ inv_txn_types ∪ doc_types`,
      offenders.length === 0,
      offenders.length
        ? `两典都不认识的取值 ${offenders.length} 种：${offenders.map((r) => `${r.doc_type}(${r.c} 行)`).join(' / ')}`
        : ''
    )

    // 分片实况（不是断言，是"这一列的语义被谁解释"的可读证据）：
    //   它回答"这一列到底有几个字典在管"，出问题时不必再手工 join 一遍。
    const byDict = rowsOf(
      db,
      `SELECT CASE WHEN d1.code IS NOT NULL THEN 'inv_txn_types' WHEN d2.code IS NOT NULL THEN 'doc_types' ELSE 'NONE' END src,
              COUNT(DISTINCT t.doc_type) kinds, COUNT(*) c
         FROM inventory_transactions t
         LEFT JOIN inv_txn_types d1 ON d1.code = t.doc_type
         LEFT JOIN doc_types     d2 ON d2.code = t.doc_type
        GROUP BY src ORDER BY c DESC`
    )
    console.log(`      归属实况：${byDict.map((r) => `${r.src} ${r.kinds} 种/${r.c} 行`).join('  |  ')}`)
    const bothDict = rowsOf(
      db,
      `SELECT COUNT(*) c FROM inventory_transactions t
        WHERE EXISTS (SELECT 1 FROM inv_txn_types d1 WHERE d1.code=t.doc_type)
          AND EXISTS (SELECT 1 FROM doc_types     d2 WHERE d2.code=t.doc_type)`
    )[0].c
    console.log(`      两典同时认得的行数：${bothDict}（>0 说明这一列确实是"两个语义混在一列"）`)

    // ---- ② txn_type 非空（唯一全覆盖维度）----
    const blankTxnType = db.prepare(
      "SELECT COUNT(*) c FROM inventory_transactions WHERE txn_type IS NULL OR TRIM(txn_type) = ''"
    ).get().c
    ok(
      '② txn_type 无空值（它是唯一覆盖全表的维度，空了就没有任何维度可对账）',
      blankTxnType === 0,
      blankTxnType ? `空值 ${blankTxnType} 行` : ''
    )

    // ---- ④ 字典码 ⇄ 文案键 双向闭合（钉「同一个类型定义散落在两处」）----
    // 只增字典不增文案（022 的 QC_RET_OUT）或只增代码不增字典，都会在这里红；
    // 而"客户新建类型"（字典行自带 name、硬编码文案表里没有）**不红** —— 见 closureDiff 注释。
    const dictRows = rowsOf(db, 'SELECT code, name FROM inv_txn_types ORDER BY code')
    const labelKeys = Object.keys(DOC_TYPE_LABEL)
    const cdiff = closureDiff(dictRows, labelKeys)
    const withLabel = dictRows.filter((r) => labelKeys.includes(r.code)).length
    const byDictName = dictRows.filter((r) => !labelKeys.includes(r.code) && String(r.name || '').trim()).length
    ok(
      `④ ${dictRows.length} 个字典码（${withLabel} 个有文案 / ${byDictName} 个靠字典名）` +
        ` ⇄ ${labelKeys.length} 个 DOC_TYPE_LABEL 文案键，双向闭合`,
      cdiff.nameless.length === 0 && cdiff.extraLabel.length === 0,
      [
        cdiff.nameless.length
          ? `字典里有码、既没文案也没字典名 ${cdiff.nameless.length} 个：${cdiff.nameless.join(' / ')}`
          : '',
        cdiff.extraLabel.length
          ? `有文案、却不在字典里 ${cdiff.extraLabel.length} 个：${cdiff.extraLabel.join(' / ')}`
          : ''
      ].filter(Boolean).join('；')
    )

    // ---- ④ 扫描器自检：把合成行/合成键注入**同一判据**，断言「该红的红、该绿的绿」----
    // 少了这一步，判据哪怕被写反（恒真）也照样全绿 —— 用同一个函数验证才不会自证。
    // 断言写成「注入探针只造成**探针本身**这一处差异」：既证明探针被抓到，
    // 又证明判据不会乱报（恒真地"什么都报"同样会被抓）。与真实数据是否闭合**无关**，
    // 所以数据本身有缺口时，自检不会跟着变红（信号不互相污染）。
    {
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
      const p1 = closureDiff([...dictRows, { code: '__PROBE_NO_NAME__', name: '' }], labelKeys)
      ok(
        '④ 扫描器自检：注入「字典里没名字、文案表里也没有」的合成码 ⇒ 只多报该码',
        same(p1.nameless, [...cdiff.nameless, '__PROBE_NO_NAME__'].sort()) && same(p1.extraLabel, cdiff.extraLabel),
        `nameless=${JSON.stringify(p1.nameless)} extraLabel=${JSON.stringify(p1.extraLabel)}`
      )
      // 这一条是**客户可新建类型**的保证：字典行自带名字就必须放行，不许误判红。
      const p2 = closureDiff([...dictRows, { code: '__PROBE_NAMED__', name: '探针命名类型' }], labelKeys)
      ok(
        '④ 扫描器自检：注入「只有字典名、没有文案」的合成码（= 客户新建）⇒ **不许**被判红',
        same(p2.nameless, cdiff.nameless) && same(p2.extraLabel, cdiff.extraLabel),
        `nameless=${JSON.stringify(p2.nameless)} extraLabel=${JSON.stringify(p2.extraLabel)}`
      )
      const p3 = closureDiff(dictRows, [...labelKeys, '__PROBE_NO_DICT__'])
      ok(
        '④ 扫描器自检：注入「只有文案、不在字典」的合成键 ⇒ 只多报该键',
        same(p3.extraLabel, [...cdiff.extraLabel, '__PROBE_NO_DICT__'].sort()) && same(p3.nameless, cdiff.nameless),
        `nameless=${JSON.stringify(p3.nameless)} extraLabel=${JSON.stringify(p3.extraLabel)}`
      )
    }

    // ---- ⑤ 闸门成员必须有写入点（`saleable_only=1` ⇒ 全仓有人写它）----
    // 守的是"拦一个不会发生的东西"这个病（`POS_OUT`/`MALL_OUT` 当年就是这样被塞进硬编码名单的）。
    // ⚠️ `saleable_only` 是**迁移 047 才加上的列** —— 没跑 047 的库直接读会抛栈（实测过），
    //    所以先探列；缺了 ⇒ **显式失败 + 带库名的人话**（"无法判定"不是"通过"）。
    const missGate = missingFor(db, 'inv_txn_types', ['saleable_only'])
    if (missGate) {
      ok('⑤ 受闸门约束的类型（saleable_only=1）都有写入点', false, missingHint(code, missGate, '判据⑤（迁移 047 的 saleable_only）无法判定'))
    } else {
      const gateCodes = rowsOf(db, 'SELECT code FROM inv_txn_types WHERE saleable_only=1').map((r) => r.code)
      const noWriter = gateWithoutWriter(gateCodes, [...WRITE_POINTS.codes])
      ok(
        `⑤ ${gateCodes.length} 个受闸门约束的类型（saleable_only=1）都有写入点`,
        noWriter.length === 0,
        noWriter.length
          ? `被标成受约束、却在 server/ 下找不到任何 docType:'<码>' 的 ${noWriter.length} 个：${noWriter.join(' / ')}`
          : ''
      )
    }

    // ---- ③（--strict）单号前缀必须 ∈ doc_types.doc_no_prefix ----
    // 只对**内核自己发号的 `doc_no` 列**下硬判据。`doc_no_field <> 'doc_no'` 的类型
    // （OM 的 `platform_order_no` = 平台给的单号、RC 的 `batch_no`）走"说明"而不是"失败"：
    // 它们的值是外部系统/另一套编号给的，不受 `doc_no_prefix` 约束 ——
    // 把这三种混在一起判，会让守卫第一天就红成噪音，然后被人关掉。
    if (STRICT) {
      // 同一条纪律：`doc_no_prefix` 也不是每张老库都有 —— 先探列再读，缺了给可读失败。
      const missStrict = missingFor(db, 'doc_types', ['doc_no_prefix'])
      if (missStrict) {
        ok('③（--strict）单号前缀都 ∈ doc_types.doc_no_prefix', false, missingHint(code, missStrict, '--strict 这一档无法判定'))
      }
    }
    if (STRICT && !missingFor(db, 'doc_types', ['doc_no_prefix'])) {
      const registered = new Set(
        rowsOf(db, "SELECT DISTINCT doc_no_prefix FROM doc_types WHERE doc_no_prefix IS NOT NULL AND doc_no_prefix <> ''").map((r) => r.doc_no_prefix)
      )
      const skipped = []
      const noted = []
      const badCodes = new Set()
      let badTypes = 0
      for (const t of rowsOf(db, 'SELECT code, table_name, doc_no_field, doc_no_prefix FROM doc_types ORDER BY code')) {
        if (!hasTable(db, t.table_name)) { skipped.push(`${t.code}(表不存在)`); continue }
        if (!hasColumn(db, t.table_name, t.doc_no_field)) { skipped.push(`${t.code}(无列 ${t.doc_no_field})`); continue }
        const total = db.prepare(`SELECT COUNT(*) c FROM ${t.table_name} WHERE ${t.doc_no_field} IS NOT NULL AND TRIM(${t.doc_no_field}) <> ''`).get().c
        if (!total) continue
        if (t.doc_no_field !== 'doc_no') {
          const pref = t.doc_no_field === 'platform_order_no' ? '外部平台单号' : '内核另立的单号列'
          noted.push(`${t.code}(${t.doc_no_field}：${pref})`)
          continue
        }
        if (!t.doc_no_prefix) { skipped.push(`${t.code}(未注册前缀)`); continue }
        const pred = `doc_no IS NOT NULL AND TRIM(doc_no) <> '' AND substr(doc_no, 1, ?) <> ?`
        const args = [String(t.doc_no_prefix).length, String(t.doc_no_prefix)]
        const n = db.prepare(`SELECT COUNT(*) c FROM ${t.table_name} WHERE ${pred}`).get(...args).c
        if (!n) continue
        badTypes += 1
        // 真正有用的是"跑出来的是哪些前缀"——只说"前缀不符"没法定位是哪套号混进来了
        const actual = rowsOf(
          db,
          `SELECT substr(doc_no, 1, ?) p, COUNT(*) c FROM ${t.table_name} WHERE ${pred} GROUP BY p ORDER BY c DESC LIMIT 5`,
          String(t.doc_no_prefix).length, ...args
        )
        const unregistered = actual.filter((x) => !registered.has(String(x.p)))
        badCodes.add(t.code)
        const knownNote = KNOWN_STRICT_PREFIX[t.code]
        ok(
          `③ ${t.code}（${t.table_name}）的单号前缀都等于内核注册的「${t.doc_no_prefix}」` +
            (knownNote ? '  ← 已知项，非回归失败' : ''),
          false,
          `${n} 行不符：${actual.map((x) => `${x.p}…(${x.c} 行)`).join(' / ')}` +
            (unregistered.length ? ` —— 其中 ${unregistered.map((x) => `「${x.p}」`).join('、')} 不在 doc_types.doc_no_prefix 里` : '') +
            (knownNote ? `\n      已知项说明：${knownNote}` : '')
        )
      }
      if (!badTypes) ok('③ 所有走 doc_no 的标准单据表，前缀都等于内核注册值', true, '')
      // ③b 防扩散：失败类型只能是已知项 AS / SO。冒出第三个 ⇒ 新问题（这条今天绿）。
      const unknownBad = [...badCodes].filter((c) => !(c in KNOWN_STRICT_PREFIX)).sort()
      ok(
        `③b 前缀失败的类型未扩散：只有已知项 ${Object.keys(KNOWN_STRICT_PREFIX).join(' / ')}（新出类型即报）`,
        unknownBad.length === 0,
        unknownBad.length ? `出现已知项之外的类型：${unknownBad.join(' / ')}` : `本次失败类型：${[...badCodes].sort().join(' / ') || '无'}`
      )
      if (badCodes.size) {
        console.log('      ⚠️ 上面 ③ 的红是**已知项、非本轮回归失败**（不写进豁免、不改成绿）：')
        for (const c of [...badCodes].sort()) {
          console.log(`         · ${c}：${KNOWN_STRICT_PREFIX[c] || '⚠️ 未登记为已知项 —— 请当新问题看'}`)
        }
      }
      console.log(`      不判（非内核发号）：${noted.length ? noted.join(' / ') : '无'}`)
      console.log(`      跳过（不适用）：${skipped.length ? skipped.join(' / ') : '无'}`)
    }
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
console.log('\n' + '─'.repeat(66))
if (scannedTxns === 0) {
  console.log('✗ 一条流水都没扫到 —— 这不是"大家都对"，是守卫没找到库（检查 GML_DATA_DIR）')
  failed += 1
  failNames.push('扫描面自证（全库）')
}
if (!STRICT) console.log('（未开 --strict；单号前缀那一档今天会红，需要时请手动跑 --strict）')
if (failed) console.log(`失败断言：${failNames.join(' / ')}`)
console.log(`计数 通过 ${pass} / 失败 ${failed}`)
process.exitCode = failed ? 1 : 0
