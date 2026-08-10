import { hostname } from 'node:os'
import type { SchedulerOptions } from './scheduler'
import { assertSourceResiliencePolicy, type SourceResiliencePolicy } from './resilience'

function positiveInteger(name: string, value: string | undefined, fallback: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function boundedNumber(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  }
  return parsed
}

export function parseWorkerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SchedulerOptions {
  return {
    workerId: environment.WORKER_ID?.trim() || `${hostname()}:${process.pid}`,
    intervalSeconds: positiveInteger('INGEST_INTERVAL_SECONDS', environment.INGEST_INTERVAL_SECONDS, 60),
    concurrency: positiveInteger('WORKER_CONCURRENCY', environment.WORKER_CONCURRENCY, 4),
    leaseDurationMs: positiveInteger('WORKER_LEASE_DURATION_MS', environment.WORKER_LEASE_DURATION_MS, 30_000),
    maxAttempts: positiveInteger('WORKER_MAX_ATTEMPTS', environment.WORKER_MAX_ATTEMPTS, 3),
    pollIntervalMs: positiveInteger('WORKER_POLL_INTERVAL_MS', environment.WORKER_POLL_INTERVAL_MS, 5_000),
  }
}

export function parseSourceResilienceConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SourceResiliencePolicy & { timeoutMs: number; maxResponseBytes: number } {
  const config = {
    maxAttempts: positiveInteger('SOURCE_RETRY_MAX_ATTEMPTS', environment.SOURCE_RETRY_MAX_ATTEMPTS, 3),
    baseDelayMs: positiveInteger('SOURCE_RETRY_BASE_DELAY_MS', environment.SOURCE_RETRY_BASE_DELAY_MS, 250),
    maxDelayMs: positiveInteger('SOURCE_RETRY_MAX_DELAY_MS', environment.SOURCE_RETRY_MAX_DELAY_MS, 5_000),
    jitterRatio: boundedNumber('SOURCE_RETRY_JITTER_RATIO', environment.SOURCE_RETRY_JITTER_RATIO, 0.2, 0, 1),
    concurrency: positiveInteger('SOURCE_CONCURRENCY', environment.SOURCE_CONCURRENCY, 4),
    circuitFailureThreshold: positiveInteger(
      'SOURCE_CIRCUIT_FAILURE_THRESHOLD',
      environment.SOURCE_CIRCUIT_FAILURE_THRESHOLD,
      3,
    ),
    circuitCooldownMs: positiveInteger(
      'SOURCE_CIRCUIT_COOLDOWN_MS',
      environment.SOURCE_CIRCUIT_COOLDOWN_MS,
      60_000,
    ),
    timeoutMs: positiveInteger('HORIZON_TIMEOUT_MS', environment.HORIZON_TIMEOUT_MS, 5_000),
    maxResponseBytes: positiveInteger(
      'HORIZON_MAX_RESPONSE_BYTES',
      environment.HORIZON_MAX_RESPONSE_BYTES,
      1_000_000,
    ),
  }
  const { timeoutMs: _timeoutMs, maxResponseBytes: _maxResponseBytes, ...policy } = config
  assertSourceResiliencePolicy(policy)
  return config
}
