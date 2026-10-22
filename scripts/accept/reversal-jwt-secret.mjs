#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/accept/reversal-jwt-secret.mjs ｜ 独立验收：注入式「先红后证」—— 证明 `scripts/test-jwt-secret.mjs` 的那些断言**真的验到了闸门**。
 * ============================================================================
 * 【职责】独立验收：注入式「先红后证」—— 证明 `scripts/test-jwt-secret.mjs` 的那些断言**真的验到了闸门**。
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
 * 注入式「先红后证」—— 证明 `scripts/test-jwt-secret.mjs` 的那些断言**真的验到了闸门**。
 *
 * 为什么需要它：
 *   那些断言现在都是绿的。但"绿"有两个互不相干的来源 ——
 *     ① 闸门在，且被触发；② 闸门不在，而那条路径**恰好没走到**。
 *   正向通过区分不了这两者。唯一能区分的手段是**主动把闸门拆坏**：
 *   拆掉之后如果断言**没变红**，说明这一节根本没验到那道闸门。
 *   A20 残余这条线尤其需要：它的断言大多在**子进程 + 真启动**里（`NODE_ENV=production` 到底会不会
 *   拒绝启动），而不是在同一进程里算一个纯函数 —— 只跑一遍绿，说明不了"换个环境它会红"。
 *
 * 硬约束：**绝不动工作区**。
 *   全部 patch / 跑测 / 还原都发生在 `/tmp` 下的**隔离副本**里，
 *   收工再用 sha256 逐字节核对源文件，证明工作区一个字节都没变。
 *
 * 铁律 21：「崩」与「可读的红」分开计数。
 *   注入后进程非 0 退出、但一条 `✗` 都没有 = `red_crashed`，不算"变红"。
 *
 * 覆盖面（7 组，锚点按**修完后**的源码重新定的）：
 *   R1 生产判定恒假 · R2 回退等级 warn→ok · R3 公开默认值等级 warn→ok
 *   R4 认不出的 NODE_ENV 不再出声 · R5 NODE_ENV 不归一化 · R6 签名改用归一化值
 *   R7 往 compose 的 environment 里塞一行 `NODE_ENV`（把 (b) 方案静默退回 (a)）
 *   R4/R5/R6 这三组就是"**模拟回退 ⇒ 判据变红**"的机制：它们对应的断言是
 *   本轮从「钉现状」翻过来的（修完当守卫），这三组证明翻转后的 pin **仍然会报警**；
 *   R7 钉的不是源码判据而是**设计前提** —— 第 2 道闸门靠 Dockerfile 的
 *   `NODE_ENV=production` 一路继承下来，compose 一旦显式设了它，闸门就静默失效。
 *
 * 本轮攒下的三条教训（同属"绿得不该绿"那一族，都别再犯）：
 *   ① 行内追加 `// INJECT-x` 会把该行**剩下的代码**一起注释掉 ⇒ 文件语法错 ⇒ 报出来的是
 *      `red_crashed`（崩），不是可读的红。所以「崩」与「可读的红」必须**分开计数**（铁律 21）。
 *   ② 期望清单写错（把**不该红**的断言列了进去）＋ 通过口径过松（第一版写的是"命中 ≥1 条
 *      即通过"）⇒ 打出 `命中期望 1/2` 却仍然记成通过。所以通过口径改成「期望清单**全部
 *      命中**」；部分命中一律算失败 —— 它要么说明我清单写错了，要么说明有一把尺子**已经不响**。
 *   ③ ②的推广：凡是"**部分成功长得像全部成功**"的地方（命中率、覆盖率、抽样、自检），
 *      口径都要写死成**断言式**的，不留「≥1 / 大约 / 大部分 / 差不多」。本脚本的三条输出
 *      口径就是它的落地：甲=每组一行（注入点·变红断言名·命中期望 N/N·还原后失败数）、
 *      乙=收尾计数行（`通过 N / 失败 M`）＋退出码、丙=库改动自报（**没碰也要打 0**）。
 *   ④ 加口径「丁」（拒绝不认识的参数）时我自己踩的一个洞，同族，留在这儿：
 *      第一版按"取 `=` 左边那截"去比名字 ⇒ `--dry=1` 被判成"认得的 `--dry`"而放行，
 *      可 `argv.includes('--dry')` 是 false ⇒ DRY 保持 false ⇒ **它一声不响把整套跑完了**。
 *      也就是说：丁把"没这个 flag"堵住了，却从"**flag 打错字/**`=1`"这个后门漏了过去。
 *      教训：闸门的判据要和**真正生效的那次读取**同源（这里：裸开关必须整字相符），
 *      否则"被拒绝的参数"与"被忽略的参数"会各自成立、合起来是假绿。
 *      另一半同族：`--only=<不存在的组号>` 会命中 0 组，而输出是「通过 0 / 失败 0」退出 0。
 *      现在两者都由丁显式拒掉（退出码 2），并有参数矩阵逐格验过。
 *
 * 丙（库改动自报）为什么**只**报这些、**不**给工作区 `data/*.db` 采 sha256 ——
 * 这一条会被"顺手加一下不就好了"质疑，所以理由写在这儿：
 *   `data/` 是**全机共享**的可变资源：3001 上那个常驻服务正开着这三个库，WAL 模式下随时落页。
 *   本脚本若去采它的 sha256，采到的差值里**混着别人的写**，于是"我改了几条库"这一栏会
 *   **经常报非 0 而其实与本次运行无关** —— 这就是**铁律 20**：可重放须划清作用范围，
 *   **范围写宽 = 假红，而假红比漏报更耗信任**（下一个人会开始怀疑整条证据链，连真报也一起不信）。
 *   所以丙只报**能划在自己作用范围内**的两件事：
 *     ① 可见性 —— 工作区 `data/` 下现在有几个库文件（数一数，可被 `find data -name '*.db*'` 独立核对）；
 *     ② 可确定性 —— 隔离副本里**连 `data/` 目录都没有**、`.db` 计数为 0（测试的 cwd 里没有可写的库）。
 *   **这不是"没量"，是范围划对了**。要更强的话得改成"只测本脚本自己开过的那些库"，
 *   那要先把本机常驻服务停掉 —— 不属于本脚本该干的事。
 *
 * 用法：
 *   node scripts/accept/reversal-jwt-secret.mjs            # 全部 7 组
 *   node scripts/accept/reversal-jwt-secret.mjs --dry      # 只验锚点唯一命中 + 顺带打丙行，不跑测试
 *   node scripts/accept/reversal-jwt-secret.mjs --only=R1,R4
 *   node scripts/accept/reversal-jwt-secret.mjs --keep     # 保留 /tmp 副本便于复查
 *   node scripts/accept/reversal-jwt-secret.mjs --help     # 只打用法
 *   （`--only` 的组号**大小写不敏感**：`--only=r1,r4` 与 `--only=R1,R4` 等价。）
 *
 * 参数（口径「丁」）：**不认识的参数一律拒绝**（打用法 + 非 0 退出），不许静默忽略 ——
 *   "我以为只验锚点、实际跑了一遍"和缺陷 186（`qty:-5` 静默成功）是同一族。
 *   `--only=` 里写错的组号同样被拒（否则命中 0 组，而输出是「通过 0 / 失败 0」，空跑与通过同形）。
 *   判据（与"日志里的码 / 响应里的码不同源"同族，可直接传播给别的脚本）：
 *     **闸门认得的形状，必须与生效时真正读取的形状，来自同一次解析。**
 *   裸开关（`--dry` / `--keep` / `--help`）只认**整字**：`--dry=1`、`--keep=1` 一律判非法 ——
 *   不许"忽略那个 1"。（原版正是这么漏的：闸门按 `=` 左边判名字 ⇒ 放行；行为按整串相等 ⇒
 *   判否 ⇒ `DRY` 保持 false ⇒ 一声不响整套跑完。）
 *
 * 本脚本**没有** `--jobs` —— 它不并发。这里刻意**不**把 `--jobs` 写进用法：写了就等于说谎，
 * 而"静默忽略一个不存在的开关"正是丁要拦的事；宁可让丁把它拒掉（退出码 2），也不假装支持。
 *
 * 退出码：0 = 全组通过；1 = 有组没通过／工作区被改；2 = 参数错（与 1 分开，便于一眼定位）。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, symlinkSync, existsSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ---------------------------------------------------------------------------
// 参数（口径「丁」）：**不认识的参数一律拒绝** —— 打用法 + 非 0 退出，不许静默忽略。
// 为什么必须显式拒绝：静默接受一个无意义的动作，与本批缺陷 186（`qty:-5` 静默成功）同族 ——
// 用户以为自己在"只验锚点、不跑"，实际得到的是"整套跑了一遍"。
// 本脚本支持 `--dry`，所以这里的风险不是"没有这个 flag"，而是**打错字**：`--drry`、`--dry=1`、
// `--only=R9` 都会落到"照常全跑"或"一组都不跑"上去，而这两种结局**都长得像成功**。
// 退出码 2 专表"参数错"，与 1（有组没通过／工作区被改）分开，读日志的人一眼知道该看哪。
// ---------------------------------------------------------------------------
const USAGE = '用法: node scripts/accept/reversal-jwt-secret.mjs [--dry] [--only=R1,R3] [--keep]\n' +
  '  --dry            只验锚点唯一命中（并顺带打丙行），不跑测试\n' +
  '  --only=<R1,R3>   只跑指定组（R1~R7，逗号分隔；**大小写不敏感**）；写错组号会被拒绝，不会"空跑当通过"\n' +
  '  --keep           保留 /tmp 副本便于复查\n' +
  '  --help           只打这份用法\n' +
  '  裸开关只认整字：`--dry=1` / `--keep=1` 判非法（不是"忽略那个 1"）\n' +
  '  （本脚本不并发，故**没有** --jobs：与其静默忽略，不如让丁把它拒掉）'
// 取值/不取值必须分开认：
//   只有 `--only` 带值；`--dry` / `--keep` / `--help` 是**裸开关**。
//   第一版按"取 `=` 左边那截"去比名字，于是 `--dry=1` 被判成"认得的 `--dry`"而放行 ——
//   可 `argv.includes('--dry')` 是 false，DRY 保持 false ⇒ **它一声不响把整套跑完了**。
//   这就是丁要堵的那个洞本人（我自己写的），所以这里改成"裸开关必须整字相符"。
const BARE_FLAGS = ['--dry', '--keep', '--help']
const badArgs = process.argv.slice(2).filter((a) => a.startsWith('--only=') ? false : !BARE_FLAGS.includes(a))
if (badArgs.length) {
  console.error(`❌ 不认识的参数：${badArgs.join(' ')}`)
  console.error(USAGE)
  process.exit(2)
}
if (process.argv.includes('--help')) { console.log(USAGE); process.exit(0) }

const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) : null
const DRY = process.argv.includes('--dry')
const KEEP = process.argv.includes('--keep')

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// ---------------------------------------------------------------------------
// 库文件体检：数一个目录树下有多少 "库文件"（.db / .db-wal / .db-shm）。
//   定义在这里（而不是在 COPY_FILES 旁边），因为 `--dry` 也要用它 —— 它必须在
//   --dry 分支**执行之前**求值：函数声明会提升，但它引用的 `const DB_FILE_RE` 不会，
//   放到 --dry 之后就变成 `ReferenceError: Cannot access 'DB_FILE_RE' before initialization`
//   （这个机制单独核实过，不是纸上顾虑）。
// ---------------------------------------------------------------------------
const DB_FILE_RE = /\.db(?:-wal|-shm)?$/
function countDbFiles(dir) {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) n += countDbFiles(p)
    else if (DB_FILE_RE.test(e.name)) n += 1
  }
  return n
}

// ---------------------------------------------------------------------------
// 7 组注入。`from` 必须在文件里**唯一命中**；命中 0 次或 >1 次一律报"锚点未命中"，
// 绝不静默跳过（宁可空手，也不许假装验过）。`expect` 是"期望变红的断言名里的子串"。
// ---------------------------------------------------------------------------
const INJECTIONS = [
  {
    id: 'R1',
    title: '生产判定恒假（`isProd = false`）⇒ 生产 + 无密钥不再拒绝启动',
    file: 'server/middleware/auth.js',
    from: "  const isProd = nodeEnv === 'production'",
    to: '  const isProd = false // INJECT-R1',
    expect: ['① 归一化', '两个都没设 + NODE_ENV=production ⇒ level=fatal', '真启动·`NODE_ENV=Production`']
  },
  {
    id: 'R2',
    title: "回退等级 warn → ok（回退不再响亮）",
    file: 'server/middleware/auth.js',
    from: "    source: 'fallback',\n    level: isProd ? 'fatal' : 'warn',",
    to: "    source: 'fallback',\n    level: isProd ? 'fatal' : 'ok', // INJECT-R2",
    expect: ['两个都没设 + 非生产 ⇒ level=warn', '反向：凡是回退']
  },
  {
    id: 'R3',
    title: "公开已知值的等级 warn → ok（公开默认值不再出声）",
    file: 'server/middleware/auth.js',
    from: "        source: 'public-default',\n        level: isProd ? 'fatal' : 'warn',",
    to: "        source: 'public-default',\n        level: isProd ? 'fatal' : 'ok', // INJECT-R3",
    // 期望清单只放**这一处注入真正应当打红**的断言：
    // `⑥ 跨层·第 2 道闸门` 测的是"生产 + 公开值 ⇒ fatal"，而本组只改**非生产**那一侧，
    // 所以它**不该**红 —— 第一版把它写进 expect，报出 1/2（脚本没错，是我的清单写错了）。
    expect: ['② 公开已知值', '② 警告文案跟']
  },
  {
    id: 'R4',
    title: '认不出的 NODE_ENV 不再可见（`unknownNodeEnv = false`）——「模拟回退」',
    file: 'server/middleware/auth.js',
    from: "  const unknownNodeEnv = nodeEnv !== '' && !KNOWN_NODE_ENVS.includes(nodeEnv)",
    to: '  const unknownNodeEnv = false // INJECT-R4',
    expect: ['① 认不出', '① 落点：认不出']
  },
  {
    id: 'R5',
    title: 'NODE_ENV 不归一化（去掉 trim + toLowerCase）——「模拟回退」',
    file: 'server/middleware/auth.js',
    from: "  const nodeEnv = String(env.NODE_ENV ?? '').trim().toLowerCase()",
    to: "  const nodeEnv = String(env.NODE_ENV ?? '') // INJECT-R5",
    expect: ['① 归一化', '① 认得出']
  },
  {
    id: 'R6',
    title: '签名改用归一化值（`secret: raw` → `secret: classified`）——「模拟回退」',
    file: 'server/middleware/auth.js',
    from: 'secret: raw,',
    // ⚠️ 这里**不能**在行中间追加 `// INJECT-R6` —— 那会把该行剩下的
    // `reason: ... }` 一起注释掉 ⇒ 文件语法错误 ⇒ 报的是 `red_crashed`（崩），
    // 不是可读的红。第一版就是这么写的，被"崩与红分开计数"逮住（铁律 21 生效）。
    to: 'secret: classified,',
    expect: ['② 签名用**原始**值']
  },
  {
    id: 'R7',
    title: '往 compose 的 environment 里加一行 `NODE_ENV: development`（(b) 方案被静默退回 (a)）',
    file: 'docker-compose.yml',
    // 锚在 environment 块内的一个已有键上 —— 注入结果就落在同一个块里，
    // 正是"有人顺手加一行"会写出的东西。
    from: '      GML_DATA_DIR: /data',
    to: '      GML_DATA_DIR: /data\n      NODE_ENV: development # INJECT-R7',
    expect: ['⑥ 跨层·第 2 道闸门的**前提**']
  }
]

// ---------------------------------------------------------------------------
// `--only` 的组号必须真实存在。
//   为什么单列一条：写错一个字母（`--only=R9`、`--only=R1 ,R2`）会命中 **0 组**，
//   而输出照样是「通过 0 / 失败 0」+ 退出码 0 —— 空跑与"全部通过"**同形**。
//   这跟丁拒绝不认识的 flag 是同一族，只是被拒的东西从 flag 换成了组号。
// ---------------------------------------------------------------------------
const KNOWN_IDS = INJECTIONS.map((i) => i.id)
if (ONLY) {
  const unknownIds = [...ONLY].filter((id) => !KNOWN_IDS.includes(id))
  if (!ONLY.size || unknownIds.length) {
    console.error(`❌ --only ${ONLY.size ? `里有不存在的组号：${unknownIds.join(' ')}` : '后面没给组号'}`)
    console.error(`   现有组号：${KNOWN_IDS.join(' ')}`)
    console.error(USAGE)
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// --dry：只做锚点解析（跑一轮 7 组要几分钟，先验锚点能省一大截）
// ---------------------------------------------------------------------------
if (DRY) {
  let miss = 0
  for (const inj of INJECTIONS) {
    const p = path.join(ROOT, inj.file)
    const n = existsSync(p) ? readFileSync(p, 'utf8').split(inj.from).length - 1 : 0
    if (n !== 1) miss += 1
    console.log(`[${inj.id}] ${n === 1 ? '✓ 锚点唯一命中' : `✗ 命中 ${n} 次（必须恰好 1 次）`}  ${inj.file}  ${inj.title}`)
  }
  console.log(`\n--dry：${INJECTIONS.length - miss} / ${INJECTIONS.length} 组锚点就绪${miss ? `，${miss} 组未命中` : ''}`)
  // 丙（库改动自报）也在这里先给一眼工作区侧的**实测值**：它只是个计数器，不是我打上去的
  // 常量 —— 拿 `ls data/*.db*` 这类独立工具数一遍，两边对得上才算这个"0"有依据。
  console.log(`本次改动数据库：工作区 0 条（脚本不碰 data/ 下的任何 .db）`)
  console.log(`     实测依据（--dry 未建副本）：工作区 data/ 下现有 ${countDbFiles(path.join(ROOT, 'data'))} 个库文件，可用 ls data/*.db* 独立核对`)
  process.exit(miss ? 1 : 0)
}

// ---------------------------------------------------------------------------
// 隔离副本：**只复制本组要测的东西**
//   · `server/`（被测对象）· `scripts/test-jwt-secret.mjs`（那把尺子）· `docker-compose.yml`
//     （测试的 ⑥ 要从它里面读兜底默认值）· `package.json`（ESM 判定）。
//   · 刻意**不**整棵复制 `scripts/`：那里有一堆与本组无关的脚本（selfcheck 会建整库），
//     既慢又会引入无关失败源。本组要的证据只在 `test-jwt-secret.mjs` 里。
//   · data/ .env .git 一个都不复制；node_modules 只读软链复用。测试自己把数据目录指到 /tmp。
// ---------------------------------------------------------------------------
const COPY_FILES = ['scripts/test-jwt-secret.mjs', 'docker-compose.yml', 'package.json']

// 隔离副本的"有没有库"体检：首次建副本时记下，末尾的丙行（库改动自报）要引用它。
let copyProbe = null
function makeCopy(tag) {
  const TMP = mkdtempSync(path.join(tmpdir(), `gml-revjwt-${tag}-`))
  const REPO = path.join(TMP, 'repo')
  mkdirSync(REPO, { recursive: true })
  cpSync(path.join(ROOT, 'server'), path.join(REPO, 'server'), { recursive: true })
  for (const rel of COPY_FILES) {
    mkdirSync(path.dirname(path.join(REPO, rel)), { recursive: true })
    copyFileSync(path.join(ROOT, rel), path.join(REPO, rel))
  }
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(REPO, 'node_modules'), 'dir')
  if (!copyProbe) copyProbe = { hasDataDir: existsSync(path.join(REPO, 'data')), dbFiles: countDbFiles(REPO) }
  return { TMP, REPO }
}

function runSuite(REPO) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/test-jwt-secret.mjs')], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env }
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/** 从 stdout 抓 `  ✗ <断言名>`（去掉 ANSI 与 `  → 详情`） */
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')
function readFailures(stdout) {
  return stripAnsi(String(stdout || ''))
    .split('\n')
    .filter((l) => /^ {2}✗ /.test(l))
    .map((l) => l.replace(/^ {2}✗ /, '').split('  → ')[0].trim())
}
const readTally = (stdout) => (stripAnsi(String(stdout || '')).match(/通过\s*(\d+)\s*\/\s*失败\s*(\d+)/) || []).slice(1).map(Number)

// ---------------------------------------------------------------------------
// 单组流程：patch（副本）→ 跑 → 断言命中 → 还原 → 再跑 → 断言回绿
// ---------------------------------------------------------------------------
function processInjection(inj) {
  const tag = `${inj.id}-${Date.now().toString(36)}`
  const rec = { id: inj.id, title: inj.title, file: inj.file, anchorLine: null, status: 'unknown', failures: [], hit: [], greenFailures: null, crashed: false, note: '' }
  let copy = null
  const append = (s) => { rec.note = rec.note ? `${rec.note} ｜ ${s}` : s }
  try {
    copy = makeCopy(tag)
    const target = path.join(copy.REPO, inj.file)
    if (!existsSync(target)) { rec.status = 'anchor_miss'; append(`文件不存在：${inj.file}`); return rec }
    const original = readFileSync(target, 'utf8')
    const occurrences = original.split(inj.from).length - 1
    if (occurrences !== 1) {
      rec.status = 'anchor_miss'
      append(`锚点在 ${inj.file} 命中 ${occurrences} 次（必须恰好 1 次）`)
      return rec
    }
    rec.anchorLine = original.slice(0, original.indexOf(inj.from)).split('\n').length

    // ① 注入
    writeFileSync(target, original.replace(inj.from, inj.to))

    // ② 跑：必须变红（且可读）
    const red = runSuite(copy.REPO)
    rec.failures = readFailures(red.stdout)
    if (rec.failures.length === 0) {
      // 没有可读的 ✗。先把文件还原、再跑一次，用这一次的结果区分两种成因：
      //   · 还原后全绿 ⇒ 崩是**这次注入**造成的（但按铁律 21，崩不算"可读的红"）；
      //   · 还原后还崩 ⇒ 与注入无关（环境/竞态）—— 别让人误读成"这套断言没牙"。
      rec.crashed = red.status !== 0
      writeFileSync(target, original)
      const after = runSuite(copy.REPO)
      const af = readFailures(after.stdout)
      rec.greenFailures = af.length
      if (af.length === 0 && after.status === 0) {
        rec.status = rec.crashed ? 'red_crashed' : 'no_red'
        append(rec.crashed
          ? `注入后退出码 ${red.status} 且**没有可读的 ✗**；还原后全绿 ⇒ 崩由本次注入引起，但不计为"变红"（铁律 21）。stderr 尾部：${(red.stderr || '').split('\n').slice(-2).join(' | ').slice(0, 140)}`
          : '注入后失败数为 0 —— **在 `test-jwt-secret.mjs` 里没有任何断言守住它**')
      } else {
        rec.status = 'env_failure'
        append(`⚠️ 环境/竞态类失败，非断言失败：注入后无 ✗，且还原后同样失败 ${af.length} 条 ⇒ 与本次注入无关`)
      }
      return rec
    }
    rec.hit = inj.expect.filter((sub) => rec.failures.some((n) => n.includes(sub)))

    // ③ 还原（并逐字节核对）
    writeFileSync(target, original)
    if (readFileSync(target, 'utf8') !== original) { rec.status = 'restore_failed'; append('还原后与原文不一致'); return rec }

    // ④ 再跑：必须回绿
    const green = runSuite(copy.REPO)
    const gf = readFailures(green.stdout)
    rec.greenFailures = gf.length
    if (gf.length !== 0) {
      rec.status = 'not_green'
      append(`还原后仍有 ${gf.length} 条失败：${gf.slice(0, 3).join(' / ')}`)
      return rec
    }
    // **期望清单必须全部命中**才算通过（不是"命中一条就算"）：
    // 部分命中意味着两件事之一 —— 要么我列的期望里有不该红的（我的清单错了），
    // 要么有一把尺子**已经不响了**（判据退化）。两种都要当场看见，不能混在"通过"里。
    rec.status = rec.hit.length === inj.expect.length ? 'pass' : 'red_but_unexpected'
    if (rec.hit.length !== inj.expect.length) append(`期望 ${inj.expect.length} 条、只命中 ${rec.hit.length} 条：缺 ${inj.expect.filter((s) => !rec.hit.includes(s)).join(' | ')}；实际红：${rec.failures.slice(0, 4).join(' / ')}`)
    return rec
  } finally {
    if (copy && !KEEP) { try { rmSync(copy.TMP, { recursive: true, force: true }) } catch {} }
    if (copy && KEEP) console.log(`  [${inj.id}] 副本保留：${copy.REPO}`)
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const watched = [...new Set(INJECTIONS.map((i) => i.file)), 'scripts/test-jwt-secret.mjs']
const before = Object.fromEntries(watched.map((f) => [f, sha256(path.join(ROOT, f))]))

const queue = INJECTIONS.filter((inj) => !ONLY || ONLY.has(inj.id))
console.log(`注入式「先红后证」：JWT 密钥姿态（A20 残余）\n  源 ${ROOT}\n  组数 ${queue.length}${ONLY ? `（--only 过滤掉：${INJECTIONS.filter((i) => !ONLY.has(i.id)).map((i) => i.id).join(',')}）` : ''}\n`)

const base = (() => {
  const c = makeCopy('baseline')
  try {
    const r = runSuite(c.REPO)
    const t = readTally(r.stdout)
    return { red: readFailures(r.stdout).length, tally: t.length === 2 ? `通过 ${t[0]} / 失败 ${t[1]}` : '（无统计行）', status: r.status }
  } finally { try { rmSync(c.TMP, { recursive: true, force: true }) } catch {} }
})()
console.log(`【副本基线】${base.tally}  红=${base.red}${base.red ? ' ⚠️ 基线不绿，注入结论不可信' : ''}\n`)

const recs = []
for (const inj of queue) {
  const rec = processInjection(inj)
  recs.push(rec)
  console.log(`[${rec.id}] ${rec.status === 'pass' ? '✓' : '✗'} ${rec.title}`)
  console.log(`     注入点：${rec.file}:${rec.anchorLine ?? '?'}（唯一命中）`)
  console.log(`     变红断言（${rec.failures.length} 条）：${rec.failures.slice(0, 4).join(' / ')}${rec.failures.length > 4 ? ` …其余 ${rec.failures.length - 4} 条` : ''}`)
  console.log(`     命中期望：${rec.hit.length}/${inj.expect.length}${rec.hit.length ? `（${rec.hit.join(' | ')}）` : ''}｜还原后失败数：${rec.greenFailures}`)
  if (rec.note) console.log(`     备注：${rec.note}`)
  console.log('')
}

// 工作区未被触碰（逐字节）
const changed = watched.filter((f) => sha256(path.join(ROOT, f)) !== before[f])
console.log(`${changed.length ? '✗' : '✓'} 工作区核对：${watched.length} 个被监视文件${changed.length ? ` 有改动：${changed.join(' / ')}` : ' sha256 逐字节未变'}`)

// ---------------------------------------------------------------------------
// 丙：库改动自报（铁律 21 —— "没碰"也要**可见地说出来**）。
//   为什么不能省：本脚本压根不碰库，恰恰因此这行必须由它自己说，否则读者区分不了
//   "不碰" 与 "没量"；也用不着靠上面那条源码 sha256 去**间接暗示**。
//   报法把两件事分开，一类是结论、一类是可确定地量到的依据：
//     · 结论：本次改动数据库 0 条。
//     · 依据：工作区 data/ 下现有几个库文件（"库在那里"的可见性），以及隔离副本里
//       **连 data/ 目录都没有、`.db` 计数为 0** —— 测试进程的 cwd 里没有库可写。
//   刻意**不**去采样 `data/*.db` 的 sha256：那是全机共享的可变资源（本机就有服务在写
//   .db-wal），一采样就会把**别人的**写入记成"我改了库"，制造假红。只拿确定的东西当证据。
// ---------------------------------------------------------------------------
const wsDbFiles = countDbFiles(path.join(ROOT, 'data'))
const probe = copyProbe
console.log('本次改动数据库：工作区 0 条（脚本不碰 data/ 下的任何 .db）')
console.log(`     实测依据：工作区 data/ 下现有 ${wsDbFiles} 个库文件；隔离副本内 data/ 目录${probe ? (probe.hasDataDir ? '**存在**（不该有！）' : '不存在') : '（未取样）'}、副本内 .db 计数 ${probe ? probe.dbFiles : '（未取样）'} ⇒ 测试进程的工作目录里没有可写的库`)

const passN = recs.filter((r) => r.status === 'pass').length
const failN = recs.length - passN
console.log(`\n${'─'.repeat(60)}`)
console.log(`通过 ${passN} / 失败 ${failN}`)
if (failN) {
  const bad = recs.filter((r) => r.status !== 'pass')
  console.log('失败项：\n - ' + bad.map((r) => `${r.id}(${r.status}) ${r.note}`).join('\n - '))
}
process.exit(failN || changed.length ? 1 : 0)
