import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION, MZAR_RESERVE_CONNECTOR_PROFILE } from '../../config/methodology'
import {
  creditAssetSchema,
  formatAssetId,
  formatNetworkAssetKey,
  formatNetworkPairKey,
  networkIdSchema,
  parseTradingPairId,
  tradingPairSchema,
  type MetricId,
} from '../contracts/domain'
import { serializeWorkerError } from '../worker/errors'
import type { DatabaseClient } from './client'
import { anchorDomains, anchors, assets, ingestCycles, networks, scheduledCycleLeases, sourceDefinitions } from './schema'

const supplySourceConfigSchema = z.object({
  enabled: z.literal(true),
  assetIds: z.array(z.string().min(1)).min(1),
  trustedCheckpoints: z.record(z.unknown()).optional(),
}).strict()

const depthSourceConfigSchema = z.object({
  enabled: z.literal(true),
  pairs: z.array(z.string().min(1)).min(1),
}).strict()
const trustlineSourceConfigSchema = z.object({ enabled: z.literal(true), assetIds: z.array(z.string().min(1)).min(1) }).strict()
const anchorReserveSourceConfigSchema = z.object({
  enabled: z.literal(true),
  assetIds: z.array(z.string().min(1)).min(1),
  verifications: z.record(z.object({
    domainId: z.string().min(1),
    verifiedAt: z.string().datetime({ offset: true }),
    verificationExpiresAt: z.string().datetime({ offset: true }),
  }).strict()),
  profiles: z.record(z.enum(['axiom_json_v1', MZAR_RESERVE_CONNECTOR_PROFILE])).optional(),
}).strict()

const discoveredSourceSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  sourceClass: z.enum(['canonical_ledger', 'archive', 'dex', 'anchor_self_reported', 'third_party_oracle']),
  adapter: z.enum(['horizon', 'archive', 'sdex', 'anchor', 'oracle']),
  upstreamId: z.string().min(1).nullable(),
  networkId: networkIdSchema,
  networkPassphrase: z.string().min(1),
  trustedCheckpoint: z.unknown().optional(),
  configurationError: z.string().min(1).max(500).optional(),
}).strict()
type DiscoveredSource = z.infer<typeof discoveredSourceSchema>

export const discoveredIngestJobSchema = z.discriminatedUnion('metric', [
  z.object({
    metric: z.literal('latest_ledger'),
    subjectKey: z.string().min(1),
    methodologyVersion: z.string().min(1),
    sources: z.array(discoveredSourceSchema).min(1),
  }).strict(),
  z.object({
    metric: z.literal('circulating_supply'),
    subjectKey: z.string().min(1),
    methodologyVersion: z.string().min(1),
    asset: creditAssetSchema,
    sources: z.array(discoveredSourceSchema).min(1),
  }).strict(),
  z.object({
    metric: z.literal('order_book_depth'),
    subjectKey: z.string().min(1),
    methodologyVersion: z.string().min(1),
    pair: tradingPairSchema,
    sources: z.array(discoveredSourceSchema).min(1),
  }).strict(),
  z.object({
    metric: z.literal('trustline_count'),
    subjectKey: z.string().min(1),
    methodologyVersion: z.string().min(1),
    asset: creditAssetSchema,
    sources: z.array(discoveredSourceSchema).min(1),
  }).strict(),
  z.object({
    metric: z.literal('anchor_reserves'),
    subjectKey: z.string().min(1),
    methodologyVersion: z.string().min(1),
    anchorId: z.string().min(1),
    connectorProfile: z.enum(['axiom_json_v1', MZAR_RESERVE_CONNECTOR_PROFILE]),
    asset: creditAssetSchema,
    sources: z.array(discoveredSourceSchema).length(1),
  }).strict(),
])

export type DiscoveredIngestJob = z.infer<typeof discoveredIngestJobSchema>

export interface ScheduledCycleInput {
  id: string
  metric: MetricId
  subjectKey: string
  methodologyVersion: string
  idempotencyKey: string
  scheduledAt: string
  jobDefinition?: unknown
  jobDefinitionSha256?: string
}

export interface ClaimedCycle extends ScheduledCycleInput {
  leaseOwner: string
  leaseToken: number
  leaseExpiresAt: string
  attemptCount: number
}

export function parseDiscoveredIngestJob(input: unknown): DiscoveredIngestJob {
  return discoveredIngestJobSchema.parse(input)
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

      const jobs = new Map<string, Extract<DiscoveredIngestJob, { metric: 'latest_ledger' }>>()
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
        job.sources.push(discoveredSourceSchema.parse(source))
      }
      return [...jobs.values()]
    },

    async discoverSupplyJobs(methodologyVersion: string): Promise<DiscoveredIngestJob[]> {
      const [sourceRows, assetRows] = await Promise.all([
        db
          .select({
            id: sourceDefinitions.id,
            url: sourceDefinitions.url,
            sourceClass: sourceDefinitions.sourceClass,
            adapter: sourceDefinitions.adapter,
            upstreamId: sourceDefinitions.upstreamId,
            networkId: networks.id,
            networkPassphrase: networks.passphrase,
            config: sourceDefinitions.config,
          })
          .from(sourceDefinitions)
          .innerJoin(networks, eq(networks.id, sourceDefinitions.networkId))
          .where(eq(sourceDefinitions.enabled, true))
          .orderBy(asc(networks.id), asc(sourceDefinitions.id)),
        db
          .select({
            id: assets.id,
            networkId: assets.networkId,
            code: assets.code,
            issuer: assets.issuer,
            canonicalId: assets.canonicalId,
          })
          .from(assets)
          .where(eq(assets.type, 'credit'))
          .orderBy(asc(assets.networkId), asc(assets.canonicalId)),
      ])

      const jobs: DiscoveredIngestJob[] = []
      for (const asset of assetRows) {
        const networkId = networkIdSchema.parse(asset.networkId)
        const parsedAsset = creditAssetSchema.safeParse({ kind: 'credit', code: asset.code, issuer: asset.issuer })
        if (!parsedAsset.success || formatAssetId(parsedAsset.data) !== asset.canonicalId) {
          throw new Error(`configured supply asset ${asset.id} has an invalid canonical identity`)
        }
        const eligibleSources = sourceRows.flatMap((source): DiscoveredSource[] => {
          if (!['horizon', 'archive'].includes(source.adapter) || source.networkId !== asset.networkId) return []
          const rawSupplyConfig = source.config.supply
          if (!rawSupplyConfig || typeof rawSupplyConfig !== 'object' || Array.isArray(rawSupplyConfig)) return []
          const rawConfig = rawSupplyConfig as Record<string, unknown>
          if (rawConfig.enabled !== true) return []
          const routingIds = Array.isArray(rawConfig.assetIds) && rawConfig.assetIds.every((id) => typeof id === 'string')
            ? rawConfig.assetIds as string[]
            : null
          if (routingIds && !routingIds.includes(asset.id)) return []
          const supplyConfig = supplySourceConfigSchema.safeParse(rawSupplyConfig)
          if (!supplyConfig.success) return [{
            id: source.id,
            url: source.url,
            sourceClass: source.sourceClass,
            adapter: source.adapter,
            upstreamId: source.upstreamId,
            networkId: networkIdSchema.parse(source.networkId),
            networkPassphrase: source.networkPassphrase,
            configurationError: 'Supply source configuration is malformed',
          }]
          const trustedCheckpoint = supplyConfig.data.trustedCheckpoints?.[asset.id]
          return [{
            id: source.id,
            url: source.url,
            sourceClass: source.sourceClass,
            adapter: source.adapter,
            upstreamId: source.upstreamId,
            networkId: networkIdSchema.parse(source.networkId),
            networkPassphrase: source.networkPassphrase,
            ...(trustedCheckpoint === undefined ? {} : { trustedCheckpoint }),
          }]
        })
        if (eligibleSources.length === 0) continue
        jobs.push({
          metric: 'circulating_supply',
          subjectKey: formatNetworkAssetKey(networkId, parsedAsset.data),
          methodologyVersion,
          asset: parsedAsset.data,
          sources: eligibleSources,
        })
      }
      return jobs
    },

    async discoverDepthJobs(methodologyVersion: string): Promise<DiscoveredIngestJob[]> {
      const rows = await db
        .select({
          id: sourceDefinitions.id,
          url: sourceDefinitions.url,
          sourceClass: sourceDefinitions.sourceClass,
          adapter: sourceDefinitions.adapter,
          upstreamId: sourceDefinitions.upstreamId,
          networkId: networks.id,
          networkPassphrase: networks.passphrase,
          config: sourceDefinitions.config,
        })
        .from(sourceDefinitions)
        .innerJoin(networks, eq(networks.id, sourceDefinitions.networkId))
        .where(eq(sourceDefinitions.enabled, true))
        .orderBy(asc(networks.id), asc(sourceDefinitions.id))
      const jobs = new Map<string, Extract<DiscoveredIngestJob, { metric: 'order_book_depth' }>>()
      for (const source of rows) {
        if (source.adapter !== 'sdex' || source.sourceClass !== 'dex') continue
        const rawDepthConfig = source.config.depth
        if (!rawDepthConfig || typeof rawDepthConfig !== 'object' || Array.isArray(rawDepthConfig)) continue
        const rawConfig = rawDepthConfig as Record<string, unknown>
        if (rawConfig.enabled !== true) continue
        const routingPairs = Array.isArray(rawConfig.pairs) && rawConfig.pairs.every((pair) => typeof pair === 'string')
          ? rawConfig.pairs as string[] : null
        if (!routingPairs || routingPairs.length === 0) continue
        const parsedConfig = depthSourceConfigSchema.safeParse(rawDepthConfig)
        for (const pairId of routingPairs) {
          let pair
          try {
            pair = parseTradingPairId(pairId)
          } catch {
            throw new Error(`configured depth pair ${pairId} is invalid`)
          }
          const networkId = networkIdSchema.parse(source.networkId)
          const subjectKey = formatNetworkPairKey(networkId, pair)
          let job = jobs.get(subjectKey)
          if (!job) {
            job = { metric: 'order_book_depth', subjectKey, methodologyVersion, pair, sources: [] }
            jobs.set(subjectKey, job)
          }
          job.sources.push(discoveredSourceSchema.parse({
            ...source,
            networkId,
            ...(parsedConfig.success ? {} : { configurationError: 'Depth source configuration is malformed' }),
          }))
        }
      }
      return [...jobs.values()]
    },

    async discoverTrustlineJobs(methodologyVersion: string): Promise<DiscoveredIngestJob[]> {
      const [sourceRows, assetRows] = await Promise.all([
        db.select({ id: sourceDefinitions.id, url: sourceDefinitions.url, sourceClass: sourceDefinitions.sourceClass,
          adapter: sourceDefinitions.adapter, upstreamId: sourceDefinitions.upstreamId, networkId: networks.id,
          networkPassphrase: networks.passphrase, config: sourceDefinitions.config })
          .from(sourceDefinitions).innerJoin(networks, eq(networks.id, sourceDefinitions.networkId))
          .where(eq(sourceDefinitions.enabled, true)).orderBy(asc(networks.id), asc(sourceDefinitions.id)),
        db.select({ id: assets.id, networkId: assets.networkId, code: assets.code, issuer: assets.issuer, canonicalId: assets.canonicalId })
          .from(assets).where(eq(assets.type, 'credit')).orderBy(asc(assets.networkId), asc(assets.canonicalId)),
      ])
      const jobs: DiscoveredIngestJob[] = []
      for (const asset of assetRows) {
        const parsedAsset = creditAssetSchema.safeParse({ kind: 'credit', code: asset.code, issuer: asset.issuer })
        if (!parsedAsset.success || formatAssetId(parsedAsset.data) !== asset.canonicalId) throw new Error(`configured trustline asset ${asset.id} has an invalid identity`)
        const sources = sourceRows.flatMap((source): DiscoveredSource[] => {
          if (source.adapter !== 'horizon' || source.sourceClass !== 'canonical_ledger' || source.networkId !== asset.networkId) return []
          const raw = source.config.trustlines
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
          const record = raw as Record<string, unknown>
          if (record.enabled !== true) return []
          const routingIds = Array.isArray(record.assetIds) && record.assetIds.every((id) => typeof id === 'string')
            ? record.assetIds as string[]
            : null
          if (routingIds && !routingIds.includes(asset.id)) return []
          const parsed = trustlineSourceConfigSchema.safeParse(raw)
          return [{ id: source.id, url: source.url, sourceClass: source.sourceClass, adapter: source.adapter,
            upstreamId: source.upstreamId, networkId: networkIdSchema.parse(source.networkId), networkPassphrase: source.networkPassphrase,
            ...(parsed.success ? {} : { configurationError: 'Trustline source configuration is malformed' }) }]
        })
        if (sources.length) jobs.push({ metric: 'trustline_count', subjectKey: formatNetworkAssetKey(networkIdSchema.parse(asset.networkId), parsedAsset.data), methodologyVersion, asset: parsedAsset.data, sources })
      }
      return jobs
    },

    async discoverAnchorReserveJobs(methodologyVersion: string, now = new Date()): Promise<DiscoveredIngestJob[]> {
      if (!Number.isFinite(now.getTime())) throw new Error('anchor reserve discovery time must be valid')
      const [sourceRows, assetRows, domainRows] = await Promise.all([
        db.select({
          id: sourceDefinitions.id,
          url: sourceDefinitions.url,
          sourceClass: sourceDefinitions.sourceClass,
          adapter: sourceDefinitions.adapter,
          upstreamId: sourceDefinitions.upstreamId,
          networkId: networks.id,
          networkPassphrase: networks.passphrase,
          config: sourceDefinitions.config,
          anchorId: anchors.id,
          anchorStatus: anchors.status,
          anchorAccount: anchors.stellarAccount,
        }).from(sourceDefinitions)
          .innerJoin(networks, eq(networks.id, sourceDefinitions.networkId))
          .innerJoin(anchors, eq(anchors.id, sourceDefinitions.anchorId))
          .where(eq(sourceDefinitions.enabled, true))
          .orderBy(asc(networks.id), asc(sourceDefinitions.id)),
        db.select({ id: assets.id, networkId: assets.networkId, code: assets.code, issuer: assets.issuer, canonicalId: assets.canonicalId })
          .from(assets).where(eq(assets.type, 'credit')).orderBy(asc(assets.networkId), asc(assets.canonicalId)),
        db.select({ id: anchorDomains.id, anchorId: anchorDomains.anchorId, verificationExpiresAt: anchorDomains.verificationExpiresAt })
          .from(anchorDomains),
      ])
      const domainsById = new Map(domainRows.map((domain) => [domain.id, domain]))
      const jobs: DiscoveredIngestJob[] = []
      for (const source of sourceRows) {
        if (source.adapter !== 'anchor' || source.sourceClass !== 'anchor_self_reported' || source.anchorStatus !== 'verified') continue
        const raw = source.config.anchorReserves
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const parsed = anchorReserveSourceConfigSchema.safeParse(raw)
        if (!parsed.success) continue
        const routingIds = parsed.data.assetIds
        for (const asset of assetRows.filter((candidate) => candidate.networkId === source.networkId && routingIds.includes(candidate.id))) {
          const verification = parsed.data.verifications[asset.id]
          if (!verification || Date.parse(verification.verificationExpiresAt) <= now.getTime()) continue
          const domain = domainsById.get(verification.domainId)
          if (!domain || domain.anchorId !== source.anchorId || !domain.verificationExpiresAt ||
            Date.parse(domain.verificationExpiresAt) <= now.getTime()) continue
          const parsedAsset = creditAssetSchema.safeParse({ kind: 'credit', code: asset.code, issuer: asset.issuer })
          if (!parsedAsset.success || formatAssetId(parsedAsset.data) !== asset.canonicalId || asset.issuer !== source.anchorAccount) {
            throw new Error(`configured anchor reserve asset ${asset.id} has invalid issuer attribution`)
          }
          jobs.push({
            metric: 'anchor_reserves',
            subjectKey: formatNetworkAssetKey(networkIdSchema.parse(source.networkId), parsedAsset.data),
            methodologyVersion: parsed.data.profiles?.[asset.id] === MZAR_RESERVE_CONNECTOR_PROFILE
              ? MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION
              : methodologyVersion,
            anchorId: source.anchorId,
            connectorProfile: parsed.data.profiles?.[asset.id] ?? 'axiom_json_v1',
            asset: parsedAsset.data,
            sources: [discoveredSourceSchema.parse({
              id: source.id,
              url: source.url,
              sourceClass: source.sourceClass,
              adapter: source.adapter,
              upstreamId: source.upstreamId,
              networkId: networkIdSchema.parse(source.networkId),
              networkPassphrase: source.networkPassphrase,
            })],
          })
        }
      }
      const seen = new Set<string>()
      for (const job of jobs) {
        if (seen.has(job.subjectKey)) throw new Error(`multiple active verified anchor reserve routes exist for ${job.subjectKey}`)
        seen.add(job.subjectKey)
      }
      return jobs
    },

    async ensureScheduledCycle(input: ScheduledCycleInput) {
      const inserted = await db
        .insert(scheduledCycleLeases)
        .values({
          ...input,
          jobDefinition: input.jobDefinition as Record<string, unknown> | undefined,
        })
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
          ...(row.jobDefinition === null ? {} : { jobDefinition: row.jobDefinition }),
          ...(row.jobDefinitionSha256 === null ? {} : { jobDefinitionSha256: row.jobDefinitionSha256 }),
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
