import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { DEPTH_RECONCILIATION_METHODOLOGY_VERSION, depthReconciliationMethodologyConfig } from '../../config/methodology'
import {
  formatNetworkPairKey,
  formatTradingPairId,
  metricSubjectSchema,
  metricValueSchema,
  reconciliationSnapshotSchema,
  sourceErrorSchema,
  tradingPairSchema,
  type NetworkIdentity,
  type ReconciliationSnapshot,
} from '../contracts/domain'
import { depthBookObservationSchema, type DepthBookObservation } from '../reconcile/depth'
import { absoluteDelta } from '../stellar/amount'
import { createDatabaseClient, type DatabaseClient } from './client'
import { discrepancies, ingestCycles, rawReadings, reconciliationSnapshots, snapshotContributions } from './schema'

export interface DepthReadModel { snapshot: ReconciliationSnapshot; stale: boolean; freshForSeconds: number }
const rawDepthPayloadSchema = z.object({ observation: depthBookObservationSchema }).passthrough()

function toValue(observation: DepthBookObservation) {
  return metricValueSchema.parse({
    kind: 'depth', referencePrice: observation.referencePrice, ledgerSequence: observation.ledgerSequence,
    ledgerClosedAt: observation.ledgerClosedAt,
    buckets: observation.buckets.map((bucket) => ({ side: bucket.side, priceBandBasisPoints: bucket.priceBandBasisPoints, value: bucket.amount })),
  })
}
function sameBook(value: Extract<ReturnType<typeof metricValueSchema.parse>, { kind: 'depth' }>, observation: DepthBookObservation) {
  if (value.ledgerSequence !== observation.ledgerSequence || value.referencePrice.numerator !== observation.referencePrice.numerator || value.referencePrice.denominator !== observation.referencePrice.denominator) return false
  return value.buckets.every((bucket) => observation.buckets.find((candidate) => candidate.side === bucket.side && candidate.priceBandBasisPoints === bucket.priceBandBasisPoints)?.amount.equals(bucket.value))
}

export async function queryLatestDepthReadModel(
  client: DatabaseClient,
  pairInput: unknown,
  now = new Date(),
  networkId: NetworkIdentity['id'] = 'public',
): Promise<DepthReadModel | null> {
  const pair = tradingPairSchema.parse(pairInput)
  if (!Number.isFinite(now.getTime())) throw new Error('now must be a valid Date')
  const subjectKey = formatNetworkPairKey(networkId, pair)
  const rows = await client.db.select({ snapshot: reconciliationSnapshots }).from(reconciliationSnapshots)
    .innerJoin(ingestCycles, eq(ingestCycles.id, reconciliationSnapshots.cycleId))
    .where(and(
      eq(reconciliationSnapshots.metric, 'order_book_depth'), eq(reconciliationSnapshots.subjectKey, subjectKey),
      eq(reconciliationSnapshots.methodologyVersion, DEPTH_RECONCILIATION_METHODOLOGY_VERSION), eq(ingestCycles.status, 'completed'),
      eq(ingestCycles.metric, 'order_book_depth'), eq(ingestCycles.subjectKey, subjectKey), eq(ingestCycles.methodologyVersion, DEPTH_RECONCILIATION_METHODOLOGY_VERSION),
    )).orderBy(desc(reconciliationSnapshots.asOf), desc(reconciliationSnapshots.id)).limit(1)
  const stored = rows[0]?.snapshot
  if (!stored) return null
  const subject = metricSubjectSchema.parse(stored.subject)
  if (subject.kind !== 'pair' || formatTradingPairId(subject.pair) !== formatTradingPairId(pair)) throw new Error('persisted depth subject does not match its key')
  const value = stored.value === null ? null : metricValueSchema.parse(stored.value)
  if (value !== null && value.kind !== 'depth') throw new Error('persisted depth snapshot has a non-depth value')

  const contributionRows = await client.db.select({
    observationId: rawReadings.observationId, cycleId: rawReadings.cycleId, sourceId: rawReadings.sourceId,
    rawPayload: rawReadings.rawPayload, ageSeconds: snapshotContributions.ageSeconds,
    effectiveWeight: snapshotContributions.effectiveWeight, agrees: snapshotContributions.agrees,
  }).from(snapshotContributions).innerJoin(rawReadings, eq(rawReadings.id, snapshotContributions.readingId))
    .where(eq(snapshotContributions.snapshotId, stored.id)).orderBy(asc(rawReadings.sourceId))
  const observations = contributionRows.map((row) => {
    const observation = rawDepthPayloadSchema.parse(row.rawPayload).observation
    if (row.cycleId !== stored.cycleId || observation.cycleId !== stored.cycleId || observation.observationId !== row.observationId || observation.provenance.source.id !== row.sourceId) throw new Error(`persisted depth reading identity does not match ${row.observationId}`)
    if (formatTradingPairId(observation.pair) !== formatTradingPairId(pair)) throw new Error(`persisted depth reading pair does not match ${subjectKey}`)
    return { row, observation }
  })
  if (observations.length !== stored.sourcesUsable || observations.filter(({ row }) => row.agrees).length !== stored.sourcesAgreeing) throw new Error('persisted depth contribution totals do not match snapshot counts')
  const reference = observations.find(({ row }) => row.agrees)?.observation
  if (stored.status !== 'unavailable' && (!reference || value?.kind !== 'depth' || !sameBook(value, reference))) throw new Error('available depth snapshot has no matching reference evidence')

  const discrepancyRows = await client.db.select().from(discrepancies).where(and(
    eq(discrepancies.metric, 'order_book_depth'), eq(discrepancies.subjectKey, subjectKey),
    eq(discrepancies.methodologyVersion, DEPTH_RECONCILIATION_METHODOLOGY_VERSION), eq(discrepancies.lastFinalizedCycleId, stored.cycleId),
    eq(discrepancies.lifecycleState, 'open'), eq(discrepancies.publicationState, 'approved_public'),
  )).orderBy(asc(discrepancies.sourceId))
  const publicDiscrepancies = discrepancyRows.map((state) => {
    const observed = observations.find(({ row }) => row.sourceId === state.sourceId)?.observation
    if (!observed || !reference) throw new Error(`public discrepancy ${state.id} has incomplete evidence`)
    return {
      id: state.id, sourceId: state.sourceId, severity: state.severity, lifecycleState: state.lifecycleState,
      publicationState: state.publicationState, consecutiveCycles: state.consecutiveCycles,
      observedValue: toValue(observed), referenceValue: toValue(reference),
      details: {
        kind: 'depth_comparison' as const, observedLedgerSequence: observed.ledgerSequence, referenceLedgerSequence: reference.ledgerSequence,
        observedSourceTimestamp: observed.ledgerClosedAt, referenceSourceTimestamp: reference.ledgerClosedAt,
        bucketDifferences: observed.buckets.flatMap((item) => {
          const referenceAmount = reference.buckets.find((candidate) => candidate.side === item.side && candidate.priceBandBasisPoints === item.priceBandBasisPoints)!.amount
          return item.amount.equals(referenceAmount) ? [] : [{ side: item.side, priceBandBasisPoints: item.priceBandBasisPoints, observed: item.amount, reference: referenceAmount, absoluteDelta: absoluteDelta(item.amount, referenceAmount) }]
        }),
      },
      firstObservedAt: new Date(state.firstObservedAt).toISOString(), lastObservedAt: new Date(state.lastObservedAt).toISOString(),
    }
  })
  const snapshot = reconciliationSnapshotSchema.parse({
    snapshotId: stored.id, cycleId: stored.cycleId, metric: 'order_book_depth', subject, status: stored.status, value,
    confidence: { score: Number(stored.confidence), formulaVersion: stored.confidenceFormulaVersion, components: stored.confidenceComponents, capsApplied: stored.confidenceCapsApplied },
    sourcesConfigured: stored.sourcesConfigured, sourcesResponded: stored.sourcesResponded, sourcesUsable: stored.sourcesUsable,
    sourcesAgreeing: stored.sourcesAgreeing, sourcesExcluded: stored.sourcesExcluded,
    contributions: observations.map(({ row, observation }) => ({ observationId: observation.observationId, sourceId: row.sourceId, sourceClass: observation.provenance.source.sourceClass, ageSeconds: Number(row.ageSeconds), effectiveWeight: Number(row.effectiveWeight), agrees: row.agrees })),
    discrepancies: publicDiscrepancies, sourceErrors: stored.sourceErrors.map((error) => sourceErrorSchema.parse(error)),
    asOf: new Date(stored.asOf).toISOString(), methodologyVersion: stored.methodologyVersion,
  })
  const elapsed = Math.max(0, (now.getTime() - Date.parse(snapshot.asOf)) / 1_000)
  const maximumAge = snapshot.contributions.reduce((maximum, contribution) => Math.max(maximum, contribution.ageSeconds + elapsed), elapsed)
  return { snapshot, stale: maximumAge > depthReconciliationMethodologyConfig.maximumObservationAgeSeconds, freshForSeconds: Math.max(0, depthReconciliationMethodologyConfig.maximumObservationAgeSeconds - maximumAge) }
}

let webProcessClient: DatabaseClient | undefined
export async function loadLatestDepthReadModel(pair: unknown, now = new Date()) {
  webProcessClient ??= createDatabaseClient()
  return queryLatestDepthReadModel(webProcessClient, pair, now)
}
