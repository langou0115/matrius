#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: install-python-deps.sh [--dev] [--venv PATH]

Exports the hashed requirements from uv.lock, probes the configured PyPI
indexes, and installs from the fastest reachable one. Falls back to the next
index when an install fails.

Environment:
  PYPI_INDEX_CANDIDATES  Comma- or space-separated indexes to probe.
  PYPI_PROBE_TIMEOUT     Per-attempt probe timeout in seconds (default: 6).
  PYPI_INSTALL_TIMEOUT   Seconds to try one index before falling back (default: 300).
EOF
  exit 2
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
server_dir=$(dirname "$script_dir")
cd "$server_dir"

dev=0
venv=.venv
while (($#)); do
  case $1 in
    --dev) dev=1 ;;
    --no-dev) dev=0 ;;
    --venv)
      [[ $# -ge 2 ]] || usage
      venv=$2
      shift
      ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
  shift
done

command -v uv >/dev/null || {
  echo 'uv is required: https://docs.astral.sh/uv/getting-started/installation/' >&2
  exit 1
}
command -v python3 >/dev/null || {
  echo 'python3 is required to probe package indexes.' >&2
  exit 1
}

requirements=$(mktemp)
cleanup() {
  rm -f -- "$requirements"
}
trap cleanup EXIT

export_args=(--frozen --no-emit-project --output-file "$requirements")
if ((dev)); then
  export_args+=(--extra dev)
fi
uv export "${export_args[@]}" >/dev/null

if [[ ! -x $venv/bin/python ]]; then
  uv venv --python 3.12 "$venv"
fi

indexes=()
read_indexes() {
  indexes=()
  local index
  while IFS= read -r index; do
    if [[ -n $index ]]; then indexes+=("$index"); fi
  done < <(python3 "$script_dir/select-index.py" "$@")
}

read_indexes
if ((${#indexes[@]} == 0)); then
  echo 'No PyPI index answered the probe; retrying once.' >&2
  sleep 2
  read_indexes
fi
if ((${#indexes[@]} == 0)); then
  # Probing is a latency optimization, not a gate. A transient DNS or TLS
  # failure should not block a build that pip can still complete.
  echo 'Index probe failed; attempting the configured indexes directly.' >&2
  read_indexes --all
fi
if ((${#indexes[@]} == 0)); then
  echo 'No PyPI index is configured.' >&2
  exit 1
fi

install_timeout=${PYPI_INSTALL_TIMEOUT:-300}
for index in "${indexes[@]}"; do
  printf 'Installing Python dependencies from %s\n' "$index"
  if timeout --signal=TERM "$install_timeout" \
    uv pip install --python "$venv/bin/python" --require-hashes \
    --default-index "$index" --requirements "$requirements"; then
    exit 0
  fi
  printf 'Installation from %s failed or timed out; trying the next index.\n' "$index" >&2
done

echo 'Failed to install Python dependencies from all reachable indexes.' >&2
exit 1
