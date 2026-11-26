#!/usr/bin/env bash
# Installs the Ambient Cyber theme + edge-lights extension into Spicetify.
# Usage: scripts/install.sh [--with-glow]    (--with-glow also installs the macOS desktop glow app)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v spicetify >/dev/null || { echo "Spicetify is not installed. See https://spicetify.app (macOS: brew install spicetify-cli)"; exit 1; }
CFG="$(dirname "$(spicetify -c)")"

python3 "$ROOT/scripts/build-theme.py"
mkdir -p "$CFG/Themes/Ambient" "$CFG/Extensions"
cp "$ROOT/theme/Ambient/color.ini" "$ROOT/theme/Ambient/user.css" "$CFG/Themes/Ambient/"
cp "$ROOT/extension/ambient-edge.js" "$CFG/Extensions/"

spicetify config current_theme Ambient color_scheme Base inject_css 1 replace_colors 1 extensions ambient-edge.js
# first run needs a backup; later runs just re-apply
spicetify backup apply 2>/dev/null || spicetify apply

if [[ "${1:-}" == "--with-glow" ]]; then
  "$ROOT/scripts/install-glow.sh"
fi
echo "Done. If Spotify updates and the theme disappears, run: spicetify backup apply"
