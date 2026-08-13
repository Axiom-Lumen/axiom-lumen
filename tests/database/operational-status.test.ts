import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOperationalStatusRepository } from '../../lib/db/operational-status'
import * as schema from '../../lib/db/schema'

const adminUrl = process.env.DATABASE_TEST_ADMIN_URL
const describeWithDatabase = adminUrl ? describe : describe.skip
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))
const databases: string[] = []
let adminPool: Pool

describeWithDatabase('persisted operational status', () => {
  beforeAll(() => { adminPool = new Pool({ connectionString: adminUrl, max: 1 }) })
  afterAll(async () => {
    await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1)', [databases])
    for (const name of databases) await adminPool.query(`DROP DATABASE IF EXISTS "${name}"`)
    await adminPool.end()
  })

  it('aggregates durable worker, source, freshness, and discrepancy state', async () => {
    const name = `axiom_status_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    await adminPool.query(`CREATE DATABASE "${name}"`)
    databases.push(name)
    const url = new URL(adminUrl!); url.pathname = `/${name}`
    const pool = new Pool({ connectionString: url.toString(), max: 2 })
    try {
      const client = { pool, db: drizzle({ client: pool, schema }) }
      await migrate(client.db, { migrationsFolder })
      await pool.query(`INSERT INTO networks (id, passphrase, display_name) VALUES ('public', 'Public Network', 'Public')`)
      await pool.query(`INSERT INTO source_definitions (id, network_id, source_class, adapter, url) VALUES ('source-a', 'public', 'canonical_ledger', 'horizon', 'https://horizon.example')`)
      await pool.query(`
        INSERT INTO ingest_cycles
          (id, metric, subject_key, methodology_version, idempotency_key, status, scheduled_at, started_at, completed_at)
        VALUES ('cycle-a', 'latest_ledger', 'public', 'latest-ledger-v0.2', 'status-cycle-a', 'completed',
                '2026-08-13T11:59:00Z', '2026-08-13T11:59:01Z', '2026-08-13T12:00:00Z')
      `)
      await pool.query(`
        INSERT INTO retrieval_attempts (id, cycle_id, source_id, attempt_number, outcome, started_at, completed_at)
        VALUES ('attempt-a', 'cycle-a', 'source-a', 1, 'success', '2026-08-13T11:59:59.900Z', '2026-08-13T12:00:00Z')
      `)
      await pool.query(`
        INSERT INTO reconciliation_snapshots
          (id, cycle_id, metric, subject_key, status, subject, value, confidence, confidence_formula_version,
           confidence_components, sources_configured, sources_responded, sources_usable, sources_agreeing,
           sources_excluded, methodology_version, as_of)
        VALUES ('snapshot-a', 'cycle-a', 'latest_ledger', 'public', 'verified',
                '{"kind":"network","network":{"id":"public","passphrase":"Public Network"}}',
                '{"kind":"ledger","value":58000000}', 0.95, 'confidence-v1', '{}', 1, 1, 1, 1, 0,
                'latest-ledger-v0.2', '2026-08-13T12:00:00Z')
      `)
      await pool.query(`
        INSERT INTO source_health_states (source_id, state, consecutive_failures, circuit_state, last_observed_at)
        VALUES ('source-a', 'healthy', 0, 'closed', '2026-08-13T12:00:00Z')
      `)

      const status = await createOperationalStatusRepository(client).read(new Date('2026-08-13T12:00:30Z'))
      expect(status).toMatchObject({
        status: 'operational',
        metrics: {
          retrievalLatencyMs: { average: 100, maximum: 100 },
          retrievals: { total: 1, failures: 0 },
          freshness: { trackedSnapshots: 1, staleSnapshots: 0, maximumAgeRatio: 0.25 },
          cycles: { completed: 1, maximumLagSeconds: 60 },
          sources: { tracked: 1, unhealthy: 0, stale: 0 },
          discrepancies: { open: 0, critical: 0 },
        },
      })

      await pool.query(`
        INSERT INTO source_definitions (id, network_id, source_class, adapter, url, enabled)
        VALUES ('source-disabled', 'public', 'canonical_ledger', 'horizon', 'https://disabled.example', false)
      `)
      await pool.query(`
        INSERT INTO source_health_states
          (source_id, state, consecutive_failures, circuit_state, circuit_opened_at, next_attempt_at, last_observed_at)
        VALUES ('source-disabled', 'unreachable', 4, 'open', '2026-08-13T09:00:00Z',
                '2026-08-13T12:05:00Z', '2026-08-13T09:00:00Z')
      `)
      await pool.query(`
        INSERT INTO scheduled_cycle_leases
          (id, metric, subject_key, methodology_version, idempotency_key, scheduled_at, status)
        VALUES ('lease-old', 'trustline_count', 'public:old', 'trustline-v1.3', 'status-lease-old',
                '2026-08-13T10:00:00Z', 'pending')
      `)
      await pool.query(`
        INSERT INTO discrepancies
          (id, source_id, metric, subject_key, methodology_version, named_party, severity, lifecycle_state,
           publication_state, reply_review_state, consecutive_cycles, consecutive_above_info_cycles,
           first_observed_at, last_observed_at, last_finalized_cycle_id, last_finalized_cycle_at, publication_updated_at)
        VALUES ('discrepancy-internal', 'source-a', 'latest_ledger', 'public', 'latest-ledger-v0.2', false,
                'critical', 'open', 'internal', 'not_required', 1, 1, '2026-08-13T12:00:00Z',
                '2026-08-13T12:00:00Z', 'cycle-a', '2026-08-13T12:00:00Z', '2026-08-13T12:00:00Z')
      `)

      const repository = createOperationalStatusRepository(client)
      const internal = await repository.read(new Date('2026-08-13T12:00:30Z'))
      const publiclyVisible = await repository.read(new Date('2026-08-13T12:00:30Z'), undefined, 'public')
      expect(internal.metrics.cycles).toMatchObject({ pending: 1, maximumLagSeconds: 7230 })
      expect(internal.metrics.sources).toMatchObject({ tracked: 1, unhealthy: 0, stale: 0, openCircuits: 0 })
      expect(internal.metrics.discrepancies).toMatchObject({ open: 1, critical: 1 })
      expect(publiclyVisible.metrics.discrepancies).toMatchObject({ open: 0, warning: 0, critical: 0 })
    } finally {
      await pool.end()
    }
  })
})
