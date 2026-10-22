#!/bin/sh
# Runs the Expo web dev server against the bind-mounted source tree.
set -eu

# node_modules lives in a volume, so a lockfile change needs an in-place install.
# The image records the lockfile it was built with; matching stamps start instantly.
lock=$(sha256sum /app/package-lock.json | cut -d' ' -f1)
installed=$(cat /app/node_modules/.matrius-lock 2>/dev/null || true)
if [ "$installed" != "$lock" ]; then
  echo 'Installing npm dependencies for the mounted package-lock.json...'
  CI=1 npm ci --no-audit --no-fund
  printf '%s\n' "$lock" > /app/node_modules/.matrius-lock
fi

# Generated assets are excluded from source sync, so keep them in the writable
# volume mounted over the read-only tree.
node /app/scripts/sync-katex.mjs

# No TTY keeps Expo non-interactive and stops it from opening a browser. CI must
# stay unset here, otherwise Expo disables Metro's watcher and edits stop applying.
exec /app/node_modules/.bin/expo start --web --offline
