/**
 * ============================================================================
 * 文件标识：scripts/bootstrap-admin.mjs ｜ 通过 stdin 密码安全创建首个生产管理员
 * 不启动服务，不接受命令行密码，不打印秘密或数据库异常详情。
 * ============================================================================
 */
import { parseArgs } from 'node:util'
import { bootstrapAdmin, validateBootstrapInput } from '../server/lib/admin-bootstrap.js'
import { initSchemaFor, assertIndustry } from '../server/db/index.js'
import { requireDataDirectory } from '../server/runtime.js'

const help = `Usage: GML_RUNTIME_MODE=production GML_DATA_DIR=/absolute/path node scripts/bootstrap-admin.mjs
  --industry cosmetic|food|apparel --company-code COMPANY --company-name "Company name"
  --username owner --name "Administrator name"
Read the password as one line from non-TTY stdin; never place it in arguments or environment variables.
This command initializes only a fresh production database. It cannot reset an existing administrator.`

async function readPassword() {
  if (process.stdin.isTTY) throw Object.assign(new Error('Pipe a password from a secure prompt or password manager into stdin; interactive terminal echo is not supported'), { code: 'BOOTSTRAP_STDIN_REQUIRED' })
  const chunks = []
  let length = 0
  const timeout = setTimeout(() => process.stdin.destroy(Object.assign(new Error('Password input timed out'), { code: 'BOOTSTRAP_INPUT_TIMEOUT' })), 30000)
  try {
    for await (const chunk of process.stdin) {
      length += chunk.length
      if (length > 128) throw Object.assign(new Error('Password input is too long'), { code: 'BOOTSTRAP_PASSWORD_INVALID' })
      chunks.push(chunk)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, '')
  } finally {
    clearTimeout(timeout)
    for (const chunk of chunks) chunk.fill(0)
  }
}

try {
  const { values } = parseArgs({ options: {
    industry: { type: 'string' }, 'company-code': { type: 'string' }, 'company-name': { type: 'string' },
    username: { type: 'string' }, name: { type: 'string' }, help: { type: 'boolean' }
  }, allowPositionals: false, strict: true })
  if (values.help) {
    console.log(help)
  } else {
    if (process.env.GML_RUNTIME_MODE !== 'production') throw Object.assign(new Error('Explicit GML_RUNTIME_MODE=production is required'), { code: 'BOOTSTRAP_PRODUCTION_REQUIRED' })
    requireDataDirectory()
    if (!values.industry) throw Object.assign(new Error('An explicit --industry is required'), { code: 'BOOTSTRAP_INPUT_INVALID' })
    const industry = assertIndustry(values.industry)
    const input = validateBootstrapInput({ username: values.username, name: values.name,
      companyCode: values['company-code'], companyName: values['company-name'], password: await readPassword() })
    let db
    try {
      process.umask(0o077)
      db = initSchemaFor(industry)
      const result = bootstrapAdmin(db, input)
      console.log(JSON.stringify({ success: true, industry, ...result }))
    } finally {
      input.password = ''
      db?.close()
    }
  }
} catch (error) {
  // parseArgs can echo argument values; SQLite may expose sensitive SQL. Do not print either.
  const safe = typeof error.code === 'string' && error.code.startsWith('BOOTSTRAP_')
  console.error(JSON.stringify({ success: false, code: safe ? error.code : 'BOOTSTRAP_FAILED',
    message: safe ? error.message : 'Initialization failed. Check arguments, runtime/data-directory configuration and schema; no existing account was reset.' }))
  process.exitCode = 1
}
