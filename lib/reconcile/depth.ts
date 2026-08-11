import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  DEPTH_PRICE_BANDS_BPS,
  DEPTH_RECONCILIATION_METHODOLOGY_VERSION,
  depthReconciliationMethodologyConfig,
} from '../../config/methodology'
import {
  formatTradingPairId,
  identifierSchema,
  observationProvenanceSchema,
  sourceErrorSchema,
  stellarAmountSchema,
  tradingPairSchema,
  utcTimestampSchema,
  type PersistedDiscrepancyState,
  type SourceError,
  type SourceIdentity,
} from '../contracts/domain'
import { absoluteDelta, StellarAmount } from '../stellar/amount'
import {
  reconcileMetric,
  type MetricReconciliationProfile,
  type ReconcileMetricResult,
  type ReconciliationMethodologyConfig,
} from './orchestrator'

const depthBandSchema = z.union([z.literal(50), z.literal(100), z.literal(500)])

export const depthBookObservationSchema = z.object({
  observationId: identifierSchema,
  cycleId: identifierSchema,
  metric: z.literal('order_book_depth'),
  pair: tradingPairSchema,
  buckets: z.array(z.object({
    side: z.enum(['bid', 'ask']),
    priceBandBasisPoints: depthBandSchema,
    amount: stellarAmountSchema,
  }).strict()).length(DEPTH_PRICE_BANDS_BPS.length * 2),
  referencePrice: z.object({
    numerator: z.string().regex(/^[1-9]\d*$/),
    denominator: z.string().regex(/^[1-9]\d*$/),
    decimal: z.string().regex(/^(0|[1-9]\d*)\.\d{7}$/),
  }).strict(),
  ledgerSequence: z.number().int().safe().positive(),
  ledgerClosedAt: utcTimestampSchema,
  provenance: observationProvenanceSchema,
  derivation: z.object({
    family: z.literal('horizon_sdex_offers'),
    connectorVersion: z.string().min(1).max(100),
    evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
}).strict().superRefine((book, context) => {
  if (book.provenance.sourceTimestamp !== book.ledgerClosedAt) context.addIssue({ code: z.ZodIssueCode.custom, path: ['provenance', 'sourceTimestamp'], message: 'depth source timestamp must equal ledger close time' })
  const scale = 10_000_000n
  const numerator = BigInt(book.referencePrice.numerator)
  const denominator = BigInt(book.referencePrice.denominator)
  let rounded = numerator * scale / denominator
  if ((numerator * scale % denominator) * 2n >= denominator) rounded += 1n
  const expectedDecimal = `${rounded / scale}.${(rounded % scale).toString().padStart(7, '0')}`
  if (book.referencePrice.decimal !== expectedDecimal) context.addIssue({ code: z.ZodIssueCode.custom, path: ['referencePrice', 'decimal'], message: 'depth reference decimal must match its exact ratio' })
  const keys = book.buckets.map((bucket) => `${bucket.side}:${bucket.priceBandBasisPoints}`)
  if (new Set(keys).size !== DEPTH_PRICE_BANDS_BPS.length * 2) context.addIssue({ code: z.ZodIssueCode.custom, path: ['buckets'], message: 'depth observation must contain each bucket exactly once' })
  for (const side of ['bid', 'ask'] as const) {
    const values = DEPTH_PRICE_BANDS_BPS.map((band) => book.buckets.find((bucket) => bucket.side === side && bucket.priceBandBasisPoints === band)?.amount)
    values.forEach((value, index) => {
      if (index > 0 && value && values[index - 1] && value.compare(values[index - 1]!) < 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ['buckets'], message: `${side} buckets must be cumulative` })
    })
  }
})
export type DepthBookObservation = z.infer<typeof depthBookObservationSchema>

type DepthValue = Pick<DepthBookObservation, 'buckets' | 'referencePrice' | 'ledgerSequence' | 'ledgerClosedAt'>

function bucket(value: DepthValue, side: 'bid' | 'ask', band: 50 | 100 | 500) {
  return value.buckets.find((candidate) => candidate.side === side && candidate.priceBandBasisPoints === band)!.amount
}

function maximumDeltaBasisPoints(observed: DepthValue, reference: DepthValue) {
  let maximum = 0
  for (const side of ['bid', 'ask'] as const) for (const band of DEPTH_PRICE_BANDS_BPS) {
    const left = bucket(observed, side, band)
    const right = bucket(reference, side, band)
    const denominator = right.toStroops() === 0n ? 1n : right.toStroops()
    const scaled = absoluteDelta(left, right).toStroops() * 10_000n / denominator
    maximum = Math.max(maximum, Number(scaled > 1_000_000n ? 1_000_000n : scaled))
  }
  return maximum
}

function samePrice(left: DepthValue, right: DepthValue) {
  return left.referencePrice.numerator === right.referencePrice.numerator && left.referencePrice.denominator === right.referencePrice.denominator
}

function agrees(left: DepthValue, right: DepthValue) {
  return samePrice(left, right) && maximumDeltaBasisPoints(left, right) <= depthReconciliationMethodologyConfig.comparisonToleranceBasisPoints
}

const profile: MetricReconciliationProfile<DepthBookObservation, DepthValue> = {
  metric: 'order_book_depth',
  parseObservation: (input) => depthBookObservationSchema.parse(input),
  matchesSubject: (observation, subject) => subject.kind === 'pair' && formatTradingPairId(observation.pair) === formatTradingPairId(subject.pair),
  getValue: (observation) => observation,
  compareValues: (left, right) => {
    const leftOuter = bucket(left, 'bid', 500).add(bucket(left, 'ask', 500))
    const rightOuter = bucket(right, 'bid', 500).add(bucket(right, 'ask', 500))
    return leftOuter.compare(rightOuter)
  },
  agrees,
  deviationBand: (observed, reference) => agrees(observed, reference) ? 'within_tolerance' : 'above_info',
  spreadDistance: (observed, reference) => Math.min(1, maximumDeltaBasisPoints(observed, reference) / 10_000),
  maximumSpreadDistance: 1,
  maximumObservationAgeSeconds: depthReconciliationMethodologyConfig.maximumObservationAgeSeconds,
  toMetricValue: (value) => ({
    kind: 'depth',
    referencePrice: value.referencePrice,
    ledgerSequence: value.ledgerSequence,
    ledgerClosedAt: value.ledgerClosedAt,
    buckets: value.buckets.map((item) => ({ side: item.side, priceBandBasisPoints: item.priceBandBasisPoints, value: item.amount })),
  }),
  getDiscrepancyDetails: (observed, reference) => ({
    kind: 'depth_comparison',
    observedLedgerSequence: observed.ledgerSequence,
    referenceLedgerSequence: reference.ledgerSequence,
    observedSourceTimestamp: observed.ledgerClosedAt,
    referenceSourceTimestamp: reference.ledgerClosedAt,
    bucketDifferences: observed.buckets.flatMap((item) => {
      const referenceAmount = bucket(reference, item.side, item.priceBandBasisPoints)
      return item.amount.equals(referenceAmount) ? [] : [{
        side: item.side,
        priceBandBasisPoints: item.priceBandBasisPoints,
        observed: item.amount,
        reference: referenceAmount,
        absoluteDelta: absoluteDelta(item.amount, referenceAmount),
      }]
    }),
  }),
  getUpstreamId: (observation) => observation.derivation.family,
  createDiscrepancyId: (observation) => `depth_discrepancy_${createHash('sha256').update(observation.provenance.source.id).digest('hex')}`,
}

function methodology(): ReconciliationMethodologyConfig {
  const config = depthReconciliationMethodologyConfig
  return {
    version: DEPTH_RECONCILIATION_METHODOLOGY_VERSION,
    freshnessHalfLifeSeconds: config.freshnessHalfLifeSeconds,
    expectedSourceClasses: ['dex'],
    sourceClassBaseWeights: config.sourceClassBaseWeights,
    minimumVerifiedSources: config.minimumIndependentDerivations,
    verifiedThreshold: config.confidence.verifiedThreshold,
    confidenceFormulaVersion: config.confidence.formulaVersion,
    confidenceCoefficients: {
      agreement: config.confidence.agreementCoefficient,
      freshness: config.confidence.freshnessCoefficient,
      availability: config.confidence.availabilityCoefficient,
      spread: config.confidence.spreadCoefficient,
    },
    singleSourceCap: config.confidence.singleSourceCap,
    sameUpstreamCap: config.confidence.sameDerivationCap,
    sourceErrorCap: config.confidence.sourceErrorCap,
  }
}

export function reconcileDepth(input: {
  cycleId: string
  snapshotId: string
  pair: unknown
  configuredSources: readonly (SourceIdentity | unknown)[]
  observations: readonly unknown[]
  sourceErrors?: readonly (SourceError | unknown)[]
  priorDiscrepancyStates?: Readonly<Record<string, PersistedDiscrepancyState | unknown>>
  asOf: Date
}): ReconcileMetricResult {
  const pair = tradingPairSchema.parse(input.pair)
  return reconcileMetric({
    snapshotId: input.snapshotId,
    cycleId: input.cycleId,
    subject: { kind: 'pair', pair },
    configuredSources: input.configuredSources,
    observations: input.observations,
    sourceErrors: (input.sourceErrors ?? []).map((error) => sourceErrorSchema.parse(error)),
    priorDiscrepancyStates: input.priorDiscrepancyStates,
    clock: () => new Date(input.asOf),
    methodology: methodology(),
    profile,
  })
}

export function toDepthBookObservation(input: {
  observationId: string
  cycleId: string
  observation: import('../stellar/horizon-depth').HorizonDepthObservation
}) {
  const { observation } = input
  if (observation.bookStatus !== 'complete' || !observation.midpoint) return null
  return depthBookObservationSchema.parse({
    observationId: input.observationId,
    cycleId: input.cycleId,
    metric: 'order_book_depth',
    pair: observation.pair,
    buckets: observation.buckets.map((bucket) => ({
      side: bucket.side,
      priceBandBasisPoints: bucket.priceBandBasisPoints,
      amount: bucket.amount,
    })),
    referencePrice: {
      numerator: observation.midpoint.numerator.toString(),
      denominator: observation.midpoint.denominator.toString(),
      decimal: observation.midpoint.format(7),
    },
    ledgerSequence: observation.ledgerSequence,
    ledgerClosedAt: observation.ledgerClosedAt,
    provenance: { source: observation.source, sourceTimestamp: observation.sourceTimestamp, retrievedAt: observation.retrievedAt },
    derivation: { family: observation.derivationFamily, connectorVersion: observation.connectorVersion, evidenceSha256: observation.evidenceSha256 },
  })
}
