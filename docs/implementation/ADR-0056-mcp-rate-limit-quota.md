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

### Codex 审计（AE9，gpt-6.1-sol，只读，对 batch-thirteen 的 diff）

| 级别 | 发现 | 处理 |
|---|---|---|
| high | `consumeDb` 在事务外取一次时刻 / 窗口并跨 BUSY 重试沿用；争用跨过分钟边界时按旧窗口判定与记账，无视新窗口已满 ⇒ 超发 | 已修：时刻、窗口、`Retry-After` 都在写锁内每次尝试重新取；回归测试模拟"等锁期间跨窗口且新窗口已满"，断言拒绝且没有对旧窗口记账 |
| medium | 后台清理在事件循环上用同步写重试，库被占着写锁时最多可阻塞约 20 秒（4 × busy_timeout） | 已修：先做只读探测，无过期行则不拿写锁；有过期行时把该连接的 `busy_timeout` 临时降到 25 ms、`maxAttempts: 1`，拿不到锁就放弃本轮（计 `purge_failed`，下一分钟再来），`finally` 里恢复原 `busy_timeout`；测试：另一连接占着写锁时 purge 在 2.5 s 内返回失败、`busy_timeout` 已恢复、锁释放后的下一轮成功删除 |
| — | 迁移 073 与常规 fail-closed 路径无发现（审计环境 ABI 不匹配，仅静态审阅） | — |

## 补充 2（AF9，roadmap-v11）：真实定时器测试、写锁等待直方图、并发写下的基准

**问题。** AE9 的清理定时器只有结构性断言（源码里注册了、`unref` 了），没有在活的服务里观察过一次真实清理；`db` 模式的写锁等待没有任何线上可观测量，也没有在业务写入争用下测过尾延迟；`synchronous` 与何时该退回 `memory` 没有写进运维文档。

**决定。**
- **测试专用旋钮。** `GML_TEST_MCP_RATE_WINDOW_MS`（500..60000）缩短滑动窗口，`GML_TEST_MCP_RATE_PURGE_MS`（100..3600000）缩短清理周期；由 `mcpRatePolicy` 统一读取（限流器、清理线、管理端只读展示共用同一份策略）。**只在 `GML_RUNTIME_MODE === 'test'`（精确匹配，缺省 = production）下生效**；其它模式下只要设置了非空值就在模块加载时抛 `MCP_RATE_TEST_KNOB_FORBIDDEN`（服务启动即失败，不静默忽略——静默忽略会让人以为生产里窗口被缩短了）；取值非整数 / 越界抛 `MCP_RATE_TEST_KNOB_INVALID`；空串 = 未设置。窗口下限 500 ms 保证 `Retry-After` 与滑动折算仍有意义。清理线仍是「当前窗口起点 − 2 个窗口」，只是窗口变短。
- **真实定时器测试。** `tests/mcp-rate-store-db.test.mjs` 起一台活的服务（`GML_RUNTIME_MODE=test`、窗口 1 s、清理周期 0.5 s、`db` 模式），通过真实 `/mcp` 调用写出桶行，持续调用保持当前窗口有行，轮询数据库直到最早那行被服务内的定时器删掉（截止 15 s，实测数秒），并断言活窗口的行存活、行数有界、直方图在 `/api/meta/metrics` 里有观测。另有一例：`demo` 模式下带旋钮启动服务必须失败且不监听。
- **直方图 `os_erp_mcp_rate_store_wait_seconds`。** 在 `consumeDb` 里围绕整个 `withWriteRetry` 计时（`finally`，放行、拒绝、存储失败都计；`memory` 模式不计）。**无 label ⇒ 基数固定**（只有 14 个桶 + `+Inf` + sum + count）；桶 0.5 ms … 10 s（10 s 约等于 4 次尝试 × 默认 `busy_timeout` 的量级上界）。口径写明是"等锁 + 重试 + 事务体"的墙钟，不单独拆等锁——事务体本身是几十微秒，拆开没有信息量。告警 `OsErpMcpRateStoreWaitHigh`（warning，p95 > 100 ms 且调用量 > 0.1 次/秒，持续 15 分钟）；要求有流量，避免空闲时的单个慢样本触发。
- **并发写下的基准。** 新脚本 `scripts/bench-mcp-rate-contention.mjs`：4 个调用者进程 + 1 个合成风格写者进程（多行事务、带索引），场景 baseline / oltp / bulk / saturating，输出 p50 / p95 / p99 / max、fail-closed 数、重试与用尽数、写者吞吐与最长事务；结果与机器负载（loadavg 48–77）写入 capacity-baseline「AF9」。结论：调用者自己的尾延迟基本不受写者影响（紧循环 p95 约 40 µs；有节奏且遇到不间断的 200 行事务写者时 p95 约 25 ms / p99 约 150 ms）；**反向才是问题**——紧循环调用者会把业务写者饿住（oltp 写者 45–51 行/秒，本可达约 500）；该压力是人为上界，生产有逐令牌 RPM 约束。所有场景 fail-closed 为 0、无 `withWriteRetry` 重试。
- **文档。** `monitoring.md` 写明直方图、告警、`synchronous` 现状（实测 NORMAL；连接级 pragma，不要为限速单独调低；`FULL` 会延长写锁持有）以及何时选 `memory`。

**不变 / 边界。** 默认行为与默认窗口 / 周期不变；旋钮不进入 `/api/mcp/limits` 的任何可写面；不改限流判定与 fail-closed 语义；未改应用的 `synchronous` 设置（文档说明，不改代码）。

**验证。** 新增用例（`tests/mcp-rate-store-db.test.mjs`）：旋钮在测试模式生效、在 production / 缺省 / demo / 大小写不同（`TEST`）下被拒、非法值被拒、空串视为未设置；缩短窗口同时驱动 memory 与 db 判定及清理线；直方图登记 / 无 label / db 每次放行与失败都观测 / memory 不观测；持有写锁时等待落在慢桶；告警块含 p95、流量条件、`for`；文档断言；活服务清理；demo 模式带旋钮启动失败。`tests/metrics-export.test.mjs` 的告警总数 12 → 13，且告警引用的序列必须是已导出序列。

### Codex 审计（AF9，gpt-6.1-sol，只读，对 AF9 提交）

| 级别 | 发现 | 处理 |
|---|---|---|
| high | 无 | — |
| medium | 清理周期旋钮最低 100 ms 时，同步清理（等锁最多 250 ms、逐行业库、至多 20 块）可能让事件循环几乎没有空闲给 HTTP | 接受并记录：只在显式 `GML_RUNTIME_MODE=test` 下可达，生产/演示模式设置即启动失败；测试用的是 500 ms 周期。未加让出/时间预算（会改 AE9 已审计的清理路径），如日后放宽旋钮范围再做 |
| low | 告警把所有 target 标签聚合掉，多实例时一台退化会被另一台稀释且告警不带实例 | 已修：`sum by (instance, le)` 与 `sum by (instance)`，两侧标签一致 |
| — | 旋钮：精确匹配 `test`，空串 = 未设置，空白/大小写变体不能启用，限流器与管理端 `mcpRatePolicy()` 同一校验；直方图基数固定 17 条/目标，`finally` 覆盖放行 / 拒绝 / 失败，memory 不观测；清理线严格小于「当前窗口起点 − 2 窗口」，`busy_timeout` 在 `finally` 恢复；PromQL 合法。注：计时含语句预编译与失败日志，是整个 db consume 的墙钟（文档已如此表述） | — |

## 补充 3（AG9，roadmap-v12）：精确的每令牌 429 计数、每令牌配额用量接口、告警阈值推导

**问题。** AF11 的 `rate_limited_recent` 只是"触顶窗口数"（0..2）——桶表只记放行的调用，被拒的只读不写，拿不到 429 的精确次数；管理端也看不到每令牌今天用了多少日配额；`OsErpMcpRateStoreWaitHigh` 的 100 ms 没有写明推导。

**决定。**
- **迁移 075（`075_mcp_rate_denied_kind.cjs`）。** `mcp_rate_buckets.kind` 的 CHECK 放宽为 `all|write|denied`。SQLite 不能改 CHECK，所以是表重建：新建 `mcp_rate_buckets_new` → `INSERT … SELECT` 逐列拷贝 → **核对行数一致，不一致抛错回滚** → 删旧表 → 改名 → 重建索引。全程一个事务（runner 的 `up` 本来就在事务里；被直接调用时自己开事务），失败整条回滚、旧表原样；已是新 CHECK 则不动（幂等）；暂存表名是本迁移私有的，遗留则先删。`verify()` 与 `up()` 同一来源：表、索引、列、主键、**建表语句允许 `'denied'`**。073 不改（ADR-0009），其 `verify()` 对重建后的表仍成立。
- **拒绝行。** `db` 模式下，被 `rpm` / `write_rpm` 拒绝的调用在 `withWriteRetry` 判定事务**提交之后**，另用一个短事务 `INSERT … ON CONFLICT DO UPDATE SET count=count+1` 记 `kind='denied'`（窗口取判定时的窗口）。**永不影响放行与 429**：① 判定读取的 SQL 显式 `kind IN ('all','write')`，denied 行不参与滑动窗口估计；② 拒绝行写入包在独立的 `try/catch` 里，`busy_timeout` 临时降到 25 ms、`maxAttempts: 1`、`finally` 恢复——任何失败（锁忙、旧 CHECK 未迁移、触发器拒绝）只计 `os_erp_mcp_rate_store_failures_total{reason="denied_write_failed"}` 并吞掉，调用方照常得到原来的 `reason`（不会变成 `store_unavailable`）；③ 放行的调用、`store_unavailable`、日配额拒绝都不写 denied。基数：每令牌每窗口至多一行，随既有的过期清理一起被删。
- **精确计数。** `recentLimitedByToken` 改为对「当前 + 上一窗口」的 `denied` 行求和（API 字段名不变，语义从"触顶窗口数 0..2"变为"被限流次数"）；接口文案与前端不再称为代理值。仍是尽力而为：拒绝行写失败的那一次不会被数到（有计数器可见）。
- **`GET /api/mcp/limits/quota`（`system.mcp.manage`）。** `{ daily_quota, enabled, truncated, tokens:[{id,name,used,remaining}] }`：只列**在用**令牌（active 且未过期；`dailyQuotaUsage` 一次 `LEFT JOIN … GROUP BY … ORDER BY used DESC LIMIT 501`，先排序后截断到 500），`used` 取自 `mcp_call_logs` 里本地今日的行数（与 `dailyQuotaState` 同谓词）；审计表读不到 ⇒ `usage_unavailable=true`、`tokens` 为空（限流此时 fail closed，不能报「剩余全部额度」），`remaining = max(0, quota − used)`；配额为 0 ⇒ 空列表（不披露调用节奏）。字段：`daily_quota, enabled, usage_unavailable, truncated, tokens`。口径边界：限流器还有进程内"影子计数"兜底审计写失败的情形，这里看不到，展示值是审计表口径。
- **前端。** `McpCenter.tsx` 限速卡片里加一个数据驱动的配额区块（`data-testid="mcp-quota"`，配额关闭 / 读取失败 / 403 时不显示）；每令牌限流行改为"被限流 N 次"。布局由并行的 AG11 负责，本批只加最小区块。
- **阈值推导。** `monitoring.md` 写明 `OsErpMcpRateStoreWaitHigh` 的 100 ms / 0.1 次每秒 / 15 分钟如何从 AF9 基准数字反推（最坏已测 p95 24.9 ms 的 4 倍；同步调用下 10 次/秒 × 100 ms = 事件循环占满；样本量下限；`for` 过滤批量导入），并给出上线后的复核方法。告警规则本身未改。

**不变 / 边界。** 默认（`memory`）模式零变化；放行判定、fail-closed 语义、清理线都不变；denied 行只在 `db` 模式写；`/api/mcp/limits` 的字段不变。

**验证。** `tests/mcp-quota-denied.test.mjs`：迁移新建 / 幂等 / verify 漂移 / 带 100 行旧数据重建后逐行相等且主键与索引仍在 / 事务回滚保持旧表 / 遗留暂存表；拒绝逐次记一行、放行不记、写额度拒绝同样记、denied 行不影响下一窗口的放行、无表时不抛；触发器拦截拒绝行与旧 CHECK 未迁移时 429 的 `reason` 仍是 `rpm`、计数器加一、连接不留在事务里；`busy_timeout` 恢复；`recentLimitedByToken` 精确求和 / 窗口 / 作用域 / 触顶的 all 行不再计；活服务上 5 次 429 精确计 5；配额接口（关闭为空、开启逐令牌、已吊销不列、`remaining` 下限 0、无令牌材料、403 / 401）；文档断言。

### Codex 审计（AG9，gpt-6.1-sol，只读）

对提交 5eaa845 的审计结果（无 high）：

| 级别 | 发现 | 处理 |
|---|---|---|
| high | 无 | — |
| medium | 迁移 075 首次应用走 runner 的延迟事务（`db.transaction`），并发写者可能让它因 `SQLITE_BUSY(_SNAPSHOT)` 失败；失败会回滚、旧表完好，但启动中止 | 接受并记录：这是 runner 对**所有**未应用迁移的既有行为（heal 路径已是 IMMEDIATE + 重试，AF4）；回滚后重启即可；表很小（只有近两个窗口的行），重建在毫秒级；不改 runner（影响所有迁移） |
| medium | 新进程写的 `denied` 行会让 075 之前的旧进程读桶时抛错（`cnt[r.kind]` 未定义）⇒ 该令牌 `store_unavailable` 直到行滑出窗口 | 接受并记录为升级约束：多进程共用数据目录时一起停、迁移、一起起（`monitoring.md` 写明）；新进程的判定读取显式 `kind IN ('all','write')`，以后再加 kind 不会重演；单进程部署不受影响 |
| medium | `recordDenied` 的 250 ms `busy_timeout` 在别的进程抢先持锁时会阻塞事件循环约 250 ms/次拒绝 | 已修：降到 25 ms（不重试）；丢一次拒绝行的代价只是计数少一次（有 `denied_write_failed` 计数）。未改成异步：better-sqlite3 是同步库，异步写要另开连接，复杂度不值得 |
| medium | 配额读失败时端点把缺失条目显示为"用量 0 / 剩余全部"，而限流此时 fail closed | 已修：`dailyQuotaUsage` 读失败返回 null ⇒ 端点 `usage_unavailable=true` 且 `tokens` 为空；前端显示「暂时读不到」；测试里把审计表改名后断言 |
| low | 500 上限按 id 取前 500 再排序，用量最多的大 id 令牌会被挤掉；过期 / 失效令牌占位 | 已修：`ORDER BY used DESC` 在 SQL 里先排序后截断；过滤已过期令牌（所有者变更导致的失效不在此判，文档已写）；测试覆盖「最大 id 但用量最多」在 cap=2 下仍保留 |
| — | 授权（登录 + `system.mcp.manage`）、披露范围（仅 id / 名称 / 数字，无前缀哈希明文）、上限、回滚保旧表、幂等、073 verify 兼容、校验和不变、拒绝行写失败时 `reason` 仍是 `rpm`、`busy_timeout` 恢复、连接不留事务 —— 审计环境的内存探测均确认 | — |
