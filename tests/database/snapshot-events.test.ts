import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSnapshotEventRepository, SnapshotReplayError } from '../../lib/db/snapshot-event-repository'
import * as schema from '../../lib/db/schema'

const adminUrl = process.env.DATABASE_TEST_ADMIN_URL
const describeWithDatabase = adminUrl ? describe : describe.skip
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))
const databases: string[] = []
let adminPool: Pool

async function database() {
  const name = `axiom_events_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  await adminPool.query(`CREATE DATABASE "${name}"`)
  databases.push(name)
  const url = new URL(adminUrl!); url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.toString(), max: 3 })
  await migrate(drizzle({ client: pool }), { migrationsFolder })
  return { pool, client: { pool, db: drizzle({ client: pool, schema }) } }
}

function payload(id: number) {
  return {
    snapshot_id: `snapshot_${id}`,
    metric: 'latest_ledger',
    subject: { kind: 'network', network: 'public' },
    status: 'verified',
    as_of: `2026-08-13T10:00:0${id}.000Z`,
    methodology_version: 'latest-ledger-v0.2',
    resource: '/api/v1/stellar/latest-ledger',
  }
}

describeWithDatabase('durable snapshot event replay', () => {
  beforeAll(() => { adminPool = new Pool({ connectionString: adminUrl, max: 1 }) })
  afterAll(async () => {
    await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1)', [databases])
    for (const name of databases) await adminPool.query(`DROP DATABASE IF EXISTS "${name}"`)
    await adminPool.end()
  })

  it('resumes without duplicates or gaps and observes events written by another instance', async () => {
    const { pool, client } = await database()
    try {
      for (let id = 1; id <= 3; id += 1) {
        await pool.query(`
          INSERT INTO ingest_cycles
            (id, metric, subject_key, methodology_version, idempotency_key, status, scheduled_at, started_at, completed_at)
          VALUES ($1, 'latest_ledger', 'public', 'latest-ledger-v0.2', $2, 'completed', $3, $3, $3)
        `, [`cycle_${id}`, `event_cycle_${id}`, payload(id).as_of])
        await pool.query(`
          INSERT INTO reconciliation_snapshots
            (id, cycle_id, metric, subject_key, status, subject, value, confidence, confidence_formula_version,
             confidence_components, sources_configured, sources_responded, sources_usable, sources_agreeing,
             sources_excluded, methodology_version, as_of)
          VALUES ($1, $2, 'latest_ledger', 'public', 'verified', '{"kind":"network","network":{"id":"public","passphrase":"Public Global Stellar Network ; September 2015"}}',
                  '{"kind":"ledger","value":58000000}', 0.95, 'confidence-v1', '{}', 1, 1, 1, 1, 0,
                  'latest-ledger-v0.2', $3)
        `, [`snapshot_${id}`, `cycle_${id}`, payload(id).as_of])
        await pool.query(`INSERT INTO snapshot_events (snapshot_id, payload, occurred_at) VALUES ($1, $2, $3)`, [
          `snapshot_${id}`, payload(id), payload(id).as_of,
        ])
      }

      const repository = createSnapshotEventRepository(client)
      const first = await repository.prepare(1n, 10)
      expect(first.events.map((event) => event.id)).toEqual(['2', '3'])
      const resumed = await repository.prepare(2n, 10)
      expect(resumed.events.map((event) => event.id)).toEqual(['3'])
      expect((await repository.prepare(null, 10))).toEqual({ cursor: 3n, events: [] })

      await pool.query(`
        INSERT INTO ingest_cycles
          (id, metric, subject_key, methodology_version, idempotency_key, status, scheduled_at, started_at, completed_at)
        VALUES ('cycle_4', 'latest_ledger', 'public', 'latest-ledger-v0.2', 'event_cycle_4', 'completed', $1, $1, $1)
      `, [payload(4).as_of])
      await pool.query(`
        INSERT INTO reconciliation_snapshots
          (id, cycle_id, metric, subject_key, status, subject, value, confidence, confidence_formula_version,
           confidence_components, sources_configured, sources_responded, sources_usable, sources_agreeing,
           sources_excluded, methodology_version, as_of)
        VALUES ('snapshot_4', 'cycle_4', 'latest_ledger', 'public', 'verified', '{"kind":"network","network":{"id":"public","passphrase":"Public Global Stellar Network ; September 2015"}}',
                '{"kind":"ledger","value":58000001}', 0.95, 'confidence-v1', '{}', 1, 1, 1, 1, 0,
                'latest-ledger-v0.2', $1)
      `, [payload(4).as_of])
      await pool.query(`INSERT INTO snapshot_events (snapshot_id, payload, occurred_at) VALUES ('snapshot_4', $1, $2)`, [payload(4), payload(4).as_of])
      expect((await repository.readAfter(3n, 10)).map((event) => event.id)).toEqual(['4'])

      await expect(repository.prepare(1n, 1)).rejects.toBeInstanceOf(SnapshotReplayError)
      await expect(pool.query(`UPDATE snapshot_events SET payload = '{}'`)).rejects.toMatchObject({ code: '55000' })
    } finally {
      await pool.end()
    }
  })
})
