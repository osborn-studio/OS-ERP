/**
 * ============================================================================
 * 文件标识：server/lib/store-binding.js ｜ 门店绑定判据（POS / 门店要货 / 发货 / 单据内核共用）
 * ============================================================================
 * 【职责】"账号绑了哪家门店""谁不受门店绑定约束"的唯一判据。POS 路由（pos.js storeCtx / requireStore）、
 *   门店要货路由（requisitions.js storeCtx）与单据范围注册表（docflow.js `DOC_SCOPE_RESOLVERS` 的
 *   `binding: 'store'` 行：RC / YQ / SH，ADR-0011 AB7 补充）都调用这里，MCP 读工具经注册表自动得到同一规则。
 *
 * 【改它要注意什么】只做纯函数、不碰库、不拼 SQL（SQL 谓词只在 docflow.js 的 store 构建器里有一份）。
 *   admin 豁免与 HTTP `requireStore` 一致（总部可代门店操作）；其余角色的"总部跨店"口径仍由各路由的角色名闸决定，
 *   MCP 不复刻角色名，改为严格模式（未绑门店 ⇒ 不可见），见 ADR-0011。
 * ============================================================================
 */

/** 账号绑定的门店 id（正整数）；未绑定 / 非法 ⇒ null。 */
export function boundStoreId(user) {
  if (!user || user.store_id == null || user.store_id === '') return null
  const n = Number(user.store_id)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 不受门店绑定约束的账号：admin（HTTP requireStore 对 admin 放行）与超管（`is_super`，与 MCP doc-perms 的 isSuper 豁免同口径）。 */
export function storeBindingExempt(user) {
  return !!user && (user.role === 'admin' || user.is_super === 1 || user.is_super === true)
}

/** 账号绑定的经销商 id（正整数）；未绑定 / 非法 ⇒ null（`dealerCtx` 的 `u.dealer_id` 判据，demand.js）。 */
export function boundDealerId(user) {
  if (!user || user.dealer_id == null || user.dealer_id === '') return null
  const n = Number(user.dealer_id)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 外部订货主体账号（role=dealer|store）：订货中心 `selfCustomerId` 的判据，只看自己的订货档案。 */
export function isExternalSubject(user) {
  return !!user && (user.role === 'dealer' || user.role === 'store')
}
