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

`--compare` 同时扫描 `server/`、`scripts/` 下非测试的 JS / TS / SQL 源码（`scripts/lib/analyze-scan.mjs`）：字符串或模板字面量里出现独立的 `ANALYZE`，或 `PRAGMA optimize` / `pragma('optimize')`，就红（注释、标识符、路径不算）。只想跑这项检查：`node scripts/explain-audit.mjs --analyze-scan`（不需要数据库）。确有必要时在 `ANALYZE_ALLOW` 加 `{ file, reason }`（理由 ≥20 字符；文件已无命中则条目过期、同样红）；条目可再给 `rule` + `count` 做**精确豁免**（只放行该文件里该规则恰好 `count` 处，多一处红、少一处算过期）。当前只有一条精确豁免：`server/db/index.js` 的 `pragma-optimize` × 1（AH3，见 2e）。边界：只扫静态文本——运行时拼接、`eval`、命令行里的 `sqlite3`、`package.json` / 工作流里的命令扫不到；本检查防"手滑写进代码"，不防有意绕过，运维手动 `ANALYZE` 仍按第 2 节处理。

## 2e. 大库快照、两份快照的差异与启动期 `optimize` 开关（AH3，ADR-0044 补充 7）

**第二份快照**：`docs/implementation/explain-plans.large.json`（同样 120 条语句）取自**大合成库**——`scripts/synth-data.mjs` 的 2 万 SKU / 5 万单据 / 25 万流水（夜间工作流的 `large` 规模，种子 20261023，生产模式），再灌 20 万 OMS 订单 + 每单一行明细（时间落在锚点前 60 天并随 id 递增，即 AF3 的"密集窗口"最坏情形；平台绑定两个组织，受限范围语句才有可测形态），库约 485 MB，不跑 `ANALYZE`。快照里另记 `scale: "large"`、`dataset.table_rows`（关键表行数）和 `differences`。

- **生成**（现造大库：Mac mini 整机负载 30–85 时 `synth-data` 实测 1226 s，空闲机器上的耗时未测）：`node scripts/explain-audit.mjs --snapshot docs/implementation/explain-plans.large.json --scale large`；已有大库时用 `--large-dir /abs/dir`（目录里要有 `gml_cosmetic.db`，只读打开，不改库）。`differences` 由与小库快照（`--small-snapshot`，缺省为已提交的那份）的比较生成，沿用同一对 hash 的旧说明；新出现的差异说明留空、命令退出码 1，等人写一句话再提交。
- **比较**：`--scale large --compare explain-plans.large.json [--large-dir d]` 比大库；`--compare small.json --compare-large large.json [--large-dir d]` 小库、大库各比一次再做两份快照的互查；`--compare small.json --cross-check large.json` 只做小库比较 + 互查（**不造大库**）。互查是纯文件检查：两份快照登记的语句必须相同；两份里 hash 不同的语句必须逐条登记在大库快照的 `differences` 里，绑定这一对 hash、说明 ≥20 字符；登记了但已无差异、重复、未知 id 都红。
- **哪里跑**：`ci.yml` 的"Query plan snapshot"一步用 `--compare … --cross-check …`（造的是 1.5 s 的小库，不造大库——大库在 CI 托管 runner 上要几十分钟，且 `checks` 作业本来就已 36–40 分钟）；大库比较在 `nightly-capacity.yml` 的"Large-database plan snapshot"一步：对 synth-pipeline 留下的库（`--large-dir "$CAP_RUN/data"`，默认 medium 规模）取一份**隔离的在线备份副本**，在副本里补灌 20 万 OMS 订单（`--fill-oms 200000`；原库只读，副本由工具自己删除；`large-ci` 规模磁盘放不下副本，跳过该步）。`--scale large` 会拒绝不够"大"的库（OMS 订单 < 10 万、流水 < 1 万或 SKU < 1000，退出码 2）——空 OMS 表上的绿灯什么都不证明（Codex 审计发现）。该步只告警不影响夜间闸门。

**小库与大库的计划差异（逐条）**：**没有任何语句不同**——120 条语句在小库与大库上的指纹逐条相同，`differences` 为空；大库上违规 0（裸 SCAN 30 条中 26 条是带理由的豁免、4 条在阈值之下）。这是对"无 `sqlite_stat1` 时计划与数据量无关"这一前提的**实测**（此前只是推断），也说明 AF3 的密集窗口退步是**读量**问题（窗口内订单数 × 明细索引探测），不是计划选择问题。若将来出现差异，在这一节每条一行：`<语句 id>`——一句话原因（并与大库快照的 `differences[].explanation` 逐字一致，`tests/explain-plan-large.test.mjs` 会核对）。

**`GML_SQLITE_OPTIMIZE_ON_BOOT`（默认关）**：设为 `1` / `true` 时，每个数据库在**第一次打开**时执行一次 SQLite 的优化 pragma（`server/db/index.js`，每库一行日志 `[sqlite-optimize-on-boot] cosmetic: done in … ms`）；`0` / `false` / 空为关；其它值启动失败（`SQLITE_OPTIMIZE_ON_BOOT_INVALID`）。执行失败只告警（`skipped`），不阻止启动。**开之前必须读下面这段**——它不是"无害的收尾"：

- 在没有统计的库上，这条 pragma 实际上会**对所有从未分析过的表各做一遍统计收集**（SQLite 自带分析行数上限，所以不是逐行全扫，但每张表每个索引都会取样）：开发机上对 485 MB 的大合成库实测约 3.1–3.7 s（Mac mini、整机负载 10–20、非目标主机），创建 `sqlite_stat1`（125 行）和 `sqlite_stat4`；启动时间随库大小增长，期间该库的连接池尚未入池。**关掉开关不会删除已经写进库里的统计**——要按下面的办法手动删。
- 统计收集**会改变计划**：同一份大库在跑过之后，120 条登记语句中 **23 条的指纹变了、18 处审计违规**。其中最要紧的：AI 平台分析（`ai.platform_analysis`）丢掉 `idx_oms_order_time`，变成 `SCAN pf` + 按平台走 `sqlite_autoindex_oms_orders_1` 的逐平台读取（密集窗口 30 天 p50 约 25 → 81 ms、p95 约 31 → 113 ms；90 天 p50 约 50 → 90 ms）；`dash.top_products` / `top_brands` / `top_dealers` 丢掉 `idx_so_order_date`；审计查看器若干语句计划也变了。其余热销 / 趋势 / 合计语句的延迟在噪声范围内没有可见变化。也就是说开它等于放弃 AG3 / AF3 的全部计划保证，且 `explain-audit --compare` 会因库里有 `sqlite_stat1` 直接拒绝。
- 所以：**默认关，保持关**。若确实要开（例如要评估统计信息版本），先在该库的**只读副本**上按第 2 节流程复跑审计与延迟，再决定；要回到"无统计"状态：`DROP TABLE sqlite_stat1`（和 `sqlite_stat4`，若存在）后重开连接。不要在多实例同时滚动重启时开启它（每个实例启动都会持写锁做一遍统计）。
- 源码扫描（2d）对这一个开关做了精确豁免：`server/db/index.js` 里恰好一处，别处出现、或此处出现第二处，扫描都会红。

## 3. 为什么这样写

`oms_orders.order_time` 的区间谓词依赖"没有统计信息"时的启发式（范围约束优先于等值前缀较短的索引）。这是已知的脆弱点，不是疏忽：把它写进审计（而不是靠 `INDEXED BY` 硬绑）是为了让索引缺失时语句仍可执行，只是慢。
