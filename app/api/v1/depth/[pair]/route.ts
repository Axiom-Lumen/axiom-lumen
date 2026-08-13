import { depthReconciliationMethodologyConfig } from '../../../../../config/methodology'
import { PUBLIC_API_ACCESS_POLICIES } from '../../../../../lib/api-access/policy'
import { apiReconciliationSnapshotSchema, parseTradingPairId, serializePublicReconciliationSnapshot, type ApiReconciliationSnapshot } from '../../../../../lib/contracts'
import { loadLatestDepthReadModel } from '../../../../../lib/db/depth-read-model'
import { apiErrorResponse, apiJsonResponse, apiMethodNotAllowedResponse, apiOptionsResponse, rejectUnexpectedQueryParameters, resolveApiRequestId, withPublicApiAccess } from '../../../../../lib/http/api'

export const dynamic = 'force-dynamic'
interface Context { params: Promise<{ pair: string }> }
export function OPTIONS(request: Request) { return apiOptionsResponse(request) }
export const HEAD = apiMethodNotAllowedResponse
export const POST = apiMethodNotAllowedResponse
export const PUT = apiMethodNotAllowedResponse
export const PATCH = apiMethodNotAllowedResponse
export const DELETE = apiMethodNotAllowedResponse

function staleResponse(response: ApiReconciliationSnapshot, requestId: string, now: Date) {
  return apiReconciliationSnapshotSchema.parse({ ...response, status: 'unavailable', value: null, confidence: 0,
    confidence_components: Object.fromEntries(Object.keys(response.confidence_components).map((component) => [component, 0])),
    confidence_caps_applied: [...new Set([...response.confidence_caps_applied, 'snapshot_stale'])], sources_usable: 0, sources_agreeing: 0,
    contributions: [], discrepancies: [], source_errors: [...response.source_errors, { source_id: null, source_url: null, code: 'stale_book', category: 'freshness', message: `Latest finalized depth evidence exceeds ${depthReconciliationMethodologyConfig.maximumObservationAgeSeconds} seconds`, occurred_at: now.toISOString(), retryable: false }], request_id: requestId })
}
function cachePolicy(freshForSeconds: number) { const budget = Math.max(0, Math.floor(freshForSeconds)); const maxAgeSeconds = Math.min(5, budget); return { maxAgeSeconds, staleWhileRevalidateSeconds: Math.min(15, budget - maxAgeSeconds) } }

export async function GET(request: Request, context: Context) {
  const now = new Date(); const resolved = resolveApiRequestId(request)
  if (!resolved.ok) return apiErrorResponse({ request, status: 400, code: resolved.code, message: resolved.message, requestId: resolved.requestId, asOf: now })
  return withPublicApiAccess(request, resolved.requestId, PUBLIC_API_ACCESS_POLICIES.depth, async () => {
    const queryError = rejectUnexpectedQueryParameters(request)
    if (queryError) return apiErrorResponse({ request, status: 400, ...queryError, requestId: resolved.requestId, asOf: now })
    let pair
    try { pair = parseTradingPairId((await context.params).pair) } catch { return apiErrorResponse({ request, status: 400, code: 'invalid_pair', message: 'Pair must be two different Stellar asset identifiers separated by ~', requestId: resolved.requestId, asOf: now }) }
    try {
      const readModel = await loadLatestDepthReadModel(pair, now)
      if (!readModel) return apiErrorResponse({ request, status: 404, code: 'depth_snapshot_not_found', message: 'No finalized depth snapshot is available', requestId: resolved.requestId, asOf: now })
      const response = serializePublicReconciliationSnapshot(readModel.snapshot, resolved.requestId)
      if (readModel.stale) return apiJsonResponse(request, staleResponse(response, resolved.requestId, now), { status: 503, requestId: resolved.requestId, cache: 'no-store' })
      const status = response.status === 'unavailable' ? 503 : 200
      return apiJsonResponse(request, response, { status, requestId: resolved.requestId, cache: status === 200 ? cachePolicy(readModel.freshForSeconds) : 'no-store', etag: status === 200 })
    } catch (error) {
      console.error('Unable to load depth read model', { name: error instanceof Error ? error.name : 'Error' })
      return apiErrorResponse({ request, status: 503, code: 'depth_read_unavailable', message: 'The depth read model is temporarily unavailable', requestId: resolved.requestId, asOf: now })
    }
  })
}
