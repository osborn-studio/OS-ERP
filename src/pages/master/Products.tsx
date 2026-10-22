/**
 * ============================================================================
 * 文件标识：src/pages/master/Products.tsx ｜ 商品档案
 * ============================================================================
 * 【职责】商品档案（页面）
 * 【入口】/master/products
 * 【主要接口】/master/products、/master/skus
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
 * 页面：商品档案
 */

import { Link } from 'react-router-dom'
import DataPage, { FieldDef } from '../../components/DataPage'
import { useDict, useOpts } from '../../hooks/opts'
import { fmtInt, fmtMoney, toast } from '../../components/ui'
import api from '../../api/client'

export default function Products() {
  const o = useOpts()
  const { label } = useDict()

  const fields: FieldDef[] = [
    {
      key: 'image_emoji',
      label: '图标',
      width: 54,
      align: 'center',
      render: (r) => <span className="text-[18px]">{r.image_emoji || '💄'}</span>
    },
    { key: 'spu_code', label: 'SPU 编码', width: 110, required: true, readOnly: true, hint: '自动生成' },
    { key: 'name', label: '商品名称', width: 190, required: true },
    { key: 'brand_id', label: '品牌', width: 130, type: 'select', options: o.brands, render: (r) => r.brand_name || '—' },
    { key: 'category_id', label: '品类', width: 100, type: 'select', options: o.categories, render: (r) => r.category_name || '—' },
    { key: 'spec', label: '规格', width: 90 },
    { key: 'unit', label: '单位', width: 60 },
    { key: 'sku_count', label: 'SKU', width: 60, align: 'right', formOnly: true },
    { key: 'stock_qty', label: '库存', width: 80, align: 'right', formOnly: true, render: (r) => fmtInt(r.stock_qty) },
    { key: 'price_retail', label: '零售价', width: 100, align: 'right', type: 'number', render: (r) => `¥${fmtMoney(r.price_retail)}` },
    { key: 'price_dealer', label: '经销价', width: 100, align: 'right', type: 'number', render: (r) => `¥${fmtMoney(r.price_dealer)}` },
    { key: 'cost_std', label: '标准成本', width: 100, align: 'right', type: 'number', render: (r) => `¥${fmtMoney(r.cost_std)}` },
    { key: 'safe_stock', label: '安全库存', width: 90, align: 'right', type: 'number' },
    { key: 'shelf_life_months', label: '保质期(月)', width: 100, align: 'right', type: 'number' },
    { key: 'batch_managed', label: '批次管理', width: 90, type: 'switch', align: 'center' },
    {
      key: 'require_qc',
      label: '启用质检',
      width: 90,
      type: 'switch',
      align: 'center',
      default: 0,
      hint: '开启后，该商品的批次必须检验合格才可出售'
    },
    {
      key: 'status',
      label: '状态',
      width: 70,
      type: 'select',
      options: [
        { value: 'active', label: '启用' },
        { value: 'inactive', label: '停用' }
      ],
      default: 'active'
    },
    { key: 'series', label: '系列', tableOnly: true, formOnly: true },
    { key: 'tax_rate', label: '税率(%)', type: 'number', default: 13, formOnly: true },
    { key: 'remark', label: '备注', type: 'textarea', span: 2, formOnly: true }
  ]

  return (
    <DataPage
      title="商品档案"
      desc="SPU / SKU 主数据，含品牌品类、价格体系与库存口径"
      path="/master/products"
      fields={fields}
      excelName="商品档案"
      filters={[
        { key: 'brand_id', type: 'select', label: '全部品牌', options: o.brands },
        { key: 'category_id', type: 'select', label: '全部品类', options: o.categories }
      ]}
      rowActions={(row) => (
        <SkuAction productId={row.id} name={row.name} />
      )}
    />
  )
}

function SkuAction({ productId, name }: { productId: number; name: string }) {
  const open = async () => {
    const res = await api.get('/master/skus', { product_id: productId, all: 1 })
    const list = res.data || []
    const text = list
      .map((s: any) => `${s.sku_code}  ${s.name}  零售¥${s.price_retail ?? '-'}  经销¥${s.price_dealer ?? '-'}`)
      .join('\n')
    alert(`【${name}】共 ${list.length} 个 SKU\n\n${text || '暂无 SKU'}`)
  }
  return (
    <button className="link text-[12px]" onClick={open}>
      SKU
    </button>
  )
}
