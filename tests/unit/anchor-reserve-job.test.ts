import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PersistenceRepositories } from '../../lib/db/repositories'
import type { ClaimedCycle, DiscoveredIngestJob } from '../../lib/db/scheduler-repository'
import { parseStellarAmount } from '../../lib/stellar/amount'
import { createAnchorReserveJobHandler } from '../../lib/worker/anchor-reserve-job'
import { MZAR_ISSUER } from '../../lib/stellar/mzar-profile'

const mzarReportText = readFileSync(new URL('../fixtures/stellar/mzar-attestation-2026-02.extracted.txt', import.meta.url), 'utf8')
const mzarIndexText = readFileSync(new URL('../fixtures/stellar/mzar-attestation-index-2026-04.redacted.html', import.meta.url), 'utf8')

const ISSUER = `G${'A'.repeat(55)}`
const ASSET_ID = `USDC:${ISSUER}`
const SUBJECT = `public:${ASSET_ID}`
const job: DiscoveredIngestJob = {
  metric: 'anchor_reserves',
  subjectKey: SUBJECT,
  methodologyVersion: 'anchor-reserve-comparison-v0.1',
  anchorId: 'anchor_1',
  connectorProfile: 'axiom_json_v1',
  asset: { kind: 'credit', code: 'USDC', issuer: ISSUER },
  sources: [{ id: 'anchor_source', url: 'https://evidence.example/reserve.json', sourceClass: 'anchor_self_reported', adapter: 'anchor', upstreamId: 'anchor_1', networkId: 'public', networkPassphrase: 'Public Global Stellar Network ; September 2015' }],
}
const lease: ClaimedCycle = {
  id: 'cycle_anchor_1', metric: 'anchor_reserves', subjectKey: SUBJECT,
  methodologyVersion: 'anchor-reserve-comparison-v0.1',
  idempotencyKey: 'anchor_reserves:subject:methodology:time', scheduledAt: '2026-08-11T12:00:00.000Z',
  leaseOwner: 'worker_1', leaseToken: 1, leaseExpiresAt: '2026-08-11T12:01:00.000Z', attemptCount: 1,
}
function payload(periodEnd = '2026-08-11T11:59:30Z') {
  return {
    schema: 'axiom-lumen-anchor-reserve-attestation-v1', asset: ASSET_ID,
    unit: { kind: 'asset_units', asset: ASSET_ID }, reserve_amount: '970',
    period_start: '2026-08-11T09:00:00Z', period_end: periodEnd, published_at: '2026-08-11T12:00:00Z',
  }
}
function repositories(referenceAsOf = '2026-08-11T11:59:45.000Z') {
  return {
    getSourceHealthStates: vi.fn(async () => ({})),
    getDiscrepancyStates: vi.fn(async () => ({})),
    getLatestSupplyReference: vi.fn(async () => ({
      snapshotId: 'supply_snapshot_1', cycleId: 'supply_cycle_1', amount: parseStellarAmount('1000'), asOf: referenceAsOf,
      ledgerSequence: 500, ledgerClosedAt: referenceAsOf, status: 'verified' as const, confidence: 0.95,
      methodologyVersion: 'onchain-asset-supply-v0.1',
      evidence: [{ readingId: 'supply_reading_1', observationId: 'supply_observation_1', sourceId: 'supply_source_1', payloadSha256: 'b'.repeat(64), ledgerSequence: 500, ledgerClosedAt: referenceAsOf }],
    })),
  } as unknown as PersistenceRepositories
}

describe('anchor reserve worker job', () => {
  afterEach(() => vi.restoreAllMocks())

  it('persists an internal comparison and exact supply provenance', async () => {
    const handler = createAnchorReserveJobHandler(repositories(), () => new Date('2026-08-11T12:00:05.000Z'), {
      resolve: async () => ['93.184.216.34'],
      connectImpl: vi.fn(async () => Response.json(payload())),
      resiliencePolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, concurrency: 1, circuitFailureThreshold: 3, circuitCooldownMs: 60_000 },
    })
    const batch = await handler({ lease, job, signal: new AbortController().signal })
    expect(batch.snapshot).toMatchObject({ metric: 'anchor_reserves', status: 'degraded', discrepancies: [{ publicationState: 'internal', severity: 'warning' }] })
    expect(batch.readings).toHaveLength(1)
    expect(batch.readings[0]?.rawPayload).toMatchObject({ supplyReference: { snapshotId: 'supply_snapshot_1', ledgerSequence: 500 } })
    expect(batch.events).toEqual([expect.objectContaining({ type: 'opened' })])
  })

  it('returns unavailable rather than comparing non-commensurate periods', async () => {
    const handler = createAnchorReserveJobHandler(repositories(), () => new Date('2026-08-11T12:00:05.000Z'), {
      resolve: async () => ['93.184.216.34'],
      connectImpl: vi.fn(async () => Response.json(payload('2026-08-11T10:00:00Z'))),
      resiliencePolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, concurrency: 1, circuitFailureThreshold: 3, circuitCooldownMs: 60_000 },
    })
    const batch = await handler({ lease, job, signal: new AbortController().signal })
    expect(batch.snapshot).toMatchObject({ status: 'unavailable', sourceErrors: [expect.objectContaining({ code: 'period_mismatch' })] })
    expect(batch.events).toHaveLength(0)
  })

  it('does not record a retrieval attempt while the source circuit is open', async () => {
    const repository = repositories()
    vi.mocked(repository.getSourceHealthStates).mockResolvedValue({
      anchor_source: { sourceId: 'anchor_source', state: 'unreachable', consecutiveFailures: 3, circuitState: 'open', circuitOpenedAt: '2026-08-11T11:59:00.000Z', nextAttemptAt: '2026-08-11T12:10:00.000Z', lastErrorCode: 'request_failed', lastObservedAt: '2026-08-11T11:59:00.000Z' },
    })
    const connectImpl = vi.fn()
    const handler = createAnchorReserveJobHandler(repository, () => new Date('2026-08-11T12:00:05.000Z'), { resolve: async () => ['93.184.216.34'], connectImpl })
    const batch = await handler({ lease, job, signal: new AbortController().signal })
    expect(batch.snapshot).toMatchObject({ status: 'unavailable', sourcesExcluded: 1 })
    expect(batch.attempts).toHaveLength(0)
    expect(connectImpl).not.toHaveBeenCalled()
  })

  it('rejects a supply reference from an unapproved methodology', async () => {
    const repository = repositories()
    vi.mocked(repository.getLatestSupplyReference).mockImplementation(async () => ({
      ...(await repositories().getLatestSupplyReference(SUBJECT))!, methodologyVersion: 'future-supply-v9',
    }))
    const handler = createAnchorReserveJobHandler(repository, () => new Date('2026-08-11T12:00:05.000Z'), {
      resolve: async () => ['93.184.216.34'], connectImpl: vi.fn(async () => Response.json(payload())),
      resiliencePolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, concurrency: 1, circuitFailureThreshold: 3, circuitCooldownMs: 60_000 },
    })
    const batch = await handler({ lease, job, signal: new AbortController().signal })
    expect(batch.snapshot).toMatchObject({ status: 'unavailable', sourceErrors: [expect.objectContaining({ code: 'reference_unavailable' })] })
  })

  it('aligns periods to the supply ledger close time rather than the snapshot completion time', async () => {
    const repository = repositories('2026-08-11T11:59:45.000Z')
    const current = await repository.getLatestSupplyReference(SUBJECT)
    vi.mocked(repository.getLatestSupplyReference).mockResolvedValue({ ...current!, ledgerClosedAt: '2026-08-11T11:00:00.000Z' })
    const handler = createAnchorReserveJobHandler(repository, () => new Date('2026-08-11T12:00:05.000Z'), {
      resolve: async () => ['93.184.216.34'], connectImpl: vi.fn(async () => Response.json(payload())),
      resiliencePolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, concurrency: 1, circuitFailureThreshold: 3, circuitCooldownMs: 60_000 },
    })
    const batch = await handler({ lease, job, signal: new AbortController().signal })
    expect(batch.snapshot).toMatchObject({ status: 'unavailable', sourceErrors: expect.arrayContaining([expect.objectContaining({ code: 'reference_unavailable' })]) })
  })

  it('keeps mZAR v0.2 isolated and selects a historical supply reference at the report cutoff', async () => {
    const mzarSubject = `public:mZAR:${MZAR_ISSUER}`
    const mzarJob: DiscoveredIngestJob = {
      metric: 'anchor_reserves', subjectKey: mzarSubject, methodologyVersion: 'anchor-reserve-comparison-v0.2',
      anchorId: 'anchor_mzar', connectorProfile: 'mesh_mzar_pdf_v1',
      asset: { kind: 'credit', code: 'mZAR', issuer: MZAR_ISSUER },
      sources: [{ id: 'mesh_mzar', url: 'https://mzar.co.za/', sourceClass: 'anchor_self_reported', adapter: 'anchor', upstreamId: 'anchor_mzar', networkId: 'public', networkPassphrase: 'Public Global Stellar Network ; September 2015' }],
    }
    const mzarLease: ClaimedCycle = {
      ...lease, id: 'cycle_mzar', subjectKey: mzarSubject, methodologyVersion: 'anchor-reserve-comparison-v0.2',
    }
    const repository = repositories()
    repository.getSupplyReferenceAt = vi.fn(async () => ({
      snapshotId: 'historical_supply_snapshot', cycleId: 'historical_supply_cycle', amount: parseStellarAmount('4249400.26'),
      asOf: '2026-02-28T15:00:05.000Z', ledgerSequence: 600, ledgerClosedAt: '2026-02-28T15:00:05.000Z',
      status: 'verified' as const, confidence: 0.95, methodologyVersion: 'onchain-asset-supply-v0.1',
      evidence: [{ readingId: 'historical_reading', observationId: 'historical_observation', sourceId: 'archive_source', payloadSha256: 'c'.repeat(64), ledgerSequence: 600, ledgerClosedAt: '2026-02-28T15:00:05.000Z' }],
    }))
    const connectImpl = vi.fn(async (target: { url: URL }) => target.url.pathname === '/'
      ? new Response(mzarIndexText, { headers: { 'content-type': 'text/html' } })
      : new Response(new TextEncoder().encode('mzar-pdf'), { headers: { 'content-type': 'application/pdf' } }))
    const handler = createAnchorReserveJobHandler(repository, () => new Date('2026-04-01T12:00:00.000Z'), {
      resolve: async () => ['93.184.216.34'], connectImpl, extractMzarPdfText: async () => mzarReportText,
      resiliencePolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, concurrency: 1, circuitFailureThreshold: 3, circuitCooldownMs: 60_000 },
    })
    const batch = await handler({ lease: mzarLease, job: mzarJob, signal: new AbortController().signal })
    expect(repository.getSupplyReferenceAt).toHaveBeenCalledWith(mzarSubject, '2026-02-28T15:00:00.000Z', 300)
    expect(repository.getLatestSupplyReference).not.toHaveBeenCalled()
    expect(batch.snapshot).toMatchObject({ methodologyVersion: 'anchor-reserve-comparison-v0.2', status: 'degraded', sourcesUsable: 1, discrepancies: [] })
    expect(batch.readings[0]?.rawPayload).toMatchObject({ supplyReference: { snapshotId: 'historical_supply_snapshot' } })

    const staleHandler = createAnchorReserveJobHandler(repository, () => new Date('2026-08-11T12:00:00.000Z'), {
      resolve: async () => ['93.184.216.34'], connectImpl, extractMzarPdfText: async () => mzarReportText,
      resiliencePolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, concurrency: 1, circuitFailureThreshold: 3, circuitCooldownMs: 60_000 },
    })
    const staleBatch = await staleHandler({ lease: { ...mzarLease, id: 'cycle_mzar_stale' }, job: mzarJob, signal: new AbortController().signal })
    expect(repository.getSupplyReferenceAt).toHaveBeenCalledTimes(1)
    expect(repository.getLatestSupplyReference).not.toHaveBeenCalled()
    expect(staleBatch.snapshot).toMatchObject({
      methodologyVersion: 'anchor-reserve-comparison-v0.2', status: 'unavailable',
      sourceErrors: expect.arrayContaining([expect.objectContaining({ code: 'stale_observation' })]),
    })
  })
})
