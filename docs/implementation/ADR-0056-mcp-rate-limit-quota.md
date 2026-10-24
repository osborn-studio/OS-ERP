# ADR-0056：MCP 工具级速率限制与日配额（AD9）

日期：2026-10-24。roadmap-v9 AD9。状态：开发实现，尚非产品上线验收。相关：ADR-0011（MCP 令牌模型）、ADR-0045（AB10 指标节流、AC9 告警）。

## 问题

MCP 令牌除了"近 1 小时调用数"这一条粗粒度上限（`agent_tokens.rate_limit`，读审计表，逐令牌配置）之外没有短窗口限制：一个死循环的 Agent 或被盗令牌能在几秒内对写型工具发起成千上万次调用，每次都会进事务并写审计。指标端点已有按 IP 的节流（AB10），MCP 入口没有。

## 决定

- **两个按令牌的 60 秒滑动窗口额度**（`server/lib/mcp-rate-limit.js`）：`GML_MCP_TOKEN_RPM`（全部 `tools/call` 与 `resources/read`，默认 600）、`GML_MCP_WRITE_RPM`（`level: 'write'` 工具，默认 60）。范围 1..1000000，非法值回退默认。写调用同时计入两个额度；先检查后记账，所以被写额度拒绝的调用不消耗总额度，写额度与读额度互不挤占（但总额度是硬上限）。`danger` 级工具只受总额度约束（它们本来要人工二次确认）。
- **滑动窗口算法**：当前固定窗口计数 + 上一窗口按剩余比例折算，每桶 O(1) 内存，窗口边界处不会出现 2 倍突发（有测试：跨边界 2 秒内的突发被拒）。是近似，不是逐请求精确日志；换来的是桶不随额度增大。
- **键与基数**：键只来自 `verifyToken` 验签通过的令牌行 id（整数），不读请求体、头或 IP；无效令牌在验签处被拒，到不了限流器，所以桶数不超过令牌数。桶表复用从 AB10 抽出的 `createBucketStore`（`metrics-throttle.js`，上限 10000）：满了且无过期桶可清时 **fail closed**（`reason=unavailable`，已有桶的令牌不受影响）；令牌 id 不是正整数同样拒绝。AB10 指标节流改用同一个桶表实现，行为不变（既有测试通过）。
- **限流位置**：`tools/call` 在工具查找之前（未知工具、无权限、参数非法的调用同样占额度，猜工具名/撞权限也受限）；`resources/read` 在访问判定之前按读调用计（否则它是绕开限流的第二个读入口）。`tools/list`、`initialize`、`ping` 不限（不执行工具）。
- **超限响应**：HTTP 429 + `Retry-After`，业务码 `MCP_RATE_LIMITED` 由 `bizFail` 构造（仍是唯一构造点；`detail.reason` ∈ `rpm | write_rpm | daily_quota | unavailable`，`detail.retry_after` 秒）。响应体在 `bizFail` 的 `{ code:1, success:false, error, message, detail }` 之上加 JSON-RPC 外壳（`jsonrpc`、`id`）与工具级错误形态 `result.isError=true` + `content[0].text = {"error":"MCP_RATE_LIMITED",…}`，既有 MCP 客户端/矩阵测试的解析器（读 `result.isError`）无需改动。已知形状差异：顶层 `error` 是字符串（业务码），而凭据层 JSON-RPC 错误的 `error` 是对象；按 HTTP 状态区分即可。
- **计数**：`MCP_RATE_LIMITED` 加入 `MCP_RESULT_CODES` 封闭集合，计入 `os_erp_mcp_tool_calls_total{tool,code="MCP_RATE_LIMITED"}`。**被限流的调用不写 `mcp_call_logs`**：洪泛时每次拒绝再写一行 SQLite 会把限流变成写放大；代价是审计表里看不到被拒的那部分（计数器与告警能看到量，看不到是谁——放行的那部分调用在审计里按 `token_name` 可定位到同一令牌）。
- **可选日配额**：设置键 `mcp_token_daily_quota`（`int`，0..1e8，默认 0 = 关闭，`is_danger: true`，改动须写理由并留痕）。口径：该令牌本地日历日内 `mcp_call_logs` 行数 ≥ 配额则拒绝（`reason=daily_quota`，`Retry-After` = 距本地午夜秒数）。无状态——过了本地午夜自然归零，重启不丢；配额为 0 时不查审计表（默认路径零开销）。启用后每次调用多一次按令牌计数查询（走 `idx_mcp_log_token`）；读库失败 ⇒ fail closed（`reason=unavailable`）。被速率限制拒绝的调用不写审计行，因此不占日配额。
- **告警**：`OsErpMcpRateLimited`（`docs/operations/alerts/os-erp-ab10.yml`）：10 分钟内 `MCP_RATE_LIMITED` 超过 20 次并持续 10 分钟，severity warning。

## 不做 / 边界

- 速率桶在进程内存：重启清零、多进程各自计数（与 AB10 同口径）；日配额读审计表，是持久的。
- 不改 `agent_tokens.rate_limit`（每令牌每小时上限）：两者并存，先到先拒。
- 不改 `tools.js`（AD1 改 `report.dashboard_kpi`），只改入口 `server.js`、节流库、设置、测试与文档。
- 矩阵压测 `tests/mcp-tool-matrix.test.mjs` 对每个工具 × 3 状态穷举调用，会撞默认的写 60/分；该测试的服务进程设 `GML_MCP_*_RPM=100000`。限流行为由 `tests/mcp-rate-limit.test.mjs` 覆盖。

## 验证

`tests/mcp-rate-limit.test.mjs`：默认值与非法 env 回退；额度内通过 / 额度外拒绝 / 窗口滑动与边界无突发；写额度独立于读额度、被拒的写不消耗读额度、写同时计入总额度；非法令牌 id 与桶表满 fail closed、过期桶被回收；通用桶表；设置键为危险 int、默认关；结果码登记；集成（随机回环端口、临时数据目录）：读超限 429 + 外壳 + 计数器、写超限零行写入（业务表与幂等表行数不变）且读不受影响、无效令牌不进桶、日配额开关 / 按令牌隔离 / 按日滚动；日配额状态单元（含库故障 fail closed）。
