import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersistenceRepositories } from '../../lib/db/repositories'
import type { ClaimedCycle, DiscoveredIngestJob } from '../../lib/db/scheduler-repository'
import { createLatestLedgerJobHandler } from '../../lib/worker/latest-ledger-job'
import type { SourceResiliencePolicy } from '../../lib/worker/resilience'

const passphrase = 'Public Global Stellar Network ; September 2015'
const sources: DiscoveredIngestJob['sources'] = ['a', 'b'].map((id) => ({
  id: `source-${id}`,
  url: `https://${id}.example`,
  sourceClass: 'canonical_ledger',
  adapter: 'horizon',
  upstreamId: null,
  networkId: 'public',
  networkPassphrase: passphrase,
}))
const job: DiscoveredIngestJob = {
  metric: 'latest_ledger',
  subjectKey: 'public',
  methodologyVersion: 'latest-ledger-v0.2',
  sources,
}
const lease: ClaimedCycle = {
  id: 'cycle-ing02',
  metric: 'latest_ledger',
  subjectKey: 'public',
  methodologyVersion: 'latest-ledger-v0.2',
  idempotencyKey: 'latest_ledger:public:latest-ledger-v0.2:2026-08-10T10:00:00.000Z',
  scheduledAt: '2026-08-10T10:00:00.000Z',
  leaseOwner: 'worker-a',
  leaseToken: 1,
  leaseExpiresAt: '2026-08-10T10:01:00.000Z',
  attemptCount: 1,
}
const policy: SourceResiliencePolicy = {
  maxAttempts: 2,
  baseDelayMs: 10,
  maxDelayMs: 100,
  jitterRatio: 0,
  concurrency: 2,
  circuitFailureThreshold: 2,
  circuitCooldownMs: 60_000,
}

function repositories(health: Record<string, unknown> = {}) {
  return {
    getSourceHealthStates: vi.fn(async () => health),
    getDiscrepancyStates: vi.fn(async () => ({})),
  } as unknown as PersistenceRepositories
}

function clock() {
  let milliseconds = Date.parse('2026-08-10T10:00:01.000Z')
  return () => {
    const value = new Date(milliseconds)
    milliseconds += 100
    return value
  }
}

function ledgerPayload() {
  return { _embedded: { records: [{ sequence: 500, closed_at: '2026-08-10T10:00:00.000Z' }] } }
}

describe('latest-ledger resilient worker job', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('retries an unavailable source while preserving a healthy source snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target.startsWith('https://a.example/')) return new Response('unavailable', { status: 503 })
      if (target === 'https://b.example/') return Response.json({ network_passphrase: passphrase })
      if (target.startsWith('https://b.example/ledgers')) return Response.json(ledgerPayload())
      throw new Error(`unexpected URL ${target}`)
    }))
    const sleep = vi.fn(async () => undefined)
    const handler = createLatestLedgerJobHandler(repositories(), clock(), {
      resiliencePolicy: policy,
      random: () => 0.5,
      sleep,
    })

    const batch = await handler({ lease, job, signal: new AbortController().signal })

    expect(batch.snapshot).toMatchObject({ status: 'degraded', value: { kind: 'ledger', value: 500 } })
    expect(batch.readings).toHaveLength(1)
    expect(batch.attempts.filter((attempt) => attempt.sourceId === 'source-a')).toHaveLength(2)
    expect(batch.attempts.filter((attempt) => attempt.sourceId === 'source-b')).toHaveLength(1)
    expect(batch.sourceHealthStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'source-a', state: 'unreachable', circuitState: 'closed' }),
      expect.objectContaining({ sourceId: 'source-b', state: 'healthy', consecutiveFailures: 0 }),
    ]))
    expect(sleep).toHaveBeenCalledOnce()
  })

  it('does not retry permanent payload validation failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === 'https://a.example/') return Response.json({ unexpected: true })
      if (target === 'https://b.example/') return Response.json({ network_passphrase: passphrase })
      if (target.startsWith('https://b.example/ledgers')) return Response.json(ledgerPayload())
      throw new Error(`unexpected URL ${target}`)
    }))
    const sleep = vi.fn(async () => undefined)
    const handler = createLatestLedgerJobHandler(repositories(), clock(), {
      resiliencePolicy: { ...policy, maxAttempts: 3 },
      sleep,
    })

    const batch = await handler({ lease, job, signal: new AbortController().signal })

    expect(batch.attempts.filter((attempt) => attempt.sourceId === 'source-a')).toHaveLength(1)
    expect(batch.sourceHealthStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'source-a', state: 'malformed', circuitState: 'closed' }),
    ]))
    expect(sleep).not.toHaveBeenCalled()
  })

  it('skips an open circuit without contacting that source', async () => {
    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === 'https://b.example/') return Response.json({ network_passphrase: passphrase })
      if (target.startsWith('https://b.example/ledgers')) return Response.json(ledgerPayload())
      throw new Error(`unexpected URL ${target}`)
    })
    vi.stubGlobal('fetch', fetchSpy)
    const handler = createLatestLedgerJobHandler(repositories({
      'source-a': {
        sourceId: 'source-a',
        state: 'unreachable',
        consecutiveFailures: 3,
        circuitState: 'open',
        circuitOpenedAt: '2026-08-10T09:59:00.000Z',
        nextAttemptAt: '2026-08-10T10:02:00.000Z',
        lastErrorCode: 'request_failed',
        lastObservedAt: '2026-08-10T10:00:00.000Z',
      },
    }), clock(), { resiliencePolicy: policy })

    const batch = await handler({ lease, job, signal: new AbortController().signal })

    expect(fetchSpy.mock.calls.map(([url]) => String(url))).not.toEqual(expect.arrayContaining([
      expect.stringContaining('a.example'),
    ]))
    expect(batch.sourceHealthStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'source-a', circuitState: 'open', consecutiveFailures: 3 }),
    ]))
    expect(batch.attempts.filter((attempt) => attempt.sourceId === 'source-a')).toHaveLength(0)
    expect(batch.snapshot).toMatchObject({ sourcesResponded: 1, sourcesExcluded: 1 })
  })

  it('persists an old ledger observation as stale health', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target.endsWith('/')) return Response.json({ network_passphrase: passphrase })
      if (target.includes('/ledgers')) {
        return Response.json({
          _embedded: { records: [{ sequence: 499, closed_at: '2026-08-10T09:59:00.000Z' }] },
        })
      }
      throw new Error(`unexpected URL ${target}`)
    }))
    const handler = createLatestLedgerJobHandler(repositories(), clock(), { resiliencePolicy: policy })

    const batch = await handler({ lease, job: { ...job, sources: [sources[0]!] }, signal: new AbortController().signal })

    expect(batch.readings).toHaveLength(1)
    expect(batch.sourceHealthStates).toEqual([
      expect.objectContaining({ sourceId: 'source-a', state: 'stale', lastErrorCode: 'stale_observation' }),
    ])
  })
})
