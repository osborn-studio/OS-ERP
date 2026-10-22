/**
 * ============================================================================
 * 文件标识：src/components/CapabilityGate.tsx ｜ 禁用整页不挂载，阻止其请求和轮询
 * 服务器仍是安全边界。加载与失败不回退成可用，也不自动重试业务写操作。
 * ============================================================================
 */
import { useRuntimeCapabilities, type RuntimeCapability } from '../store/runtime-capabilities'

export function CapabilityStatus({ capability, label }: { capability?: RuntimeCapability; label?: string }) {
  const { status, enabled, reload } = useRuntimeCapabilities()
  if (status === 'ready' && (!capability || enabled(capability))) return null
  return <div role="status" className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600" data-testid="capability-status">
    <p>{status === 'loading' ? '正在确认功能可用性…' : status === 'error' ? '暂时无法确认功能可用性，相关功能保持关闭。' : `${label || '此功能'}在当前实例未启用。`}</p>
    {status !== 'loading' && <button className="btn mt-3" onClick={reload}>重新检查</button>}
  </div>
}

export default function CapabilityGate({ capability, label, children }: {
  capability: RuntimeCapability; label: string; children: React.ReactNode
}) {
  const { enabled } = useRuntimeCapabilities()
  return enabled(capability) ? <>{children}</> : <CapabilityStatus capability={capability} label={label} />
}
