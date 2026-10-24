/**
 * ============================================================================
 * 文件标识：src/pages/master/Org.tsx ｜ 仓库
 * ============================================================================
 * 【职责】仓库（页面）
 * 【入口】/master/org
 * 【主要接口】/master/warehouses、/master/stores、/auth/users
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
 * 页面：仓库
 */

import { useState } from 'react'
import DataPage, { FieldDef } from '../../components/DataPage'
import { Card, Status, Tabs, fmtInt, fmtMoney } from '../../components/ui'
import { useDict } from '../../hooks/opts'

function WarehouseTable() {
  const { warehouseTypes } = useDict()
  const fields: FieldDef[] = [
    // 编码是**历史引用的键**（库存流水 / 单据按它引用仓库）：建的时候必填，改的时候只读。
    // 后端也拒（WAREHOUSE_CODE_IMMUTABLE）—— 这里只读是让用户不用先撞墙。
    { key: 'code', label: '仓库编码', width: 110, required: true, readOnlyOnEdit: true, hint: '唯一；建成后不可修改' },
    { key: 'name', label: '仓库名称', width: 200, required: true },
    {
      key: 'type',
      label: '仓库类型',
      width: 110,
      type: 'select',
      options: warehouseTypes,
      default: 'central',
      hint: '类型直接用在这里 —— 新建时就能选到「不合格品仓 / 待检品仓」',
      render: (r) => warehouseTypes.find((x) => x.value === r.type)?.label || r.type
    },
    { key: 'store_id', label: '所属门店 ID', width: 110, align: 'right', type: 'number' },
    { key: 'manager', label: '负责人', width: 90 },
    { key: 'phone', label: '电话', width: 130 },
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
      hint: '停用后：新建单据不能再选它（下拉里不再出现、接口也会拒）；历史单据与报表不受影响',
      render: (r) => <Status value={r.status} />
    },
    { key: 'address', label: '地址', span: 2, formOnly: true }
  ]
  return (
    <DataPage
      title="仓库"
      desc="客户可自行新建。类型：中心总仓 / 区域仓 / 门店仓 / 电商仓 / 中央厨房仓 / 前置仓 / 云仓 / 不合格品仓 / 待检品仓 / 普通仓。仓库不允许删除（历史单据按它记录「这批货当时在哪」），不用了就改「停用」。"
      path="/master/warehouses"
      fields={fields}
      // 删除被后端明确拒绝（WAREHOUSE_NO_DELETE），所以这里也不给按钮 ——
      // 留着它只会让人点一下、吃一个错，然后去问"为什么不能删"。
      allowDelete={false}
      emptyScopeText="当前账号的数据范围内没有仓库：仓库列表和各单据里的仓库下拉都按您账号所属组织的数据范围裁剪（不是系统里没有仓库）。请到「我的数据范围」核对，或联系管理员调整组织 / 数据范围。"
      excelName="仓库"
    />
  )
}

function StoreTable() {
  const { storeTypes } = useDict()
  const fields: FieldDef[] = [
    { key: 'code', label: '门店编码', width: 110, required: true },
    { key: 'name', label: '门店名称', width: 210, required: true },
    {
      key: 'type',
      label: '门店类型',
      width: 100,
      type: 'select',
      options: storeTypes,
      default: 'direct',
      render: (r) => storeTypes.find((x) => x.value === r.type)?.label || r.type
    },
    { key: 'region', label: '大区', width: 80 },
    { key: 'city', label: '城市', width: 90 },
    { key: 'manager', label: '店长', width: 90 },
    { key: 'phone', label: '电话', width: 130 },
    { key: 'open_date', label: '开业日期', width: 120, type: 'date' },
    {
      key: 'status',
      label: '状态',
      width: 80,
      type: 'select',
      options: [
        { value: 'active', label: '营业中' },
        { value: 'inactive', label: '已停业' }
      ],
      default: 'active',
      render: (r) => <Status value={r.status} />
    },
    { key: 'address', label: '地址', span: 2, formOnly: true }
  ]
  return <DataPage title="门店" desc="线下直营店 / 加盟店 / 商场专柜" path="/master/stores" fields={fields} excelName="门店" />
}

function UserTable() {
  const { roles } = useDict()
  const fields: FieldDef[] = [
    { key: 'username', label: '登录账号', width: 120, required: true },
    { key: 'name', label: '姓名', width: 110, required: true },
    {
      key: 'role',
      label: '角色',
      width: 110,
      type: 'select',
      options: roles,
      required: true,
      render: (r) => roles.find((x) => x.value === r.role)?.label || r.role
    },
    { key: 'dept', label: '部门', width: 110 },
    { key: 'phone', label: '手机', width: 130 },
    { key: 'dealer_id', label: '绑定经销商 ID', width: 130, align: 'right', type: 'number', hint: '角色为经销商时必填' },
    { key: 'store_id', label: '绑定门店 ID', width: 120, align: 'right', type: 'number', hint: '角色为门店店长时必填' },
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
  return <DataPage title="内部用户" desc="组织与账号对应关系" path="/auth/users" fields={fields} excelName="用户" />
}

export default function Org() {
  const [tab, setTab] = useState('warehouse')
  return (
    <div>
      <h1 className="text-[17px] font-medium text-slate-800 mb-1">仓库与门店</h1>
      <p className="text-[12px] text-slate-400 mb-3">存货节点（仓库）与线下零售节点（门店）</p>
      <Card pad={false}>
        <div className="px-3 pt-2">
          <Tabs
            tabs={[
              { key: 'warehouse', label: '仓库' },
              { key: 'store', label: '门店' }
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>
      <div className="mt-3">{tab === 'warehouse' ? <WarehouseTable /> : <StoreTable />}</div>
    </div>
  )
}
