import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gte, inArray, lt, lte } from 'drizzle-orm'
import { SUPPLY_METHODOLOGY_VERSION } from '../../config/methodology'
import {
  circulatingSupplyObservationSchema,
  persistedDiscrepancyStateSchema,
  reconciliationSnapshotSchema,
  sourceIdentitySchema,
  formatAssetId,
  formatNetworkAssetKey,
  formatTradingPairId,
  networkIdSchema,
  type PersistedDiscrepancyState,
  type ReconciliationSnapshot,
  type SourceIdentity,
} from '../contracts/domain'
import type { DiscrepancyAmendmentEvent, DiscrepancyMeasurementEvent } from '../reconcile/discrepancy-state'
import { serializePublicSnapshotEvent } from '../contracts/api'
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
  snapshotEvents,
  sourceHealthSamples,
  sourceHealthStates,
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

function canonicalDatabaseTimestamp(value: string) {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error('database returned an invalid timestamp')
  return parsed.toISOString()
}

export function computePayloadSha256(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function assertSupplyReferenceSubject(subjectKey: string, input: unknown) {
  const observation = circulatingSupplyObservationSchema.parse(input)
  if (formatNetworkAssetKey(observation.provenance.source.network.id, observation.asset) !== subjectKey) {
    throw new Error('persisted supply reference evidence does not match the requested asset')
  }
  return observation
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
  sourceIdentity: SourceIdentity | unknown
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

export interface SourceHealthStateRecord {
  sourceId: string
  state: typeof sourceHealthStates.$inferInsert.state
  consecutiveFailures: number
  circuitState: typeof sourceHealthStates.$inferInsert.circuitState
  circuitOpenedAt?: string | null
  nextAttemptAt?: string | null
  lastErrorCode?: string | null
  lastObservedAt: string
}

export interface PersistCompletedCycleInput {
  cycle: CompletedCycleRecord
  attempts: readonly RetrievalAttemptRecord[]
  readings: readonly RawReadingRecord[]
  sourceHealth?: readonly SourceHealthRecord[]
  sourceHealthStates?: readonly SourceHealthStateRecord[]
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
  sourceIdentity: SourceIdentity
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
  channel: 'email' | 'webhook'
  payload: Record<string, unknown>
  payloadSha256: string
  nextAttemptAt?: string | null
}

function assertSnapshotMatchesCycle(snapshot: ReconciliationSnapshot, cycle: CompletedCycleRecord) {
  if (snapshot.cycleId !== cycle.id) throw new Error('snapshot cycleId must match the completed cycle')
  if (snapshot.metric !== cycle.metric) throw new Error('snapshot metric must match the completed cycle')
  if (snapshot.methodologyVersion !== cycle.methodologyVersion) {
    throw new Error('snapshot methodologyVersion must match the completed cycle')
  }
  if (snapshot.asOf !== cycle.completedAt) throw new Error('snapshot asOf must match the completed cycle timestamp')
  if (
    cycle.metric === 'circulating_supply' &&
    (
      snapshot.subject.kind !== 'asset' ||
      !cycle.subjectKey.endsWith(`:${formatAssetId(snapshot.subject.asset)}`) ||
      !networkIdSchema.safeParse(cycle.subjectKey.split(':', 1)[0]).success
    )
  ) throw new Error('supply snapshot asset must match the completed cycle subject')
  if (
    cycle.metric === 'order_book_depth' &&
    (
      snapshot.subject.kind !== 'pair' ||
      !cycle.subjectKey.endsWith(`:${formatTradingPairId(snapshot.subject.pair)}`) ||
      !networkIdSchema.safeParse(cycle.subjectKey.split(':', 1)[0]).success
    )
  ) throw new Error('depth snapshot pair must match the completed cycle subject')
  if (
    cycle.metric === 'trustline_count' &&
    (
      snapshot.subject.kind !== 'asset' ||
      !cycle.subjectKey.endsWith(`:${formatAssetId(snapshot.subject.asset)}`) ||
      !networkIdSchema.safeParse(cycle.subjectKey.split(':', 1)[0]).success
    )
  ) throw new Error('trustline snapshot asset must match the completed cycle subject')
  if (
    cycle.metric === 'anchor_reserves' &&
    (
      snapshot.subject.kind !== 'asset' ||
      !cycle.subjectKey.endsWith(`:${formatAssetId(snapshot.subject.asset)}`) ||
      !networkIdSchema.safeParse(cycle.subjectKey.split(':', 1)[0]).success
    )
  ) throw new Error('anchor reserve snapshot asset must match the completed cycle subject')
}

function sameCycleIdentity(existing: typeof ingestCycles.$inferSelect, requested: CompletedCycleRecord) {
  return (
    existing.id === requested.id &&
    existing.metric === requested.metric &&
    existing.subjectKey === requested.subjectKey &&
    existing.methodologyVersion === requested.methodologyVersion &&
    existing.status === 'completed' &&
    Date.parse(existing.scheduledAt) === Date.parse(requested.scheduledAt)
  )
}

interface SupplySnapshotRow {
  status: 'verified' | 'degraded' | 'unavailable'
  value: { kind: string; value?: string } | null
  confidence: string
  methodologyVersion: string
  asOf: string
  snapshotId: string
  cycleId: string
}

async function materializeSupplyReference(db: DatabaseClient['db'], subjectKey: string, row: SupplySnapshotRow) {
  if (row.status === 'unavailable' || !row.value || row.value.kind !== 'amount' || typeof row.value.value !== 'string') return null
  const confidence = Number(row.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('persisted supply confidence is invalid')
  const evidenceRows = await db.select({
    readingId: rawReadings.id,
    observationId: rawReadings.observationId,
    sourceId: rawReadings.sourceId,
    sourceTimestamp: rawReadings.sourceTimestamp,
    payloadSha256: rawReadings.payloadSha256,
    rawPayload: rawReadings.rawPayload,
  }).from(snapshotContributions)
    .innerJoin(rawReadings, eq(rawReadings.id, snapshotContributions.readingId))
    .where(and(eq(snapshotContributions.snapshotId, row.snapshotId), eq(snapshotContributions.agrees, true)))
    .orderBy(asc(rawReadings.sourceId))
  const evidence = evidenceRows.map((candidate) => {
    const raw = candidate.rawPayload
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('observation' in raw)) throw new Error('persisted supply reference evidence is malformed')
    const observation = assertSupplyReferenceSubject(subjectKey, (raw as { observation: unknown }).observation)
    if (
      observation.observationId !== candidate.observationId || observation.cycleId !== row.cycleId ||
      observation.provenance.source.id !== candidate.sourceId ||
      observation.provenance.sourceTimestamp !== canonicalDatabaseTimestamp(candidate.sourceTimestamp!) ||
      !observation.amount.equals(StellarAmount.parse(row.value!.value!))
    ) throw new Error('persisted supply reference evidence does not match its snapshot')
    return {
      readingId: candidate.readingId, observationId: candidate.observationId, sourceId: candidate.sourceId,
      payloadSha256: candidate.payloadSha256, ledgerSequence: observation.ledgerSequence,
      ledgerClosedAt: observation.provenance.sourceTimestamp!,
    }
  })
  if (evidence.length === 0) throw new Error('available supply reference has no agreeing evidence')
  const checkpoints = new Set(evidence.map((item) => `${item.ledgerSequence}:${item.ledgerClosedAt}`))
  if (checkpoints.size !== 1) throw new Error('supply reference evidence does not share one ledger checkpoint')
  return {
    snapshotId: row.snapshotId, cycleId: row.cycleId, amount: StellarAmount.parse(row.value.value), status: row.status,
    confidence, methodologyVersion: row.methodologyVersion, asOf: canonicalDatabaseTimestamp(row.asOf),
    ledgerSequence: evidence[0]!.ledgerSequence, ledgerClosedAt: evidence[0]!.ledgerClosedAt, evidence,
  }
}

/** Repository surface intentionally exposes no update or delete operation for immutable audit records. */
export function createPersistenceRepositories(client: DatabaseClient) {
  const { db } = client

  return {
    async persistCompletedCycle(input: PersistCompletedCycleInput) {
      const snapshot = reconciliationSnapshotSchema.parse(input.snapshot)
      assertSnapshotMatchesCycle(snapshot, input.cycle)
      const sourceIdentityByReadingId = new Map(input.readings.map((reading) => {
        const identity = sourceIdentitySchema.parse(reading.sourceIdentity)
        if (identity.id !== reading.sourceId) {
          throw new Error(`reading ${reading.id} source identity does not match its source ID`)
        }
        if (input.cycle.metric === 'latest_ledger' && identity.network.id !== input.cycle.subjectKey) {
          throw new Error(`reading ${reading.id} source network does not match the cycle subject`)
        }
        if (
          input.cycle.metric === 'circulating_supply' &&
          identity.network.id !== input.cycle.subjectKey.split(':', 1)[0]
        ) throw new Error(`reading ${reading.id} source network does not match the supply cycle subject`)
        if (
          input.cycle.metric === 'order_book_depth' &&
          identity.network.id !== input.cycle.subjectKey.split(':', 1)[0]
        ) throw new Error(`reading ${reading.id} source network does not match the depth cycle subject`)
        if (
          input.cycle.metric === 'trustline_count' &&
          identity.network.id !== input.cycle.subjectKey.split(':', 1)[0]
        ) throw new Error(`reading ${reading.id} source network does not match the trustline cycle subject`)
        if (
          input.cycle.metric === 'anchor_reserves' &&
          identity.network.id !== input.cycle.subjectKey.split(':', 1)[0]
        ) throw new Error(`reading ${reading.id} source network does not match the anchor reserve cycle subject`)
        return [reading.id, identity]
      }))
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
                sourceIdentity: normalizeJsonObject(sourceIdentityByReadingId.get(reading.id)),
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

        for (const health of input.sourceHealthStates ?? []) {
          if (!Number.isSafeInteger(health.consecutiveFailures) || health.consecutiveFailures < 0) {
            throw new Error(`source health ${health.sourceId} has an invalid failure count`)
          }
          await tx
            .insert(sourceHealthStates)
            .values(health)
            .onConflictDoUpdate({
              target: sourceHealthStates.sourceId,
              setWhere: lt(sourceHealthStates.lastObservedAt, health.lastObservedAt),
              set: {
                state: health.state,
                consecutiveFailures: health.consecutiveFailures,
                circuitState: health.circuitState,
                circuitOpenedAt: health.circuitOpenedAt,
                nextAttemptAt: health.nextAttemptAt,
                lastErrorCode: health.lastErrorCode,
                lastObservedAt: health.lastObservedAt,
                updatedAt: health.lastObservedAt,
              },
            })
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

        const snapshotNetworkId = snapshot.subject.kind === 'network'
          ? snapshot.subject.network.id
          : input.cycle.subjectKey.split(':', 1)[0]
        if (snapshot.metric !== 'anchor_reserves' && snapshotNetworkId === 'public') {
          await tx.insert(snapshotEvents).values({
            snapshotId: snapshot.snapshotId,
            payload: serializePublicSnapshotEvent(snapshot, input.cycle.subjectKey),
            occurredAt: snapshot.asOf,
          })
        }

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
      const rows = await db
        .select({
          id: rawReadings.id,
          observationId: rawReadings.observationId,
          cycleId: rawReadings.cycleId,
          attemptId: rawReadings.attemptId,
          sourceId: rawReadings.sourceId,
          metric: rawReadings.metric,
          subjectKey: rawReadings.subjectKey,
          sourceIdentity: rawReadings.sourceIdentity,
          normalizedValue: rawReadings.normalizedValue,
          rawPayload: rawReadings.rawPayload,
          payloadSha256: rawReadings.payloadSha256,
          sourceTimestamp: rawReadings.sourceTimestamp,
          retrievedAt: rawReadings.retrievedAt,
        })
        .from(rawReadings)
        .where(eq(rawReadings.cycleId, cycleId))
        .orderBy(asc(rawReadings.retrievedAt), asc(rawReadings.id))
      return rows.map((row) => ({ ...row, sourceIdentity: sourceIdentitySchema.parse(row.sourceIdentity) }))
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

    async getDiscrepancyStates(metric: typeof discrepancies.$inferSelect.metric, subjectKey: string, methodologyVersion?: string) {
      const rows = await db
        .select()
        .from(discrepancies)
        .where(and(
          eq(discrepancies.metric, metric),
          eq(discrepancies.subjectKey, subjectKey),
          ...(methodologyVersion ? [eq(discrepancies.methodologyVersion, methodologyVersion)] : []),
        ))
        .orderBy(asc(discrepancies.sourceId))
      return Object.fromEntries(
        rows.map((row) => [
          row.sourceId,
          persistedDiscrepancyStateSchema.parse({
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
            firstObservedAt: canonicalDatabaseTimestamp(row.firstObservedAt),
            lastObservedAt: canonicalDatabaseTimestamp(row.lastObservedAt),
            lastFinalizedCycleId: row.lastFinalizedCycleId,
            lastFinalizedCycleAt: canonicalDatabaseTimestamp(row.lastFinalizedCycleAt),
            publicationUpdatedAt: canonicalDatabaseTimestamp(row.publicationUpdatedAt),
          }),
        ]),
      )
    },

    async getLatestSupplyReference(subjectKey: string) {
      const rows = await db
        .select({
          status: reconciliationSnapshots.status,
          value: reconciliationSnapshots.value,
          confidence: reconciliationSnapshots.confidence,
          methodologyVersion: reconciliationSnapshots.methodologyVersion,
          asOf: reconciliationSnapshots.asOf,
          snapshotId: reconciliationSnapshots.id,
          cycleId: reconciliationSnapshots.cycleId,
        })
        .from(reconciliationSnapshots)
        .innerJoin(ingestCycles, eq(ingestCycles.id, reconciliationSnapshots.cycleId))
        .where(and(
          eq(reconciliationSnapshots.metric, 'circulating_supply'),
          eq(reconciliationSnapshots.subjectKey, subjectKey),
          eq(reconciliationSnapshots.methodologyVersion, SUPPLY_METHODOLOGY_VERSION),
          eq(ingestCycles.status, 'completed'),
          eq(ingestCycles.metric, 'circulating_supply'),
          eq(ingestCycles.subjectKey, subjectKey),
          eq(ingestCycles.methodologyVersion, SUPPLY_METHODOLOGY_VERSION),
        ))
        .orderBy(desc(reconciliationSnapshots.asOf), desc(reconciliationSnapshots.id))
        .limit(1)
      const row = rows[0]
      return row ? materializeSupplyReference(db, subjectKey, row as SupplySnapshotRow) : null
    },

    async getSupplyReferenceAt(subjectKey: string, targetAt: string, maximumSkewSeconds: number) {
      const target = new Date(targetAt)
      if (!Number.isFinite(target.getTime())) throw new Error('supply reference target must be a valid timestamp')
      if (!Number.isSafeInteger(maximumSkewSeconds) || maximumSkewSeconds <= 0) throw new Error('supply reference skew must be a positive safe integer')
      const lower = new Date(target.getTime() - maximumSkewSeconds * 1_000).toISOString()
      const upper = new Date(target.getTime() + maximumSkewSeconds * 1_000).toISOString()
      const rows = await db.selectDistinct({
        status: reconciliationSnapshots.status,
        value: reconciliationSnapshots.value,
        confidence: reconciliationSnapshots.confidence,
        methodologyVersion: reconciliationSnapshots.methodologyVersion,
        asOf: reconciliationSnapshots.asOf,
        snapshotId: reconciliationSnapshots.id,
        cycleId: reconciliationSnapshots.cycleId,
      }).from(reconciliationSnapshots)
        .innerJoin(ingestCycles, eq(ingestCycles.id, reconciliationSnapshots.cycleId))
        .innerJoin(snapshotContributions, eq(snapshotContributions.snapshotId, reconciliationSnapshots.id))
        .innerJoin(rawReadings, eq(rawReadings.id, snapshotContributions.readingId))
        .where(and(
          eq(reconciliationSnapshots.metric, 'circulating_supply'),
          eq(reconciliationSnapshots.subjectKey, subjectKey),
          eq(reconciliationSnapshots.methodologyVersion, SUPPLY_METHODOLOGY_VERSION),
          eq(snapshotContributions.agrees, true),
          gte(rawReadings.sourceTimestamp, lower),
          lte(rawReadings.sourceTimestamp, upper),
          eq(ingestCycles.status, 'completed'),
          eq(ingestCycles.metric, 'circulating_supply'),
          eq(ingestCycles.subjectKey, subjectKey),
          eq(ingestCycles.methodologyVersion, SUPPLY_METHODOLOGY_VERSION),
        )).orderBy(desc(reconciliationSnapshots.asOf), desc(reconciliationSnapshots.id)).limit(100)
      const references = []
      for (const row of rows) {
        const reference = await materializeSupplyReference(db, subjectKey, row as SupplySnapshotRow)
        if (reference && Math.abs(Date.parse(reference.ledgerClosedAt) - target.getTime()) <= maximumSkewSeconds * 1_000) references.push(reference)
      }
      references.sort((left, right) =>
        Math.abs(Date.parse(left.ledgerClosedAt) - target.getTime()) - Math.abs(Date.parse(right.ledgerClosedAt) - target.getTime()) ||
        left.snapshotId.localeCompare(right.snapshotId))
      return references[0] ?? null
    },

    async getSourceHealthStates(sourceIds: readonly string[]) {
      if (sourceIds.length === 0) return {}
      const rows = await db
        .select()
        .from(sourceHealthStates)
        .where(inArray(sourceHealthStates.sourceId, [...new Set(sourceIds)]))
        .orderBy(asc(sourceHealthStates.sourceId))
      return Object.fromEntries(rows.map((row) => [row.sourceId, {
        sourceId: row.sourceId,
        state: row.state,
        consecutiveFailures: row.consecutiveFailures,
        circuitState: row.circuitState,
        circuitOpenedAt: row.circuitOpenedAt ? new Date(row.circuitOpenedAt).toISOString() : null,
        nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt).toISOString() : null,
        lastErrorCode: row.lastErrorCode,
        lastObservedAt: new Date(row.lastObservedAt).toISOString(),
      } satisfies SourceHealthStateRecord]))
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
