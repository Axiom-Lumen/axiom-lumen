import {
  apiErrorResponseSchema,
  apiReconciliationSnapshotSchema,
  formatAssetId,
  parseAssetId,
  type ApiErrorResponse,
  type ApiReconciliationSnapshot,
} from '../contracts'

export const DEFAULT_ASSET =
  'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

const ILLUSTRATIVE_AS_OF = '2026-08-10T12:00:00.000Z'
const DEFAULT_APP_URL = 'http://localhost:3000'
const FETCH_TIMEOUT_MS = 3_000

export type ConfidenceArtifactState =
  | {
      kind: 'verified' | 'degraded' | 'stale'
      asset: string
      snapshot: ApiReconciliationSnapshot
    }
  | {
      kind: 'unavailable'
      asset: string
      response: ApiReconciliationSnapshot | ApiErrorResponse
    }
  | { kind: 'empty'; asset: string }
  | {
      kind: 'error'
      asset: string
      reason: 'configuration' | 'request_failed' | 'invalid_response' | 'unexpected_status'
    }

interface LoadConfidenceArtifactOptions {
  asset?: string
  appUrl?: string
  fetcher?: typeof fetch
  timeoutMs?: number
}

export function resolveConfidenceAsset(value = process.env.AXIOM_DEFAULT_ASSET ?? DEFAULT_ASSET) {
  const asset = parseAssetId(value)
  if (asset.kind !== 'credit') throw new Error('confidence artifact requires a credit asset')
  return formatAssetId(asset)
}

function resolveAppUrl(value = process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_APP_URL) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('application URL must be an HTTP(S) origin without credentials')
  }
  return url
}

function isRequestedSupplySnapshot(payload: unknown, asset: string) {
  const parsed = apiReconciliationSnapshotSchema.safeParse(payload)
  if (!parsed.success) return null
  if (
    parsed.data.metric !== 'onchain_asset_supply'
    || parsed.data.subject.kind !== 'asset'
    || parsed.data.subject.asset !== asset
  ) {
    return null
  }
  return parsed.data
}

function isStale(snapshot: ApiReconciliationSnapshot) {
  return snapshot.confidence_caps_applied.includes('snapshot_stale')
    || snapshot.source_errors.some((error) => error.code === 'stale_observation')
}

export async function loadConfidenceArtifact(
  options: LoadConfidenceArtifactOptions = {},
): Promise<ConfidenceArtifactState> {
  let asset = DEFAULT_ASSET
  let endpoint: URL
  try {
    asset = resolveConfidenceAsset(options.asset)
    endpoint = new URL(`/api/v1/supply/${encodeURIComponent(asset)}`, resolveAppUrl(options.appUrl))
  } catch {
    return { kind: 'error', asset, reason: 'configuration' }
  }

  let response: Response
  try {
    response = await (options.fetcher ?? fetch)(endpoint, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
    })
  } catch {
    return { kind: 'error', asset, reason: 'request_failed' }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { kind: 'error', asset, reason: 'invalid_response' }
  }

  if (response.status === 200) {
    const snapshot = isRequestedSupplySnapshot(payload, asset)
    if (!snapshot || snapshot.status === 'unavailable') {
      return { kind: 'error', asset, reason: 'invalid_response' }
    }
    return { kind: snapshot.status, asset, snapshot }
  }

  if (response.status === 404) {
    const parsed = apiErrorResponseSchema.safeParse(payload)
    return parsed.success && parsed.data.error.code === 'supply_snapshot_not_found'
      ? { kind: 'empty', asset }
      : { kind: 'error', asset, reason: 'invalid_response' }
  }

  if (response.status === 503) {
    const snapshot = isRequestedSupplySnapshot(payload, asset)
    if (snapshot) {
      return isStale(snapshot)
        ? { kind: 'stale', asset, snapshot }
        : { kind: 'unavailable', asset, response: snapshot }
    }
    const error = apiErrorResponseSchema.safeParse(payload)
    return error.success
      ? { kind: 'unavailable', asset, response: error.data }
      : { kind: 'error', asset, reason: 'invalid_response' }
  }

  return { kind: 'error', asset, reason: 'unexpected_status' }
}

export function createIllustrativeSupplyArtifact(asset = DEFAULT_ASSET) {
  const canonicalAsset = resolveConfidenceAsset(asset)
  return apiReconciliationSnapshotSchema.parse({
    metric: 'onchain_asset_supply',
    subject: { kind: 'asset', asset: canonicalAsset },
    status: 'unavailable',
    value: null,
    confidence: 0,
    confidence_formula_version: 'onchain-asset-supply-confidence-v0.1',
    confidence_components: { agreement: 0, freshness: 0, availability: 0, spread: 0 },
    confidence_caps_applied: [],
    sources_configured: 0,
    sources_responded: 0,
    sources_usable: 0,
    sources_agreeing: 0,
    sources_excluded: 0,
    contributions: [],
    discrepancies: [],
    source_errors: [],
    as_of: ILLUSTRATIVE_AS_OF,
    methodology_version: 'onchain-asset-supply-v0.1',
    request_id: 'illustrative_example',
    api_version: 'v1',
  })
}
