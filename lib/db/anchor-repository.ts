import { createHash } from 'node:crypto'
import { and, eq, ne } from 'drizzle-orm'
import { anchorReserveMethodologyConfig } from '../../config/methodology'
import { creditAssetSchema, formatAssetId, networkIdSchema } from '../contracts/domain'
import type { VerifiedAnchorDiscovery } from '../stellar/anchor-discovery'
import { anchorReserveConnectorProfile } from '../stellar/mzar-profile'
import type { DatabaseClient } from './client'
import { anchorContactEndpoints, anchorDomains, anchorVerificationEvents, anchors, assets, networks, sourceDefinitions } from './schema'

function id(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex')}`
}

/** Persists only a discovery result that has already passed issuer/domain/SEP-1 verification. */
export function createAnchorRepository(client: DatabaseClient) {
  const { db } = client
  return {
    async persistVerifiedDiscovery(input: { networkId: string; discovery: VerifiedAnchorDiscovery }) {
      const networkId = networkIdSchema.parse(input.networkId)
      const asset = creditAssetSchema.parse(input.discovery.asset)
      const verificationExpiresAt = new Date(Date.parse(input.discovery.verifiedAt) + anchorReserveMethodologyConfig.verificationValiditySeconds * 1_000).toISOString()
      return db.transaction(async (tx) => {
        const assetRows = await tx.select({ id: assets.id, issuer: assets.issuer, canonicalId: assets.canonicalId, networkPassphrase: networks.passphrase })
          .from(assets)
          .innerJoin(networks, eq(networks.id, assets.networkId))
          .where(and(eq(assets.networkId, networkId), eq(assets.canonicalId, formatAssetId(asset))))
          .limit(1)
        const assetRow = assetRows[0]
        if (!assetRow || assetRow.issuer !== input.discovery.issuer) throw new Error('verified anchor asset is not registered for this network')
        if (assetRow.networkPassphrase !== input.discovery.evidence.networkPassphrase) throw new Error('verified anchor evidence does not match the registered network')

        const anchorId = id('anchor', networkId, input.discovery.issuer)
        const persistedAnchors = await tx.insert(anchors).values({
          id: anchorId,
          networkId,
          name: input.discovery.organizationName,
          stellarAccount: input.discovery.issuer,
          status: 'verified',
          updatedAt: input.discovery.verifiedAt,
        }).onConflictDoUpdate({
          target: [anchors.networkId, anchors.stellarAccount],
          set: { name: input.discovery.organizationName, status: 'verified', updatedAt: input.discovery.verifiedAt },
        }).returning({ id: anchors.id })
        const persistedAnchorId = persistedAnchors[0]?.id
        if (!persistedAnchorId) throw new Error('verified anchor could not be persisted')

        const domainId = id('anchor_domain', persistedAnchorId, input.discovery.homeDomain)
        await tx.insert(anchorDomains).values({
          id: domainId,
          anchorId: persistedAnchorId,
          domain: input.discovery.homeDomain,
          verifiedAt: input.discovery.verifiedAt,
          verificationExpiresAt,
          verificationEvidence: {
            stellarTomlUrl: input.discovery.stellarTomlUrl,
            asset: formatAssetId(asset),
            ...input.discovery.evidence,
          },
        }).onConflictDoNothing({ target: [anchorDomains.anchorId, anchorDomains.domain] })
        const domain = await tx.select({ id: anchorDomains.id, anchorId: anchorDomains.anchorId }).from(anchorDomains)
          .where(and(eq(anchorDomains.anchorId, persistedAnchorId), eq(anchorDomains.domain, input.discovery.homeDomain))).limit(1)
        if (domain[0]?.anchorId !== persistedAnchorId) throw new Error('verified domain is already attributed to another anchor')
        const persistedDomainId = domain[0].id
        await tx.update(anchorDomains).set({
          verifiedAt: input.discovery.verifiedAt,
          verificationExpiresAt,
          verificationEvidence: {
            stellarTomlUrl: input.discovery.stellarTomlUrl,
            asset: formatAssetId(asset),
            ...input.discovery.evidence,
          },
        }).where(eq(anchorDomains.id, persistedDomainId))

        const supersededDomains = await tx.select({ id: anchorDomains.id }).from(anchorDomains)
          .where(and(eq(anchorDomains.anchorId, persistedAnchorId), ne(anchorDomains.id, persistedDomainId)))
        for (const superseded of supersededDomains) {
          await tx.update(anchorDomains).set({ verificationExpiresAt: input.discovery.verifiedAt })
            .where(eq(anchorDomains.id, superseded.id))
          await tx.insert(anchorVerificationEvents).values({
            id: id('anchor_verification', persistedAnchorId, assetRow.id, superseded.id, input.discovery.verifiedAt, 'superseded'),
            anchorId: persistedAnchorId,
            domainId: superseded.id,
            assetId: assetRow.id,
            eventType: 'suspended',
            evidence: { asset: formatAssetId(asset), failureCode: 'home_domain_superseded' },
            occurredAt: input.discovery.verifiedAt,
            expiresAt: null,
          }).onConflictDoNothing()
        }

        for (const contact of input.discovery.contacts) {
          await tx.insert(anchorContactEndpoints).values({
            id: id('anchor_contact', persistedAnchorId, contact.kind, contact.endpoint),
            anchorId: persistedAnchorId,
            kind: contact.kind,
            endpoint: contact.endpoint,
            verifiedAt: null,
          }).onConflictDoNothing({
            target: [anchorContactEndpoints.anchorId, anchorContactEndpoints.kind, anchorContactEndpoints.endpoint],
          })
        }

        const anchorSources = await tx.select({ id: sourceDefinitions.id, url: sourceDefinitions.url, anchorId: sourceDefinitions.anchorId, adapter: sourceDefinitions.adapter, sourceClass: sourceDefinitions.sourceClass, config: sourceDefinitions.config })
          .from(sourceDefinitions)
          .where(and(eq(sourceDefinitions.networkId, networkId), eq(sourceDefinitions.anchorId, persistedAnchorId)))
        const existing = anchorSources.find((source) => source.url === input.discovery.attestationUrl)
        if (existing && (existing.anchorId !== persistedAnchorId || existing.adapter !== 'anchor' || existing.sourceClass !== 'anchor_self_reported')) {
          throw new Error('attestation URL is already registered with incompatible attribution')
        }
        const existingReserve = existing?.config.anchorReserves
        const priorAssetIds = existingReserve && typeof existingReserve === 'object' && !Array.isArray(existingReserve) &&
          Array.isArray((existingReserve as Record<string, unknown>).assetIds)
          ? (existingReserve as { assetIds: unknown[] }).assetIds.filter((value): value is string => typeof value === 'string')
          : []
        const priorVerifications = existingReserve && typeof existingReserve === 'object' && !Array.isArray(existingReserve) &&
          (existingReserve as Record<string, unknown>).verifications && typeof (existingReserve as Record<string, unknown>).verifications === 'object' &&
          !Array.isArray((existingReserve as Record<string, unknown>).verifications)
          ? (existingReserve as { verifications: Record<string, unknown> }).verifications
          : {}
        const priorProfiles = existingReserve && typeof existingReserve === 'object' && !Array.isArray(existingReserve) &&
          (existingReserve as Record<string, unknown>).profiles && typeof (existingReserve as Record<string, unknown>).profiles === 'object' &&
          !Array.isArray((existingReserve as Record<string, unknown>).profiles)
          ? (existingReserve as { profiles: Record<string, unknown> }).profiles
          : {}
        const connectorProfile = anchorReserveConnectorProfile({ asset, homeDomain: input.discovery.homeDomain, attestationUrl: input.discovery.attestationUrl })
        const config = {
          ...(existing?.config ?? {}),
          anchorReserves: {
            enabled: true,
            assetIds: [...new Set([...priorAssetIds, assetRow.id])].sort(),
            verifications: { ...priorVerifications, [assetRow.id]: { domainId: persistedDomainId, verifiedAt: input.discovery.verifiedAt, verificationExpiresAt } },
            profiles: { ...priorProfiles, [assetRow.id]: connectorProfile },
          },
        }
        for (const source of anchorSources) {
          if (source.id === existing?.id || source.adapter !== 'anchor' || source.sourceClass !== 'anchor_self_reported') continue
          const reserve = source.config.anchorReserves
          if (!reserve || typeof reserve !== 'object' || Array.isArray(reserve)) continue
          const remaining = Array.isArray((reserve as Record<string, unknown>).assetIds)
            ? (reserve as { assetIds: unknown[] }).assetIds.filter((value): value is string => typeof value === 'string' && value !== assetRow.id)
            : []
          const priorBindings = (reserve as Record<string, unknown>).verifications
          const verifications = priorBindings && typeof priorBindings === 'object' && !Array.isArray(priorBindings)
            ? Object.fromEntries(Object.entries(priorBindings).filter(([key]) => key !== assetRow.id))
            : {}
          const priorProfiles = (reserve as Record<string, unknown>).profiles
          const profiles = priorProfiles && typeof priorProfiles === 'object' && !Array.isArray(priorProfiles)
            ? Object.fromEntries(Object.entries(priorProfiles).filter(([key]) => key !== assetRow.id))
            : {}
          await tx.update(sourceDefinitions).set({
            enabled: remaining.length > 0,
            config: { ...source.config, anchorReserves: { ...reserve, enabled: remaining.length > 0, assetIds: remaining, verifications, profiles } },
            updatedAt: input.discovery.verifiedAt,
          }).where(eq(sourceDefinitions.id, source.id))
        }
        const sourceId = existing?.id ?? id('anchor_source', networkId, input.discovery.attestationUrl)
        if (existing) {
          await tx.update(sourceDefinitions).set({ config, enabled: true, updatedAt: input.discovery.verifiedAt })
            .where(eq(sourceDefinitions.id, sourceId))
        } else {
          await tx.insert(sourceDefinitions).values({
            id: sourceId,
            networkId,
            anchorId: persistedAnchorId,
            sourceClass: 'anchor_self_reported',
            adapter: 'anchor',
            url: input.discovery.attestationUrl,
            upstreamId: persistedAnchorId,
            enabled: true,
            config,
            updatedAt: input.discovery.verifiedAt,
          })
        }
        await tx.insert(anchorVerificationEvents).values({
          id: id('anchor_verification', persistedAnchorId, assetRow.id, input.discovery.verifiedAt, input.discovery.evidence.stellarTomlSha256),
          anchorId: persistedAnchorId,
          domainId: persistedDomainId,
          assetId: assetRow.id,
          eventType: 'verified',
          evidence: {
            stellarTomlUrl: input.discovery.stellarTomlUrl,
            attestationUrl: input.discovery.attestationUrl,
            asset: formatAssetId(asset),
            ...input.discovery.evidence,
          },
          occurredAt: input.discovery.verifiedAt,
          expiresAt: verificationExpiresAt,
        }).onConflictDoNothing()
        return { anchorId: persistedAnchorId, domainId: persistedDomainId, sourceId, assetId: assetRow.id }
      })
    },

    async suspendVerification(input: { networkId: string; issuer: string; asset: unknown; occurredAt: string; failureCode: string }) {
      const networkId = networkIdSchema.parse(input.networkId)
      const asset = creditAssetSchema.parse(input.asset)
      return db.transaction(async (tx) => {
        const anchor = (await tx.select({ id: anchors.id }).from(anchors)
          .where(and(eq(anchors.networkId, networkId), eq(anchors.stellarAccount, input.issuer))).limit(1))[0]
        if (!anchor) return { status: 'not_registered' as const }
        const assetRow = (await tx.select({ id: assets.id }).from(assets)
          .where(and(eq(assets.networkId, networkId), eq(assets.canonicalId, formatAssetId(asset)))).limit(1))[0]
        if (!assetRow) throw new Error('anchor verification asset is not registered')
        const sources = await tx.select({ id: sourceDefinitions.id, config: sourceDefinitions.config }).from(sourceDefinitions)
          .where(and(eq(sourceDefinitions.networkId, networkId), eq(sourceDefinitions.anchorId, anchor.id)))
        const boundDomainId = sources.flatMap((source) => {
          const reserve = source.config.anchorReserves
          if (!reserve || typeof reserve !== 'object' || Array.isArray(reserve)) return []
          const verifications = (reserve as Record<string, unknown>).verifications
          if (!verifications || typeof verifications !== 'object' || Array.isArray(verifications)) return []
          const binding = (verifications as Record<string, unknown>)[assetRow.id]
          return binding && typeof binding === 'object' && !Array.isArray(binding) && typeof (binding as Record<string, unknown>).domainId === 'string'
            ? [(binding as { domainId: string }).domainId]
            : []
        })[0]
        const domain = (await tx.select({ id: anchorDomains.id }).from(anchorDomains)
          .where(boundDomainId ? and(eq(anchorDomains.anchorId, anchor.id), eq(anchorDomains.id, boundDomainId)) : eq(anchorDomains.anchorId, anchor.id)).limit(1))[0]
        if (!domain) throw new Error('registered anchor has no domain projection')
        let hasCurrentBinding = false
        for (const source of sources) {
          const reserve = source.config.anchorReserves
          if (!reserve || typeof reserve !== 'object' || Array.isArray(reserve)) continue
          const remaining = Array.isArray((reserve as Record<string, unknown>).assetIds)
            ? (reserve as { assetIds: unknown[] }).assetIds.filter((value): value is string => typeof value === 'string' && value !== assetRow.id)
            : []
          const priorBindings = (reserve as Record<string, unknown>).verifications
          const verifications = priorBindings && typeof priorBindings === 'object' && !Array.isArray(priorBindings)
            ? Object.fromEntries(Object.entries(priorBindings).filter(([key]) => key !== assetRow.id))
            : {}
          const priorProfiles = (reserve as Record<string, unknown>).profiles
          const profiles = priorProfiles && typeof priorProfiles === 'object' && !Array.isArray(priorProfiles)
            ? Object.fromEntries(Object.entries(priorProfiles).filter(([key]) => key !== assetRow.id))
            : {}
          hasCurrentBinding ||= Object.values(verifications).some((binding) =>
            binding && typeof binding === 'object' && !Array.isArray(binding) &&
            typeof (binding as Record<string, unknown>).verificationExpiresAt === 'string' &&
            Date.parse((binding as { verificationExpiresAt: string }).verificationExpiresAt) > Date.parse(input.occurredAt),
          )
          await tx.update(sourceDefinitions).set({
            enabled: remaining.length > 0,
            config: { ...source.config, anchorReserves: { ...reserve, enabled: remaining.length > 0, assetIds: remaining, verifications, profiles } },
            updatedAt: input.occurredAt,
          }).where(eq(sourceDefinitions.id, source.id))
        }
        await tx.update(anchors).set({ status: hasCurrentBinding ? 'verified' : 'suspended', updatedAt: input.occurredAt }).where(eq(anchors.id, anchor.id))
        await tx.insert(anchorVerificationEvents).values({
          id: id('anchor_verification', anchor.id, assetRow.id, input.occurredAt, 'suspended', input.failureCode),
          anchorId: anchor.id,
          domainId: domain.id,
          assetId: assetRow.id,
          eventType: 'suspended',
          evidence: { asset: formatAssetId(asset), failureCode: input.failureCode },
          occurredAt: input.occurredAt,
          expiresAt: null,
        }).onConflictDoNothing()
        return { status: 'suspended' as const, anchorId: anchor.id, assetId: assetRow.id }
      })
    },
  }
}

export type AnchorRepository = ReturnType<typeof createAnchorRepository>
