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
