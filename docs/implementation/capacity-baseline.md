# 容量与性能基线（W11）

> **范围声明**：本文档的数字来自开发机 Mac mini（Apple M4, 10 核, 16 GB, Node v22.22.1）上对 **demo 种子库**的一次短跑。
> **它们不是目标主机（`dmserver`）结果，不是容量承诺，不是验收证据**。此前报告"没有压测"的结论在目标主机实测前仍然成立；
> 本脚本只是让试点前的基线**可重复**。生产规模、真实数据量、多用户混合读写、网络与反向代理都**未覆盖**。

## 方法

脚本：`scripts/bench-api.mjs`（无新增依赖，自写并发 `fetch` 池）。

1. 必须显式给**绝对路径** `GML_DATA_DIR`，并经 `requireExplicitDataDir()` 拒绝仓库 `data/`；`GML_RUNTIME_MODE` 只接受 `demo`/`test`；输出文件也不得落在仓库 `data/` 内。数据目录若位于仓库 `data/` 之内、或其中 `.db`/`-wal`/`-shm` 是符号链接/解析到仓库 `data/`，输出文件是符号链接，同样拒绝。违反即退出码 2，不启动任何进程。脚本**无法判断**某个 demo/test 目录是否正被别的实例使用——必须是专为本次压测复制或新建的目录。
2. 在 `127.0.0.1` 的随机空闲端口 spawn `server/index.js`（子进程环境白名单、随机 JWT 密钥、`GML_LOGIN_IP_LIMIT`/`GML_LOGIN_ACCOUNT_LIMIT` 提高到 10000），请求只发往该端口，每次请求前确认自己 spawn 的子进程仍存活、退出即中止；这降低但不能数学上排除端口被他人抢占的竞态。
3. 登录一次取 token（默认 `admin`/`12345`，即种子文件里的 demo 账号；可用 `GML_BENCH_USER`/`GML_BENCH_PASSWORD`/`GML_BENCH_INDUSTRY` 覆盖）。
4. 对 10 条接口顺序各跑 N 次，每条内部最多 `concurrency` 个请求同时在飞：登录（`--login-iterations`）、仪表盘 summary、采购单列表、采购单详情（取列表第一条）、库存 `stocks`、收款单列表 `ar/receipts`（应收侧）、报表 `reports/operating`（当月）、`meta/health`、订单中心 overview、通知 meta。
5. 延迟用 `performance.now()` 测整次请求（含读完响应体）。百分位为**最近秩**：升序 n 个样本取第 `ceil(p/100·n)` 个；样本很少时 p95/p99 会等于最大值，不要过度解读。错误 = HTTP ≥ 400 或网络错误/30 s 超时；超时与网络错误的实际等待时间**计入**延迟样本（不会因失败而让尾部变好看），状态直方图里记为 `network_error`。错误率阈值按未取整比例比较。`SQLITE_BUSY` 次数 = 子进程 stdout/stderr 中匹配 `SQLITE_BUSY|database is locked` 的行数（应用若吞掉该错误不写日志则计不到，是下限）。
6. 默认档（并发 4 × 每条 30 次，登录 10 次）约 1 秒，远小于 60 秒；脚本在错误率超过 `--max-error-rate`（默认 0.05）时退出码 1。

压测会写库（登录更新 `last_login_at`、产生 WAL），所以**只对副本运行**：

```bash
export GML_RUNTIME_MODE=demo GML_DATA_DIR=$(mktemp -d /tmp/bench.XXXXXX)
node scripts/reseed-all.mjs --force
node scripts/bench-api.mjs --concurrency 4 --iterations 30 --out "$GML_DATA_DIR/result.json"
```

## 输出 schema（`schema_version: 1`，字段与顺序固定，`tests/bench-api.test.mjs` 断言）

- `schema_version`、`generated_at`、`scope_notice`
- `host`：`platform, arch, cpus, cpu_model, total_mem_mb, node`
- `config`：`runtime_mode, concurrency, iterations, login_iterations, industry`
- `endpoints[10]`：`name, method, route, requests, errors, error_rate, status_histogram, latency_ms{min,p50,p95,p99,max,mean}`
- `totals`：`requests, errors, error_rate, wall_seconds, throughput_rps`
- `sqlite_busy_count`

## Mac mini 数字（**不是目标主机结果**）

默认档，demo 美妆库，并发 4；单位 ms；0 错误，`SQLITE_BUSY` 0，总吞吐约 323 req/s（总墙钟 0.87 s，共 280 请求）。

| 接口 | 请求数 | p50 | p95 | p99 |
|---|---|---|---|---|
| POST /api/auth/login | 10 | 252.7 | 407.5 | 407.5 |
| GET /api/dashboard/summary | 30 | 3.9 | 10.1 | 11.5 |
| GET /api/purchase/orders | 30 | 1.9 | 2.6 | 2.7 |
| GET /api/purchase/orders/:id | 30 | 1.6 | 3.0 | 3.1 |
| GET /api/inventory/stocks | 30 | 3.4 | 7.0 | 7.5 |
| GET /api/ar/receipts | 30 | 3.0 | 5.4 | 5.6 |
| GET /api/reports/operating | 30 | 3.3 | 10.3 | 10.9 |
| GET /api/meta/health | 30 | 1.6 | 2.3 | 2.4 |
| GET /api/order-center/overview | 30 | 2.0 | 8.3 | 8.6 |
| GET /api/notify/meta | 30 | 1.2 | 3.5 | 4.0 |

解读限制：登录的 250 ms 主要是 bcrypt 同步计算在单线程事件循环里排队（4 个并发登录互相等待），体现的是登录串行化而非单次登录成本；其余接口是 demo 库（数百行量级）上的读，**不代表生产数据量**。本节的读基线没有覆盖写路径（创建/审核/收付款）、并发写冲突下的 `SQLITE_BUSY`（写档见文末"Y7 写路径基线"）、长时间 soak、内存增长。

## 仍需目标主机

在 `dmserver` 上用生产规模数据副本、相同脚本复跑并留存 JSON，才能作为试点容量证据；届时同时记录 CPU/磁盘型号与是否经反向代理。

## X10 索引审计：迁移 059 前后（**夹具规模，不是容量证据**）

`scripts/explain-audit.mjs` 对 61 条声明语句（镜像 W11 的 10 条接口及采购/库存/应收/销售/报表主查询，表在脚本的 `STATEMENTS` 里，每条标明镜像的 lib/路由）跑 `EXPLAIN QUERY PLAN`。判据：裸 `SCAN <表>` 且该表行数 ≥ 200，或该表属于随业务增长的单据/流水表（`GROWTH_TABLES`，不看夹具行数），或 SQLite 运行时自建"自动索引"，都算违规；豁免只能按"语句 × 表"写，且必须有理由，过期豁免同样报红。

| | 迁移 057（改前） | 迁移 059（改后） |
|---|---|---|
| 违规 | 29 处裸 SCAN / 自动索引 | 0 |
| 豁免（带理由） | 15 | 15 |
| 小字典表扫描 | 4 | 4 |

改后仍保留的 15 处豁免：9 处是"按主键倒序取最新一页"（`ORDER BY id DESC LIMIT n`，计划里无排序临时表，脚本校验该前提；其中发票/结算/付款三条带 `status<>'voided'` 过滤，若尾部有大段已作废单据会多读，上界是整表，属已知残余）；5 处是整表聚合（否定式谓词或无谓词，索引无法缩小读取范围）；1 处是 `GET /inventory/stocks` 的 `qty_on_hand <> 0` 列表（几乎不过滤且跨表排序，需要分页游标/物化方案，**索引解决不了，记为残余项**）。

### 前后 p95（`bench-api.mjs`，同一份种子库拷贝，交错 A/B 各 5 次取中位数）

条件：Mac mini，`--iterations 100 --concurrency 4`，每次运行用同一份种子库的**新拷贝**（"前"=临时移走 059 的代码，"后"=含 059）。**测量时整机负载平均值约 80（其他任务并行），所以 HTTP 级 p95 噪声远大于索引的收益**：毫秒级端点的涨跌（如 `meta_health` 不碰任何新索引仍浮动 +11%）都在噪声里，**这张表不能证明"p95 不变差"，也不能证明变好**。

| 接口 | p95 前 (ms) | p95 后 (ms) | 变化 |
|---|---|---|---|
| POST /api/auth/login | 2008.1 | 2059.6 | +3%（bcrypt 排队，与索引无关） |
| GET /api/dashboard/summary | 98.4 | 82.9 | -16% |
| GET /api/purchase/orders | 97.1 | 113.1 | +16% |
| GET /api/purchase/orders/:id | 74.2 | 72.0 | -3% |
| GET /api/inventory/stocks | 87.5 | 87.6 | 0% |
| GET /api/ar/receipts | 35.9 | 66.5 | +85%（噪声：该接口计划未变，`SELECT * FROM receipts ORDER BY id DESC`） |
| GET /api/reports/operating | 70.6 | 81.2 | +15% |
| GET /api/meta/health | 27.1 | 30.0 | +11%（不碰数据库索引，纯噪声基准） |
| GET /api/order-center/overview | 70.5 | 101.7 | +44%（噪声：本接口语句计划未变） |
| GET /api/notify/meta | 44.1 | 28.1 | -36% |

0 错误，`SQLITE_BUSY` 0。因为 HTTP 数字不可用，补一份**进程内逐语句计时**（同一进程里交替执行"前库/后库"各 300 次，排除网络与调度，但机器仍有负载，只看量级）：语句 p50 变化——`stock.txn_by_doc` 34→1 µs，`sales.items` 20→2 µs，`sales.list_page` 715→188 µs（p95 22.1→2.1 ms，子查询 `COUNT(*) FROM sales_order_items WHERE order_id=…` 不再逐行全表扫），`dash.sales_today` 52→3 µs，`stock.expiring` 30→8 µs，`rpt.sales_value` 18→6 µs，`rpt.purchase_value` 7→2 µs，`rpt.sales_cost` 76→43 µs，`po.refresh_invoice_amount` 4→1 µs；61 条里没有 p50 退化超过 15% 且绝对值超过 10 µs 的语句（唯一超 15% 的 `dash.sales_unpaid` 计划未变，是噪声）。

**局限**：夹具库最大表约 1500 行，绝对数字小到不代表生产；要作为证据，需要在 `dmserver` 上用生产规模副本复跑 `explain-audit.mjs` 与 `bench-api.mjs`。新增索引的写放大（每个索引每次 INSERT/UPDATE 多维护一棵 B 树）未做写路径压测；`inventory_transactions` 新增 2 个（`doc_type, doc_id` 与 `doc_type, substr(biz_date,1,7)`），是写最频繁的表。

## Y7 写路径基线（ADR-0035，**夹具规模，不是容量证据**）

`node scripts/bench-api.mjs --profile=write`：对隔离的 demo 种子库副本并发创建采购单、确认收款（带 `evidence_ref`，复核在副本里关闭）、库存调拨（autoShip），每种 100 次，并发 8，共 300 个写请求。**单个服务进程的 SQLite 写是同步的，自己不会 BUSY**，所以脚本另起一个 worker 线程当外部写者，用独立连接周期性 `BEGIN IMMEDIATE` 占锁 30 ms、间隔 20 ms（约 60% 占锁率，比真实的偶发 CLI/备份写**重得多**），模拟其它进程。四组配置，每组一份新的种子库拷贝，Mac mini（负载不低，其它任务并行），数字只看量级：

| 配置 | 成功/总数 | HTTP 500 | `write_retry` | 用尽 | 服务日志 BUSY 行 | 墙钟 s | 完整性核对 |
|---|---|---|---|---|---|---|---|
| 默认（busy 5000 ms，重试 4 次） | 300/300 | 0 | 0 | 0 | 0 | 2.67 | OK |
| busy 5 ms，**重试关闭**（`--retry-max 1`） | 251/300 | 49 | 0 | 49 | 102 | 1.16 | OK |
| busy 5 ms，重试 4 次 | 298/300 | 2 | 31 | 2 | 42 | 3.36 | OK |
| busy 5 ms，重试 8 次 | 300/300 | 0 | 26 | 0 | 28 | 2.81 | OK |

读法：

- 默认 5 秒超时下，服务端**在锁上等待**而不是报错，所以 300/300 成功、没有一条 BUSY 日志，代价是尾延迟：本次默认组 `stock_transfer` 的 p95 约 850 ms（等外部写者释放，同机负载也有贡献）。这是"外部写者很重时的等待成本"，不是回归。
- 把 `busy_timeout` 调小到 5 ms 并关闭重试，模拟"锁等不到就失败"：49/300 请求返回 500，服务日志里是 `SQLITE_BUSY`。开重试后失败降到 2（4 次）/ 0（8 次），代价是个别请求更慢（4 次组里一次确认收款 p95 约 1.5 s）。
- **完整性核对全部通过**：成功数 = 库里的行数、无重复行、每张调拨恰好一条 `TR_OUT`、源仓库存恰好少成功调拨数、已确认收款数 = 成功数。失败的请求没有留下半截提交。脚本不重发失败请求（HTTP 路由没有幂等键），所以这里证明的是"服务端重试不会双写"，不是"客户端重发安全"。
- "服务日志 BUSY 行"是按日志文本计的下限，且一次用尽会同时产生 `write_retry_exhausted` 与 500 错误日志，不要把它当请求数。
- 外部写者的循环数（17–54）随运行时长变化；它只占锁、不写业务行。

局限：夹具库（数百行）、单机、单个服务进程 + 线程模拟外部写者；没有测多服务实例、MCP 子进程、备份与写并发的真实叠加；没有测长时间 soak、WAL 增长与 checkpoint 饥饿；0 错误/低错误率**不能**外推到生产写入量。目标主机（`dmserver`）上的写基线仍待实测。

复现：

```bash
export GML_RUNTIME_MODE=demo GML_DATA_DIR=$(mktemp -d /tmp/bench.XXXXXX)
node scripts/reseed-all.mjs --force
node scripts/bench-api.mjs --profile=write --iterations 100 --concurrency 8 --busy-ms 5 --retry-max 4 --out "$GML_DATA_DIR/write.json"
```

写档 JSON（`schema_version: 1`，`profile: "write"`）字段：`generated_at, scope_notice, host, config{..., contender_hold_ms, contender_gap_ms, sqlite_busy_ms, write_retry_max}, operations[3]{name, method, route, requests, errors, error_rate, status_histogram, latency_ms, ok}, contention{contender_cycles, contender_begin_failures, server_busy_log_lines, write_retry_log_lines, write_retry_exhausted_log_lines}, integrity{ok, run_id, ...}, totals`。读档的 schema 与字段未变。

## Y10 大库规模演练（**Mac mini / 合成数据 / 非目标主机**）

> **范围声明**：下面所有数字来自开发机 Mac mini（Apple M4, 10 核, 16 GB, Node v22.22.1, SQLite 3.49.2）上**一次**合成数据演练，机器当时还在跑别的任务（见每张表的负载）。
> **不是目标主机（`dmserver`）结果、不是容量承诺、不是 RPO/RTO 证据、不是验收证据**。合成数据是均匀随机、单行业、单管理员，不代表真实业务分布。
> 实际跑过的**最大规模**是 `large`（2 万 SKU / 5 万单据 / 25 万库存流水），**没有**跑 roadmap 写的 10 万 SKU / 20 万单据 / 100 万流水：开发机内部盘只剩约 16 GiB 且已用 92%，整条流水线（库 + 两份备份 + 两份恢复副本 + 压测副本）峰值**按 large 的实测体量外推约 10 GB（估算，未实跑）**，会挤占同机其他任务。该规模需在 `dmserver` 上用同一脚本复跑。

### 做了什么

- `scripts/synth-data.mjs`：在全新的空 `GML_DATA_DIR` 生成**生产分类**合成库。迁移走真实运行器；管理员走 `bootstrapAdmin`；采购走 `createPurchaseOrder → transitionPurchaseOrder → receivePurchaseOrder`；销售走 `createQuote → transitionQuote → convertQuote → 确认 → 发货 →（少量）cancelOrder`；盘盈盘亏走 `applyStockGain/applyStockOut` 补足流水目标。
  - **唯一直接 INSERT 的是主数据**（品牌/品类/商品/SKU/仓库/供应商/供货关系/经销商）：这些在路由里是通用 CRUD，没有可调用的领域函数，也不涉及跨表不变量；授信账户走 `ensureAccount/updateAccount`。
  - **订单确认与发货是对 `server/routes/sales.js` 对应处理器的镜像**（确认/发货逻辑只存在于 HTTP 处理器内，领域层没有同名函数）：用的仍是 `checkCredit / reserveForDoc / occupy / planShipment / applyStockOut / applyTransition / logEvent`，但**编排**是镜像的，路由改了要同步（文件头与代码注释已标）。
  - 确定性：种子 `--seed`（mulberry32）、业务日期锚在 `--anchor`、生成时固定 `TZ=UTC`；摘要里的 `digest` 只哈希业务列，同参数两次运行相同（测试断言，且断言不同时区相同）。
  - 不变量（生成末尾必跑，`tests/synth-data.test.mjs` 对最小规模再独立核对并证明篡改会红）：`integrity_check`、`foreign_key_check` 为空（无孤儿行）、库存 = 流水净额（逐 仓×SKU×批次，双向）、无负库存、预留 ≤ 现存、收货/发货单明细 = PUR_IN/SAL_OUT 流水 = 订单行已收/已发、表头 = 明细合计、每张单据有 `doc_events` 且无孤儿事件、`reconcileOrderHolds` 为空、`auditCredit` 平衡。
- `scripts/synth-pipeline.mjs`：串联 生成 → `db-backup`（明文）→ `db-backup`（`GML_BACKUP_KEY` 加密）→ 两份 `db-restore-drill`（探针全部比对）→ `explain-audit` → 压测副本预热 → `bench-api`，输出带来源身份（提交、脏工作区指纹、SQLite/Node 版本）与负载的 JSON。原始报告：`capacity-evidence/y10-medium-20261023.json`、`capacity-evidence/y10-large-20261023.json`（提交 `51382ce`，工作区干净）。

### 规模

| | medium | large（最大已跑） |
|---|---|---|
| 参数 | `--skus 20000 --docs 30000 --txns 150000` | `--skus 20000 --docs 50000 --txns 250000` |
| SKU / 库存行（批次）| 20 000 / 84 736 | 20 000 / 141 425 |
| 库存流水 | 150 000 | 250 000 |
| 采购订单 / 收货单 | 12 000 / 10 774 | 20 000 / 17 992 |
| 报价→销售订单 / 发货单 | 18 000 / 12 607 | 30 000 / 21 163 |
| 授信台账行 / 单据事件 | 18 858 / 170 747 | 31 495 / 285 053 |
| 库文件 | 248.6 MB | 410.5 MB |
| 生成总耗时（其中 采购/销售/盘点/自检）| 205.8 s（52.5 / 94.7 / 6.8 / 50.4）| 509.8 s（106.2 / 224.8 / 14.3 / 162.6）|
| 不变量 | 全绿 | 全绿 |
| 开始/结束 loadavg(1m) | 3.6 / 5.8 | 5.6 / 10.9 |

生成是单线程领域调用，约 100–150 单据/秒；medium 在 10 分钟预算内。

### 备份 / 恢复演练 / 索引审计 / 压测（单次墙钟）

| 步骤 | medium | large |
|---|---|---|
| `db-backup` 明文（墙钟 / 写冻结窗口 / 快照大小）| 2.0 s / 579 ms / 235.5 MB | 3.8 s / 1 020 ms / 388.3 MB |
| `db-backup` 加密（同上）| 2.5 s / 634 ms / 235.5 MB | 4.2 s / 1 034 ms / 388.3 MB |
| `db-restore-drill` 明文（总耗时；sha256 核对 / 迁移 / 服务就绪 / 探针）| 1.6 s（546 / 103 / 640 / 242 ms）| 2.0 s（811 / 115 / 740 / 254 ms）|
| `db-restore-drill` 加密（同上）| 1.7 s（329 / 96 / 639 / 242 ms）| 2.2 s（654 / 98 / 642 / 249 ms）|
| `explain-audit`（61 条语句）| 63 ms，**3 处违规** | 65 ms，**3 处违规** |
| 压测副本预热（见下）| 25.3 s | 44.2 s |
| `bench-api`（并发 4 × 100 次，登录 10 次）| 910 请求 / 0 错误 / 18.3 s / SQLITE_BUSY 0 | 910 请求 / 0 错误 / 29.7 s / SQLITE_BUSY 0 |

恢复演练的"耗时"只代表本机、热页缓存、备份与目标在同一块盘上的复制+迁移+起服务；**不是 RTO**，也没有网络与冷盘。备份的写冻结窗口随库大小线性增长（约 2.6 ms/MB）。

### `bench-api` p95（ms）

| 接口 | 夹具库（W11 基线）p95 | medium p95 | large p95 |
|---|---|---|---|
| POST /api/auth/login | 407.5 | 1 512.6 | 1 515.3 |
| GET /api/dashboard/summary | 10.1 | 198.5 | 282.6 |
| GET /api/purchase/orders | 2.6 | 8.8 | 14.7 |
| GET /api/purchase/orders/:id | 3.0 | 1.6 | 2.4 |
| GET /api/inventory/stocks | 7.0 | 704.1 | 1 092.1 |
| GET /api/ar/receipts | 5.4 | 2.4 | 2.0 |
| GET /api/reports/operating | 10.3 | 33.8 | 69.0 |
| GET /api/meta/health | 2.3 | 0.7 | 1.0 |
| GET /api/order-center/overview | 8.3 | 3.5 | 5.1 |
| GET /api/notify/meta | 3.5 | 1.2 | 1.0 |

夹具列来自本文上面的 W11 默认档（不同负载、不同次数，仅作量级参照）。登录 p95 是 bcrypt 同步计算在单线程事件循环里排队，与数据量无关（本次登录 10 次、并发 4）。

### 发现（给后续批次，不在本工作流内修）

1. **`GET /api/inventory/stocks` 随库存行数线性变慢**（84.7k 行 → p95 704 ms；141k 行 → 1 092 ms）。与 X10 记录的残余一致：`qty_on_hand <> 0` 的几乎不过滤列表，索引解决不了，需要分页游标或物化。
2. **`explain-audit` 在规模下出现 3 处新违规**（夹具规模下为 0）：`dash.todo_counts` 全表扫 `product_skus`（2 万行）与 `dealers`（750/1 250 行）、`stock.below_safe` 全表扫 `product_skus`。X10 的结论"夹具规模下无裸 SCAN"在这里被规模推翻了一部分；需要 `product_skus(status, safe_stock)` 一类的索引或改写，并重新审计。
3. **`GET /api/dashboard/summary` 随单据增长**（夹具 10 ms → 5 万单据 283 ms），与 2 同源的扫描有关，改索引后应复测。
4. 生成器自检曾发现的一个性能坑：`inventory_transactions` 分组 `NOT EXISTS + COALESCE(batch_no,'')` 失去索引，25 万流水上要 2 分钟；已改为 LEFT JOIN 走唯一索引；修复后 `verifyInvariants` 在 medium/large 仍要 50 s / 163 s（`integrity_check` 在 25 万流水库上单次约 19 s，其余未再逐项剖析）。

### 压测库与生成库不是同一份（必须一起读）

`bench-api` 只接受 `demo/test` 分类的库、且它起的 test 模式 `server/index.js` 启动时会执行 `db/boot.js` 的演示种子。所以流水线把生成库**复制**成一次性副本，**只在副本上**把 `os_egp_runtime.mode` 改成 `test`（整条流水线唯一一次对分类标记的直接写入；原库与两份备份仍是 production），并先单独预热一遍同一个 `bootAll` 以免撞 bench 的 60 s 启动等待。副作用已实测并记入报告 `bench_dataset`：演示种子叠加少量演示行（SKU/流水/单据量级变化 <1%），**并重置了 `credit_ledger`/`credit_accounts`/`sales_quotes` 一族**（`quote-seed.js` 清表重灌），另建 food/apparel 两份演示库；副本里 `order_received_qty_equals_receipt_items` 自检为红（来自叠加的演示采购单，生成库本身为绿）。因此压测读到的是"合成体量 + 演示叠加"，授信相关表为空。

### 复现

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
# 最小规模（测试用，几秒）
GML_RUNTIME_MODE=production GML_DATA_DIR=$(mktemp -d /tmp/synth.XXXXXX)/data GML_DB= node scripts/synth-data.mjs
# 整条演练（--out 须是尚不存在的新文件；--dir 默认跑完删除，加 --keep 保留）
node scripts/synth-pipeline.mjs --dir /tmp/synth-large --skus 20000 --txns 250000 --docs 50000 --seed 20261023 --out /tmp/large-report.json
```

跑之前确认磁盘余量（large 峰值约 4 GB，roadmap 全量约 10 GB）与机器负载（报告里有 `loadavg_start/end`）；同种子、同提交、同 SQLite 版本下 `digest` 应一致，**计时不会一致**。

### 仍需目标主机

在 `dmserver` 上用同一条命令跑 roadmap 全量（10 万 SKU / 20 万单据 / 100 万流水），并保留 JSON；这时才谈得上 RPO/RTO 与容量。本次没有覆盖：写路径并发（生成是单线程）、长时间 soak、内存增长、真实反向代理与网络、冷盘恢复。

## Z3 大库热点查询改造：迁移 061 前后（**Mac mini / 合成 medium 库 / 非目标主机**）

> **范围声明**：数字来自开发机 Mac mini，合成 `medium` 库（`synth-data.mjs --skus 20000 --docs 30000 --txns 150000`，种子 20261023，`digest` 与 Y10 的 medium 一致；2 万 SKU / 84 736 库存行 / 15 万流水 / 750 经销商）。**不是目标主机（`dmserver`）结果、不是容量承诺、不是验收证据**。测量时机器还有其他任务在跑（HTTP 级 p95 抖动 ±数十 ms，见下），所以下面把"逐语句进程内计时"和"HTTP p95"分开写，并说明各自可信到什么程度。

### 改了什么
- 迁移 `061_hot_query_indexes`：`product_skus(status, safe_stock)`、`dealers(status, credit_limit)`、`inventory_stocks(sku_id, qty_on_hand)`（覆盖索引，库存按 SKU 汇总不回表；`idx_stock_sku` 是它的前缀，因 059 的 verify 仍要求其存在而保留）。只加非 UNIQUE 索引，应用到 medium 库耗时约 3.1 s。
- `server/lib/stock.js` 新增 `countBelowSafe` / `listBelowSafe`，看板（计数与 Top 10）与 `GET /inventory/alerts` 共用一份口径；并列缺口按 sku id 升序（原写法并列顺序未定义）。
- `GET /api/inventory/stocks`：强制分页，`pageSize` 默认 50、上限 500；游标 `after_id`，排序改为 `st.id` 升序（原为 仓库 / SKU 编码 / 到期日，跨三表无法键集定位）；响应 `{list, pageSize, has_more, next_after_id}`，`total` 与 `summary` 只在首页（无 `after_id`）返回，且只连接过滤条件用到的表。**契约变化**：`page` / `offset` 不再支持（忽略）、`page`/`totalPages` 字段不再返回、排序变化；前端库存页改为"上一页 / 下一页"游标翻页，仓库与关键字过滤交给服务端。
- `explain-audit` 语句集 61 → 65：`dash.todo_counts` 去掉 below_safe 子查询并新增 `dash.below_safe_count`、`dash.stock_alerts`；`stock.query_*` 改为键集形态并新增 `stock.query_after`、`stock.query_total`；`stock.query_page` 的旧豁免换成"首页沿 rowid 升序取够 n 行即停"的带前提豁免，`stock.query_total` 为整表聚合豁免（只在首页执行）。`tests/hot-queries.test.mjs` 证明：没有 061 时 `dash.todo_counts×dealers`、`dash.below_safe_count×product_skus`、`stock.below_safe×product_skus` 报红，有 061 时零违规。

### EXPLAIN 前后（medium 库）
| 语句 | 改前 | 改后 |
|---|---|---|
| `dash.todo_counts`（经销商预警） | `SCAN dealers`（750 行）| `SEARCH dealers USING INDEX idx_dealers_status_credit (status=? AND credit_limit>?)` |
| 看板 below_safe 计数 | `SCAN sk`（2 万行）+ 相关子查询 `SEARCH st USING INDEX idx_stock_sku` | `SEARCH sk USING COVERING INDEX idx_sku_status_safe (status=? AND safe_stock>?)` + `SEARCH st USING COVERING INDEX idx_stock_sku_qty` |
| `stock.below_safe` | `SCAN sk` + LEFT JOIN + 两棵临时 B 树（GROUP BY / ORDER BY）| `SEARCH sk USING INDEX idx_sku_status_safe` + 覆盖索引上的相关子查询 + 一棵 ORDER BY 临时树 |
| `GET /stocks` 翻页 | 每页 `COUNT` + `SUM` + 全量排序后 `LIMIT/OFFSET`（读满足条件的全部行）| 首页 `SCAN st`（rowid 升序，LIMIT 51 即停）+ 一次 `COUNT/SUM`；后续页 `SEARCH st USING INTEGER PRIMARY KEY (rowid>?)` |

`explain-audit`（medium 库）：改前 61 条语句 **3 处违规**（与 Y10 一致）；改后 65 条语句 **0 违规**，豁免 16（含新增的 2 条，见上）、索引全扫 2。

**没有采用"先预聚合再 JOIN"**：试过 `LEFT JOIN (SELECT sku_id, SUM(qty_on_hand) FROM inventory_stocks GROUP BY sku_id) t`，SQLite 会为物化子查询建 `AUTOMATIC COVERING INDEX`（explain-audit 判违规），且在 8.5 万库存行上更慢（计数 13.3 ms vs 相关子查询 9.7 ms，列表 32 ms vs 5–19 ms，进程内多次测量的量级）。覆盖索引 + 相关子查询既无自动索引又更快。残余：`listBelowSafe` 的相关子查询因子查询被展平，计划里出现 3 次，实际每个候选 SKU 最多算 3 次（同一覆盖索引范围读），2 万 SKU 全部候选时仍是 O(候选数)。

### 数据口径（必须读）
合成库里**所有 SKU 的 `safe_stock = 0`、经销商 `credit_limit = 0`**（生成器不造这两类数据），所以 `safe_stock>0` 的谓词在 061 之后直接命中空范围，"改后"在原样数据上看起来几乎免费——这是数据特征，不是通用收益。为不夸大，补了一档**增强库**：在副本上执行 `UPDATE product_skus SET safe_stock=(id%5)*40; UPDATE dealers SET credit_limit=100000, credit_used=(id%10)*10000`（80% SKU 设安全库存，186 个低于安全库存）。下面两档都给。

### 逐语句进程内计时（增强库，只读连接，15 次取中位数，ms；机器有负载，只看量级）
| 语句 | 改前（无 061，旧 SQL）| 改后（061 + 新 SQL）|
|---|---|---|
| below_safe 计数（看板）| 113.0 | 46.0 |
| below_safe 列表 Top 50（预警页）| 132.7 | 38.7 |
| 经销商信用预警计数（750 行）| 0.06 | 0.05（本表太小，索引只保证量级，不改变毫秒）|
| 库存列表首页（含 total + summary）| 385.2 | 36.0 |
| 库存列表第二页 | 141.5（OFFSET 50）| 0.14（`after_id`）|

### `bench-api` p95（ms，`--concurrency 4 --iterations 100`，每次用同一份预热库的新拷贝，交错前/后各 3 次取中位数）
"前"= 本分支基线提交的代码（只有 060），"后"= 含 061 与上述改动。压测库 = 合成库 + 演示种子叠加（同 Y10，见"压测库与生成库不是同一份"）。三次运行的 p95 抖动很大（见括号内原始值），**只有量级差异大的行可信**。

| 接口 | 原样合成库 前 | 后 | 增强库 前 | 后 |
|---|---|---|---|---|
| GET /api/inventory/stocks | **2 077.8**（2127 / 2078 / 1672）| **150.5**（151 / 166 / 127）| **1 997.8**（1709 / 1998 / 2178）| **140.1**（140 / 47 / 164）|
| GET /api/dashboard/summary | 474.9 | 431.6 | 477.3 | 403.0 |
| GET /api/purchase/orders | 58.8 | 14.2 | 61.5 | 24.9 |
| GET /api/reports/operating | 120.1 | 112.8 | 113.1 | 101.5 |
| GET /api/ar/receipts | 20.4 | 16.4 | 13.9 | 2.1 |
| GET /api/meta/health（噪声基准）| 5.7 | 7.7 | 1.8 | 16.3 |
| GET /api/order-center/overview（未改，噪声基准）| 33.1 | 27.4 | 4.0 | 33.5 |

读法：`/inventory/stocks` 约 14 倍的下降超出噪声（前三次最小值 1 672 ms 仍远大于后三次最大值 166 ms）。看板 summary 只下降约 10–15%，且在噪声之内（未改接口 `meta/health`、`order-center/overview` 在同一轮里也波动 ±10–30 ms）；看板仍是 ~400 ms，说明它的主要耗时在别处（`inventory_stocks` 整表聚合 `dash.stock_total`、销售/采购汇总等，已在 X10 里作为"整表聚合"豁免），**本工作流没有解决看板整体慢，后续需单独剖析**。0 错误，`SQLITE_BUSY` 0。和 Y10 记录的 stocks 704 ms 不同（本轮基线 ~2 000 ms）是因为测量时整机负载更高，且该接口随库存行数线性，数字不可跨轮比较。

### 仍需目标主机 / 未覆盖
- `dmserver` 上用生产规模副本复跑 `explain-audit` 与 `bench-api`；large 规模未重跑（只跑了 medium）。
- `qty_on_hand <> 0` 的首页在头部有大段零库存行时会多读；`total` 仍是一次整表聚合（每次进入页面 / 改过滤条件付一次，翻页不付）。
- `server/lib/metrics.js` 的 `below_safe` 指标（口径不含 `status='active'`，不同于看板）与 `routes/ai.js`、`mcp/tools.js` 里各自的低库存查询未改，仍是原写法；`metrics.js` 注册表里并没有 `dash.todo_counts`，那条语句实际在 `server/routes/dashboard.js`，本次改动落在那里。
- 新增索引的写放大：`inventory_stocks` 每次库存变动多维护一棵 B 树（未单独测写路径）。

## AA11 迁移升级演练：059–062 在合成 medium 库上的逐迁移耗时（**Mac mini / 合成数据 / 非目标主机 / 单次墙钟**）

脚本：`scripts/upgrade-rehearsal.mjs`（库：`scripts/lib/lock-probe.mjs`；测试：`tests/upgrade-rehearsal.test.mjs`）。它在备份集（或合成库目录，经 `db-backup.mjs` 备份成备份集）的**隔离恢复副本**上，从 `--from N` 基线起把编号 > N 的迁移**逐个**交给真实运行器（生产模式、暂存迁移目录里是仓库文件的字节级复制），每步记录耗时与写锁阻塞，升级后核对校验和 / 空操作重跑 / integrity / 外键 / 业务探针 / verify-seed 风格不变量，任一失败即回退（进程内重新恢复并比对 + 调用 ADR-0016 的 `upgrade-rollback-drill.mjs`）。可选夜间步骤见 `nightly-capacity.yml` 的 `rehearsal` 输入（默认 `false`，定时任务永不运行）。

### 基线截断怎么做，为什么不绕过校验和与自愈

- `--from 58` ＝ 编号 ≤ 58 的迁移视为已应用，059–062 重放。工作副本上只做两件事：`DELETE FROM schema_migrations WHERE 编号 > 58`；`DROP INDEX` 那些"仓库里编号 > 58 的迁移创建、基线迁移不创建"的索引（内存库跑 schema.sql + 迁移 ≤58 得到集合 A，再跑全部迁移得到集合 B，只删 B−A 且存在于副本里的索引；本次删 25 个：059 的 21 个、060 的 1 个、061 的 3 个）。表/列不删（删列有损数据），所以 060/062 这类"加列 / 写字典行"的迁移在副本里是对现成结构的幂等重放——报告的 `structure_preexisting` 逐步标明（false = 真正新建，true = 空转）。
- **不改任何校验和，不调用 adopt。** ≤58 的行保留原校验和，运行器第一遍照常与暂存文件比对，不一致则生产模式在任何写入前 `MIGRATION_CHECKSUM_MISMATCH`。被删的行（>58）先与当前文件比对再删，不一致判 `PRE_UPGRADE_CHECKSUM_MISMATCH`（否则截断会抹掉"这个库在生产上启动会被拒绝"的事实）。重放的行由运行器按当前文件重新登记（origin=applied）。
- 自愈：每步记录 `healed`；> 基线的迁移被自愈 ＝ up 与 verify 不自洽，判失败；≤ 基线的只记警告。
- 想演练**真正的旧库**（表/列也不存在），用旧版本代码产出的备份集——它的版本表本来就缺这些行，`--from` 取其最高已应用编号。

### 口径

`duration_ms` ＝ 一次 `runMigrations` 调用的墙钟（含对暂存目录的校验和核对与已登记迁移的 `verify()`）；`overhead_ms` ＝ 紧接着再调一次（空操作）的墙钟；`net_ms ≈ duration − overhead`，**抖动很大（负载 40 的机器上经常为 0），只看 `duration_ms`**。`写锁阻塞` ＝ worker 线程里另一个连接每约 1 ms 做一次 `BEGIN IMMEDIATE; COMMIT`（`busy_timeout=0`），两次成功之间、期间失败过的最长间隔：**写入者视角的下界，约 1–2 ms 分辨率**；WAL 下读者不被挡，本演练不量读者；上界看 `duration_ms`（单迁移单事务）。

### 数据与结果

输入：`synth-data.mjs --skus 20000 --docs 30000 --txns 150000`（medium；6,667 商品 / 12,000 采购单 / 18,000 销售单 / 150,000 库存流水；库文件 236,937,216 字节 ≈ 226 MiB，种子 20261023）生成后，`upgrade-rehearsal.mjs --from=58 --synth-dir=… `。机器：Mac mini（Apple M4，10 核，16 GB，Node v22.22.1），**测量时整机负载平均值约 35–55（其他任务并行）**，数字只能看量级。同一份库连跑两次：

| 迁移 | 结构原本存在 | 运行 1 耗时 / 写锁阻塞 (ms) | 运行 2 耗时 / 写锁阻塞 (ms) | 说明 |
|---|---|---|---|---|
| 059_indexes | false（先删了 21 个它创建的索引） | 1023.2 / 841.0 | 560.9 / 487.3 | 真实建索引；写锁占耗时的 82–87% |
| 060_qimen_secrets | false（先删了它创建的 1 个索引） | 51.0 / 0 | 87.1 / 3.6 | 小迁移 |
| 061_hot_query_indexes | false（先删了它创建的 3 个索引） | 147.1 / 96.2 | 73.1 / 43.1 | 真实建索引 |
| 062_audit_view_permission | **true** | 38.8 / 0 | 174.3 / 0 | 权限字典行已存在，空转重放，耗时**不代表**升级成本 |
| 合计（4 步） | | 1,260 | 895 | `steps_ms` 1934 / 1346 含逐步的空操作校验调用 |

两次运行都通过全部核对：`checksums_verified`（59/59）、`repo_files_match_registry`、`production_rerun_is_noop`、`registry_covers_all_migrations`、`integrity_ok`、`foreign_keys_not_worse`（0→0）、`probes_retained`（users 1 / products 6667 / purchase_orders 12000 / receipts 0 / ar_open_balance 0 前后相同）、`seed_invariants_not_regressed`（24/24 绿 → 24/24 绿）。其他耗时：合成库备份 5.3 / 8.9 s，恢复复制 0.7 / 0.8 s，索引集差异计算 1.5 / 3.3 s，verify-seed 风格不变量（运行 2 实测）升级前 ≈236 s、升级后 ≈209 s（占总耗时 ≈ 468 s 的绝大部分，与迁移本身无关）。库文件大小升级前后相同（删掉的 25 个索引腾出的页被重建复用）。

**读法**：15 万行流水量级的 medium 库，059 建索引在这台机器上约 0.5–1.0 s、持写锁约 0.5–0.85 s；这是"另一个写入者最坏要等多久"的量级，不是 SLA。**没有在 `dmserver` 上测过，没有用真实规模或真实分布的数据测过，没有测读者，没有测并发业务写入与迁移同时进行时的 `SQLITE_BUSY` 次数**（Y7 的写路径基线是另一件事）。两次运行 059 差了近一倍，说明单次数字只能看量级；要引用请在目标主机上重复多次取分布。

### 失败路径的证据（夹具规模，`tests/upgrade-rehearsal.test.mjs`）

用 `--extra-migrations-dir` 追加一个"先建表、写行、再抛错"的 `900_rehearsal_failing.cjs`（只复制进暂存目录，永不写进 `server/db/migrations/`）：059–062 先应用，第 900 步失败 ⇒ 退出码 1，报告记录失败步骤与错误，进程内回退（删副本、重新核对 sha256 复制、版本表与升级前逐字段相同、探针相同、integrity ok）与 ADR-0016 回退演练（退出码 0，全部不变量成立）都通过，工作副本里没有半截表、没有 900 行。另有：备份里被篡改的已登记校验和（≤基线与>基线各一例）⇒ `PRE_UPGRADE_CHECKSUM_MISMATCH`、一个迁移都不尝试；`--from` 高于库内真实版本 ⇒ `REHEARSAL_BASELINE_NOT_APPLIED`（退出码 2）。

### 用法

```sh
# 真实备份集（只读使用；目标目录必须是空目录，不能是线上 data 目录）
node scripts/upgrade-rehearsal.mjs --from=58 --backup-dir=/abs/backups --target-dir=/abs/empty/rehearsal-$(date +%Y%m%d)
# 合成库目录（须带 SYNTHCO 合成指纹）
node scripts/upgrade-rehearsal.mjs --from=58 --synth-dir=/abs/synth-data --target-dir=/abs/empty/rehearsal
# 预演尚未合入的迁移（编号须大于仓库最大编号）
node scripts/upgrade-rehearsal.mjs --from=62 --backup-dir=… --target-dir=… --extra-migrations-dir=/abs/candidate-migrations
```
退出码：0 通过；1 升级或核对失败（已执行回退）；2 参数 / 目录 / 基线被拒绝（不创建任何文件）。报告 `upgrade-rehearsal-<stamp>.json` 写在目标目录（0600）。
