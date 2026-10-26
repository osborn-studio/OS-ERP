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

---

# 补充（AB2，roadmap-v7）：其余四个看板接口的剖析、缓存与多进程失效

状态：开发实现，尚非产品上线验收｜数字见 `capacity-baseline.md` 的 AB2 一节（Mac mini + 合成 medium 库 + 整机高负载，量级为准）

## 决定

### 1. 剖析与热点块
`/dashboard/trend`、`/top`、`/todos`、`/inventory-dist` 与 summary 一样接入 `createProfiler`（`GML_PROFILE=1` 才写一行 `profile_blocks`，`label=dashboard.<接口>`、`cache=hit|miss`；响应体永远不含）。**≥ 50 ms 的块**（medium 库，串行，负载下）：

| 块 | 原耗时（中位数，约） | 处理 |
|---|---|---|
| `top.products` / `top.brands` | 84 / 83 ms（负载约 20）；同进程同时测 55 / 29 ms | 改写：`FROM sales_orders so CROSS JOIN sales_order_items i ON i.order_id=so.id`，固定"先按 `idx_so_order_date` 取窗口内订单、再按 `idx_soi_order` 取明细"（原写法先全表扫 5 万行明细再回查订单）→ 同进程同时测 21 / 12 ms；结果逐行相同 |
| `inventory-dist.byWarehouse` / `byCategory` | 100 / 114 ms（负载约 20）| 改写：两条语句各扫一遍 8.5 万行宽表（前者逐仓回表，后者每行三次主键回查）→ **一条语句、一遍扫描**按 (仓库, 品类) 聚合，再在内存折成两张表。同进程同时测两条合计 218 → 146 ms（负载约 40）。**仍是 ≥ 50 ms 的块**（扫宽表的下限），靠缓存挪出请求路径 |
| `todos.stockAlerts`（`listBelowSafe(10)`）| 9–16 ms | < 50 ms，不动 |
| `trend.*`、`top.dealers/stores`、`todos` 其余块 | < 5 ms | 不动 |

**没做的**：迁移 / 新索引（`inventory_stocks` 是写入最热的表，覆盖 `(warehouse_id, qty_on_hand, cost_price)` 的索引与 AA5 同理不值；迁移号保持空置）；`byCategory` 按 SKU 预聚合（试过，无收益）。

**语义差异（有意、逐条）**：① `byWarehouse` 并列金额按仓库 id 排（原先并列顺序未定义）；② 金额 / 数量是"先分组再相加"，浮点求和顺序与原写法不同，最后一位可能不同（测试按 4 位小数比对）；③ 其余结果集与原写法逐行相同（`tests/dashboard-perf.test.mjs` 用 batch-ten 的原 SQL 在含取消 / 草稿 / 窗口外订单、无品牌商品、空仓、并列金额、负库存的夹具上比对）。

### 2. 缓存推广到四个接口（范围判断）
- **整个路由器**第一行就是 `r.use(requireAuth, requireInternal('总部经营看板'), requireGlobalData('总部经营看板'))`：能走到任何处理器的调用者都是全局数据范围的内部账号，**这四个接口的响应与调用者无关**，所以不需要按范围分桶；受限账号（`data_scope=org/dealer/none`）在进入处理器之前就 403（`GLOBAL_DATA_FORBIDDEN`），既读不到也**不会预热**缓存（测试：管理员预热后受限账号仍 403，且服务端没有产生任何新的 profile 行 = 没有进入处理器 / 缓存）。
- **键** = 接口名 + 规范化后的 `days`（`Number(req.query.days || 30)` 的数值，如 `trend:30`、`top:7`），不含用户 / 组织。`days` 由调用者控制，所以 `db-ttl-cache` 加了**键数上限**：每个连接最多 32 个键，超出淘汰最久未用，防止循环请求不同 `days` 撑爆内存。
- `db-ttl-cache` 的失效判据（TTL、`total_changes()`、`data_version`、本地日期）对所有键一视同仁；任何写入使该连接上**全部**键失效。`cachedForDb(db, compute, { key })` 的旧调用方式（不传 key）行为不变；新增 `cacheKeyCount(db)`（测试 / 诊断）。`invalidateForDb(db)` 清空全部键。
- **不缓存**：`/channel`、`/recent`（本批未剖析，不在范围；`recent` 是"最新 8 条"，命中率低且对新鲜度敏感）。
- 若将来给这些接口加入依赖调用者的字段（例如按组织的看板），必须把范围放进键，或不缓存并在此记录理由；仅放开 `requireGlobalData` 而不动缓存是**错误**的。

### 3. 两个进程的失效测试
`tests/dashboard-perf.test.mjs`：进程 A（被测，`GML_PROFILE=1`）与进程 B（第二个真实 `server/index.js`，同一 `GML_DATA_DIR`、另一个随机端口）共享同一个库文件。A 预热四个接口（第二次读为 `cache=hit`）→ B 经 HTTP 新建仓库 → A 的 `/inventory-dist` 立刻出现新仓库，且四个接口都是 `cache=miss`；再由第三个独立 `node` 进程直接用 SQL 写入一张已确认的今日订单（含明细）和一张最早的已确认订单 → A 的 `/trend`、`/top`、`/todos` 立刻反映；写入后的重复读重新命中。证明跨进程失效靠 `PRAGMA data_version`（A 自己没有任何写入，`total_changes()` 不变）。

## 测试
- 键控缓存单元：不同键各自命中、其它连接写入使全部键失效、`invalidateForDb` 清空全部、键数有上限且保留最近使用、计算抛错不留键。
- 四个接口：默认静默；`GML_PROFILE=1` 每个接口一行（块名齐全）、第二次读命中、读不使缓存失效、`?days` 分键（7 与 30 互不命中，默认 30 = 显式 30）、响应体无 cache / profile 字段。
- 范围：管理员预热后受限账号四个接口全 403、匿名 401、不进入处理器。
- SQL 改写：与原 SQL 逐行比对（见上）。
- 两进程失效（见上）。

## 已知限制
- 数字来自 Mac mini + 合成库（整机负载 35–48），不是 `dmserver` 结果；`inventory-dist` 冷路径（缓存未命中）在并发 4 下 p95 仍约 1 s（单线程 Node 串行执行同步查询，处理器本身 ≥ 100 ms），目标是靠缓存命中，写入频繁的实例命中率低。
- `scripts/explain-audit.mjs` 只镜像 trend 的两条语句；`/top`、`/inventory-dist` 的新语句**没有登记**（不在本工作流文件范围），其中库存聚合是已知的整表聚合。
- 缓存仍是每进程一份；多进程部署靠 `data_version` 感知其它进程的提交（本补充已用真实第二进程验证）。

## Codex 审计（AB2，`gpt-6.1-sol`，只读）
范围：`git diff batch-ten...HEAD` 的 `dashboard.js` / `db-ttl-cache.js` / 测试；关注陈旧缓存、跨范围泄漏、改写 SQL 的正确性、`days` 导致的内存、测试弱点。
- **高 / 中：无。** 确认：七个看板路由都先经 `requireGlobalData`（只有一处挂载、无绕过）；各接口键与规范化 `days` 互不冲突，32 键上限防止键无限增长；未发现写入失效 / TTL / 跨零点 / `data_version` 的缺口；`CROSS JOIN` 保留全部连接谓词；用内存库对"空仓、缺失 SKU / 商品、悬空品类、孤立仓库 id、NULL 成本、负库存"做的探针显示库存折叠与原 SQL 一致。
- **低 1（已修）**：`/top` 等价性夹具叠加在演示种子上，`LIMIT 10` 可能把新增的"无品牌 / 并列"商品挤出榜外。→ 夹具先清空演示销售单，并断言榜单恰为 4 个商品、两个品牌（含"未标品牌"）、2 个经销商、1 个门店。
- **低 2（已修）**：测试在 HTTP 响应后立即读子进程 stdout 里的 profile 行，二者无先后保证。→ 改为 `waitProfile`（轮询到期望条数，最多 5 s）；负向断言（受限账号不产生新行）保留固定等待。
- 审计未跑全套测试（只读沙箱）；变异检查由本工作流自己做：去掉 `data_version` 后键控缓存单元与两进程用例变红。
