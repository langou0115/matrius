#!/usr/bin/env bash
# Back up the data behind the production Compose stack.
#
# Back up data, not containers: PostgreSQL, RustFS objects and the
# environment file are the only irreplaceable state. Containers and images can
# be rebuilt from the repository.
#
# Run on the server as root or a user with Docker access. Do not run as the
# unprivileged matrius-deploy user. Install it root-owned so a compromised
# deploy user cannot change what root executes:
#   sudo install -o root -g root -m 0755 scripts/backup.sh /usr/local/sbin/matrius-backup
# Reinstall after changing this file.
#
# Suggested cron entry:
#   17 3 * * * /usr/local/sbin/matrius-backup >> /var/log/matrius-backup.log 2>&1
#
# Store a copy off the server. BACKUP_REMOTE is passed to rsync; set it to a
# mounted backup disk or a remote rsync target.
set -euo pipefail
umask 077

project_dir=${MATRIUS_PROJECT_DIR:-/home/matrius-deploy/matrius}
env_file=${PRODUCTION_ENV_FILE:-$project_dir/docker-compose/.env.production}
backup_dir=${BACKUP_DIR:-/var/backups/matrius}
keep_days=${BACKUP_KEEP_DAYS:-14}
postgres_container=${POSTGRES_CONTAINER:-matrius-postgres}
rustfs_volume=${RUSTFS_VOLUME:-matrius_prod_rustfs_data}
backup_remote=${BACKUP_REMOTE:-}

fail() {
  printf 'Backup failed: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail 'docker is not installed'
docker info >/dev/null 2>&1 || fail 'cannot access the Docker daemon; run as root or join the docker group'
[[ -f $env_file ]] || fail "missing environment file: $env_file"

env_value() {
  local key=$1 line value
  while IFS= read -r line; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*# ]] && continue
    [[ $line =~ ^[[:space:]]*$ ]] && continue
    if [[ $line == "$key="* ]]; then
      value=${line#*=}
      if [[ $value == \"*\" && $value == *\" ]]; then
        value=${value:1:${#value}-2}
      elif [[ $value == \'*\' && $value == *\' ]]; then
        value=${value:1:${#value}-2}
      fi
      printf '%s' "$value"
      return 0
    fi
  done <"$env_file"
  return 1
}

postgres_db=$(env_value POSTGRES_DB || true)
postgres_user=$(env_value POSTGRES_USER || true)
postgres_db=${postgres_db:-matrius}
postgres_user=${postgres_user:-matrius}

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

printf 'Backing up PostgreSQL (%s/%s) ...\n' "$postgres_user" "$postgres_db"
postgres_dump=$backup_dir/postgres-$timestamp.dump
if ! docker exec "$postgres_container" \
  pg_dump -U "$postgres_user" -d "$postgres_db" -Fc >"$postgres_dump"; then
  rm -f "$postgres_dump"
  fail 'pg_dump failed'
fi
[[ -s $postgres_dump ]] || {
  rm -f "$postgres_dump"
  fail 'pg_dump produced an empty file'
}
printf '  %s\n' "$postgres_dump"

printf 'Backing up RustFS volume %s ...\n' "$rustfs_volume"
rustfs_archive=$backup_dir/rustfs-$timestamp.tar.gz
if ! docker run --rm \
  -v "$rustfs_volume:/data:ro" \
  -v "$backup_dir:/backup" \
  alpine:3.20 \
  tar -czf "/backup/$(basename "$rustfs_archive")" -C /data .; then
  rm -f "$rustfs_archive"
  fail 'RustFS archive failed'
fi
[[ -s $rustfs_archive ]] || {
  rm -f "$rustfs_archive"
  fail 'RustFS archive is empty'
}
printf '  %s\n' "$rustfs_archive"

production_env=$backup_dir/production-env-$timestamp
install -m 600 "$env_file" "$production_env"
printf '  %s\n' "$production_env"

printf 'Removing backups older than %s days ...\n' "$keep_days"
find "$backup_dir" -maxdepth 1 -type f \
  \( -name 'postgres-*.dump' -o -name 'rustfs-*.tar.gz' -o -name 'production-env-*' \) \
  -mtime +"$keep_days" -delete

if [[ -n $backup_remote ]]; then
  command -v rsync >/dev/null 2>&1 || fail 'rsync is not installed but BACKUP_REMOTE is set'
  printf 'Copying backups to %s ...\n' "$backup_remote"
  rsync -a -- "$backup_dir/" "$backup_remote"
fi

printf 'Backup complete: %s\n' "$backup_dir"
