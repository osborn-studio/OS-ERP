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

---

# 补充 2（AC4，roadmap-v8）：`/channel`、`/recent` 剖析，explain-audit 登记，缓存命中率阈值依据

状态：开发实现，尚非产品上线验收｜数字见 `capacity-baseline.md` 的 AC4 一节（Mac mini + 合成 medium 库 + 2 万 OMS 单叠加 + 整机高负载，量级为准）

## 决定

### 1. 剖析结论与缓存范围
`/dashboard/channel`、`/recent` 接入 `createProfiler`（`label=dashboard.channel|recent`，响应体永远不含剖析数据）。合成 medium 库上**没有块 ≥ 50 ms**：`channel.offline` ≈ 4–5 ms（`idx_so_order_date`），`channel.online` ≈ 5–12 ms（2 万行 OMS 整表读取，`date(order_time)` 套函数无索引可用，**随订单量线性增长**），`recent` 四条合计 < 0.2 ms。

- **`/channel` 缓存**，键 `channel:<days>`（`Number(req.query.days || 90)` 的数值），与 AB2 同一套 `cachedRead`：路由器第一行已要求全局数据范围，响应只由库内容、日期、`days` 决定，不含用户 / 组织；任何写入、跨零点、TTL 到期都失效；32 键上限同样约束 `?days`。理由是线上分支的线性增长，而不是当前耗时。
- **`/recent` 不缓存**，只剖析（日志里 `cache=off`）：四条"按主键倒序取 8 条"的查询合计 < 0.2 ms，缓存的收益小于每次读取的版本校验；它是"最新动态"，任何写入都使缓存失效，命中率天然低。若生产数据量下块耗时 ≥ 50 ms，再按 `cachedRead` 推广（同一键规则）。

### 2. SQL 文本单一来源
新 `server/lib/dashboard-sql.js` 放 `/top`（四条）、`/inventory-dist`（一遍扫描的聚合）、`/channel`（两条）、`/recent`（四条）的 SQL 文本；路由与 `scripts/explain-audit.mjs` 同取。**为什么新建模块而不是从路由导出**：路由模块一导入就拉起 `getDb()` 等依赖，审计脚本是只读打开种子库的独立进程。AB2 的 `CROSS JOIN` / 单遍扫描语句因此不再有"路由改了、审计没跟上"的漂移面；`summary` / `trend` 的既有登记仍是人工镜像（未动）。

### 3. explain-audit 登记
11 条新语句（`dash.top_*` ×4、`dash.inventory_dist_agg`、`dash.channel_*` ×2、`dash.recent_*` ×4）。`expectIndex`：`/top` 四条与 `channel_offline` 为 `idx_so_order_date`——守的是 AB2 的 `CROSS JOIN` 决定：变异（改回普通 JOIN）使计划退回 `SCAN i` 并报红（本工作流做过）。豁免：`recent_*`（按主键倒序取页，`noSort` 前提由审计脚本继续检查）；`channel_online`（整表读取，谓词无法索引，理由写在 ALLOW 里）。`inventory_dist_agg` 是 `idx_stock_wh_sku` 上的索引全扫，不报红，只记录。

### 4. 缓存命中率告警阈值的依据
见 `docs/operations/monitoring.md`「缓存命中率告警阈值怎么来的」。要点：20% 与样本量条件是按模型选的，**不是生产标定**；模型用真实 `cachedForDb` + 注入时钟，并在测试里核对 AB10 计数器；命中率上限是 `floor(ttl/poll)/(floor(ttl/poll)+1)`，写入平均间隔短于一个轮询周期时降到 20% 以下。

## 测试
`tests/dashboard-perf.test.mjs` 的 AC4 用例（初版 6 个，Codex 审计后补到 9 个）：登记语句与模块导出逐字相同且路由不内联、`expectIndex`/豁免齐全；已迁移结构上登记语句 0 违规、`/top` 计划顺序、`expectIndex` 守卫真会检查；`/channel` 逐字对照原 SQL、`?days` 分键、写入失效、块计时齐全、响应无 cache / profile 字段；`/recent` 剖析且 `cache=off`、写入后立即可见；默认静默、受限账号 403 且不预热；命中率模型（单调、上限、20% 线位置、计数器核对、`ttl=0` 不计数）。

## 已知限制
- 数字来自 Mac mini + 合成库（OMS 单为叠加灌入），整机负载 27–35，不是 `dmserver` 结果；`/channel` 随 OMS 订单量越过 50 ms 的点是外推。
- `oms_orders.order_time` 无可用索引（`/channel` 线上与 `/trend` 线上共有的残余），根治需新迁移（给 `order_time` 建索引并把谓词改成区间），不在 AC4 范围。`dash.trend_*` 的登记仍是人工镜像且缺 `trend.online`。
- 压测副本上 `oc.overview_credit_used` 因演示种子叠加越过行数阈值而报违规，在 `batch-eleven` 上同样存在，与本补充无关，未处理。

## Codex 审计（AC4，`gpt-6.1-sol`，只读）
范围：`git diff batch-eleven...HEAD`；关注缓存正确性、explain-audit 语句保真、跨范围泄漏、新测试与命中率推导的弱点。
- **高：无。** 确认：范围闸门（`requireAuth, requireInternal, requireGlobalData`）在缓存之前；`channel` 的缓存值不含与调用者相关的内容；键含规范化的 `days`；登记的 SQL 与路由调用一致；`expectIndex` / ALLOW 条目有查询与结构支撑。
- **中 1（已修，文档 + 测试）**：命中率推导只看单键与写入，没有说明计数器是所有端点 / 键的合计，且命中率取决于每个键的读取间隔与 TTL——5 个键各 1 分钟读一次，30 分钟 150 次全未命中、零写入，会满足样本条件让告警一直亮；上限公式的 `floor(30/r)` 有边界效应（15 s → 2/3，16 s → 1/2）。→ `monitoring.md` 写明"命中率低不一定是写入密"、触发后的两步排查与处置、样本条件按聚合查找次数解释；新增测试 `AC4 hit ratio can be zero with no writes at all` 固定这些事实（含 150 次全未命中的多键用例）。
- **低 1（已修）**：保真测试只比较文本与导入，路由若调错构建函数 / 窗口仍绿。→ 新增 `AC4 route responses equal the results of the registered explain-audit statements`：HTTP 响应与登记语句在同一库上的执行结果逐项相等（`/top` 四条、`/channel` 两条、`/recent` 四条，默认窗口与登记一致）。仍不是"抓取路由实际 prepare 的 SQL"（路由在独立进程，没有注入点）——按行为而非文本比对。
- **低 2（已修）**：受限账号"不预热"只在已预热的键上测过。→ 新增 `AC4 a rejected caller on a cold /channel key …`：未用过的 `days=45` 被 403 / 401 后日志无处理器行，管理员第一次读该键仍是 `miss`。

---

# 补充 3（AD3，roadmap-v9）：`oms_orders.order_time` 索引（迁移 070）与 `/trend`、`/channel` 线上分支

状态：开发实现，尚非产品上线验收｜数字见 `capacity-baseline.md` 的 AD3 一节（Mac mini + 合成 20 万 OMS 单 + 整机高负载，量级为准）

## 决定

### 1. 索引：`idx_oms_order_time`，order_time 起头的**覆盖**索引
迁移 `070_oms_order_time_index.cjs`：`oms_orders(order_time, status, platform_id, pay_amount)`，非 UNIQUE、`IF NOT EXISTS`、表或列缺失则跳过，`INDEXES` 是 `up` 与 `verify` 的唯一来源。
**与 roadmap-v9 字面（单列 `oms_orders(order_time)`）的偏差，及理由**：先实测单列索引——每命中一行都要回表取 `status / platform_id / pay_amount`（随机读），窗口覆盖的行占比一高就比整表顺序扫描**更慢**（合成 20 万行、数据铺满 365 天时 `/trend` 90 天窗口约 69 → 88 ms；数据全在最近 60 天内时 30 天窗口 119 → 196 ms、90 天窗口 209 → 424 ms，即新建一家店、订单都在窗口里的最坏情形会退化 2–3×）。把两条看板查询读的列放进索引，计划变成 `SEARCH … USING COVERING INDEX idx_oms_order_time (order_time>?)`，各窗口、各数据分布都不比整表扫描慢（见 capacity-baseline）。代价：索引更大（20 万行 +9.5 MB，约 +19%；单列约 +5.6 MB）与略高的写放大。仍以 `order_time` 起头，`oms.js` 里 `o.order_time >= ?` 之类区间查询同样可用。若产品方更想要字面的单列索引，把 `INDEXES[0].cols` 与 `needs` 改回即可（测试里的 `COVERING` 断言随之改）。

### 2. SQL：加一个可走索引的区间谓词，**保留**旧谓词复核
旧：`date(order_time) >= date('now','localtime','-N day')`——对列套函数，无索引可用。
新：`order_time >= :lo AND date(order_time) >= :since`，绑定参数由 JS 按**本地日期**算出（`onlineWindow(days)` → `[lo, since]`）。
- `since` 与旧右端同值：`sinceDate()` 复刻 `date('now','localtime','-N day')`（先转本地钟面再减 N 天，无夏令时修正，与 SQLite 一致）；N 非有限数、为负（旧模板拼出 `'--N day'`，SQLite 返回 NULL，旧结果为空）、或超出 SQLite 儒略日范围时返回 `null`，绑定 NULL，结果为空，与旧行为相同。极远的过去按 SQLite 的 `-0712-11-25` 形式输出。
- `lo = since 前一天`：只用来缩小索引范围；宽一天是为了不漏掉带时区后缀的存量值（`2026-10-23T20:00:00-08:00` 的 `date()` 是 10-24，但文本小于 `'2026-10-24'`）。
- **保留 `date(order_time) >= since` 作复核**：索引选出的候选行再用原谓词过滤，所以结果与旧 SQL 逐行相同——包括脏值（`'not-a-date'`、`'null 00:00:00'` 文本序高于任何日期，但 `date()` 为 NULL，被复核剔除）。路线图写的"纯区间 `>= ? AND < ?`"没有采用：纯区间对脏值与时区后缀会改变结果，而且旧 SQL 没有上界（未来日期的订单也计入），加上界同样改变结果。
- 已知残余：文本序与日期前缀不一致的存量值（前导空白等）可能被 `lo` 挡掉而旧 SQL 会计入；应用自身写入的格式（`YYYY-MM-DD HH:MM:SS`，seed / OMS 同步 / H5 商城）不受影响。
- 缓存键 `trend:<days>` / `channel:<days>` 不变；跨零点由 `db-ttl-cache` 失效，所以 JS 日期与 SQLite `'now'` 之间的毫秒级竞态最多影响一次请求的窗口起点，且与改动前的"请求中途跨零点"同量级。

### 3. `/trend` SQL 搬进 `dashboard-sql.js`，`dash.trend_*` 不再是人工镜像
`trendSalesSql(days)` / `trendPurchaseSql(days)` 文本逐字未改（测试与旧文本逐字对照），`trendOnlineSql()` 为新语句；路由与 `scripts/explain-audit.mjs` 取同一份。explain-audit：`dash.trend_sales`（`idx_so_order_date`）、`dash.trend_purchase`（`idx_po_order_date`）、`dash.trend_online`（`idx_oms_order_time`）、`dash.channel_online`（`idx_oms_order_time`）都声明 `expectIndex`；**移除** `dash.channel_online` 的 ALLOW 豁免（`unusedAllow` 守卫保证不会残留）。登记语句带上与路由同形的绑定参数（`onlineWindow(30|90)`）。

### 4. 写放大
按 AA6 的方法（独立库交替、逐行自动提交的单行 INSERT）：见 capacity-baseline，量级为每笔订单多 25–40 µs，一次平台订单 / 商城下单落一行，可忽略；`scripts/bench-oms-order-time.mjs` 可重复。

## 测试（tests/dashboard-perf.test.mjs，`AD3` 前缀 8 个 + 既有 AC4 用例更新）
迁移（建索引、幂等、`verify()` 缺索引为假、表 / 列缺失跳过、runner 登记）；`sinceDate` 与 SQLite `date(?, 'localtime', '-N day')` 同一瞬间逐项相等（分数 / 负 / 非有限 / 超范围窗口，多个临近午夜的瞬间）并在 6 个进程时区（含半小时偏移、夏令时切换日、UTC+14）的子进程里复核；`onlineWindow`；新旧 SQL 在带边界的夹具上返回相同行（窗口起点当天 00:00:00 计入、前一天 23:59:59 不计、`T` 分隔、仅日期、时区后缀、脏文本、儒略日数字串、NULL、空串、未来日期、未知平台），变异（去掉 `date()` 复核）使之变红；`trend` sales / purchase 文本与旧文本相同；explain-audit 计划是 `COVERING INDEX idx_oms_order_time`、无 `SCAN oms_orders`、ALLOW 已删、删索引后守卫变红；HTTP 响应（`/trend`、`/channel`）与旧 SQL 逐项相等，路由里不再有内联的 `date(order_time) >=`。

## 已知限制
- 数字来自 Mac mini + 合成表，整机负载 30–45，不是 `dmserver` 结果；真实 OMS 订单的时间分布未知，覆盖索引的好处在"窗口覆盖多数行"时最大，在窗口很窄时二者接近。
- explain-audit 在 `ANALYZE` 过的库上可能选 `idx_oms_status` 的 skip-scan（应用从不跑 `ANALYZE`，`synth-data` 也刻意不跑）；若将来引入 `ANALYZE`，`expectIndex` 会报红，到时需重新评估。
- `oms.js` 的 `/stats` 等路由仍有 `date(order_time) >= …`（同样的整表读取），不在 AD3 范围；可复用 `onlineWindow()` 与同一索引另行改写。

## Codex 审计（AD3，`gpt-6.1-sol`，只读）
范围：`git diff batch-twelve...HEAD`；关注 SQL 等价（含时区边界）、迁移安全、explain-audit 保真。
- **高：无。** 确认：常规时区 / 夏令时 / 非法与超大窗口与 SQLite 一致；审计登记的 SQL 文本与路由默认工厂相同。
- **中 1（部分已修 / 部分登记为残余）**：区间谓词对 SQLite 能解析、但文本序低于 `lo` 的非规范值会改变结果——儒略日数字串（`'2.4613375e6'`、`'+2461337.5'`、`' 2461337.5'`）与日历溢出日期（`2026-02-31` 被 SQLite 规整为 03-03）。这些**不是应用写入的格式**（seed / OMS 同步 / H5 商城都写 `YYYY-MM-DD HH:MM:SS`），不修，写进上文"已知残余"并在夹具里保留儒略日数字串 `'2461000.5'`（落在窗口外，不影响等式）；要彻底消除只能放弃索引或先把存量规范化，不在 AD3 范围。已修的部分：时区后缀与脏文本由 `lo` 放宽一天 + `date()` 复核覆盖（夹具含这些值）。
- **中 2（已修）**：`expectIndex` 只检查计划里出现索引名，去掉区间谓词后计划退化成 `SCAN … USING COVERING INDEX`（覆盖索引全扫）仍然绿。→ explain-audit 新增 `expectSearch`：计划行必须是 `SEARCH … INDEX <idx> (约束)`；`dash.trend_sales / trend_purchase / trend_online / channel_online` 都声明；新测试用"只保留 `date()` 复核 + `INDEXED BY`"的变异语句验证守卫变红。
- **低 1（已修）**：小数天窗口的取整与 SQLite 不同（`TZ=UTC`、12:00:00Z、`days=0.500000001`：SQLite `2026-10-24`，JS `2026-10-23`）。→ `sinceDate` 按 SQLite 的毫秒取整（`trunc(N·86400000 + 0.5)`）减；测试加入边界窗口与子进程 UTC 瞬间，变异（去掉取整）使其变红。
- **低 2（已修）**：`verify()` 只查索引名，`CREATE INDEX idx_oms_order_time ON oms_orders(status)` 会绕过自愈。→ `verify()` 与 `up()` 改为核对所属表、有序键列、非 UNIQUE、非局部；名字被占但定义不对时 `up()` 先 `DROP` 再重建（这个名字归迁移 070 所有）；测试覆盖单列 / UNIQUE / 局部三种漂移。
- 审计提到的"登记语句的绑定参数在模块加载时取快照"：explain-audit 是一次性 CLI 进程，窗口日期只影响计划里的常量，不影响计划形态，未改。

# 补充 4（AE3，roadmap-v10）：OMS `/stats` 与 AI 平台分析改走 `idx_oms_order_time`

状态：开发实现，尚非产品上线验收｜数字见 `capacity-baseline.md` 的 AE3 一节（Mac mini + 合成 20 万 OMS 单 + 整机负载，量级为准）

## 决定
1. **SQL 搬进 `server/lib/oms-sql.js`**：`omsStatsByPlatformStmt / omsStatsTrendStmt / omsStatsTotalStmt / omsStatsTopSkusStmt(days, scope)`（`oms.js` GET `/stats`）与 `aiPlatformAnalysisStmt(days)`（`ai.js` `channel_compare` 线上分支）返回 `{ sql, params }`；路由与 `scripts/explain-audit.mjs` 取同一份。窗口参数**直接复用** `dashboard-sql.js` 的 `onlineWindow()`（不复制 `sinceDate` 逻辑），永远排在 params 最前（byPlatform 的窗口在 `LEFT JOIN … ON`，先于 WHERE 里的范围谓词）。范围谓词（`omsPlatformScopeSql` / `omsOrderScopeSql` 的输出）由调用方传入、原样拼接，语义不变。
2. **谓词**：`date(order_time) >= date('now','localtime','-N day')` → `order_time >= :lo AND date(order_time) >= :since`（AD3 同法，保留 `date()` 复核）。因此对应用自身写入的格式结果与旧 SQL 逐行相同；边界、时区后缀、脏文本、非法 / 超范围窗口的语义与补充 3 完全一致（含其"已知残余"）。
3. **explain-audit**：`oms.stats_trend`、`oms.stats_total`、`ai.platform_analysis` 声明 `expectIndex: idx_oms_order_time` + `expectSearch`（`SEARCH … COVERING INDEX idx_oms_order_time (order_time>?)`）。`oms.stats_by_platform`、`oms.stats_trend/total/by_platform_scoped`、`oms.stats_top_skus(_scoped)` 也登记（受限范围用 `orgIds: [1]`），但**不**声明索引：规划器对它们不走 `idx_oms_order_time`（见下），声明了就是假绿或常红。`oms.stats_top_skus` 与 `_scoped` 在 `oms_order_items`（增长表）上的 `SCAN i` 有 ALLOW 书面豁免。
4. **运维**：新增 `docs/operations/query-planner.md`——应用从不执行 `ANALYZE` / `PRAGMA optimize`；若将来引入，先复跑 explain-audit，再按文内顺序处置。

## 诚实边界（计划没有改变的语句）
- **byPlatform**：`platforms` 驱动，对每个平台按 `(platform_id, platform_order_no)` 自动索引取该平台全部订单；`order_time` 谓词只做过滤。要利用索引需改写成"先按 order_time 聚合再并入平台"的形态，那会改变浮点求和顺序，不能保证逐位相同，未做。
- **受限组织范围**：范围谓词是 `platform_id IN (子查询)`，规划器选 `platform_id` 等值索引，区间谓词只做过滤；前后延迟在噪声内相同。改写范围谓词会碰权限语义，不在 AE3 范围。
- **topSkus**：`oms_order_items` 驱动（`SCAN i` → 按主键取订单）；改成订单驱动（`CROSS JOIN`）同样会改变求和顺序。
- 最坏分布（窗口覆盖几乎全部行）下覆盖索引与扫描量级相当，个别 90 天窗口的 total / AI 平台分析的中位数在噪声范围内偏慢，见 capacity-baseline。

## 测试（tests/oms-sql.test.mjs，6 个）
新旧 SQL 等价（5 种范围 × 13 种窗口 × 4 条 `/stats` 语句，夹具含窗口边界、`T` 分隔、仅日期、时区后缀、脏文本、儒略日数字串、NULL、空串、未来日期、未知平台、无仓库平台）；AI 平台分析等价；绑定参数顺序与无效窗口绑定 NULL；变异（去掉 `date()` 复核）使结果改变；explain-audit 登记与路由同一份语句、`expectIndex` / `expectSearch`、无豁免、计划是覆盖索引范围 SEARCH、删索引后守卫变红；路由里不再内联 `date(order_time) >=`。

## Codex 审计（AE3，`gpt-6.1-sol`，只读）
范围：`git diff batch-thirteen...HEAD`；关注 SQL 等价（含边界）、范围谓词保留、explain-audit 保真。
- **高：无。** 确认：byPlatform 的窗口参数（在 `LEFT JOIN … ON`）排在范围参数之前，绑定顺序正确；受限范围谓词与别名原样保留；无效窗口绑定 NULL；零订单平台仍保留一行；三条全局 `expectIndex` / `expectSearch` 与观测计划一致，两条 top_skus 的 ALLOW 对应真实的明细表扫描；独立重跑审计 0 违规、0 过期豁免。
- **中（已按文档修正，不改行为）**：区间谓词对 SQLite `date()` 能解析、但文本序低于 `lo` 的非规范值会改变结果（如儒略日数字串 `'2.4613375e6'`）——即补充 3 已登记的残余，AE3 的五条语句继承；`oms-sql.js` 文件头原来写得像无条件等价。→ 文件头与上文"决定 2"改为"对应用自身写入的格式逐行相同，残余同补充 3"。
- **低（已修）**：bench 脚本只累积 `ae3.results_identical`，不一致时退出码仍为 0 且不指出是哪条。→ 记录 `ae3.mismatches`（`语句.范围.窗口`），不一致时 stderr 报出并以退出码 1 结束。


---

# 补充 5（AF3，roadmap-v11）：`/stats` 的平台维度、热销与受限范围语句改走时间索引（迁移 074）

状态：开发实现，尚非产品上线验收｜数字见 `capacity-baseline.md` 的 AF3 一节（Mac mini + 合成 20 万 OMS 单 + 每单一行明细 + 整机负载 12–25，量级为准）

## 背景
补充 4（AE3）留下三类没走 `idx_oms_order_time` 的 `/stats` 语句：`oms.stats_by_platform`（平台驱动，按 `(platform_id, platform_order_no)` 自动索引读该平台全部历史订单）、`oms.stats_top_skus`（`SCAN oms_order_items`，有书面 ALLOW 豁免）、以及所有"受限组织范围"形态（范围谓词 `platform_id IN (子查询)` 被规划器当成比 `order_time` 区间更有选择性的等值前缀，读该范围内全部历史订单）。读量都随历史订单线性增长。

## 决定
1. **byPlatform 改写为"窗口先行"**：`platforms LEFT JOIN (SELECT platform_id, … FROM oms_orders WHERE order_time >= ? AND date(order_time) >= ? GROUP BY +platform_id) w`，再在外层套 `ps.sql`。窗口参数仍在 params 最前（子查询先于外层 WHERE）。`GROUP BY +platform_id` 的一元加号是必须的：裸列会让规划器为"按平台分组"改走平台自动索引整表扫描。行序：旧写法同 gmv 时按 `pf.id` 升序（隐含），现把 `pf.id` 写进 `ORDER BY` 成为显式契约。无订单的平台仍出一行（`COALESCE` 成 0）。
2. **受限范围谓词包 `likely()`**（trend / total / topSkus）：语义恒等，只改规划器的选择，让它走 `idx_oms_order_time` 的范围 SEARCH 而不是 `platform_id` 等值。**未**改 `omsPlatformScopeSql` / `omsOrderScopeSql`（权限语义不动）。
3. **迁移 074 `idx_oms_items_order ON oms_order_items(oms_order_id)`**：`oms_order_items.oms_order_id` 此前没有任何索引（连外键级联删除都要扫明细表）。topSkus 的 SQL **文本不变**，计划由"SCAN 明细表 + 按主键取订单"变成"订单窗口（覆盖索引范围 SEARCH）→ 按订单号取明细"。`oms.stats_top_skus` 与 `_scoped` 的 ALLOW 豁免已删除。
4. **explain-audit**：九条 `oms.stats_*` / `ai.platform_analysis` 全部声明 `expectIndex: idx_oms_order_time` + `expectSearch`，没有任何 `oms.*` 豁免。审计器新增一条规则：计划里 `MATERIALIZE x` / `CO-ROUTINE x` 声明的派生表上的"自动索引"不算缺真实索引（派生表就是每次现算的聚合；派生表内部对真实表的读取仍是独立计划行，照常判定——`tests/explain-audit.test.mjs` 有对照用例，真实表上的自动索引仍违规）。
5. **等价口径变化（诚实边界）**：整数 / 文本 / 行序与旧 SQL 逐项相同；**浮点列的累加顺序随计划变化**（旧：平台自动索引或明细 rowid 顺序；新：order_time 索引顺序），SQLite 虽用补偿求和，仍可能差最后一位。因此测试对浮点列按相对 1e-9 比较，另用"金额均为二进制可精确表示的值"的夹具证明分组 / 过滤 / 行序结构上逐位相同；20 万行基准 `af3.max_rel_diff = 0`（本数据上没有观察到任何差异）。AE3 补充 4 里"改写会改变求和顺序故未做"的理由由此被取代：差异量级远低于金额分位，且已声明。

## 备选评估（20 万合成单，同机轮转计时，ms，p50 / p95，数据时间随 id 递增 + ±6h 抖动、跨 365 天）
| 语句 | AE3 现状 | (a) 只改写 | (b) 只加 `(platform_id, order_time, status, pay_amount)` | 已发布 = (a) + 074 |
|---|---|---|---|---|
| byPlatform 全局 30 / 90 天 | 89 / 219；88 / 113 | 5.2 / 13；19 / 33 | 2.6 / 19；11.6 / 19 | 6.3 / 20；18 / 29 |
| byPlatform 受限 30 / 90 天 | 33 / 47；39 / 49 | 4.3 / 11；19 / 30 | 1.1 / 4；5.3 / 14 | 7.2 / 10；19 / 38 |
| topSkus 全局 30 / 90 天 | 31 / 47；37 / 49 | 27 / 56；39 / 53（仍 SCAN 明细表） | 28 / 51；35 / 48（仍 SCAN 明细表） | 13 / 22；39 / 49 |
| topSkus 受限 30 / 90 天 | 24 / 32；39 / 75 | 23 / 34；41 / 63 | 25 / 35；41 / 77 | 6.7 / 12；24 / 50 |
| trend / total 受限 30 / 90 天 | 31–44 / 42–99 | 2–10 / 4–34 | 0.8–5.7 / 2–11 | 2–10 / 5–34 |

**选择 (a) + 074，不选 (b)**：
- (b) 的 p95 在 byPlatform / 受限形态上确实更低（byPlatform 90 天受限 14 vs 30–38 ms），但与 (a) 的差只有个位数到十几毫秒，而 (a) 已把这些语句的 p95 压到 ≤ 40 ms（原 47–219 ms）；(b) 要给热写表 `oms_orders` 再加一棵 9.5 MB 的 B 树，实测每单写入 CPU +23%（99.9 → 122.8 µs/单，约 +23 µs），与 074 叠加合计 +32%（`items_b` 132.3 µs；基线已含 070）。
- (b) **单独解决不了 topSkus**（上表第三行：仍 `SCAN oms_order_items`），所以无论选 (a) 还是 (b) 都需要 074 的明细索引——(b) 只是在此之上再多一棵。
- (b) 的真实价值是密集窗口的最坏情形（数据全在近 60 天，受限范围 90 天 byPlatform：(a) 67–75 ms vs (b) 17 ms，AE3 现状 45 ms）。这是已知回退，见下"已知限制"。**取舍是判断题**：若评审更看重受限账号的最坏情形而接受写放大，可改发布 (b)（一个迁移的差别，基准脚本已含 B 状态的完整数据）。
- 明细索引选单列而非覆盖 `(oms_order_id, title, qty, amount)`：覆盖版读快约 20%（topSkus 90 天 28.8 vs 36.2 ms CPU），索引体积 2.4 → 6.0 MB（合成标题仅 7 字符，真实标题更长则差距更大），写入 CPU 在噪声内相同（+3% vs +7%）；单列版已在 30 天窗口快 2×，选更小的。

## 写放大与体积（独立库、逐单自动提交；一单 = 1 行 `oms_orders` + 2 行 `oms_order_items`；5 轮交替，CPU µs/单，中位数）
基线（070 only）99.9；+074 单列 106.8（**+7%**，约 +7 µs/单，约 +3.5 µs/明细行）；+074 覆盖 103.0（+3%）；+(b) 122.8（+23%）；+074+(b) 132.3（+32%）。索引体积：074 单列 +2.36 MB（20 万明细行）、覆盖 +5.99 MB、(b) +9.48 MB。`CREATE INDEX` 20 万明细行 29–76 ms（持写锁）。

## 已知限制
- **密集窗口回退**（数据全在最近 60 天，即窗口覆盖几乎全部行）：topSkus 全局 30 / 90 天由约 55 / 93 ms 升到 89 / 186 ms，受限 90 天 53 → 78 ms；byPlatform 受限 90 天 45 → 67 ms。原因：订单窗口驱动要对窗口内每个订单做一次明细索引探测（随机读），窗口覆盖多数行时比顺序扫描 + 主键查找慢约 2×。换来的是读量随**窗口内订单数**而不是**全部历史订单数**增长：跨 3 年历史的同量级库（随机序，CPU 时间）topSkus 30 天窗口 5.8 vs 19 ms；这与 AD3（070）"覆盖索引在最坏分布与扫描持平，窄窗口快数倍"同类取舍，但本处最坏情形是 ~2× 的回退，不是持平。
- 基准默认的订单时间与 id 无关（对窗口驱动的索引计划偏不利，局部性差）；`--ordered` 为时间随 id 递增，更接近真实落库。随机序的 365 天分布下 topSkus 全局 90 天为 49 vs 30 ms（回退 1.6×）。
- 浮点累加顺序见决定 5；`likely()` 与 `GROUP BY +platform_id` 是对无统计信息启发式的依赖，运维手册 `docs/operations/query-planner.md` 第 2a 节已写明；有了统计信息后由 explain-audit 报红。
- 没有 `dmserver` / 生产规模副本的数字；整机负载 12–25，只看量级。

## 测试（tests/oms-sql.test.mjs 共 11 个，其中 AF3 新增 5 个、改写 1 个；tests/explain-audit.test.mjs 新增 1 个）
新旧 SQL 等价（5 种范围 × 13 种窗口，浮点列相对 1e-9）；二进制精确金额下逐位相同；4000 单随机两位小数金额下的容差等价；byPlatform 无订单平台 / 平局按 pf.id / 无效窗口；迁移 074 的 up / verify（同名异定义、UNIQUE、局部、表或列缺失）；explain-audit 九条全部带约束 SEARCH、无裸 SCAN、无豁免，topSkus 经 `idx_oms_items_order` 取明细，删 074 / 070 索引后守卫变红（变异）；去掉 `likely()` 或 `+` 后审计用例变红（手工变异，已验证）；受限范围参数绑定顺序与范围外平台不计入；审计器的派生表规则对照用例。

## Codex 审计（AF3，`gpt-6.1-sol`，只读，防御性审查）
范围：`git diff batch-fourteen...HEAD`；关注 SQL 等价、范围谓词保留、迁移安全、explain-audit 保真。
- **高：无。** 确认：byPlatform 的零订单平台保留、无效窗口得零聚合、NULL 金额的 SUM/COALESCE 行为不变、状态分支不变、参数仍窗口在前；`likely(NULL)` 仍为 NULL、`likely(1=0)` 仍为假；受限范围没有平台能逃出范围被计数；`pf.id` 平局规则使行序确定；审阅者另跑 16 组 byPlatform 对 `batch-fourteen` 的比较（含 NULL 金额 / 窗口 / 假与 NULL 范围）通过。浮点累加顺序对"几乎平局"的合计仍可能有影响（决定 5 已声明）。
- **中（已修）**：派生表规则按别名全计划豁免——另一 UNION 分支里同名的真实表别名（`LEFT JOIN fact w`）的自动索引会被放过。→ 只有别名在 SQL 里**不是**真实表别名时才豁免；新增对照用例（`tests/explain-audit.test.mjs`）。
- **中（已修）**：迁移 074 对"同名但定义不对"的索引一律 DROP，若该名字挂在**别的表**上（如别处的唯一索引）会悄悄丢约束。→ 同名索引挂在别的表上时抛错且不删；新增用例。迁移 070 的 `up()` 有同样的行为，属已执行迁移（ADR-0009），不改，记入此处。
- **中（已修）**：`expectSearch` 只要计划里任一处有该索引的约束 SEARCH 就通过，不相干的子查询 SEARCH 可以替主聚合的整条索引扫描"担保"（既有检查器局限，现被九条语句依赖）。→ 计划里只要还有对该索引的整条 `SCAN … USING … INDEX <idx>` 就判不满足；新增用例；合成库上审计仍 0 违规。
- **低（已修）**：变异断言偏弱（`size >= 8`、两条 topSkus 合并判）。→ 改为断言确切的违规语句集合。
- 未验证（审阅者与本人一致）：生产规模下 `CREATE INDEX` 的持写锁时长；`dmserver` 上的计划与延迟。


---

# 补充 6（AG3，roadmap-v12）：查询计划指纹快照与 ANALYZE 源码守卫

状态：开发实现，尚非产品上线验收｜纯测试 / CI 工具，不改应用行为、不加迁移

## 背景
AF3 选定的方案（改写 + 迁移 074）靠 `expectIndex` / `expectSearch` 守护，但它们只证明"用了某个索引"：不带这类断言的语句（如 `stock.txn_by_wh_sku_batch` 依赖 `idx_it_wh`）丢索引时不会红；`ANALYZE` 不执行只是文档约定（`docs/operations/query-planner.md`），没有机器守卫。

## 决定
1. **计划指纹**：`explain-audit --snapshot <file>` 为每条登记语句写 `EXPLAIN QUERY PLAN` 的归一化文本（去字面量 / 参数标记 / 比较符后的数值常量 / 子计划编号，保留表名、虚表策略数字、索引名、SCAN/SEARCH、COVERING、临时 B-tree、嵌套缩进）和 16 位 hash，同时记迁移号、SQLite 版本、生成命令。归一化与比较在 `scripts/lib/explain-plan-guard.mjs`，`auditStatements` 只多输出每行的嵌套深度。
2. **`--compare <file>`**：按语句 id 比较，`changed` / `added` / `removed` 都算漂移，打印前后计划行，退出码 1。库里有 `sqlite_stat1` 时拒绝比较。迁移号 / SQLite 版本不同只作提示（note），不单独判红。
3. **白名单** = `{ statement, accepted_hash, reason }`：绑定被接受的**那一个**新指纹（删除用 `"removed"`），理由 ≥20 字符；语句无漂移时条目过期同样红，指向未知语句 / 无理由 / hash 格式错误直接报错。重取快照清空白名单，所以白名单只是 PR 内的临时放行。
4. **与数据无关**：应用不跑 ANALYZE，计划由固定启发式决定，所以快照取自默认小合成库（`synth-data` 默认 60 SKU / 600 流水 / 120 单，种子 20261023，生产模式），CI 用同一条命令造库再 `--compare`；测试另断言"空的已迁移库"得到同一份指纹。
5. **CI**：`ci.yml` `checks` 作业只加一步"Query plan snapshot"（造库 + `--compare`）。
6. **ANALYZE 源码扫描**（`scripts/lib/analyze-scan.mjs`，随 `--compare` 运行，也可 `--analyze-scan` 单跑）：扫 `server/`、`scripts/` 的非测试源码，字符串 / 模板字面量（含 `${}` 内代码）里的独立 `ANALYZE`、`PRAGMA optimize`、`pragma('optimize')` 红；注释、标识符、路径不算；`.sql` 去注释后匹配。豁免表 `ANALYZE_ALLOW`（文件级，理由 ≥20 字符，过期红），当前为空。不扫 `src/`（前端文案可能含 "Analyze"，前端不碰数据库）。

## 已知限制
- 静态文本检查：运行时拼接、`eval`、命令行 `sqlite3`、`package.json` / 工作流命令扫不到；防手滑不防有意。
- 词法扫描是启发式（正则字面量 / 除号的区分），极端写法可能错位；当前仓库干净，且有测试覆盖常见形态。
- 指纹证明的是"夹具上的计划形状没变"，不是生产规模延迟；SQLite 升级会让措辞变化导致整批 hash 变，需确认后重取快照。
- 受 `GROWTH_TABLES` / 行数阈值影响的是**违规判定**，不是指纹；指纹对数据量不敏感依赖"无 sqlite_stat1"这一前提（比较时强制检查）。

## 测试（tests/explain-plan-guard.test.mjs，16 个）
归一化（字面量 / 参数 / 编号 / 带数字的标识符）；指纹确定性、与绑定值和数据量无关、保留嵌套；快照形状；删索引 → 红；added / removed；白名单绑定新 hash、后续另一个计划不被放行；无理由 / 未知语句 / 坏 hash 报错、过期条目红；`sqlite_stat1` 拒绝；版本 / 迁移提示；已提交快照与当前代码在空库上一致；扫描（字符串 / 模板 / `pragma()` / 注释 / 标识符 / 正则字面量 / `.sql` / 行号 / 目录跳过 / 豁免理由与过期）；本仓库当前无命中；CLI 端到端（`--snapshot`、`--compare` 绿、漂移红、白名单绿、删索引红、违规时拒绝写快照）。

## Codex 审计（AG3，`gpt-6.1-sol`，只读，防御性审查）
范围：未提交的 AG3 改动；关注指纹归一化稳定性、白名单滥用、CI 可复现、扫描器漏报。
- **高：无。** 确认：同一 schema 下指纹与数据内容无关；白名单缺理由 / 单条错绑 / 过期均被拒；快照步骤的库目录全新、种子 / 日期 / 时区固定、依赖锁定，未发现 CI 路径或环境缺陷。
- **中（已修）**：扫描器对 `ANALYZE/* … */`、`PRAGMA main.optimize`、`PRAGMA/* … */optimize`、`pragma('main.optimize')` 漏报。→ 字符串内先把 SQL 注释换成同长度空格，PRAGMA 名允许 schema 限定；新增用例。
- **中（已修）**：`if (ok) /it's/.test(s); db.exec('ANALYZE')`：`)` 后的 `/` 被当成除号，正则里的引号错位，吞掉后面的 SQL 字符串。→ 记录每个 `(` 是否属于 if / while / for / with 条件，其 `)` 之后的 `/` 当正则；新增用例（含 `(a + b) / 2` 仍是除号）。
- **中（已修）**：把所有独立数字替换成 `#` 会抹掉虚表策略（FTS 升序 `INDEX 64:M1` 与降序 `192:M1` 同一 hash）。→ 只替换子计划编号（SUBQUERY / MATERIALIZE / CO-ROUTINE）和比较运算符后的数值常量；重取快照；新增用例。
- **中（已修）**：已提交快照测试要求 `drifts` 为空，白名单放行的漂移会让 `--compare` 绿、聚焦测试红。→ 只断言没有**未放行**的漂移且 `ok`。
- **低（已修）**：同一语句的重复白名单条目只匹配第一条，第二条错绑条目逃过过期检查。→ 重复直接报错；新增用例。
- 记录而未改：指纹按 SQLite 版本取，升级后措辞变化会整批变 hash（SQLite 不承诺 EQP 输出稳定），已在文档写明"确认只是措辞后重取快照"。
- 未验证：托管 CI 上该步骤的实际运行；Linux 上 better-sqlite3 内置 SQLite 与本机 3.49.2 是否同版本（lockfile 固定同一 better-sqlite3，预期一致）。
