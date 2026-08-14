#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_IMAGE:?RELEASE_IMAGE is required}"
: "${RELEASE_IMAGE_DIGEST:?RELEASE_IMAGE_DIGEST is required}"
: "${RELEASE_COMMIT_SHA:?RELEASE_COMMIT_SHA is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${DATABASE_MIGRATION_URL:?DATABASE_MIGRATION_URL is required}"
: "${RELEASE_BACKUP_DIRECTORY:?RELEASE_BACKUP_DIRECTORY is required}"

[[ "$RELEASE_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$RELEASE_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$RELEASE_IMAGE" == *@"$RELEASE_IMAGE_DIGEST" ]]

release_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
[[ "$release_suffix" =~ ^[a-zA-Z0-9_.-]+$ ]]
web_container="axiom-release-web-${release_suffix}"
worker_container="axiom-release-worker-${release_suffix}"
health_file="$(mktemp)"

cleanup() {
  docker rm --force "$web_container" "$worker_container" >/dev/null 2>&1 || true
  rm -f "$health_file"
}
trap cleanup EXIT

show_runtime_logs() {
  docker logs "$web_container" 2>&1 || true
  docker logs "$worker_container" 2>&1 || true
}
trap 'show_runtime_logs' ERR

docker image inspect "$RELEASE_IMAGE" >/dev/null 2>&1 || docker pull "$RELEASE_IMAGE"
docker run --rm --network host \
  --env "DATABASE_MIGRATION_URL=$DATABASE_MIGRATION_URL" \
  "$RELEASE_IMAGE" migrate

docker run --rm --entrypoint /bin/sh "$RELEASE_IMAGE" -c \
  'test "$(id -u)" -eq 10001 && test "$(id -g)" -eq 10001'
docker run --rm --entrypoint pg_dump "$RELEASE_IMAGE" --version \
  | grep -Eq 'PostgreSQL\) 16\.'
if docker run --rm "$RELEASE_IMAGE" unsupported-release-role; then
  echo 'container accepted an unsupported runtime role' >&2
  exit 1
fi

mkdir -p "$RELEASE_BACKUP_DIRECTORY"
docker run --rm --user 0 --entrypoint chown \
  --volume "$RELEASE_BACKUP_DIRECTORY:/backups" \
  "$RELEASE_IMAGE" 10001:10001 /backups
backup_key='BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc='
backup_environment=(
  --env "DATABASE_BACKUP_URL=$DATABASE_URL"
  --env DATABASE_BACKUP_DIRECTORY=/backups
  --env DATABASE_BACKUP_ENVIRONMENT_ID=release-acceptance
  --env "DATABASE_BACKUP_ENCRYPTION_KEYS=acceptance-key:$backup_key"
  --env DATABASE_BACKUP_ACTIVE_KEY_ID=acceptance-key
)
docker run --rm --network host \
  --volume "$RELEASE_BACKUP_DIRECTORY:/backups" \
  "${backup_environment[@]}" \
  "$RELEASE_IMAGE" backup
docker run --rm --network host \
  --volume "$RELEASE_BACKUP_DIRECTORY:/backups" \
  "${backup_environment[@]}" \
  --env DATABASE_BACKUP_MAXIMUM_AGE_HOURS=1 \
  "$RELEASE_IMAGE" backup-check

runtime_environment=(
  --env "DATABASE_URL=$DATABASE_URL"
  --env AXIOM_API_AUTH_REQUIRED=false
  --env AXIOM_RELEASE_ENVIRONMENT=staging
  --env "AXIOM_RELEASE_IMAGE_DIGEST=$RELEASE_IMAGE_DIGEST"
  --env "AXIOM_RELEASE_COMMIT_SHA=$RELEASE_COMMIT_SHA"
  --env AXIOM_FEATURE_SUPPLY_ENABLED=true
  --env AXIOM_FEATURE_DEPTH_ENABLED=true
  --env AXIOM_FEATURE_TRUSTLINES_ENABLED=true
  --env AXIOM_FEATURE_ANCHOR_RESERVES_ENABLED=false
  --env ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED=false
)
docker run --detach --name "$web_container" --network host \
  "${runtime_environment[@]}" --env PORT=3100 \
  "$RELEASE_IMAGE" web >/dev/null

web_ready=false
for _attempt in {1..30}; do
  if curl --fail --silent --show-error \
    http://127.0.0.1:3100/api/health/ready > "$health_file"; then
    web_ready=true
    break
  fi
  sleep 1
done
if [[ "$web_ready" != true ]]; then
  echo 'web role did not become ready' >&2
  exit 1
fi
curl --fail --silent --show-error \
  http://127.0.0.1:3100/api/health/live > "$health_file"
jq --exit-status \
  --arg digest "$RELEASE_IMAGE_DIGEST" \
  --arg commit "$RELEASE_COMMIT_SHA" \
  '.release == {environment: "staging", imageDigest: $digest, commitSha: $commit}
    and .features == {supply: true, depth: true, trustlines: true, anchorReserves: false, namedPartyPublication: false}' \
  "$health_file" >/dev/null

docker run --detach --name "$worker_container" --network host \
  "${runtime_environment[@]}" --env WORKER_ID=release-acceptance-worker \
  "$RELEASE_IMAGE" worker >/dev/null
sleep 5
test "$(docker inspect --format '{{.State.Running}}' "$worker_container")" = true

trap - ERR
echo 'exact release image passed runtime role acceptance'
