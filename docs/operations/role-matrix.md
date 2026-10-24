<!-- 本文件由 scripts/gen-role-matrix.mjs 生成，CI 以 --check 校验不漂移；请勿手改，改门禁代码后重新生成并提交。 -->

# 角色 × 单据类型可见性矩阵

内置角色 10 个 × 单据类型 40 类。每个格子都是对真实门禁函数求值的结果（见 `scripts/gen-role-matrix.mjs` 文件头），不是手写结论。描述的是"该角色的默认账号"：数据范围取角色默认值、放在某个组织里、未绑定门店 / 经销商；单个账号的 `data_scope` 覆盖、多角色叠加与自定义角色不在本文件内（后三者见接口管理员出口与 `--json --db=`，只含计数）。这是开发阶段的文档，不是验收或上线声明。

## 一、单据流转读接口（HTTP `/api/docflow/*`）

- `G` 全局：看到全部单据（`data_scope=all`，或总部角色豁免了门店绑定）
- `O` 组织范围：只看本组织（子树 / 本组织）内的单据
- `B` 仅绑定：未绑定门店 / 经销商的账号看不到；绑定后只看自己的门店 / 经销商（总部角色绑了也只看本店）
- `-` 不可见：外部主体（`dealer` / `store`）整个 docflow 读接口 403；受限范围看不到无组织归属的总账类单据

docflow 读接口只按数据范围与总部豁免收口，不按查看权限点收口（权限点由第二节的 MCP 读工具和各业务路由把关）。

| 单据 | `admin` | `boss` | `purchase` | `sales` | `warehouse` | `finance` | `store` | `dealer` | `viewer` | `scm` |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `PO` 采购订单 | G | G | O | O | O | G | - | - | G | G |
| `GR` 采购到货单 | G | G | O | O | O | G | - | - | G | G |
| `PRT` 采购退货单 | G | G | O | O | O | G | - | - | G | G |
| `PRQ` 请购单 | G | G | O | O | O | G | - | - | G | G |
| `PI` 采购发票 | G | G | O | O | O | G | - | - | G | G |
| `PST` 采购结算单 | G | G | O | O | O | G | - | - | G | G |
| `PAY` 付款单 | G | G | O | O | O | G | - | - | G | G |
| `INS` 采购质检单 | G | G | O | O | O | G | - | - | G | G |
| `QT` 销售报价单 | G | G | O | O | O | G | - | - | G | G |
| `SO` 销售订单 | G | G | O | O | O | G | - | - | G | G |
| `DL` 销售发货单 | G | G | O | O | O | G | - | - | G | G |
| `SR` 销售退货单 | G | G | O | O | O | G | - | - | G | G |
| `SI` 销售发票 | G | G | O | O | O | G | - | - | G | G |
| `QCR` 报检单 | G | G | O | O | O | G | - | - | G | G |
| `QCI` 检验单 | G | G | O | O | O | G | - | - | G | G |
| `DH` 不良品处理单 | G | G | O | O | O | G | - | - | G | G |
| `TF` 库存调拨单 | G | G | O | O | O | G | - | - | G | G |
| `CK` 库存盘点单 | G | G | O | O | O | G | - | - | G | G |
| `AS` 组装拆卸单 | G | G | O | O | O | G | - | - | G | G |
| `CA` 存货成本调整单 | G | G | - | - | - | G | - | - | G | G |
| `AR` 应收单 | G | G | - | - | - | G | - | - | G | G |
| `YQ` 门店要货单 | G | G | O | O | O | G | - | - | B | G |
| `RCP` 收款单 | G | G | - | - | - | G | - | - | G | G |
| `SH` 门店发货单 | G | G | O | O | O | G | - | - | B | G |
| `VOUCHER` 记账凭证 | G | G | - | - | - | G | - | - | G | G |
| `RFD` 退款单 | G | G | - | - | - | G | - | - | G | G |
| `MO` 生产订单 | G | G | O | O | O | G | - | - | G | G |
| `WW` 委外订单 | G | G | O | O | O | G | - | - | G | G |
| `WM` 委外发料单 | G | G | O | O | O | G | - | - | G | G |
| `WR` 委外收货单 | G | G | O | O | O | G | - | - | G | G |
| `MR` 生产领料单 | G | G | O | O | O | G | - | - | G | G |
| `OM` 商城订单 | G | G | - | - | - | G | - | - | G | G |
| `PS` 门店零售单 | G | G | O | O | O | G | - | - | B | G |
| `PSF` 收银交班单 | G | G | O | O | O | G | - | - | B | G |
| `RC` 门店日结单 | G | G | O | O | O | G | - | - | B | G |
| `DR` 经销商要货单 | G | G | O | O | O | G | - | - | B | G |
| `DS` 经销商对账单 | G | G | O | O | O | G | - | - | G | G |
| `RB` 经销商返利单 | G | G | O | O | O | G | - | - | G | G |
| `OC` 订货单 | G | G | O | O | O | G | - | - | G | G |
| `OCS` 订货对账单 | G | G | O | O | O | G | - | - | G | G |

## 二、MCP 通用单据读工具（`doc.query` / `doc.get` / `doc.list_types`）

- `Y` 可读：所有者账号持有该类型的任一查看权限点（范围另按所有者数据范围收窄）
- `Y*` 可读但要绑定：所有者必须有门店 / 经销商 / 订货主体绑定，否则 `TOKEN_OWNER_BINDING_REQUIRED`（admin / 超管与无主令牌豁免）
- `-` 不可读：没有查看权限点，或外部主体读总部内部类型

| 单据 | `admin` | `boss` | `purchase` | `sales` | `warehouse` | `finance` | `store` | `dealer` | `viewer` | `scm` |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `PO` 采购订单 | Y | Y | Y | - | Y | Y | - | - | Y | Y |
| `GR` 采购到货单 | Y | Y | Y | - | Y | Y | - | - | Y | Y |
| `PRT` 采购退货单 | Y | Y | Y | - | Y | Y | - | - | Y | Y |
| `PRQ` 请购单 | Y | Y | Y | - | Y | Y | - | - | Y | Y |
| `PI` 采购发票 | Y | Y | Y | - | Y | Y | - | - | Y | Y |
| `PST` 采购结算单 | Y | Y | Y | - | Y | Y | - | - | Y | Y |
| `PAY` 付款单 | Y | Y | Y | - | Y | Y | - | - | Y | Y |
| `INS` 采购质检单 | Y | Y | Y | - | Y | - | - | - | Y | Y |
| `QT` 销售报价单 | Y | Y | - | Y | Y | Y | - | - | Y | Y |
| `SO` 销售订单 | Y | Y | - | Y | Y | Y | - | - | Y | Y |
| `DL` 销售发货单 | Y | Y | - | Y | Y | Y | - | - | Y | Y |
| `SR` 销售退货单 | Y | Y | - | Y | Y | Y | - | - | Y | Y |
| `SI` 销售发票 | Y | Y | - | Y | - | Y | - | - | Y | Y |
| `QCR` 报检单 | Y | Y | - | - | Y | - | - | - | Y | Y |
| `QCI` 检验单 | Y | Y | - | - | Y | - | - | - | Y | Y |
| `DH` 不良品处理单 | Y | Y | - | - | Y | - | - | - | Y | Y |
| `TF` 库存调拨单 | Y | Y | Y | Y | Y | Y | - | - | Y | Y |
| `CK` 库存盘点单 | Y | Y | Y | Y | Y | Y | - | - | Y | Y |
| `AS` 组装拆卸单 | Y | Y | Y | Y | Y | Y | - | - | Y | Y |
| `CA` 存货成本调整单 | Y | Y | - | - | Y | Y | - | - | Y | Y |
| `AR` 应收单 | Y | Y | - | Y | - | Y | - | - | Y | - |
| `YQ` 门店要货单 | Y | - | - | - | - | - | Y* | - | - | - |
| `RCP` 收款单 | Y | Y | - | Y | - | Y | - | - | Y | - |
| `SH` 门店发货单 | Y | - | - | - | - | - | Y* | - | - | - |
| `VOUCHER` 记账凭证 | Y | Y | Y | Y | - | Y | - | - | Y | - |
| `RFD` 退款单 | Y | Y | - | Y | - | Y | - | - | Y | - |
| `MO` 生产订单 | Y | Y | Y | - | Y | - | - | - | Y | Y |
| `WW` 委外订单 | Y | - | Y | - | Y | - | - | - | - | Y |
| `WM` 委外发料单 | Y | - | Y | - | Y | - | - | - | - | Y |
| `WR` 委外收货单 | Y | - | Y | - | Y | - | - | - | - | Y |
| `MR` 生产领料单 | Y | Y | Y | - | Y | - | - | - | Y | Y |
| `OM` 商城订单 | Y | Y | - | - | - | Y | - | - | Y | - |
| `PS` 门店零售单 | Y | - | - | - | - | - | Y* | - | - | - |
| `PSF` 收银交班单 | Y | - | - | - | - | - | Y* | - | - | - |
| `RC` 门店日结单 | Y | - | - | - | - | - | Y* | - | - | - |
| `DR` 经销商要货单 | Y | Y* | - | Y* | - | - | - | - | Y* | Y* |
| `DS` 经销商对账单 | Y | Y | - | Y | - | - | - | - | Y | Y |
| `RB` 经销商返利单 | Y | Y | - | Y | - | - | - | - | Y | Y |
| `OC` 订货单 | Y | Y | Y | Y | Y | Y | Y* | Y* | - | Y |
| `OCS` 订货对账单 | Y | Y | - | Y | - | Y | Y* | Y* | - | Y |

## 三、单据类型：查看权限点与绑定要求

| 单据 | 模块 | 查看权限点（任一） | MCP 绑定 | 范围注册表绑定 | 范围构建器 | 范围谓词来源（表 · 归属列 / 形状） |
|---|---|---|---|---|---|---|
| `PO` 采购订单 | purchase | `purchase.order.view`、`purchase.inbound`、`purchase.return` | 无 | 无 | purchase | purchase_orders · via=wh |
| `GR` 采购到货单 | purchase | `purchase.order.view`、`purchase.inbound`、`purchase.return` | 无 | 无 | purchase | purchase_receipts · via=wh |
| `PRT` 采购退货单 | purchase | `purchase.order.view`、`purchase.inbound`、`purchase.return` | 无 | 无 | purchase | purchase_returns · via=wh |
| `PRQ` 请购单 | purchase | `purchase.order.view`、`purchase.inbound`、`purchase.return` | 无 | 无 | purchase | purchase_requisitions · via=org |
| `PI` 采购发票 | purchase | `purchase.order.view`、`purchase.inbound`、`purchase.return` | 无 | 无 | purchase | purchase_invoices · via=org |
| `PST` 采购结算单 | purchase | `purchase.order.view`、`purchase.inbound`、`purchase.return` | 无 | 无 | purchase | purchase_settlements · via=org |
| `PAY` 付款单 | purchase | `purchase.order.view`、`purchase.inbound`、`purchase.return` | 无 | 无 | purchase | purchase_payments · via=org |
| `INS` 采购质检单 | purchase | `quality.inspect.view` | 无 | 无 | purchase | purchase_inspections · via=wh |
| `QT` 销售报价单 | sales | `sales.quote.view` | 无 | 无 | sales | sales_quotes · kind=order |
| `SO` 销售订单 | sales | `sales.order.view` | 无 | 无 | sales | sales_orders · kind=order |
| `DL` 销售发货单 | sales | `sales.order.view` | 无 | 无 | sales | sales_deliveries · kind=delivery |
| `SR` 销售退货单 | sales | `sales.order.view` | 无 | 无 | sales | sales_returns · kind=return |
| `SI` 销售发票 | sales | `sales.invoice.view` | 无 | 无 | org | sales_invoices · org_id |
| `QCR` 报检单 | quality | `quality.qc.view` | 无 | 无 | org | qc_requests · org_id |
| `QCI` 检验单 | quality | `quality.qc.view` | 无 | 无 | warehouse | qc_inspections · warehouse_id |
| `DH` 不良品处理单 | quality | `quality.qc.view` | 无 | 无 | warehouse | qc_defect_handlings · warehouse_id |
| `TF` 库存调拨单 | inventory | `inventory.stock.view` | 无 | 无 | warehouse | stock_transfers · from_warehouse_id+to_warehouse_id |
| `CK` 库存盘点单 | inventory | `inventory.stock.view` | 无 | 无 | warehouse | stock_checks · warehouse_id |
| `AS` 组装拆卸单 | inventory | `inventory.stock.view` | 无 | 无 | warehouse | assembly_orders · warehouse_id |
| `CA` 存货成本调整单 | inventory | `cost.view` | 无 | 无 | global | cost_adjustments |
| `AR` 应收单 | finance | `finance.receipt.view` | 无 | 无 | global | ar_documents |
| `YQ` 门店要货单 | requisition | `pos.store.requisition` | 门店 | 门店 | store | store_requisitions · store_id |
| `RCP` 收款单 | finance | `finance.receipt.view` | 无 | 无 | global | receipts |
| `SH` 门店发货单 | requisition | `pos.store.requisition` | 门店 | 门店 | store | store_shipments · store_id |
| `VOUCHER` 记账凭证 | finance | `finance.voucher.view` | 无 | 无 | global | vouchers |
| `RFD` 退款单 | finance | `finance.refund.view` | 无 | 无 | global | refunds |
| `MO` 生产订单 | produce | `produce.bom.view` | 无 | 无 | warehouse | production_orders · warehouse_id |
| `WW` 委外订单 | outsource | `produce.order.view` | 无 | 无 | warehouse | outsourcing_orders · warehouse_id |
| `WM` 委外发料单 | outsource | `produce.order.view` | 无 | 无 | warehouse | outsourcing_materials · warehouse_id |
| `WR` 委外收货单 | outsource | `produce.order.view` | 无 | 无 | warehouse | outsourcing_receipts · warehouse_id |
| `MR` 生产领料单 | produce | `produce.bom.view` | 无 | 无 | warehouse | material_issues · warehouse_id |
| `OM` 商城订单 | oms | `oms.order.view` | 无 | 无 | global | oms_orders |
| `PS` 门店零售单 | pos | `pos.cashier` | 门店 | 门店 | store | pos_orders · store_id |
| `PSF` 收银交班单 | pos | `pos.shift` | 门店 | 门店 | store | pos_shifts · store_id |
| `RC` 门店日结单 | pos | `pos.dailyclose` | 门店 | 门店 | store | pos_daily_closes · store_id |
| `DR` 经销商要货单 | dealer | `dms.dealer.view` | 经销商 | 经销商 | dealer | dealer_requisitions · dealer_id |
| `DS` 经销商对账单 | dealer | `dms.dealer.view` | 无 | 总部专属 | dealer | dealer_statements · dealer_id |
| `RB` 经销商返利单 | dealer | `dms.dealer.view` | 无 | 总部专属 | dealer | dealer_rebates · dealer_id |
| `OC` 订货单 | order-center | `order.view` | 订货主体 | 订货主体 | order-center | oc_orders |
| `OCS` 订货对账单 | order-center | `order.statement.view` | 订货主体 | 订货主体 | order-center | oc_statements |

## 四、内置角色与总部名单（`server/lib/hq-roles.js`）

权限点总数 144；admin 与超管恒全开。"总部（并集）"= docflow 严格门店绑定的豁免名单；POS / 要货两列是各自路由闸，与并集互不影响。

| 角色 | 名称 | 默认数据范围 | 权限点数 | 总部（并集） | POS 总部闸 | 要货总部闸 |
|---|---|---|---:|:-:|:-:|:-:|
| `admin` | 系统管理员 | all | 144 | 是 | 是 | 是 |
| `boss` | 老板/总经理 | all | 57 | 是 | 否 | 否 |
| `purchase` | 采购员 | subtree | 43 | 是 | 否 | 是 |
| `sales` | 销售员 | subtree | 39 | 是 | 是 | 是 |
| `warehouse` | 仓管员 | subtree | 37 | 是 | 是 | 是 |
| `finance` | 财务 | all | 64 | 是 | 是 | 是 |
| `store` | 店长 | org | 27 | 否 | 否 | 否 |
| `dealer` | 经销商 | dealer | 9 | 否 | 否 | 否 |
| `viewer` | 访客 | all | 28 | 否 | 否 | 否 |
| `scm` | 供应链主管 | all | 56 | 是 | 否 | 是 |

## 五、可见度五档（`GET /api/meta/role-matrix` 同一份计算）

`server/lib/role-matrix.js` 的 `buildRoleMatrix` 对每个内置角色推演的五档可见度（接口与本脚本共用，管理员出口另含自定义角色，自定义角色只出现在 `--json --db=<库>` 的 `tenant` 字段）。
`full` 全部｜`scoped` 按范围｜`bound` 须绑定｜`global_only` 仅全局｜`-` 无。

| 单据 | `admin` | `boss` | `scm` | `purchase` | `sales` | `warehouse` | `finance` | `store` | `dealer` | `viewer` |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `PO` 采购订单 | full | scoped | scoped | scoped | - | scoped | scoped | - | - | scoped |
| `GR` 采购到货单 | full | scoped | scoped | scoped | - | scoped | scoped | - | - | scoped |
| `PRT` 采购退货单 | full | scoped | scoped | scoped | - | scoped | scoped | - | - | scoped |
| `PRQ` 请购单 | full | scoped | scoped | scoped | - | scoped | scoped | - | - | scoped |
| `PI` 采购发票 | full | scoped | scoped | scoped | - | scoped | scoped | - | - | scoped |
| `PST` 采购结算单 | full | scoped | scoped | scoped | - | scoped | scoped | - | - | scoped |
| `PAY` 付款单 | full | scoped | scoped | scoped | - | scoped | scoped | - | - | scoped |
| `INS` 采购质检单 | full | scoped | scoped | scoped | - | scoped | - | - | - | scoped |
| `QT` 销售报价单 | full | scoped | scoped | - | scoped | scoped | scoped | - | - | scoped |
| `SO` 销售订单 | full | scoped | scoped | - | scoped | scoped | scoped | - | - | scoped |
| `DL` 销售发货单 | full | scoped | scoped | - | scoped | scoped | scoped | - | - | scoped |
| `SR` 销售退货单 | full | scoped | scoped | - | scoped | scoped | scoped | - | - | scoped |
| `SI` 销售发票 | full | scoped | scoped | - | scoped | - | scoped | - | - | scoped |
| `QCR` 报检单 | full | scoped | scoped | - | - | scoped | - | - | - | scoped |
| `QCI` 检验单 | full | scoped | scoped | - | - | scoped | - | - | - | scoped |
| `DH` 不良品处理单 | full | scoped | scoped | - | - | scoped | - | - | - | scoped |
| `TF` 库存调拨单 | full | scoped | scoped | scoped | scoped | scoped | scoped | - | - | scoped |
| `CK` 库存盘点单 | full | scoped | scoped | scoped | scoped | scoped | scoped | - | - | scoped |
| `AS` 组装拆卸单 | full | scoped | scoped | scoped | scoped | scoped | scoped | - | - | scoped |
| `CA` 存货成本调整单 | full | global_only | global_only | - | - | global_only | global_only | - | - | global_only |
| `AR` 应收单 | full | global_only | - | - | global_only | - | global_only | - | - | global_only |
| `YQ` 门店要货单 | full | - | - | - | - | - | - | bound | - | - |
| `RCP` 收款单 | full | global_only | - | - | global_only | - | global_only | - | - | global_only |
| `SH` 门店发货单 | full | - | - | - | - | - | - | bound | - | - |
| `VOUCHER` 记账凭证 | full | global_only | - | global_only | global_only | - | global_only | - | - | global_only |
| `RFD` 退款单 | full | global_only | - | - | global_only | - | global_only | - | - | global_only |
| `MO` 生产订单 | full | scoped | scoped | scoped | - | scoped | - | - | - | scoped |
| `WW` 委外订单 | full | - | scoped | scoped | - | scoped | - | - | - | - |
| `WM` 委外发料单 | full | - | scoped | scoped | - | scoped | - | - | - | - |
| `WR` 委外收货单 | full | - | scoped | scoped | - | scoped | - | - | - | - |
| `MR` 生产领料单 | full | scoped | scoped | scoped | - | scoped | - | - | - | scoped |
| `OM` 商城订单 | full | global_only | - | - | - | - | global_only | - | - | global_only |
| `PS` 门店零售单 | full | - | - | - | - | - | - | bound | - | - |
| `PSF` 收银交班单 | full | - | - | - | - | - | - | bound | - | - |
| `RC` 门店日结单 | full | - | - | - | - | - | - | bound | - | - |
| `DR` 经销商要货单 | full | scoped | scoped | - | scoped | - | - | - | - | bound |
| `DS` 经销商对账单 | full | scoped | scoped | - | scoped | - | - | - | - | scoped |
| `RB` 经销商返利单 | full | scoped | scoped | - | scoped | - | - | - | - | scoped |
| `OC` 订货单 | full | scoped | scoped | scoped | scoped | scoped | scoped | bound | bound | - |
| `OCS` 订货对账单 | full | scoped | scoped | - | scoped | - | scoped | bound | bound | - |
