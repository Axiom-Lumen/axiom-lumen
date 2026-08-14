import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiErrorResponseSchema } from '../../lib/contracts'
import { latestLedgerResponseSchema, type LatestLedgerReconciliationResult } from '../../lib/reconcile/latest-ledger'
import { expectOpenApiResponse } from '../helpers/openapi-response'

const readModel = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../../lib/db/latest-ledger-read-model', () => ({
  loadLatestLedgerReadModel: readModel.load,
  latestLedgerProducerCycle: () => undefined,
}))
vi.mock('../../lib/db/api-access-repository', () => ({ authorizePublicApiKey: vi.fn(async () => ({ status: 'allowed', grant: { principalId: 'test', planId: 'developer', limit: 60, remaining: 59, resetAt: '2026-08-10T10:01:00.000Z' } })) }))

import { GET, OPTIONS, POST } from '../../app/api/v1/stellar/latest-ledger/route'

const OPENAPI_PATH = '/api/v1/stellar/latest-ledger'

const finalizedSnapshot: LatestLedgerReconciliationResult = latestLedgerResponseSchema.parse({
  metric: 'latest_ledger',
  value: 500,
  status: 'verified',
  confidence: 1,
  confidence_formula_version: 'latest-ledger-confidence-v0.2',
  confidence_components: { agreement: 1, freshness: 1, availability: 1, diversity: 1, spread: 1 },
  confidence_caps_applied: [],
  sources_configured: 2,
  sources_responded: 2,
  sources_usable: 2,
  sources_agreeing: 2,
  sources_excluded: 0,
  observations: [],
  discrepancies: [],
  source_errors: [],
  as_of: '2026-08-10T10:00:00.000Z',
  methodology_version: 'latest-ledger-v0.2',
})

describe('GET /api/v1/stellar/latest-ledger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    readModel.load.mockReset()
  })

  it('serves the latest finalized snapshot without waiting for an upstream request', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    readModel.load.mockResolvedValue(finalizedSnapshot)

    const response = await GET(new Request('https://axiom.example/api/v1/stellar/latest-ledger', {
      headers: { 'X-Request-ID': 'req_latest_1' },
    }))
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'get')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(finalizedSnapshot)
    expect(response.headers.get('x-request-id')).toBe('req_latest_1')
    expect(response.headers.get('cache-control')).toBe('private, max-age=15, stale-while-revalidate=45')
    expect(response.headers.get('vary')).toBe('X-Request-ID, X-Axiom-Key')
    expect(response.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('etag')).toMatch(/^W\/"[A-Za-z0-9_-]+"$/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(readModel.load).toHaveBeenCalledOnce()
  })

  it('returns the shared not-found envelope when no finalized snapshot exists', async () => {
    readModel.load.mockResolvedValue(null)

    const response = await GET(new Request('https://axiom.example/api/v1/stellar/latest-ledger'))
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'get')
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error).toMatchObject({
      code: 'latest_ledger_snapshot_not_found',
      message: 'No finalized latest-ledger snapshot is available',
    })
    expect(apiErrorResponseSchema.parse(body)).toEqual(body)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('returns a sanitized unavailable response when the read store fails', async () => {
    readModel.load.mockRejectedValue(new Error('postgres://user:secret@db.internal/axiom'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await GET(new Request('https://axiom.example/api/v1/stellar/latest-ledger'))
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'get')
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.error).toMatchObject({
      code: 'latest_ledger_read_unavailable',
      message: 'The latest-ledger read model is temporarily unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('returns 304 using weak comparison for a matching snapshot ETag', async () => {
    readModel.load.mockResolvedValue(finalizedSnapshot)
    const first = await GET(new Request('https://axiom.example/api/v1/stellar/latest-ledger'))
    const etag = first.headers.get('etag')!

    const response = await GET(new Request('https://axiom.example/api/v1/stellar/latest-ledger', {
      headers: { 'If-None-Match': etag.replace(/^W\//, '') },
    }))
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'get')

    expect(response.status).toBe(304)
    expect(await response.text()).toBe('')
    expect(response.headers.get('etag')).toBe(etag)
  })

  it('rejects query parameters and invalid request IDs', async () => {
    const invalidQuery = await GET(new Request('https://axiom.example/api/v1/stellar/latest-ledger?limit=10'))
    await expectOpenApiResponse(invalidQuery.clone(), OPENAPI_PATH, 'get')
    expect(invalidQuery.status).toBe(400)
    expect((await invalidQuery.json()).error.code).toBe('invalid_query_parameter')

    const invalidRequestId = await GET(new Request('https://axiom.example/api/v1/stellar/latest-ledger', {
      headers: { 'X-Request-ID': 'contains spaces' },
    }))
    await expectOpenApiResponse(invalidRequestId.clone(), OPENAPI_PATH, 'get')
    expect(invalidRequestId.status).toBe(400)
    expect((await invalidRequestId.json()).error.code).toBe('invalid_request_id')
    expect(readModel.load).not.toHaveBeenCalled()
  })

  it('answers CORS preflight with the standardized policy', async () => {
    const response = OPTIONS(new Request('https://axiom.example/api/v1/stellar/latest-ledger', {
      method: 'OPTIONS',
      headers: { 'X-Request-ID': 'req_options' },
    }))
    await expectOpenApiResponse(response.clone(), OPENAPI_PATH, 'options')

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS')
    expect(response.headers.get('access-control-allow-headers')).toContain('If-None-Match')
    expect(response.headers.get('access-control-max-age')).toBe('86400')
    expect(response.headers.get('x-request-id')).toBe('req_options')
  })

  it('rejects invalid preflight IDs and unsupported methods with shared envelopes', async () => {
    const invalidPreflight = OPTIONS(new Request('https://axiom.example/api/v1/stellar/latest-ledger', {
      method: 'OPTIONS',
      headers: { 'X-Request-ID': 'invalid request id' },
    }))
    await expectOpenApiResponse(invalidPreflight.clone(), OPENAPI_PATH, 'options')
    expect(invalidPreflight.status).toBe(400)
    expect((await invalidPreflight.json()).error.code).toBe('invalid_request_id')

    const unsupported = POST(new Request('https://axiom.example/api/v1/stellar/latest-ledger', {
      method: 'POST',
      headers: { 'X-Request-ID': 'req_latest_post' },
    }))
    expect(unsupported.status).toBe(405)
    expect(unsupported.headers.get('allow')).toBe('GET, OPTIONS')
    expect(unsupported.headers.get('access-control-allow-origin')).toBe('*')
    expect((await unsupported.json()).error.code).toBe('method_not_allowed')
  })
})
