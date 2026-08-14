import { describe, expect, it } from 'vitest'
import { reconcileTrustlines } from '../../lib/reconcile/trustlines'
import type { SourceIdentity } from '../../lib/contracts'

const ISSUER = `G${'A'.repeat(55)}`; const asset = { kind: 'credit' as const, code: 'USDC', issuer: ISSUER }; const NOW = '2026-08-10T12:00:00.000Z'
function source(id: string): SourceIdentity { return { id, sourceClass: 'canonical_ledger', adapter: 'horizon', url: `https://${id}.example`, network: { id: 'public', passphrase: 'Public Global Stellar Network ; September 2015' } } }
function observation(identity: SourceIdentity, states = { authorized: '700', authorized_to_maintain_liabilities: '100', unauthorized: '25' }, ledger = 500, sourceTimestamp = NOW) {
  const total = (BigInt(states.authorized) + BigInt(states.authorized_to_maintain_liabilities) + BigInt(states.unauthorized)).toString()
  return { observationId: `observation_${identity.id}`, cycleId: 'cycle_trustlines', metric: 'trustline_count' as const, asset, total, states, ledgerSequence: ledger, methodologyVersion: 'trustline-state-v0.1' as const,
    provenance: { source: identity, sourceTimestamp, retrievedAt: NOW }, derivation: { family: 'horizon_asset_aggregate' as const, connectorVersion: 'horizon-trustlines-v0.1', evidenceSha256: 'a'.repeat(64), checkpoint: { ledgerSequence: ledger } } }
}
describe('trustline-state reconciliation', () => {
  it('keeps exact state counts and caps Horizon replicas', () => {
    const left = source('left'); const right = source('right')
    const result = reconcileTrustlines({ cycleId: 'cycle_trustlines', snapshotId: 'snapshot_trustlines', asset, configuredSources: [left, right], observations: [observation(left), observation(right)], asOf: new Date(NOW) })
    expect(result.snapshot).toMatchObject({ status: 'degraded', sourcesAgreeing: 2, value: { kind: 'trustline_state', total: 825n, states: { authorized: 700n } }, confidence: { capsApplied: ['same_upstream_replicas'] } })
  })
  it('reports offsetting state changes even when the total is unchanged', () => {
    const left = source('left'); const right = source('right')
    const result = reconcileTrustlines({ cycleId: 'cycle_trustlines', snapshotId: 'snapshot_trustlines', asset, configuredSources: [left, right], observations: [observation(left), observation(right, { authorized: '699', authorized_to_maintain_liabilities: '100', unauthorized: '26' })], asOf: new Date(NOW) })
    expect(result.snapshot.sourcesAgreeing).toBe(1)
    expect(result.snapshot.discrepancies).toEqual(expect.arrayContaining([expect.objectContaining({ details: expect.objectContaining({ kind: 'trustline_comparison', stateDifferences: expect.arrayContaining([expect.objectContaining({ state: 'authorized' }), expect.objectContaining({ state: 'unauthorized' })]) }) })]))
  })
  it('does not treat identical counts from different ledger boundaries as agreement', () => {
    const left = source('left'); const right = source('right')
    const result = reconcileTrustlines({ cycleId: 'cycle_trustlines', snapshotId: 'snapshot_trustlines', asset, configuredSources: [left, right], observations: [observation(left), observation(right, undefined, 501, '2026-08-10T12:00:01.000Z')], asOf: new Date(NOW) })
    expect(result.snapshot.sourcesAgreeing).toBe(1)
    expect(result.snapshot.discrepancies).toEqual(expect.arrayContaining([expect.objectContaining({ details: expect.objectContaining({ observedLedgerSequence: 501, referenceLedgerSequence: 500 }) })]))
  })
})
