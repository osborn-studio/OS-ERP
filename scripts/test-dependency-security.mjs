/**
 * ============================================================================
 * 文件标识：scripts/test-dependency-security.mjs | 依赖补丁与解析兼容性回归。
 * ============================================================================
 * 保留 braces 无官方修复这一事实，不将“告警被隐藏”视为修复。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { zipSync, unzipSync } from 'fflate'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { Routes, Route, Link, useParams } from 'react-router-dom'
import { StaticRouter } from 'react-router'
import selectorParser from 'postcss-selector-parser'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
let passed = 0
function verify(name, action) { action(); passed++; console.log(`PASS ${name}`) }
for (const [name, version] of Object.entries({ vite: '6.4.5', 'react-router': '7.18.4', 'react-router-dom': '7.18.4', fflate: '0.8.3', 'postcss-selector-parser': '7.1.7' })) {
  verify(`patched ${name}`, () => {
    const matches = Object.entries(lock.packages).filter(([key]) => key.endsWith(`/node_modules/${name}`) || key === `node_modules/${name}`)
    assert.ok(matches.length > 0)
    for (const [, entry] of matches) assert.equal(entry.version, version)
  })
}
verify('esbuild contains the development-server security fix', () => {
  const version = lock.packages['node_modules/esbuild'].version.split('.').map(Number)
  assert.ok(version[0] > 0 || version[1] >= 25)
})
verify('Unicode ZIP filenames and payloads round-trip', () => {
  const files = { '手册/安装说明.txt': Buffer.from('安装与演示资料'), 'code/main.js': Buffer.from('export const ok = true') }
  const archive = unzipSync(zipSync(files))
  assert.deepEqual(Object.keys(archive).sort(), Object.keys(files).sort())
  for (const name of Object.keys(files)) assert.deepEqual(Buffer.from(archive[name]), files[name])
})
verify('malformed ZIP64 terminates instead of looping indefinitely', () => {
  const archive = Buffer.from(zipSync({ 'probe.txt': new Uint8Array([1, 2, 3]) }))
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  assert.ok(central >= 0)
  archive.writeUInt32LE(0xffffffff, central + 20)
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import {unzipSync} from 'fflate'; try { unzipSync(Buffer.from(process.argv[1], 'base64')) } catch {}", archive.toString('base64')],
  { cwd: root, timeout: 2000, encoding: 'utf8' })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0)
})
for (const entry of ['/order-center', '/sales/orders/12', '/pos', '/mall']) {
  verify(`React Router matches ${entry}`, () => {
    function Detail() { return React.createElement('span', null, `order-${useParams().id}`) }
    const page = React.createElement(StaticRouter, { location: entry },
      React.createElement(Routes, null,
        React.createElement(Route, { path: '/sales/orders/:id', element: React.createElement(Detail) }),
        React.createElement(Route, { path: '*', element: React.createElement(Link, { to: '/sales/orders/12' }, 'order-list') })))
    const html = renderToString(page)
    assert.ok(html.includes(entry.startsWith('/sales/orders/') ? 'order-12' : 'order-list'))
  })
}
verify('selector parser retains Tailwind escaped selectors', () => {
  const selectors = '.sm\\:grid-cols-2:hover,.text-\\[12px\\],.bg-brand-700,.group:hover .group-hover\\:text-white'
  const parsed = selectorParser().astSync(selectors)
  assert.equal(parsed.nodes.length, 4)
  assert.equal(parsed.toString(), selectors)
})
verify('development server explicitly binds loopback', () => {
  assert.match(fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8'), /host:\s*'127\.0\.0\.1'/)
})
console.log(`依赖安全回归：通过 ${passed} / 失败 0`)
