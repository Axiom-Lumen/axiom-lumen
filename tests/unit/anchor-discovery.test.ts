import { describe, expect, it, vi } from 'vitest'
import { discoverAnchor } from '../../lib/stellar/anchor-discovery'

const ISSUER = `G${'A'.repeat(55)}`
const ASSET = { kind: 'credit' as const, code: 'USDC', issuer: ISSUER }
const NETWORK = { id: 'public' as const, passphrase: 'Public Global Stellar Network ; September 2015' }
const TOML = `
NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015"
[DOCUMENTATION]
ORG_NAME = "Example Anchor"
ORG_OFFICIAL_EMAIL = "ops@anchor.example"
[[CURRENCIES]]
code = "USDC"
issuer = "${ISSUER}"
is_asset_anchored = true
anchor_asset_type = "fiat"
anchor_asset = "USD"
attestation_of_reserve = "https://evidence.example/reserve.json"
`
const publicResolver = vi.fn(async () => ['93.184.216.34'])

function fetcher(account: Record<string, unknown> = { account_id: ISSUER, home_domain: 'anchor.example' }) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url === 'https://horizon.example/') return Response.json({ network_passphrase: NETWORK.passphrase })
    if (url.includes(`/accounts/${ISSUER}`)) return new Response(JSON.stringify(account), { headers: { 'content-type': 'application/json' } })
    if (url === 'https://anchor.example/.well-known/stellar.toml') return new Response(TOML, { headers: { 'content-type': 'text/plain' } })
    throw new Error(`unexpected URL ${url}`)
  })
}

function connector(account?: Record<string, unknown>) {
  const request = fetcher(account)
  return vi.fn(async (target: { url: URL }) => request(target.url))
}

describe('verified anchor discovery', () => {
  it('proves the issuer, home domain, SEP-1 currency, and reserve evidence chain', async () => {
    const result = await discoverAnchor({ horizonUrl: 'https://horizon.example', network: NETWORK, asset: ASSET, connectImpl: connector(), resolve: publicResolver, clock: () => new Date('2026-08-11T12:00:00.000Z') })
    expect(result).toMatchObject({
      issuer: ISSUER,
      homeDomain: 'anchor.example',
      organizationName: 'Example Anchor',
      attestationUrl: 'https://evidence.example/reserve.json',
      contacts: [{ kind: 'email', endpoint: 'ops@anchor.example' }],
      evidence: { accountSha256: expect.stringMatching(/^[0-9a-f]{64}$/), horizonRootSha256: expect.stringMatching(/^[0-9a-f]{64}$/), stellarTomlSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
  })

  it('rejects an issuer account without a home domain', async () => {
    await expect(discoverAnchor({ horizonUrl: 'https://horizon.example', network: NETWORK, asset: ASSET, connectImpl: connector({ account_id: ISSUER }), resolve: publicResolver })).rejects.toThrow('does not publish a home domain')
  })

  it('rejects a stellar.toml host that resolves to a private address', async () => {
    await expect(discoverAnchor({ horizonUrl: 'https://horizon.example', network: NETWORK, asset: ASSET, connectImpl: connector(), resolve: async () => ['127.0.0.1'] })).rejects.toThrow('non-public address')
  })

  it('rejects insecure configured Horizon endpoints', async () => {
    await expect(discoverAnchor({ horizonUrl: 'http://horizon.example', network: NETWORK, asset: ASSET, connectImpl: connector(), resolve: publicResolver })).rejects.toThrow('must use HTTPS')
  })
})
