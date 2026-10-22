# 伴圆AI原生ERP 开发与MCP接手

本手册帮助接收方 IT 定位完整源码、重建前端、验证接口及接入智能体。它不是生产部署安全认证，也不授予未约定的源码再分发许可。依赖遵循各自许可证。

## 一 架构和源码入口

| 层次 | 入口 | 职责 |
|---|---|---|
| 前端 | src/App.tsx、src/pages、src/components | 路由、业务界面、公共组件 |
| 服务入口 | server/index.js | Express 中间件、行业上下文、业务路由、MCP、静态前端 |
| 业务API | server/routes | 接收 REST 请求，检查身份、权限及范围 |
| 领域服务 | server/lib | 状态流转、库存、结算、凭证等业务判据 |
| 数据库 | server/db | SQLite 结构、迁移、独立行业库及虚构数据 |
| MCP | server/mcp | JSON-RPC、Agent Token、工具定义、参数检查和审计 |
| 回归 | scripts/test-*.mjs、scripts/accept | 功能、权限、异常及反例验证 |
| 发行 | scripts/package-release.mjs | 构建、筛选文件、生成启动器和校验清单 |

前后端源码和测试均随包，不只包含 dist。未包含 Git 历史、原机依赖和原机数据库。MANIFEST 记录基线提交及包含本地未提交修复这一事实，不应把基线提交误当完整交付版本。

## 二 开发环境重建

在独立开发副本中使用 Node.js 22.x，执行：

```bash
npm ci --include=dev --registry=https://registry.npmjs.org
npm run docs:build
npx tsc --noEmit
npm run build
```

开发启动用 npm run dev，或分别运行 dev:api、dev:web；API 端口和 Vite 代理见 scripts/dev.mjs 与 vite.config.ts。不要在本地安装工具正在占用的端口再起第二份服务。

安装工具 start 会校验原始发行清单，手工改源码后校验不通过属于预期。开发者使用开发启动命令，修改完成后重新打包产生新清单，不以删除校验错误代替测试。

## 三 数据与密钥

SQLite 分行业存储，行业码为 cosmetic、food、apparel；业务范围只验收前两者。服务启动会初始化结构、迁移及空库样本。直接运行 server/index.js 时默认数据位置由 server/db/index.js 决定，自定义通过 GML_DATA_DIR；GML_DB 为旧的单库覆盖变量，不要误继承。

本地工具将数据固定到本副本 data，密钥固定到本副本 .local/config.json，强制 HOST=127.0.0.1 和 NODE_ENV=production。直接部署服务需显式配置强随机 GML_JWT_SECRET，不能用内置演示值。不要把本地 .local 或备份目录打进下一份发行包。

## 四 身份和接口

网页登录调用 /api/auth/login，取得面向后台的 JWT，后续 REST 使用 Authorization: Bearer 加 JWT。用户角色及实体绑定从数据库检查，不能只依赖前端菜单。行业与令牌绑定，门店和经销商须有有效实体范围。

AI 使用单独 Agent Token，通常以 gml_ 开头，由管理员在 /system/mcp 或 /api/mcp/tokens 创建。新令牌只返回一次明文，数据库存摘要；可设置行业、scope、工具白名单、限频及过期，再吊销。首先签发只读最小权限令牌，避免给所有智能体全权。

## 五 MCP调用示例

默认地址 http://127.0.0.1:3001/mcp，请求使用 HTTP POST、Content-Type: application/json、Authorization: Bearer 加 Agent Token，消息为 JSON-RPC 2.0。当前实现是项目自定义无状态 HTTP 传输；并非所有 MCP 客户端都能零配置接入，标准协议及传输兼容性须用目标客户端联调，不能仅凭名称宣称全面兼容。

随包工具不需要第三方智能体即可验证端点和只读调用。先在页面创建只读令牌，再在终端设置环境变量，不要把令牌写入源码或录屏字幕。

```bash
# macOS / Linux
export GML_AGENT_TOKEN='在本机粘贴一次性令牌'
node scripts/mcp-readonly-demo.mjs
unset GML_AGENT_TOKEN
```

```powershell
# Windows PowerShell
$env:GML_AGENT_TOKEN='在本机粘贴一次性令牌'
node scripts/mcp-readonly-demo.mjs
Remove-Item Env:GML_AGENT_TOKEN
```

换端口可设置 GML_MCP_URL。脚本执行 tools/list 和 doc.list_types，不发起写操作；输出不回显令牌。

以下是工具发现消息体，无需预设工具数量：

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

以下是单据类型发现消息体，具体字段和工具名以 tools/list 返回为准：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"doc.list_types","arguments":{}}}
```

接入完整智能体时，先 initialize，按服务返回处理后续方法，读取工具模式并逐项验证。模型调用服务、工具参数组织、授权、确认交互、超时和重试由客户端实现，不在本包中预装外部模型 Key。

## 六 写入及人工确认

read 工具按令牌范围查询；write 工具要求幂等键，同键同参复用结果，同键异参拒绝。danger 领域工具需先生成待确认单，由具备权限且非申请人的用户确认，再由原令牌按绑定参数执行。确认与幂等控制不能代替领域服务的余额、数量及状态检查。

通用 doc.transition 对被标记为高危的流转边直接拒绝，不能假设有 confirm_token 就能推进所有边。参数应为对象，数值须有限、布尔须为真正布尔值，未知字段及非法实体范围按当前模式拒绝。

权限、工具黑白名单和实体范围也要约束 resources/read，不能把资源接口当成绕过工具授权的另一条通道。调用结果可能在 result.isError 中表达业务错误，不能只检查 HTTP 200。

## 七 测试和修改纪律

业务状态、金额数量判据应复用 server/lib，不在 MCP handler 和页面另写平行规则。修改实体范围要覆盖列表、详情、汇总、写入、资源以及旧令牌场景；管理员路径通过不等于门店和经销商路径通过。

先安装开发依赖，再在 macOS/Linux 独立回归副本执行：

```bash
node scripts/regress-isolated.mjs --rounds=3 --industries=cosmetic,food --output=./test-evidence
```

该入口复制源码并生成新样本，运行数据不指向原演示库。输出日志可能包含测试样本及临时接入信息，按内部测试材料管理，不混入对外安装包。Windows 回归执行方式未实机验证。

上一轮2026年10月21日业务审查曾完成连续三轮全量回归，每轮111项；本地发行工具新增后仍须单独完成解压安装、首次建库、登录、静态前端、MCP、备份和二次启动检查，不能仅引用旧业务测试替代安装验收。

## 八 重新打包和交付

```bash
npm run release
```

打包工具构建手册及前端，将完整源码、锁文件、可复用模块、测试、启动器和手册生成到 release 下的全新目录及 ZIP。不会重建或读取当前业务数据库，也不会删除旧发行包。需要指定位置可传 --output=绝对路径。

第三方首次安装需联网，程序不捆绑 Node 运行时和跨平台原生依赖；若客户要求断网首装，需另按具体操作系统和 CPU 构建离线依赖及运行时发行版并验收，不能把本包称为通用离线安装器。

生产部署、TLS、访问入口、短信支付、模型供应商、数据政策及真实 ERP/IM 连接器需另行配置验证。SQLite 并发、可用性、运维及规模适配应做专项测试，不因本地演示通过就默认满足客户生产要求。
