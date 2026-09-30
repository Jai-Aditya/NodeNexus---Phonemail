#!/usr/bin/env bash
# PhoneMail backup: the database plus the files it refers to (attachments, profile
# pictures), in one dated folder. Old backups are removed after KEEP_DAYS.
#
#   bash scripts/backup.sh                      # from the phonemail folder
#   BACKUP_DIR=/mnt/usb/phonemail bash scripts/backup.sh
#
# Nightly on a server (crontab -e), 03:15:
#   15 3 * * * cd /path/to/phonemail && bash scripts/backup.sh >> /var/log/phonemail-backup.log 2>&1
#
# Keep BACKUP_DIR on a different disk from the Docker volumes (or copy it off the server):
# a backup on the same disk doesn't survive that disk failing.
# Restore with: bash scripts/restore.sh <backup folder>
set -euo pipefail
umask 077 # backups hold everyone's mail: readable by their owner only
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1  # Git Bash on Windows: keep container paths like /data as they are

DEST="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
dir="$DEST/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$dir"
echo "Backing up to $dir"

# 1. The database, as one consistent snapshot (pg_dump reads inside a single
#    transaction, so mail being sent meanwhile is either fully in or fully out).
#    Custom format: compressed, and restorable table by table if ever needed.
docker compose exec -T db pg_dump -U phonemail -d phonemail --format=custom > "$dir/phonemail.dump"

# 2. The files, taken after the dump so every file the dump refers to is included.
#    (A file added after the dump is harmless extra; the clean-up only removes files
#    of messages nobody can see any more.)
docker compose exec -T mailsvc tar -C /data -cf - attachments > "$dir/attachments.tar"
docker compose exec -T api tar -C /data -cf - avatars > "$dir/avatars.tar"

# 3. Check the dump is readable before trusting it, and record checksums.
docker compose exec -T db pg_restore --list < "$dir/phonemail.dump" > /dev/null
(cd "$dir" && sha256sum phonemail.dump attachments.tar avatars.tar > SHA256SUMS)
echo "OK: $(du -sh "$dir" | cut -f1) in $dir"

# 4. Remove backups older than KEEP_DAYS days.
find "$DEST" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime "+$KEEP_DAYS" -exec rm -rf {} +
