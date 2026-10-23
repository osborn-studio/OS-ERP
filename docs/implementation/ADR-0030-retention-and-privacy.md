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

- 不改历史备份文件。（原先“不改 `audit_logs` 里部分遮盖的手机号、不改 `refunds.customer_name` / `oc_*` 姓名快照”已由下面的「补充（Y8）」取代，剩余边界见该节。）
- 相同姓名 / 地址得到相同伪名（便于对账，也意味着可关联）；不做不可关联的随机化。
- 未在真实生产量级库上跑过；`DELETE` 一次事务锁库的时长随日志量增长，首次执行建议在业务低峰、先演练。
- 这不是法律合规结论：保留期限与抹除范围应由业务 / 法务确认后再改设置。


## 补充（Y8，2026-10-23）：抹除覆盖面扩展与 `--report`

### 判据：什么算“与主体有确定关联”

只有**精确**的手机号、客户 id、订单 id 算关联；姓名只作为二次门槛（见下），不单独成为关联依据。核心集（客户、购物车、H5 订单、销售单、POS 单，以及电话精确等于主体的订货中心客户 / 地址）决定“该号码是否存在 / 是否已抹除”；扩展集只在核心集存在时参与。

- **退款单** `refunds`：`customer_type='member'` 且 `customer_id` = 主体客户 id（姓名一定是主体）；或退款明细 → 退货单 `sales_returns.order_id` 属于主体的销售单（此类退款的 `customer_name` 来自退货单的经销商 / 门店名，是企业名，**只有等于主体名下姓名时才改**）。金额、单号、状态、银行账号、流水号不动。
- **订货中心**：`oc_customers.phone`（或 `oc_addresses.phone`）精确等于主体手机号。客户行：phone / contact / address 换伪名，名称仅当等于主体姓名；地址行同理（仅地址行命中的企业客户，其客户行与订单不连带）。命中客户名下的全部 `oc_addresses`（含备用电话 / 空电话的地址）与命中客户的 `oc_orders` / `oc_statements` / `ar_documents` / `receipts` / `sales_invoices`（`subject_type='oc'`）/ `credit_accounts` 上的名称快照用同一“等于主体姓名”判据。
- **自由文本里的原号码**：只在已关联行的 remark 类列上、且只替换**独立出现**的号码（前后不能紧挨字母 / 数字 / `_` / `-`，所以 `RC-13812345678` 这类单号不动；明细是 JSON 时定点替换、不重新序列化，只改字符串值，不改数字与键，祖先键为单号 / 账号 / 金额 / id 类的整棵子树受保护，键名含 phone / mobile / tel / contact 的显式放行；“这一行是否含该号码”与替换用同一口径，所以只在单号里嵌了号码的行不算关联）做原号码→伪名替换（`oms_orders` / `sales_orders` / `pos_orders` / `refunds` 的 remark、`member_*_ledger.remark`）。
- **审计 / 通知日志**：`audit_logs.detail`、`notify_logs.title/payload/error`。含**原号码**的行，以及 `audit_logs.(entity, entity_id)` 指向主体订单 / 销售单 / POS 单 / 客户 / 会员账户 / 退款单的行，把原号码和部分遮盖片段（`redact.js` 的 前 3 + `****` + 后 4）换成同一个伪名。其余仅凭遮盖串命中的行**不能证明属于主体**（约 10^4 个号码共享一个遮盖串），默认不动，`--report` 单列其行数；运维确认接受误伤后可加 `--include-ambiguous-masked`。只替换 detail / title / payload / error 里的子串；动作、模块、实体、实体 id、用户、时间、行 id、金额、单号一律不动，`PRIVACY_ERASE` 审计行自身永不被改。
- **同一事务**：每个行业库仍是一个 `BEGIN IMMEDIATE` 事务；事务内重新取数、重新生成计划（管理员与在途订单复核同 X9），计划→执行→“实际改动行数必须等于计划行数，否则回滚”→全库原号码残留扫描→一条严格审计（含各表行数、未触碰的遮盖行数、残留列）。
- **`--report` / `--dry-run`**：只读打开；报告里的行数来自与真实执行同一份计划，因此测试断言 报告 = 执行输出 = 审计 `counts`。`--report` 不需要 `--confirm` / `--actor`，在途订单只列出（`would_refuse`）；`--dry-run` 需要 `--actor` 并做与真实执行相同的拒绝判断。报告同时给出：`raw_phone_not_covered`（按行预测：现在含原号码的行数减去计划会清掉的行数，所以与执行后的 `residual_raw_phone` 一致）与 `manual_review`（经销商 / 门店 / 供应商 / 员工 / 仓库 / IM 映射表里恰好相同的电话，只提示不改）。
- **导出**与抹除共用 `collect`：退款单、订货中心行、台账、含原号码或与主体单据绑定的日志行一并导出；仅遮盖片段命中的日志行只给行数，不导出（避免把别人的数据给本人）。

### 全库个人信息列清单与结论

对 `schema.sql` + 迁移后的 196 张表，按列名（name / phone / mobile / tel / addr / contact / nick / receiver / buyer / customer / member / subject / remark / reason / summary / payload / detail …）系统筛查，结论如下。

| 表.列 | 结论 |
|---|---|
| `mall_customers.phone,name`；`mall_cart_items.phone`；H5 `oms_orders.buyer_nick,receiver,receiver_phone,receiver_address`；`sales_orders.receiver,receiver_phone,receiver_address`；`pos_orders.member_phone` | 已覆盖（X9） |
| `refunds.customer_name` | **Y8 覆盖**（member 类型，或关联主体销售单且名字等于主体姓名） |
| `refunds.remark,void_reason`；`oms_orders/sales_orders/pos_orders.remark`；`member_points_ledger.remark`；`member_balance_ledger.remark` | **Y8 覆盖**：仅已关联行里的原号码子串 |
| `oc_customers.phone,contact,address`（名称仅等于主体姓名时）；`oc_addresses.phone,contact,address`（`name` 同上） | **Y8 覆盖**：电话精确等于主体 |
| `oc_orders.customer_name`、`oc_statements.customer_name`、`ar_documents/receipts/sales_invoices.subject_name`（`subject_type='oc'`）、`credit_accounts.name` | **Y8 覆盖**：关联客户 + 名称等于主体姓名 |
| `audit_logs.detail`、`notify_logs.title/payload/error` | **Y8 覆盖**：原号码 / 绑定行的遮盖片段；仅遮盖串命中的默认不动（可选） |
| `refunds.bank_account,serial_no`、`receipts.evidence_note`、`purchase_payments.evidence_note` 等 | 不动：账务凭证，是否个人信息需业务 / 法务确认 |
| `ar_documents/receipts/sales_invoices.subject_name`（`dealer` / `store`）、`oc_orders.customer_name`（企业名）、`dealers.name`、`stores.name` | 不动：企业名 / 往来对象主数据 |
| `dealers.contact,phone,address`；`stores.phone,address`；`suppliers.contact,phone,address`；`warehouses.phone,address`；`users.name,phone`；`im_user_map.external_name,mobile`；`*_by_name` / `creator_name` / `cashier_name` / `salesperson` / `applicant_name` 等 | 不动：供应商 / 经销商 / 员工等主数据与操作人留痕，不属于商城主体；报告 `manual_review` 只提示电话精确相同的行 |
| `mcp_call_logs.result_summary`、`doc_events.payload_json`、`oms_sync_logs.payload`、`im_sync_*`、`setting_audit_log.detail`、`period_audit_log.detail` 等其它自由文本 | 不改；执行后全库扫描，如含原号码在 `residual_raw_phone` 如实列出（精确 11 位，不含遮盖形式） |
| 其余含 `remark` / `reason` / `note` 的业务单据列 | 不改；同上由残留扫描兜底（只发现，不替换） |

### 边界（如实）

- Y8 之前已抹除的主体不会被追补：识别用的手机号已被换成伪名，名称集合也已丢失。
- 残留扫描只认精确 11 位原号码（带分隔符、受保护字段里的原号码都不会被改，也不会被当成已处理）；报告另给 `masked_fragment_columns` 仅供参考；带分隔符的写法（138-1234-5678）、其它遮盖形式、姓名 / 地址出现在自由文本里都发现不了。
- 遮盖串匹配的日志行是否属于主体无法由数据证明；默认保守不动，`--include-ambiguous-masked` 会把他人同遮盖串的行也改成主体伪名（误关联，不影响账务，但审计明细被改写）。
- 订货中心 / 往来客户名与主体姓名同名但并非同一人时会被改（姓名门槛只防“企业名”，不防“同名不同人”）。
- 全库扫描在大库上耗时随表量增长；未在生产量级上实测。
