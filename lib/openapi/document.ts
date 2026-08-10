import { zodToJsonSchema } from 'zod-to-json-schema'
import {
  apiErrorResponseSchema,
  apiReconciliationSnapshotSchema,
  type ApiErrorResponse,
  type ApiReconciliationSnapshot,
} from '../contracts'
import {
  LATEST_LEDGER_CONFIDENCE_FORMULA_VERSION,
  LATEST_LEDGER_METHODOLOGY_VERSION,
  latestLedgerResponseSchema,
  type LatestLedgerReconciliationResult,
} from '../reconcile/latest-ledger'

const ISSUER = `G${'A'.repeat(55)}`
const ASSET = `USDC:${ISSUER}`
const AS_OF = '2026-08-10T12:00:00.000Z'

export const IMPLEMENTED_PUBLIC_OPERATIONS = [
  {
    operationId: 'getLatestLedger',
    method: 'get',
    path: '/api/v1/stellar/latest-ledger',
  },
  {
    operationId: 'latestLedgerOptions',
    method: 'options',
    path: '/api/v1/stellar/latest-ledger',
  },
  {
    operationId: 'getSupply',
    method: 'get',
    path: '/api/v1/supply/{asset}',
  },
  {
    operationId: 'supplyOptions',
    method: 'options',
    path: '/api/v1/supply/{asset}',
  },
] as const

function latestExample(status: 'verified' | 'degraded' | 'unavailable'): LatestLedgerReconciliationResult {
  const available = status !== 'unavailable'
  return latestLedgerResponseSchema.parse({
    metric: 'latest_ledger',
    value: available ? 58_000_000 : null,
    status,
    confidence: status === 'verified' ? 0.96 : status === 'degraded' ? 0.6 : 0,
    confidence_formula_version: LATEST_LEDGER_CONFIDENCE_FORMULA_VERSION,
    confidence_components: {
      agreement: available ? 1 : 0,
      freshness: available ? 0.95 : 0,
      availability: status === 'verified' ? 1 : status === 'degraded' ? 0.5 : 0,
      diversity: available ? 1 : 0,
      spread: available ? 1 : 0,
    },
    confidence_caps_applied: status === 'degraded' ? ['single_source'] : [],
    sources_configured: 2,
    sources_responded: available ? (status === 'verified' ? 2 : 1) : 0,
    sources_usable: available ? (status === 'verified' ? 2 : 1) : 0,
    sources_agreeing: available ? (status === 'verified' ? 2 : 1) : 0,
    sources_excluded: status === 'unavailable' ? 2 : 0,
    observations: [],
    discrepancies: [],
    source_errors: status === 'unavailable' ? [{
      sourceId: 'configuration',
      sourceUrl: '',
      code: 'request_failed',
      message: 'No current source evidence is usable',
      retrievedAt: AS_OF,
    }] : [],
    as_of: AS_OF,
    methodology_version: LATEST_LEDGER_METHODOLOGY_VERSION,
  })
}

function supplyExample(status: 'verified' | 'degraded' | 'unavailable'): ApiReconciliationSnapshot {
  const available = status !== 'unavailable'
  return apiReconciliationSnapshotSchema.parse({
    metric: 'onchain_asset_supply',
    subject: { kind: 'asset', asset: ASSET },
    status,
    value: available ? { kind: 'amount', value: '1000' } : null,
    confidence: status === 'verified' ? 0.95 : status === 'degraded' ? 0.6 : 0,
    confidence_formula_version: 'onchain-asset-supply-confidence-v0.1',
    confidence_components: {
      agreement: available ? 1 : 0,
      freshness: available ? 0.95 : 0,
      availability: status === 'verified' ? 1 : status === 'degraded' ? 0.5 : 0,
      spread: available ? 1 : 0,
    },
    confidence_caps_applied: status === 'degraded' ? ['single_source'] : [],
    sources_configured: 2,
    sources_responded: available ? (status === 'verified' ? 2 : 1) : 0,
    sources_usable: available ? (status === 'verified' ? 2 : 1) : 0,
    sources_agreeing: available ? (status === 'verified' ? 2 : 1) : 0,
    sources_excluded: status === 'unavailable' ? 2 : 0,
    contributions: [],
    discrepancies: [],
    source_errors: status === 'unavailable' ? [{
      source_id: null,
      source_url: null,
      code: 'stale_observation',
      category: 'freshness',
      message: 'Latest finalized supply evidence exceeds 120 seconds',
      occurred_at: AS_OF,
      retryable: false,
    }] : [],
    as_of: AS_OF,
    methodology_version: 'onchain-asset-supply-v0.1',
    request_id: 'example_request',
    api_version: 'v1',
  })
}

function errorExample(code: string, message: string): ApiErrorResponse {
  return apiErrorResponseSchema.parse({
    error: { code, message },
    request_id: 'example_request',
    as_of: AS_OF,
    api_version: 'v1',
  })
}

export const OPENAPI_EXAMPLES = {
  latestVerified: latestExample('verified'),
  latestDegraded: latestExample('degraded'),
  latestUnavailable: latestExample('unavailable'),
  supplyVerified: supplyExample('verified'),
  supplyDegraded: supplyExample('degraded'),
  supplyUnavailable: supplyExample('unavailable'),
  invalidRequestId: errorExample(
    'invalid_request_id',
    'X-Request-ID must be a valid identifier of at most 128 characters',
  ),
  invalidQueryParameter: errorExample('invalid_query_parameter', 'Unsupported query parameter: limit'),
  invalidAsset: errorExample('invalid_asset', 'Asset must be a canonical CODE:ISSUER credit-asset identifier'),
  latestMissingSnapshot: errorExample(
    'latest_ledger_snapshot_not_found',
    'No finalized latest-ledger snapshot is available',
  ),
  supplyMissingSnapshot: errorExample('supply_snapshot_not_found', 'No finalized supply snapshot is available'),
  latestReadUnavailable: errorExample(
    'latest_ledger_read_unavailable',
    'The latest-ledger read model is temporarily unavailable',
  ),
  supplyReadUnavailable: errorExample(
    'supply_read_unavailable',
    'The supply read model is temporarily unavailable',
  ),
  authenticationError: errorExample('authentication_required', 'A valid API credential is required'),
  rateLimitError: errorExample('rate_limit_exceeded', 'The request quota has been exceeded'),
} as const

function componentSchema(schema: Parameters<typeof zodToJsonSchema>[0], name: string) {
  const converted = zodToJsonSchema(schema, { name, target: 'jsonSchema7', $refStrategy: 'none' }) as {
    definitions?: Record<string, unknown>
  }
  const component = converted.definitions?.[name]
  if (!component) throw new Error(`could not generate OpenAPI component ${name}`)
  return component
}

const responseHeaders = {
  'X-Request-ID': { $ref: '#/components/headers/XRequestId' },
  'Cache-Control': { $ref: '#/components/headers/CacheControl' },
  'Access-Control-Allow-Origin': { $ref: '#/components/headers/CorsOrigin' },
  'Access-Control-Expose-Headers': { $ref: '#/components/headers/CorsExposeHeaders' },
  Vary: { $ref: '#/components/headers/Vary' },
}

const conditionalHeaders = {
  ...responseHeaders,
  ETag: { $ref: '#/components/headers/ETag' },
}

const errorContent = (examples: Record<string, { $ref: string }>) => ({
  'application/json': {
    schema: { $ref: '#/components/schemas/ApiErrorResponse' },
    examples,
  },
})

function publicOptionsOperation(operationId: string) {
  const optionsHeaders = {
    ...responseHeaders,
    'Access-Control-Allow-Headers': { $ref: '#/components/headers/CorsAllowHeaders' },
    'Access-Control-Allow-Methods': { $ref: '#/components/headers/CorsAllowMethods' },
    'Access-Control-Max-Age': { $ref: '#/components/headers/CorsMaxAge' },
  }
  return {
    operationId,
    summary: 'Inspect public read-only CORS policy',
    parameters: [{ $ref: '#/components/parameters/RequestId' }],
    responses: {
      204: { description: 'CORS preflight accepted', headers: optionsHeaders },
      400: {
        description: 'Invalid request identifier',
        headers: optionsHeaders,
        content: errorContent({ invalidRequestId: { $ref: '#/components/examples/InvalidRequestId' } }),
      },
    },
  } as const
}

export function createOpenApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Axiom Lumen Public API',
      version: '1.0.0',
      description: 'Persisted Stellar reconciliation snapshots. The production specification includes implemented routes only.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: '/', description: 'Current origin' }],
    tags: [
      { name: 'Ledger', description: 'Latest closed-ledger reconciliation' },
      { name: 'Supply', description: 'Classic credit-asset on-chain supply reconciliation' },
    ],
    paths: {
      '/api/v1/stellar/latest-ledger': {
        get: {
          operationId: 'getLatestLedger',
          tags: ['Ledger'],
          summary: 'Get the latest finalized Public Network ledger snapshot',
          parameters: [{ $ref: '#/components/parameters/RequestId' }, { $ref: '#/components/parameters/IfNoneMatch' }],
          responses: {
            200: {
              description: 'Current verified or degraded latest-ledger snapshot',
              headers: conditionalHeaders,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/LatestLedgerResponse' },
                  examples: {
                    verified: { $ref: '#/components/examples/LatestVerified' },
                    degraded: { $ref: '#/components/examples/LatestDegraded' },
                  },
                },
              },
            },
            304: { description: 'The representation matches If-None-Match', headers: conditionalHeaders },
            400: {
              description: 'Invalid request header or query parameter',
              headers: responseHeaders,
              content: errorContent({
                invalidRequestId: { $ref: '#/components/examples/InvalidRequestId' },
                invalidQueryParameter: { $ref: '#/components/examples/InvalidQueryParameter' },
              }),
            },
            404: {
              description: 'No finalized snapshot exists',
              headers: responseHeaders,
              content: errorContent({ missing: { $ref: '#/components/examples/LatestMissingSnapshot' } }),
            },
            503: {
              description: 'Persisted metric state or read storage is unavailable',
              headers: responseHeaders,
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/LatestLedgerResponse' },
                      { $ref: '#/components/schemas/ApiErrorResponse' },
                    ],
                  },
                  examples: {
                    unavailable: { $ref: '#/components/examples/LatestUnavailable' },
                    readUnavailable: { $ref: '#/components/examples/LatestReadUnavailable' },
                  },
                },
              },
            },
          },
        },
        options: publicOptionsOperation('latestLedgerOptions'),
      },
      '/api/v1/supply/{asset}': {
        get: {
          operationId: 'getSupply',
          tags: ['Supply'],
          summary: 'Get the latest finalized Public Network supply snapshot',
          parameters: [
            { $ref: '#/components/parameters/Asset' },
            { $ref: '#/components/parameters/RequestId' },
            { $ref: '#/components/parameters/IfNoneMatch' },
          ],
          responses: {
            200: {
              description: 'Current verified or degraded on-chain supply snapshot',
              headers: conditionalHeaders,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ReconciliationSnapshot' },
                  examples: {
                    verified: { $ref: '#/components/examples/SupplyVerified' },
                    degraded: { $ref: '#/components/examples/SupplyDegraded' },
                  },
                },
              },
            },
            304: { description: 'The representation matches If-None-Match', headers: conditionalHeaders },
            400: {
              description: 'Invalid asset, request header, or query parameter',
              headers: responseHeaders,
              content: errorContent({
                invalidAsset: { $ref: '#/components/examples/InvalidAsset' },
                invalidRequestId: { $ref: '#/components/examples/InvalidRequestId' },
                invalidQueryParameter: { $ref: '#/components/examples/InvalidQueryParameter' },
              }),
            },
            404: {
              description: 'No finalized snapshot exists for the asset',
              headers: responseHeaders,
              content: errorContent({ missing: { $ref: '#/components/examples/SupplyMissingSnapshot' } }),
            },
            503: {
              description: 'Persisted metric state, evidence freshness, or read storage is unavailable',
              headers: responseHeaders,
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/ReconciliationSnapshot' },
                      { $ref: '#/components/schemas/ApiErrorResponse' },
                    ],
                  },
                  examples: {
                    unavailable: { $ref: '#/components/examples/SupplyUnavailable' },
                    readUnavailable: { $ref: '#/components/examples/SupplyReadUnavailable' },
                  },
                },
              },
            },
          },
        },
        options: publicOptionsOperation('supplyOptions'),
      },
    },
    components: {
      schemas: {
        LatestLedgerResponse: componentSchema(latestLedgerResponseSchema, 'LatestLedgerResponse'),
        ReconciliationSnapshot: componentSchema(apiReconciliationSnapshotSchema, 'ReconciliationSnapshot'),
        ApiErrorResponse: componentSchema(apiErrorResponseSchema, 'ApiErrorResponse'),
      },
      responses: {
        AuthenticationError: {
          description: 'Reserved authentication failure response for future authenticated operations',
          headers: responseHeaders,
          content: errorContent({ authentication: { $ref: '#/components/examples/AuthenticationError' } }),
        },
        RateLimitError: {
          description: 'Reserved quota-exceeded response for future rate-limited operations',
          headers: {
            ...responseHeaders,
            'Retry-After': { $ref: '#/components/headers/RetryAfter' },
          },
          content: errorContent({ rateLimit: { $ref: '#/components/examples/RateLimitError' } }),
        },
      },
      parameters: {
        Asset: {
          name: 'asset',
          in: 'path',
          required: true,
          description: 'Canonical classic credit asset identifier CODE:ISSUER',
          schema: { type: 'string', pattern: '^[A-Z0-9]{1,12}:G[A-Z2-7]{55}$' },
          example: ASSET,
        },
        RequestId: {
          name: 'X-Request-ID',
          in: 'header',
          required: false,
          description: 'Optional caller correlation identifier; generated when absent',
          schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' },
        },
        IfNoneMatch: {
          name: 'If-None-Match',
          in: 'header',
          required: false,
          schema: { type: 'string' },
        },
      },
      headers: {
        XRequestId: { description: 'Request correlation identifier', schema: { type: 'string' } },
        CacheControl: { description: 'Private snapshot caching or no-store', schema: { type: 'string' } },
        ETag: { description: 'Weak complete-representation validator', schema: { type: 'string' } },
        CorsOrigin: { description: 'Public read-only origin policy', schema: { type: 'string', enum: ['*'] } },
        CorsExposeHeaders: { description: 'Response headers available to browsers', schema: { type: 'string' } },
        CorsAllowHeaders: { description: 'Headers accepted by CORS requests', schema: { type: 'string' } },
        CorsAllowMethods: { description: 'Methods accepted by CORS requests', schema: { type: 'string', enum: ['GET, OPTIONS'] } },
        CorsMaxAge: { description: 'Preflight cache lifetime in seconds', schema: { type: 'string', enum: ['86400'] } },
        Vary: { description: 'Cache representation varies by request identifier', schema: { type: 'string', enum: ['X-Request-ID'] } },
        RetryAfter: { description: 'Seconds until a quota-limited request may be retried', schema: { type: 'integer', minimum: 0 } },
      },
      examples: {
        LatestVerified: { summary: 'Verified latest ledger', value: OPENAPI_EXAMPLES.latestVerified },
        LatestDegraded: { summary: 'Degraded latest ledger', value: OPENAPI_EXAMPLES.latestDegraded },
        LatestUnavailable: { summary: 'Unavailable latest ledger', value: OPENAPI_EXAMPLES.latestUnavailable },
        SupplyVerified: { summary: 'Verified supply', value: OPENAPI_EXAMPLES.supplyVerified },
        SupplyDegraded: { summary: 'Degraded supply', value: OPENAPI_EXAMPLES.supplyDegraded },
        SupplyUnavailable: { summary: 'Unavailable or stale supply', value: OPENAPI_EXAMPLES.supplyUnavailable },
        InvalidRequestId: { summary: 'Invalid request identifier', value: OPENAPI_EXAMPLES.invalidRequestId },
        InvalidQueryParameter: { summary: 'Unsupported query parameter', value: OPENAPI_EXAMPLES.invalidQueryParameter },
        InvalidAsset: { summary: 'Invalid supply asset', value: OPENAPI_EXAMPLES.invalidAsset },
        LatestMissingSnapshot: { summary: 'No finalized latest-ledger snapshot', value: OPENAPI_EXAMPLES.latestMissingSnapshot },
        SupplyMissingSnapshot: { summary: 'No finalized supply snapshot', value: OPENAPI_EXAMPLES.supplyMissingSnapshot },
        LatestReadUnavailable: { summary: 'Latest-ledger read storage unavailable', value: OPENAPI_EXAMPLES.latestReadUnavailable },
        SupplyReadUnavailable: { summary: 'Supply read storage unavailable', value: OPENAPI_EXAMPLES.supplyReadUnavailable },
        AuthenticationError: {
          summary: 'Reserved example for future authenticated operations; no production path currently references it',
          value: OPENAPI_EXAMPLES.authenticationError,
        },
        RateLimitError: {
          summary: 'Reserved example for future quota enforcement; no production path currently references it',
          value: OPENAPI_EXAMPLES.rateLimitError,
        },
      },
    },
  } as const
}

export type AxiomOpenApiDocument = ReturnType<typeof createOpenApiDocument>
