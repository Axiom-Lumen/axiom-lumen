import { describe, expect, it } from 'vitest'
import { reconcileAnchorReserve } from '../../lib/reconcile/anchor-reserve'
import { parseStellarAmount } from '../../lib/stellar/amount'

const ISSUER = `G${'A'.repeat(55)}`
const asset = { kind: 'credit' as const, code: 'USDC', issuer: ISSUER }
const source = { id: 'anchor_source', sourceClass: 'anchor_self_reported' as const, adapter: 'anchor' as const, url: 'https://evidence.example/reserve.json', network: { id: 'public' as const, passphrase: 'Public Global Stellar Network ; September 2015' } }
function observation(amount: string, cycleId = 'cycle_1') {
  return {
    observationId: `observation_${cycleId}`, cycleId, metric: 'anchor_reserves', anchorId: 'anchor_1', asset,
    amount, unit: { kind: 'asset_units', asset }, attestationPeriodStart: '2026-08-11T11:00:00Z',
    attestationPeriodEnd: '2026-08-11T11:59:00Z', publishedAt: '2026-08-11T12:00:00Z',
    methodologyVersion: 'anchor-reserve-comparison-v0.1',
    attestation: { schema: 'axiom-lumen-anchor-reserve-attestation-v1', evidenceSha256: 'a'.repeat(64), documentUrl: source.url },
    provenance: { source, sourceTimestamp: '2026-08-11T11:59:00Z', retrievedAt: '2026-08-11T12:00:00Z' },
  }
}
const reference = {
  snapshotId: 'supply_snapshot_1', cycleId: 'supply_cycle_1', amount: parseStellarAmount('1000'),
  asOf: '2026-08-11T11:59:45.000Z', ledgerSequence: 500, ledgerClosedAt: '2026-08-11T11:59:30.000Z',
  status: 'verified' as const, confidence: 0.95, methodologyVersion: 'onchain-asset-supply-v0.1',
  evidence: [{ readingId: 'supply_reading_1', observationId: 'supply_observation_1', sourceId: 'supply_source_1', payloadSha256: 'b'.repeat(64), ledgerSequence: 500, ledgerClosedAt: '2026-08-11T11:59:30.000Z' }],
}

describe('anchor reserve comparison', () => {
  it('remains degraded and non-public even when reserve and supply agree', () => {
    const result = reconcileAnchorReserve({ cycleId: 'cycle_1', snapshotId: 'snapshot_1', asset, anchorId: 'anchor_1', configuredSource: source, observation: observation('1000'), supplyReference: reference, asOf: new Date('2026-08-11T12:00:05.000Z') })
    expect(result.snapshot).toMatchObject({ status: 'degraded', sourcesAgreeing: 1, discrepancies: [], confidence: { capsApplied: expect.arrayContaining(['anchor_self_reported', 'named_party_publication_withheld']) } })
  })

  it('opens a named-party Warning internally until notification activates the reply gate', () => {
    const result = reconcileAnchorReserve({ cycleId: 'cycle_1', snapshotId: 'snapshot_1', asset, anchorId: 'anchor_1', configuredSource: source, observation: observation('970'), supplyReference: reference, asOf: new Date('2026-08-11T12:00:05.000Z') })
    expect(result.snapshot.discrepancies[0]).toMatchObject({ severity: 'warning', publicationState: 'internal', details: { kind: 'anchor_reserve_comparison', supplySnapshotId: 'supply_snapshot_1', supplyLedgerSequence: 500 } })
    expect(result.discrepancyStates.anchor_source).toMatchObject({ namedParty: true, replyReviewState: 'not_required' })
  })

  it('escalates only after three consecutive cycles and resolves on reconvergence', () => {
    const first = reconcileAnchorReserve({ cycleId: 'cycle_1', snapshotId: 'snapshot_1', asset, anchorId: 'anchor_1', configuredSource: source, observation: observation('970', 'cycle_1'), supplyReference: reference, asOf: new Date('2026-08-11T12:00:05.000Z') })
    const second = reconcileAnchorReserve({ cycleId: 'cycle_2', snapshotId: 'snapshot_2', asset, anchorId: 'anchor_1', configuredSource: source, observation: observation('970', 'cycle_2'), supplyReference: reference, priorState: first.discrepancyStates.anchor_source, asOf: new Date('2026-08-11T12:01:05.000Z') })
    const third = reconcileAnchorReserve({ cycleId: 'cycle_3', snapshotId: 'snapshot_3', asset, anchorId: 'anchor_1', configuredSource: source, observation: observation('970', 'cycle_3'), supplyReference: reference, priorState: second.discrepancyStates.anchor_source, asOf: new Date('2026-08-11T12:02:05.000Z') })
    expect(third.discrepancyStates.anchor_source).toMatchObject({ severity: 'critical', consecutiveAboveInfoCycles: 3, publicationState: 'internal' })
    const resolved = reconcileAnchorReserve({ cycleId: 'cycle_4', snapshotId: 'snapshot_4', asset, anchorId: 'anchor_1', configuredSource: source, observation: observation('1000', 'cycle_4'), supplyReference: reference, priorState: third.discrepancyStates.anchor_source, asOf: new Date('2026-08-11T12:03:05.000Z') })
    expect(resolved.discrepancyStates.anchor_source).toMatchObject({ lifecycleState: 'resolved', consecutiveCycles: 0 })
    expect(resolved.events.map((event) => event.type)).toEqual(['reconverged', 'resolved'])
  })

  it('handles a zero supply reference without division or numeric discrepancy errors', () => {
    const zeroReference = { ...reference, amount: parseStellarAmount('0') }
    const agreeing = reconcileAnchorReserve({ cycleId: 'cycle_zero', snapshotId: 'snapshot_zero', asset, anchorId: 'anchor_1', configuredSource: source, observation: observation('0', 'cycle_zero'), supplyReference: zeroReference, asOf: new Date('2026-08-11T12:00:05.000Z') })
    expect(agreeing.snapshot).toMatchObject({ sourcesAgreeing: 1, discrepancies: [] })
    const mismatch = reconcileAnchorReserve({ cycleId: 'cycle_nonzero', snapshotId: 'snapshot_nonzero', asset, anchorId: 'anchor_1', configuredSource: source, observation: observation('1', 'cycle_nonzero'), supplyReference: zeroReference, asOf: new Date('2026-08-11T12:00:05.000Z') })
    expect(mismatch.snapshot.discrepancies[0]).toMatchObject({ details: { deltaBasisPoints: 10_000 } })
  })
})
