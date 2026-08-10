import { describe, expect, it } from 'vitest'
import type { SourceIdentity } from '../../lib/contracts/domain'
import { reconcileSupply } from '../../lib/reconcile/supply'
import { parseStellarAmount } from '../../lib/stellar/amount'

const NETWORK = {
  id: 'public' as const,
  passphrase: 'Public Global Stellar Network ; September 2015',
}
const ASSET = { kind: 'credit' as const, code: 'USDC', issuer: `G${'A'.repeat(55)}` }
const AS_OF = new Date('2026-08-10T12:00:30.000Z')
const HORIZON: SourceIdentity = {
  id: 'horizon_1', sourceClass: 'canonical_ledger', adapter: 'horizon',
  url: 'https://horizon.example', network: NETWORK,
}
const ARCHIVE: SourceIdentity = {
  id: 'archive_1', sourceClass: 'archive', adapter: 'archive',
  url: 'https://archive.example/supply.json', network: NETWORK,
}

function components(authorized = '700') {
  return {
    authorized_trustlines: parseStellarAmount(authorized),
    maintain_liabilities_trustlines: parseStellarAmount('100'),
    unauthorized_trustlines: parseStellarAmount('25'),
    claimable_balances: parseStellarAmount('50'),
    liquidity_pools: parseStellarAmount('75'),
    contract_balances: parseStellarAmount('50'),
  }
}

function horizonObservation(source = HORIZON, sourceTimestamp = '2026-08-10T12:00:00.000Z') {
  return {
    observationId: `observation_${source.id}`,
    cycleId: 'cycle_supply_500',
    metric: 'circulating_supply' as const,
    asset: ASSET,
    amount: parseStellarAmount('1000'),
    components: components(),
    ledgerSequence: 500,
    methodologyVersion: 'onchain-asset-supply-v0.1' as const,
    provenance: { source, sourceTimestamp, retrievedAt: '2026-08-10T12:00:10.000Z' },
    derivation: {
      family: 'horizon_asset_aggregate' as const,
      connectorVersion: 'horizon-supply-v0.1',
      evidenceSha256: 'a'.repeat(64),
      software: { name: 'stellar-horizon' as const, version: null },
      checkpoint: {
        kind: 'horizon_asset_page' as const,
        ledgerSequence: 500,
        terminalCursor: 'asset-500',
        pagesScanned: 1,
        recordsScanned: 1 as const,
      },
    },
  }
}

function archiveObservation(sourceTimestamp = '2026-08-10T12:00:00.000Z') {
  return {
    ...horizonObservation(ARCHIVE, sourceTimestamp),
    observationId: 'observation_archive_1',
    provenance: { source: ARCHIVE, sourceTimestamp, retrievedAt: '2026-08-10T12:00:11.000Z' },
    derivation: {
      family: 'history_archive_state_replay' as const,
      connectorVersion: 'archive-supply-v0.1',
      evidenceSha256: 'b'.repeat(64),
      software: { name: 'supply-replay', version: '1.0.0', stellarCoreVersion: '24.0.0' },
      checkpoint: {
        kind: 'history_archive_replay' as const,
        ledgerSequence: 500,
        ledgerHash: 'c'.repeat(64),
        trustedLedgerHash: 'c'.repeat(64),
        bucketListHash: 'd'.repeat(64),
        historyArchiveStateSha256: 'e'.repeat(64),
        trustedArtifactSha256: 'f'.repeat(64),
        trustProvenance: {
          manifestId: 'manifest_500',
          source: 'https://checkpoints.example/500.json',
          verificationMethod: 'trusted_manifest_signature' as const,
          verificationEvidenceSha256: '9'.repeat(64),
          verifiedAt: '2026-08-10T12:00:05.000Z',
        },
        replayStartLedger: 1,
        replayEndLedger: 500,
      },
    },
  }
}

function reconcile(observations: unknown[], configuredSources: SourceIdentity[] = [HORIZON, ARCHIVE]) {
  return reconcileSupply({
    cycleId: 'cycle_supply_500',
    snapshotId: 'snapshot_supply_500',
    asset: ASSET,
    configuredSources,
    observations,
    asOf: AS_OF,
  })
}

describe('supply reconciliation profile', () => {
  it('verifies exact observations from two independent derivation families', () => {
    const result = reconcile([horizonObservation(), archiveObservation()])

    expect(result.snapshot).toMatchObject({
      metric: 'circulating_supply',
      status: 'verified',
      value: { kind: 'amount' },
      sourcesConfigured: 2,
      sourcesUsable: 2,
      sourcesAgreeing: 2,
      methodologyVersion: 'onchain-asset-supply-v0.1',
    })
    expect(result.snapshot.value?.kind === 'amount' && result.snapshot.value.value.toString()).toBe('1000')
  })

  it('keeps Horizon replicas degraded because they share one derivation family', () => {
    const replica: SourceIdentity = { ...HORIZON, id: 'horizon_2', url: 'https://horizon-2.example' }
    const result = reconcile([horizonObservation(), horizonObservation(replica)], [HORIZON, replica])

    expect(result.snapshot.status).toBe('degraded')
    expect(result.snapshot.confidence.components.diversity).toBe(0.5)
    expect(result.snapshot.confidence.score).toBeLessThan(0.9)
  })

  it('records discrepancies when totals, components, ledgers, or close times differ', () => {
    const variants = [
      { ...archiveObservation(), amount: parseStellarAmount('1001'), components: components('701') },
      {
        ...archiveObservation(),
        components: {
          ...components(),
          authorized_trustlines: parseStellarAmount('699'),
          unauthorized_trustlines: parseStellarAmount('26'),
        },
      },
      {
        ...archiveObservation(), ledgerSequence: 501,
        derivation: {
          ...archiveObservation().derivation,
          checkpoint: { ...archiveObservation().derivation.checkpoint, ledgerSequence: 501, replayEndLedger: 501 },
        },
      },
      archiveObservation('2026-08-10T12:00:01.000Z'),
    ]

    for (const observation of variants) {
      const result = reconcile([horizonObservation(), observation])
      expect(result.snapshot).toMatchObject({ status: 'degraded', sourcesAgreeing: 1 })
      expect(result.snapshot.discrepancies).toHaveLength(1)
      expect(result.snapshot.discrepancies[0]?.details).toMatchObject({
        kind: 'supply_comparison',
        observedLedgerSequence: observation.ledgerSequence,
        referenceLedgerSequence: 500,
      })
      expect(result.events[0]).toMatchObject({ type: 'opened', deviationBand: 'above_info' })
    }
  })

  it('retains exact component differences even when aggregate totals match', () => {
    const observation = {
      ...archiveObservation(),
      components: {
        ...components(),
        authorized_trustlines: parseStellarAmount('699'),
        unauthorized_trustlines: parseStellarAmount('26'),
      },
    }
    const discrepancy = reconcile([horizonObservation(), observation]).snapshot.discrepancies[0]

    expect(discrepancy?.observedValue).toEqual(discrepancy?.referenceValue)
    expect(discrepancy?.details).toMatchObject({
      kind: 'supply_comparison',
      componentDifferences: [
        { component: 'authorized_trustlines', observed: parseStellarAmount('699'), reference: parseStellarAmount('700') },
        { component: 'unauthorized_trustlines', observed: parseStellarAmount('26'), reference: parseStellarAmount('25') },
      ],
    })
  })

  it('excludes stale readings and never reuses them as a current value', () => {
    const staleTimestamp = '2026-08-10T11:58:00.000Z'
    const result = reconcile([
      horizonObservation(HORIZON, staleTimestamp),
      archiveObservation(staleTimestamp),
    ])

    expect(result.snapshot).toMatchObject({
      status: 'unavailable',
      value: null,
      sourcesResponded: 2,
      sourcesUsable: 0,
    })
  })
})
