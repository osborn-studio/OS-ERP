/**
 * ============================================================================
 * 文件标识：server/lib/db-ttl-cache.js ｜ 按数据库连接隔离的短时结果缓存：TTL 之内命中，任何写入（本进程或其它进程）立即失效（AA5，ADR-0044）
 * ============================================================================
 * 【职责】给"同一数据库、同一份与调用者无关的聚合结果"（目前只有总部看板汇总）省掉重复的整表聚合。
 *   不是通用缓存：值必须只由数据库内容与当前日期决定，不得含用户 / 组织范围相关的内容（看板路由本身要求全局数据范围）。
 * 【失效判据（命中必须同时满足）】
 *   ① 没过期：距写入不超过 `ttlMs`（默认 30 s，`GML_DASHBOARD_CACHE_MS` 可调，0 = 关闭缓存）；
 *   ② 本连接没有任何写入：`SELECT total_changes()`（本连接自打开以来改动的行数，含触发器、含已回滚的）与写入时相同；
 *   ③ 没有其它连接提交过：`PRAGMA data_version`（别的连接 / 进程提交后才变）与写入时相同；
 *   ④ 本地日期没变：结果里含 `date('now','localtime')` 相关的"今日 / 本月"，跨零点不得继续用昨天的结果。
 *   ②③ 是"相关写入"的**超集**（任何表的任何写入都会让它失效，包括审计 / 登录时间戳），宁可多失效也不漏——
 *   不靠各个写路由手工调用失效，所以新增写路径不会让看板读到旧数据。代价是写入频繁的实例命中率低（行为退回到每次计算）。
 * 【隔离】缓存挂在 `WeakMap<Database, …>` 上，每个行业库一个连接，互不串；连接关闭 / 回收时随之释放。
 * ============================================================================
 */
import { localDate } from './dates.js'

const DEFAULT_TTL_MS = 30000
const state = new WeakMap() // db -> { stmt, pragmaOk, entry }

export function cacheTtlMs(env = process.env) {
  const raw = env.GML_DASHBOARD_CACHE_MS
  if (raw === undefined || raw === '') return DEFAULT_TTL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TTL_MS
}

function slot(db) {
  let s = state.get(db)
  if (!s) { s = { stmt: db.prepare('SELECT total_changes() AS c'), entry: null }; state.set(db, s) }
  return s
}

function versionKey(db, s) {
  return `${localDate()}|${s.stmt.get().c}|${db.pragma('data_version', { simple: true })}`
}

/** 取缓存或计算；`compute` 抛错时不缓存。返回 `{ value, hit }`。 */
export function cachedForDb(db, compute, { ttlMs = cacheTtlMs(), now = Date.now } = {}) {
  if (!(ttlMs > 0)) return { value: compute(), hit: false }
  const s = slot(db)
  const key = versionKey(db, s)
  const t = now()
  if (s.entry && s.entry.key === key && t - s.entry.at <= ttlMs) return { value: s.entry.value, hit: true }
  s.entry = null
  const value = compute()
  // 计算期间如果本连接又写了东西（不应发生：处理器是同步只读的），key 以计算后为准重取，保守起见不缓存
  const after = versionKey(db, s)
  if (after === key) s.entry = { key, at: t, value }
  return { value, hit: false }
}

/** 显式失效（测试 / 运维钩子）；不传 db 无效，因为缓存按连接隔离。 */
export function invalidateForDb(db) {
  const s = state.get(db)
  if (s) s.entry = null
}
