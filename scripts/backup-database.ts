import { createDatabaseBackup } from '../lib/operations/database-backup'

createDatabaseBackup({}).then(({ manifest }) => {
  process.stdout.write(`${JSON.stringify({ event: 'database_backup_completed', createdAt: manifest.createdAt, database: manifest.database, file: manifest.dump.file, sha256: manifest.dump.sha256 })}\n`)
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'database backup failed'}\n`)
  process.exitCode = 1
})
