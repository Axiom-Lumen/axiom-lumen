import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { orderBookDepthObservationSchema } from '../../lib/contracts/domain'
import { PUBLIC_NETWORK_PASSPHRASE } from '../../lib/stellar/horizon'
import {
  fetchHorizonOrderBookDepth,
  toRawDepthObservations,
} from '../../lib/stellar/horizon-depth'

const ISSUER = `G${'A'.repeat(55)}`
const ROOT = 'https://horizon.example'
const XLM = { kind: 'native' as const }
const USDC = { kind: 'credit' as const, code: 'USDC', issuer: ISSUER }
const PAIR = { base: XLM, counter: USDC }
const NETWORK = { id: 'public' as const, passphrase: PUBLIC_NETWORK_PASSPHRASE }
const SOURCE = {
  id: 'sdex_horizon_1',
  url: ROOT,
  sourceClass: 'dex' as const,
  adapter: 'sdex' as const,
  network: NETWORK,
}
const NOW = new Date('2026-08-11T12:00:00.000Z')
const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/stellar/horizon-depth-offers.json', import.meta.url),
  'utf8',
)) as { asks: Record<string, unknown>[]; bids: Record<string, unknown>[] }

function json(payload: unknown, latestLedger?: number, status = 200) {
  return Response.json(payload, {
    status,
    headers: latestLedger ? { 'Latest-Ledger': String(latestLedger) } : undefined,
  })
}

function page(records: unknown[], next?: string) {
  return { _links: { next: next ? { href: next } : undefined }, _embedded: { records } }
}

function isAskUrl(target: string) {
  const url = new URL(target)
  return url.pathname === '/offers' && url.searchParams.get('selling_asset_type') === 'native'
}

function isBidUrl(target: string) {
  const url = new URL(target)
  return url.pathname === '/offers' && url.searchParams.get('selling_asset_code') === 'USDC'
}

function baseFetch({ asks = fixture.asks, bids = fixture.bids, ledger = 500, closedAt = '2026-08-11T11:59:55Z' } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const target = String(input)
    if (target === `${ROOT}/`) return json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
    if (isAskUrl(target)) return json(page(asks), ledger)
    if (isBidUrl(target)) return json(page(bids), ledger)
    if (target === `${ROOT}/ledgers/${ledger}`) return json({ sequence: ledger, closed_at: closedAt })
    throw new Error(`Unexpected request: ${target}`)
  })
}

async function collect(fetchImpl = baseFetch(), extras: Record<string, unknown> = {}) {
  return fetchHorizonOrderBookDepth({
    source: SOURCE,
    pair: PAIR,
    expectedNetwork: NETWORK,
    fetchImpl,
    clock: () => new Date(NOW),
    ...extras,
  })
}

describe('fetchHorizonOrderBookDepth', () => {
  it('collects exact same-ledger SDEX depth and excludes out-of-band offers', async () => {
    const result = await collect()

    expect(result.error).toBeUndefined()
    const observation = result.observation!
    expect(observation).toMatchObject({
      pair: PAIR,
      pairKey: `native/USDC:${ISSUER}`,
      requestedPairReversed: false,
      bookStatus: 'complete',
      ledgerSequence: 500,
      ledgerClosedAt: '2026-08-11T11:59:55.000Z',
      methodologyVersion: 'order-book-depth-v0.1',
      connectorVersion: 'horizon-depth-v0.1',
      derivationFamily: 'horizon_sdex_offers',
      liquidityPoolsIncluded: false,
      scanMetadata: { pagesScanned: 2, recordsScanned: 3, ledgerRestarts: 0 },
    })
    expect(observation.midpoint?.toJSON()).toEqual({ n: '201', d: '200' })
    expect(observation.buckets.map((bucket) => [bucket.side, bucket.priceBandBasisPoints, bucket.amount.toString(), bucket.offerCount])).toEqual([
      ['bid', 50, '10', 1],
      ['ask', 50, '10', 1],
      ['bid', 100, '10', 1],
      ['ask', 100, '10', 1],
      ['bid', 500, '10', 1],
      ['ask', 500, '10', 1],
    ])
    expect(observation.levels.asks).toHaveLength(2)
    expect(observation.requestProvenance.map(({ kind, side, latestLedger }) => [kind, side, latestLedger])).toEqual([
      ['root', null, null],
      ['offer_page', 'ask', 500],
      ['offer_page', 'bid', 500],
      ['ledger', null, null],
    ])
    expect(observation.evidenceSha256).toMatch(/^[0-9a-f]{64}$/)

    const raw = toRawDepthObservations({ observationIdPrefix: 'depth', cycleId: 'cycle_1', observation })
    expect(raw).toHaveLength(6)
    expect(raw[0]).toMatchObject({
      metric: 'order_book_depth',
      side: 'bid',
      priceBandBasisPoints: 50,
      ledgerSequence: 500,
      methodologyVersion: 'order-book-depth-v0.1',
      derivation: { family: 'horizon_sdex_offers' },
    })

    const first = raw[0]!
    expect(() => orderBookDepthObservationSchema.parse({
      ...first,
      priceBandBasisPoints: 37,
    })).toThrow(/one of 50, 100, 500/)
    expect(() => orderBookDepthObservationSchema.parse({
      ...first,
      pair: { base: first.pair.counter, counter: first.pair.base },
    })).toThrow(/canonical asset order/)
    expect(() => orderBookDepthObservationSchema.parse({
      ...first,
      derivation: {
        ...first.derivation,
        checkpoint: { ...first.derivation.checkpoint, ledgerSequence: 499 },
      },
    })).toThrow(/checkpoint must match/)
    expect(() => orderBookDepthObservationSchema.parse({
      ...first,
      provenance: {
        ...first.provenance,
        source: { ...first.provenance.source, adapter: 'horizon', sourceClass: 'canonical_ledger' },
      },
    })).toThrow(/dex\/sdex/)
  })

  it('canonicalizes reversed requests before querying Horizon', async () => {
    const result = await collect(baseFetch(), { pair: { base: USDC, counter: XLM } })

    expect(result.observation).toMatchObject({ pair: PAIR, requestedPairReversed: true })
  })

  it('paginates both sides without changing the pair filters', async () => {
    const visited: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const target = String(input)
      visited.push(target)
      if (target === `${ROOT}/`) return json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
      if (isAskUrl(target)) {
        const url = new URL(target)
        if (!url.searchParams.has('cursor')) {
          url.searchParams.set('cursor', 'ask-next')
          return json(page([fixture.asks[0]], url.toString()), 500)
        }
        return json(page([fixture.asks[1]]), 500)
      }
      if (isBidUrl(target)) {
        const url = new URL(target)
        if (!url.searchParams.has('cursor')) {
          url.searchParams.set('cursor', 'bid-next')
          return json(page(fixture.bids, url.toString()), 500)
        }
        return json(page([]), 500)
      }
      if (target === `${ROOT}/ledgers/500`) return json({ sequence: 500, closed_at: '2026-08-11T11:59:55Z' })
      throw new Error(`Unexpected request: ${target}`)
    })

    const result = await collect(fetchImpl)

    expect(result.observation?.scanMetadata).toMatchObject({ pagesScanned: 4, recordsScanned: 3 })
    expect(visited.filter((target) => isAskUrl(target))).toHaveLength(2)
    expect(visited.filter((target) => isBidUrl(target))).toHaveLength(2)
  })

  it('inverts bid prices and rounds base-equivalent depth down at the connector boundary', async () => {
    const ask = {
      ...fixture.asks[0],
      price_r: { n: 151, d: 100 },
      price: '1.5100000',
    }
    const bid = {
      ...fixture.bids[0],
      amount: '1.0000000',
      price_r: { n: 2, d: 3 },
      price: '0.6666667',
    }

    const result = await collect(baseFetch({ asks: [ask], bids: [bid] }))

    expect(result.observation?.bestBid?.toJSON()).toEqual({ n: '3', d: '2' })
    expect(result.observation?.midpoint?.toJSON()).toEqual({ n: '301', d: '200' })
    expect(result.observation?.buckets.find((bucket) =>
      bucket.side === 'bid' && bucket.priceBandBasisPoints === 50
    )?.amount.toFixed()).toBe('0.6666666')
  })

  it.each([
    ['empty', [], [], 'empty'],
    ['ask-only thin', [fixture.asks[0]], [], 'one_sided'],
    ['bid-only thin', [], fixture.bids, 'one_sided'],
  ])('returns a non-fabricated %s book state', async (_label, asks, bids, expectedStatus) => {
    const result = await collect(baseFetch({ asks, bids }))

    expect(result.observation).toMatchObject({ bookStatus: expectedStatus, midpoint: null, buckets: [] })
    expect(toRawDepthObservations({
      observationIdPrefix: 'depth', cycleId: 'cycle_1', observation: result.observation!,
    })).toEqual([])
  })

  it('rejects a crossed book', async () => {
    const crossedBid = {
      ...fixture.bids[0],
      price_r: { n: 1, d: 2 },
      price: '0.5000000',
    }
    const result = await collect(baseFetch({ bids: [crossedBid] }))

    expect(result.error).toMatchObject({ code: 'crossed_book' })
  })

  it('rejects books beyond the hard freshness bound', async () => {
    const older = (record: Record<string, unknown>) => ({
      ...record,
      last_modified_ledger: 499,
      last_modified_time: '2026-08-11T11:59:30Z',
    })
    const result = await collect(baseFetch({
      asks: fixture.asks.map(older),
      bids: fixture.bids.map(older),
      closedAt: '2026-08-11T11:59:39Z',
    }))

    expect(result.error).toMatchObject({ code: 'stale_book' })
  })

  it('restarts the complete scan when rapid updates cross a ledger boundary', async () => {
    let roots = 0
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const target = String(input)
      if (target === `${ROOT}/`) {
        roots += 1
        return json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
      }
      if (isAskUrl(target)) return json(page(fixture.asks), roots === 1 ? 500 : 501)
      if (isBidUrl(target)) return json(page(fixture.bids), 501)
      if (target === `${ROOT}/ledgers/501`) return json({ sequence: 501, closed_at: '2026-08-11T11:59:56Z' })
      throw new Error(`Unexpected request: ${target}`)
    })

    const result = await collect(fetchImpl)

    expect(result.observation).toMatchObject({ ledgerSequence: 501, scanMetadata: { ledgerRestarts: 1 } })
    expect(roots).toBe(2)
  })

  it('fails closed when ledger drift exceeds the restart budget', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const target = String(input)
      if (target === `${ROOT}/`) return json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
      if (isAskUrl(target)) return json(page(fixture.asks), 500)
      if (isBidUrl(target)) return json(page(fixture.bids), 501)
      throw new Error(`Unexpected request: ${target}`)
    })
    const result = await collect(fetchImpl, { maxLedgerRestarts: 0 })

    expect(result.error).toMatchObject({ code: 'ledger_changed', restartRequired: true })
  })

  it('enforces page budgets and validates rational price rounding', async () => {
    const nextFetch = vi.fn(async (input: string | URL | Request) => {
      const target = String(input)
      if (target === `${ROOT}/`) return json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
      if (isAskUrl(target)) {
        const url = new URL(target)
        const current = url.searchParams.get('cursor')
        const next = current === null ? 'one' : current === 'one' ? 'two' : 'three'
        url.searchParams.set('cursor', next)
        return json(page([{ ...fixture.asks[0], id: next, paging_token: next }], url.toString()), 500)
      }
      throw new Error(`Unexpected request: ${target}`)
    })
    const bounded = await collect(nextFetch, { maxPages: 2 })
    expect(bounded.error).toMatchObject({ code: 'partial_scan' })

    const inconsistent = { ...fixture.asks[0], price: '1.0100001' }
    const malformed = await collect(baseFetch({ asks: [inconsistent] }))
    expect(malformed.error).toMatchObject({ code: 'malformed_payload', message: expect.stringMatching(/price_r/) })
  })

  it('enforces the combined record budget and rejects duplicate paging tokens', async () => {
    const bounded = await collect(baseFetch(), { maxRecords: 2 })
    expect(bounded.error).toMatchObject({ code: 'partial_scan' })

    const duplicateFetch = vi.fn(async (input: string | URL | Request) => {
      const target = String(input)
      if (target === `${ROOT}/`) return json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
      if (isAskUrl(target)) {
        const url = new URL(target)
        if (!url.searchParams.has('cursor')) {
          url.searchParams.set('cursor', 'next')
          return json(page([fixture.asks[0]], url.toString()), 500)
        }
        return json(page([fixture.asks[0]]), 500)
      }
      throw new Error(`Unexpected request: ${target}`)
    })
    const duplicate = await collect(duplicateFetch)
    expect(duplicate.error).toMatchObject({ code: 'duplicate_record', restartRequired: true })
  })

  it('rejects network mismatches and unsafe next-page origins', async () => {
    const mismatchFetch = vi.fn(async () => json({ network_passphrase: 'Test SDF Network ; September 2015' }))
    expect((await collect(mismatchFetch)).error).toMatchObject({ code: 'network_mismatch' })

    const unsafeFetch = vi.fn(async (input: string | URL | Request) => {
      const target = String(input)
      if (target === `${ROOT}/`) return json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
      if (isAskUrl(target)) return json(page([fixture.asks[0]], 'https://attacker.example/offers?cursor=next'), 500)
      throw new Error(`Unexpected request: ${target}`)
    })
    expect((await collect(unsafeFetch)).error).toMatchObject({ code: 'malformed_payload' })
  })

  it('returns a safe structured error for malformed source and network identities', async () => {
    const malformedSource = await fetchHorizonOrderBookDepth({
      source: null,
      pair: PAIR,
      expectedNetwork: NETWORK,
      fetchImpl: vi.fn(),
      clock: () => new Date(NOW),
    })
    expect(malformedSource.error).toMatchObject({
      code: 'invalid_configuration',
      sourceId: null,
      sourceUrl: null,
    })

    const malformedNetwork = await fetchHorizonOrderBookDepth({
      source: SOURCE,
      pair: PAIR,
      expectedNetwork: null,
      fetchImpl: vi.fn(),
      clock: () => new Date(NOW),
    })
    expect(malformedNetwork.error).toMatchObject({ code: 'invalid_configuration' })
  })
})
