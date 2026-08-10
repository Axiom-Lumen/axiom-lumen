import { hostname } from 'node:os'
import type { SchedulerOptions } from './scheduler'

function positiveInteger(name: string, value: string | undefined, fallback: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
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
