import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseLastEventId,
  parseSnapshotEventStreamConfig,
  type SnapshotEventRecord,
  type SnapshotEventStreamConfig,
} from '../../lib/db/snapshot-event-repository'
import { createSnapshotEventStream, encodeSnapshotEvent } from '../../lib/http/sse'

const config: SnapshotEventStreamConfig = {
  replayLimit: 10,
  pollIntervalMs: 100,
  heartbeatIntervalMs: 1_000,
  reauthorizeIntervalMs: 100,
  maxBackpressurePolls: 3,
}

function event(id: string): SnapshotEventRecord {
  return {
    id,
    occurredAt: '2026-08-13T10:00:00.000Z',
    payload: {
      snapshot_id: `snapshot_${id}`,
      metric: 'latest_ledger',
      subject: { kind: 'network', network: 'public' },
      status: 'verified',
      as_of: '2026-08-13T10:00:00.000Z',
      methodology_version: 'latest-ledger-v0.2',
      resource: '/api/v1/stellar/latest-ledger',
    },
  }
}

async function text(result: ReadableStreamReadResult<Uint8Array>) {
  return result.value ? new TextDecoder().decode(result.value) : ''
}

describe('snapshot SSE runtime', () => {
  afterEach(() => vi.useRealTimers())

  it('encodes replayable snapshot records with their durable event ID', () => {
    expect(encodeSnapshotEvent(event('42'))).toBe(
      `id: 42\nevent: snapshot\ndata: ${JSON.stringify(event('42').payload)}\n\n`,
    )
  })

  it('validates resume cursors and bounded operational configuration', () => {
    expect(parseLastEventId(null)).toBeNull()
    expect(parseLastEventId('0')).toBe(0n)
    expect(parseLastEventId('42')).toBe(42n)
    expect(() => parseLastEventId('-1')).toThrow(/non-negative decimal/)
    expect(() => parseLastEventId('9223372036854775808')).toThrow(/supported event ID range/)
    expect(parseSnapshotEventStreamConfig({ EVT_SSE_REPLAY_LIMIT: '25' })).toMatchObject({ replayLimit: 25 })
    expect(() => parseSnapshotEventStreamConfig({ EVT_SSE_REPLAY_LIMIT: '1001' })).toThrow(/1 through 1000/)
  })

  it('polls after the replay cursor without duplicating the initial event', async () => {
    vi.useFakeTimers()
    const source = { readAfter: vi.fn(async () => [event('3')]) }
    const stream = createSnapshotEventStream({ source, initialCursor: 1n, initialEvents: [event('2')], config })
    const reader = stream.getReader()
    expect(await text(await reader.read())).toContain('retry: 100')
    expect(await text(await reader.read())).toContain('id: 2')
    await vi.advanceTimersByTimeAsync(100)
    expect(await text(await reader.read())).toContain('id: 3')
    expect(source.readAfter).toHaveBeenCalledWith(2n, 10)
    await reader.cancel()
  })

  it.each([
    { status: 'unauthorized' as const },
    { status: 'rate_limited' as const, quotaKind: 'sustained' as const, limit: 1, remaining: 0 as const, resetAt: '2026-08-13T10:01:00.000Z', retryAfterSeconds: 10 },
  ])('terminates a live stream when recurring access is lost: $status', async (decision) => {
    vi.useFakeTimers()
    let now = 0
    const authorize = vi.fn(async () => decision)
    const stream = createSnapshotEventStream({
      source: { readAfter: vi.fn(async () => []) },
      initialCursor: 0n,
      initialEvents: [],
      config,
      authorize,
      clock: () => now,
    })
    const reader = stream.getReader()
    await reader.read()
    now = 100
    await vi.advanceTimersByTimeAsync(100)
    expect(await text(await reader.read())).toContain('stream_access_revoked')
    expect((await reader.read()).done).toBe(true)
    expect(authorize).toHaveBeenCalledOnce()
  })

  it('reauthorizes and closes a stream even while its response queue is backpressured', async () => {
    vi.useFakeTimers()
    let now = 0
    const authorize = vi.fn(async () => ({ status: 'unauthorized' as const }))
    const stream = createSnapshotEventStream({
      source: { readAfter: vi.fn(async () => []) },
      initialCursor: 0n,
      initialEvents: [],
      config,
      authorize,
      clock: () => now,
    })

    now = 100
    await vi.advanceTimersByTimeAsync(100)
    const reader = stream.getReader()
    expect(await text(await reader.read())).toContain('retry: 100')
    expect(await text(await reader.read())).toContain('stream_access_revoked')
    expect((await reader.read()).done).toBe(true)
    expect(authorize).toHaveBeenCalledOnce()
  })

  it('emits heartbeat comments without advancing the durable event cursor', async () => {
    vi.useFakeTimers()
    let now = 0
    const source = { readAfter: vi.fn(async () => []) }
    const stream = createSnapshotEventStream({
      source,
      initialCursor: 42n,
      initialEvents: [],
      config,
      clock: () => now,
    })
    const reader = stream.getReader()
    await reader.read()

    now = 1_000
    await vi.advanceTimersByTimeAsync(100)
    const heartbeat = await text(await reader.read())
    expect(heartbeat).toBe(': heartbeat 1970-01-01T00:00:01.000Z\n\n')
    expect(heartbeat).not.toContain('id:')
    expect(source.readAfter).toHaveBeenCalledWith(42n, 10)
    await reader.cancel()
  })

  it('does not enqueue an entire initial replay for a consumer that never pulls', async () => {
    vi.useFakeTimers()
    const stream = createSnapshotEventStream({
      source: { readAfter: vi.fn(async () => []) },
      initialCursor: 0n,
      initialEvents: [event('1'), event('2'), event('3')],
      config,
    })

    await vi.advanceTimersByTimeAsync(300)
    const reader = stream.getReader()
    expect(await text(await reader.read())).toContain('retry: 100')
    expect((await reader.read()).done).toBe(true)
  })

  it('stops enqueueing a polled batch when the response queue applies backpressure', async () => {
    vi.useFakeTimers()
    const source = { readAfter: vi.fn(async () => [event('1'), event('2'), event('3')]) }
    const stream = createSnapshotEventStream({
      source,
      initialCursor: 0n,
      initialEvents: [],
      config,
    })
    const reader = stream.getReader()
    await reader.read()

    await vi.advanceTimersByTimeAsync(400)
    expect(await text(await reader.read())).toContain('id: 1')
    expect((await reader.read()).done).toBe(true)
    expect(source.readAfter).toHaveBeenCalledOnce()
  })

  it('closes instead of growing an unbounded queue for a slow consumer', async () => {
    vi.useFakeTimers()
    const stream = createSnapshotEventStream({
      source: { readAfter: vi.fn(async () => []) },
      initialCursor: 0n,
      initialEvents: [],
      config,
    })
    await vi.advanceTimersByTimeAsync(300)
    const reader = stream.getReader()
    expect(await text(await reader.read())).toContain('retry: 100')
    expect((await reader.read()).done).toBe(true)
  })
})
