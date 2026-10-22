#!/bin/sh
# 生成并安装 macOS 一键启动 / 停止应用（安装到 ~/Applications，可拖进 Dock）
# 用法：sh scripts/install-macos-app.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Applications"
mkdir -p "$DEST"

build_app() { # $1=应用名 $2=可执行名 $3=源脚本 $4=bundleId
  APP="$DEST/$1.app"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp "$3" "$APP/Contents/MacOS/$2"
  chmod +x "$APP/Contents/MacOS/$2"
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$1</string>
  <key>CFBundleDisplayName</key><string>$1</string>
  <key>CFBundleIdentifier</key><string>$4</string>
  <key>CFBundleExecutable</key><string>$2</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
  if [ -f "$ROOT/docs/appicon.icns" ]; then
    cp "$ROOT/docs/appicon.icns" "$APP/Contents/Resources/AppIcon.icns"
  fi
  xattr -cr "$APP" 2>/dev/null || true
  echo "[ok] 已生成 $APP"
}

build_app "GML 供应链" "GML" "$ROOT/scripts/macos/GML-launcher.sh" "com.osborn.gml.launcher"
build_app "GML 停止服务" "GMLStop" "$ROOT/scripts/macos/GML-stopper.sh" "com.osborn.gml.stopper"

LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREG" ] && "$LSREG" -f "$DEST/GML 供应链.app" 2>/dev/null || true
[ -x "$LSREG" ] && "$LSREG" -f "$DEST/GML 停止服务.app" 2>/dev/null || true

echo ""
echo "完成。可执行："
echo "  双击 ~/Applications/GML 供应链.app   → 启动服务并自动打开浏览器"
echo "  双击 ~/Applications/GML 停止服务.app → 停止服务"
echo "  建议把「GML 供应链」拖到 Dock，或用 Spotlight(⌘Space) 输入 GML 直接启动"
