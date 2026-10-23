# ADR-0008：通知子系统加固（摘要数据范围、出站 Webhook 策略、渠道密钥静态保护）

日期：2026-10-22。关联审阅报告 F05 / F08 / F09（`docs/audit/GML_商用可行性源码审阅报告_2026-10-21.md`）。状态：开发实现，尚非产品上线验收。

## 决定

### F05 摘要接口要求全局数据范围（403，而不是"按范围缩小的摘要"）

`GET /api/notify/preview`、`POST /api/notify/push`、`GET /api/notify/logs`、`GET /api/notify/overview` 统一挂 `requireAuth → requireInternal → requirePerm(system:notify:view|manage|push) → requireGlobalData`；`push` 另需 `system:notify:push`。判据复用 `server/middleware/auth.js` 已有中间件（与 dashboard / accounting 同一组），不新增权限模型。

选择 403 而非"按组织切片"的原因：摘要来自 `purchaseTodos` 与 `approvalTodoItems`，其中 `purchase_orders` 与 `approval_instances` 没有组织列，无法可靠按组织/仓库过滤；假装过滤会产出"看起来受限、实际仍是全库"的摘要。门店、经销商、以及只有 `subtree`/`org`/`self` 范围的岗位一律 403（`GLOBAL_DATA_FORBIDDEN` 或角色 403）；管理员与显式 `data_scope='all'` 的内部账号可用。`/api/notify/meta` 与渠道维护接口不受此门影响（它们不含业务摘要）。

行为变化：内置 `purchase` 角色默认 `subtree` 范围，升级后不能再预览/推送全库摘要，需管理员将该账号 `data_scope` 设为 `all`。这是本决定的直接后果，不是回归。

### F08 出站策略只有一处：`server/lib/outbound-url.js`

保存渠道（`upsertChannel`）与发送（`pushToChannel`）都经过同一模块：

- 生产只允许 `https`，demo/test 运行时允许 `http`；放宽仅由 `GML_RUNTIME_MODE` 决定，无 `ENABLE_*` 开关。
- 拒绝 URL 用户信息；拒绝 `localhost` 及 `*.localhost`；拒绝 IPv4/IPv6 回环、私网、链路本地、CGNAT、测试网、组播、未指定、保留段，以及 IPv4 映射/兼容/NAT64/6to4 内嵌地址（内嵌 IPv4 再判一次）。WHATWG URL 解析把 `0x7f.1`、`2130706433`、`0` 等形式归一化为点分 IPv4，因此一并被拦。
- 发送时先 DNS 解析（`dns.lookup all`），**每一个**答案都要过地址检查，再把检查过的地址钉进 socket `lookup`，连接阶段不再做第二次解析；每次请求新建 Agent，不复用连接。这是对 DNS 重绑定的缓解方式（解析一次、钉住、不重查）。
- 不跟随重定向：3xx 一律失败（`OUTBOUND_REDIRECT`），目标不会被二次请求。
- 一个总超时覆盖解析、连接、响应头与响应体（默认 8s）；响应体上限 256KB（`OUTBOUND_BODY_TOO_LARGE`）。
- 可选 `GML_WEBHOOK_ALLOWED_HOSTS`（逗号分隔主机名）只进一步收窄；名单里写 `127.0.0.1`/`localhost` 不会放开私网。未设置名单不等于放开私网。
- demo/test 允许回环与 `http`：自动化测试用 127.0.0.1 上的受控监听器验证正向发送路径；同一监听器在生产模式必须被策略拒绝且不建立连接（测试断言监听器零命中）。

保存时做同步校验（协议/主机/名单/字面 IP）；DNS 解析与钉住在发送时执行。库里已存在的地址（策略收紧前保存或绕过 API 写入）在发送时同样被拦并留 `fail` 日志，错误文本以 `OUTBOUND_*` 码开头。

### F09 渠道密钥不出服务端、静态封存、支持轮换

- 响应形态：所有渠道响应经过 `publicChannel`，**没有 `secret` 字段**，只有 `has_secret`、`secret_last4`（密钥 ≥ 12 字符才露末 4 位），封存值解不开时 `secret_unreadable: true`。
- 写入语义：`secret` 未传/`null` = 保持；`''` = 清除；非空 = 设置/轮换。前端编辑框不再回显，留空即保持，提供"清除密钥"勾选。
- 静态保护：`server/lib/secret-box.js` 用 AES-256-GCM，格式 `enc:v1:<iv>.<tag>.<ct>`（base64url）。密钥来源 `GML_SECRET_KEY`（≥16 字符）优先，否则由 JWT 密钥（`jwtSecretPosture` 唯一出处）经 HKDF-SHA256 派生。无前缀的旧明文行照常可读，下一次写入该行时自动封存（含 `toggle`）。不需要新迁移：仍用 `notify_channels.secret` TEXT 列，故未新增 051。
- 轮换：`GML_SECRET_KEY_PREVIOUS`（逗号分隔）只用于解；新写入一律用当前密钥。步骤：旧值挪入 PREVIOUS → 设新 `GML_SECRET_KEY` → 重启 → 让每个渠道保存一次（或等待自然写入）→ 确认无旧密钥才能解的行后清掉 PREVIOUS。更换 JWT 密钥而未设置 `GML_SECRET_KEY` 时，旧封存值会变为不可读（响应 `secret_unreadable`，发送失败并留痕），需要重新录入或配置 PREVIOUS。
- 发送签名：钉钉（query `timestamp`+`sign`）、飞书（body `timestamp`+`sign`）、通用 webhook（`X-GML-Timestamp` / `X-GML-Signature: sha256=…`，对 `${timestamp}.${body}` 做 HMAC）；企业微信无签名方案。日志只记录实际发出的消息体，不含密钥。
- 启动日志打印 Agent Token 的部分此前已修复：`server/db/boot.js` 仅打印名称与权限（"凭据不写日志"），`server/mcp/tokens.js` 无日志输出；本 ADR 不重做。

## 约束与边界

- `purchase_orders`、`approval_instances` 无组织列是 F05 选 403 的根因；要做到"受限账号收到自己范围的摘要"需先补齐单据组织归属，另行决定。
- `/api/purchase/chain/todos`、`/api/approval/todos` 仍只 `requireAuth`，与本 ADR 同属"全局待办对受限账号可见"问题，不在本批范围，需单独处理。
- 出站策略在应用层；不替代网络出口策略（egress 防火墙）。IPv6 地址检查覆盖常见嵌入形式，Teredo（2001::/32）已在 W4 阻断（见「TLS 联调」）。
- demo/test 允许回环与 http 是测试与本地演示的放宽，不是商用口径；生产模式判据不受任何环境开关影响。
- 密钥封存的强度取决于 `GML_SECRET_KEY` 或 JWT 密钥的保密性；生产 JWT 密钥缺失/公开值时服务不会启动（ADR-0004 / A20），demo/test 下回退到公开演示密钥派生，仅为形式保护。

## 负向验收（`tests/notify-hardening.test.mjs`，`node --test`，Node 22，隔离临时库、loopback 随机端口、无外部网络）

- F08 单元：回环/私网/链路本地/组播/未指定/映射/NAT64/6to4 地址全部阻断；生产拒绝 http、ftp、用户信息、`localhost`、`127.0.0.1`、`[::1]`、`10.x`、`169.254.169.254`、`[::ffff:127.0.0.1]`、`0x7f.1`、`2130706433`；名单外主机拒绝，名单含私网仍拒绝；注入 DNS 答案中任一私网地址即拒绝，公网答案被钉住；受控监听器上 302 → `OUTBOUND_REDIRECT`（目标未被二次请求）、超限响应体 → `OUTBOUND_BODY_TOO_LARGE`、慢响应体 → `OUTBOUND_TIMEOUT`；生产模式对同一监听器零连接。
- F09 单元：封存带前缀且不含明文、随机 IV、旧明文透传、篡改与错误密钥不可读、PREVIOUS 轮换可读、JWT 派生键隔离、短 `GML_SECRET_KEY` 拒绝、掩码只露足够长密钥的末 4 位。
- F05 生产服务：门店/经销商账号对 preview/push/logs/overview 403；`purchase`（subtree）403 `GLOBAL_DATA_FORBIDDEN`，改为 `data_scope=all` 后 200；`sales`（无权限）403；`viewer` 可预览不可推送；未登录 401；管理员正常。
- F09 生产服务：创建/列表/toggle 响应无 `secret`；库中为 `enc:v1:` 且不含明文；省略 `secret` 保持原封存值；`''` 清除；手工写入旧明文后列表显示 `has_secret` 与末 4 位，下一次写入升级为封存并能用服务配置的 JWT 密钥派生键解开。
- F08 生产服务：保存 `http://127.0.0.1`、`https://localhost`、`https://10.0.0.1`、`https://[::1]`、`https://169.254.169.254`、带用户信息地址均 400 且不落库；直接改库指向本机监听器后推送 → `fail`、错误含 `OUTBOUND_*`、监听器零命中、日志 `fail`。
- 正向路径（test 模式服务）：通用/钉钉/飞书渠道向 127.0.0.1 监听器发送成功，签名与密钥逐一校验；重定向渠道失败；日志与库中无明文密钥。

本批在 Mac mini 上以 Node 22 本地开发验证，不等于 Linux 目标服务器或 CI 验收。

## TLS 联调（W4）

- `tests/notify-tls.test.mjs` 在 test 模式下启动本地 HTTPS 监听（仅测试用自签证书与私钥，`tests/fixtures/notify-tls-test-*.pem`，主机名 `hook.example.test`），经注入的 `lookup` 走完整 `outboundRequest`，验证：解析后固定 IP 连接且 SNI 为主机名；证书主机名校验（换名即 `OUTBOUND_NETWORK` 拒绝）；不带测试 CA 时自签被拒；3xx 拒绝；响应体上限；总超时覆盖慢响应体。
- 自签仅能经显式选项 `testTrustedCa` 接受，且仅当 `GML_RUNTIME_MODE=test`；production/demo/缺省模式在解析与连接之前抛 `OUTBOUND_TEST_CA_FORBIDDEN`。该选项不读环境开关，也不关闭主机名校验；生产调用方（通知服务）不传它。
- Teredo（2001::/32）加入 IPv6 阻断分类，邻近公网段（如 2001:4860::）不受影响。
- 在 Mac mini / Node 22 本地验证，不等于 Linux 目标机或 CI 验收。
