/**
 * ============================================================================
 * 文件标识：src/pages/system/Dict.tsx ｜ 枚举字典
 * ============================================================================
 * 【职责】枚举字典（页面）
 * 【入口】/system/dict
 * 【主要接口】/meta/dict
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
 * 页面：枚举字典
 */

import { Card, SectionTitle, useFetch } from '../../components/ui'

const GROUPS: { key: string; title: string; desc: string }[] = [
  { key: 'roles', title: '角色', desc: '系统用户角色与权限范围' },
  { key: 'dealer_levels', title: '经销商等级', desc: '等级与折扣、返利政策对应' },
  { key: 'dealer_channel', title: '经销商渠道类型', desc: '下游渠道分类' },
  { key: 'warehouse_types', title: '仓库类型', desc: '存货节点分类' },
  { key: 'store_types', title: '门店类型', desc: '线下零售节点分类' },
  { key: 'platform_types', title: '平台类型', desc: '线上渠道分类' },
  { key: 'sales_channels', title: '销售渠道', desc: '订单来源渠道枚举' },
  { key: 'purchase_status', title: '采购订单状态', desc: '采购单据状态机' },
  { key: 'sales_status', title: '销售订单状态', desc: '销售单据状态机' },
  { key: 'oms_status', title: '线上订单状态', desc: 'OMS 订单状态机' },
  { key: 'transfer_status', title: '调拨单状态', desc: '调拨流程状态' },
  { key: 'check_status', title: '盘点单状态', desc: '盘点流程状态' },
  { key: 'stock_doc_types', title: '库存流水业务类型', desc: '出入库业务来源' },
  { key: 'direction', title: '出入库方向', desc: '库存变动方向' },
  { key: 'rebate_status', title: '返利状态', desc: '返利核算流程' },
  { key: 'statement_status', title: '对账单状态', desc: '对账流程状态' },
  { key: 'expire_level', title: '效期预警级别', desc: '临期分级规则' }
]

export default function Dict() {
  const { data } = useFetch<any>('/meta/dict')
  const d = data || {}

  return (
    <div>
      <div className="mb-3">
        <h1 className="title-serif text-[19px] font-medium text-ink-900">枚举字典</h1>
        <p className="text-[12px] text-ink-700 mt-0.5">系统全部枚举值与中文口径，接口与前端共用同一份字典</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
        {GROUPS.map((g) => {
          const obj = d[g.key] || {}
          const entries = Object.entries(obj)
          return (
            <Card key={g.key} pad={false}>
              <div className="px-4 pt-4">
                <SectionTitle title={g.title} desc={g.desc} />
              </div>
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 140 }}>编码</th>
                      <th>显示名称</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.length === 0 && (
                      <tr>
                        <td colSpan={2} className="text-center py-4 text-slate-400">—</td>
                      </tr>
                    )}
                    {entries.map(([k, v]) => (
                      <tr key={k}>
                        <td className="font-mono text-[12px] text-ink-700">{k}</td>
                        <td>{String(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
