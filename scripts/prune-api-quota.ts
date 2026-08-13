import { createApiAccessRepository } from '../lib/db/api-access-repository'
import { createDatabaseClient } from '../lib/db/client'

function positiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) throw new Error('--limit must be from 1 through 10000')
  return parsed
}

const retentionHours = positiveInteger(process.env.API_QUOTA_RETENTION_HOURS, 168)
const limitIndex = process.argv.indexOf('--limit')
const limit = positiveInteger(limitIndex >= 0 ? process.argv[limitIndex + 1] : undefined, 1_000)
const before = new Date(Date.now() - retentionHours * 60 * 60 * 1_000).toISOString()
const client = createDatabaseClient()
try {
  const deleted = await createApiAccessRepository(client).pruneQuotaUsage({ before, limit })
  process.stdout.write(`${JSON.stringify({ event: 'api_quota_pruned', before, deleted })}\n`)
} finally {
  await client.pool.end()
}
