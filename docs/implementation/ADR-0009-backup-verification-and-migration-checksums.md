# ADR-0009：备份先校验后轮转，迁移文件校验和

日期：2026-10-22。对应审阅报告 F12（P1）。范围：`scripts/db-backup.mjs` 的校验/轮转/退出码/报告，`server/db/migrations/runner.js` 的迁移文件校验和。**不包含**完整恢复演练、异地备份、加密与 RPO/RTO 测量。

## 问题

上游 `db-backup.mjs` 在新快照校验之前就裁剪旧副本；`--verify` 是可选的，且 integrity/结构不一致只打印、不影响退出码，依赖退出码的运维脚本会把坏备份当成功。相对 `backup_dir`（迁移 020 写入每个库的 `data/backups`）拼到项目根，违反 ADR-0001 "禁止隐式使用仓库 data/"。迁移运行器只记录迁移 id，已执行的迁移文件被改动（无论是部署被篡改还是未经评审的就地修改）在启动时无法发现；ADR-0007 已指出历史 up 仍可能在结构"脱节"时重跑。

## 决定

### 备份（`scripts/db-backup.mjs`）

1. 每个库 `VACUUM INTO` 生成快照后**总是**校验，`--verify` 仅为兼容保留、无额外作用；没有 `--no-verify`，不提供关闭校验的入口。校验项：`PRAGMA integrity_check` 必须为 `ok`；`PRAGMA foreign_key_check` 必须为空；表/视图数与源库一致；`schema_migrations` 行数与源库一致；只读打开快照后对 `users` 表 `COUNT(*)`。最后一项是**烟雾恢复**——证明快照能独立打开并查询已知表，不是完整恢复演练。
2. 任一项失败：快照改名为 `<文件>.db.failed`（保留证据，但裁剪与恢复都只认 `.db`），**不裁剪**，计入失败，整次退出码 1。快照本身失败（目录不可写等）同样计失败、不裁剪。任一库失败则整次非零，其余库仍各自备份并各自校验。
3. 裁剪只在该库新快照通过之后进行，只删本脚本命名规则生成的 `<库名>_*.db`，新文件永远保留，其余按 mtime 保留 `keep-1` 份；`keep` 来自 `settings.backup_keep` 或 `--keep=N`（必须 ≥1）。
4. 每次运行在备份目录写 `backup-report-<stamp>.json`：运行模式、数据目录、每库 `status`（ok/failed/skipped）、源库表数与迁移数、快照路径/大小/sha256、校验明细与失败原因、裁剪清单。报告不含任何凭据；整次成功时顺带把旧报告裁到 `keep` 份。
5. 必须显式绝对路径 `GML_DATA_DIR`（复用 `server/runtime.js` 的 `requireDataDirectory`），否则退出码 2 且不创建任何目录。`backup_dir` 由新增的 `server/lib/backup-dir.js` 唯一解析：绝对路径原样；相对路径落在 `GML_DATA_DIR` 内；旧缺省值 `data/backups` 等价于新缺省值 `backups`（即 `GML_DATA_DIR/backups`），避免得到 `GML_DATA_DIR/data/backups` 这种误导路径。`db-reset.mjs` 与 `settings.backup_dir` 的说明同步改为这一口径；迁移 020 本身不改（它已是受校验和保护的已执行迁移）。
6. 未知 `--` 参数拒绝执行（退出码 2），防止把 `--no-verify` 之类的误拼当成静默接受。
7. 故障注入 `GML_BACKUP_FAULT=truncate[:行业码]` 仅在 `GML_RUNTIME_MODE=test` 下生效，用于测试"快照写坏"的路径；其他模式下设置它会以 `BACKUP_FAULT_FORBIDDEN` 拒绝运行，而不是静默忽略。

### 迁移校验和（`server/db/migrations/runner.js`）

1. `schema_migrations` 增加 `checksum`（文件内容 sha256）与 `checksum_origin`（`applied` / `healed` / `adopted`）两列，由 `ensureVersionTable` 在启动时幂等 `ALTER TABLE` 补列。这是运行器的启动基础设施而不是编号迁移：编号迁移本身要靠这张表登记，先有鸡后有蛋；且它不改业务结构。
2. 每次 `runMigrations` 先**只读**核对全部已登记迁移的校验和，再执行任何 up()/heal。生产模式发现不一致即抛 `MIGRATION_CHECKSUM_MISMATCH`（带 `mismatched` 列表），库不被改动一字节；demo/test 模式只告警（`warn`，默认 `console.warn`）并在返回值 `mismatched` 中列出。理由：按 ADR-0001 demo/test 数据可丢弃，开发时会就地修改迁移文件并用 reset/reseed 重建，失败关闭会把本地开发循环堵死；生产库的迁移文件应与建库时一致，不一致意味着部署被改或改动未经评审，运行器无法替人判断，所以拒绝启动。
3. 升级前登记的旧行 `checksum` 为 NULL：首次运行按当前文件收养（`adopted`），不失败，只做一次。启动**不**收养"不一致"的行。
4. heal 重跑 up() 后登记被实际执行的文件的校验和（`healed`）。ADR-0007 的不变量保持：正常重检不清空、不重跑已执行版本；其三项测试未改动且仍通过。
5. 显式收养入口：`node scripts/migrate.mjs --adopt-checksums`，把未登记与不一致的行按当前文件重新登记，供评审后使用。`scripts/verify-migrations.mjs` 打印每库 一致/未登记/不一致/文件缺失，任一库不一致退出码 1。
6. `runMigrations(db, { migrationsDir, mode, log, warn })`：`migrationsDir` 与 `mode` 为可选参数，默认分别为本目录与 `GML_RUNTIME_MODE`（缺省 production），供测试在临时副本上篡改文件。`migrationStatus` 的 applied 行附带两列。

## 契约变化

- `db-backup.mjs` 退出码：0 全部通过；1 任一库快照或校验失败；2 参数/环境错误。原先校验失败退出 0 的行为不再存在。
- 新增环境变量：`GML_BACKUP_FAULT`（仅 test）。无新增生产环境变量。
- `settings.backup_dir` 相对路径的基准从项目根改为 `GML_DATA_DIR`；缺省值从 `data/backups` 改为 `backups`，旧值等价。
- `runMigrations` 返回值新增 `adopted`、`mismatched`；新增错误码 `MIGRATION_CHECKSUM_MISMATCH`。**修改已执行的迁移文件会使生产启动失败**：新结构改动必须新开迁移编号（下一个可用编号 054）；经评审的历史文件修订需在每个生产库上执行 `--adopt-checksums`。

## 操作命令

```sh
# 备份三库并校验、裁剪（只在新快照通过后）
GML_RUNTIME_MODE=production GML_DATA_DIR=/absolute/os-egp-data GML_DB= node scripts/db-backup.mjs
GML_RUNTIME_MODE=production GML_DATA_DIR=/absolute/os-egp-data GML_DB= node scripts/db-backup.mjs food --keep=3
# 检查退出码与报告
echo $?; cat /absolute/os-egp-data/backups/backup-report-<stamp>.json

# 迁移状态与校验和核对
GML_RUNTIME_MODE=production GML_DATA_DIR=/absolute/os-egp-data GML_DB= node scripts/migrate.mjs --status
GML_RUNTIME_MODE=production GML_DATA_DIR=/absolute/os-egp-data GML_DB= node scripts/verify-migrations.mjs
# 评审后显式收养改动过的迁移文件（否则生产启动拒绝）
GML_RUNTIME_MODE=production GML_DATA_DIR=/absolute/os-egp-data GML_DB= node scripts/migrate.mjs --adopt-checksums
```

恢复仍是手工动作：停服后把 `<库名>_<stamp>.db` 复制为 `GML_DATA_DIR/gml_<行业>.db`（同时删除旧的 `-wal` / `-shm`），启动前先核对报告里的 sha256，启动时运行器会核对迁移校验和。`*.db.failed` 文件不会自动清理，排查后手工删除。

## 验证

`node --test tests/db-backup.test.mjs tests/migration-checksum.test.mjs`（均纳入 `npm run test:focused`）。备份测试用真实子进程在临时数据目录上跑脚本：成功路径的校验/报告/sha256/裁剪到 keep；注入截断故障后非零退出、不裁剪、坏文件只以 `.failed` 存在；一库失败整次非零而健康库仍得到通过的快照；目录不可写时不裁剪；缺少或相对 `GML_DATA_DIR` 时拒绝且仓库 `data/backups` 不被创建；非 test 模式拒绝故障注入；未知参数拒绝；`--verify` 兼容；绝对/相对 `backup_dir` 解析。校验和测试：新库登记 sha256；旧表结构与 NULL 行被收养一次且不重跑；篡改临时副本中的已执行迁移在 production 抛 `MIGRATION_CHECKSUM_MISMATCH` 且库字节不变，在 demo/test 只告警；显式收养后可再次启动；heal 登记实际执行文件的校验和；缺省模式来自环境且缺省为 production。

## 明确未做

- **未测量 RPO/RTO**；没有在空环境做过从备份文件到可登录服务的完整恢复演练，也没有升级失败后回退到旧备份的实测记录。这些仍是 F12 的开放项，需要在目标 Linux 主机上记录数据笔数与关键余额后才能宣称。
- 三个行业库仍是各自快照，不是同一业务时刻的一致性点；跨库一致需要停服或应用层静默窗口。
- 没有备份加密、异地复制、保留策略之外的生命周期管理。
- 校验和保护的是"迁移文件与登记一致"，不是对拥有数据库写权限者的防线：直接改 `schema_migrations` 不在此防线内（与 ADR-0001 的边界相同）。
- 迁移 020 等历史迁移中的配置副作用、`verify()` 失败时重跑 up() 的旧机制未改（ADR-0007 的开放项）。
