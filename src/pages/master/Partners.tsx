/**
 * ============================================================================
 * 文件标识：src/pages/master/Partners.tsx ｜ 供应商
 * ============================================================================
 * 【职责】供应商（页面）
 * 【入口】/master/partners
 * 【主要接口】/master/suppliers、/master/dealers
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
 * 页面：供应商
 */

import { useState } from 'react'
import DataPage, { FieldDef } from '../../components/DataPage'
import { Card, Status, Tabs, fmtMoney } from '../../components/ui'
import { useDict } from '../../hooks/opts'
import { useAuth } from '../../store/auth'
import { hasDealer } from '../../constants/capabilities'

function SupplierTable() {
  const { label } = useDict()
  const { industry } = useAuth()
  const supplierDesc = industry === 'apparel' ? '面料 / 辅料 / 成衣代工（OEM）供应商' : '化妆品原料 / 包材 / OEM 供应商'
  const fields: FieldDef[] = [
    { key: 'code', label: '供应商编码', width: 110, required: true },
    { key: 'name', label: '供应商名称', width: 220, required: true },
    { key: 'category', label: '供货类别', width: 120 },
    { key: 'contact', label: '联系人', width: 90 },
    { key: 'phone', label: '电话', width: 130 },
    { key: 'settle_type', label: '结算方式', width: 120, default: '月结 30 天' },
    { key: 'credit_days', label: '账期(天)', width: 90, align: 'right', type: 'number', default: 30 },
    {
      key: 'status',
      label: '状态',
      width: 80,
      type: 'select',
      options: [
        { value: 'active', label: '启用' },
        { value: 'inactive', label: '停用' }
      ],
      default: 'active',
      render: (r) => <Status value={r.status} />
    },
    { key: 'tax_no', label: '税号', formOnly: true },
    { key: 'address', label: '地址', span: 2, formOnly: true },
    { key: 'bank_account', label: '银行账号', span: 2, formOnly: true }
  ]
  return <DataPage title="供应商" desc={supplierDesc} path="/master/suppliers" fields={fields} excelName="供应商" canWrite />
}

function DealerTable() {
  const { dealerLevels, dealerChannel } = useDict()
  const fields: FieldDef[] = [
    { key: 'code', label: '经销商编码', width: 110, required: true },
    { key: 'name', label: '经销商名称', width: 220, required: true },
    {
      key: 'level',
      label: '等级',
      width: 90,
      type: 'select',
      options: dealerLevels,
      default: 'bronze',
      render: (r) => <Status value={r.level} text={r.level_name || dealerLevels.find((x) => x.value === r.level)?.label} />
    },
    { key: 'region', label: '区域', width: 80 },
    { key: 'city', label: '城市', width: 90 },
    {
      key: 'channel_type',
      label: '渠道类型',
      width: 100,
      type: 'select',
      options: dealerChannel,
      render: (r) => dealerChannel.find((x) => x.value === r.channel_type)?.label || r.channel_type || '—'
    },
    { key: 'discount_rate', label: '折扣率', width: 90, align: 'right', type: 'number', default: 100, render: (r) => (r.discount_rate ? `${r.discount_rate}%` : '—') },
    { key: 'rebate_rate', label: '返利率', width: 90, align: 'right', type: 'number', default: 0, render: (r) => (r.rebate_rate ? `${r.rebate_rate}%` : '—') },
    { key: 'credit_limit', label: '信用额度', width: 120, align: 'right', type: 'number', render: (r) => `¥${fmtMoney(r.credit_limit, 0)}` },
    { key: 'credit_used', label: '已用额度', width: 120, align: 'right', formOnly: true, render: (r) => `¥${fmtMoney(r.credit_used, 0)}` },
    { key: 'contact', label: '联系人', width: 90 },
    { key: 'phone', label: '电话', width: 125 },
    { key: 'settle_type', label: '结算方式', width: 110, formOnly: true, default: '月结 30 天' },
    { key: 'onboard_date', label: '合作起始', width: 110, type: 'date', formOnly: true },
    {
      key: 'status',
      label: '状态',
      width: 75,
      type: 'select',
      options: [
        { value: 'active', label: '启用' },
        { value: 'inactive', label: '停用' }
      ],
      default: 'active',
      render: (r) => <Status value={r.status} />
    },
    { key: 'address', label: '地址', span: 2, formOnly: true },
    { key: 'tax_no', label: '税号', formOnly: true },
    { key: 'remark', label: '备注', span: 2, type: 'textarea', formOnly: true }
  ]
  return (
    <DataPage
      title="经销商"
      desc="等级、折扣、返利与信用额度政策"
      path="/master/dealers"
      fields={fields}
      excelName="经销商"
      filters={[
        { key: 'level', type: 'select', label: '全部等级', options: dealerLevels },
        { key: 'region', type: 'text', label: '区域' }
      ]}
    />
  )
}

export default function Partners() {
  const [tab, setTab] = useState('supplier')
  const { industry } = useAuth()
  // 连锁餐饮**没有经销商**（总部直营门店 + 供应商），这一页只剩供应商。
  // 判据走 `hasDealer`，不在这里写 industry !== 'food' —— 否则下次加行业必漏。
  const showDealer = hasDealer(industry)
  return (
    <div>
      <h1 className="text-[17px] font-medium text-slate-800 mb-1">{showDealer ? '供应商 / 经销商' : '供应商'}</h1>
      <p className="text-[12px] text-slate-400 mb-3">
        {showDealer ? '采购上游与分销下游的合作方主数据' : '采购上游的合作方主数据（本行业版本为总部直营，无经销商）'}
      </p>
      {showDealer && (
        <Card pad={false}>
          <div className="px-3 pt-2">
            <Tabs
              tabs={[
                { key: 'supplier', label: '供应商' },
                { key: 'dealer', label: '经销商' }
              ]}
              value={tab}
              onChange={setTab}
            />
          </div>
        </Card>
      )}
      <div className="mt-3">{showDealer && tab === 'dealer' ? <DealerTable /> : <SupplierTable />}</div>
    </div>
  )
}
