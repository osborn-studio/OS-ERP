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
import { Status, useFetch } from '../../components/ui'
import { useDict, useOpts } from '../../hooks/opts'
import { DATA_SCOPES, ORG_CLEAR, flattenOrgTree, prepareUserPayload, userFieldVisible } from './user-form'

export default function Users() {
  const { roles } = useDict()
  const o = useOpts()
  const { data: orgData } = useFetch<any>('/auth/org-tree', undefined, [])
  const orgOpts = flattenOrgTree(orgData?.tree)
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
      render: (r) => (
        <span>
          {roles.find((x) => x.value === r.role)?.label || r.role}
          {/* AH10：主角色已停用的账号 —— 点该行"编辑"改上面的角色字段即为"重新指派主角色"（不另建编辑器） */}
          {r.role_status === 'inactive' && (
            <span className="ml-1 text-[11px] text-amber-700" data-testid="primary-role-inactive-tag" title="主角色已停用：点编辑，在角色字段重新指派主角色">
              （已停用·请重新指派主角色）
            </span>
          )}
        </span>
      )
    },
    { key: 'dept', label: '部门', width: 110 },
    { key: 'phone', label: '手机', width: 130 },
    {
      key: 'org_id',
      label: '所属组织',
      type: 'select',
      options: [...orgOpts, { value: ORG_CLEAR, label: '（清除所属组织）' }],
      formOnly: true,
      emptyLabel: '不修改（新建则不设置）',
      hint: '当前值不在列表接口中返回，故默认不修改；选项取自组织树（按你的数据范围裁剪）'
    },
    {
      key: 'data_scope',
      label: '数据范围',
      type: 'select',
      options: DATA_SCOPES.map(({ value, label }) => ({ value, label })),
      formOnly: true,
      emptyLabel: '不修改（新建则沿用角色默认）'
    },
    {
      key: 'dealer_id', label: '绑定经销商', width: 190, type: 'select', options: o.dealers, formOnly: true,
      showWhen: (f) => userFieldVisible('dealer_id', f), render: (r) => r.dealer_name || '—'
    },
    {
      key: 'store_id', label: '绑定门店', width: 180, type: 'select', options: o.stores, formOnly: true,
      showWhen: (f) => userFieldVisible('store_id', f), render: (r) => r.store_name || '—'
    },
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
      preparePayload={(body, context) => prepareUserPayload(body, context, { ...o, orgs: orgOpts })}
      formNotice={(form) => {
        const scope = DATA_SCOPES.find((x) => x.value === (form.data_scope || ''))
        return (
          <div className="mb-3 space-y-2 text-[12px]">
            {form.role === 'admin' && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700" data-testid="admin-scope-note">
                管理员角色恒为「全部数据」，下面选择的数据范围对管理员不生效。
              </div>
            )}
            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600" data-testid="scope-hint">
              {scope
                ? <>数据范围「{scope.label}」：{scope.hint}{scope.value === 'all' && <b className="text-red-600"> 将可见全部组织数据。</b>}</>
                : <>未选择数据范围：新建账号沿用所选角色的默认范围，编辑时保持账号当前设置（更换角色会改变沿用的默认范围）。部分角色（如老板/财务/访客）默认是全部数据，请确认。</>}
            </div>
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800" role="alert" data-testid="revoke-warning">
              安全提示：保存时若该账号的角色、状态、所属组织、数据范围、绑定经销商/门店或密码实际发生变化，
              该用户的所有登录会话会立即失效，需要重新登录（修改自己的账号也会把你自己登出）；仅修改姓名、部门、手机不会。
              填写新密码即使与旧密码相同也会登出。选择「不修改」的所属组织/数据范围不会发送，保持账号当前值。
            </div>
          </div>
        )
      }}
      excelName="用户"
      filters={[{ key: 'role', type: 'select', label: '全部角色', options: roles }]}
    />
  )
}
