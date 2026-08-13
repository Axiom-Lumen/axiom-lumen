import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { apiKeyHashMatches, issueApiKey, parseApiKey, type IssuedApiKey } from '../api-access/key'
import type { DatabaseClient } from './client'
import { apiKeys, apiPlans, apiPrincipals, apiQuotaUsage } from './schema'

export interface ApiAccessGrant {
  principalId: string
  planId: string
  limit: number
  remaining: number
  resetAt: string
}

export type ApiAccessDecision =
  | { status: 'allowed'; grant: ApiAccessGrant }
  | { status: 'unauthorized' }
  | { status: 'rate_limited'; limit: number; remaining: 0; resetAt: string; retryAfterSeconds: number }

function windowStart(now: Date, windowSeconds: number) {
  const windowMs = windowSeconds * 1_000
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs)
}

export function createApiAccessRepository(client: DatabaseClient, clock: () => Date = () => new Date()) {
  return {
    async createKey(input: { principalId: string; expiresAt?: string | null; issuer?: () => IssuedApiKey }) {
      const now = clock()
      const expiresAt = input.expiresAt ?? null
      if (expiresAt !== null && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime())) {
        throw new Error('API key expiration must be a future timestamp')
      }
      return client.db.transaction(async (tx) => {
        const principal = (await tx.select({ id: apiPrincipals.id, status: apiPrincipals.status, planEnabled: apiPlans.enabled })
          .from(apiPrincipals).innerJoin(apiPlans, eq(apiPlans.id, apiPrincipals.planId))
          .where(eq(apiPrincipals.id, input.principalId)).limit(1))[0]
        if (!principal || principal.status !== 'active' || !principal.planEnabled) {
          throw new Error('principal is missing, inactive, or assigned to a disabled plan')
        }
        const issued = (input.issuer ?? issueApiKey)()
        await tx.insert(apiKeys).values({
          id: `api_key_${issued.keyPrefix}`,
          principalId: principal.id,
          keyPrefix: issued.keyPrefix,
          keyHash: issued.keyHash,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        })
        return issued
      })
    },

    async revokeKey(keyPrefix: string) {
      if (!/^[A-Za-z0-9_-]{12}$/.test(keyPrefix)) throw new Error('API key prefix must contain 12 URL-safe characters')
      const revokedAt = clock().toISOString()
      const revoked = await client.db.update(apiKeys).set({ revokedAt })
        .where(and(eq(apiKeys.keyPrefix, keyPrefix), isNull(apiKeys.revokedAt))).returning({ id: apiKeys.id })
      if (revoked.length !== 1) throw new Error('active API key was not found')
      return { keyPrefix, revokedAt }
    },

    async pruneQuotaUsage(input: { before: string; limit?: number }) {
      const before = new Date(input.before)
      const limit = input.limit ?? 1_000
      if (!Number.isFinite(before.getTime())) throw new Error('quota retention boundary must be a valid timestamp')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('quota prune limit must be from 1 through 10000')
      const result = await client.pool.query(
        `DELETE FROM api_quota_usage
         WHERE (principal_id, window_started_at) IN (
           SELECT principal_id, window_started_at FROM api_quota_usage
           WHERE window_started_at < $1 ORDER BY window_started_at, principal_id LIMIT $2
         )`,
        [before.toISOString(), limit],
      )
      return result.rowCount ?? 0
    },

    async authorizeAndConsume(rawKey: string | null): Promise<ApiAccessDecision> {
      const parsed = parseApiKey(rawKey)
      if (!parsed) return { status: 'unauthorized' }
      const now = clock()
      const nowTimestamp = now.toISOString()

      return client.db.transaction(async (tx) => {
        const record = (await tx.select({
          keyId: apiKeys.id,
          keyHash: apiKeys.keyHash,
          principalId: apiPrincipals.id,
          principalStatus: apiPrincipals.status,
          planId: apiPlans.id,
          planEnabled: apiPlans.enabled,
          requestsPerWindow: apiPlans.requestsPerWindow,
          windowSeconds: apiPlans.windowSeconds,
        }).from(apiKeys)
          .innerJoin(apiPrincipals, eq(apiPrincipals.id, apiKeys.principalId))
          .innerJoin(apiPlans, eq(apiPlans.id, apiPrincipals.planId))
          .where(and(
            eq(apiKeys.keyPrefix, parsed.keyPrefix),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, nowTimestamp)),
          )).limit(1))[0]

        if (!record || record.principalStatus !== 'active' || !record.planEnabled || !apiKeyHashMatches(parsed.key, record.keyHash)) {
          return { status: 'unauthorized' as const }
        }

        const startedAt = windowStart(now, record.windowSeconds)
        const reset = new Date(startedAt.getTime() + record.windowSeconds * 1_000)
        const consumed = (await tx.insert(apiQuotaUsage).values({
          principalId: record.principalId,
          windowStartedAt: startedAt.toISOString(),
          requestCount: 1n,
          updatedAt: nowTimestamp,
        }).onConflictDoUpdate({
          target: [apiQuotaUsage.principalId, apiQuotaUsage.windowStartedAt],
          set: { requestCount: sql`${apiQuotaUsage.requestCount} + 1`, updatedAt: nowTimestamp },
          setWhere: sql`${apiQuotaUsage.requestCount} < ${record.requestsPerWindow}`,
        }).returning({ requestCount: apiQuotaUsage.requestCount }))[0]

        if (!consumed) {
          return {
            status: 'rate_limited' as const,
            limit: record.requestsPerWindow,
            remaining: 0 as const,
            resetAt: reset.toISOString(),
            retryAfterSeconds: Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 1_000)),
          }
        }
        await tx.update(apiKeys).set({ lastUsedAt: nowTimestamp }).where(eq(apiKeys.id, record.keyId))
        return {
          status: 'allowed' as const,
          grant: {
            principalId: record.principalId,
            planId: record.planId,
            limit: record.requestsPerWindow,
            remaining: record.requestsPerWindow - Number(consumed.requestCount),
            resetAt: reset.toISOString(),
          },
        }
      })
    },
  }
}

let webProcessClient: DatabaseClient | undefined

export async function authorizePublicApiKey(rawKey: string | null) {
  const { createDatabaseClient } = await import('./client')
  webProcessClient ??= createDatabaseClient()
  return createApiAccessRepository(webProcessClient).authorizeAndConsume(rawKey)
}
