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
2. **谓词**：`date(order_time) >= date('now','localtime','-N day')` → `order_time >= :lo AND date(order_time) >= :since`（AD3 同法，保留 `date()` 复核）。因此结果与旧 SQL 逐行相同，边界、时区后缀、脏文本、非法 / 超范围窗口的语义与补充 3 完全一致（含其"已知残余"）。
3. **explain-audit**：`oms.stats_trend`、`oms.stats_total`、`ai.platform_analysis` 声明 `expectIndex: idx_oms_order_time` + `expectSearch`（`SEARCH … COVERING INDEX idx_oms_order_time (order_time>?)`）。`oms.stats_by_platform`、`oms.stats_trend/total/by_platform_scoped`、`oms.stats_top_skus(_scoped)` 也登记（受限范围用 `orgIds: [1]`），但**不**声明索引：规划器对它们不走 `idx_oms_order_time`（见下），声明了就是假绿或常红。`oms.stats_top_skus` 与 `_scoped` 在 `oms_order_items`（增长表）上的 `SCAN i` 有 ALLOW 书面豁免。
4. **运维**：新增 `docs/operations/query-planner.md`——应用从不执行 `ANALYZE` / `PRAGMA optimize`；若将来引入，先复跑 explain-audit，再按文内顺序处置。

## 诚实边界（计划没有改变的语句）
- **byPlatform**：`platforms` 驱动，对每个平台按 `(platform_id, platform_order_no)` 自动索引取该平台全部订单；`order_time` 谓词只做过滤。要利用索引需改写成"先按 order_time 聚合再并入平台"的形态，那会改变浮点求和顺序，不能保证逐位相同，未做。
- **受限组织范围**：范围谓词是 `platform_id IN (子查询)`，规划器选 `platform_id` 等值索引，区间谓词只做过滤；前后延迟在噪声内相同。改写范围谓词会碰权限语义，不在 AE3 范围。
- **topSkus**：`oms_order_items` 驱动（`SCAN i` → 按主键取订单）；改成订单驱动（`CROSS JOIN`）同样会改变求和顺序。
- 最坏分布（窗口覆盖几乎全部行）下覆盖索引与扫描量级相当，个别 90 天窗口的 total / AI 平台分析的中位数在噪声范围内偏慢，见 capacity-baseline。

## 测试（tests/oms-sql.test.mjs，6 个）
新旧 SQL 等价（5 种范围 × 13 种窗口 × 4 条 `/stats` 语句，夹具含窗口边界、`T` 分隔、仅日期、时区后缀、脏文本、儒略日数字串、NULL、空串、未来日期、未知平台、无仓库平台）；AI 平台分析等价；绑定参数顺序与无效窗口绑定 NULL；变异（去掉 `date()` 复核）使结果改变；explain-audit 登记与路由同一份语句、`expectIndex` / `expectSearch`、无豁免、计划是覆盖索引范围 SEARCH、删索引后守卫变红；路由里不再内联 `date(order_time) >=`。
