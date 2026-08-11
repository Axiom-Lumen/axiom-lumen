import { createHash } from 'node:crypto'
import {
  TRUSTLINE_METHODOLOGY_VERSION,
  TRUSTLINE_STATE_IDS,
  trustlineMethodologyConfig,
} from '../../config/methodology'
import {
  creditAssetSchema,
  formatAssetId,
  sourceErrorSchema,
  trustlineCountObservationSchema,
  type PersistedDiscrepancyState,
  type RawObservation,
  type SourceError,
  type SourceIdentity,
} from '../contracts/domain'
import { reconcileMetric, type MetricReconciliationProfile, type ReconciliationMethodologyConfig } from './orchestrator'

export type TrustlineObservation = Extract<RawObservation, { metric: 'trustline_count' }>
type TrustlineValue = Pick<TrustlineObservation, 'total' | 'states' | 'ledgerSequence'> & { sourceTimestamp: string }
function exact(left: TrustlineValue, right: TrustlineValue) {
  return left.ledgerSequence === right.ledgerSequence &&
    left.sourceTimestamp === right.sourceTimestamp &&
    left.total === right.total &&
    TRUSTLINE_STATE_IDS.every((state) => left.states[state] === right.states[state])
}
function delta(left: bigint, right: bigint) { return left >= right ? left - right : right - left }

const profile: MetricReconciliationProfile<TrustlineObservation, TrustlineValue> = {
  metric: 'trustline_count',
  parseObservation: (input) => trustlineCountObservationSchema.parse(input),
  matchesSubject: (observation, subject) => subject.kind === 'asset' && formatAssetId(observation.asset) === formatAssetId(subject.asset),
  getValue: (observation) => ({ total: observation.total, states: observation.states, ledgerSequence: observation.ledgerSequence, sourceTimestamp: observation.provenance.sourceTimestamp! }),
  compareValues: (left, right) => left.total < right.total ? -1 : left.total > right.total ? 1 : 0,
  agrees: exact,
  deviationBand: (observed, reference) => exact(observed, reference) ? 'within_tolerance' : 'above_info',
  spreadDistance: (observed, reference) => {
    if (reference.total === 0n) return observed.total === 0n ? 0 : 1
    const bps = delta(observed.total, reference.total) * 10_000n / reference.total
    return Math.min(1, Number(bps > 10_000n ? 10_000n : bps) / 10_000)
  },
  maximumSpreadDistance: 1,
  maximumObservationAgeSeconds: trustlineMethodologyConfig.maximumObservationAgeSeconds,
  toMetricValue: (value) => ({ kind: 'trustline_state', total: value.total, states: value.states, ledgerSequence: value.ledgerSequence, ledgerClosedAt: value.sourceTimestamp }),
  getDiscrepancyDetails: (observed, reference) => ({
    kind: 'trustline_comparison', observedLedgerSequence: observed.ledgerSequence, referenceLedgerSequence: reference.ledgerSequence,
    observedSourceTimestamp: observed.sourceTimestamp, referenceSourceTimestamp: reference.sourceTimestamp,
    stateDifferences: TRUSTLINE_STATE_IDS.flatMap((state) => observed.states[state] === reference.states[state] ? [] : [{ state, observed: observed.states[state], reference: reference.states[state], absoluteDelta: delta(observed.states[state], reference.states[state]) }]),
  }),
  getUpstreamId: (observation) => observation.derivation.family,
  createDiscrepancyId: (observation) => `trustline_discrepancy_${createHash('sha256').update(observation.provenance.source.id).digest('hex')}`,
}

function methodology(): ReconciliationMethodologyConfig {
  const config = trustlineMethodologyConfig
  return {
    version: TRUSTLINE_METHODOLOGY_VERSION, freshnessHalfLifeSeconds: config.freshnessHalfLifeSeconds,
    expectedSourceClasses: ['canonical_ledger'], sourceClassBaseWeights: config.sourceClassBaseWeights,
    minimumVerifiedSources: config.minimumIndependentDerivations, verifiedThreshold: config.confidence.verifiedThreshold,
    confidenceFormulaVersion: config.confidence.formulaVersion,
    confidenceCoefficients: { agreement: config.confidence.agreementCoefficient, freshness: config.confidence.freshnessCoefficient, availability: config.confidence.availabilityCoefficient, spread: config.confidence.spreadCoefficient },
    singleSourceCap: config.confidence.singleSourceCap, sameUpstreamCap: config.confidence.sameDerivationCap, sourceErrorCap: config.confidence.sourceErrorCap,
  }
}

export function reconcileTrustlines(input: {
  cycleId: string; snapshotId: string; asset: unknown; configuredSources: readonly (SourceIdentity | unknown)[];
  observations: readonly unknown[]; sourceErrors?: readonly (SourceError | unknown)[];
  priorDiscrepancyStates?: Readonly<Record<string, PersistedDiscrepancyState | unknown>>; asOf: Date;
}) {
  const asset = creditAssetSchema.parse(input.asset)
  return reconcileMetric({ snapshotId: input.snapshotId, cycleId: input.cycleId, subject: { kind: 'asset', asset },
    configuredSources: input.configuredSources, observations: input.observations,
    sourceErrors: (input.sourceErrors ?? []).map((error) => sourceErrorSchema.parse(error)),
    priorDiscrepancyStates: input.priorDiscrepancyStates, clock: () => new Date(input.asOf), methodology: methodology(), profile })
}
