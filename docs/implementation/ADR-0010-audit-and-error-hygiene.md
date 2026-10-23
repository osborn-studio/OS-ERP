# ADR-0010：审计与错误卫生（F13）

日期：2026-10-22。范围：审阅报告 F13（P1）—— 审计可失败后静默继续、凭据可进 URL/日志、错误响应泄露内部信息。不包含 `server/mcp/*` 的审计路径（另一条线接入本文的共享助手）、`notify.js`、日志访问权限/保存期限等运营验收。

## 决定

### 1. 后台凭据只从受控头取

`requireAuth` 与 `server/index.js` 的行业上下文中间件都不再接受 `?token=`：后台 JWT 只能来自 `Authorization: Bearer`。`middleware/auth.js` 新增 `bearerToken(req)` 作为唯一取值点。

前端（`src/api/client.ts` 与各页面）从未拼 `?token=`，无导出/下载链接依赖 URL 凭据，所以没有兼容期也没有前端改动；`npx tsc --noEmit` 通过。将来若出现浏览器直接导航的文件下载，必须另做短期一次性下载票据端点，不得把会话 JWT 放回 URL。C 端 `x-mall-token` 头不受影响。

### 2. 脱敏只有一处：`server/lib/redact.js`

- `redactValue(obj)`：递归返回新对象；键名命中 `/password|secret|token|authorization|cookie|jwt|key/i` 的非空值整体换成 `[REDACTED]`；`phone|mobile|tel` 类键部分遮盖（前 3 后 4）；字符串值走 `redactText`；循环引用/过深用标记代替，保证能序列化。
- `redactText` / `redactUrl`：字符串里 `token=xxx`、`api_key=xxx` 这类"敏感键=值"的值剥掉，键名判据与上面同一个正则。
- `key` 故意偏宽（会命中 `keyword`、配置项的 `key`）：宁可多遮一个无害字段。需要保留此类名字的审计调用点改用别的字段名（本批次的配置审计用 `setting`）。

MCP 审计（`server/mcp/server.js` 保存部分 args）由 MCP 线接入 `redactValue`；本批不改该目录。

### 3. 错误响应与日志

`lib/http.js` `bizFail(res, err, incidentId)` 仍是唯一失败形状构造点，形状契约 `code/success/message/error/detail` 不变，`scripts/check-bizcode-shape.mjs` 的动态断言照旧通过。新增判据：

- **业务码 = 有 `code` 且自带 HTTP 状态**（与 `failFromError` 的门同源）。只有 `code` 没有状态的是运行时错误（better-sqlite3 `SQLITE_ERROR`、Node `ENOENT`/`ERR_*`），原来会被当业务码回给客户端（`error:'SQLITE_ERROR'` + 表名文案），现在按无业务码 5xx 处理。
- **无业务码的 5xx**：响应体带 16 位 hex `incident_id`；`GML_RUNTIME_MODE=production` 时 `message` 换成通用文案 + 事件号、不回 `detail`；demo/test 保留 `message` 与脱敏后的 `detail`。事件号由 `errorHandler` 生成并先打 `[error] <id> <method> <redactUrl(originalUrl)> <err>`；别的入口直接调 `bizFail` 时它自己生成并打日志，保证响应里的事件号在日志里一定找得到。
- **带业务码的 5xx**（`FEATURE_DISABLED`、`SECURITY_AUDIT_UNAVAILABLE`…）是各 lib 刻意给出的文案，形状不变，只对 `detail` 脱敏。4xx 的 `detail` 是校验反馈（字段名/可选值），原样回。
- 日志里的 URL 一律经 `redactUrl`；完整错误对象仍写服务端日志。

### 4. 审计落库唯一点：`server/lib/audit-trail.js`

- `insertAuditRow(db,row)`：`audit_logs` 唯一 INSERT；明细在这里序列化并经 `redactValue` 脱敏（请求体里的密码/令牌/手机号不再原样落库）。
- `auditStrictRow(db,row)`：必须在事务内（否则抛 `AUDIT_OUTSIDE_TX` 500，编码错误）；写入抛错或 0 行（含 `RAISE(IGNORE)`）即抛 503 `SECURITY_AUDIT_UNAVAILABLE`，由外层事务回滚业务写入。不做"去掉明细重试"。
- `middleware/audit.js`：`audit(req,payload)` 保持"不抛、失败打日志、去掉明细重试一次"的口径，改为调用 `insertAuditRow`；新增 `auditStrict(req,payload)`，载荷形状与 `audit` 相同。
- `lib/account-security.js` 的严格安全审计改为委托 `auditStrictRow`，错误码与 503 语义不变（`tests/auth-session.test.mjs` A07 仍覆盖）。

### 5. 切换到严格审计的站点

写入已经在 `db.transaction` 内，审计与写入同事务，审计失败整笔回滚：

| 路由 | 动作 | 说明 |
| --- | --- | --- |
| `PUT /api/meta/settings` | `SETTING_SET` | 外层事务包住 `writeSetting` 自身事务（savepoint）；`changed:false` 不留痕 |
| `POST /api/meta/settings/reset` | `SETTING_RESET` | 同上 |
| `POST /api/dealers/:id/credit` | `DEALER_CREDIT_UPDATE` | 原来裸 UPDATE 无事务，现包进事务；明细记 before/patch |
| `PUT /api/dealers/rebates/:id` | `UPDATE dealer_rebates` | 原 `audit` 在事务外，移入事务并改严格；明细记状态前后与点位 |
| `POST/PUT /api/auth/users*`、`change-password`、`logout-all`、`PUT /api/auth/roles/:code/permissions` | 既有 | `account-security.js` 已严格，现走共享落库点 |

其它 `audit()` 调用点（主数据、单据等）保持宽松口径：留痕失败不阻断业务。扩大严格集合是后续批次的事。

## 契约变化

- `?token=` 对后台接口一律 401（原来 200）。
- 无业务码的 5xx 响应多出 `incident_id`；生产环境 `message` 不再是 `err.message`，`detail` 不回。
- 运行时错误（有 `code` 无状态）的 5xx 不再带 `error`/`detail.code`，顶层 `code` 为 HTTP 状态。
- 上述四个路由在审计表不可写时返回 503 `SECURITY_AUDIT_UNAVAILABLE` 且不改数据；`PUT /api/dealers/rebates/:id` 的审计 `detail` 由字符串改为对象。
- 审计 `detail` 里的凭据键值为 `[REDACTED]`，手机号为 `138****5678`。

无迁移。

## 验证入口

`node --test tests/audit-error-hygiene.test.mjs`：H01 URL 令牌 401 / 头令牌 200；H02 脱敏助手；H03 进程内 `bizFail`/`errorHandler` 三种模式与四类错误；H04 隔离生产服务真实 5xx（表改名）响应与 stderr 事件号对应；H05 内存库落库脱敏、事务外拒绝、ABORT/IGNORE 触发器均 503；H06 隔离生产服务 + 触发器注入：四个站点 503 且配置、`setting_audit_log`、经销商、返利单、`doc_events` 均未变化，撤掉触发器后写入成功且明细脱敏。

只在新临时数据目录与随机 loopback 端口运行；合成凭据不输出。Node/macOS 结果仅为开发证据。

已知的既有守卫红项（本批之前即存在，未改）：`scripts/check-bizcode-shape.mjs` 判 `server/middleware/auth.js`（`SESSION_REVOKED` 的 `fail()` 第 5 参）与 `server/routes/auth.js:28` 为形内业务码构造点；`scripts/check-file-header.mjs` 覆盖率因 `src/components/SessionBoundary.tsx` 缺标识块为 99.8%。
