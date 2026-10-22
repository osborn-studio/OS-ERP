/**
 * ============================================================================
 * 文件标识：src/constants/capabilities.ts ｜ 「这个行业版本有没有这个概念」的**唯一出处**
 * ============================================================================
 * 【它和权限（roles）不是一回事】
 *   · `roles`      —— 这个**人**能不能看（谁被授权）；
 *   · capability   —— 这个**行业版本**有没有这个概念（业务形态）。
 *   经销商就是一个典型：**美妆连锁 / 服装有、连锁餐饮没有**（总部直营门店 + 供应商，
 *   不存在分销层）。所以"餐饮管理员看不到经销商"**不是权限不足**，是这个行业没有这个东西。
 *   把两者混成一个判断，会让客户以为"再给个人权限就能看见"，而其实永远不该出现。
 *
 * 【客户口径（2026-10-17）】
 *   「连锁餐饮版里的经销商全部去掉。但化妆品版那个不要啊，记住。」
 *   ⇒ 餐饮：菜单 + 页面内入口 + 直接敲 URL 都不出现；
 *     美妆：**一个字都不动**。
 *
 * 【纪律】
 *   页面里判断"要不要显示经销商"，一律调 `hasDealer(industry)`，
 *   **不要在页面里写 `industry !== 'food'`** —— 那样下次加行业时必然漏一处。
 * ============================================================================
 */
/** 有经销商（分销层）的行业。加行业时**默认没有**，要显式加进来。 */
const DEALER_INDUSTRIES = ['cosmetic', 'apparel'] as const

/** 这个行业版本有没有「经销商」这个概念 */
export function hasDealer(industry: string | null | undefined): boolean {
  return !!industry && (DEALER_INDUSTRIES as readonly string[]).includes(industry)
}

/**
 * 只有"有经销商"的行业才能进的页面路径（前缀匹配）。
 * 用途：直接敲 URL 也要拦住 —— 菜单藏起来只挡得住"点"，挡不住"贴地址"。
 */
export const DEALER_ONLY_PATHS = [
  '/dealers',
  '/dms/channel',
  '/demand/dealer-requisitions'
] as const

/** 路径是否属于"经销商专属页" */
export function isDealerOnlyPath(pathname: string): boolean {
  return DEALER_ONLY_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))
}
