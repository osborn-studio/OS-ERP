# 审计日志关键词检索：FTS5 索引维护与无 FTS 回退

适用：迁移 067（`audit_logs_fts`，FTS5 外部内容表，trigram）、roadmap-v8 AC5。数字见 `docs/implementation/capacity-baseline.md` 的 "AC5" 一节。

## 1. 它是什么

- `audit_logs_fts` 是 `audit_logs` 的**影子索引**，只存倒排索引；正文仍在 `audit_logs`。三个触发器在同一事务内维护它。
- 触发器被删、裸 SQL 绕过触发器写入、崩溃后的异常，都可能让索引与表不一致。表现：关键词检索**漏行**（走 FTS 的关键词：≥3 字符且命中稀少）。LIKE 路径不受影响。
- 没有 FTS5 / trigram 的 SQLite 构建上，迁移 067 是空操作，表不存在，检索自动走 LIKE。

## 2. 维护脚本

```sh
node scripts/audit-fts-maintain.mjs --data-dir /abs/path/to/data --industry cosmetic --integrity-check
node scripts/audit-fts-maintain.mjs --data-dir /abs/path/to/data --industry cosmetic --optimize
node scripts/audit-fts-maintain.mjs --data-dir /abs/path/to/data --industry cosmetic --rebuild
```

| 动作 | 做什么 | 持写锁 | 何时用 |
|---|---|---|---|
| `--integrity-check` | FTS5 `integrity-check`（含与 `audit_logs` 对账）| 短（一次写事务；大库上与索引大小成正比）| 每周 / 升级后 / 怀疑检索漏行时 |
| `--optimize` | 合并索引段，不改内容 | 与累积的未合并段成正比 | 大批量写入 / 归档后 |
| `--rebuild` | 从 `audit_logs` 重建整个索引 | **整个重建期间**（单次写事务）| `integrity-check` 报 corrupt 之后；触发器被重建之后 |

- 必须显式给 `--data-dir`（绝对路径）与 `--industry`。仓库 `data/` 被拒绝（退出 2）；环境里的 `GML_DB` 被忽略。脚本不创建库、不跑迁移、不建 FTS 表。
- 退出码：0 成功；1 失败（`corrupt` / `busy` / `error`，或表不存在时的 `--optimize` / `--rebuild`）；2 参数 / 环境错误。表不存在时 `--integrity-check` 退出 0，报告 `status: "absent"`（无 FTS5 的构建本来就没有）。
- 报告：默认写到 `<data-dir>/audit-fts-maintain-<行业>-<动作>-<时间戳>.json`（0600），`--out <绝对路径>` 另指（物理位置不能在仓库 `data/` 下，含经符号链接；不能是库文件或其边车；不覆盖已有文件）。库文件本身是符号链接时拒绝。字段：`status`、`rows`、`elapsed_ms`（BEGIN→COMMIT 墙钟，持写锁时间的粗上界）、`lock_probe`（另一线程用自己的连接反复 `BEGIN IMMEDIATE` 量出的写入者被挡时长：`max_blocked_ms` 近似上界、`max_busy_span_ms` 下界，见 `scripts/lib/lock-probe.mjs`）、`triggers_present`、`bytes_before` / `bytes_after`。报告不含绝对路径。
- 拿不到写锁（默认等 5 s，`--busy-ms` 可调）时 `status: "busy"`、退出 1，**索引不被改动**。

### 重建的操作建议

1. 先 `--integrity-check`；只有报 `corrupt` 或触发器曾缺失才需要 `--rebuild`。
2. `--rebuild` 期间其它写入（包括每条审计写入）会等待 `busy_timeout`（默认 5 s）：**100 万行约数秒**（见 capacity-baseline "AC5"，Mac mini 数字，目标主机请自行实测）。在低峰执行；超过 5 s 的重建会让同时到达的写入收到 `SQLITE_BUSY`。读者不受影响（WAL）。
3. 重建后再 `--integrity-check` 应为 `ok`。

### 夜间可选步骤

`nightly-capacity.yml` 手动触发时可填 `audit_fts=integrity-check`（默认空 = 不跑，定时触发永不跑）：在流水线合成库的**副本**上跑 `--integrity-check`，日志只打印一行固定格式摘要。该步骤失败只告警，不改变夜间门禁。

## 3. 强制走 LIKE：`GML_AUDIT_FTS=0`

- 进程环境里 `GML_AUDIT_FTS` 恰为字符串 `0` 时，审计检索一律走 `LIKE`（`keywordUsesFts` 恒为 false）；其它取值（未设、空串、`1`、`false`）不关闭 FTS。代码每次查询时读取该变量；对已运行的服务进程，环境变量只能靠重启来改。
- **只影响查询路径**：迁移 067 照常建表与触发器，写入照常维护索引，维护脚本照常可用。用途：FTS 索引被怀疑有问题时的**止血开关**（先切 LIKE，再 `--rebuild`），以及测试。
- CI 的 checks job 有一步 `Audit view tests without FTS (GML_AUDIT_FTS=0)`，用该开关再跑一遍 `tests/audit-logs-view.test.mjs`：在带 FTS5 的构建上真实演练回退路径（此前只靠 `setFtsOverride` 模拟）。依赖"FTS 路径可用"的用例在该运行里按原因跳过，其余照跑。
- 代价：LIKE 路径在命中稀少的关键词上会读全表（100 万行约百毫秒级，见 capacity-baseline "AB3"）。

## 4. 完全关闭索引：设置 `audit_fts_enabled`（AD4，ADR-0054）

- 危险设置键，默认开。关闭 = 删除 `audit_logs_fts` 与三个触发器，检索一律走 LIKE（与无 FTS5 的构建同一条路径），审计写入少一次索引维护；可逆。
- 运维入口（同一个写事务里改设置并删/建对象，必须写理由，留痕到 `setting_audit_log`）：

```sh
node scripts/audit-fts-maintain.mjs --data-dir /abs/path/to/data --industry cosmetic --disable --reason "原因"
node scripts/audit-fts-maintain.mjs --data-dir /abs/path/to/data --industry cosmetic --enable  --reason "原因"
```

- `--enable` = 建表 + 触发器 + 回填存量行（即 `--rebuild` 的成本，持写锁到结束，低峰执行）；构建不支持 FTS5 时报 `unsupported`、退出 1、设置不改。两个动作幂等。
- **启动自愈规则**：只在设置这样说时才动索引——设置开且对象缺失 → 重建并回填；设置关且对象存在 → 删除；设置关且对象已不在 → 什么都不做（不会每次启动重建）。在界面 / API 里改设置不立即动索引，下次启动收敛；要立即生效用上面的脚本。
- 在带 FTS5 的构建上建过索引的库，不要拿到无 FTS5 的构建上写入；要换构建，先 `--disable`。
- 与 `GML_AUDIT_FTS=0` 的区别：后者只切查询路径、索引与触发器仍在并被维护；设置关闭是真正删除。
- CI 的 `audit-no-fts5` job 用从源码重编译、去掉 `SQLITE_ENABLE_FTS5` 的 better-sqlite3 跑 `tests/audit-logs-view.test.mjs` 与 `tests/audit-fts-maintain.test.mjs`（真实无 FTS5 构建）。

## 5. 端到端运维闭环：关闭 → 检索仍可用 → 重启 → 重新开启（AE4，ADR-0054 补充）

`tests/audit-fts-ops-loop.test.mjs` 在真实服务进程（随机 loopback 端口、临时数据目录）上演练下面整条链路；回填耗时见 capacity-baseline "AE4"。

| 步骤 | 操作 | 预期（可核对） |
|---|---|---|
| 1 | 服务**运行中**执行 `--disable --reason "原因"` | 退出 0，报告 `status: ok`、`setting_after: "0"`、`changed_objects: true`；`audit_logs_fts` 与三个触发器都不在；`setting_audit_log` 多一行留痕 |
| 2 | 照常使用：关键词检索 | 结果与关闭前完全一致（走 `LIKE`）；关闭期间新写入的审计行立即可检索，索引**不会**被写入悄悄重建 |
| 3 | 重启服务 | 设置为关 → 启动自愈**不**重建索引；`--integrity-check` 报告 `status: absent`（退出 0）|
| 4 | 低峰执行 `--enable --reason "原因"` | 退出 0，`setting_after: "1"`；建表 + 触发器 + **回填全部存量行（含第 2 步关闭期间写入的行）**；关键词检索重新走 FTS（≥3 字符且命中稀少）；`--integrity-check` 为 `ok` |
| 5 | 之后的新写入与再次重启 | 触发器维护索引；设置为开 → 重启后对象仍在 |

- 重复执行同一动作是幂等的（`changed_objects` / `setting_changed` 为 false）；缺 `--reason` 退出 2、什么都不改；构建不支持 FTS5 时 `--enable` 报 `unsupported`、退出 1、设置不改。
- 步骤 4 持写锁到回填结束；100 万行的实测见 capacity-baseline "AE4"（复现：`node scripts/bench-audit-fts-toggle.mjs --rows 1000000`，在系统临时目录建库、结束即删）。期间并发写入等 `busy_timeout`，可能收到 `SQLITE_BUSY`——低峰执行。
- 并发与失败：设置与对象在同一个 `BEGIN IMMEDIATE` 事务里改，拿不到锁 → `status: busy`、二者都不变；中途失败 → 整体回滚。两个运维脚本同时执行时后到者等锁，之后看到的是已改好的状态（幂等）。
- 已知窗口（未修）：`--disable` 恰好提交于某个在途关键词请求「选定走 FTS」与「执行查询」之间时，那一个请求会失败（`no such table: audit_logs_fts`；CSV 导出跨批次可能中途失败），重试即可——低峰执行，或先以 `GML_AUDIT_FTS=0` 重启切走查询路径再 `--disable`。启动自愈与维护脚本恰好重叠时，启动可能得到 `SQLITE_BUSY_SNAPSHOT` 而失败，重启即可。
- 无 FTS5 构建：CI 的 `audit-no-fts5` job（`ci.yml`）从源码重编译去掉 `SQLITE_ENABLE_FTS5` 的 better-sqlite3 并跑审计视图与维护测试；该 job 在托管 runner 上的首次运行结果尚未验证（见 ADR-0054）。
