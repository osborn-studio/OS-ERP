/**
 * ============================================================================
 * 文件标识：server/lib/doc-scope-registry.js ｜ 单据范围谓词注册表（ADR-0032）
 * ============================================================================
 * 【职责】让各领域库（purchase / sales-order / order-center）把自己的"组织范围 → SQL 谓词"函数
 *   登记给单据内核，而不让 `lib/docflow.js` 反向 import 它们。
 *
 * 【为什么单独一个无依赖文件】采购 / 销售 / 订货库都 import `docflow.js`（applyTransition 等），
 *   `docflow.js` 若再 import 它们就是循环依赖，模块求值期会撞 `EFFECT_OWNERS` 的暂时性死区
 *   （实测：`Cannot access 'EFFECT_OWNERS' before initialization`）。注册表本身不 import 任何东西，
 *   两边都可以安全依赖它。
 *
 * 【改它要注意什么】构建器签名 `(ctx, spec) => { sql, params } | null`：`sql` 是对别名 `t`（单据主表）的完整谓词，
 *   `null` / `1=0` 表示该范围下整类单据不可见。未登记的构建器 ⇒ 调用方按**不可见**处理（失败关闭）。
 * ============================================================================
 */
const builders = new Map()

/** 领域库在模块求值期调用；重复登记同名构建器会抛错（防止两处各写一份）。 */
export function registerDocScopeBuilder(name, fn) {
  if (typeof fn !== 'function') throw new TypeError(`doc scope builder ${name} must be a function`)
  if (builders.has(name) && builders.get(name) !== fn) throw new Error(`doc scope builder ${name} already registered`)
  builders.set(name, fn)
}

export function docScopeBuilder(name) {
  return builders.get(name) || null
}

export function registeredDocScopeBuilders() {
  return [...builders.keys()]
}
