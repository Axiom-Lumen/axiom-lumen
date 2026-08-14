import { and, asc, desc, eq, gt, inArray, isNotNull, lt, or } from 'drizzle-orm'
import { z } from 'zod'
import { anchorReservesObservationSchema, identifierSchema, utcTimestampSchema } from '../contracts/domain'
import { absoluteDelta, parseStellarAmount, relativeDelta } from '../stellar/amount'
import type { DatabaseClient } from './client'
import {
  anchorCases,
  anchorCaseEvents,
  anchorDisputes,
  anchorEvidence,
  anchorReplies,
  anchorReviews,
  anchors,
  corrections,
  discrepancies,
  discrepancyEvents,
  rawReadings,
  reconciliationSnapshots,
} from './schema'

const PUBLIC_ANCHOR_PAGE_SIZE = 25
const PUBLIC_ANCHOR_MAXIMUM_PAGE_SIZE = 100

export class InvalidAnchorReserveCursorError extends Error {
  constructor() {
    super('anchor reserve cursor is invalid')
    this.name = 'InvalidAnchorReserveCursorError'
  }
}

const cursorSchema = z.object({ reviewedAt: utcTimestampSchema, flagId: identifierSchema }).strict()
const measurementStateSchema = z.object({
  severity: z.enum(['warning', 'critical']),
  lifecycleState: z.literal('open'),
}).passthrough()
const approvalEventSchema = z.object({
  action: z.literal('approve'),
  reviewerId: identifierSchema,
  after: z.object({ publicationState: z.literal('approved_public') }).passthrough(),
}).passthrough()
const caseOpenedEventSchema = z.object({ triggeringEventId: identifierSchema }).passthrough()
const storedAnchorReadingSchema = z.object({
  observation: anchorReservesObservationSchema,
  supplyReference: z.object({
    snapshotId: identifierSchema,
    cycleId: identifierSchema,
    amount: z.string(),
    asOf: utcTimestampSchema,
    ledgerSequence: z.number().int().safe().positive(),
    ledgerClosedAt: utcTimestampSchema,
    status: z.enum(['verified', 'degraded']),
    confidence: z.number().min(0).max(1),
    methodologyVersion: z.string().min(1).max(100),
  }).passthrough(),
}).passthrough()
const storedAmountValueSchema = z.object({ kind: z.literal('amount'), value: z.string() }).strict()

function encodeCursor(reviewedAt: string, flagId: string) {
  return Buffer.from(JSON.stringify({ reviewedAt, flagId })).toString('base64url')
}

function decodeCursor(cursor?: string) {
  if (!cursor) return null
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
  } catch {
    throw new InvalidAnchorReserveCursorError()
  }
}

function deltaBasisPoints(observed: ReturnType<typeof anchorReservesObservationSchema.parse>['amount'], reference: ReturnType<typeof anchorReservesObservationSchema.parse>['amount']) {
  const delta = relativeDelta(observed, reference)
  if (!delta) return observed.isZero() ? 0 : 10_000
  const scaled = delta.numerator * 100_000_000n / delta.denominator
  return Number(scaled > 100_000_000n ? 100_000_000n : scaled) / 10_000
}

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
  const targetEventIds = correctionDetails.map((item) => item.targetEventId)
  const correctionTargets = targetEventIds.length === 0 ? [] : await client.db.select({ id: discrepancyEvents.id, occurredAt: discrepancyEvents.occurredAt })
    .from(discrepancyEvents).where(inArray(discrepancyEvents.id, targetEventIds))
  const correctionTargetAt = new Map(correctionTargets.map((item) => [item.id, new Date(item.occurredAt).toISOString()]))
  const correctionById = new Map(correctionDetails.map((item) => [item.id, item]))
  const correctionCandidates = allCorrectionEvents.flatMap((event) => {
    const correctionId = typeof event.payload.correctionId === 'string' ? event.payload.correctionId : ''
    const detail = correctionById.get(correctionId)
    return detail ? [{ ...detail, type: event.eventType as 'corrected' | 'retracted', occurredAt: new Date(event.occurredAt).toISOString() }] : []
  })
  const approvedReview = (await client.db.select({ replyId: anchorReviews.replyId, reviewedAt: anchorReviews.reviewedAt, reviewerPrincipalId: anchorReviews.reviewerPrincipalId })
    .from(anchorReviews).where(and(eq(anchorReviews.caseId, flag.caseId), eq(anchorReviews.decision, 'approve_public')))
    .orderBy(desc(anchorReviews.reviewedAt)).limit(1))[0]
  const publicCorrections = approvedReview ? correctionCandidates.filter(
    (correction) => Date.parse(correction.occurredAt) >= Date.parse(approvedReview.reviewedAt) &&
      Date.parse(correctionTargetAt.get(correction.targetEventId) ?? '') <= Date.parse(approvedReview.reviewedAt),
  ) : []
  const approvalEvents = approvedReview ? await client.db.select({ payload: discrepancyEvents.payload })
    .from(discrepancyEvents).where(and(
      eq(discrepancyEvents.discrepancyId, flag.id),
      eq(discrepancyEvents.eventType, 'publication_changed'),
      eq(discrepancyEvents.occurredAt, approvedReview.reviewedAt),
    )) : []
  const parsedApproval = approvalEvents.map((event) => approvalEventSchema.safeParse(event.payload))
    .find((event) => event.success && event.data.reviewerId === approvedReview?.reviewerPrincipalId)
  // Mutable publication state is never sufficient authorization. The durable
  // approve_public review is the public boundary and remains auditable after
  // later internal recurrences or an anchor-status change.
  if (!approvedReview || !parsedApproval?.success) return null
  const publicPublicationState = publicCorrections.some((correction) => correction.type === 'retracted')
    ? 'withheld' as const
    : 'approved_public' as const
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
    publicationState: publicPublicationState,
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

/**
 * Anchor-scoped public collection. Anchor existence is intentionally separate
 * from disclosure existence: a verified anchor with no approved flags returns
 * an empty collection without revealing whether internal cases exist.
 */
export async function queryPublicAnchorReserves(
  client: DatabaseClient,
  anchorId: string,
  options: { cursor?: string; limit?: number } = {},
) {
  const limit = options.limit ?? PUBLIC_ANCHOR_PAGE_SIZE
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PUBLIC_ANCHOR_MAXIMUM_PAGE_SIZE) {
    throw new Error(`anchor reserve limit must be from 1 through ${PUBLIC_ANCHOR_MAXIMUM_PAGE_SIZE}`)
  }
  const cursor = decodeCursor(options.cursor)
  const anchor = (await client.db.select({
    id: anchors.id,
    name: anchors.name,
    networkId: anchors.networkId,
    stellarAccount: anchors.stellarAccount,
    status: anchors.status,
    updatedAt: anchors.updatedAt,
  }).from(anchors).where(eq(anchors.id, anchorId)).limit(1))[0]
  if (!anchor) return null

  const cursorCondition = cursor ? or(
    lt(anchorReviews.reviewedAt, cursor.reviewedAt),
    and(eq(anchorReviews.reviewedAt, cursor.reviewedAt), gt(discrepancies.id, cursor.flagId)),
  ) : undefined
  const candidates = await client.db.select({
    caseId: anchorCases.id,
    flagId: discrepancies.id,
    sourceId: discrepancies.sourceId,
    reviewedAt: anchorReviews.reviewedAt,
    reviewerPrincipalId: anchorReviews.reviewerPrincipalId,
    replyId: anchorReviews.replyId,
    methodologyVersion: discrepancies.methodologyVersion,
  }).from(anchorReviews)
    .innerJoin(anchorCases, eq(anchorCases.id, anchorReviews.caseId))
    .innerJoin(discrepancies, eq(discrepancies.id, anchorCases.discrepancyId))
    .where(and(
      eq(anchorCases.anchorId, anchor.id),
      eq(anchorReviews.decision, 'approve_public'),
      eq(discrepancies.metric, 'anchor_reserves'),
      cursorCondition,
    ))
    .orderBy(desc(anchorReviews.reviewedAt), asc(discrepancies.id))
    .limit(limit + 1)

  if (anchor.status !== 'verified') {
    const historicalApproval = (await client.db.select({ id: anchorReviews.id }).from(anchorReviews)
      .innerJoin(anchorCases, eq(anchorCases.id, anchorReviews.caseId))
      .innerJoin(discrepancies, eq(discrepancies.id, anchorCases.discrepancyId))
      .where(and(
        eq(anchorCases.anchorId, anchor.id),
        eq(anchorReviews.decision, 'approve_public'),
        eq(discrepancies.metric, 'anchor_reserves'),
      )).limit(1))[0]
    if (!historicalApproval) return null
  }
  const pageCandidates = candidates.slice(0, limit)
  const flagIds = pageCandidates.map((item) => item.flagId)
  const caseEvents = pageCandidates.length === 0 ? [] : await client.db.select({ caseId: anchorCaseEvents.caseId, payload: anchorCaseEvents.payload })
    .from(anchorCaseEvents).where(and(
      inArray(anchorCaseEvents.caseId, pageCandidates.map((item) => item.caseId)),
      eq(anchorCaseEvents.eventType, 'opened'),
    ))
  const approvalEvents = flagIds.length === 0 ? [] : await client.db.select({ discrepancyId: discrepancyEvents.discrepancyId, payload: discrepancyEvents.payload, occurredAt: discrepancyEvents.occurredAt })
    .from(discrepancyEvents).where(and(eq(discrepancyEvents.eventType, 'publication_changed'), inArray(discrepancyEvents.discrepancyId, flagIds)))
  const measurementEvents = flagIds.length === 0 ? [] : await client.db.select({ id: discrepancyEvents.id, discrepancyId: discrepancyEvents.discrepancyId, eventType: discrepancyEvents.eventType, cycleId: discrepancyEvents.cycleId, payload: discrepancyEvents.payload, occurredAt: discrepancyEvents.occurredAt })
    .from(discrepancyEvents).where(and(
      inArray(discrepancyEvents.discrepancyId, flagIds),
      inArray(discrepancyEvents.eventType, ['opened', 'observed', 'escalated']),
      isNotNull(discrepancyEvents.cycleId),
    )).orderBy(desc(discrepancyEvents.occurredAt), desc(discrepancyEvents.id))
  const reviewedMeasurementByFlag = new Map(pageCandidates.map((candidate) => {
    const caseEvent = caseEvents.find((item) => item.caseId === candidate.caseId)
    const triggeringEventId = caseEvent ? caseOpenedEventSchema.parse(caseEvent.payload).triggeringEventId : null
    const event = measurementEvents.find((item) => item.id === triggeringEventId && item.discrepancyId === candidate.flagId)
    if (!event?.cycleId || Date.parse(event.occurredAt) > Date.parse(candidate.reviewedAt)) {
      throw new Error(`approved anchor flag ${candidate.flagId} has no valid case-triggering measurement event`)
    }
    return [candidate.flagId, event] as const
  }))
  const cycleIds = [...new Set([...reviewedMeasurementByFlag.values()].map((item) => item.cycleId!))]
  const [readingRows, snapshotRows, correctionEventRows, disputeRows, replyRows] = await Promise.all([
    cycleIds.length === 0 ? [] : client.db.select({ cycleId: rawReadings.cycleId, sourceId: rawReadings.sourceId, rawPayload: rawReadings.rawPayload }).from(rawReadings)
      .where(and(inArray(rawReadings.cycleId, cycleIds), eq(rawReadings.metric, 'anchor_reserves'))),
    cycleIds.length === 0 ? [] : client.db.select({ cycleId: reconciliationSnapshots.cycleId, status: reconciliationSnapshots.status, value: reconciliationSnapshots.value, confidence: reconciliationSnapshots.confidence, confidenceFormulaVersion: reconciliationSnapshots.confidenceFormulaVersion, confidenceComponents: reconciliationSnapshots.confidenceComponents, confidenceCapsApplied: reconciliationSnapshots.confidenceCapsApplied, asOf: reconciliationSnapshots.asOf, methodologyVersion: reconciliationSnapshots.methodologyVersion }).from(reconciliationSnapshots)
      .where(and(inArray(reconciliationSnapshots.cycleId, cycleIds), eq(reconciliationSnapshots.metric, 'anchor_reserves'))),
    flagIds.length === 0 ? [] : client.db.select({ discrepancyId: discrepancyEvents.discrepancyId, eventType: discrepancyEvents.eventType, payload: discrepancyEvents.payload, occurredAt: discrepancyEvents.occurredAt }).from(discrepancyEvents)
      .where(and(inArray(discrepancyEvents.discrepancyId, flagIds), inArray(discrepancyEvents.eventType, ['corrected', 'retracted']))).orderBy(asc(discrepancyEvents.occurredAt), asc(discrepancyEvents.id)),
    flagIds.length === 0 ? [] : client.db.select({ id: anchorDisputes.id, flagId: anchorDisputes.flagId, body: anchorDisputes.body, status: anchorDisputes.status, submittedAt: anchorDisputes.submittedAt, resolvedAt: anchorDisputes.resolvedAt }).from(anchorDisputes)
      .where(and(inArray(anchorDisputes.flagId, flagIds), eq(anchorDisputes.publicationState, 'approved_public'), inArray(anchorDisputes.status, ['resolved', 'rejected']))).orderBy(asc(anchorDisputes.submittedAt), asc(anchorDisputes.id)),
    pageCandidates.some((item) => item.replyId) ? client.db.select({ id: anchorReplies.id, body: anchorReplies.body, version: anchorReplies.version, submittedAt: anchorReplies.submittedAt }).from(anchorReplies)
      .where(inArray(anchorReplies.id, pageCandidates.flatMap((item) => item.replyId ? [item.replyId] : []))) : [],
  ])
  const correctionIds = correctionEventRows.flatMap((event) => typeof event.payload.correctionId === 'string' ? [event.payload.correctionId] : [])
  const correctionRows = correctionIds.length === 0 ? [] : await client.db.select({ id: corrections.id, targetEventId: corrections.targetEventId, reason: corrections.reason, replacement: corrections.replacement }).from(corrections).where(inArray(corrections.id, correctionIds))
  const correctionTargets = correctionRows.length === 0 ? [] : await client.db.select({ id: discrepancyEvents.id, occurredAt: discrepancyEvents.occurredAt }).from(discrepancyEvents).where(inArray(discrepancyEvents.id, correctionRows.map((item) => item.targetEventId)))
  const evidenceRows = replyRows.length === 0 && disputeRows.length === 0 ? [] : await client.db.select({ id: anchorEvidence.id, replyId: anchorEvidence.replyId, disputeId: anchorEvidence.disputeId, kind: anchorEvidence.kind, url: anchorEvidence.url, contentType: anchorEvidence.contentType, byteSize: anchorEvidence.byteSize, sha256: anchorEvidence.sha256 })
    .from(anchorEvidence).where(and(
      or(
        replyRows.length === 0 ? undefined : inArray(anchorEvidence.replyId, replyRows.map((item) => item.id)),
        disputeRows.length === 0 ? undefined : inArray(anchorEvidence.disputeId, disputeRows.map((item) => item.id)),
      ),
      or(eq(anchorEvidence.kind, 'link'), and(eq(anchorEvidence.kind, 'upload'), eq(anchorEvidence.scanStatus, 'clean'))),
    )).orderBy(asc(anchorEvidence.id))
  const correctionById = new Map(correctionRows.map((item) => [item.id, item]))
  const correctionTargetAt = new Map(correctionTargets.map((item) => [item.id, new Date(item.occurredAt).toISOString()]))
  const evidenceFor = (parent: { replyId?: string | null; disputeId?: string | null }) => evidenceRows.filter((item) =>
    (parent.replyId && item.replyId === parent.replyId) || (parent.disputeId && item.disputeId === parent.disputeId),
  ).map((item) => item.kind === 'link'
    ? { id: item.id, kind: 'link' as const, url: item.url! }
    : { id: item.id, kind: 'upload' as const, contentType: item.contentType!, byteSize: item.byteSize!, sha256: item.sha256! })

  const disclosures = pageCandidates.map((candidate) => {
    const reviewedAt = new Date(candidate.reviewedAt).toISOString()
    const approved = approvalEvents.map((event) => ({ event, parsed: approvalEventSchema.safeParse(event.payload) }))
      .find(({ event, parsed }) => event.discrepancyId === candidate.flagId && Date.parse(event.occurredAt) === Date.parse(candidate.reviewedAt) && parsed.success && parsed.data.reviewerId === candidate.reviewerPrincipalId)
    if (!approved) throw new Error(`approved anchor flag ${candidate.flagId} has no matching publication event`)
    const measurement = reviewedMeasurementByFlag.get(candidate.flagId)!
    const approvedState = measurementStateSchema.parse(measurement.payload.after)
    const episodeStart = measurementEvents.find((item) => item.discrepancyId === candidate.flagId && item.eventType === 'opened' && Date.parse(item.occurredAt) <= Date.parse(measurement.occurredAt))
    if (!episodeStart) throw new Error(`approved anchor flag ${candidate.flagId} has no opening measurement event`)
    const reading = readingRows.find((item) => item.cycleId === measurement.cycleId && item.sourceId === candidate.sourceId)
    if (!reading) throw new Error(`approved anchor flag ${candidate.flagId} has no exact reserve evidence`)
    const stored = storedAnchorReadingSchema.parse(reading.rawPayload)
    const observation = stored.observation
    if (observation.anchorId !== anchor.id || observation.cycleId !== measurement.cycleId || observation.provenance.source.id !== candidate.sourceId || observation.provenance.source.network.id !== anchor.networkId) {
      throw new Error(`approved anchor flag ${candidate.flagId} evidence identity does not match`)
    }
    const snapshot = snapshotRows.find((item) => item.cycleId === measurement.cycleId)
    if (!snapshot || snapshot.status === 'unavailable' || snapshot.methodologyVersion !== candidate.methodologyVersion) throw new Error(`approved anchor flag ${candidate.flagId} snapshot does not match its methodology`)
    const snapshotValue = storedAmountValueSchema.parse(snapshot.value)
    if (!observation.amount.equals(parseStellarAmount(snapshotValue.value))) throw new Error(`approved anchor flag ${candidate.flagId} reading does not match its snapshot`)
    const correctionsForFlag = correctionEventRows.flatMap((event) => {
      if (event.discrepancyId !== candidate.flagId || typeof event.payload.correctionId !== 'string') return []
      const detail = correctionById.get(event.payload.correctionId)
      const targetAt = detail ? correctionTargetAt.get(detail.targetEventId) : undefined
      if (!detail || !targetAt || Date.parse(event.occurredAt) < Date.parse(reviewedAt) || Date.parse(targetAt) > Date.parse(reviewedAt)) return []
      return [{ ...detail, type: event.eventType as 'corrected' | 'retracted', occurredAt: new Date(event.occurredAt).toISOString() }]
    })
    const reply = candidate.replyId ? replyRows.find((item) => item.id === candidate.replyId) : null
    if (candidate.replyId && !reply) throw new Error(`approved anchor flag ${candidate.flagId} reply is missing`)
    const referenceAmount = parseStellarAmount(stored.supplyReference.amount)
    return {
      flagId: candidate.flagId, anchor: anchor.name, severity: approvedState.severity, lifecycleState: approvedState.lifecycleState,
      publicationState: correctionsForFlag.some((item) => item.type === 'retracted') ? 'withheld' as const : 'approved_public' as const,
      methodologyVersion: candidate.methodologyVersion, firstObservedAt: new Date(episodeStart.occurredAt).toISOString(), lastObservedAt: new Date(measurement.occurredAt).toISOString(), approvedAt: reviewedAt,
      measurement: { eventId: measurement.id, measuredAt: new Date(snapshot.asOf).toISOString(), asset: observation.asset, reserveAmount: observation.amount, onchainSupply: referenceAmount, absoluteDelta: absoluteDelta(observation.amount, referenceAmount), deltaBasisPoints: deltaBasisPoints(observation.amount, referenceAmount), attestationPeriodStart: observation.attestationPeriodStart, attestationPeriodEnd: observation.attestationPeriodEnd, publishedAt: observation.publishedAt, attestation: observation.attestation, source: observation.provenance.source, supplyReference: stored.supplyReference, confidence: { score: Number(snapshot.confidence), formulaVersion: snapshot.confidenceFormulaVersion, components: snapshot.confidenceComponents, capsApplied: snapshot.confidenceCapsApplied } },
      response: reply ? { body: reply.body, version: reply.version, submittedAt: new Date(reply.submittedAt).toISOString(), reviewedAt, evidence: evidenceFor({ replyId: reply.id }) } : null,
      disputes: disputeRows.filter((item) => item.flagId === candidate.flagId).map((item) => ({ ...item, submittedAt: new Date(item.submittedAt).toISOString(), resolvedAt: new Date(item.resolvedAt!).toISOString(), evidence: evidenceFor({ disputeId: item.id }) })),
      corrections: correctionsForFlag,
    }
  })

  const publicTimes = disclosures.flatMap((disclosure) => [
    disclosure.approvedAt,
    disclosure.measurement.measuredAt,
    ...disclosure.corrections.map((item) => item.occurredAt),
    ...disclosure.disputes.flatMap((item) => [item.submittedAt, item.resolvedAt ?? item.submittedAt]),
  ])
  const asOf = new Date(Math.max(
    Date.parse(new Date(anchor.updatedAt).toISOString()),
    ...publicTimes.map(Date.parse),
  )).toISOString()
  const next = candidates.length > limit ? pageCandidates.at(-1) : undefined

  return {
    anchor: {
      id: anchor.id,
      name: anchor.name,
      networkId: anchor.networkId,
      stellarAccount: anchor.stellarAccount,
      status: anchor.status,
    },
    disclosures,
    asOf,
    nextCursor: next ? encodeCursor(new Date(next.reviewedAt).toISOString(), next.flagId) : null,
  }
}

export type PublicAnchorReserves = NonNullable<Awaited<ReturnType<typeof queryPublicAnchorReserves>>>

let webProcessClient: DatabaseClient | undefined

export async function loadPublicAnchorReserves(anchorId: string, options: { cursor?: string; limit?: number } = {}) {
  const { createDatabaseClient } = await import('./client')
  webProcessClient ??= createDatabaseClient()
  return queryPublicAnchorReserves(webProcessClient, anchorId, options)
}
