#!/usr/bin/env bash
# Open SSH local forwards to the data services on the production server.
# The server publishes those ports on 127.0.0.1 only; nothing is exposed
# publicly. Run this in its own terminal and leave it running.
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${DEV_ENV_FILE:-$repo_dir/.env.local}

if [[ ! -f $env_file ]]; then
  printf 'Missing %s.\nCopy .env.local.example to .env.local and fill it in.\n' "$env_file" >&2
  exit 1
fi

# The file is a local, user-controlled env file; keep the syntax simple.
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

: "${SERVER_HOST:?Set SERVER_HOST in .env.local}"
SERVER_PORT=${SERVER_PORT:-22}
SERVER_USER=${SERVER_USER:-matrius-deploy}

DB_TUNNEL_PORT=${DB_TUNNEL_PORT:-15432}
REDIS_TUNNEL_PORT=${REDIS_TUNNEL_PORT:-16379}
RUSTFS_TUNNEL_PORT=${RUSTFS_TUNNEL_PORT:-19000}
OPENSERP_TUNNEL_PORT=${OPENSERP_TUNNEL_PORT:-17000}

for name in SERVER_PORT DB_TUNNEL_PORT REDIS_TUNNEL_PORT RUSTFS_TUNNEL_PORT OPENSERP_TUNNEL_PORT; do
  value=${!name}
  if [[ ! $value =~ ^[0-9]+$ ]] || ((value < 1 || value > 65535)); then
    printf '%s must be a port between 1 and 65535, got %q\n' "$name" "$value" >&2
    exit 1
  fi
done

expand_tilde() {
  local value=$1
  if [[ $value == "~/"* ]]; then
    printf '%s/%s' "$HOME" "${value#~/}"
  else
    printf '%s' "$value"
  fi
}

ssh_command=(ssh)
if [[ -n ${SERVER_SSH_KEY:-} ]]; then
  ssh_key=$(expand_tilde "$SERVER_SSH_KEY")
  if [[ ! -f $ssh_key ]]; then
    printf 'SSH key not found: %s\n' "$ssh_key" >&2
    exit 1
  fi
elif [[ -n ${SERVER_PASSWORD:-} ]]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    printf 'SERVER_PASSWORD is set but sshpass is not installed.\n' >&2
    printf 'Install sshpass or use SERVER_SSH_KEY instead.\n' >&2
    exit 1
  fi
  export SSHPASS=$SERVER_PASSWORD
  ssh_command=(sshpass -e ssh)
fi

ssh_options=(
  -N
  -T
  -p "$SERVER_PORT"
  -o ConnectTimeout=10
  -o ExitOnForwardFailure=yes
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
)

if [[ -n ${SERVER_KNOWN_HOSTS:-} ]]; then
  known_hosts=$(expand_tilde "$SERVER_KNOWN_HOSTS")
  ssh_options+=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$known_hosts")
else
  ssh_options+=(-o StrictHostKeyChecking=accept-new)
fi

if [[ -n ${SERVER_SSH_KEY:-} ]]; then
  ssh_options+=(-i "$ssh_key")
fi

forwards=(
  "127.0.0.1:${DB_TUNNEL_PORT}:127.0.0.1:${DB_TUNNEL_PORT}"
  "127.0.0.1:${REDIS_TUNNEL_PORT}:127.0.0.1:${REDIS_TUNNEL_PORT}"
  "127.0.0.1:${RUSTFS_TUNNEL_PORT}:127.0.0.1:${RUSTFS_TUNNEL_PORT}"
  "127.0.0.1:${OPENSERP_TUNNEL_PORT}:127.0.0.1:${OPENSERP_TUNNEL_PORT}"
)
for forward in "${forwards[@]}"; do
  ssh_options+=(-L "$forward")
done

printf 'Tunnelling via %s@%s:%s\n' "$SERVER_USER" "$SERVER_HOST" "$SERVER_PORT"
printf '  PostgreSQL  127.0.0.1:%s -> server 127.0.0.1:%s\n' "$DB_TUNNEL_PORT" "$DB_TUNNEL_PORT"
printf '  Redis       127.0.0.1:%s -> server 127.0.0.1:%s\n' "$REDIS_TUNNEL_PORT" "$REDIS_TUNNEL_PORT"
printf '  RustFS      127.0.0.1:%s -> server 127.0.0.1:%s\n' "$RUSTFS_TUNNEL_PORT" "$RUSTFS_TUNNEL_PORT"
printf '  OpenSERP    127.0.0.1:%s -> server 127.0.0.1:%s\n' "$OPENSERP_TUNNEL_PORT" "$OPENSERP_TUNNEL_PORT"
printf 'Press Ctrl+C to close the tunnel.\n'

exec "${ssh_command[@]}" "${ssh_options[@]}" "${SERVER_USER}@${SERVER_HOST}"
