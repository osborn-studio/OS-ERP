# ADR-0004：后台会话失效与前端请求边界

日期：2026-10-22。范围：后台/POS 会话、改密、退出及客户端请求处理。

## 会话行为

所有 JSON、下载与 rawPost 的 401 共用一条处理路径。后台失效清后台凭据及用户缓存；商城失效只清商城凭据。后台与商城的登录请求不附带旧凭据，登录失败也不清现有会话。后台凭据不再发送到商城接口。

每次建立会话生成独立 generation，与 token 一起在请求发出时捕获。失效响应、改密完成与退出完成只可清除相同 generation/token 的状态；即使两次登录得到相同 token 文本，旧响应也不能删除新登录。generation 不是认证凭据，服务端仍是身份判据。

同标签页用无凭据 payload 的 `os-egp:auth-changed` 通知 AuthProvider；其他标签页读取原生 storage 事件后的最新存储值。AuthProvider 的 `/auth/me` 回填也比较请求快照。网络错误本身不删除已有会话。

`useAuth().logout()` 请求 `POST /auth/logout-all`（10 秒超时），只认 `data.revoked === true`。失败、超时或响应未确认时仍清当前本地会话，显示“未能确认服务端会话撤销”，不自动重试。退出按钮不应无条件导航，依赖 token 清除触发的路由守卫，避免旧操作改变新登录页面。

`useAuth().changePassword(oldPassword,newPassword)` 请求 `POST /auth/change-password`（15 秒超时），只认 `changed:true` 且 `reauthenticate:true`，随后清当前会话并要求新密码登录。密码仅存在表单内存及 HTTPS 请求体，不入本地存储、事件或日志；请求失败不宣称密码未改变，UI 明示状态未确认。新增 ChangePasswordDialog，由 Layout 接线。

POS 改用同一 Auth hook，避免直接读 localStorage 后不响应其他标签的退出。POS 退出也执行账号全部后台会话撤销，不影响独立商城会话。

## 传输与能力事件

客户端只接受 API 相对路径（例如 `/auth/me` 或空字符串代表 `/api`），拒绝外部/绝对 URL、协议相对 URL、反斜杠、fragment 及逃出 `/api` 的路径。设置 `redirect:error`，防止自定义商城凭据随重定向外发；不再支持把 HTTP 客户端当外部请求代理。

业务码兼容 `detail.code`、顶层字符串 `code`、`error`。错误对象保留该码。任何请求方式收到 `FEATURE_DISABLED` 都派发 `os-egp:feature-disabled`，payload 仅包含可选 capability，供运行能力 Provider 刷新。原写操作不会自动重试。rawPost 保留 HTTP 200 的普通协议错误报文，但认证、传输和 FEATURE_DISABLED 错误统一抛出。

## 验证及限制

`tests/frontend-session.test.mjs` 通过 TypeScript 编译后加载实际 client/session 模块，使用 Node 的 fetch/Response 与轻量存储/事件夹具验证传输和会话契约；这不替代 React、真实多标签页或浏览器导航验收。Linux 浏览器集成由主任务按平台指示执行。

`tests/browser/session.mjs` 在 Linux、启用 sandbox 的 Chromium 中挂载实际 AuthProvider 与改密 Dialog，加载实际 client/session 模块，以两个同源标签页验证原生 storage 传播、退出/改密、三种请求的 401 及竞态、业务码、商城隔离、能力事件和 URL/重定向限制。网络响应是确定性拦截夹具，不等于真实后端撤销或完整 Layout 导航验收。脚本仅接受 loopback 源，不启动服务；缺浏览器环境变量即失败。需要 `GML_PLAYWRIGHT_MODULE`、`GML_CHROMIUM_EXECUTABLE`、`GML_TEST_BASE_URL`，可选 `GML_BROWSER_LD_LIBRARY_PATH`（只注入浏览器环境）和 `GML_BROWSER_EVIDENCE`（新建 JSON 文件，已有文件则拒绝覆盖）。Mac mini 仅作 Node 焦点及 TypeScript 检查，未运行此浏览器脚本。

JWT 仍保存在 localStorage，本批没有解决同源 XSS 读取凭据风险；未引入 HttpOnly cookie/refresh token 或单设备撤销。storage 多键写入不是跨标签事务，读取者始终重新读取当前值；极端同时写登录仍属于后续集中会话存储设计范围。不能将前端清缓存等同服务端撤销证据。
