/**
 * ============================================================================
 * 文件标识：src/pages/system/McpCenter.tsx ｜ 「AI 与 MCP 控制台」
 * ============================================================================
 * 【这一页回答客户的哪句话】
 *   「明确展示这个系统**任何单据**都有 MCP，都可以被 AI 使用和控制，同时保证安全性。」
 *
 * 【这一页的数据从哪来】
 *   **全部来自 `GET /api/mcp/catalog`**（服务端 `server/mcp/catalog.js` 由内核三张表推导）。
 *   页面里**不写任何单据名、不写任何数量** —— 一旦写死，"支持 N 种单据"第二天就开始撒谎，
 *   而且它不会报错，只会安静地过时。这是本页最重要的设计约束。
 *
 * 【这一页为什么值得存在】
 *   MCP 的能力原本只体现在 `/mcp` 的 JSON-RPC 与代码里：客户看不见、实施讲不清、
 *   验收无法核对。把「有哪些单据 / 能读能写到哪一步 / 哪些必须人确认」摊开成一张表，
 *   才能回答三个具体问题：
 *     ① 我这张单据，AI 认得吗？（单据矩阵：40 种全在）
 *     ② AI 能对它做什么？（安全边可推进 / 高危边必须人工）
 *     ③ 凭什么信它不会乱来？（安全边界 + 每次调用留痕）
 *
 * 【操作边界】能力目录只读；人工确认和调用审计复用服务端现有权限与确认接口，不签发令牌。
 *   令牌表（ADR-0015）只展示与吊销 / 清扫：`status` 是行历史，`effective_status` 是现状
 *   （所有者改密 / 停用 / 过期时不再是 active），两列都来自服务端，页面不自己推断。
 * ============================================================================
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Card, SectionTitle, StatCard, Table, Tabs, useFetch, toast } from '../../components/ui'
import api from '../../api/client'
import { PRODUCT_NAME } from '../../constants/brand'
import { ShieldCheck, Bot, FileStack, Workflow, AlertTriangle, Radio, KeyRound, ScrollText } from 'lucide-react'

const LEVEL_LABEL: Record<string, { text: string; cls: string }> = {
  read: { text: '只读', cls: 'bg-brand-50 text-brand-700 border-brand-200' },
  write: { text: '可写', cls: 'bg-tech-50 text-tech-700 border-tech-200' },
  danger: { text: '高危·需人工确认', cls: 'bg-red-50 text-red-600 border-red-200' }
}

function Badge({ children, cls = '' }: { children: any; cls?: string }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] leading-4 ${cls || 'bg-ink-100 text-ink-700 border-ink-300'}`}>
      {children}
    </span>
  )
}

export default function McpCenter() {
  const [tab, setTab] = useState('matrix')
  const { data, loading, reload } = useFetch<any>('/mcp/catalog')
  const c = data || {}
  const s = c.summary || {}
  const docs: any[] = c.doc_types || []
  const tools: any[] = c.tools || []
  const generic: any[] = c.generic_tools || []
  const safety: any[] = c.safety || []

  const genericNames = useMemo(() => new Set(generic.map((g) => g.name)), [generic])
  const toolsByLevel = useMemo(() => {
    const out: Record<string, any[]> = { read: [], write: [], danger: [] }
    for (const t of tools) (out[t.level] || (out[t.level] = [])).push(t)
    return out
  }, [tools])

  return (
    <div className="space-y-3">
      {/* ---------- 抬头：一句话定位 ---------- */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Bot size={18} className="text-brand-600" />
              <div className="text-[16px] font-medium text-ink-900 title-serif">AI 与 MCP 控制台</div>
              <Badge cls="bg-tech-50 text-tech-700 border-tech-200">AI 原生</Badge>
              <Badge cls="bg-brand-600 text-white border-brand-600">MCP 全面开放</Badge>
            </div>
            <div className="text-[13px] text-brand-700 font-medium mt-1.5">
              这是一个「全面开放 MCP 的 ERP」—— 全部 {s.doc_types ?? ''} 种单据、{s.actions_via_generic ?? ''} 条安全流转边，AI 都能读、能写、能推进。
            </div>
            <div className="text-[12.5px] text-ink-600 mt-1 leading-6 max-w-[860px]">
              {PRODUCT_NAME} 把**每一张单据**都通过 MCP 暴露给 AI：能查、能读详情与流转留痕、
              能在**内核允许的安全边**上推进；<b>高危动作一律拒绝，必须由人在界面确认</b>。
              下面这张矩阵不是宣传页 —— 它由单据内核与工具注册表**实时推导**，新增一张单据它会自动多一行。
            </div>
          </div>
          <button className="btn-ghost btn-sm" onClick={reload} disabled={loading}>
            {loading ? '读取中…' : '刷新'}
          </button>
        </div>
      </Card>

      {/* ---------- 覆盖统计 ---------- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="单据类型" value={s.doc_types ?? '—'} sub={`其中 ${s.doc_types_with_data ?? 0} 种在本行业有数据`} tone="brand" icon={<FileStack size={14} />} />
        <StatCard label="可由 AI 推进的边" value={s.actions_via_generic ?? '—'} sub={`内核共 ${s.actions ?? 0} 条流转边`} icon={<Workflow size={14} />} />
        <StatCard label="高危边（须人工）" value={s.actions_danger ?? '—'} sub="通用工具一律拒收，报 EDGE_REQUIRES_HUMAN" tone="red" icon={<AlertTriangle size={14} />} />
        <StatCard label="MCP 工具" value={s.tools ?? '—'} sub={`只读 ${s.tools_read ?? 0} / 可写 ${s.tools_write ?? 0} / 高危 ${s.tools_danger ?? 0}`} icon={<Radio size={14} />} />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'matrix', label: '单据矩阵' },
          { key: 'tools', label: '工具清单' },
          { key: 'safety', label: '安全边界' },
          { key: 'operations', label: '人工确认与审计' },
          { key: 'howto', label: '接入方式' }
        ]}
      />
      {tab === 'operations' && <McpOperations />}

      {/* ---------- 一、单据矩阵 ---------- */}
      {tab === 'matrix' && (
        <Card pad={false}>
          <div className="px-3 pt-3">
            <SectionTitle
              title="这个系统的每一张单据，AI 都认得"
              desc="「安全边」= 通用工具 doc.transition 能推进的边；「高危边」= 必须人工确认的边（AI 调用会被拒绝）。"
            />
          </div>
          <Table
            loading={loading}
            columns={[
              { key: 'code', title: '类型', width: 90, render: (r) => <span className="font-mono text-[12px]">{r.code}</span> },
              { key: 'name', title: '单据', width: 150 },
              { key: 'module', title: '模块', width: 100, render: (r) => <span className="text-ink-600">{r.module}</span> },
              {
                key: 'states',
                title: '状态',
                width: 70,
                align: 'right',
                render: (r) => <span title={(r.states || []).map((x: any) => x.name).join(' / ')}>{r.states?.length ?? 0}</span>
              },
              {
                key: 'safe',
                title: '安全边',
                width: 80,
                align: 'right',
                render: (r) => {
                  const n = (r.actions || []).filter((a: any) => !a.danger).length
                  return <span className={n ? 'text-brand-700 font-medium' : 'text-ink-400'}>{n}</span>
                }
              },
              {
                key: 'danger',
                title: '高危边',
                width: 80,
                align: 'right',
                render: (r) => {
                  const n = (r.actions || []).filter((a: any) => a.danger).length
                  return n ? <span className="text-red-600">{n}</span> : <span className="text-ink-400">0</span>
                }
              },
              {
                key: 'rows',
                title: '在用',
                width: 80,
                align: 'right',
                render: (r) =>
                  r.rows == null ? (
                    <span className="text-ink-400" title="表还没建（迁移没跑到）">未建表</span>
                  ) : (
                    <span className={r.rows > 0 ? 'text-ink-800' : 'text-ink-400'}>{r.rows}</span>
                  )
              },
              {
                key: 'ai',
                title: 'AI 能力',
                render: (r) => (
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge cls="bg-brand-50 text-brand-700 border-brand-200">可读</Badge>
                    {r.ai?.write ? <Badge cls="bg-tech-50 text-tech-700 border-tech-200">可推进</Badge> : null}
                    {r.ai?.needs_human_for_danger ? <Badge cls="bg-red-50 text-red-600 border-red-200">含高危</Badge> : null}
                    {/* 归属列 = 0 的单据：受限令牌（按组织/门店/经销商/仓库约束）会判成"看不到"。
                        这件事必须写在页面上 —— 否则"AI 说没这张单"永远分不清是范围还是数据。 */}
                    {r.restricted_invisible ? (
                      <span title="该单据表没有组织/门店/经销商/仓库归属列：受限令牌（按范围约束）看不到它，不传范围的全量令牌可以">
                        <Badge cls="bg-amber-50 text-amber-700 border-amber-200">受限令牌不可见</Badge>
                      </span>
                    ) : null}
                  </div>
                )
              }
            ]}
            data={docs}
            rowKey={(r) => r.code}
            empty="没有读到单据定义（检查 /api/mcp/catalog）"
          />
        </Card>
      )}

      {/* ---------- 二、工具清单 ---------- */}
      {tab === 'tools' && (
        <div className="space-y-3">
          <Card>
            <SectionTitle
              title="通用单据工具：4 个工具覆盖全部单据"
              desc="它们不认业务、只认内核 —— 内核里新登记一张单据，AI 立刻能读能推进，不需要改 MCP 代码。"
            />
            <div className="mt-2 space-y-2">
              {generic.map((g) => (
                <div key={g.name} className="flex flex-wrap items-start gap-2 pb-2 border-b border-ink-200 last:border-0">
                  <span className="font-mono text-[12px] text-ink-900 w-[150px] shrink-0">{g.name}</span>
                  <Badge cls={LEVEL_LABEL[g.level]?.cls}>{LEVEL_LABEL[g.level]?.text || g.level}</Badge>
                  {g.implemented ? (
                    <Badge cls="bg-green-50 text-green-700 border-green-200">已实现</Badge>
                  ) : (
                    <Badge cls="bg-red-50 text-red-600 border-red-200">未实现</Badge>
                  )}
                  <span className="text-[12.5px] text-ink-600 flex-1 min-w-[240px]">{g.covers}</span>
                </div>
              ))}
            </div>
          </Card>

          {['read', 'write', 'danger'].map((lv) => (
            <Card key={lv} pad={false}>
              <div className="px-3 pt-3">
                <SectionTitle
                  title={`${LEVEL_LABEL[lv]?.text || lv}工具（${toolsByLevel[lv]?.length || 0} 个）`}
                  desc={
                    lv === 'read'
                      ? '只查不改，无副作用。'
                      : lv === 'write'
                        ? '会改数据，必须带幂等键；重放返回同一结果，同键不同参数直接 409。'
                        : '高危：要人工确认（confirm_token）才执行 —— 这是"AI 能控制"与"AI 别乱动"的分界。'
                  }
                />
              </div>
              <Table
                loading={loading}
                columns={[
                  {
                    key: 'name',
                    title: '工具',
                    width: 240,
                    render: (r) => (
                      <span className="font-mono text-[12px]">
                        {r.name}
                        {genericNames.has(r.name) ? <span className="ml-1 text-tech-600 text-[10px]">通用</span> : null}
                      </span>
                    )
                  },
                  { key: 'title', title: '用途', width: 170 },
                  { key: 'description', title: '说明', render: (r) => <span className="text-ink-600 text-[12.5px]">{r.description}</span> }
                ]}
                data={toolsByLevel[lv] || []}
                rowKey={(r) => r.name}
                empty="无"
              />
            </Card>
          ))}
        </div>
      )}

      {/* ---------- 三、安全边界 ---------- */}
      {tab === 'safety' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {safety.map((x) => (
            <Card key={x.key}>
              <div className="flex items-start gap-2">
                <ShieldCheck size={16} className="text-brand-600 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium text-ink-900">{x.title}</div>
                  <div className="text-[12.5px] text-ink-600 mt-1 leading-6">{x.detail}</div>
                </div>
              </div>
            </Card>
          ))}
          <Card>
            <div className="flex items-start gap-2">
              <ScrollText size={16} className="text-brand-600 mt-0.5 shrink-0" />
              <div>
                <div className="text-[13.5px] font-medium text-ink-900">一句话总结</div>
                <div className="text-[12.5px] text-ink-600 mt-1 leading-6">
                  AI 与人在**同一套判据**下工作：同一份单据定义、同一份动作权限、同一份实体范围。
                  区别只有一个 —— <b>高危动作 AI 做不了，必须人来点</b>。
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ---------- 四、接入方式 ---------- */}
      {tab === 'howto' && (
        <Card>
          <SectionTitle title="接入方式（3 步）" desc="标准 MCP 协议，任何支持 MCP 的客户端都能接。" />
          <div className="space-y-3 mt-2">
            {[
              {
                icon: KeyRound,
                title: '① 签发 Agent Token',
                body: '在「用户与权限 / MCP 令牌」里签发，令牌以 gml_ 开头，可设行业、组织范围、工具白名单、调用频率与有效期。吊销即时生效。'
              },
              {
                icon: Radio,
                title: '② 连上 MCP 端点',
                body: 'POST /mcp（JSON-RPC 2.0），Authorization: Bearer gml_xxx。先 initialize 握手，再 tools/list 取工具，最后 tools/call 执行。'
              },
              {
                icon: Workflow,
                title: '③ 按"先看类型、再操作"的顺序调用',
                body: '任何单据操作前先调 doc.list_types 拿到「这个类型在什么状态下能做什么、哪些是高危」；读用 doc.query / doc.get，写用 doc.transition（带 idempotency_key）。'
              },
              {
                icon: ScrollText,
                title: '④ 高危动作的人工确认',
                body: '高危工具调用会返回 confirmation_required + confirm_token；具备 system.mcp.confirm 权限的登录用户在界面上确认后，AI 才能继续。'
              }
            ].map((x) => (
              <div key={x.title} className="flex items-start gap-2 pb-2 border-b border-ink-200 last:border-0">
                <x.icon size={15} className="text-tech-600 mt-0.5 shrink-0" />
                <div>
                  <div className="text-[13px] font-medium text-ink-900">{x.title}</div>
                  <div className="text-[12.5px] text-ink-600 mt-0.5 leading-6">{x.body}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

/** 令牌有效状态 → 展示文案与色调。键必须与服务端 `EFFECTIVE_STATUS`（server/mcp/tokens.js）逐字一致。 */
const EFFECTIVE_LABEL: Record<string, { text: string; cls: string }> = {
  active: { text: '可用', cls: 'bg-green-100 text-green-700' },
  revoked: { text: '已吊销', cls: 'bg-slate-100 text-slate-600' },
  expired: { text: '已过期', cls: 'bg-amber-100 text-amber-700' },
  owner_missing: { text: '所有者不存在', cls: 'bg-red-100 text-red-600' },
  owner_inactive: { text: '所有者已停用', cls: 'bg-red-100 text-red-600' },
  revoked_by_owner_change: { text: '所有者已变更·失效', cls: 'bg-red-100 text-red-600' }
}

type McpLimits = { rpm: number; write_rpm: number; window_seconds: number; daily_quota: number; rate_limited_total: number; counter_scope: string }

/**
 * 限速与配额读数（AE11，只读，仅 system.mcp.manage）。数字来自 `GET /api/mcp/limits`：与限流器同一份策略，不在页面里写死。
 * 429 计数是**本进程自启动以来**的累计（重启归零、多进程各自计数），不是历史统计；要看明细用 /metrics 的
 * os_erp_mcp_tool_calls_total{code="MCP_RATE_LIMITED"}。读取失败（含 403）时整块不显示，不画默认值。
 */
function McpLimitsCard({ nonce }: { nonce: number }) {
  const { data, error } = useFetch<McpLimits>('/mcp/limits', undefined, [nonce])
  if (!data || error) return null
  const quotaOn = data.daily_quota > 0
  return (
    <Card>
      <SectionTitle
        title="限速与日配额"
        desc="按令牌计，键是验签后的令牌 id。超限返回 HTTP 429 + Retry-After（业务码 MCP_RATE_LIMITED）。调整：环境变量 GML_MCP_TOKEN_RPM / GML_MCP_WRITE_RPM（需重启），日配额在系统设置 mcp_token_daily_quota。"
      />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="mcp-limits" data-rpm={data.rpm} data-write-rpm={data.write_rpm} data-daily-quota={data.daily_quota} data-limited={data.rate_limited_total}>
        <StatCard label="每分钟调用上限" value={data.rpm} sub={`每令牌，${data.window_seconds} 秒滑动窗口，含写调用`} />
        <StatCard label="每分钟写调用上限" value={data.write_rpm} sub="写型工具另计，同时占用总额度" />
        <StatCard label="每日配额" value={quotaOn ? data.daily_quota : '未开启'} sub={quotaOn ? '每令牌每本地日历日，过午夜归零' : '设置 mcp_token_daily_quota = 0'} />
        <StatCard label="被限流（429）" value={data.rate_limited_total} tone={data.rate_limited_total > 0 ? 'amber' : 'default'} sub="本进程自启动以来，重启归零" />
      </div>
      <McpTokenLimitsBlock nonce={nonce} />
      <McpQuotaBlock nonce={nonce} />
    </Card>
  )
}

type McpTokenLimits = { store: 'memory' | 'db'; truncated?: boolean; window_seconds: number; tokens: { id: number; name: string; rate_limited_recent: number }[] }

/**
 * 每令牌近期限流（AF11，只读，仅 system.mcp.manage）。数字来自 `GET /api/mcp/limits/tokens`，只在 `db` 速率存储模式有数据。
 * `rate_limited_recent` 是当前 + 上一窗口内该令牌被限流（429）的精确次数（AG9：来自拒绝时记的 denied 行）。读取失败（含 403）时不显示。
 */
function McpTokenLimitsBlock({ nonce }: { nonce: number }) {
  const { data, error } = useFetch<McpTokenLimits>('/mcp/limits/tokens', undefined, [nonce])
  if (!data || error) return null
  if (data.store !== 'db') {
    return <div data-testid="mcp-token-429" data-store={data.store} className="mt-3 text-[12px] text-slate-500">每令牌限流明细仅在 GML_MCP_RATE_STORE=db 时提供；当前为内存模式（各进程各自计数、重启归零）。</div>
  }
  const hit = data.tokens.filter((t) => t.rate_limited_recent > 0)
  return (
    <div data-testid="mcp-token-429" data-store="db" data-hit={hit.length} className="mt-3">
      {data.truncated && <div className="text-[12px] text-amber-700 mb-1" data-testid="mcp-token-429-truncated">令牌过多，仅列出前 500 张，触顶令牌优先。</div>}
      <div className="text-[12px] text-slate-500 mb-1">当前与上一个 {data.window_seconds} 秒窗口内被限流（429）的令牌与次数</div>
      {hit.length === 0
        ? <div className="text-[12px] text-emerald-700" data-testid="mcp-token-429-empty">没有令牌被限流</div>
        : <ul className="text-[13px] divide-y divide-slate-100">{hit.map((t) => (
            <li key={t.id} className="py-1 flex justify-between" data-testid="mcp-token-429-row" data-token-id={t.id} data-recent={t.rate_limited_recent}>
              <span>{t.name} <span className="text-slate-400">#{t.id}</span></span>
              <span className="text-amber-700">被限流 {t.rate_limited_recent} 次</span>
            </li>
          ))}</ul>}
    </div>
  )
}

type McpQuotaToken = { id: number; name: string; used: number; remaining: number }
type McpQuota = { daily_quota: number; enabled: boolean; usage_unavailable?: boolean; truncated?: boolean; next_cursor?: string | null; tokens: McpQuotaToken[] }

/**
 * 每令牌今日配额用量（AG9，只读，仅 system.mcp.manage）。数据来自 `GET /api/mcp/limits/quota`，口径同日配额判定（本地日历日的审计行数）。
 * 配额关闭时服务端返回空列表，这里整块不显示；读取失败（含 403）同样不显示。
 * AH9：游标分页——首屏 100 行，`next_cursor` 非空时显示「加载更多」，按它取下一页并追加（按 id 去重）；刷新（nonce）时回到首页。
 */
function McpQuotaBlock({ nonce }: { nonce: number }) {
  const { data, error } = useFetch<McpQuota>('/mcp/limits/quota', undefined, [nonce])
  const [extra, setExtra] = useState<McpQuotaToken[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreFailed, setMoreFailed] = useState(false)
  const generation = useRef(0) // 刷新后到达的旧「加载更多」响应必须丢弃，否则会把已清空的行又塞回来并推进新列表的游标
  useEffect(() => { generation.current += 1; setExtra([]); setCursor(data?.next_cursor ?? null); setMoreFailed(false); setLoadingMore(false) }, [data])
  if (!data || error || !data.enabled) return null
  if (data.usage_unavailable) return <div data-testid="mcp-quota" data-quota={data.daily_quota} data-unavailable="1" className="mt-3 text-[12px] text-amber-700">今日配额用量暂时读不到（审计表不可读）；此时调用会被安全拒绝，不代表还有剩余额度。</div>
  const rows = [...data.tokens, ...extra.filter((t) => !data.tokens.some((d) => d.id === t.id))]
  const low = rows.filter((t) => t.remaining === 0).length
  const loadMore = async () => {
    if (!cursor || loadingMore) return
    const mine = generation.current
    setLoadingMore(true); setMoreFailed(false)
    try {
      const res = await api.get('/mcp/limits/quota', { cursor, limit: 100 })
      if (mine !== generation.current) return
      const page: McpQuota = res.data
      if (page.usage_unavailable) { setMoreFailed(true); return }
      setExtra((prev) => [...prev, ...page.tokens.filter((t) => !prev.some((p) => p.id === t.id))])
      setCursor(page.next_cursor ?? null)
    } catch { if (mine === generation.current) setMoreFailed(true) } finally { if (mine === generation.current) setLoadingMore(false) }
  }
  return (
    <div data-testid="mcp-quota" data-quota={data.daily_quota} data-exhausted={low} data-loaded={rows.length} data-has-more={cursor ? '1' : '0'} className="mt-3">
      <div className="text-[12px] text-slate-500 mb-1">今日配额用量（每令牌 {data.daily_quota} 次，本地日历日，审计行口径；用量多者在前）</div>
      {rows.length === 0
        ? <div className="text-[12px] text-slate-500" data-testid="mcp-quota-empty">没有在用令牌</div>
        : <ul className="text-[13px] divide-y divide-slate-100">{rows.map((t) => (
            <li key={t.id} className="py-1 flex justify-between" data-testid="mcp-quota-row" data-token-id={t.id} data-used={t.used} data-remaining={t.remaining}>
              <span>{t.name} <span className="text-slate-400">#{t.id}</span></span>
              <span className={t.remaining === 0 ? 'text-red-600' : 'text-slate-700'}>已用 {t.used} / 剩余 {t.remaining}</span>
            </li>
          ))}</ul>}
      {cursor && (
        <button type="button" className="mt-2 text-[12px] text-blue-600 hover:underline disabled:opacity-50" data-testid="mcp-quota-more" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? '加载中…' : '加载更多'}
        </button>
      )}
      {moreFailed && <div className="text-[12px] text-amber-700 mt-1" data-testid="mcp-quota-more-failed">加载更多失败，请稍后重试或刷新。</div>}
    </div>
  )
}

function McpOperations() {
  const [confirmations, setConfirmations] = useState<any[]>([])
  const [logs, setLogs] = useState<any[]>([])
  const [tokens, setTokens] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const load = async () => {
    setBusy(true)
    try {
      const pending = await api.get('/mcp/confirmations')
      const calls = await api.get('/mcp/logs', { limit: 30 })
      const list = await api.get('/mcp/tokens')
      setConfirmations(pending.data || [])
      setLogs(calls.data || [])
      setTokens(list.data || [])
      setLimitsNonce((n) => n + 1)
    } catch (e: any) { toast(e.message, 'error') }
    finally { setBusy(false) }
  }
  const sweep = async () => {
    if (!window.confirm('把「所有者已变更 / 所有者不存在」但仍标为 active 的令牌置为已吊销？（调用早已被拒，这一步只让列表与事实一致）')) return
    setBusy(true)
    try {
      const r = await api.post('/mcp/tokens/sweep', {})
      toast(`已清扫 ${r.data?.swept ?? 0} 张令牌`)
      await load()
    } catch (e: any) { toast(e.message, 'error'); setBusy(false) }
  }
  const revoke = async (row: any) => {
    if (!window.confirm(`吊销令牌「${row.name}」（${row.token_prefix}…）？吊销后不可恢复，只能重新签发。`)) return
    setBusy(true)
    try {
      await api.del(`/mcp/tokens/${row.id}`)
      toast('已吊销')
      await load()
    } catch (e: any) { toast(e.message, 'error'); setBusy(false) }
  }
  const [limitsNonce, setLimitsNonce] = useState(0)
  const stale = tokens.filter((t) => t.status === 'active' && (t.effective_status === 'revoked_by_owner_change' || t.effective_status === 'owner_missing')).length
  useEffect(() => { load() }, [])
  const decide = async (row: any, decision: 'approve' | 'reject') => {
    if (!window.confirm(`${decision === 'approve' ? '批准' : '拒绝'} ${row.tool_name}？\n${row.args_json}`)) return
    setBusy(true)
    try {
      if (decision === 'approve') {
        await api.post(`/mcp/confirmations/${encodeURIComponent(row.confirm_token)}/approve`, {})
      } else {
        await api.post(`/mcp/confirmations/${encodeURIComponent(row.confirm_token)}/reject`, {})
      }
      toast(decision === 'approve' ? '已确认，等待Agent按原参数执行' : '已拒绝')
      await load()
    } catch (e: any) { toast(e.message, 'error'); setBusy(false) }
  }
  return <div className="space-y-3">
    <div className="flex justify-end"><button className="btn-ghost btn-sm" disabled={busy} onClick={load}>刷新记录</button></div>
    <McpLimitsCard nonce={limitsNonce} />
    <Card>
      <SectionTitle
        title="Agent Token"
        desc="「状态」是行历史，「有效状态」是现状：所有者改密 / 退出全部会话 / 角色或权限集变更后，旧令牌每次调用都被拒（TOKEN_OWNER_REVOKED），清扫把它们如实标为已吊销。"
        right={<button className="btn-ghost btn-sm" disabled={busy || stale === 0} onClick={sweep}>清扫失效令牌{stale ? `（${stale}）` : ''}</button>}
      />
      <Table data={tokens} rowKey={(r) => r.id} columns={[
        { key: 'name', title: '名称', render: r => <div><div className="font-medium">{r.name}</div><div className="text-[11px] text-ink-500 font-mono">{r.token_prefix}…</div></div> },
        { key: 'owner', title: '所有者', render: r => r.owner_user_id == null ? <span className="text-ink-500">无主</span> : (r.owner_name || r.owner_username || `#${r.owner_user_id}`) },
        { key: 'scopes', title: '范围' },
        { key: 'status', title: '状态', render: r => r.status === 'active' ? '活跃' : '已吊销' },
        { key: 'effective_status', title: '有效状态', render: r => {
          const m = EFFECTIVE_LABEL[r.effective_status] || { text: r.effective_status, cls: 'bg-slate-100 text-slate-600' }
          return <span className={`tag ${m.cls}`} title={r.effective_reason || ''}>{m.text}</span>
        } },
        { key: 'reason', title: '说明', render: r => <span className="break-all text-[12px]">{r.revoked_reason ? `${r.revoked_reason}${r.revoked_at ? ` · ${r.revoked_at}` : ''}` : (r.effective_reason || r.remark || '—')}</span> },
        { key: 'last_used_at', title: '最近调用', render: r => r.last_used_at || '—' },
        { key: 'actions', title: '操作', render: r => r.status === 'active'
          ? <button className="btn-ghost btn-sm" disabled={busy} onClick={() => revoke(r)}>吊销</button>
          : '—' }
      ]} empty="暂无 Agent Token" />
    </Card>
    <Card>
      <SectionTitle title="高危动作确认" desc="批准仅授权本次原参数调用，实际执行仍由Agent发起；申请人不得自行批准。" />
      <Table data={confirmations} rowKey={(r) => r.id} columns={[
        { key: 'tool_name', title: '工具' },
        { key: 'token_name', title: '申请Agent' },
        { key: 'args_json', title: '本次参数', render: r => <pre className="whitespace-pre-wrap break-all text-[11px] max-w-[450px]">{r.args_json}</pre> },
        { key: 'status', title: '状态' },
        { key: 'confirmed_by', title: '确认人' },
        { key: 'actions', title: '操作', render: r => r.status === 'pending' ? <div className="flex gap-2">
          <button className="btn-primary btn-sm" disabled={busy} onClick={() => decide(r, 'approve')}><ShieldCheck size={14} />批准</button>
          <button className="btn-ghost btn-sm" disabled={busy} onClick={() => decide(r, 'reject')}>拒绝</button>
        </div> : '—' }
      ]} empty="暂无高危动作申请" />
    </Card>
    <Card>
      <SectionTitle title="MCP调用审计" />
      <Table data={logs} rowKey={(r) => r.id} columns={[
        { key: 'created_at', title: '时间' }, { key: 'tool_name', title: '工具' },
        { key: 'level', title: '级别' },
        { key: 'ok', title: '结果', render: r => r.ok ? '成功' : '未执行 / 拒绝' },
        { key: 'error', title: '说明', render: r => <span className="break-all">{r.error_message || r.error_code || '已记录调用'}</span> }
      ]} empty="暂无调用记录" />
    </Card>
  </div>
}
