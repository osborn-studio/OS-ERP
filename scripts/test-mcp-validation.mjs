/**
 * ============================================================================
 * 文件标识：scripts/test-mcp-validation.mjs | MCP 参数边界测试
 * 【职责】拒绝非有限数、字符串布尔值、非对象参数与原型链字段，验证合法参数可用。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { validateToolArgs } from '../server/mcp/validate.js'

const tool = { inputSchema: { type: 'object', properties: {
  qty: { type: 'number', exclusiveMinimum: 0 }, flag: { type: 'boolean' },
  count: { type: 'integer' }, kind: { type: 'string', enum: ['a', 'b'] }
} } }
let passed = 0
function verify(name, condition) { assert(condition, name); passed++ }
for (const value of ['Infinity', '-Infinity', '1e999', Infinity, -Infinity, NaN]) {
  verify(`reject non-finite ${String(value)}`, !validateToolArgs(tool, { qty: value }).ok)
}
for (const value of ['true', 'false', 0, 1, {}, []]) {
  verify(`reject non-boolean ${JSON.stringify(value)}`, !validateToolArgs(tool, { flag: value }).ok)
}
for (const value of [null, [], 'x', 1, true]) verify('reject non-object arguments', !validateToolArgs(tool, value).ok)
for (const key of ['constructor', 'toString', '__proto__']) {
  const args = JSON.parse(`{"${key}":"x"}`)
  verify(`reject prototype key ${key}`, validateToolArgs(tool, args).code === 'ARG_UNKNOWN')
}
for (const args of [{ qty: 1 }, { qty: '1.25' }, { flag: false }, { flag: true }, { count: '2' }, { kind: 'a' }, {}]) {
  verify(`accept ${JSON.stringify(args)}`, validateToolArgs(tool, args).ok)
}
verify('reject fractional integer', !validateToolArgs(tool, { count: 1.2 }).ok)
verify('reject non-positive quantity', !validateToolArgs(tool, { qty: 0 }).ok)
verify('reject unknown enum', !validateToolArgs(tool, { kind: 'c' }).ok)
console.log(`通过 ${passed} / 失败 0`)
