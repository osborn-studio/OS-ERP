# ADR-0054：审计 FTS5 索引可选化与无 FTS5 构建的真实验证（AD4）

状态：开发实现，尚非产品上线验收｜相关：迁移 067（AB3）、AC5（`GML_AUDIT_FTS`、`audit-fts-maintain`）、ADR-0009（已执行迁移不改）、roadmap-v9 AD4

## 背景

`GML_AUDIT_FTS=0` 只切换查询路径，067 的表与触发器仍在，并不等于"没有 FTS5 的 SQLite 构建"；CI 里"无 FTS5"的路径一直只靠 `setFtsOverride` 模拟和环境开关。另一方面索引是影子数据：运维没有办法在不改代码的前提下把它整个去掉（磁盘、写放大、怀疑索引问题时的彻底回退），也没有可逆的入口。

## 决定

### 1. 危险设置键 `audit_fts_enabled`（默认开）
- 登记在 `server/lib/settings.js`（bool、`is_danger`、改值必须写理由、留痕到 `setting_audit_log`）；危险键数 19 → 20（`scripts/test-setting-audit.mjs`）。
- 语义：库里存的值恰为规范串 `"0"`（不裁剪、不认 false/off/空串）才算关；没有 settings 表 / 没有这一行 / 其它值都按默认（开）。删除是破坏性的，所以对手工改库得到的非规范值保守地保持开启（`writeSetting` 总写规范值）。

### 2. 迁移 071 `071_audit_fts_optional.cjs`：不新增结构，只负责"按设置收敛"
- 067 不改（ADR-0009：改已执行迁移 = 生产启动校验和失败）。但 067 的 `verify()` 把"表缺失"当作脱节并重建；设置为关时这会在**每次启动重建整张索引**。因此运行器新增一个通用声明：迁移可写 `supersedesVerifyOf = ['<旧迁移 id>']`，运行器此后不再单独自检旧迁移，由声明者的 `verify()`/`up()` 负责。071 声明接管 `067_audit_fts`。
- 071 的 `verify()`：构建无 FTS5/trigram → 真；设置开 → 067 的判据（表 + 三触发器齐全）；设置关 → 表与三触发器都不在。`up()` 对应：开 → 调 067 的 `up`（建 + 回填，幂等）；关 → 删触发器与表。
- **自愈规则（写死）**：启动时只在设置这样说时才动索引——设置开且对象缺失 → 重建并回填；设置关且对象存在 → 删除；其余不动。改设置本身（界面 / API）不立即动对象，下次启动收敛；要立即生效用脚本。
- 因此"自愈"现在记在 `071_audit_fts_optional` 名下（`runMigrations().healed`），不再是 `067_audit_fts`（`tests/audit-logs-view.test.mjs` 的对应断言已改）。
- 067 文件不在目录里（旧目录 / 测试副本）时 071 延迟 require、整体空操作。

### 3. 运维入口 `audit-fts-maintain --disable|--enable --reason <理由>`
- **同一个写事务**里：删除 / 重建 FTS 对象，并 `writeSetting('audit_fts_enabled')`（留痕，来源 `script`，`reason` 必填，缺则退出 2）。要么都成，要么都不改（忙 → `status: busy`，对象与设置都不变）。幂等（重复执行 `setting_changed: false`）。
- 启用 = 067 的 `up`（建表、触发器、回填存量行），持写锁到结束，大库耗时同 `--rebuild`（capacity-baseline "AC5"）；报告照常带持锁探针。构建不支持 FTS5/trigram 时 `--enable` 报 `unsupported` 并退出 1，设置不改。
- `audit-view.js` 不改：它本来就以"表是否存在"为唯一判据（`ftsAvailable`），表缺失与无 FTS5 构建走同一条路径。

### 4. CI：真实的无 FTS5 构建（已加 job `audit-no-fts5`）
- better-sqlite3 只通过 `deps/defines.gypi` 里的 `SQLITE_ENABLE_FTS5` 打开 FTS5；SQLite 的 `SQLITE_OMIT_FTS5` 并不是这里能传的开关（FTS5 默认关，打开靠 ENABLE）。所以 job 在 `npm ci --ignore-scripts` 之后删掉那一行 define，再 `npm rebuild better-sqlite3 --build-from-source`。
- 本地试验（Node 22.22.1、macOS，在 `node_modules/better-sqlite3` 的临时副本里，未碰共享 `node_modules`）：`node-gyp rebuild` 25 s、`npm rebuild --build-from-source` 39 s，远低于 10 分钟门槛；构建后 `compile_options` 仅剩 `ENABLE_FTS3/FTS3_PARENTHESIS/FTS4`，`CREATE VIRTUAL TABLE ... USING fts5` 报 `no such module: fts5`。ubuntu runner 上需要 python3 与 node-gyp 头文件下载（runner 自带 / 联网），预期同量级；`timeout-minutes: 20`。
- job 先断言"确实没有 FTS5"（否则失败，避免空跑），再跑 `tests/audit-logs-view.test.mjs` 与 `tests/audit-fts-maintain.test.mjs`。依赖 FTS 可用的用例在该构建上按原因跳过，其余（含新增的"无 FTS5 构建"用例）真实执行。
- 与并行工作流同改 `ci.yml`：本变更只新增一个独立 job，不动其它 job。

## 诚实边界

- 在 FTS5 构建上建过索引的库，拿到无 FTS5 构建上：虚拟表模块不在，`DROP TABLE` 删不掉（触发器引用它，写入也会失败）——这是 067 已写明的限制，071 在无 FTS5 构建上不尝试删除。先在带 FTS5 的构建上 `--disable`。
- 设置只管 `audit_logs_fts`；`GML_AUDIT_FTS=0` 仍是只切查询路径的止血开关，两者独立。
- 关闭索引后稀有关键词检索回到全表扫描（100 万行约百毫秒级，capacity-baseline "AB3"）。
- 本地 macOS 编译成功不等于 ubuntu runner 成功；该 job 的首次托管运行结果未验证。

## 后果

- 新文件：`server/db/migrations/071_audit_fts_optional.cjs`。改动：`server/db/migrations/runner.js`（`supersedesVerifyOf`）、`server/lib/settings.js`、`scripts/audit-fts-maintain.mjs`、`scripts/test-setting-audit.mjs`、`.github/workflows/ci.yml`、`tests/audit-logs-view.test.mjs`、`tests/audit-fts-maintain.test.mjs`、`docs/operations/audit-search.md`。

## 审计记录

Codex 审计（gpt-6.1-sol，只读，针对相对 batch-twelve 的差异）：无高危；确认 DROP 在事务内回滚正确、全新库 / 关闭后重启 / 再开启 / 缺触发器自愈路径、被接管的 067 校验和仍受检（`MIGRATION_CHECKSUM_MISMATCH`），CI 命令与已安装的 better-sqlite3 构建配置一致。
- 中：071 用 `trim()` 判关，`" 0 "` 会删除索引，与"恰为 0"的约定不符 ⇒ 已修：只认规范串 `"0"`，测试覆盖 `" 0 "`/false/off/空串/junk。
- 中：脚本的 `ensureSettings` 在 `BEGIN IMMEDIATE` 之前提交，之后失败会留下新播种的设置行与基线日志 ⇒ 已修：移入同一事务，新增失败回滚测试（触发器注入失败，对象、设置行、基线日志均回滚）。
- 未执行：Linux runner 上的无 FTS5 重编译 job（本地 macOS 试验在复制的 `better-sqlite3` 上通过并跑完两个测试文件：45 个用例，21 通过、23 跳过、1 失败；该失败是 `AA6 explain-audit` 断言 FTS 语句存在，已对无 FTS5 构建改为跳过并复跑通过）。

---

## 补充（AE4，第十四批）：运维闭环的端到端验证、回填实测与无 FTS5 job 的复核

状态：开发实现，尚非产品上线验收｜相关：roadmap-v10 AE4

### 做了什么
1. **端到端运维闭环测试** `tests/audit-fts-ops-loop.test.mjs`（真实 `server/index.js` 子进程、临时数据目录、随机 loopback 端口，维护脚本也是真实子进程）：服务运行中 `--disable`（对象与触发器删除、设置写 `"0"`、`setting_audit_log` 留痕）→ 关键词检索（含已有行与关闭后新写入的行）仍可用、答案与关闭前一致 → 重启服务，设置为关时不重建（`--integrity-check` 报 `absent`）→ `--enable` 建表 + 触发器 + 回填，关闭期间写入的行被索引（FTS 行数 = `audit_logs` 行数，`keywordUsesFts` 为真，`--integrity-check` 为 `ok`）→ 新写入由触发器维护，再重启仍为开。另有两个用例：缺 `--reason` 退出 2 且什么都不改（无 FTS5 构建上 `--enable` 报 `unsupported`）；`--enable` 遇另一连接持写锁 → `busy`、对象与设置都不变，释放后重试成功并回填。
2. **基准脚本** `scripts/bench-audit-fts-toggle.mjs`：合成 N 行库上的 `--enable` / `--disable` / `--integrity-check` 耗时，数字写入 capacity-baseline "AE4"（100 万行启用回填 1.5–1.6 s 持写锁；`--disable` 约 19 ms，但库文件不缩小，需要另行 `VACUUM`）。
3. **无 FTS5 的 CI job**：AD4 已经加了 `audit-no-fts5`（见上文第 4 节），所以本批**不新增 job**，也没有重复在 `node_modules` 副本里重编译；只复核了它依赖的前提在当前锁定的 better-sqlite3 上仍成立（`deps/defines.gypi` 中确有一行 `'SQLITE_ENABLE_FTS5',`，job 的 `sed` 模式可匹配）。该 job 的 `node --test` 命令未改动（避免与 AE6/AE7/AE8/AE10 同改 `ci.yml` 冲突），所以新测试文件里依赖 FTS5 的用例不在该 job 里跑，"无 FTS5 构建上 `--enable` 报 `unsupported`"这一分支也只在本地有 FTS5 的构建上被跳过（未在真实无 FTS5 构建上执行）。
4. 文档：`docs/operations/audit-search.md` 第 5 节、操作手册第 38.5 节（含并发/失败语义与关闭不回收磁盘的说明）。

### 并发与竞态的结论（设计层面，测试覆盖见上）
- 设置与对象在同一个 `BEGIN IMMEDIATE` 事务里改：写者（含服务进程的每条审计写入）要么排在事务前（回填会包含它）、要么排在事务后（触发器已在），不存在"行写入了但既没被回填也没触发器"的窗口（回填正确性由测试里"关闭期间写入的行在 `--enable` 后被索引"断言）。
- 运行中的服务不缓存"FTS 是否可用"（`ftsAvailable` 每次查 `sqlite_master`），所以 `--disable` 后无需重启，新请求立即转 LIKE（测试断言）。
- **已知窗口（Codex 审计，中，未修，记录在案）**：① `meta.js` 先决定走 FTS 再执行查询；`--disable` 恰好在这两步之间提交时，那一个在途请求会得到 `no such table: audit_logs_fts`（500），CSV 导出若跨多个批次则可能在中途失败。仅限 `--disable`（`--enable` 只是新增对象）、仅限执行脚本的那一刻在途的请求；建议在低峰执行，或先 `GML_AUDIT_FTS=0` 重启切走查询路径再 `--disable`。② 启动自愈（071）在运行器的延迟事务里先读设置再写：若维护脚本恰在这两步之间提交，写升级会得到 `SQLITE_BUSY_SNAPSHOT`（`busy_timeout` 解决不了陈旧快照），启动失败、重试即可。**不能**据此声称"后到者等锁、之后一定看到收敛状态"；这条只在无重叠时成立。两处都没有加重试代码（改 `meta.js`/运行器超出 AE4 范围且与其它工作流同文件），也没有重叠测试。

### 诚实边界
- 托管 ubuntu runner 上 `audit-no-fts5` 的首次运行结果仍未验证（未触发任何工作流）。
- 100 万行数字是 Mac mini、合成数据、机器有负载下的单次墙钟，不是目标主机结果；服务满负荷写入时执行 `--enable` 的写入者失败率未测。

### 审计记录（AE4，Codex gpt-6.1-sol 只读，相对 batch-thirteen 的差异）
无高危。`audit-no-fts5` job 的构建配置未发现缺陷；回填测试的断言有效（显式 `MATCH` + 外部内容 `integrity-check`，不只靠行数）。
- 中：`--disable` 与在途检索请求的竞态 ⇒ **未修，记录为已知窗口**（见上，修复要改 `meta.js` 的路径选择或加 LIKE 重试，超出 AE4 范围）。
- 中：启动自愈与重叠维护脚本的 `SQLITE_BUSY_SNAPSHOT`，以及本补充原稿"后到者等锁、必看到收敛状态"的过度表述 ⇒ 表述已更正；代码未改，无重叠测试。
- 中：测试清理顺序（目录先于服务与连接被删）⇒ 已修：单个有序清理钩子（停服务 → 关连接 → 删目录）。

---

## 补充 2（AF4，第十五批）：关闭两个已记录的竞态窗口

状态：开发实现，尚非产品上线验收｜相关：roadmap-v11 AF4；收口 AE4 补充里「未修，记录在案」的两项

### 做了什么
1. **在途请求的 LIKE 重试**（`server/lib/audit-view.js`，`meta.js` 只换成调用它）：新增 `auditQueryPlan(db, filters)`，它是一次请求内 `where`/`args` 的唯一持有者；`plan.run(fn)` 以当前计划执行 `fn`，若计划用了 FTS 且抛出 `SQLITE_ERROR: no such table: audit_logs_fts`（`isFtsMissingError`，不认其它表、其它错误码、非 SqliteError 形态之外的误匹配），就把计划换成 LIKE、`os_erp_audit_fts_fallback_total{reason}` +1，**只重跑一次**；重跑再失败原样抛出，LIKE 计划上的任何错误都不重试。列表的计数 + 取页放在同一次 `run` 里（同一份计划，不会出现总数走 FTS、行走 LIKE）；导出的起始计数是一次 `run`，之后**每个批次**经 `run(…, 'export_batch')`，索引在批次之间消失则从原游标继续（FTS 与 LIKE 同序同结果：FTS 只缩小候选集，同一个 LIKE 谓词仍然过滤，见 `buildWhere`），行不重不漏。计数器的 `reason` 是封闭集合 `query | export_batch`。
2. **启动自愈与维护脚本的写锁**：运行器的自愈改走 `withWriteRetry`（`tx.js` 的唯一重试实现：`BEGIN IMMEDIATE`，仅 BUSY/LOCKED 族，含 `SQLITE_BUSY_SNAPSHOT`，有上限与抖动）；锁内**先重读** `verify`，已收敛则什么都不做（日志 `heal-skip`，不计入 `healed`），否则按**此刻**的设置重跑 `up`。旧实现是延迟事务「先读设置再写」，维护脚本在两步之间提交会得到 `SQLITE_BUSY_SNAPSHOT`，`busy_timeout` 解决不了陈旧快照。`scripts/audit-fts-maintain.mjs --enable|--disable` 同样：`BEGIN IMMEDIATE`、遇 BUSY 有上限地重试（最多 5 次且总等待不超过 `--busy-ms`，每次重试前 ROLLBACK 并重新取锁），锁内重读设置值与对象，已与目标一致 → 回滚空事务、报告 `already_in_state: true`、`changed_objects`/`setting_changed` 为 false。**未改**：`--optimize/--rebuild/--integrity-check`。
3. **确定性测试钩子** `server/lib/test-pause.js`：环境变量指向一个目录，进程在暂停点写 `.<名>-paused` 并同步等待 `.<名>-continue`；仅 `GML_RUNTIME_MODE=test`（其它模式设置即抛 `PAUSE_HOOK_FORBIDDEN`），有 60 s 上限；未设置时零成本。三个暂停点：`GML_TEST_AUDIT_FTS_PAUSE`（审计检索，选定 FTS 之后、执行之前）、`GML_TEST_MIGRATE_HEAL_PAUSE`（自愈，锁外判定之后、取锁之前）、`GML_TEST_FTS_MAINTAIN_PAUSE`（脚本，读完状态之后、开事务之前）。
4. 测试 `tests/audit-fts-races.test.mjs`（10 个用例）：判据单测；计划在「prepare 之后、execute 之前由另一连接删索引」时恰好重跑一次、行相同、计数 +1；LIKE 计划 / 其它错误 / 第二次失败不重试不吞错；导出批次间删索引仍每行恰好一次且同序；**真实服务进程 + 真实 `--disable` 子进程**把删除排在请求暂停处（列表与导出各一次，均 200，`/metrics` 上计数为 2）；**启动自愈 vs `--enable`**（自愈已判定、脚本先提交 → 启动成功、无 `heal 071`、FTS 行数 = 审计行数）与 **启动自愈 vs `--disable`**（自愈不得撤销关闭）；两个脚本重叠（输家 `already_in_state`）；暂停钩子在非 test 模式被拒。已确认：去掉重试逻辑后「在途请求」用例转红。
5. 文档：`audit-search.md` 第 5 节（替换「已知窗口（未修）」）、`monitoring.md` 指标表。

### 诚实边界
- 重试只覆盖「表不存在」这一种形态。`--disable` 同时删三个触发器：写入路径（`insertAuditRow`）上的触发器引用已删表的窗口由 SQLite 的单写者串行化挡住（`DROP` 与 `INSERT` 在同一把写锁下排队），未发现需要额外处理的形态，但没有对写入路径单独做压力竞态测试。
- 在途请求窗口里，`--enable`（只新增对象）本来就不会让查询失败，没有对应重试。
- 重叠的 `--enable` 仍持写锁到回填结束（100 万行约 1.5 s，见 capacity-baseline「AE4」）；等待超过 `--busy-ms` / 自愈重试上限的一方失败（脚本 `busy`；启动失败，重启即可）。这是有意的上限，不是无限等待。
- 暂停钩子是同步阻塞的测试设施；"确定性"指的是进程间提交顺序由文件标记排定，不是对任意交错的穷举。
- 托管 runner（ubuntu）上的结果未验证；本批只在本机 macOS / Node 22 / 带 FTS5 的 better-sqlite3 上跑，无 FTS5 构建（`audit-no-fts5` job）上的新测试按原因跳过。
