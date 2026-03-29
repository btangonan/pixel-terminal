#!/bin/bash
cd "$(dirname "$0")"

# Kill any running instance before launching
pkill -f "pixel-terminal" 2>/dev/null
pkill -f "tauri dev" 2>/dev/null
pkill -f "cargo.*pixel" 2>/dev/null
sleep 0.5

# Start OmiWebhook (cloud path) in a new terminal tab
osascript <<'EOF'
tell application "Terminal"
  do script "cd ~/Projects/OmiWebhook && ./start.sh"
end tell
EOF

# Start pixel_voice_bridge (local mic, always-on) in a new terminal tab
osascript <<'EOF'
tell application "Terminal"
  do script "cd ~/Projects/OmiWebhook && source venv/bin/activate && python3 pixel_voice_bridge.py --ble"
end tell
EOF

npm run tauri dev
