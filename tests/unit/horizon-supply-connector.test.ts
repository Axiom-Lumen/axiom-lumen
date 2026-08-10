import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PUBLIC_NETWORK_PASSPHRASE } from '../../lib/stellar/horizon'
import {
  fetchHorizonOnchainAssetSupply,
  type HorizonSupplyCheckpoint,
} from '../../lib/stellar/horizon-supply'

const ISSUER = `G${'A'.repeat(55)}`
const ROOT = 'https://horizon.example'
const ASSET = { kind: 'credit' as const, code: 'USDC', issuer: ISSUER }
const NETWORK = { id: 'public' as const, passphrase: PUBLIC_NETWORK_PASSPHRASE }
const SOURCE = {
  id: 'horizon_1',
  url: ROOT,
  sourceClass: 'canonical_ledger' as const,
  adapter: 'horizon' as const,
  network: NETWORK,
}
const NOW = new Date('2026-08-10T12:00:00.000Z')
const fixtureUrl = new URL('../fixtures/stellar/horizon-supply-asset.json', import.meta.url)
const ASSET_RECORD = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as Record<string, unknown>

function json(payload: unknown, latestLedger?: number, status = 200) {
  const headers = latestLedger ? { 'Latest-Ledger': String(latestLedger) } : undefined
  return Response.json(payload, { status, headers })
}

function assetPage(records: unknown[], next?: string) {
  return {
    _links: { next: next ? { href: next } : undefined },
    _embedded: { records },
  }
}

function baseFetch(assetResponse: () => Response = () => json(assetPage([ASSET_RECORD]), 500)) {
  return vi.fn(async (url: string | URL | Request) => {
    const target = String(url)
    if (target === `${ROOT}/`) return json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
    if (target === `${ROOT}/accounts/${ISSUER}`) return json({ account_id: ISSUER, home_domain: 'issuer.example' }, 499)
    if (target.startsWith(`${ROOT}/assets?`)) return assetResponse()
    if (target === `${ROOT}/ledgers/500`) return json({ sequence: 500, closed_at: '2026-08-10T11:59:55Z' })
    throw new Error(`Unexpected request: ${target}`)
  })
}

async function collect(fetchImpl = baseFetch(), options: Record<string, unknown> = {}) {
  return fetchHorizonOnchainAssetSupply({
    source: SOURCE,
    asset: ASSET,
    expectedNetwork: NETWORK,
    fetchImpl,
    clock: () => new Date(NOW),
    ...options,
  })
}

describe('fetchHorizonOnchainAssetSupply', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('collects a ledger-consistent decimal-safe total with complete provenance', async () => {
    const fetchImpl = baseFetch()
    const result = await collect(fetchImpl)

    expect(result.error).toBeUndefined()
    const observation = result.observation!
    expect(observation.amount.toString()).toBe('1000')
    expect(Object.fromEntries(Object.entries(observation.components).map(([key, value]) => [key, value.toString()]))).toEqual({
      authorized_trustlines: '700',
      maintain_liabilities_trustlines: '100',
      unauthorized_trustlines: '25',
      claimable_balances: '50',
      liquidity_pools: '75',
      contract_balances: '50',
    })
    expect(observation).toMatchObject({
      ledgerSequence: 500,
      ledgerClosedAt: '2026-08-10T11:59:55.000Z',
      sourceTimestamp: '2026-08-10T11:59:55.000Z',
      retrievedAt: NOW.toISOString(),
      methodologyVersion: 'onchain-asset-supply-v0.1',
      connectorVersion: 'horizon-supply-v0.1',
      derivationFamily: 'horizon_asset_aggregate',
      source: SOURCE,
      network: NETWORK,
      issuerObservedAtLedger: 499,
      pageMetadata: { pagesScanned: 1, recordsScanned: 1, ledgerRestarts: 0, resumedFromCheckpoint: false },
    })
    expect(observation.requestProvenance.map(({ kind, latestLedger }) => [kind, latestLedger])).toEqual([
      ['root', null],
      ['issuer', 499],
      ['asset_page', 500],
      ['ledger', 500],
    ])
    expect(observation.requestProvenance.every(({ payloadSha256 }) => /^[0-9a-f]{64}$/.test(payloadSha256 ?? ''))).toBe(true)
    expect(observation).not.toHaveProperty('issuerHomeDomain')
    expect(fetchImpl).toHaveBeenCalledTimes(4)

    // This fixture oracle is deliberately independent of the connector's summation helper.
    const fixtureTotalStroops = ['700.0000000', '100.0000000', '25.0000000', '50.0000000', '75.0000000', '50.0000000']
      .map((amount) => BigInt(amount.replace('.', '')))
      .reduce((sum, amount) => sum + amount, 0n)
    expect(observation.amount.toStroops()).toBe(fixtureTotalStroops)
  })

  it('records request start and body-completion timestamps separately', async () => {
    let clockCalls = 0
    const result = await fetchHorizonOnchainAssetSupply({
      source: SOURCE,
      asset: ASSET,
      expectedNetwork: NETWORK,
      fetchImpl: baseFetch(),
      clock: () => new Date(NOW.getTime() + clockCalls++ * 1_000),
    })

    expect(result.observation?.requestProvenance.map(({ startedAt, completedAt }) => [startedAt, completedAt])).toEqual([
      ['2026-08-10T12:00:01.000Z', '2026-08-10T12:00:02.000Z'],
      ['2026-08-10T12:00:03.000Z', '2026-08-10T12:00:04.000Z'],
      ['2026-08-10T12:00:05.000Z', '2026-08-10T12:00:06.000Z'],
      ['2026-08-10T12:00:07.000Z', '2026-08-10T12:00:08.000Z'],
    ])
    expect(result.observation?.retrievedAt).toBe('2026-08-10T12:00:08.000Z')
  })

  it('resumes after a failed page without repeating completed requests', async () => {
    const pageTwo = `${ROOT}/assets?asset_code=USDC&asset_issuer=${ISSUER}&order=asc&limit=1&cursor=next`
    let pageTwoAttempts = 0
    const firstFetch = vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === `${ROOT}/`) return json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
      if (target === `${ROOT}/accounts/${ISSUER}`) return json({ account_id: ISSUER }, 499)
      if (target.includes('/assets?') && !target.includes('cursor=')) return json(assetPage([ASSET_RECORD], pageTwo), 500)
      if (target === pageTwo) {
        pageTwoAttempts += 1
        return new Response('temporarily unavailable', { status: 503 })
      }
      throw new Error(`Unexpected request: ${target}`)
    })
    const interrupted = await collect(firstFetch, { pageSize: 1 })

    expect(interrupted.error).toMatchObject({ code: 'non_200_response', status: 503 })
    expect(interrupted.error?.checkpoint).toMatchObject({ pagesScanned: 1, recordsScanned: 1, nextUrl: pageTwo })

    const resumeFetch = vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === pageTwo) return json(assetPage([]), 500)
      if (target === `${ROOT}/ledgers/500`) return json({ sequence: 500, closed_at: '2026-08-10T11:59:55Z' })
      throw new Error(`Resume repeated completed request: ${target}`)
    })
    const resumed = await collect(resumeFetch, { pageSize: 1, checkpoint: interrupted.error?.checkpoint })

    expect(pageTwoAttempts).toBe(1)
    expect(resumed.observation).toMatchObject({
      ledgerSequence: 500,
      pageMetadata: { pagesScanned: 2, recordsScanned: 1, resumedFromCheckpoint: true },
    })
    expect(resumeFetch).toHaveBeenCalledTimes(2)
  })

  it('restarts from the beginning after a ledger change in the middle of pagination', async () => {
    const pageTwo = `${ROOT}/assets?asset_code=USDC&asset_issuer=${ISSUER}&order=asc&limit=1&cursor=next`
    const fetchImpl = baseFetch()
    let pageOneCalls = 0
    fetchImpl.mockImplementation(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === `${ROOT}/`) return json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
      if (target === `${ROOT}/accounts/${ISSUER}`) return json({ account_id: ISSUER }, 499)
      if (target.includes('/assets?') && !target.includes('cursor=')) {
        pageOneCalls += 1
        return json(assetPage([ASSET_RECORD], pageTwo), pageOneCalls === 1 ? 500 : 501)
      }
      if (target === pageTwo) return json(assetPage([]), 501)
      if (target === `${ROOT}/ledgers/501`) return json({ sequence: 501, closed_at: '2026-08-10T12:00:00Z' })
      throw new Error(`Unexpected request: ${target}`)
    })

    const result = await collect(fetchImpl, { pageSize: 1 })
    expect(result.observation).toMatchObject({
      ledgerSequence: 501,
      pageMetadata: { ledgerRestarts: 1, resumedFromCheckpoint: false },
    })
    expect(pageOneCalls).toBe(2)
  })

  it('bounds ledger-change restarts and never exposes the unsafe checkpoint', async () => {
    const pageTwo = `${ROOT}/assets?asset_code=USDC&asset_issuer=${ISSUER}&order=asc&limit=1&cursor=next`
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === `${ROOT}/`) return json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
      if (target === `${ROOT}/accounts/${ISSUER}`) return json({ account_id: ISSUER }, 499)
      if (target.includes('/assets?') && !target.includes('cursor=')) return json(assetPage([ASSET_RECORD], pageTwo), 500)
      if (target === pageTwo) return json(assetPage([]), 501)
      throw new Error(`Unexpected request: ${target}`)
    })

    const result = await collect(fetchImpl, { pageSize: 1, maxLedgerRestarts: 1 })
    expect(result.error).toMatchObject({ code: 'ledger_changed', restartRequired: true })
    expect(result.error?.checkpoint).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(8)
  })

  it('rejects duplicate asset records across pages', async () => {
    const pageTwo = `${ROOT}/assets?asset_code=USDC&asset_issuer=${ISSUER}&order=asc&limit=1&cursor=next`
    const fetchImpl = baseFetch()
    fetchImpl.mockImplementation(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === `${ROOT}/`) return json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
      if (target === `${ROOT}/accounts/${ISSUER}`) return json({ account_id: ISSUER }, 499)
      if (target.includes('/assets?') && !target.includes('cursor=')) return json(assetPage([ASSET_RECORD], pageTwo), 500)
      if (target === pageTwo) return json(assetPage([ASSET_RECORD]), 500)
      throw new Error(`Unexpected request: ${target}`)
    })

    const result = await collect(fetchImpl, { pageSize: 1 })
    expect(result.error).toMatchObject({ code: 'duplicate_record', restartRequired: true })
  })

  it('returns a resumable partial scan when a page bound is reached', async () => {
    const pageTwo = `${ROOT}/assets?asset_code=USDC&asset_issuer=${ISSUER}&order=asc&limit=1&cursor=next`
    const result = await collect(baseFetch(() => json(assetPage([ASSET_RECORD], pageTwo), 500)), {
      pageSize: 1,
      maxPages: 1,
    })

    expect(result.error).toMatchObject({
      code: 'partial_scan',
      checkpoint: { pagesScanned: 1, recordsScanned: 1, nextUrl: pageTwo },
    })
  })

  it('keeps the last safe checkpoint when a record bound is reached', async () => {
    const secondRecord = { ...ASSET_RECORD, paging_token: 'second' }
    const result = await collect(baseFetch(() => json(assetPage([ASSET_RECORD, secondRecord]), 500)), {
      maxRecords: 1,
    })

    expect(result.error).toMatchObject({
      code: 'partial_scan',
      checkpoint: { pagesScanned: 0, recordsScanned: 0, record: null },
    })
  })

  it('returns structured failures for unsupported assets and missing issuers', async () => {
    const noFetch = vi.fn()
    const invalid = await fetchHorizonOnchainAssetSupply({
      source: SOURCE,
      asset: { kind: 'native' },
      expectedNetwork: NETWORK,
      fetchImpl: noFetch,
      clock: () => new Date(NOW),
    })
    expect(invalid.error).toMatchObject({ code: 'invalid_asset' })
    expect(noFetch).not.toHaveBeenCalled()

    const malformedCredit = await fetchHorizonOnchainAssetSupply({
      source: SOURCE,
      asset: { kind: 'credit', code: 'lowercase', issuer: 'not-an-account' },
      expectedNetwork: NETWORK,
      fetchImpl: noFetch,
      clock: () => new Date(NOW),
    })
    expect(malformedCredit.error).toMatchObject({ code: 'invalid_asset' })
    expect(noFetch).not.toHaveBeenCalled()

    const missingIssuerFetch = vi.fn(async (url: string | URL | Request) =>
      String(url) === `${ROOT}/`
        ? json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
        : new Response('not found', { status: 404 }),
    )
    const missing = await collect(missingIssuerFetch)
    expect(missing.error).toMatchObject({ code: 'issuer_not_found', status: 404 })
  })

  it('preserves rate-limit retry metadata even when the error body is not JSON', async () => {
    const fetchImpl = baseFetch(() => new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } }))
    const result = await collect(fetchImpl)

    expect(result.error).toMatchObject({ code: 'non_200_response', status: 429, retryAfterMs: 2_000 })
    expect(result.error?.checkpoint).toBeDefined()
  })

  it('resumes a failure on the initial asset page without repeating discovery', async () => {
    const interrupted = await collect(baseFetch(() => new Response('busy', { status: 503 })))
    const resumeFetch = vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target.startsWith(`${ROOT}/assets?`)) return json(assetPage([ASSET_RECORD]), 500)
      if (target === `${ROOT}/ledgers/500`) return json({ sequence: 500, closed_at: '2026-08-10T11:59:55Z' })
      throw new Error(`Resume repeated discovery request: ${target}`)
    })

    const resumed = await collect(resumeFetch, { checkpoint: interrupted.error?.checkpoint })
    expect(resumed.observation).toMatchObject({
      amount: expect.anything(),
      pageMetadata: { resumedFromCheckpoint: true },
    })
    expect(resumeFetch).toHaveBeenCalledTimes(2)
  })

  it('returns structured failures for absent assets and network mismatches', async () => {
    const absent = await collect(baseFetch(() => json(assetPage([]), 500)))
    expect(absent.error).toMatchObject({ code: 'asset_not_found' })

    const mismatch = await collect(vi.fn(async () => json({ network_passphrase: 'Test SDF Network ; September 2015' })))
    expect(mismatch.error).toMatchObject({ code: 'network_mismatch' })
  })

  it('rejects missing ledger headers and negative component amounts', async () => {
    const missingHeader = await collect(baseFetch(() => json(assetPage([ASSET_RECORD]))))
    expect(missingHeader.error).toMatchObject({ code: 'malformed_payload' })

    const negative = {
      ...ASSET_RECORD,
      balances: { ...(ASSET_RECORD.balances as Record<string, unknown>), authorized: '-1.0000000' },
    }
    const malformedAmount = await collect(baseFetch(() => json(assetPage([negative]), 500)))
    expect(malformedAmount.error).toMatchObject({ code: 'malformed_payload' })
  })

  it('enforces response-size and timeout budgets', async () => {
    const oversized = await collect(
      vi.fn(async () => json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })),
      { maxResponseBytes: 16 },
    )
    expect(oversized.error).toMatchObject({ code: 'response_too_large' })

    vi.useFakeTimers()
    const hangingFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const pending = collect(hangingFetch, { timeoutMs: 25 })
    await vi.advanceTimersByTimeAsync(25)
    expect((await pending).error).toMatchObject({ code: 'request_aborted' })
  })

  it('rejects malformed or incomplete asset records', async () => {
    const malformed = structuredClone(ASSET_RECORD)
    delete malformed.contracts_amount
    const result = await collect(baseFetch(() => json(assetPage([malformed]), 500)))

    expect(result.error).toMatchObject({ code: 'malformed_payload' })
  })

  it('rejects an asset record whose Horizon type disagrees with its code length', async () => {
    const malformed = { ...ASSET_RECORD, asset_type: 'credit_alphanum12' }
    const result = await collect(baseFetch(() => json(assetPage([malformed]), 500)))

    expect(result.error).toMatchObject({ code: 'malformed_payload' })
  })

  it('revalidates resumed next-page URLs before making a request', async () => {
    const first = await collect(baseFetch(() => new Response('busy', { status: 503 })))
    const checkpoint = structuredClone(first.error?.checkpoint) as HorizonSupplyCheckpoint
    checkpoint.nextUrl = `https://attacker.example/assets?asset_code=USDC&asset_issuer=${ISSUER}`
    const noFetch = vi.fn()
    const resumed = await collect(noFetch, { checkpoint })

    expect(resumed.error).toMatchObject({ code: 'invalid_configuration' })
    expect(noFetch).not.toHaveBeenCalled()
  })

  it('rejects internally inconsistent checkpoints before trusting retained amounts', async () => {
    const first = await collect(baseFetch(() => new Response('busy', { status: 503 })))
    const checkpoint = structuredClone(first.error?.checkpoint) as HorizonSupplyCheckpoint
    checkpoint.nextUrl = null
    checkpoint.ledgerSequence = 500
    checkpoint.record = {
      pagingToken: String(ASSET_RECORD.paging_token),
      components: {
        authorized_trustlines: '700.0000000',
        maintain_liabilities_trustlines: '100.0000000',
        unauthorized_trustlines: '25.0000000',
        claimable_balances: '50.0000000',
        liquidity_pools: '75.0000000',
        contract_balances: '50.0000000',
      },
      rawRecord: ASSET_RECORD,
    }
    const noFetch = vi.fn()
    const result = await collect(noFetch, { checkpoint })

    expect(result.error).toMatchObject({ code: 'invalid_configuration' })
    expect(noFetch).not.toHaveBeenCalled()
  })

  it('requires the shared Horizon source identity and matching network', async () => {
    const noFetch = vi.fn()
    const result = await fetchHorizonOnchainAssetSupply({
      source: { ...SOURCE, adapter: 'archive' },
      asset: ASSET,
      expectedNetwork: NETWORK,
      fetchImpl: noFetch,
      clock: () => new Date(NOW),
    })

    expect(result.error).toMatchObject({ code: 'invalid_configuration' })
    expect(noFetch).not.toHaveBeenCalled()
  })
})
