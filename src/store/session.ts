/**
 * ============================================================================
 * 文件标识：src/store/session.ts ｜ 后台退出/改密协议及有条件的本地会话清理
 * 网络失败只确认本地退出；较旧操作不能清掉其后建立的登录状态。
 * ============================================================================
 */
import api, { clearToken, getAuthSnapshot, noticeWhenLoggedOut } from '../api/client'

export type LogoutResult = { revoked: boolean; message: string }
export async function logoutAll(): Promise<LogoutResult> {
  const snapshot = getAuthSnapshot()
  let revoked = false
  try {
    if (snapshot.token) revoked = (await api.post('/auth/logout-all', {}, { signal: AbortSignal.timeout(10000) })).data?.revoked === true
  } catch { /* Local exit remains available; do not claim server revocation on failure. */ }
  const message = revoked ? '已退出，服务端已撤销该账号的全部后台会话。' : '已退出本地；未能确认服务端会话撤销。请在恢复连接后重新登录并退出全部会话。'
  if (!clearToken(snapshot, message)) noticeWhenLoggedOut(message)
  return { revoked, message }
}
export async function changePassword(oldPassword: string, newPassword: string) {
  const snapshot = getAuthSnapshot()
  const result = await api.post('/auth/change-password', { oldPassword, newPassword }, { signal: AbortSignal.timeout(15000) })
  if (result?.data?.changed !== true || result?.data?.reauthenticate !== true) throw new Error('服务器未确认密码变更与会话撤销，请确认状态后再操作。')
  clearToken(snapshot, '密码已修改，全部后台会话已失效。请使用新密码重新登录。')
}
