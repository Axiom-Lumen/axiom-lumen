import { describe, expect, it } from 'vitest'
import { parseSourceResilienceConfig, parseWorkerConfig } from '../../lib/worker/config'
import { serializeWorkerError } from '../../lib/worker/errors'

describe('worker configuration', () => {
  it('parses explicit bounded worker settings', () => {
    expect(parseWorkerConfig({
      WORKER_ID: ' worker-a ',
      INGEST_INTERVAL_SECONDS: '120',
      WORKER_CONCURRENCY: '2',
      WORKER_LEASE_DURATION_MS: '45000',
      WORKER_MAX_ATTEMPTS: '5',
      WORKER_POLL_INTERVAL_MS: '1000',
    })).toEqual({
      workerId: 'worker-a',
      intervalSeconds: 120,
      concurrency: 2,
      leaseDurationMs: 45000,
      maxAttempts: 5,
      pollIntervalMs: 1000,
    })
  })

  it('rejects invalid positive integer settings without exposing unrelated environment values', () => {
    expect(() => parseWorkerConfig({ WORKER_CONCURRENCY: '0', SECRET: 'do-not-log' })).toThrow(
      'WORKER_CONCURRENCY must be a positive integer',
    )
  })

  it('parses source retry, circuit, concurrency, and connector limits', () => {
    expect(parseSourceResilienceConfig({
      SOURCE_RETRY_MAX_ATTEMPTS: '4',
      SOURCE_RETRY_BASE_DELAY_MS: '100',
      SOURCE_RETRY_MAX_DELAY_MS: '2000',
      SOURCE_RETRY_JITTER_RATIO: '0.1',
      SOURCE_CONCURRENCY: '2',
      SOURCE_CIRCUIT_FAILURE_THRESHOLD: '5',
      SOURCE_CIRCUIT_COOLDOWN_MS: '30000',
      HORIZON_TIMEOUT_MS: '4000',
      HORIZON_MAX_RESPONSE_BYTES: '500000',
    })).toEqual({
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 2000,
      jitterRatio: 0.1,
      concurrency: 2,
      circuitFailureThreshold: 5,
      circuitCooldownMs: 30000,
      timeoutMs: 4000,
      maxResponseBytes: 500000,
    })
  })

  it('rejects a retry ceiling below the initial backoff', () => {
    expect(() => parseSourceResilienceConfig({
      SOURCE_RETRY_BASE_DELAY_MS: '500',
      SOURCE_RETRY_MAX_DELAY_MS: '100',
    })).toThrow('maxDelayMs must be at least baseDelayMs')
  })
})

describe('worker error serialization', () => {
  it('redacts URL credentials and secret assignments', () => {
    expect(serializeWorkerError(new Error(
      'connect postgres://runtime:super-secret@db.example/axiom password=also-secret api_key=third-secret',
    ))).toEqual({
      name: 'Error',
      message: 'connect postgres://[REDACTED]@db.example/axiom password=[REDACTED] api_key=[REDACTED]',
    })
  })
})
