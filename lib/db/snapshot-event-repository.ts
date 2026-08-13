import { apiSnapshotEventSchema, type ApiSnapshotEvent } from '../contracts'
import type { DatabaseClient } from './client'

const MAX_EVENT_ID = 9_223_372_036_854_775_807n

export interface SnapshotEventRecord {
  id: string
  payload: ApiSnapshotEvent
  occurredAt: string
}

export interface SnapshotEventStreamConfig {
  replayLimit: number
  pollIntervalMs: number
  heartbeatIntervalMs: number
  reauthorizeIntervalMs: number
  maxBackpressurePolls: number
}

export class SnapshotReplayError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: 'invalid_last_event_id' | 'replay_window_exceeded',
    message: string,
    readonly details?: Record<string, string | number>,
  ) {
    super(message)
  }
}

function boundedInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

export function parseSnapshotEventStreamConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SnapshotEventStreamConfig {
  return {
    replayLimit: boundedInteger('EVT_SSE_REPLAY_LIMIT', environment.EVT_SSE_REPLAY_LIMIT, 100, 1, 1_000),
    pollIntervalMs: boundedInteger('EVT_SSE_POLL_INTERVAL_MS', environment.EVT_SSE_POLL_INTERVAL_MS, 1_000, 100, 30_000),
    heartbeatIntervalMs: boundedInteger('EVT_SSE_HEARTBEAT_INTERVAL_MS', environment.EVT_SSE_HEARTBEAT_INTERVAL_MS, 15_000, 1_000, 120_000),
    reauthorizeIntervalMs: boundedInteger('EVT_SSE_REAUTHORIZE_INTERVAL_MS', environment.EVT_SSE_REAUTHORIZE_INTERVAL_MS, 15_000, 1_000, 120_000),
    maxBackpressurePolls: boundedInteger('EVT_SSE_MAX_BACKPRESSURE_POLLS', environment.EVT_SSE_MAX_BACKPRESSURE_POLLS, 3, 1, 100),
  }
}

export function parseLastEventId(value: string | null) {
  if (value === null) return null
  if (!/^(?:0|[1-9]\d{0,18})$/.test(value)) {
    throw new SnapshotReplayError(400, 'invalid_last_event_id', 'Last-Event-ID must be a non-negative decimal event ID')
  }
  const parsed = BigInt(value)
  if (parsed > MAX_EVENT_ID) {
    throw new SnapshotReplayError(400, 'invalid_last_event_id', 'Last-Event-ID exceeds the supported event ID range')
  }
  return parsed
}

function canonicalTimestamp(value: string | Date) {
  const timestamp = new Date(value)
  if (!Number.isFinite(timestamp.getTime())) throw new Error('snapshot event contains an invalid timestamp')
  return timestamp.toISOString()
}

export function createSnapshotEventRepository(client: DatabaseClient) {
  async function latestEventId() {
    const result = await client.pool.query<{ id: string }>(`SELECT COALESCE(max(id), 0)::text AS id FROM snapshot_events`)
    return BigInt(result.rows[0]?.id ?? '0')
  }

  async function readAfter(afterId: bigint, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('snapshot event read limit must be from 1 through 1000')
    const result = await client.pool.query<{ id: string; payload: unknown; occurred_at: string | Date }>(
      `SELECT id::text, payload, occurred_at FROM snapshot_events WHERE id > $1 ORDER BY id LIMIT $2`,
      [afterId.toString(), limit + 1],
    )
    if (result.rows.length > limit) {
      const latest = await latestEventId()
      throw new SnapshotReplayError(409, 'replay_window_exceeded', 'More events are pending than the bounded replay window permits', {
        last_event_id: afterId.toString(),
        latest_event_id: latest.toString(),
        replay_limit: limit,
      })
    }
    return result.rows.map((row): SnapshotEventRecord => ({
      id: row.id,
      payload: apiSnapshotEventSchema.parse(row.payload),
      occurredAt: canonicalTimestamp(row.occurred_at),
    }))
  }

  return {
    latestEventId,
    readAfter,

    async prepare(lastEventId: bigint | null, replayLimit: number) {
      const latest = await latestEventId()
      if (lastEventId === null) return { cursor: latest, events: [] as SnapshotEventRecord[] }
      if (lastEventId > latest) {
        throw new SnapshotReplayError(400, 'invalid_last_event_id', 'Last-Event-ID is ahead of the latest persisted event', {
          latest_event_id: latest.toString(),
        })
      }
      if (lastEventId > 0n) {
        const exists = await client.pool.query(`SELECT 1 FROM snapshot_events WHERE id = $1`, [lastEventId.toString()])
        if (exists.rowCount !== 1) {
          throw new SnapshotReplayError(409, 'replay_window_exceeded', 'Last-Event-ID is not available in the durable replay log', {
            last_event_id: lastEventId.toString(),
            latest_event_id: latest.toString(),
          })
        }
      }
      const events = await readAfter(lastEventId, replayLimit)
      return { cursor: events.length > 0 ? BigInt(events.at(-1)!.id) : lastEventId, events }
    },
  }
}

let webProcessClient: DatabaseClient | undefined

export async function createWebSnapshotEventRepository() {
  const { createDatabaseClient } = await import('./client')
  webProcessClient ??= createDatabaseClient()
  return createSnapshotEventRepository(webProcessClient)
}
