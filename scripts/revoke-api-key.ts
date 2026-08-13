import { createDatabaseClient } from '../lib/db/client'
import { createApiAccessRepository } from '../lib/db/api-access-repository'

function option(name: string, required = false) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if ((required || index >= 0) && (!value || value.startsWith('--'))) throw new Error(`${name} requires a value`)
  return value
}

async function main() {
  const keyPrefix = option('--prefix', true)!
  const actor = option('--actor')
  const client = createDatabaseClient()
  try {
    const result = await createApiAccessRepository(client).revokeKey(keyPrefix, actor)
    process.stdout.write(`${JSON.stringify({ event: 'api_key_revoked', ...result })}\n`)
  } finally {
    await client.pool.end()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'API key revocation failed'}\n`)
  process.exitCode = 1
})
