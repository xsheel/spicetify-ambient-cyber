#!/usr/bin/env bash
# Builds "Ambient Glow.app" (macOS only) — paints a music-synced glow on the desktop around the Spotify window —
# installs it to ~/Applications and starts it at login via a LaunchAgent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ "$(uname)" == "Darwin" ]] || { echo "The desktop glow app is macOS-only."; exit 1; }
command -v swiftc >/dev/null || { echo "swiftc not found. Install the Xcode Command Line Tools: xcode-select --install"; exit 1; }

APP="$HOME/Applications/Ambient Glow.app"
AGENT="$HOME/Library/LaunchAgents/local.ambient.glow.plist"
mkdir -p "$APP/Contents/MacOS" "$HOME/Library/LaunchAgents"
swiftc -O -o "$APP/Contents/MacOS/AmbientGlow" "$ROOT/glow-app/main.swift"
cp "$ROOT/glow-app/Info.plist" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.ambient.glow</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/AmbientGlow</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/local.ambient.glow" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"
echo "Ambient Glow installed and running (starts at login)."
