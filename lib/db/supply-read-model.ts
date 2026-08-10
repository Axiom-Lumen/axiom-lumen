import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  SUPPLY_COMPONENT_IDS,
  SUPPLY_METHODOLOGY_VERSION,
  supplyMethodologyConfig,
} from '../../config/methodology'
import {
  circulatingSupplyObservationSchema,
  creditAssetSchema,
  formatAssetId,
  formatNetworkAssetKey,
  metricSubjectSchema,
  metricValueSchema,
  reconciliationSnapshotSchema,
  sourceErrorSchema,
  type AssetId,
  type NetworkIdentity,
  type ReconciliationSnapshot,
} from '../contracts/domain'
import { absoluteDelta } from '../stellar/amount'
import { createDatabaseClient, type DatabaseClient } from './client'
import {
  discrepancies,
  ingestCycles,
  rawReadings,
  reconciliationSnapshots,
  snapshotContributions,
} from './schema'

export interface SupplyReadModel {
  snapshot: ReconciliationSnapshot
  stale: boolean
  freshForSeconds: number
}

// Raw readings keep connector evidence beside the complete normalized observation.
// Unknown evidence fields are intentionally ignored at the public read boundary.
const rawSupplyPayloadSchema = z.object({ observation: circulatingSupplyObservationSchema }).passthrough()

function sameAsset(left: AssetId, right: AssetId) {
  return formatAssetId(left) === formatAssetId(right)
}

export async function queryLatestSupplyReadModel(
  client: DatabaseClient,
  assetInput: unknown,
  now = new Date(),
  networkId: NetworkIdentity['id'] = 'public',
): Promise<SupplyReadModel | null> {
  const asset = creditAssetSchema.parse(assetInput)
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('now must be a valid Date')
  const subjectKey = formatNetworkAssetKey(networkId, asset)
  const snapshotRows = await client.db
    .select({ snapshot: reconciliationSnapshots })
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
  const stored = snapshotRows[0]?.snapshot
  if (!stored) return null

  const subject = metricSubjectSchema.parse(stored.subject)
  if (subject.kind !== 'asset' || !sameAsset(subject.asset, asset)) {
    throw new Error('persisted supply snapshot subject does not match its subject key')
  }
  const value = stored.value === null ? null : metricValueSchema.parse(stored.value)
  if (value !== null && value.kind !== 'amount') throw new Error('persisted supply snapshot has a non-amount value')

  const contributionRows = await client.db
    .select({
      observationId: rawReadings.observationId,
      cycleId: rawReadings.cycleId,
      sourceId: rawReadings.sourceId,
      rawPayload: rawReadings.rawPayload,
      ageSeconds: snapshotContributions.ageSeconds,
      effectiveWeight: snapshotContributions.effectiveWeight,
      agrees: snapshotContributions.agrees,
    })
    .from(snapshotContributions)
    .innerJoin(rawReadings, eq(rawReadings.id, snapshotContributions.readingId))
    .where(eq(snapshotContributions.snapshotId, stored.id))
    .orderBy(asc(rawReadings.sourceId))

  const observations = contributionRows.map((row) => {
    const parsed = rawSupplyPayloadSchema.parse(row.rawPayload).observation
    if (
      row.cycleId !== stored.cycleId ||
      parsed.cycleId !== stored.cycleId ||
      parsed.observationId !== row.observationId ||
      parsed.provenance.source.id !== row.sourceId
    ) {
      throw new Error(`persisted supply reading identity does not match ${row.observationId}`)
    }
    if (!sameAsset(parsed.asset, asset)) throw new Error(`persisted supply reading asset does not match ${subjectKey}`)
    return { row, observation: parsed }
  })
  if (observations.length !== stored.sourcesUsable) {
    throw new Error('persisted supply contribution count does not match usable-source count')
  }
  if (observations.filter(({ row }) => row.agrees).length !== stored.sourcesAgreeing) {
    throw new Error('persisted supply agreement count does not match agreeing-source count')
  }
  const reference = observations.find(({ row }) => row.agrees)?.observation
  if (stored.status !== 'unavailable' && (!reference || value?.kind !== 'amount' || !reference.amount.equals(value.value))) {
    throw new Error('available supply snapshot does not have matching reference evidence')
  }

  const discrepancyRows = await client.db
    .select()
    .from(discrepancies)
    .where(and(
      eq(discrepancies.metric, 'circulating_supply'),
      eq(discrepancies.subjectKey, subjectKey),
      eq(discrepancies.methodologyVersion, SUPPLY_METHODOLOGY_VERSION),
      eq(discrepancies.lastFinalizedCycleId, stored.cycleId),
      eq(discrepancies.lifecycleState, 'open'),
      eq(discrepancies.publicationState, 'approved_public'),
    ))
    .orderBy(asc(discrepancies.sourceId))

  const publicDiscrepancies = discrepancyRows.map((state) => {
    const observed = observations.find(({ row }) => row.sourceId === state.sourceId)?.observation
    if (!observed || !reference) throw new Error(`public discrepancy ${state.id} has incomplete cycle evidence`)
    return {
      id: state.id,
      sourceId: state.sourceId,
      severity: state.severity,
      lifecycleState: state.lifecycleState,
      publicationState: state.publicationState,
      consecutiveCycles: state.consecutiveCycles,
      observedValue: { kind: 'amount' as const, value: observed.amount },
      referenceValue: { kind: 'amount' as const, value: reference.amount },
      details: {
        kind: 'supply_comparison' as const,
        observedLedgerSequence: observed.ledgerSequence,
        referenceLedgerSequence: reference.ledgerSequence,
        observedSourceTimestamp: observed.provenance.sourceTimestamp!,
        referenceSourceTimestamp: reference.provenance.sourceTimestamp!,
        componentDifferences: SUPPLY_COMPONENT_IDS.flatMap((component) => {
          const observedAmount = observed.components[component]
          const referenceAmount = reference.components[component]
          return observedAmount.equals(referenceAmount) ? [] : [{
            component,
            observed: observedAmount,
            reference: referenceAmount,
            absoluteDelta: absoluteDelta(observedAmount, referenceAmount),
          }]
        }),
      },
      firstObservedAt: new Date(state.firstObservedAt).toISOString(),
      lastObservedAt: new Date(state.lastObservedAt).toISOString(),
    }
  })

  const snapshot = reconciliationSnapshotSchema.parse({
    snapshotId: stored.id,
    cycleId: stored.cycleId,
    metric: 'circulating_supply',
    subject,
    status: stored.status,
    value,
    confidence: {
      score: Number(stored.confidence),
      formulaVersion: stored.confidenceFormulaVersion,
      components: stored.confidenceComponents,
      capsApplied: stored.confidenceCapsApplied,
    },
    sourcesConfigured: stored.sourcesConfigured,
    sourcesResponded: stored.sourcesResponded,
    sourcesUsable: stored.sourcesUsable,
    sourcesAgreeing: stored.sourcesAgreeing,
    sourcesExcluded: stored.sourcesExcluded,
    contributions: observations.map(({ row, observation }) => ({
      observationId: observation.observationId,
      sourceId: row.sourceId,
      sourceClass: observation.provenance.source.sourceClass,
      ageSeconds: Number(row.ageSeconds),
      effectiveWeight: Number(row.effectiveWeight),
      agrees: row.agrees,
    })),
    discrepancies: publicDiscrepancies,
    sourceErrors: stored.sourceErrors.map((error) => sourceErrorSchema.parse(error)),
    asOf: new Date(stored.asOf).toISOString(),
    methodologyVersion: stored.methodologyVersion,
  })
  const elapsedSinceSnapshotSeconds = Math.max(0, (now.getTime() - Date.parse(snapshot.asOf)) / 1_000)
  const maximumEvidenceAgeSeconds = snapshot.contributions.reduce(
    (maximum, contribution) => Math.max(maximum, contribution.ageSeconds + elapsedSinceSnapshotSeconds),
    elapsedSinceSnapshotSeconds,
  )
  const freshForSeconds = Math.max(
    0,
    supplyMethodologyConfig.maximumObservationAgeSeconds - maximumEvidenceAgeSeconds,
  )
  return {
    snapshot,
    stale: maximumEvidenceAgeSeconds > supplyMethodologyConfig.maximumObservationAgeSeconds,
    freshForSeconds,
  }
}

let webProcessClient: DatabaseClient | undefined

export async function loadLatestSupplyReadModel(asset: unknown, now = new Date()) {
  webProcessClient ??= createDatabaseClient()
  return queryLatestSupplyReadModel(webProcessClient, asset, now)
}
