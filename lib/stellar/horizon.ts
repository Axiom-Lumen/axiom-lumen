import { z } from 'zod'
import type { LatestLedgerObservation, LatestLedgerSourceError } from '../reconcile/latest-ledger'

export const MAX_HORIZON_SOURCES = 10
export const DEFAULT_HORIZON_TIMEOUT_MS = 5000
export const DEFAULT_HORIZON_MAX_RESPONSE_BYTES = 1_000_000
export const PUBLIC_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015'

export interface HorizonSource {
  id: string
  url: string
}

export interface HorizonEndpointPolicy {
  allowedHosts?: readonly string[]
  deniedHosts?: readonly string[]
}

export interface HorizonLatestLedgerFetchResult {
  observations: LatestLedgerObservation[]
  source_errors: LatestLedgerSourceError[]
  sources_configured: number
  sources_excluded: number
  retrieved_at: string
  network_passphrase: string
}

type FetchLike = typeof fetch

const horizonRootPayloadSchema = z.object({ network_passphrase: z.string().trim().min(1) }).passthrough()
const horizonLedgerPayloadSchema = z
  .object({
    _embedded: z
      .object({
        records: z.array(
          z
            .object({
              sequence: z.union([z.number(), z.string()]),
              closed_at: z.string(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough()

function normalizeHostList(hosts: readonly string[] | undefined) {
  return new Set((hosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean))
}

function isRestrictedIpv4(hostname: string) {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false
  const [first = 0, second = 0] = parts.map(Number)
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  )
}

function ipv4MappedAddress(hostname: string) {
  if (!hostname.startsWith('::ffff:')) return null
  const tail = hostname.slice('::ffff:'.length)
  if (tail.includes('.')) return tail

  const groups = tail.split(':')
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  const high = Number.parseInt(groups[0]!, 16)
  const low = Number.parseInt(groups[1]!, 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

function isRestrictedHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true
  if (isRestrictedIpv4(normalized)) return true
  const mappedIpv4 = ipv4MappedAddress(normalized)
  if (mappedIpv4 && isRestrictedIpv4(mappedIpv4)) return true
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true
  }
  return /^fe[89ab]/.test(normalized)
}

function assertEndpointAllowed(url: URL, policy: HorizonEndpointPolicy) {
  if (url.username || url.password) throw new Error(`Horizon URL must not contain credentials: ${url.toString()}`)
  const hostname = url.hostname.toLowerCase()
  if (isRestrictedHostname(hostname)) throw new Error(`Horizon host is not allowed: ${hostname}`)

  const deniedHosts = normalizeHostList(policy.deniedHosts)
  if (deniedHosts.has(hostname)) throw new Error(`Horizon host is denied by policy: ${hostname}`)
  const allowedHosts = normalizeHostList(policy.allowedHosts)
  if (allowedHosts.size > 0 && !allowedHosts.has(hostname)) {
    throw new Error(`Horizon host is not present in the allow list: ${hostname}`)
  }
}

export function parseHorizonHostList(rawValue: string | undefined) {
  return rawValue?.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean) ?? []
}

export function parseHorizonSources(
  rawValue: string | undefined,
  policy: HorizonEndpointPolicy = {},
): HorizonSource[] {
  if (!rawValue) return []

  const deduped = new Map<string, HorizonSource>()
  for (const entry of rawValue.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue

    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new Error(`Invalid Horizon URL: ${trimmed}`)
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Horizon URL must use http or https: ${trimmed}`)
    }
    assertEndpointAllowed(parsed, policy)

    parsed.hash = ''
    parsed.search = ''
    parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    const normalized = parsed.toString().replace(/\/$/, '')
    if (!deduped.has(normalized)) {
      deduped.set(normalized, { id: `horizon_${deduped.size + 1}`, url: normalized })
    }
  }

  if (deduped.size > MAX_HORIZON_SOURCES) {
    throw new Error(`STELLAR_HORIZON_URLS supports at most ${MAX_HORIZON_SOURCES} sources`)
  }
  return Array.from(deduped.values())
}

function assertFetchOptions({ sources, timeoutMs, maxResponseBytes, endpointPolicy }: {
  sources: readonly HorizonSource[]
  timeoutMs: number
  maxResponseBytes: number
  endpointPolicy: HorizonEndpointPolicy
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be greater than zero')
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error('maxResponseBytes must be a positive safe integer')
  }
  const sourceIds = new Set<string>()
  const sourceUrls = new Set<string>()
  if (sources.length > MAX_HORIZON_SOURCES) throw new Error(`at most ${MAX_HORIZON_SOURCES} Horizon sources are supported`)
  for (const source of sources) {
    let url: URL
    try {
      url = new URL(source.url)
    } catch {
      throw new Error(`Invalid Horizon URL: ${source.url}`)
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Horizon URL must use http or https: ${source.url}`)
    }
    assertEndpointAllowed(url, endpointPolicy)
    if (sourceIds.has(source.id)) throw new Error(`duplicate Horizon source ID: ${source.id}`)
    if (sourceUrls.has(source.url)) throw new Error(`duplicate Horizon source URL: ${source.url}`)
    sourceIds.add(source.id)
    sourceUrls.add(source.url)
  }
}

function sourceError({
  source,
  code,
  message,
  retrievedAt,
  status,
  retryAfterMs,
}: {
  source: HorizonSource
  code: string
  message: string
  retrievedAt: string
  status?: number
  retryAfterMs?: number
}): LatestLedgerSourceError {
  return { sourceId: source.id, sourceUrl: source.url, code, message, retrievedAt, status, retryAfterMs }
}

export function parseRetryAfter(value: string | null, now: string) {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1_000
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
  }
  const target = Date.parse(trimmed)
  const baseline = Date.parse(now)
  return Number.isFinite(target) && Number.isFinite(baseline) ? Math.max(0, target - baseline) : undefined
}

class ResponseTooLargeError extends Error {}

async function readBoundedJson(response: Response, maxResponseBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new ResponseTooLargeError(`response exceeded ${maxResponseBytes} bytes`)
  }
  if (!response.body) return JSON.parse(await response.text()) as unknown

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > maxResponseBytes) {
        await reader.cancel()
        throw new ResponseTooLargeError(`response exceeded ${maxResponseBytes} bytes`)
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text) as unknown
  } finally {
    reader.releaseLock()
  }
}

function responseFailure(source: HorizonSource, response: Response, retrievedAt: string, endpoint: string) {
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    return sourceError({
      source,
      code: 'redirect_rejected',
      message: `${endpoint} redirected outside the configured endpoint`,
      retrievedAt,
      status: response.status,
    })
  }
  if (!response.ok) {
    return sourceError({
      source,
      code: 'non_200_response',
      message: `${endpoint} returned HTTP ${response.status}`,
      retrievedAt,
      status: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), retrievedAt),
    })
  }
  return null
}

async function fetchHorizonRootMetadata(
  source: HorizonSource,
  { fetchImpl, timeoutMs, maxResponseBytes, retrievedAt, signal }: {
    fetchImpl: FetchLike
    timeoutMs: number
    maxResponseBytes: number
    retrievedAt: string
    signal?: AbortSignal
  },
): Promise<{ networkPassphrase?: string; sourceError?: LatestLedgerSourceError }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(`${source.url}/`, {
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'error',
    })
    const failure = responseFailure(source, response, retrievedAt, 'Horizon root endpoint')
    if (failure) return { sourceError: failure }

    try {
      const payload = horizonRootPayloadSchema.parse(await readBoundedJson(response, maxResponseBytes))
      return { networkPassphrase: payload.network_passphrase }
    } catch (error) {
      return {
        sourceError: sourceError({
          source,
          code: error instanceof ResponseTooLargeError ? 'response_too_large' : 'malformed_payload',
          message:
            error instanceof ResponseTooLargeError
              ? `Horizon root response exceeded ${maxResponseBytes} bytes`
              : 'Horizon root response did not match the expected schema',
          retrievedAt,
        }),
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error
    const isAbort = error instanceof Error && error.name === 'AbortError'
    return {
      sourceError: sourceError({
        source,
        code: isAbort ? 'request_aborted' : 'request_failed',
        message: isAbort ? `Horizon request exceeded ${timeoutMs}ms` : 'Horizon request failed',
        retrievedAt,
      }),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchHorizonLatestLedger(
  source: HorizonSource,
  { fetchImpl, timeoutMs, maxResponseBytes, retrievedAt, signal }: {
    fetchImpl: FetchLike
    timeoutMs: number
    maxResponseBytes: number
    retrievedAt: string
    signal?: AbortSignal
  },
): Promise<{ observation?: LatestLedgerObservation; sourceError?: LatestLedgerSourceError }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(`${source.url}/ledgers?order=desc&limit=1`, {
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'error',
    })
    const failure = responseFailure(source, response, retrievedAt, 'Horizon ledger endpoint')
    if (failure) return { sourceError: failure }

    let payload: z.infer<typeof horizonLedgerPayloadSchema>
    try {
      payload = horizonLedgerPayloadSchema.parse(await readBoundedJson(response, maxResponseBytes))
    } catch (error) {
      return {
        sourceError: sourceError({
          source,
          code: error instanceof ResponseTooLargeError ? 'response_too_large' : 'malformed_payload',
          message:
            error instanceof ResponseTooLargeError
              ? `Horizon ledger response exceeded ${maxResponseBytes} bytes`
              : 'Horizon response did not match the expected latest-ledger schema',
          retrievedAt,
        }),
      }
    }

    const record = payload._embedded.records[0]
    if (!record) {
      return {
        sourceError: sourceError({
          source,
          code: 'empty_ledger_records',
          message: 'Horizon response did not include a latest ledger record',
          retrievedAt,
        }),
      }
    }
    const numericSequence = typeof record.sequence === 'string' ? Number(record.sequence) : record.sequence
    const closedAtMs = Date.parse(record.closed_at)
    if (!Number.isSafeInteger(numericSequence) || numericSequence <= 0 || !Number.isFinite(closedAtMs)) {
      return {
        sourceError: sourceError({
          source,
          code: 'malformed_payload',
          message: 'Horizon latest ledger record contained an invalid sequence or closed_at',
          retrievedAt,
        }),
      }
    }

    return {
      observation: {
        sourceId: source.id,
        sourceUrl: source.url,
        ledgerSequence: numericSequence,
        closedAt: new Date(closedAtMs).toISOString(),
        retrievedAt,
        rawPayload: record,
      },
    }
  } catch (error) {
    if (signal?.aborted) throw error
    const isAbort = error instanceof Error && error.name === 'AbortError'
    return {
      sourceError: sourceError({
        source,
        code: isAbort ? 'request_aborted' : 'request_failed',
        message: isAbort ? `Horizon request exceeded ${timeoutMs}ms` : 'Horizon request failed',
        retrievedAt,
      }),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchLatestLedgersFromHorizonSources({
  sources,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_HORIZON_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_HORIZON_MAX_RESPONSE_BYTES,
  expectedNetworkPassphrase = PUBLIC_NETWORK_PASSPHRASE,
  clock = () => new Date(),
  signal,
  endpointPolicy = {},
}: {
  sources: HorizonSource[]
  fetchImpl?: FetchLike
  timeoutMs?: number
  maxResponseBytes?: number
  expectedNetworkPassphrase?: string
  clock?: () => Date
  signal?: AbortSignal
  endpointPolicy?: HorizonEndpointPolicy
}): Promise<HorizonLatestLedgerFetchResult> {
  assertFetchOptions({ sources, timeoutMs, maxResponseBytes, endpointPolicy })
  if (!expectedNetworkPassphrase.trim()) throw new Error('expectedNetworkPassphrase must not be empty')
  const now = clock()
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('clock must return a valid Date')
  const retrievedAt = now.toISOString()
  if (signal?.aborted) throw signal.reason
  const requestOptions = { fetchImpl, timeoutMs, maxResponseBytes, retrievedAt, signal }
  const rootMetadataResults = await Promise.all(
    sources.map((source) => fetchHorizonRootMetadata(source, requestOptions)),
  )

  const sourceErrors: LatestLedgerSourceError[] = []
  const eligibleSources: HorizonSource[] = []
  for (const [index, result] of rootMetadataResults.entries()) {
    const source = sources[index]
    if (!source) continue
    if (result.sourceError) {
      sourceErrors.push(result.sourceError)
    } else if (result.networkPassphrase === expectedNetworkPassphrase) {
      eligibleSources.push(source)
    } else {
      sourceErrors.push(
        sourceError({
          source,
          code: 'network_mismatch',
          message: 'Horizon network passphrase did not match the configured network',
          retrievedAt,
        }),
      )
    }
  }

  const ledgerResults = await Promise.all(
    eligibleSources.map((source) => fetchHorizonLatestLedger(source, requestOptions)),
  )
  const observations = ledgerResults.flatMap((result) => (result.observation ? [result.observation] : []))
  const ledgerErrors = ledgerResults.flatMap((result) => (result.sourceError ? [result.sourceError] : []))
  const completedAtValue = clock()
  if (!(completedAtValue instanceof Date) || !Number.isFinite(completedAtValue.getTime())) {
    throw new Error('clock must return a valid Date')
  }
  const completedAt = completedAtValue.toISOString()

  return {
    observations: observations.map((observation) => ({ ...observation, retrievedAt: completedAt })),
    source_errors: [...sourceErrors, ...ledgerErrors].map((error) => ({ ...error, retrievedAt: completedAt })),
    sources_configured: sources.length,
    sources_excluded: sourceErrors.filter((error) => error.code === 'network_mismatch').length,
    retrieved_at: completedAt,
    network_passphrase: expectedNetworkPassphrase,
  }
}
