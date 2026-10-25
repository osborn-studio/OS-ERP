/**
 * ============================================================================
 * 文件标识：server/openapi.js ｜ OpenAPI 3.0 契约（**接口文档的唯一出处**）：路径 / 参数 / 业务场景枚举；`npm run gen:api` 由此生成前端类型
 * ============================================================================
 * 【职责】OpenAPI 3.0 契约（**接口文档的唯一出处**）：路径 / 参数 / 业务场景枚举；`npm run gen:api` 由此生成前端类型
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自手写**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

const jsonResp = (schemaRef, desc = '成功') => ({
  description: desc,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiResponse' } } }
})

// 安全会话端点使用明确的 data 形状；既有 jsonResp 的泛型包装保持兼容。
const sessionResp = (dataRef, description) => ({
  description,
  content: { 'application/json': { schema: { allOf: [
    { $ref: '#/components/schemas/ApiResponse' },
    { type: 'object', required: ['data'], properties: { data: { $ref: `#/components/schemas/${dataRef}` } } }
  ] } } }
})

const q = (name, desc, required = false, schema = { type: 'string' }) => ({ name, in: 'query', description: desc, required, schema })
const body = (ref, desc = '请求体') => ({ required: true, description: desc, content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } })
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } }
// 具名路径参数（促销与会员域大量使用 `{customerId}` / `{code}` 这类非 id 的路径段）
const p = (name, desc, schema = { type: 'string' }) => ({ name, in: 'path', required: true, description: desc, schema })

export function buildOpenApi() {
  const paths = {
    '/api/meta/health': {
      get: { tags: ['系统'], summary: '健康检查（匿名只返回 status/版本/构建 SHA/时间；带 admin 令牌另返回 database 与 ops 运维块，ADR-0029）', security: [], responses: { 200: jsonResp(null, '服务状态') } }
    },
    '/api/meta/metrics': {
      get: {
        tags: ['系统'],
        summary: '运维计数器（备份年龄/迁移校验和不一致/节流存储/磁盘；仅 admin 或 is_super，ADR-0029）。format=prometheus 返回 text/plain 指标（os_erp_ 前缀），另接受 GML_METRICS_TOKEN Bearer（仅此格式，ADR-0045）',
        parameters: [q('format', 'json（默认）或 prometheus；其它值 400')],
        responses: { 200: jsonResp(null, '计数器（json）或 Prometheus 文本（prometheus）'), 400: jsonResp(null, 'format 非法'), 401: jsonResp(null, '未认证'), 403: jsonResp(null, '非管理员') }
      }
    },
    '/api/meta/dict': {
      get: { tags: ['系统'], summary: '枚举字典（状态/角色/单据类型）', security: [], responses: { 200: jsonResp(null, '字典') } }
    },
    // ---- 系统参数（批次 R）：配置的定义、当前值与**变更历史** ----
    // 这组端点在此之前**没有登记进契约**（`GET/PUT /api/meta/settings` 一直存在，
    // 但只在路由里），本批一并补齐 —— 配置是会计政策的载体，它不该躲在契约之外。
    '/api/meta/settings': {
      get: {
        tags: ['系统参数'],
        summary: '配置定义 + 当前值（按分组返回，含是否偏离默认值与历史条数）',
        responses: { 200: jsonResp(null, '{ groups, items, total, changed, note }') }
      },
      put: {
        tags: ['系统参数'],
        summary: '修改配置（同事务写变更日志；值未变时返回 changed=false 且不写日志）',
        requestBody: body('SettingWrite'),
        responses: {
          200: jsonResp(null, '{ key, value, changed, logged, entry_id }'),
          400: { description: '未登记的键（SETTING_UNKNOWN）/ 值域不合法（SETTING_VALUE_INVALID）/ 危险配置未写理由（SETTING_REASON_REQUIRED）' }
        }
      }
    },
    '/api/meta/settings/defs': {
      get: { tags: ['系统参数'], summary: '配置定义表（标签 / 类型 / 默认值 / 值域 / 是否危险）—— "有哪些键"的唯一出处', responses: { 200: jsonResp(null) } }
    },
    '/api/meta/settings/reset': {
      post: {
        tags: ['系统参数'],
        summary: '恢复默认值（同样留痕，action=reset；危险配置必填理由）',
        requestBody: body('SettingReset'),
        responses: { 200: jsonResp(null, '{ key, value, changed, logged }'), 400: { description: '危险配置未写理由' } }
      }
    },
    '/api/meta/settings/audit': {
      get: {
        tags: ['系统参数'], summary: '配置变更历史（只追加，没有修改与删除路径）',
        parameters: [q('key', '只看某个配置键'), q('danger_only', '只看危险配置（1/true）'), q('limit', '返回条数，默认 200，上限 1000')],
        responses: { 200: jsonResp(null, '{ rows, total, limit, truncated, actions }') }
      }
    },
    '/api/meta/settings/audit/check': {
      get: { tags: ['系统参数'], summary: '配置变更链自证（重放日志==现状 / 键集合一致 / 危险项变更都写了理由 / 值域合法）', responses: { 200: jsonResp(null, '{ ok, problems, keys_checked, entries_checked, registered_keys }') } }
    },
    '/api/meta/audit-logs': {
      get: {
        tags: ['系统'], summary: '审计日志查询（权限 system:audit:view；分页 + 模块/动作/用户/对象/日期/关键字过滤；detail 读取时再脱敏；附保留策略提示）',
        parameters: [q('module', '模块（精确）'), q('action', '动作（精确）'), q('user', '操作人：纯数字按 user_id（走索引），否则按用户名包含'), q('entity', '对象类型（精确）'), q('entity_id', '对象 ID（精确）'), q('from', '起始日期 YYYY-MM-DD（含）'), q('to', '截止日期 YYYY-MM-DD（含）'), q('keyword', '关键字：至少 2 个有效字符，只搜 action / entity / user_name（子串，不搜 detail）；不足返回 400'), q('page', '页码'), q('pageSize', '每页条数，上限 200')],
        responses: { 200: jsonResp(null, '{ list, total（封顶估算，最多 10001）, has_more（total>10000）, total_cap, page, pageSize, totalPages, retention, export_max_rows, fts: { setting_enabled（设置 audit_fts_enabled）, index_present（库里有 FTS 索引表）, env_disabled（GML_AUDIT_FTS=0）, active（关键词查询实际可走索引 = index_present 且非 env_disabled，与设置值可能暂时不一致，直到维护脚本或重启收敛）} }'), 400: { description: '日期格式或区间不合法 / 关键字太短 / 翻页超过 10000 条上限' }, 403: { description: '缺 system:audit:view' } }
      }
    },
    '/api/meta/audit-logs/export.csv': {
      get: {
        tags: ['系统'], summary: '审计日志 CSV 导出（同一过滤；分批流式；行数封顶；公式注入安全；导出动作写严格审计 AUDIT_LOG_EXPORT）',
        parameters: [q('module', '模块（精确）'), q('action', '动作（精确）'), q('user', '操作人'), q('entity', '对象类型'), q('entity_id', '对象 ID'), q('from', '起始日期'), q('to', '截止日期'), q('keyword', '关键字（至少 2 个有效字符，同列表）')],
        responses: { 200: { description: 'text/csv（UTF-8 BOM；响应头 X-Export-Truncated 表示是否被行数上限截断）' }, 403: { description: '缺 system:audit:view' } }
      }
    },
    '/api/auth/login': {
      post: {
        tags: ['认证'], summary: '登录获取 Token', security: [],
        requestBody: body('LoginRequest'), responses: { 200: jsonResp(null, '登录成功，返回 token 与用户信息') }
      }
    },
    '/api/auth/me': { get: { tags: ['认证'], summary: '当前登录用户', responses: { 200: jsonResp(null) } } },
    '/api/auth/industries': { get: { tags: ['认证'], summary: '可选行业版本列表（登录页用，公开）', security: [], responses: { 200: jsonResp(null, '{ code, name, label } 数组') } } },
    '/api/auth/users': {
      get: { tags: ['认证'], summary: '用户列表（管理员）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('keyword', '关键字')], responses: { 200: jsonResp(null) } },
      post: { tags: ['认证'], summary: '新建用户（管理员）', requestBody: body('UserCreate'), responses: { 200: jsonResp(null) } }
    },
    '/api/auth/change-password': {
      post: {
        tags: ['认证'], summary: '修改本人密码并撤销全部后台会话',
        description: '成功后包括当前请求凭据在内的该账号后台 JWT 均失效；客户端清除本地会话并重新登录。不撤销独立 Agent Token。',
        requestBody: body('ChangePasswordRequest'),
        responses: {
          200: sessionResp('ChangePasswordResult', '密码更新与会话撤销已提交；data.changed=true，data.reauthenticate=true'),
          400: jsonResp(null, '原密码不正确或新密码不符合共享密码规则'),
          401: jsonResp(null, '未登录或后台会话已撤销'),
          409: jsonResp(null, '并发账号变更导致冲突，需要重新登录')
        }
      }
    },
    '/api/auth/logout-all': {
      post: {
        tags: ['认证'], summary: '退出本账号全部后台会话',
        description: '无需请求体。成功后包括当前请求凭据在内的后台 JWT 均失效，客户端清除本地会话。网络错误不代表撤销已完成；独立 Agent Token 不在此范围。',
        responses: {
          200: sessionResp('LogoutAllResult', '全部后台会话撤销已提交；data.revoked=true'),
          401: jsonResp(null, '未登录或后台会话已撤销')
        }
      }
    },
    // ---- 角色与权限（前端「系统管理 → 角色与权限」页）----
    // 为什么公开这三个：客户要能在界面上自己分配权限、并且**看到**这个角色能进哪些菜单。
    // `roles/{code}/permissions` 是**整体覆盖**（后端先删后插），调用方必须提交完整勾选集合。
    '/api/auth/permissions': { get: { tags: ['认证'], summary: '权限点字典（按模块分组，供角色权限矩阵渲染）', responses: { 200: jsonResp(null) } } },
    '/api/auth/my-permissions': { get: { tags: ['认证'], summary: '当前用户的有效权限点与数据范围（前端据此收敛按钮与数据）', responses: { 200: jsonResp(null) } } },
    '/api/auth/my-scope': { get: { tags: ['认证'], summary: '**当前用户的有效数据范围**与白话解释（只读，仅描述调用者自己：角色、是否管理员、生效范围及来源、所属组织/门店/经销商、范围内组织数与前 20 个名称）', responses: { 200: jsonResp(null), 401: jsonResp(null) } } },
    '/api/auth/roles-permissions': { get: { tags: ['认证'], summary: '**角色与权限矩阵**：每个角色的权限点集合（仅管理员）', responses: { 200: jsonResp(null), 403: jsonResp(null) } } },
    '/api/auth/roles/{code}/deactivation-impact': {
      get: {
        tags: ['认证'],
        summary: '**停用角色的影响预告**（仅管理员；AH10，ADR-0051 补充 5）：受影响账号数 N（被授予该角色的启用中非管理员账号）与其中主角色为此角色的 M；只含账号编号不含账号名；角色不存在 404 ROLE_NOT_FOUND',
        parameters: [idParam],
        responses: { 200: jsonResp(null), 401: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) }
      }
    },
    '/api/auth/roles/{code}/deactivate': {
      post: {
        tags: ['认证'],
        summary: '**停用角色**（仅管理员；AH10）：必须带 confirm_affected（先取影响预告），与事务内现算的 N 不一致 409 ROLE_IMPACT_CHANGED（响应 detail 带当前人数）；缺失或不是非负整数 400 ROLE_CONFIRM_REQUIRED；管理员角色 409 ROLE_ADMIN_PROTECTED；已停用 409 ROLE_ALREADY_INACTIVE；写严格审计 ROLE_DEACTIVATE（明细带受影响人数）；不撤销会话',
        parameters: [idParam],
        requestBody: body('RoleDeactivate'),
        responses: { 200: jsonResp(null), 400: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) }
      }
    },
    '/api/auth/roles/{code}/activate': {
      post: {
        tags: ['认证'],
        summary: '**启用角色**（仅管理员；AH10）：恢复被停用的角色，无需确认；已启用 409 ROLE_ALREADY_ACTIVE；写严格审计 ROLE_ACTIVATE（明细带当前持有人数）',
        parameters: [idParam],
        responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) }
      }
    },
    '/api/auth/roles/{code}/permissions': {
      put: {
        tags: ['认证'],
        summary: '**覆盖式**保存某角色的权限点（仅管理员；整体覆盖，需提交完整集合）',
        parameters: [idParam],
        requestBody: body('RolePermissions'),
        responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) }
      }
    },


    '/api/master/options': { get: { tags: ['主数据'], summary: '下拉选项聚合（品牌/品类/仓库/门店/供应商/经销商/平台/SKU）', responses: { 200: jsonResp(null) } } },
    '/api/master/overview': { get: { tags: ['主数据'], summary: '主数据数量概览', responses: { 200: jsonResp(null) } } },
    '/api/master/products': {
      get: { tags: ['主数据'], summary: '商品列表', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('keyword', '名称/编码'), q('brand_id', '品牌'), q('category_id', '品类'), q('status', '状态')], responses: { 200: jsonResp(null) } },
      post: { tags: ['主数据'], summary: '新建商品（可带 SKU）', requestBody: body('ProductCreate'), responses: { 200: jsonResp(null) } }
    },
    '/api/master/products/{id}': {
      get: { tags: ['主数据'], summary: '商品详情（含 SKU）', parameters: [idParam], responses: { 200: jsonResp(null) } },
      put: { tags: ['主数据'], summary: '修改商品', parameters: [idParam], responses: { 200: jsonResp(null) } },
      delete: { tags: ['主数据'], summary: '删除商品（被引用时禁止）', parameters: [idParam], responses: { 200: jsonResp(null) } }
    },
    '/api/master/skus': {
      get: { tags: ['主数据'], summary: 'SKU 列表', parameters: [q('product_id', '所属商品'), q('keyword', '关键字'), q('limit', '返回条数')], responses: { 200: jsonResp(null) } },
      post: { tags: ['主数据'], summary: '新增 SKU', responses: { 200: jsonResp(null) } }
    },
    '/api/master/brands': { get: { tags: ['主数据'], summary: '品牌列表', responses: { 200: jsonResp(null) } }, post: { tags: ['主数据'], summary: '新建品牌', responses: { 200: jsonResp(null) } } },
    '/api/master/categories': { get: { tags: ['主数据'], summary: '品类列表', responses: { 200: jsonResp(null) } }, post: { tags: ['主数据'], summary: '新建品类', responses: { 200: jsonResp(null) } } },
    '/api/master/warehouses': {
      get: { tags: ['主数据'], summary: '仓库列表', parameters: [q('keyword', '编码/名称'), q('status', 'active 启用 / inactive 停用'), q('type', '仓库类型')], responses: { 200: jsonResp(null) } },
      post: { tags: ['主数据'], summary: '新建仓库（type 必须来自 /meta/dict 的 warehouse_types）', responses: { 200: jsonResp(null) } }
    },
    '/api/master/warehouses/{id}': {
      get: { tags: ['主数据'], summary: '仓库详情', parameters: [idParam], responses: { 200: jsonResp(null) } },
      put: { tags: ['主数据'], summary: '修改仓库（编码不可改；停用=status 改 inactive）', parameters: [idParam], responses: { 200: jsonResp(null) } },
      delete: { tags: ['主数据'], summary: '仓库禁止删除（409 + WAREHOUSE_NO_DELETE，请改为停用）', parameters: [idParam], responses: { 200: jsonResp(null) } }
    },
    '/api/master/stores': { get: { tags: ['主数据'], summary: '门店列表', responses: { 200: jsonResp(null) } }, post: { tags: ['主数据'], summary: '新建门店', responses: { 200: jsonResp(null) } } },
    // 出入库单据类型：客户可维护的主数据（模块 03 × 27）
    '/api/master/inv-txn-types': {
      get: {
        tags: ['主数据'],
        summary: '出入库单据类型列表',
        parameters: [
          q('keyword', '编码 / 名称'),
          q('status', 'active 启用 / inactive 停用'),
          q('direction', 'in 入库 / out 出库'),
          q('saleable_only', '1 = 只看受「可售性闸门」约束的类型')
        ],
        responses: { 200: jsonResp(null) }
      },
      post: { tags: ['主数据'], summary: '新建出入库单据类型（编码与方向建成后不可改）', responses: { 200: jsonResp(null) } }
    },
    '/api/master/inv-txn-types/{code}': {
      put: {
        tags: ['主数据'],
        summary: '修改出入库单据类型（改名 / 停用 / 是否受闸门约束 / 财务核算科目；编码与方向不可改）',
        parameters: [p('code', '类型编码')],
        responses: { 200: jsonResp(null) }
      },
      delete: {
        tags: ['主数据'],
        summary: '出入库类型禁止删除（409 + INV_TYPE_NO_DELETE，请改为停用）',
        parameters: [p('code', '类型编码')],
        responses: { 200: jsonResp(null) }
      }
    },
    '/api/master/suppliers': { get: { tags: ['主数据'], summary: '供应商列表', responses: { 200: jsonResp(null) } }, post: { tags: ['主数据'], summary: '新建供应商', responses: { 200: jsonResp(null) } } },
    '/api/master/dealers': { get: { tags: ['主数据'], summary: '经销商列表', responses: { 200: jsonResp(null) } }, post: { tags: ['主数据'], summary: '新建经销商', responses: { 200: jsonResp(null) } } },
    '/api/master/platforms': { get: { tags: ['主数据'], summary: '线上平台/店铺列表', responses: { 200: jsonResp(null) } }, post: { tags: ['主数据'], summary: '新建平台店铺', responses: { 200: jsonResp(null) } } },

    '/api/purchase/orders': {
      get: { tags: ['采购'], summary: '采购订单列表', parameters: [q('status', '状态'), q('supplier_id', '供应商'), q('startDate', '开始日期'), q('endDate', '结束日期'), q('keyword', '单号/供应商')], responses: { 200: jsonResp(null) } },
      post: { tags: ['采购'], summary: '新建采购订单', requestBody: body('PurchaseOrderCreate'), responses: { 200: jsonResp(null) } }
    },
    '/api/purchase/orders/{id}': { get: { tags: ['采购'], summary: '采购订单详情', parameters: [idParam], responses: { 200: jsonResp(null) } }, put: { tags: ['采购'], summary: '修改草稿订单', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/purchase/orders/{id}/status': { post: { tags: ['采购'], summary: '提交/审批/关闭/取消', parameters: [idParam], requestBody: body('StatusAction'), responses: { 200: jsonResp(null) } } },
    '/api/purchase/orders/{id}/receive': { post: { tags: ['采购'], summary: '收货入库（生成收货单+批次入库）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/purchase/orders/{id}/receive-suggest': { get: { tags: ['采购'], summary: '收货建议（待收数量与效期）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/purchase/receipts': { get: { tags: ['采购'], summary: '收货单列表', responses: { 200: jsonResp(null) } } },
    '/api/purchase/receipts/{id}': { get: { tags: ['采购'], summary: '收货单详情（含批次）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    // 到货单归档（GR inspected → closed）。内核 `ACTIONS.GR` 一直有这条边，但从来没有门 ⇒
    // 库里那些 `closed` 全是造数据造的，界面上关不掉（停在「已质检」关不掉的是 18/21/20 张）。
    // ⚠️ 别把它与 `POST /purchase/inspections/{id}/close` 混为一谈：那是**质检单**（INS）的归档，
    //    到货单（GR）的「已质检」是提交质检结论时由 `lib/qc.js` 自动推进的，与这条不同。
    '/api/purchase/receipts/{id}/close': { post: { tags: ['采购'], summary: '关闭到货单（GR inspected → closed；归档动作，零副作用）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/purchase/returns': { get: { tags: ['采购'], summary: '采购退货列表', responses: { 200: jsonResp(null) } }, post: { tags: ['采购'], summary: '新建采购退货（出库）', responses: { 200: jsonResp(null) } } },
    // 采购退货单（PRT）的两条边，同样是「内核有边、后端无门」——
    // `cancel` 只从 draft 出发（此时那 9 张表一张都没写过 ⇒ 必须零副作用）；
    // `complete` 只从 confirmed 出发（结案）。三库里 3/4/4 张**全部卡在「已确认」**，
    // 这是本批最严重的一条：货退回去了、单子永远不闭合。
    '/api/purchase/returns/{id}/cancel': { post: { tags: ['采购'], summary: '作废采购退货单（PRT draft → cancelled；草稿态零副作用）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/purchase/returns/{id}/complete': { post: { tags: ['采购'], summary: '完成采购退货单（PRT confirmed → completed；结案）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/purchase/stats': { get: { tags: ['采购'], summary: '采购统计（趋势/供应商排行/待办）', responses: { 200: jsonResp(null) } } },

    // —— 模块 07 采购域后段（请购 → 发票 → 三单结算 → 付款核销 + 供货目录）——
    // 与上面「订单/收货/退货」同挂 /api/purchase，Express 先匹配前者、未命中的落到这批。
    '/api/purchase/chain/overview': { get: { tags: ['采购域'], summary: '采购域总览（请购/订单/发票/结算/付款与四段关闭待办）。门：内部主体 + 采购读权限（与 /chain/todos 同一道门）；内容按调用者组织范围过滤，范围为空返回空结果（ADR-0017）；计数 / 金额 / 榜单 / 趋势都按同一集合算', responses: { 200: jsonResp(null), 403: jsonResp(null) } } },
    '/api/purchase/chain/todos': { get: { tags: ['采购域'], summary: '采购域待办（供采购工作台）。门：内部主体 + 采购读权限；内容按调用者组织范围（订单按仓的组织）与动作权限过滤，范围为空返回空列表（ADR-0015）', responses: { 200: jsonResp(null), 403: jsonResp(null) } } },
    '/api/purchase/chain/flow': { get: { tags: ['采购域'], summary: '采购十环节业务流定义（内核 biz_flow_steps；含到货与质检拆分为两张单后的质量检验环节）。门：内部主体 + 采购读权限（与 /chain/todos 同一道门，ADR-0017）', responses: { 200: jsonResp(null), 403: jsonResp(null) } } },
    '/api/purchase/chain/actions': { get: { tags: ['采购域'], summary: '某单据当前可执行动作（供界面渲染按钮）。门：内部主体 + 采购读权限；单据不在调用者组织范围内按不存在处理 404（ADR-0020）', parameters: [q('doc_type', '单据类型 PRQ/PI/PST/PAY/PO/GR', true), q('id', '单据 id', true)], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },

    '/api/purchase/catalog': {
      get: { tags: ['采购域'], summary: '供货目录（供应商-物料对照：是否可供/协议价/起订量/交期）', parameters: [q('supplier_id', '供应商'), q('keyword', '编码/名称'), q('is_available', '是否可供')], responses: { 200: jsonResp(null) } },
      post: { tags: ['采购域'], summary: '维护供货目录（新增/更新协议价与起订量）', responses: { 200: jsonResp(null) } }
    },
    '/api/purchase/price': { get: { tags: ['采购域'], summary: '取价（四档链：协议价→最近成交价→最近订单价→标准成本，带来源标签）', parameters: [q('sku_id', 'SKU', true), q('supplier_id', '供应商'), q('manual_price', '手工录入价')], responses: { 200: jsonResp(null) } } },
    '/api/purchase/price-preview': { post: { tags: ['采购域'], summary: '批量取价预览（下单前看价，不落库）', responses: { 200: jsonResp(null) } } },

    '/api/purchase/requisitions': {
      get: { tags: ['采购域'], summary: '请购单列表。门：内部主体 + 采购读权限（与 /chain/todos 同一道门）；内容按调用者组织范围过滤，范围为空返回空结果（ADR-0017）', parameters: [q('status', '状态'), q('applicant_type', '申请主体类型 org/store/warehouse'), q('keyword', '单号/申请人/部门')], responses: { 200: jsonResp(null), 403: jsonResp(null) } },
      post: { tags: ['采购域'], summary: '新建请购单（未给价的行自动走取价链）', responses: { 200: jsonResp(null) } }
    },
    '/api/purchase/requisitions/{id}': { get: { tags: ['采购域'], summary: '请购单详情（含明细与可转数量）。门：内部主体 + 采购读权限；不在调用者组织范围内按不存在处理 404（ADR-0020）', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/purchase/requisitions/{id}/{action}': { post: { tags: ['采购域'], summary: '请购单流转（submit/approve/reject/cancel/close）。ADR-0031：内部主体 + 组织范围；单据不在调用者范围内按不存在处理（404，不泄漏存在性），在任何写之前判定', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/purchase/requisitions/{id}/convert': { post: { tags: ['采购域'], summary: '请购转采购订单（支持部分转单，受供货目录与起订量硬拦）。ADR-0031：内部主体 + 组织范围；单据不在调用者范围内按不存在处理（404，不泄漏存在性），在任何写之前判定；显式指定的入库仓同样须在范围内', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },

    '/api/purchase/invoices': {
      get: { tags: ['采购域'], summary: '采购发票列表（含费用发票）。门：内部主体 + 采购读权限（与 /chain/todos 同一道门）；内容按调用者组织范围过滤，范围为空返回空结果（ADR-0017），summary 合计同口径', parameters: [q('status', '状态'), q('supplier_id', '供应商'), q('invoice_type', '发票类型')], responses: { 200: jsonResp(null), 403: jsonResp(null) } },
      post: { tags: ['采购域'], summary: '录入采购发票（票号重复会被拒）', responses: { 200: jsonResp(null) } }
    },
    '/api/purchase/invoices/{id}': { get: { tags: ['采购域'], summary: '发票详情（含三单匹配结果）。门：内部主体 + 采购读权限；不在调用者组织范围内按不存在处理 404（ADR-0020）', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/purchase/invoices/{id}/{action}': { post: { tags: ['采购域'], summary: '发票流转（submit/verify/post/void）；校验时发票量不得超入库量。ADR-0031：内部主体 + 组织范围；单据不在调用者范围内按不存在处理（404，不泄漏存在性），在任何写之前判定', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/purchase/invoices-available-lines': { get: { tags: ['采购域'], summary: '可开票的入库行（已入库未开票）。门：内部主体 + 采购读权限；入库按调用者组织范围汇总（ADR-0020）', parameters: [q('supplier_id', '供应商')], responses: { 200: jsonResp(null), 403: jsonResp(null) } } },

    '/api/purchase/settlements': {
      get: { tags: ['采购域'], summary: '采购结算单列表（三单匹配结果）。门：内部主体 + 采购读权限（与 /chain/todos 同一道门）；内容按调用者组织范围过滤，范围为空返回空结果（ADR-0017），summary 合计同口径', parameters: [q('status', '状态'), q('supplier_id', '供应商')], responses: { 200: jsonResp(null), 403: jsonResp(null) } },
      post: { tags: ['采购域'], summary: '生成结算单（settle_mode: auto 按票 / manual 按入库暂估 / fee 含费用发票）', responses: { 200: jsonResp(null) } }
    },
    '/api/purchase/settlements/{id}': { get: { tags: ['采购域'], summary: '结算单详情（已生效核销 / 未生效计划 / 未结清金额分列）。门：内部主体 + 采购读权限；不在调用者组织范围内按不存在处理 404（ADR-0020）', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/purchase/settlements/{id}/{action}': { post: { tags: ['采购域'], summary: '结算单流转（submit/audit/settle/void）。ADR-0031：内部主体 + 组织范围；单据不在调用者范围内按不存在处理（404，不泄漏存在性），在任何写之前判定', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/purchase/settlement-preview': { get: { tags: ['采购域'], summary: '结算预览（先看金额与差异，不落库）。门：内部主体 + 采购读权限；入库与发票按调用者组织范围汇总（ADR-0020）', responses: { 200: jsonResp(null), 403: jsonResp(null) } } },

    '/api/purchase/payments': {
      get: { tags: ['采购域'], summary: '付款单列表。门：内部主体 + 采购读权限（与 /chain/todos 同一道门）；内容按调用者组织范围过滤，范围为空返回空结果（ADR-0017），summary 合计同口径', parameters: [q('status', '状态'), q('supplier_id', '供应商')], responses: { 200: jsonResp(null), 403: jsonResp(null) } },
      post: { tags: ['采购域'], summary: '新建付款单（不传核销分配则按 FIFO 自动核销）', responses: { 200: jsonResp(null) } }
    },
    '/api/purchase/payments/{id}': { get: { tags: ['采购域'], summary: '付款单详情（含核销明细）。门：内部主体 + 采购读权限；不在调用者组织范围内按不存在处理 404（ADR-0020）', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/purchase/payments/{id}/review': { post: { tags: ['采购域'], summary: '付款执行的第二人复核（ADR-0018，需 finance.funds.review）：approve 在同一事务里执行 pay（核销 + 已付）+ 严格审计；reject 退回已审批并记原因。发起人自审 409 FUNDS_SELF_REVIEW；不在待复核 409 FUNDS_NOT_PENDING。响应含 review 块。ADR-0031：内部主体 + 组织范围；单据不在调用者范围内按不存在处理（404，不泄漏存在性），在任何写之前判定', parameters: [idParam], requestBody: body('FundsReview'), responses: { 200: jsonResp(null), 400: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/purchase/payments/{id}/{action}': { post: { tags: ['采购域'], summary: '付款单流转（submit 核销生效 / pay 执行付款 / void 作废并回退已付）。pay 过证据闸与二人复核（ADR-0018）：必须带 evidence_ref（funds_evidence_required，缺失 400 FUNDS_EVIDENCE_REQUIRED）；金额 ≥ funds_review_threshold 且 funds_review_required 时只挂待复核（review.status=pending_review，结算单不动），否则直接执行；待复核期间任何动作 409 FUNDS_REVIEW_PENDING。响应为付款单行 + review 块。ADR-0031：内部主体 + 组织范围；单据不在调用者范围内按不存在处理（404），在任何写之前判定', parameters: [idParam], requestBody: { required: false, description: 'pay 时的证据；其它动作可空', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentAction' } } } }, responses: { 200: jsonResp(null), 400: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/purchase/payment-plan': { get: { tags: ['采购域'], summary: 'FIFO 核销计划预览（按结算日期先老后新）。门：内部主体 + 采购读权限；只列并只核销调用者组织范围内的结算单（ADR-0020）', parameters: [q('supplier_id', '供应商', true), q('amount', '付款金额', true)], responses: { 200: jsonResp(null), 403: jsonResp(null) } } },

    '/api/purchase/payables': { get: { tags: ['采购域'], summary: '应付账款（按供应商：已结算/已付/未付）+ **采购退货披露**。⚠️ 退货金额放在单独的 `returns` 块里、**不参与** settle/paid/open 口径 —— 结算怎么抵减退货是业务规则（按单抵 / 按期间抵 / 已审是否追溯），不是实现细节。门：内部主体 + 采购读权限（与 /chain/todos 同一道门）；内容按调用者组织范围过滤，范围为空返回空结果（ADR-0017）；退货披露经仓的组织过滤', parameters: [q('supplier_id', '供应商')], responses: { 200: jsonResp(null), 403: jsonResp(null) } } },
    '/api/purchase/orders/{id}/closes': { get: { tags: ['采购域'], summary: '采购订单四段关闭（到货/入库/开票/付款，只进不退）。门：内部主体 + 采购读权限；不在调用者组织范围内按不存在处理 404（ADR-0020）', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/purchase/orders/{id}/receive-check': { post: { tags: ['采购域'], summary: '收货前超量校验（写库前拦，非事后回滚）。ADR-0031：内部主体 + 组织范围；单据不在调用者范围内按不存在处理（404，不泄漏存在性），在任何写之前判定', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/purchase/supplier-last-price': { post: { tags: ['采购域'], summary: '供应商最近成交价（收货回写的数据来源）', responses: { 200: jsonResp(null) } } },

    // —— 质检（模块 07：到货单记事实、质检单记判断，两单分开）——
    '/api/purchase/inspections/meta': { get: { tags: ['质检'], summary: '质检枚举（结论 / 不合格原因码）', responses: { 200: jsonResp(null) } } },
    '/api/purchase/inspections/overview': { get: { tags: ['质检'], summary: '质检概览（待质检 / 判退数量金额 / 判退率 / 已生成退货单）', responses: { 200: jsonResp(null) } } },
    '/api/purchase/inspections/pending': { get: { tags: ['质检'], summary: '待质检的到货单（含已建草稿的，带 draft_id/draft_no）', parameters: [q('limit', '返回条数，默认 50')], responses: { 200: jsonResp(null) } } },
    '/api/purchase/inspections/receipt/{receiptId}': { get: { tags: ['质检'], summary: '按到货单装填质检数据（到货行 + 已有草稿），前端一屏填完', parameters: [{ name: 'receiptId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: jsonResp(null) } } },
    '/api/purchase/inspections': {
      get: { tags: ['质检'], summary: '质检单列表（状态/结论/供应商/到货单过滤）', parameters: [q('status', '状态'), q('result', '结论'), q('supplier_id', '供应商'), q('receipt_id', '到货单')], responses: { 200: jsonResp(null) } },
      post: { tags: ['质检'], summary: '从到货单新建质检单（默认全部合格；行级三数必须闭合）', requestBody: body('InspectionCreate'), responses: { 200: jsonResp(null) } }
    },
    '/api/purchase/inspections/{id}': { get: { tags: ['质检'], summary: '质检单详情（行级合格/让步/判退 + 流转留痕）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/purchase/inspections/{id}/submit': { post: { tags: ['质检'], summary: '提交质检结论：判退部分自动生成采购退货单并反向出库', parameters: [idParam], requestBody: body('InspectionSubmit'), responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/purchase/inspections/{id}/close': { post: { tags: ['质检'], summary: '归档质检单（不产生业务后果）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/purchase/inspections/{id}/cancel': { post: { tags: ['质检'], summary: '作废质检单（作废后可对同票重开）', parameters: [idParam], responses: { 200: jsonResp(null) } } },

    '/api/sales/orders': {
      get: { tags: ['销售'], summary: '销售订单列表（支持渠道/状态/日期/关键字；内部账号按组织数据范围过滤，ADR-0026）', parameters: [q('channel', '渠道 dealer/store/online/platform/live'), q('status', '状态'), q('startDate', '开始日期'), q('endDate', '结束日期'), q('keyword', '关键字')], responses: { 200: jsonResp(null) } },
      post: { tags: ['销售'], summary: '新建销售订单（自动按渠道与经销商折扣取价；出货仓与门店须在调用者组织范围内，否则 403）', requestBody: body('SalesOrderCreate'), responses: { 200: jsonResp(null), 403: jsonResp(null) } }
    },
    '/api/sales/orders/{id}': { get: { tags: ['销售'], summary: '销售订单详情（组织范围外 404，与不存在同形）', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } }, put: { tags: ['销售'], summary: '修改草稿订单（组织范围外 404；改仓目标不在范围内 403）', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/sales/orders/{id}/confirm': { post: { tags: ['销售'], summary: '确认订单并占用库存（库存不足会拒绝；组织范围外 404）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/sales/orders/{id}/deliver': { post: { tags: ['销售'], summary: '发货出库（批次先进先出；组织范围外 404，发货仓不在范围内 403）', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/sales/orders/{id}/payment': { post: { tags: ['销售'], summary: '登记回款（组织范围外 404）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/sales/orders/{id}/cancel': { post: { tags: ['销售'], summary: '取消订单并释放占用（组织范围外 404）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/sales/orders/{id}/complete': { post: { tags: ['销售'], summary: '完成订单（签收结案；组织范围外 404）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/sales/deliveries': { get: { tags: ['销售'], summary: '发货单列表（内部账号按所属订单的组织范围过滤）', responses: { 200: jsonResp(null) } } },
    '/api/sales/deliveries/{id}': { get: { tags: ['销售'], summary: '发货单详情（组织范围外 404）', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/sales/deliveries/{id}/receive': { post: { tags: ['销售'], summary: '发货单签收（已发货 → 已签收；状态不对返回 409；组织范围外 404）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/sales/returns': { get: { tags: ['销售'], summary: '销售退货列表（内部账号按来源订单 / 自身仓与门店的组织范围过滤）', responses: { 200: jsonResp(null) } }, post: { tags: ['销售'], summary: '新建销售退货（入库；来源订单范围外 404，入库仓 / 门店不在范围内 403）', responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/sales/returns/{id}/complete': { post: { tags: ['销售'], summary: '退货完成（已确认 → 已完成；状态不对返回 409；组织范围外 404）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/sales/stats': { get: { tags: ['销售'], summary: '销售分析（渠道/趋势/商品/经销商/门店排行；内部账号只含组织范围内订单）', parameters: [q('days', '统计天数，默认 30')], responses: { 200: jsonResp(null) } } },

    '/api/inventory/stocks': { get: { tags: ['存货'], summary: '库存明细（仓库/批次/效期/可用量）', parameters: [q('warehouse_id', '仓库'), q('sku_id', 'SKU'), q('batch_no', '批次'), q('keyword', '关键字'), q('expiring', 'N 天内临期'), q('pageSize', '每页条数，默认 50，上限 500'), q('after_id', '游标：上一页最后一行 id（按 id 升序；total/summary 仅首页返回）')], responses: { 200: jsonResp(null) } } },
    '/api/inventory/stocks/by-sku': { get: { tags: ['存货'], summary: '按 SKU 汇总库存（跨仓库）', responses: { 200: jsonResp(null) } } },
    '/api/inventory/transactions': { get: { tags: ['存货'], summary: '库存流水（收发明细）', parameters: [q('sku_id', 'SKU'), q('warehouse_id', '仓库'), q('doc_type', '单据类型'), q('startDate', '开始日期'), q('endDate', '结束日期')], responses: { 200: jsonResp(null) } } },
    '/api/inventory/ledger': { get: { tags: ['存货'], summary: '收发存台账（期初/入库/出库/期末）', parameters: [q('sku_id', 'SKU（必填）', true), q('warehouse_id', '仓库'), q('startDate', '开始日期'), q('endDate', '结束日期')], responses: { 200: jsonResp(null) } } },
    '/api/inventory/alerts': { get: { tags: ['存货'], summary: '库存预警（低于安全库存/临期/呆滞/零库存）', responses: { 200: jsonResp(null) } } },
    '/api/inventory/adjust': { post: { tags: ['存货'], summary: '库存手工调整（盘盈/盘亏）', responses: { 200: jsonResp(null) } } },
    '/api/inventory/transfers': { get: { tags: ['存货'], summary: '调拨单列表', responses: { 200: jsonResp(null) } }, post: { tags: ['存货'], summary: '新建调拨单', responses: { 200: jsonResp(null) } } },
    '/api/inventory/transfers/{id}': { get: { tags: ['存货'], summary: '调拨单详情', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/inventory/transfers/{id}/ship': { post: { tags: ['存货'], summary: '调拨出库', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/inventory/transfers/{id}/receive': { post: { tags: ['存货'], summary: '调拨入库', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    // 调拨单（TF）的两条边，本批新开门。
    // `submit`：draft → submitted，**纯状态、不动库存**；它让「草稿 → 已提交 → 已出库」可选两步走，
    //   而出库仍允许从 draft 直接走（`/ship` 的 draft 出边保留）—— 两条路都通，不是互斥。
    // `cancel`：**一个路由管两条边**（draft→cancelled 与 submitted→cancelled），
    //   由内核按当前状态选边；路由里**不写**状态白名单（写第二份判据必然与内核分叉）。
    '/api/inventory/transfers/{id}/submit': { post: { tags: ['存货'], summary: '提交调拨单（TF draft → submitted；纯状态，不动库存）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/inventory/transfers/{id}/cancel': { post: { tags: ['存货'], summary: '作废调拨单（TF draft / submitted → cancelled；出库前作废，零副作用）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/inventory/checks': { get: { tags: ['存货'], summary: '盘点单列表', responses: { 200: jsonResp(null) } }, post: { tags: ['存货'], summary: '生成盘点单（拉取账面数）', responses: { 200: jsonResp(null) } } },
    '/api/inventory/checks/{id}': { get: { tags: ['存货'], summary: '盘点单详情', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/inventory/checks/{id}/items': { put: { tags: ['存货'], summary: '提交实盘数量', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/inventory/checks/{id}/adjust': { post: { tags: ['存货'], summary: '差异过账（生成盘盈/盘亏）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    // 盘点单作废（CK draft → cancelled）。内核有边、后端无门 ⇒ 建了盘点单不想盘了就取消不掉。
    // 只从 draft 出发（`checking` 之后没有出边）⇒ 已开始的盘点必须走完 `adjust`，不能半途作废。
    '/api/inventory/checks/{id}/cancel': { post: { tags: ['存货'], summary: '作废盘点单（CK draft → cancelled；草稿态零副作用）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/inventory/stats': { get: { tags: ['存货'], summary: '库存总览（仓库/品类分布、出入库趋势）', responses: { 200: jsonResp(null) } } },

    '/api/dealers/overview': { get: { tags: ['经销商'], summary: '经销商总览（等级/区域/排行/信用预警）', parameters: [q('days', '统计天数')], responses: { 200: jsonResp(null) } } },
    '/api/dealers/{id}/profile': { get: { tags: ['经销商'], summary: '经销商画像（销售/回款/商品结构/返利/对账）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/dealers/{id}/purchase-analysis': { get: { tags: ['经销商'], summary: '经销商进货结构分析', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/dealers/{id}/credit': { post: { tags: ['经销商'], summary: '维护信用额度/等级/政策', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/dealers/rebates': { get: { tags: ['经销商'], summary: '返利记录列表', parameters: [q('dealer_id', '经销商'), q('period', '期间 YYYY-MM'), q('status', '状态')], responses: { 200: jsonResp(null) } } },
    '/api/dealers/rebates/calc': { post: { tags: ['经销商'], summary: '按期间核算返利（阶梯点位）', responses: { 200: jsonResp(null) } } },
    '/api/dealers/rebates/{id}': { put: { tags: ['经销商'], summary: '确认/调整返利', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/dealers/statements': { get: { tags: ['经销商'], summary: '对账单列表', responses: { 200: jsonResp(null) } }, post: { tags: ['经销商'], summary: '生成对账单', responses: { 200: jsonResp(null) } } },
    '/api/dealers/statements/{id}': { get: { tags: ['经销商'], summary: '对账单详情（含订单与退货明细）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/dealers/statements/{id}/status': { post: { tags: ['经销商'], summary: '对账单状态流转（确认/发送）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    // 终局动作两条。summary 里刻意把**校验**与**副作用边界**都写出来：
    //   · close 必须"同主体同期间应收已收齐"，否则 409；force=true 才允许手动结清且必须写理由；
    //   · void **只作废这份对账单凭证，不动底层应收台账**（债权照旧挂在应收上、照旧计账龄）。
    // 不写清边界的话，下一个读到契约的人会把"作废对账单"实现成"作废整条债权"。
    '/api/dealers/statements/{id}/close': { post: { tags: ['经销商'], summary: '结清对账单（须同主体同期间应收已收齐；force 手动结清须写理由）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/dealers/statements/{id}/void': { post: { tags: ['经销商'], summary: '作废对账单（只作废本凭证，不动底层应收台账；须写理由）', parameters: [idParam], responses: { 200: jsonResp(null) } } },

    '/api/oms/platforms': { get: { tags: ['线上 OMS'], summary: '平台店铺列表（含订单数/GMV/最近同步）；受限范围只列履约仓归属组织在范围内的平台（ADR-0039）', responses: { 200: jsonResp(null) } } },
    '/api/qimen/platforms/{id}/secret': { post: { tags: ['线上 OMS'], summary: '签发/轮换奇门平台密钥（oms.platform.manage；明文仅此一次返回；已有密钥需 rotate:true，ADR-0033）', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/oms/sync/{platformId}': { post: { tags: ['线上 OMS'], summary: '从平台拉取订单（演示为模拟数据源；生产 503）。订单归平台绑定组织（履约仓所属组织）：平台未绑定 422 PLATFORM_ORG_UNBOUND，履约仓不在调用者组织范围内 403', parameters: [{ name: 'platformId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null), 422: jsonResp(null) } } },
    '/api/oms/orders': { get: { tags: ['线上 OMS'], summary: '线上订单列表；按平台绑定组织（履约仓所属组织）过滤，未绑定平台的订单仅全局范围可见（ADR-0039）', parameters: [q('platform_id', '平台'), q('status', '状态'), q('pending', '=1 只看待发货'), q('startDate', '开始日期'), q('endDate', '结束日期'), q('keyword', '关键字')], responses: { 200: jsonResp(null) } } },
    '/api/oms/orders/{id}': { get: { tags: ['线上 OMS'], summary: '线上订单详情；范围外与不存在同形 404（ADR-0039）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/oms/orders/{id}/convert': { post: { tags: ['线上 OMS'], summary: '线上订单转销售订单（占库）；销售订单归平台绑定组织的履约仓，平台未绑定 422，平台范围外 404', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 422: jsonResp(null) } } },
    '/api/oms/orders/convert-batch': { post: { tags: ['线上 OMS'], summary: '批量转单（逐单同上：范围外按「订单不存在」、未绑定平台按原因计入 failed）', responses: { 200: jsonResp(null) } } },
    '/api/oms/orders/{id}/ship': { post: { tags: ['线上 OMS'], summary: '发货并回传平台（同时出库）；订单须在平台绑定组织范围内（范围外 404），关联销售订单的出货仓须在范围内（403，ADR-0042）', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/oms/orders/{id}/refund': { post: { tags: ['线上 OMS'], summary: '退款处理（释放占用）；范围口径同发货（范围外 404、出货仓越界 403，ADR-0042）', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    // 线上订单完成（OM shipped → completed）。平台侧早就完成了，系统里一直显示「已发货」
    // （三库停在 shipped 的 88/64/93 张）⇒ 看不出哪些真的结了。
    // ⚠️ `OM` 内核里**没有 `closed` 状态**（`STATES.OM` = pending/shipped/completed/refunded/cancelled），
    //    别照 `meta.js` 里那条历史遗留的 `closed` 文案去写这个动作。
    '/api/oms/orders/{id}/complete': { post: { tags: ['线上 OMS'], summary: '完成线上订单（OM shipped → completed；纯状态，不动库存）；订单须在平台绑定组织范围内，范围外 404（ADR-0042）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/oms/stock-push': { post: { tags: ['线上 OMS'], summary: '推送可售库存至平台；只推范围内平台、库存合计只含范围内仓，指定平台在范围外 404（ADR-0042）', responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/oms/sync-logs': { get: { tags: ['线上 OMS'], summary: '同步日志；只含范围内平台（ADR-0039）', parameters: [q('platform_id', '平台'), q('sync_type', '类型 order/stock/shipment/refund/price')], responses: { 200: jsonResp(null) } } },
    '/api/oms/stats': { get: { tags: ['线上 OMS'], summary: '线上经营分析（平台 GMV/趋势/热销）；只统计范围内平台（ADR-0039）', parameters: [q('days', '统计天数')], responses: { 200: jsonResp(null) } } },

    '/api/dashboard/summary': { get: { tags: ['看板'], summary: '经营 KPI 总览', responses: { 200: jsonResp(null) } } },
    '/api/dashboard/trend': { get: { tags: ['看板'], summary: '销售/采购/线上趋势', parameters: [q('days', '统计天数')], responses: { 200: jsonResp(null) } } },
    '/api/dashboard/channel': { get: { tags: ['看板'], summary: '渠道结构', parameters: [q('days', '统计天数')], responses: { 200: jsonResp(null) } } },
    '/api/dashboard/todos': { get: { tags: ['看板'], summary: '待办事项（待发货/待收货/待转单/库存预警/临期）', responses: { 200: jsonResp(null) } } },
    '/api/dashboard/top': { get: { tags: ['看板'], summary: '排行榜（商品/品牌/经销商/门店）', parameters: [q('days', '统计天数')], responses: { 200: jsonResp(null) } } },
    '/api/dashboard/recent': { get: { tags: ['看板'], summary: '最近单据流', responses: { 200: jsonResp(null) } } },
    '/api/dashboard/inventory-dist': { get: { tags: ['看板'], summary: '库存分布（仓库/品类）', responses: { 200: jsonResp(null) } } },

    '/api/requisitions/store': {
      get: { tags: ['门店要货'], summary: '总部：门店要货单列表', parameters: [q('status', '状态'), q('store_id', '门店')], responses: { 200: jsonResp(null) } },
      post: { tags: ['门店要货'], summary: '门店：提交要货申请', responses: { 200: jsonResp(null) } }
    },
    '/api/requisitions/store/mine': { get: { tags: ['门店要货'], summary: '门店：查看本店要货单', responses: { 200: jsonResp(null) } } },
    '/api/requisitions/store/board': { get: { tags: ['门店要货'], summary: '总部：要货看板（总数/待受理/在营门店/最新要货）', responses: { 200: jsonResp(null) } } },
    '/api/requisitions/store/{id}': { get: { tags: ['门店要货'], summary: '要货单明细（含总部可用量、门店实时库存、已发/待发数量）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/requisitions/store/{id}/status': { post: { tags: ['门店要货'], summary: '受理 / 驳回 / 完成', parameters: [idParam], requestBody: body('StatusAction'), responses: { 200: jsonResp(null) } } },
    '/api/requisitions/store/{id}/to-purchase': { post: { tags: ['门店要货'], summary: '转采购（总部入库 hq / 直运门店仓 direct）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/requisitions/store/{id}/to-transfer': { post: { tags: ['门店要货'], summary: '中心仓配货调拨至门店仓', parameters: [idParam], responses: { 200: jsonResp(null) } } },

    '/api/requisitions/shipments': {
      get: { tags: ['门店要货'], summary: '总部：门店发货单列表（含 draft/shipped/partial/received 汇总）', parameters: [q('status', '状态'), q('store_id', '门店')], responses: { 200: jsonResp(null) } },
      post: { tags: ['门店要货'], summary: '总部：参考要货单生成发货单（勾选行 + 可改发货数量）', responses: { 200: jsonResp(null) } }
    },
    '/api/requisitions/shipments/{id}': { get: { tags: ['门店要货'], summary: '发货单明细（含批次明细与各行收货状态）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/requisitions/shipments/{id}/ship': { post: { tags: ['门店要货'], summary: '确认发货：发货仓 FIFO 出库（SHP_OUT）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/requisitions/shipments/{id}/cancel': { post: { tags: ['门店要货'], summary: '取消发货单（仅待发货）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/requisitions/store/shipments/mine': { get: { tags: ['门店要货'], summary: '门店：待收货发货单与收货历史', responses: { 200: jsonResp(null) } } },
    '/api/requisitions/store/shipments/{id}': { get: { tags: ['门店要货'], summary: '门店：查看本店发货单明细', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/requisitions/store/shipments/{id}/receive': { post: { tags: ['门店要货'], summary: '门店：选择性收货（可只收部分行 / 短收，自动登记差异）', parameters: [idParam], responses: { 200: jsonResp(null) } } },

    '/api/outsourcing/orders': {
      get: { tags: ['委外管理'], summary: '委外订单列表', parameters: [q('status', '状态'), q('supplier_id', '加工商')], responses: { 200: jsonResp(null) } },
      post: { tags: ['委外管理'], summary: '新建委外订单（成品行 + 材料行）', responses: { 200: jsonResp(null) } }
    },
    '/api/outsourcing/orders/{id}': { get: { tags: ['委外管理'], summary: '委外订单详情', parameters: [idParam], responses: { 200: jsonResp(null) } }, put: { tags: ['委外管理'], summary: '修改委外订单', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/outsourcing/orders/{id}/status': { post: { tags: ['委外管理'], summary: '提交 / 审批 / 关闭 / 取消', parameters: [idParam], requestBody: body('StatusAction'), responses: { 200: jsonResp(null) } } },
    '/api/outsourcing/orders/{id}/issue': { post: { tags: ['委外管理'], summary: '委外发料（材料 FIFO 出库，WWS_OUT）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/outsourcing/orders/{id}/receive': { post: { tags: ['委外管理'], summary: '委外收货（成品入库，WWS_IN）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/outsourcing/materials': { get: { tags: ['委外管理'], summary: '委外发料单列表', responses: { 200: jsonResp(null) } } },
    '/api/outsourcing/receipts': { get: { tags: ['委外管理'], summary: '委外收货单列表', responses: { 200: jsonResp(null) } } },
    // 委外收货单质检（WR received → inspected）。收货单是 `POST /outsourcing/orders/:id/receive` 建的，
    // 建单即 `received`，而 **inspect 从来没有门** ⇒ 委外加工回来的货质检不了（三库 2/0/2 张卡着）。
    // 本轮只做「入口 + 真实留痕」：可选 body `{ inspector, remark }` 记进 payload；
    // **不新增库存副作用**（入库那一步 `WR.receive` 已经动过库存，再动就是把货记两遍）。
    '/api/outsourcing/receipts/{id}/inspect': { post: { tags: ['委外管理'], summary: '委外收货单质检（WR received → inspected；不动库存）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/outsourcing/settlements': { get: { tags: ['委外管理'], summary: '委外结算（按加工商 × 期间汇总加工费）', responses: { 200: jsonResp(null) } } },
    '/api/outsourcing/stats': { get: { tags: ['委外管理'], summary: '委外统计', responses: { 200: jsonResp(null) } } },

    '/api/demand/dealer/requisitions': {
      get: { tags: ['计划与生产'], summary: '总部：经销商要货申请列表', responses: { 200: jsonResp(null) } },
      post: { tags: ['计划与生产'], summary: '经销商：提交要货申请', responses: { 200: jsonResp(null) } }
    },
    '/api/demand/dealer/requisitions/mine': { get: { tags: ['计划与生产'], summary: '经销商：本单位的要货申请', responses: { 200: jsonResp(null) } } },
    '/api/demand/dealer/requisitions/{id}': { get: { tags: ['计划与生产'], summary: '要货申请明细', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/demand/dealer/requisitions/{id}/status': { post: { tags: ['计划与生产'], summary: '提交 / 审批 / 驳回 / 转单', parameters: [idParam], requestBody: body('StatusAction'), responses: { 200: jsonResp(null) } } },
    '/api/demand/dealer/plans': { get: { tags: ['计划与生产'], summary: '总部：按期间汇总的经销商要货计划', parameters: [q('period', '期间 YYYY-MM')], responses: { 200: jsonResp(null) } }, post: { tags: ['计划与生产'], summary: '经销商：上报要货计划（期间 + SKU）', responses: { 200: jsonResp(null) } } },
    '/api/demand/dealer/plans/mine': { get: { tags: ['计划与生产'], summary: '经销商：本单位的要货计划', responses: { 200: jsonResp(null) } } },
    '/api/demand/dealer/summary': {
      post: {
        tags: ['计划与生产'], summary: '净需求汇总（时间段 + 库存对比仓 → 净需求，不落库）',
        requestBody: body('DemandSummary'), responses: { 200: jsonResp(null, '按 SKU 的净需求与分流建议') }
      }
    },
    '/api/demand/dealer/summary/to-orders': { post: { tags: ['计划与生产'], summary: '净需求 → 生成采购 / 生产 / 委外订单', responses: { 200: jsonResp(null) } } },
    '/api/demand/dealer/summary/runs': { get: { tags: ['计划与生产'], summary: '净需求汇总运行记录', responses: { 200: jsonResp(null) } } },
    '/api/demand/production/orders': {
      get: { tags: ['计划与生产'], summary: '生产订单列表', parameters: [q('status', '状态')], responses: { 200: jsonResp(null) } },
      post: { tags: ['计划与生产'], summary: '新建生产订单', responses: { 200: jsonResp(null) } }
    },
    '/api/demand/production/orders/{id}': { get: { tags: ['计划与生产'], summary: '生产订单详情', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/demand/production/orders/{id}/status': { post: { tags: ['计划与生产'], summary: '提交 / 审批 / 开工 / 完工', parameters: [idParam], requestBody: body('StatusAction'), responses: { 200: jsonResp(null) } } },

    '/api/ai/manifest': { get: { tags: ['AI 承接'], summary: 'AI 能力清单（模块/意图/示例问题/数据字典入口）', security: [], responses: { 200: jsonResp(null) } } },
    '/api/ai/metrics': { get: { tags: ['AI 承接'], summary: '指标口径定义', security: [], responses: { 200: jsonResp(null) } } },
    '/api/ai/query': { post: { tags: ['AI 承接'], summary: '结构化语义查询（AI 主要调用入口）', requestBody: body('AiQuery'), responses: { 200: jsonResp(null) } } },
    '/api/ai/schema': { get: { tags: ['AI 承接'], summary: '数据库表结构与字段（供 AI 理解模型）', responses: { 200: jsonResp(null) } } },
    '/api/ai/logs': { get: { tags: ['AI 承接'], summary: 'AI 查询日志', responses: { 200: jsonResp(null) } } },

    // —— 模块 06 编码规则（试取号与规则维护）——
    '/api/docflow/no-rules': {
      get: { tags: ['系统'], summary: '单据编号规则列表', parameters: [q('doc_type', '单据类型')], responses: { 200: jsonResp(null) } },
      post: { tags: ['系统'], summary: '新建 / 修改编号规则（段可配：常量/日期/SKU/流水）', responses: { 200: jsonResp(null) } }
    },
    '/api/docflow/no-preview': { post: { tags: ['系统'], summary: '试取号（不占用计数器，改公式前先验证）', responses: { 200: jsonResp(null) } } },
    '/api/docflow/no-issue': { post: { tags: ['系统'], summary: '正式取号（占用计数器）；非干跑需该单据类型的创建权限，未映射类型 403 DOC_TYPE_PERM_UNMAPPED（ADR-0028）', responses: { 200: jsonResp(null), 403: jsonResp(null) } } },

    '/api/master/bundles': {
      get: { tags: ['主数据'], summary: '组合装（捆绑商品）列表', responses: { 200: jsonResp(null) } },
      post: { tags: ['主数据'], summary: '新建组合装', responses: { 200: jsonResp(null) } }
    },
    '/api/master/bundles/{id}': {
      get: { tags: ['主数据'], summary: '组合装详情（含组件明细与最近组装记录）', parameters: [idParam], responses: { 200: jsonResp(null) } },
      put: { tags: ['主数据'], summary: '修改组合装', parameters: [idParam], responses: { 200: jsonResp(null) } }
    },
    '/api/master/scan': { get: { tags: ['主数据'], summary: '扫码解析（条码 → SKU）', parameters: [q('code', '条码', true)], responses: { 200: jsonResp(null) } } },

    // 门店 POS 的路径统一在下面的「门店 POS（模块 17）」段里声明。
    // 这里原来另有一份 tag 为「看板」的旧副本（context/products/stocks/orders/…/hq/*），
    // 与后面那一段**同名键重复** ⇒ 后者覆盖前者，旧副本的 summary/parameters 一直是死文本，已删。
    // 教训：本文件是一个巨大的对象字面量，同一路径写两遍时**没有语法错、只有一句静默失效的声明**。

    // —— 模块 12A 订货中心 ——
    '/api/order-center/customers/{id}': { get: { tags: ['门店要货'], summary: '订货客户详情（含信用与协议价）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/order-center/customers/{id}/admit': { post: { tags: ['门店要货'], summary: '准入 / 取消准入订货客户', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/order-center/orders': {
      get: { tags: ['门店要货'], summary: '订货单列表', parameters: [q('status', '状态'), q('customer_id', '订货客户'), q('page', '页码'), q('pageSize', '每页条数')], responses: { 200: jsonResp(null) } },
      post: { tags: ['门店要货'], summary: '新建订货单（门店要货与经销商订货统一入口）', responses: { 200: jsonResp(null) } }
    },
    '/api/order-center/orders/{id}': { get: { tags: ['门店要货'], summary: '订货单详情', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/order-center/orders/{id}/{action}': { post: { tags: ['门店要货'], summary: '订货单流转（提交/受理/发货/收货/关闭 等）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/order-center/statements': {
      get: { tags: ['门店要货'], summary: '订货对账单列表', parameters: [q('page', '页码'), q('pageSize', '每页条数')], responses: { 200: jsonResp(null) } },
      post: { tags: ['门店要货'], summary: '生成订货对账单', responses: { 200: jsonResp(null) } }
    },
    '/api/order-center/statements/{id}': { get: { tags: ['门店要货'], summary: '订货对账单详情', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    // 对账单的四个流转动作。⚠️ 它们是**独立字面段**（`/statements/:id/confirm` 等），
    // 不是 `/orders/:id/:action` 那样的参数段 —— 所以契约里必须逐个列出。
    // 原来这里写的是 `{id}/{action}`，会让人（和契约检查）以为可以传任意动作名：
    // 实际传 `close`/`void` 到了后端就是 404 —— 而前端按钮**早就渲染了这两个动作**
    // （它读内核 `allowedActions('OCS', status)`），于是"按钮在、门不存在"。
    // 这正是把契约写准的价值：泛化写法会把"少了哪个动作"藏起来。
    '/api/order-center/statements/{id}/confirm': { post: { tags: ['门店要货'], summary: '确认对账', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/order-center/statements/{id}/settle': { post: { tags: ['门店要货'], summary: '登记回款（收齐时自动结清）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    // 终局动作两条。summary 里写死了校验与**副作用边界**：
    //   · close 须"未收差额已结清"，否则 409；force=true 才允许业务判断手动结清且必须写理由；
    //   · void **只作废这份对账单凭证，不动底层台账**（订货单 / 授信台账分毫不动）。
    // 不写清边界的话，下一个读到契约的人会把"作废对账单"实现成"作废债权"。
    '/api/order-center/statements/{id}/close': { post: { tags: ['门店要货'], summary: '结清对账单（须未收差额已结清；force 手动结清须写理由）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/order-center/statements/{id}/void': { post: { tags: ['门店要货'], summary: '作废对账单（只作废本凭证，不动底层台账；须写理由）', parameters: [idParam], responses: { 200: jsonResp(null) } } },

    // —— C 端「我的数据」：**不是免登录**，而是"C 端自己的会话"（A16）——
    // 原来这些都标 `security: []`（免鉴权），因为身份是从 `phone` 参数取的。
    // 现在身份只能来自 `x-mall-token`（`/api/mall/login` 签发），
    // 与后台 `bearerAuth` 是**两套互不通用的凭据**，所以单列一个 scheme。
    '/api/mall/session': { get: { tags: ['线上 OMS'], summary: 'C 端会话自省（我是谁 / 在哪个行业）', security: [{ mallToken: [] }], responses: { 200: jsonResp(null) } } },
    '/api/mall/member': { get: { tags: ['线上 OMS'], summary: 'H5 商城会员信息（等级 / 积分）', security: [{ mallToken: [] }], responses: { 200: jsonResp(null) } } },

    // —— 契约补漏（由 scripts/check-api-contract.mjs 扫出来的「前端在用但没登记」）——
    '/api/dealers/policies': {
      get: { tags: ['经销商'], summary: '渠道政策列表（等级 / 价格 / 账期）', parameters: [q('dealer_id', '经销商'), q('page', '页码'), q('pageSize', '每页条数')], responses: { 200: jsonResp(null) } },
      post: { tags: ['经销商'], summary: '新建渠道政策', responses: { 200: jsonResp(null) } }
    },
    '/api/dealers/policies/{id}': {
      put: { tags: ['经销商'], summary: '修改渠道政策', parameters: [idParam], responses: { 200: jsonResp(null) } },
      delete: { tags: ['经销商'], summary: '删除渠道政策（已产生返利记录的政策不可删）', parameters: [idParam], responses: { 200: jsonResp(null) } }
    },
    '/api/dealers/rebates/preview': { post: { tags: ['经销商'], summary: '返利试算预览（不落库，用于核对政策）', responses: { 200: jsonResp(null) } } },

    '/api/inventory/assembly': {
      get: { tags: ['存货'], summary: '组装 / 拆卸单列表', parameters: [q('status', '状态'), q('page', '页码'), q('pageSize', '每页条数')], responses: { 200: jsonResp(null) } },
      post: { tags: ['存货'], summary: '新建组装 / 拆卸单', responses: { 200: jsonResp(null) } }
    },
    '/api/inventory/assembly/{id}': { get: { tags: ['存货'], summary: '组装 / 拆卸单详情', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/inventory/assembly/{id}/confirm': { post: { tags: ['存货'], summary: '确认组装 / 拆卸（执行出入库与成本结转）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    // 组装单作废（AS draft → cancelled）。草稿态 = 还没动过库存 ⇒ 零副作用。
    // 三库里现在就有 5 张草稿卡着（美妆 2 / 餐饮 2 / 服饰 2），界面上只有「执行组装」，录错了只能硬着头皮执行。
    '/api/inventory/assembly/{id}/cancel': { post: { tags: ['存货'], summary: '作废组装 / 拆卸单（AS draft → cancelled；草稿态零副作用）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/inventory/serials/trace/{serialNo}': { get: { tags: ['存货'], summary: '序列号全程追溯（出入库轨迹）', parameters: [q('serialNo', '序列号', true)], responses: { 200: jsonResp(null) } } },
    // （调拨出库/入库这两条原来在 `transfers/{id}` 之后已声明一次，此处又重复了一份。
    //   重复键后者覆盖前者 ⇒ 这里那一份一直是死文本，已删；定义留在上面的存货段里。）

    '/api/mall/login': { post: { tags: ['线上 OMS'], summary: 'H5 商城登录（会员 / 手机号）', security: [], responses: { 200: jsonResp(null) } } },
    '/api/mall/home': { get: { tags: ['线上 OMS'], summary: 'H5 商城首页（轮播 / 推荐 / 分类）', security: [], responses: { 200: jsonResp(null) } } },
    '/api/mall/products': { get: { tags: ['线上 OMS'], summary: 'H5 商城商品列表', parameters: [q('keyword', '关键字'), q('category_id', '品类'), q('page', '页码'), q('pageSize', '每页条数')], security: [], responses: { 200: jsonResp(null) } } },
    '/api/mall/products/{skuId}': { get: { tags: ['线上 OMS'], summary: 'H5 商城商品详情', parameters: [q('skuId', 'SKU', true)], security: [], responses: { 200: jsonResp(null) } } },
    '/api/mall/cart': {
      get: { tags: ['线上 OMS'], summary: '购物车', security: [{ mallToken: [] }], responses: { 200: jsonResp(null) } },
      post: { tags: ['线上 OMS'], summary: '加入购物车', security: [{ mallToken: [] }], responses: { 200: jsonResp(null) } }
    },
    '/api/mall/cart/update': { post: { tags: ['线上 OMS'], summary: '修改购物车行（数量 / 勾选）', security: [{ mallToken: [] }], responses: { 200: jsonResp(null) } } },
    '/api/mall/orders': {
      get: { tags: ['线上 OMS'], summary: '我的订单', security: [{ mallToken: [] }], responses: { 200: jsonResp(null) } },
      post: {
        tags: ['线上 OMS'],
        summary: '**提交订单（下单）** —— 走结算域算钱（会员等级折扣 → 活动 → 券 → 积分），' +
          '与试算 `/api/mall/quote` 同一条判据；优惠留痕 / 券核销 / 积分扣送由结算层落库',
        security: [{ mallToken: [] }],
        requestBody: body('MallOrderCreate'),
        responses: { 200: jsonResp(null), 400: jsonResp(null) }
      }
    },
    // —— 渠道闭环（A14）：C 端试算 / 券包 / 撤单 ——
    // 试算存在的意义：结算页显示的钱与落单后实际收的钱必须来自同一条公式，
    // 否则只会在对账时以"说不清的一笔钱"出现。
    '/api/mall/quote': {
      post: {
        tags: ['线上 OMS'],
        summary: '**C 端结算试算**（纯读，不写库）：商品额 / 运费 / 会员折扣 / 活动优惠 / 积分抵扣 / 应付 + 可用券',
        security: [{ mallToken: [] }],
        requestBody: body('MallQuote'),
        responses: { 200: jsonResp(null), 400: jsonResp(null) }
      }
    },
    '/api/mall/coupons': {
      get: {
        tags: ['线上 OMS'],
        summary: '**我的券包**（按会话身份；`usable` 是本单金额下真能用的，`blocked` 带不能用原因）',
        security: [{ mallToken: [] }],
        responses: { 200: jsonResp(null) }
      }
    },
    '/api/mall/orders/{id}/cancel': {
      post: {
        tags: ['线上 OMS'],
        summary: '**C 端撤单**（仅"未转销售单且待发货"的本单）—— 成对回退优惠留痕 / 券 / 积分（含抵现退回与累计消费回退）',
        parameters: [idParam],
        security: [{ mallToken: [] }],
        responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) }
      }
    },

    // —— 模块 24 待办推送（通知中心）——
    '/api/notify/meta': { get: { tags: ['通知中心'], summary: '渠道类型与可选事件类型', responses: { 200: jsonResp(null) } } },
    '/api/notify/overview': { get: { tags: ['通知中心'], summary: '推送总览（渠道数/启用数/成功失败）', responses: { 200: jsonResp(null) } } },
    '/api/notify/channels': {
      get: { tags: ['通知中心'], summary: '推送渠道列表（含「是否可发」判定）', responses: { 200: jsonResp(null) } },
      post: { tags: ['通知中心'], summary: '新建 / 修改推送渠道（需 system:notify:manage）', responses: { 200: jsonResp(null) } }
    },
    '/api/notify/channels/{id}/toggle': { post: { tags: ['通知中心'], summary: '启用 / 停用渠道（未配 webhook 不许启用）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/notify/preview': { get: { tags: ['通知中心'], summary: '渲染推送预览（只渲染，不发送）', parameters: [q('provider', 'feishu/dingtalk/wecom/generic'), q('kinds', '只看这些待办类型，逗号分隔'), q('channel_id', '按渠道配置渲染')], responses: { 200: jsonResp(null) } } },
    '/api/notify/push': { post: { tags: ['通知中心'], summary: '发起待办推送（需 system:notify:push）；dry_run=true 时只试算', responses: { 200: jsonResp(null) } } },
    '/api/notify/logs': { get: { tags: ['通知中心'], summary: '推送日志', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('channel_code', '渠道编码'), q('status', 'ok/fail')], responses: { 200: jsonResp(null) } } },

    // —— 钉钉 / 飞书 组织与审批同步（批次 T）——
    // 契约里如实写着 real_call_ready=false：真实租户调用未实现。
    // 一个"看起来能用"的契约比"明确写着未实现"危险得多。
    '/api/im/meta': { get: { tags: ['IM 同步'], summary: '平台字典 / 决策映射 / 冲突码字典 / 运行状态；**含 real_call_ready=false**（真实租户调用未实现）', responses: { 200: jsonResp(null) } } },
    '/api/im/status': { get: { tags: ['IM 同步'], summary: '同步总览（平台启用状态 / 三张映射表行数 / 未挂接与未开户数 / 冲突数）', responses: { 200: jsonResp(null) } } },
    '/api/im/audit': { get: { tags: ['IM 同步'], summary: '同步链自证（留痕只追加 / 映射有出处 / 引用不悬空 / 状态取值域）', responses: { 200: jsonResp(null) } } },
    '/api/im/platforms': { get: { tags: ['IM 同步'], summary: '平台配置列表（**密钥不落库**，只显示凭据环境变量名与"环境里有没有值"）', responses: { 200: jsonResp(null) } } },
    '/api/im/mappings': { get: { tags: ['IM 同步'], summary: '三张映射表：外部部门→本地组织 / 外部成员→本地用户 / 外部审批单→本地审批实例', parameters: [q('platform', 'dingtalk / feishu'), q('limit', '每类返回条数')], responses: { 200: jsonResp(null) } } },
    '/api/im/runs': { get: { tags: ['IM 同步'], summary: '同步流水（**只追加**：拉了多少 / 建了几个 / 冲突几条 / 游标从哪到哪）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('platform', 'dingtalk / feishu')], responses: { 200: jsonResp(null) } } },
    '/api/im/conflicts': { get: { tags: ['IM 同步'], summary: '冲突台账（**只追加**：每条带一句人话，说明出了什么事、该怎么办）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('platform', 'dingtalk / feishu'), q('reason_code', '冲突码')], responses: { 200: jsonResp(null) } } },
    '/api/im/sync/org': { post: { tags: ['IM 同步'], summary: '发起组织同步（需 system.im.sync）。**没配凭据时明确 409 IM_NOT_CONFIGURED**，绝不返回空快照（空快照会被读成"所有人都离职了"）', responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/im/sync/approval': { post: { tags: ['IM 同步'], summary: '发起审批同步（需 system.im.sync）：把外部审批结论落到本地 pending 实例上；**外部审批人未映射到本地用户时不代替签字**', responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/im/self-test': { post: { tags: ['IM 同步'], summary: '全链路自检：用固定快照在一个**会回滚的事务里**跑一遍（映射→幂等→缺失判定→冲突→留痕），不碰外部、不留痕', responses: { 200: jsonResp(null) } } },

    // —— 模块 22 通用审批流 ——
    '/api/approval/meta': { get: { tags: ['审批中心'], summary: '审批元数据（单据类型/角色/人员/权限点）', responses: { 200: jsonResp(null) } } },
    '/api/approval/overview': { get: { tags: ['审批中心'], summary: '审批总览（待审/通过/驳回/撤回/模板）', responses: { 200: jsonResp(null) } } },
    '/api/approval/check': { get: { tags: ['审批中心'], summary: '某动作是否需要审批（已在审批中会带回实例）', parameters: [q('doc_type', '单据类型', true), q('doc_id', '单据 id', true), q('action', '动作码', true)], responses: { 200: jsonResp(null) } } },
    '/api/approval/instances': {
      get: { tags: ['审批中心'], summary: '审批实例列表', parameters: [q('status', 'pending/approved/rejected/canceled'), q('doc_type', '单据类型'), q('mine', '1=我提交的'), q('page', '页码'), q('pageSize', '每页条数')], responses: { 200: jsonResp(null) } },
      post: { tags: ['审批中心'], summary: '提交审批（审批实例的唯一创建入口）', requestBody: body('ApprovalSubmit'), responses: { 200: jsonResp(null) } }
    },
    '/api/approval/pending': { get: { tags: ['审批中心'], summary: '待我审批（按当前级指派给本人解析）', parameters: [q('page', '页码'), q('pageSize', '每页条数')], responses: { 200: jsonResp(null) } } },
    '/api/approval/instances/{id}': { get: { tags: ['审批中心'], summary: '审批详情（级次链路 + 处理记录）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/approval/instances/{id}/decide': { post: { tags: ['审批中心'], summary: '通过 / 驳回（最后一级通过会真正执行业务流转）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/approval/instances/{id}/cancel': { post: { tags: ['审批中心'], summary: '撤回审批（提交人本人或管理员）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/approval/templates': {
      get: { tags: ['审批中心'], summary: '审批模板列表（含级次）', responses: { 200: jsonResp(null) } },
      post: { tags: ['审批中心'], summary: '新建 / 修改审批模板（级次整体重建；需 system:approval:template 且全局数据范围；指定人员须存在，AA3）', responses: { 200: jsonResp(null) } }
    },
    '/api/approval/templates/{id}/toggle': { post: { tags: ['审批中心'], summary: '启用 / 停用模板（未标记需审批的动作不允许启用；需 system:approval:template 且全局数据范围）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/approval/todos': { get: { tags: ['审批中心'], summary: '审批待办（按单据类型分组）。门：审批中心任一权限点；只统计当前级指到本人的 pending 实例，admin / system:approval:manage 全见（ADR-0015）', responses: { 200: jsonResp(null), 403: jsonResp(null) } } },

    // —— 模块 23 数据口径字典 ——
    // 每条指标是「口径 + 算法」写在同一处的一个对象，表只是投影；这组接口把两者一起端出来。
    '/api/metrics': { get: { tags: ['数据口径'], summary: '指标字典（按模块分组，含当前值）；with_values=0 只回口径', parameters: [q('days', '窗口天数，用于周转/临期这类区间指标，默认 30'), q('with_values', '0=不带当前值')], responses: { 200: jsonResp(null) } } },
    '/api/metrics/defs': { get: { tags: ['数据口径'], summary: '只要口径（不含值与算法），供文档 / AI / 外部系统读', responses: { 200: jsonResp(null) } } },
    '/api/metrics/values': { get: { tags: ['数据口径'], summary: '只要值（可批量取多个指标）', parameters: [q('keys', '指标 key，逗号分隔；不传=全部'), q('days', '窗口天数')], responses: { 200: jsonResp(null) } } },
    '/api/metrics/catalog': { get: { tags: ['数据口径'], summary: '关键指标一览（口径 + 当前值）', parameters: [q('days', '窗口天数')], responses: { 200: jsonResp(null) } } },
    '/api/metrics/stale': { get: { tags: ['数据口径'], summary: '定义一致性自检：表是否落后于代码，并摊开差异', responses: { 200: jsonResp(null) } } },
    '/api/metrics/sync': { post: { tags: ['数据口径'], summary: '按代码重新投影 metric_defs（幂等；需 system:metrics:sync）', responses: { 200: jsonResp(null) } } },

    // —— 模块 09 存货核算与成本 ——
    // 三条硬口径都在这组接口上体现：① 三层成本要闭合；② 结转要有约束力（结转后禁止补单）；
    // ③ 暂估差异必须回写、且不追溯已售出部分。成本调整单是**成本单据**，不是会计凭证。
    '/api/costing/meta': { get: { tags: ['存货核算'], summary: '成本枚举（调整单状态 / 计价方式 / 调整类型）', responses: { 200: jsonResp(null) } } },
    '/api/costing/overview': { get: { tags: ['存货核算'], summary: '成本概览（本期三层 + 待调整暂估差异 + 自洽状态，一屏）', parameters: [q('period', '会计期间 YYYY-MM，缺省为当前月')], responses: { 200: jsonResp(null) } } },
    '/api/costing/layers': { get: { tags: ['存货核算'], summary: '三层成本明细（期初 / 本期入 / 本期出 / 截至期末 / 期末之后 / 现存量 + 残差与是否平衡）', parameters: [q('period', '会计期间 YYYY-MM'), q('warehouse_id', '仓库'), q('sku_id', 'SKU'), q('batch_no', '批次号'), q('owner_org_id', '货主组织'), q('currency', '币种')], responses: { 200: jsonResp(null) } } },
    '/api/costing/audit': { get: { tags: ['存货核算'], summary: '成本自洽审计（流水累计 vs 结存金额；qty=0 的残值单列不判错）；传 warehouse_id + sku_id 则只对单个维度重算', parameters: [q('warehouse_id', '仓库（与 sku_id 同时传则走单维度重算）'), q('sku_id', 'SKU'), q('batch_no', '批次号'), q('limit', '返回差异条数，默认 20')], responses: { 200: jsonResp(null) } } },
    '/api/costing/periods': { get: { tags: ['存货核算'], summary: '成本期间列表（open 可写 / closed 已结转）', parameters: [q('limit', '返回条数，默认 36')], responses: { 200: jsonResp(null) } } },
    '/api/costing/periods/close': { post: { tags: ['存货核算'], summary: '期末结转：落期末快照作为下期期初并锁定本期（此后禁止再往该期间写出入库）；未走完的期间结不了', requestBody: body('CostPeriodClose'), responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/costing/variances': { get: { tags: ['存货核算'], summary: '暂估差异台账（来自采购结算，含已调整 / 待调整状态与已售出不追溯金额）', parameters: [q('status', 'pending/ adjusted / all'), q('limit', '返回条数')], responses: { 200: jsonResp(null) } } },
    '/api/costing/adjustments': {
      get: { tags: ['存货核算'], summary: '成本调整单列表', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('status', 'draft / adjusted / cancelled'), q('period', '会计期间'), q('settle_id', '结算单')], responses: { 200: jsonResp(null) } },
      post: { tags: ['存货核算'], summary: '从结算单开成本调整单（草稿，建单不改成本）；只调仍在该批次库存里的数量', requestBody: body('CostAdjustmentCreate'), responses: { 200: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/costing/adjustments/{id}': { get: { tags: ['存货核算'], summary: '成本调整单详情（行级调整前后单价与金额 + 流转留痕）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/costing/adjustments/{id}/adjust': { post: { tags: ['存货核算'], summary: '确认调整（**唯一有后果的动作**：回写批次结存金额与单价 + 写成本台账 + 内核推进状态）', parameters: [idParam], responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/costing/adjustments/{id}/cancel': { post: { tags: ['存货核算'], summary: '取消成本调整单（仅草稿可取消；已调整的不可作废，要纠正请开反向调整单）', parameters: [idParam], responses: { 200: jsonResp(null) } } },

    // —— 模块 08A 销售报价与信用控制 ——
    // 报价侧四条硬口径：① 价由价格中心算出并留痕来源；② 有效期是硬约束（过期不能转单）；
    // ③ 低于最低限价 / 低于客户政策折扣 / 超金额阈值必须审批；④ 转单只能成功一次。
    '/api/sales/quotes/meta': { get: { tags: ['销售报价'], summary: '报价枚举（状态 / 客户类型 / 渠道 / 转单目标 / 审批阈值 / 默认有效期）', responses: { 200: jsonResp(null) } } },
    '/api/sales/quotes/overview': { get: { tags: ['销售报价'], summary: '报价概览（各状态数量 + 待审批数 + 7 天内到期 + 已转单金额；按调用者组织范围统计，ADR-0034）', responses: { 200: jsonResp(null) } } },
    '/api/sales/quotes/price': { post: { tags: ['销售报价'], summary: '取价试算（不落库；给出的仓库 / 门店 / 订货客户须在组织范围内，否则 403）：按客户算每行价格、折扣率、是否低于最低限价，并给出是否需要审批', requestBody: body('QuotePriceRequest'), responses: { 200: jsonResp(null), 400: jsonResp(null), 403: jsonResp(null) } } },
    '/api/sales/quotes': {
      get: { tags: ['销售报价'], summary: '报价单列表（按仓库 / 门店 / 订货客户的组织归属过滤，ADR-0034）', parameters: [q('status', '状态'), q('customer_type', '客户类型'), q('dealer_id', '经销商'), q('customer_id', '订货客户'), q('keyword', '单号/客户'), q('valid_only', '1=只看可转单（已审批且未过期）'), q('page', '页码'), q('pageSize', '每页条数')], responses: { 200: jsonResp(null) } },
      post: { tags: ['销售报价'], summary: '新建报价单（草稿；价由价格中心算出，手工改价需同时保留挂牌价与成交价）；受限范围下仓库 / 门店 / 订货客户须都在范围内且至少给一个，否则 403；改版来源范围外 404', requestBody: body('QuoteCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } }
    },
    '/api/sales/quotes/{id}': { get: { tags: ['销售报价'], summary: '报价单详情（含行级取价来源、最低限价快照、是否已过期 / 已转单）；组织范围外 404', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/sales/quotes/{id}/action': { post: { tags: ['销售报价'], summary: '报价流转：submit 提交 / approve 审批通过 / reject 驳回 / resubmit 修改后再提交 / cancel 取消；组织范围外 404（与不存在同形）', parameters: [idParam], requestBody: body('QuoteAction'), responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/sales/quotes/{id}/convert': { post: { tags: ['销售报价'], summary: '报价转订单（**唯一有后果的动作**）：生成销售订单（沿用报价价）或订货单；已审批且未过期才可转，一张报价只能转一次；超信默认拦住，force+reason 为特批放行；组织范围外 404，仓库 / 门店 / 订货客户不全在范围内 403', parameters: [idParam], requestBody: body('QuoteConvert'), responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/sales/quotes/{id}/copy': { post: { tags: ['销售报价'], summary: '复制改版：生成新草稿且 version+1（已报出去的价不改，要改就出新版本）；组织范围外 404', parameters: [idParam], requestBody: body('QuoteCopy'), responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } } },
    '/api/sales/quotes/expire': { post: { tags: ['销售报价'], summary: '批量把过了有效期的报价置为「已过期」（系统动作，不是状态机里的按钮；只处理调用者组织范围内的报价）', requestBody: body('QuoteExpire'), responses: { 200: jsonResp(null) } } },

    // 信用侧三条硬口径：① 已用额 = 统一台账 + 订货中心同主体占用，不读缓存列；
    // ② 占用 / 释放 / 核销成对，核销只认回款（货发了钱没到，额度仍占着）；
    // ③ 超信默认拦，特批放行必须带理由并进留痕。
    '/api/credit/meta': { get: { tags: ['信用控制'], summary: '信用枚举（台账变更类型 / 校验结论 / 账户状态 / 主体类型）', responses: { 200: jsonResp(null) } } },
    '/api/credit/overview': { get: { tags: ['信用控制'], summary: '信用总览（额度与占用、风险榜、拦截与特批留痕、自洽审计）', responses: { 200: jsonResp(null) } } },
    '/api/credit/accounts': {
      get: { tags: ['信用控制'], summary: '信用账户列表（含额度 / 已用 / 可用 / 账期 / 逾期 / 使用率）', parameters: [q('subject_type', '主体类型'), q('status', 'active / frozen'), q('keyword', '名称/编码'), q('page', '页码'), q('pageSize', '每页条数')], responses: { 200: jsonResp(null) } },
      post: { tags: ['信用控制'], summary: '建立信用账户（按主体自动带出档案上的额度与账期）', requestBody: body('CreditAccountCreate'), responses: { 200: jsonResp(null), 404: jsonResp(null) } }
    },
    '/api/credit/accounts/{id}': {
      get: { tags: ['信用控制'], summary: '信用账户详情（快照 + 台账流水 + 校验留痕）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } },
      post: { tags: ['信用控制'], summary: '维护信用账户：额度 / 账期 / 临时额度与到期日 / 冻结与解冻（冻结必须填原因）', parameters: [idParam], requestBody: body('CreditAccountUpdate'), responses: { 200: jsonResp(null), 404: jsonResp(null) } }
    },
    '/api/credit/check': { post: { tags: ['信用控制'], summary: '只校验不写单：下单或转单前问一句「够不够」；超信返回 block，force+reason 才是特批放行', requestBody: body('CreditCheckRequest'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/credit/ledger': { get: { tags: ['信用控制'], summary: '信用台账流水（占用为正，释放与回款核销为负）', parameters: [q('account_id', '账户'), q('source_type', '来源单据类型'), q('source_id', '来源单据 id'), q('limit', '返回条数，默认 100')], responses: { 200: jsonResp(null) } } },
    '/api/credit/checks': { get: { tags: ['信用控制'], summary: '信用校验留痕（pass 通过 / warn 预警 / block 拦截 / force 特批放行）', parameters: [q('account_id', '账户'), q('result', '结论'), q('limit', '返回条数，默认 100')], responses: { 200: jsonResp(null) } } },
    '/api/credit/settle': { post: { tags: ['信用控制'], summary: '回款核销：钱到了才释放占用（货发了钱没到，额度仍然占着）', requestBody: body('CreditSettle'), responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/credit/adjust': { post: { tags: ['信用控制'], summary: '人工调整占用（坏账核销 / 争议挂账等），必填原因', requestBody: body('CreditAdjust'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/credit/release': { post: { tags: ['信用控制'], summary: '释放某张单据占用的授信（如订单取消），不填 amount 则按台账未释放额整笔回冲', requestBody: body('CreditRelease'), responses: { 200: jsonResp(null) } } },
    '/api/credit/audit': { get: { tags: ['信用控制'], summary: '信用自洽审计（台账逐笔余额漂移 + 销售订单占用与台账差异）', responses: { 200: jsonResp(null) } } },

    // ── 应收与收款核销（模块 21）────────────────────────────────
    '/api/ar/meta': { get: { tags: ['应收与收款'], summary: '应收/收款状态字典、收款方式与账龄分桶口径', responses: { 200: jsonResp(null) } } },
    '/api/ar/overview': { get: { tags: ['应收与收款'], summary: '应收总览（应收/已收/未结/逾期 + 账龄 + 逾期榜前十）', responses: { 200: jsonResp(null) } } },
    // ⚠️ 这两条**必须写成一个对象字面量**：曾经写成上下两行同名键
    //   （`'/api/ar/documents': { get: … }` 紧跟 `'/api/ar/documents': { post: … }`），
    //   JS 里重复键**后者覆盖前者** ⇒ `get` 静默消失，而 `check-api-contract` 只比路径
    //   不比方法（当时）所以一路全绿。实测：契约里查不到 GET，前端 `api.get('/ar/documents')`
    //   与真实路由却都是 GET（`routes/ar.js`）。
    '/api/ar/documents': {
      get: { tags: ['应收与收款'], summary: '应收单列表（客户 / 状态 / 仅看未结 / 仅看逾期 / 关键字分页）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('keyword', '关键字')], responses: { 200: jsonResp(null) } },
      post: { tags: ['应收与收款'], summary: '手工建应收单（补账用；正常由销售订单自动生成）', requestBody: body('ArCreate'), responses: { 200: jsonResp(null) } }
    },
    '/api/ar/documents/generate': { post: { tags: ['应收与收款'], summary: '按销售订单批量生成应收单（幂等：同一来源只生成一次）', requestBody: body('ArGenerate'), responses: { 200: jsonResp(null) } } },
    '/api/ar/documents/{id}': { get: { tags: ['应收与收款'], summary: '应收单详情（含核销明细：这笔钱抵了哪几笔）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    // ⚠️ 同上：曾写成两行同名键，`get` 被 `post` 覆盖掉。
    '/api/ar/receipts': {
      get: { tags: ['应收与收款'], summary: '收款单列表（客户 / 状态 / 关键字分页）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('keyword', '关键字')], responses: { 200: jsonResp(null) } },
      post: { tags: ['应收与收款'], summary: '登记收款单（草稿 + 计划核销；不传 allocations 按到期日 FIFO 自动摊）', requestBody: body('ReceiptCreate'), responses: { 200: jsonResp(null) } }
    },
    '/api/ar/receipts/{id}': { get: { tags: ['应收与收款'], summary: '收款单详情（含核销明细）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/ar/receipts/{id}/confirm': { post: { tags: ['应收与收款'], summary: '确认收款：核销生效（抵减应收）+ 按来源释放授信占用并记释放台账（响应含 credit_released）。ADR-0018 证据闸与二人复核：必须带 evidence_ref（funds_evidence_required，缺失 400 FUNDS_EVIDENCE_REQUIRED）；金额 ≥ funds_review_threshold 且 funds_review_required 时只挂待复核（status 仍 draft、review.status=pending_review，应收 / 授信不动），否则直接生效。待复核期间再次确认 / 作废 409 FUNDS_REVIEW_PENDING。响应含 review 块', parameters: [idParam], requestBody: body('ReceiptConfirm'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },
    '/api/ar/receipts/{id}/review': { post: { tags: ['应收与收款'], summary: '收款确认的第二人复核（ADR-0018，需 finance.funds.review）：approve 在同一事务里执行确认（核销 + 释放授信）+ 严格审计；reject 退回草稿并记原因（comment 必填）。发起人自审 409 FUNDS_SELF_REVIEW；不在待复核 409 FUNDS_NOT_PENDING。响应含 review: {status, maker, checker, decided_at}', parameters: [idParam], requestBody: body('FundsReview'), responses: { 200: jsonResp(null), 400: jsonResp(null), 403: jsonResp(null), 409: jsonResp(null) } } },
    '/api/ar/receipts/{id}/void': { post: { tags: ['应收与收款'], summary: '作废收款：核销失效并重算应收，并按授信释放台账逐笔恢复统一授信与订货占用（响应含 credit_reversal；重复作废 409 RC_ALREADY_VOID，跨客户 409 CREDIT_REVERSAL_SUBJECT_MISMATCH）', parameters: [idParam], requestBody: body('ReceiptVoid'), responses: { 200: jsonResp(null) } } },
    '/api/ar/aging': { get: { tags: ['应收与收款'], summary: '账龄分析（未到期 / 1-30 / 31-60 / 60+；by_subject=1 时按客户汇总）', parameters: [{ name: 'by_subject', in: 'query', schema: { type: 'string' } }], responses: { 200: jsonResp(null) } } },
    '/api/ar/statement': { get: { tags: ['应收与收款'], summary: '客户对账单（应收明细 + 收款明细 + 核销明细 + 期末余额）', parameters: [{ name: 'subject_type', in: 'query', required: true, schema: { type: 'string' } }, { name: 'subject_id', in: 'query', required: true, schema: { type: 'integer' } }, { name: 'from', in: 'query', schema: { type: 'string' } }, { name: 'to', in: 'query', schema: { type: 'string' } }], responses: { 200: jsonResp(null) } } },
    '/api/ar/audit': { get: { tags: ['应收与收款'], summary: '应收自洽审计（已收 = 核销明细 SUM、状态与金额相符、无超额核销）', responses: { 200: jsonResp(null) } } },
    '/api/ar/recalc': { post: { tags: ['应收与收款'], summary: '按客户（或全量）重算应收已收与状态', requestBody: body('ArRecalc'), responses: { 200: jsonResp(null) } } },
    '/api/ar/aging/detail': { get: { tags: ['应收与收款'], summary: '逐笔账龄：一行一张应收单（余额 / 逾期天数 / 账龄桶），口径取自视图 v_ar_aging_detail', parameters: [q('subject_type', '往来对象类型'), q('subject_id', '往来对象 id'), q('bucket', '账龄桶 b0~b3 / settled / all'), q('source_type', '来源类型 SO / OC / MANUAL'), q('keyword', '关键字'), q('include_settled', '是否包含已结清')], responses: { 200: jsonResp(null) } } },
    '/api/ar/aging/subjects': { get: { tags: ['应收与收款'], summary: '客户级逐笔汇总（催收风险榜，含最长逾期天数）', responses: { 200: jsonResp(null) } } },
    '/api/ar/prepay': { get: { tags: ['应收与收款'], summary: '预收余额清单（按往来对象；预收 = 已确认收款单金额 − 其核销明细之和）', parameters: [q('subject_type', '往来对象类型'), q('subject_id', '往来对象 id'), q('keyword', '客户名称关键字')], responses: { 200: jsonResp(null) } } },
    '/api/ar/prepay/detail': { get: { tags: ['应收与收款'], summary: '预收明细：哪些收款单付多了，以及该客户可抵的未结应收', parameters: [{ name: 'subject_type', in: 'query', required: true, schema: { type: 'string' } }, { name: 'subject_id', in: 'query', required: true, schema: { type: 'integer' } }], responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/ar/prepay/apply': { post: { tags: ['应收与收款'], summary: '预收转应收：指定应收单抵扣，或传 auto 按到期日 FIFO 自动抵（同对象校验，禁止跨客户；按来源释放统一授信并记释放台账，响应含 credit_released）', requestBody: body('PrepayApply'), responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/ar/oc/pending': { get: { tags: ['应收与收款'], summary: '订货中心待并入应收的订货单（已收货/发货但未生成应收，口径取自视图 v_oc_ar_pending）', parameters: [q('customer_id', '订货客户 id'), q('keyword', '单号 / 客户关键字')], responses: { 200: jsonResp(null) } } },
    '/api/ar/oc/sync': { post: { tags: ['应收与收款'], summary: '批量把待并入的订货单生成应收（幂等，可重复跑）', requestBody: body('ArOcSync'), responses: { 200: jsonResp(null) } } },

    // ---------- 销售发票（模块 24）----------
    // 销售链的最后一环：发货出库 → 开票 → 应收 → 收款。开票只产生债权，不动库存。
    '/api/invoices/meta': { get: { tags: ['销售发票'], summary: '发票状态字典、开票关闭口径与当前应收来源口径（SO / SI）', responses: { 200: jsonResp(null) } } },
    '/api/invoices/overview': { get: { tags: ['销售发票'], summary: '开票总览（已开票额 / 税额 / 待确认张数 / 待开票发货单数 / 按状态分布）', responses: { 200: jsonResp(null) } } },
    '/api/invoices/pending': { get: { tags: ['销售发票'], summary: '待开票队列（已发货/已签收且未开完票的发货单，含客户与剩余可开数量）', parameters: [q('order_id', '只看某张订单'), { name: 'only_none', in: 'query', schema: { type: 'string' } }, q('keyword', '发货单号 / 订单号')], responses: { 200: jsonResp(null) } } },
    '/api/invoices/pending/{deliveryId}': { get: { tags: ['销售发票'], summary: '某张发货单的逐行待开数量（已开票数量按已确认蓝字发票 SUM 得出）', parameters: [{ name: 'deliveryId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/invoices/list': { get: { tags: ['销售发票'], summary: '发票列表（状态 / 客户 / 订单 / 蓝红字 / 开票日期区间 / 关键字分页）', parameters: [q('status', 'draft/pending/confirmed/red_charted/voided'), q('subject_type', 'dealer/store'), q('subject_id', '客户 id'), q('order_id', '订单 id'), q('invoice_type', 'normal 蓝字 / red 红字'), q('from', '开票起始日期'), q('to', '开票结束日期'), q('keyword', '单号 / 票号 / 客户 / 订单号'), q('page', '页码'), q('pageSize', '每页条数')], responses: { 200: jsonResp(null) } } },
    '/api/invoices/audit': { get: { tags: ['销售发票'], summary: '开票自洽审计（头行金额一致 / 未超开数量 / 已确认票必有应收关联 / 无孤儿关联 / 关闭状态无漂移）', responses: { 200: jsonResp(null) } } },
    '/api/invoices/refresh-close': { post: { tags: ['销售发票'], summary: '重推开票关闭状态（运维兜底：整库重建或历史导入后一次性推平发货单与订单的 invoice_status）', responses: { 200: jsonResp(null) } } },
    '/api/invoices/{id}': { get: { tags: ['销售发票'], summary: '发票详情（含发票行、应收关联、红字票、原票）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/invoices/from-delivery': { post: { tags: ['销售发票'], summary: '由发货单开票（不传 items = 整单未开行一次开完；传 items 支持分批开票）。生成草稿，确认后才成立债权', requestBody: body('InvoiceFromDelivery'), responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/invoices/manual': { post: { tags: ['销售发票'], summary: '手工开票（无来源单据，补开历史票 / 特殊业务）', requestBody: body('InvoiceManual'), responses: { 200: jsonResp(null) } } },
    '/api/invoices/{id}/submit': { post: { tags: ['销售发票'], summary: '提交开票（draft → pending）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/invoices/{id}/confirm': { post: { tags: ['销售发票'], summary: '确认开票（**唯一有后果的动作**：生成/关联应收 + 回写开票关闭；应收口径由 settings.ar_source_of_truth 决定）', parameters: [idParam], requestBody: body('InvoiceConfirm'), responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/invoices/{id}/red-chart': { post: { tags: ['销售发票'], summary: '红冲（原票留痕 + 关联应收作废 + 生成红字票；已收过款的票需先作废收款单）', parameters: [idParam], requestBody: body('InvoiceRedChart'), responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/invoices/{id}/void': { post: { tags: ['销售发票'], summary: '作废发票（仅草稿/待确认；已开票的只能红冲）', parameters: [idParam], requestBody: body('InvoiceVoid'), responses: { 200: jsonResp(null) } } },

    // ----- 质量检验（模块 13）：独立前缀 /api/qc -----
    '/api/qc/meta': { get: { tags: ['质量检验'], summary: '质量字典：报检来源 / 结论 / 处置方式 / 缺陷代码 / 抽样表与三条口径', responses: { 200: jsonResp(null) } } },
    '/api/qc/overview': { get: { tags: ['质量检验'], summary: '质量总览（待检来源数 / 合格率 / 四路处置量 / 按来源与方式分布）', responses: { 200: jsonResp(null) } } },
    '/api/qc/audit': { get: { tags: ['质量检验'], summary: '自洽审计（判定与数字一致 / 头行汇总一致 / 处置不超量 / 库存后果齐备 / 无孤儿子引用）', responses: { 200: jsonResp(null) } } },
    '/api/qc/sample-plan': { get: { tags: ['质量检验'], summary: '抽样方案试算（按批量与检验水平给出 n / Ac / Re）', parameters: [q('qty', '批量（报检数量）'), q('level', 'normal / tightened / reduced')], responses: { 200: jsonResp(null) } } },
    '/api/qc/pending': { get: { tags: ['质量检验'], summary: '待检来源（采购到货 + 生产完工；已报检或被模块 07 质检覆盖的不再出现）', parameters: [q('source_type', 'purchase_receipt / production_order'), q('keyword', '单号 / 供应商'), q('warehouse_id'), q('limit')], responses: { 200: jsonResp(null) } } },
    '/api/qc/pending/detail': { get: { tags: ['质量检验'], summary: '来源单据的行级装填（前端一屏填完，不用先建后改）', parameters: [q('source_type', '必填'), q('source_id', '必填')], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/qc/requests': {
      get: { tags: ['质量检验'], summary: '报检单列表（分页；含未合格行数）', parameters: [q('status'), q('source_type'), q('keyword'), q('page'), q('pageSize')], responses: { 200: jsonResp(null) } },
      post: { tags: ['质量检验'], summary: '建报检单（草稿；抽样方案按批量与检验水平写入行，可覆盖来源行与数量）', requestBody: body('QcRequestCreate'), responses: { 200: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/qc/requests/{id}': { get: { tags: ['质量检验'], summary: '报检单详情（含明细行、抽样方案、留痕）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/qc/requests/{id}/submit': { post: { tags: ['质量检验'], summary: '提交报检（同时生成一对一的检验单草稿；至此进入待检工作台）', parameters: [idParam], responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/qc/requests/{id}/close': { post: { tags: ['质量检验'], summary: '关闭报检单（归档；检验与处置完成时系统会自动调它）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/qc/requests/{id}/cancel': { post: { tags: ['质量检验'], summary: '作废报检单（仅草稿）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/qc/inspections': { get: { tags: ['质量检验'], summary: '检验单列表（分页；含草稿处置单数）', parameters: [q('status'), q('result'), q('keyword'), q('page'), q('pageSize')], responses: { 200: jsonResp(null) } } },
    '/api/qc/inspections/{id}': { get: { tags: ['质量检验'], summary: '检验单详情（含报检明细行、处置单、留痕）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/qc/inspections/{id}/submit': { post: { tags: ['质量检验'], summary: '提交检验结论（**检验唯一有后果的动作**：判定由不良数与 Ac/Re 推导，不由人选；全部合格自动关闭报检单）', parameters: [idParam], requestBody: body('QcInspectSubmit'), responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/qc/inspections/{id}/close': { post: { tags: ['质量检验'], summary: '关闭检验单（归档）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/qc/inspections/{id}/cancel': { post: { tags: ['质量检验'], summary: '作废检验单（仅待检）', parameters: [idParam], responses: { 200: jsonResp(null) } } },
    '/api/qc/handlings': {
      get: { tags: ['质量检验'], summary: '不良品处理单列表（分页）', parameters: [q('status'), q('mode'), q('inspection_id'), q('keyword'), q('page'), q('pageSize')], responses: { 200: jsonResp(null) } },
      post: { tags: ['质量检验'], summary: '建不良品处理单（草稿；让步接收必须填理由；数量不得超过该行可处置量）', requestBody: body('QcHandlingCreate'), responses: { 200: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/qc/handlings/{id}': { get: { tags: ['质量检验'], summary: '不良品处理单详情（含留痕与生成的出库单号）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/qc/handlings/{id}/confirm': { post: { tags: ['质量检验'], summary: '执行处理（**唯一产生库存后果的动作**，四种处置都会真的动库存：报废出库 SCRAP_OUT / 退货生成采购退货单或质检退料出库 QC_RET_OUT / 让步接收自动生成调拨单入不合格品仓 / 返工自动生成调拨单入待检品仓；调拨的出库与入库都真的发生，单号回写 out_doc_no）', parameters: [idParam], responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/qc/handlings/{id}/cancel': { post: { tags: ['质量检验'], summary: '取消处理单（仅待处理；已执行的不能取消，只能再开反向单）', parameters: [idParam], responses: { 200: jsonResp(null) } } },

    // ----- 生产制造（模块 10B）：BOM / 领料 / 完工入库，独立前缀 /api/manufacture -----
    // 为什么不并进 /api/demand：`demand` 管**净需求与计划**（算「要做什么」），
    // 这里管**执行**（「照什么做、领什么料、入什么库」），且授权粒度不同。
    '/api/manufacture/meta': { get: { tags: ['生产制造'], summary: '制造字典：BOM 用途/状态、领料类型/状态、订单状态，以及七条硬口径原文', responses: { 200: jsonResp(null) } } },
    '/api/manufacture/overview': { get: { tags: ['生产制造'], summary: '制造总览（在制订单/在制数量、已出库领料额、累计良品与不良率、待完工入库数）+ BOM 总览（含「能生产但没 BOM」的成品数）', responses: { 200: jsonResp(null) } } },
    '/api/manufacture/audit': { get: { tags: ['生产制造'], summary: '自洽审计七项不变量（出库无流水 / 已出库金额为 0 / 头行不平 / 汇报标记入库却无流水 / 订单完工数与汇报不符 / 订单材料成本与归集不符 / 累计领用超出 BOM 需求且无补料单解释）', responses: { 200: jsonResp(null) } } },

    '/api/manufacture/boms': {
      get: { tags: ['生产制造'], summary: ' BOM 列表（分页；可按状态 / 用途 / 关键字筛）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('status', 'draft / approved / obsolete'), q('usage', 'self_made / outsourced / combo'), q('keyword', 'BOM 号 / 母件编码 / 名称')], responses: { 200: jsonResp(null) } },
      post: { tags: ['生产制造'], summary: '新建 BOM（存为草稿）。一个母件 + 一个用途只能有一版，重复建返回 BOM_ALREADY_EXISTS', requestBody: body('BomCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null) } }
    },
    '/api/manufacture/boms/by-sku': { get: { tags: ['生产制造'], summary: '按 SKU 取**生效** BOM（唯一取用口径：已审批 + 在生效期内），另附该母件已有各用途 BOM 供提示', parameters: [q('sku_id', '母件 SKU', true, { type: 'integer' }), q('usage', 'self_made（默认）/ outsourced / combo'), q('date', '业务日期，默认今天')], responses: { 200: jsonResp(null) } } },
    '/api/manufacture/boms/{id}': {
      get: { tags: ['生产制造'], summary: 'BOM 详情（含组件行）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } },
      put: { tags: ['生产制造'], summary: '改 BOM（**已审批的一律拒绝**：BOM_APPROVED_IMMUTABLE，换版请作废后新建）', parameters: [idParam], requestBody: body('BomUpdate'), responses: { 200: jsonResp(null), 400: jsonResp(null) } },
      delete: { tags: ['生产制造'], summary: '删 BOM（**仅草稿**；已审批请作废）', parameters: [idParam], responses: { 200: jsonResp(null), 400: jsonResp(null) } }
    },
    '/api/manufacture/boms/{id}/audit': { post: { tags: ['生产制造'], summary: '审批 BOM（审批后才能用于需求展开）', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null) } } },
    '/api/manufacture/boms/{id}/obsolete': { post: { tags: ['生产制造'], summary: '作废 BOM（留痕；历史单据仍指向当时那一版）', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null) } } },
    '/api/manufacture/boms/{id}/expand': { post: { tags: ['生产制造'], summary: '试算展开（**不改任何数据**）：用量 = 单件用量 × (1+损耗率) × 数量 ÷ 基准批量；替代料按「同组内库存够的优先、其次优先级高」选取并返回取舍理由', parameters: [idParam], requestBody: body('BomExpand'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },

    '/api/manufacture/orders': { get: { tags: ['生产制造'], summary: '生产订单列表（含领料额、完工汇报良品/不良、转换成本与在制剩余）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('status', '订单状态'), q('warehouse_id', '生产仓'), q('keyword', '单号 / 成品编码 / 名称')], responses: { 200: jsonResp(null) } } },
    '/api/manufacture/orders/{id}': { get: { tags: ['生产制造'], summary: '订单详情（BOM / 领料单 / 完工汇报 / 进度一屏）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/manufacture/orders/{id}/requirement': { get: { tags: ['生产制造'], summary: '还需领用的物料清单：BOM 需求（含损耗）− 已出库累计 = 待领量，按 SKU 汇总', parameters: [idParam, q('warehouse_id', '生产仓，默认取订单仓'), q('include_issued', '传 1 时连已领满的行一起返回（前端展示「已领/待领」两列）')], responses: { 200: jsonResp(null) } } },
    '/api/manufacture/orders/{id}/start': { post: { tags: ['生产制造'], summary: '开工（进「生产中」）。**领料与完工入库都要求订单已开工**，否则料会挂在库外、单据上还看不出来', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/manufacture/orders/{id}/complete-preview': { get: { tags: ['生产制造'], summary: '完工入库试算：材料成本 = 已出库领料总额 ÷ 订单数量 × 本次良品；转换成本 = 人工 + 制费；并给出「本次后是否全部完工」', parameters: [idParam, q('report_id', '只试算某一张汇报；不传则该单全部待入库汇报一起算')], responses: { 200: jsonResp(null) } } },
    '/api/manufacture/orders/{id}/complete': { post: { tags: ['生产制造'], summary: '**完工入库**（本模块唯一给库存做加法的动作）：按良品数入库、生成待检批次、回写汇报与订单的成本与完工数；全部完工时订单转「已完工」', parameters: [idParam], requestBody: body('OrderComplete'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },

    '/api/manufacture/issues': {
      get: { tags: ['生产制造'], summary: '领料单列表（分页；可按状态 / 类型 / 订单 / 关键字筛）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('status', 'draft / submitted / approved / issued / cancelled'), q('issue_type', 'by_bom / limit / supplement'), q('order_id', '生产订单'), q('keyword', '领料单号 / 生产订单号')], responses: { 200: jsonResp(null) } },
      post: { tags: ['生产制造'], summary: '新建领料单（草稿）。**不传 items 时按 BOM 自动装填待领量**；限额领料超出 BOM 需求返回 MFG_OVER_ISSUE，补料不填原因返回 MFG_SUPPLEMENT_REASON_REQUIRED', requestBody: body('IssueCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null) } }
    },
    '/api/manufacture/issues/{id}': { get: { tags: ['生产制造'], summary: '领料单详情（含行、实际批次与出库成本、流转留痕）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/manufacture/issues/{id}/submit': { post: { tags: ['生产制造'], summary: '提交领料单（不产生库存后果）', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null) } } },
    '/api/manufacture/issues/{id}/approve': { post: { tags: ['生产制造'], summary: '审批领料单（不产生库存后果）', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null) } } },
    '/api/manufacture/issues/{id}/issue': { post: { tags: ['生产制造'], summary: '**确认出库**（唯一扣库存的动作）：按库存引擎的拣选规则取批、回写实际批次号与出库单价，行金额 = 数量 × 出库单价；单据随即变终态', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },
    '/api/manufacture/issues/{id}/cancel': { post: { tags: ['生产制造'], summary: '取消领料单（已出库的不能取消）', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null) } } },

    '/api/manufacture/reports': {
      get: { tags: ['生产制造'], summary: '完工汇报列表（分页）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('order_id', '生产订单'), q('stock_done', '1 = 已入库 / 0 = 待入库'), q('keyword', '汇报单号 / 生产订单号')], responses: { 200: jsonResp(null) } },
      post: { tags: ['生产制造'], summary: '登记完工汇报（**不推进任何状态、不入库存**：按第三轮口径 G4「生产不报工」，它只作为完工入库的依据）', requestBody: body('WorkReportCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null) } }
    },
    '/api/manufacture/reports/{id}': {
      get: { tags: ['生产制造'], summary: '完工汇报详情', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } },
      put: { tags: ['生产制造'], summary: '改完工汇报（**已入库的一律拒绝**：货已在库里，改数量会让库存账对不上）', parameters: [idParam], responses: { 200: jsonResp(null), 400: jsonResp(null) } },
      delete: { tags: ['生产制造'], summary: '删完工汇报（已入库的不能删）', parameters: [idParam], responses: { 200: jsonResp(null), 400: jsonResp(null) } }
    },

    // ----- 门店 POS（模块 17）：交班 → 缴款 → 长短款 → 日结上传 -----
    // 授权粒度与其它模块不同：门店账号只能看/改自己门店（`requireStore()`），
    // 总部侧只读查询单独挂在 `/hq/*` 前缀下（`HQ_ROLES`），不混在门店端点里。
    '/api/pos/context': { get: { tags: ['门店 POS'], summary: '门店上下文：门店 / 门店仓 / **当前营业中班次** / 该班次系统应收（三段钱的第一段）/ 日结门禁 / 支付方式字典', responses: { 200: jsonResp(null), 403: jsonResp(null) } } },
    '/api/pos/products': { get: { tags: ['门店 POS'], summary: '收银可售商品（含门店仓可用库存与零售价）', parameters: [q('keyword', '名称 / 编码 / 条码'), q('limit', '返回条数')], responses: { 200: jsonResp(null) } } },
    '/api/pos/stocks': { get: { tags: ['门店 POS'], summary: '门店仓库存（按 SKU 汇总可用量）', parameters: [q('keyword', '名称 / 编码')], responses: { 200: jsonResp(null) } } },

    '/api/pos/orders': {
      get: { tags: ['门店 POS'], summary: '本店零售单列表', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('shift_id', '按班次筛'), q('status', 'local / synced / voided'), q('startDate', '开始业务日'), q('endDate', '结束业务日')], responses: { 200: jsonResp(null) } },
      post: { tags: ['门店 POS'], summary: '**开单**（写 `shift_id`：订单归属靠班次外键，不靠「同门店同收银员同日」现算 —— 后者在一天两班时会把现金应收算成两倍且不报错）。必须有营业中班次，无班次直接拒', requestBody: body('PosOrderCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/pos/orders/{id}': { get: { tags: ['门店 POS'], summary: '零售单详情（含行与支付方式）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/pos/orders/{id}/void': { post: { tags: ['门店 POS'], summary: '作废零售单（**货与钱一起退**：反向入库 + 负数冲减该班次系统应收；已进日结批次的不能作废）', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null), 409: jsonResp(null) } } },

    '/api/pos/shifts': { get: { tags: ['门店 POS'], summary: '班次列表（四态 open / declared / closed / cancelled）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('status', '班次状态'), q('cashier_id', '收银员'), q('startDate', '开始业务日'), q('endDate', '结束业务日')], responses: { 200: jsonResp(null) } } },
    '/api/pos/shifts/open': {
      get: { tags: ['门店 POS'], summary: '当前营业中的班次（收银前必读；无班次时返回 null）', responses: { 200: jsonResp(null) } },
      post: { tags: ['门店 POS'], summary: '**开班**（生成 `PSF` 单号与钱箱备用金）。同一收银员同日已有 `open`/`declared` 班次时拒绝 —— 判据是**收银员**不是门店，一家店允许多个钱箱', requestBody: body('PosShiftOpen'), responses: { 200: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/pos/shifts/{id}': { get: { tags: ['门店 POS'], summary: '班次详情一屏：三段钱（系统应收 / 报数 / 实点）+ **按支付方式拆分的差异** + 关联订单 + 缴款记录 + 流转留痕', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/pos/shifts/{id}/declare': { post: { tags: ['门店 POS'], summary: '**报数交班**（第二段钱：收银员按支付方式报数）。此时现金差异恒为 0（没人实点），非现金差异立即成立 —— 移动支付差额是系统/网络问题，与现金差额（人的问题）必须分开', parameters: [idParam], requestBody: body('PosShiftDeclare'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },
    '/api/pos/shifts/{id}/reject': { post: { tags: ['门店 POS'], summary: '退回重报（必填原因；**清空该次报数明细**，不清干净就会拿旧数核款）', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/pos/shifts/{id}/approve': { post: { tags: ['门店 POS'], summary: '**核款**（第三段钱：店长实点，唯一算出长短款的点，`variance = 实点 − 系统应收`）。有差异必须同时给原因与归属；超过 `settings.pos_variance_limit`（默认 500）强制走 `pending` 交总部，门店不能自结', parameters: [idParam], requestBody: body('PosShiftApprove'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },
    '/api/pos/shifts/{id}/settle-variance': { post: { tags: ['门店 POS'], summary: '长短款落案（`charge` 责任人承担 / `absorb` 公司承担）。**不是状态流转** —— 班次已停在 `closed` 终态，这里只改归属字段并留痕', parameters: [idParam], requestBody: body('PosVarianceSettle'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/pos/shifts/{id}/cancel': { post: { tags: ['门店 POS'], summary: '作废班次（**有有效订单的班次不许作废** —— 否则那些订单会挂在没有班次的真空里）', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/pos/shifts/close': { post: { tags: ['门店 POS'], summary: '报数交班的**兼容别名**（旧前端只有一个「交班」按钮，一次调用完成「开班若缺 + 报数」）。新页面请用 `/shifts/open` + `/shifts/{id}/declare`', requestBody: body('PosShiftDeclare'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },

    '/api/pos/cash-drops': {
      get: { tags: ['门店 POS'], summary: '缴款单列表（`pending` 待总部点收 / `received` 已点收 / `cancelled`）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('status', '缴款单状态'), q('startDate', '开始日期'), q('endDate', '结束日期')], responses: { 200: jsonResp(null) } },
      post: { tags: ['门店 POS'], summary: '**创建缴款单**（一个班次只能缴一次款；只允许对已核款的班次缴款）。创建即把班次的 `cash_drop_amount` 占上', requestBody: body('PosCashDropCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/pos/cash-drops/pending-shifts': { get: { tags: ['门店 POS'], summary: '待缴款的班次（已核款 + 实点现金 > 已缴金额）', responses: { 200: jsonResp(null) } } },
    '/api/pos/cash-drops/{id}/receive': { post: { tags: ['门店 POS'], summary: '总部点收（**缴款人与接收人不能是同一人** —— 钱从谁手里交到谁手里必须留两个名字）', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/pos/cash-drops/{id}/cancel': { post: { tags: ['门店 POS'], summary: '取消缴款（**必须把班次的 `cash_drop_amount` 退回去并删明细**，否则这笔钱会在在途看板上永远悬着）', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null), 409: jsonResp(null) } } },

    '/api/pos/daily-close': { post: { tags: ['门店 POS'], summary: '**日结上传**（把本营业日的本地单传成总部 SO + 生成批次）。**核款门禁**：有未核款班次一律拒绝；落单三段现金数 = 参与班次之和', requestBody: body('PosDailyClose'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },
    '/api/pos/daily-closes': { get: { tags: ['门店 POS'], summary: '本店日结批次列表（含三段现金数与缴款额）', parameters: [q('page', '页码'), q('pageSize', '每页条数')], responses: { 200: jsonResp(null) } } },
    // 总部确认日结（RC uploaded → confirmed）。日结单由门店 `POST /pos/daily-close` 建、建单即 `uploaded`，
    // 而 **confirm 从来没有门** ⇒ 三库 10/40/10 张**全部停在「已上传」**，门店交的款永远没人确认过。
    // 纯状态推进 + 留痕（把「谁确认的」记进去），不动钱、不动库存。
    '/api/pos/daily-closes/{id}/confirm': { post: { tags: ['门店 POS'], summary: '总部确认日结（RC uploaded → confirmed；纯状态，不动钱不动库存）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },

    '/api/pos/returns': {
      get: { tags: ['门店 POS'], summary: '门店退货列表（渠道为 store 的那一类）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('status', '状态')], responses: { 200: jsonResp(null) } },
      post: { tags: ['门店 POS'], summary: '**门店退货**（货回门店仓，入库成本取门店仓**当前成本价**，不能用售价 —— 用售价会让门店仓的存货金额凭空变高）+ 一条负数零售单冲减班次系统应收。必须挂营业中班次', requestBody: body('PosReturnCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } }
    },

    '/api/pos/stock-checks': {
      get: { tags: ['门店 POS'], summary: '门店盘点单列表（盘点表里 scope 为 store 的那一类，与总部盘点同表不同范围）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('status', '状态')], responses: { 200: jsonResp(null) } },
      post: { tags: ['门店 POS'], summary: '建盘点单（可按 `sku_ids` 只盘部分商品；不传则整店）。草稿时**只带账面数**，实盘数由 `PUT /items` 填', requestBody: body('PosStoreCheckCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null) } }
    },
    '/api/pos/stock-checks/{id}': { get: { tags: ['门店 POS'], summary: '盘点单详情（含明细与差异）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/pos/stock-checks/{id}/items': { put: { tags: ['门店 POS'], summary: '提交实盘数（**账面数一律从库里取，不信客户端传的 `book_qty`** —— 否则前端截了个旧页面就能把差异抹平）', parameters: [idParam], responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/pos/stock-checks/{id}/adjust': { post: { tags: ['门店 POS'], summary: '盘点过账（**唯一动库存的动作**）：盘盈入库 / 盘亏出库，差异写入成本台账', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null), 409: jsonResp(null) } } },

    '/api/pos/hq/overview': { get: { tags: ['门店 POS'], summary: '总部总览：门店数 / 今日开单与销售额 / 待核款班次 / 资金在途总额', responses: { 200: jsonResp(null) } } },
    '/api/pos/hq/cash-inflight': { get: { tags: ['门店 POS'], summary: '**资金在途看板**（唯一口径来自 `v_pos_cash_inflight`）：各门店待缴现金 / 长短款合计 / 待核款班次 / 营业中班次', responses: { 200: jsonResp(null) } } },
    '/api/pos/hq/daily-closes': { get: { tags: ['门店 POS'], summary: '总部日结批次查询（跨门店）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('store_id', '门店'), q('startDate', '开始业务日'), q('endDate', '结束业务日')], responses: { 200: jsonResp(null) } } },
    '/api/pos/hq/orders': { get: { tags: ['门店 POS'], summary: '总部零售单查询（跨门店）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('store_id', '门店'), q('status', '状态'), q('startDate', '开始业务日'), q('endDate', '结束业务日'), q('keyword', '单号')], responses: { 200: jsonResp(null) } } },
    '/api/pos/hq/shifts': { get: { tags: ['门店 POS'], summary: '总部班次查询（跨门店；含长短款与处理归属）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('store_id', '门店'), q('status', '班次状态'), q('variance_handled', '短款归属 charge / absorb / pending'), q('startDate', '开始业务日'), q('endDate', '结束业务日')], responses: { 200: jsonResp(null) } } },
    '/api/pos/hq/shifts/{id}': { get: { tags: ['门店 POS'], summary: '总部查看某班次详情（三段钱 + 支付方式差异 + 缴款；只读）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },

    // —— 模块 18 促销与会员（营销域，独立前缀）——
    // 与 /api/mall 的分界：/api/mall 面向 C 端免登录（手机号即身份）；
    // /api/promo 面向内部员工，按 mall.* 权限收口。唯一的交叠是 /api/promo/shop/*。
    '/api/promo/meta': { get: { tags: ['促销与会员'], summary: '营销字典：促销类型 / 分配方式 / 作用目标 / 券状态 / 积分与储值种类 / 等级 / 规则属性白名单与操作符 / 口径设置', responses: { 200: jsonResp(null) } } },
    '/api/promo/overview': { get: { tags: ['促销与会员'], summary: '营销总览（活动 / 促销 / 券的发放与核销 / 会员数与积分储值余额 / 等级分布 / 累计优惠额）', responses: { 200: jsonResp(null) } } },
    '/api/promo/audit': { get: { tags: ['促销与会员'], summary: '自洽审计：账户余额 = 流水合计、券的已核销必须有核销时间、模板发行量与实例数一致、促销 used 计数器与使用登记一致、优惠留痕不指向已删促销、客户冗余等级与账户等级一致', responses: { 200: jsonResp(null) } } },

    '/api/promo/levels': { get: { tags: ['促销与会员'], summary: '会员等级与权益（门槛 = 累计积分 **与** 累计消费同时满足；折扣用万分比，10000 = 不打折）', responses: { 200: jsonResp(null) } } },
    '/api/promo/levels/{code}': { put: { tags: ['促销与会员'], summary: '编辑等级权益（折扣率 / 积分倍率 / 抵扣上限 / 门槛 / 权益说明）。折扣率超过 10000 或为 0 会被拒 —— 前者是倒贴、后者是全场 0 元', parameters: [p('code', '等级编码 normal/silver/gold/platinum')], requestBody: body('MemberLevelUpdate'), responses: { 200: jsonResp(null), 400: jsonResp(null), 404: jsonResp(null) } } },

    '/api/promo/campaigns': {
      get: { tags: ['促销与会员'], summary: '活动列表（含各活动下的促销数、生效数与累计优惠额）', parameters: [q('status', 'active / ended'), q('keyword', '编码或名称')], responses: { 200: jsonResp(null) } },
      post: { tags: ['促销与会员'], summary: '新建活动（促销的容器：共享档期与预算）', requestBody: body('PromoCampaignCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/promo/campaigns/{id}/status': { post: { tags: ['促销与会员'], summary: '启停活动（active / ended）', parameters: [idParam], requestBody: body('StatusOnly'), responses: { 200: jsonResp(null), 404: jsonResp(null) } } },

    '/api/promo/promotions': {
      get: { tags: ['促销与会员'], summary: '促销列表（分页；按生效优先、优先级、id 倒序）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('status', 'active / inactive'), q('keyword', '编码或名称')], responses: { 200: jsonResp(null) } },
      post: { tags: ['促销与会员'], summary: '新建促销（含唯一一个优惠方式与三组规则：rules 订单条件 / target_rules 作用对象 / buy_rules 买赠条件）', requestBody: body('PromotionCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/promo/promotions/validate': { post: { tags: ['促销与会员'], summary: '促销草稿预检（**只校验不落库**）：编码必填、时间窗不得写反、percentage 的 value 是万分比（>10000 会被拒）、once 必须给件数、买赠必须给门槛与赠品、独占与同组互斥不得同时设置、规则属性走白名单', requestBody: body('PromotionCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/promo/promotions/{id}': {
      get: { tags: ['促销与会员'], summary: '促销详情（含优惠方式、三组规则、使用汇总）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } },
      put: { tags: ['促销与会员'], summary: '编辑促销（未传的字段保留原值，不会当成清空）。有使用记录后编码锁定 —— 优惠留痕按 code 回查', parameters: [idParam], requestBody: body('PromotionCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } },
      delete: { tags: ['促销与会员'], summary: '删除促销。有使用记录或被券模板引用时拒绝（停用请走 /status）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/promo/promotions/{id}/status': { post: { tags: ['促销与会员'], summary: '启停促销（active / inactive）', parameters: [idParam], requestBody: body('StatusOnly'), responses: { 200: jsonResp(null), 404: jsonResp(null) } } },

    '/api/promo/quote': { post: { tags: ['促销与会员'], summary: '**试算**（纯读、不写库）：算钱顺序 会员折扣 → 促销优惠 → 积分抵扣。返回命中链、逐行分摊（行优惠合计恒等于整单优惠，不平即抛错）与可用券；`auto_coupon` 默认 false —— 不显式声明就一张券都不会替你用', requestBody: body('PromoQuote'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/promo/explain': { post: { tags: ['促销与会员'], summary: '试算并生成人类可读的解释链（「哪个活动生效 / 哪个被谁拦下、为什么」）', requestBody: body('PromoQuote'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/promo/settle': { post: { tags: ['促销与会员'], summary: '**落单**：写优惠留痕 + 登记使用（幂等键防重复）+ 核销券 + 送积分，全在一个事务里；送分基数用实付金额', requestBody: body('PromoSettle'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/promo/unsettle': { post: { tags: ['促销与会员'], summary: '**撤单**：成对回退上面四件事。积分回收按当前可用余额封顶并报出 `shortfall` —— 客户已把分花掉时不抛错（否则会留下「券退了、分没扣」的半截状态）', requestBody: body('PromoUnsettle'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },

    '/api/promo/coupons': {
      get: { tags: ['促销与会员'], summary: '券模板列表（分页）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('status', 'active / paused / ended'), q('keyword', '编码或名称')], responses: { 200: jsonResp(null) } },
      post: { tags: ['促销与会员'], summary: '新建券模板。券**必须绑定一张促销** —— 优惠额由促销引擎算，券表里的 type/value 只是列表页展示用的冗余；不绑的券领了也用不了', requestBody: body('CouponCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/promo/coupons/expire': { post: { tags: ['促销与会员'], summary: '把已到期券批量落库为 expired（查询侧本来就按 expires_at 现算，这一步是为了统计口径能算出来）', requestBody: body('AtOnly'), responses: { 200: jsonResp(null) } } },
    '/api/promo/coupons/{id}': {
      get: { tags: ['促销与会员'], summary: '券模板详情（含绑定的促销与剩余可发张数）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } },
      put: { tags: ['促销与会员'], summary: '编辑券模板。发行量不能小于已发数量；已开始发放的券不能换绑促销（否则已领券的减免额会变）', parameters: [idParam], requestBody: body('CouponCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null), 404: jsonResp(null) } }
    },
    '/api/promo/coupons/{id}/status': { post: { tags: ['促销与会员'], summary: '启停券模板', parameters: [idParam], requestBody: body('StatusOnly'), responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/promo/coupons/{id}/issue': { post: { tags: ['促销与会员'], summary: '给指定客户发券（N 张；受模板总量与每人限领双约束）', parameters: [idParam], requestBody: body('CouponIssue'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/promo/coupon-instances': { get: { tags: ['促销与会员'], summary: '券实例列表（按客户 / 模板 / 状态筛；含按 expires_at 现算的 effective_status）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('customer_id', '客户'), q('coupon_id', '券模板'), q('status', 'unused / used / expired / void')], responses: { 200: jsonResp(null) } } },
    '/api/promo/coupon-instances/{id}/void': { post: { tags: ['促销与会员'], summary: '作废一张券（必填原因）', parameters: [idParam], requestBody: body('RemarkOnly'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },

    '/api/promo/members': { get: { tags: ['促销与会员'], summary: '会员列表（按累计消费倒序；含等级、可用积分、累计积分、储值、券数）', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('keyword', '手机号或姓名'), q('level_code', '等级')], responses: { 200: jsonResp(null) } } },
    '/api/promo/members/{customerId}': { get: { tags: ['促销与会员'], summary: '会员详情：账户 + 当前等级与权益 + 到下一级还差多少（积分与消费分别给，因为门槛是「与」关系）+ 抵扣报价 + 券包 + 券统计', parameters: [p('customerId', '商城客户 id')], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/promo/members/{customerId}/ledger': { get: { tags: ['促销与会员'], summary: '会员流水（**余额的唯一真相**；`kind=points` 积分 / `kind=balance` 储值，单位为分）。每行带 `balance_after` 可回放到任意时点', parameters: [p('customerId', '客户 id'), q('kind', 'points / balance'), q('page'), q('pageSize')], responses: { 200: jsonResp(null) } } },
    '/api/promo/members/{customerId}/points': { post: { tags: ['促销与会员'], summary: '**人工调整积分**（必填理由；调整会写一条 adjust 流水并当场对账）', parameters: [p('customerId', '客户 id')], requestBody: body('MemberPointsAdjust'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/promo/members/{customerId}/balance': { post: { tags: ['促销与会员'], summary: '储值充值（kind=recharge，走 doc_no）或人工调整（kind=adjust，必填理由）。充值不能为负、消费不能透支', parameters: [p('customerId', '客户 id')], requestBody: body('MemberBalanceChange'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/promo/members/{customerId}/level': { post: { tags: ['促销与会员'], summary: '**人工指定等级**（必填理由）。会把累计门槛一并抬到达标线，避免下一次送分被自动判定改回去', parameters: [p('customerId', '客户 id')], requestBody: body('MemberLevelSet'), responses: { 200: jsonResp(null), 400: jsonResp(null), 404: jsonResp(null) } } },
    '/api/promo/members/{customerId}/sync': { post: { tags: ['促销与会员'], summary: '按规则重判等级（`force=true` 时无视 `member_upgrade_auto` 开关）', parameters: [p('customerId', '客户 id')], requestBody: body('ForceOnly'), responses: { 200: jsonResp(null) } } },
    '/api/promo/members/{customerId}/coupons': { post: { tags: ['促销与会员'], summary: '给该客户发券：传 `coupon_id` 按模板发 N 张，传 `coupon_code` 则为指定券补发', parameters: [p('customerId', '客户 id')], requestBody: body('MemberCouponIssue'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },

    // —— C 端（商城 H5）——
    // ⚠️ 身份一律取 **C 端会话**（`x-mall-token`，见 `middleware/mall-session.js`）。
    // 这一段原来标的是「免登录，手机号即身份」：`phone` 从查询串/请求体里取。
    // 手机号是公开标识（印在快递单上），不是凭据 —— 知道一个手机号就能读他的
    // 会员等级/积分/储值/券包，还能替他领券。A16 收口时只改了 `routes/mall.js`，
    // 这三个端点是漏网的那一个入口。
    '/api/promo/shop/member': { get: { tags: ['促销与会员'], summary: '**C 端**会员中心：等级与权益、积分、储值、券包与券统计（身份取会话）', security: [{ mallToken: [] }], responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/promo/shop/promotions': { get: { tags: ['促销与会员'], summary: '**C 端**活动墙：当前生效且无需券码即可参与的自动促销（公共数据，无需登录）', responses: { 200: jsonResp(null) }, security: [] } },
    '/api/promo/shop/quote': { post: { tags: ['促销与会员'], summary: '**C 端**下单前试算（身份取会话；不暴露内部轨迹与成本口径，只给能不能用、减多少）', requestBody: body('PromoQuote'), security: [{ mallToken: [] }], responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/promo/shop/claim': { post: { tags: ['促销与会员'], summary: '**C 端**自助领券（发给**会话本人**，受模板总量与每人限领约束）', requestBody: body('ShopClaim'), security: [{ mallToken: [] }], responses: { 200: jsonResp(null), 400: jsonResp(null) } } },

    // —— 门店收银试算（模块 17 与模块 18 的接缝）——
    // 与落单 `POST /api/pos/orders` 共用 `lib/pos2.js` 的 `posQuote()`：
    // 同一份算钱判据，界面上显示的应收与落库的 `pay_amount` 不会分叉。
    '/api/pos/quote': {
      post: {
        tags: ['看板'],
        summary: '**收银台试算**（纯读）：商品额 / 手工让利 / 会员折扣 / 活动优惠 / 积分抵扣 / 应收',
        requestBody: body('PosQuote'),
        responses: { 200: jsonResp(null), 400: jsonResp(null) }
      }
    },

    // —— 渠道管理 DMS（批次 G）：协议价档案 + 返利计提 / 试算 / 核销 ——
    // 独立前缀的理由：经销商档案是**主数据**，协议价与返利是**政策与结算**，
    // 两者的授权粒度不同（前者看档案、后者看财务），混在一个前缀下会让
    // "能改客户电话的人"顺手能核销返利。
    '/api/dms/meta': { get: { tags: ['渠道管理'], summary: '字典：协议目标 / 价格形态 / 政策类型 / 返利与核销状态', responses: { 200: jsonResp(null) } } },

    '/api/dms/agreements': {
      get: {
        tags: ['渠道管理'],
        summary: '协议价列表（可按经销商 / 状态 / 关键字筛）',
        parameters: [q('dealer_id', '经销商', false, { type: 'integer' }), q('status', 'active/inactive'), q('keyword', '编码或名称'), q('page', '页码'), q('pageSize', '每页条数')],
        responses: { 200: jsonResp(null) }
      },
      post: { tags: ['渠道管理'], summary: '新建协议价（销售 / 财务 / 管理员）；不传 code 时按 XY+年+4 位序号自生成', requestBody: body('PriceAgreement'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/dms/agreements/explain': {
      get: {
        tags: ['渠道管理'],
        summary: '**协议价接入取价链的证据接口**：调 `resolvePrice`（与销售开单同一条路径）并返回 `rule` + 轨迹，同时给出"不带经销商时的价"作为对照',
        parameters: [q('sku_id', 'SKU', true, { type: 'integer' }), q('dealer_id', '经销商', false, { type: 'integer' }), q('dealer_level', '经销商等级'), q('channel', '渠道'), q('store_type', '门店类型'), q('region', '区域'), q('qty', '数量', false, { type: 'integer' })],
        responses: { 200: jsonResp(null), 400: jsonResp(null) }
      }
    },
    '/api/dms/agreements/{id}': {
      get: { tags: ['渠道管理'], summary: '协议价详情', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } },
      put: { tags: ['渠道管理'], summary: '修改协议价（改价会写入价格变更留痕）', parameters: [idParam], requestBody: body('PriceAgreement'), responses: { 200: jsonResp(null), 400: jsonResp(null) } }
    },
    '/api/dms/agreements/{id}/status': { post: { tags: ['渠道管理'], summary: '启用 / 停用协议价（停用后取价**立刻**不再命中）', parameters: [idParam], responses: { 200: jsonResp(null), 400: jsonResp(null) } } },

    '/api/dms/policies': {
      get: { tags: ['渠道管理'], summary: '返利政策列表（阶梯 / 按件定额 / 同比增量 / 回款达标 / 品类专返 / 档期任务）', parameters: [q('type', '政策类型'), q('status', 'active/inactive'), q('page', '页码'), q('pageSize', '每页条数')], responses: { 200: jsonResp(null) } },
      post: { tags: ['渠道管理'], summary: '新建返利政策（销售 / 财务 / 管理员）', requestBody: body('RebatePolicy'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/dms/rebates': { get: { tags: ['渠道管理'], summary: '返利记录（按经销商 / 期间 / 状态筛）', parameters: [q('dealer_id', '经销商', false, { type: 'integer' }), q('period', '期间 YYYY-MM'), q('status', 'pending/confirmed/paid'), q('page', '页码'), q('pageSize', '每页条数')], responses: { 200: jsonResp(null) } } },
    '/api/dms/rebates/plan': { post: { tags: ['渠道管理'], summary: '**返利试算**（纯读）：这一期该返多少、为什么（逐政策给 `basis_desc`）', requestBody: body('RebatePlan'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/dms/rebates/accrue': { post: { tags: ['渠道管理'], summary: '**返利计提**：试算落成待核算记录。幂等 —— 已确认 / 已核销的行一律**不覆盖**并如实报出', requestBody: body('RebatePlan'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/dms/rebates/{id}/confirm': { post: { tags: ['渠道管理'], summary: '确认单笔返利（pending → confirmed；状态机不做跳级）', parameters: [idParam], responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/dms/rebates/settle': {
      post: {
        tags: ['渠道管理'],
        summary: '**返利核销**：把某期已确认的返利汇成一张核销单并**冲减该客户的未核销应收**。只减不增（不生成负数应收），冲不下的部分登记为 `unoffset_amount`；带 `idempotency_key` 时重放返回同一张单',
        requestBody: body('RebateSettle'),
        responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) }
      }
    },
    '/api/dms/settlements': { get: { tags: ['渠道管理'], summary: '返利核销单列表', parameters: [q('dealer_id', '经销商', false, { type: 'integer' }), q('period', '期间 YYYY-MM'), q('status', '状态'), q('page', '页码'), q('pageSize', '每页条数')], responses: { 200: jsonResp(null) } } },
    '/api/dms/settlements/{id}': { get: { tags: ['渠道管理'], summary: '核销单详情（含逐笔返利的冲减分摊）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/dms/rebate-audit': { get: { tags: ['渠道管理'], summary: '**返利域自证**：已核销必挂单 / 明细合计 = 总额 / 冲减 + 未冲 = 总额', responses: { 200: jsonResp(null) } } },

    // ---------------------------------------------------------------------
    // 财务中心 · 业财一体凭证（模块 27 · 批次 H）
    //
    // 这一域**刻意没有"新建凭证"的端点**：一张凭证的来源由
    // `(biz_type, source_type, source_id)` 唯一决定，界面上只有"生成"。
    // 手工编分录的口子一开，"这张凭证是哪来的"就再也答不出来，
    // 而编出来的账同样是平的 —— 平账骗得过所有不变量。
    // ---------------------------------------------------------------------
    '/api/accounting/meta': { get: { tags: ['财务凭证'], summary: '字典：业务场景 / 取数键 / 科目类别 / 余额方向 / 默认税率', responses: { 200: jsonResp(null) } } },

    '/api/accounting/subjects': {
      get: { tags: ['财务凭证'], summary: '会计科目列表（可带关键词 / 只看可记账的叶子科目）', parameters: [q('keyword', '编码或名称'), q('only_leaf', '只看叶子科目（1/0）')], responses: { 200: jsonResp(null) } },
      post: { tags: ['财务凭证'], summary: '新建或更新科目（财务 / 管理员）；父科目的 `is_leaf` 由结构推导，不人工维护', requestBody: body('AccountingSubject'), responses: { 200: jsonResp(null), 400: jsonResp(null) } }
    },
    '/api/accounting/subjects/tree': { get: { tags: ['财务凭证'], summary: '科目树（父 → 子）', responses: { 200: jsonResp(null) } } },
    '/api/accounting/subjects/{id}': { put: { tags: ['财务凭证'], summary: '修改科目（编码不可改：它是历史凭证上的对外标识）', parameters: [idParam], requestBody: body('AccountingSubject'), responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/accounting/subjects/{id}/status': { post: { tags: ['财务凭证'], summary: '启用 / 停用科目（已被分录用过或有子科目时拒绝停用）', parameters: [idParam], responses: { 200: jsonResp(null), 409: jsonResp(null) } } },

    '/api/accounting/templates': { get: { tags: ['财务凭证'], summary: '凭证模板列表（含分录模板与取数键）', responses: { 200: jsonResp(null) } } },
    '/api/accounting/templates/{bizType}': { get: { tags: ['财务凭证'], summary: '单个业务场景的模板（含样例取数袋）', parameters: [idParam], responses: { 200: jsonResp(null), 409: jsonResp(null) } } },

    '/api/accounting/vouchers': {
      get: {
        tags: ['财务凭证'],
        summary: '凭证列表',
        parameters: [q('period', '期间 YYYY-MM'), q('biz_type', '业务场景'), q('status', 'draft / posted / voided'), q('source_doc_no', '来源单号模糊'), q('page', '页码'), q('pageSize', '每页条数')],
        responses: { 200: jsonResp(null) }
      }
    },
    '/api/accounting/vouchers/plan': { post: { tags: ['财务凭证'], summary: '**试算（纯读，不落库）**：算出这张来源单的分录并做借贷平衡校验；与"生成"走**同一个函数**，所以预览与落库必然一致', requestBody: body('VoucherGenerate'), responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/accounting/vouchers/generate': {
      post: {
        tags: ['财务凭证'],
        summary: '**生成凭证**（财务 / 管理员）：从来源单据按模板取数生成分录。三条硬口径 —— 借贷**不平即拒绝且整张不落库**；同一来源唯一（重放返回同一张）；只能挂**叶子科目**',
        requestBody: body('VoucherGenerate'),
        responses: { 200: jsonResp(null), 400: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) }
      }
    },
    '/api/accounting/vouchers/{id}': { get: { tags: ['财务凭证'], summary: '凭证详情（头 + 分录，含来源反查）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/accounting/vouchers/{id}/post': { post: { tags: ['财务凭证'], summary: '凭证过账（`draft → posted`）。过账是**入账**：再校验一次借贷平衡，只有 `posted` 计入试算平衡表', parameters: [idParam], responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/accounting/vouchers/{id}/void': { post: { tags: ['财务凭证'], summary: '凭证作废（高危）：作废已过账凭证**必须写理由** —— 作废会改变当期发生额', parameters: [idParam], requestBody: body('VoucherVoid'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },
    '/api/accounting/vouchers/by-source/{sourceType}/{sourceId}': { get: { tags: ['财务凭证'], summary: '反查：某张来源单据生成过哪些凭证（"这笔记过账没有"）', responses: { 200: jsonResp(null) } } },

    // ---- AI 与 MCP：能力目录（前端「AI 与 MCP 控制台」页）----
    // 说明：MCP 业务端点本身走 POST /mcp（JSON-RPC 2.0，非 REST），不在这里登记；
    // 这里登记的是**管理面**的 REST 接口。数据全部由内核三张表推导，页面不写死名单。
    '/api/mcp/catalog': { get: { tags: ['AI 与 MCP'], summary: '**AI 能力目录**：全部单据类型 × 状态机 × 可推进边（含高危标注）× 工具清单 × 安全边界。由 `doc_types`/`doc_states`/`doc_actions` 实时推导', responses: { 200: jsonResp(null), 403: jsonResp(null) } } },
    '/api/mcp/limits/tokens': { get: { tags: ['AI 与 MCP'], summary: 'MCP 每令牌近期限流（需 system.mcp.manage，只读）：store（memory|db）/ window_seconds / truncated（超过 500 张时 true，触顶令牌优先）/ tokens[{id,name,rate_limited_recent}]。db 模式下 rate_limited_recent = 当前+上一窗口里该令牌被速率额度拒绝（429）的精确次数（来自迁移 075 的 denied 行；拒绝行写失败的那一次不计）；memory 模式 tokens 恒为空。不含令牌前缀/哈希/明文（AF11）', responses: { 200: jsonResp(null), 403: jsonResp(null) } } },
    '/api/mcp/limits/quota': { get: { tags: ['AI 与 MCP'], summary: 'MCP 每令牌今日日配额用量（需 system.mcp.manage，只读，游标分页）：daily_quota（0=关闭）/ enabled / usage_unavailable / truncated（还有后续页，= next_cursor 非空）/ next_cursor（不透明游标，null=没有更多）/ tokens[{id,name,used,remaining}]（仅在用令牌，次序固定 used 降序再 id 升序；口径同 dailyQuotaState：本地日历日的 mcp_call_logs 行数）。配额关闭时 tokens 为空。不含令牌前缀/哈希/明文（AG9、AH9）', parameters: [q('limit', '每页条数，1..500，默认 100，超过 500 取 500；非整数或小于 1 返回 400'), q('cursor', '上一页返回的 next_cursor；不合规返回 400。游标是位置而非快照：翻页期间用量变大的令牌只会往前挪，不会重复')], responses: { 200: jsonResp(null), 400: jsonResp(null), 403: jsonResp(null) } } },
    '/api/mcp/limits': { get: { tags: ['AI 与 MCP'], summary: 'MCP 限速读数（需 system.mcp.manage，只读）：rpm / write_rpm / window_seconds / daily_quota（0=关闭）/ rate_limited_total（本进程自启动以来的 429 次数，重启归零）/ counter_scope=process。不含令牌信息（AE11）', responses: { 200: jsonResp(null), 403: jsonResp(null) } } },
    '/api/mcp/tools': { get: { tags: ['AI 与 MCP'], summary: 'MCP 工具清单（名称 / 级别 / 用途），供令牌白名单勾选', responses: { 200: jsonResp(null) } } },
    '/api/mcp/tokens': {
      get: { tags: ['AI 与 MCP'], summary: 'Agent Token 列表（需 system.mcp.manage）。每行带 `effective_status`（active / revoked / expired / owner_missing / owner_inactive / revoked_by_owner_change）与 `effective_reason`、`revoked_reason`、`revoked_at`、所有者信息；`status` 是行历史，`effective_status` 是现状（ADR-0015）', responses: { 200: jsonResp(null), 403: jsonResp(null) } },
      post: { tags: ['AI 与 MCP'], summary: '签发 Agent Token（有主：所有者 = 当前登录人；明文只返回一次）', responses: { 200: jsonResp(null), 400: jsonResp(null), 403: jsonResp(null) } }
    },
    '/api/mcp/tokens/sweep': { post: { tags: ['AI 与 MCP'], summary: '清扫：把所有者 auth_version 已变 / 所有者已不存在、但行仍 active 的令牌置为 revoked 并记 `revoked_reason`（幂等；返回 swept / ids）', responses: { 200: jsonResp(null), 403: jsonResp(null) } } },
    '/api/mcp/tokens/{id}': {
      get: { tags: ['AI 与 MCP'], summary: 'Agent Token 详情（字段与列表同一份，含 effective_status）', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } },
      delete: { tags: ['AI 与 MCP'], summary: '吊销 Agent Token（revoked_reason=admin）', parameters: [idParam], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null) } }
    },
    '/api/mcp/scopes': { get: { tags: ['AI 与 MCP'], summary: '令牌可用范围（组织 / 门店 / 仓库 等）', responses: { 200: jsonResp(null) } } },
    '/api/mcp/logs': { get: { tags: ['AI 与 MCP'], summary: 'MCP 工具调用审计日志', parameters: [q('limit', '返回条数，上限 500'), q('token_id', 'Agent Token ID'), q('level', 'read/write/danger'), q('ok', '0 仅看失败')], responses: { 200: jsonResp(null), 403: jsonResp(null) } } },
    '/api/mcp/confirmations': { get: { tags: ['AI 与 MCP'], summary: '高危 MCP 动作人工确认列表', responses: { 200: jsonResp(null), 403: jsonResp(null) } } },
    '/api/mcp/confirmations/{token}/approve': { post: { tags: ['AI 与 MCP'], summary: '批准一项绑定原始参数的 MCP 高危动作；申请人不可自批', parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonResp(null), 403: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/mcp/confirmations/{token}/reject': { post: { tags: ['AI 与 MCP'], summary: '拒绝一项 MCP 高危动作确认申请', parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonResp(null), 400: jsonResp(null), 404: jsonResp(null) } } },
    '/api/accounting/trial-balance': { get: { tags: ['财务凭证'], summary: '**试算平衡表**：按科目汇总已过账分录，给借合计 / 贷合计 / 差额与余额方向（余额方向由科目自身方向决定，不靠"借减贷"正负去猜）', parameters: [q('period', '期间 YYYY-MM'), q('from', '起始记账日'), q('to', '截止记账日')], responses: { 200: jsonResp(null) } } },
    '/api/accounting/trial-balance/detail': { get: { tags: ['财务凭证'], summary: '**试算平衡表逐行展开**：某科目在同一筛选条件下的全部分录明细（含逐笔余额）。与汇总表**共用同一个 where**（`trialBalanceFilter`），所以"明细借贷合计 = 汇总行"是必然的；超上限时如实回报 `truncated` / `total_count`，不静默截断', parameters: [q('period', '期间 YYYY-MM'), q('from', '起始记账日'), q('to', '截止记账日'), q('subjectCode', '科目编码（与 subjectId 二选一）'), q('subjectId', '科目 id'), q('limit', '返回条数上限，默认 500 / 上限 2000')], responses: { 200: jsonResp(null), 400: jsonResp(null), 404: jsonResp(null) } } },
    '/api/accounting/audit': { get: { tags: ['财务凭证'], summary: '**凭证域自证**：分录金额为正 / 凭证平衡 / 头 = 分录合计 / 只挂叶子科目 / 来源真实存在 / 同一事实只入一次账 / 总账试算平衡', responses: { 200: jsonResp(null) } } },

    // —— 退款单（批次 J）：把销售退货登记的「待退款」兑现成一次真实出账 ——
    // 独立前缀：退款与退货的授权粒度不同（谁能放钱 vs 谁能退货），
    // 且它与收款单是**方向相反**的两类资金单据。
    '/api/refunds/meta': { get: { tags: ['退款管理'], summary: '字典：退款状态 / 退款方式 / 来源类型', responses: { 200: jsonResp(null) } } },
    '/api/refunds/refundables': { get: { tags: ['退款管理'], summary: '可退清单：待退款余额 > 0 的退货单（含客户与已退 / 可退金额）', parameters: [q('customer_type', 'dealer / store / walkin'), q('customer_id', '客户 id'), q('keyword', '单号或客户名')], responses: { 200: jsonResp(null) } } },
    '/api/refunds/audit': { get: { tags: ['退款管理'], summary: '**退款域自证**：头行一致 / 已退款必有确认人 / 作废必有理由 / 无孤儿明细 / 累计已退 ≤ 待退款', responses: { 200: jsonResp(null) } } },
    '/api/refunds': {
      get: { tags: ['退款管理'], summary: '退款单列表', parameters: [q('page', '页码'), q('pageSize', '每页条数'), q('status', 'draft / confirmed / voided'), q('customer_type', '客户类型'), q('customer_id', '客户 id'), q('keyword', '单号 / 客户名 / 流水号')], responses: { 200: jsonResp(null) } },
      post: { tags: ['退款管理'], summary: '登记退款单（草稿，**钱不动**）。退款上限 =（退货单的待退款额 − 已确认退款额）按单累计；超退 / 负金额 / 跨客户一律拒绝', requestBody: body('RefundCreate'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/refunds/{id}': { get: { tags: ['退款管理'], summary: '退款单详情（含分摊明细与各退货单当前可退余额）', parameters: [idParam], responses: { 200: jsonResp(null), 404: jsonResp(null) } } },
    '/api/refunds/{id}/confirm': { post: { tags: ['退款管理'], summary: '**确认退款（这一步才出账）**：`draft → confirmed`。确认前**重验**一次额度（建单时合法 ≠ 确认时合法）；重复确认幂等，不重复出账', parameters: [idParam], responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/refunds/{id}/void': { post: { tags: ['退款管理'], summary: '作废退款单。已退款的作废是**高危动作**：必须写理由（它会让一笔已出的钱从账上消失）', parameters: [idParam], requestBody: body('RefundVoid'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },

    // ---- 财务报表（批次 L · 模块 28）----
    // 读取类全部要求 `finance.report.view`；维护类按**四个独立权限点**分开授权：
    //   改报表口径（会计政策）/ 关账（挡记账）/ 反关账（让已定稿期间重新可变）/ 改期初（改变之后每一期）。
    '/api/reports/meta': { get: { tags: ['财务报表'], summary: '字典：报表定义 / 取数口径 / 行类型 / 期间状态 / 比较模式（含自定义基期）/ **区间模式（累计，带 applicable_basis 供界面禁用）** / 可用期间', responses: { 200: jsonResp(null) } } },
    // —— 现金流量项目（批次 U）：把现金流量表从"靠对手科目猜"变成"按项目填列" ——
    // 项目比报表行细（内置 22 项 → 现金流量表 10 个科目行），所以字典里有一列显式的落点
    // （`report_line_code`）；标了却落不到行上的会**如实计入** `tagged_unresolved_count`
    // 并退回分析填列，不静默丢账。归属与预算无关，唯一判据是"这一笔钱是什么性质"。
    '/api/reports/cashflow-items': { get: { tags: ['财务报表'], summary: '**现金流量项目字典**：code（机器键）/ 名称 / 类别（经营·投资·筹资）/ 方向（流入·流出）/ 是否内置 / **落到现金流量表的哪一行**（`report_line_code`）/ 排序 / 状态。归集时优先按它走，未标记的才退回按对手科目分析', parameters: [q('category', '只看某一类 operating / investing / financing'), q('status', '只看某个状态 active / inactive'), q('keyword', '按 code 或名称模糊查')], responses: { 200: jsonResp(null) } } },
    '/api/reports/cashflow-items/meta': { get: { tags: ['财务报表'], summary: '现金流量项目元数据：类别与方向的**标签**（界面不自己拼中文）+ 四个如实计数（总数 / 启用数 / 已配落点数 / **落点失效数** `orphan_count`——项目指向的报表行被删了，挂在这些项目上的标记会退回分析）', responses: { 200: jsonResp(null) } } },
    '/api/reports/vouchers/{id}/tag-cashflow': {
      post: {
        tags: ['财务报表'],
        summary: '**给一张凭证的分录打 / 改 / 清「现金流量项目」标记**（现金流量表按项目填列的唯一入口）。拒绝四种标法：凭证不存在或已作废 · 行号不属于这张凭证 · 项目不在字典里或已停用 · **给现金类科目的分录打标记**（标的是对手方那一笔，现金分录本身是"钱动了"这个事实）。**改动已经标过的分录必须写理由**（危险是差分驱动的：第一次标是日常，改一笔已定性的钱等于改报表一行的金额）',
        parameters: [idParam],
        requestBody: {
          required: true,
          description: '`{ entries: [{ line_no, cash_flow_item }], reason? }`；行号就是**分录的 `seq`**（凭证详情接口里的那个字段，两个名字都收）；`cash_flow_item` 传 null 或空串 = 清除标记',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['entries'],
                properties: {
                  reason: { type: 'string', description: '改动已标过的分录时必填' },
                  entries: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['line_no'],
                      properties: {
                        line_no: { type: 'integer', description: '凭证分录行号' },
                        cash_flow_item: { type: 'string', nullable: true, description: '项目 code；null / 空串 = 清除' }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: { 200: jsonResp(null), 400: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) }
      }
    },
    '/api/reports/defs': { get: { tags: ['财务报表'], summary: '报表定义列表（含 `cover_categories`：这张表必须穷尽覆盖哪些科目大类）', responses: { 200: jsonResp(null) } } },
    '/api/reports/defs/{code}': { put: { tags: ['财务报表'], summary: '维护报表定义（取数口径 `balance` / `amount` / `cash_flow` 与现金类科目集合）——**会计政策，不是展示配置**', parameters: [p('code', '报表代码 bs / pl / cf')], requestBody: body('ReportDefSave'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/reports/defs/{code}/lines': { get: { tags: ['财务报表'], summary: '报表行（科目区间 / 方向过滤 / 小计表达式），按 order_no 排序', parameters: [p('code', '报表代码 bs / pl / cf')], responses: { 200: jsonResp(null) } } },
    '/api/reports/lines': { post: { tags: ['财务报表'], summary: '新增或修改一行报表口径。科目区间支持**多段**（`1122~1122|2203~2203`）；小计表达式只允许「行号 + 加减号」—— 可被界面编辑的配置一旦能写表达式，就等于配置能改账', requestBody: body('ReportLineSave'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/reports/lines/{id}': { delete: { tags: ['财务报表'], summary: '删除一行报表口径。**必须写理由**（`report_lines` 是物理删除，删掉的那一行之后只剩日志里的整行快照）；**被小计行引用的行不允许删除**（删掉会让小计静默少一块，而报表仍然很好看）', parameters: [idParam], requestBody: body('ReportLineDelete'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },
    '/api/reports/config/meta': { get: { tags: ['财务报表'], summary: '**报表口径变更链的定义表**：四种动作 · 两种目标 · **危险字段集**（改到它们必须写理由，是全项目唯一的判据）· `SNAPSHOT_FIELDS`（留痕与重放比对覆盖的全部列）· 字段中文名', responses: { 200: jsonResp(null) } } },
    '/api/reports/config/audit': { get: { tags: ['财务报表'], summary: '**报表口径变更历史**：每一次新增 / 修改 / 删除都带**改动前后的整行快照**。删除记录是"删掉的那一行"唯一还能被查到的地方（行已物理删除）。`changed` 字段把差分摊成「字段名 + 改前 + 改后 + 是否危险」，界面不自己解析 JSON', parameters: [q('target_type', 'def（报表定义）/ line（口径行）'), q('report_code', '只看某张报表 bs / pl / cf'), q('action', '只看某个动作 baseline / create / update / delete'), q('danger_only', '1 = 只看会计政策变更'), q('limit', '最多返回条数，默认 200，上限 1000')], responses: { 200: jsonResp(null) } } },
    '/api/reports/config/audit/check': { get: { tags: ['财务报表'], summary: '**报表口径变更链自证**：动作名是否认识 · 快照是否整份（"删了什么查不出来"的机械守卫）· 快照是否可解析 · 危险改动是否写了理由 · 有没有行一条历史都没有（`REPORT_CONFIG_UNTRACKED`）· 有历史的行能否重放出来（`REPORT_CONFIG_AUDIT_DESYNC`，**与 UNTRACKED 互斥**，一条断言只被一个原因守着）· 有没有行挂在不存在的报表上 · `SNAPSHOT_FIELDS` 有没有漏掉表里新增的列。**全库扫描 + 纯只读**（初始化只在 `bootIndustry` 与 `seedReport` 两处，检查里写库会把"没补基线"这件事掩盖掉）', responses: { 200: jsonResp(null) } } },
    '/api/reports/periods': { get: { tags: ['财务报表'], summary: '会计期间列表与关账状态。**注意：这里的每一列都是「现状指针」**（`closed_by` / `closed_at` / `reopen_reason` …）—— 反关账会把 `closed_by` 清空是刻意的，因为「状态为未关账」与「关账人是张三」放在同一行是自相矛盾的一句话；历史（谁在什么时候改成了什么样）在 `/api/reports/periods/audit`', responses: { 200: jsonResp(null) } } },
    '/api/reports/periods/audit': { get: { tags: ['财务报表'], summary: '**期间变更历史**：关账/反关账/期末结转/撤销结转/年度结转/撤销年结/利润分配/撤销分配 的每一次记录。**只追加**，没有修改与删除路径；`baseline` 是迁移时按现状补记的基线（不是某个人的动作）。`year` 筛选会同时返回该年的年度动作与期间动作', parameters: [q('period', '只看某一期 YYYY-MM'), q('year', '只看某一年 YYYY（含该年的期间动作）'), q('action', '只看某个动作'), q('limit', '最多返回条数，默认 200，上限 1000')], responses: { 200: jsonResp(null) } } },
    '/api/reports/periods/audit/check': { get: { tags: ['财务报表'], summary: '**审计链自证**：从空状态按序重放全部变更记录，结果必须等于期间表的现状（`PERIOD_AUDIT_DESYNC`）；期间表上有留痕就必须有对应的动作日志（`PERIOD_AUDIT_MISSING`）；每条派生凭证都要能被某条日志认领（`PERIOD_AUDIT_VOUCHER_ORPHAN`，这条**完全不读期间表**）；动作名必须认识（`PERIOD_AUDIT_UNKNOWN_ACTION`）；撤销类动作必须有理由（`PERIOD_AUDIT_REASON_REQUIRED`）；年结承诺「封整年」⇒ 该年度不能还有开着的期间（`PERIOD_AUDIT_YEAR_GAP`）。**全库扫描**，不是只查某一期', responses: { 200: jsonResp(null) } } },
    '/api/reports/periods/{period}/close': { post: { tags: ['财务报表'], summary: '期间关账。关账前**必须**跑通三张报表的自证且无未过账草稿 —— 带着一张不平的资产负债表定稿，等于把差额永久封存在这一期', parameters: [p('period', '期间 YYYY-MM')], requestBody: body('PeriodClose'), responses: { 200: jsonResp(null), 409: jsonResp(null) } } },
    '/api/reports/periods/{period}/reopen': { post: { tags: ['财务报表'], summary: '反关账（让已定稿的期间重新可变）。**必须写理由** —— 与作废已过账凭证同一个道理', parameters: [p('period', '期间 YYYY-MM')], requestBody: body('PeriodReopen'), responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/reports/closing/{period}': { get: { tags: ['财务报表'], summary: '期末结转状态（只读）：本期是否已结转 / 待结转损益净额 / 逐科目的余额与结转方向。**与关账前置检查共用同一份判据** —— 界面上的「该不该结转」与「能不能关账」不会给出两个答案', parameters: [p('period', '期间 YYYY-MM')], responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/reports/periods/{period}/carry-forward': { post: { tags: ['财务报表'], summary: '期末结转：把损益类科目（6xxx）余额结转到「本年利润」（4103），生成一张**已过账**的凭证（日期取期间末日）。**不走凭证模板** —— 模板回答「这笔业务该记成哪几笔分录」，而结转是一个算法、行数由余额决定。幂等：同一期重复调用返回首次结果', parameters: [p('period', '期间 YYYY-MM')], requestBody: body('PeriodCarryForward'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },
    '/api/reports/periods/{period}/reverse-closing': { post: { tags: ['财务报表'], summary: '撤销结转：删掉本期的结转账并清掉期间上的结转记录。**必须写理由**，且**期间未关账**（先反关账 —— 这样才没有死锁路径）。撤的是**派生凭证**（可由科目余额完全重算），所以物理删除而非作废，与业务凭证不同', parameters: [p('period', '期间 YYYY-MM')], requestBody: body('PeriodReverseClosing'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },
    '/api/reports/opening': {
      get: { tags: ['财务报表'], summary: '期初余额（某期间的期初试算表）', parameters: [q('period', '期间 YYYY-MM', true)], responses: { 200: jsonResp(null) } },
      put: { tags: ['财务报表'], summary: '录入期初余额（**整批覆盖**）。借贷不平、或同一科目同时有借/贷余额 → 整批不落库', requestBody: body('OpeningSave'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } }
    },
    '/api/reports/subject-balances': { get: { tags: ['财务报表'], summary: '科目余额表（期初 / 本期发生 / 期末）——**三张报表唯一的取数口**，也是期初余额滚动到本期的可见证据', parameters: [q('period', '期间 YYYY-MM', true)], responses: { 200: jsonResp(null) } } },
    '/api/reports/operating': { get: { tags: ['财务报表'], summary: '经营分析：**账上口径**与**业务单汇总**并列，差额如实展示（不抹平）。差额本身就是"还没记到账上的业务"的度量', parameters: [q('period', '期间 YYYY-MM', true)], responses: { 200: jsonResp(null) } } },
    '/api/reports/audit': { get: { tags: ['财务报表'], summary: '**报表域自证**：科目覆盖 / 区间不重叠 / 兜底行为空 / 资产＝负债＋权益 / 净利润＝损益类发生额 / 现金流净增加额＝现金科目变动 / 期初平衡 / **本期期初＝上期期末（全期间扫描）** / 结转状态与账一致 / **本年累计＝逐月相加（全期间扫描）** / **期间审计链自洽（重放日志＝期间表现状，全库扫描）**。恒等式不平时**只可能是配置错**，所以它是"报表看起来很好看、就是差一个数"的唯一探针', parameters: [q('period', '期间 YYYY-MM', true)], responses: { 200: jsonResp(null) } } },
    '/api/reports/{code}/compare': { get: { tags: ['财务报表'], summary: '**跨期比较**（环比 = 上期 / 同比 = 去年同期 / **累计同比 = 上年同期累计**）。两列都来自同一个计算入口（逐行等于单独打开那一期），差额 = 两列相减、变动率 = 差额 ÷ |基期|（基期 0 时**留空**）。`mode=yoy_ytd` 是唯一的"两列都是累计"的模式：本期列 = [会计年度年初, 本期]、基期列 = [上年会计年度年初, 上年同月]（**不是** [上年同月, 本期] —— 那个跨两个年度、含一个完整的上年，是另一个量）；结果里 `compare_basis=ytd`、`range_meta`/`base_range_meta` 给出两个窗口。基期没数据时如实标注 `comparable=false` —— 不拒绝比较，也不把"上期没开张"读成暴涨', parameters: [p('code', '报表代码 bs / pl / cf'), q('period', '期间 YYYY-MM', true), q('mode', '比较模式 previous（环比）/ yoy（同比）/ yoy_ytd（上年同期累计，两列都是累计）/ custom（自定义基期，须同时给 base_period）'), q('base_period', '自定义基期 YYYY-MM（仅 mode=custom 用，**必须早于本期**）'), q('range', '仅 `mode=yoy_ytd` 可传 `ytd`（它自带累计，传别的值会被拒）')], responses: { 200: jsonResp(null), 400: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } },
    '/api/reports/{code}/compare/audit': { get: { tags: ['财务报表'], summary: '**比较自证**：两列必须等于"单独打开那一期"（累计模式则等于"单独打开那一期的累计"）、差额必须等于两列相减、基期必须由模式唯一决定、变动率必须与"基期是否为 0"一致、**结果自称的口径与两个窗口必须与模式推出来的一致**（`COMPARE_BASIS_BAD` / `COMPARE_RANGE_WINDOW_BAD`）。断言都是可执行断言 —— 不靠人记得（本项目已经吃过"同一件事有两个实现"的亏）', parameters: [p('code', '报表代码 bs / pl / cf'), q('period', '期间 YYYY-MM', true), q('mode', '比较模式 previous / yoy / yoy_ytd / custom'), q('base_period', '自定义基期 YYYY-MM（仅 mode=custom 用）')], responses: { 200: jsonResp(null) } } },
    // —— 同期多年对比（批次 U 之四 / ④）：跨年度报表 ——
    '/api/reports/{code}/multi-year': { get: { tags: ['财务报表'], summary: '**同期多年对比（跨年度）**：同一张表并排 N 列，第 k 列 = 本期往前 12k 个月的数（k=0 本期 / 1 去年同月 / 2 前年同月…），`years` 限 2~5。每一列都是**对那一期单独调同一个计算入口**的结果（构造性满足"列 = 单独打开那一期"）。**不做**（明写）：任意跨年窗口（如"上年 12 月 ~ 本年 3 月"，那需要一条新的区间入参）· 利润分配跨年还原 · 年度报表同比列', parameters: [p('code', '报表代码 bs / pl / cf'), q('period', '期间 YYYY-MM', true), q('years', '并列几期，2~5（默认 3，越界报 MULTI_YEAR_COUNT）')], responses: { 200: jsonResp(null), 400: jsonResp(null), 404: jsonResp(null) } } },
    '/api/reports/{code}/multi-year/audit': { get: { tags: ['财务报表'], summary: '**同期多年对比自证**：每一列必须等于"单独打开那一期"（守唯一实现）、期间序列必须**字面**等于本期往前 12 个月的整数倍（不由被测函数推）、列数必须等于 `years`（少一列会让"前年"悄悄消失而表看起来仍然完整）', parameters: [p('code', '报表代码 bs / pl / cf'), q('period', '期间 YYYY-MM', true), q('years', '并列几期，2~5')], responses: { 200: jsonResp(null) } } },
    '/api/reports/{code}/range/audit': { get: { tags: ['财务报表'], summary: '**本年累计自证**：区间自称的起点必须是本期所在年度的 1 月、终点必须就是本期，且**逐行等于**「本年 1 月至本期逐月各算一次再相加」（两条独立路径互证），同时本期列必须与单独打开本期一致。期望窗口在这里**字面算出**、不经过 `resolveRange` —— 用被测函数推期望值再和它的输出比就是自己验自己，那类探针比没有探针更危险', parameters: [p('code', '报表代码 pl / cf（时点口径会报 RANGE_BASIS_NOT_APPLICABLE）'), q('period', '期间 YYYY-MM', true), q('range', '区间模式，默认 ytd')], responses: { 200: jsonResp(null) } } },
    '/api/reports/{code}/export': { get: { tags: ['财务报表'], summary: '**报表导出**：导出即视图 —— 每一行都是同一个计算入口的结果、每一列都来自同一份列定义（`columnsOf`），不另写取数路径。`format=csv`（**默认，带 BOM**）或 `format=xlsx`（零依赖写入器，工作表名取报表名；报表名非法时降级成安全名并用 `X-Report-Sheet-Fallback` 如实标出）。可选 `mode` 带上比较列。响应头 `X-Report-Code/Period/Format/Range/Base-Period`；文件名双份（`filename*` 给现代浏览器中文名，ASCII 名兜底）', parameters: [p('code', '报表代码 bs / pl / cf'), q('period', '期间 YYYY-MM', true), q('format', '导出格式：`csv`（默认）/ `xlsx`'), q('mode', '比较模式 previous / yoy / yoy_ytd / custom（不传 = 导单期）'), q('base_period', '自定义基期 YYYY-MM（仅 mode=custom 用）'), q('years', '同期多年对比并列几期（2~5）；与 mode / range 互斥'), q('range', '区间模式：`ytd` = 带上本年累计列（仅单期口径可用；`mode=yoy_ytd` 自带累计）')], responses: { 200: { description: '文件字节（csv: text/csv; charset=utf-8 ／ xlsx: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet）', content: { 'text/csv': { schema: { type: 'string' } } } }, 400: jsonResp(null) } } },
    '/api/reports/annual': { get: { tags: ['财务报表'], summary: '**年度结转与利润分配的年度概览**：每个年度的期间数 / 已关账数 / 未结转期间 / 是否已年结 / 是否已分配 / 待结转金额 / 可分配余额 / **能不能年结**（唯一回答，界面不自己拼判断）', responses: { 200: jsonResp(null) } } },
    '/api/reports/annual/{year}': { get: { tags: ['财务报表'], summary: '单年详情与**年结预览**：将要结转多少（年末 4103 的余额）、本年利润表净利润、将要生成的两行分录，以及**前置检查的完整回答**（还差什么才能年结 —— 每一条都带可执行指引，不是一句"不能年结"）', parameters: [p('year', '年度 YYYY')], responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/reports/annual/{year}/distribution': { get: { tags: ['财务报表'], summary: '利润分配状态：可分配余额（年末 4104 的贷方余额）、是否已分配、历史上分配给了谁，以及**能不能分配**与不能的原因', parameters: [p('year', '年度 YYYY')], responses: { 200: jsonResp(null), 400: jsonResp(null) } } },
    '/api/reports/annual/{year}/carry-forward': { post: { tags: ['财务报表'], summary: '**年度结转**（4103 本年利润 → 4104 未分配利润）：生成一张**已过账**凭证（日期取年末最后一天），并把该年度**所有期间置为已关账**。前置：全年已做月度结转（漏一个月就是一笔**永久错账**，而账仍然是平的）/ 无未过账草稿 / 12 月未关账。幂等：同一年重复调用返回首次结果', parameters: [p('year', '年度 YYYY')], requestBody: body('AnnualCarryForward'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },
    '/api/reports/annual/{year}/reverse-closing': { post: { tags: ['财务报表'], summary: '撤销年度结转：删掉年结凭证（**派生凭证**，可重算）。**必须先撤销利润分配**，且**次年不能有已关账期间**（撤销会改变次年期初）。**必须写理由**。撤销**不**把全年置回未关账 —— "打开"是一个需要理由的动作', parameters: [p('year', '年度 YYYY')], requestBody: body('AnnualReverseClosing'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },
    '/api/reports/annual/{year}/distribute': { post: { tags: ['财务报表'], summary: '**利润分配**（4104 → 4105 盈余公积 / 2232 应付股利…）：金额**必须由人给**（这是决议，不是算法）。一次调用生成一张凭证（借 4104 总额 / 贷各目标科目），默认落在**次年 1 月**（分红决议在次年，账也做在次年）。校验：目标必须是权益或负债类叶子科目、不能是 4103（年结来源）或 4104 自己、总额不得超过可分配余额', parameters: [p('year', '年度 YYYY')], requestBody: body('AnnualDistribute'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },
    '/api/reports/annual/{year}/reverse-distribution': { post: { tags: ['财务报表'], summary: '撤销利润分配（物理删除派生凭证）。**必须写理由**，且**次年不能有已关账期间**', parameters: [p('year', '年度 YYYY')], requestBody: body('AnnualReverseDistribution'), responses: { 200: jsonResp(null), 400: jsonResp(null), 409: jsonResp(null) } } },
    '/api/reports/{code}': { get: { tags: ['财务报表'], summary: '按代码取一张报表（`bs` 资产负债表 / `pl` 利润表 / `cf` 现金流量表）。行金额 = `sign × Σ(本行认领科目的 signed)`，方向口径写进行里而不是写进代码。带 `range=ytd` 时多一列**本年累计**（本年 1 月至本期，含两端）——**时点口径（资产负债表）没有累计这回事**，对它会明确 409 而不是静默当成单期', parameters: [p('code', '报表代码 bs / pl / cf'), q('period', '期间 YYYY-MM', true), q('range', '区间模式：`ytd` = 加一列本年累计（仅 amount / cash_flow 口径可用）')], responses: { 200: jsonResp(null), 404: jsonResp(null), 409: jsonResp(null) } } }
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'GML 供应链协同系统 API',
      version: '1.45.0',
      description:
        '化妆品 / 服装 双行业轻量级供应链协同系统接口文档。覆盖主数据、采购、销售、存货、经销商、门店要货、委外管理、计划与生产、生产制造（BOM / 领料 / 完工入库）、质量检验、线上 OMS 与经营看板。\n\n' +
        '**多行业**：登录 `POST /api/auth/login` 时传 `industry`（`cosmetic` / `apparel`）选择行业版本；' +
        '行业上下文优先取 token 内的 `industry`，公开页面可用请求头 `x-industry` 指定。\n\n' +
        '**AI / Agent 接入建议**：先读 `GET /api/ai/manifest` 获取能力清单与意图列表，再用 `POST /api/ai/query` 做结构化查询；' +
        '需要理解数据模型时读 `GET /api/ai/schema`，确认指标口径读 `GET /api/ai/metrics`。',
      contact: { name: 'GML 演示系统' }
    },
    servers: [{ url: '/', description: '当前站点' }],
    tags: [
      { name: '应收与收款', description: '应收与收款核销（模块 21）：已收金额由核销明细 SUM 算出；核销生效点 = 收款单确认；到期日 = 业务日 + 账期；作废不自动回收授信' },
      { name: '销售发票', description: '销售发票与开票关闭（模块 24）：开票只产生债权不动库存；开票关闭由发票行 SUM 与发货/订单数量比对推导；确认开票才生成/关联应收；红冲不删原票' },
      { name: '质量检验', description: '报检 / 检验 / 不良品处理三单独立成链（模块 13）：判定由不良数与 Ac/Re 推导不由人选；抽样量 ≤ 报检数量、不良数 ≤ 抽样量；四种处置都会真的动库存 —— 退货与报废必须出库，让步接收自动调拨入不合格品仓、返工自动调拨入待检品仓（出库与入库都真的发生）' },
      { name: '认证', description: '登录、用户与权限' },
      { name: '主数据', description: '商品、SKU、往来单位、仓库门店、平台店铺' },
      { name: '采购', description: '采购订单、收货入库、采购退货' },
      { name: '质检', description: '到货单与质检单拆分：到货单记事实（送来了什么），质检单记判断（收不收 / 收多少 / 为什么）。判退必须生成退货单并反向出库，判退率与判退金额由此可算' },
      { name: '销售', description: '多渠道销售、发货出库、退货、回款' },
      { name: '存货', description: '库存查询、收发存台账、批次效期、调拨、盘点' },
      { name: '经销商', description: '等级政策、信用额度、返利核算、对账单' },
      { name: '门店要货', description: '门店向总部要货、总部受理、转采购（总部入库 / 直运门店仓）、中心仓配货，以及门店发货单（参考要货单选择性发货）与门店端选择性收货（短收与差异登记）' },
      { name: '委外管理', description: '委外订单、委外发料、委外收货、委外结算（用友口径）' },
      { name: '计划与生产', description: '经销商要货申请与计划、净需求汇总、采购/生产/委外分流、生产订单' },
      { name: '线上 OMS', description: '平台店铺、订单同步、转单、发货回传、退款、库存推送' },
      { name: '看板', description: '经营指标与分析' },
      { name: 'AI 承接', description: '供 AI / Agent 调用的语义化接口' },
      { name: '系统', description: '健康检查与枚举字典' },
      { name: '系统参数', description: '配置的定义与变更留痕（批次 R）。三条硬口径：① **配置项的集合是确定的** —— 库里的键必须等于服务端 `SETTING_RULES` 登记表的键，未登记的键不许写入（写进去的每一个键都有人认识它）；② **值的形态与值域只有一处定义** —— 类型（布尔 / 整数 / 科目编码 / 枚举）、默认值、值域都在登记表里，读取统一走 `readSetting`、写入统一走 `writeSetting`（这一批把散在 credit / quote / member / pos2 四处的私有 `setting()` 收敛成了一处）；③ **每一次改动只追加地留一条可重放的记录**，危险配置（会计政策 / 应收口径 / 门店长短款阈值）改动必须写理由' },
      { name: '审批中心', description: '通用审批流：模板（几级/谁审/金额区间）、实例、待我审批、通过/驳回；审批与单据状态解耦' },
      { name: '生产制造', description: 'BOM / 生产订单 / 领料 / 完工汇报 / 完工入库（模块 10B）：一个母件一个用途只能有一版生效 BOM；已审批的 BOM 不可改、要领料与完工入库都要求订单已开工；完工入库是唯一给库存做加法的动作' },
      { name: '门店 POS', description: '门店交班缴款与长短款（模块 17）：三段钱（系统应收 / 收银员报数 / 店长实点），长短款 = 实点 − 系统应收，**必须按支付方式拆分**（现金差额是人的问题、移动支付差额是系统问题），备用金不参与长短款；缴款一个班次只能一次且缴收不同人；日结有未核款班次一票否决；门店退货按门店仓当前成本价回库并冲减班次应收；门店盘点账面数一律取自库里' },
      { name: '通知中心', description: '待办推送到飞书 / 钉钉 / 企业微信：渠道配置、消息预览（只渲染不发送）、推送与日志' },
      { name: 'IM 同步', description: '钉钉 / 飞书的**组织同步与审批同步**：外部部门→本地组织、外部成员→本地用户、外部审批单→本地审批实例三套映射，外加只追加的同步流水与冲突台账。⚠️ 真实租户调用**未实现**（无凭据），除那一次 HTTP 之外的全部环节均可跑通与自证' },
      { name: '数据口径', description: '指标口径字典：每条口径的「怎么算 / 不算什么 / 取自哪 / 何时踩坑」与当前值同源同框；表只是代码定义的投影' },
      { name: '存货核算', description: '存货核算与成本（模块 09）：期间、三层成本（期初/本期入/本期出/期末）、期末结转与锁定、暂估差异回写。三条硬口径：三层要闭合、结转要有约束力、差异不追溯已售出部分' },
      { name: '财务凭证', description: '业财一体凭证（模块 27 · 批次 H）：科目表 → 凭证模板 → 凭证生成 → 试算平衡。四条硬口径：① **凭证只能由已发生的业务事实生成**（来源 `biz_type + source_type + source_id` 唯一，没有"新建凭证"端点）；② **不平即拒绝且整张不落库**（半张凭证比没有更糟）；③ **方向由模板决定、金额恒 > 0、只能挂叶子科目**（允许负数金额的账，任何汇总都能被"负负得正"地做平）；④ **只有 `posted` 计入账**，作废已过账凭证必须写理由' },
      { name: '退款管理', description: '退款单（批次 J）：把销售退货时登记的「待退款」（`sales_returns.refund_due`）兑现成一次真实出账。四条硬口径：① **退款上限 = 退货单的待退款额 − 已确认退款额**（按单累计，草稿不占额度 —— 否则"先建单、后作废"成了一条永远退不出去的路）；② **只有 `confirmed` 才真的出账**，且确认前**重验**一次额度（建单时合法 ≠ 确认时合法，两张草稿可以各自合法地答应退同一笔额度）；③ **幂等键非空唯一**（动钱的动作最怕重放）；④ **退款必须有账务后果**（凭证：借 2203 预收账款 / 贷 1002 银行存款 —— 退的是"多收客户的钱"那笔负债）' },
      { name: '财务报表', description: '三张主表 + 期间关账 + 期初余额 + 经营分析（模块 28 · 批次 L）。五条硬口径：① **报表结构是会计政策，不是代码** —— 科目区间与方向口径入库（`report_lines`），可审计、可追溯改过什么；② **小计表达式只允许「行号 + 加减号」** —— 能写表达式的配置就等于配置能改账；③ **期初余额按借贷两列存且整批覆盖** —— 不平则整批不落库（一张不平的期初会让之后每一期都不平，且差额来源不可考）；④ **关账后不能再过账、但可以生成**（`draft` 不计入任何报表）；⑤ **三条自证恒等式**：资产＝负债＋所有者权益 / 净利润＝损益类科目发生额按方向取号 / 现金流净增加额＝现金类科目期末−期初。三条都是数学恒等式，不平时**只可能是配置错**（口径漏了科目 / 期初不平），这正是让它立刻现形的探针。**批次 S 补**：口径的每一次改动都留一条只追加、可重放的记录（`/api/reports/config/audit`）—— 存**改动前后的整行快照**，所以"删掉的那一行原来是什么"在被物理删除之后仍然答得出；危险字段（`line_no` / `line_type` / `subject_range` / `sign` / `only_direction` / `subtotal_expr` / `is_fallback`）改动与**新增**必须写理由，只改行名 / 行次 / 缩进 / 排序不必（危险是**差分驱动**的，不是"这一行危险"）；自证接在关账前置里（`auditReport` 第 ⑫ 条）。**批次 U 补**：现金流量表加「现金流量项目」辅助核算（`/api/reports/cashflow-items`）—— 分录上可以标一个项目，归集时**标记优先**、未标记的仍按对手科目分析；两种填列法都如实报条数（`tagged_count` / `untagged_count`），存量凭证一条标记都没有但结果与升级前**逐字节相同**。**批次 U 之四（报表纵深）补**：③-a 导出 Excel（`?format=xlsx`，默认仍是 CSV）；③-b 「本年累计的比较」（`mode=yoy_ytd`，两列都是累计：本期 [会计年度年初, 本期] vs 上年 [上年年初, 上年同月]）；③-c 会计年度起始月可配置（`settings.fiscal.start_month`，**报表侧**支持非 1 月起点，**年结/利润分配在非 1 月时明确 409 拒绝**——跨自然年的年结未实现，不做静默按自然年结）；④ 同期多年对比（`/api/reports/{code}/multi-year`，2~5 列）' },
      { name: '销售报价', description: '销售报价单（模块 08A）：取价（来源留痕）→ 有效期（过期不可转单）→ 审批（低于最低限价 / 低于客户政策折扣 / 超金额阈值）→ 转单（唯一有后果，一张报价只能转一次；要改价走复制改版）' },
      { name: '信用控制', description: '信用控制（模块 08A）：额度唯一真相（统一台账 + 订货中心同主体占用，不读缓存列）；跨渠道共享额度；占用 / 释放 / 回款核销成对；超信默认拦、特批放行必须填理由并留痕' },
      { name: '促销与会员', description: '商城促销引擎与会员体系（模块 18）。三条硬口径：① **算钱顺序固定**——会员折扣（作用于原价，是"身份价"）→ 促销优惠（在会员价上叠加，是"活动价"）→ 积分抵扣（只能作用在最终成交价上，反过来会突破应付金额）；② **优惠必须摊到行**——行优惠合计恒等于整单优惠，不平即抛错，否则退货时算不出"这行实付多少"、退完所有行钱还对不上；③ **余额不是真相，流水才是**——积分与储值的每次变动都写流水并带 `balance_after`，账户余额与流水合计不等就报案。另有四条防事故约束：券默认不自动使用（要显式 `auto_coupon`）、优惠有最低价地板（闸住"货出了钱没进"的 0 元单）、撤单时积分回收按余额封顶并报差额、券的优惠额只由促销引擎算（券表里的值仅展示）' }
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '后台登录接口返回的 token（audience=gml-erp）' },
        mallToken: {
          type: 'apiKey',
          in: 'header',
          name: 'x-mall-token',
          description: 'C 端会话令牌（/api/mall/login 返回，audience=gml-mall）；与 bearerAuth 互不通用'
        }
      },
      schemas: {
        ApiResponse: {
          type: 'object',
          properties: {
            code: { type: 'integer', example: 0 },
            success: { type: 'boolean', example: true },
            data: { description: '业务数据，结构随接口而定' },
            message: { type: 'string', nullable: true },
            total: { type: 'integer' },
            page: { type: 'integer' },
            pageSize: { type: 'integer' }
          }
        },
        InspectionCreate: {
          type: 'object',
          required: ['receipt_id'],
          properties: {
            receipt_id: { type: 'integer', description: '到货单 id（必须是「已收货」状态，且未出过质检结论）' },
            inspect_date: { type: 'string', example: '2026-10-15' },
            remark: { type: 'string' },
            items: {
              type: 'array',
              description: '要覆盖的到货行；不传则全部按合格建单（正常情况一次点击，异常情况才改数字）',
              items: {
                type: 'object',
                properties: {
                  receipt_item_id: { type: 'integer', description: '到货单行 id（事实来源）' },
                  qualified_qty: { type: 'number' },
                  concession_qty: { type: 'number', description: '让步接收：收下但留痕，不影响入库数量' },
                  rejected_qty: { type: 'number', description: '判退：合格 + 让步 + 判退 必须等于到货数量，否则整单被拒' },
                  defect_code: { type: 'string', enum: ['appearance', 'spec', 'packaging', 'expiry', 'batch', 'quality', 'other'] },
                  defect_reason: { type: 'string', description: '不合格说明，会带到退货单上作为索赔依据' }
                }
              }
            }
          }
        },
        InspectionSubmit: {
          type: 'object',
          properties: {
            remark: { type: 'string' },
            lines: {
              type: 'array',
              description: '按**质检单行 id** 覆盖（不是到货单行 id —— 传错不会报错，只会「覆盖不上」，表现为改了数字却没生效）；不传则按草稿现况提交',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer', description: '质检单行 id' },
                  qualified_qty: { type: 'number' },
                  concession_qty: { type: 'number' },
                  rejected_qty: { type: 'number', description: '大于 0 时自动生成采购退货单并反向出库；库存不足则整单失败' },
                  defect_code: { type: 'string' },
                  defect_reason: { type: 'string' },
                  remark: { type: 'string' }
                }
              }
            }
          }
        },
        CostPeriodClose: {
          type: 'object',
          properties: {
            period: { type: 'string', example: '2026-09', description: '要结转的会计期间，缺省为当前自然月（当前月还没走完，结不了）' },
            reopen: { type: 'boolean', description: '重结：会先删掉该期快照再重算。不传则已结转的期间会被拒（PERIOD_ALREADY_CLOSED）' },
            remark: { type: 'string' }
          }
        },
        CostAdjustmentCreate: {
          type: 'object',
          required: ['settle_id'],
          properties: {
            settle_id: { type: 'integer', description: '采购结算单 id（差异的来源）。结算未生效或差异为 0 会被拒' },
            adjust_date: { type: 'string', example: '2026-10-15', description: '调整日期，决定归属期间；该期间已结转会被拒（PERIOD_CLOSED）' },
            remark: { type: 'string' }
          }
        },
        // —— 模块 08A 销售报价与信用控制 ——
        QuotePriceRequest: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  sku_id: { type: 'integer' },
                  qty: { type: 'number' },
                  price: { type: 'number', description: '手工改价（可选）。不传则用价格中心算出的价；传了则同时保留挂牌价与成交价，折扣率由此算出' }
                }
              }
            },
            customer_type: { type: 'string', enum: ['dealer', 'oc', 'store'] },
            dealer_id: { type: 'integer' },
            customer_id: { type: 'integer' },
            store_id: { type: 'integer' },
            channel: { type: 'string' },
            warehouse_id: { type: 'integer' },
            freight: { type: 'number' },
            tax_rate: { type: 'number' }
          }
        },
        QuoteCreate: {
          type: 'object',
          required: ['items'],
          properties: {
            customer_type: { type: 'string', enum: ['dealer', 'oc', 'store'] },
            dealer_id: { type: 'integer' },
            customer_id: { type: 'integer' },
            store_id: { type: 'integer' },
            channel: { type: 'string' },
            warehouse_id: { type: 'integer' },
            quote_date: { type: 'string', example: '2026-10-15' },
            valid_days: { type: 'integer', description: '有效期天数（不传 valid_to 时生效，默认取设置 quote.valid_days）' },
            valid_to: { type: 'string', example: '2026-11-14' },
            items: { type: 'array', items: { type: 'object', properties: { sku_id: { type: 'integer' }, qty: { type: 'number' }, price: { type: 'number' } } } },
            freight: { type: 'number' },
            tax_rate: { type: 'number' },
            remark: { type: 'string' },
            source_quote_id: { type: 'integer', description: '改版来源报价 id；传了则 version = 来源 version + 1' }
          }
        },
        QuoteAction: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['submit', 'approve', 'reject', 'resubmit', 'cancel'] },
            remark: { type: 'string' }
          }
        },
        QuoteConvert: {
          type: 'object',
          properties: {
            target: { type: 'string', enum: ['SO', 'OC'], description: 'SO 销售订单（沿用报价价）/ OC 订货单（仅订货客户，按订货中心当前口径取价）' },
            order_date: { type: 'string' },
            force: { type: 'boolean', description: '超信特批放行开关；为 true 时 reason 必填' },
            reason: { type: 'string', description: '特批理由（force=true 时必填，写入信用校验留痕）' },
            remark: { type: 'string' }
          }
        },
        QuoteCopy: { type: 'object', properties: { valid_days: { type: 'integer' }, remark: { type: 'string' } } },
        QuoteExpire: { type: 'object', properties: { at: { type: 'string', description: '基准日期 YYYY-MM-DD，缺省为今天' } } },
        CreditAccountCreate: {
          type: 'object',
          required: ['subject_type', 'subject_id'],
          properties: {
            subject_type: { type: 'string', enum: ['dealer', 'oc', 'store'] },
            subject_id: { type: 'integer' }
          }
        },
        ArCreate: {
          type: 'object',
          required: ['subject_type', 'subject_id', 'amount'],
          properties: {
            subject_type: { type: 'string', enum: ['dealer', 'oc', 'store'] },
            subject_id: { type: 'integer' },
            subject_name: { type: 'string' },
            source_type: { type: 'string', enum: ['SO', 'OC', 'MANUAL'] },
            source_id: { type: 'integer' },
            source_doc_no: { type: 'string' },
            biz_date: { type: 'string', description: '业务日期，到期日由它 + 账期推出' },
            amount: { type: 'number' },
            credit_days: { type: 'integer', description: '账期天数；0 = 现结（当天到期）' },
            remark: { type: 'string' }
          }
        },
        ArGenerate: {
          type: 'object',
          properties: {
            source_type: { type: 'string', enum: ['SO', 'OC'] },
            limit: { type: 'integer', description: '最多处理多少张来源单据（默认 50）' },
            items: { type: 'array', items: { type: 'object' }, description: '不传则自动取未生成应收的销售订单' }
          }
        },
        ReceiptCreate: {
          type: 'object',
          required: ['subject_type', 'subject_id', 'amount'],
          properties: {
            subject_type: { type: 'string', enum: ['dealer', 'oc', 'store'] },
            subject_id: { type: 'integer' },
            receipt_date: { type: 'string' },
            method: { type: 'string', enum: ['transfer', 'cash', 'bill', 'online'] },
            amount: { type: 'number' },
            bank_account: { type: 'string' },
            serial_no: { type: 'string' },
            remark: { type: 'string' },
            allocations: {
              type: 'array',
              description: '手工指定核销对象；不传按到期日 FIFO 自动分摊',
              items: {
                type: 'object',
                properties: { ar_id: { type: 'integer' }, amount: { type: 'number' } }
              }
            }
          }
        },
        ReceiptConfirm: {
          type: 'object',
          properties: {
            release_credit: { type: 'boolean', description: '默认 true：确认收款即释放授信占用' },
            evidence_ref: { type: 'string', description: '银行流水号 / 凭证号（funds_evidence_required=1 时必填；行上已存的证据可不重传）' },
            evidence_note: { type: 'string', description: '证据说明（可选）' }
          }
        },
        FundsReview: {
          type: 'object',
          required: ['decision'],
          properties: {
            decision: { type: 'string', enum: ['approve', 'reject'], description: 'approve 批准（执行原确认逻辑）/ reject 驳回（退回原状态）' },
            comment: { type: 'string', description: '复核意见；驳回时必填（FUNDS_COMMENT_REQUIRED）' }
          }
        },
        PaymentAction: {
          type: 'object',
          properties: {
            evidence_ref: { type: 'string', description: 'pay 时：银行流水号 / 凭证号（funds_evidence_required=1 时必填）' },
            evidence_note: { type: 'string', description: 'pay 时：证据说明（可选）' },
            remark: { type: 'string', description: '流转备注' }
          }
        },
        ReceiptVoid: {
          type: 'object',
          properties: { reason: { type: 'string', description: '作废原因（写入流转留痕）' } }
        },
        ArRecalc: {
          type: 'object',
          properties: {
            subject_type: { type: 'string' },
            subject_id: { type: 'integer' }
          }
        },
        PrepayApply: {
          type: 'object',
          required: ['receipt_id'],
          properties: {
            receipt_id: { type: 'integer', description: '已确认的收款单 id（只有已确认的收款单才有可用预收）' },
            ar_id: { type: 'integer', description: '指定要抵扣的应收单；与 auto 二选一' },
            amount: { type: 'integer', description: '抵扣金额；不传则抵到该应收单结清或用完预收' },
            auto: { type: 'boolean', description: 'true = 按到期日 FIFO 自动抵扣该客户最老的未结应收' }
          }
        },
        ArOcSync: {
          type: 'object',
          properties: {
            limit: { type: 'integer', description: '本次最多并入多少张（默认 500）' },
            customer_id: { type: 'integer', description: '只并入某个订货客户的订单' }
          }
        },
        InvoiceFromDelivery: {
          type: 'object',
          required: ['delivery_id'],
          properties: {
            delivery_id: { type: 'integer', description: '来源发货单 id' },
            invoice_date: { type: 'string', description: '开票日期 YYYY-MM-DD，缺省为今天' },
            invoice_no: { type: 'string', description: '税务发票号（票面号，可后补）' },
            tax_rate: { type: 'number', description: '税率，缺省 0.13；含税单价按此反推不含税与税额' },
            items: {
              type: 'array',
              description: '分批开票：指定要开的发货行与数量；不传 = 该发货单所有未开行一次开完',
              items: {
                type: 'object',
                properties: {
                  item_id: { type: 'integer', description: '发货行 id（sales_delivery_items.id）' },
                  qty: { type: 'number', description: '本次开票数量（不超过该行剩余可开数量）' }
                }
              }
            },
            remark: { type: 'string' }
          }
        },
        InvoiceManual: {
          type: 'object',
          required: ['subject_type', 'subject_id', 'items'],
          properties: {
            subject_type: { type: 'string', description: 'dealer / store' },
            subject_id: { type: 'integer' },
            subject_name: { type: 'string' },
            invoice_date: { type: 'string' },
            invoice_no: { type: 'string' },
            tax_rate: { type: 'number' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['qty', 'price'],
                properties: {
                  sku_id: { type: 'integer' },
                  qty: { type: 'number' },
                  price: { type: 'number', description: '含税单价' },
                  total_amount: { type: 'number', description: '含税金额；不传则按 qty × price 计算' },
                  tax_rate: { type: 'number' }
                }
              }
            },
            remark: { type: 'string' }
          }
        },
        InvoiceConfirm: {
          type: 'object',
          properties: {
            credit_days: { type: 'integer', description: '新建应收时的账期天数；不传则取客户默认账期' }
          }
        },
        InvoiceRedChart: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', description: '红冲原因（必填，写入红字票与原票流转留痕）' } }
        },
        InvoiceVoid: {
          type: 'object',
          properties: { reason: { type: 'string', description: '作废原因' } }
        },
        // ----- 质量检验（模块 13）-----
        QcRequestCreate: {
          type: 'object',
          required: ['source_type'],
          properties: {
            source_type: { type: 'string', enum: ['purchase_receipt', 'production_order', 'inventory'], description: '报检来源' },
            source_id: { type: 'integer', description: '来源单据 id（inventory 来源可不传）' },
            request_date: { type: 'string', description: '报检日期 YYYY-MM-DD，缺省为今天' },
            aql: { type: 'number', description: '接收质量限，缺省 2.5' },
            level: { type: 'string', enum: ['normal', 'tightened', 'reduced'], description: '检验水平，缺省 normal' },
            warehouse_id: { type: 'integer', description: 'inventory 来源必填' },
            items: {
              type: 'array',
              description: '覆盖来源行（只报检一部分行 / 部分数量）；不传 = 来源单据全部行按原数量报检',
              items: {
                type: 'object',
                properties: {
                  source_item_id: { type: 'integer', description: '来源行 id（采购到货行 id）' },
                  sku_id: { type: 'integer' },
                  batch_no: { type: 'string' },
                  qty: { type: 'number', description: '报检数量' }
                }
              }
            },
            remark: { type: 'string' }
          }
        },
        QcInspectSubmit: {
          type: 'object',
          properties: {
            lines: {
              type: 'array',
              description: '逐行实测结果；不传的行沿用草稿里的不良数（0）',
              items: {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'integer', description: '报检行 id（qc_request_items.id）' },
                  defect_qty: { type: 'number', description: '实测不良数（不得超过抽样量）' },
                  defect_code: { type: 'string', description: '缺陷代码' },
                  defect_reason: { type: 'string' },
                  remark: { type: 'string' }
                }
              }
            },
            remark: { type: 'string' }
          }
        },
        QcHandlingCreate: {
          type: 'object',
          required: ['inspection_id', 'qty', 'mode'],
          properties: {
            inspection_id: { type: 'integer' },
            sku_id: { type: 'integer' },
            batch_no: { type: 'string' },
            qty: { type: 'number', description: '处理数量（不得超过该行报检数量减去已处置量）' },
            mode: { type: 'string', enum: ['concession', 'return', 'scrap', 'rework'], description: '让步接收 / 退货 / 报废 / 返工' },
            reason: { type: 'string', description: '处置理由（让步接收必填）' },
            defect_code: { type: 'string' },
            remark: { type: 'string' }
          }
        },
        CreditAccountUpdate: {
          type: 'object',
          properties: {
            credit_limit: { type: 'number' },
            credit_days: { type: 'integer' },
            temp_limit: { type: 'number' },
            temp_expire_at: { type: 'string', description: '临时额度到期日；过期即失效，不再计入可用额度' },
            settle_type: { type: 'string' },
            status: { type: 'string', enum: ['active', 'frozen'] },
            frozen_reason: { type: 'string', description: '冻结原因（status=frozen 时必填，界面上要能看见）' },
            remark: { type: 'string' }
          }
        },
        CreditCheckRequest: {
          type: 'object',
          required: ['amount'],
          properties: {
            amount: { type: 'number' },
            dealer_id: { type: 'integer' },
            customer_id: { type: 'integer' },
            store_id: { type: 'integer' },
            account_id: { type: 'integer' },
            scene: { type: 'string', example: 'order.confirm' },
            source_type: { type: 'string' },
            source_id: { type: 'integer' },
            doc_no: { type: 'string' },
            force: { type: 'boolean' },
            reason: { type: 'string' }
          }
        },
        CreditSettle: {
          type: 'object',
          required: ['amount'],
          properties: {
            amount: { type: 'number' },
            dealer_id: { type: 'integer' },
            customer_id: { type: 'integer' },
            account_id: { type: 'integer' },
            source_type: { type: 'string', example: 'SO' },
            source_id: { type: 'integer' },
            doc_no: { type: 'string' },
            remark: { type: 'string' }
          }
        },
        CreditAdjust: {
          type: 'object',
          required: ['amount', 'remark'],
          properties: {
            amount: { type: 'number', description: '正=加占用，负=减占用' },
            remark: { type: 'string' },
            dealer_id: { type: 'integer' },
            customer_id: { type: 'integer' },
            account_id: { type: 'integer' }
          }
        },
        CreditRelease: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: '不传则按台账里该单据未释放的占用额整笔回冲' },
            source_type: { type: 'string', example: 'SO' },
            source_id: { type: 'integer' },
            doc_no: { type: 'string' },
            dealer_id: { type: 'integer' },
            customer_id: { type: 'integer' },
            account_id: { type: 'integer' },
            remark: { type: 'string' }
          }
        },
        ChangePasswordRequest: {
          type: 'object', required: ['oldPassword', 'newPassword'],
          properties: {
            oldPassword: { type: 'string', format: 'password', writeOnly: true, description: '当前密码，最多1024个UTF-8字节' },
            newPassword: { type: 'string', format: 'password', writeOnly: true, minLength: 16, description: '至少16个Unicode字符，最多72个UTF-8字节，至少6种不同字符，不含控制字符' }
          }
        },
        ChangePasswordResult: {
          type: 'object', required: ['changed', 'reauthenticate'],
          properties: { changed: { type: 'boolean', enum: [true] }, reauthenticate: { type: 'boolean', enum: [true] } }
        },
        LogoutAllResult: {
          type: 'object', required: ['revoked'],
          properties: { revoked: { type: 'boolean', enum: [true] } }
        },
        RoleDeactivate: {
          type: 'object',
          required: ['confirm_affected'],
          properties: { confirm_primary: { type: 'integer', minimum: 0, description: '可选：影响预告里的 primary_users；给了就必须与停用时现算的一致（总数不变而主角色人数变了同样 409 ROLE_IMPACT_CHANGED）' }, confirm_affected: { type: 'integer', minimum: 0, description: '影响预告里的 affected_users；与停用时事务内现算的人数不一致即拒绝（409 ROLE_IMPACT_CHANGED）' } }
        },
        LoginRequest: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', example: 'admin' },
            password: { type: 'string', example: '12345' },
            industry: { type: 'string', enum: ['cosmetic', 'food', 'apparel'], example: 'cosmetic', description: '行业版本，缺省为 cosmetic' }
          }
        },
        // ---- 系统参数（批次 R）----
        SettingWrite: {
          type: 'object',
          required: ['key', 'value'],
          properties: {
            key: { type: 'string', example: 'closing_profit_subject', description: '配置键。**必须在服务端 `SETTING_RULES` 里登记**（未登记直接拒绝）' },
            value: { example: '4103', description: '新值。按登记的类型归一化：布尔收 1/0/true/false/on/off，整数收整数字符串，科目编码必须是纯数字，枚举只收登记过的 value 或 label' },
            reason: { type: 'string', nullable: true, description: '修改理由。**危险配置（会计政策 / 应收口径 / 门店阈值）必填** —— 改它会让已经结出来的账换一种解释' }
          }
        },
        SettingReset: {
          type: 'object',
          required: ['key'],
          properties: {
            key: { type: 'string', example: 'closing_profit_subject' },
            reason: { type: 'string', nullable: true, description: '恢复默认值的理由。危险配置必填（"它回到了默认值"不是理由，"为什么让它回到默认值"才是）' }
          }
        },
        UserCreate: {
          type: 'object',
          required: ['username', 'password', 'name'],
          properties: {
            username: { type: 'string' },
            password: { type: 'string' },
            name: { type: 'string' },
            role: { type: 'string', enum: ['admin', 'purchase', 'sales', 'warehouse', 'finance', 'dealer', 'store', 'viewer'] },
            dept: { type: 'string' },
            phone: { type: 'string' },
            dealer_id: { type: 'integer' },
            store_id: { type: 'integer' }
          }
        },
        ProductCreate: {
          type: 'object',
          required: ['name'],
          properties: {
            spu_code: { type: 'string', example: 'SP10021' },
            name: { type: 'string', example: '晨曦神经酰胺修护霜' },
            brand_id: { type: 'integer' },
            category_id: { type: 'integer' },
            series: { type: 'string' },
            spec: { type: 'string' },
            unit: { type: 'string', example: '罐' },
            shelf_life_months: { type: 'integer', example: 36 },
            tax_rate: { type: 'number', example: 13 },
            price_retail: { type: 'number' },
            price_dealer: { type: 'number' },
            price_member: { type: 'number' },
            cost_std: { type: 'number' },
            safe_stock: { type: 'integer' },
            skus: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  sku_code: { type: 'string' },
                  name: { type: 'string' },
                  color_no: { type: 'string' },
                  spec: { type: 'string' },
                  price_retail: { type: 'number' },
                  price_dealer: { type: 'number' },
                  price_member: { type: 'number' },
                  cost_std: { type: 'number' },
                  safe_stock: { type: 'integer' }
                }
              }
            }
          }
        },
        PurchaseOrderCreate: {
          type: 'object',
          required: ['supplier_id', 'warehouse_id', 'items'],
          properties: {
            supplier_id: { type: 'integer' },
            warehouse_id: { type: 'integer' },
            order_date: { type: 'string', example: '2026-10-14' },
            expect_date: { type: 'string' },
            settle_type: { type: 'string' },
            remark: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['sku_id', 'qty'],
                properties: {
                  sku_id: { type: 'integer' },
                  qty: { type: 'number' },
                  price: { type: 'number' },
                  tax_rate: { type: 'number', example: 13 }
                }
              }
            }
          }
        },
        SalesOrderCreate: {
          type: 'object',
          required: ['items'],
          properties: {
            channel: { type: 'string', enum: ['dealer', 'store', 'online', 'platform', 'live'], example: 'dealer' },
            dealer_id: { type: 'integer', description: '经销商渠道必填' },
            store_id: { type: 'integer', description: '门店渠道必填' },
            platform_id: { type: 'integer' },
            oms_order_no: { type: 'string' },
            order_date: { type: 'string', example: '2026-10-14' },
            warehouse_id: { type: 'integer', description: '不传则自动取门店仓/中心仓' },
            freight: { type: 'number' },
            discount_amount: { type: 'number' },
            receiver: { type: 'string' },
            receiver_phone: { type: 'string' },
            receiver_address: { type: 'string' },
            remark: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['sku_id', 'qty'],
                properties: {
                  sku_id: { type: 'integer' },
                  qty: { type: 'number' },
                  price: { type: 'number', description: '不传则按渠道+经销商折扣自动取价' },
                  discount: { type: 'number' }
                }
              }
            }
          }
        },
        StatusAction: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['submit', 'approve', 'close', 'cancel'] } }
        },
        DemandSummary: {
          type: 'object',
          required: ['startDate', 'endDate'],
          properties: {
            startDate: { type: 'string', example: '2026-10-01', description: '汇总开始日期' },
            endDate: { type: 'string', example: '2026-12-31', description: '汇总结束日期' },
            warehouse_id: { type: 'integer', description: '库存对比仓（缺省取中心仓）' },
            include_requests: { type: 'boolean', default: true, description: '是否纳入经销商要货申请' },
            include_plans: { type: 'boolean', default: true, description: '是否纳入经销商要货计划' }
          }
        },
        DemandToOrders: {
          type: 'object',
          required: ['period_start', 'period_end', 'lines'],
          properties: {
            period_start: { type: 'string', example: '2026-10-01' },
            period_end: { type: 'string', example: '2026-12-31' },
            warehouse_id: { type: 'integer' },
            outsource_supplier_id: { type: 'integer', description: '委外行统一指定的加工商' },
            lines: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  sku_id: { type: 'integer' },
                  qty: { type: 'number' },
                  route: { type: 'string', enum: ['purchase', 'production', 'outsourcing'] },
                  supplier_id: { type: 'integer' },
                  price: { type: 'number' }
                }
              }
            }
          }
        },
        ApprovalSubmit: {
          type: 'object',
          required: ['doc_type', 'doc_id', 'action'],
          properties: {
            doc_type: { type: 'string', example: 'PO', description: '单据类型码' },
            doc_id: { type: 'integer', example: 12 },
            doc_no: { type: 'string', example: 'PO202610110001' },
            action: { type: 'string', example: 'cancel', description: '需要审批的动作码（须与 doc_actions 一致）' },
            remark: { type: 'string', description: '提交说明' }
          }
        },
        AiQuery: {
          type: 'object',
          required: ['intent'],
          properties: {
            intent: {
              type: 'string',
              enum: [
                'sales_summary', 'sales_trend', 'channel_compare', 'inventory_query', 'stock_alert',
                'expiring_stock', 'dealer_ranking', 'dealer_profile', 'purchase_status', 'oms_pending', 'product_360'
              ],
              example: 'stock_alert'
            },
            params: {
              type: 'object',
              description: '各 intent 支持的参数见 /api/ai/manifest',
              properties: {
                question: { type: 'string', description: '原始自然语言问题（用于日志）' },
                days: { type: 'integer' },
                limit: { type: 'integer' },
                keyword: { type: 'string' },
                dealer_id: { type: 'integer' },
                sku_id: { type: 'integer' },
                warehouse_id: { type: 'integer' },
                startDate: { type: 'string' },
                endDate: { type: 'string' },
                channel: { type: 'string' }
              }
            },
            source: { type: 'string', example: 'agent' }
          }
        },

        // ----- 生产制造（模块 10B）请求体 -----
        RemarkOnly: {
          type: 'object',
          properties: { remark: { type: 'string', description: '备注 / 说明（可空）' } }
        },
        BomCreate: {
          type: 'object',
          required: ['product_sku_id', 'items'],
          properties: {
            product_sku_id: { type: 'integer', description: '母件 SKU（要生产/组装出来的成品）' },
            usage: { type: 'string', enum: ['self_made', 'outsourced', 'combo'], default: 'self_made', description: '用途。同一母件同一用途只能有一版' },
            version: { type: 'string', example: 'V1.0', description: '版本号（换版请作废后新建）' },
            base_qty: { type: 'number', default: 1, description: '基准批量：下面填的是「批量 N 件需要多少」' },
            produce_way: { type: 'string', enum: ['self_made', 'outsourced'], description: '生产方式；缺省按 usage 推导' },
            warehouse_id: { type: 'integer', description: '默认生产仓（可空）' },
            effective_from: { type: 'string', example: '2026-01-01' },
            effective_to: { type: 'string', description: '留空表示长期有效' },
            remark: { type: 'string' },
            items: {
              type: 'array',
              minItems: 1,
              description: '组件行。用量必须 > 0；损耗率填小数（5% 填 0.05，填 5 会被 BOM_ITEM_LOSS_SUSPECT 拦下）',
              items: {
                type: 'object',
                required: ['sku_id', 'qty'],
                properties: {
                  sku_id: { type: 'integer' },
                  qty: { type: 'number', description: '基准批量下的用量' },
                  loss_rate: { type: 'number', default: 0, description: '损耗率，小数' },
                  substitute_group: { type: 'string', description: '替代组名；同组内多行互为替代' },
                  priority: { type: 'integer', default: 0, description: '替代优先级，0 为最高' },
                  issue_way: { type: 'string', default: 'by_bom' },
                  remark: { type: 'string' }
                }
              }
            }
          }
        },
        BomUpdate: {
          type: 'object',
          description: '只允许改**草稿**；已审批的返回 BOM_APPROVED_IMMUTABLE。传了 items 则整体替换组件行',
          properties: {
            version: { type: 'string' },
            base_qty: { type: 'number' },
            produce_way: { type: 'string', enum: ['self_made', 'outsourced'] },
            warehouse_id: { type: 'integer' },
            effective_from: { type: 'string' },
            effective_to: { type: 'string' },
            remark: { type: 'string' },
            items: { type: 'array', description: '同 BomCreate.items', items: { type: 'object' } }
          }
        },
        BomExpand: {
          type: 'object',
          required: ['qty'],
          properties: {
            qty: { type: 'number', description: '计划生产数量，必须 > 0' },
            warehouse_id: { type: 'integer', description: '生产仓。给了才能判断替代料的库存够不够；不给则只按优先级取主料' },
            allow_substitute: { type: 'boolean', default: true, description: 'false 表示永远取主料' }
          }
        },
        IssueCreate: {
          type: 'object',
          required: ['order_id'],
          properties: {
            order_id: { type: 'integer', description: '生产订单（须为「生产中」）' },
            warehouse_id: { type: 'integer', description: '领料仓；缺省取订单仓' },
            issue_date: { type: 'string', example: '2026-10-15' },
            issue_type: { type: 'string', enum: ['by_bom', 'limit', 'supplement'], default: 'by_bom', description: '限额领料不得超 BOM 需求；确需多领请改 supplement 并填原因' },
            remark: { type: 'string', description: 'supplement 时**必填**原因' },
            items: {
              type: 'array',
              description: '不传或传 null 时按 BOM 自动装填待领量',
              items: {
                type: 'object',
                required: ['sku_id', 'qty'],
                properties: {
                  sku_id: { type: 'integer' },
                  qty: { type: 'number' },
                  batch_no: { type: 'string', description: '留空则由库存引擎按拣选规则取批，出库后回写实际批次号' },
                  substitute_for: { type: 'integer', description: '替代的是哪一行（留痕用）' },
                  remark: { type: 'string' }
                }
              }
            }
          }
        },
        WorkReportCreate: {
          type: 'object',
          required: ['order_id'],
          properties: {
            order_id: { type: 'integer', description: '生产订单（须为「生产中」）' },
            issue_id: { type: 'integer', description: '关联的领料单（可空）' },
            report_date: { type: 'string', example: '2026-10-15' },
            process_name: { type: 'string' },
            good_qty: { type: 'number', description: '良品数。良品与不良不能同时为 0；良品不得使累计完工超过订单数量' },
            defect_qty: { type: 'number', default: 0 },
            work_hours: { type: 'number', default: 0 },
            labor_rate: { type: 'number', default: 0, description: '人工成本 = 工时 × 费率' },
            overhead_cost: { type: 'number', default: 0, description: '制造费用' },
            batch_no: { type: 'string', description: '可空' },
            remark: { type: 'string' }
          }
        },
        OrderComplete: {
          type: 'object',
          properties: {
            report_id: { type: 'integer', description: '只入库某一张汇报；不传则把该单全部待入库汇报一起入' },
            batch_no: { type: 'string', description: '留空由系统生成' },
            warehouse_id: { type: 'integer', description: '缺省取订单仓' },
            remark: { type: 'string' }
          }
        },
        PosOrderCreate: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              description: '购物明细；数量与单价都必须为正，库存在**写库前**校验（不是事后回滚）',
              items: {
                type: 'object',
                properties: {
                  sku_id: { type: 'integer' },
                  qty: { type: 'number' },
                  price: { type: 'number', description: '不传取零售价；低于零售价需门店有折扣权限（演示环境不做限制）' }
                }
              }
            },
            member_phone: { type: 'string' },
            pay_method: { type: 'string', enum: ['cash', 'wxpay', 'alipay', 'unionpay', 'balance', 'other'], description: '缺省 cash' },
            discount_amount: { type: 'number', default: 0 },
            remark: { type: 'string' }
          }
        },
        PosShiftOpen: {
          type: 'object',
          properties: {
            biz_date: { type: 'string', example: '2026-10-15', description: '营业日；缺省今天（**营业日 ≠ 自然日**，跨零点后仍算前一天）' },
            opening_float: { type: 'number', default: 0, description: '钱箱备用金。**不参与长短款** —— 备用金是店里的零钱本金，不是销售应收' },
            device_no: { type: 'string', description: '收银机编号。一家店多钱箱时用它区分' },
            remark: { type: 'string' }
          }
        },
        PosShiftDeclare: {
          type: 'object',
          properties: {
            payments: {
              type: 'array',
              description: '按支付方式的报数。**一种支付方式一行**（`UNIQUE (shift_id, method)` 兜底）；不传的行按「系统应收原额」补齐，所以只报差异行也行',
              items: {
                type: 'object',
                properties: {
                  method: { type: 'string', enum: ['cash', 'wxpay', 'alipay', 'unionpay', 'balance', 'other'] },
                  declared_amount: { type: 'number', description: '收银员报的金额（现金是数钱，非现金读支付流水）' }
                }
              }
            },
            remark: { type: 'string' }
          }
        },
        PosShiftApprove: {
          type: 'object',
          required: ['counted_cash'],
          properties: {
            counted_cash: { type: 'number', description: '店长**实点**现金。必填且必须传 —— 不传就核款等于让长短款凭空消失' },
            variance_note: { type: 'string', description: '有差异时必填（原因）' },
            variance_handled: { type: 'string', enum: ['charge', 'absorb', 'pending'], description: '有差异时必填（归属）。金额超过 pos_variance_limit 时会被强制改成 pending' },
            float_returned: { type: 'boolean', default: true, description: '备用金是否归还钱箱（false 时备用金留在实点里）' },
            remark: { type: 'string' }
          }
        },
        PosVarianceSettle: {
          type: 'object',
          required: ['handled'],
          properties: {
            handled: { type: 'string', enum: ['charge', 'absorb'], description: '总部落案：责任人承担 / 公司承担。不接受 pending（那本来就是要被替换掉的状态）' },
            note: { type: 'string', description: '落案说明' }
          }
        },
        PosCashDropCreate: {
          type: 'object',
          required: ['shift_ids'],
          properties: {
            shift_ids: { type: 'array', description: '要缴的班次（**一个班次只能缴一次款**，`UNIQUE (shift_id)` 兜底）。只能选已核款且实点现金大于已缴金额的班次', items: { type: 'integer' } },
            drop_date: { type: 'string', description: '缴款日期，缺省今天' },
            reference_no: { type: 'string', description: '银行/押运凭据号' },
            remark: { type: 'string' }
          }
        },
        PosDailyClose: {
          type: 'object',
          properties: {
            biz_date: { type: 'string', example: '2026-10-15', description: '营业日；缺省今天。只上传该营业日的本地单' }
          }
        },
        PosReturnCreate: {
          type: 'object',
          required: ['items'],
          properties: {
            shift_id: { type: 'integer', description: '退货挂哪个班次（缺省取当前营业中班次）。挂错班次会让退货冲减到别人的现金应收上' },
            items: { type: 'array', items: { type: 'object', properties: { sku_id: { type: 'integer' }, qty: { type: 'number' } } } },
            reason: { type: 'string' },
            return_date: { type: 'string' },
            refund_method: { type: 'string', enum: ['cash', 'wxpay', 'alipay', 'unionpay', 'balance', 'other'], default: 'cash', description: '原路退回的支付方式；会冲减该方式在本班次的系统应收' },
            order_id: { type: 'integer', description: '关联原零售单（留痕用，可空）' }
          }
        },
        PosStoreCheckCreate: {
          type: 'object',
          properties: {
            sku_ids: { type: 'array', description: '只盘这些 SKU；不传则整店全盘', items: { type: 'integer' } },
            check_date: { type: 'string', description: '盘点日期，缺省今天' },
            checker: { type: 'string' },
            remark: { type: 'string' }
          }
        },

        // —— 模块 18 促销与会员 ——

        StatusOnly: {
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string', description: '目标状态（各接口的允许值不同，见 /meta 的字典）' } }
        },
        AtOnly: {
          type: 'object',
          properties: { at: { type: 'string', description: '判定时点 YYYY-MM-DD HH:mm:ss，缺省现在。用于把"某一刻哪些券算过期"复现出来' } }
        },
        ForceOnly: {
          type: 'object',
          properties: { force: { type: 'boolean', description: 'true = 无视 member_upgrade_auto 开关强制按规则重判' } }
        },
        PromotionCreate: {
          type: 'object',
          required: ['code', 'name'],
          properties: {
            code: { type: 'string', description: '促销编码，全局唯一；有使用记录后不可改' },
            name: { type: 'string' },
            type: { type: 'string', enum: ['standard', 'buyget'], default: 'standard' },
            status: { type: 'string', enum: ['active', 'inactive'], default: 'active' },
            campaign_id: { type: 'integer', description: '所属活动（可空）' },
            is_automatic: { type: 'boolean', default: false, description: 'true = 无需券码自动参与；false = 必须命中券码' },
            is_tax_inclusive: { type: 'boolean', default: false },
            priority: { type: 'integer', default: 100, description: '数值小者先算（先算的先把额度用掉）' },
            stack_group: { type: 'string', description: '同组互斥：一组里只取最先命中的那个。与 is_exclusive 不能同时设' },
            is_exclusive: { type: 'boolean', default: false, description: '独占：一生效其它促销全部不参与' },
            usage_limit: { type: 'integer', description: '总使用次数上限，null = 不限。条件式 UPDATE 兜底防超发' },
            starts_at: { type: 'string' },
            ends_at: { type: 'string' },
            remark: { type: 'string' },
            method: {
              type: 'object',
              description: '**唯一一个**优惠方式（DB 上有 UNIQUE(promotion_id)）。两个方式会让「减多少」变成不确定',
              required: ['type', 'target_type', 'allocation', 'value'],
              properties: {
                type: { type: 'string', enum: ['fixed', 'percentage'], description: 'fixed = value 即减免的分；percentage = value 是万分比' },
                target_type: { type: 'string', enum: ['items', 'order', 'shipping'] },
                allocation: { type: 'string', enum: ['each', 'across', 'once'], description: 'each 逐行独立 / across 整单算完按行摊 / once 只作用于最便宜的 N 件（必须给 max_quantity）' },
                value: { type: 'integer', description: 'fixed 时单位是分；percentage 时是**减免率**的万分比（500 = 减 5%，即 95 折；1000 = 减 10%，即 9 折；10000 = 全免），上限 10000' },
                max_quantity: { type: 'integer', description: 'allocation=once 时必填' },
                buy_rules_min_quantity: { type: 'integer', description: '买赠门槛（买几件）' },
                gift_sku_id: { type: 'integer', description: '买赠赠品 SKU' }
              }
            },
            rules: {
              type: 'object',
              description: '三组规则，**只会做比较、不做表达式求值**（属性名走白名单，避免注入面）',
              properties: {
                rules: { type: 'array', description: '订单级适用条件，如 subtotal >= 10000', items: { $ref: '#/components/schemas/PromoRule' } },
                target_rules: { type: 'array', description: '作用对象条件，如 category_id in 3,5', items: { $ref: '#/components/schemas/PromoRule' } },
                buy_rules: { type: 'array', description: '买赠的购买条件', items: { $ref: '#/components/schemas/PromoRule' } }
              }
            }
          }
        },
        PromoRule: {
          type: 'object',
          required: ['attribute', 'operator', 'value'],
          properties: {
            attribute: { type: 'string', enum: ['sku_id', 'category_id', 'qty', 'unit_price', 'subtotal', 'shipping_fee', 'level', 'level_code', 'customer_id'] },
            operator: { type: 'string', enum: ['in', 'not_in', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte'] },
            value: { type: 'string', description: 'in / not_in 用逗号分隔多个值' }
          }
        },
        PromoCampaignCreate: {
          type: 'object',
          required: ['code', 'name'],
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            starts_at: { type: 'string' },
            ends_at: { type: 'string' },
            status: { type: 'string', enum: ['active', 'ended'], default: 'active' }
          }
        },
        PromoQuote: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', description: '购物车行。只传 {sku_id, qty} 时按 SKU 零售价兜底；已用取价引擎算过就带上 unit_price_cents', items: { type: 'object', properties: { sku_id: { type: 'integer' }, qty: { type: 'number' }, unit_price_cents: { type: 'integer' }, is_discountable: { type: 'boolean', description: 'false = 该行不参与任何折扣' } } } },
            customer_id: { type: 'integer', description: '会员客户 id；不传则不算会员折扣与积分' },
            coupon_codes: { type: 'array', description: '本单要用的券实例码。**不传就是一张都不用**', items: { type: 'string' } },
            auto_coupon: { type: 'boolean', default: false, description: 'true = 自动带上该客户名下所有可用券。默认 false —— 否则普通试算会顺手把券全用掉' },
            use_points: { type: 'integer', default: 0, description: '想抵的积分数；超过等级上限会被拒（不会静默截断）' },
            at: { type: 'string', description: '算价时点，缺省现在。用于复现某一刻的活动命中结果' }
          }
        },
        PriceAgreement: {
          type: 'object',
          required: ['name', 'dealer_id'],
          properties: {
            code: { type: 'string', description: '协议编码；**留空则按「XY + 年 + 4 位序号」自生成**（与演示造数同一条规则）' },
            name: { type: 'string' },
            dealer_id: { type: 'integer', description: '协议主体：**具体某一家经销商**（不是 dealer_level —— 等级是共享维度，用它表达"某一家"会影响所有同档客户）' },
            target_type: { type: 'string', enum: ['sku', 'category', 'all'], default: 'sku' },
            target_id: { type: 'integer', description: 'sku_id 或 category_id；`target_type=all` 时必须为空' },
            price_type: { type: 'string', enum: ['fixed', 'discount'], default: 'fixed', description: 'fixed 定价 / discount 折扣（在标准零售价上按万分比折）' },
            price: { type: 'number', description: 'price_type=fixed 时的协议单价' },
            discount_bp: { type: 'integer', default: 10000, description: 'price_type=discount 时的折扣万分比（9500 = 95 折）。必须落在 (0, 10000)' },
            min_qty: { type: 'number', default: 1, description: '起订量：低于它不适用本协议' },
            effect_from: { type: 'string', description: '合同周期起（含）' },
            effect_to: { type: 'string', description: '合同周期止（含）' },
            priority: { type: 'integer', default: 100, description: '数值小者优先（同类协议并存时用它裁决）' },
            status: { type: 'string', enum: ['active', 'inactive'], default: 'active' },
            remark: { type: 'string' }
          }
        },
        RebatePolicy: {
          type: 'object',
          required: ['code', 'name', 'type'],
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string', enum: ['tiered', 'fixed_per_unit', 'growth', 'payback', 'category', 'seasonal'] },
            dealer_level: { type: 'string', default: 'all' },
            channel_type: { type: 'string', default: 'all' },
            period: { type: 'string', description: '生效期间：`2026-10` 或 `2026-Q4`' },
            basis: { type: 'string', enum: ['net', 'gross', 'pay'], default: 'net', description: '计返基数：净销售（扣退货）/ 毛销售 / 回款额' },
            rules: { type: 'object', description: '规则体：tiers / perUnit / rate / payRatio / categoryId / target' },
            rebate_cap: { type: 'number', default: 0, description: '单期封顶，0 = 不封顶' },
            priority: { type: 'integer', default: 100 },
            status: { type: 'string', default: 'active' },
            remark: { type: 'string' }
          }
        },
        RebatePlan: {
          type: 'object',
          required: ['dealer_id', 'period'],
          properties: {
            dealer_id: { type: 'integer' },
            period: { type: 'string', description: '期间，必须 `YYYY-MM`（格式写错的后果是"这一期永远算不出返利"）' },
            policy_id: { type: 'integer', description: '只算某一条政策；不传则算这一期全部适用政策' }
          }
        },
        AccountingSubject: {
          type: 'object',
          required: ['code', 'name', 'category'],
          properties: {
            code: { type: 'string', description: '科目编码，全局唯一，且**不可修改**（它是历史凭证上的对外标识）' },
            name: { type: 'string' },
            category: { type: 'string', enum: ['asset', 'liability', 'equity', 'cost', 'profit_loss'] },
            direction: { type: 'string', enum: ['debit', 'credit'], description: '余额方向。不传则按类别推断（资产 / 成本 → 借，其余 → 贷）' },
            parent_id: { type: 'integer', description: '上级科目 id。挂上子科目后，父科目**自动变成不可记账**（由结构推导）' },
            aux_type: { type: 'string', enum: ['customer', 'supplier'], description: '辅助核算类型' },
            remark: { type: 'string' }
          }
        },
        VoucherGenerate: {
          type: 'object',
          required: ['biz_type', 'source_id'],
          properties: {
            biz_type: {
              type: 'string',
              enum: ['purchase_inbound', 'sales_delivery', 'cost_carry', 'receipt', 'payment', 'refund', 'purchase_return'],
              description: '业务场景。`purchase_inbound` 采购入库暂估 / `sales_delivery` 销售出库确认收入 / `cost_carry` 结转销售成本 / `receipt` 收款 / `payment` 付款 / `refund` 销售退款 / `purchase_return` 采购退货冲回暂估。⚠️ 这份枚举是**文档**，真正的唯一出处在 `lib/accounting.js` 的 `BIZ_TYPES`；此处曾漏登记 `refund`（本批一并补上）'
            },
            source_type: { type: 'string', description: '可省略；传了就必须与业务场景的来源表一致' },
            source_id: { type: 'integer', description: '来源单据 id。生成器会校验它的**状态已允许入账**（例如草稿的收款单不是事实）' },
            memo: { type: 'string' }
          }
        },
        VoucherVoid: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: '作废理由。**作废已过账凭证时必填** —— 它会改变当期发生额，账少了钱得有人知道为什么' }
          }
        },
        RefundCreate: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              description: '分摊明细：退哪张退货单、退多少。**至少一条**；同一张退货单不能出现两次（合并后判据才有唯一口径）',
              items: {
                type: 'object',
                required: ['return_id', 'amount'],
                properties: {
                  return_id: { type: 'integer', description: '退货单 id（`sales_returns.id`）' },
                  amount: { type: 'number', description: '本次退这张退货单多少钱，恒 > 0' }
                }
              }
            },
            refund_date: { type: 'string', description: '退款日期 YYYY-MM-DD，缺省为今天' },
            method: { type: 'string', enum: ['bank', 'cash', 'wechat', 'alipay', 'original'], description: '退款方式' },
            idempotency_key: { type: 'string', description: '重放保护：同键返回**首次那张退款单**，不重复登记（动钱的动作最怕重放）' },
            bank_account: { type: 'string' },
            serial_no: { type: 'string', description: '银行流水号' },
            remark: { type: 'string' }
          }
        },
        RefundVoid: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: '作废理由。**必填** —— 作废一张已退款的单会让一笔已出的钱从账上消失，必须答得出为什么' }
          }
        },
        ReportDefSave: {
          type: 'object',
          required: ['name', 'basis'],
          properties: {
            name: { type: 'string' },
            basis: { type: 'string', enum: ['balance', 'amount', 'cash_flow'], description: '取数口径：期末余额 / 本期发生额 / 现金收支（对手科目分析填列）' },
            cash_subjects: { type: 'string', description: '仅 `cash_flow`：现金类科目码，逗号分隔（默认 1001,1002）' },
            cover_categories: { type: 'string', description: '**必须穷尽覆盖**的科目大类，逗号分隔（`asset,liability,equity,cost,profit_loss`）。空 = 不做覆盖检查' },
            remark: { type: 'string' },
            status: { type: 'string', enum: ['active', 'disabled'], description: '停用一张报表也是会计政策变更（`status` 在危险字段集里）' },
            reason: { type: 'string', description: '**动了危险字段时必填**（`basis` / `cash_subjects` / `cover_categories` / `status`）——否则 400`REPORT_CONFIG_REASON_REQUIRED`。只改名称 / 备注可以不填' }
          }
        },
        ReportLineSave: {
          type: 'object',
          required: ['report_code', 'line_code', 'line_no', 'line_name', 'line_type'],
          properties: {
            report_code: { type: 'string', enum: ['bs', 'pl', 'cf'] },
            line_code: { type: 'string', description: '机器键（如 `BS_ASSETS_TOTAL`）：报表自证按它找行，不按中文名。**它同时是身份键**：改了它等于新增一行，不会命中原来那一行' },
            line_no: { type: 'integer', description: '行号：小计表达式按它引用。撞到别的行 → 409`LINE_NO_TAKEN`；被小计引用时不许改 → 409`LINE_NO_IN_USE`' },
            display_no: { type: 'string' },
            line_name: { type: 'string' },
            line_type: { type: 'string', enum: ['item', 'subtotal', 'total'] },
            level: { type: 'integer' },
            subject_range: { type: 'string', description: '`item` 行必填。科目码闭区间，**可多段**：`1122~1122|2203~2203`' },
            sign: { type: 'integer', enum: [1, -1], description: '方向口径：行金额 = `sign × Σ(本行认领科目的 signed)`，其中 `signed = 借 − 贷`' },
            only_direction: { type: 'string', enum: ['credit', 'debit'], description: '仅现金流量表：只接流入 / 只接流出。同一科目在两个方向上语义不同（贷 222101 是代收销项税，借 222101 是实际缴税）' },
            subtotal_expr: { type: 'string', description: '`subtotal` / `total` 行必填。**只允许「行号 + 加减号」**（如 `1+2+3-4`）—— 能写表达式的配置就等于配置能改账' },
            is_fallback: { type: 'boolean', description: '兜底行：只接没有任何具体行认领的科目。一张报表只允许一个' },
            order_no: { type: 'integer' },
            remark: { type: 'string' },
            reason: { type: 'string', description: '**动了危险字段时必填**（`line_no` / `line_type` / `subject_range` / `sign` / `only_direction` / `subtotal_expr` / `is_fallback`），`create` 同样必填（新增一行会让报表多一块）。只改行名 / 行次 / 缩进 / 排序 / 备注可以不填。响应带 `changed` / `logged` / `entry_id`' }
          }
        },
        ReportLineDelete: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', description: '**必填**。删掉一行口径会让报表少一块，而 `report_lines` 是物理删除 —— 这一行之后只剩日志里的整行快照。缺理由 → 400`REPORT_CONFIG_REASON_REQUIRED`' }
          }
        },
        PeriodClose: {
          type: 'object',
          properties: { remark: { type: 'string' } }
        },
        PeriodReopen: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', description: '反关账理由。**必填** —— 它会让已定稿的期间重新可变' } }
        },
        PeriodCarryForward: {
          type: 'object',
          properties: {
            remark: { type: 'string', description: '备注（可空）。会写进结转账的摘要，便于事后回答「这次结转是在什么背景下做的」' }
          }
        },
        PeriodReverseClosing: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', description: '撤销理由。**必填** —— 撤销会删掉这一期的结转账，账重新变成未结平' } }
        },
        AnnualCarryForward: {
          type: 'object',
          properties: {
            remark: { type: 'string', description: '备注（可空）。会写进年结凭证的摘要，便于事后回答「这次年结是在什么背景下做的」' }
          }
        },
        AnnualReverseClosing: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', description: '撤销理由。**必填** —— 撤销会删掉这一年的年结凭证，4103 恢复余额' } }
        },
        AnnualDistribute: {
          type: 'object',
          required: ['items'],
          properties: {
            period: { type: 'string', description: '分配凭证的记账期间（默认**次年 1 月**）。不得早于年末期间；分红决议通常在次年作出，账也做在次年' },
            remark: { type: 'string', description: '备注（可空）' },
            items: {
              type: 'array',
              description: '分配项。**金额必须由人给** —— 这是股东会的决议，没有任何东西能推导出它',
              items: {
                type: 'object',
                required: ['subject_code', 'amount'],
                properties: {
                  subject_code: { type: 'string', example: '4105', description: '目标科目：必须是**权益类**（4105 盈余公积 = 钱留在公司）或**负债类**（2232 应付股利 = 钱欠出去了）的叶子科目' },
                  amount: { type: 'number', example: 800, description: '分配金额，必须为正' },
                  label: { type: 'string', description: '分录摘要（可空）' }
                }
              }
            }
          }
        },
        AnnualReverseDistribution: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', description: '撤销理由。**必填** —— 撤销会删掉分配凭证，已宣告的分配消失' } }
        },
        OpeningSave: {
          type: 'object',
          required: ['period', 'rows'],
          properties: {
            period: { type: 'string', example: '2026-05' },
            remark: { type: 'string' },
            rows: {
              type: 'array',
              description: '整批覆盖。借方合计必须等于贷方合计，否则整批不落库',
              items: {
                type: 'object',
                required: ['subject_code'],
                properties: {
                  subject_code: { type: 'string' },
                  debit_amount: { type: 'number', description: '非负。方向用借/贷两列表达，不靠符号' },
                  credit_amount: { type: 'number', description: '非负。同一科目不能同时有借方与贷方期初余额' }
                }
              }
            }
          }
        },
        RebateSettle: {
          type: 'object',
          required: ['dealer_id', 'period'],
          properties: {
            dealer_id: { type: 'integer' },
            period: { type: 'string' },
            idempotency_key: { type: 'string', description: '重放保护：同键返回**首次那张核销单**，不重复冲减' },
            remark: { type: 'string' }
          }
        },
        PosQuote: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: { type: 'object', properties: { sku_id: { type: 'integer' }, qty: { type: 'number' } } } },
            member_phone: { type: 'string', description: '会员手机号（业务输入，非凭据）：命中则用会员价作基准价并带上会员等级折扣与积分' },
            coupon_codes: { type: 'array', items: { type: 'string' } },
            auto_coupon: { type: 'boolean', default: false },
            use_points: { type: 'integer', default: 0 },
            discount_amount: { type: 'number', description: '**手工让利**（店长现场决定，不参与促销预算），作为整单减项叠加在结算结果之后' }
          }
        },
        PromoSettle: {
          type: 'object',
          required: ['order_id', 'items'],
          properties: {
            source: { type: 'string', enum: ['oms', 'pos'], default: 'oms', description: '**来源通道**（迁移 030）：留痕/登记/券/积分都按「通道 + 单号」归属' },
            order_id: { type: 'integer', description: '订单 id；优惠留痕与使用登记的幂等键都按它生成' },
            items: { type: 'array', items: { type: 'object' } },
            customer_id: { type: 'integer' },
            coupon_codes: { type: 'array', items: { type: 'string' } },
            auto_coupon: { type: 'boolean', default: false },
            use_points: { type: 'integer', default: 0 },
            order_amount_for_points: { type: 'integer', description: '送分基数（分）。缺省用实付金额 —— 按原价送分会把促销预算变成积分预算' },
            at: { type: 'string' }
          }
        },
        PromoUnsettle: {
          type: 'object',
          required: ['order_id'],
          properties: {
            source: { type: 'string', enum: ['oms', 'pos'], default: 'oms', description: '**来源通道**（迁移 030）。`oms_orders.id` 与 `pos_orders.id` 独立自增会撞号，只按 order_id 撤单会撤到另一张同号的单上' },
            order_id: { type: 'integer' },
            reason: { type: 'string', default: '订单取消', description: '会拼进积分回收流水的说明里' },
            order_amount_cents: { type: 'integer', description: '该单结算时计入累计消费的金额（**分**）；不给就只回退留痕/券/积分，不回退累计消费' }
          }
        },
        MallQuote: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', description: '购物车行（服务端按 `price_member || price_retail` 取基准价，不接受前端传价）', items: { type: 'object', properties: { sku_id: { type: 'integer' }, qty: { type: 'number' } } } },
            coupon_codes: { type: 'array', description: '本单要用的券实例码；不传就是一张都不用', items: { type: 'string' } },
            auto_coupon: { type: 'boolean', default: false },
            use_points: { type: 'integer', default: 0, description: '想抵的积分数；上限由服务端按**优惠后金额**推导（见响应 `points_quote`）' }
          }
        },
        MallOrderCreate: {
          type: 'object',
          required: ['receiver', 'receiver_phone', 'address', 'items'],
          properties: {
            receiver: { type: 'string' },
            receiver_phone: { type: 'string' },
            address: { type: 'string' },
            remark: { type: 'string' },
            items: { type: 'array', items: { type: 'object', properties: { sku_id: { type: 'integer' }, qty: { type: 'number' } } } },
            coupon_codes: { type: 'array', items: { type: 'string' } },
            auto_coupon: { type: 'boolean', default: false },
            use_points: { type: 'integer', default: 0 }
          }
        },
        CouponCreate: {
          type: 'object',
          required: ['code', 'name'],
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            promotion_id: { type: 'integer', description: '**必须绑一张促销**：券只是"解锁凭证"，优惠额由促销引擎算；不绑的券领了也用不了' },
            type: { type: 'string', enum: ['fixed', 'percent'], default: 'fixed', description: '仅列表页展示用的冗余字段' },
            value: { type: 'integer', description: '仅展示用（分）' },
            min_subtotal: { type: 'integer', description: '使用门槛（**分**）；0 = 无门槛' },
            total_qty: { type: 'integer', description: '发行总量，null = 不限量' },
            per_user_limit: { type: 'integer', default: 1 },
            valid_from: { type: 'string', description: '绝对有效期起。与 valid_days 取**交集**：实际失效 = min(valid_to, 领取时刻 + valid_days)' },
            valid_to: { type: 'string' },
            valid_days: { type: 'integer', description: '相对有效期（领取后 N 天）' },
            remark: { type: 'string' }
          }
        },
        CouponIssue: {
          type: 'object',
          required: ['customer_id'],
          properties: {
            customer_id: { type: 'integer' },
            qty: { type: 'integer', default: 1, description: '发几张；受模板发行总量与每人限领双约束' },
            remark: { type: 'string' }
          }
        },
        ShopClaim: {
          type: 'object',
          required: ['coupon_id'],
          properties: {
            phone: { type: 'string', description: '**已废弃**：身份一律取 C 端会话（`x-mall-token`）。手机号是公开标识，不是凭据' },
            coupon_id: { type: 'integer' }
          }
        },
        MemberLevelUpdate: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            discount_pct: { type: 'integer', description: '等级折扣（万分比，10000=不打折）。必须在 1~10000 之间 —— 0 是全场 0 元，>10000 是倒贴' },
            points_rate: { type: 'integer', description: '积分倍率（100 = 1 倍）' },
            points_deduct_limit: { type: 'integer', description: '积分抵扣上限（占订单额万分比，5000 = 最多抵一半）' },
            min_points: { type: 'integer', description: '升级门槛：累计获得积分' },
            min_spent_yuan: { type: 'number', description: '升级门槛：累计消费（元）。与 min_points 是**与**关系' },
            benefits: { type: 'string' },
            sort_order: { type: 'integer' }
          }
        },
        MemberPointsAdjust: {
          type: 'object',
          required: ['change', 'remark'],
          properties: {
            change: { type: 'integer', description: '正加负减，不能为 0' },
            remark: { type: 'string', description: '**必填**：不留理由的积分变动在账上无法解释' }
          }
        },
        MemberBalanceChange: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['recharge', 'adjust'], default: 'adjust', description: 'recharge 走充值（记 doc_no，面向财务）；adjust 是人工纠错，必填理由' },
            amount_cents: { type: 'integer', description: 'kind=recharge 时的充值金额（分），必须 > 0' },
            change_cents: { type: 'integer', description: 'kind=adjust 时的变动额（分），正加负减，不能为 0' },
            doc_no: { type: 'string', description: 'kind=recharge 时的财务单据号' },
            remark: { type: 'string', description: 'kind=adjust 时必填' }
          }
        },
        MemberLevelSet: {
          type: 'object',
          required: ['level_code', 'remark'],
          properties: {
            level_code: { type: 'string', enum: ['normal', 'silver', 'gold', 'platinum'] },
            remark: { type: 'string', description: '**必填**：人工定级等于一次变相调价，必须留痕' }
          }
        },
        MemberCouponIssue: {
          type: 'object',
          properties: {
            coupon_id: { type: 'integer', description: '按模板发券时用它' },
            coupon_code: { type: 'string', description: '指定券补发时用它（客服补发场景）' },
            qty: { type: 'integer', default: 1 },
            remark: { type: 'string' }
          }
        }
      }
    },
    security: [{ bearerAuth: [] }]
  }
}

export default buildOpenApi
