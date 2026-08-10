import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { sourceErrorSchema, sourceIdentitySchema } from '../contracts/domain'
import {
  LATEST_LEDGER_METHODOLOGY_VERSION,
  classifyLatestLedgerDiscrepancy,
  latestLedgerResponseSchema,
  type LatestLedgerReconciliationResult,
} from '../reconcile/latest-ledger'
import { createDatabaseClient, type DatabaseClient } from './client'
import {
  rawReadings,
  reconciliationSnapshots,
  snapshotContributions,
} from './schema'

const ledgerValueSchema = z.object({ kind: z.literal('ledger'), value: z.number().int().safe().positive() }).strict()

export async function queryLatestLedgerReadModel(
  client: DatabaseClient,
  subjectKey = 'public',
): Promise<LatestLedgerReconciliationResult | null> {
  const snapshotRows = await client.db
    .select()
    .from(reconciliationSnapshots)
    .where(
      and(
        eq(reconciliationSnapshots.metric, 'latest_ledger'),
        eq(reconciliationSnapshots.subjectKey, subjectKey),
        eq(reconciliationSnapshots.methodologyVersion, LATEST_LEDGER_METHODOLOGY_VERSION),
      ),
    )
    .orderBy(desc(reconciliationSnapshots.asOf), desc(reconciliationSnapshots.id))
    .limit(1)
  const snapshot = snapshotRows[0]
  if (!snapshot) return null

  const rows = await client.db
    .select({
      sourceId: rawReadings.sourceId,
      sourceIdentity: rawReadings.sourceIdentity,
      normalizedValue: rawReadings.normalizedValue,
      sourceTimestamp: rawReadings.sourceTimestamp,
      retrievedAt: rawReadings.retrievedAt,
      ageSeconds: snapshotContributions.ageSeconds,
      effectiveWeight: snapshotContributions.effectiveWeight,
      agrees: snapshotContributions.agrees,
    })
    .from(snapshotContributions)
    .innerJoin(rawReadings, eq(rawReadings.id, snapshotContributions.readingId))
    .where(eq(snapshotContributions.snapshotId, snapshot.id))
    .orderBy(rawReadings.sourceId)

  const reference = snapshot.value === null ? null : ledgerValueSchema.parse(snapshot.value).value
  const observations = rows.map((row) => {
    const observed = ledgerValueSchema.parse(row.normalizedValue).value
    const source = sourceIdentitySchema.parse(row.sourceIdentity)
    if (source.id !== row.sourceId) throw new Error(`reading source identity does not match ${row.sourceId}`)
    const ledgerDelta = reference === null ? 0 : observed - reference
    const retrievedAt = new Date(row.retrievedAt).toISOString()
    return {
      sourceId: row.sourceId,
      sourceUrl: source.url,
      ledgerSequence: observed,
      closedAt: new Date(row.sourceTimestamp ?? row.retrievedAt).toISOString(),
      retrievedAt,
      sourceClass: source.sourceClass,
      ageSeconds: Number(row.ageSeconds),
      effectiveWeight: Number(row.effectiveWeight),
      agrees: row.agrees,
      ledgerDelta,
    }
  })

  return latestLedgerResponseSchema.parse({
    metric: 'latest_ledger',
    value: reference,
    status: snapshot.status,
    confidence: Number(snapshot.confidence),
    confidence_formula_version: snapshot.confidenceFormulaVersion,
    confidence_components: snapshot.confidenceComponents,
    confidence_caps_applied: snapshot.confidenceCapsApplied,
    sources_configured: snapshot.sourcesConfigured,
    sources_responded: snapshot.sourcesResponded,
    sources_usable: snapshot.sourcesUsable,
    sources_agreeing: snapshot.sourcesAgreeing,
    sources_excluded: snapshot.sourcesExcluded,
    observations,
    discrepancies: observations
      .filter((observation) => observation.ledgerDelta !== 0)
      .map((observation) => ({
        source: observation.sourceId,
        source_url: observation.sourceUrl,
        observed_value: observation.ledgerSequence,
        delta_ledgers: observation.ledgerDelta,
        severity: classifyLatestLedgerDiscrepancy(observation.ledgerDelta),
        closed_at: observation.closedAt,
        retrieved_at: observation.retrievedAt,
      })),
    source_errors: snapshot.sourceErrors.map((input) => {
      const error = sourceErrorSchema.parse(input)
      return {
        sourceId: error.sourceId ?? 'configuration',
        sourceUrl: error.sourceUrl ?? '',
        code: error.code,
        message: error.message,
        retrievedAt: error.occurredAt,
        ...(error.httpStatus === undefined ? {} : { status: error.httpStatus }),
      }
    }),
    as_of: new Date(snapshot.asOf).toISOString(),
    methodology_version: snapshot.methodologyVersion,
  })
}

let webProcessClient: DatabaseClient | undefined

export async function loadLatestLedgerReadModel() {
  webProcessClient ??= createDatabaseClient()
  return queryLatestLedgerReadModel(webProcessClient)
}
