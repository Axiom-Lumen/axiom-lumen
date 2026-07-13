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
      vi.fn(async (url: string | URL | Request) => {
        const target = String(url)
        if (target === 'https://a.example/' || target === 'https://b.example/') {
          return Response.json({ network_passphrase: 'Public Global Stellar Network ; September 2015' })
        }
        if (target === 'https://a.example/ledgers?order=desc&limit=1' || target === 'https://b.example/ledgers?order=desc&limit=1') {
          return Response.json(horizonPayload(500, new Date().toISOString()))
        }
        return new Response('not found', { status: 404 })
      }),
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
        const target = String(url)
        if (target === 'https://a.example/' || target === 'https://b.example/') {
          return Response.json({ network_passphrase: 'Public Global Stellar Network ; September 2015' })
        }
        if (target === 'https://a.example/ledgers?order=desc&limit=1') {
          return Response.json(horizonPayload(500, new Date().toISOString()))
        }
        if (target === 'https://b.example/ledgers?order=desc&limit=1') {
          return new Response('bad gateway', { status: 502 })
        }
        return new Response('not found', { status: 404 })
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
      vi.fn(async (url: string | URL | Request) => {
        const target = String(url)
        if (target === 'https://a.example/') {
          return Response.json({ network_passphrase: 'Public Global Stellar Network ; September 2015' })
        }
        if (target === 'https://a.example/ledgers?order=desc&limit=1') {
          return Response.json(horizonPayload(500, new Date().toISOString()))
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.value).toBe(500)
    expect(body.status).toBe('degraded')
    expect(body.confidence).toBeLessThanOrEqual(0.6)
    expect(body.sources_usable).toBe(1)
  })

  it('returns a degraded response when a mixed-network source is excluded', async () => {
    vi.stubEnv('STELLAR_HORIZON_URLS', 'https://main.example,https://test.example')
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === 'https://main.example/') {
        return Response.json({ network_passphrase: 'Public Global Stellar Network ; September 2015' })
      }
      if (target === 'https://test.example/') {
        return Response.json({ network_passphrase: 'Test SDF Network ; September 2015' })
      }
      if (target === 'https://main.example/ledgers?order=desc&limit=1') {
        return Response.json(horizonPayload(500, new Date().toISOString()))
      }
      if (target === 'https://test.example/ledgers?order=desc&limit=1') {
        return Response.json(horizonPayload(501, new Date().toISOString()))
      }
      return new Response('not found', { status: 404 })
    }))

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe('degraded')
    expect(body.value).toBe(500)
    expect(body.sources_usable).toBe(1)
    expect(body.sources_excluded).toBe(1)
    expect(body.discrepancies).toEqual([])
    expect(body.source_errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceId: 'horizon_2', code: 'network_mismatch' })]),
    )
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
