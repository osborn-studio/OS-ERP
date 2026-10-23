# ADR-0044：低库存口径统一与看板热点块（AA5）

状态：开发实现，尚非产品上线验收｜相关：ADR-0038（库存范围）、Z3（迁移 061、`countBelowSafe` / `listBelowSafe`）、`docs/implementation/capacity-baseline.md` 的 AA5 一节

## 背景

1. Z3 把看板与预警页的低库存收到 `lib/stock.js`，但还有三处各写各的：指标注册表 `below_safe`（`lib/metrics.js`）、AI `stock_alert`（`routes/ai.js`）、MCP `inventory.stock_alert`（`mcp/tools.js`）。四处口径不同（是否只算 active、无库存行的 SKU 算不算、并列顺序、范围依据），同一时刻在不同入口看到不同的"缺货数"。
2. Z3 之后合成 medium 库上 `GET /dashboard/summary` 的 p95 仍约 400–800 ms（`bench-api` 并发 4），原因当时没找到。

## 决定

### 1. 低库存只有一份口径
`metrics.js` / `ai.js` / `tools.js` 全部改调 `countBelowSafe` / `listBelowSafe`（`lib/stock.js`）。**口径差异（有意为之，逐条列出）**：

| 入口 | 原写法 | 统一后 | 影响 |
|---|---|---|---|
| 指标 `below_safe` | 不看 SKU 状态 | 只算 `status='active'` | 停用 SKU 不再计入；与看板数字一致 |
| AI `stock_alert` | 内连接 products；按缺口降序，并列未定义；无 LIMIT | 同字段（去掉 `sku_id`）、同排序，并列按 sku id；`LIMIT -1`（不限） | 行集合相同；并列顺序变确定 |
| MCP `inventory.stock_alert` | 只含**有库存行**的 SKU；不看状态；按**货主组织**过滤；LIMIT 100 | 只算 active；按**仓库所属组织**累计（`ctx.scope`）；LIMIT 100；输出仍是五个键。**全局范围**含无库存行的缺货 SKU；**受限范围**只列范围内至少有一行库存的 SKU（`listBelowSafe(..., { visibleOnly: true })`） | 全局：无库存的缺货 SKU 现在会出现（原先是漏报）；受限令牌只累计其范围内仓库的库存，范围外令牌得到空清单（`tests/mcp-tool-matrix.test.mjs` 的 scope_excluded 状态要求这一点），不会把全部缺货 SKU 当成"0 库存"列出；空范围返回空而不是全库 |

MCP 的范围依据从 `owner_org_id` 改为仓库所属组织，是 ADR-0038 的统一判据（AA2 对其余库存工具做同样处理）；本工作流只动低库存这一处。

### 2. 看板分段计时器（临时、默认关闭）
`server/lib/profile.js`：`GML_PROFILE=1`（精确值）时，`GET /dashboard/summary` 每块的耗时与是否命中缓存写成一行 `profile_blocks` 日志；**不进响应体**；关闭时 `time()` 直接调用回调，不取时钟、不写日志。测试证明默认静默、开启后响应键不变。

### 3. 热点块与修复
在合成 medium 库（增强版，80% SKU 设安全库存）上逐块计时，**≥50 ms 的只有一个：`inventory`**（`SUM(qty)`、`SUM(qty*cost)`、`COUNT(DISTINCT sku_id)` 同一条语句）。`COUNT(DISTINCT sku_id)` 让 SQLite 在扫整张宽表的同时建临时 B 树。其余块都在 10 ms 以内（`below_safe` ≈ 8、`lastMonth` ≈ 4、`receivable` ≈ 3）。

- **改写，不加索引**：拆成"整表求和"（仍是已豁免的整表聚合）+ `SELECT COUNT(*) FROM (SELECT DISTINCT sku_id FROM inventory_stocks WHERE sku_id IS NOT NULL)`（走 `idx_stock_sku` 覆盖索引，无临时树）。`sku_id` 为 `NOT NULL`，结果与原语句相同（medium 库 19 917 = 19 917）。约 142 → 39 ms（单次，机器有负载，量级为准）。
- **迁移 064：不需要**。试过覆盖索引 `(sku_id, qty_on_hand, cost_price)`：求和部分 83 → 24 ms，但 `inventory_stocks` 是写入最热的表（059 / 061 起已有 7 棵索引），再加一棵的写放大不值得；且 30 s 缓存已把整表聚合挪出请求路径。EXPLAIN 证据与 `explain-audit`（66 条语句、0 违规）记录在 capacity-baseline。路线图里"迁移 064（如需）"这一格保持空置。
- **30 s 进程内缓存**（`server/lib/db-ttl-cache.js`），只用于总部看板汇总：
  - **范围安全**：该路由本身要求 `requireInternal` + `requireGlobalData`，响应与调用者无关；缓存挂在 `WeakMap<数据库连接>` 上（每个行业库一个连接），不同行业库不串；缓存值里没有用户 / 组织字段。
  - **失效（显式、保守）**：命中必须同时满足 ① 距写入 ≤ TTL（默认 30 s，`GML_DASHBOARD_CACHE_MS`，0 = 关闭）；② `SELECT total_changes()` 未变（本连接任何写入，含触发器与已回滚的）；③ `PRAGMA data_version` 未变（其它连接 / 进程提交过）；④ 本地日期未变（"今日 / 本月"跨零点必须重算）。这是"相关写入"的**超集**：不靠每个写路由手工调用失效，所以新增写路径不会让看板读到旧数据。
  - **代价**：写入频繁的实例命中率低（行为退回到每次计算，没有更坏）；每次请求多两次极便宜的读（`total_changes()`、`data_version`）。缓存只在 `GET /summary`；`/trend`、`/top`、`/todos` 等未缓存。
  - **未选的方案**：预聚合表（每次库存写入要同步维护，侵入所有写路径）；按表手工失效（漏一个写路径就读到旧数据）。

## 测试（tests/dashboard-perf.test.mjs）
三处旧 SQL 与新口径逐行比较（夹具含无库存、多仓、非活动、安全库存 0、并列、负库存）并断言每条已知差异；指标 `exclusions` 文案；计时器默认关 / 精确值才开 / 只进日志；缓存单元（命中、本连接写、他连接写、回滚、TTL、跨零点、隔离、关闭、环境变量、失败不缓存）；HTTP 级"另一连接改库存后看板立即变化"且第二次读为命中（证明请求自身不使缓存失效）。变异检查：去掉 `data_version` 后缓存与 HTTP 用例变红。

## 已知限制
- 汇总只由库内容与本地日期决定；如果将来加入依赖其它状态（如当前用户、系统设置缓存）的字段，必须同步改缓存键或去掉缓存。
- 数字来自 Mac mini + 合成库，不是 `dmserver` 结果；冷（未命中）路径在并发 4 下 p95 仍约 400 ms，是单线程 Node 串行执行同步查询的排队效应，目标 p95 < 150 ms 依赖缓存命中。
- `total_changes()` 在 `better-sqlite3` 多线程（worker）使用同一文件时只统计本连接；跨线程 / 进程靠 `data_version`。
