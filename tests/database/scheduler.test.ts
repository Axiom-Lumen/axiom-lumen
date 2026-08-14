import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSchedulerRepository } from '../../lib/db/scheduler-repository'
import { queryLatestLedgerReadModel } from '../../lib/db/latest-ledger-read-model'
import * as schema from '../../lib/db/schema'

const adminUrl = process.env.DATABASE_TEST_ADMIN_URL
const describeWithDatabase = adminUrl ? describe : describe.skip
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))
const databases: string[] = []
let adminPool: Pool

async function database() {
  if (!adminUrl) throw new Error('DATABASE_TEST_ADMIN_URL is required')
  const name = `axiom_scheduler_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  await adminPool.query(`CREATE DATABASE "${name}"`)
  databases.push(name)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.toString(), max: 4 })
  await migrate(drizzle({ client: pool }), { migrationsFolder })
  const client = { pool, db: drizzle({ client: pool, schema }) }
  return { pool, client, repository: createSchedulerRepository(client) }
}

const scheduled = {
  id: 'cycle-scheduled',
  metric: 'latest_ledger' as const,
  subjectKey: 'public',
  methodologyVersion: 'latest-ledger-v0.2',
  idempotencyKey: 'latest_ledger:public:latest-ledger-v0.2:2026-08-10T10:00:00.000Z',
  scheduledAt: '2026-08-10T10:00:00.000Z',
}

describeWithDatabase('scheduler leases', () => {
  beforeAll(() => {
    adminPool = new Pool({ connectionString: adminUrl, max: 1 })
  })

  afterAll(async () => {
    await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1)', [databases])
    for (const name of databases) await adminPool.query(`DROP DATABASE IF EXISTS "${name}"`)
    await adminPool.end()
  })

  it('allows only one worker to claim a scheduled cycle', async () => {
    const { pool, repository } = await database()
    try {
      await repository.ensureScheduledCycle(scheduled)
      expect(await repository.ensureScheduledCycle({
        ...scheduled,
        id: 'cycle-next',
        idempotencyKey: 'next-idempotency-key',
        scheduledAt: '2026-08-10T10:01:00.000Z',
      })).toBe(false)
      const claims = await Promise.all([
        repository.claimNextCycle({ workerId: 'worker-a', now: scheduled.scheduledAt, leaseDurationMs: 30_000 }),
        repository.claimNextCycle({ workerId: 'worker-b', now: scheduled.scheduledAt, leaseDurationMs: 30_000 }),
      ])

      expect(claims.filter(Boolean)).toHaveLength(1)
      expect(claims.find(Boolean)).toMatchObject({ id: scheduled.id, leaseToken: 1, attemptCount: 1 })
    } finally {
      await pool.end()
    }
  })

  it('retries an expired lease and recognizes finalization after a worker crashes before acknowledgement', async () => {
    const { pool, repository } = await database()
    try {
      await repository.ensureScheduledCycle(scheduled)
      const first = await repository.claimNextCycle({
        workerId: 'worker-a',
        now: scheduled.scheduledAt,
        leaseDurationMs: 1_000,
      })
      expect(first).not.toBeNull()

      expect(await repository.reapExpiredLeases('2026-08-10T10:00:02.000Z', 3)).toEqual({
        retried: 1,
        abandoned: 0,
        finalized: 0,
      })
      const retry = await repository.claimNextCycle({
        workerId: 'worker-b',
        now: '2026-08-10T10:00:02.000Z',
        leaseDurationMs: 1_000,
      })
      expect(retry).toMatchObject({ leaseToken: 2, attemptCount: 2 })

      await pool.query(
        `INSERT INTO ingest_cycles
          (id, metric, subject_key, methodology_version, idempotency_key, status, scheduled_at, started_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8)`,
        [
          scheduled.id,
          scheduled.metric,
          scheduled.subjectKey,
          scheduled.methodologyVersion,
          scheduled.idempotencyKey,
          scheduled.scheduledAt,
          '2026-08-10T10:00:02.000Z',
          '2026-08-10T10:00:02.500Z',
        ],
      )
      expect(await repository.reapExpiredLeases('2026-08-10T10:00:04.000Z', 3)).toEqual({
        retried: 0,
        abandoned: 0,
        finalized: 1,
      })
      const lease = await pool.query(
        'SELECT status, finalized_cycle_id, attempt_count, lease_owner FROM scheduled_cycle_leases WHERE id = $1',
        [scheduled.id],
      )
      expect(lease.rows[0]).toEqual({
        status: 'completed',
        finalized_cycle_id: scheduled.id,
        attempt_count: 2,
        lease_owner: null,
      })
      await expect(
        pool.query(
          `INSERT INTO ingest_cycles
            (id, metric, subject_key, methodology_version, idempotency_key, status, scheduled_at, started_at, completed_at)
           VALUES ('duplicate-cycle', $1, $2, $3, $4, 'completed', $5, $6, $7)`,
          [
            scheduled.metric,
            scheduled.subjectKey,
            scheduled.methodologyVersion,
            scheduled.idempotencyKey,
            scheduled.scheduledAt,
            '2026-08-10T10:00:02.000Z',
            '2026-08-10T10:00:02.500Z',
          ],
        ),
      ).rejects.toMatchObject({ code: '23505' })
    } finally {
      await pool.end()
    }
  })

  it('abandons an expired lease when its attempt budget is exhausted', async () => {
    const { pool, repository } = await database()
    try {
      await repository.ensureScheduledCycle(scheduled)
      await repository.claimNextCycle({ workerId: 'worker-a', now: scheduled.scheduledAt, leaseDurationMs: 1_000 })

      expect(await repository.reapExpiredLeases('2026-08-10T10:00:02.000Z', 1)).toEqual({
        retried: 0,
        abandoned: 1,
        finalized: 0,
      })
      const lease = await pool.query('SELECT status, last_error FROM scheduled_cycle_leases WHERE id = $1', [scheduled.id])
      expect(lease.rows[0]).toMatchObject({
        status: 'abandoned',
        last_error: { name: 'LeaseExpired' },
      })
    } finally {
      await pool.end()
    }
  })

  it('routes the exact mZAR binding to retrospective v0.2 without changing generic v0.1 routes', async () => {
    const { pool, repository } = await database()
    try {
      const issuer = 'GCBNWTCCMC32UHZ5OCC2PNMFDGXRVPA7MFFBFFTCVW77SX5PMRB7Q4BY'
      await pool.query(`INSERT INTO networks (id, passphrase, display_name) VALUES ('public', 'Public Global Stellar Network ; September 2015', 'Public')`)
      await pool.query(`INSERT INTO assets (id, network_id, type, code, issuer, canonical_id) VALUES ('asset-mzar', 'public', 'credit', 'mZAR', $1, $2)`, [issuer, `mZAR:${issuer}`])
      await pool.query(`INSERT INTO anchors (id, network_id, name, stellar_account, status) VALUES ('anchor-mzar', 'public', 'Mesh Trade South Africa (Pty) Ltd', $1, 'verified')`, [issuer])
      await pool.query(`
        INSERT INTO anchor_domains (id, anchor_id, domain, verified_at, verification_expires_at)
        VALUES ('domain-mzar', 'anchor-mzar', 'mzar.co.za', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z')
      `)
      await pool.query(`
        INSERT INTO source_definitions (id, network_id, anchor_id, source_class, adapter, url, upstream_id, config)
        VALUES ('source-mzar', 'public', 'anchor-mzar', 'anchor_self_reported', 'anchor', 'https://mzar.co.za/', 'anchor-mzar',
          '{"anchorReserves":{"enabled":true,"assetIds":["asset-mzar"],"verifications":{"asset-mzar":{"domainId":"domain-mzar","verifiedAt":"2026-04-01T00:00:00.000Z","verificationExpiresAt":"2026-04-02T00:00:00.000Z"}},"profiles":{"asset-mzar":"mesh_mzar_pdf_v1"}}}')
      `)
      expect(await repository.discoverAnchorReserveJobs('anchor-reserve-comparison-v0.1', new Date('2026-04-01T12:00:00.000Z'))).toEqual([{
        metric: 'anchor_reserves', subjectKey: `public:mZAR:${issuer}`, methodologyVersion: 'anchor-reserve-comparison-v0.2',
        anchorId: 'anchor-mzar', connectorProfile: 'mesh_mzar_pdf_v1', asset: { kind: 'credit', code: 'mZAR', issuer },
        sources: [expect.objectContaining({ id: 'source-mzar', url: 'https://mzar.co.za/' })],
      }])
    } finally {
      await pool.end()
    }
  })

  it('reconstructs the compatibility response from finalized evidence only', async () => {
    const { pool, client, repository } = await database()
    try {
      await pool.query(`
        INSERT INTO networks (id, passphrase, display_name)
        VALUES ('public', 'Public Global Stellar Network ; September 2015', 'Public')
      `)
      await pool.query(`
        INSERT INTO source_definitions (id, network_id, source_class, adapter, url)
        VALUES ('source-a', 'public', 'canonical_ledger', 'horizon', 'https://a.example')
      `)
      expect(await repository.discoverLatestLedgerJobs('latest-ledger-v0.2')).toEqual([{
        metric: 'latest_ledger',
        subjectKey: 'public',
        methodologyVersion: 'latest-ledger-v0.2',
        sources: [{
          id: 'source-a',
          url: 'https://a.example',
          sourceClass: 'canonical_ledger',
          adapter: 'horizon',
          upstreamId: null,
          networkId: 'public',
          networkPassphrase: 'Public Global Stellar Network ; September 2015',
        }],
      }])
      const canonicalAsset = `USDC:G${'A'.repeat(55)}`
      await pool.query(`
        INSERT INTO assets (id, network_id, type, code, issuer, canonical_id)
        VALUES ('asset-usdc', 'public', 'credit', 'USDC', $1, $2)
      `, [`G${'A'.repeat(55)}`, canonicalAsset])
      await pool.query(`
        UPDATE source_definitions
        SET config = '{"supply":{"enabled":true,"assetIds":["asset-usdc"]}}'
        WHERE id = 'source-a'
      `)
      await pool.query(`
        INSERT INTO source_definitions (id, network_id, source_class, adapter, url, config)
        VALUES (
          'archive-a', 'public', 'archive', 'archive', 'https://archive.example/usdc.json',
          '{"supply":{"enabled":true,"assetIds":["asset-usdc"],"trustedCheckpoints":{"asset-usdc":{"ledgerSequence":500}}}}'
        )
      `)
      expect(await repository.discoverSupplyJobs('onchain-asset-supply-v0.1')).toEqual([{
        metric: 'circulating_supply',
        subjectKey: `public:${canonicalAsset}`,
        methodologyVersion: 'onchain-asset-supply-v0.1',
        asset: { kind: 'credit', code: 'USDC', issuer: `G${'A'.repeat(55)}` },
        sources: [
          expect.objectContaining({ id: 'archive-a', adapter: 'archive', trustedCheckpoint: { ledgerSequence: 500 } }),
          expect.objectContaining({ id: 'source-a', adapter: 'horizon' }),
        ],
      }])
      await pool.query(`
        UPDATE source_definitions
        SET config = jsonb_set(config, '{trustlines}', '{"enabled":true,"assetIds":["asset-usdc"]}'::jsonb)
        WHERE id = 'source-a'
      `)
      expect(await repository.discoverTrustlineJobs('trustline-state-v0.1')).toEqual([{
        metric: 'trustline_count',
        subjectKey: `public:${canonicalAsset}`,
        methodologyVersion: 'trustline-state-v0.1',
        asset: { kind: 'credit', code: 'USDC', issuer: `G${'A'.repeat(55)}` },
        sources: [expect.objectContaining({ id: 'source-a', adapter: 'horizon', sourceClass: 'canonical_ledger' })],
      }])
      await pool.query(`
        INSERT INTO anchors (id, network_id, name, stellar_account, status)
        VALUES ('anchor-usdc', 'public', 'Example Anchor', $1, 'verified')
      `, [`G${'A'.repeat(55)}`])
      await pool.query(`
        INSERT INTO anchor_domains (id, anchor_id, domain, verified_at, verification_expires_at)
        VALUES (
          'anchor-domain-usdc', 'anchor-usdc', 'anchor.example',
          '2026-08-11T12:00:00.000Z', '2026-08-12T12:00:00.000Z'
        )
      `)
      await pool.query(`
        INSERT INTO source_definitions (id, network_id, anchor_id, source_class, adapter, url, upstream_id, config)
        VALUES (
          'anchor-reserve-a', 'public', 'anchor-usdc', 'anchor_self_reported', 'anchor',
          'https://anchor.example/reserve.json', 'anchor-usdc',
          '{"anchorReserves":{"enabled":true,"assetIds":["asset-usdc"],"verifications":{"asset-usdc":{"domainId":"anchor-domain-usdc","verifiedAt":"2026-08-11T12:00:00.000Z","verificationExpiresAt":"2026-08-12T12:00:00.000Z"}}}}'
        )
      `)
      expect(await repository.discoverAnchorReserveJobs('anchor-reserve-comparison-v0.1', new Date('2026-08-11T12:30:00.000Z'))).toEqual([{
        metric: 'anchor_reserves',
        subjectKey: `public:${canonicalAsset}`,
        methodologyVersion: 'anchor-reserve-comparison-v0.1',
        anchorId: 'anchor-usdc',
        connectorProfile: 'axiom_json_v1',
        asset: { kind: 'credit', code: 'USDC', issuer: `G${'A'.repeat(55)}` },
        sources: [expect.objectContaining({ id: 'anchor-reserve-a', adapter: 'anchor', sourceClass: 'anchor_self_reported' })],
      }])
      await pool.query(`
        INSERT INTO source_definitions (id, network_id, anchor_id, source_class, adapter, url, upstream_id, config)
        VALUES (
          'anchor-reserve-duplicate', 'public', 'anchor-usdc', 'anchor_self_reported', 'anchor',
          'https://anchor.example/reserve-duplicate.json', 'anchor-usdc',
          '{"anchorReserves":{"enabled":true,"assetIds":["asset-usdc"],"verifications":{"asset-usdc":{"domainId":"anchor-domain-usdc","verifiedAt":"2026-08-11T12:00:00.000Z","verificationExpiresAt":"2026-08-12T12:00:00.000Z"}}}}'
        )
      `)
      await expect(repository.discoverAnchorReserveJobs('anchor-reserve-comparison-v0.1', new Date('2026-08-11T12:30:00.000Z'))).rejects.toThrow('multiple active verified')
      await pool.query(`UPDATE source_definitions SET enabled = false WHERE id = 'anchor-reserve-duplicate'`)
      await pool.query(`UPDATE anchor_domains SET verification_expires_at = '2026-08-11T13:00:00.000Z' WHERE id = 'anchor-domain-usdc'`)
      expect(await repository.discoverAnchorReserveJobs('anchor-reserve-comparison-v0.1', new Date('2026-08-11T13:00:00.000Z'))).toEqual([])
      expect(await repository.discoverAnchorReserveJobs('anchor-reserve-comparison-v0.1', new Date('2026-08-12T12:00:00.000Z'))).toEqual([])
      await pool.query(`
        UPDATE source_definitions
        SET config = jsonb_set(config, '{trustlines}', '{"enabled":true,"assetIds":"asset-usdc"}'::jsonb)
        WHERE id = 'source-a'
      `)
      expect(await repository.discoverTrustlineJobs('trustline-state-v0.1')).toEqual([
        expect.objectContaining({
          sources: [expect.objectContaining({ id: 'source-a', configurationError: 'Trustline source configuration is malformed' })],
        }),
      ])
      await pool.query(`
        UPDATE source_definitions
        SET config = '{"supply":{"enabled":true,"assetIds":"asset-usdc"}}'
        WHERE id = 'source-a'
      `)
      expect(await repository.discoverSupplyJobs('onchain-asset-supply-v0.1')).toEqual([{
        metric: 'circulating_supply',
        subjectKey: `public:${canonicalAsset}`,
        methodologyVersion: 'onchain-asset-supply-v0.1',
        asset: { kind: 'credit', code: 'USDC', issuer: `G${'A'.repeat(55)}` },
        sources: [
          expect.objectContaining({ id: 'archive-a', adapter: 'archive' }),
          expect.objectContaining({
            id: 'source-a',
            adapter: 'horizon',
            configurationError: 'Supply source configuration is malformed',
          }),
        ],
      }])
      await pool.query(`
        INSERT INTO ingest_cycles
          (id, metric, subject_key, methodology_version, idempotency_key, status, scheduled_at, started_at, completed_at)
        VALUES ('cycle-a', 'latest_ledger', 'public', 'latest-ledger-v0.2', 'idem-a', 'completed',
                '2026-08-10T10:00:00Z', '2026-08-10T10:00:00Z', '2026-08-10T10:00:01Z')
      `)
      await pool.query(`
        INSERT INTO retrieval_attempts
          (id, cycle_id, source_id, attempt_number, outcome, started_at, completed_at, http_status)
        VALUES ('attempt-a', 'cycle-a', 'source-a', 1, 'success',
                '2026-08-10T10:00:00Z', '2026-08-10T10:00:01Z', 200)
      `)
      await pool.query(`
        INSERT INTO raw_readings
          (id, observation_id, cycle_id, attempt_id, source_id, metric, subject_key, normalized_value,
           source_identity, raw_payload, payload_sha256, source_timestamp, retrieved_at)
        VALUES ('reading-a', 'observation-a', 'cycle-a', 'attempt-a', 'source-a', 'latest_ledger', 'public',
                '{"kind":"ledger","value":500}',
                '{"id":"source-a","sourceClass":"canonical_ledger","adapter":"horizon","url":"https://a.example","network":{"id":"public","passphrase":"Public Global Stellar Network ; September 2015"}}',
                '{"sequence":500}', repeat('a', 64),
                '2026-08-10T09:59:59Z', '2026-08-10T10:00:01Z')
      `)
      await pool.query(`
        INSERT INTO reconciliation_snapshots
          (id, cycle_id, metric, subject_key, status, subject, value, confidence, confidence_formula_version,
           confidence_components, confidence_caps_applied, source_errors, sources_configured, sources_responded,
           sources_usable, sources_agreeing, sources_excluded, methodology_version, as_of)
        VALUES ('snapshot-a', 'cycle-a', 'latest_ledger', 'public', 'degraded',
                '{"kind":"network","network":{"id":"public","passphrase":"Public Global Stellar Network ; September 2015"}}',
                '{"kind":"ledger","value":500}', 0.6, 'latest-ledger-confidence-v0.2',
                '{"agreement":1,"freshness":0.9,"availability":1,"diversity":1,"spread":1}',
                '["single_source"]', '[]', 1, 1, 1, 1, 0, 'latest-ledger-v0.2', '2026-08-10T10:00:01Z')
      `)
      await pool.query(`
        INSERT INTO snapshot_contributions
          (snapshot_id, reading_id, source_id, age_seconds, effective_weight, agrees)
        VALUES ('snapshot-a', 'reading-a', 'source-a', 2, 0.95, true)
      `)
      await pool.query(`UPDATE source_definitions SET url = 'https://changed.example' WHERE id = 'source-a'`)

      const response = await queryLatestLedgerReadModel(client)

      expect(response).toMatchObject({
        metric: 'latest_ledger',
        value: 500,
        status: 'degraded',
        confidence: 0.6,
        confidence_caps_applied: ['single_source'],
        observations: [{
          sourceId: 'source-a',
          sourceUrl: 'https://a.example',
          ledgerSequence: 500,
          ageSeconds: 2,
          effectiveWeight: 0.95,
          agrees: true,
          ledgerDelta: 0,
        }],
        discrepancies: [],
      })
    } finally {
      await pool.end()
    }
  })
})
