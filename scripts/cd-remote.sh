#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

upload_dir=${1:-}
release_id=${2:-}
if [[ ! $upload_dir =~ ^/home/matrius-deploy/\.matrius-upload\.[a-zA-Z0-9]{8}$ \
  || ! $release_id =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]]; then
  echo 'Invalid deployment paths.' >&2
  exit 1
fi
trap 'rm -rf -- "$upload_dir"' EXIT

deploy_home=/home/matrius-deploy
release_root="$deploy_home/.matrius-releases"
release_dir="$release_root/$release_id"
project_dir="$deploy_home/matrius"
exec 9> "$deploy_home/.matrius-deploy.lock"
if ! flock -n 9; then
  echo 'Another server deployment is already running.' >&2
  exit 1
fi

if [[ -e $project_dir && ! -L $project_dir ]]; then
  echo 'The project path already contains a directory. Ask the server administrator to relocate it before using CD.' >&2
  exit 1
fi

previous_release=$(readlink "$project_dir" || true)
mkdir -p "$release_root"
mkdir "$release_dir"
tar -xzf "$upload_dir/release.tar.gz" --no-same-owner -C "$release_dir"
install -m 600 "$upload_dir/production.env" "$release_dir/docker-compose/.env.production"

# Validate configuration before switching the active release.
bash "$release_dir/scripts/deploy-health.sh" --validate \
  "$release_dir/docker-compose/.env.production"

ln -sfnT "$release_dir" "$project_dir.next"
mv -Tf "$project_dir.next" "$project_dir"

if ! sudo -n /usr/local/sbin/matrius-deploy --check; then
  if [[ -n $previous_release ]]; then
    ln -sfnT "$previous_release" "$project_dir.next"
    mv -Tf "$project_dir.next" "$project_dir"
  fi
  echo 'The server deploy helper is not ready.' >&2
  exit 1
fi

sudo -n /usr/local/sbin/matrius-deploy
bash "$project_dir/scripts/deploy-health.sh" "$project_dir/docker-compose/.env.production"

# Keep the current and previous source releases; persistent data lives in Docker volumes.
for candidate in "$release_root"/*; do
  if [[ $candidate != "$release_dir" && $candidate != "$previous_release" ]]; then
    if ! rm -rf -- "$candidate" 2>/dev/null; then
      printf 'WARNING: Deployment is healthy, but cannot clean old release: %s. Ask the server administrator to repair release ownership; see doc/deployment.md.\n' "$candidate" >&2
    fi
  fi
done
