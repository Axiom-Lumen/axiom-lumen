import { createAnchorCaseRepository } from '../lib/db/anchor-case-repository'
import { createDatabaseClient } from '../lib/db/client'

function option(name: string) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

async function main() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const client = createDatabaseClient()
  try {
    const result = await createAnchorCaseRepository(client).requeueFailedNotification({
      notificationId: option('--notification'),
      administratorPrincipalId: option('--administrator'),
      reason: Buffer.concat(chunks).toString('utf8'),
      requeuedAt: new Date().toISOString(),
    })
    process.stdout.write(`${JSON.stringify({ event: 'anchor_notification_requeued', ...result })}\n`)
  } finally { await client.pool.end() }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'notification requeue failed'}\n`)
  process.exitCode = 1
})
