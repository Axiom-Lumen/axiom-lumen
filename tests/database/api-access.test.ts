import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { issueApiKey } from '../../lib/api-access/key'
import { createApiAccessRepository } from '../../lib/db/api-access-repository'
import * as schema from '../../lib/db/schema'

const latestPolicy = { routeId: 'stellar.latest-ledger', requiredScope: 'metrics:read' }
const depthPolicy = { routeId: 'stellar.depth', requiredScope: 'metrics:read' }
const anchorPolicy = { routeId: 'anchors.reserves', requiredScope: 'anchors:read' }

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
      const replacement = issueApiKey()
      await pool.query(`INSERT INTO api_plans (id, name, requests_per_window, window_seconds) VALUES ('developer', 'Developer', 2, 60)`)
      await pool.query(`INSERT INTO api_principals (id, plan_id, display_name) VALUES ('client-a', 'developer', 'Client A')`)
      await pool.query(`INSERT INTO api_scopes (id, description) VALUES ('metrics:read', 'Read public metrics'), ('anchors:read', 'Read anchor disclosures')`)
      await pool.query(`INSERT INTO api_principal_scopes (principal_id, scope_id) VALUES ('client-a', 'metrics:read')`)
      await pool.query(`INSERT INTO api_plan_route_limits (plan_id, route_id, requests_per_window, window_seconds, burst_requests, burst_window_seconds) VALUES ('developer', 'stellar.depth', 5, 60, 1, 1)`)
      const repository = createApiAccessRepository(client, () => new Date('2026-08-10T10:00:30.000Z'))
      await expect(repository.createKey({ principalId: 'client-a', expiresAt: '2026-08-10T10:00:29.000Z' })).rejects.toThrow(/future timestamp/)
      await pool.query(`INSERT INTO api_plans (id, name, requests_per_window, window_seconds, enabled) VALUES ('disabled', 'Disabled', 2, 60, false)`)
      await pool.query(`INSERT INTO api_principals (id, plan_id, display_name) VALUES ('client-disabled', 'disabled', 'Disabled Client')`)
      await expect(repository.createKey({ principalId: 'client-disabled' })).rejects.toThrow(/disabled plan/)
      await repository.createKey({ principalId: 'client-a', expiresAt: '2026-09-01T00:00:00.000Z', issuer: () => issued })
      expect(await repository.authorizeAndConsume(null, latestPolicy)).toEqual({ status: 'unauthorized' })
      expect(await repository.authorizeAndConsume(issued.key.replace(/.$/, 'A'), latestPolicy)).toEqual({ status: 'unauthorized' })
      expect(await repository.authorizeAndConsume(issued.key, anchorPolicy)).toEqual({ status: 'forbidden' })
      await pool.query(`INSERT INTO api_principal_scopes (principal_id, scope_id) VALUES ('client-a', 'anchors:read')`)
      await pool.query(`INSERT INTO api_plan_route_limits (plan_id, route_id, requests_per_window, window_seconds, burst_requests, burst_window_seconds, enabled) VALUES ('developer', 'anchors.reserves', 2, 60, 1, 1, false)`)
      expect(await repository.authorizeAndConsume(issued.key, anchorPolicy)).toEqual({ status: 'forbidden' })

      const concurrent = await Promise.all([
        repository.authorizeAndConsume(issued.key, latestPolicy),
        repository.authorizeAndConsume(issued.key, latestPolicy),
        repository.authorizeAndConsume(issued.key, latestPolicy),
      ])
      expect(concurrent.filter((item) => item.status === 'allowed')).toHaveLength(2)
      expect(concurrent.filter((item) => item.status === 'rate_limited')).toHaveLength(1)
      expect((await pool.query(`SELECT request_count::int AS count FROM api_quota_usage WHERE principal_id = 'client-a' AND route_id = 'stellar.latest-ledger' AND quota_kind = 'sustained'`)).rows[0]?.count).toBe(2)
      expect((await pool.query(`SELECT last_used_at FROM api_keys WHERE key_prefix = $1`, [issued.keyPrefix])).rows[0]?.last_used_at).not.toBeNull()

      const rotated = await repository.rotateKey({ keyPrefix: issued.keyPrefix, issuer: () => replacement, actor: 'security-admin' })
      expect(rotated).toMatchObject({ keyPrefix: replacement.keyPrefix, replacedKeyPrefix: issued.keyPrefix, expiresAt: '2026-09-01T00:00:00.000Z' })
      expect(await repository.authorizeAndConsume(issued.key, depthPolicy)).toEqual({ status: 'unauthorized' })
      expect((await repository.authorizeAndConsume(replacement.key, depthPolicy)).status).toBe('allowed')
      expect(await repository.authorizeAndConsume(replacement.key, depthPolicy)).toMatchObject({ status: 'rate_limited', quotaKind: 'burst', limit: 1 })
      expect((await pool.query(`SELECT request_count::int AS count FROM api_quota_usage WHERE principal_id = 'client-a' AND route_id = 'stellar.depth' AND quota_kind = 'sustained'`)).rows[0]?.count).toBe(1)

      expect(await repository.revokeKey(replacement.keyPrefix, 'security-admin')).toMatchObject({ keyPrefix: replacement.keyPrefix })
      expect(await repository.authorizeAndConsume(replacement.key, latestPolicy)).toEqual({ status: 'unauthorized' })
      const events = await pool.query(`SELECT event_type, actor FROM api_key_events ORDER BY occurred_at, event_type`)
      expect(events.rows).toEqual(expect.arrayContaining([
        { event_type: 'created', actor: 'operator-cli' },
        { event_type: 'created', actor: 'security-admin' },
        { event_type: 'rotated', actor: 'security-admin' },
        { event_type: 'revoked', actor: 'security-admin' },
      ]))
      expect(events.rows).toHaveLength(4)
      await expect(pool.query(`UPDATE api_key_events SET actor = 'tampered'`)).rejects.toMatchObject({ code: '55000' })

      await pool.query(`INSERT INTO api_quota_usage (principal_id, route_id, quota_kind, window_started_at, request_count) VALUES ('client-a', 'legacy', 'sustained', '2026-08-01T00:00:00Z', 1), ('client-a', 'legacy', 'sustained', '2026-08-02T00:00:00Z', 1)`)
      expect(await repository.pruneQuotaUsage({ before: '2026-08-05T00:00:00Z', limit: 1 })).toBe(1)
      expect((await pool.query(`SELECT count(*)::int AS count FROM api_quota_usage WHERE principal_id = 'client-a' AND route_id = 'legacy'`)).rows[0]?.count).toBe(1)
      expect(await repository.pruneQuotaUsage({ before: '2026-08-05T00:00:00Z', limit: 1 })).toBe(1)
      expect((await pool.query(`SELECT count(*)::int AS count FROM api_quota_usage WHERE principal_id = 'client-a' AND route_id = 'legacy'`)).rows[0]?.count).toBe(0)
    } finally {
      await pool.end()
    }
  })
})
