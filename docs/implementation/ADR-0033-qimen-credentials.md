# ADR-0033：奇门网关平台凭据、签名契约与重新开放验收清单

日期：2026-10-23。状态：开发实现，尚非产品上线验收。承接 ADR-0028 第 3 条与其"边界"节（签名密钥是公开演示常量、`/capabilities` 向任何登录账号列出 `app_key`）。生产运行时网关仍由 `qimen_gateway` 能力关闭（ADR-0002，503），本 ADR **不**重新开放它。

## 决定

1. **每平台独立密钥**。迁移 `060_qimen_secrets` 给 `platforms` 加 `app_secret_sealed`（`secret-box.js` 的 `enc:v1:` 封存值）和 `app_secret_rotated_at`，新增 `qimen_nonces`（防重放）和权限点 `oms.platform.manage`（首次迁移仅授予 admin，ADR-0007 口径：`verify()` 不检查角色授权集合）。已有平台的密钥为空 ⇒ 网关 401 `1005`（凭据未签发），不会静默沿用任何默认值。公开演示常量 `GML-DEMO-SECRET` 已从代码、能力清单与调试页删除。
2. **签发 / 轮换接口**：`POST /api/qimen/platforms/:id/secret`，要求登录 + 内部账号 + `oms.platform.manage`。明文 `qsk_` + 32 随机字节十六进制，**只出现在这一次响应里**（`Cache-Control: no-store`），库里只有封存值，同时把 `app_secret_masked` 更新为 `****末4位`。平台已有密钥而请求体没有 `{"rotate": true}` ⇒ 409 `QIMEN_SECRET_EXISTS`（防重复点击作废刚发出的密钥）；平台无 `app_key` ⇒ 409 `QIMEN_APP_KEY_MISSING`；平台不存在 ⇒ 404。轮换后旧密钥立即失效。审计只记 `QIMEN_SECRET_ISSUE` / `QIMEN_SECRET_ROTATE` + app_key，不带密钥、不带末 4 位。该接口位于 `/api/qimen` 下，所以随 `qimen_gateway` 能力一起在生产关闭。
3. **签名契约 v2（破坏性变更）**。请求体 `{ method, app_key, timestamp, nonce, sign, request }`：
   - `timestamp`：UTC 毫秒时间戳（13 位），与服务器时间相差不超过 ±5 分钟，否则 401 `1006`；
   - `nonce`：16–64 位 `[A-Za-z0-9_-]`，不合规 401 `1007`；
   - `sign` = 大写十六进制 `HMAC-SHA256(平台密钥, canonical)`（比较大小写不敏感，`timingSafeEqual`）；
   - `canonical` = 以 `\n` 连接 `app_key`、`method`、`timestamp`、`nonce`、`sha256hex(canonicalJson(request))`；
   - `canonicalJson`：递归按键名升序、无空白、UTF-8（`JSON.stringify` 语义，`undefined` 属性省略）；缺省 `request` 视为 `{}`；嵌套超 32 层按验签失败处理。
   旧 `MD5(app_key + method + secret)` 不再接受。保留的是外形（大写十六进制、`app_key` / `method` / `sign` 字段、鉴权失败 HTTP 401 + 协议码）；新增 `timestamp`、`nonce`，并把 `request` 摘要纳入签名，所以篡改报文体会验签失败。仓库内唯一调用方是后台调试页 `src/pages/oms/Qimen.tsx`（已改为在浏览器内存里用 WebCrypto 计算签名，密钥不保存、不上传），没有其他内部调用方；外部对接方需按本契约重新实现。
4. **防重放**：nonce 在**签名通过之后**才写入 `qimen_nonces`（主键 `platform_id + nonce`）；主键冲突 ⇒ 401 `1008`。所以不持有密钥的人既不能占用 nonce 也不能撑大表，同一个 nonce 在不同平台互不影响。窗口 ±5 分钟意味着一个 nonce 最长可被接受 10 分钟，保留 11 分钟，之后在每次接受时顺带清理。选表而不是进程内滑动窗口：重启不丢、多实例共库也成立。代价：每个合法请求一次写入（带 SQLite 写锁）；表规模 ≈ 每分钟请求数 × 11。
5. **`GET /api/qimen/capabilities`** 要求 `oms.platform.manage`（并仅内部账号）：普通登录账号 403、匿名 401。列表只含 `app_key` 与 `has_secret` / `secret_rotated_at`，永不含密钥或封存值。静态协议元数据随之一起受限（不再是 `meta` 例外，`check-route-authz` 登记已删除）。
6. **其他读写面一并收口**：`GET /api/oms/platforms` 不再返回 `app_secret_sealed`（改为 `has_secret` / `secret_rotated_at`）；通用主数据 `crudRouter` 新增 `protectedFields` 选项，`/api/master/platforms` 用显式列清单读取，并且封存列、轮换时间、掩码列不可经通用接口写入或作过滤条件（否则 `sales` 角色可以直接 PUT 一个明文进去）。网关读取密钥时**要求** `enc:v1:` 前缀，旧明文形态的值一律当作未签发。
7. **日志**：`oms_sync_logs.payload` 不再记录 `sign`；失败日志只记 app_key 与原因；`audit_logs` 里没有密钥（测试对两张表做子串扫描）。

## 契约变化

- `POST /api/qimen`：必填字段增加 `timestamp`、`nonce`；`sign` 算法由 MD5 改为 HMAC-SHA256；新增 401 协议码 `1005`（未签发）、`1006`（时间戳）、`1007`（nonce）、`1008`（重放）。
- `GET /api/qimen/capabilities`：新增 401/403；`platforms[]` 增加 `has_secret`、`secret_rotated_at`。
- 新增 `POST /api/qimen/platforms/:id/secret`。
- `GET /api/oms/platforms`、`/api/master/platforms[/:id]`：不再含 `app_secret_sealed`；增加 `has_secret`、`secret_rotated_at`。
- 新增权限点 `oms.platform.manage`（首次迁移授予 admin）。

## 重新开放（生产）前的验收清单

网关在生产保持 503，直到下列每一项都有证据（命令输出或记录），由产品负责人单独授权后才能改 `server/capabilities.js`：

1. **密钥**：生产设置显式 `GML_SECRET_KEY`（≥16 字符；ADR-0008 轮换流程已演练），确认 `jwtSecretPosture` 非公开值；每个对接平台由管理员签发独立密钥，交付渠道不是聊天/邮件明文（一次性展示后由对方即时保存），台账记录签发人与时间（审计 `QIMEN_SECRET_ISSUE/ROTATE`）。
2. **轮换演练**：对一个测试平台完成"签发 → 联调通过 → 轮换 → 旧密钥 401 → 新密钥 200"，并确认轮换窗口内对方的切换方案（旧密钥立即失效，无宽限期；如需宽限期必须另开 ADR）。
3. **传输**：网关只经 HTTPS 暴露；反向代理对 `/api/qimen` 设 body 大小上限和每源 IP 限速（应用层目前没有对 `/api/qimen` 的限速，nonce 表写入只发生在签名通过后）；时间同步（NTP）已核对，5 分钟窗口与对方时钟偏差留有余量。
4. **范围**：当前网关处理器是模拟承接方（不实际出入库，库存查询按平台绑定仓过滤）。接入真实业务写入前，必须先确定平台→组织/仓库绑定并让每个 method 按该绑定受范围约束（见 Y4 对 OMS 同步入口的组织绑定），并给写入类 method 加幂等键。
5. **日志与备份**：确认 `oms_sync_logs`、审计、应用日志与备份中无密钥（备份含封存值，必须启用 ADR-0022 的备份加密，且备份密钥与 `GML_SECRET_KEY` 分管）。
6. **监控**：对 `1004/1005/1006/1008` 的 401 比例设告警；`qimen_nonces` 行数与最老 `seen_at` 纳入 ops 健康检查（应不超过窗口 + 清理间隔）。
7. **回归**：`tests/qimen-auth.test.mjs`、`tests/authz-misc.test.mjs`、`tests/capabilities.test.mjs`、`node scripts/check-route-authz.mjs` 在 Linux 验证主机（ADR 验证主机决定）上全绿；`tests/browser` 的能力门禁用例通过。
8. **外部对接文档**：向对接方交付本 ADR 第 3 条的契约、含测试向量（canonical 串与期望签名）和错误码表。

## 已知限制

- 无宽限期轮换；无"仅吊销不重发"的单独动作（停用平台即让网关 401）。
- 没有按平台的网关限速；依赖入口代理（清单第 3 项）。
- 未做 IP 白名单。
- 后台调试页需要 WebCrypto（HTTPS 或 localhost）；否则提示不可用。
- 仍是奇门协议的**模拟承接方**，不代表已与任何真实平台完成对接。

## 验证入口

`node --test tests/qimen-auth.test.mjs`：迁移幂等与 verify、签发/轮换权限与一次性明文、封存落库、旧密钥失效、各类篡改/过期/未来/坏 nonce/重放/旧 MD5/演示常量/明文落库/他平台密钥/停用平台 401、失败请求不占 nonce、nonce 清理、`/capabilities` 权限、三处读接口与日志无密钥、通用主数据接口不可写封存列、前端签名器与服务端字节级一致。`tests/authz-misc.test.mjs` 的 qimen 用例已改为新签名。Mac mini Node 22 本地验证，不等于目标平台验收。
