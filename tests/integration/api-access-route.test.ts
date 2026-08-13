import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiErrorResponseSchema } from '../../lib/contracts'
import { expectOpenApiResponse } from '../helpers/openapi-response'

const access = vi.hoisted(() => ({ authorize: vi.fn() }))
const readModel = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../../lib/db/api-access-repository', () => ({ authorizePublicApiKey: access.authorize }))
vi.mock('../../lib/db/latest-ledger-read-model', () => ({ loadLatestLedgerReadModel: readModel.load }))

import { GET as latestGet, OPTIONS as latestOptions } from '../../app/api/v1/stellar/latest-ledger/route'
import { GET as supplyGet } from '../../app/api/v1/supply/[asset]/route'
import { GET as depthGet } from '../../app/api/v1/depth/[pair]/route'
import { GET as trustlineGet } from '../../app/api/v1/trustlines/[asset]/route'
import { GET as anchorGet } from '../../app/api/v1/anchors/[anchor]/reserves/route'

const ISSUER = `G${'A'.repeat(55)}`
const ASSET = `USD:${ISSUER}`
const protectedRoutes = [
  { path: '/api/v1/stellar/latest-ledger', call: (headers?: HeadersInit) => latestGet(new Request('https://axiom.example/api/v1/stellar/latest-ledger', { headers })) },
  { path: '/api/v1/supply/{asset}', call: (headers?: HeadersInit) => supplyGet(new Request(`https://axiom.example/api/v1/supply/${ASSET}`, { headers }), { params: Promise.resolve({ asset: ASSET }) }) },
  { path: '/api/v1/depth/{pair}', call: (headers?: HeadersInit) => depthGet(new Request(`https://axiom.example/api/v1/depth/native~${ASSET}`, { headers }), { params: Promise.resolve({ pair: `native~${ASSET}` }) }) },
  { path: '/api/v1/trustlines/{asset}', call: (headers?: HeadersInit) => trustlineGet(new Request(`https://axiom.example/api/v1/trustlines/${ASSET}`, { headers }), { params: Promise.resolve({ asset: ASSET }) }) },
  { path: '/api/v1/anchors/{anchor}/reserves', call: (headers?: HeadersInit) => anchorGet(new Request('https://axiom.example/api/v1/anchors/anchor-a/reserves', { headers }), { params: Promise.resolve({ anchor: 'anchor-a' }) }) },
]

function request(key?: string) {
  return latestGet(new Request('https://axiom.example/api/v1/stellar/latest-ledger', {
    headers: key ? { 'X-Axiom-Key': key } : undefined,
  }))
}

describe('public API access boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    access.authorize.mockReset()
    readModel.load.mockReset()
  })

  it('returns one indistinguishable 401 contract for missing or invalid credentials', async () => {
    vi.stubEnv('AXIOM_API_AUTH_REQUIRED', 'true')
    access.authorize.mockResolvedValue({ status: 'unauthorized' })
    for (const route of protectedRoutes) {
      const response = await route.call()
      await expectOpenApiResponse(response.clone(), route.path, 'get')
      expect(response.status).toBe(401)
      expect(apiErrorResponseSchema.parse(await response.json()).error).toEqual({ code: 'authentication_required', message: 'A valid API key is required' })
    }
    expect((await request('malformed')).status).toBe(401)
    expect(readModel.load).not.toHaveBeenCalled()
  })

  it('adds quota metadata to authenticated application responses', async () => {
    vi.stubEnv('AXIOM_API_AUTH_REQUIRED', 'true')
    access.authorize.mockResolvedValue({ status: 'allowed', grant: { principalId: 'client-a', planId: 'developer', limit: 60, remaining: 41, resetAt: '2026-08-10T10:01:00.000Z' } })
    readModel.load.mockResolvedValue(null)
    const response = await request('opaque-key')
    expect(response.status).toBe(404)
    expect(response.headers.get('x-ratelimit-limit')).toBe('60')
    expect(response.headers.get('x-ratelimit-remaining')).toBe('41')
    expect(response.headers.get('x-ratelimit-reset')).toBe('1786356060')
  })

  it('returns 429 before route work and reports the retry boundary', async () => {
    vi.stubEnv('AXIOM_API_AUTH_REQUIRED', 'true')
    access.authorize.mockResolvedValue({ status: 'rate_limited', limit: 2, remaining: 0, resetAt: '2026-08-10T10:01:00.000Z', retryAfterSeconds: 17 })
    for (const route of protectedRoutes) {
      const response = await route.call({ 'X-Axiom-Key': 'opaque-key' })
      await expectOpenApiResponse(response.clone(), route.path, 'get')
      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBe('17')
      expect(response.headers.get('x-ratelimit-remaining')).toBe('0')
      expect((await response.json()).error.code).toBe('rate_limit_exceeded')
    }
    expect(readModel.load).not.toHaveBeenCalled()
  })

  it('keeps preflight unauthenticated, permits the key header, and consumes no quota', () => {
    vi.stubEnv('AXIOM_API_AUTH_REQUIRED', 'true')
    const response = latestOptions(new Request('https://axiom.example/api/v1/stellar/latest-ledger', { method: 'OPTIONS' }))
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toContain('X-Axiom-Key')
    expect(access.authorize).not.toHaveBeenCalled()
  })

  it('fails closed when the production access policy is absent or invalid', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AXIOM_API_AUTH_REQUIRED', '')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await request()
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe('api_access_unavailable')
    expect(access.authorize).not.toHaveBeenCalled()
  })

  it('fails closed and sanitizes authentication-store errors', async () => {
    vi.stubEnv('AXIOM_API_AUTH_REQUIRED', 'true')
    access.authorize.mockRejectedValue(new Error('postgres://secret'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await request('opaque-key')
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).not.toContain('secret')
    expect(readModel.load).not.toHaveBeenCalled()
  })
})
