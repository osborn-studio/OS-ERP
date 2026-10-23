# ADR-0018：人工资金模式 —— 收付款确认必须有证据，并由第二人复核

日期：2026-10-23。关联审阅报告 F10（P1，"商城结算不等于真实资金闭环"）与 backlog 的决定：不接支付网关，后台人工登记收款 / 付款，**但必须由真实凭证和第二人复核支撑**。本条只覆盖两处真正动钱的动作 —— 收款单确认（`ar.confirmReceipt`）与付款单执行付款（`purchase.transitionPayment` 的 `pay`）；商城 / OMS / 奇门的模拟支付路径不在本条范围。

## 问题

- `POST /api/ar/receipts/:id/confirm` 与 `POST /api/purchase/payments/:id/pay` 都是一个人、一次点击就落地：核销应收、释放授信（ADR-0013 的台账）、把结算单标成已付。没有任何字段要求"钱确实到了"的证据，也没有第二个人看过。
- 审计是宽松口径（`audit()` 失败不阻断），"动作成功了但审计上没有"对动钱的动作不可接受（ADR-0010 第 5 节只把配置 / 信用额度 / 账号切到了严格审计）。

## 决定

**原确认逻辑一行不改，只在它前面加一道门；门的判据只有一处。**

- 新文件 `server/lib/funds-review.js` 是证据闸与二人复核的**唯一实现**。两个路由都把原来的确认函数作为 `apply` 回调传进去：
  - `confirmFunds(db, { kind, id, actor, evidence, apply })`（发起人 A）：
    1. 待复核中 → 409 `FUNDS_REVIEW_PENDING`；不在可确认状态 → 409 `FUNDS_NOT_READY`；
    2. `funds_evidence_required` 打开且既没传 `evidence_ref`、行上也没存过 → 400 `FUNDS_EVIDENCE_REQUIRED`；
    3. 证据落到行上（`evidence_ref` / `evidence_note`）；
    4. `funds_review_required` 打开且金额 ≥ `funds_review_threshold`（0 = 每笔）→ 只写 `review_status='pending_review'` + 发起人 + 时间，严格审计 `FUNDS_REVIEW_REQUEST`，**不调用 `apply`**：内核 `status` 不变（收款单 `draft` / 付款单 `approved`），应收、授信台账、结算单一分不动；
    5. 否则在**同一事务**里 `apply()` + 严格审计 `FUNDS_CONFIRM`。
  - `reviewFunds(db, { kind, id, actor, decision, comment, apply })`（复核人 B，路由上要求权限 `finance.funds.review`）：
    - 不在待复核 → 409 `FUNDS_NOT_PENDING`；发起人即复核人 → 409 `FUNDS_SELF_REVIEW`（按 user id 比，两边都没 id 时按名字兜底）；`decision` 不是 approve / reject → 400 `FUNDS_BAD_DECISION`；驳回没写原因 → 400 `FUNDS_COMMENT_REQUIRED`；
    - approve：同一事务里写复核人 / 时间 / 意见 → `apply()`（即原来的 `confirmReceipt` / `transitionPayment pay`，含 ADR-0013 的授信释放台账）→ 严格审计 `FUNDS_REVIEW_APPROVE`。任一步失败整笔回滚，单据仍是待复核；
    - reject：写 `review_status='rejected'` + 原因 + 严格审计 `FUNDS_REVIEW_REJECT`。内核状态本来就没动，所以"退回原状态"（收款单草稿 / 付款单已审批）不需要再做什么；发起人补好证据后可再次发起，复核列被覆盖、复核人清空。
  - `assertNotPending`：待复核期间收款单作废、付款单任何内核动作（再次 `pay` / `void`）一律 409 `FUNDS_REVIEW_PENDING`。挂起的确认不能被作废悄悄抹掉，要先由复核人驳回。
- 严格审计走 `lib/audit-trail.js` 的 `auditStrictRow`（ADR-0010 第 4 节），审计行带 `ip`、`doc_no`、金额、证据号、发起人、意见；审计表写不进去 → 503 `SECURITY_AUDIT_UNAVAILABLE`，业务写入回滚。
- 迁移 `056_funds_maker_checker.cjs`：`receipts` / `purchase_payments` 各加 `evidence_ref` / `evidence_note` / `review_status` / `review_maker_id` / `review_maker_name` / `review_requested_at` / `review_checker_id` / `review_checker_name` / `review_decided_at` / `review_comment`；权限点 `finance.funds.review`（资金收付复核），默认授予内置角色 admin / finance。`verify()` 只查列与权限字典，不查授权集合（ADR-0007）。
- 配置（`lib/settings.js`，新分组 `funds`，三条都 `is_danger`）：`funds_evidence_required`（bool，默认 1）、`funds_review_required`（bool，默认 1）、`funds_review_threshold`（number ≥ 0，默认 0）。关掉任一条等于允许一个人凭空确认收付款，改动必须写理由并进 `setting_audit_log`。

### 为什么"待复核"是独立列，不是内核状态

单据内核的 `doc_states` / `doc_actions` 定义归 008 迁移，后来的迁移写进去会被 008 的自愈抹掉；而 008 已执行、受迁移校验和保护（ADR-0009，生产模式篡改即拒绝启动）。更根本的是：待复核**不是一次有后果的流转**，它是"确认动作被挂起"—— 钱、额度、应收都没动。所以用 `review_status` 承载，内核 `status` 在挂起期间保持 ready 态。代价是列表按 `status` 筛选时待复核单仍落在 draft / approved 里，界面用 `review_status` 另打标签。

### 为什么付款单驳回回到 `approved` 而不是 `draft`

付款单的 `approved`（提交审批）是"核销生效"（用友口径，见 `Payments.tsx` 文件头），`pay` 只是"钱出去了"。复核人驳回的是"钱出去了"这件事的证据，不是核销本身；退回 `approved` 让发起人补证据再发起，不必重走审批。收款单没有这一层，退回即草稿。

## 接口变化（新增字段为主；`pay` 的响应形状有变）

- `POST /api/ar/receipts/:id/confirm` 请求体增加 `evidence_ref` / `evidence_note`；响应增加 `review: {status, maker:{id,name,at}, checker:{id,name}, decided_at, comment, evidence_ref, evidence_note}`。挂起时 `status` 仍为 `draft`、无 `credit_released`。
- 新增 `POST /api/ar/receipts/:id/review`（`finance.funds.review`）、`POST /api/purchase/payments/:id/review`（同权限；排在 `/:action` 之前，`review` 不是内核动作），请求体 `{decision: approve|reject, comment}`。
- `POST /api/purchase/payments/:id/pay` 接受 `evidence_ref` / `evidence_note`；响应由原来的流转结果 `{docType, from, to, ...}` 改为**付款单行 + `review`**。`GET /api/purchase/payments/:id` 与 `GET /api/ar/receipts/:id` 增加 `review` 块；列表行自带 `review_status` 等新列。
- `GET /api/ar/meta` 增加 `funds_review_status` 字典与 `funds_review_perm`。
- 新错误码：`FUNDS_EVIDENCE_REQUIRED`（400）、`FUNDS_REVIEW_PENDING`（409）、`FUNDS_NOT_READY`（409）、`FUNDS_NOT_PENDING`（409）、`FUNDS_SELF_REVIEW`（409）、`FUNDS_BAD_DECISION`（400）、`FUNDS_COMMENT_REQUIRED`（400）；严格审计不可用沿用 `SECURITY_AUDIT_UNAVAILABLE`（503）。
- 新严格审计动作：`FUNDS_REVIEW_REQUEST` / `FUNDS_CONFIRM` / `FUNDS_REVIEW_APPROVE` / `FUNDS_REVIEW_REJECT`（`module` 为 finance / purchase，`entity` 为 receipts / purchase_payments）。原宽松审计 `RC_CONFIRM` / `pay` 只在真正生效时再记一条。
- OpenAPI 契约版本 1.32.0 → 1.33.0；`src/types/api-routes.ts` 重新生成。

**默认行为变化**：升级后，收款确认与付款执行默认**需要凭证号且每笔都要第二人复核**。单人演示要把 `funds_review_required` 关掉（危险项，必须写理由）。`lib/ar.js` 的 `confirmReceipt` 与 `lib/purchase.js` 的 `transitionPayment` 本身不变 —— 直接调 lib 的脚本（`scripts/test-ar.mjs` / `test-purchase.mjs`）与既有测试不受影响；门只在 HTTP 路由上。

## 前端

`src/pages/finance/Receivables.tsx` 收款单详情：草稿且未在复核中时显示凭证号 / 说明输入，确认按钮带着证据提交；列表与详情对 `review_status='pending_review'` 显示「待复核」；持 `finance.funds.review` 且不是发起人的用户看到「复核通过 / 驳回（原因必填）」。`src/pages/purchase/Payments.tsx` 同样：执行付款先要凭证号，待复核显示标签与复核按钮。权限取自 `/api/auth/me` 的 `permissions`。`npx tsc --noEmit` 通过；未做浏览器实跑。

## 验证入口

`node --test tests/funds-maker-checker.test.mjs`：内存库直调 lib（证据必填与放宽；阈值分流 —— 挂起时应收余额 / `credit_release_ledger` 行数 / SO 占用不变；自审拒绝；驳回无效果且可再发起；批准恰好生效一次 —— 应收 40、台账 1 行、`doc_events` confirm 1 条、二次批准 / 再确认都被拒；审计表触发器注入 → 批准与直接确认均 503 且整笔回滚；复核关闭直接生效仍要证据；付款单 `pay` 同一道门、批准后 `paid` + 结算单已付 200）+ 隔离 test 服务的 HTTP（finance 角色经迁移获得复核权限、sales / purchase 角色 403、发起人自审 409、待复核期间确认 / 作废 / 通用动作路由 409、admin 可驳回、设置关闭后直接确认、阈值 60 分流、付款 `review` 不能被 `/:action` 绕过）。只在临时目录与随机回环端口运行；合成凭据不输出。Node/macOS 结果仅为开发证据，目标平台验收以 CI 为准。
