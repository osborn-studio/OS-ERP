/**
 * ============================================================================
 * 文件标识：src/pages/system/AiLogs.tsx ｜ 操作审计日志
 * ============================================================================
 * 【职责】操作审计日志（页面）
 * 【入口】/system/ai-logs
 * 【主要接口】/auth/audit-logs
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
 * 页面：操作审计日志
 */

import DataPage, { FieldDef } from '../../components/DataPage'
import { Status } from '../../components/ui'

export default function AiLogs() {
  const fields: FieldDef[] = [
    { key: 'created_at', label: '时间', width: 165 },
    { key: 'user_name', label: '操作人', width: 100 },
    { key: 'action', label: '动作', width: 110 },
    { key: 'module', label: '模块', width: 100 },
    { key: 'entity', label: '对象', width: 160 },
    { key: 'entity_id', label: '对象 ID', width: 80, align: 'right' },
    { key: 'detail', label: '说明', width: 260 },
    { key: 'ip', label: 'IP', width: 130 },
    { key: 'status', label: '结果', width: 80, render: (r) => <Status value={r.status || 'success'} /> }
  ]
  return (
    <DataPage
      title="操作审计日志"
      desc="所有单据操作与主数据变更留痕，可按模块与动作追溯"
      path="/auth/audit-logs"
      fields={fields}
      canWrite={false}
      allowDelete={false}
      excelName="审计日志"
      filters={[
        {
          key: 'module',
          type: 'select',
          label: '全部模块',
          options: [
            { value: 'auth', label: '认证' },
            { value: 'master', label: '主数据' },
            { value: 'purchase', label: '采购' },
            { value: 'sales', label: '销售' },
            { value: 'inventory', label: '存货' },
            { value: 'dealer', label: '经销商' },
            { value: 'oms', label: '线上 OMS' }
          ]
        }
      ]}
    />
  )
}
