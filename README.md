# OS ERP — lightweight ERP development

**MIT-licensed development project; not production-ready.** See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). This public repository starts with a reviewed source snapshot; prior Git history and retired distribution artifacts are not imported.

Derived from `osborn-studio/gml` at `a80b007494b20e8dc801d063f285e87145cbe15e` as a verified current-tree snapshot (not a Git history mirror). Original implementation and documentation remain below for traceability. Current work follows [handoff.md](handoff.md), [plan](docs/implementation/plan.md), and [progress](docs/implementation/progress.md).

Goal: single-enterprise deployment with dependable purchasing, inventory, sales, basic receivables/payables, backup and recovery. Audit findings remain open until verified. Demo instructions below are historical and must not be used against real data.

当前开发步骤和测试命令见 [开发与验证](docs/implementation/development.md)，运行模式决定见 [ADR-0001](docs/implementation/ADR-0001-runtime-isolation.md)。下方保留的是上游历史说明；旧安装器并未获得 OS ERP 生产验收。

---

# 伴圆AI原生ERP系统

> **以下为上游保留的演示说明，仅适用于演示模式（`GML_RUNTIME_MODE=demo`）。** OS ERP 缺省运行模式是 production：空库、不生成样本数据、没有演示账号，首个管理员须按[安装手册](docs/本地交付/01_安装手册.md)第五章用 `scripts/bootstrap-admin.mjs` 创建。下文的样本数据、`admin / 12345` 等演示口令、固定验证码、商城与 MCP 演示**不得用于生产或真实数据**。

面向企业 AI 场景验证的开放业务底座：ERP 承载业务数据和规则，智能体通过 MCP 查询和调用业务能力。包含总部后台、门店 POS、线上商城和经销商订货。当前演示范围为美妆连锁及连锁餐饮，服装不在此次交付验收范围。

**本系统用于演示和方案验证，不是未经改造即可公网商用的生产系统。** 数据为虚构样例；真实支付、短信、银行、IM、外部模型和企业连接器需要另外配置及联调。

## 本地安装包

接收完整发行 ZIP 后，先安装 **Node.js 22.x LTS（至少 22.2，含 npm）**，完整解压，再执行：

- macOS：双击 `install.command` 安装，再双击 `start.command` 启动。
- Windows：双击 `install-windows.bat`，再双击 `start-windows.bat`。
- Linux：在解压目录运行下列命令。

```bash
node scripts/local-manage.mjs setup
node scripts/local-manage.mjs start
```

生产模式下需先创建管理员（见上方说明），再启动；健康检查成功后自动打开 <http://127.0.0.1:3001/login>。停止时在运行窗口按 Ctrl+C。

首次安装需联网下载运行依赖，后续基础业务可离线运行。包中不捆绑 Node、node_modules、实际密钥或原机数据库。演示模式下首次启动生成本副本的样本库（生产模式缺省只建空库结构、不造数据）；已有数据不会在普通重启时重建。默认仅监听本机，端口占用会报错退出，不会关闭已有服务。

本次安装实测平台为 macOS Apple Silicon；Windows、Linux 提供脚本，尚未完成对应实机验收。具体安装、备份恢复及问题处理见安装手册。

## 从GitHub源码启动

源码仓库不提交 dist 或 node_modules，克隆后使用 Node.js 22.x（至少 22.2；ZIP 校验使用该版本起提供的 `zlib.crc32`）执行：

```bash
npm ci --include=dev --registry=https://registry.npmjs.org
npm run docs:build
npm run build
node scripts/local-manage.mjs setup
node scripts/local-manage.mjs start
```

需要热更新开发时使用 `npm run dev`；先停止同端口运行的本地安装服务。不要在正在使用的数据目录运行重建及回归脚本。

## 手册

| 手册 | 可编辑源文档 | 运行后的网页 |
|---|---|---|
| 安装手册 | [安装手册](docs/本地交付/01_安装手册.md) | `/docs/install.html` |
| 操作手册 | [操作手册](docs/本地交付/02_操作手册.md) | `/docs/manual.html` |
| 演示手册 | [演示手册](docs/本地交付/03_演示手册.md) | `/docs/demo-flow.html` |
| 开发与MCP | [开发与MCP接手](docs/本地交付/04_开发与MCP接手.md) | `/docs/dev.html` |
| 依赖安全说明 | [依赖安全说明](docs/本地交付/06_依赖安全说明.md) | `/docs/security.html` |

发行包还包含 `手册` 文件夹，可以不启动系统直接双击 HTML 阅读。历史文档保留在 docs 中；安装及当前演示口径以本表中的手册为准。

## 演示账号和入口（仅 demo 模式）

以下账号只存在于演示模式的样本库，生产库里没有；登录时先选行业。密码以 `server/db/seed.js` 的新样本为准；已有库若改过密码，以已有库为准。

| 账号 | 初始密码 | 用途 |
|---|---|---|
| admin | 12345（演示口令，勿用于生产） | 总部及系统管理 |
| boss | 123456 | 经营查询及授权审批 |
| scm | 123456 | 采购、库存、生产、质量、委外 |
| purchase / sales / warehouse | 123456 | 对应采购、销售、仓储岗位 |
| finance | 123456 | 应收、会计及报表 |
| store01 | 123456 | 本店 POS、库存、要货 |
| dealer01 | 123456 | 美妆版本人订货及对账 |
| viewer | 123456 | 授权范围只读 |

后台 `/login`，门店 `/pos`，消费者商城 `/mall`。商城使用演示手机号及固定验证码 `1234`，不能用于真实短信登录。餐饮演示不使用经销商角色。跨角色演示使用独立浏览器会话，避免令牌互相覆盖。

## 业务范围

- 主数据：商品及 SKU、品牌品类、组合装、往来单位、仓库门店和价格。
- 采购：请购、订单、部分收货、质量、发票、结算、付款和退货。
- 销售及往来：报价、订单、部分发货、开票、应收、收款核销、退货和退款。
- 库存：现存及可用、批次效期、流水、调拨在途、盘点、成本和货权。
- 计划生产及委外：净需求、BOM、领料、报工、完工入库和委外流程。
- 零售及渠道：门店收银、交班核款、缴款日结、要货收货、线上商城及 OMS、经销商协议价和返利对账。
- 会计及治理：业务凭证、试算及报表、用户角色、审批、参数变更与审计。

客户特定规则、复杂排产、规模并发、税控开票、真实银行与平台对接不因演示有页面就视为已交付。跨自然年度结转不在当前完成范围。

## MCP和AI

端点 `/mcp` 使用 JSON-RPC HTTP POST 和独立 Agent Token；不是用户登录 JWT。工具包含发现单据类型、查询、读详情、受控推进以及领域操作，具体数量和输入模式以实时 `tools/list` 为准。

安全控制包括行业及实体范围、工具白黑名单、限频及吊销、参数校验、写操作幂等、高危人工确认和调用审计。通用单据推进会拒绝高危边；支持确认的领域工具绑定原令牌和参数，不能自批或换参执行。MCP handler 复用业务判据，不允许模型直接改数据库。

管理员从 `/system/mcp` 签发只读令牌后，在本机设置 `GML_AGENT_TOKEN`，可运行：

```bash
node scripts/mcp-readonly-demo.mjs
```

脚本只发现工具和单据类型，不写业务数据。它是接口示例，不代表大模型自主执行。默认未预装国外模型 Key；目标 MCP 客户端的协议及传输兼容性须实际联调。

## 源码和技术

Node.js 22、Express 4、better-sqlite3、React 18、Vite 6、React Router 7、TypeScript 和 Tailwind。完整前后端、迁移和样本初始化、测试及可复用模块一并交付。

| 目录 | 内容 |
|---|---|
| src | 页面、路由和公共组件 |
| server/routes | REST 接口及权限检查 |
| server/lib | 库存、状态机、结算及会计等领域服务 |
| server/db | 分行业库、迁移、启动和种子数据 |
| server/mcp | 工具模式、参数、凭据、执行和审计 |
| scripts | 安装维护、代码检查、回归及发行 |
| public | 静态页面和生成的网页手册 |
| reusable | 可复用模块 |

## 维护和验证

```bash
node scripts/local-manage.mjs doctor
node scripts/local-manage.mjs backup
npx tsc --noEmit
npm run build
```

备份建议先停机，保存 SQLite 一致性副本和本机配置；备份含数据及密钥，应保密。完整回归在独立副本执行：

```bash
node scripts/regress-isolated.mjs --rounds=3 --industries=cosmetic,food --output=./test-evidence
```

安装包独立验收入口（仅对尚未安装、无 data、无 .local、无 node_modules 的新解压副本运行）：

```bash
node scripts/test-local-delivery.mjs --package=/absolute/path/to/fresh-package --evidence=/absolute/path/to/evidence
```

测试会在指定副本安装依赖、生成样本、创建测试用户、验证 MCP、备份恢复及重启。不要指向真实业务环境。

## 打包发行

```bash
npm run release
```

输出 `release/BanyuanERP-Local-日期-编号.zip`、对应解压目录和 `.zip.sha256`。发行工具只构建和复制源码，不读取、重建或导出当前工作库，不删除旧发行包。逐文件校验使用包内 `node scripts/verify-release.mjs`。

直接部署服务或 Docker 时必须显式设置强随机 `GML_JWT_SECRET` 并核验监听和端口发布范围。Docker 路径未在本次环境实机验收；不能绕过密钥闸门。正式公网使用前须另做 HTTPS、账号治理、真实连接器、数据政策、容量及恢复演练。

本仓库交付不自动授予开源或再分发许可；第三方依赖按各自许可证使用。

## 依赖安全状态

1.0.1升级了Vite、React Router、fflate及CSS解析依赖，覆盖原12条公告中有补丁的11条。剩余braces高危公告暂无官方修复，仍由Tailwind 3开发构建链引入，不应将本版本称为“安全告警清零”。开发服务仅监听本机，发行运行采用预构建前端及省略开发依赖安装。详见[依赖安全说明](docs/本地交付/06_依赖安全说明.md)。
