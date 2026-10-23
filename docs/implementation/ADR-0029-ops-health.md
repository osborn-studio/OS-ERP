# ADR-0029 运维健康块、计数器与备份失败告警

状态：已采纳（X8）｜相关：ADR-0008（出站策略与通知渠道）、ADR-0009 / ADR-0022（备份报告与加密）、ADR-0012（健康/版本契约）、ADR-0023（日志）

## 背景

备份失败、迁移文件被改、登录节流存储不可用、磁盘写满，原先都只有"事后翻日志"才能发现；`/api/meta/health` 又是公开端点，不能把这些细节直接放上去。

## 决策

1. `server/lib/ops-status.js` 只读汇总，每项独立 try/catch（一项失败只让该项变 null / unavailable）：

```
ops = {
  last_backup:         { at: ISO|null, result: 'ok'|'failed'|'none'|'unreadable', encrypted: bool|null, age_seconds: n|null },
  migration_checksums: { mismatched: n|null, adopted: n|null },
  login_throttle:      'ok' | 'unavailable',
  disk_free_bytes:     n | null,            // GML_DATA_DIR 所在卷的可用字节
  db_sizes:            { cosmetic: n|null, food: n|null, apparel: n|null }  // 主库文件字节，不含路径
}
```

   - `last_backup` 读备份目录（`backup-dir.js` 解析，同 db-backup）里**字典序最新**的 `backup-report-*.json`，只取 `generated_at / failed / encrypted` 三个字段，不透出路径、sha256、库文件名。
   - `mismatched` 来自 `checkMigrationChecksums`；`adopted` 是 `schema_migrations.checksum_origin='adopted'` 的行数（显式收养过的迁移，评审痕迹）。
   - `login_throttle` 为只读探测：存储文件存在则只读打开并核对元数据行，不存在（尚无人登录）则看数据目录是否可写；不创建、不写。
2. `GET /api/meta/health`：**匿名**（以及无 admin 权限者）只得到 `status / service / version / build_sha / time`（ADR-0012 契约；Docker HEALTHCHECK 与 `docker-smoke` 不带令牌，仍 200）。带有效 admin（角色 `admin` 或 `is_super`）令牌时另得 `database`（原先匿名可见的表数/商品数/是否已灌数，现收紧到 admin）与 `ops`。可选鉴权：无 Bearer ⇒ 匿名放行；带了无效令牌 ⇒ 401（不悄悄降级为匿名）。
3. `GET /api/meta/metrics`（admin 或 is_super，否则 403/401）返回 `{counters}`：`backup_age_seconds`、`backup_last_failed`、`backup_missing`、`migration_checksum_mismatches`、`migration_checksum_adopted`、`login_throttle_unavailable`、`disk_free_bytes`；未知值为 -1，便于告警规则统一写 `> x` / `== -1`。
4. 备份失败告警：`scripts/db-backup.mjs` 在有失败时，若环境变量 `GML_ALERT_CHANNEL` 是**已存在**的通知渠道 code，则经 `notify.js` 的 `pushToChannel`（出站策略、签名、留痕 `notify_logs`，`triggered_by='db-backup'`）发一条简短告警；全部成功时**静默**，不查渠道、不发。
   - 内容仅含：数据目录**目录名**、失败的行业码、`BACKUP_*` 错误**码**、时间。不含错误原文（可能带路径）、不含 URL/密钥/sha256/文件路径。逻辑在 `server/lib/backup-alert.js`，发送器可注入以便测试。
   - 渠道在本次备份涉及的行业库中依次查找（通知渠道按库存放）。
   - 失败不被吞：结果以 `ALERT_SENT` / `ALERT_NOT_SENT: <status> <code>` 写 stderr（`disabled / channel_missing / failed / error`）；告警自身失败**不改变**备份退出码（有失败本来就是 1）。

## 后果与限制

- 公开健康响应不再含 `database`：依赖它做哨兵的旧脚本 `scripts/test-industry-code.mjs`（匿名读 `database.products` 判断落到哪个库）需带 admin 令牌或改用别的哨兵；本批未改（该脚本不在焦点测试内，也不得跑 regress 套件）。
- 告警沿用采购待办的 digest 渲染（"共 N 项待办，合计 ¥0.00"的措辞），未为告警新增模板；渠道群里会看到这个措辞。要改措辞需动 `notify.js` 渲染，另开项。
- 只有备份**失败**才告警；备份**没跑**（cron 挂了）不会触发——这要靠 `/api/meta/metrics` 的 `backup_age_seconds` / `backup_missing` 由外部监控判断。
- `/api/meta/metrics` 是 JSON 而非 Prometheus 文本格式。
- 告警走的是通知渠道的 webhook，受出站策略限制：指向私网/回环地址的渠道会被拒绝并记入 `notify_logs`（stderr 为 `ALERT_NOT_SENT: failed`）。

## 验证

`tests/ops-health.test.mjs`：报告解析（最新/失败/损坏/加密/年龄/自定义 backup_dir）、节流探测、磁盘与库大小降级、计数器映射、告警内容无路径与秘密、注入发送器的六种结果、`db-backup` 子进程（成功静默、缺渠道、经 notify 失败留痕且 payload 无路径）、真实服务上匿名/viewer/无效令牌/admin 的健康响应形状与 `metrics` 的 401/403/200。
