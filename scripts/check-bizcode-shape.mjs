#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/check-bizcode-shape.mjs ｜ 静态守卫：业务码形状守卫：**带业务码的失败响应只能有一个构造点**，且三个入口产出的 JSON 必须逐字段相同。
 * ============================================================================
 * 【职责】静态守卫：业务码形状守卫：**带业务码的失败响应只能有一个构造点**，且三个入口产出的 JSON 必须逐字段相同。
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
 * 业务码形状守卫：**带业务码的失败响应只能有一个构造点**，且三个入口产出的 JSON 必须逐字段相同。
 *
 * 为什么需要它：
 *   业务码（`PERIOD_CLOSED` / `DOC_STATE_ILLEGAL` / `PAY_NO_SUPPLIER`…）原先有**三个落点**、
 *   形状互不相同 —— 路由层的"翻译"只写 `detail.code`，全局兜底中间件只写顶层 `error`，
 *   单据流转两处都写。于是调用方读一个码得写 `b.error || b.detail?.code` 两套判断；
 *   少写一半的表现是**错误提示退化成一句中文**，报障时无从定位。
 *   这类"形状漂移"不会让任何测试报错（两边各自都能跑通），只会让排查变慢 ——
 *   所以必须有一条常驻守卫盯着：将来谁再手写一份形状，这里立刻变红。
 *
 * 判据两条：
 *   ① 静态：`server/` 下除 `lib/http.js` 外，不得存在「业务码被**在形内手写**」的构造点；
 *      三个入口必须实调 `bizFail`（而不是自己拼对象）。
 *      （判据的形态清单见下方 ①-3 的注释 —— 第一版只认 `error:` 与 `detail: { code:`，
 *       被 `{ success:false, code, message }` 与 `detail: { code: x }`（code 是第一个键）
 *       两种形态各穿透过一次，现已补齐。）
 *   ② 动态：在进程内把 `errorHandler` / `failFromError` / `handleFlowError` 三个入口
 *      喂同一个业务错误，断言产出的 JSON **完全一致**，且顶层 `error` == `detail.code` == 业务码、
 *      顶层 `code` == 1；无业务码时顶层 `code` 退回 HTTP status 且不出现 `error` 字段。
 *
 * 用法：node scripts/check-bizcode-shape.mjs   （全绿退出 0，否则 1）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UNIQUE_SOURCE = path.join(ROOT, 'server/lib/http.js')
const HTTP_REL = path.relative(ROOT, UNIQUE_SOURCE)

let pass = 0
let failed = 0
const failNames = []
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    failNames.push(name)
    console.log(`  ✗ ${name}${extra ? `  —— ${extra}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 静态检查
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.js$/.test(f)) out.push(p)
  }
  return out
}

/** 去掉注释：否则注释里写的形状说明会把静态扫描带偏（守卫自己就被写歪过） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

/**
 * 把字符串/模板字面量替换成等长填充（**保留换行**，否则行号会整体错位）。
 *
 * 为什么需要：业务码的判据要区分「值是数字字面量（顶层 code，项目约定）」与
 * 「值是字符串/变量（业务码）」。而错误文案里经常出现 `code: ` 这样的字样
 * （例如 `fail(res, '请检查 code: 5 是否合法')`），不遮住字面量就会**误报**；
 * 全遮又会把 `code: 'PERIOD_CLOSED'` 的真业务码一起遮掉 —— 所以是"替换成等长的
 * 非空白填充"而不是"删掉"：真业务码填充后仍然是非数字，照样命中。
 */
function maskLiterals(src) {
  return src.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, (m) => m.replace(/[^\n]/g, '\u0001'))
}

/**
 * 在一段文本里找「业务码」出现的位置。
 *
 * 业务码 = 值是**非数字字面量**的 `code`（字符串 / 变量 / 成员访问），
 * 或者 `code` 简写（`{ code, message }` —— 值来自同名的变量）。
 * 为什么**不含** `code: 1` / `code: 409`：顶层 `code` 是数字是本项目的既有约定
 * （`0` 成功、非 0 失败），`1` 出现得满地都是（`index.js` 的 404 兜底、
 * MCP 确认单的 6 处），把它算成业务码会让守卫变成噪声、进而被忽略 ——
 * 而一条会被忽略的守卫等于没有。
 */
function bizCodeHits(text) {
  const hits = []
  let m
  // 键值式：`{ code: X }` / `, code: X`。值不是数字字面量才算业务码。
  // 前导**必须是 `{` `(` `,`**（不能是 `^`）：`fail(code, message, httpStatus)` 这种
  // "形参名就叫 code"的签名会被 `^` 当成简写命中 —— 而它跟业务码毫无关系。
  const kv = /([{,(,]\s*)code\s*:\s*([^\s,}]+)/g
  while ((m = kv.exec(text))) {
    if (!/^-?\d+(\.\d+)?$/.test(m[2])) hits.push(m[2])
  }
  // 简写式：`{ code }` / `, code }`。前导限定为 `{` `,` —— 简写属性语法只可能出现在对象字面量里，
  // 而 `fail(res, code, 400)` 这种位置参数不是。
  const shorthand = /[{,]\s*code\s*(?=[,}])/g
  while ((m = shorthand.exec(text))) hits.push('(shorthand)')
  return hits
}

/** 返回 src 中 openIdx 处 `{` 对应的 `}` 下标（含嵌套），找不到返回 -1 */
function matchBrace(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 返回 src 中 openIdx 处 `(` 对应的 `)` 下标（含嵌套），找不到返回 -1 */
function matchParen(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 取出 `function NAME(...) { ... }` 的函数体（含头），找不到返回 null */
function funcBody(src, name) {
  const re = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`)
  const m = re.exec(src)
  if (!m) return null
  const open = src.indexOf('{', m.index)
  if (open < 0) return null
  const close = matchBrace(src, open)
  if (close < 0) return null
  return src.slice(m.index, close + 1)
}

// ①-1：唯一构造点必须存在
const httpSrc = stripComments(fs.readFileSync(UNIQUE_SOURCE, 'utf8'))
ok(`静态：${HTTP_REL} 导出唯一构造点 bizFail`, /export\s+function\s+bizFail\s*\(/.test(httpSrc))

// ①-2：三个入口都实调 bizFail，且不再自己拼形状（自己拼必然出现 success:false）
const auditSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server/middleware/audit.js'), 'utf8'))
const docflowSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server/routes/docflow.js'), 'utf8'))
for (const [name, src, fn] of [
  ['failFromError', httpSrc, 'failFromError'],
  ['errorHandler', auditSrc, 'errorHandler'],
  ['handleFlowError', docflowSrc, 'handleFlowError']
]) {
  const body = funcBody(src, fn)
  ok(
    `静态：${name} 委托 bizFail（不再手写失败形状）`,
    !!body && /bizFail\s*\(/.test(body) && !/success\s*:\s*false/.test(body),
    body ? (/(bizFail\s*\()/.test(body) ? '仍含手写 success:false' : '未调用 bizFail') : '未找到函数'
  )
}

// ①-3：server/ 下没有任何「形内业务码构造点」
//       三级判据，缺一不可 —— 成因不同，只查一级会漏掉另一级：
//         Ⅰ「响应对象式」：自己拼失败响应对象（含 `success: false`），并把业务码写进去。
//            这里踩过两个坑，都写进判据里了：
//              · 只认 `error:` 键 → 漏掉只写 `detail: { code }` 的形态；
//              · 只认 `detail: { code:` 紧接着 `{` → 漏掉 `detail: { code: 'X' }`
//                （code 是**第一个**键）—— 正则要求 `code` 前面是 `{` 或 `,`，
//                而 `{ code` 里的 `{` 已被 `\{` 吃掉，剩下的前导字符是空格，匹配不上。
//            现判据：只要有**业务码**（非数字字面量的 `code`，含简写）就算构造点。
//         Ⅱ「fail() 参数式」：把业务码塞进 `fail()` 的第 5 个参数（`fail(res, msg, 400, 1, { code })`）。
//            这类**不含 `success: false`**（success 由 `fail()` 自己写），所以只查 Ⅰ 永远抓不到 ——
//            本次收编掉的 21 处路由全部属于这一级。
//         Ⅲ「中间变量式」：`const body = { code: e.code }; fail(res, msg, 409, 1, body)`。
//            Ⅰ 看不到（没有 `success: false`），Ⅱ 也看不到（参数位上只有标识符）。
//            做法是**尽力而为**的同文件数据流：先收集「字面量里带业务码」的变量名，
//            再看它有没有出现在 `fail()` 的实参里。跨文件/跨函数赋值的绕法仍然看不出来 ——
//            那已经超出静态判据的边界，但"同文件里先赋给变量再传"是真实会发生的写法。
//       判据：出现即算构造点，`lib/http.js` 是唯一豁免（`bizFail` 就在那里），
//             外加 DECLARED_ALIEN 里**声明过**的外部协议落点（见下方说明）。
//
// 扫描逻辑抽成 `scanOne(rel, raw)` 是为了下面的**扫描器自检**能直接复用它 ——
// 自检必须打的就是"真正跑在源码上的那个函数"，另写一份等于自检另一个东西。
function scanOne(rel, raw) {
  const offenders = []
  // 「形内手写失败形状、但**不带业务码**」的落点（与 `fail()` 产出的 JSON 逐字节相同）。
  // 它们不是违规，但**必须记账**：它们是"将来改信封时要记得改"的点，而守卫的判据（业务码）
  // 按设计看不见它们 —— 不记账就等于"没人知道有这几处"。
  const handwritten = []
  const src = maskLiterals(stripComments(raw))
  const lineOf = (idx) => src.slice(0, idx).split('\n').length
  const textAt = (line) => (src.split('\n')[line - 1] || '').trim()

  // Ⅲ 的前置：本文件里「值是有业务码的对象字面量」的变量名
  const codeVars = new Set()
  const cvRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g
  let cv
  while ((cv = cvRe.exec(src))) {
    const open = src.indexOf('{', cv.index)
    const close = matchBrace(src, open)
    if (close > open && bizCodeHits(src.slice(open, close + 1)).length) codeVars.add(cv[1])
  }

  // Ⅰ 响应对象式。
  // 用正则而不是 `indexOf('success: false')`：写法变体会穿透字面量匹配 ——
  // `success:!1`（压缩器产物）、`success : false`、`success:\n  false` 都是同一件事。
  const failFlag = /success\s*:\s*(?:false|!1)/g
  let idxM
  while ((idxM = failFlag.exec(src))) {
    const idx = idxM.index
    const open = src.lastIndexOf('{', idx)
    if (open >= 0) {
      const close = matchBrace(src, open)
      if (close > idx) {
        const obj = src.slice(open, close + 1)
        const hasErrorKey = /(^|[{,])\s*error\s*:/.test(obj)
        const line = lineOf(open)
        if (hasErrorKey || bizCodeHits(obj).length) {
          offenders.push({ file: rel, line, kind: 'Ⅰ 响应对象式', text: textAt(line) })
        } else {
          handwritten.push({ file: rel, line, text: textAt(line) })
        }
      }
    }
  }

  // Ⅱ fail() 参数式：把调用实参整段取出再看有没有业务码
  let c = src.indexOf('fail(')
  while (c >= 0) {
    const before = src[c - 1] || ''
    const isCall = !/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(src[c + 4] || '')
    if (isCall) {
      const openP = c + 4
      const closeP = matchParen(src, openP)
      const args = closeP > 0 ? src.slice(openP + 1, closeP) : ''
      const line = lineOf(c)
      // 只认「键名」形态（`{ code:` / `, code:` / 简写 `{ code }`）；`code = 1` 这类赋值不算
      if (bizCodeHits(args).length) offenders.push({ file: rel, line, kind: 'Ⅱ fail() 参数式', text: textAt(line) })
      // Ⅲ：实参里出现"带业务码的中间变量"。
      // `(?:[,)]|$)` 里的 `$` 不能省：参数出现在**末位**时（`fail(res, m, 409, 1, body)`）
      // 后面没有右括号 —— args 是 `(` 与 `)` 之间的切片，右括号不在里面。
      for (const v of codeVars) {
        if (new RegExp(`[,\\(]\\s*${v}\\s*(?:[,)]|$)`).test(args)) {
          offenders.push({ file: rel, line, kind: `Ⅲ 中间变量式：${v}`, text: textAt(line) })
          break
        }
      }
    }
    c = src.indexOf('fail(', c + 5)
  }
  return { offenders, handwritten }
}

// ── 扫描器自检：先证明"这次真的扫到了"，再相信"这次是干净的" ──────────────
// 为什么必须有这一段：**守卫扫不到时只会变绿，而绿是没人会去看的颜色。**
// 判据被写歪（正则漏了、`maskLiterals` 把整段吃掉了、`walk` 少扫了目录），
// 输出与"库里真的干净"**完全一样**。本批次就真的发生过两次：
//   · Ⅰ 的正则要求 `code` 前紧跟 `{`/`,`，于是 `detail: { code: … }`（code 是**第一个**键）
//     全库穿透，而守卫是绿的；
//   · "保留键"判据第一版只扫 `detail:` 字面量，看不见**位置参数**形态（`agreement.js`）。
// 所以这里拿 8 段**合成的已知违规**喂给上面那个真正跑在源码上的 `scanOne()`，
// 每段都必须被判成违规 —— 少判一段就红，并直说"扫描器失效"。
// 另配一段**干净样本**做反向对照：它必须**一条都不判**，否则说明判据变成了"见谁都咬"。
const SCANNER_SHAPES = [
  { id: 'F1', desc: 'Ⅰ：拼失败对象 + error: 键', src: `res.status(409).json({ code: 1, success: false, message: 'x', error: 'PERIOD_CLOSED', detail: { code: 'PERIOD_CLOSED' } })` },
  { id: 'F2a', desc: 'Ⅰ：detail 里 code 是**第一个**键（当年穿透的就是它）', src: `res.status(409).json({ code: 1, success: false, message: 'x', detail: { code: 'PERIOD_CLOSED' } })` },
  { id: 'F2b', desc: 'Ⅰ：detail 里 code 在展开之后', src: `res.status(409).json({ code: 1, success: false, message: 'x', detail: { ...(e.detail || {}), code: e.code } })` },
  { id: 'F3', desc: 'Ⅰ：顶层 code 用**简写**（qimen.js 的真实形态）', src: `res.status(200).json({ success: false, code, message })` },
  { id: 'F4', desc: 'Ⅱ：fail() 第 5 参放 code，跨 7 行', src: `fail(\n  res,\n  e.message,\n  409,\n  1,\n  { code: e.code }\n)` },
  { id: 'F5', desc: 'Ⅲ：先把 body 放进中间变量再传 fail()', src: `const body = { code: e.code };\nfail(res, e.message, 409, 1, body)` },
  { id: 'F7', desc: 'Ⅰ：另起一个不同名字的同类助手', src: `function failBiz(res, code, message) {\n  return res.status(200).json({ success: false, code, message })\n}` },
  { id: 'F9', desc: 'Ⅰ：success 写成压缩风格 `!1`', src: `res.status(409).json({ success: !1, code, message })` }
]
// 干净样本：一个手写失败形状（**无**业务码 → 只该进"记账"桶）+ 一次合法的 fail() 调用
const SCANNER_CLEAN = [
  `res.status(404).json({ code: 1, success: false, message: '接口不存在' })`,
  `fail(res, '参数不对', 400, 1, { field: 'supplier_id' })`,
  `const body = { code: 1 }`,
  `fail(res, '参数不对', 400, 1, body)`
].join('\n')

const selfMissed = []
for (const s of SCANNER_SHAPES) {
  const r = scanOne('__scanner_selftest__', s.src)
  if (!r.offenders.length) selfMissed.push(s.id)
  ok(
    `自检：扫描器能判出「${s.id} ${s.desc}」`,
    r.offenders.length > 0,
    `**扫描器失效** —— 这段合成违规一条都没判出来，本轮"无违规"不能相信：${JSON.stringify(s.src)}`
  )
}
const clean = scanOne('__scanner_selftest__', SCANNER_CLEAN)
ok(
  '自检：干净样本不被误判（反向对照 —— 判据不能"见谁都咬"）',
  clean.offenders.length === 0 && clean.handwritten.length === 1,
  `offenders=${JSON.stringify(clean.offenders)} handwritten=${clean.handwritten.length}（期望 0 / 1）`
)
if (selfMissed.length) {
  // 只要**有一种**形态判不出来就报 —— 不能只在"全判不出来"时才喊：
  // 判据通常是**部分**退化（改了个正则、少认一个键名），而部分退化同样会让
  // 上面那条"真实扫描"变成**假绿**。部分退化比全瘫更危险，因为它看起来还像在工作。
  console.log(
    `\n⛔ 扫描器失效：${selfMissed.length}/${SCANNER_SHAPES.length} 种合成违规判不出来（${selfMissed.join(' / ')}）` +
      ` —— 本次"server/ 下无任何业务码构造点"的结论**不可信**，先修判据再信它。\n`
  )
}

const offenders = []
const handwritten = []
let scanned = 0
for (const f of walk(path.join(ROOT, 'server'))) {
  if (f === UNIQUE_SOURCE) continue
  const r = scanOne(path.relative(ROOT, f), fs.readFileSync(f, 'utf8'))
  offenders.push(...r.offenders)
  handwritten.push(...r.handwritten)
  scanned += 1
}

// ── 已声明的「非项目信封」落点（豁免）──────────────────────────────────────
// 为什么允许存在例外：奇门（Qimen）网关的**线格式由外部协议规定** ——
// 《奇门标准化协议》要求承接方一律回 HTTP 200，成败放在响应体的
// `{ success, code, message }` 里，`code` 是协议错误码（'1001'/'1002'/'9999'…，
// 见 `server/routes/qimen.js` 的 `qimenError`）。它的消费者是**外部 ERP/平台**，
// 不是本项目前端；改成 `bizFail` 的项目信封（顶层 code 数字 + error/detail.code）
// 会直接违反协议 —— 同文件里成功响应也是 `{ success: true, code: 0, ... }`，可见
// 这是"整个网关不属于项目信封"的协议级决定，不是漏改。（实测：`POST /api/qimen {}`
// → HTTP 200 + `{"success":false,"code":"1001","message":"缺少 method 参数"}`。）
//
// 定位用 **文件 + 该行原文的唯一子串**，不用行号：
//   行号会漂（上面加一段注释就整体下移），而**误豁免是静默的** —— 守卫照样绿，
//   豁免却落到了另一个构造点上。用行内容定位后：漂到别处 = 子串对不上 = 变红，
//   提醒你更新声明。"失败要响"是这条判据唯一重要的性质。
// 名单里的落点如果不见了（被收编成 bizFail / 改写），也会变红提醒删掉这一条 ——
// 否则它将来会变成一张"过期通行证"。
const DECLARED_ALIEN = [
  {
    file: 'server/routes/qimen.js',
    contains: 'json({ success: false, code, message, ...extra })',
    why: '奇门协议：HTTP 200 + {success, code, message}，code 是协议错误码，消费者是外部 ERP'
  }
]
const fmt = (o) => `${o.file}:${o.line}（${o.kind}）`
const waived = offenders.filter((o) => DECLARED_ALIEN.some((d) => d.file === o.file && o.text.includes(d.contains)))
const real = offenders.filter((o) => !waived.includes(o))
ok(
  `静态：server/ 下（除 ${HTTP_REL} 与 ${DECLARED_ALIEN.length} 处已声明外部协议落点外）无任何形内业务码构造点`,
  real.length === 0,
  real.map(fmt).join(' / ')
)
ok(
  '静态：已声明的外部协议落点仍在（名单不过期；行内容定位，漂了也红）',
  DECLARED_ALIEN.every((d) => waived.some((o) => o.file === d.file && o.text.includes(d.contains))),
  `名单 ${DECLARED_ALIEN.length} 条、命中 ${waived.length} 条：${DECLARED_ALIEN.map((d) => `${d.file}「${d.contains}」`).join(' / ')}`
)

// ── 已声明的「形状重复但无业务码」清单（记账，不是豁免）────────────────────
// 这几处是自己拼的失败响应对象，但**不带业务码**，所以按上面的判据不算违规 ——
// 而它们与 `fail(res, msg, status)` 产出的 JSON **逐字节相同**（`detail: undefined`
// 会被 JSON 丢掉），今天不构成形状分叉。之所以还要把它们钉成数字：
//
//   它们是"将来改信封时要记得改"的点。守卫的判据（业务码）**按设计**看不见它们，
//   于是"不违规"和"没人知道有这几处"就混成了一件事。把**处数**钉住后：
//     · 谁新写一处 → 红（提醒他直接用 `fail()`）
//     · 谁把这 7 处收编成 `fail()` → 也红（提醒把数字改小）—— 这条同样重要，
//       否则清单会永远停在一个虚高的数字上，重新变成"没人知道"。
// 当前 7 处：`server/index.js` 的 404 兜底 1 处 + `server/mcp/server.js` 确认单的 REST 接口 6 处。
const HANDWRITTEN_DECLARED = 7
ok(
  `静态：形内手写失败形状（无业务码）恰好 ${HANDWRITTEN_DECLARED} 处 —— 与 fail() 逐字节相同，改信封时要记得改`,
  handwritten.length === HANDWRITTEN_DECLARED,
  `实际 ${handwritten.length} 处：${handwritten.map((o) => `${o.file}:${o.line}`).join(' / ')}`
)

// ── 已声明的「别的信封」码承载通道（不是违规，但也不能当它不存在）──────────
// 判据只覆盖"响应体的失败形状"。下面这些通道的码**不由响应体形状表达**，
// 所以判据扫不到它们 —— 扫不到不等于不存在：它们是"一个业务码、多种读法"的
// 既成事实，必须**声明**出来（每条都断言"仍然存在"，不然文档与代码会各说各话）。
//
// 与上面 DECLARED_ALIEN 的区别：ALIEN 是"**命中判据**但刻意保留"，这里是"**不命中判据**
// 但需要记账"。把两者混在一起会让"豁免"这个词失去意义。
const ENVELOPES = [
  {
    name: 'MCP toolError（工具级错误）',
    file: 'server/mcp/server.js',
    contains: 'function toolError(res, id, code, message, detail = null)',
    why: '外层是 MCP 规范的 `result.isError`（不是 JSON-RPC error，见上面的注释），消费者是 Agent 宿主，线格式由规范定；payload 内部**沿用项目字段名** `{error, message, detail}`，所以会读 bizFail 的人就会读它。**已声明的差异**：它只在 `error` 一处给码、没有 `detail.code` —— 跨通道两种读法是既成事实，统一它是另一件事，这里不做"应该统一"的判断。'
  },
  {
    name: 'MCP rpcError（协议/传输层错误）',
    file: 'server/mcp/server.js',
    contains: 'function rpcError(res, id, code, message)',
    why: 'JSON-RPC 的 `error.code` 是**协议层**码（不是业务码），与业务码归类不同是刻意的。'
  }
]
for (const env of ENVELOPES) {
  const src = maskLiterals(stripComments(fs.readFileSync(path.join(ROOT, env.file), 'utf8')))
  ok(`静态：已声明通道仍在 —— ${env.name}`, src.includes(env.contains), `${env.file} 里找不到「${env.contains}」`)
}

// ── 保留键 `code` 不得被业务库当 `detail` 的键名 ──────────────────────────
// `bizFail` 会把业务码写进 `detail.code`，所以 `code` 在**响应**的 detail 里是保留键。
// 业务库如果拿它装别的东西（`lib/agreement.js` 曾用 `{ agreement_id, code: a.code }`
// 传**协议号** AG2026-xxx），后果是静默的：`error` 与 `detail.code` 不同值，
// 两处读法拿到两个不同的东西 —— 而"静默"正是这一批要消灭的东西。
//
// 为什么这条断言是必要的：`bizFail` 的展开顺序修好后，**覆盖已经不会发生**
// （业务码总是赢），于是"调用方又用 code 键"这件事就**再也不会造成任何可见后果** ——
// 协议号只会**安静地消失**。没有这条断言，`agreement.js` 的改法就没有任何东西看着。
//
// 两种写法都要覆盖，它们的形状完全不同：
//   · 选项对象式 `new PurchaseError(msg, { code, httpStatus, detail })`
//     → `detail` 是个**键名**，扫 `detail: { ... }` 字面量即可；
//   · 位置参数式 `new AgreementError(code, msg, httpStatus, detail)`
//     → `detail` **根本不是键名**，字面量扫描看不见它（第一版就漏在这里，
//       反例 C5 没变红才发现）。所以要**读每个错误类的构造器签名**，数出 `detail`
//       是第几个参数，再去 `new Xxx(...)` 的实参里取那一个。
//   排除 `audit(...)`：审计载荷的 `detail` 是**日志字段**不是响应体
//   （`audit` 会把 `{code: row.code}` 之类原样写进 audit_logs），在那里用 `code` 是对的。
const errClasses = new Map()
for (const f of walk(path.join(ROOT, 'server'))) {
  const src = maskLiterals(stripComments(fs.readFileSync(f, 'utf8')))
  const re = /export\s+class\s+(\w+)\s+extends\s+Error\s*\{[\s\S]{0,500}?constructor\s*\(([\s\S]{0,200}?)\)\s*\{/g
  let m
  while ((m = re.exec(src))) {
    // 构造器参数里有 `{` = 选项对象式（`detail` 是里面的键），交给字面量判据
    if (m[2].includes('{')) { errClasses.set(m[1], -1); continue }
    const names = m[2].split(',').map((s) => s.trim().split(/[=\s]/)[0]).filter(Boolean)
    errClasses.set(m[1], names.indexOf('detail'))
  }
}
/** 按顶层逗号切参数（跳过括号/花括号/方括号内部的逗号） */
function splitArgs(s) {
  const out = []
  let depth = 0, cur = ''
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim())
}
const reservedMisuse = []
for (const f of walk(path.join(ROOT, 'server'))) {
  const raw = fs.readFileSync(f, 'utf8')
  const src = maskLiterals(stripComments(raw))
  const rel = path.relative(ROOT, f)
  const lines = src.split('\n')
  const report = (idx, where) => reservedMisuse.push(`${rel}:${src.slice(0, idx).split('\n').length}（${where}用保留键 code 装非业务码）`)

  // ① 选项对象式：`detail: { ... }` 字面量
  const re = /(^|[{,(,])\s*detail\s*:\s*\{/g
  let m
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index)
    const close = matchBrace(src, open)
    if (close < 0) continue
    const line = src.slice(0, open).split('\n').length
    if ((lines[line - 1] || '').includes('audit(')) continue
    if (bizCodeHits(src.slice(open, close + 1)).length) report(open, 'detail 字面量里的 ')
  }

  // ② 位置参数式：按构造器签名取第 N 个实参
  for (const [cls, idx] of errClasses) {
    if (idx < 0) continue
    const reNew = new RegExp(`new\\s+${cls}\\s*\\(`, 'g')
    let n
    while ((n = reNew.exec(src))) {
      const openP = src.indexOf('(', n.index)
      const closeP = matchParen(src, openP)
      if (closeP < 0) continue
      const args = splitArgs(src.slice(openP + 1, closeP))
      const arg = args[idx]
      if (arg && arg.startsWith('{') && bizCodeHits(arg).length) report(openP, `${cls} 第 ${idx + 1} 个实参（detail）`)
    }
  }
}
ok(
  '静态：没有把保留键 code 当 detail 键名的地方（协议号之类请改用 agreement_code 这类名字）',
  reservedMisuse.length === 0,
  reservedMisuse.join(' / ')
)

// ---------------------------------------------------------------------------
// 动态检查：三个入口对同一个业务错误必须产出完全相同的 JSON
// ---------------------------------------------------------------------------

const { bizFail, failFromError } = await import('../server/lib/http.js')
const { errorHandler } = await import('../server/middleware/audit.js')
const { handleFlowError } = await import('../server/routes/docflow.js')
const { DocFlowError } = await import('../server/lib/docflow.js')

/** 极简 res：够 bizFail / errorHandler 用（status().json() 链式） */
function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    status(s) {
      this.statusCode = s
      return this
    },
    json(b) {
      this.body = b
      return this
    }
  }
}

const errInput = () => ({ code: 'X_Y', message: 'm', status: 409, detail: { a: 1 } })

const r1 = fakeRes()
errorHandler(errInput(), { method: 'POST', originalUrl: '/probe' }, r1, () => {})
const r2 = fakeRes()
failFromError(r2, errInput())
const r3 = fakeRes()
handleFlowError(r3, new DocFlowError('m', { code: 'X_Y', httpStatus: 409, detail: { a: 1 } }))

const entries = { errorHandler: r1, failFromError: r2, handleFlowError: r3 }

// 三个入口形状完全一致（含 status 与 body）
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
ok(
  '动态：三入口产出完全一致（status=409 / 同一份 JSON）',
  r1.statusCode === 409 &&
    r2.statusCode === 409 &&
    r3.statusCode === 409 &&
    same(r1.body, r2.body) &&
    same(r1.body, r3.body),
  `${r1.statusCode}/${r2.statusCode}/${r3.statusCode} ${JSON.stringify(r1.body)} | ${JSON.stringify(r2.body)} | ${JSON.stringify(r3.body)}`
)

// 逐入口：双写一致（顶层 error == detail.code == 业务码，顶层 code == 1，detail 其余字段保留）
for (const [label, r] of Object.entries(entries)) {
  const b = r.body || {}
  ok(
    `动态：${label} 顶层 error == detail.code == 'X_Y' 且顶层 code == 1`,
    b.code === 1 && b.success === false && b.error === 'X_Y' && b.detail?.code === 'X_Y',
    JSON.stringify(b)
  )
}

// detail 的其它键必须保留（不能为了统一而把业务明细吃掉）
ok(
  '动态：bizFail 保留 detail 附加字段（a=1）',
  r1.body?.detail?.a === 1 && r2.body?.detail?.a === 1 && r3.body?.detail?.a === 1,
  `${JSON.stringify(r1.body?.detail)} / ${JSON.stringify(r2.body?.detail)} / ${JSON.stringify(r3.body?.detail)}`
)

// 无业务码：顶层 code 退回 HTTP status，且不出现 error 字段
const r4 = fakeRes()
errorHandler({ message: 'boom', status: 500 }, { method: 'POST', originalUrl: '/probe' }, r4, () => {})
ok(
  '动态：无业务码时顶层 code 退回 HTTP status（500）',
  r4.statusCode === 500 && r4.body?.code === 500 && r4.body?.success === false,
  `${r4.statusCode} ${JSON.stringify(r4.body)}`
)
ok(
  '动态：无业务码时不写 error 字段',
  r4.body && !Object.prototype.hasOwnProperty.call(r4.body, 'error'),
  JSON.stringify(r4.body)
)

// `detail` 里的 `code` 是**保留键**：业务码不能被 detail 自带的同名字段覆盖。
// 这条是真实撞过的形态（`lib/agreement.js` 传过 `{ agreement_id, code: a.code }`，
// 而 `a.code` 是**协议号** AG2026-xxx）：`error` 是业务码、`detail.code` 是协议号，
// 同一份响应里两处读法拿到两个不同的东西，且完全静默。
// 修法是 `detail: { ...(err.detail || {}), code }`（展开在 code 之前）。
const r5 = fakeRes()
bizFail(r5, { code: 'OUTER', message: 'm', status: 409, detail: { a: 1, code: 'INNER' } })
ok(
  "动态：detail 自带 code 键时不能覆盖业务码（error === detail.code === 'OUTER'）",
  r5.body?.error === 'OUTER' && r5.body?.detail?.code === 'OUTER' && r5.body?.detail?.a === 1,
  JSON.stringify(r5.body)
)

// 用**真实错误类**再过一次（上面那条是我造的对象，这条证明调用方真的会踩到）
const { AgreementError } = await import('../server/lib/agreement.js')
const r6 = fakeRes()
bizFail(
  r6,
  new AgreementError('AGREEMENT_BELOW_FLOOR', '折算价低于最低限价', 409, {
    agreement_id: 7,
    agreement_code: 'AG2026-001',
    price: 88,
    floor: 100
  })
)
ok(
  '动态：真实 AgreementError 过 bizFail —— detail.code 是业务码、协议号在 agreement_code、明细没丢',
  r6.statusCode === 409 &&
    r6.body?.detail?.code === 'AGREEMENT_BELOW_FLOOR' &&
    r6.body?.detail?.agreement_code === 'AG2026-001' &&
    r6.body?.detail?.agreement_id === 7 &&
    r6.body?.detail?.price === 88 &&
    r6.body?.detail?.floor === 100,
  `${r6.statusCode} ${JSON.stringify(r6.body)}`
)

// 日志码与响应码**同源**：两处都走 `statusOf`。
// 这条的观测量是"有没有记 [error] 日志"＋"响应码是多少"这一对：
//   只有 `.httpStatus` / `.http` 的错误（`ImError` / `ArError` 那两族），
//   日志判定若自己写 `err.status || 500` 就会算出 500 → **记日志（说 500）、响应实发 400**；
//   改后两处同源 → 400 < 500 → 不记日志，且响应 400。所以"没记日志"就是判据。
for (const [name, err, want] of [
  ['只有 httpStatus（ImError 形态）', { code: 'IM_X', message: 'm', httpStatus: 400 }, 400],
  ['只有 http（ArError 的旧形态）', { code: 'AR_X', message: 'm', http: 404 }, 404]
]) {
  const res = fakeRes()
  const logged = []
  const orig = console.error
  console.error = (...a) => logged.push(a)
  errorHandler(err, { method: 'POST', originalUrl: '/probe' }, res, () => {})
  console.error = orig
  ok(
    `动态：${name} —— 响应 ${want} 且日志判定同源（不记 [error]，修前会记成 500）`,
    res.statusCode === want && logged.length === 0,
    `status=${res.statusCode} 记日志=${logged.length} 次 ${JSON.stringify(res.body)}`
  )
}
// 真正的 5xx 仍要记日志（别把上面两条修成"什么都不记"）
{
  const res = fakeRes()
  const logged = []
  const orig = console.error
  console.error = (...a) => logged.push(a)
  errorHandler({ message: 'boom' }, { method: 'POST', originalUrl: '/probe' }, res, () => {})
  console.error = orig
  ok(
    '动态：真 5xx（无任何 status 字段）仍记 [error] 日志且响应 500',
    res.statusCode === 500 && logged.length === 1,
    `status=${res.statusCode} 记日志=${logged.length} 次`
  )
}

// ---------------------------------------------------------------------------
console.log('\n' + '─'.repeat(60))
if (failed) console.log(`失败断言：${failNames.join(' / ')}`)
console.log(`通过 ${pass} / 失败 ${failed}`)
process.exitCode = failed ? 1 : 0
