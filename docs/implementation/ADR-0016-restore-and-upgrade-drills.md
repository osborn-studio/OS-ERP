# ADR-0016：恢复演练与升级失败回退演练

日期：2026-10-22。承接 ADR-0009"明确未做"中的两项开放点（F12）：没有从备份文件到可登录服务的完整恢复演练，没有升级失败后回退到旧备份的实测记录，未测量 RPO/RTO。范围：`scripts/db-restore-drill.mjs`、`scripts/upgrade-rollback-drill.mjs`、共用底座 `scripts/lib/drill-common.mjs`、操作手册 `docs/operations/restore-runbook.md`。**不包含**异地备份、加密、跨库一致性点、自动化定期演练调度。

## 问题

ADR-0009 的备份校验只做到"快照能只读打开并在 `users` 上 COUNT"。它不能回答运维最关心的三个问题：这套备份文件在一台干净机器上真的能把服务拉起来并登录吗；恢复要多久（RTO）、备份离现在多久（RPO）；一次升级在迁移中途失败后，库是停在旧版本还是留下半截结构，回退到旧备份后能不能起来。这些问题此前只有"手工动作"的文字描述，没有可重复执行、可留证据的工具。

## 决定

### 共同约束（两个演练共用，`scripts/lib/drill-common.mjs`）

1. 演练**只在一个与线上无关的空目录**上进行。`--target-dir` 必须是显式绝对路径，且：要么不存在要么为空目录（`DRILL_TARGET_NOT_EMPTY`）；不等于备份报告记录的来源 `data_dir`（`DRILL_TARGET_IS_LIVE`）；不等于调用方环境里的 `GML_DATA_DIR`（同码）；不与备份目录互相包含（`DRILL_TARGET_OVERLAPS_BACKUP`）。被拒绝时退出码 2，不创建、不改动任何文件。演练脚本本身不读 `GML_DATA_DIR`，所有子进程都显式得到 `GML_DATA_DIR=<目标目录>`、`GML_RUNTIME_MODE=production`、`GML_DB=`，不继承调用方的 `GML_*` 与密钥。
2. 备份集来自 `backup-report-<stamp>.json`（缺省最新，`--stamp` 指定），只取 `status=ok` 的库。复制前逐个核对文件 sha256，**任一不符一个字节都不复制**（`RESTORE_SHA256_MISMATCH`，退出码 1）。复制用 `COPYFILE_EXCL` 并删除目标处可能存在的 `-wal`/`-shm`，复制后再核对一次。
3. 只接受运行模式标记为 `production` 的备份（ADR-0001 的 `os_egp_runtime`）。demo/test 库按 ADR-0001 可丢弃，不是恢复演练的对象；它们在生产模式下会被闸门拒绝，与其得到一个误导性的失败，不如在参数阶段就拒绝（`DRILL_BACKUP_NOT_PRODUCTION`，退出码 2）。
4. 迁移与服务都走**真实入口的子进程**：`scripts/migrate.mjs`（含 ADR-0009 校验和核对）与 `server/index.js`（`HOST=127.0.0.1`、随机空闲端口、每次演练随机生成的 48 字节 JWT 密钥、`NODE_ENV=production`）。演练证明的是"这套备份 + 这份代码"能起来，不是演练脚本内存里的另一套逻辑。密钥只存在于子进程环境，不进报告、不进日志。
5. 探针口径只有一份（`PROBES`）：`users`、`products`、`purchase_orders`、`receipts` 四张表的 `COUNT(*)`，以及应收未收余额 `SUM(amount - allocated_amount) WHERE status IN ('open','partial')`（与 `server/lib/ar.js` 的 `arOverview().open_amount` 同一公式，同样保留两位小数）。SQL 侧直接只读打开**备份文件**算期望值；HTTP 侧经已认证接口 `/api/auth/users`、`/api/master/products`、`/api/purchase/orders`、`/api/ar/receipts`（`pageSize=1` 取 `total`）与 `/api/ar/overview` 取实际值。
6. 报告写在目标目录内（`restore-drill-<stamp>.json` / `upgrade-rollback-drill-<stamp>.json`，mode 0600），包含备份来源、sha256、迁移输出尾部、端口、账号名、探针、耗时与失败原因；**不含**密码、密钥、令牌、密码哈希。源备份目录与来源 `data_dir` 永不改动。

### 恢复演练（`scripts/db-restore-drill.mjs`）

1. 顺序：参数与目标目录判定 → 读备份文件算探针期望值并判定账号来源 → sha256 核对并复制 → 生产迁移 → （仅需要时）建演练管理员 → 拉起服务等 `/api/meta/health` 返回 `status=ok` → 登录 → HTTP 探针 → 逐项比对 → 写报告。任一环节失败即停止并退出码 1；服务进程在 finally 中以 SIGTERM 回收（10 秒后 SIGKILL）。
2. 账号：备份里有账号时必须给 `--drill-username=<账号>`，密码只经非交互 stdin 一行传入（与 ADR-0003 同一原则：不接受参数、不接受环境变量、不回显）；给了账号名却没有 stdin 密码，或有账号却没给账号名（`DRILL_ACCOUNT_REQUIRED`）均退出码 2。只有当备份里 `users` 为 0 行时，才用现有 `scripts/bootstrap-admin.mjs` 在**恢复副本**里创建演练管理员（随机 27 字节密码，仅存在于进程内存；账号名 `drill_<stamp>`），此时 `users` 探针的期望值 +1 并在报告 `note` 里标明、`account.created_by_drill=true`。ADR-0003 的 bootstrap 前置条件（空用户表、无业务组织、无一次性标记）保证这条路径不会接管任何真实账号。
3. RTO：`timing.total_ms`（= `rto_ms`）是从脚本启动到探针比对结束的全程耗时，并拆成 `verify_ms`（sha256 + 复制）、`migrate_ms`、`server_ready_ms`、`probe_ms`。RPO 指标：`backup.age_seconds` = 当前时间 − 备份报告 `generated_at`；这是"备份离现在多久"，不是数据丢失量本身——后者取决于备份频率与最后一笔业务的时间，报告里同时给出备份文件 mtime 供人工对照。
4. `--fault=probe-skew` 是唯一的故障注入入口：命令行可见、写进报告 `fault` 字段、必然使 `users` 探针不符并退出码 1。它存在是为了证明"不符会红"，不是运维选项。

### 升级失败回退演练（`scripts/upgrade-rollback-drill.mjs`）

1. 顺序：恢复（同上）→ 生产迁移基线 → 对每个恢复库取快照（`schema_migrations` 全部行 + `sqlite_master` 非内部对象）→ 在**临时迁移目录副本**里追加 `999_drill_failing_upgrade.cjs`（先 `CREATE TABLE drill_upgrade_partial`、再 INSERT 一行、然后抛 `DRILL_UPGRADE_FAILURE`），以 `runMigrations(db, { migrationsDir, mode: 'production' })` 执行 → 核不变量 → 在第二份副本里篡改第一个已执行迁移文件再跑一次 → 回退。临时副本在 finally 中删除；失败迁移**永不**出现在 `server/db/migrations/`。
2. 不变量（任一失败退出码 1，报告 `invariants[]` 逐条记录）：`failing_migration_threw`；`no_partial_table`（半截表不存在）；`schema_migrations_unchanged`（版本表逐字段与基线相同）；`schema_objects_unchanged`（`sqlite_master` 相同）；`no_failed_migration_recorded`；`checksums_intact`（`checkMigrationChecksums` 无 mismatched/unrecorded，verified 数等于基线）；`integrity_ok`；`tampered_file_rejected_before_write`（`MIGRATION_CHECKSUM_MISMATCH` 且库快照不变）；`rollback_sha256_verified`；`rollback_migrations_ok`；`rollback_server_healthy`；`rollback_data_retained`（回退后副本的 SQL 探针与备份文件逐项相同）。
3. 回退步骤就是手册里要求操作员做的事：删掉副本库与 `-wal`/`-shm` → 从备份重新核对 sha256 并复制 → 生产迁移 → 启动 → 健康检查。演练把这套动作跑一遍并计时（`timing.rollback_ms`），操作手册引用同一顺序。
4. 这里证明的是运行器两条既有契约（ADR-0009）：单个迁移一个事务、校验和核对先于任何写入。改动运行器的事务边界会让这些不变量变红，那是预期的红。

## 契约变化

- 新增脚本与退出码：两个演练均为 0 通过 / 1 任一校验、迁移、启动、登录、探针或不变量失败 / 2 参数、目标目录、备份集或账号来源被拒绝。退出码 2 时不写报告、不创建文件（目标目录若由演练新建则为空）。
- 新增错误码：`DRILL_USAGE`、`DRILL_TARGET_NOT_EMPTY`、`DRILL_TARGET_IS_LIVE`、`DRILL_TARGET_OVERLAPS_BACKUP`、`DRILL_BACKUP_DIR_MISSING`、`DRILL_BACKUP_REPORT_MISSING`、`DRILL_BACKUP_REPORT_INVALID`、`DRILL_BACKUP_EMPTY`、`DRILL_BACKUP_NOT_PRODUCTION`、`DRILL_ACCOUNT_REQUIRED`、`RESTORE_SHA256_MISMATCH`、`RESTORE_COPY_CORRUPT`、`DRILL_MIGRATION_FAILED`、`DRILL_BOOTSTRAP_FAILED`、`DRILL_SERVER_NOT_READY`、`DRILL_LOGIN_FAILED`、`DRILL_PROBE_HTTP_FAILED`、`PROBE_MISMATCH`、`INVARIANT_FAILED`。
- 没有新增生产环境变量；运行器、备份脚本、服务端代码未改动。`runMigrations` 的 `migrationsDir` 选项（ADR-0009 已有）是回退演练注入失败迁移的唯一途径。
- `scripts/check-file-header.mjs` 的 DECLARED 新增三个文件。

## 操作命令

```sh
# 恢复演练：备份里已有账号 → 演练账号密码经 stdin
python3 -c 'import getpass,sys; sys.stdout.write(getpass.getpass("演练账号密码: ")+"\n")' |
  node scripts/db-restore-drill.mjs \
    --backup-dir=/absolute/os-egp-data/backups \
    --target-dir=/absolute/empty/restore-drill-$(date +%Y%m%d) \
    --drill-username=owner --industry=cosmetic
echo $?; cat /absolute/empty/restore-drill-*/restore-drill-*.json

# 升级失败回退演练（不需要账号）
node scripts/upgrade-rollback-drill.mjs \
  --backup-dir=/absolute/os-egp-data/backups \
  --target-dir=/absolute/empty/upgrade-drill-$(date +%Y%m%d)
```

两个命令都**不要**设置 `GML_DATA_DIR`（设了且等于目标目录会被拒绝）；完整操作步骤见 `docs/operations/restore-runbook.md`。

## 验证

`node --test tests/restore-drill.test.mjs tests/upgrade-rollback-drill.test.mjs`（均纳入 `npm run test:focused`）。两个测试文件都用真实子进程：用 `scripts/bootstrap-admin.mjs` 或 `production-boot.js` 在临时目录建生产库、写入少量应收/收款行、用 `scripts/db-backup.mjs` 生成备份集，再跑演练脚本。

恢复演练 6 项：完整链路通过且报告/耗时字段/探针（含 `ar_open_balance=270.25`）齐全、源备份 sha256 不变、输出与报告不含密码或哈希；篡改备份文件 → `RESTORE_SHA256_MISMATCH`、退出码 1、目标目录没有库文件、报告 `migrations`/`server` 为 null；`--fault=probe-skew` → `PROBE_MISMATCH`、退出码 1；非空目标 / 目标等于来源 `data_dir` / 目标等于调用方 `GML_DATA_DIR` / 相对路径 → 退出码 2 且不动任何文件；空账号备份 → 在副本里建演练管理员、`users` 期望 1、源库仍为 0 行；有账号却不给账号名 → `DRILL_ACCOUNT_REQUIRED`。

回退演练 3 项：11 条不变量全部成立、副本库无 `drill_upgrade_partial`、无 `999_%` 登记行、哨兵表数据保留、校验和列无 NULL；篡改备份 → 退出码 1、报告 `invariants=[]`、未复制；非空目标与未知参数 → 退出码 2。

2026-10-22 本工作树实测（macOS Apple Silicon、Node 22，**fixture 规模**：单库约 2.7 MB、51 个迁移、1 个用户、0 商品）：恢复演练 RTO 约 1.8 秒（sha256+复制 <10 ms、迁移约 140 ms、服务就绪约 1.3 秒、登录+探针约 100 ms）；回退演练全程约 1.7 秒。**这不是生产规模的 RTO**：生产库的复制与 `integrity_check` 耗时与文件大小成正比，服务就绪时间与机器相关，必须在目标 Linux 主机上用真实备份测量后才能写进 SLA。

## 明确未做

- 没有在目标 Linux 主机（`dmserver`）上用真实规模备份测量过 RTO/RPO；本 ADR 的数字只证明工具链可用。
- 三个行业库仍是各自快照；演练逐库恢复并逐库比对，不证明跨库同一业务时刻。
- 探针只有五项计数/余额，不是全表比对；它们能发现"恢复错了库 / 恢复了旧版本 / 升级改了数据"这类粗错误，不能发现单笔明细差异。需要更强的证据时应扩展 `PROBES`，而不是在演练外另写一套。
- 演练在恢复副本里创建的管理员只存在于副本；演练不负责清理目标目录（保留作为证据，由操作员按手册删除）。
- 不自动调度定期演练；手册规定频率，执行记录靠报告文件留存。
- 没有演练"生产机器上就地回退"（停服、替换文件、重启）——那一步仍是手册里的人工动作，演练只证明备份文件与回退顺序本身有效。
