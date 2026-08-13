import {
  apiMethodNotAllowedResponse,
  apiOptionsResponse,
} from '../../../../../lib/http/api'
import { createSupplyGetHandler } from '../../../../../lib/http/supply-route'

export const dynamic = 'force-dynamic'

export function OPTIONS(request: Request) {
  return apiOptionsResponse(request)
}

export const HEAD = apiMethodNotAllowedResponse
export const POST = apiMethodNotAllowedResponse
export const PUT = apiMethodNotAllowedResponse
export const PATCH = apiMethodNotAllowedResponse
export const DELETE = apiMethodNotAllowedResponse
export const GET = createSupplyGetHandler()
