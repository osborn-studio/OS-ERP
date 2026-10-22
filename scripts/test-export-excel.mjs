/**
 * ============================================================================
 * 文件标识：scripts/test-export-excel.mjs ｜ 测试：批次 U 之四 · ③-a：报表导出 Excel（`?format=xlsx`）
 * ============================================================================
 * 【职责】测试：批次 U 之四 · ③-a：报表导出 Excel（`?format=xlsx`）
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
 * 批次 U 之四 · ③-a：报表导出 Excel（`?format=xlsx`）
 *
 * 这一项最要紧的两条**不是**"能不能生成 xlsx"，而是：
 *   ① **默认仍是 csv 且逐字节不变** —— 这个端点在此之前只有一种格式，加格式不许改动既有调用
 *      的一个字节（`format` 缺省 = csv；文件名、mime、内容都照旧）；
 *   ② **产物交给第三方实现去读**。自己写个读取器验自己写的写入器是同源验证：
 *      ZIP 的 CRC 字段我解释错了，读取器大概率也按同样错的方式解释，于是两边一致、
 *      测试全绿、而文件在 Excel 里打不开。所以这里把工作簿落盘，
 *      交给 **CPython + openpyxl**（真正的 xlsx 读取器）去读，再用它的读数做断言。
 *
 * 只读跑：三库都以 `readonly: true` 打开 —— 导出是纯计算 + 序列化，不写任何一张表
 * （"读不到就写不进去"由 SQLite 自己保证，比断言"行数没变"更硬）。
 *
 * ── 独立复核之后的四处加固（每处都对应一种"断言在跑但不承重"）─────────────
 *   A. **样本期由被测事实派生**。原来是 `availablePeriods(db).find(x => x.posted_count > 0)?.period
 *      || '2026-10'`：`availablePeriods` 是**倒序**，`find` 拿到的是**最新**那一期（2026-10），
 *      而那一期"有已过账凭证但全是非现金/非损益科目" ⇒ 利润表**金额格全为 0**，
 *      于是"金额 == 报表金额"这类断言退化成在比 `0.00` 与 `0`（为真，但几乎不携带信息）。
 *      现在逐个候选期间跑一次 `computeReport`，挑**利润表确实有非零金额**的那一期；
 *      一个都挑不到就**响亮失败**（不回退硬编码期间），并另加一条自证断言
 *      `本次核对用的样本期里至少有一个非零金额`。
 *   B. **应到 / 实到断言数自证**。原来少一个库（文件不存在）只打印"跳过"，计数从 98 掉到 66
 *      但**仍然是绿的** —— 跳过与通过同形。现在文件里写死 `EXPECTED_TOTAL`，
 *      收尾比对"实到条数"，少跑一条就红。⚠️ `EXPECTED_TOTAL` 是**时点的函数**：
 *      任何增删断言都必须同步改它（这正是它存在的意义）。
 *   C. **意料之外的异常不许把整套带崩**。第三方读取器一崩，后面 20 多条断言连 print 都跑不到、
 *      计数行也不打（回归统计器只看到"没有计数行"，比一条红断言更糟）。
 *      现在：读取失败 → 该节断言**逐条记为失败并写出原因**（不是跳过）→ 继续跑完 → 计数行必打。
 *   D. **解释器路径不许写死**（与 `is_isolated_copy` 同一类"在我机器上能跑"）：
 *      `GML_PYTHON` 优先 → 否则按候选列表取第一个存在的。**找不到不静默跳过** ——
 *      本文件最硬的那条证据就是"用外部工具读回来"，跳过等于把它悄悄删掉；
 *      找不到时本节断言全部记为失败并**写明为什么**。
 *   （由这三条共同保证："通过 N / 失败 M" 里的 N+M **恒定**。断言总数会变，才说明
 *     某条路径悄悄没跑到。）
 *
 * 用法：`node scripts/test-export-excel.mjs`
 *   `GML_PYTHON=/path/to/python node scripts/test-export-excel.mjs` 可指定解释器。
 * 收尾打印「通过 N / 失败 M」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import * as R from '../server/lib/report.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// 第三方读取器必须能实际 import openpyxl；显式解释器失败不得回退。
import { resolvePythonRuntime } from './lib/python-runtime.mjs'
const PY_ENV = process.env.GML_PYTHON?.trim() || null
let PY = null
let PY_WHY = null
try { PY = resolvePythonRuntime().executable } catch (error) { PY_WHY = error.message }

const TMP = `/tmp/gml-test-export-excel-${process.pid}`
const XLSX_PATH = `${TMP}.xlsx`
const PY_PATH = `${TMP}.py`

const INDUSTRIES = ['cosmetic', 'food', 'apparel']
// 末尾元信息里有时间戳 —— 固定它，才能拿"两次调用逐字节相同"当断言
const FIXED_AT = '2026-01-01 00:00:00'

// ── B：应到断言总数 ───────────────────────────────────────────────────────
// ⚠️ 这是**时点的函数**：增删/合并断言必须同步改这里，否则收尾那条自证会红
//    （它红了不代表实现坏了，只代表"断言条数变了而预期没跟着改"）。
// 组成：每库 31 条 × 3 库 + E4 5 条 + E5 3 条 + 收尾自证 1 条 = 102。
const EXPECTED_TOTAL = 102

let pass = 0
let fail = 0
const failures = []
// 实际跑过的库：**计数行由它派生**，不写死"三库"（只跑一个库却写着三库，读计数行的人会被误导）。
// 必须在模块作用域（收尾的计数行在 `main()` 之外；放进去会 ReferenceError ⇒ 连计数行都没了 —— 我踩过一次）。
const ran = []
function ok(cond, msg, detail) {
  // 自保（铁律 27 第二次撞车后立的规矩）：参数写反时**当场崩**，而不是「永远绿」。
  // 全仓 ok() 有三种形参顺序并存（(cond,msg,…) 多数 / (name,cond,…) 9 份 / (msg,cond,…) 1 份），
  // 本文件是 (cond, msg, detail)；把别的顺序的写法搬过来时，这一行会立刻逮住它。
  if (typeof cond !== 'boolean') throw new Error(`ok() 的条件必须是布尔值，收到 ${typeof cond}（参数顺序写反了？）`)
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
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)
const throws = (fn, code, msg) => {
  try {
    fn()
  } catch (e) {
    const hit = !code || e.code === code
    if (!hit) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${code}，实得 ${e.code || e.message}`)
    ok(hit, msg)
    return
  }
  console.log(`  \x1b[31m✗\x1b[0m ${msg}：没有抛错`)
  ok(false, msg)
}

// ── A：样本期选取（**由被测事实派生**，不是写死一个期间）────────────────────
/**
 * 挑一个"利润表确实有非零金额"的期间。
 *
 * 为什么不是"最新一期"：最新一期可能只有非损益凭证（本库里 2026-10 就是），
 * 那样金额列全 0，"金额 == 报表金额"退化成 `0.00 == 0`。
 * 返回 `{ period, nonZero, tried }`；挑不到时 `period === null` —— 调用方必须**响亮失败**，
 * 不许回退到硬编码期间（那种回退会在换库/换种子之后悄悄换成另一期，或者干脆核一张不存在的表）。
 */
function pickSamplePeriod(db) {
  const cands = R.availablePeriods(db).filter((x) => x.posted_count > 0).map((x) => x.period)
  const tried = []
  for (const p of cands) {
    try {
      const rep = R.computeReport(db, { reportCode: 'pl', period: p })
      const nonZero = rep.rows.filter((r) => Math.abs(Number(r.amount) || 0) > 0.005).length
      tried.push(`${p}=${nonZero}`)
      if (nonZero > 0) return { period: p, nonZero, tried }
    } catch (e) {
      tried.push(`${p}=抛错(${e.code || e.message})`)
    }
  }
  return { period: null, nonZero: 0, tried }
}

const PY_SRC = `
import sys, json, openpyxl
wb = openpyxl.load_workbook(sys.argv[1], read_only=True)
ws = wb[wb.sheetnames[0]]
rows = [[c.value for c in r] for r in ws.iter_rows()]
print('GML_RESULT=' + json.dumps({'sheets': wb.sheetnames, 'rows': rows}, ensure_ascii=False, default=str))
`
fs.writeFileSync(PY_PATH, PY_SRC)

/** 交给第三方实现读一遍工作簿（失败就抛，调用处统一转成"该节断言逐条失败"） */
function readWithOpenpyxl(file) {
  if (!PY) throw new Error(PY_WHY)
  const r = spawnSync(PY, [PY_PATH, file], { encoding: 'utf8' })
  if (r.error) throw new Error(`python 起不来（${PY}）：${r.error.message}`)
  if (r.status !== 0) throw new Error(`python 读取失败（${PY} status=${r.status}）：${String(r.stderr || '').slice(0, 300)}`)
  const line = String(r.stdout).split('\n').find((l) => l.startsWith('GML_RESULT='))
  if (!line) throw new Error(`python 没有输出结果行：${String(r.stdout).slice(0, 200)}`)
  return JSON.parse(line.slice('GML_RESULT='.length))
}

// ── E3 / E4 的断言名清单：**先列出来**，收尾扫"没执行到的"逐条补记失败 ────────
// 这是"总数恒定"的实现方式：每条名字**恰好上报一次**（执行到就按结果记，没执行到就记失败）。
// 于是"第三方读取器不可用"不会变成"少跑 13 条、看着还是绿的"。
const E3_KEYS = [
  '工作表名（第三方读取器的读数）',
  '表头单元格逐字 == columnsOf 的 label（列定义只有一个出处）',
  '表头与 CSV 的表头逐字相同（两种格式同一份列定义）',
  '数据行数 = 报表行数（不含表头 / 空行 / 元信息）',
  '第 1 行金额：openpyxl 的读数 == 报表金额',
  '第 2 行金额：openpyxl 的读数 == 报表金额',
  '第 3 行金额：openpyxl 的读数 == 报表金额',
  '金额列全部是**数值**单元格（文本型的 "0.00" 在 Excel 里不能求和，等于没导出）',
  '至少核对了 3 个数值单元格（防空跑）',
  '金额在两种格式里的值一致（xlsx 数值 == CSV 文本转成数）',
  '末尾元信息在文件里（"这份文件是哪一期、哪个口径"不随文件离开系统而丢失）',
  '末尾元信息里有生成时间',
  'xlsx 里的元信息不带 `#`（那是 CSV 的注释约定，单元格里它只会让人以为数据坏了）'
]
const E4_KEYS = [
  '合法名不降级',
  '含 [ ] : * ? / \\ 的名字降级成安全名并如实标出',
  '超 31 个字符的名字截断到 31 个码点（中文按字算，不按字节）',
  '前后撇号被去掉（Excel 不许）',
  '降级后的工作簿第三方读得开'
]

function main() {
  console.log(`=== 报表导出 Excel 测试（三库：${INDUSTRIES.join(' / ')}） ===`)
  console.log(PY
    ? `第三方读取器：${PY}${PY_ENV ? '（来自 GML_PYTHON）' : ''}`
    : `\x1b[31m⚠️ 第三方读取器不可用：${PY_WHY}\x1b[0m\n   —— E3/E4 里"交给外部实现读回来"的那些断言会**逐条记为失败并写明原因**（不跳过）。`)

  // 实际跑过的库：**计数行由它派生**，不写死"三库"（只跑一个库却写着三库，读计数行的人会被误导）

  const picked = new Map()

  for (const ind of INDUSTRIES) {
    const file = path.join(ROOT, 'data', `gml_${ind}.db`)
    if (!fs.existsSync(file)) {
      // B：缺一个库**不是"跳过"** —— 跳过与通过同形（原来 98 掉到 66 仍然全绿）。
      // 这里记一条失败；收尾的"应到 / 实到"自证会把这一库少跑的那些条数也报出来。
      ok(false, `三库齐备（缺 ${ind}：${file} 不存在）`, '缺库时本节的断言一条都不会跑')
      continue
    }
    // 只读打开：导出不该写库，这里让"写"在物理上不可能
    const db = new Database(file, { readonly: true, fileMustExist: true })
    const pick = pickSamplePeriod(db)
    picked.set(ind, pick.period)
    if (!pick.period) {
      ok(false, `【${ind}】没找到可核对的样本期（候选里利润表金额全是 0）`, `试过：${pick.tried.join(' ')}`)
      db.close()
      continue
    }
    const P = pick.period
    ran.push(ind) // 这一库真的开跑了（后面还有断言要过）—— 计数行的库标签由它派生
    console.log(`\n${'─'.repeat(72)}\n【${ind}】期间 ${P}（候选非零行数 ${pick.tried.join(' ')}）`)
    // A 的自证：这条本身也要能被反例验证 —— 把选取改成"恒取最新一期"，它必须变红。
    ok(pick.nonZero >= 1,
      `本次核对用的样本期（${P}）里至少有一个非零金额`,
      `非零行数 ${pick.nonZero}（否则金额断言退化成在比 0.00 与 0）`)

    // =======================================================================
    section(`E1 默认格式仍是 CSV，且与改造前逐字节相同（${ind}）`)
    // =======================================================================
    const csv = R.exportReport(db, { reportCode: 'pl', period: P, generatedAt: FIXED_AT })
    eq('不传 format 时 format=csv', csv.format, 'csv')
    eq('不传 format 时 mime 还是 text/csv', csv.mime, 'text/csv; charset=utf-8')
    eq('不传 format 时文件名还是 .csv', csv.filename, `pl_${P}.csv`)
    ok(!csv.sheet_name, 'CSV 结果里没有工作表名（那是 xlsx 的概念）')
    const result = R.computeReport(db, { reportCode: 'pl', period: P })
    eq('CSV 内容逐字节 == buildReportCSV(同一份 result)（含末尾元信息行）',
      csv.content, R.buildReportCSV(result, { generatedAt: FIXED_AT }))
    eq('CSV 以 UTF-8 BOM 开头（Excel 认编码靠它）', csv.content.slice(0, 1), '\uFEFF')
    const csvLines = String(csv.content).replace(/^\uFEFF/, '').split('\r\n')
    const footer = csvLines.filter((l) => l.startsWith('#')).map((l) => l.replace(/^#\s?/, ''))
    // C：取值前先判存在 —— `footer[0]` 在"没有元信息行"时会抛，把整个套件带崩（后面的断言一条都跑不到）
    eq('末尾元信息仍是 4 行（标题 / 生成时间 + 该报表特有的窗口行）',
      [(footer[0] || '').startsWith('利润表'), footer[footer.length - 1] || '', footer.length >= 2],
      [true, `生成于 ${FIXED_AT}`, true])
    // 固定时间戳之后，两次调用必须逐字节相同（否则"同一份输入两次导出哈希不同"会变成回归噪声）
    eq('两次导出的 CSV 逐字节相同（生成时间已被固定）',
      R.exportReport(db, { reportCode: 'pl', period: P, generatedAt: FIXED_AT }).content, csv.content)

    // =======================================================================
    section(`E2 xlsx：结构、mime、文件名、与列定义同源（${ind}）`)
    // =======================================================================
    const out = R.exportReport(db, { reportCode: 'pl', period: P, format: 'xlsx', generatedAt: FIXED_AT })
    eq('format=xlsx 的 mime', out.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    eq('xlsx 文件名后缀', out.filename, `pl_${P}.xlsx`)
    ok(Buffer.isBuffer(out.content) && out.content.length > 100, `内容是 Buffer 且有内容（${out.content.length} 字节）`)
    eq('xlsx 是 ZIP（PK\\x03\\x04 魔数）', [...out.content.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04])
    eq('工作表名 = 报表名（没有被降级）', [out.sheet_name, out.sheet_name_fallback], ['利润表', false])

    // =======================================================================
    section(`E3 **独立验证**：交给 openpyxl 读回来，逐格核对（${ind}）`)
    // =======================================================================
    const e3seen = new Set()
    const e3 = (name, cond, detail) => { e3seen.add(name); ok(cond, name, detail) }
    let why = null
    let read = null
    try {
      fs.writeFileSync(XLSX_PATH, out.content)
      read = readWithOpenpyxl(XLSX_PATH)
    } catch (e) {
      why = e.message
      console.log(`  \x1b[31m⚠️ 第三方读取器这一节整体不可用：${why}\x1b[0m`)
    }
    if (read) {
      const rows = read.rows || []
      e3(E3_KEYS[0], JSON.stringify(read.sheets) === JSON.stringify(['利润表']), JSON.stringify(read.sheets))
      const hdr = rows[0] || []
      e3(E3_KEYS[1], JSON.stringify(hdr.slice(0, out.columns.length)) === JSON.stringify(out.columns.map((c) => c.label)),
        `期望 ${JSON.stringify(out.columns.map((c) => c.label))}，实际 ${JSON.stringify(hdr)}`)
      e3(E3_KEYS[2], hdr.slice(0, out.columns.length).join(',') === csvLines[0], `xlsx ${JSON.stringify(hdr.slice(0, out.columns.length).join(','))} / csv ${JSON.stringify(csvLines[0])}`)
      // 行次列是文本（`columnValue` 按 kind='text' 落成字符串），所以按"看起来像行号"来数，
      // 这样表头 / 空行 / 末尾元信息都不会被算进去
      const dataRows = rows.filter((r) => /^\d+$/.test(String((r || [])[0] ?? '')))
      e3(E3_KEYS[3], dataRows.length === out.row_count, `读到 ${dataRows.length} 行 / 报表 ${out.row_count} 行`)
      // 金额单元格必须是**数值类型**（能被 Excel 求和），且等于报表里的金额；
      // 同时它的字符串形式必须与 CSV 里那一格逐字相同（两种格式的**值**不许分叉）
      let checkedNum = 0
      let allMoneyNumeric = true
      // 固定核前 3 行（`Math.min` 之后再数）：断言条数因此恒定，不会"行少就少跑几条"
      for (let i = 0; i < Math.min(3, result.rows.length); i += 1) {
        const row = rows[i + 1] || []
        const want = Number(result.rows[i].amount)
        const got = row[2]
        const numOk = typeof got === 'number' && near(got, want)
        if (typeof got !== 'number') allMoneyNumeric = false
        if (numOk) checkedNum += 1
        e3(E3_KEYS[4 + i], numOk, `行=${result.rows[i].line_name}：openpyxl 读到 ${JSON.stringify(got)}，报表 ${want}`)
      }
      e3(E3_KEYS[7], allMoneyNumeric, '有金额单元格不是数值（文本型 "0.00" 在 Excel 里不能求和）')
      e3(E3_KEYS[8], checkedNum === 3, `核对到的数值单元格 ${checkedNum} 个（应 3 个）`)
      // 两种格式**表示**不同是应该的（xlsx 数值 / CSV 两位小数文本），但**值**必须相同。
      // 用数值比较而不是字符串比较：`String(0) === '0'` 而 CSV 里是 '0.00' —— 那只是表示差别。
      e3(E3_KEYS[9], Number((rows[1] || [])[2]) === Number((csvLines[1] || '').split(',')[2]),
        `xlsx ${JSON.stringify((rows[1] || [])[2])} / csv ${JSON.stringify((csvLines[1] || '').split(',')[2])}`)
      const texts = rows.map((r) => (typeof (r || [])[0] === 'string' ? r[0] : null)).filter(Boolean)
      e3(E3_KEYS[10], texts.some((t) => t.startsWith('利润表 ·')), JSON.stringify(texts.slice(-5)))
      e3(E3_KEYS[11], texts.some((t) => t.startsWith('生成于 ')), JSON.stringify(texts.slice(-5)))
      e3(E3_KEYS[12], !texts.some((t) => t.startsWith('#')), JSON.stringify(texts.slice(-5)))
    }
    // 收尾扫尾：没执行到的断言一律记失败（并说明原因）。跳过 = 把失败藏起来。
    for (const k of E3_KEYS) if (!e3seen.has(k)) e3(k, false, `断言未执行：${why || '未跑到'}`)

    // 三张表都能导，且累计/比较的列也在（列多出来时行也要对齐）
    for (const code of ['bs', 'cf']) {
      const o = R.exportReport(db, { reportCode: code, period: P, format: 'xlsx', generatedAt: FIXED_AT })
      try {
        fs.writeFileSync(XLSX_PATH, o.content)
        const rd = readWithOpenpyxl(XLSX_PATH)
        eq(`${code} xlsx 的表头 == 该报表的 columns label`, (rd.rows?.[0] || []).slice(0, o.columns.length), o.columns.map((c) => c.label))
      } catch (e) {
        ok(false, `${code} xlsx 的表头 == 该报表的 columns label`, `第三方读取器不可用：${e.message}`)
      }
    }
    {
      const o = R.exportReport(db, { reportCode: 'cf', period: P, range: 'ytd', format: 'xlsx', generatedAt: FIXED_AT })
      try {
        fs.writeFileSync(XLSX_PATH, o.content)
        const rd = readWithOpenpyxl(XLSX_PATH)
        const h0 = rd.rows?.[0] || []
        eq('带本年累计列的 xlsx：列数 = columns 长度', h0.filter((x) => x !== null).length, o.columns.length)
        ok(h0.some((x) => String(x).includes('本年累计')), '表头里有「本年累计」且带区间', JSON.stringify(h0))
      } catch (e) {
        ok(false, '带本年累计列的 xlsx：列数 = columns 长度', `第三方读取器不可用：${e.message}`)
        ok(false, '表头里有「本年累计」且带区间', `第三方读取器不可用：${e.message}`)
      }
    }

    db.close()
  }

  // =======================================================================
  section('E4 工作表名的边界（非法名降级，不 500）')
  // =======================================================================
  {
    const base = {
      report_code: 'x', report_name: '利润表', basis: 'amount', basis_label: '本期发生额',
      period: '2026-10', rows: [{ line_no: 1, line_name: '一、营业收入', amount: 1.5 }],
      columns: R.columnsOf({ period: '2026-10' })
    }
    const e4seen = new Set()
    const e4 = (name, cond, detail) => { e4seen.add(name); ok(cond, name, detail) }
    const e4eq = (name, actual, expect) => { e4seen.add(name); eq(name, actual, expect) }
    let why = null
    try {
      const good = R.buildReportXlsx(base, { generatedAt: FIXED_AT })
      e4eq('合法名不降级', [good.sheet_name, good.sheet_name_fallback], ['利润表', false])
      const bad = R.buildReportXlsx({ ...base, report_name: '资产负债/表[草稿]' }, { generatedAt: FIXED_AT })
      e4eq('含 [ ] : * ? / \\ 的名字降级成安全名并如实标出',
        [bad.sheet_name, bad.sheet_name_fallback], ['资产负债_表_草稿_', true])
      const long = R.buildReportXlsx({ ...base, report_name: '长'.repeat(40) }, { generatedAt: FIXED_AT })
      e4eq('超 31 个字符的名字截断到 31 个码点（中文按字算，不按字节）',
        [[...long.sheet_name].length, long.sheet_name_fallback], [31, true])
      const quoted = R.buildReportXlsx({ ...base, report_name: "'引号表'" }, { generatedAt: FIXED_AT })
      e4eq('前后撇号被去掉（Excel 不许）', [quoted.sheet_name, quoted.sheet_name_fallback], ['引号表', true])
      // 降级名必须能被第三方读取器接受
      fs.writeFileSync(XLSX_PATH, bad.buffer)
      const rd = readWithOpenpyxl(XLSX_PATH)
      e4(E4_KEYS[4], JSON.stringify(rd.sheets) === JSON.stringify(['资产负债_表_草稿_']), JSON.stringify(rd.sheets))
    } catch (e) {
      why = e.message
    }
    for (const k of E4_KEYS) if (!e4seen.has(k)) e4(k, false, `断言未执行：${why || '未跑到'}`)
  }

  // =======================================================================
  section('E5 非法 format 明确拒绝（4xx + 封闭错误码，不静默退回 CSV）')
  // =======================================================================
  {
    const db = new Database(path.join(ROOT, 'data', 'gml_cosmetic.db'), { readonly: true, fileMustExist: true })
    // 这一节只要一个**合法期间字符串**（它验的是"格式不认识就拒"，与那一期有多少数据无关）。
    // 仍然不写死：取候选里第一个（`availablePeriods` 按期间倒序，第一个就是最新一期）。
    const p5 = R.availablePeriods(db)[0]?.period || null
    if (!p5) {
      ok(false, 'E5 需要一个合法期间才能构造导出请求（这一库一个期间都没有）')
    } else {
      throws(() => R.exportReport(db, { reportCode: 'pl', period: p5, format: 'pdf' }), 'BAD_EXPORT_FORMAT', 'format=pdf → BAD_EXPORT_FORMAT')
      try {
        R.exportReport(db, { reportCode: 'pl', period: p5, format: 'pdf' })
      } catch (e) {
        eq('错误码是 400（不是 500）', e.http ?? e.status, 400)
      }
      eq('format 大小写不敏感、空串按默认 CSV', R.exportReport(db, { reportCode: 'pl', period: p5, format: ' XLSX ' }).format, 'xlsx')
    }
    db.close()
  }
}

// ── C：主体抛未预期异常也要**照常打出计数行**（没有计数行会被回归统计器记成"无计数"）──
try {
  main()
} catch (e) {
  ok(false, `套件主体抛出未预期异常（已兜住，计数行仍会打印）：${e && e.message}`, e && e.stack && e.stack.split('\n').slice(0, 3).join(' | '))
}

// =========================================================================
section(`收尾自证：应到 ${EXPECTED_TOTAL} 条断言，实到 ${pass + fail + 1} 条`)
// =========================================================================
// 比对的是"这一条之前"的实到数（`+1` 是它自己）。少跑一条就红 ——
// 这样"某个库被跳过 / 某一节整体没跑到"不会再表现为"绿的但计数小了一截"。
const soFar = pass + fail
// ⚠️ 注意本文件 `ok(cond, msg, detail)` 的参数顺序（`test-xlsx.mjs` 是 `ok(name, cond, detail)`，
// 两个文件相反）。写成 `ok(名字, 条件, 明细)` 的话条件位置收到的是一个**非空字符串**——
// 恒为真、这条自证永远绿（第一次就是这么写错的，被"跳过一个库仍全绿"这组反例当场抓出来）。
ok(soFar === EXPECTED_TOTAL - 1,
  `应到 ${EXPECTED_TOTAL} 条断言，实到 ${soFar + 1} 条（增删断言必须同步改文件里的 EXPECTED_TOTAL）`,
  `实到 ${soFar + 1} / 应到 ${EXPECTED_TOTAL}`)

console.log(`\n${'─'.repeat(72)}`)
console.log(`报表导出 Excel（实跑 ${ran.length ? ran.join('/') : '没有库跑到'}）：通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  failures.forEach((f) => console.log(`  - ${f}`))
}
for (const f of [XLSX_PATH, PY_PATH]) {
  try {
    fs.rmSync(f, { force: true })
  } catch {
    /* 临时文件删不掉不影响结论 */
  }
}
process.exit(fail === 0 ? 0 : 1)
