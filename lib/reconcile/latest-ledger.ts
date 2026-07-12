export const LATEST_LEDGER_METHODOLOGY_VERSION = 'latest-ledger-v0.1'
export const DEFAULT_HORIZON_HALF_LIFE_SECONDS = 30
export const DEFAULT_HORIZON_BASE_WEIGHT = 1

export type LatestLedgerStatus = 'verified' | 'degraded' | 'unavailable'
export type LedgerDiscrepancySeverity = 'info' | 'warning' | 'critical'

export interface LatestLedgerObservation {
  sourceId: string
  sourceUrl: string
  ledgerSequence: number
  closedAt: string
  retrievedAt: string
  baseWeight?: number
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
  asOf?: Date
  halfLifeSeconds?: number
}

export interface LatestLedgerReconciliationResult {
  metric: 'latest_ledger'
  value: number | null
  status: LatestLedgerStatus
  confidence: number
  sources_configured: number
  sources_responded: number
  sources_usable: number
  sources_agreeing: number
  observations: WeightedLatestLedgerObservation[]
  discrepancies: LatestLedgerDiscrepancy[]
  source_errors: LatestLedgerSourceError[]
  as_of: string
  methodology_version: typeof LATEST_LEDGER_METHODOLOGY_VERSION
}

function didSourceRespond(error: LatestLedgerSourceError) {
  return !['request_aborted', 'request_failed'].includes(error.code)
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
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

  // A Horizon latest-ledger source loses half its vote every 30 seconds after ledger close by default.
  return baseWeight * 0.5 ** (Math.max(0, ageSeconds) / halfLifeSeconds)
}

function parseTime(value: string) {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : Number.NaN
}

function weightedMedian(observations: { ledgerSequence: number; effectiveWeight: number }[]) {
  const usable = observations
    .filter((observation) => observation.effectiveWeight > 0)
    .sort((a, b) => a.ledgerSequence - b.ledgerSequence)
  const totalWeight = usable.reduce((sum, observation) => sum + observation.effectiveWeight, 0)
  const midpoint = totalWeight / 2
  let runningWeight = 0

  for (const observation of usable) {
    runningWeight += observation.effectiveWeight
    if (runningWeight >= midpoint) return observation.ledgerSequence
  }

  return null
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
  asOf = new Date(),
  halfLifeSeconds = DEFAULT_HORIZON_HALF_LIFE_SECONDS,
}: LatestLedgerReconciliationInput): LatestLedgerReconciliationResult {
  const asOfMs = asOf.getTime()
  const sourceErrorsCount = sourceErrors.length
  const sourcesResponded = observations.length + sourceErrors.filter(didSourceRespond).length
  const normalizedSourceCount = Math.max(0, sourcesConfigured)
  const sourceErrorIds = new Set(sourceErrors.map((error) => error.sourceId))
  const usableObservations = observations.filter((observation) => {
    return (
      !sourceErrorIds.has(observation.sourceId) &&
      Number.isSafeInteger(observation.ledgerSequence) &&
      Number.isFinite(parseTime(observation.closedAt)) &&
      Number.isFinite(parseTime(observation.retrievedAt))
    )
  })

  const preliminaryWeighted = usableObservations.map((observation) => {
    const closedAtMs = parseTime(observation.closedAt)
    const ageSeconds = Math.max(0, (asOfMs - closedAtMs) / 1000)
    const effectiveWeight = computeFreshnessWeight({
      baseWeight: observation.baseWeight ?? DEFAULT_HORIZON_BASE_WEIGHT,
      ageSeconds,
      halfLifeSeconds,
    })

    return {
      ...observation,
      ageSeconds,
      effectiveWeight,
      agrees: false,
      ledgerDelta: 0,
    }
  })

  const value = weightedMedian(preliminaryWeighted)

  if (value === null) {
    return {
      metric: 'latest_ledger',
      value: null,
      status: 'unavailable',
      confidence: 0,
      sources_configured: normalizedSourceCount,
      sources_responded: sourcesResponded,
      sources_usable: 0,
      sources_agreeing: 0,
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
      agrees: Math.abs(ledgerDelta) <= 1,
    }
  })
  const totalEffectiveWeight = weightedObservations.reduce(
    (sum, observation) => sum + observation.effectiveWeight,
    0,
  )
  const totalBaseWeight = weightedObservations.reduce(
    (sum, observation) => sum + (observation.baseWeight ?? DEFAULT_HORIZON_BASE_WEIGHT),
    0,
  )
  const agreeingObservations = weightedObservations.filter((observation) => observation.agrees)
  const agreeingWeight = agreeingObservations.reduce(
    (sum, observation) => sum + observation.effectiveWeight,
    0,
  )
  const maxLedgerDelta = Math.max(
    0,
    ...weightedObservations.map((observation) => Math.abs(observation.ledgerDelta)),
  )
  const availabilityScore =
    normalizedSourceCount === 0 ? 0 : weightedObservations.length / normalizedSourceCount
  const agreementScore = totalEffectiveWeight === 0 ? 0 : agreeingWeight / totalEffectiveWeight
  const freshnessScore = totalBaseWeight === 0 ? 0 : totalEffectiveWeight / totalBaseWeight
  const spreadScore = 1 - Math.min(1, maxLedgerDelta / 5)
  let confidence = clamp01(
    agreementScore * 0.5 + freshnessScore * 0.25 + availabilityScore * 0.2 + spreadScore * 0.05,
  )

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
    weightedObservations.length < 2 ||
    sourceErrorsCount > 0 ||
    availabilityScore < 1 ||
    agreementScore < 1 ||
    confidence < 0.9

  if (weightedObservations.length === 1) confidence = Math.min(confidence, 0.6)
  if (sourceErrorsCount > 0) confidence = Math.min(confidence, 0.85)

  return {
    metric: 'latest_ledger',
    value,
    status: degraded ? 'degraded' : 'verified',
    confidence: Number(confidence.toFixed(4)),
    sources_configured: normalizedSourceCount,
    sources_responded: sourcesResponded,
    sources_usable: weightedObservations.length,
    sources_agreeing: agreeingObservations.length,
    observations: weightedObservations,
    discrepancies,
    source_errors: sourceErrors,
    as_of: asOf.toISOString(),
    methodology_version: LATEST_LEDGER_METHODOLOGY_VERSION,
  }
}
