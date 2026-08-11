import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reconciliationSnapshotSchema } from '../../lib/contracts'
import type { PersistenceRepositories } from '../../lib/db/repositories'
import type { ClaimedCycle, DiscoveredIngestJob } from '../../lib/db/scheduler-repository'
import { PUBLIC_NETWORK_PASSPHRASE } from '../../lib/stellar/horizon'
import { createTrustlineJobHandler } from '../../lib/worker/trustline-job'

const ISSUER = `G${'A'.repeat(55)}`; const ROOT = 'https://horizon.example'; const ASSET = `USDC:${ISSUER}`; const NOW = new Date('2026-08-10T12:00:05.000Z')
const fixture = JSON.parse(readFileSync(new URL('../fixtures/stellar/horizon-supply-asset.json', import.meta.url), 'utf8'))
const job: DiscoveredIngestJob = { metric: 'trustline_count', subjectKey: `public:${ASSET}`, methodologyVersion: 'trustline-state-v0.1', asset: { kind: 'credit', code: 'USDC', issuer: ISSUER }, sources: [{ id: 'horizon_1', url: ROOT, sourceClass: 'canonical_ledger', adapter: 'horizon', upstreamId: null, networkId: 'public', networkPassphrase: PUBLIC_NETWORK_PASSPHRASE }] }
const lease: ClaimedCycle = { id: 'cycle_trustlines', metric: 'trustline_count', subjectKey: job.subjectKey, methodologyVersion: job.methodologyVersion, idempotencyKey: `trustline_count:${job.subjectKey}:trustline-state-v0.1:${NOW.toISOString()}`, scheduledAt: NOW.toISOString(), leaseOwner: 'worker_1', leaseToken: 1, leaseExpiresAt: '2026-08-10T12:01:00.000Z', attemptCount: 1 }
function repositories() { return { getSourceHealthStates: vi.fn(async () => ({})), getDiscrepancyStates: vi.fn(async () => ({})) } as unknown as PersistenceRepositories }
function fetcher() { return vi.fn(async (input: string | URL | Request) => { const target = String(input); if (target === `${ROOT}/`) return Response.json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE }); if (target === `${ROOT}/accounts/${ISSUER}`) return Response.json({ account_id: ISSUER }, { headers: { 'Latest-Ledger': '499' } }); if (target.startsWith(`${ROOT}/assets?`)) return Response.json({ _links: {}, _embedded: { records: [fixture] } }, { headers: { 'Latest-Ledger': '500' } }); if (target === `${ROOT}/ledgers/500`) return Response.json({ sequence: 500, closed_at: '2026-08-10T12:00:00Z' }); throw new Error(`unexpected URL ${target}`) }) }
const policy = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, concurrency: 1, circuitFailureThreshold: 2, circuitCooldownMs: 60_000 }
describe('trustline worker job', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  it('persists exact state evidence and a degraded Horizon-only snapshot', async () => {
    vi.stubGlobal('fetch', fetcher())
    const batch = await createTrustlineJobHandler(repositories(), () => new Date(NOW), { resiliencePolicy: policy })({ lease, job, signal: new AbortController().signal })
    expect(reconciliationSnapshotSchema.parse(batch.snapshot)).toMatchObject({ status: 'degraded', sourcesUsable: 1, value: { kind: 'trustline_state', total: 825n } })
    expect(batch.readings).toHaveLength(1); expect(batch.attempts).toHaveLength(1)
  })
  it('fails closed when the connector cannot produce evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    const batch = await createTrustlineJobHandler(repositories(), () => new Date(NOW), { resiliencePolicy: policy })({ lease, job, signal: new AbortController().signal })
    expect(batch.snapshot).toMatchObject({ status: 'unavailable', value: null, sourcesUsable: 0, sourceErrors: [expect.objectContaining({ code: 'non_200_response' })] })
    expect(batch.readings).toHaveLength(0)
    expect(batch.attempts).toEqual([expect.objectContaining({ outcome: 'failure', httpStatus: 503 })])
  })
  it('persists but does not reconcile evidence older than the hard freshness limit', async () => {
    vi.stubGlobal('fetch', fetcher())
    const late = new Date('2026-08-10T12:15:01.000Z')
    const batch = await createTrustlineJobHandler(repositories(), () => new Date(late), { resiliencePolicy: policy })({ lease, job, signal: new AbortController().signal })
    expect(batch.snapshot).toMatchObject({ status: 'unavailable', value: null, sourcesUsable: 0, sourceErrors: [expect.objectContaining({ code: 'stale_observation' })] })
    expect(batch.readings).toHaveLength(1)
  })
})
