#!/usr/bin/env python3
"""Embed the bundled fonts into the theme: theme/Ambient/user.src.css -> theme/Ambient/user.css."""
import base64
from pathlib import Path

theme = Path(__file__).resolve().parent.parent / "theme" / "Ambient"
css = (theme / "user.src.css").read_text()
for font in sorted((theme / "fonts").glob("*.woff2")):
    css = css.replace("{{%s}}" % font.stem, base64.b64encode(font.read_bytes()).decode())
if "{{" in css:
    raise SystemExit("A font placeholder in user.src.css has no matching file in theme/Ambient/fonts/")
(theme / "user.css").write_text(css)
print(f"Built {theme / 'user.css'}")
