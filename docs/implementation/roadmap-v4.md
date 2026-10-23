# OS ERP 商用整改详细方案 v4（第八批）

日期：2026-10-23。基线：PR #3 合并后的 `main`（含 roadmap v2 W1–W12、v3 X1–X12）。本方案承接 backlog 第六/七批节登记的残留项与各 ADR 的"未做"段落。通用约束、TDD、守卫清单（含 `check-route-authz`、`check-data-paths`、`explain-audit`）、Codex 审计方式与 [roadmap-v2](roadmap-v2.md) 相同。ADR 编号从 0031 起，迁移从 060 起。所有新增路由或收口必须同步更新 `scripts/check-route-authz.mjs` 的登记。

---

## Y1 采购链动作路由与 MCP 采购工具单据范围（ADR-0031）

- 现状：`purchase-chain.js` 的 `/requisitions|invoices|settlements|payments/:id/:action`、`/requisitions/:id/convert`、`/payments/:id/review`、`/orders/:id/receive-check` 只校验动作权限，不判单据归属；MCP `purchase.settlement.build`、`purchase.payment.create` 未传 `orgScope`。
- 改动：动作路由在取单后调用 `assertPurchaseDocInScope`（ADR-0020），越权 404；`review` 另要求 ADR-0018 权限；MCP 两工具从委托上下文取所有者范围传入 `buildSettlement`/`createPayment`（已支持 `orgScope` 参数）。更新守卫登记。
- 文件：`server/routes/purchase-chain.js`、`server/mcp/tools.js`（仅两工具）、`tests/purchase-action-scope.test.mjs`、矩阵测试覆盖。

## Y2 单据流读接口组织过滤（ADR-0032）

- 现状：`docflow.js` 的 `/events`、`/overview`、`/history`、`/trace` 对任何内部账号返回全库事件，含 OC/OCS。
- 改动：按 `doc_type` 把事件映射到对应领域的范围谓词（采购 `purchaseScopeSql`、销售 `salesScopeSql`、订货 `ocScope`、POS 门店、其余主数据类型要求全局范围）；`/overview` 聚合只统计范围内；详情越权 404。单一分发表 `DOC_SCOPE_RESOLVERS` 放在 `server/lib/docflow.js`。
- 文件：`server/lib/docflow.js`、`server/routes/docflow.js`、`tests/docflow-scope.test.mjs`。

## Y3 奇门网关凭据与能力清单（ADR-0033）

- 现状：签名秘密是公开演示常量；`/capabilities` 向任意登录用户列出各平台 `app_key`；生产 503。
- 改动：平台表增加 `app_secret_sealed`（迁移 060，用 `secret-box.js` 封存），管理员接口签发/轮换（只显示一次）；签名用平台自身秘密；`/capabilities` 要求 `oms.platform.manage`，不再返回 app_key 以外的秘密、普通用户 403；时间戳与重放窗口（5 分钟 + nonce 表或滑动窗口）。生产门禁保持关闭；ADR 写明重新开放前的验收清单。
- 文件：`server/routes/qimen.js`、`server/lib/qimen-auth.js`（新）、`server/db/migrations/060_qimen_secrets.cjs`、`src/pages/oms/Platforms.tsx`（签发按钮）、`tests/qimen-auth.test.mjs`。

## Y4 报价、MCP 销售工具与 OMS 入口范围（ADR-0034）

- 改动：`quote.js` 读写走 `salesScopeSql`（报价按客户/仓库归属）；MCP `sales.*` 工具从委托上下文传 `orgScope` 到 `sales-order.js`；OMS 同步入口（`/api/oms/sync` 等，生产 503）写入订单时按平台绑定组织。更新守卫登记与矩阵测试。
- 文件：`server/routes/quote.js`、`server/lib/quote.js`、`server/mcp/tools.js`（仅 sales 工具）、`server/routes/oms.js`、`tests/quote-scope.test.mjs`。

## Y5 POS 前端按权限显示（前端）

- 改动：POS 页面（`src/pages/pos/*`）根据 `/auth/my-permissions` 隐藏无权限的动作按钮（交班批准/驳回、缴款、日结、盘点调整），接入 W3 的 403/范围提示；交班批准按钮对发起人显示"需另一人复核"。纯逻辑选择器 `src/utils/pos-actions.ts` 单元测试。
- 文件：`src/pages/pos/*`、`src/utils/pos-actions.ts`、`tests/pos-actions.test.mjs`。

## Y6 MCP 文档读的门店/经销商绑定门禁（ADR-0011 补充）

- 现状：RC/YQ/SH 等类型 HTTP 侧有角色名/门店绑定门禁，MCP 只校验权限码。
- 改动：在 `server/mcp/doc-perms.js` 为这些类型声明 `binding: 'store'|'dealer'`，所有者无对应绑定或绑定不匹配单据时拒绝；矩阵测试加该状态。
- 文件：`server/mcp/doc-perms.js`、`server/mcp/tools.js`、`tests/mcp-doc-perms.test.mjs`。

## Y7 写路径并发与 SQLITE_BUSY 治理（ADR-0035）

- 现状：基线只测读；busy_timeout 固定；无写并发证据。
- 改动：`bench-api.mjs` 增 `--profile=write`（并发创建采购单/收款确认/库存调拨，幂等键），记录 BUSY/重试/错误；服务端统一在 `server/db/index.js` 配置 busy_timeout 可调（`GML_SQLITE_BUSY_MS`，默认沿用）与写事务重试包装（仅对 `SQLITE_BUSY`，有上限与抖动，幂等保护下）；`docs/implementation/capacity-baseline.md` 追加写基线。
- 文件：`scripts/bench-api.mjs`、`server/db/index.js`、`server/lib/tx.js`（新，单一重试实现）、`tests/write-contention.test.mjs`。

## Y8 个人信息擦除覆盖面扩展（ADR-0030 补充）

- 改动：`privacy-erase.mjs` 覆盖 `refunds.customer_name`、`oc_*` 客户快照、`audit_logs.detail` 中部分脱敏手机号的再脱敏（按 keyed 哈希替换）、通知日志摘要；增加 `--report` 列出每表影响行数；运维手册更新。
- 文件：`scripts/privacy-erase.mjs`、`scripts/lib/privacy-common.mjs`、`tests/privacy-tools.test.mjs`（扩）。

## Y9 发行版本与变更记录

- 改动：`package.json` 版本 `0.2.0-alpha.1`；`scripts/gen-changelog.mjs` 从 `docs/implementation/ADR-*.md` 的标题与"决定"段生成 `CHANGELOG.md`（按批次分组，幂等）；`package-release.mjs` 把 SBOM（`npm run sbom`）打进包并由 `verify-release.mjs` 校验；`tests/release-package.test.mjs` 扩展。
- 文件：上述；`CHANGELOG.md`。

## Y10 大库规模演练（本机合成）

- 改动：`scripts/synth-data.mjs` 在隔离目录生成合成大库（可配：10 万 SKU×批次、100 万库存流水、20 万单据），只用真实迁移与领域函数写入（不绕过不变量）；用它跑 `db-backup`（含加密）、`db-restore-drill`、`explain-audit`、`bench-api` 并把耗时写入 `capacity-baseline.md`（标注本机、非目标主机）。
- 文件：`scripts/synth-data.mjs`、`tests/synth-data.test.mjs`（小规模冒烟）、文档。

## Y11 安全响应头与前端令牌存放（ADR-0036）

- 改动：`server/middleware/security-headers.js`（无新依赖）：CSP（默认 `default-src 'self'`，报告模式可切强制，`GML_CSP_MODE`）、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`、受信代理下 HSTS；评估 F06 附注（localStorage 令牌）：实现可选 HttpOnly Cookie 会话模式（`GML_SESSION_TRANSPORT=cookie`，同站 Lax，CSRF 双提交），默认仍 Bearer，ADR 写明切换条件；测试覆盖头与两种传输。
- 文件：新中间件、`server/index.js`、`src/api/client.ts`（cookie 模式不带 Bearer）、`tests/security-headers.test.mjs`。

## Y12 审批域组织范围与实例读（ADR-0037）

- 现状：`approval.js` 实例列表/详情对内部账号未按组织过滤；创建/取消只有处理器内检查。
- 改动：审批实例按其指向单据的领域范围谓词过滤（复用 Y2 的 `DOC_SCOPE_RESOLVERS`，所以 Y12 在 Y2 之后集成；实现时先在本分支内联一个最小映射并标注待替换）；审批人仅见自己可审批或范围内实例；越权 404。更新守卫登记。
- 文件：`server/routes/approval.js`、`server/lib/approval.js`、`tests/approval-scope.test.mjs`。

---

## 分配

| 工作流 | 分支 | ADR | 迁移 |
|---|---|---|---|
| Y1 | feat/y1-purchase-action-scope | 0031 | — |
| Y2 | feat/y2-docflow-scope | 0032 | — |
| Y3 | feat/y3-qimen-credentials | 0033 | 060 |
| Y4 | feat/y4-quote-sales-mcp-scope | 0034 | — |
| Y5 | feat/y5-pos-frontend-perms | — | — |
| Y6 | feat/y6-mcp-doc-binding | 0011 补充 | — |
| Y7 | feat/y7-write-contention | 0035 | — |
| Y8 | feat/y8-erase-coverage | 0030 补充 | — |
| Y9 | feat/y9-release-changelog | — | — |
| Y10 | feat/y10-synth-scale | — | — |
| Y11 | feat/y11-security-headers | 0036 | — |
| Y12 | feat/y12-approval-scope | 0037 | — |

冲突提示：Y1/Y4/Y6 都改 `server/mcp/tools.js`（分别只动采购两工具、sales 工具、doc 工具）；Y2/Y12 都涉及单据→范围映射（Y12 先内联，集成时合到 Y2 的分发表）；Y3/Y4 都改 `server/routes/oms.js` 相邻区域时各自限定函数。
