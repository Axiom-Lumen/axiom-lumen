import { zodToJsonSchema } from 'zod-to-json-schema'
import {
  apiAnchorReservesResponseSchema,
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
const PAIR = `native~${ASSET}`
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
  { operationId: 'getDepth', method: 'get', path: '/api/v1/depth/{pair}' },
  { operationId: 'depthOptions', method: 'options', path: '/api/v1/depth/{pair}' },
  { operationId: 'getTrustlines', method: 'get', path: '/api/v1/trustlines/{asset}' },
  { operationId: 'trustlineOptions', method: 'options', path: '/api/v1/trustlines/{asset}' },
  { operationId: 'getAnchorReserves', method: 'get', path: '/api/v1/anchors/{anchor}/reserves' },
  { operationId: 'anchorReservesOptions', method: 'options', path: '/api/v1/anchors/{anchor}/reserves' },
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

function depthExample(status: 'verified' | 'degraded' | 'unavailable'): ApiReconciliationSnapshot {
  const available = status !== 'unavailable'
  const buckets = (['bid', 'ask'] as const).flatMap((side) => ([50, 100, 500] as const).map((price_band_basis_points, index) => ({ side, price_band_basis_points, value: String((index + 1) * 100) })))
  return apiReconciliationSnapshotSchema.parse({
    metric: 'order_book_depth', subject: { kind: 'pair', base: 'native', counter: ASSET }, status,
    value: available ? { kind: 'depth', reference_price: { numerator: '2', denominator: '1', decimal: '2.0000000' }, ledger_sequence: 58_000_000, ledger_closed_at: AS_OF, buckets } : null,
    confidence: status === 'verified' ? 0.95 : status === 'degraded' ? 0.6 : 0,
    confidence_formula_version: 'order-book-depth-confidence-v0.2',
    confidence_components: { agreement: available ? 1 : 0, freshness: available ? 0.95 : 0, availability: status === 'verified' ? 1 : status === 'degraded' ? 0.5 : 0, spread: available ? 1 : 0 },
    confidence_caps_applied: status === 'degraded' ? ['single_source'] : [], sources_configured: 2,
    sources_responded: available ? (status === 'verified' ? 2 : 1) : 0, sources_usable: available ? (status === 'verified' ? 2 : 1) : 0,
    sources_agreeing: available ? (status === 'verified' ? 2 : 1) : 0, sources_excluded: 0, contributions: [], discrepancies: [],
    source_errors: status === 'unavailable' ? [{ source_id: null, source_url: null, code: 'stale_book', category: 'freshness', message: 'Latest finalized depth evidence exceeds 20 seconds', occurred_at: AS_OF, retryable: false }] : [],
    as_of: AS_OF, methodology_version: 'order-book-depth-v0.2', request_id: 'example_request', api_version: 'v1',
  })
}

function trustlineExample(status: 'verified' | 'degraded' | 'unavailable'): ApiReconciliationSnapshot {
  const available = status !== 'unavailable'
  return apiReconciliationSnapshotSchema.parse({
    metric: 'trustline_state', subject: { kind: 'asset', asset: ASSET }, status,
    value: available ? { kind: 'trustline_state', total: '825', states: { authorized: '700', authorized_to_maintain_liabilities: '100', unauthorized: '25' }, ledger_sequence: 58_000_000, ledger_closed_at: AS_OF } : null,
    confidence: status === 'verified' ? 0.95 : status === 'degraded' ? 0.6 : 0,
    confidence_formula_version: 'trustline-state-confidence-v0.1',
    confidence_components: { agreement: available ? 1 : 0, freshness: available ? 0.95 : 0, availability: status === 'verified' ? 1 : status === 'degraded' ? 0.5 : 0, spread: available ? 1 : 0 },
    confidence_caps_applied: status === 'degraded' ? ['single_source'] : [], sources_configured: 2,
    sources_responded: available ? (status === 'verified' ? 2 : 1) : 0, sources_usable: available ? (status === 'verified' ? 2 : 1) : 0,
    sources_agreeing: available ? (status === 'verified' ? 2 : 1) : 0, sources_excluded: 0, contributions: [], discrepancies: [],
    source_errors: status === 'unavailable' ? [{ source_id: null, source_url: null, code: 'stale_observation', category: 'freshness', message: 'Latest finalized trustline evidence exceeds 900 seconds', occurred_at: AS_OF, retryable: false }] : [],
    as_of: AS_OF, methodology_version: 'trustline-state-v0.1', request_id: 'example_request', api_version: 'v1',
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

function anchorReservesExample() {
  return apiAnchorReservesResponseSchema.parse({
    anchor: { id: 'anchor_example', name: 'Example Anchor', network: 'public', stellar_account: ISSUER, status: 'verified' },
    disclosures: [{
      flag_id: 'anchor_flag_example', severity: 'warning', lifecycle_state: 'open', publication_state: 'approved_public',
      methodology_version: 'anchor-reserve-comparison-v0.1', approved_at: AS_OF,
      first_observed_at: AS_OF, last_observed_at: AS_OF,
      measurement: {
        event_id: 'anchor_measurement_example', measured_at: AS_OF, asset: ASSET,
        reserve_amount: '970', onchain_supply: '1000', absolute_delta: '30', delta_basis_points: 300,
        attestation_period_start: '2026-08-10T11:00:00.000Z', attestation_period_end: AS_OF, published_at: AS_OF,
        attestation: { schema: 'axiom-lumen-anchor-reserve-attestation-v1', document_url: 'https://anchor.example/reserves', evidence_sha256: 'a'.repeat(64) },
        source: { id: 'anchor_source_example', url: 'https://anchor.example/reserves', source_class: 'anchor_self_reported' },
        supply_reference: { snapshot_id: 'supply_snapshot_example', amount: '1000', as_of: AS_OF, ledger_sequence: 58_000_000, ledger_closed_at: AS_OF, status: 'verified', confidence: 0.95, methodology_version: 'onchain-asset-supply-v0.1' },
        confidence: { score: 0.49, formula_version: 'anchor-reserve-confidence-v0.1', components: { attestation: 1, reference: 0.95, temporal_alignment: 1 }, caps_applied: ['anchor_self_reported'] },
      },
      response: null, disputes: [], corrections: [],
    }],
    page: { next_cursor: null }, as_of: AS_OF, request_id: 'example_request', api_version: 'v1',
  })
}

export const OPENAPI_EXAMPLES = {
  latestVerified: latestExample('verified'),
  latestDegraded: latestExample('degraded'),
  latestUnavailable: latestExample('unavailable'),
  supplyVerified: supplyExample('verified'),
  supplyDegraded: supplyExample('degraded'),
  supplyUnavailable: supplyExample('unavailable'),
  depthVerified: depthExample('verified'),
  depthDegraded: depthExample('degraded'),
  depthUnavailable: depthExample('unavailable'),
  trustlineVerified: trustlineExample('verified'),
  trustlineDegraded: trustlineExample('degraded'),
  trustlineUnavailable: trustlineExample('unavailable'),
  anchorReserves: anchorReservesExample(),
  invalidRequestId: errorExample(
    'invalid_request_id',
    'X-Request-ID must be a valid identifier of at most 128 characters',
  ),
  invalidQueryParameter: errorExample('invalid_query_parameter', 'Unsupported query parameter: limit'),
  invalidAsset: errorExample('invalid_asset', 'Asset must be a canonical CODE:ISSUER credit-asset identifier'),
  invalidPair: errorExample('invalid_pair', 'Pair must be two different Stellar asset identifiers separated by ~'),
  invalidPagination: errorExample('invalid_pagination', 'anchor reserve cursor is invalid'),
  latestMissingSnapshot: errorExample(
    'latest_ledger_snapshot_not_found',
    'No finalized latest-ledger snapshot is available',
  ),
  supplyMissingSnapshot: errorExample('supply_snapshot_not_found', 'No finalized supply snapshot is available'),
  depthMissingSnapshot: errorExample('depth_snapshot_not_found', 'No finalized depth snapshot is available'),
  trustlineMissingSnapshot: errorExample('trustline_snapshot_not_found', 'No finalized trustline snapshot is available'),
  latestReadUnavailable: errorExample(
    'latest_ledger_read_unavailable',
    'The latest-ledger read model is temporarily unavailable',
  ),
  supplyReadUnavailable: errorExample(
    'supply_read_unavailable',
    'The supply read model is temporarily unavailable',
  ),
  depthReadUnavailable: errorExample('depth_read_unavailable', 'The depth read model is temporarily unavailable'),
  trustlineReadUnavailable: errorExample('trustline_read_unavailable', 'The trustline read model is temporarily unavailable'),
  authenticationError: errorExample('authentication_required', 'A valid API key is required'),
  insufficientScope: errorExample('insufficient_scope', 'The API key is not authorized for this route'),
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

const quotaHeaders = {
  'X-RateLimit-Limit': { $ref: '#/components/headers/XRateLimitLimit' },
  'X-RateLimit-Remaining': { $ref: '#/components/headers/XRateLimitRemaining' },
  'X-RateLimit-Reset': { $ref: '#/components/headers/XRateLimitReset' },
}

const authenticatedResponseHeaders = {
  ...responseHeaders,
  ...quotaHeaders,
}

const conditionalHeaders = {
  ...authenticatedResponseHeaders,
  ETag: { $ref: '#/components/headers/ETag' },
}

const accessErrorResponses = {
  401: { $ref: '#/components/responses/AuthenticationError' },
  403: { $ref: '#/components/responses/AuthorizationError' },
  429: { $ref: '#/components/responses/RateLimitError' },
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
      { name: 'Depth', description: 'Classic SDEX cumulative order-book depth reconciliation' },
      { name: 'Trustlines', description: 'Classic credit-asset trustline authorization-state reconciliation' },
      { name: 'Anchors', description: 'Reviewed, publication-approved anchor reserve disclosures' },
    ],
    paths: {
      '/api/v1/stellar/latest-ledger': {
        get: {
          operationId: 'getLatestLedger',
          security: [{ ApiKeyAuth: [] }],
          tags: ['Ledger'],
          summary: 'Get the latest finalized Public Network ledger snapshot',
          parameters: [{ $ref: '#/components/parameters/RequestId' }, { $ref: '#/components/parameters/IfNoneMatch' }],
          responses: {
            ...accessErrorResponses,
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
              headers: authenticatedResponseHeaders,
              content: errorContent({
                invalidRequestId: { $ref: '#/components/examples/InvalidRequestId' },
                invalidQueryParameter: { $ref: '#/components/examples/InvalidQueryParameter' },
              }),
            },
            404: {
              description: 'No finalized snapshot exists',
              headers: authenticatedResponseHeaders,
              content: errorContent({ missing: { $ref: '#/components/examples/LatestMissingSnapshot' } }),
            },
            503: {
              description: 'Persisted metric state, read storage, or API access storage is unavailable',
              headers: authenticatedResponseHeaders,
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
          security: [{ ApiKeyAuth: [] }],
          tags: ['Supply'],
          summary: 'Get the latest finalized Public Network supply snapshot',
          parameters: [
            { $ref: '#/components/parameters/Asset' },
            { $ref: '#/components/parameters/RequestId' },
            { $ref: '#/components/parameters/IfNoneMatch' },
          ],
          responses: {
            ...accessErrorResponses,
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
              headers: authenticatedResponseHeaders,
              content: errorContent({
                invalidAsset: { $ref: '#/components/examples/InvalidAsset' },
                invalidRequestId: { $ref: '#/components/examples/InvalidRequestId' },
                invalidQueryParameter: { $ref: '#/components/examples/InvalidQueryParameter' },
              }),
            },
            404: {
              description: 'No finalized snapshot exists for the asset',
              headers: authenticatedResponseHeaders,
              content: errorContent({ missing: { $ref: '#/components/examples/SupplyMissingSnapshot' } }),
            },
            503: {
              description: 'Persisted metric state, evidence freshness, read storage, or API access storage is unavailable',
              headers: authenticatedResponseHeaders,
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
      '/api/v1/depth/{pair}': {
        get: {
          operationId: 'getDepth', tags: ['Depth'], summary: 'Get the latest finalized Public Network SDEX depth snapshot',
          security: [{ ApiKeyAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/Pair' }, { $ref: '#/components/parameters/RequestId' }, { $ref: '#/components/parameters/IfNoneMatch' }],
          responses: {
            ...accessErrorResponses,
            200: { description: 'Current verified or degraded depth snapshot', headers: conditionalHeaders, content: { 'application/json': { schema: { $ref: '#/components/schemas/ReconciliationSnapshot' }, examples: { verified: { $ref: '#/components/examples/DepthVerified' }, degraded: { $ref: '#/components/examples/DepthDegraded' } } } } },
            304: { description: 'The representation matches If-None-Match', headers: conditionalHeaders },
            400: { description: 'Invalid pair, request header, or query parameter', headers: authenticatedResponseHeaders, content: errorContent({ invalidPair: { $ref: '#/components/examples/InvalidPair' }, invalidRequestId: { $ref: '#/components/examples/InvalidRequestId' }, invalidQueryParameter: { $ref: '#/components/examples/InvalidQueryParameter' } }) },
            404: { description: 'No finalized snapshot exists for the pair', headers: authenticatedResponseHeaders, content: errorContent({ missing: { $ref: '#/components/examples/DepthMissingSnapshot' } }) },
            503: { description: 'Persisted metric state, freshness, read storage, or API access storage is unavailable', headers: authenticatedResponseHeaders, content: { 'application/json': { schema: { oneOf: [{ $ref: '#/components/schemas/ReconciliationSnapshot' }, { $ref: '#/components/schemas/ApiErrorResponse' }] }, examples: { unavailable: { $ref: '#/components/examples/DepthUnavailable' }, readUnavailable: { $ref: '#/components/examples/DepthReadUnavailable' } } } } },
          },
        },
        options: publicOptionsOperation('depthOptions'),
      },
      '/api/v1/trustlines/{asset}': {
        get: {
          operationId: 'getTrustlines', tags: ['Trustlines'], summary: 'Get finalized Public Network trustline authorization-state counts',
          security: [{ ApiKeyAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/Asset' }, { $ref: '#/components/parameters/RequestId' }, { $ref: '#/components/parameters/IfNoneMatch' }],
          responses: {
            ...accessErrorResponses,
            200: { description: 'Current verified or degraded trustline-state snapshot', headers: conditionalHeaders, content: { 'application/json': { schema: { $ref: '#/components/schemas/ReconciliationSnapshot' }, examples: { verified: { $ref: '#/components/examples/TrustlineVerified' }, degraded: { $ref: '#/components/examples/TrustlineDegraded' } } } } },
            304: { description: 'The representation matches If-None-Match', headers: conditionalHeaders },
            400: { description: 'Invalid asset, request header, or query parameter', headers: authenticatedResponseHeaders, content: errorContent({ invalidAsset: { $ref: '#/components/examples/InvalidAsset' }, invalidRequestId: { $ref: '#/components/examples/InvalidRequestId' }, invalidQueryParameter: { $ref: '#/components/examples/InvalidQueryParameter' } }) },
            404: { description: 'No finalized snapshot exists for the asset', headers: authenticatedResponseHeaders, content: errorContent({ missing: { $ref: '#/components/examples/TrustlineMissingSnapshot' } }) },
            503: { description: 'Persisted metric state, freshness, read storage, or API access storage is unavailable', headers: authenticatedResponseHeaders, content: { 'application/json': { schema: { oneOf: [{ $ref: '#/components/schemas/ReconciliationSnapshot' }, { $ref: '#/components/schemas/ApiErrorResponse' }] }, examples: { unavailable: { $ref: '#/components/examples/TrustlineUnavailable' }, readUnavailable: { $ref: '#/components/examples/TrustlineReadUnavailable' } } } } },
          },
        },
        options: publicOptionsOperation('trustlineOptions'),
      },
      '/api/v1/anchors/{anchor}/reserves': {
        get: {
          operationId: 'getAnchorReserves', tags: ['Anchors'], summary: 'Get reviewed public reserve disclosures for a verified anchor',
          security: [{ ApiKeyAuth: [] }],
          description: 'Returns only publication-approved named-party flags and public corrections. An empty disclosures array does not reveal whether internal cases exist.',
          parameters: [{ $ref: '#/components/parameters/Anchor' }, { $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/RequestId' }, { $ref: '#/components/parameters/IfNoneMatch' }],
          responses: {
            ...accessErrorResponses,
            200: { description: 'Public disclosures, possibly empty', headers: conditionalHeaders, content: { 'application/json': { schema: { $ref: '#/components/schemas/AnchorReservesResponse' }, examples: { reviewedComparison: { $ref: '#/components/examples/AnchorReserves' } } } } },
            304: { description: 'The representation matches If-None-Match', headers: conditionalHeaders },
            400: { description: 'Invalid anchor, pagination, request header, or query parameter', headers: authenticatedResponseHeaders, content: errorContent({ invalidAnchor: { $ref: '#/components/examples/InvalidAnchor' }, invalidPagination: { $ref: '#/components/examples/InvalidPagination' }, invalidRequestId: { $ref: '#/components/examples/InvalidRequestId' }, invalidQueryParameter: { $ref: '#/components/examples/InvalidQueryParameter' } }) },
            404: { description: 'No verified anchor exists for the identifier', headers: authenticatedResponseHeaders, content: errorContent({ missing: { $ref: '#/components/examples/AnchorMissing' } }) },
            503: { description: 'The persisted public read model or API access storage is unavailable', headers: authenticatedResponseHeaders, content: errorContent({ readUnavailable: { $ref: '#/components/examples/AnchorReadUnavailable' } }) },
          },
        },
        options: publicOptionsOperation('anchorReservesOptions'),
      },
    },
    components: {
      schemas: {
        LatestLedgerResponse: componentSchema(latestLedgerResponseSchema, 'LatestLedgerResponse'),
        ReconciliationSnapshot: componentSchema(apiReconciliationSnapshotSchema, 'ReconciliationSnapshot'),
        AnchorReservesResponse: componentSchema(apiAnchorReservesResponseSchema, 'AnchorReservesResponse'),
        ApiErrorResponse: componentSchema(apiErrorResponseSchema, 'ApiErrorResponse'),
      },
      responses: {
        AuthenticationError: {
          description: 'API key is missing, malformed, expired, revoked, or inactive when authentication is required',
          headers: responseHeaders,
          content: errorContent({ authentication: { $ref: '#/components/examples/AuthenticationError' } }),
        },
        AuthorizationError: {
          description: 'The authenticated principal does not hold the scope required by this route, or the route is disabled for its plan',
          headers: responseHeaders,
          content: errorContent({ authorization: { $ref: '#/components/examples/AuthorizationError' } }),
        },
        RateLimitError: {
          description: 'The authenticated principal exhausted its sustained or burst quota for the current route window',
          headers: {
            ...responseHeaders,
            'Retry-After': { $ref: '#/components/headers/RetryAfter' },
            'X-RateLimit-Limit': { $ref: '#/components/headers/XRateLimitLimit' },
            'X-RateLimit-Remaining': { $ref: '#/components/headers/XRateLimitRemaining' },
            'X-RateLimit-Reset': { $ref: '#/components/headers/XRateLimitReset' },
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
          schema: { type: 'string', pattern: '^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$' },
          example: ASSET,
        },
        Pair: {
          name: 'pair', in: 'path', required: true,
          description: 'Canonical unordered pair as BASE~COUNTER; native sorts before credit assets',
          schema: { type: 'string', pattern: '^(?:native|[A-Za-z0-9]{1,12}:G[A-Z2-7]{55})~(?:native|[A-Za-z0-9]{1,12}:G[A-Z2-7]{55})$' }, example: PAIR,
        },
        Anchor: {
          name: 'anchor', in: 'path', required: true,
          description: 'Canonical verified anchor identifier',
          schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' }, example: 'anchor_example',
        },
        Cursor: {
          name: 'cursor', in: 'query', required: false,
          description: 'Opaque cursor returned by the preceding anchor disclosure page',
          schema: { type: 'string', minLength: 1, maxLength: 512 },
        },
        Limit: {
          name: 'limit', in: 'query', required: false,
          description: 'Disclosure page size; defaults to 25 and cannot exceed 100',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
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
        Vary: { description: 'Cache representation varies by request identifier and API credential', schema: { type: 'string', enum: ['X-Request-ID, X-Axiom-Key'] } },
        RetryAfter: { description: 'Seconds until a quota-limited request may be retried', schema: { type: 'string', pattern: '^\\d+$' } },
        XRateLimitLimit: { description: 'Maximum requests in the current plan window', schema: { type: 'string', pattern: '^[1-9]\\d*$' } },
        XRateLimitRemaining: { description: 'Requests remaining after this request', schema: { type: 'string', pattern: '^\\d+$' } },
        XRateLimitReset: { description: 'UTC Unix timestamp when the fixed window resets', schema: { type: 'string', pattern: '^\\d+$' } },
      },
      examples: {
        LatestVerified: { summary: 'Verified latest ledger', value: OPENAPI_EXAMPLES.latestVerified },
        LatestDegraded: { summary: 'Degraded latest ledger', value: OPENAPI_EXAMPLES.latestDegraded },
        LatestUnavailable: { summary: 'Unavailable latest ledger', value: OPENAPI_EXAMPLES.latestUnavailable },
        SupplyVerified: { summary: 'Verified supply', value: OPENAPI_EXAMPLES.supplyVerified },
        SupplyDegraded: { summary: 'Degraded supply', value: OPENAPI_EXAMPLES.supplyDegraded },
        SupplyUnavailable: { summary: 'Unavailable or stale supply', value: OPENAPI_EXAMPLES.supplyUnavailable },
        DepthVerified: { summary: 'Verified depth', value: OPENAPI_EXAMPLES.depthVerified },
        DepthDegraded: { summary: 'Degraded depth', value: OPENAPI_EXAMPLES.depthDegraded },
        DepthUnavailable: { summary: 'Unavailable or stale depth', value: OPENAPI_EXAMPLES.depthUnavailable },
        TrustlineVerified: { summary: 'Verified trustline state', value: OPENAPI_EXAMPLES.trustlineVerified },
        TrustlineDegraded: { summary: 'Degraded trustline state', value: OPENAPI_EXAMPLES.trustlineDegraded },
        TrustlineUnavailable: { summary: 'Unavailable or stale trustline state', value: OPENAPI_EXAMPLES.trustlineUnavailable },
        AnchorReserves: { summary: 'Reviewed reserve comparison disclosure', value: OPENAPI_EXAMPLES.anchorReserves },
        InvalidRequestId: { summary: 'Invalid request identifier', value: OPENAPI_EXAMPLES.invalidRequestId },
        InvalidQueryParameter: { summary: 'Unsupported query parameter', value: OPENAPI_EXAMPLES.invalidQueryParameter },
        InvalidAsset: { summary: 'Invalid supply asset', value: OPENAPI_EXAMPLES.invalidAsset },
        InvalidPair: { summary: 'Invalid depth pair', value: OPENAPI_EXAMPLES.invalidPair },
        InvalidAnchor: { summary: 'Invalid anchor identifier', value: errorExample('invalid_anchor', 'Anchor must be a valid canonical identifier') },
        InvalidPagination: { summary: 'Invalid anchor disclosure pagination', value: OPENAPI_EXAMPLES.invalidPagination },
        LatestMissingSnapshot: { summary: 'No finalized latest-ledger snapshot', value: OPENAPI_EXAMPLES.latestMissingSnapshot },
        SupplyMissingSnapshot: { summary: 'No finalized supply snapshot', value: OPENAPI_EXAMPLES.supplyMissingSnapshot },
        DepthMissingSnapshot: { summary: 'No finalized depth snapshot', value: OPENAPI_EXAMPLES.depthMissingSnapshot },
        TrustlineMissingSnapshot: { summary: 'No finalized trustline snapshot', value: OPENAPI_EXAMPLES.trustlineMissingSnapshot },
        AnchorMissing: { summary: 'No verified anchor', value: errorExample('anchor_not_found', 'No verified anchor is available for this identifier') },
        LatestReadUnavailable: { summary: 'Latest-ledger read storage unavailable', value: OPENAPI_EXAMPLES.latestReadUnavailable },
        SupplyReadUnavailable: { summary: 'Supply read storage unavailable', value: OPENAPI_EXAMPLES.supplyReadUnavailable },
        DepthReadUnavailable: { summary: 'Depth read storage unavailable', value: OPENAPI_EXAMPLES.depthReadUnavailable },
        TrustlineReadUnavailable: { summary: 'Trustline read storage unavailable', value: OPENAPI_EXAMPLES.trustlineReadUnavailable },
        AnchorReadUnavailable: { summary: 'Anchor reserve read storage unavailable', value: errorExample('anchor_reserves_read_unavailable', 'The anchor reserve read model is temporarily unavailable') },
        AuthenticationError: {
          summary: 'Authentication is required but the supplied API key is not usable',
          value: OPENAPI_EXAMPLES.authenticationError,
        },
        AuthorizationError: {
          summary: 'The API key lacks the scope required by the route',
          value: OPENAPI_EXAMPLES.insufficientScope,
        },
        RateLimitError: {
          summary: 'The current API-key plan window is exhausted',
          value: OPENAPI_EXAMPLES.rateLimitError,
        },
      },
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Axiom-Key',
          description: 'Required by the hosted API contract. Plaintext keys are shown only when issued.',
        },
      },
    },
  } as const
}

export type AxiomOpenApiDocument = ReturnType<typeof createOpenApiDocument>
