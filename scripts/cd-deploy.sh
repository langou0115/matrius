#!/usr/bin/env bash
set -euo pipefail
umask 077

for name in DEPLOY_HOST DEPLOY_PORT DEPLOY_USER DEPLOY_SSH_PRIVATE_KEY DEPLOY_SSH_KNOWN_HOSTS PRODUCTION_ENV GITHUB_SHA GITHUB_RUN_ID GITHUB_RUN_ATTEMPT; do
  if [[ -z ${!name:-} ]]; then
    printf 'Missing deployment configuration: %s\n' "$name" >&2
    exit 1
  fi
done

if [[ ${GITHUB_REF:-} != refs/heads/main || ! $GITHUB_SHA =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Deployment requires a main commit SHA.' >&2
  exit 1
fi
if [[ ! $DEPLOY_HOST =~ ^([a-zA-Z0-9][a-zA-Z0-9.-]*|[0-9a-fA-F:]+)$ || $DEPLOY_USER != matrius-deploy ]]; then
  echo 'Invalid deployment host or user.' >&2
  exit 1
fi
if [[ ! $DEPLOY_PORT =~ ^[1-9][0-9]{0,4}$ ]] || (( DEPLOY_PORT > 65535 )); then
  echo 'Invalid SSH port.' >&2
  exit 1
fi
if [[ ! $GITHUB_RUN_ID =~ ^[0-9]+$ || ! $GITHUB_RUN_ATTEMPT =~ ^[0-9]+$ ]]; then
  echo 'Invalid deployment run identifier.' >&2
  exit 1
fi
if [[ $(git rev-parse HEAD) != "$GITHUB_SHA" ]]; then
  echo 'Checked-out code does not match the requested commit.' >&2
  exit 1
fi

work_dir=$(mktemp -d)
upload_dir=''
ssh_options=()
cleanup() {
  if [[ -n $upload_dir ]]; then
    ssh "${ssh_options[@]}" -l "$DEPLOY_USER" -- "$DEPLOY_HOST" \
      "rm -rf -- '$upload_dir'" </dev/null || true
  fi
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

printf '%s\n' "$DEPLOY_SSH_PRIVATE_KEY" | tr -d '\r' > "$work_dir/key"
printf '%s\n' "$DEPLOY_SSH_KNOWN_HOSTS" | tr -d '\r' > "$work_dir/known_hosts"
printf '%s\n' "$PRODUCTION_ENV" | tr -d '\r' > "$work_dir/production.env"
unset DEPLOY_SSH_PRIVATE_KEY DEPLOY_SSH_KNOWN_HOSTS PRODUCTION_ENV

ssh-keygen -y -P '' -f "$work_dir/key" >/dev/null
host_pattern=$DEPLOY_HOST
if [[ $DEPLOY_PORT != 22 ]]; then
  host_pattern="[$DEPLOY_HOST]:$DEPLOY_PORT"
fi
if ! ssh-keygen -F "$host_pattern" -f "$work_dir/known_hosts" >/dev/null; then
  echo 'The pinned server key does not match DEPLOY_HOST and DEPLOY_PORT.' >&2
  exit 1
fi

ssh_options=(
  -F /dev/null -T -p "$DEPLOY_PORT" -i "$work_dir/key"
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$work_dir/known_hosts" -o GlobalKnownHostsFile=/dev/null
  -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
)
upload_dir=$(ssh "${ssh_options[@]}" -l "$DEPLOY_USER" -- "$DEPLOY_HOST" \
  'umask 077; mktemp -d /home/matrius-deploy/.matrius-upload.XXXXXXXX')
if [[ ! $upload_dir =~ ^/home/matrius-deploy/\.matrius-upload\.[a-zA-Z0-9]{8}$ ]]; then
  upload_dir=''
  echo 'Unexpected server upload directory.' >&2
  exit 1
fi

git archive --format=tar.gz "$GITHUB_SHA" > "$work_dir/release.tar.gz"
tar -czf "$work_dir/payload.tar.gz" -C "$work_dir" release.tar.gz production.env \
  -C "$PWD" scripts/cd-remote.sh scripts/deploy-health.sh
release_id="$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
echo "Deploying $GITHUB_SHA."
ssh "${ssh_options[@]}" -l "$DEPLOY_USER" -- "$DEPLOY_HOST" \
  "tar -xzf - -C '$upload_dir' && bash '$upload_dir/scripts/cd-remote.sh' '$upload_dir' '$release_id'" \
  < "$work_dir/payload.tar.gz"
echo "Deployment and health checks passed for $GITHUB_SHA."
