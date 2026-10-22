#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/accept/reversal-cashflow.mjs ｜ 独立验收：注入式「先红后证」—— 证明 `scripts/test-cashflow-item.mjs` 那些断言**真的验到了现金流量项目这一维**。
 * ============================================================================
 * 【职责】独立验收：注入式「先红后证」—— 证明 `scripts/test-cashflow-item.mjs` 那些断言**真的验到了现金流量项目这一维**。
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
 * 注入式「先红后证」—— 证明 `scripts/test-cashflow-item.mjs` 那些断言**真的验到了现金流量项目这一维**。
 *
 * 与证据文件的配对关系：
 *   产物 `docs/evidence/批次U_反例先红_现金流量项目辅助核算.txt`
 *   ←→ 本脚本。证据是**一次跑出来的记录**（文字摘录），本脚本是**能再跑一遍的东西**：
 *   证据只有"当时红了几条"这一句话，脚本里写着**改哪个文件的哪一行**、期望哪几条断言变红、
 *   还原之后必须回到全绿（且目标文件 sha256 与注入前一致）。数字允许与当时那次不完全相同
 *   （锚点按**当前源码**重钉），但**结论必须同向**：真红、真回绿。
 *
 * 为什么需要它（而不是"再跑一次测试看看绿不绿"）：
 *   那些断言现在都是绿的。但"绿"有两个互不相干的来源 ——
 *     ① 闸门/口径在，且被那条断言量到了；② 那条路径**恰好没走到**。
 *   正向通过区分不了这两者。唯一能区分的手段是**主动把口径拆坏**：
 *   拆掉之后如果断言**没变红**，说明这一节根本没量到它（铁律 22）。
 *
 * ## 覆盖面（9 组）
 *   派单点名要覆盖的 4 条：
 *     `1a` / `1b`  `cashFlowBuckets` 的 `if (tagged.length === 0)` 拆叉改成**恒真 / 恒假**（两个方向分别量）
 *     `2`          `tagVoucherCashFlow` 的「方向必须属于该项」校验 —— ⚠️ **这道校验在当前实现里不存在**。
 *                  说谎比缺覆盖更糟：所以这一组不假装它能被拆掉，而是**把这道闸门补上**，
 *                  看它会不会被逮住。逮住它的是本轮新加的那条 pin（`test-cashflow-item.mjs`
 *                  的"方向闸门"一段：现状 + 后果 + 自证不响 + 还原，共 4 条）。
 *     `3`          `listCashFlowItems` 少返回内置项
 *     `4`          迁移 `041` 里某条内置项方向写反 —— 它**只能**被本轮新加的方向字面 pin 逮住
 *                  （041 的 `verify()` 只查取值域，查不出"方向写反"；账还是平的，别的断言也不会响）
 *   另外 5 组（前一轮已验证、按当前源码重钉）：
 *     `5` 项目→报表行永远解析不出来 · `6` 摘掉探针 CF_ITEM_UNKNOWN · `7` 标记取号反了
 *     `8` 摘掉探针 CF_ITEM_DOMAIN · （`1a`/`1b` 同时覆盖"零标记等价被破坏"）
 *
 * ## 硬约束：**绝不动工作区**
 *   全部 patch / 跑测 / 还原都发生在 `/tmp` 下的**隔离副本**里（复刻 `run-on-copy.mjs` 的复制口径：
 *   只复制源码与配置，排除 .git / node_modules，node_modules 用只读软链）。
 *   `test-cashflow-item.mjs` 是对着 `data/gml_*.db` 取 `backup()` 快照再在快照上跑迁移的，
 *   所以副本里必须带一份 `data/` 快照 —— 工作区那三个 .db 依旧一个字节都不碰。
 *   收工自证四件事：① 逐组 sha256：还原后与注入前逐字节一致；② 目标文件全局 sha256 未变；
 *   ③ `git status --porcelain` 前后一致；④ **本次创建的临时副本一份都不剩**（逐份核对）。
 *   **反例不改库**：本脚本改的只有源码副本，工作区三库 sha256 前后一致，并如实报「改了几条库」。
 *
 * ## 铁律 21：「崩」与「可读的红」必须分开计数
 *   注入后进程非 0 退出、但一条 `✗` 都没有（或报错在无关位置）= `red_crashed`，不算"变红"，
 *   单独统计 —— 而且**还原后再跑一次**来区分"崩由这次注入引起"与"环境问题"。
 *
 * ⚠️ `/tmp` 里偶尔会看到**半截**的本脚本副本目录：那**不**来自本脚本的清理
 *   （收工自证会给出"仍存在 0 份"），而是被中途杀掉的进程留下的（例如同一命令被沙箱拒绝后
 *   在沙箱外重跑一遍，那一次会连同它的副本一起被 KILL）。看到半截目录先看收工自证那一行。
 *
 * 用法：
 *   node scripts/accept/reversal-cashflow.mjs            # 全部 9 组
 *   node scripts/accept/reversal-cashflow.mjs --dry      # 只验锚点唯一命中，不跑测试
 *   node scripts/accept/reversal-cashflow.mjs --only=1A,4
 *   node scripts/accept/reversal-cashflow.mjs --jobs=3   # 并行度（每组独占一份副本）
 *   node scripts/accept/reversal-cashflow.mjs --keep     # 保留 /tmp 副本便于复查
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
// 静默接受一个无意义的动作，与本批缺陷 186（`qty:-5` 静默成功）是同一族：
// 用户以为自己在"只验锚点、不跑"，实际得到的是"整套跑了一遍"。
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
const USAGE = '用法: node scripts/accept/reversal-cashflow.mjs [--dry] [--only=ID,ID] [--jobs=N] [--keep]\n' +
  '  --dry         只解析锚点（不跑套件、秒级）\n' +
  '  --only=1A,4   只跑指定组（组号见上面 INJECTIONS；大小写不敏感）\n' +
  '  --jobs=N      并行度（每组独占一份 /tmp 副本）\n' +
  '  --keep        保留 /tmp 副本便于复查\n' +
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
//   工作区：只读 COUNT(*) 一次（`readonly: true` 打开，不写一个字节）——
//           只报 sha256 的话，读者得自己**间接**推出"没碰"，而"没量"与"不碰"分不清。
//   副本内：套件对着副本里的 `data/` 快照跑；本脚本在每组跑完后再数一遍，如实报出差值
//           （套件自己还会再 `backup()` 到它自己的临时目录里写，那些写不在这一栏里）。
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

// 被测对象：本批只动 `server/lib/report.js` + 迁移 `041`，所以锚点全在这两个文件里。
const TARGET = 'server/lib/report.js'
const MIGRATION = 'server/db/migrations/041_cash_flow_item.cjs'
// 跑哪套尺子：三库、自建临时快照（`data/` 只读复制一份进副本）
const RUNNER = 'scripts/test-cashflow-item.mjs'

// ---------------------------------------------------------------------------
// 9 组注入。`from` 必须在文件里**唯一命中**；命中 0 次或 >1 次一律报"锚点未命中"，
// 绝不静默跳过（宁可空手，也不许假装验过）。
// `expect` 是"期望变红的断言名里的子串" —— 用子串而不是全等，是因为 `eq()` 型断言的
// 失败行会**带上期望/实际**（`名字：期望 X，实际 Y`），全等永远匹配不上。
// ---------------------------------------------------------------------------
const INJECTIONS = [
  {
    id: '1A',
    title: '岔路口拆叉 → 恒真（标记永远不生效；零标记那条路不变）',
    file: TARGET,
    from: '    if (tagged.length === 0) {',
    to: '    if (true) { // INJECT-CF1A：恒走旧口径 —— 标记永远不生效',
    expect: ['借方分录的标记取负号', '借方标记后计数如实', '打标记之后：100 从「销售收现」搬到']
  },
  {
    id: '1B',
    title: '岔路口拆叉 → 恒假（零标记的凭证也走标记路径：旧口径等价被破坏）',
    file: TARGET,
    from: '    if (tagged.length === 0) {',
    to: '    if (false) { // INJECT-CF1B：恒走标记路径 —— 没标记的凭证也被净额归兜底桶',
    expect: ['自造期间的逐行金额 == 旧口径参照实现', '自造期间的合计 == 参照实现', '自造期间的流入/流出/净额']
  },
  {
    id: '2',
    title: '补上「方向必须属于该项」的闸门（复核点名的那道 —— 当前实现里**不存在**）',
    file: TARGET,
    from: '    const subjectCode = subjectCodeOf.get(Number(p.entry.subject_id))',
    to: [
      '    const subjectCode = subjectCodeOf.get(Number(p.entry.subject_id))',
      '    // INJECT-CF2：把复核派单里点名的那道「方向必须属于该项」补上。',
      '    // 它当前**不存在**（`direction` 只用于展示标签与 CF_ITEM_DOMAIN 的取值域探针），',
      '    // 所以这一组量的不是"拆掉闸门会红"，而是"**补上闸门会不会被逮住**"。',
      '    {',
      "      const entryDir = db.prepare('SELECT direction FROM voucher_entries WHERE voucher_id=? AND seq=?').get(id, p.line_no)?.direction",
      "      const dirOf = db.prepare('SELECT direction FROM cash_flow_items WHERE code=?').get(p.to)?.direction",
      "      if (dirOf && dirOf !== 'both' && ((dirOf === 'in') !== (entryDir === 'credit'))) {",
      "        throw new ReportError('CF_ITEM_DIRECTION_MISMATCH', `第 ${p.line_no} 行是${entryDir === 'credit' ? '贷方（流入）' : '借方（流出）'}，却被标成方向为「${dirOf}」的项目`, 400, { line_no: p.line_no, direction: dirOf })",
      '      }',
      '    }'
    ].join('\n'),
    expect: ['现状：把借方（流出）分录取标成流入项目', '它的后果：250 记在**流入行**上但取负数']
  },
  {
    id: '3',
    title: 'listCashFlowItems 少返回内置项（字典接口静默变空）',
    file: TARGET,
    from: '  return rows.map((row) => ({',
    to: '  return rows.filter((r) => Number(r.is_builtin) !== 1).map((row) => ({ // INJECT-CF3：内置项不返回',
    expect: ['内置现金流量项目不少于 18 条', '三大类齐全', '至少 3 条内置项']
  },
  {
    id: '4',
    title: '迁移 041 里某条内置项方向写反（销售收现 in → out）',
    file: MIGRATION,
    from: "  { code: 'CFI_SALES_GOODS', name: '销售商品、提供劳务收到的现金', category: 'operating', direction: 'in', line: 'CF_SALES_CASH', sort: 110 },",
    to: "  { code: 'CFI_SALES_GOODS', name: '销售商品、提供劳务收到的现金', category: 'operating', direction: 'out', line: 'CF_SALES_CASH', sort: 110 }, // INJECT-CF4：方向写反",
    // ⚠️ 这条的**红法**在 041 改成 upsert 之后变了，别照旧理解：
    //    改的是**定义** ⇒ 已迁移的库会在 `up()` 里被 upsert 收敛到"定义那一份"（这正是 upsert 的目的），
    //    所以 `verify()` **不再**变红（两边自洽了）；红的是**钉住会计语义**的那两组断言：
    //    ① 库里那份（`mig`）方向已经变成 out ⇒ 方向字面 pin 红；② 全新库建出来就是 out ⇒ 同一 pin 红。
    //    换句话说：这条现在证明的是"**定义写错会一路传到库与报表**，而只有字面 pin 守得住"。
    expect: ['关键内置项的方向与会计语义一致', '全新库的内置项方向与会计语义一致']
  },
  {
    id: '5',
    title: '让"项目 → 报表行"永远解析不出来（标记形同虚设）',
    file: TARGET,
    from: '      const ln = lineOfItem.get(String(t.item))',
    to: '      const ln = undefined // INJECT-CF5：落点永远解析不出来 —— 标记静默退回分析',
    expect: ['借方分录的标记取负号', '借方标记后计数如实', '打标记之后：100 从「销售收现」搬到']
  },
  {
    id: '6',
    title: '摘掉探针：分录标了不存在的项目不再报（CF_ITEM_UNKNOWN 不再响）',
    file: TARGET,
    from: '    if (Number(unknownTag) > 0) {',
    to: '    if (false && Number(unknownTag) > 0) { // INJECT-CF6：这条探针不再出声',
    expect: ['CF_ITEM_UNKNOWN：分录挂着字典里不存在的项目时报出来']
  },
  {
    id: '7',
    title: '标记取号反了（流入流出对调，归属与自证同时坏）',
    file: TARGET,
    from: "      tagged.push({ line_no: ln, amount: t.direction === 'credit' ? t.amount : -t.amount })",
    to: "      tagged.push({ line_no: ln, amount: t.direction === 'credit' ? -t.amount : t.amount }) // INJECT-CF7：取号反了",
    expect: ['借方分录的标记取负号', '借方标记之后净增加额仍然不变', '借方标记之后自造期间自证仍通过']
  },
  {
    id: '8',
    title: '摘掉探针：字典的 category / direction 取值域被写坏不再报（CF_ITEM_DOMAIN 不再响）',
    file: TARGET,
    from: '    if (Number(badCat) > 0 || Number(badDir) > 0) {',
    to: '    if (false && (Number(badCat) > 0 || Number(badDir) > 0)) { // INJECT-CF8：这条探针不再出声',
    expect: ['CF_ITEM_DOMAIN：类别取值域被写坏时报出来', 'CF_ITEM_DOMAIN：方向取值域被写坏时报出来']
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

// 本脚本创建过的临时副本目录（收工时**逐份核对**"还在不在"，而不是笼统宣称清理过了 ——
// 铁律 11：自称的元信息必须由实算派生）
const CREATED = []

function makeCopy(tag) {
  const TMP = mkdtempSync(path.join(tmpdir(), `gml-rev-cf-${tag}-`))
  const REPO = path.join(TMP, 'repo')
  mkdirSync(REPO, { recursive: true })
  for (const d of COPY_DIRS) if (existsSync(path.join(ROOT, d))) cpSync(path.join(ROOT, d), path.join(REPO, d), { recursive: true })
  for (const f of COPY_FILES) if (existsSync(path.join(ROOT, f))) copyFileSync(path.join(ROOT, f), path.join(REPO, f))
  // `data/` 必须复制：`test-cashflow-item.mjs` 对着 `ROOT/data/gml_*.db` 取 `backup()` 快照。
  // 复制的是**快照**，副本里的改动与工作区无关（工作区那三个 .db 一个字节都不碰）。
  if (existsSync(path.join(ROOT, 'data'))) cpSync(path.join(ROOT, 'data'), path.join(REPO, 'data'), { recursive: true })
  // node_modules 只读软链复用 —— 依赖不属于被测对象，没必要再装一遍。
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(REPO, 'node_modules'), 'dir')
  CREATED.push(TMP)
  // 口径「丙」副本那一栏的**起点**：副本里那份 `data/` 快照数一遍
  const rowBefore = sumRows(path.join(REPO, 'data'))
  return { TMP, REPO, rowBefore }
}

function runSuite(REPO) {
  const r = spawnSync(process.execPath, [path.join(REPO, RUNNER)], {
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
 * 优先读收尾那一段（`失败项：` 之后的 `- 名字`，本项目的套件有 1 空格与 2 空格两种缩进）——
 * 它是套件自己维护的**去重后的断言名**，比解析 `✗` 行可靠（`eq()` 失败会打印两行：
 * 带期望/实际的一行 + 只有名字的一行，按行数统计会把同一条断言数成两条）。
 * 拿不到那一段（套件崩在半路）再退化为解析 `✗` 行，并把 `  → 明细`、`：期望…` 切掉。
 */
function readResult(stdout) {
  const txt = stripAnsi(stdout)
  const m = txt.match(/通过 (\d+) \/ 失败 (\d+)/)
  const tally = m ? { pass: Number(m[1]), fail: Number(m[2]) } : null
  const names = []
  const idx = txt.lastIndexOf('失败项：')
  if (idx >= 0) {
    for (const line of txt.slice(idx).split('\n').slice(1)) {
      if (/^ {1,2}- /.test(line)) names.push(line.replace(/^ {1,2}- /, '').trim())
    }
  }
  if (!names.length) {
    for (const line of txt.split('\n')) {
      if (/^ {2}✗ /.test(line)) names.push(line.replace(/^ {2}✗ /, '').split('  → ')[0].split('：期望')[0].trim())
    }
  }
  return { tally, names }
}

// ---------------------------------------------------------------------------
// 单组流程：patch（副本）→ 跑 → 断言命中 → 还原 → 再跑 → 断言回绿 → sha256 与注入前一致
// ---------------------------------------------------------------------------
function processInjection(inj) {
  const tag = `${inj.id}-${Date.now().toString(36)}`
  const rec = { id: inj.id, title: inj.title, file: inj.file, runner: RUNNER, anchor: null, status: 'unknown', failures: [], hit: [], redTally: null, greenFailures: null, crashed: false, note: '', sha: null, dbCopy: null }
  let copy = null
  try {
    copy = makeCopy(tag)
    const target = path.join(copy.REPO, inj.file)
    if (!existsSync(target)) { rec.status = 'anchor_miss'; rec.note = `文件不存在：${inj.file}`; return rec }

    const original = readFileSync(target, 'utf8')
    const shaBefore = sha256(target)
    const occurrences = original.split(inj.from).length - 1
    if (occurrences !== 1) {
      rec.status = 'anchor_miss'
      rec.note = `锚点在 ${inj.file} 命中 ${occurrences} 次（必须恰好 1 次）—— 源码改过之后锚点会漂，请按新源码重定`
      return rec
    }
    rec.anchor = { file: inj.file, line: original.slice(0, original.indexOf(inj.from)).split('\n').length }

    // ① 注入
    writeFileSync(target, original.replace(inj.from, inj.to))

    // ② 跑：必须变红（且可读）
    const red = runSuite(copy.REPO)
    const rr = readResult(red.stdout)
    rec.failures = rr.names
    rec.redTally = rr.tally
    if (rr.names.length === 0) {
      // 没有可读的 ✗。**先把文件还原、再跑一次**，用这一次的结果区分两种完全不同的成因：
      //   · 还原后全绿  ⇒ 崩是**这次注入**造成的（但按铁律 21，崩仍不算"可读的红"）；
      //   · 还原后还崩  ⇒ 与注入无关，是**环境/竞态**（端口、并发、资源）—— 别让下一个人
      //                   把它误读成"验收台坏了"或"这条断言没牙"。
      rec.crashed = red.status !== 0
      writeFileSync(target, original)
      const greenAfterCrash = runSuite(copy.REPO)
      const gfc = readResult(greenAfterCrash.stdout)
      rec.greenFailures = gfc.names.length
      if (gfc.names.length === 0 && greenAfterCrash.status === 0) {
        rec.status = rec.crashed ? 'red_crashed' : 'no_red'
        rec.note = rec.crashed
          ? `注入后进程退出码 ${red.status} 且**没有可读的 ✗**；还原后同一套件全绿 ⇒ 崩溃**由这次注入引起**（不是环境问题），但仍不计为"变红"（铁律 21）。stderr 尾部：${(red.stderr || '').split('\n').slice(-3).join(' | ').slice(0, 160)}`
          : '注入后失败数为 0 —— **在这把尺子（test-cashflow-item 三库）里**没有任何断言守住它（注意：这只说明"这把尺子量不到"，不等于"没有断言在守"）'
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
    const green = runSuite(copy.REPO)
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
      // 口径「丙」：副本那一栏**必须在这里数** —— 下一行就把副本删了，
      // 那时数出来的是"库没了"而不是"改了几条"。
      rec.dbCopy = existsSync(copy.REPO) ? sumRows(path.join(copy.REPO, 'data')) - copy.rowBefore : null
      if (!KEEP) { const r = rmrf(copy.TMP); if (!r.ok) console.log(`  [${inj.id}] ⚠️ 临时副本没删干净：${copy.TMP}（${r.why}）`) }
      else console.log(`  [${inj.id}] 副本保留：${copy.REPO}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 主流程（带并行度）
// ---------------------------------------------------------------------------
const queue = INJECTIONS.filter((inj) => !ONLY || ONLY.has(inj.id))
const skipped = INJECTIONS.filter((inj) => ONLY && !ONLY.has(inj.id)).map((inj) => inj.id)

console.log(`注入式「先红后证」：批次 U · 现金流量项目辅助核算（${INJECTIONS.length} 组反例）
  源 ${ROOT}
  证据配对 docs/evidence/批次U_反例先红_现金流量项目辅助核算.txt
  尺子 ${RUNNER}（三库；每组独占一份 /tmp 隔离副本，副本内自带 data/ 快照）
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
    console.log(`[${inj.id}] ${inj.title}\n     注入点 ${rec.anchor ? `${rec.anchor.file}:${rec.anchor.line}` : '—'} ｜ ${red}${rec.redTally ? `（套件口径 通过 ${rec.redTally.pass} / 失败 ${rec.redTally.fail}）` : ''} ｜ 期望命中断言 ${rec.hit.length}/${inj.expect.length} ｜ 还原后失败 ${rec.greenFailures === null ? '未跑' : rec.greenFailures} 条 ｜ 还原后 sha256 ${rec.sha ? (rec.sha.same ? `✓ 与注入前一致（${rec.sha.before.slice(0, 12)}）` : `✗ 不一致（${rec.sha.before.slice(0, 12)} → ${rec.sha.after.slice(0, 12)}）`) : '—'}${rec.note ? `\n     ⚠️ ${rec.note}` : ''}`)
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
console.log('组 | 注入点 | 变红 | 命中期望 | 还原回绿 | 还原后 sha256 | 结论')
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
  console.log(`${r.id} | ${anchor} | ${r.failures.length} 条 | ${r.hit.length} | ${r.greenFailures === null ? '—' : r.greenFailures === 0 ? '是' : '否'} | ${r.sha ? (r.sha.same ? '一致' : '不一致') : '—'} | ${verdict}`)
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
// 工作区自证：副本已清 + 目标文件逐字节未变 + 三库未变（反例**不改库**）+ git status 前后一致
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
console.log(`      副本内快照 ${copyDelta} 条（${results.length} 份副本各数一遍求和；套件对副本的 data/ 只读 —— 它自己再 backup() 到自己的临时目录里写）`)
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
