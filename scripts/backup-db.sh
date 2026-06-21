#!/usr/bin/env bash
# backup-db.sh — Manual PostgreSQL backup script for Sage platform
# Usage: DATABASE_URL=postgres://... ./scripts/backup-db.sh [output-dir]
#
# Requirements: pg_dump, gzip must be in PATH
# Output: data/backups/sage-backup-<timestamp>.sql.gz (or custom dir)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# ─── Config ───────────────────────────────────────────────────────────────────
DB_URL="${DATABASE_URL:?DATABASE_URL environment variable must be set}"
BACKUP_DIR="${1:-$PROJECT_ROOT/data/backups}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%S)"
BACKUP_FILE="$BACKUP_DIR/sage-backup-$TIMESTAMP.sql.gz"
RETENTION_DAYS=30

# ─── Setup ────────────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
echo "[$(date -u)] Starting backup → $BACKUP_FILE"

# ─── Dump ─────────────────────────────────────────────────────────────────────
if pg_dump "$DB_URL" | gzip > "$BACKUP_FILE"; then
  echo "[$(date -u)] pg_dump completed"
else
  echo "[$(date -u)] ERROR: pg_dump failed" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

# ─── Verify ───────────────────────────────────────────────────────────────────
if gzip -t "$BACKUP_FILE"; then
  SIZE_KB=$(du -k "$BACKUP_FILE" | cut -f1)
  echo "[$(date -u)] Backup verified OK — ${SIZE_KB} KB"
else
  echo "[$(date -u)] ERROR: Backup verification failed" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

# ─── Prune old backups ────────────────────────────────────────────────────────
echo "[$(date -u)] Pruning backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "sage-backup-*.sql.gz" -mtime "+$RETENTION_DAYS" -delete -print | \
  while read -r f; do echo "[$(date -u)] Pruned: $f"; done

echo "[$(date -u)] Backup complete: $BACKUP_FILE"
