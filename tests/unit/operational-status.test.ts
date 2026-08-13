import { describe, expect, it, vi } from 'vitest'
import type { DatabaseClient } from '../../lib/db/client'
import { createOperationalStatusRepository, parseOperationalThresholds } from '../../lib/db/operational-status'
import { renderOperationalMetrics } from '../../lib/observability/metrics'

function row(overrides: Record<string, unknown> = {}) {
  return {
    retrieval_total: 10, retrieval_failures: 0, latency_average: '120.5', latency_maximum: '250',
    snapshots_tracked: 4, stale_snapshots: 0, maximum_snapshot_age_ratio: '0.25', snapshots_unavailable: 0,
    cycles_completed: 8, cycles_failed: 0, cycles_pending: 0, cycles_running: 1, maximum_cycle_lag: '45',
    sources_tracked: 5, sources_unhealthy: 0, sources_stale: 0, oldest_source_observation_age: '30', circuits_open: 0,
    discrepancies_open: 1, discrepancies_warning: 1, discrepancies_critical: 0,
    ...overrides,
  }
}

function repository(aggregate: Record<string, unknown>) {
  const query = vi.fn(async () => ({ rows: [aggregate] }))
  return { repository: createOperationalStatusRepository({ pool: { query } } as unknown as DatabaseClient), query }
}

describe('persisted operational status', () => {
  it('aggregates healthy persisted signals into an operational projection and Prometheus metrics', async () => {
    const fixture = repository(row())
    const status = await fixture.repository.read(new Date('2026-08-13T12:00:00.000Z'))
    expect(status).toMatchObject({
      status: 'operational',
      metrics: {
        retrievalLatencyMs: { average: 120.5, maximum: 250 },
        retrievals: { total: 10, failures: 0, failurePercent: 0 },
        sources: { tracked: 5, unhealthy: 0 },
      },
      alerts: [],
    })
    expect(fixture.query).toHaveBeenCalledWith(expect.objectContaining({ values: expect.arrayContaining(['2026-08-13T12:00:00.000Z', 900, true]) }))
    expect(renderOperationalMetrics(status)).toContain('axiom_snapshot_maximum_age_ratio 0.25')
  })

  it('requests publication-approved discrepancies for the public projection', async () => {
    const fixture = repository(row())
    await fixture.repository.read(new Date('2026-08-13T12:00:00.000Z'), parseOperationalThresholds(), 'public')
    expect(fixture.query).toHaveBeenCalledWith(expect.objectContaining({ values: expect.arrayContaining([false]) }))
  })

  it('raises explicit warning and critical alerts from configured thresholds', async () => {
    const status = await repository(row({
      retrieval_failures: 3,
      latency_maximum: '6000',
      stale_snapshots: 1,
      maximum_snapshot_age_ratio: '2',
      sources_unhealthy: 1,
      discrepancies_critical: 3,
    })).repository.read(new Date('2026-08-13T12:00:00.000Z'))
    expect(status.status).toBe('outage')
    expect(status.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'retrieval_latency', level: 'critical' }),
      expect.objectContaining({ code: 'retrieval_failures', level: 'critical' }),
      expect.objectContaining({ code: 'snapshot_freshness', level: 'warning' }),
      expect.objectContaining({ code: 'critical_discrepancies', level: 'critical' }),
    ]))
  })

  it('validates bounded and ordered alert thresholds', () => {
    expect(parseOperationalThresholds({ OPS_STATUS_WINDOW_SECONDS: '60' }).windowSeconds).toBe(60)
    expect(() => parseOperationalThresholds({ OPS_LATENCY_WARNING_MS: '5000', OPS_LATENCY_CRITICAL_MS: '2000' })).toThrow(/critical threshold/)
    expect(() => parseOperationalThresholds({ OPS_FAILURE_WARNING_PERCENT: '0' })).toThrow(/positive integer/)
  })
})
