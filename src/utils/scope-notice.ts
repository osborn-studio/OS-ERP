/**
 * ============================================================================
 * 文件标识：src/utils/scope-notice.ts ｜ 403 / 无组织空范围 / 功能关闭 / 登录失效 的提示选择器（纯函数）
 * ============================================================================
 * 【职责】由 `{ status, code, meta, rows, loading }` 决定页面该显示哪种提示，不碰 DOM、不发请求。
 *   - 401 → unauthenticated；403 → forbidden；code=FEATURE_DISABLED（任意状态）→ feature_disabled；
 *   - 请求成功（无 status 错误）且 rows 为空，并且 meta 表明账号无组织 / data_scope=none（非 all、非 admin）→ empty_scope；
 *   - 其它一律 none（正常显示数据或通用错误）。
 * 【不变量】失败（有 status>=400 或 code）绝不会被判成 empty_scope；加载中永远 none，不闪现提示。
 *   empty_scope 只是"为什么空"的解释，不替代服务端授权；它是 200 + 空列表（ADR-0017），不是错误。
 * ============================================================================
 */
export type ScopeNoticeKind = 'none' | 'unauthenticated' | 'forbidden' | 'feature_disabled' | 'empty_scope'
export type ScopeMeta = { role?: string | null; orgId?: number | string | null; dataScope?: string | null }
export type ScopeNoticeInput = {
  status?: number | null
  code?: string | null
  meta?: ScopeMeta | null
  rows?: unknown[] | number | null
  loading?: boolean
}
export type ScopeNotice = { kind: ScopeNoticeKind; title: string; message: string; blocking: boolean }

const NONE: ScopeNotice = { kind: 'none', title: '', message: '', blocking: false }

/** 账号是否处于"无组织或数据范围为空"的受限状态。admin 与 data_scope=all 永不算。 */
export function isUnscopedAccount(meta?: ScopeMeta | null): boolean {
  if (!meta) return false
  if (meta.role === 'admin') return false
  const scope = meta.dataScope == null ? '' : String(meta.dataScope)
  if (scope === 'all') return false
  if (scope === 'none') return true
  const org = meta.orgId
  return org === null || org === undefined || org === '' || org === 0
}

export function selectScopeNotice(input: ScopeNoticeInput): ScopeNotice {
  if (input.loading) return NONE
  const status = Number(input.status || 0)
  if (input.code === 'FEATURE_DISABLED') {
    return { kind: 'feature_disabled', blocking: true, title: '功能未启用', message: '此功能在当前实例未启用，当前页面没有可用数据。请联系管理员确认是否需要开通。' }
  }
  if (status === 401) {
    return { kind: 'unauthenticated', blocking: true, title: '登录已失效', message: '登录状态已失效，请重新登录后再查看。' }
  }
  if (status === 403) {
    return { kind: 'forbidden', blocking: true, title: '没有访问权限', message: '当前账号没有查看此内容的权限（不是没有数据）。请联系管理员核对角色与权限。' }
  }
  if (status >= 400 || input.code) return NONE
  const count = Array.isArray(input.rows) ? input.rows.length : typeof input.rows === 'number' ? input.rows : null
  if (count === 0 && isUnscopedAccount(input.meta)) {
    return { kind: 'empty_scope', blocking: false, title: '当前账号未关联组织或数据范围', message: '列表为空可能是因为账号没有挂组织或数据范围为空，并不代表系统里没有单据。请联系管理员为账号设置组织或数据范围。' }
  }
  return NONE
}
