import { latestLedgerProducerCycle, loadLatestLedgerReadModel } from '../../../../../lib/db/latest-ledger-read-model'
import { PUBLIC_API_ACCESS_POLICIES } from '../../../../../lib/api-access/policy'
import {
  apiErrorResponse,
  apiJsonResponse,
  linkApiResponseToProducerCycle,
  apiMethodNotAllowedResponse,
  apiOptionsResponse,
  rejectUnexpectedQueryParameters,
  resolveApiRequestId,
  withPublicApiAccess,
} from '../../../../../lib/http/api'
import { errorTelemetry, structuredLog } from '../../../../../lib/observability/telemetry'

export const dynamic = 'force-dynamic'

function requestError(request: Request, status: number, code: string, message: string, requestId: string) {
  return apiErrorResponse({ request, status, code, message, requestId })
}

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
  if (!resolved.ok) return requestError(request, 400, resolved.code, resolved.message, resolved.requestId)
  return withPublicApiAccess(request, resolved.requestId, PUBLIC_API_ACCESS_POLICIES.latestLedger, async () => {
    const queryError = rejectUnexpectedQueryParameters(request)
    if (queryError) return requestError(request, 400, queryError.code, queryError.message, resolved.requestId)

    try {
      const reconciled = await loadLatestLedgerReadModel()
      if (!reconciled) {
        return requestError(
          request,
          404,
          'latest_ledger_snapshot_not_found',
          'No finalized latest-ledger snapshot is available',
          resolved.requestId,
        )
      }
      const status = reconciled.status === 'unavailable' ? 503 : 200
      const response = apiJsonResponse(request, reconciled, {
        status,
        requestId: resolved.requestId,
        cache: status === 200 ? { maxAgeSeconds: 15, staleWhileRevalidateSeconds: 45 } : 'no-store',
        etag: status === 200,
      })
      const producerCycle = latestLedgerProducerCycle(reconciled)
      return producerCycle ? linkApiResponseToProducerCycle(response, producerCycle) : response
    } catch (error) {
      structuredLog('error', 'latest_ledger_read_failed', { request_id: resolved.requestId, ...errorTelemetry(error) })
      return requestError(
        request,
        503,
        'latest_ledger_read_unavailable',
        'The latest-ledger read model is temporarily unavailable',
        resolved.requestId,
      )
    }
  })
}
