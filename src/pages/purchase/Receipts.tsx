/**
 * ============================================================================
 * 文件标识：src/pages/purchase/Receipts.tsx ｜ 收货单
 * ============================================================================
 * 【职责】收货单（页面）
 * 【入口】/purchase/receipts
 * 【主要接口】/purchase/receipts
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
 * 页面：收货单
 */

import DataPage, { FieldDef } from '../../components/DataPage'
import { Status, fmtInt, fmtMoney, toast } from '../../components/ui'
import { useOpts } from '../../hooks/opts'
import api from '../../api/client'

export default function Receipts() {
  const o = useOpts()
  const fields: FieldDef[] = [
    { key: 'doc_no', label: '收货单号', width: 150 },
    { key: 'order_no', label: '采购订单', width: 150 },
    { key: 'supplier_name', label: '供应商', width: 210 },
    { key: 'warehouse_name', label: '收货仓库', width: 150 },
    { key: 'receipt_date', label: '收货日期', width: 110 },
    { key: 'item_count', label: '行数', width: 60, align: 'right' },
    { key: 'total_qty', label: '入库数量', width: 90, align: 'right', render: (r) => fmtInt(r.total_qty) },
    { key: 'total_amount', label: '入库金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.total_amount)}` },
    { key: 'inspector', label: '验收人', width: 90 },
    { key: 'status', label: '状态', width: 90, render: (r) => <Status value={r.status} /> },
    { key: 'remark', label: '备注', width: 160 }
  ]

  /**
   * 关闭（仅 inspected）＝归档。零副作用：入库、批次、流水都在收货那一步完成了，
   * 质检结论也已经出过，这里只是把单子收进「已关闭」。
   * 不做 `received`：还没质检的到货单不该被直接归档，那是质检岗的判断。
   */
  const close = async (row: any, reload: () => void) => {
    if (!confirm(`关闭到货单「${row.doc_no}」？关闭只是归档，不影响库存与批次。`)) return
    try {
      await api.post(`/purchase/receipts/${row.id}/close`, {})
      toast('到货单已关闭')
      reload()
    } catch (e: any) {
      toast(e.message || '关闭失败', 'error')
    }
  }

  return (
    <DataPage
      title="收货单"
      desc="采购收货记录，每张收货单都会生成批次库存与入库流水"
      path="/purchase/receipts"
      fields={fields}
      canWrite={false}
      allowDelete={false}
      excelName="收货单"
      filters={[{ key: 'supplier_id', type: 'select', label: '全部供应商', options: o.suppliers }]}
      rowActions={(row, reload) =>
        row.status === 'inspected' ? (
          <button className="link text-[12px]" onClick={() => close(row, reload)}>
            关闭
          </button>
        ) : null
      }
    />
  )
}
