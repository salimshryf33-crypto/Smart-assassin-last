#!/usr/bin/env bash
# restore-db.sh — Restore PostgreSQL database from a compressed backup
# Usage: DATABASE_URL=postgres://... ./scripts/restore-db.sh <backup-file.sql.gz>
#
# WARNING: This will DROP and recreate the target database.
# Use only in disaster recovery scenarios.

set -euo pipefail

BACKUP_FILE="${1:?Usage: restore-db.sh <backup-file.sql.gz>}"
DB_URL="${DATABASE_URL:?DATABASE_URL environment variable must be set}"

# ─── Validate backup file ─────────────────────────────────────────────────────
if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
  echo "ERROR: Backup file is corrupt or not gzip compressed: $BACKUP_FILE" >&2
  exit 1
fi

echo "[$(date -u)] Backup file verified: $BACKUP_FILE"
SIZE_KB=$(du -k "$BACKUP_FILE" | cut -f1)
echo "[$(date -u)] Backup size: ${SIZE_KB} KB"

# ─── Safety confirmation ──────────────────────────────────────────────────────
echo ""
echo "WARNING: This will restore the database from backup."
echo "Target: $DB_URL"
echo "File:   $BACKUP_FILE"
echo ""
read -r -p "Type 'RESTORE' to confirm: " CONFIRM
if [[ "$CONFIRM" != "RESTORE" ]]; then
  echo "Aborted."
  exit 0
fi

# ─── Restore ──────────────────────────────────────────────────────────────────
echo "[$(date -u)] Starting restore..."
if gunzip -c "$BACKUP_FILE" | psql "$DB_URL"; then
  echo "[$(date -u)] Restore completed successfully"
else
  echo "[$(date -u)] ERROR: Restore failed" >&2
  exit 1
fi

echo "[$(date -u)] Restore complete from: $BACKUP_FILE"
