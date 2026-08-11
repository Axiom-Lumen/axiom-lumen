import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersistenceRepositories } from '../../lib/db/repositories'
import type { ClaimedCycle, DiscoveredIngestJob } from '../../lib/db/scheduler-repository'
import { reconciliationSnapshotSchema } from '../../lib/contracts'
import { PUBLIC_NETWORK_PASSPHRASE } from '../../lib/stellar/horizon'
import { createDepthJobHandler } from '../../lib/worker/depth-job'

const ISSUER = `G${'A'.repeat(55)}`
const ROOT = 'https://horizon.example'
const PAIR_ID = `native~USDC:${ISSUER}`
const NOW = new Date('2026-08-11T12:00:00.000Z')
const fixture = JSON.parse(readFileSync(new URL('../fixtures/stellar/horizon-depth-offers.json', import.meta.url), 'utf8')) as { asks: unknown[]; bids: unknown[] }
const job: DiscoveredIngestJob = {
  metric: 'order_book_depth', subjectKey: `public:${PAIR_ID}`, methodologyVersion: 'order-book-depth-v0.2',
  pair: { base: { kind: 'native' }, counter: { kind: 'credit', code: 'USDC', issuer: ISSUER } },
  sources: [{ id: 'sdex_1', url: ROOT, sourceClass: 'dex', adapter: 'sdex', upstreamId: null, networkId: 'public', networkPassphrase: PUBLIC_NETWORK_PASSPHRASE }],
}
const lease: ClaimedCycle = {
  id: 'cycle_depth_500', metric: 'order_book_depth', subjectKey: job.subjectKey, methodologyVersion: job.methodologyVersion,
  idempotencyKey: `order_book_depth:${job.subjectKey}:order-book-depth-v0.2:2026-08-11T12:00:00.000Z`, scheduledAt: NOW.toISOString(),
  leaseOwner: 'worker_1', leaseToken: 1, leaseExpiresAt: '2026-08-11T12:01:00.000Z', attemptCount: 1,
}
function repositories() { return { getSourceHealthStates: vi.fn(async () => ({})), getDiscrepancyStates: vi.fn(async () => ({})) } as unknown as PersistenceRepositories }
function isAsk(target: string) { const url = new URL(target); return url.pathname === '/offers' && url.searchParams.get('selling_asset_type') === 'native' }
function isBid(target: string) { const url = new URL(target); return url.pathname === '/offers' && url.searchParams.get('selling_asset_code') === 'USDC' }
function connectorFetch(asks = fixture.asks, bids = fixture.bids) {
  return vi.fn(async (input: string | URL | Request) => {
    const target = String(input)
    if (target === `${ROOT}/`) return Response.json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
    if (isAsk(target)) return Response.json({ _links: {}, _embedded: { records: asks } }, { headers: { 'Latest-Ledger': '500' } })
    if (isBid(target)) return Response.json({ _links: {}, _embedded: { records: bids } }, { headers: { 'Latest-Ledger': '500' } })
    if (target === `${ROOT}/ledgers/500`) return Response.json({ sequence: 500, closed_at: '2026-08-11T11:59:55Z' })
    throw new Error(`unexpected URL ${target}`)
  })
}
const policy = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, concurrency: 1, circuitFailureThreshold: 2, circuitCooldownMs: 60_000 }

describe('depth worker job', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  it('persists one coherent complete-book reading and a degraded Horizon-only snapshot', async () => {
    vi.stubGlobal('fetch', connectorFetch())
    const batch = await createDepthJobHandler(repositories(), () => new Date(NOW), { resiliencePolicy: policy })({ lease, job, signal: new AbortController().signal })
    const snapshot = reconciliationSnapshotSchema.parse(batch.snapshot)
    expect(snapshot).toMatchObject({ metric: 'order_book_depth', status: 'degraded', sourcesUsable: 1, value: { kind: 'depth', ledgerSequence: 500 } })
    expect(batch.readings).toHaveLength(1)
    expect(batch.readings[0]?.rawPayload).toMatchObject({ observation: { buckets: expect.any(Array) }, connectorObservation: { bookStatus: 'complete' } })
    expect(snapshot.value?.kind === 'depth' && snapshot.value.buckets).toHaveLength(6)
  })
  it('retains an empty book as healthy evidence but publishes unavailable', async () => {
    vi.stubGlobal('fetch', connectorFetch([], []))
    const batch = await createDepthJobHandler(repositories(), () => new Date(NOW), { resiliencePolicy: policy })({ lease, job, signal: new AbortController().signal })
    expect(reconciliationSnapshotSchema.parse(batch.snapshot)).toMatchObject({ status: 'unavailable', value: null, sourcesResponded: 1, sourcesUsable: 0, sourceErrors: [expect.objectContaining({ code: 'empty_book' })] })
    expect(batch.readings).toHaveLength(1)
    expect(batch.sourceHealthStates).toEqual([expect.objectContaining({ state: 'healthy' })])
  })
})
