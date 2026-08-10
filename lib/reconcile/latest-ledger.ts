import { createHash } from 'node:crypto'
import { z } from 'zod'
import { SOURCE_CLASS_IDS, methodologyConfig, type SourceClassId } from '../../config/methodology'
import {
  identifierSchema,
  latestLedgerObservationSchema,
  networkIdentitySchema,
  sourceErrorCodeSchema,
  type NetworkIdentity,
  type PersistedDiscrepancyState,
  type SourceError,
  type SourceIdentity,
} from '../contracts/domain'
import { classifySafeIntegerDeviationBand } from './discrepancy-state'
import {
  reconcileMetric,
  type MetricReconciliationProfile,
  type ReconcileMetricResult,
  type ReconciliationMethodologyConfig,
} from './orchestrator'
import { computeWeightFromAge } from './staleness'

const latestLedgerMethodology = methodologyConfig.metrics.latestLedger
const latestLedgerConfidence = latestLedgerMethodology.confidence
const PUBLIC_NETWORK: NetworkIdentity = {
  id: 'public',
  passphrase: 'Public Global Stellar Network ; September 2015',
}

export const LATEST_LEDGER_METHODOLOGY_VERSION = latestLedgerMethodology.methodologyVersion
export const DEFAULT_HORIZON_HALF_LIFE_SECONDS = latestLedgerMethodology.freshnessHalfLifeSeconds
export const DEFAULT_HORIZON_BASE_WEIGHT =
  methodologyConfig.sourceClasses[latestLedgerMethodology.sourceClass].baseWeight
export const LATEST_LEDGER_CONFIDENCE_FORMULA_VERSION = latestLedgerConfidence.formulaVersion

export type LatestLedgerStatus = 'verified' | 'degraded' | 'unavailable'
export type LedgerDiscrepancySeverity = 'info' | 'warning' | 'critical'

export interface LatestLedgerObservation {
  sourceId: string
  sourceUrl: string
  ledgerSequence: number
  closedAt: string
  retrievedAt: string
  baseWeight?: number
  sourceClass?: SourceClassId
  upstreamId?: string
  rawPayload?: unknown
}

export interface LatestLedgerSourceError {
  sourceId: string
  sourceUrl: string
  code: string
  message: string
  retrievedAt: string
  status?: number
}

export interface WeightedLatestLedgerObservation extends LatestLedgerObservation {
  ageSeconds: number
  effectiveWeight: number
  agrees: boolean
  ledgerDelta: number
}

export interface LatestLedgerDiscrepancy {
  source: string
  source_url: string
  observed_value: number
  delta_ledgers: number
  severity: LedgerDiscrepancySeverity
  closed_at: string
  retrieved_at: string
}

export interface LatestLedgerReconciliationInput {
  observations: LatestLedgerObservation[]
  sourceErrors?: LatestLedgerSourceError[]
  sourcesConfigured: number
  sourcesExcluded?: number
  asOf?: Date
  halfLifeSeconds?: number
  expectedSourceClasses?: readonly SourceClassId[]
  network?: NetworkIdentity
}

const confidenceComponentsSchema = z
  .object({
    agreement: z.number().finite().min(0).max(1),
    freshness: z.number().finite().min(0).max(1),
    availability: z.number().finite().min(0).max(1),
    diversity: z.number().finite().min(0).max(1),
    spread: z.number().finite().min(0).max(1),
  })
  .strict()

const legacyObservationSchema = z
  .object({
    sourceId: identifierSchema,
    sourceUrl: z.string().url(),
    ledgerSequence: z.number().int().safe().positive(),
    closedAt: z.string().datetime({ offset: true }),
    retrievedAt: z.string().datetime({ offset: true }),
    baseWeight: z.number().finite().positive().optional(),
    sourceClass: z.enum(SOURCE_CLASS_IDS).optional(),
    upstreamId: z.string().trim().min(1).optional(),
    ageSeconds: z.number().finite().nonnegative(),
    effectiveWeight: z.number().finite().nonnegative(),
    agrees: z.boolean(),
    ledgerDelta: z.number().int().safe(),
  })
  .strict()

const legacySourceErrorSchema = z
  .object({
    sourceId: z.string(),
    sourceUrl: z.string(),
    code: z.string().min(1),
    message: z.string().min(1),
    retrievedAt: z.string().datetime({ offset: true }),
    status: z.number().int().min(100).max(599).optional(),
  })
  .strict()

export const latestLedgerResponseSchema = z
  .object({
    metric: z.literal('latest_ledger'),
    value: z.number().int().safe().positive().nullable(),
    status: z.enum(['verified', 'degraded', 'unavailable']),
    confidence: z.number().finite().min(0).max(1),
    confidence_formula_version: z.literal(LATEST_LEDGER_CONFIDENCE_FORMULA_VERSION),
    confidence_components: confidenceComponentsSchema,
    confidence_caps_applied: z.array(z.string().min(1)),
    sources_configured: z.number().int().safe().nonnegative(),
    sources_responded: z.number().int().safe().nonnegative(),
    sources_usable: z.number().int().safe().nonnegative(),
    sources_agreeing: z.number().int().safe().nonnegative(),
    sources_excluded: z.number().int().safe().nonnegative(),
    observations: z.array(legacyObservationSchema),
    discrepancies: z.array(
      z
        .object({
          source: identifierSchema,
          source_url: z.string().url(),
          observed_value: z.number().int().safe().positive(),
          delta_ledgers: z.number().int().safe(),
          severity: z.enum(['info', 'warning', 'critical']),
          closed_at: z.string().datetime({ offset: true }),
          retrieved_at: z.string().datetime({ offset: true }),
        })
        .strict(),
    ),
    source_errors: z.array(legacySourceErrorSchema),
    as_of: z.string().datetime({ offset: true }),
    methodology_version: z.literal(LATEST_LEDGER_METHODOLOGY_VERSION),
  })
  .strict()
  .superRefine((response, context) => {
    if ((response.status === 'unavailable') !== (response.value === null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'availability and value disagree' })
    }
    if (response.sources_responded > response.sources_configured) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources_responded'], message: 'responded exceeds configured' })
    }
    if (response.sources_usable > response.sources_responded) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources_usable'], message: 'usable exceeds responded' })
    }
    if (response.sources_agreeing > response.sources_usable) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources_agreeing'], message: 'agreeing exceeds usable' })
    }
    if (response.sources_excluded > response.sources_configured) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources_excluded'], message: 'excluded exceeds configured' })
    }
  })
export type LatestLedgerReconciliationResult = z.infer<typeof latestLedgerResponseSchema>

export function computeFreshnessWeight({
  baseWeight = DEFAULT_HORIZON_BASE_WEIGHT,
  ageSeconds,
  halfLifeSeconds = DEFAULT_HORIZON_HALF_LIFE_SECONDS,
}: {
  baseWeight?: number
  ageSeconds: number
  halfLifeSeconds?: number
}) {
  if (!Number.isFinite(baseWeight) || baseWeight <= 0) return 0
  if (!Number.isFinite(ageSeconds)) return 0
  if (!Number.isFinite(halfLifeSeconds) || halfLifeSeconds <= 0) {
    throw new Error('halfLifeSeconds must be greater than zero')
  }
  return computeWeightFromAge({ baseWeight, ageSeconds: Math.max(0, ageSeconds), halfLifeSeconds })
}

export function classifyLatestLedgerDiscrepancy(deltaLedgers: number): LedgerDiscrepancySeverity {
  const absoluteDelta = Math.abs(deltaLedgers)
  if (absoluteDelta <= 1) return 'info'
  if (absoluteDelta <= 5) return 'warning'
  return 'critical'
}

function sourceIdentity(
  sourceId: string,
  sourceUrl: string,
  network: NetworkIdentity,
  sourceClass: SourceClassId = latestLedgerMethodology.sourceClass,
): SourceIdentity {
  return {
    id: identifierSchema.parse(sourceId),
    sourceClass,
    adapter: sourceClass === 'archive' ? 'archive' : 'horizon',
    url: sourceUrl,
    network,
  }
}

function sourceErrorCategory(code: SourceError['code']): SourceError['category'] {
  if (code === 'invalid_configuration') return 'configuration'
  if (code === 'request_failed' || code === 'request_aborted') return 'transport'
  if (code === 'non_200_response' || code === 'redirect_rejected') return 'http'
  if (code === 'network_mismatch') return 'network'
  if (code === 'stale_observation') return 'freshness'
  if (code === 'excluded_source') return 'policy'
  return 'payload'
}

function toDomainSourceError(error: LatestLedgerSourceError): SourceError {
  const parsedCode = sourceErrorCodeSchema.safeParse(error.code)
  const code: SourceError['code'] = parsedCode.success ? parsedCode.data : 'request_failed'
  return {
    sourceId: identifierSchema.parse(error.sourceId),
    sourceUrl: error.sourceUrl,
    code,
    category: sourceErrorCategory(code),
    message: error.message,
    occurredAt: error.retrievedAt,
    ...(error.status === undefined ? {} : { httpStatus: error.status }),
    retryable:
      code === 'request_failed' ||
      code === 'request_aborted' ||
      code === 'response_too_large' ||
      (code === 'non_200_response' && (error.status ?? 0) >= 500),
  }
}

function methodology(
  halfLifeSeconds: number,
  expectedSourceClasses: readonly SourceClassId[],
): ReconciliationMethodologyConfig {
  return {
    version: LATEST_LEDGER_METHODOLOGY_VERSION,
    freshnessHalfLifeSeconds: halfLifeSeconds,
    expectedSourceClasses,
    sourceClassBaseWeights: Object.fromEntries(
      SOURCE_CLASS_IDS.map((sourceClass) => [sourceClass, methodologyConfig.sourceClasses[sourceClass].baseWeight]),
    ) as ReconciliationMethodologyConfig['sourceClassBaseWeights'],
    minimumVerifiedSources: latestLedgerMethodology.minimumVerifiedSources,
    verifiedThreshold: latestLedgerConfidence.verifiedThreshold,
    confidenceFormulaVersion: LATEST_LEDGER_CONFIDENCE_FORMULA_VERSION,
    confidenceCoefficients: {
      agreement: latestLedgerConfidence.agreementCoefficient,
      freshness: latestLedgerConfidence.freshnessCoefficient,
      availability: latestLedgerConfidence.availabilityCoefficient,
      spread: latestLedgerConfidence.spreadCoefficient,
    },
    singleSourceCap: latestLedgerConfidence.singleSourceCap,
    sameUpstreamCap: latestLedgerConfidence.sameUpstreamCap,
    sourceErrorCap: latestLedgerConfidence.sourceErrorCap,
  }
}

const profiledLatestLedgerObservationSchema = latestLedgerObservationSchema
  .extend({
    baseWeight: z.number().finite().positive().optional(),
    upstreamId: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
type DomainLatestLedgerObservation = ReturnType<typeof profiledLatestLedgerObservationSchema.parse>

const profile: MetricReconciliationProfile<DomainLatestLedgerObservation, number> = {
  metric: 'latest_ledger',
  parseObservation: (input) => profiledLatestLedgerObservationSchema.parse(input),
  matchesSubject: (observation, subject) =>
    subject.kind === 'network' &&
    observation.provenance.source.network.id === subject.network.id &&
    observation.provenance.source.network.passphrase === subject.network.passphrase,
  getValue: (observation) => observation.ledgerSequence,
  getBaseWeight: (observation, configuredBaseWeight) => observation.baseWeight ?? configuredBaseWeight,
  compareValues: (left, right) => left - right,
  agrees: (observed, reference) =>
    Math.abs(observed - reference) <= latestLedgerMethodology.agreementToleranceLedgers,
  deviationBand: (observed, reference) =>
    classifySafeIntegerDeviationBand({
      absoluteDeviation: Math.abs(observed - reference),
      tolerance: latestLedgerMethodology.agreementToleranceLedgers,
    }),
  spreadDistance: (observed, reference) => Math.abs(observed - reference),
  maximumSpreadDistance: latestLedgerConfidence.maximumSpreadLedgers,
  toMetricValue: (value) => ({ kind: 'ledger', value }),
  getUpstreamId: (observation) => observation.upstreamId ?? observation.provenance.source.id,
}

export interface LatestLedgerDomainReconciliationInput extends LatestLedgerReconciliationInput {
  cycleId: string
  snapshotId: string
  priorDiscrepancyStates?: Readonly<Record<string, PersistedDiscrepancyState | unknown>>
}

export function reconcileLatestLedgerDomain({
  cycleId,
  snapshotId,
  observations,
  sourceErrors = [],
  sourcesConfigured,
  asOf = new Date(),
  halfLifeSeconds = DEFAULT_HORIZON_HALF_LIFE_SECONDS,
  expectedSourceClasses = [latestLedgerMethodology.sourceClass],
  network: networkInput = PUBLIC_NETWORK,
  priorDiscrepancyStates = {},
}: LatestLedgerDomainReconciliationInput): ReconcileMetricResult {
  const network = networkIdentitySchema.parse(networkInput)
  const configuredCount = Number.isSafeInteger(sourcesConfigured) ? Math.max(0, sourcesConfigured) : 0
  const identities = new Map<string, SourceIdentity>()
  observations.forEach((observation) => {
    identities.set(
      observation.sourceId,
      sourceIdentity(observation.sourceId, observation.sourceUrl, network, observation.sourceClass),
    )
  })
  sourceErrors.forEach((error) => {
    if (!identities.has(error.sourceId)) {
      identities.set(error.sourceId, sourceIdentity(error.sourceId, error.sourceUrl, network))
    }
  })
  for (let index = identities.size; index < configuredCount; index += 1) {
    let sourceId = `configured_${index + 1}`
    while (identities.has(sourceId)) sourceId = `${sourceId}_placeholder`
    identities.set(sourceId, sourceIdentity(sourceId, `https://${sourceId}.invalid`, network))
  }
  const asOfValue = new Date(asOf)
  const domainObservations = observations.map((observation) => ({
    observationId: `observation_${createHash('sha256').update(`${cycleId}:${observation.sourceId}`).digest('hex')}`,
    cycleId,
    metric: 'latest_ledger' as const,
    ledgerSequence: observation.ledgerSequence,
    ...(observation.baseWeight && observation.baseWeight > 0 ? { baseWeight: observation.baseWeight } : {}),
    provenance: {
      source: identities.get(observation.sourceId),
      sourceTimestamp: observation.closedAt,
      retrievedAt: observation.retrievedAt,
    },
    ...(observation.upstreamId ? { upstreamId: observation.upstreamId } : {}),
  }))
  return reconcileMetric({
    snapshotId,
    cycleId,
    subject: { kind: 'network', network },
    configuredSources: [...identities.values()],
    observations: domainObservations,
    sourceErrors: sourceErrors.map(toDomainSourceError),
    priorDiscrepancyStates,
    clock: () => new Date(asOfValue),
    methodology: methodology(halfLifeSeconds, expectedSourceClasses),
    profile,
  })
}

/**
 * Runs the latest-ledger-v0.2 direct diagnostic profile through the shared orchestrator and then preserves the
 * established route response. It is intentionally not the persisted v1 snapshot serializer.
 */
export function reconcileLatestLedger({
  observations,
  sourceErrors = [],
  sourcesConfigured,
  sourcesExcluded = 0,
  asOf = new Date(),
  halfLifeSeconds = DEFAULT_HORIZON_HALF_LIFE_SECONDS,
  expectedSourceClasses = [latestLedgerMethodology.sourceClass],
  network: networkInput = PUBLIC_NETWORK,
}: LatestLedgerReconciliationInput): LatestLedgerReconciliationResult {
  const asOfValue = new Date(asOf)
  const cycleId = `latest-ledger:${asOfValue.toISOString()}`
  const result = reconcileLatestLedgerDomain({
    cycleId,
    snapshotId: `diagnostic:${asOfValue.toISOString()}`,
    observations,
    sourceErrors,
    sourcesConfigured,
    sourcesExcluded,
    asOf: asOfValue,
    halfLifeSeconds,
    expectedSourceClasses,
    network: networkInput,
  })

  const reference = result.snapshot.value?.kind === 'ledger' ? result.snapshot.value.value : null
  const contributions = new Map(result.snapshot.contributions.map((item) => [item.sourceId, item]))
  const weightedObservations: WeightedLatestLedgerObservation[] = observations.flatMap((observation) => {
    const contribution = contributions.get(observation.sourceId)
    if (!contribution || reference === null) return []
    const ledgerDelta = observation.ledgerSequence - reference
    const { rawPayload: _rawPayload, ...publicObservation } = observation
    return [{
      ...publicObservation,
      ageSeconds: contribution.ageSeconds,
      effectiveWeight: contribution.effectiveWeight,
      agrees: contribution.agrees,
      ledgerDelta,
    }]
  })
  const discrepancies = weightedObservations
    .filter((observation) => observation.ledgerDelta !== 0)
    .map((observation) => ({
      source: observation.sourceId,
      source_url: observation.sourceUrl,
      observed_value: observation.ledgerSequence,
      delta_ledgers: observation.ledgerDelta,
      severity: classifyLatestLedgerDiscrepancy(observation.ledgerDelta),
      closed_at: observation.closedAt,
      retrieved_at: observation.retrievedAt,
    }))

  return latestLedgerResponseSchema.parse({
    metric: 'latest_ledger',
    value: reference,
    status: result.snapshot.status,
    confidence: result.snapshot.confidence.score,
    confidence_formula_version: result.snapshot.confidence.formulaVersion,
    confidence_components: result.snapshot.confidence.components,
    confidence_caps_applied: result.snapshot.confidence.capsApplied,
    sources_configured: result.snapshot.sourcesConfigured,
    sources_responded: result.snapshot.sourcesResponded,
    sources_usable: result.snapshot.sourcesUsable,
    sources_agreeing: result.snapshot.sourcesAgreeing,
    sources_excluded: Math.max(result.snapshot.sourcesExcluded, Math.max(0, sourcesExcluded)),
    observations: weightedObservations,
    discrepancies,
    source_errors: sourceErrors,
    as_of: result.snapshot.asOf,
    methodology_version: LATEST_LEDGER_METHODOLOGY_VERSION,
  })
}
