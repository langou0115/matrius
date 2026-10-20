#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: %s [--validate] <env-file>\n' "$0" >&2
  exit 2
}

load_env() {
  local file=$1 line key value
  [[ -f $file ]] || fail "Missing environment file: $file"
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*# ]] && continue
    [[ $line =~ ^[[:space:]]*$ ]] && continue
    [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    if [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]]; then
      value=${BASH_REMATCH[1]}
    fi
    declare -g "$key=$value"
  done < "$file"
}

validate_port() {
  local name=$1 value=$2
  [[ $value =~ ^[1-9][0-9]{0,4}$ ]] && (( value <= 65535 )) \
    || fail "$name must be a valid TCP port."
}

validate_config() {
  local env_file=$1
  load_env "$env_file"

  APP_PORT=${APP_PORT:-8081}
  APP_BIND=${APP_BIND:-0.0.0.0}
  APP_HTTPS_PORT=${APP_HTTPS_PORT:-8443}
  CADDY_SITE_ADDRESS=${CADDY_SITE_ADDRESS:-:80}

  validate_port APP_PORT "$APP_PORT"
  validate_port APP_HTTPS_PORT "$APP_HTTPS_PORT"
  [[ $APP_BIND == 0.0.0.0 || $APP_BIND == 127.0.0.1 ]] \
    || fail 'APP_BIND must be 0.0.0.0 or 127.0.0.1.'
  [[ $CADDY_SITE_ADDRESS =~ ^(:80|([A-Za-z0-9-]+\.)*[A-Za-z0-9-]+(:[0-9]+)?)?$ ]] \
    || fail 'CADDY_SITE_ADDRESS must be empty, :80, or a hostname.'

  local name value
  for name in POSTGRES_PASSWORD REDIS_PASSWORD RUSTFS_ACCESS_KEY RUSTFS_SECRET_KEY; do
    value=${!name:-}
    [[ -n $value ]] || fail "$name is required."
    [[ $value != change-me* ]] || fail "$name still contains the example value."
  done
  if [[ -n ${INITIAL_ADMIN_PASSWORD:-} && $INITIAL_ADMIN_PASSWORD == change-me* ]]; then
    fail 'INITIAL_ADMIN_PASSWORD still contains the example value.'
  fi
}

health_urls() {
  if [[ -n $CADDY_SITE_ADDRESS && $CADDY_SITE_ADDRESS != :* ]]; then
    local host=${CADDY_SITE_ADDRESS%%:*}
    local https_port=$APP_HTTPS_PORT
    if [[ $CADDY_SITE_ADDRESS == *:* ]]; then
      https_port=${CADDY_SITE_ADDRESS##*:}
    fi
    HEALTH_CURL=(
      curl -k -fsS --max-time 10
      --resolve "$host:$https_port:127.0.0.1"
    )
    BASE_URL="https://$host:$https_port"
  else
    HEALTH_CURL=(curl -fsS --max-time 10)
    BASE_URL="http://127.0.0.1:$APP_PORT"
  fi
}

wait_for_health() {
  local attempt body
  health_urls
  for attempt in $(seq 1 60); do
    body=$("${HEALTH_CURL[@]}" "$BASE_URL/api/health" 2>/dev/null || true)
    if grep -Eq '"service"[[:space:]]*:[[:space:]]*"matrius"' <<<"$body" \
      && grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$body"; then
      "${HEALTH_CURL[@]}" -o /dev/null "$BASE_URL/" \
        || fail 'The web client did not respond.'
      printf 'Matrius health checks passed at %s.\n' "$BASE_URL"
      return 0
    fi
    if (( attempt < 60 )); then
      sleep 5
    fi
  done
  fail 'Production health checks did not pass. Check the server container logs.'
}

if [[ ${1:-} == '--validate' ]]; then
  [[ $# -eq 2 ]] || usage
  validate_config "$2"
  printf 'Deployment configuration is valid.\n'
  exit 0
fi

[[ $# -eq 1 ]] || usage
validate_config "$1"
wait_for_health
