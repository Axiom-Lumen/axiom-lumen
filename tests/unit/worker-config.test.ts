import { describe, expect, it } from 'vitest'
import { parseWorkerConfig } from '../../lib/worker/config'
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
