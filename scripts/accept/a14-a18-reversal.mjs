#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/accept/a14-a18-reversal.mjs ｜ 独立验收：注入式「先红后证」—— 证明 S13（A14 / A15 / A17b / A18）**真的验到了那些闸门**。
 * ============================================================================
 * 【职责】独立验收：注入式「先红后证」—— 证明 S13（A14 / A15 / A17b / A18）**真的验到了那些闸门**。
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
 * 注入式「先红后证」—— 证明 S13（A14 / A15 / A17b / A18）**真的验到了那些闸门**。
 *
 * 为什么需要它：
 *   S13 的那些断言现在都是绿的。但"绿"有两个互不相干的来源 ——
 *     ① 闸门在，且被触发；② 闸门不在，而那条路径**恰好没走到**。
 *   正向通过区分不了这两者。唯一能区分的手段是**主动把闸门拆坏**：
 *   拆掉之后如果断言**没变红**，说明这一节根本没验到那道闸门（铁律 22）。
 *
 * 硬约束：**绝不动工作区**。
 *   全部 patch / 跑测 / 还原都发生在 `/tmp` 下的**隔离副本**里（复刻 `run-on-copy.mjs`
 *   的复制方式：只复制源码与配置，排除 data/ .env .git node_modules，node_modules 用只读软链）。
 *   收工时再用 sha256 逐字节核对源文件，证明工作区一个字节都没变。
 *
 * 铁律 21：「崩」与「可读的红」必须分开计数。
 *   注入后进程非 0 退出、但一条 `✗` 都没有（或报错在无关位置）= `red_crashed`，
 *   不算"变红"，单独统计。
 *
 * 覆盖面：
 *   S13（A14 / A15 / A17b / A18）+ S14–S17（A19 / A12 / A06 / A08 / A07 / A10 / A11 / A13）。
 *   文件名保留 `a14-a18` 是历史原因：`scripts/accept/selfcheck.mjs` 的注释里引用了这个路径，
 *   改名要动别人的文件 —— 不值当。组 id 与覆盖范围以本文件的 INJECTIONS 为准。
 *
 * 跑什么：默认 `scripts/accept/selfcheck.mjs`（建全新三库）。
 *   断言落在别处时，用 `runner: 'test-guards'` 改跑 `scripts/test-guards.mjs <industry>`
 *   （P 组就是这种：A12b"多行 global 读最新"那条在 test-guards 的 G12，不在 selfcheck）。
 *   test-guards 组会把 `data/` **快照**复制进副本（它对着开发库跑），工作区的 .db 依旧不碰。
 *
 * 用法：
 *   node scripts/accept/a14-a18-reversal.mjs               # 全部 17 组
 *   node scripts/accept/a14-a18-reversal.mjs --only=A,C    # 只跑指定组（分批用）
 *   node scripts/accept/a14-a18-reversal.mjs --jobs=3      # 并行度（每组独占一份副本）
 *   node scripts/accept/a14-a18-reversal.mjs --keep        # 保留 /tmp 副本便于复查
 *
 * 退出码：全组通过 0，否则 1。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, symlinkSync, existsSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ---------------------------------------------------------------------------
// 参数（口径「丁」）：**不认识的参数一律拒绝** —— 打用法 + 非 0 退出，绝不静默忽略。
// 静默接受一个无意义的动作，与本批缺陷 186（`qty:-5` 静默成功）是同一族：
// 用户以为自己在"只验锚点、不跑"，实际得到的是"整套跑了一遍"。
// ⚠️ 本文件只加**这个参数闸门 + 收工自证输出行**，**不动收尾那份 JSON 的字段结构**
//    （`docs/evidence/独立验收_注入先红后证_ABCDEFGHIJKK2LMNOP_20261016.json` 正被它用着）。
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
const USAGE = '用法: node scripts/accept/a14-a18-reversal.mjs [--dry] [--only=A,B] [--jobs=N] [--keep]\n' +
  '  --dry         只解析锚点（不跑套件）\n' +
  '  --only=A,K2   只跑指定组（大小写不敏感）\n' +
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

// 端口基址按 pid 打散：别的 worker 可能同时在跑 selfcheck（默认 42351），
// 撞端口报出来的错与真实原因毫无关系。
// 步长 40、单次最多 17 组（i*2 ⇒ 最多 +32，仍 < 40）—— 保证两个并发实例的端口段**不重叠**。
const PORT_BASE = 42600 + (process.pid % 40) * 40
// test-guards 自己起服务（端口写死 3196），另开一段端口避免与 selfcheck 的段重叠
const TG_PORT_BASE = 44200 + (process.pid % 40) * 3

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// ---------------------------------------------------------------------------
// 17 组注入（S13 的 7 组 + S14–S17 的 9 组，外加 K2：K 切 lib 层会连种子一起崩、
// 记 red_crashed，故另切一刀 HTTP 边界来证明 A08 那条断言"有牙"）。`from` 必须在文件里**唯一命中**；
// 命中 0 次或 >1 次一律报"锚点未命中"，绝不静默跳过（宁可空手，也不许假装验过）。
// `--dry` 可以只做锚点解析、不跑 selfcheck —— 跑一轮要十几分钟，先验锚点能省一大截。
// ---------------------------------------------------------------------------
const INJECTIONS = [
  {
    id: 'A',
    title: 'A14 送分口径（强制每元 1 分）',
    file: 'server/lib/member.js',
    from: "export const pointsPerYuan = (db) => readSetting(db, 'promo_points_per_yuan')",
    to: 'export const pointsPerYuan = (db) => 1 // INJECT-A：旧口径，1 元 1 分',
    expect: ['A14 送分口径不是', 'A14 送分与']
  },
  {
    id: 'B',
    title: 'A15 撤单退回抵扣积分',
    file: 'server/lib/member.js',
    from: '    if (redeemed > 0) {',
    to: '    if (false && redeemed > 0) { // INJECT-B：跳过"退回 redeem"那一段',
    expect: ['A15 撤单后积分回到期初']
  },
  {
    id: 'C',
    title: 'A17b 改草稿时数量必须为正',
    file: 'server/routes/sales.js',
    from: '        const q = numQty(it.qty, `${at}销售数量`)',
    to: '        const q = numQty(it.qty, `${at}销售数量`, { positive: false }) // INJECT-C：去掉数量下界',
    expect: ['A17b 改草稿数量为 0 被拒']
  },
  {
    id: 'D',
    title: 'A17b MCP 未知字段校验',
    file: 'server/mcp/validate.js',
    from: '  if (unknown.length) {',
    to: '  if (false && unknown.length) { // INJECT-D：未知字段静默放行',
    expect: ['A17b MCP 传未知字段被拒', 'A17b 拒绝码来自参数校验 ARG_UNKNOWN']
  },
  {
    id: 'E',
    title: 'A17b MCP 数量下界（负出库）',
    file: 'server/mcp/tools.js',
    from: "        qty: { ...S.num('出库数量', { exclusiveMinimum: 0 }), description: '出库数量（必填，正数）' },",
    to: "        qty: { ...S.num('出库数量'), description: '出库数量（必填，正数）' }, // INJECT-E：去掉 exclusiveMinimum",
    expect: ['A17b MCP 负出库被拒', 'A17b 拒绝理由说清是数量非法']
  },
  {
    id: 'F',
    title: 'A18 核销的供应商一致校验',
    file: 'server/lib/purchase.js',
    from: '    if (Number(st.supplier_id) !== Number(supplierId)) {',
    to: '    if (false && Number(st.supplier_id) !== Number(supplierId)) { // INJECT-F：短路供应商一致校验',
    expect: ['PAY_ALLOC_SUPPLIER_MISMATCH', 'A18 跨供应商核销']
  },
  {
    id: 'G',
    title: 'A18 生效时重验余额',
    file: 'server/lib/purchase.js',
    from: '  if (!items.length) return\n  assertPaymentAllocations(db, { supplierId, allocations: items, selfPaymentId: paymentId })',
    to: '  if (!items.length) return\n  if (true) return // INJECT-G：生效时不重验余额\n  assertPaymentAllocations(db, { supplierId, allocations: items, selfPaymentId: paymentId })',
    expect: ['A18 第二张生效被拒']
  },

  // ===== S14–S17（A19 / A12 / A06 / A08 / A07 / A10 / A11 / A13）=====
  {
    id: 'H',
    title: 'A19 approval.approve 改回裸 UPDATE（绕开领域服务）',
    file: 'server/mcp/tools.js',
    from: '      const out = decideApproval(db, {\n        instanceId: inst.id,\n        decision: \'approve\',\n        comment: args.comment || null,\n        actor\n      })',
    to: '      // INJECT-H：改回裸 UPDATE —— 绕开状态机（不写 approval_records、不进级、不执行业务流转）\n      db.prepare("UPDATE approval_instances SET status=\'approved\', decided_at=datetime(\'now\',\'localtime\') WHERE id=?").run(inst.id)\n      const out = { instance: { ...inst, status: \'approved\' }, step: 1, done: true, nextStep: null, applied: null }',
    expect: ['A19 approval.approve 改调领域服务', 'A19/D5c approval.approve 未经人工确认不得执行']
  },
  {
    id: 'I',
    title: 'A12 库存参数缓存退回模块级 Map（不按 db 分区）',
    file: 'server/lib/stock.js',
    from: "let paramCache = new WeakMap()\n\nfunction cacheOf(db) {\n  let m = paramCache.get(db)\n  if (!m) {\n    m = new Map()\n    paramCache.set(db, m)\n  }\n  return m\n}",
    to: "// INJECT-I：退回 A12 之前的口径 —— 模块级普通 Map，key 不含 db/行业\nlet paramCache = new Map()\nconst GLOBAL_PARAM_KEY = '__global__'\n\nfunction cacheOf(_db) {\n  let m = paramCache.get(GLOBAL_PARAM_KEY)\n  if (!m) {\n    m = new Map()\n    paramCache.set(GLOBAL_PARAM_KEY, m)\n  }\n  return m\n}",
    expect: ['A12 库存参数缓存按 db 分区', 'A12 没有退回']
  },
  {
    id: 'J',
    title: 'A06 收款释放授信退回按 RCP+收款单号（恒 0 条流水）',
    file: 'server/lib/ar.js',
    from: '          if (ar?.source_type && ar.source_id) {',
    to: '          if (false && ar?.source_type && ar.source_id) { // INJECT-J：退回按 RCP 释放',
    expect: ['A06 收款核销后可用额度回到占用前', 'A06 台账里占用与释放都挂在同一个']
  },
  {
    id: 'K',
    title: 'A08 核销退回 FIFO 分摊（丢掉显式指定的那条）—— lib 层',
    file: 'server/lib/ar.js',
    from: '    if (Array.isArray(allocations)) {',
    to: '    if (false && Array.isArray(allocations)) { // INJECT-K：丢掉 explicit allocations，退回 FIFO',
    expect: ['A08 核销只落在', 'A08 另一张'],
    note: 'K：这一刀切在 lib 层 `createReceipt`，而**运行时与建库种子两个用户共用它** —— `server/db/ar-seed.js:183` → `applyPrepay` → `ar.js:978` 会抛 `PREPAY_EMPTY`，于是 selfcheck 在种子阶段就崩、一条 ✗ 都产生不出来。故记 `red_crashed`（不计入通过），并**保留这条记录**：它说明 lib 层那道闸门有两个承重用户，拆它会同时打到两边。A08 那条断言"有没有牙"由 K2（只拆 HTTP 边界）证明。'
  },
  {
    id: 'K2',
    title: 'A08 核销退回 FIFO —— HTTP 边界（种子不受影响）',
    file: 'server/routes/ar.js',
    from: '    allocations: b.allocations || null,',
    to: '    allocations: null, // INJECT-K2：路由层丢掉显式核销，退回 FIFO',
    expect: ['A08 核销只落在', 'A08 另一张']
  },
  {
    id: 'L',
    title: 'A07 核销额超实收的校验短路',
    file: 'server/lib/ar.js',
    from: '        if (want > left + 0.005) {',
    to: '        if (false && want > left + 0.005) { // INJECT-L：不再拒绝超实收核销',
    expect: ['RC_ALLOC_EXCEEDS_RECEIPT', 'A07 被拒后一张收款单都没落库']
  },
  {
    id: 'M',
    title: 'A10 红冲不区分 linked/created，一律作废整张应收',
    file: 'server/lib/invoice.js',
    from: '    for (const l of links) {\n      if (l.relation === \'linked\') continue\n      const ar = db.prepare(\'SELECT * FROM ar_documents WHERE id=?\').get(l.ar_id)\n      if (ar && ar.status !== \'voided\' && ar.status !== \'closed\') {',
    to: '    for (const l of links) {\n      // INJECT-M：不区分 linked / created，共享的订单级应收也一并作废\n      const ar = db.prepare(\'SELECT * FROM ar_documents WHERE id=?\').get(l.ar_id)\n      if (ar && ar.status !== \'voided\' && ar.status !== \'closed\') {',
    expect: ['A10 共享的订单级应收']
  },
  {
    id: 'N',
    title: 'A11 跨批次成本误用末批单价',
    file: 'server/lib/stock.js',
    from: '      const qtySum = parts.reduce((n, r) => n + Number(r.qty || 0), 0)\n      const amtSum = parts.reduce((n, r) => n + Number(r.outAmount || 0), 0)\n      return {\n        ...last,\n        qty: round4(qtySum),\n        outAmount: round2(amtSum),\n        // 加权平均单价：既是"这次出库的真实单价"，也让 `qty × unitCost` 恰好等于总额\n        unitCost: qtySum > 0 ? round4(amtSum / qtySum) : last.unitCost,',
    to: '      const qtySum = parts.reduce((n, r) => n + Number(r.qty || 0), 0)\n      const amtSum = qtySum * Number(last.unitCost || 0) // INJECT-N：误用末批单价\n      return {\n        ...last,\n        qty: round4(qtySum),\n        outAmount: round2(amtSum),\n        unitCost: last.unitCost,',
    expect: ['A11 行成本 = 各批次金额之和', 'A11 行金额与逐批流水之和一致']
  },
  {
    id: 'O',
    title: 'A13 把 MR 移出"只许可售货"的集合',
    file: 'server/lib/stock.js',
    from: "const SALEABLE_ONLY_OUT = new Set(['SAL_OUT', 'SHP_OUT', 'MR', 'WWS_OUT'])",
    to: "const SALEABLE_ONLY_OUT = new Set(['SAL_OUT', 'SHP_OUT', 'WWS_OUT']) // INJECT-O：MR 被移出 ⇒ 生产领料可指名不可售批次",
    expect: ['BATCH_NOT_SELLABLE', 'A13 显式指定不合格批次出库']
  },
  {
    id: 'P',
    title: 'getInvParam 的 global 分支去掉 ORDER BY id DESC（取最新一行）',
    file: 'server/lib/stock.js',
    from: '      .prepare("SELECT param_value FROM inv_params WHERE param_key=? AND scope=\'global\' ORDER BY id DESC LIMIT 1")',
    to: '      .prepare("SELECT param_value FROM inv_params WHERE param_key=? AND scope=\'global\' LIMIT 1") // INJECT-P：不再取最新一行',
    expect: ['A12b：同一 global 键多行时读到'],
    runner: 'test-guards',
    note: 'P：闸门由 **`test-guards` G12 的 A12b** 守（**不在 selfcheck**）。用 selfcheck 量它全绿是**量错了尺子**；用 `test-guards` 量：注入后**红 1 条**（红的正是 A12b），还原后 **0 失败**。刻意不写当时的套件总数（`370/1`、`371/0` 那类）—— 总数每批都在变（HTTP 信用形状那 7 条加上来之后就不是那个数了），写死就会过期，而这正是本批在修的毛病。'
  }
]

// ---------------------------------------------------------------------------
// `--dry`：只解析锚点，不跑 selfcheck
// ---------------------------------------------------------------------------
if (DRY) {
  let miss = 0
  for (const inj of INJECTIONS) {
    const p = path.join(ROOT, inj.file)
    if (!existsSync(p)) { console.log(`[${inj.id}] ✗ 文件不存在 ${inj.file}`); miss++; continue }
    const src = readFileSync(p, 'utf8')
    const n = src.split(inj.from).length - 1
    const first = n === 1 ? src.slice(0, src.indexOf(inj.from)).split('\n').length : null
    if (n !== 1) miss++
    console.log(`[${inj.id}] ${n === 1 ? `✓ 锚点唯一命中 ${inj.file}:${first}` : `✗ 命中 ${n} 次（必须 1 次）`}  ${inj.title}`)
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

function makeCopy(tag, { withData = false } = {}) {
  const TMP = mkdtempSync(path.join(tmpdir(), `gml-rev-${tag}-`))
  const REPO = path.join(TMP, 'repo')
  mkdirSync(REPO, { recursive: true })
  for (const d of COPY_DIRS) if (existsSync(path.join(ROOT, d))) cpSync(path.join(ROOT, d), path.join(REPO, d), { recursive: true })
  for (const f of COPY_FILES) if (existsSync(path.join(ROOT, f))) copyFileSync(path.join(ROOT, f), path.join(REPO, f))
  // data/ .env .git 默认一个都不复制；node_modules 只读软链复用。
  // 例外：跑 test-guards 的组必须带上 data/ —— 它是对着**开发库**做回归的
  // （`ROOT/data/gml_<industry>.db`）。复制一份快照进副本，工作区的 .db 依旧一个字节不碰。
  if (withData && existsSync(path.join(ROOT, 'data'))) cpSync(path.join(ROOT, 'data'), path.join(REPO, 'data'), { recursive: true })
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(REPO, 'node_modules'), 'dir')
  CREATED.push(TMP)
  return { TMP, REPO }
}

function runSelfcheck(REPO, port) {
  // 先清掉可能残留的证据目录，避免读到上一轮的 JSON（陈旧数据 = 假红/假绿）
  rmSync(path.join(REPO, 'docs/evidence'), { recursive: true, force: true })
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/accept/selfcheck.mjs')], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      ACCEPT_PORT: String(port),
      GML_ACCEPT_SHA: 'inject-reversal',
      GML_ACCEPT_DIRTY: 'isolated-copy(patched)'
    }
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/**
 * 跑 test-guards（cosmetic）—— 给"断言落在 test-guards 而不是 selfcheck 里"的组用。
 * 两处副本内改造（都不碰被测闸门本身）：
 *   ① test-guards 的端口在文件里**写死 3196**，并发跑会撞 → 副本里换成本次专属端口；
 *   ② 它是对着 `ROOT/data/gml_cosmetic.db` 跑的，所以副本必须带 data/ 快照（由 makeCopy 负责）。
 */
function runTestGuards(REPO, port) {
  const tg = path.join(REPO, 'scripts/test-guards.mjs')
  const src = readFileSync(tg, 'utf8')
  if (/const PORT = \d+/.test(src)) writeFileSync(tg, src.replace(/const PORT = \d+/, `const PORT = ${port}`))
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/test-guards.mjs'), 'cosmetic'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env }
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/** 去掉 ANSI 颜色（test-guards 用 `\x1b[31m✗\x1b[0m` 输出） */
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')

/** 优先从证据 JSON 读失败名单（结构化、无解析歧义）；拿不到再退化为解析 stdout。 */
function readFailures(REPO, stdout) {
  const dir = path.join(REPO, 'docs/evidence')
  if (existsSync(dir)) {
    const f = readdirSync(dir).filter((n) => n.startsWith('独立验收_必打反例_') && n.endsWith('.json')).sort().pop()
    if (f) {
      try {
        const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
        if (Array.isArray(j.results)) return j.results.filter((x) => !x.pass).map((x) => x.name)
      } catch {}
    }
  }
  // 退化路径：解析 `  ✗ <断言名>`，但要排掉收尾的分组汇总行（形如 `  ✗ S13 … 12/20`）
  return stripAnsi(String(stdout || ''))
    .split('\n')
    .filter((l) => /^ {2}✗ /.test(l) && !/\d+\/\d+\s*$/.test(l))
    .map((l) => l.replace(/^ {2}✗ /, '').split('  → ')[0].trim())
}

// ---------------------------------------------------------------------------
// 单组流程：patch（副本）→ 跑 → 断言命中 → 还原 → 再跑 → 断言回绿
// ---------------------------------------------------------------------------
function processInjection(inj, index) {
  const tag = `${inj.id}-${Date.now().toString(36)}`
  const isTG = inj.runner === 'test-guards'
  const port = isTG ? TG_PORT_BASE + index : PORT_BASE + index * 2
  const rec = { id: inj.id, title: inj.title, file: inj.file, runner: isTG ? 'test-guards' : 'selfcheck', anchor: null, status: 'unknown', failures: [], hit: [], greenFailures: null, crashed: false, note: inj.note || '' }
  let copy = null
  const pre = rec.note
  const append = (s) => { rec.note = pre ? `${pre} ｜ ${s}` : s }
  const runOne = (repo) => (isTG ? runTestGuards(repo, port) : runSelfcheck(repo, port))
  try {
    copy = makeCopy(tag, { withData: isTG })
    const target = path.join(copy.REPO, inj.file)
    if (!existsSync(target)) { rec.status = 'anchor_miss'; append(`文件不存在：${inj.file}`); return rec }

    const original = readFileSync(target, 'utf8')
    const occurrences = original.split(inj.from).length - 1
    if (occurrences !== 1) {
      rec.status = 'anchor_miss'
      append(`锚点在 ${inj.file} 命中 ${occurrences} 次（必须恰好 1 次）`)
      return rec
    }
    const lineNo = original.slice(0, original.indexOf(inj.from)).split('\n').length
    rec.anchor = { file: inj.file, line: lineNo }

    // ① 注入
    writeFileSync(target, original.replace(inj.from, inj.to))

    // ② 跑：必须变红（且可读）
    const red = runOne(copy.REPO)
    const failures = readFailures(copy.REPO, red.stdout)
    rec.failures = failures
    if (failures.length === 0) {
      // 没有可读的 ✗。**先把文件还原、再跑一次**，用这一次的结果区分两种完全不同的成因：
      //   · 还原后全绿  ⇒ 崩是**这次注入**造成的（但按铁律 21，崩仍不算"可读的红"）；
      //   · 还原后还崩  ⇒ 与注入无关，是**环境/竞态**（端口、并发、资源）—— 别让下一个人
      //                   把它误读成"验收台坏了"或"这条断言没牙"。
      rec.crashed = red.status !== 0
      writeFileSync(target, original)
      const greenAfterCrash = runOne(copy.REPO)
      const gfc = readFailures(copy.REPO, greenAfterCrash.stdout)
      rec.greenFailures = gfc.length
      if (gfc.length === 0 && greenAfterCrash.status === 0) {
        rec.status = rec.crashed ? 'red_crashed' : 'no_red'
        append(rec.crashed
          ? `注入后进程退出码 ${red.status} 且**没有可读的 ✗**；还原后同一套件全绿 ⇒ 崩溃**由这次注入引起**（不是环境问题），但仍不计为"变红"（铁律 21）。stderr 尾部：${(red.stderr || '').split('\n').slice(-3).join(' | ').slice(0, 160)}`
          : '注入后失败数为 0 —— **在本次跑的这个套件里**没有任何断言守住它（注意：这只说明"这把尺子量不到"，不等于"没有断言在守"）')
      } else {
        rec.status = 'env_failure'
        append(`⚠️ **环境/竞态类失败，非断言失败**：注入后无 ✗，且**还原后同样失败**（失败 ${gfc.length} 条 / 退出码 ${greenAfterCrash.status}）⇒ 与本次注入无关，**不要**当成"验收台坏了"。stderr 尾部：${(red.stderr || '').split('\n').slice(-3).join(' | ').slice(0, 160)}`)
      }
      return rec
    }
    rec.hit = inj.expect.filter((sub) => failures.some((n) => n.includes(sub)))

    // ③ 还原
    writeFileSync(target, original)
    if (readFileSync(target, 'utf8') !== original) { rec.status = 'restore_failed'; append('还原后与原文不一致'); return rec }

    // ④ 再跑：必须回绿
    const green = runOne(copy.REPO)
    const gf = readFailures(copy.REPO, green.stdout)
    rec.greenFailures = gf.length
    if (gf.length !== 0) {
      rec.status = 'not_green'
      append(`还原后仍有 ${gf.length} 条失败：${gf.slice(0, 3).join(' / ')}`)
      return rec
    }
    rec.status = rec.hit.length > 0 ? 'pass' : 'red_but_unexpected'
    if (rec.hit.length === 0) append(`变红了，但没有一条是期望的断言：期望 ${inj.expect.join(' | ')}；实际 ${failures.slice(0, 4).join(' / ')}`)
    return rec
  } finally {
    if (copy && !KEEP) { try { rmSync(copy.TMP, { recursive: true, force: true }) } catch {} }
    if (copy && KEEP) console.log(`  [${inj.id}] 副本保留：${copy.REPO}`)
  }}

// ---------------------------------------------------------------------------
// 主流程（带并行度）
// ---------------------------------------------------------------------------
const queue = INJECTIONS.map((inj, i) => ({ inj, i })).filter(({ inj }) => !ONLY || ONLY.has(inj.id))
const skipped = INJECTIONS.filter((inj) => ONLY && !ONLY.has(inj.id)).map((inj) => inj.id)

// `--only` 写错一个组号 ⇒ 命中 0 组 ⇒ 而"0 组全绿"与"全部通过"**同形**（都是 失败 0）。
// 所以命中 0 组时**响亮失败**，不假装验过。（与同族另两份脚本同一口径；原来本文件缺这道兜底。）
if (queue.length === 0) {
  console.log(`\n❌ --only 没匹配到任何组（给的：${[...(ONLY || [])].join(',')}；本脚本的组：${INJECTIONS.map((i) => i.id).join(',')}）`)
  console.log('\n计数 通过 0 / 失败 1')
  process.exit(1)
}

console.log(`注入式「先红后证」：S13（A14/A15/A17b/A18）+ S14–S17（A19/A12/A06/A08/A07/A10/A11/A13）\n  源 ${ROOT}\n  组数 ${queue.length}${skipped.length ? `（--only 过滤掉：${skipped.join(',')}）` : ''}｜并行度 ${JOBS}｜端口基址 ${PORT_BASE}`)

// 工作区基线：逐字节核对用
const baseline = new Map()
for (const inj of INJECTIONS) {
  const p = path.join(ROOT, inj.file)
  if (!baseline.has(inj.file) && existsSync(p)) baseline.set(inj.file, sha256(p))
}
const gitBefore = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout || ''

const results = new Array(queue.length)
let cursor = 0
async function worker() {
  while (true) {
    const slot = cursor++
    if (slot >= queue.length) return
    const { inj, i } = queue[slot]
    const rec = processInjection(inj, i)
    results[slot] = rec
    const red = rec.status === 'red_crashed' ? '崩（不可读）'
      : rec.failures.length ? `失败 ${rec.failures.length} 条` : '未变红'
    console.log(`[${inj.id}] 注入 ${inj.title}（runner=${rec.runner}） → ${red} / 期望命中的断言：${rec.hit.length ? '命中(' + rec.hit.join(',') + ')' : '未命中'} / 还原后失败 ${rec.greenFailures === null ? '未跑' : rec.greenFailures} 条${rec.note ? `  ⚠️ ${rec.note}` : ''}`)
    if (rec.failures.length) {
      for (const f of rec.failures.slice(0, 6)) console.log(`      ✗ ${f}`)
      if (rec.failures.length > 6) console.log(`      …还有 ${rec.failures.length - 6} 条`)
    }
  }
}
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, () => worker()))

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.status === 'pass').length
const failedG = results.length - passed
console.log(`\n${'─'.repeat(96)}`)
console.log('组 | 注入点 | 变红 | 命中期望 | 还原回绿 | 结论')
console.log(`${'─'.repeat(96)}`)
for (const r of results) {
  const anchor = r.anchor ? `${r.anchor.file}:${r.anchor.line}` : '—'
  const verdict = { pass: '✅ 通过', red_crashed: '❌ 崩（不可读的红）', no_red: '❌ 未变红', red_but_unexpected: '❌ 红错地方', anchor_miss: '❌ 锚点未命中', not_green: '❌ 还原未回绿', restore_failed: '❌ 还原失败', env_failure: '⚠️ 环境/竞态类失败（非断言失败）' }[r.status] || `❌ ${r.status}`
  console.log(`${r.id}${r.runner !== "selfcheck" ? "[" + r.runner + "]" : ""} | ${anchor} | ${r.failures.length} 条 | ${r.hit.length ? r.hit.join(',') : '—'} | ${r.greenFailures === null ? '—' : r.greenFailures === 0 ? '是' : '否'} | ${verdict}`)
}
console.log(`${'─'.repeat(96)}`)
console.log(`通过 ${passed} / 失败 ${failedG}（共 ${results.length} 组）`)
const crashed = results.filter((r) => r.status === 'red_crashed')
console.log(`  其中「注入后崩、没有可读的红」${crashed.length} 组：${crashed.map((r) => r.id).join(',') || '无'}  ← 铁律 21：崩不算变红（还原后同一套件全绿 ⇒ 崩由注入引起）`)
const envFail = results.filter((r) => r.status === 'env_failure')
console.log(`  「环境/竞态类失败，非断言失败」${envFail.length} 组：${envFail.map((r) => r.id).join(',') || '无'}  ← 还原后照样失败，与注入无关，别当成验收台坏了`)
const noRed = results.filter((r) => r.status === 'no_red')
console.log(`  「注入后压根没变红」${noRed.length} 组：${noRed.map((r) => r.id).join(',') || '无'}  ← 只说"本次这把尺子量不到"，不等于"没有断言在守"`)
const misses = results.filter((r) => r.status === 'anchor_miss')
console.log(`  「锚点未命中」${misses.length} 组：${misses.map((r) => `${r.id}(${r.note})`).join(', ') || '无'}`)

// ---------------------------------------------------------------------------
// 工作区自证：目标文件逐字节未变
// ---------------------------------------------------------------------------
console.log(`\n工作区自证（脚本只写 /tmp 副本）：`)
// ① 本次创建的临时副本**逐份核对**还在不在（不是笼统宣称"清理过了" —— 铁律 11）
const stillThere = KEEP ? [] : CREATED.filter((p) => existsSync(p))
console.log(`  ${stillThere.length === 0 ? '✓' : '✗'} 本次创建的 ${CREATED.length} 份临时副本，收工时仍存在 ${stillThere.length} 份${stillThere.length ? `：${stillThere.join(' / ')}` : ''}`)
if (KEEP && CREATED.length) console.log(`  （--keep：本次保留 ${CREATED.length} 份，路径见上面逐组输出）`)
// ② 被监视的源文件逐字节未变（sha256 前后一致）
for (const [file, hash] of baseline) {
  const now = existsSync(path.join(ROOT, file)) ? sha256(path.join(ROOT, file)) : '(缺失)'
  console.log(`  ${now === hash ? '✓ 未变' : '✗ 已变'} ${file}`)
}
// ③ git status 前后比对（行数也要写出来 —— 只写"一致"看不出量级）
const gitAfter = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout || ''
const gitSame = gitBefore === gitAfter
console.log(`  ${gitSame ? '✓' : '⚠️'} git status --porcelain 与开跑前一致（开跑前 ${gitBefore.split('\n').filter(Boolean).length} 行 / 收工 ${gitAfter.split('\n').filter(Boolean).length} 行）`)
if (!gitSame) {
  const a = new Set(gitBefore.split('\n').filter(Boolean)); const b = new Set(gitAfter.split('\n').filter(Boolean))
  const added = [...b].filter((x) => !a.has(x)); const removed = [...a].filter((x) => !b.has(x))
  // 本脚本唯一的仓库内产物是这份证据 JSON（与 run-on-copy 落证据同一约定）；它不在 SOURCE 之列
  const mine = added.filter((x) => x.includes('独立验收_注入先红后证_'))
  const addedReal = added.filter((x) => !mine.includes(x))
  console.log(`    新增：${addedReal.join(' | ') || '无'}`)
  console.log(`    本脚本产物（非源码）：${mine.join(' | ') || '无'}`)
  console.log(`    消失：${removed.join(' | ') || '无'}`)
  console.log('    （注：工作区同时有别的 worker 在改文件，差异未必来自本脚本；本脚本对源码只写 /tmp 副本）')
}

// 证据落盘（真仓库，供复核；这不是"源码"，不影响被测对象）
// 文件名带上**本次实际跑的组**，这样分批跑不会互相覆盖。
const evDir = path.join(ROOT, 'docs/evidence')
mkdirSync(evDir, { recursive: true })
const groupTag = results.map((r) => r.id).join('')
const evPath = path.join(evDir, `独立验收_注入先红后证_${groupTag}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`)
writeFileSync(evPath, JSON.stringify({
  kind: 'injection-reversal-selfcheck',
  at: new Date().toISOString(),
  source_root: ROOT,
  groups_run: results.map((r) => r.id),
  isolation: 'each injection patched a /tmp isolated copy; workspace untouched (sha256 verified)',
  summary: { total: results.length, passed, failed: failedG, red_crashed: crashed.length, env_failure: envFail.length, no_red: noRed.length, anchor_miss: misses.length },
  injections: INJECTIONS.map((x) => ({ id: x.id, title: x.title, file: x.file, expect: x.expect })),
  results
}, null, 2))
console.log(`\n证据：${evPath}`)
process.exit(failedG ? 1 : 0)
