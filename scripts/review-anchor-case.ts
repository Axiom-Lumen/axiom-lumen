import { createAnchorCaseRepository } from '../lib/db/anchor-case-repository'
import { createDatabaseClient } from '../lib/db/client'

function option(name: string) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

async function main() {
  const caseId = option('--case')
  const reviewerPrincipalId = option('--reviewer')
  const decision = option('--decision')
  if (!['approve_public', 'withhold'].includes(decision)) throw new Error('--decision must be approve_public or withhold')
  const allowNamedPartyPublication = process.env.ANCHOR_NAMED_PARTY_PUBLICATION_ENABLED === 'true'
  const client = createDatabaseClient()
  try {
    const result = await createAnchorCaseRepository(client).reviewCase({
      caseId,
      reviewerPrincipalId,
      decision: decision as 'approve_public' | 'withhold',
      reviewedAt: new Date().toISOString(),
      allowNamedPartyPublication,
    })
    process.stdout.write(`${JSON.stringify({ event: 'anchor_case_reviewed', ...result })}\n`)
  } finally {
    await client.pool.end()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'anchor case review failed'}\n`)
  process.exitCode = 1
})
