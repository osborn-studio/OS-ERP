/**
 * ============================================================================
 * 文件标识：src/components/ScopeNotice.tsx ｜ 403 / 空范围 / 功能关闭 统一提示组件
 * 提示文案由 src/utils/scope-notice.ts 的纯选择器决定；本组件只负责展示，不替代服务端授权。
 * blocking 为真时调用方应不再渲染数据区，避免把 403 / 关闭画成"没有数据"。
 * ============================================================================
 */
import { getUser } from '../api/client'
import { selectScopeNotice, type ScopeNoticeInput } from '../utils/scope-notice'

export type FetchFailure = { errorStatus?: number | null; errorCode?: string | null }

export function currentScopeMeta() {
  const u = getUser()
  return { role: u?.role ?? null, orgId: u?.org_id ?? null, dataScope: u?.data_scope ?? null }
}

/** 页面用：返回提示与是否阻断数据区。 */
export function useScopeNotice(f: FetchFailure, rows: unknown[] | number | null | undefined, loading: boolean) {
  const notice = selectScopeNotice({ status: f.errorStatus, code: f.errorCode, rows: rows ?? null, loading, meta: currentScopeMeta() } as ScopeNoticeInput)
  return notice
}

export default function ScopeNotice({ failure, rows, loading }: { failure: FetchFailure; rows?: unknown[] | number | null; loading: boolean }) {
  const n = useScopeNotice(failure, rows, loading)
  if (n.kind === 'none') return null
  const blocking = n.blocking
  return (
    <div role={blocking ? 'alert' : 'status'} data-testid="scope-notice" data-kind={n.kind}
      className={`rounded-lg border p-4 text-sm mb-3 ${blocking ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
      <p className="font-medium">{n.title}</p>
      <p className="mt-1">{n.message}</p>
    </div>
  )
}

export function ForbiddenNotice({ failure }: { failure: FetchFailure }) {
  return <ScopeNotice failure={failure} loading={false} />
}

/** 多个请求并发时取第一个带状态/错误码的失败（FEATURE_DISABLED / 403 优先于其它）。 */
export function firstFailure(...fs: FetchFailure[]): FetchFailure {
  const rank = (f: FetchFailure) => f.errorCode === 'FEATURE_DISABLED' ? 3 : f.errorStatus === 403 ? 2 : f.errorStatus === 401 ? 1 : 0
  return fs.reduce((best, f) => rank(f) > rank(best) ? f : best, {} as FetchFailure)
}

/** 是否应隐藏数据区（403 / 401 / 功能关闭）。 */
export function isBlocked(f: FetchFailure) {
  return selectScopeNotice({ status: f.errorStatus, code: f.errorCode, loading: false }).blocking
}

/** 阻断态整页：403 / 401 / 功能关闭时替代数据区，附"重新加载"。 */
export function ScopeBlocked({ failure, onRetry }: { failure: FetchFailure; onRetry?: () => void }) {
  return (
    <div>
      <ScopeNotice failure={failure} loading={false} />
      {onRetry && <button className="btn-ghost btn-sm" onClick={onRetry}>重新加载</button>}
    </div>
  )
}
