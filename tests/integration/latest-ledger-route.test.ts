import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from '../../app/api/v1/stellar/latest-ledger/route'

function horizonPayload(sequence: number, closedAt = '2026-07-12T12:00:00Z') {
  return {
    _embedded: {
      records: [{ sequence, closed_at: closedAt }],
    },
  }
}

describe('GET /api/v1/stellar/latest-ledger', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('returns a verified response for agreeing Horizon sources', async () => {
    vi.stubEnv('STELLAR_HORIZON_URLS', 'https://a.example,https://b.example')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(horizonPayload(500, new Date().toISOString()))),
    )

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      metric: 'latest_ledger',
      value: 500,
      status: 'verified',
      sources_configured: 2,
      sources_responded: 2,
      sources_usable: 2,
      sources_agreeing: 2,
      discrepancies: [],
      source_errors: [],
    })
  })

  it('keeps source failures separate from data discrepancies', async () => {
    vi.stubEnv('STELLAR_HORIZON_URLS', 'https://a.example,https://b.example')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).startsWith('https://b.example')) {
          return new Response('bad gateway', { status: 502 })
        }
        return Response.json(horizonPayload(500, new Date().toISOString()))
      }),
    )

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe('degraded')
    expect(body.value).toBe(500)
    expect(body.discrepancies).toEqual([])
    expect(body.source_errors).toHaveLength(1)
    expect(body.source_errors[0]).toMatchObject({ sourceId: 'horizon_2', code: 'non_200_response' })
    expect(body.sources_configured).toBe(2)
    expect(body.sources_responded).toBe(2)
    expect(body.sources_usable).toBe(1)
    expect(body.confidence).toBeLessThanOrEqual(0.6)
  })

  it('returns a degraded one-source result without calling it fully verified', async () => {
    vi.stubEnv('STELLAR_HORIZON_URLS', 'https://a.example')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(horizonPayload(500, new Date().toISOString()))),
    )

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.value).toBe(500)
    expect(body.status).toBe('degraded')
    expect(body.confidence).toBeLessThanOrEqual(0.6)
    expect(body.sources_usable).toBe(1)
  })

  it('returns unavailable when no Horizon sources are configured', async () => {
    vi.stubEnv('STELLAR_HORIZON_URLS', '')

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      metric: 'latest_ledger',
      value: null,
      status: 'unavailable',
      confidence: 0,
      sources_configured: 0,
      sources_usable: 0,
    })
    expect(body.source_errors[0]).toMatchObject({ code: 'invalid_configuration' })
  })

  it('returns unavailable when all configured sources fail', async () => {
    vi.stubEnv('STELLAR_HORIZON_URLS', 'https://a.example,https://b.example')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })))

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.value).toBeNull()
    expect(body.status).toBe('unavailable')
    expect(body.source_errors).toHaveLength(2)
    expect(body.discrepancies).toEqual([])
  })
})
