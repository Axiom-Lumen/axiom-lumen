import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'
import type { DatabaseClient } from './client'
import {
  anchorCases,
  anchorDisputes,
  anchorEvidence,
  anchorReplies,
  anchorReviews,
  anchors,
  corrections,
  discrepancies,
  discrepancyEvents,
} from './schema'

/**
 * Returns only publication-approved named-party material and immutable corrections.
 * Upload bytes/storage references, claimant/session identities, reviewer notes, and
 * non-clean evidence are never selected into this model.
 */
export async function queryPublicAnchorFlag(client: DatabaseClient, flagId: string) {
  const flag = (await client.db.select({
    id: discrepancies.id,
    anchorName: anchors.name,
    severity: discrepancies.severity,
    lifecycleState: discrepancies.lifecycleState,
    publicationState: discrepancies.publicationState,
    methodologyVersion: discrepancies.methodologyVersion,
    firstObservedAt: discrepancies.firstObservedAt,
    lastObservedAt: discrepancies.lastObservedAt,
    caseId: anchorCases.id,
  }).from(discrepancies)
    .innerJoin(anchorCases, eq(anchorCases.discrepancyId, discrepancies.id))
    .innerJoin(anchors, eq(anchors.id, anchorCases.anchorId))
    .where(eq(discrepancies.id, flagId)).limit(1))[0]
  if (!flag) return null

  // Correction events link correctionId in payload rather than sharing IDs.
  const allCorrectionEvents = await client.db.select({ id: discrepancyEvents.id, eventType: discrepancyEvents.eventType, payload: discrepancyEvents.payload, occurredAt: discrepancyEvents.occurredAt })
    .from(discrepancyEvents).where(and(eq(discrepancyEvents.discrepancyId, flag.id), inArray(discrepancyEvents.eventType, ['corrected', 'retracted'])))
    .orderBy(asc(discrepancyEvents.occurredAt), asc(discrepancyEvents.id))
  const correctionIds = allCorrectionEvents.flatMap((event) => typeof event.payload.correctionId === 'string' ? [event.payload.correctionId] : [])
  const correctionDetails = correctionIds.length === 0 ? [] : await client.db.select({ id: corrections.id, targetEventId: corrections.targetEventId, reason: corrections.reason, replacement: corrections.replacement })
    .from(corrections).where(inArray(corrections.id, correctionIds))
  const correctionById = new Map(correctionDetails.map((item) => [item.id, item]))
  const correctionCandidates = allCorrectionEvents.flatMap((event) => {
    const correctionId = typeof event.payload.correctionId === 'string' ? event.payload.correctionId : ''
    const detail = correctionById.get(correctionId)
    return detail ? [{ ...detail, type: event.eventType as 'corrected' | 'retracted', occurredAt: new Date(event.occurredAt).toISOString() }] : []
  })
  const approvedReview = (await client.db.select({ replyId: anchorReviews.replyId, reviewedAt: anchorReviews.reviewedAt })
    .from(anchorReviews).where(and(eq(anchorReviews.caseId, flag.caseId), eq(anchorReviews.decision, 'approve_public')))
    .orderBy(desc(anchorReviews.reviewedAt)).limit(1))[0]
  const publicCorrections = approvedReview ? correctionCandidates.filter(
    (correction) => Date.parse(correction.occurredAt) >= Date.parse(approvedReview.reviewedAt),
  ) : []
  if (flag.publicationState !== 'approved_public' && (!approvedReview || publicCorrections.length === 0)) return null
  const reply = approvedReview?.replyId ? (await client.db.select({ id: anchorReplies.id, body: anchorReplies.body, version: anchorReplies.version, submittedAt: anchorReplies.submittedAt })
    .from(anchorReplies).where(eq(anchorReplies.id, approvedReview.replyId)).limit(1))[0] : null
  const evidence = reply ? await client.db.select({ id: anchorEvidence.id, kind: anchorEvidence.kind, url: anchorEvidence.url, contentType: anchorEvidence.contentType, byteSize: anchorEvidence.byteSize, sha256: anchorEvidence.sha256 })
    .from(anchorEvidence).where(and(
      eq(anchorEvidence.replyId, reply.id),
      or(eq(anchorEvidence.kind, 'link'), and(eq(anchorEvidence.kind, 'upload'), eq(anchorEvidence.scanStatus, 'clean'))),
    )).orderBy(asc(anchorEvidence.id)) : []
  const disputes = await client.db.select({ id: anchorDisputes.id, body: anchorDisputes.body, status: anchorDisputes.status, submittedAt: anchorDisputes.submittedAt, resolvedAt: anchorDisputes.resolvedAt })
    .from(anchorDisputes).where(and(
      eq(anchorDisputes.flagId, flag.id),
      eq(anchorDisputes.publicationState, 'approved_public'),
      inArray(anchorDisputes.status, ['resolved', 'rejected']),
    ))
    .orderBy(asc(anchorDisputes.submittedAt), asc(anchorDisputes.id))

  return {
    flagId: flag.id,
    anchor: flag.anchorName,
    severity: flag.severity,
    lifecycleState: flag.lifecycleState,
    publicationState: flag.publicationState,
    methodologyVersion: flag.methodologyVersion,
    firstObservedAt: new Date(flag.firstObservedAt).toISOString(),
    lastObservedAt: new Date(flag.lastObservedAt).toISOString(),
    response: reply ? {
      body: reply.body,
      version: reply.version,
      submittedAt: new Date(reply.submittedAt).toISOString(),
      reviewedAt: new Date(approvedReview!.reviewedAt).toISOString(),
      evidence: evidence.map((item) => item.kind === 'link'
        ? { id: item.id, kind: 'link' as const, url: item.url! }
        : { id: item.id, kind: 'upload' as const, contentType: item.contentType!, byteSize: item.byteSize!, sha256: item.sha256! }),
    } : null,
    disputes: disputes.map((item) => ({ ...item, submittedAt: new Date(item.submittedAt).toISOString(), resolvedAt: item.resolvedAt ? new Date(item.resolvedAt).toISOString() : null })),
    corrections: publicCorrections,
  }
}

export type PublicAnchorFlag = NonNullable<Awaited<ReturnType<typeof queryPublicAnchorFlag>>>
