# 开发进度

更新：2026-10-22。全新公开仓库：[osborn-studio/OS-ERP](https://github.com/osborn-studio/OS-ERP)，采用 MIT，仅导入清理后的当前文件快照。旧仓库保留为私有归档，其 PR/Actions/历史对象不导入本仓库。未发布正式 Release、未部署。来源及旧 checkout 使用限制见 [PUBLICATION_HISTORY](../PUBLICATION_HISTORY.md)，MIT 决策不替代第三方权属核验。

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
