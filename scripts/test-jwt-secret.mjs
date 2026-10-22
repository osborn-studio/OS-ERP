#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/test-jwt-secret.mjs ｜ 测试：JWT 密钥来源的「姿态」守卫（A20 残余）。
 * ============================================================================
 * 【职责】测试：JWT 密钥来源的「姿态」守卫（A20 残余）。
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
 * JWT 密钥来源的「姿态」守卫（A20 残余）。
 *
 * 这条缺陷有两层，第一层已经修了（两个名字都认 + compose 改名统一），
 * 本脚本守的是**第二层**：**"读不到就回退"必须是响亮的**。
 *
 * 第一层（已修，本脚本顺手守住不让人改回去）：
 *   `GML_JWT_SECRET` 优先，**兼容旧名字 `JWT_SECRET`**。
 *   没有这条，compose 配的名字与代码读的名字对不上时，服务会**静默**用回退密钥。
 *
 * 第二层（本脚本的主要对象）：
 *   · 两个都没设 + `NODE_ENV=production` ⇒ 密钥姿态 `fatal`，**启动被拒**（带 code 抛错）；
 *   · 两个都没设 + 非生产 ⇒ `warn` + 启动时一条响亮警告（回退**允许**，但不许悄悄进行）；
 *   · 设了任一名字 ⇒ `ok`，回退路径根本不发生。
 *
 * 为什么必须把判定做成**纯函数**：如果只在模块加载期算一个常量，那"同一进程内测多种环境组合"
 * 就是不可能的 —— ESM 模块缓存会让你改完 `process.env` 再 import 也拿到旧值（很经典的假绿）。
 * 所以：纯函数负责判定（同进程可测任意组合），**真·模块常量与真·启动入口用子进程测**。
 *
 * 用法：node scripts/test-jwt-secret.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import jwt from 'jsonwebtoken'
import { jwtSecretPosture, assertJwtSecretPosture, JWT_SECRET, DEMO_JWT_SECRET, PUBLIC_DEFAULT_SECRETS, BACK_AUD } from '../server/middleware/auth.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
const failed = []
const ok = (name, cond, detail) => {
  const p = !!cond
  p ? (pass += 1) : (fail += 1)
  if (!p) failed.push(name)
  console.log(`  ${p ? '✓' : '✗'} ${name}${p ? '' : `  → ${JSON.stringify(detail)}`}`)
}
const group = (n) => console.log(`\n── ${n}`)

const show = (v) => {
  try { return JSON.stringify(v) } catch { return String(v) }
}

// 干净的基底 env：把宿主机的密钥变量剥掉，避免"这台机器碰巧设了"改变结论
const cleanEnv = () => {
  const e = { ...process.env }
  delete e.GML_JWT_SECRET
  delete e.JWT_SECRET
  delete e.NODE_ENV
  e.GML_RUNTIME_MODE = 'test' // 本组历史用例明确验证非生产回退
  e.HOST = '127.0.0.1'
  return e
}

// ---------------------------------------------------------------------------
group('姿态判定（纯函数，同进程可测任意 env 组合）')
// ---------------------------------------------------------------------------
{
  const fallbackDev = jwtSecretPosture({ ...cleanEnv() })
  ok('两个都没设 + 非生产 ⇒ source=fallback', fallbackDev.source === 'fallback', fallbackDev)
  ok('两个都没设 + 非生产 ⇒ level=warn（回退必须响亮，不是静默 ok）', fallbackDev.level === 'warn', fallbackDev)

  const fallbackProd = jwtSecretPosture({ ...cleanEnv(), NODE_ENV: 'production' })
  ok('两个都没设 + NODE_ENV=production ⇒ level=fatal', fallbackProd.level === 'fatal', fallbackProd)
  ok('生产回退的 reason 说清"必须显式提供 GML_JWT_SECRET"', /GML_JWT_SECRET/.test(fallbackProd.reason || ''), fallbackProd.reason)

  const byNew = jwtSecretPosture({ ...cleanEnv(), GML_JWT_SECRET: 'new-name-secret' })
  ok('设了 GML_JWT_SECRET ⇒ source=env', byNew.source === 'env', byNew)
  ok('设了 GML_JWT_SECRET ⇒ level=ok', byNew.level === 'ok', byNew)
  ok('设了 GML_JWT_SECRET ⇒ secret 等于所设的那个值', byNew.secret === 'new-name-secret', byNew.secret)

  // 这条守的是"兼容旧名字"不许被改回去（第一层修复）
  const byOld = jwtSecretPosture({ ...cleanEnv(), JWT_SECRET: 'old-name-secret' })
  ok('只设旧名字 JWT_SECRET ⇒ source=env（兼容旧名字，不许改回去）', byOld.source === 'env' && byOld.secret === 'old-name-secret', byOld)

  const both = jwtSecretPosture({ ...cleanEnv(), GML_JWT_SECRET: 'wins', JWT_SECRET: 'loses' })
  ok('两个都设 ⇒ GML_JWT_SECRET 优先', both.secret === 'wins', both)

  // 反向断言：任何"回退"都不得被判成 ok —— 静默回退必须不可能
  const allFallbacks = [
    jwtSecretPosture({ ...cleanEnv() }),
    jwtSecretPosture({ ...cleanEnv(), NODE_ENV: 'production' }),
    // 空串 / 全空白 也该算"没设"，不能拿空密钥去签
    jwtSecretPosture({ ...cleanEnv(), GML_JWT_SECRET: '' }),
    jwtSecretPosture({ ...cleanEnv(), GML_JWT_SECRET: '', JWT_SECRET: '' })
  ]
  ok('反向：凡是回退（含空串当没设）level 都不得是 ok', allFallbacks.every((p) => p.level !== 'ok'), allFallbacks.map((p) => p.level))
  ok('反向：回退用的密钥非空（否则"回退值可用"无从谈起）', allFallbacks.every((p) => typeof p.secret === 'string' && p.secret.length > 0), allFallbacks.map((p) => p.secret))
}

// ---------------------------------------------------------------------------
group('启动落点 assertJwtSecretPosture：warn 出声 / fatal 抛出 / 正常不吵')
// ---------------------------------------------------------------------------
{
  const logs = []
  const fakeLog = { warn: (m) => logs.push(String(m)) }

  const dev = assertJwtSecretPosture({ ...cleanEnv() }, fakeLog)
  ok('非生产回退：不抛（开发/验收副本要能起得来）', dev.level === 'warn', dev)
  ok('非生产回退：打了且只打了一条警告', logs.length === 1, logs)
  ok('警告里说清"用的是演示密钥"', /演示密钥/.test(logs[0] || ''), logs[0])
  ok('警告里说清"任何人都能用它伪造令牌"（人话，不是一串 code）', /伪造令牌/.test(logs[0] || ''), logs[0])

  let threw = null
  try {
    assertJwtSecretPosture({ ...cleanEnv(), NODE_ENV: 'production' }, fakeLog)
  } catch (e) {
    threw = e
  }
  ok('生产 + 无密钥：抛错（拒绝启动）', !!threw, threw && threw.message)
  ok('生产 + 无密钥：错误带 code=JWT_SECRET_MISSING_IN_PRODUCTION', threw && threw.code === 'JWT_SECRET_MISSING_IN_PRODUCTION', threw && threw.code)
  ok('生产 + 无密钥：错误消息指名 GML_JWT_SECRET（运维知道该配什么）', !!threw && /GML_JWT_SECRET/.test(threw.message), threw && threw.message)

  const logs2 = []
  const byEnv = assertJwtSecretPosture({ ...cleanEnv(), GML_JWT_SECRET: 'x' }, { warn: (m) => logs2.push(m) })
  ok('设了密钥：不抛也不吵', byEnv.level === 'ok' && logs2.length === 0, { level: byEnv.level, logs: logs2 })
}

// ---------------------------------------------------------------------------
group('回退值**真的可用**（不是空串、不是恒真校验）')
// ---------------------------------------------------------------------------
{
  const tok = jwt.sign({ uid: 1, role: 'admin' }, JWT_SECRET, { expiresIn: '1h', audience: BACK_AUD })
  let decoded = null
  try { decoded = jwt.verify(tok, JWT_SECRET, { audience: BACK_AUD }) } catch (e) { decoded = `VERIFY_FAILED:${e.message}` }
  ok('本进程的 JWT_SECRET 能签也能验（回退时就是演示密钥，但确实生效）', decoded && decoded.uid === 1, decoded)

  // 反向：密钥不是"什么都能过"的摆设 —— 换个密钥验必须失败
  let wrongKey = null
  try { jwt.verify(tok, 'definitely-not-the-secret') } catch { wrongKey = 'rejected' }
  ok('反向：换个密钥验同一个令牌 ⇒ 拒绝（不是空校验）', wrongKey === 'rejected', wrongKey)

  // 常量与函数必须同源：模块加载期算的常量要等于"用当前真实 env 跑一遍纯函数"的结果
  const expected = jwtSecretPosture(process.env)
  ok('模块常量 JWT_SECRET 与 jwtSecretPosture(process.env) 同源（不留第二份定义）', JWT_SECRET === expected.secret, { JWT_SECRET, expected: expected.secret })
  ok('模块常量非空（回退不是 undefined/空串）', typeof JWT_SECRET === 'string' && JWT_SECRET.length > 0, JWT_SECRET)
  ok('演示密钥常量就是源码里那串公开值（正因为公开，生产才必须挡住）', DEMO_JWT_SECRET === 'gml-supply-chain-demo-secret-2026', DEMO_JWT_SECRET)
}

// ---------------------------------------------------------------------------
group('子进程：真·模块加载期常量（同进程 import 会被 ESM 缓存骗）')
// ---------------------------------------------------------------------------
const probe = (env) => {
  const r = spawnSync(
    process.execPath,
    [
      '-e',
      "import('./server/middleware/auth.js').then(m=>console.log('SECRET='+m.JWT_SECRET+'|SRC='+m.jwtSecretPosture().source+'|LV='+m.jwtSecretPosture().level))"
    ],
    { cwd: ROOT, env, encoding: 'utf8' }
  )
  const m = /SECRET=([^|]*)\|SRC=([^|]*)\|LV=(.*)/.exec(r.stdout || '')
  return { raw: r.stdout, stderr: r.stderr, secret: m && m[1], source: m && m[2], level: m && m[3], status: r.status }
}
{
  const r1 = probe({ ...cleanEnv(), JWT_SECRET: 'old-name-secret' })
  ok('子进程·只设 JWT_SECRET ⇒ 模块常量为它（旧名字真被读进常量了）', r1.secret === 'old-name-secret', r1)

  const r2 = probe({ ...cleanEnv(), GML_JWT_SECRET: 'new-name-secret' })
  ok('子进程·设 GML_JWT_SECRET ⇒ 模块常量为它', r2.secret === 'new-name-secret', r2)

  const r3 = probe({ ...cleanEnv() })
  ok('子进程·两个都没设 ⇒ 模块常量是演示回退值', r3.secret === DEMO_JWT_SECRET, r3)
  ok('子进程·两个都没设 ⇒ 姿态为 warn/fallback', r3.level === 'warn' && r3.source === 'fallback', r3)

  const r4 = probe({ ...cleanEnv(), NODE_ENV: 'production' })
  ok('子进程·生产 + 无密钥 ⇒ 姿态为 fatal', r4.level === 'fatal', r4)
}

// ---------------------------------------------------------------------------
group('真·启动入口（node server/index.js）：生产拒绝启动 / 非生产能起来')
// ---------------------------------------------------------------------------
const startProbe = (env, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let settled = false
    const settle = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch {}
      resolve({ ...r, out, err })
    }
    const timer = setTimeout(() => settle({ started: out.includes('服务已启动'), exited: null, timedOut: true }), timeoutMs)
    child.stdout.on('data', (d) => { out += d; if (out.includes('服务已启动')) settle({ started: true, exited: null, timedOut: false }) })
    child.stderr.on('data', (d) => { err += d })
    child.on('exit', (code) => settle({ started: out.includes('服务已启动'), exited: code, timedOut: false }))
  })

{
  // 数据目录指到 /tmp：即使启动路径碰了库，也绝不落进工作区 data/
  const dataDirProd = mkdtempSync(path.join(tmpdir(), 'gml-jwt-prod-'))
  const dataDirDev = mkdtempSync(path.join(tmpdir(), 'gml-jwt-dev-'))
  try {
    const prod = await startProbe(
      { ...cleanEnv(), NODE_ENV: 'production', GML_DATA_DIR: dataDirProd, PORT: String(47000 + (process.pid % 500)) },
      30000
    )
    ok('生产 + 无密钥：进程自己退出（不是超时挂着）', prod.exited !== null, { exited: prod.exited, timedOut: prod.timedOut })
    ok('生产 + 无密钥：退出码非 0', prod.exited !== 0, { exited: prod.exited })
    ok('生产 + 无密钥：没有打"服务已启动"（真的没起来）', prod.started === false, prod.out.slice(-200))
    ok('生产 + 无密钥：stderr 指名 error code（运维可搜可查）', /JWT_SECRET_MISSING_IN_PRODUCTION/.test(prod.err), prod.err.slice(-300))

    const dev = await startProbe(
      { ...cleanEnv(), GML_DATA_DIR: dataDirDev, PORT: String(47500 + (process.pid % 500)) },
      45000
    )
    ok('反向·非生产 + 无密钥：**能起来**（闸门只该立在会对外服务的那一侧）', dev.started === true, { started: dev.started, exited: dev.exited, timedOut: dev.timedOut, tail: dev.out.slice(-200) })
    ok('反向·非生产 + 无密钥：启动时打了"演示密钥"警告（回退有落点）', /演示密钥/.test(dev.out + dev.err), (dev.out + dev.err).slice(-400))
  } finally {
    rmSync(dataDirProd, { recursive: true, force: true })
    rmSync(dataDirDev, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 独立复核补充（A20 残余第二轮）：这一组原本是「钉现状」的 4 条 pin，
// 三条缺陷修完之后**已经翻到"已修"方向** —— 现在它们断言的是**正确行为**，
// 谁把修复改回去就会红（反例见交付说明里的"模拟回退"三组）。
//
// 为什么 pin 要翻转而不是删掉：删掉就等于"修完没人看着"。
// 翻转后的断言 = 修复的**回归闸门**；这也正是 pin 机制的价值 ——
// 它先在缺口期当"落点"，修完当"守卫"。
// ---------------------------------------------------------------------------
group('独立复核补充：边界矩阵 · 纯函数性 · 闸门落点 · 公开值 · 认不出的 NODE_ENV')
{
  // ① NODE_ENV 归一化：大小写 / 首尾空白 / 换行都必须仍然算生产
  const variants = ['production', 'Production', 'PRODUCTION', ' production ', 'production ', 'Production\n']
  const lv = (v) => jwtSecretPosture({ ...cleanEnv(), NODE_ENV: v }).level
  const table = variants.map((v) => `${JSON.stringify(v)}=${lv(v)}`)
  ok('① 归一化：6 种大小写/空白/换行写法**全部**判 fatal（修前只有全小写是）',
    variants.every((v) => lv(v) === 'fatal'), table)

  // ① 认不出的 NODE_ENV 必须**可见**（不猜它算不算生产，但也不许静默按非生产处理）
  const unknown = ['prod', 'staging', 'PROD', 'y']
  const uP = unknown.map((v) => ({ v, ...jwtSecretPosture({ ...cleanEnv(), NODE_ENV: v }) }))
  ok('① 认不出：`prod`/`staging` 等 ⇒ unknownNodeEnv=true 且按非生产处理（level=warn，不是 fatal）',
    uP.every((p) => p.unknownNodeEnv === true && p.level === 'warn'), uP.map((p) => [p.v, p.unknownNodeEnv, p.level]))
  ok('① 认得出：production/development/test/空 ⇒ unknownNodeEnv=false（不误报）',
    ['production', 'development', 'test', 'Production', ''].every(
      (v) => jwtSecretPosture({ ...cleanEnv(), NODE_ENV: v }).unknownNodeEnv === false
    ))
  {
    const logs = []
    const p = assertJwtSecretPosture({ ...cleanEnv(), NODE_ENV: 'prod' }, { warn: (m) => logs.push(String(m)) })
    ok('① 落点：认不出的 NODE_ENV 会**真的打一条警告**（且说明运行模式与 NODE_ENV 共同决定闸门）',
      logs.length === 2 && p.unknownNodeEnv === true && /NODE_ENV/.test(logs[0]) && /闸门/.test(logs[0]),
      logs.map((l) => l.slice(0, 40)))
  }

  // ② 密钥值的归一化与"公开已知值"
  ok('② 空串算"没设"（`GML_JWT_SECRET=""` ⇒ fallback）', jwtSecretPosture({ ...cleanEnv(), GML_JWT_SECRET: '' }).source === 'fallback')
  const ws = ['   ', '\t', ' \t\n ', '\u200b']
  const wsP = ws.map((w) => ({ w, ...jwtSecretPosture({ ...cleanEnv(), GML_JWT_SECRET: w }) }))
  ok('② 纯空白 / 零宽空格都算"没设" ⇒ fallback（修前它们是 `env/ok`，密钥就是那几个空白）',
    wsP.every((p) => p.source === 'fallback' && p.level === 'warn'), wsP.map((p) => [JSON.stringify(p.w), p.source, p.level]))
  const squeezed = jwtSecretPosture({ ...cleanEnv(), GML_JWT_SECRET: '   ', JWT_SECRET: 'normal' })
  ok('② 空白 GML **不再吞掉**正常的 JWT_SECRET（修前会静默回退到演示密钥）',
    squeezed.source === 'env' && squeezed.secret === 'normal' && /JWT_SECRET/.test(squeezed.reason), squeezed)
  const publicVals = [DEMO_JWT_SECRET, 'gml-demo-secret-change-me', 'undefined', 'null']
  const pubP = publicVals.map((v) => ({ v, ...jwtSecretPosture({ ...cleanEnv(), GML_JWT_SECRET: v }) }))
  ok('② 公开已知值（演示常量 / compose 默认值 / `undefined` / `null`）⇒ source=public-default + 非生产 warn',
    pubP.every((p) => p.source === 'public-default' && p.level === 'warn'), pubP.map((p) => [p.v.slice(0, 24), p.source, p.level]))
  ok('② 反向：正常密钥仍是 `env`/`ok`（不要把什么都当公开值）',
    jwtSecretPosture({ ...cleanEnv(), GML_JWT_SECRET: 'a-real-secret' }).source === 'env')
  {
    // **分类用归一化、取值用原始**：`'abc '`（尾随空格）虽然少见，但它是一个**真实密钥**。
    // 若拿归一化后的 `'abc'` 去签名，就是**静默换掉签名密钥 ⇒ 已签发的令牌全部失效**。
    const trailing = jwtSecretPosture({ ...cleanEnv(), GML_JWT_SECRET: 'abc ' })
    const leadingZwsp = jwtSecretPosture({ ...cleanEnv(), GML_JWT_SECRET: '\u200bsecret' })
    ok('② 签名用**原始**值（分类才用归一化）：`\'abc \'` ⇒ secret 保留尾随空格，不被"顺手修好"',
      trailing.source === 'env' && trailing.secret === 'abc ', JSON.stringify(trailing.secret))
    ok('② 签名用**原始**值（续）：前导零宽空格也在 secret 里原样保留',
      leadingZwsp.source === 'env' && leadingZwsp.secret === '\u200bsecret', JSON.stringify(leadingZwsp.secret))
  }
  {
    // 文案要与行为同步：公开值命中时**不能说**"用的是内置演示密钥"（那是另一回事）
    const pubLogs = []
    assertJwtSecretPosture({ ...cleanEnv(), GML_JWT_SECRET: 'gml-demo-secret-change-me' }, { warn: (m) => pubLogs.push(String(m)) })
    const devLogs = []
    assertJwtSecretPosture({ ...cleanEnv() }, { warn: (m) => devLogs.push(String(m)) })
    ok('② 警告文案跟 `source` 走：公开值命中时说"公开已知"，落回演示密钥时才说"内置演示密钥"',
      /公开已知/.test(pubLogs[0] || '') && !/内置演示密钥/.test(pubLogs[0] || '') && /内置演示密钥/.test(devLogs[0] || ''),
      [String(pubLogs[0] || '').slice(0, 60), String(devLogs[0] || '').slice(0, 60)])
  }

  // ③ 纯函数性：传进去的 env 就是全部（不许回头读 process.env 兜底）
  const pureDir = mkdtempSync(path.join(tmpdir(), 'gml-jwt-pure-'))
  const probePure = path.join(pureDir, 'p.mjs')
  writeFileSync(
    probePure,
    `import { jwtSecretPosture } from ${JSON.stringify(path.join(ROOT, 'server/middleware/auth.js'))}\n` +
      `console.log('@@' + JSON.stringify({ noArg: jwtSecretPosture().secret, emptyArg: jwtSecretPosture({}).level }))\n`
  )
  const rp = spawnSync(process.execPath, [probePure], { env: { ...cleanEnv(), GML_JWT_SECRET: 'ENV_SECRET' }, encoding: 'utf8' })
  const pd = JSON.parse((rb => (rb.stdout || '').match(/@@(.*)/)?.[1] || '{}')(rp))
  ok('③ 纯函数性：进程里设着密钥时 `jwtSecretPosture()` 读到它，但 `jwtSecretPosture({})` **按缺省生产判 fatal**' +
     '（不读全局 ⇒ 不会被宿主机变量污染结论）',
    pd.noArg === 'ENV_SECRET' && pd.emptyArg === 'fatal', pd)
  rmSync(pureDir, { recursive: true, force: true })

  // ④ 闸门不在加载期（生产 + 无密钥下单独 import auth.js 不许炸）+ 常量仍可用
  const loadDir = mkdtempSync(path.join(tmpdir(), 'gml-jwt-load-'))
  const probeLoad = path.join(loadDir, 'l.mjs')
  writeFileSync(probeLoad, `import { JWT_SECRET } from ${JSON.stringify(path.join(ROOT, 'server/middleware/auth.js'))}\nconsole.log('@@' + typeof JWT_SECRET)\n`)
  const rl = spawnSync(process.execPath, [probeLoad], { env: { ...cleanEnv(), NODE_ENV: 'production' }, encoding: 'utf8' })
  ok('④ 闸门不在加载期：生产 + 无密钥下单独 import auth.js **不抛**（test-guards/selfcheck 不被牵连）',
    rl.status === 0 && /@@string/.test(rl.stdout || ''), { status: rl.status, stderr: (rl.stderr || '').slice(-160) })
  ok('④ 模块常量仍是非空字符串（三个消费者：index.js / mall-session.js / test-guards 读的都是它）',
    typeof JWT_SECRET === 'string' && JWT_SECRET.length > 0, JWT_SECRET)

  // ⑤ 落点：闸门在 server/index.js 的 listen **之前**
  const idxSrc = readFileSync(path.join(ROOT, 'server/index.js'), 'utf8')
  const atAssert = idxSrc.indexOf('assertJwtSecretPosture()')
  const atListen = idxSrc.indexOf('app.listen(')
  ok('⑤ 落点：`assertJwtSecretPosture()` 在 `app.listen(` **之前**被调用（先判密钥再对外服务）',
    atAssert > 0 && atListen > 0 && atAssert < atListen, { atAssert, atListen })

  // ⑥ 跨层：两道闸门，判据不同、互不重叠。
  //    ⚠️ 判据换过一次：这里原本抓的是 compose 里的 `${GML_JWT_SECRET:-<默认值>}`，
  //    前提是"compose 兜了一个默认值"；决策改成 `:?`（缺变量由 compose 直接拒绝）之后，
  //    那个默认值**从仓库里消失了** —— 所以判据必须跟着换，否则它会因为扫不到锚点而变成**空跑**。
  //    现在的判据直接钉"仓库里不存在公开默认密钥"这件事本身。
  const composeSrc = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8')
  const composeAssign = /^\s*GML_JWT_SECRET:\s*(.+)$/m.exec(composeSrc)?.[1] ?? ''
  ok('⑥ 跨层·第 1 道闸门：compose 用 `:?`（缺变量时**compose 自己拒绝解析**）且**没有** `:-` 兜底默认值',
    /:\?/.test(composeAssign) && !/:-/.test(composeAssign), composeAssign.slice(0, 120))
  // ⚠️ 这条是 (b) 方案**承重的一条**：第二道闸门（"变量给了但等于公开已知值 ⇒ production 下拒绝启动"）
  //    成立的前提是 **compose 不覆盖 NODE_ENV** —— 这样 Dockerfile 的 `ENV NODE_ENV=production`
  //    才原样继承。哪天有人往 compose 里加一行 `NODE_ENV: development`，(b) 就**静默塌掉**，
  //    等于退回我们刻意否掉的 (a)（带着公开值起得来）。所以这里把它钉住。
  //    判据只扫 `environment:` 块**内部**（按缩进切块）；注释里出现 `NODE_ENV` 不算
  //    （`^\s*NODE_ENV\s*:` 不会匹配 `# NODE_ENV:`）。
  {
    const lines = composeSrc.split('\n')
    const envIdx = lines.findIndex((l) => /^\s*environment:\s*$/.test(l))
    const envIndent = envIdx >= 0 ? (lines[envIdx].match(/^\s*/) || [''])[0].length : -1
    const block = []
    for (let i = envIdx + 1; envIdx >= 0 && i < lines.length; i++) {
      const l = lines[i]
      if (l.trim() === '') { block.push(l); continue }
      if ((l.match(/^\s*/) || [''])[0].length <= envIndent) break
      block.push(l)
    }
    const hasNodeEnv = /^\s*NODE_ENV\s*:/m.test(block.join('\n'))
    ok('⑥ 跨层·第 2 道闸门的**前提**：compose 的 environment 里**没有**显式设置 NODE_ENV' +
       '（否则 Dockerfile 的 production 被覆盖 ⇒ 第二道闸门静默失效，等于退回被否掉的 (a) 方案）',
      envIdx >= 0 && block.length > 0 && !hasNodeEnv,
      { '找到 environment 块': envIdx >= 0, '块内行数': block.length, '块内出现 NODE_ENV': hasNodeEnv })
  }
  ok('⑥ 跨层·第 2 道闸门（判据与第 1 道不重叠）：旧文档里的示例值仍在公开值集合里，' +
     '且"变量给了但等于公开已知值"在生产下 ⇒ fatal',
    PUBLIC_DEFAULT_SECRETS.includes('gml-demo-secret-change-me') &&
      jwtSecretPosture({ ...cleanEnv(), NODE_ENV: 'production', GML_JWT_SECRET: 'gml-demo-secret-change-me' }).level === 'fatal')
}

// ---------------------------------------------------------------------------
// 真启动：NODE_ENV 归一化与"认不出"的端到端证据（两种写法各起一次进程）
// ---------------------------------------------------------------------------
group('真启动：大小写 NODE_ENV 会被拒绝 / 认不出的 NODE_ENV 有警告')
{
  const startProbe = (env, timeoutMs) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = '', err = '', settled = false
      const settle = (r) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL') } catch {} ; resolve({ ...r, out, err }) }
      const timer = setTimeout(() => settle({ started: out.includes('服务已启动'), exited: null, timedOut: true }), timeoutMs)
      child.stdout.on('data', (d) => { out += d; if (out.includes('服务已启动')) settle({ started: true, exited: null, timedOut: false }) })
      child.stderr.on('data', (d) => { err += d })
      child.on('exit', (code) => settle({ started: out.includes('服务已启动'), exited: code, timedOut: false }))
    })
  const d1 = mkdtempSync(path.join(tmpdir(), 'gml-jwt-up-'))
  const d2 = mkdtempSync(path.join(tmpdir(), 'gml-jwt-un-'))
  let port = 47400
  try {
    const upper = await startProbe({ ...cleanEnv(), NODE_ENV: 'Production', GML_DATA_DIR: d1, PORT: String(++port) }, 30000)
    ok('真启动·`NODE_ENV=Production` + 无密钥 ⇒ **拒绝启动**（退出码非 0，修前它会照常起来）',
      upper.exited !== null && upper.exited !== 0 && upper.started === false,
      { exited: upper.exited, started: upper.started, err: upper.err.slice(-160) })

    const unknown = await startProbe({ ...cleanEnv(), NODE_ENV: 'prod', GML_JWT_SECRET: 'a-real-secret', GML_DATA_DIR: d2, PORT: String(++port) }, 45000)
    ok('真启动·`NODE_ENV=prod`（认不出）+ 正常密钥 ⇒ 起得来，但**stderr 里有"无法识别"警告**（闸门可能没生效这件事被说出来）',
      unknown.started === true && /无法识别的 NODE_ENV/.test(unknown.out + unknown.err),
      { started: unknown.started, err: (unknown.out + unknown.err).slice(-260) })
  } finally {
    rmSync(d1, { recursive: true, force: true })
    rmSync(d2, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(56)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) console.log('失败项：\n - ' + failed.join('\n - '))
process.exit(fail ? 1 : 0)
