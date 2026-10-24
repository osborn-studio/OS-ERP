# 开发进度

更新：2026-10-22。全新公开仓库：[osborn-studio/OS-ERP](https://github.com/osborn-studio/OS-ERP)，采用 MIT，仅导入清理后的当前文件快照。旧仓库保留为私有归档，其 PR/Actions/历史对象不导入本仓库。未发布正式 Release、未部署。来源及旧 checkout 使用限制见 [PUBLICATION_HISTORY](../PUBLICATION_HISTORY.md)，MIT 决策不替代第三方权属核验。

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
