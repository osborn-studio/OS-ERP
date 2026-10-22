#!/usr/bin/env bash
# 使用安全打包入口；保留既有 release 产物与本机数据库。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec node scripts/package-release.mjs "$@"
