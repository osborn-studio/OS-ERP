/**
 * ============================================================================
 * 文件标识：src/pages/oms/Qimen.tsx ｜ 奇门对接中心
 * ============================================================================
 * 【职责】奇门对接中心（页面）
 * 【入口】/oms/qimen
 * 【主要接口】/qimen/capabilities
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
 * 页面：奇门对接中心
 */

import { useState } from 'react'
import { RefreshCw, Plug, Play, Globe2 } from 'lucide-react'
import { getIndustry } from '../../api/client'
import { Card, Table, useFetch, toast } from '../../components/ui'

const METHODS_SAMPLE: Record<string, any> = {
  'taobao.qimen.itemmapping.query': { itemCode: 'SP10001-01' },
  'taobao.qimen.inventory.query': { itemCodes: ['SP10001-01', 'SP10013-01'] },
  'taobao.qimen.deliveryorder.create': {
    deliveryOrder: {
      deliveryOrderCode: 'GML-OUT-TEST1', orderType: 'JYCK', warehouseCode: 'WH03', orderSourceCode: 'TB2610123456',
      orderLines: [{ itemCode: 'SP10001-01', planQty: 1 }]
    }
  },
  'taobao.qimen.deliveryorder.confirm': {
    deliveryOrder: { deliveryOrderCode: 'GML-OUT-TEST1', logisticsCode: 'SF', expressCode: 'SF1390001122334', orderLines: [{ itemCode: 'SP10001-01', actualQty: 1 }] }
  },
  'taobao.qimen.entryorder.create': {
    entryOrder: { entryOrderCode: 'PR20261020001', orderType: 'PURCHASE', warehouseCode: 'WH01', orderLines: [{ itemCode: 'SP10013-01', planQty: 100, batchCode: 'B20261001' }] }
  },
  'taobao.qimen.entryorder.confirm': {
    entryOrder: { entryOrderCode: 'PR20261020001', orderLines: [{ itemCode: 'SP10013-01', actualQty: 98, defectQty: 2 }] }
  },
  'taobao.qimen.returnorder.create': {
    returnOrder: { returnOrderCode: 'RT20261020001', orderType: 'RETURN', orderLines: [{ itemCode: 'SP10008-01', qty: 1 }] }
  },
  'taobao.qimen.stock.change.report': {
    warehouseCode: 'WH03', items: [{ itemCode: 'SP10001-01', changeQty: 50, orderType: 'PURCHASE' }]
  }
}

export default function Qimen() {
  const cap = useFetch<any>('/qimen/capabilities')
  const [method, setMethod] = useState('taobao.qimen.itemmapping.query')
  const [appKey, setAppKey] = useState('')
  const [sign, setSign] = useState('')
  const [reqBody, setReqBody] = useState(JSON.stringify(METHODS_SAMPLE['taobao.qimen.itemmapping.query'], null, 2))
  const [sending, setSending] = useState(false)
  const [resp, setResp] = useState<any>(null)

  const pickMethod = (m: string) => {
    setMethod(m)
    setReqBody(JSON.stringify(METHODS_SAMPLE[m] || {}, null, 2))
    setResp(null)
  }

  const send = async () => {
    setSending(true)
    try {
      let request: any
      try {
        request = JSON.parse(reqBody)
      } catch {
        return toast('请求体不是合法 JSON', 'error')
      }
      // 网关自鉴权（app_key + sign，缺一即 401）。这里**不带**后台登录令牌：
      // 网关的 401 是协议鉴权失败，不是后台会话失效，走 api 客户端会把当前登录误判为过期并登出。
      const body: any = { method, request }
      if (appKey) body.app_key = appKey
      if (sign) body.sign = sign
      const industry = getIndustry()
      const res = await fetch('/api/qimen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(industry ? { 'x-industry': industry } : {}) },
        body: JSON.stringify(body),
        redirect: 'error',
        credentials: 'same-origin'
      })
      let data: any
      try { data = await res.json() } catch { data = { success: false, message: `返回数据格式异常 (${res.status})` } }
      setResp({ httpStatus: res.status, ...data })
    } catch (e: any) {
      setResp({ success: false, message: e.message })
    } finally {
      setSending(false)
    }
  }

  const methods = cap.data?.methods || []

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="text-[17px] font-medium text-ink-900 title-serif">奇门对接中心</h1>
          <p className="text-[12px] text-slate-400 mt-0.5">
            {cap.data?.protocol || '奇门标准化协议'} · 网关 <code className="font-mono">POST /api/qimen</code> · 对接淘宝 / 天猫 / 京东 / 抖音 / 拼多多 / 快手等主流平台
          </p>
        </div>
        <button className="btn-ghost btn-sm" onClick={() => cap.reload()}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      <Card className="mb-3" pad>
        <div className="flex items-start gap-2 text-[12px] text-slate-600 leading-5">
          <Plug size={14} className="text-brand-700 mt-0.5 shrink-0" />
          <div>
            <b className="text-ink-900">签名规则</b>：{cap.data?.signRule}
            <br />
            <b className="text-ink-900">报文格式</b>：<code className="font-mono">{'{ method, app_key, sign, request }'}</code>，响应统一 <code className="font-mono">{'{ success, code, message, ...data }'}</code>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <Card pad className="col-span-2">
          <div className="text-[13px] font-medium text-ink-900 mb-2.5 flex items-center gap-1.5">
            <Globe2 size={14} className="text-brand-700" /> 平台适配配置（主流平台编码）
          </div>
          <Table
            columns={[
              { key: 'name', title: '平台', width: 110 },
              { key: 'platform_code', title: '奇门编码', width: 90, render: (r: any) => <span className="font-mono text-[11px] text-brand-700">{r.platform_code || '—'}</span> },
              { key: 'shop_name', title: '店铺', width: 150, render: (r: any) => r.shop_name || '—' },
              { key: 'adapter', title: '适配方式', width: 90, render: (r: any) => (
                <span className={`px-1.5 py-0.5 rounded text-[11px] ${r.adapter === 'qimen' ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500'}`}>
                  {r.adapter === 'qimen' ? '奇门标准' : r.adapter === 'direct' ? '直连 API' : r.adapter}
                </span>
              ) },
              { key: 'app_key', title: 'AppKey', width: 140, render: (r: any) => <span className="font-mono text-[11px]">{r.app_key || '—'}</span> },
              { key: 'qimen_wh', title: '奇门仓编', width: 90, render: (r: any) => <span className="font-mono text-[11px]">{r.qimen_wh || '—'}</span> },
              { key: 'warehouse_name', title: '发货仓', render: (r: any) => r.warehouse_name || '—' }
            ]}
            data={cap.data?.platforms || []}
            loading={cap.loading}
          />
        </Card>
        <Card pad>
          <div className="text-[13px] font-medium text-ink-900 mb-2.5">主流平台编码对照</div>
          <div className="grid grid-cols-2 gap-1.5 text-[12px]">
            {(cap.data?.platformCodes || []).map((p: any) => (
              <div key={p.code + p.name} className="flex items-center gap-1.5">
                <span className="font-mono text-[11px] px-1 py-0.5 rounded bg-brand-50 text-brand-700">{p.code}</span>
                <span className="text-slate-600">{p.name}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card pad={false}>
          <div className="px-3 py-2 text-[13px] font-medium text-ink-900 border-b border-ink-300">支持的标准接口（{methods.length} 个）</div>
          <div className="max-h-[480px] overflow-y-auto">
            <Table
              columns={[
                { key: 'method', title: 'method', width: 300, render: (r: any) => (
                  <button className={`text-left font-mono text-[11px] w-full ${method === r.method ? 'text-brand-700 font-medium' : 'text-slate-600 hover:text-brand-700'}`} onClick={() => pickMethod(r.method)}>
                    {r.method}
                  </button>
                ) },
                { key: 'name', title: '说明', render: (r: any) => (
                  <div className="text-[12px]">
                    <span className="text-ink-900">{r.name}</span>
                    <span className="text-slate-400 ml-1.5">{r.direction}</span>
                  </div>
                ) }
              ]}
              data={methods}
              loading={cap.loading}
            />
          </div>
        </Card>

        <Card pad={false}>
          <div className="px-3 py-2 text-[13px] font-medium text-ink-900 border-b border-ink-300 flex items-center justify-between">
            <span>联调调试台</span>
            <button className="btn-primary btn-sm" disabled={sending} onClick={send}>
              <Play size={12} /> 发送请求
            </button>
          </div>
          <div className="p-3 space-y-2.5">
            <div>
              <div className="text-[11px] text-slate-400 mb-1">method</div>
              <select className="input font-mono text-[12px]" value={method} onChange={(e) => pickMethod(e.target.value)}>
                {methods.map((m: any) => <option key={m.method} value={m.method}>{m.method}</option>)}
              </select>
            </div>
            <div>
              <div className="text-[11px] text-slate-400 mb-1">app_key（必填，从左侧平台列表复制；缺失或错误网关返回 401）</div>
              <input className="input font-mono text-[12px]" value={appKey} placeholder="ak_xxx" onChange={(e) => setAppKey(e.target.value)} />
            </div>
            <div>
              <div className="text-[11px] text-slate-400 mb-1">sign（必填：MD5(app_key + method + 演示 secret)，大写十六进制）</div>
              <input className="input font-mono text-[12px]" value={sign} placeholder="32 位大写 MD5" onChange={(e) => setSign(e.target.value.trim())} />
            </div>
            <div>
              <div className="text-[11px] text-slate-400 mb-1">request 报文（JSON）</div>
              <textarea className="input font-mono text-[12px] h-56" value={reqBody} onChange={(e) => setReqBody(e.target.value)} spellCheck={false} />
            </div>
            {resp && (
              <div>
                <div className="text-[11px] text-slate-400 mb-1">响应（{resp.success ? <span className="text-emerald-600">success</span> : <span className="text-red-500">failure · {resp.code}</span>}）</div>
                <pre className="p-2.5 rounded-md bg-ink-900 text-[11px] text-emerald-200 overflow-auto max-h-52 leading-4 font-mono">{JSON.stringify(resp, null, 2)}</pre>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
