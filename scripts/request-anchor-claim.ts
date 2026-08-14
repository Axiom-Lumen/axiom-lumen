import { createAnchorClaimRepository } from '../lib/db/anchor-claim-repository'
import { createDatabaseClient } from '../lib/db/client'

const index = process.argv.indexOf('--anchor')
const anchorId = index >= 0 ? process.argv[index + 1] : undefined
if (!anchorId) throw new Error('--anchor is required')

const client = createDatabaseClient()
try {
  const result = await createAnchorClaimRepository(client).createChallenge({ anchorId })
  process.stdout.write(`${JSON.stringify({ event: 'anchor_claim_challenge_created', ...result })}\n`)
} finally {
  await client.pool.end()
}
