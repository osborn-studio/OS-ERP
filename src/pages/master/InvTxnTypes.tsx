/**
 * ============================================================================
 * 文件标识：src/pages/master/InvTxnTypes.tsx ｜ 出入库单据类型
 * ============================================================================
 * 【职责】出入库单据类型（页面）
 * 【入口】/master/inv-txn-types
 * 【主要接口】/master/inv-txn-types
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自本页自己的标题**、
 *   入口取自 `src/App.tsx` 的路由表、接口取自本页实际调用的接口（**都不是新编的**）。
 *   人工完善时补：这页回答用户的什么问题 / 为什么这样组织 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处；下拉选项从 `/api/meta/*` 取，不要在页面里写死；
 *   改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */
/**
 * 页面：出入库单据类型
 */

import DataPage, { FieldDef } from '../../components/DataPage'
import { Status } from '../../components/ui'

/**
 * 出入库单据类型 —— 客户可维护的主数据（客户原话：「出入库单据类型也是客户新建的」）。
 *
 * 这一页回答三个问题，正是客户提的三件事：
 *   ① **有哪些类型** —— 列表就是权威名单（`inv_txn_types`）。
 *   ② **哪种出库要把货当可售货消耗** —— 「受可售性闸门约束」开关。
 *      它原先写死在 `lib/stock.js`，改成一列之后客户自己说了算；打开它 = 这种出库
 *      指定批次时会被"冻结 / 报废 / 过保 / 检验不合格"拦住，关掉 = 不拦（例如报废出库）。
 *   ③ **这种出库算到哪个科目** —— 「财务核算科目」（`ledger_subject_code`）：**只读展示**。
 *      **`[未接线 · 依赖"出库类型 → 凭证模板"映射落地]`**
 *
 * ⚠️ ③ 这一格的处理口径（team-lead **最终裁定**，2026-10-16，方案 A）：
 *   **界面只读 + hint 明示** + **接口拒写**（`INV_TYPE_LEDGER_RESERVED`）。
 *   它**没有接进凭证生成**（原因见 `047` 与 `routes/inv-txn-types.js` 的头注释：现有凭证由
 *   **来源单据**驱动，再接一条"库存异动 → 凭证"的触发链会让同一笔业务**记两遍账**，
 *   而**重复记账比漏记更危险** —— 两套报表会各自自洽地错，谁也发现不了）。
 *   ⇒ 为什么最终选 A 而不是"保留可填 + 明示"（B）：**A 严格包含 B 的全部优点**
 *   （hint 里的明示没丢），并且**多消掉一条"写了没效果"的写路径** —— 与铁律 17
 *   （"无意义的动作须由闸门明确拒绝 + 一句人话"）一致；同时它还少一份死代码
 *   （值域校验与科目下拉请求都随字段一起撤销）。
 *   客户拍定的粒度是「一种出库类型 → **一套凭证模板**」（第 0 层 §7.2）；
 *   等那个映射落地时，这一格会换成一个**选模板**的下拉（届时"科目候选"那次请求也一起回来）。
 *
 * 两个"改不动"的字段（`readOnlyOnEdit`）：**编码**与**方向**。
 * 它们都是"历史流水已经按它记过账"的东西 —— 后端也拒（`409`），这里只读是让用户不用先撞墙。
 */
export default function InvTxnTypes() {
  const fields: FieldDef[] = [
    // 编码是**历史引用的键**（库存流水按 `doc_type` 引用它）：建的时候必填，改的时候只读。
    { key: 'code', label: '类型编码', width: 120, required: true, readOnlyOnEdit: true, hint: '大写字母/数字/下划线，如 REPAIR_OUT；建成后不可修改' },
    { key: 'name', label: '类型名称', width: 170, required: true, hint: '界面与台账上显示的名字；改名不影响历史流水' },
    {
      key: 'direction',
      label: '方向',
      width: 80,
      type: 'select',
      required: true,
      readOnlyOnEdit: true,
      options: [
        { value: 'in', label: '入库' },
        { value: 'out', label: '出库' }
      ],
      hint: '建成后不可修改（历史流水的方向是既成事实）',
      render: (r) => (r.direction === 'in' ? '入库' : r.direction === 'out' ? '出库' : r.direction)
    },
    {
      key: 'saleable_only',
      label: '受可售性闸门约束',
      width: 140,
      align: 'center',
      type: 'switch',
      default: 0,
      hint: '打开：这种出库指定批次时，冻结 / 报废 / 过保 / 检验不合格的货会被拦住（"把货当可售货消耗"）。'
        + '关闭：不拦（报废、退料、调拨、盘亏这类本来就要把不可用的货弄出去）。'
    },
    {
      key: 'ledger_subject_code',
      label: '财务核算科目',
      width: 150,
      // **只读**：这一列是**预留位**，接口也拒写（`INV_TYPE_LEDGER_RESERVED`）——
      // 界面上只读 = 让用户"不用先撞墙才知道"，而不是"能填却没有任何反应"。
      // 只读 + hint **成对**：客户看到的是"这里有个预留位、现在不可写、将来会指向模板"。
      readOnly: true,
      // ⚠️ hint 说清**现状 + 原因 + 将来**（team-lead 最终裁定取 A 方案：它的全部优点都包含
      //    "保留 + 明示"这一版，并且多消掉一条"写了没效果"的写路径）：
      hint: '预留位（不可写）：尚未接进凭证生成，因此填了不会产生任何效果；它将在「出库类型 → 凭证模板」映射落地时改为指向模板。⚠️ 接入前必须先定"谁负责记账"，否则同一笔业务会被来源单据与库存异动各记一遍账（重复记账比漏记更难发现）'
    },
    {
      key: 'status',
      label: '状态',
      width: 80,
      type: 'select',
      options: [
        { value: 'active', label: '启用' },
        { value: 'inactive', label: '停用' }
      ],
      default: 'active',
      hint: '停用后：新单据不能再写这种类型（出/入库会被硬拦）；历史流水与报表不受影响',
      render: (r) => <Status value={r.status} />
    }
  ]

  return (
    <div>
      <DataPage
        title="出入库单据类型"
        desc="客户可自行新增类型；「受可售性闸门约束」决定这种出库要不要按可售货校验，类型不可删除（历史流水引用它），只能停用"
        path="/master/inv-txn-types"
        fields={fields}
        allowDelete={false}
        excelName="出入库单据类型"
        filters={[
          {
            key: 'direction',
            type: 'select',
            label: '全部方向',
            w: 110,
            options: [
              { value: 'in', label: '入库' },
              { value: 'out', label: '出库' }
            ]
          },
          {
            key: 'status',
            type: 'select',
            label: '全部状态',
            w: 110,
            options: [
              { value: 'active', label: '启用' },
              { value: 'inactive', label: '停用' }
            ]
          }
        ]}
      />
    </div>
  )
}
