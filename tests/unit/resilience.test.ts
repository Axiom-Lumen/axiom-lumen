import { describe, expect, it, vi } from 'vitest'
import {
  classifySourceFailure,
  executeWithRetry,
  mapWithConcurrency,
  retryDelayMs,
  sourceCanAttempt,
  sourceHealthState,
  transitionSourceHealth,
  type SourceResiliencePolicy,
} from '../../lib/worker/resilience'

const policy: SourceResiliencePolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  jitterRatio: 0.2,
  concurrency: 2,
  circuitFailureThreshold: 2,
  circuitCooldownMs: 10_000,
}

describe('source resilience', () => {
  it('retries only transient failures and respects Retry-After', async () => {
    const sleep = vi.fn(async () => undefined)
    const operation = vi.fn()
      .mockResolvedValueOnce({ error: { code: 'non_200_response', status: 429, retryAfterMs: 750 } })
      .mockResolvedValueOnce({ value: 123 })

    const result = await executeWithRetry({
      operation,
      policy,
      signal: new AbortController().signal,
      random: () => 0.5,
      sleep,
    })

    expect(result.result).toEqual({ value: 123 })
    expect(operation).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(750, expect.any(AbortSignal))
    expect(classifySourceFailure({ code: 'malformed_payload' })).toBe('permanent')
  })

  it('computes deterministic bounded exponential jitter', () => {
    expect(retryDelayMs({ failedAttempt: 1, error: { code: 'request_failed' }, policy, random: () => 0 })).toBe(80)
    expect(retryDelayMs({ failedAttempt: 2, error: { code: 'request_failed' }, policy, random: () => 1 })).toBe(240)
    expect(retryDelayMs({ failedAttempt: 8, error: { code: 'request_failed' }, policy, random: () => 0.5 })).toBe(1_000)
    expect(retryDelayMs({ failedAttempt: 8, error: { code: 'request_failed' }, policy, random: () => 1 })).toBe(1_000)
  })

  it.each([
    [undefined, 'healthy'],
    [{ code: 'request_failed' }, 'unreachable'],
    [{ code: 'non_200_response', status: 403 }, 'rejected'],
    [{ code: 'malformed_payload' }, 'malformed'],
    [{ code: 'stale_observation' }, 'stale'],
    [{ code: 'network_mismatch' }, 'network_mismatched'],
    [{ code: 'non_200_response', status: 425 }, 'unreachable'],
  ] as const)('maps %j to the persisted %s health state', (error, state) => {
    expect(sourceHealthState(error)).toBe(state)
  })

  it('opens and recovers a circuit from persisted health state', () => {
    const first = transitionSourceHealth({
      sourceId: 'source-a', error: { code: 'request_failed' }, observedAt: '2026-08-10T10:00:00.000Z', policy,
    })
    const opened = transitionSourceHealth({
      sourceId: 'source-a', previous: first, error: { code: 'request_failed' },
      observedAt: '2026-08-10T10:00:01.000Z', policy,
    })
    expect(opened).toMatchObject({ circuitState: 'open', consecutiveFailures: 2, state: 'unreachable' })
    expect(sourceCanAttempt(opened, '2026-08-10T10:00:05.000Z')).toBe(false)
    expect(sourceCanAttempt(opened, '2026-08-10T10:00:11.000Z')).toBe(true)
    expect(transitionSourceHealth({
      sourceId: 'source-a', previous: opened, observedAt: '2026-08-10T10:00:12.000Z', policy,
    })).toMatchObject({ circuitState: 'closed', consecutiveFailures: 0, state: 'healthy' })
  })

  it('bounds source concurrency', async () => {
    let active = 0
    let maximum = 0
    await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return value
    })
    expect(maximum).toBe(2)
  })
})
