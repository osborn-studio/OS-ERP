/**
 * ============================================================================
 * 文件标识：src/pages/AiConsole.tsx ｜ AI 数据承接台（自然语言查询 → 结构化取数）
 * ============================================================================
 * 【职责】AI 数据承接台（自然语言查询 → 结构化取数）（页面）
 * 【入口】/ai
 * 【主要接口】/ai/manifest、/ai/schema、/ai/logs、/ai/query
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
 * 页面：AI 数据承接台（自然语言查询 → 结构化取数）
 */

import { useState } from 'react'
import api from '../api/client'
import { Card, SectionTitle, Status, Tabs, Table, fmtInt, toast, useFetch, Pagination } from '../components/ui'
import { Send, Sparkles, Database, Braces } from 'lucide-react'

export default function AiConsole() {
  const [tab, setTab] = useState('console')
  const [intent, setIntent] = useState('sales_summary')
  const [paramsText, setParamsText] = useState('{"startDate":"2026-10-01"}')
  const [result, setResult] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const { data: manifest } = useFetch<any>('/ai/manifest')
  const { data: schema } = useFetch<any[]>('/ai/schema')

  const [page, setPage] = useState(1)
  const { data: logs, reload } = useFetch<any>('/ai/logs', { page, pageSize: 20 }, [page])

  const run = async () => {
    setBusy(true)
    setResult(null)
    try {
      let params = {}
      try {
        params = paramsText.trim() ? JSON.parse(paramsText) : {}
      } catch {
        throw new Error('参数不是合法 JSON')
      }
      const res: any = await api.post('/ai/query', { intent, params })
      setResult(res.data)
      toast('查询完成')
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="mb-3">
        <h1 className="title-serif text-[19px] font-medium text-ink-900">AI 数据承接台</h1>
        <p className="text-[12px] text-ink-700 mt-0.5">
          面向 AI FDE：结构化意图查询 + 能力清单 + 数据字典，供 Agent / 大模型直接读取业务数据
        </p>
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[
              { key: 'console', label: '意图查询' },
              { key: 'manifest', label: 'AI 能力清单' },
              { key: 'schema', label: '数据结构', count: schema?.length },
              { key: 'logs', label: '查询日志' }
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>

      {tab === 'console' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <Card>
            <SectionTitle title="发起查询" desc="选择意图并传入参数，返回结构化 JSON" />
            <div className="flex flex-col gap-3">
              <div>
                <span className="label">意图 intent</span>
                <select className="input" value={intent} onChange={(e) => setIntent(e.target.value)}>
                  {(manifest?.intents || []).map((it: any) => (
                    <option key={it.key} value={it.key}>
                      {it.name}（{it.key}）
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <span className="label">参数 params（JSON）</span>
                <textarea className="input h-24 py-2 font-mono text-[12px]" value={paramsText} onChange={(e) => setParamsText(e.target.value)} />
              </div>
              <div className="text-[12px] text-ink-700">
                可用参数：
                {(manifest?.intents || []).find((x: any) => x.key === intent)?.params?.join('、') || '无'}
              </div>
              <button className="btn-primary" disabled={busy} onClick={run}>
                <Send size={14} /> {busy ? '查询中…' : '执行查询'}
              </button>
            </div>

            <div className="mt-4 pt-4 border-t border-ink-300">
              <div className="text-[13px] font-medium text-ink-900 mb-2 flex items-center gap-1.5">
                <Sparkles size={14} className="text-tech-500" /> 示例问题
              </div>
              <ul className="flex flex-col gap-1.5">
                {(manifest?.sample_questions || []).map((q: string) => (
                  <li key={q} className="text-[13px] text-ink-800">
                    · {q}
                  </li>
                ))}
              </ul>
            </div>
          </Card>

          <Card className="lg:col-span-2" pad={false}>
            <div className="px-4 pt-4">
              <SectionTitle title="查询结果" desc={result ? '以下为接口返回的结构化数据' : '尚未执行查询'} />
            </div>
            <div className="px-4 pb-4">
              {!result ? (
                <div className="text-center py-16 text-slate-400 text-[13px]">选择左侧意图并执行查询，结果将在此展示</div>
              ) : (
                <div className="flex flex-col gap-3">
                  {Object.entries(result).map(([k, v]) => (
                    <div key={k}>
                      <div className="text-[12px] text-ink-700 mb-1">{k}</div>
                      {Array.isArray(v) ? (
                        <div className="table-wrap border border-ink-300 rounded-md">
                          <table className="tbl">
                            <thead>
                              <tr>
                                {Object.keys(v[0] || { _: '' }).map((h) => (
                                  <th key={h}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {v.length === 0 && (
                                <tr>
                                  <td colSpan={3} className="text-center py-4 text-slate-400">
                                    空结果
                                  </td>
                                </tr>
                              )}
                              {v.slice(0, 20).map((row: any, i: number) => (
                                <tr key={i}>
                                  {Object.keys(v[0] || { _: '' }).map((h) => (
                                    <td key={h} className="tabular-nums">
                                      {row[h] === null || row[h] === undefined ? '—' : String(row[h])}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="text-[13px] text-ink-900 bg-ink-100 rounded-md px-3 py-2">
                          {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                        </div>
                      )}
                    </div>
                  ))}
                  <details className="text-[12px]">
                    <summary className="cursor-pointer text-ink-700">查看原始 JSON</summary>
                    <pre className="mt-2 p-3 bg-ink-100 rounded-md overflow-x-auto text-[12px] leading-5">{JSON.stringify(result, null, 2)}</pre>
                  </details>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}

      {tab === 'manifest' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Card>
            <SectionTitle title="系统信息" desc="供 AI 识别系统边界与鉴权方式" />
            <div className="flex flex-col gap-2 text-[13px]">
              {Object.entries(manifest?.system || {}).map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <span className="w-28 shrink-0 text-ink-700">{k}</span>
                  <span className="text-ink-900">{String(v)}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <SectionTitle title="模块清单" desc="AI 可访问的业务模块与路径" />
            <Table
              columns={[
                { key: 'name', title: '模块', width: 110 },
                { key: 'path', title: '接口前缀', width: 150 },
                { key: 'desc', title: '说明' }
              ]}
              data={manifest?.modules || []}
            />
          </Card>
          <Card className="lg:col-span-2" pad={false}>
            <div className="px-4 pt-4">
              <SectionTitle title="意图清单" desc="结构化查询意图与参数定义" />
            </div>
            <Table
              columns={[
                { key: 'key', title: 'intent', width: 170, render: (r) => <span className="font-mono text-[12px]">{r.key}</span> },
                { key: 'name', title: '名称', width: 130 },
                { key: 'params', title: '参数', render: (r) => (r.params || []).join('、') || '—' }
              ]}
              data={manifest?.intents || []}
            />
            <div className="px-4 py-4 text-[12px] text-ink-700">
              <div className="flex items-center gap-1.5 mb-1">
                <Braces size={13} /> 调用方式：<span className="font-mono">POST /api/ai/query</span> body：
                <span className="font-mono">{'{ "intent": "sales_summary", "params": { "startDate": "2026-10-01" } }'}</span>
              </div>
              <div>鉴权：Header 携带 Authorization: Bearer &lt;token&gt;（/api/ai/manifest 与 /api/meta/health 免鉴权）</div>
            </div>
          </Card>
        </div>
      )}

      {tab === 'schema' && (
        <Card pad={false}>
          <div className="px-4 pt-4">
            <SectionTitle title="数据结构" desc="全部业务表与其字段，供 AI 生成 SQL / 理解口径" right={<span className="text-[12px] text-ink-700 flex items-center gap-1"><Database size={13} /> 共 {schema?.length || 0} 张表</span>} />
          </div>
          <Table
            columns={[
              { key: 'table', title: '表名', width: 220, render: (r) => <span className="font-mono text-[12px]">{r.table}</span> },
              { key: 'rows', title: '记录数', width: 100, align: 'right', render: (r) => fmtInt(r.rows) },
              { key: 'columns', title: '字段', render: (r) => <span className="text-[12px] text-ink-700">{(r.columns || []).join(', ')}</span> }
            ]}
            data={schema || []}
          />
        </Card>
      )}

      {tab === 'logs' && (
        <Card pad={false}>
          <div className="px-4 pt-4">
            <SectionTitle title="AI 查询日志" desc="每次意图查询的入参、结果与耗时" />
          </div>
          <Table
            columns={[
              { key: 'created_at', title: '时间', width: 165 },
              { key: 'intent', title: '意图', width: 160, render: (r) => <span className="font-mono text-[12px]">{r.intent}</span> },
              { key: 'params', title: '参数', width: 260, render: (r) => <span className="text-[12px] text-ink-700">{r.params || '—'}</span> },
              { key: 'cost_ms', title: '耗时(ms)', width: 100, align: 'right' },
              { key: 'status', title: '结果', width: 90, render: (r) => <Status value={r.status || 'success'} /> },
              { key: 'user_name', title: '调用人', width: 120 }
            ]}
            data={logs?.list || []}
            empty="暂无查询记录，去「意图查询」执行一次试试"
          />
          <div className="px-4 pb-4">
            <Pagination page={page} pageSize={20} total={logs?.total || 0} onChange={setPage} />
          </div>
        </Card>
      )}
    </div>
  )
}
