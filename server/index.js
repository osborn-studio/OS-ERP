/**
 * ============================================================================
 * 文件标识：server/index.js ｜ 服务入口（Express 装配 + 启动顺序 + 路由挂载）
 * ============================================================================
 * 【启动顺序是有讲究的，别随手调】
 *   1) 装中间件（JSON / 静态 / 日志）→ 2) 挂 `/api` 业务路由 → 3) 挂 `/mcp`（协议端点）
 *   → 4) 静态前端 + SPA 兜底 → 5) 全局错误处理（**必须最后**，否则前面的 404/异常不会被它兜住）。
 *
 * 【两套入口，别混】
 *   · `/api/**`  REST 给人和前端用（JWT）；
 *   · `/mcp`     MCP 协议给 AI 用（Agent Token，JSON-RPC 2.0）。
 *   两者**共用同一份领域服务与判据**（`lib/*`），不存在"AI 走另一套逻辑"。
 *
 * 【改这里要注意】
 *   · 新增路由文件 → 在下面挂载，并同步 `server/openapi.js`（`npm run gen:api` 会重生成前端类型）；
 *   · 挂载前缀会被 `scripts/check-contract-routes.mjs` 反向解析，**写法必须是 `app.use('/api/x', xRoutes)`**；
 *   · 静态兜底必须排在 API 之后，否则 `/api/xxx` 会被 SPA 的 `index.html` 吃掉（返回 200 + HTML）。
 * ============================================================================
 */
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ROOT_DIR, INDUSTRIES, DEFAULT_INDUSTRY, runWithIndustry, normalizeIndustry, dbPathFor } from './db/index.js'
import { errorHandler } from './middleware/audit.js'
import { requireAuth, JWT_SECRET, assertJwtSecretPosture, isTokenInvalid } from './middleware/auth.js'
import jwt from 'jsonwebtoken'
import authRoutes from './routes/auth.js'
import masterRoutes from './routes/master.js'
import purchaseRoutes from './routes/purchase.js'
import salesRoutes from './routes/sales.js'
import inventoryRoutes from './routes/inventory.js'
import dealerRoutes from './routes/dealers.js'
import omsRoutes from './routes/oms.js'
import posRoutes from './routes/pos.js'
import mallRoutes from './routes/mall.js'
import qimenRoutes from './routes/qimen.js'
import dashboardRoutes from './routes/dashboard.js'
import aiRoutes from './routes/ai.js'
import metaRoutes from './routes/meta.js'
import requisitionRoutes from './routes/requisitions.js'
import outsourcingRoutes from './routes/outsourcing.js'
import demandRoutes from './routes/demand.js'
import pricingRoutes from './routes/pricing.js'
import docflowRoutes from './routes/docflow.js'
import orderCenterRoutes from './routes/order-center.js'
import purchaseChainRoutes from './routes/purchase-chain.js'
import notifyRoutes from './routes/notify.js'
import approvalRoutes from './routes/approval.js'
import metricsRoutes from './routes/metrics.js'
import qcRoutes from './routes/qc.js'
import costingRoutes from './routes/costing.js'
// 模块 08A：销售报价单（挂 /api/sales，与销售订单同源前缀）+ 信用控制（独立前缀）
import quoteRoutes from './routes/quote.js'
import creditRoutes from './routes/credit.js'
// 模块 21：应收与收款核销（财务域，独立前缀）
import arRoutes from './routes/ar.js'
// 模块 24：销售发票（销售域，独立前缀 —— 发票是「票」，与订单/发货单的「货」分开管）
import invoiceRoutes from './routes/invoice.js'
import qc2Routes from './routes/qc2.js'
// 模块 10B：BOM 与报工领料（制造域，独立前缀 —— 计划归 demand，执行归 manufacture）
import manufactureRoutes from './routes/manufacture.js'
// 模块 18：促销与会员（营销域，独立前缀 —— /api/mall 是免登录的 C 端通道，
// 而活动配置/发券/调积分要按权限管控，两类信任级别不能挤在一个前缀里）
import promoRoutes from './routes/promo.js'
// 渠道管理（批次 G）：协议价档案 + 返利计提/试算/核销
import dmsRoutes from './routes/dms.js'
import accountingRoutes from './routes/accounting.js'
import reportRoutes from './routes/report.js'
import refundRoutes from './routes/refund.js'
// 钉钉 / 飞书 组织与审批同步（批次 T）
import imRoutes from './routes/im.js'
// 副作用导入：审批引擎在加载时把自己的闸门注册进单据内核（见 lib/approval.js）。
// 这里显式引入一次，保证任何流转发生前闸门一定已挂上 ——
// 只靠路由挂载的话，加载顺序一变闸门就会静默失效。
import './lib/approval.js'
import mcpRoutes from './mcp/server.js'
import mcpAdminRoutes from './mcp/admin.js'
import { buildOpenApi } from './openapi.js'
import { installCapabilityGates, runtimeCapabilities } from './capabilities.js'
// 版本与构建 SHA 的唯一出处（F16）：/api、health、AI manifest、MCP serverInfo 都从这里取
import { versionInfo } from './version.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3001)
const HOST = process.env.HOST || '0.0.0.0'

// A20 残余：**启动闸门**。放在 listen 之前、尽可能靠前 ——
// 生产环境没显式给 GML_JWT_SECRET 就直接抛错退出，绝不拿内置演示密钥对外签发令牌；
// 非生产回退时这里会打一条刺耳的警告（有落点，不静默）。
assertJwtSecretPosture()

const app = express()
app.disable('x-powered-by')
app.use(cors())
app.use(express.json({ limit: '5mb' }))
app.use(express.urlencoded({ extended: true }))
// 在行业、凭据解析与所有业务路由之前拒绝未验收能力；含 MCP 通用工具旁路。
installCapabilityGates(app)

// —— 行业上下文：**令牌里的行业**（签发时确定）**覆盖** `x-industry` 头；都没给出 ⇒ 默认行业 ——
//
// `x-industry` 是**请求方可以随便填的**，而行业决定后面读哪个库 ⇒ 绝不能让头优先于令牌
// （那等于"换个头就能换一个库"）。所以要**先校验头、再由令牌覆盖**。
// C 端会话令牌存在 `x-mall-token`（不走 Authorization），必须**一并解析** ——
// 否则"行业钉死在令牌"只对把令牌塞进 Authorization 的调用方成立（验收侧 §26.2 的观察）。
//
// 【执行顺序与优先级 —— 下面三行**与实测逐条对齐**（改动前请按这个顺序核一遍）】
//   ① 先判 `x-industry` 头（外部可控）：
//        · 缺失（`undefined` / 空串）⇒ 按**默认行业**（"头没带 = 用默认"是正当语义）；
//        · **非法 ⇒ 当场抛**（400 + `INDUSTRY_CODE_INVALID`）——
//          **无论令牌里有没有行业**，都走不到 ②。这是刻意的：带令牌的请求上"头写错"
//          必须响亮报错；若让令牌把它掩盖掉，就新增了一个**永远检不出来**的静默面。
//          实测：`头=foo + 令牌(food)` ⇒ **400**（不是 200）。
//   ② 再看令牌载荷 `industry`（签发时确定）：**存在且合法 ⇒ 覆盖 ① 的结论**。
//        · 实测：`头=apparel + 令牌(food)` ⇒ 读 **food** 库（令牌赢 —— 合法但不同的头被覆盖）；
//        · 令牌里的行业**非法 ⇒ 也当场抛**（令牌是签发的，出现非法码说明**签发侧**有问题，
//          回落会让这张坏令牌一直隐藏下去）；
//        · 令牌**本身无效**（`isTokenInvalid` 白名单：签名错 / 格式错 / aud 不符 / 过期）
//          ⇒ 忽略它，退回 ① 的结论（后续 `requireAuth` 会另行 401）；
//        · 其余**任何**异常（含行业码非法、以及"预期外的 TypeError"）⇒ **上抛拒绝该请求**，
//          **绝不**静默回落默认库（fail-closed；详见下面 catch 里的注释）。
//   ③ ①②都没给出行业 ⇒ 默认行业。
//
// 顺带一条"宁拒不猜"：**同值重复头**（`x-industry: food` 出现两次）在传输层合成
//   `'food, food'` ⇒ 不是合法码 ⇒ **400**。取"第一个"就是回到"猜"，这里不猜。
//
// 旧写法把"缺失"与"非法"合成了一条（`normalizeIndustry` 把任何不认识的值静默归一成 cosmetic）：
// 于是一个打错的 `x-industry` / 一张带着坏行业的令牌，会安静地读到美妆版的库 ——
// 不报错、界面照常出数，跨租户串库**看起来完全正常**。这里宁可拒绝。
app.use((req, res, next) => {
  try {
    // ① `x-industry` 头（外部可控）：缺失 ⇒ 默认；非法 ⇒ normalizeIndustry 抛（下面 catch → 400）
    let industry = normalizeIndustry(req.headers['x-industry'])
    // ② 令牌里的行业（签发时确定）优先于头
    const raw = String(req.headers.authorization || req.headers['x-mall-token'] || '')
    // 只认受控头：`?token=` 不再是凭据来源（与 `requireAuth` 同一口径，F13）
    const token = raw.replace(/^Bearer\s+/i, '')
    if (token) {
      try {
        const payload = jwt.verify(String(token), JWT_SECRET)
        if (payload.industry) industry = normalizeIndustry(payload.industry)
      } catch (e) {
        // —— fail-closed：**只有**"令牌本身无效"才允许忽略这个令牌、退回 ① 的结论 ——
        // 判据是**白名单** `isTokenInvalid`（jsonwebtoken 的 JsonWebTokenError 家族：
        // 签名错 / 格式错 / aud 不符 / 过期 / 未生效）。其余**任何**异常
        // （行业码非法、构造错误时的意外 TypeError…）一律**上抛**给全局 errorHandler ⇒ 拒绝该请求。
        //
        // 为什么不能写成旧的黑名单（`if (e?.code === INDUSTRY_CODE_INVALID) throw e`，其余吞掉）：
        // 那样**任何没被列出的意外异常**都会掉进 else、被当成"令牌无效"吞掉 ⇒ 静默回落默认库
        // ⇒ **200 读到默认行业库**。红队实测：令牌载荷 `industry:{toString:null}` 会让
        // `industryError` 在构造错误时自身又抛（不是行业码错）⇒ 被吞 ⇒ 200 读美妆库的默认数据。
        // "未知异常 ⇒ 静默落到某个库"正是本线要消灭的形态，所以判据反过来写：**默认拒绝、白名单才放行**。
        if (!isTokenInvalid(e)) throw e
      }
    }
    runWithIndustry(industry, () => next())
  } catch (e) {
    next(e)
  }
})

// 默认只初始化生产 schema/config；显式 demo/test 模式才加载演示灌数模块。
// 不静态导入 seed：其中含演示时钟等模块级副作用。
const { runtimeMode, requireDataDirectory } = await import('./runtime.js')
requireDataDirectory()
const { bootAll } = await import(runtimeMode() === 'production' ? './db/production-boot.js' : './db/boot.js')
bootAll({ log: (m) => console.log(`[gml] ${m}`) })
for (const code of Object.keys(INDUSTRIES)) {
  console.log(`[gml] ${INDUSTRIES[code].label} 数据库：${dbPathFor(code)}`)
}

app.get('/api', (_req, res) => {
  res.json({
    code: 0,
    success: true,
    data: {
      name: 'GML 供应链协同系统',
      ...versionInfo(),
      industries: Object.values(INDUSTRIES).map((x) => ({ code: x.code, name: x.name, label: x.label })),
      default_industry: DEFAULT_INDUSTRY,
      capabilities: runtimeCapabilities(),
      runtime_mode: runtimeMode(),
      docs: '/api/openapi.json',
      ai_manifest: '/api/ai/manifest',
      health: '/api/meta/health'
    }
  })
})

app.get('/api/openapi.json', (_req, res) => res.json(buildOpenApi()))

app.use('/api/auth', authRoutes)
app.use('/api/meta', metaRoutes)
app.use('/api/master', masterRoutes)
app.use('/api/purchase', purchaseRoutes)
// 质检路由与采购路由共用 /api/purchase 前缀：质检属于采购域，
// 但独立成文件（到货单与质检单拆分，见 routes/qc.js 头注）。
app.use('/api/purchase', qcRoutes)
// 模块 07 采购域后段（请购 / 发票 / 结算 / 付款 / 供货目录）。
// 挂在同一前缀、排在前面那个之后：Express 先匹配 purchase.js，
// 未命中的路径落到这里 —— 既有订单收货链路零改动。
app.use('/api/purchase', purchaseChainRoutes)
app.use('/api/sales', salesRoutes)
app.use('/api/inventory', inventoryRoutes)
app.use('/api/dealers', dealerRoutes)
app.use('/api/oms', omsRoutes)
app.use('/api/pos', posRoutes)
app.use('/api/mall', mallRoutes)
app.use('/api/qimen', qimenRoutes)
app.use('/api/requisitions', requisitionRoutes)
app.use('/api/outsourcing', outsourcingRoutes)
app.use('/api/demand', demandRoutes)
app.use('/api/pricing', pricingRoutes)
app.use('/api/docflow', docflowRoutes)
app.use('/api/order-center', orderCenterRoutes)
app.use('/api/notify', notifyRoutes)
app.use('/api/im', imRoutes)
app.use('/api/approval', approvalRoutes)
app.use('/api/metrics', metricsRoutes)
app.use('/api/costing', costingRoutes)
// 报价属于销售域，与销售订单共用前缀；信用控制跨销售与订货两个域，独立成前缀
app.use('/api/sales', quoteRoutes)
app.use('/api/credit', creditRoutes)
// 应收/收款属财务域：与信用控制共享「钱」的口径，但单据独立成前缀
app.use('/api/ar', arRoutes)
// 销售发票（模块 24）：销售链最后一环，独立前缀便于「票」与「货」分别授权
app.use('/api/invoices', invoiceRoutes)
// 质量检验（模块 13）：报检/检验/不良品处理三单独立成链，来源跨采购与生产，故独立前缀
app.use('/api/qc', qc2Routes)
app.use('/api/promo', promoRoutes)
app.use('/api/dms', dmsRoutes)
app.use('/api/accounting', accountingRoutes)
// 财务报表（批次 L · 模块 28）：三张报表 / 期间关账 / 期初余额 / 经营分析。
// 独立前缀而不是挂在 `/api/accounting` 下：**授权粒度不同** ——
// "看报表"与"维护账（改口径 / 关账 / 改期初）"是两件事，
// 挂在同一个前缀下，权限就只能按"谁配了哪些码"去拼，而不是按前缀一刀切。
app.use('/api/reports', reportRoutes)
// 退款单（批次 J）：独立前缀 —— 退款与退货的授权粒度不同（谁能放钱 vs 谁能退货），
// 且它与收款单是**方向相反**的两类资金单据，挂同一个前缀会让"收还是付"要靠动词去猜。
app.use('/api/refunds', refundRoutes)
app.use('/api/manufacture', manufactureRoutes)
app.use('/api/dashboard', dashboardRoutes)
app.use('/api/ai', (req, res, next) => {
  if (req.path === '/manifest' || req.path === '/metrics') return next()
  return requireAuth(req, res, next)
}, aiRoutes)

// —— MCP 能力层：业务能力原生暴露，不经过「外挂适配」——
//   POST /mcp           标准 MCP 端点（JSON-RPC 2.0）
//   /api/mcp/*          Agent Token 管理、调用审计、人工确认
app.use('/api/mcp', mcpAdminRoutes)
app.use('/mcp', mcpRoutes)

app.use('/api', (_req, res) => res.status(404).json({ code: 1, success: false, message: '接口不存在' }))

// 前端静态资源（生产构建产物）
const distDir = path.join(ROOT_DIR, 'dist')
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')))
} else {
  app.get('/', (_req, res) =>
    res
      .status(200)
      .send(
        `<pre style="font:14px/1.6 ui-monospace,Menlo,monospace;padding:24px">
GML 供应链协同系统 · API 已启动（开发模式）

前端尚未构建。请任选一种：
  1) 开发模式：npm run dev      → 访问 http://localhost:5173
  2) 生产模式：npm run build && npm start → 访问 http://localhost:${PORT}

API 入口：
  http://localhost:${PORT}/api
  接口文档：http://localhost:${PORT}/api/openapi.json
  AI 能力清单：http://localhost:${PORT}/api/ai/manifest
  健康检查：http://localhost:${PORT}/api/meta/health
</pre>`
      )
  )
}

app.use(errorHandler)

app.listen(PORT, HOST, () => {
  console.log(`[gml] 服务已启动：http://localhost:${PORT}`)
  console.log(`[gml] 行业版本：${Object.values(INDUSTRIES).map((x) => x.label).join(' / ')}（登录时选择）`)
  console.log(`[gml] 演示账号：admin / 12345（主管理员，全部模块）· 其余角色账号密码 123456`)
})
