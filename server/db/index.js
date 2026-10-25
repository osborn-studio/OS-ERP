/**
 * ============================================================================
 * 文件标识：server/db/index.js ｜ 数据库连接与多行业切库：`INDUSTRIES` 定义、`AsyncLocalStorage` 载行业、`getDb()` 无参切库、行业码归一化
 * ============================================================================
 * 【职责】数据库连接与多行业切库：`INDUSTRIES` 定义、`AsyncLocalStorage` 载行业、`getDb()` 无参切库、行业码归一化
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自手写**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { runMigrations } from './migrations/runner.js'
import { runtimeMode, requireDataDirectory } from '../runtime.js'
import { classifyEmptyDatabase, assertDatabaseMode } from './runtime-policy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const ROOT_DIR = path.resolve(__dirname, '../..')
export const DATA_DIR = process.env.GML_DATA_DIR || path.join(ROOT_DIR, 'data')

// ============ 多行业（多版本）============
// 同一套表结构，按行业各自独立一份数据库文件；行业由登录时选择决定。
//
// ⚠️ `label` 是**界面上给客户看的名字**，`name` 是拼句子用的短名（`${name}行业`）。
//    两个字段都给齐，是因为界面上一会儿要"连锁餐饮版"（卡片标题），
//    一会儿要"连锁餐饮行业"（正文），只有一个字段时必然有一处读着别扭。
// ⚠️ 服装版**不再写"暂缓"**（客户 2026-10-17 口径：写"开发中"）。
//    "暂缓"给人的信号是"这个行业不做了"，而实际状态是"功能在补、演示可用"——
//    这两个信号对客户的决策完全不同，不能混用同一个词。
// `visible` = **是否在入口页 / 登录页展示**。它和"这个行业能不能用"是两件事：
//   · `visible: false` —— 前端不展示（客户 2026-10-17 口径："索性不要显示服装版了"）；
//   · 定义与库**全部保留** —— `normalizeIndustry('apparel')` 照样合法，接口/演示/自动化仍可用；
//     将来要放出来，只改这一个布尔值，**不需要动任何别的代码**。
// 为什么不做成"删掉 apparel"：删掉是不可逆的（迁移、数据、测试、脚本都得跟着改），
// 而客户说的是"现在不要显示" —— 将来一定会再要，删除是把未来的成本提前付掉。
export const INDUSTRIES = {
  cosmetic: { code: 'cosmetic', name: '美妆连锁', label: '美妆连锁版', visible: true, db: 'gml_cosmetic.db' },
  food: { code: 'food', name: '连锁餐饮', label: '连锁餐饮版', visible: true, db: 'gml_food.db' },
  apparel: { code: 'apparel', name: '服装', label: '服装版（开发中）', visible: false, db: 'gml_apparel.db' }
}
export const DEFAULT_INDUSTRY = 'cosmetic'

// 行业码非法的**稳定业务码**：HTTP 响应体的 `error` / `detail.code`，
// CLI 与 MCP 也读同一个码（机器可判、文案可变）。
export const INDUSTRY_CODE_INVALID = 'INDUSTRY_CODE_INVALID'

// 合法判定用 `Object.hasOwn`，**不是** `INDUSTRIES[industry]`：
// 后者对 `'constructor'` / `'toString'` / `'__proto__'` 这几个原型链上的键会返回真值，
// 于是"不是行业码"的值会被当成合法，再一路落到 `INDUSTRIES[code].db === undefined`
// —— 那正是"判据本身漏了一类值"的形态。
const hasIndustry = (v) => typeof v === 'string' && Object.hasOwn(INDUSTRIES, v)

/**
 * 把**任意**（外部可控）取值安全地回显成一小段人话。
 *
 * 为什么必须单独一个函数（而不是直接 `${value}` / `String(value)`）：
 *   `{ toString: null }` / `Object.create(null)` 这类值 **`String()` 自己就抛 TypeError**
 *   （ToPrimitive 找不到可调用的 `toString`）。原来 `industryError` 里 `String(value)` 被求值**两次**
 *   （`message` 与 `detail.industry`），于是"构造这个错误"的过程**又抛一次** ⇒ `status` / `code`
 *   没来得及挂上 ⇒ 全局 errorHandler 按 **500** 处理、**没有业务码** ——
 *   调用方分不清"我传错了"还是"服务挂了"。而 `POST /api/auth/login {industry:{toString:null}}`
 *   **无需登录、外网可达**（`JSON.parse` 就能造出这种对象）。
 * 截断：红队实测 90KB 的非法值被原样回显（响应体 ≈2× 放大，低危但没必要）⇒ 只留前 64 字符。
 * **本函数保证不抛**（连 `Object.prototype.toString` 也兜一层）。
 */
const MAX_ECHO = 64
export function showValue(v) {
  let s
  try {
    s = typeof v === 'string' ? v : String(v)
  } catch {
    // 连 String() 都抛（toString 不可调用 / valueOf 抛错 / Proxy 陷阱）⇒ 退到不触发用户代码的描述
    try {
      s = Object.prototype.toString.call(v)
    } catch {
      s = '<不可回显的值>'
    }
  }
  return s.length > MAX_ECHO ? `${s.slice(0, MAX_ECHO)}…（共 ${s.length} 字符）` : s
}

/** 非法行业码的**唯一报错构造点**：400 + 人话 + 稳定码 + 候选清单。**本函数保证不抛。** */
export function industryError(value) {
  const allowed = Object.keys(INDUSTRIES)
  // 只求值一次（原来 `String(value)` 求值两次 ⇒ `{toString:null}` 在构造错误时又抛一次）
  const shown = showValue(value)
  const e = new Error(`行业码「${shown}」不是合法取值（可选：${allowed.join(' / ')}）`)
  e.status = 400
  e.code = INDUSTRY_CODE_INVALID
  e.detail = { industry: shown, allowed }
  return e
}

/**
 * 行业码的**唯一判据** —— 把「缺失」与「非法」拆成两条，这是本次修法的核心：
 *
 *   · 缺失（`undefined` / `null` / 空串） ⇒ 返回 `null`
 *     （由调用方按"用默认"处理 —— "头没带 = 用默认"是正当语义，必须保留）；
 *   · 合法（`INDUSTRIES` 里确有此键）    ⇒ 原样返回；
 *   · 给了但不是合法码                   ⇒ **抛**（绝**不**静默落到某个库）。
 *
 * 为什么"非法"必须响亮：`x-industry` 头 / 登录体 / 令牌载荷都是**外部可控**的，
 * 而行业决定后面读哪个库。旧写法把任何不认识的值静默归一成 `cosmetic`——
 * 于是"一个打错的行业码"会安静地读到美妆版的库，不报错、界面照常出数，
 * 跨租户串库看起来完全正常。**读错了库**是最难发现的一类错，所以这里宁可拒绝。
 *
 * 刻意**不做** trim / 大小写归一：`'Cosmetic'`（大小写）、`'cos metic'`（内部空白）一律算非法
 * —— "静默归一"正是本判据要消灭的形态，不能又在自己身上留一个。
 *
 * ⚠️ **首尾空白**这一格要分清"在哪一层"（与实测一致，别照着"想当然"改判据）：
 *   · **本函数（应用层）**：`assertIndustry(' cosmetic')` / `('cosmetic ')` 确实**抛**（它不 trim）；
 *   · **HTTP 头路径**：`x-industry: 'cosmetic '` 在到达本函数**之前**，首尾 OWS 已被
 *     **Node 的 HTTP 解析器**按 RFC 7230 剥掉 ⇒ 应用**看不到原文**，等价于 `'cosmetic'`（合法）。
 *     这是**传输层**的归一，不是本判据的归一（实测：raw socket 带尾随空格 ⇒ 200）；
 *   · **JSON 体路径**（登录体）：JSON 不剥空白 ⇒ `'cosmetic '` 到本函数仍是原样 ⇒ **抛（400）**。
 *   所以"首尾空白"在头路径上**不可观测**。**不许为了让它"看起来被拦"去加 `trim`** ——
 *   剥了空白只会变回**同一个**码、不会变成**另一个**码（本就不构成跨租户洞），
 *   加 trim 只会新增一个"我以为我拦住了"的假面。
 */
export function assertIndustry(industry) {
  if (industry === undefined || industry === null || industry === '') return null
  if (hasIndustry(industry)) return industry
  throw industryError(industry)
}

/**
 * 缺失 ⇒ `DEFAULT_INDUSTRY`；合法 ⇒ 原码；非法 ⇒ **抛**。
 * 三个入口（`runWithIndustry` / `dbPathFor` / `getDbFor`）共用它，保证"同一件事只有一处实现"。
 */
export function normalizeIndustry(industry) {
  const code = assertIndustry(industry)
  return code === null ? DEFAULT_INDUSTRY : code
}

// 以异步上下文（AsyncLocalStorage）承载「当前请求所属行业」，
// 这样 getDb() 保持无参调用，所有既有路由无需改动即可自动落到对应行业的库。
const als = new AsyncLocalStorage()
const pools = new Map()

export function runWithIndustry(industry, fn) {
  return als.run({ industry: normalizeIndustry(industry) }, fn)
}

export function getCurrentIndustry() {
  return als.getStore()?.industry || DEFAULT_INDUSTRY
}

export function dbPathFor(industry) {
  const code = normalizeIndustry(industry)
  if (process.env.GML_DB && code === DEFAULT_INDUSTRY) return process.env.GML_DB
  return path.join(DATA_DIR, INDUSTRIES[code].db)
}

/**
 * 脚本用的**显式数据目录判据**（ADR-0019）—— 与 `scripts/regress-all.mjs` 的闸门同一口径：
 *   · 缺 `GML_DATA_DIR` / 非绝对路径 ⇒ `DATA_DIRECTORY_REQUIRED`（复用 ADR-0001 的判据）；
 *   · 指向仓库 `data/`（按物理路径比较，symlink 也认）⇒ `DATA_DIRECTORY_IS_REPOSITORY`。
 * 为什么放在这里而不是各脚本自己写：`DATA_DIR` 的兜底 `<repo>/data` 是模块加载期算好的，
 * 任何脚本只要"自己拼 `data/gml_*.db`"就绕开了 ADR-0001 —— `check-mcp-coverage` 曾经就是这样。
 * 调用方通过后再用 `dbPathFor()` 取库文件，**不要**自己拼文件名。
 */
export function requireExplicitDataDir(env = process.env) {
  const dir = requireDataDirectory(env)
  const physical = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
  if (physical(dir) === physical(path.join(ROOT_DIR, 'data'))) {
    throw Object.assign(new Error(`GML_DATA_DIR 指向仓库 data/（${dir}）；请复制到隔离目录后再跑`), { code: 'DATA_DIRECTORY_IS_REPOSITORY' })
  }
  return dir
}

/**
 * `busy_timeout` 毫秒数（ADR-0035）。缺省 5000（沿用旧值）；`GML_SQLITE_BUSY_MS` 必须是 0..300000 的十进制整数，
 * 其它值抛 `SQLITE_BUSY_MS_INVALID`（拼错的配置宁可启动失败，也不要静默回落成别的等待时间）。
 */
export const DEFAULT_SQLITE_BUSY_MS = 5000
export function sqliteBusyMs(env = process.env) {
  const raw = env.GML_SQLITE_BUSY_MS
  if (raw === undefined || raw === '') return DEFAULT_SQLITE_BUSY_MS
  if (!/^\d+$/.test(raw) || Number(raw) > 300000) {
    throw Object.assign(new Error(`GML_SQLITE_BUSY_MS 必须是 0..300000 的整数毫秒，收到「${showValue(raw)}」`), { code: 'SQLITE_BUSY_MS_INVALID' })
  }
  return Number(raw)
}

/**
 * AH3：启动期一次 SQLite 优化开关（默认关）。`GML_SQLITE_OPTIMIZE_ON_BOOT` 只认 1 / true（开）与 0 / false / 空（关），其它值抛
 * `SQLITE_OPTIMIZE_ON_BOOT_INVALID`（拼错的开关宁可启动失败）。
 * 打开它会让 SQLite 在库里写 `sqlite_stat1`（它认为有用时），从而改变规划器的前提——explain-audit 的断言与计划指纹快照都以"没有统计"为前提，
 * 所以默认关；开之前先读 docs/operations/query-planner.md 2e。整个仓库只有这一处允许该语句（analyze-scan 的精确豁免）。
 */
export function sqliteOptimizeOnBoot(env = process.env) {
  const raw = env.GML_SQLITE_OPTIMIZE_ON_BOOT
  if (raw === undefined || raw === '' || raw === '0' || raw === 'false') return false
  if (raw === '1' || raw === 'true') return true
  throw Object.assign(new Error(`GML_SQLITE_OPTIMIZE_ON_BOOT 只接受 1 / true / 0 / false / 空，收到「${showValue(raw)}」`), { code: 'SQLITE_OPTIMIZE_ON_BOOT_INVALID' })
}

/** 每个库连接建立时调用一次（连接池里只建一次）；失败只告警不影响启动 */
function optimizeOnBoot(db, code) {
  const t0 = process.hrtime.bigint()
  try {
    db.pragma('optimize')
    console.log(`[sqlite-optimize-on-boot] ${code}: done in ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)} ms (GML_SQLITE_OPTIMIZE_ON_BOOT is on; planner statistics may now exist)`)
  } catch (e) {
    console.warn(`[sqlite-optimize-on-boot] ${code}: skipped (${e.code || 'error'})`)
  }
}

export function getDbFor(industry) {
  const mode = runtimeMode()
  if (path.resolve(requireDataDirectory()) !== path.resolve(DATA_DIR)) {
    throw Object.assign(new Error('Changing GML_DATA_DIR after database module import is forbidden'), { code: 'DATA_DIRECTORY_CHANGED' })
  }
  const code = normalizeIndustry(industry)
  if (pools.has(code)) {
    const db = pools.get(code)
    assertDatabaseMode(db, mode)
    return db
  }
  const optimize = sqliteOptimizeOnBoot() // 非法值在打开库之前就抛
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const db = new Database(dbPathFor(code))
  try {
    classifyEmptyDatabase(db, mode)
  } catch (error) {
    db.close()
    throw error
  }
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // POS / 商城并发写：遇锁等待（默认 5s，`GML_SQLITE_BUSY_MS` 可调）而不是立刻抛 SQLITE_BUSY
  db.pragma(`busy_timeout = ${sqliteBusyMs()}`)
  if (optimize) optimizeOnBoot(db, code)
  pools.set(code, db)
  return db
}

/** 当前上下文（或默认行业）的数据库 */
export function getDb() {
  return getDbFor(getCurrentIndustry())
}

export function initSchemaFor(industry, { log } = {}) {
  const db = getDbFor(industry)
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  db.exec(schema)
  // 增量迁移（orgs / 库存五维 / 事务字典 …）：幂等，已执行过的自动跳过
  runMigrations(db, { log })
  return db
}

export function initSchema() {
  return initSchemaFor(getCurrentIndustry())
}

export function tableCount(table, industry) {
  const db = getDbFor(industry || getCurrentIndustry())
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c
  } catch {
    return 0
  }
}

export function isSeeded(industry) {
  return tableCount('products', industry) > 0
}

/** 向后兼容：默认行业的库文件路径 */
export const DB_PATH = dbPathFor(DEFAULT_INDUSTRY)

export function industryList() {
  return Object.values(INDUSTRIES).map((x) => ({ code: x.code, name: x.name, label: x.label }))
}

export default {
  getDb, getDbFor, initSchema, initSchemaFor, DB_PATH, DATA_DIR,
  INDUSTRIES, DEFAULT_INDUSTRY, isSeeded, tableCount,
  runWithIndustry, getCurrentIndustry, dbPathFor, industryList, requireExplicitDataDir,
  assertIndustry, normalizeIndustry, industryError, INDUSTRY_CODE_INVALID, showValue, sqliteBusyMs, sqliteOptimizeOnBoot
}
