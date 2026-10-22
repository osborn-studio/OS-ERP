# 独立验收 · 端到端 HTTP 清单

> 对象提交：`dbe62f9d1544bb3b2a4f76a4a300b424f1267663`（来源：env：harness 传入）｜服务：疑似独立副本（有哨兵；源 HEAD dbe62f9d） + 全新三库 + 独立端口 42351｜生成：2026-10-17T06:47:30.783Z
> 全部请求用**真实 HTTP + 真实令牌**发出（不是 router.handle 注入）。

| # | 用例 | 方法 | URL | 期望码 | 实际码 | 业务码 | 判定 |
|---|---|---|---|---|---|---|---|
| 1 | 健康检查 | GET | `/api/meta/health` | 200 | 200 | — | ✅ |
| 2 | 登录（正） | POST | `/api/auth/login` | 200 | 200 | — | ✅ |
| 3 | 登录（负·错误口令） | POST | `/api/auth/login` | 401 | 401 | — | ✅ |
| 4 | 通用流转驱动带副作用的单据（负） | POST | `/api/docflow/transition` | 409 | 409 | EFFECT_REQUIRES_BUSINESS_API | ✅ |
| 5 | 采购结算（负·无权限） | POST | `/api/purchase/settlements/1/settle` | 403 | 403 | PERM_DENIED | ✅ |
| 6 | C 端令牌打 MCP（负） | POST | `/mcp` | 200 | 200 | [object Object] | ✅ |
| 7 | 退货（负·超退） | POST | `/api/sales/returns` | 409 | 409 | RETURN_EXCEEDS_SHIPPED | ✅ |
| 8 | 退货（负·缺来源行） | POST | `/api/sales/returns` | 400 | 400 | SOURCE_REQUIRED | ✅ |
| 9 | 审批提交（负·外部主体×内部单据） | POST | `/api/approval/instances` | 403 | 403 | — | ✅ |
| 10 | 审批提交（负·单据不存在） | POST | `/api/approval/instances` | 404 | 404 | — | ✅ |
| 11 | 协议价取证接口（正·本轮修复的那个） | GET | `/api/dms/agreements/explain?sku_id=1&dealer_id=1&qty=1` | 200 | 200 | — | ✅ |
| 12 | IM 元数据（正） | GET | `/api/im/meta` | 200 | 200 | — | ✅ |
| 13 | IM 状态（正） | GET | `/api/im/status` | 200 | 200 | — | ✅ |
| 14 | IM 同步（负·未配置） | POST | `/api/im/sync/org` | 409 | 409 | IM_NOT_CONFIGURED | ✅ |
| 15 | IM 同步（负·viewer 无权限） | POST | `/api/im/sync/org` | 403 | 403 | — | ✅ |
| 16 | IM 自检（正） | POST | `/api/im/self-test` | 200 | 200 | — | ✅ |
| 17 | IM 自证（正） | GET | `/api/im/audit` | 200 | 200 | — | ✅ |
| 18 | IM 未知平台（负） | POST | `/api/im/sync/org` | 400 | 400 | — | ✅ |
| 19 | 不存在的接口（负） | GET | `/api/definitely/not/here` | 404 | 404 | — | ✅ |
| 20 | A14 商城下单（应走 checkout.settle） | POST | `/api/mall/orders` | 200 | 200 | — | ✅ |
| 21 | A15 商城下单（用积分抵现） | POST | `/api/mall/orders` | 200 | 200 | — | ✅ |
| 22 | A15 撤单 | POST | `/api/mall/orders/401/cancel` | 200 | 200 | — | ✅ |
| 23 | A17b 改草稿数量为 0（应拒） | PUT | `/api/sales/orders/233` | 400 | 400 | — | ✅ |
| 24 | A17b 只改运费（应重算） | PUT | `/api/sales/orders/233` | 200 | 200 | — | ✅ |
| 25 | A18 跨供应商核销（应拒） | POST | `/api/purchase/payments` | 409 | 409 | PAY_ALLOC_SUPPLIER_MISMATCH | ✅ |
| 26 | A18 超未付余额核销（应拒） | POST | `/api/purchase/payments` | 409 | 409 | PAY_ALLOC_OVER_OPEN | ✅ |
| 27 | A18 非法币种（应拒） | POST | `/api/purchase/payments` | 400 | 400 | PAY_BAD_CURRENCY | ✅ |
| 28 | A18 第一张草稿生效 | POST | `/api/purchase/payments/5/submit` | 200 | 200 | — | ✅ |
| 29 | A18 第二张草稿生效（应被余额闸门拒） | POST | `/api/purchase/payments/6/submit` | 409 | 409 | PAY_ALLOC_OVER_OPEN | ✅ |
| 30 | A06 建销售订单（正） | POST | `/api/sales/orders` | 200 | 200 | — | ✅ |
| 31 | A06 确认订单（正·占用授信） | POST | `/api/sales/orders/815/confirm` | 200 | 200 | — | ✅ |
| 32 | A06 确认收款（正·应释放授信） | POST | `/api/ar/receipts/10/confirm` | 200 | 200 | — | ✅ |
| 33 | A07 核销额 > 实收额（负） | POST | `/api/ar/receipts` | 409 | 409 | RC_ALLOC_EXCEEDS_RECEIPT | ✅ |
| 34 | A07 第二张草稿确认（负·重复抵同一应收） | POST | `/api/ar/receipts/13/confirm` | 409 | 409 | AR_OVER_ALLOCATED | ✅ |
| 35 | A10 部分发票红冲（正） | POST | `/api/invoices/4/red-chart` | 200 | 200 | — | ✅ |
| 36 | A11 建生产领料单（正·不指定批次 ⇒ 允许跨批次） | POST | `/api/manufacture/issues` | 200 | 200 | — | ✅ |
| 37 | A11 确认领料出库（正） | POST | `/api/manufacture/issues/5/issue` | 200 | 200 | — | ✅ |
| 38 | A13 指名不合格批次做可售出库（负） | POST | `/api/manufacture/issues/6/issue` | 409 | 409 | BATCH_NOT_SELLABLE | ✅ |

合计 **38** 条：正向 19 · 负向 19
