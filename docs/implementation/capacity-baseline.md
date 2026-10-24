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

## AA6 审计日志检索：迁移 065 + 封顶计数 + 导出 5 万行（**Mac mini / 合成 100 万行 / 非目标主机**）

脚本：`node scripts/bench-audit-logs.mjs --rows 1000000 --out result.json`（自检：`tests/audit-bench.test.mjs` 小规模跑通）。临时库建在系统临时目录，结束即删。
合成数据：100 万行 `audit_logs`，经 `insertAuditRow`（唯一 INSERT 点）写入，确定性种子；12 个 module 偏斜分布（`sales` 约 34 万行，`rare_mod` 20 行）、约 480 个 user（`user_id=499` 25 行）、40 种 entity、高基数 entity_id；`created_at` 每行 +30 秒回填。库文件 143 MB（明细很短，**真实审计明细更长，库会更大**）。

**"前"= Z7 旧代码路径、无二级索引**（整表 `COUNT(*)`、`ORDER BY id DESC`、user 数字 `OR user_name`、导出 `id < ?` 游标）；**"后"= AA6 代码 + 迁移 065**（封顶计数 `LIMIT 10001`、按过滤选排序、`(created_at,id)` 游标）。同一进程内计时、每项预热一次后取中位数（列表/计数 3 次，导出 2 次）。**机器有负载**：运行时 `uptime` 的 1 分钟负载约 50–60（同机并行跑着其它工作流），只看量级。

### 进程内计时（ms；列表 = 第 1 页 50 行；计数 = 页面总数；导出 = 5 万行封顶，含读出 + 读取侧脱敏 + CSV 编码，不含 socket）
| 过滤 | 列表 前 → 后 | 计数 前 → 后 | 导出 前 → 后 |
|---|---|---|---|
| 常见 module（约 34 万行）| 0.21 → 0.17 | 107.95（=342 592）→ 0.57（=10 001）| 761.7 → 785.9（5 万行，8.3 MB）|
| 稀有 module（20 行）| **181.87 → 0.08** | 119.22 → 0.01 | 250.3 → 0.12 |
| module + 日期区间（1.1 万行）| **100.46 → 0.61** | 116.49 → 2.10（=10 001）| 558.2 → 306.1 |
| 稀有 user_id（25 行）| **129.43 → 0.24** | 138.31 → 0.02 | 418.9 → 0.41 |
| entity + entity_id | **142.71 → 0.03** | 123.37 → 0.02 | 166.3 → 0.07 |
| 无过滤 | 0.15 → 0.75（噪声：两者都是 rowid 倒扫取 50 行）| **57.43（=1 020 000）→ 0.32（=10 001）** | 952.5 → 709.5（5 万行，8.4 MB）|

读法（诚实边界）：
- **索引的收益在"稀有/中等选择性"的过滤**（整表扫描 100–180 ms → 亚毫秒）。**常见 module** 在旧代码里本来就快（`ORDER BY id DESC` 沿 rowid 倒扫，很快凑够 50 行），索引没有改善它，导出同理（5 万行约 0.7–0.8 s，耗时主要在脱敏与 CSV 编码，不在查库）。
- **计数是最大的单项收益**：每次列表请求都付一次整表 `COUNT(*)`（无过滤 57 ms，有过滤 108–138 ms，随表线性增长）；封顶后读量上界是 10 001 个索引项，与表大小无关。代价是 `total` 在超过 1 万时只是下界（响应带 `has_more`、`total_cap`，前端提示"总数为估算"，翻页深度也封顶在 1 万行）。
- **导出 5 万行**：1 M 行表上无过滤/常见 module 约 0.7–0.8 s（进程内）；稀有过滤因命中少而近乎瞬时。HTTP 端到端还要加网络与 res.write 背压，未测。
- **写放大**：追加 2 万行审计，每千行耗时 24.9 ms（无索引）→ 47.1 ms（三棵索引），**约 +90%**（同机负载抖动，量级可信、百分比不精确）。库文件 143 → 229 MB（+60%，三棵索引）。审计表几乎每次业务写入都追加一行，这是 065 的真实成本。
- **建索引耗时**：对 100 万行执行 065 的 `up` 约 **5.1 s**（持写锁；升级演练 AA11 会把它纳入）。

### EXPLAIN（同上库；"前"是旧语句，"后"是新语句）
| 形态 | 前 | 后 |
|---|---|---|
| 列表 module / module+date | `SCAN audit_logs`（rowid 倒扫 + 逐行过滤）| `SEARCH … USING INDEX idx_audit_module_created (module=? [AND created_at>? AND created_at<?])`；`ORDER BY created_at DESC, id DESC` 由索引顺序给出，**无排序临时表** |
| 列表 user_id | `SCAN audit_logs`（`user_id=? OR user_name=?` 使索引不可用）| `SEARCH … USING INDEX idx_audit_user_created (user_id=?)`，同样无排序临时表 |
| 列表 entity+entity_id | `SCAN audit_logs` | `SEARCH … USING INDEX idx_audit_entity (entity=? AND entity_id=?)`（索引内按 rowid 序，`ORDER BY id DESC` 无需排序）|
| 计数（有过滤）| `SCAN audit_logs`（整表 COUNT）| `SEARCH … USING COVERING INDEX idx_audit_*` 包在 `LIMIT 10001` 子查询里 |
| 计数（无过滤）| `SCAN audit_logs` | `SCAN … USING COVERING INDEX`（索引扫描，`LIMIT 10001` 到数即停）|
| 导出后续批 | 旧：`id < ?` 游标；有过滤时缺索引会退化为 rowid 区间扫描 | 新：`(created_at,id) < (?,?)` 游标走同一索引，无排序临时表 |

`explain-audit`：新增 21 条 `audit.list_* / count_* / export_*` 语句（SQL 文本由 `server/lib/audit-view.js` 生成，与路由同一份），其中 12 条声明 `expectIndex`；**没有迁移 065 时这 12 条全部报红，有 065 时 0 违规**（`tests/audit-logs-view.test.mjs` 断言两侧）。`audit_logs` 已加入 `GROWTH_TABLES`（不看行数）。

### 已知残余（未解决，不要读成已解决）
- **（AB3 更新：≥3 字符且命中稀少的关键词现在走 FTS5，见下方 AB3 一节；2 字关键词与命中很多的关键词仍是下面描述的 LIKE 行为。）** **关键词是子串匹配**（`LIKE '%x%'` 于 action / entity / user_name），任何索引都帮不上：命中多时靠 `LIMIT` 早停，**命中稀少时仍读全表**。已把范围收窄（不再搜 module / entity_id / detail）并要求至少 2 个有效字符；`explain-audit` 为 `audit.list_keyword` / `audit.count_keyword` 登记了带理由的豁免。组合 module / user 过滤（走索引）才会快。
- **仅按日期区间或仅按 action 过滤**没有可用索引（`created_at` 单列、`action` 不在三棵索引里）：沿 rowid 倒扫，区间越旧读得越多。需要时再评估 `(created_at)` 索引，代价是再多一棵写放大。
- **仅按 entity（不带 entity_id）**：Codex 复核实测，让它走 `idx_audit_entity` 要对全部命中行临时排序（10 万行内存库 0.15 ms → 48 ms），比不建索引还差，所以此形态用 `+entity = ?` 屏蔽该索引，仍沿 rowid 倒扫（与迁移前相同：命中多的类型凑够一页即停，命中稀少的类型读到整表）。带 entity_id 才走索引。
- 非字符串/含 `%` 的 `user` 子串过滤（按姓名）仍是整表扫描；纯数字现在只匹配 `user_id`（旧版也匹配 `user_name` 恰为该数字的行——行为收窄，已在代码注释中说明）。
- 只在 Mac mini 上、合成数据、机器带负载；`dmserver` 上的数字、真实长明细的库体积、HTTP 端到端导出时间均**未测**。

## AB3 审计日志关键词检索：迁移 067（FTS5）+ `created_at` 单列索引决定（**Mac mini / 合成 100 万行 / 非目标主机**）

脚本：`node scripts/bench-audit-logs.mjs --rows 1000000`（同 AA6 的库：100 万行、143 MB；065 之后继续应用 067，再临时建 `created_at` 索引量化，测完即删）。机器有负载（运行时 1 分钟负载约 14–22，同机并行其它工作流），**只看量级**。

### 迁移 067 做了什么
`audit_logs_fts(action, entity, user_name)`：FTS5 **外部内容**表（`content='audit_logs'`，tokenizer = `trigram`，子串语义与 `LIKE '%x%'` 一致、含中文），由 `audit_logs` 上的 INSERT / DELETE / `UPDATE OF action, entity, user_name` 三个触发器维护。`PRAGMA compile_options` 无 `ENABLE_FTS5`（或 trigram 不可用）时迁移是空操作且 `verify()` 为真，`audit-view.js` 查不到 `audit_logs_fts` 就走原 LIKE；`explain-audit` 为该回退登记了带理由的豁免（`audit.count_keyword_nofts` / `audit.list_keyword_nofts`）。
**何时走 FTS**（`keywordUsesFts`）：库里有 FTS 表、关键词 ≥3 字符（trigram 下限；2 字关键词走 LIKE）、且探测到命中稀少（≤2000 条）。命中很多时 FTS 反而慢（第一版无条件走 FTS 的实测：常见词 `APPROVE` 列表 0.2 → 22.6 ms，`module + 关键词` 0.09 → 144 ms，因为要物化全部命中 rowid），所以命中多时回退 LIKE（沿索引/rowid 倒扫，凑够一页即停）。两条路径返回的行完全相同（FTS 只缩小候选集，候选行再过一遍同一个 LIKE 谓词：trigram 对 Unicode 大小写不敏感而 LIKE 只折叠 ASCII，Codex 复核实测 `ÄBC` / `äbc` 两路径曾不一致，已修；`tests/audit-logs-view.test.mjs` 对一组含 FTS 语法、通配符、中文、大小写的关键词逐个比对，含 Unicode 大小写对）。

### 实测（ms；列表 = 第 1 页，计数 = 封顶 10 001；FTS 列含"命中是否稀少"的探测耗时）
| 关键词 | LIKE（仅 065）列表 / 计数 | 067 列表 / 计数 | 走的路径 |
|---|---|---|---|
| 稀有（`user499`，26 行）| 354 / 272 | **0.8 / 0.7** | FTS |
| 不存在（`zzqq`）| 116 / 193 | **0.09 / 0.10** | FTS |
| 常见（`APPROVE`）| 0.2 / 9.2 | 0.6 / 12.7 | 探测后回退 LIKE（多出的是探测开销）|
| 实体名（`ent7`，命中很多）| 0.3 / 53 | 1.9 / 100 | 探测后回退 LIKE |
| `module=rare_mod` + `user` | 0.09 / 0.02 | 0.7 / 0.5 | 回退 LIKE |

读法（诚实边界）：收益只在**命中稀少**的关键词（百毫秒 → 亚毫秒）；命中很多时 LIKE 本来就快，067 只多一次探测（本表 +0.4 ~ +47 ms，计数那一格最大；探测读到 2001 个命中即停，但若关键词的每个三元组都很常见而短语本身稀少，探测会读较长的倒排链，上界与一次 LIKE 扫描同量级）。

### 代价
- **建表 / 回填**：对 100 万行执行 067 的 `up`（含 `rebuild`）约 **2.7–3.9 s**（持写锁；`rebuild` 是单次写事务，升级演练 AA11 应把它纳入）。
- **库体积**：239 → 301 MB（**+62 MB / 100 万行，约 +26%**；trigram 把每个字段切成三元组，明细里的短字段也被索引）。
- **写放大**（交替轮次、独立库、逐行自动提交的 `insertAuditRow`，20 万行种子，5 轮 × 5000 行；µs/行，取最小值 / 中位数）：仅 065 **107 / 134**；065 + FTS **248 / 432**（**约 +140 µs/行，最小值口径 2.3×**；机器有负载，中位数抖动更大）；065 + `created_at` 索引 **104 / 215**（最小值与仅 065 持平）。复跑一次（机器较空闲，Codex 修复之后）：仅 065 **73 / 82**，065 + FTS **133 / 137**（最小值口径 **1.8×，约 +60 µs/行**），065 + `created_at` **81 / 95**——倍数随机器负载变化，量级稳定。绝对量级：一次业务写入追加 1–2 行审计，多付约 0.15–0.3 ms。不要拿"在同一个库上顺序比较"的写入耗时做结论：大批量建索引 / 回填之后 WAL 与页缓存状态不同，会把"之后"的写入测慢几倍（本脚本第一版就是这样测出 5× 的，已改为独立库交替）。
- 触发器在同一事务内更新索引；`DELETE FROM audit_logs`（保留清理）每行多一次索引删除。

### `created_at` 单列索引：**不建**（决定）
测量（同库，`audit_logs(created_at)`，与 AB6 的哈希链无关）：
| 形态（只有日期区间）| 无索引 | 有索引 |
|---|---|---|
| 1 天（2880 行）列表 / 计数 | 74.6 / 78.1 | **1.3 / 0.06** |
| 1 个月（>10 000 行）列表 / 计数 | 65.0 / 9.2 | **82.6** / 0.69 |
写放大：最小值与仅 065 持平（104 vs 107 µs/行）；库体积 +25–30 MB / 100 万行。
**不建的理由**：① 收益只在"窄日期区间"，而列表排序仍是 `id DESC`，宽区间时规划器选了该索引再对整段区间做临时排序，反而更慢（65 → 83 ms）；要让宽区间受益得把"只有日期"也并入 `orderOf` 的 `created_at DESC, id DESC` 序，那是另一个改动（连同导出游标）；② 常见的复核口径已经带 module 或 user（命中 065 的 `(module, created_at)` / `(user_id, created_at)`）；③ 本批 AB3 的边界是"只加 FTS 影子表与触发器"。**重新评估的条件**：出现"只按日期区间"的高频查询，或把 `orderOf` 扩展到日期过滤——届时单独开迁移（写成本已在上表量化，不是阻碍）。

### 仅 action 过滤
`action` 必须同时带 `module`（400，业务码 `AUDIT_ACTION_NEEDS_MODULE`，经 `bizFail`；列表与导出同一判据，`buildWhere` 自身也强制；前端提示"按动作过滤时必须同时填写模块"）。带 module 后走 `(module, created_at)` 索引，action 只是索引范围内的行过滤。

### 未覆盖
进程内计时（不含 HTTP / 鉴权）；单机单连接；合成数据（关键词分布不代表生产）；FTS 的 `integrity-check` 与长期碎片（`optimize`）未测；无 FTS5 构建的回退路径只在测试里模拟（`setFtsOverride(false)` 与 DROP 掉 FTS 对象），没有真正的无 FTS5 二进制可跑。

## AC5 审计 FTS 索引维护：`audit-fts-maintain.mjs` 在合成 100 万行库上的持写锁时间（**Mac mini / 合成 100 万行 / 非目标主机 / 单次墙钟 / 整机高负载**）

脚本：`node scripts/audit-fts-maintain.mjs --data-dir <临时目录> --industry cosmetic --rebuild|--optimize|--integrity-check`（用法与口径见 `docs/operations/audit-search.md`）。库：临时目录里 schema + 全部迁移，用 `bench-audit-logs.mjs` 导出的 `seed()`（唯一 INSERT 点 `insertAuditRow`，含 AB6 哈希链与 067 触发器）写入 100 万行合成审计（种子 20261024，写入 188 s），随后 `wal_checkpoint(TRUNCATE)`；库文件 451 MB（含 FTS 索引）；测完临时目录已删除（脚本自带 `rm -rf` 并打印确认）。
**机器有负载**（测量期间 1 分钟负载约 29–30，同机并行其它工作流）：**只看量级**。每个动作各跑一次（`rebuild` 跑两次）；`elapsed_ms` = 本进程 BEGIN→COMMIT 墙钟；`lock_probe` = 另一线程用自己的连接每约 1 ms 试 `BEGIN IMMEDIATE`（`busy_timeout=0`），`max_busy_span_ms` 为被挡窗口的下界、`max_blocked_ms` 为近似上界（见 `scripts/lib/lock-probe.mjs`）。

| 动作 | elapsed_ms | 写入者被挡（下界 / 上界，ms）| 探针撞上次数 / 窗口数 | 库文件（含 WAL）| 
|---|---|---|---|---|
| `--integrity-check` | 1142 | 1141 / 1144 | 680 / 1 | 451 → 451 MB（不变）|
| `--optimize` | 1314 | 966 / 969 | 524 / 1 | 451 → 508 MB（WAL 里待检查点的新页）|
| `--rebuild`（第 1 次）| **3335** | **3025 / 3028** | 1745 / 1 | 460 → 521 MB |
| `--rebuild`（第 2 次）| **4099** | **3727 / 3730** | 2201 / 1 | 460 → 521 MB |
| `--integrity-check`（重建后）| 1496 | 1494 / 1502 | 847 / 1 | 460 → 460 MB |

读法（诚实边界）：
- **100 万行重建约 3–4 s 持写锁**，与 AB3 记录的迁移 067 回填（2.7–3.9 s）同量级；全程一个被挡窗口，说明重建确实是单次写事务。这段时间内其它写入（每条审计写入、每次业务写）等待 `busy_timeout`（默认 5 s）：本次未超；目标主机更慢或库更大时可能超过 5 s，届时并发写入收到 `SQLITE_BUSY`——所以 `--rebuild` 应在低峰执行。读者不受影响（WAL，探针只量写入者）。
- `--integrity-check` 也持写锁（FTS5 的 `integrity-check` 是 INSERT 形式的命令），100 万行约 1.1–1.5 s；夜间可选步骤跑在合成库副本上，不影响在用库。
- 两次重建相差 0.8 s，主要是机器负载抖动，不是系统性差别；不要把任何一格当作承诺值。
- 合成数据的 detail 很短，真实库的 `action / entity / user_name` 三列更长时三元组更多，重建会更慢；这里没有测。
- `GML_AUDIT_FTS=0` 开关只影响查询路径，不影响上述任何数字。

## AA11 迁移升级演练：059–062 在合成 medium 库上的逐迁移耗时（**Mac mini / 合成数据 / 非目标主机 / 单次墙钟**）

脚本：`scripts/upgrade-rehearsal.mjs`（库：`scripts/lib/lock-probe.mjs`；测试：`tests/upgrade-rehearsal.test.mjs`）。它在备份集（或合成库目录，经 `db-backup.mjs` 备份成备份集）的**隔离恢复副本**上，从 `--from N` 基线起把编号 > N 的迁移**逐个**交给真实运行器（生产模式、暂存迁移目录里是仓库文件的字节级复制），每步记录耗时与写锁阻塞，升级后核对校验和 / 空操作重跑 / integrity / 外键 / 业务探针 / verify-seed 风格不变量，任一失败即回退（进程内重新恢复并比对 + 调用 ADR-0016 的 `upgrade-rollback-drill.mjs`）。可选夜间步骤见 `nightly-capacity.yml` 的 `rehearsal` 输入（默认 `false`，定时任务永不运行）。

### 基线截断怎么做，为什么不绕过校验和与自愈

- `--from 58` ＝ 编号 ≤ 58 的迁移视为已应用，059–062 重放。工作副本上只做两件事：`DELETE FROM schema_migrations WHERE 编号 > 58`；`DROP INDEX` 那些"仓库里编号 > 58 的迁移创建、基线迁移不创建"的索引（内存库跑 schema.sql + 迁移 ≤58 得到集合 A，再跑全部迁移得到集合 B，只删 B−A 且存在于副本里的索引；本次删 25 个：059 的 21 个、060 的 1 个、061 的 3 个）。表/列不删（删列有损数据），所以 060/062 这类"加列 / 写字典行"的迁移在副本里是对现成结构的幂等重放——报告的 `structure_preexisting` 逐步标明（false = 真正新建，true = 空转）。
- **不改任何校验和，不调用 adopt。** ≤58 的行保留原校验和，运行器第一遍照常与暂存文件比对，不一致则生产模式在任何写入前 `MIGRATION_CHECKSUM_MISMATCH`。被删的行（>58）先与当前文件比对再删，不一致判 `PRE_UPGRADE_CHECKSUM_MISMATCH`（否则截断会抹掉"这个库在生产上启动会被拒绝"的事实）。重放的行由运行器按当前文件重新登记（origin=applied）。
- 自愈：每步记录 `healed`；> 基线的迁移被自愈 ＝ up 与 verify 不自洽，判失败；≤ 基线的只记警告。
- 想演练**真正的旧库**（表/列也不存在），用旧版本代码产出的备份集——它的版本表本来就缺这些行，`--from` 取其最高已应用编号。

### 口径

`duration_ms` ＝ 一次 `runMigrations` 调用的墙钟（含对暂存目录的校验和核对与已登记迁移的 `verify()`）；`overhead_ms` ＝ 紧接着再调一次（必须是空操作，否则判失败）的墙钟；`net_ms ≈ duration − overhead`，**抖动很大（负载 30–50 的机器上经常为 0），只看 `duration_ms`**。写锁：worker 线程里另一个连接每约 1 ms 做一次 `BEGIN IMMEDIATE; COMMIT`（`busy_timeout=0`）。每个"被挡窗口"记两个数，**真实持锁时长落在两者之间**（再加线程调度噪声）：`busy_span`＝第一次到最后一次失败尝试的间隔（下界），`blocked`＝上一次成功到下一次成功的间隔（近似上界，高负载下可能明显偏大）。写入者视角；WAL 下读者不被挡，本演练不量读者；单迁移单事务，粗上界看 `duration_ms`。

### 数据与结果

输入：`synth-data.mjs --skus 20000 --docs 30000 --txns 150000`（medium；6,667 商品 / 12,000 采购单 / 18,000 销售单 / 150,000 库存流水；库文件 236,937,216 字节 ≈ 226 MiB，种子 20261023）生成后，`upgrade-rehearsal.mjs --from=58 --synth-dir=…`。机器：Mac mini（Apple M4，10 核，16 GB，Node v22.22.1），**测量时整机负载平均值约 17–50（其他任务并行）**，数字只能看量级。以下是最终代码上同一份库连跑两次（运行 5、运行 6）；此前用较早版本的脚本（探针只有 `blocked` 一个口径）还跑过四次，059 耗时 447 / 561 / 993 / 1023 ms，量级一致。

| 迁移 | 结构原本存在 | 运行 5：耗时 / 写锁（busy_span–blocked） (ms) | 运行 6：耗时 / 写锁（busy_span–blocked） (ms) | 说明 |
|---|---|---|---|---|
| 059_indexes | false（先删了 21 个它创建的索引） | 337.6 / 277.5–280.5 | 415.0 / 349.6–352.9 | 真实建索引；写锁占耗时的约 80–85% |
| 060_qimen_secrets | false（先删了它创建的 1 个索引） | 34.4 / 0–0 | 36.2 / 0–3.3 | 小迁移；基本没撞上锁 |
| 061_hot_query_indexes | false（先删了它创建的 3 个索引） | 43.1 / 24.4–27.1 | 135.9 / 73.9–80.5 | 真实建索引 |
| 062_audit_view_permission | **true** | 16.8 / 0–0 | 41.2 / 0–0 | 权限字典行已存在，空转重放，耗时**不代表**升级成本 |
| 合计（4 步） | | 431.9 | 628.3 | |

两次运行都通过全部核对且 `warnings` 为空：`checksums_verified`（59/59）、`repo_files_match_registry`、`production_rerun_is_noop`、`registry_covers_all_migrations`、`integrity_ok`、`foreign_keys_not_worse`（0→0）、`probes_retained`（users 1 / products 6667 / purchase_orders 12000 / receipts 0 / ar_open_balance 0 前后相同）、`seed_invariants_not_regressed`（24/24 绿 → 24/24 绿）。其他耗时（运行 5 / 6）：合成库备份 3.9 / 3.7 s，恢复复制 0.3 / 0.4 s，索引集差异计算 1.2 / 0.8 s，verify-seed 风格不变量升级前 137 / 102 s、升级后 109 / 80 s（占总耗时 258 / 192 s 的绝大部分，与迁移本身无关）。库文件大小升级前后相同（删掉的 25 个索引腾出的页被重建复用）。

**读法**：15 万行流水量级的 medium 库，059 建索引在这台机器上约 0.3–1.0 s、持写锁约 0.3–0.85 s；这是"另一个写入者最坏要等多久"的量级，不是 SLA。**没有在 `dmserver` 上测过，没有用真实规模或真实分布的数据测过，没有测读者，没有测并发业务写入与迁移同时进行时的 `SQLITE_BUSY` 次数**（Y7 的写路径基线是另一件事）。六次运行里 059 在 0.34–1.02 s 之间波动，说明单次数字只能看量级；要引用请在目标主机上重复多次取分布。

### 失败路径的证据（夹具规模，`tests/upgrade-rehearsal.test.mjs`）

用 `--extra-migrations-dir` 追加一个"先建表、写行、再抛错"的 `900_rehearsal_failing.cjs`（只复制进暂存目录，永不写进 `server/db/migrations/`）：059–062 先应用，第 900 步失败 ⇒ 退出码 1，报告记录失败步骤与错误，进程内回退（删副本、重新核对 sha256 复制、版本表与升级前逐字段相同、探针相同、integrity ok）与 ADR-0016 回退演练（退出码 0，全部不变量成立）都通过，工作副本里没有半截表、没有 900 行。另有：备份里被篡改的已登记校验和（≤基线与>基线各一例）⇒ `PRE_UPGRADE_CHECKSUM_MISMATCH`、一个迁移都不尝试；`--from` 高于库内真实版本 ⇒ `REHEARSAL_BASELINE_NOT_APPLIED`（退出码 2）；版本表里有登记行而仓库没有对应文件 ⇒ `PRE_UPGRADE_REGISTRY_FILE_MISSING`（截断会把它的校验和历史一并抹掉，所以先拒绝）；一个 `verify()` 与 `up()` 不自洽的迁移，紧接着的核对调用若发生自愈即判失败（不会被悄悄修好）；合成库副本 settings 里指向别处的 `backup_dir`/`backup_keep` 在副本里被改回迁移 020 的缺省值，备份不会写到或裁剪目标目录之外的任何目录。

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

## AA5 看板瓶颈剖析与低库存口径统一（**Mac mini / 合成 medium 库 / 非目标主机**）

> **范围声明**：同 Z3——Mac mini，合成 `medium` 库（`--skus 20000 --docs 30000 --txns 150000`，种子 20261023；2 万 SKU / 84 736 库存行 / 15 万流水），**不是 `dmserver` 结果、不是容量承诺、不是验收证据**。**测量时整机负载极高（`uptime` 15 分钟平均负载约 45–50，同时有其它工作流在跑测试），绝对数字偏大且抖动大**，所以每行都给原始值，并优先看同一轮里"前 / 后交错"的对比。库用 Z3 的"增强库"口径（`safe_stock=(id%5)*40`，1.6 万 SKU 设了安全库存；经销商 `credit_limit=100000`），否则安全库存全 0 看不出低库存查询的代价。

### 逐块计时（`GML_PROFILE=1`，串行请求，增强库，中位数 ms）
方法：`server/lib/profile.js` 在 `GET /dashboard/summary` 的每个查询块上计时并写一行 `profile_blocks` 日志（响应体不含）；起一个本机测试模式服务，串行请求 30–40 次取中位数。"前"= 本分支基线（Z3 之后的 `dashboard.js`，仅加了计时），"后"= 缓存关闭（`GML_DASHBOARD_CACHE_MS=0`）下的新查询，即**未命中缓存的冷路径**。

| 块 | 前 | 后（冷路径） | 备注 |
|---|---|---|---|
| `inventory`（SUM + SUM + COUNT DISTINCT）| **49.6** | 19.4 / 19.9（两次）| **唯一 ≥50 ms 的块**；拆成"求和"+"覆盖索引上去重计数" |
| `below_safe`（`countBelowSafe`）| 8.2 | 8.8 / 10.0 | Z3 的口径，未再改 |
| `lastMonth` | 4.2 | 3.8 / 3.9 | `substr(order_date,1,7)` 不能走索引，量级小 |
| `receivable` | 2.5 | 3.0 / 3.9 | |
| `payable` | 1.6 | 1.6 | |
| `alertsRow`（待办 5 项计数）| 0.28 | 0.27 | |
| `today` / `month` / `purchaseMonth` / `omsMonth` | < 0.1 | < 0.1 | |
| 处理器总计（中位数）| 74.5 | 54.6 / 56.2 | 负载下中位数不可相加，仅作量级 |
| HTTP 中位数（串行）| 85.2 | 61.8 / 64.0 | |

同一进程里对 `inventory` 块做 A/B（同一时刻，消除负载差）：原语句 **142 ms**（`SCAN inventory_stocks` + `USE TEMP B-TREE FOR count(DISTINCT)`）→ 求和 34.6 + 去重计数 4.4 = **39 ms**（`SCAN inventory_stocks USING COVERING INDEX idx_stock_sku`，无临时树）；两种写法在 medium 库上结果都是 19 917 个 SKU。覆盖索引 `(sku_id, qty_on_hand, cost_price)` 试过：求和 83 → 24 ms，但给写入最热的表再加一棵索引不值，**没有做迁移 064**（理由见 ADR-0044）。

### `bench-api` p95（`--concurrency 4 --iterations 100`，每次用同一份预热库的新拷贝，前 / 后交错）
| 接口 | 前（原始值 ms，p95）| 前 p95 中位数 | 后：缓存开（默认）| 后 p95 中位数 | 后：缓存关（冷）|
|---|---|---|---|---|---|
| GET /api/dashboard/summary（增强库）| 551.2 / 822.3 / 803.0 / 676.6 | **≈ 740** | 49.6 / 40.4 / 41.7 | **41.7** | 397.6 / 426.1 |
| GET /api/dashboard/summary（原样合成库，安全库存全 0）| 657.2 | — | 69.7 | — | — |
| GET /api/dashboard/summary p50（增强库）| 297 / 448 / 503 / 422 | ≈ 435 | 4.9 / 2.3 / 2.5 | 2.5 | 234 / 278 |
| GET /api/inventory/stocks（未改，噪声参照）| 219 / 223 / 235 / 263 | ≈ 229 | 225 / 296 / 248 | 248 | — |
| GET /api/meta/health（噪声参照）| 17.9 / 4.1 / 5.7 / 8.4 | — | 12.9 / 5.9 / 7.0 | — | — |

读法与诚实边界：
- **目标 p95 < 150 ms 达成（41.7 ms），但靠的是缓存命中**。`bench-api` 并发 4 打同一个只读接口，基本全是命中；冷路径（缓存关）p95 仍约 400 ms。原因是 Node 单线程、同步 SQLite：处理器约 55 ms（本机高负载下），4 个并发请求排队，p95 ≈ 4–7 个处理器耗时。冷路径相对"前"从 ≈ 740 降到 ≈ 410，方向与 `inventory` 块 50 → 19 ms 一致；但两组各只有 2–4 次、负载在变，**幅度只能当量级**。
- 缓存在写入后立即失效（见 ADR-0044），所以真实使用里每次库存 / 订单写入后的第一次读取走冷路径，约 55 ms 量级（串行）。写入频繁的实例命中率会低。
- `inventory/stocks` 的 ≈ 230–250 ms 是本轮的负载底噪（Z3 记录的 140–150 ms 是另一轮的数字），不可跨轮比较；它没有改动，只作参照。
- 0 错误，`SQLITE_BUSY` 0。

### `explain-audit`（medium 库）
66 条语句（`dash.stock_total` 拆出 `dash.stock_sku_count`），**0 违规**，豁免 16，索引全扫 3。

### 低库存口径统一（不涉及性能数字）
指标 `below_safe`、AI `stock_alert`、MCP `inventory.stock_alert` 改调 `countBelowSafe` / `listBelowSafe`；口径差异逐条见 ADR-0044（指标不再计停用 SKU；MCP 含无库存行的缺货 SKU、范围依据改为仓库所属组织）。medium 增强库上缺货 SKU 为 186 个（与 Z3 相同），`listBelowSafe(-1)`（AI 不限行数）返回这 186 行，约 227 ms（负载下单次）；原写法同样无 LIMIT，行为不变。

### 仍未覆盖
- `dmserver` 上用生产规模副本复跑；large 规模未跑。
- `/dashboard/trend`、`/top`、`/todos`、`/inventory-dist` 等其它看板接口未剖析、未缓存。
- 缓存只在单进程内；多进程部署时每个进程各有一份，靠 `data_version` 感知其它进程的提交（已测两个连接，未做多进程实测）。

## AB11 large-ci：托管 runner 上的 10 万 SKU / 100 万流水（**机制已就绪，大规模本身尚未运行**）

> **范围声明**：本节记录的是 `large-ci` 的**机制与结果 JSON 形状**。大规模运行（10 万 SKU / 100 万流水）**没有在本机执行**（Mac mini 磁盘与负载都不允许），所以这里**没有任何 large-ci 的容量数字**。唯一实测的是下面的"冒烟"：5 000 SKU / 5 万流水，仅证明分批 + 预算路径能走通，**不是 large 运行、不是容量证据、不是目标主机（`dmserver`）结果**。首次真实 large-ci 运行要等 `nightly-capacity.yml` 手动触发（`scale=large-ci`）。

### 怎么用
- 本地/流水线：`node scripts/synth-pipeline.mjs --dir <绝对新目录> --profile large-ci [--time-budget 240] [--out <报告>]`。`large-ci` 默认 `--skus 100000 --txns 1000000 --docs 100000 --batch-txns 200000 --min-free-mb 3072`；显式给的参数永远覆盖默认。
- 工作流：`nightly-capacity.yml` 的手动输入 `scale` 增加选项 `large-ci`（默认仍 `medium`，定时运行不受影响）；选它时作业超时 355 分钟（GitHub 上限 360），生成预算 `--time-budget 240` 分钟，其余步骤（备份、两次恢复演练、explain-audit、压测、写档压测）在剩余时间内跑。
- 新步骤 `Large-ci report` 只从原始流水线报告打印固定格式行：`partial`/原因/达到规模、`explain_audit violations=`、逐接口 `p50/p95/p99/errors`（p95 表）。现有 `Gate` 不变（违规或错误仍然红）；AC8 起 `capacity-summary.mjs` 对 large-ci 也输出 `scale: "large-ci"`、`profile`、`partial`、`partial_reason`（仅 `time_budget`/`disk_low`/`null`，其余记 `?`）与 `reached`（`skus/txns/txns_target/docs/docs_target`），此前 `scale` 显示 `?`。

### 分批与守卫（`synth-data.mjs`）
- `--batch-txns N`：每当 `inventory_transactions` 的最大 rowid 越过 N 的整数倍（在单据事务之外的循环边界检查），先 `wal_checkpoint(TRUNCATE)`，再 `VACUUM`，再 checkpoint。目的是控制 WAL 与空闲页，不是改数据：同种子下分批与不分批的 `digest` 相同（测试断言）。
- 磁盘守卫：`VACUUM` 在 WAL 模式下峰值额外占用约 2 倍库大小，所以边界处若可用空间 < `2.2 × 库大小 + --min-free-mb` 则**不做 VACUUM 而直接停止**（`partial_reason: disk_low`）；另外在第 1 个循环迭代、之后每 200 个迭代与每个边界检查一次 `可用空间 < --min-free-mb`；`statfs` 读不出来时按「不安全」处理，直接停止（`disk_low`），VACUUM 跨过时间预算时同样立刻停止。
- `--time-budget M`（分钟，可小数，仅约束**生成阶段**）：到点后在下一个循环边界停止，后续阶段整体跳过；已提交的单据完整，仍照常做不变量校验（校验与 VACUUM 的收尾时间不计入预算，流水线给生成步骤的进程超时是"预算 + 30 分钟"）。
- 流水线在 `large-ci` 下为省磁盘（runner 约 14 GB）：每次恢复演练结束立刻删除恢复出的整库副本，两次演练后删除备份目录。**这些都没有在大库上验证；估算峰值约为库大小的 4 倍（数据 + 明文备份 + 加密备份 + 演练副本），100 万流水库约 1.5–2.5 GB（由冒烟库 5 万流水 68 MB 外推，未验证）。**

### 结果 JSON（`pipeline-report.json` 新增字段，`schema_version` 仍为 1，旧字段不变）
| 字段 | 含义 |
|---|---|
| `profile` | `"large-ci"` 或 `null` |
| `partial` | 生成因预算或磁盘守卫提前停止则为 `true`；否则 `false`。**partial 时 `ok` 仍可为 true、进程退出码 0（作业保持绿色），但报告对象是"已达到的规模"** |
| `partial_reason` | `"time_budget"` / `"disk_low"` / `null`（`synth-summary.json` 另有 `partial_phase`：停在 purchase/sales/adjust） |
| `reached` | `{skus, txns, txns_target, docs, docs_target}`：来自库内真实行数 / 已创建单据数，不是目标值 |
| `batching` | `{batch_txns, vacuums, vacuum_ms, min_free_mb, free_mb_min_seen}` |
| `steps.explain_audit.violations` | 索引审计违规数（与原有字段相同） |
| `steps.bench_api.endpoints[]` | `name/route/requests/errors/p50/p95/p99`（p95 表的来源） |

读法：`partial: true` 时所有 p95 与违规数都只对 `reached` 那个规模成立，不能当作 100 万流水的结果；`txns` 达到目标的 `partial: false` 才是完整 large-ci。

### 冒烟（**不是 large 运行**）
Mac mini，`--profile large-ci --skus 5000 --txns 50000 --docs 5000 --batch-txns 20000 --time-budget 20 --iterations 30 --concurrency 4`，临时目录，测完删除。测量时整机负载很高（loadavg 起始 26.6）。结果：`ok: true`、`partial: false`、`reached` 5 000 SKU / 50 000 流水 / 5 000 单据；`vacuums: 2`（`vacuum_ms` 3 161）；库 68 186 112 字节；生成 164.6 s（purchase 32.8 s / sales 101.6 s / adjust 19.5 s / verify 8.9 s）；`explain_audit` 0 违规；压测 10 个接口 0 错误，p95（ms）：login 3 828（含密码哈希，负载下）、dashboard_summary 59、purchase_order_list 20、stock_query 57、report_operating 148，其余 < 16。这些 p95 是冒烟库上高负载下的单次读数，**不可与 Y10/Z3 的 medium 数字比较**。另有测试覆盖：分批（digest 不变）、时间预算（`partial: true`、退出码 0、不变量仍绿）、磁盘守卫、流水线 partial 报告。

### 未验证
大规模运行本身；runner 上的磁盘峰值与 355 分钟内能否跑完全部后续步骤；`bootAll` 预热在百万流水库上是否撞 1 小时步骤超时；`GITHUB` 托管 runner 的 `statfs` 余量读数。

## AB6 审计日志哈希链：迁移 068 回填 + 写入开销 + 校验 + 归档（**Mac mini / 合成 100 万行 / 非目标主机 / 机器有负载**）

数据：与 AA6 同一套 `syntheticRow` 合成行（`scripts/bench-audit-logs.mjs` 导出），100 万行 `audit_logs`，先按 AA6 的状态（含 065 的三棵索引、无 068）建好，再对它执行 068。机器负载：运行时 1 分钟负载约 18（同机并行跑着其它工作流），只看量级；同一代码多次测量的差异见括号。库文件：244 MB → 391 MB（每行多两个 64 字符十六进制 + 其索引外开销，约 +60%）。

| 项 | 结果 |
|---|---|
| 迁移 068 `up`（建列 + 锚点表 + 回填 100 万行，持写锁）| **8.6 s**（另两次 11.5 s、16.5 s；负载抖动，量级 10 s）|
| `audit-verify-chain` 全表校验 100 万行（只读）| **3.0 s**（3.0–4.2 s）|
| 追加 2 万行，事务内，每千行耗时：链式 vs 同表原写法 | 约 **51–95 ms vs 34–54 ms**（每行 +20–40 µs：一次小查询 + 一次 SHA-256 + JSON 规范化）|
| 单条 autocommit 审计写入（`BEGIN IMMEDIATE … COMMIT`）| 每千条 123–176 ms（WAL 提交主导，与原写法同量级）|
| `audit-archive` 100 万行（验证 + 导出 422 MB JSONL + 读回校验 + 删除 + 锚点 + 剩余链校验，单个写事务）| **28 s** 墙钟（持写锁）；归档后剩余 22 001 行校验 0.2 s |

读法与边界：
- 第一次在语句里每次 `prepare` 三条语句时链式写入慢到 174 µs/行；改为按连接缓存语句、去掉嵌套事务包装后降到上表量级。
- 回填在迁移事务里完成；若部署库有千万级审计行，需要把迁移放进维护窗口（线性外推：每百万行约 10 s）。
- 归档期间写入被阻塞（busy_timeout 5 s 内排队，超过则 500）；这是单事务保证“导出的就是删除的”的代价，运维手册要求低峰执行。
- 未在目标主机（dmserver）测；未测 HTTP 端到端的审计写路径延迟。

## AB2 看板其余接口剖析、缓存与多进程失效（**Mac mini / 合成 medium 库 / 非目标主机**）

> **范围声明与负载（务必连同数字一起读）**：Mac mini；合成 `medium` 库（`synth-data.mjs --skus 20000 --docs 30000 --txns 150000`，种子 20261023，在隔离临时目录生成，用完删除；2 万 SKU / 84 736 库存行 / 15 万流水 / 1.8 万销售单），在**副本**上按 AA5 的"增强库"口径（`safe_stock=(id%5)*40`、经销商 `credit_limit=100000`）并把分类标记改为 `test`、跑过一次 `bootAll` 演示种子。**测量时整机负载极高（`uptime` 1 分钟平均负载 32–48，多个工作流同时在跑测试）**，绝对数字比空闲机器大数倍且抖动大；每轮"前 / 后（缓存关）/ 后（缓存开）"交错执行 3 轮，表里给 3 轮中位数，原始值见下。**不是 `dmserver` 结果、不是容量承诺、不是验收证据。**
>
> 负载生成器是一次性脚本（并发 4 个连接、每接口 100 次 + 1 次预热，打 `GET /api/dashboard/{trend,top,todos,inventory-dist}` 默认参数；`bench-api.mjs` 的固定十条端点不含这四个，本工作流不改它）。"前" = `batch-ten` 源码（`git archive` 出来的另一份树）；"后" = 本分支。每次用同一份预热库的新拷贝、新进程。缓存开的 100 次里只有预热那一次是未命中，所以这一列是**纯命中**路径，不代表真实使用（任何写入之后第一次读走冷路径）。

### 逐块计时（`GML_PROFILE=1`，串行，缓存关，中位数 ms）
| 块 | 前（负载约 20）| 后（负载约 46）| 同进程 A/B（同一时刻）|
|---|---|---|---|
| `top.products` | **84.3** | 37.9 | 55.1 → 21.3 |
| `top.brands` | **83.1** | 36.9 | 29.0 → 12.4 |
| `top.dealers` / `stores` | 3.8 / 0.6 | 4.2 / 0.9 | 未改 |
| `inventory-dist.byWarehouse` | **99.6** | —（合并为 `stockAgg`）| |
| `inventory-dist.byCategory` | **114.0** | —（合并为 `stockAgg`）| 两条合计 218.5 → 一条 145.9（负载约 40）|
| `inventory-dist.stockAgg`（一遍扫描）| — | **164.6** | |
| `todos.stockAlerts` | 15.7 | 15.8 | < 50 ms，未动 |
| `todos` 其余 4 块 | < 1.4 | < 1.3 | |
| `trend.sales` / `purchase` / `online` | 1.45 / 0.05 / 0.02 | 1.41 / 0.05 / 0.02 | `trend` 全程 < 2 ms，无热点 |

"前 / 后"两列负载不同（后一次机器更忙），所以只有"同进程 A/B"列是可比的。≥ 50 ms 的块：`top.products`、`top.brands`（改写后同进程测 < 25 ms）、`inventory-dist` 的两块（改写后仍是最重的一块：扫 8.5 万行宽表的下限，在本机忙时 > 100 ms，**没有达到 < 50 ms**，靠缓存挪出请求路径）。

### HTTP 延迟（并发 4，每接口 100 次，ms；3 轮中位数，括号内为 3 轮原始值）
| 接口 | 前 p50 | 前 p95 | 后·缓存关 p50 | 后·缓存关 p95 | 后·缓存开 p50 | 后·缓存开 p95 |
|---|---|---|---|---|---|---|
| `/dashboard/trend` | 9.0 (8.8/9.0/14.2) | 42.0 (67.7/25.0/42.0) | 7.0 (7.0/5.8/10.9) | 24.8 (24.2/24.8/48.4) | 4.7 (3.9/4.7/5.1) | 20.6 (13.0/20.6/25.0) |
| `/dashboard/top` | 421.6 (386.3/421.6/554.3) | 758.8 (755.3/758.8/871.3) | 305.6 (305.6/254.5/338.9) | 487.2 (487.2/433.1/520.1) | 3.0 (4.5/3.0/3.0) | 15.6 (15.6/8.4/16.9) |
| `/dashboard/todos` | 63.4 (63.4/53.1/96.4) | 105.2 (105.2/86.3/171.4) | 67.6 (63.7/67.8/67.6) | 136.8 (142.1/120.2/136.8) | 4.4 (2.6/4.4/4.5) | 14.1 (8.0/18.1/14.1) |
| `/dashboard/inventory-dist` | 831.0 (831.0/800.6/1249.3) | 1268.9 (1268.9/1144.7/2344.9) | 625.0 (625.0/590.4/793.6) | 1052.9 (1052.9/918.7/1131.7) | 3.4 (4.4/3.4/2.7) | 14.6 (14.6/13.1/15.9) |

读法与诚实边界：
- **缓存命中后四个接口 p95 都在 ~8–25 ms**（对比之前 40–1270 ms）；这是命中路径，冷路径见"缓存关"列。
- **冷路径**：`top` p95 约 760 → 490 ms（SQL 改写，方向与逐块结果一致）；`inventory-dist` 约 1270 → 1050 ms，改善有限（仍是整表聚合，且并发 4 时排队）；`trend` 本来就快，差异在噪声内；`todos` 的"后·缓存关"比"前"略差（137 vs 105 ms p95），**该接口的查询没有改动**，差别是负载抖动，不要读成回退。
- 单线程 Node + 同步 SQLite：4 个并发请求排队，p95 ≈ 3–5 个处理器耗时，所以 `inventory-dist` 的 p50（~600 ms）远大于其处理器耗时（~150 ms）。
- 0 个错误（4 个接口 × 3 轮 × 3 档，全部 200）。

### 多进程失效（功能验证，非性能）
`tests/dashboard-perf.test.mjs` 起第二个真实 `server/index.js` 进程（同一数据目录，随机端口）写入，被测进程的四个接口全部失效并立即反映新数据（`PRAGMA data_version`）；另起一个独立 `node` 进程直接用 SQL 写单据，三个接口立即反映。细节见 ADR-0044 补充。

### 仍未覆盖
- `dmserver` 上用生产规模副本复跑；large 规模未跑；机器空闲时的数字未取（本轮全程高负载）。
- `/dashboard/channel`、`/dashboard/recent` 未剖析、未缓存（**AC4 已补**，见下节）。
- `explain-audit` 未登记 `/top`、`/inventory-dist` 的新语句（**AC4 已登记**，见下节）；`explain-audit`（对本合成 medium 库、只读）：87 条既有语句，**0 违规**，裸 SCAN 21（豁免 20、小表 1），索引全扫 5——这个结果不覆盖新语句。

## AB5 真正旧结构库上的 059–066 逐迁移耗时（**Mac mini / 合成 medium / 非目标主机 / 单次墙钟 / 整机高负载**）

脚本：`scripts/schema-snapshot.mjs`（ADR-0048）产出"版本 58 备份集"，再 `upgrade-rehearsal.mjs --from=58 --backup-dir=<集>/data/backups`。与 AA11 的区别：这里**没有截断**（报告 `baseline_registry.truncation='skipped'`，`registry_truncated=[]`，`indexes_dropped=[]`），库的表、列、索引、字典行本来就是 58 版的，所以 059–066 的 `structure_preexisting` **全部为 false**（AA11 里 062 是 true，耗时不能代表升级成本）。

### 数据与口径

快照：`schema-snapshot.mjs --upto=58 --synth=medium`（`synth-data.mjs --skus 20000 --docs 30000 --txns 150000`，种子 20261023）在最新结构里生成，再拷进旧结构库：1,272,489 行 / 192 张表；`permissions` / `role_permissions` 因迁移 >58 会改动而**不拷**；拷后 `foreign_key_check`=0、verify-seed 风格不变量 24/24 绿；商品 6,667 / 采购单 12,000 / 库存流水 150,000 / 库存行 84,736 / `doc_events` 170,747；**`audit_logs` 只有 1 行**（合成数据不写审计流水）。cosmetic 备份 221,999,104 字节（≈212 MiB），food / apparel 各 2.7 MB（只有结构与指纹，无业务数据）。快照耗时：建三库 1.6 s、合成生成 608 s、拷入+不变量校验 308 s、备份 4.5 s（共 923 s，**整机负载平均值 26–47**，其他任务并行，所以这些是上界量级）。

同一份快照连跑两次演练（运行 1、运行 2），机器：Mac mini（Apple M4，10 核，16 GB，Node v22.22.1）。下面是 **cosmetic 库**（food / apparel 为空库，各步 29–65 ms，是纯运行器开销）：

| 迁移 | 性质 | 运行 1：耗时 / 写锁（busy_span–blocked）(ms) | 运行 2：耗时 / 写锁 (ms) |
|---|---|---|---|
| 059_indexes | 21 个索引（真建）| 389.1 / 321.6–325.2 | 617.8 / 531.5–534.4 |
| 060_qimen_secrets | 2 列 + 1 表 + 1 索引 + 权限行 | 58.9 / 22.9–25.7 | 46.2 / 3.0–6.3 |
| 061_hot_query_indexes | 3 个索引（真建）| 103.7 / 48.0–51.3 | 138.8 / 78.7–84.0 |
| 062_audit_view_permission | 权限字典行 | 37.1 / 0–0 | 47.5 / 0–0 |
| 063_approval_template_perm | 权限字典行 | 37.2 / 0–0 | 42.8 / 0–0 |
| 065_audit_log_indexes | 3 个索引，但 `audit_logs` 仅 1 行 | 34.5 / 0–0 | 57.7 / 0–0 |
| 066_pos_settle_permission | 权限字典行 | 41.3 / 0–0 | 55.1 / 0–0 |
| 合计（7 步）| | 701.8 | 1005.9 |

两次都通过全部核对且 `warnings` 为空：`checksums_verified`（62/62）、`production_rerun_is_noop`、`registry_covers_all_migrations`（62 行）、`integrity_ok`、`foreign_keys_not_worse`（0→0）、`probes_retained`（users 1 / products 6667 / purchase_orders 12000 前后相同）、`seed_invariants_not_regressed`（24/24 → 24/24）。库文件 221,999,104 → 236,957,696 字节（+15 MB，新建索引的页）。演练总耗时 340 s / 475 s，其中 verify-seed 风格不变量占绝大部分（升级前 197 / 284 s、升级后 131 / 175 s；高负载下），迁移本身 1.3 / 2.0 s。

### 读法与诚实边界

- 与 AA11（截断路径，059 约 0.34–1.02 s）量级一致：059 是主要成本，在 15 万行流水量级约 0.4–0.6 s、持写锁约 0.3–0.55 s；060 / 061 是几十到一百多毫秒；其余是字典行 upsert。063 / 066 以前没有测过，这里是第一次。
- **065 的数字不代表审计表大时的成本**：合成库的 `audit_logs` 只有 1 行，三棵索引几乎是空建。AA6 在 100 万行审计表上单独测过 065 的 `up` 约 5.1 s（见上文 AA6 一节）；本次没有把合成审计行灌进旧结构库。
- 单次墙钟，**整机平均负载 26–47**；059 在两次间相差 1.6 倍，只能看量级。没有在 `dmserver` 上测，没有真实规模/真实分布的数据，没有测读者，没有测并发业务写入与迁移同时进行时的 `SQLITE_BUSY`。
- 结构是**今天的** `schema.sql` + 迁移 ≤ 58，业务数据由今天的领域函数写入后拷入（只含两边都有的列），不是"58 版本代码当年写出的数据"。
- `nightly-capacity.yml` 的 `snapshot_upto` 输入只验证了 YAML 语法与静态策略测试，**尚未在 GitHub 上执行**。

```sh
node scripts/schema-snapshot.mjs --upto=58 --synth=medium --out=/abs/new-dir
node scripts/upgrade-rehearsal.mjs --from=58 --backup-dir=/abs/new-dir/data/backups --target-dir=/abs/empty/rehearsal
```

## 托管 runner（AB9：`nightly-capacity.yml` 在 GitHub 托管 runner 上的首次手动演练）

**状态（AC8，2026-10-24）：未能触发，下表全部待填（原因）。** 本节只登记触发方法与待填结果；没有任何托管 runner 的数字被写在这里。托管 runner 是共享虚拟机 + 合成数据 + 单次运行，数字只作趋势参考，**不是 `dmserver` 目标主机结果，不是容量承诺**；工作流只上传白名单的 `capacity-summary.json`，下表只抄摘要里的字段，不贴原始报告、库文件或日志。

### AC8 触发尝试记录
- 检查：`gh api repos/osborn-studio/OS-ERP/contents/.github/workflows/nightly-capacity.yml?ref=main` 返回 HTTP 404，即 `main` 上**根本没有** `nightly-capacity.yml`（`main` 的工作流只有 `CI` 与 `OS ERP Linux validation`，`gh workflow list` 同）；该文件只存在于 `feat/batch-eleven`（PR #7 未合并）等分支，该分支上含 `scale=large-ci`、`rehearsal`、`snapshot_upto` 三个输入。
- 尝试：`gh workflow run nightly-capacity.yml --ref feat/batch-eleven -f scale=small` 被 GitHub 拒绝：`HTTP 404: workflow nightly-capacity.yml not found on the default branch`。`workflow_dispatch` 只对默认分支上已存在的工作流文件开放，分支上的新工作流在合入默认分支前无法手动触发，也无法被定时触发。
- 因此**一次运行也没有派发**（已派发 0/3；被拒绝的请求不产生 run id），三次规定运行（`rehearsal=true snapshot_upto=58`、`scale=large-ci`、默认）全部未执行。
- 修复建议（需要用户决定，AC8 未改仓库设置也未改工作流）：合并 PR #7（或把 `nightly-capacity.yml` 单独 cherry-pick 进 `main`）之后，再按下面的命令触发三次；合并前在 PR 分支上无法验证该工作流能否在 GitHub 上跑通。

### 触发（合入 `main` 之后；只用 `gh workflow run`，不改仓库设置）
```bash
gh workflow run nightly-capacity.yml --ref main -f rehearsal=true -f snapshot_upto=58
gh workflow run nightly-capacity.yml --ref main -f scale=large-ci
gh workflow run nightly-capacity.yml --ref main
# 查看与等待（每次等待设硬超时，用 gh run view 轮询）
gh run list --workflow nightly-capacity.yml --limit 3
gh run view <run-id> --json status,conclusion
gh run view <run-id> --log-failed
```

### 结果登记
下表三列各对应一次规定运行；每格的值必须附 run id；摘要字段来自 `capacity-summary.json`（含 AC8 新增的 `scale/partial/partial_reason/reached`，摘要本身不含 run id，run id 取自 Actions 页面），磁盘余量与升级演练逐迁移耗时不在摘要里，需另从 `Large-ci report` 步骤日志 / 演练日志取并注明来源，取不到就写「不可得」。

| 项 | `rehearsal=true snapshot_upto=58` | `scale=large-ci` | 默认（medium） |
|---|---|---|---|
| run id / commit / 结论 / 耗时 | 待填（未触发：工作流不在默认分支，GitHub 404） | 待填（同左） | 待填（同左） |
| scale / partial / partial_reason / reached | 待填（同左） | 待填（同左） | 待填（同左） |
| runner 信息（OS、CPU 核数、磁盘余量） | 待填（同左） | 待填（同左） | 待填（同左） |
| 生成 / 备份 / 恢复演练耗时（s） | 待填（同左） | 待填（同左） | 待填（同左） |
| `explain-audit` 违规数 | 待填（同左） | 待填（同左） | 待填（同左） |
| `bench-api` 读 p95（ms，按接口） | 待填（同左） | 待填（同左） | 待填（同左） |
| `bench-api` 写 p95（ms）/ 完整性检查 | 待填（同左） | 待填（同左） | 待填（同左） |
| 升级演练逐迁移耗时 | 待填（同左） | 不适用 | 不适用 |
| 失败 / 异常 | 待填（同左） | 待填（同左） | 待填（同左） |

### 未验证
截至 2026-10-24 本次尝试（`gh run list --workflow nightly-capacity.yml` 与 `gh workflow run` 均返回 HTTP 404，输出未存档）未发现该工作流的任何运行；仅限本次尝试的结论，不证明历史上从未运行。`large-ci` 的 355 分钟超时、磁盘余量、partial 行为；`snapshot_upto` 输入校验的线上表现；所有托管 runner 数字。

## AC4 看板 `/channel`、`/recent` 剖析与 explain-audit 登记（**Mac mini / 合成 medium 库 / 非目标主机 / 整机高负载**）

> **范围声明与负载（务必连同数字一起读）**：Mac mini；合成 `medium` 库（`synth-data.mjs --skus 20000 --docs 30000 --txns 150000`，种子 20261023，在隔离临时目录生成，用完删除；生成耗时 356 s，库 250 MB）。压测用**副本**：分类标记改 `test`、跑一次 `bootAll`（演示种子叠加，同 AB2 口径），并**额外灌入 5 个平台与 2 万条 `oms_orders`**（时间分布在最近 120 天、状态五种轮换）——合成生成器不产生 OMS 单，不灌的话 `/channel` 的线上分支是空表，测不出任何东西。**测量时整机负载很高（`uptime` 1 分钟平均负载 27–35，多个工作流同时在跑测试）**，绝对数字抖动大、只看量级；3 轮"缓存关 / 缓存开"交错，表里给 3 轮中位数。**不是 `dmserver` 结果、不是容量承诺、不是验收证据。**

### 逐块计时
两种口径：(a) 直接在副本库上对 SQL 计时（只读连接，21 次取中位数，负载约 31）；(b) 服务进程 `GML_PROFILE=1`、缓存关、100 次请求的块耗时中位数（负载约 30）。

| 块 | (a) SQL 直测 ms | (b) 服务内块 ms | 计划 |
|---|---|---|---|
| `channel.offline` | 3.83 | 5.47 | `SEARCH sales_orders USING INDEX idx_so_order_date` + 临时 B 树分组 |
| `channel.online`（2 万 OMS 单）| 11.93 | 4.76 | **`SCAN o`**（`date(order_time)` 套函数，无索引可用）+ 临时 B 树分组 |
| `recent.salesOrders` / `purchaseOrders` / `omsOrders` / `transactions` | 0.04 / 0.02 / 0.01 / 0.02 | 0.03 / 0.02 / 0.02 / 0.02 | 全部 `SCAN` 沿 rowid 倒序取 8 行即停，无排序临时表 |
| `/channel` 整个处理器 | — | 10.8 | |

(a) 与 (b) 的 `online` 差异（11.9 vs 4.8）是负载抖动，不是改动：两边是同一条 SQL。**没有任何块 ≥ 50 ms。**

### 决定与理由
- **`/channel` 缓存**（键 `channel:<days>`，与 AB2 同一套 `cachedRead`）：单次不到 15 ms，但线上分支是对 `oms_orders` 的**整表读取，随订单量线性增长**（2 万行 ≈ 5–12 ms，外推 20 万行会越过 50 ms 线——这是外推，没有测）；响应只由库内容、日期与 `days` 决定，路由器已要求全局数据范围，缓存范围安全。缓存把重复请求挪出请求路径，不改查询。
- **`/recent` 不缓存**：四条查询合计 < 0.2 ms，缓存的收益小于每次读取的版本校验；"最新动态"任何写入都使缓存失效，命中率天然低。仍接入 `createProfiler`（`cache=off`），以便生产数据量下回看。

### HTTP 延迟（并发 4，每接口 100 次 + 1 次预热，ms；3 轮中位数，括号内为 3 轮原始值）
| 接口 | 缓存关 p50 | 缓存关 p95 | 缓存开 p50 | 缓存开 p95 |
|---|---|---|---|---|
| `/dashboard/channel` | 73.8 (73.8/97.5/39.9) | 200.6 (200.6/284.1/79.7) | 2.7 (2.3/2.7/7.1) | 16.5 (16.5/8.6/61.9) |
| `/dashboard/recent`（两档代码路径相同，差异是噪声）| 5.1 (6.7/5.1/3.9) | 26.4 (26.4/29.7/9.8) | 4.5 (4.4/6.4/4.5) | 29.9 (15.8/66.4/29.9) |

读法：`/channel` 缓存关的 p50 远大于块耗时（~11 ms）是并发 4 在单线程 Node 上排队加整机高负载；缓存开后命中路径 p50 ≈ 3 ms。`/recent` 本来就快，不缓存是对的。0 个错误（全部 200）。"前"（batch-eleven）与"缓存关"同一条 SQL，所以没有单独跑前后对比。

### explain-audit 登记
`scripts/explain-audit.mjs` 新增 11 条语句，SQL 文本**直接取自** `server/lib/dashboard-sql.js`（路由执行的同一份，不是抄写；`tests/dashboard-perf.test.mjs` 断言登记文本与模块导出逐字相同、路由里不再内联）：`dash.top_products` / `top_brands` / `top_dealers` / `top_stores`（`expectIndex: idx_so_order_date`）、`dash.inventory_dist_agg`、`dash.channel_offline`（`expectIndex: idx_so_order_date`）、`dash.channel_online`、`dash.recent_sales` / `recent_purchase` / `recent_oms` / `recent_txn`。计划：`/top` 两条为 `SEARCH so USING INDEX idx_so_order_date` → `SEARCH i USING INDEX idx_soi_order`（CROSS JOIN 写法确实固定了顺序；变异——改回普通 JOIN——使计划变成 `SCAN i` 并报红）；`inventory_dist_agg` 是 `SCAN st USING INDEX idx_stock_wh_sku`（索引全扫，一遍）；`recent_*` 四条豁免（按主键倒序取页，`noSort`）；`channel_online` 豁免（整表读取，理由与"根治需新迁移"写在 ALLOW 里）。

- 在**纯合成 medium 库**上（不含演示种子）：110 条语句，**0 违规**，裸 SCAN 28（豁免 27、小表 1），索引全扫 6。
- 在压测副本（含演示种子叠加）上：1 条违规 `oc.overview_credit_used`（`oc_customers` 752 行 ≥ 阈值 200，裸 SCAN）。**与本工作流无关**：同一副本上 `batch-eleven` 源码（99 条语句）同样报这一条；原因是演示种子把该表灌到阈值之上。未处理，列入未验证 / 后续。

### 仍未覆盖
- `dmserver` 上用生产规模副本复跑；large 规模未跑；机器空闲时的数字未取。
- `dash.trend_*` 的 explain-audit 登记仍是人工镜像（只有 sales / purchase 两条，没有 `trend.online`，其 `date(order_time)` 同样整表读取 `oms_orders`）；本工作流只登记新增语句。
- `oms_orders.order_time` 没有可用索引（`/channel` 线上分支与 `/trend` 线上分支共同的残余），根治需要新迁移，不在本工作流范围。

## AD3 `oms_orders.order_time` 覆盖索引：迁移 070 前后（**Mac mini / 合成 20 万 OMS 单 / 非目标主机 / 整机高负载**）

脚本：`node scripts/bench-oms-order-time.mjs --rows 200000 --span 365|60 --rounds 5 --writes 5000 --repeat 31`（全新临时目录、真实迁移运行器后删掉 070 的索引造出"迁移前"，结束即删；不跑 `ANALYZE`——应用从不跑，统计表会让规划器改选 `idx_oms_status` 的 skip-scan）。**机器负载很高（运行时 1 分钟平均负载 34–43，同机并行其它工作流）**，绝对值抖动大、只看量级；中位数取 31 次。**不是 `dmserver` 结果、不是容量承诺。**

"前"= 旧 SQL（`date(order_time) >= …`，无索引）；"后"= 新 SQL（`dashboard-sql.js`，`order_time >= ? AND date(order_time) >= ?`）+ 迁移 070 的覆盖索引；"单列"= 仅作对比、**未发布**的 `oms_orders(order_time)`。新旧 SQL 在两个窗口上返回的行逐项相同（脚本断言，`results_identical: true`）。

### 计划
| 语句 | 前 | 后 |
|---|---|---|
| `/trend` 线上 | `SCAN oms_orders` + 临时 B 树分组 | `SEARCH oms_orders USING COVERING INDEX idx_oms_order_time (order_time>?)` + 临时 B 树分组 |
| `/channel` 线上 | `SCAN o` + `SEARCH pf …` + 临时 B 树分组 | `SEARCH o USING COVERING INDEX idx_oms_order_time (order_time>?)` + `SEARCH pf …` + 临时 B 树分组 |

### 延迟（ms，中位数；20 万行）
数据铺满 365 天（30 天窗口约含 8% 的行，90 天约 25%）：

| 窗口 / 语句 | 前（SCAN） | 后（覆盖索引） | 单列索引（未发布） |
|---|---|---|---|
| 30 天 trend | 40.4 | **6.5** | 27.7 |
| 30 天 channel | 38.4 | **6.4** | 27.0 |
| 90 天 trend | 68.7 | **24.4** | 88.3 |
| 90 天 channel | 44.6 | **15.9** | 87.7 |

数据全部落在最近 60 天内（两个窗口都覆盖 100% 的行，最坏情形，如新开业的店）：

| 窗口 / 语句 | 前（SCAN） | 后（覆盖索引） | 单列索引（未发布） |
|---|---|---|---|
| 30 天 trend | 119.1 | **49.7** | 195.5 |
| 30 天 channel | 61.9 | 58.7 | 200.6 |
| 90 天 trend | 208.7 | **102.7** | 423.6 |
| 90 天 channel | 88.1 | 76.6 | 411.9 |

读法：单列索引在窗口覆盖多数行时**比整表扫描慢 2–5×**（每行一次回表），这是迁移 070 用覆盖索引而不是路线图字面的单列索引的原因；覆盖索引在各分布下都不比扫描慢，窗口窄时快 6×（trend 30 天），最坏情形与扫描持平或略好。`/trend`、`/channel` 另有 30 s 缓存，这里是未命中路径。

### 建索引与库体积
`CREATE INDEX`（20 万行）约 175–215 ms；库文件 49.96 MB → 59.45 MB（**+9.5 MB，约 +19%**；单列索引约 +5.6 MB）。大库上建索引持写锁，量级随行数线性。

### 写放大（独立库交替、逐行自动提交的 INSERT，种子 10 万行，5 轮 × 5000 行；µs/行，最小值 / 中位数）
| 状态 | 数据铺满 365 天 | 数据在 60 天内 |
|---|---|---|
| 无索引 | 59.5 / 62.0 | 58.5 / 68.7 |
| 迁移 070（覆盖索引） | 86.1 / 103.0（**最小值 ×1.45，约 +27 µs/行**） | 90.3 / 107.2（×1.54，约 +32 µs/行） |
| 单列索引（未发布） | 68.3 / 95.2（×1.15） | 81.9 / 103.1（×1.40） |

写放大的绝对量级：每笔平台同步订单 / H5 商城订单落一行 `oms_orders`，多付约 30–40 µs（含机器负载抖动，倍数随负载变化、量级稳定）。

### 复现与未覆盖
- 复现：`node scripts/bench-oms-order-time.mjs --rows 200000 --span 365 --out result.json`（`--span 60` 为最坏情形）。
- 未覆盖：`dmserver` 与生产规模副本；机器空闲时的数字；真实 OMS 订单的时间分布；并发写入下的索引争用；`oms.js` `/stats` 等其它 `date(order_time)` 查询（未改）。
- explain-audit（合成库，`synth-data --skus 300 --docs 300 --txns 1500`，只读）：111 条语句，**0 违规**，裸 SCAN 27（豁免 26、小表 1），索引全扫 6；`dash.trend_*` 与 `dash.channel_online` 的计划见上表，`dash.channel_online` 的豁免已移除。
