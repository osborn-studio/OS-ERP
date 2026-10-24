/**
 * ============================================================================
 * 文件标识：server/mcp/catalog.js ｜ 「AI 能把系统控制到什么程度」的**唯一口径**
 * ============================================================================
 * 【这个文件回答什么问题】
 *   客户的要求是一句话：「明确展示这个系统**任何单据**都有 MCP，都可以被 AI 使用和控制，
 *   同时保证安全性。」
 *   要能这么讲，必须能拿出**可核对的数据**，而不是一张手写的宣传页。所以：
 *     · 单据清单、状态机、可选动作 —— 从内核的 `doc_types` / `doc_states` / `doc_actions` 三张表读；
 *     · 工具清单、读写级别 —— 从 `./tools.js` 的 `TOOLS` 注册表读；
 *     · 覆盖判定 —— 由上面两者**推导**（每个单据类型是否被通用单据工具覆盖）。
 *   **本文件不维护任何第二份名单**。手写一份"我们支持 40 种单据"的页面，
 *   第二天新增一张单据它就开始撒谎，而且不会报错。
 *
 * 【为什么"通用单据工具"是关键】
 *   专用工具（`purchase.create_order` 之类）覆盖的是**主链路**，永远追不上内核里 40 个单据类型。
 *   所以另配一组**由内核驱动的通用工具**（`doc.list_types` / `doc.query` / `doc.get` /
 *   `doc.transition`）：它们不认识具体业务，只认识内核定义。
 *   ⇒ 内核里登记了这张单据，AI 就**一定**能读它；只要这条边在内核里是合法的、且不是高危边，
 *     就**一定**能推进它。新增单据类型不需要改 MCP 代码。
 *
 * 【安全边界（这里是"能控制"与"乱控制"的分界，不要在别处再写一遍）】
 *   1. **高危边不给通用工具**：`doc_actions.is_danger=1` 的边，`doc.transition` 一律拒绝
 *      （`EDGE_REQUIRES_HUMAN`）。高危动作只能走**带人工确认**的专用工具 / 界面。
 *      理由：通用工具的调用方是 AI，"高危"的定义就是"需要人看一眼"，两者不能共存。
 *   2. **边权限照旧**：`assertEdgePermitted` 与 HTTP 入口、MCP 专用工具**同一份判据**。
 *   3. **实体范围照旧**：受限令牌只能看到 / 推进自己组织、门店、经销商、仓库范围内的事；
 *      表上取不到任何归属列时**按看不到处理**（fail-closed），不按"能看"处理。
 *   4. **行业绑定照旧**：令牌绑定行业，跨行业读不到。
 *   5. **类型级查看权限（X5）**：`doc.query` / `doc.get` / `doc.list_types` 按 `doc-perms.js` 的映射校验
 *      令牌所有者**此刻**是否有该类型的查看权限点；未登记的类型默认拒绝。
 *   6. **写操作要幂等键**：由 `server/mcp/server.js` 统一要求（不在本文件）。
 * ============================================================================
 */
import { TOOLS } from './tools.js'
import { viewPermsOf } from './doc-perms.js'

/**
 * 由内核驱动的通用单据工具。
 * ⚠️ 这张表是**声明**，真正实现必须与 `tools.js` 里注册的工具一一对应；
 *    `scripts/check-mcp-coverage.mjs` 会交叉核对（名字对不上就红），防止"说支持了、其实没实现"。
 */
export const GENERIC_DOC_TOOLS = [
  { name: 'doc.list_types', level: 'read', covers: '所有者有权查看的单据类型：状态机 + 可选动作 + 高危标注' },
  { name: 'doc.query', level: 'read', covers: '按类型 / 状态 / 关键词查单据（受类型级查看权限与实体范围约束）' },
  { name: 'doc.get', level: 'read', covers: '单据详情 + 流转留痕（受类型级查看权限与实体范围约束）' },
  { name: 'doc.transition', level: 'write', covers: '按内核推进单据（**高危边一律拒绝**，须人工确认）' }
]

/** 表名白名单：`doc_types.table_name` 来自库，但仍然校验 —— 它会被拼进 SQL */
const SAFE_TABLE = /^[a-z_][a-z0-9_]*$/

/**
 * 归属列推断：**从表的真实列推**，不维护第二份"这张表归谁"的名单。
 * 为什么：40 个单据类型、每个都可能加列；手写一份映射必然漏，漏了就是"越界可见"。
 * 推断不到任何归属列的受限令牌 ⇒ 看不到（fail-closed），与 `order.trace_document` 同一条口径。
 */
export function ownershipColumns(db, table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  const has = (c) => cols.includes(c)
  const out = { orgs: [], stores: [], dealers: [], warehouses: [] }
  if (has('org_id')) out.orgs.push('org_id')
  if (has('store_id')) out.stores.push('store_id')
  if (has('target_store_id')) out.stores.push('target_store_id')
  if (has('dealer_id')) out.dealers.push('dealer_id')
  if (has('warehouse_id')) out.warehouses.push('warehouse_id')
  if (has('from_warehouse_id')) out.warehouses.push('from_warehouse_id')
  if (has('to_warehouse_id')) out.warehouses.push('to_warehouse_id')
  if (has('material_warehouse_id')) out.warehouses.push('material_warehouse_id')
  return out
}

/**
 * 构建「AI 能力目录」。
 *
 * @param {object} db 当前行业的库（**已按行业切好**：这个函数不切库，调用方负责）
 * @returns 可直接给界面渲染的结构（不含任何 HTML）
 */
export function buildMcpCatalog(db) {
  const types = db
    .prepare(
      `SELECT code, name, module, table_name, doc_no_prefix, has_lines, status_field, doc_no_field
         FROM doc_types WHERE status='active' ORDER BY sort_order, code`
    )
    .all()
  const states = db
    .prepare('SELECT doc_type, code, name, kind, is_initial, is_final FROM doc_states ORDER BY doc_type, sort_order')
    .all()
  const actions = db
    .prepare(
      `SELECT doc_type, action, action_name, from_state, to_state, perm_code, require_approval, is_danger
         FROM doc_actions ORDER BY doc_type, sort_order`
    )
    .all()

  const stateOf = new Map()
  for (const s of states) {
    if (!stateOf.has(s.doc_type)) stateOf.set(s.doc_type, [])
    stateOf.get(s.doc_type).push({ code: s.code, name: s.name, kind: s.kind, initial: !!s.is_initial, final: !!s.is_final })
  }
  const actionOf = new Map()
  for (const a of actions) {
    if (!actionOf.has(a.doc_type)) actionOf.set(a.doc_type, [])
    actionOf.get(a.doc_type).push({
      action: a.action,
      name: a.action_name,
      from: a.from_state,
      to: a.to_state,
      perm: a.perm_code,
      need_approval: !!a.require_approval,
      danger: !!a.is_danger,
      // 通用工具**能不能**推进这一条边 —— 判定只有这一处
      via_generic_tool: !a.is_danger
    })
  }

  const docTypes = types.map((t) => {
    let count = null
    // 计数是"这张单据到底有没有在用"，不是装饰：全 0 的类型说明该行业没启用它
    if (SAFE_TABLE.test(t.table_name)) {
      try {
        count = db.prepare(`SELECT COUNT(*) c FROM ${t.table_name}`).get().c
      } catch {
        count = null // 表还没建（迁移没跑到）——留 null，前端显示"未建表"而不是 0
      }
    }
    const acts = actionOf.get(t.code) || []
    // 归属列：**没有归属列的单据，受限令牌会 fail-closed 判成"看不到"**。
    // 这是既有的 7 个类型（AR / CA / OCS / OM / RCP / RFD / VOUCHER —— 它们的"归谁"
    // 记在 customer_type/customer_id 或根本没有主体维度）。这件事**必须在页面上看得见**：
    // 否则某天客户问"AI 说没有这张收款单"，没人答得上来是范围问题还是数据问题。
    let ownerCols = 0
    if (SAFE_TABLE.test(t.table_name)) {
      try {
        const oc = ownershipColumns(db, t.table_name)
        ownerCols = oc.orgs.length + oc.stores.length + oc.dealers.length + oc.warehouses.length
      } catch {
        ownerCols = 0
      }
    }
    return {
      code: t.code,
      name: t.name,
      module: t.module,
      table: t.table_name,
      has_lines: !!t.has_lines,
      rows: count,
      owner_cols: ownerCols,
      /** X5：读这张单据所需的权限点（任一命中即可）；null = 未登记，通用读工具默认拒绝 */
      view_perms: viewPermsOf(t.code),
      /** true = 受限令牌（按组织/门店/经销商/仓库约束）看不到这张单据 */
      restricted_invisible: ownerCols === 0,
      states: stateOf.get(t.code) || [],
      actions: acts,
      // 「AI 能不能用」的三态，全部由数据推导，不手写
      ai: {
        read: viewPermsOf(t.code) !== null, // 由 doc.query / doc.get 覆盖；未登记查看权限点则默认拒绝（X5）
        write: acts.some((a) => !a.danger), // 至少有一条安全边 ⇒ 可写
        // 高危边存在 ⇒ 必须在界面上人工确认才能推进
        needs_human_for_danger: acts.some((a) => a.danger)
      }
    }
  })

  const byLevel = (lv) => TOOLS.filter((t) => t.level === lv).length
  const totalActions = actions.length
  const dangerActions = actions.filter((a) => a.is_danger).length

  return {
    // ---- 单据矩阵（页面主体）----
    doc_types: docTypes,
    summary: {
      doc_types: docTypes.length,
      doc_types_with_data: docTypes.filter((d) => (d.rows || 0) > 0).length,
      states: states.length,
      actions: totalActions,
      actions_danger: dangerActions,
      // 通用工具能推进的安全边数量 —— 这是"AI 能控制多少步"的实打实分母
      actions_via_generic: totalActions - dangerActions,
      // 受限令牌看不到的单据类型数（口径见每个 doc_type 的 restricted_invisible）
      doc_types_restricted_invisible: docTypes.filter((d) => d.restricted_invisible).length,
      tools: TOOLS.length,
      tools_read: byLevel('read'),
      tools_write: byLevel('write'),
      tools_danger: byLevel('danger')
    },
    // ---- 工具清单（按级别分组，供界面勾选白名单时对照）----
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, level: t.level, description: t.description })),
    generic_tools: GENERIC_DOC_TOOLS.map((g) => {
      const found = TOOLS.find((t) => t.name === g.name)
      return { ...g, implemented: !!found, level: found?.level || g.level }
    }),
    // ---- 安全边界（**文字也要从代码里来**，避免页面和实现两套说法）----
    safety: [
      {
        key: 'token',
        title: '凭据：Agent Token（gml_ 前缀）',
        detail: '每个 AI 客户端一份令牌，可吊销、可设有效期、可限调用频率；令牌绑定行业，跨行业读不到。'
      },
      {
        key: 'scope',
        title: '数据范围：组织 / 门店 / 经销商 / 仓库',
        detail: '受限令牌只能看到并推进自己范围内的事；单据表上取不到归属列时按**看不到**处理（fail-closed）。'
      },
      {
        key: 'edge',
        title: '动作权限：与界面同一份判据',
        detail:
          '每一次流转都校验该条边的权限点（`assertEdgePermitted`），与 HTTP 入口、MCP 专用工具共用同一份定义 —— 不存在"界面拦得住、AI 拦不住"。'
      },
      {
        key: 'danger',
        title: `高危动作：${dangerActions} 条边不给 AI 直接执行`,
        detail:
          '`is_danger` 的边（作废已过账凭证、强平账等）通用工具**一律拒绝**（`EDGE_REQUIRES_HUMAN`）；专用高危工具必须先申请确认令牌，由**登录用户**在界面点确认后才执行。'
      },
      {
        key: 'idempotency',
        title: '写操作：幂等键 + 指纹',
        detail: '同一幂等键重放返回同一结果；同键不同参数直接 409，避免"AI 重试把货入两遍"。'
      },
      {
        key: 'audit',
        title: '审计：每次调用都留痕',
        detail: '工具名、参数、身份、结果、耗时全部落库（`GET /api/mcp/logs`），可回答"这句话是谁让 AI 做的"。'
      }
    ]
  }
}
