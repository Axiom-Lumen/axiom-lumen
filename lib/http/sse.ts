import type { ApiAccessDecision } from '../db/api-access-repository'
import type {
  SnapshotEventRecord,
  SnapshotEventStreamConfig,
  SnapshotReplayError,
} from '../db/snapshot-event-repository'

const encoder = new TextEncoder()

export interface SnapshotEventSource {
  readAfter(afterId: bigint, limit: number): Promise<SnapshotEventRecord[]>
}

export function encodeSnapshotEvent(event: SnapshotEventRecord) {
  return `id: ${event.id}\nevent: snapshot\ndata: ${JSON.stringify(event.payload)}\n\n`
}

function terminalEvent(code: string, message: string) {
  return `event: error\ndata: ${JSON.stringify({ error: { code, message } })}\n\n`
}

export function createSnapshotEventStream(input: {
  source: SnapshotEventSource
  initialCursor: bigint
  initialEvents: SnapshotEventRecord[]
  config: SnapshotEventStreamConfig
  signal?: AbortSignal
  authorize?: () => Promise<ApiAccessDecision>
  clock?: () => number
  onError?: (error: unknown) => void
}) {
  const clock = input.clock ?? Date.now
  let cursor = input.initialCursor
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let backpressurePolls = 0
  let lastHeartbeatAt = clock()
  let lastAuthorizationAt = clock()
  const pendingEvents = [...input.initialEvents]
  const drainPendingEvents = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    while (!closed && pendingEvents.length > 0 && (controller.desiredSize ?? 0) > 0) {
      const event = pendingEvents.shift()!
      controller.enqueue(encoder.encode(encodeSnapshotEvent(event)))
      cursor = BigInt(event.id)
      lastHeartbeatAt = clock()
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return
        closed = true
        if (timer) clearTimeout(timer)
        controller.close()
      }
      const enqueue = (value: string) => {
        if (!closed) controller.enqueue(encoder.encode(value))
      }
      const fail = (code: string, message: string, error?: unknown) => {
        if (error !== undefined) input.onError?.(error)
        enqueue(terminalEvent(code, message))
        close()
      }
      const poll = async () => {
        if (closed) return
        if (input.signal?.aborted) return close()

        const now = clock()
        try {
          if (input.authorize && now - lastAuthorizationAt >= input.config.reauthorizeIntervalMs) {
            const decision = await input.authorize()
            lastAuthorizationAt = now
            if (decision.status !== 'allowed') {
              fail('stream_access_revoked', 'Stream access is no longer authorized')
              return
            }
          }

          drainPendingEvents(controller)
          if (pendingEvents.length > 0 || (controller.desiredSize ?? 0) <= 0) {
            backpressurePolls += 1
            if (backpressurePolls >= input.config.maxBackpressurePolls) return close()
            timer = setTimeout(poll, input.config.pollIntervalMs)
            return
          }
          backpressurePolls = 0

          const events = await input.source.readAfter(cursor, input.config.replayLimit)
          pendingEvents.push(...events)
          drainPendingEvents(controller)
          if (pendingEvents.length === 0 && now - lastHeartbeatAt >= input.config.heartbeatIntervalMs) {
            enqueue(`: heartbeat ${new Date(now).toISOString()}\n\n`)
            lastHeartbeatAt = now
          }
        } catch (error) {
          const replay = error as Partial<SnapshotReplayError>
          if (replay.code === 'replay_window_exceeded') {
            fail('replay_window_exceeded', 'The stream fell outside the bounded replay window', error)
          } else {
            fail('stream_unavailable', 'The snapshot event stream is temporarily unavailable', error)
          }
          return
        }
        timer = setTimeout(poll, input.config.pollIntervalMs)
      }

      enqueue(`retry: ${input.config.pollIntervalMs}\n\n`)
      input.signal?.addEventListener('abort', close, { once: true })
      timer = setTimeout(poll, input.config.pollIntervalMs)
    },
    pull(controller) {
      drainPendingEvents(controller)
    },
    cancel() {
      closed = true
      if (timer) clearTimeout(timer)
    },
  })
}
