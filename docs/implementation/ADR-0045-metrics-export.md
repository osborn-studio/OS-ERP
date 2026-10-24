# ADR-0045 Prometheus 指标导出与抓取令牌（AA10）

状态：开发实现，尚非产品上线验收｜相关：ADR-0029（运维健康块与 JSON 计数器）、ADR-0023（日志）、ADR-0035（写路径并发）、ADR-0005 修订（登录节流）、ADR-0036（CSP Report-Only）、ADR-0021（路由授权清单）、ADR-0012（健康/版本契约）

## 背景

ADR-0029 的 `GET /api/meta/metrics` 只返回 JSON，抓取端（Prometheus）无法直接消费，且 JSON 里只有"此刻状态"（备份年龄、磁盘等），没有"事件发生过多少次"：登录节流拒绝、严格审计写失败、写重试与用尽都只有日志行。同时 Prometheus 没有用户会话，不能要求它带 admin JWT（12 小时过期，且是人的凭据）。

## 决策

### 1. 端点

`GET /api/meta/metrics?format=prometheus` 返回 `text/plain; version=0.0.4; charset=utf-8`（`Cache-Control: no-store`），每个指标族一行 `# HELP`、一行 `# TYPE`，名字统一前缀 `os_erp_`。无 `format` 或 `format=json` 与 ADR-0029 完全一致；其它 `format` 值 ⇒ 400（不静默回落）。

### 2. 鉴权（两条，且只有这两条）

1. admin JWT（角色 `admin` 或 `is_super`），与 ADR-0029 相同：匿名 401、非 admin 403。
2. `Authorization: Bearer <GML_METRICS_TOKEN>`，**仅对 `?format=prometheus` 生效**。令牌对 JSON 形态、`/health`、以及任何其它路由都无效（落到 `requireAuth` ⇒ 401）。

令牌规则：
- 只来自环境变量 `GML_METRICS_TOKEN`；未设置或短于 32 字符 ⇒ 令牌路径整体关闭（短令牌不会因"设了"而变成弱口令）。不接受查询参数传令牌（URL 会进访问日志）。
- 常数时间比较：双方各取 SHA-256（定长 32 字节）后 `crypto.timingSafeEqual`；不比较明文、不泄露长度。
- 令牌永不写日志、响应体、审计。错误令牌与"没带凭据"得到同样的 401，不提示令牌机制存在。
- 令牌是**只读的指标读取权**：能看到的只有下面列出的数字与固定 label，没有任何账号、路径、业务数据。

路由守卫：`/api/meta/metrics` 的路由中间件 `metricsAuth` 是自定义函数，`check-route-authz` 按名字识别不到 `requireAuth`，故该路由从 `handler-scope` 改登记为 `public`（与 `/health` 的可选鉴权同类），理由里写明真实门禁；**它并不匿名可读**（无凭据/错令牌 401，由测试证明）。路由级中间件是 `metricsAuth`（令牌 ⇒ 放行，否则 `requireAuth`），处理器内再按 `req.user` 是否 admin 或"令牌且 prometheus"二次确认。

### 3. 指标清单

Gauge（抓取时现算，来自 `ops-status.js`，未知为 -1，与 ADR-0029 一致）：

| 指标 | 含义 |
|---|---|
| `os_erp_backup_age_seconds` | 最新备份报告距今秒数 |
| `os_erp_backup_last_failed` | 最新备份报告含失败 ⇒ 1 |
| `os_erp_backup_missing` | 没有任何备份报告 ⇒ 1 |
| `os_erp_migration_checksum_mismatches` | 迁移文件与登记校验和不一致的条数 |
| `os_erp_migration_checksum_adopted` | 显式收养登记的迁移条数 |
| `os_erp_login_throttle_unavailable` | 节流存储只读探测失败 ⇒ 1（此时登录 fail closed） |
| `os_erp_disk_free_bytes` | 数据目录所在卷可用字节 |
| `os_erp_build_info{version}` | 恒 1，version 与公开的 `/health` 一致 |

Counter（进程内、只增、重启归零；抓取端用 `increase()`/`rate()`）：

| 指标 | 增量点（真实发生处） |
|---|---|
| `os_erp_login_throttle_rejections_total{reason="rate_limited"}` | `login-throttle.js` 限流器 `consumeLoginAttempt` 返回 429 前 |
| `os_erp_login_throttle_rejections_total{reason="unavailable"}` | 生产入口 `consumeLoginAttempt` 把存储故障转为 503 `LOGIN_THROTTLE_UNAVAILABLE` 前 |
| `os_erp_audit_strict_write_failures_total{reason}` | `audit-trail.js` `auditStrictRow`：`insert_error`（INSERT 抛错）、`no_row`（0 行，如 `RAISE(IGNORE)`）、`outside_tx`（不在事务内，编码错误）；`server/mcp/server.js` `insertCallLog` 失败记 `mcp_call_log` |
| `os_erp_security_audit_unavailable_total` | 同一处，`insert_error`/`no_row` 两种导致业务以 503 `SECURITY_AUDIT_UNAVAILABLE` 回滚时各 +1（`outside_tx` 与 MCP 不计） |
| `os_erp_write_calls_total` / `_retries_total` / `_retry_exhausted_total` / `_non_retryable_errors_total` | 直接读 `tx.js` 的 `writeRetryStats()`（ADR-0035 已有的计数，不另起一份） |
| `os_erp_csp_violation_reports_total` | **恒 0**，见下 |

label 值全部来自代码内登记的固定集合（`process-counters.js` 的 `COUNTER_DEFS`），绝不来自用户输入（账号、IP、路径），时间序列基数固定；未登记的名字/值被忽略而不抛错。

### 4. CSP 违规数：未采集

ADR-0036 的 CSP 目前只发 `Content-Security-Policy-Report-Only`，头里没有 `report-uri` / `report-to`，服务端也没有任何报告接收端点（核对 `server/middleware/security-headers.js` 与全部路由）。本 ADR **不新增**报告端点（匿名可写端点需要自己的滥用防护与存储评审，另开项）。因此 `os_erp_csp_violation_reports_total` 恒为 0，HELP 文本写明 "not collected"；**它为 0 不代表没有违规**，文档里的告警规则也不引用它。

## 后果与限制

- 计数器是进程内的：多进程/多副本各自计数，重启归零。当前部署是单进程；多副本时抓取端对每个实例分别抓取。
- 令牌若泄露，攻击者获得的是只读运维数字（备份年龄、磁盘余量、事件计数），可用于侦察但无法读写业务数据；轮换办法是改环境变量并重启。令牌路径没有单独的失败限速（令牌 ≥32 字符，暴力猜解不可行；反向代理层限速仍建议开启）。
- `login_throttle_rejections_total{reason="rate_limited"}` 只统计"限流命中"，不区分攻击与误输入；它是趋势信号，不是封禁清单。
- `outside_tx` 是编码错误信号，正常运行应恒为 0。
- 指标只暴露**整个进程**的数字，不分行业库（备份年龄取默认库的备份目录，沿用 ADR-0029）。

## 验证

`tests/metrics-export.test.mjs`：计数器注册表（未登记名/值被忽略）；渲染形状（每族 HELP/TYPE、前缀、label 转义、未知 = -1）；令牌函数（未配置/过短/不等长/大小写/非字符串；源码使用 SHA-256 + `timingSafeEqual`）；三处真实增量点（严格审计的 INSERT 抛错、`RAISE(IGNORE)` 零行、事务外；限流器 429；`withWriteRetry` 重试与用尽）；真实服务进程上匿名 401 / 非 admin 403 / admin 200 与响应头、JSON 形态不变、非法 format 400、令牌只对 prometheus 有效且不被 `/health`、`/settings`、JSON 形态、查询参数接受、令牌不出现在服务输出、未设/过短令牌禁用、登录被限流后抓取值 +1 且不含账号名。运维文档：`docs/operations/monitoring.md`。

## 补充（AB10，batch eleven）：端点加固与新指标

### 节流
`/api/meta/metrics` 增加按来源 IP 的固定窗口节流（`server/lib/metrics-throttle.js`），**独立桶**、位于鉴权之前（猜令牌的请求同样计数，并覆盖 JSON 形态与 admin JWT）。来源 IP 取 `req.ip`（`GML_TRUST_PROXY` 单一策略，ADR-0040），IPv4 映射的 IPv6 与 IPv4 同桶，无法解析的来源不豁免，桶数上限 10000、满且无可清理项时 fail closed。默认 120 次 / 60 s / IP，`GML_METRICS_IP_LIMIT`、`GML_METRICS_IP_WINDOW_MS` 可调，非法值回退默认。超限：429、`bizFail` 形状、业务码 `METRICS_RATE_LIMITED`、`Retry-After`。
与登录节流的差别（有意）：登录节流为 SQLite 持久化，且其接口绑定"IP 桶 + 账号桶"并带策略冻结校验；指标端点只读，重启清零无安全后果，因此复用其**口径**（IP 归一化、桶上限、fail closed、独立桶）而非其存储，避免把抓取流量写进登录节流库、也避免存储故障连带拖垮抓取。

### 令牌轮换
`GML_METRICS_TOKEN` 与 `GML_METRICS_TOKEN_NEXT` 同时有效（各自须 ≥32 字符，过短者忽略）。两把**都**做 SHA-256 + `timingSafeEqual` 比较，不提前返回。轮换流程见 `docs/operations/monitoring.md` §1。

### 新指标
- `os_erp_dashboard_cache_total{result=hit|miss}`：`db-ttl-cache.js` 的 `cachedForDb`（缓存关闭时不计）。
- `os_erp_audit_write_duration_seconds`（histogram，固定桶 0.5 ms … 1 s + `+Inf`）：`audit-trail.js` 的 `insertAuditRow`（唯一 INSERT 点），失败的尝试同样计时。
- `os_erp_mcp_tool_calls_total{tool,code}`：`mcp/server.js` 的 `insertCallLog` 成功落行后计数。
**基数与注入**：`tool` 只接受启动时从工具目录登记的名字（含虚拟工具），其余 `unknown`；`code` 只接受 `process-counters.js` 内登记的结果码，其余 `other`；成功为 `ok`。用户可控字符串因此不能产生新序列，label 值另经转义。直方图桶边界与名字写死在 `HISTOGRAM_DEFS`。
`ok` 与 `AUDIT_UNAVAILABLE` 对每个已登记工具预置为 0（`increase()` 无法还原首次出现即为 1 的序列），其它码在首次发生时出现。
**限制**：MCP 计数以审计行落地为准——审计写入本身失败的调用不计入该计数（见 `audit_strict_write_failures_total{reason="mcp_call_log"}`）；多进程各自计数。

### 验证
`tests/metrics-export.test.mjs` 增：轮换（两把有效、仅 NEXT、过短忽略）、缓存命中/未命中、MCP 计数封闭集合与注入、直方图累计桶与 `insertAuditRow` 计时（含失败）、节流单元（独立桶、窗口过期、容量 fail closed、非法配置回退、映射地址）、真实服务进程上的 429 形状 / `Retry-After` / 错误令牌也计数 / 两把令牌均可抓取。

## 补充 2（AC9，batch twelve）：规则文件化、promtool 校验与端到端

### 告警规则文件化
`monitoring.md` 里内联的两段规则移到 `docs/operations/alerts/os-erp.yml`（6 条）与 `os-erp-ab10.yml`（4 条），文档只引用文件，Prometheus 的 `rule_files` 可直接指向它们。CI 的 docker job 增一步 `promtool check rules`：`prom/prometheus` v3.5.0 以 **digest 固定**（`@sha256:63805ebb…`，与同文件 action 的 SHA 固定同风格）、`--network none`、规则目录只读挂载、仅 `promtool` 入口，不起 Prometheus 进程。
本机没有 `promtool`：本地只做 YAML 解析 + 结构检查（`groups[].rules[].alert/expr/labels.severity`），promtool 的 PromQL 语法检查要等 CI 实跑。`tests/metrics-export.test.mjs` 另断言：每个规则文件有 `groups`、每条告警恰有一个 `expr` 与 `severity`、告警名唯一、表达式里引用的每个 `os_erp_*` 序列（去掉 `_bucket/_sum/_count`）都出现在真实渲染的导出里、`os_erp_mcp_tool_calls_total{code=...}` 的码都在 `MCP_RESULT_CODES` 内，`monitoring.md` 不再内联规则且引用每个文件。

### MCP 计数端到端
测试在真实服务进程上用 `createToken` 建只读令牌，发真实 `tools/call`（`org.tree`），从 `/metrics?format=prometheus` 抓取 `os_erp_mcp_tool_calls_total{tool="org.tree",code="ok"}`：预置 0 → 1 → 2；未登记工具名不产生新序列。

### SIGTERM 指标快照
`server/index.js` 的 `SIGTERM` 处理（`process.once`）先写一行 JSON（`shutdownSnapshotLine`，`msg=metrics_snapshot`、`event=shutdown`，含 `counters`、`histograms`、`retry`），再 `server.close()` 并退出 0；5 s 兜底定时器（unref）。安全性：只读内存计数器、不查库、不含路径/账号；序列化失败折成 `metrics_snapshot_failed` 一行；`SIGKILL`/崩溃无快照。日志直接 `console.log` 一行 JSON（不经文本格式的 logger，以保证测试模式下同样是单行 JSON）。

### 审计（Codex）后的修正
- promtool 步骤：容器内没有 shell，`/alerts/*.yml` 不会被展开；改为挂载仓库根、`-w /w`，由宿主 shell 展开 `docs/operations/alerts/*.yml`。
- 快照落盘：`process.exit` 前等待 stdout 写回调（5 s 兜底），避免管道背压时截断。
- `OsErpWriteContention` 原先把"重试用尽"与"重试速率高"放在同一条且带 `for: 10m`：10 分钟窗口的 `increase` 撑不过 10 分钟的 pending 期，单次用尽永远不会触发。拆为 `OsErpWriteRetryExhausted`（无 `for`）与 `OsErpWriteContention`（速率，`for: 10m`）。
- 已知保留：`OsErpMcpAuditUnavailable` 依赖审计行落地后才计数，持续的 `mcp_call_logs` 写失败由 `OsErpAuditStrictWriteFailing`（`reason="mcp_call_log"`）覆盖，本条只看结果码。
