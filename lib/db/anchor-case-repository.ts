import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { ContactSecretKeyring } from '../anchor/contact-secret'
import { encryptContactSecret } from '../anchor/contact-secret'
import { planAnchorCase, replyDueAt } from '../anchor/case-workflow'
import { persistedDiscrepancyStateSchema, utcTimestampSchema } from '../contracts/domain'
import { computeEvidenceSha256 } from '../evidence/json'
import { transitionDiscrepancyPublication } from '../reconcile/discrepancy-state'
import type { DatabaseClient } from './client'
import {
  anchorCaseEvents,
  anchorCases,
  anchorContactEndpoints,
  anchorContactSecrets,
  anchorReviews,
  anchorReplies,
  anchors,
  apiPrincipalScopes,
  apiPrincipals,
  discrepancies,
  discrepancyEvents,
  notificationDeliveryAttempts,
  notifications,
  rawReadings,
  sourceDefinitions,
} from './schema'

function durableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex')}`
}

function publicationEventRow(event: ReturnType<typeof transitionDiscrepancyPublication>['event']) {
  return {
    id: event.eventId,
    discrepancyId: event.discrepancyId,
    cycleId: null,
    targetEventId: null,
    eventType: event.type,
    methodologyVersion: event.methodologyVersion,
    payload: { ...event },
    occurredAt: event.occurredAt,
  }
}

function canonicalTimestamp(value: string) {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error('database returned an invalid timestamp')
  return parsed.toISOString()
}

function stateFromRow(row: typeof discrepancies.$inferSelect) {
  return persistedDiscrepancyStateSchema.parse({
    discrepancyId: row.id,
    sourceId: row.sourceId,
    methodologyVersion: row.methodologyVersion,
    namedParty: row.namedParty,
    severity: row.severity,
    lifecycleState: row.lifecycleState,
    publicationState: row.publicationState,
    replyReviewState: row.replyReviewState,
    consecutiveCycles: row.consecutiveCycles,
    consecutiveAboveInfoCycles: row.consecutiveAboveInfoCycles,
    firstObservedAt: canonicalTimestamp(row.firstObservedAt),
    lastObservedAt: canonicalTimestamp(row.lastObservedAt),
    lastFinalizedCycleAt: canonicalTimestamp(row.lastFinalizedCycleAt),
    lastFinalizedCycleId: row.lastFinalizedCycleId,
    publicationUpdatedAt: canonicalTimestamp(row.publicationUpdatedAt),
  })
}

export interface NotificationDeliveryResult {
  outcome: 'sent' | 'failed'
  startedAt: string
  completedAt: string
  httpStatus?: number
  responseBody?: Uint8Array
  failure?: { code: string; retryable: boolean }
  nextAttemptAt?: string | null
}

export interface ClaimedAnchorNotification {
  id: string
  contactEndpointId: string
  leaseToken: number
  attemptCount: number
  channel: 'email' | 'webhook'
  endpoint: string
  payload: Record<string, unknown>
  secret: null | {
    version: number
    keyId: string
    ciphertext: string
    initializationVector: string
    authenticationTag: string
  }
}

/** Internal ANC-03 persistence boundary. Public routes must not import this repository. */
export function createAnchorCaseRepository(client: DatabaseClient) {
  const { db } = client
  return {
    async rotateContactSecret(input: { contactEndpointId: string; secret: string; rotatedAt: string; keyring: ContactSecretKeyring; random?: (size: number) => Uint8Array }) {
      const rotatedAt = utcTimestampSchema.parse(input.rotatedAt)
      return db.transaction(async (tx) => {
        const contact = (await tx.select({ id: anchorContactEndpoints.id, kind: anchorContactEndpoints.kind })
          .from(anchorContactEndpoints).where(eq(anchorContactEndpoints.id, input.contactEndpointId)).for('update').limit(1))[0]
        if (!contact || contact.kind !== 'webhook') throw new Error('contact secret rotation requires a webhook endpoint')
        const current = (await tx.select({ version: anchorContactSecrets.version }).from(anchorContactSecrets)
          .where(eq(anchorContactSecrets.contactEndpointId, contact.id)).orderBy(sql`${anchorContactSecrets.version} DESC`).limit(1))[0]
        const version = (current?.version ?? 0) + 1
        const encrypted = encryptContactSecret({
          secret: input.secret,
          contactEndpointId: contact.id,
          version,
          keyring: input.keyring,
          random: input.random,
        })
        await tx.update(anchorContactSecrets).set({ retiredAt: rotatedAt }).where(and(
          eq(anchorContactSecrets.contactEndpointId, contact.id),
          isNull(anchorContactSecrets.retiredAt),
        ))
        const id = durableId('anchor_contact_secret', contact.id, String(version))
        await tx.insert(anchorContactSecrets).values({ id, contactEndpointId: contact.id, version, ...encrypted })
        return { id, version, keyId: encrypted.keyId }
      })
    },

    async findEligibleCaseCandidates(limit = 25) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) throw new Error('case candidate limit must be between 1 and 100')
      const rows = await db.selectDistinctOn([discrepancies.id], { discrepancyId: discrepancies.id, triggeringEventId: discrepancyEvents.id })
        .from(discrepancies)
        .innerJoin(sourceDefinitions, eq(sourceDefinitions.id, discrepancies.sourceId))
        .innerJoin(anchors, eq(anchors.id, sourceDefinitions.anchorId))
        .innerJoin(discrepancyEvents, eq(discrepancyEvents.discrepancyId, discrepancies.id))
        .leftJoin(anchorCases, eq(anchorCases.discrepancyId, discrepancies.id))
        .where(and(
          eq(discrepancies.namedParty, true),
          eq(discrepancies.lifecycleState, 'open'),
          inArray(discrepancies.severity, ['warning', 'critical']),
          eq(discrepancies.publicationState, 'internal'),
          eq(anchors.status, 'verified'),
          isNull(anchorCases.id),
          inArray(discrepancyEvents.eventType, ['opened', 'observed', 'escalated']),
        ))
        .orderBy(asc(discrepancies.id), desc(discrepancyEvents.occurredAt), desc(discrepancyEvents.id))
        .limit(limit)
      return rows
    },

    async openEligibleCase(input: { discrepancyId: string; triggeringEventId: string; openedAt: string }) {
      const openedAt = utcTimestampSchema.parse(input.openedAt)
      return db.transaction(async (tx) => {
        const candidate = (await tx.select({ discrepancy: discrepancies, anchorId: sourceDefinitions.anchorId, anchorStatus: anchors.status })
          .from(discrepancies)
          .innerJoin(sourceDefinitions, eq(sourceDefinitions.id, discrepancies.sourceId))
          .innerJoin(anchors, eq(anchors.id, sourceDefinitions.anchorId))
          .where(eq(discrepancies.id, input.discrepancyId))
          .for('update')
          .limit(1))[0]
        if (!candidate?.anchorId || candidate.anchorStatus !== 'verified') {
          throw new Error('eligible discrepancy is not attributed to a verified anchor')
        }
        const triggeringEvent = (await tx.select({ id: discrepancyEvents.id, eventType: discrepancyEvents.eventType })
          .from(discrepancyEvents)
          .where(and(eq(discrepancyEvents.id, input.triggeringEventId), eq(discrepancyEvents.discrepancyId, input.discrepancyId)))
          .limit(1))[0]
        if (!triggeringEvent || !['opened', 'observed', 'escalated'].includes(triggeringEvent.eventType)) {
          throw new Error('anchor case requires an eligible discrepancy measurement event')
        }
        const existing = (await tx.select({ id: anchorCases.id, status: anchorCases.status })
          .from(anchorCases).where(eq(anchorCases.discrepancyId, input.discrepancyId)).limit(1))[0]
        if (existing) return { status: 'duplicate' as const, caseId: existing.id, caseStatus: existing.status }

        const contacts = await tx.select({
          id: anchorContactEndpoints.id,
          kind: anchorContactEndpoints.kind,
          verifiedAt: anchorContactEndpoints.verifiedAt,
          verificationExpiresAt: anchorContactEndpoints.verificationExpiresAt,
        }).from(anchorContactEndpoints).where(and(
          eq(anchorContactEndpoints.anchorId, candidate.anchorId),
          inArray(anchorContactEndpoints.kind, ['email', 'webhook']),
          isNull(anchorContactEndpoints.revokedAt),
          or(isNull(anchorContactEndpoints.verificationExpiresAt), gt(anchorContactEndpoints.verificationExpiresAt, openedAt)),
        )).orderBy(asc(anchorContactEndpoints.id))
        const webhookIds = contacts.filter((contact) => contact.kind === 'webhook').map((contact) => contact.id)
        const activeWebhookSecretRows = webhookIds.length > 0 ? await tx.select({ contactEndpointId: anchorContactSecrets.contactEndpointId })
          .from(anchorContactSecrets).where(and(
            inArray(anchorContactSecrets.contactEndpointId, webhookIds), isNull(anchorContactSecrets.retiredAt),
          )) : []
        const activeWebhookSecretIds = new Set(activeWebhookSecretRows.map((row) => row.contactEndpointId))
        const plan = planAnchorCase({
          anchorId: candidate.anchorId,
          discrepancyState: stateFromRow(candidate.discrepancy),
          triggeringEventId: triggeringEvent.id,
          contacts: contacts.flatMap((contact) => contact.verifiedAt && (contact.kind === 'email' || activeWebhookSecretIds.has(contact.id))
            ? [{ id: contact.id, kind: contact.kind as 'email' | 'webhook', verifiedAt: new Date(contact.verifiedAt).toISOString() }]
            : []),
          openedAt,
        })
        await tx.insert(anchorCases).values(plan.caseRecord)
        await tx.insert(anchorCaseEvents).values(plan.caseEvent)
        await tx.insert(notifications).values(plan.notifications)
        return { status: 'opened' as const, caseId: plan.caseRecord.id, notificationIds: plan.notifications.map((notice) => notice.id) }
      })
    },

    async claimDueNotifications(input: { workerId: string; now: string; leaseDurationMs: number; limit: number }): Promise<ClaimedAnchorNotification[]> {
      const now = utcTimestampSchema.parse(input.now)
      if (!input.workerId.trim() || input.workerId.length > 128) throw new Error('notification workerId must contain 1 to 128 characters')
      if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) throw new Error('notification leaseDurationMs must be positive')
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 100) throw new Error('notification claim limit must be between 1 and 100')
      const expiresAt = new Date(Date.parse(now) + input.leaseDurationMs).toISOString()
      return db.transaction(async (tx) => {
        const due = await tx.select({ id: notifications.id }).from(notifications).where(and(
          or(
            eq(notifications.status, 'pending'),
            and(eq(notifications.status, 'failed'), lte(notifications.nextAttemptAt, now)),
          ),
          or(isNull(notifications.leaseExpiresAt), lte(notifications.leaseExpiresAt, now)),
        )).orderBy(asc(notifications.nextAttemptAt), asc(notifications.createdAt), asc(notifications.id))
          .for('update', { skipLocked: true }).limit(input.limit)
        if (due.length === 0) return []
        const claimed: ClaimedAnchorNotification[] = []
        for (const candidate of due) {
          const updated = (await tx.update(notifications).set({
            leaseOwner: input.workerId,
            leaseToken: sql`${notifications.leaseToken} + 1`,
            leaseExpiresAt: expiresAt,
          }).where(eq(notifications.id, candidate.id)).returning())[0]
          if (!updated) continue
          const contact = (await tx.select({ endpoint: anchorContactEndpoints.endpoint, kind: anchorContactEndpoints.kind })
            .from(anchorContactEndpoints).where(eq(anchorContactEndpoints.id, updated.contactEndpointId)).limit(1))[0]
          if (!contact || !['email', 'webhook'].includes(contact.kind) || contact.kind !== updated.channel) {
            throw new Error('notification contact does not match its persisted channel')
          }
          const secret = contact.kind === 'webhook'
            ? (await tx.select({
                version: anchorContactSecrets.version,
                keyId: anchorContactSecrets.keyId,
                ciphertext: anchorContactSecrets.ciphertext,
                initializationVector: anchorContactSecrets.initializationVector,
                authenticationTag: anchorContactSecrets.authenticationTag,
              }).from(anchorContactSecrets).where(and(
                eq(anchorContactSecrets.contactEndpointId, updated.contactEndpointId),
                isNull(anchorContactSecrets.retiredAt),
              )).limit(1))[0] ?? null
            : null
          claimed.push({
            id: updated.id,
            contactEndpointId: updated.contactEndpointId,
            leaseToken: updated.leaseToken,
            attemptCount: updated.attemptCount,
            channel: updated.channel as 'email' | 'webhook',
            endpoint: contact.endpoint,
            payload: updated.payload,
            secret,
          })
        }
        return claimed
      })
    },

    async recordDeliveryAttempt(input: { notificationId: string; workerId?: string; leaseToken?: number; result: NotificationDeliveryResult }) {
      const startedAt = utcTimestampSchema.parse(input.result.startedAt)
      const completedAt = utcTimestampSchema.parse(input.result.completedAt)
      if (Date.parse(completedAt) < Date.parse(startedAt)) throw new Error('delivery completion cannot precede its start')
      if (input.result.outcome === 'sent' && input.result.failure) throw new Error('sent delivery cannot include failure metadata')
      if (input.result.outcome === 'failed' && !input.result.failure) throw new Error('failed delivery requires structured failure metadata')
      if (input.result.failure) {
        const keys = Object.keys(input.result.failure).sort()
        if (keys.join(',') !== 'code,retryable' || !/^[a-z0-9_]{1,64}$/.test(input.result.failure.code) || typeof input.result.failure.retryable !== 'boolean') {
          throw new Error('delivery failure metadata must contain only a bounded code and retryable flag')
        }
      }
      if (input.result.responseBody !== undefined && !(input.result.responseBody instanceof Uint8Array)) {
        throw new Error('delivery responseBody must be bytes')
      }
      if (input.result.httpStatus !== undefined && (!Number.isSafeInteger(input.result.httpStatus) || input.result.httpStatus < 100 || input.result.httpStatus > 599)) {
        throw new Error('delivery httpStatus must be an integer between 100 and 599')
      }
      const nextAttemptAt = input.result.nextAttemptAt == null ? null : utcTimestampSchema.parse(input.result.nextAttemptAt)
      if (input.result.outcome === 'sent' && nextAttemptAt) throw new Error('sent delivery cannot schedule another attempt')
      if (nextAttemptAt && Date.parse(nextAttemptAt) < Date.parse(completedAt)) throw new Error('next delivery attempt cannot precede completion')

      return db.transaction(async (tx) => {
        const row = (await tx.select({ notification: notifications, anchorCase: anchorCases, discrepancy: discrepancies })
          .from(notifications)
          .innerJoin(anchorCases, eq(anchorCases.id, notifications.caseId))
          .innerJoin(discrepancies, eq(discrepancies.id, anchorCases.discrepancyId))
          .where(eq(notifications.id, input.notificationId))
          .for('update')
          .limit(1))[0]
        if (!row) throw new Error('notification does not exist or is not linked to a discrepancy case')
        if (row.notification.status === 'sent') {
          return { status: 'already_sent' as const, caseId: row.anchorCase.id, sentAt: row.notification.sentAt }
        }
        if (input.workerId !== undefined || input.leaseToken !== undefined) {
          if (row.notification.leaseOwner !== input.workerId || row.notification.leaseToken !== input.leaseToken) {
            throw new Error('notification delivery lease is no longer owned by this worker')
          }
        }
        const attemptNumber = row.notification.attemptCount + 1
        const attemptId = durableId('notification_attempt', input.notificationId, String(attemptNumber))
        const inserted = await tx.insert(notificationDeliveryAttempts).values({
          id: attemptId,
          notificationId: input.notificationId,
          attemptNumber,
          outcome: input.result.outcome,
          startedAt,
          completedAt,
          httpStatus: input.result.httpStatus ?? null,
          failure: input.result.failure ?? null,
          responseSha256: input.result.responseBody ? createHash('sha256').update(input.result.responseBody).digest('hex') : null,
        }).onConflictDoNothing({ target: [notificationDeliveryAttempts.notificationId, notificationDeliveryAttempts.attemptNumber] })
          .returning({ id: notificationDeliveryAttempts.id })
        if (!inserted[0]) return { status: 'duplicate' as const, attemptId }

        if (input.result.outcome === 'failed') {
          await tx.update(notifications).set({
            status: 'failed',
            attemptCount: attemptNumber,
            nextAttemptAt,
            failure: input.result.failure,
            leaseOwner: null,
            leaseExpiresAt: null,
          }).where(eq(notifications.id, input.notificationId))
          await tx.insert(anchorCaseEvents).values({
            id: durableId('anchor_case_event', row.anchorCase.id, 'notice_failed', attemptId),
            caseId: row.anchorCase.id,
            eventType: 'notice_failed',
            actorType: 'system',
            actorId: null,
            payload: { notificationId: input.notificationId, attemptId, failure: input.result.failure },
            occurredAt: completedAt,
          })
          return { status: 'failed' as const, attemptId, caseId: row.anchorCase.id }
        }

        await tx.update(notifications).set({ status: 'sent', attemptCount: attemptNumber, nextAttemptAt: null, sentAt: completedAt, failure: null, leaseOwner: null, leaseExpiresAt: null })
          .where(eq(notifications.id, input.notificationId))
        const state = stateFromRow(row.discrepancy)
        let replyDeadline = row.anchorCase.replyDueAt ? new Date(row.anchorCase.replyDueAt).toISOString() : null
        if (state.publicationState === 'internal') {
          const transition = transitionDiscrepancyPublication({
            state,
            action: {
              type: 'begin_reply',
              eventId: durableId('discrepancy_event', row.discrepancy.id, 'begin_reply', input.notificationId),
              notificationId: input.notificationId,
              occurredAt: completedAt,
            },
          })
          replyDeadline = replyDueAt(completedAt)
          await tx.update(discrepancies).set({
            publicationState: transition.state.publicationState,
            replyReviewState: transition.state.replyReviewState,
            publicationUpdatedAt: transition.state.publicationUpdatedAt,
          }).where(and(eq(discrepancies.id, row.discrepancy.id), eq(discrepancies.publicationState, 'internal')))
          await tx.update(anchorCases).set({ status: 'awaiting_reply', replyDueAt: replyDeadline, updatedAt: completedAt })
            .where(eq(anchorCases.id, row.anchorCase.id))
          await tx.insert(discrepancyEvents).values(publicationEventRow(transition.event))
        }
        await tx.insert(anchorCaseEvents).values({
          id: durableId('anchor_case_event', row.anchorCase.id, 'notice_delivered', attemptId),
          caseId: row.anchorCase.id,
          eventType: 'notice_delivered',
          actorType: 'system',
          actorId: null,
          payload: { notificationId: input.notificationId, attemptId },
          occurredAt: completedAt,
        })
        return { status: 'sent' as const, attemptId, caseId: row.anchorCase.id, replyDueAt: replyDeadline }
      })
    },

    async requeueFailedNotification(input: { notificationId: string; administratorPrincipalId: string; reason: string; requeuedAt: string }) {
      const requeuedAt = utcTimestampSchema.parse(input.requeuedAt)
      const reason = input.reason.trim()
      if (!reason || reason.length > 4_000) throw new Error('notification requeue reason must contain 1 to 4000 characters')
      return db.transaction(async (tx) => {
        const administrator = (await tx.select({ id: apiPrincipals.id }).from(apiPrincipals)
          .innerJoin(apiPrincipalScopes, eq(apiPrincipalScopes.principalId, apiPrincipals.id))
          .where(and(
            eq(apiPrincipals.id, input.administratorPrincipalId),
            eq(apiPrincipals.status, 'active'),
            eq(apiPrincipalScopes.scopeId, 'anchor:review'),
          )).limit(1))[0]
        if (!administrator) throw new Error('administrator principal is not active or lacks anchor:review scope')
        const row = (await tx.select({ notification: notifications, anchorCase: anchorCases }).from(notifications)
          .innerJoin(anchorCases, eq(anchorCases.id, notifications.caseId))
          .where(eq(notifications.id, input.notificationId)).for('update').limit(1))[0]
        if (!row || row.notification.status !== 'failed' || row.notification.nextAttemptAt !== null || row.notification.leaseOwner !== null) {
          throw new Error('notification is not a terminal unleased failure')
        }
        await tx.update(notifications).set({ nextAttemptAt: requeuedAt, failure: null }).where(eq(notifications.id, row.notification.id))
        await tx.insert(anchorCaseEvents).values({
          id: durableId('anchor_case_event', row.anchorCase.id, 'notice_requeued', row.notification.id, requeuedAt),
          caseId: row.anchorCase.id,
          eventType: 'notice_requeued',
          actorType: 'administrator',
          actorId: administrator.id,
          payload: { notificationId: row.notification.id, priorAttemptCount: row.notification.attemptCount, reason },
          occurredAt: requeuedAt,
        })
        return { notificationId: row.notification.id, caseId: row.anchorCase.id, nextAttemptAt: requeuedAt }
      })
    },

    async expireDueReplyWindows(input: { now: string; limit?: number }) {
      const now = utcTimestampSchema.parse(input.now)
      const limit = input.limit ?? 25
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) throw new Error('reply expiry limit must be between 1 and 100')
      return db.transaction(async (tx) => {
        const due = await tx.select({ anchorCase: anchorCases, discrepancy: discrepancies }).from(anchorCases)
          .innerJoin(discrepancies, eq(discrepancies.id, anchorCases.discrepancyId))
          .where(and(
            eq(anchorCases.status, 'awaiting_reply'),
            lte(anchorCases.replyDueAt, now),
            eq(discrepancies.publicationState, 'pending_reply'),
            eq(discrepancies.replyReviewState, 'awaiting_reply'),
          )).orderBy(asc(anchorCases.replyDueAt), asc(anchorCases.id)).for('update', { skipLocked: true }).limit(limit)
        const expired: string[] = []
        for (const row of due) {
          const transition = transitionDiscrepancyPublication({
            state: stateFromRow(row.discrepancy),
            action: { type: 'expire_reply_window', eventId: durableId('discrepancy_event', row.discrepancy.id, 'reply_expired'), occurredAt: now },
          })
          await tx.update(discrepancies).set({
            publicationState: transition.state.publicationState,
            replyReviewState: transition.state.replyReviewState,
            publicationUpdatedAt: transition.state.publicationUpdatedAt,
          }).where(eq(discrepancies.id, row.discrepancy.id))
          await tx.update(anchorCases).set({ status: 'under_review', updatedAt: now }).where(eq(anchorCases.id, row.anchorCase.id))
          await tx.insert(discrepancyEvents).values(publicationEventRow(transition.event))
          await tx.insert(anchorCaseEvents).values({
            id: durableId('anchor_case_event', row.anchorCase.id, 'reply_window_expired'),
            caseId: row.anchorCase.id,
            eventType: 'reply_window_expired',
            actorType: 'system',
            actorId: null,
            payload: { replyDueAt: canonicalTimestamp(row.anchorCase.replyDueAt!) },
            occurredAt: now,
          })
          expired.push(row.anchorCase.id)
        }
        return expired
      })
    },

    async reviewCase(input: { caseId: string; reviewerPrincipalId: string; decision: 'approve_public' | 'withhold'; notes?: string; reviewedAt: string; allowNamedPartyPublication?: boolean }) {
      const reviewedAt = utcTimestampSchema.parse(input.reviewedAt)
      if (input.decision === 'approve_public' && input.allowNamedPartyPublication !== true) {
        throw new Error('named-party publication is disabled pending explicit product/legal enablement')
      }
      const notes = input.notes?.trim() || null
      if (notes && notes.length > 4_000) throw new Error('review notes must not exceed 4000 characters')
      return db.transaction(async (tx) => {
        const reviewer = (await tx.select({ id: apiPrincipals.id }).from(apiPrincipals)
          .innerJoin(apiPrincipalScopes, eq(apiPrincipalScopes.principalId, apiPrincipals.id))
          .where(and(
            eq(apiPrincipals.id, input.reviewerPrincipalId),
            eq(apiPrincipals.status, 'active'),
            eq(apiPrincipalScopes.scopeId, 'anchor:review'),
          )).limit(1))[0]
        if (!reviewer) throw new Error('reviewer principal is not active or lacks anchor:review scope')
        const row = (await tx.select({ anchorCase: anchorCases, discrepancy: discrepancies }).from(anchorCases)
          .innerJoin(discrepancies, eq(discrepancies.id, anchorCases.discrepancyId))
          .where(eq(anchorCases.id, input.caseId)).for('update').limit(1))[0]
        if (!row || !['awaiting_reply', 'under_review'].includes(row.anchorCase.status)) throw new Error('anchor case is not reviewable')
        const latestReply = (await tx.select({ id: anchorReplies.id }).from(anchorReplies)
          .where(eq(anchorReplies.caseId, row.anchorCase.id)).orderBy(sql`${anchorReplies.version} DESC`).limit(1))[0]
        let reviewableState = stateFromRow(row.discrepancy)
        if (reviewableState.replyReviewState === 'response_received') {
          const responseReview = transitionDiscrepancyPublication({
            state: reviewableState,
            action: { type: 'review_response', eventId: durableId('discrepancy_event', row.discrepancy.id, 'review_response', reviewedAt), occurredAt: reviewedAt, reviewerId: reviewer.id },
          })
          reviewableState = responseReview.state
          await tx.insert(discrepancyEvents).values(publicationEventRow(responseReview.event))
        }
        const transition = transitionDiscrepancyPublication({
          state: reviewableState,
          action: input.decision === 'approve_public'
            ? { type: 'approve', eventId: durableId('discrepancy_event', row.discrepancy.id, 'approve', reviewedAt), occurredAt: reviewedAt, reviewerId: reviewer.id }
            : { type: 'withhold', eventId: durableId('discrepancy_event', row.discrepancy.id, 'withhold', reviewedAt), occurredAt: reviewedAt, reviewerId: reviewer.id },
        })
        const reviewId = durableId('anchor_review', row.anchorCase.id, reviewedAt, input.decision)
        await tx.insert(anchorReviews).values({
          id: reviewId,
          caseId: row.anchorCase.id,
          replyId: latestReply?.id ?? null,
          reviewerPrincipalId: reviewer.id,
          decision: input.decision,
          notes,
          reviewedAt,
        })
        await tx.update(discrepancies).set({
          publicationState: transition.state.publicationState,
          replyReviewState: transition.state.replyReviewState,
          publicationUpdatedAt: transition.state.publicationUpdatedAt,
        }).where(eq(discrepancies.id, row.discrepancy.id))
        await tx.update(anchorCases).set({ status: 'resolved', updatedAt: reviewedAt }).where(eq(anchorCases.id, row.anchorCase.id))
        await tx.insert(discrepancyEvents).values(publicationEventRow(transition.event))
        await tx.insert(anchorCaseEvents).values({
          id: durableId('anchor_case_event', row.anchorCase.id, 'reviewed', reviewId),
          caseId: row.anchorCase.id,
          eventType: 'reviewed',
          actorType: 'reviewer',
          actorId: reviewer.id,
          payload: { reviewId, decision: input.decision },
          occurredAt: reviewedAt,
        })
        return { caseId: row.anchorCase.id, reviewId, publicationState: transition.state.publicationState }
      })
    },

    async listReviewQueue() {
      return db.select({
        caseId: anchorCases.id,
        anchorId: anchorCases.anchorId,
        discrepancyId: anchorCases.discrepancyId,
        caseStatus: anchorCases.status,
        replyDueAt: anchorCases.replyDueAt,
        severity: discrepancies.severity,
        methodologyVersion: discrepancies.methodologyVersion,
        firstObservedAt: discrepancies.firstObservedAt,
        lastObservedAt: discrepancies.lastObservedAt,
        publicationState: discrepancies.publicationState,
        replyReviewState: discrepancies.replyReviewState,
      }).from(anchorCases)
        .innerJoin(discrepancies, eq(discrepancies.id, anchorCases.discrepancyId))
        .where(inArray(anchorCases.status, ['awaiting_reply', 'under_review']))
        .orderBy(asc(anchorCases.replyDueAt), asc(anchorCases.id))
    },

    async getReviewEvidence(caseId: string) {
      const anchorCase = (await db.select().from(anchorCases).where(eq(anchorCases.id, caseId)).limit(1))[0]
      if (!anchorCase?.discrepancyId) return null
      const discrepancy = (await db.select().from(discrepancies).where(eq(discrepancies.id, anchorCase.discrepancyId)).limit(1))[0]
      if (!discrepancy) return null
      const [caseHistory, discrepancyHistory, evidence] = await Promise.all([
        db.select().from(anchorCaseEvents).where(eq(anchorCaseEvents.caseId, caseId)).orderBy(asc(anchorCaseEvents.occurredAt), asc(anchorCaseEvents.id)),
        db.select().from(discrepancyEvents).where(eq(discrepancyEvents.discrepancyId, discrepancy.id)).orderBy(asc(discrepancyEvents.occurredAt), asc(discrepancyEvents.id)),
        db.select({ id: rawReadings.id, rawPayload: rawReadings.rawPayload, payloadSha256: rawReadings.payloadSha256, sourceTimestamp: rawReadings.sourceTimestamp, retrievedAt: rawReadings.retrievedAt })
          .from(rawReadings).where(and(
            eq(rawReadings.sourceId, discrepancy.sourceId),
            eq(rawReadings.metric, discrepancy.metric),
            eq(rawReadings.subjectKey, discrepancy.subjectKey),
          )).orderBy(asc(rawReadings.retrievedAt)),
      ])
      return { anchorCase, discrepancy: stateFromRow(discrepancy), caseHistory, discrepancyHistory, evidence }
    },
  }
}

export type AnchorCaseRepository = ReturnType<typeof createAnchorCaseRepository>
