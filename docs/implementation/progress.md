# 开发进度

更新：2026-10-22。全新公开仓库：[osborn-studio/OS-ERP](https://github.com/osborn-studio/OS-ERP)，采用 MIT，仅导入清理后的当前文件快照。旧仓库保留为私有归档，其 PR/Actions/历史对象不导入本仓库。未发布正式 Release、未部署。来源及旧 checkout 使用限制见 [PUBLICATION_HISTORY](../PUBLICATION_HISTORY.md)，MIT 决策不替代第三方权属核验。

## 第十五批当前状态（2026-10-24）

按 [roadmap-v11](roadmap-v11.md) 的 AF1–AF12，12 路 Sonnet 5.5 subagent 并行实现并各自经 Codex（gpt-6.1-sol）审计后集成到 `batch-fifteen`（将作为 PR #11）：AF1 `candidate` job 搬进独立的 `release-candidate.yml`（仅 `v*` 标签与手动触发），`ci.yml` 恢复纯门禁语义，`resolveCiRun` 只认 PR 与 main 推送的 run；AF2 销售/OMS/订货中心指标接入范围语义（`scopeAware`），受限账号得到按范围计算的值（ADR-0057 补充）；AF3 OMS 平台维度、热销与受限范围语句改走时间窗口 + 迁移 074 明细索引，explain-audit 去豁免（ADR-0044 补充 5；密集窗口最坏情形有回退，已记录）；AF4 审计检索在 `no such table` 时回退 LIKE 一次并计数，启动自愈与维护脚本 `BEGIN IMMEDIATE` + 有限重试，测试模式暂停钩子做两进程有序重叠测试（ADR-0054 补充 2）；AF5 `--against-backup` 同样做意图对账，去掉不可达的"佐证行已归档"路径，`release-keygen --purpose anchor-intent`（ADR-0055 补充 2；归档后校验需 `--archive-dir` 或新锚点）；AF6 备份：加密路径改名后 fsync 目录、清单 fsync、三库明文先清再写清单、新建目录 fsync 父目录；AF7 `verify-release --sbom-diff`、`sbom-diff.mjs`、候选 job 增 `npm audit signatures` 与 SBOM 对比步骤（已移植到 `release-candidate.yml`）；AF8 复查：main 上仍无可派发的工作流；AF9 测试专用窗口/清理周期旋钮、`os_erp_mcp_rate_store_wait_seconds` 直方图与告警、并发写压测（ADR-0056 补充 2）；AF10 有效权限只合并启用角色，`ROLE_INACTIVE_NOTICE` 通知字段，`requireRole`/`requireWrite` 对停用角色拒绝（ADR-0051 补充 3）；AF11 指标"按范围计算"标记、`/api/mcp/limits/tokens` 与每令牌触顶窗口数、审计 FTS 回退槽位、两个浏览器场景；AF12 操作/安装手册补第十四批功能。集成修复：AF7 步骤按 AF1 的新工作流位置移植；`offbox-anchor` 夹具补 `sbom-diff.mjs`；手册锚点措辞取 AF5。验证以托管 CI 为准。

## 第十四批当前状态（2026-10-24）

按 [roadmap-v10](roadmap-v10.md) 的 AE1–AE12，12 路 Sonnet 5.5 subagent 并行实现并各自经 Codex（gpt-6.1-sol）审计后集成到 `batch-fourteen`（将作为 PR #10）：AE1 指标按业务权限过滤、危险键 `metrics_global_for_restricted`（默认 `hide`）、响应带 `hidden_count`（ADR-0057；门店/经销商绑定账号也算受限）；AE2 角色矩阵覆盖自定义角色、`data_scope` 覆盖计数与多角色并集，生成器与接口共用一份计算（ADR-0051 补充 2）；AE3 `oms-sql.js`：OMS `/stats` 与 AI 平台分析改区间谓词走迁移 070 索引并同源登记 explain-audit，新增 `docs/operations/query-planner.md`（ADR-0044 补充 4）；AE4 审计 FTS 开关端到端回路测试与 100 万行启用回填基准（ADR-0054 补充；`audit-no-fts5` job 已由 AD4 提供）；AE5 迁移 072 `audit_anchor_intents`：保留清理/归档/擦除在同一事务写意图并由审计行佐证，`audit-verify-chain` 对锚定区间内新锚点要求意图对账（ADR-0055 补充；`--accept-new-anchors` 语义收窄）；AE6 加密备份全注入点与 macOS/Linux 原语差异断言；AE7 `check-audit-allowlist --include-dev` 与手动 `dependency-review` job（当前 0 发现）；AE8 复查：工作流仍不在 main，未派发；AE9 `GML_MCP_RATE_STORE=db`（迁移 073 `mcp_rate_buckets`，跨进程共享、重启保留、失败即拒、后台清理）（ADR-0056 补充）；AE10 标签推送只跑 `candidate` job、`--ci-run=auto` 的 `hosted-ci-self` 回退、`evidence-log-ingest.mjs`；AE11 审计页 FTS 状态卡、`/api/mcp/limits` 只读接口与限速卡、三个浏览器场景；AE12 操作/安装手册补第十三批功能（修正 `boss` 口径）。集成修复：限流器合并保留 AE9 存储模式与 AE11 `mcpRatePolicy`；指标页用 AE11 槽位承接 AE1 的 `hidden_count`；角色矩阵页以 AE2 真实分组替代 AE11 占位。验证以托管 CI 为准。

## 第十三批当前状态（2026-10-24）

按 [roadmap-v9](roadmap-v9.md) 的 AD1–AD12，12 路 Sonnet 5.5 subagent 并行实现并各自经 Codex（gpt-6.1-sol）审计后集成到 `batch-thirteen`（将作为 PR #9）：AD1 指标函数带 `orgScope`，无范围语义的指标对受限调用者标 `scoped:false`（前端"全局口径"），`report.dashboard_kpi` 按子项权限省略，`/dealer/summary` 要求采购查看权限（ADR-0053）；AD2 `boss` 纳入总部名单，`gen-role-matrix.mjs` 从真实门禁生成 `docs/operations/role-matrix.md` 并入 CI 漂移检查（ADR-0051 补充）；AD3 迁移 070 `oms_orders(order_time,…)` 覆盖索引，`/trend`、`/channel` 线上分支改区间谓词并同源登记 explain-audit（ADR-0044 补充 3）；AD4 审计 FTS 可选化（迁移 071，ADR-0054）；AD5 `offbox-anchor.mjs` 签名离机锚点与 `--offbox` 校验（ADR-0055；锚定区间内新增锚点视为重写）；AD6 `fs-fault.mjs` 文件系统故障注入覆盖归档/备份/透明日志写入序列，备份改为先写 `.partial` 再改名；AD7 移除未使用的 `zod`，审计白名单清空；AD8 夜间工作流仍不在 main，加 `capacity-smoke` 手动 job 作过渡；AD9 MCP 令牌级滑动窗口限速与可选日配额（ADR-0056，429 `MCP_RATE_LIMITED`）；AD10 `candidate` job（仅手动触发或 `v*` 标签，产出未签名候选为 artifact，不发布 Release）；AD11 `/api/meta/role-matrix` 与"角色与数据范围"页；AD12 操作/安装手册补第十二批功能。集成修复：`ci.yml` 两个新 job 按整块追加避免交错；`test-inv-type-gate` 接受 AC9 的受控 SIGTERM 退出。OpenAPI 版本 1.41.0。验证以托管 CI 为准。

## 第十二批当前状态（2026-10-24）

按 [roadmap-v8](roadmap-v8.md) 的 AC1–AC12，12 路 Sonnet 5.5 subagent 并行实现并各自经 Codex（gpt-6.1-sol）审计后集成到 `batch-twelve`（将作为 PR #8）：AC1 采购单范围谓词唯一化（`purchaseOrderScopeSql`），MCP 采购工具、经销商需求汇总、主数据库存量与仓库计数全部按仓库组织（ADR-0050）；AC2 总部角色单一名单 `hq-roles.js`、docflow 严格门店绑定与危险键 `docflow_strict_store_binding`（ADR-0051；`boss` 角色不在旧名单，需产品决定）；AC3 解析表剩余类型绑定规则（ADR-0011 补充 2）；AC4 看板 `/channel` 缓存、`/recent` 剖析、看板 SQL 抽到 `dashboard-sql.js` 供 explain-audit 同源登记（ADR-0044 补充 2）；AC5 `audit-fts-maintain.mjs`、`GML_AUDIT_FTS=0` 真实回退路径与 CI 步骤；AC6 发行证据透明日志 `EVIDENCE-LOG.jsonl` 与未签名候选醒目警告（ADR-0052）；AC7 备份清单记录审计链尾与锚点、`--against-backup`、归档 `--resume` 与 SIGKILL 崩溃测试（ADR-0049 补充）；AC8 `capacity-summary` 显示 large-ci 的 partial/reached（夜间工作流在 PR #7 合入 main 前无法手动触发，已记录）；AC9 告警规则落为 YAML 文件、CI `promtool check rules`、MCP 调用计数端到端、SIGTERM 指标快照（ADR-0045 补充 2）；AC10 `npm audit` 门禁与到期白名单（GHSA-vfj7-8cjw-p6xm 已撤回；`zod` 未使用依赖的高危告警白名单至 2026-12-15）；AC11 前端：看板"数据截至"与刷新、审计 FTS 提示、仓库空范围提示、指标 429 提示、两个浏览器场景；AC12 操作/安装手册补第十一批功能。集成修复：`/channel` 接入 AC11 的带戳响应器。OpenAPI 版本 1.40.0。验证以托管 CI 为准。

## 第十一批当前状态（2026-10-23）

按 [roadmap-v7](roadmap-v7.md) 的 AB1–AB12，12 路 Sonnet 5.5 subagent 并行实现并各自经 Codex（gpt-6.1-sol）审计后集成到 `batch-eleven`（将作为 PR #7）：AB1 主数据仓库下拉、采购订单列表/详情/统计、QC 概览与审计聚合按仓库组织范围（ADR-0046）；AB2 看板 trend/top/todos/inventory-dist 剖析、CROSS JOIN 与单遍扫描改写、按键 LRU 缓存与两进程 `data_version` 失效测试（ADR-0044 补充）；AB3 审计日志 FTS5 trigram 关键词检索（迁移 067，候选再经 LIKE 复核，无 FTS5 时退化）与"仅 action 必须带 module"；AB4 发行候选证据 Ed25519 签名、`release-keygen`、`verify-release --pubkey`（ADR-0047）；AB5 `schema-snapshot.mjs` 产出旧结构备份集供升级演练不截断重放（ADR-0048）；AB6 审计日志哈希链、锚点表、`audit-verify-chain`/`audit-archive`（ADR-0049，迁移 068；保留清理与擦除遇断链即拒绝）；AB7 RC/YQ/SH 门店绑定进入 `DOC_SCOPE_RESOLVERS`，MCP 严格绑定（ADR-0011 补充）；AB8 奇门演示常量清除（迁移 069）、演示模式按安装生成密钥、`qimen-issue-key.mjs`、能力清单只回 app_key 前 4 位（ADR-0033 补充）；AB9 托管 runner 浏览器场景登记与审批模板/POS 结算权限场景；AB10 指标端点按 IP 节流、令牌轮换、缓存/审计写入/MCP 调用指标（ADR-0045 补充）；AB11 `synth-pipeline --profile large-ci` 分批 VACUUM、磁盘与时间预算、`partial` 诚实报告（夜间 `scale=large-ci`）；AB12 操作/安装手册补第十批功能与 `docs/security/dependency-notes.md`。集成修复：`check-route-authz` 用 `process.exitCode` 代替 `process.exit()`（管道截断导致 codemap 测试随机红），`gen-codemap` 校验清单条数；`meta.js` 导入冲突曾整文件取本侧而丢掉 AB3 路由改动，已恢复并补测。OpenAPI 版本 1.39.0。验证以托管 CI 为准。

## 第十批当前状态（2026-10-23）

按 [roadmap-v6](roadmap-v6.md) 的 AA1–AA12，12 路 Sonnet 5.5 subagent 并行实现并各自经 Codex（gpt-6.1-sol）审计后集成到 `batch-ten`（将作为 PR #6）：AA1 MCP `order.trace_document`/`doc.query` 改走 `DOC_SCOPE_RESOLVERS`（ADR-0041）；AA2 OMS 写路由与 MCP 库存工具按仓库组织范围（ADR-0042）；AA3 审批模板维护权限 `system:approval:template`（ADR-0037 补充，迁移 063；0043 编号未使用）；AA4 质检处置/仓库主数据/采购收货退货/POS 门店库存接入仓库范围（ADR-0038 补充）；AA5 低库存口径统一为 `listBelowSafe`、看板剖析与 30 s 缓存（ADR-0044；缓存命中 p95 约 42 ms，未命中约 400 ms）；AA6 审计日志索引与封顶计数（迁移 065）；AA7 发行候选 `--run-tests`/`--ci-run auto` 与证据校验；AA8 浏览器场景 my-scope/audit-logs/inventory-paging；AA9 POS 作废与差异结算权限码（迁移 066）；AA10 Prometheus 指标导出（ADR-0045）；AA11 迁移升级演练脚本与夜间可选步骤；AA12 安装/操作手册补第七至九批功能。集成时合并 AA1/AA2/AA5 在 `mcp/tools.js` 的改动（`stock_alert` 低库存走 `listBelowSafe`，临期行保留 AA2 仓库过滤）。OpenAPI 版本 1.38.0。验证以托管 CI 为准。

## 第九批当前状态（2026-10-23）

按 [roadmap-v5](roadmap-v5.md) 的 Z1–Z12，12 路 Sonnet 5.5 subagent 并行实现并各自经 Codex（gpt-6.1-sol）审计后集成到 `batch-nine`（将作为 PR #5）：Z1 库存域与采购订单状态/收货按仓库组织范围（ADR-0038）；Z2 OMS 读接口与 MCP `doc.get` 走解析表（ADR-0039）；Z3 热点查询改造与库存列表键集分页（迁移 061，`/inventory/stocks` p95 2078→151 ms）；Z4 `GML_TRUST_PROXY` 统一受信代理（ADR-0040）；Z5 发行候选打包与证据包；Z6 `/api/auth/my-scope` 与"我的数据范围"页；Z7 审计日志查看器与 CSV 导出（迁移 062）；Z8 MCP 幂等/确认缓存命中前重验；Z9 `approval_manager_global` 开关（危险键 17→18）；Z10 夜间容量基线工作流；Z11 依赖补丁刷新（braces 链仍无修复）；Z12 代码地图与 ADR 索引生成并入 CI。集成时合并 Z1 与 Z3 在库存域的改动：`listBelowSafe`/`countBelowSafe` 叠加调用者组织范围。验证以托管 CI 为准。

## 第八批当前状态（2026-10-23）

按 [roadmap-v4](roadmap-v4.md) 的 Y1–Y12，12 路 Sonnet 5.5 subagent 并行实现并各自经 Codex（gpt-6.1-sol）审计后集成到 `integration`（将作为 PR #4）：Y1 采购链动作路由/复核/MCP 结算付款单据范围（ADR-0031）；Y2 单据流读接口按 40 类单据类型解析范围（ADR-0032，`doc-scope-registry`）；Y3 奇门按平台密钥、HMAC-SHA256 签名、时间戳与 nonce 防重放、能力清单需管理权限（ADR-0033，迁移 060）；Y4 报价、MCP 销售工具、OMS 下单按组织（ADR-0034）；Y5 POS 前端按权限显示与自审禁用；Y6 MCP 文档读按门店/经销商绑定；Y7 写路径 SQLITE_BUSY 重试包装与写基线（ADR-0035）；Y8 个人信息擦除覆盖退款/订货快照/日志片段并出报告；Y9 版本 0.2.0-alpha.1、ADR 生成 CHANGELOG、发行包带 SBOM；Y10 合成大库演练（large：2 万 SKU/5 万单据/25 万流水，备份 3.8 s、加密 4.2 s、恢复 2.0 s）；Y11 安全响应头/CSP/可选 HttpOnly Cookie 会话（ADR-0036）；Y12 审批域组织范围（ADR-0037），并补 MCP 审批签字人范围。验证以托管 CI 为准。

## 第七批当前状态（2026-10-23）

按 [roadmap-v3](roadmap-v3.md) 的 X1–X12，12 路 Sonnet 5.5 subagent 并行实现并各自经 Codex（gpt-6.1-sol）审计后集成：X1 POS 按动作权限 + 跨店 404 + 交班二人分离（ADR-0025，迁移 058）；X2 销售域组织范围（ADR-0026）；X3 订货中心按客户归属组织范围（ADR-0027）；X4 `no-issue`/`orgs`/奇门认证/采购自动分配范围（ADR-0028）；X5 MCP 文档读工具按单据类型权限（40 类型全映射）；X6 托管 CI 浏览器 job 与两个新场景（首次 CI 运行待验证）；X7 登录节流只计失败、成功清零（ADR-0005 修订）；X8 健康/指标 ops 块与备份失败告警（ADR-0029）；X9 日志保留与个人信息导出/擦除工具（ADR-0030，危险键 14→17）；X10 EXPLAIN 守卫与 21 个索引（迁移 059）；X11 用户页组织/数据范围编辑；X12 上游复用来源锁定与相似度核对（Medusa/Medici/casbin 代码重合率 ≤0.41%）。`check-route-authz` 待处理项从 49 降到约 30。验证以托管 CI 为准。

## 第六批当前状态（2026-10-23）

按 [roadmap-v2](roadmap-v2.md) 的 W1–W12，12 路 Sonnet 5.5 subagent 并行实现，每路完成后用 Codex CLI（gpt-6.1-sol，只读沙箱）独立审计并修复其高危发现，再由主执行器集成：W1 采购链详情/预览读接口范围（ADR-0020）；W2 路由授权清单守卫 `check-route-authz`（ADR-0021，638 条路由分类，暴露 POS/销售/订货中心组织范围、`docflow/no-issue`、`auth/orgs`、奇门缺 app_key 放行等真实缺口）；W3 前端 403/空范围/能力关闭统一提示；W4 出站 TLS/SNI 固定地址联调测试；W5 MCP 40 工具 × 3 所有者状态矩阵（修复 4 个工具级越权，含确认人绕过）；W6 备份 AES-256-GCM 加密与三库一致性点（ADR-0022）；W7 结构化 JSON 日志与 request-id（ADR-0023）；W8 发行包验收改为生产初始化流程；W9 运行时 SBOM 与生成式第三方声明 + CI 漂移校验；W10 安装/操作手册生产口径重写；W11 容量基线脚本；W12 付款释放台账与原子作废（ADR-0024，迁移 057）。验证以托管 CI 为准。

## 第五批当前状态（2026-10-23）

第五批 4 路 subagent 并行，已合入 `integration`：采购链全部读接口统一门禁与组织范围（ADR-0017）；收付款证据与二人复核（ADR-0018，迁移 056，新增设置 `funds_*` 与权限 `finance.funds.review`，默认开启，F10 人工资金模式落地）；脚本数据目录卫生守卫 `check-data-paths` 与单实例安装验收 `tests/local-instance.test.mjs`（ADR-0019，F11）；应收界面展示授信释放/恢复效果与投影校验。PR #2 已合并到 main；第五批将作为新 PR 提交，验证以托管 CI 为准。

## 第四批当前状态（2026-10-22）

第四批 4 路 subagent 并行，已合入 `integration`（PR #2）：授信占用投影单一写入者与对账守卫（ADR-0014，修复 `test-quote-credit` 原有两项失败）；待办接口权限/范围与 Agent Token 有效状态（ADR-0015，迁移 055，新增 `/api/mcp/tokens/:id` 与 `sweep`）；恢复演练与升级失败回退演练脚本及恢复手册（ADR-0016，`docs/operations/restore-runbook.md`）；托管 CI 新增 `docker` job（linux/amd64 构建 + `scripts/docker-smoke.mjs` 冒烟）。验证结果以 PR #2 的托管 CI 为准。

## 第三批当前状态（2026-10-22）

第三批由 6 路 Claude Code subagent 在独立工作树并行实现，主执行器集成到 `integration` 分支：F05/F08/F09 通知加固（ADR-0008）、F12 备份校验与迁移校验和（ADR-0009）、F13 审计与错误脱敏（ADR-0010）、F07 MCP 委托授权（ADR-0011）、F14/F16 容器最小化与版本契约（ADR-0012）、授信逆向台账（ADR-0013）。新增迁移 052、053；新增 9 个 `tests/*.test.mjs` 专项。集成后 Mac mini 开发检查：`npm run test:focused` 全绿、`tsc`、Vite 构建、bizcode/file-header/api-contract 守卫全绿；两处原有守卫失败（SESSION_REVOKED/AUTH_INVALID_CREDENTIALS 未经 `bizFail`、SessionBoundary 头缺分隔线）已修。

验证主机决定：仓库公开且未收费期间，用 GitHub 托管 runner 的 `.github/workflows/ci.yml` 作为开发合并闸门（PR/push 1 轮隔离回归，手动 3 轮）；开始收费后切回 dmserver。托管 CI 首轮对 CI 基线提交的回归为 109/113（4 项失败：bizcode、file-header 已修；`test-mcp-purchase.mjs` 在 ubuntu 上失败待定位）。各状态与剩余验收见 [整改跟踪](backlog.md)。

## 第二批当前状态

第二批已集成到本地 `codex/session-capabilities`：`auth_version` 撤销、统一安全变更事务和密码策略、持久登录节流、前端失效/跨标签页同步、改密和退出全部会话、运行能力展示及生产隐藏演示入口。迁移 026/049 已补避免每次启动重新授予权限的回归。实现和开发专项结果不等于 Linux 集成验收。

私有前身候选 `0867d6c540d49156b140acc08e4edf7c4cf78cd3` 已补齐 `/api/promo/shop` 生产门禁、POS 演示提示、用户表单契约及会话切换页面隔离。Linux 前置证据：应用源码一致的 `f6f7a16` 通过104项专项、TypeScript、Vite及20项会话/9项能力浏览器场景；`0867d6c` 只修测试定位器，Users浏览器9项通过。独立移除会话隔离key的变体按预期失败。三轮完整回归仍在执行，不能声称已经通过或生产就绪。浏览器HTTP使用拦截夹具，后端真实HTTP/SQLite专项另行记录。

改名后的 CI 配置已修正仓库 guard 和证据归属字段；Python 变量以 `OS_ERP_LINUX_PYTHON` 为先、兼容原 `OS_EGP_LINUX_PYTHON`。未注册自托管 runner，也没有把直接 SSH 验证称为 Actions 通过。

## 第一批历史结果

已从 GML `a80b007494b20e8dc801d063f285e87145cbe15e` 创建独立当前树快照，保留来源、审计与 handoff。原 `gml-filtered` 审阅 checkout 保持不变。

第一批运行代码与测试已集成，下列功能已完成下述固定候选 Linux 源码验证：

- 独立生产启动、数据库持久模式、直接/卫星演示 seed 底层保护，生产模式拒绝缺失或已知公开 JWT 密钥。
- 生产关闭商城、奇门、未验收同步及模拟成功入口、MCP；能力状态可由 API 查询。
- 一次性生产管理员 CLI，密码经 stdin 输入，事务/并发/永久标记保护。
- 修复发票应收回款未释放原销售订单授信的缺陷，补部分、多票、多客户、ID 碰撞及故障回滚测试。
- Linux Python/openpyxl 前置检查、所有新增测试自动接入、手动自托管 CI 配置。

六路 subagent 分工实现和复审；管理员/能力门禁、授信修复分别经过非实现者静态复审。Claude Code 尚未实际参与。

验证：Linux dmserver 对冻结候选 `9c532f39183eede6a0c45ac4990d1742c57b65aa` 完成三轮源码回归，每轮 113/113、合计 339 个跑批项通过、0 失败。XLSX 专项 51/51；额外专项 TAP 44/44、0 失败、0 跳过。前两次失败尝试、修复原因与证据边界完整保留于 [验证记录](validation.md)，不把原基线或中止尝试记为通过。

后续接手：根 [handoff.md](../../handoff.md) 保留完整产品规格；[第二批原始规格](next-batch.md) 保留会话撤销、登录节流与前端能力展示的设计和负向验收要求，当前实现/验证状态以上方和最新验证记录为准，不再把已集成功能当成未开始任务。

**仍不可作为商用生产版本交付。** MIT 已由用户授权采用，但第三方权属链、原审计多项 P1、授信逆向/预收路径及依赖公告未关闭。详见 [整改跟踪](backlog.md)。Linux SSH 验证不等于 Actions 执行，Mac Studio eva 尚未连接验证；本批没有 Swift 工作。
