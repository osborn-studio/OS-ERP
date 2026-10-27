# 测试套件的组织、耗时与负载容忍（AH1）

日期：2026-10-24。范围：怎样跑测试、哪些文件算"慢"、负载抖动的断言怎么写。本页描述度量与约定，不是验收证据：耗时随机器和负载变化，托管 runner 与目标主机 `dmserver` 的数字不可互换。

## 1. 目录约定

| 位置 | 内容 | 谁跑 |
|---|---|---|
| `tests/*.test.mjs` | 门禁套件，每个文件在参考机上不超过 60 s | `ci.yml` `checks` job：`npm run test:focused`（`node --test --test-concurrency=1 tests/*.test.mjs`） |
| `tests/slow/*.test.mjs` | 超过 60 s 的文件，**首 5 行内**必须有 `// slow: <理由>` | `ci.yml` `slow-tests` job，与 `checks` 并行：`node scripts/test-timings.mjs --run tests/slow/*.test.mjs` |
| `tests/lib/load-tolerance.mjs` | 受负载影响的超时/轮询/重试预算常量 | 被测试导入，不是测试 |

`tests/*.test.mjs` 的 glob 不递归，所以 `tests/slow` 自动不在 `checks` 里；`tests/test-tree-policy.test.mjs` 把这一点钉死：slow 目录只含带理由头的 `*.test.mjs`，`checks` job 不出现 `tests/slow`，`slow-tests` job 存在并上传耗时 artifact，`docs/implementation/test-timings.json` 与目录一致。

发行候选的 `--run-tests`（`scripts/release-candidate.mjs`）会同时跑 `tests/*.test.mjs` 与 `tests/slow/*.test.mjs`：候选自己的证据不能因为门禁分流而少测。

本地跑全部：`npm run test:focused && npm run test:slow`。

## 2. 耗时报告

```
node scripts/test-timings.mjs --run [--output <json>] [--threshold-s 60] [files...]
node scripts/test-timings.mjs --check [--input <json>]
```

`--run` 对每个文件起一个 `node --test --test-reporter=tap` 子进程（串行，env 只带 `GML_RUNTIME_MODE=test`、`HOST=127.0.0.1`、`GML_DB=`、随机 `GML_JWT_SECRET`），记录墙钟耗时、通过/失败/跳过计数与最慢 5 个顶层用例，写 `docs/implementation/test-timings.json`（默认）；任何文件失败则退出 1，耗时仍写出。`--check` 只读：非 slow 文件不得超阈值（`exempt` 中登记理由的除外），slow 目录里的文件都有记录。CI 的 `slow-tests` job 把 slow 文件的结果作为 artifact `os-erp-test-timings-<run>-<attempt>` 上传，**不**回写仓库。

提交的 `test-timings.json` 是 2026-10-24 在 macOS Mac mini 上逐文件跑一遍的参考值（不是目标平台，也不是 CI）。重新测量后把新文件提交即可；移动文件后必须同步（`tests/test-tree-policy.test.mjs` 会红）。

### 参考值（> 40 s 的文件，秒）

| 文件 | 秒 |
|---|---|
| `tests/slow/audit-logs-view.test.mjs` | 337 |
| `tests/slow/dashboard-perf.test.mjs` | 204 |
| `tests/slow/audit-fts-races.test.mjs` | 186 |
| `tests/slow/authz-followups.test.mjs` | 176 |
| `tests/slow/audit-chain.test.mjs` | 141 |
| `tests/slow/audit-fts-ops-loop.test.mjs` | 103 |
| `tests/slow/approval-scope.test.mjs` | 97 |
| `tests/slow/auth-session.test.mjs` | 97 |
| `tests/slow/authz-misc.test.mjs` | 94 |
| `tests/slow/qimen-auth.test.mjs` | 94 |
| `tests/slow/mcp-doc-perms.test.mjs` | 93 |
| `tests/slow/inventory-scope.test.mjs` | 81 |
| `tests/slow/metrics-export.test.mjs` | 73 |
| `tests/slow/release-candidate.test.mjs` | 65 |
| `tests/fs-fault.test.mjs`（豁免，见下） | 62 |
| `tests/metrics-perms.test.mjs` | 57 |
| `tests/pos-authz.test.mjs` | 54 |
| `tests/release-signing.test.mjs` | 41 |
| `tests/synth-data.test.mjs` | 40 |

`tests/fs-fault.test.mjs` 刚好超线（62 s），不移动：roadmap-v13 AH6 要给它单独的 `fs-fault` CI job，路径固定为 `tests/fs-fault.test.mjs`；该豁免记在 `test-timings.json` 的 `exempt` 里并带理由。

## 3. 把一个文件移进 slow

1. `git mv tests/x.test.mjs tests/slow/x.test.mjs`，把文件内 `'../` 形式的相对路径改成 `'../../`（含 `new URL('../', import.meta.url)`）。
2. 在文件**第一行**加 `// slow: <一句话理由>（含测得秒数）`。
3. 改掉引用旧路径的地方：`ci.yml`、`scripts/check-file-header.mjs` 的 `DECLARED`、`docs/operations/*`。
4. 重新测量并更新 `test-timings.json`，跑 `node --test tests/test-tree-policy.test.mjs`。

反方向（文件变快了）同理。阈值是 60 s，不是 59 或 61：靠近线的文件用 `exempt` 或留在原处并写明，不要来回搬。

## 4. 负载抖动：常量而不是魔法数

托管 runner 与共享机器上，下面几类断言会在重跑即过的情况下偶发失败：子进程超时、"等服务就绪"的轮询、单次 HTTP 请求上限、写争用基准的重试预算。统一用 `tests/lib/load-tolerance.mjs`：

- `GML_TEST_LOAD_FACTOR`（正数，缺省 1，上限 20）整体放宽**等待与超时上限**；`LOAD_FACTOR`、`scaleMs()` 导出倍率。
- 超时常量：`SPAWN_TIMEOUT_SHORT_MS`（60 s）/`_MEDIUM_MS`（150 s）/`_LONG_MS`（280 s），`CASE_TIMEOUT_FAST_MS`（120 s）/`_MEDIUM_MS`（180 s）/`_SLOW_MS`（240 s）/`_CANDIDATE_MS`（590 s）。
- 轮询：`READY_POLL_ATTEMPTS` × `READY_POLL_INTERVAL_MS`（缺省 1200 × 50 ms），`UNTIL_POLL_ATTEMPTS` × `UNTIL_POLL_INTERVAL_MS`（1000 × 25 ms），`pollUntil()`。
- `FETCH_TIMEOUT_MS`：对真实服务的单次请求上限。
- `WRITE_BENCH`：写争用基准的 `busy-ms`/`retry-max`/占锁/间隔；重试已经是脚本允许的上限，**不随倍率变**——要更稳就减少迭代数，不要再加重试。

规矩：**只放宽等待，不放宽行为断言**。"至少一次重试"、"零重复行"、"完整性检查通过"、"被拒绝的请求不改状态"这类断言不得加倍率、不得改成近似。新增会随负载波动的数字，先看这里有没有现成常量，没有就加一个并写清它放宽的是什么。

AH1 已迁移 `tests/write-contention.test.mjs`、`tests/release-signing.test.mjs`、`tests/slow/audit-fts-ops-loop.test.mjs`、`tests/slow/audit-fts-races.test.mjs`。

2026-10-27 E03：其余 12 个 slow 文件的用例/子进程/HTTP 超时与服务就绪、归档暂停、profile 等待已迁移到公共预算。`SLOW_WAIT` 补齐 5/10/30/90/120/290/300 秒的原有上限，以及 2400/250/600/100 次的原轮询上限；默认倍率 1 时数值逐项保持不变。已有 15 秒 HTTP、180 秒用例与280秒子进程上限复用原常量。只缩放轮询次数，间隔仍为原来的 40/50 毫秒，不让预算被乘两次。

不迁移业务时钟（缓存 TTL、令牌过期、限流窗口）、数据行数、重试次数、锁持有时间、模拟延迟和断言阈值；这些决定被测行为。所有 slow 文件仍由托管慢套件实际运行，不能用预算映射测试代替 Linux 行为验收。新增真实超时应先定位原因，不能靠提高倍率制造通过。

## 5. 已知基线失败（macOS 参考机，AH1 开始前就存在）

逐文件参考跑里有两个文件各有 1 个失败，与本工作流的改动无关，已在 `test-timings.json` 里以 `exit: 1` 如实记录：

- `tests/explain-plan-guard.test.mjs`：`the committed … explain-plans.json matches the current statements on a freshly migrated database` 期望最后一个迁移是 `075_mcp_rate_denied_kind`，实得 `074_oms_items_order_index`。
- `tests/mcp-limits-readout.test.mjs`：`GET /api/meta/audit-logs carries fts state …` 的键集合多出 `fallback_total`。

这两处在托管 CI 上是否通过未知（本批没有触发工作流）；见 backlog。

### 独立挑战审计后的门禁补强（2026-10-24）

`regression` 保留既有必需检查名称，但依赖 `checks` 与 `slow-tests`，并用 `always()` 在依赖失败或取消后仍执行首步结果校验；只有两者均为 success 才运行回归。这样慢测试及 `GML_AUDIT_FTS=0` 重跑的失败不能因 job 非必需而绕过门禁，无需修改仓库保护设置。

`test-timings` 为每个文件分配新临时 HOME/TMPDIR/GML_DATA_DIR（默认位于临时目录的 osstack 下，支持 OSSTACK_SCRATCH_ROOT），结束后清理。仅透传 CI 与显式负载倍率；倍率默认 1，不自动放宽行为断言。失败时输出最多 10 个脱敏用例名称与进程错误码/信号，不输出原始断言或凭据。提交的 timings JSON 是历史测量，不是所有新增测试都低于 60 秒的证明；托管最新耗时 artifact 与完整套件结果需另行核验。
