# GML 模块 06 · 编码规则与单据编号 详细设计 v1

> 文档性质：详细设计（**已落地实现并实测通过**）
> 口径来源：第一轮「编码后台可配置」横切口径、框架文档 P0「编码规则」项
> 前置依赖：模块 04 单据内核（规则按单据类型注册）
> 关联文档：《GML 系统总体框架与模块地图 v1》《GML 模块 04 单据内核 详细设计 v1》
> 实现位置：`server/lib/docno.js`、`server/db/migrations/009_docno_rules.cjs`
> 测试证据：`scripts/test-docflow.mjs` 的编码规则段（9 项断言）

---

## 一、为什么要做这个模块

框架文档把「编码规则」列为 L2 共享能力中心之一，现状标注 🟡 —— 因为单号**能生成**，但方式不对。

改造前 `server/lib/docno.js` 的做法：

```js
// 前缀 + 日期 + 「查库中最后一条 + 探测占位」反推序号
const key = `${prefix}${d.format('YYYYMMDD')}`
const row = db.prepare(`SELECT doc_no FROM t WHERE doc_no LIKE ? ORDER BY length(doc_no) DESC, doc_no DESC LIMIT 1`).get(`${key}%`)
let seq = parseInt(String(row.no).slice(key.length), 10) + 1
```

四个问题：

| # | 问题 | 后果 |
|---|---|---|
| 1 | **规则写死在代码里** | 换个编号格式要改代码、发版；前台门店想自己调格式不可能 |
| 2 | **序号不分场景** | 同一前缀在总部、区域、门店**共用一个序列**，无法按组织分段编号 |
| 3 | **取号非原子** | 「查最后一条 + 探测」之间存在竞态窗口。当前是单写者 + WAL 所以没炸，但**做法本身不可靠** |
| 4 | **无法按组织/仓库分段** | 集团型企业常见需求：「华东与华南各自从 0001 起编」，做不到 |

第 3 条是本模块**真正的技术债**：它在演示负载下不会暴露，属于「现在没事、量一上来就出事」的典型。

---

## 二、核心设计：规则与计数器分离

```
doc_no_rules     规则表：什么单据、什么作用域，用什么模式编号
      ↓
doc_no_counters  计数器表：每条规则 × 每个周期，当前序号到几了
      ↓
   单号字符串
```

### 2.1 `doc_no_rules` 规则表

| 列 | 含义 |
|---|---|
| `doc_type` | 单据类型（关联 `doc_types`） |
| `scope_type` | 作用域类型：`global` / `org` / `warehouse` / `store` |
| `scope_value` | 作用域取值（对应 id；global 为空串） |
| `pattern` | **编号模式**，如 `{PREFIX}{YYYYMMDD}{SEQ:4}` |
| `period` | 序号归零周期：`none` / `day` / `month` / `year` |
| `seq_pad` · `seq_start` | 序号位数与起始值 |

唯一键 `UNIQUE(doc_type, scope_type, scope_value)` —— 保证一个单据在同一作用域下只有一条有效规则。

### 2.2 `doc_no_counters` 计数器表

```
PRIMARY KEY (rule_id, period_key)
period_key 按 period 生成：none→''  /  year→'2026'  /  month→'202610'  /  day→'20261015'
```

**取号在同一个事务内 UPSERT 自增**：

```js
const allocate = db.transaction(() => {
  const cur = db.prepare('SELECT current_value FROM doc_no_counters WHERE rule_id=? AND period_key=?').get(rule.id, pkey)
  let seq = cur ? cur.current_value : rule.seq_start - 1
  do { seq += 1; no = render(seq) } while (existsStmt.get(no) && guard++ < 9999)
  db.prepare(`INSERT INTO doc_no_counters … ON CONFLICT(rule_id,period_key) DO UPDATE SET current_value=excluded.current_value`).run(rule.id, pkey, seq)
  return no
})
```

这就是把问题 3 从根上解决：**序号来源从「反推历史」变成「读计数器 +1」**，不再依赖扫表推断，竞态窗口消失。

代码里仍保留了「逐号探测直到不与库里既有单号冲突」的兜底循环（`guard < 9999`）。原因是**演示库里的单号是 seed 按自增序号拼的、与日期脱钩**，规则取号的第一发就可能撞上历史数据。兜底循环只会在撞号时多走几步，正常路径零开销。

---

## 三、编号模式语法

### 3.1 通配符清单

| 通配符 | 含义 | 示例输出 |
|---|---|---|
| `{PREFIX}` | 单据类型注册的单号前缀 | `PO` |
| `{TYPE}` | 单据类型码 | `PO` |
| `{YYYY}` `{YY}` | 年 / 两位年 | `2026` / `26` |
| `{MM}` `{DD}` | 月 / 日 | `10` / `15` |
| `{HH}` `{mm}` `{SS}` | 时 / 分 / 秒 | `14` / `30` / `05` |
| `{SEQ:n}` | 序号，n 位补零 | `0001` |
| `{RAND:n}` | 随机数，n 位 | `483` |
| `{ORG}` `{WH}` `{STORE}` | 组织 / 仓库 / 门店 id，4 位补零 | `0003` |

默认规则：`{PREFIX}{YYYYMMDD}{SEQ:4}` → 例如 `PO202610150007`。

### 3.2 复合日期段：一个被测试逼出来的真 bug

**这是本模块最值得记录的一处实现细节。**

模式的直觉写法是 `{YYYYMMDD}`（一个 token 里塞三个原子段），而不是 `{YYYY}{MM}{DD}`。默认规则就是前者。

最初的解析器是这么写的：把 `{...}` 内的内容当作**一个整体 key** 去 `ctx` 里查。结果：

```
期望：PO202610150001
实际：PO{YYYYMMDD}0001      ← token 原样输出到单号里！
```

**9 条编码规则断言同时失败**，实际值里带着字面量 `{YYYYMMDD}`。这是必须立刻修的严重缺陷——它会让所有新生成的单号都带花括号。

修复方式是把 key **按原子段贪心切分**：

```js
const ATOMS = ['YYYY','YY','MM','DD','HH','mm','SS','PREFIX','TYPE','ORG','WH','STORE']
const sorted = [...ATOMS].sort((a, b) => b.length - a.length)   // 长段优先，避免 YY 抢先匹配 YYYY

function resolveToken(key, ctx, seq, seqPad) {
  if (key.startsWith('SEQ')) return pad(seq, seqPad)      // 带参数的先处理
  if (key.startsWith('RAND')) { … }
  let i = 0, out = ''
  while (i < key.length) {
    const hit = sorted.find((a) => key.startsWith(a, i))
    if (!hit) return null                                  // 未知 token 原样保留，让配置错误显性可见
    out += ctx[hit] ?? ''
    i += hit.length
  }
  return out
}
```

两个设计要点：

1. **原子段按长度降序排**。若 `YY` 排在 `YYYY` 前面，`{YYYYMMDD}` 会被切成 `YY`+`YY`+`MM`+`DD` → 输出 `26261015`，**错得无声无息**。排序是必须的，不是优化。
2. **未知 token 返回 `null`，调用方原样保留花括号**。这样配置写错时单号里会显式出现 `{FOO}`，**错误可见**，而不是静默替换成空串——静默吞掉会让「单号少了一段」这种问题极难排查。

修好之后，`{YYYYMMDD}`、`{YYYY}{MM}{DD}`、`{YYMM}` 三种写法**全部可用且等价**。

### 3.3 作用域优先级

`findRule()` 按精确度取最合适的规则：

```
warehouse  →  store  →  org  →  global
（最精确）                        （兜底）
```

含义是「**就近覆盖**」：集团配一条 global 规则，华东仓配一条 warehouse 规则，则华东仓的单号用后者的模式，其它仓用 global。未配置任何规则时返回 `null`，调用方回落到旧逻辑。

---

## 四、兼容策略：为什么 80 处调用点零改动

这是本模块**最重要的工程决策**。

`nextDocNo(db, prefix, table, field, dateStr)` 在项目里被调用 **80 处**。如果直接改签名或行为，风险是爆炸性的。

因此采用**双轨并行**：

```
nextDocNo()       ← 旧签名与行为 100% 保留，80 处调用点不动
nextDocNoByRule() ← 新：走规则表，未配置规则返回 null
nextDocNoAuto()   ← 新：有规则走规则，无规则自动回落旧逻辑（调用方无需关心）
```

**渐进迁移路径**：路由可以先什么都不改（继续用 `nextDocNo`），也可以在准备好时切到 `nextDocNoAuto` 一行搞定。**没有「必须一次性全改」的强制点。**

这条策略的代价是代码里同时存在两套取号逻辑；收益是不会因为一次重构引爆 80 个调用点。在演示系统的场景下，这个取舍是明确的。

---

## 五、批次号：另一类编码

单据编号之外，还有一个东西也是「编码」——**批次号**。

```js
export function nextBatchNo(skuCode, dateStr) {
  const rand = Math.floor(Math.random() * 900 + 100)
  return `${skuCode.slice(-6).toUpperCase()}${d.format('YYMM')}${rand}`   // 例：SKU0082610483
}
```

`SKU末6位 + YYMM + 3位随机`。设计意图是**让批次号里带上效期月份**，配合库存引擎的 FEFO（先到期先出）拣选——仓管员扫一眼批次号就能看出大致效期，不必回查系统。

这是与单据编号不同的设计取向：**单据号要可读、可排序、可追溯；批次号要可拣选**。因此批次号不带序号（序号会让人误以为有先后意义），而带随机数（避免同 SKU 同月重复）。

---

## 六、不变量与自检自愈

`009_docno_rules.cjs` 的 `verify()` 校验两条：

| # | 不变量 | 作用 |
|---|---|---|
| 一 | **凡登记了单号前缀的单据类型，都必须有全局取号规则** | 新增单据类型后（改模块 04 的 `DOC_TYPES`），重跑迁移会自动补出规则，不会出现「类型注册了但取不到号」的半成品状态 |
| 二 | **定义指纹一致** | 默认 `pattern` / `period` / `seq_pad` / `seq_start` 改了要能被发现并同步 |

第 2 条是后来补的。原先 `009` 只有第 1 条不变量——但**默认编号模式也是一种「定义」**：把它从 `{PREFIX}{YYYYMMDD}{SEQ:4}` 改成别的，第 1 条不变量照样满足，库里却不会更新。这与模块 04 第 6.1 节的教训是同一类问题，因此一并接入指纹机制（`stampDef` / `defStale`）。

**重跑用 `ON CONFLICT DO NOTHING`**，这是有意的：库里可能已经存在按组织/仓库分段的自定义规则，以及演示时现场调过的参数。重跑**只补缺、不覆盖**。

---

## 七、接口

| 接口 | 说明 |
|---|---|
| `GET /api/docflow/no-rules` | 规则清单，带 `counter_rows`（计数器行数）便于判断哪些规则真在用 |
| `POST /api/docflow/no-preview` | **预览**：不消耗序号，实时看模式效果（界面配置规则时的必备） |
| `POST /api/docflow/no-issue` | 按规则正式取号 |

`listDocNoRules()` 里带了一个 `counter_rows` 子查询——一行 SQL，但很实用：**规则配了一堆，哪些真的在用**，看计数器有没有行就知道。

预览接口 `previewDocNo()` 对随机段做特殊处理（输出 `xxx` 而非随机数），因为预览的意义是看**格式**，随机值每次不同会干扰判断。

---

## 八、实测结果

| 项 | 结果 |
|---|---|
| 默认规则数 | **20 条/库**（22 种单据类型中，`PSF` 收银交班单与 `RC` 门店日结单无单号前缀，故不生成） |
| 默认模式 | `{PREFIX}{YYYYMMDD}{SEQ:4}`，与旧的 `nextDocNo` 格式**完全兼容**，新旧混用不冲突 |
| 复合日期段 | `{YYYYMMDD}` / `{YYYY}{MM}{DD}` / `{YYMM}` 三种写法全部通过断言 |
| 定义指纹自愈 | 三库 `heal 009_docno_rules`，二次运行稳定 |
| 断言数 | 编码规则段 9 项，全通过 |

---

## 九、待确认（不阻塞）

1. **是否真的需要按组织分段编号** —— 能力已具备（`scope_type` 支持 org/warehouse/store + 优先级查找），但**当前没有任何一条非 global 规则**。若实际不需要，这块能力就是「备而不用」，不占成本。若需要，需求方要给出分段口径（华东从 0001 起？还是按仓？）。
2. **序号归零周期** —— 当前全部是 `day`（每天归零）。集团型企业常见 `month` 或 `none`（终身不归零）。待确认实际口径。
3. **单号是否要防猜测** —— 当前单号是「前缀+日期+顺序号」，完全可预测。这在内部系统没问题，但若经销商门户/门店自助端要用单号做对外标识，可能需要引入 `{RAND:n}` 或哈希段。**这是安全视角的待确认项**。
4. **历史单号是否要重编** —— 演示库里 1054 张单据的单号是历史 seed 生成的，与新规则格式不完全一致。当前策略是**不重编**（`nextDocNoByRule` 的撞号探测循环正是为此保留）。若演示要求「单号整齐划一」，需要一次性的数据重编脚本，**但重编会破坏已有单号的对外引用**，需谨慎。

---

## 十、下一步

- **编码规则配置界面**：`no-rules` / `no-preview` 接口已有，前端页面未做
- **模块 07 采购域**：请购单、到货单、采购发票的编号规则按需配置
- **餐饮版专属 seed**：餐饮库需按 20 店 + 央厨 + 3 品牌重做，届时可验证「按门店分段编号」的实际效果
