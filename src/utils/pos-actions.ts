/**
 * ============================================================================
 * 文件标识：src/utils/pos-actions.ts ｜ POS 动作按钮的可见 / 可用选择器（纯函数，ADR-0025）
 * ============================================================================
 * 【职责】由 `{ permissions, shift, cashDrop, currentUser }` 决定每个 POS 动作按钮：
 *   `visible`（持有对应权限点且单据状态适用）与 `enabled`（可见但当前不能点）及 `reason`（不能点的原因，页面照原文展示）。
 *   - 无权限点 → 不可见（隐藏，不是置灰）；权限未加载（null / undefined）→ 也不可见，避免先闪出再收回。
 *   - 交班核款 / 退回：当前用户是开班人（cashier_id，缺 id 时按姓名 / 账号兜底，口径同服务端 assertShiftChecker）
 *     → 可见但禁用，原因 POS_SELF_APPROVE（需另一人复核）。admin 不豁免。
 *   - 接收缴款：缴款人（handed_by）是当前用户 → 可见但禁用（SAME_PERSON）。
 *   - 作废订单需 pos.refund（order_void）；差异结案需 pos.shift.settle（variance_settle，AA9）。
 *   - 作废已报数的班次另需 pos.shift.review（服务端在路由里补的校验）。
 * 【不变量 / 边界】这只是体验层提示，不替代服务端授权：服务端仍会拒绝（403 / 404 / 409）。
 *   客户端看不到 doc_events 里"代他人报数"的人，所以服务端可能对"看似可点"的核款仍返回 409 POS_SELF_APPROVE，
 *   页面必须照常展示服务端错误。权限含 '*' 视为全开（同 hasPerm）；admin 的 my-permissions 本身返回全部权限点。
 * ============================================================================
 */
export type PosActionKey =
  | 'shift_open' | 'shift_declare' | 'shift_approve' | 'shift_reject' | 'shift_cancel'
  | 'cashdrop_create' | 'cashdrop_receive' | 'cashdrop_cancel'
  | 'daily_close' | 'stock_check_create' | 'stock_check_adjust'
  | 'order_void' | 'variance_settle'

export type PosActionState = { visible: boolean; enabled: boolean; reason: string }
export type PosActions = Record<PosActionKey, PosActionState>
export type PosUser = { id?: number | string | null; name?: string | null; username?: string | null } | null | undefined
export type PosActionInput = {
  permissions?: string[] | null
  currentUser?: PosUser
  /** 班次：{ status, cashier_id, cashier_name } */
  shift?: { status?: string | null; cashier_id?: number | string | null; cashier_name?: string | null } | null
  /** 缴款单：{ status, handed_by } */
  cashDrop?: { status?: string | null; handed_by?: number | string | null; handed_by_name?: string | null } | null
  /** 日结门禁（ctx.daily_close_gate）：ok === false 时禁用并说明 */
  dailyCloseGate?: { ok?: boolean; blocking?: unknown[] } | null
}

export const PERM = {
  shift: 'pos.shift',
  review: 'pos.shift.review',
  cashdrop: 'pos.cashdrop',
  receive: 'pos.cashdrop.receive',
  dailyclose: 'pos.dailyclose',
  check: 'pos.store.check',
  refund: 'pos.refund',
  settle: 'pos.shift.settle'
} as const

export const SELF_APPROVE_REASON = '你开班或报数的班次不能由自己核款 / 退回，需另一人复核（POS_SELF_APPROVE）'
export const SAME_PERSON_REASON = '缴款人与接收人不能是同一人，需另一人点收（SAME_PERSON）'
export const DAILY_CLOSE_BLOCKED_REASON = '还有班次未核款，核款完成后才能日结'

const HIDDEN: PosActionState = { visible: false, enabled: false, reason: '' }
const on = (): PosActionState => ({ visible: true, enabled: true, reason: '' })
const off = (reason: string): PosActionState => ({ visible: true, enabled: false, reason })

export function hasPosPerm(permissions: string[] | null | undefined, code: string): boolean {
  if (!Array.isArray(permissions)) return false
  return permissions.includes(code) || permissions.includes('*')
}

const str = (v: unknown) => (v == null ? '' : String(v).trim())

/** 与服务端 assertShiftChecker 同口径：有 id 按 id，否则按姓名 / 账号。 */
export function isShiftMaker(shift: PosActionInput['shift'], user: PosUser): boolean {
  if (!shift || !user) return false
  if (shift.cashier_id != null && str(shift.cashier_id) !== '') {
    return user.id != null && Number(shift.cashier_id) === Number(user.id)
  }
  const cashier = str(shift.cashier_name)
  return !!cashier && (cashier === str(user.name) || cashier === str(user.username))
}

export function selectPosActions(input: PosActionInput): PosActions {
  const p = input.permissions
  const has = (c: string) => hasPosPerm(p, c)
  const status = str(input.shift?.status)
  const all = (state: PosActionState): PosActions => ({
    shift_open: state, shift_declare: state, shift_approve: state, shift_reject: state, shift_cancel: state,
    cashdrop_create: state, cashdrop_receive: state, cashdrop_cancel: state,
    daily_close: state, stock_check_create: state, stock_check_adjust: state,
    order_void: state, variance_settle: state
  })
  if (!Array.isArray(p)) return all(HIDDEN)

  const out = all(HIDDEN)
  if (has(PERM.shift)) {
    out.shift_open = on()
    out.shift_declare = on()
    // 已报数的班次作废另需 pos.shift.review（pos.js /shifts/:id/cancel）
    if (status === 'declared') out.shift_cancel = has(PERM.review) ? on() : HIDDEN
    else out.shift_cancel = on()
  }
  if (has(PERM.review)) {
    const self = isShiftMaker(input.shift, input.currentUser)
    const mk = () => (self ? off(SELF_APPROVE_REASON) : on())
    out.shift_approve = mk()
    out.shift_reject = mk()
  }
  if (has(PERM.cashdrop)) {
    out.cashdrop_create = on()
    out.cashdrop_cancel = on()
  }
  if (has(PERM.receive)) {
    const d = input.cashDrop
    const u = input.currentUser
    const same = !!d && !!u && d.handed_by != null && str(d.handed_by) !== '' && u.id != null && Number(d.handed_by) === Number(u.id)
    out.cashdrop_receive = same ? off(SAME_PERSON_REASON) : on()
  }
  if (has(PERM.dailyclose)) {
    out.daily_close = input.dailyCloseGate && input.dailyCloseGate.ok === false ? off(DAILY_CLOSE_BLOCKED_REASON) : on()
  }
  if (has(PERM.refund)) out.order_void = on()
  if (has(PERM.settle)) out.variance_settle = on()
  if (has(PERM.check)) {
    out.stock_check_create = on()
    out.stock_check_adjust = on()
  }
  return out
}
