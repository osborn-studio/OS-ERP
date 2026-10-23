/**
 * ============================================================================
 * 文件标识：src/store/auth.tsx ｜ 登录态与行业上下文（React Context）：token / user / industry 的唯一来源
 * ============================================================================
 * 【职责】登录态与行业上下文（React Context）：token / user / industry 的唯一来源
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import api, { getUser, setUser, getIndustry, setSession, setCookieSession, getAuthSnapshot, isCurrentSession, subscribeAuth, getSessionNotice, dismissSessionNotice } from '../api/client'
import { logoutAll, changePassword, type LogoutResult } from './session'

type AuthState = {
  user: any
  token: string
  /** Local UI revision of the actual token/generation/industry, never a credential. */
  sessionRevision: number
  loading: boolean
  industry: string
  login: (username: string, password: string, industry?: string) => Promise<any>
  logout: () => Promise<LogoutResult>
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>
  sessionNotice: string
  dismissSessionNotice: () => void
  is: (...roles: string[]) => boolean
}

const Ctx = createContext<AuthState>(null as any)

export const ROLE_LABEL: Record<string, string> = {
  admin: '系统管理员',
  boss: '老板/总经理',
  // 与后端 `middleware/auth.js` 的 ROLES **必须逐字一致**：
  // 两处文案不同不会报错，只会让"同一个人在两个页面显示两个头衔"。
  scm: '供应链主管',
  purchase: '采购主管',
  sales: '销售主管',
  warehouse: '仓储主管',
  finance: '财务',
  dealer: '经销商',
  store: '门店店长',
  viewer: '只读访客'
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setU] = useState<any>(getUser())
  const [session, setAuthSession] = useState(() => ({ ...getAuthSnapshot(), industry: getIndustry(), revision: 0 }))
  const token = session.token
  const [loading, setLoading] = useState(false)
  const industry = session.industry || 'cosmetic'
  const [sessionNotice, setNotice] = useState(getSessionNotice())
  const loginSequence = useRef(0)

  useEffect(() => {
    const sync = () => {
      const next = { ...getAuthSnapshot(), industry: getIndustry() }
      setAuthSession(previous => previous.token === next.token && previous.generation === next.generation && previous.industry === next.industry
        ? previous : { ...next, revision: previous.revision + 1 })
      setU(getUser()); setNotice(getSessionNotice())
    }
    const unsubscribe = subscribeAuth(sync)
    sync()
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!token) return
    const snapshot = getAuthSnapshot()
    let active = true
    api.get('/auth/me').then(r => { if (active) setUser(r.data, snapshot) }).catch(() => {
      // 401 is handled centrally. Connectivity failure alone must not invalidate a session.
    })
    return () => { active = false }
  }, [token, session.generation, industry])

  const login = async (username: string, password: string, ind?: string) => {
    const sequence = ++loginSequence.current
    const snapshot = getAuthSnapshot()
    setLoading(true)
    try {
      const code = ind || industry
      const res = await api.post('/auth/login', { username, password, industry: code })
      const { token: tk, user: u, transport } = res.data
      if (sequence !== loginSequence.current || !isCurrentSession(snapshot)) throw new Error('登录状态已在其他操作中变更，请重试。')
      if (transport === 'cookie') {
        // Cookie transport (ADR-0036): the server set the HttpOnly session cookie; no JWT reaches JavaScript.
        if (!u) throw new Error('登录响应缺少有效会话。')
        setCookieSession(u, code)
      } else {
        if (typeof tk !== 'string' || !tk || !u) throw new Error('登录响应缺少有效会话。')
        setSession(tk, u, code)
      }
      return u
    } finally {
      if (sequence === loginSequence.current) setLoading(false)
    }
  }

  const logout = logoutAll

  const value = useMemo<AuthState>(
    () => ({
      user,
      token,
      sessionRevision: session.revision,
      loading,
      industry,
      login,
      logout,
      changePassword,
      sessionNotice,
      dismissSessionNotice,
      is: (...roles: string[]) => !!user && (user.role === 'admin' || roles.includes(user.role))
    }),
    [user, token, loading, industry, sessionNotice, session.revision]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  return useContext(Ctx)
}
