import { parseContactSecretKeyring } from '../lib/anchor/contact-secret'
import { createAnchorCaseRepository } from '../lib/db/anchor-case-repository'
import { createDatabaseClient } from '../lib/db/client'

function option(name: string) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

async function main() {
  const contactEndpointId = option('--contact')
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const secret = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  const keyring = parseContactSecretKeyring()
  const client = createDatabaseClient()
  try {
    const result = await createAnchorCaseRepository(client).rotateContactSecret({
      contactEndpointId,
      secret,
      rotatedAt: new Date().toISOString(),
      keyring,
    })
    process.stdout.write(`${JSON.stringify({ event: 'anchor_contact_secret_rotated', contactEndpointId, ...result })}\n`)
  } finally {
    await client.pool.end()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'contact secret rotation failed'}\n`)
  process.exitCode = 1
})
