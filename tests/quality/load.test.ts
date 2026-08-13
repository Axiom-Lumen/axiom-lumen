import { afterEach, describe, expect, it, vi } from 'vitest'
import { reconciliationSnapshotSchema } from '../../lib/contracts'
import type { PersistenceRepositories } from '../../lib/db/repositories'
import type { ClaimedCycle, DiscoveredIngestJob } from '../../lib/db/scheduler-repository'
import type { SnapshotEventRecord, SnapshotEventStreamConfig } from '../../lib/db/snapshot-event-repository'
import { createSnapshotEventStream } from '../../lib/http/sse'
import { createSupplyGetHandler } from '../../lib/http/supply-route'
import { createLatestLedgerJobHandler } from '../../lib/worker/latest-ledger-job'

const event: SnapshotEventRecord = {
  id: '1',
  occurredAt: '2026-08-13T10:00:00.000Z',
  payload: {
    snapshot_id: 'snapshot_1',
    metric: 'latest_ledger',
    subject: { kind: 'network', network: 'public' },
    status: 'verified',
    as_of: '2026-08-13T10:00:00.000Z',
    methodology_version: 'latest-ledger-v0.2',
    resource: '/api/v1/stellar/latest-ledger',
  },
}

const streamConfig: SnapshotEventStreamConfig = {
  replayLimit: 100,
  pollIntervalMs: 100,
  heartbeatIntervalMs: 15_000,
  reauthorizeIntervalMs: 5_000,
  maxBackpressurePolls: 3,
}
const issuer = `G${'A'.repeat(55)}`
const asset = `USDC:${issuer}`
const supplySnapshot = reconciliationSnapshotSchema.parse({
  snapshotId: 'snapshot-load', cycleId: 'cycle-load', metric: 'circulating_supply',
  subject: { kind: 'asset', asset: { kind: 'credit', code: 'USDC', issuer } },
  status: 'degraded', value: { kind: 'amount', value: '1000' },
  confidence: {
    score: 0.6, formulaVersion: 'onchain-asset-supply-confidence-v0.1',
    components: { agreement: 1, freshness: 1, availability: 1, spread: 1 }, capsApplied: ['single_source'],
  },
  sourcesConfigured: 1, sourcesResponded: 1, sourcesUsable: 1, sourcesAgreeing: 1, sourcesExcluded: 0,
  contributions: [], discrepancies: [], sourceErrors: [], asOf: '2026-08-13T10:00:00.000Z',
  methodologyVersion: 'onchain-asset-supply-v0.1',
})

describe('bounded load behavior', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('serves isolated responses through the real API route across a concurrent batch', async () => {
    const loadReadModel = vi.fn(async () => ({ snapshot: supplySnapshot, stale: false, freshForSeconds: 100 }))
    const getSupply = createSupplyGetHandler({
      loadReadModel,
      clock: () => new Date('2026-08-13T10:00:00.000Z'),
    })
    const responses = await Promise.all(Array.from({ length: 500 }, async (_, index) => {
      const requestId = `load-${index}`
      const response = await getSupply(
        new Request(`https://api.example.test/api/v1/supply/${asset}`, { headers: { 'X-Request-ID': requestId } }),
        { params: Promise.resolve({ asset }) },
      )
      return {
        status: response.status,
        requestId: response.headers.get('x-request-id'),
        body: await response.json() as { request_id: string; metric: string },
      }
    }))

    expect(responses).toHaveLength(500)
    expect(loadReadModel).toHaveBeenCalledTimes(500)
    expect(new Set(responses.map((response) => response.requestId)).size).toBe(500)
    expect(responses[499]).toMatchObject({
      status: 200, requestId: 'load-499', body: { request_id: 'load-499', metric: 'onchain_asset_supply' },
    })
  })

  it('runs a full worker job without exceeding configured source concurrency', async () => {
    let active = 0
    let maximum = 0
    const passphrase = 'Public Global Stellar Network ; September 2015'
    const sources: DiscoveredIngestJob['sources'] = Array.from({ length: 10 }, (_, index) => ({
      id: `source-${index}`, url: `https://horizon-${index}.example`, sourceClass: 'canonical_ledger',
      adapter: 'horizon', upstreamId: null, networkId: 'public', networkPassphrase: passphrase,
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      active += 1
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active -= 1
      return String(input).endsWith('/')
        ? Response.json({ network_passphrase: passphrase })
        : Response.json({ _embedded: { records: [{ sequence: 500, closed_at: '2026-08-13T09:59:59.000Z' }] } })
    }))
    const repositories = {
      getSourceHealthStates: vi.fn(async () => ({})),
      getDiscrepancyStates: vi.fn(async () => ({})),
    } as unknown as PersistenceRepositories
    const handler = createLatestLedgerJobHandler(repositories, () => new Date('2026-08-13T10:00:00.000Z'), {
      resiliencePolicy: {
        maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, concurrency: 3,
        circuitFailureThreshold: 2, circuitCooldownMs: 60_000,
      },
    })
    const lease: ClaimedCycle = {
      id: 'cycle-load', metric: 'latest_ledger', subjectKey: 'public', methodologyVersion: 'latest-ledger-v0.2',
      idempotencyKey: 'latest_ledger:public:latest-ledger-v0.2:2026-08-13T10:00:00.000Z',
      scheduledAt: '2026-08-13T10:00:00.000Z', leaseOwner: 'load-worker', leaseToken: 1,
      leaseExpiresAt: '2026-08-13T10:01:00.000Z', attemptCount: 1,
    }
    const job: DiscoveredIngestJob = {
      metric: 'latest_ledger', subjectKey: 'public', methodologyVersion: 'latest-ledger-v0.2', sources,
    }
    const batch = await handler({ lease, job, signal: new AbortController().signal })

    expect(maximum).toBe(3)
    expect(batch.attempts).toHaveLength(10)
    expect(batch.snapshot).toMatchObject({ sourcesConfigured: 10, sourcesUsable: 10 })
  })

  it('polls one shared durable source for many independent SSE consumers', async () => {
    vi.useFakeTimers()
    const source = { readAfter: vi.fn(async () => [event]) }
    const streams = Array.from({ length: 100 }, () => createSnapshotEventStream({
      source,
      initialCursor: 0n,
      initialEvents: [],
      config: streamConfig,
    }))
    const readers = streams.map((stream) => stream.getReader())
    await Promise.all(readers.map((reader) => reader.read()))
    await vi.advanceTimersByTimeAsync(100)
    const payloads = await Promise.all(readers.map(async (reader) => {
      const decoder = new TextDecoder()
      const snapshot = decoder.decode((await reader.read()).value)
      await reader.cancel()
      return snapshot
    }))

    expect(source.readAfter).toHaveBeenCalledTimes(100)
    expect(payloads).toHaveLength(100)
    expect(payloads.every((payload) => payload.includes('id: 1'))).toBe(true)
    expect(new Set(payloads).size).toBe(1)
  })
})
