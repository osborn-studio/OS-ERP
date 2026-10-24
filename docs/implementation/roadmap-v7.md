# OS ERP 商用整改详细方案 v7（第十一批）

日期：2026-10-23。基线：`batch-ten`（PR #6 候选，含 v2–v6 全部工作流）。承接 backlog "第十批后仍 open" 节、第七至九批残留中尚未关闭的条目，以及各 AA 报告的"未验证"项。通用约束、TDD、守卫清单（`check-route-authz`、`check-data-paths`、`check-file-header`、`check-bizcode-shape`、`check-api-contract`、`explain-audit`、`gen-codemap --check`、`gen-changelog --check`、`gen-third-party-notices --check`）、Codex 审计方式（`codex exec -m gpt-6.1-sol --sandbox read-only … </dev/null`）与 [roadmap-v2](roadmap-v2.md) 相同。**硬约束**：不得对自己未启动的进程执行 `pkill`/`kill`；改动路由/模块/迁移/ADR 后运行 `node scripts/gen-codemap.mjs` 与 `node scripts/gen-changelog.mjs` 并提交生成物；登录节流环境变量上限 10000；只在隔离临时目录与随机 loopback 端口上测试。ADR 从 0046 起（0043 空号不用），迁移从 067 起。`gen-changelog.mjs` 的第十一批范围：ADR 53–64（第一个改到它的工作流负责加 `{ id: 11, title: '第十一批（进行中）：见 roadmap-v7', from: 53, to: 64 }`；其余工作流遇冲突以已有范围为准）。

---

## AB1 主数据下拉与剩余只读入口按范围（ADR-0046）
- 现状：`GET /master/options` 的 `warehouses`/`warehouses_all` 向任意登录用户返回全部仓库；`GET /api/purchase/orders` 列表与详情只有权限门禁；`/api/qc/overview`、`/api/qc/audit` 聚合不按范围（AA4 审计）。
- 改动：`master/options` 的仓库项按 `stockScopeSql` 裁剪（全局范围不变）；采购订单列表/详情经 `assertPurchaseDocInScope`/列表谓词；QC 概览与审计聚合按仓库范围 `WHERE` 收口；`check-route-authz` 待处理项逐条关闭或登记理由，目标待处理 ≤ 20。
- 文件：`server/routes/master.js`、`server/routes/purchase.js`、`server/routes/qc.js`、`server/routes/qc2.js`、`tests/inventory-scope.test.mjs`（扩）、守卫登记。

## AB2 看板其余接口剖析、缓存与多进程失效（ADR-0044 补充）
- 改动：`/dashboard/trend`、`/top`、`/todos`、`/inventory-dist` 接入 `GML_PROFILE=1` 剖析，≥50 ms 的块优化；`db-ttl-cache` 推广到这四个接口（读范围依赖调用者的接口按范围键分桶，或不缓存并记录理由）；补两个进程（`child_process` 起第二个 server 写入）下 `data_version` 失效测试；`capacity-baseline` 记录前后 p95。
- 文件：`server/routes/dashboard.js`、`server/lib/db-ttl-cache.js`、`tests/dashboard-perf.test.mjs`（扩）。

## AB3 审计日志关键词检索与剩余过滤形态（迁移 067）
- 改动：评估 FTS5 外部内容表 `audit_logs_fts(action, entity, user_name)`（触发器维护；`PRAGMA compile_options` 无 FTS5 时迁移跳过并记 `explain-audit` 豁免）；`created_at` 单列索引决定（写放大量化后取舍，写入 capacity-baseline）；仅 action 过滤改走 `(module, created_at)` 要求必须带 module，否则前端提示。
- 文件：`server/db/migrations/067_audit_fts.cjs`、`server/lib/audit-view.js`、`scripts/bench-audit-logs.mjs`、`tests/audit-logs-view.test.mjs`（扩）、前端审计页提示。

## AB4 发行候选证据签名（ADR-0047）
- 现状：`EVIDENCE.json` 的 `produced` 结果只有一致性与包绑定校验，手改即可声称已跑（AA7 Codex P1）。
- 改动：`release-candidate.mjs` 用 `GML_RELEASE_SIGN_KEY`（Ed25519 私钥 PEM 路径，缺省不签并写 `signature: null`）对 EVIDENCE 规范化 JSON 签名，`EVIDENCE.sig` 入包；`verify-release --evidence --pubkey <pem>` 校验；`scripts/release-keygen.mjs` 生成密钥对到隔离目录（0600，不进仓库）；README 说明密钥保管。
- 文件：`scripts/release-candidate.mjs`、`scripts/verify-release.mjs`、`scripts/release-keygen.mjs`、`scripts/package-release.mjs`、`tests/release-candidate.test.mjs`、`docs/release/README.md`。

## AB5 升级演练接受真正的旧结构库（ADR-0048）
- 现状：AA11 只能截断登记表并删索引，表/列仍是新结构；"真正旧库"需旧版本备份集。
- 改动：`scripts/schema-snapshot.mjs --upto N`：在隔离目录用 `schema.sql` + 迁移 ≤ N 建三库并经 `db-backup.mjs` 产出"版本 N 备份集"（带 SYNTHCO 指纹，可选灌入 synth 数据）；`upgrade-rehearsal.mjs --from N --backup <that set>` 则无需截断；夜间工作流 `rehearsal=true` 时先产快照再演练；在合成 medium 库上记录 059–066 的逐迁移耗时。
- 文件：`scripts/schema-snapshot.mjs`、`scripts/upgrade-rehearsal.mjs`、`tests/upgrade-rehearsal.test.mjs`（扩）、`.github/workflows/nightly-capacity.yml`、capacity-baseline。

## AB6 审计日志防篡改哈希链与归档（ADR-0049，迁移 068）
- 改动：`audit_logs` 增 `prev_hash`/`row_hash`（SHA-256 覆盖 id、created_at、user_id、action、entity、entity_id、detail、prev_hash），`insertAuditRow` 唯一写入点维护；`scripts/audit-verify-chain.mjs` 校验并报告首个断点；`scripts/audit-archive.mjs --before <date>` 导出 JSONL + 链头/链尾摘要后删除（危险操作，复用保留清理的确认机制），`check-data-paths` 登记。
- 文件：迁移、`server/lib/audit-trail.js`、两个脚本、`tests/audit-chain.test.mjs`、`docs/operations/*.md`。

## AB7 MCP 剩余角色门禁复刻（ADR-0011 补充）
- 现状：RC/YQ/SH 三类单据在 HTTP 侧有角色名/门店绑定门禁，MCP 侧未复刻（第七批残留）。
- 改动：`DOC_SCOPE_RESOLVERS` 为这三类加绑定规则（与 HTTP 同一判据函数，不复制 SQL）；`doc.get`/`doc.query`/`order.trace_document` 自动生效；矩阵测试加三类 × 绑定/未绑定；`check-mcp-coverage` 登记。
- 文件：`server/lib/doc-scope-registry.js`、`server/mcp/tools.js`（仅解析表接入）、`tests/mcp-tool-matrix.test.mjs`、`tests/mcp-doc-perms.test.mjs`。

## AB8 奇门签名密钥按安装生成（ADR-0033 补充，迁移 069）
- 现状：平台签名秘密仍是公开演示常量。
- 改动：迁移 069 清空演示常量；`scripts/qimen-issue-key.mjs` 已有的签发流程成为唯一来源；生产模式下无密钥的平台调用 503 `CAPABILITY_DISABLED` 不变、演示模式启动时生成随机密钥写入 `qimen_secrets` 并在日志提示（不写仓库）；`/capabilities` 不再回传 app_key 明文（只给前 4 位）。
- 文件：迁移、`server/routes/qimen.js`、`server/lib/qimen-auth.js`、`tests/qimen-auth.test.mjs`（扩）、操作手册。

## AB9 托管 runner 实跑新增场景与夜间步骤
- 改动：`ci.yml` 浏览器 job 纳入 AA8 三个场景并修复首跑问题；手动触发一次 `nightly-capacity.yml`（`rehearsal=true`），把结果摘要（不含产物）写入 capacity-baseline "托管 runner" 小节；`browser-ci-policy` 测试覆盖新场景登记；本机只做 `node --check`。
- 文件：`.github/workflows/ci.yml`、`scripts/browser-ci.mjs`、`tests/browser/*`、`tests/browser-ci-policy.test.mjs`、capacity-baseline。注意：触发工作流只用 `gh workflow run`，不改仓库设置。

## AB10 指标端点加固与缓存/看板指标（ADR-0045 补充）
- 改动：`/api/meta/metrics` 加按 IP 的节流（复用登录节流表的实现，独立桶）与 `GML_METRICS_TOKEN` 轮换（允许两把并存 `GML_METRICS_TOKEN_NEXT`）；新增 gauges/counters：看板缓存命中/未命中、审计写入延迟直方图、MCP 工具调用计数按结果码；`monitoring.md` 补告警规则。
- 文件：`server/routes/meta.js`、`server/lib/metrics-export.js`、`server/lib/db-ttl-cache.js`、`tests/metrics-export.test.mjs`（扩）、文档。

## AB11 合成 large 规模在托管 runner 上跑通
- 现状：roadmap 规模（10 万 SKU/100 万流水）未跑（开发机磁盘不足）。
- 改动：`synth-pipeline.mjs --profile large-ci` 在 ubuntu runner 14 GB 磁盘内分段生成（流水按 20 万一批、生成后即 VACUUM），`nightly-capacity.yml` 增 `scale` 输入（默认 medium）；输出 p95 表与 `explain-audit` 违规数；若 runner 超时（6 h 上限）则记录达到的规模并退出 0 但标 `partial: true`。
- 文件：`scripts/synth-data.mjs`、`scripts/synth-pipeline.mjs`、`.github/workflows/nightly-capacity.yml`、`tests/synth-data.test.mjs`（扩）、capacity-baseline。

## AB12 操作/安装手册补第十批功能与依赖残留说明
- 改动：操作手册增指标导出接入 Prometheus、升级演练流程与读报告、审批模板权限分离、POS 差异结算权限、发行候选 `--run-tests`/`--ci-run auto`、审计总数估算提示；安装手册增 `GML_DASHBOARD_CACHE_MS`、`GML_PROFILE`、`GML_METRICS_TOKEN`；`docs/security/dependency-notes.md` 记录 braces 链无修复的影响评估；`docs:build` 并提交生成物。
- 文件：`docs/本地交付/*.md`、`docs/operations/*.md`、`public/docs/*`。

---

## 分配

| 工作流 | 分支 | ADR | 迁移 |
|---|---|---|---|
| AB1 | feat/ab1-master-options-scope | 0046 | — |
| AB2 | feat/ab2-dashboard-rest-cache | 0044 补充 | — |
| AB3 | feat/ab3-audit-fts | — | 067 |
| AB4 | feat/ab4-evidence-signing | 0047 | — |
| AB5 | feat/ab5-schema-snapshot-rehearsal | 0048 | — |
| AB6 | feat/ab6-audit-hash-chain | 0049 | 068 |
| AB7 | feat/ab7-mcp-role-gates | 0011 补充 | — |
| AB8 | feat/ab8-qimen-per-install-secret | 0033 补充 | 069 |
| AB9 | feat/ab9-hosted-scenarios | — | — |
| AB10 | feat/ab10-metrics-hardening | 0045 补充 | — |
| AB11 | feat/ab11-synth-large-ci | — | — |
| AB12 | feat/ab12-operator-docs-3 | — | — |

冲突提示：AB3 与 AB6 都改 `audit_logs`（AB3 只加 FTS 影子表与触发器，AB6 只加两列与写入点）；AB5/AB9/AB11 都碰 `nightly-capacity.yml`（各自只加自己的输入与步骤，合并时以生成顺序叠加）；AB2 与 AB10 都碰 `db-ttl-cache.js`（AB2 扩接口，AB10 只加计数钩子）；AB7 只改解析表，不改各工具 handler；AB12 只增文档。
