import { createAnchorClaimRepository } from '../lib/db/anchor-claim-repository'
import { createDatabaseClient } from '../lib/db/client'

function option(name: string) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`${name} is required`)
  return value
}

const principalId = option('--principal')
const disputeIndex = process.argv.indexOf('--dispute')
const disputeId = disputeIndex >= 0 ? process.argv[disputeIndex + 1] : undefined
const client = createDatabaseClient()
try {
  const repository = createAnchorClaimRepository(client)
  const result = disputeId
    ? await repository.getDisputeForReview({ disputeId, principalId })
    : await repository.listDisputesForReview(principalId)
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await client.pool.end()
}
