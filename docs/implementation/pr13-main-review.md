# PR #13 — main 同步与合并审查（2026-10-27）

本次仅处理 `feat/batch-seventeen`。用户要求同步 main、修复冲突与 CI 问题、使用 Claude CLI Haiku 5.5 复审，待当前 HEAD 的托管 CI 全绿后通知；**不合并 PR、不启用 auto-merge**。

## 基线与冲突处理

- PR 原 HEAD：`0561b60947267e2bc9fb6bfb37eb4c34a1a74ec2`。
- 同步 main：`38bebfbbbd741c67f9292b3147aa6c5319f9d24d`（包含 PR #12）。普通 merge，保留双方历史。
- 原 HEAD 的 [CI 40195157372](https://github.com/osborn-studio/OS-ERP/actions/runs/40195157372) 已通过适用检查；该结果不验证本次合并提交。
- `src/types/api-routes.ts` 由 `node scripts/gen-api-types.mjs` 重生成，OpenAPI 1.45.0、530 条路径；main 的 527 条与原 PR 的 529 条均保留。
- `tests/slow/audit-chain.test.mjs` 合并双方 import，统一搬迁后的 `../../` 深度。保留 main 的清单真实性校验/SSH 独占发布/本地失败清理与 PR17 的慢套件及负载容忍调整。
- 静态核对双方字面 test 声明无遗漏：audit-chain 为 main69/原PR73/合并75；dashboard34/34/34；offbox19/17/19；write-contention13/13/13。这里是声明数，不是含子用例的测试结果数。

## 本次确认并修复的问题

1. **自动合并遗漏搬迁后的动态 import。** PR12 跨午夜测试的 `../scripts/explain-audit.mjs?dashboard-perf-midnight` 在 `tests/slow/` 下指向不存在的路径。定向红测复现 `ERR_MODULE_NOT_FOUND`，改为 `../../scripts/...` 后 1/1 通过；保留固定时钟、午夜边界和负向断言。
2. **测试树守卫误判 ESM 查询串。** Haiku 指出守卫直接把 `?dashboard-perf-midnight` 当文件名，红测确认。ESM 用 `new URL(specifier, pathToFileURL(file))` / `fileURLToPath` 解析，CommonJS `require` 保留字面路径规则。既验证真实文件存在，又允许 ESM 缓存隔离参数。修后守卫 10/10；用例名收窄为实际扫描的 `../` 范围。
3. **Node 兼容性声明过宽。** ZIP 安全校验使用 `zlib.crc32`，[Node 官方文档](https://nodejs.org/api/zlib.html#zlibcrc32data-value)明确其在 Node22.2 引入。将 engines 从 `>=22 <23` 收窄为 `>=22.2 <23`，用 npm 重生成锁文件，仅根 engines 改变；README 同步。没有降低 CRC、解压大小、路径或权限校验。
4. 去掉 main 合并带入的重复 AG5 头注释，无行为变化。

## 指定模型复审与取舍

共三块初审（合并集成、权限/范围、审计/备份/ZIP），一轮提供实际依赖实现的复审，以及一轮最后小差异复核。全部使用 `claude -p --model claude-haiku-5-5 --tools '' --strict-mcp-config --safe-mode`，明确仅审提供文本、不得调用工具。五次均 `is_error=false`，`modelUsage['claude-haiku-5-5'].canonicalModel=claude-haiku-5-5`。最终两轮无确认阻断。模型没有执行测试，其判断不替代实际验证或独立 Approve。

- 守卫查询串问题：采纳并以红/绿测试确认。
- `Roles.tsx` 读取 `e.detail.code` 疑点：不成立。`src/api/client.ts` 将顶层业务码归一化到 `ApiError.detail.code`；服务端 409 的人数确在 `detail`，角色停用测试验证 3 人/人数变化与 primary 变化；客户端现有契约测试 22/22。
- 节选里缺少 metrics 守卫、MCP 测试旋钮/计数器、ADR0056补充4 等：实际合并树均存在，相关完整测试通过，不能把节选缺失当代码缺失。
- 命名角色停用：`requireRole` 实际先用 `isRoleActive` 检查角色状态；停用事务使用 `.immediate()`，保留事务内操作者校验、人数确认、严格审计回滚。
- FTS/锚点条件项：生产 CLI 确实调用 `resolveKeyIdRequirement`；runtime 接受 env；verify-release 的 `listed` 已声明；audit_logs 使用 AUTOINCREMENT；迁移067 up 不另开事务；生产调用不在 `plan.run` 外拼接 plan.where/args；隔离回归脚本实际调用 regress-all。
- 备份报告包含本轮所有 results，orphan_causes 也是本轮聚合，不是单目录计数；不按单目录假设修改它。SSH 成功发布后的临时文件清理失败仍可能留下残留，这是已有运维限制，不宣称本轮已消除。
- 本轮不是全仓库安全证明。单 SQLite 文件不能实现表属主隔离、部分聚合查询在大数据量下的性能、生产容量与发布验收均不由本轮本机检查证明。

## Node 开发检查证据

使用 Node22.22.1、任务隔离数据目录及回环端口；没有运行本机 Python或操作客户数据。osstack0.22.1 有限任务 `task_07704f03`、run `run_62963bd5-e7ab-4ee2-bf58-5de502781c3c` 的 17 条执行命令及验证命令全部成功。

| 范围 | 结果 |
| --- | --- |
| midnight 定向复现修复 | 1/1 pass（修前 ERR_MODULE_NOT_FOUND） |
| offbox、slow audit-chain/dashboard、write-contention、hq-roles、role-matrix 六完整文件 | 201/201 pass |
| tree/timings/FS fault CI/browser CI/ZIP 五完整文件 | 60/60 pass |
| role-deactivate、MCP quota paging、metrics scopeless、FTS maintain 四完整文件 | 70 项：69 pass、0 fail、1 skip |
| frontend-session 现有客户端契约 | 22/22 pass |
| test-tree 最终补验 | 10/10 pass（此前查询串红测已记录） |
| helper-shape | 78 通过、0 失败 |
| 类型检查、Vite build、API契约、metrics scope、锁注册源、文件头、数据路径、路由权限、业务码、changelog/codemap/role-matrix生成物 | 全部通过 |

FTS 跳过项明确需要真正不带 FTS5 的 SQLite 构建，由托管 `audit-no-fts5` 作业验收。ZIP 严格权限、浏览器、Docker、完整慢套件/无FTS5、备份故障注入和隔离全回归仍须看新 HEAD 的 GitHub Linux CI。上述计数存在单项复验重叠，不相加宣称独立测试总量。

## 托管验收待办

推送后记录新 HEAD 与 CI 运行。七个必执行 CI 作业必须 success：focused、audit-no-fts5、Docker、browser、isolated regression、backup fault injection、slow-tests；capacity/candidate/dependency-review 仅在条件不适用时接受 skip。其他未知失败/取消/缺失均不能当通过。全绿后再次读取 PR HEAD 和 review threads，评论精确结果并通知用户是否仍需独立 Approve。未授权合并。
