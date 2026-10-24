# ADR-0054：审计 FTS5 索引可选化与无 FTS5 构建的真实验证（AD4）

状态：开发实现，尚非产品上线验收｜相关：迁移 067（AB3）、AC5（`GML_AUDIT_FTS`、`audit-fts-maintain`）、ADR-0009（已执行迁移不改）、roadmap-v9 AD4

## 背景

`GML_AUDIT_FTS=0` 只切换查询路径，067 的表与触发器仍在，并不等于"没有 FTS5 的 SQLite 构建"；CI 里"无 FTS5"的路径一直只靠 `setFtsOverride` 模拟和环境开关。另一方面索引是影子数据：运维没有办法在不改代码的前提下把它整个去掉（磁盘、写放大、怀疑索引问题时的彻底回退），也没有可逆的入口。

## 决定

### 1. 危险设置键 `audit_fts_enabled`（默认开）
- 登记在 `server/lib/settings.js`（bool、`is_danger`、改值必须写理由、留痕到 `setting_audit_log`）；危险键数 19 → 20（`scripts/test-setting-audit.mjs`）。
- 语义：库里存的值恰为 `"0"` 才算关；没有 settings 表 / 没有这一行 / 其它值都按默认（开）。

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
