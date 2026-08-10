import { and, asc, eq, lte, sql } from 'drizzle-orm'
import type { MetricId } from '../contracts/domain'
import { serializeWorkerError } from '../worker/errors'
import type { DatabaseClient } from './client'
import { ingestCycles, networks, scheduledCycleLeases, sourceDefinitions } from './schema'

export interface DiscoveredIngestJob {
  metric: 'latest_ledger'
  subjectKey: string
  methodologyVersion: string
  sources: Array<{
    id: string
    url: string
    sourceClass: typeof sourceDefinitions.$inferSelect.sourceClass
    adapter: typeof sourceDefinitions.$inferSelect.adapter
    upstreamId: string | null
    networkId: string
    networkPassphrase: string
  }>
}

export interface ScheduledCycleInput {
  id: string
  metric: MetricId
  subjectKey: string
  methodologyVersion: string
  idempotencyKey: string
  scheduledAt: string
}

export interface ClaimedCycle extends ScheduledCycleInput {
  leaseOwner: string
  leaseToken: number
  leaseExpiresAt: string
  attemptCount: number
}

function expiresAt(now: string, leaseDurationMs: number) {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error('leaseDurationMs must be a positive safe integer')
  }
  return new Date(Date.parse(now) + leaseDurationMs).toISOString()
}

export function createSchedulerRepository(client: DatabaseClient) {
  const { db } = client

  return {
    async discoverLatestLedgerJobs(methodologyVersion: string): Promise<DiscoveredIngestJob[]> {
      const rows = await db
        .select({
          id: sourceDefinitions.id,
          url: sourceDefinitions.url,
          sourceClass: sourceDefinitions.sourceClass,
          adapter: sourceDefinitions.adapter,
          upstreamId: sourceDefinitions.upstreamId,
          networkId: networks.id,
          networkPassphrase: networks.passphrase,
        })
        .from(sourceDefinitions)
        .innerJoin(networks, eq(networks.id, sourceDefinitions.networkId))
        .where(eq(sourceDefinitions.enabled, true))
        .orderBy(asc(networks.id), asc(sourceDefinitions.id))

      const jobs = new Map<string, DiscoveredIngestJob>()
      for (const source of rows) {
        if (source.adapter !== 'horizon') continue
        let job = jobs.get(source.networkId)
        if (!job) {
          job = {
            metric: 'latest_ledger',
            subjectKey: source.networkId,
            methodologyVersion,
            sources: [],
          }
          jobs.set(source.networkId, job)
        }
        job.sources.push(source)
      }
      return [...jobs.values()]
    },

    async ensureScheduledCycle(input: ScheduledCycleInput) {
      const inserted = await db
        .insert(scheduledCycleLeases)
        .values(input)
        .onConflictDoNothing()
        .returning({ id: scheduledCycleLeases.id })
      return inserted.length === 1
    },

    async claimNextCycle({
      workerId,
      now,
      leaseDurationMs,
    }: {
      workerId: string
      now: string
      leaseDurationMs: number
    }): Promise<ClaimedCycle | null> {
      const leaseExpiresAt = expiresAt(now, leaseDurationMs)
      return db.transaction(async (tx) => {
        const available = await tx
          .select({ id: scheduledCycleLeases.id })
          .from(scheduledCycleLeases)
          .where(and(eq(scheduledCycleLeases.status, 'pending'), lte(scheduledCycleLeases.scheduledAt, now)))
          .orderBy(asc(scheduledCycleLeases.scheduledAt), asc(scheduledCycleLeases.id))
          .limit(1)
          .for('update', { skipLocked: true })
        if (!available[0]) return null

        const claimed = await tx
          .update(scheduledCycleLeases)
          .set({
            status: 'running',
            leaseOwner: workerId,
            leaseToken: sql`${scheduledCycleLeases.leaseToken} + 1`,
            leaseExpiresAt,
            heartbeatAt: now,
            attemptCount: sql`${scheduledCycleLeases.attemptCount} + 1`,
            updatedAt: now,
          })
          .where(eq(scheduledCycleLeases.id, available[0].id))
          .returning()
        const row = claimed[0]
        if (!row || !row.leaseOwner || !row.leaseExpiresAt) return null
        return {
          id: row.id,
          metric: row.metric,
          subjectKey: row.subjectKey,
          methodologyVersion: row.methodologyVersion,
          idempotencyKey: row.idempotencyKey,
          scheduledAt: row.scheduledAt,
          leaseOwner: row.leaseOwner,
          leaseToken: row.leaseToken,
          leaseExpiresAt: row.leaseExpiresAt,
          attemptCount: row.attemptCount,
        }
      })
    },

    async renewLease(lease: ClaimedCycle, now: string, leaseDurationMs: number) {
      const renewed = await db
        .update(scheduledCycleLeases)
        .set({ heartbeatAt: now, leaseExpiresAt: expiresAt(now, leaseDurationMs), updatedAt: now })
        .where(
          and(
            eq(scheduledCycleLeases.id, lease.id),
            eq(scheduledCycleLeases.status, 'running'),
            eq(scheduledCycleLeases.leaseOwner, lease.leaseOwner),
            eq(scheduledCycleLeases.leaseToken, lease.leaseToken),
          ),
        )
        .returning({ id: scheduledCycleLeases.id })
      return renewed.length === 1
    },

    async acknowledgeFinalized(lease: ClaimedCycle, now: string) {
      const finalized = await db
        .select({ id: ingestCycles.id })
        .from(ingestCycles)
        .where(eq(ingestCycles.idempotencyKey, lease.idempotencyKey))
        .limit(1)
      if (!finalized[0]) throw new Error(`cycle ${lease.id} has no durable finalization`)
      const acknowledged = await db
        .update(scheduledCycleLeases)
        .set({
          status: 'completed',
          finalizedCycleId: finalized[0].id,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(scheduledCycleLeases.id, lease.id),
            eq(scheduledCycleLeases.status, 'running'),
            eq(scheduledCycleLeases.leaseOwner, lease.leaseOwner),
            eq(scheduledCycleLeases.leaseToken, lease.leaseToken),
          ),
        )
        .returning({ id: scheduledCycleLeases.id })
      return acknowledged.length === 1
    },

    async releaseLease(lease: ClaimedCycle, now: string) {
      const released = await db
        .update(scheduledCycleLeases)
        .set({
          status: 'pending',
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(scheduledCycleLeases.id, lease.id),
            eq(scheduledCycleLeases.status, 'running'),
            eq(scheduledCycleLeases.leaseOwner, lease.leaseOwner),
            eq(scheduledCycleLeases.leaseToken, lease.leaseToken),
          ),
        )
        .returning({ id: scheduledCycleLeases.id })
      return released.length === 1
    },

    async failLease(lease: ClaimedCycle, now: string, error: unknown) {
      const failed = await db
        .update(scheduledCycleLeases)
        .set({
          status: 'failed',
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          lastError: serializeWorkerError(error),
          updatedAt: now,
        })
        .where(
          and(
            eq(scheduledCycleLeases.id, lease.id),
            eq(scheduledCycleLeases.status, 'running'),
            eq(scheduledCycleLeases.leaseOwner, lease.leaseOwner),
            eq(scheduledCycleLeases.leaseToken, lease.leaseToken),
          ),
        )
        .returning({ id: scheduledCycleLeases.id })
      return failed.length === 1
    },

    async reapExpiredLeases(now: string, maxAttempts: number) {
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be positive')
      return db.transaction(async (tx) => {
        const expired = await tx
          .select()
          .from(scheduledCycleLeases)
          .where(and(eq(scheduledCycleLeases.status, 'running'), lte(scheduledCycleLeases.leaseExpiresAt, now)))
          .orderBy(asc(scheduledCycleLeases.leaseExpiresAt), asc(scheduledCycleLeases.id))
          .limit(100)
          .for('update', { skipLocked: true })
        let retried = 0
        let abandoned = 0
        let finalized = 0
        for (const lease of expired) {
          const cycle = await tx
            .select({ id: ingestCycles.id })
            .from(ingestCycles)
            .where(eq(ingestCycles.idempotencyKey, lease.idempotencyKey))
            .limit(1)
          if (cycle[0]) {
            await tx
              .update(scheduledCycleLeases)
              .set({
                status: 'completed',
                finalizedCycleId: cycle[0].id,
                leaseOwner: null,
                leaseExpiresAt: null,
                heartbeatAt: null,
                updatedAt: now,
              })
              .where(eq(scheduledCycleLeases.id, lease.id))
            finalized += 1
          } else {
            const status = lease.attemptCount >= maxAttempts ? 'abandoned' : 'pending'
            await tx
              .update(scheduledCycleLeases)
              .set({
                status,
                leaseOwner: null,
                leaseExpiresAt: null,
                heartbeatAt: null,
                lastError: { name: 'LeaseExpired', message: 'Worker lease expired before durable finalization' },
                updatedAt: now,
              })
              .where(eq(scheduledCycleLeases.id, lease.id))
            if (status === 'pending') retried += 1
            else abandoned += 1
          }
        }
        return { retried, abandoned, finalized }
      })
    },
  }
}

export type SchedulerRepository = ReturnType<typeof createSchedulerRepository>
