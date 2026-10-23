# ADR-0035：写路径并发与 SQLITE_BUSY 治理

日期：2026-10-23。对应 roadmap-v4 Y7；与 ADR-0013（收款释放台账）、ADR-0018（收付款证据与复核）、ADR-0024（付款释放台账）的"同一事务、整体回滚"不变量相容——本决定**不改变**任何一处事务边界内的语义，只在事务**外**加一层"回滚之后再试"。

## 背景与审计结论

1. `server/db/index.js` 把 `busy_timeout` 写死为 5000 ms，没有调节手段，也没有任何写并发证据（W11/X10 基线只测读）。
2. 单个 Node 服务进程里 better-sqlite3 是同步的：同一进程内两个请求不可能"同时"持有写事务，所以**单进程自己不会 BUSY**。真实的 `SQLITE_BUSY` 来自别的进程——CLI 脚本（`db-backup`、`retention`、`privacy-erase`、`local-manage`）、MCP 子进程、第二个服务实例。
3. 现有写函数用 `db.transaction(...)`，即 `BEGIN DEFERRED`：先读（比如 `nextDocNo` 取当前最大单号）再写。WAL 下，如果读到写之间别的进程提交过，升级写锁会立刻失败为 `SQLITE_BUSY_SNAPSHOT`——**这种失败不等待 `busy_timeout`**，调高超时也救不了。
4. 没有 HTTP 层幂等键（只有 MCP 工具有 `mcp_idempotency`）。所以"重试是否安全"不能靠幂等键回答，必须靠事务原子性回答。

## 决定

### 1. `GML_SQLITE_BUSY_MS`（`server/db/index.js` → `sqliteBusyMs()`）

默认 **5000**（沿用旧值）。必须是 0..300000 的十进制整数，否则启动抛 `SQLITE_BUSY_MS_INVALID`（拼错的配置宁可失败，也不静默回落）。

### 2. `withWriteRetry(db, fn, {maxAttempts, baseDelayMs, maxDelayMs, label})`（`server/lib/tx.js`，唯一实现）

**重试契约**

| # | 规则 |
|---|---|
| ① 只认并发冲突 | 仅当错误是 better-sqlite3 的 `SqliteError` 且 `code` 匹配 `SQLITE_BUSY*` / `SQLITE_LOCKED*` 才重试。业务错误（`PurchaseError`、`ArError`、`FundsError`…）、约束冲突、`TypeError`、以及"code 字符串碰巧是 SQLITE_BUSY 但不是 SqliteError"的对象，**一次都不重试**，原样抛出。 |
| ② 原子 | 每次尝试都是 `db.transaction(fn).immediate()`：`BEGIN IMMEDIATE` 先拿写锁，`fn` 的读写都在锁内；任何异常（含 COMMIT 阶段）由 better-sqlite3 `ROLLBACK` 整个事务后再抛（库源码语义：`catch` 里 `if (db.inTransaction) ROLLBACK`）。所以**重试之前上一次的所有写入已撤销**；COMMIT 成功就立即返回，**不存在"提交之后再重试"的路径**。`fn` 内部的 `db.transaction` 变成 SAVEPOINT 嵌套，随外层回滚。 |
| ③ fn 只含 DB 操作 | 会被整体重跑，不得做外部副作用（发请求、写文件、通知、进程内状态）；这些放在 `withWriteRetry` 返回之后（路由里的 `audit(req, …)` 就在其后）。`fn` 必须同步，返回 Promise 会被拒绝并回滚。 |
| ④ 已在事务内 | `db.inTransaction` 为真时不重试、不嵌套：直接跑一次，原子性与重试由外层负责。 |
| ⑤ 用尽 | 默认总共 4 次（`GML_WRITE_RETRY_MAX`，1..10，1 = 关闭）；用尽后抛**最后一次的原始错误**，调用方看到的 HTTP 行为与包装前一致（500），只是多等了几轮。 |
| ⑥ 退避 | `min(maxDelayMs=400, baseDelayMs=25 · 2^(attempt-1))` × [0.5, 1] 抖动；同步阻塞等待（`Atomics.wait`），与 `busy_timeout` 自身的阻塞一致。 |
| ⑦ 可观测 | 每次重试一行 `write_retry`（warn），用尽一行 `write_retry_exhausted`；进程内计数 `writeRetryStats()`（calls / retries / exhausted / non_retryable）。 |

**为什么用 IMMEDIATE 而不是只包一层 try/catch**：DEFERRED 事务里"读后升级"的 `BUSY_SNAPSHOT` 不会等超时，必须回滚重来；改成 IMMEDIATE 后，读发生在写锁之内，快照过期这一类失败从根上消失，剩下的只有"拿不到写锁等满超时"，这才是重试要对付的。同时 `nextDocNo`（读最大号再 +1）的读与写在同一把锁里，消除了跨进程重号。副作用：校验类的读也在锁内——对 409/404 这类业务拒绝，代价是一次空的 BEGIN/ROLLBACK，行为（状态码、消息、回滚）不变。

### 3. 接入范围（路由层，不动领域函数）

| 路由 | 包装的调用 | label |
|---|---|---|
| `POST /api/purchase/orders` | `createPurchaseOrder` | `po.create` |
| `POST /api/purchase/orders/:id/status` | `transitionPurchaseOrder`（确认/审批等流转） | `po.transition` |
| `POST /api/purchase/orders/:id/receive` | `receivePurchaseOrder` | `po.receive` |
| `POST /api/ar/receipts/:id/confirm`、`/review` | `confirmFunds` / `reviewFunds`（内含 `confirmReceipt`） | `receipt.confirm` / `receipt.review` |
| `POST /api/inventory/transfers`、`/:id/ship`、`/:id/receive` | `createTransfer` / `shipTransfer` / `receiveTransfer` | `transfer.*` |

MCP 工具、其它写路径、CLI 脚本**本次未接入**（见"边界"）。

### 4. 与既有不变量的关系

- ADR-0013/0024 的台账行、ADR-0018 的复核状态与严格审计都在原有事务里写；现在多了一层外层 IMMEDIATE 事务，内层事务变 SAVEPOINT，**任一步失败仍整体回滚**（内层抛出 → 外层回滚）。严格审计行（`auditStrictRow`）要求 `db.inTransaction`，条件仍满足。
- 重试发生在外层回滚之后，台账行 / `doc_events` / 单号计数 / 库存流水都已撤销，再执行一次不会出现双写。测试 `BUSY thrown after fn already wrote` 与多进程测试里"每张调拨恰好一条 TR_OUT、库存恰好少 N"直接证明。

## 压测（`bench-api.mjs --profile=write`）怎么保持诚实

- 单服务进程不会自己 BUSY，所以脚本默认再起一个 **worker 线程**（`scripts/lib/bench-contender.mjs`）用独立连接周期性 `BEGIN IMMEDIATE`（默认占 30 ms、间隔 20 ms，约 60% 占锁率，**偏重**）模拟外部写者；`--contender-hold-ms 0` 关闭。它不写任何业务行。
- 并发创建采购单 / 确认收款（带 `evidence_ref`，隔离副本里复核关闭、证据开启）/ 库存调拨(autoShip)。收款单为"预收"（`allocations: []`），避免 N 张互相争同一张应收。
- 每个请求带唯一键（`remark` / `serial_no`）。**脚本不重发失败请求**，键只用于结束后（服务已停）只读核对：成功数 = 库里的行数、无重复行、每张调拨恰好一条 `TR_OUT`、源仓库存恰好少成功数、已确认收款数 = 成功数。核对失败退出码 1。
- 报告分列：HTTP 状态分布（含 500）、服务日志里 BUSY 行数、`write_retry` 行数、`write_retry_exhausted` 行数、外部写者的循环数。BUSY 行数按日志文本计，是**下限且含重复**（一次用尽会同时产生 `write_retry_exhausted` 与 500 错误日志）。

## 验证

- `tests/write-contention.test.mjs`：配置校验；`isBusyError` 判据；退避上限/抖动；BEGIN 阶段争用后 fn 只跑一次；fn 写完后抛 BUSY → 前次写入回滚、重试后恰好一行；**非 BUSY 错误零次重试且不留行**（约束冲突、业务错误、伪 BUSY、TypeError）；用尽后抛原始错误；`maxAttempts=1`；已在事务内不重试；async fn 被拒；热点路由确实包了 `withWriteRetry`（静态）；**多进程**：5 个独立写进程 × 12 轮（采购单 + autoShip 调拨），父进程先占写锁 400 ms，`busy_timeout=1ms`，断言无丢写、单号唯一、库存守恒、重试 ≥ 进程数、无用尽、无非 BUSY；`bench-api --profile=write` 固定字段与完整性。把多进程用例的 `maxAttempts` 改成 1 会以 `database is locked` 失败（已手动验证，说明测试确实依赖重试）。
- 写基线数字见 `capacity-baseline.md`"Y7 写路径基线"。

## 边界与未覆盖

- **只覆盖 SQLite 写锁争用**；不解决慢事务本身、长事务、WAL 无限增长、checkpoint 饥饿。
- 同步阻塞退避会占住事件循环（最坏约 25+50+100 ms 一次请求），与 busy_timeout 的阻塞同量级；若将来改为异步重试需要重新审视"fn 同步"这一前提。
- HTTP 路由仍无幂等键：客户端自己重发请求（超时后重试）依然可能造出两张单；这是既有行为，本 ADR 不改。重试用尽返回的仍是 500，没有改成 503/`Retry-After`（避免改动对外契约）。
- MCP 工具（`mcp_idempotency` 缓存在业务事务之后写入）、`credit`/`pos`/`mall` 等其它写路由、CLI 脚本未接入；它们沿用 `busy_timeout`。
- 压测是**夹具规模、单机、单服务进程 + 线程模拟外部写者**，不是 `dmserver` 结果，不是容量承诺。
