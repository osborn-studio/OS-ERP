/**
 * ============================================================================
 * 文件标识：scripts/mcp-readonly-demo.mjs | 接收方只读 MCP 接入自检，不输出凭据。
 * ============================================================================
 */
const token = process.env.GML_AGENT_TOKEN
const url = process.env.GML_MCP_URL || 'http://127.0.0.1:3001/mcp'
if (!token) { console.error('Set GML_AGENT_TOKEN to a locally issued read-only token.'); process.exit(1) }
let id = 0
async function rpc(method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15000) })
  const body = await response.json()
  if (!response.ok || body.error || body.result?.isError) throw new Error(JSON.stringify(body.error || body.result || { status: response.status }))
  return body.result
}
try {
  const tools = await rpc('tools/list', {})
  console.log(`Available tools: ${tools.tools?.length ?? 0}`)
  console.log(JSON.stringify(await rpc('tools/call', { name: 'doc.list_types', arguments: {} }), null, 2))
} catch (error) { console.error(error.message); process.exitCode = 1 }
