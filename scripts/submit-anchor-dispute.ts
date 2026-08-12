import { createEvidenceRuntimeFromEnvironment } from '../lib/anchor/evidence-runtime'
import { createAnchorClaimRepository } from '../lib/db/anchor-claim-repository'
import { createDatabaseClient } from '../lib/db/client'
import { evidenceFromArguments } from './anchor-evidence-input'

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

const flagId = option('--flag')
const sessionToken = process.env.ANCHOR_CLAIM_SESSION_TOKEN
if (!sessionToken) throw new Error('ANCHOR_CLAIM_SESSION_TOKEN is required')
const evidence = await evidenceFromArguments(process.argv.slice(2))
const uploadRuntime = evidence.some((item) => item.kind === 'upload') ? createEvidenceRuntimeFromEnvironment() : {}
const client = createDatabaseClient()
try {
  const result = await createAnchorClaimRepository(client, uploadRuntime).submitDispute({ flagId, sessionToken, body: await stdin(), evidence })
  process.stdout.write(`${JSON.stringify({ event: 'anchor_dispute_submitted', ...result })}\n`)
} finally {
  await client.pool.end()
}
