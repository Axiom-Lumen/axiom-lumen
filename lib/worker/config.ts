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

export interface AnchorWorkflowConfig {
  enabled: boolean
  concurrency: number
  claimLimit: number
  leaseDurationMs: number
  pollIntervalMs: number
  maximumAttempts: number
  retryBaseDelayMs: number
  retryMaximumDelayMs: number
  transportTimeoutMs: number
  maximumResponseBytes: number
  emailRelayUrl?: string
  emailRelayToken?: string
}

export function parseAnchorWorkflowConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AnchorWorkflowConfig {
  const enabled = environment.ANCHOR_WORKFLOW_ENABLED === 'true'
  if (environment.ANCHOR_WORKFLOW_ENABLED !== undefined && !['true', 'false'].includes(environment.ANCHOR_WORKFLOW_ENABLED)) {
    throw new Error('ANCHOR_WORKFLOW_ENABLED must be true or false')
  }
  const emailRelayUrl = environment.ANCHOR_EMAIL_RELAY_URL?.trim()
  const emailRelayToken = environment.ANCHOR_EMAIL_RELAY_TOKEN
  if ((emailRelayUrl && !emailRelayToken) || (!emailRelayUrl && emailRelayToken)) {
    throw new Error('ANCHOR_EMAIL_RELAY_URL and ANCHOR_EMAIL_RELAY_TOKEN must be configured together')
  }
  if (emailRelayUrl) {
    const url = new URL(emailRelayUrl)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('ANCHOR_EMAIL_RELAY_URL must be credential-free HTTPS')
  }
  const config: AnchorWorkflowConfig = {
    enabled,
    concurrency: positiveInteger('ANCHOR_NOTIFICATION_CONCURRENCY', environment.ANCHOR_NOTIFICATION_CONCURRENCY, 2),
    claimLimit: positiveInteger('ANCHOR_NOTIFICATION_CLAIM_LIMIT', environment.ANCHOR_NOTIFICATION_CLAIM_LIMIT, 10),
    leaseDurationMs: positiveInteger('ANCHOR_NOTIFICATION_LEASE_DURATION_MS', environment.ANCHOR_NOTIFICATION_LEASE_DURATION_MS, 30_000),
    pollIntervalMs: positiveInteger('ANCHOR_WORKFLOW_POLL_INTERVAL_MS', environment.ANCHOR_WORKFLOW_POLL_INTERVAL_MS, 5_000),
    maximumAttempts: positiveInteger('ANCHOR_NOTIFICATION_MAX_ATTEMPTS', environment.ANCHOR_NOTIFICATION_MAX_ATTEMPTS, 5),
    retryBaseDelayMs: positiveInteger('ANCHOR_NOTIFICATION_RETRY_BASE_DELAY_MS', environment.ANCHOR_NOTIFICATION_RETRY_BASE_DELAY_MS, 1_000),
    retryMaximumDelayMs: positiveInteger('ANCHOR_NOTIFICATION_RETRY_MAX_DELAY_MS', environment.ANCHOR_NOTIFICATION_RETRY_MAX_DELAY_MS, 300_000),
    transportTimeoutMs: positiveInteger('ANCHOR_NOTIFICATION_TIMEOUT_MS', environment.ANCHOR_NOTIFICATION_TIMEOUT_MS, 10_000),
    maximumResponseBytes: positiveInteger('ANCHOR_NOTIFICATION_MAX_RESPONSE_BYTES', environment.ANCHOR_NOTIFICATION_MAX_RESPONSE_BYTES, 64_000),
    ...(emailRelayUrl && emailRelayToken ? { emailRelayUrl, emailRelayToken } : {}),
  }
  if (config.claimLimit > 100) throw new Error('ANCHOR_NOTIFICATION_CLAIM_LIMIT must not exceed 100')
  if (config.retryMaximumDelayMs < config.retryBaseDelayMs) throw new Error('anchor notification retry maximum must not be below its base')
  return config
}
