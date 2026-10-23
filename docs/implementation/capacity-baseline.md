# 容量与性能基线（W11）

> **范围声明**：本文档的数字来自开发机 Mac mini（Apple M4, 10 核, 16 GB, Node v22.22.1）上对 **demo 种子库**的一次短跑。
> **它们不是目标主机（`dmserver`）结果，不是容量承诺，不是验收证据**。此前报告"没有压测"的结论在目标主机实测前仍然成立；
> 本脚本只是让试点前的基线**可重复**。生产规模、真实数据量、多用户混合读写、网络与反向代理都**未覆盖**。

## 方法

脚本：`scripts/bench-api.mjs`（无新增依赖，自写并发 `fetch` 池）。

1. 必须显式给**绝对路径** `GML_DATA_DIR`，并经 `requireExplicitDataDir()` 拒绝仓库 `data/`；`GML_RUNTIME_MODE` 只接受 `demo`/`test`；输出文件也不得落在仓库 `data/` 内。违反即退出码 2，不启动任何进程。
2. 在 `127.0.0.1` 的随机空闲端口 spawn `server/index.js`（子进程环境白名单、随机 JWT 密钥、`GML_LOGIN_IP_LIMIT`/`GML_LOGIN_ACCOUNT_LIMIT` 提高到 10000），只对自己 spawn 的子进程发请求。
3. 登录一次取 token（默认 `admin`/`12345`，即种子文件里的 demo 账号；可用 `GML_BENCH_USER`/`GML_BENCH_PASSWORD`/`GML_BENCH_INDUSTRY` 覆盖）。
4. 对 10 条接口顺序各跑 N 次，每条内部最多 `concurrency` 个请求同时在飞：登录（`--login-iterations`）、仪表盘 summary、采购单列表、采购单详情（取列表第一条）、库存 `stocks`、收款单列表 `ar/receipts`（应收侧）、报表 `reports/operating`（当月）、`meta/health`、订单中心 overview、通知 meta。
5. 延迟用 `performance.now()` 测整次请求（含读完响应体）。百分位为**最近秩**：升序 n 个样本取第 `ceil(p/100·n)` 个；样本很少时 p95/p99 会等于最大值，不要过度解读。错误 = HTTP ≥ 400 或网络错误/30 s 超时。`SQLITE_BUSY` 次数 = 子进程 stdout/stderr 中匹配 `SQLITE_BUSY|database is locked` 的行数（应用若吞掉该错误不写日志则计不到，是下限）。
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

解读限制：登录的 250 ms 主要是 bcrypt 同步计算在单线程事件循环里排队（4 个并发登录互相等待），体现的是登录串行化而非单次登录成本；其余接口是 demo 库（数百行量级）上的读，**不代表生产数据量**。本基线没有覆盖写路径（创建/审核/收付款）、并发写冲突下的 `SQLITE_BUSY`、长时间 soak、内存增长。

## 仍需目标主机

在 `dmserver` 上用生产规模数据副本、相同脚本复跑并留存 JSON，才能作为试点容量证据；届时同时记录 CPU/磁盘型号与是否经反向代理。
