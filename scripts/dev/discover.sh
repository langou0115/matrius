#!/usr/bin/env bash
# Read runtime metadata without changing containers or persisting credentials locally.
set -euo pipefail
printf '{"infrastructure":'
docker inspect matrius-postgres matrius-redis matrius-rustfs matrius-openserp
printf ',"api":'
if metadata=$(docker inspect matrius-api 2>/dev/null); then
  printf '%s' "$metadata"
else
  printf '[]'
fi
printf ',"releases":'
# docker cp also works when the production API container is stopped.
if releases=$(docker cp matrius-api:/app/releases/features.json - 2>/dev/null | tar -xO 2>/dev/null); then
  printf '%s' "$releases"
else
  printf '[]'
fi
printf '}\n'
