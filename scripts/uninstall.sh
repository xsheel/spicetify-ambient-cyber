#!/usr/bin/env bash
# Removes the desktop glow app, the theme files and the extension, and restores stock Spotify.
set -uo pipefail
launchctl bootout "gui/$(id -u)/local.ambient.glow" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/local.ambient.glow.plist"
rm -rf "$HOME/Applications/Ambient Glow.app"
if command -v spicetify >/dev/null; then
  CFG="$(dirname "$(spicetify -c)")"
  spicetify config extensions ambient-edge.js- >/dev/null 2>&1
  rm -rf "$CFG/Themes/Ambient" "$CFG/Extensions/ambient-edge.js"
  spicetify restore
fi
echo "Uninstalled. Spotify is back to its original look."
