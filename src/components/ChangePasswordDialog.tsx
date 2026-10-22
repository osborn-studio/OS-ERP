/**
 * ============================================================================
 * 文件标识：src/components/ChangePasswordDialog.tsx ｜ 后台自助改密与强制重新登录
 * 密码仅保留在当前表单内存，后端确认后清除当前会话，不写本地存储。
 * ============================================================================
 */
import { useState, type FormEvent } from 'react'
import { useAuth } from '../store/auth'

export default function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { changePassword } = useAuth()
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError('')
    if (newPassword !== confirmation) { setError('两次输入的新密码不一致。'); return }
    setBusy(true)
    try {
      await changePassword(oldPassword, newPassword)
      setOldPassword(''); setNewPassword(''); setConfirmation(''); onClose()
    } catch (e: any) { setError(e.message || '密码修改未确认，请检查连接和当前密码。') }
    finally { setBusy(false) }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
    <form onSubmit={submit} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
      <h2 id="change-password-title" className="text-lg font-semibold">修改密码</h2>
      <p className="mt-2 mb-4 text-sm text-slate-600">修改成功后，全部后台会话失效，需要重新登录。新密码至少 16 个字符、6 种不同字符，最多 72 个 UTF-8 字节。</p>
      <label className="block mb-3">当前密码<input className="input mt-1 w-full" type="password" autoComplete="current-password" value={oldPassword} onChange={e => setOldPassword(e.target.value)} disabled={busy} required autoFocus /></label>
      <label className="block mb-3">新密码<input className="input mt-1 w-full" type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} disabled={busy} required /></label>
      <label className="block mb-3">确认新密码<input className="input mt-1 w-full" type="password" autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy} required /></label>
      {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2"><button className="btn-ghost" type="button" disabled={busy} onClick={onClose}>取消</button><button className="btn-primary" type="submit" disabled={busy}>{busy ? '正在修改…' : '修改并重新登录'}</button></div>
    </form>
  </div>
}
