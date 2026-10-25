# OS ERP 商用整改详细方案 v13（第十七批）

日期：2026-10-24。基线：`batch-sixteen`（PR #12 候选，含 v2–v12 全部工作流）。承接 backlog "第十六批后仍 open" 节、[status-report-2026-10-24](status-report-2026-10-24.md) 第 3 节与各 AG 报告的"未验证"项。通用约束、TDD、守卫清单（`check-route-authz`、`check-data-paths`、`check-file-header`、`check-bizcode-shape`、`check-api-contract`、`check-mcp-coverage`、`check-audit-allowlist`（含 `--include-dev`）、`check-metrics-scope`、`check-lock-registry`、`gen-role-matrix --check`、`explain-audit --compare docs/implementation/explain-plans.json`、`gen-codemap --check`、`gen-changelog --check`、`gen-third-party-notices --check`）、Codex 审计方式（`codex exec -m gpt-6.1-sol --sandbox read-only … </dev/null`，防御性措辞）与 [roadmap-v2](roadmap-v2.md) 相同。**硬约束**：不得对自己未启动的进程执行 `pkill`/`kill`；不得从单个 Bash 调用里启动无硬超时的常驻服务；改动路由/模块/迁移/ADR 后运行 `node scripts/gen-codemap.mjs && node scripts/gen-changelog.mjs && npm run gen:api` 并提交生成物；改动注册语句的 SQL 后运行 `explain-audit --snapshot` 更新 `explain-plans.json` 并在提交说明里给出理由；解决合并冲突时**不要**对非生成文件整文件 `checkout --ours/--theirs`；工作流文件：`ci.yml` 只放 PR/main 门禁 job，发行相关步骤放 `release-candidate.yml`，新 job 整块追加文件末尾；前端"槽位"约定不变；`tests/offbox-anchor.test.mjs` 的最小发行包夹具列出了 `scripts/lib` 的文件白名单——给 `verify-release` 新增 lib 依赖时同步补该正则；登录节流环境变量上限 10000（浏览器场景驱动已把共用服务的 `GML_LOGIN_IP_LIMIT` 设为 10000，新场景不要再各自起服务）；只在隔离临时目录与随机 loopback 端口上测试；不触发 GitHub 工作流、不改仓库设置（AH8 例外）。ADR 从 0058 起，迁移从 076 起。`gen-changelog.mjs` 的 BATCHES 目前止于第十四批（57–68）；第一个用到 0058 的工作流把它改为 `{ id: 14, …, from: 57, to: 57 }` 并新增 `{ id: 17, title: '第十七批（进行中）：见 roadmap-v13', from: 58, to: 70 }`（以 `gen-changelog --check` 与 `release-candidate` 测试通过为准）。

---

## AH1 门禁 job 的"负载抖动"分类与慢用例隔离
- 现状：托管 `checks` job 跑满 36–40 分钟；`write-contention` 的基准用例、`release-signing`、AD4 over-HTTP 等在负载下偶发失败，重跑即过；每次都靠人判断"是抖动"。
- 改动：`scripts/test-timings.mjs` 从 TAP 输出统计每个文件/用例耗时并写 `docs/implementation/test-timings.json`（CI 上传为 artifact）；把 > 60 s 的用例文件归入 `tests/slow/`（`node --test tests/*.test.mjs` 不再包含，`ci.yml` 新增一个 `slow-tests` job 并行跑它们，整块追加文件末尾）；对已知受负载影响的断言（定时、p95、重试次数）统一用 `tests/lib/load-tolerance.mjs` 的常量而不是散落的魔法数；`tests/test-tree-policy.test.mjs` 断言 slow 目录只含带 `// slow:` 理由头的文件。
- 文件：新脚本、`tests/slow/*`（git mv）、`.github/workflows/ci.yml`（`checks` job 的 node --test 行 + 新 job）、`tests/lib/load-tolerance.mjs`、策略测试、`docs/implementation/testing.md`。

## AH2 指标 scopeless 清单逐条评估与 `hide` 模式部分展示（ADR-0057 补充 3）
- 改动：为 `check-metrics-scope` 加 `--report`，输出每个 `scopeless` 指标及理由；逐个评估，能接入范围的接入（预期至少再接入 5 个），剩余的理由改为可机读分类（`global_by_nature` / `no_org_column` / `pending`），`pending` 必须带 backlog 链接且守卫在 CI 上对 `pending` 超过 N 个报警（不红）；`hide` 模式下受限账号的指标页：有范围语义的照常显示，无范围语义的只显示"已隐藏 N 项"而不是整页隐藏。
- 文件：`scripts/check-metrics-scope.mjs`、`server/lib/metrics.js`、`server/routes/dashboard.js`、`src/pages/system/Metrics.tsx`、测试、ADR。

## AH3 大数据量下的查询计划快照（ADR-0044 补充 7）
- 现状：`explain-plans.json` 取自默认小合成库；OMS 密集窗口最坏情形（AF3）在小库上看不出来；`ANALYZE` 政策只在文档。
- 改动：`explain-audit --snapshot --scale large` 在 Y10 的 `synth-scale` 大库（CI 已有 `synth large-ci` 产物）上取第二份指纹 `explain-plans.large.json`，`--compare` 两份都比；记录两份之间不同的语句并逐条说明；给 `db/index.js` 加启动时一次 `PRAGMA optimize` 的可选项（`GML_SQLITE_OPTIMIZE_ON_BOOT`，默认关），AG3 的源码扫描对这一处白名单；capacity-baseline 记录大库下 OMS 密集窗口的实际 p95。
- 文件：`scripts/explain-audit.mjs`、`docs/implementation/explain-plans.large.json`、`server/db/index.js`、`.github/workflows/ci.yml`（只改 AG3 那一步）、测试、`docs/operations/query-planner.md`、ADR。

## AH4 审计 FTS：AG4 基准重跑与大表重建进度
- 现状：AG4 基准表取自节奏修复前；`audit-fts-maintain --rebuild` 在大表上无进度、无可中断点。
- 改动：用修复后的脚本重跑 AG4 基准并替换 capacity-baseline 表；`--rebuild` 分批（每批 N 行，`BEGIN IMMEDIATE` 内只做一批）、打印进度、SIGTERM 后在批边界停止并可 `--resume`；测试用 5 万行审计表验证中断/续跑后索引完整性（`--integrity-check` 通过）。
- 文件：`scripts/bench-audit-toggle-under-write.mjs`（只重跑）、`scripts/audit-fts-maintain.mjs`、`tests/audit-fts-maintain.test.mjs`、`docs/implementation/capacity-baseline.md`、`docs/operations/audit-search.md`。

## AH5 锚点意图：过渡期结束与"能写库者"威胁模型（ADR-0055 补充 4）
- 改动：`--require-intent-key-id` 的默认值随运行模式：production 下从 `GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER=<ISO 日期>` 起强制（缺省为仓库里写死的日期 2026-12-01），demo/test 不强制；`baseline-anchor-list-missing` 分支补测试；在 ADR 里写清"能直接写数据库的人可以伪造未签名意图"的边界，给出唯一可行的缓解（意图表只允许 CLI 用户写、应用账号只读，`local-manage` 安装时落实文件/角色权限）并落地到 `local-manage.mjs` 的安装检查。
- 文件：`server/lib/audit-anchor-intent.js`、`scripts/audit-verify-chain.mjs`、`scripts/local-manage.mjs`、测试、`docs/operations/*`、ADR。

## AH6 备份：Linux 上的故障注入结果登记与孤儿清单成因扩展
- 现状：fs-fault 矩阵只在 macOS 本机跑过；孤儿清单清扫只覆盖 prune 中断一种成因。
- 改动：`ci.yml` 新增 `fs-fault` job（ubuntu，整块追加文件末尾）跑 `tests/fs-fault.test.mjs` 并上传 `fs-fault-report.json`；`db-backup --prune` 的孤儿清单识别扩展到"加密中断留下的 .part 文件"与"报告写入中断"，三种成因各自计数并写进报告；`restore-runbook.md` 补三种成因的人工处置；capacity-baseline §5b 增 Linux 列（填 CI 结果，标明托管 runner 不是目标主机）。
- 文件：`.github/workflows/ci.yml`、`scripts/db-backup.mjs`、`scripts/lib/fs-fault.mjs`、`tests/fs-fault.test.mjs`、文档。

## AH7 供应链：签名核验进门禁、zip 条目上限、大陆安装路径
- 现状：切到 npmjs 后 `npm audit signatures` 仍只在发行工作流；zip 条目/解压上限不可靠；大陆安装速度未评估。
- 改动：`ci.yml` 的 `dependency-review` job 增 `npm audit signatures` 一步（PR 上实跑）并把 `check-lock-registry` 也放进去；`verify-release` 给解压加硬上限（条目数、单文件与总解压字节、路径穿越）并有测试；`docs/security/dependency-notes.md` 写明"锁文件只认 npmjs；大陆部署用 `npm ci --registry` 的镜像只影响下载、integrity 仍按锁文件校验"，并给一个 `scripts/check-install-registry.mjs` 验证安装后 `node_modules/.package-lock.json` 的 resolved 与锁文件一致。
- 文件：`.github/workflows/ci.yml`（只改 `dependency-review` job）、`scripts/verify-release.mjs`、新脚本、测试、文档。

## AH8 托管 runner 首跑（视 PR 合入情况，重复项）
- 同 AG8 规则；若 `release-candidate.yml` 已在 main，先 `dry_run=true` 再完整一次；若仍未合入，只复查并把"不可派发"写进报告。

## AH9 MCP 限速：denied 行清理、配额接口分页、指标标签基数
- 改动：`denied` 行纳入现有清理周期并暴露 `os_erp_mcp_rate_denied_rows` gauge；`GET /api/mcp/limits/quota` 改游标分页（`cursor`/`limit`，默认 100，上限 500），前端卡片"加载更多"；每令牌 429 指标不以令牌 id 做 label（基数守卫测试：label 集合必须是常量）；`monitoring.md` 的阈值推导补"按生产流量校准"的步骤与一个 `scripts/mcp-rate-calibrate.mjs`（读直方图导出，给出建议阈值，不改配置）。
- 文件：`server/lib/mcp-rate-limit.js`、`server/mcp/admin.js`、`server/lib/metrics-export.js`、`src/pages/system/McpCenter.tsx`、新脚本、测试、文档、ADR-0056 补充 4。

## AH10 角色停用的影响预告与恢复指引（ADR-0051 补充 5）
- 改动：停用角色的接口返回/前端弹窗显示"受影响用户 N 人（其中主角色为此角色 M 人）"，需要二次确认；主角色停用导致范围置空的用户登录后横幅给出"联系管理员"与管理员侧的"重新指派主角色"入口；审计记录停用/启用与受影响人数；一个浏览器场景。
- 文件：`server/routes/roles.js`（或现有角色路由）、`src/pages/system/Roles.tsx`、`src/pages/system/MyScope.tsx`、`tests/browser/*`、测试、ADR。

## AH11 前端补齐第十六批
- 改动：审计链页显示意图 `key_id` 与密钥集合状态（AG5）；令牌列表显示精确 429 数（AG9 的 `rate_limited_recent`）；备份页/系统页显示最近一次备份报告状态（AG6 报告文件）；两个浏览器场景；本机只做 `tsc`/`vite build`/策略测试。
- 文件：`src/pages/system/*`、`tests/browser/*`、`scripts/browser-ci.mjs`。

## AH12 操作/安装手册补第十六批功能
- 改动：把 AG12 第 57 章列出的未成文项写成正式章节（`dry_run`、指标范围守卫、计划快照、意图密钥轮换、备份报告持久性、npmjs 源、配额接口与 denied 行、停用角色横幅）；每条命令对照脚本参数；`docs:build` 并提交。
- 文件：`docs/本地交付/*.md`、`docs/operations/*.md`、`public/docs/*`。

---

## 分配

| 工作流 | 分支 | ADR | 迁移 |
|---|---|---|---|
| AH1 | feat/ah1-slow-tests | — | — |
| AH2 | feat/ah2-metrics-scopeless-report | 0057 补充 3 | — |
| AH3 | feat/ah3-explain-plan-large | 0044 补充 7 | — |
| AH4 | feat/ah4-fts-rebuild-resume | — | — |
| AH5 | feat/ah5-intent-key-enforcement | 0055 补充 4 | — |
| AH6 | feat/ah6-fs-fault-linux | — | — |
| AH7 | feat/ah7-signatures-gate | — | — |
| AH8 | feat/ah8-hosted-first-runs-5 | — | — |
| AH9 | feat/ah9-mcp-quota-paging | 0056 补充 4 | — |
| AH10 | feat/ah10-role-deactivate-preview | 0051 补充 5 | — |
| AH11 | feat/ah11-frontend-batch-sixteen | — | — |
| AH12 | feat/ah12-operator-docs-9 | — | — |

冲突提示：AH1、AH6 各给 `ci.yml` 追加一个 job，AH3 只改 AG3 那一步，AH7 只改 `dependency-review` job；AH9 与 AH11 都碰 MCP 页（数据 / 布局）；AH10 与 AH11 都碰系统页（各自页面）；AH2 与 AH11 都碰指标页（AH2 改隐藏逻辑，AH11 不碰指标页）；AH4 与 AH6 不碰同一脚本；AH12 只增文档。
