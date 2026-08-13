import { createHash, randomBytes } from 'node:crypto'

export type TelemetryLevel = 'info' | 'warn' | 'error'
export type TelemetryContext = Readonly<Record<string, unknown>>

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token|api[-_]?key|database[-_]?url)/i
const SENSITIVE_QUERY_KEY = /(?:access|auth|credential|key|password|secret|signature|token)/i
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const URL_VALUE = /(?:https?|postgres(?:ql)?):\/\/[^\s"'<>]+/gi

function redactOneUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.username) url.username = '[REDACTED]'
    if (url.password) url.password = '[REDACTED]'
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, '[REDACTED]')
    }
    return url.toString()
  } catch {
    return '[REDACTED_INVALID_URL]'
  }
}

function redactUrls(value: string) {
  return value.replace(URL_VALUE, (url) => redactOneUrl(url))
}

export function redactTelemetryValue(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactUrls(value)
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : '[INVALID_DATE]'
  if (value instanceof Error) {
    return {
      error_type: value.name || 'Error',
      ...(('code' in value && typeof value.code === 'string') ? { error_code: value.code } : {}),
    }
  }
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactTelemetryValue(item, '', seen))
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactTelemetryValue(entryValue, entryKey, seen)]),
  )
}

export function structuredLog(
  level: TelemetryLevel,
  event: string,
  context: TelemetryContext = {},
  options: { clock?: () => Date; write?: (line: string) => void } = {},
) {
  const timestamp = (options.clock ?? (() => new Date()))()
  if (!Number.isFinite(timestamp.getTime())) throw new Error('telemetry clock must return a valid Date')
  const payload = redactTelemetryValue({
    timestamp: timestamp.toISOString(),
    level,
    event,
    ...context,
  })
  const line = JSON.stringify(payload)
  const write = options.write ?? ((output: string) => {
    if (process.env.NODE_ENV === 'test') return
    const target = level === 'error' ? process.stderr : process.stdout
    target.write(`${output}\n`)
  })
  write(line)
  return line
}

export interface TraceContext {
  traceId: string
  spanId: string
  traceparent: string
}

export function resolveTraceContext(value: string | null, random = randomBytes): TraceContext {
  const match = value?.toLowerCase().match(TRACEPARENT)
  const inherited = match && match[1] !== '0'.repeat(32) && match[2] !== '0'.repeat(16) ? match[1] : undefined
  const traceId = inherited ?? random(16).toString('hex')
  const spanId = random(8).toString('hex')
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` }
}

export function traceIdForCycle(cycleId: string) {
  return createHash('sha256').update(`axiom-lumen:cycle:${cycleId}`).digest('hex').slice(0, 32)
}

export function errorTelemetry(error: unknown) {
  if (!(error instanceof Error)) return { error_type: 'UnknownError' }
  return {
    error_type: error.name || 'Error',
    ...(('code' in error && typeof error.code === 'string') ? { error_code: error.code } : {}),
  }
}
