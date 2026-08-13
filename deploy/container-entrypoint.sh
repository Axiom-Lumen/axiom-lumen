#!/bin/sh
set -eu

role="${1:-web}"
case "$role" in
  web)
    exec ./node_modules/.bin/next start --hostname 0.0.0.0 --port "${PORT:-3000}"
    ;;
  worker)
    exec node --import tsx worker/main.ts --continuous
    ;;
  migrate)
    exec ./node_modules/.bin/drizzle-kit migrate
    ;;
  backup-check)
    exec node --import tsx scripts/check-database-backup.ts
    ;;
  backup)
    exec node --import tsx scripts/backup-database.ts
    ;;
  *)
    echo "unknown Axiom Lumen container role: $role" >&2
    exit 64
    ;;
esac
