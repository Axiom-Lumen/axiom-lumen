import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apiErrorResponseSchema,
  apiReconciliationSnapshotSchema,
  reconciliationSnapshotSchema,
} from '../../lib/contracts'
import type { SupplyReadModel } from '../../lib/db/supply-read-model'

const readModel = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../../lib/db/supply-read-model', () => ({ loadLatestSupplyReadModel: readModel.load }))

import { GET } from '../../app/api/v1/supply/[asset]/route'

const ISSUER = `G${'A'.repeat(55)}`
const ASSET = `USDC:${ISSUER}`

function finalizedSnapshot(status: 'verified' | 'degraded' | 'unavailable' = 'verified'): SupplyReadModel['snapshot'] {
  return reconciliationSnapshotSchema.parse({
    snapshotId: 'snapshot_supply_1',
    cycleId: 'cycle_supply_1',
    metric: 'circulating_supply',
    subject: { kind: 'asset', asset: { kind: 'credit', code: 'USDC', issuer: ISSUER } },
    status,
    value: status === 'unavailable' ? null : { kind: 'amount', value: '1000' },
    confidence: {
      score: status === 'verified' ? 0.95 : status === 'degraded' ? 0.6 : 0,
      formulaVersion: 'onchain-asset-supply-confidence-v0.1',
      components: { agreement: 1, freshness: 1, availability: 1, spread: 1 },
      capsApplied: status === 'degraded' ? ['single_source'] : [],
    },
    sourcesConfigured: 2,
    sourcesResponded: status === 'unavailable' ? 0 : 2,
    sourcesUsable: status === 'unavailable' ? 0 : 2,
    sourcesAgreeing: status === 'unavailable' ? 0 : status === 'verified' ? 2 : 1,
    sourcesExcluded: status === 'unavailable' ? 2 : 0,
    contributions: status === 'unavailable' ? [] : [
      {
        observationId: 'observation_horizon',
        sourceId: 'source_horizon',
        sourceClass: 'canonical_ledger',
        ageSeconds: 10,
        effectiveWeight: 0.8,
        agrees: true,
      },
      {
        observationId: 'observation_archive',
        sourceId: 'source_archive',
        sourceClass: 'archive',
        ageSeconds: 10,
        effectiveWeight: 0.7,
        agrees: status === 'verified',
      },
    ],
    discrepancies: [],
    sourceErrors: status === 'unavailable' ? [{
      sourceId: null,
      sourceUrl: null,
      code: 'request_failed',
      category: 'transport',
      message: 'No current source evidence is usable',
      occurredAt: '2026-08-10T12:00:00.000Z',
      retryable: true,
    }] : [],
    asOf: '2026-08-10T12:00:00.000Z',
    methodologyVersion: 'onchain-asset-supply-v0.1',
  })
}

function request(asset = ASSET) {
  return GET(new Request(`https://axiom.example/api/v1/supply/${asset}`), {
    params: Promise.resolve({ asset }),
  })
}

describe('GET /api/v1/supply/{asset}', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    readModel.load.mockReset()
  })

  it('serves a verified finalized snapshot without synchronous upstream fan-out', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    readModel.load.mockResolvedValue({ snapshot: finalizedSnapshot(), stale: false })

    const response = await request()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      metric: 'onchain_asset_supply',
      subject: { kind: 'asset', asset: ASSET },
      status: 'verified',
      value: { kind: 'amount', value: '1000' },
      methodology_version: 'onchain-asset-supply-v0.1',
      api_version: 'v1',
    })
    expect(apiReconciliationSnapshotSchema.parse(body)).toEqual(body)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('preserves an explicit degraded state', async () => {
    readModel.load.mockResolvedValue({ snapshot: finalizedSnapshot('degraded'), stale: false })

    const response = await request()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: 'degraded', confidence: 0.6, confidence_caps_applied: ['single_source'] })
  })

  it('returns an explicit unavailable persisted state', async () => {
    readModel.load.mockResolvedValue({ snapshot: finalizedSnapshot('unavailable'), stale: false })

    const response = await request()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ status: 'unavailable', value: null, sources_usable: 0 })
    expect(apiReconciliationSnapshotSchema.parse(body)).toEqual(body)
  })

  it('never presents an expired finalized snapshot as current', async () => {
    readModel.load.mockResolvedValue({ snapshot: finalizedSnapshot(), stale: true })

    const response = await request()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      status: 'unavailable',
      value: null,
      confidence: 0,
      confidence_components: { agreement: 0, freshness: 0, availability: 0, spread: 0 },
      sources_usable: 0,
      sources_agreeing: 0,
      confidence_caps_applied: ['snapshot_stale'],
      sources_excluded: 0,
    })
    expect(body.source_errors).toContainEqual(expect.objectContaining({
      code: 'stale_observation',
      category: 'freshness',
    }))
    expect(body.as_of).toBe('2026-08-10T12:00:00.000Z')
    expect(apiReconciliationSnapshotSchema.parse(body)).toEqual(body)
  })

  it('returns not found when the asset has no finalized snapshot', async () => {
    readModel.load.mockResolvedValue(null)

    const response = await request()
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error).toMatchObject({
      code: 'supply_snapshot_not_found',
      message: 'No finalized supply snapshot is available',
    })
    expect(apiErrorResponseSchema.parse(body)).toEqual(body)
  })

  it.each(['native', 'usdc:not-an-issuer', `usdc:${ISSUER}`, 'USDC'])('rejects malformed or unsupported asset %s', async (asset) => {
    const response = await request(asset)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toMatchObject({ code: 'invalid_asset' })
    expect(apiErrorResponseSchema.parse(body)).toEqual(body)
    expect(readModel.load).not.toHaveBeenCalled()
  })

  it('sanitizes read-store failures', async () => {
    readModel.load.mockRejectedValue(new Error('postgres://user:secret@db.internal/axiom'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await request()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.error).toMatchObject({
      code: 'supply_read_unavailable',
      message: 'The supply read model is temporarily unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('secret')
  })
})
