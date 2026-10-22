/**
 * ============================================================================
 * 文件标识：src/pages/master/Brands.tsx ｜ 品牌管理
 * ============================================================================
 * 【职责】品牌管理（页面）
 * 【入口】/master/brands
 * 【主要接口】/master/brands、/master/categories
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
 * 页面：品牌管理
 */

import DataPage, { FieldDef } from '../../components/DataPage'
import { Status } from '../../components/ui'
import { useAuth } from '../../store/auth'

export default function Brands() {
  const { industry } = useAuth()
  const brandFields: FieldDef[] = [
    { key: 'code', label: '品牌编码', width: 110, required: true },
    { key: 'name', label: '品牌名称', width: 200, required: true },
    { key: 'en_name', label: '英文名', width: 180 },
    { key: 'origin', label: '产地', width: 120 },
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
    }
  ]

  const catFields: FieldDef[] = [
    { key: 'code', label: '品类编码', width: 110, required: true },
    { key: 'name', label: '品类名称', width: 200, required: true },
    { key: 'parent_id', label: '上级品类 ID', width: 110, align: 'right', type: 'number' },
    { key: 'sort_no', label: '排序', width: 80, align: 'right', type: 'number', default: 100 },
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
    }
  ]

  return (
    <div className="flex flex-col gap-6">
      <DataPage title="品牌管理" desc={`${industry === 'apparel' ? '服装' : '化妆品'}品牌主数据`} path="/master/brands" fields={brandFields} excelName="品牌" />
      <DataPage title="品类管理" desc="支持二级品类（上级品类填父级 ID）" path="/master/categories" fields={catFields} excelName="品类" />
    </div>
  )
}
