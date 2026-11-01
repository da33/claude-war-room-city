#!/bin/zsh
# Double-click on a Mac: start the city (unless it's already running) and open it in the browser.
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PAGE="http://localhost:${PORT:-5177}/"

if ! command -v node >/dev/null; then
  echo "找不到 Node.js。請到 https://nodejs.org 下載安裝 LTS 版，裝好再雙擊一次。"
  read -k1 "?按任意鍵關閉…"
  exit 1
fi
if curl -s -o /dev/null --max-time 1 "${PAGE}api/state"; then
  open "$PAGE" # already running (for example from the menu bar app)
  exit 0
fi
echo "戰情城啟動中…　不用時，關掉這個視窗就會停止。"
exec node server.js --open
