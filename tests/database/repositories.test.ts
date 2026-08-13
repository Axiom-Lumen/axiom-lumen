import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  computePayloadSha256,
  createPersistenceRepositories,
  type PersistCompletedCycleInput,
} from '../../lib/db/repositories'
import { createAnchorRepository } from '../../lib/db/anchor-repository'
import { createAnchorCaseRepository } from '../../lib/db/anchor-case-repository'
import * as schema from '../../lib/db/schema'
import { queryLatestSupplyReadModel } from '../../lib/db/supply-read-model'
import { queryLatestTrustlineReadModel } from '../../lib/db/trustline-read-model'
import { computeEvidenceSha256 } from '../../lib/evidence/json'
import type { ClaimedCycle, DiscoveredIngestJob } from '../../lib/db/scheduler-repository'
import { createSupplyJobHandler } from '../../lib/worker/supply-job'
import { createTrustlineJobHandler } from '../../lib/worker/trustline-job'
import { reconciliationSnapshotSchema } from '../../lib/contracts/domain'
import { parseContactSecretKeyring } from '../../lib/anchor/contact-secret'

const adminUrl = process.env.DATABASE_TEST_ADMIN_URL
const describeWithDatabase = adminUrl ? describe : describe.skip
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))
const databases: string[] = []
const roles: string[] = []
let adminPool: Pool
const supplyArchiveFixture = JSON.parse(readFileSync(
  new URL('../fixtures/stellar/archive-supply-replay-v1.redacted.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>
const supplyHorizonFixture = JSON.parse(readFileSync(
  new URL('../fixtures/stellar/horizon-supply-asset.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>

function databaseUrl(name: string) {
  if (!adminUrl) throw new Error('DATABASE_TEST_ADMIN_URL is required')
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  return url.toString()
}

async function createDatabase() {
  const name = `axiom_repository_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  await adminPool.query(`CREATE DATABASE "${name}"`)
  databases.push(name)
  const pool = new Pool({ connectionString: databaseUrl(name), max: 2 })
  await migrate(drizzle({ client: pool }), {
    migrationsFolder,
    migrationsSchema: 'drizzle',
    migrationsTable: '__axiom_lumen_migrations',
  })
  await pool.query(`
    INSERT INTO networks (id, passphrase, display_name)
    VALUES ('public', 'Public Global Stellar Network ; September 2015', 'Public')
  `)
  await pool.query(`
    INSERT INTO source_definitions (id, network_id, source_class, adapter, url)
    VALUES ('source-a', 'public', 'canonical_ledger', 'horizon', 'https://horizon.example')
  `)
  return pool
}

function cycleBatch(label: string, completedAt: string): PersistCompletedCycleInput {
  const cycleId = `cycle-${label}`
  const observationId = `observation-${label}`
  const readingId = `reading-${label}`
  const attemptId = `attempt-${label}`
  const snapshotId = `snapshot-${label}`
  const rawPayload = {
    ledger: label === 'one' ? 100 : 101,
    paging_token: `${label}-token`,
    Authorization: 'Bearer must-not-be-stored',
    nested: { api_key: 'must-also-be-redacted' },
  }
  const state = {
    discrepancyId: 'discrepancy-a',
    sourceId: 'source-a',
    methodologyVersion: 'method-v1',
    namedParty: false,
    severity: 'warning' as const,
    lifecycleState: 'open' as const,
    publicationState: 'internal' as const,
    replyReviewState: 'not_required' as const,
    consecutiveCycles: 1,
    consecutiveAboveInfoCycles: 1,
    firstObservedAt: '2026-08-10T10:00:00.000Z',
    lastObservedAt: completedAt,
    lastFinalizedCycleAt: completedAt,
    lastFinalizedCycleId: cycleId,
    publicationUpdatedAt: '2026-08-10T10:00:00.000Z',
  }
  return {
    cycle: {
      id: cycleId,
      metric: 'latest_ledger',
      subjectKey: 'public',
      methodologyVersion: 'method-v1',
      idempotencyKey: `latest-ledger:${label}`,
      scheduledAt: completedAt,
      startedAt: completedAt,
      completedAt,
    },
    attempts: [
      {
        id: attemptId,
        sourceId: 'source-a',
        attemptNumber: 1,
        outcome: 'success',
        startedAt: completedAt,
        completedAt,
        httpStatus: 200,
      },
    ],
    readings: [
      {
        id: readingId,
        observationId,
        attemptId,
        sourceId: 'source-a',
        sourceIdentity: {
          id: 'source-a',
          sourceClass: 'canonical_ledger',
          adapter: 'horizon',
          url: 'https://horizon.example',
          network: { id: 'public', passphrase: 'Public Global Stellar Network ; September 2015' },
        },
        normalizedValue: { kind: 'ledger', value: label === 'one' ? 100 : 101 },
        rawPayload,
        retrievedAt: completedAt,
      },
    ],
    sourceHealth: [
      {
        id: `health-${label}`,
        sourceId: 'source-a',
        state: 'healthy',
        latencyMs: 25,
        observedAt: completedAt,
      },
    ],
    sourceHealthStates: [
      {
        sourceId: 'source-a',
        state: 'healthy',
        consecutiveFailures: 0,
        circuitState: 'closed',
        circuitOpenedAt: null,
        nextAttemptAt: null,
        lastErrorCode: null,
        lastObservedAt: completedAt,
      },
    ],
    snapshot: {
      snapshotId,
      cycleId,
      metric: 'latest_ledger',
      subject: {
        kind: 'network',
        network: { id: 'public', passphrase: 'Public Global Stellar Network ; September 2015' },
      },
      status: 'degraded',
      value: { kind: 'ledger', value: label === 'one' ? 100 : 101 },
      confidence: {
        score: 0.5,
        formulaVersion: 'confidence-v1',
        components: { agreement: 1, freshness: 1, availability: 1, diversity: 0.2, spread: 1 },
        capsApplied: ['single_source'],
      },
      sourcesConfigured: 1,
      sourcesResponded: 1,
      sourcesUsable: 1,
      sourcesAgreeing: 1,
      sourcesExcluded: 0,
      contributions: [
        {
          observationId,
          sourceId: 'source-a',
          sourceClass: 'canonical_ledger',
          ageSeconds: 0,
          effectiveWeight: 1,
          agrees: true,
        },
      ],
      discrepancies: [
        {
          id: 'discrepancy-a',
          sourceId: 'source-a',
          severity: 'warning',
          lifecycleState: 'open',
          publicationState: 'internal',
          consecutiveCycles: 1,
          observedValue: { kind: 'ledger', value: label === 'one' ? 97 : 101 },
          referenceValue: { kind: 'ledger', value: label === 'one' ? 100 : 101 },
          firstObservedAt: '2026-08-10T10:00:00.000Z',
          lastObservedAt: completedAt,
        },
      ],
      sourceErrors: [],
      asOf: completedAt,
      methodologyVersion: 'method-v1',
    },
    discrepancyStates: { 'source-a': state },
    events: [
      {
        eventId: `event-opened-${label}`,
        type: 'opened',
        discrepancyId: 'discrepancy-a',
        sourceId: 'source-a',
        methodologyVersion: 'method-v1',
        cycleId,
        occurredAt: completedAt,
        deviationBand: 'above_info',
        before: null,
        after: {
          severity: 'warning',
          lifecycleState: 'open',
          publicationState: 'internal',
          replyReviewState: 'not_required',
          consecutiveCycles: 1,
          consecutiveAboveInfoCycles: 1,
        },
      },
    ],
  }
}

describeWithDatabase('transactional persistence repositories', () => {
  beforeAll(() => {
    adminPool = new Pool({ connectionString: adminUrl, max: 1 })
  })

  afterAll(async () => {
    await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1)', [databases])
    for (const name of databases) await adminPool.query(`DROP DATABASE IF EXISTS "${name}"`)
    for (const role of roles) await adminPool.query(`DROP ROLE IF EXISTS "${role}"`)
    await adminPool.end()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('persists verification history, rotates reserve sources, and suspends failed re-verification', async () => {
    const pool = await createDatabase()
    try {
      const issuer = `G${'R'.repeat(55)}`
      await pool.query(`
        INSERT INTO assets (id, network_id, type, code, issuer, canonical_id)
        VALUES ('asset-anchor-usdc', 'public', 'credit', 'USDC', $1, $2),
               ('asset-anchor-eurc', 'public', 'credit', 'EURC', $1, $3)
      `, [issuer, `USDC:${issuer}`, `EURC:${issuer}`])
      const repository = createAnchorRepository({ pool, db: drizzle({ client: pool, schema }) })
      const discovery = {
        issuer,
        asset: { kind: 'credit' as const, code: 'USDC', issuer },
        homeDomain: 'anchor.example',
        organizationName: 'Example Anchor',
        stellarTomlUrl: 'https://anchor.example/.well-known/stellar.toml',
        attestationUrl: 'https://evidence.example/reserve.json',
        anchorAssetType: 'fiat',
        anchorAsset: 'USD',
        contacts: [{ kind: 'email' as const, endpoint: 'ops@anchor.example' }],
        verifiedAt: '2026-08-11T12:00:00.000Z',
        evidence: { accountSha256: 'a'.repeat(64), horizonRootSha256: 'c'.repeat(64), stellarTomlSha256: 'b'.repeat(64), networkPassphrase: 'Public Global Stellar Network ; September 2015' },
      }
      const first = await repository.persistVerifiedDiscovery({ networkId: 'public', discovery })
      expect(await repository.persistVerifiedDiscovery({ networkId: 'public', discovery })).toEqual(first)
      const eurcDiscovery = { ...discovery, asset: { kind: 'credit' as const, code: 'EURC', issuer }, verifiedAt: '2026-08-11T12:30:00.000Z' }
      const eurc = await repository.persistVerifiedDiscovery({ networkId: 'public', discovery: eurcDiscovery })
      expect(eurc.sourceId).toBe(first.sourceId)
      expect((await pool.query('SELECT status, stellar_account FROM anchors')).rows).toEqual([{ status: 'verified', stellar_account: issuer }])
      expect((await pool.query('SELECT verified_at, verification_expires_at, verification_evidence FROM anchor_domains')).rows[0]).toMatchObject({ verification_evidence: { asset: `EURC:${issuer}` } })
      expect((await pool.query('SELECT verified_at FROM anchor_contact_endpoints')).rows).toEqual([{ verified_at: null }])
      expect((await pool.query('SELECT event_type FROM anchor_verification_events ORDER BY occurred_at')).rows).toEqual([{ event_type: 'verified' }, { event_type: 'verified' }])
      expect((await pool.query('SELECT adapter, source_class, config FROM source_definitions WHERE id = $1', [first.sourceId])).rows[0]).toEqual({
        adapter: 'anchor', source_class: 'anchor_self_reported', config: { anchorReserves: {
          enabled: true, assetIds: ['asset-anchor-eurc', 'asset-anchor-usdc'], verifications: { 'asset-anchor-eurc': {
            domainId: first.domainId, verifiedAt: '2026-08-11T12:30:00.000Z', verificationExpiresAt: '2026-08-12T12:30:00.000Z',
          }, 'asset-anchor-usdc': {
            domainId: first.domainId, verifiedAt: '2026-08-11T12:00:00.000Z', verificationExpiresAt: '2026-08-12T12:00:00.000Z',
          } }, profiles: { 'asset-anchor-eurc': 'axiom_json_v1', 'asset-anchor-usdc': 'axiom_json_v1' },
        } },
      })
      const rotated = await repository.persistVerifiedDiscovery({
        networkId: 'public',
        discovery: { ...discovery, attestationUrl: 'https://evidence.example/reserve-v2.json', verifiedAt: '2026-08-11T13:00:00.000Z', evidence: { ...discovery.evidence, stellarTomlSha256: 'd'.repeat(64) } },
      })
      expect(rotated.sourceId).not.toBe(first.sourceId)
      expect((await pool.query('SELECT id, enabled FROM source_definitions ORDER BY id')).rows).toEqual(expect.arrayContaining([
        { id: first.sourceId, enabled: true }, { id: rotated.sourceId, enabled: true },
      ]))
      expect((await pool.query('SELECT event_type FROM anchor_verification_events ORDER BY occurred_at')).rows).toEqual([{ event_type: 'verified' }, { event_type: 'verified' }, { event_type: 'verified' }])
      expect(await repository.suspendVerification({ networkId: 'public', issuer, asset: discovery.asset, occurredAt: '2026-08-11T14:00:00.000Z', failureCode: 'FetchError' })).toMatchObject({ status: 'suspended' })
      expect((await pool.query('SELECT status FROM anchors')).rows).toEqual([{ status: 'verified' }])
      expect((await pool.query('SELECT count(*)::int AS count FROM source_definitions WHERE enabled AND anchor_id = $1', [first.anchorId])).rows).toEqual([{ count: 1 }])
      expect(await repository.suspendVerification({ networkId: 'public', issuer, asset: eurcDiscovery.asset, occurredAt: '2026-08-11T14:05:00.000Z', failureCode: 'FetchError' })).toMatchObject({ status: 'suspended' })
      expect((await pool.query('SELECT status FROM anchors')).rows).toEqual([{ status: 'suspended' }])
      expect((await pool.query('SELECT count(*)::int AS count FROM source_definitions WHERE enabled AND anchor_id = $1', [first.anchorId])).rows).toEqual([{ count: 0 }])
      expect((await pool.query('SELECT event_type FROM anchor_verification_events ORDER BY occurred_at')).rows).toEqual([{ event_type: 'verified' }, { event_type: 'verified' }, { event_type: 'verified' }, { event_type: 'suspended' }, { event_type: 'suspended' }])
    } finally {
      await pool.end()
    }
  })

  it('uses network and issuer identity instead of display names or globally unique domains', async () => {
    const pool = await createDatabase()
    try {
      const issuerA = `G${'J'.repeat(55)}`
      const issuerB = `G${'K'.repeat(55)}`
      await pool.query(`INSERT INTO networks (id, passphrase, display_name) VALUES ('testnet', 'Test SDF Network ; September 2015', 'Testnet')`)
      await pool.query(`
        INSERT INTO assets (id, network_id, type, code, issuer, canonical_id) VALUES
          ('asset-public-a', 'public', 'credit', 'USD', $1, $2),
          ('asset-public-b', 'public', 'credit', 'USD', $3, $4),
          ('asset-testnet-a', 'testnet', 'credit', 'USD', $1, $2)
      `, [issuerA, `USD:${issuerA}`, issuerB, `USD:${issuerB}`])
      const repository = createAnchorRepository({ pool, db: drizzle({ client: pool, schema }) })
      const discovery = (issuer: string, homeDomain: string, passphrase: string) => ({
        issuer, asset: { kind: 'credit' as const, code: 'USD', issuer }, homeDomain,
        organizationName: 'Shared Display Name', stellarTomlUrl: `https://${homeDomain}/.well-known/stellar.toml`,
        attestationUrl: `https://${homeDomain}/reserve.json`, anchorAssetType: 'fiat', anchorAsset: 'USD', contacts: [],
        verifiedAt: '2026-08-11T12:00:00.000Z',
        evidence: { accountSha256: 'a'.repeat(64), horizonRootSha256: 'b'.repeat(64), stellarTomlSha256: 'c'.repeat(64), networkPassphrase: passphrase },
      })
      const publicA = await repository.persistVerifiedDiscovery({ networkId: 'public', discovery: discovery(issuerA, 'shared.example', 'Public Global Stellar Network ; September 2015') })
      await repository.persistVerifiedDiscovery({ networkId: 'public', discovery: discovery(issuerB, 'other.example', 'Public Global Stellar Network ; September 2015') })
      const testnetA = await repository.persistVerifiedDiscovery({ networkId: 'testnet', discovery: discovery(issuerA, 'shared.example', 'Test SDF Network ; September 2015') })
      expect(publicA.anchorId).not.toBe(testnetA.anchorId)
      expect(publicA.domainId).not.toBe(testnetA.domainId)
      expect((await pool.query('SELECT count(*)::int AS count FROM anchors')).rows).toEqual([{ count: 3 }])
      expect((await pool.query('SELECT count(*)::int AS count FROM anchor_domains')).rows).toEqual([{ count: 3 }])
    } finally {
      await pool.end()
    }
  })

  it('assigns the mZAR provider profile only to the exact verified issuer-domain-endpoint tuple', async () => {
    const pool = await createDatabase()
    try {
      const issuer = 'GCBNWTCCMC32UHZ5OCC2PNMFDGXRVPA7MFFBFFTCVW77SX5PMRB7Q4BY'
      await pool.query(`INSERT INTO assets (id, network_id, type, code, issuer, canonical_id) VALUES ('asset-mzar', 'public', 'credit', 'mZAR', $1, $2)`, [issuer, `mZAR:${issuer}`])
      const repository = createAnchorRepository({ pool, db: drizzle({ client: pool, schema }) })
      const persisted = await repository.persistVerifiedDiscovery({
        networkId: 'public',
        discovery: {
          issuer, asset: { kind: 'credit', code: 'mZAR', issuer }, homeDomain: 'mzar.co.za',
          organizationName: 'Mesh Trade South Africa (Pty) Ltd', stellarTomlUrl: 'https://mzar.co.za/.well-known/stellar.toml',
          attestationUrl: 'https://mzar.co.za/', anchorAssetType: 'fiat', anchorAsset: 'ZAR', contacts: [],
          verifiedAt: '2026-04-01T12:00:00.000Z', evidence: {
            accountSha256: 'a'.repeat(64), horizonRootSha256: 'b'.repeat(64), stellarTomlSha256: 'c'.repeat(64),
            networkPassphrase: 'Public Global Stellar Network ; September 2015',
          },
        },
      })
      expect((await pool.query('SELECT config FROM source_definitions WHERE id = $1', [persisted.sourceId])).rows[0]).toMatchObject({
        config: { anchorReserves: { profiles: { 'asset-mzar': 'mesh_mzar_pdf_v1' } } },
      })
    } finally {
      await pool.end()
    }
  })

  it('persists and reconstructs finalized trustline-state evidence', async () => {
    const pool = await createDatabase()
    try {
      const issuer = `G${'T'.repeat(55)}`
      const assetId = `USDC:${issuer}`
      const subjectKey = `public:${assetId}`
      await pool.query(`
        INSERT INTO assets (id, network_id, type, code, issuer, canonical_id)
        VALUES ('asset-trustline-usdc', 'public', 'credit', 'USDC', $1, $2)
      `, [issuer, assetId])
      const job: DiscoveredIngestJob = {
        metric: 'trustline_count',
        subjectKey,
        methodologyVersion: 'trustline-state-v0.1',
        asset: { kind: 'credit', code: 'USDC', issuer },
        sources: [{
          id: 'source-a', url: 'https://horizon.example', sourceClass: 'canonical_ledger', adapter: 'horizon',
          upstreamId: null, networkId: 'public', networkPassphrase: 'Public Global Stellar Network ; September 2015',
        }],
      }
      const lease: ClaimedCycle = {
        id: 'cycle-trustline-e2e', metric: 'trustline_count', subjectKey,
        methodologyVersion: 'trustline-state-v0.1',
        idempotencyKey: `trustline_count:${subjectKey}:trustline-state-v0.1:2026-08-10T12:00:00.000Z`,
        scheduledAt: '2026-08-10T12:00:00.000Z', leaseOwner: 'worker-a', leaseToken: 1,
        leaseExpiresAt: '2026-08-10T12:01:00.000Z', attemptCount: 1,
      }
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
        const target = String(url)
        if (target === 'https://horizon.example/') return Response.json({ network_passphrase: 'Public Global Stellar Network ; September 2015' })
        if (target === `https://horizon.example/accounts/${issuer}`) return Response.json({ account_id: issuer }, { headers: { 'Latest-Ledger': '499' } })
        if (target.startsWith('https://horizon.example/assets?')) return Response.json({ _embedded: { records: [{ ...supplyHorizonFixture, asset_issuer: issuer }] } }, { headers: { 'Latest-Ledger': '500' } })
        if (target === 'https://horizon.example/ledgers/500') return Response.json({ sequence: 500, closed_at: '2026-08-10T12:00:00Z' })
        throw new Error(`unexpected URL ${target}`)
      }))
      const databaseClient = { pool, db: drizzle({ client: pool, schema }) }
      const repositories = createPersistenceRepositories(databaseClient)
      const handler = createTrustlineJobHandler(repositories, () => new Date('2026-08-10T12:00:05.000Z'), {
        resiliencePolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, concurrency: 1, circuitFailureThreshold: 2, circuitCooldownMs: 60_000 },
      })
      const batch = await handler({ lease, job, signal: new AbortController().signal })
      expect(batch.snapshot).toMatchObject({ status: 'degraded', value: { kind: 'trustline_state', total: 825n }, sourcesUsable: 1 })
      expect(await repositories.persistCompletedCycle(batch)).toEqual({ status: 'inserted', cycleId: lease.id })
      const readModel = await queryLatestTrustlineReadModel(databaseClient, job.asset, new Date('2026-08-10T12:00:05.000Z'))
      expect(readModel).toMatchObject({
        stale: false, freshForSeconds: 895,
        snapshot: {
          metric: 'trustline_count', status: 'degraded', subject: { kind: 'asset', asset: job.asset },
          value: { kind: 'trustline_state', total: 825n, states: { authorized: 700n, authorized_to_maintain_liabilities: 100n, unauthorized: 25n }, ledgerSequence: 500 },
          contributions: [expect.objectContaining({ sourceId: 'source-a', agrees: true })],
        },
      })
      expect(await queryLatestTrustlineReadModel(databaseClient, job.asset, new Date('2026-08-10T12:15:00.001Z'))).toMatchObject({ stale: true, freshForSeconds: 0 })
    } finally {
      await pool.end()
    }
  })

  it('persists the connector-to-reconciliation supply pipeline and deduplicates cycle replay', async () => {
    const pool = await createDatabase()
    try {
      const issuer = `G${'A'.repeat(55)}`
      const assetId = `USDC:${issuer}`
      const subjectKey = `public:${assetId}`
      await pool.query(`
        INSERT INTO assets (id, network_id, type, code, issuer, canonical_id)
        VALUES ('asset-usdc', 'public', 'credit', 'USDC', $1, $2)
      `, [issuer, assetId])
      await pool.query(`
        INSERT INTO source_definitions (id, network_id, source_class, adapter, url)
        VALUES ('source-archive', 'public', 'archive', 'archive', 'https://archive.example/usdc.json')
      `)

      const archivePayload = structuredClone(supplyArchiveFixture)
      ;(archivePayload.components as Record<string, unknown>).authorized_trustlines = '701.0000000'
      archivePayload.total = '1001.0000000'
      const trustedCheckpoint = {
        ledgerSequence: 500,
        ledgerHash: 'f4180bce5da1a4c4a48e2f2982dcc324cd69b6ee34f7beeacacee6cf47b829eb',
        artifactSha256: computeEvidenceSha256(archivePayload),
        provenance: {
          manifestId: 'public_archive_manifest_500',
          source: 'https://checkpoints.example/public/500.manifest.json',
          verificationMethod: 'trusted_manifest_signature',
          verificationEvidenceSha256: '9'.repeat(64),
          verifiedAt: '2026-08-10T12:00:00.000Z',
        },
      }
      const job: DiscoveredIngestJob = {
        metric: 'circulating_supply',
        subjectKey,
        methodologyVersion: 'onchain-asset-supply-v0.1',
        asset: { kind: 'credit', code: 'USDC', issuer },
        sources: [
          {
            id: 'source-a', url: 'https://horizon.example', sourceClass: 'canonical_ledger', adapter: 'horizon',
            upstreamId: null, networkId: 'public',
            networkPassphrase: 'Public Global Stellar Network ; September 2015',
          },
          {
            id: 'source-archive', url: 'https://archive.example/usdc.json', sourceClass: 'archive', adapter: 'archive',
            upstreamId: null, networkId: 'public',
            networkPassphrase: 'Public Global Stellar Network ; September 2015', trustedCheckpoint,
          },
        ],
      }
      const lease: ClaimedCycle = {
        id: 'cycle-supply-e2e',
        metric: 'circulating_supply',
        subjectKey,
        methodologyVersion: 'onchain-asset-supply-v0.1',
        idempotencyKey: `circulating_supply:${subjectKey}:onchain-asset-supply-v0.1:2026-08-10T12:00:00.000Z`,
        scheduledAt: '2026-08-10T12:00:00.000Z',
        leaseOwner: 'worker-a',
        leaseToken: 1,
        leaseExpiresAt: '2026-08-10T12:01:00.000Z',
        attemptCount: 1,
      }
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
        const target = String(url)
        if (target === 'https://horizon.example/') {
          return Response.json({ network_passphrase: 'Public Global Stellar Network ; September 2015' })
        }
        if (target === `https://horizon.example/accounts/${issuer}`) {
          return Response.json({ account_id: issuer }, { headers: { 'Latest-Ledger': '499' } })
        }
        if (target.startsWith('https://horizon.example/assets?')) {
          return Response.json(
            { _links: {}, _embedded: { records: [supplyHorizonFixture] } },
            { headers: { 'Latest-Ledger': '500' } },
          )
        }
        if (target === 'https://horizon.example/ledgers/500') {
          return Response.json({ sequence: 500, closed_at: '2026-08-10T11:59:55Z' })
        }
        if (target === 'https://archive.example/usdc.json') return Response.json(archivePayload)
        throw new Error(`unexpected URL ${target}`)
      }))

      const repositories = createPersistenceRepositories({ pool, db: drizzle({ client: pool, schema }) })
      const handler = createSupplyJobHandler(repositories, () => new Date('2026-08-10T12:00:05.000Z'), {
        resiliencePolicy: {
          maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, concurrency: 2,
          circuitFailureThreshold: 2, circuitCooldownMs: 60_000,
        },
      })
      const batch = await handler({ lease, job, signal: new AbortController().signal })
      expect(batch.snapshot).toMatchObject({ status: 'degraded', sourcesUsable: 2, sourcesAgreeing: 1 })
      expect(batch.events).toHaveLength(1)
      const replay = await handler({ lease, job, signal: new AbortController().signal })
      expect(replay.snapshot).toEqual(batch.snapshot)
      expect(replay.events).toEqual(batch.events)
      expect(await repositories.persistCompletedCycle(batch)).toEqual({ status: 'inserted', cycleId: lease.id })
      expect(await repositories.persistCompletedCycle(replay)).toEqual({ status: 'duplicate', cycleId: lease.id })
      const persistedSupplySnapshot = reconciliationSnapshotSchema.parse(batch.snapshot)
      expect(await repositories.getLatestSupplyReference(subjectKey)).toMatchObject({
        snapshotId: persistedSupplySnapshot.snapshotId,
        cycleId: lease.id,
        methodologyVersion: 'onchain-asset-supply-v0.1',
        ledgerSequence: 500,
        ledgerClosedAt: '2026-08-10T11:59:55.000Z',
        evidence: [expect.objectContaining({ sourceId: 'source-a', ledgerSequence: 500 })],
      })
      // Select by the actual contributing ledger close, not the later snapshot
      // completion timestamp (which matters for retrospective replay).
      expect(await repositories.getSupplyReferenceAt(subjectKey, '2026-08-10T11:59:55.000Z', 5)).toMatchObject({
        snapshotId: persistedSupplySnapshot.snapshotId,
        ledgerSequence: 500,
        ledgerClosedAt: '2026-08-10T11:59:55.000Z',
      })
      expect(await repositories.getSupplyReferenceAt(subjectKey, '2026-08-10T13:00:00.000Z', 300)).toBeNull()

      const databaseClient = { pool, db: drizzle({ client: pool, schema }) }
      const readModel = await queryLatestSupplyReadModel(
        databaseClient,
        job.asset,
        new Date('2026-08-10T12:00:05.000Z'),
      )
      expect(readModel).toMatchObject({
        stale: false,
        freshForSeconds: 110,
        snapshot: {
          metric: 'circulating_supply',
          subject: { kind: 'asset', asset: job.asset },
          status: 'degraded',
          value: { kind: 'amount' },
          sourcesConfigured: 2,
          sourcesUsable: 2,
          contributions: [
            expect.objectContaining({ sourceId: 'source-a' }),
            expect.objectContaining({ sourceId: 'source-archive' }),
          ],
          discrepancies: [],
        },
      })
      expect(await queryLatestSupplyReadModel(
        databaseClient,
        job.asset,
        new Date('2026-08-10T12:01:55.000Z'),
      )).toMatchObject({ stale: false, freshForSeconds: 0 })
      expect(await queryLatestSupplyReadModel(
        databaseClient,
        job.asset,
        new Date('2026-08-10T12:01:55.001Z'),
      )).toMatchObject({ stale: true, freshForSeconds: 0 })

      await pool.query(`
        UPDATE discrepancies
        SET publication_state = 'approved_public', publication_updated_at = last_observed_at
        WHERE metric = 'circulating_supply' AND subject_key = $1
      `, [subjectKey])
      const publicReadModel = await queryLatestSupplyReadModel(
        databaseClient,
        job.asset,
        new Date('2026-08-10T12:00:05.000Z'),
      )
      expect(publicReadModel?.snapshot.discrepancies).toHaveLength(1)
      const publicDiscrepancy = publicReadModel?.snapshot.discrepancies[0]
      expect(publicDiscrepancy).toMatchObject({
        sourceId: 'source-archive',
        publicationState: 'approved_public',
        observedValue: { kind: 'amount' },
        referenceValue: { kind: 'amount' },
        details: {
          kind: 'supply_comparison',
          observedLedgerSequence: 500,
          referenceLedgerSequence: 500,
          componentDifferences: [expect.objectContaining({ component: 'authorized_trustlines' })],
        },
      })
      if (publicDiscrepancy?.details?.kind !== 'supply_comparison') {
        throw new Error('expected supply discrepancy details')
      }
      if (publicDiscrepancy.observedValue.kind !== 'amount' || publicDiscrepancy.referenceValue.kind !== 'amount') {
        throw new Error('expected supply amount values')
      }
      expect(publicDiscrepancy.observedValue.value.toString()).toBe('1001')
      expect(publicDiscrepancy.referenceValue.value.toString()).toBe('1000')
      expect(publicDiscrepancy.details.componentDifferences.map((difference) => ({
        component: difference.component,
        observed: difference.observed.toString(),
        reference: difference.reference.toString(),
        absoluteDelta: difference.absoluteDelta.toString(),
      }))).toEqual([{
        component: 'authorized_trustlines',
        observed: '701',
        reference: '700',
        absoluteDelta: '1',
      }])

      const counts = await pool.query(`
        SELECT
          (SELECT count(*)::int FROM ingest_cycles) AS cycles,
          (SELECT count(*)::int FROM raw_readings) AS readings,
          (SELECT count(*)::int FROM reconciliation_snapshots) AS snapshots,
          (SELECT count(*)::int FROM snapshot_events) AS stream_events,
          (SELECT count(*)::int FROM discrepancy_events) AS events
      `)
      expect(counts.rows[0]).toEqual({ cycles: 1, readings: 2, snapshots: 1, stream_events: 1, events: 1 })
      const streamEvent = await pool.query(`SELECT id::text, snapshot_id, payload FROM snapshot_events`)
      expect(streamEvent.rows).toEqual([expect.objectContaining({
        id: '1',
        snapshot_id: persistedSupplySnapshot.snapshotId,
        payload: expect.objectContaining({
          snapshot_id: persistedSupplySnapshot.snapshotId,
          metric: 'onchain_asset_supply',
          resource: expect.stringContaining('/api/v1/supply/'),
        }),
      })])
      expect(await repositories.getRawReadings(lease.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          metric: 'circulating_supply',
          subjectKey,
          rawPayload: expect.objectContaining({
            observation: expect.objectContaining({ ledgerSequence: 500, components: expect.any(Object) }),
          }),
        }),
        expect.objectContaining({
          metric: 'circulating_supply',
          subjectKey,
          rawPayload: expect.objectContaining({
            observation: expect.objectContaining({ methodologyVersion: 'onchain-asset-supply-v0.1' }),
          }),
        }),
      ]))
    } finally {
      await pool.end()
    }
  })

  it('reads completed supply cycles only and rejects snapshots missing their evidence context', async () => {
    const pool = await createDatabase()
    try {
      const issuer = `G${'B'.repeat(55)}`
      const assetId = `EURC:${issuer}`
      const subjectKey = `public:${assetId}`
      await pool.query(`
        INSERT INTO assets (id, network_id, type, code, issuer, canonical_id)
        VALUES ('asset-eurc', 'public', 'credit', 'EURC', $1, $2)
      `, [issuer, assetId])
      await pool.query(`
        INSERT INTO ingest_cycles
          (id, metric, subject_key, methodology_version, idempotency_key, status, scheduled_at, started_at)
        VALUES
          ('cycle-incomplete-supply', 'circulating_supply', $1, 'onchain-asset-supply-v0.1',
           'incomplete-supply-cycle', 'running', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z')
      `, [subjectKey])
      await pool.query(`
        INSERT INTO reconciliation_snapshots
          (id, cycle_id, metric, subject_key, status, subject, value, confidence,
           confidence_formula_version, confidence_components, confidence_caps_applied, source_errors,
           sources_configured, sources_responded, sources_usable, sources_agreeing, sources_excluded,
           methodology_version, as_of)
        VALUES
          ('snapshot-incomplete-supply', 'cycle-incomplete-supply', 'circulating_supply', $1, 'degraded',
           $2, '{"kind":"amount","value":"100"}', 0.6, 'onchain-asset-supply-confidence-v0.1',
           '{"agreement":1,"freshness":1,"availability":1,"spread":1}', '[]', '[]',
           1, 1, 1, 1, 0, 'onchain-asset-supply-v0.1', '2026-08-10T12:00:05Z')
      `, [subjectKey, JSON.stringify({ kind: 'asset', asset: { kind: 'credit', code: 'EURC', issuer } })])
      const databaseClient = { pool, db: drizzle({ client: pool, schema }) }
      const asset = { kind: 'credit' as const, code: 'EURC', issuer }

      expect(await queryLatestSupplyReadModel(
        databaseClient,
        asset,
        new Date('2026-08-10T12:00:05.000Z'),
      )).toBeNull()

      await pool.query(`
        UPDATE ingest_cycles
        SET status = 'completed', completed_at = '2026-08-10T12:00:05Z'
        WHERE id = 'cycle-incomplete-supply'
      `)
      await expect(queryLatestSupplyReadModel(
        databaseClient,
        asset,
        new Date('2026-08-10T12:00:05.000Z'),
      )).rejects.toThrow('contribution count does not match usable-source count')
    } finally {
      await pool.end()
    }
  })

  it('atomically persists a completed cycle, hashes and redacts evidence, and deduplicates retries', async () => {
    const pool = await createDatabase()
    try {
      const repositories = createPersistenceRepositories({ pool, db: drizzle({ client: pool, schema }) })
      const batch = cycleBatch('one', '2026-08-10T10:00:00.000Z')
      expect(await repositories.persistCompletedCycle(batch)).toEqual({ status: 'inserted', cycleId: 'cycle-one' })
      expect(await repositories.persistCompletedCycle(batch)).toEqual({ status: 'duplicate', cycleId: 'cycle-one' })

      const overlappingRetry = cycleBatch('one', '2026-08-10T10:00:05.000Z')
      overlappingRetry.cycle.scheduledAt = batch.cycle.scheduledAt
      expect(await repositories.persistCompletedCycle(overlappingRetry)).toEqual({
        status: 'duplicate',
        cycleId: 'cycle-one',
      })

      const divergentRetry = cycleBatch('one', '2026-08-10T10:00:00.000Z')
      divergentRetry.cycle.scheduledAt = '2026-08-10T09:59:00.000Z'
      await expect(repositories.persistCompletedCycle(divergentRetry)).rejects.toThrow(
        'was reused with different cycle parameters',
      )

      const readings = await repositories.getRawReadings('cycle-one')
      expect(readings).toHaveLength(1)
      expect(readings[0]?.rawPayload).toMatchObject({
        Authorization: '[REDACTED]',
        nested: { api_key: '[REDACTED]' },
      })
      expect(readings[0]?.sourceIdentity).toMatchObject({
        id: 'source-a',
        url: 'https://horizon.example',
        network: { id: 'public' },
      })
      expect(readings[0]?.payloadSha256).toBe(computePayloadSha256(readings[0]?.rawPayload))
      expect(readings[0]?.payloadSha256).not.toBe(computePayloadSha256(batch.readings[0]?.rawPayload))
      expect(computePayloadSha256({ value: 1 })).toBe(computePayloadSha256({ value: 1 }))
      expect(computePayloadSha256({ value: 1 })).not.toBe(computePayloadSha256({ value: 2 }))
      expect(await repositories.getSourceHealthStates(['source-a', 'source-a'])).toEqual({
        'source-a': expect.objectContaining({
          state: 'healthy',
          consecutiveFailures: 0,
          circuitState: 'closed',
          lastObservedAt: '2026-08-10T10:00:00.000Z',
        }),
      })
      expect(await repositories.getSourceHealthStates([])).toEqual({})

      const counts = await pool.query(`
        SELECT
          (SELECT count(*)::int FROM ingest_cycles) AS cycles,
          (SELECT count(*)::int FROM raw_readings) AS readings,
          (SELECT count(*)::int FROM reconciliation_snapshots) AS snapshots,
          (SELECT count(*)::int FROM snapshot_events) AS stream_events,
          (SELECT count(*)::int FROM discrepancy_events) AS events
      `)
      expect(counts.rows[0]).toEqual({ cycles: 1, readings: 1, snapshots: 1, stream_events: 1, events: 1 })

      await pool.query(`INSERT INTO anchors (id, network_id, name) VALUES ('anchor-a', 'public', 'Anchor A')`)
      await pool.query(`
        INSERT INTO anchor_contact_endpoints (id, anchor_id, kind, endpoint)
        VALUES ('contact-a', 'anchor-a', 'email', 'ops@example.com')
      `)
      await pool.query(`
        INSERT INTO anchor_cases (id, anchor_id, discrepancy_id, opened_at)
        VALUES ('case-a', 'anchor-a', 'discrepancy-a', '2026-08-10T10:00:00.000Z')
      `)
      expect(
        await repositories.enqueueNotification({
          id: 'notification-a',
          caseId: 'case-a',
          contactEndpointId: 'contact-a',
          idempotencyKey: 'case-a:initial',
          channel: 'email',
          payload: {},
          payloadSha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        }),
      ).toEqual({ status: 'inserted', id: 'notification-a' })
      expect(
        await repositories.enqueueNotification({
          id: 'notification-retry',
          caseId: 'case-a',
          contactEndpointId: 'contact-a',
          idempotencyKey: 'case-a:initial',
          channel: 'email',
          payload: {},
          payloadSha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        }),
      ).toEqual({ status: 'duplicate' })
      expect((await pool.query('SELECT count(*)::int AS count FROM notifications')).rows[0]?.count).toBe(1)
    } finally {
      await pool.end()
    }
  })

  it('opens an anchor case idempotently and starts the reply clock only after successful delivery', async () => {
    const pool = await createDatabase()
    try {
      const client = { pool, db: drizzle({ client: pool, schema }) }
      const repositories = createPersistenceRepositories(client)
      await repositories.persistCompletedCycle(cycleBatch('one', '2026-08-10T10:00:00.000Z'))
      await pool.query(`
        INSERT INTO anchors (id, network_id, name, status)
        VALUES ('anchor-a', 'public', 'Anchor A', 'verified')
      `)
      await pool.query(`UPDATE source_definitions SET anchor_id = 'anchor-a' WHERE id = 'source-a'`)
      await pool.query(`UPDATE discrepancies SET named_party = true WHERE id = 'discrepancy-a'`)
      await pool.query(`
        INSERT INTO anchor_contact_endpoints (id, anchor_id, kind, endpoint, verified_at)
        VALUES ('contact-a', 'anchor-a', 'email', 'ops@example.com', '2026-08-10T09:00:00.000Z')
      `)
      const cases = createAnchorCaseRepository(client)
      const opened = await cases.openEligibleCase({
        discrepancyId: 'discrepancy-a',
        triggeringEventId: 'event-opened-one',
        openedAt: '2026-08-10T10:01:00.000Z',
      })
      expect(opened).toMatchObject({ status: 'opened' })
      if (opened.status !== 'opened') throw new Error('expected opened case')
      expect(await cases.openEligibleCase({
        discrepancyId: 'discrepancy-a',
        triggeringEventId: 'event-opened-one',
        openedAt: '2026-08-10T10:01:00.000Z',
      })).toMatchObject({ status: 'duplicate', caseId: opened.caseId })

      const notificationId = opened.notificationIds[0]!
      const firstClaims = await cases.claimDueNotifications({
        workerId: 'notice-worker-1',
        now: '2026-08-10T10:01:30.000Z',
        leaseDurationMs: 30_000,
        limit: 10,
      })
      expect(firstClaims).toHaveLength(1)
      expect(await cases.recordDeliveryAttempt({
        notificationId,
        workerId: 'notice-worker-1',
        leaseToken: firstClaims[0]!.leaseToken,
        result: {
          outcome: 'failed',
          startedAt: '2026-08-10T10:02:00.000Z',
          completedAt: '2026-08-10T10:02:01.000Z',
          failure: { code: 'timeout', retryable: true },
          nextAttemptAt: '2026-08-10T10:03:00.000Z',
        },
      })).toMatchObject({ status: 'failed', caseId: opened.caseId })
      expect((await pool.query(`SELECT status, reply_due_at FROM anchor_cases WHERE id = $1`, [opened.caseId])).rows[0]).toEqual({
        status: 'draft',
        reply_due_at: null,
      })
      expect((await pool.query(`SELECT publication_state FROM discrepancies WHERE id = 'discrepancy-a'`)).rows[0]?.publication_state).toBe('internal')

      const secondClaims = await cases.claimDueNotifications({
        workerId: 'notice-worker-2',
        now: '2026-08-10T10:03:00.000Z',
        leaseDurationMs: 30_000,
        limit: 10,
      })
      expect(secondClaims).toHaveLength(1)
      const sent = await cases.recordDeliveryAttempt({
        notificationId,
        workerId: 'notice-worker-2',
        leaseToken: secondClaims[0]!.leaseToken,
        result: {
          outcome: 'sent',
          startedAt: '2026-08-10T10:03:00.000Z',
          completedAt: '2026-08-10T10:03:01.000Z',
          httpStatus: 202,
          responseBody: new TextEncoder().encode('accepted but not retained'),
        },
      })
      expect(sent).toMatchObject({
        status: 'sent',
        caseId: opened.caseId,
        replyDueAt: '2026-08-13T10:03:01.000Z',
      })
      expect(await cases.recordDeliveryAttempt({
        notificationId,
        result: {
          outcome: 'sent',
          startedAt: '2026-08-10T10:04:00.000Z',
          completedAt: '2026-08-10T10:04:01.000Z',
        },
      })).toMatchObject({ status: 'already_sent', caseId: opened.caseId })

      expect((await pool.query(`
        SELECT publication_state, reply_review_state
        FROM discrepancies WHERE id = 'discrepancy-a'
      `)).rows[0]).toEqual({ publication_state: 'pending_reply', reply_review_state: 'awaiting_reply' })
      expect((await pool.query(`
        SELECT count(*)::int AS count FROM notification_delivery_attempts
      `)).rows[0]?.count).toBe(2)
      expect((await pool.query(`
        SELECT count(*)::int AS count FROM discrepancy_events WHERE event_type = 'publication_changed'
      `)).rows[0]?.count).toBe(1)
      await repositories.enqueueNotification({
        id: 'notification-terminal',
        caseId: opened.caseId,
        contactEndpointId: 'contact-a',
        idempotencyKey: `${opened.caseId}:terminal-test`,
        channel: 'email',
        payload: {},
        payloadSha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      })
      const terminalClaim = await cases.claimDueNotifications({ workerId: 'notice-worker-3', now: '2026-08-10T10:05:00.000Z', leaseDurationMs: 30_000, limit: 10 })
      expect(terminalClaim.map((claim) => claim.id)).toEqual(['notification-terminal'])
      await cases.recordDeliveryAttempt({
        notificationId: 'notification-terminal',
        workerId: 'notice-worker-3',
        leaseToken: terminalClaim[0]!.leaseToken,
        result: {
          outcome: 'failed',
          startedAt: '2026-08-10T10:05:00.000Z',
          completedAt: '2026-08-10T10:05:01.000Z',
          failure: { code: 'permanent_http_status', retryable: false },
        },
      })
      expect(await cases.claimDueNotifications({ workerId: 'notice-worker-4', now: '2026-08-10T10:06:00.000Z', leaseDurationMs: 30_000, limit: 10 })).toEqual([])
      const queue = await cases.listReviewQueue()
      expect(queue).toHaveLength(1)
      expect(queue[0]).toMatchObject({ caseId: opened.caseId, publicationState: 'pending_reply' })
      const review = await cases.getReviewEvidence(opened.caseId)
      expect(review).toMatchObject({
        discrepancy: { methodologyVersion: 'method-v1' },
        caseHistory: [{ eventType: 'opened' }, { eventType: 'notice_failed' }, { eventType: 'notice_delivered' }, { eventType: 'notice_failed' }],
      })
      expect(review?.evidence[0]).toMatchObject({ rawPayload: { Authorization: '[REDACTED]' } })

      expect(await cases.expireDueReplyWindows({ now: '2026-08-13T10:03:01.000Z' })).toEqual([opened.caseId])
      expect((await pool.query(`SELECT status FROM anchor_cases WHERE id = $1`, [opened.caseId])).rows[0]?.status).toBe('under_review')
      await pool.query(`INSERT INTO api_plans (id, name, requests_per_window, window_seconds) VALUES ('review-plan', 'Review', 1, 60)`)
      await pool.query(`INSERT INTO api_principals (id, plan_id, display_name) VALUES ('reviewer-1', 'review-plan', 'Reviewer')`)
      await pool.query(`INSERT INTO api_scopes (id, description) VALUES ('anchor:review', 'Review anchor cases')`)
      await pool.query(`INSERT INTO api_principal_scopes (principal_id, scope_id) VALUES ('reviewer-1', 'anchor:review')`)
      await expect(cases.reviewCase({
        caseId: opened.caseId,
        reviewerPrincipalId: 'reviewer-1',
        decision: 'approve_public',
        reviewedAt: '2026-08-13T10:04:00.000Z',
      })).rejects.toThrow(/publication is disabled/)
      expect(await cases.reviewCase({
        caseId: opened.caseId,
        reviewerPrincipalId: 'reviewer-1',
        decision: 'approve_public',
        reviewedAt: '2026-08-13T10:04:00.000Z',
        allowNamedPartyPublication: true,
      })).toMatchObject({ publicationState: 'approved_public' })
      expect((await pool.query(`SELECT status FROM anchor_cases WHERE id = $1`, [opened.caseId])).rows[0]?.status).toBe('resolved')

      await pool.query(`
        INSERT INTO anchor_contact_endpoints (id, anchor_id, kind, endpoint, verified_at)
        VALUES ('webhook-a', 'anchor-a', 'webhook', 'https://hooks.example/notice', '2026-08-10T09:00:00.000Z')
      `)
      const keyring = parseContactSecretKeyring({
        ANCHOR_CONTACT_SECRET_KEYS: `key-1:${Buffer.alloc(32, 4).toString('base64')}`,
        ANCHOR_CONTACT_ACTIVE_KEY_ID: 'key-1',
      })
      expect(await cases.rotateContactSecret({
        contactEndpointId: 'webhook-a',
        secret: 'first-secret',
        rotatedAt: '2026-08-13T10:05:00.000Z',
        keyring,
        random: () => new Uint8Array(12).fill(1),
      })).toMatchObject({ version: 1, keyId: 'key-1' })
      expect(await cases.rotateContactSecret({
        contactEndpointId: 'webhook-a',
        secret: 'second-secret',
        rotatedAt: '2026-08-13T10:06:00.000Z',
        keyring,
        random: () => new Uint8Array(12).fill(2),
      })).toMatchObject({ version: 2, keyId: 'key-1' })
      const secrets = await pool.query(`SELECT ciphertext, retired_at FROM anchor_contact_secrets ORDER BY version`)
      expect(secrets.rows).toHaveLength(2)
      expect(JSON.stringify(secrets.rows)).not.toContain('first-secret')
      expect(JSON.stringify(secrets.rows)).not.toContain('second-secret')
      expect(secrets.rows.filter((row) => row.retired_at === null)).toHaveLength(1)
    } finally {
      await pool.end()
    }
  })

  it('rolls back the complete batch when a contribution cannot be linked to evidence', async () => {
    const pool = await createDatabase()
    try {
      const repositories = createPersistenceRepositories({ pool, db: drizzle({ client: pool, schema }) })
      const batch = cycleBatch('invalid', '2026-08-10T11:00:00.000Z')
      const snapshot = batch.snapshot as { contributions: Array<{ observationId: string }> }
      snapshot.contributions[0]!.observationId = 'missing-observation'
      await expect(repositories.persistCompletedCycle(batch)).rejects.toThrow('has no reading')
      expect((await pool.query('SELECT count(*)::int AS count FROM ingest_cycles')).rows[0]?.count).toBe(0)
      expect((await pool.query('SELECT count(*)::int AS count FROM raw_readings')).rows[0]?.count).toBe(0)
    } finally {
      await pool.end()
    }
  })

  it('appends linked resolution and correction events and blocks audit mutation for an application role', async () => {
    const pool = await createDatabase()
    try {
      const repositories = createPersistenceRepositories({ pool, db: drizzle({ client: pool, schema }) })
      const opened = cycleBatch('one', '2026-08-10T10:00:00.000Z')
      await repositories.persistCompletedCycle(opened)

      const resolved = cycleBatch('two', '2026-08-10T11:00:00.000Z')
      resolved.sourceHealthStates = [{
        sourceId: 'source-a',
        state: 'unreachable',
        consecutiveFailures: 3,
        circuitState: 'open',
        circuitOpenedAt: '2026-08-10T11:00:00.000Z',
        nextAttemptAt: '2026-08-10T11:01:00.000Z',
        lastErrorCode: 'request_failed',
        lastObservedAt: '2026-08-10T11:00:00.000Z',
      }]
      const resolvedState = {
        ...(resolved.discrepancyStates['source-a'] as Record<string, unknown>),
        lifecycleState: 'resolved',
        consecutiveCycles: 0,
        consecutiveAboveInfoCycles: 0,
      }
      resolved.discrepancyStates = { 'source-a': resolvedState }
      resolved.events = [
        {
          eventId: 'event-reconverged',
          type: 'reconverged',
          discrepancyId: 'discrepancy-a',
          sourceId: 'source-a',
          methodologyVersion: 'method-v1',
          cycleId: 'cycle-two',
          occurredAt: '2026-08-10T11:00:00.000Z',
          deviationBand: 'within_tolerance',
          before: {
            severity: 'warning',
            lifecycleState: 'open',
            publicationState: 'internal',
            replyReviewState: 'not_required',
            consecutiveCycles: 1,
            consecutiveAboveInfoCycles: 1,
          },
          after: {
            severity: 'warning',
            lifecycleState: 'resolved',
            publicationState: 'internal',
            replyReviewState: 'not_required',
            consecutiveCycles: 0,
            consecutiveAboveInfoCycles: 0,
          },
        },
        {
          eventId: 'event-resolved',
          type: 'resolved',
          discrepancyId: 'discrepancy-a',
          sourceId: 'source-a',
          methodologyVersion: 'method-v1',
          cycleId: 'cycle-two',
          occurredAt: '2026-08-10T11:00:00.000Z',
          deviationBand: 'within_tolerance',
          before: {
            severity: 'warning',
            lifecycleState: 'open',
            publicationState: 'internal',
            replyReviewState: 'not_required',
            consecutiveCycles: 1,
            consecutiveAboveInfoCycles: 1,
          },
          after: {
            severity: 'warning',
            lifecycleState: 'resolved',
            publicationState: 'internal',
            replyReviewState: 'not_required',
            consecutiveCycles: 0,
            consecutiveAboveInfoCycles: 0,
          },
        },
      ]
      await repositories.persistCompletedCycle(resolved)
      expect(await repositories.getSourceHealthStates(['source-a'])).toEqual({
        'source-a': expect.objectContaining({
          state: 'unreachable',
          consecutiveFailures: 3,
          circuitState: 'open',
          nextAttemptAt: '2026-08-10T11:01:00.000Z',
        }),
      })

      const stale = cycleBatch('stale', '2026-08-10T10:30:00.000Z')
      await expect(repositories.persistCompletedCycle(stale)).rejects.toThrow('newer finalization or incompatible identity')
      expect(
        (await pool.query(`SELECT count(*)::int AS count FROM ingest_cycles WHERE id = 'cycle-stale'`)).rows[0]?.count,
      ).toBe(0)

      await expect(
        repositories.appendDiscrepancyAmendment({
          eventId: 'event-wrong-source',
          type: 'corrected',
          discrepancyId: 'discrepancy-a',
          sourceId: 'source-b',
          methodologyVersion: 'method-v1',
          targetEventId: 'event-opened-one',
          occurredAt: '2026-08-10T12:00:00.000Z',
          reason: 'Invalid cross-source amendment',
          correctedDeviationBand: 'info',
          requiresReplay: true,
        }),
      ).rejects.toThrow('same discrepancy and methodology')

      await repositories.appendDiscrepancyAmendment({
        eventId: 'event-corrected',
        type: 'corrected',
        discrepancyId: 'discrepancy-a',
        sourceId: 'source-a',
        methodologyVersion: 'method-v1',
        targetEventId: 'event-opened-one',
        occurredAt: '2026-08-10T12:00:00.000Z',
        reason: 'Upstream evidence was revised',
        correctedDeviationBand: 'info',
        requiresReplay: true,
      })

      const chain = await repositories.getDiscrepancyEventChain('discrepancy-a')
      expect(chain.map((event) => event.eventType)).toEqual(['opened', 'reconverged', 'resolved', 'corrected'])
      expect(chain.find((event) => event.eventType === 'resolved')?.targetEventId).toBe('event-opened-one')
      expect(chain.find((event) => event.eventType === 'corrected')?.targetEventId).toBe('event-opened-one')

      const role = `axiom_app_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      roles.push(role)
      await adminPool.query(`CREATE ROLE "${role}" NOLOGIN`)
      await pool.query(`GRANT USAGE ON SCHEMA public TO "${role}"`)
      await pool.query(`
        GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE
        ON discrepancy_events, raw_readings, source_health_samples
        TO "${role}"
      `)
      const connection = await pool.connect()
      try {
        await connection.query(`SET ROLE "${role}"`)
        await expect(
          connection.query(`UPDATE discrepancy_events SET event_type = 'tampered' WHERE id = 'event-opened-one'`),
        ).rejects.toMatchObject({ code: '55000' })
        await expect(connection.query(`DELETE FROM raw_readings WHERE id = 'reading-one'`)).rejects.toMatchObject({
          code: '55000',
        })
        await expect(connection.query('TRUNCATE TABLE source_health_samples')).rejects.toMatchObject({ code: '55000' })
      } finally {
        await connection.query('RESET ROLE')
        connection.release()
      }
      expect((await repositories.getDiscrepancyEventChain('discrepancy-a'))[0]?.eventType).toBe('opened')
    } finally {
      await pool.end()
    }
  })
})
