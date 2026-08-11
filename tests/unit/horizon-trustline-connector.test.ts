import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { fetchHorizonTrustlineObservation } from '../../lib/stellar/horizon-trustlines'
import { PUBLIC_NETWORK_PASSPHRASE } from '../../lib/stellar/horizon'

const ISSUER = `G${'A'.repeat(55)}`; const ROOT = 'https://horizon.example'; const NOW = new Date('2026-08-10T12:00:05.000Z')
const asset = { kind: 'credit' as const, code: 'USDC', issuer: ISSUER }
const network = { id: 'public' as const, passphrase: PUBLIC_NETWORK_PASSPHRASE }
const source = { id: 'horizon_1', url: ROOT, sourceClass: 'canonical_ledger' as const, adapter: 'horizon' as const, network }
const fixture = JSON.parse(readFileSync(new URL('../fixtures/stellar/horizon-supply-asset.json', import.meta.url), 'utf8')) as Record<string, unknown>
function connectorFetch(record: unknown = fixture) {
  return vi.fn(async (input: string | URL | Request) => {
    const target = String(input)
    if (target === `${ROOT}/`) return Response.json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
    if (target === `${ROOT}/accounts/${ISSUER}`) return Response.json({ account_id: ISSUER }, { headers: { 'Latest-Ledger': '499' } })
    if (target.startsWith(`${ROOT}/assets?`)) return Response.json({ _links: {}, _embedded: { records: [record] } }, { headers: { 'Latest-Ledger': '500' } })
    if (target === `${ROOT}/ledgers/500`) return Response.json({ sequence: 500, closed_at: '2026-08-10T12:00:00Z' })
    throw new Error(`unexpected URL ${target}`)
  })
}

describe('Horizon trustline-state connector', () => {
  it('normalizes mutually exclusive authorization states at one ledger', async () => {
    const result = await fetchHorizonTrustlineObservation({ observationId: 'trustline_1', cycleId: 'cycle_1', source, asset, expectedNetwork: network, fetchImpl: connectorFetch(), clock: () => new Date(NOW) })
    expect(result.error).toBeUndefined()
    expect(result.observation).toMatchObject({ metric: 'trustline_count', total: 825n, states: { authorized: 700n, authorized_to_maintain_liabilities: 100n, unauthorized: 25n }, ledgerSequence: 500, methodologyVersion: 'trustline-state-v0.1', derivation: { family: 'horizon_asset_aggregate' } })
  })
  it('rejects an asset aggregate without authorization-state counts', async () => {
    const malformed = structuredClone(fixture); delete malformed.accounts
    const result = await fetchHorizonTrustlineObservation({ observationId: 'trustline_1', cycleId: 'cycle_1', source, asset, expectedNetwork: network, fetchImpl: connectorFetch(malformed), clock: () => new Date(NOW) })
    expect(result.error).toMatchObject({ code: 'malformed_payload' })
  })
  it('does not require supply-only balance fields', async () => {
    const trustlineOnly = structuredClone(fixture)
    delete trustlineOnly.balances
    delete trustlineOnly.claimable_balances_amount
    delete trustlineOnly.liquidity_pools_amount
    delete trustlineOnly.contracts_amount
    const result = await fetchHorizonTrustlineObservation({ observationId: 'trustline_1', cycleId: 'cycle_1', source, asset, expectedNetwork: network, fetchImpl: connectorFetch(trustlineOnly), clock: () => new Date(NOW) })
    expect(result.error).toBeUndefined()
    expect(result.observation).toMatchObject({ total: 825n, ledgerSequence: 500 })
  })
})
