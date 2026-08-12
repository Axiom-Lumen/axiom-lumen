import { createHash } from 'node:crypto'
import {
  ANCHOR_RESERVE_METHODOLOGY_VERSION,
  anchorReserveMethodologyConfig,
  MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION,
  mzarAnchorReserveMethodologyConfig,
} from '../../config/methodology'
import {
  anchorReservesObservationSchema,
  creditAssetSchema,
  reconciliationSnapshotSchema,
  sourceErrorSchema,
  sourceIdentitySchema,
  type PersistedDiscrepancyState,
  type SourceError,
  type SourceIdentity,
} from '../contracts/domain'
import { absoluteDelta, isWithinBasisPoints, relativeDelta, type StellarAmount } from '../stellar/amount'
import { advanceDiscrepancyState, type DeviationBand } from './discrepancy-state'

export interface SupplyReference {
  snapshotId: string
  cycleId: string
  amount: StellarAmount
  asOf: string
  ledgerSequence: number
  ledgerClosedAt: string
  status: 'verified' | 'degraded'
  confidence: number
  methodologyVersion: string
  evidence: readonly { readingId: string; observationId: string; sourceId: string; payloadSha256: string; ledgerSequence: number; ledgerClosedAt: string }[]
}

type AnchorReserveMethodologyVersion = typeof ANCHOR_RESERVE_METHODOLOGY_VERSION | typeof MZAR_ANCHOR_RESERVE_METHODOLOGY_VERSION

function methodology(version: AnchorReserveMethodologyVersion) {
  if (version === ANCHOR_RESERVE_METHODOLOGY_VERSION) return {
    ...anchorReserveMethodologyConfig,
    maximumReferenceSkewSeconds: anchorReserveMethodologyConfig.maximumPeriodSkewSeconds,
  }
  return mzarAnchorReserveMethodologyConfig
}

function discrepancyId(anchorId: string, sourceId: string, methodologyVersion: AnchorReserveMethodologyVersion) {
  const identity = methodologyVersion === ANCHOR_RESERVE_METHODOLOGY_VERSION
    ? `${anchorId}\0${sourceId}`
    : `${anchorId}\0${sourceId}\0${methodologyVersion}`
  return `anchor_reserve_${createHash('sha256').update(identity).digest('hex')}`
}

function deviationBand(observed: StellarAmount, reference: StellarAmount, toleranceBasisPoints: number): DeviationBand {
  const tolerance = BigInt(toleranceBasisPoints)
  if (isWithinBasisPoints(observed, reference, tolerance)) return 'within_tolerance'
  if (isWithinBasisPoints(observed, reference, tolerance * 2n)) return 'info'
  return 'above_info'
}

function deltaBasisPoints(observed: StellarAmount, reference: StellarAmount) {
  const delta = relativeDelta(observed, reference)
  if (!delta) return observed.isZero() ? 0 : 10_000
  const scaled = delta.numerator * 100_000_000n / delta.denominator
  return Number(scaled > 100_000_000n ? 100_000_000n : scaled) / 10_000
}

export function reconcileAnchorReserve(input: {
  cycleId: string
  snapshotId: string
  asset: unknown
  anchorId: string
  configuredSource: SourceIdentity | unknown
  observation?: unknown
  sourceErrors?: readonly (SourceError | unknown)[]
  supplyReference?: SupplyReference | null
  priorState?: PersistedDiscrepancyState | null
  methodologyVersion?: AnchorReserveMethodologyVersion
  asOf: Date
}) {
  const asset = creditAssetSchema.parse(input.asset)
  const source = sourceIdentitySchema.parse(input.configuredSource)
  const errors = (input.sourceErrors ?? []).map((candidate) => sourceErrorSchema.parse(candidate))
  const asOf = input.asOf.toISOString()
  const observation = input.observation === undefined ? null : anchorReservesObservationSchema.parse(input.observation)
  const supplyReference = input.supplyReference ?? null
  const methodologyVersion = input.methodologyVersion ?? ANCHOR_RESERVE_METHODOLOGY_VERSION
  const config = methodology(methodologyVersion)
  if (observation && observation.anchorId !== input.anchorId) throw new Error('reserve observation anchor does not match the requested anchor')
  if (observation && observation.methodologyVersion !== methodologyVersion) throw new Error('reserve observation methodology does not match the requested profile')

  if (!observation || !supplyReference) {
    return {
      snapshot: reconciliationSnapshotSchema.parse({
        snapshotId: input.snapshotId,
        cycleId: input.cycleId,
        metric: 'anchor_reserves',
        subject: { kind: 'asset', asset },
        status: 'unavailable',
        value: null,
        confidence: { score: 0, formulaVersion: config.confidence.formulaVersion, components: { attestation: 0, reference: 0, temporal_alignment: 0 }, capsApplied: ['reference_or_attestation_unavailable'] },
        sourcesConfigured: 1,
        sourcesResponded: observation || errors.some((error) => error.httpStatus !== undefined) ? 1 : 0,
        sourcesUsable: 0,
        sourcesAgreeing: 0,
        sourcesExcluded: errors.some((error) => error.code === 'excluded_source') ? 1 : 0,
        contributions: [],
        discrepancies: [],
        sourceErrors: errors,
        asOf,
        methodologyVersion,
      }),
      discrepancyStates: input.priorState ? { [source.id]: input.priorState } : {},
      events: [],
    }
  }

  const reference = supplyReference
  const band = deviationBand(observation.amount, reference.amount, config.toleranceBasisPoints)
  const id = discrepancyId(input.anchorId, source.id, methodologyVersion)
  const advanced = advanceDiscrepancyState({
    priorState: input.priorState,
    discrepancyId: id,
    sourceId: source.id,
    namedParty: true,
    methodologyVersion,
    cycle: { cycleId: input.cycleId, completedAt: asOf, deviationBand: band },
  })
  const ageSeconds = Math.max(0, (input.asOf.getTime() - Date.parse(observation.attestationPeriodEnd)) / 1_000)
  const skewSeconds = Math.abs(Date.parse(observation.attestationPeriodEnd) - Date.parse(reference.ledgerClosedAt)) / 1_000
  const temporalAlignment = Math.max(0, 1 - skewSeconds / config.maximumReferenceSkewSeconds)
  const confidence = config.confidence
  const score = Math.min(confidence.selfReportedCap, confidence.selfReportedBase + reference.confidence * confidence.supplyReferenceCoefficient + temporalAlignment * confidence.temporalAlignmentCoefficient)
  const state = advanced.state
  const discrepancies = state?.lifecycleState === 'open' ? [{
    id: state.discrepancyId,
    sourceId: source.id,
    severity: state.severity,
    lifecycleState: state.lifecycleState,
    publicationState: state.publicationState,
    consecutiveCycles: state.consecutiveCycles,
    observedValue: { kind: 'amount' as const, value: observation.amount },
    referenceValue: { kind: 'amount' as const, value: reference.amount },
    details: {
      kind: 'anchor_reserve_comparison' as const,
      anchorId: input.anchorId,
      attestationPeriodEnd: observation.attestationPeriodEnd,
      supplyAsOf: reference.asOf,
      supplySnapshotId: reference.snapshotId,
      supplyLedgerSequence: reference.ledgerSequence,
      supplyLedgerClosedAt: reference.ledgerClosedAt,
      absoluteDelta: absoluteDelta(observation.amount, reference.amount),
      deltaBasisPoints: deltaBasisPoints(observation.amount, reference.amount),
    },
    firstObservedAt: state.firstObservedAt,
    lastObservedAt: state.lastObservedAt,
  }] : []

  return {
    snapshot: reconciliationSnapshotSchema.parse({
      snapshotId: input.snapshotId,
      cycleId: input.cycleId,
      metric: 'anchor_reserves',
      subject: { kind: 'asset', asset },
      status: 'degraded',
      value: { kind: 'amount', value: observation.amount },
      confidence: {
        score,
        formulaVersion: confidence.formulaVersion,
        components: { attestation: 1, reference: reference.confidence, temporal_alignment: temporalAlignment },
        capsApplied: ['anchor_self_reported', 'named_party_publication_withheld'],
      },
      sourcesConfigured: 1,
      sourcesResponded: 1,
      sourcesUsable: 1,
      sourcesAgreeing: band === 'within_tolerance' ? 1 : 0,
      sourcesExcluded: 0,
      contributions: [{ observationId: observation.observationId, sourceId: source.id, sourceClass: source.sourceClass, ageSeconds, effectiveWeight: confidence.effectiveWeight, agrees: band === 'within_tolerance' }],
      discrepancies,
      sourceErrors: errors,
      asOf,
      methodologyVersion,
    }),
    discrepancyStates: state ? { [source.id]: state } : {},
    events: advanced.events,
  }
}
