# ADR-0040 受信代理配置（Z4）

状态：已采纳｜相关：ADR-0005（登录节流来源 IP）、ADR-0023（请求号）、ADR-0036（HSTS / Cookie Secure）

## 背景

ADR-0005 / 0023 / 0036 都写了"Express `trust proxy` 默认关闭；将来接代理要显式配置"，但代码没有任何配置入口：TLS 终结在反向代理的部署里，来源 IP 全是代理 IP、HSTS 与 Cookie `Secure` 永远不生效。三个模块各自依赖 `req.ip` / `req.secure` / `app.get('trust proxy fn')`，信任判据没有单一出处。

## 决策

### 1. 单一开关 `GML_TRUST_PROXY`

| 值 | 含义 |
|---|---|
| 未设 / 空 / `off`（默认） | 不信任任何对端 |
| `loopback` | 仅 127.0.0.0/8 与 ::1 |
| 逗号分隔 CIDR | IPv4 / IPv6 CIDR；裸地址视为单主机；最多 64 项 |

其它值启动即失败：`server/index.js` 在装配 Express 前调用 `assertTrustProxyConfig()`，抛 `TRUST_PROXY_INVALID`（`code` 字段；消息含 `GML_TRUST_PROXY`）。拒绝：`true` / `1` / `2`（跳数）/ `*`、`loopback` 与 CIDR 混写、空项、前缀越界或非数字、**前缀 0（0.0.0.0/0、::/0 即全网）**、含 `%zone` 的地址、前缀 <96 的 IPv4-mapped 写法（含义含混）、超过 64 项。故意不兼容 Express 的 `true`（信任全部）与跳数写法：它们让"谁是代理"取决于网络拓扑之外的假设。

### 2. 唯一判据 `server/lib/trust-proxy.js`

- `parseTrustProxy(value)` → `{ mode, rules, fn }`；`trustProxyFn(ip)` 读当前 `GML_TRUST_PROXY`（按原值缓存）；`isTrustedPeer(req)` 读 `req.app.get('trust proxy fn')(socket.remoteAddress)`——只看 TCP 对端，不看任何请求头；`isSecureRequest(req)` = `req.secure`。
- `app.set('trust proxy', trustProxyFn)`（server/index.js）。Express 由此派生 `req.ip`（从 `X-Forwarded-For` 右向左走，遇到第一个不受信地址即为客户端）、`req.protocol` / `req.secure`（仅受信对端的 `X-Forwarded-Proto` 生效）。
- 地址规范化后再匹配：IPv4-mapped IPv6（点分与十六进制形态）折成 IPv4，故 `10.0.0.0/8` 命中双栈 socket 的 `::ffff:10.1.2.3`；含 `%`、非 IP、>64 字符、非字符串 ⇒ 不受信（XFF 链里的垃圾项不会被当成可信跳）。
- 匹配用自写位运算（4/16 字节），不依赖 `BlockList` 对 mapped 地址的行为。

### 3. 消费者（不再有各自的信任逻辑）

| 消费者 | 做法 |
|---|---|
| 登录节流 / 审计 / MCP 日志的来源 IP | 路由传 `req.ip`（Express 按统一函数派生）；节流对非法 IP 仍 400 拒绝（ADR-0005 不变） |
| 请求号（logger） | `isTrustedPeer(req)` 且格式合法才采纳入站 `x-request-id` |
| HSTS（security-headers） | `isSecureRequest(req)` |
| 会话 Cookie `Secure`（session-transport） | `GML_COOKIE_SECURE=always` **或** `isSecureRequest(req)`；always 只强制 Cookie，不触发 HSTS |

## 部署契约

1. 受信代理必须**覆盖**（不是追加或透传）`X-Forwarded-Proto` 与 `X-Request-Id`，并向 `X-Forwarded-For` 追加真实对端；程序端口只对代理可达。未满足时 XFF 最右侧受信跳之外的内容由代理负责，程序无法替部署兜底。
2. `GML_TRUST_PROXY` 填的是代理**连接到程序时的来源地址**，不是公网地址。docker compose 默认网桥下是网桥网段，不是 loopback。
3. 反向代理后未配置本项：所有用户共享代理 IP（来源 IP 限额整体触发）、无 HSTS、Cookie 非 Secure（除非 always）。

## 测试（tests/trust-proxy.test.mjs）

解析器（off / loopback / v4 / v6 / mapped / 裸地址 / 空白）；不受信输入（zone、垃圾、非字符串）；非法值矩阵；off 下伪造 XFF / XFP / X-Request-Id 无效、无 HSTS、Cookie 非 Secure；loopback 与 CIDR 命中时全部生效；CIDR 不覆盖对端时等同 off；XFF 链从右向左；`GML_COOKIE_SECURE=always`；节流键仅在受信对端时取 XFF 客户端 IP；非法值启动失败。

## 已知限制

- 受信代理链内某一跳若原样透传客户端的 XFF 而不追加，则其左侧内容可能成为 `req.ip`——这是代理配置错误，文档已要求覆盖/追加。
- 配置变更需重启（`trustProxyFn` 虽读环境变量，但 Express 在启动时只绑定函数）。
- 未对真实 nginx/caddy 拓扑做实机验证。
