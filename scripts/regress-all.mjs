/**
 * ============================================================================
 * 文件标识：scripts/regress-all.mjs ｜ 全量回归跑批台：按轮次串行跑 test-* / verify-* / check-* / smoke-api/tsc/vite build，输出「通过 N / 失败 M」与断言累计
 * ============================================================================
 * 【职责】全量回归跑批台：按轮次串行跑 test-* / verify-* / check-* / smoke-api / tsc / vite build，输出「通过 N / 失败 M」与断言累计
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自手写**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 全量回归跑批（串行）。
 *
 * 为什么要有这个脚本：本项目的回归是「21 套 test-*.mjs × 三库 + 4 个自检脚本 +
 * 类型检查 + 构建」这样一组命令，逐条手工敲有两个问题：
 *   ① **会漏**：手工跑的时候最容易漏掉那些"没改到、所以觉得不用跑"的域，
 *      而本项目出过的缺陷恰恰多是"改 A 域弄坏 B 域"（内核 / 库存引擎 / 口径复核）；
 *   ② **跑错库**：每套测试的行业参数是 `process.argv[2]`，漏传就静默只用 cosmetic 跑一遍，
 *      另外两个库根本没测，而输出里看不出来。
 * 所以这里把「哪些测试要×三库」这件事**从文件名读出来**，而不是靠人记。
 *
 * **必须串行**：多个脚本并发写同一个 SQLite 会 WAL 竞争，
 * 报出来的错与真实原因无关（本项目已踩过）。
 *
 * 用法：
 *   node scripts/regress-all.mjs             # 默认 3 轮
 *   ROUNDS=1 node scripts/regress-all.mjs    # 只跑一轮（改一处时用）
 *   ONLY=promo node scripts/regress-all.mjs  # 只跑文件名含 promo 的测试（调试用）
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath
const ROUNDS = Number(process.env.ROUNDS || 3)
if (!Number.isSafeInteger(ROUNDS) || ROUNDS < 1) throw new Error('ROUNDS must be a positive integer')
const requestedData = process.env.GML_DATA_DIR
const repoData = path.join(ROOT, 'data')
const physicalPath = p => existsSync(p) ? realpathSync(p) : path.resolve(p)
if (!requestedData || physicalPath(requestedData) === physicalPath(repoData)) {
  throw new Error('Refusing regression on repository data/. Use node scripts/regress-isolated.mjs')
}
const ONLY = process.env.ONLY || ''
const INDUSTRIES = process.env.GML_TEST_INDUSTRIES
  ? process.env.GML_TEST_INDUSTRIES.split(',').map(x => x.trim())
  : ['cosmetic', 'food', 'apparel']
if (!INDUSTRIES.length || INDUSTRIES.some(x => !['cosmetic', 'food', 'apparel'].includes(x))) {
  throw new Error('GML_TEST_INDUSTRIES must contain valid industry codes')
}

/**
 * `check:dict`（`scripts/check-inv-txn-dict.mjs`）需要一份**库副本** —— 它按纪律**拒绝对仓库 `data/` 直接跑**
 * （见该脚本文件头：只读它的 `DATA_DIR` 常量，若是 `data/` 就退 2，因为"在活库上跑判据"分不清"库有问题"与"测试写脏了"）。
 *
 * 为什么必须接进这里：这条守卫在本批之前**只被人手跑过**（证据文件里能看到 `GML_DATA_DIR=/tmp/w-disp-db npm run check:dict`），
 * 而"**判据存在 ≠ 判据被执行**"是本项目用一条真缺陷（`assertPositiveQty` 挂在"可能一次都不进"的循环里）换来的铁律 ——
 * **没人跑的守卫就是装饰**。它当天上线就捞出过真 bug（拆卸单 `DS` 与经销商对账单 `DS` 前缀撞车、`PUR_RT_REV` 未登记），
 * 这种"只在有人想起来时才发现"的形态不可接受。
 *
 * 副本在**模块初始化期**（任何 test-*.mjs 落笔之前）取，所以它反映的是**本轮起点的库状态**，
 * 与 `verify-reseed` 那种"把前面测试写出来的数据抹掉"的条目不冲突。
 * 落点默认 `os.tmpdir()`，可用 `GML_DICT_SNAPSHOT` 覆盖；**跑完即删**（不留在仓库里）。
 */
const DICT_DBS = INDUSTRIES.map(x => `gml_${x}.db`)
const DICT_SNAPSHOT = process.env.GML_DICT_SNAPSHOT || path.join(os.tmpdir(), `gml-dict-snapshot-${process.pid}`)
// ⚠️ 副本**必须取自本轮实际在跑的那批库**：设了 `GML_DATA_DIR`（隔离跑法）时全套测试读的是那个目录，
//   若快照仍从仓库 `data/` 取，就会出现"测试在 A 库跑、守卫在 B 库判"——两条判据看起来都在，
//   实际互不相关。判据与它判的对象必须同源。
const DATA_SRC = process.env.GML_DATA_DIR || path.join(ROOT, 'data')
function snapshotForDict() {
  try {
    mkdirSync(DICT_SNAPSHOT, { recursive: true })
    for (const f of DICT_DBS) {
      const src = path.join(DATA_SRC, f)
      if (existsSync(src)) copyFileSync(src, path.join(DICT_SNAPSHOT, f))
    }
  } catch (e) {
    // 备不出副本 ⇒ 下面那条 check 会以"库文件不存在"红。**这是故意的**：
    // "没能执行"必须可见，不许悄悄从清单里消失（跳过与通过同形是最危险的一种绿）。
    return `备副本失败：${e.message}`
  }
  return DICT_DBS.every((f) => existsSync(path.join(DICT_SNAPSHOT, f))) ? null : '副本不全（三库没凑齐）'
}
const dictSnapshotErr = snapshotForDict()

/** 一套测试支持哪些库：看它有没有读 `process.argv[2]`（行业参数约定） */
function industriesFor(file) {
  const src = readFileSync(file, 'utf8')
  return /process\.argv\[2\]/.test(src) ? INDUSTRIES : ['(单库)']
}

const testFiles = readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => /^test-.*\.mjs$/.test(f))
  // 安装验收需要 --package 指向全新发行包，不能作为数据库单测无参执行。
  .filter((f) => f !== 'test-local-delivery.mjs')
  // Measurement CLI requires --run/--check; node:test already covers its implementation.
  .filter((f) => f !== 'test-timings.mjs')
  .filter((f) => !ONLY || f.includes(ONLY))
  .sort()

const checks = testFiles.map((f) => ({ name: `test:${f}`, cmd: [`scripts/${f}`], industries: industriesFor(path.join(ROOT, 'scripts', f)) }))
// AH1: tests/slow/ holds the files over 60 s; the isolated regression still runs them (it is not the PR gate's critical path).
const nodeTestFiles = ['tests', 'tests/slow'].flatMap(dir => (existsSync(path.join(ROOT, dir)) ? readdirSync(path.join(ROOT, dir)) : [])
  .filter(f => f.endsWith('.test.mjs') && (!ONLY || f.includes(ONLY)))
  .sort()
  .map(f => `${dir}/${f}`))
// Explicit file arguments work without shell glob expansion and keep future suites in the gate.
if (nodeTestFiles.length) checks.unshift({
  name: 'node:test', cmd: ['--test', '--test-concurrency=1', ...nodeTestFiles], industries: ['-']
})

// 自检脚本：都自带多库循环，跑一次即可
checks.push({ name: 'verify-seed', cmd: ['scripts/verify-seed.mjs'], industries: INDUSTRIES })
// 整库重建可复现性：`reseed-all --force` 跑两次，业务值必须逐项相等。
// 放在最后 —— 它会把前面测试写出来的数据抹掉（它跑的就是重建）。
checks.push({ name: 'verify-reseed(两次重建比对)', cmd: ['scripts/verify-reseed.mjs'], industries: INDUSTRIES })
checks.push({ name: 'verify-migrations', cmd: ['scripts/verify-migrations.mjs'], industries: ['-'] })
checks.push({ name: 'check:api', cmd: ['scripts/check-api-contract.mjs'], industries: ['-'] })
// 路由遮蔽（批次 T）：字面段路由必须排在同前缀的参数路由之前。
// 它不是"风格检查"——被遮蔽的接口**存在、契约里有、前端在调，但永远 404**，
// 而 404 是个看起来正常的错（资源不存在），排查时会往数据上想。
// `/api/dms/agreements/explain` 就这样从写下那天起一直 404。
checks.push({ name: 'check:route-order', cmd: ['scripts/check-route-order.mjs'], industries: ['-'] })
// 业务码形状：`error` / `detail.code` 两个落点必须由**唯一**构造点（lib/http.js 的 bizFail）产出。
// 形状漂移不会让任何测试报错（两个读法各自都能跑通），只会让排查变慢 ——
// 所以它是一条常驻守卫，而不是一次性检查。
checks.push({ name: 'check:bizcode', cmd: ['scripts/check-bizcode-shape.mjs'], industries: ['-'] })
// 库文件路径守卫（ADR-0019）：`data/gml_*.db` / `path.join(ROOT, 'data', …)` 这类直拼路径只许出现在
// `server/db/index.js`（或带理由登记的例外）。它守的是 ADR-0001 的**旁路**：判据写在 db/index.js 里，
// 一个脚本自己拼路径就整个绕开了，而且不报错 —— `check-mcp-coverage` 曾经文件头说一套、代码读另一套。
// 纯静态、零副作用。
checks.push({ name: 'check:data-paths', cmd: ['scripts/check-data-paths.mjs'], industries: ['-'] })
// 路由授权清单（ADR-0021）：只有 requireAuth（或连登录都没有）的路由必须在例外表里带理由登记，
// 双向校验（登记了却已加闸门/已删除也红）。纯静态；`pending` 条目是真实缺口的待办清单。
checks.push({ name: 'check:route-authz', cmd: ['scripts/check-route-authz.mjs'], industries: ['-'] })
// 断言助手形参形状：各 test-*.mjs 里的 ok()/eq() 参数顺序**不统一**（4 种 ok、6 种 eq 并存），
// 于是"从别的文件抄一行 ok(...)"就会把实参对错槽位 —— 条件位收到一个非空字符串就恒真，
// **断言从此永远绿**。本项目已撞过两次（test-im-sync、test-export-excel），两次的产物都是假绿。
// 隐藏难度在于它不报错、不算失败、覆盖率还很好看，所以必须常驻，不能靠人记得跑。
checks.push({ name: 'check:test-helper-shape', cmd: ['scripts/check-test-helper-shape.mjs'], industries: ['-'] })
// 隔离闸门（批次 V + 本批扩展）：**动态 import 是一条边界；静态 import 会被提升到模块体之前。**
// 凡"自己算出 /tmp 目录、写进 GML_DATA_DIR、然后自证落在 /tmp"的脚本，只要从它出发能**一路全静态**
// 走到 `server/db/index.js`，那个自证就是**假保证** —— `db/index.js:11` 的 `DATA_DIR` 是模块加载时
// 求值的，它会在"钉 env"那行之前就算好，于是脚本安静地打开并写**仓库 data/**，还照样打绿。
// 本批实测过一次真事故（`test-kernel-migrate.mjs` 打开的就是仓库 data/），所以它必须常驻。
// **本批扩展的第二格（次序）**：动态 import 若其（静态∪动态）闭包可达 `db/index.js`，
// 则那一行必须排在"钉 env"**之后** —— 否则同样无效，而"全静态闭包"那格看不见它
// （实测形态：`await import('../server/lib/stock.js')` 写在钉 env 之前 ⇒ `stock → costing → docflow → db` 已求值完）。
// 纯静态、零副作用（不开库 / 不 spawn / 不写文件），因此可以每轮跑。
// 注：本条目与 `scripts/check-env-pinning.mjs` 是**同一份守卫**（原 `check-import-closure.mjs` 已合并删除，避免两份同判据）。
checks.push({ name: 'check:env-pinning', cmd: ['scripts/check-env-pinning.mjs'], industries: ['-'] })
// 契约 ↔ 真实路由**双向差集**：`openapi.js` 声明的路径，真实 express 路由里必须存在（反之亦然）。
// 它补的正是"路由遮蔽"与"契约检查"之间的缝：前者管注册顺序、后者管前后端与类型文件，
// **没有一条问过"契约写的这条路，后端真的有门吗"** —— 订货对账单（OCS）的 `close`/`void`
// 后端压根没有路由，契约里写的是笼统的 `{id}/{action}`，两道守卫都不报，
// 于是"点了必然 404"活到今天（`src/pages/order-center/OrderCenter.tsx:40` 早有人记下了它）。
// ⚠️ 默认只把**① 契约→真实**计入退出码（那才是"点了 404"）；**② 真实→契约**当前有 76 条
// 历史欠账（多为 crudRouter 生成的资源级 `/:id` 路由未登记），默认只打印，加 `--strict` 才计入。
checks.push({ name: 'check:contract-routes', cmd: ['scripts/check-contract-routes.mjs'], industries: ['-'] })
// 留痕↔内核边一致（痕不许说谎）：手工补的 `logEvent` 不带边校验，写错一对状态不会报错，
// 只会在时间线上留一句假话。判据是静态的（只解析源码 + 内核定义），因此不连库、不受隔离闸门影响。
// ⚠️ 双向判据：实测 ∖ 例外表 ⇒ 红；例外表 ∖ 实测 ⇒ 红（修好了没删登记行 = 橡皮图章）。
checks.push({ name: 'check:doc-events-edges', cmd: ['scripts/check-doc-events-edges.mjs'], industries: ['-'] })
// 库存流水字典闭合（`doc_type ⊆ inv_txn_types ∪ doc_types` + `txn_type` 非空 + 字典⇄文案双向差集 + 闸门成员必须有写入点）。
// 跑在**库副本**上（`GML_DATA_DIR` 指模块初始化期取的快照，见文件头）。判据本身纯读库，不写。
// ⚠️ 若快照没备出来（见 `dictSnapshotErr`），这条会红而不是消失 —— "少判一条就报"。
checks.push({ name: 'check:dict', cmd: ['scripts/check-inv-txn-dict.mjs'], industries: ['-'], env: { GML_DATA_DIR: DICT_SNAPSHOT } })
// AI 与 MCP 覆盖守卫：断言「任何单据都有 MCP」这句话在数据层面仍然成立
checks.push({ name: 'check:mcp', cmd: ['scripts/check-mcp-coverage.mjs'], industries: ['-'] })
// 文件标识守卫：客户口径「代码都要有标识，方便人工读取理解」
checks.push({ name: 'check:file-header', cmd: ['scripts/check-file-header.mjs'], industries: ['-'] })
if (dictSnapshotErr) console.log(`⚠️ check:dict 的库副本没备好（${dictSnapshotErr}）—— 该判据本轮会红，这是"没执行"的可见化，不是通过`)
checks.push({ name: 'smoke-api', cmd: ['scripts/smoke-api.mjs'], industries: ['-'] })

let fail = 0
const rows = []

// 旧 test-*.mjs 串行跑在**同一个** run-data 目录里，几十个脚本都以 admin 等账号从 127.0.0.1 登录，
// 会撞上 ADR-0005 的持久登录节流（默认 10 次失败/5 分钟/账号；成功登录自 X7 起不再计入账号桶，
// 但 IP 桶仍计全部尝试，且许多旧脚本会故意失败登录）—— 表现是后面的脚本"登录失败/401"，
// 与被测功能无关。节流策略一经写入 run-data 就固定，所以这里对**所有**旧脚本统一给足额度
// （上限 10000 是 checkedPolicy 允许的最大值）；`tests/*.test.mjs` 各自用临时目录并自带策略，不沾这份 env。
// 这是测试台的环境设置，不改变生产默认值；节流本身由 tests/login-throttle.test.mjs 与 auth-session A08 守着。
const LEGACY_LOGIN_ENV = { GML_LOGIN_IP_LIMIT: '10000', GML_LOGIN_ACCOUNT_LIMIT: '10000' }

function run(file, args, extraEnv = {}) {
  const r = spawnSync(NODE, [file, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...extraEnv }
  })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

/** 从输出里抓「通过 N / 失败 M」这句（各套测试统一的收尾格式） */
function tally(out) {
  const m = out.match(/通过\s*(\d+)\s*\/?\s*失败\s*(\d+)/)
  return m ? { pass: Number(m[1]), failed: Number(m[2]) } : null
}

for (let round = 1; round <= ROUNDS; round++) {
  console.log(`\n${'█'.repeat(64)}`)
  console.log(`█ 第 ${round} / ${ROUNDS} 轮`)
  console.log(`${'█'.repeat(64)}`)

  for (const c of checks) {
    for (const ind of c.industries) {
      const args = ind === '(单库)' || ind === '-' ? [] : [ind]
      const label = `${c.name}${args.length ? ` [${ind}]` : ''}`
      const t0 = Date.now()
      const { code, out } = run(c.cmd[0], [...c.cmd.slice(1), ...args], { ...(c.name === 'node:test' ? {} : LEGACY_LOGIN_ENV), ...(c.env || {}) })
      const ms = Date.now() - t0
      const t = tally(out)
      const good = code === 0 && !(t && t.failed > 0)
      if (!good) fail += 1
      rows.push({ round, label, code, ms, t, good })

      const detail = t ? `通过 ${t.pass} / 失败 ${t.failed}` : code === 0 ? '通过（无计数）' : `退出码 ${code}`
      console.log(`  ${good ? '✓' : '✗'} ${label.padEnd(46)} ${detail.padEnd(22)} ${(ms / 1000).toFixed(1)}s`)
      if (!good) {
        // 失败时把输出尾部打出来 —— 否则只有"✗"一行，还得翻回去重跑才能看原因
        console.log('    ── 输出尾部 ──')
        console.log(out.split('\n').slice(-25).map((l) => '    ' + l).join('\n'))
        // node --test 的失败用例名在 TAP 的 `not ok` 行，往往不在尾部 25 行里；单独列出（含紧随其后的 error/location 行）
        const lines = out.split('\n')
        const picked = []
        for (let i = 0; i < lines.length; i++) {
          // This diagnostic is built from numeric benchmark counters only (never raw server output).
          if (/^# write-bench failure /.test(lines[i])) picked.push(lines[i])
          if (/^\s*not ok /.test(lines[i])) {
            picked.push(lines[i])
            for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
              if (/^\s+(error:|location:|code:|failureType:|ENOENT|expected|actual)/.test(lines[j])) picked.push(lines[j])
            }
          }
        }
        if (picked.length) {
          console.log('    ── not ok 用例 ──')
          console.log(picked.slice(0, 60).map((l) => '    ' + l).join('\n'))
        }
      }
    }
  }

  // 契约与构建：前端改动后必须过（类型错会一路带到运行期，只在某个页面炸）
  for (const [label, args] of [['tsc --noEmit', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']]]) {
    const t0 = Date.now()
    const { code, out } = run(args[0], args.slice(1))
    const good = code === 0
    if (!good) fail += 1
    rows.push({ round, label, code, ms: Date.now() - t0, t: null, good })
    console.log(`  ${good ? '✓' : '✗'} ${label.padEnd(46)} ${(good ? '通过' : `退出码 ${code}`).padEnd(22)} ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    if (!good) console.log(out.split('\n').slice(0, 15).map((l) => '    ' + l).join('\n'))
  }
  const t0 = Date.now()
  const { code: bcode } = run('node_modules/vite/bin/vite.js', ['build', '--logLevel', 'warn'])
  const bgood = bcode === 0
  if (!bgood) fail += 1
  rows.push({ round, label: 'vite build', code: bcode, ms: Date.now() - t0, t: null, good: bgood })
  console.log(`  ${bgood ? '✓' : '✗'} ${'vite build'.padEnd(46)} ${(bgood ? '通过' : `退出码 ${bcode}`).padEnd(22)} ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

console.log(`\n${'─'.repeat(70)}`)
// check:dict 的库快照用完即删（它是 /tmp 下的临时物，不该留在机器上）
try {
  rmSync(DICT_SNAPSHOT, { recursive: true, force: true })
} catch {
  /* 删不掉不影响结论 —— 落点在 tmpdir */
}
const byRound = new Map()
for (const r of rows) {
  const cur = byRound.get(r.round) || { ok: 0, bad: 0 }
  r.good ? cur.ok++ : cur.bad++
  byRound.set(r.round, cur)
}
for (const [round, v] of byRound) {
  console.log(`  第 ${round} 轮：${v.ok} 项通过 / ${v.bad} 项失败`)
}
const assertionPass = rows.reduce((s, r) => s + (r.t?.pass || 0), 0)
console.log(`  断言累计通过 ${assertionPass} 条；跑批项 ${rows.length} 个`)
if (fail) {
  console.log(`\n\x1b[31m回归失败：${fail} 项\x1b[0m`)
  console.log('  明细：' + rows.filter((r) => !r.good).map((r) => `第${r.round}轮 ${r.label}`).join('；'))
} else {
  console.log(`\n\x1b[32m全量回归通过（${ROUNDS} 轮 × 串行）\x1b[0m`)
}
process.exit(fail ? 1 : 0)
