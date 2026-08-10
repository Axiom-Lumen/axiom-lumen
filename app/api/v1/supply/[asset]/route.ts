import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supplyMethodologyConfig } from '../../../../../config/methodology'
import {
  apiReconciliationSnapshotSchema,
  createApiErrorResponse,
  parseAssetId,
  serializePublicReconciliationSnapshot,
  type ApiReconciliationSnapshot,
} from '../../../../../lib/contracts'
import { loadLatestSupplyReadModel } from '../../../../../lib/db/supply-read-model'

export const dynamic = 'force-dynamic'

interface SupplyRouteContext {
  params: Promise<{ asset: string }>
}

function errorResponse(status: number, code: string, message: string, requestId: string, asOf: Date) {
  return NextResponse.json(createApiErrorResponse({ code, message, requestId, asOf }), { status })
}

function staleResponse(
  response: ApiReconciliationSnapshot,
  requestId: string,
  now: Date,
): ApiReconciliationSnapshot {
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

export async function GET(_request: Request, context: SupplyRouteContext) {
  const requestId = randomUUID()
  const now = new Date()
  const { asset: rawAsset } = await context.params
  let asset
  try {
    const parsed = parseAssetId(rawAsset)
    if (parsed.kind !== 'credit') throw new Error('native XLM is not supported by supply v0.1')
    asset = parsed
  } catch {
    return errorResponse(
      400,
      'invalid_asset',
      'Asset must be a canonical CODE:ISSUER credit-asset identifier',
      requestId,
      now,
    )
  }

  try {
    const readModel = await loadLatestSupplyReadModel(asset, now)
    if (!readModel) {
      return errorResponse(404, 'supply_snapshot_not_found', 'No finalized supply snapshot is available', requestId, now)
    }
    const response = serializePublicReconciliationSnapshot(readModel.snapshot, requestId)
    if (readModel.stale) return NextResponse.json(staleResponse(response, requestId, now), { status: 503 })
    return NextResponse.json(response, { status: response.status === 'unavailable' ? 503 : 200 })
  } catch (error) {
    console.error('Unable to load the supply read model', {
      name: error instanceof Error ? error.name : 'Error',
    })
    return errorResponse(503, 'supply_read_unavailable', 'The supply read model is temporarily unavailable', requestId, now)
  }
}
