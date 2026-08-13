import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabaseBackup, runDatabaseRestoreDrill } from '../../lib/operations/database-backup'
import * as schema from '../../lib/db/schema'

const adminUrl = process.env.DATABASE_TEST_ADMIN_URL
const clientToolsAvailable = ['pg_dump', 'pg_restore'].every((command) => spawnSync(command, ['--version']).status === 0)
if (process.env.DATABASE_RESTORE_TOOLS_REQUIRED === 'true' && !clientToolsAvailable) {
  throw new Error('pg_dump and pg_restore are required for the restore-drill test')
}
const describeWithDatabase = adminUrl && clientToolsAvailable ? describe : describe.skip
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))
const databases: string[] = []
const directories: string[] = []
let adminPool: Pool

describeWithDatabase('database backup restore drill', () => {
  beforeAll(() => { adminPool = new Pool({ connectionString: adminUrl, max: 1 }) })
  afterAll(async () => {
    await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1)', [databases])
    for (const name of databases) await adminPool.query(`DROP DATABASE IF EXISTS "${name}"`)
    await adminPool.end()
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('backs up a migrated database and restores it into a verified ephemeral database', async () => {
    const name = `axiom_backup_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    await adminPool.query(`CREATE DATABASE "${name}"`)
    databases.push(name)
    const sourceUrl = new URL(adminUrl!); sourceUrl.pathname = `/${name}`
    const sourcePool = new Pool({ connectionString: sourceUrl.toString(), max: 1 })
    try {
      await migrate(drizzle({ client: sourcePool, schema }), { migrationsFolder })
      await sourcePool.query(`INSERT INTO networks (id, passphrase, display_name) VALUES ('restore-proof', 'Restore proof', 'Restore proof')`)
      await sourcePool.query(`INSERT INTO api_plans (id, name, requests_per_window, window_seconds) VALUES ('restore-plan', 'Restore plan', 10, 60)`)
      await sourcePool.query(`INSERT INTO api_principals (id, plan_id, display_name) VALUES ('restore-principal', 'restore-plan', 'Restore principal')`)
      await sourcePool.query(`INSERT INTO api_keys (id, principal_id, key_prefix, key_hash) VALUES ('restore-key', 'restore-principal', 'restore', '${'a'.repeat(64)}')`)
      await sourcePool.query(`INSERT INTO api_key_events (id, key_id, principal_id, event_type, actor, occurred_at) VALUES ('restore-event', 'restore-key', 'restore-principal', 'created', 'restore-test', now())`)
    } finally {
      await sourcePool.end()
    }

    const directory = await mkdtemp(path.join(os.tmpdir(), 'axiom-restore-drill-'))
    directories.push(directory)
    const backup = await createDatabaseBackup({
      environment: { DATABASE_BACKUP_URL: sourceUrl.toString(), DATABASE_BACKUP_DIRECTORY: directory, DATABASE_BACKUP_ENVIRONMENT_ID: 'ci-source', DATABASE_BACKUP_ENCRYPTION_KEYS: `ci-key:${Buffer.alloc(32, 5).toString('base64')}`, DATABASE_BACKUP_ACTIVE_KEY_ID: 'ci-key' },
    })
    const result = await runDatabaseRestoreDrill({
      dumpPath: backup.dumpPath,
      environment: {
        DATABASE_RESTORE_ADMIN_URL: adminUrl,
        DATABASE_RESTORE_ENVIRONMENT_ID: 'ci-restore',
        DATABASE_BACKUP_ENCRYPTION_KEYS: `ci-key:${Buffer.alloc(32, 5).toString('base64')}`,
        DATABASE_BACKUP_ACTIVE_KEY_ID: 'ci-key',
        DATABASE_RESTORE_DRILL_ACK: 'CREATE_AND_DROP_EPHEMERAL_DATABASE',
      },
      allowSourceServerForTest: true,
    })
    expect(result.database).toMatch(/^axiom_restore_[0-9a-f]{16}$/)
    expect(result.immutabilityTriggers).toBe(17)
    expect(result.inventory.networks).toBe(1)
    expect(result.inventory.api_key_events).toBe(1)
    const remaining = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [result.database])
    expect(remaining.rowCount).toBe(0)
  })
})
