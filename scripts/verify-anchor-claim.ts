import { createAnchorClaimRepository } from '../lib/db/anchor-claim-repository'
import { createDatabaseClient } from '../lib/db/client'

function option(name: string) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`${name} is required`)
  return value
}

const challengeId = option('--challenge')
const token = process.env.ANCHOR_CLAIM_TOKEN
if (!token) throw new Error('ANCHOR_CLAIM_TOKEN is required')
const client = createDatabaseClient()
try {
  const repository = createAnchorClaimRepository(client)
  const result = await repository.claimAnchor({ challengeId, token })
  process.stdout.write(`${JSON.stringify({ event: 'anchor_claim_verified', ...result })}\n`)
} finally {
  await client.pool.end()
}
