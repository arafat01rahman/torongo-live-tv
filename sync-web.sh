#!/usr/bin/env bash
# ============================================================
# sync-web.sh — copy the web app into the Capacitor webDir.
#
# WHY THIS EXISTS
#   capacitor.config.json has "webDir": "www", but this project is
#   actually edited at the REPO ROOT (app.js, channels.js,
#   index.html, style.css). Capacitor only ever copies from www/,
#   so without this step Android Studio builds a STALE app.
#
#   There is no Vite/Webpack/React build here — the website is
#   plain static files. "Building" it just means copying 4 files.
#
# USAGE
#   ./sync-web.sh          # copy + npx cap sync android
#   ./sync-web.sh --copy   # copy only (no cap sync)
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"

FILES=(index.html style.css app.js channels.js)

echo "==> Copying web sources to www/"
for f in "${FILES[@]}"; do
    if [[ ! -f "$f" ]]; then
        echo "ERROR: missing source file: $f" >&2
        exit 1
    fi
    cp -f "$f" "www/$f"
    echo "    $f"
done

if [[ "${1:-}" == "--copy" ]]; then
    echo "==> Done (copy only)."
    exit 0
fi

echo "==> Running Capacitor sync (updates android/)"
if command -v npx >/dev/null 2>&1; then
    npx cap sync android
else
    echo "WARN: npx not found — skipped 'cap sync'." >&2
    echo "      Manually copy www/ into android/app/src/main/assets/public/" >&2
    echo "      (keep index.html, style.css, app.js, channels.js in sync)." >&2
fi

echo "==> Web assets are now in sync. Continue in Android Studio."
