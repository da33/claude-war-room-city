#!/bin/zsh
# Build the menu bar app "Claude 戰情城.app" into ~/Applications and (re)start it.
set -e
HERE=${0:A:h}
ROOT=${HERE:h}
APP="$HOME/Applications/Claude 戰情城.app"

if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "需要先安裝 Xcode Command Line Tools：在終端機輸入 xcode-select --install，裝好再執行一次。"
  exit 1
fi

pkill -TERM -f "$APP/Contents/MacOS/WarRoom" 2>/dev/null && sleep 1 || true # replace a running copy
mkdir -p "$APP/Contents/MacOS"
xcrun swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/WarRoom" "$HERE/WarRoom.swift"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>WarRoom</string>
  <key>CFBundleIdentifier</key><string>tw.rino.claude-warroom</string>
  <key>CFBundleName</key><string>Claude 戰情城</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>tw.rino.claude-warroom</string>
    <key>CFBundleURLSchemes</key><array><string>claude-warroom</string></array>
  </dict></array>
  <key>WarRoomProjectDir</key><string>$ROOT</string>
</dict>
</plist>
EOF

codesign --force --sign - "$APP"
open "$APP"
echo "Installed and started: $APP"
