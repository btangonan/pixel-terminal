#!/bin/bash
cd "$(dirname "$0")"
MY_PID=$$

# Kill any running instance before launching (exclude this script's own process tree)
pgrep -f "target/.*/pixel-terminal" | grep -v "$MY_PID" | xargs kill 2>/dev/null
pgrep -f "tauri dev" | grep -v "$MY_PID" | xargs kill 2>/dev/null
pgrep -f "cargo.*pixel" | grep -v "$MY_PID" | xargs kill 2>/dev/null
pkill -f "pixel_voice_bridge" 2>/dev/null   # kill zombie bridge processes holding BLE slot
pkill -f "OmiWebhook" 2>/dev/null
pkill -f "vexil_master.py" 2>/dev/null
sleep 0.5

# Close ALL Terminal windows/tabs from previous pixel-terminal launches.
# Matches by process name (running) OR tab history/title (dead shells).
osascript <<'CLOSE'
tell application "Terminal"
  set windowCount to count of windows
  repeat with w from windowCount to 1 by -1
    try
      set tabCount to count of tabs of window w
      repeat with t from tabCount to 1 by -1
        try
          set tabProcs to (processes of tab t of window w) as text
          set tabHist to (history of tab t of window w) as text
          if tabProcs contains "OmiWebhook" or tabProcs contains "pixel_voice_bridge" or tabProcs contains "start.sh" or tabProcs contains "tauri" or tabProcs contains "cargo" or tabHist contains "pixel_voice_bridge" or tabHist contains "OmiWebhook" or tabHist contains "tauri dev" or tabHist contains "pixel-terminal" then
            close tab t of window w
          end if
        end try
      end repeat
      -- If window has no tabs left, close it
      if (count of tabs of window w) = 0 then close window w
    end try
  end repeat
end tell
CLOSE
sleep 0.2

# Start OmiWebhook (cloud path) in a new terminal tab
osascript <<'EOF'
tell application "Terminal"
  do script "cd ~/Projects/OmiWebhook && ./start.sh"
end tell
EOF

# Start pixel_voice_bridge (Mac mic default) — waits for pixel-terminal ws_bridge (port 9876)
osascript <<'EOF'
tell application "Terminal"
  do script "cd ~/Projects/OmiWebhook && source venv/bin/activate && echo 'Waiting for pixel-terminal (port 9876)...' && while ! nc -z 127.0.0.1 9876 2>/dev/null; do sleep 1; done && echo 'pixel-terminal ready — starting voice bridge (mic)' && python3 pixel_voice_bridge.py"
end tell
EOF

# Check for duplicate ES module exports before launching
DUPE_EXPORTS=$(node --input-type=module <<'NODEEOF'
import { readFileSync } from 'fs';
const files = ['src/session.js','src/cards.js','src/history.js','src/app.js','src/companion.js','src/voice.js','src/session-lifecycle.js','src/messages.js','src/events.js'];
let found = false;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const inline = [...src.matchAll(/^export (?:function|const|class|let|var)\s+(\w+)/gm)].map(m=>m[1]);
  const block  = [...src.matchAll(/^export \{([^}]+)\}/gm)].flatMap(m=>m[1].split(',').map(s=>s.trim().split(/\s+as\s+/)[0].trim()));
  const all = [...inline, ...block];
  const dupes = all.filter((v,i)=>all.indexOf(v)!==i);
  if (dupes.length) { console.log(`DUPLICATE EXPORT in ${f}: ${dupes.join(', ')}`); found = true; }
}
if (!found) console.log('ok');
NODEEOF
)
if [[ "$DUPE_EXPORTS" != "ok" ]]; then
  echo "⛔ LAUNCH BLOCKED — duplicate exports detected:"
  echo "$DUPE_EXPORTS"
  echo "Fix before launching."
  exit 1
fi

# Print JS fingerprint so we can confirm new code is loaded
JS_HASH=$(cat src/companion.js src/voice.js src/session-lifecycle.js src/session.js src/cards.js src/history.js src/app.js src/index.html src/styles.css | shasum -a 256 | cut -c1-8)
echo "┌─────────────────────────────────────┐"
echo "│ pixel-terminal launching            │"
echo "│ JS fingerprint: $JS_HASH            │"
echo "└─────────────────────────────────────┘"

# Open a dedicated log tail window
LOG_FILE="/tmp/pixel-terminal.log"
: > "$LOG_FILE"   # truncate on each launch
osascript <<EOF
tell application "Terminal"
  do script "echo '── pixel-terminal log ──' && tail -f $LOG_FILE"
end tell
EOF

# Wipe event feeds from last run (fresh slate per launch)
rm -f ~/.local/share/pixel-terminal/vexil_feed.jsonl \
      ~/.local/share/pixel-terminal/vexil_master_out.jsonl \
      ~/.local/share/pixel-terminal/oracle_query.json

# Clear WebKit network cache so HTML/CSS changes land without a manual wipe
# ~/Library/WebKit/pixel-terminal = LocalStorage only (keep it)
# ~/Library/Caches/pixel-terminal = NetworkCache = actual page cache (clear this)
rm -rf ~/Library/Caches/pixel-terminal/WebKit/NetworkCache

# Source shell profiles so PATH includes the claude CLI for the Vexil Master daemon.
# .command files launched from Finder don't source .zshrc — only login shells.
# shellcheck disable=SC1090
source ~/.zprofile 2>/dev/null || true
source ~/.zshrc    2>/dev/null || true

# Note: buddy.json sync now runs inside the app via invoke('sync_buddy') — Rust port of sync_real_buddy.ts
# Note: Vexil Master daemon now runs inside the app as a tokio task — Rust port of vexil_master.py

npm run tauri dev 2>&1 | tee -a "$LOG_FILE"
