# 变更记录

本文件的“按批次”部分由 `node scripts/gen-changelog.mjs` 从 `docs/implementation/ADR-*.md` 生成，CI 校验不漂移；标记行之上是手写说明。

- 当前版本号以 `package.json` 为准（预发布 alpha），不是可用于生产或商用交付的声明：验收状态、未关闭事项与验证边界以 [整改跟踪](docs/implementation/backlog.md) 和 [开发进度](docs/implementation/progress.md) 为准。
- 这里只转述各 ADR 写下的决定，不代表已在目标主机上验收；没有 ADR 的工作（脚本、文档、测试）见开发进度。
- 批次划分来自开发进度；同一 ADR 后续的修订可能在原文件内更新。

<!-- generated -->

## 第十批（进行中）：见 roadmap-v6

- [ADR-0041：MCP `order.trace_document` 与 `doc.query` 按单据解析器表判归属](docs/implementation/ADR-0041-mcp-trace-query-scope.md) — 判据唯一化：两个工具的归属都走 `docflow.docScopeOf / docInScope`（即 `/api/docflow/history`、`doc.get` 用的同一份解析器表）。入参由新的 `docScopeCtx(db, ctx)` 组装：`orgScope = ctx.scope`（令牌范围 ∩ 所有者当前范围，ADR-0011 `effectiveScope`），`user` = 令牌所有者行（`store` 型解析器需要 `store_id`；无主令牌为…
- [ADR-0042：OMS 写路由与 MCP 库存工具按组织范围收口](docs/implementation/ADR-0042-oms-write-mcp-inventory-scope.md) — 判据不新增：沿用 ADR-0034 / 0039 的「平台绑定组织 = 平台履约仓所属组织」（`omsOrderScopeSql` / `omsPlatformScopeSql`，`server/lib/sales-order.js`），仓库侧用 ADR-0038 的 `assertWarehouseInScope` / `stockScopeSql`（`server/lib/stock.js`）。 2. `ship` / `complete` / `refund` 增 `a…
- [ADR-0044：低库存口径统一与看板热点块（AA5）](docs/implementation/ADR-0044-dashboard-hot-blocks.md) — `metrics.js` / `ai.js` / `tools.js` 全部改调 `countBelowSafe` / `listBelowSafe`（`lib/stock.js`）。口径差异（有意为之，逐条列出）
- [ADR-0045 Prometheus 指标导出与抓取令牌（AA10）](docs/implementation/ADR-0045-metrics-export.md) — `GET /api/meta/metrics?format=prometheus` 返回 `text/plain; version=0.0.4; charset=utf-8`（`Cache-Control: no-store`），每个指标族一行 `# HELP`、一行 `# TYPE`，名字统一前缀 `os_erp_`。无 `format` 或 `format=json` 与 ADR-0029 完全一致；其它 `format` 值 ⇒ 400（不静默回落）。
- [ADR-0049 审计日志防篡改哈希链与归档（AB6）](docs/implementation/ADR-0049-audit-hash-chain.md) — `audit_logs` 增 `prev_hash TEXT`、`row_hash TEXT`。 - `row_hash = sha256( JSON.stringify([id, created_at, user_id, action, entity, entity_id, detail, prev_hash]) )`：八个分量先转字符串（NULL 保持 `null`）再做 JSON 数组序列化；`prev_hash` = 前一行（按 id）的 `row_hash`，库里最…

## 第九批：见 roadmap-v5

- [ADR-0038：库存域与采购订单状态/收货路由按组织范围收口](docs/implementation/ADR-0038-inventory-scope.md) — 一处判据：`server/lib/stock.js` 的 `stockScopeSql(orgScope, alias, column='warehouse_id')`，键为 `warehouses.org_id`。不传或 `all` ⇒ `1=1`；`dealer` / `none` / 空集合 ⇒ `1=0`；仓库 `org_id` 为 NULL 对受限范围不可见。同文件还有 `warehouseInScope` / `assertWarehouseInScope`（写目…
- [ADR-0039：OMS 读接口与 MCP 单据历史工具按组织范围收口](docs/implementation/ADR-0039-oms-mcp-history-scope.md) — 判据：沿用 ADR-0034 的「平台绑定组织 = 平台履约仓 `platforms.warehouse_id` 所属组织 `warehouses.org_id`」。判据仍只在 `server/lib/sales-order.js` 一处： - `omsPlatformScopeSql(orgScope, alias)`：作用在 `platforms` 行； - `omsOrderScopeSql(orgScope, alias)`：作用在 `oms_orders` 行（经 …
- [ADR-0040 受信代理配置（Z4）](docs/implementation/ADR-0040-trust-proxy.md) — 其它值启动即失败：`server/index.js` 在装配 Express 前调用 `assertTrustProxyConfig()`，抛 `TRUST_PROXY_INVALID`（`code` 字段；消息含 `GML_TRUST_PROXY`）。拒绝：`true` / `1` / `2`（跳数）/ `*`、`loopback` 与 CIDR 混写、空项、前缀越界或非数字、前缀 0（0.0.0.0/0、::/0 即全网）、含 `%zone` 的地址、前缀 <96 的 I…

## 第八批（进行中）：见 roadmap-v4

- [ADR-0031：采购链动作路由与 MCP 采购工具的单据范围](docs/implementation/ADR-0031-purchase-action-scope.md) — 动作路由统一的门 `actionGate` = `requireAuth` → `requireInternal('采购单据')` → `attachOrgScope`，用于四条 `/:id/:action`、`/requisitions/:id/convert`、`/payments/:id/review`。外部主体（dealer / store）在动作权限之前就 403。 2. 单据范围判定紧跟动作权限、先于任何写：`assertActionPermitted` 在 `a…
- [ADR-0032：单据流读接口按账号数据范围过滤](docs/implementation/ADR-0032-docflow-scope.md) — `doc_events` 行只有 `(doc_type, doc_id)`，没有统一的组织归属，所以"这条事件能不能给这个账号看"回到它指向的单据，用该单据领域已有的范围谓词判定。分发表按 `doc_types.code` 一行一项，冻结导出；Y12（审批实例范围）直接复用。
- [ADR-0033：奇门网关平台凭据、签名契约与重新开放验收清单](docs/implementation/ADR-0033-qimen-credentials.md) — 每平台独立密钥。迁移 `060_qimen_secrets` 给 `platforms` 加 `app_secret_sealed`（`secret-box.js` 的 `enc:v1:` 封存值）和 `app_secret_rotated_at`，新增 `qimen_nonces`（防重放）和权限点 `oms.platform.manage`（首次迁移仅授予 admin，ADR-0007 口径：`verify()` 不检查角色授权集合）。已有平台的密钥为空 ⇒ 网关 401…
- [ADR-0034：报价、MCP 销售工具与 OMS 入口按组织范围收口](docs/implementation/ADR-0034-quote-sales-mcp-scope.md) — 一处判据，仍在 `server/lib/sales-order.js`，不在新文件里再抄一份： - 订单类沿用 ADR-0026 的 `salesScopeSql` / `assertSalesDocInScope` / `assertSalesTargetInScope`，不改。 - 新增 `quoteScopeSql(orgScope, alias)`、`assertQuoteInScope(db, id, orgScope)`、`assertQuoteTargetInS…
- [ADR-0035：写路径并发与 SQLITE_BUSY 治理](docs/implementation/ADR-0035-write-contention.md) — 默认 5000（沿用旧值）。必须是 0..300000 的十进制整数，否则启动抛 `SQLITE_BUSY_MS_INVALID`（拼错的配置宁可失败，也不静默回落）。
- [ADR-0036 安全响应头与后台会话传输（Y11）](docs/implementation/ADR-0036-security-headers-and-session-transport.md) — `GML_CSP_MODE=report|enforce|off`：生产（缺省的运行模式）默认 enforce，demo/test 默认 report；非法值回落到该运行模式的默认值（不会因拼错而静默关闭）。
- [ADR-0037：审批域按指向单据的组织范围收口](docs/implementation/ADR-0037-approval-scope.md) — 审批实例没有自己的归属，一律跟着它指向的单据（`doc_type` + `doc_id`）。唯一判据在 `server/lib/approval.js`

## 第七批：POS/销售/订货中心范围、运维健康与个人信息

- [ADR-0025：门店 POS 路由按动作授权、跨店 404、交班核款二人分离](docs/implementation/ADR-0025-pos-authorization.md) — `requireStore()` 放行 `admin` 与绑定了门店（`store_id`）的账号，不再硬编码 `role==='store'`（独立审计 P2：否则只带日常权限的自定义角色用不了 POS）；真正的闸是紧随其后的 `requirePerm` 权限点（admin / 超管恒真）。未绑门店且非 admin 一律 403。权限点沿用 005 / 024 已登记的字典项，不另造同义词，只补两处缺口
- [ADR-0026：销售域读写按内部账号组织范围收口](docs/implementation/ADR-0026-sales-org-scope.md) — 一处判据，在 `server/lib/sales-order.js`，与采购侧 `purchaseScopeSql` / `assertPurchaseDocInScope`（ADR-0017 / 0020）同一形状： - `salesScopeSql(orgScope, kind, alias)` → `{ sql, params, empty }`。不传或 `all` ⇒ `1=1`；`dealer` / `none` / 空集合 ⇒ `1=0`（空范围不许变成全库）。 …
- [ADR-0027：订货中心按客户归属组织收口](docs/implementation/ADR-0027-order-center-scope.md) — （ADR 未写出“决定”段，仅列标题）
- [ADR-0028：杂项授权缺口收口（no-issue / orgs / qimen / 付款与结算范围）](docs/implementation/ADR-0028-authz-misc.md) — `POST /api/docflow/no-issue`（真实取号会消耗序号）：非干跑要求调用者持有该单据类型的创建权限。映射表是 `server/lib/docflow.js` 的 `DOC_CREATE_PERMS`（唯一出处，`createPermOf(code)` 取值）。类型没有映射（含未注册类型、原型链键）⇒ `403 DOC_TYPE_PERM_UNMAPPED`，管理员同样：映射缺项是工程缺口，不是权限问题。缺权限 ⇒ `403 DOC_CREATE_PERM…
- [ADR-0029 运维健康块、计数器与备份失败告警](docs/implementation/ADR-0029-ops-health.md) — `server/lib/ops-status.js` 只读汇总，每项独立 try/catch（一项失败只让该项变 null / unavailable）
- [ADR-0030：日志保留清理与个人信息处理](docs/implementation/ADR-0030-retention-and-privacy.md) — 设置键（`ops` 组，`int`，`is_danger`）：`retention_audit_days` 默认 365（90–3650）、`retention_notify_log_days` 默认 90（7–3650）、`retention_mcp_log_days` 默认 90（7–3650）。缩短窗口 = 更早永久删除，所以按既有判据是危险键，改动必须写理由；`scripts/test-setting-audit.mjs` 钉死的危险键集合由 14 变 17。 - 默…

## 第六批：详情范围、路由守卫、备份加密、日志与付款台账

- [ADR-0020：采购链详情与辅助读接口同一道门、逐单范围判定](docs/implementation/ADR-0020-purchase-detail-scope.md) — 详情 / 动作 / 预览类接口共用 ADR-0017 的 `readGate`（内部主体 → 采购读权限 → 挂组织范围）。 - 单据详情取单前调用 `lib/purchase.js` 的 `assertPurchaseDocInScope(db, docType, id, orgScope)`：与 `purchaseScopeSql` 同一判据（PRQ / PI / PST / PAY 按 `org_id`，PO / GR 经 `warehouses.org_id`；NUL…
- [ADR-0021 路由授权清单守卫](docs/implementation/ADR-0021-route-authz-guard.md) — 新增静态守卫 `scripts/check-route-authz.mjs`（登记为 `check:route-authz`，进入 `regress-all`）
- [ADR-0022：备份加密与三库一致点](docs/implementation/ADR-0022-backup-encryption.md) — `GML_BACKUP_KEY` 未设置：行为不变。设置且 ≥32 字节：输出 `<库>_<stamp>.db.enc`。设置但过短：退出码 2（不静默降级为明文）。 - 格式 v1：`"OSBK" | 0x01 | salt(32) | iv(12) | 密文 | tag(16)`。整个 header 作为 GCM AAD，改动任何头部字节解密即失败。 - 密钥派生：文件密钥 = HKDF-SHA256(`GML_BACKUP_KEY` 的 UTF-8 字节, salt=每…
- [ADR-0023 结构化日志与请求号贯通](docs/implementation/ADR-0023-structured-logging.md) — `server/lib/logger.js` 是服务端日志的唯一出口，每事件一行 JSON：`{ts, level, msg, req_id, user_id, industry, route, status, duration_ms, incident_id, ...}`。所有字段（含嵌套）统一过 `lib/redact.js`；`ts/level/msg` 保留字不可被字段覆盖；`Error` 序列化为 `{name, code, message, stack}` 后同样…
- [ADR-0024：供应商付款释放台账，作废按台账逐笔逆向](docs/implementation/ADR-0024-payment-release-ledger.md) — 迁移 `057_payment_release_ledger.cjs`：`payment_release_ledger`（payment_id、item_id、supplier_id、settle_id、amount、paid_before、paid_after、reversed_at、reversal_ref）。 - 付款单 `submit`（用友口径：审核即核销，应付在此刻冲减）后，按明细逐张结算单写行（幂等）。`pay` 只改状态，不改金额，不加行。 - `void` …

## 第五批：采购链范围、人工资金复核与脚本数据目录

- [ADR-0017：采购链读接口与待办同一道门、同一份组织范围](docs/implementation/ADR-0017-purchase-chain-scope.md) — `server/routes/purchase-chain.js` 的全部读接口 —— `GET /chain/overview`、`/chain/flow`、`/chain/todos`、`/requisitions`、`/invoices`、`/settlements`、`/payments`、`/payables` —— 共用一个 `readGate = [requireAuth, requireInternal, requirePerm(...PO_READ_PERM…
- [ADR-0018：人工资金模式 —— 收付款确认必须有证据，并由第二人复核](docs/implementation/ADR-0018-funds-maker-checker.md) — 原确认逻辑一行不改，只在它前面加一道门；门的判据只有一处。
- [ADR-0019：脚本数据目录卫生与单实例安装验收](docs/implementation/ADR-0019-script-data-dir-hygiene.md) — 唯一判据加一个出口：`server/db/index.js` 新增 `requireExplicitDataDir(env)`：复用 ADR-0001 的 `requireDataDirectory()`（缺失 / 非绝对 ⇒ `DATA_DIRECTORY_REQUIRED`），再按物理路径（realpath）拒绝等于仓库 `data/` 的目录（`DATA_DIRECTORY_IS_REPOSITORY`）。这与 `scripts/regress-all.mjs` 的闸门…

## 第四批：授信投影、待办范围与恢复演练

- [ADR-0014：sales_orders.credit_hold 是授信台账的投影，只有一个写入者](docs/implementation/ADR-0014-credit-hold-projection.md) — 投影随台账走，写入点只有 `credit.js`。
- [ADR-0015：待办接口按权限与范围收口；Agent Token 列表报告有效状态](docs/implementation/ADR-0015-todo-scope-and-token-status.md) — 为什么这两处选"按范围缩小"而不是 ADR-0008 的 403：采购后段四张单有 `org_id`，采购订单可经仓库取组织，审批实例有"当前级审批人"——都能诚实地算出"我的那一份"。ADR-0008 的通知摘要仍是全库口径（`purchaseTodos(db)` 不传范围、`approvalTodos`），由其 `requireGlobalData` 把守，本 ADR 不改它。
- [ADR-0016：恢复演练与升级失败回退演练](docs/implementation/ADR-0016-restore-and-upgrade-drills.md) — 演练只在一个与线上无关的空目录上进行。`--target-dir` 必须是显式绝对路径，且：要么不存在要么为空目录（`DRILL_TARGET_NOT_EMPTY`）；不等于备份报告记录的来源 `data_dir`（`DRILL_TARGET_IS_LIVE`）；不等于调用方环境里的 `GML_DATA_DIR`（同码）；不与备份目录互相包含（`DRILL_TARGET_OVERLAPS_BACKUP`）。被拒绝时退出码 2，不创建、不改动任何文件。演练脚本本身不读 `GML…

## 第三批：通知、备份、审计、MCP 委托与容器/版本契约

- [ADR-0008：通知子系统加固（摘要数据范围、出站 Webhook 策略、渠道密钥静态保护）](docs/implementation/ADR-0008-notify-hardening.md) — `GET /api/notify/preview`、`POST /api/notify/push`、`GET /api/notify/logs`、`GET /api/notify/overview` 统一挂 `requireAuth → requireInternal → requirePerm(system:notify:view|manage|push) → requireGlobalData`；`push` 另需 `system:notify:push`。判据复用 `s…
- [ADR-0009：备份先校验后轮转，迁移文件校验和](docs/implementation/ADR-0009-backup-verification-and-migration-checksums.md) — 每个库 `VACUUM INTO` 生成快照后总是校验，`--verify` 仅为兼容保留、无额外作用；没有 `--no-verify`，不提供关闭校验的入口。校验项：`PRAGMA integrity_check` 必须为 `ok`；`PRAGMA foreign_key_check` 必须为空；表/视图数与源库一致；`schema_migrations` 行数与源库一致；只读打开快照后对 `users` 表 `COUNT(*)`。最后一项是烟雾恢复——证明快照能独立打开并…
- [ADR-0010：审计与错误卫生（F13）](docs/implementation/ADR-0010-audit-and-error-hygiene.md) — `requireAuth` 与 `server/index.js` 的行业上下文中间件都不再接受 `?token=`：后台 JWT 只能来自 `Authorization: Bearer`。`middleware/auth.js` 新增 `bearerToken(req)` 作为唯一取值点。
- [ADR-0011：MCP Agent Token 是所有者的委托，不是独立服务主体](docs/implementation/ADR-0011-mcp-delegated-token-scope.md) — 有主令牌（`agent_tokens.owner_user_id IS NOT NULL`）是所有者本人的委托。 它在任何时刻能做的事，等于「令牌自己声明的范围（scopes / allow / deny / 绑定组织）」与「所有者此刻在库里还有的权限点与数据范围」的交集；所有者不可用，委托随之不可用。判据与后台 JWT 的 A20 口径完全相同：凭据只是"谁签发过"的声明，可用性与权限每次回库核对（`permContext` / `resolveOrgScope`，不另写一…
- [ADR-0012：最小运行镜像与版本 / 状态契约](docs/implementation/ADR-0012-container-and-version-contract.md) — `Dockerfile` 改为三阶段，规则由 `tests/dockerfile-policy.test.mjs` 静态守卫
- [ADR-0013：收款释放的授信按台账逐笔逆向，不按总额猜](docs/implementation/ADR-0013-credit-release-ledger.md) — 释放时记归属，逆向时只读归属。

## 第二批：后台会话、登录节流与权限迁移

- [ADR-0004：后台账号会话版本与原子安全变更](docs/implementation/ADR-0004-account-sessions.md) — （ADR 未写出“决定”段，仅列标题）
- [ADR-0004：后台会话失效与前端请求边界](docs/implementation/ADR-0004-frontend-session.md) — （ADR 未写出“决定”段，仅列标题）
- [ADR-0005：有界、持久化的后台登录节流](docs/implementation/ADR-0005-login-throttle.md) — 使用 `GML_DATA_DIR/login-throttle.sqlite`，单独持久化节流状态，不占业务迁移编号。所有行业共用此文件，因此来源 IP 限额不会被切换行业绕过。库沿用 production/demo/test 分类保护，拒绝运行模式不符或未分类的旧库，不自动删除或重分类。三个模式都启用相同限制。
- [ADR-0007：正常重启不得恢复已撤销的角色授权](docs/implementation/ADR-0007-permission-migration-checks.md) — `026_mcp_guard.verify` 要求 MCP 确认权限的角色授予数量不少于默认值；`049_scm_role.verify` 要求供应链角色至少 20 项授权且不得有默认排除项。管理员通过角色管理合法削减权限后，下一次 `runMigrations` 会误判损坏、调用已有 `up()` 重新授予。（摘自“问题与决定”节首段）

## 第一批：生产/演示隔离与首个管理员

- [ADR-0001：生产、演示与测试数据隔离](docs/implementation/ADR-0001-runtime-isolation.md) — 上游 F04：普通启动会调用完整演示 boot，商品表为空时会重建业务表，随后补演示单据、配置和 Agent Token。真实企业的空商品库不能作为“允许重建”的依据。（摘自“问题与决定”节首段）
- [ADR-0002：未验收网络能力的生产门禁](docs/implementation/ADR-0002-capabilities.md) — 首版简易 ERP 聚焦人工采购、库存、销售及往来管理。商城身份验证、真实支付、外部连接器以及 Agent 委托权限尚未完成商业验收；不能因为接口能返回成功，就把它作为正式能力开放。
- [ADR-0003：首次生产管理员初始化](docs/implementation/ADR-0003-admin-bootstrap.md) — 由 `scripts/bootstrap-admin.mjs` 接收非秘密参数，通过标准输入读取一行密码，然后初始化所选行业数据库的 schema。必须显式设置 `GML_RUNTIME_MODE=production` 和绝对路径 `GML_DATA_DIR`；缺省运行模式也不构成执行初始化的明确选择。已有数据库必须通过生产分类校验，demo/test 库不能采用。
