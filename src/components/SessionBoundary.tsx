/**
 * ============================================================================
 * 文件标识：src/components/SessionBoundary.tsx ｜ 后台业务状态的会话生命周期边界
 * ============================================================================
 * 换号、重新登录、退出或切行业时卸载旧页面及其表单/缓存；商城不使用后台边界。
 * 【改它要注意】`key` 必须是会话修订号（`sessionRevision`）：换成稳定值会让旧账号的表单草稿跨会话残留。
 * ============================================================================
 */
import { Fragment, type ReactNode } from 'react'
import { useAuth } from '../store/auth'

export default function SessionBoundary({ children }: { children: ReactNode }) {
  const { sessionRevision } = useAuth()
  return <Fragment key={sessionRevision}>{children}</Fragment>
}
