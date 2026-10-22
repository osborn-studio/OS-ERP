#!/bin/zsh
# GML 供应链 · 停止服务
LABEL="com.gml.serve"
PORT=3001

/bin/launchctl remove "$LABEL" >/dev/null 2>&1
PIDS="$(/usr/sbin/lsof -ti:$PORT 2>/dev/null)"
if [ -n "$PIDS" ]; then
  echo "$PIDS" | while read -r p; do /bin/kill "$p" 2>/dev/null; done
  /bin/sleep 1
fi

if /usr/sbin/lsof -ti:$PORT >/dev/null 2>&1; then
  MSG="端口 $PORT 仍被占用，可能有其他程序在跑"
else
  MSG="GML 服务已停止"
fi
/usr/bin/osascript -e "display notification \"$MSG\" with title \"GML 供应链\"" >/dev/null 2>&1
