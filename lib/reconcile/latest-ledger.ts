import { methodologyConfig } from '../../config/methodology'
import type { SourceClassId } from '../../config/methodology'
import {
  computeAvailabilityScore,
  computeSourceClassDiversity,
  computeWeightedAgreement,
} from './agreement'
import { computeConfidence, type ConfidenceComponents } from './confidence'
import { computeNormalizedSpread } from './spread'
import { computeEffectiveWeight as computeObservationEffectiveWeight, computeWeightFromAge } from './staleness'
import { computeSafeIntegerWeightedMedian } from './weighted-median'

const latestLedgerProfile = methodologyConfig.metrics.latestLedger
const latestLedgerConfidence = latestLedgerProfile.confidence

export const LATEST_LEDGER_METHODOLOGY_VERSION = latestLedgerProfile.methodologyVersion
export const DEFAULT_HORIZON_HALF_LIFE_SECONDS = latestLedgerProfile.freshnessHalfLifeSeconds
export const DEFAULT_HORIZON_BASE_WEIGHT =
  methodologyConfig.sourceClasses[latestLedgerProfile.sourceClass].baseWeight
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
}

export interface LatestLedgerReconciliationResult {
  metric: 'latest_ledger'
  value: number | null
  status: LatestLedgerStatus
  confidence: number
  confidence_formula_version: typeof LATEST_LEDGER_CONFIDENCE_FORMULA_VERSION
  confidence_components: ConfidenceComponents
  confidence_caps_applied: string[]
  sources_configured: number
  sources_responded: number
  sources_usable: number
  sources_agreeing: number
  sources_excluded: number
  observations: WeightedLatestLedgerObservation[]
  discrepancies: LatestLedgerDiscrepancy[]
  source_errors: LatestLedgerSourceError[]
  as_of: string
  methodology_version: typeof LATEST_LEDGER_METHODOLOGY_VERSION
}

function didSourceRespond(error: LatestLedgerSourceError) {
  return !['request_aborted', 'request_failed'].includes(error.code)
}

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

  return computeWeightFromAge({
    baseWeight,
    ageSeconds: Math.max(0, ageSeconds),
    halfLifeSeconds,
  })
}

function parseTime(value: string) {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : Number.NaN
}

function normalizeBaseWeight(value: number | undefined) {
  const baseWeight = value ?? DEFAULT_HORIZON_BASE_WEIGHT
  return Number.isFinite(baseWeight) && baseWeight > 0 ? baseWeight : 0
}

export function classifyLatestLedgerDiscrepancy(deltaLedgers: number): LedgerDiscrepancySeverity {
  const absoluteDelta = Math.abs(deltaLedgers)
  if (absoluteDelta <= 1) return 'info'
  if (absoluteDelta <= 5) return 'warning'
  return 'critical'
}

export function reconcileLatestLedger({
  observations,
  sourceErrors = [],
  sourcesConfigured,
  sourcesExcluded = 0,
  asOf = new Date(),
  halfLifeSeconds = DEFAULT_HORIZON_HALF_LIFE_SECONDS,
  expectedSourceClasses = [latestLedgerProfile.sourceClass],
}: LatestLedgerReconciliationInput): LatestLedgerReconciliationResult {
  const sourceErrorsCount = sourceErrors.length
  const sourcesResponded = observations.length + sourceErrors.filter(didSourceRespond).length
  const normalizedSourceCount = Math.max(0, sourcesConfigured)
  const sourceErrorIds = new Set(sourceErrors.map((error) => error.sourceId))
  const usableObservations = observations.filter((observation) => {
    return (
      !sourceErrorIds.has(observation.sourceId) &&
      Number.isSafeInteger(observation.ledgerSequence) &&
      Number.isFinite(parseTime(observation.retrievedAt))
    )
  })

  const preliminaryWeighted = usableObservations.map((observation) => {
    const weighted = computeObservationEffectiveWeight({
      baseWeight: normalizeBaseWeight(observation.baseWeight),
      sourceTimestamp: observation.closedAt,
      retrievedAt: observation.retrievedAt,
      now: asOf,
      halfLifeSeconds,
    })

    return {
      ...observation,
      ageSeconds: weighted.ageSeconds,
      effectiveWeight: weighted.effectiveWeight,
      agrees: false,
      ledgerDelta: 0,
    }
  })

  const value =
    computeSafeIntegerWeightedMedian(
      preliminaryWeighted.map((observation) => ({
        id: observation.sourceId,
        value: observation.ledgerSequence,
        effectiveWeight: observation.effectiveWeight,
      })),
    )?.value ?? null

  if (value === null) {
    return {
      metric: 'latest_ledger',
      value: null,
      status: 'unavailable',
      confidence: 0,
      confidence_formula_version: LATEST_LEDGER_CONFIDENCE_FORMULA_VERSION,
      confidence_components: {
        agreement: 0,
        freshness: 0,
        availability: 0,
        diversity: 0,
        spread: 0,
      },
      confidence_caps_applied: [],
      sources_configured: normalizedSourceCount,
      sources_responded: sourcesResponded,
      sources_usable: 0,
      sources_agreeing: 0,
      sources_excluded: Math.max(0, sourcesExcluded),
      observations: [],
      discrepancies: [],
      source_errors: sourceErrors,
      as_of: asOf.toISOString(),
      methodology_version: LATEST_LEDGER_METHODOLOGY_VERSION,
    }
  }

  const weightedObservations = preliminaryWeighted.map((observation) => {
    const ledgerDelta = observation.ledgerSequence - value
    return {
      ...observation,
      ledgerDelta,
      agrees: Math.abs(ledgerDelta) <= latestLedgerProfile.agreementToleranceLedgers,
    }
  })
  const totalEffectiveWeight = weightedObservations.reduce(
    (sum, observation) => sum + observation.effectiveWeight,
    0,
  )
  const totalBaseWeight = weightedObservations.reduce(
    (sum, observation) => sum + normalizeBaseWeight(observation.baseWeight),
    0,
  )
  const agreeingObservations = weightedObservations.filter((observation) => observation.agrees)
  const availabilityScore = computeAvailabilityScore({
    usableSources: weightedObservations.length,
    configuredSources: Math.max(normalizedSourceCount, weightedObservations.length),
  })
  const agreementScore = computeWeightedAgreement(weightedObservations).score
  const freshnessScore = totalBaseWeight === 0 ? 0 : totalEffectiveWeight / totalBaseWeight
  const spreadScore = computeNormalizedSpread({
    distances: weightedObservations.map((observation) => observation.ledgerDelta),
    maximumDistance: latestLedgerConfidence.maximumSpreadLedgers,
  }).score
  const diversityScore = computeSourceClassDiversity({
    representedSourceClasses: weightedObservations.map(
      (observation) => observation.sourceClass ?? latestLedgerProfile.sourceClass,
    ),
    expectedSourceClasses,
  }).score
  const uniqueUpstreams = new Set(
    weightedObservations.map((observation) => observation.upstreamId?.trim() || observation.sourceId),
  ).size
  const confidenceResult = computeConfidence({
    formulaVersion: LATEST_LEDGER_CONFIDENCE_FORMULA_VERSION,
    components: {
      agreement: agreementScore,
      freshness: freshnessScore,
      availability: availabilityScore,
      diversity: diversityScore,
      spread: spreadScore,
    },
    coefficients: {
      agreement: latestLedgerConfidence.agreementCoefficient,
      freshness: latestLedgerConfidence.freshnessCoefficient,
      availability: latestLedgerConfidence.availabilityCoefficient,
      spread: latestLedgerConfidence.spreadCoefficient,
    },
    caps: [
      {
        id: 'single_source',
        maximum: latestLedgerConfidence.singleSourceCap,
        applies: weightedObservations.length === 1,
      },
      {
        id: 'same_upstream_replicas',
        maximum: latestLedgerConfidence.sameUpstreamCap,
        applies: weightedObservations.length > 1 && uniqueUpstreams === 1,
      },
      {
        id: 'source_error',
        maximum: latestLedgerConfidence.sourceErrorCap,
        applies: sourceErrorsCount > 0,
      },
    ],
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

  const degraded =
    weightedObservations.length < latestLedgerProfile.minimumVerifiedSources ||
    sourceErrorsCount > 0 ||
    availabilityScore < 1 ||
    agreementScore < 1 ||
    confidenceResult.score < latestLedgerConfidence.verifiedThreshold

  return {
    metric: 'latest_ledger',
    value,
    status: degraded ? 'degraded' : 'verified',
    confidence: confidenceResult.score,
    confidence_formula_version: confidenceResult.formulaVersion,
    confidence_components: confidenceResult.components,
    confidence_caps_applied: confidenceResult.capsApplied,
    sources_configured: normalizedSourceCount,
    sources_responded: sourcesResponded,
    sources_usable: weightedObservations.length,
    sources_agreeing: agreeingObservations.length,
    sources_excluded: Math.max(0, sourcesExcluded),
    observations: weightedObservations,
    discrepancies,
    source_errors: sourceErrors,
    as_of: asOf.toISOString(),
    methodology_version: LATEST_LEDGER_METHODOLOGY_VERSION,
  }
}
