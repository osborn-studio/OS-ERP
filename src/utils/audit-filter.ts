/**
 * ============================================================================
 * 文件标识：src/utils/audit-filter.ts ｜ 审计日志过滤草稿的提示与校验（纯函数，与服务端 lib/audit-view.js 同口径）
 * ============================================================================
 * 【职责】关键词有效字符数（去掉空白与控制 / 格式字符后按码点计）→ 提示模式：
 *   none（空）/ too_short（1 字，服务端 400）/ like（2 字，普通匹配）/ fts（≥3 字，库里有全文索引时走全文检索；命中很多或没有 FTS5 构建时服务端自动回退普通匹配，结果相同）。
 *   “按动作过滤必须同时填模块”只约束 action：其它条件（用户 / 对象 / 日期 / 关键词）单独给不受限。
 * 【不变量】阈值与服务端 KEYWORD_MIN_CHARS = 2、KEYWORD_FTS_MIN_CHARS = 3 一致；这里只做提示与前置拦截，授权与最终校验仍在服务端。
 * ============================================================================
 */
export const KEYWORD_MIN_CHARS = 2
export const KEYWORD_FTS_MIN_CHARS = 3

export type KeywordMode = 'none' | 'too_short' | 'like' | 'fts'

export const effectiveKeywordLength = (kw: string) => [...kw.replace(/[\s\p{Cc}\p{Cf}]/gu, '')].length

export function keywordMode(kw: string): KeywordMode {
  if (!kw) return 'none'
  const n = effectiveKeywordLength(kw)
  if (n < KEYWORD_MIN_CHARS) return 'too_short'
  return n >= KEYWORD_FTS_MIN_CHARS ? 'fts' : 'like'
}

export const KEYWORD_HINTS: Record<KeywordMode, string> = {
  none: '关键字 ≥3 字符走全文检索；2 字符走普通匹配；至少 2 字符。',
  too_short: '关键字至少需要 2 个字符，当前不会发起查询。',
  like: '2 个字符走普通匹配；≥3 字符才走全文检索。',
  fts: '≥3 字符走全文检索（命中很多或无全文索引时自动回退普通匹配，结果相同）。'
}

/** 仅按动作过滤（没有模块）——服务端 AUDIT_ACTION_NEEDS_MODULE 400 */
export const actionNeedsModule = (d: { action: string; module: string }) => !!d.action.trim() && !d.module.trim()
export const ACTION_NEEDS_MODULE_HINT = '按动作过滤必须同时填写模块（如 sales）；只有动作需要模块，其它条件可单独使用。'
