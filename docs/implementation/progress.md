# 开发进度

更新：2026-10-22。全新公开仓库：[osborn-studio/OS-ERP](https://github.com/osborn-studio/OS-ERP)，采用 MIT，仅导入清理后的当前文件快照。旧仓库保留为私有归档，其 PR/Actions/历史对象不导入本仓库。未发布正式 Release、未部署。来源及旧 checkout 使用限制见 [PUBLICATION_HISTORY](../PUBLICATION_HISTORY.md)，MIT 决策不替代第三方权属核验。

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
