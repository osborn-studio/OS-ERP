/**
 * ============================================================================
 * 文件标识：src/components/BackupReportCard.tsx ｜ 最近一次备份报告状态卡（AH11，只读）
 * ============================================================================
 * 【职责】显示最近一份 backup-report-*.json 的时间、结果（成功 / 失败 / 无 / 不可读）与清理计数（清掉的旧备份、孤儿清单）。
 * 【数据】`GET /api/meta/health` 的 `ops.last_backup`（at / result / encrypted / age_seconds）与 `ops.backup_report`（只给计数与状态）。
 *   两者只对管理员返回；非管理员 / 读取失败时整卡不显示。报告里的路径、sha256、库名从不透出。
 * 【口径】prune_state：none 无需清理 / done 已清理 / planned 清理已记录但未确认完成（被打断，下次运行继续）/ failed 清理失败 / skipped 报告写不下去故未删任何文件。
 * ============================================================================
 */
import { Card, SectionTitle, useFetch } from './ui'

type LastBackup = { at: string | null; result: 'ok' | 'failed' | 'none' | 'unreadable'; encrypted: boolean | null; age_seconds: number | null }
type ReportDetail = { report_phase: 'pre-prune' | 'final'; databases: number; failed: number; prune_state: string; pruned_backups: number; pruned_orphans: number }
type Health = { ops?: { last_backup?: LastBackup; backup_report?: ReportDetail | null } }

const RESULT_TEXT: Record<string, { text: string; cls: string }> = {
  ok: { text: '成功', cls: 'text-emerald-700' },
  failed: { text: '失败', cls: 'text-red-700' },
  none: { text: '从未备份（没有报告）', cls: 'text-amber-700' },
  unreadable: { text: '报告不可读', cls: 'text-red-700' }
}
const PRUNE_TEXT: Record<string, string> = {
  none: '无需清理', done: '已清理', planned: '清理已记录但未确认完成（被打断，下次运行继续）', failed: '清理失败', skipped: '报告写不下去，未删除任何文件'
}

function ageText(sec: number | null): string {
  if (sec == null) return '未知'
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`
  return `${Math.floor(sec / 86400)} 天前`
}

export default function BackupReportCard() {
  const { data, error } = useFetch<Health>('/meta/health')
  const last = data?.ops?.last_backup
  if (error || !last) return null
  const detail = data?.ops?.backup_report ?? null
  const res = RESULT_TEXT[last.result] || RESULT_TEXT.unreadable
  return (
    <Card className="mb-3">
      <SectionTitle title="最近一次备份报告" desc="来自备份目录里最新的 backup-report-*.json；只显示时间、结果与清理计数。" />
      <div data-testid="backup-report" data-result={last.result} data-prune-state={detail?.prune_state ?? ''} data-pruned={detail?.pruned_backups ?? ''} data-prune-confirmed={detail?.prune_state === 'done' ? '1' : '0'} data-orphans={detail?.pruned_orphans ?? ''} className="text-[13px] leading-relaxed">
        <div>结果：<b className={res.cls} data-testid="backup-report-result">{res.text}</b></div>
        <div data-testid="backup-report-at">时间：{last.at ? `${last.at}（${ageText(last.age_seconds)}）` : '—'}{last.encrypted != null && (last.encrypted ? ' · 已加密' : ' · 未加密')}</div>
        {detail
          ? <div className="mt-1 text-slate-600" data-testid="backup-report-prune">
              {detail.databases} 个库条目{detail.failed > 0 ? `，失败事件 ${detail.failed} 次（含备份 / 报告写入 / 清理失败）` : ''}；清理：{PRUNE_TEXT[detail.prune_state] || detail.prune_state}，
              {detail.prune_state === 'done'
                ? <>已清掉旧备份 <b>{detail.pruned_backups}</b> 份、孤儿清单 <b>{detail.pruned_orphans}</b> 份</>
                : <span data-testid="backup-report-unconfirmed">计划清理旧备份 <b>{detail.pruned_backups}</b> 份、孤儿清单 <b>{detail.pruned_orphans}</b> 份（未确认已删除）</span>}
              {detail.report_phase === 'pre-prune' && <span className="text-amber-700">（这是清理前的中间报告，终版报告未写出）</span>}
            </div>
          : <div className="mt-1 text-slate-500" data-testid="backup-report-prune-none">没有可显示的清理摘要。</div>}
      </div>
    </Card>
  )
}
