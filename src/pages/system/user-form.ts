/**
 * ============================================================================
 * 文件标识：src/pages/system/user-form.ts ｜ 用户管理表单的请求契约；不放宽服务端校验
 * ============================================================================
 */
type SubjectOption = { value: unknown }
type Options = { dealers: readonly SubjectOption[]; stores: readonly SubjectOption[]; orgs?: readonly SubjectOption[] }

/**
 * data_scope 取值与 server/lib/account-security.js 的白名单一致（'' | all | subtree | org | self | dealer）。
 * 表单里 value 为 ROLE_DEFAULT 的选项发送 ''（沿用角色默认）；空选择表示「不修改」，不发送该字段。
 * 服务端不接受 store / none：门店账号靠角色 + 所属组织(org)收口，「无数据」是 org/subtree/self 缺所属组织时的结果。
 */
export const ROLE_DEFAULT = 'role_default'
export const ORG_CLEAR = '__clear_org'
export const DATA_SCOPES: readonly { value: string; label: string; hint: string }[] = [
  { value: ROLE_DEFAULT, label: '沿用角色默认', hint: '按该角色的默认数据范围；部分角色（如老板/财务/访客）默认是全部数据，请确认。' },
  { value: 'all', label: '全部数据', hint: '可见所有组织的数据，请谨慎授予。' },
  { value: 'subtree', label: '本组织及下级', hint: '所属组织及其全部下级组织；必须选择所属组织，否则看不到任何数据。' },
  { value: 'org', label: '仅本组织', hint: '只看所属组织（如店长）；必须选择所属组织，否则看不到任何数据。' },
  { value: 'self', label: '仅本人', hint: '只看本人相关数据；必须选择所属组织，否则看不到任何数据。' },
  { value: 'dealer', label: '仅本经销商', hint: '只看绑定经销商的数据；必须绑定经销商，否则看不到任何数据。' }
]
const ORG_SCOPES = ['subtree', 'org', 'self']

type OrgNode = { id: number; name?: string; short_name?: string; children?: OrgNode[] }
/** /api/auth/org-tree 的 tree -> 缩进后的下拉选项（有深度上限，防环）。 */
export function flattenOrgTree(tree: readonly OrgNode[] | null | undefined): { value: number; label: string }[] {
  const out: { value: number; label: string }[] = []
  const seen = new Set<number>()
  const walk = (nodes: readonly OrgNode[] | undefined, depth: number) => {
    if (!nodes || depth > 12) return
    for (const n of nodes) {
      if (!Number.isSafeInteger(n.id) || n.id <= 0 || seen.has(n.id)) continue
      seen.add(n.id)
      out.push({ value: n.id, label: `${'　'.repeat(depth)}${depth ? '└ ' : ''}${n.name || n.short_name || '组织' + n.id}` })
      walk(n.children, depth + 1)
    }
  }
  walk(tree || undefined, 0)
  return out
}

const filled = (v: unknown) => v !== null && v !== undefined && v !== ''

/** 绑定字段的显示条件：与当前角色/数据范围相关，或已有绑定值（让运维看得到并能清除旧绑定）。 */
export function userFieldVisible(key: string, form: Record<string, any>): boolean {
  if (key === 'dealer_id') return form.data_scope === 'dealer' || form.role === 'dealer' || filled(form.dealer_id)
  if (key === 'store_id') return form.role === 'store' || filled(form.store_id)
  return true
}

const CREATE_FIELDS = ['username', 'password', 'name', 'role', 'dept', 'phone', 'dealer_id', 'store_id', 'status', 'org_id', 'data_scope']
const EDIT_FIELDS = CREATE_FIELDS.filter(k => k !== 'username')

function subjectId(value: unknown, options: readonly SubjectOption[], label: string): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`请重新选择有效${label}`)
  // DOM select values are strings. Restore only the exact selected option's
  // numeric identity; never coerce arbitrary numeric-looking request values.
  const selected = options.find(option => typeof option.value === 'number' &&
    Number.isSafeInteger(option.value) && option.value > 0 && String(option.value) === String(value))
  if (!selected) throw new Error(`请重新选择有效${label}`)
  return selected.value as number
}

export function prepareUserPayload(body: Record<string, any>, { isEditing }: { isEditing: boolean }, options: Options) {
  // Allow-list: only field names PUT/POST /api/auth/users accept; formOnly display columns
  // (last_login_at) and anything else never reach the API.
  const payload: Record<string, any> = {}
  for (const key of isEditing ? EDIT_FIELDS : CREATE_FIELDS) if (Object.prototype.hasOwnProperty.call(body, key)) payload[key] = body[key]
  payload.dealer_id = subjectId(body.dealer_id, options.dealers, '经销商')
  payload.store_id = subjectId(body.store_id, options.stores, '门店')
  // org_id / data_scope are not returned by GET /auth/users, so an untouched control means
  // "leave unchanged" (field omitted) -- never null/'' which would clear org or reset scope.
  delete payload.org_id; delete payload.data_scope
  if (filled(body.org_id)) {
    payload.org_id = body.org_id === ORG_CLEAR ? null : subjectId(body.org_id, options.orgs || [], '所属组织')
  }
  if (filled(body.data_scope)) {
    if (body.data_scope === ROLE_DEFAULT) payload.data_scope = ''
    else if (typeof body.data_scope === 'string' && DATA_SCOPES.some(s => s.value === body.data_scope)) payload.data_scope = body.data_scope
    else throw new Error('请重新选择有效数据范围')
  }
  const scope = payload.data_scope
  if (scope === 'dealer' && payload.dealer_id === null) throw new Error('数据范围为「仅本经销商」时必须绑定经销商')
  if (ORG_SCOPES.includes(scope) && (isEditing ? payload.org_id === null : !payload.org_id)) throw new Error('该数据范围必须选择所属组织')
  // Only this page interprets its untouched/cleared password control as "keep".
  // The API continues to reject an explicitly supplied null password.
  if (isEditing && (body.password === null || body.password === undefined || body.password === '')) delete payload.password
  return payload
}
