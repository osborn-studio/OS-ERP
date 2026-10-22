/**
 * ============================================================================
 * 文件标识：vite.config.ts ｜ 前端构建配置（开发代理 + 产物输出）
 * ============================================================================
 * 【职责】开发态把 `/api`、`/mcp` 代理到后端；构建产物输出到 `dist/`（由 Express 静态托管）。
 *
 * 【为什么要写清楚代理】
 *   开发时前端跑在 Vite 端口、后端在 3001。**漏挂一个前缀**（例如 `/mcp`）的表现是
 *   "页面上 AI 功能全 404，但打包后正常" —— 只在开发环境错，最难查。
 *   ⇒ 后端新增顶级路径（`/api` 之外）时，**这里必须同步加一条代理**。
 * ============================================================================
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500
  }
})
