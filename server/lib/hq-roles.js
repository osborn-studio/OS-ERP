/**
 * ============================================================================
 * 文件标识：server/lib/hq-roles.js ｜ 总部角色名单（唯一来源，ADR-0051）
 * ============================================================================
 * 【职责】"哪些角色名算总部角色"的唯一出处。原来 `routes/pos.js` 的 `HQ_ROLES`（4 个）与
 *   `routes/requisitions.js` 的 `HQ`（6 个）各写一份且不同；现在三类用法从同一张表派生：
 *     · `HQ_ROLES`              —— 并集：不受门店绑定约束的总部角色（`/api/docflow/*` 严格绑定的豁免名单）；
 *     · `POS_HQ_ROLES`          —— POS 总部接口（`/hq/*`、日结确认、跨店结算）的路由闸，与改动前逐项相同；
 *     · `REQUISITION_HQ_ROLES`  —— 门店要货 / 发货总部接口的路由闸，与改动前逐项相同。
 *   每个角色为何在表里、在哪个面生效，见 ADR-0051。
 *
 * 【改它要注意什么】只增不减要走 ADR：往 `HQ_ROLES` 加角色 = 该角色在 docflow 里重新可见 RC / YQ / SH。
 *   POS / 要货两个面是否也放行，是各自独立的标志，不要为了"统一"把 purchase / scm 放进 POS 闸。
 * ============================================================================
 */
const TABLE = Object.freeze({
  admin: { pos: true, requisition: true },
  finance: { pos: true, requisition: true },
  sales: { pos: true, requisition: true },
  warehouse: { pos: true, requisition: true },
  purchase: { pos: false, requisition: true },
  scm: { pos: false, requisition: true }
})

const pick = (flag) => Object.freeze(Object.keys(TABLE).filter((r) => (flag ? TABLE[r][flag] : true)))

export const HQ_ROLES = pick(null)
export const POS_HQ_ROLES = pick('pos')
export const REQUISITION_HQ_ROLES = pick('requisition')

/** 角色名是否总部角色（并集口径）。 */
export function isHqRole(role) {
  return typeof role === 'string' && Object.prototype.hasOwnProperty.call(TABLE, role)
}
