#!/bin/sh
# GML 服务启动包装脚本（供 launchd / 手动调用）
# 作用：动态定位可用的 node（优先系统 node，其次 WorkBuddy 托管 node），再启动后端。
set -e
cd "$(dirname "$0")/.."

NODE_BIN=""
for c in "${GML_NODE:-}" /usr/local/bin/node /opt/homebrew/bin/node \
         "$HOME/.workbuddy/binaries/node/versions/"22.*/bin/node; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE_BIN="$c"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "[gml] 未找到可用的 node，请安装 Node 18+ 或设置 GML_NODE" >&2
  exit 1
fi

echo "[gml] 使用 node：$NODE_BIN"
exec "$NODE_BIN" server/index.js
