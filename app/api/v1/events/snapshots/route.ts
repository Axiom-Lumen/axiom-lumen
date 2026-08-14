import { apiAuthenticationRequired } from '../../../../../lib/api-access/key'
import { PUBLIC_API_ACCESS_POLICIES } from '../../../../../lib/api-access/policy'
import { authorizePublicApiKey } from '../../../../../lib/db/api-access-repository'
import {
  SnapshotReplayError,
  createWebSnapshotEventRepository,
  parseLastEventId,
  parseSnapshotEventStreamConfig,
} from '../../../../../lib/db/snapshot-event-repository'
import {
  apiErrorResponse,
  apiEventStreamResponse,
  apiMethodNotAllowedResponse,
  apiOptionsResponse,
  rejectUnexpectedQueryParameters,
  resolveApiRequestId,
  withPublicApiAccess,
} from '../../../../../lib/http/api'
import { createSnapshotEventStream } from '../../../../../lib/http/sse'
import { errorTelemetry, structuredLog } from '../../../../../lib/observability/telemetry'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export function OPTIONS(request: Request) {
  return apiOptionsResponse(request)
}

export const HEAD = apiMethodNotAllowedResponse
export const POST = apiMethodNotAllowedResponse
export const PUT = apiMethodNotAllowedResponse
export const PATCH = apiMethodNotAllowedResponse
export const DELETE = apiMethodNotAllowedResponse

export async function GET(request: Request) {
  const resolved = resolveApiRequestId(request)
  if (!resolved.ok) {
    return apiErrorResponse({ request, status: 400, code: resolved.code, message: resolved.message, requestId: resolved.requestId })
  }
  const queryError = rejectUnexpectedQueryParameters(request)
  if (queryError) return apiErrorResponse({ request, status: 400, ...queryError, requestId: resolved.requestId })

  let lastEventId
  let config
  try {
    lastEventId = parseLastEventId(request.headers.get('last-event-id'))
    config = parseSnapshotEventStreamConfig()
  } catch (error) {
    if (error instanceof SnapshotReplayError) {
      return apiErrorResponse({
        request,
        status: error.status,
        code: error.code,
        message: error.message,
        requestId: resolved.requestId,
        details: error.details,
      })
    }
    structuredLog('error', 'snapshot_stream_configuration_failed', { request_id: resolved.requestId, ...errorTelemetry(error) })
    return apiErrorResponse({ request, status: 503, code: 'stream_unavailable', message: 'The snapshot event stream is temporarily unavailable', requestId: resolved.requestId })
  }

  return withPublicApiAccess(request, resolved.requestId, PUBLIC_API_ACCESS_POLICIES.snapshotEvents, async () => {
    try {
      const source = await createWebSnapshotEventRepository()
      const prepared = await source.prepare(lastEventId, config.replayLimit)
      const authenticationRequired = apiAuthenticationRequired()
      const rawKey = request.headers.get('x-axiom-key')
      const stream = createSnapshotEventStream({
        source,
        initialCursor: lastEventId ?? prepared.cursor,
        initialEvents: prepared.events,
        config,
        signal: request.signal,
        authorize: authenticationRequired
          ? () => authorizePublicApiKey(rawKey, PUBLIC_API_ACCESS_POLICIES.snapshotEvents)
          : undefined,
        onError(error) {
          structuredLog('error', 'snapshot_stream_stopped', { request_id: resolved.requestId, ...errorTelemetry(error) })
        },
      })
      return apiEventStreamResponse(stream, resolved.requestId)
    } catch (error) {
      if (error instanceof SnapshotReplayError) {
        return apiErrorResponse({
          request,
          status: error.status,
          code: error.code,
          message: error.message,
          requestId: resolved.requestId,
          details: error.details,
        })
      }
      structuredLog('error', 'snapshot_stream_open_failed', { request_id: resolved.requestId, ...errorTelemetry(error) })
      return apiErrorResponse({ request, status: 503, code: 'stream_unavailable', message: 'The snapshot event stream is temporarily unavailable', requestId: resolved.requestId })
    }
  })
}
