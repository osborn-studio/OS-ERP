/**
 * ============================================================================
 * 文件标识：src/utils/cache-stamp.ts ｜ 看板“数据截至 hh:mm:ss（缓存 30 s）”文案选择器（纯函数）
 * ============================================================================
 * 【职责】由各缓存接口返回的 `{ cachedAt, ttlMs }` 得到页面要显示的一行字。多个接口取**最早**的 cachedAt（页面上最旧的那份数据），
 *   所以“数据截至”从不比任何一块数据更新；任何一个接口没有戳（或 cachedAt 不是合法时间）就不显示，宁可不写也不写错。
 * 【不变量】只读服务端给的 cached_at，不用浏览器当前时间冒充数据时间；ttlMs = 0 显示“未缓存”，不写“缓存 0 s”。
 * ============================================================================
 */
export type CacheStamp = { cachedAt: string; ttlMs: number }
export type StampView = { text: string; cachedAt: string; ttlMs: number }

const pad = (n: number) => String(n).padStart(2, '0')
/** 本地时区的 hh:mm:ss（24 小时制，不依赖 Intl 的区域差异） */
export function formatClock(iso: string): string | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function selectCacheStamp(stamps: (CacheStamp | null | undefined)[]): StampView | null {
  if (stamps.length === 0 || stamps.some((s) => !s || formatClock(s.cachedAt) === null)) return null
  const list = stamps as CacheStamp[]
  const oldest = list.reduce((a, b) => (Date.parse(b.cachedAt) < Date.parse(a.cachedAt) ? b : a))
  const ttlMs = Math.max(...list.map((s) => s.ttlMs))
  const ttl = ttlMs > 0 ? `缓存 ${Math.round(ttlMs / 1000)} s` : '未缓存'
  return { text: `数据截至 ${formatClock(oldest.cachedAt)}（${ttl}）`, cachedAt: oldest.cachedAt, ttlMs }
}
