# 查询规划器与 `ANALYZE`：应用不执行，若将来引入要做什么

适用：`scripts/explain-audit.mjs`、迁移 059 / 067 / 070 / 074 的索引、`server/lib/dashboard-sql.js` 与 `server/lib/oms-sql.js` 的区间谓词（ADR-0044 补充 3、4、5、6）。

## 1. 现状

- 应用、迁移、`synth-data`、各基准脚本**都不执行 `ANALYZE`**（`PRAGMA optimize` 同理未使用），库里没有 `sqlite_stat1`。没有统计信息时 SQLite 规划器按固定的启发式选索引，`explain-audit` 的 `expectIndex` / `expectSearch` 断言与 capacity-baseline 里的前后计划都是在这个前提下取得的。
- 运维人员**手动**对生产库跑 `ANALYZE`（或 `sqlite3` 命令行 `PRAGMA optimize`）就会改变这个前提：`oms_orders` 上规划器可能改选 `idx_oms_status` 的 skip-scan，而不是 `idx_oms_order_time` 的范围 SEARCH。

## 2. 如果将来引入 `ANALYZE`（或有人手动跑过）

1. 先在**该库的只读副本**上复跑索引审计，用同一份数据看计划是否变了：
   `GML_DATA_DIR=/abs/copy node scripts/explain-audit.mjs --industry cosmetic`。
   `dash.trend_online`、`dash.channel_online`、`ai.platform_analysis` 和全部八条 `oms.stats_*`（含受限范围形态，AF3）会因 `expectIndex` / `expectSearch` 报红，说明计划已偏离。
2. 用 `scripts/bench-oms-order-time.mjs` 在同量级合成数据上量一次延迟（脚本刻意不跑 `ANALYZE`，要量统计信息版本需自行在其副本里加一行）。
3. 计划变差时的处置顺序：删除该库的统计（`DELETE FROM sqlite_stat1`，然后重开连接）→ 评估把查询改成显式 `INDEXED BY`（会让索引缺失时语句直接报错，要同步迁移自愈）→ 重新评估 `expectIndex` 声明。**不要**只为让审计变绿而删除断言。
4. 更新 `docs/implementation/capacity-baseline.md` 并在 ADR-0044 补充里记下新的前提。

## 2a. AF3 新增的两处"提示"写法（改动前要知道）

- `oms-sql.js` 的 `likely(<范围谓词>)`：语义恒等，只是让规划器不把受限范围的 `platform_id IN (子查询)` 当成比 `order_time` 区间更有选择性的条件。有了统计信息后这个启发式可能被推翻——同样由上面的 `expectIndex` 报红来发现。
- `omsStatsByPlatformStmt` 子查询里的 `GROUP BY +platform_id`（一元加号）：阻止规划器为"按平台分组"改走 `(platform_id, platform_order_no)` 自动索引整表扫描。不要"清理"掉这个加号。
- explain-audit 不把"计划里 `MATERIALIZE x` / `CO-ROUTINE x` 声明的派生表上的自动索引"算作缺索引（它的内容是每次现算的聚合，没有真实索引可补）；派生表内部对真实表的读取仍是独立的计划行、照常被判定。
- 迁移 074 的 `idx_oms_items_order` 缺失时 `oms.stats_top_skus*` 会退化成整表 SCAN `oms_order_items`（没有豁免）：先跑迁移自检（`node scripts/verify-migrations.mjs`），不要为让审计变绿而恢复 ALLOW。

## 2b. 密集窗口的已知退步（AF3，迁移 074）

订单几乎全部集中在最近 60 天（时间窗口覆盖几乎所有行，例如刚上线不久的实例）时，`/stats` 的热销 SKU 与受限范围的平台汇总会比 AE3 慢约 2 倍（开发机合成数据：热销 SKU 全局 90 天约 93 → 186 ms，受限平台汇总 90 天约 45 → 67 ms）：订单窗口驱动要对窗口内每个订单随机探一次 `idx_oms_items_order`。换来的是读量随窗口内订单数而不是全部历史订单数增长。这是 ADR-0044 补充 5 记录的取舍，不是故障，也不要为此删除迁移 074 的索引；若评审要改发布复合索引方案，是一个迁移的差别。操作员视角见操作手册 51.4。

## 2c. 计划指纹快照与 CI 守卫（AG3，ADR-0044 补充 6）

`expectIndex` / `expectSearch` 只断言"用了某个索引"。AG3 把**每条登记语句的整条计划**存成指纹，任何漂移都会让 CI 变红：

- **快照文件**：`docs/implementation/explain-plans.json`（120 条语句，每条一个 `hash` 加归一化后的计划行，另记迁移号、SQLite 版本和生成命令）。归一化 = 去掉字面量 / `?NNN` / `:name` 参数、比较运算符后的数值常量、子计划编号（`SUBQUERY 2` → `#`）、多余空白；其余数字（如虚表策略 `VIRTUAL TABLE INDEX 64:M1`）保留；表名、索引名、SCAN/SEARCH、COVERING、`USE TEMP B-TREE`、嵌套缩进都保留。
- **与数据无关**：没有 `sqlite_stat1` 时规划器按固定启发式选计划，所以小合成库上的指纹等于大库上的计划形状（`tests/explain-plan-guard.test.mjs` 断言空库与已提交快照一致）。库里有 `sqlite_stat1` 时 `--compare` 直接拒绝（统计会改计划）。
- **生成（本地与 CI 同一形状）**：

  ```
  SYNTH_DIR="$(mktemp -d)/synth"
  GML_RUNTIME_MODE=production GML_DATA_DIR="$SYNTH_DIR" GML_DB= node scripts/synth-data.mjs --quiet
  GML_DATA_DIR="$SYNTH_DIR" node scripts/explain-audit.mjs --snapshot docs/implementation/explain-plans.json
  ```

  `synth-data` 取默认小规模（60 SKU / 600 流水 / 120 单，种子 20261023，约 1.5 s）。`--snapshot` 在审计有违规时拒绝写文件（不把坏状态固化成基线）。
- **比较**：`GML_DATA_DIR="$SYNTH_DIR" node scripts/explain-audit.mjs --compare docs/implementation/explain-plans.json`，CI `checks` 作业里的"Query plan snapshot"步骤就是这两行加上同样的造库。漂移的语句会打印前后计划行（`-` / `+`）。
- **有意改变计划时**（新迁移、改写 SQL）：先确认新计划是想要的，然后**重取快照并在同一个 PR 里提交**，PR 说明写明哪些语句的计划变了、为什么。若只想临时放行某条语句，在快照 `whitelist` 里加 `{ "statement": "<id>", "accepted_hash": "<比较输出里的新 hash>", "reason": "<至少 20 个字符的理由>" }`：条目绑定被接受的那一个新指纹，之后同一语句再变会重新红；该语句没有漂移时条目算过期、同样红；重取快照会清空白名单。
- **只有 SQLite 措辞变了**（升级 better-sqlite3 后整批 hash 变）：`--compare` 会在 note 里提示两边 SQLite 版本不同；确认只是措辞，再重取快照。
- **提示**：删除一个索引时，不带 `expectIndex` 的语句（如 `stock.txn_by_wh_sku_batch` 依赖 `idx_it_wh`）原本不会红，现在会因指纹变化红。

## 2d. 源码里不许出现统计收集语句（AG3）

`--compare` 同时扫描 `server/`、`scripts/` 下非测试的 JS / TS / SQL 源码（`scripts/lib/analyze-scan.mjs`）：字符串或模板字面量里出现独立的 `ANALYZE`，或 `PRAGMA optimize` / `pragma('optimize')`，就红（注释、标识符、路径不算）。只想跑这项检查：`node scripts/explain-audit.mjs --analyze-scan`（不需要数据库）。确有必要时在 `ANALYZE_ALLOW` 加 `{ file, reason }`（理由 ≥20 字符；文件已无命中则条目过期、同样红）。当前为空。边界：只扫静态文本——运行时拼接、`eval`、命令行里的 `sqlite3`、`package.json` / 工作流里的命令扫不到；本检查防"手滑写进代码"，不防有意绕过，运维手动 `ANALYZE` 仍按第 2 节处理。

## 3. 为什么这样写

`oms_orders.order_time` 的区间谓词依赖"没有统计信息"时的启发式（范围约束优先于等值前缀较短的索引）。这是已知的脆弱点，不是疏忽：把它写进审计（而不是靠 `INDEXED BY` 硬绑）是为了让索引缺失时语句仍可执行，只是慢。
