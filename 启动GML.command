#!/bin/zsh
# 双击本文件即可启动 GML 供应链系统（在终端窗口中运行，关闭窗口即停止服务）
cd "$(dirname "$0")" || exit 1
clear
echo "=============================================="
echo "  GML 供应链协同系统 · 启动中"
echo "  启动完成后浏览器访问： http://localhost:3001"
echo "  停止服务：在本窗口按 Control + C，或直接关闭窗口"
echo "=============================================="
echo ""
exec ./scripts/serve.sh
