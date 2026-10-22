#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/accept/reversal-report-deepening.mjs ｜ 独立验收：注入式「先红后证」—— 证明「报表纵深之四（③-a / ③-b / ③-c）+ ④ 跨年度报表」
 * ============================================================================
 * 【职责】独立验收：注入式「先红后证」—— 证明「报表纵深之四（③-a / ③-b / ③-c）+ ④ 跨年度报表」
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
 * 注入式「先红后证」—— 证明「报表纵深之四（③-a / ③-b / ③-c）+ ④ 跨年度报表」
 * 那些断言**真的验到了那些口径**。
 *
 * 与证据文件的配对关系：
 *   产物 `docs/evidence/批次U之四_反例先红_报表纵深之四.txt`
 *   ←→ 本脚本。证据是**一次跑出来的记录**（文字摘录），本脚本是**能再跑一遍的东西**：
 *   证据只有"当时红了几条"这一句话，脚本里写着**改哪个文件的哪一行**、
 *   期望哪几条断言变红、还原之后必须回到全绿（且目标文件 sha256 与注入前一致）。
 *   数字允许与当时那次不完全相同，但**结论必须同向**：真红、真回绿。
 *
 * 为什么需要它（而不是"再跑一次测试看看绿不绿"）：
 *   那些断言现在都是绿的。但"绿"有两个互不相干的来源 ——
 *     ① 口径在，且被那条断言量到了；② 那条路径**恰好没走到**。
 *   正向通过区分不了这两者。唯一能区分的手段是**主动把口径拆坏**：
 *   拆掉之后如果断言**没变红**，说明这一节根本没量到它（铁律 22）。
 *   这一批尤其需要：③-a 的"表头 = columnsOf 的 label"、③-b 的"基期 = 上年同月"、
 *   ④ 的"第 k 列 = 往前 12k 个月"全都是**差一个月 / 差一个名字就看着完全正常**的错误。
 *
 * ## 覆盖面（9 组）
 *   派单点名要覆盖的 5 条：
 *     `3a` `columns[].label` 误写成表头（xlsx 表头取列键）
 *     `3b` `yoy_ytd` 的比较基期错一个月（delta -12 → -1）
 *     `3g` xlsx **inlineStr 的 `&` 转义被去掉**（去掉后 XML 不合法，第三方读取器读不回来）
 *     `3h` `fiscalYearOf` 的**起始月边界**（`mm >= m` 改成 `mm > m`：正好落在起始月的那一期被算进上一年度）
 *     `4`  `multiYearPeriods` 的年份窗口（-12k → -11k）
 *   另外 4 组：
 *     `3c` 摘掉"非自然年度不做年结"的闸门
 *     `3d` / `3e` / `3f` **测试自身的三个口子**（独立复核点名，改在 `scripts/test-export-excel.mjs` 上）：
 *          样本期退化（恒取最新一期 ⇒ 金额断言退化成 0 vs 0）、第三方读取器找不到、
 *          静默跳过一库（跳过与通过同形）。这三组量的不是产品口径，而是"**修完的口子还守不守得住**"。
 *
 * 硬约束：**绝不动工作区**。
 *   全部 patch / 跑测 / 还原都发生在 `/tmp` 下的**隔离副本**里（复刻 `run-on-copy.mjs`
 *   的复制口径：只复制源码与配置，排除 .git / node_modules，node_modules 用只读软链）。
 *   四把尺子都对着 `ROOT/data/gml_<行业>.db` 跑（其中 test-fiscal-year 会**写**它，
 *   写在 `BEGIN … ROLLBACK` 里），所以副本里必须带一份 `data/` 快照 ——
 *   工作区那三个 .db 依旧一个字节都不碰（副本里的改动随副本一起删掉）。
 *   收工自证四件事：① 逐组 sha256：还原后与注入前逐字节一致；② 目标文件全局 sha256 未变；
 *   ③ `git status --porcelain` 前后一致；④ **本次创建的临时副本一份都不剩**（逐份核对）。
 *   **反例不改库**：本脚本改的只有源码副本，工作区三库 sha256 前后一致，并如实报「改了几条库」。
 *
 * ⚠️ 一个易被误读的现象：`/tmp` 里偶尔会看到**半截**的本脚本副本目录。
 *   它们不来自本脚本的清理（本脚本收工自证会给出"仍存在 0 份"）——
 *   而是**被中途杀掉的进程**留下的（例如同一命令被沙箱拒绝后在沙箱外重跑一遍，
 *   那一次会连同它的副本一起被 KILL）。看到半截目录先看收工自证那一行再下结论。
 *
 * 铁律 21：「崩」与「可读的红」必须分开计数。
 *   注入后进程非 0 退出、但一条 `✗` 都没有（或报错在无关位置）= `red_crashed`，
 *   不算"变红"，单独统计 —— 而且**还原后再跑一次**来区分"崩由这次注入引起"与"环境问题"。
 *
 * 用法：
 *   node scripts/accept/reversal-report-deepening.mjs            # 全部 9 组
 *   node scripts/accept/reversal-report-deepening.mjs --dry      # 只验锚点唯一命中，不跑测试
 *   node scripts/accept/reversal-report-deepening.mjs --only=3A,4
 *   node scripts/accept/reversal-report-deepening.mjs --jobs=2   # 并行度（每组独占一份副本）
 *   node scripts/accept/reversal-report-deepening.mjs --keep     # 保留 /tmp 副本便于复查
 *
 * 退出码：全组通过 0，否则 1；收尾另打一行 `计数 通过 N / 失败 M`。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, symlinkSync, existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ---------------------------------------------------------------------------
// 参数（口径「丁」）：**不认识的参数一律拒绝** —— 打用法 + 非 0 退出，绝不静默忽略。
// 静默接受一个无意义的动作，与本批缺陷 186（`qty:-5` 静默成功）是同一族。
//
// 【2026-10-16 修：参数只解析一次】原版把参数**读了两遍** —— 闸门按「`=` 前面的名字」判白名单，
// 行为却按「整串相等」判（`process.argv.includes('--dry')`）。于是 `--dry=1`：闸门认它（名字
// `--dry` 在白名单里）⇒ **放行**；行为不认（整串不等）⇒ `DRY=false` ⇒ **一声不响把整套跑完**。
// `--keep=1` 同形：放行、但 `KEEP=false` ⇒ 你让它保留副本，它给你删了。
// 这跟本批"日志里的码与响应里的码不同源"是**同一族**，判据一句话：
//   **闸门认得的形状，必须与生效时真正读取的形状，来自同一次解析。**
// 所以下面只解析一次：裸开关收到 `=值` 判**非法**（不是忽略那个值），带值开关缺 `=` 也判非法。
// ---------------------------------------------------------------------------
const NO_VALUE = new Set(['--dry', '--keep', '--help'])  // 裸开关：只认整字，不收 `=值`
const WITH_VALUE = new Set(['--only', '--jobs'])         // 带值开关：必须写成 `--x=值`
const FLAGS = new Set()
const OPTS = new Map()
const badArgs = []
for (const a of process.argv.slice(2)) {
  const eq = a.indexOf('=')
  const name = eq < 0 ? a : a.slice(0, eq)
  if (NO_VALUE.has(name)) { if (eq >= 0) badArgs.push(a); else FLAGS.add(name); continue }
  if (WITH_VALUE.has(name)) { if (eq < 0) badArgs.push(a); else OPTS.set(name, a.slice(eq + 1)); continue }
  badArgs.push(a)
}
const USAGE = '用法: node scripts/accept/reversal-report-deepening.mjs [--dry] [--only=ID,ID] [--jobs=N] [--keep]\n' +
  '  --dry           只解析锚点（不跑套件、秒级）\n' +
  '  --only=3A,4     只跑指定组（组号见上面 INJECTIONS；大小写不敏感）\n' +
  '  --jobs=N        并行度（每组独占一份 /tmp 副本）\n' +
  '  --keep          保留 /tmp 副本便于复查\n' +
  '  裸开关只认整字：`--dry=1` / `--keep=1` 判非法（不是"忽略那个 1"）'
if (badArgs.length) {
  console.error(`❌ 不认识的参数（或写法不对）：${badArgs.join(' ')}`)
  console.error(USAGE)
  process.exit(2)
}
if (FLAGS.has('--help')) { console.log(USAGE); process.exit(0) }
// 行为与闸门**从同一次解析读**（这就是"判据只有一个出处"）
const ONLY = OPTS.has('--only') ? new Set(OPTS.get('--only').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) : null
const JOBS = Math.max(1, Number(OPTS.get('--jobs') ?? 1) || 1)
const KEEP = FLAGS.has('--keep')
const DRY = FLAGS.has('--dry')

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// 删临时副本要**重试**：`rmSync(recursive)` 在深目录上偶发 `ENOTEMPTY`（遍历与删除之间的竞态），
// 一次失败就 `catch {}` 会把半截副本留在 /tmp 里越积越多。失败时同步小睡再试。
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 不支持就退化成不睡 */ } }
function rmrf(p) {
  let last = null
  for (let i = 0; i < 6; i += 1) {
    try { rmSync(p, { recursive: true, force: true }) } catch (e) { last = e }
    if (!existsSync(p)) return { ok: true, why: null }
    sleepSync(200)
  }
  return { ok: false, why: last ? `${last.code} @ ${last.path || '?'}` : '目录仍在但没抛错' }
}

// ---------------------------------------------------------------------------
// 「改了几条库」的量法（口径「丙」）：**两栏口径不同，都要显式报数字**。
//   工作区：只读 COUNT(*) 一次（`readonly: true` 打开，不写一个字节）。
//   副本内：四把尺子都对着副本里的 `data/` 快照跑（`test-fiscal-year` 会写它，写在 BEGIN…ROLLBACK 里），
//           本脚本在每组跑完后数一遍、如实报出差值。
// ---------------------------------------------------------------------------
const Database = (await import(path.join(ROOT, 'node_modules/better-sqlite3/lib/index.js'))).default
/** 一个库里所有表的行数之和（读不出来返回 null —— 调用方如实报，不假装 0） */
function dbRows(file) {
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true })
    let n = 0
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      try { n += Number(db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c) } catch { /* 虚表/视图跳过 */ }
    }
    db.close()
    return n
  } catch { return null }
}
const sumRows = (dir) => ['cosmetic', 'food', 'apparel']
  .map((i) => dbRows(path.join(dir, `gml_${i}.db`)))
  .filter((x) => x !== null)
  .reduce((s, x) => s + x, 0)

// ---------------------------------------------------------------------------
// 9 组注入。`from` 必须在文件里**唯一命中**；命中 0 次或 >1 次一律报"锚点未命中"，
// 绝不静默跳过（宁可空手，也不许假装验过）。
// `expect` 是"期望变红的断言名里的子串" —— 用子串而不是全等，因为 `eq()` 型断言的
// 失败行会**带上期望/实际**（`名字：期望 X，实际 Y`），全等永远匹配不上。
// ③-a/③-b/③-c/④ 与 3h 的被测对象是 `server/lib/report.js`（本批的改动落点）；
// 3g 在 `server/lib/xlsx.js`（写入器本身）；3d/3e/3f 在 `scripts/test-export-excel.mjs`
// （复核点名的三个"断言在跑但不承重"的口子，修完之后要能证明它**现在守得住**）。
// ---------------------------------------------------------------------------
const INJECTIONS = [
  {
    id: '3a',
    title: '让 xlsx 的表头写成列键（而不是 columnsOf 的中文名）',
    file: 'server/lib/report.js',
    from: '  const rows = [cols.map((c) => c.label)]',
    to: '  const rows = [cols.map((c) => c.key)] // INJECT-RD3a：表头改用列键',
    runner: 'scripts/test-export-excel.mjs',
    suite: '报表导出 Excel（三库）',
    expect: ['表头单元格逐字 == columnsOf 的 label', '表头与 CSV 的表头逐字相同']
  },
  {
    id: '3b',
    title: '累计同比的基期错一个月（delta 从 -12 改成 -1）',
    file: 'server/lib/report.js',
    from: "  yoy_ytd: { label: '上年同期累计（累计同比）', delta: -12, range: 'ytd' },",
    to: "  yoy_ytd: { label: '上年同期累计（累计同比）', delta: -1, range: 'ytd' }, // INJECT-RD3b：基期只往前一个月",
    runner: 'scripts/test-ytd-compare.mjs',
    suite: '本年累计的比较（三库）',
    expect: ['基期期间 = 本期往前 12 个月', '基期窗口**字面**等于 [上年年初, 上年同月]']
  },
  {
    id: '3c',
    title: '摘掉"非自然年度不做年结"的闸门',
    file: 'server/lib/report.js',
    from: '  const m = fiscalStartMonth(db)\n  if (m !== FISCAL_START_DEFAULT) {',
    to: '  const m = fiscalStartMonth(db)\n  if (false && m !== FISCAL_START_DEFAULT) { // INJECT-RD3c：闸门不再拦',
    runner: 'scripts/test-fiscal-year.mjs',
    suite: '会计年度起点可配置（三库）',
    expect: ['年结被明确拒绝（不是静默按自然年结）', '利润分配被明确拒绝']
  },
  {
    id: '3d',
    title: '样本期退化：恒取第一个候选期间（金额断言退化成比 0.00 与 0）',
    file: 'scripts/test-export-excel.mjs',
    from: '      if (nonZero > 0) return { period: p, nonZero, tried }',
    to: '      return { period: p, nonZero, tried } // INJECT-RD3d：恒取第一个候选 —— 最新一期损益全 0',
    runner: 'scripts/test-export-excel.mjs',
    suite: '报表导出 Excel（三库）',
    expect: ['本次核对用的样本期']
  },
  {
    id: '3e',
    title: '第三方读取器找不到（去掉已知可用的候选解释器）',
    file: 'scripts/test-export-excel.mjs',
    from: "  process.env.GML_PYTHON,\n  '/Users/linxinlan/.workbuddy/binaries/python/envs/default/bin/python',",
    to: '  process.env.GML_PYTHON, // INJECT-RD3e：去掉已知可用的解释器（模拟"一个候选都找不到"）',
    runner: 'scripts/test-export-excel.mjs',
    suite: '报表导出 Excel（三库）',
    expect: ['工作表名（第三方读取器的读数）', '表头单元格逐字 == columnsOf 的 label']
  },
  {
    id: '3f',
    title: '静默跳过一库（跳过与通过同形 ⇒ 计数变小但仍然全绿）',
    file: 'scripts/test-export-excel.mjs',
    from: '    const db = new Database(file, { readonly: true, fileMustExist: true })\n    const pick = pickSamplePeriod(db)',
    to: '    const db = new Database(file, { readonly: true, fileMustExist: true })\n    if (ind === \'cosmetic\') { db.close(); continue } // INJECT-RD3f：这一库的断言一条都不跑\n    const pick = pickSamplePeriod(db)',
    runner: 'scripts/test-export-excel.mjs',
    suite: '报表导出 Excel（三库）',
    expect: ['应到 102 条断言']
  },
  {
    id: '3g',
    title: 'xlsx inlineStr 的 `&` 转义被去掉（XML 不再合法）',
    file: 'server/lib/xlsx.js',
    from: "  return sanitizeXmlText(s)\n    .replace(/&/g, '&amp;')\n    .replace(/</g, '&lt;')",
    to: "  return sanitizeXmlText(s)\n    // INJECT-RD3g：去掉 & 转义（inlineStr 里出现裸 & ⇒ XML 不合法）\n    .replace(/</g, '&lt;')",
    runner: 'scripts/test-xlsx.mjs',
    suite: 'XLSX 写入器回归',
    expect: ['Python·& < > " 后仍能取回原字符串', 'openpyxl·字符串读回原值']
  },
  {
    id: '3h',
    title: 'fiscalYearOf 的起始月边界（`mm >= m` 改成 `mm > m`：正好落在起始月的那一期被算进上一年度）',
    file: 'server/lib/report.js',
    from: '  const fromYear = mm >= m ? y : y - 1',
    to: '  const fromYear = mm > m ? y : y - 1 // INJECT-RD3h：起始月那一期被划到上一年度',
    runner: 'scripts/test-fiscal-year.mjs',
    suite: '会计年度起点可配置（三库）',
    expect: ['八组（期间 × 起始月）的字面预期全部命中']
  },
  {
    id: '4',
    title: '同期多年对比的期间序列错一个月（-12k 改成 -11k）',
    file: 'server/lib/report.js',
    from: '  for (let k = 0; k < n; k += 1) out.push({ k, period: shiftPeriod(p, -12 * k) })',
    to: '  for (let k = 0; k < n; k += 1) out.push({ k, period: shiftPeriod(p, -11 * k) }) // INJECT-RD4：往前 11k 个月',
    runner: 'scripts/test-multi-year.mjs',
    suite: '同期多年对比（三库）',
    expect: ['years=2 的期间序列（字面算出的期望值）', 'years=3 的期间序列（字面算出的期望值）']
  }
]

// ---------------------------------------------------------------------------
// `--dry`：只解析锚点，不跑测试
// ---------------------------------------------------------------------------
if (DRY) {
  let miss = 0
  for (const inj of INJECTIONS) {
    const p = path.join(ROOT, inj.file)
    if (!existsSync(p)) { console.log(`[${inj.id}] ✗ 文件不存在 ${inj.file}`); miss += 1; continue }
    const src = readFileSync(p, 'utf8')
    const n = src.split(inj.from).length - 1
    const first = n === 1 ? src.slice(0, src.indexOf(inj.from)).split('\n').length : null
    if (n !== 1) miss += 1
    console.log(`[${inj.id}] ${n === 1 ? `✓ 锚点唯一命中 ${inj.file}:${first}` : `✗ 命中 ${n} 次（必须恰好 1 次）`}  ${inj.title}`)
  }
  console.log(`\n--dry：${INJECTIONS.length - miss} / ${INJECTIONS.length} 组锚点就绪${miss ? `，${miss} 组未命中` : ''}`)
  process.exit(miss ? 1 : 0)
}

// ---------------------------------------------------------------------------
// 隔离副本（复刻 run-on-copy.mjs 的复制口径）
// ---------------------------------------------------------------------------
const COPY_DIRS = ['server', 'scripts', 'src', 'public']
const COPY_FILES = ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'vite.config.js', 'tsconfig.json', 'tailwind.config.js', 'postcss.config.js', 'enter.html']

// 本脚本创建过的临时副本目录（收工时**逐份核对**「还在不在」，而不是笼统宣称清理过了 ——
// 铁律 11：自称的元信息必须由实算派生）
const CREATED = []

function makeCopy(tag) {
  const TMP = mkdtempSync(path.join(tmpdir(), `gml-rev-rd-${tag}-`))
  const REPO = path.join(TMP, 'repo')
  mkdirSync(REPO, { recursive: true })
  for (const d of COPY_DIRS) if (existsSync(path.join(ROOT, d))) cpSync(path.join(ROOT, d), path.join(REPO, d), { recursive: true })
  for (const f of COPY_FILES) if (existsSync(path.join(ROOT, f))) copyFileSync(path.join(ROOT, f), path.join(REPO, f))
  // `data/` 必须复制：四把尺子都对着 `ROOT/data/gml_*.db` 跑。
  // 复制的是**快照**，副本里的写（test-fiscal-year 改配置）随副本一起删 —— 工作区一个字节都不碰。
  if (existsSync(path.join(ROOT, 'data'))) cpSync(path.join(ROOT, 'data'), path.join(REPO, 'data'), { recursive: true })
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(REPO, 'node_modules'), 'dir')
  CREATED.push(TMP)
  // 口径「丙」副本那一栏的**起点**：副本里那份 `data/` 快照数一遍
  const rowBefore = sumRows(path.join(REPO, 'data'))
  return { TMP, REPO, rowBefore }
}

function runSuite(REPO, runner) {
  const r = spawnSync(process.execPath, [path.join(REPO, runner)], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env }
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

const stripAnsi = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '')

/**
 * 从套件输出里读「通过 N / 失败 M」与**失败断言名单**。
 *
 * 优先读收尾那一段（`失败项：` 之后的 `  - 名字`）—— 它是套件自己维护的
 * **去重后的断言名**，比解析 `✗` 行可靠（`eq()` 失败会打印两行：带期望/实际的一行 + 只有名字的一行，
 * 按行数统计会把同一条断言数成两条）。拿不到那一段（套件崩在半路）再退化为解析 `✗` 行。
 */
function readResult(stdout) {
  const txt = stripAnsi(stdout)
  const m = txt.match(/通过 (\d+) \/ 失败 (\d+)/)
  const tally = m ? { pass: Number(m[1]), fail: Number(m[2]) } : null
  const names = []
  const idx = txt.lastIndexOf('失败项：')
  if (idx >= 0) {
    for (const line of txt.slice(idx).split('\n').slice(1)) {
      if (/^ {2}- /.test(line)) names.push(line.replace(/^ {2}- /, '').trim())
    }
  }
  if (!names.length) {
    for (const line of txt.split('\n')) {
      if (/^ {2}✗ /.test(line)) names.push(line.replace(/^ {2}✗ /, '').trim())
    }
  }
  return { tally, names }
}

// ---------------------------------------------------------------------------
// 单组流程：patch（副本）→ 跑 → 断言命中 → 还原 → 再跑 → 断言回绿
// ---------------------------------------------------------------------------
function processInjection(inj) {
  const tag = `${inj.id}-${Date.now().toString(36)}`
  const rec = { id: inj.id, title: inj.title, file: inj.file, runner: inj.runner, anchor: null, status: 'unknown', failures: [], hit: [], redTally: null, greenFailures: null, crashed: false, note: '', sha: null, dbCopy: null }
  let copy = null
  try {
    copy = makeCopy(tag)
    const target = path.join(copy.REPO, inj.file)
    if (!existsSync(target)) { rec.status = 'anchor_miss'; rec.note = `文件不存在：${inj.file}`; return rec }

    const original = readFileSync(target, 'utf8')
    const occurrences = original.split(inj.from).length - 1
    if (occurrences !== 1) {
      rec.status = 'anchor_miss'
      rec.note = `锚点在 ${inj.file} 命中 ${occurrences} 次（必须恰好 1 次）—— 源码改过之后锚点会漂，请按新源码重定`
      return rec
    }
    rec.anchor = { file: inj.file, line: original.slice(0, original.indexOf(inj.from)).split('\n').length }
    const shaBefore = sha256(target)

    // ① 注入
    writeFileSync(target, original.replace(inj.from, inj.to))

    // ② 跑：必须变红（且可读）
    const red = runSuite(copy.REPO, inj.runner)
    const rr = readResult(red.stdout)
    rec.failures = rr.names
    rec.redTally = rr.tally
    if (rr.names.length === 0) {
      // 没有可读的 ✗。**先把文件还原、再跑一次**，用这一次的结果区分两种完全不同的成因：
      //   · 还原后全绿  ⇒ 崩是**这次注入**造成的（但按铁律 21，崩仍不算"可读的红"）；
      //   · 还原后还崩  ⇒ 与注入无关，是**环境/竞态**（解释器缺失、端口、资源）—— 别让下一个人
      //                   把它误读成"验收台坏了"或"这条断言没牙"。
      rec.crashed = red.status !== 0
      writeFileSync(target, original)
      const greenAfterCrash = runSuite(copy.REPO, inj.runner)
      const gfc = readResult(greenAfterCrash.stdout)
      rec.greenFailures = gfc.names.length
      if (gfc.names.length === 0 && greenAfterCrash.status === 0) {
        rec.status = rec.crashed ? 'red_crashed' : 'no_red'
        rec.note = rec.crashed
          ? `注入后进程退出码 ${red.status} 且**没有可读的 ✗**；还原后同一套件全绿 ⇒ 崩溃**由这次注入引起**（不是环境问题），但仍不计为"变红"（铁律 21）。stderr 尾部：${(red.stderr || '').split('\n').slice(-3).join(' | ').slice(0, 160)}`
          : `注入后失败数为 0 —— **在这把尺子（${inj.suite}）里**没有任何断言守住它（注意：这只说明"这把尺子量不到"，不等于"没有断言在守"）`
      } else {
        rec.status = 'env_failure'
        rec.note = `⚠️ **环境/竞态类失败，非断言失败**：注入后无 ✗，且**还原后同样失败**（失败 ${gfc.names.length} 条 / 退出码 ${greenAfterCrash.status}）⇒ 与本次注入无关，**不要**当成"验收台坏了"。stderr 尾部：${(red.stderr || '').split('\n').slice(-3).join(' | ').slice(0, 160)}`
      }
      rec.sha = { before: shaBefore, after: sha256(target), same: sha256(target) === shaBefore }
      return rec
    }
    rec.hit = inj.expect.filter((sub) => rr.names.some((n) => n.includes(sub)))

    // ③ 还原
    writeFileSync(target, original)
    const shaAfter = sha256(target)
    rec.sha = { before: shaBefore, after: shaAfter, same: shaAfter === shaBefore }
    if (!rec.sha.same) { rec.status = 'restore_failed'; rec.note = `还原后 sha256 与注入前不同（${shaBefore.slice(0, 12)} → ${shaAfter.slice(0, 12)}）`; return rec }

    // ④ 再跑：必须回绿
    const green = runSuite(copy.REPO, inj.runner)
    const gf = readResult(green.stdout)
    rec.greenFailures = gf.names.length
    if (gf.names.length !== 0) {
      rec.status = 'not_green'
      rec.note = `还原后仍有 ${gf.names.length} 条失败：${gf.names.slice(0, 3).join(' / ')}`
      return rec
    }
    if (rec.hit.length < inj.expect.length) {
      rec.note = `期望命中的断言少命中了 ${inj.expect.length - rec.hit.length} 条：${inj.expect.filter((e) => !rec.hit.includes(e)).join(' | ')}`
    }
    rec.status = 'pass'
    return rec
  } finally {
    if (copy) {
      // 口径「丙」：副本那一栏**必须在这里数** —— 下一行就把副本删了。
      rec.dbCopy = existsSync(copy.REPO) ? sumRows(path.join(copy.REPO, 'data')) - copy.rowBefore : null
      if (!KEEP) { const r = rmrf(copy.TMP); if (!r.ok) console.log(`  [${inj.id}] ⚠️ 临时副本没删干净：${copy.TMP}（${r.why}）`) }
      else console.log(`  [${inj.id}] 副本保留：${copy.REPO}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 主流程（带并行度）
// ---------------------------------------------------------------------------
// `--only` 的匹配**大小写不敏感**：组 id 里有 `3a` 这种小写，而人在命令行上随手会写 `3A`。
// （第一次写成 `ONLY.has(inj.id)` 时 `--only=3a` 命中 0 组、还照样"通过 0 / 失败 0"—— 空跑。）
const picked = (id) => !ONLY || ONLY.has(String(id).toUpperCase())
const queue = INJECTIONS.filter((inj) => picked(inj.id))
const skipped = INJECTIONS.filter((inj) => !picked(inj.id)).map((inj) => inj.id)

console.log(`注入式「先红后证」：批次 U 之四 · 报表纵深之四（③-a/③-b/③-c）+ ④ 跨年度报表（${INJECTIONS.length} 组反例）
  源 ${ROOT}
  证据配对 docs/evidence/批次U之四_反例先红_报表纵深之四.txt
  尺子 ${INJECTIONS.map((i) => `${i.id}→${i.runner.replace('scripts/', '')}`).join(' ｜ ')}
  组数 ${queue.length}${skipped.length ? `（--only 过滤掉：${skipped.join(',')}）` : ''}｜并行度 ${JOBS}`)
// 空跑与"通过"同形：`--only` 写错一个字母就会命中 0 组，而输出照样是「通过 0 / 失败 0」。
// 所以命中 0 组时**响亮失败**，不假装验过。
if (queue.length === 0) {
  console.log(`\n❌ --only 没匹配到任何组（给的：${[...(ONLY || [])].join(',')}；本脚本的组：${INJECTIONS.map((i) => i.id).join(',')}）`)
  console.log(`\n计数 通过 0 / 失败 1`)
  process.exit(1)
}

// 工作区基线：逐字节核对用（目标源码 + 三库 —— 反例**不许改库**）
const targets = [...new Set(INJECTIONS.map((i) => i.file))]
const beforeHash = new Map()
for (const f of targets) { const p = path.join(ROOT, f); if (existsSync(p)) beforeHash.set(f, sha256(p)) }
const dbFiles = ['cosmetic', 'food', 'apparel'].map((i) => path.join('data', `gml_${i}.db`)).filter((f) => existsSync(path.join(ROOT, f)))
const dbBefore = new Map(dbFiles.map((f) => [f, sha256(path.join(ROOT, f))]))
const wsRowsBefore = sumRows(path.join(ROOT, 'data'))
const gitBefore = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout || ''

const results = new Array(queue.length)
let cursor = 0
async function worker() {
  while (true) {
    const slot = cursor++
    if (slot >= queue.length) return
    const inj = queue[slot]
    const rec = processInjection(inj)
    results[slot] = rec
    const red = rec.status === 'red_crashed' ? '崩（不可读）'
      : rec.failures.length ? `失败 ${rec.failures.length} 条` : '未变红'
    console.log(`[${inj.id}] ${inj.title}（尺子 ${rec.runner.replace('scripts/', '')}）\n     注入点 ${rec.anchor ? `${rec.anchor.file}:${rec.anchor.line}` : '—'} ｜ ${red}${rec.redTally ? `（套件口径 通过 ${rec.redTally.pass} / 失败 ${rec.redTally.fail}）` : ''} ｜ 期望命中断言 ${rec.hit.length}/${inj.expect.length} ｜ 还原后失败 ${rec.greenFailures === null ? '未跑' : rec.greenFailures} 条 ｜ 还原后 sha256 ${rec.sha ? (rec.sha.same ? `✓ 与注入前一致（${rec.sha.before.slice(0, 12)}）` : `✗ 不一致（${rec.sha.before.slice(0, 12)} → ${rec.sha.after.slice(0, 12)}）`) : '—'}${rec.note ? `\n     ⚠️ ${rec.note}` : ''}`)
    for (const f of rec.failures.slice(0, 5)) console.log(`      ✗ ${f}`)
    if (rec.failures.length > 5) console.log(`      …还有 ${rec.failures.length - 5} 条`)
  }
}
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, () => worker()))

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.status === 'pass').length
const failed = results.length - passed
console.log(`\n${'─'.repeat(112)}`)
console.log('组 | 尺子 | 注入点 | 变红 | 命中期望 | 还原回绿 | 还原后 sha256 | 结论')
console.log(`${'─'.repeat(112)}`)
for (const r of results) {
  const anchor = r.anchor ? `${r.anchor.file}:${r.anchor.line}` : '—'
  const verdict = {
    pass: '✅ 通过',
    red_crashed: '❌ 崩（不可读的红）',
    no_red: '❌ 未变红',
    anchor_miss: '❌ 锚点未命中',
    not_green: '❌ 还原未回绿',
    restore_failed: '❌ 还原失败（sha256 不一致）',
    env_failure: '⚠️ 环境/竞态类失败（非断言失败）'
  }[r.status] || `❌ ${r.status}`
  console.log(`${r.id} | ${r.runner.replace('scripts/', '')} | ${anchor} | ${r.failures.length} 条 | ${r.hit.length} | ${r.greenFailures === null ? '—' : r.greenFailures === 0 ? '是' : '否'} | ${r.sha ? (r.sha.same ? '一致' : '不一致') : '—'} | ${verdict}`)
}
console.log(`${'─'.repeat(112)}`)
console.log(`通过 ${passed} / 失败 ${failed}（共 ${results.length} 组）`)
const noRed = results.filter((r) => r.status === 'no_red')
console.log(`  「注入后压根没变红」${noRed.length} 组：${noRed.map((r) => r.id).join(',') || '无'}  ← 只说"本次这把尺子量不到"，不等于"没有断言在守"`)
const crashed = results.filter((r) => r.status === 'red_crashed')
console.log(`  「注入后崩、没有可读的红」${crashed.length} 组：${crashed.map((r) => r.id).join(',') || '无'}  ← 铁律 21：崩不算变红（还原后全绿 ⇒ 崩由注入引起）`)
const envFail = results.filter((r) => r.status === 'env_failure')
console.log(`  「环境/竞态类失败，非断言失败」${envFail.length} 组：${envFail.map((r) => r.id).join(',') || '无'}`)

// ---------------------------------------------------------------------------
// 工作区自证：目标文件逐字节未变 + git status 前后一致
// ---------------------------------------------------------------------------
console.log(`\n工作区自证（脚本只写 /tmp 副本）：`)
const stillThere = KEEP ? [] : CREATED.filter((p) => existsSync(p))
console.log(`  ${stillThere.length === 0 ? '✓' : '✗'} 本次创建的 ${CREATED.length} 份临时副本，收工时仍存在 ${stillThere.length} 份${stillThere.length ? `：${stillThere.join(' / ')}` : ''}`)
if (KEEP && CREATED.length) console.log(`  （--keep：本次保留 ${CREATED.length} 份，路径见上面逐组输出）`)
for (const f of targets) {
  const p = path.join(ROOT, f)
  const now = existsSync(p) ? sha256(p) : '(缺失)'
  console.log(`  ${now === beforeHash.get(f) ? '✓ 未变' : '✗ 已变'} ${f}（sha256 ${String(beforeHash.get(f)).slice(0, 12)} → ${String(now).slice(0, 12)}）`)
}
let dbChanged = 0
for (const f of dbFiles) if (sha256(path.join(ROOT, f)) !== dbBefore.get(f)) dbChanged += 1
const wsRowsAfter = sumRows(path.join(ROOT, 'data'))
const copyDelta = results.reduce((s, r) => s + (r.dbCopy || 0), 0)
console.log(`  ${dbChanged === 0 ? '✓' : 'ℹ️'} 本次改动数据库（两栏口径不同，**都要显式报**，没碰也要打 0）：`)
console.log(`      工作区 实测 ${wsRowsAfter - wsRowsBefore} 条（按表 COUNT(*) ${wsRowsBefore} → ${wsRowsAfter}）；本脚本对 data/ 只以 readonly 打开做只读计数 —— 受控实验：只读打开前后 sha256 逐字节不变`)
console.log(`        三库 sha256 本次${dbChanged === 0 ? '未变' : `有变化（${dbChanged} 个文件）—— 工作区同时有其它进程在写（常驻服务 / 别的 worker 对着开发库的套件），**这个差异不来自本脚本**`}`)
console.log(`      副本内快照 ${copyDelta} 条（${results.length} 份副本各数一遍求和；四把尺子对副本的 data/ 快照跑，test-fiscal-year 的写落在 BEGIN…ROLLBACK 里）`)
const gitAfter = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout || ''
const gitSame = gitBefore === gitAfter
console.log(`  ${gitSame ? '✓' : '⚠️'} git status --porcelain 与开跑前一致（开跑前 ${gitBefore.split('\n').filter(Boolean).length} 行 / 收工 ${gitAfter.split('\n').filter(Boolean).length} 行）`)
if (!gitSame) {
  const a = new Set(gitBefore.split('\n').filter(Boolean)); const b = new Set(gitAfter.split('\n').filter(Boolean))
  console.log(`    新增：${[...b].filter((x) => !a.has(x)).join(' | ') || '无'}`)
  console.log(`    消失：${[...a].filter((x) => !b.has(x)).join(' | ') || '无'}`)
  console.log('    （注：工作区可能同时有别人在改文件，差异未必来自本脚本；本脚本对源码只写 /tmp 副本）')
}

console.log(`\n计数 通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
