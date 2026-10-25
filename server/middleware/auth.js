/**
 * ============================================================================
 * 文件标识：server/middleware/auth.js ｜ 鉴权与授权中间件：JWT 校验、角色门、权限点、跨组织拦截 —— `requireAuth` / `requireRole` / `requirePerm` 的**唯一实现**
 * ============================================================================
 * 【职责】鉴权与授权中间件：JWT 校验、角色门、权限点、跨组织拦截 —— `requireAuth` / `requireRole` / `requirePerm` 的**唯一实现**
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自手写**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

import { runtimeMode } from '../runtime.js'
import jwt from 'jsonwebtoken'
import { getDb, DEFAULT_INDUSTRY, assertIndustry, getCurrentIndustry } from '../db/index.js'
import { fail, bizFail } from '../lib/http.js'
import { sessionCookieToken, needsCsrf, csrfValid, clearSessionCookies } from './session-transport.js'

// 密钥来源：`GML_JWT_SECRET` 优先，**兼容 `JWT_SECRET`**（A20）。
// 起因：`docker-compose.yml` 配的是 `JWT_SECRET`，而这里只读 `GML_JWT_SECRET` ——
// 容器里两个名字对不上，于是**线上一直在用内置的演示回退密钥**，
// 而这件事不会报任何错（有回退值就不会崩），只是所有人都知道密钥是什么。
// 修法是两边都认 + 把 compose 的名字统一过来：**改名不能只改一处**。
//
// 第二层（A20 残余）：**"读不到就回退"这件事本身还是同一条病根** ——
// 回退是**静默**的，于是"两个名字都没配对"与"我们换过密钥了"从外面看**一模一样**：
// 服务照常起来、照常签发令牌，密钥却是源码里公开可见的那一串。没有任何东西会告诉运维。
// OS EGP：runtime 模式缺省 production；它或 NODE_ENV 任一为生产即拒绝公开/缺失密钥。
// 只有显式 demo/test 且 NODE_ENV 非生产才允许回退，并记录警告。
// 密钥姿态为纯函数，实际启动闸门由 server/index.js 在监听之前调用。
export const DEMO_JWT_SECRET = 'gml-supply-chain-demo-secret-2026'

/**
 * **公开已知**的密钥值：源码里、`docker-compose.yml` 的兜底值里、文档里就能查到。
 *
 * 为什么只判"设没设"不够（A20 残余②）：把 compose 的默认值原样带进生产，
 * 与"没设"是**同一个后果**（密钥公开、任何人可伪造令牌），但姿态会报 `ok`、
 * 一条警告都没有 —— 于是"我们换过密钥了"与"我们一直在用公开值"从外面看一模一样。
 * `'undefined'` / `'null'` 是模板没解析出来时的常见残留（`${GML_JWT_SECRET}` 变量名写错、
 * CI 里引用了不存在的 secret），同样属于"看起来设了、其实谁都知道"。
 */
export const PUBLIC_DEFAULT_SECRETS = [
  DEMO_JWT_SECRET,
  'gml-demo-secret-change-me', // **旧**文档/旧版 docker-compose 里的示例默认值（仓库里已删，但外面抄过的要继续被拒）
  'undefined',
  'null'
]

/** 认得的 `NODE_ENV`。认不出来的**不猜**（见 `unknownNodeEnv`），但必须可见。 */
const KNOWN_NODE_ENVS = ['production', 'development', 'test']

/**
 * 归一化时剥掉的**不可见字符**：肉眼看不出来、却会被复制粘贴带进来
 * （从网页 / 文档里复制的密钥常带零宽空格或 BOM）。
 *
 * 为什么必须剥：`GML_JWT_SECRET='\u200b'` 在 `trim()` 之后**仍是非空** ⇒ 姿态报 `ok`、
 * 密钥就是"一个看不见的字符" —— 谁都猜得到、且一条警告都没有。
 * 普通空白（空格 / `\t` / `\n` / NBSP / 全角空格 / 行分隔）由 `trim()` 负责 ——
 * 这几个实测都能去掉，只有零宽这类 `trim()` 不管。
 */
const INVISIBLE_CHARS = /[\u00ad\u200b-\u200f\u2060\ufeff]/g

/** 归一化：**只用于分类判断**（判空 / 判是否公开默认值），**不用于取签名密钥** —— 见下面的说明。 */
const normalizeForClassify = (s) => String(s ?? '').replace(INVISIBLE_CHARS, '').trim()

/**
 * 当前密钥的「姿态」：从哪来、风险等级如何。**纯函数**（只看传进来的 env），因此可单测。
 *
 * `source`：`env`（真是自己设的）· `public-default`（设了，但设的是公开已知值）·
 *           `fallback`（没设，用内置演示密钥）
 * `level` ：`ok` / `warn` / `fatal`
 * `unknownNodeEnv`：NODE_ENV 非空但无法识别。仍发出警告；不会覆盖 runtime 模式的生产保护。
 *   GML_RUNTIME_MODE 缺省 production，因此漏写/误写 NODE_ENV 不能关闭生产密钥闸门。
 *
 * ⚠️ **分类用归一化值，取值用原始值** —— 这个区分不能省：
 *   · 分类（判空 / 判是否公开默认值）必须用**归一化**值，否则 `'   '`、`'\u200b'`
 *     会被当成"设了"，姿态报 `ok` 而密钥等于几个空白；
 *   · 取签名密钥必须用**原始**值：`'abc '`（尾随空格）虽少见，但它**是一个真实密钥** ——
 *     若拿归一化后的 `'abc'` 去签名，等于**静默换掉签名密钥 ⇒ 已签发的令牌全部失效**。
 *   所以只有分类结论是"空"（⇒ fallback）或"公开默认值"（⇒ 按没设处理）时，才不用原始值。
 *
 * ⚠️ 也不能写成 `String(env.GML_JWT_SECRET || env.JWT_SECRET).trim()`：`'   '` 是**真值**，
 *   `||` 会在归一化**之前**短路 ⇒ "一个空白的 GML_JWT_SECRET 把正常的 JWT_SECRET 也吞了"，
 *   然后静默回退到演示密钥。那正是本次要消灭的形态，别自己再造一个。
 *
 * **刻意不做密钥强度校验**（长度 / 字符集）：开发与 CI 里短密钥是常态（`GML_JWT_SECRET=x`），
 *   强度校验会误伤合法用法 —— 它是一条**独立的**闸门，不属于"姿态判断"这一层。
 *   这条是"没做且可见"，不是"忘了"。
 *
 * @returns {{source:'env'|'public-default'|'fallback', level:'ok'|'warn'|'fatal', secret:string, reason:string, nodeEnv:string, unknownNodeEnv:boolean}}
 */
export function jwtSecretPosture(env = process.env) {
  // 归一化：大小写 + 首尾空白（`'Production'` / `' production '` / `'production\n'`）。
  // 不归一化的后果是**静默降级**：安全网在打错一个字母时失效，而没有任何东西会说话。
  const nodeEnv = String(env.NODE_ENV ?? '').trim().toLowerCase()
  const isProd = runtimeMode(env) === 'production' || nodeEnv === 'production'
  const unknownNodeEnv = nodeEnv !== '' && !KNOWN_NODE_ENVS.includes(nodeEnv)
  const base = { nodeEnv, unknownNodeEnv }

  // 每个候选**各自**归一化（分类用），并保留各自的原始串（取值用）
  const rawNew = env.GML_JWT_SECRET == null ? '' : String(env.GML_JWT_SECRET)
  const rawLegacy = env.JWT_SECRET == null ? '' : String(env.JWT_SECRET)
  const namedNew = normalizeForClassify(rawNew)
  const namedLegacy = normalizeForClassify(rawLegacy)
  const from = namedNew ? 'GML_JWT_SECRET' : 'JWT_SECRET'
  const classified = namedNew || namedLegacy
  const raw = namedNew ? rawNew : rawLegacy

  if (classified) {
    if (PUBLIC_DEFAULT_SECRETS.includes(classified)) {
      return {
        ...base,
        source: 'public-default',
        level: isProd ? 'fatal' : 'warn',
        // 公开值按"没设"处理 ⇒ 用内置那串：拿一个全世界都知道的值去签，与"没设"没有区别，
        // 而且这样"签出来的令牌用的是哪把钥匙"只有一个答案，不必去追调用方当年填了什么。
        secret: DEMO_JWT_SECRET,
        reason:
          `${from} 的值是**公开已知值**（源码 / docker-compose.yml 默认值 / 文档里就能查到），` +
          '与"没设密钥"是同一个后果 —— 任何人都可以用它伪造令牌；按"没设"处理'
      }
    }
    // 正常路径：secret 用**原始**值（可能含调用方有意写的尾随空格等 —— 那是他的密钥）
    return { ...base, source: 'env', level: 'ok', secret: raw, reason: `从环境变量 ${from} 读取` }
  }

  return {
    ...base,
    source: 'fallback',
    level: isProd ? 'fatal' : 'warn',
    secret: DEMO_JWT_SECRET,
    reason: isProd
      ? '生产环境必须显式提供 GML_JWT_SECRET，不能用内置演示密钥'
      : '未提供 GML_JWT_SECRET/JWT_SECRET，回退到内置演示密钥（任何人都能用它伪造令牌）'
  }
}

// 常量与函数取自**同一处判定**，不允许两份定义各说各话。
// 对外可用性保持不变：`JWT_SECRET` 仍是模块加载期算好的字符串常量
// （消费者：server/index.js、middleware/mall-session.js、scripts/test-guards.mjs）。
const POSTURE = jwtSecretPosture()
export const JWT_SECRET = POSTURE.secret
export const JWT_EXPIRES = '12h'

/**
 * 启动时的落点：`fatal` ⇒ 抛（带 code，服务起不来）；`warn` ⇒ 打一条响亮的警告。
 *
 * 由 `server/index.js` 在 listen 之前显式调用，而**不是**放在本模块的加载期：
 * 加载 auth.js 的还有测试与脚本（test-guards / test-jwt-secret / …），
 * 它们并不是"在启动服务"，不该被这条闸门牵连着吵或崩。
 */
export function assertJwtSecretPosture(env = process.env, log = console) {
  const p = jwtSecretPosture(env)
  // 工具环境拼写警告与生产密钥判据分别报告；不能误称默认生产保护失效。
  if (p.unknownNodeEnv) {
    log.warn(
      `[安全警告] 无法识别的 NODE_ENV=${JSON.stringify(String(env.NODE_ENV))}。\n` +
        '          —— 密钥闸门：GML_RUNTIME_MODE（缺省 production）或 NODE_ENV 任一为 production 即强制生产规则。\n' +
        '          —— 请写成 production / development / test 之一。'
    )
  }
  if (p.level === 'fatal') {
    const e = new Error(`[安全] ${p.reason}。请设置环境变量 GML_JWT_SECRET（旧名字 JWT_SECRET 也认）后再启动。`)
    e.code = 'JWT_SECRET_MISSING_IN_PRODUCTION'
    throw e
  }
  if (p.level === 'warn') {
    // 尾注要跟 `source` 走：`public-default` 时密钥是**调用方自己设的那个公开值**，
    // 不是内置演示密钥 —— 一句话说错，运维就会去查错方向（"我们明明设了呀？"）。
    const tail =
      p.source === 'public-default'
        ? '          —— 你设的这个值是**公开已知**的（源码 / docker-compose.yml 默认值 / 文档里就有），等于没有密钥。\n'
        : '          —— 当前用的是内置演示密钥：任何人都可以用源码里那串公开的值伪造令牌。\n'
    log.warn(
      `[安全警告] ${p.reason}\n` +
        tail +
        '          —— 本地开发无所谓；只要这套服务会给别人用，就必须设置 GML_JWT_SECRET。'
    )
  }
  return p
}

export const ROLES = {
  admin: '系统管理员',
  boss: '老板/总经理',
  // 供应链主管：客户 2026-10-17 指定的演示角色（采购 + 库存 + 生产 + 质检 一人管）
  scm: '供应链主管',
  purchase: '采购主管',
  sales: '销售主管',
  warehouse: '仓储主管',
  finance: '财务',
  dealer: '经销商',
  store: '门店店长',
  viewer: '只读访客'
}

// ============================================================
// 两套凭据靠 **audience** 分开，验签各自要求自己的那一半
// ============================================================
// 为什么必须显式要求 audience：`jwt.verify(token, SECRET)` **不校 aud**。
// C 端令牌用的是**同一个签名密钥**（演示环境只有一个密钥），所以只要验签不要求 aud，
// 一张商城令牌就能当后台登录态用 —— 验收侧 §26/§27 独立复现：
// 商城 JWT 作 `Authorization: Bearer` 访问 `GET /api/docflow/overview` 与
// `GET /api/purchase/settlements` **都 200 并返回数据**，而 `requireWrite` 只挡
// `role === 'viewer'` ⇒ `role:'mall'` 连写闸都能过。
//
// 教训：**签的时候标了身份，验的时候也必须看这个标**。
// 只在签发侧加 `audience` 等于没加 —— "双向隔离"只要有一侧不看，就还是单向的。
export const BACK_AUD = 'gml-erp'

export function signToken(user, industry) {
  if (!Number.isSafeInteger(user.auth_version) || user.auth_version < 0) throw new Error('User session version is missing or invalid')
  return jwt.sign(
    {
      uid: user.id,
      auth_version: user.auth_version,
      username: user.username,
      role: user.role,
      name: user.name,
      dealer_id: user.dealer_id,
      store_id: user.store_id,
      org_id: user.org_id,
      industry: industry || user.industry || DEFAULT_INDUSTRY
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES, audience: BACK_AUD, algorithm: 'HS256' }
  )
}

/**
 * 这个异常是否表示「**令牌本身无效**」（签名错 / 格式错 / `aud` 不符 / 过期 / 未生效）。
 *
 * 为什么必须是**白名单**：调用方（`server/index.js` 的行业上下文中间件）只有两种选择 ——
 * 「忽略这个令牌、退回请求头 / 默认行业」或「拒绝该请求」。**只有这一类才允许忽略**。
 * 旧写法是**黑名单**（`if (e.code === INDUSTRY_CODE_INVALID) throw e`，其余一律吞掉当"令牌无效"）
 * ⇒ 任何**没被列出的意外异常**都会掉进 else 被吞 ⇒ 静默回落默认库（红队实测：令牌载荷
 * `industry:{toString:null}` 在构造错误时自身又抛 ⇒ 不是行业码错 ⇒ 被吞 ⇒ **200 读默认库**）。
 * "未知异常 ⇒ 静默落到某个库"正是本线要消灭的形态，所以判据反过来写：**默认拒绝，白名单才放行**。
 *
 * `jwt.JsonWebTokenError` 是 jsonwebtoken 的家族基类：`TokenExpiredError` / `NotBeforeError`
 * 都是它的子类，三者 `instanceof` 均成立。其它任何 Error（含我们自己的 `INDUSTRY_CODE_INVALID`）
 * 一律返回 `false` ⇒ 由调用方上抛。
 */
export function isTokenInvalid(e) {
  return e instanceof jwt.JsonWebTokenError
}

/**
 * 后台 JWT **只从 `Authorization: Bearer` 头取**（F13）。
 * 原来还接受 `?token=`：令牌会随 URL 进访问日志、浏览器历史、Referer 与代理日志，
 * 而这些地方没有任何一处当它是凭据来保护。前端从不拼 `?token=`（`src/api/client.ts` 只写头），
 * 所以这里没有兼容期；需要浏览器直接导航下载文件的场景另做短期一次性票据，不复用会话 JWT。
 */
export function bearerToken(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

/**
 * 后台会话令牌的取法（Y11，ADR-0036）：Bearer 头优先；**没有 Authorization 头**且
 * `GML_SESSION_TRANSPORT=cookie` 时才看会话 Cookie（bearer 模式从不读 Cookie）。
 * Authorization 头只要出现（即使无效）就不回落到 Cookie。`viaCookie` ⇒ 需要 CSRF 双提交。
 */
export function sessionToken(req) {
  const bearer = bearerToken(req)
  if (bearer) return { token: bearer, viaCookie: false }
  if (req.headers.authorization) return { token: null, viaCookie: false }
  const cookie = sessionCookieToken(req)
  return cookie ? { token: cookie, viaCookie: true } : { token: null, viaCookie: false }
}

export function requireAuth(req, res, next) {
  const { token, viaCookie } = sessionToken(req)
  if (!token) return fail(res, '未登录或登录已过期', 401, 401)
  // Cookie 里的会话一旦判死，顺带清掉两只 Cookie（HttpOnly 的那只前端自己清不掉）
  const dead = () => { if (viaCookie) clearSessionCookies(req, res) }
  try {
    // 只接受**后台** audience 的令牌：C 端（`gml-mall`）令牌在这里一律 401
    const p = jwt.verify(token, JWT_SECRET, { audience: BACK_AUD, algorithms: ['HS256'] })
    // Cookie 是环境凭据：写操作必须带与会话绑定的 CSRF 值（头 == Cookie == HMAC(JWT)）
    if (viaCookie && needsCsrf(req) && !csrfValid(req, token, JWT_SECRET)) {
      return bizFail(res, { status: 403, code: 'CSRF_TOKEN_INVALID', message: '缺少或无效的 CSRF 令牌，请刷新页面后重试' })
    }
    const revoked = () => { dead(); return bizFail(res, { status: 401, code: 'SESSION_REVOKED', message: '会话已失效，请重新登录' }) }
    if (!Number.isSafeInteger(p.uid) || p.uid <= 0 || !Number.isSafeInteger(p.auth_version) || p.auth_version < 0 ||
        !assertIndustry(p.industry) || p.industry !== getCurrentIndustry()) return revoked()
    // ------------------------------------------------------------------
    // A20：令牌只是"谁登录过"的**声明**，权限与可用性一律**以库为准**。
    //
    // 原来 `jwt.verify` 之后直接把 payload 当 `req.user` 用 —— 于是：
    //   · 用户被停用（`status` 改了）→ 旧令牌最长还能用 12 小时；
    //   · 角色被降级 → 旧令牌里仍是老角色，**权限跟着旧角色走**；
    //   · 用户被删除 → 令牌照样畅通（后面按 uid 查不到任何东西时才可能出错）。
    // 撤权"不即时生效"在权限系统里是很重的问题：**撤了权却还能用**，
    // 而且不报错 —— 管理员以为已经撤掉了。
    //
    // 因此每次请求都回库核对一次：拿库里的角色/归属覆盖 token 里的，
    // 不用 token 里那份"登录当时的快照"。这一条查询换来的是"撤权即时生效"。
    // ------------------------------------------------------------------
    const u = getDb()
      .prepare(
        'SELECT id, username, name, role, is_super, status, dealer_id, store_id, org_id, data_scope, auth_version FROM users WHERE id=?'
      )
      .get(p.uid)
    if (!u || u.status !== 'active' || u.auth_version !== p.auth_version) return revoked()
    if ((u.role === 'dealer' && !u.dealer_id) || (u.role === 'store' && !u.store_id)) {
      return fail(res, '当前账号未绑定业务主体，请联系管理员', 403, 'SUBJECT_BINDING_REQUIRED')
    }
    req.user = {
      ...p,
      uid: u.id,
      username: u.username,
      name: u.name,
      role: u.role,
      is_super: u.is_super,
      dealer_id: u.dealer_id,
      store_id: u.store_id,
      org_id: u.org_id,
      data_scope: u.data_scope
    }
    next()
  } catch {
    dead()
    return fail(res, '登录状态无效，请重新登录', 401, 401)
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return fail(res, '未登录', 401, 401)
    if (req.user.role === 'admin') return next()
    // AF10（Codex 审计 high）：旧闸只比对主角色名；主角色已停用时同样不放行（与 permContext 同一条 active-only 规则）
    if (!isRoleActive(getDb(), req.user.role)) {
      return fail(res, `当前角色「${ROLES[req.user.role] || req.user.role}」已停用，无此操作权限`, 403, 403)
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return fail(res, `当前角色「${ROLES[req.user.role] || req.user.role}」无此操作权限`, 403, 403)
    }
    next()
  }
}

export function requireWrite(req, res, next) {
  if (!req.user) return fail(res, '未登录', 401, 401)
  // 纵深防御：写闸要能**自己**识别出"这不是后台身份"，而不是指望上游一定挂过 requireAuth。
  // 原来的写法只挡 `role === 'viewer'` —— 于是任何"新出现的"非后台角色都自动获得写权限
  // （C 端 `mall` 就是这样过的闸）。改成**后台角色白名单**：不在表里的一律拒写。
  // AF10：账号的角色一个 active 的都没有（主角色与附加角色全停用）⇒ 拒写；admin / 超管不受角色表约束
  if (req.user.role !== 'admin' && !splitRolesByStatus(getDb(), req.user.uid, req.user.role).active.length) {
    return fail(res, '当前账号的角色已全部停用，不能执行写操作', 403, 403)
  }
  if (!Object.prototype.hasOwnProperty.call(ROLES, req.user.role) || req.user.role === 'viewer') {
    return fail(
      res,
      req.user.role === 'viewer' ? '只读访客不能执行写操作' : '当前凭据不能执行写操作',
      403,
      403
    )
  }
  next()
}

// ============================================================
// 数据范围：列表 SQL 与详情判定必须同源
// ============================================================
// 为什么要把「范围」抽成一个谓词再派生两种用法：
//   原来的写法是「列表走 scopeFilter、详情手写 if」。两者各写一套，必然只改一处 ——
//   实测就是这样漏的：销售订单详情只手写了 dealer 分支，**store 分支缺失**，
//   于是门店 1 的账号能打开门店 4 的订单详情（列表里却看不到这张单）。
//   列表挡得住、详情挡不住，是这一类缺陷的固定形状；
//   只要"同一个判据有两个实现"，它就会再犯一次。所以只有 scopePairs 一处定义。

/** 当前用户的数据范围谓词：一组 { 字段, 取值 }，全部命中才可见。 */
export function scopePairs(req, { dealerField = 'dealer_id', storeField = 'store_id' } = {}) {
  const u = req.user || {}
  const out = []
  if (u.role === 'dealer') out.push({ field: dealerField, value: u.dealer_id || null })
  if (u.role === 'store') out.push({ field: storeField, value: u.store_id || null })
  return out
}

/** 列表用：把 scopePairs 翻译成 SQL 片段（前导 AND，便于直接拼接）。 */
export function scopeFilter(req, alias = 't') {
  const pairs = scopePairs(req)
  if (!pairs.length) return { sql: '', params: [] }
  return {
    sql: pairs.map((p) => ` AND ${alias}.${p.field} = ? `).join(''),
    params: pairs.map((p) => p.value)
  }
}

const SCOPE_FIELD_LABEL = { dealer_id: '经销商', store_id: '门店' }

/**
 * 详情/单条读取用：与 scopeFilter 同一份规则，在 JS 侧判定。
 * 用法：const d = assertCanRead(req, order); if (!d.ok) return fail(res, d.message, d.status)
 * 返回而不是直接抛/写 res —— 调用方才知道该用哪个返回体与文案。
 */
export function assertCanRead(req, row, opts = {}) {
  if (!row) return { ok: false, status: 404, message: '记录不存在' }
  for (const p of scopePairs(req, opts)) {
    if (p.value == null || row[p.field] !== p.value) {
      return { ok: false, status: 403, message: `无权查看其他${SCOPE_FIELD_LABEL[p.field] || '主体'}的单据` }
    }
  }
  return { ok: true }
}

/** 外部主体（经销商 / 门店）——它们只该看到"自己的"往来单据，看不到内部单据。 */
export function isExternalUser(req) {
  const role = (req.user || {}).role
  return role === 'dealer' || role === 'store'
}

/**
 * 属于「内部业务域」的模块码。
 *
 * **唯一出处**（原来只写在 `routes/docflow.js` 里，是一个模块级 const）。
 * 批次 T 把它提到这里：审批提交入口也要用同一条判定，而在第二个文件里再抄一份，
 * 就是"同一份判据有两个实现"—— 改一处忘一处时，表现是"某个入口对外部主体开口子"。
 * 用途：`INTERNAL_MODULES.has(type.module) && isExternalUser(req)` ⇒ 拒绝。
 */
export const INTERNAL_MODULES = new Set(['purchase', 'inventory', 'produce', 'outsource', 'quality', 'finance'])

/**
 * 内部单据（采购、成本、内部调拨…）默认对外部主体**不可见**。
 * 注意：这里不合并进 scopeFilter —— 外部主体读自己那部分销售/订货数据是对的，
 * 但读采购单在任何范围下都不对。范围管"看哪些行"，这条管"这类单能不能看"。
 */
export function requireInternal(label = '内部单据') {
  return (req, res, next) => {
    if (!req.user) return fail(res, '未登录', 401, 401)
    if (isExternalUser(req)) {
      return fail(res, `当前角色「${ROLES[req.user.role] || req.user.role}」无权查看${label}`, 403, 403)
    }
    next()
  }
}

// ============================================================
// 金额 / 数量入参校验（唯一出处）
// ============================================================
// 为什么必须收敛到一处：
//   价格可以来自请求体。采购单传 `price = -5`，服务端把 -5 原样写进
//   `purchase_orders.total_amount`，返回 200 —— 一张**负金额的采购单**就此成立，
//   而账龄、成本、报表全都建立在这个负数上，全链路没有一处会报错。
//   负数不是"不可能"，是"没人拦"。校验器只有一份，才谈得上"每个入口都拦"。
const NUM_DECIMALS = { amount: 2, qty: 4 }

/**
 * 校验一个数值入参。
 * @returns {{ok:true, value:number|null}|{ok:false, message:string}}
 *   value 为 null 表示「未传」且非必填（调用方自行决定兜底值）。
 */
export function numField(v, opts = {}) {
  const {
    name = '数值',
    min = 0,
    positive = false,
    max = Number.MAX_SAFE_INTEGER,
    decimals = NUM_DECIMALS.amount,
    required = false
  } = opts
  const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
  if (empty) {
    if (required) return { ok: false, message: `${name}不能为空` }
    return { ok: true, value: null }
  }
  if (typeof v === 'boolean' || Array.isArray(v) || (typeof v === 'object' && v !== null)) {
    return { ok: false, message: `${name}必须是数字（收到 ${typeof v}）` }
  }
  // 只接受十进制字面量：Number('5abc') = NaN 会被下面拦掉，
  // 但 '0x10' / '1e3' 这类会被 Number 悄悄接受，先做形状检查再转数。
  if (typeof v === 'string' && !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v.trim())) {
    return { ok: false, message: `${name}必须是有效数字（收到「${v}」）` }
  }
  const n = typeof v === 'number' ? v : Number(v.trim())
  if (!Number.isFinite(n)) return { ok: false, message: `${name}必须是有效数字（收到「${v}」）` }
  if (positive && !(n > 0)) return { ok: false, message: `${name}必须大于 0` }
  if (n < min) return { ok: false, message: `${name}不能小于 ${min}（收到 ${n}）` }
  if (n > max) return { ok: false, message: `${name}超出允许上限 ${max}（收到 ${n}）` }
  const scale = 10 ** decimals
  if (Math.abs(n * scale - Math.round(n * scale)) > 1e-6) {
    return { ok: false, message: `${name}最多保留 ${decimals} 位小数（收到 ${n}）` }
  }
  return { ok: true, value: Math.round(n * scale) / scale }
}

/** 金额：非负、最多 2 位小数 */
export const numAmount = (v, name, extra = {}) => numField(v, { name, min: 0, decimals: NUM_DECIMALS.amount, ...extra })
/** 数量：必须大于 0、最多 4 位小数 */
export const numQty = (v, name, extra = {}) => numField(v, { name, positive: true, decimals: NUM_DECIMALS.qty, ...extra })

export function currentUser(req) {
  const u = req.user || {}
  const row = u.uid ? getDb().prepare('SELECT id, username, name, role, dept FROM users WHERE id=?').get(u.uid) : null
  return row ? { ...row, ...u } : u
}

// ============================================================
// 模块 05：权限点校验与组织数据范围
// ============================================================
// 设计：权限两轴正交 —— 功能权限（看不看得到这个功能）与数据权限（看得到谁的数据）。
//       两轴分开，避免「有菜单但看不到数据」或「看得到数据但动不了」。
//       全部向下兼容：旧 requireRole(...) 继续可用，新代码用 requirePerm(...)。

/** 停用角色提示码（登录 / me / my-scope 的 `notice_code`；成功响应里的提示，不是失败码，所以不进 bizFail） */
export const ROLE_INACTIVE_NOTICE = 'ROLE_INACTIVE_NOTICE'

/** 账号被授予的全部角色码：user_roles 并上主角色 users.role（去重，不看角色状态） */
function grantedRoleCodes(db, userId, primary) {
  const roles = userId ? db.prepare('SELECT role_code FROM user_roles WHERE user_id=?').all(userId).map((r) => r.role_code) : []
  if (primary && !roles.includes(primary)) roles.push(primary)
  return roles
}

/**
 * 账号的角色拆成 { active, inactive }（ADR-0051 补充 3）：有效权限**只合并 `roles.status='active'`** 的角色，
 * 主角色也不例外；库里没有该角色行的码按停用处理（`role_permissions` 对 roles 有外键，本来也不会有权限点）。
 * 每次回库查，没有缓存——角色状态一改，下一次请求（旧令牌也一样）就按新状态判。
 */
export function splitRolesByStatus(db, userId, primary) {
  const granted = grantedRoleCodes(db, userId, primary)
  if (!granted.length) return { active: [], inactive: [] }
  const ph = granted.map(() => '?').join(',')
  const live = new Set(db.prepare(`SELECT code FROM roles WHERE status='active' AND code IN (${ph})`).all(...granted).map((r) => r.code))
  return { active: granted.filter((c) => live.has(c)), inactive: granted.filter((c) => !live.has(c)).sort() }
}

/** 单个角色码是否 active（旧 requireRole 闸用；库里没有该行按停用） */
function isRoleActive(db, code) {
  return !!db.prepare("SELECT 1 FROM roles WHERE code=? AND status='active'").get(code)
}

/** 某角色集合的权限点并集 */
function permsOfRoles(db, roles) {
  if (!roles.length) return []
  const ph = roles.map(() => '?').join(',')
  return db.prepare(`SELECT DISTINCT perm_code AS code FROM role_permissions WHERE role_code IN (${ph})`).all(...roles).map((r) => r.code)
}

/** 取某用户的权限点集合（走 user_roles，支持一人多角色；admin 超级管理员全开；只计 active 角色） */
export function userPermissions(db, userId, role) {
  const row = db.prepare('SELECT is_super, role FROM users WHERE id=?').get(userId)
  if (row?.is_super || row?.role === 'admin') {
    return db.prepare('SELECT code FROM permissions').all().map((r) => r.code)
  }
  return permsOfRoles(db, splitRolesByStatus(db, userId, role).active)
}

/**
 * 「这个人有哪些权限点」的**唯一出处**。
 *
 * 为什么必须收敛：同一条判据一旦有两个实现，就只会改一处。
 *   `requirePerm` 原来自己写了一段"查角色 → 查 role_permissions"；
 *   枢纽流转入口（A01）又要一次同样的判定。如果各写各的，
 *   将来"一人多角色"或"admin 全开"的口径只会在一侧更新 ——
 *   表现是「同一个按钮，列表页点得动、详情页点不动」。
 *
 * AF10（ADR-0051 补充 3）：只合并 `roles.status='active'` 的角色（主角色也算）；账号因此一个权限都没有时
 * 返回空集合，所有权限门照常拒绝（与"无角色"同一出口）。
 *
 * @returns {{ perms: Set<string>|null, isSuper: boolean }} isSuper=true 时 perms 为 null（全开）
 */
export function permContext(db, user) {
  const u = user || {}
  const row = u.uid ? db.prepare('SELECT is_super, role FROM users WHERE id=?').get(u.uid) : null
  if (row?.is_super || row?.role === 'admin' || u.role === 'admin') {
    return { perms: null, isSuper: true }
  }
  return { perms: new Set(permsOfRoles(db, splitRolesByStatus(db, u.uid, u.role).active)), isSuper: false }
}

/**
 * 登录 / me / my-scope 共用的停用角色披露：只含**调用者自己**被授予且已停用的角色码。
 * AH10：`primary_role_inactive` 标出"主角色本身被停用"（此时账号的角色默认数据范围为空，必须由管理员重新指派主角色），
 * 文案点明"联系管理员 / 重新指派主角色"；只停用了附加角色时仍是通用提示。管理员 / 超管的权限不看角色状态，不标主角色停用。
 */
export function roleInactiveNotice(db, userId, primary) {
  const { inactive } = splitRolesByStatus(db, userId, primary)
  const row = userId ? db.prepare('SELECT is_super FROM users WHERE id=?').get(userId) : null
  const primaryInactive = !!primary && primary !== 'admin' && !row?.is_super && inactive.includes(primary)
  let message = null
  if (primaryInactive) {
    const name = db.prepare('SELECT name FROM roles WHERE code=?').get(primary)?.name || primary
    message = `你的主角色「${name}」已停用：其权限与默认数据范围不再生效，数据范围可能为空。请联系管理员重新指派主角色。`
  } else if (inactive.length) {
    message = '你的账号被授予的部分角色已停用，其权限不再生效；如需恢复请联系管理员。'
  }
  return {
    roles_inactive: inactive,
    primary_role_inactive: primaryInactive,
    notice_code: inactive.length ? ROLE_INACTIVE_NOTICE : null,
    notice_message: message
  }
}

/** 权限点是否命中（permContext 的配套判据；admin/超管恒真） */
export function hasPerm(ctx, code) {
  if (!ctx) return false
  if (ctx.isSuper) return true
  if (!code) return true
  const perms = ctx.perms || new Set()
  return perms.has(code) || perms.has('*')
}

/** 功能权限校验：任一命中即通过 */
export function requirePerm(...codes) {
  return (req, res, next) => {
    if (!req.user) return fail(res, '未登录', 401, 401)
    const ctx = permContext(getDb(), req.user)
    if (ctx.isSuper) return next()
    if (codes.length && codes.some((c) => hasPerm(ctx, c))) return next()
    return fail(res, `当前角色无此操作权限（需 ${codes.join(' 或 ')}）`, 403, 403)
  }
}

/**
 * 解析用户可访问的组织范围。
 *   all      全部数据（老板/财务/访客）
 *   subtree  本组织及其下级（区域/总部职能岗）
 *   org      仅本组织（店长）
 *   dealer   仅本经销商（经销商账号，走 dealer_id）
 *   self     仅本人
 */
export function resolveOrgScope(db, user) {
  const u = user || {}
  const row = u.uid
    ? db.prepare('SELECT org_id, data_scope, is_super, dealer_id, store_id FROM users WHERE id=?').get(u.uid)
    : null
  if (row?.is_super || u.role === 'admin') return { scope: 'all', orgIds: null, orgId: row?.org_id ?? null }

  // 用户级 data_scope 优先，其次角色默认
  // AG10（ADR-0051 补充 4）：停用的主角色不再提供默认范围，且**失败即收紧**：账号没有单独设置范围时落到空范围('none')，
  // 不落到 'self'（'self' 按所属组织过滤，可能比原先的 'dealer' 默认更宽）。库里没有该角色行时保持原行为。
  const roleRow = db.prepare('SELECT data_scope, status FROM roles WHERE code=?').get(u.role)
  const primaryOff = !!roleRow && roleRow.status !== 'active'
  const userScoped = !!(row?.data_scope && row.data_scope !== '')
  if (primaryOff && !userScoped) return { scope: 'none', orgIds: [], orgId: null }
  const roleScope = primaryOff ? undefined : roleRow?.data_scope
  const scope = userScoped ? row.data_scope : roleScope || 'self'
  const orgId = row?.org_id ?? u.org_id ?? null

  if (scope === 'all') return { scope, orgIds: null, orgId }
  if (scope === 'dealer') return { scope, orgIds: null, orgId, dealerId: row?.dealer_id ?? u.dealer_id ?? null }
  if (!orgId) return { scope: 'none', orgIds: [], orgId: null }

  const node = db.prepare('SELECT id, path FROM orgs WHERE id=?').get(orgId)
  if (scope === 'subtree' && node?.path) {
    const ids = db
      .prepare('SELECT id FROM orgs WHERE path LIKE ? OR id=?')
      .all(`${node.path}%`, orgId)
      .map((r) => r.id)
    return { scope, orgIds: ids, orgId }
  }
  return { scope, orgIds: [orgId], orgId }
}

/** 中间件：把组织数据范围挂到 req.orgScope（轻量、无 DB 写入） */
export function attachOrgScope(req, res, next) {
  try {
    req.orgScope = resolveOrgScope(getDb(), req.user)
  } catch {
    req.orgScope = { scope: 'none', orgIds: [] }
  }
  next()
}

/** Global aggregate endpoints are fail-closed until they implement ownership filtering. */
export function requireGlobalData(label = '全局数据') {
  return (req, res, next) => {
    if (!req.user) return fail(res, '未登录', 401, 401)
    const scope = resolveOrgScope(getDb(), req.user)
    if (scope.scope !== 'all') {
      return fail(res, `${label}仅向具有全部数据范围的授权账号开放；受限账号请使用按组织过滤的业务或MCP入口`, 403, 'GLOBAL_DATA_FORBIDDEN')
    }
    next()
  }
}

/** Organization SQL scope; an empty scope must never become an unrestricted query. */
export function orgScopeFilter(req, alias = 't', column = 'org_id') {
  const s = req.orgScope || { scope: 'all', orgIds: null }
  if (s.scope === 'all') return { sql: '', params: [] }
  if (s.scope === 'dealer') {
    if (!s.dealerId) return { sql: ' AND 1=0 ', params: [] }
    return { sql: ` AND ${alias}.dealer_id = ? `, params: [s.dealerId] }
  }
  if (s.scope === 'none') return { sql: ' AND 1=0 ', params: [] }
  if (!s.orgIds || !s.orgIds.length) return { sql: ' AND 1=0 ', params: [] }
  const ph = s.orgIds.map(() => '?').join(',')
  return { sql: ` AND ${alias}.${column} IN (${ph}) `, params: [...s.orgIds] }
}
