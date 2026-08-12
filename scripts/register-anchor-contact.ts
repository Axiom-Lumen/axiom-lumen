import { parseContactSecretKeyring } from '../lib/anchor/contact-secret'
import { createAnchorClaimRepository } from '../lib/db/anchor-claim-repository'
import { createDatabaseClient } from '../lib/db/client'

function option(name: string) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`${name} is required`)
  return value
}

const sessionToken = process.env.ANCHOR_CLAIM_SESSION_TOKEN
if (!sessionToken) throw new Error('ANCHOR_CLAIM_SESSION_TOKEN is required')
const kind = option('--kind')
if (kind !== 'email' && kind !== 'webhook') throw new Error('--kind must be email or webhook')
const webhookSecret = kind === 'webhook' ? process.env.ANCHOR_WEBHOOK_SECRET : undefined
if (kind === 'webhook' && !webhookSecret) throw new Error('ANCHOR_WEBHOOK_SECRET is required for webhook contacts')

const client = createDatabaseClient()
try {
  const result = await createAnchorClaimRepository(client, {
    ...(kind === 'webhook' ? { contactSecretKeyring: parseContactSecretKeyring() } : {}),
  }).registerVerifiedContact({
    sessionToken,
    kind,
    endpoint: option('--endpoint'),
    ...(webhookSecret ? { webhookSecret } : {}),
  })
  process.stdout.write(`${JSON.stringify({ event: 'anchor_contact_verified', ...result })}\n`)
} finally {
  await client.pool.end()
}
