import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm'
import { z } from 'zod'
import { encryptContactSecret, type ContactSecretKeyring } from '../anchor/contact-secret'
import {
  CLAIM_CHALLENGE_TTL_SECONDS,
  CLAIM_SESSION_TTL_SECONDS,
  CLAIM_VERIFICATION_TTL_SECONDS,
  claimantTextSchema,
  hashOpaqueToken,
  issueOpaqueToken,
  prepareEvidenceLink,
  prepareEvidenceUpload,
  verifyDomainClaim,
  verifyWebhookContact,
  type EvidenceScanner,
  type EvidenceStorage,
  type EvidenceSubmission,
  type PreparedEvidenceUpload,
} from '../anchor/claims'
import type { ResolveHost } from '../stellar/safe-http'
import { identifierSchema, persistedDiscrepancyStateSchema } from '../contracts/domain'
import { appendDiscrepancyAmendment, transitionDiscrepancyPublication } from '../reconcile/discrepancy-state'
import type { DatabaseClient } from './client'
import {
  anchorCaseEvents,
  anchorCases,
  anchorClaimChallenges,
  anchorClaimEvents,
  anchorClaimSessions,
  anchorClaimants,
  anchorDisputes,
  anchorDomains,
  anchorEvidence,
  anchorContactEndpoints,
  anchorContactSecrets,
  anchorReplies,
  anchors,
  apiPrincipalScopes,
  apiPrincipals,
  corrections,
  discrepancies,
  discrepancyEvents,
  sourceDefinitions,
} from './schema'

function durableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex')}`
}

function canonicalTimestamp(value: string) {
  return new Date(value).toISOString()
}

function discrepancyState(row: typeof discrepancies.$inferSelect) {
  return persistedDiscrepancyStateSchema.parse({
    discrepancyId: row.id, sourceId: row.sourceId, methodologyVersion: row.methodologyVersion,
    namedParty: row.namedParty, severity: row.severity, lifecycleState: row.lifecycleState,
    publicationState: row.publicationState, replyReviewState: row.replyReviewState,
    consecutiveCycles: row.consecutiveCycles, consecutiveAboveInfoCycles: row.consecutiveAboveInfoCycles,
    firstObservedAt: canonicalTimestamp(row.firstObservedAt), lastObservedAt: canonicalTimestamp(row.lastObservedAt),
    lastFinalizedCycleAt: canonicalTimestamp(row.lastFinalizedCycleAt), lastFinalizedCycleId: row.lastFinalizedCycleId,
    publicationUpdatedAt: canonicalTimestamp(row.publicationUpdatedAt),
  })
}

type PreparedEvidence =
  | { kind: 'link'; url: string; scanStatus: 'not_required' }
  | PreparedEvidenceUpload

async function requirePrincipalScope(tx: Parameters<Parameters<DatabaseClient['db']['transaction']>[0]>[0], principalId: string, scopeId: string) {
  const principal = (await tx.select({ id: apiPrincipals.id }).from(apiPrincipals)
    .innerJoin(apiPrincipalScopes, eq(apiPrincipalScopes.principalId, apiPrincipals.id))
    .where(and(eq(apiPrincipals.id, principalId), eq(apiPrincipals.status, 'active'), eq(apiPrincipalScopes.scopeId, scopeId)))
    .limit(1))[0]
  if (!principal) throw new Error(`principal is not active or lacks ${scopeId} scope`)
  return principal
}

/** ANC-04 claimant, reply, dispute, and correction persistence boundary. */
export function createAnchorClaimRepository(client: DatabaseClient, options: {
  verifyDomainControl?: typeof verifyDomainClaim
  verifyWebhookControl?: typeof verifyWebhookContact
  clock?: () => Date
  evidenceScanner?: EvidenceScanner
  evidenceStorage?: EvidenceStorage
  resolveEvidenceHost?: ResolveHost
  contactSecretKeyring?: ContactSecretKeyring
} = {}) {
  const { db } = client
  const verifyDomainControl = options.verifyDomainControl ?? verifyDomainClaim
  const verifyWebhookControl = options.verifyWebhookControl ?? verifyWebhookContact

  function trustedNow() {
    const value = options.clock?.() ?? new Date()
    if (!Number.isFinite(value.getTime())) throw new Error('trusted clock returned an invalid time')
    return value.toISOString()
  }

  async function authenticateSession(tx: Parameters<Parameters<DatabaseClient['db']['transaction']>[0]>[0], token: string, now: string) {
    const tokenHash = hashOpaqueToken(token)
    const row = (await tx.select({ session: anchorClaimSessions, claimant: anchorClaimants })
      .from(anchorClaimSessions)
      .innerJoin(anchorClaimants, eq(anchorClaimants.id, anchorClaimSessions.claimantId))
      .where(and(
        eq(anchorClaimSessions.tokenHash, tokenHash), isNull(anchorClaimSessions.revokedAt),
        gt(anchorClaimSessions.expiresAt, now), isNull(anchorClaimants.revokedAt),
        gt(anchorClaimants.verificationExpiresAt, now),
      )).for('update').limit(1))[0]
    if (!row) throw new Error('claim session is invalid, expired, or revoked')
    await tx.update(anchorClaimSessions).set({ lastUsedAt: now }).where(eq(anchorClaimSessions.id, row.session.id))
    return row.claimant
  }

  async function insertEvidence(tx: Parameters<Parameters<DatabaseClient['db']['transaction']>[0]>[0], parent: { replyId?: string; disputeId?: string }, evidence: readonly PreparedEvidence[]) {
    if (evidence.length > 10) throw new Error('a submission may include at most 10 evidence items')
    const ids: string[] = []
    for (const [index, item] of evidence.entries()) {
      const id = durableId('anchor_evidence', parent.replyId ?? parent.disputeId!, String(index), item.kind === 'link' ? item.url : item.sha256)
      await tx.insert(anchorEvidence).values(item.kind === 'link' ? {
        id, ...parent, kind: 'link', url: item.url, scanStatus: 'not_required',
      } : {
        id, ...parent, kind: 'upload', storageReference: item.storageReference, contentType: item.contentType,
        byteSize: item.byteSize, sha256: item.sha256, scanStatus: item.scanStatus,
        scanResult: item.scanResult, scannedAt: item.scannedAt,
      })
      ids.push(id)
    }
    return ids
  }

  async function prepareEvidence(evidence: readonly EvidenceSubmission[]) {
    if (evidence.length > 10) throw new Error('a submission may include at most 10 evidence items')
    return Promise.all(evidence.map(async (item) => {
      if (item.kind === 'link') return prepareEvidenceLink(item, options.resolveEvidenceHost)
      if (!options.evidenceScanner || !options.evidenceStorage) {
        throw new Error('evidence uploads require configured malware scanning and storage')
      }
      return prepareEvidenceUpload({
        bytes: item.bytes,
        contentType: item.contentType,
        scanner: options.evidenceScanner,
        storage: options.evidenceStorage,
        clock: options.clock,
      })
    }))
  }

  return {
    async registerVerifiedContact(input: { sessionToken: string; kind: 'email' | 'webhook'; endpoint: string; webhookSecret?: string }) {
      const verifiedAt = trustedNow()
      const endpoint = input.endpoint.trim()
      if (!endpoint || endpoint.length > 2_048) throw new Error('contact endpoint must contain 1 through 2048 characters')
      return db.transaction(async (tx) => {
        const claimant = await authenticateSession(tx, input.sessionToken, verifiedAt)
        const domain = (await tx.select({ domain: anchorDomains.domain }).from(anchorDomains).where(eq(anchorDomains.id, claimant.domainId)).limit(1))[0]
        if (!domain) throw new Error('claimant verified domain no longer exists')
        let normalizedEndpoint: string
        if (input.kind === 'email') {
          normalizedEndpoint = endpoint.toLowerCase()
          if (!z.string().email().safeParse(normalizedEndpoint).success || !normalizedEndpoint.endsWith(`@${domain.domain}`)) {
            throw new Error('verified email contact must belong to the claimed domain')
          }
        } else {
          if (!input.webhookSecret || !options.contactSecretKeyring) {
            throw new Error('verified webhook contacts require a signing secret and encryption keyring')
          }
          const url = new URL(endpoint)
          if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.hostname !== domain.domain) {
            throw new Error('verified webhook contact must be credential-free HTTPS on the claimed domain')
          }
          normalizedEndpoint = url.toString()
          const challenge = issueOpaqueToken('al_claim_').token
          await verifyWebhookControl({ url: normalizedEndpoint, expectedHostname: domain.domain, challenge })
        }
        const id = durableId('anchor_contact', claimant.anchorId, input.kind, normalizedEndpoint)
        await tx.insert(anchorContactEndpoints).values({
          id, anchorId: claimant.anchorId, kind: input.kind, endpoint: normalizedEndpoint, verifiedAt,
          claimantId: claimant.id, domainId: claimant.domainId,
          verificationExpiresAt: claimant.verificationExpiresAt, revokedAt: null,
        }).onConflictDoUpdate({
          target: [anchorContactEndpoints.anchorId, anchorContactEndpoints.kind, anchorContactEndpoints.endpoint],
          set: {
            verifiedAt, claimantId: claimant.id, domainId: claimant.domainId,
            verificationExpiresAt: claimant.verificationExpiresAt, revokedAt: null,
          },
        })
        if (input.kind === 'webhook') {
          const current = (await tx.select({ version: anchorContactSecrets.version }).from(anchorContactSecrets)
            .where(eq(anchorContactSecrets.contactEndpointId, id)).orderBy(desc(anchorContactSecrets.version)).limit(1))[0]
          const version = (current?.version ?? 0) + 1
          const encrypted = encryptContactSecret({
            secret: input.webhookSecret!, contactEndpointId: id, version, keyring: options.contactSecretKeyring!,
          })
          await tx.update(anchorContactSecrets).set({ retiredAt: verifiedAt }).where(and(
            eq(anchorContactSecrets.contactEndpointId, id), isNull(anchorContactSecrets.retiredAt),
          ))
          await tx.insert(anchorContactSecrets).values({
            id: durableId('anchor_contact_secret', id, String(version)), contactEndpointId: id, version,
            ...encrypted, createdAt: verifiedAt,
          })
        }
        await tx.insert(anchorClaimEvents).values({
          id: durableId('anchor_claim_event', claimant.id, 'contact_verified', id, verifiedAt),
          anchorId: claimant.anchorId, claimantId: claimant.id, eventType: 'contact_verified',
          actorType: 'claimant', actorId: claimant.id, payload: { contactEndpointId: id, kind: input.kind }, occurredAt: verifiedAt,
        })
        return { id, kind: input.kind, endpoint: normalizedEndpoint, verifiedAt, verificationExpiresAt: claimant.verificationExpiresAt }
      })
    },

    async revokeContact(input: { sessionToken: string; contactEndpointId: string }) {
      const revokedAt = trustedNow()
      return db.transaction(async (tx) => {
        const claimant = await authenticateSession(tx, input.sessionToken, revokedAt)
        const contact = (await tx.select({ id: anchorContactEndpoints.id }).from(anchorContactEndpoints).where(and(
          eq(anchorContactEndpoints.id, identifierSchema.parse(input.contactEndpointId)),
          eq(anchorContactEndpoints.claimantId, claimant.id),
          isNull(anchorContactEndpoints.revokedAt),
        )).for('update').limit(1))[0]
        if (!contact) throw new Error('verified contact is unavailable or not owned by this claimant')
        await tx.update(anchorContactEndpoints).set({ revokedAt }).where(eq(anchorContactEndpoints.id, contact.id))
        await tx.insert(anchorClaimEvents).values({
          id: durableId('anchor_claim_event', claimant.id, 'contact_revoked', contact.id, revokedAt),
          anchorId: claimant.anchorId, claimantId: claimant.id, eventType: 'contact_revoked',
          actorType: 'claimant', actorId: claimant.id, payload: { contactEndpointId: contact.id }, occurredAt: revokedAt,
        })
        return { contactEndpointId: contact.id, revokedAt }
      })
    },

    async createChallenge(input: { anchorId: string; random?: (size: number) => Uint8Array }) {
      const anchorId = identifierSchema.parse(input.anchorId)
      const issuedAt = trustedNow()
      const issued = issueOpaqueToken('al_claim_', input.random)
      return db.transaction(async (tx) => {
        const row = (await tx.select({ anchorStatus: anchors.status, domainId: anchorDomains.id, domain: anchorDomains.domain, domainExpiresAt: anchorDomains.verificationExpiresAt })
          .from(anchors).innerJoin(anchorDomains, eq(anchorDomains.anchorId, anchors.id))
          .where(and(
            eq(anchors.id, anchorId), eq(anchors.status, 'verified'),
            isNotNull(anchorDomains.verifiedAt), gt(anchorDomains.verificationExpiresAt, issuedAt),
          ))
          .orderBy(desc(anchorDomains.verifiedAt)).limit(1))[0]
        if (!row?.domainExpiresAt) throw new Error('anchor has no current verified domain')
        const challengeId = durableId('anchor_claim_challenge', anchorId, issued.tokenHash)
        const expiresAt = new Date(Math.min(
          Date.parse(issuedAt) + CLAIM_CHALLENGE_TTL_SECONDS * 1_000,
          Date.parse(row.domainExpiresAt),
        )).toISOString()
        await tx.insert(anchorClaimChallenges).values({
          id: challengeId, anchorId, domainId: row.domainId, tokenHash: issued.tokenHash,
          verificationPath: '/.well-known/stellar.toml', expiresAt, createdAt: issuedAt,
        })
        await tx.insert(anchorClaimEvents).values({
          id: durableId('anchor_claim_event', anchorId, 'challenge_created', challengeId),
          anchorId, claimantId: null, eventType: 'challenge_created', actorType: 'system', actorId: null,
          payload: { challengeId, domainId: row.domainId, expiresAt }, occurredAt: issuedAt,
        })
        return { challengeId, token: issued.token, domain: row.domain, verificationPath: '/.well-known/stellar.toml', expiresAt }
      })
    },

    async getChallengeForVerification(challengeId: string) {
      const at = trustedNow()
      const row = (await db.select({ domain: anchorDomains.domain }).from(anchorClaimChallenges)
        .innerJoin(anchorDomains, eq(anchorDomains.id, anchorClaimChallenges.domainId))
        .where(and(eq(anchorClaimChallenges.id, identifierSchema.parse(challengeId)), isNull(anchorClaimChallenges.consumedAt), gt(anchorClaimChallenges.expiresAt, at)))
        .limit(1))[0]
      return row ?? null
    },

    async claimAnchor(input: { challengeId: string; token: string; random?: (size: number) => Uint8Array }) {
      const checkedAt = trustedNow()
      const tokenHash = hashOpaqueToken(input.token)
      const session = issueOpaqueToken('al_session_', input.random)
      const verificationTarget = (await db.select({ domain: anchorDomains.domain, tokenHash: anchorClaimChallenges.tokenHash }).from(anchorClaimChallenges)
        .innerJoin(anchorDomains, eq(anchorDomains.id, anchorClaimChallenges.domainId))
        .where(and(
          eq(anchorClaimChallenges.id, identifierSchema.parse(input.challengeId)),
          isNull(anchorClaimChallenges.consumedAt),
          gt(anchorClaimChallenges.expiresAt, checkedAt),
        )).limit(1))[0]
      if (!verificationTarget || verificationTarget.tokenHash !== tokenHash) throw new Error('claim challenge is invalid, expired, or already consumed')
      await verifyDomainControl({ domain: verificationTarget.domain, token: input.token })
      return db.transaction(async (tx) => {
        const verifiedAt = trustedNow()
        const challenge = (await tx.select({
          challenge: anchorClaimChallenges, domainExpiresAt: anchorDomains.verificationExpiresAt,
          domainVerifiedAt: anchorDomains.verifiedAt, domainAnchorId: anchorDomains.anchorId, anchorStatus: anchors.status,
        }).from(anchorClaimChallenges).innerJoin(anchorDomains, eq(anchorDomains.id, anchorClaimChallenges.domainId))
          .innerJoin(anchors, eq(anchors.id, anchorClaimChallenges.anchorId))
          .where(eq(anchorClaimChallenges.id, identifierSchema.parse(input.challengeId))).for('update').limit(1))[0]
        if (!challenge || challenge.challenge.tokenHash !== tokenHash || challenge.challenge.consumedAt ||
          challenge.anchorStatus !== 'verified' || !challenge.domainVerifiedAt ||
          challenge.domainAnchorId !== challenge.challenge.anchorId || !challenge.domainExpiresAt ||
          Date.parse(challenge.challenge.expiresAt) <= Date.parse(verifiedAt) || Date.parse(challenge.domainExpiresAt) <= Date.parse(verifiedAt)) {
          throw new Error('claim challenge is invalid, expired, or already consumed')
        }
        const verificationExpiresAt = new Date(Math.min(
          Date.parse(verifiedAt) + CLAIM_VERIFICATION_TTL_SECONDS * 1_000,
          Date.parse(challenge.domainExpiresAt!),
        )).toISOString()
        await tx.update(anchorClaimants).set({ revokedAt: verifiedAt }).where(and(
          eq(anchorClaimants.anchorId, challenge.challenge.anchorId),
          eq(anchorClaimants.domainId, challenge.challenge.domainId),
          isNull(anchorClaimants.revokedAt),
        ))
        await tx.update(anchorContactEndpoints).set({ revokedAt: verifiedAt }).where(and(
          eq(anchorContactEndpoints.anchorId, challenge.challenge.anchorId),
          eq(anchorContactEndpoints.domainId, challenge.challenge.domainId),
          isNull(anchorContactEndpoints.revokedAt),
        ))
        const versionedClaimantId = durableId('anchor_claimant', challenge.challenge.anchorId, challenge.challenge.domainId, verifiedAt)
        await tx.insert(anchorClaimants).values({
          id: versionedClaimantId, anchorId: challenge.challenge.anchorId, domainId: challenge.challenge.domainId,
          verifiedAt, verificationExpiresAt, createdAt: verifiedAt,
        })
        await tx.update(anchorClaimChallenges).set({ consumedAt: verifiedAt }).where(eq(anchorClaimChallenges.id, challenge.challenge.id))
        const sessionId = durableId('anchor_claim_session', versionedClaimantId, session.tokenHash)
        const expiresAt = new Date(Math.min(Date.parse(verifiedAt) + CLAIM_SESSION_TTL_SECONDS * 1_000, Date.parse(verificationExpiresAt))).toISOString()
        await tx.insert(anchorClaimSessions).values({ id: sessionId, claimantId: versionedClaimantId, tokenHash: session.tokenHash, expiresAt, createdAt: verifiedAt })
        await tx.insert(anchorClaimEvents).values({
          id: durableId('anchor_claim_event', versionedClaimantId, 'claim_verified', challenge.challenge.id),
          anchorId: challenge.challenge.anchorId, claimantId: versionedClaimantId, eventType: 'claim_verified',
          actorType: 'claimant', actorId: versionedClaimantId,
          payload: { challengeId: challenge.challenge.id, domainId: challenge.challenge.domainId, sessionId, expiresAt }, occurredAt: verifiedAt,
        })
        return { claimantId: versionedClaimantId, sessionToken: session.token, expiresAt }
      })
    },

    async revokeSession(input: { sessionToken: string }) {
      const revokedAt = trustedNow()
      return db.transaction(async (tx) => {
        const row = (await tx.select({ session: anchorClaimSessions, claimant: anchorClaimants }).from(anchorClaimSessions)
          .innerJoin(anchorClaimants, eq(anchorClaimants.id, anchorClaimSessions.claimantId))
          .where(and(eq(anchorClaimSessions.tokenHash, hashOpaqueToken(input.sessionToken)), isNull(anchorClaimSessions.revokedAt)))
          .for('update').limit(1))[0]
        if (!row) return false
        await tx.update(anchorClaimSessions).set({ revokedAt }).where(eq(anchorClaimSessions.id, row.session.id))
        await tx.insert(anchorClaimEvents).values({
          id: durableId('anchor_claim_event', row.claimant.id, 'session_revoked', row.session.id),
          anchorId: row.claimant.anchorId, claimantId: row.claimant.id, eventType: 'session_revoked',
          actorType: 'claimant', actorId: row.claimant.id, payload: { sessionId: row.session.id }, occurredAt: revokedAt,
        })
        return true
      })
    },

    async submitReply(input: { caseId: string; sessionToken: string; body: string; evidence?: readonly EvidenceSubmission[] }) {
      const submittedAt = trustedNow()
      const body = claimantTextSchema.parse(input.body)
      return db.transaction(async (tx) => {
        const claimant = await authenticateSession(tx, input.sessionToken, submittedAt)
        const row = (await tx.select({ anchorCase: anchorCases, discrepancy: discrepancies }).from(anchorCases)
          .innerJoin(discrepancies, eq(discrepancies.id, anchorCases.discrepancyId))
          .where(eq(anchorCases.id, identifierSchema.parse(input.caseId))).for('update').limit(1))[0]
        if (!row || row.anchorCase.anchorId !== claimant.anchorId || !['awaiting_reply', 'under_review'].includes(row.anchorCase.status)) {
          throw new Error('claimant is not authorized to reply to this case')
        }
        if (!row.anchorCase.replyDueAt || Date.parse(row.anchorCase.replyDueAt) <= Date.parse(submittedAt)) {
          throw new Error('the anchor reply window has expired')
        }
        const preparedEvidence = await prepareEvidence(input.evidence ?? [])
        const prior = (await tx.select({ id: anchorReplies.id, version: anchorReplies.version }).from(anchorReplies)
          .where(eq(anchorReplies.caseId, row.anchorCase.id)).orderBy(desc(anchorReplies.version)).limit(1))[0]
        const version = (prior?.version ?? 0) + 1
        const replyId = durableId('anchor_reply', row.anchorCase.id, String(version), submittedAt)
        await tx.insert(anchorReplies).values({
          id: replyId, caseId: row.anchorCase.id, claimantId: claimant.id,
          supersedesReplyId: prior?.id ?? null, version, submittedBy: claimant.id, body,
          evidence: {}, submittedAt,
        })
        const evidenceIds = await insertEvidence(tx, { replyId }, preparedEvidence)
        if (row.discrepancy.replyReviewState === 'awaiting_reply') {
          const transition = transitionDiscrepancyPublication({
            state: discrepancyState(row.discrepancy),
            action: { type: 'record_response', eventId: durableId('discrepancy_event', row.discrepancy.id, 'response', replyId), occurredAt: submittedAt },
          })
          await tx.update(discrepancies).set({ replyReviewState: transition.state.replyReviewState, publicationUpdatedAt: submittedAt }).where(eq(discrepancies.id, row.discrepancy.id))
          await tx.insert(discrepancyEvents).values({
            id: transition.event.eventId, discrepancyId: row.discrepancy.id, cycleId: null, targetEventId: null,
            eventType: transition.event.type, methodologyVersion: row.discrepancy.methodologyVersion,
            payload: { ...transition.event, replyId }, occurredAt: submittedAt,
          })
        }
        await tx.update(anchorCases).set({ status: 'under_review', updatedAt: submittedAt }).where(eq(anchorCases.id, row.anchorCase.id))
        await tx.insert(anchorCaseEvents).values({
          id: durableId('anchor_case_event', row.anchorCase.id, 'reply_submitted', replyId), caseId: row.anchorCase.id,
          eventType: 'reply_submitted', actorType: 'anchor', actorId: claimant.id,
          payload: { replyId, version, evidenceIds }, occurredAt: submittedAt,
        })
        return { replyId, version, evidenceIds }
      })
    },

    async submitDispute(input: { flagId: string; sessionToken: string; body: string; evidence?: readonly EvidenceSubmission[] }) {
      const submittedAt = trustedNow()
      const body = claimantTextSchema.parse(input.body)
      return db.transaction(async (tx) => {
        const claimant = await authenticateSession(tx, input.sessionToken, submittedAt)
        const flag = (await tx.select({ discrepancy: discrepancies, anchorId: sourceDefinitions.anchorId })
          .from(discrepancies).innerJoin(sourceDefinitions, eq(sourceDefinitions.id, discrepancies.sourceId))
          .where(eq(discrepancies.id, identifierSchema.parse(input.flagId))).for('update').limit(1))[0]
        if (!flag || flag.anchorId !== claimant.anchorId || flag.discrepancy.publicationState !== 'approved_public') {
          throw new Error('claimant is not authorized to dispute this public flag')
        }
        const preparedEvidence = await prepareEvidence(input.evidence ?? [])
        const anchorCase = (await tx.select({ id: anchorCases.id }).from(anchorCases)
          .where(eq(anchorCases.discrepancyId, flag.discrepancy.id)).limit(1))[0]
        const caseId = anchorCase?.id ?? null
        const disputeId = durableId('anchor_dispute', flag.discrepancy.id, claimant.id, submittedAt)
        await tx.insert(anchorDisputes).values({ id: disputeId, flagId: flag.discrepancy.id, caseId, claimantId: claimant.id, body, submittedAt })
        const evidenceIds = await insertEvidence(tx, { disputeId }, preparedEvidence)
        if (caseId) await tx.insert(anchorCaseEvents).values({
          id: durableId('anchor_case_event', caseId, 'dispute_submitted', disputeId), caseId,
          eventType: 'dispute_submitted', actorType: 'anchor', actorId: claimant.id,
          payload: { disputeId, flagId: flag.discrepancy.id, evidenceIds }, occurredAt: submittedAt,
        })
        return { disputeId, evidenceIds }
      })
    },

    async resolveDispute(input: { disputeId: string; principalId: string; decision: 'resolved' | 'rejected'; publish?: boolean; allowNamedPartyPublication?: boolean }) {
      const occurredAt = trustedNow()
      if (input.publish && input.allowNamedPartyPublication !== true) {
        throw new Error('named-party dispute publication is disabled pending explicit product/legal enablement')
      }
      return db.transaction(async (tx) => {
        await requirePrincipalScope(tx, input.principalId, 'anchor:review')
        const dispute = (await tx.select({ dispute: anchorDisputes, caseId: anchorDisputes.caseId }).from(anchorDisputes)
          .where(eq(anchorDisputes.id, identifierSchema.parse(input.disputeId))).for('update').limit(1))[0]
        if (!dispute || !['open', 'under_review'].includes(dispute.dispute.status)) throw new Error('dispute is not reviewable')
        const publicationState = input.publish ? 'approved_public' as const : 'internal' as const
        await tx.update(anchorDisputes).set({ status: input.decision, publicationState, resolvedAt: occurredAt }).where(eq(anchorDisputes.id, dispute.dispute.id))
        if (dispute.caseId) await tx.insert(anchorCaseEvents).values({
          id: durableId('anchor_case_event', dispute.caseId, 'dispute_reviewed', dispute.dispute.id), caseId: dispute.caseId,
          eventType: 'dispute_reviewed', actorType: 'reviewer', actorId: input.principalId,
          payload: { disputeId: dispute.dispute.id, decision: input.decision, publicationState }, occurredAt,
        })
        return { disputeId: dispute.dispute.id, status: input.decision, publicationState }
      })
    },

    async listDisputesForReview(principalId: string) {
      return db.transaction(async (tx) => {
        await requirePrincipalScope(tx, principalId, 'anchor:review')
        return tx.select({
          disputeId: anchorDisputes.id, flagId: anchorDisputes.flagId, caseId: anchorDisputes.caseId,
          status: anchorDisputes.status, submittedAt: anchorDisputes.submittedAt,
        }).from(anchorDisputes).where(or(eq(anchorDisputes.status, 'open'), eq(anchorDisputes.status, 'under_review')))
          .orderBy(asc(anchorDisputes.submittedAt), asc(anchorDisputes.id))
      })
    },

    async getDisputeForReview(input: { disputeId: string; principalId: string }) {
      return db.transaction(async (tx) => {
        await requirePrincipalScope(tx, input.principalId, 'anchor:review')
        const dispute = (await tx.select().from(anchorDisputes)
          .where(eq(anchorDisputes.id, identifierSchema.parse(input.disputeId))).limit(1))[0]
        if (!dispute) return null
        const evidence = await tx.select().from(anchorEvidence).where(eq(anchorEvidence.disputeId, dispute.id)).orderBy(asc(anchorEvidence.id))
        return { dispute, evidence }
      })
    },

    async correctFlag(input: { caseId: string; targetEventId: string; principalId: string; action: 'corrected' | 'retracted'; reason: string; correctedDeviationBand?: 'within_tolerance' | 'info' | 'above_info' }) {
      const occurredAt = trustedNow()
      const reason = claimantTextSchema.parse(input.reason)
      return db.transaction(async (tx) => {
        await requirePrincipalScope(tx, input.principalId, 'anchor:correct')
        const row = (await tx.select({ anchorCase: anchorCases, discrepancy: discrepancies }).from(anchorCases)
          .innerJoin(discrepancies, eq(discrepancies.id, anchorCases.discrepancyId))
          .where(eq(anchorCases.id, identifierSchema.parse(input.caseId))).for('update').limit(1))[0]
        if (!row) throw new Error('correction case does not exist')
        const target = (await tx.select().from(discrepancyEvents).where(and(
          eq(discrepancyEvents.id, identifierSchema.parse(input.targetEventId)),
          eq(discrepancyEvents.discrepancyId, row.discrepancy.id),
        )).limit(1))[0]
        const correctableEventTypes = ['opened', 'observed', 'escalated', 'reconverged', 'resolved'] as const
        if (!target || !target.cycleId || !correctableEventTypes.includes(target.eventType as typeof correctableEventTypes[number])) {
          throw new Error('correction target must be a measurement event for the case discrepancy')
        }
        const amendment = appendDiscrepancyAmendment({
          state: discrepancyState(row.discrepancy), eventId: durableId('discrepancy_event', row.discrepancy.id, input.action, occurredAt),
          targetEvent: {
            eventId: target.id, type: target.eventType as 'opened' | 'observed' | 'escalated' | 'reconverged' | 'resolved',
            discrepancyId: row.discrepancy.id, sourceId: row.discrepancy.sourceId, methodologyVersion: target.methodologyVersion,
            cycleId: target.cycleId, occurredAt: canonicalTimestamp(target.occurredAt), deviationBand: ((target.payload as Record<string, unknown>).deviationBand ?? 'above_info') as 'within_tolerance' | 'info' | 'above_info',
            before: null, after: { severity: row.discrepancy.severity, lifecycleState: row.discrepancy.lifecycleState, publicationState: row.discrepancy.publicationState, replyReviewState: row.discrepancy.replyReviewState, consecutiveCycles: row.discrepancy.consecutiveCycles, consecutiveAboveInfoCycles: row.discrepancy.consecutiveAboveInfoCycles },
          },
          type: input.action, occurredAt, reason,
          ...(input.correctedDeviationBand ? { correctedDeviationBand: input.correctedDeviationBand } : {}),
        })
        const correctionId = durableId('correction', row.anchorCase.id, amendment.eventId)
        await tx.insert(corrections).values({
          id: correctionId, caseId: row.anchorCase.id, targetEventId: target.id, authorPrincipalId: input.principalId,
          reason, replacement: input.correctedDeviationBand ? { correctedDeviationBand: input.correctedDeviationBand } : null,
        })
        await tx.insert(discrepancyEvents).values({
          id: amendment.eventId, discrepancyId: amendment.discrepancyId, cycleId: null, targetEventId: amendment.targetEventId,
          eventType: amendment.type, methodologyVersion: amendment.methodologyVersion, payload: { ...amendment, correctionId }, occurredAt,
        })
        const publicationState = input.action === 'retracted' && row.discrepancy.publicationState === 'approved_public'
          ? 'withheld' as const
          : row.discrepancy.publicationState
        if (publicationState !== row.discrepancy.publicationState) {
          await tx.update(discrepancies).set({ publicationState: 'withheld', publicationUpdatedAt: occurredAt }).where(eq(discrepancies.id, row.discrepancy.id))
        }
        await tx.insert(anchorCaseEvents).values({
          id: durableId('anchor_case_event', row.anchorCase.id, input.action, correctionId), caseId: row.anchorCase.id,
          eventType: input.action, actorType: 'administrator', actorId: input.principalId,
          payload: { correctionId, targetEventId: target.id }, occurredAt,
        })
        return { correctionId, eventId: amendment.eventId, publicationState }
      })
    },
  }
}

export type AnchorClaimRepository = ReturnType<typeof createAnchorClaimRepository>
