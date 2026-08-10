export interface RetryableSourceError {
  code: string
  status?: number
  retryAfterMs?: number
}

export interface SourceResiliencePolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  jitterRatio: number
  concurrency: number
  circuitFailureThreshold: number
  circuitCooldownMs: number
}

export interface SourceHealthProjection {
  sourceId: string
  state: 'healthy' | 'unreachable' | 'rejected' | 'malformed' | 'stale' | 'network_mismatched'
  consecutiveFailures: number
  circuitState: 'closed' | 'open'
  circuitOpenedAt: string | null
  nextAttemptAt: string | null
  lastErrorCode: string | null
  lastObservedAt: string
}

export interface SourceOperationResult<T, TError extends RetryableSourceError> {
  value?: T
  error?: TError
}

export function assertSourceResiliencePolicy(policy: SourceResiliencePolicy) {
  for (const [name, value] of Object.entries({
    maxAttempts: policy.maxAttempts,
    baseDelayMs: policy.baseDelayMs,
    maxDelayMs: policy.maxDelayMs,
    concurrency: policy.concurrency,
    circuitFailureThreshold: policy.circuitFailureThreshold,
    circuitCooldownMs: policy.circuitCooldownMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
  }
  if (policy.maxDelayMs < policy.baseDelayMs) throw new Error('maxDelayMs must be at least baseDelayMs')
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new Error('jitterRatio must be between zero and one')
  }
}

export function classifySourceFailure(error: RetryableSourceError) {
  if (error.code === 'request_failed' || error.code === 'request_aborted') return 'transient' as const
  if (error.code === 'non_200_response') {
    const status = error.status ?? 0
    return status === 408 || status === 425 || status === 429 || status >= 500
      ? ('transient' as const)
      : ('permanent' as const)
  }
  return 'permanent' as const
}

export function retryDelayMs({
  failedAttempt,
  error,
  policy,
  random,
}: {
  failedAttempt: number
  error: RetryableSourceError
  policy: SourceResiliencePolicy
  random: () => number
}) {
  assertSourceResiliencePolicy(policy)
  const sample = random()
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new Error('random must return a value from zero to one')
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1))
  const jittered = Math.round(exponential * (1 - policy.jitterRatio + 2 * policy.jitterRatio * sample))
  return Math.min(
    policy.maxDelayMs,
    Math.max(0, jittered, Math.min(policy.maxDelayMs, error.retryAfterMs ?? 0)),
  )
}

function abortError() {
  return new DOMException('Source operation was cancelled', 'AbortError')
}

export async function abortableSleep(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout)
      reject(abortError())
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function executeWithRetry<T, TError extends RetryableSourceError>({
  operation,
  policy,
  signal,
  random = Math.random,
  sleep = abortableSleep,
}: {
  operation: (attemptNumber: number) => Promise<SourceOperationResult<T, TError>>
  policy: SourceResiliencePolicy
  signal: AbortSignal
  random?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}) {
  assertSourceResiliencePolicy(policy)
  const attempts: SourceOperationResult<T, TError>[] = []
  for (let attemptNumber = 1; attemptNumber <= policy.maxAttempts; attemptNumber += 1) {
    if (signal.aborted) throw abortError()
    const result = await operation(attemptNumber)
    if ((result.value === undefined) === (result.error === undefined)) {
      throw new Error('source operation must return exactly one value or error')
    }
    attempts.push(result)
    if (result.value !== undefined || !result.error || classifySourceFailure(result.error) === 'permanent') {
      return { attempts, result }
    }
    if (attemptNumber < policy.maxAttempts) {
      await sleep(retryDelayMs({ failedAttempt: attemptNumber, error: result.error, policy, random }), signal)
    }
  }
  return { attempts, result: attempts.at(-1)! }
}

export function sourceHealthState(error: RetryableSourceError | undefined): SourceHealthProjection['state'] {
  if (!error) return 'healthy'
  if (error.code === 'network_mismatch') return 'network_mismatched'
  if ([
    'malformed_payload',
    'empty_ledger_records',
    'empty_records',
    'response_too_large',
    'checkpoint_mismatch',
    'artifact_integrity_mismatch',
    'total_mismatch',
  ].includes(error.code)) {
    return 'malformed'
  }
  if (error.code === 'stale_observation') return 'stale'
  if (
    ['redirect_rejected', 'invalid_configuration', 'excluded_source'].includes(error.code) ||
    (error.code === 'non_200_response' &&
      (error.status ?? 500) < 500 &&
      ![408, 425, 429].includes(error.status ?? 0))
  ) {
    return 'rejected'
  }
  return 'unreachable'
}

export function sourceCanAttempt(projection: SourceHealthProjection | undefined, now: string) {
  return !projection?.nextAttemptAt || Date.parse(projection.nextAttemptAt) <= Date.parse(now)
}

export function transitionSourceHealth({
  sourceId,
  previous,
  error,
  observedAt,
  policy,
}: {
  sourceId: string
  previous?: SourceHealthProjection
  error?: RetryableSourceError
  observedAt: string
  policy: SourceResiliencePolicy
}): SourceHealthProjection {
  assertSourceResiliencePolicy(policy)
  if (!error) {
    return {
      sourceId,
      state: 'healthy',
      consecutiveFailures: 0,
      circuitState: 'closed',
      circuitOpenedAt: null,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastObservedAt: observedAt,
    }
  }

  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1
  const transient = classifySourceFailure(error) === 'transient'
  const opensCircuit = transient && (previous?.circuitState === 'open' || consecutiveFailures >= policy.circuitFailureThreshold)
  const retryAfterAt = error.retryAfterMs
    ? new Date(Date.parse(observedAt) + error.retryAfterMs).toISOString()
    : null
  const circuitUntil = opensCircuit
    ? new Date(Date.parse(observedAt) + policy.circuitCooldownMs).toISOString()
    : null
  const nextAttemptAt = [retryAfterAt, circuitUntil]
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null
  return {
    sourceId,
    state: sourceHealthState(error),
    consecutiveFailures,
    circuitState: opensCircuit ? 'open' : 'closed',
    circuitOpenedAt: opensCircuit ? previous?.circuitOpenedAt ?? observedAt : null,
    nextAttemptAt,
    lastErrorCode: error.code,
    lastObservedAt: observedAt,
  }
}

export async function mapWithConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<TResult>,
) {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new Error('concurrency must be a positive safe integer')
  const results = new Array<TResult>(values.length)
  let nextIndex = 0
  async function consume() {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await mapper(values[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => consume()))
  return results
}
