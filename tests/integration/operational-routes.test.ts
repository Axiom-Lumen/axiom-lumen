import { afterEach, describe, expect, it, vi } from 'vitest'

const statusStore = vi.hoisted(() => ({ load: vi.fn(), ready: vi.fn() }))
vi.mock('../../lib/db/operational-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/db/operational-status')>()),
  loadPublicOperationalStatus: statusStore.load,
  checkOperationalReadiness: statusStore.ready,
}))

import { GET as live } from '../../app/api/health/live/route'
import { GET as ready } from '../../app/api/health/ready/route'
import { GET as metrics } from '../../app/api/metrics/route'

const operational = {
  status: 'operational' as const,
  generatedAt: '2026-08-13T12:00:00.000Z', windowSeconds: 900,
  metrics: {
    retrievalLatencyMs: { average: 100, maximum: 200 }, retrievals: { total: 10, failures: 0, failurePercent: 0 },
    freshness: { trackedSnapshots: 4, staleSnapshots: 0, maximumAgeRatio: 0.25, unavailable: 0 },
    cycles: { completed: 8, failed: 0, pending: 0, running: 1, maximumLagSeconds: 45 },
    sources: { tracked: 5, unhealthy: 0, stale: 0, openCircuits: 0, oldestObservationAgeSeconds: 30 }, discrepancies: { open: 0, warning: 0, critical: 0 },
  },
  components: [], alerts: [],
}

describe('operational endpoints', () => {
  afterEach(() => { statusStore.load.mockReset(); statusStore.ready.mockReset() })

  it('serves liveness without consulting persisted dependencies and continues an incoming trace', async () => {
    const response = live(new Request('https://axiom.example/api/health/live', {
      headers: { traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01` },
    }))
    expect(response.status).toBe(200)
    expect((await response.json()).status).toBe('alive')
    expect(response.headers.get('traceparent')).toMatch(new RegExp(`^00-${'1'.repeat(32)}-[0-9a-f]{16}-01$`))
    expect(statusStore.load).not.toHaveBeenCalled()
  })

  it('reports readiness when persisted health is queryable, even if upstream signals are degraded', async () => {
    statusStore.ready.mockResolvedValue(undefined)
    const response = await ready(new Request('https://axiom.example/api/health/ready'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ready' })
    expect(statusStore.load).not.toHaveBeenCalled()
  })

  it('fails readiness without leaking dependency errors', async () => {
    statusStore.ready.mockRejectedValue(new Error('postgres://user:secret@db.internal/private'))
    const response = await ready(new Request('https://axiom.example/api/health/ready'))
    const body = await response.text()
    expect(response.status).toBe(503)
    expect(JSON.parse(body)).toEqual(expect.objectContaining({ status: 'not_ready' }))
    expect(body).not.toContain('secret')
  })

  it('exports persisted aggregate metrics without source identities or URLs', async () => {
    statusStore.load.mockResolvedValue(operational)
    const response = await metrics()
    const body = await response.text()
    expect(response.headers.get('content-type')).toContain('version=0.0.4')
    expect(body).toContain('axiom_retrieval_latency_average_milliseconds 100')
    expect(body).toContain('axiom_sources_unhealthy 0')
    expect(body).not.toContain('source_id')
  })
})
