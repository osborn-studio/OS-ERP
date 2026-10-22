/**
 * ============================================================================
 * 文件标识：src/pages/system/user-form.ts ｜ 用户管理表单的请求契约；不放宽服务端校验
 * ============================================================================
 */
type SubjectOption = { value: unknown }
type Options = { dealers: readonly SubjectOption[]; stores: readonly SubjectOption[] }

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
  const payload = { ...body }
  payload.dealer_id = subjectId(body.dealer_id, options.dealers, '经销商')
  payload.store_id = subjectId(body.store_id, options.stores, '门店')
  // Only this page interprets its untouched/cleared password control as "keep".
  // The API continues to reject an explicitly supplied null password.
  if (isEditing && (body.password === null || body.password === undefined || body.password === '')) delete payload.password
  return payload
}
