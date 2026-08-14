import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { circulatingSupplyObservationSchema } from '../../lib/contracts/domain'
import { computeEvidenceSha256 } from '../../lib/evidence/json'
import {
  fetchArchiveSupplyObservation,
} from '../../lib/stellar/archive-supply'
import { PUBLIC_NETWORK_PASSPHRASE } from '../../lib/stellar/horizon'
import { parseStellarAmount } from '../../lib/stellar/amount'
import { assessSupplyEvidence, fetchHorizonRawSupplyObservation } from '../../lib/stellar/supply-observation'

const ISSUER = `G${'A'.repeat(55)}`
const NETWORK = { id: 'public' as const, passphrase: PUBLIC_NETWORK_PASSPHRASE }
const ASSET = { kind: 'credit' as const, code: 'USDC', issuer: ISSUER }
const TRUSTED_CHECKPOINT = {
  ledgerSequence: 500,
  ledgerHash: 'f4180bce5da1a4c4a48e2f2982dcc324cd69b6ee34f7beeacacee6cf47b829eb',
  artifactSha256: 'b742669c897c3f0ebedc1ef30dc34bb876539bc2de3b2968258239e59e65be98',
  provenance: {
    manifestId: 'public_archive_manifest_500',
    source: 'https://checkpoints.example/public/500.manifest.json',
    verificationMethod: 'trusted_manifest_signature' as const,
    verificationEvidenceSha256: '9ca9a7aec5d9d46e2b3fcae74360dcddb7123778c0d887d32ea5ebb3ab7aa383',
    verifiedAt: '2026-08-10T12:00:30.000Z',
  },
}
const ARCHIVE_SOURCE = {
  id: 'archive_replay_1',
  sourceClass: 'archive' as const,
  adapter: 'archive' as const,
  url: 'https://archive.example/evidence/usdc-500.json',
  network: NETWORK,
}
const HORIZON_SOURCE = {
  id: 'horizon_1',
  sourceClass: 'canonical_ledger' as const,
  adapter: 'horizon' as const,
  url: 'https://horizon.example',
  network: NETWORK,
}
const NOW = new Date('2026-08-10T12:01:00.000Z')
const artifactFixture = JSON.parse(readFileSync(
  new URL('../fixtures/stellar/archive-supply-replay-v1.redacted.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>
const fixtureProvenance = JSON.parse(readFileSync(
  new URL('../fixtures/stellar/archive-supply-replay-v1.redacted.provenance.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>
const horizonAssetFixture = JSON.parse(readFileSync(
  new URL('../fixtures/stellar/horizon-supply-asset.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>

async function collectArchive(
  payload: unknown = artifactFixture,
  options: Record<string, unknown> = {},
) {
  return fetchArchiveSupplyObservation({
    observationId: 'observation_archive_500',
    cycleId: 'cycle_supply_500',
    source: ARCHIVE_SOURCE,
    asset: ASSET,
    expectedNetwork: NETWORK,
    trustedCheckpoint: TRUSTED_CHECKPOINT,
    fetchImpl: vi.fn(async () => Response.json(payload)),
    clock: () => new Date(NOW),
    ...options,
  })
}

function trustedCheckpointFor(payload: unknown) {
  return { ...TRUSTED_CHECKPOINT, artifactSha256: computeEvidenceSha256(payload) }
}

describe('fetchArchiveSupplyObservation', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('parses recorded redacted replay evidence into the shared raw observation contract', async () => {
    const result = await collectArchive()

    expect(result.error).toBeUndefined()
    expect(result.observation).toMatchObject({
      observationId: 'observation_archive_500',
      cycleId: 'cycle_supply_500',
      metric: 'circulating_supply',
      asset: ASSET,
      ledgerSequence: 500,
      methodologyVersion: 'onchain-asset-supply-v0.1',
      provenance: {
        source: ARCHIVE_SOURCE,
        sourceTimestamp: '2026-08-10T11:59:55.000Z',
        retrievedAt: NOW.toISOString(),
      },
      derivation: {
        family: 'history_archive_state_replay',
        connectorVersion: 'archive-supply-v0.1',
        software: {
          name: '[redacted]',
          version: '1.0.0',
          stellarCoreVersion: '24.0.0',
        },
        checkpoint: {
          ledgerSequence: 500,
          replayStartLedger: 1,
          replayEndLedger: 500,
          trustedArtifactSha256: TRUSTED_CHECKPOINT.artifactSha256,
          trustProvenance: TRUSTED_CHECKPOINT.provenance,
        },
      },
    })
    expect(result.observation?.amount.toString()).toBe('1000')
    expect(result.evidence?.request.payloadSha256).toMatch(/^[0-9a-f]{64}$/)

    const independentTotal = Object.values((artifactFixture.components as Record<string, string>))
      .map((amount) => BigInt(amount.replace('.', '')))
      .reduce((sum, amount) => sum + amount, 0n)
    expect(result.observation?.amount.toStroops()).toBe(independentTotal)
    expect(fixtureProvenance).toMatchObject({
      capture_type: 'recorded_replay_tool_output',
      artifact_sha256: computeEvidenceSha256(artifactFixture),
      redactions: ['asset.issuer', 'derivation.replay_tool.name'],
    })
  })

  it('produces a distinct derivation family that is comparable to Horizon at the same ledger', async () => {
    const archive = await collectArchive()
    const horizonFetch = vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === 'https://horizon.example/') return Response.json({ network_passphrase: PUBLIC_NETWORK_PASSPHRASE })
      if (target === `https://horizon.example/accounts/${ISSUER}`) {
        return Response.json({ account_id: ISSUER }, { headers: { 'Latest-Ledger': '499' } })
      }
      if (target.startsWith('https://horizon.example/assets?')) {
        return Response.json(
          { _links: {}, _embedded: { records: [horizonAssetFixture] } },
          { headers: { 'Latest-Ledger': '500' } },
        )
      }
      if (target === 'https://horizon.example/ledgers/500') {
        return Response.json({ sequence: 500, closed_at: '2026-08-10T11:59:55Z' })
      }
      throw new Error(`Unexpected request: ${target}`)
    })
    const horizonResult = await fetchHorizonRawSupplyObservation({
      observationId: 'observation_horizon_500',
      cycleId: 'cycle_supply_500',
      source: HORIZON_SOURCE,
      asset: ASSET,
      expectedNetwork: NETWORK,
      fetchImpl: horizonFetch,
      clock: () => new Date(NOW),
    })
    const horizon = horizonResult.observation!

    expect(archive.observation?.ledgerSequence).toBe(horizon.ledgerSequence)
    expect(archive.observation?.amount.equals(horizon.amount)).toBe(true)
    expect(new Set([archive.observation?.derivation.family, horizon.derivation.family])).toEqual(
      new Set(['history_archive_state_replay', 'horizon_asset_aggregate']),
    )
    expect(new Set([archive.observation?.provenance.source.sourceClass, horizon.provenance.source.sourceClass])).toEqual(
      new Set(['archive', 'canonical_ledger']),
    )
    expect(assessSupplyEvidence([horizon, archive.observation])).toEqual({
      statusCeiling: 'verified',
      reason: 'verification_eligible',
      eligibleDerivationFamilies: ['history_archive_state_replay', 'horizon_asset_aggregate'],
    })

    const horizonReplica = {
      ...horizon,
      observationId: 'observation_horizon_replica_500',
      provenance: {
        ...horizon.provenance,
        source: { ...horizon.provenance.source, id: 'horizon_2', url: 'https://horizon-2.example' },
      },
    }
    expect(assessSupplyEvidence([horizon, horizonReplica])).toMatchObject({
      statusCeiling: 'degraded',
      reason: 'insufficient_independent_derivations',
      eligibleDerivationFamilies: ['horizon_asset_aggregate'],
    })

    expect(assessSupplyEvidence([])).toEqual({
      statusCeiling: 'unavailable',
      reason: 'no_observations',
      eligibleDerivationFamilies: [],
    })

    const archiveObservation = archive.observation!
    const incompatibleCases = [
      {
        expected: 'incompatible_asset',
        observation: { ...archiveObservation, asset: { ...ASSET, code: 'EURC' } },
      },
      {
        expected: 'incompatible_network',
        observation: {
          ...archiveObservation,
          provenance: {
            ...archiveObservation.provenance,
            source: {
              ...archiveObservation.provenance.source,
              network: { id: 'testnet' as const, passphrase: 'Test SDF Network ; September 2015' },
            },
          },
        },
      },
      {
        expected: 'incompatible_ledger',
        observation: {
          ...archiveObservation,
          ledgerSequence: 501,
          derivation: {
            ...archiveObservation.derivation,
            checkpoint: {
              ...archiveObservation.derivation.checkpoint,
              ledgerSequence: 501,
              replayEndLedger: 501,
            },
          },
        },
      },
      {
        expected: 'incompatible_cycle',
        observation: { ...archiveObservation, cycleId: 'cycle_supply_other' },
      },
      {
        expected: 'incompatible_source_timestamp',
        observation: {
          ...archiveObservation,
          provenance: { ...archiveObservation.provenance, sourceTimestamp: '2026-08-10T11:59:56.000Z' },
        },
      },
    ]
    for (const { observation, expected } of incompatibleCases) {
      expect(assessSupplyEvidence([horizon, observation])).toMatchObject({
        statusCeiling: 'degraded',
        reason: expected,
      })
    }

    const componentDisagreement = {
      ...archiveObservation,
      components: {
        ...archiveObservation.components,
        authorized_trustlines: parseStellarAmount('699'),
        unauthorized_trustlines: parseStellarAmount('26'),
      },
    }
    expect(assessSupplyEvidence([horizon, componentDisagreement])).toMatchObject({
      statusCeiling: 'degraded',
      reason: 'independent_derivations_disagree',
    })

    const totalDisagreement = {
      ...archiveObservation,
      amount: parseStellarAmount('1001'),
      components: {
        ...archiveObservation.components,
        authorized_trustlines: parseStellarAmount('701'),
      },
    }
    expect(assessSupplyEvidence([horizon, totalDisagreement])).toMatchObject({
      statusCeiling: 'degraded',
      reason: 'independent_derivations_disagree',
    })
  })

  it('rejects mismatched totals and replay checkpoints as structured failures', async () => {
    const badTotal = structuredClone(artifactFixture)
    badTotal.total = '999.0000000'
    expect((await collectArchive(badTotal, { trustedCheckpoint: trustedCheckpointFor(badTotal) })).error)
      .toMatchObject({ code: 'total_mismatch' })

    const badCheckpoint = structuredClone(artifactFixture)
    const badDerivation = badCheckpoint.derivation as Record<string, unknown>
    badDerivation.replay_end_ledger = 499
    expect((await collectArchive(badCheckpoint, { trustedCheckpoint: trustedCheckpointFor(badCheckpoint) })).error)
      .toMatchObject({ code: 'checkpoint_mismatch' })

    const untrusted = await collectArchive(artifactFixture, {
      trustedCheckpoint: { ...TRUSTED_CHECKPOINT, ledgerHash: 'f'.repeat(64) },
    })
    expect(untrusted.error).toMatchObject({ code: 'checkpoint_mismatch' })
  })

  it('rejects any component or total tampering not authorized by the trusted manifest', async () => {
    const tampered = structuredClone(artifactFixture)
    const components = tampered.components as Record<string, string>
    components.authorized_trustlines = '699.0000000'
    components.unauthorized_trustlines = '26.0000000'

    expect((await collectArchive(tampered)).error).toMatchObject({ code: 'artifact_integrity_mismatch' })
  })

  it('rejects malformed, wrong-network, wrong-asset, and mislabeled evidence', async () => {
    const malformed = structuredClone(artifactFixture)
    delete malformed.components
    expect((await collectArchive(malformed, { trustedCheckpoint: trustedCheckpointFor(malformed) })).error)
      .toMatchObject({ code: 'malformed_payload' })

    const wrongNetwork = structuredClone(artifactFixture)
    wrongNetwork.network = { id: 'testnet', passphrase: 'Test SDF Network ; September 2015' }
    expect((await collectArchive(wrongNetwork, { trustedCheckpoint: trustedCheckpointFor(wrongNetwork) })).error)
      .toMatchObject({ code: 'network_mismatch' })

    const wrongAsset = structuredClone(artifactFixture)
    wrongAsset.asset = { kind: 'credit', code: 'EURC', issuer: ISSUER }
    expect((await collectArchive(wrongAsset, { trustedCheckpoint: trustedCheckpointFor(wrongAsset) })).error)
      .toMatchObject({ code: 'invalid_asset' })

    const archive = await collectArchive()
    expect(() => circulatingSupplyObservationSchema.parse({
      ...archive.observation,
      provenance: {
        ...archive.observation?.provenance,
        source: { ...ARCHIVE_SOURCE, sourceClass: 'anchor_self_reported', adapter: 'anchor' },
      },
    })).toThrow(/derivation family/)
  })

  it('preserves rate-limit metadata and rejects redirects', async () => {
    const limited = await collectArchive(undefined, {
      fetchImpl: vi.fn(async () => new Response('slow down', {
        status: 429,
        headers: { 'Retry-After': '3' },
      })),
    })
    expect(limited.error).toMatchObject({ code: 'non_200_response', status: 429, retryAfterMs: 3_000 })

    const redirected = await collectArchive(undefined, {
      fetchImpl: vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://other.example' } })),
    })
    expect(redirected.error).toMatchObject({ code: 'redirect_rejected' })
  })

  it('enforces response-size and timeout bounds', async () => {
    const oversized = await collectArchive(undefined, { maxResponseBytes: 32 })
    expect(oversized.error).toMatchObject({ code: 'response_too_large' })

    vi.useFakeTimers()
    const hangingFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const pending = collectArchive(undefined, { fetchImpl: hangingFetch, timeoutMs: 25 })
    await vi.advanceTimersByTimeAsync(25)
    expect((await pending).error).toMatchObject({ code: 'request_aborted' })
  })

  it('fails closed for unsupported assets and non-archive source identities', async () => {
    const noFetch = vi.fn()
    const invalidAsset = await fetchArchiveSupplyObservation({
      observationId: 'observation_invalid',
      cycleId: 'cycle_supply_500',
      source: ARCHIVE_SOURCE,
      asset: { kind: 'native' },
      expectedNetwork: NETWORK,
      trustedCheckpoint: TRUSTED_CHECKPOINT,
      fetchImpl: noFetch,
      clock: () => new Date(NOW),
    })
    expect(invalidAsset.error).toMatchObject({ code: 'invalid_asset' })

    const mislabeledSource = await fetchArchiveSupplyObservation({
      observationId: 'observation_invalid_source',
      cycleId: 'cycle_supply_500',
      source: { ...ARCHIVE_SOURCE, sourceClass: 'canonical_ledger', adapter: 'horizon' },
      asset: ASSET,
      expectedNetwork: NETWORK,
      trustedCheckpoint: TRUSTED_CHECKPOINT,
      fetchImpl: noFetch,
      clock: () => new Date(NOW),
    })
    expect(mislabeledSource.error).toMatchObject({ code: 'invalid_configuration' })
    expect(noFetch).not.toHaveBeenCalled()
  })
})
