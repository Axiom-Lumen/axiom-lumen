import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apiErrorResponseSchema,
  apiReconciliationSnapshotSchema,
  reconciliationSnapshotSchema,
} from '../../lib/contracts'
import type { SupplyReadModel } from '../../lib/db/supply-read-model'
import { expectOpenApiResponse } from '../helpers/openapi-response'

vi.mock('../../lib/db/api-access-repository', () => ({ authorizePublicApiKey: vi.fn(async () => ({ status: 'allowed', grant: { principalId: 'test', planId: 'developer', limit: 60, remaining: 59, resetAt: '2026-08-10T10:01:00.000Z' } })) }))

const readModel = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../../lib/db/supply-read-model', () => ({ loadLatestSupplyReadModel: readModel.load }))

import { GET, OPTIONS, POST } from '../../app/api/v1/supply/[asset]/route'
import { createSupplyGetHandler } from '../../lib/http/supply-route'

const ISSUER = `G${'A'.repeat(55)}`
const ASSET = `USDC:${ISSUER}`
const OPENAPI_PATH = '/api/v1/supply/{asset}'

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

function request(asset = ASSET, init?: RequestInit, query = '') {
  return GET(new Request(`https://axiom.example/api/v1/supply/${asset}${query}`, init), {
    params: Promise.resolve({ asset }),
  })
}

describe('GET /api/v1/supply/{asset}', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    readModel.load.mockReset()
  })

  it('fails closed before reads when supply is disabled for the environment', async () => {
    const disabled = createSupplyGetHandler({ featureEnabled: () => false, loadReadModel: readModel.load })
    const response = await disabled(
      new Request(`https://axiom.example/api/v1/supply/${ASSET}`, { headers: { 'X-Request-ID': 'req_disabled' } }),
      { params: Promise.resolve({ asset: ASSET }) },
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'feature_not_available' } })
    expect(readModel.load).not.toHaveBeenCalled()
  })

  it('serves a verified finalized snapshot without synchronous upstream fan-out', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    readModel.load.mockResolvedValue({ snapshot: finalizedSnapshot(), stale: false, freshForSeconds: 110 })

    const response = await request(ASSET, { headers: { 'X-Request-ID': 'req_supply_1' } })
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'get')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      metric: 'onchain_asset_supply',
      subject: { kind: 'asset', asset: ASSET },
      status: 'verified',
      value: { kind: 'amount', value: '1000' },
      methodology_version: 'onchain-asset-supply-v0.1',
      api_version: 'v1',
      request_id: 'req_supply_1',
    })
    expect(response.headers.get('x-request-id')).toBe('req_supply_1')
    expect(response.headers.get('cache-control')).toBe('private, max-age=15, stale-while-revalidate=45')
    expect(response.headers.get('vary')).toBe('X-Request-ID, X-Axiom-Key')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('etag')).toMatch(/^W\/"[A-Za-z0-9_-]+"$/)
    expect(apiReconciliationSnapshotSchema.parse(body)).toEqual(body)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('preserves an explicit degraded state', async () => {
    readModel.load.mockResolvedValue({ snapshot: finalizedSnapshot('degraded'), stale: false, freshForSeconds: 110 })

    const response = await request()
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'get')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: 'degraded', confidence: 0.6, confidence_caps_applied: ['single_source'] })
  })

  it('returns an explicit unavailable persisted state', async () => {
    readModel.load.mockResolvedValue({ snapshot: finalizedSnapshot('unavailable'), stale: false, freshForSeconds: 110 })

    const response = await request()
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'get')
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ status: 'unavailable', value: null, sources_usable: 0 })
    expect(apiReconciliationSnapshotSchema.parse(body)).toEqual(body)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('never presents an expired finalized snapshot as current', async () => {
    readModel.load.mockResolvedValue({ snapshot: finalizedSnapshot(), stale: true, freshForSeconds: 0 })

    const response = await request()
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'get')
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
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'get')
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error).toMatchObject({
      code: 'supply_snapshot_not_found',
      message: 'No finalized supply snapshot is available',
    })
    expect(apiErrorResponseSchema.parse(body)).toEqual(body)
  })

  it.each(['native', 'usdc:not-an-issuer', `usd-:${ISSUER}`, 'USDC'])('rejects malformed or unsupported asset %s', async (asset) => {
    const response = await request(asset)
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'get')
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
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'get')
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.error).toMatchObject({
      code: 'supply_read_unavailable',
      message: 'The supply read model is temporarily unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('uses representation ETags and isolates caller-supplied request IDs', async () => {
    readModel.load.mockResolvedValue({ snapshot: finalizedSnapshot(), stale: false, freshForSeconds: 110 })
    const first = await request(ASSET, { headers: { 'X-Request-ID': 'req_supply_a' } })
    const etag = first.headers.get('etag')!

    const differentRequest = await request(ASSET, {
      headers: { 'If-None-Match': etag, 'X-Request-ID': 'req_supply_b' },
    })
    expect(differentRequest.status).toBe(200)
    expect(differentRequest.headers.get('etag')).not.toBe(etag)
    expect((await differentRequest.json()).request_id).toBe('req_supply_b')

    const response = await request(ASSET, {
      headers: { 'If-None-Match': etag, 'X-Request-ID': 'req_supply_a' },
    })
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'get')

    expect(response.status).toBe(304)
    expect(await response.text()).toBe('')
    expect(response.headers.get('etag')).toBe(etag)
    expect(response.headers.get('x-request-id')).toBe('req_supply_a')
  })

  it('never lets cache freshness exceed the remaining evidence lifetime', async () => {
    readModel.load.mockResolvedValue({ snapshot: finalizedSnapshot(), stale: false, freshForSeconds: 20 })
    expect((await request()).headers.get('cache-control')).toBe(
      'private, max-age=15, stale-while-revalidate=5',
    )

    readModel.load.mockResolvedValue({ snapshot: finalizedSnapshot(), stale: false, freshForSeconds: 0.9 })
    expect((await request()).headers.get('cache-control')).toBe('private, max-age=0, must-revalidate')
  })

  it('rejects query parameters and invalid request IDs before reading storage', async () => {
    const invalidQuery = await request(ASSET, undefined, '?cursor=unexpected')
    await expectOpenApiResponse(invalidQuery.clone(), OPENAPI_PATH, 'get')
    expect(invalidQuery.status).toBe(400)
    expect((await invalidQuery.json()).error.code).toBe('invalid_query_parameter')

    const invalidRequestId = await request(ASSET, { headers: { 'X-Request-ID': 'contains spaces' } })
    await expectOpenApiResponse(invalidRequestId.clone(), OPENAPI_PATH, 'get')
    expect(invalidRequestId.status).toBe(400)
    expect((await invalidRequestId.json()).error.code).toBe('invalid_request_id')
    expect(readModel.load).not.toHaveBeenCalled()
  })

  it('answers CORS preflight with the standardized policy', async () => {
    const response = OPTIONS(new Request(`https://axiom.example/api/v1/supply/${ASSET}`, {
      method: 'OPTIONS',
      headers: { 'X-Request-ID': 'req_supply_options' },
    }))
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'options')

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS')
    expect(response.headers.get('access-control-allow-headers')).toContain('X-Request-ID')
    expect(response.headers.get('x-request-id')).toBe('req_supply_options')
  })

  it('rejects invalid preflight IDs and unsupported methods with shared envelopes', async () => {
    const invalidPreflight = OPTIONS(new Request(`https://axiom.example/api/v1/supply/${ASSET}`, {
      method: 'OPTIONS',
      headers: { 'X-Request-ID': 'invalid request id' },
    }))
    await expectOpenApiResponse(invalidPreflight.clone(), OPENAPI_PATH, 'options')
    expect(invalidPreflight.status).toBe(400)
    expect((await invalidPreflight.json()).error.code).toBe('invalid_request_id')
    expect(invalidPreflight.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS')

    const unsupported = POST(new Request(`https://axiom.example/api/v1/supply/${ASSET}`, {
      method: 'POST',
      headers: { 'X-Request-ID': 'req_supply_post' },
    }))
    expect(unsupported.status).toBe(405)
    expect(unsupported.headers.get('allow')).toBe('GET, OPTIONS')
    expect(unsupported.headers.get('x-request-id')).toBe('req_supply_post')
    expect((await unsupported.json()).error.code).toBe('method_not_allowed')
  })
})
