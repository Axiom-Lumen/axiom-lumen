import { eq } from 'drizzle-orm'
import { createDatabaseClient } from '../lib/db/client'
import { createAnchorRepository } from '../lib/db/anchor-repository'
import { networks } from '../lib/db/schema'
import { creditAssetSchema, networkIdSchema, parseAssetId } from '../lib/contracts/domain'
import { discoverAnchor } from '../lib/stellar/anchor-discovery'
import { parseHorizonHostList } from '../lib/stellar/horizon'

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} is required`)
  return value
}

async function main() {
  const networkId = networkIdSchema.parse(argument('network'))
  const asset = creditAssetSchema.parse(parseAssetId(argument('asset')))
  const horizonUrl = argument('horizon')
  const client = createDatabaseClient()
  try {
    const configured = await client.db.select({ id: networks.id, passphrase: networks.passphrase })
      .from(networks).where(eq(networks.id, networkId)).limit(1)
    if (!configured[0]) throw new Error(`network ${networkId} is not registered`)
    const repository = createAnchorRepository(client)
    let discovery
    try {
      discovery = await discoverAnchor({
        horizonUrl,
        network: { id: networkId, passphrase: configured[0].passphrase },
        asset,
        endpointPolicy: {
          allowedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_ALLOWED_HOSTS),
          deniedHosts: parseHorizonHostList(process.env.STELLAR_HORIZON_DENIED_HOSTS),
        },
      })
    } catch (error) {
      await repository.suspendVerification({
        networkId,
        issuer: asset.issuer,
        asset,
        occurredAt: new Date().toISOString(),
        failureCode: error instanceof Error ? error.name : 'UnknownError',
      })
      throw error
    }
    const persisted = await repository.persistVerifiedDiscovery({ networkId, discovery })
    console.log(JSON.stringify({
      event: 'anchor_discovery_complete',
      network: networkId,
      asset: `${asset.code}:${asset.issuer}`,
      homeDomain: discovery.homeDomain,
      ...persisted,
    }))
  } finally {
    await client.pool.end()
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: 'anchor_discovery_failed', errorType: error instanceof Error ? error.name : 'UnknownError' }))
  process.exitCode = 1
})
