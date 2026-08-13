import { createHash, randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createApiErrorResponse, identifierSchema } from '../contracts'
import { apiAuthenticationRequired } from '../api-access/key'

export const PUBLIC_API_PREFIX = '/api/v1' as const
export const DEFAULT_PAGE_SIZE = 25
export const MAXIMUM_PAGE_SIZE = 100

const REQUEST_ID_HEADER = 'x-request-id'
const ALLOWED_METHODS = 'GET, OPTIONS'
const API_KEY_HEADER = 'x-axiom-key'
const ALLOWED_HEADERS = 'Accept, Content-Type, If-None-Match, X-Axiom-Key, X-Request-ID'
const EXPOSED_HEADERS = 'Deprecation, ETag, Link, Retry-After, Sunset, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Request-ID'

export interface ApiDeprecationPolicy {
  deprecatedAt: string
  sunsetAt: string
  successorUrl: string
}

export interface ApiResponseOptions {
  status: number
  requestId: string
  cache?: ApiCachePolicy
  etag?: boolean
  etagValue?: unknown
  deprecation?: ApiDeprecationPolicy
}

export type ApiCachePolicy = 'no-store' | {
  maxAgeSeconds: number
  staleWhileRevalidateSeconds?: number
}

export interface ApiPagination {
  cursor?: string
  limit: number
}

export class ApiParameterError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ApiParameterError'
    this.code = code
  }
}

const paginationSchema = z.object({
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).optional(),
}).strict().superRefine((pagination, context) => {
  if (pagination.limit !== undefined && (pagination.limit < 1 || pagination.limit > MAXIMUM_PAGE_SIZE)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['limit'],
      message: `limit must be from 1 through ${MAXIMUM_PAGE_SIZE}`,
    })
  }
})

function parseDate(name: string, value: string) {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error(`${name} must be a valid timestamp`)
  return milliseconds
}

function deprecationHeaders(policy: ApiDeprecationPolicy) {
  const deprecatedAt = parseDate('deprecatedAt', policy.deprecatedAt)
  const sunsetAt = parseDate('sunsetAt', policy.sunsetAt)
  if (sunsetAt <= deprecatedAt) throw new Error('sunsetAt must be later than deprecatedAt')
  const successor = new URL(policy.successorUrl)
  if (!['http:', 'https:'].includes(successor.protocol) || successor.username || successor.password) {
    throw new Error('successorUrl must be an HTTP(S) URL without credentials')
  }
  return {
    Deprecation: `@${Math.floor(deprecatedAt / 1_000)}`,
    Sunset: new Date(sunsetAt).toUTCString(),
    Link: `<${successor.toString()}>; rel="successor-version"`,
  }
}

function cacheControl(policy: ApiCachePolicy | undefined) {
  if (!policy || policy === 'no-store') return 'no-store'
  if (!Number.isSafeInteger(policy.maxAgeSeconds) || policy.maxAgeSeconds < 0) {
    throw new Error('cache maxAgeSeconds must be a non-negative safe integer')
  }
  const staleSeconds = policy.staleWhileRevalidateSeconds ?? 0
  if (!Number.isSafeInteger(staleSeconds) || staleSeconds < 0) {
    throw new Error('cache staleWhileRevalidateSeconds must be a non-negative safe integer')
  }
  return [
    'private',
    `max-age=${policy.maxAgeSeconds}`,
    ...(staleSeconds === 0 ? ['must-revalidate'] : [`stale-while-revalidate=${staleSeconds}`]),
  ].join(', ')
}

function baseHeaders(requestId: string, cache: ApiResponseOptions['cache'], deprecation?: ApiDeprecationPolicy) {
  identifierSchema.parse(requestId)
  return new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Cache-Control': cacheControl(cache),
    Vary: 'X-Request-ID, X-Axiom-Key',
    'X-Content-Type-Options': 'nosniff',
    'X-Request-ID': requestId,
    ...(deprecation ? deprecationHeaders(deprecation) : {}),
  })
}

function weakEtag(value: unknown) {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('base64url')
  return `W/"${digest}"`
}

function opaqueTag(value: string) {
  const match = /^(?:W\/)?("[^"\r\n]*")$/.exec(value)
  return match?.[1]
}

function etagMatches(request: Request, etag: string) {
  const candidates = request.headers.get('if-none-match')?.split(',').map((value) => value.trim()) ?? []
  const expected = opaqueTag(etag)
  return candidates.includes('*') || (expected !== undefined && candidates.some((candidate) => opaqueTag(candidate) === expected))
}

export function resolveApiRequestId(request: Request) {
  const supplied = request.headers.get(REQUEST_ID_HEADER)
  if (supplied === null) return { ok: true as const, requestId: randomUUID() }
  const parsed = identifierSchema.safeParse(supplied)
  if (parsed.success) return { ok: true as const, requestId: parsed.data }
  return {
    ok: false as const,
    requestId: randomUUID(),
    code: 'invalid_request_id',
    message: 'X-Request-ID must be a valid identifier of at most 128 characters',
  }
}

export function rejectUnexpectedQueryParameters(request: Request, allowed: readonly string[] = []) {
  const allowedNames = new Set(allowed)
  const unexpected = [...new URL(request.url).searchParams.keys()].filter((name) => !allowedNames.has(name))
  return unexpected.length === 0 ? null : {
    code: 'invalid_query_parameter',
    message: `Unsupported query parameter: ${unexpected[0]}`,
  }
}

export function parseApiPagination(searchParams: URLSearchParams): ApiPagination {
  const unexpected = [...searchParams.keys()].filter((name) => !['cursor', 'limit'].includes(name))
  if (unexpected[0]) throw new ApiParameterError('invalid_query_parameter', `Unsupported query parameter: ${unexpected[0]}`)
  const duplicate = ['cursor', 'limit'].find((name) => searchParams.getAll(name).length > 1)
  if (duplicate) throw new ApiParameterError('invalid_pagination', `Pagination parameter ${duplicate} must appear once`)
  const values = Object.fromEntries(searchParams.entries())
  const parsed = paginationSchema.safeParse(values)
  if (!parsed.success) throw new ApiParameterError('invalid_pagination', parsed.error.issues[0]?.message ?? 'Invalid pagination')
  return {
    ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
    limit: parsed.data.limit ?? DEFAULT_PAGE_SIZE,
  }
}

export function apiJsonResponse(request: Request, body: unknown, options: ApiResponseOptions) {
  const headers = baseHeaders(options.requestId, options.cache ?? 'no-store', options.deprecation)
  if (options.etag && options.status === 200) {
    const etag = weakEtag(options.etagValue ?? body)
    headers.set('ETag', etag)
    if (etagMatches(request, etag)) return new NextResponse(null, { status: 304, headers })
  }
  return NextResponse.json(body, { status: options.status, headers })
}

export function apiErrorResponse({
  request,
  status,
  code,
  message,
  requestId,
  asOf = new Date(),
  details,
}: {
  request: Request
  status: number
  code: string
  message: string
  requestId: string
  asOf?: Date
  details?: Record<string, unknown>
}) {
  return apiJsonResponse(
    request,
    createApiErrorResponse({ code, message, requestId, asOf, details }),
    { status, requestId, cache: 'no-store' },
  )
}

export function apiOptionsResponse(request: Request) {
  const resolved = resolveApiRequestId(request)
  const headers = baseHeaders(resolved.requestId, 'no-store')
  headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS)
  headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS)
  headers.set('Access-Control-Max-Age', '86400')
  if (!resolved.ok) {
    return NextResponse.json(
      createApiErrorResponse({
        code: resolved.code,
        message: resolved.message,
        requestId: resolved.requestId,
        asOf: new Date(),
      }),
      { status: 400, headers },
    )
  }
  return new NextResponse(null, { status: 204, headers })
}

export function apiMethodNotAllowedResponse(request: Request) {
  const resolved = resolveApiRequestId(request)
  const response = apiErrorResponse({
    request,
    status: resolved.ok ? 405 : 400,
    code: resolved.ok ? 'method_not_allowed' : resolved.code,
    message: resolved.ok ? 'This endpoint accepts GET and OPTIONS only' : resolved.message,
    requestId: resolved.requestId,
  })
  response.headers.set('Allow', ALLOWED_METHODS)
  return response
}

function applyRateLimitHeaders(response: Response, limit: number, remaining: number, resetAt: string) {
  response.headers.set('X-RateLimit-Limit', String(limit))
  response.headers.set('X-RateLimit-Remaining', String(remaining))
  response.headers.set('X-RateLimit-Reset', String(Math.floor(Date.parse(resetAt) / 1_000)))
  return response
}

/** Authenticates and atomically consumes one plan quota unit before public route work begins. */
export async function withPublicApiAccess(
  request: Request,
  requestId: string,
  handler: () => Promise<Response>,
) {
  try {
    if (!apiAuthenticationRequired()) return handler()
  } catch (error) {
    console.error('Unable to read public API access policy', { name: error instanceof Error ? error.name : 'Error' })
    return apiErrorResponse({ request, status: 503, code: 'api_access_unavailable', message: 'API access verification is temporarily unavailable', requestId })
  }
  let decision
  try {
    const { authorizePublicApiKey } = await import('../db/api-access-repository')
    decision = await authorizePublicApiKey(request.headers.get(API_KEY_HEADER))
  } catch (error) {
    console.error('Unable to authorize public API access', { name: error instanceof Error ? error.name : 'Error' })
    return apiErrorResponse({
      request,
      status: 503,
      code: 'api_access_unavailable',
      message: 'API access verification is temporarily unavailable',
      requestId,
    })
  }

  if (decision.status === 'unauthorized') {
    return apiErrorResponse({
      request,
      status: 401,
      code: 'authentication_required',
      message: 'A valid API key is required',
      requestId,
    })
  }
  if (decision.status === 'rate_limited') {
    const response = apiErrorResponse({
      request,
      status: 429,
      code: 'rate_limit_exceeded',
      message: 'The request quota has been exceeded',
      requestId,
    })
    response.headers.set('Retry-After', String(decision.retryAfterSeconds))
    return applyRateLimitHeaders(response, decision.limit, decision.remaining, decision.resetAt)
  }
  return applyRateLimitHeaders(
    await handler(),
    decision.grant.limit,
    decision.grant.remaining,
    decision.grant.resetAt,
  )
}
