import { createDatabaseClient } from '../lib/db/client'
import { createApiAccessRepository } from '../lib/db/api-access-repository'

function requiredOption(name: string) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

function optionalTimestamp(name: string) {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--') || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be a valid timestamp`)
  return new Date(value).toISOString()
}

async function main() {
  const principalId = requiredOption('--principal')
  const expiresAt = optionalTimestamp('--expires-at')
  const client = createDatabaseClient()
  try {
    const issued = await createApiAccessRepository(client).createKey({ principalId, expiresAt })
    process.stdout.write(`${JSON.stringify({ event: 'api_key_created', principalId, keyPrefix: issued.keyPrefix, expiresAt, key: issued.key })}\n`)
  } finally {
    await client.pool.end()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'API key creation failed'}\n`)
  process.exitCode = 1
})
