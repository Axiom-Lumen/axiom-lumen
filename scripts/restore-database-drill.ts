import { runDatabaseRestoreDrill } from '../lib/operations/database-backup'

async function main() {
  const index = process.argv.indexOf('--backup')
  const dumpPath = index >= 0 ? process.argv[index + 1] : undefined
  if (!dumpPath || dumpPath.startsWith('--')) throw new Error('--backup requires a dump path')
  const result = await runDatabaseRestoreDrill({ dumpPath })
  process.stdout.write(`${JSON.stringify({ event: 'database_restore_drill_completed', ...result })}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'database restore drill failed'}\n`)
  process.exitCode = 1
})
