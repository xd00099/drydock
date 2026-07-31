#!/bin/sh
# Local .app build. Signs with the machine's Apple code-signing identity when
# one exists, so macOS permission grants (TCC keys them to the signature)
# survive rebuilds — an ad-hoc signature changes every build and resets them.
# Extra args pass through, e.g.:
#   scripts/build-app.sh --config src-tauri/tauri.dev.conf.json   # Drydock Dev
set -e
cd "$(dirname "$0")/.."
identity=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(.*\)"/\1/p' | head -1)
if [ -n "$identity" ]; then
  export APPLE_SIGNING_IDENTITY="$identity"
  echo "signing as: $identity"
else
  echo "no code-signing identity found — building ad-hoc (permission grants will reset)"
fi
exec npx tauri build "$@"
