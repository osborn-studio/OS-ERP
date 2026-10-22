/**
 * ============================================================================
 * 文件标识：src/pages/system/Notify.tsx ｜ 消息推送
 * ============================================================================
 * 【职责】消息推送（页面）
 * 【入口】/system/notify
 * 【主要接口】/notify/meta、/notify/overview、/notify/channels、/notify/push、/notify/logs
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
 * 页面：消息推送
 */

import { useState } from 'react'
import api from '../../api/client'
import { Card, Field, Modal, StatCard, Table, Tabs, fmtInt, toast, useFetch } from '../../components/ui'
import { FilterBar, Inp, Sel } from '../../components/DataPage'
import { useAuth } from '../../store/auth'
import { RefreshCw, Pencil, Send, Power, BellRing, Eye } from 'lucide-react'

/**
 * 消息推送（模块 24）。
 *
 * 这一页存在的理由：采购域的待办（请购待审批、订单待到货、结算待付款…）都在库里躺着，
 * 没人会为了看它专门打开系统 —— 待办必须能**主动推到人面前**才有意义。
 *
 * 三件事在这页要分得很清楚，不能含糊：
 *   ① 渠道配置 —— 一个渠道要能发出去，必须「有 webhook」且「已启用」，缺一不可。
 *      界面上「可用」这一列就是这两件事的交集，不是单独看开关。
 *   ② 消息预览 —— 配 webhook 之前先看消息长什么样。**只渲染不发送**，
 *      避免为了「看看效果」把消息真的推到了群里。
 *   ③ 推送日志 —— 发过什么、成没成、失败原因。推送是唯一「发出去就收不回」的动作，
 *      没有日志等于闭着眼睛发。
 */
export default function Notify() {
  const { is } = useAuth()
  const canManage = is('admin')
  const [tab, setTab] = useState('channels')
  const [edit, setEdit] = useState<any>(null)

  const { data: meta } = useFetch<any>('/notify/meta', undefined, [])
  const { data: ov, reload: reloadOv } = useFetch<any>('/notify/overview', undefined, [])
  const { data: chData, loading: chLoading, reload: reloadCh } = useFetch<any>('/notify/channels', undefined, [])

  const channels: any[] = chData?.list || []
  const providerLabel = (code: string) =>
    (meta?.providers || []).find((p: any) => p.code === code)?.label || code

  const reloadAll = () => {
    reloadOv()
    reloadCh()
  }

  const toggle = async (row: any) => {
    try {
      await api.post(`/notify/channels/${row.id}/toggle`)
      toast(Number(row.enabled) ? '渠道已停用' : '渠道已启用')
      reloadAll()
    } catch (e: any) {
      // 后端会挡「没配 webhook 就启用」—— 这是有意的，把原话透出来
      toast(e.message, 'error')
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">消息推送</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">
            把待办推到飞书 / 钉钉 / 企业微信。渠道必须「有 webhook + 已启用」才真正可用
          </p>
        </div>
        <button className="btn-ghost btn-sm" onClick={reloadAll}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <StatCard label="推送渠道" value={fmtInt(ov?.channels || 0)} icon={<BellRing size={15} />} sub={`可用 ${ov?.ready || 0}`} />
        <StatCard label="已启用" value={fmtInt(ov?.enabled || 0)} tone={(ov?.enabled || 0) > 0 ? 'green' : 'default'} sub={`共 ${ov?.channels || 0} 个渠道`} />
        <StatCard label="推送次数" value={fmtInt(ov?.log_total || 0)} sub={ov?.last ? `最近 ${ov.last}` : '暂无推送'} />
        <StatCard
          label="成功 / 失败"
          value={`${fmtInt(ov?.log_ok || 0)} / ${fmtInt(ov?.log_fail || 0)}`}
          tone={(ov?.log_fail || 0) > 0 ? 'red' : 'default'}
        />
      </div>

      <Tabs
        tabs={[
          { key: 'channels', label: '渠道配置', count: channels.length },
          { key: 'preview', label: '消息预览' },
          { key: 'logs', label: '推送日志', count: ov?.log_total || 0 }
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'channels' && (
        <>
          {canManage && (
            <div className="flex justify-end mb-2">
              <button className="btn-primary btn-sm" onClick={() => setEdit({ __new: true, provider: 'feishu', enabled: 0 })}>
                + 新建渠道
              </button>
            </div>
          )}
          <Card pad={false}>
            <Table
              columns={[
                { key: 'code', title: '渠道编码', width: 150 },
                { key: 'name', title: '名称', width: 170 },
                { key: 'provider', title: '类型', width: 110, render: (r) => providerLabel(r.provider) },
                {
                  key: 'webhook_url',
                  title: 'Webhook',
                  width: 220,
                  render: (r) =>
                    r.webhook_url ? (
                      <span className="font-mono text-[11px] text-ink-600" title={r.webhook_url}>
                        …{String(r.webhook_url).slice(-24)}
                      </span>
                    ) : (
                      <span className="tag bg-amber-100 text-amber-700">未配置</span>
                    )
                },
                {
                  key: 'enabled',
                  title: '启用',
                  width: 80,
                  render: (r) =>
                    Number(r.enabled) ? (
                      <span className="tag bg-green-100 text-green-700">已启用</span>
                    ) : (
                      <span className="tag bg-slate-100 text-slate-500">已停用</span>
                    )
                },
                {
                  key: 'ready',
                  title: '可用',
                  width: 130,
                  render: (r) =>
                    r.ready?.ok ? (
                      <span className="tag bg-brand-50 text-brand-700">就绪</span>
                    ) : (
                      <span className="text-[12px] text-ink-500">{r.ready?.reason || '不可用'}</span>
                    )
                },
                { key: 'event_types', title: '订阅事件', width: 150, render: (r) => r.event_types || <span className="text-ink-400">全部</span> },
                { key: 'last_push_at', title: '最近推送', width: 150, render: (r) => r.last_push_at || '—' },
                { key: 'remark', title: '备注', width: 180 },
                ...(canManage
                  ? [
                      {
                        key: '__act',
                        title: '操作',
                        width: 140,
                        render: (r: any) => (
                          <div className="flex items-center gap-2">
                            <button className="link inline-flex items-center gap-1 text-[12px]" onClick={() => setEdit(r)}>
                              <Pencil size={12} /> 编辑
                            </button>
                            <button
                              className="link inline-flex items-center gap-1 text-[12px]"
                              onClick={() => toggle(r)}
                            >
                              <Power size={12} /> {Number(r.enabled) ? '停用' : '启用'}
                            </button>
                          </div>
                        )
                      }
                    ]
                  : [])
              ]}
              data={channels}
              loading={chLoading}
              empty="暂无推送渠道"
            />
          </Card>
        </>
      )}

      {tab === 'preview' && <PreviewTab />}
      {tab === 'logs' && <LogsTab />}

      <EditModal row={edit} meta={meta} onClose={() => setEdit(null)} onSaved={reloadAll} />
    </div>
  )
}

/* ------------------------------------------------------------------ 预览 */

function PreviewTab() {
  const { is } = useAuth()
  const canPush = is('admin')
  const [provider, setProvider] = useState('feishu')
  const [kinds, setKinds] = useState<string[]>([])
  const [pushing, setPushing] = useState(false)
  const qs = kinds.length ? `&kinds=${kinds.join(',')}` : ''
  const { data, loading, reload } = useFetch<any>(`/notify/preview?provider=${provider}${qs}`, undefined, [provider, kinds.join(',')])
  const digest: any = data?.digest
  const groups: any[] = digest?.groups || []

  const dry = async () => {
    setPushing(true)
    try {
      const res: any = await api.post('/notify/push', { kinds: kinds.length ? kinds : null, dry_run: true })
      toast(`试算完成：将推送 ${res.data?.sent || 0} 条`)
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setPushing(false)
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <Card className="!mb-0">
        <div className="flex items-center justify-between mb-3">
          <div className="font-medium text-[14px] text-ink-900">待办摘要</div>
          <div className="flex items-center gap-2">
            <Sel
              value={provider}
              onChange={setProvider}
              options={[
                { value: 'feishu', label: '飞书' },
                { value: 'dingtalk', label: '钉钉' },
                { value: 'wecom', label: '企业微信' },
                { value: 'generic', label: '通用 Webhook' }
              ]}
              w={130}
            />
            <button className="btn-ghost btn-sm" onClick={reload}>
              <RefreshCw size={13} />
            </button>
            {canPush && (
              <button className="btn-ghost btn-sm" disabled={pushing} onClick={dry}>
                <Eye size={13} /> 试算
              </button>
            )}
          </div>
        </div>

        <div className="text-[12px] text-ink-500 mb-3">
          共 <b className="text-ink-800">{fmtInt(digest?.total || 0)}</b> 项待办 · 生成于 {digest?.generated_at || '—'}
        </div>

        {loading && <div className="text-[12px] text-ink-400 py-6 text-center">加载中…</div>}
        {!loading && groups.length === 0 && (
          <div className="text-[12px] text-ink-400 py-8 text-center">当前没有待办 —— 各环节都已处理完</div>
        )}

        <div className="space-y-2">
          {groups.map((g) => (
            <div key={g.kind} className="border border-slate-200 rounded-md overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-slate-50">
                <span className="text-[13px] font-medium text-ink-800">{g.label}</span>
                <span className="text-[12px] text-ink-600">
                  {g.count} 项{g.amount ? ` · ¥${fmtInt(g.amount)}` : ''}
                </span>
              </div>
              <div className="px-3 py-1.5">
                {(g.items || []).slice(0, 4).map((it: any) => (
                  <div key={it.doc_no} className="flex items-center justify-between py-1 text-[12px]">
                    <span className="font-mono text-ink-700">{it.doc_no}</span>
                    <span className="text-ink-600">{it.amount != null ? `¥${fmtInt(it.amount)}` : ''}</span>
                  </div>
                ))}
                {g.count > 4 && <div className="text-[11px] text-ink-400 py-1">…还有 {g.count - 4} 项</div>}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="!mb-0">
        <div className="font-medium text-[14px] text-ink-900 mb-3">
          消息体预览 <span className="text-[11px] text-ink-400 font-normal">（{data?.format || '—'} · 仅渲染，不发送）</span>
        </div>
        <pre className="text-[11px] leading-relaxed bg-slate-50 border border-slate-200 rounded-md p-3 overflow-auto max-h-[560px] text-ink-700">
          {data?.body ? JSON.stringify(data.body, null, 2) : '—'}
        </pre>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ 日志 */

function LogsTab() {
  const [status, setStatus] = useState('')
  const [channel, setChannel] = useState('')
  const [page, setPage] = useState(1)
  const { data, loading } = useFetch<any>('/notify/logs', {
    page,
    pageSize: 20,
    status: status || undefined,
    channel_code: channel || undefined
  })
  const list: any[] = data?.list || []

  return (
    <>
      <FilterBar onReset={() => { setStatus(''); setChannel(''); setPage(1) }}>
        <Sel
          value={status}
          onChange={(v) => { setStatus(v); setPage(1) }}
          options={[
            { value: 'ok', label: '成功' },
            { value: 'fail', label: '失败' }
          ]}
          placeholder="全部状态"
          w={140}
        />
        <Inp value={channel} onChange={(v) => { setChannel(v); setPage(1) }} placeholder="渠道编码" w={180} />
        <span className="text-[12px] text-ink-500 ml-2">共 {data?.total || 0} 条</span>
      </FilterBar>
      <Card pad={false}>
        <Table
          columns={[
            { key: 'created_at', title: '时间', width: 165 },
            { key: 'channel_code', title: '渠道', width: 150 },
            { key: 'provider', title: '类型', width: 100 },
            {
              key: 'status',
              title: '结果',
              width: 90,
              render: (r) =>
                r.status === 'ok' ? (
                  <span className="tag bg-green-100 text-green-700">成功</span>
                ) : (
                  <span className="tag bg-red-100 text-red-600">失败</span>
                )
            },
            { key: 'total', title: '待办数', width: 80, align: 'right', render: (r) => fmtInt(r.total || 0) },
            { key: 'triggered_by', title: '触发人', width: 110 },
            {
              key: 'error',
              title: '详情 / 失败原因',
              render: (r) => <span className="text-[12px] text-ink-600">{r.error || r.remark || '—'}</span>
            }
          ]}
          data={list}
          loading={loading}
          empty="暂无推送记录"
        />
      </Card>
      {data?.total > 20 && (
        <div className="flex justify-end mt-3">
          <div className="flex items-center gap-2 text-[12px]">
            <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <span className="text-ink-500">
              第 {page} / {Math.max(1, Math.ceil((data?.total || 0) / 20))} 页
            </span>
            <button
              className="btn-ghost btn-sm"
              disabled={page >= Math.ceil((data?.total || 0) / 20)}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </>
  )
}

/* ---------------------------------------------------------------- 编辑弹窗 */

function EditModal({ row, meta, onClose, onSaved }: any) {
  const [form, setForm] = useState<any>({})
  const [saving, setSaving] = useState(false)

  if (row && form.__id !== (row.id ?? '__new')) {
    setForm({
      __id: row.id ?? '__new',
      code: row.code ?? '',
      name: row.name ?? '',
      provider: row.provider ?? 'feishu',
      webhook_url: row.webhook_url ?? '',
      // 后端永远不回传密钥（ADR-0008）：留空 = 保持现有密钥；填写 = 设置/轮换；勾选清除 = 置空
      secret: '',
      clear_secret: false,
      event_types: row.event_types ?? '',
      remark: row.remark ?? ''
    })
  }

  const submit = async () => {
    if (!form.code || !form.name) return toast('渠道编码与名称必填', 'error')
    setSaving(true)
    try {
      await api.post('/notify/channels', {
        code: form.code,
        name: form.name,
        provider: form.provider,
        webhook_url: form.webhook_url || null,
        secret: form.clear_secret ? '' : form.secret || null,
        event_types: form.event_types || null,
        enabled: row.enabled ?? 0,
        remark: form.remark || null
      })
      toast('渠道已保存')
      onClose()
      onSaved()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const allKinds: string[] = meta?.kinds || []
  const picked = String(form.event_types || '').split(',').map((s) => s.trim()).filter(Boolean)

  return (
    <Modal
      open={!!row}
      title={row?.__new ? '新建推送渠道' : `编辑渠道 · ${row?.name || ''}`}
      width={640}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="渠道编码" hint="唯一标识，如 feishu-purchase">
          <input className="input" value={form.code ?? ''} disabled={!row?.__new} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </Field>
        <Field label="渠道名称">
          <input className="input" value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="渠道类型" hint="决定消息体格式：飞书为交互式卡片，其余为 Markdown">
          <select className="input" value={form.provider ?? 'feishu'} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
            {(meta?.providers || []).map((p: any) => (
              <option key={p.code} value={p.code}>{p.label}</option>
            ))}
          </select>
        </Field>
        <Field
          label="签名密钥"
          hint={row?.has_secret
            ? `已设置${row.secret_last4 ? `（…${row.secret_last4}）` : ''}；留空保持不变，填写即轮换`
            : '钉钉 / 飞书加签与通用 Webhook HMAC 用；不用留空'}
        >
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={row?.has_secret ? '••••••••（已设置，不回显）' : ''}
            disabled={!!form.clear_secret}
            value={form.secret ?? ''}
            onChange={(e) => setForm({ ...form, secret: e.target.value })}
          />
          {row?.has_secret ? (
            <label className="mt-1 flex items-center gap-1 text-[12px] text-slate-500">
              <input type="checkbox" checked={!!form.clear_secret} onChange={(e) => setForm({ ...form, clear_secret: e.target.checked, secret: '' })} />
              清除密钥
            </label>
          ) : null}
        </Field>
        <Field label="Webhook 地址" span={2} hint="留空则该渠道无法启用（后端会挡）">
          <input className="input font-mono text-[12px]" value={form.webhook_url ?? ''} onChange={(e) => setForm({ ...form, webhook_url: e.target.value })} />
        </Field>
        <Field label="订阅事件" span={2} hint="不勾选 = 订阅全部；勾选后只推选中的待办类型">
          <div className="flex flex-wrap gap-2 pt-1">
            {allKinds.map((k) => (
              <label key={k} className="inline-flex items-center gap-1.5 text-[12px] px-2 py-1 border border-slate-200 rounded cursor-pointer">
                <input
                  type="checkbox"
                  checked={picked.includes(k)}
                  onChange={(e) => {
                    const next = e.target.checked ? [...picked, k] : picked.filter((x) => x !== k)
                    setForm({ ...form, event_types: next.join(',') })
                  }}
                />
                {k}
              </label>
            ))}
          </div>
        </Field>
        <Field label="备注" span={2}>
          <input className="input" value={form.remark ?? ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
        </Field>
      </div>
      <p className="text-[12px] text-ink-500 mt-3">
        <Send size={12} className="inline -mt-0.5 mr-1" />
        保存后渠道仍是「停用」状态 —— 需要单独启用。推送是唯一发出去收不回的动作，启用必须是显式的。
      </p>
    </Modal>
  )
}
