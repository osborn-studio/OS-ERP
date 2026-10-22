/**
 * ============================================================================
 * 文件标识：src/pages/system/Users.tsx ｜ 用户与权限
 * ============================================================================
 * 【职责】用户与权限（页面）
 * 【入口】/system/users
 * 【主要接口】/auth/users
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
 * 页面：用户与权限
 */

import DataPage, { FieldDef } from '../../components/DataPage'
import { Status } from '../../components/ui'
import { useDict, useOpts } from '../../hooks/opts'
import { prepareUserPayload } from './user-form'

export default function Users() {
  const { roles } = useDict()
  const o = useOpts()
  const fields: FieldDef[] = [
    { key: 'username', label: '登录账号', width: 130, required: true, hint: '创建后不可修改' },
    { key: 'password', label: '密码', width: 0, type: 'password', formOnly: true, hint: '新增必填；编辑留空不修改。至少16个字符、6种不同字符，最多72个UTF-8字节' },
    { key: 'name', label: '姓名', width: 110, required: true },
    {
      key: 'role',
      label: '角色',
      width: 120,
      type: 'select',
      options: roles,
      required: true,
      default: 'viewer',
      render: (r) => roles.find((x) => x.value === r.role)?.label || r.role
    },
    { key: 'dept', label: '部门', width: 110 },
    { key: 'phone', label: '手机', width: 130 },
    { key: 'dealer_id', label: '绑定经销商', width: 190, type: 'select', options: o.dealers, formOnly: true, render: (r) => r.dealer_name || '—' },
    { key: 'store_id', label: '绑定门店', width: 180, type: 'select', options: o.stores, formOnly: true, render: (r) => r.store_name || '—' },
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
    { key: 'last_login_at', label: '最近登录', width: 165, formOnly: true }
  ]
  return (
    <DataPage
      title="用户与权限"
      desc="8 类角色：管理员 / 采购 / 销售 / 仓储 / 财务 / 经销商 / 门店 / 只读。经销商与门店账号自动限定数据范围"
      path="/auth/users"
      fields={fields}
      preparePayload={(body, context) => prepareUserPayload(body, context, o)}
      excelName="用户"
      filters={[{ key: 'role', type: 'select', label: '全部角色', options: roles }]}
    />
  )
}
