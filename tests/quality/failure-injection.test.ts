import { describe, expect, it, vi } from 'vitest'
import { executeWithRetry, transitionSourceHealth, type SourceResiliencePolicy } from '../../lib/worker/resilience'

const policy: SourceResiliencePolicy = {
  maxAttempts: 3,
  baseDelayMs: 10,
  maxDelayMs: 100,
  jitterRatio: 0,
  concurrency: 2,
  circuitFailureThreshold: 2,
  circuitCooldownMs: 60_000,
}

describe('deterministic failure injection', () => {
  it('records every timeout attempt and stops at the retry budget', async () => {
    const operation = vi.fn(async () => ({ error: { code: 'request_aborted' } }))
    const sleep = vi.fn(async () => undefined)
    const result = await executeWithRetry({
      operation,
      policy,
      signal: new AbortController().signal,
      random: () => 0.5,
      sleep,
    })

    expect(operation).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(result.attempts).toHaveLength(3)
    expect(result.result).toEqual({ error: { code: 'request_aborted' } })
  })

  it('aborts before duplicate delivery when cancellation occurs during backoff', async () => {
    const controller = new AbortController()
    const operation = vi.fn(async () => ({ error: { code: 'request_failed' } }))
    const sleep = vi.fn(async () => {
      controller.abort()
    })

    await expect(executeWithRetry({
      operation,
      policy,
      signal: controller.signal,
      random: () => 0.5,
      sleep,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(operation).toHaveBeenCalledOnce()
  })

  it('does not let backward clock skew regress newer durable health state', () => {
    const previous = {
      sourceId: 'source-a' as const, state: 'unreachable' as const, consecutiveFailures: 1, circuitState: 'closed' as const,
      circuitOpenedAt: null, nextAttemptAt: null, lastErrorCode: 'request_failed',
      lastObservedAt: '2026-08-13T10:00:10.000Z',
    }
    const ignored = transitionSourceHealth({
      sourceId: 'source-a',
      previous,
      error: { code: 'request_failed' },
      observedAt: '2026-08-13T10:00:00.000Z',
      policy,
    })

    expect(ignored).toEqual(previous)
    const opened = transitionSourceHealth({
      sourceId: 'source-a', previous, error: { code: 'request_failed' },
      observedAt: '2026-08-13T10:00:20.000Z', policy,
    })
    expect(opened).toMatchObject({
      circuitState: 'open',
      circuitOpenedAt: '2026-08-13T10:00:20.000Z',
      nextAttemptAt: '2026-08-13T10:01:20.000Z',
      lastObservedAt: '2026-08-13T10:00:20.000Z',
    })
  })

  it('rejects invalid clock values and cross-source prior state', () => {
    expect(() => transitionSourceHealth({
      sourceId: 'source-a', error: { code: 'request_failed' }, observedAt: 'not-a-date', policy,
    })).toThrow(/observedAt/)
    expect(() => transitionSourceHealth({
      sourceId: 'source-a',
      previous: {
        sourceId: 'source-b', state: 'healthy', consecutiveFailures: 0, circuitState: 'closed',
        circuitOpenedAt: null, nextAttemptAt: null, lastErrorCode: null, lastObservedAt: '2026-08-13T10:00:00.000Z',
      },
      observedAt: '2026-08-13T10:00:01.000Z', policy,
    })).toThrow(/another source/)
  })
})
