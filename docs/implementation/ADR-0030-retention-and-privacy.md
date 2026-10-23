# ADR-0030：日志保留清理与个人信息处理

日期：2026-10-23。范围：`scripts/retention.mjs`、`scripts/privacy-export.mjs`、`scripts/privacy-erase.mjs`、`scripts/lib/privacy-common.mjs`、`server/lib/settings.js`（三个设置键）、`server/lib/secret-box.js`（`keyedPseudonym`）、运维手册第二十四章。

## 问题

1. `audit_logs`、`notify_logs`（含发出的消息体）、`mcp_call_logs`（含调用参数）只增不减，既无限增长，也无限期保留个人信息。
2. 没有响应数据主体访问 / 删除请求的受控方法；人工改库既容易漏表，也不留痕。

## 决定

### 保留清理

- 设置键（`ops` 组，`int`，`is_danger`）：`retention_audit_days` 默认 365（90–3650）、`retention_notify_log_days` 默认 90（7–3650）、`retention_mcp_log_days` 默认 90（7–3650）。缩短窗口 = 更早永久删除，所以按既有判据是危险键，改动必须写理由；`scripts/test-setting-audit.mjs` 钉死的危险键集合由 14 变 17。
- 默认 `--dry-run`（只读打开）；`--execute` 对每个行业库开**一个** `BEGIN IMMEDIATE` 事务：三个 DELETE + 一条 `auditStrictRow` 的 `RETENTION_PURGE`（module=`retention`，detail 含各表删除行数、窗口天数）。审计写不进即整库回滚。跨行业库不是一个事务，各库独立成败。
- 设置值不合法（越界 / 非整数）⇒ 该库拒绝清理、退出码 1。**不用 `readSetting`**：它对库内非法值静默回落默认值，破坏性操作不能悄悄换窗口。
- **审计清理用白名单**：`audit_logs` 只有 `module` ∈ {master, notify} 的行才可能被删。原因：Codex 复核指出黑名单漏掉了 `purchase/pay`、`pos/APPROVE` 等账务证据——业务模块（purchase、sales、pos、dealer、dms、inventory、order-center、oms、requisition、manufacture、outsourcing、marketing …）的写操作审计本身就是账务 / 授权证据，逐个排除必然漏。第二轮复核又指出 quality（报废 / 退供应商确认）、docflow（单据流转）、im（审批同步）同样含账务或审批证据，因此白名单收窄到 master、notify 两个模块。其余如 finance / settings / auth / approval / privacy / retention、所有业务模块、`module` 为空或未知的新模块、`FUNDS_` 开头的动作一律保留；`mcp_call_logs.level='danger'` 保留。后果：`retention_audit_days` 目前只作用于白名单里的低价值模块；要扩大是政策变更（改 `PURGEABLE_AUDIT_MODULES` + 本 ADR + 测试），`master`（主数据维护）是否真的无账务影响需业务确认。`setting_audit_log`、所有业务单据与账务表不在清理范围。
- 范围外：删除后 SQLite 文件不收缩（不自动 VACUUM）；备份文件里的旧日志按备份保留份数过期。

### 个人信息导出 / 抹除

- 本系统没有独立地址簿表，商城（平台 `H5`）的收货信息在 `oms_orders` 上。涉及的数据 = `mall_customers`（phone, name）、`mall_cart_items.phone`、H5 `oms_orders`（buyer_nick, receiver, receiver_phone, receiver_address）、其关联 `sales_orders`（receiver, receiver_phone, receiver_address）、`pos_orders.member_phone`；`member_accounts` / `member_points_ledger` 只导出不改（无个人字段）。
- **导出**：只读；`--out` 必填、绝对路径、不在仓库目录、不覆盖（`wx`）、权限 0600、不向 stdout 打印；键名命中 `SENSITIVE_KEY` 的值遮盖；自由文本里的 `token=x`、JSON 片段 `"token":"x"`、`Authorization: Bearer x`、`api_key: x` 也遮盖（整串是 JSON 时按结构处理）。这是启发式，不保证识别所有凭据形态。手机号 / 姓名 / 地址**不遮盖**（答复本人）。
- **抹除**：`--confirm` 与 `--actor <启用的 admin>` 缺一拒绝（退出 2）。把上述列换成 `erased:` + HMAC-SHA256 前 24 hex（手机号再加 `-<mall_customers.id>` 后缀：`phone` 是 UNIQUE，同一号码抹除后再注册、再抹除会撞唯一键，按生命周期区分；哈希部分相同仍可关联）；销售单的两条来路都覆盖（H5 订单转出、POS 日结上传时把 `member_phone` 抄进 `receiver_phone` / `receiver=会员 <手机号>`）；金额、单号、数量、状态、时间、行 id、`customer_id` 一律不动，所以外键与账务不受影响（测试比较前后 `foreign_key_check`）。每个库一个 `BEGIN IMMEDIATE` 事务，**事务内重新取数并复核管理员与在途订单**（先做一遍只读预检以便早停，但以事务内为准，预检之后新增 / 变化的订单不会漏），含一条 `PRIVACY_ERASE` 严格审计（只记行 id / 行数 / 伪名前缀，不含原手机号）。
- **在途订单**（oms: pending/shipped/refunding；sales: draft/confirmed/picking/shipped）⇒ 拒绝，除非 `--allow-open-orders`，因为抹掉收货信息会让订单无法履约。
- **重放**：原号码查不到而 `erased:<哈希>-%` 存在 ⇒ `already-erased`、退出 0、不写第二条审计；号码从未出现 ⇒ 退出 1。跨库失败后重跑，已完成的库自动跳过。
- **密钥**：`secret-box.keyedPseudonym(purpose, input)`，由 `GML_SECRET_KEY`（缺省则 JWT 密钥）经 HKDF（info=`pseudonym:<purpose>`，与封存子钥不同）派生。生产模式若密钥缺省 / 公开值则抛 `PSEUDONYM_KEY_UNSAFE`：手机号空间只有约 10^10，公开密钥下的"哈希"可被穷举还原。只用当前密钥；更换密钥后旧伪名不可复算，重放判定会失效（审计行仍是证据）。

## 边界（如实）

- 不改历史备份文件；不改 `audit_logs` 里已被 `redact.js` 部分遮盖（前 3 后 4）的手机号；不改其它域的姓名快照（如 `refunds.customer_name`、`oc_*`），这些是否与商城客户同一自然人，需业务确认，本批未验证。
- 相同姓名 / 地址得到相同伪名（便于对账，也意味着可关联）；不做不可关联的随机化。
- 未在真实生产量级库上跑过；`DELETE` 一次事务锁库的时长随日志量增长，首次执行建议在业务低峰、先演练。
- 这不是法律合规结论：保留期限与抹除范围应由业务 / 法务确认后再改设置。
