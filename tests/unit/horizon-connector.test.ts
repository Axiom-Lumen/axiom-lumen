import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PUBLIC_NETWORK_PASSPHRASE,
  fetchLatestLedgersFromHorizonSources,
  parseHorizonSources,
} from '../../lib/stellar/horizon'

describe('parseHorizonSources', () => {
  it('trims, removes empties, normalizes trailing slashes, and deduplicates endpoints', () => {
    const sources = parseHorizonSources(' https://horizon.example/ , ,https://horizon.example, http://other.example/// ')

    expect(sources).toEqual([
      { id: 'horizon_1', url: 'https://horizon.example' },
      { id: 'horizon_2', url: 'http://other.example' },
    ])
  })

  it('rejects non-http URLs and unreasonable source counts', () => {
    expect(() => parseHorizonSources('ftp://horizon.example')).toThrow(/http or https/)

    const tooMany = Array.from({ length: 11 }, (_, index) => `https://h${index}.example`).join(',')
    expect(() => parseHorizonSources(tooMany)).toThrow(/at most 10/)
  })

  it('rejects credentials, private hosts, and hosts outside endpoint policy', () => {
    expect(() => parseHorizonSources('https://user:secret@horizon.example')).toThrow(/credentials/)
    expect(() => parseHorizonSources('http://127.0.0.1:8000')).toThrow(/not allowed/)
    expect(() => parseHorizonSources('http://[::ffff:127.0.0.1]:8000')).toThrow(/not allowed/)
    expect(() => parseHorizonSources('https://horizon.example', { deniedHosts: ['horizon.example'] })).toThrow(
      /denied by policy/,
    )
    expect(() => parseHorizonSources('https://other.example', { allowedHosts: ['horizon.example'] })).toThrow(
      /allow list/,
    )
  })
})

describe('fetchLatestLedgersFromHorizonSources', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const sources = [{ id: 'horizon_1', url: 'https://horizon.example' }]
  const payload = {
    _embedded: {
      records: [{ sequence: 123, closed_at: '2026-07-12T12:00:00Z' }],
    },
  }

  it('returns a normalized latest-ledger observation', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === 'https://horizon.example/') {
        return Response.json({ network_passphrase: 'Public Global Stellar Network ; September 2015' })
      }
      if (target === 'https://horizon.example/ledgers?order=desc&limit=1') {
        return Response.json(payload)
      }
      throw new Error(`Unexpected request: ${target}`)
    })
    const result = await fetchLatestLedgersFromHorizonSources({ sources, fetchImpl })

    expect(fetchImpl).toHaveBeenCalledWith('https://horizon.example/', expect.any(Object))
    expect(fetchImpl).toHaveBeenCalledWith('https://horizon.example/ledgers?order=desc&limit=1', expect.any(Object))
    expect(result.source_errors).toEqual([])
    expect(result.observations[0]).toMatchObject({
      sourceId: 'horizon_1',
      sourceUrl: 'https://horizon.example',
      ledgerSequence: 123,
      closedAt: '2026-07-12T12:00:00.000Z',
      rawPayload: payload._embedded.records[0],
    })
    expect(result.observations[0].retrievedAt).toEqual(expect.any(String))
  })

  it('uses one injected completion timestamp for the complete cycle output', async () => {
    const cycleTime = new Date('2026-08-09T14:15:16.000Z')
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/')
        ? Response.json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
        : Response.json(payload),
    )
    const result = await fetchLatestLedgersFromHorizonSources({
      sources,
      fetchImpl,
      clock: () => new Date(cycleTime),
    })

    expect(result.retrieved_at).toBe(cycleTime.toISOString())
    expect(result.observations[0]?.retrievedAt).toBe(cycleTime.toISOString())
  })

  it('records retrieval completion after all upstream work finishes', async () => {
    const times = [
      new Date('2026-08-09T14:15:16.000Z'),
      new Date('2026-08-09T14:15:18.000Z'),
    ]
    let clockCalls = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/')
        ? Response.json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
        : Response.json(payload),
    )

    const result = await fetchLatestLedgersFromHorizonSources({
      sources,
      fetchImpl,
      clock: () => new Date(times[clockCalls++]!),
    })

    expect(clockCalls).toBe(2)
    expect(result.retrieved_at).toBe(times[1]?.toISOString())
    expect(result.observations[0]?.retrievedAt).toBe(times[1]?.toISOString())
  })

  it('records non-200 responses as source errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad gateway', { status: 502 }))
    const result = await fetchLatestLedgersFromHorizonSources({ sources, fetchImpl })

    expect(result.observations).toEqual([])
    expect(result.source_errors[0]).toMatchObject({ code: 'non_200_response', status: 502 })
  })

  it('records malformed JSON payloads as source errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('{nope', { status: 200 }))
    const result = await fetchLatestLedgersFromHorizonSources({ sources, fetchImpl })

    expect(result.observations).toEqual([])
    expect(result.source_errors[0]).toMatchObject({ code: 'malformed_payload' })
  })

  it('rejects a root payload that does not match the expected schema', async () => {
    const result = await fetchLatestLedgersFromHorizonSources({
      sources,
      fetchImpl: vi.fn(async () => Response.json({ horizon_version: 'unknown' })),
    })

    expect(result.observations).toEqual([])
    expect(result.source_errors[0]).toMatchObject({ code: 'malformed_payload' })
  })

  it('bounds response bodies before parsing JSON', async () => {
    const result = await fetchLatestLedgersFromHorizonSources({
      sources,
      maxResponseBytes: 16,
      fetchImpl: vi.fn(async () => Response.json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })),
    })

    expect(result.observations).toEqual([])
    expect(result.source_errors[0]).toMatchObject({ code: 'response_too_large' })
  })

  it('rejects redirects and disables automatic redirect following', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://other.example/' } }))
    const result = await fetchLatestLedgersFromHorizonSources({ sources, fetchImpl })

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://horizon.example/',
      expect.objectContaining({ redirect: 'error' }),
    )
    expect(result.source_errors[0]).toMatchObject({ code: 'redirect_rejected' })
  })

  it('rejects duplicate source identities before retrieval', async () => {
    await expect(
      fetchLatestLedgersFromHorizonSources({
        sources: [
          { id: 'duplicate', url: 'https://a.example' },
          { id: 'duplicate', url: 'https://b.example' },
        ],
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/duplicate Horizon source ID/)
  })

  it('applies endpoint security policy to database-discovered sources before retrieval', async () => {
    const fetchImpl = vi.fn()
    await expect(
      fetchLatestLedgersFromHorizonSources({
        sources: [{ id: 'database-source', url: 'http://127.0.0.1:8000' }],
        fetchImpl,
      }),
    ).rejects.toThrow(/not allowed/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('records empty ledger records as source errors', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === 'https://horizon.example/') {
        return Response.json({ network_passphrase: 'Public Global Stellar Network ; September 2015' })
      }
      if (target === 'https://horizon.example/ledgers?order=desc&limit=1') {
        return Response.json({ _embedded: { records: [] } })
      }
      throw new Error(`Unexpected request: ${target}`)
    })
    const result = await fetchLatestLedgersFromHorizonSources({ sources, fetchImpl })

    expect(result.observations).toEqual([])
    expect(result.source_errors[0]).toMatchObject({ code: 'empty_ledger_records' })
  })

  it('records malformed ledger records as source errors', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ _embedded: { records: [{ sequence: 'abc' }] } }))
    const result = await fetchLatestLedgersFromHorizonSources({ sources, fetchImpl })

    expect(result.observations).toEqual([])
    expect(result.source_errors[0]).toMatchObject({ code: 'malformed_payload' })
  })

  it('records timed-out requests as aborted source errors', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    )

    const pending = fetchLatestLedgersFromHorizonSources({ sources, fetchImpl, timeoutMs: 25 })
    await vi.advanceTimersByTimeAsync(25)
    const result = await pending

    expect(result.observations).toEqual([])
    expect(result.source_errors[0]).toMatchObject({ code: 'request_aborted' })
  })

  it('records externally aborted requests as source errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError')
    })
    const result = await fetchLatestLedgersFromHorizonSources({ sources, fetchImpl })

    expect(result.observations).toEqual([])
    expect(result.source_errors[0]).toMatchObject({ code: 'request_aborted' })
  })

  it('propagates worker cancellation instead of recording a source failure', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))
        }),
    )
    const pending = fetchLatestLedgersFromHorizonSources({ sources, fetchImpl, signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('excludes sources whose reported network passphrase does not match', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === 'https://main.example/') {
        return Response.json({ network_passphrase: 'Public Global Stellar Network ; September 2015' })
      }
      if (target === 'https://test.example/') {
        return Response.json({ network_passphrase: 'Test SDF Network ; September 2015' })
      }
      if (target === 'https://main.example/ledgers?order=desc&limit=1') {
        return Response.json({ _embedded: { records: [{ sequence: 123, closed_at: '2026-07-12T12:00:00Z' }] } })
      }
      if (target === 'https://test.example/ledgers?order=desc&limit=1') {
        return Response.json({ _embedded: { records: [{ sequence: 321, closed_at: '2026-07-12T12:00:00Z' }] } })
      }
      throw new Error(`Unexpected request: ${target}`)
    })

    const result = await fetchLatestLedgersFromHorizonSources({
      sources: [
        { id: 'horizon_1', url: 'https://main.example' },
        { id: 'horizon_2', url: 'https://test.example' },
      ],
      fetchImpl,
    })

    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]).toMatchObject({ sourceId: 'horizon_1', ledgerSequence: 123 })
    expect(result.source_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: 'horizon_2', code: 'network_mismatch' }),
      ]),
    )
  })

  it('uses configured network identity instead of trusting the first responding source', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === 'https://test.example/') {
        return Response.json({ network_passphrase: 'Test SDF Network ; September 2015' })
      }
      if (target === 'https://main.example/') {
        return Response.json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
      }
      if (target === 'https://main.example/ledgers?order=desc&limit=1') return Response.json(payload)
      throw new Error(`Unexpected request: ${target}`)
    })

    const result = await fetchLatestLedgersFromHorizonSources({
      sources: [
        { id: 'test', url: 'https://test.example' },
        { id: 'main', url: 'https://main.example' },
      ],
      fetchImpl,
    })

    expect(result.observations.map((item) => item.sourceId)).toEqual(['main'])
    expect(result.source_errors).toEqual([
      expect.objectContaining({ sourceId: 'test', code: 'network_mismatch' }),
    ])
  })
})
