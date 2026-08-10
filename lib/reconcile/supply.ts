import { createHash } from 'node:crypto'
import {
  SUPPLY_COMPONENT_IDS,
  SUPPLY_METHODOLOGY_VERSION,
  supplyMethodologyConfig,
} from '../../config/methodology'
import {
  circulatingSupplyObservationSchema,
  creditAssetSchema,
  formatAssetId,
  sourceErrorSchema,
  type PersistedDiscrepancyState,
  type RawObservation,
  type SourceError,
  type SourceIdentity,
} from '../contracts/domain'
import { absoluteDelta, type StellarAmount } from '../stellar/amount'
import { classifyStellarAmountDeviationBand } from './discrepancy-state'
import {
  reconcileMetric,
  type MetricReconciliationProfile,
  type ReconcileMetricResult,
  type ReconciliationMethodologyConfig,
} from './orchestrator'

export type SupplyObservation = Extract<RawObservation, { metric: 'circulating_supply' }>

interface SupplyComparisonValue {
  amount: StellarAmount
  ledgerSequence: number
  sourceTimestamp: string
  components: SupplyObservation['components']
}

function exactAgreement(left: SupplyComparisonValue, right: SupplyComparisonValue) {
  return left.amount.equals(right.amount) &&
    left.ledgerSequence === right.ledgerSequence &&
    Date.parse(left.sourceTimestamp) === Date.parse(right.sourceTimestamp) &&
    SUPPLY_COMPONENT_IDS.every((component) => left.components[component].equals(right.components[component]))
}

const profile: MetricReconciliationProfile<SupplyObservation, SupplyComparisonValue> = {
  metric: 'circulating_supply',
  parseObservation: (input) => circulatingSupplyObservationSchema.parse(input),
  matchesSubject: (observation, subject) =>
    subject.kind === 'asset' && formatAssetId(observation.asset) === formatAssetId(subject.asset),
  getValue: (observation) => ({
    amount: observation.amount,
    ledgerSequence: observation.ledgerSequence,
    sourceTimestamp: observation.provenance.sourceTimestamp!,
    components: observation.components,
  }),
  compareValues: (left, right) => left.amount.compare(right.amount),
  agrees: exactAgreement,
  deviationBand: (observed, reference) => {
    if (exactAgreement(observed, reference)) return 'within_tolerance'
    const amountBand = classifyStellarAmountDeviationBand({
      absoluteDeviation: absoluteDelta(observed.amount, reference.amount),
      tolerance: absoluteDelta(reference.amount, reference.amount),
    })
    return amountBand === 'within_tolerance' ? 'above_info' : amountBand
  },
  spreadDistance: (observed, reference) => exactAgreement(observed, reference) ? 0 : 1,
  maximumSpreadDistance: 1,
  maximumObservationAgeSeconds: supplyMethodologyConfig.maximumObservationAgeSeconds,
  toMetricValue: (value) => ({ kind: 'amount', value: value.amount }),
  getDiscrepancyDetails: (observed, reference) => ({
    kind: 'supply_comparison',
    observedLedgerSequence: observed.ledgerSequence,
    referenceLedgerSequence: reference.ledgerSequence,
    observedSourceTimestamp: observed.sourceTimestamp,
    referenceSourceTimestamp: reference.sourceTimestamp,
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
  }),
  getUpstreamId: (observation) => observation.derivation.family,
  createDiscrepancyId: (observation) =>
    `supply_discrepancy_${createHash('sha256').update(observation.provenance.source.id).digest('hex')}`,
}

function methodology(): ReconciliationMethodologyConfig {
  const confidence = supplyMethodologyConfig.confidence
  return {
    version: SUPPLY_METHODOLOGY_VERSION,
    freshnessHalfLifeSeconds: supplyMethodologyConfig.freshnessHalfLifeSeconds,
    expectedSourceClasses: ['canonical_ledger', 'archive'],
    sourceClassBaseWeights: supplyMethodologyConfig.sourceClassBaseWeights,
    minimumVerifiedSources: supplyMethodologyConfig.minimumIndependentDerivations,
    verifiedThreshold: confidence.verifiedThreshold,
    confidenceFormulaVersion: confidence.formulaVersion,
    confidenceCoefficients: {
      agreement: confidence.agreementCoefficient,
      freshness: confidence.freshnessCoefficient,
      availability: confidence.availabilityCoefficient,
      spread: confidence.spreadCoefficient,
    },
    singleSourceCap: confidence.singleSourceCap,
    sameUpstreamCap: confidence.sameDerivationCap,
    sourceErrorCap: confidence.sourceErrorCap,
  }
}

export interface ReconcileSupplyInput {
  cycleId: string
  snapshotId: string
  asset: unknown
  configuredSources: readonly (SourceIdentity | unknown)[]
  observations: readonly unknown[]
  sourceErrors?: readonly (SourceError | unknown)[]
  priorDiscrepancyStates?: Readonly<Record<string, PersistedDiscrepancyState | unknown>>
  asOf: Date
}

export function reconcileSupply({
  cycleId,
  snapshotId,
  asset: assetInput,
  configuredSources,
  observations,
  sourceErrors = [],
  priorDiscrepancyStates = {},
  asOf,
}: ReconcileSupplyInput): ReconcileMetricResult {
  const asset = creditAssetSchema.parse(assetInput)
  return reconcileMetric({
    snapshotId,
    cycleId,
    subject: { kind: 'asset', asset },
    configuredSources,
    observations,
    sourceErrors: sourceErrors.map((error) => sourceErrorSchema.parse(error)),
    priorDiscrepancyStates,
    clock: () => new Date(asOf),
    methodology: methodology(),
    profile,
  })
}
