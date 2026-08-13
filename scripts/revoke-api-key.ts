import { createDatabaseClient } from '../lib/db/client'
import { createApiAccessRepository } from '../lib/db/api-access-repository'

const index = process.argv.indexOf('--prefix')
const keyPrefix = index >= 0 ? process.argv[index + 1] : undefined
if (!keyPrefix || !/^[A-Za-z0-9_-]{12}$/.test(keyPrefix)) throw new Error('--prefix must be a 12-character key prefix')

const client = createDatabaseClient()
try {
  const result = await createApiAccessRepository(client).revokeKey(keyPrefix)
  process.stdout.write(`${JSON.stringify({ event: 'api_key_revoked', ...result })}\n`)
} finally {
  await client.pool.end()
}
