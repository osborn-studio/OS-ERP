# 监控与告警（Prometheus）

适用：ADR-0045（指标导出）、ADR-0029（运维块）。指标端点只读，不含账号、路径、业务数据。

## 1. 开启抓取

1. 生成抓取令牌（至少 32 字符；短于 32 字符令牌路径整体关闭）：
   ```sh
   openssl rand -hex 32
   ```
2. 只通过环境变量交给服务：`GML_METRICS_TOKEN=<上一步的值>`（与 `GML_JWT_SECRET` 一样放在 secrets/环境文件里，不进仓库、不进镜像、不进日志）。重启服务生效；轮换 = 换值并重启，Prometheus 侧同步更新。
3. 令牌**只**对 `GET /api/meta/metrics?format=prometheus` 有效；对 JSON 形态、`/health` 及其它接口无效。令牌不能放在 URL 里。

自测（把令牌放在 `curl` 的头里，不要写进 shell 历史时可用 `read -s`）：

```sh
curl -sS -H "Authorization: Bearer $GML_METRICS_TOKEN" 'http://127.0.0.1:3000/api/meta/metrics?format=prometheus' | head
```

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

计数器是进程内的，重启归零；用 `increase()`/`rate()`，不要直接比较绝对值。

## 4. 告警规则（5 条）

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

## 5. 排障

- 抓取返回 401：令牌与服务的 `GML_METRICS_TOKEN` 不一致、服务端令牌短于 32 字符（被禁用）、或用了 `/metrics` 的 JSON 形态（令牌只对 `format=prometheus` 有效）。
- 备份指标全是 -1/`backup_missing=1`：指标读取的是备份目录里最新的 `backup-report-*.json`（目录规则同 `db-backup`，可由设置项 `backup_dir` 指定）；还没跑过备份就是这个状态。
- 计数器为 0 但日志里有对应事件：多半是进程重启过（计数器归零），或抓到的是另一个实例。
