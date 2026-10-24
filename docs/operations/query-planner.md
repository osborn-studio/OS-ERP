# 查询规划器与 `ANALYZE`：应用不执行，若将来引入要做什么

适用：`scripts/explain-audit.mjs`、迁移 059 / 067 / 070 / 074 的索引、`server/lib/dashboard-sql.js` 与 `server/lib/oms-sql.js` 的区间谓词（ADR-0044 补充 3、4、5）。

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

## 3. 为什么这样写

`oms_orders.order_time` 的区间谓词依赖"没有统计信息"时的启发式（范围约束优先于等值前缀较短的索引）。这是已知的脆弱点，不是疏忽：把它写进审计（而不是靠 `INDEXED BY` 硬绑）是为了让索引缺失时语句仍可执行，只是慢。
