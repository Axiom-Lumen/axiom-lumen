import { createAnchorClaimRepository } from '../lib/db/anchor-claim-repository'
import { createDatabaseClient } from '../lib/db/client'

const token = process.env.ANCHOR_CLAIM_SESSION_TOKEN
if (!token) throw new Error('ANCHOR_CLAIM_SESSION_TOKEN is required')
const index = process.argv.indexOf('--contact')
const contactEndpointId = index >= 0 ? process.argv[index + 1] : undefined
if (!contactEndpointId) throw new Error('--contact is required')

const client = createDatabaseClient()
try {
  const result = await createAnchorClaimRepository(client).revokeContact({ sessionToken: token, contactEndpointId })
  process.stdout.write(`${JSON.stringify({ event: 'anchor_contact_revoked', ...result })}\n`)
} finally {
  await client.pool.end()
}
