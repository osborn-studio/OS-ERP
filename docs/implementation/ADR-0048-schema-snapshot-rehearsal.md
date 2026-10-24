# ADR-0048：旧结构快照备份集与免截断的升级演练（AB5）

状态：开发实现，尚非产品上线验收｜相关：ADR-0009（迁移校验和）、ADR-0016（恢复/回退演练）、AA11（`upgrade-rehearsal.mjs`）、Y10（`synth-data.mjs`）、`docs/implementation/capacity-baseline.md` 的 AB5 一节

## 背景

AA11 的升级演练从 `--from N` 起重放后续迁移，但手头的备份集/合成库都是**最新结构**：它只能删版本表里编号 > N 的行并删掉那些迁移创建的索引。表、列、字典行早就存在，059/061 这类建索引迁移被真实重放，而 060/062 这类"加列 / 写字典行"迁移只是对现成结构的幂等空转（报告的 `structure_preexisting=true`）。耗时因此偏低，不代表真实升级成本。AA11 文档已写明"想演练真正的旧库，要旧版本代码产出的备份集"——但仓库里没有这样的备份集，也没有产生它的办法。

## 决定

### 1. `scripts/schema-snapshot.mjs --upto N --out <dir> [--synth tiny|small|medium]`

在 `--out` 里**用今天的仓库**重建"版本 N 的库"并产出备份集：

1. `_helpers` 与编号 ≤ N 的迁移文件**字节级复制**到暂存目录并逐个核对 sha256（与 `upgrade-rehearsal` 的暂存同一做法）；`N` 必须恰是一个现有迁移编号（有空号：044/051/054/064），这样快照版本表的最高编号就是 N。
2. cosmetic / food / apparel 三库各自：先写 production 分类标记（`classifyEmptyDatabase`，与线上同一函数）→ `schema.sql` → **真实运行器** `runMigrations(…, { migrationsDir: 暂存目录, mode: 'production' })` → `ensureSettings` → 写入合成指纹 `orgs.code='SYNTHCO'`。校验和就是运行器按暂存文件登记的（origin=applied），不手写、不改。随后断言版本表恰为编号 ≤ N 的仓库迁移、每个校验和等于仓库文件的 sha256。
3. `--synth`（可选）：`synth-data.mjs` 在**最新结构**的临时目录生成合成库，再把业务数据**拷进旧结构库**。迁移 >N 会改动内容的表（做法：把旧结构库 `VACUUM INTO` 克隆一份，跑完全部仓库迁移，逐表比较旧列上的行内容；典型是 `permissions` / `role_permissions`）算"迁移所有"，**不拷**，保持 ≤N 的内容——否则 062/063/066 的权限行会提前出现，演练又回到空转。其余表按两边都有的列拷（旧结构缺的列留空、新结构多出的列丢弃），关外键、`INSERT OR REPLACE`，随后逐表核对行数与源相同，`foreign_key_check` 必须为 0，`synth-data` 的 verify-seed 风格不变量必须全绿，否则整次失败并清理。合成数据只进 cosmetic（`synth-data` 只产出 cosmetic）；food / apparel 只带结构与指纹。
4. 三库在一次 `db-backup.mjs`（子进程、生产模式、明文、环境白名单）里备份并校验；随后擦除在用的 `.db`，只留 `--out/data/backups`（备份集）和 `--out/snapshot-manifest.json`（0600）。

### 2. `upgrade-rehearsal.mjs` 免截断

库的版本表最高编号**恰等于** N（`regMax === from`）⇒ 没有可删的登记行，也不删索引（结构本来就是旧的）；报告每库多一个 `baseline_registry: { max, truncation: 'skipped' | 'applied' }`。最高编号 > N（最新结构的库）仍走原来的截断路径，行为不变。**校验和核对不因此减弱**：`PRE_UPGRADE_CHECKSUM_MISMATCH` / `PRE_UPGRADE_REGISTRY_FILE_MISSING` 两个判据在截断之前执行，两条路径都照常经过；`--from` 高于库内真实版本仍是 `REHEARSAL_BASELINE_NOT_APPLIED`。接口沿用现有 `--backup-dir`（路线图里写的 `--backup` 即它）。

### 3. 夜间工作流

`nightly-capacity.yml` 的 `workflow_dispatch` 新增字符串输入 `snapshot_upto`（缺省空 = 关闭，定时任务永不设置），只在 `rehearsal=true` 的演练步骤里生效：值经环境变量传入、用 `case` 匹配 1–3 位数字，不拼进脚本；有值时先 `schema-snapshot.mjs --upto=$snap --synth=<small|medium>`（`large` 用 medium）再 `upgrade-rehearsal.mjs --from=$snap --backup-dir=…`。失败只是 warning，不改 Gate。

## 安全判据

- `--out` 必须是显式绝对路径；不得位于仓库 `data/` 内（`isWithin` 穿过符号链接解析，含悬空链接）；不得等于或位于调用方 `GML_DATA_DIR`；必须不存在或是空目录且自身不是符号链接；违反 ⇒ 退出码 2，**先于任何文件创建**判定。运行期失败（退出码 1）清空本次在 `--out` 里创建的全部内容。
- 子进程环境白名单：不继承 `GML_*`，不带 `GML_BACKUP_KEY`（内容是合成/空库，备份集明文）；备份目录解析后断言落在 `--out` 内；合成库副本 settings 里的 `backup_dir` / `backup_keep` 改回迁移 020 缺省值（与 AA11 同一做法）。
- 不打开仓库 `data/`；快照不含密码（合成管理员密码只在被删除的临时目录里）。

## 诚实边界

- 结构 = **今天的** `schema.sql` + 迁移 ≤ N，不是历史上 N 版本当时的 `schema.sql`；业务数据由今天的领域函数写入后拷入，只含两边都有的列。它回答"这个体量上 >N 的迁移要多久"，不回答"旧版本代码写出的历史数据长什么样"。
- 合成数据不是客户数据；耗时是 Mac mini、当时负载下的单次墙钟，不是 `dmserver` 结果，不是容量承诺，不是验收证据。
- 工作流新输入未在 GitHub 上执行过；本机只验证了 YAML 语法与静态策略测试。

## 测试

`tests/schema-snapshot.test.mjs`：版本表/校验和/旧结构（无 060 的表与列、无 059 的索引、无 060 的权限行）/三库指纹与 production 标记/备份集 sha256/不留在用库；`--synth=tiny` 业务数据在旧结构里且不变量全绿；用快照跑演练免截断且 059–062 `structure_preexisting=false`、升级后与全部迁移一致；备份里被篡改的登记校验和仍被拒绝；十余种拒绝用例（相对路径、非空目录、仓库 `data/` 含符号链接别名、等于/位于调用方 `GML_DATA_DIR`、空号/越界/非数字 `--upto`、未知参数/规模）且不创建任何文件。`tests/upgrade-rehearsal.test.mjs` 断言最新结构库仍走 `truncation='applied'`。`tests/nightly-capacity-policy.test.mjs` 断言新输入的形态。
