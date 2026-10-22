/**
 * ============================================================================
 * 文件标识：src/pages/sales/Deliveries.tsx ｜ 发货单
 * ============================================================================
 * 【职责】发货单（页面）
 * 【入口】/sales/deliveries
 * 【主要接口】/sales/deliveries
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
 * 页面：发货单
 */

import DataPage, { FieldDef } from '../../components/DataPage'
import { Status, fmtInt, fmtMoney, toast } from '../../components/ui'
import { useDict, useOpts } from '../../hooks/opts'
import api from '../../api/client'

/**
 * DL 自己的状态文案（**唯一出处是内核 `008_doc_kernel.cjs` 的 `STATES.DL` 的 name**）。
 *
 * 为什么必须给 DL 单独一份，而不是直接用全局 `ui.tsx` 的 `STATUS_MAP`：
 *   那个 map 是**按状态码**索引的（一份表服务所有单据类型），而状态码在不同域语义不同 ——
 *   `received` 在采购域是「已收货」（PO/GR 入库到货），在销售发货域是「已签收」（客户签收）。
 *   全局表只能二选一：改它 ⇒ 采购那 5 个域的到货/收货文案被改错；
 *   不改 ⇒ 这张单上按钮叫「签收」、点完状态却显示「已收货」，前后逻辑不一致。
 *   所以按项目既有口径（同码不同域 ⇒ 不能让两个域共用一个字段）：**DL 查自己的表，查不到才回落全局**。
 *   （`draft` 同理：全局是「草稿」，DL 域内核名叫「待发货」。）
 *
 * 导出是为了让"文案 == 内核 name"这件事能被**实测**（而不是只靠读码声称）：
 * `scripts` 不长驻也无需长驻，本轮用隔离脚本对拍内核 `STATES.DL` 与本表。
 */
export const DL_STATUS_LABEL: Record<string, string> = {
  draft: '待发货',
  shipped: '已发货',
  received: '已签收',
  cancelled: '已取消'
}

export default function Deliveries() {
  const o = useOpts()
  const { salesChannels } = useDict()
  const fields: FieldDef[] = [
    { key: 'doc_no', label: '发货单号', width: 150 },
    { key: 'order_no', label: '销售订单', width: 150 },
    { key: 'channel', label: '渠道', width: 100, render: (r) => salesChannels.find((c) => c.value === r.channel)?.label || r.channel },
    { key: 'customer_name', label: '客户', width: 200 },
    { key: 'warehouse_name', label: '发货仓库', width: 150 },
    { key: 'delivery_date', label: '发货日期', width: 110 },
    { key: 'total_qty', label: '发货数量', width: 90, align: 'right', render: (r) => fmtInt(r.total_qty) },
    { key: 'total_amount', label: '发货金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.total_amount)}` },
    { key: 'express_company', label: '承运商', width: 110 },
    { key: 'express_no', label: '运单号', width: 160 },
    {
      key: 'status',
      label: '状态',
      width: 90,
      // `text` 只覆盖文案，徽标配色仍走全局表（同码在两类单据里的色调一致）
      render: (r) => <Status value={r.status} text={DL_STATUS_LABEL[r.status]} />
    }
  ]

  // 签收（已发货 → 已签收）。按钮只在 `shipped` 时可点 —— 与服务端内核的边定义一致
  // （`receive` 边的 from_state 只有 `shipped`）：前端不假装"哪张单都能签"，
  // 状态不对时服务端会回 409，这里先把不可能的操作藏起来。
  const receive = async (row: any, reload: () => void) => {
    if (!confirm(`确认发货单「${row.doc_no}」已由客户签收？`)) return
    try {
      await api.post(`/sales/deliveries/${row.id}/receive`, {})
      toast('已签收')
      reload()
    } catch (e: any) {
      toast(e.message || '签收失败', 'error')
    }
  }

  return (
    <DataPage
      title="发货单"
      desc="按批次先进先出挑货出库；临期批次优先出库"
      path="/sales/deliveries"
      fields={fields}
      canWrite={false}
      allowDelete={false}
      excelName="发货单"
      rowActions={(row, reload) =>
        row.status === 'shipped' ? (
          <button className="link text-[12px]" onClick={() => receive(row, reload)}>
            签收
          </button>
        ) : null
      }
      filters={[
        { key: 'channel', type: 'select', label: '全部渠道', options: salesChannels },
        { key: 'warehouse_id', type: 'select', label: '全部仓库', options: o.warehouses }
      ]}
    />
  )
}
