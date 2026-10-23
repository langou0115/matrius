#!/usr/bin/env bash
# Back up the data behind the production Compose stack.
#
# Back up data, not containers: the SQLite database, uploaded files inside the
# api_data volume and the environment file are the only irreplaceable state.
# Containers and images can be rebuilt from the repository.
#
# Run on the server as root or a user with Docker access. Install it root-owned so a compromised
# deploy user cannot change what root executes:
#   sudo install -o root -g root -m 0755 scripts/backup.sh /usr/local/sbin/matrius-backup
# Reinstall after changing this file.
#
# Suggested cron entry:
#   17 3 * * * /usr/local/sbin/matrius-backup >> /var/log/matrius-backup.log 2>&1
#
# Store a copy off the server. BACKUP_REMOTE is passed to rsync; set it to a
# mounted backup disk or a remote rsync target.
#
# Restore: stop the stack, restore sqlite-<time>.db to /data/matrius.db in the
# api_data volume, extract files-<time>.tar.gz into /data, then start the stack.
set -euo pipefail
umask 077

env_file=${PRODUCTION_ENV_FILE:-/etc/matrius/remote.env}
backup_dir=${BACKUP_DIR:-/var/backups/matrius}
keep_days=${BACKUP_KEEP_DAYS:-14}
api_image=${API_IMAGE:-matrius-api:local}
api_volume=${API_VOLUME:-matrius_prod_api_data}
backup_remote=${BACKUP_REMOTE:-}

fail() {
  printf 'Backup failed: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail 'docker is not installed'
docker info >/dev/null 2>&1 || fail 'cannot access the Docker daemon; run as root or join the docker group'
[[ -f $env_file ]] || fail "missing environment file: $env_file"
docker image inspect "$api_image" >/dev/null 2>&1 \
  || fail "missing API image: $api_image (deploy once with npm run deploy)"
docker volume inspect "$api_volume" >/dev/null 2>&1 \
  || fail "missing API volume: $api_volume"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

# sqlite3.Connection.backup takes a consistent snapshot even while the API is
# writing, and includes rows still sitting in the WAL. The volume stays
# read-write because opening a WAL database may need to create -shm/-wal files.
printf 'Backing up SQLite (%s) ...\n' "$api_volume"
sqlite_backup=$backup_dir/sqlite-$timestamp.db
if ! docker run --rm --entrypoint python \
  -v "$api_volume:/data" \
  -v "$backup_dir:/backup" \
  -e SNAPSHOT="/backup/$(basename "$sqlite_backup")" \
  "$api_image" -c '
import os
import sqlite3

source = sqlite3.connect("/data/matrius.db")
target = sqlite3.connect(os.environ["SNAPSHOT"])
with target:
    source.backup(target)
source.close()
target.close()
'; then
  rm -f "$sqlite_backup"
  fail 'SQLite snapshot failed'
fi
[[ -s $sqlite_backup ]] || {
  rm -f "$sqlite_backup"
  fail 'SQLite snapshot is empty'
}
printf '  %s\n' "$sqlite_backup"

printf 'Backing up uploaded files in %s ...\n' "$api_volume"
files_archive=$backup_dir/files-$timestamp.tar.gz
if ! docker run --rm \
  -v "$api_volume:/data:ro" \
  -v "$backup_dir:/backup" \
  alpine:3.20 \
  sh -c 'if [ -d /data/files ]; then tar -czf "/backup/$1" -C /data files; else tar -czf "/backup/$1" --files-from /dev/null; fi' \
  _ "$(basename "$files_archive")"; then
  rm -f "$files_archive"
  fail 'File archive failed'
fi
[[ -s $files_archive ]] || {
  rm -f "$files_archive"
  fail 'File archive is empty'
}
printf '  %s\n' "$files_archive"

production_env=$backup_dir/production-env-$timestamp
install -m 600 "$env_file" "$production_env"
printf '  %s\n' "$production_env"

printf 'Removing backups older than %s days ...\n' "$keep_days"
find "$backup_dir" -maxdepth 1 -type f \
  \( -name 'sqlite-*.db' -o -name 'files-*.tar.gz' -o -name 'production-env-*' \) \
  -mtime +"$keep_days" -delete

if [[ -n $backup_remote ]]; then
  command -v rsync >/dev/null 2>&1 || fail 'rsync is not installed but BACKUP_REMOTE is set'
  printf 'Copying backups to %s ...\n' "$backup_remote"
  rsync -a -- "$backup_dir/" "$backup_remote"
fi

printf 'Backup complete: %s\n' "$backup_dir"
