import { identifierSchema, serializePublicAnchorReserves } from '../../../../../../lib/contracts'
import { InvalidAnchorReserveCursorError, loadPublicAnchorReserves } from '../../../../../../lib/db/anchor-public-read-model'
import {
  ApiParameterError,
  apiErrorResponse,
  apiJsonResponse,
  apiMethodNotAllowedResponse,
  apiOptionsResponse,
  parseApiPagination,
  resolveApiRequestId,
  withPublicApiAccess,
} from '../../../../../../lib/http/api'

export const dynamic = 'force-dynamic'

interface AnchorReserveRouteContext {
  params: Promise<{ anchor: string }>
}

export function OPTIONS(request: Request) {
  return apiOptionsResponse(request)
}

export const HEAD = apiMethodNotAllowedResponse
export const POST = apiMethodNotAllowedResponse
export const PUT = apiMethodNotAllowedResponse
export const PATCH = apiMethodNotAllowedResponse
export const DELETE = apiMethodNotAllowedResponse

export async function GET(request: Request, context: AnchorReserveRouteContext) {
  const now = new Date()
  const resolved = resolveApiRequestId(request)
  if (!resolved.ok) {
    return apiErrorResponse({ request, status: 400, code: resolved.code, message: resolved.message, requestId: resolved.requestId, asOf: now })
  }
  const requestId = resolved.requestId
  return withPublicApiAccess(request, requestId, async () => {
    let pagination
    try {
      pagination = parseApiPagination(new URL(request.url).searchParams)
    } catch (error) {
      if (!(error instanceof ApiParameterError)) throw error
      return apiErrorResponse({ request, status: 400, code: error.code, message: error.message, requestId, asOf: now })
    }

    const { anchor: rawAnchor } = await context.params
    const parsedAnchor = identifierSchema.safeParse(rawAnchor)
    if (!parsedAnchor.success) {
      return apiErrorResponse({ request, status: 400, code: 'invalid_anchor', message: 'Anchor must be a valid canonical identifier', requestId, asOf: now })
    }

    try {
      const model = await loadPublicAnchorReserves(parsedAnchor.data, pagination)
      if (!model) return apiErrorResponse({ request, status: 404, code: 'anchor_not_found', message: 'No verified anchor is available for this identifier', requestId, asOf: now })
      const body = serializePublicAnchorReserves(model, requestId)
      return apiJsonResponse(request, body, {
        status: 200, requestId, cache: { maxAgeSeconds: 15, staleWhileRevalidateSeconds: 45 }, etag: true, etagValue: { ...body, request_id: undefined },
      })
    } catch (error) {
      if (error instanceof InvalidAnchorReserveCursorError) {
        return apiErrorResponse({ request, status: 400, code: 'invalid_pagination', message: error.message, requestId, asOf: now })
      }
      console.error('Unable to load the public anchor reserve read model', { name: error instanceof Error ? error.name : 'Error' })
      return apiErrorResponse({ request, status: 503, code: 'anchor_reserves_read_unavailable', message: 'The anchor reserve read model is temporarily unavailable', requestId, asOf: now })
    }
  })
}
