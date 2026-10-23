#!/usr/bin/env bash
# Receives one length-prefixed tar archive over SSH, then deploys the production images.
set -euo pipefail
umask 077

workspace=${1:-$HOME/.matrius-remote}
env_file=${2:-}
export PUBLIC_URL=${3:?Missing public URL}
app_port=${4:-}
api_port=${5:-}
https_port=${6:-}
for entry in "APP_PORT:$app_port" "API_PORT:$api_port" "APP_HTTPS_PORT:$https_port"; do
  name=${entry%%:*}; value=${entry#*:}
  [[ -z $value ]] && continue
  [[ $value =~ ^[1-9][0-9]{0,4}$ ]] && (( value <= 65535 )) || {
    echo "$name must be a valid TCP port." >&2; exit 1;
  }
done
[[ $workspace == /* && $workspace != / && $workspace != *$'\n'* ]] || {
  echo 'REMOTE_WORKSPACE must be an absolute dedicated directory.' >&2; exit 1;
}
[[ -z $env_file || ($env_file == /* && $env_file != *$'\n'*) ]] || {
  echo 'REMOTE_ENV_FILE must be an absolute path when set.' >&2; exit 1;
}
for tool in docker tar flock head comm curl od tr base64 sha256sum cut; do
  command -v "$tool" >/dev/null || { echo "Missing server command: $tool" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || {
  echo 'SSH account needs Docker access.' >&2
  exit 1
}
docker compose version >/dev/null

mkdir -p "$workspace"
exec 9>"$workspace/session.lock"
flock -n 9 || { echo 'Another npm run deploy session owns this server workspace.' >&2; exit 1; }

random_secret() {
  dd if=/dev/urandom bs=32 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'
}

env_value() {
  local key=$1 line value=''
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line == "$key="* ]] && value=${line#*=}
  done <"$env_file"
  printf '%s' "$value"
}

# Keep secrets intact while replacing a single key. Only called for explicit
# local overrides, so an unset value never rewrites the server configuration.
set_env_value() {
  local key=$1 value=$2 line found=0 temp
  temp=$(mktemp "$workspace/env.XXXXXXXX")
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "$key="* ]]; then
      printf '%s=%s\n' "$key" "$value"
      found=1
    else
      printf '%s\n' "$line"
    fi
  done <"$env_file" >"$temp"
  [[ $found == 1 ]] || printf '%s=%s\n' "$key" "$value" >>"$temp"
  chmod 600 "$temp"
  mv -f -- "$temp" "$env_file"
}

# Application settings from .env.local (session lifetime, limits, web tool proxy)
# override the generated server defaults. Empty values are never sent.
apply_app_env() {
  local key encoded value
  [[ -n $app_env_payload ]] || return 0
  while IFS=' ' read -r key encoded || [[ -n $key ]]; do
    [[ -n $key && -n $encoded ]] || {
      echo 'Invalid application setting frame.' >&2; return 1; }
    case $key in
      AUTH_SESSION_TTL_SECONDS|MAX_UPLOAD_BYTES|STORAGE_QUOTA_BYTES|FETCH_MAX_CHARS|SQLITE_BUSY_TIMEOUT_MS|CACHE_MAX_ENTRIES|CACHE_MAX_BYTES|SEARCH_TIMEOUT_SECONDS|SEARCH_MAX_BYTES|FETCH_MAX_BYTES|WEBTOOL_PROXY_URL|LOG_LEVEL) ;;
      *) echo "Unsupported application setting: $key" >&2; return 1 ;;
    esac
    value=$(printf '%s' "$encoded" | base64 -d) || {
      echo "Cannot decode $key." >&2; return 1; }
    [[ $value != *$'\n'* && $value != *$'\r'* ]] || {
      echo "$key must be on one line." >&2; return 1; }
    set_env_value "$key" "$value"
  done <<<"$app_env_payload"
}

apply_ports() {
  local key value
  for key in APP_PORT API_PORT APP_HTTPS_PORT; do
    case $key in
      APP_PORT) value=$app_port ;;
      API_PORT) value=$api_port ;;
      APP_HTTPS_PORT) value=$https_port ;;
    esac
    if [[ -n $value && $(env_value "$key") != "$value" ]]; then
      set_env_value "$key" "$value"
    fi
  done
  return 0
}

# Default to a generated file inside the workspace; /etc is only used when explicitly set.
[[ -n $env_file ]] || env_file=$workspace/production.env
admin_file=$workspace/initial-admin.txt
fresh=0
docker volume inspect matrius_prod_api_data >/dev/null 2>&1 || fresh=1

export REMOTE_SOURCE_DIR=$workspace/source
mkdir -p "$REMOTE_SOURCE_DIR"
cd "$REMOTE_SOURCE_DIR"
archive=$(mktemp "$workspace/upload.XXXXXXXX.tar.gz")
cleanup() { rm -f -- "$archive"; }
trap cleanup EXIT
trap 'exit 130' INT TERM

printf '@@MATRIUS_REMOTE_READY\n'
IFS=' ' read -r action first second || { echo 'Missing sync frame.' >&2; exit 1; }
admin_user=''
admin_password=''
app_env_payload=''
if [[ $action == CRED ]]; then
  [[ $first == - ]] || admin_user=$(printf '%s' "$first" | base64 -d)
  [[ $second == - ]] || admin_password=$(printf '%s' "$second" | base64 -d)
  if [[ -n $admin_user || -n $admin_password ]]; then
    [[ -n $admin_user && -n $admin_password && ${#admin_user} -le 64 ]] || {
      echo 'INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD must be set together.' >&2; exit 1;
    }
    [[ -n $admin_user && -n $admin_password && $admin_user != *$'\n'* && $admin_password != *$'\n'* ]] || {
      echo 'Initial admin credentials are invalid.' >&2; exit 1;
    }
  fi
  IFS=' ' read -r action first second || { echo 'Missing sync frame.' >&2; exit 1; }
fi
if [[ $action == ENV ]]; then
  [[ $first == - ]] || app_env_payload=$(printf '%s' "$first" | base64 -d) || {
    echo 'Invalid application setting frame.' >&2; exit 1; }
  IFS=' ' read -r action size || { echo 'Missing sync frame.' >&2; exit 1; }
else
  size=$first
fi
[[ $action == SYNC && $size =~ ^[1-9][0-9]*$ ]] || {
  echo 'Invalid sync frame.' >&2; exit 1;
}
head -c "$size" >"$archive"
[[ $(wc -c <"$archive") -eq $size ]] || { echo 'Interrupted upload.' >&2; exit 1; }
tar -xzOf "$archive" .remote-sync-manifest >"$workspace/incoming-manifest"
# Validate the whole archive before deleting anything from the previous sync.
tar -tzf "$archive" >/dev/null
# Only delete files recorded by a previous deployment, never arbitrary server files.
if [[ -f $workspace/manifest ]]; then
  while IFS= read -r file; do
    [[ -n $file && $file != /* && $file != ../* && $file != */../* && $file != *'/..' ]] || exit 1
    rm -f -- "$file"
    if [[ $file == */* ]]; then rmdir -p -- "${file%/*}" 2>/dev/null || true; fi
  done < <(LC_ALL=C comm -23 "$workspace/manifest" "$workspace/incoming-manifest")
fi
# The API runs as a different UID. Source must be readable inside the build context.
umask 022
tar -xzf "$archive" --touch --no-same-owner --no-same-permissions
umask 077
rm -f .remote-sync-manifest
mv "$workspace/incoming-manifest" "$workspace/manifest"

if [[ ! -f $env_file ]]; then
  if [[ $fresh == 0 ]]; then
    echo "Existing database volume found but $env_file is missing." >&2
    echo 'Restore the previous configuration; refusing to generate new secrets for existing data.' >&2
    exit 1
  fi
  admin_user=${admin_user:-admin}
  password_generated=0
  if [[ -z $admin_password ]]; then
    admin_password=$(random_secret)
    password_generated=1
  fi
  mkdir -p "$(dirname -- "$env_file")" 2>/dev/null || true
  {
    printf '# Generated by npm run deploy. Keep this file private.\n'
    printf 'CADDY_SITE_ADDRESS=\nAPP_BIND=0.0.0.0\nAPP_PORT=%s\nAPP_HTTPS_PORT=%s\nAPI_PORT=%s\n' \
      "${app_port:-16666}" "${https_port:-8443}" "${api_port:-16667}"
    printf 'APP_URL=%s\n' "$PUBLIC_URL"
    printf 'INITIAL_ADMIN_USERNAME=%s\nINITIAL_ADMIN_PASSWORD=%s\n' "$admin_user" "$admin_password"
    printf 'AUTH_SESSION_TTL_SECONDS=604800\n'
    printf 'MAX_UPLOAD_BYTES=20971520\nSTORAGE_QUOTA_BYTES=536870912\nFETCH_MAX_CHARS=50000\n'
    printf 'SQLITE_BUSY_TIMEOUT_MS=30000\nCACHE_MAX_ENTRIES=10000\nCACHE_MAX_BYTES=67108864\n'
    printf 'SEARCH_TIMEOUT_SECONDS=15\nSEARCH_MAX_BYTES=2097152\nFETCH_MAX_BYTES=5242880\n'
    printf 'WEBTOOL_PROXY_URL=\n'
    printf 'LOG_LEVEL=INFO\n'
  } >"$env_file" || {
    echo "Cannot create $env_file. Use a writable server path for REMOTE_ENV_FILE." >&2
    exit 1
  }
  chmod 600 "$env_file"
  printf 'Created %s with generated secrets.\n' "$env_file" >&2
  printf 'username=%s\npassword=%s\n' "$admin_user" "$admin_password" >"$admin_file"
  chmod 600 "$admin_file"
  if [[ $password_generated == 1 ]]; then
    printf 'Initial admin: %s / %s\n' "$admin_user" "$admin_password" >&2
    printf 'Saved to %s (mode 600). Change the password after first login.\n' "$admin_file" >&2
  else
    printf 'Initial admin: %s (password from .env.local)\n' "$admin_user" >&2
  fi
  fresh=1
fi

# Explicit local application settings and port overrides apply on every
# deployment; omitted values retain the server configuration.
apply_app_env
apply_ports

# The latest deployment owns the administrator password. Bootstrap reapplies
# these values to the existing account on every start.
if [[ -n $admin_user || -n $admin_password ]]; then
  [[ -n $admin_user && -n $admin_password ]] || {
    echo 'INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD must be set together.' >&2; exit 1;
  }
  set_env_value INITIAL_ADMIN_USERNAME "$admin_user"
  set_env_value INITIAL_ADMIN_PASSWORD "$admin_password"
fi

base=(docker compose --project-name matrius-prod --project-directory "$REMOTE_SOURCE_DIR/docker-compose"
  --env-file "$env_file" -f "$REMOTE_SOURCE_DIR/docker-compose/docker-compose.yml")

# A snapshot taken immediately before a migration is the rollback path: Alembic
# can roll back code changes but not dropped or rewritten data. sqlite3's backup
# API works on a live database and includes commits that are still in the WAL.
# One-off containers work even if the API is down after a failed deployment.
backup_database() {
  local dir file
  dir=$workspace/backups
  mkdir -p "$dir"
  chmod 700 "$dir"
  file=$dir/matrius-$(date -u +%Y%m%dT%H%M%SZ).db
  echo 'Backing up SQLite before migrating.' >&2
  "${base[@]}" run -T --rm --no-deps --entrypoint rm api -f /data/backup-snapshot.db >/dev/null 2>&1 || true
  if ! "${base[@]}" run -T --rm --no-deps --entrypoint python api -c '
import os, sqlite3, sys
path = "/data/matrius.db"
if not os.path.exists(path):
    sys.exit("database not found")
source = sqlite3.connect(path)
target = sqlite3.connect("/data/backup-snapshot.db")
with target:
    source.backup(target)
source.close()
target.close()
' >&2; then
    "${base[@]}" run -T --rm --no-deps --entrypoint rm api -f /data/backup-snapshot.db >/dev/null 2>&1 || true
    echo 'Database backup failed; refusing to deploy.' >&2
    return 1
  fi
  if ! "${base[@]}" run -T --rm --no-deps --entrypoint cat api /data/backup-snapshot.db >"$file" 2>/dev/null; then
    "${base[@]}" run -T --rm --no-deps --entrypoint rm api -f /data/backup-snapshot.db >/dev/null 2>&1 || true
    rm -f -- "$file"
    echo 'Database backup could not be copied; refusing to deploy.' >&2
    return 1
  fi
  "${base[@]}" run -T --rm --no-deps --entrypoint rm api -f /data/backup-snapshot.db >/dev/null 2>&1 || true
  if [[ ! -s $file ]]; then
    rm -f -- "$file"
    echo 'Database backup is empty; refusing to deploy.' >&2
    return 1
  fi
  # Keep the ten most recent snapshots.
  { ls -1t "$dir"/matrius-*.db 2>/dev/null || true; } | tail -n +11 \
    | while IFS= read -r old; do rm -f -- "$old"; done
  printf 'Database backup: %s\n' "$file" >&2
  printf 'Restore: stop the API container, replace matrius.db inside the api_data volume\n' >&2
  printf 'with %s, then start the API again.\n' "$file" >&2
}

bash scripts/remote/health.sh --validate "$env_file" >&2

# Build from the complete uploaded source; Docker caches unchanged layers.
"${base[@]}" build web api >&2

# Every deployment migrates, so keep a snapshot of existing data first.
if [[ $fresh == 0 ]]; then
  backup_database
fi

# The API entrypoint runs Alembic, the schema check and bootstrap before uvicorn.
# Force recreation so an unchanged image still applies migrations and refreshes
# the administrator password from the latest deployment. --remove-orphans retires
# containers from the previous multi-service topology.
"${base[@]}" up -d --wait --wait-timeout 180 --remove-orphans --force-recreate api >&2

# Replace application containers when their baked image changes.
"${base[@]}" up -d --no-deps web api >&2
caddy_digest=$(sha256sum docker-compose/Caddyfile | cut -d' ' -f1)
applied_caddy_digest=$(cat "$workspace/caddy-config.sha256" 2>/dev/null || true)
if [[ $caddy_digest != "$applied_caddy_digest" ]]; then
  # Compose detects port/image/environment changes, but cannot detect changed bind-mounted contents.
  "${base[@]}" up -d --no-deps --force-recreate caddy >&2
else
  # Recreate only if the resolved service configuration (including host ports) changed.
  "${base[@]}" up -d --no-deps caddy >&2
fi

if ! bash scripts/remote/health.sh "$env_file" >&2; then
  "${base[@]}" logs --tail 100 web api caddy >&2 || true
  exit 1
fi

printf '%s\n' "$caddy_digest" >"$workspace/caddy-config.sha256.tmp"
mv -f -- "$workspace/caddy-config.sha256.tmp" "$workspace/caddy-config.sha256"

printf '@@MATRIUS_REMOTE_SYNCED\n'
