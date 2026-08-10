import { describe, expect, it } from 'vitest'
import {
  ApiParameterError,
  DEFAULT_PAGE_SIZE,
  MAXIMUM_PAGE_SIZE,
  apiJsonResponse,
  parseApiPagination,
  resolveApiRequestId,
} from '../../lib/http/api'

describe('shared API HTTP behavior', () => {
  it('parses bounded cursor pagination with stable defaults', () => {
    expect(parseApiPagination(new URLSearchParams())).toEqual({ limit: DEFAULT_PAGE_SIZE })
    expect(parseApiPagination(new URLSearchParams(`cursor=next-page&limit=${MAXIMUM_PAGE_SIZE}`))).toEqual({
      cursor: 'next-page',
      limit: MAXIMUM_PAGE_SIZE,
    })
  })

  it.each([
    'limit=0',
    `limit=${MAXIMUM_PAGE_SIZE + 1}`,
    'limit=1.5',
    'limit=ten',
    'limit=10&limit=20',
    'cursor=one&cursor=two',
  ])('rejects invalid pagination %s', (query) => {
    expect(() => parseApiPagination(new URLSearchParams(query))).toThrow(ApiParameterError)
  })

  it('rejects unknown pagination parameters', () => {
    expect(() => parseApiPagination(new URLSearchParams('page=2'))).toThrowError(
      expect.objectContaining({ code: 'invalid_query_parameter' }),
    )
  })

  it('accepts safe correlation IDs and replaces invalid values for the error response', () => {
    expect(resolveApiRequestId(new Request('https://axiom.example', {
      headers: { 'X-Request-ID': 'request_123' },
    }))).toEqual({ ok: true, requestId: 'request_123' })

    const invalid = resolveApiRequestId(new Request('https://axiom.example', {
      headers: { 'X-Request-ID': 'unsafe request id' },
    }))
    expect(invalid).toMatchObject({ ok: false, code: 'invalid_request_id' })
    expect(invalid.requestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('emits opt-in deprecation, sunset, and successor headers', () => {
    const response = apiJsonResponse(
      new Request('https://axiom.example/api/v1/example'),
      { ok: true },
      {
        status: 200,
        requestId: 'request_123',
        cache: { maxAgeSeconds: 15, staleWhileRevalidateSeconds: 45 },
        deprecation: {
          deprecatedAt: '2026-09-01T00:00:00.000Z',
          sunsetAt: '2026-12-01T00:00:00.000Z',
          successorUrl: 'https://axiom.example/api/v2/example',
        },
      },
    )

    expect(response.headers.get('deprecation')).toBe('@1788220800')
    expect(response.headers.get('sunset')).toBe('Tue, 01 Dec 2026 00:00:00 GMT')
    expect(response.headers.get('link')).toBe('<https://axiom.example/api/v2/example>; rel="successor-version"')
  })

  it.each([
    'javascript:alert(1)',
    'data:text/plain,successor',
    'https://user:secret@axiom.example/api/v2/example',
  ])('rejects unsafe deprecation successor URL %s', (successorUrl) => {
    expect(() => apiJsonResponse(
      new Request('https://axiom.example/api/v1/example'),
      { ok: true },
      {
        status: 200,
        requestId: 'request_123',
        deprecation: {
          deprecatedAt: '2026-09-01T00:00:00.000Z',
          sunsetAt: '2026-12-01T00:00:00.000Z',
          successorUrl,
        },
      },
    )).toThrow('successorUrl must be an HTTP(S) URL without credentials')
  })
})
