import { z } from 'zod'
import {
  DEPTH_METHODOLOGY_VERSION,
  depthMethodologyConfig,
} from '../../config/methodology'
import {
  identifierSchema,
  networkIdentitySchema,
  orderBookDepthObservationSchema,
  sourceIdentitySchema,
  type NetworkIdentity,
  type RawObservation,
  type SourceIdentity,
  type TradingPair,
} from '../contracts/domain'
import { computeEvidenceSha256 } from '../evidence/json'
import { StellarAmount, parseStellarAmount } from './amount'
import {
  DEFAULT_HORIZON_MAX_RESPONSE_BYTES,
  DEFAULT_HORIZON_TIMEOUT_MS,
  HorizonResponseTooLargeError,
  assertHorizonEndpointAllowed,
  parseRetryAfter,
  readBoundedHorizonJson,
  type HorizonEndpointPolicy,
} from './horizon'
import { StellarPrice, canonicalizeTradingPair } from './price'

export const HORIZON_DEPTH_CONNECTOR_VERSION = 'horizon-depth-v0.1' as const
export const HORIZON_DEPTH_DERIVATION_FAMILY = 'horizon_sdex_offers' as const
export const DEFAULT_DEPTH_PAGE_SIZE = 200
export const DEFAULT_DEPTH_MAX_PAGES = 100
export const DEFAULT_DEPTH_MAX_RECORDS = 10_000
export const DEFAULT_DEPTH_MAX_LEDGER_RESTARTS = 1

const amountSchema = z.string().regex(/^(0|[1-9]\d*)\.\d{7}$/)
const priceSchema = z.string().regex(/^(0|[1-9]\d*)\.\d{7}$/)
const horizonAssetSchema = z.discriminatedUnion('asset_type', [
  z.object({ asset_type: z.literal('native') }).passthrough(),
  z.object({
    asset_type: z.enum(['credit_alphanum4', 'credit_alphanum12']),
    asset_code: z.string(),
    asset_issuer: z.string(),
  }).passthrough(),
])
const offerSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  paging_token: z.union([z.string(), z.number()]).transform(String),
  selling: horizonAssetSchema,
  buying: horizonAssetSchema,
  amount: amountSchema,
  price_r: z.object({
    n: z.number().int().safe().positive().max(2_147_483_647),
    d: z.number().int().safe().positive().max(2_147_483_647),
  }).strict(),
  price: priceSchema,
  last_modified_ledger: z.number().int().safe().positive().optional(),
  last_modified_time: z.string().datetime({ offset: true }).optional(),
}).passthrough()
const offerPageSchema = z.object({
  _links: z.object({ next: z.object({ href: z.string().url() }).passthrough().optional() }).passthrough(),
  _embedded: z.object({ records: z.array(offerSchema) }).passthrough(),
}).passthrough()
const rootSchema = z.object({ network_passphrase: z.string().trim().min(1) }).passthrough()
const ledgerSchema = z.object({
  sequence: z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().safe().positive()]),
  closed_at: z.string().datetime({ offset: true }),
}).passthrough()

type DepthSide = 'bid' | 'ask'

export interface HorizonDepthRequestProvenance {
  kind: 'root' | 'offer_page' | 'ledger'
  side: DepthSide | null
  url: string
  status: number
  startedAt: string
  completedAt: string
  latestLedger: number | null
  payloadSha256: string | null
}

export interface HorizonDepthLevel {
  side: DepthSide
  offerId: string
  pagingToken: string
  price: StellarPrice
  baseAmount: StellarAmount
  counterAmount: StellarAmount
  lastModifiedLedger: number | null
  lastModifiedAt: string | null
}

export interface HorizonDepthBucket {
  side: DepthSide
  priceBandBasisPoints: number
  amount: StellarAmount
  offerCount: number
}

export interface HorizonDepthObservation {
  source: SourceIdentity
  pair: TradingPair
  pairKey: string
  requestedPairReversed: boolean
  network: NetworkIdentity
  bookStatus: 'complete' | 'empty' | 'one_sided'
  bestBid: StellarPrice | null
  bestAsk: StellarPrice | null
  midpoint: StellarPrice | null
  levels: { bids: HorizonDepthLevel[]; asks: HorizonDepthLevel[] }
  buckets: HorizonDepthBucket[]
  ledgerSequence: number
  ledgerClosedAt: string
  sourceTimestamp: string
  retrievedAt: string
  methodologyVersion: typeof DEPTH_METHODOLOGY_VERSION
  connectorVersion: typeof HORIZON_DEPTH_CONNECTOR_VERSION
  derivationFamily: typeof HORIZON_DEPTH_DERIVATION_FAMILY
  liquidityPoolsIncluded: false
  scanMetadata: {
    pagesScanned: number
    recordsScanned: number
    bidPagesScanned: number
    askPagesScanned: number
    ledgerRestarts: number
  }
  requestProvenance: HorizonDepthRequestProvenance[]
  evidenceSha256: string
  rawPayload: { bids: Record<string, unknown>[]; asks: Record<string, unknown>[] }
}

export type HorizonDepthErrorCode =
  | 'invalid_pair'
  | 'invalid_configuration'
  | 'request_failed'
  | 'request_aborted'
  | 'non_200_response'
  | 'redirect_rejected'
  | 'response_too_large'
  | 'malformed_payload'
  | 'network_mismatch'
  | 'partial_scan'
  | 'ledger_changed'
  | 'duplicate_record'
  | 'crossed_book'
  | 'stale_book'

export interface HorizonDepthError {
  sourceId: string | null
  sourceUrl: string | null
  code: HorizonDepthErrorCode
  message: string
  retrievedAt: string
  status?: number
  retryAfterMs?: number
  restartRequired?: boolean
}

export type HorizonDepthResult =
  | { observation: HorizonDepthObservation; error?: never }
  | { observation?: never; error: HorizonDepthError }

export interface HorizonDepthFetchOptions {
  source: SourceIdentity | unknown
  pair: TradingPair | unknown
  expectedNetwork: NetworkIdentity | unknown
  fetchImpl?: typeof fetch
  clock?: () => Date
  signal?: AbortSignal
  endpointPolicy?: HorizonEndpointPolicy
  timeoutMs?: number
  maxResponseBytes?: number
  pageSize?: number
  maxPages?: number
  maxRecords?: number
  maxLedgerRestarts?: number
}

interface RequestSuccess {
  response: Response
  payload: unknown
  provenance: HorizonDepthRequestProvenance
}

interface RequestFailure {
  code: Extract<HorizonDepthErrorCode,
    'request_failed' | 'request_aborted' | 'non_200_response' | 'redirect_rejected' | 'response_too_large' | 'malformed_payload'>
  message: string
  retrievedAt: string
  status?: number
  retryAfterMs?: number
}

function nowIso(clock: () => Date) {
  const value = clock()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('clock must return a valid Date')
  return value.toISOString()
}

function depthError(
  source: Pick<SourceIdentity, 'id' | 'url'> | null,
  code: HorizonDepthErrorCode,
  message: string,
  retrievedAt: string,
  extras: Omit<Partial<HorizonDepthError>, 'sourceId' | 'sourceUrl' | 'code' | 'message' | 'retrievedAt'> = {},
): HorizonDepthResult {
  return {
    error: {
      sourceId: source?.id ?? null,
      sourceUrl: source?.url ?? null,
      code,
      message,
      retrievedAt,
      ...extras,
    },
  }
}

function parseLatestLedger(value: string | null) {
  if (!value || !/^[1-9]\d*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

async function requestJson({
  url,
  kind,
  side,
  fetchImpl,
  signal,
  timeoutMs,
  maxResponseBytes,
  clock,
}: {
  url: string
  kind: HorizonDepthRequestProvenance['kind']
  side: DepthSide | null
  fetchImpl: typeof fetch
  signal?: AbortSignal
  timeoutMs: number
  maxResponseBytes: number
  clock: () => Date
}): Promise<RequestSuccess | { failure: RequestFailure }> {
  const startedAt = nowIso(clock)
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal
  try {
    let response: Response
    try {
      response = await fetchImpl(url, { signal: combinedSignal, redirect: 'manual' })
    } catch (error) {
      const retrievedAt = nowIso(clock)
      const aborted = combinedSignal.aborted || (error instanceof Error && error.name === 'AbortError')
      return { failure: {
        code: aborted ? 'request_aborted' : 'request_failed',
        message: aborted ? 'Horizon request was aborted or timed out' : 'Horizon request failed',
        retrievedAt,
      } }
    }
    if (response.status >= 300 && response.status < 400) {
      const completedAt = nowIso(clock)
      return { failure: { code: 'redirect_rejected', message: 'Horizon redirects are not followed', retrievedAt: completedAt, status: response.status } }
    }
    if (!response.ok) {
      const completedAt = nowIso(clock)
      return { failure: {
        code: 'non_200_response',
        message: `Horizon returned HTTP ${response.status}`,
        retrievedAt: completedAt,
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), completedAt),
      } }
    }
    try {
      const payload = await readBoundedHorizonJson(response, maxResponseBytes)
      const completedAt = nowIso(clock)
      return {
        response,
        payload,
        provenance: {
          kind,
          side,
          url,
          status: response.status,
          startedAt,
          completedAt,
          latestLedger: parseLatestLedger(response.headers.get('Latest-Ledger')),
          payloadSha256: computeEvidenceSha256(payload),
        },
      }
    } catch (error) {
      const completedAt = nowIso(clock)
      return { failure: {
        code: error instanceof HorizonResponseTooLargeError ? 'response_too_large' : 'malformed_payload',
        message: error instanceof HorizonResponseTooLargeError ? error.message : 'Horizon returned malformed JSON',
        retrievedAt: completedAt,
      } }
    }
  } finally {
    clearTimeout(timeout)
  }
}

function normalizedRoot(source: SourceIdentity, endpointPolicy: HorizonEndpointPolicy) {
  const url = new URL(source.url)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Horizon URL must use HTTP or HTTPS')
  assertHorizonEndpointAllowed(url, endpointPolicy)
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function assetType(asset: TradingPair['base']) {
  if (asset.kind === 'native') return 'native'
  return asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'
}

function addAssetQuery(url: URL, prefix: 'selling' | 'buying', asset: TradingPair['base']) {
  url.searchParams.set(`${prefix}_asset_type`, assetType(asset))
  if (asset.kind === 'credit') {
    url.searchParams.set(`${prefix}_asset_code`, asset.code)
    url.searchParams.set(`${prefix}_asset_issuer`, asset.issuer)
  }
}

function initialOffersUrl(root: string, pair: TradingPair, side: DepthSide, pageSize: number) {
  const url = new URL(`${root}/offers`)
  const selling = side === 'ask' ? pair.base : pair.counter
  const buying = side === 'ask' ? pair.counter : pair.base
  addAssetQuery(url, 'selling', selling)
  addAssetQuery(url, 'buying', buying)
  url.searchParams.set('order', 'asc')
  url.searchParams.set('limit', String(pageSize))
  return url
}

function assertNextPageAllowed(nextHref: string, initial: URL, endpointPolicy: HorizonEndpointPolicy) {
  const next = new URL(nextHref)
  assertHorizonEndpointAllowed(next, endpointPolicy)
  if (next.origin !== initial.origin || next.pathname !== initial.pathname || next.hash) {
    throw new Error('next page must retain the exact Horizon origin and offers path')
  }
  const allowedKeys = new Set([...initial.searchParams.keys(), 'cursor'])
  for (const key of next.searchParams.keys()) {
    if (!allowedKeys.has(key)) throw new Error('next page introduced an unexpected query parameter')
  }
  for (const [key, value] of initial.searchParams) {
    if (next.searchParams.getAll(key).length !== 1 || next.searchParams.get(key) !== value) {
      throw new Error('next page changed the requested pair or scan bounds')
    }
  }
  if (next.searchParams.getAll('cursor').length !== 1 || !next.searchParams.get('cursor')) {
    throw new Error('next page must contain exactly one non-empty cursor')
  }
  return next
}

function horizonAssetMatches(value: z.infer<typeof horizonAssetSchema>, expected: TradingPair['base']) {
  if (expected.kind === 'native') return value.asset_type === 'native'
  return value.asset_type === assetType(expected) && value.asset_code === expected.code && value.asset_issuer === expected.issuer
}

function parseLevel(record: z.infer<typeof offerSchema>, side: DepthSide, pair: TradingPair): HorizonDepthLevel {
  const expectedSelling = side === 'ask' ? pair.base : pair.counter
  const expectedBuying = side === 'ask' ? pair.counter : pair.base
  if (!horizonAssetMatches(record.selling, expectedSelling) || !horizonAssetMatches(record.buying, expectedBuying)) {
    throw new Error('offer assets do not match the requested pair and side')
  }
  const sellingAmount = parseStellarAmount(record.amount)
  if (sellingAmount.isZero()) throw new Error('offer amount must be positive')
  const rawPrice = StellarPrice.fromHorizon(record.price_r.n, record.price_r.d)
  if (rawPrice.format(7) !== record.price) throw new Error('offer decimal price does not match price_r')
  const price = side === 'ask' ? rawPrice : rawPrice.invert()
  const baseAmount = side === 'ask' ? sellingAmount : rawPrice.multiplyAmountFloor(sellingAmount)
  const counterAmount = side === 'ask' ? rawPrice.multiplyAmountFloor(sellingAmount) : sellingAmount
  return {
    side,
    offerId: record.id,
    pagingToken: record.paging_token,
    price,
    baseAmount,
    counterAmount,
    lastModifiedLedger: record.last_modified_ledger ?? null,
    lastModifiedAt: record.last_modified_time ? new Date(record.last_modified_time).toISOString() : null,
  }
}

interface ScanResult {
  levels: HorizonDepthLevel[]
  raw: Record<string, unknown>[]
  pagesScanned: number
  ledgerSequence: number
  provenance: HorizonDepthRequestProvenance[]
}

async function scanSide({
  root,
  pair,
  side,
  options,
  expectedLedger,
}: {
  root: string
  pair: TradingPair
  side: DepthSide
  options: Required<Pick<HorizonDepthFetchOptions, 'fetchImpl' | 'clock' | 'endpointPolicy' | 'timeoutMs' | 'maxResponseBytes' | 'pageSize' | 'maxPages' | 'maxRecords'>> & Pick<HorizonDepthFetchOptions, 'signal'>
  expectedLedger: number | null
}): Promise<ScanResult | { failure: RequestFailure | { code: HorizonDepthErrorCode; message: string; retrievedAt: string; restartRequired?: boolean } }> {
  const initial = initialOffersUrl(root, pair, side, options.pageSize)
  let next: URL | null = initial
  let ledgerSequence = expectedLedger
  let pagesScanned = 0
  const levels: HorizonDepthLevel[] = []
  const raw: Record<string, unknown>[] = []
  const provenance: HorizonDepthRequestProvenance[] = []
  const seenUrls = new Set<string>()
  const seenTokens = new Set<string>()

  while (next) {
    const retrievedAt = nowIso(options.clock)
    if (pagesScanned >= options.maxPages) {
      return { failure: { code: 'partial_scan', message: 'offer scan exceeded its page budget', retrievedAt } }
    }
    if (seenUrls.has(next.toString())) {
      return { failure: { code: 'duplicate_record', message: 'offer pagination repeated a page URL', retrievedAt, restartRequired: true } }
    }
    seenUrls.add(next.toString())
    const result = await requestJson({
      url: next.toString(), kind: 'offer_page', side,
      fetchImpl: options.fetchImpl, signal: options.signal, timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes, clock: options.clock,
    })
    if ('failure' in result) return result
    provenance.push(result.provenance)
    const pageLedger = result.provenance.latestLedger
    if (!pageLedger) {
      return { failure: { code: 'malformed_payload', message: 'offer page omitted a valid Latest-Ledger header', retrievedAt: result.provenance.completedAt } }
    }
    if (ledgerSequence !== null && ledgerSequence !== pageLedger) {
      return { failure: { code: 'ledger_changed', message: 'offer pages crossed a ledger boundary', retrievedAt: result.provenance.completedAt, restartRequired: true } }
    }
    ledgerSequence = pageLedger
    let page: z.infer<typeof offerPageSchema>
    try {
      page = offerPageSchema.parse(result.payload)
    } catch {
      return { failure: { code: 'malformed_payload', message: 'Horizon returned an invalid offers page', retrievedAt: result.provenance.completedAt } }
    }
    if (levels.length + page._embedded.records.length > options.maxRecords) {
      return { failure: { code: 'partial_scan', message: 'offer scan exceeded its record budget', retrievedAt: result.provenance.completedAt } }
    }
    for (const record of page._embedded.records) {
      if (seenTokens.has(record.paging_token)) {
        return { failure: { code: 'duplicate_record', message: 'offer pagination repeated a paging token', retrievedAt: result.provenance.completedAt, restartRequired: true } }
      }
      seenTokens.add(record.paging_token)
      try {
        levels.push(parseLevel(record, side, pair))
      } catch (error) {
        return { failure: { code: 'malformed_payload', message: error instanceof Error ? error.message : 'invalid offer', retrievedAt: result.provenance.completedAt } }
      }
      raw.push(record as unknown as Record<string, unknown>)
    }
    pagesScanned += 1
    const nextHref = page._links.next?.href
    if (!nextHref || page._embedded.records.length === 0) {
      next = null
    } else {
      try {
        next = assertNextPageAllowed(nextHref, initial, options.endpointPolicy)
      } catch (error) {
        return { failure: { code: 'malformed_payload', message: error instanceof Error ? error.message : 'invalid next page', retrievedAt: result.provenance.completedAt } }
      }
    }
  }
  return { levels, raw, pagesScanned, ledgerSequence: ledgerSequence!, provenance }
}

function aggregateBuckets(bids: HorizonDepthLevel[], asks: HorizonDepthLevel[], midpoint: StellarPrice) {
  return depthMethodologyConfig.priceBandsBasisPoints.flatMap((priceBandBasisPoints) => {
    const make = (side: DepthSide, levels: HorizonDepthLevel[]) => {
      const included = levels.filter((level) => side === 'bid'
        ? level.price.withinBidBand(midpoint, priceBandBasisPoints)
        : level.price.withinAskBand(midpoint, priceBandBasisPoints))
      return {
        side,
        priceBandBasisPoints,
        amount: included.reduce((sum, level) => sum.add(level.baseAmount), StellarAmount.fromStroops(0n)),
        offerCount: included.length,
      }
    }
    return [make('bid', bids), make('ask', asks)]
  })
}

export async function fetchHorizonOrderBookDepth(options: HorizonDepthFetchOptions): Promise<HorizonDepthResult> {
  const clock = options.clock ?? (() => new Date())
  let source: SourceIdentity
  try {
    source = sourceIdentitySchema.parse(options.source)
  } catch {
    return depthError(null, 'invalid_configuration', 'depth source identity is invalid', nowIso(clock))
  }
  let pairResult: ReturnType<typeof canonicalizeTradingPair>
  let expectedNetwork: NetworkIdentity
  try {
    pairResult = canonicalizeTradingPair(options.pair)
  } catch {
    return depthError(source, 'invalid_pair', 'depth pair is invalid', nowIso(clock))
  }
  try {
    expectedNetwork = networkIdentitySchema.parse(options.expectedNetwork)
  } catch {
    return depthError(source, 'invalid_configuration', 'depth network identity is invalid', nowIso(clock))
  }
  if (source.adapter !== 'sdex' || source.sourceClass !== 'dex') {
    return depthError(source, 'invalid_configuration', 'depth source must use the dex class and sdex adapter', nowIso(clock))
  }
  if (source.network.id !== expectedNetwork.id || source.network.passphrase !== expectedNetwork.passphrase) {
    return depthError(source, 'invalid_configuration', 'source network does not match the requested network', nowIso(clock))
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const endpointPolicy = options.endpointPolicy ?? {}
  const timeoutMs = options.timeoutMs ?? DEFAULT_HORIZON_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_HORIZON_MAX_RESPONSE_BYTES
  const pageSize = options.pageSize ?? DEFAULT_DEPTH_PAGE_SIZE
  const maxPages = options.maxPages ?? DEFAULT_DEPTH_MAX_PAGES
  const maxRecords = options.maxRecords ?? DEFAULT_DEPTH_MAX_RECORDS
  const maxLedgerRestarts = options.maxLedgerRestarts ?? DEFAULT_DEPTH_MAX_LEDGER_RESTARTS
  if (
    !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
    !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 ||
    !Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > 200 ||
    !Number.isSafeInteger(maxPages) || maxPages < 2 ||
    !Number.isSafeInteger(maxRecords) || maxRecords <= 0 ||
    !Number.isSafeInteger(maxLedgerRestarts) || maxLedgerRestarts < 0
  ) {
    return depthError(source, 'invalid_configuration', 'depth scan budgets are invalid', nowIso(clock))
  }
  let root: string
  try {
    root = normalizedRoot(source, endpointPolicy)
  } catch (error) {
    return depthError(source, 'invalid_configuration', error instanceof Error ? error.message : 'invalid Horizon URL', nowIso(clock))
  }

  const resolved = { fetchImpl, clock, endpointPolicy, timeoutMs, maxResponseBytes, pageSize, maxPages, maxRecords, signal: options.signal }
  for (let ledgerRestarts = 0; ledgerRestarts <= maxLedgerRestarts; ledgerRestarts += 1) {
    const rootResult = await requestJson({
      url: `${root}/`, kind: 'root', side: null, fetchImpl, signal: options.signal,
      timeoutMs, maxResponseBytes, clock,
    })
    if ('failure' in rootResult) return depthError(source, rootResult.failure.code, rootResult.failure.message, rootResult.failure.retrievedAt, rootResult.failure)
    let rootPayload: z.infer<typeof rootSchema>
    try {
      rootPayload = rootSchema.parse(rootResult.payload)
    } catch {
      return depthError(source, 'malformed_payload', 'Horizon root payload is invalid', rootResult.provenance.completedAt)
    }
    if (rootPayload.network_passphrase !== expectedNetwork.passphrase) {
      return depthError(source, 'network_mismatch', 'Horizon network passphrase does not match the requested network', rootResult.provenance.completedAt)
    }

    const asks = await scanSide({ root, pair: pairResult.pair, side: 'ask', options: resolved, expectedLedger: null })
    if ('failure' in asks) {
      if (asks.failure.code === 'ledger_changed' && ledgerRestarts < maxLedgerRestarts) continue
      return depthError(source, asks.failure.code, asks.failure.message, asks.failure.retrievedAt, asks.failure)
    }
    const remainingPages = maxPages - asks.pagesScanned
    const remainingRecords = maxRecords - asks.levels.length
    if (remainingPages < 1 || remainingRecords < 1) {
      return depthError(source, 'partial_scan', 'combined offer scan exhausted its configured budget', nowIso(clock))
    }
    const bids = await scanSide({
      root,
      pair: pairResult.pair,
      side: 'bid',
      options: { ...resolved, maxPages: remainingPages, maxRecords: remainingRecords },
      expectedLedger: asks.ledgerSequence,
    })
    if ('failure' in bids) {
      if (bids.failure.code === 'ledger_changed' && ledgerRestarts < maxLedgerRestarts) continue
      return depthError(source, bids.failure.code, bids.failure.message, bids.failure.retrievedAt, bids.failure)
    }
    if (asks.pagesScanned + bids.pagesScanned > maxPages || asks.levels.length + bids.levels.length > maxRecords) {
      return depthError(source, 'partial_scan', 'combined offer scan exceeded its configured budget', nowIso(clock))
    }

    const ledgerResult = await requestJson({
      url: `${root}/ledgers/${asks.ledgerSequence}`, kind: 'ledger', side: null, fetchImpl,
      signal: options.signal, timeoutMs, maxResponseBytes, clock,
    })
    if ('failure' in ledgerResult) return depthError(source, ledgerResult.failure.code, ledgerResult.failure.message, ledgerResult.failure.retrievedAt, ledgerResult.failure)
    let ledger: z.infer<typeof ledgerSchema>
    try {
      ledger = ledgerSchema.parse(ledgerResult.payload)
    } catch {
      return depthError(source, 'malformed_payload', 'Horizon ledger payload is invalid', ledgerResult.provenance.completedAt)
    }
    if (Number(ledger.sequence) !== asks.ledgerSequence) {
      return depthError(source, 'malformed_payload', 'ledger response does not match the offer ledger', ledgerResult.provenance.completedAt)
    }
    const ledgerClosedAt = new Date(ledger.closed_at).toISOString()
    const retrievedAt = ledgerResult.provenance.completedAt
    const everyLevel = [...asks.levels, ...bids.levels]
    if (everyLevel.some((level) => level.lastModifiedLedger !== null && level.lastModifiedLedger > asks.ledgerSequence)) {
      return depthError(source, 'malformed_payload', 'offer modification ledger exceeds the snapshot ledger', retrievedAt)
    }
    if (everyLevel.some((level) => level.lastModifiedAt !== null && Date.parse(level.lastModifiedAt) > Date.parse(ledgerClosedAt))) {
      return depthError(source, 'malformed_payload', 'offer modification time exceeds the snapshot close time', retrievedAt)
    }
    const ageMs = Date.parse(retrievedAt) - Date.parse(ledgerClosedAt)
    if (ageMs < 0) return depthError(source, 'malformed_payload', 'ledger close time is after retrieval time', retrievedAt)
    if (ageMs > depthMethodologyConfig.maximumObservationAgeSeconds * 1_000) {
      return depthError(source, 'stale_book', 'order book exceeds the methodology freshness bound', retrievedAt)
    }

    const sortedBids = [...bids.levels].sort((left, right) => right.price.compare(left.price))
    const sortedAsks = [...asks.levels].sort((left, right) => left.price.compare(right.price))
    const bestBid = sortedBids[0]?.price ?? null
    const bestAsk = sortedAsks[0]?.price ?? null
    if (bestBid && bestAsk && bestBid.compare(bestAsk) >= 0) {
      return depthError(source, 'crossed_book', 'best bid must be lower than best ask at one ledger boundary', retrievedAt)
    }
    const midpoint = bestBid && bestAsk ? bestBid.midpoint(bestAsk) : null
    const bookStatus = sortedBids.length === 0 && sortedAsks.length === 0
      ? 'empty'
      : !bestBid || !bestAsk ? 'one_sided' : 'complete'
    const buckets = midpoint ? aggregateBuckets(sortedBids, sortedAsks, midpoint) : []
    const requestProvenance = [rootResult.provenance, ...asks.provenance, ...bids.provenance, ledgerResult.provenance]
    const rawPayload = { bids: bids.raw, asks: asks.raw }
    const evidenceSha256 = computeEvidenceSha256({ rawPayload, requestProvenance })
    return { observation: {
      source,
      pair: pairResult.pair,
      pairKey: pairResult.key,
      requestedPairReversed: pairResult.reversed,
      network: expectedNetwork,
      bookStatus,
      bestBid,
      bestAsk,
      midpoint,
      levels: { bids: sortedBids, asks: sortedAsks },
      buckets,
      ledgerSequence: asks.ledgerSequence,
      ledgerClosedAt,
      sourceTimestamp: ledgerClosedAt,
      retrievedAt,
      methodologyVersion: DEPTH_METHODOLOGY_VERSION,
      connectorVersion: HORIZON_DEPTH_CONNECTOR_VERSION,
      derivationFamily: HORIZON_DEPTH_DERIVATION_FAMILY,
      liquidityPoolsIncluded: false,
      scanMetadata: {
        pagesScanned: asks.pagesScanned + bids.pagesScanned,
        recordsScanned: asks.levels.length + bids.levels.length,
        bidPagesScanned: bids.pagesScanned,
        askPagesScanned: asks.pagesScanned,
        ledgerRestarts,
      },
      requestProvenance,
      evidenceSha256,
      rawPayload,
    } }
  }
  return depthError(source, 'ledger_changed', 'offer scan could not remain on one ledger', nowIso(clock), { restartRequired: true })
}

export function toRawDepthObservations({
  observationIdPrefix,
  cycleId,
  observation,
}: {
  observationIdPrefix: string
  cycleId: string
  observation: HorizonDepthObservation
}): Extract<RawObservation, { metric: 'order_book_depth' }>[] {
  identifierSchema.parse(observationIdPrefix)
  identifierSchema.parse(cycleId)
  if (!observation.midpoint) return []
  return observation.buckets.map((bucket) => orderBookDepthObservationSchema.parse({
    observationId: `${observationIdPrefix}_${bucket.side}_${bucket.priceBandBasisPoints}`,
    cycleId,
    metric: 'order_book_depth',
    pair: observation.pair,
    side: bucket.side,
    priceBandBasisPoints: bucket.priceBandBasisPoints,
    amount: bucket.amount,
    referencePrice: {
      numerator: observation.midpoint!.numerator.toString(),
      denominator: observation.midpoint!.denominator.toString(),
    },
    ledgerSequence: observation.ledgerSequence,
    methodologyVersion: observation.methodologyVersion,
    provenance: {
      source: observation.source,
      sourceTimestamp: observation.sourceTimestamp,
      retrievedAt: observation.retrievedAt,
    },
    derivation: {
      family: observation.derivationFamily,
      connectorVersion: observation.connectorVersion,
      evidenceSha256: observation.evidenceSha256,
      checkpoint: {
        ledgerSequence: observation.ledgerSequence,
        pagesScanned: observation.scanMetadata.pagesScanned,
        recordsScanned: observation.scanMetadata.recordsScanned,
      },
    },
  }))
}
