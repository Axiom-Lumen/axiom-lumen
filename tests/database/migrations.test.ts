import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const adminUrl = process.env.DATABASE_TEST_ADMIN_URL
const describeWithDatabase = adminUrl ? describe : describe.skip
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))
const databases: string[] = []
let adminPool: Pool

function databaseName(label: string) {
  return `axiom_${label}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function databaseUrl(name: string) {
  if (!adminUrl) throw new Error('DATABASE_TEST_ADMIN_URL is required')
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  return url.toString()
}

async function createDatabase(label: string) {
  const name = databaseName(label)
  await adminPool.query(`CREATE DATABASE "${name}"`)
  databases.push(name)
  return { name, pool: new Pool({ connectionString: databaseUrl(name), max: 2 }) }
}

async function applyMigrations(pool: Pool) {
  await migrate(drizzle({ client: pool }), {
    migrationsFolder,
    migrationsSchema: 'drizzle',
    migrationsTable: '__axiom_lumen_migrations',
  })
}

async function applySqlMigration(pool: Pool, filename: string) {
  const sql = await readFile(new URL(`../../drizzle/${filename}`, import.meta.url), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) {
    await pool.query(statement)
  }
}

describeWithDatabase('PostgreSQL forward migrations', () => {
  beforeAll(() => {
    adminPool = new Pool({ connectionString: adminUrl, max: 1 })
  })

  afterAll(async () => {
    await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1)', [databases])
    for (const name of databases) await adminPool.query(`DROP DATABASE IF EXISTS "${name}"`)
    await adminPool.end()
  })

  it('migrates an empty database with explicit constraints, UTC timestamps, and query indexes', async () => {
    const { pool } = await createDatabase('empty')
    try {
      await applyMigrations(pool)
      await applyMigrations(pool)

      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
      )
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        'anchor_cases',
        'anchor_contact_endpoints',
        'anchor_domains',
        'anchor_replies',
        'anchor_reviews',
        'anchors',
        'api_keys',
        'api_plans',
        'api_principal_scopes',
        'api_principals',
        'api_quota_usage',
        'api_scopes',
        'assets',
        'corrections',
        'discrepancies',
        'discrepancy_events',
        'ingest_cycles',
        'networks',
        'notifications',
        'raw_readings',
        'reconciliation_snapshots',
        'retrieval_attempts',
        'scheduled_cycle_leases',
        'snapshot_contributions',
        'source_credential_references',
        'source_definitions',
        'source_health_samples',
        'source_health_states',
      ])

      const migrationRows = await pool.query('SELECT count(*)::int AS count FROM drizzle.__axiom_lumen_migrations')
      expect(migrationRows.rows[0]?.count).toBe(5)

      const utcColumns = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM information_schema.columns
         WHERE table_schema = 'public' AND data_type = 'timestamp with time zone'`,
      )
      expect(utcColumns.rows[0]?.count).toBeGreaterThan(30)

      const nonUtcColumns = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM information_schema.columns
         WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'`,
      )
      expect(nonUtcColumns.rows[0]?.count).toBe(0)

      const foreignKeys = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM information_schema.table_constraints
         WHERE table_schema = 'public' AND constraint_type = 'FOREIGN KEY'`,
      )
      expect(foreignKeys.rows[0]?.count).toBeGreaterThanOrEqual(35)

      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
      )
      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          'ingest_cycles_idempotency_uidx',
          'reconciliation_snapshots_latest_idx',
          'discrepancies_open_source_subject_uidx',
          'discrepancy_events_discrepancy_occurred_idx',
          'notifications_idempotency_uidx',
          'scheduled_cycle_leases_idempotency_uidx',
          'scheduled_cycle_leases_active_subject_uidx',
          'scheduled_cycle_leases_expiry_idx',
          'source_health_states_state_idx',
          'source_health_states_circuit_idx',
        ]),
      )

      await expect(
        pool.query(`INSERT INTO networks (id, passphrase, display_name) VALUES ('', 'passphrase', 'Invalid')`),
      ).rejects.toMatchObject({ code: '23514' })

      await pool.query(`INSERT INTO networks (id, passphrase, display_name) VALUES ('public', 'public-passphrase', 'Public')`)
      await pool.query(`
        INSERT INTO source_definitions (id, network_id, source_class, adapter, url)
        VALUES ('source-a', 'public', 'canonical_ledger', 'horizon', 'https://a.example')
      `)
      await expect(pool.query(`
        INSERT INTO source_health_states
          (source_id, state, consecutive_failures, circuit_state, last_observed_at)
        VALUES ('source-a', 'healthy', 1, 'closed', now())
      `)).rejects.toMatchObject({ code: '23514' })
      await pool.query(`
        INSERT INTO ingest_cycles
          (id, metric, subject_key, methodology_version, idempotency_key, status, scheduled_at, started_at)
        VALUES
          ('cycle-a', 'latest_ledger', 'public', 'latest-ledger-v0.2', 'idem-a', 'running', now(), now()),
          ('cycle-b', 'latest_ledger', 'public', 'latest-ledger-v0.2', 'idem-b', 'running', now(), now())
      `)
      await pool.query(`
        INSERT INTO retrieval_attempts
          (id, cycle_id, source_id, attempt_number, outcome, started_at, completed_at)
        VALUES ('attempt-a', 'cycle-a', 'source-a', 1, 'success', now(), now())
      `)

      await expect(
        pool.query(`
          INSERT INTO raw_readings
            (id, observation_id, cycle_id, attempt_id, source_id, metric, subject_key,
             source_identity, normalized_value, raw_payload, payload_sha256, retrieved_at)
          VALUES
            ('reading-invalid', 'obs-invalid', 'cycle-b', 'attempt-a', 'source-a', 'latest_ledger', 'public',
             '{"id":"source-a","sourceClass":"canonical_ledger","adapter":"horizon","url":"https://a.example","network":{"id":"public","passphrase":"public-passphrase"}}',
             '{"kind":"ledger","value":1}', '{}', repeat('a', 64), now())
        `),
      ).rejects.toMatchObject({ code: '23503' })

      await expect(
        pool.query(`
          INSERT INTO discrepancies
            (id, source_id, metric, subject_key, methodology_version, severity, lifecycle_state,
             publication_state, reply_review_state, consecutive_cycles, consecutive_above_info_cycles,
             first_observed_at, last_observed_at, last_finalized_cycle_id, last_finalized_cycle_at,
             publication_updated_at)
          VALUES
            ('disc-invalid', 'source-a', 'latest_ledger', 'public', 'latest-ledger-v0.2', 'warning', 'resolved',
             'internal', 'not_required', 1, 1, now(), now(), 'cycle-a', now(), now())
        `),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await pool.end()
    }
  })

  it('migrates a representative prior schema without altering existing data', async () => {
    const { pool } = await createDatabase('prior')
    try {
      await pool.query(`
        CREATE TABLE legacy_runtime_metadata (
          key text PRIMARY KEY,
          value jsonb NOT NULL,
          recorded_at timestamp with time zone NOT NULL
        )
      `)
      await pool.query(
        `INSERT INTO legacy_runtime_metadata (key, value, recorded_at) VALUES ($1, $2, $3)`,
        ['latest-ledger-profile', { methodology: 'latest-ledger-v0.2' }, '2026-08-10T00:00:00.000Z'],
      )

      await applySqlMigration(pool, '0000_flippant_magma.sql')
      await applySqlMigration(pool, '0001_outgoing_jazinda.sql')
      await applySqlMigration(pool, '0002_dat02_append_only.sql')
      await pool.query(`
        INSERT INTO networks (id, passphrase, display_name)
        VALUES ('public', 'Public Global Stellar Network ; September 2015', 'Public')
      `)
      await pool.query(`
        INSERT INTO source_definitions (id, network_id, source_class, adapter, url)
        VALUES ('source-prior', 'public', 'canonical_ledger', 'horizon', 'https://prior.example')
      `)
      await pool.query(`
        INSERT INTO ingest_cycles
          (id, metric, subject_key, methodology_version, idempotency_key, status, scheduled_at, started_at)
        VALUES ('cycle-prior', 'latest_ledger', 'public', 'latest-ledger-v0.2', 'prior-idem', 'running', now(), now())
      `)
      await pool.query(`
        INSERT INTO retrieval_attempts
          (id, cycle_id, source_id, attempt_number, outcome, started_at, completed_at)
        VALUES ('attempt-prior', 'cycle-prior', 'source-prior', 1, 'success', now(), now())
      `)
      await pool.query(`
        INSERT INTO raw_readings
          (id, observation_id, cycle_id, attempt_id, source_id, metric, subject_key,
           normalized_value, raw_payload, payload_sha256, retrieved_at)
        VALUES ('reading-prior', 'observation-prior', 'cycle-prior', 'attempt-prior', 'source-prior',
                'latest_ledger', 'public', '{"kind":"ledger","value":1}', '{}', repeat('a', 64), now())
      `)

      await applySqlMigration(pool, '0003_military_argent.sql')

      const legacy = await pool.query('SELECT key, value FROM legacy_runtime_metadata')
      expect(legacy.rows).toEqual([
        { key: 'latest-ledger-profile', value: { methodology: 'latest-ledger-v0.2' } },
      ])
      const backfilled = await pool.query(`SELECT source_identity FROM raw_readings WHERE id = 'reading-prior'`)
      expect(backfilled.rows[0]?.source_identity).toEqual({
        id: 'source-prior',
        sourceClass: 'canonical_ledger',
        adapter: 'horizon',
        url: 'https://prior.example',
        network: {
          id: 'public',
          passphrase: 'Public Global Stellar Network ; September 2015',
        },
      })
      await expect(
        pool.query(`UPDATE raw_readings SET source_identity = '{}' WHERE id = 'reading-prior'`),
      ).rejects.toMatchObject({ code: '55000' })
      const snapshotTable = await pool.query("SELECT to_regclass('public.reconciliation_snapshots') AS table_name")
      expect(snapshotTable.rows[0]?.table_name).toBe('reconciliation_snapshots')
    } finally {
      await pool.end()
    }
  })
})
