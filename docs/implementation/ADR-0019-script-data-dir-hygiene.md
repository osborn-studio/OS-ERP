# ADR-0019：脚本数据目录卫生与单实例安装验收

日期：2026-10-23。承接 ADR-0001（显式绝对 `GML_DATA_DIR`，禁止隐式仓库 `data/`）与审阅发现 F11（一个企业 = 一个实例 = 一份数据目录 / 密钥 / 备份）。范围：`server/db/index.js` 的新助手、六个脚本的路径解析、静态守卫 `scripts/check-data-paths.mjs`、`scripts/local-manage.mjs` 的实例目录参数、两份测试。**不包含**把历史 `test-*.mjs` 的样本源迁到 `dbPathFor()`（已登记为例外，见下）。

## 问题

ADR-0001 的判据写在 `server/db/index.js`（`DATA_DIR = GML_DATA_DIR || <repo>/data`、`requireDataDirectory()`）。但一个脚本只要自己拼 `'data/gml_cosmetic.db'` 或 `path.join(ROOT, 'data', …)` 就把判据整个绕开，而且**不报错**：`scripts/check-mcp-coverage.mjs` 文件头写着"不设 `GML_DATA_DIR` 时读仓库 `data/`"，代码实际上**永远**读仓库 `data/`，`regress-all` 在隔离目录跑时它判的仍是另一份库。审计 `scripts/*.mjs` 与 `server/db/*.js` 发现同类旁路六处（见下表）；`server/db/*.js` 无旁路。

同时，本地安装器 `local-manage.mjs` 把实例目录钉死为代码副本根目录，没有任何自动化证据表明"两个企业各一份数据目录 / 密钥 / 备份、互不串账号"。

## 决定

1. **唯一判据加一个出口**：`server/db/index.js` 新增 `requireExplicitDataDir(env)`：复用 ADR-0001 的 `requireDataDirectory()`（缺失 / 非绝对 ⇒ `DATA_DIRECTORY_REQUIRED`），再按物理路径（realpath）拒绝等于仓库 `data/` 的目录（`DATA_DIRECTORY_IS_REPOSITORY`）。这与 `scripts/regress-all.mjs` 的闸门同一口径。脚本通过后只用 `dbPathFor(industry)` 取库文件，不自己拼文件名。
2. **六处旁路改走助手**，退出码 2、不开库：

   | 文件 | 原命中 | 判定 | 动作 |
   |---|---|---|---|
   | `scripts/check-mcp-coverage.mjs` | `path.join(ROOT,'data',\`gml_${INDUSTRY}.db\`)` | 旁路（文件头与代码不符） | `requireExplicitDataDir()` + `dbPathFor(assertIndustry(argv[2]) \|\| 'cosmetic')` |
   | `scripts/db-inventory.mjs` | `readdirSync('data')` / `'data/'+f`（相对 cwd） | 旁路 | 读 `requireExplicitDataDir()` 返回的目录 |
   | `scripts/inspect-org.mjs` | `'data/gml_cosmetic.db'` | 旁路 | 助手 + `dbPathFor()`；新增可选行业参数，默认 cosmetic |
   | `scripts/inspect-doc-kernel.mjs` | `argv[2] \|\| path.join(ROOT,'data','gml_cosmetic.db')` | 旁路（兜底段） | 显式路径参数照旧；无参数时助手 + `dbPathFor('cosmetic')` |
   | `scripts/verify-reseed.mjs` | `GML_DATA_DIR \|\| path.join(ROOT,'data')` | 旁路（漏设 env ⇒ 重建开发库两遍） | 启动即 `requireExplicitDataDir()`，指纹用 `dbPathFor()` |
   | `scripts/check-inv-txn-dict.mjs` | 导入 `DATA_DIR` 常量，等于仓库 `data/` 时只告警 | 部分旁路（告警不阻止） | 改为拒绝（退出码 2），库文件用 `dbPathFor()` |
   | `scripts/local-manage.mjs` | `path.join(ROOT,'data')` | 有意：安装副本 / 实例目录就是数据根，子进程显式收到 `GML_DATA_DIR` | 改为 `path.join(INSTANCE,'data')`（缺省 `INSTANCE = ROOT`，见 4）；不再是守卫的字面形态，因此不在例外表 |
   | `scripts/regress-all.mjs`、`regress-isolated.mjs`、`inject-mfg-guards.mjs`、`accept/selfcheck.mjs`、`test-flows.mjs`、`test-guards.mjs` 及 18 个带"等于仓库 data/ 就拒绝"闸门的 `test-*.mjs` | `path.join(ROOT,'data')` | 有意：闸门需要知道仓库 `data/` 在哪才能拒绝它；`regress-isolated` 的 `<副本>/data` 是显式传给 `reseed-all` 的 `GML_DATA_DIR` | 登记例外 |
   | 17 个历史 `test-*.mjs` / `verify-purchase-*.mjs`（`REPO_DATA = path.join(ROOT,'data')` 复制样本到自己的隔离目录）、`accept/*reversal*.mjs`、`smoke-report-deepening.mjs`、`test-local-delivery.mjs` | `path.join(ROOT,'data')`、`path.join(REPO_DATA, …)` | 有意但属欠账：只读样本源；只在 `regress-isolated` 的临时副本里跑，那里 `<ROOT>/data` 正是按显式 `GML_DATA_DIR` 灌出的样本 | 登记例外并写明"后续批次迁到 `dbPathFor()`"；守卫钉住"不许再多一个" |
   | `server/db/*.js` | 无 | 正确 | — |
   | `scripts/lib/drill-common.mjs` `INDUSTRY_DB` | 文件名表（无 `data/`） | 有意：文件头说明不能导入 `db/index.js` | 不在守卫判据内 |

3. **静态守卫** `scripts/check-data-paths.mjs`：扫描 `server/ scripts/ tests/`（去掉注释行），五种形态任一命中即红——`'data/gml_*.db'` 字面量、`'data', 'gml_…'` 相邻段、`'data/' +` 拼接、`readdirSync('data')`、`path.join(ROOT|ROOT_DIR|repo|root|__dirname…, 'data')`。`server/db/index.js` 是唯一定义点不扫；其余命中必须在 `ALLOW` 里带理由登记；登记了却已无命中、或文件已不存在 ⇒ 也红。注册进 `regress-all`（`check:data-paths`，与 `check:bizcode` 同列）与 `npm run check:data-paths`。`tests/data-path-guard.test.mjs` 在临时副本上注入三种形态证明会红、注释不算、过期登记会红、真仓库为绿。
4. **单实例安装**：`local-manage.mjs` 新增 `GML_LOCAL_INSTANCE=/absolute/dir`（或 `--instance=`，优先）。实例目录承载 `data/`、`.local/config.json`（端口 + 48 字节签名密钥，0600）与 `backups/`；相对路径拒绝；缺省仍是代码副本根目录，原行为不变。`doctor` 多报 `instance` / `backupDirectory`。`dist/`、`node_modules` 仍按代码根找。`tests/local-instance.test.mjs` 在一份临时代码副本（`server/ scripts/ package.json` + `node_modules` 软链 + 占位 `dist/index.html`）上开两个实例：各自 `setup`（密钥 0600、两份不同、不建库、代码副本不落状态）→ `bootstrap-admin` 各建一个管理员 → 两个服务同时在不同回环端口上就绪 → A 的账号在 B 登录 401（反之亦然）→ 三库均为 `production` 分类、只有 bootstrap 的那一个用户、`products/sales_orders/purchase_orders/agent_tokens` 为 0 → `doctor` 健康 → `backup` 落在各自 `backups/` 且含三库 + `config.json` → 调用方环境里故意放的 `GML_DATA_DIR/GML_DB/GML_JWT_SECRET` 未被继承。

## 契约变化

- 新增导出 `requireExplicitDataDir()`、新错误码 `DATA_DIRECTORY_IS_REPOSITORY`。
- 六个脚本在缺显式 `GML_DATA_DIR` 或指向仓库 `data/` 时退出码 2（以前：读仓库 `data/`）。`inspect-org.mjs` 新增可选行业参数；`inspect-doc-kernel.mjs` 的显式路径参数照旧。
- `local-manage.mjs` 新增 `GML_LOCAL_INSTANCE` / `--instance=`；启动横幅不再写"首次启动生成样本数据"（生产缺省下并不成立）。
- `check-file-header.mjs` DECLARED 新增五项；`regress-all` 新增 `check:data-paths`。

## 验证

`npm run test:focused`（含两份新测试）、`node scripts/check-data-paths.mjs`、`node scripts/check-file-header.mjs`、`node scripts/check-env-pinning.mjs`。Mac mini Node 22 本地验证，不等于目标平台验收；`regress-all` / `regress-isolated` 本批未跑。

## 明确未做

- 历史 `test-*.mjs` 仍以 `<ROOT>/data` 为只读样本源（已登记例外，守卫只阻止新增）。
- 守卫是逐行正则 + 简单注释剥离：跨行拼接（先 `const D = path.join(ROOT, 'data')` 再 `path.join(D, 'gml_x.db')`）只靠形态⑤的定义点命中；用变量名以外的方式（如 `[ROOT, 'data'].join('/')`）可绕过。它钉住的是"已知形态不许再多"，不是语义证明。
- 单实例测试只证明目录 / 密钥 / 备份 / 账号四个维度互不串；未覆盖同一实例目录被两个进程同时 `start`（端口占用会拒绝第二个，由 `freePort` 守）、也未覆盖 Windows 权限位。
