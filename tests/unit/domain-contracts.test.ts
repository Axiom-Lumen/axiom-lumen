import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  apiErrorResponseSchema,
  apiReconciliationSnapshotSchema,
  createApiErrorResponse,
  formatAssetId,
  parseAssetId,
  rawObservationSchema,
  networkIdentitySchema,
  reconciliationSnapshotSchema,
  retrievalAttemptSchema,
  serializePublicReconciliationSnapshot,
  sourceErrorCodeSchema,
  tradingPairSchema,
} from '../../lib/contracts'
import { StellarAmount } from '../../lib/stellar/amount'

const ISSUER = `G${'A'.repeat(55)}`
const NETWORK = {
  id: 'public' as const,
  passphrase: 'Public Global Stellar Network ; September 2015',
}
const SOURCE = {
  id: 'horizon_1',
  sourceClass: 'canonical_ledger' as const,
  adapter: 'horizon' as const,
  url: 'https://a.example/',
  network: NETWORK,
}
const PROVENANCE = {
  source: SOURCE,
  sourceTimestamp: '2026-08-09T13:00:00+01:00',
  retrievedAt: '2026-08-09T12:00:05Z',
  requestId: 'req_1',
}

function snapshotInput() {
  return {
    snapshotId: 'snapshot_1',
    cycleId: 'cycle_1',
    metric: 'latest_ledger' as const,
    subject: { kind: 'network' as const, network: NETWORK },
    status: 'degraded' as const,
    value: { kind: 'ledger' as const, value: 500 },
    confidence: {
      score: 0.85,
      formulaVersion: 'latest-ledger-confidence-v0.1',
      components: { agreement: 1, freshness: 1, availability: 0.5, spread: 0.8 },
      capsApplied: ['source_error'],
    },
    sourcesConfigured: 2,
    sourcesResponded: 1,
    sourcesUsable: 1,
    sourcesAgreeing: 1,
    sourcesExcluded: 0,
    contributions: [
      {
        observationId: 'obs_1',
        sourceId: 'horizon_1',
        sourceClass: 'canonical_ledger' as const,
        ageSeconds: 5,
        effectiveWeight: 0.8909,
        agrees: true,
      },
    ],
    discrepancies: [
      {
        id: 'disc_1',
        sourceId: 'horizon_1',
        severity: 'warning' as const,
        lifecycleState: 'open' as const,
        publicationState: 'approved_public' as const,
        consecutiveCycles: 1,
        observedValue: { kind: 'ledger' as const, value: 501 },
        referenceValue: { kind: 'ledger' as const, value: 500 },
        firstObservedAt: '2026-08-09T12:00:00Z',
        lastObservedAt: '2026-08-09T12:00:00Z',
      },
    ],
    sourceErrors: [
      {
        sourceId: 'horizon_2',
        sourceUrl: 'https://b.example/',
        code: 'request_failed' as const,
        category: 'transport' as const,
        message: 'Horizon request failed',
        occurredAt: '2026-08-09T12:00:00Z',
        retryable: true,
      },
    ],
    asOf: '2026-08-09T12:00:05Z',
    methodologyVersion: 'latest-ledger-v0.1',
  }
}

describe('domain contracts', () => {
  it('parses canonical native and credit asset identifiers', () => {
    expect(parseAssetId('native')).toEqual({ kind: 'native' })
    expect(parseAssetId('NATIVE')).toEqual({ kind: 'native' })
    const credit = parseAssetId(`USDC:${ISSUER}`)
    expect(credit).toEqual({ kind: 'credit', code: 'USDC', issuer: ISSUER })
    expect(formatAssetId(credit)).toBe(`USDC:${ISSUER}`)
  })

  it.each([`usdc:${ISSUER}`, 'USDC:not-an-account', 'USDC', 'USDC:issuer:extra'])('rejects invalid asset identifier %s', (asset) => {
    expect(() => parseAssetId(asset)).toThrow()
  })

  it('rejects a trading pair containing the same asset twice', () => {
    expect(() =>
      tradingPairSchema.parse({ base: { kind: 'native' }, counter: { kind: 'native' } }),
    ).toThrow(/must be different/)
  })

  it('rejects a known network ID paired with the wrong passphrase', () => {
    expect(() =>
      networkIdentitySchema.parse({
        id: 'public',
        passphrase: 'Test SDF Network ; September 2015',
      }),
    ).toThrow(/does not match public/)
  })

  it('parses and normalizes a discriminated latest-ledger observation', () => {
    const observation = rawObservationSchema.parse({
      observationId: 'obs_1',
      cycleId: 'cycle_1',
      metric: 'latest_ledger',
      ledgerSequence: 500,
      provenance: PROVENANCE,
    })

    expect(observation.metric).toBe('latest_ledger')
    expect(observation.provenance.sourceTimestamp).toBe('2026-08-09T12:00:00.000Z')
    expect(observation.provenance.retrievedAt).toBe('2026-08-09T12:00:05.000Z')
  })

  it('parses decimal amount strings into StellarAmount at the boundary', () => {
    const observation = rawObservationSchema.parse({
      observationId: 'obs_2',
      cycleId: 'cycle_1',
      metric: 'circulating_supply',
      asset: { kind: 'credit', code: 'USDC', issuer: ISSUER },
      amount: '48213092.4400001',
      components: {
        authorized_trustlines: '48213092.4400001',
        maintain_liabilities_trustlines: '0',
        unauthorized_trustlines: '0',
        claimable_balances: '0',
        liquidity_pools: '0',
        contract_balances: '0',
      },
      ledgerSequence: 500,
      methodologyVersion: 'onchain-asset-supply-v0.1',
      derivation: {
        family: 'horizon_asset_aggregate',
        connectorVersion: 'horizon-supply-v0.1',
        evidenceSha256: 'a'.repeat(64),
        software: { name: 'stellar-horizon', version: null },
        checkpoint: {
          kind: 'horizon_asset_page',
          ledgerSequence: 500,
          terminalCursor: 'asset-500',
          pagesScanned: 1,
          recordsScanned: 1,
        },
      },
      provenance: PROVENANCE,
    })

    expect(observation.metric).toBe('circulating_supply')
    if (observation.metric !== 'circulating_supply') throw new Error('unexpected metric')
    expect(observation.amount).toBeInstanceOf(StellarAmount)
    expect(observation.amount.toString()).toBe('48213092.4400001')
  })

  it('rejects unknown boundary fields instead of silently type-casting them', () => {
    expect(() =>
      rawObservationSchema.parse({
        observationId: 'obs_1',
        cycleId: 'cycle_1',
        metric: 'latest_ledger',
        ledgerSequence: 500,
        provenance: PROVENANCE,
        untrusted: true,
      }),
    ).toThrow(/Unrecognized key/)
  })

  it('rejects retrieval attempts that complete before they start', () => {
    expect(() =>
      retrievalAttemptSchema.parse({
        attemptId: 'attempt_1',
        cycleId: 'cycle_1',
        source: SOURCE,
        startedAt: '2026-08-09T12:00:05Z',
        completedAt: '2026-08-09T12:00:00Z',
        outcome: 'success',
        observationIds: ['obs_1'],
      }),
    ).toThrow(/cannot complete before it starts/)
  })

  it('represents depth connector failures in the shared source-error vocabulary', () => {
    expect(sourceErrorCodeSchema.parse('invalid_pair')).toBe('invalid_pair')
    expect(sourceErrorCodeSchema.parse('crossed_book')).toBe('crossed_book')
    expect(sourceErrorCodeSchema.parse('stale_book')).toBe('stale_book')
  })

  it('enforces snapshot availability and source-count invariants', () => {
    expect(() => reconciliationSnapshotSchema.parse({ ...snapshotInput(), status: 'unavailable' })).toThrow(
      /must have null value/,
    )
    expect(() => reconciliationSnapshotSchema.parse({ ...snapshotInput(), sourcesAgreeing: 2 })).toThrow(
      /agreeing sources exceed usable sources/,
    )
    expect(() =>
      reconciliationSnapshotSchema.parse({
        ...snapshotInput(),
        metric: 'circulating_supply',
      }),
    ).toThrow(/requires value kind amount/)
  })
})

describe('API contracts', () => {
  it('serializes domain camelCase to the versioned snake_case fixture', () => {
    const fixturePath = fileURLToPath(
      new URL('../fixtures/contracts/reconciliation-snapshot-v1.json', import.meta.url),
    )
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown
    const parsedFixture = apiReconciliationSnapshotSchema.parse(fixture)
    const snapshot = reconciliationSnapshotSchema.parse(snapshotInput())

    expect(serializePublicReconciliationSnapshot(snapshot, 'req_1')).toEqual(parsedFixture)
  })

  it('omits discrepancies that have not been approved for publication', () => {
    const input = snapshotInput()
    const snapshot = reconciliationSnapshotSchema.parse({
      ...input,
      discrepancies: input.discrepancies.map((discrepancy) => ({
        ...discrepancy,
        publicationState: 'internal',
      })),
    })

    expect(serializePublicReconciliationSnapshot(snapshot, 'req_2').discrepancies).toEqual([])
  })

  it('uses the scope-accurate public metric ID for supply snapshots', () => {
    const supplySnapshot = reconciliationSnapshotSchema.parse({
      ...snapshotInput(),
      metric: 'circulating_supply',
      subject: { kind: 'asset', asset: { kind: 'credit', code: 'USDC', issuer: ISSUER } },
      value: { kind: 'amount', value: '1000' },
      discrepancies: [],
      methodologyVersion: 'onchain-asset-supply-v0.1',
    })
    const publicSupply = serializePublicReconciliationSnapshot(supplySnapshot, 'req_supply')

    expect(publicSupply).toMatchObject({
      metric: 'onchain_asset_supply',
      subject: { kind: 'asset', asset: `USDC:${ISSUER}` },
      value: { kind: 'amount', value: '1000' },
      methodology_version: 'onchain-asset-supply-v0.1',
    })
    expect(() => apiReconciliationSnapshotSchema.parse({ ...publicSupply, metric: 'circulating_supply' })).toThrow()
  })

  it('serializes exact supply discrepancy context', () => {
    const supplySnapshot = reconciliationSnapshotSchema.parse({
      ...snapshotInput(),
      metric: 'circulating_supply',
      subject: { kind: 'asset', asset: { kind: 'credit', code: 'USDC', issuer: ISSUER } },
      value: { kind: 'amount', value: '1000' },
      discrepancies: [{
        ...snapshotInput().discrepancies[0],
        observedValue: { kind: 'amount', value: '1000' },
        referenceValue: { kind: 'amount', value: '1000' },
        details: {
          kind: 'supply_comparison',
          observedLedgerSequence: 501,
          referenceLedgerSequence: 500,
          observedSourceTimestamp: '2026-08-09T12:00:01Z',
          referenceSourceTimestamp: '2026-08-09T12:00:00Z',
          componentDifferences: [{
            component: 'contract_balances',
            observed: '11',
            reference: '10',
            absoluteDelta: '1',
          }],
        },
      }],
      methodologyVersion: 'onchain-asset-supply-v0.1',
    })

    expect(serializePublicReconciliationSnapshot(supplySnapshot, 'req_supply_details').discrepancies[0]).toMatchObject({
      observed_value: { kind: 'amount', value: '1000' },
      reference_value: { kind: 'amount', value: '1000' },
      details: {
        kind: 'supply_comparison',
        observed_ledger_sequence: 501,
        reference_ledger_sequence: 500,
        component_differences: [{
          component: 'contract_balances',
          observed: '11',
          reference: '10',
          absolute_delta: '1',
        }],
      },
    })
  })

  it('serializes bigint counts and amounts as strings', () => {
    const countSnapshot = reconciliationSnapshotSchema.parse({
      ...snapshotInput(),
      metric: 'trustline_count',
      subject: { kind: 'asset', asset: { kind: 'native' } },
      value: { kind: 'count', value: '900719925474099312345' },
      discrepancies: [],
    })

    expect(serializePublicReconciliationSnapshot(countSnapshot, 'req_3').value).toEqual({
      kind: 'count',
      value: '900719925474099312345',
    })
  })

  it('creates and validates a standard error response with UTC metadata', () => {
    const response = createApiErrorResponse({
      code: 'invalid_asset',
      message: 'Asset must be native or CODE:ISSUER',
      requestId: 'req_4',
      asOf: new Date('2026-08-09T12:00:00Z'),
      details: { field: 'asset' },
    })

    expect(apiErrorResponseSchema.parse(response)).toEqual(response)
    expect(response.as_of).toBe('2026-08-09T12:00:00.000Z')
  })
})
