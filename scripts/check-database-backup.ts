import { checkLatestDatabaseBackup } from '../lib/operations/database-backup'

checkLatestDatabaseBackup().then((result) => {
  process.stdout.write(`${JSON.stringify({ event: 'database_backup_check_passed', ...result })}\n`)
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'database backup check failed'}\n`)
  process.exitCode = 1
})
