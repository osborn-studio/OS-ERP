# ADR-0036 安全响应头与后台会话传输（Y11）

状态：已采纳｜相关：ADR-0004（账号会话 / 前端会话）、ADR-0005（可信代理）、ADR-0010（F13，backlog F06 附注）、ADR-0023（trust proxy 策略）

## 背景

backlog F06 附注留了一个开口：后台 JWT 存在 `localStorage`，同源任意脚本执行（XSS）即可读走并在别处使用 12 小时。同时服务端此前不发任何安全头（无 CSP、无 nosniff、无反点击劫持、无 HSTS）。本 ADR 一次处理两件事：给所有响应加固定的头；提供**可选**的 HttpOnly Cookie 会话传输，默认仍是 Bearer。

## 决策

### 1. 安全响应头（`server/middleware/security-headers.js`，无新依赖，紧随 `requestLogger`）

| 头 | 值 | 模式 |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | 全部（含 CSP off） |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 全部 |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()` | 全部 |
| `X-Frame-Options` | `DENY`（CSP 另有 `frame-ancestors 'none'`） | 全部 |
| `Strict-Transport-Security` | `max-age=15552000; includeSubDomains`（无 preload） | 仅 `req.secure` |
| `Content-Security-Policy` | 见下 | `GML_CSP_MODE=enforce` |
| `Content-Security-Policy-Report-Only` | 同一策略 | `GML_CSP_MODE=report` |

`GML_CSP_MODE=report|enforce|off`：生产（缺省的运行模式）默认 **enforce**，demo/test 默认 **report**；非法值回落到该运行模式的默认值（不会因拼错而静默关闭）。

CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`。

- 构建产物 `dist/index.html` 没有内联脚本 / 样式 / 事件属性（Vite 默认只发外链模块与样式表），脚本策略不含 `unsafe-inline`、`unsafe-eval`。`tests/security-headers.test.mjs` 起真实服务、在 enforce 下加载 SPA 首页、所有 `/assets/*` 与深链回退，并断言首页无内联脚本。
- `public/*.html`（文档站、入口页、`_dev_login.html`）有内联 `<script>`：中间件按内容对这类文件的每个内联脚本算 sha256，只加进**该文件**响应的 `script-src`（按 mtime 缓存，改文件哈希自动更新）。测试逐个核对所有 `public/**/*.html`，并断言其无内联事件属性与 eval。
- `style-src` 保留 `'unsafe-inline'`：图表库与 React 会写内联样式，样式注入的危害远低于脚本注入；这是有意的残余，不是遗漏。
- 未提供 `report-uri`：report 模式的违规只出现在浏览器控制台。新增上报端点要走路由授权清单与 OpenAPI 契约，另批。

**HSTS 信任判据**与 ADR-0005/0023 同一：只看 Express 的 `req.secure`，即直连 TLS，或 `trust proxy` 已显式信任连接对端且其 `X-Forwarded-Proto: https`。客户端自己写的 `X-Forwarded-Proto` 不算数（有测试）。代码目前没有暴露配置 `trust proxy` 的环境开关（ADR-0023 同样如此）；在 TLS 终结于反向代理的部署里，要么由代理自己发 HSTS，要么另批加 trust-proxy 配置。

### 2. 会话传输（`server/middleware/session-transport.js`）

`GML_SESSION_TRANSPORT=bearer|cookie`，缺省与任何其他值 = `bearer`。

**bearer（默认）**：行为与此前完全一致——登录响应体返回 `token`，前端存 `localStorage`，请求带 `Authorization: Bearer`；服务端**从不读取 Cookie**（即便客户端带了合法 JWT 的 `gml_session` 也是 401，有测试）。

**cookie** 契约：

1. 登录 `POST /api/auth/login` 成功：响应体**不含** `token`，改含 `transport: 'cookie'`；下发
   - `gml_session=<JWT>`：`HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`，https（`req.secure`）或 `GML_COOKIE_SECURE=always` 时加 `Secure`；
   - `gml_csrf=<HMAC-SHA256(JWT_SECRET, 'os-erp-csrf:v1:' + JWT)>`：同属性但**非 HttpOnly**，供前端读取。
2. `requireAuth`：先看 `Authorization: Bearer`；**没有 Authorization 头**时才用 `gml_session`。Authorization 头出现（即使无效）就不回落到 Cookie。
3. Cookie 来的会话遇到非 `GET/HEAD/OPTIONS` 请求，必须同时满足 `x-csrf-token` 头 == `gml_csrf` Cookie == 由该 JWT 重新计算的 HMAC（常数时间比较），否则 `403 CSRF_TOKEN_INVALID`，不进业务处理器。CSRF 值绑定到会话 JWT，所以兄弟子域写入同名 Cookie（cookie tossing）无法制造可用的值。
4. Bearer 头请求不要求 CSRF（不是环境凭据）；MCP/脚本/运维调用不受影响。
5. 清除：`/auth/logout-all`、`/auth/change-password` 成功后清两只 Cookie（`Max-Age=0`）；Cookie 内 JWT 验签失败 / 被撤销（401）时同样清除——HttpOnly 的那只前端无法自己清。
6. 行业上下文中间件（`server/index.js`）在无 Authorization / `x-mall-token` 时也从会话 Cookie 解析行业，使“行业钉死在令牌”在 cookie 模式下仍成立。`/api/meta/health` 的可选鉴权同样识别会话 Cookie。
7. 前端 `src/api/client.ts`：登录响应 `transport === 'cookie'` 时 `localStorage` 只存**非机密标记** `__os_erp_cookie_session__`（让多标签同步、401 处理、会话代次逻辑原样工作），**不存 JWT**；请求不发 `Authorization`，非安全方法从 `document.cookie` 读 `gml_csrf` 写入 `x-csrf-token`；商城（`x-mall-token`）通道不变。`credentials: 'same-origin'` 本已设置。

### 切换条件（cookie 作为默认之前必须满足）

- 部署为同站（前后端同源，当前即是）且全程 https；`GML_COOKIE_SECURE=always` 或已配置 trust proxy 使 `req.secure` 为真；
- CSP 在 report 模式下观察过真实流量无违规，再切 enforce；
- 所有需要非浏览器调用的集成继续走 Bearer（MCP 令牌、脚本）；
- 浏览器端验收（真实浏览器里登录 / 刷新 / 多标签 / 登出）已在目标环境做过。本批只有 Node 级测试，**没有**浏览器验收。

## 残余风险（诚实边界）

- **XSS 仍然危险**：cookie 模式下脚本读不到 JWT，但同源脚本仍能以受害者身份直接发请求——它能读 `gml_csrf` 并带上 `x-csrf-token`，所以 CSRF 双提交**不防 XSS**，GET 读取更是不需要任何额外凭据。cookie 模式缩小的是“令牌被带走、在别处长期重放”的窗口，不是消除 XSS。真正的防线是 CSP（脚本源收紧）与不引入注入点。
- 登录 CSRF（攻击者把受害者登录到攻击者账号）：登录接口没有会话可绑定，`SameSite=Lax` 也不阻止顶层跨站表单 POST。cookie 模式下登录因此额外拒绝跨站浏览器请求（`Sec-Fetch-Site` 不是 `same-origin`/`none` ⇒ `403 CROSS_SITE_LOGIN_REJECTED`；缺该头的旧浏览器比较 `Origin` 与 `Host`）。无这两个头的脚本/curl 放行——它们不是被诱导的浏览器。这是独立审计（Codex）提出的 P2，已修。
- `style-src 'unsafe-inline'`、无 `report-uri`、无 `__Host-` 前缀（需要 Secure，而 demo 为 http）。
- HSTS 无 preload；`includeSubDomains` 要求整个注册域下的子域都能走 https。
- CORS 仍是 `cors()` 默认（`*`、不带凭据）：浏览器不会让跨域页面带 Cookie 读响应，这与 cookie 模式相容，但本 ADR 没有收紧它。
- `public/_dev_login.html` 在 cookie 模式下写不到 token（响应不含），它只是本地演示工具；生产镜像不应依赖它。

## 后果

- 响应多 5 个头（HTTPS 时多 HSTS）；bearer 模式的请求/响应体不变。
- 新增环境变量：`GML_CSP_MODE`、`GML_SESSION_TRANSPORT`、`GML_COOKIE_SECURE`（仅 `always` 有意义）。
- `requireAuth` 抽出 `sessionToken(req)`；`bearerToken` 保持仅读 Bearer。
