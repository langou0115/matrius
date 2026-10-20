#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly deploy_home=/home/matrius-deploy
readonly project_dir=$deploy_home/matrius
readonly compose_dir=$project_dir/docker-compose
readonly compose_file=$compose_dir/docker-compose.yml
readonly env_file=$compose_dir/.env.production

if [[ $EUID -ne 0 ]]; then
  echo 'matrius-deploy must run as root.' >&2
  exit 1
fi

if [[ $# -eq 1 && $1 == '--check' ]]; then
  [[ -f $compose_file && -f $env_file ]] || exit 1
  command -v docker >/dev/null
  docker compose version >/dev/null
  exit 0
fi

if [[ $# -ne 0 ]]; then
  echo 'Usage: matrius-deploy [--check]' >&2
  exit 2
fi

[[ -f $compose_file && -f $env_file ]] || {
  echo 'Deployment files are missing.' >&2
  exit 1
}

# Fixed command only. Never execute scripts from the deploy-owned release tree as root.
exec docker compose \
  --project-name matrius-prod \
  --project-directory "$compose_dir" \
  -f "$compose_file" \
  --env-file "$env_file" \
  up -d --build --remove-orphans
