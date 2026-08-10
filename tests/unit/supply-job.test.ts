import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeEvidenceSha256 } from '../../lib/evidence/json'
import type { PersistenceRepositories } from '../../lib/db/repositories'
import type { ClaimedCycle, DiscoveredIngestJob } from '../../lib/db/scheduler-repository'
import { createSupplyJobHandler } from '../../lib/worker/supply-job'
import type { SourceResiliencePolicy } from '../../lib/worker/resilience'

const ISSUER = `G${'A'.repeat(55)}`
const PASSPHRASE = 'Public Global Stellar Network ; September 2015'
const ASSET_ID = `USDC:${ISSUER}`
const SUBJECT_KEY = `public:${ASSET_ID}`
const NOW = new Date('2026-08-10T12:00:05.000Z')
const archiveFixture = JSON.parse(readFileSync(
  new URL('../fixtures/stellar/archive-supply-replay-v1.redacted.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>
const horizonFixture = JSON.parse(readFileSync(
  new URL('../fixtures/stellar/horizon-supply-asset.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>
const trustedCheckpoint = {
  ledgerSequence: 500,
  ledgerHash: 'f4180bce5da1a4c4a48e2f2982dcc324cd69b6ee34f7beeacacee6cf47b829eb',
  artifactSha256: computeEvidenceSha256(archiveFixture),
  provenance: {
    manifestId: 'public_archive_manifest_500',
    source: 'https://checkpoints.example/public/500.manifest.json',
    verificationMethod: 'trusted_manifest_signature',
    verificationEvidenceSha256: '9ca9a7aec5d9d46e2b3fcae74360dcddb7123778c0d887d32ea5ebb3ab7aa383',
    verifiedAt: '2026-08-10T12:00:00.000Z',
  },
}
const job: DiscoveredIngestJob = {
  metric: 'circulating_supply',
  subjectKey: SUBJECT_KEY,
  methodologyVersion: 'onchain-asset-supply-v0.1',
  asset: { kind: 'credit', code: 'USDC', issuer: ISSUER },
  sources: [
    {
      id: 'horizon_1',
      url: 'https://horizon.example',
      sourceClass: 'canonical_ledger',
      adapter: 'horizon',
      upstreamId: null,
      networkId: 'public',
      networkPassphrase: PASSPHRASE,
    },
    {
      id: 'archive_1',
      url: 'https://archive.example/usdc-500.json',
      sourceClass: 'archive',
      adapter: 'archive',
      upstreamId: null,
      networkId: 'public',
      networkPassphrase: PASSPHRASE,
      trustedCheckpoint,
    },
  ],
}
const lease: ClaimedCycle = {
  id: 'cycle_supply_500',
  metric: 'circulating_supply',
  subjectKey: SUBJECT_KEY,
  methodologyVersion: 'onchain-asset-supply-v0.1',
  idempotencyKey: `circulating_supply:${SUBJECT_KEY}:onchain-asset-supply-v0.1:2026-08-10T12:00:00.000Z`,
  scheduledAt: '2026-08-10T12:00:00.000Z',
  leaseOwner: 'worker_1',
  leaseToken: 1,
  leaseExpiresAt: '2026-08-10T12:01:00.000Z',
  attemptCount: 1,
}
const policy: SourceResiliencePolicy = {
  maxAttempts: 1,
  baseDelayMs: 10,
  maxDelayMs: 10,
  jitterRatio: 0,
  concurrency: 2,
  circuitFailureThreshold: 2,
  circuitCooldownMs: 60_000,
}

function repositories() {
  return {
    getSourceHealthStates: vi.fn(async () => ({})),
    getDiscrepancyStates: vi.fn(async () => ({})),
  } as unknown as PersistenceRepositories
}

function connectorFetch(archivePayload: unknown = archiveFixture, ledgerClosedAt = '2026-08-10T11:59:55Z') {
  return vi.fn(async (url: string | URL | Request) => {
    const target = String(url)
    if (target === 'https://horizon.example/') return Response.json({ network_passphrase: PASSPHRASE })
    if (target === `https://horizon.example/accounts/${ISSUER}`) {
      return Response.json({ account_id: ISSUER }, { headers: { 'Latest-Ledger': '499' } })
    }
    if (target.startsWith('https://horizon.example/assets?')) {
      return Response.json(
        { _links: {}, _embedded: { records: [horizonFixture] } },
        { headers: { 'Latest-Ledger': '500' } },
      )
    }
    if (target === 'https://horizon.example/ledgers/500') {
      return Response.json({ sequence: 500, closed_at: ledgerClosedAt })
    }
    if (target === 'https://archive.example/usdc-500.json') return Response.json(archivePayload)
    throw new Error(`unexpected URL ${target}`)
  })
}

describe('supply worker job', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('runs Horizon and archive fixtures into a verification-eligible persistence batch', async () => {
    vi.stubGlobal('fetch', connectorFetch())
    const handler = createSupplyJobHandler(repositories(), () => new Date(NOW), { resiliencePolicy: policy })

    const batch = await handler({ lease, job, signal: new AbortController().signal })

    expect(batch.snapshot).toMatchObject({
      metric: 'circulating_supply',
      status: 'verified',
      value: { kind: 'amount' },
      sourcesConfigured: 2,
      sourcesUsable: 2,
      sourcesAgreeing: 2,
    })
    expect(batch.readings).toHaveLength(2)
    expect(batch.attempts).toHaveLength(2)
    expect(batch.events).toHaveLength(0)
    expect(batch.readings.map((reading) => reading.rawPayload)).toEqual([
      expect.objectContaining({
        observation: expect.objectContaining({
          ledgerSequence: 500,
          derivation: expect.objectContaining({ family: 'horizon_asset_aggregate' }),
        }),
        evidence: expect.objectContaining({ pageMetadata: expect.any(Object) }),
      }),
      expect.objectContaining({
        observation: expect.objectContaining({ ledgerSequence: 500, derivation: expect.any(Object) }),
        evidence: expect.objectContaining({ rawPayload: expect.any(Object), request: expect.any(Object) }),
      }),
    ])
  })

  it('persists stale raw evidence but excludes it from the current snapshot', async () => {
    const staleArchive = structuredClone(archiveFixture)
    ;(staleArchive.ledger as Record<string, unknown>).closed_at = '2026-08-10T11:58:00Z'
    const staleJob = structuredClone(job)
    staleJob.sources[1]!.trustedCheckpoint = {
      ...trustedCheckpoint,
      artifactSha256: computeEvidenceSha256(staleArchive),
    }
    vi.stubGlobal('fetch', connectorFetch(staleArchive, '2026-08-10T11:58:00Z'))
    const handler = createSupplyJobHandler(repositories(), () => new Date(NOW), { resiliencePolicy: policy })

    const batch = await handler({ lease, job: staleJob, signal: new AbortController().signal })

    expect(batch.snapshot).toMatchObject({
      status: 'unavailable',
      value: null,
      sourcesResponded: 2,
      sourcesUsable: 0,
      sourceErrors: [
        expect.objectContaining({ sourceId: 'archive_1', code: 'stale_observation' }),
        expect.objectContaining({ sourceId: 'horizon_1', code: 'stale_observation' }),
      ],
    })
    expect(batch.readings).toHaveLength(2)
    expect(batch.sourceHealthStates).toEqual([
      expect.objectContaining({ sourceId: 'horizon_1', state: 'stale' }),
      expect.objectContaining({ sourceId: 'archive_1', state: 'stale' }),
    ])
  })

  it('produces an unavailable snapshot without reusing readings when every source fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    const handler = createSupplyJobHandler(repositories(), () => new Date(NOW), { resiliencePolicy: policy })

    const batch = await handler({ lease, job, signal: new AbortController().signal })

    expect(batch.snapshot).toMatchObject({ status: 'unavailable', value: null, sourcesUsable: 0 })
    expect(batch.readings).toHaveLength(0)
    expect(batch.attempts).toHaveLength(2)
  })

  it('contains a thrown source-contract failure and preserves healthy unrelated evidence', async () => {
    const invalidJob = structuredClone(job)
    invalidJob.sources[0]!.sourceClass = 'archive'
    vi.stubGlobal('fetch', connectorFetch())
    const handler = createSupplyJobHandler(repositories(), () => new Date(NOW), { resiliencePolicy: policy })

    const batch = await handler({ lease, job: invalidJob, signal: new AbortController().signal })

    expect(batch.snapshot).toMatchObject({
      status: 'degraded',
      sourcesUsable: 1,
      sourceErrors: [expect.objectContaining({ sourceId: 'horizon_1', code: 'invalid_configuration' })],
    })
    expect(batch.readings).toHaveLength(1)
    expect(batch.readings[0]?.sourceId).toBe('archive_1')
  })
})
