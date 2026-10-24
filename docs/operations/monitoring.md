# 监控与告警（Prometheus）

适用：ADR-0045（指标导出）、ADR-0029（运维块）。指标端点只读，不含账号、路径、业务数据。

运维人员的接入步骤摘要见操作手册第三十一章；`GML_METRICS_TOKEN` 等可选环境变量见安装手册 6.3。

## 1. 开启抓取

1. 生成抓取令牌（至少 32 字符；短于 32 字符令牌路径整体关闭）：
   ```sh
   openssl rand -hex 32
   ```
2. 只通过环境变量交给服务：`GML_METRICS_TOKEN=<上一步的值>`（与 `GML_JWT_SECRET` 一样放在 secrets/环境文件里，不进仓库、不进镜像、不进日志）。重启服务生效；轮换 = 换值并重启，Prometheus 侧同步更新。
   **轮换（AB10）**：先把新令牌设为 `GML_METRICS_TOKEN_NEXT` 并重启（此时新旧两把同时有效），把 Prometheus 侧换成新令牌，确认抓取正常后，把 `GML_METRICS_TOKEN` 改成新值、删除 `GML_METRICS_TOKEN_NEXT` 再重启。两把都要求 ≥32 字符，任何一把过短即被忽略。
3. 令牌**只**对 `GET /api/meta/metrics?format=prometheus` 有效；对 JSON 形态、`/health` 及其它接口无效。令牌不能放在 URL 里。

自测（把令牌放在 `curl` 的头里，不要写进 shell 历史时可用 `read -s`）：

```sh
curl -sS -H "Authorization: Bearer $GML_METRICS_TOKEN" 'http://127.0.0.1:3000/api/meta/metrics?format=prometheus' | head
```

**抓取节流（AB10）**：`/api/meta/metrics` 按来源 IP（`req.ip`，受 `GML_TRUST_PROXY` 约束）限速，独立于登录节流的桶，在鉴权之前计数（猜令牌同样受限）。默认每 IP 每 60 s 120 次，可用 `GML_METRICS_IP_LIMIT`（1..100000）与 `GML_METRICS_IP_WINDOW_MS`（1000..86400000）调整，非法值回退默认。超限返回 429，`error=METRICS_RATE_LIMITED` 并带 `Retry-After`。进程内计数，重启清零。

## 2. Prometheus 抓取配置

```yaml
scrape_configs:
  - job_name: os-erp
    metrics_path: /api/meta/metrics
    params:
      format: [prometheus]
    scrape_interval: 30s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/os-erp-metrics-token   # 文件内容只有令牌本身
    scheme: https            # 经反向代理终结 TLS 时；内网直连则 http
    static_configs:
      - targets: ['erp.example.internal:443']
```

要点：`credentials_file` 比内联 `credentials` 好（配置文件可以入库，令牌不入库）；令牌走 Authorization 头，不会出现在访问日志的 URL 里。Prometheus 与服务之间若不是回环/内网，必须走 TLS。

## 3. 指标

| 指标 | 类型 | 说明 |
|---|---|---|
| `os_erp_backup_age_seconds` | gauge | 最新备份报告距今秒数；未知 -1 |
| `os_erp_backup_last_failed` | gauge | 最新备份有失败 ⇒ 1 |
| `os_erp_backup_missing` | gauge | 没有任何备份报告 ⇒ 1 |
| `os_erp_migration_checksum_mismatches` | gauge | 迁移校验和不一致数；未知 -1 |
| `os_erp_migration_checksum_adopted` | gauge | 显式收养的迁移数 |
| `os_erp_login_throttle_unavailable` | gauge | 登录节流存储不可用 ⇒ 1（登录此时全部拒绝） |
| `os_erp_disk_free_bytes` | gauge | 数据卷可用字节；未知 -1 |
| `os_erp_login_throttle_rejections_total{reason}` | counter | `rate_limited` / `unavailable` |
| `os_erp_audit_strict_write_failures_total{reason}` | counter | `insert_error` / `no_row` / `outside_tx` / `mcp_call_log` |
| `os_erp_security_audit_unavailable_total` | counter | 因安全审计写不进去而回滚的业务变更次数 |
| `os_erp_write_calls_total`、`_retries_total`、`_retry_exhausted_total`、`_non_retryable_errors_total` | counter | 写事务重试统计（ADR-0035） |
| `os_erp_csp_violation_reports_total` | counter | **恒 0：未采集**（CSP 为 Report-Only 且没有报告端点，ADR-0036）；不要据此告警 |
| `os_erp_build_info{version}` | gauge | 恒 1 |

AB10 新增：

| 指标 | 类型 | 含义 |
|---|---|---|
| `os_erp_dashboard_cache_total{result="hit\|miss"}` | counter | 总部看板 TTL 缓存命中 / 未命中（汇总、趋势、排行、待办、库存分布；AC4 起含渠道，`/recent` 不缓存、不计数；`GML_DASHBOARD_CACHE_MS=0` 关闭缓存时不计数） |
| `os_erp_audit_write_duration_seconds_bucket{le}` / `_sum` / `_count` | histogram | `audit_logs` INSERT 耗时（秒，含失败的尝试）；固定桶 0.0005 … 1 与 `+Inf` |
| `os_erp_mcp_tool_calls_total{tool,code}` | counter | MCP 工具调用（以调用审计行成功落地为准），`code` 为 `ok` 或登记的错误码；未登记的工具名折成 `unknown`、未登记的码折成 `other`，基数固定 |

计数器是进程内的，重启归零；用 `increase()`/`rate()`，不要直接比较绝对值。

## 4. 告警规则（5 条 + AB10 的 4 条，见 4.1）

```yaml
groups:
  - name: os-erp
    rules:
      - alert: OsErpBackupStaleOrFailed
        # 备份失败、从未备份、或超过 26 小时没有新报告（每日备份留 2 小时余量）；未知（-1）也算异常
        expr: os_erp_backup_last_failed == 1 or os_erp_backup_missing == 1 or os_erp_backup_age_seconds > 93600 or os_erp_backup_age_seconds == -1
        for: 15m
        labels: { severity: critical }
        annotations:
          summary: "OS-ERP 备份失败/缺失/过期"
          description: "按 docs/operations/restore-runbook.md 检查备份目录与最新 backup-report；备份没跑（cron 挂了）只有这条规则能发现。"

      - alert: OsErpAuditStrictWriteFailing
        # 安全审计写不进去 ⇒ 受保护的业务变更全部 503 回滚；任何一次都值得看
        expr: increase(os_erp_security_audit_unavailable_total[10m]) > 0 or increase(os_erp_audit_strict_write_failures_total{reason=~"insert_error|no_row|mcp_call_log"}[10m]) > 0
        labels: { severity: critical }
        annotations:
          summary: "严格审计写失败，业务变更被回滚"
          description: "检查 audit_logs / mcp_call_logs 表、磁盘空间、数据库只读或锁。outside_tx 是编码错误，不在此规则内，看日志 AUDIT_OUTSIDE_TX。"

      - alert: OsErpLoginThrottleUnavailable
        # 节流存储坏了 ⇒ 登录 fail closed（全部 503），或已经出现 unavailable 拒绝
        expr: os_erp_login_throttle_unavailable == 1 or increase(os_erp_login_throttle_rejections_total{reason="unavailable"}[10m]) > 0
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "登录节流存储不可用，用户无法登录"
          description: "检查数据目录下 login-throttle.sqlite 的权限/损坏/磁盘；见 ADR-0005。"

      - alert: OsErpWriteContention
        # 写重试用尽 = 有请求因 SQLITE_BUSY 最终失败；或重试速率持续偏高
        expr: increase(os_erp_write_retry_exhausted_total[10m]) > 0 or rate(os_erp_write_retries_total[10m]) > 1
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "写事务争用：重试用尽或重试频繁"
          description: "检查是否有长事务/备份与写入同时进行；见 ADR-0035，必要时调 GML_WRITE_RETRY_MAX 或错开备份时段。"

      - alert: OsErpDiskLowOrMigrationDrift
        # 磁盘可用低于 5 GiB（-1 为未知，不触发），或迁移文件与已登记校验和不一致
        expr: (os_erp_disk_free_bytes >= 0 and os_erp_disk_free_bytes < 5 * 1024 * 1024 * 1024) or os_erp_migration_checksum_mismatches > 0
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "数据卷空间不足或迁移校验和漂移"
          description: "磁盘写满会让备份与审计写入失败；校验和不一致说明已应用的迁移文件被改过，先评审再决定是否收养。"
```

另外建议（非 OS-ERP 指标）：用 `up{job="os-erp"} == 0` 监控抓取本身；`rate_limited` 的突增可单独做看板观察撞库趋势，但不建议直接告警（误输入会触发）。

### 4.1 AB10 新增序列的告警规则

```yaml
groups:
  - name: os-erp-ab10
    rules:
      - alert: OsErpDashboardCacheIneffective
        # 看板请求持续、但命中率低于 20%：库写入频繁使缓存不断失效，或 TTL 被配得过短。命中率低本身不是故障，仅提示
        expr: |
          sum(increase(os_erp_dashboard_cache_total{result="hit"}[30m]))
            / clamp_min(sum(increase(os_erp_dashboard_cache_total[30m])), 1) < 0.2
          and sum(increase(os_erp_dashboard_cache_total[30m])) > 60
        for: 30m
        labels: { severity: info }
        annotations:
          summary: "总部看板缓存命中率低"
          description: "检查 GML_DASHBOARD_CACHE_MS 是否为 0/过小，或写入是否过于频繁（ADR-0044：任何写入都会让缓存失效）。"

      - alert: OsErpAuditWriteSlow
        # 审计写入 p95 超过 100 ms：磁盘或锁争用，会拖慢所有受审计的写请求
        expr: histogram_quantile(0.95, sum by (le) (rate(os_erp_audit_write_duration_seconds_bucket[10m]))) > 0.1
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "审计写入 p95 延迟超过 100ms"
          description: "检查磁盘 IO、WAL 检查点、备份是否与写入重叠；与 OsErpWriteContention 一起看。"

      - alert: OsErpMcpDeniedSpike
        # 权限/范围类拒绝突增：令牌被滥用或配置错误的 Agent 在反复撞墙
        expr: sum(increase(os_erp_mcp_tool_calls_total{code=~"PERM_DENIED|SCOPE_DENIED|TOOL_DENIED|TOOL_NOT_ALLOWED|TOKEN_OWNER_PERM_DENIED|ORG_OUT_OF_SCOPE"}[10m])) > 50
        labels: { severity: warning }
        annotations:
          summary: "MCP 工具调用被拒绝次数突增"
          description: "到 MCP 调用日志（mcp_call_logs）按 token_name 看是谁；必要时吊销该令牌。"

      - alert: OsErpMcpAuditUnavailable
        # 调用审计写不进去的同时仍有工具调用失败：与 OsErpAuditStrictWriteFailing 互补（后者按失败计数，这里看 AUDIT_UNAVAILABLE 结果码）
        expr: increase(os_erp_mcp_tool_calls_total{code="AUDIT_UNAVAILABLE"}[10m]) > 0
        labels: { severity: critical }
        annotations:
          summary: "MCP 写型工具因调用审计不可用而被拒"
          description: "检查 mcp_call_logs 表与磁盘；见 ADR-0011。"
```

#### 缓存命中率告警（`OsErpDashboardCacheIneffective`）阈值怎么来的（AC4）

先说清楚：**20% 与 `> 60 次 / 30 分钟` 是按下面的模型选的"值得提示"的线，不是用生产流量标定的**——还没有 `dmserver` 上的真实抓取数据，上线后用本节方法复核。

**命中率由什么决定。** `db-ttl-cache` 的失效判据（ADR-0044）：30 s TTL，且该连接上**任何**写入（`total_changes()`）或别的进程提交（`data_version`）都使全部键失效。因此一个端点的命中率只取决于两个量：读的间隔 `r`（看板自动刷新 / 多人同时打开）和写入的平均间隔 `w`：

- 上限 = `floor(30/r) / (floor(30/r)+1)`：每次未命中之后最多还能命中 `floor(30/r)` 次——`r=5 s` 为 85.7%，`r=15 s` 为 66.7%；写入再少也越不过这条线（所以"命中率 99%"不是合理目标）。
- 写入变密则下降：下表用**真实的 `cachedForDb`**（注入时钟，6 小时模拟读取，写入间隔服从指数分布，种子固定）跑出来，并在 `tests/dashboard-perf.test.mjs`（`AC4 cache hit-ratio model`）里断言——测试同时核对 AB10 的 `os_erp_dashboard_cache_total{result}` 计数器的 hit / miss 与模型一致，所以"命中率 = hit 增量 ÷ (hit+miss) 增量"这个 PromQL 口径就是模型口径。

| 写入平均间隔 `w` | 2 s | 5 s | 10 s | 15 s | 30 s | 60 s | 300 s |
|---|---|---|---|---|---|---|---|
| 命中率（`r = 5 s`）| 0.08 | 0.35 | 0.60 | 0.69 | 0.78 | 0.82 | 0.85 |
| 命中率（`r = 15 s`）| 0.00 | 0.05 | 0.21 | 0.33 | 0.51 | 0.58 | 0.65 |

**为什么线画在 20%。** 从表里读：`r = 15 s` 时 20% 对应"平均每 10 s 就有一次写入"；`r = 5 s` 时对应"平均每 3–4 s 一次"。也就是写入密到**平均不足一个轮询周期就来一次**，缓存几乎总是未命中，只多出每次读取时的版本校验（`total_changes()` 与 `data_version`，未单独测量）而省不下查询。这种实例继续开着缓存无害，只是缓存没有价值——所以告警等级是 `info`，不是 `warning`：它提示"缓存在白跑"，不是"服务有问题"。更高的线（如 50%）在模型里就会误报：`r = 15 s`、写入每 30 s 一次的完全正常实例命中率只有 51%，轮询更慢时上限更低。
**样本量条件 `> 60 次 / 30 分钟`**：约每 30 s 一次读取。样本太少时一次未命中就能把比值拉到 0，没有意义；`GML_DASHBOARD_CACHE_MS=0` 关闭缓存时根本不计数，因此不会触发（模型测试里有断言）。`for: 30m` 则是为了跳过批量导入 / 夜间备份引起的短时写入高峰。
**上线后怎么复核**：取一周的 `sum(increase(os_erp_dashboard_cache_total{result="hit"}[1h])) / sum(increase(os_erp_dashboard_cache_total[1h]))` 的分布，营业高峰 p10 若长期接近或低于 20%，说明阈值太敏感（调低到该分布的 p5）或写入真的太密（该调查写入来源，而不是调阈值）。AC4 起 `/channel` 也计入同一计数器（`/recent` 不缓存、不计数）。

说明：抓取被节流（429）时 Prometheus 侧表现为 `up == 0`，已有的 `up{job="os-erp"} == 0` 规则覆盖；默认限额（120 次/分钟/IP）远高于 30 s 一次的抓取频率。

## 5. 排障

- 抓取返回 401：令牌与服务的 `GML_METRICS_TOKEN` 不一致、服务端令牌短于 32 字符（被禁用）、或用了 `/metrics` 的 JSON 形态（令牌只对 `format=prometheus` 有效）。
- 备份指标全是 -1/`backup_missing=1`：指标读取的是备份目录里最新的 `backup-report-*.json`（目录规则同 `db-backup`，可由设置项 `backup_dir` 指定）；还没跑过备份就是这个状态。
- 计数器为 0 但日志里有对应事件：多半是进程重启过（计数器归零），或抓到的是另一个实例。
