import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  SUPPLY_COMPONENT_IDS,
  SUPPLY_METHODOLOGY_VERSION,
  type SupplyComponentId,
} from '../../config/methodology'
import {
  assetIdSchema,
  formatAssetId,
  networkIdentitySchema,
  sourceIdentitySchema,
  type AssetId,
  type NetworkIdentity,
  type SourceIdentity,
} from '../contracts/domain'
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

export const DEFAULT_SUPPLY_PAGE_SIZE = 200
export const DEFAULT_SUPPLY_MAX_PAGES = 100
export const DEFAULT_SUPPLY_MAX_RECORDS = 1_000
export const DEFAULT_SUPPLY_MAX_LEDGER_RESTARTS = 1
export const HORIZON_SUPPLY_CONNECTOR_VERSION = 'horizon-supply-v0.1' as const
export const HORIZON_SUPPLY_DERIVATION_FAMILY = 'horizon_asset_aggregate' as const

const amountStringSchema = z.string().regex(/^(0|[1-9]\d*)\.\d{7}$/, 'amount must use seven decimal places')
const rootSchema = z.object({ network_passphrase: z.string().trim().min(1) }).passthrough()
const issuerSchema = z.object({
  account_id: z.string(),
}).passthrough()
const assetRecordSchema = z.object({
  asset_type: z.enum(['credit_alphanum4', 'credit_alphanum12']),
  asset_code: z.string(),
  asset_issuer: z.string(),
  paging_token: z.union([z.string(), z.number()]).transform(String),
  balances: z.object({
    authorized: amountStringSchema,
    authorized_to_maintain_liabilities: amountStringSchema,
    unauthorized: amountStringSchema,
  }).passthrough(),
  claimable_balances_amount: amountStringSchema,
  liquidity_pools_amount: amountStringSchema,
  contracts_amount: amountStringSchema,
}).passthrough()
const assetPageSchema = z.object({
  _links: z.object({
    next: z.object({ href: z.string().url() }).passthrough().optional(),
  }).passthrough(),
  _embedded: z.object({ records: z.array(assetRecordSchema) }).passthrough(),
}).passthrough()
const ledgerSchema = z.object({
  sequence: z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().safe().positive()]),
  closed_at: z.string().datetime({ offset: true }),
}).passthrough()

const componentStringsSchema = z.object({
  authorized_trustlines: amountStringSchema,
  maintain_liabilities_trustlines: amountStringSchema,
  unauthorized_trustlines: amountStringSchema,
  claimable_balances: amountStringSchema,
  liquidity_pools: amountStringSchema,
  contract_balances: amountStringSchema,
}).strict()

const checkpointRecordSchema = z.object({
  pagingToken: z.string().min(1),
  components: componentStringsSchema,
  rawRecord: z.record(z.unknown()),
}).strict()

const requestProvenanceSchema = z.object({
  kind: z.enum(['root', 'issuer', 'asset_page', 'ledger']),
  url: z.string().url(),
  status: z.number().int().min(100).max(599),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  latestLedger: z.number().int().safe().positive().nullable(),
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
}).strict()

export type HorizonSupplySource = SourceIdentity

export interface HorizonSupplyRequestProvenance {
  kind: 'root' | 'issuer' | 'asset_page' | 'ledger'
  url: string
  status: number
  startedAt: string
  completedAt: string
  latestLedger: number | null
  payloadSha256: string | null
}

export interface HorizonSupplyCheckpoint {
  version: 1
  source: SourceIdentity
  asset: string
  expectedNetwork: NetworkIdentity
  nextUrl: string | null
  ledgerSequence: number | null
  pageSize: number
  pagesScanned: number
  recordsScanned: number
  lastRequestedCursor: string | null
  seenPageUrls: string[]
  seenPagingTokens: string[]
  record: {
    pagingToken: string
    components: Record<SupplyComponentId, string>
    rawRecord: Record<string, unknown>
  } | null
  issuerObservedAtLedger: number | null
  requestProvenance: HorizonSupplyRequestProvenance[]
}

const checkpointSchema: z.ZodType<HorizonSupplyCheckpoint> = z.object({
  version: z.literal(1),
  source: sourceIdentitySchema,
  asset: z.string().min(1),
  expectedNetwork: networkIdentitySchema,
  nextUrl: z.string().url().nullable(),
  ledgerSequence: z.number().int().safe().positive().nullable(),
  pageSize: z.number().int().min(1).max(200),
  pagesScanned: z.number().int().safe().nonnegative(),
  recordsScanned: z.number().int().safe().nonnegative(),
  lastRequestedCursor: z.string().nullable(),
  seenPageUrls: z.array(z.string().url()),
  seenPagingTokens: z.array(z.string().min(1)),
  record: checkpointRecordSchema.nullable(),
  issuerObservedAtLedger: z.number().int().safe().positive().nullable(),
  requestProvenance: z.array(requestProvenanceSchema),
}).strict()

export type HorizonSupplyErrorCode =
  | 'invalid_asset'
  | 'invalid_configuration'
  | 'request_failed'
  | 'request_aborted'
  | 'non_200_response'
  | 'redirect_rejected'
  | 'response_too_large'
  | 'malformed_payload'
  | 'network_mismatch'
  | 'issuer_not_found'
  | 'asset_not_found'
  | 'partial_scan'
  | 'ledger_changed'
  | 'duplicate_record'

export interface HorizonSupplyError {
  sourceId: string
  sourceUrl: string
  code: HorizonSupplyErrorCode
  message: string
  retrievedAt: string
  status?: number
  retryAfterMs?: number
  checkpoint?: HorizonSupplyCheckpoint
  restartRequired?: boolean
}

export interface HorizonSupplyObservation {
  source: SourceIdentity
  asset: Extract<AssetId, { kind: 'credit' }>
  network: NetworkIdentity
  amount: StellarAmount
  components: Record<SupplyComponentId, StellarAmount>
  ledgerSequence: number
  ledgerClosedAt: string
  sourceTimestamp: string
  retrievedAt: string
  methodologyVersion: typeof SUPPLY_METHODOLOGY_VERSION
  connectorVersion: typeof HORIZON_SUPPLY_CONNECTOR_VERSION
  derivationFamily: typeof HORIZON_SUPPLY_DERIVATION_FAMILY
  issuerObservedAtLedger: number | null
  pageMetadata: {
    pagesScanned: number
    recordsScanned: number
    firstPagingToken: string
    lastPagingToken: string
    terminalCursor: string
    checkpointVersion: 1
    ledgerRestarts: number
    resumedFromCheckpoint: boolean
  }
  requestProvenance: HorizonSupplyRequestProvenance[]
  rawPayload: {
    assetRecord: Record<string, unknown>
    componentAmounts: Record<SupplyComponentId, string>
  }
}

export type HorizonSupplyResult =
  | { observation: HorizonSupplyObservation; error?: never }
  | { observation?: never; error: HorizonSupplyError }

export interface HorizonSupplyFetchOptions {
  source: HorizonSupplySource
  asset: AssetId | unknown
  expectedNetwork: NetworkIdentity | unknown
  checkpoint?: HorizonSupplyCheckpoint | unknown
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

interface RequestResult {
  response: Response
  payload: unknown
  payloadSha256: string | null
  startedAt: string
  completedAt: string
}

function timestamp(clock: () => Date) {
  const value = clock()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('clock must return a valid Date')
  return value.toISOString()
}

function parsePositiveInteger(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON payload contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`
  }
  throw new Error(`JSON payload contains unsupported ${typeof value} value`)
}

function payloadSha256(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function supplyError(
  source: HorizonSupplySource,
  code: HorizonSupplyErrorCode,
  message: string,
  retrievedAt: string,
  extras: Omit<Partial<HorizonSupplyError>, 'sourceId' | 'sourceUrl' | 'code' | 'message' | 'retrievedAt'> = {},
): HorizonSupplyResult {
  return { error: { sourceId: source.id, sourceUrl: source.url, code, message, retrievedAt, ...extras } }
}

function baseUrl(source: HorizonSupplySource, endpointPolicy: HorizonEndpointPolicy) {
  const parsed = new URL(source.url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Horizon URL must use HTTP or HTTPS')
  assertHorizonEndpointAllowed(parsed, endpointPolicy)
  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/$/, '')
}

function endpoint(root: string, path: string) {
  return `${root}/${path.replace(/^\//, '')}`
}

async function requestJson({
  url,
  fetchImpl,
  signal,
  timeoutMs,
  maxResponseBytes,
  clock,
}: {
  url: string
  fetchImpl: typeof fetch
  signal?: AbortSignal
  timeoutMs: number
  maxResponseBytes: number
  clock: () => Date
}): Promise<RequestResult | { failure: HorizonSupplyErrorCode; message: string; startedAt: string; completedAt: string }> {
  const startedAt = timestamp(clock)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'error',
    })
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      const completedAt = timestamp(clock)
      return { failure: 'redirect_rejected', message: 'Horizon request redirected outside the configured endpoint', startedAt, completedAt }
    }
    if (!response.ok) {
      return { response, payload: null, payloadSha256: null, startedAt, completedAt: timestamp(clock) }
    }
    let payload: unknown
    let digest: string
    try {
      payload = await readBoundedHorizonJson(response, maxResponseBytes)
      digest = payloadSha256(payload)
    } catch (error) {
      if (signal?.aborted) throw error
      const completedAt = timestamp(clock)
      const aborted = error instanceof Error && error.name === 'AbortError'
      return {
        failure: aborted
          ? 'request_aborted'
          : error instanceof HorizonResponseTooLargeError
            ? 'response_too_large'
            : 'malformed_payload',
        message: aborted
          ? `Horizon request exceeded ${timeoutMs}ms`
          : error instanceof HorizonResponseTooLargeError
            ? `Horizon response exceeded ${maxResponseBytes} bytes`
            : 'Horizon response was not valid JSON',
        startedAt,
        completedAt,
      }
    }
    return { response, payload, payloadSha256: digest, startedAt, completedAt: timestamp(clock) }
  } catch (error) {
    if (signal?.aborted) throw error
    const completedAt = timestamp(clock)
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      failure: aborted ? 'request_aborted' : 'request_failed',
      message: aborted ? `Horizon request exceeded ${timeoutMs}ms` : 'Horizon request failed',
      startedAt,
      completedAt,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function componentStrings(record: z.infer<typeof assetRecordSchema>): Record<SupplyComponentId, string> {
  return {
    authorized_trustlines: record.balances.authorized,
    maintain_liabilities_trustlines: record.balances.authorized_to_maintain_liabilities,
    unauthorized_trustlines: record.balances.unauthorized,
    claimable_balances: record.claimable_balances_amount,
    liquidity_pools: record.liquidity_pools_amount,
    contract_balances: record.contracts_amount,
  }
}

function parseComponents(values: Record<SupplyComponentId, string>) {
  return Object.fromEntries(
    SUPPLY_COMPONENT_IDS.map((component) => [component, parseStellarAmount(values[component])]),
  ) as Record<SupplyComponentId, StellarAmount>
}

function sumComponents(components: Record<SupplyComponentId, StellarAmount>) {
  return SUPPLY_COMPONENT_IDS.reduce(
    (total, component) => total.add(components[component]),
    StellarAmount.fromStroops(0n),
  )
}

function initialAssetUrl(root: string, asset: Extract<AssetId, { kind: 'credit' }>, pageSize: number) {
  const url = new URL(endpoint(root, 'assets'))
  url.searchParams.set('asset_code', asset.code)
  url.searchParams.set('asset_issuer', asset.issuer)
  url.searchParams.set('order', 'asc')
  url.searchParams.set('limit', String(pageSize))
  return url.toString()
}

function assertNextPageUrl({
  nextUrl,
  root,
  asset,
  pageSize,
  endpointPolicy,
}: {
  nextUrl: string
  root: string
  asset: Extract<AssetId, { kind: 'credit' }>
  pageSize: number
  endpointPolicy: HorizonEndpointPolicy
}) {
  const parsed = new URL(nextUrl)
  const expected = new URL(endpoint(root, 'assets'))
  assertHorizonEndpointAllowed(parsed, endpointPolicy)
  if (
    parsed.origin !== expected.origin ||
    parsed.pathname !== expected.pathname ||
    parsed.searchParams.get('asset_code') !== asset.code ||
    parsed.searchParams.get('asset_issuer') !== asset.issuer ||
    parsed.searchParams.get('order') !== 'asc' ||
    parsed.searchParams.get('limit') !== String(pageSize) ||
    !parsed.searchParams.get('cursor') ||
    ['asset_code', 'asset_issuer', 'order', 'limit', 'cursor'].some(
      (key) => parsed.searchParams.getAll(key).length !== 1,
    ) ||
    [...parsed.searchParams.keys()].some(
      (key) => !['asset_code', 'asset_issuer', 'order', 'limit', 'cursor'].includes(key),
    )
  ) {
    throw new Error('Horizon next-page URL changed the configured asset endpoint')
  }
  return parsed.toString()
}

function checkpointMatches(
  checkpoint: HorizonSupplyCheckpoint,
  source: HorizonSupplySource,
  asset: Extract<AssetId, { kind: 'credit' }>,
  network: NetworkIdentity,
) {
  return checkpoint.source.id === source.id &&
    checkpoint.source.url === source.url &&
    checkpoint.source.sourceClass === source.sourceClass &&
    checkpoint.source.adapter === source.adapter &&
    checkpoint.source.network.id === source.network.id &&
    checkpoint.source.network.passphrase === source.network.passphrase &&
    checkpoint.asset === formatAssetId(asset) &&
    checkpoint.expectedNetwork.id === network.id &&
    checkpoint.expectedNetwork.passphrase === network.passphrase
}

function assertCheckpointConsistent({
  checkpoint,
  root,
  asset,
  endpointPolicy,
}: {
  checkpoint: HorizonSupplyCheckpoint
  root: string
  asset: Extract<AssetId, { kind: 'credit' }>
  endpointPolicy: HorizonEndpointPolicy
}) {
  if (checkpoint.pagesScanned !== checkpoint.seenPageUrls.length) {
    throw new Error('checkpoint page count does not match its completed pages')
  }
  if (new Set(checkpoint.seenPageUrls).size !== checkpoint.seenPageUrls.length) {
    throw new Error('checkpoint contains repeated page URLs')
  }
  if (new Set(checkpoint.seenPagingTokens).size !== checkpoint.seenPagingTokens.length) {
    throw new Error('checkpoint contains repeated paging tokens')
  }
  if (checkpoint.recordsScanned !== checkpoint.seenPagingTokens.length || checkpoint.recordsScanned > 1) {
    throw new Error('checkpoint record count is inconsistent with an exact asset query')
  }
  if ((checkpoint.pagesScanned === 0) !== (checkpoint.ledgerSequence === null)) {
    throw new Error('checkpoint ledger fence is inconsistent with its completed pages')
  }
  if (checkpoint.nextUrl === null && checkpoint.pagesScanned === 0) {
    throw new Error('checkpoint cannot terminate before scanning an asset page')
  }
  if (checkpoint.issuerObservedAtLedger === null) {
    throw new Error('checkpoint omitted the issuer request ledger')
  }
  const expectedLastCursor = checkpoint.seenPageUrls.length
    ? new URL(checkpoint.seenPageUrls.at(-1)!).searchParams.get('cursor')
    : null
  if (checkpoint.lastRequestedCursor !== expectedLastCursor) {
    throw new Error('checkpoint terminal cursor does not match its completed pages')
  }

  const initialUrl = initialAssetUrl(root, asset, checkpoint.pageSize)
  for (const [index, pageUrl] of checkpoint.seenPageUrls.entries()) {
    if (index === 0) {
      if (pageUrl !== initialUrl) throw new Error('checkpoint initial page URL is invalid')
    } else {
      assertNextPageUrl({ nextUrl: pageUrl, root, asset, pageSize: checkpoint.pageSize, endpointPolicy })
    }
  }
  if (checkpoint.nextUrl) {
    if (checkpoint.pagesScanned === 0) {
      if (checkpoint.nextUrl !== initialUrl) throw new Error('checkpoint initial next-page URL is invalid')
    } else {
      assertNextPageUrl({ nextUrl: checkpoint.nextUrl, root, asset, pageSize: checkpoint.pageSize, endpointPolicy })
    }
    if (checkpoint.seenPageUrls.includes(checkpoint.nextUrl)) throw new Error('checkpoint next page was already completed')
  }

  if ((checkpoint.record === null) !== (checkpoint.recordsScanned === 0)) {
    throw new Error('checkpoint record is inconsistent with its record count')
  }
  if (checkpoint.record) {
    if (
      checkpoint.seenPagingTokens.length !== 1 ||
      checkpoint.seenPagingTokens[0] !== checkpoint.record.pagingToken
    ) {
      throw new Error('checkpoint asset record does not match its paging token')
    }
    const parsedRecord = assetRecordSchema.safeParse(checkpoint.record.rawRecord)
    if (
      !parsedRecord.success ||
      parsedRecord.data.asset_code !== asset.code ||
      parsedRecord.data.asset_issuer !== asset.issuer ||
      parsedRecord.data.asset_type !== (asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12') ||
      parsedRecord.data.paging_token !== checkpoint.record.pagingToken ||
      JSON.stringify(componentStrings(parsedRecord.data)) !== JSON.stringify(checkpoint.record.components)
    ) {
      throw new Error('checkpoint asset record or components are inconsistent')
    }
  }

  const expectedKinds = [
    'root',
    'issuer',
    ...Array.from({ length: checkpoint.pagesScanned }, () => 'asset_page'),
  ]
  const rootRequest = checkpoint.requestProvenance[0]
  const issuerRequest = checkpoint.requestProvenance[1]
  if (
    checkpoint.requestProvenance.length !== expectedKinds.length ||
    checkpoint.requestProvenance.some((request, index) =>
      request.kind !== expectedKinds[index] ||
      request.payloadSha256 === null ||
      Date.parse(request.startedAt) > Date.parse(request.completedAt) ||
      (request.kind === 'asset_page' && request.latestLedger !== checkpoint.ledgerSequence)
    ) ||
    rootRequest?.url !== endpoint(root, '/') ||
    rootRequest?.latestLedger !== null ||
    issuerRequest?.url !== endpoint(root, `accounts/${asset.issuer}`) ||
    issuerRequest?.latestLedger !== checkpoint.issuerObservedAtLedger ||
    checkpoint.requestProvenance.slice(2).some(
      (request, index) => request.url !== checkpoint.seenPageUrls[index],
    )
  ) {
    throw new Error('checkpoint request provenance is inconsistent')
  }
}

async function fetchHorizonOnchainAssetSupplyAttempt({
  source,
  asset: assetInput,
  expectedNetwork: networkInput,
  checkpoint: checkpointInput,
  fetchImpl = fetch,
  clock = () => new Date(),
  signal,
  endpointPolicy = {},
  timeoutMs = DEFAULT_HORIZON_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_HORIZON_MAX_RESPONSE_BYTES,
  pageSize = DEFAULT_SUPPLY_PAGE_SIZE,
  maxPages = DEFAULT_SUPPLY_MAX_PAGES,
  maxRecords = DEFAULT_SUPPLY_MAX_RECORDS,
}: HorizonSupplyFetchOptions, ledgerRestarts: number): Promise<HorizonSupplyResult> {
  const requestedAt = timestamp(clock)
  const parsedAsset = assetIdSchema.safeParse(assetInput)
  if (!parsedAsset.success || parsedAsset.data.kind !== 'credit') {
    return supplyError(source, 'invalid_asset', 'Supply v0.1 requires a valid classic credit asset', requestedAt)
  }
  const asset = parsedAsset.data
  let expectedNetwork: NetworkIdentity
  let root: string
  try {
    source = sourceIdentitySchema.parse(source)
    expectedNetwork = networkIdentitySchema.parse(networkInput)
    if (source.adapter !== 'horizon') throw new Error('supply Horizon connector requires the horizon adapter')
    if (
      source.network.id !== expectedNetwork.id ||
      source.network.passphrase !== expectedNetwork.passphrase
    ) {
      throw new Error('source network identity does not match the requested network')
    }
    root = baseUrl(source, endpointPolicy)
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error('pageSize must be from 1 to 200')
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('maxPages must be a positive integer')
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new Error('maxRecords must be a positive integer')
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be greater than zero')
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw new Error('maxResponseBytes must be a positive integer')
    }
  } catch (error) {
    return supplyError(
      source,
      'invalid_configuration',
      error instanceof Error ? error.message : 'Supply connector configuration is invalid',
      requestedAt,
    )
  }

  let checkpoint: HorizonSupplyCheckpoint
  const resumedFromCheckpoint = checkpointInput !== undefined
  if (checkpointInput !== undefined) {
    const parsed = checkpointSchema.safeParse(checkpointInput)
    if (!parsed.success || !checkpointMatches(parsed.data, source, asset, expectedNetwork) || parsed.data.pageSize !== pageSize) {
      return supplyError(source, 'invalid_configuration', 'Supply checkpoint does not match the requested scan', requestedAt)
    }
    checkpoint = structuredClone(parsed.data)
    try {
      assertCheckpointConsistent({ checkpoint, root, asset, endpointPolicy })
    } catch (error) {
      return supplyError(
        source,
        'invalid_configuration',
        error instanceof Error ? error.message : 'Supply checkpoint is inconsistent',
        requestedAt,
      )
    }
  } else {
    checkpoint = {
      version: 1,
      source,
      asset: formatAssetId(asset),
      expectedNetwork,
      nextUrl: initialAssetUrl(root, asset, pageSize),
      ledgerSequence: null,
      pageSize,
      pagesScanned: 0,
      recordsScanned: 0,
      lastRequestedCursor: null,
      seenPageUrls: [],
      seenPagingTokens: [],
      record: null,
      issuerObservedAtLedger: null,
      requestProvenance: [],
    }

    const rootUrl = endpoint(root, '/')
    const rootResult = await requestJson({ url: rootUrl, fetchImpl, signal, timeoutMs, maxResponseBytes, clock })
    if ('failure' in rootResult) {
      return supplyError(source, rootResult.failure, rootResult.message, rootResult.completedAt)
    }
    if (!rootResult.response.ok) {
      return supplyError(source, 'non_200_response', `Horizon root returned HTTP ${rootResult.response.status}`, rootResult.completedAt, {
        status: rootResult.response.status,
        retryAfterMs: parseRetryAfter(rootResult.response.headers.get('retry-after'), rootResult.completedAt),
      })
    }
    const rootPayload = rootSchema.safeParse(rootResult.payload)
    if (!rootPayload.success) return supplyError(source, 'malformed_payload', 'Horizon root payload is malformed', rootResult.completedAt)
    checkpoint.requestProvenance.push({
      kind: 'root',
      url: rootUrl,
      status: rootResult.response.status,
      startedAt: rootResult.startedAt,
      completedAt: rootResult.completedAt,
      latestLedger: null,
      payloadSha256: rootResult.payloadSha256,
    })
    if (rootPayload.data.network_passphrase !== expectedNetwork.passphrase) {
      return supplyError(source, 'network_mismatch', 'Horizon network passphrase does not match the requested network', rootResult.completedAt)
    }

    const issuerUrl = endpoint(root, `accounts/${asset.issuer}`)
    const issuerResult = await requestJson({ url: issuerUrl, fetchImpl, signal, timeoutMs, maxResponseBytes, clock })
    if ('failure' in issuerResult) return supplyError(source, issuerResult.failure, issuerResult.message, issuerResult.completedAt)
    if (!issuerResult.response.ok) {
      const code = issuerResult.response.status === 404 ? 'issuer_not_found' : 'non_200_response'
      return supplyError(source, code, code === 'issuer_not_found' ? 'Asset issuer account was not found' : `Horizon issuer endpoint returned HTTP ${issuerResult.response.status}`, issuerResult.completedAt, {
        status: issuerResult.response.status,
        retryAfterMs: parseRetryAfter(issuerResult.response.headers.get('retry-after'), issuerResult.completedAt),
      })
    }
    const issuerPayload = issuerSchema.safeParse(issuerResult.payload)
    if (!issuerPayload.success || issuerPayload.data.account_id !== asset.issuer) {
      return supplyError(source, 'malformed_payload', 'Horizon issuer payload does not match the requested issuer', issuerResult.completedAt)
    }
    checkpoint.issuerObservedAtLedger = parsePositiveInteger(issuerResult.response.headers.get('latest-ledger'))
    if (!checkpoint.issuerObservedAtLedger) {
      return supplyError(
        source,
        'malformed_payload',
        'Horizon issuer response omitted a valid Latest-Ledger header',
        issuerResult.completedAt,
      )
    }
    checkpoint.requestProvenance.push({
      kind: 'issuer',
      url: issuerUrl,
      status: issuerResult.response.status,
      startedAt: issuerResult.startedAt,
      completedAt: issuerResult.completedAt,
      latestLedger: checkpoint.issuerObservedAtLedger,
      payloadSha256: issuerResult.payloadSha256,
    })
  }

  while (checkpoint.nextUrl) {
    if (checkpoint.pagesScanned >= maxPages) {
      return supplyError(source, 'partial_scan', `Supply scan exceeded ${maxPages} pages`, timestamp(clock), { checkpoint })
    }
    if (checkpoint.seenPageUrls.includes(checkpoint.nextUrl)) {
      return supplyError(source, 'duplicate_record', 'Supply pagination repeated a page URL', timestamp(clock), {
        checkpoint,
        restartRequired: true,
      })
    }
    const pageUrl = checkpoint.nextUrl
    const requestedCursor = new URL(pageUrl).searchParams.get('cursor')
    const pageResult = await requestJson({ url: pageUrl, fetchImpl, signal, timeoutMs, maxResponseBytes, clock })
    if ('failure' in pageResult) {
      return supplyError(source, pageResult.failure, pageResult.message, pageResult.completedAt, { checkpoint })
    }
    if (!pageResult.response.ok) {
      return supplyError(source, 'non_200_response', `Horizon assets endpoint returned HTTP ${pageResult.response.status}`, pageResult.completedAt, {
        status: pageResult.response.status,
        retryAfterMs: parseRetryAfter(pageResult.response.headers.get('retry-after'), pageResult.completedAt),
        checkpoint,
      })
    }
    const latestLedger = parsePositiveInteger(pageResult.response.headers.get('latest-ledger'))
    if (!latestLedger) {
      return supplyError(source, 'malformed_payload', 'Horizon assets response omitted a valid Latest-Ledger header', pageResult.completedAt, { checkpoint })
    }
    if (checkpoint.ledgerSequence !== null && checkpoint.ledgerSequence !== latestLedger) {
      return supplyError(source, 'ledger_changed', 'Horizon ledger changed during the supply scan', pageResult.completedAt, {
        restartRequired: true,
      })
    }
    const page = assetPageSchema.safeParse(pageResult.payload)
    if (!page.success) {
      return supplyError(source, 'malformed_payload', 'Horizon asset page is incomplete or malformed', pageResult.completedAt, { checkpoint })
    }
    const records = page.data._embedded.records
    if (checkpoint.recordsScanned + records.length > maxRecords) {
      return supplyError(source, 'partial_scan', `Supply scan exceeded ${maxRecords} records`, pageResult.completedAt, { checkpoint })
    }
    let nextRecord = checkpoint.record
    const nextPagingTokens: string[] = []
    for (const record of records) {
      if (record.asset_code !== asset.code || record.asset_issuer !== asset.issuer) {
        return supplyError(source, 'malformed_payload', 'Horizon asset page returned a different asset', pageResult.completedAt, { checkpoint })
      }
      const expectedAssetType = asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'
      if (record.asset_type !== expectedAssetType) {
        return supplyError(source, 'malformed_payload', 'Horizon asset record type does not match its asset code', pageResult.completedAt, { checkpoint })
      }
      if (checkpoint.seenPagingTokens.includes(record.paging_token) || nextPagingTokens.includes(record.paging_token) || nextRecord) {
        return supplyError(source, 'duplicate_record', 'Horizon asset scan returned a duplicate asset record', pageResult.completedAt, {
          checkpoint,
          restartRequired: true,
        })
      }
      nextPagingTokens.push(record.paging_token)
      nextRecord = {
        pagingToken: record.paging_token,
        components: componentStrings(record),
        rawRecord: { ...record },
      }
    }

    const recordsOnPage = records.length
    let nextUrl: string | null
    if (recordsOnPage < pageSize) {
      nextUrl = null
    } else {
      const next = page.data._links.next?.href
      if (!next) return supplyError(source, 'partial_scan', 'Full Horizon asset page omitted its next link', pageResult.completedAt, { checkpoint })
      try {
        nextUrl = assertNextPageUrl({ nextUrl: next, root, asset, pageSize, endpointPolicy })
      } catch (error) {
        return supplyError(source, 'malformed_payload', error instanceof Error ? error.message : 'Invalid next-page URL', pageResult.completedAt, { checkpoint })
      }
    }

    checkpoint.ledgerSequence = latestLedger
    checkpoint.pagesScanned += 1
    checkpoint.recordsScanned += records.length
    checkpoint.lastRequestedCursor = requestedCursor
    checkpoint.seenPageUrls.push(pageUrl)
    checkpoint.seenPagingTokens.push(...nextPagingTokens)
    checkpoint.record = nextRecord
    checkpoint.nextUrl = nextUrl
    checkpoint.requestProvenance.push({
      kind: 'asset_page',
      url: pageUrl,
      status: pageResult.response.status,
      startedAt: pageResult.startedAt,
      completedAt: pageResult.completedAt,
      latestLedger,
      payloadSha256: pageResult.payloadSha256,
    })
  }

  if (!checkpoint.record || !checkpoint.ledgerSequence) {
    return supplyError(source, 'asset_not_found', 'Horizon did not return the requested asset', timestamp(clock), { checkpoint })
  }

  const ledgerUrl = endpoint(root, `ledgers/${checkpoint.ledgerSequence}`)
  const ledgerResult = await requestJson({ url: ledgerUrl, fetchImpl, signal, timeoutMs, maxResponseBytes, clock })
  if ('failure' in ledgerResult) return supplyError(source, ledgerResult.failure, ledgerResult.message, ledgerResult.completedAt, { checkpoint })
  if (!ledgerResult.response.ok) {
    return supplyError(source, 'non_200_response', `Horizon ledger endpoint returned HTTP ${ledgerResult.response.status}`, ledgerResult.completedAt, {
      status: ledgerResult.response.status,
      retryAfterMs: parseRetryAfter(ledgerResult.response.headers.get('retry-after'), ledgerResult.completedAt),
      checkpoint,
    })
  }
  const ledger = ledgerSchema.safeParse(ledgerResult.payload)
  const ledgerSequence = ledger.success ? Number(ledger.data.sequence) : Number.NaN
  const ledgerClosedAt = ledger.success ? new Date(ledger.data.closed_at) : new Date(Number.NaN)
  if (!ledger.success || ledgerSequence !== checkpoint.ledgerSequence || !Number.isFinite(ledgerClosedAt.getTime())) {
    return supplyError(source, 'malformed_payload', 'Horizon ledger payload does not match the supply ledger', ledgerResult.completedAt, { checkpoint })
  }
  checkpoint.requestProvenance.push({
    kind: 'ledger',
    url: ledgerUrl,
    status: ledgerResult.response.status,
    startedAt: ledgerResult.startedAt,
    completedAt: ledgerResult.completedAt,
    latestLedger: checkpoint.ledgerSequence,
    payloadSha256: ledgerResult.payloadSha256,
  })

  const components = parseComponents(checkpoint.record.components)
  const amount = sumComponents(components)
  const firstPagingToken = checkpoint.seenPagingTokens[0]!
  const lastPagingToken = checkpoint.seenPagingTokens.at(-1)!
  return {
    observation: {
      source,
      asset,
      network: expectedNetwork,
      amount,
      components,
      ledgerSequence: checkpoint.ledgerSequence,
      ledgerClosedAt: ledgerClosedAt.toISOString(),
      sourceTimestamp: ledgerClosedAt.toISOString(),
      retrievedAt: ledgerResult.completedAt,
      methodologyVersion: SUPPLY_METHODOLOGY_VERSION,
      connectorVersion: HORIZON_SUPPLY_CONNECTOR_VERSION,
      derivationFamily: HORIZON_SUPPLY_DERIVATION_FAMILY,
      issuerObservedAtLedger: checkpoint.issuerObservedAtLedger,
      pageMetadata: {
        pagesScanned: checkpoint.pagesScanned,
        recordsScanned: checkpoint.recordsScanned,
        firstPagingToken,
        lastPagingToken,
        terminalCursor: checkpoint.lastRequestedCursor ?? lastPagingToken,
        checkpointVersion: checkpoint.version,
        ledgerRestarts,
        resumedFromCheckpoint,
      },
      requestProvenance: checkpoint.requestProvenance,
      rawPayload: {
        assetRecord: checkpoint.record.rawRecord,
        componentAmounts: checkpoint.record.components,
      },
    },
  }
}

export async function fetchHorizonOnchainAssetSupply(options: HorizonSupplyFetchOptions): Promise<HorizonSupplyResult> {
  const maxLedgerRestarts = options.maxLedgerRestarts ?? DEFAULT_SUPPLY_MAX_LEDGER_RESTARTS
  if (!Number.isSafeInteger(maxLedgerRestarts) || maxLedgerRestarts < 0) {
    const clock = options.clock ?? (() => new Date())
    return supplyError(
      options.source,
      'invalid_configuration',
      'maxLedgerRestarts must be a non-negative safe integer',
      timestamp(clock),
    )
  }

  let attemptOptions = options
  for (let ledgerRestarts = 0; ledgerRestarts <= maxLedgerRestarts; ledgerRestarts += 1) {
    const result = await fetchHorizonOnchainAssetSupplyAttempt(attemptOptions, ledgerRestarts)
    if (result.error?.code !== 'ledger_changed' || ledgerRestarts === maxLedgerRestarts) return result
    attemptOptions = { ...options, checkpoint: undefined }
  }
  throw new Error('unreachable supply restart state')
}
