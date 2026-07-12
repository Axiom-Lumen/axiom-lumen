import { describe, expect, it } from 'vitest'
import { computeFreshnessWeight, reconcileLatestLedger } from '../../lib/reconcile/latest-ledger'

const asOf = new Date('2026-07-12T12:00:30.000Z')

function observation(sourceId: string, ledgerSequence: number, closedAt = '2026-07-12T12:00:25.000Z') {
  return {
    sourceId,
    sourceUrl: `https://${sourceId}.example`,
    ledgerSequence,
    closedAt,
    retrievedAt: '2026-07-12T12:00:30.000Z',
  }
}

describe('reconcileLatestLedger', () => {
  it('computes a weighted median that resists an outlier by magnitude', () => {
    const result = reconcileLatestLedger({
      observations: [observation('a', 100), observation('b', 100), observation('c', 140)],
      sourcesConfigured: 3,
      asOf,
    })

    expect(result.value).toBe(100)
    expect(result.status).toBe('degraded')
    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0]).toMatchObject({ source: 'c', severity: 'critical' })
  })

  it('uses half-life freshness decay', () => {
    expect(computeFreshnessWeight({ baseWeight: 1, ageSeconds: 30, halfLifeSeconds: 30 })).toBeCloseTo(0.5)
    expect(computeFreshnessWeight({ baseWeight: 1, ageSeconds: 60, halfLifeSeconds: 30 })).toBeCloseTo(0.25)
  })

  it('penalizes confidence when configured sources fail', () => {
    const clean = reconcileLatestLedger({
      observations: [observation('a', 100), observation('b', 100), observation('c', 100)],
      sourcesConfigured: 3,
      asOf,
    })
    const degraded = reconcileLatestLedger({
      observations: [observation('a', 100), observation('b', 100)],
      sourceErrors: [
        {
          sourceId: 'c',
          sourceUrl: 'https://c.example',
          code: 'request_failed',
          message: 'failed',
          retrievedAt: asOf.toISOString(),
        },
      ],
      sourcesConfigured: 3,
      asOf,
    })

    expect(clean.status).toBe('verified')
    expect(degraded.status).toBe('degraded')
    expect(degraded.confidence).toBeLessThan(clean.confidence)
    expect(degraded.confidence).toBeLessThanOrEqual(0.85)
  })

  it('returns a degraded capped result for one usable source', () => {
    const result = reconcileLatestLedger({
      observations: [observation('a', 100)],
      sourcesConfigured: 3,
      asOf,
    })

    expect(result.value).toBe(100)
    expect(result.status).toBe('degraded')
    expect(result.confidence).toBeLessThanOrEqual(0.6)
    expect(result.sources_usable).toBe(1)
    expect(result.sources_agreeing).toBe(1)
  })

  it('returns unavailable when no usable observations exist', () => {
    const result = reconcileLatestLedger({
      observations: [],
      sourceErrors: [
        {
          sourceId: 'a',
          sourceUrl: 'https://a.example',
          code: 'request_aborted',
          message: 'timeout',
          retrievedAt: asOf.toISOString(),
        },
      ],
      sourcesConfigured: 1,
      asOf,
    })

    expect(result.value).toBeNull()
    expect(result.status).toBe('unavailable')
    expect(result.confidence).toBe(0)
    expect(result.sources_responded).toBe(0)
  })

  it('classifies small, medium, and large ledger discrepancies', () => {
    const result = reconcileLatestLedger({
      observations: [
        observation('median-a', 100),
        observation('median-b', 100),
        observation('median-c', 100),
        observation('info', 101),
        observation('warning', 103),
        observation('critical', 110),
      ],
      sourcesConfigured: 6,
      asOf,
    })

    expect(result.discrepancies.map((item) => [item.source, item.severity])).toEqual([
      ['info', 'info'],
      ['warning', 'warning'],
      ['critical', 'critical'],
    ])
  })

  it('decreases confidence when agreement drops', () => {
    const agreeing = reconcileLatestLedger({
      observations: [observation('a', 100), observation('b', 100), observation('c', 100)],
      sourcesConfigured: 3,
      asOf,
    })
    const disagreeing = reconcileLatestLedger({
      observations: [observation('a', 100), observation('b', 100), observation('c', 104)],
      sourcesConfigured: 3,
      asOf,
    })

    expect(disagreeing.confidence).toBeLessThan(agreeing.confidence)
    expect(disagreeing.status).toBe('degraded')
  })
})
