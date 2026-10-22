/**
 * ============================================================================
 * 文件标识：src/pages/oms/Logs.tsx ｜ 同步日志
 * ============================================================================
 * 【职责】同步日志（页面）
 * 【入口】/oms/logs
 * 【主要接口】/oms/sync-logs
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自本页自己的标题**、
 *   入口取自 `src/App.tsx` 的路由表、接口取自本页实际调用的接口（**都不是新编的**）。
 *   人工完善时补：这页回答用户的什么问题 / 为什么这样组织 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处；下拉选项从 `/api/meta/*` 取，不要在页面里写死；
 *   改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */
/**
 * 页面：同步日志
 */

import DataPage, { FieldDef } from '../../components/DataPage'
import { Status, fmtInt } from '../../components/ui'
import { useOpts } from '../../hooks/opts'

export default function OmsLogs() {
  const o = useOpts()
  const fields: FieldDef[] = [
    { key: 'created_at', label: '时间', width: 165 },
    { key: 'platform_name', label: '平台', width: 110 },
    { key: 'sync_type', label: '同步类型', width: 100, render: (r) => ({ order: '订单同步', stock: '库存推送', refund: '退款同步', ship: '发货回传' }[r.sync_type as string] || r.sync_type) },
    { key: 'direction', label: '方向', width: 80, render: (r) => (r.direction === 'in' ? '平台 → 系统' : '系统 → 平台') },
    { key: 'total_count', label: '总数', width: 70, align: 'right', render: (r) => fmtInt(r.total_count) },
    { key: 'success_count', label: '成功', width: 70, align: 'right', render: (r) => fmtInt(r.success_count) },
    {
      key: 'fail_count',
      label: '失败',
      width: 70,
      align: 'right',
      render: (r) => <span className={r.fail_count > 0 ? 'text-red-500' : ''}>{fmtInt(r.fail_count)}</span>
    },
    { key: 'cost_ms', label: '耗时(ms)', width: 90, align: 'right' },
    { key: 'status', label: '结果', width: 80, render: (r) => <Status value={r.status} /> },
    { key: 'message', label: '信息', width: 260 }
  ]
  return (
    <DataPage
      title="同步日志"
      desc="订单拉取、库存推送、发货回传、退款同步的执行记录，异常可在此回溯"
      path="/oms/sync-logs"
      fields={fields}
      canWrite={false}
      allowDelete={false}
      excelName="OMS同步日志"
      filters={[
        { key: 'platform_id', type: 'select', label: '全部平台', options: o.platforms },
        {
          key: 'status',
          type: 'select',
          label: '全部结果',
          options: [
            { value: 'success', label: '成功' },
            { value: 'fail', label: '失败' }
          ]
        }
      ]}
    />
  )
}
