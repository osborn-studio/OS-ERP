#!/usr/bin/env bash
# 本地安装统一入口，不重建数据、不停止其他服务。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node scripts/local-manage.mjs setup
exec node scripts/local-manage.mjs start
