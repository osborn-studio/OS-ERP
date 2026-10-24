#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/gen-role-matrix.mjs ｜ 从权限字典与门禁代码生成 docs/operations/role-matrix.md（AD2，ADR-0051 补充）
 * ============================================================================
 * 【做什么】在一个全新的临时数据目录里跑迁移（权限字典 / 内置角色 / 单据类型都由迁移写入），然后对每个内置角色
 *   × 每种单据类型，**调用真实的门禁函数**得出可见性，写成 Markdown：
 *     ① 单据流转（HTTP `/api/docflow/*`）：`docScopeOf`（lib/docflow.js）+ `resolveOrgScope`（middleware/auth.js）+
 *        `hq-roles.js` 的总部豁免，对"数据范围取角色默认、未绑门店 / 经销商、已放在某个组织里"的账号求值。
 *        G 全局｜O 组织范围（子树 / 本组织）｜B 仅绑定（未绑定看不到，绑了只看自己的门店 / 经销商）｜- 不可见。
 *        外部主体（dealer / store）整个 docflow 读接口 403（`requireInternal`），记 `-`。
 *     ② MCP 通用单据读工具（`doc.*`）：`permContext` + `hasPerm` + `holdsBinding`（mcp/doc-perms.js）对"有此角色的无绑定账号"求值，
 *        并与 `canViewDocType` 的结论互相对拍（不一致即生成失败）。
 *        Y 可读｜Y* 可读但所有者必须有门店 / 经销商 / 订货主体绑定（admin / 超管豁免）｜- 无权限点或外部主体被内部类型挡掉。
 *   不手写任何角色 × 类型的结论：改了权限字典、`DOC_VIEW_PERMS`、`DOC_SCOPE_RESOLVERS` 或 `hq-roles.js`，输出就变，`--check` 就红。
 *   有任一在用单据类型缺 `DOC_VIEW_PERMS` / `DOC_SCOPE_RESOLVERS` 登记也直接失败（不会悄悄画成 `-`）。
 * 【诚实边界】矩阵描述的是"该角色的默认账号"；单个账号的 `data_scope` 覆盖、多角色叠加、自定义角色不在内。
 *   Markdown 只含静态结论（无时间戳 / 路径 / 随机），两次运行逐字节一致。
 * 【用法】node scripts/gen-role-matrix.mjs            写入 docs/operations/role-matrix.md
 *         node scripts/gen-role-matrix.mjs --check    与仓库文件比对，漂移（含文件缺失 / 被手改）退出 1（CI）
 *         node scripts/gen-role-matrix.mjs --json     把求值结果以 JSON 打到 stdout（测试按格取样用）
 *         --file=<绝对路径>                            把输出 / 比对目标换成另一个文件（只给测试造漂移用）
 *   临时库用 `os.tmpdir()` 下的新目录，`GML_DATA_DIR` 由本脚本自己设置；不读写仓库 `data/`。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
if (args.has('--check') && args.has('--json')) {
  console.error('--check 与 --json 不能同时使用（--json 会在比对之前退出，等于关掉漂移检查）')
  process.exit(2)
}
let OUT = path.join(ROOT, 'docs/operations/role-matrix.md')
for (const a of args) {
  if (a.startsWith('--file=') && path.isAbsolute(a.slice(7))) OUT = a.slice(7) // 测试用：对另一个文件做 --check / 写入
  else if (!['--check', '--json'].includes(a)) {
    console.error(`未知参数 ${a}。用法：node scripts/gen-role-matrix.mjs [--check|--json] [--file=<绝对路径>]`)
    process.exit(2)
  }
}

/** 求值：返回 { roles, types, docflow, mcp, hq }（不含任何时间 / 路径）。 */
async function evaluate() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-erp-role-matrix-'))
  process.env.GML_DATA_DIR = tmp
  process.env.GML_RUNTIME_MODE = 'test'
  delete process.env.GML_DB // 继承来的 GML_DB 优先于 GML_DATA_DIR，会把迁移与夹具写进别人的库
  try {
    const dbm = await import('../server/db/index.js')
    const dbFile = path.resolve(dbm.dbPathFor('cosmetic'))
    if (path.relative(tmp, dbFile).startsWith('..') || path.isAbsolute(path.relative(tmp, dbFile))) throw new Error(`库路径 ${dbFile} 不在临时目录内，拒绝写入`)
    const db = dbm.initSchemaFor('cosmetic')
    const { resolveOrgScope, permContext, hasPerm } = await import('../server/middleware/auth.js')
    const { readSetting } = await import('../server/lib/settings.js')
    await import('../server/lib/purchase.js')
    await import('../server/lib/sales-order.js')
    await import('../server/lib/order-center.js')
    const { docScopeOf, DOC_SCOPE_RESOLVERS } = await import('../server/lib/docflow.js')
    const { DOC_VIEW_PERMS, canViewDocType, holdsBinding, viewPermsOf, HQ_ONLY_MODULES } = await import('../server/mcp/doc-perms.js')
    const { HQ_ROLES, POS_HQ_ROLES, REQUISITION_HQ_ROLES } = await import('../server/lib/hq-roles.js')

    const roles = db.prepare('SELECT code, name, data_scope FROM roles ORDER BY rowid').all()
    const types = db.prepare("SELECT code, name, module FROM doc_types WHERE status='active' ORDER BY sort_order, code").all()
    const problems = []
    for (const t of types) {
      if (!viewPermsOf(t.code)) problems.push(`${t.code} 在 DOC_VIEW_PERMS 里没有查看权限点`)
      if (!DOC_SCOPE_RESOLVERS[t.code]) problems.push(`${t.code} 在 DOC_SCOPE_RESOLVERS 里没有登记`)
    }
    const permCount = Object.fromEntries(
      db.prepare('SELECT role_code, COUNT(*) c FROM role_permissions GROUP BY role_code').all().map((r) => [r.role_code, r.c])
    )
    const totalPerms = db.prepare('SELECT COUNT(*) c FROM permissions').get().c

    // 一个放在组织 1 里的账号（默认范围取角色）；组织 1 只用于让子树 / 本组织范围成立
    db.prepare("INSERT INTO orgs (id, code, name, type, level, path) VALUES (1, 'MATRIX', 'matrix', 'store', 1, '/1/')").run()
    const insUser = db.prepare("INSERT INTO users (username, password_hash, name, role, org_id) VALUES (?, 'x', ?, ?, 1)")
    // 与 routes/docflow.js 的 scopeCtx 同一判据：strictBinding / hqExempt 都取设置键 docflow_strict_store_binding（默认开）
    const strict = readSetting(db, 'docflow_strict_store_binding') === true
    const docflow = {}
    const mcp = {}
    for (const role of roles) {
      const uid = Number(insUser.run(`matrix_${role.code}`, role.code, role.code).lastInsertRowid)
      db.prepare('INSERT INTO user_roles (user_id, role_code) VALUES (?, ?)').run(uid, role.code) // 与 account-security.js 建号同形
      const user = { uid, role: role.code, org_id: 1, store_id: null, dealer_id: null, is_super: 0 }
      const bound = { ...user, store_id: 1, dealer_id: 1 }
      const orgScope = resolveOrgScope(db, user)
      const external = role.code === 'dealer' || role.code === 'store'
      const owner = permContext(db, { uid })
      docflow[role.code] = {}
      mcp[role.code] = {}
      for (const t of types) {
        // ① docflow：与 routes/docflow.js 的 scopeCtx 同参（strictBinding + hqExempt，取设置键）；外部主体被 requireInternal 整体 403
        let cell = '-'
        if (!external) {
          const mk = (u) => docScopeOf({ db, user: u, orgScope, strictBinding: strict, hqExempt: strict }, t.code)
          const p = mk(user)
          if (p && p.all) cell = 'G'
          else if (p) cell = 'O'
          else cell = mk(bound) ? 'B' : '-'
        }
        docflow[role.code][t.code] = cell
        // ② MCP doc.*：权限点（permContext/hasPerm）+ 外部主体闸 + 绑定（holdsBinding）；再与 canViewDocType 对拍
        const type = { code: t.code, module: t.module, name: t.name }
        const perms = viewPermsOf(t.code) || []
        const blocked = external && HQ_ONLY_MODULES.has(t.module)
        let m = '-'
        if (!blocked && perms.some((pc) => hasPerm(owner, pc))) m = holdsBinding(db, { ownerUserId: uid }, type, owner) ? 'Y' : 'Y*'
        if (canViewDocType(db, { ownerUserId: uid }, type) !== (m === 'Y')) problems.push(`${role.code}×${t.code}：矩阵 ${m} 与 canViewDocType 不一致`)
        mcp[role.code][t.code] = m
      }
    }
    const meta = types.map((t) => ({
      code: t.code,
      name: t.name,
      module: t.module,
      perms: viewPermsOf(t.code) || [],
      binding: DOC_VIEW_PERMS[t.code]?.binding || null,
      resolverBinding: DOC_SCOPE_RESOLVERS[t.code]?.binding || null,
      builder: DOC_SCOPE_RESOLVERS[t.code]?.builder || null,
      // 范围谓词的来源（O 格只说"受限"，具体收窄到哪些行由这几项决定；任一变动都会让本文件漂移）
      shape: (({ table, cols, via, kind }) => [table, cols && cols.join('+'), via && `via=${via}`, kind && `kind=${kind}`].filter(Boolean).join(' · '))(DOC_SCOPE_RESOLVERS[t.code] || {})
    }))
    db.close()
    return {
      problems,
      totalPerms,
      roles: roles.map((r) => ({ code: r.code, name: r.name, dataScope: r.data_scope, perms: permCount[r.code] || 0 })),
      types: meta,
      docflow,
      mcp,
      hq: { union: [...HQ_ROLES], pos: [...POS_HQ_ROLES], requisition: [...REQUISITION_HQ_ROLES] }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const BINDING_TEXT = { store: '门店', dealer: '经销商', subject: '订货主体', hq: '总部专属' }

function render(model) {
  const { roles, types, docflow, mcp, hq } = model
  const head = `| 单据 | ${roles.map((r) => `\`${r.code}\``).join(' | ')} |`
  const sep = `|---|${roles.map(() => ':-:').join('|')}|`
  const grid = (g) => types.map((t) => `| \`${t.code}\` ${t.name} | ${roles.map((r) => g[r.code][t.code]).join(' | ')} |`).join('\n')
  const flag = (list, c) => (list.includes(c) ? '是' : '否')
  const lines = []
  lines.push('<!-- 本文件由 scripts/gen-role-matrix.mjs 生成，CI 以 --check 校验不漂移；请勿手改，改门禁代码后重新生成并提交。 -->')
  lines.push('')
  lines.push('# 角色 × 单据类型可见性矩阵')
  lines.push('')
  lines.push(
    `内置角色 ${roles.length} 个 × 单据类型 ${types.length} 类。每个格子都是对真实门禁函数求值的结果（见 \`scripts/gen-role-matrix.mjs\` 文件头），不是手写结论。` +
      '描述的是"该角色的默认账号"：数据范围取角色默认值、放在某个组织里、未绑定门店 / 经销商；单个账号的 `data_scope` 覆盖、多角色叠加与自定义角色不在内。' +
      '这是开发阶段的文档，不是验收或上线声明。'
  )
  lines.push('')
  lines.push('## 一、单据流转读接口（HTTP `/api/docflow/*`）')
  lines.push('')
  lines.push('- `G` 全局：看到全部单据（`data_scope=all`，或总部角色豁免了门店绑定）')
  lines.push('- `O` 组织范围：只看本组织（子树 / 本组织）内的单据')
  lines.push('- `B` 仅绑定：未绑定门店 / 经销商的账号看不到；绑定后只看自己的门店 / 经销商（总部角色绑了也只看本店）')
  lines.push('- `-` 不可见：外部主体（`dealer` / `store`）整个 docflow 读接口 403；受限范围看不到无组织归属的总账类单据')
  lines.push('')
  lines.push('docflow 读接口只按数据范围与总部豁免收口，不按查看权限点收口（权限点由第二节的 MCP 读工具和各业务路由把关）。')
  lines.push('')
  lines.push(head)
  lines.push(sep)
  lines.push(grid(docflow))
  lines.push('')
  lines.push('## 二、MCP 通用单据读工具（`doc.query` / `doc.get` / `doc.list_types`）')
  lines.push('')
  lines.push('- `Y` 可读：所有者账号持有该类型的任一查看权限点（范围另按所有者数据范围收窄）')
  lines.push('- `Y*` 可读但要绑定：所有者必须有门店 / 经销商 / 订货主体绑定，否则 `TOKEN_OWNER_BINDING_REQUIRED`（admin / 超管与无主令牌豁免）')
  lines.push('- `-` 不可读：没有查看权限点，或外部主体读总部内部类型')
  lines.push('')
  lines.push(head)
  lines.push(sep)
  lines.push(grid(mcp))
  lines.push('')
  lines.push('## 三、单据类型：查看权限点与绑定要求')
  lines.push('')
  lines.push('| 单据 | 模块 | 查看权限点（任一） | MCP 绑定 | 范围注册表绑定 | 范围构建器 | 范围谓词来源（表 · 归属列 / 形状） |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const t of types) {
    lines.push(
      `| \`${t.code}\` ${t.name} | ${t.module} | ${t.perms.map((p) => `\`${p}\``).join('、')} | ${t.binding ? BINDING_TEXT[t.binding] : '无'} | ${t.resolverBinding ? BINDING_TEXT[t.resolverBinding] : '无'} | ${t.builder || '无'} | ${t.shape || '无'} |`
    )
  }
  lines.push('')
  lines.push('## 四、内置角色与总部名单（`server/lib/hq-roles.js`）')
  lines.push('')
  lines.push(`权限点总数 ${model.totalPerms}；admin 与超管恒全开。"总部（并集）"= docflow 严格门店绑定的豁免名单；POS / 要货两列是各自路由闸，与并集互不影响。`)
  lines.push('')
  lines.push('| 角色 | 名称 | 默认数据范围 | 权限点数 | 总部（并集） | POS 总部闸 | 要货总部闸 |')
  lines.push('|---|---|---|---:|:-:|:-:|:-:|')
  for (const r of roles) {
    lines.push(`| \`${r.code}\` | ${r.name} | ${r.dataScope} | ${r.perms} | ${flag(hq.union, r.code)} | ${flag(hq.pos, r.code)} | ${flag(hq.requisition, r.code)} |`)
  }
  lines.push('')
  return lines.join('\n')
}

const model = await evaluate()
if (model.problems.length) {
  console.error(`角色矩阵无法生成：\n  ${model.problems.join('\n  ')}`)
  process.exit(1)
}
if (args.has('--json')) {
  process.stdout.write(`${JSON.stringify(model)}\n`)
  process.exit(0)
}
const text = render(model)
if (args.has('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null
  if (cur !== text) {
    console.error(`docs/operations/role-matrix.md ${cur === null ? '不存在' : '与门禁代码生成结果不一致（漂移）'}；运行 node scripts/gen-role-matrix.mjs 重新生成并提交`)
    process.exit(1)
  }
  console.log('role-matrix.md 与门禁代码一致')
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, text)
  console.log(`已写入 ${path.relative(ROOT, OUT)}`)
}
