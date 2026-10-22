/**
 * ============================================================================
 * 文件标识：server/middleware/mall-session.js ｜ C 端（商城 H5）会话 —— **唯一实现**
 * ============================================================================
 * 【职责】C 端（商城 H5）会话 —— **唯一实现**
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// C 端（商城 H5）会话 —— **唯一实现**
//
// 为什么单独抽一个文件：C 端会话原来只长在 `routes/mall.js` 里，而 `routes/promo.js`
// 的 `/api/promo/shop/*` 三个端点是另一套口径 ——「**免登录，手机号即身份**」，
// 身份直接从 `req.query.phone` / `req.body.phone` 取。那是 A16 定性的漏洞形态：
//
//   · 手机号是**公开标识**（印在快递单上），不是凭据；
//   · 知道一个手机号就能读他的会员等级、积分、储值、券包，还能替他领券。
//
// A16 收口时只改了 `routes/mall.js`，`/api/promo/shop/*` 是**漏网的那一个入口**——
// 这正是"逐个接口手写用例挡不住"的那类漏（漏掉的那个永远不会出现在清单里）。
//
// 所以这里不是"把 mall.js 的两段代码搬个家"，而是把 C 端身份收成**一处**：
//   · `signMallToken`  签发（登录时）
//   · `requireMall`    校验（凡是"我的数据"的端点一律用它）
// 任何需要"C 端身份"的地方都从 `req.mall` 取，**不再从请求体/查询串读 phone**。
//
// 令牌口径（与 A16 一致，不要改）：
//   · audience `gml-mall`，与后台令牌 `gml-erp` 互不通用；
//   · `industry` **签进令牌**，签发时确定、之后不可改
//     （`server/index.js` 同时解析 `Authorization` 与 `x-mall-token`，
//      并把令牌里的行业钉死 —— 请求头改不了它）。
import jwt from 'jsonwebtoken'
import { fail } from '../lib/http.js'
import { getCurrentIndustry } from '../db/index.js'
import { JWT_SECRET } from './auth.js'

export const MALL_AUD = 'gml-mall'
export const MALL_TOKEN_EXPIRES = '30d'

export function signMallToken(customer, industry) {
  return jwt.sign(
    { cid: customer.id, phone: customer.phone, role: 'mall', industry },
    JWT_SECRET,
    { expiresIn: MALL_TOKEN_EXPIRES, audience: MALL_AUD }
  )
}

/** C 端会话门：身份只认会话，不认请求里的 phone */
export function requireMall(req, res, next) {
  const raw = String(req.headers['x-mall-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!raw) return fail(res, '请先登录', 401, 401)
  try {
    const p = jwt.verify(raw, JWT_SECRET, { audience: MALL_AUD })
    if (p.role !== 'mall' || !p.phone) return fail(res, '登录状态无效，请重新登录', 401, 401)
    // 行业必须与令牌一致：`index.js` 已按令牌钉死行业，这里再判一次是**防回归** ——
    // 万一将来有人把"令牌带 industry"删掉、行业退回由头决定，这条会立刻红。
    if (p.industry && p.industry !== getCurrentIndustry()) {
      return fail(res, '登录状态与当前行业不一致，请重新登录', 401, 401)
    }
    req.mall = { id: p.cid, phone: String(p.phone), industry: p.industry || null }
    next()
  } catch {
    return fail(res, '登录状态无效，请重新登录', 401, 401)
  }
}

/**
 * 从会话身份取出**会员档案**（`mall_customers` 行）。
 * 找不到就是"这个手机号还没注册过" —— 返回 null，由调用方决定是报错还是走匿名口径，
 * **不要在这里顺手建一条**：建档是登录的职责，散落在各端点会让"谁建的档"说不清。
 */
export function mallCustomer(db, mall) {
  if (!mall?.phone) return null
  return db.prepare('SELECT * FROM mall_customers WHERE phone=?').get(mall.phone) || null
}

export default { MALL_AUD, MALL_TOKEN_EXPIRES, signMallToken, requireMall, mallCustomer }
