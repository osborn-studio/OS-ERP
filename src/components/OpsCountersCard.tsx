/**
 * ============================================================================
 * 文件标识：src/components/OpsCountersCard.tsx ｜ 运维计数器卡片（备份年龄 / 迁移校验 / 磁盘余量等）
 * ============================================================================
 * 数据来自 GET /api/meta/metrics（仅管理员；AB10 起按来源 IP 节流，超限 429 + METRICS_RATE_LIMITED）。
 * 429 时保留上一次成功的数值并显示友好提示（文案见 utils/ops-metrics-error.ts），不把节流当成故障或空数据。
 * 页面层只负责展示；授权与节流都在服务端。
 * ============================================================================
 */
import { RefreshCw } from 'lucide-react'
import { Card, SectionTitle, useFetch } from './ui'
import { selectOpsMetricsNotice } from '../utils/ops-metrics-error'

const LABELS: Record<string, string> = {
  backup_age_seconds: '距上次备份（秒，-1 = 未知）',
  backup_last_failed: '上次备份失败（1 = 是）',
  backup_missing: '从未备份（1 = 是）',
  migration_checksum_mismatches: '迁移校验不一致（个）',
  migration_checksum_adopted: '迁移校验已收编（个）',
  login_throttle_unavailable: '登录节流不可用（1 = 是）',
  disk_free_bytes: '磁盘可用字节（-1 = 未知）'
}

export default function OpsCountersCard() {
  const { data, loading, error, errorStatus, errorCode, reload } = useFetch<{ counters: Record<string, number> }>('/meta/metrics')
  const notice = error ? selectOpsMetricsNotice({ status: errorStatus, code: errorCode, message: error }) : null
  const counters = data?.counters
  return (
    <Card className="mt-3">
      <SectionTitle
        title="运维计数器"
        desc="备份、迁移校验、登录节流与磁盘余量；抓取有按来源地址的限速"
        right={<button className="btn-ghost btn-sm" disabled={loading} onClick={reload} data-testid="ops-counters-refresh"><RefreshCw size={13} /> 刷新</button>}
      />
      {notice && (
        <div role="status" data-testid="ops-counters-notice" data-kind={notice.kind} className={`mb-3 rounded border px-3 py-2 text-[13px] ${notice.kind === 'rate_limited' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {notice.message}
        </div>
      )}
      {counters && (
        <table className="w-full text-[12.5px]">
          <tbody className="divide-y divide-slate-100">
            {Object.entries(counters).map(([k, v]) => (
              <tr key={k}>
                <td className="py-1.5 pr-3 text-slate-600">{LABELS[k] || k}</td>
                <td className="py-1.5 text-right tabular-nums text-slate-800" data-counter={k}>{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!counters && !notice && !loading && <div className="text-[13px] text-slate-400">暂无数据</div>}
    </Card>
  )
}
