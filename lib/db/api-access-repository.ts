import { randomUUID } from 'node:crypto'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { apiKeyHashMatches, issueApiKey, parseApiKey, type IssuedApiKey } from '../api-access/key'
import { parsePublicApiAccessPolicy, type PublicApiAccessPolicy } from '../api-access/policy'
import type { DatabaseClient } from './client'
import {
  apiKeyEvents,
  apiKeys,
  apiPlanRouteLimits,
  apiPlans,
  apiPrincipalScopes,
  apiPrincipals,
  apiQuotaUsage,
} from './schema'

export interface ApiAccessGrant {
  principalId: string
  planId: string
  routeId: string
  scopes: string[]
  limit: number
  remaining: number
  resetAt: string
}

export type ApiAccessDecision =
  | { status: 'allowed'; grant: ApiAccessGrant }
  | { status: 'unauthorized' }
  | { status: 'forbidden' }
  | {
      status: 'rate_limited'
      quotaKind: 'sustained' | 'burst'
      limit: number
      remaining: 0
      resetAt: string
      retryAfterSeconds: number
    }

interface QuotaBoundary {
  limit: number
  resetAt: string
  retryAfterSeconds: number
}

class QuotaExceeded extends Error {
  constructor(
    readonly quotaKind: 'sustained' | 'burst',
    readonly boundary: QuotaBoundary,
  ) {
    super(`${quotaKind} API quota exceeded`)
  }
}

function windowStart(now: Date, windowSeconds: number) {
  const windowMs = windowSeconds * 1_000
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs)
}

function quotaBoundary(now: Date, windowSeconds: number, limit: number) {
  const startedAt = windowStart(now, windowSeconds)
  const reset = new Date(startedAt.getTime() + windowSeconds * 1_000)
  return {
    startedAt,
    limit,
    resetAt: reset.toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 1_000)),
  }
}

function validateActor(actor: string | undefined) {
  const value = actor?.trim() || 'operator-cli'
  if (value.length > 128) throw new Error('API key audit actor must not exceed 128 characters')
  return value
}

function validateExpiration(expiresAt: string | null, now: Date) {
  if (expiresAt !== null && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime())) {
    throw new Error('API key expiration must be a future timestamp')
  }
}

function validateKeyPrefix(keyPrefix: string) {
  if (!/^[A-Za-z0-9_-]{12}$/.test(keyPrefix)) throw new Error('API key prefix must contain 12 URL-safe characters')
}

export function createApiAccessRepository(client: DatabaseClient, clock: () => Date = () => new Date()) {
  return {
    async createKey(input: {
      principalId: string
      expiresAt?: string | null
      actor?: string
      issuer?: () => IssuedApiKey
    }) {
      const now = clock()
      const expiresAt = input.expiresAt ?? null
      const actor = validateActor(input.actor)
      validateExpiration(expiresAt, now)
      return client.db.transaction(async (tx) => {
        const principal = (await tx.select({ id: apiPrincipals.id, status: apiPrincipals.status, planEnabled: apiPlans.enabled })
          .from(apiPrincipals).innerJoin(apiPlans, eq(apiPlans.id, apiPrincipals.planId))
          .where(eq(apiPrincipals.id, input.principalId)).limit(1))[0]
        if (!principal || principal.status !== 'active' || !principal.planEnabled) {
          throw new Error('principal is missing, inactive, or assigned to a disabled plan')
        }
        const issued = (input.issuer ?? issueApiKey)()
        const keyId = `api_key_${issued.keyPrefix}`
        await tx.insert(apiKeys).values({
          id: keyId,
          principalId: principal.id,
          keyPrefix: issued.keyPrefix,
          keyHash: issued.keyHash,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        })
        await tx.insert(apiKeyEvents).values({
          id: `api_key_event_${randomUUID()}`,
          keyId,
          principalId: principal.id,
          eventType: 'created',
          actor,
          occurredAt: now.toISOString(),
        })
        return issued
      })
    },

    async rotateKey(input: {
      keyPrefix: string
      expiresAt?: string | null
      actor?: string
      issuer?: () => IssuedApiKey
    }) {
      validateKeyPrefix(input.keyPrefix)
      const now = clock()
      const actor = validateActor(input.actor)
      if (input.expiresAt !== undefined) validateExpiration(input.expiresAt, now)
      return client.db.transaction(async (tx) => {
        const current = (await tx.select({
          keyId: apiKeys.id,
          expiresAt: apiKeys.expiresAt,
          principalId: apiPrincipals.id,
          principalStatus: apiPrincipals.status,
          planEnabled: apiPlans.enabled,
        }).from(apiKeys)
          .innerJoin(apiPrincipals, eq(apiPrincipals.id, apiKeys.principalId))
          .innerJoin(apiPlans, eq(apiPlans.id, apiPrincipals.planId))
          .where(and(eq(apiKeys.keyPrefix, input.keyPrefix), isNull(apiKeys.revokedAt)))
          .limit(1))[0]
        if (!current || current.principalStatus !== 'active' || !current.planEnabled) {
          throw new Error('active API key was not found for an enabled principal')
        }
        const issued = (input.issuer ?? issueApiKey)()
        const replacementKeyId = `api_key_${issued.keyPrefix}`
        const replacementExpiresAtValue = input.expiresAt === undefined ? current.expiresAt : input.expiresAt
        const replacementExpiresAt = replacementExpiresAtValue ? new Date(replacementExpiresAtValue).toISOString() : null
        await tx.insert(apiKeys).values({
          id: replacementKeyId,
          principalId: current.principalId,
          keyPrefix: issued.keyPrefix,
          keyHash: issued.keyHash,
          expiresAt: replacementExpiresAt,
        })
        const revoked = await tx.update(apiKeys).set({ revokedAt: now.toISOString() })
          .where(and(eq(apiKeys.id, current.keyId), isNull(apiKeys.revokedAt)))
          .returning({ id: apiKeys.id })
        if (revoked.length !== 1) throw new Error('API key was rotated concurrently')
        await tx.insert(apiKeyEvents).values([
          {
            id: `api_key_event_${randomUUID()}`,
            keyId: replacementKeyId,
            principalId: current.principalId,
            eventType: 'created' as const,
            actor,
            occurredAt: now.toISOString(),
          },
          {
            id: `api_key_event_${randomUUID()}`,
            keyId: current.keyId,
            principalId: current.principalId,
            eventType: 'rotated' as const,
            actor,
            relatedKeyId: replacementKeyId,
            occurredAt: now.toISOString(),
          },
        ])
        return {
          ...issued,
          replacedKeyPrefix: input.keyPrefix,
          expiresAt: replacementExpiresAt,
          rotatedAt: now.toISOString(),
        }
      })
    },

    async revokeKey(keyPrefix: string, actorInput?: string) {
      validateKeyPrefix(keyPrefix)
      const actor = validateActor(actorInput)
      const revokedAt = clock().toISOString()
      return client.db.transaction(async (tx) => {
        const revoked = await tx.update(apiKeys).set({ revokedAt })
          .where(and(eq(apiKeys.keyPrefix, keyPrefix), isNull(apiKeys.revokedAt)))
          .returning({ id: apiKeys.id, principalId: apiKeys.principalId })
        if (revoked.length !== 1) throw new Error('active API key was not found')
        await tx.insert(apiKeyEvents).values({
          id: `api_key_event_${randomUUID()}`,
          keyId: revoked[0]!.id,
          principalId: revoked[0]!.principalId,
          eventType: 'revoked',
          actor,
          occurredAt: revokedAt,
        })
        return { keyPrefix, revokedAt }
      })
    },

    async pruneQuotaUsage(input: { before: string; limit?: number }) {
      const before = new Date(input.before)
      const limit = input.limit ?? 1_000
      if (!Number.isFinite(before.getTime())) throw new Error('quota retention boundary must be a valid timestamp')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('quota prune limit must be from 1 through 10000')
      const result = await client.pool.query(
        `DELETE FROM api_quota_usage WHERE ctid IN (
           SELECT ctid FROM api_quota_usage
           WHERE window_started_at < $1 ORDER BY window_started_at, principal_id, route_id, quota_kind LIMIT $2
         )`,
        [before.toISOString(), limit],
      )
      return result.rowCount ?? 0
    },

    async authorizeAndConsume(rawKey: string | null, rawPolicy: PublicApiAccessPolicy): Promise<ApiAccessDecision> {
      const parsed = parseApiKey(rawKey)
      if (!parsed) return { status: 'unauthorized' }
      const policy = parsePublicApiAccessPolicy(rawPolicy)
      const now = clock()
      const nowTimestamp = now.toISOString()

      try {
        return await client.db.transaction(async (tx) => {
          const record = (await tx.select({
            keyId: apiKeys.id,
            keyHash: apiKeys.keyHash,
            principalId: apiPrincipals.id,
            principalStatus: apiPrincipals.status,
            planId: apiPlans.id,
            planEnabled: apiPlans.enabled,
            defaultRequestsPerWindow: apiPlans.requestsPerWindow,
            defaultWindowSeconds: apiPlans.windowSeconds,
            routeEnabled: apiPlanRouteLimits.enabled,
            routeRequestsPerWindow: apiPlanRouteLimits.requestsPerWindow,
            routeWindowSeconds: apiPlanRouteLimits.windowSeconds,
            routeBurstRequests: apiPlanRouteLimits.burstRequests,
            routeBurstWindowSeconds: apiPlanRouteLimits.burstWindowSeconds,
          }).from(apiKeys)
            .innerJoin(apiPrincipals, eq(apiPrincipals.id, apiKeys.principalId))
            .innerJoin(apiPlans, eq(apiPlans.id, apiPrincipals.planId))
            .leftJoin(apiPlanRouteLimits, and(
              eq(apiPlanRouteLimits.planId, apiPlans.id),
              eq(apiPlanRouteLimits.routeId, policy.routeId),
            ))
            .where(and(
              eq(apiKeys.keyPrefix, parsed.keyPrefix),
              isNull(apiKeys.revokedAt),
              or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, nowTimestamp)),
            )).limit(1))[0]

          if (!record || record.principalStatus !== 'active' || !record.planEnabled || !apiKeyHashMatches(parsed.key, record.keyHash)) {
            return { status: 'unauthorized' as const }
          }
          if (record.routeEnabled === false) return { status: 'forbidden' as const }

          const scopeRows = await tx.select({ scopeId: apiPrincipalScopes.scopeId }).from(apiPrincipalScopes)
            .where(eq(apiPrincipalScopes.principalId, record.principalId))
          const scopes = scopeRows.map((item) => item.scopeId)
          if (!scopes.includes(policy.requiredScope)) return { status: 'forbidden' as const }

          const sustainedLimit = record.routeRequestsPerWindow ?? record.defaultRequestsPerWindow
          const sustainedWindowSeconds = record.routeWindowSeconds ?? record.defaultWindowSeconds
          const burstLimit = record.routeBurstRequests ?? Math.min(sustainedLimit, 10)
          const burstWindowSeconds = record.routeBurstWindowSeconds ?? 1

          const consume = async (quotaKind: 'sustained' | 'burst', limit: number, windowSeconds: number) => {
            const boundary = quotaBoundary(now, windowSeconds, limit)
            const consumed = (await tx.insert(apiQuotaUsage).values({
              principalId: record.principalId,
              routeId: policy.routeId,
              quotaKind,
              windowStartedAt: boundary.startedAt.toISOString(),
              requestCount: 1n,
              updatedAt: nowTimestamp,
            }).onConflictDoUpdate({
              target: [apiQuotaUsage.principalId, apiQuotaUsage.routeId, apiQuotaUsage.quotaKind, apiQuotaUsage.windowStartedAt],
              set: { requestCount: sql`${apiQuotaUsage.requestCount} + 1`, updatedAt: nowTimestamp },
              setWhere: sql`${apiQuotaUsage.requestCount} < ${limit}`,
            }).returning({ requestCount: apiQuotaUsage.requestCount }))[0]
            if (!consumed) throw new QuotaExceeded(quotaKind, boundary)
            return { ...boundary, requestCount: Number(consumed.requestCount) }
          }

          const sustained = await consume('sustained', sustainedLimit, sustainedWindowSeconds)
          await consume('burst', burstLimit, burstWindowSeconds)
          await tx.update(apiKeys).set({ lastUsedAt: nowTimestamp }).where(eq(apiKeys.id, record.keyId))
          return {
            status: 'allowed' as const,
            grant: {
              principalId: record.principalId,
              planId: record.planId,
              routeId: policy.routeId,
              scopes,
              limit: sustained.limit,
              remaining: sustained.limit - sustained.requestCount,
              resetAt: sustained.resetAt,
            },
          }
        })
      } catch (error) {
        if (!(error instanceof QuotaExceeded)) throw error
        return {
          status: 'rate_limited',
          quotaKind: error.quotaKind,
          limit: error.boundary.limit,
          remaining: 0,
          resetAt: error.boundary.resetAt,
          retryAfterSeconds: error.boundary.retryAfterSeconds,
        }
      }
    },
  }
}

let webProcessClient: DatabaseClient | undefined

export async function authorizePublicApiKey(rawKey: string | null, policy: PublicApiAccessPolicy) {
  const { createDatabaseClient } = await import('./client')
  webProcessClient ??= createDatabaseClient()
  return createApiAccessRepository(webProcessClient).authorizeAndConsume(rawKey, policy)
}
