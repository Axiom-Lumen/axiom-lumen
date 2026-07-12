import type { LatestLedgerObservation, LatestLedgerSourceError } from '../reconcile/latest-ledger'

export const MAX_HORIZON_SOURCES = 10
export const DEFAULT_HORIZON_TIMEOUT_MS = 5000

export interface HorizonSource {
  id: string
  url: string
}

export interface HorizonLatestLedgerFetchResult {
  observations: LatestLedgerObservation[]
  source_errors: LatestLedgerSourceError[]
  sources_configured: number
  retrieved_at: string
}

type FetchLike = typeof fetch

interface HorizonLedgerRecord {
  sequence?: unknown
  closed_at?: unknown
}

interface HorizonLedgerPayload {
  _embedded?: {
    records?: HorizonLedgerRecord[]
  }
}

export function parseHorizonSources(rawValue: string | undefined): HorizonSource[] {
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

    parsed.hash = ''
    parsed.search = ''
    parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    const normalized = parsed.toString().replace(/\/$/, '')
    if (!deduped.has(normalized)) {
      deduped.set(normalized, {
        id: `horizon_${deduped.size + 1}`,
        url: normalized,
      })
    }
  }

  if (deduped.size > MAX_HORIZON_SOURCES) {
    throw new Error(`STELLAR_HORIZON_URLS supports at most ${MAX_HORIZON_SOURCES} sources`)
  }

  return Array.from(deduped.values())
}

function sourceError({
  source,
  code,
  message,
  retrievedAt,
  status,
}: {
  source: HorizonSource
  code: string
  message: string
  retrievedAt: string
  status?: number
}): LatestLedgerSourceError {
  return {
    sourceId: source.id,
    sourceUrl: source.url,
    code,
    message,
    retrievedAt,
    status,
  }
}

function parseLedgerRecord(payload: HorizonLedgerPayload): HorizonLedgerRecord | null {
  const records = payload._embedded?.records
  if (!Array.isArray(records) || records.length === 0) return null
  return records[0] ?? null
}

function parseLedgerSequence(value: unknown): number | null {
  const numericValue = typeof value === 'string' ? Number(value) : value
  if (!Number.isSafeInteger(numericValue) || Number(numericValue) <= 0) return null
  return Number(numericValue)
}

function parseClosedAt(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp).toISOString()
}

async function fetchHorizonLatestLedger(
  source: HorizonSource,
  {
    fetchImpl,
    timeoutMs,
  }: {
    fetchImpl: FetchLike
    timeoutMs: number
  },
): Promise<{ observation?: LatestLedgerObservation; sourceError?: LatestLedgerSourceError }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(`${source.url}/ledgers?order=desc&limit=1`, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
      },
    })
    const retrievedAt = new Date().toISOString()

    if (!response.ok) {
      return {
        sourceError: sourceError({
          source,
          code: 'non_200_response',
          message: `Horizon returned HTTP ${response.status}`,
          retrievedAt,
          status: response.status,
        }),
      }
    }

    let payload: HorizonLedgerPayload
    try {
      payload = (await response.json()) as HorizonLedgerPayload
    } catch {
      return {
        sourceError: sourceError({
          source,
          code: 'malformed_payload',
          message: 'Horizon response was not valid JSON',
          retrievedAt,
        }),
      }
    }

    const record = parseLedgerRecord(payload)
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

    const ledgerSequence = parseLedgerSequence(record.sequence)
    const closedAt = parseClosedAt(record.closed_at)
    if (ledgerSequence === null || closedAt === null) {
      return {
        sourceError: sourceError({
          source,
          code: 'malformed_payload',
          message: 'Horizon latest ledger record was missing a valid sequence or closed_at',
          retrievedAt,
        }),
      }
    }

    return {
      observation: {
        sourceId: source.id,
        sourceUrl: source.url,
        ledgerSequence,
        closedAt,
        retrievedAt,
      },
    }
  } catch (error) {
    const retrievedAt = new Date().toISOString()
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
}: {
  sources: HorizonSource[]
  fetchImpl?: FetchLike
  timeoutMs?: number
}): Promise<HorizonLatestLedgerFetchResult> {
  const results = await Promise.all(
    sources.map((source) => fetchHorizonLatestLedger(source, { fetchImpl, timeoutMs })),
  )
  const observations = results
    .map((result) => result.observation)
    .filter((observation): observation is LatestLedgerObservation => Boolean(observation))
  const source_errors = results
    .map((result) => result.sourceError)
    .filter((error): error is LatestLedgerSourceError => Boolean(error))

  return {
    observations,
    source_errors,
    sources_configured: sources.length,
    retrieved_at: new Date().toISOString(),
  }
}
