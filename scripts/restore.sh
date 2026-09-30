#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh, REPLACING the current data:
#
#   bash scripts/restore.sh backups/20261001-031500
#
# The stack must be running (docker compose up -d). The API and mail service are
# stopped while the database is replaced, so nothing writes to it halfway through.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1  # Git Bash on Windows: keep container paths like /data as they are

dir="${1:?usage: bash scripts/restore.sh <backup folder>}"
for f in phonemail.dump attachments.tar avatars.tar; do
  [ -f "$dir/$f" ] || { echo "missing $dir/$f"; exit 1; }
done
(cd "$dir" && sha256sum -c --quiet SHA256SUMS) || { echo "checksum mismatch: backup damaged"; exit 1; }

read -r -p "This replaces ALL current PhoneMail data with $dir. Type yes: " ok
[ "$ok" = yes ] || { echo "Cancelled."; exit 1; }

docker compose stop api mailsvc
# --clean drops each object before recreating it; --single-transaction: all or nothing.
docker compose exec -T db pg_restore -U phonemail -d phonemail --clean --if-exists \
  --no-owner --single-transaction < "$dir/phonemail.dump"
docker compose start mailsvc api

# Files: unpack over the volumes, then give them back to the user each service runs as.
docker compose exec -T -u root mailsvc sh -c 'rm -rf /data/attachments/* && tar -C /data -xf - && chown -R app /data/attachments' < "$dir/attachments.tar"
docker compose exec -T -u root api sh -c 'rm -rf /data/avatars/* && tar -C /data -xf - && chown -R node /data/avatars' < "$dir/avatars.tar"
echo "Restored from $dir"
