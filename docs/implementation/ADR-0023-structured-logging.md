# ADR-0023 结构化日志与请求号贯通

状态：已采纳（W7）｜相关：ADR-0010（审计与错误卫生）、ADR-0005（登录节流的可信代理策略）

## 背景

F13 引入 5xx 事件号 `incident_id`，但日志仍是 `console` 文本：没有请求号、没有级别，脱敏只靠各调用点自觉。运维拿到响应里的事件号，无法把同一请求的访问记录、审计失败、错误栈串起来。

## 决策

1. `server/lib/logger.js` 是服务端日志的唯一出口，每事件一行 JSON：`{ts, level, msg, req_id, user_id, industry, route, status, duration_ms, incident_id, ...}`。所有字段（含嵌套）统一过 `lib/redact.js`；`ts/level/msg` 保留字不可被字段覆盖；`Error` 序列化为 `{name, code, message, stack}` 后同样脱敏。
2. `GML_LOG_FORMAT=json|text`：生产默认 json；demo/test 默认 text（`[level] msg k=v`，错误栈作为第二个参数，既有按字符串匹配的测试与人读习惯不变）。非法值回落默认，不抛。`GML_LOG_LEVEL=debug|info|warn|error`，默认 info。
3. `requestLogger` 最先挂载：
   - 请求号：入站 `x-request-id` **仅当** Express `trust proxy` 已显式信任该连接对端（与登录节流同一策略，默认关闭）且格式为 `[A-Za-z0-9._-]{8,64}` 时采纳，否则生成 UUID；始终回写响应头。格式限制同时防日志注入。
   - 请求号进入 `AsyncLocalStorage`，`audit()`、MCP 审计失败等深层调用点无需传参即带 `req_id`。
   - 每请求结束记一行 `request` 访问日志（info）；`/api/meta/health` 降为 debug。`route` 优先取路由模板，否则取去掉查询串的路径，查询串永不入日志。
4. `errorHandler` 5xx 经 `logger.error` 记录，含 `incident_id`（与响应体相同）和 `req_id`（与响应头相同）；访问日志行也带同一 `incident_id`。状态码判定仍走 `statusOf`，非 5xx 不记 error（`check-bizcode-shape` 的动态断言继续守着）。
5. `audit.js` 与 `mcp/server.js` 仅替换 `console.*` 日志调用点，不改行为；日志字段名用 `err_message` 而非 `message` 以避免与保留字混淆。

## 后果与限制

- 响应行为不变，仅多一个 `x-request-id` 响应头。
- 生产 stderr/stdout 变为 JSON 行；依赖旧文本格式 grep 的运维脚本需改用 `GML_LOG_FORMAT=text` 或解析 JSON。
- 未接入的 `console.*`（启动横幅、脚本、其他模块）保持原样，后续按需迁移。
- 多代理链下 `trust proxy` 的跳数/地址范围必须由部署方显式配置；本 ADR 不改变默认。
- 未命中任何路由的请求，访问日志 `route` 记 `[unmatched]`，不记原始路径（路径段可能含手机号 / 邮箱 / 凭据，`redact` 只认 `key=value`）。Codex 审计指出，已修。
- 可信代理的请求号：`trust proxy` 只证明连接对端是自家代理，不证明它覆盖了 `x-request-id`。部署契约：受信代理必须覆盖（而非透传）该头；否则客户端可自选请求号，只影响日志关联，不影响鉴权 / 节流 / 审计归属。此项为配置前提，代码默认不信任。
- 5xx `error` 行的 `route` 沿用 `redactUrl(originalUrl)`（既有行为，未收紧）；如需消除路径段 PII，后续改为路由模板。
- `msg` 应为固定短句，变量放字段；`msg` 也会过 `redactText`，但不应依赖它。
