# ADR-0056：MCP 工具级速率限制与日配额（AD9）

日期：2026-10-24。roadmap-v9 AD9。状态：开发实现，尚非产品上线验收。相关：ADR-0011（MCP 令牌模型）、ADR-0045（AB10 指标节流、AC9 告警）。

## 问题

MCP 令牌除了"近 1 小时调用数"这一条粗粒度上限（`agent_tokens.rate_limit`，读审计表，逐令牌配置）之外没有短窗口限制：一个死循环的 Agent 或被盗令牌能在几秒内对写型工具发起成千上万次调用，每次都会进事务并写审计。指标端点已有按 IP 的节流（AB10），MCP 入口没有。

## 决定

- **两个按令牌的 60 秒滑动窗口额度**（`server/lib/mcp-rate-limit.js`）：`GML_MCP_TOKEN_RPM`（全部 `tools/call` 与 `resources/read`，默认 600）、`GML_MCP_WRITE_RPM`（`level: 'write'` 工具，默认 60）。范围 1..1000000，非法值回退默认。写调用同时计入两个额度；先检查后记账，所以被写额度拒绝的调用不消耗总额度，写额度与读额度互不挤占（但总额度是硬上限）。`danger` 级工具只受总额度约束（它们本来要人工二次确认）。
- **滑动窗口算法**：当前固定窗口计数 + 上一窗口按剩余比例折算，每桶 O(1) 内存，窗口边界处不会出现 2 倍突发（有测试：跨边界 2 秒内的突发被拒）。是近似，不是逐请求精确日志；换来的是桶不随额度增大。
- **键与基数**：键只来自 `verifyToken` 验签通过的令牌行 id（整数）加**行业库标识**（令牌 id 在各行业库里各自从 1 起编，不带库标识则不同行业的同号令牌共用一个桶），不读请求体、头或 IP；无效令牌在验签处被拒，到不了限流器，所以桶数不超过令牌数。桶表复用从 AB10 抽出的 `createBucketStore`（`metrics-throttle.js`，上限 10000）：满了且无过期桶可清时 **fail closed**（`reason=unavailable`，已有桶的令牌不受影响）；令牌 id 不是正整数同样拒绝。AB10 指标节流改用同一个桶表实现，行为不变（既有测试通过）。
- **限流位置**：`tools/call` 在工具查找之前（未知工具、无权限、参数非法的调用同样占额度，猜工具名/撞权限也受限）；`resources/read` 在访问判定之前按读调用计（否则它是绕开限流的第二个读入口）。`tools/list`、`initialize`、`ping` 不限（不执行工具）。
- **超限响应**：HTTP 429 + `Retry-After`，业务码 `MCP_RATE_LIMITED` 由 `bizFail` 构造（仍是唯一构造点；业务码在 `detail.code`，`detail.reason` ∈ `rpm | write_rpm | daily_quota | unavailable`，`detail.retry_after` 秒）。响应体在 `bizFail` 的 `{ code:1, success:false, message, detail }` 之上加 JSON-RPC 外壳（`jsonrpc`、`id`）与工具级错误形态 `result.isError=true` + `content[0].text = {"error":"MCP_RATE_LIMITED",…}`，既有 MCP 客户端/矩阵测试的解析器（读 `result.isError`）无需改动。**不带顶层 `error` 字符串**：JSON-RPC 规定 `result` 与 `error` 二选一，且 `error` 必须是对象（Codex 审计 P2，已改）。
- **计数**：`MCP_RATE_LIMITED` 加入 `MCP_RESULT_CODES` 封闭集合，计入 `os_erp_mcp_tool_calls_total{tool,code="MCP_RATE_LIMITED"}`。**被限流的调用不写 `mcp_call_logs`**：洪泛时每次拒绝再写一行 SQLite 会把限流变成写放大；代价是审计表里看不到被拒的那部分（计数器与告警能看到量，看不到是谁——放行的那部分调用在审计里按 `token_name` 可定位到同一令牌）。
- **可选日配额**：设置键 `mcp_token_daily_quota`（`int`，0..1e8，默认 0 = 关闭，`is_danger: true`，改动须写理由并留痕）。口径：该令牌本地日历日内 `mcp_call_logs` 行数 ≥ 配额则拒绝（`reason=daily_quota`，`Retry-After` = 距本地午夜秒数）。无状态——过了本地午夜自然归零，重启不丢；配额为 0 时不查审计表（默认路径零开销）。启用后每次调用多一次按令牌计数查询（走 `idx_mcp_log_token`）；读设置键与计数查询任一失败 ⇒ fail closed（`reason=unavailable`；不用会吞错回落默认值的 `readSetting`，否则库故障会把已开启的配额静默关掉）。审计行是权威计数，但读工具 / `resources/read` 的审计是尽力写，写失败时计数不会推进，所以另有**进程内影子计数**（本进程已放行次数，桶表同样有上限、满则拒），实际已用 = 两者较大值。被速率限制拒绝的调用不写审计行，因此不占日配额。
- **告警**：`OsErpMcpRateLimited`（`docs/operations/alerts/os-erp-ab10.yml`）：10 分钟内 `MCP_RATE_LIMITED` 超过 20 次并持续 10 分钟，severity warning。

## 不做 / 边界

- 速率桶在进程内存：重启清零、多进程各自计数（与 AB10 同口径）；日配额读审计表，是持久的。
- 不改 `agent_tokens.rate_limit`（每令牌每小时上限）：两者并存，先到先拒。
- 不改 `tools.js`（AD1 改 `report.dashboard_kpi`），只改入口 `server.js`、节流库、设置、测试与文档。
- 矩阵压测 `tests/mcp-tool-matrix.test.mjs` 对每个工具 × 3 状态穷举调用，会撞默认的写 60/分；该测试的服务进程设 `GML_MCP_*_RPM=100000`。限流行为由 `tests/mcp-rate-limit.test.mjs` 覆盖。

## 验证

`tests/mcp-rate-limit.test.mjs`：默认值与非法 env 回退；额度内通过 / 额度外拒绝 / 窗口滑动与边界无突发；写额度独立于读额度、被拒的写不消耗读额度、写同时计入总额度；非法令牌 id 与桶表满 fail closed、过期桶被回收；通用桶表；设置键为危险 int、默认关；结果码登记；集成（随机回环端口、临时数据目录）：读超限 429 + 外壳 + 计数器、写超限零行写入（业务表与幂等表行数不变）且读不受影响、无效令牌不进桶、日配额开关 / 按令牌隔离 / 按日滚动；日配额状态单元（含库故障 fail closed）。

## Codex 审计（gpt-6.1-sol，只读，对 batch-twelve 的 diff）

| 级别 | 发现 | 处理 |
|---|---|---|
| P1 | 日配额在设置读失败时 fail open（`readSetting` 吞错回落 0） | 已修：严格读（直接 SELECT + 值域校验），失败 ⇒ `unavailable`；单元测试 |
| P2 | 令牌 id 在各行业库独立编号，进程级限流器按裸 id 计，跨行业共享额度 | 已修：键带行业库标识；单元测试 |
| P2 | 429 响应同时带顶层 `error` 字符串与 `result`，违反 JSON-RPC | 已修：去掉顶层 `error`，业务码在 `detail.code`；集成测试断言无 `error` 成员 |
| P2 | 审计写失败时读路径不推进日配额计数，可超配额（仅受 RPM 约束） | 已修：进程内影子计数取较大值；单元测试 |
| — | 未发现令牌伪造 / 键基数 / `/api/mcp` 挂载绕过；元数据方法（`tools/list` 等）有意不限；本地日期滚动判据与审计时间戳一致；AB10 指标节流抽取前后 10000 次决策与 `Retry-After` 一致 | — |

## 补充（AE9，roadmap-v10）：限速桶可存到数据库（`GML_MCP_RATE_STORE=db`）

**问题。** 原决定「速率桶在进程内存」意味着多进程部署各算各的（N 个进程 ≈ N 倍额度），重启也清零。

**决定。**
- 新开关 `GML_MCP_RATE_STORE=memory|db`，默认 `memory`（路径、行为、性能均不变）；其它取值启动即抛 `MCP_RATE_STORE_INVALID`（拼错不能悄悄退回"各进程各算各的"）。
- `db` 模式用迁移 073 的表 `mcp_rate_buckets(token_key, window_start, kind, count)`，主键 `(token_key, window_start, kind)`，`kind ∈ {all, write}`，另有 `idx_mcp_rate_buckets_window(window_start)` 供范围清理。`token_key` 与内存模式同一个键（`<行业库>|<令牌 id>`）。表已登记在 `seed.js` 的 `TABLES`（整库重建清桶）。
- **原子性**：一次申请 = 一个 `withWriteRetry`（`BEGIN IMMEDIATE`）事务：读当前 / 上一窗口计数 → 与内存模式同一条滑动窗口判定（`prev·(1-f)+cur+1 > limit`）→ 通过才 `INSERT … ON CONFLICT DO UPDATE SET count=count+1`（总额度与写额度同事务，要么都记要么都不记）。写锁串行化各进程，所以不会超发；被拒的调用事务里没有写语句。`tests/mcp-rate-store-db.test.mjs` 起 4 个进程各打 50 次、额度 100，断言合计恰好放行 100。
- **fail closed**：任何存储错误（BUSY 重试用尽、表缺失、触发器/磁盘错误、缺少库句柄）⇒ 拒绝本次调用：429 `MCP_RATE_LIMITED`，`detail.reason='store_unavailable'`，`Retry-After: 5`，计数器 `mcp_rate_store_failures_total{reason="write_failed"}` +1（同时在 `os_erp_mcp_tool_calls_total{code="MCP_RATE_LIMITED"}` 里可见）。`detail.reason` 的集合扩为 `rpm | write_rpm | daily_quota | unavailable | store_unavailable`；`unavailable` 仍表示令牌 id 非法 / 内存桶满 / 日配额状态不可用。
- **清理**：过期桶只由后台定时器清理，请求路径从不删除。服务里此前没有周期性定时器，所以在 `server/index.js` 新注册一个（仅 `db` 模式，`setInterval` 60 s、`unref()`，遍历磁盘上已存在的行业库，调用 `purge(db)`）。清理线 = 当前窗口起点 − 2 个窗口（比上一窗口还早一整个窗口），所以进程间时钟偏差在 ±1 窗口内不会误删仍在用的桶；分块（每块 5000 行、最多 20 块）、每块一个短事务；失败只记日志与 `purge_failed` 计数、永不抛。
- **告警**：`OsErpMcpRateStoreUnavailable`（`os-erp-ab10.yml`，critical，5 分钟内有 `write_failed` 即触发，不设 `for`——fail closed 期间调用全部被拒）。
- **开销**：见 capacity-baseline「AE9」：单进程 `consume()` 中位多约 13 µs、p95 约 38 µs（read / write 相近）。代价主要是每次放行持一次 SQLite 写锁，与业务写入争用——故默认不开。

**不变 / 边界。** 日配额仍读 `mcp_call_logs`（本就跨进程共享、持久），进程内影子计数仍是每进程一份；`agent_tokens.rate_limit` 不变；桶数无上限（行数 ≤ 令牌数 × 2 窗口 × 2 kind，由清理兜底）；`memory` 模式不碰这张表。不做：Redis 等外部存储、按 IP 限速。

**验证。** `tests/mcp-rate-store-db.test.mjs`（12 例）：迁移 up 幂等 / verify 与 up 一致且能发现漂移；seed 与计数器登记；env 取值；db 模式与内存模式语义一致（读写额度、被拒写不耗读额度、行业隔离、被拒不写行）、窗口边界无突发；"重启"与两个连接共享；存储失败 fail closed + 计数、写型第二行失败整体回滚（无半记账）；清理边界；两个**服务进程**共用一个数据目录共享额度、重启 A 后仍限流、把表改名后 fail closed 并计数；4 进程竞速恰好放行 `rpm` 次；定时器仅 `db` 模式注册且 `unref`、请求路径无 `purge` 调用。

