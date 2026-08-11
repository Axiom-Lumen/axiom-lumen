import { describe, expect, it } from 'vitest'
import { DEPTH_PRICE_BANDS_BPS } from '../../config/methodology'
import { formatTradingPairId, parseTradingPairId, type SourceIdentity } from '../../lib/contracts'
import { reconcileDepth } from '../../lib/reconcile/depth'

const ISSUER = `G${'A'.repeat(55)}`
const pair = parseTradingPairId(`native~USDC:${ISSUER}`)
const now = '2026-08-10T12:00:00.000Z'
function source(id: string): SourceIdentity {
  return { id, sourceClass: 'dex', adapter: 'sdex', url: `https://${id}.example`, network: { id: 'public', passphrase: 'Public Global Stellar Network ; September 2015' } }
}
function observation(identity: SourceIdentity, outer = 300, ledger = 500, price = { numerator: '2', denominator: '1', decimal: '2.0000000' }) {
  return {
    observationId: `observation_${identity.id}_${ledger}`, cycleId: 'cycle_depth', metric: 'order_book_depth' as const, pair,
    buckets: (['bid', 'ask'] as const).flatMap((side) => DEPTH_PRICE_BANDS_BPS.map((priceBandBasisPoints, index) => ({ side, priceBandBasisPoints, amount: String(index === 2 ? outer : (index + 1) * 100) }))),
    referencePrice: price, ledgerSequence: ledger, ledgerClosedAt: now,
    provenance: { source: identity, sourceTimestamp: now, retrievedAt: now },
    derivation: { family: 'horizon_sdex_offers' as const, connectorVersion: 'horizon-depth-v0.1', evidenceSha256: 'a'.repeat(64) },
  }
}

describe('depth reconciliation v0.2', () => {
  it('canonicalizes reversed route pairs without changing their identity', () => {
    expect(formatTradingPairId(parseTradingPairId(`USDC:${ISSUER}~native`))).toBe(`native~USDC:${ISSUER}`)
  })

  it('persists one coherent six-bucket book and caps Horizon replicas', () => {
    const left = source('left'); const right = source('right')
    const result = reconcileDepth({ cycleId: 'cycle_depth', snapshotId: 'snapshot_depth', pair, configuredSources: [left, right], observations: [observation(left), observation(right)], asOf: new Date(now) })
    expect(result.snapshot.status).toBe('degraded')
    expect(result.snapshot.confidence.capsApplied).toContain('same_upstream_replicas')
    expect(result.snapshot.sourcesAgreeing).toBe(2)
    expect(result.snapshot.value).toMatchObject({ kind: 'depth', ledgerSequence: 500, buckets: expect.arrayContaining([expect.objectContaining({ side: 'bid', priceBandBasisPoints: 500 })]) })
  })

  it('uses decimal-safe tolerance and reports an outlier by bucket', () => {
    const left = source('left'); const right = source('right'); const outlier = source('outlier')
    const result = reconcileDepth({ cycleId: 'cycle_depth', snapshotId: 'snapshot_depth', pair, configuredSources: [left, right, outlier], observations: [observation(left), observation(right, 301), observation(outlier, 900)], asOf: new Date(now) })
    expect(result.snapshot.sourcesAgreeing).toBe(2)
    expect(result.snapshot.discrepancies).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: 'outlier', details: expect.objectContaining({ kind: 'depth_comparison' }) })]))
  })

  it('keeps rapid same-price ledger updates comparable while retaining the selected ledger boundary', () => {
    const left = source('left'); const right = source('right')
    const result = reconcileDepth({ cycleId: 'cycle_depth', snapshotId: 'snapshot_depth', pair, configuredSources: [left, right], observations: [observation(left, 300, 500), observation(right, 300, 501)], asOf: new Date(now) })
    expect(result.snapshot.sourcesAgreeing).toBe(2)
    expect(result.snapshot.value).toMatchObject({ kind: 'depth', ledgerSequence: 500 })
  })
})
