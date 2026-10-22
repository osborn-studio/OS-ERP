/**
 * ============================================================================
 * 文件标识：src/main.tsx ｜ 前端入口：挂载 React 根节点、装路由与全局样式
 * ============================================================================
 * 【职责】前端入口：挂载 React 根节点、装路由与全局样式
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './store/auth'
import { RuntimeCapabilitiesProvider } from './store/runtime-capabilities'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <RuntimeCapabilitiesProvider><App /></RuntimeCapabilitiesProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
)
