# 模块代码地图（server/lib 与 server/mcp）

<!-- generated -->
<!-- 由 `node scripts/gen-codemap.mjs` 生成，勿手改；CI 校验不漂移 -->

共 86 个模块。“路由”只列在处理器区域内直接引用该函数的路由（路由超过 5 条时按路由文件汇总，明细见 [routes.md](routes.md)）；“MCP 工具”来自 `server/mcp/tools.js` 的 40 个工具；“被模块调用”是其它 lib/mcp 模块里的跨文件引用。“—”表示静态扫描没找到调用方，不等于死代码。

## 扫描边界（必读）

本文件由静态文本扫描生成，不执行代码，不是调用图证明。看不到：动态分发（`handlers[x]()`、注册表、docflow 流转表）、把函数当参数传出去后在别处调用、`FROM ${变量}` 与逗号连接的表、小写 SQL。
“经 lib 触达的表”沿跨文件调用最多 3 跳，是**可能触达**的上界。完整清单见 [scripts/gen-codemap.mjs](../../scripts/gen-codemap.mjs) 文件头。

## `server/lib/account-security.js`

账号变更、会话撤销及严格安全审计的原子边界

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `changePassword` | fn | POST /api/auth/change-password | — | — |
| `createAccount` | fn | POST /api/auth/users | — | — |
| `logoutAll` | fn | POST /api/auth/logout-all | — | — |
| `replaceRolePermissions` | fn | PUT /api/auth/roles/:code/permissions | — | — |
| `updateAccount` | fn | PUT /api/auth/users/:id | — | — |

## `server/lib/accounting.js`

业财一体凭证（批次 H · 模块 27）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `AccountingError` | class | — | — | — |
| `BIZ_TYPES` | const | — | — | — |
| `DIRECTIONS` | const | — | — | — |
| `DIRECTION_LABEL` | const | — | — | — |
| `FACT_KEYS` | const | — | — | — |
| `SUBJECT_CATEGORIES` | const | — | — | — |
| `SUBJECT_CATEGORY_LABEL` | const | — | — | — |
| `assertBalancedLines` | fn | — | — | — |
| `assertTemplateBalanced` | fn | — | — | — |
| `auditVoucher` | fn | GET /api/accounting/audit | — | — |
| `balanceOf` | fn | — | — | — |
| `collectFacts` | fn | — | — | — |
| `defaultTaxRate` | fn | — | — | — |
| `generateVoucher` | fn | POST /api/accounting/vouchers/generate | — | — |
| `getVoucher` | fn | GET /api/accounting/vouchers/:id | — | lib/annual.js, lib/closing.js |
| `listSubjects` | fn | GET /api/accounting/subjects | — | — |
| `listTemplates` | fn | GET /api/accounting/templates | — | — |
| `listVouchers` | fn | GET /api/accounting/vouchers | — | — |
| `meta` | fn | GET /api/accounting/meta | — | — |
| `persistVoucher` | fn | — | — | lib/annual.js, lib/closing.js |
| `planVoucher` | fn | POST /api/accounting/vouchers/plan | — | — |
| `postVoucher` | fn | POST /api/accounting/vouchers/:id/post | — | lib/annual.js, lib/closing.js |
| `saveSubject` | fn | POST /api/accounting/subjects<br>PUT /api/accounting/subjects/:id | — | — |
| `setSubjectStatus` | fn | POST /api/accounting/subjects/:id/status | — | — |
| `subjectTree` | fn | GET /api/accounting/subjects/tree | — | — |
| `templateOf` | fn | GET /api/accounting/templates/:bizType | — | — |
| `trialBalance` | fn | GET /api/accounting/trial-balance | — | — |
| `trialBalanceDetail` | fn | GET /api/accounting/trial-balance/detail | — | — |
| `trialBalanceFilter` | fn | — | — | — |
| `voidVoucher` | fn | POST /api/accounting/vouchers/:id/void | — | — |
| `vouchersOfSource` | fn | GET /api/accounting/vouchers/by-source/:sourceType/:sourceId | — | — |

## `server/lib/admin-bootstrap.js`

空生产库的一次性企业管理员初始化

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `bootstrapAdmin` | fn | — | — | — |
| `validateBootstrapInput` | fn | — | — | — |

## `server/lib/agreement.js`

渠道协议价（批次 G · 模块 26）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `AGREEMENT_PRICE_LABEL` | const | — | — | — |
| `AGREEMENT_TARGET_LABEL` | const | — | — | — |
| `AgreementError` | class | — | — | — |
| `createAgreement` | fn | POST /api/dms/agreements | — | — |
| `discountLabel` | fn | — | — | — |
| `getAgreement` | fn | GET /api/dms/agreements/:id | — | — |
| `listAgreements` | fn | GET /api/dms/agreements | — | — |
| `meta` | fn | — | — | — |
| `nextAgreementCode` | fn | — | — | — |
| `resolveAgreement` | fn | — | — | lib/pricing.js |
| `setAgreementStatus` | fn | POST /api/dms/agreements/:id/status | — | — |
| `updateAgreement` | fn | PUT /api/dms/agreements/:id | — | — |

## `server/lib/annual.js`

年度结转与利润分配（批次 O · 模块 28 的续之三）：让 4103 也有出路

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `ANNUAL_BIZ_TYPE` | const | — | — | — |
| `ANNUAL_SOURCE_TYPE` | const | — | — | — |
| `AnnualError` | class | — | — | — |
| `DIST_BIZ_TYPE` | const | — | — | — |
| `annualPrecheck` | fn | — | — | — |
| `assertYear` | fn | — | — | — |
| `carryForwardAnnual` | fn | POST /api/reports/annual/:year/carry-forward | — | — |
| `decemberPeriod` | fn | — | — | — |
| `distributableAmount` | fn | — | — | — |
| `distributeProfit` | fn | POST /api/reports/annual/:year/distribute | — | — |
| `distributionStatus` | fn | GET /api/reports/annual/:year/distribution | — | — |
| `distributionSubjects` | fn | — | — | — |
| `listAnnual` | fn | GET /api/reports/annual | — | — |
| `meta` | fn | — | — | — |
| `planAnnual` | fn | GET /api/reports/annual/:year | — | — |
| `profitCarryBalance` | fn | — | — | — |
| `retainedSubject` | fn | — | — | — |
| `retainedSubjectCode` | fn | — | — | — |
| `reverseAnnual` | fn | POST /api/reports/annual/:year/reverse-closing | — | — |
| `reverseDistribution` | fn | POST /api/reports/annual/:year/reverse-distribution | — | — |
| `yearNetProfit` | fn | — | — | — |
| `yearOf` | fn | — | — | — |
| `yearPeriods` | fn | — | — | — |

## `server/lib/approval.js`

通用审批流引擎（模块 22）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `ApprovalError` | class | — | — | — |
| `amountOf` | fn | — | — | — |
| `approvalDocScope` | fn | GET /api/approval/check<br>POST /api/approval/instances | — | — |
| `approvalGate` | fn | GET /api/approval/check | — | — |
| `approvalOverview` | fn | GET /api/approval/overview | — | — |
| `approvalTodoItems` | fn | — | — | — |
| `approvalTodos` | fn | — | — | — |
| `approvalTodosFor` | fn | GET /api/approval/todos | — | — |
| `canApproveStep` | fn | — | — | — |
| `cancelApproval` | fn | POST /api/approval/instances/:id/cancel | — | — |
| `decideApproval` | fn | POST /api/approval/instances/:id/decide | approval.approve | lib/im-sync.js, mcp/tools.js |
| `describeApprover` | fn | — | — | — |
| `getInstance` | fn | GET /api/approval/instances/:id | — | — |
| `instanceVisibleTo` | fn | GET /api/approval/instances/:id | — | — |
| `listInstances` | fn | GET /api/approval/instances | — | — |
| `listTemplates` | fn | GET /api/approval/templates<br>POST /api/approval/templates<br>POST /api/approval/templates/:id/toggle | — | — |
| `matchTemplate` | fn | — | — | — |
| `pendingForMe` | fn | GET /api/approval/pending | — | — |
| `pendingInstancesFor` | fn | — | — | — |
| `stepsOfTemplate` | fn | GET /api/approval/check | — | — |
| `submitApproval` | fn | POST /api/approval/instances | — | — |
| `templateIsGlobal` | fn | — | — | — |
| `validateApproverScope` | fn | POST /api/approval/templates | — | — |

## `server/lib/ar.js`

应收与收款核销（模块 21 · 第一阶段）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `AGING_BUCKET_LABEL` | const | — | — | — |
| `AR_SOURCE_MANUAL` | const | — | — | — |
| `AR_SOURCE_OC` | const | — | — | — |
| `AR_SOURCE_SI` | const | — | — | lib/invoice.js |
| `AR_SOURCE_SO` | const | — | — | — |
| `AR_STATUS_LABEL` | const | — | — | — |
| `ArError` | class | — | — | — |
| `PAY_METHOD_LABEL` | const | — | — | — |
| `RC_STATUS_LABEL` | const | — | — | — |
| `aging` | fn | — | — | — |
| `agingBySubject` | fn | GET /api/ar/overview<br>GET /api/ar/aging | — | — |
| `agingDetail` | fn | GET /api/ar/aging/detail | — | — |
| `agingDetailBySubject` | fn | GET /api/ar/aging/subjects | — | — |
| `applyPrepay` | fn | POST /api/ar/prepay/apply | — | — |
| `arOfOrder` | fn | POST /api/sales/orders/:id/payment | — | lib/invoice.js, lib/returns.js |
| `arOverview` | fn | — | — | — |
| `auditAr` | fn | GET /api/ar/audit | — | — |
| `confirmReceipt` | fn | POST /api/ar/receipts/:id/confirm<br>POST /api/ar/receipts/:id/review<br>POST /api/sales/orders/:id/payment | — | — |
| `createReceipt` | fn | POST /api/ar/receipts<br>POST /api/sales/orders/:id/payment | — | — |
| `dueDateOf` | fn | — | — | — |
| `ensureAr` | fn | POST /api/ar/documents<br>POST /api/ar/documents/generate<br>POST /api/sales/orders/:id/payment | — | lib/invoice.js |
| `ensureOcAr` | fn | — | — | lib/order-center.js |
| `getAr` | fn | GET /api/ar/documents/:id | — | — |
| `getReceipt` | fn | GET /api/ar/receipts/:id<br>POST /api/ar/receipts/:id/confirm<br>POST /api/ar/receipts/:id/review | — | — |
| `listAr` | fn | GET /api/ar/documents | — | — |
| `listReceipts` | fn | GET /api/ar/receipts | — | — |
| `offsetAr` | fn | — | — | lib/rebate.js, lib/returns.js |
| `overdueDaysOf` | fn | — | — | — |
| `pendingOcAr` | fn | GET /api/ar/oc/pending | — | — |
| `prepayDetail` | fn | GET /api/ar/prepay/detail | — | — |
| `prepayList` | fn | GET /api/ar/prepay | — | — |
| `recalcAr` | fn | — | — | — |
| `recalcArBySubject` | fn | POST /api/ar/recalc | — | — |
| `statement` | fn | GET /api/ar/statement | — | — |
| `syncOcAr` | fn | POST /api/ar/oc/sync | — | — |
| `voidReceipt` | fn | POST /api/ar/receipts/:id/void | — | — |

## `server/lib/audit-anchor-manifest.js`

审计链尾 / 锚点摘要的离机清单：生成、读取、与在用库比对（ADR-0049 补充，AC7）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `MANIFEST_FORMAT` | const | — | — | — |
| `anchorsDigest` | fn | — | — | — |
| `buildManifest` | fn | — | — | — |
| `compareLiveToBackup` | fn | — | — | — |
| `forEachJsonlRow` | fn | — | — | — |
| `loadBackupManifest` | fn | — | — | — |
| `sha256FileSync` | fn | — | — | — |
| `summarizeAuditChain` | fn | — | — | — |
| `withoutAnchorList` | fn | — | — | — |

## `server/lib/audit-chain-verify.js`

审计哈希链校验器：顺序走一遍 `audit_logs`，报告第一个断点（ADR-0049）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `chainColumnsPresent` | fn | — | — | lib/audit-anchor-manifest.js |
| `verifyChain` | fn | — | — | lib/audit-anchor-manifest.js, lib/audit-trail.js |
| `verifyJsonlSegment` | fn | — | — | lib/audit-anchor-manifest.js |

## `server/lib/audit-trail.js`

`audit_logs` 的**唯一 INSERT 点**：明细归一与脱敏、普通写入、以及事务内"写不进就抛"的严格写入

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `AUDIT_OUTSIDE_TX` | const | — | — | — |
| `GENESIS` | 再导出（未解析） | — | — | — |
| `SECURITY_AUDIT_UNAVAILABLE` | const | — | — | — |
| `auditStrictRow` | fn | — | — | lib/account-security.js, lib/funds-review.js |
| `deleteAuditRowsAnchored` | fn | — | — | — |
| `insertAuditRow` | fn | — | — | lib/admin-bootstrap.js |
| `normalizeDetail` | fn | — | — | — |
| `rehashAuditRow` | fn | — | — | — |

## `server/lib/audit-view.js`

审计日志查看器的查询与 CSV 编码（Z7 / roadmap-v5 Z7）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `AUDIT_ACTION_NEEDS_MODULE` | const | — | — | — |
| `AUDIT_COUNT_CAP` | const | — | — | — |
| `AUDIT_EXPORT_MAX_ROWS` | const | — | — | — |
| `AUDIT_PAGE_MAX` | const | — | — | — |
| `AuditViewError` | class | — | — | — |
| `CSV_HEADER` | const | — | — | — |
| `FTS_RARE_MAX` | const | — | — | — |
| `FTS_TABLE` | const | — | — | — |
| `KEYWORD_FTS_MIN_CHARS` | const | — | — | — |
| `KEYWORD_MIN_CHARS` | const | — | — | — |
| `assertKeyword` | fn | — | — | — |
| `buildWhere` | fn | GET /api/meta/audit-logs<br>GET /api/meta/audit-logs/export.csv | — | — |
| `countCapped` | fn | GET /api/meta/audit-logs | — | — |
| `countSql` | fn | — | — | — |
| `csvCell` | fn | — | — | — |
| `csvLine` | fn | — | — | — |
| `exportChunks` | fn | GET /api/meta/audit-logs/export.csv | — | — |
| `exportSql` | fn | — | — | — |
| `ftsAvailable` | fn | — | — | — |
| `ftsEnvDisabled` | fn | — | — | — |
| `ftsPhrase` | fn | — | — | — |
| `ftsState` | fn | GET /api/meta/audit-logs | — | — |
| `keywordUsesFts` | fn | GET /api/meta/audit-logs<br>GET /api/meta/audit-logs/export.csv | — | — |
| `orderOf` | fn | GET /api/meta/audit-logs<br>GET /api/meta/audit-logs/export.csv | — | — |
| `parseFilters` | fn | GET /api/meta/audit-logs<br>GET /api/meta/audit-logs/export.csv | — | — |
| `redactDetail` | fn | — | — | — |
| `setFtsOverride` | fn | — | — | — |
| `useFtsFor` | fn | — | — | — |
| `viewRow` | fn | GET /api/meta/audit-logs | — | — |

## `server/lib/backup-alert.js`

备份失败告警钩子：经现有通知渠道发送，成功静默（ADR-0029）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `buildBackupAlert` | fn | — | — | — |
| `errorCodeOf` | fn | — | — | — |
| `safeDetail` | fn | — | — | — |
| `sendBackupAlert` | fn | — | — | — |

## `server/lib/backup-crypto.js`

备份文件的流式 AES-256-GCM 加密/解密（ADR-0022）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `BackupCryptoError` | class | — | — | — |
| `FORMAT_VERSION` | const | — | — | — |
| `MAGIC` | const | — | — | — |
| `MIN_KEY_BYTES` | const | — | — | — |
| `decryptFile` | fn | — | — | lib/audit-anchor-manifest.js |
| `encryptFile` | fn | — | — | — |
| `loadBackupKey` | fn | — | — | — |
| `shredFile` | fn | — | — | lib/audit-anchor-manifest.js |

## `server/lib/backup-dir.js`

备份输出目录的唯一解析点：相对路径落在 GML_DATA_DIR 内，不落仓库

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `DEFAULT_BACKUP_DIR` | const | — | — | — |
| `LEGACY_DEFAULT_BACKUP_DIR` | const | — | — | — |
| `resolveBackupDir` | fn | — | — | lib/ops-status.js |

## `server/lib/bom.js`

BOM 服务层（模块 10B · 一个 BOM + 三类执行单）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `BOM_STATUS_LABEL` | const | — | — | — |
| `BomError` | class | — | — | — |
| `PRODUCE_WAY_LABEL` | const | — | — | — |
| `USAGE_LABEL` | const | — | — | — |
| `auditBom` | fn | POST /api/manufacture/boms/:id/audit | — | — |
| `bomOverview` | fn | GET /api/manufacture/overview | — | — |
| `bomUsagesOf` | fn | GET /api/manufacture/boms/by-sku | — | — |
| `createBom` | fn | POST /api/manufacture/boms | — | — |
| `deleteBom` | fn | DELETE /api/manufacture/boms/:id | — | — |
| `expandBom` | fn | POST /api/manufacture/boms/:id/expand | — | lib/mfg.js |
| `getBom` | fn | GET /api/manufacture/boms/:id | — | — |
| `getSkuInfo` | fn | — | — | lib/mfg.js |
| `listBoms` | fn | GET /api/manufacture/boms | — | — |
| `localDate` | 再导出（lib/dates.js） | 29 条：ar.js×3, dealers.js×1, demand.js×2, inventory.js×6, oms.js×1, outsourcing.js×4, pos.js×3, purchase.js×1, requisitions.js×6, sales.js×2 | inventory.adjust, inventory.ownership_transfer, inventory.stock_in, inventory.stock_out, inventory.transfer, report.sales_summary | 17 个：lib/accounting.js, lib/ar.js, lib/bom.js, lib/costing.js, lib/credit.js, lib/db-ttl-cache.js … |
| `localNow` | 再导出（lib/dates.js） | — | inventory.list_batches | 22 个：lib/ar.js, lib/bom.js, lib/costing.js, lib/credit-release.js, lib/credit.js, lib/dealer-statement.js … |
| `obsoleteBom` | fn | POST /api/manufacture/boms/:id/obsolete | — | — |
| `resolveBom` | fn | GET /api/manufacture/boms/by-sku | — | lib/mfg.js |
| `skuAvailable` | fn | — | — | — |
| `updateBom` | fn | PUT /api/manufacture/boms/:id | — | — |

## `server/lib/catalog.js`

「可售商品」的判据 —— **只在这里实现一次**。

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `SELLABLE_COND` | const | — | — | — |
| `SELLABLE_JOIN` | const | — | — | — |
| `isSellable` | fn | — | — | — |
| `sellableSkus` | fn | — | — | — |
| `sellableSkusInWarehouse` | fn | — | — | — |

## `server/lib/checkout.js`

模块 18：结算接入层 —— 促销 / 会员 / 券在这里汇合

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `buildItems` | fn | 6 条：mall.js×2, promo.js×4 | — | lib/pos2.js |
| `distribute` | fn | — | — | — |
| `quote` | fn | POST /api/mall/quote<br>POST /api/promo/quote<br>POST /api/promo/explain<br>POST /api/promo/shop/quote | — | lib/pos2.js |
| `settle` | fn | POST /api/mall/orders<br>POST /api/promo/settle | — | lib/pos2.js |
| `settlementOf` | fn | — | — | — |
| `unsettle` | fn | POST /api/mall/orders/:id/cancel<br>POST /api/promo/unsettle | — | lib/pos2.js |

## `server/lib/closing.js`

期末结转（批次 M · 模块 28 的续）：把损益类科目余额搬到「本年利润」，让"结账"这个词有内容

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `CARRY_SOURCE_TYPE` | const | — | — | — |
| `ClosingError` | class | — | — | — |
| `carryForward` | fn | POST /api/reports/periods/:period/carry-forward | — | — |
| `closingStatus` | fn | GET /api/reports/closing/:period | — | — |
| `closingSubject` | fn | — | — | — |
| `closingSubjectCode` | fn | — | — | — |
| `meta` | fn | — | — | — |
| `planClosing` | fn | — | — | — |
| `reverseClosing` | fn | POST /api/reports/periods/:period/reverse-closing | — | — |

## `server/lib/costing.js`

存货核算与成本服务层（模块 09）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `ADJ_STATUS` | const | — | — | — |
| `AMOUNT_TOL` | const | — | — | — |
| `COST_METHODS` | const | — | — | — |
| `CostError` | class | — | — | — |
| `adjustCost` | fn | POST /api/costing/adjustments/:id/adjust | — | — |
| `assertPeriodOpen` | fn | — | — | lib/stock.js |
| `auditCostIntegrity` | fn | GET /api/costing/audit | — | — |
| `closePeriod` | fn | POST /api/costing/periods/close | — | — |
| `costMethod` | fn | — | — | — |
| `costingOverview` | fn | GET /api/costing/overview | — | — |
| `createAdjustment` | fn | POST /api/costing/adjustments | — | — |
| `ensurePeriod` | fn | — | — | — |
| `estimateVariances` | fn | GET /api/costing/variances | — | — |
| `getAdjustment` | fn | GET /api/costing/adjustments/:id<br>POST /api/costing/adjustments/:id/cancel | — | — |
| `isPeriodClosed` | fn | — | — | — |
| `listAdjustments` | fn | GET /api/costing/adjustments | — | — |
| `listPeriods` | fn | GET /api/costing/periods | — | — |
| `periodFinished` | fn | — | — | — |
| `periodOf` | fn | GET /api/costing/layers<br>GET /api/costing/periods<br>POST /api/costing/periods/close | — | — |
| `periodRange` | fn | GET /api/costing/layers | — | — |
| `recompute` | fn | GET /api/costing/audit | — | — |
| `settleCostDiff` | fn | — | — | — |
| `settlementLines` | fn | — | — | — |
| `threeLayers` | fn | GET /api/costing/layers | — | — |
| `transitionAdjustment` | fn | POST /api/costing/adjustments/:id/cancel | — | — |

## `server/lib/coupon.js`

模块 18：优惠券（模板 / 实例 / 发放 / 核销 / 过期）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `INSTANCE_STATUS` | const | — | — | — |
| `INSTANCE_STATUS_LABEL` | const | — | — | — |
| `TEMPLATE_STATUS` | const | — | — | — |
| `TEMPLATE_STATUS_LABEL` | const | — | — | — |
| `availableCoupons` | fn | GET /api/mall/coupons<br>GET /api/promo/shop/member | — | lib/checkout.js |
| `claimCoupon` | fn | POST /api/promo/members/:customerId/coupons | — | — |
| `codesForCustomer` | fn | — | — | lib/checkout.js |
| `createCoupon` | fn | POST /api/promo/coupons | — | — |
| `expireCoupons` | fn | POST /api/promo/coupons/expire | — | — |
| `getCouponDetail` | fn | GET /api/promo/coupons/:id | — | — |
| `issueCoupons` | fn | POST /api/promo/coupons/:id/issue<br>POST /api/promo/members/:customerId/coupons<br>POST /api/promo/shop/claim | — | — |
| `listCoupons` | fn | GET /api/promo/coupons | — | — |
| `listInstances` | fn | GET /api/promo/coupon-instances | — | — |
| `redeemCoupon` | fn | — | — | lib/checkout.js |
| `releaseCoupon` | fn | — | — | lib/checkout.js |
| `resolveValidity` | fn | — | — | — |
| `setCouponStatus` | fn | POST /api/promo/coupons/:id/status | — | — |
| `updateCoupon` | fn | PUT /api/promo/coupons/:id | — | — |
| `validateCoupon` | fn | — | — | — |
| `voidInstance` | fn | POST /api/promo/coupon-instances/:id/void | — | — |

## `server/lib/credit-release.js`

收款释放授信的唯一入口 + 作废时按释放台账逐笔逆向

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `creditSourceOfAr` | fn | — | — | — |
| `releaseForReceipt` | fn | — | — | lib/ar.js |
| `releasesOfReceipt` | fn | — | — | — |
| `reverseForReceipt` | fn | — | — | lib/ar.js |

## `server/lib/credit.js`

信用控制（模块 08A）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `CHANGE_TYPE_LABEL` | const | — | — | — |
| `CHECK_RESULT_LABEL` | const | — | — | — |
| `CreditError` | class | — | — | lib/credit-release.js |
| `adjustCredit` | fn | POST /api/credit/adjust | — | — |
| `auditCredit` | fn | GET /api/credit/audit | — | — |
| `checkCredit` | fn | POST /api/credit/check<br>POST /api/sales/orders/:id/confirm | — | lib/quote.js |
| `creditOverview` | fn | GET /api/credit/overview | — | — |
| `creditSnapshot` | fn | 7 条：credit.js×7 | — | — |
| `ensureAccount` | fn | POST /api/credit/accounts | — | — |
| `ledgerOf` | fn | GET /api/credit/accounts/:id<br>GET /api/credit/ledger | — | — |
| `occupy` | fn | POST /api/sales/orders/:id/confirm | — | — |
| `openAmountOf` | fn | — | — | — |
| `overdueBlockDays` | fn | — | — | — |
| `projectOrderHold` | fn | — | — | lib/sales-order.js |
| `reconcileOrderHolds` | fn | — | — | — |
| `release` | fn | POST /api/credit/release | — | lib/sales-order.js |
| `reoccupy` | fn | — | — | lib/credit-release.js |
| `reprojectOrderHolds` | fn | — | — | — |
| `resolveSubject` | fn | POST /api/credit/settle<br>POST /api/credit/adjust<br>POST /api/credit/release<br>POST /api/sales/orders/:id/confirm | — | lib/sales-order.js |
| `settle` | fn | POST /api/credit/settle | — | lib/credit-release.js |
| `snapshotFor` | fn | — | — | — |
| `updateAccount` | fn | POST /api/credit/accounts/:id | — | — |

## `server/lib/crud.js`

通用增删改查骨架：字段白名单、分页、排序、软删除的**唯一实现**（各路由不要各写一套）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `crudRouter` | fn | 6 条：master.js×6 | — | — |
| `tableColumns` | fn | — | — | — |

## `server/lib/dashboard-sql.js`

看板接口 /trend /top /inventory-dist /channel /recent 的 SQL 文本唯一来源（AC4 / AD3，ADR-0044 补充 2、3）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `INVENTORY_DIST_AGG_SQL` | const | — | — | — |
| `RECENT_SQL` | const | — | — | — |
| `channelOfflineSql` | fn | GET /api/dashboard/channel | — | — |
| `channelOnlineSql` | fn | GET /api/dashboard/channel | — | — |
| `onlineWindow` | fn | — | — | — |
| `sinceDate` | fn | — | — | — |
| `topBrandsSql` | fn | GET /api/dashboard/top | — | — |
| `topDealersSql` | fn | GET /api/dashboard/top | — | — |
| `topProductsSql` | fn | GET /api/dashboard/top | — | — |
| `topStoresSql` | fn | GET /api/dashboard/top | — | — |
| `trendOnlineSql` | fn | GET /api/dashboard/trend | — | — |
| `trendPurchaseSql` | fn | GET /api/dashboard/trend | — | — |
| `trendSalesSql` | fn | GET /api/dashboard/trend | — | — |

## `server/lib/dates.js`

业务日期的**唯一来源**。

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `addDays` | fn | GET /api/inventory/ledger<br>POST /api/outsourcing/orders/:id/receive<br>GET /api/purchase/orders/:id/receive-suggest | — | lib/ar.js, lib/credit.js, lib/order-center.js, lib/quote.js |
| `diffDays` | fn | — | — | — |
| `localDate` | fn | 29 条：ar.js×3, dealers.js×1, demand.js×2, inventory.js×6, oms.js×1, outsourcing.js×4, pos.js×3, purchase.js×1, requisitions.js×6, sales.js×2 | inventory.adjust, inventory.ownership_transfer, inventory.stock_in, inventory.stock_out, inventory.transfer, report.sales_summary | 17 个：lib/accounting.js, lib/ar.js, lib/bom.js, lib/costing.js, lib/credit.js, lib/db-ttl-cache.js … |
| `localNow` | fn | — | inventory.list_batches | 22 个：lib/ar.js, lib/bom.js, lib/costing.js, lib/credit-release.js, lib/credit.js, lib/dealer-statement.js … |
| `monthEnd` | fn | — | — | lib/annual.js, lib/closing.js |

## `server/lib/db-ttl-cache.js`

按数据库连接隔离的短时结果缓存：TTL 之内命中，任何写入（本进程或其它进程）立即失效（AA5，ADR-0044）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `cacheKeyCount` | fn | — | — | — |
| `cacheTtlMs` | fn | GET /api/dashboard/trend<br>GET /api/dashboard/channel<br>GET /api/dashboard/todos<br>GET /api/dashboard/top<br>GET /api/dashboard/inventory-dist | — | — |
| `cachedForDb` | fn | 6 条：dashboard.js×6 | — | — |
| `invalidateForDb` | fn | — | — | — |

## `server/lib/dealer-statement.js`

经销商对账单的生命周期动作：确认 / 发送 / 结清 / 作废 —— **唯一实现**

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `MIN_REASON` | const | — | — | — |
| `SETTLE_TOLERANCE` | const | — | — | — |
| `STATUS_ACTION` | const | — | — | — |
| `StatementError` | class | — | — | — |
| `closeStatement` | fn | POST /api/dealers/statements/:id/close | — | — |
| `setStatementStatus` | fn | POST /api/dealers/statements/:id/status | — | — |
| `statementFigures` | fn | POST /api/dealers/statements | — | — |
| `voidStatement` | fn | POST /api/dealers/statements/:id/void | — | — |

## `server/lib/doc-scope-registry.js`

单据范围谓词注册表（ADR-0032）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `docScopeBuilder` | fn | — | — | lib/docflow.js |
| `registerDocScopeBuilder` | fn | — | — | lib/purchase.js |
| `registeredDocScopeBuilders` | fn | — | — | — |

## `server/lib/docflow.js`

单据内核：状态机驱动的统一流转入口

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `DOC_CREATE_PERMS` | const | — | — | — |
| `DOC_SCOPE_RESOLVERS` | const | — | — | lib/approval.js, lib/role-matrix.js |
| `DocFlowError` | class | — | purchase.build_settlement, purchase.convert_requisition, purchase.create_invoice, purchase.create_order, purchase.create_payment, purchase.create_requisition, purchase.create_return, purchase.receive_order | lib/purchase.js, mcp/tools.js |
| `advanceStatus` | fn | 25 条：demand.js×2, inventory.js×7, oms.js×3, outsourcing.js×1, pos.js×1, purchase.js×3, requisitions.js×3, sales.js×5 | — | lib/pos2.js, lib/returns.js, lib/sales-order.js |
| `allowedActions` | fn | PUT /api/dealers/rebates/:id<br>POST /api/demand/dealer/requisitions/:id/status<br>GET /api/docflow/actions<br>POST /api/requisitions/store/shipments/:id/receive<br>POST /api/requisitions/shipments/:id/ship | — | lib/order-center.js, lib/purchase.js |
| `applyTransition` | fn | POST /api/mall/orders/:id/cancel<br>POST /api/outsourcing/orders/:id/issue<br>POST /api/outsourcing/orders/:id/receive | — | 12 个：lib/ar.js, lib/costing.js, lib/dealer-statement.js, lib/invoice.js, lib/mfg.js, lib/order-center.js … |
| `assertEdgePermitted` | fn | 6 条：docflow.js×1, order-center.js×1, purchase-chain.js×4 | doc.transition, purchase.advance_order | lib/purchase.js, mcp/tools.js |
| `claimTransitionEffect` | fn | — | — | lib/order-center.js, lib/purchase.js |
| `createPermOf` | fn | POST /api/docflow/no-issue | — | — |
| `dispatchTransition` | fn | POST /api/docflow/transition | doc.transition, purchase.advance_invoice, purchase.advance_payment, purchase.advance_requisition, purchase.advance_settlement | mcp/tools.js |
| `docEventScope` | fn | GET /api/docflow/overview<br>GET /api/docflow/history/:docType/:id<br>GET /api/docflow/trace<br>GET /api/docflow/events | — | — |
| `docInScope` | fn | POST /api/docflow/transition<br>GET /api/docflow/history/:docType/:id | doc.get, order.trace_document | lib/approval.js, mcp/tools.js |
| `docScopeOf` | fn | GET /api/docflow/overview | doc.query | mcp/tools.js |
| `effectOwnerOf` | fn | POST /api/docflow/transition | — | lib/approval.js |
| `explainLifecycle` | fn | GET /api/docflow/types/:code/lifecycle<br>GET /api/purchase/chain/flow | — | — |
| `findAction` | fn | — | — | lib/transfer.js |
| `getDocType` | fn | 7 条：docflow.js×3, purchase-chain.js×4 | purchase.advance_order | mcp/tools.js |
| `getMachine` | fn | GET /api/docflow/types/:code/machine | — | — |
| `historyOf` | fn | GET /api/docflow/history/:docType/:id | — | — |
| `listDocTypes` | fn | GET /api/docflow/types | — | — |
| `logEvent` | fn | 7 条：dealers.js×1, oms.js×1, requisitions.js×4, sales.js×1 | — | 7 个：lib/accounting.js, lib/ar.js, lib/invoice.js, lib/pos2.js, lib/purchase.js, lib/rebate.js … |
| `nowText` | fn | POST /api/demand/dealer/requisitions/:id/status<br>POST /api/sales/orders/:id/confirm<br>POST /api/sales/orders/:id/deliver | — | lib/pos2.js, lib/sales-order.js |
| `pruneOrphanEvents` | fn | — | — | — |
| `setApprovalGate` | fn | — | — | lib/approval.js |
| `traceByDocNo` | fn | GET /api/docflow/trace | — | — |
| `transitionPolicyOf` | fn | — | — | — |
| `tryTransition` | fn | POST /api/demand/production/orders/:id/status<br>POST /api/outsourcing/orders/:id/status | — | — |
| `unmappedScopeDocTypes` | fn | — | — | — |

## `server/lib/docno.js`

单据号生成（编码规则 + 计数器）：`nextDocNo` / `nextDocNoAuto` 的**唯一实现**

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `listDocNoRules` | fn | GET /api/docflow/no-rules<br>POST /api/docflow/no-rules | — | — |
| `nextBatchNo` | fn | POST /api/outsourcing/orders/:id/receive | — | lib/purchase.js |
| `nextDocNo` | fn | 19 条：dealers.js×1, demand.js×3, inventory.js×2, mall.js×1, oms.js×3, outsourcing.js×3, requisitions.js×4, sales.js×2 | — | 7 个：lib/accounting.js, lib/bom.js, lib/mfg.js, lib/pos2.js, lib/rebate.js, lib/returns.js … |
| `nextDocNoAuto` | fn | POST /api/docflow/no-issue | — | 7 个：lib/ar.js, lib/invoice.js, lib/mfg.js, lib/purchase.js, lib/qc2.js, lib/quote.js … |
| `nextDocNoByRule` | fn | POST /api/docflow/no-issue | — | lib/order-center.js, lib/purchase.js |
| `previewDocNo` | fn | POST /api/docflow/no-preview<br>POST /api/docflow/no-issue | — | — |

## `server/lib/funds-review.js`

收付款的证据闸与二人复核（maker-checker）—— 唯一实现（ADR-0018）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `FUNDS_REVIEW_LABEL` | const | — | — | — |
| `FUNDS_REVIEW_PERM` | const | — | — | — |
| `FundsError` | class | — | — | — |
| `KINDS` | const | — | — | — |
| `assertNotPending` | fn | POST /api/ar/receipts/:id/void<br>POST /api/purchase/payments/:id/:action | — | lib/purchase.js |
| `confirmFunds` | fn | POST /api/ar/receipts/:id/confirm<br>POST /api/purchase/payments/:id/:action | — | — |
| `fundsPolicy` | fn | — | — | — |
| `needsReview` | fn | — | — | — |
| `reviewFunds` | fn | POST /api/ar/receipts/:id/review<br>POST /api/purchase/payments/:id/review | — | — |
| `reviewOf` | fn | GET /api/ar/receipts/:id<br>GET /api/purchase/payments/:id | — | — |

## `server/lib/hq-roles.js`

总部角色名单（唯一来源，ADR-0051）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `HQ_ROLES` | const | — | — | — |
| `POS_HQ_ROLES` | const | — | — | — |
| `REQUISITION_HQ_ROLES` | const | — | — | — |
| `isHqRole` | fn | — | — | lib/docflow.js, lib/role-matrix.js |

## `server/lib/http.js`

HTTP 响应与错误归一：`ok` / `fail` / `wrap` 的**唯一实现**（统一 `{code,data,message}` 形状）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `GENERIC_5XX_MESSAGE` | const | — | — | — |
| `bizFail` | fn | 11 条：auth.js×1, demand.js×3, meta.js×1, notify.js×1, outsourcing.js×1, quote.js×1, sales.js×3 | — | mcp/server.js |
| `fail` | fn | 192 条：accounting.js×1, ai.js×1, approval.js×5, ar.js×4, auth.js×2, costing.js×1, credit.js×5, dealers.js×10, demand.js×9, dms.js×7, docflow.js×8, im.js×3, inventory.js×14, invoice.js×2, mall.js×7, manufacture.js×5, master.js×11, meta.js×4, notify.js×1, oms.js×10, order-center.js×8, outsourcing.js×7, pos.js×10, pricing.js×3, promo.js×5, purchase-chain.js×10, purchase.js×7, qc.js×2, qc2.js×5, qimen.js×1, quote.js×2, refund.js×1, requisitions.js×11, sales.js×10 | — | lib/crud.js |
| `failFromError` | fn | 170 条：accounting.js×18, auth.js×1, dms.js×17, mall.js×3, meta.js×2, pos.js×3, promo.js×40, purchase-chain.js×33, purchase.js×10, refund.js×4, report.js×39 | — | — |
| `hidesInternals` | fn | — | — | — |
| `newIncidentId` | fn | — | — | — |
| `ok` | fn | 573 条：accounting.js×17, ai.js×4, approval.js×13, ar.js×23, auth.js×15, costing.js×11, credit.js×13, dashboard.js×7, dealers.js×15, demand.js×13, dms.js×13, docflow.js×15, im.js×8, inv-txn-types.js×2, inventory.js×23, invoice.js×14, mall.js×16, manufacture.js×26, master.js×15, meta.js×10, metrics.js×6, notify.js×8, oms.js×12, order-center.js×21, outsourcing.js×9, pos.js×39, pricing.js×8, promo.js×35, purchase-chain.js×33, purchase.js×12, qc.js×9, qc2.js×19, qimen.js×2, quote.js×10, refund.js×8, report.js×38, requisitions.js×14, sales.js×13, warehouses.js×4 | — | lib/crud.js |
| `pageParams` | fn | 66 条：accounting.js×1, ai.js×1, approval.js×2, auth.js×2, costing.js×1, credit.js×1, dealers.js×3, demand.js×2, dms.js×4, docflow.js×1, im.js×2, inv-txn-types.js×1, inventory.js×8, manufacture.js×4, master.js×2, meta.js×1, notify.js×1, oms.js×2, order-center.js×3, outsourcing.js×3, pricing.js×1, promo.js×5, purchase.js×3, qc.js×1, qc2.js×3, quote.js×1, refund.js×1, requisitions.js×2, sales.js×3, warehouses.js×1 | — | lib/crud.js |
| `paged` | fn | 59 条：accounting.js×1, ai.js×1, auth.js×2, costing.js×1, dealers.js×3, demand.js×2, dms.js×4, im.js×2, inv-txn-types.js×1, inventory.js×8, manufacture.js×4, master.js×2, meta.js×1, oms.js×2, order-center.js×3, outsourcing.js×3, pricing.js×1, promo.js×5, purchase.js×3, qc.js×1, qc2.js×3, requisitions.js×2, sales.js×3, warehouses.js×1 | — | lib/crud.js |
| `statusOf` | fn | — | — | — |
| `wrap` | fn | 630 条：accounting.js×18, ai.js×5, approval.js×13, ar.js×23, auth.js×16, costing.js×12, credit.js×13, dashboard.js×7, dealers.js×18, demand.js×15, dms.js×17, docflow.js×15, im.js×10, inv-txn-types.js×4, inventory.js×31, invoice.js×14, mall.js×16, manufacture.js×30, master.js×17, meta.js×12, metrics.js×6, notify.js×8, oms.js×14, order-center.js×24, outsourcing.js×12, pos.js×39, pricing.js×9, promo.js×40, purchase-chain.js×33, purchase.js×15, qc.js×10, qc2.js×22, qimen.js×3, quote.js×10, refund.js×8, report.js×39, requisitions.js×16, sales.js×16 | — | lib/crud.js |

## `server/lib/im-sync.js`

钉钉 / 飞书 组织与审批同步 —— **唯一实现**

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `CONFLICT_CODES` | const | — | — | — |
| `CONFLICT_CODE_LIST` | const | — | — | — |
| `IM_PLATFORMS` | const | — | — | — |
| `IM_PLATFORM_CODES` | const | — | — | — |
| `ImError` | class | — | — | — |
| `MAP_STATUS` | const | — | — | — |
| `RUN_STATUS` | const | — | — | — |
| `SELF_TEST_SNAPSHOT` | const | — | — | — |
| `SYNC_KINDS` | const | — | — | — |
| `applyApprovalSync` | fn | POST /api/im/sync/approval | — | — |
| `applyOrgSync` | fn | POST /api/im/sync/org<br>POST /api/im/self-test | — | — |
| `auditImTrail` | fn | GET /api/im/audit<br>POST /api/im/self-test | — | — |
| `ensureImPlatforms` | fn | — | — | — |
| `fetchApprovalRows` | fn | — | — | — |
| `fetchOrgSnapshot` | fn | — | — | — |
| `getImTransport` | fn | — | — | — |
| `imStatus` | fn | GET /api/im/status | — | — |
| `listConflicts` | fn | GET /api/im/conflicts | — | — |
| `listMappings` | fn | GET /api/im/mappings | — | — |
| `listPlatforms` | fn | GET /api/im/platforms | — | — |
| `listRuns` | fn | GET /api/im/runs | — | — |
| `planApprovalSync` | fn | POST /api/im/self-test | — | — |
| `planOrgSync` | fn | POST /api/im/self-test | — | — |
| `setImTransport` | fn | POST /api/im/self-test | — | — |

## `server/lib/invoice.js`

销售发票（模块 24）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `INVOICE_STATUS_LABEL` | const | — | — | — |
| `InvoiceError` | class | — | — | — |
| `SI_STATUS_LABEL` | const | — | — | — |
| `auditInvoice` | fn | GET /api/invoices/audit | — | — |
| `confirmInvoice` | fn | POST /api/invoices/:id/confirm | — | — |
| `createInvoiceFromDelivery` | fn | POST /api/invoices/from-delivery | — | — |
| `createManualInvoice` | fn | POST /api/invoices/manual | — | — |
| `getInvoice` | fn | GET /api/invoices/:id<br>POST /api/invoices/:id/submit<br>POST /api/invoices/:id/confirm<br>POST /api/invoices/:id/red-chart<br>POST /api/invoices/:id/void | — | — |
| `invoiceOverview` | fn | GET /api/invoices/overview | — | — |
| `listInvoices` | fn | GET /api/invoices/list | — | — |
| `pendingDeliveries` | fn | GET /api/invoices/pending | — | — |
| `pendingLinesOfDelivery` | fn | GET /api/invoices/pending/:deliveryId | — | — |
| `redChartInvoice` | fn | POST /api/invoices/:id/red-chart | — | — |
| `refreshCloseStatus` | fn | POST /api/invoices/refresh-close | — | — |
| `submitInvoice` | fn | POST /api/invoices/:id/submit | — | — |
| `voidInvoice` | fn | POST /api/invoices/:id/void | — | — |

## `server/lib/logger.js`

结构化日志（每事件一行 JSON）+ 请求号（x-request-id）中间件

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `logFormat` | fn | — | — | — |
| `logger` | const | — | — | lib/mcp-rate-limit.js, lib/profile.js, lib/tx.js, mcp/server.js |
| `requestLogger` | fn | — | — | — |

## `server/lib/login-throttle.js`

持久化、有容量上限的登录尝试节流

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `DEFAULT_LOGIN_THROTTLE_POLICY` | const | — | — | — |
| `consumeLoginAttempt` | fn | POST /api/auth/login | — | — |
| `createLoginThrottle` | fn | — | — | — |

## `server/lib/mcp-rate-limit.js`

MCP 按令牌的速率限制与日配额（ADR-0056 / AD9）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `DEFAULT_MCP_RATE` | const | — | — | — |
| `createMcpRateLimiter` | fn | — | — | mcp/server.js |
| `dailyQuotaConfigured` | fn | — | — | — |
| `dailyQuotaState` | fn | — | — | — |
| `mcpRatePolicy` | fn | — | — | — |
| `rateStoreFromEnv` | fn | — | — | — |

## `server/lib/member.js`

模块 18：会员（等级 / 积分 / 储值）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `BALANCE_KIND` | const | — | — | — |
| `BALANCE_KIND_LABEL` | const | — | — | — |
| `LEVEL_LABEL` | const | — | — | lib/checkout.js |
| `POINTS_KIND` | const | — | — | — |
| `POINTS_KIND_LABEL` | const | — | — | — |
| `adjustBalance` | fn | POST /api/promo/members/:customerId/balance | — | — |
| `adjustPoints` | fn | POST /api/promo/members/:customerId/points | — | — |
| `assertLedgerConsistent` | fn | — | — | — |
| `auditMember` | fn | GET /api/promo/audit | — | — |
| `centsToPoints` | fn | — | — | — |
| `centsToYuan` | fn | — | — | — |
| `couponStat` | fn | GET /api/promo/members/:customerId<br>GET /api/promo/shop/member | — | — |
| `deductMaxBp` | fn | — | — | — |
| `earnPoints` | fn | — | — | lib/checkout.js |
| `ensureAccount` | fn | POST /api/mall/orders<br>POST /api/mall/quote | — | lib/checkout.js, lib/pos2.js |
| `getMemberDetail` | fn | GET /api/promo/members/:customerId<br>GET /api/promo/shop/member | — | — |
| `isAutoUpgrade` | fn | — | — | — |
| `levelOf` | fn | — | — | — |
| `listAccounts` | fn | GET /api/promo/members | — | — |
| `listBalanceLedger` | fn | GET /api/promo/members/:customerId/ledger | — | — |
| `listLevels` | fn | GET /api/promo/meta<br>GET /api/promo/levels | — | — |
| `listPointsLedger` | fn | GET /api/promo/members/:customerId/ledger | — | — |
| `payByBalance` | fn | — | — | — |
| `pointsDeductQuote` | fn | — | — | lib/checkout.js |
| `pointsForOrder` | fn | — | — | — |
| `pointsPerYuan` | fn | — | — | — |
| `pointsPerYuanDeduct` | fn | — | — | — |
| `pointsToCents` | fn | — | — | lib/checkout.js |
| `rechargeBalance` | fn | POST /api/promo/members/:customerId/balance | — | — |
| `redeemPoints` | fn | — | — | lib/checkout.js |
| `refundToBalance` | fn | — | — | — |
| `reverseOrderPoints` | fn | — | — | lib/checkout.js |
| `setMemberLevel` | fn | POST /api/promo/members/:customerId/level | — | — |
| `syncLevel` | fn | POST /api/promo/members/:customerId/sync | — | — |
| `updateLevel` | fn | PUT /api/promo/levels/:code | — | — |
| `yuanToCents` | fn | — | — | — |

## `server/lib/metrics-export.js`

Prometheus 文本指标渲染 + 抓取令牌校验（ADR-0045）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `METRICS_TOKEN_MIN_LENGTH` | const | — | — | — |
| `PROMETHEUS_CONTENT_TYPE` | const | — | — | — |
| `metricsTokenOk` | fn | GET /api/meta/metrics | — | — |
| `renderPrometheus` | fn | GET /api/meta/metrics | — | — |
| `shutdownSnapshotLine` | fn | — | — | — |

## `server/lib/metrics-throttle.js`

`/api/meta/metrics` 的按来源 IP 节流（独立桶，ADR-0045 补充 / AB10）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `DEFAULT_METRICS_THROTTLE` | const | — | — | — |
| `createBucketStore` | fn | — | — | lib/mcp-rate-limit.js |
| `createMetricsThrottle` | fn | — | — | — |
| `envInt` | fn | — | — | lib/mcp-rate-limit.js |

## `server/lib/metrics.js`

数据口径字典（模块 23）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `METRICS` | const | — | — | — |
| `METRICS_GLOBAL_MODE_KEY` | const | — | — | — |
| `METRIC_BY_KEY` | const | — | — | — |
| `METRIC_DEFS_FINGERPRINT_ID` | const | — | — | — |
| `isScopeRestricted` | fn | — | — | — |
| `metricCatalog` | fn | GET /api/metrics/catalog | — | — |
| `metricDefinitions` | fn | GET /api/ai/metrics<br>GET /api/metrics/defs<br>GET /api/metrics/stale | — | — |
| `metricDefsStale` | fn | GET /api/metrics/stale<br>POST /api/metrics/sync | — | — |
| `metricGroups` | fn | GET /api/metrics | — | — |
| `metricScopedFlags` | fn | GET /api/metrics/values | — | — |
| `metricValues` | fn | GET /api/metrics/values | — | — |
| `metricVisibility` | fn | GET /api/metrics<br>GET /api/metrics/values<br>GET /api/metrics/catalog | — | — |
| `syncMetricDefs` | fn | POST /api/metrics/sync | — | — |

## `server/lib/mfg.js`

生产制造服务层（模块 10B · 领料 / 完工 / 料工费归集）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `ISSUE_STATUS_LABEL` | const | — | — | — |
| `ISSUE_TYPE_LABEL` | const | — | — | — |
| `MfgError` | class | — | — | — |
| `ORDER_STATUS_LABEL` | const | — | — | — |
| `auditMfg` | fn | GET /api/manufacture/audit | — | — |
| `completeOrder` | fn | POST /api/manufacture/orders/:id/complete | — | — |
| `createIssue` | fn | POST /api/manufacture/issues | — | — |
| `createWorkReport` | fn | POST /api/manufacture/reports | — | — |
| `deleteWorkReport` | fn | DELETE /api/manufacture/reports/:id | — | — |
| `getIssue` | fn | GET /api/manufacture/issues/:id | — | — |
| `getProductionOrder` | fn | GET /api/manufacture/orders/:id | — | — |
| `getWorkReport` | fn | GET /api/manufacture/reports/:id | — | — |
| `issueOut` | fn | — | — | — |
| `listIssues` | fn | GET /api/manufacture/issues | — | — |
| `listProductionOrders` | fn | GET /api/manufacture/orders | — | — |
| `listWorkReports` | fn | GET /api/manufacture/reports | — | — |
| `localDate` | 再导出（lib/dates.js） | 29 条：ar.js×3, dealers.js×1, demand.js×2, inventory.js×6, oms.js×1, outsourcing.js×4, pos.js×3, purchase.js×1, requisitions.js×6, sales.js×2 | inventory.adjust, inventory.ownership_transfer, inventory.stock_in, inventory.stock_out, inventory.transfer, report.sales_summary | 17 个：lib/accounting.js, lib/ar.js, lib/bom.js, lib/costing.js, lib/credit.js, lib/db-ttl-cache.js … |
| `localNow` | 再导出（lib/dates.js） | — | inventory.list_batches | 22 个：lib/ar.js, lib/bom.js, lib/costing.js, lib/credit-release.js, lib/credit.js, lib/dealer-statement.js … |
| `mfgOverview` | fn | — | — | — |
| `planRequirement` | fn | GET /api/manufacture/orders/:id/requirement | — | — |
| `previewCompletion` | fn | GET /api/manufacture/orders/:id/complete-preview | — | — |
| `startOrder` | fn | POST /api/manufacture/orders/:id/start | — | — |
| `transitionIssue` | fn | POST /api/manufacture/issues/:id/submit<br>POST /api/manufacture/issues/:id/approve<br>POST /api/manufacture/issues/:id/issue<br>POST /api/manufacture/issues/:id/cancel | — | — |
| `updateWorkReport` | fn | PUT /api/manufacture/reports/:id | — | — |

## `server/lib/notify.js`

待办推送（通知服务层）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `KNOWN_KINDS` | const | — | — | — |
| `NotifyError` | class | — | — | — |
| `PROVIDERS` | const | — | — | — |
| `buildDigest` | fn | GET /api/notify/preview | — | — |
| `channelKinds` | fn | — | — | — |
| `channelReady` | fn | GET /api/notify/channels<br>POST /api/notify/channels<br>POST /api/notify/channels/:id/toggle | — | — |
| `getChannel` | fn | POST /api/notify/channels/:id/toggle<br>GET /api/notify/preview | — | — |
| `listChannels` | fn | — | — | — |
| `listChannelsPublic` | fn | GET /api/notify/channels | — | — |
| `listLogs` | fn | GET /api/notify/logs | — | — |
| `notifyOverview` | fn | GET /api/notify/overview | — | — |
| `publicChannel` | fn | — | — | — |
| `pushDigest` | fn | POST /api/notify/push | — | — |
| `pushToChannel` | fn | — | — | lib/backup-alert.js |
| `renderMarkdown` | fn | — | — | — |
| `renderPayload` | fn | — | — | — |
| `renderText` | fn | — | — | — |
| `signRequest` | fn | — | — | — |
| `upsertChannel` | fn | POST /api/notify/channels<br>POST /api/notify/channels/:id/toggle | — | — |

## `server/lib/oc-credit.js`

订货中心授信台账（oc_credit_ledger）的唯一写入口。

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `ocCreditUsed` | fn | — | — | lib/order-center.js |
| `releaseByOrder` | fn | — | — | lib/credit-release.js |
| `reoccupyByOrder` | fn | — | — | lib/credit-release.js |
| `writeOcCredit` | fn | — | — | lib/order-center.js |

## `server/lib/ops-status.js`

运维健康快照：最近备份 / 迁移校验和 / 登录节流存储 / 磁盘 / 库体积（ADR-0029）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `computeOpsStatus` | fn | GET /api/meta/health<br>GET /api/meta/metrics | — | — |
| `dbSizes` | fn | — | — | — |
| `diskFreeBytes` | fn | — | — | — |
| `lastBackupStatus` | fn | — | — | — |
| `loginThrottleStatus` | fn | — | — | — |
| `migrationChecksumStatus` | fn | — | — | — |
| `opsCounters` | fn | GET /api/meta/metrics | — | lib/metrics-export.js |

## `server/lib/order-center.js`

订货中心服务层（模块 12A）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `OC_MIN_REASON` | const | — | — | — |
| `OC_SETTLE_TOLERANCE` | const | — | — | — |
| `OrderCenterError` | class | — | — | — |
| `availableQty` | fn | — | — | — |
| `buildStatement` | fn | POST /api/order-center/statements | — | — |
| `checkOrder` | fn | POST /api/order-center/quote | — | — |
| `closeStatement` | fn | POST /api/order-center/statements/:id/close | — | — |
| `confirmStatement` | fn | POST /api/order-center/statements/:id/confirm | — | — |
| `createOrder` | fn | POST /api/order-center/orders | — | lib/quote.js |
| `creditSnapshot` | fn | GET /api/order-center/customers/:id<br>GET /api/order-center/credit/:customerId | — | — |
| `customerInScope` | fn | GET /api/order-center/customers/tree | — | — |
| `customerTree` | fn | GET /api/order-center/customers/tree | — | — |
| `customerWarehouseIds` | fn | GET /api/order-center/customers/:id | — | — |
| `decideApproval` | fn | POST /api/order-center/quote | — | — |
| `ensureCustomer` | fn | — | — | — |
| `getCustomer` | fn | 6 条：order-center.js×6 | — | — |
| `getOrder` | fn | GET /api/order-center/orders/:id<br>GET /api/order-center/orders/:id/repeat<br>GET /api/order-center/orders/:id/actions<br>POST /api/order-center/orders/:id/:action | — | — |
| `getStatement` | fn | GET /api/order-center/statements/:id<br>POST /api/order-center/statements/:id/confirm | — | — |
| `ocAccessCheck` | fn | POST /api/order-center/orders/:id/:action | — | — |
| `ocScope` | fn | 6 条：order-center.js×6 | — | lib/approval.js |
| `overview` | fn | — | — | — |
| `pickWarehouse` | fn | POST /api/order-center/quote | — | — |
| `quoteItems` | fn | POST /api/order-center/quote | — | — |
| `selfCustomerId` | fn | 6 条：order-center.js×6 | — | — |
| `settleStatement` | fn | POST /api/order-center/statements/:id/settle | — | — |
| `statementBalance` | fn | — | — | — |
| `transitionOrder` | fn | POST /api/order-center/orders/:id/:action | — | — |
| `visibleSkus` | fn | GET /api/order-center/catalog | — | — |
| `voidStatement` | fn | POST /api/order-center/statements/:id/void | — | — |
| `writeCredit` | fn | — | — | — |

## `server/lib/outbound-url.js`

出站 HTTP 策略：webhook 目标校验、DNS 钉住、禁重定向、总超时与响应体上限（ADR-0008 / F08）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `DEFAULT_MAX_BODY_BYTES` | const | — | — | — |
| `DEFAULT_TIMEOUT_MS` | const | — | — | — |
| `OutboundUrlError` | class | — | — | lib/notify.js |
| `isBlockedAddress` | fn | — | — | — |
| `outboundPolicy` | fn | — | — | — |
| `outboundRequest` | fn | — | — | lib/notify.js |
| `resolveOutboundTarget` | fn | — | — | — |
| `validateOutboundUrl` | fn | — | — | lib/notify.js |

## `server/lib/password-policy.js`

新设密码的共享纯校验；登录旧密码不套用新强度规则

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `validateNewPassword` | fn | — | — | lib/account-security.js, lib/admin-bootstrap.js |

## `server/lib/period-audit.js`

期间审计链（批次 Q）：把"谁在什么时候把关账/结转/年结/分配改成了什么样"落成**可重放**的日志

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `ACTION_VOUCHER_BIZ_TYPES` | const | — | — | — |
| `FIELD_LEDGER` | const | — | — | — |
| `PERIOD_ACTIONS` | const | — | — | — |
| `PERIOD_STATE_KEYS` | const | — | — | — |
| `PeriodAuditError` | class | — | — | — |
| `REASON_REQUIRED_ACTIONS` | const | — | — | — |
| `auditPeriodTrail` | fn | GET /api/reports/periods/audit/check | — | lib/report.js |
| `listPeriodAudit` | fn | GET /api/reports/periods/audit | — | — |
| `listYearAudit` | fn | — | — | — |
| `logPeriodChange` | fn | — | — | lib/annual.js, lib/closing.js, lib/report.js |
| `meta` | fn | — | — | — |
| `periodStateOf` | fn | — | — | — |
| `replayEntries` | fn | — | — | — |
| `replayPeriodAudit` | fn | — | — | — |

## `server/lib/period.js`

会计期间（批次 L）：期间格式、状态、以及**过账闸门**

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `CARRY_BIZ_TYPE` | const | — | — | lib/closing.js, lib/report.js |
| `PERIOD_STATUS_LABEL` | const | — | — | lib/report.js |
| `PeriodError` | class | — | — | — |
| `assertPeriod` | fn | — | — | lib/annual.js, lib/closing.js, lib/period-audit.js, lib/report.js |
| `assertPeriodOpen` | fn | — | — | lib/accounting.js |
| `ensurePeriod` | fn | — | — | lib/annual.js, lib/closing.js, lib/report.js |
| `getPeriod` | fn | — | — | lib/annual.js, lib/closing.js, lib/period-audit.js, lib/report.js |
| `isPeriodCarried` | fn | — | — | — |
| `isPeriodClosed` | fn | — | — | — |
| `listPeriods` | fn | — | — | lib/report.js |
| `shiftPeriod` | fn | — | — | lib/annual.js, lib/report.js |

## `server/lib/pos2.js`

模块 17：门店交班、核款与长短款

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `CASH_METHOD` | const | — | — | — |
| `DEFAULT_VARIANCE_LIMIT` | const | — | — | — |
| `DROP_STATUS` | const | — | — | — |
| `HANDLE_TYPES` | const | — | — | — |
| `PAY_METHODS` | const | — | — | — |
| `PAY_METHOD_LABEL` | const | — | — | — |
| `VARIANCE_EPS` | const | — | — | — |
| `adjustStoreCheck` | fn | POST /api/pos/stock-checks/:id/adjust | — | — |
| `approveShift` | fn | POST /api/pos/shifts/:id/approve | — | — |
| `assertShiftChecker` | fn | — | — | — |
| `attachLegacyShiftNo` | fn | — | — | — |
| `cancelCashDrop` | fn | POST /api/pos/cash-drops/:id/cancel | — | — |
| `cancelShift` | fn | POST /api/pos/shifts/:id/cancel | — | — |
| `cashInflight` | fn | GET /api/pos/hq/overview<br>GET /api/pos/hq/cash-inflight | — | — |
| `computeDailyCash` | fn | — | — | — |
| `computeShiftSystem` | fn | GET /api/pos/context | — | — |
| `createCashDrop` | fn | POST /api/pos/cash-drops | — | — |
| `createPosOrder` | fn | POST /api/pos/orders | — | — |
| `createStoreCheck` | fn | POST /api/pos/stock-checks | — | — |
| `dailyClose` | fn | POST /api/pos/daily-close | — | — |
| `dailyCloseGate` | fn | GET /api/pos/context<br>GET /api/pos/hq/overview | — | — |
| `declareShift` | fn | POST /api/pos/shifts/:id/declare<br>POST /api/pos/shifts/close | — | — |
| `getVarianceLimit` | fn | GET /api/pos/hq/cash-inflight | — | — |
| `isZero` | fn | — | — | — |
| `listShifts` | fn | GET /api/pos/shifts<br>GET /api/pos/hq/shifts | — | — |
| `openShift` | fn | POST /api/pos/shifts/open | — | — |
| `posQuote` | fn | POST /api/pos/quote | — | — |
| `receiveCashDrop` | fn | POST /api/pos/cash-drops/:id/receive | — | — |
| `rejectShift` | fn | POST /api/pos/shifts/:id/reject | — | — |
| `round2` | fn | — | — | — |
| `settleVariance` | fn | POST /api/pos/shifts/:id/settle-variance | — | — |
| `shiftDetail` | fn | GET /api/pos/shifts/:id<br>GET /api/pos/hq/shifts/:id | — | — |
| `storeReturn` | fn | POST /api/pos/returns | — | — |
| `submitStoreCheckItems` | fn | PUT /api/pos/stock-checks/:id/items | — | — |
| `voidPosOrder` | fn | POST /api/pos/orders/:id/void | — | — |

## `server/lib/pricing.js`

取价引擎：按「匹配度 + 优先级」在四维自由组合的价格组里取值

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `explainPrice` | fn | GET /api/dms/agreements/explain<br>GET /api/pricing/explain | — | — |
| `logPriceChange` | fn | PUT /api/pricing/groups/:id/items | pricing.update_price | lib/agreement.js, mcp/tools.js |
| `resolvePrice` | fn | GET /api/dms/agreements/explain<br>GET /api/pricing/resolve | — | lib/order-center.js, lib/quote.js |
| `resolvePrices` | fn | POST /api/pricing/resolve-batch | — | — |

## `server/lib/process-counters.js`

进程级事件计数器（只增不减，进程重启归零）（ADR-0045）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `COUNTER_DEFS` | const | — | — | lib/metrics-export.js |
| `HISTOGRAM_DEFS` | const | — | — | lib/metrics-export.js |
| `MCP_RESULT_CODES` | const | — | — | — |
| `counterSnapshot` | fn | GET /api/meta/metrics | — | — |
| `histogramSnapshot` | fn | GET /api/meta/metrics | — | — |
| `incCounter` | fn | — | — | lib/audit-trail.js, lib/db-ttl-cache.js, lib/login-throttle.js, lib/mcp-rate-limit.js, mcp/server.js |
| `incMcpToolCall` | fn | — | — | mcp/server.js |
| `mcpCodeTotal` | fn | — | — | — |
| `observeHistogram` | fn | — | — | lib/audit-trail.js |
| `registerMcpTools` | fn | — | — | mcp/server.js |
| `resetCounters` | fn | — | — | — |

## `server/lib/profile.js`

临时分段计时器：`GML_PROFILE=1` 时把一次请求内各代码块的耗时写进结构化日志（AA5）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `createProfiler` | fn | 7 条：dashboard.js×7 | — | — |
| `profilingEnabled` | fn | — | — | — |

## `server/lib/promotion.js`

商城促销引擎（P1 · 促销域第一阶段）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `ALLOCATION` | const | — | — | — |
| `ALLOCATION_LABEL` | const | — | — | — |
| `PROMO_STATUS_LABEL` | const | — | — | — |
| `PROMO_TYPE` | const | — | — | — |
| `PROMO_TYPE_LABEL` | const | — | — | — |
| `PromotionError` | class | — | — | — |
| `TARGET` | const | — | — | — |
| `TARGET_LABEL` | const | — | — | — |
| `computePromotionActions` | fn | — | — | lib/checkout.js |
| `createCampaign` | fn | POST /api/promo/campaigns | — | — |
| `createPromotion` | fn | POST /api/promo/promotions | — | — |
| `deletePromotion` | fn | DELETE /api/promo/promotions/:id | — | — |
| `explainPromotion` | fn | POST /api/promo/explain | — | — |
| `getPromotionDetail` | fn | GET /api/promo/promotions/:id | — | — |
| `listCampaigns` | fn | GET /api/promo/campaigns | — | — |
| `listPromotions` | fn | GET /api/promo/promotions | — | — |
| `persistAdjustments` | fn | — | — | lib/checkout.js |
| `registerUsage` | fn | — | — | lib/checkout.js |
| `revertUsage` | fn | — | — | — |
| `setCampaignStatus` | fn | POST /api/promo/campaigns/:id/status | — | — |
| `setPromotionStatus` | fn | POST /api/promo/promotions/:id/status | — | — |
| `sortPromotions` | fn | — | — | — |
| `updatePromotion` | fn | PUT /api/promo/promotions/:id | — | — |
| `validatePromotionDraft` | fn | POST /api/promo/promotions/validate | — | — |

## `server/lib/purchase.js`

采购域服务层（模块 07）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `DocFlowError` | 再导出（未解析） | — | — | — |
| `PO_READ_PERMS` | const | — | — | lib/metrics.js |
| `PURCHASE_ORDER_FROM` | const | — | — | — |
| `PURCHASE_ORDER_SELECT` | const | — | — | — |
| `PurchaseError` | class | — | — | — |
| `assertNotParamOnly` | fn | — | purchase.advance_order, purchase.advance_requisition | mcp/tools.js |
| `assertPurchaseDocInScope` | fn | 25 条：purchase-chain.js×14, purchase.js×9, qc.js×2 | — | — |
| `buildSettlement` | fn | POST /api/purchase/settlements | purchase.build_settlement | mcp/tools.js |
| `checkOverReceive` | fn | POST /api/purchase/price-preview<br>POST /api/purchase/orders/:id/receive-check | — | — |
| `checkSupplyCatalog` | fn | GET /api/purchase/price<br>POST /api/purchase/price-preview | — | — |
| `convertRequisitionToOrder` | fn | POST /api/purchase/requisitions/:id/convert | purchase.convert_requisition | mcp/tools.js |
| `createInvoice` | fn | POST /api/purchase/invoices | purchase.create_invoice | mcp/tools.js |
| `createPayment` | fn | POST /api/purchase/payments | purchase.create_payment | mcp/tools.js |
| `createPurchaseOrder` | fn | POST /api/purchase/orders | purchase.create_order | mcp/tools.js |
| `createPurchaseReturn` | fn | POST /api/purchase/returns | purchase.create_return | lib/qc.js, lib/qc2.js, mcp/tools.js |
| `createRequisition` | fn | POST /api/purchase/requisitions | purchase.create_requisition | mcp/tools.js |
| `getInvoice` | fn | GET /api/purchase/invoices/:id | — | — |
| `getPayment` | fn | GET /api/purchase/payments/:id<br>POST /api/purchase/payments/:id/review<br>POST /api/purchase/payments/:id/:action | — | — |
| `getPurchaseOrder` | fn | GET /api/purchase/orders/:id<br>PUT /api/purchase/orders/:id | — | — |
| `getPurchaseReturn` | fn | — | — | — |
| `getRequisition` | fn | GET /api/purchase/requisitions/:id | — | — |
| `getSettlement` | fn | GET /api/purchase/settlements/:id | — | — |
| `invoiceOrderIds` | fn | POST /api/purchase/payments/:id/review | — | — |
| `listRequisitions` | fn | GET /api/purchase/requisitions | — | — |
| `matchInvoiceToReceipts` | fn | GET /api/purchase/invoices/:id | — | — |
| `normalizePurchaseOrderLines` | fn | PUT /api/purchase/orders/:id | — | — |
| `planAllocation` | fn | GET /api/purchase/payment-plan | — | — |
| `purchaseActions` | fn | GET /api/purchase/chain/actions<br>GET /api/purchase/requisitions/:id<br>GET /api/purchase/invoices/:id<br>GET /api/purchase/settlements/:id<br>GET /api/purchase/payments/:id | — | — |
| `purchaseOrderScopeSql` | fn | POST /api/demand/dealer/summary<br>GET /api/purchase/orders<br>GET /api/purchase/stats | purchase.list_orders, report.dashboard_kpi | lib/metrics.js, mcp/tools.js |
| `purchaseOverview` | fn | GET /api/purchase/chain/overview | — | — |
| `purchaseReturnSource` | fn | — | — | — |
| `purchaseScopeSql` | fn | 9 条：purchase-chain.js×7, purchase.js×2 | — | lib/approval.js |
| `purchaseTodos` | fn | GET /api/purchase/chain/todos | — | — |
| `recalcOrder` | fn | PUT /api/purchase/orders/:id | — | — |
| `receivePurchaseOrder` | fn | POST /api/purchase/orders/:id/receive | purchase.receive_order | mcp/tools.js |
| `refreshCloseFlags` | fn | POST /api/purchase/invoices<br>GET /api/purchase/orders/:id/closes | — | lib/qc.js |
| `refreshOrderStats` | fn | POST /api/purchase/invoices<br>GET /api/purchase/orders/:id/closes | — | lib/qc.js |
| `resolvePurchasePrice` | fn | GET /api/purchase/price | — | — |
| `resolvePurchasePrices` | fn | POST /api/purchase/price-preview<br>POST /api/purchase/requisitions | purchase.create_requisition | mcp/tools.js |
| `syncSettlePaid` | fn | — | — | — |
| `touchSupplierLastPrice` | fn | POST /api/purchase/supplier-last-price | — | — |
| `transitionInvoice` | fn | POST /api/purchase/invoices/:id/:action | — | — |
| `transitionPayment` | fn | POST /api/purchase/payments/:id/review<br>POST /api/purchase/payments/:id/:action | — | — |
| `transitionPurchaseOrder` | fn | POST /api/purchase/orders/:id/status | purchase.advance_order | lib/approval.js, mcp/tools.js |
| `transitionRequisition` | fn | POST /api/purchase/requisitions/:id/:action | — | — |
| `transitionSettlement` | fn | POST /api/purchase/settlements/:id/:action | — | — |
| `upsertSupplierProduct` | fn | POST /api/purchase/catalog | — | — |
| `writeOffPayment` | fn | — | — | — |

## `server/lib/qc.js`

采购质检服务层（模块 07 · 到货单与质检单拆分）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `QCError` | class | — | — | — |
| `RESULT_LABEL` | const | — | — | — |
| `createInspection` | fn | POST /api/purchase/inspections | — | — |
| `getInspection` | fn | GET /api/purchase/inspections/:id<br>POST /api/purchase/inspections/:id/close<br>POST /api/purchase/inspections/:id/cancel | — | — |
| `getReceiptForInspect` | fn | GET /api/purchase/inspections/receipt/:receiptId | — | — |
| `inspectionOverview` | fn | GET /api/purchase/inspections/overview | — | — |
| `listInspections` | fn | GET /api/purchase/inspections | — | — |
| `pendingReceipts` | fn | GET /api/purchase/inspections/pending | — | — |
| `submitInspection` | fn | POST /api/purchase/inspections/:id/submit | — | — |
| `transitionInspection` | fn | POST /api/purchase/inspections/:id/close<br>POST /api/purchase/inspections/:id/cancel | — | — |

## `server/lib/qc2.js`

质量检验服务层（模块 13 · 报检 / 检验 / 不良品处理）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `DEFECT_CODES` | const | — | — | — |
| `DISPOSITION_LABEL` | const | — | — | — |
| `DISPOSITION_TARGET` | const | — | — | — |
| `DISPOSITION_TARGET_LABEL` | const | — | — | — |
| `MODE_LABEL` | const | — | — | — |
| `QC2Error` | class | — | — | — |
| `RESULT_LABEL` | const | — | — | — |
| `SAMPLE_TABLE` | const | — | — | — |
| `SOURCE_LABEL` | const | — | — | — |
| `auditQc` | fn | GET /api/qc/audit | — | — |
| `cancelHandling` | fn | POST /api/qc/handlings/:id/cancel | — | — |
| `confirmHandling` | fn | POST /api/qc/handlings/:id/confirm | — | — |
| `createHandling` | fn | POST /api/qc/handlings | — | — |
| `createRequest` | fn | POST /api/qc/requests | — | — |
| `directionOf` | fn | — | — | — |
| `getHandling` | fn | GET /api/qc/handlings/:id | — | — |
| `getInspection` | fn | POST /api/qc/inspections/:id/close<br>POST /api/qc/inspections/:id/cancel<br>GET /api/qc/inspections/:id | — | — |
| `getRequest` | fn | POST /api/qc/requests/:id/close<br>POST /api/qc/requests/:id/cancel<br>GET /api/qc/requests/:id | — | — |
| `listHandlings` | fn | GET /api/qc/handlings | — | — |
| `listInspections` | fn | GET /api/qc/inspections | — | — |
| `listRequests` | fn | GET /api/qc/requests | — | — |
| `localDate` | 再导出（lib/dates.js） | 29 条：ar.js×3, dealers.js×1, demand.js×2, inventory.js×6, oms.js×1, outsourcing.js×4, pos.js×3, purchase.js×1, requisitions.js×6, sales.js×2 | inventory.adjust, inventory.ownership_transfer, inventory.stock_in, inventory.stock_out, inventory.transfer, report.sales_summary | 17 个：lib/accounting.js, lib/ar.js, lib/bom.js, lib/costing.js, lib/credit.js, lib/db-ttl-cache.js … |
| `localNow` | 再导出（lib/dates.js） | — | inventory.list_batches | 22 个：lib/ar.js, lib/bom.js, lib/costing.js, lib/credit-release.js, lib/credit.js, lib/dealer-statement.js … |
| `pendingSources` | fn | GET /api/qc/pending | — | — |
| `qcOverview` | fn | GET /api/qc/overview | — | — |
| `recalcDisposition` | fn | — | — | — |
| `samplingPlan` | fn | — | — | — |
| `sourceDetail` | fn | GET /api/qc/pending/detail<br>POST /api/qc/requests | — | — |
| `submitInspection` | fn | POST /api/qc/inspections/:id/submit | — | — |
| `submitRequest` | fn | POST /api/qc/requests/:id/submit | — | — |
| `transitionInspection` | fn | POST /api/qc/inspections/:id/close<br>POST /api/qc/inspections/:id/cancel | — | — |
| `transitionRequest` | fn | POST /api/qc/requests/:id/close<br>POST /api/qc/requests/:id/cancel | — | — |

## `server/lib/qimen-auth.js`

奇门网关鉴权：每平台独立密钥（封存）、HMAC-SHA256 签名、5 分钟时间窗、nonce 防重放（ADR-0033）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `APP_KEY_PREFIX_LEN` | const | — | — | — |
| `NONCE_RETAIN_MS` | const | — | — | — |
| `PLATFORM_PROTECTED_FIELDS` | const | — | — | — |
| `PLATFORM_PUBLIC_SELECT` | const | — | — | — |
| `QIMEN_CODES` | const | — | — | — |
| `QimenCredentialError` | class | — | — | — |
| `WINDOW_MS` | const | — | — | — |
| `appKeyPrefix` | fn | GET /api/qimen/capabilities | — | — |
| `canonicalJson` | fn | — | — | — |
| `canonicalString` | fn | — | — | — |
| `ensureDemoQimenSecret` | fn | — | — | — |
| `issuePlatformSecret` | fn | POST /api/qimen/platforms/:id/secret | — | — |
| `publicPlatform` | fn | GET /api/oms/platforms | — | — |
| `signQimen` | fn | — | — | — |
| `verifyQimenRequest` | fn | POST /api/qimen | — | — |

## `server/lib/quote.js`

销售报价单（模块 08A）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `CUSTOMER_TYPE` | const | — | — | — |
| `QUOTE_STATUS` | const | — | — | — |
| `QuoteError` | class | — | — | — |
| `convertQuote` | fn | POST /api/sales/quotes/:id/convert | — | — |
| `copyQuote` | fn | POST /api/sales/quotes/:id/copy | — | — |
| `createQuote` | fn | POST /api/sales/quotes | — | — |
| `expireQuotes` | fn | POST /api/sales/quotes/expire | — | — |
| `getQuote` | fn | GET /api/sales/quotes/:id | — | — |
| `listQuotes` | fn | GET /api/sales/quotes | — | — |
| `priceQuote` | fn | POST /api/sales/quotes/price | — | — |
| `quoteOverview` | fn | GET /api/sales/quotes/meta<br>GET /api/sales/quotes/overview | — | — |
| `transitionQuote` | fn | POST /api/sales/quotes/:id/action | — | — |

## `server/lib/rebate.js`

经销商返利：计提 → 试算 → 核销 → 冲应收（批次 G · 模块 26）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `POLICY_TYPE_LABEL` | const | — | — | — |
| `REBATE_STATUS_LABEL` | const | — | — | — |
| `RebateError` | class | — | — | — |
| `SETTLEMENT_STATUS_LABEL` | const | — | — | — |
| `accrueRebates` | fn | POST /api/dealers/rebates/calc<br>POST /api/dms/rebates/accrue | — | — |
| `applicablePolicies` | fn | — | — | — |
| `assertPeriod` | fn | — | — | — |
| `auditRebate` | fn | GET /api/dms/rebate-audit | — | — |
| `calcOnePolicy` | fn | — | — | — |
| `confirmRebate` | fn | POST /api/dms/rebates/:id/confirm | — | — |
| `getDealer` | fn | — | — | — |
| `getSettlement` | fn | GET /api/dms/settlements/:id | — | — |
| `listSettlements` | fn | GET /api/dms/settlements | — | — |
| `parseRules` | fn | — | — | — |
| `periodMatches` | fn | — | — | — |
| `planRebate` | fn | POST /api/dms/rebates/plan | — | — |
| `policyApplies` | fn | — | — | — |
| `settleRebates` | fn | POST /api/dms/rebates/settle | — | — |

## `server/lib/redact.js`

日志 / 审计明细 / 错误响应的**唯一脱敏实现**：凭据键整体遮盖、URL 里的 token= 值剥掉、手机号部分遮盖

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `MASK` | const | — | — | — |
| `PII_KEY` | const | — | — | — |
| `SENSITIVE_KEY` | const | — | — | — |
| `redactText` | fn | — | — | lib/audit-view.js, lib/logger.js |
| `redactUrl` | fn | — | — | — |
| `redactValue` | fn | POST /api/qimen | — | lib/audit-trail.js, lib/audit-view.js, lib/http.js, lib/logger.js |

## `server/lib/refund.js`

退款单领域服务（批次 J）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `REFUND_METHODS` | const | — | — | — |
| `REFUND_METHOD_LABEL` | const | — | — | — |
| `REFUND_SOURCE_LABEL` | const | — | — | — |
| `REFUND_STATUS_LABEL` | const | — | — | — |
| `RefundError` | class | — | — | — |
| `auditRefund` | fn | GET /api/refunds/audit | — | — |
| `confirmRefund` | fn | POST /api/refunds/:id/confirm | — | — |
| `createRefund` | fn | POST /api/refunds | — | — |
| `customerOfReturn` | fn | — | — | — |
| `getRefund` | fn | GET /api/refunds/:id | — | — |
| `listRefundables` | fn | GET /api/refunds/refundables | — | — |
| `listRefunds` | fn | GET /api/refunds | — | — |
| `planRefund` | fn | — | — | — |
| `refundableOf` | fn | — | — | — |
| `refundedOf` | fn | — | — | — |
| `voidRefund` | fn | POST /api/refunds/:id/void | — | — |

## `server/lib/report-config-audit.js`

报表口径变更留痕（批次 S）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `REPORT_CONFIG_ACTIONS` | const | — | — | — |
| `REPORT_CONFIG_ACTION_KEYS` | const | — | — | — |
| `REPORT_CONFIG_DANGER_FIELDS` | const | — | — | — |
| `REPORT_CONFIG_FIELD_LABELS` | const | — | — | — |
| `REPORT_CONFIG_TARGETS` | const | — | — | — |
| `REPORT_CONFIG_TARGET_LABELS` | const | — | — | — |
| `ReportConfigAuditError` | class | — | — | — |
| `SNAPSHOT_FIELDS` | const | — | — | — |
| `auditReportConfigTrail` | fn | GET /api/reports/config/audit/check | — | lib/report.js |
| `diffSnapshot` | fn | — | — | lib/report.js |
| `ensureReportConfigTrail` | fn | — | — | — |
| `isDangerChange` | fn | — | — | — |
| `keyOf` | fn | — | — | — |
| `labelFields` | fn | — | — | — |
| `listReportConfigAudit` | fn | GET /api/reports/config/audit | — | — |
| `logReportConfigChange` | fn | — | — | lib/report.js |
| `meta` | fn | GET /api/reports/config/meta | — | — |
| `pickSnapshot` | fn | — | — | — |
| `replayReportConfig` | fn | — | — | — |
| `reportConfigStateOf` | fn | — | — | — |

## `server/lib/report.js`

报表体系（批次 L · 模块 28）：资产负债表 / 利润表 / 现金流量表 + 会计期间 + 期初余额

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `CARRY_BIZ_TYPE` | 再导出（未解析） | — | — | — |
| `CASH_FLOW_CATEGORY_LABEL` | const | — | — | — |
| `CASH_FLOW_DIRECTION_LABEL` | const | — | — | — |
| `CASH_OTHER_BUCKET` | const | — | — | — |
| `COMPARE_MODES` | const | — | — | — |
| `CSV_BOM` | const | — | — | — |
| `DEFAULT_CASH_SUBJECTS` | const | — | — | — |
| `EXPORT_FORMATS` | const | — | — | — |
| `FISCAL_START_DEFAULT` | const | — | — | — |
| `LINE_TYPE_LABEL` | const | — | — | — |
| `MULTI_YEAR_LAG_KEY` | fn | — | — | — |
| `MULTI_YEAR_MAX` | const | — | — | — |
| `MULTI_YEAR_MIN` | const | — | — | — |
| `PERIOD_STATUS_LABEL` | 再导出（未解析） | — | — | — |
| `PeriodError` | 再导出（未解析） | — | — | — |
| `RANGE_MODES` | const | — | — | — |
| `REPORT_BASIS_LABEL` | const | — | — | — |
| `ReportError` | class | — | — | — |
| `XLSX_SHEET_NAME_MAX` | const | — | — | — |
| `assertNaturalFiscalYear` | fn | — | — | lib/annual.js |
| `assertPeriod` | 再导出（未解析） | — | — | — |
| `assertPeriodOpen` | 再导出（未解析） | — | — | — |
| `auditComparison` | fn | GET /api/reports/:code/compare/audit | — | — |
| `auditMultiYear` | fn | GET /api/reports/:code/multi-year/audit | — | — |
| `auditRange` | fn | GET /api/reports/:code/range/audit | — | — |
| `auditReport` | fn | GET /api/reports/audit | — | — |
| `availablePeriods` | fn | — | — | — |
| `balanceSheet` | fn | — | — | — |
| `buildReportCSV` | fn | — | — | — |
| `buildReportXlsx` | fn | — | — | — |
| `cashFlow` | fn | — | — | — |
| `cashFlowBuckets` | fn | — | — | — |
| `cashFlowItemMeta` | fn | GET /api/reports/cashflow-items/meta | — | — |
| `cashSubjectsOf` | fn | — | — | — |
| `closePeriod` | fn | POST /api/reports/periods/:period/close | — | — |
| `columnValue` | fn | — | — | — |
| `columnsOf` | fn | — | — | — |
| `compareReport` | fn | GET /api/reports/:code/compare | — | — |
| `computeReport` | fn | GET /api/reports/:code | — | — |
| `csvCell` | fn | — | — | — |
| `deleteReportLine` | fn | DELETE /api/reports/lines/:id | — | — |
| `ensurePeriod` | 再导出（未解析） | — | — | — |
| `exportReport` | fn | GET /api/reports/:code/export | — | — |
| `fiscalStartMonth` | fn | — | — | lib/annual.js |
| `fiscalYearOf` | fn | — | — | lib/annual.js |
| `getPeriod` | 再导出（未解析） | — | — | — |
| `getReportDef` | fn | — | — | — |
| `inSubjectRange` | fn | — | — | — |
| `incomeStatement` | fn | — | — | lib/annual.js, lib/closing.js |
| `isPeriodCarried` | 再导出（未解析） | — | — | — |
| `isPeriodClosed` | 再导出（未解析） | — | — | — |
| `isRangeCompareMode` | fn | — | — | — |
| `listCashFlowItems` | fn | GET /api/reports/cashflow-items | — | — |
| `listOpeningBalances` | fn | GET /api/reports/opening | — | — |
| `listPeriods` | 再导出（未解析） | — | — | — |
| `listReportDefs` | fn | GET /api/reports/defs | — | — |
| `listReportLines` | fn | GET /api/reports/defs/:code/lines | — | — |
| `meta` | fn | GET /api/reports/meta | — | — |
| `multiYearPeriods` | fn | — | — | — |
| `multiYearReport` | fn | GET /api/reports/:code/multi-year | — | — |
| `openingBalancesAsOf` | fn | — | — | — |
| `operatingSummary` | fn | GET /api/reports/operating | — | — |
| `parseSubjectRange` | fn | — | — | — |
| `parseSubtotalExpr` | fn | — | — | — |
| `reopenPeriod` | fn | POST /api/reports/periods/:period/reopen | — | — |
| `reportFooterLines` | fn | — | — | — |
| `resolveCompareMode` | fn | — | — | — |
| `resolveRange` | fn | — | — | — |
| `saveReportDef` | fn | PUT /api/reports/defs/:code | — | — |
| `saveReportLine` | fn | POST /api/reports/lines | — | — |
| `setOpeningBalances` | fn | PUT /api/reports/opening | — | — |
| `shiftPeriod` | 再导出（未解析） | — | — | — |
| `subjectBalances` | fn | GET /api/reports/subject-balances | — | lib/annual.js, lib/closing.js |
| `subjectRangeMovements` | fn | — | — | — |
| `tagVoucherCashFlow` | fn | POST /api/reports/vouchers/:id/tag-cashflow | — | — |
| `uncarriedProfitSubjects` | fn | — | — | lib/annual.js |

## `server/lib/returns.js`

销售退货闭环（D1）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `ReturnError` | class | — | — | lib/pos2.js |
| `createSalesReturn` | fn | POST /api/sales/returns | — | — |
| `planReturn` | fn | — | — | lib/pos2.js |
| `returnedQtyOfItem` | fn | — | — | — |

## `server/lib/role-matrix.js`

角色 x 单据类型可见度矩阵（AD11；AD2 的生成脚本可复用）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `ACCESS` | const | — | — | — |
| `accessOf` | fn | — | — | — |
| `buildRoleMatrix` | fn | — | — | — |
| `describeCaller` | fn | — | — | — |
| `roleMatrixFor` | fn | GET /api/meta/role-matrix | — | — |
| `unionCells` | fn | — | — | — |

## `server/lib/sales-order.js`

销售订单领域服务（D5）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `SalesOrderError` | class | — | — | lib/quote.js |
| `assertQuoteInScope` | fn | — | — | lib/quote.js |
| `assertQuoteTargetInScope` | fn | — | — | lib/quote.js |
| `assertSalesDocInScope` | fn | 11 条：sales.js×11 | — | lib/quote.js |
| `assertSalesTargetInScope` | fn | 9 条：oms.js×3, sales.js×6 | — | — |
| `cancelOrder` | fn | POST /api/sales/orders/:id/cancel | sales.cancel_order | mcp/tools.js |
| `omsOrderScopeSql` | fn | 7 条：oms.js×7 | — | — |
| `omsPlatformScopeSql` | fn | GET /api/oms/platforms<br>POST /api/oms/stock-push<br>GET /api/oms/sync-logs<br>GET /api/oms/stats<br>GET /api/oms/qimen-stock-message/:platformId | — | — |
| `quoteScopeSql` | fn | — | — | lib/quote.js |
| `salesScopeSql` | fn | GET /api/sales/orders<br>GET /api/sales/deliveries<br>GET /api/sales/returns<br>GET /api/sales/stats | sales.list_orders | lib/approval.js, mcp/tools.js |

## `server/lib/secret-box.js`

配置型密钥的静态加密盒：AES-256-GCM + 版本前缀，旧明文可读、写时升级、支持轮换（ADR-0008 / F09）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `SEALED_PREFIX` | const | — | — | — |
| `SecretBoxError` | class | — | — | — |
| `isSealed` | fn | — | — | lib/qimen-auth.js |
| `keyedPseudonym` | fn | — | — | — |
| `maskSecret` | fn | — | — | lib/qimen-auth.js |
| `openSecret` | fn | — | — | lib/notify.js, lib/qimen-auth.js |
| `resealIfLegacy` | fn | — | — | lib/notify.js |
| `sealSecret` | fn | — | — | lib/notify.js, lib/qimen-auth.js |

## `server/lib/settings.js`

配置（settings）的唯一出处（批次 R）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `INTERNAL_MARKER_KEYS` | const | — | — | — |
| `SETTING_ACTIONS` | const | — | — | — |
| `SETTING_GROUPS` | const | — | — | — |
| `SETTING_KEYS` | const | — | — | — |
| `SETTING_RULES` | const | — | — | lib/mcp-rate-limit.js, lib/pos2.js |
| `SettingError` | class | — | — | — |
| `auditSettingTrail` | fn | GET /api/meta/settings/audit/check | — | lib/report.js |
| `castSettingValue` | fn | — | — | lib/mcp-rate-limit.js |
| `ensureSettings` | fn | GET /api/meta/settings<br>PUT /api/meta/settings<br>POST /api/meta/settings/reset<br>GET /api/meta/settings/audit/check | — | — |
| `listSettingAudit` | fn | GET /api/meta/settings/audit | — | — |
| `listSettings` | fn | GET /api/meta/settings | — | — |
| `logSettingChange` | fn | — | — | — |
| `meta` | fn | — | — | — |
| `normalizeSettingValue` | fn | — | — | lib/mcp-rate-limit.js |
| `readSetting` | fn | 7 条：docflow.js×5, invoice.js×1, meta.js×1 | — | 18 个：lib/accounting.js, lib/annual.js, lib/approval.js, lib/audit-view.js, lib/closing.js, lib/credit.js … |
| `replaySettings` | fn | — | — | — |
| `resetSetting` | fn | POST /api/meta/settings/reset | — | — |
| `settingDef` | fn | — | — | — |
| `settingRow` | fn | — | — | — |
| `settingsStateOf` | fn | — | — | — |
| `writeSetting` | fn | PUT /api/meta/settings | — | — |

## `server/lib/stock.js`

存货核心 v2 —— 五维库存（仓库 × 货主 × SKU × 批次 × 币种）+ 移动加权成本 + 成本流水

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `DOC_TYPE_LABEL` | const | — | — | — |
| `applyOwnershipTransfer` | fn | — | — | — |
| `applyStockGain` | fn | POST /api/inventory/adjust<br>POST /api/inventory/checks/:id/adjust | inventory.adjust | lib/pos2.js, mcp/tools.js |
| `applyStockIn` | fn | POST /api/inventory/assembly/:id/confirm<br>POST /api/outsourcing/orders/:id/receive<br>POST /api/requisitions/store/shipments/:id/receive | — | lib/mfg.js, lib/pos2.js, lib/purchase.js, lib/returns.js, lib/transfer.js |
| `applyStockOut` | fn | 7 条：inventory.js×3, oms.js×1, outsourcing.js×1, requisitions.js×1, sales.js×1 | — | lib/mfg.js, lib/pos2.js, lib/purchase.js, lib/qc2.js, lib/transfer.js |
| `assertStockDocInScope` | fn | 18 条：inventory.js×7, qc.js×4, qc2.js×7 | — | — |
| `assertWarehouseInScope` | fn | 14 条：demand.js×2, inventory.js×3, master.js×1, oms.js×3, purchase.js×4, qc2.js×1 | — | lib/transfer.js |
| `availableQty` | fn | — | — | — |
| `clearInvTypeCache` | fn | POST /api/master/inv-txn-types<br>PUT /api/master/inv-txn-types/:code | — | — |
| `clearParamCache` | fn | — | — | — |
| `consumeStock` | fn | — | — | — |
| `costOf` | fn | — | inventory.get_cost | mcp/tools.js |
| `countBelowSafe` | fn | GET /api/dashboard/summary | — | lib/metrics.js |
| `getInvParam` | fn | — | inventory.stock_alert | mcp/tools.js |
| `getStockRow` | fn | — | — | — |
| `listBelowSafe` | fn | POST /api/ai/query<br>GET /api/dashboard/todos<br>GET /api/inventory/alerts | inventory.stock_alert | mcp/tools.js |
| `pickBatches` | fn | POST /api/inventory/assembly/:id/confirm<br>POST /api/outsourcing/orders/:id/issue<br>POST /api/requisitions/store/:id/to-transfer<br>POST /api/requisitions/shipments/:id/ship | inventory.pick_suggestion, inventory.stock_out, inventory.transfer | lib/mfg.js, lib/pos2.js, mcp/tools.js |
| `planShipment` | fn | POST /api/oms/orders/:id/ship<br>POST /api/sales/orders/:id/deliver | — | — |
| `queryBalance` | fn | — | — | — |
| `releaseForDoc` | fn | POST /api/oms/orders/:id/refund | — | lib/sales-order.js |
| `releaseStock` | fn | — | — | — |
| `reservationsOf` | fn | — | — | — |
| `reserveForDoc` | fn | POST /api/oms/orders/:id/convert<br>POST /api/oms/orders/convert-batch<br>POST /api/sales/orders/:id/confirm | — | — |
| `reserveStock` | fn | — | — | — |
| `resolveCurrency` | fn | — | — | — |
| `resolveOwnerOrg` | fn | — | inventory.adjust, inventory.get_cost, inventory.ownership_transfer, inventory.pick_suggestion, inventory.stock_in, inventory.stock_out, inventory.transfer | mcp/tools.js |
| `setStockNowProvider` | fn | — | — | — |
| `stockScopeSql` | fn | 28 条：demand.js×2, inventory.js×14, master.js×10, oms.js×1, warehouses.js×1 | inventory.list_batches, inventory.list_transactions, inventory.query_stock, inventory.stock_alert, master.get_product_360, report.dashboard_kpi | lib/metrics.js, lib/qc.js, lib/qc2.js, lib/transfer.js, mcp/tools.js |
| `warehouseInScope` | fn | 35 条：inventory.js×1, pos.js×31, qc2.js×2, warehouses.js×1 | inventory.adjust, inventory.get_cost, inventory.ownership_transfer, inventory.pick_suggestion, inventory.stock_in, inventory.stock_out, inventory.transfer | lib/qc2.js, mcp/tools.js |

## `server/lib/store-binding.js`

门店绑定判据（POS / 门店要货 / 发货 / 单据内核共用）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `boundDealerId` | fn | GET /api/metrics<br>GET /api/metrics/values<br>GET /api/metrics/catalog | — | lib/approval.js, lib/docflow.js |
| `boundStoreId` | fn | 39 条：metrics.js×3, pos.js×31, requisitions.js×5 | — | lib/approval.js, lib/docflow.js |
| `isExternalSubject` | fn | GET /api/metrics<br>GET /api/metrics/values<br>GET /api/metrics/catalog | — | lib/approval.js, lib/docflow.js |
| `storeBindingExempt` | fn | GET /api/metrics<br>GET /api/metrics/values<br>GET /api/metrics/catalog | — | lib/approval.js, lib/docflow.js |

## `server/lib/transfer.js`

库存调拨单服务层：**建单 / 出库 / 入库** 三件事的唯一实现。

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `TRANSFER_TYPES` | const | — | — | — |
| `assertTransferInScope` | fn | GET /api/inventory/transfers/:id<br>POST /api/inventory/transfers/:id/ship<br>POST /api/inventory/transfers/:id/receive<br>POST /api/inventory/transfers/:id/submit<br>POST /api/inventory/transfers/:id/cancel | — | — |
| `assertTransferTargetsInScope` | fn | POST /api/inventory/transfers | — | lib/qc2.js |
| `createTransfer` | fn | POST /api/inventory/transfers | — | lib/qc2.js |
| `receiveTransfer` | fn | POST /api/inventory/transfers/:id/receive | — | lib/qc2.js |
| `shipTransfer` | fn | POST /api/inventory/transfers/:id/ship | — | lib/qc2.js |
| `transferScopeSql` | fn | GET /api/inventory/transfers | — | — |

## `server/lib/trust-proxy.js`

受信反向代理的唯一判据（ADR-0040）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `assertTrustProxyConfig` | fn | — | — | — |
| `isSecureRequest` | fn | — | — | — |
| `isTrustedPeer` | fn | — | — | lib/logger.js |
| `parseTrustProxy` | fn | — | — | — |
| `trustProxyFn` | fn | — | — | — |

## `server/lib/tx.js`

写事务的唯一重试实现：`withWriteRetry`（仅 SQLITE_BUSY/LOCKED，原子，带上限与抖动）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `WRITE_RETRY_DEFAULT_MAX` | const | — | — | — |
| `backoffMs` | fn | — | — | — |
| `isBusyError` | fn | — | — | — |
| `resetWriteRetryStats` | fn | — | — | — |
| `withWriteRetry` | fn | 8 条：ar.js×2, inventory.js×3, purchase.js×3 | — | lib/mcp-rate-limit.js |
| `writeRetryMaxFromEnv` | fn | — | — | — |
| `writeRetryStats` | fn | GET /api/meta/metrics | — | — |

## `server/lib/warehouse.js`

仓库（warehouses）的**类型字典**、**可用性判据**、**「单据类型 → 允许仓库」白名单**的唯一出处。

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `DOC_WAREHOUSE_SCOPE_KEY` | const | — | — | — |
| `DOC_WAREHOUSE_SCOPE_UNRESTRICTED` | const | — | — | — |
| `ISOLATION_WAREHOUSE_TYPES` | const | — | — | — |
| `WAREHOUSE_STATUS` | const | — | — | — |
| `WAREHOUSE_TYPES` | const | — | — | — |
| `WAREHOUSE_TYPE_CODES` | const | — | — | lib/order-center.js |
| `WarehouseError` | class | — | — | — |
| `allowedWarehouseCodesForDoc` | fn | — | — | — |
| `assertWarehouseAllowedForDoc` | fn | — | — | lib/purchase.js |
| `assertWarehouseType` | fn | POST /api/master/warehouses<br>PUT /api/master/warehouses/:id | — | — |
| `assertWarehouseUsable` | fn | — | — | lib/purchase.js |
| `docWarehouseScope` | fn | — | — | — |
| `findWarehouse` | fn | GET /api/master/warehouses/:id<br>PUT /api/master/warehouses/:id<br>DELETE /api/master/warehouses/:id | — | — |
| `isIsolationWarehouseType` | fn | — | — | lib/order-center.js |
| `isWarehouseType` | fn | — | — | — |
| `parseDocWarehouseScope` | fn | — | — | — |
| `warehouseTypeLabel` | fn | — | — | — |
| `warehouseTypeOptions` | fn | — | — | — |

## `server/lib/xlsx.js`

零依赖 XLSX（Excel 工作簿）写入器 —— 给"财务报表导出 Excel"用的底层能力。

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `XLSX_CODES` | const | — | — | lib/report.js |
| `XlsxError` | class | — | — | lib/report.js |
| `buildXlsx` | fn | — | — | lib/report.js |
| `crc32` | fn | — | — | — |
| `escapeXml` | fn | — | — | — |
| `sanitizeXmlText` | fn | — | — | — |

## `server/mcp/admin.js`

Agent Token 管理（管理员）：签发 / 列表 / 吊销 / 调用审计

（无具名导出）

## `server/mcp/catalog.js`

「AI 能把系统控制到什么程度」的**唯一口径**

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `GENERIC_DOC_TOOLS` | const | — | — | — |
| `buildMcpCatalog` | fn | — | — | — |
| `ownershipColumns` | fn | — | — | — |

## `server/mcp/delegation.js`

有主 Agent Token 的委托判定：所有者存在 / active / 版本未变；权限与数据范围 = 令牌声明 ∩ 所有者当前

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `TOKEN_OWNER_INACTIVE` | const | — | — | — |
| `TOKEN_OWNER_MISSING` | const | — | — | — |
| `TOKEN_OWNER_PERM_DENIED` | const | — | — | mcp/doc-perms.js |
| `TOKEN_OWNER_REVOKED` | const | — | — | — |
| `effectiveScope` | fn | — | — | mcp/server.js |
| `intersectScope` | fn | — | — | — |
| `ownerToolDenied` | fn | — | — | mcp/server.js |
| `permSnapshot` | fn | — | — | — |
| `permsCovered` | fn | — | — | — |
| `resolveDelegation` | fn | — | — | — |
| `scopeCovers` | fn | — | — | — |
| `scopeSnapshot` | fn | — | — | — |
| `tokenOrgScope` | fn | — | — | — |

## `server/mcp/doc-perms.js`

通用单据读工具的「单据类型 → 查看权限点」唯一映射（ADR-0011 补充 X5）

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `DOC_TYPE_UNMAPPED` | const | — | — | — |
| `DOC_VIEW_PERMS` | const | — | — | lib/role-matrix.js |
| `HQ_ONLY_MODULES` | const | — | — | lib/role-matrix.js |
| `TOKEN_OWNER_BINDING_REQUIRED` | const | — | — | — |
| `TOKEN_OWNER_PERM_DENIED` | 再导出（未解析） | — | — | — |
| `assertCanViewDocType` | fn | — | doc.get, doc.query | mcp/tools.js |
| `bindingOf` | fn | — | — | — |
| `bindingWhere` | fn | — | doc.query | mcp/tools.js |
| `canViewDocType` | fn | — | doc.list_types, order.trace_document | mcp/tools.js |
| `holdsBinding` | fn | — | — | — |
| `rowInBinding` | fn | — | doc.get, order.trace_document | mcp/tools.js |
| `unmappedDocTypes` | fn | — | — | — |
| `viewPermsOf` | fn | — | — | mcp/catalog.js |

## `server/mcp/server.js`

MCP 服务端：以标准 MCP（2026-07-28 无状态版）暴露系统业务能力

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `CACHE_DENIED` | const | — | — | — |
| `mcpRateStore` | const | — | — | — |
| `purgeMcpRateBuckets` | fn | — | — | — |
| `redactArgs` | fn | — | — | — |

## `server/mcp/tokens.js`

Agent Token：AI 接入凭据的签发、校验、吊销

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `EFFECTIVE_STATUS` | const | — | — | — |
| `REVOKE_REASON` | const | — | — | — |
| `SCOPE_LABEL` | const | — | — | — |
| `TOKEN_FIELD_INVALID` | const | — | — | — |
| `TOKEN_OWNER_INACTIVE` | const | — | — | — |
| `TOKEN_OWNER_INVALID` | const | — | — | — |
| `createToken` | fn | — | — | — |
| `effectiveTokenStatus` | fn | — | — | — |
| `ensureDemoTokens` | fn | — | — | — |
| `extractToken` | fn | — | — | — |
| `generateToken` | fn | — | — | — |
| `getTokenWithStatus` | fn | — | — | — |
| `hashToken` | fn | — | — | — |
| `listTokensWithStatus` | fn | — | — | — |
| `revokeOwnerTokens` | fn | — | — | lib/account-security.js |
| `revokeToken` | fn | — | — | — |
| `sweepOwnerRevokedTokens` | fn | — | — | — |
| `tokenAllow` | fn | — | — | — |
| `tokenDeny` | fn | — | — | — |
| `tokenScopes` | fn | — | — | — |
| `touchToken` | fn | — | — | — |
| `verifyToken` | fn | — | — | — |

## `server/mcp/tools.js`

MCP 工具注册表：把系统业务能力以标准 MCP 工具暴露

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `LEVELS` | const | — | — | — |
| `TOOLS` | const | — | — | mcp/catalog.js |
| `TOOL_MAP` | const | — | — | mcp/server.js |
| `listTools` | fn | — | — | — |
| `toolToMcp` | fn | — | — | — |

## `server/mcp/validate.js`

MCP 工具入参校验（唯一实现）。

| 导出 | 类型 | 路由 | MCP 工具 | 被模块调用 |
|---|---|---|---|---|
| `validateToolArgs` | fn | — | — | — |

## MCP 工具 → lib 函数 → 表

| 工具 | 级别 | 权限点 | 调用的 lib 函数 | 工具内 SQL 表 | 经 lib 触达的表 |
|---|---|---|---|---|---|
| `master.search_products` | read | master.product.view | — | brands, categories, product_skus, products | — |
| `master.get_product_360` | read | master.product.view | lib/stock.js: stockScopeSql | inventory_stocks, inventory_transactions, orgs, product_skus, products, warehouses | — |
| `master.list_partners` | read | master.partner.view | — | dealers, stores, suppliers | — |
| `inventory.query_stock` | read | inventory.stock.view | lib/stock.js: stockScopeSql | inventory_stocks, orgs, product_skus, products, warehouses | — |
| `inventory.list_batches` | read | inventory.batch.view | lib/dates.js: localNow<br>lib/stock.js: stockScopeSql | inventory_batches, inventory_stocks, product_skus | warehouses |
| `inventory.get_cost` | read | inventory.cost.view | lib/stock.js: costOf, resolveOwnerOrg, warehouseInScope | warehouses | inventory_stocks |
| `inventory.pick_suggestion` | read | inventory.stock.query | lib/stock.js: pickBatches, resolveOwnerOrg, warehouseInScope | warehouses | inv_params, inventory_batches, inventory_stocks, product_skus, products |
| `inventory.list_transactions` | read | inventory.stock.query | lib/stock.js: stockScopeSql | inventory_transactions, orgs, warehouses | — |
| `inventory.stock_alert` | read | inventory.stock.view | lib/stock.js: getInvParam, listBelowSafe, stockScopeSql | inventory_stocks, product_skus, warehouses | inv_params, products |
| `purchase.list_orders` | read | purchase.order.view, purchase.inbound, purchase.return | lib/purchase.js: purchaseOrderScopeSql | purchase_order_items, purchase_orders, suppliers | warehouses |
| `sales.list_orders` | read | sales.order.view | lib/sales-order.js: salesScopeSql | sales_order_items, sales_orders | stores, warehouses |
| `order.trace_document` | read | sales.order.view, purchase.order.view, inventory.stock.view | lib/docflow.js: docInScope<br>mcp/doc-perms.js: canViewDocType, rowInBinding | dealers, doc_types, inventory_transactions, stores, users, warehouses | ar_documents, assembly_orders, cost_adjustments, dealer_rebates, dealer_requisitions, dealer_statements, material_issues, oc_customers, oc_orders, oc_statements, oms_orders, outsourcing_materials, outsourcing_orders, outsourcing_receipts, pos_daily_closes, pos_orders, pos_shifts, production_orders, purchase_inspections, purchase_invoices, purchase_orders, purchase_payments, purchase_receipts, purchase_requisitions, purchase_returns, purchase_settlements, qc_defect_handlings, qc_inspections, qc_requests, receipts, refunds, role_permissions, sales_deliveries, sales_invoices, sales_orders, sales_quotes, sales_returns, stock_checks, stock_transfers, store_requisitions, store_shipments, user_roles, vouchers |
| `report.sales_summary` | read | sales.order.view | lib/dates.js: localDate | dealers, sales_orders, stores, warehouses | — |
| `report.dashboard_kpi` | read | — | lib/purchase.js: purchaseOrderScopeSql<br>lib/stock.js: stockScopeSql | dealers, inventory_stocks, product_skus, purchase_orders, sales_orders, stores, warehouses | role_permissions, user_roles, users |
| `org.tree` | read | — | — | orgs | — |
| `inventory.stock_in` | write | purchase.inbound | lib/dates.js: localDate<br>lib/stock.js: resolveOwnerOrg, warehouseInScope | warehouses | — |
| `inventory.stock_out` | write | sales.outbound | lib/dates.js: localDate<br>lib/stock.js: pickBatches, resolveOwnerOrg, warehouseInScope | warehouses | inv_params, inventory_batches, inventory_stocks, product_skus, products |
| `inventory.transfer` | write | inventory.transfer | lib/dates.js: localDate<br>lib/stock.js: pickBatches, resolveOwnerOrg, warehouseInScope | warehouses | inv_params, inventory_batches, inventory_stocks, product_skus, products |
| `inventory.ownership_transfer` | write | inventory.transfer.ownership | lib/dates.js: localDate<br>lib/stock.js: resolveOwnerOrg, warehouseInScope | warehouses | — |
| `inventory.adjust` | danger | inventory.adjust | lib/dates.js: localDate<br>lib/stock.js: applyStockGain, resolveOwnerOrg, warehouseInScope | warehouses | cost_periods, inv_params, inv_txn_types, inventory_batches, inventory_stocks, inventory_transactions, stock_cost_ledger |
| `pricing.update_price` | danger | master.price.edit | lib/pricing.js: logPriceChange | — | price_change_logs |
| `sales.cancel_order` | danger | sales.order.edit | lib/sales-order.js: cancelOrder | — | credit_accounts, credit_ledger, dealers, doc_actions, doc_events, doc_states, doc_types, inv_params, inventory_batches, inventory_reservations, inventory_stocks, oc_customers, product_skus, products, sales_deliveries, sales_order_items, sales_orders, sales_returns, stores, warehouses |
| `approval.approve` | danger | approval.instance.act | lib/approval.js: decideApproval | approval_instances, dealers, doc_types, stores, users, warehouses | approval_records, approval_steps, ar_documents, assembly_orders, brands, cost_adjustments, dealer_rebates, dealer_requisitions, dealer_statements, doc_actions, doc_events, doc_states, doc_transition_policy, material_issues, oc_addresses, oc_customers, oc_orders, oc_statements, oms_orders, orgs, outsourcing_materials, outsourcing_orders, outsourcing_receipts, permissions, pos_daily_closes, pos_orders, pos_shifts, product_skus, production_orders, products, purchase_inspections, purchase_invoices, purchase_order_items, purchase_orders, purchase_payments, purchase_receipts, purchase_requisitions, purchase_returns, purchase_settlements, qc_defect_handlings, qc_inspections, qc_requests, receipts, refunds, role_permissions, roles, sales_deliveries, sales_invoices, sales_orders, sales_quotes, sales_returns, stock_checks, stock_transfers, store_requisitions, store_shipments, suppliers, user_roles, vouchers |
| `purchase.create_requisition` | write | purchase.req.edit | lib/purchase.js: createRequisition, resolvePurchasePrices | users | doc_no_counters, doc_no_rules, doc_types, product_skus, products, purchase_order_items, purchase_orders, purchase_requisition_items, purchase_requisitions, role_permissions, supplier_products, user_roles |
| `purchase.create_order` | write | purchase.order.edit | lib/purchase.js: createPurchaseOrder | users | brands, doc_no_counters, doc_no_rules, doc_types, product_skus, products, purchase_order_items, purchase_orders, purchase_receipts, role_permissions, settings, suppliers, user_roles, warehouses |
| `purchase.create_invoice` | write | purchase.invoice.edit | lib/purchase.js: createInvoice | users | doc_no_counters, doc_no_rules, doc_types, product_skus, purchase_invoice_items, purchase_invoices, purchase_order_items, purchase_orders, purchase_receipts, purchase_settlement_items, purchase_settlements, role_permissions, suppliers, user_roles |
| `purchase.build_settlement` | write | purchase.settle.edit | lib/purchase.js: buildSettlement | users | doc_no_counters, doc_no_rules, doc_types, product_skus, purchase_invoice_items, purchase_invoices, purchase_order_items, purchase_orders, purchase_payment_items, purchase_payments, purchase_receipt_items, purchase_receipts, purchase_return_items, purchase_returns, purchase_settlement_items, purchase_settlements, role_permissions, settings, suppliers, user_roles, warehouses |
| `purchase.create_payment` | write | purchase.payment.edit | lib/purchase.js: createPayment | users | doc_no_counters, doc_no_rules, doc_types, purchase_payment_items, purchase_payments, purchase_settlements, role_permissions, suppliers, user_roles, warehouses |
| `purchase.create_return` | write | purchase.return | lib/purchase.js: createPurchaseReturn | purchase_returns, users | cost_periods, doc_actions, doc_events, doc_no_counters, doc_no_rules, doc_states, doc_types, inv_params, inv_txn_types, inventory_batches, inventory_stocks, inventory_transactions, product_skus, products, purchase_order_items, purchase_orders, purchase_receipt_items, purchase_receipts, purchase_return_items, role_permissions, settings, stock_cost_ledger, user_roles, warehouses |
| `purchase.advance_requisition` | danger | — | lib/docflow.js: dispatchTransition<br>lib/purchase.js: assertNotParamOnly | dealers, purchase_invoices, purchase_orders, purchase_payments, purchase_receipts, purchase_requisitions, purchase_returns, purchase_settlements, stores, users, warehouses | doc_actions, doc_events, doc_states, doc_transition_policy, doc_types, role_permissions, user_roles |
| `purchase.convert_requisition` | danger | — | lib/purchase.js: convertRequisitionToOrder | dealers, purchase_invoices, purchase_orders, purchase_payments, purchase_receipts, purchase_requisitions, purchase_returns, purchase_settlements, stores, users, warehouses | doc_actions, doc_events, doc_no_counters, doc_no_rules, doc_states, doc_types, product_skus, products, purchase_order_items, purchase_requisition_items, role_permissions, settings, supplier_products, user_roles |
| `purchase.advance_order` | danger | — | lib/docflow.js: assertEdgePermitted, getDocType<br>lib/purchase.js: assertNotParamOnly, transitionPurchaseOrder | dealers, purchase_invoices, purchase_orders, purchase_payments, purchase_receipts, purchase_requisitions, purchase_returns, purchase_settlements, stores, users, warehouses | brands, doc_actions, doc_events, doc_states, doc_types, product_skus, products, purchase_order_items, role_permissions, suppliers, user_roles |
| `purchase.receive_order` | danger | — | lib/purchase.js: receivePurchaseOrder | dealers, purchase_invoices, purchase_orders, purchase_payments, purchase_receipts, purchase_requisitions, purchase_returns, purchase_settlements, stores, users, warehouses | brands, cost_periods, doc_actions, doc_events, doc_no_counters, doc_no_rules, doc_states, doc_types, inv_params, inv_txn_types, inventory_batches, inventory_stocks, inventory_transactions, payment_release_ledger, product_skus, products, purchase_invoice_items, purchase_order_items, purchase_payment_items, purchase_receipt_items, purchase_settlement_items, receipts, role_permissions, stock_cost_ledger, supplier_products, suppliers, user_roles |
| `purchase.advance_invoice` | danger | — | lib/docflow.js: dispatchTransition | dealers, purchase_invoices, purchase_orders, purchase_payments, purchase_receipts, purchase_requisitions, purchase_returns, purchase_settlements, stores, users, warehouses | doc_actions, doc_events, doc_states, doc_transition_policy, doc_types, role_permissions, user_roles |
| `purchase.advance_settlement` | danger | — | lib/docflow.js: dispatchTransition | dealers, purchase_invoices, purchase_orders, purchase_payments, purchase_receipts, purchase_requisitions, purchase_returns, purchase_settlements, stores, users, warehouses | doc_actions, doc_events, doc_states, doc_transition_policy, doc_types, role_permissions, user_roles |
| `purchase.advance_payment` | danger | — | lib/docflow.js: dispatchTransition | dealers, purchase_invoices, purchase_orders, purchase_payments, purchase_receipts, purchase_requisitions, purchase_returns, purchase_settlements, stores, users, warehouses | doc_actions, doc_events, doc_states, doc_transition_policy, doc_types, role_permissions, user_roles |
| `doc.list_types` | read | — | mcp/doc-perms.js: canViewDocType | doc_actions, doc_states, doc_types | role_permissions, user_roles, users |
| `doc.query` | read | — | lib/docflow.js: docScopeOf<br>mcp/doc-perms.js: assertCanViewDocType, bindingWhere | doc_types, users | ar_documents, assembly_orders, cost_adjustments, dealer_rebates, dealer_requisitions, dealer_statements, dealers, material_issues, oc_customers, oc_orders, oc_statements, oms_orders, outsourcing_materials, outsourcing_orders, outsourcing_receipts, pos_daily_closes, pos_orders, pos_shifts, production_orders, purchase_inspections, purchase_invoices, purchase_orders, purchase_payments, purchase_receipts, purchase_requisitions, purchase_returns, purchase_settlements, qc_defect_handlings, qc_inspections, qc_requests, receipts, refunds, role_permissions, sales_deliveries, sales_invoices, sales_orders, sales_quotes, sales_returns, stock_checks, stock_transfers, store_requisitions, store_shipments, stores, user_roles, vouchers, warehouses |
| `doc.get` | read | — | lib/docflow.js: docInScope<br>mcp/doc-perms.js: assertCanViewDocType, rowInBinding | doc_events, doc_types, users | ar_documents, assembly_orders, cost_adjustments, dealer_rebates, dealer_requisitions, dealer_statements, dealers, material_issues, oc_customers, oc_orders, oc_statements, oms_orders, outsourcing_materials, outsourcing_orders, outsourcing_receipts, pos_daily_closes, pos_orders, pos_shifts, production_orders, purchase_inspections, purchase_invoices, purchase_orders, purchase_payments, purchase_receipts, purchase_requisitions, purchase_returns, purchase_settlements, qc_defect_handlings, qc_inspections, qc_requests, receipts, refunds, role_permissions, sales_deliveries, sales_invoices, sales_orders, sales_quotes, sales_returns, stock_checks, stock_transfers, store_requisitions, store_shipments, stores, user_roles, vouchers, warehouses |
| `doc.transition` | write | — | lib/docflow.js: assertEdgePermitted, dispatchTransition | dealers, doc_actions, doc_types, stores, users, warehouses | doc_events, doc_states, doc_transition_policy, role_permissions, user_roles |
