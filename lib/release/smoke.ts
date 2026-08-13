import { readFileSync } from 'node:fs'
import {
  apiAnchorReservesResponseSchema,
  apiErrorResponseSchema,
  apiReconciliationSnapshotSchema,
} from '../contracts'
import { latestLedgerResponseSchema } from '../reconcile/latest-ledger'
import { parseReleaseFeatureFlags, type ReleaseFeatureFlags } from './config'
import { parseReleaseManifest, promotableEnvironmentSchema, type ReleaseManifest } from './manifest'

type FetchClient = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface ReleaseSmokeInput {
  baseUrl: URL
  manifest: ReleaseManifest
  environment: string
  features: ReleaseFeatureFlags
  apiKey: string
  asset: string
  pair: string
  anchor: string
  workerProgressAfter: Date
  workerProgressTimeoutMs?: number
  pollIntervalMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  fetchClient?: FetchClient
}

export function releaseSmokeInputFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReleaseSmokeInput {
  const baseUrl = new URL(environment.RELEASE_BASE_URL ?? '')
  if (
    baseUrl.protocol !== 'https:'
    || baseUrl.username
    || baseUrl.password
    || baseUrl.pathname !== '/'
    || baseUrl.search
    || baseUrl.hash
  ) {
    throw new Error('RELEASE_BASE_URL must be a credential-free HTTPS origin')
  }
  const manifestPath = environment.RELEASE_MANIFEST_PATH
  if (!manifestPath) throw new Error('RELEASE_MANIFEST_PATH is required')
  const apiKey = environment.AXIOM_SMOKE_API_KEY
  if (!apiKey) throw new Error('AXIOM_SMOKE_API_KEY is required for hosted release smoke checks')
  const asset = environment.AXIOM_SMOKE_ASSET
  if (!asset) throw new Error('AXIOM_SMOKE_ASSET is required')
  const pair = environment.AXIOM_SMOKE_PAIR
  if (!pair) throw new Error('AXIOM_SMOKE_PAIR is required')
  const anchor = environment.AXIOM_SMOKE_ANCHOR
  if (!anchor) throw new Error('AXIOM_SMOKE_ANCHOR is required')
  const workerProgressAfter = new Date(environment.RELEASE_WORKER_PROGRESS_AFTER ?? '')
  if (!Number.isFinite(workerProgressAfter.getTime())) throw new Error('RELEASE_WORKER_PROGRESS_AFTER must be a UTC timestamp')
  return {
    baseUrl,
    manifest: parseReleaseManifest(JSON.parse(readFileSync(manifestPath, 'utf8'))),
    environment: promotableEnvironmentSchema.parse(environment.RELEASE_ENVIRONMENT),
    features: parseReleaseFeatureFlags(environment),
    apiKey,
    asset,
    pair,
    anchor,
    workerProgressAfter,
  }
}

export async function runReleaseSmoke(input: ReleaseSmokeInput) {
  if (!Number.isFinite(input.workerProgressAfter.getTime())) {
    throw new Error('worker progress cutoff must be a valid timestamp')
  }
  const fetchClient = input.fetchClient ?? fetch
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  async function request(path: string) {
    const response = await fetchClient(new URL(path, input.baseUrl), {
      headers: { 'X-Axiom-Key': input.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    const body: unknown = await response.json()
    return { response, body }
  }

  const live = await request('/api/health/live')
  const liveBody = live.body as {
    release?: { environment?: string, imageDigest?: string, commitSha?: string } | null
    features?: unknown
  }
  if (
    live.response.status !== 200
    || liveBody.release?.imageDigest !== input.manifest.image_digest
    || liveBody.release?.commitSha !== input.manifest.commit_sha
    || liveBody.release?.environment !== input.environment
  ) {
    throw new Error('liveness did not report the promoted environment, commit, and image digest')
  }
  if (JSON.stringify(liveBody.features) !== JSON.stringify(input.features)) {
    throw new Error('liveness feature flags do not match the promoted release configuration')
  }

  const ready = await request('/api/health/ready')
  if (ready.response.status !== 200) throw new Error('deployment readiness failed')

  const progressDeadline = Date.now() + (input.workerProgressTimeoutMs ?? 180_000)
  while (true) {
    let progressFailure = 'latest-ledger has not advanced beyond the rollout cutoff'
    try {
      const latest = await request('/api/v1/stellar/latest-ledger')
      if (latest.response.status !== 200) {
        progressFailure = `latest-ledger returned HTTP ${latest.response.status}`
      } else {
        const parsed = latestLedgerResponseSchema.safeParse(latest.body)
        if (!parsed.success) {
          progressFailure = 'latest-ledger returned an invalid response contract'
        } else if (Date.parse(parsed.data.as_of) > input.workerProgressAfter.getTime()) {
          break
        }
      }
    } catch (error) {
      progressFailure = error instanceof Error ? error.message : 'latest-ledger request failed'
    }
    if (Date.now() >= progressDeadline) {
      throw new Error(`worker did not finalize a latest-ledger cycle after rollout: ${progressFailure}`)
    }
    await sleep(input.pollIntervalMs ?? 5_000)
  }

  const checks = [
    { path: `/api/v1/supply/${encodeURIComponent(input.asset)}`, enabled: input.features.supply, schema: apiReconciliationSnapshotSchema, metric: 'onchain_asset_supply' },
    { path: `/api/v1/depth/${encodeURIComponent(input.pair)}`, enabled: input.features.depth, schema: apiReconciliationSnapshotSchema, metric: 'order_book_depth' },
    { path: `/api/v1/trustlines/${encodeURIComponent(input.asset)}`, enabled: input.features.trustlines, schema: apiReconciliationSnapshotSchema, metric: 'trustline_state' },
    { path: `/api/v1/anchors/${encodeURIComponent(input.anchor)}/reserves`, enabled: input.features.anchorReserves, schema: apiAnchorReservesResponseSchema },
  ] as const

  for (const check of checks) {
    const result = await request(check.path)
    if (!check.enabled) {
      const error = apiErrorResponseSchema.safeParse(result.body)
      if (result.response.status !== 404 || !error.success || error.data.error.code !== 'feature_not_available') {
        throw new Error(`${check.path} did not return the disabled feature contract`)
      }
      continue
    }
    if (result.response.status !== 200) {
      throw new Error(`${check.path} did not return a successful representative read (${result.response.status})`)
    }
    const parsed = check.schema.safeParse(result.body)
    if (!parsed.success) throw new Error(`${check.path} returned an invalid response contract`)
    if ('metric' in check && (result.body as { metric?: unknown }).metric !== check.metric) {
      throw new Error(`${check.path} returned the wrong metric`)
    }
  }

  const statusPage = await fetchClient(new URL('/status', input.baseUrl), {
    headers: { 'X-Axiom-Key': input.apiKey, Accept: 'text/html' },
    signal: AbortSignal.timeout(10_000),
  })
  const statusBody = await statusPage.text()
  if (
    statusPage.status !== 200
    || !statusPage.headers.get('content-type')?.includes('text/html')
    || !statusBody.includes('AL-OPS-01')
  ) {
    throw new Error('/status did not return the persisted operational status page')
  }

  const streamController = new AbortController()
  const streamTimeout = setTimeout(() => streamController.abort(), 10_000)
  try {
    const stream = await fetchClient(new URL('/api/v1/events/snapshots', input.baseUrl), {
      headers: { 'X-Axiom-Key': input.apiKey, Accept: 'text/event-stream' },
      signal: streamController.signal,
    })
    if (stream.status !== 200 || !stream.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('/api/v1/events/snapshots did not open an event stream')
    }
    if (!stream.body) throw new Error('/api/v1/events/snapshots returned no stream body')
    const reader = stream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (buffer.length < 8_192) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      if (buffer.includes('\n\n')) break
    }
    await reader.cancel().catch(() => undefined)
    streamController.abort()
    if (!/(?:^|\n)(?:retry:|: heartbeat|event: snapshot|id: )/m.test(buffer)) {
      throw new Error('/api/v1/events/snapshots did not emit a contract-valid stream preface')
    }
  } finally {
    clearTimeout(streamTimeout)
  }

  return { status: 'passed' as const, image_digest: input.manifest.image_digest }
}
