import { createAnchorClaimRepository } from '../lib/db/anchor-claim-repository'
import { createDatabaseClient } from '../lib/db/client'

const token = process.env.ANCHOR_CLAIM_SESSION_TOKEN
if (!token) throw new Error('ANCHOR_CLAIM_SESSION_TOKEN is required')
const client = createDatabaseClient()
try {
  const revoked = await createAnchorClaimRepository(client).revokeSession({ sessionToken: token })
  if (!revoked) throw new Error('claim session is unavailable or already revoked')
  process.stdout.write(`${JSON.stringify({ event: 'anchor_claim_session_revoked' })}\n`)
} finally {
  await client.pool.end()
}
