import { createAnchorClaimRepository } from '../lib/db/anchor-claim-repository'
import { createDatabaseClient } from '../lib/db/client'

function option(name: string) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`${name} is required`)
  return value
}
async function stdin() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const action = option('--action')
if (!['corrected', 'retracted'].includes(action)) throw new Error('--action must be corrected or retracted')
const bandIndex = process.argv.indexOf('--corrected-deviation-band')
const correctedDeviationBand = bandIndex >= 0 ? process.argv[bandIndex + 1] : undefined
if (action === 'corrected' && !['within_tolerance', 'info', 'above_info'].includes(correctedDeviationBand ?? '')) {
  throw new Error('--corrected-deviation-band is required for corrected and must be within_tolerance, info, or above_info')
}
if (action === 'retracted' && correctedDeviationBand) throw new Error('--corrected-deviation-band is not valid for retracted')
const client = createDatabaseClient()
try {
  const result = await createAnchorClaimRepository(client).correctFlag({
    caseId: option('--case'), targetEventId: option('--event'), principalId: option('--principal'),
    action: action as 'corrected' | 'retracted', reason: await stdin(),
    ...(correctedDeviationBand ? { correctedDeviationBand: correctedDeviationBand as 'within_tolerance' | 'info' | 'above_info' } : {}),
  })
  process.stdout.write(`${JSON.stringify({ event: 'anchor_flag_amended', ...result })}\n`)
} finally {
  await client.pool.end()
}
