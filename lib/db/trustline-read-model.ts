import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { TRUSTLINE_METHODOLOGY_VERSION, TRUSTLINE_STATE_IDS, trustlineMethodologyConfig } from '../../config/methodology'
import { creditAssetSchema, formatAssetId, formatNetworkAssetKey, metricSubjectSchema, metricValueSchema, reconciliationSnapshotSchema, sourceErrorSchema, trustlineCountObservationSchema, type AssetId, type NetworkIdentity, type ReconciliationSnapshot } from '../contracts/domain'
import { createDatabaseClient, type DatabaseClient } from './client'
import { discrepancies, ingestCycles, rawReadings, reconciliationSnapshots, snapshotContributions } from './schema'

export interface TrustlineReadModel { snapshot: ReconciliationSnapshot; stale: boolean; freshForSeconds: number }
const rawPayloadSchema = z.object({ observation: trustlineCountObservationSchema }).passthrough()
function sameAsset(left: AssetId, right: AssetId) { return formatAssetId(left) === formatAssetId(right) }
function toValue(observation: z.infer<typeof trustlineCountObservationSchema>) {
  return metricValueSchema.parse({ kind: 'trustline_state', total: observation.total, states: observation.states, ledgerSequence: observation.ledgerSequence, ledgerClosedAt: observation.provenance.sourceTimestamp })
}
function sameValue(value: Extract<ReturnType<typeof metricValueSchema.parse>, { kind: 'trustline_state' }>, observation: z.infer<typeof trustlineCountObservationSchema>) {
  return value.total === observation.total && value.ledgerSequence === observation.ledgerSequence && TRUSTLINE_STATE_IDS.every((state) => value.states[state] === observation.states[state])
}
function delta(left: bigint, right: bigint) { return left >= right ? left - right : right - left }

export async function queryLatestTrustlineReadModel(client: DatabaseClient, assetInput: unknown, now = new Date(), networkId: NetworkIdentity['id'] = 'public'): Promise<TrustlineReadModel | null> {
  const asset = creditAssetSchema.parse(assetInput); if (!Number.isFinite(now.getTime())) throw new Error('now must be a valid Date')
  const subjectKey = formatNetworkAssetKey(networkId, asset)
  const rows = await client.db.select({ snapshot: reconciliationSnapshots }).from(reconciliationSnapshots).innerJoin(ingestCycles, eq(ingestCycles.id, reconciliationSnapshots.cycleId)).where(and(
    eq(reconciliationSnapshots.metric, 'trustline_count'), eq(reconciliationSnapshots.subjectKey, subjectKey), eq(reconciliationSnapshots.methodologyVersion, TRUSTLINE_METHODOLOGY_VERSION),
    eq(ingestCycles.status, 'completed'), eq(ingestCycles.metric, 'trustline_count'), eq(ingestCycles.subjectKey, subjectKey), eq(ingestCycles.methodologyVersion, TRUSTLINE_METHODOLOGY_VERSION),
  )).orderBy(desc(reconciliationSnapshots.asOf), desc(reconciliationSnapshots.id)).limit(1)
  const stored = rows[0]?.snapshot; if (!stored) return null
  const subject = metricSubjectSchema.parse(stored.subject)
  if (subject.kind !== 'asset' || !sameAsset(subject.asset, asset)) throw new Error('persisted trustline subject does not match its key')
  const value = stored.value === null ? null : metricValueSchema.parse(stored.value)
  if (value !== null && value.kind !== 'trustline_state') throw new Error('persisted trustline snapshot has an incompatible value')
  const contributionRows = await client.db.select({ observationId: rawReadings.observationId, cycleId: rawReadings.cycleId, sourceId: rawReadings.sourceId, rawPayload: rawReadings.rawPayload, ageSeconds: snapshotContributions.ageSeconds, effectiveWeight: snapshotContributions.effectiveWeight, agrees: snapshotContributions.agrees })
    .from(snapshotContributions).innerJoin(rawReadings, eq(rawReadings.id, snapshotContributions.readingId)).where(eq(snapshotContributions.snapshotId, stored.id)).orderBy(asc(rawReadings.sourceId))
  const observations = contributionRows.map((row) => {
    const observation = rawPayloadSchema.parse(row.rawPayload).observation
    if (row.cycleId !== stored.cycleId || observation.cycleId !== stored.cycleId || observation.observationId !== row.observationId || observation.provenance.source.id !== row.sourceId) throw new Error(`persisted trustline reading identity does not match ${row.observationId}`)
    if (!sameAsset(observation.asset, asset)) throw new Error(`persisted trustline reading asset does not match ${subjectKey}`)
    return { row, observation }
  })
  if (observations.length !== stored.sourcesUsable || observations.filter(({ row }) => row.agrees).length !== stored.sourcesAgreeing) throw new Error('persisted trustline contribution totals do not match snapshot counts')
  const reference = observations.find(({ row }) => row.agrees)?.observation
  if (stored.status !== 'unavailable' && (!reference || value?.kind !== 'trustline_state' || !sameValue(value, reference))) throw new Error('available trustline snapshot has no matching reference evidence')
  const discrepancyRows = await client.db.select().from(discrepancies).where(and(eq(discrepancies.metric, 'trustline_count'), eq(discrepancies.subjectKey, subjectKey), eq(discrepancies.methodologyVersion, TRUSTLINE_METHODOLOGY_VERSION), eq(discrepancies.lastFinalizedCycleId, stored.cycleId), eq(discrepancies.lifecycleState, 'open'), eq(discrepancies.publicationState, 'approved_public'))).orderBy(asc(discrepancies.sourceId))
  const publicDiscrepancies = discrepancyRows.map((state) => {
    const observed = observations.find(({ row }) => row.sourceId === state.sourceId)?.observation
    if (!observed || !reference) throw new Error(`public discrepancy ${state.id} has incomplete evidence`)
    return { id: state.id, sourceId: state.sourceId, severity: state.severity, lifecycleState: state.lifecycleState, publicationState: state.publicationState, consecutiveCycles: state.consecutiveCycles,
      observedValue: toValue(observed), referenceValue: toValue(reference), details: { kind: 'trustline_comparison' as const, observedLedgerSequence: observed.ledgerSequence, referenceLedgerSequence: reference.ledgerSequence, observedSourceTimestamp: observed.provenance.sourceTimestamp!, referenceSourceTimestamp: reference.provenance.sourceTimestamp!, stateDifferences: TRUSTLINE_STATE_IDS.flatMap((name) => observed.states[name] === reference.states[name] ? [] : [{ state: name, observed: observed.states[name], reference: reference.states[name], absoluteDelta: delta(observed.states[name], reference.states[name]) }]) }, firstObservedAt: new Date(state.firstObservedAt).toISOString(), lastObservedAt: new Date(state.lastObservedAt).toISOString() }
  })
  const snapshot = reconciliationSnapshotSchema.parse({ snapshotId: stored.id, cycleId: stored.cycleId, metric: 'trustline_count', subject, status: stored.status, value,
    confidence: { score: Number(stored.confidence), formulaVersion: stored.confidenceFormulaVersion, components: stored.confidenceComponents, capsApplied: stored.confidenceCapsApplied },
    sourcesConfigured: stored.sourcesConfigured, sourcesResponded: stored.sourcesResponded, sourcesUsable: stored.sourcesUsable, sourcesAgreeing: stored.sourcesAgreeing, sourcesExcluded: stored.sourcesExcluded,
    contributions: observations.map(({ row, observation }) => ({ observationId: observation.observationId, sourceId: row.sourceId, sourceClass: observation.provenance.source.sourceClass, ageSeconds: Number(row.ageSeconds), effectiveWeight: Number(row.effectiveWeight), agrees: row.agrees })), discrepancies: publicDiscrepancies, sourceErrors: stored.sourceErrors.map((error) => sourceErrorSchema.parse(error)), asOf: new Date(stored.asOf).toISOString(), methodologyVersion: stored.methodologyVersion })
  const elapsed = Math.max(0, (now.getTime() - Date.parse(snapshot.asOf)) / 1_000)
  const maximumAge = snapshot.contributions.reduce((maximum, contribution) => Math.max(maximum, contribution.ageSeconds + elapsed), elapsed)
  return { snapshot, stale: maximumAge > trustlineMethodologyConfig.maximumObservationAgeSeconds, freshForSeconds: Math.max(0, trustlineMethodologyConfig.maximumObservationAgeSeconds - maximumAge) }
}
let webProcessClient: DatabaseClient | undefined
export async function loadLatestTrustlineReadModel(asset: unknown, now = new Date()) { webProcessClient ??= createDatabaseClient(); return queryLatestTrustlineReadModel(webProcessClient, asset, now) }
