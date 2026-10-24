/**
 * ============================================================================
 * 文件标识：server/lib/db-ttl-cache.js ｜ 按数据库连接隔离的短时结果缓存：TTL 之内命中，任何写入（本进程或其它进程）立即失效（AA5，ADR-0044）
 * ============================================================================
 * 【职责】给"同一数据库、同一份与调用者无关的聚合结果"（总部看板汇总，AB2 起还有 trend / top / todos / inventory-dist）省掉重复的整表聚合。
 *   不是通用缓存：值必须只由数据库内容与当前日期决定，不得含用户 / 组织范围相关的内容（看板路由本身要求全局数据范围）。
 * 【失效判据（命中必须同时满足）】
 *   ① 没过期：距写入不超过 `ttlMs`（默认 30 s，`GML_DASHBOARD_CACHE_MS` 可调，0 = 关闭缓存）；
 *   ② 本连接没有任何写入：`SELECT total_changes()`（本连接自打开以来改动的行数，含触发器、含已回滚的）与写入时相同；
 *   ③ 没有其它连接提交过：`PRAGMA data_version`（别的连接 / 进程提交后才变）与写入时相同；
 *   ④ 本地日期没变：结果里含 `date('now','localtime')` 相关的"今日 / 本月"，跨零点不得继续用昨天的结果。
 *   ②③ 是"相关写入"的**超集**（任何表的任何写入都会让它失效，包括审计 / 登录时间戳），宁可多失效也不漏——
 *   不靠各个写路由手工调用失效，所以新增写路径不会让看板读到旧数据。代价是写入频繁的实例命中率低（行为退回到每次计算）。
 * 【键】同一连接可按 `key`（如 `trend:30`）缓存多份互不相同的结果；每个连接最多 32 个键，超出淘汰最久未用；失效判据对所有键相同。
 * 【隔离】缓存挂在 `WeakMap<Database, …>` 上，每个行业库一个连接，互不串；连接关闭 / 回收时随之释放。
 * ============================================================================
 */
import { localDate } from './dates.js'
import { incCounter } from './process-counters.js'

const DEFAULT_TTL_MS = 30000
const MAX_KEYS = 32 // 每个连接最多缓存的键数（调用者可控的 ?days 不得撑爆内存）；超出按最近最少使用淘汰
const DEFAULT_KEY = '' // AA5 的调用方式（不传 key）仍落在这一个条目上
const state = new WeakMap() // db -> { stmt, entries: Map<key, { key: versionKey, at, value }> }（Map 的插入顺序 = 最近使用顺序）

export function cacheTtlMs(env = process.env) {
  const raw = env.GML_DASHBOARD_CACHE_MS
  if (raw === undefined || raw === '') return DEFAULT_TTL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TTL_MS
}

function slot(db) {
  let s = state.get(db)
  if (!s) { s = { stmt: db.prepare('SELECT total_changes() AS c'), entries: new Map() }; state.set(db, s) }
  return s
}

function versionKey(db, s) {
  return `${localDate()}|${s.stmt.get().c}|${db.pragma('data_version', { simple: true })}`
}

/**
 * 取缓存或计算；`compute` 抛错时不缓存。返回 `{ value, hit }`。
 * `key`：同一连接上互不相同的结果（如 `trend:30`、`top:7`）用不同的键；失效判据（②③④）对所有键一视同仁。
 * 键必须只由请求里与调用者无关的参数构成（路由已要求全局数据范围）；依赖调用者范围的结果不得使用本缓存。
 */
export function cachedForDb(db, compute, { ttlMs = cacheTtlMs(), now = Date.now, key = DEFAULT_KEY } = {}) {
  if (!(ttlMs > 0)) return { value: compute(), hit: false }
  const s = slot(db)
  const ver = versionKey(db, s)
  const t = now()
  const hitEntry = s.entries.get(key)
  if (hitEntry && hitEntry.key === ver && t - hitEntry.at <= ttlMs) {
    s.entries.delete(key); s.entries.set(key, hitEntry) // 标记为最近使用
    incCounter('dashboard_cache_total', 'hit')
    return { value: hitEntry.value, hit: true }
  }
  incCounter('dashboard_cache_total', 'miss')
  s.entries.delete(key)
  const value = compute()
  // 计算期间如果本连接又写了东西（不应发生：处理器是同步只读的），版本以计算后为准重取，保守起见不缓存
  const after = versionKey(db, s)
  if (after === ver) {
    s.entries.set(key, { key: ver, at: t, value })
    while (s.entries.size > MAX_KEYS) s.entries.delete(s.entries.keys().next().value)
  }
  return { value, hit: false }
}

/** 显式失效（测试 / 运维钩子）：清空该连接上的全部键；不传 db 无效，因为缓存按连接隔离。 */
export function invalidateForDb(db) {
  const s = state.get(db)
  if (s) s.entries.clear()
}

/** 该连接当前缓存的键数（测试 / 诊断用）。 */
export function cacheKeyCount(db) {
  return state.get(db)?.entries.size ?? 0
}
