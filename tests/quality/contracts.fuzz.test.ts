import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  apiReconciliationSnapshotSchema,
  circulatingSupplyObservationSchema,
  reconciliationSnapshotSchema,
  sourceErrorSchema,
} from '../../lib/contracts'
import { fetchLatestLedgersFromHorizonSources, PUBLIC_NETWORK_PASSPHRASE } from '../../lib/stellar/horizon'
import { fetchHorizonOrderBookDepth } from '../../lib/stellar/horizon-depth'
import { fetchHorizonOnchainAssetSupply } from '../../lib/stellar/horizon-supply'
import { fetchHorizonTrustlineObservation } from '../../lib/stellar/horizon-trustlines'

const issuer = `G${'A'.repeat(55)}`
const root = 'https://horizon.example'
const asset = { kind: 'credit' as const, code: 'USDC', issuer }
const network = { id: 'public' as const, passphrase: PUBLIC_NETWORK_PASSPHRASE }
const source = {
  id: 'horizon_1', url: root, sourceClass: 'canonical_ledger' as const, adapter: 'horizon' as const, network,
}
const now = new Date('2026-08-13T10:00:05.000Z')

function aggregateFetch(record: unknown) {
  return async (input: string | URL | Request) => {
    const target = String(input)
    if (target === `${root}/`) return Response.json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
    if (target === `${root}/accounts/${issuer}`) {
      return Response.json({ account_id: issuer }, { headers: { 'Latest-Ledger': '499' } })
    }
    if (target.startsWith(`${root}/assets?`)) {
      return Response.json({ _links: {}, _embedded: { records: [record] } }, { headers: { 'Latest-Ledger': '500' } })
    }
    if (target === `${root}/ledgers/500`) {
      return Response.json({ sequence: 500, closed_at: '2026-08-13T10:00:00.000Z' })
    }
    throw new Error(`unexpected connector fuzz URL: ${target}`)
  }
}

const boundarySchemas = [
  circulatingSupplyObservationSchema,
  reconciliationSnapshotSchema,
  apiReconciliationSnapshotSchema,
  sourceErrorSchema,
]

describe('malformed boundary-input fuzzing', () => {
  it('rejects or parses arbitrary JSON without leaking an internal exception', () => {
    fc.assert(fc.property(fc.jsonValue(), (payload) => {
      for (const schema of boundarySchemas) {
        expect(() => schema.safeParse(payload)).not.toThrow()
      }
    }), { numRuns: 500 })
  })

  it('rejects prototype-shaped and deeply nested malformed payloads', () => {
    const malformed = [
      JSON.parse('{"__proto__":{"authorization":"secret"}}'),
      { provenance: { source: { url: 'file:///etc/passwd' } } },
      { amount: '1e100', ledgerSequence: Number.MAX_SAFE_INTEGER + 1 },
      { sourceErrors: [{ message: { nested: Array.from({ length: 100 }, () => ({})) } }] },
    ]

    for (const payload of malformed) {
      for (const schema of boundarySchemas) expect(schema.safeParse(payload).success).toBe(false)
    }
  })

  it('contains arbitrary Horizon root and latest-ledger payloads at the connector boundary', async () => {
    await fc.assert(fc.asyncProperty(fc.jsonValue(), fc.boolean(), async (payload, fuzzRoot) => {
      const result = await fetchLatestLedgersFromHorizonSources({
        sources: [{ id: 'horizon_1', url: root }],
        fetchImpl: async (input) => String(input).endsWith('/')
          ? Response.json(fuzzRoot ? payload : { network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
          : Response.json(fuzzRoot ? { _embedded: { records: [] } } : payload),
        clock: () => new Date(now),
      })
      expect(result.observations.length + result.source_errors.length).toBeGreaterThan(0)
    }), { numRuns: 100 })
  })

  it('contains arbitrary supply and trustline aggregate records at connector boundaries', async () => {
    await fc.assert(fc.asyncProperty(fc.jsonValue(), async (record) => {
      const fetchImpl = aggregateFetch(record)
      const [supply, trustlines] = await Promise.all([
        fetchHorizonOnchainAssetSupply({ source, asset, expectedNetwork: network, fetchImpl, clock: () => new Date(now) }),
        fetchHorizonTrustlineObservation({
          observationId: 'trustline-fuzz', cycleId: 'cycle-fuzz', source, asset, expectedNetwork: network,
          fetchImpl, clock: () => new Date(now),
        }),
      ])
      expect(supply.error ?? supply.observation).toBeDefined()
      expect(trustlines.error ?? trustlines.observation).toBeDefined()
    }), { numRuns: 100 })
  })

  it('contains arbitrary SDEX offer records at the depth connector boundary', async () => {
    const depthSource = { ...source, sourceClass: 'dex' as const, adapter: 'sdex' as const }
    await fc.assert(fc.asyncProperty(fc.jsonValue(), async (record) => {
      const result = await fetchHorizonOrderBookDepth({
        source: depthSource,
        pair: { base: { kind: 'native' }, counter: asset },
        expectedNetwork: network,
        fetchImpl: async (input) => {
          const target = String(input)
          if (target === `${root}/`) return Response.json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
          if (target.includes('/offers?')) {
            return Response.json(
              { _links: {}, _embedded: { records: [record] } },
              { headers: { 'Latest-Ledger': '500' } },
            )
          }
          if (target === `${root}/ledgers/500`) {
            return Response.json({ sequence: 500, closed_at: '2026-08-13T10:00:00.000Z' })
          }
          throw new Error(`unexpected depth fuzz URL: ${target}`)
        },
        clock: () => new Date(now),
      })
      expect(result.error ?? result.observation).toBeDefined()
    }), { numRuns: 100 })
  })
})
