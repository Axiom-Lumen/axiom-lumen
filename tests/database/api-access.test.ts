import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { issueApiKey } from '../../lib/api-access/key'
import { createApiAccessRepository } from '../../lib/db/api-access-repository'
import * as schema from '../../lib/db/schema'

const adminUrl = process.env.DATABASE_TEST_ADMIN_URL
const describeWithDatabase = adminUrl ? describe : describe.skip
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))
const databases: string[] = []
let adminPool: Pool

async function database() {
  const name = `axiom_access_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  await adminPool.query(`CREATE DATABASE "${name}"`)
  databases.push(name)
  const url = new URL(adminUrl!); url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.toString(), max: 4 })
  await migrate(drizzle({ client: pool }), { migrationsFolder })
  return { pool, client: { pool, db: drizzle({ client: pool, schema }) } }
}

describeWithDatabase('public API authentication and quota', () => {
  beforeAll(() => { adminPool = new Pool({ connectionString: adminUrl, max: 1 }) })
  afterAll(async () => {
    await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1)', [databases])
    for (const name of databases) await adminPool.query(`DROP DATABASE IF EXISTS "${name}"`)
    await adminPool.end()
  })

  it('authenticates active hashed keys and atomically caps a fixed window', async () => {
    const { pool, client } = await database()
    try {
      const issued = issueApiKey()
      await pool.query(`INSERT INTO api_plans (id, name, requests_per_window, window_seconds) VALUES ('developer', 'Developer', 2, 60)`)
      await pool.query(`INSERT INTO api_principals (id, plan_id, display_name) VALUES ('client-a', 'developer', 'Client A')`)
      const repository = createApiAccessRepository(client, () => new Date('2026-08-10T10:00:30.000Z'))
      await expect(repository.createKey({ principalId: 'client-a', expiresAt: '2026-08-10T10:00:29.000Z' })).rejects.toThrow(/future timestamp/)
      await pool.query(`INSERT INTO api_plans (id, name, requests_per_window, window_seconds, enabled) VALUES ('disabled', 'Disabled', 2, 60, false)`)
      await pool.query(`INSERT INTO api_principals (id, plan_id, display_name) VALUES ('client-disabled', 'disabled', 'Disabled Client')`)
      await expect(repository.createKey({ principalId: 'client-disabled' })).rejects.toThrow(/disabled plan/)
      await repository.createKey({ principalId: 'client-a', issuer: () => issued })
      expect(await repository.authorizeAndConsume(null)).toEqual({ status: 'unauthorized' })
      expect(await repository.authorizeAndConsume(issued.key.replace(/.$/, 'A'))).toEqual({ status: 'unauthorized' })

      const concurrent = await Promise.all([repository.authorizeAndConsume(issued.key), repository.authorizeAndConsume(issued.key), repository.authorizeAndConsume(issued.key)])
      expect(concurrent.filter((item) => item.status === 'allowed')).toHaveLength(2)
      expect(concurrent.filter((item) => item.status === 'rate_limited')).toHaveLength(1)
      expect((await pool.query(`SELECT request_count::int AS count FROM api_quota_usage WHERE principal_id = 'client-a'`)).rows[0]?.count).toBe(2)
      expect((await pool.query(`SELECT last_used_at FROM api_keys WHERE key_prefix = $1`, [issued.keyPrefix])).rows[0]?.last_used_at).not.toBeNull()

      expect(await repository.revokeKey(issued.keyPrefix)).toMatchObject({ keyPrefix: issued.keyPrefix })
      expect(await repository.authorizeAndConsume(issued.key)).toEqual({ status: 'unauthorized' })

      await pool.query(`INSERT INTO api_quota_usage (principal_id, window_started_at, request_count) VALUES ('client-a', '2026-08-01T00:00:00Z', 1), ('client-a', '2026-08-02T00:00:00Z', 1)`)
      expect(await repository.pruneQuotaUsage({ before: '2026-08-05T00:00:00Z', limit: 1 })).toBe(1)
      expect((await pool.query(`SELECT count(*)::int AS count FROM api_quota_usage WHERE principal_id = 'client-a'`)).rows[0]?.count).toBe(2)
      expect(await repository.pruneQuotaUsage({ before: '2026-08-05T00:00:00Z', limit: 1 })).toBe(1)
      expect((await pool.query(`SELECT count(*)::int AS count FROM api_quota_usage WHERE principal_id = 'client-a'`)).rows[0]?.count).toBe(1)
    } finally {
      await pool.end()
    }
  })
})
