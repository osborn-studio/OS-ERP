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
node scripts/audit-fts-maintain.mjs --data-dir /abs/path/to/data --industry cosmetic --rebuild [--batch-rows 5000] [--pause-ms 5]
node scripts/audit-fts-maintain.mjs --data-dir /abs/path/to/data --industry cosmetic --resume
```

| 动作 | 做什么 | 持写锁 | 何时用 |
|---|---|---|---|
| `--integrity-check` | FTS5 `integrity-check`（含与 `audit_logs` 对账）| 短（一次写事务；大库上与索引大小成正比）| 每周 / 升级后 / 怀疑检索漏行时 |
| `--optimize` | 合并索引段，不改内容 | 与累积的未合并段成正比 | 大批量写入 / 归档后 |
| `--rebuild` | 从 `audit_logs` 分批重建整个索引（AH4）：每批一个 `BEGIN IMMEDIATE` 事务，批间让出写锁，打印进度 | **每批**（默认 5000 行；30 万行 Mac mini 实测最长一批约 0.3 s，单事务则 1.7 s，见 capacity-baseline AH4）| `integrity-check` 报 corrupt 之后；触发器被重建之后 |
| `--resume` | 从检查点续跑被中断的 `--rebuild` | 同上 | `--rebuild` 被 SIGTERM / SIGINT / 崩溃中断之后 |

- 必须显式给 `--data-dir`（绝对路径）与 `--industry`。仓库 `data/` 被拒绝（退出 2）；环境里的 `GML_DB` 被忽略。脚本不创建库、不跑迁移、不建 FTS 表。
- 退出码：0 成功；1 失败（`corrupt` / `busy` / `error`，或表不存在时的 `--optimize` / `--rebuild`，或下面的检查点拒绝）；2 参数 / 环境错误；3 分批重建在批边界被信号中断（可 `--resume`）。表不存在时 `--integrity-check` 退出 0，报告 `status: "absent"`（无 FTS5 的构建本来就没有）。
- 报告：默认写到 `<data-dir>/audit-fts-maintain-<行业>-<动作>-<时间戳>.json`（0600），`--out <绝对路径>` 另指（物理位置不能在仓库 `data/` 下，含经符号链接；不能是库文件或其边车；不覆盖已有文件）。库文件本身是符号链接时拒绝。字段：`status`、`rows`、`elapsed_ms`（BEGIN→COMMIT 墙钟，持写锁时间的粗上界）、`lock_probe`（另一线程用自己的连接反复 `BEGIN IMMEDIATE` 量出的写入者被挡时长：`max_blocked_ms` 近似上界、`max_busy_span_ms` 下界，见 `scripts/lib/lock-probe.mjs`）、`triggers_present`、`bytes_before` / `bytes_after`。报告不含绝对路径。
- 拿不到写锁（默认等 5 s，`--busy-ms` 可调）时 `status: "busy"`、退出 1，**索引不被改动**。

### 重建的操作建议

1. 先 `--integrity-check`；只有报 `corrupt` 或触发器曾缺失才需要 `--rebuild`。
2. `--rebuild`（AH4 起分批）只在每一批里持写锁，写入者最多等一批的时间（默认 5000 行/批；`--batch-rows` 1..1000000，`--pause-ms` 批间停顿，默认 5 ms）；每批打印一行 `audit-fts-maintain progress rebuild batch=k/N rows=a/b pct=…`。Mac mini 实测数字见 capacity-baseline "AH4"，目标主机请自行实测；仍建议低峰执行。读者不受影响（WAL）。
3. **重建期间索引是残缺的**：库里有检查点表 `audit_fts_rebuild_state`，查询路径见到它就不走 FTS（回退 LIKE，结果相同，只是慢），`--integrity-check` / `--optimize` 报 `rebuild_in_progress`。**重建期间不要跑审计归档 / 清理**（见下）。
4. **中断与续跑**：对脚本发 SIGTERM / SIGINT，它在当前批提交后停止，报告 `status: "interrupted"`、退出 3，检查点留在库里；`--resume` 从检查点继续（`--batch-rows` 缺省沿用检查点里的值）。崩溃 / 杀进程同样可续跑（每批提交后检查点即更新）。
5. 触发器缺失时（常见于"触发器被重建之后"）分批不适用：初始化事务会在写锁内补齐触发器并做一次完整 `rebuild`（持写锁到结束，同旧行为），报告 `repaired_triggers`；批间触发器被删 → `triggers_missing`（退出 1，`--rebuild --restart` 修复）。
6. 拒绝路径（退出 1，索引与检查点都不被改动）：`--resume` 没有检查点 → `no_checkpoint`；检查点属于别的行业或别的库（指纹对不上）→ `checkpoint_mismatch`；`--rebuild` 时已有检查点 → `checkpoint_exists`（用 `--resume` 续跑，或确认后 `--rebuild --restart` 丢弃它从头来）。
7. 重建期间若有**尚未入索引**的审计行被删除（审计归档 / 清理在跑），触发器会对索引发出无效的 delete；续跑到末尾剩余行数对不上时报 `interfered`（检查点保留，索引仍不被查询使用）——用 `--rebuild --restart` 修复。`--disable` / `--enable` 会顺带清掉过期检查点（`--enable` 遇到残缺索引会做一次完整重建）。
8. 重建完成后再 `--integrity-check` 应为 `ok`（脚本不在持锁的最后一批里跑它，因为它与索引大小成正比）。

### 夜间可选步骤

`nightly-capacity.yml` 手动触发时可填 `audit_fts=integrity-check`（默认空 = 不跑，定时触发永不跑）：在流水线合成库的**副本**上跑 `--integrity-check`，日志只打印一行固定格式摘要。该步骤失败只告警，不改变夜间门禁。

## 3. 强制走 LIKE：`GML_AUDIT_FTS=0`

- 进程环境里 `GML_AUDIT_FTS` 恰为字符串 `0` 时，审计检索一律走 `LIKE`（`keywordUsesFts` 恒为 false）；其它取值（未设、空串、`1`、`false`）不关闭 FTS。代码每次查询时读取该变量；对已运行的服务进程，环境变量只能靠重启来改。
- **只影响查询路径**：迁移 067 照常建表与触发器，写入照常维护索引，维护脚本照常可用。用途：FTS 索引被怀疑有问题时的**止血开关**（先切 LIKE，再 `--rebuild`），以及测试。
- CI 的 slow-tests job（AH1 起；此前在 checks job）有一步 `Audit view tests without FTS (GML_AUDIT_FTS=0)`，用该开关再跑一遍 `tests/slow/audit-logs-view.test.mjs`：在带 FTS5 的构建上真实演练回退路径（此前只靠 `setFtsOverride` 模拟）。依赖"FTS 路径可用"的用例在该运行里按原因跳过，其余照跑。
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
- CI 的 `audit-no-fts5` job 用从源码重编译、去掉 `SQLITE_ENABLE_FTS5` 的 better-sqlite3 跑 `tests/slow/audit-logs-view.test.mjs` 与 `tests/audit-fts-maintain.test.mjs`（真实无 FTS5 构建）。

## 5. 端到端运维闭环：关闭 → 检索仍可用 → 重启 → 重新开启（AE4，ADR-0054 补充）

`tests/slow/audit-fts-ops-loop.test.mjs` 在真实服务进程（随机 loopback 端口、临时数据目录）上演练下面整条链路；回填耗时见 capacity-baseline "AE4"。

| 步骤 | 操作 | 预期（可核对） |
|---|---|---|
| 1 | 服务**运行中**执行 `--disable --reason "原因"` | 退出 0，报告 `status: ok`、`setting_after: "0"`、`changed_objects: true`；`audit_logs_fts` 与三个触发器都不在；`setting_audit_log` 多一行留痕 |
| 2 | 照常使用：关键词检索 | 结果与关闭前完全一致（走 `LIKE`）；关闭期间新写入的审计行立即可检索，索引**不会**被写入悄悄重建 |
| 3 | 重启服务 | 设置为关 → 启动自愈**不**重建索引；`--integrity-check` 报告 `status: absent`（退出 0）|
| 4 | 低峰执行 `--enable --reason "原因"` | 退出 0，`setting_after: "1"`；建表 + 触发器 + **回填全部存量行（含第 2 步关闭期间写入的行）**；关键词检索重新走 FTS（≥3 字符且命中稀少）；`--integrity-check` 为 `ok` |
| 5 | 之后的新写入与再次重启 | 触发器维护索引；设置为开 → 重启后对象仍在 |

- 重复执行同一动作是幂等的（`changed_objects` / `setting_changed` 为 false）；缺 `--reason` 退出 2、什么都不改；构建不支持 FTS5 时 `--enable` 报 `unsupported`、退出 1、设置不改。
- 步骤 4 持写锁到回填结束；100 万行的实测见 capacity-baseline "AE4"（复现：`node scripts/bench-audit-fts-toggle.mjs --rows 1000000`，在系统临时目录建库、结束即删）。期间并发写入等 `busy_timeout`，可能收到 `SQLITE_BUSY`——低峰执行。
- 并发与失败：设置与对象在同一个 `BEGIN IMMEDIATE` 事务里改，拿不到锁 → `status: busy`、二者都不变；中途失败 → 整体回滚。
- **在途请求与 `--disable`（AF4 已处理）**：检索请求「选定走 FTS」与「执行查询」之间索引表被删时，查询路径捕获 `no such table: audit_logs_fts`，**只重试一次**，换 LIKE 重跑（结果与 FTS 路径逐行相同），并使 `os_erp_audit_fts_fallback_total{reason="query"}` +1；CSV 导出跨批次时在原游标处换 LIKE 继续（`reason="export_batch"`），行不重不漏。重试后再失败、或别的错误，照常报错——不吞错。
- **启动自愈与维护脚本重叠（AF4 已处理）**：启动自愈（迁移 071 经 `supersedesVerifyOf` 接管 067 的自检）与 `--enable`/`--disable` 都用 `BEGIN IMMEDIATE` 先取写锁（遇 `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` 有上限地重试，脚本总等待不超过 `--busy-ms`），**拿到锁后重读设置与对象**：状态已被对方收敛则什么都不做（脚本报告 `already_in_state: true`；启动日志出现 `heal-skip 071`）。所以「后到者」的结论是：它不会撤销先到者的决定，也不会因陈旧快照使启动失败。仍然成立的边界：重叠的 `--enable` 持写锁到回填结束，等待超过上限的一方得到 `busy`（脚本）或启动失败（重启即可）。
- 回退计数 `os_erp_audit_fts_fallback_total{reason}` 的读法见操作手册第五十四章。审计列表响应的 `fts.fallback_total`（AG11）是各 `reason` 之和，审计页的索引状态卡据此显示；它同样是本进程自启动以来的累计，重启归零、多进程各自计数，分 `reason` 的明细只在计数器里。
- 无 FTS5 构建：CI 的 `audit-no-fts5` job（`ci.yml`）从源码重编译去掉 `SQLITE_ENABLE_FTS5` 的 better-sqlite3 并跑审计视图与维护测试；该 job 在托管 runner 上的首次运行结果尚未验证（见 ADR-0054）。

## 6. 切换时机与写入失败的含义（AG4，ADR-0054 补充）

`scripts/bench-audit-toggle-under-write.mjs` 在写入者持续写的同时多轮 `--disable` / `--enable`，结果见 capacity-baseline "AG4"。运维要点：

- **在写入低谷切换**。`--disable` 只是 `DROP`（毫秒到数百毫秒），`--enable` 要回填，持写锁时长随行数线性增长（合成数据：2 万行约几十毫秒，50 万行约 2.3–3.2 s，100 万行见 AE4）。持锁期间所有审计写入（和任何别的写事务）排队等 `busy_timeout`（默认 5000 ms，`GML_SQLITE_BUSY_MS` 可调）。
- **没有丢行、没有链断点**：压测里切换期间已确认的写入全部在表里，哈希链完好；`--disable` 期间写入的行由下一次 `--enable` 回填进索引（开启后 `--integrity-check` 应为 ok）。切换不会让写入者看到 `no such table` 或触发器错误。
- **写入失败只可能是 `SQLITE_BUSY`**（锁被占超过 `busy_timeout`）：该行**整体没有写入**（没有半截行，哈希链不受影响），不会事后补写。普通审计（`audit()`）遇错只重试一次（去掉明细），再失败则业务请求照常返回、这条审计缺失；严格审计（`auditStrictRow`）失败返回 503 并回滚业务事务。所以：回填预期时间 ≥ `busy_timeout` 的库，先在低谷执行，或临时调大 `GML_SQLITE_BUSY_MS` 后重启；事后用 `scripts/audit-verify-chain.mjs` 与 `--integrity-check` 核对。
- **怎么自检**：在隔离的库副本上跑 `node scripts/bench-audit-toggle-under-write.mjs --seed-rows <接近生产的行数> --rounds 3 --rate <峰值写入速率>`，看输出里的 `writer.lost_rows`（失败行，按类别）与 `max_write_ms`（最大写停顿），对账 `verify.ok` 应为 true。该脚本只用临时目录，不碰在用库。

