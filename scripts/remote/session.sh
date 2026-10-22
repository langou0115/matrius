#!/usr/bin/env bash
# Receives one length-prefixed tar archive over SSH, then deploys the production images.
set -euo pipefail
umask 077

workspace=${1:-$HOME/.matrius-remote}
env_file=${2:-}
export PUBLIC_URL=${3:?Missing public URL}
initialize=${4:-0}
publish=${5:-0}
migrate=${6:-0}
app_port=${7:-}
api_port=${8:-}
https_port=${9:-}
for flag in "$initialize" "$publish" "$migrate"; do [[ $flag == 0 || $flag == 1 ]] || exit 1; done
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
flock -n 9 || { echo 'Another npm run remote session owns this server workspace.' >&2; exit 1; }

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
docker volume inspect matrius_prod_postgres_data >/dev/null 2>&1 || fresh=1

announced_admin=0
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

# The source tree is bind-mounted read-only, and Docker refuses to create the
# mountpoints for the writable volumes inside it. These directories are generated
# (and excluded from the sync), so create them on the host up front.
mkdir -p "$REMOTE_SOURCE_DIR/node_modules" \
  "$REMOTE_SOURCE_DIR/.expo" \
  "$REMOTE_SOURCE_DIR/public/vendor/katex"

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
    printf '# Generated by npm run remote. Keep this file private.\n'
    printf 'CADDY_SITE_ADDRESS=\nAPP_BIND=0.0.0.0\nAPP_PORT=%s\nAPP_HTTPS_PORT=%s\nAPI_PORT=%s\n' \
      "${app_port:-16666}" "${https_port:-8443}" "${api_port:-16667}"
    printf 'APP_URL=%s\n' "$PUBLIC_URL"
    printf 'POSTGRES_DB=matrius\nPOSTGRES_USER=matrius\nPOSTGRES_PASSWORD=%s\n' "$(random_secret)"
    printf 'REDIS_PASSWORD=%s\n' "$(random_secret)"
    printf 'RUSTFS_ACCESS_KEY=%s\n' "$(random_secret)"
    printf 'RUSTFS_SECRET_KEY=%s\n' "$(random_secret)"
    printf 'RUSTFS_BUCKET=matrius\n'
    printf 'INITIAL_ADMIN_USERNAME=%s\nINITIAL_ADMIN_PASSWORD=%s\n' "$admin_user" "$admin_password"
    printf 'AUTH_SESSION_TTL_SECONDS=604800\nPREVIEW_USERNAME=admin_test\n'
    printf 'MAX_UPLOAD_BYTES=20971520\nSTORAGE_QUOTA_BYTES=536870912\nFETCH_MAX_CHARS=50000\n'
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
  announced_admin=1
  fresh=1
fi

# Local values win over the server file. Unset keys keep their server value.
apply_ports

# A missing database volume means first run, so initialize without requiring --init.
[[ $fresh == 1 ]] && initialize=1

base=(docker compose --project-name matrius-prod --project-directory "$REMOTE_SOURCE_DIR/docker-compose"
  --env-file "$env_file" -f "$REMOTE_SOURCE_DIR/docker-compose/docker-compose.yml")

bash scripts/remote/health.sh --validate "$env_file" >&2

# Application code is bind-mounted into both containers, so editing a source file
# needs no image build and no container restart: Metro and uvicorn watch the
# mounted tree. Only dependency/toolchain inputs justify rebuilding an image.
# The state file is only rewritten after health checks pass, so a failed deploy
# is retried in full.
digest_files() {
  local directory=$1
  shift
  (
    cd "$directory" || exit 1
    sha256sum -- "$@" | sha256sum | cut -d' ' -f1
  )
}

stored_digest() {
  local key=$1 line
  [[ -f $workspace/build-state ]] || return 1
  while IFS= read -r line; do
    if [[ $line == "$key="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <"$workspace/build-state"
  return 1
}

web_digest=$(digest_files "$REMOTE_SOURCE_DIR" \
  package.json package-lock.json Dockerfile.web.dev scripts/sync-katex.mjs)
api_digest=$(digest_files "$REMOTE_SOURCE_DIR/server" \
  pyproject.toml uv.lock Dockerfile scripts/select-index.py scripts/install-python-deps.sh)

web_changed=1
api_changed=1
if [[ $(stored_digest web) == "$web_digest" ]] \
    && docker image inspect matrius-web-live:local >/dev/null 2>&1; then
  web_changed=0
fi
if [[ $(stored_digest api) == "$api_digest" ]] \
    && docker image inspect matrius-api:local >/dev/null 2>&1; then
  api_changed=0
fi

services=()
if ((web_changed)); then services+=(web); else echo 'web dependencies unchanged; mounted source reloads in place.' >&2; fi
if ((api_changed)); then services+=(api); else echo 'api dependencies unchanged; mounted source reloads in place.' >&2; fi

if ((${#services[@]})); then
  echo "Building images for: ${services[*]}." >&2
  "${base[@]}" build "${services[@]}" >&2
fi
if ((web_changed)); then
  # The dependency volume still holds the previous lockfile's packages. Recreate
  # it from the freshly built image instead of installing packages at startup.
  "${base[@]}" rm --stop --force web >/dev/null 2>&1 || true
  docker volume rm matrius_web_node_modules >/dev/null 2>&1 || true
fi
if [[ $initialize == 1 ]]; then
  echo 'Initializing server infrastructure.' >&2
fi

# Idempotent: starts anything that is stopped, keeps existing data.
"${base[@]}" up -d --wait --wait-timeout 180 postgres redis rustfs openserp >&2

if [[ $initialize == 1 || $migrate == 1 ]]; then
  echo 'Applying reviewed database migrations.' >&2
  if [[ $fresh == 1 ]]; then
    # Credentials from .env.local win over an auto-generated file. Pass them
    # through the environment so they never appear in the server process list.
    bootstrap_user=${admin_user:-$(env_value INITIAL_ADMIN_USERNAME)}; bootstrap_user=${bootstrap_user:-admin}
    bootstrap_password=${admin_password:-$(env_value INITIAL_ADMIN_PASSWORD)}
    if [[ -z $bootstrap_password ]]; then
      bootstrap_password=$(random_secret)
      printf 'username=%s\npassword=%s\n' "$bootstrap_user" "$bootstrap_password" >"$admin_file"
      chmod 600 "$admin_file"
      if [[ $announced_admin == 0 ]]; then
        printf 'Initial admin: %s / %s\n' "$bootstrap_user" "$bootstrap_password" >&2
        printf 'Saved to %s (mode 600). Change the password after first login.\n' "$admin_file" >&2
      fi
    elif [[ $announced_admin == 0 ]]; then
      printf 'Initial admin: %s (existing password kept)\n' "$bootstrap_user" >&2
      printf 'username=%s\npassword=%s\n' "$bootstrap_user" "$bootstrap_password" >"$admin_file"
      chmod 600 "$admin_file"
    fi
    env INITIAL_ADMIN_USERNAME="$bootstrap_user" INITIAL_ADMIN_PASSWORD="$bootstrap_password" \
      "${base[@]}" run -T --rm --no-deps migrate </dev/null >&2
  else
    "${base[@]}" run -T --rm --no-deps migrate </dev/null >&2
  fi
fi

# Start missing containers and recreate only when the compose configuration or
# image changed. Plain source edits already reached the watchers through the
# bind mounts, so they do not restart anything.
"${base[@]}" up -d --no-deps web api >&2
"${base[@]}" up -d --no-deps --force-recreate caddy >&2

if ! bash scripts/remote/health.sh "$env_file" >&2; then
  "${base[@]}" logs --tail 100 web api caddy >&2 || true
  exit 1
fi

{
  printf 'web=%s\napi=%s\n' "$web_digest" "$api_digest"
} >"$workspace/build-state.tmp"
mv -f -- "$workspace/build-state.tmp" "$workspace/build-state"

if [[ $publish == 1 ]]; then
  # Mount the live source so --publish releases the code that is actually running,
  # not whatever was baked into the image when dependencies last changed.
  docker run --rm --network none --user 0:0 --entrypoint python \
    -w /srv -v matrius_feature_releases:/releases \
    -v "$REMOTE_SOURCE_DIR/server:/srv:ro" \
    matrius-api:local -m app.features.release >&2
fi

printf '@@MATRIUS_REMOTE_SYNCED\n'
