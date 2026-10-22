# 恢复与升级回退操作手册

适用：OS-ERP 单机部署（三个行业 SQLite 库，`GML_DATA_DIR` 显式绝对路径）。依据 ADR-0009（备份校验）、ADR-0016（恢复与回退演练）。本手册只写操作步骤与判据；为什么这样做见 ADR。

前提约定：

- 线上数据目录记为 `$DATA`（例如 `/srv/os-egp-data`），备份目录缺省为 `$DATA/backups`。
- 所有命令在仓库根目录执行，Node 22。演练与恢复都**不要**继承 shell 里残留的 `GML_DATA_DIR`：演练脚本以参数指定目录，线上命令显式写环境变量。
- 密码一律经 stdin 管道传入（`getpass` 或密码管理器），不写在命令行、不写在环境变量、不写进日志。

## 1. 日常：生成并校验备份

```sh
GML_RUNTIME_MODE=production GML_DATA_DIR=$DATA GML_DB= node scripts/db-backup.mjs
echo $?          # 必须是 0；1 = 某库快照或校验失败（旧备份不裁剪），2 = 参数/环境错误
ls -l $DATA/backups/
```

判据：退出码 0，且 `backup-report-<stamp>.json` 里每个库 `status=ok`。任何 `*.db.failed` 文件都要当天排查。建议频率：每日一次，升级前必做一次。

## 2. 定期：恢复演练（证明备份能起来，量 RTO/RPO）

频率：每月一次，以及每次升级前。演练在一台与线上无关的机器或线上机器上的一个**空目录**里做，不会碰线上目录。

### 2.1 备份里已有账号（正常情况）

准备一个演练用账号（建议专门建一个 `admin` 角色的只读巡检账号，不要用老板账号）：

```sh
TARGET=/srv/drills/restore-$(date +%Y%m%d-%H%M)    # 必须是不存在或空的目录
python3 -c 'import getpass,sys; sys.stdout.write(getpass.getpass("演练账号密码: ")+"\n")' |
  node scripts/db-restore-drill.mjs \
    --backup-dir=$DATA/backups \
    --target-dir=$TARGET \
    --drill-username=<演练账号> --industry=cosmetic
echo $?
```

`--industry` 决定登录和探针用哪个库（cosmetic / food / apparel），缺省取备份集中第一个库；`--stamp=yyyyMMdd-HHmmss` 可指定非最新的备份集。三个库都要演练时，换 `--industry` 各跑一次（每次用新的空目录）。

### 2.2 备份里没有任何账号（刚初始化、尚未 bootstrap）

不给 `--drill-username`，演练会用 `scripts/bootstrap-admin.mjs` 在**恢复副本**里建一个临时管理员（源备份与线上库不受影响）：

```sh
node scripts/db-restore-drill.mjs --backup-dir=$DATA/backups --target-dir=$TARGET --industry=cosmetic
```

### 2.3 读结果

```sh
cat $TARGET/restore-drill-*.json
```

| 字段 | 判据 |
| --- | --- |
| `passed` | 必须 `true`，退出码 0 |
| `restored[].sha256_verified` | 全部 `true` |
| `migrations.status` | `ok`（生产模式，含迁移文件校验和核对） |
| `server.ready_ms` | 服务健康检查通过的耗时 |
| `probes[].match` | 全部 `true`；`expected` 来自备份文件，`actual` 来自登录后的 HTTP 接口 |
| `timing.rto_ms` | 本次恢复总耗时（RTO 实测） |
| `backup.age_seconds` | 备份年龄（RPO 指标）：超过备份周期说明备份任务没跑 |

退出码含义：0 通过；1 校验和、迁移、启动、登录或探针不符（看 `failures[]`）；2 参数或目录被拒绝（没有写任何文件，看 stderr）。

常见拒绝：

- `DRILL_TARGET_NOT_EMPTY`：目标目录非空。换一个新目录，不要清空旧目录来复用（旧报告是证据）。
- `DRILL_TARGET_IS_LIVE`：目标目录是备份来源的线上目录，或等于当前 shell 的 `GML_DATA_DIR`。演练永远不在线上目录做。
- `DRILL_ACCOUNT_REQUIRED`：备份里有账号，必须提供 `--drill-username` 与 stdin 密码。
- `RESTORE_SHA256_MISMATCH`（退出码 1）：备份文件与报告不符，**该备份不可用**，立刻检查备份介质并重新备份。

### 2.4 收尾

把 `restore-drill-<stamp>.json` 归档到运维记录（它不含密码/密钥/令牌），然后删除 `$TARGET`（里面是线上数据的副本，含演练临时管理员）。记录本次 `rto_ms` 与 `age_seconds`。

## 3. 升级前：升级失败回退演练

频率：每次升级前，在升级前最新的备份集上跑一次。不需要账号。

```sh
TARGET=/srv/drills/upgrade-$(date +%Y%m%d-%H%M)
node scripts/upgrade-rollback-drill.mjs --backup-dir=$DATA/backups --target-dir=$TARGET
echo $?
cat $TARGET/upgrade-rollback-drill-*.json
```

判据：退出码 0、`passed=true`、`invariants[]` 全部 `passed=true`。它证明了：一个在中途失败的迁移不会给库留下半截结构、版本表与校验和表完好、被篡改的迁移文件在动库之前就被拒绝、从备份回退后生产迁移与服务都能起来、回退后的数据与备份一致。任一条红，**不要升级**，先修。

收尾同 2.4。

## 4. 真实恢复（线上库损坏 / 需要回到某个备份）

这是手工动作，顺序与回退演练一致。操作前先在空目录对该备份集跑一次第 2 节的恢复演练（几秒钟），确认备份可用再动线上。

1. 停服，确认没有进程持有库文件：

   ```sh
   # 以部署方式为准（systemd / launchd / 手工进程）
   lsof $DATA/gml_*.db || true
   ```

2. 把当前（可能损坏的）线上文件移走留证，**不要删除**：

   ```sh
   mkdir -p $DATA/incident-$(date +%Y%m%d-%H%M)
   mv $DATA/gml_cosmetic.db $DATA/gml_cosmetic.db-wal $DATA/gml_cosmetic.db-shm $DATA/incident-*/ 2>/dev/null
   # food / apparel 同理，只移需要恢复的库
   ```

3. 选定备份集，核对 sha256 后复制为线上文件名（每库一行；`-wal`/`-shm` 一定要一起清掉）：

   ```sh
   STAMP=<backup-report 的 stamp>
   jq -r '.results[] | select(.status=="ok") | "\(.sha256)  \(.file)"' $DATA/backups/backup-report-$STAMP.json | shasum -a 256 -c
   cp $DATA/backups/gml_cosmetic_$STAMP.db $DATA/gml_cosmetic.db
   rm -f $DATA/gml_cosmetic.db-wal $DATA/gml_cosmetic.db-shm
   ```

   `shasum -c` 任一行不是 `OK` 就停下，换另一个备份集。

4. 生产模式迁移（会核对迁移文件校验和；不一致会拒绝，说明部署的代码与建库时不一致，先查代码再继续）：

   ```sh
   GML_RUNTIME_MODE=production GML_DATA_DIR=$DATA GML_DB= node scripts/migrate.mjs
   GML_RUNTIME_MODE=production GML_DATA_DIR=$DATA GML_DB= node scripts/verify-migrations.mjs
   ```

5. 启动服务，确认健康检查与登录：

   ```sh
   curl -s http://127.0.0.1:<端口>/api/meta/health
   ```

   然后用业务账号登录，对照备份当天的关键数字（用户数、商品数、采购单数、收款单数、应收未收余额——与演练探针同一口径）。

6. 记录：恢复用的备份 stamp、操作时间、停服到可登录的实际耗时（这才是生产规模的 RTO）、以及 `backup.generated_at` 到故障时刻之间丢失的业务（RPO）。补录丢失业务后才算恢复完成。

## 5. 升级失败后回退

升级前必须有：当天通过校验的备份（第 1 节）+ 回退演练通过（第 3 节）。

1. 升级时 `scripts/migrate.mjs` 或服务启动报错（包括 `MIGRATION_CHECKSUM_MISMATCH`）：**不要**重试、不要手改 `schema_migrations`、不要 `--adopt-checksums`。运行器保证失败的迁移整条回滚，库停在旧版本。
2. 停服，把代码切回升级前的版本。
3. 先试"只换代码不换库"：旧代码 + 当前库跑 `migrate.mjs --status`，`待执行 0 个` 且校验和一致就可以直接启动旧版本——因为失败的迁移没有登记，库本来就在旧版本。
4. 若库已被升级成功的前几个迁移改动（`--status` 显示旧代码不认识的已执行迁移），按第 4 节用升级前的备份恢复。这就是回退演练里 `rollback_*` 那几步。
5. 启动、健康检查、登录、对数，记录耗时。把失败迁移的报错原文与 `upgrade-rollback-drill-*.json` 一起交给开发。

## 6. 本手册的边界

- 演练数字来自演练机，生产 RTO 以第 4 节第 6 步的实测为准。
- 三个库各自独立快照，不保证跨库同一业务时刻；跨库一致需要停服窗口内备份。
- 演练探针只有五项计数/余额，不是逐笔比对；它们发现的是"恢复错库 / 旧版本 / 结构半截"这类粗错误。
- 没有备份加密与异地副本；`$DATA/backups` 在同一块盘上时，盘坏即备份坏，需另行复制到异地。
