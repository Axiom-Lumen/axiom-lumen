import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotEventRecord } from '../../lib/db/snapshot-event-repository'
import { expectOpenApiResponse } from '../helpers/openapi-response'

const access = vi.hoisted(() => ({ authorize: vi.fn() }))
const eventStore = vi.hoisted(() => ({ prepare: vi.fn(), readAfter: vi.fn() }))

vi.mock('../../lib/db/api-access-repository', () => ({ authorizePublicApiKey: access.authorize }))
vi.mock('../../lib/db/snapshot-event-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/db/snapshot-event-repository')>()),
  createWebSnapshotEventRepository: vi.fn(async () => eventStore),
}))

import { GET, OPTIONS } from '../../app/api/v1/events/snapshots/route'
import { SnapshotReplayError } from '../../lib/db/snapshot-event-repository'

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

async function nextText(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read()
  return result.value ? new TextDecoder().decode(result.value) : ''
}

describe('snapshot event SSE route', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    access.authorize.mockReset()
    eventStore.prepare.mockReset()
    eventStore.readAfter.mockReset()
  })

  it('replays strictly after Last-Event-ID and resumes without a duplicate', async () => {
    vi.stubEnv('AXIOM_API_AUTH_REQUIRED', 'true')
    access.authorize.mockResolvedValue({
      status: 'allowed',
      grant: { principalId: 'client-a', planId: 'developer', routeId: 'events.snapshots', scopes: ['events:read'], limit: 60, remaining: 59, resetAt: '2026-08-13T10:01:00.000Z' },
    })
    eventStore.readAfter.mockResolvedValue([])
    eventStore.prepare
      .mockResolvedValueOnce({ cursor: 2n, events: [event('2')] })
      .mockResolvedValueOnce({ cursor: 3n, events: [event('3')] })

    const first = await GET(new Request('https://axiom.example/api/v1/events/snapshots', {
      headers: { 'X-Axiom-Key': 'opaque-key', 'Last-Event-ID': '1' },
    }))
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toContain('text/event-stream')
    expect(first.headers.get('x-ratelimit-remaining')).toBe('59')
    const firstReader = first.body!.getReader()
    await nextText(firstReader)
    expect(await nextText(firstReader)).toContain('id: 2')
    await firstReader.cancel()

    const resumed = await GET(new Request('https://axiom.example/api/v1/events/snapshots', {
      headers: { 'X-Axiom-Key': 'opaque-key', 'Last-Event-ID': '2' },
    }))
    const resumedReader = resumed.body!.getReader()
    await nextText(resumedReader)
    const resumedEvent = await nextText(resumedReader)
    expect(resumedEvent).toContain('id: 3')
    expect(resumedEvent).not.toContain('id: 2')
    await resumedReader.cancel()
    expect(eventStore.prepare).toHaveBeenNthCalledWith(1, 1n, 100)
    expect(eventStore.prepare).toHaveBeenNthCalledWith(2, 2n, 100)
  })

  it.each([
    [{ status: 'unauthorized' as const }, 401, 'authentication_required'],
    [{ status: 'forbidden' as const }, 403, 'insufficient_scope'],
    [{ status: 'rate_limited' as const, quotaKind: 'sustained' as const, limit: 1, remaining: 0 as const, resetAt: '2026-08-13T10:01:00.000Z', retryAfterSeconds: 10 }, 429, 'rate_limit_exceeded'],
  ])('denies the stream before event storage for access decision %#', async (decision, status, code) => {
    vi.stubEnv('AXIOM_API_AUTH_REQUIRED', 'true')
    access.authorize.mockResolvedValue(decision)
    const response = await GET(new Request('https://axiom.example/api/v1/events/snapshots', {
      headers: { 'X-Axiom-Key': 'opaque-key' },
    }))
    await expectOpenApiResponse(response.clone(), '/api/v1/events/snapshots', 'get')
    expect(response.status).toBe(status)
    expect((await response.json()).error.code).toBe(code)
    expect(eventStore.prepare).not.toHaveBeenCalled()
  })

  it('rejects malformed cursors before authentication or event storage', async () => {
    vi.stubEnv('AXIOM_API_AUTH_REQUIRED', 'true')
    const response = await GET(new Request('https://axiom.example/api/v1/events/snapshots', {
      headers: { 'Last-Event-ID': '-1' },
    }))
    await expectOpenApiResponse(response.clone(), '/api/v1/events/snapshots', 'get')
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('invalid_last_event_id')
    expect(access.authorize).not.toHaveBeenCalled()
    expect(eventStore.prepare).not.toHaveBeenCalled()
  })

  it('returns a documented conflict when the cursor is outside bounded replay', async () => {
    vi.stubEnv('AXIOM_API_AUTH_REQUIRED', 'true')
    access.authorize.mockResolvedValue({
      status: 'allowed',
      grant: { principalId: 'client-a', planId: 'developer', routeId: 'events.snapshots', scopes: ['events:read'], limit: 60, remaining: 59, resetAt: '2026-08-13T10:01:00.000Z' },
    })
    eventStore.prepare.mockRejectedValue(new SnapshotReplayError(409, 'replay_window_exceeded', 'Replay window exceeded'))
    const response = await GET(new Request('https://axiom.example/api/v1/events/snapshots', {
      headers: { 'X-Axiom-Key': 'opaque-key', 'Last-Event-ID': '1' },
    }))
    await expectOpenApiResponse(response.clone(), '/api/v1/events/snapshots', 'get')
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('replay_window_exceeded')
  })

  it('permits Last-Event-ID in unauthenticated preflight', () => {
    const response = OPTIONS(new Request('https://axiom.example/api/v1/events/snapshots', { method: 'OPTIONS' }))
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toContain('Last-Event-ID')
    expect(access.authorize).not.toHaveBeenCalled()
  })
})
