#!/bin/sh
set -eu

# The image starts as root only to take ownership of the named volume on first
# use (Docker creates empty volumes owned by root), then drops to the app user.
data_dir="${DATA_DIR:-/data}"
if [ "$(id -u)" = 0 ]; then
    mkdir -p "$data_dir/files"
    if [ "$(stat -c %u "$data_dir")" != "10001" ]; then
        chown -R matrius:matrius "$data_dir"
    fi
    exec gosu matrius "$0" "$@"
fi

# Single instance: migrations and bootstrap run once, before uvicorn accepts
# traffic. `alembic check` refuses to start when models and migrations drift.
alembic upgrade head
alembic check
python -m app.bootstrap

# Supervise both children: either failure stops the container for restart.
node /opt/matrius/scripts/run-services.mjs "$@"
