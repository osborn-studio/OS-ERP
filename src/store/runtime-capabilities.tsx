/**
 * ============================================================================
 * 文件标识：src/store/runtime-capabilities.tsx ｜ 运行能力状态的唯一前端来源
 * 未知、失败或不完整响应默认关闭。此展示状态不替代服务端授权与能力门禁。
 * ============================================================================
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import api from '../api/client'

export const CAPABILITY_IDS = ['public_mall', 'qimen_gateway', 'oms_simulation', 'im_connector', 'agent_access'] as const
export type RuntimeCapability = typeof CAPABILITY_IDS[number]
type Mode = 'production' | 'demo' | 'test'
type Snapshot = { mode: Mode; capabilities: Record<RuntimeCapability, boolean> }
type State = { status: 'loading' | 'ready' | 'error'; snapshot: Snapshot | null }
type Context = State & { enabled: (id: RuntimeCapability) => boolean; isDemo: boolean; reload: () => void }
const Ctx = createContext<Context | null>(null)

export function parseRuntimeCapabilities(response: any): Snapshot {
  const data = response?.data
  if (!['production', 'demo', 'test'].includes(data?.runtime_mode)) throw new Error('Unknown runtime mode')
  const capabilities = {} as Snapshot['capabilities']
  for (const id of CAPABILITY_IDS) {
    if (typeof data?.capabilities?.[id]?.enabled !== 'boolean') throw new Error('Incomplete capability response')
    capabilities[id] = data.capabilities[id].enabled
  }
  return { mode: data.runtime_mode, capabilities }
}

export function RuntimeCapabilitiesProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading', snapshot: null })
  const sequence = useRef(0)
  const reload = useCallback(() => {
    const current = ++sequence.current
    setState({ status: 'loading', snapshot: null })
    let timeout: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Capability request timed out')), 10000) })
    Promise.race([api.get(''), deadline]).then(parseRuntimeCapabilities).then(snapshot => {
      if (current === sequence.current) setState({ status: 'ready', snapshot })
    }).catch(() => {
      if (current === sequence.current) setState({ status: 'error', snapshot: null })
    }).finally(() => clearTimeout(timeout))
  }, [])
  useEffect(() => {
    reload()
    window.addEventListener('os-egp:feature-disabled', reload)
    window.addEventListener('focus', reload)
    return () => {
      ++sequence.current
      window.removeEventListener('os-egp:feature-disabled', reload)
      window.removeEventListener('focus', reload)
    }
  }, [reload])
  const value = useMemo<Context>(() => ({
    ...state,
    enabled: id => state.status === 'ready' && state.snapshot?.capabilities[id] === true,
    isDemo: state.status === 'ready' && (state.snapshot?.mode === 'demo' || state.snapshot?.mode === 'test'),
    reload
  }), [state, reload])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRuntimeCapabilities() {
  const value = useContext(Ctx)
  if (!value) throw new Error('RuntimeCapabilitiesProvider is required')
  return value
}
