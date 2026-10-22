#!/bin/zsh
# GML 供应链 · 一键启动器
# 已在运行 → 直接开浏览器；未运行 → 三级启动尝试 → 等就绪 → 开浏览器
PORT=3001
URL="http://localhost:$PORT"
APP_DIR="$HOME/工作文档/gml"
LABEL="com.gml.serve"

is_up() { /usr/bin/curl -s -o /dev/null --max-time 2 "$URL" }

wait_up() { # $1 = 最多等待秒数
  local n=$(( $1 * 2 ))
  for i in $(seq 1 $n); do
    is_up && return 0
    /bin/sleep 0.5
  done
  return 1
}

# 1) 已在运行：直接打开
if is_up; then /usr/bin/open "$URL"; exit 0; fi

cd "$APP_DIR" || exit 1

# 2) 首选：交给 launchd 托管（最持久，启动器关闭也不受影响）
/bin/launchctl remove "$LABEL" >/dev/null 2>&1
/bin/launchctl submit -l "$LABEL" -- /bin/sh "$APP_DIR/scripts/serve.sh" >/dev/null 2>&1
wait_up 4 && { /usr/bin/open "$URL"; exit 0; }

# 3) 次选：nohup 后台启动（孤儿进程由 launchd 收养，无窗口）
/usr/bin/nohup /bin/sh "$APP_DIR/scripts/serve.sh" >> "$APP_DIR/data/server.log" 2>&1 &
/bin/sleep 0.3
wait_up 10 && { /usr/bin/open "$URL"; exit 0; }

# 4) 兜底：用终端窗口启动（可见、可长驻）
/usr/bin/osascript -e "tell application \"Terminal\" to do script \"cd '$APP_DIR' && ./scripts/serve.sh\"" >/dev/null 2>&1
wait_up 15 && { /usr/bin/open "$URL"; exit 0; }

/usr/bin/osascript -e 'display alert "GML 启动失败" message "服务未能在 30 秒内就绪，请查看 data/server.log" as critical' >/dev/null 2>&1
exit 1
