import { createDatabaseClient } from '../lib/db/client'
import { createApiAccessRepository } from '../lib/db/api-access-repository'

function option(name: string, required = false) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if ((required || index >= 0) && (!value || value.startsWith('--'))) throw new Error(`${name} requires a value`)
  return value
}

function expiration() {
  const value = option('--expires-at')
  if (value === undefined) return undefined
  if (!Number.isFinite(Date.parse(value))) throw new Error('--expires-at must be a valid timestamp')
  return new Date(value).toISOString()
}

async function main() {
  const keyPrefix = option('--prefix', true)!
  const expiresAt = expiration()
  const actor = option('--actor')
  const client = createDatabaseClient()
  try {
    const rotated = await createApiAccessRepository(client).rotateKey({ keyPrefix, expiresAt, actor })
    process.stdout.write(`${JSON.stringify({
      event: 'api_key_rotated',
      replacedKeyPrefix: rotated.replacedKeyPrefix,
      keyPrefix: rotated.keyPrefix,
      expiresAt: rotated.expiresAt,
      key: rotated.key,
      rotatedAt: rotated.rotatedAt,
    })}\n`)
  } finally {
    await client.pool.end()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'API key rotation failed'}\n`)
  process.exitCode = 1
})
