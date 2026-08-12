import { createAnchorClaimRepository } from '../lib/db/anchor-claim-repository'
import { createDatabaseClient } from '../lib/db/client'

function option(name: string) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`${name} is required`)
  return value
}

const decision = option('--decision')
if (decision !== 'resolved' && decision !== 'rejected') throw new Error('--decision must be resolved or rejected')
const publish = process.argv.includes('--publish')
const client = createDatabaseClient()
try {
  const result = await createAnchorClaimRepository(client).resolveDispute({
    disputeId: option('--dispute'), principalId: option('--principal'), decision,
    publish, allowNamedPartyPublication: process.env.ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED === 'true',
  })
  process.stdout.write(`${JSON.stringify({ event: 'anchor_dispute_reviewed', ...result })}\n`)
} finally {
  await client.pool.end()
}
