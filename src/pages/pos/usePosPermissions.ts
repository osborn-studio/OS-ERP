/**
 * ============================================================================
 * 文件标识：src/pages/pos/usePosPermissions.ts ｜ POS 页面取"当前用户的权限点"与失败状态的小钩子
 * ============================================================================
 * 【职责】从 `/auth/my-permissions` 取当前账号的有效权限（ADR-0025 的按动作权限点），连同登录用户 id / 姓名一起交给
 *   `src/utils/pos-actions.ts` 的纯选择器。取到之前 `permissions` 为 null（选择器据此全部隐藏，不先闪出再收回）；
 *   取失败也保持 null（动作全隐藏，服务端仍是唯一授权）。`toFailure` 把 ApiError 转成 W3 ScopeNotice 的失败形状。
 * ============================================================================
 */
import { useEffect, useState } from 'react'
import api, { ApiError, getUser } from '../../api/client'
import type { FetchFailure } from '../../components/ScopeNotice'

export function toFailure(e: unknown): FetchFailure {
  return e instanceof ApiError ? { errorStatus: e.status, errorCode: e.code || null } : {}
}

export function usePosPermissions() {
  const [permissions, setPermissions] = useState<string[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    api.get('/auth/my-permissions')
      .then((r: any) => { if (live) { setPermissions(Array.isArray(r.data?.permissions) ? r.data.permissions : null); setFailed(!Array.isArray(r.data?.permissions)) } })
      .catch(() => { if (live) { setPermissions(null); setFailed(true) } })
    return () => { live = false }
  }, [tick])
  const u = getUser()
  return { permissions, failed, retry: () => setTick((n) => n + 1), currentUser: u ? { id: u.id, name: u.name, username: u.username } : null }
}
