import { supplyMethodologyConfig } from '../../config/methodology'
import { PUBLIC_API_ACCESS_POLICIES } from '../api-access/policy'
import {
  apiReconciliationSnapshotSchema,
  parseAssetId,
  serializePublicReconciliationSnapshot,
  type ApiReconciliationSnapshot,
} from '../contracts'
import { loadLatestSupplyReadModel } from '../db/supply-read-model'
import { errorTelemetry, structuredLog } from '../observability/telemetry'
import {
  apiErrorResponse,
  apiJsonResponse,
  linkApiResponseToProducerCycle,
  rejectUnexpectedQueryParameters,
  resolveApiRequestId,
  withPublicApiAccess,
} from './api'

interface SupplyRouteContext {
  params: Promise<{ asset: string }>
}

interface SupplyRouteDependencies {
  loadReadModel?: typeof loadLatestSupplyReadModel
  clock?: () => Date
}

function staleResponse(response: ApiReconciliationSnapshot, requestId: string, now: Date): ApiReconciliationSnapshot {
  return apiReconciliationSnapshotSchema.parse({
    ...response,
    status: 'unavailable',
    value: null,
    confidence: 0,
    confidence_components: Object.fromEntries(
      Object.keys(response.confidence_components).map((component) => [component, 0]),
    ),
    confidence_caps_applied: [...new Set([...response.confidence_caps_applied, 'snapshot_stale'])],
    sources_usable: 0,
    sources_agreeing: 0,
    contributions: [],
    discrepancies: [],
    source_errors: [
      ...response.source_errors,
      {
        source_id: null,
        source_url: null,
        code: 'stale_observation',
        category: 'freshness',
        message: `Latest finalized supply evidence exceeds ${supplyMethodologyConfig.maximumObservationAgeSeconds} seconds`,
        occurred_at: now.toISOString(),
        retryable: false,
      },
    ],
    request_id: requestId,
  })
}

function supplyCachePolicy(freshForSeconds: number) {
  const totalBudget = Math.max(0, Math.floor(freshForSeconds))
  const maxAgeSeconds = Math.min(15, totalBudget)
  return { maxAgeSeconds, staleWhileRevalidateSeconds: Math.min(45, totalBudget - maxAgeSeconds) }
}

export function createSupplyGetHandler({
  loadReadModel = loadLatestSupplyReadModel,
  clock = () => new Date(),
}: SupplyRouteDependencies = {}) {
  return async function getSupply(request: Request, context: SupplyRouteContext) {
    const now = clock()
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('supply route clock must return a valid Date')
    }
    const resolved = resolveApiRequestId(request)
    if (!resolved.ok) {
      return apiErrorResponse({
        request, status: 400, code: resolved.code, message: resolved.message,
        requestId: resolved.requestId, asOf: now,
      })
    }
    const requestId = resolved.requestId
    return withPublicApiAccess(request, requestId, PUBLIC_API_ACCESS_POLICIES.supply, async () => {
      const queryError = rejectUnexpectedQueryParameters(request)
      if (queryError) return apiErrorResponse({ request, status: 400, ...queryError, requestId, asOf: now })

      const { asset: rawAsset } = await context.params
      let asset
      try {
        const parsed = parseAssetId(rawAsset)
        if (parsed.kind !== 'credit') throw new Error('native XLM is not supported by supply v0.1')
        asset = parsed
      } catch {
        return apiErrorResponse({
          request, status: 400, code: 'invalid_asset',
          message: 'Asset must be a canonical CODE:ISSUER credit-asset identifier', requestId, asOf: now,
        })
      }

      try {
        const readModel = await loadReadModel(asset, now)
        if (!readModel) {
          return apiErrorResponse({
            request, status: 404, code: 'supply_snapshot_not_found',
            message: 'No finalized supply snapshot is available', requestId, asOf: now,
          })
        }
        const response = serializePublicReconciliationSnapshot(readModel.snapshot, requestId)
        if (readModel.stale) {
          return linkApiResponseToProducerCycle(apiJsonResponse(
            request,
            staleResponse(response, requestId, now),
            { status: 503, requestId, cache: 'no-store' },
          ), readModel.snapshot.cycleId)
        }
        const status = response.status === 'unavailable' ? 503 : 200
        return linkApiResponseToProducerCycle(apiJsonResponse(request, response, {
          status,
          requestId,
          cache: status === 200 ? supplyCachePolicy(readModel.freshForSeconds) : 'no-store',
          etag: status === 200,
        }), readModel.snapshot.cycleId)
      } catch (error) {
        structuredLog('error', 'supply_read_failed', { request_id: requestId, ...errorTelemetry(error) })
        return apiErrorResponse({
          request, status: 503, code: 'supply_read_unavailable',
          message: 'The supply read model is temporarily unavailable', requestId, asOf: now,
        })
      }
    })
  }
}
