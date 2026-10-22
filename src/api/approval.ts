/**
 * ============================================================================
 * 文件标识：src/api/approval.ts ｜ 模块 approval（按文件名推断，待人工完善）
 * ============================================================================
 * 【职责】模块 approval（按文件名推断，待人工完善）
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import api from './client'
import { toast } from '../components/ui'

/**
 * 审批闸门的前端配套（模块 22）。
 *
 * 后端在 `applyTransition` 上挂了一道闸门：被标记为「需审批」的动作，
 * 如果没有走完审批就执行，会抛 `APPROVAL_PENDING`（409）。
 *
 * 关键点：**这不是失败，是「还没走完流程」**。如果前端只丢一句
 * 「操作失败」，用户会反复点同一个按钮 —— 而每次点都会被同一道闸门挡回来，
 * 且闸门**不会**偷偷建审批实例（见 server/lib/approval.js 口径①）。
 * 所以这里必须主动把用户送去「提交审批」，否则那个动作永远无法完成。
 */
export const isApprovalPending = (e: any) => e?.detail?.code === 'APPROVAL_PENDING'

export const APPROVAL_CENTER_PATH = '/system/approval'

/**
 * 被闸门拦下时的统一处理：提示原因 → 已提交则引导去审批中心，未提交则询问是否提交。
 * @returns true 表示已处理（调用方不要再 toast 报错）
 */
export async function handleApprovalPending(
  e: any,
  { docType, docId, docNo, action, onSubmitted }: {
    docType: string
    docId: number
    docNo?: string
    action: string
    onSubmitted?: () => void
  }
): Promise<boolean> {
  if (!isApprovalPending(e)) return false
  const d = e.detail || {}

  if (d.instanceId) {
    const go = confirm(
      `「${d.actionName || action}」需要审批，该单据已提交审批。\n当前等待：${d.currentApprover || '审批人'}\n\n是否前往审批中心查看？`
    )
    if (go) window.location.href = APPROVAL_CENTER_PATH
    return true
  }

  const ask = confirm(
    `「${d.actionName || action}」需要审批${d.templateName ? `（${d.templateName}）` : ''}。\n` +
      `单据：${docNo || `#${docId}`}${d.amount ? `　金额：¥${Number(d.amount).toLocaleString()}` : ''}\n\n` +
      `审批通过后该动作才会真正执行。是否现在提交审批？`
  )
  if (!ask) return true

  try {
    await api.post('/approval/instances', { doc_type: docType, doc_id: docId, doc_no: docNo, action })
    toast('已提交审批，等待审批人处理')
    onSubmitted?.()
  } catch (e2: any) {
    toast(e2.message, 'error')
  }
  return true
}
