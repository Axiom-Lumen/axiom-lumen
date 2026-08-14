import { z } from 'zod'
import { TRUSTLINE_METHODOLOGY_VERSION } from '../../config/methodology'
import {
  assetIdSchema,
  identifierSchema,
  networkIdentitySchema,
  sourceIdentitySchema,
  trustlineCountObservationSchema,
  type NetworkIdentity,
  type RawObservation,
  type SourceIdentity,
} from '../contracts/domain'
import { computeEvidenceSha256 } from '../evidence/json'
import {
  DEFAULT_HORIZON_MAX_RESPONSE_BYTES,
  DEFAULT_HORIZON_TIMEOUT_MS,
  HorizonResponseTooLargeError,
  assertHorizonEndpointAllowed,
  parseRetryAfter,
  readBoundedHorizonJson,
  type HorizonEndpointPolicy,
} from './horizon'
import type { HorizonSupplyError } from './horizon-supply'

export const HORIZON_TRUSTLINE_CONNECTOR_VERSION = 'horizon-trustlines-v0.1' as const
export const HORIZON_TRUSTLINE_DERIVATION_FAMILY = 'horizon_asset_aggregate' as const

const countSchema = z.union([
  z.number().int().safe().nonnegative().transform(BigInt),
  z.string().regex(/^(0|[1-9]\d*)$/).transform(BigInt),
])
const rootSchema = z.object({ network_passphrase: z.string().trim().min(1) }).passthrough()
const issuerSchema = z.object({ account_id: z.string() }).passthrough()
const assetRecordSchema = z.object({
  asset_type: z.enum(['credit_alphanum4', 'credit_alphanum12']),
  asset_code: z.string(),
  asset_issuer: z.string(),
  paging_token: z.union([z.string(), z.number()]).transform(String),
  accounts: z.object({
    authorized: countSchema,
    authorized_to_maintain_liabilities: countSchema,
    unauthorized: countSchema,
  }).strict(),
}).passthrough()
const assetPageSchema = z.object({
  _embedded: z.object({ records: z.array(assetRecordSchema) }).passthrough(),
}).passthrough()
const ledgerSchema = z.object({
  sequence: z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().safe().positive()]),
  closed_at: z.string().datetime({ offset: true }),
}).passthrough()

export interface HorizonTrustlineFetchOptions {
  source: SourceIdentity
  asset: unknown
  expectedNetwork: NetworkIdentity | unknown
  fetchImpl?: typeof fetch
  clock?: () => Date
  signal?: AbortSignal
  endpointPolicy?: HorizonEndpointPolicy
  timeoutMs?: number
  maxResponseBytes?: number
}

interface RequestEvidence {
  kind: 'root' | 'issuer' | 'asset_page' | 'ledger'
  url: string
  status: number
  startedAt: string
  completedAt: string
  latestLedger: number | null
  payloadSha256: string | null
}

interface RequestResult {
  response: Response
  payload: unknown
  payloadSha256: string | null
  startedAt: string
  completedAt: string
}

type RequestFailure = {
  code: HorizonSupplyError['code']
  message: string
  completedAt: string
  status?: number
  retryAfterMs?: number
}

export type HorizonTrustlineObservation = Extract<RawObservation, { metric: 'trustline_count' }>
export type HorizonTrustlineResult =
  | { observation: HorizonTrustlineObservation; evidence: unknown; error?: never }
  | { observation?: never; evidence?: never; error: HorizonSupplyError }

function timestamp(clock: () => Date) {
  const value = clock()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('clock must return a valid Date')
  return value.toISOString()
}

function positiveInteger(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function endpointRoot(source: SourceIdentity, policy: HorizonEndpointPolicy) {
  const parsed = new URL(source.url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Horizon URL must use HTTP or HTTPS')
  assertHorizonEndpointAllowed(parsed, policy)
  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/$/, '')
}

function endpoint(root: string, path: string) {
  return `${root}/${path.replace(/^\//, '')}`
}

function failure(source: SourceIdentity, code: HorizonSupplyError['code'], message: string, retrievedAt: string, extras: Partial<Pick<HorizonSupplyError, 'status' | 'retryAfterMs'>> = {}): HorizonTrustlineResult {
  return { error: { sourceId: source.id, sourceUrl: source.url, code, message, retrievedAt, ...extras } }
}

async function requestJson(options: {
  url: string
  fetchImpl: typeof fetch
  signal?: AbortSignal
  timeoutMs: number
  maxResponseBytes: number
  clock: () => Date
}): Promise<RequestResult | RequestFailure> {
  const startedAt = timestamp(options.clock)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await options.fetchImpl(options.url, {
      signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'error',
    })
    const completedAt = timestamp(options.clock)
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      return { code: 'redirect_rejected', message: 'Horizon request redirected outside the configured endpoint', completedAt }
    }
    if (!response.ok) {
      return {
        code: 'non_200_response',
        message: `Horizon request returned HTTP ${response.status}`,
        completedAt,
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), completedAt),
      }
    }
    try {
      const payload = await readBoundedHorizonJson(response, options.maxResponseBytes)
      return { response, payload, payloadSha256: computeEvidenceSha256(payload), startedAt, completedAt }
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        return { code: 'request_aborted', message: `Horizon request exceeded ${options.timeoutMs}ms`, completedAt }
      }
      return {
        code: error instanceof HorizonResponseTooLargeError ? 'response_too_large' : 'malformed_payload',
        message: error instanceof HorizonResponseTooLargeError
          ? `Horizon response exceeded ${options.maxResponseBytes} bytes`
          : 'Horizon response was not valid JSON',
        completedAt,
      }
    }
  } catch (error) {
    if (options.signal?.aborted) throw error
    const completedAt = timestamp(options.clock)
    return {
      code: error instanceof Error && error.name === 'AbortError' ? 'request_aborted' : 'request_failed',
      message: error instanceof Error && error.name === 'AbortError'
        ? `Horizon request exceeded ${options.timeoutMs}ms`
        : 'Horizon request failed',
      completedAt,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchHorizonTrustlineObservation({
  source: sourceInput,
  asset: assetInput,
  expectedNetwork: networkInput,
  fetchImpl = fetch,
  clock = () => new Date(),
  signal,
  endpointPolicy = {},
  timeoutMs = DEFAULT_HORIZON_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_HORIZON_MAX_RESPONSE_BYTES,
  observationId,
  cycleId,
}: HorizonTrustlineFetchOptions & { observationId: string; cycleId: string }): Promise<HorizonTrustlineResult> {
  const requestedAt = timestamp(clock)
  const parsedAsset = assetIdSchema.safeParse(assetInput)
  if (!parsedAsset.success || parsedAsset.data.kind !== 'credit') {
    return failure(sourceInput, 'invalid_asset', 'Trustline state requires a valid classic credit asset', requestedAt)
  }
  const asset = parsedAsset.data
  let source: SourceIdentity
  let expectedNetwork: NetworkIdentity
  let root: string
  try {
    source = sourceIdentitySchema.parse(sourceInput)
    expectedNetwork = networkIdentitySchema.parse(networkInput)
    if (source.adapter !== 'horizon') throw new Error('trustline connector requires the horizon adapter')
    if (source.network.id !== expectedNetwork.id || source.network.passphrase !== expectedNetwork.passphrase) {
      throw new Error('source network identity does not match the requested network')
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be greater than zero')
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error('maxResponseBytes must be a positive integer')
    root = endpointRoot(source, endpointPolicy)
  } catch (error) {
    return failure(sourceInput, 'invalid_configuration', error instanceof Error ? error.message : 'Trustline connector configuration is invalid', requestedAt)
  }

  const provenance: RequestEvidence[] = []
  const perform = async (kind: RequestEvidence['kind'], url: string) => {
    const result = await requestJson({ url, fetchImpl, signal, timeoutMs, maxResponseBytes, clock })
    if ('code' in result) return result
    provenance.push({ kind, url, status: result.response.status, startedAt: result.startedAt, completedAt: result.completedAt, latestLedger: positiveInteger(result.response.headers.get('latest-ledger')), payloadSha256: result.payloadSha256 })
    return result
  }

  const rootResult = await perform('root', endpoint(root, '/'))
  if ('code' in rootResult) return failure(source, rootResult.code, rootResult.message, rootResult.completedAt, rootResult)
  const rootPayload = rootSchema.safeParse(rootResult.payload)
  if (!rootPayload.success) return failure(source, 'malformed_payload', 'Horizon root payload is malformed', rootResult.completedAt)
  if (rootPayload.data.network_passphrase !== expectedNetwork.passphrase) return failure(source, 'network_mismatch', 'Horizon network passphrase does not match the requested network', rootResult.completedAt)

  const issuerResult = await perform('issuer', endpoint(root, `accounts/${asset.issuer}`))
  if ('code' in issuerResult) {
    const code = issuerResult.status === 404 ? 'issuer_not_found' : issuerResult.code
    return failure(source, code, code === 'issuer_not_found' ? 'Asset issuer account was not found' : issuerResult.message, issuerResult.completedAt, issuerResult)
  }
  const issuerPayload = issuerSchema.safeParse(issuerResult.payload)
  const issuerLedger = positiveInteger(issuerResult.response.headers.get('latest-ledger'))
  if (!issuerPayload.success || issuerPayload.data.account_id !== asset.issuer || !issuerLedger) {
    return failure(source, 'malformed_payload', 'Horizon issuer response is malformed or missing its ledger boundary', issuerResult.completedAt)
  }

  const assetUrl = new URL(endpoint(root, 'assets'))
  assetUrl.searchParams.set('asset_code', asset.code)
  assetUrl.searchParams.set('asset_issuer', asset.issuer)
  assetUrl.searchParams.set('order', 'asc')
  assetUrl.searchParams.set('limit', '1')
  const assetResult = await perform('asset_page', assetUrl.toString())
  if ('code' in assetResult) return failure(source, assetResult.code, assetResult.message, assetResult.completedAt, assetResult)
  const assetLedger = positiveInteger(assetResult.response.headers.get('latest-ledger'))
  const page = assetPageSchema.safeParse(assetResult.payload)
  if (!assetLedger || !page.success) return failure(source, 'malformed_payload', 'Horizon asset page is incomplete or malformed', assetResult.completedAt)
  if (issuerLedger > assetLedger) return failure(source, 'ledger_changed', 'Horizon issuer evidence is newer than the asset ledger boundary', assetResult.completedAt)
  if (page.data._embedded.records.length === 0) return failure(source, 'asset_not_found', 'Horizon did not return the requested asset', assetResult.completedAt)
  if (page.data._embedded.records.length !== 1) return failure(source, 'duplicate_record', 'Horizon returned duplicate records for the requested asset', assetResult.completedAt)
  const record = page.data._embedded.records[0]!
  const rawRecord = (assetResult.payload as { _embedded: { records: unknown[] } })._embedded.records[0]
  const expectedType = asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'
  if (record.asset_code !== asset.code || record.asset_issuer !== asset.issuer || record.asset_type !== expectedType) {
    return failure(source, 'malformed_payload', 'Horizon asset record does not match the requested asset', assetResult.completedAt)
  }

  const ledgerResult = await perform('ledger', endpoint(root, `ledgers/${assetLedger}`))
  if ('code' in ledgerResult) return failure(source, ledgerResult.code, ledgerResult.message, ledgerResult.completedAt, ledgerResult)
  const ledger = ledgerSchema.safeParse(ledgerResult.payload)
  if (!ledger.success || Number(ledger.data.sequence) !== assetLedger) return failure(source, 'malformed_payload', 'Horizon ledger payload does not match the asset ledger', ledgerResult.completedAt)
  const ledgerClosedAt = new Date(ledger.data.closed_at).toISOString()
  provenance.at(-1)!.latestLedger = assetLedger

  const states = record.accounts
  const total = states.authorized + states.authorized_to_maintain_liabilities + states.unauthorized
  const evidence = {
    rawPayload: { assetRecord: rawRecord },
    requestProvenance: provenance,
    pageMetadata: { pagesScanned: 1, recordsScanned: 1, firstPagingToken: record.paging_token, lastPagingToken: record.paging_token, terminalCursor: record.paging_token },
  }
  return {
    observation: trustlineCountObservationSchema.parse({
      observationId: identifierSchema.parse(observationId), cycleId: identifierSchema.parse(cycleId), metric: 'trustline_count', asset, total, states,
      ledgerSequence: assetLedger, methodologyVersion: TRUSTLINE_METHODOLOGY_VERSION,
      provenance: { source, sourceTimestamp: ledgerClosedAt, retrievedAt: ledgerResult.completedAt },
      derivation: { family: HORIZON_TRUSTLINE_DERIVATION_FAMILY, connectorVersion: HORIZON_TRUSTLINE_CONNECTOR_VERSION, evidenceSha256: computeEvidenceSha256(evidence), checkpoint: { ledgerSequence: assetLedger } },
    }),
    evidence,
  }
}
