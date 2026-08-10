import { SOURCE_CLASS_IDS, type SourceClassId } from '../../config/methodology'
import {
  identifierSchema,
  metricSubjectSchema,
  persistedDiscrepancyStateSchema,
  reconciliationSnapshotSchema,
  sourceErrorSchema,
  sourceIdentitySchema,
  type MetricId,
  type MetricSubject,
  type MetricValue,
  type PersistedDiscrepancyState,
  type RawObservation,
  type ReconciliationSnapshot,
  type SourceIdentity,
} from '../contracts/domain'
import { computeAvailabilityScore, computeSourceClassDiversity, computeWeightedAgreement } from './agreement'
import { computeConfidence, type ConfidenceCoefficients } from './confidence'
import {
  advanceDiscrepancyState,
  type DeviationBand,
  type DiscrepancyMeasurementEvent,
} from './discrepancy-state'
import { computeEffectiveWeight } from './staleness'
import { computeWeightedMedian, type ValueComparator } from './weighted-median'

interface ObservationBase {
  observationId: string
  cycleId: string
  metric: MetricId
  provenance: RawObservation['provenance']
}

export interface ReconciliationMethodologyConfig {
  version: string
  freshnessHalfLifeSeconds: number
  expectedSourceClasses: readonly SourceClassId[]
  sourceClassBaseWeights: Readonly<Record<SourceClassId, number>>
  minimumVerifiedSources: number
  verifiedThreshold: number
  confidenceFormulaVersion: string
  confidenceCoefficients: ConfidenceCoefficients
  singleSourceCap: number
  sameUpstreamCap: number
  sourceErrorCap: number
}

export interface MetricReconciliationProfile<TObservation extends ObservationBase, TValue> {
  metric: TObservation['metric']
  parseObservation: (input: unknown) => TObservation
  matchesSubject: (observation: TObservation, subject: MetricSubject) => boolean
  getValue: (observation: TObservation) => TValue
  getBaseWeight?: (observation: TObservation, configuredBaseWeight: number) => number
  compareValues: ValueComparator<TValue>
  agrees: (observed: TValue, reference: TValue) => boolean
  deviationBand: (observed: TValue, reference: TValue) => DeviationBand
  spreadDistance: (observed: TValue, reference: TValue) => number
  maximumSpreadDistance: number
  toMetricValue: (value: TValue) => MetricValue
  isNamedParty?: (observation: TObservation) => boolean
  getUpstreamId?: (observation: TObservation) => string
  createDiscrepancyId?: (observation: TObservation) => string
}

export interface ReconcileMetricInput<TObservation extends ObservationBase, TValue> {
  snapshotId: string
  cycleId: string
  subject: MetricSubject | unknown
  configuredSources: readonly (SourceIdentity | unknown)[]
  observations: readonly unknown[]
  sourceErrors?: readonly unknown[]
  priorDiscrepancyStates?: Readonly<Record<string, PersistedDiscrepancyState | unknown>>
  clock: () => Date
  methodology: ReconciliationMethodologyConfig
  profile: MetricReconciliationProfile<TObservation, TValue>
}

export interface ReconcileMetricResult {
  snapshot: ReconciliationSnapshot
  discrepancyStates: Readonly<Record<string, PersistedDiscrepancyState>>
  events: readonly DiscrepancyMeasurementEvent[]
}

interface WeightedObservation<TObservation, TValue> {
  observation: TObservation
  value: TValue
  ageSeconds: number
  baseWeight: number
  effectiveWeight: number
}

const EXCLUSION_CODES = new Set(['network_mismatch', 'excluded_source'])
const NO_RESPONSE_CODES = new Set(['request_failed', 'request_aborted'])

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function assertMethodology(methodology: ReconciliationMethodologyConfig) {
  if (!methodology.version.trim()) throw new Error('methodology.version must not be empty')
  if (!methodology.confidenceFormulaVersion.trim()) {
    throw new Error('methodology.confidenceFormulaVersion must not be empty')
  }
  if (!Number.isFinite(methodology.freshnessHalfLifeSeconds) || methodology.freshnessHalfLifeSeconds <= 0) {
    throw new Error('methodology.freshnessHalfLifeSeconds must be greater than zero')
  }
  if (!Number.isSafeInteger(methodology.minimumVerifiedSources) || methodology.minimumVerifiedSources < 1) {
    throw new Error('methodology.minimumVerifiedSources must be a positive safe integer')
  }
  if (!Number.isFinite(methodology.verifiedThreshold) || methodology.verifiedThreshold < 0 || methodology.verifiedThreshold > 1) {
    throw new Error('methodology.verifiedThreshold must be from 0 to 1')
  }
  if (!Number.isFinite(methodology.singleSourceCap) || methodology.singleSourceCap < 0 || methodology.singleSourceCap > 1) {
    throw new Error('methodology.singleSourceCap must be from 0 to 1')
  }
  if (!Number.isFinite(methodology.sameUpstreamCap) || methodology.sameUpstreamCap < 0 || methodology.sameUpstreamCap > 1) {
    throw new Error('methodology.sameUpstreamCap must be from 0 to 1')
  }
  if (!Number.isFinite(methodology.sourceErrorCap) || methodology.sourceErrorCap < 0 || methodology.sourceErrorCap > 1) {
    throw new Error('methodology.sourceErrorCap must be from 0 to 1')
  }
  if (methodology.expectedSourceClasses.length === 0) {
    throw new Error('methodology.expectedSourceClasses must not be empty')
  }
  const expectedClasses = new Set(methodology.expectedSourceClasses)
  if (expectedClasses.size !== methodology.expectedSourceClasses.length) {
    throw new Error('methodology.expectedSourceClasses must not contain duplicates')
  }
  for (const sourceClass of methodology.expectedSourceClasses) {
    if (!SOURCE_CLASS_IDS.includes(sourceClass)) {
      throw new Error(`unknown expected source class: ${sourceClass}`)
    }
  }
  for (const sourceClass of SOURCE_CLASS_IDS) {
    const baseWeight = methodology.sourceClassBaseWeights[sourceClass]
    if (!Number.isFinite(baseWeight) || baseWeight <= 0 || baseWeight > 1) {
      throw new Error(`base weight for ${sourceClass} must be finite and from 0 exclusive to 1 inclusive`)
    }
  }
  computeConfidence({
    formulaVersion: methodology.confidenceFormulaVersion,
    components: { agreement: 1, freshness: 1, availability: 1, diversity: 1, spread: 1 },
    coefficients: methodology.confidenceCoefficients,
  })
}

function sameSource(left: SourceIdentity, right: SourceIdentity) {
  return (
    left.id === right.id &&
    left.sourceClass === right.sourceClass &&
    left.adapter === right.adapter &&
    left.url === right.url &&
    left.network.id === right.network.id &&
    left.network.passphrase === right.network.passphrase
  )
}

function defaultDiscrepancyId(observation: ObservationBase) {
  return identifierSchema.parse(observation.observationId)
}

function unavailableConfidence(methodology: ReconciliationMethodologyConfig) {
  return {
    score: 0,
    formulaVersion: methodology.confidenceFormulaVersion,
    components: { agreement: 0, freshness: 0, availability: 0, diversity: 0, spread: 0 },
    capsApplied: [] as string[],
  }
}

/**
 * Runs a complete reconciliation cycle. All trust-boundary inputs are parsed before a snapshot is returned;
 * callers either receive one immutable result or an exception, never a partial snapshot.
 */
export function reconcileMetric<TObservation extends ObservationBase, TValue>({
  snapshotId,
  cycleId,
  subject: subjectInput,
  configuredSources: configuredSourceInputs,
  observations: observationInputs,
  sourceErrors: sourceErrorInputs = [],
  priorDiscrepancyStates: priorStateInputs = {},
  clock,
  methodology,
  profile,
}: ReconcileMetricInput<TObservation, TValue>): ReconcileMetricResult {
  identifierSchema.parse(snapshotId)
  identifierSchema.parse(cycleId)
  assertMethodology(methodology)
  if (profile.maximumSpreadDistance <= 0 || !Number.isFinite(profile.maximumSpreadDistance)) {
    throw new Error('profile.maximumSpreadDistance must be finite and greater than zero')
  }

  const now = clock()
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('clock must return a valid Date')
  const asOf = now.toISOString()
  const subject = metricSubjectSchema.parse(subjectInput)
  const configuredSources = configuredSourceInputs.map((source) => sourceIdentitySchema.parse(source))
  const configuredById = new Map<string, SourceIdentity>()
  for (const source of configuredSources) {
    if (configuredById.has(source.id)) throw new Error(`duplicate configured source: ${source.id}`)
    configuredById.set(source.id, source)
  }

  const observations = observationInputs.map((observation) => profile.parseObservation(observation))
  const observationIds = new Set<string>()
  const observationSourceIds = new Set<string>()
  for (const observation of observations) {
    if (observation.metric !== profile.metric) throw new Error('observation metric does not match profile')
    if (!profile.matchesSubject(observation, subject)) {
      throw new Error(`observation ${observation.observationId} does not match the requested subject`)
    }
    if (observation.cycleId !== cycleId) throw new Error(`observation ${observation.observationId} belongs to another cycle`)
    if (observationIds.has(observation.observationId)) {
      throw new Error(`duplicate observation ID: ${observation.observationId}`)
    }
    if (observationSourceIds.has(observation.provenance.source.id)) {
      throw new Error(`multiple observations for source: ${observation.provenance.source.id}`)
    }
    observationIds.add(observation.observationId)
    observationSourceIds.add(observation.provenance.source.id)
    const configuredSource = configuredById.get(observation.provenance.source.id)
    if (!configuredSource || !sameSource(configuredSource, observation.provenance.source)) {
      throw new Error(`observation source ${observation.provenance.source.id} is not configured exactly`)
    }
  }

  const sourceErrors = sourceErrorInputs.map((error) => sourceErrorSchema.parse(error))
  for (const error of sourceErrors) {
    if (error.sourceId && !configuredById.has(error.sourceId)) {
      throw new Error(`source error references unconfigured source: ${error.sourceId}`)
    }
    if (error.sourceId && error.sourceUrl && error.sourceUrl !== configuredById.get(error.sourceId)?.url) {
      throw new Error(`source error URL does not match configured source: ${error.sourceId}`)
    }
  }
  const sortedErrors = [...sourceErrors].sort((left, right) =>
    compareText(`${left.sourceId ?? ''}:${left.code}:${left.occurredAt}`, `${right.sourceId ?? ''}:${right.code}:${right.occurredAt}`),
  )
  const erroredSourceIds = new Set(sourceErrors.flatMap((error) => (error.sourceId ? [error.sourceId] : [])))

  const priorStates = new Map<string, PersistedDiscrepancyState>()
  for (const [sourceId, stateInput] of Object.entries(priorStateInputs)) {
    identifierSchema.parse(sourceId)
    const state = persistedDiscrepancyStateSchema.parse(stateInput)
    if (state.sourceId !== sourceId) throw new Error(`prior state key does not match source: ${sourceId}`)
    if (!configuredById.has(sourceId)) throw new Error(`prior state references unconfigured source: ${sourceId}`)
    priorStates.set(sourceId, state)
  }

  const eligibleObservations = observations
    .filter((observation) => !erroredSourceIds.has(observation.provenance.source.id))
    .sort((left, right) => compareText(left.observationId, right.observationId))
  const weighted: WeightedObservation<TObservation, TValue>[] = eligibleObservations.map((observation) => {
    const sourceClass = observation.provenance.source.sourceClass
    const configuredBaseWeight = methodology.sourceClassBaseWeights[sourceClass]
    const baseWeight = profile.getBaseWeight?.(observation, configuredBaseWeight) ?? configuredBaseWeight
    if (!Number.isFinite(baseWeight) || baseWeight <= 0) {
      throw new Error(`missing positive base weight for source class: ${sourceClass}`)
    }
    const freshness = computeEffectiveWeight({
      baseWeight,
      sourceTimestamp: observation.provenance.sourceTimestamp,
      retrievedAt: observation.provenance.retrievedAt,
      now,
      halfLifeSeconds: methodology.freshnessHalfLifeSeconds,
    })
    return {
      observation,
      value: profile.getValue(observation),
      ageSeconds: freshness.ageSeconds,
      baseWeight,
      effectiveWeight: freshness.effectiveWeight,
    }
  })
  const usable = weighted.filter((item) => item.effectiveWeight > 0)
  const median = computeWeightedMedian(
    usable.map((item) => ({
      id: item.observation.observationId,
      value: item.value,
      effectiveWeight: item.effectiveWeight,
    })),
    profile.compareValues,
  )

  const respondedSourceIds = new Set(observations.map((observation) => observation.provenance.source.id))
  sourceErrors.forEach((error) => {
    if (error.sourceId && !NO_RESPONSE_CODES.has(error.code)) respondedSourceIds.add(error.sourceId)
  })
  const sourcesExcluded = new Set(
    sourceErrors.flatMap((error) => (error.sourceId && EXCLUSION_CODES.has(error.code) ? [error.sourceId] : [])),
  ).size

  if (!median) {
    const snapshot = reconciliationSnapshotSchema.parse({
      snapshotId,
      cycleId,
      metric: profile.metric,
      subject,
      status: 'unavailable',
      value: null,
      confidence: unavailableConfidence(methodology),
      sourcesConfigured: configuredSources.length,
      sourcesResponded: respondedSourceIds.size,
      sourcesUsable: 0,
      sourcesAgreeing: 0,
      sourcesExcluded,
      contributions: [],
      discrepancies: [],
      sourceErrors: sortedErrors,
      asOf,
      methodologyVersion: methodology.version,
    })
    return deepFreeze({
      snapshot,
      discrepancyStates: Object.fromEntries(
        [...priorStates.entries()].sort(([left], [right]) => compareText(left, right)),
      ),
      events: [],
    })
  }

  const reference = median.value
  const evaluated = usable.map((item) => ({
    ...item,
    agrees: profile.agrees(item.value, reference),
    deviationBand: profile.deviationBand(item.value, reference),
    spreadDistance: profile.spreadDistance(item.value, reference),
  }))
  evaluated.forEach((item) => {
    if (!Number.isFinite(item.spreadDistance) || item.spreadDistance < 0) {
      throw new Error(`spread distance for ${item.observation.observationId} must be finite and non-negative`)
    }
    if ((item.deviationBand === 'within_tolerance') !== item.agrees) {
      throw new Error(`agreement and deviation band disagree for ${item.observation.observationId}`)
    }
  })

  const agreementScore = computeWeightedAgreement(evaluated).score
  const totalBaseWeight = evaluated.reduce((total, item) => total + item.baseWeight, 0)
  const totalEffectiveWeight = evaluated.reduce((total, item) => total + item.effectiveWeight, 0)
  const freshnessScore = totalBaseWeight === 0 ? 0 : totalEffectiveWeight / totalBaseWeight
  const availabilityScore = computeAvailabilityScore({
    usableSources: evaluated.length,
    configuredSources: configuredSources.length,
  })
  const diversityScore = computeSourceClassDiversity({
    representedSourceClasses: evaluated.map((item) => item.observation.provenance.source.sourceClass),
    expectedSourceClasses: methodology.expectedSourceClasses,
  }).score
  const maximumObservedSpread = Math.max(0, ...evaluated.map((item) => item.spreadDistance))
  const spreadScore = 1 - Math.min(1, maximumObservedSpread / profile.maximumSpreadDistance)
  const upstreamIds = evaluated.map((item) =>
    (profile.getUpstreamId?.(item.observation) ?? item.observation.provenance.source.id).trim(),
  )
  upstreamIds.forEach((upstreamId, index) => {
    if (!upstreamId.trim()) throw new Error(`upstream ID for observation ${evaluated[index]?.observation.observationId} is empty`)
  })
  const uniqueUpstreams = new Set(upstreamIds).size
  const confidence = computeConfidence({
    formulaVersion: methodology.confidenceFormulaVersion,
    components: {
      agreement: agreementScore,
      freshness: freshnessScore,
      availability: availabilityScore,
      diversity: diversityScore,
      spread: spreadScore,
    },
    coefficients: methodology.confidenceCoefficients,
    caps: [
      { id: 'single_source', maximum: methodology.singleSourceCap, applies: evaluated.length === 1 },
      {
        id: 'same_upstream_replicas',
        maximum: methodology.sameUpstreamCap,
        applies: evaluated.length > 1 && uniqueUpstreams === 1,
      },
      { id: 'source_error', maximum: methodology.sourceErrorCap, applies: sourceErrors.length > 0 },
    ],
  })
  const domainConfidence = {
    score: confidence.score,
    formulaVersion: confidence.formulaVersion,
    components: confidence.components,
    capsApplied: confidence.capsApplied,
  }

  const discrepancyStates: Record<string, PersistedDiscrepancyState> = Object.fromEntries(priorStates)
  const events: DiscrepancyMeasurementEvent[] = []
  const discrepancies: ReconciliationSnapshot['discrepancies'] = []
  for (const item of evaluated) {
    const sourceId = item.observation.provenance.source.id
    const priorState = priorStates.get(sourceId)
    const result = advanceDiscrepancyState({
      priorState,
      discrepancyId:
        priorState?.lifecycleState === 'open'
          ? priorState.discrepancyId
          : profile.createDiscrepancyId?.(item.observation) ?? defaultDiscrepancyId(item.observation),
      sourceId,
      namedParty: profile.isNamedParty?.(item.observation) ?? false,
      methodologyVersion: methodology.version,
      cycle: {
        cycleId,
        completedAt: asOf,
        deviationBand: item.deviationBand,
      },
    })
    if (result.ignoredReason) {
      throw new Error(`cycle ${cycleId} is ${result.ignoredReason.replaceAll('_', ' ')} for source ${sourceId}`)
    }
    events.push(...result.events)
    if (!result.state) continue
    discrepancyStates[sourceId] = result.state
    discrepancies.push({
      id: result.state.discrepancyId,
      sourceId,
      severity: result.state.severity,
      lifecycleState: result.state.lifecycleState,
      publicationState: result.state.publicationState,
      consecutiveCycles: result.state.consecutiveCycles,
      observedValue: profile.toMetricValue(item.value),
      referenceValue: profile.toMetricValue(reference),
      firstObservedAt: result.state.firstObservedAt,
      lastObservedAt: result.state.lastObservedAt,
    })
  }

  const degraded =
    evaluated.length < methodology.minimumVerifiedSources ||
    sourceErrors.length > 0 ||
    sourcesExcluded > 0 ||
    availabilityScore < 1 ||
    agreementScore < 1 ||
    confidence.score < methodology.verifiedThreshold
  const snapshot = reconciliationSnapshotSchema.parse({
    snapshotId,
    cycleId,
    metric: profile.metric,
    subject,
    status: degraded ? 'degraded' : 'verified',
    value: profile.toMetricValue(reference),
    confidence: domainConfidence,
    sourcesConfigured: configuredSources.length,
    sourcesResponded: respondedSourceIds.size,
    sourcesUsable: evaluated.length,
    sourcesAgreeing: evaluated.filter((item) => item.agrees).length,
    sourcesExcluded,
    contributions: evaluated.map((item) => ({
      observationId: item.observation.observationId,
      sourceId: item.observation.provenance.source.id,
      sourceClass: item.observation.provenance.source.sourceClass,
      ageSeconds: item.ageSeconds,
      effectiveWeight: item.effectiveWeight,
      agrees: item.agrees,
    })),
    discrepancies: discrepancies.sort((left, right) => compareText(left.sourceId, right.sourceId)),
    sourceErrors: sortedErrors,
    asOf,
    methodologyVersion: methodology.version,
  })

  return deepFreeze({
    snapshot,
    discrepancyStates: Object.fromEntries(Object.entries(discrepancyStates).sort(([left], [right]) => compareText(left, right))),
    events: events.sort((left, right) => compareText(left.eventId, right.eventId)),
  })
}
