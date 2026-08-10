import { createHash } from 'node:crypto'
import { and, asc, eq, lt } from 'drizzle-orm'
import {
  persistedDiscrepancyStateSchema,
  reconciliationSnapshotSchema,
  type PersistedDiscrepancyState,
  type ReconciliationSnapshot,
} from '../contracts/domain'
import type { DiscrepancyAmendmentEvent, DiscrepancyMeasurementEvent } from '../reconcile/discrepancy-state'
import { StellarAmount } from '../stellar/amount'
import type { DatabaseClient } from './client'
import {
  discrepancyEvents,
  discrepancies,
  ingestCycles,
  notifications,
  rawReadings,
  reconciliationSnapshots,
  retrievalAttempts,
  snapshotContributions,
  sourceHealthSamples,
} from './schema'

type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

const SENSITIVE_KEY = /^(?:authorization|cookie|setcookie|password|passwd|secret|clientsecret|apikey|accesskey|accesstoken|refreshtoken|token)$/

function normalizedKey(key: string) {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
}

export function normalizeJson(value: unknown, redactSensitive = false): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON numbers must be finite')
    return value
  }
  if (typeof value === 'bigint' || value instanceof StellarAmount) return value.toString()
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('JSON dates must be valid')
    return value.toISOString()
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, redactSensitive))
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('raw payload must contain plain JSON values')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [
          key,
          redactSensitive && SENSITIVE_KEY.test(normalizedKey(key)) ? '[REDACTED]' : normalizeJson(nested, redactSensitive),
        ]),
    )
  }
  throw new Error(`raw payload contains unsupported ${typeof value} value`)
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(normalizeJson(value))
}

function normalizeJsonObject(value: unknown, redactSensitive = false): Record<string, JsonValue> {
  const normalized = normalizeJson(value, redactSensitive)
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== 'object') {
    throw new Error('value must normalize to a JSON object')
  }
  return normalized
}

export function computePayloadSha256(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export interface CompletedCycleRecord {
  id: string
  metric: typeof ingestCycles.$inferInsert.metric
  subjectKey: string
  methodologyVersion: string
  idempotencyKey: string
  scheduledAt: string
  startedAt: string
  completedAt: string
}

export interface RetrievalAttemptRecord {
  id: string
  sourceId: string
  attemptNumber: number
  outcome: typeof retrievalAttempts.$inferInsert.outcome
  startedAt: string
  completedAt: string
  httpStatus?: number | null
  error?: Record<string, unknown> | null
}

export interface RawReadingRecord {
  id: string
  observationId: string
  attemptId: string
  sourceId: string
  normalizedValue: unknown
  rawPayload: unknown
  sourceTimestamp?: string | null
  retrievedAt: string
}

export interface SourceHealthRecord {
  id: string
  sourceId: string
  state: typeof sourceHealthSamples.$inferInsert.state
  latencyMs?: number | null
  details?: Record<string, unknown>
  observedAt: string
}

export interface PersistCompletedCycleInput {
  cycle: CompletedCycleRecord
  attempts: readonly RetrievalAttemptRecord[]
  readings: readonly RawReadingRecord[]
  sourceHealth?: readonly SourceHealthRecord[]
  snapshot: ReconciliationSnapshot | unknown
  discrepancyStates: Readonly<Record<string, PersistedDiscrepancyState | unknown>>
  events: readonly DiscrepancyMeasurementEvent[]
}

export interface StoredRawReading {
  id: string
  observationId: string
  cycleId: string
  attemptId: string
  sourceId: string
  metric: typeof rawReadings.$inferSelect.metric
  subjectKey: string
  normalizedValue: unknown
  rawPayload: unknown
  payloadSha256: string
  sourceTimestamp: string | null
  retrievedAt: string
}

export interface StoredDiscrepancyEvent {
  id: string
  discrepancyId: string
  cycleId: string | null
  targetEventId: string | null
  eventType: string
  methodologyVersion: string
  payload: unknown
  occurredAt: string
}

export interface NotificationRecord {
  id: string
  caseId: string
  contactEndpointId: string
  idempotencyKey: string
  nextAttemptAt?: string | null
}

function assertSnapshotMatchesCycle(snapshot: ReconciliationSnapshot, cycle: CompletedCycleRecord) {
  if (snapshot.cycleId !== cycle.id) throw new Error('snapshot cycleId must match the completed cycle')
  if (snapshot.metric !== cycle.metric) throw new Error('snapshot metric must match the completed cycle')
  if (snapshot.methodologyVersion !== cycle.methodologyVersion) {
    throw new Error('snapshot methodologyVersion must match the completed cycle')
  }
  if (snapshot.asOf !== cycle.completedAt) throw new Error('snapshot asOf must match the completed cycle timestamp')
}

function sameCycleIdentity(existing: typeof ingestCycles.$inferSelect, requested: CompletedCycleRecord) {
  return (
    existing.id === requested.id &&
    existing.metric === requested.metric &&
    existing.subjectKey === requested.subjectKey &&
    existing.methodologyVersion === requested.methodologyVersion &&
    existing.status === 'completed' &&
    Date.parse(existing.scheduledAt) === Date.parse(requested.scheduledAt) &&
    Date.parse(existing.startedAt ?? '') === Date.parse(requested.startedAt) &&
    Date.parse(existing.completedAt ?? '') === Date.parse(requested.completedAt)
  )
}

/** Repository surface intentionally exposes no update or delete operation for immutable audit records. */
export function createPersistenceRepositories(client: DatabaseClient) {
  const { db } = client

  return {
    async persistCompletedCycle(input: PersistCompletedCycleInput) {
      const snapshot = reconciliationSnapshotSchema.parse(input.snapshot)
      assertSnapshotMatchesCycle(snapshot, input.cycle)
      const states = Object.values(input.discrepancyStates).map((state) => persistedDiscrepancyStateSchema.parse(state))
      const stateById = new Map(states.map((state) => [state.discrepancyId, state]))
      for (const event of input.events) {
        if (event.cycleId !== input.cycle.id || event.occurredAt !== input.cycle.completedAt) {
          throw new Error(`event ${event.eventId} must belong to the completed cycle and its finalization time`)
        }
        const state = stateById.get(event.discrepancyId)
        if (!state || state.sourceId !== event.sourceId || state.methodologyVersion !== event.methodologyVersion) {
          throw new Error(`event ${event.eventId} does not match its projected discrepancy state`)
        }
      }

      return db.transaction(async (tx) => {
        const insertedCycle = await tx
          .insert(ingestCycles)
          .values({ ...input.cycle, status: 'completed' })
          .onConflictDoNothing()
          .returning({ id: ingestCycles.id })

        if (insertedCycle.length === 0) {
          const existing = await tx
            .select()
            .from(ingestCycles)
            .where(eq(ingestCycles.idempotencyKey, input.cycle.idempotencyKey))
            .limit(1)
          if (!existing[0]) throw new Error(`cycle ID ${input.cycle.id} conflicts with a different idempotency key`)
          if (!sameCycleIdentity(existing[0], input.cycle)) {
            throw new Error(`idempotency key ${input.cycle.idempotencyKey} was reused with different cycle parameters`)
          }
          return { status: 'duplicate' as const, cycleId: existing[0].id }
        }

        if (input.attempts.length > 0) {
          await tx.insert(retrievalAttempts).values(
            input.attempts.map((attempt) => ({
              ...attempt,
              cycleId: input.cycle.id,
              error: attempt.error ? normalizeJsonObject(attempt.error) : null,
            })),
          )
        }

        if (input.readings.length > 0) {
          await tx.insert(rawReadings).values(
            input.readings.map((reading) => {
              const sanitizedPayload = normalizeJson(reading.rawPayload, true)
              return {
                id: reading.id,
                observationId: reading.observationId,
                cycleId: input.cycle.id,
                attemptId: reading.attemptId,
                sourceId: reading.sourceId,
                metric: input.cycle.metric,
                subjectKey: input.cycle.subjectKey,
                normalizedValue: normalizeJsonObject(reading.normalizedValue),
                rawPayload: sanitizedPayload,
                payloadSha256: computePayloadSha256(sanitizedPayload),
                sourceTimestamp: reading.sourceTimestamp,
                retrievedAt: reading.retrievedAt,
              }
            }),
          )
        }

        if (input.sourceHealth && input.sourceHealth.length > 0) {
          await tx.insert(sourceHealthSamples).values(
            input.sourceHealth.map((health) => ({
              ...health,
              cycleId: input.cycle.id,
              details: normalizeJsonObject(health.details ?? {}),
            })),
          )
        }

        await tx.insert(reconciliationSnapshots).values({
          id: snapshot.snapshotId,
          cycleId: input.cycle.id,
          metric: snapshot.metric,
          subjectKey: input.cycle.subjectKey,
          status: snapshot.status,
          subject: normalizeJsonObject(snapshot.subject),
          value: snapshot.value ? normalizeJsonObject(snapshot.value) : null,
          confidence: snapshot.confidence.score.toString(),
          confidenceFormulaVersion: snapshot.confidence.formulaVersion,
          confidenceComponents: normalizeJsonObject(snapshot.confidence.components) as Record<string, number>,
          confidenceCapsApplied: snapshot.confidence.capsApplied,
          sourceErrors: snapshot.sourceErrors.map((error) => normalizeJsonObject(error)),
          sourcesConfigured: snapshot.sourcesConfigured,
          sourcesResponded: snapshot.sourcesResponded,
          sourcesUsable: snapshot.sourcesUsable,
          sourcesAgreeing: snapshot.sourcesAgreeing,
          sourcesExcluded: snapshot.sourcesExcluded,
          methodologyVersion: snapshot.methodologyVersion,
          asOf: snapshot.asOf,
        })

        const readingIdByObservation = new Map(input.readings.map((reading) => [reading.observationId, reading.id]))
        if (snapshot.contributions.length > 0) {
          await tx.insert(snapshotContributions).values(
            snapshot.contributions.map((contribution) => {
              const readingId = readingIdByObservation.get(contribution.observationId)
              if (!readingId) throw new Error(`snapshot contribution ${contribution.observationId} has no reading`)
              return {
                snapshotId: snapshot.snapshotId,
                readingId,
                sourceId: contribution.sourceId,
                ageSeconds: contribution.ageSeconds.toString(),
                effectiveWeight: contribution.effectiveWeight.toString(),
                agrees: contribution.agrees,
              }
            }),
          )
        }

        for (const state of states.filter((candidate) => candidate.lastFinalizedCycleId === input.cycle.id)) {
          const persisted = await tx
            .insert(discrepancies)
            .values({
              id: state.discrepancyId,
              sourceId: state.sourceId,
              metric: input.cycle.metric,
              subjectKey: input.cycle.subjectKey,
              methodologyVersion: state.methodologyVersion,
              namedParty: state.namedParty,
              severity: state.severity,
              lifecycleState: state.lifecycleState,
              publicationState: state.publicationState,
              replyReviewState: state.replyReviewState,
              consecutiveCycles: state.consecutiveCycles,
              consecutiveAboveInfoCycles: state.consecutiveAboveInfoCycles,
              firstObservedAt: state.firstObservedAt,
              lastObservedAt: state.lastObservedAt,
              lastFinalizedCycleId: state.lastFinalizedCycleId,
              lastFinalizedCycleAt: state.lastFinalizedCycleAt,
              publicationUpdatedAt: state.publicationUpdatedAt,
            })
            .onConflictDoUpdate({
              target: discrepancies.id,
              setWhere: and(
                lt(discrepancies.lastFinalizedCycleAt, state.lastFinalizedCycleAt),
                eq(discrepancies.sourceId, state.sourceId),
                eq(discrepancies.metric, input.cycle.metric),
                eq(discrepancies.subjectKey, input.cycle.subjectKey),
                eq(discrepancies.methodologyVersion, state.methodologyVersion),
                eq(discrepancies.namedParty, state.namedParty),
              ),
              set: {
                severity: state.severity,
                lifecycleState: state.lifecycleState,
                publicationState: state.publicationState,
                replyReviewState: state.replyReviewState,
                consecutiveCycles: state.consecutiveCycles,
                consecutiveAboveInfoCycles: state.consecutiveAboveInfoCycles,
                lastObservedAt: state.lastObservedAt,
                lastFinalizedCycleId: state.lastFinalizedCycleId,
                lastFinalizedCycleAt: state.lastFinalizedCycleAt,
                publicationUpdatedAt: state.publicationUpdatedAt,
              },
            })
            .returning({ id: discrepancies.id })
          if (persisted.length === 0) {
            throw new Error(`discrepancy ${state.discrepancyId} has a newer finalization or incompatible identity`)
          }
        }

        for (const event of input.events) {
          let targetEventId: string | null = null
          if (event.type === 'resolved') {
            const opening = await tx
              .select({ id: discrepancyEvents.id })
              .from(discrepancyEvents)
              .where(and(eq(discrepancyEvents.discrepancyId, event.discrepancyId), eq(discrepancyEvents.eventType, 'opened')))
              .orderBy(asc(discrepancyEvents.occurredAt), asc(discrepancyEvents.id))
              .limit(1)
            if (!opening[0]) throw new Error(`resolved event ${event.eventId} has no opening event to target`)
            targetEventId = opening[0].id
          }
          await tx.insert(discrepancyEvents).values({
            id: event.eventId,
            discrepancyId: event.discrepancyId,
            cycleId: 'cycleId' in event ? event.cycleId : null,
            targetEventId,
            eventType: event.type,
            methodologyVersion: event.methodologyVersion,
            payload: normalizeJsonObject(event),
            occurredAt: event.occurredAt,
          })
        }

        return { status: 'inserted' as const, cycleId: input.cycle.id }
      })
    },

    async appendDiscrepancyAmendment(event: DiscrepancyAmendmentEvent) {
      return db.transaction(async (tx) => {
        const target = await tx
          .select({
            id: discrepancyEvents.id,
            discrepancyId: discrepancyEvents.discrepancyId,
            methodologyVersion: discrepancyEvents.methodologyVersion,
            occurredAt: discrepancyEvents.occurredAt,
            sourceId: discrepancies.sourceId,
          })
          .from(discrepancyEvents)
          .innerJoin(discrepancies, eq(discrepancies.id, discrepancyEvents.discrepancyId))
          .where(eq(discrepancyEvents.id, event.targetEventId))
          .limit(1)
        if (
          !target[0] ||
          target[0].discrepancyId !== event.discrepancyId ||
          target[0].sourceId !== event.sourceId ||
          target[0].methodologyVersion !== event.methodologyVersion ||
          Date.parse(event.occurredAt) < Date.parse(target[0].occurredAt)
        ) {
          throw new Error('amendment target must be an earlier event in the same discrepancy and methodology')
        }
        await tx.insert(discrepancyEvents).values({
          id: event.eventId,
          discrepancyId: event.discrepancyId,
          cycleId: null,
          targetEventId: event.targetEventId,
          eventType: event.type,
          methodologyVersion: event.methodologyVersion,
          payload: normalizeJsonObject(event),
          occurredAt: event.occurredAt,
        })
        return event.eventId
      })
    },

    async getRawReadings(cycleId: string): Promise<StoredRawReading[]> {
      return db
        .select({
          id: rawReadings.id,
          observationId: rawReadings.observationId,
          cycleId: rawReadings.cycleId,
          attemptId: rawReadings.attemptId,
          sourceId: rawReadings.sourceId,
          metric: rawReadings.metric,
          subjectKey: rawReadings.subjectKey,
          normalizedValue: rawReadings.normalizedValue,
          rawPayload: rawReadings.rawPayload,
          payloadSha256: rawReadings.payloadSha256,
          sourceTimestamp: rawReadings.sourceTimestamp,
          retrievedAt: rawReadings.retrievedAt,
        })
        .from(rawReadings)
        .where(eq(rawReadings.cycleId, cycleId))
        .orderBy(asc(rawReadings.retrievedAt), asc(rawReadings.id))
    },

    async getDiscrepancyEventChain(discrepancyId: string): Promise<StoredDiscrepancyEvent[]> {
      return db
        .select({
          id: discrepancyEvents.id,
          discrepancyId: discrepancyEvents.discrepancyId,
          cycleId: discrepancyEvents.cycleId,
          targetEventId: discrepancyEvents.targetEventId,
          eventType: discrepancyEvents.eventType,
          methodologyVersion: discrepancyEvents.methodologyVersion,
          payload: discrepancyEvents.payload,
          occurredAt: discrepancyEvents.occurredAt,
        })
        .from(discrepancyEvents)
        .where(eq(discrepancyEvents.discrepancyId, discrepancyId))
        .orderBy(asc(discrepancyEvents.occurredAt), asc(discrepancyEvents.id))
    },

    async enqueueNotification(notification: NotificationRecord) {
      const inserted = await db
        .insert(notifications)
        .values(notification)
        .onConflictDoNothing({ target: notifications.idempotencyKey })
        .returning({ id: notifications.id })
      return inserted[0] ? { status: 'inserted' as const, id: inserted[0].id } : { status: 'duplicate' as const }
    },
  }
}

export type PersistenceRepositories = ReturnType<typeof createPersistenceRepositories>
