# ADR 索引

<!-- generated -->
<!-- 由 `node scripts/gen-codemap.mjs` 生成，勿手改；CI 校验不漂移 -->

共 49 个 ADR 文件。批次来自 `scripts/gen-changelog.mjs` 的 BATCHES（编号区间）；状态是 ADR 原文“状态：”一句的摘录（没有就如实标注），**不代表验收**；“守卫 / 测试”是 ADR 正文里提到的文件路径（静态正则提取，路径不存在时标注“（不存在）”），不证明该测试覆盖了 ADR 的全部决定。

| 编号 | 标题 | 批次 | 状态（原文摘录） | 守卫（scripts/） | 测试（tests/） |
|---|---|---|---|---|---|
| 0001 | [ADR-0001：生产、演示与测试数据隔离](ADR-0001-runtime-isolation.md) | 第一批 | 第一批实现；尚不构成生产上线验收 | `regress-isolated.mjs` | — |
| 0002 | [ADR-0002：未验收网络能力的生产门禁](ADR-0002-capabilities.md) | 第一批 | 开发实现，尚非产品上线验收 | — | — |
| 0003 | [ADR-0003：首次生产管理员初始化](ADR-0003-admin-bootstrap.md) | 第一批 | （ADR 未写出状态） | `bootstrap-admin.mjs` | — |
| 0004 | [ADR-0004：后台账号会话版本与原子安全变更](ADR-0004-account-sessions.md) | 第二批 | （ADR 未写出状态） | — | — |
| 0004 | [ADR-0004：后台会话失效与前端请求边界](ADR-0004-frontend-session.md) | 第二批 | （ADR 未写出状态） | — | `browser/session.mjs` |
| 0005 | [ADR-0005：有界、持久化的后台登录节流](ADR-0005-login-throttle.md) | 第二批 | （ADR 未写出状态） | — | — |
| 0007 | [ADR-0007：正常重启不得恢复已撤销的角色授权](ADR-0007-permission-migration-checks.md) | 第二批 | （ADR 未写出状态） | — | — |
| 0008 | [ADR-0008：通知子系统加固（摘要数据范围、出站 Webhook 策略、渠道密钥静态保护）](ADR-0008-notify-hardening.md) | 第三批 | 开发实现，尚非产品上线验收 | — | — |
| 0009 | [ADR-0009：备份先校验后轮转，迁移文件校验和](ADR-0009-backup-verification-and-migration-checksums.md) | 第三批 | （ADR 未写出状态） | `db-backup.mjs`<br>`migrate.mjs`<br>`verify-migrations.mjs` | — |
| 0010 | [ADR-0010：审计与错误卫生（F13）](ADR-0010-audit-and-error-hygiene.md) | 第三批 | （ADR 未写出状态） | `check-bizcode-shape.mjs`<br>`check-file-header.mjs` | — |
| 0011 | [ADR-0011：MCP Agent Token 是所有者的委托，不是独立服务主体](ADR-0011-mcp-delegated-token-scope.md) | 第三批 | 对每个首次成功的写型工具，用同一幂等键依次在"权限被撤""范围被缩""全部恢复"下重放，断言前两格得到当前错误、不带 ` | `check-mcp-coverage.mjs`<br>`test-mcp-purchase.mjs`<br>`test-mcp-validation.mjs`<br>`test-mcp.mjs` | — |
| 0012 | [ADR-0012：最小运行镜像与版本 / 状态契约](ADR-0012-container-and-version-contract.md) | 第三批 | 开发实现，尚非生产部署验收 | `build-docs-wiki.mjs`<br>`check-api-contract.mjs`<br>`check-contract-routes.mjs`<br>`check-file-header.mjs`<br>`package-release.mjs`<br>`test-dependency-security.mjs` | — |
| 0013 | [ADR-0013：收款释放的授信按台账逐笔逆向，不按总额猜](ADR-0013-credit-release-ledger.md) | 第三批 | （ADR 未写出状态） | — | — |
| 0014 | [ADR-0014：sales_orders.credit_hold 是授信台账的投影，只有一个写入者](ADR-0014-credit-hold-projection.md) | 第四批 | （ADR 未写出状态） | `test-guards.mjs`<br>`test-quote-credit.mjs`<br>`verify-seed.mjs` | — |
| 0015 | [ADR-0015：待办接口按权限与范围收口；Agent Token 列表报告有效状态](ADR-0015-todo-scope-and-token-status.md) | 第四批 | 开发实现，尚非产品上线验收 | `check-api-contract.mjs`<br>`check-file-header.mjs`<br>`check-mcp-coverage.mjs`<br>`test-mcp-purchase.mjs`<br>`test-mcp.mjs` | — |
| 0016 | [ADR-0016：恢复演练与升级失败回退演练](ADR-0016-restore-and-upgrade-drills.md) | 第四批 | （ADR 未写出状态） | `bootstrap-admin.mjs`<br>`check-file-header.mjs`<br>`db-backup.mjs`<br>`db-restore-drill.mjs`<br>`lib/drill-common.mjs`<br>`migrate.mjs`<br>`upgrade-rollback-drill.mjs` | — |
| 0017 | [ADR-0017：采购链读接口与待办同一道门、同一份组织范围](ADR-0017-purchase-chain-scope.md) | 第五批 | 开发实现，尚非产品上线验收 | `check-api-contract.mjs`<br>`check-file-header.mjs`<br>`test-purchase.mjs`<br>`verify-purchase-chain.mjs` | — |
| 0018 | [ADR-0018：人工资金模式 —— 收付款确认必须有证据，并由第二人复核](ADR-0018-funds-maker-checker.md) | 第五批 | （ADR 未写出状态） | `test-ar.mjs` | — |
| 0019 | [ADR-0019：脚本数据目录卫生与单实例安装验收](ADR-0019-script-data-dir-hygiene.md) | 第五批 | （ADR 未写出状态） | `check-data-paths.mjs`<br>`check-env-pinning.mjs`<br>`check-file-header.mjs`<br>`check-inv-txn-dict.mjs`<br>`check-mcp-coverage.mjs`<br>`db-inventory.mjs`<br>`inspect-doc-kernel.mjs`<br>`inspect-org.mjs`<br>`lib/drill-common.mjs`<br>`local-manage.mjs`<br>`regress-all.mjs`<br>`verify-reseed.mjs` | — |
| 0020 | [ADR-0020：采购链详情与辅助读接口同一道门、逐单范围判定](ADR-0020-purchase-detail-scope.md) | 第六批 | 开发实现，尚非产品上线验收 | — | — |
| 0021 | [ADR-0021 路由授权清单守卫](ADR-0021-route-authz-guard.md) | 第六批 | 已采纳（2026-10-23） | `check-route-authz.mjs` | — |
| 0022 | [ADR-0022：备份加密与三库一致点](ADR-0022-backup-encryption.md) | 第六批 | （ADR 未写出状态） | `db-backup.mjs`<br>`db-restore-drill.mjs`<br>`lib/drill-common.mjs` | — |
| 0023 | [ADR-0023 结构化日志与请求号贯通](ADR-0023-structured-logging.md) | 第六批 | 已采纳（W7） | — | — |
| 0024 | [ADR-0024：供应商付款释放台账，作废按台账逐笔逆向](ADR-0024-payment-release-ledger.md) | 第六批 | （ADR 未写出状态） | — | — |
| 0025 | [ADR-0025：门店 POS 路由按动作授权、跨店 404、交班核款二人分离](ADR-0025-pos-authorization.md) | 第七批 | （ADR 未写出状态） | `check-route-authz.mjs`<br>`test-pos2.mjs` | — |
| 0026 | [ADR-0026：销售域读写按内部账号组织范围收口](ADR-0026-sales-org-scope.md) | 第七批 | 开发实现，尚非产品上线验收 | — | — |
| 0027 | [ADR-0027：订货中心按客户归属组织收口](ADR-0027-order-center-scope.md) | 第七批 | 开发实现，尚非产品上线验收 | — | — |
| 0028 | [ADR-0028：杂项授权缺口收口（no-issue / orgs / qimen / 付款与结算范围）](ADR-0028-authz-misc.md) | 第七批 | 开发实现，尚非产品上线验收 | `check-route-authz.mjs` | — |
| 0029 | [ADR-0029 运维健康块、计数器与备份失败告警](ADR-0029-ops-health.md) | 第七批 | 已采纳（X8） | `db-backup.mjs`<br>`test-industry-code.mjs` | — |
| 0030 | [ADR-0030：日志保留清理与个人信息处理](ADR-0030-retention-and-privacy.md) | 第七批 | （ADR 未写出状态） | `lib/privacy-common.mjs`<br>`privacy-erase.mjs`<br>`privacy-export.mjs`<br>`retention.mjs`<br>`test-setting-audit.mjs` | — |
| 0031 | [ADR-0031：采购链动作路由与 MCP 采购工具的单据范围](ADR-0031-purchase-action-scope.md) | 第八批（进行中） | 开发实现，尚非产品上线验收 | `check-route-authz.mjs`<br>`test-mcp-purchase.mjs` | — |
| 0032 | [ADR-0032：单据流读接口按账号数据范围过滤](ADR-0032-docflow-scope.md) | 第八批（进行中） | （ADR 未写出状态） | `check-route-authz.mjs` | — |
| 0033 | [ADR-0033：奇门网关平台凭据、签名契约与重新开放验收清单](ADR-0033-qimen-credentials.md) | 第八批（进行中） | 开发实现，尚非产品上线验收 | `check-route-authz.mjs`<br>`qimen-issue-key.mjs` | — |
| 0034 | [ADR-0034：报价、MCP 销售工具与 OMS 入口按组织范围收口](ADR-0034-quote-sales-mcp-scope.md) | 第八批（进行中） | 开发实现，尚非产品上线验收 | `check-route-authz.mjs` | — |
| 0035 | [ADR-0035：写路径并发与 SQLITE_BUSY 治理](ADR-0035-write-contention.md) | 第八批（进行中） | （ADR 未写出状态） | `lib/bench-contender.mjs` | — |
| 0036 | [ADR-0036 安全响应头与后台会话传输（Y11）](ADR-0036-security-headers-and-session-transport.md) | 第八批（进行中） | 已采纳 | — | — |
| 0037 | [ADR-0037：审批域按指向单据的组织范围收口](ADR-0037-approval-scope.md) | 第八批（进行中） | 开发实现，尚非产品上线验收 | `test-setting-audit.mjs` | — |
| 0038 | [ADR-0038：库存域与采购订单状态/收货路由按组织范围收口](ADR-0038-inventory-scope.md) | 第九批 | 开发实现，尚非产品上线验收 | `check-route-authz.mjs` | — |
| 0039 | [ADR-0039：OMS 读接口与 MCP 单据历史工具按组织范围收口](ADR-0039-oms-mcp-history-scope.md) | 第九批 | 开发实现，尚非产品上线验收 | `check-route-authz.mjs` | — |
| 0040 | [ADR-0040 受信代理配置（Z4）](ADR-0040-trust-proxy.md) | 第九批 | 已采纳 | — | — |
| 0041 | [ADR-0041：MCP `order.trace_document` 与 `doc.query` 按单据解析器表判归属](ADR-0041-mcp-trace-query-scope.md) | 第十批 | 开发实现，尚非产品上线验收 | `check-mcp-coverage.mjs` | — |
| 0042 | [ADR-0042：OMS 写路由与 MCP 库存工具按组织范围收口](ADR-0042-oms-write-mcp-inventory-scope.md) | 第十批 | 开发实现，尚非产品上线验收 | `check-mcp-coverage.mjs`<br>`check-route-authz.mjs`<br>`test-mcp.mjs`<br>`test-stock-v2.mjs` | — |
| 0044 | [ADR-0044：低库存口径统一与看板热点块（AA5）](ADR-0044-dashboard-hot-blocks.md) | 第十批 | 开发实现，尚非产品上线验收 | `explain-audit.mjs` | — |
| 0045 | [ADR-0045 Prometheus 指标导出与抓取令牌（AA10）](ADR-0045-metrics-export.md) | 第十批 | 开发实现，尚非产品上线验收 | — | — |
| 0046 | [ADR-0046：主数据下拉仓库项、采购订单读与 QC 聚合按仓库组织范围收口](ADR-0046-master-options-qc-scope.md) | 第十一批（进行中） | 开发实现，尚非产品上线验收 | `check-route-authz.mjs` | — |
| 0047 | [ADR-0047：发行候选证据 Ed25519 签名（AB4）](ADR-0047-evidence-signing.md) | 第十一批（进行中） | 开发实现，尚非产品上线验收 | `lib/evidence-sign.mjs`<br>`release-keygen.mjs` | — |
| 0048 | [ADR-0048：旧结构快照备份集与免截断的升级演练（AB5）](ADR-0048-schema-snapshot-rehearsal.md) | 第十一批（进行中） | 开发实现，尚非产品上线验收 | `schema-snapshot.mjs` | — |
| 0049 | [ADR-0049 审计日志防篡改哈希链与归档（AB6）](ADR-0049-audit-hash-chain.md) | 第十一批（进行中） | 开发实现，尚非产品上线验收 | `audit-archive.mjs`<br>`audit-verify-chain.mjs`<br>`lib/audit-chain-cli.mjs`<br>`lib/privacy-common.mjs`<br>`retention.mjs` | — |
| 0051 | [ADR-0051 总部角色名单单点与 docflow 严格门店绑定（AC2）](ADR-0051-hq-roles-docflow-binding.md) | 第十二批（进行中） | 开发实现，尚非产品上线验收 | `test-setting-audit.mjs` | — |
