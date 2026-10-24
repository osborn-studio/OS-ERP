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

## 1.1 备份加密与密钥管理（ADR-0022）

备份含密码哈希、通知渠道密文、令牌哈希等秘密材料。设置 `GML_BACKUP_KEY`（至少 32 字节的随机串，例如 `openssl rand -base64 48`）后，`db-backup.mjs` 输出 `*.db.enc`（AES-256-GCM），报告记录 `encrypted: true` 与**密文**的 sha256；未设置则行为不变（明文 `.db`）。设置了但短于 32 字节会直接退出码 2，不会静默写明文。

```sh
GML_BACKUP_KEY="$(cat /secure/backup.key)" GML_RUNTIME_MODE=production GML_DATA_DIR=$DATA GML_DB= node scripts/db-backup.mjs
```

要点：

- **密钥必须与备份分开保管**（密码管理器 / 离线介质 / 另一台机器），放在备份同一块盘上等于没加密。**丢失密钥 = 加密备份永久不可恢复**，没有后门。
- **明文窗口（诚实说明）**：`VACUUM INTO` 必须写出一个文件，所以有密钥时快照先落到备份目录里的 0600 临时文件 `.<库>_<stamp>.plain.tmp`，校验、加密完成后立刻用零覆盖并删除。窗口为"快照到加密完成"（秒级，大库更长，报告里有 `encryption.ms`）。在 SSD / 写时复制文件系统上覆盖不保证物理擦除；进程被强杀时临时文件会遗留——发现 `.plain.tmp` 请手工 `shred`/删除。需要更强保证时把备份目录放在加密卷上。
- **演练与恢复**：`db-restore-drill.mjs` 在环境变量 `GML_BACKUP_KEY` 存在时透明解密 `.db.enc`；密钥缺失或错误 ⇒ 退出码 1（`DRILL_BACKUP_KEY_REQUIRED` / `DRILL_BACKUP_DECRYPT_FAILED`），目标目录里不留库文件或 `.partial`。真实恢复（第 4 节）前先用同一密钥跑一次演练。
- **跨库一致点**：三个库在同一个短暂写冻结窗口内（各持 `BEGIN IMMEDIATE`）依次快照，报告里的 `consistency_stamp`（id、冻结/释放时刻、毫秒数）三库共享。这是"近似一致点"，不是跨库事务；拿不到锁（5 秒超时）则整次失败、不产出文件。
- **轮换**：旧备份用旧密钥加密，不会被新密钥解开。步骤：① 用新密钥生成一份新备份并跑演练通过；② 保留旧密钥直到旧备份按 `backup_keep` 被裁剪完或已确认不再需要；③ 之后销毁旧密钥。需要立即换掉旧备份时：用旧密钥演练解密验证 → 用新密钥重新备份 → 安全删除旧 `.db.enc`。
- 怀疑密钥泄露：视同明文备份泄露，轮换备份密钥的同时按 ADR-0008 轮换 `GML_SECRET_KEY`、重置账号密码与令牌。


### 备份失败告警与健康检查（ADR-0029）

- 想在备份失败时收到消息：先在通知管理里建好并启用一个渠道（出站策略同 ADR-0008，私网/回环地址会被拒绝），然后给备份任务设 `GML_ALERT_CHANNEL=<渠道 code>`。只有**失败**才发，内容仅含数据目录名、行业码、`BACKUP_*` 错误码；成功静默。发没发出去看备份命令的 stderr：`ALERT_SENT` 或 `ALERT_NOT_SENT: <原因>`，渠道侧的记录在 `notify_logs`（`triggered_by=db-backup`）。告警自身失败不影响备份退出码。
- 备份**没跑**不会告警。用 admin 令牌看 `GET /api/meta/health` 的 `ops.last_backup`（`result / encrypted / age_seconds`），或 `GET /api/meta/metrics` 的 `backup_age_seconds`、`backup_missing`、`backup_last_failed`，由外部监控判断"超过 N 小时没有成功备份"。同一处还能看 `migration_checksums.mismatched`（非 0 先按第 5 节处理，不要收养）、`login_throttle`（`unavailable` 时登录会 503）、`disk_free_bytes`（备份目录同卷时尤其要盯）。匿名调用只返回 `status` 与版本，探活不受影响。

### 备份被打断后的状态：报告缺失 / 清理中断（AG6）

备份命令被杀（kill -9 / 断电）或在写报告、清理时报错后，先看备份目录，再决定。**备份文件本身（`.db` / `.db.enc` + `.audit-manifest.*`）与报告是分开持久化的：报告只是诊断记录，缺了它不影响恢复。** 所有状态的详细对应见 `audit-integrity.md` §5b。

**A. 报告缺失，但备份完整**（命令在写报告时被打断，或最近一次运行的报告没有出现）

1. 确认备份完整：新 `gml_<库>_<stamp>.db`（或 `.db.enc`）旁边有 `.audit-manifest.json`（加密模式还有 `.audit-manifest.enc`）。没有清单的备份“可用但缺链清单”，按 §5b 的孤儿备份处理（确认后可删，或重新备份）。
2. 目录里若有 `.backup-report-<stamp>.json.<随机串>.tmp`（点文件）：它是本次本该落地的报告，内容完整且已 fsync，只是没来得及改名。可以 `jq . <文件>` 查看；**不要手工改名成报告**（核对 sha256 时以备份文件为准，见第 4 节第 3 步，必要时重新备份）。下一次正常运行会自动清扫它。
3. 对没有报告的备份，用文件本身核验：`shasum -a 256 <备份文件>`，并按第 2 节的恢复演练（`scripts/db-restore-drill.mjs`）实际打开它；加密备份先用当前密钥解密。
4. 正常再跑一次 `node scripts/db-backup.mjs`：自动清扫遗留 `.tmp`、写出新报告、按 keep 规则裁剪。退出码 0 才算收尾。

**B. 清理被打断**（报告里的 `report_phase` 是 `pre-prune`，或条目 `prune_state` 是 `planned` / `failed` / `skipped`）

1. 报告是清理前持久化的：条目的 `pruned` 列出这次要删（可能已删）的旧备份文件名，`pruned_orphans` 列出孤儿清单。`prune_state=planned` 且 `report_phase=pre-prune` 说明删除阶段被打断，终版报告没写；`failed` 附带 `prune_error=BACKUP_PRUNE_FAILED…`；`skipped` 说明 pre-prune 报告没写成，所以**没有删任何文件**。
2. 新备份（条目 `status=ok` 的 `file`）和它的清单不受影响，可直接用于恢复。`pruned` 里的名字可能还在（断电后目录项没落盘的删除会“复活”，无害）或已不在；两种都不需要手工处理。
3. 若发现“备份已不在、`.audit-manifest.*` 还在”的孤儿清单：这是删除在“删备份”与“删清单”之间被打断。**如果那份清单你已离机保存，保留你的离机副本**；盘上的孤儿清单下一次运行会被清扫（条目 `pruned_orphans` 记名）。
4. 重新运行 `node scripts/db-backup.mjs`（同样的 `--keep`）：按 keep 规则继续裁剪、清扫孤儿清单，写出 `report_phase=final` 且 `prune_state=done` 的报告。再跑一次应是空操作（`prune_state=none`）。

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
