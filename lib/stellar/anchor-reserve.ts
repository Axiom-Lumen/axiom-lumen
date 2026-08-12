import { z } from 'zod'
import { createHash } from 'node:crypto'
import {
  ANCHOR_RESERVE_ATTESTATION_SCHEMA,
  ANCHOR_RESERVE_METHODOLOGY_VERSION,
} from '../../config/methodology'
import {
  anchorReservesObservationSchema,
  creditAssetSchema,
  formatAssetId,
  parseAssetId,
  type SourceIdentity,
} from '../contracts/domain'
import { fetchSafePublicHttps, readBoundedText, UnsafeEndpointError, type ResolveHost, type SafeHttpsConnect } from './safe-http'

export const ANCHOR_RESERVE_CONNECTOR_VERSION = 'anchor-reserve-json-v0.1' as const

const attestationPayloadSchema = z.object({
  schema: z.literal(ANCHOR_RESERVE_ATTESTATION_SCHEMA),
  asset: z.string(),
  unit: z.object({ kind: z.literal('asset_units'), asset: z.string() }).strict(),
  reserve_amount: z.string(),
  period_start: z.string().datetime({ offset: true }),
  period_end: z.string().datetime({ offset: true }),
  published_at: z.string().datetime({ offset: true }),
}).strict()

export interface AnchorReserveConnectorError {
  sourceId: string
  sourceUrl: string
  code: 'invalid_configuration' | 'request_failed' | 'request_aborted' | 'non_200_response' |
    'redirect_rejected' | 'response_too_large' | 'malformed_payload' | 'unsafe_endpoint' |
    'scope_mismatch' | 'unit_mismatch' | 'stale_observation' | 'period_mismatch' |
    'reference_unavailable' | 'excluded_source' | 'unsupported_attestation'
  message: string
  retrievedAt: string
  status?: number
  retryAfterMs?: number
  startedAt?: string
  completedAt?: string
}

export type AnchorReserveConnectorResult =
  | { observation: z.infer<typeof anchorReservesObservationSchema>; evidence: { rawText: string; payload: unknown; connectorVersion: string } }
  | { error: AnchorReserveConnectorError }

function timestamp(clock: () => Date) {
  const value = clock()
  if (!Number.isFinite(value.getTime())) throw new Error('clock must return a valid Date')
  return value.toISOString()
}

function error(source: SourceIdentity, code: AnchorReserveConnectorError['code'], message: string, retrievedAt: string, status?: number): AnchorReserveConnectorResult {
  return { error: { sourceId: source.id, sourceUrl: source.url, code, message, retrievedAt, ...(status === undefined ? {} : { status }) } }
}

function retryAfterMilliseconds(response: Response, now: string) {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  if (/^\d+$/.test(value)) return Number(value) * 1_000
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.parse(now)) : undefined
}

export async function fetchAnchorReserveObservation(options: {
  observationId: string
  cycleId: string
  anchorId: string
  source: SourceIdentity
  asset: unknown
  connectImpl?: SafeHttpsConnect
  resolve?: ResolveHost
  timeoutMs?: number
  maximumBytes?: number
  signal?: AbortSignal
  clock?: () => Date
}): Promise<AnchorReserveConnectorResult> {
  const clock = options.clock ?? (() => new Date())
  const retrievedAt = timestamp(clock)
  const asset = creditAssetSchema.parse(options.asset)
  if (options.source.adapter !== 'anchor' || options.source.sourceClass !== 'anchor_self_reported') {
    return error(options.source, 'invalid_configuration', 'Reserve evidence requires an anchor self-reported source', retrievedAt)
  }
  let endpoint: URL
  try { endpoint = new URL(options.source.url) } catch {
    return error(options.source, 'unsafe_endpoint', 'Reserve evidence endpoint did not pass public HTTPS policy', retrievedAt)
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
  try {
    const response = await fetchSafePublicHttps(endpoint, {
      resolve: options.resolve,
      connectImpl: options.connectImpl,
      init: {
        signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
        redirect: 'manual',
        headers: { accept: 'application/json' },
      },
    })
    const completedAt = timestamp(clock)
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      return error(options.source, 'redirect_rejected', 'Reserve evidence redirects are not accepted', completedAt, response.status)
    }
    if (!response.ok) {
      const result = error(options.source, 'non_200_response', `Reserve evidence returned HTTP ${response.status}`, completedAt, response.status)
      const retryAfterMs = retryAfterMilliseconds(response, completedAt)
      return retryAfterMs === undefined || !('error' in result) ? result : { error: { ...result.error, retryAfterMs } }
    }
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') return error(options.source, 'unsupported_attestation', 'Reserve evidence must use application/json', completedAt, response.status)
    let payload: unknown
    let rawText = ''
    try {
      rawText = await readBoundedText(response, options.maximumBytes ?? 256_000)
      payload = JSON.parse(rawText)
    } catch (cause) {
      return error(
        options.source,
        cause instanceof Error && cause.message.includes('maximum size') ? 'response_too_large' : 'malformed_payload',
        cause instanceof Error && cause.message.includes('maximum size') ? 'Reserve evidence exceeds the response limit' : 'Reserve evidence is not valid JSON',
        completedAt,
      )
    }
    const parsed = attestationPayloadSchema.safeParse(payload)
    if (!parsed.success) return error(options.source, 'malformed_payload', 'Reserve evidence does not match the versioned attestation schema', completedAt)
    let payloadAsset
    let unitAsset
    try {
      payloadAsset = creditAssetSchema.parse(parseAssetId(parsed.data.asset))
      unitAsset = creditAssetSchema.parse(parseAssetId(parsed.data.unit.asset))
    } catch {
      return error(options.source, 'scope_mismatch', 'Reserve evidence contains an invalid classic credit-asset identity', completedAt)
    }
    if (formatAssetId(payloadAsset) !== formatAssetId(asset)) {
      return error(options.source, 'scope_mismatch', 'Reserve evidence asset does not match the configured asset', completedAt)
    }
    if (formatAssetId(unitAsset) !== formatAssetId(asset)) {
      return error(options.source, 'unit_mismatch', 'Reserve evidence is not denominated in exact issued-asset units', completedAt)
    }
    try {
      const observation = anchorReservesObservationSchema.parse({
        observationId: options.observationId,
        cycleId: options.cycleId,
        metric: 'anchor_reserves',
        anchorId: options.anchorId,
        asset,
        amount: parsed.data.reserve_amount,
        unit: { kind: 'asset_units', asset: unitAsset },
        attestationPeriodStart: parsed.data.period_start,
        attestationPeriodEnd: parsed.data.period_end,
        publishedAt: parsed.data.published_at,
        methodologyVersion: ANCHOR_RESERVE_METHODOLOGY_VERSION,
        attestation: {
          schema: ANCHOR_RESERVE_ATTESTATION_SCHEMA,
          evidenceSha256: createHash('sha256').update(rawText).digest('hex'),
          documentUrl: endpoint.toString(),
        },
        provenance: { source: options.source, sourceTimestamp: parsed.data.period_end, retrievedAt: completedAt },
      })
      return { observation, evidence: { rawText, payload, connectorVersion: ANCHOR_RESERVE_CONNECTOR_VERSION } }
    } catch {
      return error(options.source, 'malformed_payload', 'Reserve evidence failed semantic validation', completedAt)
    }
  } catch (cause) {
    if (options.signal?.aborted) throw cause
    const completedAt = timestamp(clock)
    return error(
      options.source,
      cause instanceof UnsafeEndpointError ? 'unsafe_endpoint' : cause instanceof Error && cause.name === 'AbortError' ? 'request_aborted' : 'request_failed',
      cause instanceof UnsafeEndpointError ? 'Reserve evidence endpoint did not pass public HTTPS policy' : cause instanceof Error && cause.name === 'AbortError' ? 'Reserve evidence request timed out' : 'Reserve evidence request failed',
      completedAt,
    )
  } finally {
    clearTimeout(timeout)
  }
}
